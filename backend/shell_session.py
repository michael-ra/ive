"""Plain terminal sessions: the user's login shell in a project folder.

A "shell" session is what the Mac Terminal app gives you: the login shell
(from $SHELL, else the directory service, else /bin/zsh) started as a login
interactive shell in the chosen folder. No agent, no hooks, no transcript, no
MCP, no permission/model/effort. Restart means a new shell.

The session row uses cli_type = session_type = "shell". The profile below is
deliberately NOT in cli_profiles.PROFILES: everything that iterates the agent
profiles (hook installation, model providers, MCP sync, CLI availability)
must never see it. cli_profiles.get_profile("shell") returns it so per-session
lookups do not crash.
"""
from __future__ import annotations

import os
import re
import subprocess
from functools import lru_cache
from typing import Mapping, Optional

SHELL_CLI_TYPE = "shell"
SHELL_SESSION_TYPE = "shell"
DEFAULT_SHELL = "/bin/zsh"
DEFAULT_LANG = "en_US.UTF-8"

# The parent process's identity must not leak into a plain terminal: these
# describe IVE's own backend (or the agent that launched IVE), not a shell the
# user opened. Terminal.app would not have them either.
_DROP_EXACT = {
    "CLAUDECODE",
    "FORCE_COLOR", "CLICOLOR_FORCE",   # IVE forces colour for agent TUIs only
    "COLUMNS", "LINES",                # a fixed size breaks resizing in the shell
    "NON_INTERACTIVE", "CI", "NO_COLOR",
    "SHLVL", "OLDPWD",
    "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID",
    "ITERM_SESSION_ID", "ITERM_PROFILE", "VSCODE_INJECTION",
    "VIRTUAL_ENV", "PYTHONPATH", "PYTHONUNBUFFERED", "PYTHONDONTWRITEBYTECODE",
}
_DROP_PREFIXES = (
    "CLAUDE_CODE_",
    "COMMANDER_",
    "WORKER_",
    "IVE_",
    "MCP_",
    "OTEL_",
)


def is_shell_cli(cli_type: Optional[str]) -> bool:
    return str(cli_type or "").strip().lower() == SHELL_CLI_TYPE


def is_shell_session(row: Optional[Mapping]) -> bool:
    if not row:
        return False
    return is_shell_cli(row.get("cli_type")) or str(row.get("session_type") or "") == SHELL_SESSION_TYPE


def _usable_shell(path: Optional[str]) -> Optional[str]:
    if not path:
        return None
    path = str(path).strip()
    if not path.startswith("/"):
        return None
    if os.path.isfile(path) and os.access(path, os.X_OK):
        return path
    return None


@lru_cache(maxsize=8)
def _directory_service_shell(user: str) -> Optional[str]:
    """macOS: `dscl . -read /Users/<user> UserShell` → the account's shell."""
    if not user or not os.path.exists("/usr/bin/dscl"):
        return None
    try:
        out = subprocess.run(
            ["/usr/bin/dscl", ".", "-read", f"/Users/{user}", "UserShell"],
            capture_output=True, text=True, timeout=3,
        ).stdout
    except Exception:
        return None
    match = re.search(r"UserShell:\s*(\S+)", out or "")
    return match.group(1) if match else None


def resolve_login_shell(env: Optional[Mapping[str, str]] = None) -> str:
    """The user's login shell: $SHELL, then the directory service, then zsh."""
    env = os.environ if env is None else env
    found = _usable_shell(env.get("SHELL"))
    if found:
        return found
    user = env.get("USER") or env.get("LOGNAME") or ""
    if not user:
        try:
            import pwd
            user = pwd.getpwuid(os.getuid()).pw_name
        except Exception:
            user = ""
    found = _usable_shell(_directory_service_shell(user))
    if found:
        return found
    return DEFAULT_SHELL


def shell_command(shell: Optional[str] = None) -> list[str]:
    """argv for a login interactive shell (works for zsh, bash, fish, sh)."""
    shell = shell or resolve_login_shell()
    return [shell, "-l", "-i"]


@lru_cache(maxsize=1)
def _system_lang() -> str:
    """LANG like Terminal.app derives it from the macOS locale."""
    try:
        out = subprocess.run(
            ["/usr/bin/defaults", "read", "-g", "AppleLocale"],
            capture_output=True, text=True, timeout=3,
        ).stdout.strip()
    except Exception:
        out = ""
    match = re.match(r"^([a-z]{2,3}_[A-Z]{2})", out or "")
    return f"{match.group(1)}.UTF-8" if match else DEFAULT_LANG


def shell_env(inherited: Mapping[str, str], extra: Optional[Mapping[str, str]] = None,
              cwd: Optional[str] = None) -> dict:
    """Clean environment for a plain terminal.

    Starts from the backend's environment (HOME, USER, PATH, …), removes
    everything that describes IVE or a parent agent, and sets the terminal
    basics. The login shell then builds the rest from the user's rc files,
    exactly like a new Terminal window.
    """
    env = {**inherited, **(extra or {})}
    for key in list(env):
        if key in _DROP_EXACT or key.startswith(_DROP_PREFIXES):
            env.pop(key, None)
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    if not env.get("LANG"):
        env["LANG"] = _system_lang()
    if cwd:
        env["PWD"] = cwd
    else:
        env.pop("PWD", None)
    return env
