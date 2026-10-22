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
from task_dependencies import get_task_ready
import dispatch_ownership

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


async def _on_research_completed(event_name: str, payload: dict):
    """Research finished — un-park any task blocked on it.

    On success the task returns to 'todo' and dispatch is retried; on
    failure/cancel it returns to 'backlog' with an event note so Commander can
    decide whether to proceed without the research or re-commission. Either way
    the blocked_on_research_id link is cleared, so a stalled or cancelled
    research job never strands the task in the parking lane forever.
    """
    entry_id = payload.get("entry_id")
    if not entry_id:
        return
    success = payload.get("status") == "complete"
    new_status = "todo" if success else "backlog"
    if success:
        note = "research complete — task resumed"
    else:
        outcome = payload.get("status") or "ended"
        err = payload.get("error")
        note = f"research {outcome} — task unblocked" + (f": {err}" if err else "")

    workspaces: set[str] = set()
    parked: list[dict] = []
    # The event bus swallows subscriber exceptions, so guard explicitly: a
    # silent failure here would leave the task parked forever (the startup
    # reconciliation is the only other backstop).
    try:
        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT id, workspace_id, status FROM tasks WHERE blocked_on_research_id = ?",
                (entry_id,),
            )
            parked = [dict(r) for r in await cur.fetchall()]
            for t in parked:
                await db.execute(
                    "UPDATE tasks SET blocked_on_research_id = NULL, status = ?, "
                    "updated_at = datetime('now') WHERE id = ?",
                    (new_status, t["id"]),
                )
                await db.execute(
                    "INSERT INTO task_events (task_id, event_type, actor, old_value, new_value, message) "
                    "VALUES (?, 'status_changed', 'research', ?, ?, ?)",
                    (t["id"], t.get("status"), new_status, note),
                )
                if t.get("workspace_id"):
                    workspaces.add(t["workspace_id"])
            await db.commit()
        finally:
            await db.close()
    except Exception:
        logger.exception("failed to un-park tasks for research %s", entry_id)
        return

    if parked:
        logger.info("Research %s (%s) un-parked %d task(s)",
                    entry_id[:8], payload.get("status"), len(parked))
    for ws_id in workspaces:
        await _maybe_dispatch(ws_id)


# ── Core dispatch logic ─────────────────────────────────────────────

async def dispatch_task_to_commander(
    workspace_id: str,
    specific_task_id: str | None = None,
    *,
    require_auto_exec: bool = False,
) -> dict:
    """Public dispatch entrypoint for explicit, dependency-gated intents."""
    return await _maybe_dispatch(
        workspace_id,
        specific_task_id,
        require_auto_exec=require_auto_exec,
    )


async def _maybe_dispatch(
    workspace_id: str,
    specific_task_id: str = None,
    *,
    require_auto_exec: bool = True,
) -> dict:
    """Check auto_exec, worker count, and dispatch next task to Commander."""
    if not workspace_id:
        return {"ok": False, "dispatched": False, "reason": "workspace_id_required"}

    lock = _get_lock(workspace_id)
    if lock.locked():
        return {"ok": False, "dispatched": False, "reason": "dispatch_in_progress"}

    async with lock:
        return await _do_dispatch(
            workspace_id,
            specific_task_id,
            require_auto_exec=require_auto_exec,
        )


async def _has_pending_dispatch_intent(db, task_id: str) -> bool:
    cur = await db.execute(
        "SELECT 1 FROM task_dispatch_intents WHERE task_id = ? AND status = 'pending' LIMIT 1",
        (task_id,),
    )
    return await cur.fetchone() is not None


async def is_brain_enabled(workspace_id: str) -> bool:
    """Legacy Company adapter; inactive products never own dispatch."""
    return bool(await dispatch_ownership.get_owner(workspace_id, get_db=get_db, owner="company"))


async def _do_dispatch(
    workspace_id: str,
    specific_task_id: str = None,
    *,
    require_auto_exec: bool = True,
) -> dict:
    # Only implicit auto-dispatch yields to an installed external owner. The
    # explicit dispatch entrypoint retains its own dependency/permission gates.
    if require_auto_exec:
        owner = await dispatch_ownership.get_owner(workspace_id, get_db=get_db)
        if owner:
            logger.debug("Auto-exec dormant for workspace %s — owner=%s", workspace_id[:8], owner["owner"])
            return {"ok": False, "dispatched": False, "reason": owner["reason"]}

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
        return {"ok": False, "dispatched": False, "reason": "circuit_breaker", "pending_count": count}

    # Pipeline priority: if a pipeline is already handling this task, skip
    if specific_task_id:
        try:
            from pipeline_engine import is_task_in_pipeline
            if is_task_in_pipeline(specific_task_id):
                logger.debug("Auto-exec skipping task %s — pipeline is handling it", specific_task_id)
                return {"ok": False, "dispatched": False, "reason": "pipeline_claimed"}
        except Exception:
            pass

    db = await get_db()
    try:
        # 1. Check workspace auto_exec flag
        cur = await db.execute(
            "SELECT auto_exec_enabled, commander_max_workers, commander_max_epics, task_dependencies_enabled FROM workspaces WHERE id = ?",
            (workspace_id,),
        )
        ws = await cur.fetchone()
        if not ws:
            return {"ok": False, "dispatched": False, "reason": "workspace_not_found"}
        if require_auto_exec and not ws["auto_exec_enabled"]:
            return {"ok": False, "dispatched": False, "reason": "auto_exec_disabled"}

        max_workers = ws["commander_max_workers"] or 3
        # Epics are coarse intents that each fan out into their own sub-task
        # tree, so they get a tighter concurrency cap than leaf workers — a
        # released blueprint shouldn't light up every phase-root epic at once.
        max_epics = ws["commander_max_epics"] or 2

        # 2. Find Commander session
        cur = await db.execute(
            """SELECT id FROM sessions
               WHERE workspace_id = ? AND session_type = 'commander'
               ORDER BY created_at DESC LIMIT 1""",
            (workspace_id,),
        )
        commander = await cur.fetchone()
        if not commander:
            return {"ok": False, "dispatched": False, "reason": "commander_not_found"}
        commander_id = commander["id"]

        # 3. Verify Commander PTY is alive — auto-revive if dead so a stopped
        # commander doesn't silently swallow board-triggered dispatches.
        if not _pty_mgr:
            return {"ok": False, "dispatched": False, "reason": "pty_manager_unavailable"}
        if not _pty_mgr.is_alive(commander_id):
            try:
                from session_supervisor import restart as _supervisor_restart
                logger.info("Auto-exec: commander PTY %s dead, reviving", commander_id)
                result = await _supervisor_restart(commander_id)
                if not result.get("ok"):
                    logger.warning("Auto-exec: failed to revive commander %s: %s",
                                   commander_id, result.get("error"))
                    return {"ok": False, "dispatched": False, "reason": "commander_revive_failed", "detail": result.get("error")}
                # Give the Ink TUI a beat to render before paste lands.
                await asyncio.sleep(1.5)
            except Exception:
                logger.exception("Auto-exec: commander revive raised; bailing")
                return {"ok": False, "dispatched": False, "reason": "commander_revive_failed"}
            if not _pty_mgr.is_alive(commander_id):
                return {"ok": False, "dispatched": False, "reason": "commander_not_alive"}

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

        # Count epics already in flight so the cap below can hold the line.
        cur = await db.execute(
            """SELECT COUNT(*) as cnt FROM tasks
               WHERE workspace_id = ? AND tier = 'epic'
               AND status IN ('in_progress', 'planning')""",
            (workspace_id,),
        )
        erow = await cur.fetchone()
        active_epics = erow["cnt"] if erow else 0

        if active_workers >= max_workers:
            await bus.emit(CommanderEvent.AUTO_EXEC_THROTTLED, {
                "workspace_id": workspace_id,
                "active_workers": active_workers,
                "max_workers": max_workers,
            }, source="auto_exec")
            return {
                "ok": False,
                "dispatched": False,
                "reason": "max_workers_reached",
                "active_workers": active_workers,
                "max_workers": max_workers,
            }

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
                return {"ok": False, "dispatched": False, "reason": "task_not_dispatchable"}
            task = dict(task_row)
            if require_auto_exec and await _has_pending_dispatch_intent(db, task["id"]):
                return {"ok": False, "dispatched": False, "reason": "pending_dispatch_intent", "task_id": task["id"]}
            # Check dependencies for the specific task
            readiness = await get_task_ready(db, task["id"], task)
            if readiness and not readiness["ready"]:
                logger.debug("Auto-exec skipping task %s — dependencies not met", specific_task_id)
                return {
                    "ok": False,
                    "dispatched": False,
                    "reason": "dependencies_unmet",
                    **readiness,
                }
            if (task.get("tier") or "") == "epic" and active_epics >= max_epics:
                return {
                    "ok": False,
                    "dispatched": False,
                    "reason": "max_epics_reached",
                    "active_epics": active_epics,
                    "max_epics": max_epics,
                    "task_id": task["id"],
                }
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
            blocked = []
            for candidate in candidates:
                if require_auto_exec and await _has_pending_dispatch_intent(db, candidate["id"]):
                    continue
                readiness = await get_task_ready(db, candidate["id"], candidate)
                if readiness and not readiness["ready"]:
                    blocked.append(readiness)
                    continue
                # Hold the epic concurrency cap: skip an epic candidate when the
                # workspace already has max_epics in flight, but keep scanning so
                # leaf sub-tasks can still dispatch under the worker cap.
                if (candidate.get("tier") or "") == "epic" and active_epics >= max_epics:
                    continue
                task = candidate
                break
            if not task:
                return {
                    "ok": False,
                    "dispatched": False,
                    "reason": "no_ready_tasks" if blocked else "no_dispatchable_tasks",
                    "blocked": blocked,
                }

        # Inherit the intent task's seam contract (set by the Planner) so this
        # slice worker builds to the same interface as its sibling slices. The
        # seam-fit review task is the exception: it carries the contract in its
        # own description with JUDGE-not-build framing, so skip the "build to
        # this exactly" injection there.
        if task.get("parent_task_id") and "seam-fit-check" not in (task.get("labels") or ""):
            cur = await db.execute(
                "SELECT seam_contract FROM tasks WHERE id = ?",
                (task["parent_task_id"],),
            )
            prow = await cur.fetchone()
            if prow and prow["seam_contract"]:
                task["seam_contract"] = prow["seam_contract"]
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
        return {"ok": False, "dispatched": False, "reason": "pipeline_claimed", "task_id": task["id"]}

    # 6. Build prompt and send to Commander PTY
    prompt = _build_task_prompt(task)
    msg_bytes = prompt.encode("utf-8")

    # Re-check pipeline ownership at the last possible moment before writing.
    if is_task_in_pipeline and is_task_in_pipeline(task["id"]):
        logger.debug("Auto-exec aborting task %s pre-write — pipeline claimed it", task["id"])
        return {"ok": False, "dispatched": False, "reason": "pipeline_claimed", "task_id": task["id"]}

    # Use Escape-clear + delay + Enter pattern (same as send_session_input)
    _pty_mgr.write(commander_id, b"\x1b" + b"\x7f" * 20)
    await asyncio.sleep(0.15)
    if is_task_in_pipeline and is_task_in_pipeline(task["id"]):
        # Pipeline raced in during the post-Escape settle. Abort before we
        # type the prompt — Commander's input field is now empty so this is
        # a safe bail-out.
        logger.debug("Auto-exec aborting task %s mid-write — pipeline claimed it", task["id"])
        return {"ok": False, "dispatched": False, "reason": "pipeline_claimed", "task_id": task["id"]}
    # Never press Enter after a rejected write: it would submit a partial
    # or stale input line instead of the task prompt.
    if _pty_mgr.write(commander_id, msg_bytes) is False:
        logger.warning("Auto-exec: commander %s rejected task %s prompt", commander_id, task["id"])
        return {"ok": False, "dispatched": False, "reason": "input_rejected", "task_id": task["id"]}
    await asyncio.sleep(0.4)
    if _pty_mgr.write(commander_id, b"\r") is False:
        logger.warning("Auto-exec: commander %s rejected Enter for task %s", commander_id, task["id"])
        return {"ok": False, "dispatched": False, "reason": "input_rejected", "task_id": task["id"]}

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

    return {
        "ok": True,
        "dispatched": True,
        "workspace_id": workspace_id,
        "task_id": task["id"],
        "title": task.get("title"),
        "commander_session_id": commander_id,
    }


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
    if task.get("seam_contract"):
        parts.append(
            "Seam contract (shared interface with sibling slices — build to this "
            "EXACTLY; do not redefine it). Pass this to the worker:\n"
            f"{str(task['seam_contract']).strip()}"
        )
        parts.append(
            "If the seam is ambiguous, post a question to peer messages "
            "(topic='seam') referencing the intent task instead of guessing — "
            "the plan is the authority on the contract."
        )
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
    bus.subscribe(CommanderEvent.RESEARCH_COMPLETED, _on_research_completed)
    logger.info("Auto-exec subscribers registered")
