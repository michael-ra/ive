"""
Hook installer for IVE.

Generates the relay script (~/.ive/hooks/hook.sh) and installs
hook entries into Claude Code and Gemini CLI settings files. Hooks are
identified by the hook.sh path so they can be cleanly uninstalled.

The relay script is env-var-gated: it only POSTs to IVE when
COMMANDER_SESSION_ID is set. Non-IVE CLI sessions exit immediately.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shlex
import stat
import sys
import tomllib
from pathlib import Path

from config import HOOKS_DIR
from cli_features import HookEvent

logger = logging.getLogger(__name__)

HOOK_SCRIPT_NAME = "hook.sh"
HOOK_SCRIPT_PATH = HOOKS_DIR / HOOK_SCRIPT_NAME

# Markers used to identify IVE/Commander-installed hooks during refresh or
# uninstall. Older installs used ~/.claude-commander; treat those as ours so
# startup can replace stale hook entries with the current build's hook script.
_HOOK_MARKERS = (
    str(HOOK_SCRIPT_PATH),
    ".claude-commander/hooks/hook.sh",
)

# State-dir names IVE has used for its data dir (default ~/.ive, the repo-local
# .ive-team-state used by start.sh/IVE_DATA_DIR, the old ~/.claude-commander).
# A bare `<dir>/hooks/hook.sh` command under one of these is an IVE relay
# from some (possibly older, moved or deleted) install, so the installer
# replaces it instead of letting relays accumulate.
_IVE_STATE_DIR_NAMES = frozenset({
    ".ive", ".ive-team-state", ".claude-commander", HOOKS_DIR.parent.name,
})
_RELAY_SCRIPT_SIGNATURE = "# IVE hook relay"

# Events the generic relay must NEVER be registered for. On these, the mere
# presence of a command hook changes Claude Code's behaviour, and a silent,
# observation-only relay breaks it:
#   WorktreeCreate  replaces `git worktree add`; the hook must print the new
#                   worktree path on stdout, otherwise creation fails with
#                   "hook succeeded but returned no worktree path"
#                   (`claude --worktree`, subagent `isolation: "worktree"`,
#                   background sessions).
#   WorktreeRemove  replaces cleanup of hook-created worktrees; exit 0 means
#                   "removed" even though nothing was deleted.
# https://code.claude.com/docs/en/hooks#worktreecreate
RELAY_EXCLUDED_EVENTS = frozenset({"WorktreeCreate", "WorktreeRemove"})


def relay_hook_events(profile) -> list[str]:
    """Events the IVE relay is registered for: the profile's list minus
    behaviour-replacing events (defence in depth for declarative profiles)."""
    return [
        event for event in profile.default_hook_events
        if event not in RELAY_EXCLUDED_EVENTS
    ]


def _is_ive_relay_command(command) -> bool:
    """True if a hook command is an IVE relay (current or stale install).

    Matches the current relay path and legacy markers as before, plus any
    single-token command `.../<ive-state-dir>/hooks/hook.sh`, or any
    single-token `.../hooks/hook.sh` whose file carries the relay signature.
    User-owned hooks (other scripts, wrappers, pipelines) never match.
    """
    command = str(command or "")
    if any(marker in command for marker in _HOOK_MARKERS):
        return True
    token = command.strip().strip("'\"")
    if not token or any(ch.isspace() for ch in token):
        return False
    path = Path(os.path.expanduser(token))
    if path.name != HOOK_SCRIPT_NAME or path.parent.name != "hooks":
        return False
    if path.parent.parent.name in _IVE_STATE_DIR_NAMES:
        return True
    try:
        with path.open("r", errors="replace") as fh:
            head = fh.read(256)
    except OSError:
        return False
    return _RELAY_SCRIPT_SIGNATURE in head

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
    # Detect CLI type from the parent process for external terminals.
    # Managed IVE PTYs pass COMMANDER_CLI_TYPE separately via env.
    CLI_TYPE="${COMMANDER_CLI_TYPE:-claude}"
    PARENT_COMM=$(ps -p $PPID -o comm= 2>/dev/null)
    if echo "$PARENT_COMM" | grep -Eqi 'agy|antigravity'; then
      CLI_TYPE="antigravity"
    elif echo "$PARENT_COMM" | grep -qi gemini; then
      CLI_TYPE="gemini"
    elif echo "$PARENT_COMM" | grep -qi codex; then
      CLI_TYPE="codex"
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
# (e.g. the reflection nudge). PreToolUse/BeforeTool may return lock rejections.
# For these we run synchronously and forward the response body or format the rejection.
# All other events stay fire-and-forget so PostToolUse/Notification don't add latency to the CLI.
EVENT_NAME=$(echo "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)

if [ "$EVENT_NAME" = "Stop" ] || [ "$EVENT_NAME" = "stop" ] || [ "$EVENT_NAME" = "PreToolUse" ] || [ "$EVENT_NAME" = "BeforeTool" ]; then
  RESP=$(echo "$INPUT" | curl -s -X POST \\
    "${COMMANDER_API_URL}/api/hooks/event" \\
    -H "Content-Type: application/json" \\
    -H "X-Commander-Session-Id: $COMMANDER_SESSION_ID" \\
    -H "X-Commander-Session-Proof: ${COMMANDER_SESSION_PROOF:-}" \\
    -H "X-Commander-Workspace-Id: ${COMMANDER_WORKSPACE_ID:-}" \\
    --max-time 5 \\
    -d @- 2>/dev/null)
  # Only forward bodies that look like a hook decision dict.
  # Empty / non-decision responses → exit 0 silently (normal stop).
  if [ -n "$RESP" ]; then
    if echo "$RESP" | jq -e 'has("decision") or has("hookSpecificOutput") or has("additionalContext") or has("updatedInput")' >/dev/null 2>&1; then
      printf '%s' "$RESP"
    elif echo "$RESP" | jq -e 'has("allow") and .allow == false' >/dev/null 2>&1; then
      REASON=$(echo "$RESP" | jq -r '.reason // "File is locked by active teammate session"')
      CLI_TYPE="${COMMANDER_CLI_TYPE:-claude}"
      PARENT_COMM=$(ps -p $PPID -o comm= 2>/dev/null)
      if echo "$PARENT_COMM" | grep -Eqi 'agy|antigravity'; then
        CLI_TYPE="antigravity"
      elif echo "$PARENT_COMM" | grep -qi gemini; then
        CLI_TYPE="gemini"
      elif echo "$PARENT_COMM" | grep -qi codex; then
        CLI_TYPE="codex"
      fi
      DECISION_PROTOCOL="${COMMANDER_HOOK_DECISION_PROTOCOL:-}"
      if [ -z "$DECISION_PROTOCOL" ]; then
        case "$CLI_TYPE" in
          gemini|antigravity) DECISION_PROTOCOL="exit_code" ;;
          claude|codex) DECISION_PROTOCOL="claude_json" ;;
        esac
      fi
      if [ "$DECISION_PROTOCOL" = "exit_code" ]; then
        echo "$REASON" >&2
        exit 2
      elif [ "$DECISION_PROTOCOL" = "claude_json" ]; then
        cat <<HOOKEOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"$REASON"}}
HOOKEOF
      else
        echo "IVE hook decision protocol unsupported for $CLI_TYPE" >&2
        exit 2
      fi
      exit 0
    fi
  fi
  exit 0
fi

echo "$INPUT" | curl -s -X POST \\
  "${COMMANDER_API_URL}/api/hooks/event" \\
  -H "Content-Type: application/json" \\
  -H "X-Commander-Session-Id: $COMMANDER_SESSION_ID" \\
  -H "X-Commander-Session-Proof: ${COMMANDER_SESSION_PROOF:-}" \\
  -H "X-Commander-Workspace-Id: ${COMMANDER_WORKSPACE_ID:-}" \\
  --max-time 2 \\
  -d @- >/dev/null 2>&1 &

exit 0
"""


def generate_hook_script():
    """Write the relay script to ~/.ive/hooks/hook.sh."""
    HOOKS_DIR.mkdir(parents=True, exist_ok=True)
    from resource_path import is_frozen
    if is_frozen():
        from helper_command import helper_command
        script = "#!/bin/sh\n# IVE hook relay — bundled runtime\nexec " + shlex.join(helper_command("hook-relay")) + '\n'
    else:
        script = HOOK_SCRIPT
    HOOK_SCRIPT_PATH.write_text(script)
    # Make executable
    HOOK_SCRIPT_PATH.chmod(HOOK_SCRIPT_PATH.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    logger.info(f"Hook script written to {HOOK_SCRIPT_PATH}")


# ─── Settings merge helpers ──────────────────────────────────────────

def _strip_json_comments(text: str) -> str:
    """Remove // and /* */ comments outside strings (JSONC, as Gemini allows)."""
    out: list[str] = []
    i, n = 0, len(text)
    in_string = False
    while i < n:
        ch = text[i]
        if in_string:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
        elif text.startswith("//", i):
            end = text.find("\n", i)
            i = n if end == -1 else end
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end == -1 else end + 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _read_settings(path: Path) -> dict:
    """Read a JSON settings file for INSPECTION only, {} if missing or invalid.

    Never feed the result into ``_write_settings``: on a parse error it is
    empty, and writing it back would wipe the user's file. Read-modify-write
    paths go through ``_update_settings``.
    """
    if not path.exists():
        return {}
    try:
        text = path.read_text()
    except OSError as e:
        logger.warning(f"Could not read {path}: {e}")
        return {}
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        try:
            data = json.loads(_strip_json_comments(text))
        except json.JSONDecodeError as e:
            logger.warning(f"Could not read {path}: {e}")
            return {}
    return data if isinstance(data, dict) else {}


def _write_text_atomic(path: Path, text: str) -> None:
    """Replace ``path`` atomically, keeping its mode and any symlink in place."""
    import tempfile
    target = path.resolve() if path.is_symlink() else path
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        mode = stat.S_IMODE(target.stat().st_mode)
    except FileNotFoundError:
        mode = None
    fd, tmp = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent))
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode if mode is not None else 0o644)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _write_settings(path: Path, data: dict):
    """Write settings JSON atomically, creating parent dirs if needed."""
    _write_text_atomic(path, json.dumps(data, indent=2) + "\n")


def _update_settings(path: Path, mutate, *, create: bool = True) -> bool:
    """Fail-safe read-modify-write of a CLI's JSON settings file.

    Returns False (and leaves the file untouched) when the file is missing and
    ``create`` is False, or when it cannot be read or parsed as strict JSON:
    a file we do not fully understand (syntax error, JSONC comments that a
    rewrite would drop) is never clobbered.
    """
    if not path.exists():
        if not create:
            return False
        settings: dict = {}
    else:
        try:
            text = path.read_text()
        except OSError as e:
            logger.warning("Not updating %s: could not read it (%s)", path, e)
            return False
        try:
            settings = json.loads(text)
        except json.JSONDecodeError as e:
            logger.warning(
                "Not updating %s: it is not plain JSON (%s). Fix or remove "
                "comments to let IVE manage its hooks there.", path, e,
            )
            return False
        if not isinstance(settings, dict):
            logger.warning("Not updating %s: top level is not an object", path)
            return False
    updated = mutate(settings)
    if updated is None:
        updated = settings
    _write_settings(path, updated)
    return True


# Codex 0.147.0 reads lifecycle hooks from config.toml, not settings.json.
# Marker-delimited array-of-table blocks let IVE add/remove its own groups
# without parsing or rewriting the user's unrelated TOML configuration.
_TOML_HOOK_MARKER_PREFIX = "IVE managed hooks"


def _toml_hook_marker(owner: str, *, end: bool = False) -> str:
    edge = "<<<" if end else ">>>"
    return f"# {edge} {_TOML_HOOK_MARKER_PREFIX}: {owner}"


def _remove_toml_hook_block(text: str, owner: str) -> str:
    """Remove IVE's ``owner`` block(s), keeping any [hooks.state.*] tables codex
    wrote inside them (trust for other hooks must survive an IVE uninstall)."""
    start = _toml_hook_marker(owner)
    end = _toml_hook_marker(owner, end=True)
    while True:
        start_at = text.find(start)
        if start_at < 0:
            break
        end_at = text.find(end, start_at + len(start))
        if end_at < 0:
            inner = text[start_at + len(start):]
            end_at = len(text)
        else:
            inner = text[start_at + len(start):end_at]
            end_at += len(end)
            if end_at < len(text) and text[end_at] == "\n":
                end_at += 1
        state_part = _split_state_tables(inner)[1].strip("\n")
        keep = state_part + "\n" if state_part else ""
        text = text[:start_at] + keep + text[end_at:]
    return text.rstrip() + ("\n" if text.strip() else "")


def _toml_scalar(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return json.dumps(str(value))


def _render_toml_hook_block(owner: str, event_groups: dict[str, list[dict]]) -> str:
    lines = [_toml_hook_marker(owner)]
    for event, groups in event_groups.items():
        for group in groups:
            lines.append(f"[[hooks.{event}]]")
            for key, value in group.items():
                if key != "hooks":
                    lines.append(f"{key} = {_toml_scalar(value)}")
            for hook in group.get("hooks", []):
                lines.append(f"[[hooks.{event}.hooks]]")
                for key, value in hook.items():
                    lines.append(f"{key} = {_toml_scalar(value)}")
    lines.append(_toml_hook_marker(owner, end=True))
    return "\n".join(lines) + "\n"


def _install_toml_hook_block(
    path: Path, owner: str, event_groups: dict[str, list[dict]]
) -> dict | None:
    """Install IVE's marker block for ``owner`` and keep IVE's Codex hooks trusted.

    Codex 0.16x keys hook trust by position (``<file>:<event>:<group>:<handler>``),
    so the block is rewritten only when its rendered content changed, and then in
    place: other blocks and the user's own hooks keep their indices. Codex writes
    its ``[hooks.state.*]`` tables after the last table in the file, which is often
    inside IVE's last block; those tables are preserved, never deleted.
    Returns the trust report (see ``codex_hook_trust_report``).
    """
    try:
        existing = path.read_text() if path.exists() else ""
    except OSError as exc:
        # Never fall back to "" here: that would rewrite the user's config
        # with nothing but IVE's block.
        logger.warning("Not writing IVE %s hooks to %s: could not read it (%s)", owner, path, exc)
        return {"all_ive_trusted": False, "reason": "settings_unreadable", "detail": str(exc)}
    rendered = _render_toml_hook_block(owner, event_groups)
    updated = _place_toml_hook_block(existing, owner, rendered)
    if updated != existing:
        try:
            tomllib.loads(updated)
        except tomllib.TOMLDecodeError as exc:
            # e.g. the user declares `[hooks] Stop = [...]` inline: appending
            # [[hooks.Stop]] would make codex refuse the whole config.
            logger.warning(
                "Not writing IVE %s hooks to %s: result would not parse (%s)",
                owner, path, exc,
            )
            report = _ensure_codex_hook_trust(path) or {}
            return {**report, "all_ive_trusted": False, "reason": "hook_block_conflict",
                    "detail": str(exc)}
        _write_text_atomic(path, updated)
    return _ensure_codex_hook_trust(path)


_TOML_STATE_HEADER_RE = re.compile(r"^\s*\[\s*hooks\s*\.\s*state\s*(?:\]|\.)")
_TOML_TABLE_HEADER_RE = re.compile(r"^\s*\[")


def _split_state_tables(inner: str) -> tuple[str, str]:
    """Split a marker block's body into (IVE hook tables, foreign state tables)."""
    keep, state = [], []
    in_state = False
    for line in inner.splitlines(keepends=True):
        if _TOML_TABLE_HEADER_RE.match(line):
            in_state = bool(_TOML_STATE_HEADER_RE.match(line))
        (state if in_state else keep).append(line)
    return "".join(keep), "".join(state)


def _place_toml_hook_block(text: str, owner: str, rendered: str) -> str:
    """Return ``text`` with exactly one ``owner`` block equal to ``rendered``."""
    start_marker = _toml_hook_marker(owner)
    end_marker = _toml_hook_marker(owner, end=True)
    spans: list[tuple[int, int, str]] = []
    pos = 0
    while True:
        start_at = text.find(start_marker, pos)
        if start_at < 0:
            break
        end_at = text.find(end_marker, start_at + len(start_marker))
        if end_at < 0:
            spans.append((start_at, len(text), text[start_at + len(start_marker):]))
            break
        inner = text[start_at + len(start_marker):end_at]
        end_at += len(end_marker)
        if end_at < len(text) and text[end_at] == "\n":
            end_at += 1
        spans.append((start_at, end_at, inner))
        pos = end_at
    if not spans:
        base = text.rstrip()
        return (base + "\n\n" if base else "") + rendered

    preserved = []
    for _, _, inner in spans:
        hook_part, state_part = _split_state_tables(inner)
        if state_part.strip():
            preserved.append(state_part.strip("\n") + "\n")
    first_start, first_end, first_inner = spans[0]
    current = start_marker + _split_state_tables(first_inner)[0].rstrip("\n") + "\n" + end_marker + "\n"
    if len(spans) == 1 and not preserved and current == rendered:
        return text
    replacement = rendered
    if preserved:
        replacement += "\n" + "\n".join(preserved)
    out = [text[:first_start], replacement]
    cursor = first_end
    for start_at, end_at, _ in spans[1:]:
        out.append(text[cursor:start_at])
        cursor = end_at
    out.append(text[cursor:])
    result = "".join(out)
    if len(spans) == 1 and not preserved:
        return result
    return result.rstrip() + "\n"


# ─── Codex hook trust (codex-cli >= 0.16x) ─────────────────────────────
#
# Codex runs a config.toml hook only when
#   [hooks.state."<config.toml path>:<event_snake>:<group idx>:<handler idx>"]
#   trusted_hash = "sha256:<hex>"
# matches the handler's current hash; otherwise the TUI shows "N hooks need
# review" and silently skips them. The hash is codex's own (codex-rs
# hooks/src/engine/discovery.rs `hook_hash` + config/src/fingerprint.rs
# `version_for_toml`): sha256 over the key-sorted compact JSON of
#   {"event_name": <snake>, "matcher": <matcher or absent>,
#    "hooks": [<normalized handler>]}
# Checked against hashes codex 0.162.1 wrote itself.
#
# IVE writes trust ONLY for handlers inside its own marker blocks. It never
# launches codex with --dangerously-bypass-hook-trust: that flag applies to
# every enabled hook of every layer (user config and project .codex/ in any
# repo a session opens), so it would also run unreviewed third-party hooks.
_CODEX_EVENT_LABELS = {
    "PreToolUse": "pre_tool_use",
    "PermissionRequest": "permission_request",
    "PostToolUse": "post_tool_use",
    "PreCompact": "pre_compact",
    "PostCompact": "post_compact",
    "SessionStart": "session_start",
    "SessionEnd": "session_end",
    "UserPromptSubmit": "user_prompt_submit",
    "SubagentStart": "subagent_start",
    "SubagentStop": "subagent_stop",
    "Stop": "stop",
    "Interrupt": "interrupt",
}
_CODEX_EVENTS_WITHOUT_MATCHER = {"UserPromptSubmit", "Stop", "Interrupt"}
_CODEX_EVENTS_WITH_CONTEXT_LIMIT = {
    "PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "SubagentStart",
}
_CODEX_DEFAULT_CONTEXT_LIMIT = 2500
_CODEX_SHORT_TIMEOUT_EVENTS = {"SessionEnd", "Interrupt"}


def codex_auto_trust_enabled() -> bool:
    return os.environ.get("IVE_CODEX_AUTO_TRUST_HOOKS", "1").strip().lower() not in {
        "0", "false", "no", "off",
    }


def codex_hook_key_source(config_path: Path) -> str:
    """The config.toml path codex uses in trust keys.

    codex canonicalizes $CODEX_HOME (find_codex_home) and joins config.toml;
    IVE always launches codex with CODEX_HOME set.
    """
    config_path = Path(config_path)
    return str(config_path.parent.resolve(strict=False) / config_path.name)


def codex_hook_hash(event: str, group: dict, handler: dict) -> str | None:
    """Codex's trust hash for one command handler (None if not hashable)."""
    label = _CODEX_EVENT_LABELS.get(event)
    if label is None or not isinstance(handler, dict):
        return None
    if handler.get("type", "command") != "command":
        return None
    command = handler.get("command")
    if not isinstance(command, str) or not command.strip():
        return None
    timeout = handler.get("timeout")
    if timeout is not None and (isinstance(timeout, bool) or not isinstance(timeout, int)):
        return None
    if event in _CODEX_SHORT_TIMEOUT_EVENTS:
        timeout = min(max(1 if timeout is None else timeout, 1), 3)
    else:
        timeout = max(600 if timeout is None else timeout, 1)
    normalized: dict[str, object] = {
        "type": "command",
        "command": command,
        "timeout": timeout,
        "async": bool(handler.get("async", False)),
    }
    if isinstance(handler.get("statusMessage"), str):
        normalized["statusMessage"] = handler["statusMessage"]
    limit = handler.get("additionalContextLimit")
    if (
        event in _CODEX_EVENTS_WITH_CONTEXT_LIMIT
        and isinstance(limit, int)
        and not isinstance(limit, bool)
        and limit != _CODEX_DEFAULT_CONTEXT_LIMIT
    ):
        normalized["additionalContextLimit"] = limit
    identity: dict[str, object] = {"event_name": label, "hooks": [normalized]}
    matcher = None if event in _CODEX_EVENTS_WITHOUT_MATCHER else group.get("matcher")
    if isinstance(matcher, str):
        identity["matcher"] = matcher
    payload = json.dumps(identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _scan_toml_hook_layout(text: str) -> tuple[dict, dict]:
    """Walk header lines in file order.

    Returns ({event: [handler count per group]}, {(event, g, h): owner}) where
    owner is the IVE marker block the handler sits in (None = user's hook).
    """
    counts: dict[str, list[int]] = {}
    owners: dict[tuple[str, int, int], str | None] = {}
    owner: str | None = None
    start_prefix = f"# >>> {_TOML_HOOK_MARKER_PREFIX}: "
    end_prefix = f"# <<< {_TOML_HOOK_MARKER_PREFIX}: "
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith(start_prefix):
            owner = line[len(start_prefix):].strip()
            continue
        if line.startswith(end_prefix):
            owner = None
            continue
        m = re.match(r"^\[\[\s*hooks\s*\.\s*([A-Za-z]+)\s*\.\s*hooks\s*\]\]", line)
        if m:
            event = m.group(1)
            groups = counts.setdefault(event, [0])
            groups[-1] += 1
            owners[(event, len(groups) - 1, groups[-1] - 1)] = owner
            continue
        m = re.match(r"^\[\[\s*hooks\s*\.\s*([A-Za-z]+)\s*\]\]", line)
        if m:
            counts.setdefault(m.group(1), []).append(0)
    return counts, owners


def _state_header(key: str) -> str:
    return f"[hooks.state.{json.dumps(key, ensure_ascii=False)}]"


def _set_trusted_hash(text: str, key: str, value: str) -> str | None:
    """Set trusted_hash for ``key`` in its existing header table, or append one.

    Returns None when the key exists in a form IVE does not edit (inline table,
    dotted keys); the caller then reports it instead of risking a duplicate key.
    """
    header = _state_header(key)
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if line.strip() != header:
            continue
        j = i + 1
        while j < len(lines) and not _TOML_TABLE_HEADER_RE.match(lines[j]):
            if re.match(r"^\s*trusted_hash\s*=", lines[j]):
                lines[j] = f"trusted_hash = {json.dumps(value)}\n"
                return "".join(lines)
            j += 1
        lines.insert(i + 1, f"trusted_hash = {json.dumps(value)}\n")
        return "".join(lines)
    base = text.rstrip()
    return (base + "\n\n" if base else "") + f"{header}\ntrusted_hash = {json.dumps(value)}\n"


def codex_hook_trust_report(path: Path, *, fix: bool = False) -> dict:
    """Which hooks in a Codex config.toml will actually run, IVE's in particular.

    With ``fix=True`` (and IVE_CODEX_AUTO_TRUST_HOOKS not disabled) IVE writes
    trusted_hash entries for handlers inside its own marker blocks only. A
    handler the user disabled (``enabled = false``) stays disabled.
    """
    path = Path(path)
    key_source = codex_hook_key_source(path)
    report: dict[str, object] = {
        "path": str(path),
        "key_source": key_source,
        "hooks": [],
        "ive_total": 0,
        "ive_trusted": 0,
        "auto_trusted": 0,
        "all_ive_trusted": False,
        "auto_trust": codex_auto_trust_enabled(),
        "reason": "ok",
    }
    try:
        text = path.read_text() if path.exists() else ""
        parsed = tomllib.loads(text)
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        report["reason"] = "config_unreadable"
        report["detail"] = str(exc)
        return report
    hooks_section = parsed.get("hooks", {})
    if not isinstance(hooks_section, dict):
        report["reason"] = "invalid_hooks_section"
        return report
    states = hooks_section.get("state", {})
    states = states if isinstance(states, dict) else {}
    counts, owners = _scan_toml_hook_layout(text)
    entries: list[dict] = []
    layout_ok = True
    for event, groups in hooks_section.items():
        if event == "state" or not isinstance(groups, list):
            continue
        text_counts = counts.get(event, [])
        parsed_counts = [
            len(g.get("hooks", [])) if isinstance(g, dict) and isinstance(g.get("hooks", []), list) else -1
            for g in groups
        ]
        if text_counts != parsed_counts:
            # Hooks declared in a syntax the line scan cannot index (inline
            # arrays, [hooks] PreToolUse = [...]): positions are unknown, so
            # IVE neither trusts nor claims trust for this event. Only a
            # problem when IVE has handlers in it.
            if any(o is not None for (ev, _, _), o in owners.items() if ev == event):
                layout_ok = False
            continue
        for g, group in enumerate(groups):
            for h, handler in enumerate(group.get("hooks", [])):
                key = f"{key_source}:{_CODEX_EVENT_LABELS.get(event, event)}:{g}:{h}"
                current = codex_hook_hash(event, group, handler)
                state = states.get(key) if isinstance(states.get(key), dict) else None
                if current is None:
                    status = "unsupported"
                elif state is not None and state.get("enabled") is False:
                    status = "disabled"
                elif state is not None and state.get("trusted_hash") == current:
                    status = "trusted"
                elif state is not None and state.get("trusted_hash"):
                    status = "modified"
                else:
                    status = "untrusted"
                entries.append({
                    "key": key,
                    "event": event,
                    "group": g,
                    "handler": h,
                    "owner": owners.get((event, g, h)),
                    "command": handler.get("command") if isinstance(handler, dict) else None,
                    "hash": current,
                    "status": status,
                })
    if not layout_ok:
        report["reason"] = "hook_layout_unindexable"

    if fix and report["auto_trust"]:
        new_text = text
        changed = []
        for entry in entries:
            if entry["owner"] is None or entry["status"] not in {"untrusted", "modified"}:
                continue
            candidate = _set_trusted_hash(new_text, entry["key"], entry["hash"])
            if candidate is None:
                continue
            new_text = candidate
            changed.append(entry)
        if changed:
            try:
                reparsed = tomllib.loads(new_text)
                new_states = reparsed.get("hooks", {}).get("state", {})
                if any(new_states.get(e["key"], {}).get("trusted_hash") != e["hash"] for e in changed):
                    raise ValueError("trust entries did not round-trip")
                _write_text_atomic(path, new_text)
            except (OSError, ValueError, tomllib.TOMLDecodeError) as exc:
                logger.warning("Could not write Codex hook trust to %s: %s", path, exc)
                report["reason"] = "trust_write_failed"
                report["detail"] = str(exc)
            else:
                for entry in changed:
                    entry["status"] = "trusted"
                    entry["auto_trusted"] = True
                report["auto_trusted"] = len(changed)
                logger.info("Trusted %d IVE Codex hook(s) in %s", len(changed), path)

    ive = [e for e in entries if e["owner"] is not None]
    report["hooks"] = entries
    report["ive_total"] = len(ive)
    report["ive_trusted"] = sum(1 for e in ive if e["status"] == "trusted")
    report["ive_untrusted"] = [
        {k: e[k] for k in ("key", "event", "owner", "status")}
        for e in ive if e["status"] != "trusted"
    ]
    report["all_ive_trusted"] = bool(ive) and layout_ok and report["ive_trusted"] == len(ive)
    return report


def _ensure_codex_hook_trust(path: Path) -> dict | None:
    try:
        return codex_hook_trust_report(path, fix=True)
    except Exception as exc:  # never let trust bookkeeping break hook install
        logger.warning("Codex hook trust check failed for %s: %s", path, exc)
        return None


def codex_hooks_notice(report: dict | None) -> str | None:
    """User-facing text when IVE's Codex hooks will not run, else None."""
    if not report or report.get("all_ive_trusted"):
        return None
    pending = report.get("ive_untrusted") or []
    disabled = [e for e in pending if e.get("status") == "disabled"]
    if report.get("reason") == "hook_block_conflict":
        why = "IVE could not add its Codex hooks (config.toml declares hooks inline)"
    elif report.get("reason") == "hook_layout_unindexable":
        why = "Codex hooks in config.toml use a layout IVE cannot index"
    elif disabled and len(disabled) == len(pending):
        why = f"{len(disabled)} IVE Codex hook(s) are disabled"
    else:
        why = f"{len(pending) or 'Some'} IVE Codex hook(s) need review"
    return (
        f"{why}, so Working/Ready status, native-id capture and the Safety Gate "
        f"do not run for Codex. Run /hooks in Codex and trust the IVE hooks "
        f"({report.get('path')})."
    )


def _uninstall_toml_hook_block(path: Path, owner: str) -> None:
    if not path.exists():
        return
    try:
        existing = path.read_text()
    except OSError as exc:
        logger.warning("Not removing IVE %s hooks from %s: could not read it (%s)", owner, path, exc)
        return
    text = _remove_toml_hook_block(existing, owner)
    if text != existing:
        _write_text_atomic(path, text)


def _has_toml_hook_block(path: Path, owner: str) -> bool:
    if not path.exists():
        return False
    try:
        return _toml_hook_marker(owner) in path.read_text()
    except OSError:
        return False


def _hook_command_path(command: str) -> Path | None:
    """Resolve one shell-quoted executable; reject extra arguments/operators."""
    try:
        words = shlex.split(command)
    except ValueError:
        return None
    if len(words) != 1:
        return None
    path = Path(words[0])
    return path.resolve(strict=False) if path.is_absolute() else None


def _hook_entry(profile: CLIProfile | None = None) -> dict:
    """A single Commander hook entry referencing the relay script."""
    if profile is not None:
        shape = profile.hook_entry_shape
        return {
            shape["entry_type_key"]: shape["entry_type_value"],
            shape["command_key"]: shlex.quote(str(HOOK_SCRIPT_PATH)),
        }
    return {
        "type": "command",
        "command": shlex.quote(str(HOOK_SCRIPT_PATH)),
    }


def _is_commander_hook(hook: dict) -> bool:
    """Check if a hook entry was installed by Commander."""
    return _is_ive_relay_command(hook.get("command", ""))


def _merge_hooks(
    settings: dict,
    events: list[str],
    profile: CLIProfile | None = None,
) -> dict:
    """Merge Commander hooks into settings, preserving existing hooks."""
    settings = _remove_hooks(settings, profile)
    shape = profile.hook_entry_shape if profile is not None else {
        "groups_key": "hooks", "matcher_key": "matcher"
    }
    hooks = settings.setdefault(shape["groups_key"], {})
    for event in events:
        if event in RELAY_EXCLUDED_EVENTS:
            continue
        groups = hooks.setdefault(event, [])
        groups.append({
            shape["matcher_key"]: "",
            shape["groups_key"]: [_hook_entry(profile)],
        })
    return settings


def _remove_hooks(settings: dict, profile: CLIProfile | None = None) -> dict:
    """Remove all Commander hooks from settings."""
    shape = profile.hook_entry_shape if profile is not None else {
        "groups_key": "hooks", "command_key": "command"
    }
    groups_key = shape["groups_key"]
    hooks = settings.get(groups_key, {})
    for event in list(hooks.keys()):
        groups = hooks[event]
        cleaned = []
        for group in groups:
            filtered = [
                h for h in group.get(groups_key, [])
                if not _is_ive_relay_command(
                    h.get(shape.get("command_key", "command"), "")
                )
            ]
            if filtered:
                group[groups_key] = filtered
                cleaned.append(group)
            # Drop entire group if it only had Commander hooks
        if cleaned:
            hooks[event] = cleaned
        else:
            del hooks[event]
    if not hooks:
        settings.pop(groups_key, None)
    return settings


# ─── Profile-driven hook install/uninstall ───────────────────────────
#
# All CLI-specific data (settings path, event names) comes from the
# CLIProfile.  Adding a third CLI only requires a new profile — nothing
# in this file needs to change.

from cli_profiles import CLIProfile, PROFILES, get_profile
from ive_cli_profile import (
    managed_home,
    prepare_ive_cli_env,
    runtime_home_for_cli,
    settings_path_for as _managed_settings_path_for,
)

# Backward-compat aliases — existing code may reference these directly.
CLAUDE_SETTINGS = Path(os.path.expanduser(get_profile("claude").settings_file))
GEMINI_SETTINGS = Path(os.path.expanduser(get_profile("gemini").settings_file))
CODEX_SETTINGS = Path(os.path.expanduser(get_profile("codex").settings_file))
CLAUDE_HOOK_EVENTS = relay_hook_events(get_profile("claude"))
GEMINI_HOOK_EVENTS = relay_hook_events(get_profile("gemini"))
CODEX_HOOK_EVENTS = relay_hook_events(get_profile("codex"))

_CODEX_COMMANDER_HOOK_OWNER = "commander-relay"
_CODEX_MYELIN_HOOK_OWNER = "myelin"
_CODEX_SAFETY_HOOK_OWNER = "safety-gate"


class HookInstallError(RuntimeError):
    """A guarded foreign-settings hook operation was refused."""

    def __init__(self, message: str, *, code: str = "hook_install_refused") -> None:
        super().__init__(message)
        self.code = code


_HOOK_ENTRY_SHAPE_FIELDS = {
    "groups_key", "matcher_key", "entry_type_key", "entry_type_value",
    "command_key", "timeout_key",
}


def _validate_hook_contract(profile: CLIProfile) -> None:
    if profile.hook_manifest_dialect not in {"json_groups", "toml_groups"}:
        raise HookInstallError(
            f"CLI profile '{profile.id}' has no supported hook manifest dialect",
            code="hooks_unsupported",
        )
    if profile.hook_decision_protocol not in {"claude_json", "exit_code"}:
        raise HookInstallError(
            f"CLI profile '{profile.id}' has no supported hook decision protocol",
            code="hooks_unsupported",
        )
    if set(profile.hook_entry_shape) != _HOOK_ENTRY_SHAPE_FIELDS:
        raise HookInstallError(
            f"CLI profile '{profile.id}' has no complete hook entry shape",
            code="hooks_unsupported",
        )
    expected_format = "json" if profile.hook_manifest_dialect == "json_groups" else "toml"
    if profile.hook_config_format != expected_format:
        raise HookInstallError(
            f"CLI profile '{profile.id}' hook dialect/config format disagree",
            code="hooks_unsupported",
        )
    pre_tool = profile.native_hook(HookEvent.PRE_TOOL)
    if not pre_tool or pre_tool not in profile.default_hook_events:
        raise HookInstallError(
            f"CLI profile '{profile.id}' has no installed pre-tool hook event",
            code="hooks_unsupported",
        )


def _assert_hook_path_within_profile_home(profile: CLIProfile, path: Path) -> None:
    if not profile.home_dir:
        raise HookInstallError(
            f"CLI profile '{profile.id}' has no declared home_dir",
            code="hook_path_outside_profile_home",
        )
    home = Path(os.path.expanduser(profile.home_dir)).resolve(strict=False)
    target = path.resolve(strict=False)
    try:
        target.relative_to(home)
    except ValueError as exc:
        raise HookInstallError(
            f"refusing hook path outside '{home}': {target}",
            code="hook_path_outside_profile_home",
        ) from exc


def _strict_read_hook_settings(path: Path, config_format: str):
    if not path.exists():
        return {} if config_format == "json" else ""
    try:
        content = path.read_text()
    except OSError as exc:
        raise HookInstallError(f"could not read foreign settings file '{path}': {exc}") from exc
    try:
        if config_format == "json":
            parsed = json.loads(content)
            if not isinstance(parsed, dict):
                raise ValueError("top level must be an object")
            return parsed
        tomllib.loads(content)
        return content
    except (json.JSONDecodeError, tomllib.TOMLDecodeError, ValueError) as exc:
        raise HookInstallError(
            f"foreign {config_format.upper()} settings do not parse: {path}: {exc}",
            code="invalid_foreign_settings",
        ) from exc


def dry_run_hooks_for_profile(
    profile: CLIProfile, settings_path: Path | None = None
) -> dict:
    """Render and validate the exact foreign-settings merge without writing."""
    _validate_hook_contract(profile)
    path = settings_path or _settings_path_for(profile)
    _assert_hook_path_within_profile_home(profile, path)
    config_format = profile.hook_config_format
    if config_format not in {"json", "toml"}:
        raise HookInstallError(
            f"unsupported hook_config_format '{config_format}'",
            code="invalid_hook_config_format",
        )

    existing = _strict_read_hook_settings(path, config_format)
    if profile.hook_manifest_dialect == "json_groups":
        shape = profile.hook_entry_shape
        groups = {
            event: [{
                shape["matcher_key"]: "",
                shape["groups_key"]: [_hook_entry(profile)],
            }]
            for event in relay_hook_events(profile)
        }
        merged = _merge_hooks(existing, relay_hook_events(profile), profile)
        merged_content = json.dumps(merged, indent=2) + "\n"
        hook_content = json.dumps({shape["groups_key"]: groups}, indent=2) + "\n"
        merge_path = "json:_merge_hooks"
        try:
            parsed = json.loads(merged_content)
            if not isinstance(parsed, dict):
                raise ValueError("top level must be an object")
        except (json.JSONDecodeError, ValueError) as exc:
            raise HookInstallError(
                f"generated JSON hook output does not parse: {exc}",
                code="invalid_generated_hook_config",
            ) from exc
    else:
        shape = profile.hook_entry_shape
        groups = {
            event: [{
                shape["matcher_key"]: "",
                shape["groups_key"]: [_hook_entry(profile)],
            }]
            for event in relay_hook_events(profile)
        }
        hook_content = _render_toml_hook_block(_CODEX_COMMANDER_HOOK_OWNER, groups)
        merged_content = _place_toml_hook_block(
            existing, _CODEX_COMMANDER_HOOK_OWNER, hook_content
        )
        merge_path = "toml:_place_toml_hook_block+_render_toml_hook_block"
        try:
            tomllib.loads(merged_content)
        except tomllib.TOMLDecodeError as exc:
            raise HookInstallError(
                f"generated TOML hook output does not parse: {exc}",
                code="invalid_generated_hook_config",
            ) from exc

    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "profile_id": profile.id,
                "path": str(path.resolve(strict=False)),
                "content": merged_content,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    return {
        "profile_id": profile.id,
        "path": str(path.resolve(strict=False)),
        "hook_content": hook_content,
        "merged_content": merged_content,
        "hook_config_format": config_format,
        "merge_path": merge_path,
        "confirmation": fingerprint,
        "written": False,
    }


def confirm_hooks_for_profile(
    profile: CLIProfile,
    *,
    confirmation: str,
    confirmed: bool,
    settings_path: Path | None = None,
) -> dict:
    """Recompute a dry run and write only after explicit, non-stale consent."""
    if confirmed is not True:
        raise HookInstallError(
            "explicit hook installation confirmation is required",
            code="hook_confirmation_required",
        )
    plan = dry_run_hooks_for_profile(profile, settings_path=settings_path)
    if not confirmation or confirmation != plan["confirmation"]:
        raise HookInstallError(
            "hook dry run is missing or stale; preview the current file again",
            code="stale_hook_dry_run",
        )

    path = Path(plan["path"])
    if profile.hook_manifest_dialect == "json_groups":
        _write_settings(path, json.loads(plan["merged_content"]))
    else:
        shape = profile.hook_entry_shape
        groups = {
            event: [{
                shape["matcher_key"]: "",
                shape["groups_key"]: [_hook_entry(profile)],
            }]
            for event in relay_hook_events(profile)
        }
        _install_toml_hook_block(path, _CODEX_COMMANDER_HOOK_OWNER, groups)
    return {**plan, "written": True}


def _settings_path_for(profile: CLIProfile, home: Path | None = None) -> Path:
    if home is not None:
        return _managed_settings_path_for(profile, home)
    hook_settings = getattr(profile, "hook_settings_file", "") or profile.settings_file
    return Path(os.path.expanduser(hook_settings))


def _runtime_settings_path_for(
    profile: CLIProfile, runtime_env: dict[str, str]
) -> Path:
    """Resolve the hook settings file from the environment the CLI will receive."""
    template = getattr(profile, "hook_settings_file", "") or profile.settings_file
    configured_root = runtime_env.get(profile.config_dir_env) if profile.config_dir_env else None
    if configured_root:
        root = Path(configured_root)
        if not root.is_absolute():
            raise HookInstallError(
                f"runtime {profile.config_dir_env} is not absolute: {configured_root}",
                code="relative_runtime_config_dir",
            )
        declared_home = Path(os.path.expanduser(profile.home_dir)).resolve(strict=False)
        declared_settings = Path(os.path.expanduser(template)).resolve(strict=False)
        try:
            relative_settings = declared_settings.relative_to(declared_home)
        except ValueError as exc:
            raise HookInstallError(
                f"hook settings for profile '{profile.id}' are outside its config root",
                code="hook_path_outside_profile_home",
            ) from exc
        return (root / relative_settings).resolve(strict=False)

    runtime_home = runtime_env.get("HOME")
    if not runtime_home or not Path(runtime_home).is_absolute():
        raise HookInstallError(
            f"profile '{profile.id}' has no absolute runtime HOME",
            code="missing_runtime_home",
        )
    return _settings_path_for(profile, Path(runtime_home)).resolve(strict=False)


def install_hooks_for_profile(
    profile: CLIProfile,
    settings_path: Path | None = None,
    *,
    managed: bool = False,
):
    """Install Commander hooks into a CLI's settings file."""
    _validate_hook_contract(profile)
    if profile.adapter_kind == "declarative" and not managed:
        raise HookInstallError(
            "declarative profiles require dry_run_hooks_for_profile followed by "
            "confirm_hooks_for_profile",
            code="hook_confirmation_required",
        )
    path = settings_path or _settings_path_for(profile)
    if profile.hook_manifest_dialect == "toml_groups":
        shape = profile.hook_entry_shape
        groups = {
            event: [{
                shape["matcher_key"]: "",
                shape["groups_key"]: [_hook_entry(profile)],
            }]
            for event in relay_hook_events(profile)
        }
        trust = _install_toml_hook_block(path, _CODEX_COMMANDER_HOOK_OWNER, groups)
        logger.info("Hooks installed in %s (%s, TOML)", path, profile.id)
        return trust
    if _update_settings(
        path, lambda settings: _merge_hooks(settings, relay_hook_events(profile), profile)
    ):
        logger.info("Hooks installed in %s (%s)", path, profile.id)


def uninstall_hooks_for_profile(
    profile: CLIProfile,
    settings_path: Path | None = None,
    *,
    managed: bool = False,
):
    """Remove Commander hooks from a CLI's settings file."""
    _validate_hook_contract(profile)
    if profile.adapter_kind == "declarative" and not managed:
        raise HookInstallError(
            "declarative foreign hooks require an explicit uninstall confirmation",
            code="hook_confirmation_required",
        )
    path = settings_path or _settings_path_for(profile)
    if profile.hook_manifest_dialect == "toml_groups":
        _uninstall_toml_hook_block(path, _CODEX_COMMANDER_HOOK_OWNER)
        logger.info("Hooks removed from %s (%s, TOML)", path, profile.id)
        return
    if _update_settings(path, lambda settings: _remove_hooks(settings, profile), create=False):
        logger.info("Hooks removed from %s (%s)", path, profile.id)


def install_hooks_for_managed_profile(cli_type: str, home: str | Path | None = None):
    """Install hooks into IVE's managed profile for a CLI."""
    profile = get_profile(cli_type)
    profile_home = Path(home) if home else managed_home(profile.id)
    settings_path = _settings_path_for(profile, profile_home)
    try:
        settings_path.resolve(strict=False).relative_to(profile_home.resolve(strict=False))
    except ValueError as exc:
        raise HookInstallError(
            f"managed hook path escapes runtime HOME: {settings_path}",
            code="hook_path_outside_runtime_home",
        ) from exc
    return install_hooks_for_profile(profile, settings_path=settings_path, managed=True)


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
            "command": shlex.quote(str(AVCP_CLAUDE_HOOK)),
            "timeout": 30,
        }],
    }


def _avcp_gemini_entry() -> dict:
    return {
        "matcher": "shell_execute|run_shell_command|Bash",
        "hooks": [{
            "type": "command",
            "command": shlex.quote(str(AVCP_GEMINI_HOOK)),
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

    # Claude Code -> PreToolUse
    def _add_claude(settings: dict) -> dict:
        settings = _remove_avcp_from_settings(settings)
        settings.setdefault("hooks", {}).setdefault("PreToolUse", []).append(_avcp_claude_entry())
        return settings

    if _update_settings(CLAUDE_SETTINGS, _add_claude):
        logger.info(f"AVCP hook installed in {CLAUDE_SETTINGS} (PreToolUse)")

    # Gemini/Antigravity CLI -> BeforeTool (only if ~/.gemini exists)
    if GEMINI_SETTINGS.parent.exists() and AVCP_GEMINI_HOOK.exists():
        def _add_gemini(settings: dict) -> dict:
            settings = _remove_avcp_from_settings(settings)
            settings.setdefault("hooks", {}).setdefault("BeforeTool", []).append(_avcp_gemini_entry())
            return settings

        if _update_settings(GEMINI_SETTINGS, _add_gemini):
            logger.info(f"AVCP hook installed in {GEMINI_SETTINGS} (BeforeTool)")


def uninstall_avcp_hooks():
    """Remove AVCP hooks from all CLI settings files."""
    for path in (CLAUDE_SETTINGS, GEMINI_SETTINGS):
        if _update_settings(path, _remove_avcp_from_settings, create=False):
            logger.info(f"AVCP hooks removed from {path}")


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
# Semantic conflict detection across concurrent sessions. Hooks are
# installed only when the separately owned SwarmLock extension is enabled. Per-workspace
# opt-out is enforced inside the hook's downstream MCP call via the
# workspace_settings.myelin_coordination_enabled flag.

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
    python = sys.executable or "python3"
    return f"{shlex.quote(python)} {shlex.quote(str(hook_script))} --event {shlex.quote(event)}"


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


def install_myelin_hooks():
    """Install coordination hooks into Claude Code, Codex, and Gemini/Antigravity settings."""
    from extension_host import available
    if not available("swarmlock"):
        # Do not mutate another CLI's settings merely because an edition omits
        # an optional product. Existing installed paths retain a compatibility
        # launcher; mandatory command-safety hooks are independent of this.
        logger.info("SwarmLock extension unavailable; coordination hook install skipped")
        return
    # Claude Code: UserPromptSubmit + PreToolUse
    def _add_claude(settings: dict) -> dict:
        settings = _remove_myelin_from_settings(settings)
        hooks = settings.setdefault("hooks", {})
        for event, entry_fn in [("UserPromptSubmit", _myelin_prompt_entry),
                                 ("PreToolUse", _myelin_tool_entry)]:
            hooks.setdefault(event, []).append(entry_fn())
        return settings

    if _update_settings(CLAUDE_SETTINGS, _add_claude):
        logger.info(f"Myelin coordination hooks installed in {CLAUDE_SETTINGS}")

    # Codex CLI: same lifecycle names, native TOML configuration shape.
    if CODEX_SETTINGS.parent.exists() or _cli_available("codex"):
        _install_toml_hook_block(CODEX_SETTINGS, _CODEX_MYELIN_HOOK_OWNER, {
            "UserPromptSubmit": [_myelin_prompt_entry()],
            "PreToolUse": [_myelin_tool_entry()],
        })
        logger.info(f"Myelin coordination hooks installed in {CODEX_SETTINGS}")

    # Gemini CLI: BeforeAgent + BeforeTool
    if GEMINI_SETTINGS.parent.exists() or _gemini_available():
        def _add_gemini(settings: dict) -> dict:
            settings = _remove_myelin_from_settings(settings)
            hooks = settings.setdefault("hooks", {})
            for event, entry_fn in [("BeforeAgent", _myelin_prompt_entry),
                                     ("BeforeTool", lambda: _myelin_tool_entry("edit_file|write_file|create_file"))]:
                hooks.setdefault(event, []).append(entry_fn())
            return settings

        if _update_settings(GEMINI_SETTINGS, _add_gemini):
            logger.info(f"Myelin coordination hooks installed in {GEMINI_SETTINGS}")


def uninstall_myelin_hooks():
    """Remove myelin coordination hooks from all CLI settings."""
    for path in (CLAUDE_SETTINGS, GEMINI_SETTINGS):
        if _update_settings(path, _remove_myelin_from_settings, create=False):
            logger.info(f"Myelin coordination hooks removed from {path}")
    _uninstall_toml_hook_block(CODEX_SETTINGS, _CODEX_MYELIN_HOOK_OWNER)


def check_myelin_installation() -> dict:
    """Check whether myelin coordination hooks are installed."""
    from extension_host import available
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
        "codex": _has_toml_hook_block(CODEX_SETTINGS, _CODEX_MYELIN_HOOK_OWNER),
        "gemini": _has(GEMINI_SETTINGS) if GEMINI_SETTINGS.exists() else False,
        "myelin_module_exists": available("swarmlock") and MYELIN_DIR.exists(),
        "extension_available": available("swarmlock"),
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
#   Fallback: fail closed (Claude asks; Gemini denies because it has no ask mode)

COMMANDER_API_URL="${COMMANDER_API_URL:-http://localhost:5111}"
INPUT=$(cat)

# BREAK-GLASS. This gate runs before EVERY tool call, so a bug in it locks the
# operator out of the machine needed to fix it (this happened: a mandatory
# session_id turned every non-IVE call into a denial, on four separate layers).
# Creating $IVE_DATA_DIR/hooks/BREAK_GLASS (legacy: ~/.ive/hooks/BREAK_GLASS)
# downgrades this hook to Tier-1 only: the
# local critical-pattern deny list below still runs (rm -rf /, mkfs, dd, pipe-
# to-shell, fork bomb, device writes, shutdown, kill 1, DROP TABLE), but a
# failure to reach or parse the API no longer blocks the call. It NEVER turns a
# Tier-1 critical match into an allow. Remove the file to restore full gating.
SAFETY_BREAK_GLASS=""
if [ -f "${IVE_DATA_DIR:-$HOME/.ive}/hooks/BREAK_GLASS" ]; then
  SAFETY_BREAK_GLASS=1
  echo "[Safety Gate] BREAK-GLASS active (Tier-1 critical rules only)" >&2
fi

# Extract tool_name and tool_input from hook JSON
TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null)

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
  if ps -p $PPID -o command= 2>/dev/null | grep -Eqi '\\b(agy|antigravity)\\b'; then
    CLI_TYPE="antigravity"
  elif ps -p $PPID -o command= 2>/dev/null | grep -qi '\\bgemini\\b'; then
    CLI_TYPE="gemini"
  elif ps -p $PPID -o command= 2>/dev/null | grep -qi '\\bcodex\\b'; then
    CLI_TYPE="codex"
  fi
fi
DECISION_PROTOCOL="${COMMANDER_HOOK_DECISION_PROTOCOL:-}"
if [ -z "$DECISION_PROTOCOL" ]; then
  case "$CLI_TYPE" in
    gemini|antigravity) DECISION_PROTOCOL="exit_code" ;;
    claude|codex) DECISION_PROTOCOL="claude_json" ;;
  esac
fi
case "$DECISION_PROTOCOL" in
  claude_json|exit_code) ;;
  *) echo "[Safety Gate] unsupported hook decision protocol for $CLI_TYPE" >&2; exit 2 ;;
esac

# Emit protocol JSON with a serializer. Rule names/reasons are data and may
# contain quotes or newlines; interpolating them into a heredoc can corrupt the
# hook response. If serialization itself is unavailable, exit 2 so the CLI
# blocks the operation.
emit_claude_decision() {
  if ! SAFETY_PERMISSION="$1" SAFETY_REASON="$2" python3 -c "import json,os; print(json.dumps({'hookSpecificOutput':{'hookEventName':'PreToolUse','permissionDecision':os.environ['SAFETY_PERMISSION'],'permissionDecisionReason':'[Safety Gate] '+os.environ['SAFETY_REASON']}}))"; then
    echo "[Safety Gate] could not serialize safety decision (fail-closed)" >&2
    exit 2
  fi
}

if [ -z "$TOOL_NAME" ]; then
  if [ "$DECISION_PROTOCOL" = "exit_code" ]; then
    echo "[Safety Gate] malformed hook input" >&2
    exit 2
  fi
  emit_claude_decision "deny" "malformed hook input (fail-closed)"
  exit 0
fi

# ── Tier 1: Local critical pattern check ──────────────────────────────
# These patterns are checked locally with zero network dependency. Command
# shape, not a closed tool-name list, decides whether this tier runs.
COMMAND=$(echo "$INPUT" | python3 -c "
import json, os, sys
i = (json.load(sys.stdin).get('tool_input') or {})
value = next((i.get(k) for k in ('command','cmd','shell_command','command_line','script','script_body') if isinstance(i.get(k), str) and i.get(k).strip()), '')
path = next((i.get(k) for k in ('script_path','executable_path') if isinstance(i.get(k), str) and i.get(k).strip()), '')
if not value and path:
    try:
        with open(path, 'r', errors='replace') as fh:
            value = fh.read(8000)
    except OSError:
        value = path
print(value)
" 2>/dev/null)
if [ -n "$COMMAND" ]; then
  BLOCKED=""
  REASON=""

  # The raw grep below cannot see what shell variables become. Resolve only
  # rm path operands (never execute the command) so break-glass still catches
  # `rm -rf "$UNSET_DIR/"` collapsing to `/` or an empty operand.
  COLLAPSED_RM=""
  if echo "$COMMAND" | grep -q '[$]' && SAFETY_COMMAND="$COMMAND" python3 - <<'PY'
import os
import re
import shlex
import sys

# This snippet is emitted into a bash heredoc inside a non-raw Python string,
# so a backslash-escaped quote here does NOT survive to the generated file.
# Build the quote set from chr() instead — no escapes, nothing to mangle.
_QUOTES = chr(34) + chr(39)

variable = re.compile(r'[$](?:[{]([A-Za-z_][A-Za-z0-9_]*)[}]|([A-Za-z_][A-Za-z0-9_]*))')
assignment = re.compile(r'^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\\s*$')
scope = dict(os.environ)

def expand(value):
    return variable.sub(
        lambda match: scope.get(match.group(1) or match.group(2), ''),
        value,
    )

dangerous = False
for segment in re.split(r'[;&|]+', os.environ.get('SAFETY_COMMAND', '')):
    local = assignment.match(segment)
    if local and ' rm ' not in f' {segment} ':
        value = local.group(2).strip().strip(_QUOTES)
        # Runtime-producing assignments are set-but-unknown, never assumed
        # empty. Literal/local assignments are carried into later segments.
        scope[local.group(1)] = (
            f'__ive_dynamic_{local.group(1)}__'
            if '$(' in value or '`' in value
            else expand(value)
        )
        continue
    try:
        words = shlex.split(segment, posix=True)
    except ValueError:
        continue
    rm_index = next(
        (index for index, word in enumerate(words) if os.path.basename(word) == 'rm'),
        None,
    )
    if rm_index is None:
        continue
    operands = words[rm_index + 1:]
    options = [word for word in operands if word.startswith('-')]
    recursive = any(word == '--recursive' or ('r' in word[1:] and not word.startswith('--')) for word in options)
    force = any(word == '--force' or ('f' in word[1:] and not word.startswith('--')) for word in options)
    if not (recursive and force):
        continue
    for operand in (word for word in operands if not word.startswith('-')):
        expanded = expand(operand)
        if expanded == '' or os.path.normpath(os.path.expanduser(expanded)) == '/':
            dangerous = True
            break
    if dangerous:
        break
sys.exit(0 if dangerous else 1)
PY
  then
    COLLAPSED_RM=1
  fi

  # Recursive force delete of root/home
  if echo "$COMMAND" | grep -qEi 'rm\\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\\s+(/\\s*$|/\\*|~/|/home)'; then
    BLOCKED=1; REASON="Recursive force delete targeting root or home directory"
  elif [ -n "$COLLAPSED_RM" ]; then
    BLOCKED=1; REASON="Recursive force delete path resolves to root or empty"
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
  elif echo "$COMMAND" | grep -qEi '(^|[;&|][[:space:]]*)(sudo[[:space:]]+)?([^[:space:]]*/)?(shutdown|reboot|halt|poweroff)([[:space:]]|[;&|]|$)|(^|[;&|][[:space:]]*)(sudo[[:space:]]+)?init[[:space:]]+[06]([[:space:]]|[;&|]|$)'; then
    BLOCKED=1; REASON="System shutdown/reboot/halt"
  # Kill init
  elif echo "$COMMAND" | grep -qEi '(^|[;&|][[:space:]]*)(sudo[[:space:]]+)?kill[[:space:]]+(-[^[:space:]]*9[^[:space:]]*[[:space:]]+)?1([[:space:]]|[;&|]|$)'; then
    BLOCKED=1; REASON="Killing PID 1 can crash the system"
  # DROP TABLE/DATABASE
  elif echo "$COMMAND" | grep -qEi 'DROP\\s+(TABLE|DATABASE|SCHEMA)'; then
    BLOCKED=1; REASON="DROP TABLE/DATABASE is irreversible"
  fi

  if [ -n "$BLOCKED" ]; then
    if [ "$DECISION_PROTOCOL" = "exit_code" ]; then
      echo "$REASON" >&2
      exit 2
    fi
    emit_claude_decision "deny" "$REASON"
    exit 0
  fi
fi

# Tier 1 for path-bearing tools: protect .ssh reads/writes plus /etc and .git
# mutations. Prompt/description strings are intentionally excluded.
FPATH=$(echo "$INPUT" | python3 -c "import sys,json; i=(json.load(sys.stdin).get('tool_input') or {}); print(next((i.get(k) for k in ('file_path','path','target_path','destination','destination_path','notebook_path') if isinstance(i.get(k),str) and i.get(k).strip()), ''))" 2>/dev/null)
if [ -n "$FPATH" ]; then
  BLOCKED=""
  REASON=""
  WRITE_TOOL=$(echo "$INPUT" | python3 -c "
import json,re,sys
d=json.load(sys.stdin); i=d.get('tool_input') or {}; n=str(d.get('tool_name') or '')
n=re.sub(r'([a-z0-9])([A-Z])', r'\\1_\\2', n).lower()
words=set(filter(None,re.split(r'[^a-z0-9]+',n)))
mut={'write','edit','create','delete','remove','patch','replace','save','move','copy','rename','mutate','update','apply'}
values={'content','patch','diff','old_string','new_string','replacement','new_content','edits'}
print('1' if words & mut or any(k in i for k in values) else '')
" 2>/dev/null)

  if echo "$FPATH" | grep -qE '[/~]\\.ssh/'; then
    BLOCKED=1; REASON="Accessing SSH keys or configuration"
  elif [ -n "$WRITE_TOOL" ] && echo "$FPATH" | grep -qE '^/etc/'; then
    BLOCKED=1; REASON="Writing to system config directory /etc/"
  elif [ -n "$WRITE_TOOL" ] && echo "$FPATH" | grep -qE '/\\.git/'; then
    BLOCKED=1; REASON="Writing directly to Git internals"
  fi

  if [ -n "$BLOCKED" ]; then
    if [ "$DECISION_PROTOCOL" = "exit_code" ]; then
      echo "$REASON" >&2
      exit 2
    fi
    emit_claude_decision "deny" "$REASON"
    exit 0
  fi
fi

# Break-glass exits here: every Tier-1 critical pattern above has already been
# evaluated and would have denied. Skipping Tier 2 gives up custom rules,
# logging and the classifier — deliberately, to keep the machine usable.
if [ -n "$SAFETY_BREAK_GLASS" ]; then
  exit 0
fi

# ── Scope: Tier 2 runs for IVE-managed sessions only ──────────────────
# This hook is registered globally in ~/.claude/settings.json, so it fires in
# EVERY project. Tier 1 above is offline, costs nothing and is worth having
# everywhere. Tier 2 is a network round trip whose audit log and precedent
# learning are only meaningful for IVE-managed work, and outside that context
# it added ~1s per call plus prompts the operator could not act on.
# COMMANDER_SESSION_ID is injected by IVE at spawn time and by nothing else,
# so its absence is an exact, zero-cost signal that this is not IVE work.
# Set IVE_SAFETY_ALWAYS=1 to force the full evaluation everywhere.
if [ -z "${COMMANDER_SESSION_ID:-}" ] && [ "${IVE_SAFETY_ALWAYS:-}" != "1" ]; then
  exit 0
fi

# ── Tier 2: Commander API evaluation ──────────────────────────────────
# Package manager commands need full AVCP scan + LLM analysis — no timeout.
# Normal tool calls budget ~2s so the LLM safety classifier (1.5s ceiling) can
# actually return a decision; a down Commander still can't block the CLI long
# (curl caps at MAX_TIME and any timeout is handled as a non-allowing result).
# The LLM classifier needs ~1.5s plus request overhead; a 2s cap raced it, and
# every timeout became a denial — which, in front of every tool call, locks the
# machine. 8s sits comfortably above the classifier ceiling and is still
# imperceptible for a single tool call.
MAX_TIME="8"
if [ -n "$COMMAND" ]; then
  case "$COMMAND" in
    *"pip install"*|*"pip3 install"*|*"npm install"*|*"npm i "*|*"npm add"*|\
    *"yarn add"*|*"pnpm add"*|*"bun add"*|*"cargo add"*|*"cargo install"*|\
    *"go get "*|*"go install"*|*"gem install"*|*"composer require"*|*"brew install"*)
      MAX_TIME="120"
      ;;
  esac
  # /tmp/ script execution: the server reads the script body and widens the
  # classifier ceiling to ~3s — a 2s curl cap would deny before the
  # verdict arrives, so give those calls more headroom.
  if [ "$MAX_TIME" = "8" ]; then
    case "$COMMAND" in
      *"/tmp/"*) MAX_TIME="6" ;;
    esac
  fi
fi
RESP=$(echo "$INPUT" | python3 -c "
import sys, json, os, re
d = json.load(sys.stdin)
cmd = str((d.get('tool_input') or {}).get('command') or '')
hints = {}
if cmd:
    names = sorted(set(re.findall('[$][{]?([A-Za-z_][A-Za-z0-9_]*)', cmd)))
    secret = re.compile('KEY|TOKEN|SECRET|PASS|CRED|AUTH|COOKIE|PRIVATE|SESSION', re.I)
    for n in names:
        if n in os.environ and len(hints) < 24:
            hints[n] = '***' if secret.search(n) else os.environ.get(n, '')[:200]
payload = {
    'tool_name': d.get('tool_name', ''),
    'tool_input': d.get('tool_input', {}),
    'tool_use_id': d.get('tool_use_id', ''),
    'session_id': '${COMMANDER_SESSION_ID:-}',
    'workspace_id': '${COMMANDER_WORKSPACE_ID:-}',
    'env_hints': hints
}
print(json.dumps(payload))
" 2>/dev/null | curl -s -X POST \\
  "${COMMANDER_API_URL}/api/safety/evaluate" \\
  -H "Content-Type: application/json" \\
  --max-time "$MAX_TIME" \\
  -d @- 2>/dev/null)

# Parse API response
DECISION=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('decision','deny'))" 2>/dev/null)
API_REASON=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason',''))" 2>/dev/null)
DECISION_TOKEN=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('decision_token',''))" 2>/dev/null)
TOOL_USE_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_use_id',''))" 2>/dev/null)
# An unreachable, slow, or malformed safety service is an AVAILABILITY failure,
# not a verdict. Degrade to ASK so the operator decides, rather than DENY, which
# turns any hiccup in this one service into a locked machine. The Tier-1
# critical patterns above already ran locally and would have denied outright,
# so this never opens a path to rm -rf /, mkfs, dd, pipe-to-shell, or shutdown.
[ -z "$DECISION" ] && DECISION="ask"
[ -z "$API_REASON" ] && API_REASON="Safety service unavailable or returned invalid output (fail-closed)"

case "$DECISION" in
  deny)
    if [ "$DECISION_PROTOCOL" = "exit_code" ]; then
      echo "[Safety Gate] $API_REASON" >&2
      exit 2
    fi
    emit_claude_decision "deny" "$API_REASON"
    exit 0
    ;;
  ask)
    if [ "$DECISION_PROTOCOL" = "exit_code" ]; then
      echo "[Safety Gate] $API_REASON (confirmation unavailable; denied)" >&2
      exit 2
    fi
    # A call outside an IVE-managed session gets no decision token by design:
    # it cannot own or reuse a session-scoped approval, so there is nothing to
    # prove. Ask the operator in their own CLI instead of denying — denying
    # here (the first cut) blocked every tool on the machine, including the
    # ones needed to repair the gate. A token is still REQUIRED whenever the
    # server issues one (i.e. inside a session), so approval reuse stays bound.
    if [ -z "$DECISION_TOKEN" ]; then
      emit_claude_decision "ask" "$API_REASON"
      exit 0
    fi
    if [ -z "$TOOL_USE_ID" ]; then
      emit_claude_decision "deny" "ASK carried a token without a tool_use_id (fail-closed)"
      exit 0
    fi
    DECISION_DIR="${TMPDIR:-/tmp}/ive-safety-decisions"
    DECISION_KEY=$(TOOL_USE_ID="$TOOL_USE_ID" python3 -c "import hashlib,os; print(hashlib.sha256((os.environ.get('COMMANDER_SESSION_ID','')+'\\0'+os.environ['TOOL_USE_ID']).encode()).hexdigest())" 2>/dev/null)
    umask 077
    if [ -z "$DECISION_KEY" ] || ! mkdir -p "$DECISION_DIR" 2>/dev/null || \
       [ ! -O "$DECISION_DIR" ] || ! chmod 700 "$DECISION_DIR" 2>/dev/null || \
       ! printf '%s' "$DECISION_TOKEN" > "$DECISION_DIR/$DECISION_KEY.tmp.$$" || \
       ! mv "$DECISION_DIR/$DECISION_KEY.tmp.$$" "$DECISION_DIR/$DECISION_KEY"; then
      rm -f "$DECISION_DIR/$DECISION_KEY.tmp.$$" 2>/dev/null
      emit_claude_decision "deny" "could not retain signed decision token (fail-closed)"
      exit 0
    fi
    emit_claude_decision "ask" "$API_REASON"
    exit 0
    ;;
  allow|allow_auto)
    # Even legacy servers must not bypass the agent's chosen permission mode.
    # No decision means continue through the native permission checks.
    exit 0
    ;;
  *)
    if [ "$DECISION_PROTOCOL" = "exit_code" ]; then
      echo "[Safety Gate] invalid safety decision (fail-closed)" >&2
      exit 2
    fi
    emit_claude_decision "deny" "invalid safety decision (fail-closed)"
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
# Return the pre-hook's signed decision so one exact repeat may be authorized.

COMMANDER_API_URL="${COMMANDER_API_URL:-http://localhost:5111}"
INPUT=$(cat)

TOOL_USE_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_use_id',''))" 2>/dev/null)
[ -z "$TOOL_USE_ID" ] && exit 0

DECISION_DIR="${TMPDIR:-/tmp}/ive-safety-decisions"
[ ! -d "$DECISION_DIR" ] && exit 0
[ ! -O "$DECISION_DIR" ] && exit 0
DECISION_KEY=$(TOOL_USE_ID="$TOOL_USE_ID" python3 -c "import hashlib,os; print(hashlib.sha256((os.environ.get('COMMANDER_SESSION_ID','')+'\\0'+os.environ['TOOL_USE_ID']).encode()).hexdigest())" 2>/dev/null)
[ -z "$DECISION_KEY" ] && exit 0
DECISION_FILE="$DECISION_DIR/$DECISION_KEY"
[ ! -f "$DECISION_FILE" ] && exit 0
DECISION_TOKEN=$(cat "$DECISION_FILE" 2>/dev/null)
[ -z "$DECISION_TOKEN" ] && exit 0

PAYLOAD=$(TOOL_USE_ID="$TOOL_USE_ID" DECISION_TOKEN="$DECISION_TOKEN" python3 -c "import json,os; print(json.dumps({'tool_use_id':os.environ['TOOL_USE_ID'],'decision_token':os.environ['DECISION_TOKEN']}))" 2>/dev/null)
[ -z "$PAYLOAD" ] && exit 0
HTTP_STATUS=$(printf '%s' "$PAYLOAD" | curl -s -o /dev/null -w '%{http_code}' -X POST \\
  "${COMMANDER_API_URL}/api/safety/approved" \\
  -H "Content-Type: application/json" \\
  --max-time 2 \\
  -d @- 2>/dev/null)

case "$HTTP_STATUS" in
  2??) rm -f "$DECISION_FILE" ;;
esac

exit 0
"""


def generate_safety_gate_script():
    """Write the safety gate hook scripts to ~/.ive/hooks/."""
    HOOKS_DIR.mkdir(parents=True, exist_ok=True)
    from helper_command import shell_python_function
    python_shim = shell_python_function()
    def with_python(script):
        return script.replace("#!/bin/bash\n", "#!/bin/bash\n" + python_shim, 1) if python_shim else script
    SAFETY_GATE_SCRIPT_PATH.write_text(with_python(SAFETY_GATE_SCRIPT))
    SAFETY_GATE_SCRIPT_PATH.chmod(
        SAFETY_GATE_SCRIPT_PATH.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH
    )
    SAFETY_GATE_POST_SCRIPT_PATH.write_text(with_python(SAFETY_GATE_POST_SCRIPT))
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
            "command": shlex.quote(str(SAFETY_GATE_SCRIPT_PATH)),
            "timeout": 135,
        }],
    }


def _safety_gate_post_entry() -> dict:
    return {
        "matcher": "",  # Match ALL tools
        "hooks": [{
            "type": "command",
            "command": shlex.quote(str(SAFETY_GATE_POST_SCRIPT_PATH)),
            "timeout": 2,
        }],
    }


def attest_runtime_safety_gate(
    cli_type: str, runtime_env: dict[str, str]
) -> dict[str, object]:
    """Prove the exact runtime profile has the current all-tools safety hook."""
    profile = get_profile(cli_type)
    try:
        settings_path = _runtime_settings_path_for(profile, runtime_env)
    except HookInstallError as exc:
        return {
            "attested": False,
            "profile_id": profile.id,
            "path": None,
            "reason": exc.code,
            "detail": str(exc),
        }

    evidence: dict[str, object] = {
        "attested": False,
        "profile_id": profile.id,
        "path": str(settings_path),
        "hook_config_format": profile.hook_config_format,
    }
    try:
        settings_bytes = settings_path.read_bytes()
    except FileNotFoundError:
        return {**evidence, "reason": "runtime_settings_missing"}
    except OSError as exc:
        return {
            **evidence,
            "reason": "runtime_settings_unreadable",
            "detail": str(exc),
        }

    evidence["settings_sha256"] = hashlib.sha256(settings_bytes).hexdigest()
    try:
        settings_text = settings_bytes.decode("utf-8")
        if profile.hook_config_format == "json":
            settings = json.loads(settings_text)
        elif profile.hook_config_format == "toml":
            settings = tomllib.loads(settings_text)
        else:
            return {**evidence, "reason": "unsupported_hook_config_format"}
        if not isinstance(settings, dict):
            return {**evidence, "reason": "invalid_runtime_settings"}
    except (UnicodeDecodeError, json.JSONDecodeError, tomllib.TOMLDecodeError) as exc:
        return {
            **evidence,
            "reason": "invalid_runtime_settings",
            "detail": str(exc),
        }

    pre_tool_event = profile.native_hook(HookEvent.PRE_TOOL)
    if not pre_tool_event:
        return {**evidence, "reason": "profile_has_no_pre_tool_hook"}
    evidence["pre_tool_event"] = pre_tool_event

    script_path = SAFETY_GATE_SCRIPT_PATH.resolve(strict=False)
    try:
        script_bytes = script_path.read_bytes()
    except FileNotFoundError:
        return {**evidence, "reason": "safety_gate_script_missing"}
    except OSError as exc:
        return {
            **evidence,
            "reason": "safety_gate_script_unreadable",
            "detail": str(exc),
        }
    script_hash = hashlib.sha256(script_bytes).hexdigest()
    expected_script_hash = hashlib.sha256(SAFETY_GATE_SCRIPT.encode()).hexdigest()
    evidence["script_path"] = str(script_path)
    evidence["script_sha256"] = script_hash
    if script_hash != expected_script_hash:
        return {**evidence, "reason": "safety_gate_script_hash_mismatch"}
    if not os.access(script_path, os.X_OK):
        return {**evidence, "reason": "safety_gate_script_not_executable"}

    hooks_section = settings.get("hooks", {})
    if not isinstance(hooks_section, dict):
        return {**evidence, "reason": "invalid_runtime_hook_shape"}
    groups = hooks_section.get(pre_tool_event, [])
    exact_hook_found = False
    if isinstance(groups, list):
        for group in groups:
            if not isinstance(group, dict) or group.get("matcher") != "":
                continue
            hooks = group.get("hooks", [])
            if not isinstance(hooks, list):
                continue
            for hook in hooks:
                if not isinstance(hook, dict) or hook.get("type") != "command":
                    continue
                command = hook.get("command")
                if not isinstance(command, str):
                    continue
                command_path = _hook_command_path(command)
                if command_path == script_path:
                    exact_hook_found = True
                    break
            if exact_hook_found:
                break
    if not exact_hook_found:
        return {**evidence, "reason": "exact_pre_tool_hook_missing"}

    if profile.hook_config_format == "toml":
        # Codex 0.16x skips untrusted config.toml hooks without failing, so a
        # present-but-untrusted gate would be "attested" yet never run.
        trust = codex_hook_trust_report(settings_path)
        gate_entries = [
            entry for entry in trust.get("hooks", [])
            if entry.get("event") == pre_tool_event
            and isinstance(entry.get("command"), str)
            and _hook_command_path(entry["command"]) == script_path
        ]
        evidence["hook_trust"] = {
            "key_source": trust.get("key_source"),
            "gate": [
                {"key": e["key"], "status": e["status"]} for e in gate_entries
            ],
            "ive_trusted": trust.get("ive_trusted"),
            "ive_total": trust.get("ive_total"),
            "reason": trust.get("reason"),
        }
        if not any(entry.get("status") == "trusted" for entry in gate_entries):
            return {**evidence, "reason": "codex_hook_untrusted"}

    return {**evidence, "attested": True, "reason": "attested"}


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
    """Install Safety Gate hooks into Claude Code, Codex, and Gemini/Antigravity."""
    generate_safety_gate_script()

    # Claude Code -> PreToolUse + PostToolUse (matcher: "" = all tools)
    def _add_claude(settings: dict) -> dict:
        settings = _remove_safety_gate_from_settings(settings)
        hooks = settings.setdefault("hooks", {})
        hooks.setdefault("PreToolUse", []).append(_safety_gate_entry())
        hooks.setdefault("PostToolUse", []).append(_safety_gate_post_entry())
        return settings

    if _update_settings(CLAUDE_SETTINGS, _add_claude):
        logger.info("Safety Gate hooks installed in %s (PreToolUse + PostToolUse)", CLAUDE_SETTINGS)

    # Codex CLI -> PreToolUse + PostToolUse. Codex uses the Claude-style
    # hook decision payload for blocking/asking.
    if CODEX_SETTINGS.parent.exists() or _cli_available("codex"):
        _install_toml_hook_block(CODEX_SETTINGS, _CODEX_SAFETY_HOOK_OWNER, {
            "PreToolUse": [_safety_gate_entry()],
            "PostToolUse": [_safety_gate_post_entry()],
        })
        logger.info("Safety Gate hooks installed in %s (PreToolUse + PostToolUse)", CODEX_SETTINGS)

    # Gemini/Antigravity CLI -> BeforeTool + AfterTool (only if ~/.gemini exists)
    if GEMINI_SETTINGS.parent.exists():
        def _add_gemini(settings: dict) -> dict:
            settings = _remove_safety_gate_from_settings(settings)
            hooks = settings.setdefault("hooks", {})
            hooks.setdefault("BeforeTool", []).append(_safety_gate_entry())
            hooks.setdefault("AfterTool", []).append(_safety_gate_post_entry())
            return settings

        if _update_settings(GEMINI_SETTINGS, _add_gemini):
            logger.info("Safety Gate hooks installed in %s (BeforeTool + AfterTool)", GEMINI_SETTINGS)



def uninstall_safety_gate_hooks():
    """Remove Safety Gate hooks from Claude Code, Codex, and Gemini/Antigravity."""
    if _update_settings(CLAUDE_SETTINGS, _remove_safety_gate_from_settings, create=False):
        logger.info("Safety Gate hooks removed from %s", CLAUDE_SETTINGS)
    _uninstall_toml_hook_block(CODEX_SETTINGS, _CODEX_SAFETY_HOOK_OWNER)
    if _update_settings(GEMINI_SETTINGS, _remove_safety_gate_from_settings, create=False):
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
        "codex": _has_toml_hook_block(CODEX_SETTINGS, _CODEX_SAFETY_HOOK_OWNER),
        "gemini": _has(GEMINI_SETTINGS) if GEMINI_SETTINGS.exists() else False,
        "script_exists": SAFETY_GATE_SCRIPT_PATH.exists(),
    }


# ─── Unified install/uninstall ────────────────────────────────────────

def install_all():
    """Generate script and install hooks for IVE-managed CLI profiles."""
    generate_hook_script()
    results: dict[str, dict] = {}
    for profile in PROFILES.values():
        if not getattr(profile, "active", True):
            continue
        if profile.adapter_kind == "declarative":
            try:
                _validate_hook_contract(profile)
            except HookInstallError as exc:
                results[profile.id] = {
                    "status": "unsupported", "code": exc.code, "reason": str(exc),
                }
            else:
                results[profile.id] = {
                    "status": "confirmation_required",
                    "code": "hook_confirmation_required",
                }
            continue
        if _cli_available(profile):
            try:
                env = prepare_ive_cli_env(profile.id)
                trust = install_hooks_for_managed_profile(profile.id, env.get("HOME"))
                results[profile.id] = {"status": "installed"}
                if isinstance(trust, dict):
                    results[profile.id]["hook_trust"] = {
                        "all_ive_trusted": trust.get("all_ive_trusted"),
                        "ive_trusted": trust.get("ive_trusted"),
                        "ive_total": trust.get("ive_total"),
                        "auto_trusted": trust.get("auto_trusted"),
                    }
                    notice = codex_hooks_notice(trust)
                    if notice:
                        logger.warning("%s", notice)
            except HookInstallError as exc:
                results[profile.id] = {
                    "status": "unsupported", "code": exc.code, "reason": str(exc),
                }
        else:
            results[profile.id] = {"status": "binary_unavailable"}
    return results


def uninstall_all():
    """Remove Commander hooks from IVE-managed CLI profiles."""
    results: dict[str, dict] = {}
    for profile in PROFILES.values():
        if not getattr(profile, "active", True):
            continue
        if profile.adapter_kind == "declarative":
            results[profile.id] = {
                "status": "confirmation_required",
                "code": "hook_confirmation_required",
            }
            continue
        uninstall_hooks_for_profile(
            profile,
            _settings_path_for(profile, runtime_home_for_cli(profile.id)),
        )
        results[profile.id] = {"status": "removed"}
    return results


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

    result = {"script_exists": HOOK_SCRIPT_PATH.exists()}
    for profile in PROFILES.values():
        if not getattr(profile, "active", True):
            continue
        try:
            _validate_hook_contract(profile)
        except HookInstallError as exc:
            result[profile.id] = {
                "status": "unsupported", "code": exc.code, "reason": str(exc),
            }
            continue
        path = _settings_path_for(profile, runtime_home_for_cli(profile.id))
        if profile.hook_config_format == "toml":
            result[profile.id] = _has_toml_hook_block(
                path, _CODEX_COMMANDER_HOOK_OWNER
            )
        else:
            result[profile.id] = _has_hooks(path)
    return result


def _cli_available(profile_or_binary) -> bool:
    """Check if a CLI binary is installed on PATH."""
    import shutil
    if isinstance(profile_or_binary, str):
        return shutil.which(profile_or_binary) is not None
    binaries = [profile_or_binary.binary, *getattr(profile_or_binary, "binary_candidates", [])]
    return any(shutil.which(binary) is not None for binary in binaries if binary)


def _gemini_available() -> bool:
    """Check if gemini CLI is installed (backward compat wrapper)."""
    return _cli_available("gemini")
