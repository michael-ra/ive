"""Worker queue: event-driven auto-delivery of queued tasks to workers.

When Commander queues a task for a specific worker (queued_for_session_id),
this module auto-delivers it when the worker finishes its current task.
Triggered by TASK_STATUS_CHANGED/TASK_COMPLETED events and session_idle hooks.

Follows the auto_exec.py pattern: register_subscribers() wires up handlers,
set_pty_manager()/set_broadcast_fn() inject dependencies at startup.
"""
from __future__ import annotations

import asyncio
import json
import logging

from commander_events import CommanderEvent
from event_bus import bus
from db import get_db

logger = logging.getLogger(__name__)

_pty_mgr = None
_broadcast_fn = None

# Per-session lock prevents concurrent delivery races
_delivery_locks: dict[str, asyncio.Lock] = {}


def set_pty_manager(mgr):
    global _pty_mgr
    _pty_mgr = mgr


def set_broadcast_fn(fn):
    global _broadcast_fn
    _broadcast_fn = fn


def _get_lock(session_id: str) -> asyncio.Lock:
    if session_id not in _delivery_locks:
        _delivery_locks[session_id] = asyncio.Lock()
    return _delivery_locks[session_id]


# ── Event handlers ───────────────────────────────────────────────────

async def _on_task_completed(event_name: str, payload: dict):
    """Task finished (done/review/verified) — check if worker has queued tasks."""
    new_status = payload.get("new_status", payload.get("status"))
    if new_status not in ("done", "review", "verified"):
        return

    # Find the worker that completed this task
    session_id = payload.get("assigned_session_id") or payload.get("session_id")
    if session_id:
        await _maybe_deliver(session_id)


async def on_session_idle(session_id: str):
    """Called from hooks.py when a worker goes idle. Check for queued tasks."""
    await _maybe_deliver(session_id)


# ── Core delivery logic ─────────────────────────────────────────────

async def _maybe_deliver(session_id: str):
    """Check if this worker has queued tasks and deliver the next one."""
    if not session_id:
        return

    lock = _get_lock(session_id)
    if lock.locked():
        return  # Another delivery is in progress for this worker

    async with lock:
        await _do_deliver(session_id)


async def _do_deliver(session_id: str):
    db = await get_db()
    try:
        # 1. Check worker's current task status — only deliver if current task is done
        cur = await db.execute(
            "SELECT task_id, cli_type FROM sessions WHERE id = ?", (session_id,),
        )
        sess = await cur.fetchone()
        if not sess:
            return

        current_task_id = sess["task_id"]
        cli_type = sess["cli_type"] or "claude"

        if current_task_id:
            cur = await db.execute(
                "SELECT status FROM tasks WHERE id = ?", (current_task_id,),
            )
            task_row = await cur.fetchone()
            if task_row and task_row["status"] not in ("done", "review", "verified", "blocked"):
                return  # Current task still in progress — don't deliver next one

        # 2. Find next queued task for this worker
        cur = await db.execute(
            """SELECT * FROM tasks WHERE queued_for_session_id = ?
               ORDER BY queue_order ASC LIMIT 1""",
            (session_id,),
        )
        next_task_row = await cur.fetchone()
        if not next_task_row:
            # Queue empty — emit event so Commander knows
            workspace_id = None
            cur2 = await db.execute(
                "SELECT workspace_id FROM sessions WHERE id = ?", (session_id,),
            )
            ws_row = await cur2.fetchone()
            if ws_row:
                workspace_id = ws_row["workspace_id"]
            await bus.emit(CommanderEvent.WORKER_QUEUE_EMPTY, {
                "session_id": session_id,
                "workspace_id": workspace_id,
            }, source="worker_queue")
            return

        task = dict(next_task_row)

        # 3. Assign the task to this worker
        await db.execute(
            """UPDATE tasks SET
               assigned_session_id = ?,
               queued_for_session_id = NULL,
               queue_order = 0,
               status = CASE WHEN status IN ('backlog', 'todo') THEN 'todo' ELSE status END,
               updated_at = datetime('now')
               WHERE id = ?""",
            (session_id, task["id"]),
        )

        # Update session's task_id
        await db.execute(
            "UPDATE sessions SET task_id = ? WHERE id = ?",
            (task["id"], session_id),
        )

        # Log event
        await db.execute(
            """INSERT INTO task_events (task_id, event_type, actor, old_value, new_value, message)
               VALUES (?, 'assigned_session_id_changed', 'worker_queue', NULL, ?, ?)""",
            (task["id"], session_id,
             f"Auto-delivered from queue to worker {session_id}"),
        )
        await db.commit()

    finally:
        await db.close()

    # 4. Send handoff prompt to worker PTY
    if not _pty_mgr or not _pty_mgr.is_alive(session_id):
        logger.warning("Worker %s not alive — cannot deliver queued task %s", session_id, task["id"])
        return

    prompt = _build_handoff_prompt(task)
    msg_bytes = prompt.encode("utf-8")

    if cli_type == "gemini":
        clean = prompt.replace("\n", " ").replace("\r", " ")
        _pty_mgr.write(session_id, clean.encode("utf-8") + b"\r")
    else:
        # Escape-clear + delay + text + delay + Enter (same pattern as auto_exec.py)
        _pty_mgr.write(session_id, b"\x1b" + b"\x7f" * 20)
        await asyncio.sleep(0.15)
        _pty_mgr.write(session_id, msg_bytes)
        await asyncio.sleep(0.4)
        _pty_mgr.write(session_id, b"\r")

    logger.info("Worker queue: delivered task %s to worker %s", task["id"], session_id)

    # 5. Emit event + broadcast
    await bus.emit(CommanderEvent.WORKER_QUEUE_TASK_DELIVERED, {
        "session_id": session_id,
        "task_id": task["id"],
        "title": task.get("title"),
        "workspace_id": task.get("workspace_id"),
    }, source="worker_queue")

    if _broadcast_fn:
        await _broadcast_fn({
            "type": "worker_queue_delivery",
            "session_id": session_id,
            "task_id": task["id"],
            "title": task.get("title"),
        })


def _build_handoff_prompt(task: dict) -> str:
    """Build the prompt sent to a worker when auto-delivered from queue."""
    parts = [
        "--- NEW TASK ASSIGNMENT ---",
        "Your previous task is complete. Here is your next assignment.",
        "",
        f"Task: {task.get('title', '')}",
        f"Task ID: {task['id']}",
    ]
    if task.get("description"):
        parts.append(f"Description: {task['description']}")
    if task.get("acceptance_criteria"):
        parts.append(f"Acceptance criteria: {task['acceptance_criteria']}")
    if task.get("labels"):
        parts.append(f"Labels: {task['labels']}")
    parts.append("")
    parts.append(
        f"Call get_my_tasks to see full details. "
        f'Update status via update_my_task(task_id="{task["id"]}") as you work.'
    )
    return "\n".join(parts)


# ── Registration ─────────────────────────────────────────────────────

def register_subscribers():
    """Wire up event handlers. Called from on_startup()."""
    bus.subscribe(CommanderEvent.TASK_STATUS_CHANGED, _on_task_completed)
    bus.subscribe(CommanderEvent.TASK_COMPLETED, _on_task_completed)
    logger.info("Worker queue subscribers registered")
