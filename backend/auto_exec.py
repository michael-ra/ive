"""Auto-exec: event-driven automatic task dispatch to Commander.

When a workspace has auto_exec_enabled=1, this module listens for task
creation and completion events and automatically dispatches pending tasks
to the Commander session, respecting commander_max_workers limits.

Wired up in on_startup() via register_subscribers().
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

# Per-workspace lock prevents concurrent dispatch races
_dispatch_locks: dict[str, asyncio.Lock] = {}

# Circuit breaker: stop dispatching if too many tasks are pending
MAX_PENDING_DISPATCHES = 20
_pending_counts: dict[str, int] = {}  # workspace_id → consecutive dispatch count
_BACKOFF_RESET_S = 60


def set_pty_manager(mgr):
    global _pty_mgr
    _pty_mgr = mgr


def set_broadcast_fn(fn):
    global _broadcast_fn
    _broadcast_fn = fn


def _get_lock(workspace_id: str) -> asyncio.Lock:
    if workspace_id not in _dispatch_locks:
        _dispatch_locks[workspace_id] = asyncio.Lock()
    return _dispatch_locks[workspace_id]


# ── Event handlers ───────────────────────────────────────────────────

async def _on_task_created(event_name: str, payload: dict):
    """New task created — maybe dispatch if auto_exec is on."""
    await _maybe_dispatch(payload.get("workspace_id"), payload.get("task_id"))


async def _on_task_completed(event_name: str, payload: dict):
    """Task finished — check for next pending task to pick up."""
    new_status = payload.get("new_status", payload.get("status"))
    ws_id = payload.get("workspace_id")
    if ws_id and new_status in ("done", "verified"):
        # Reset circuit breaker on successful completion
        _pending_counts.pop(ws_id, None)
    if new_status in ("testing", "documenting"):
        return  # Pipeline is handling this task's lifecycle
    if new_status in ("done", "verified", "blocked", "review"):
        await _maybe_dispatch(ws_id)


async def _on_iteration_requested(event_name: str, payload: dict):
    """Task iterated back to todo — dispatch if auto_exec is on."""
    await _maybe_dispatch(payload.get("workspace_id"), payload.get("task_id"))


# ── Core dispatch logic ─────────────────────────────────────────────

async def _maybe_dispatch(workspace_id: str, specific_task_id: str = None):
    """Check auto_exec, worker count, and dispatch next task to Commander."""
    if not workspace_id:
        return

    lock = _get_lock(workspace_id)
    if lock.locked():
        return  # Another dispatch is in progress for this workspace

    async with lock:
        await _do_dispatch(workspace_id, specific_task_id)


async def _deps_unmet(db, task: dict) -> bool:
    """Return True if the task has unfinished dependencies."""
    raw = task.get("depends_on", "[]")
    if not raw or raw == "[]":
        return False
    dep_ids = json.loads(raw) if isinstance(raw, str) else (raw or [])
    if not dep_ids:
        return False
    placeholders = ",".join("?" * len(dep_ids))
    cur = await db.execute(
        f"SELECT COUNT(*) as cnt FROM tasks WHERE id IN ({placeholders}) AND status NOT IN ('done', 'verified')",
        dep_ids,
    )
    row = await cur.fetchone()
    return (row["cnt"] if row else 0) > 0


async def _do_dispatch(workspace_id: str, specific_task_id: str = None):
    # Circuit breaker: prevent runaway dispatch loops
    count = _pending_counts.get(workspace_id, 0)
    if count >= MAX_PENDING_DISPATCHES:
        logger.warning("Auto-exec circuit breaker: %d dispatches for workspace %s, pausing",
                        count, workspace_id[:8])
        await bus.emit(CommanderEvent.AUTO_EXEC_THROTTLED, {
            "workspace_id": workspace_id,
            "reason": "circuit_breaker",
            "pending_count": count,
        }, source="auto_exec")
        return

    # Pipeline priority: if a pipeline is already handling this task, skip
    if specific_task_id:
        try:
            from pipeline_engine import is_task_in_pipeline
            if is_task_in_pipeline(specific_task_id):
                logger.debug("Auto-exec skipping task %s — pipeline is handling it", specific_task_id)
                return
        except Exception:
            pass

    db = await get_db()
    try:
        # 1. Check workspace auto_exec flag
        cur = await db.execute(
            "SELECT auto_exec_enabled, commander_max_workers, task_dependencies_enabled FROM workspaces WHERE id = ?",
            (workspace_id,),
        )
        ws = await cur.fetchone()
        if not ws or not ws["auto_exec_enabled"]:
            return

        max_workers = ws["commander_max_workers"] or 3
        task_deps_enabled = bool(ws["task_dependencies_enabled"])

        # 2. Find Commander session
        cur = await db.execute(
            """SELECT id FROM sessions
               WHERE workspace_id = ? AND session_type = 'commander'
               ORDER BY created_at DESC LIMIT 1""",
            (workspace_id,),
        )
        commander = await cur.fetchone()
        if not commander:
            return
        commander_id = commander["id"]

        # 3. Verify Commander PTY is alive
        if not _pty_mgr or not _pty_mgr.is_alive(commander_id):
            return

        # 4. Count active workers (sessions with in_progress/planning tasks)
        cur = await db.execute(
            """SELECT COUNT(*) as cnt FROM tasks
               WHERE workspace_id = ?
               AND status IN ('in_progress', 'planning')
               AND assigned_session_id IS NOT NULL""",
            (workspace_id,),
        )
        row = await cur.fetchone()
        active_workers = row["cnt"] if row else 0

        if active_workers >= max_workers:
            await bus.emit(CommanderEvent.AUTO_EXEC_THROTTLED, {
                "workspace_id": workspace_id,
                "active_workers": active_workers,
                "max_workers": max_workers,
            }, source="auto_exec")
            return

        # 5. Find next dispatchable task
        if specific_task_id:
            cur = await db.execute(
                """SELECT * FROM tasks
                   WHERE id = ? AND workspace_id = ? AND status IN ('backlog', 'todo')
                   AND assigned_session_id IS NULL""",
                (specific_task_id, workspace_id),
            )
            task_row = await cur.fetchone()
            if not task_row:
                return
            task = dict(task_row)
            # Check dependencies for the specific task
            if task_deps_enabled and await _deps_unmet(db, task):
                logger.debug("Auto-exec skipping task %s — dependencies not met", specific_task_id)
                return
        else:
            cur = await db.execute(
                """SELECT * FROM tasks
                   WHERE workspace_id = ? AND status IN ('backlog', 'todo')
                   AND assigned_session_id IS NULL
                   ORDER BY priority DESC, sort_order ASC, created_at ASC
                   LIMIT 10""",
                (workspace_id,),
            )
            candidates = [dict(r) for r in await cur.fetchall()]
            task = None
            for candidate in candidates:
                if task_deps_enabled and await _deps_unmet(db, candidate):
                    continue
                task = candidate
                break
            if not task:
                return
    finally:
        await db.close()

    # 5b. Double-check pipeline hasn't claimed this task in the meantime.
    # The check at line ~218 used to be the only guard, but there are awaits
    # between that check and the PTY write below — pipeline_engine.start_run
    # could land in that gap. We re-check right before each PTY write (the
    # check is sync; pipeline claims the task synchronously before its own
    # awaits, so any prior context-switch will already have populated the set).
    try:
        from pipeline_engine import is_task_in_pipeline
    except Exception:
        is_task_in_pipeline = None  # type: ignore

    if is_task_in_pipeline and is_task_in_pipeline(task["id"]):
        logger.debug("Auto-exec skipping task %s — pipeline claimed it", task["id"])
        return

    # 6. Build prompt and send to Commander PTY
    prompt = _build_task_prompt(task)
    msg_bytes = prompt.encode("utf-8")

    # Re-check pipeline ownership at the last possible moment before writing.
    if is_task_in_pipeline and is_task_in_pipeline(task["id"]):
        logger.debug("Auto-exec aborting task %s pre-write — pipeline claimed it", task["id"])
        return

    # Use Escape-clear + delay + Enter pattern (same as send_session_input)
    _pty_mgr.write(commander_id, b"\x1b" + b"\x7f" * 20)
    await asyncio.sleep(0.15)
    if is_task_in_pipeline and is_task_in_pipeline(task["id"]):
        # Pipeline raced in during the post-Escape settle. Abort before we
        # type the prompt — Commander's input field is now empty so this is
        # a safe bail-out.
        logger.debug("Auto-exec aborting task %s mid-write — pipeline claimed it", task["id"])
        return
    _pty_mgr.write(commander_id, msg_bytes)
    await asyncio.sleep(0.4)
    _pty_mgr.write(commander_id, b"\r")

    _pending_counts[workspace_id] = _pending_counts.get(workspace_id, 0) + 1
    logger.info("Auto-exec dispatched task %s to commander %s", task["id"], commander_id)

    await bus.emit(CommanderEvent.AUTO_EXEC_TASK_DISPATCHED, {
        "workspace_id": workspace_id,
        "task_id": task["id"],
        "title": task.get("title"),
        "commander_session_id": commander_id,
    }, source="auto_exec")

    # Broadcast for frontend notification
    if _broadcast_fn:
        await _broadcast_fn({
            "type": "auto_exec_dispatch",
            "workspace_id": workspace_id,
            "task_id": task["id"],
            "title": task.get("title"),
        })


def _build_task_prompt(task: dict) -> str:
    """Build the dispatch prompt sent to Commander for a task."""
    parts = [
        f"Pick up task: {task.get('title', '')}",
        f"Task ID: {task['id']}",
    ]
    if task.get("description"):
        parts.append(f"Description: {task['description']}")
    if task.get("acceptance_criteria"):
        parts.append(f"Acceptance criteria: {task['acceptance_criteria']}")
    if task.get("plan_first"):
        parts.append("Plan first: yes -- research and plan, then wait for approval before implementing")
    else:
        parts.append("Plan first: no -- implement directly")
    if task.get("ralph_loop"):
        parts.append("Ralph mode: ON")
    if task.get("deep_research"):
        parts.append("Deep research: ON")
    if task.get("test_with_agent"):
        parts.append("Test with agent: ON")
    if task.get("pipeline"):
        parts.append("Pipeline mode: ON — implement with Ralph-style verification, then set status to 'review' to trigger automated testing and documentation")
        parts.append(f"Pipeline max iterations: {task.get('pipeline_max_iterations', 5)}")

    # Iteration context — give Commander and worker full history
    iteration = task.get("iteration") or 1
    if iteration > 1:
        parts.append(f"\nThis is iteration {iteration} of this task (revision requested).")
        if task.get("last_agent_session_id"):
            parts.append(f"Previous work was done by session {task['last_agent_session_id']}. Reuse it if still alive.")
        if task.get("lessons_learned"):
            parts.append(f"Lessons from previous work:\n{task['lessons_learned']}")
        if task.get("important_notes"):
            parts.append(f"Important notes: {task['important_notes']}")
        if task.get("iteration_history"):
            try:
                history = json.loads(task["iteration_history"])
                if history:
                    last = history[-1]
                    if last.get("result_summary"):
                        parts.append(f"Previous result: {last['result_summary']}")
                    if last.get("discoveries"):
                        parts.append(f"Previous discoveries: {', '.join(last['discoveries'][:5])}")
                    if last.get("files_touched"):
                        parts.append(f"Files previously touched: {', '.join(last['files_touched'][:10])}")
            except (json.JSONDecodeError, TypeError):
                pass

    parts.append(
        f'\nStatus tracking: Update this task via update_task(task_id="{task["id"]}") '
        '-- set status to "in_progress" when work begins, and "done" with a result_summary when complete.'
    )
    return "\n".join(parts)


# ── Registration ─────────────────────────────────────────────────────

def register_subscribers():
    """Wire up event handlers. Called from on_startup()."""
    bus.subscribe(CommanderEvent.TASK_CREATED, _on_task_created)
    bus.subscribe(CommanderEvent.TASK_STATUS_CHANGED, _on_task_completed)
    bus.subscribe(CommanderEvent.TASK_COMPLETED, _on_task_completed)
    bus.subscribe(CommanderEvent.TASK_ITERATION_REQUESTED, _on_iteration_requested)
    logger.info("Auto-exec subscribers registered")
