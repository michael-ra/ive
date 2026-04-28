"""
Automated auth cycling via Playwright + LLM-steered navigation.

Three capabilities:
1. Auto-failover: quota exceeded → pick next account → restart session
2. Playwright auth: headless OAuth via persistent browser contexts
3. Interactive setup: visible browser for initial account login

Each account gets a Playwright persistent browser context stored at
``~/.ive/browser_contexts/{account_id}/``.  The context is a full
Chromium user-data directory — cookies, localStorage, IndexedDB all
persist between launches.  That means you log in once (visible browser)
and every subsequent Playwright launch is already authenticated, just
like reopening a Chrome profile.

When the OAuth flow doesn't auto-redirect (consent screen, changed UI,
new steps), an LLM (Claude Haiku via direct API call) looks at the page
screenshot and decides what to click.  This makes the automation
self-healing — no hardcoded button labels to break.  The API key is
sourced from any api_key account in the DB or the ANTHROPIC_API_KEY env
var.  If no key is available, falls back to a simple heuristic.

Supports both Claude (Anthropic console) and Gemini (Google) accounts.

Gated behind the ``experimental_auto_auth_cycling`` app_settings flag.
"""

from __future__ import annotations

import asyncio
import base64
import json as _json
import logging
import os
import re
import stat
import tempfile
from pathlib import Path

from config import DATA_DIR, ACCOUNT_HOMES_DIR

logger = logging.getLogger(__name__)

BROWSER_CONTEXTS_DIR = DATA_DIR / "browser_contexts"

# Per-CLI login pages and auth commands.
_CLI_AUTH = {
    "claude": {
        "login_url": "https://console.anthropic.com/login",
        "post_login_re": re.compile(
            r"console\.anthropic\.com/(dashboard|settings|workbench|projects)"
        ),
        "auth_cmd": ["claude", "auth", "login"],
        "provider": "Anthropic",
    },
    "gemini": {
        "login_url": "https://accounts.google.com/signin",
        "post_login_re": re.compile(
            r"(myaccount\.google\.com|accounts\.google\.com/b/\d|aistudio\.google\.com)"
        ),
        "auth_cmd": ["gemini", "auth", "login"],
        "provider": "Google",
    },
}

# LLM steering config
_STEER_MODEL = "claude-haiku-4-5-20251001"
_STEER_MAX_STEPS = 8
_STEER_API_URL = "https://api.anthropic.com/v1/messages"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ensure_dirs(account_id: str) -> tuple[Path, Path]:
    """Return (sandbox_home, user_data_dir), creating them if needed."""
    sandbox_home = ACCOUNT_HOMES_DIR / account_id
    user_data_dir = BROWSER_CONTEXTS_DIR / account_id
    sandbox_home.mkdir(parents=True, exist_ok=True)
    user_data_dir.mkdir(parents=True, exist_ok=True)
    return sandbox_home, user_data_dir


def _make_url_catcher() -> tuple[str, str]:
    """Create a tiny shell script that writes $1 (the URL) to a temp file.

    Returns (script_path, url_file_path).  Set ``BROWSER`` to script_path
    so the CLI hands us the OAuth URL instead of opening a real browser.
    """
    url_file = tempfile.mktemp(suffix=".url", prefix="ive_auth_")
    script_file = tempfile.mktemp(suffix=".sh", prefix="ive_browser_")
    with open(script_file, "w") as f:
        f.write(f'#!/bin/bash\necho "$1" > {url_file}\n')
    os.chmod(script_file, stat.S_IRWXU)
    return script_file, url_file


async def _poll_file(path: str, timeout: float = 30.0, interval: float = 0.3) -> str | None:
    """Poll for a file to appear and return its contents."""
    elapsed = 0.0
    while elapsed < timeout:
        if os.path.exists(path):
            with open(path) as f:
                content = f.read().strip()
            if content:
                return content
        await asyncio.sleep(interval)
        elapsed += interval
    return None


async def _is_feature_enabled() -> bool:
    """Check if experimental_auto_auth_cycling is turned on."""
    from db import get_db
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT value FROM app_settings WHERE key = 'experimental_auto_auth_cycling'"
        )
        row = await cur.fetchone()
        return row and row["value"] == "on"
    finally:
        await db.close()


def _resolve_cli(cli_type: str | None) -> str:
    """Normalize cli_type, defaulting to 'claude'."""
    if cli_type and cli_type.lower() in _CLI_AUTH:
        return cli_type.lower()
    return "claude"


async def _find_api_key() -> str | None:
    """Find an API key for LLM steering calls.

    Priority:
    1. ANTHROPIC_API_KEY env var (always available, no DB needed)
    2. Any api_key account in the accounts table
    """
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        return key

    try:
        from db import get_db
        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT api_key FROM accounts WHERE type = 'api_key' AND api_key IS NOT NULL "
                "AND api_key != '' AND status = 'active' LIMIT 1"
            )
            row = await cur.fetchone()
            if row:
                return row["api_key"]
        finally:
            await db.close()
    except Exception:
        pass

    return None


def _is_callback_url(url: str) -> bool:
    """Check if the URL is a localhost OAuth callback (auth complete)."""
    return bool(re.match(r"https?://(localhost|127\.0\.0\.1)(:\d+)?/", url))


# ---------------------------------------------------------------------------
# LLM-steered browser navigation
# ---------------------------------------------------------------------------

async def _llm_steer(page, api_key: str, goal: str, max_steps: int = _STEER_MAX_STEPS) -> bool:
    """Use Claude vision to navigate a Playwright page toward a goal.

    Takes a screenshot, sends it to Claude Haiku via direct API call,
    gets back an action, and executes it.  Repeats until the goal is
    reached, we hit the callback URL, or we run out of steps.

    Returns True if navigation succeeded (reached callback or DONE).
    """
    import aiohttp

    for step in range(max_steps):
        # Check if we've already reached the OAuth callback
        if _is_callback_url(page.url):
            logger.info("llm_steer: reached callback URL at step %d", step)
            return True

        # Take screenshot
        screenshot = await page.screenshot(type="png")
        b64 = base64.b64encode(screenshot).decode()

        prompt = (
            f"You are automating a browser to complete an OAuth authorization flow.\n"
            f"Goal: {goal}\n"
            f"Current URL: {page.url}\n\n"
            f"Look at this screenshot and decide the single best next action.\n"
            f"Respond with EXACTLY one JSON object, nothing else:\n\n"
            f'{{"action": "click", "text": "visible button/link text to click"}}\n'
            f'{{"action": "done"}}  — if the goal appears achieved or we reached a success page\n'
            f'{{"action": "wait"}}  — if the page is still loading\n'
            f'{{"action": "fail", "reason": "..."}}  — if you see a CAPTCHA, error, or cannot proceed\n\n'
            f"Rules:\n"
            f"- Prefer clicking authorize/allow/continue/accept buttons\n"
            f"- If you see a Google account chooser, click the correct account email\n"
            f"- If the page looks like a success/callback/redirect page, respond done\n"
            f"- Never try to type passwords or sensitive info\n"
            f"- Respond with raw JSON only, no markdown fences"
        )

        try:
            async with aiohttp.ClientSession() as http:
                resp = await http.post(
                    _STEER_API_URL,
                    headers={
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                    json={
                        "model": _STEER_MODEL,
                        "max_tokens": 256,
                        "messages": [{
                            "role": "user",
                            "content": [
                                {
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": "image/png",
                                        "data": b64,
                                    },
                                },
                                {"type": "text", "text": prompt},
                            ],
                        }],
                    },
                    timeout=aiohttp.ClientTimeout(total=30),
                )
                body = await resp.json()
        except Exception as e:
            logger.warning("llm_steer: API call failed at step %d: %s", step, e)
            return False

        if resp.status != 200:
            logger.warning("llm_steer: API returned %d: %s", resp.status, body)
            return False

        # Parse the LLM response
        raw = body.get("content", [{}])[0].get("text", "").strip()
        # Strip markdown fences if the model wraps it anyway
        if raw.startswith("```"):
            raw = re.sub(r"^```(?:json)?\s*", "", raw)
            raw = re.sub(r"\s*```$", "", raw)

        try:
            action = _json.loads(raw)
        except _json.JSONDecodeError:
            logger.warning("llm_steer: unparseable response at step %d: %s", step, raw[:200])
            return False

        act = action.get("action", "")
        logger.info("llm_steer step %d: %s", step, action)

        if act == "done":
            return True

        elif act == "fail":
            logger.warning("llm_steer: LLM says cannot proceed: %s", action.get("reason", ""))
            return False

        elif act == "wait":
            await page.wait_for_timeout(2000)

        elif act == "click":
            text = action.get("text", "")
            if not text:
                logger.warning("llm_steer: click action missing text")
                continue
            try:
                # Try by role first (buttons, links), then by text
                for role in ("button", "link"):
                    locator = page.get_by_role(role, name=re.compile(re.escape(text), re.I))
                    if await locator.count() > 0 and await locator.first.is_visible():
                        await locator.first.click()
                        await page.wait_for_timeout(2000)
                        break
                else:
                    # Fallback: click by visible text
                    locator = page.get_by_text(text, exact=False)
                    if await locator.count() > 0 and await locator.first.is_visible():
                        await locator.first.click()
                        await page.wait_for_timeout(2000)
                    else:
                        logger.warning("llm_steer: could not find element with text '%s'", text)
            except Exception as e:
                logger.warning("llm_steer: click failed for '%s': %s", text, e)

        else:
            logger.warning("llm_steer: unknown action '%s'", act)

    logger.warning("llm_steer: exhausted %d steps without completing", max_steps)
    return False


async def _heuristic_steer(page) -> None:
    """Simple fallback: try clicking common OAuth button labels.

    Used when no API key is available for LLM steering.
    """
    try:
        for label in ("Authorize", "Allow", "Continue", "Accept", "Log in", "Sign in", "Approve"):
            btn = page.get_by_role("button", name=re.compile(label, re.I))
            if await btn.count() > 0 and await btn.first.is_visible():
                await btn.first.click()
                await page.wait_for_timeout(2000)
                return
        # Also try links
        for label in ("Authorize", "Allow", "Continue"):
            link = page.get_by_role("link", name=re.compile(label, re.I))
            if await link.count() > 0 and await link.first.is_visible():
                await link.first.click()
                await page.wait_for_timeout(2000)
                return
    except Exception:
        pass


# ---------------------------------------------------------------------------
# AuthCycler
# ---------------------------------------------------------------------------

class AuthCycler:
    """Singleton managing automatic account rotation and Playwright-based auth."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._auth_in_progress: set[str] = set()

    # ── Auto-failover ─────────────────────────────────────────────────

    async def auto_failover(self, session_id: str) -> dict | None:
        """Find the next usable account and switch the session to it.

        Returns a dict with old/new account info on success, or None if
        no accounts are available.  The caller is responsible for stopping
        the PTY and broadcasting the ``account_switched`` event.
        """
        from db import get_db
        from account_sandbox import has_snapshot

        async with self._lock:
            db = await get_db()
            try:
                cur = await db.execute(
                    "SELECT s.id, s.account_id, s.cli_type, a.name AS account_name "
                    "FROM sessions s LEFT JOIN accounts a ON s.account_id = a.id "
                    "WHERE s.id = ?",
                    (session_id,),
                )
                session = await cur.fetchone()
                if not session:
                    return None
                session = dict(session)
                current_id = session.get("account_id")

                if current_id:
                    await db.execute(
                        "UPDATE accounts SET status = 'quota_exceeded', "
                        "quota_reset_at = datetime('now', '+4 hours') WHERE id = ?",
                        (current_id,),
                    )

                cur = await db.execute(
                    "SELECT * FROM accounts WHERE status = 'active' AND id != ? "
                    "ORDER BY last_used_at ASC NULLS FIRST, created_at ASC",
                    (current_id or "",),
                )
                rows = [dict(r) for r in await cur.fetchall()]

                if not rows:
                    cur = await db.execute(
                        "SELECT * FROM accounts WHERE status = 'quota_exceeded' "
                        "AND quota_reset_at <= datetime('now') AND id != ? "
                        "ORDER BY quota_reset_at ASC",
                        (current_id or "",),
                    )
                    rows = [dict(r) for r in await cur.fetchall()]

                cli_type = session.get("cli_type", "claude")
                # An OAuth account is usable if it either has a snapshot on
                # disk or a Playwright browser context we can mint one from.
                candidates = [
                    a for a in rows
                    if (a["type"] == "api_key" and a.get("api_key"))
                    or (a["type"] == "oauth" and (
                        has_snapshot(a["id"], cli_type)
                        or self.has_browser_context(a["id"])
                    ))
                ]

                if not candidates:
                    logger.warning("auto_failover: no available accounts for session %s", session_id)
                    await db.commit()
                    return None

                # Walk candidates in LRU order, picking the first one whose
                # auth we can guarantee. For OAuth accounts whose snapshot is
                # missing or stale (>1h — OAuth access tokens often expire
                # before then), refresh via Playwright when a context exists.
                from cli_profiles import get_profile as _get_profile
                import time as _time
                _profile = _get_profile(cli_type)

                def _snapshot_age_h(acc_id: str) -> float:
                    p = ACCOUNT_HOMES_DIR / acc_id / _profile.auth_dir_name
                    if not p.exists():
                        return float("inf")
                    return (_time.time() - p.stat().st_mtime) / 3600

                chosen = None
                # Track whether the chosen account's credentials are verified.
                # When we fall back to a stale snapshot after a refresh failure,
                # we can't honestly mark the account 'active' — the next PTY
                # may immediately re-trip quota_exceeded or land on an expired
                # token. Keep its prior status so the UI can still flag it.
                chosen_verified = False
                for c in candidates:
                    if c["type"] == "api_key":
                        chosen = c
                        chosen_verified = True  # API keys don't need browser refresh
                        break
                    age_h = _snapshot_age_h(c["id"])
                    has_ctx = self.has_browser_context(c["id"])
                    if has_ctx and (age_h > 1):
                        logger.info(
                            "auto_failover: refreshing %s via Playwright (snapshot age %.1fh)",
                            c["name"], age_h,
                        )
                        try:
                            r = await self.playwright_auth(
                                c["id"], cli_type=cli_type, headless=True,
                            )
                        except Exception as e:
                            logger.warning("auto_failover: refresh exception for %s: %s", c["name"], e)
                            r = {"status": "failed", "error": str(e)}
                        if r.get("status") == "success":
                            chosen = c
                            chosen_verified = True
                            break
                        # Refresh failed but we still have a snapshot — try
                        # it; worst case the new PTY surfaces an auth error
                        # and the user can re-run setup. Do NOT mark verified.
                        if age_h != float("inf"):
                            logger.warning(
                                "auto_failover: refresh failed for %s (%s), using stale snapshot",
                                c["name"], r.get("error") or r.get("message"),
                            )
                            chosen = c
                            chosen_verified = False
                            break
                        # No snapshot and refresh failed — try next candidate
                        continue
                    # Snapshot is fresh enough, or no context to refresh with.
                    # Fresh enough (≤1h) is treated as verified; the prior
                    # successful login still has time on it.
                    if age_h != float("inf"):
                        chosen = c
                        chosen_verified = age_h <= 1
                        break

                if not chosen:
                    logger.warning("auto_failover: all candidates failed for session %s", session_id)
                    await db.commit()
                    return None

                await db.execute(
                    "UPDATE sessions SET account_id = ? WHERE id = ?",
                    (chosen["id"], session_id),
                )
                if chosen_verified:
                    await db.execute(
                        "UPDATE accounts SET last_used_at = datetime('now'), status = 'active' WHERE id = ?",
                        (chosen["id"],),
                    )
                else:
                    # Bump last_used_at for LRU rotation but leave status alone
                    # so the dashboard still shows whatever cooldown / error
                    # state the account had. We don't promote to 'active'
                    # without a successful auth verification.
                    await db.execute(
                        "UPDATE accounts SET last_used_at = datetime('now') WHERE id = ?",
                        (chosen["id"],),
                    )
                await db.commit()

                logger.info(
                    "auto_failover: session %s switched %s → %s (%s)",
                    session_id,
                    session.get("account_name", "system"),
                    chosen["name"],
                    chosen["id"],
                )

                return {
                    "session_id": session_id,
                    "old_account_id": current_id,
                    "old_account_name": session.get("account_name", "system auth"),
                    "new_account_id": chosen["id"],
                    "new_account_name": chosen["name"],
                }
            finally:
                await db.close()

    # ── Playwright: interactive setup ─────────────────────────────────

    async def setup_browser(self, account_id: str, cli_type: str | None = None) -> dict:
        """Run the CLI's real auth flow in a visible Playwright browser.

        Runs ``claude auth login`` (or ``gemini auth login``) inside the
        account's sandbox HOME and intercepts the OAuth URL it generates
        (this is whatever URL the CLI itself decides on — claude.ai for
        Max/Pro, console.anthropic.com for API console, Google OAuth for
        Gemini, etc.). A visible Chromium window opens at that URL using a
        persistent context at ``~/.ive/browser_contexts/{account_id}/`` so
        cookies survive across launches. The user logs in, the OAuth
        callback fires, and the CLI writes auth tokens to the sandbox.
        After this completes, headless re-auth via ``playwright_auth``
        works because both cookies and tokens are saved.
        """
        if account_id in self._auth_in_progress:
            return {"ok": False, "error": "Auth already in progress for this account"}

        try:
            from playwright.async_api import async_playwright
        except ImportError:
            return {
                "ok": False,
                "error": "Playwright not installed. Run: pip3 install playwright && playwright install chromium",
            }

        cli = _resolve_cli(cli_type)
        auth_cfg = _CLI_AUTH[cli]
        self._auth_in_progress.add(account_id)
        sandbox_home, user_data_dir = _ensure_dirs(account_id)

        # Symlink shell/git/etc dotfiles into the sandbox HOME so the auth
        # subprocess feels like a normal terminal (matches playwright_auth).
        from account_sandbox import SYMLINK_DOTFILES
        real_home = Path.home()
        for dotfile in SYMLINK_DOTFILES:
            src = real_home / dotfile
            dst = sandbox_home / dotfile
            if src.exists() and not dst.exists():
                try:
                    dst.symlink_to(src)
                except OSError:
                    pass

        script_path, url_file = _make_url_catcher()
        result: dict = {"account_id": account_id, "cli_type": cli}
        proc = None

        try:
            # 1. Launch the CLI's auth command with a fake $BROWSER that
            #    captures the URL instead of opening it.
            env = os.environ.copy()
            env["HOME"] = str(sandbox_home)
            env["BROWSER"] = script_path
            if cli == "claude":
                # Force claude config (including .credentials.json fallback)
                # into the sandbox dir. Without this, OAuth tokens land in
                # the shared macOS keychain entry that all accounts read
                # from, breaking multi-account isolation.
                from account_sandbox import claude_config_dir
                cfg_dir = claude_config_dir(account_id)
                cfg_dir.mkdir(parents=True, exist_ok=True)
                env["CLAUDE_CONFIG_DIR"] = str(cfg_dir)

            proc = await asyncio.create_subprocess_exec(
                *auth_cfg["auth_cmd"],
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            # 2. Wait for the URL to land in the catcher file.
            auth_url = await _poll_file(url_file, timeout=30)
            if not auth_url:
                # Fallback: scan the CLI's own stdout for a URL.
                try:
                    stdout_data = await asyncio.wait_for(proc.stdout.read(4096), timeout=5)
                except (asyncio.TimeoutError, Exception):
                    stdout_data = b""
                m = re.search(r"https://[^\s]+", stdout_data.decode(errors="replace"))
                if m:
                    auth_url = m.group(0)

            if not auth_url:
                proc.kill()
                await proc.wait()
                result["ok"] = False
                result["error"] = (
                    f"Could not capture OAuth URL from `{' '.join(auth_cfg['auth_cmd'])}`. "
                    f"Make sure the CLI is installed and in $PATH."
                )
                return result

            logger.info("setup_browser: captured OAuth URL for %s (cli=%s)", account_id, cli)

            # 3. Open that URL in a visible browser. User logs in normally.
            #    Anti-automation pages (notably console.anthropic.com's
            #    "Authorize" button) check `navigator.webdriver` and a few
            #    other Playwright fingerprints; without these overrides the
            #    button click silently no-ops on some sessions.
            async with async_playwright() as p:
                context = await p.chromium.launch_persistent_context(
                    str(user_data_dir),
                    headless=False,
                    args=[
                        "--disable-blink-features=AutomationControlled",
                        "--no-default-browser-check",
                        "--no-first-run",
                        "--disable-features=IsolateOrigins,site-per-process",
                    ],
                    user_agent=(
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/131.0.0.0 Safari/537.36"
                    ),
                    viewport={"width": 1280, "height": 800},
                    ignore_default_args=["--enable-automation"],
                )
                # Strip Playwright fingerprints before page scripts run.
                await context.add_init_script(
                    "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"
                    "Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});"
                    "Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});"
                    "window.chrome = window.chrome || { runtime: {} };"
                )
                page = context.pages[0] if context.pages else await context.new_page()
                await page.goto(auth_url)

                # 4. Wait for the auth subprocess to exit — that means the
                #    OAuth callback fired and the CLI saved tokens.
                try:
                    await asyncio.wait_for(proc.wait(), timeout=600)  # 10 min
                    if proc.returncode == 0:
                        result["ok"] = True
                        if cli == "claude":
                            from account_sandbox import has_isolated_claude_credentials
                            isolated = has_isolated_claude_credentials(account_id)
                            result["isolated"] = isolated
                            if isolated:
                                result["message"] = (
                                    f"Login successful — {cli} authenticated, credentials "
                                    f"saved per-account (file). Multi-account isolation works."
                                )
                            else:
                                # Token went to shared macOS keychain. All accounts
                                # share that entry, so this account's creds will be
                                # overwritten by the next login. Surface this loudly
                                # so the user can retry and click "Don't Allow" on
                                # the keychain dialog to force the file fallback.
                                result["warning"] = (
                                    "Tokens went to the shared macOS keychain (Claude Code-credentials), "
                                    "not this account's sandbox. All OAuth accounts will read the same "
                                    "creds and overwrite each other.\n\n"
                                    "To fix: delete this account, retry setup, and click \"Don't Allow\" "
                                    "(or Cancel) when macOS asks to access the keychain. That forces "
                                    "claude to fall back to per-account file storage."
                                )
                                result["message"] = f"Login completed but isolation FAILED — see warning."
                        else:
                            result["message"] = f"Login successful — {cli} authenticated and browser cookies saved."
                    else:
                        err = b""
                        try:
                            err = await asyncio.wait_for(proc.stderr.read(2048), timeout=2)
                        except Exception:
                            pass
                        result["ok"] = False
                        result["error"] = (
                            f"`{' '.join(auth_cfg['auth_cmd'])}` exited {proc.returncode}: "
                            f"{err.decode(errors='replace')[:500]}"
                        )
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.wait()
                    result["ok"] = False
                    result["error"] = "Login timed out (10 min). Try again."

                await context.close()

        except Exception as e:
            if proc and proc.returncode is None:
                try:
                    proc.kill()
                    await proc.wait()
                except Exception:
                    pass
            result["ok"] = False
            result["error"] = str(e)
        finally:
            self._auth_in_progress.discard(account_id)
            for f in (script_path, url_file):
                try:
                    os.unlink(f)
                except OSError:
                    pass

        return result

    # ── Playwright: automated OAuth ───────────────────────────────────

    async def playwright_auth(
        self,
        account_id: str,
        cli_type: str | None = None,
        headless: bool = True,
    ) -> dict:
        """Automate ``claude/gemini auth login`` using Playwright + LLM.

        Flow:
        1. URL-catcher script intercepts the OAuth URL from the CLI.
        2. Playwright navigates to it with saved cookies.
        3. If auto-redirect doesn't happen (consent screen, changed UI):
           - With API key: LLM sees the page screenshot and decides what
             to click.  Self-healing — doesn't break when UI changes.
           - Without API key: falls back to heuristic button matching.
        4. CLI receives the callback token, auth saved in sandbox.
        """
        if account_id in self._auth_in_progress:
            return {"error": "Auth already in progress for this account"}

        try:
            from playwright.async_api import async_playwright
        except ImportError:
            return {
                "error": "Playwright not installed. Run: pip3 install playwright && playwright install chromium",
            }

        cli = _resolve_cli(cli_type)
        auth_cfg = _CLI_AUTH[cli]
        self._auth_in_progress.add(account_id)
        sandbox_home, user_data_dir = _ensure_dirs(account_id)

        # Ensure dotfile symlinks
        from account_sandbox import SYMLINK_DOTFILES
        real_home = Path.home()
        for dotfile in SYMLINK_DOTFILES:
            src = real_home / dotfile
            dst = sandbox_home / dotfile
            if src.exists() and not dst.exists():
                try:
                    dst.symlink_to(src)
                except OSError:
                    pass

        script_path, url_file = _make_url_catcher()
        result: dict = {"account_id": account_id, "cli_type": cli}

        try:
            # 1. Start auth login with URL catcher
            env = os.environ.copy()
            env["HOME"] = str(sandbox_home)
            env["BROWSER"] = script_path
            if cli == "claude":
                from account_sandbox import claude_config_dir
                cfg_dir = claude_config_dir(account_id)
                cfg_dir.mkdir(parents=True, exist_ok=True)
                env["CLAUDE_CONFIG_DIR"] = str(cfg_dir)

            proc = await asyncio.create_subprocess_exec(
                *auth_cfg["auth_cmd"],
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            # 2. Capture the OAuth URL
            auth_url = await _poll_file(url_file, timeout=30)

            if not auth_url:
                stdout_data = b""
                try:
                    stdout_data = await asyncio.wait_for(proc.stdout.read(4096), timeout=5)
                except (asyncio.TimeoutError, Exception):
                    pass
                url_match = re.search(r"https://[^\s]+", stdout_data.decode(errors="replace"))
                if url_match:
                    auth_url = url_match.group(0)

            if not auth_url:
                proc.kill()
                await proc.wait()
                result["status"] = "failed"
                result["error"] = f"Could not capture auth URL from {' '.join(auth_cfg['auth_cmd'])}"
                return result

            logger.info("playwright_auth: captured URL for account %s (cli=%s)", account_id, cli)

            # 3. Navigate Playwright to the auth URL
            api_key = await _find_api_key()
            steered_by = "llm" if api_key else "heuristic"

            async with async_playwright() as p:
                context = await p.chromium.launch_persistent_context(
                    str(user_data_dir),
                    headless=headless,
                    args=["--disable-blink-features=AutomationControlled"],
                )
                page = context.pages[0] if context.pages else await context.new_page()

                try:
                    await page.goto(auth_url, wait_until="networkidle", timeout=60_000)
                except Exception as e:
                    logger.warning("playwright_auth: goto error (may be OK — callback redirect): %s", e)

                # If we didn't auto-redirect to localhost, we need to navigate
                if not _is_callback_url(page.url):
                    if api_key:
                        goal = (
                            f"Complete the {auth_cfg['provider']} OAuth authorization. "
                            f"Click the authorize/allow/continue button to grant access. "
                            f"The flow should redirect to a localhost URL when done."
                        )
                        ok = await _llm_steer(page, api_key, goal)
                        if not ok:
                            logger.warning("playwright_auth: LLM steering failed, trying heuristic")
                            await _heuristic_steer(page)
                    else:
                        logger.info("playwright_auth: no API key for LLM steering, using heuristic")
                        await _heuristic_steer(page)

                await context.close()

            # 4. Wait for CLI to finish
            try:
                await asyncio.wait_for(proc.wait(), timeout=20)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()

            if proc.returncode == 0:
                from db import get_db
                db = await get_db()
                try:
                    await db.execute(
                        "UPDATE accounts SET type = 'oauth', status = 'active', "
                        "last_used_at = datetime('now') WHERE id = ?",
                        (account_id,),
                    )
                    await db.commit()
                finally:
                    await db.close()

                result["status"] = "success"
                result["steered_by"] = steered_by
                result["message"] = f"Auth completed — {cli} account ready."
                logger.info("playwright_auth: success for account %s (steered_by=%s)", account_id, steered_by)
            else:
                stderr = (await proc.stderr.read()).decode(errors="replace")
                result["status"] = "failed"
                result["error"] = f"{' '.join(auth_cfg['auth_cmd'])} exited {proc.returncode}: {stderr[:500]}"

        except Exception as e:
            result["status"] = "error"
            result["error"] = str(e)
            logger.error("playwright_auth failed for %s: %s", account_id, e, exc_info=True)
        finally:
            self._auth_in_progress.discard(account_id)
            for f in (script_path, url_file):
                try:
                    os.unlink(f)
                except OSError:
                    pass

        return result

    # ── Convenience ───────────────────────────────────────────────────

    def has_browser_context(self, account_id: str) -> bool:
        """Check if an account has a saved Playwright browser context."""
        ctx_dir = BROWSER_CONTEXTS_DIR / account_id
        return ctx_dir.exists() and any(ctx_dir.iterdir())

    async def refresh_stale_accounts(self, cli_type: str = "claude") -> list[dict]:
        """Re-auth any accounts whose snapshots are older than 7 days."""
        from db import get_db
        from cli_profiles import get_profile
        import time

        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT * FROM accounts WHERE type = 'oauth' AND status = 'active'"
            )
            rows = [dict(r) for r in await cur.fetchall()]
        finally:
            await db.close()

        profile = get_profile(cli_type)
        results = []
        for acc in rows:
            if not self.has_browser_context(acc["id"]):
                continue
            auth_dir = ACCOUNT_HOMES_DIR / acc["id"] / profile.auth_dir_name
            if auth_dir.exists():
                age_days = (time.time() - auth_dir.stat().st_mtime) / 86400
                if age_days < 7:
                    continue

            result = await self.playwright_auth(acc["id"], cli_type=cli_type, headless=True)
            results.append(result)

        return results


# Module-level singleton
auth_cycler = AuthCycler()
