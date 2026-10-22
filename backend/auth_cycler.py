"""IVE account rotation, isolated CLI login and evidence-backed verification.

Ordinary account setup opens an interactive, account-scoped browser or offers a
manual private-window handoff. Confirmed failover and credential verification
remain core functions. Optional unattended automation is supplied by the AnyUse
extension; its absence must not disable manual login or cause a hidden browser
fallback. Legacy automation method signatures remain as compatibility ports.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shlex
import shutil
import sqlite3
import tempfile
from pathlib import Path

from config import ACCOUNT_HOMES_DIR

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ensure_dirs(account_id: str) -> tuple[Path, Path]:
    """Return (sandbox_home, user_data_dir), creating them if needed."""
    sandbox_home = ACCOUNT_HOMES_DIR / account_id
    user_data_dir = sandbox_home / "browser"
    sandbox_home.mkdir(parents=True, exist_ok=True)
    user_data_dir.mkdir(parents=True, exist_ok=True)
    return sandbox_home, user_data_dir


def _apply_profile_config_env(
    env: dict[str, str], cli_type: str, sandbox_home: Path
) -> Path | None:
    """Apply a verified profile's config/credential redirect, if it has one."""
    from cli_profiles import get_profile
    from ive_cli_profile import config_dir_path_for

    profile = get_profile(cli_type)
    config_dir = config_dir_path_for(profile, sandbox_home)
    if config_dir is None:
        return None
    config_dir.mkdir(parents=True, exist_ok=True)
    env[profile.config_dir_env] = str(config_dir)
    return config_dir


def _make_url_catcher() -> tuple[str, str]:
    """Create a tiny shell script that writes $1 (the URL) to a temp file.

    Returns (script_path, url_file_path).  Set ``BROWSER`` to script_path
    so the CLI hands us the OAuth URL instead of opening a real browser.
    """
    url_fd, url_file = tempfile.mkstemp(suffix=".url", prefix="ive_auth_")
    os.close(url_fd)
    script_fd, script_file = tempfile.mkstemp(suffix=".sh", prefix="ive_browser_")
    with os.fdopen(script_fd, "w") as f:
        f.write(f'#!/bin/bash\nprintf "%s" "$1" > {shlex.quote(url_file)}\n')
    os.chmod(script_file, 0o700)
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
    """Normalize cli_type without aliasing an unknown CLI to another tool."""
    return (cli_type or "claude").lower()


def _auth_config(cli_type: str) -> dict:
    from cli_profiles import UnknownCLIProfileError, get_profile

    try:
        profile = get_profile(cli_type)
    except UnknownCLIProfileError:
        return {
            "supported": False,
            "auth_cmd": None,
            "unsupported_reason": f"{cli_type} has no registered CLI profile",
        }
    required = {
        "login URL": profile.auth_login_url,
        "auth command": profile.auth_command,
        "completion patterns": profile.auth_completion_patterns,
        "allowed hosts": profile.auth_allowed_hosts,
        "provider": profile.auth_provider,
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        return {
            "supported": False,
            "auth_cmd": None,
            "unsupported_reason": (
                f"{profile.id} auth is unsupported; missing " + ", ".join(missing)
            ),
        }
    return {
        "supported": True,
        "login_url": profile.auth_login_url,
        "post_login_re": re.compile("|".join(profile.auth_completion_patterns)),
        "auth_cmd": list(profile.auth_command),
        "provider": profile.auth_provider,
        "allowed_hosts": list(profile.auth_allowed_hosts),
    }


def _resolved_auth_command(cli_type: str, auth_cfg: dict) -> list[str] | None:
    command = auth_cfg.get("auth_cmd")
    if not isinstance(command, list) or not command:
        return None
    from cli_profiles import get_profile

    profile = get_profile(cli_type)
    resolved_binary = next(
        (
            resolved
            for candidate in [profile.binary, *profile.binary_candidates]
            if candidate and (resolved := shutil.which(candidate))
        ),
        None,
    )
    if any("{binary}" in str(part) for part in command) and not resolved_binary:
        return None
    return [
        str(part).replace("{binary}", resolved_binary or profile.binary)
        for part in command
    ]


_SENSITIVE_URL_RE = re.compile(r"https?://[^\s]+", re.IGNORECASE)


def _redact_auth_text(value: str | bytes | None) -> str:
    if isinstance(value, bytes):
        value = value.decode(errors="replace")
    return _SENSITIVE_URL_RE.sub("<oauth-url-redacted>", value or "")[:500]


async def _persist_login_verification(
    account_id: str,
    cli_type: str,
    verification: dict,
) -> dict:
    """Persist only evidence-backed login state and flag duplicate identities."""
    from db import get_db

    subject = verification.get("verified_subject")
    duplicate = None
    db = await get_db()
    try:
        if verification.get("verified") and subject:
            cur = await db.execute(
                "SELECT id, name FROM accounts WHERE type = 'oauth' AND cli_type = ? "
                "AND verified_subject = ? AND id != ? LIMIT 1",
                (cli_type, subject, account_id),
            )
            row = await cur.fetchone()
            duplicate = dict(row) if row else None
        status = (
            "duplicate_identity" if duplicate
            else "active" if verification.get("verified")
            else "auth_failed"
        )
        values = (
            cli_type,
            subject if verification.get("verified") else None,
            status,
            1 if verification.get("verified") else 0,
            1 if verification.get("verified") else 0,
            account_id,
        )
        statement = (
            "UPDATE accounts SET cli_type = ?, verified_subject = ?, status = ?, "
            "credentials_verified_at = CASE WHEN ? THEN datetime('now') ELSE NULL END, "
            "last_used_at = CASE WHEN ? THEN datetime('now') ELSE last_used_at END "
            "WHERE id = ? AND type = 'oauth'"
        )
        try:
            await db.execute(statement, values)
            await db.commit()
        except sqlite3.IntegrityError:
            if not verification.get("verified") or not subject:
                raise
            await db.rollback()
            cur = await db.execute(
                "SELECT id, name FROM accounts WHERE type = 'oauth' AND status = 'active' "
                "AND cli_type = ? AND verified_subject = ? AND id != ? LIMIT 1",
                (cli_type, subject, account_id),
            )
            row = await cur.fetchone()
            if not row:
                raise
            duplicate = dict(row)
            status = "duplicate_identity"
            await db.execute(statement, (
                cli_type, subject, status, 1, 1, account_id,
            ))
            await db.commit()
    finally:
        await db.close()
    return {"status": status, "duplicate": duplicate}


async def _finish_login_process(
    proc,
    *,
    account_id: str,
    cli_type: str,
    before: dict[str, tuple[int, int]],
    browser_result: dict,
    driver: str,
    timeout: float,
) -> dict:
    """Wait for the CLI callback, verify files, then persist the identity."""
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        persisted = await _persist_login_verification(
            account_id,
            cli_type,
            {"verified": False, "verified_subject": None},
        )
        return {
            "ok": False,
            "status": persisted["status"],
            "error": "Login timed out before the CLI received its OAuth callback.",
            "account_id": account_id,
            "cli_type": cli_type,
            "driver": driver,
            "browser": browser_result,
        }

    from account_sandbox import verify_account_credentials
    verification = await asyncio.to_thread(
        verify_account_credentials, account_id, cli_type, before=before
    )
    if proc.returncode != 0:
        verification["verified"] = False
        persisted = await _persist_login_verification(account_id, cli_type, verification)
        return {
            "ok": False,
            "status": "failed",
            "error": (
                f"The {cli_type} login command exited {proc.returncode}. "
                f"{_redact_auth_text(stderr)}"
            ).strip(),
            "account_id": account_id,
            "cli_type": cli_type,
            "driver": driver,
            "browser": browser_result,
            "verification": verification,
            **persisted,
        }

    persisted = await _persist_login_verification(account_id, cli_type, verification)
    duplicate = persisted.get("duplicate")
    ok = bool(verification.get("verified") and not duplicate)
    result = {
        "ok": ok,
        "status": "success" if ok else persisted["status"],
        "account_id": account_id,
        "cli_type": cli_type,
        "driver": driver,
        "browser": browser_result,
        "verification": verification,
        "isolated": verification.get("strong_isolation"),
        "verified_subject": verification.get("verified_subject"),
    }
    if duplicate:
        result["error"] = (
            f"These credentials resolve to the same {cli_type} identity as "
            f"account '{duplicate['name']}'."
        )
        result["duplicate_account_id"] = duplicate["id"]
    elif not verification.get("verified") and cli_type == "claude":
        result["error"] = "Claude completed login but did not write per-account credentials."
        result["warning"] = (
            "On macOS, click \"Don't Allow\" when Claude asks for Keychain access, "
            "then retry. The shared Claude Code-credentials item cannot isolate accounts."
        )
    elif not verification.get("verified"):
        result["error"] = (
            f"{cli_type} exited successfully, but no new credential files appeared "
            "inside this account's sandbox. The account remains not logged in."
        )
    elif verification.get("strong_isolation"):
        result["message"] = f"{cli_type} login verified in its profile-declared config directory."
    else:
        result["message"] = (
            f"{cli_type} login verified in the account HOME. This CLI has no verified "
            "config-directory environment variable, so isolation is weaker."
        )
        result["warning"] = "HOME-only credential isolation; no stronger CLI config redirect is declared."
    return result


def _normalize_auth_driver(driver: str | None) -> str:
    d = (driver or "ive").strip().lower()
    aliases = {
        "local": "ive",
        "playwright": "ive",
        "ive": "ive",
        "anyuse": "anyuse",
        "auto": "auto",
    }
    return aliases.get(d, "ive")


def _anyuse_account_backend():
    from extension_host import load_backend_module
    return load_backend_module("anyuse", "backend/account_cycler.py")


def _anyuse_account_available() -> bool:
    from extension_host import available
    return available("anyuse")


def _anyuse_account_unavailable(account_id: str, cli_type: str | None) -> dict:
    message = "The AnyUse account automation extension is not installed or enabled."
    return {
        "ok": False, "driver": "anyuse", "account_id": account_id,
        "cli_type": _resolve_cli(cli_type), "reason": "anyuse_extension_unavailable",
        "error": message, "message": message,
    }


async def _maybe_anyuse_browser_auth(
    *,
    driver: str,
    account_id: str,
    cli: str,
    auth_cfg: dict,
    auth_url: str,
    user_data_dir: Path,
    sandbox_home: Path,
    headless: bool,
    mode: str,
) -> tuple[bool, dict]:
    """Route optional automation without making manual account login optional."""
    selected = _normalize_auth_driver(driver)
    if selected == "ive":
        return False, {}
    if not _anyuse_account_available():
        if selected == "auto":
            return False, {}
        return True, _anyuse_account_unavailable(account_id, cli)
    return await _anyuse_account_backend()._maybe_anyuse_browser_auth(
        driver=selected, account_id=account_id, cli=cli, auth_cfg=auth_cfg,
        auth_url=auth_url, user_data_dir=user_data_dir, sandbox_home=sandbox_home,
        headless=headless, mode=mode,
    )


async def _finish_anyuse_browser_auth(
    proc, *, result: dict, anyuse_result: dict, account_id: str, cli: str,
    before: dict, user_data_dir: Path,
) -> dict:
    return await _anyuse_account_backend().finish_browser_auth(
        proc, result=result, anyuse_result=anyuse_result, account_id=account_id,
        cli=cli, before=before, user_data_dir=user_data_dir,
    )


# ---------------------------------------------------------------------------
# AuthCycler
# ---------------------------------------------------------------------------

class AuthCycler:
    """Singleton managing account rotation and isolated CLI authentication."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._auth_in_progress: set[str] = set()
        self._background_auth_tasks: set[asyncio.Task] = set()

    async def _finish_background_login(
        self,
        proc,
        *,
        account_id: str,
        cli_type: str,
        before: dict[str, tuple[int, int]],
        browser_result: dict,
        driver: str,
    ) -> None:
        try:
            result = await _finish_login_process(
                proc,
                account_id=account_id,
                cli_type=cli_type,
                before=before,
                browser_result=browser_result,
                driver=driver,
                timeout=600,
            )
            logger.info(
                "background account login completed account=%s cli=%s status=%s",
                account_id,
                cli_type,
                result.get("status"),
            )
        except Exception:
            logger.exception(
                "background account login completion failed account=%s cli=%s",
                account_id,
                cli_type,
            )
            try:
                await _persist_login_verification(
                    account_id,
                    cli_type,
                    {"verified": False, "verified_subject": None},
                )
            except Exception:
                logger.exception(
                    "failed to persist background login failure account=%s cli=%s",
                    account_id,
                    cli_type,
                )
        finally:
            self._auth_in_progress.discard(account_id)

    # ── Auto-failover ─────────────────────────────────────────────────

    async def auto_failover(self, session_id: str, reset_at: str | None = None) -> dict | None:
        """Find the next usable account and switch the session to it.

        Returns a dict with old/new account info on success, or None if
        no accounts are available.  The caller is responsible for stopping
        the PTY and broadcasting the ``account_switched`` event.

        ``reset_at`` is the exact quota-reset time parsed from the CLI banner
        (a SQLite/UTC datetime string). When given, the benched account is held
        until precisely that time instead of a hardcoded +4h guess.
        """
        from db import get_db
        from account_sandbox import verify_account_credentials

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

                await db.execute(
                    "UPDATE accounts SET quota_reset_at = NULL "
                    "WHERE status != 'quota_exceeded' "
                    "AND quota_reset_at IS NOT NULL"
                )
                await db.execute(
                    "UPDATE accounts SET status = 'active', quota_reset_at = NULL "
                    "WHERE status = 'quota_exceeded' "
                    "AND quota_reset_at IS NOT NULL "
                    "AND quota_reset_at <= datetime('now')"
                )

                if current_id:
                    if reset_at:
                        await db.execute(
                            "UPDATE accounts SET status = 'quota_exceeded', "
                            "quota_reset_at = ? WHERE id = ?",
                            (reset_at, current_id),
                        )
                    else:
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
                # OAuth rows are CLI-bound and usable only while their own
                # verified credential evidence still exists on disk.
                candidates = [
                    a for a in rows
                    if (a["type"] == "api_key" and cli_type == "claude" and a.get("api_key"))
                    or (
                        a["type"] == "oauth"
                        and a.get("cli_type") == cli_type
                        and a.get("credentials_verified_at")
                        and (await asyncio.to_thread(
                            verify_account_credentials, a["id"], cli_type
                        )).get("verified")
                    )
                ]

                if not candidates:
                    logger.warning("auto_failover: no available accounts for session %s", session_id)
                    await db.commit()
                    return None

                chosen = candidates[0] if candidates else None

                if not chosen:
                    logger.warning("auto_failover: all candidates failed for session %s", session_id)
                    await db.commit()
                    return None

                # The caller performs the locked stop/restart and commits the
                # session binding only after the old PTY has exited.
                await db.commit()

                logger.info(
                    "auto_failover: session %s selected %s → %s (%s)",
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

    # ── Account-scoped interactive setup ──────────────────────────────

    async def setup_browser(
        self,
        account_id: str,
        cli_type: str | None = None,
        driver: str | None = None,
        browser_path: str | None = None,
        anyuse_headless: bool = False,
        anyuse_mode: str = "setup",
    ) -> dict:
        """Run the CLI's real auth flow inside its account-scoped HOME.

        Runs the CLI's supported auth command inside the
        account's sandbox HOME and intercepts the OAuth URL it generates
        (this is whatever URL the CLI itself decides on — claude.ai for
        Max/Pro, console.anthropic.com for API console, OpenAI for Codex,
        etc.). The URL opens only in ``<account_home>/browser``. If no browser
        with explicit profile isolation is available, the URL is returned with
        a private-window instruction and is never opened in the default profile.
        """
        if account_id in self._auth_in_progress:
            return {
                "ok": False,
                "status": "in_progress",
                "error": "Auth already in progress for this account",
            }

        selected_driver = _normalize_auth_driver(driver)
        if selected_driver == "anyuse" and not _anyuse_account_available():
            return _anyuse_account_unavailable(account_id, cli_type)

        cli = _resolve_cli(cli_type)
        auth_cfg = _auth_config(cli)
        auth_command = _resolved_auth_command(cli, auth_cfg)
        if not auth_command:
            return {
                "ok": False,
                "error": auth_cfg.get("unsupported_reason") or f"{cli} login command was not found",
                "cli_type": cli,
            }
        self._auth_in_progress.add(account_id)
        sandbox_home, user_data_dir = _ensure_dirs(account_id)

        script_path, url_file = _make_url_catcher()
        result: dict = {"account_id": account_id, "cli_type": cli, "driver": selected_driver}
        proc = None
        manual_handoff = False

        try:
            # 1. Launch the CLI's auth command with a fake $BROWSER that
            #    captures the URL instead of opening it.
            env = os.environ.copy()
            env["HOME"] = str(sandbox_home)
            env["BROWSER"] = script_path
            # A blank profile declaration intentionally means HOME-only
            # isolation. Never guess a CLI-specific config environment name.
            _apply_profile_config_env(env, cli, sandbox_home)

            from account_sandbox import capture_credential_state
            before = await asyncio.to_thread(capture_credential_state, account_id, cli)

            proc = await asyncio.create_subprocess_exec(
                *auth_command,
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
                    f"Could not capture OAuth URL from `{' '.join(auth_command)}`. "
                    f"Make sure the CLI is installed and in $PATH."
                )
                return result

            logger.info("setup_browser: captured OAuth URL for %s (cli=%s)", account_id, cli)

            anyuse_handled, anyuse_result = await _maybe_anyuse_browser_auth(
                driver=selected_driver,
                account_id=account_id,
                cli=cli,
                auth_cfg=auth_cfg,
                auth_url=auth_url,
                user_data_dir=user_data_dir,
                sandbox_home=sandbox_home,
                headless=anyuse_headless,
                mode=anyuse_mode,
            )
            if anyuse_handled:
                return await _finish_anyuse_browser_auth(
                    proc, result=result, anyuse_result=anyuse_result,
                    account_id=account_id, cli=cli, before=before,
                    user_data_dir=user_data_dir,
                )

            result["driver"] = "ive"
            from auth_browser_driver import launch_local_isolated_browser
            browser_result = await launch_local_isolated_browser(
                auth_url,
                user_data_dir,
                preferred=browser_path,
            )
            if browser_result.get("opened"):
                task = asyncio.create_task(self._finish_background_login(
                    proc,
                    account_id=account_id,
                    cli_type=cli,
                    before=before,
                    browser_result=browser_result,
                    driver="ive",
                ))
                self._background_auth_tasks.add(task)
                task.add_done_callback(self._background_auth_tasks.discard)
                manual_handoff = True
                return {
                    "ok": True,
                    "status": "verification_pending",
                    "account_id": account_id,
                    "cli_type": cli,
                    "driver": "ive",
                    "browser": browser_result,
                    "message": (
                        "Finish the OAuth flow in the isolated browser. IVE is "
                        "waiting for the CLI callback and will verify this account's credentials."
                    ),
                }

            # Keep the CLI callback listener alive while the UI exposes the
            # sensitive URL. The background task performs the same verification
            # after the operator finishes in a private/incognito window.
            task = asyncio.create_task(self._finish_background_login(
                proc,
                account_id=account_id,
                cli_type=cli,
                before=before,
                browser_result=browser_result,
                driver="manual_private",
            ))
            self._background_auth_tasks.add(task)
            task.add_done_callback(self._background_auth_tasks.discard)
            manual_handoff = True
            return {
                "ok": True,
                "status": "action_required",
                "account_id": account_id,
                "cli_type": cli,
                "driver": "manual_private",
                "browser": browser_result,
                "auth_url": auth_url,
                "message": browser_result["message"],
                "sensitive_url": True,
            }

        except Exception as e:
            if proc and proc.returncode is None:
                try:
                    proc.kill()
                    await proc.wait()
                except Exception:
                    pass
            result["ok"] = False
            result["error"] = _redact_auth_text(str(e))
        finally:
            if not manual_handoff:
                self._auth_in_progress.discard(account_id)
            for f in (script_path, url_file):
                try:
                    os.unlink(f)
                except OSError:
                    pass

        return result

    # ── AnyUse: unattended OAuth ──────────────────────────────────────

    async def anyuse_auth(
        self,
        account_id: str,
        cli_type: str | None = None,
        headless: bool = True,
    ) -> dict:
        """Delegate unattended login only when its optional product is installed."""
        if not _anyuse_account_available():
            return _anyuse_account_unavailable(account_id, cli_type)
        return await _anyuse_account_backend().anyuse_auth(
            self, account_id, cli_type=cli_type, headless=headless,
        )

    # ── Convenience ───────────────────────────────────────────────────

    def has_browser_context(self, account_id: str) -> bool:
        """Check if an account has its dedicated browser profile on disk."""
        ctx_dir = ACCOUNT_HOMES_DIR / account_id / "browser"
        return ctx_dir.exists() and any(ctx_dir.iterdir())

    def is_auth_in_progress(self, account_id: str) -> bool:
        return account_id in self._auth_in_progress

    async def refresh_stale_accounts(self, cli_type: str = "claude") -> list[dict]:
        """Run the optional account-refresh policy; absence is not a successful refresh."""
        return await _anyuse_account_backend().refresh_stale_accounts(self, cli_type)


# Module-level singleton
auth_cycler = AuthCycler()
