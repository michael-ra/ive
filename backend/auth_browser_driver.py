"""Browser drivers for CLI OAuth account setup.

IVE owns account sandboxes and CLI auth validation.  Browser driving can be done
locally in a dedicated per-account browser profile or delegated to AnyUse when a
browser-auth endpoint is available. OAuth URLs are sensitive and are never logged.
"""
from __future__ import annotations

import asyncio
import os
import logging
import platform
import shutil
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional, Tuple

HttpPost = Callable[[str, dict[str, Any], dict[str, str], float], Awaitable[Tuple[int, Any]]]

DEFAULT_TIMEOUT_S = 600.0
logger = logging.getLogger(__name__)


_MAC_BROWSER_APPS = {
    "google chrome": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "brave browser": "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "microsoft edge": "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "chromium": "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "vivaldi": "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
    "opera": "/Applications/Opera.app/Contents/MacOS/Opera",
    "arc": "/Applications/Arc.app/Contents/MacOS/Arc",
    "firefox": "/Applications/Firefox.app/Contents/MacOS/firefox",
}
_CHROMIUM_NAMES = (
    "chrome", "chromium", "brave", "edge", "vivaldi", "opera", "arc",
)


def _browser_kind(executable: str) -> str | None:
    name = Path(executable).name.lower()
    if "firefox" in name:
        return "firefox"
    if any(marker in name for marker in _CHROMIUM_NAMES):
        return "chromium"
    return None


def _mac_app_executable(path: str) -> str | None:
    clean = path.rstrip("/")
    app_name = Path(clean).name.removesuffix(".app").lower()
    known = _MAC_BROWSER_APPS.get(app_name)
    if known:
        return known
    if clean.lower().endswith(".app"):
        candidate = Path(clean) / "Contents" / "MacOS" / Path(clean).stem
        return str(candidate)
    return None


def find_isolated_browser(
    preferred: str | None = None,
    *,
    platform_name: str | None = None,
) -> tuple[str, str] | None:
    """Find a browser with an explicit, isolated profile-directory option.

    Safari and unknown browsers are deliberately rejected: opening an OAuth URL
    in their default profile would silently reuse the operator's web login.
    """
    system = platform_name or platform.system()
    candidates: list[str] = []
    preferred = (preferred or "").strip()
    if preferred:
        if system == "Darwin" and (preferred.lower().endswith(".app") or "/" not in preferred):
            resolved = _mac_app_executable(preferred)
            if resolved:
                candidates.append(resolved)
        else:
            candidates.append(preferred)

    if system == "Darwin":
        candidates.extend(_MAC_BROWSER_APPS.values())
    elif system == "Windows":
        roots = [os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"), os.environ.get("LOCALAPPDATA")]
        for root in (value for value in roots if value):
            candidates.extend([
                str(Path(root) / "Google/Chrome/Application/chrome.exe"),
                str(Path(root) / "Microsoft/Edge/Application/msedge.exe"),
                str(Path(root) / "BraveSoftware/Brave-Browser/Application/brave.exe"),
                str(Path(root) / "Mozilla Firefox/firefox.exe"),
            ])
    else:
        candidates.extend([
            "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
            "brave-browser", "microsoft-edge", "vivaldi", "firefox",
        ])

    seen: set[str] = set()
    for candidate in candidates:
        resolved = candidate
        if "/" not in candidate and "\\" not in candidate:
            resolved = shutil.which(candidate) or ""
        if not resolved or resolved in seen:
            continue
        seen.add(resolved)
        kind = _browser_kind(resolved)
        if kind and Path(resolved).is_file() and os.access(resolved, os.X_OK):
            return resolved, kind
    return None


def build_isolated_browser_command(
    executable: str,
    kind: str,
    user_data_dir: Path,
    auth_url: str,
) -> list[str]:
    """Build a browser command that cannot use the browser's default profile."""
    if kind == "firefox":
        return [executable, "-no-remote", "-profile", str(user_data_dir), auth_url]
    if kind == "chromium":
        return [
            executable,
            f"--user-data-dir={user_data_dir}",
            "--no-first-run",
            "--no-default-browser-check",
            auth_url,
        ]
    raise ValueError(f"browser does not support an isolated profile: {kind}")


async def launch_local_isolated_browser(
    auth_url: str,
    user_data_dir: Path,
    *,
    preferred: str | None = None,
) -> dict[str, Any]:
    """Open a sensitive OAuth URL only in a dedicated browser profile."""
    browser = find_isolated_browser(preferred)
    if browser is None:
        return {
            "opened": False,
            "status": "manual_private_required",
            "profile_dir": str(user_data_dir),
            "message": (
                "No local browser with isolated-profile support was found. "
                "Copy the URL into a new private/incognito window; do not open it "
                "in your normal browser profile."
            ),
        }

    executable, kind = browser
    user_data_dir.mkdir(parents=True, exist_ok=True)
    command = build_isolated_browser_command(executable, kind, user_data_dir, auth_url)
    try:
        await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError:
        return {
            "opened": False,
            "status": "manual_private_required",
            "profile_dir": str(user_data_dir),
            "message": (
                "The isolated browser could not be started. Copy the URL into a "
                "new private/incognito window; do not use your normal profile."
            ),
        }
    return {
        "opened": True,
        "status": "isolated_profile_opened",
        "browser": Path(executable).name,
        "profile_dir": str(user_data_dir),
        "message": "Opened the OAuth URL in this account's isolated browser profile.",
    }


def _anyuse_backend():
    from extension_host import load_backend_module
    return load_backend_module("anyuse", "backend/account_browser.py")


def _anyuse_available() -> bool:
    from extension_host import available
    return available("anyuse")


def _truthy(value: str | None) -> bool:
    return _anyuse_backend()._truthy(value)


def anyuse_browser_auth_enabled() -> bool:
    """An optional automation driver is enabled only while its plugin is present."""
    return _anyuse_available() and _anyuse_backend().anyuse_browser_auth_enabled()


def _anyuse_base() -> str | None:
    return _anyuse_backend()._anyuse_base()


def _brain_headers(request_id: str | None = None) -> dict[str, str]:
    return _anyuse_backend()._brain_headers(request_id)


def _host(url: str) -> str:
    return _anyuse_backend()._host(url)


def _auth_hosts(cli_type: str, auth_url: str) -> list[str]:
    return _anyuse_backend()._auth_hosts(cli_type, auth_url)


def build_anyuse_browser_auth_payload(
    *,
    account_id: str,
    cli_type: str,
    provider: str,
    auth_url: str,
    user_data_dir: Path,
    sandbox_home: Path,
    headless: bool,
    mode: str,
) -> dict[str, Any]:
    return _anyuse_backend().build_anyuse_browser_auth_payload(
        account_id=account_id, cli_type=cli_type, provider=provider,
        auth_url=auth_url, user_data_dir=user_data_dir, sandbox_home=sandbox_home,
        headless=headless, mode=mode,
    )


def _normalize_anyuse_response(status: int, data: Any) -> dict[str, Any]:
    return _anyuse_backend()._normalize_anyuse_response(status, data)


async def run_anyuse_browser_auth(
    payload: dict[str, Any],
    *,
    http_post: Optional[HttpPost] = None,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    require_enabled: bool = True,
) -> dict[str, Any]:
    if not _anyuse_available():
        return {
            "ok": False, "driver": "anyuse",
            "reason": "anyuse_extension_unavailable",
            "message": "The AnyUse account automation extension is not installed or enabled.",
        }
    return await _anyuse_backend().run_anyuse_browser_auth(
        payload, http_post=http_post, timeout_s=timeout_s, require_enabled=require_enabled,
    )


def __getattr__(name):
    # Preserve the legacy constant without keeping the product endpoint in core.
    if name == "BROWSER_AUTH_PATH":
        return _anyuse_backend().BROWSER_AUTH_PATH
    raise AttributeError(name)
