"""
Hook installer for IVE.

Generates the relay script (~/.ive/hooks/hook.sh) and installs
hook entries into Claude Code and Gemini CLI settings files. Hooks are
identified by the hook.sh path so they can be cleanly uninstalled.

The relay script is env-var-gated: it only POSTs to IVE when
COMMANDER_SESSION_ID is set. Non-IVE CLI sessions exit immediately.
"""

import json
import logging
import os
import stat
from pathlib import Path

from config import HOOKS_DIR

logger = logging.getLogger(__name__)

HOOK_SCRIPT_NAME = "hook.sh"
HOOK_SCRIPT_PATH = HOOKS_DIR / HOOK_SCRIPT_NAME

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
    if ps -p $PPID -o comm= 2>/dev/null | grep -qi gemini; then
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
    settings = _read_settings(path)
    settings = _remove_hooks(settings)
    _write_settings(path, settings)
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
AVCP_CLAUDE_HOOK = AVCP_DIR / "hooks" / "claude-code.sh"
AVCP_GEMINI_HOOK = AVCP_DIR / "hooks" / "gemini-cli.sh"

# Marker: any hook whose command path contains "avcp" or "anti-vibe"
_AVCP_MARKER_STRINGS = ("avcp", "anti-vibe")


def _is_avcp_hook(hook: dict) -> bool:
    cmd = hook.get("command", "").lower()
    return any(m in cmd for m in _AVCP_MARKER_STRINGS)


def _avcp_claude_entry() -> dict:
    return {
        "matcher": "Bash",
        "hooks": [{
            "type": "command",
            "command": str(AVCP_CLAUDE_HOOK),
            "timeout": 30,
        }],
    }


def _avcp_gemini_entry() -> dict:
    return {
        "matcher": "shell_execute|run_shell_command|Bash",
        "hooks": [{
            "type": "command",
            "command": str(AVCP_GEMINI_HOOK),
            "timeout": 30000,
        }],
    }


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
    """Install AVCP hooks into Claude Code and (if present) Gemini CLI."""
    if not AVCP_CLAUDE_HOOK.exists():
        logger.warning(f"AVCP hook not found at {AVCP_CLAUDE_HOOK}")
        return

    # Make hook scripts executable
    for hook_path in (AVCP_CLAUDE_HOOK, AVCP_GEMINI_HOOK):
        if hook_path.exists():
            hook_path.chmod(
                hook_path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH
            )

    # Claude Code → PreToolUse
    settings = _read_settings(CLAUDE_SETTINGS)
    hooks = settings.setdefault("hooks", {})
    pre_tool = hooks.setdefault("PreToolUse", [])
    already = any(
        _is_avcp_hook(h)
        for group in pre_tool
        for h in group.get("hooks", [])
    )
    if not already:
        pre_tool.append(_avcp_claude_entry())
    _write_settings(CLAUDE_SETTINGS, settings)
    logger.info(f"AVCP hook installed in {CLAUDE_SETTINGS} (PreToolUse)")

    # Gemini CLI → BeforeTool (only if ~/.gemini exists)
    if GEMINI_SETTINGS.parent.exists() and AVCP_GEMINI_HOOK.exists():
        settings = _read_settings(GEMINI_SETTINGS)
        hooks = settings.setdefault("hooks", {})
        before_tool = hooks.setdefault("BeforeTool", [])
        already = any(
            _is_avcp_hook(h)
            for group in before_tool
            for h in group.get("hooks", [])
        )
        if not already:
            before_tool.append(_avcp_gemini_entry())
        _write_settings(GEMINI_SETTINGS, settings)
        logger.info(f"AVCP hook installed in {GEMINI_SETTINGS} (BeforeTool)")


def uninstall_avcp_hooks():
    """Remove AVCP hooks from all CLI settings files."""
    settings = _read_settings(CLAUDE_SETTINGS)
    settings = _remove_avcp_from_settings(settings)
    _write_settings(CLAUDE_SETTINGS, settings)
    logger.info(f"AVCP hooks removed from {CLAUDE_SETTINGS}")

    if GEMINI_SETTINGS.exists():
        settings = _read_settings(GEMINI_SETTINGS)
        settings = _remove_avcp_from_settings(settings)
        _write_settings(GEMINI_SETTINGS, settings)
        logger.info(f"AVCP hooks removed from {GEMINI_SETTINGS}")


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

    return {
        "claude": _has_avcp(CLAUDE_SETTINGS),
        "gemini": _has_avcp(GEMINI_SETTINGS) if GEMINI_SETTINGS.exists() else False,
        "avcp_exists": AVCP_DIR.exists(),
        "hook_script": str(AVCP_CLAUDE_HOOK),
    }


# ─── Myelin coordination hooks ──────────────────────────────────────────
#
# Semantic conflict detection across concurrent sessions. When the
# experimental_myelin_coordination flag is toggled ON, these hooks let
# the myelin coordination module intercept user prompts and pre-tool
# calls to check for overlapping work.

MYELIN_DIR = project_root() / "ext-repo" / "myelin"

_MYELIN_MARKER = "myelin.coordination.hook"


def _is_myelin_hook(hook: dict) -> bool:
    return _MYELIN_MARKER in hook.get("command", "")


def _myelin_prompt_entry() -> dict:
    """UserPromptSubmit / BeforeAgent hook — captures user intent."""
    return {
        "matcher": "",
        "hooks": [{
            "type": "command",
            "command": f"python3 -m myelin.coordination.hook --event user_prompt",
        }],
    }


def _myelin_tool_entry(matcher: str = "Edit|Write|MultiEdit|NotebookEdit") -> dict:
    """PreToolUse / BeforeTool hook — checks for semantic overlap."""
    return {
        "matcher": matcher,
        "hooks": [{
            "type": "command",
            "command": f"python3 -m myelin.coordination.hook --event pre_tool",
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


def install_myelin_hooks():
    """Install coordination hooks into Claude Code and Gemini CLI settings."""
    # Claude Code: UserPromptSubmit + PreToolUse
    settings = _read_settings(CLAUDE_SETTINGS)
    hooks = settings.setdefault("hooks", {})

    for event, entry_fn in [("UserPromptSubmit", _myelin_prompt_entry),
                             ("PreToolUse", _myelin_tool_entry)]:
        groups = hooks.setdefault(event, [])
        already = any(_is_myelin_hook(h) for g in groups for h in g.get("hooks", []))
        if not already:
            groups.append(entry_fn())

    _write_settings(CLAUDE_SETTINGS, settings)
    logger.info(f"Myelin coordination hooks installed in {CLAUDE_SETTINGS}")

    # Gemini CLI: BeforeAgent + BeforeTool
    if GEMINI_SETTINGS.parent.exists() or _gemini_available():
        settings = _read_settings(GEMINI_SETTINGS)
        hooks = settings.setdefault("hooks", {})

        for event, entry_fn in [("BeforeAgent", _myelin_prompt_entry),
                                 ("BeforeTool", lambda: _myelin_tool_entry("edit_file|write_file|create_file"))]:
            groups = hooks.setdefault(event, [])
            already = any(_is_myelin_hook(h) for g in groups for h in g.get("hooks", []))
            if not already:
                groups.append(entry_fn())

        _write_settings(GEMINI_SETTINGS, settings)
        logger.info(f"Myelin coordination hooks installed in {GEMINI_SETTINGS}")


def uninstall_myelin_hooks():
    """Remove myelin coordination hooks from all CLI settings."""
    for path in (CLAUDE_SETTINGS, GEMINI_SETTINGS):
        if path.exists():
            settings = _read_settings(path)
            settings = _remove_myelin_from_settings(settings)
            _write_settings(path, settings)
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

    return {
        "claude": _has(CLAUDE_SETTINGS),
        "gemini": _has(GEMINI_SETTINGS) if GEMINI_SETTINGS.exists() else False,
        "myelin_module_exists": MYELIN_DIR.exists(),
    }


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

# Detect CLI type
CLI_TYPE="${COMMANDER_CLI_TYPE:-claude}"

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
  --max-time 0.1 \\
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
  *)
    # allow, or parse error — pass through
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
    """Install Safety Gate hooks into Claude Code and Gemini CLI."""
    generate_safety_gate_script()

    # Claude Code → PreToolUse + PostToolUse (matcher: "" = all tools)
    settings = _read_settings(CLAUDE_SETTINGS)
    hooks = settings.setdefault("hooks", {})

    pre_tool = hooks.setdefault("PreToolUse", [])
    if not any(_is_safety_gate_hook(h) for g in pre_tool for h in g.get("hooks", [])):
        pre_tool.append(_safety_gate_entry())

    post_tool = hooks.setdefault("PostToolUse", [])
    if not any(_is_safety_gate_hook(h) for g in post_tool for h in g.get("hooks", [])):
        post_tool.append(_safety_gate_post_entry())

    _write_settings(CLAUDE_SETTINGS, settings)
    logger.info("Safety Gate hooks installed in %s (PreToolUse + PostToolUse)", CLAUDE_SETTINGS)

    # Gemini CLI → BeforeTool + AfterTool (only if ~/.gemini exists)
    if GEMINI_SETTINGS.parent.exists():
        settings = _read_settings(GEMINI_SETTINGS)
        hooks = settings.setdefault("hooks", {})

        before_tool = hooks.setdefault("BeforeTool", [])
        if not any(_is_safety_gate_hook(h) for g in before_tool for h in g.get("hooks", [])):
            before_tool.append(_safety_gate_entry())

        after_tool = hooks.setdefault("AfterTool", [])
        if not any(_is_safety_gate_hook(h) for g in after_tool for h in g.get("hooks", [])):
            after_tool.append(_safety_gate_post_entry())

        _write_settings(GEMINI_SETTINGS, settings)
        logger.info("Safety Gate hooks installed in %s (BeforeTool + AfterTool)", GEMINI_SETTINGS)


def uninstall_safety_gate_hooks():
    """Remove Safety Gate hooks from all CLI settings files."""
    settings = _read_settings(CLAUDE_SETTINGS)
    settings = _remove_safety_gate_from_settings(settings)
    _write_settings(CLAUDE_SETTINGS, settings)
    logger.info("Safety Gate hooks removed from %s", CLAUDE_SETTINGS)

    if GEMINI_SETTINGS.exists():
        settings = _read_settings(GEMINI_SETTINGS)
        settings = _remove_safety_gate_from_settings(settings)
        _write_settings(GEMINI_SETTINGS, settings)
        logger.info("Safety Gate hooks removed from %s", GEMINI_SETTINGS)


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

    return {
        "claude": _has(CLAUDE_SETTINGS),
        "gemini": _has(GEMINI_SETTINGS) if GEMINI_SETTINGS.exists() else False,
        "script_exists": SAFETY_GATE_SCRIPT_PATH.exists(),
    }


# ─── Unified install/uninstall ────────────────────────────────────────

def install_all():
    """Generate script and install hooks for all registered CLI profiles."""
    generate_hook_script()
    for profile in PROFILES.values():
        path = _settings_path_for(profile)
        if path.parent.exists() or _cli_available(profile.binary):
            install_hooks_for_profile(profile)


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

    return {
        "claude": _has_hooks(CLAUDE_SETTINGS),
        "gemini": _has_hooks(GEMINI_SETTINGS),
        "script_exists": HOOK_SCRIPT_PATH.exists(),
    }


def _cli_available(binary: str) -> bool:
    """Check if a CLI binary is installed on PATH."""
    import shutil
    return shutil.which(binary) is not None


def _gemini_available() -> bool:
    """Check if gemini CLI is installed (backward compat wrapper)."""
    return _cli_available("gemini")
