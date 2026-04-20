#!/usr/bin/env python3
"""Claude Code hooks for Myelin multi-agent coordination.

Two hooks that work together:

1. UserPromptSubmit — captures user intent when they type a message.
   Stores the intent in a sidecar file that PreToolUse reads.

2. PreToolUse — fires before Edit/Write. Checks for overlapping work
   via shared workspace. Blocks or injects context based on overlap level.

Setup in .claude/settings.json (project or global):

{
  "hooks": {
    "UserPromptSubmit": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "python3 -m myelin.coordination.hook --event user_prompt"
      }]
    }],
    "PreToolUse": [{
      "matcher": "Edit|Write|MultiEdit|NotebookEdit",
      "hooks": [{
        "type": "command",
        "command": "python3 -m myelin.coordination.hook --event pre_tool"
      }]
    }]
  }
}

No manual env vars needed. The hook auto-detects:
  - session_id from hook input (unique per Claude Code instance)
  - user intent from UserPromptSubmit hook
  - shared DB at ~/.myelin/coord.db (or MYELIN_DB_PATH env)
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path


# Sidecar dir for passing user prompts between hooks.
# Lives under the current user's private temp dir (0700 created below).
SIDECAR_DIR = Path(tempfile.gettempdir()) / f"myelin_hook_sidecar_{os.getuid()}" if hasattr(os, "getuid") else Path(tempfile.gettempdir()) / "myelin_hook_sidecar"

# Stale sidecar cutoff — files older than this are cleaned up on write.
SIDECAR_MAX_AGE_SECS = 24 * 3600

# Only allow alphanumerics, dash, underscore in session_id (defeats path traversal).
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _safe_session_id(session_id: str) -> str | None:
    """Return sanitized session_id, or None if invalid."""
    if not session_id or not _SESSION_ID_RE.match(session_id):
        return None
    return session_id


def _sidecar_path(session_id: str) -> Path:
    """Per-session sidecar file for storing user prompt."""
    return SIDECAR_DIR / f"{session_id}.prompt"


def _ensure_sidecar_dir() -> None:
    """Create sidecar dir with mode 0700."""
    SIDECAR_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(SIDECAR_DIR, 0o700)
    except OSError:
        pass


def _cleanup_stale_sidecars() -> None:
    """Remove sidecar files older than SIDECAR_MAX_AGE_SECS. Best-effort."""
    try:
        now = time.time()
        for f in SIDECAR_DIR.glob("*.prompt"):
            try:
                if now - f.stat().st_mtime > SIDECAR_MAX_AGE_SECS:
                    f.unlink()
            except OSError:
                pass
    except OSError:
        pass


# ─── Hook: UserPromptSubmit ───

def handle_user_prompt(data: dict) -> None:
    """Store the user's prompt so PreToolUse can use it for intent."""
    session_id = _safe_session_id(data.get("session_id", ""))
    prompt = data.get("prompt", "")
    if not session_id or not prompt:
        sys.exit(0)

    _ensure_sidecar_dir()
    _cleanup_stale_sidecars()

    # Write with mode 0600 — only current user can read.
    sp = _sidecar_path(session_id)
    fd = os.open(str(sp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, prompt[:500].encode("utf-8", errors="replace"))
    finally:
        os.close(fd)
    # Exit 0 — allow the prompt to proceed to Claude
    sys.exit(0)


# ─── Hook: PreToolUse ───

async def handle_pre_tool(data: dict) -> None:
    """Check for coordination conflicts before destructive operations."""
    tool_name = data.get("tool_name", "") or ""
    tool_input = data.get("tool_input", {}) or {}
    session_id_raw = data.get("session_id", "") or ""

    # Only check destructive ops. Empty tool_name must NOT pass this gate.
    if not tool_name or tool_name not in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        sys.exit(0)

    file_path = (
        tool_input.get("file_path")
        or tool_input.get("path")
        or tool_input.get("notebook_path")
        or ""
    )
    if not file_path:
        sys.exit(0)

    session_id = _safe_session_id(session_id_raw) or "unknown"

    # Read user prompt from sidecar (written by UserPromptSubmit hook)
    user_prompt = ""
    if session_id != "unknown":
        try:
            sp = _sidecar_path(session_id)
            if sp.exists():
                user_prompt = sp.read_text()
        except OSError:
            pass

    # Late imports
    try:
        from myelin import Myelin
        from myelin.coordination import (
            AgentWorkspace, AgentObserver, CoordinationResolver, Action,
        )
        from myelin.storage.sqlite import SQLiteStorage
        from myelin.core.embeddings import GeminiEmbedding
    except ImportError as e:
        # Myelin not installed — fail open
        sys.exit(0)

    # Configure
    db_path = os.environ.get("MYELIN_DB_PATH", os.path.expanduser("~/.myelin/coord.db"))
    namespace = os.environ.get("MYELIN_NAMESPACE", "claude_code:shared")
    agent_id = f"session_{session_id}" if session_id != "unknown" else f"pid_{os.getpid()}"

    try:
        os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
        storage = SQLiteStorage(db_path=db_path, embedding_dims=3072)
        embedder = GeminiEmbedding()
        brain = Myelin(namespace=namespace, storage=storage, embedder=embedder)

        workspace = AgentWorkspace(brain)
        resolver = CoordinationResolver(workspace=workspace, block_on_conflict=True)
    except Exception:
        sys.exit(0)  # Fail open

    # Build observer with whatever context we have
    obs = AgentObserver(workspace, agent_id=agent_id)
    if user_prompt:
        obs.record_user_prompt(user_prompt)
    obs.record_tool_call(tool_name, {"file_path": file_path}, "")

    try:
        conflicts = await obs.check_before_write(file_path)
    except Exception:
        sys.exit(0)

    if not conflicts:
        # No overlap — announce our intent so other agents see us
        try:
            await obs._maybe_update_task()
        except Exception:
            pass
        sys.exit(0)

    # Resolve
    try:
        resolution = await resolver.resolve(conflicts, action_type=tool_name.lower())
    except Exception:
        sys.exit(0)

    if resolution.action == Action.BLOCK:
        # Structured deny — cleaner than exit code 2
        output = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": resolution.message,
            }
        }
        print(json.dumps(output))
        sys.exit(0)

    if resolution.action == Action.PROCEED_WITH_NOTE:
        # Inject coordination context — Claude sees it alongside tool result
        output = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "additionalContext": resolution.message,
            }
        }
        print(json.dumps(output))
        try:
            await obs._maybe_update_task()
        except Exception:
            pass
        sys.exit(0)

    # Default: allow
    sys.exit(0)


# ─── Entrypoint ───

def main() -> None:
    # Determine which hook event we're handling
    event = "pre_tool"  # default
    if "--event" in sys.argv:
        idx = sys.argv.index("--event")
        if idx + 1 < len(sys.argv):
            event = sys.argv[idx + 1]

    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    if event == "user_prompt":
        handle_user_prompt(data)
    elif event == "pre_tool":
        asyncio.run(handle_pre_tool(data))
    else:
        sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
    except Exception as e:
        # Never crash Claude Code — fail open
        print(str(e), file=sys.stderr)
        sys.exit(0)
