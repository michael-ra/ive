"""
Hook installer for IVE.

Generates the relay script (~/.ive/hooks/hook.sh) and installs
hook entries into registered CLI settings files. Hooks are
identified by the hook.sh path so they can be cleanly uninstalled.

The relay script is env-var-gated: it only POSTs to IVE when
COMMANDER_SESSION_ID is set. Non-IVE CLI sessions exit immediately.
"""

import json
import logging
import os
import shutil
import stat
from pathlib import Path

from config import DATA_DIR, HOOKS_DIR

logger = logging.getLogger(__name__)

HOOK_SCRIPT_NAME = "hook.sh"
HOOK_SCRIPT_PATH = HOOKS_DIR / HOOK_SCRIPT_NAME
SESSION_HOMES_DIR = DATA_DIR / "session_homes"

# Marker used to identify Commander-installed hooks during uninstall
_HOOK_MARKER = str(HOOK_SCRIPT_PATH)

# ─── Script generation ───────────────────────────────────────────────

HOOK_SCRIPT = """\
#!/bin/bash
# IVE hook relay — auto-generated, do not edit.
# Reads CLI lifecycle JSON from stdin and POSTs it to IVE's API.
# For IVE-managed sessions, COMMANDER_SESSION_ID is already set.
# For external terminals, auto-discovers via /api/hooks/discover.

COMMANDER_API_URL="${COMMANDER_API_URL:-http://localhost:5111}"
INPUT=$(cat)

if [ -z "$COMMANDER_SESSION_ID" ]; then
  # Auto-discover: ask Commander if this workspace has auto-register enabled.
  # Cache the result by PID so we only call discover once per CLI process.
  CACHE_DIR="${TMPDIR:-/tmp}/commander-discover"
  CACHE_FILE="$CACHE_DIR/$$"

  if [ -f "$CACHE_FILE" ]; then
    COMMANDER_SESSION_ID=$(cat "$CACHE_FILE")
  else
    # Detect CLI type from the parent process
    CLI_TYPE="claude"
    if ps -p $PPID -o comm= 2>/dev/null | grep -qi codex; then
      CLI_TYPE="codex"
    elif ps -p $PPID -o comm= 2>/dev/null | grep -qi gemini; then
      CLI_TYPE="gemini"
    fi

    DISCOVER_RESP=$(echo "$INPUT" | jq -c --arg cwd "$PWD" --arg pid "$$" --arg cli "$CLI_TYPE" \\
      '. + {cwd: $cwd, pid: $pid, cli_type: $cli}' | \\
      curl -s -X POST "${COMMANDER_API_URL}/api/hooks/discover" \\
        -H "Content-Type: application/json" \\
        --max-time 2 -d @- 2>/dev/null)

    COMMANDER_SESSION_ID=$(echo "$DISCOVER_RESP" | jq -r '.session_id // empty' 2>/dev/null)

    if [ -n "$COMMANDER_SESSION_ID" ]; then
      mkdir -p "$CACHE_DIR" 2>/dev/null
      echo "$COMMANDER_SESSION_ID" > "$CACHE_FILE"
    else
      exit 0  # No matching workspace or auto-register disabled
    fi
  fi
fi

# Stop events may return a decision dict that re-engages the model
# (e.g. the reflection nudge). For those we run synchronously and forward
# the response body to stdout — Claude Code reads stdout to honor
# {"decision":"block","reason":...}. All other events stay fire-and-forget
# so PostToolUse/Notification don't add latency to the CLI.
EVENT_NAME=$(echo "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)

if [ "$EVENT_NAME" = "Stop" ] || [ "$EVENT_NAME" = "stop" ]; then
  RESP=$(echo "$INPUT" | curl -s -X POST \\
    "${COMMANDER_API_URL}/api/hooks/event" \\
    -H "Content-Type: application/json" \\
    -H "X-Commander-Session-Id: $COMMANDER_SESSION_ID" \\
    -H "X-Commander-Workspace-Id: ${COMMANDER_WORKSPACE_ID:-}" \\
    --max-time 5 \\
    -d @- 2>/dev/null)
  # Only forward bodies that look like a hook decision dict.
  # Empty / non-decision responses → exit 0 silently (normal stop).
  if [ -n "$RESP" ] && echo "$RESP" | jq -e 'has("decision")' >/dev/null 2>&1; then
    printf '%s' "$RESP"
  fi
  exit 0
fi

echo "$INPUT" | curl -s -X POST \\
  "${COMMANDER_API_URL}/api/hooks/event" \\
  -H "Content-Type: application/json" \\
  -H "X-Commander-Session-Id: $COMMANDER_SESSION_ID" \\
  -H "X-Commander-Workspace-Id: ${COMMANDER_WORKSPACE_ID:-}" \\
  --max-time 2 \\
  -d @- >/dev/null 2>&1 &

exit 0
"""


def generate_hook_script():
    """Write the relay script to ~/.ive/hooks/hook.sh."""
    HOOKS_DIR.mkdir(parents=True, exist_ok=True)
    HOOK_SCRIPT_PATH.write_text(HOOK_SCRIPT)
    # Make executable
    HOOK_SCRIPT_PATH.chmod(HOOK_SCRIPT_PATH.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    logger.info(f"Hook script written to {HOOK_SCRIPT_PATH}")


def prepare_runtime_hooks():
    """Prepare hook relay scripts without mutating any native CLI settings."""
    generate_hook_script()


_SESSION_HOME_SYMLINKS = [
    ".zshrc", ".bashrc", ".bash_profile", ".profile",
    ".gitconfig", ".ssh", ".npm", ".node", ".nvm",
    ".cargo", ".rustup", ".go", ".config",
]


def _settings_path_for_home(profile, home_dir: Path) -> Path:
    settings_file = str(profile.settings_file)
    if settings_file.startswith("~/"):
        return home_dir / settings_file[2:]
    if settings_file.startswith("~"):
        return home_dir / settings_file[1:].lstrip("/")
    return home_dir / settings_file


def _profile_home_in(home_dir: Path, profile) -> Path:
    return home_dir / profile.auth_dir_name


def _copy_profile_home_once(profile, source_home: Path, target_home: Path) -> None:
    source_cli_home = source_home / profile.auth_dir_name
    target_cli_home = _profile_home_in(target_home, profile)
    if target_cli_home.exists():
        return
    target_cli_home.parent.mkdir(parents=True, exist_ok=True)
    if source_cli_home.exists():
        shutil.copytree(
            source_cli_home,
            target_cli_home,
            symlinks=True,
            ignore=shutil.ignore_patterns("*.log", "logs"),
        )
    else:
        target_cli_home.mkdir(parents=True, exist_ok=True)


def _symlink_common_home_entries(source_home: Path, target_home: Path, profile) -> None:
    target_home.mkdir(parents=True, exist_ok=True)
    for name in _SESSION_HOME_SYMLINKS:
        if name == profile.auth_dir_name:
            continue
        src = source_home / name
        dst = target_home / name
        if not src.exists() or dst.exists():
            continue
        try:
            dst.symlink_to(src)
        except OSError as e:
            logger.debug("Session-home symlink skipped %s -> %s: %s", dst, src, e)


def _session_env_for_profile(profile, home_dir: Path) -> dict[str, str]:
    env = {"HOME": str(home_dir)}
    cli_home = _profile_home_in(home_dir, profile)
    if profile.home_env_var:
        env[profile.home_env_var] = str(cli_home)
    return env


def prepare_session_hook_home(
    profile,
    session_id: str,
    *,
    source_home: str | Path | None = None,
    include_avcp: bool = False,
    include_safety_gate: bool = False,
    include_myelin: bool = False,
) -> dict[str, str]:
    """Create an IVE-owned HOME for one managed session and install hooks there.

    The source CLI home is copied once so existing auth, MCP, skills, and user
    settings are visible to the managed CLI, but hook changes land only in the
    session home under ~/.ive/session_homes/<session_id>/.
    """
    prepare_runtime_hooks()
    src_home = Path(source_home).expanduser() if source_home else Path.home()
    session_home = SESSION_HOMES_DIR / session_id
    _copy_profile_home_once(profile, src_home, session_home)
    _symlink_common_home_entries(src_home, session_home, profile)

    settings_path = _settings_path_for_home(profile, session_home)
    settings = _read_settings(settings_path)
    settings = _merge_hooks(settings, profile.default_hook_events)
    settings = _merge_session_optional_hooks(
        settings,
        profile,
        include_avcp=include_avcp,
        include_safety_gate=include_safety_gate,
        include_myelin=include_myelin,
    )
    _write_settings(settings_path, settings)

    return _session_env_for_profile(profile, session_home)


# ─── Settings merge helpers ──────────────────────────────────────────

def _read_settings(path: Path) -> dict:
    """Read a JSON settings file, returning {} if missing or invalid."""
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        logger.warning(f"Could not read {path}: {e}")
        return {}


def _write_settings(path: Path, data: dict):
    """Write settings JSON, creating parent dirs if needed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def _hook_entry() -> dict:
    """A single Commander hook entry referencing the relay script."""
    return {
        "type": "command",
        "command": str(HOOK_SCRIPT_PATH),
    }


def _is_commander_hook(hook: dict) -> bool:
    """Check if a hook entry was installed by Commander."""
    return _HOOK_MARKER in hook.get("command", "")


def _merge_hooks(settings: dict, events: list[str]) -> dict:
    """Merge Commander hooks into settings, preserving existing hooks."""
    hooks = settings.setdefault("hooks", {})
    for event in events:
        groups = hooks.setdefault(event, [])
        # Check if Commander already has a hook registered for this event
        already = False
        for group in groups:
            for h in group.get("hooks", []):
                if _is_commander_hook(h):
                    already = True
                    break
            if already:
                break
        if not already:
            groups.append({
                "matcher": "",
                "hooks": [_hook_entry()],
            })
    return settings


def _remove_hooks(settings: dict) -> dict:
    """Remove all Commander hooks from settings."""
    hooks = settings.get("hooks", {})
    for event in list(hooks.keys()):
        groups = hooks[event]
        cleaned = []
        for group in groups:
            filtered = [h for h in group.get("hooks", []) if not _is_commander_hook(h)]
            if filtered:
                group["hooks"] = filtered
                cleaned.append(group)
            # Drop entire group if it only had Commander hooks
        if cleaned:
            hooks[event] = cleaned
        else:
            del hooks[event]
    if not hooks:
        settings.pop("hooks", None)
    return settings


# ─── Profile-driven hook install/uninstall ───────────────────────────
#
# All CLI-specific data (settings path, event names) comes from the
# CLIProfile.  Adding a third CLI only requires a new profile — nothing
# in this file needs to change.

from cli_features import HookEvent
from cli_profiles import CLIProfile, PROFILES, get_profile

# Backward-compat aliases — existing code may reference these directly.
CLAUDE_SETTINGS = Path(os.path.expanduser(get_profile("claude").settings_file))
GEMINI_SETTINGS = Path(os.path.expanduser(get_profile("gemini").settings_file))
CLAUDE_HOOK_EVENTS = get_profile("claude").default_hook_events
GEMINI_HOOK_EVENTS = get_profile("gemini").default_hook_events


def _settings_path_for(profile: CLIProfile) -> Path:
    return Path(os.path.expanduser(profile.settings_file))


def install_hooks_for_profile(profile: CLIProfile):
    """Install Commander hooks into a CLI's settings file."""
    path = _settings_path_for(profile)
    settings = _read_settings(path)
    settings = _merge_hooks(settings, profile.default_hook_events)
    _write_settings(path, settings)
    logger.info("Hooks installed in %s (%s)", path, profile.id)


def uninstall_hooks_for_profile(profile: CLIProfile):
    """Remove Commander hooks from a CLI's settings file."""
    path = _settings_path_for(profile)
    if not path.exists():
        logger.info("Hook settings absent, nothing to remove: %s (%s)", path, profile.id)
        return
    settings = _read_settings(path)
    settings = _remove_hooks(settings)
    if settings:
        _write_settings(path, settings)
    else:
        path.unlink(missing_ok=True)
    logger.info("Hooks removed from %s (%s)", path, profile.id)


# Thin wrappers for backward compat (existing callers still work).
def install_claude_hooks():
    install_hooks_for_profile(get_profile("claude"))

def uninstall_claude_hooks():
    uninstall_hooks_for_profile(get_profile("claude"))

def install_gemini_hooks():
    install_hooks_for_profile(get_profile("gemini"))

def uninstall_gemini_hooks():
    uninstall_hooks_for_profile(get_profile("gemini"))


# ─── AVCP (Anti-Pwning Protection) hooks ─────────────────────────────
#
# Bundled supply chain security scanner. When enabled via the experimental
# settings toggle, installs a PreToolUse hook (Claude) / BeforeTool hook
# (Gemini) that intercepts package manager commands and blocks malicious
# packages before they're installed.

from resource_path import project_root
AVCP_DIR = project_root() / "anti-vibe-code-pwner"
AVCP_HOOKS_DIR = AVCP_DIR / "hooks"
AVCP_CLAUDE_HOOK = AVCP_HOOKS_DIR / "claude-code.sh"
AVCP_GEMINI_HOOK = AVCP_HOOKS_DIR / "gemini-cli.sh"
AVCP_CODEX_HOOK = AVCP_HOOKS_DIR / "codex-cli.sh"

# Marker: any hook whose command path contains "avcp" or "anti-vibe"
_AVCP_MARKER_STRINGS = ("avcp", "anti-vibe")


def _is_avcp_hook(hook: dict) -> bool:
    cmd = hook.get("command", "").lower()
    return any(m in cmd for m in _AVCP_MARKER_STRINGS)


def _avcp_entry(profile) -> dict:
    """AVCP hook entry for any CLI, driven entirely by profile fields."""
    return {
        "matcher": profile.avcp_matcher,
        "hooks": [{
            "type": "command",
            "command": str(AVCP_HOOKS_DIR / profile.avcp_hook_script),
            "timeout": profile.avcp_timeout,
        }],
    }


def _avcp_scripts() -> list[Path]:
    """All AVCP relay script paths across registered profiles."""
    seen, out = set(), []
    for p in PROFILES.values():
        if p.avcp_hook_script and p.avcp_hook_script not in seen:
            seen.add(p.avcp_hook_script)
            out.append(AVCP_HOOKS_DIR / p.avcp_hook_script)
    return out


def _avcp_claude_entry() -> dict:
    return _avcp_entry(get_profile("claude"))


def _avcp_gemini_entry() -> dict:
    return _avcp_entry(get_profile("gemini"))


def _avcp_codex_entry() -> dict:
    return _avcp_entry(get_profile("codex"))


def _remove_avcp_from_settings(settings: dict) -> dict:
    """Remove all AVCP hooks from a settings dict (any CLI)."""
    hooks = settings.get("hooks", {})
    for event in list(hooks.keys()):
        groups = hooks[event]
        cleaned = []
        for group in groups:
            filtered = [h for h in group.get("hooks", []) if not _is_avcp_hook(h)]
            if filtered:
                group["hooks"] = filtered
                cleaned.append(group)
        if cleaned:
            hooks[event] = cleaned
        else:
            del hooks[event]
    if not hooks:
        settings.pop("hooks", None)
    return settings


def install_avcp_hooks():
    """Install AVCP hooks into registered CLI settings."""
    if not AVCP_CLAUDE_HOOK.exists():
        logger.warning(f"AVCP hook not found at {AVCP_CLAUDE_HOOK}")
        return

    # Make hook scripts executable
    for hook_path in _avcp_scripts():
        if hook_path.exists():
            hook_path.chmod(
                hook_path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH
            )

    # Profile-driven install: Claude always; other CLIs only if their config
    # dir already exists. Native event comes from each profile's hook map
    # (Claude/Codex → PreToolUse, Gemini → BeforeTool).
    for cli_id, profile in PROFILES.items():
        if not profile.avcp_hook_script:
            continue
        script = AVCP_HOOKS_DIR / profile.avcp_hook_script
        if not script.exists():
            continue
        settings_path = _settings_path_for(profile)
        if cli_id != "claude" and not settings_path.parent.exists():
            continue
        settings = _read_settings(settings_path)
        hooks = settings.setdefault("hooks", {})
        event = profile.native_hook(HookEvent.PRE_TOOL)
        bucket = hooks.setdefault(event, [])
        already = any(
            _is_avcp_hook(h)
            for group in bucket
            for h in group.get("hooks", [])
        )
        if not already:
            bucket.append(_avcp_entry(profile))
        _write_settings(settings_path, settings)
        logger.info(f"AVCP hook installed in {settings_path} ({event})")


def uninstall_avcp_hooks():
    """Remove AVCP hooks from all CLI settings files."""
    for profile in PROFILES.values():
        settings_path = _settings_path_for(profile)
        if not settings_path.exists():
            continue
        settings = _read_settings(settings_path)
        settings = _remove_avcp_from_settings(settings)
        if settings:
            _write_settings(settings_path, settings)
        else:
            settings_path.unlink(missing_ok=True)
        logger.info(f"AVCP hooks removed from {settings_path}")


def check_avcp_installation() -> dict:
    """Check whether AVCP hooks are currently installed."""
    def _has_avcp(path: Path) -> bool:
        settings = _read_settings(path)
        for groups in settings.get("hooks", {}).values():
            for group in groups:
                for h in group.get("hooks", []):
                    if _is_avcp_hook(h):
                        return True
        return False

    status = {
        profile.id: _has_avcp(_settings_path_for(profile))
        for profile in PROFILES.values()
    }
    status["avcp_exists"] = AVCP_DIR.exists()
    status["hook_script"] = str(AVCP_CLAUDE_HOOK)
    return status


# ─── Myelin coordination hooks ──────────────────────────────────────────
#
# Semantic conflict detection across concurrent sessions. When the
# experimental_myelin_coordination flag is toggled ON, these hooks let
# the myelin coordination module intercept user prompts and pre-tool
# calls to check for overlapping work.

MYELIN_DIR = project_root() / "ext-repo" / "myelin"

_MYELIN_MARKER = "myelin.coordination.hook"
# New command form uses an absolute filesystem path (slashes), old form
# used `python3 -m` (dots). Match either so we can still recognize and
# clean up legacy entries during uninstall / re-install.
_MYELIN_PATH_MARKER = "myelin/coordination/hook"


def _is_myelin_hook(hook: dict) -> bool:
    cmd = hook.get("command", "")
    return _MYELIN_MARKER in cmd or _MYELIN_PATH_MARKER in cmd


def _myelin_cmd(event: str) -> str:
    from resource_path import is_frozen, project_root
    if is_frozen():
        return f"{project_root() / 'bin' / 'ive-myelin-hook'} --event {event}"
    # `python3 -m myelin.coordination.hook` fails because `myelin` is at
    # ext-repo/myelin/ and is not on Python's import path. Invoke the script
    # by absolute path; hook.py self-bootstraps its sys.path for the lazy
    # `from myelin import ...` imports inside handle_pre_tool.
    hook_script = project_root() / "ext-repo" / "myelin" / "coordination" / "hook.py"
    return f"python3 {hook_script} --event {event}"


def _myelin_prompt_entry() -> dict:
    """UserPromptSubmit / BeforeAgent hook — captures user intent."""
    return {
        "matcher": "",
        "hooks": [{
            "type": "command",
            "command": _myelin_cmd("user_prompt"),
        }],
    }


def _myelin_tool_entry(matcher: str = "Edit|Write|MultiEdit|NotebookEdit") -> dict:
    """PreToolUse / BeforeTool hook — checks for semantic overlap."""
    return {
        "matcher": matcher,
        "hooks": [{
            "type": "command",
            "command": _myelin_cmd("pre_tool"),
        }],
    }


def _remove_myelin_from_settings(settings: dict) -> dict:
    """Remove all myelin coordination hooks from settings."""
    hooks = settings.get("hooks", {})
    for event in list(hooks.keys()):
        groups = hooks[event]
        cleaned = []
        for group in groups:
            filtered = [h for h in group.get("hooks", []) if not _is_myelin_hook(h)]
            if filtered:
                group["hooks"] = filtered
                cleaned.append(group)
        if cleaned:
            hooks[event] = cleaned
        else:
            del hooks[event]
    if not hooks:
        settings.pop("hooks", None)
    return settings


def _myelin_events_for_profile(profile: CLIProfile) -> list[tuple[str, callable]]:
    prompt_event = profile.native_hook(HookEvent.PROMPT_SUBMIT)
    tool_event = profile.native_hook(HookEvent.PRE_TOOL)
    events = []
    if prompt_event:
        events.append((prompt_event, _myelin_prompt_entry))
    if tool_event:
        matcher = profile.tool_event_matcher
        events.append((tool_event, lambda matcher=matcher: _myelin_tool_entry(matcher)))
    return events


def install_myelin_hooks():
    """Install coordination hooks into registered CLI settings."""
    for profile in PROFILES.values():
        settings_path = _settings_path_for(profile)
        if profile.id != "claude" and not settings_path.parent.exists() and not _cli_available(profile.binary):
            continue
        events = _myelin_events_for_profile(profile)
        if not events:
            continue
        settings = _read_settings(settings_path)
        hooks = settings.setdefault("hooks", {})

        for event, entry_fn in events:
            groups = hooks.setdefault(event, [])
            already = any(_is_myelin_hook(h) for g in groups for h in g.get("hooks", []))
            if not already:
                groups.append(entry_fn())

        _write_settings(settings_path, settings)
        logger.info("Myelin coordination hooks installed in %s", settings_path)


def uninstall_myelin_hooks():
    """Remove myelin coordination hooks from all CLI settings."""
    for path in (_settings_path_for(profile) for profile in PROFILES.values()):
        if path.exists():
            settings = _read_settings(path)
            settings = _remove_myelin_from_settings(settings)
            if settings:
                _write_settings(path, settings)
            else:
                path.unlink(missing_ok=True)
            logger.info(f"Myelin coordination hooks removed from {path}")


def check_myelin_installation() -> dict:
    """Check whether myelin coordination hooks are installed."""
    def _has(path: Path) -> bool:
        settings = _read_settings(path)
        for groups in settings.get("hooks", {}).values():
            for g in groups:
                for h in g.get("hooks", []):
                    if _is_myelin_hook(h):
                        return True
        return False

    status = {
        profile.id: _has(_settings_path_for(profile))
        for profile in PROFILES.values()
    }
    status["myelin_module_exists"] = MYELIN_DIR.exists()
    return status


# ─── Safety Gate hooks ──────────────────────────────────────────────────
#
# General-purpose tool call safety engine. When experimental_safety_gate
# is toggled ON, installs a PreToolUse/BeforeTool hook that evaluates ALL
# tool calls against configurable rules. Separate from AVCP (packages only)
# and Commander relay (fire-and-forget).

SAFETY_GATE_SCRIPT_NAME = "safety_gate.sh"
SAFETY_GATE_SCRIPT_PATH = HOOKS_DIR / SAFETY_GATE_SCRIPT_NAME

_SAFETY_GATE_MARKER = "safety_gate"

SAFETY_GATE_SCRIPT = """\
#!/bin/bash
# Commander Safety Gate — auto-generated, do not edit.
# Two-tier tool call safety evaluation:
#   Tier 1: Local critical pattern check (always works, 0ms, no network)
#   Tier 2: Commander API for full rule engine (custom rules, logging)
#   Fallback: Claude → "ask" (user decides), Gemini → allow (no ask mode)

COMMANDER_API_URL="${COMMANDER_API_URL:-http://localhost:5111}"
INPUT=$(cat)

# Extract tool_name and tool_input from hook JSON
TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null)
[ -z "$TOOL_NAME" ] && exit 0

# Detect CLI type. The env var wins when explicitly set (e.g. by Commander
# when it spawns a session). Otherwise inspect the parent process command
# line — both CLIs are Node scripts so they share comm="node", but their
# argv differs. Without this fallback, Gemini sessions get the Claude-format
# JSON output below and Gemini reports "Hook(s) [...] failed for event
# BeforeTool" because it doesn't recognize Claude's hook protocol.
CLI_TYPE="${COMMANDER_CLI_TYPE:-}"
if [ -z "$CLI_TYPE" ]; then
  CLI_TYPE="claude"
  # Use `command=` (full argv) not `comm=` — Gemini CLI is a Node script, so
  # `comm=` returns "node" while `command=` is "node /opt/homebrew/bin/gemini …".
  if ps -p $PPID -o command= 2>/dev/null | grep -qi '\\bcodex\\b'; then
    CLI_TYPE="codex"
  elif ps -p $PPID -o command= 2>/dev/null | grep -qi '\\bgemini\\b'; then
    CLI_TYPE="gemini"
  fi
fi

# ── Tier 1: Local critical pattern check ──────────────────────────────
# These patterns are checked locally with zero network dependency.
# Critical-deny only — never accidentally blocks safe commands.
if [ "$TOOL_NAME" = "Bash" ] || [ "$TOOL_NAME" = "execute" ]; then
  COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null)
  BLOCKED=""
  REASON=""

  # Recursive force delete of root/home
  if echo "$COMMAND" | grep -qEi 'rm\\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\\s+(/\\s*$|/\\*|~/|/home)'; then
    BLOCKED=1; REASON="Recursive force delete targeting root or home directory"
  # Disk format
  elif echo "$COMMAND" | grep -qEi 'mkfs\\.'; then
    BLOCKED=1; REASON="Disk format command will erase partition"
  # Raw disk write
  elif echo "$COMMAND" | grep -qEi 'dd\\s+.*if='; then
    BLOCKED=1; REASON="Raw disk write via dd"
  # Pipe to shell
  elif echo "$COMMAND" | grep -qEi '(curl|wget)\\s+.*\\|\\s*(ba)?sh'; then
    BLOCKED=1; REASON="Downloading and piping to shell execution"
  # Fork bomb
  elif echo "$COMMAND" | grep -qEi ':\\(\\)\\s*\\{.*:\\|:.*\\}'; then
    BLOCKED=1; REASON="Fork bomb will crash the system"
  # Write to device
  elif echo "$COMMAND" | grep -qEi '>\\s*/dev/' && ! echo "$COMMAND" | grep -qEi '>\\s*/dev/(null|stdout|stderr|fd/)'; then
    BLOCKED=1; REASON="Writing directly to device file"
  # System shutdown
  elif echo "$COMMAND" | grep -qEi '\\b(shutdown|reboot|halt|poweroff|init\\s+[06])\\b'; then
    BLOCKED=1; REASON="System shutdown/reboot/halt"
  # DROP TABLE/DATABASE
  elif echo "$COMMAND" | grep -qEi 'DROP\\s+(TABLE|DATABASE|SCHEMA)'; then
    BLOCKED=1; REASON="DROP TABLE/DATABASE is irreversible"
  fi

  if [ -n "$BLOCKED" ]; then
    if [ "$CLI_TYPE" = "gemini" ]; then
      echo "$REASON" >&2
      exit 2
    fi
    cat <<HOOKEOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[Safety Gate] $REASON"}}
HOOKEOF
    exit 0
  fi
fi

# Tier 1 for file tools: block .ssh/ and /etc/ writes locally
if [ "$TOOL_NAME" = "Write" ] || [ "$TOOL_NAME" = "Edit" ] || [ "$TOOL_NAME" = "write_file" ] || [ "$TOOL_NAME" = "edit_file" ]; then
  FPATH=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null)
  BLOCKED=""
  REASON=""

  if echo "$FPATH" | grep -qE '[/~]\\.ssh/'; then
    BLOCKED=1; REASON="Writing to SSH directory"
  elif echo "$FPATH" | grep -qE '^/etc/'; then
    BLOCKED=1; REASON="Writing to system config directory /etc/"
  fi

  if [ -n "$BLOCKED" ]; then
    if [ "$CLI_TYPE" = "gemini" ]; then
      echo "$REASON" >&2
      exit 2
    fi
    cat <<HOOKEOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[Safety Gate] $REASON"}}
HOOKEOF
    exit 0
  fi
fi

# ── Tier 2: Commander API evaluation ──────────────────────────────────
# Package manager commands need full AVCP scan + LLM analysis — no timeout.
# Normal tool calls use a short timeout so a down Commander doesn't block the CLI.
MAX_TIME="0.5"
if [ -n "$COMMAND" ]; then
  case "$COMMAND" in
    *"pip install"*|*"pip3 install"*|*"npm install"*|*"npm i "*|*"npm add"*|\
    *"yarn add"*|*"pnpm add"*|*"bun add"*|*"cargo add"*|*"cargo install"*|\
    *"go get "*|*"go install"*|*"gem install"*|*"composer require"*|*"brew install"*)
      MAX_TIME="120"
      ;;
  esac
fi
RESP=$(echo "$INPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
payload = {
    'tool_name': d.get('tool_name', ''),
    'tool_input': d.get('tool_input', {}),
    'tool_use_id': d.get('tool_use_id', ''),
    'session_id': '${COMMANDER_SESSION_ID:-}',
    'workspace_id': '${COMMANDER_WORKSPACE_ID:-}'
}
print(json.dumps(payload))
" 2>/dev/null | curl -s -X POST \\
  "${COMMANDER_API_URL}/api/safety/evaluate" \\
  -H "Content-Type: application/json" \\
  --max-time "$MAX_TIME" \\
  -d @- 2>/dev/null)

# Parse API response
DECISION=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('decision','allow'))" 2>/dev/null)
API_REASON=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason',''))" 2>/dev/null)

case "$DECISION" in
  deny)
    if [ "$CLI_TYPE" = "gemini" ]; then
      echo "[Safety Gate] $API_REASON" >&2
      exit 2
    fi
    cat <<HOOKEOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[Safety Gate] $API_REASON"}}
HOOKEOF
    exit 0
    ;;
  ask)
    if [ "$CLI_TYPE" = "gemini" ]; then
      exit 0  # Gemini has no ask mode, allow and let its own prompts handle it
    fi
    cat <<HOOKEOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"[Safety Gate] $API_REASON"}}
HOOKEOF
    exit 0
    ;;
  allow_auto)
    # Explicit allow — overrides Claude Code's native first-tool-call
    # confirmation menu. Server returns this only when the session's stored
    # permission_mode is 'auto' AND no deny/ask rule matched, so the
    # operator's intent ("auto-approve unless safety gate flags it") is
    # honored without a manual keystroke.
    if [ "$CLI_TYPE" = "gemini" ]; then
      exit 0  # Gemini has its own permission model; pass through
    fi
    cat <<HOOKEOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"[Safety Gate] $API_REASON"}}
HOOKEOF
    exit 0
    ;;
  *)
    # allow, or parse error — pass through (Claude's native gating runs)
    exit 0
    ;;
esac
"""


SAFETY_GATE_POST_SCRIPT_NAME = "safety_gate_post.sh"
SAFETY_GATE_POST_SCRIPT_PATH = HOOKS_DIR / SAFETY_GATE_POST_SCRIPT_NAME

SAFETY_GATE_POST_SCRIPT = """\
#!/bin/bash
# Commander Safety Gate — PostToolUse companion (auto-generated, do not edit).
# When a tool executes after an "ask" prompt, this means the user approved.
# Report the approval so the same rule auto-allows for the rest of the session.

COMMANDER_API_URL="${COMMANDER_API_URL:-http://localhost:5111}"
INPUT=$(cat)

TOOL_USE_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_use_id',''))" 2>/dev/null)
[ -z "$TOOL_USE_ID" ] && exit 0

# Fire-and-forget: report approval to Commander (non-blocking, 50ms timeout)
curl -s -X POST \\
  "${COMMANDER_API_URL}/api/safety/approved" \\
  -H "Content-Type: application/json" \\
  --max-time 0.05 \\
  -d "{\\"tool_use_id\\":\\"${TOOL_USE_ID}\\"}" >/dev/null 2>&1 &

exit 0
"""


def generate_safety_gate_script():
    """Write the safety gate hook scripts to ~/.ive/hooks/."""
    HOOKS_DIR.mkdir(parents=True, exist_ok=True)
    SAFETY_GATE_SCRIPT_PATH.write_text(SAFETY_GATE_SCRIPT)
    SAFETY_GATE_SCRIPT_PATH.chmod(
        SAFETY_GATE_SCRIPT_PATH.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH
    )
    SAFETY_GATE_POST_SCRIPT_PATH.write_text(SAFETY_GATE_POST_SCRIPT)
    SAFETY_GATE_POST_SCRIPT_PATH.chmod(
        SAFETY_GATE_POST_SCRIPT_PATH.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH
    )
    logger.info("Safety gate scripts written to %s", HOOKS_DIR)


def _is_safety_gate_hook(hook: dict) -> bool:
    cmd = hook.get("command", "").lower()
    return _SAFETY_GATE_MARKER in cmd


def _safety_gate_entry() -> dict:
    return {
        "matcher": "",  # Match ALL tools
        "hooks": [{
            "type": "command",
            "command": str(SAFETY_GATE_SCRIPT_PATH),
            "timeout": 5,
        }],
    }


def _safety_gate_post_entry() -> dict:
    return {
        "matcher": "",  # Match ALL tools
        "hooks": [{
            "type": "command",
            "command": str(SAFETY_GATE_POST_SCRIPT_PATH),
            "timeout": 2,
        }],
    }


def _remove_safety_gate_from_settings(settings: dict) -> dict:
    """Remove all Safety Gate hooks from a settings dict."""
    hooks = settings.get("hooks", {})
    for event in list(hooks.keys()):
        groups = hooks[event]
        cleaned = []
        for group in groups:
            filtered = [h for h in group.get("hooks", []) if not _is_safety_gate_hook(h)]
            if filtered:
                group["hooks"] = filtered
                cleaned.append(group)
        if cleaned:
            hooks[event] = cleaned
        else:
            del hooks[event]
    if not hooks:
        settings.pop("hooks", None)
    return settings


def install_safety_gate_hooks():
    """Install Safety Gate hooks into registered CLI settings."""
    generate_safety_gate_script()

    for profile in PROFILES.values():
        settings_path = _settings_path_for(profile)
        if profile.id != "claude" and not settings_path.parent.exists():
            continue
        settings = _read_settings(settings_path)
        hooks = settings.setdefault("hooks", {})

        pre_event = profile.native_hook(HookEvent.PRE_TOOL)
        post_event = profile.native_hook(HookEvent.POST_TOOL)

        pre_tool = hooks.setdefault(pre_event, [])
        if not any(_is_safety_gate_hook(h) for g in pre_tool for h in g.get("hooks", [])):
            pre_tool.append(_safety_gate_entry())

        post_tool = hooks.setdefault(post_event, [])
        if not any(_is_safety_gate_hook(h) for g in post_tool for h in g.get("hooks", [])):
            post_tool.append(_safety_gate_post_entry())

        _write_settings(settings_path, settings)
        logger.info("Safety Gate hooks installed in %s (%s + %s)", settings_path, pre_event, post_event)


def uninstall_safety_gate_hooks():
    """Remove Safety Gate hooks from all CLI settings files."""
    for profile in PROFILES.values():
        settings_path = _settings_path_for(profile)
        if not settings_path.exists():
            continue
        settings = _read_settings(settings_path)
        settings = _remove_safety_gate_from_settings(settings)
        if settings:
            _write_settings(settings_path, settings)
        else:
            settings_path.unlink(missing_ok=True)
        logger.info("Safety Gate hooks removed from %s", settings_path)


def check_safety_gate_installation() -> dict:
    """Check whether Safety Gate hooks are currently installed."""
    def _has(path: Path) -> bool:
        settings = _read_settings(path)
        for groups in settings.get("hooks", {}).values():
            for group in groups:
                for h in group.get("hooks", []):
                    if _is_safety_gate_hook(h):
                        return True
        return False

    status = {
        profile.id: _has(_settings_path_for(profile))
        for profile in PROFILES.values()
    }
    status["script_exists"] = SAFETY_GATE_SCRIPT_PATH.exists()
    return status


def _append_entry_once(settings: dict, event: str, entry: dict, marker_fn) -> dict:
    hooks = settings.setdefault("hooks", {})
    groups = hooks.setdefault(event, [])
    if not any(marker_fn(h) for group in groups for h in group.get("hooks", [])):
        groups.append(entry)
    return settings


def _merge_session_optional_hooks(
    settings: dict,
    profile: CLIProfile,
    *,
    include_avcp: bool = False,
    include_safety_gate: bool = False,
    include_myelin: bool = False,
) -> dict:
    """Merge optional protection/coordination hooks into session-local settings."""
    if include_avcp:
        for hook_path in _avcp_scripts():
            if hook_path.exists():
                hook_path.chmod(
                    hook_path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH
                )
        _avcp_script = AVCP_HOOKS_DIR / profile.avcp_hook_script
        if profile.avcp_hook_script and _avcp_script.exists():
            settings = _append_entry_once(
                settings, profile.native_hook(HookEvent.PRE_TOOL),
                _avcp_entry(profile), _is_avcp_hook,
            )

    if include_myelin:
        for event, entry_fn in _myelin_events_for_profile(profile):
            settings = _append_entry_once(settings, event, entry_fn(), _is_myelin_hook)

    if include_safety_gate:
        generate_safety_gate_script()
        pre_event = profile.native_hook(HookEvent.PRE_TOOL)
        post_event = profile.native_hook(HookEvent.POST_TOOL)
        settings = _append_entry_once(settings, pre_event, _safety_gate_entry(), _is_safety_gate_hook)
        settings = _append_entry_once(settings, post_event, _safety_gate_post_entry(), _is_safety_gate_hook)

    return settings


# ─── Unified install/uninstall ────────────────────────────────────────

def install_all():
    """Generate script and install hooks for all registered CLI profiles."""
    generate_hook_script()
    for profile in PROFILES.values():
        path = _settings_path_for(profile)
        if path.parent.exists() or _cli_available(profile.binary):
            install_hooks_for_profile(profile)


def install_global_hooks(
    *,
    include_avcp: bool = False,
    include_safety_gate: bool = False,
    include_myelin: bool = False,
) -> None:
    """Install global relay hooks plus any enabled optional hook features."""
    install_all()
    if include_avcp:
        install_avcp_hooks()
    if include_safety_gate:
        install_safety_gate_hooks()
    if include_myelin:
        install_myelin_hooks()


def uninstall_all():
    """Remove Commander hooks from all registered CLI profiles."""
    for profile in PROFILES.values():
        uninstall_hooks_for_profile(profile)


def check_installation() -> dict:
    """Check whether hooks are installed."""
    def _has_hooks(path: Path) -> bool:
        settings = _read_settings(path)
        for groups in settings.get("hooks", {}).values():
            for group in groups:
                for h in group.get("hooks", []):
                    if _is_commander_hook(h):
                        return True
        return False

    status = {
        profile.id: _has_hooks(_settings_path_for(profile))
        for profile in PROFILES.values()
    }
    status["script_exists"] = HOOK_SCRIPT_PATH.exists()
    return status


def _cli_available(binary: str) -> bool:
    """Check if a CLI binary is installed on PATH."""
    import shutil
    return shutil.which(binary) is not None


def _gemini_available() -> bool:
    """Check if gemini CLI is installed (backward compat wrapper)."""
    return _cli_available(get_profile("gemini").binary)
