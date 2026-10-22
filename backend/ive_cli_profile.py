"""IVE-owned CLI profile homes.

Managed IVE sessions should not need to mutate the user's primary CLI
settings files.  This module prepares a per-CLI HOME/config area under
``~/.ive/cli_profiles`` and seeds only the auth/config files needed for the
CLI to start from the user's existing login.
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from cli_profiles import CLIProfile, get_profile
from config import ACCOUNT_HOMES_DIR, DATA_DIR


IVE_CLI_PROFILES_DIR = DATA_DIR / "cli_profiles" / "default"

SYMLINK_DOTFILES = [
    ".zshrc", ".bashrc", ".bash_profile", ".profile",
    ".gitconfig", ".ssh", ".npm", ".node", ".nvm",
    ".cargo", ".rustup", ".go", ".config", ".cache", ".local",
]

SEED_PATHS = {
    "claude": [
        ".credentials.json",
        "settings.json",
        "CLAUDE.md",
        "plugins",
    ],
    "codex": [
        "auth.json",
        "config.toml",
        "settings.json",
        "rules",
        "plugins",
        "models_cache.json",
    ],
    "antigravity": [
        "oauth_creds.json",
        "google_accounts.json",
        "state.json",
        "projects.json",
        "trustedFolders.json",
        "installation_id",
        "settings.json",
        "policies",
        "skills",
        "config/config.json",
        "config/projects",
        "config/.migrated",
        "config/plugins",
        "config/sidecars",
        "antigravity/installation_id",
        "antigravity/antigravity_state.pbtxt",
        "antigravity/user_settings.pb",
        "antigravity/browserAllowlist.txt",
        "antigravity/browserOnboardingStatus.txt",
        "antigravity/bin",
        "antigravity/mcp",
        "antigravity/mcp_config.json",
        "antigravity-cli/settings.json",
        "antigravity-cli/keybindings.json",
        "antigravity-cli/bin",
        "antigravity-cli/installation_id",
        "antigravity-cli/mcp",
    ],
}

IGNORE_NAMES = {
    ".DS_Store",
    "log",
    "logs",
    "tmp",
    "cache",
    "brain",
    "conversations",
    "implicit",
    "shell_snapshots",
    "sessions",
}


def _real_home() -> Path:
    return Path.home()


_HOST_LOGIN_TRUE = {"1", "true", "yes", "on"}


def _host_login_enabled() -> bool:
    """"Use host login" mode (DEFAULT ON): no-account sessions run every CLI from the REAL host HOME so
    they reuse your terminal login AND your existing conversation history (~/.claude holds all of it —
    isolating the config dir orphans those conversations and breaks --resume). Claude keeps its
    normal credential lookup, including the macOS Keychain. Opt OUT with IVE_USE_HOST_LOGIN=0 for isolated
    managed-profile HOMEs. An explicit account_id always wins.
    """
    return os.environ.get("IVE_USE_HOST_LOGIN", "1").strip().lower() in _HOST_LOGIN_TRUE


def managed_home(cli_type: str, account_id: str | None = None) -> Path:
    if account_id:
        return ACCOUNT_HOMES_DIR / account_id
    return IVE_CLI_PROFILES_DIR / (cli_type or "claude")


def runtime_home_for_cli(cli_type: str, account_id: str | None = None) -> Path:
    """Return the HOME that IVE should use for this CLI at runtime.

    Precedence: an explicit ``account_id`` always wins (per-account sandbox). With
    no account, the default host-login mode (IVE_USE_HOST_LOGIN=1) returns the real
    host HOME so the CLI reuses your terminal login — this is the fix for "codex /
    claude / agy should just use my normal terminal login." Antigravity keeps its
    existing host-HOME default unless IVE_AGY_ISOLATED_PROFILE=1.
    """
    cli = (cli_type or "claude").lower()
    if account_id:
        return managed_home(cli, account_id=account_id)
    # No account: run from the REAL host HOME (default) so sessions reuse your terminal login AND find
    # your existing conversations (~/.claude), using the CLI's normal credential lookup.
    # Isolating claude's config dir orphaned the
    # whole ~/.claude/projects history and broke --resume — that's why host-login is the default.
    if _host_login_enabled():
        return _real_home()
    # Opt-out (IVE_USE_HOST_LOGIN=0): isolated managed profiles — but gemini/antigravity still read the
    # real ~/.gemini (Google OAuth refreshes in place there, so an isolated copy goes stale).
    if cli in ("antigravity", "gemini") and os.environ.get("IVE_AGY_ISOLATED_PROFILE") != "1":
        return _real_home()
    return managed_home(cli, account_id=None)


def _profile_path_under_home(path_template: str, home: Path) -> Path:
    if path_template.startswith("~/"):
        return home / path_template[2:]
    return Path(os.path.expanduser(path_template))


def settings_path_for(profile: CLIProfile, home: Path) -> Path:
    template = getattr(profile, "hook_settings_file", "") or profile.settings_file
    return _profile_path_under_home(template, home)


def mcp_config_path_for(profile: CLIProfile, home: Path) -> Path:
    template = getattr(profile, "mcp_config_file", "") or ""
    return _profile_path_under_home(template, home)


def config_dir_path_for(profile: CLIProfile, home: Path) -> Path | None:
    """Resolve the profile-declared config/credential root below a runtime HOME."""
    if not profile.config_dir_env or not profile.config_dir_subpath:
        return None
    return home / profile.config_dir_subpath


def cli_data_dir(cli_type: str, home: Path | None = None) -> Path:
    cli = (cli_type or "claude").lower()
    base_home = home or _real_home()
    if cli == "antigravity":
        return base_home / ".gemini" / "antigravity-cli"
    return _profile_path_under_home(get_profile(cli).home_dir, base_home)


# Claude Code caps a sanitized project folder name at this many UTF-16 code
# units and appends ``-<base36 hash>`` of the raw path (2.1.296:
# ``MAX_SANITIZED_LENGTH=200`` / ``sanitizePath``).
CLAUDE_PROJECT_DIRNAME_MAX = 200


def _utf16_units(text: str) -> list[int]:
    data = text.encode("utf-16-le", "surrogatepass")
    return [int.from_bytes(data[i:i + 2], "little") for i in range(0, len(data), 2)]


def _claude_djb2(text: str) -> int:
    """Claude's ``e=(e<<5)-e+charCodeAt(n)|0`` hash (signed 32-bit)."""
    h = 0
    for unit in _utf16_units(text):
        h = ((h << 5) - h + unit) & 0xFFFFFFFF
    return h - 0x100000000 if h & 0x80000000 else h


def _to_base36(n: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    if n == 0:
        return "0"
    out = []
    while n:
        n, r = divmod(n, 36)
        out.append(digits[r])
    return "".join(reversed(out))


def _claude_sanitize(text: str) -> str:
    out: list[str] = []
    for ch in text:
        if ch.isascii() and ch.isalnum():
            out.append(ch)
        else:
            out.append("--" if ord(ch) > 0xFFFF else "-")
    return "".join(out)


def claude_project_dirname(workspace_path: str) -> str:
    """Folder name Claude Code uses under ``<config>/projects`` for a cwd.

    Claude replaces every character outside ``[A-Za-z0-9]`` with ``-`` (JS
    regex over UTF-16 code units, so a non-BMP character becomes two dashes).
    ``/Users/x/ive.dev`` -> ``-Users-x-ive-dev``. Names longer than 200 are
    cut to 200 and get ``-`` + base36(abs(djb2(raw path))) appended.
    """
    path = str(workspace_path or "")
    name = _claude_sanitize(path)
    if len(name) <= CLAUDE_PROJECT_DIRNAME_MAX:
        return name
    return f"{name[:CLAUDE_PROJECT_DIRNAME_MAX]}-{_to_base36(abs(_claude_djb2(path)))}"


_CWD_SCAN_CACHE: dict[str, tuple[int, str | None]] = {}


def _transcript_cwd(project_dir: Path, max_lines: int = 50) -> str | None:
    """First ``cwd`` recorded in any transcript of a Claude project dir."""
    try:
        files = sorted(project_dir.glob("*.jsonl"))
    except OSError:
        return None
    for f in files:
        try:
            with open(f, "r", encoding="utf-8", errors="replace") as fh:
                for i, line in enumerate(fh):
                    if i >= max_lines:
                        break
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    cwd = rec.get("cwd") if isinstance(rec, dict) else None
                    if isinstance(cwd, str) and cwd:
                        return cwd
        except OSError:
            continue
    return None


def claude_project_cwd(project_dir: Path) -> str | None:
    """Workspace path a Claude project dir belongs to, from its transcripts.

    Cached per directory mtime so repeated listings stay cheap.
    """
    key = str(project_dir)
    try:
        mtime = project_dir.stat().st_mtime_ns
    except OSError:
        return None
    hit = _CWD_SCAN_CACHE.get(key)
    if hit and hit[0] == mtime:
        return hit[1]
    cwd = _transcript_cwd(project_dir)
    _CWD_SCAN_CACHE[key] = (mtime, cwd)
    return cwd


def claude_long_project_dirs(projects_dir: Path, workspace_path: str) -> list[Path]:
    """Truncated project dirs whose transcripts' ``cwd`` is this workspace.

    Only for paths over the length cap: covers a hash Claude computed
    differently (other versions / SDK builds) than :func:`claude_project_dirname`.
    """
    path = str(workspace_path or "")
    paths = [path]
    try:
        real = os.path.realpath(path) if path else ""
    except OSError:
        real = ""
    if real and real != path:
        paths.append(real)
    found: list[Path] = []
    for p in paths:
        name = _claude_sanitize(p)
        if len(name) <= CLAUDE_PROJECT_DIRNAME_MAX:
            continue
        try:
            matches = sorted(projects_dir.glob(f"{name[:CLAUDE_PROJECT_DIRNAME_MAX]}-*"))
        except OSError:
            continue
        for d in matches:
            if d.is_dir() and d not in found and claude_project_cwd(d) in paths:
                found.append(d)
    return found


def claude_project_dirnames(workspace_path: str) -> list[str]:
    """Candidate project folder names, the one Claude writes today first.

    Also covers the realpath Claude sees as its cwd (``/tmp`` ->
    ``/private/tmp``) and IVE's legacy ``/``-only encoding as a fallback.
    """
    path = str(workspace_path or "")
    names = [claude_project_dirname(path)]
    try:
        real = os.path.realpath(path) if path else ""
    except OSError:
        real = ""
    if real and real != path:
        names.append(claude_project_dirname(real))
    names.append(path.replace("/", "-"))
    unique: list[str] = []
    for name in names:
        if name and name not in unique:
            unique.append(name)
    return unique


def candidate_data_dirs(cli_type: str) -> list[Path]:
    cli = (cli_type or "claude").lower()
    runtime_home = runtime_home_for_cli(cli)
    fallback_home = managed_home(cli) if runtime_home == _real_home() else _real_home()
    dirs = [
        cli_data_dir(cli, runtime_home),
        cli_data_dir(cli, fallback_home),
    ]
    seen: set[str] = set()
    unique: list[Path] = []
    for d in dirs:
        key = str(d)
        if key not in seen:
            seen.add(key)
            unique.append(d)
    return unique


def _safe_symlink_dotfiles(home: Path) -> None:
    real_home = _real_home()
    home.mkdir(parents=True, exist_ok=True)
    for name in SYMLINK_DOTFILES:
        src = real_home / name
        dst = home / name
        if not src.exists() or dst.exists():
            continue
        try:
            resolved = src.resolve()
            if resolved != src and not resolved.is_relative_to(real_home):
                continue
            dst.symlink_to(src)
        except OSError:
            pass


def _copy_seed(src: Path, dst: Path) -> None:
    if dst.exists() or not src.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(
            src,
            dst,
            symlinks=True,
            ignore=shutil.ignore_patterns(*IGNORE_NAMES),
        )
    else:
        shutil.copy2(src, dst)


def _seed_cli_config(cli_type: str, home: Path) -> None:
    cli = (cli_type or "claude").lower()
    profile = get_profile(cli)
    src_root = Path(os.path.expanduser(profile.home_dir))
    dst_root = _profile_path_under_home(profile.home_dir, home)
    dst_root.mkdir(parents=True, exist_ok=True)
    for rel in SEED_PATHS.get(cli, []):
        _copy_seed(src_root / rel, dst_root / rel)


def prepare_ive_cli_env(cli_type: str, account_id: str | None = None) -> dict[str, str]:
    """Create and return env vars for the active IVE-owned CLI profile."""
    cli = (cli_type or "claude").lower()
    profile = get_profile(cli)
    runtime_home = runtime_home_for_cli(cli, account_id=account_id)
    if cli == "antigravity" and runtime_home == _real_home():
        # No-account agy sessions use the user's system login because the CLI
        # does not expose a stable auth-login subcommand. Explicit OAuth
        # accounts still pass account_id above and run from their sandbox HOME.
        profile_home = managed_home(cli)
        _safe_symlink_dotfiles(profile_home)
        _seed_cli_config(cli, profile_home)
        antigravity_env = {
            "HOME": str(_real_home()),
            "IVE_CLI_PROFILE_HOME": str(profile_home),
        }
        if profile.hook_decision_protocol:
            antigravity_env["COMMANDER_HOOK_DECISION_PROTOCOL"] = profile.hook_decision_protocol
        return antigravity_env
    home = runtime_home
    _safe_symlink_dotfiles(home)
    # An explicit account must prove it owns credentials written by its own
    # login flow. Seeding from the host here made a missing account login
    # silently run as the operator's host identity.
    if account_id is None:
        _seed_cli_config(cli, home)

    env = {
        "HOME": str(home),
        "IVE_CLI_PROFILE_HOME": str(home),
    }
    if profile.hook_decision_protocol:
        env["COMMANDER_HOOK_DECISION_PROTOCOL"] = profile.hook_decision_protocol
    config_dir = config_dir_path_for(profile, home)
    if config_dir is not None:
        config_dir.mkdir(parents=True, exist_ok=True)
        # Setting CLAUDE_CONFIG_DIR, even to ~/.claude, changes Claude's credential
        # lookup. Host sessions must use the same login as `claude` in a terminal;
        # detached subprocesses can use that login too. Never export Keychain
        # credentials into a file just to launch a host session.
        # Explicit accounts and isolated profiles still keep their own config root.
        if profile.id != "claude" or home != _real_home():
            env[profile.config_dir_env] = str(config_dir)
    return env
