"""
Hook event receiver for Claude Code and Gemini CLI lifecycle hooks.

Replaces the ANSI-based session state detection (idle timers, silence-based
prompt detection, numbered-option regex, cursor character matching) with
structured JSON events POSTed by CLI hooks.

Hook events arrive at POST /api/hooks/event from the relay script
(~/.ive/hooks/hook.sh) which fires inside each CLI session.
The script only activates when COMMANDER_SESSION_ID is set in the env,
so standalone CLI usage is unaffected.
"""

import json
import logging
import time
from aiohttp import web

logger = logging.getLogger(__name__)

# ─── W2W workspace flag cache ────────────────────────────────────────
# Avoids a DB query on every PostToolUse for file edits.
# Cache is {session_id -> {"context": bool, "comms": bool, "ts": float}}.
# Entries expire after 60s or when invalidated.
_w2w_flag_cache: dict[str, dict] = {}
_W2W_CACHE_TTL = 60.0


async def _get_w2w_enabled(session_id: str, flag: str = "context") -> bool:
    """Check if a W2W flag is on for this session's workspace (cached).

    flag: "context" (context_sharing_enabled) or "comms" (comms_enabled)
    """
    cached = _w2w_flag_cache.get(session_id)
    if cached and (time.monotonic() - cached["ts"]) < _W2W_CACHE_TTL:
        return cached.get(flag, False)

    from db import get_db
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT w.context_sharing_enabled, w.comms_enabled FROM sessions s
               JOIN workspaces w ON s.workspace_id = w.id
               WHERE s.id = ?""",
            (session_id,),
        )
        row = await cur.fetchone()
        ctx = bool(row and row["context_sharing_enabled"])
        comms = bool(row and row["comms_enabled"])
        _w2w_flag_cache[session_id] = {"context": ctx, "comms": comms, "ts": time.monotonic()}
        return ctx if flag == "context" else comms
    finally:
        await db.close()


def invalidate_w2w_cache(session_id: str = None):
    """Call when workspace settings change to bust the cache."""
    if session_id:
        _w2w_flag_cache.pop(session_id, None)
    else:
        _w2w_flag_cache.clear()


# ─── Per-session hook state ───────────────────────────────────────────
# Replaces: _session_prompt_state, _idle_timers, _pending_prompts,
#           _last_idle_broadcast from the old ANSI detection system.

# Sessions whose native_session_id has already been captured from hooks.
# Prevents a DB query on every subsequent hook event.
_native_id_resolved: set[str] = set()

_hook_sessions: dict[str, dict] = {}
# session_id -> {
#   "state": "idle" | "working" | "prompting",
#   "last_idle_at": float (monotonic),
#   "tool_stack": [str],  # nested tool calls
#   "subagents": {agent_id -> {id, type, status, started_at, tools: [], result}},
# }

_IDLE_THROTTLE_INTERVAL = 15.0  # seconds — same as old IDLE_BROADCAST_MIN_INTERVAL

# Module-level broadcast function — injected by server.py on startup
_broadcast = None

# Module-level PTY manager — injected by server.py on startup so hooks can
# write warnings directly into agent PTYs (peer warnings, file conflicts).
_pty_mgr = None

# Module-level OutputCaptureProcessor — injected by server.py on startup so
# the compaction hook can re-arm the per-session context-low warning flag.
_capture_proc = None

# Pending PTY warnings — queued during PostToolUse, delivered on next Stop (idle).
# {session_id -> [{"message": str, "priority": str, "source": str}]}
_pending_pty_warnings: dict[str, list[dict]] = {}


def set_broadcast_fn(fn):
    """Called once at startup to inject the WebSocket broadcast function."""
    global _broadcast
    _broadcast = fn


def set_pty_manager(mgr):
    """Called once at startup to inject the PTY manager for writing warnings to agents."""
    global _pty_mgr
    _pty_mgr = mgr


def set_capture_proc(proc):
    """Called once at startup to inject the OutputCaptureProcessor so the
    compaction hook can clear its per-session context-low warning flag."""
    global _capture_proc
    _capture_proc = proc


async def _maybe_capture_native_id(commander_session_id: str, payload: dict):
    """Extract the CLI's native session_id from the hook payload and store it.

    Every hook event from Claude Code includes a 'session_id' field — the UUID
    that identifies the conversation file (e.g. abc123.jsonl). We capture this
    on first contact so sessions can be resumed with --resume later.
    This is far more reliable than the file-based detection which races against
    CLI startup timing.
    """
    if commander_session_id in _native_id_resolved:
        return

    native_sid = payload.get("session_id", "")
    if not native_sid or not isinstance(native_sid, str):
        return

    # Mark resolved immediately to prevent concurrent DB writes
    _native_id_resolved.add(commander_session_id)

    from db import get_db
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT native_session_id FROM sessions WHERE id = ?",
            (commander_session_id,),
        )
        row = await cur.fetchone()
        if not row:
            return
        existing = row["native_session_id"]
        if existing:
            return  # Already set (e.g. by file-based detection)

        await db.execute(
            "UPDATE sessions SET native_session_id = ? WHERE id = ?",
            (native_sid, commander_session_id),
        )
        await db.commit()
        logger.info(
            f"Captured native session ID from hook: {commander_session_id[:8]} → {native_sid[:12]}"
        )
    except Exception as e:
        # Non-fatal — file-based detection is still a fallback
        _native_id_resolved.discard(commander_session_id)
        logger.warning(f"Failed to capture native session ID: {e}")
    finally:
        await db.close()


def _get_state(session_id: str) -> dict:
    if session_id not in _hook_sessions:
        _hook_sessions[session_id] = {
            "state": "idle",
            "last_idle_at": 0.0,
            "tool_stack": [],
            "subagents": {},
        }
    s = _hook_sessions[session_id]
    if "subagents" not in s:
        s["subagents"] = {}
    return s


def cleanup_session(session_id: str):
    """Remove all hook state for a session. Called from handle_pty_exit."""
    _hook_sessions.pop(session_id, None)
    _pending_pty_warnings.pop(session_id, None)


def clear_native_id_cache(session_id: str):
    """Allow re-capture of native session ID.

    Called after /branch so the next hook event from the branch conversation
    can update the session's native_session_id to the branch's UUID.
    """
    _native_id_resolved.discard(session_id)


def get_subagents(session_id: str) -> list[dict]:
    """Return the list of tracked sub-agents for a session."""
    s = _hook_sessions.get(session_id)
    if not s or not s.get("subagents"):
        return []
    return list(s["subagents"].values())


def _get_recent_output(session_id: str, lines: int = 10) -> str:
    """Grab recent clean terminal output for notification context."""
    if _capture_proc is None:
        return ""
    try:
        return _capture_proc.get_buffer(session_id, lines=lines).strip()
    except Exception:
        return ""


def _summarize_tool_input(tool_name: str, tool_input: dict) -> str:
    """Extract a one-line summary from tool input for display."""
    if not tool_input:
        return ""
    tn = tool_name.lower()
    if tn in ("bash", "execute"):
        cmd = tool_input.get("command", "")
        return cmd[:120] if cmd else ""
    if tn in ("read", "read_file"):
        fp = tool_input.get("file_path", "")
        offset = tool_input.get("offset")
        limit = tool_input.get("limit")
        suffix = ""
        if offset or limit:
            suffix = f" L{offset or 1}"
            if limit:
                suffix += f"-{(offset or 1) + limit}"
        return (fp + suffix) if fp else ""
    if tn in ("write", "write_file"):
        return tool_input.get("file_path", "")
    if tn in ("edit", "edit_file"):
        return tool_input.get("file_path", "")
    if tn in ("glob", "find_files"):
        pattern = tool_input.get("pattern", "")
        path = tool_input.get("path", "")
        return f"{pattern}" + (f" in {path}" if path else "")
    if tn in ("grep", "search"):
        pattern = tool_input.get("pattern", "")
        path = tool_input.get("path", "")
        return f"/{pattern}/" + (f" in {path}" if path else "")
    if tn == "agent":
        desc = tool_input.get("description", "")
        atype = tool_input.get("subagent_type", "")
        return f"{atype}: {desc}" if atype else desc
    if tn in ("webfetch", "web_fetch"):
        return tool_input.get("url", "")
    if tn in ("websearch", "web_search"):
        return tool_input.get("query", "")
    # Generic: try common keys
    for key in ("file_path", "path", "command", "pattern", "query", "prompt", "description"):
        if key in tool_input:
            val = str(tool_input[key])
            return val[:120] if val else ""
    return ""


# ─── Event handlers ──────────────────────────────────────────────────

async def _handle_stop(session_id: str, payload: dict):
    """Claude finished responding — definitive 'idle' signal."""
    s = _get_state(session_id)
    s["state"] = "idle"
    s["tool_stack"].clear()

    # Always broadcast prompt_state idle
    await _broadcast({"type": "prompt_state", "session_id": session_id, "state": "idle"})
    await _broadcast({"type": "session_state", "session_id": session_id, "state": "idle", "source": "hook"})

    # Throttled session_idle for oversight nudge
    now = time.monotonic()
    if now - s["last_idle_at"] >= _IDLE_THROTTLE_INTERVAL:
        s["last_idle_at"] = now
        await _broadcast({"type": "session_idle", "session_id": session_id})

    # Permission question detection — check if the session stopped because
    # it asked "Want me to implement this?" instead of just doing it.
    try:
        if _capture_proc is not None:
            matched = _capture_proc.check_permission_question(session_id)
            if matched:
                logger.info(
                    "Permission question detected in session %s: %s",
                    session_id[:8], matched[:80],
                )
                await _broadcast({
                    "type": "permission_question",
                    "session_id": session_id,
                    "question": matched,
                    "context": _get_recent_output(session_id, lines=8),
                })
    except Exception as e:
        logger.debug("Permission question check failed: %s", e)

    # Server-side cascade advancement
    try:
        from cascade_runner import on_session_idle
        await on_session_idle(session_id)
    except Exception as e:
        logger.debug("Cascade runner idle check failed: %s", e)

    # Worker queue: auto-deliver queued tasks
    try:
        from worker_queue import on_session_idle as wq_on_session_idle
        await wq_on_session_idle(session_id)
    except Exception as e:
        logger.debug("Worker queue idle check failed: %s", e)

    # Pipeline engine: advance configurable pipelines
    try:
        from pipeline_engine import on_session_idle as pe_on_session_idle
        await pe_on_session_idle(session_id)
    except Exception as e:
        logger.debug("Pipeline engine idle check failed: %s", e)

    # W2W: Deliver pending PTY warnings (peer conflicts, file overlaps)
    # queued during PostToolUse, delivered now when the agent is idle.
    try:
        await _deliver_pending_warnings(session_id)
    except Exception as e:
        logger.debug("Pending warning delivery failed: %s", e)


def _extract_options(payload: dict) -> list[dict]:
    """Extract structured options/choices from a hook payload.

    The CLI may send options under various keys depending on the
    notification type.  Returns a list of ``{num, text}`` dicts suitable
    for the frontend toast, or an empty list if nothing found.
    """
    for key in ("options", "choices", "items"):
        raw = payload.get(key)
        if isinstance(raw, list) and raw:
            out = []
            for i, item in enumerate(raw, 1):
                if isinstance(item, dict):
                    text = item.get("label") or item.get("text") or item.get("name") or item.get("title") or item.get("value") or str(item)
                elif isinstance(item, str):
                    text = item
                else:
                    continue
                num = item.get("index", i) if isinstance(item, dict) else i
                out.append({"num": num, "text": str(text)})
            if out:
                return out

    # Elicitation schema with enum values
    schema = payload.get("schema")
    if isinstance(schema, dict):
        enum = schema.get("enum")
        if isinstance(enum, list) and enum:
            return [{"num": i, "text": str(v)} for i, v in enumerate(enum, 1)]

    return []


def _extract_actions(payload: dict, notification_type: str, has_options: bool) -> list[dict]:
    """Extract keyboard actions from hook payload with sensible defaults.

    Returns a list of ``{label, key, style}`` dicts.  ``key`` is a
    logical name (enter, escape, tab, ctrl-e, …) that the frontend maps
    to the actual terminal sequence.
    """
    # Check for structured action data from the CLI
    for key in ("actions", "keys", "shortcuts", "key_bindings"):
        raw = payload.get(key)
        if isinstance(raw, list) and raw:
            return [
                {
                    "label": a.get("label", a.get("key", "")),
                    "key": a.get("key", ""),
                    "style": a.get("style", "default"),
                }
                for a in raw
                if isinstance(a, dict)
            ]

    # Sensible defaults by notification type
    if notification_type == "permission_prompt":
        return [
            {"label": "Allow", "key": "enter", "style": "primary"},
            {"label": "Reject", "key": "escape", "style": "danger"},
        ]

    if has_options:
        # Options handle selection — just offer cancel
        return [
            {"label": "Cancel", "key": "escape", "style": "default"},
        ]

    # Generic: confirm + cancel
    return [
        {"label": "Confirm", "key": "enter", "style": "primary"},
        {"label": "Cancel", "key": "escape", "style": "default"},
    ]


async def _handle_notification(session_id: str, payload: dict):
    """Notification from CLI — permission prompt, idle prompt, etc.

    All non-idle notifications are normalized to a generic structure:
    message + options + actions, broadcast as session_state/prompting.
    """
    ntype = payload.get("notification_type", "")

    # Log payload keys for debugging (full payload at DEBUG)
    _skip_keys = {"hook_event_name", "session_id"}
    debug_payload = {k: v for k, v in payload.items() if k not in _skip_keys}
    logger.info(f"Notification({ntype}) session={session_id[:8]} keys={list(debug_payload.keys())}")
    logger.debug(f"Notification({ntype}) payload: {debug_payload}")

    # ── idle_prompt: only case that transitions to idle ──
    if ntype == "idle_prompt":
        s = _get_state(session_id)
        s["state"] = "idle"
        s["tool_stack"].clear()
        await _broadcast({"type": "prompt_state", "session_id": session_id, "state": "idle"})
        await _broadcast({"type": "session_state", "session_id": session_id, "state": "idle", "source": "hook"})
        now = time.monotonic()
        if now - s["last_idle_at"] >= _IDLE_THROTTLE_INTERVAL:
            s["last_idle_at"] = now
            await _broadcast({"type": "session_idle", "session_id": session_id})
        # Server-side cascade advancement
        try:
            from cascade_runner import on_session_idle
            await on_session_idle(session_id)
        except Exception as e:
            logger.debug("Cascade runner idle check failed: %s", e)
        # Worker queue: auto-deliver queued tasks
        try:
            from worker_queue import on_session_idle as wq_on_session_idle
            await wq_on_session_idle(session_id)
        except Exception as e:
            logger.debug("Worker queue idle check failed: %s", e)
        return

    # ── Everything else: generic prompting ──
    s = _get_state(session_id)
    s["state"] = "prompting"

    tool_name = payload.get("tool_name", "")
    message = payload.get("message", "") or payload.get("title", "")
    options = _extract_options(payload)
    actions = _extract_actions(payload, ntype, bool(options))

    await _broadcast({
        "type": "prompt_state",
        "session_id": session_id,
        "state": "select",
        "question": tool_name or message or "Input needed",
        "options": options,
    })
    await _broadcast({
        "type": "session_state",
        "session_id": session_id,
        "state": "prompting",
        "notification_type": ntype,
        "tool_name": tool_name,
        "message": message,
        "options": options,
        "actions": actions,
        "context": _get_recent_output(session_id),
        "source": "hook",
    })


async def _handle_pre_tool_use(session_id: str, payload: dict):
    """Tool about to execute — session is working."""
    s = _get_state(session_id)
    s["state"] = "working"
    tool_name = payload.get("tool_name", "unknown")
    s["tool_stack"].append(tool_name)

    agent_id = payload.get("agent_id")
    agent_type = payload.get("agent_type")

    await _broadcast({
        "type": "session_state",
        "session_id": session_id,
        "state": "working",
        "tool_name": tool_name,
        "source": "hook",
    })

    tool_event = {
        "type": "tool_event",
        "session_id": session_id,
        "action": "start",
        "tool_name": tool_name,
        "tool_input": payload.get("tool_input", {}),
    }
    if agent_id:
        tool_event["agent_id"] = agent_id
        tool_event["agent_type"] = agent_type
        # Track tool call on the subagent
        if agent_id in s["subagents"]:
            tool_input = payload.get("tool_input", {})
            # Extract a concise summary from the input for display
            input_summary = _summarize_tool_input(tool_name, tool_input)
            s["subagents"][agent_id]["tools"].append({
                "tool": tool_name,
                "action": "start",
                "tool_use_id": payload.get("tool_use_id"),
                "input_summary": input_summary,
                "input": tool_input,
            })
    await _broadcast(tool_event)

    # Memory sync: if a Write/Edit targets a memory file, schedule sync.
    # PreToolUse fires before the write but debounce delay (~3s) ensures
    # the file is written by the time we actually read it.
    if tool_name in ("Write", "Edit", "write_file", "edit_file"):
        file_path = payload.get("tool_input", {}).get("file_path", "")
        if file_path:
            try:
                from memory_sync import is_memory_path, on_memory_file_changed
                if is_memory_path(file_path):
                    import asyncio as _aio
                    _aio.create_task(on_memory_file_changed(session_id, file_path))
            except Exception as exc:
                logger.debug("Memory sync check failed: %s", exc)


async def _handle_post_tool_use(session_id: str, payload: dict):
    """Tool finished executing."""
    s = _get_state(session_id)
    tool_name = payload.get("tool_name", "unknown")
    if s["tool_stack"]:
        s["tool_stack"].pop()

    agent_id = payload.get("agent_id")
    agent_type = payload.get("agent_type")

    tool_event = {
        "type": "tool_event",
        "session_id": session_id,
        "action": "complete",
        "tool_name": tool_name,
    }
    if agent_id:
        tool_event["agent_id"] = agent_id
        tool_event["agent_type"] = agent_type
    await _broadcast(tool_event)

    # Safety Gate: correlate PostToolUse with pending safety decisions.
    # If PostToolUse fires, the user approved the tool execution.
    tool_use_id = payload.get("tool_use_id")
    if tool_use_id:
        try:
            from safety_learning import record_user_response
            from db import get_db as _get_db
            _db = await _get_db()
            try:
                await record_user_response(_db, tool_use_id, "approved")
            finally:
                await _db.close()
        except Exception:
            pass  # safety learning not critical

    # Session Advisor: feed tool signals to intent accumulator
    try:
        from session_advisor import update_intent
        tool_input = payload.get("tool_input") or {}
        signal = None
        if tool_name in ("Write", "Edit", "MultiEdit", "NotebookEdit",
                          "write_file", "edit_file", "create_file"):
            fp = tool_input.get("file_path", "")
            if fp:
                # Extract directory-level signal (not full path, too noisy)
                import os
                signal = f"editing {os.path.dirname(fp)}/"
        elif tool_name in ("Read", "Glob", "Grep", "read_file"):
            fp = tool_input.get("file_path") or tool_input.get("path", "")
            if fp:
                import os
                signal = f"reading {os.path.dirname(fp)}/"
        elif tool_name in ("Bash", "bash", "execute_command"):
            cmd = tool_input.get("command", "")
            if "test" in cmd.lower() or "jest" in cmd.lower() or "pytest" in cmd.lower():
                signal = "running tests"
            elif "build" in cmd.lower() or "compile" in cmd.lower():
                signal = "building project"
        if signal:
            ws_id = None
            from server import _session_workspace
            ws_id = _session_workspace.get(session_id)
            import asyncio
            asyncio.create_task(update_intent(session_id, signal, source="tool", workspace_id=ws_id))
    except Exception:
        pass  # advisor not critical

    # W2W: Auto-track files_touched in session digest + file activity log
    if tool_name in ("Write", "Edit", "MultiEdit", "NotebookEdit",
                      "write_file", "edit_file", "create_file"):
        file_path = (payload.get("tool_input") or {}).get("file_path", "")
        if file_path:
            try:
                await _w2w_track_file_touched(session_id, file_path)
                await _w2w_record_file_activity(session_id, file_path, tool_name)
            except Exception:
                pass  # never let W2W tracking affect the session
            # Check for relevant peer messages about this file
            try:
                await _w2w_check_peer_warnings(session_id, file_path)
            except Exception as _pw_err:
                logger.warning("Peer warning check failed: %s", _pw_err)
            # Check for file-level conflicts with other active sessions
            try:
                await _w2w_check_file_conflict(session_id, file_path)
            except Exception:
                pass  # never let conflict detection affect the session


# ── W2W: PTY warning queue + delivery ──────────────────────────────────

def _queue_pty_warning(session_id: str, message: str, priority: str = "info", source: str = "w2w"):
    """Queue a warning for delivery to the agent's PTY at next idle."""
    warnings = _pending_pty_warnings.setdefault(session_id, [])
    # Dedup: skip if an identical message is already queued
    if any(w["message"] == message for w in warnings):
        return
    warnings.append({"message": message, "priority": priority, "source": source})


async def _deliver_pending_warnings(session_id: str):
    """Deliver queued PTY warnings to the agent. Called from _handle_stop (idle)."""
    warnings = _pending_pty_warnings.get(session_id, [])
    if not warnings or not _pty_mgr or not _pty_mgr.is_alive(session_id):
        return  # Keep queue intact if PTY is dead — retry on next Stop

    # Pop only after confirming delivery is possible
    _pending_pty_warnings.pop(session_id, None)

    import asyncio
    lines = []
    for w in warnings:
        icon = "\u26d4" if w["priority"] == "blocking" else "\u26a0\ufe0f"
        lines.append(f"{icon} [W2W] {w['message']}")

    # Build a concise prompt the agent will see as user input
    prompt = "\n".join(lines)
    if len(warnings) > 1:
        prompt += "\n\nPlease acknowledge these warnings and adjust your approach if needed."

    msg_bytes = prompt.encode("utf-8")
    _pty_mgr.write(session_id, b"\x1b" + b"\x7f" * 20)
    await asyncio.sleep(0.15)
    _pty_mgr.write(session_id, msg_bytes)
    await asyncio.sleep(0.4)
    _pty_mgr.write(session_id, b"\r")

    logger.info("Delivered %d W2W warning(s) to session %s", len(warnings), session_id[:8])


async def _w2w_check_file_conflict(session_id: str, file_path: str):
    """Check if another ACTIVE session has recently edited the same file.

    Unlike peer message warnings (which require explicit posting), this
    detects implicit conflicts from file_activity records. When two agents
    edit the same file within a short window, one gets a warning.
    """
    if not await _get_w2w_enabled(session_id):
        return

    from db import get_db
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT workspace_id FROM sessions WHERE id = ?", (session_id,))
        row = await cur.fetchone()
        if not row:
            return
        ws_id = row["workspace_id"]

        # Find other active sessions that touched this file in the last 10 min
        cur = await db.execute(
            """SELECT DISTINCT fa.session_id, fa.session_name, fa.task_summary, fa.task_title
               FROM file_activity fa
               JOIN sessions s ON fa.session_id = s.id
               WHERE fa.workspace_id = ?
                 AND fa.file_path = ?
                 AND fa.session_id != ?
                 AND fa.created_at > datetime('now', '-10 minutes')
                 AND s.status IN ('running', 'idle')
               ORDER BY fa.created_at DESC LIMIT 3""",
            (ws_id, file_path, session_id),
        )
        conflicts = await cur.fetchall()
        if not conflicts:
            return

        # Build warning
        names = []
        for c in conflicts:
            name = c["session_name"] or c["session_id"][:8]
            task = c["task_title"] or c["task_summary"] or ""
            names.append(f"{name}" + (f" ({task[:40]})" if task else ""))

        file_short = file_path.split("/")[-1] if "/" in file_path else file_path
        warning = f"File conflict: {file_short} was recently edited by {', '.join(names)}. Coordinate to avoid overwriting their changes."

        # Broadcast to UI
        await _broadcast({
            "type": "file_conflict",
            "session_id": session_id,
            "file_path": file_path,
            "conflicting_sessions": [dict(c) for c in conflicts],
            "message": warning,
        })

        # Queue for PTY delivery at next idle
        _queue_pty_warning(session_id, warning, priority="heads_up", source="file_conflict")

    finally:
        await db.close()


async def _w2w_track_file_touched(session_id: str, file_path: str):
    """Append a file path to the session's digest files_touched (if context_sharing is on)."""
    if not await _get_w2w_enabled(session_id):
        return

    from db import get_db
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT files_touched FROM session_digests WHERE session_id = ?",
            (session_id,),
        )
        drow = await cur.fetchone()
        if drow:
            files = json.loads(drow["files_touched"] or "[]")
            if file_path not in files:
                files.append(file_path)
                await db.execute(
                    "UPDATE session_digests SET files_touched = ?, updated_at = datetime('now') WHERE session_id = ?",
                    (json.dumps(files), session_id),
                )
                await db.commit()
        else:
            # Auto-create digest with this file
            import uuid as _uuid
            scur = await db.execute("SELECT workspace_id FROM sessions WHERE id = ?", (session_id,))
            srow = await scur.fetchone()
            ws_id = srow["workspace_id"] if srow else None
            await db.execute(
                """INSERT OR IGNORE INTO session_digests (id, session_id, workspace_id, files_touched)
                   VALUES (?, ?, ?, ?)""",
                (str(_uuid.uuid4()), session_id, ws_id, json.dumps([file_path])),
            )
            await db.commit()
    finally:
        await db.close()


async def _w2w_record_file_activity(session_id: str, file_path: str, tool_name: str):
    """Record a file edit in the activity log with the worker's current task context.

    This is the 'context follows the file' mechanism — when another worker
    encounters this file, they see who was here and what goal they were pursuing.
    Task context is resolved from two sources (best available):
      1. Session digest (task_summary) — the worker's self-reported goal
      2. Task board (task title) — the formally assigned task
    """
    if not await _get_w2w_enabled(session_id):
        return

    from db import get_db
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT workspace_id, name, task_id FROM sessions WHERE id = ?",
            (session_id,),
        )
        row = await cur.fetchone()
        if not row:
            return

        workspace_id = row["workspace_id"]
        session_name = row["name"] or session_id[:8]

        # Resolve task context from digest
        task_summary = ""
        dcur = await db.execute(
            "SELECT task_summary FROM session_digests WHERE session_id = ?",
            (session_id,),
        )
        drow = await dcur.fetchone()
        if drow and drow["task_summary"]:
            task_summary = drow["task_summary"]

        # Resolve task title from task board (if assigned)
        task_title = ""
        if row["task_id"]:
            tcur = await db.execute(
                "SELECT title FROM tasks WHERE id = ?", (row["task_id"],)
            )
            trow = await tcur.fetchone()
            if trow:
                task_title = trow["title"]

        await db.execute(
            """INSERT INTO file_activity
               (workspace_id, file_path, session_id, session_name, task_summary, task_title, tool_name)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (workspace_id, file_path, session_id, session_name,
             task_summary, task_title, tool_name),
        )
        await db.commit()
    finally:
        await db.close()


async def _w2w_check_peer_warnings(session_id: str, file_path: str):
    """Check if any unread peer messages reference this file path.

    When a worker edits a file that another worker warned about in a
    peer message, deliver that warning via WebSocket so the worker (and
    the human watching) sees it immediately — not when they remember
    to call check_messages().

    Only checks blocking and heads_up priority messages.
    """
    if not await _get_w2w_enabled(session_id, flag="comms"):
        return

    from db import get_db
    import json as _json

    db = await get_db()
    try:
        # Get workspace for this session
        cur = await db.execute(
            "SELECT workspace_id FROM sessions WHERE id = ?", (session_id,))
        row = await cur.fetchone()
        if not row:
            return
        ws_id = row["workspace_id"]

        # Find unread peer messages that reference this file
        cur = await db.execute(
            """SELECT id, from_session_id, topic, content, priority, files, read_by
               FROM peer_messages
               WHERE workspace_id = ?
                 AND from_session_id != ?
                 AND priority IN ('blocking', 'heads_up')
               ORDER BY created_at DESC LIMIT 20""",
            (ws_id, session_id),
        )
        msgs = await cur.fetchall()

        for msg in msgs:
            read_by = msg["read_by"] or "[]"
            try:
                read_list = _json.loads(read_by) if isinstance(read_by, str) else (read_by or [])
            except Exception:
                read_list = []
            if session_id in read_list:
                continue

            # Check if the file matches any files in the message
            msg_files = msg["files"] or "[]"
            try:
                file_list = _json.loads(msg_files) if isinstance(msg_files, str) else (msg_files or [])
            except Exception:
                file_list = []

            # Match: exact path or file_path ends with a listed path
            matched = False
            for mf in file_list:
                if mf and (file_path == mf or file_path.endswith(mf) or mf.endswith(file_path.split("/")[-1])):
                    matched = True
                    break

            if not matched:
                continue

            # Deliver the warning via WebSocket
            # Get sender name
            scur = await db.execute(
                "SELECT name FROM sessions WHERE id = ?", (msg["from_session_id"],))
            srow = await scur.fetchone()
            sender = srow["name"] if srow else msg["from_session_id"][:8]

            priority_icon = "\u26d4" if msg["priority"] == "blocking" else "\u26a0\ufe0f"
            warning_text = f"Peer warning from {sender}: {msg['content'][:200]}"

            await _broadcast({
                "type": "peer_warning",
                "session_id": session_id,
                "from_session": sender,
                "priority": msg["priority"],
                "topic": msg["topic"],
                "content": msg["content"],
                "matched_file": file_path,
                "message": f"{priority_icon} {warning_text}",
            })

            # Queue for PTY delivery so the AGENT sees it too, not just the UI
            _queue_pty_warning(session_id, warning_text,
                               priority=msg["priority"], source="peer_warning")

            # Auto-mark as read for this session
            read_list.append(session_id)
            await db.execute(
                "UPDATE peer_messages SET read_by = ? WHERE id = ?",
                (_json.dumps(read_list), msg["id"]),
            )
            await db.commit()

            logger.info("Peer warning delivered: %s → %s (file: %s)",
                        sender, session_id[:8], file_path)
            break  # One warning per file edit is enough
    finally:
        await db.close()


async def _handle_subagent(session_id: str, payload: dict, action: str):
    """Subagent started or stopped — track lifecycle and broadcast rich events."""
    s = _get_state(session_id)
    agent_id = payload.get("agent_id", "")
    agent_type = payload.get("agent_type", "unknown")

    if action == "start" and agent_id:
        s["subagents"][agent_id] = {
            "id": agent_id,
            "type": agent_type,
            "status": "running",
            "started_at": time.time(),
            "tools": [],
            "result": None,
        }
        await _broadcast({
            "type": "subagent_event",
            "session_id": session_id,
            "action": "start",
            "agent_id": agent_id,
            "agent_type": agent_type,
        })

    elif action == "stop" and agent_id:
        result = payload.get("last_assistant_message", "")
        transcript_path = payload.get("agent_transcript_path", "")
        agent = s["subagents"].get(agent_id)
        if agent:
            agent["status"] = "completed"
            agent["result"] = result[:5000] if result else None  # Keep more for viewer
            agent["transcript_path"] = transcript_path or None
        await _broadcast({
            "type": "subagent_event",
            "session_id": session_id,
            "action": "stop",
            "agent_id": agent_id,
            "agent_type": agent_type,
            "result_preview": (result[:200] + "...") if result and len(result) > 200 else result,
            "transcript_path": transcript_path,
        })

    else:
        # Fallback for missing agent_id — still broadcast
        await _broadcast({
            "type": "subagent_event",
            "session_id": session_id,
            "action": action,
        })


async def _handle_session_end(session_id: str, payload: dict):
    """Session ended — cleanup."""
    cleanup_session(session_id)


async def _handle_file_changed(session_id: str, payload: dict):
    """File changed on disk — Claude fires this natively.

    If the changed file is a memory file (CLAUDE.md, GEMINI.md, or
    auto-memory), trigger a debounced sync so the central store and all
    other CLI providers stay in sync.
    """
    file_path = payload.get("file_path", "") or payload.get("path", "")
    if not file_path:
        return
    try:
        from memory_sync import is_memory_path, on_memory_file_changed
        if is_memory_path(file_path):
            import asyncio as _aio
            _aio.create_task(on_memory_file_changed(session_id, file_path))
    except Exception as exc:
        logger.debug("Memory file change handler failed: %s", exc)


async def _handle_compaction(session_id: str, payload: dict):
    """
    Context compaction event from Claude (PreCompact/PostCompact) or
    Gemini (PreCompress/PostCompress). Replaces the brittle regex-based
    detection in output_capture.py — hooks give a definitive signal so
    we no longer false-positive on the word "compact" appearing in
    Claude Code's own status bar.

    User-initiated (`/compact`) is filtered out — the user already knows.
    """
    event = payload.get("hook_event_name", "")
    if event in ("PreCompact", "PreCompress"):
        phase = "pre"
    elif event in ("PostCompact", "PostCompress"):
        phase = "post"
    else:
        phase = "pre"

    # Claude uses `compaction_trigger`, Gemini uses `trigger`
    trigger = payload.get("compaction_trigger") or payload.get("trigger") or "auto"

    if trigger == "manual":
        return  # User already knows — no need to surface

    # Re-arm the regex-based context-low warning so the next time context
    # fills up after this compaction we get a fresh warning.
    if phase == "post" and _capture_proc is not None:
        try:
            _capture_proc.clear_context_warned(session_id)
        except Exception as e:
            logger.error(f"Failed to clear context-warned flag: {e}")

    await _broadcast({
        "type": "compaction",
        "session_id": session_id,
        "phase": phase,
        "trigger": trigger,
    })


# ─── Worktree / branch lifecycle ─────────────────────────────────────


def _generate_branch_label(branch_group: str, existing_labels: set) -> str:
    """Generate a short letter+digit label (e.g. 'k3') from a branch group UUID."""
    import hashlib
    h = hashlib.md5(branch_group.encode()).digest()
    for i in range(0, len(h) - 1, 2):
        letter = chr(ord('a') + h[i] % 26)
        digit = str(h[i + 1] % 10)
        candidate = letter + digit
        if candidate not in existing_labels:
            return candidate
    for c in 'abcdefghijklmnopqrstuvwxyz':
        for d in '0123456789':
            if c + d not in existing_labels:
                return c + d
    return 'z0'


async def _handle_worktree_create(session_id: str, payload: dict):
    """Branch/worktree created (e.g. /branch command).

    Creates a sibling Commander session for the branched conversation so it
    opens as a new tab in the UI.  Inherits model, guidelines, and MCP servers
    from the parent session.
    """
    import uuid as _uuid
    from db import get_db

    db = await get_db()
    try:
        # ── Look up parent session ──────────────────────────────────────
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        parent = await cur.fetchone()
        if not parent:
            logger.warning("WorktreeCreate: parent session %s not found", session_id[:8])
            return
        parent = dict(parent)

        # ── Extract branch info from payload (resilient to unknown schema) ─
        worktree_path = (payload.get("worktree_path")
                         or payload.get("path")
                         or "")
        branch_name = (payload.get("branch_name")
                       or payload.get("branch")
                       or "")
        # The branch conversation's native session ID (enables --resume)
        branch_native_id = (payload.get("new_session_id")
                            or payload.get("branch_session_id")
                            or "")

        # ── Guard against duplicates ────────────────────────────────────
        if branch_native_id:
            cur = await db.execute(
                "SELECT id FROM sessions WHERE parent_session_id = ? AND native_session_id = ?",
                (session_id, branch_native_id),
            )
            if await cur.fetchone():
                logger.debug("WorktreeCreate: branch session already exists, skipping")
                return

        # ── Create new Commander session ────────────────────────────────
        new_id = str(_uuid.uuid4())
        name = (f"Branch: {branch_name}" if branch_name
                else f"{parent['name']} (branch)")

        # ── Resolve branch group (peer linkage, not hierarchy) ─────────
        if parent.get("branch_group"):
            # Branch of a branch — reuse existing group + label
            branch_group = parent["branch_group"]
            branch_label = parent.get("branch_label", "")
        else:
            # First branch — create new group, generate label, tag parent
            branch_group = str(_uuid.uuid4())
            cur = await db.execute(
                "SELECT DISTINCT branch_label FROM sessions WHERE workspace_id = ? AND branch_label IS NOT NULL",
                (parent["workspace_id"],),
            )
            existing = {row["branch_label"] for row in await cur.fetchall()}
            branch_label = _generate_branch_label(branch_group, existing)
            # Tag the parent so it shows the same label
            await db.execute(
                "UPDATE sessions SET branch_group = ?, branch_label = ? WHERE id = ?",
                (branch_group, branch_label, session_id),
            )

        await db.execute(
            """INSERT INTO sessions
               (id, workspace_id, name, model, permission_mode, effort,
                budget_usd, system_prompt, allowed_tools, disallowed_tools,
                add_dirs, cli_type, worktree, parent_session_id,
                native_session_id, worktree_path,
                branch_group, branch_label)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)""",
            (new_id, parent["workspace_id"], name, parent["model"],
             parent["permission_mode"], parent["effort"],
             parent.get("budget_usd"), parent.get("system_prompt"),
             parent.get("allowed_tools"), parent.get("disallowed_tools"),
             parent.get("add_dirs"), parent.get("cli_type", "claude"),
             session_id, branch_native_id or None, worktree_path or None,
             branch_group, branch_label),
        )

        # ── Copy guidelines from parent ─────────────────────────────────
        cur = await db.execute(
            "SELECT guideline_id FROM session_guidelines WHERE session_id = ?",
            (session_id,),
        )
        for row in await cur.fetchall():
            await db.execute(
                "INSERT OR IGNORE INTO session_guidelines (session_id, guideline_id) VALUES (?, ?)",
                (new_id, row["guideline_id"]),
            )

        # ── Copy MCP servers from parent ────────────────────────────────
        cur = await db.execute(
            "SELECT mcp_server_id, auto_approve_override FROM session_mcp_servers WHERE session_id = ?",
            (session_id,),
        )
        for row in await cur.fetchall():
            await db.execute(
                "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, ?)",
                (new_id, row["mcp_server_id"], row["auto_approve_override"]),
            )

        await db.commit()

        # ── Fetch complete session row and broadcast ────────────────────
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (new_id,))
        new_session = dict(await cur.fetchone())

        # Re-fetch parent so frontend gets updated branch_group/label
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        updated_parent = dict(await cur.fetchone())

        await _broadcast({
            "type": "session_created",
            "session": new_session,
            "auto_open": True,
            "parent_session_id": session_id,
            "updated_parent": updated_parent,
        })

        logger.info(
            "Branch session %s created from parent %s (branch=%s)",
            new_id[:8], session_id[:8], branch_name or "unnamed",
        )
    except Exception as e:
        logger.exception("WorktreeCreate handler failed: %s", e)
    finally:
        await db.close()


async def _handle_worktree_remove(session_id: str, payload: dict):
    """Worktree removed — mark any branch sessions as exited."""
    from db import get_db

    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT id FROM sessions WHERE parent_session_id = ? AND worktree = 1",
            (session_id,),
        )
        for row in await cur.fetchall():
            branch_id = row["id"]
            await db.execute(
                "UPDATE sessions SET status = 'exited' WHERE id = ?",
                (branch_id,),
            )
            await _broadcast({
                "type": "status",
                "session_id": branch_id,
                "status": "exited",
            })
        await db.commit()
    except Exception as e:
        logger.exception("WorktreeRemove handler failed: %s", e)
    finally:
        await db.close()


# ─── Event routing ───────────────────────────────────────────────────

# Build _EVENT_HANDLERS dynamically from profiles instead of hardcoding
# both Claude and Gemini native names.  Each canonical HookEvent is mapped
# to a handler, and we expand all native names from all registered profiles.

from cli_features import HookEvent
from cli_profiles import PROFILES

_CANONICAL_HANDLERS = {
    HookEvent.TURN_COMPLETE:  _handle_stop,
    HookEvent.NOTIFICATION:   _handle_notification,
    HookEvent.PRE_TOOL:       _handle_pre_tool_use,
    HookEvent.POST_TOOL:      _handle_post_tool_use,
    HookEvent.SESSION_STOP:   _handle_session_end,
    HookEvent.FILE_CHANGED:   _handle_file_changed,
    HookEvent.PRE_COMPACT:    _handle_compaction,
    HookEvent.POST_COMPACT:   _handle_compaction,
    HookEvent.WORKTREE_CREATE: _handle_worktree_create,
    HookEvent.WORKTREE_REMOVE: _handle_worktree_remove,
}

_EVENT_HANDLERS: dict[str, object] = {}
for _profile in PROFILES.values():
    for _canonical, _handler in _CANONICAL_HANDLERS.items():
        _native = _profile.native_hook(_canonical)
        if _native and _native not in _EVENT_HANDLERS:
            _EVENT_HANDLERS[_native] = _handler


async def handle_hook_event(request: web.Request) -> web.Response:
    """
    POST /api/hooks/event

    Receives structured lifecycle events from Claude Code / Gemini CLI hooks.
    The hook relay script (~/.ive/hooks/hook.sh) POSTs the raw
    JSON from the CLI's stdin, with the Commander session ID in a header.
    """
    session_id = request.headers.get("X-Commander-Session-Id", "").strip()
    if not session_id:
        return web.json_response({})  # Non-Commander session — ignore silently

    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)

    event_name = payload.get("hook_event_name", "")

    # Capture the CLI's native session ID on first hook contact.
    # This is the most reliable way to learn the conversation UUID for --resume.
    try:
        await _maybe_capture_native_id(session_id, payload)
    except Exception:
        pass  # Non-fatal — never block hook processing

    # SubagentStart/SubagentStop use a shared handler with action param
    if event_name == "SubagentStart":
        await _handle_subagent(session_id, payload, "start")
        return web.json_response({})
    if event_name == "SubagentStop":
        await _handle_subagent(session_id, payload, "stop")
        return web.json_response({})

    handler = _EVENT_HANDLERS.get(event_name)
    if handler:
        try:
            await handler(session_id, payload)
        except Exception as e:
            logger.exception(f"Hook handler error for {event_name}: {e}")
    else:
        logger.debug(f"Unhandled hook event: {event_name} for session {session_id[:8]}")

    # Dispatch to plugin hook scripts attached to this session
    try:
        await _dispatch_plugin_hooks(session_id, event_name, payload)
    except Exception as e:
        logger.warning(f"Plugin hook dispatch error: {e}")

    return web.json_response({})


# ─── Plugin hook dispatch ────────────────────────────────────────────

async def _dispatch_plugin_hooks(session_id: str, event_name: str, payload: dict):
    """Execute plugin script components that match this event.

    When a hook event arrives, we look up script components attached to
    this session whose trigger matches the event. The canonical event name
    is checked against both the raw native event name and its canonical
    equivalent so scripts using either naming convention are matched.
    """
    from db import get_db
    import asyncio
    import subprocess

    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            """SELECT pc.content, pc.trigger, pc.name, p.name as plugin_name
               FROM plugin_components pc
               JOIN session_plugin_components spc ON pc.id = spc.component_id
               JOIN plugins p ON pc.plugin_id = p.id
               WHERE spc.session_id = ? AND pc.type = 'script'""",
            (session_id,),
        )
    finally:
        await db.close()

    if not rows:
        return

    for row in rows:
        trigger = row["trigger"] or ""
        if not trigger:
            continue

        # Match: trigger can be the canonical event name or the native name
        if not _trigger_matches_event(trigger, event_name):
            continue

        script_content = row["content"] or ""
        if not script_content:
            continue

        plugin_name = row["plugin_name"] or "unknown"
        script_name = row["name"] or "unknown"

        try:
            logger.info(
                "Dispatching plugin hook: %s/%s on %s for session %s",
                plugin_name, script_name, event_name, session_id[:8],
            )
            # Execute the script with payload on stdin, non-blocking
            proc = await asyncio.create_subprocess_exec(
                "/bin/bash", "-c", script_content,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={
                    **__import__("os").environ,
                    "COMMANDER_SESSION_ID": session_id,
                    "HOOK_EVENT_NAME": event_name,
                },
            )
            payload_bytes = __import__("json").dumps(payload).encode()
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=payload_bytes),
                timeout=10.0,
            )
            if proc.returncode != 0:
                logger.warning(
                    "Plugin hook %s/%s exited %d: %s",
                    plugin_name, script_name, proc.returncode,
                    stderr.decode(errors="replace")[:200],
                )
        except asyncio.TimeoutError:
            logger.warning("Plugin hook %s/%s timed out", plugin_name, script_name)
        except Exception as e:
            logger.warning("Plugin hook %s/%s failed: %s", plugin_name, script_name, e)


def _trigger_matches_event(trigger: str, event_name: str) -> bool:
    """Check if a script's trigger matches the incoming event.

    Supports:
      - Exact match (canonical or native name)
      - Comma-separated list of events
      - Wildcard "*" (matches all events)
    """
    if trigger == "*":
        return True

    triggers = [t.strip() for t in trigger.split(",")]

    # Direct match
    if event_name in triggers:
        return True

    # Try canonical ↔ native translation
    try:
        for t in triggers:
            # Check if trigger is a canonical name matching via any profile
            try:
                canonical = HookEvent(t)
                for profile in PROFILES.values():
                    if profile.native_hook(canonical) == event_name:
                        return True
            except ValueError:
                pass

            # Check if trigger is a native name whose canonical matches
            for profile in PROFILES.values():
                canonical = profile.canonical_hook(t)
                if canonical:
                    for p2 in PROFILES.values():
                        if p2.native_hook(canonical) == event_name:
                            return True
    except ImportError:
        pass

    return False
