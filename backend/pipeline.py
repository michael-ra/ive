"""Task Pipeline: event-driven implement → test → document loop.

When a task has pipeline=1, this module automates the post-implementation
flow: worker marks 'review' → route to tester → route to documentor → done.
If tests fail, iterate back to the implementor with failure context.

Wired up in on_startup() via register_subscribers(), same pattern as auto_exec.py.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid

from commander_events import CommanderEvent
from event_bus import bus
from db import get_db

logger = logging.getLogger(__name__)

_pty_mgr = None
_broadcast_fn = None

# Per-task lock prevents concurrent pipeline transitions on the same task
_pipeline_locks: dict[str, asyncio.Lock] = {}


def set_pty_manager(mgr):
    global _pty_mgr
    _pty_mgr = mgr


def set_broadcast_fn(fn):
    global _broadcast_fn
    _broadcast_fn = fn


def _get_lock(task_id: str) -> asyncio.Lock:
    if task_id not in _pipeline_locks:
        _pipeline_locks[task_id] = asyncio.Lock()
    return _pipeline_locks[task_id]


# ── Event handlers ───────────────────────────────────────────────────

async def _on_task_status_changed(event_name: str, payload: dict):
    """React to task status changes for pipeline-enabled tasks."""
    task_id = payload.get("task_id")
    new_status = payload.get("new_status")
    if not task_id or not new_status:
        return

    # Route to testing when worker marks review
    if new_status == "review":
        await _maybe_route_to_testing(task_id)

    # Complete pipeline when documentor marks done
    elif new_status == "done":
        await _maybe_complete_pipeline(task_id)

    # Detect manual override: user drags task out of pipeline flow
    elif new_status in ("backlog", "in_progress", "planning", "blocked"):
        await _clear_pipeline_stage_if_needed(task_id)


async def _on_test_completed(event_name: str, payload: dict):
    """React to test queue entry completion — route to documentor or iterate."""
    task_id = payload.get("task_id")
    if not task_id:
        return

    # Only handle pipeline tasks in the testing stage
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        row = await cur.fetchone()
        if not row:
            return
        task = dict(row)
    finally:
        await db.close()

    if not task.get("pipeline") or task.get("pipeline_stage") != "testing":
        return

    lock = _get_lock(task_id)
    if lock.locked():
        return
    async with lock:
        test_status = payload.get("status", "")
        result_summary = payload.get("result_summary", "")
        workspace_id = task.get("workspace_id")

        if test_status == "done":
            # Tests passed — route to documentor
            await _route_to_documentor(task_id, workspace_id, result_summary)
        else:
            # Tests failed — iterate back to implementor
            await _route_back_to_implementor(task_id, workspace_id, result_summary)


# ── Core pipeline functions ──────────────────────────────────────────

async def _clear_pipeline_stage_if_needed(task_id: str):
    """Clear pipeline_stage when user manually moves a pipeline task out of flow."""
    db = await get_db()
    try:
        cur = await db.execute("SELECT pipeline, pipeline_stage FROM tasks WHERE id = ?", (task_id,))
        row = await cur.fetchone()
        if row and row["pipeline"] and row["pipeline_stage"]:
            logger.info("Pipeline: user override detected for task %s, clearing pipeline_stage", task_id)
            await db.execute(
                "UPDATE tasks SET pipeline_stage = NULL, updated_at = datetime('now') WHERE id = ?",
                (task_id,),
            )
            await db.commit()
    finally:
        await db.close()


async def _maybe_route_to_testing(task_id: str):
    """Check if task is pipeline-enabled and route to testing."""
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        row = await cur.fetchone()
        if not row:
            return
        task = dict(row)
    finally:
        await db.close()

    if not task.get("pipeline"):
        return

    lock = _get_lock(task_id)
    if lock.locked():
        return
    async with lock:
        workspace_id = task.get("workspace_id")
        await _route_to_testing(task_id, workspace_id)


async def _route_to_testing(task_id: str, workspace_id: str):
    """Route a pipeline task to the tester session."""
    logger.info("Pipeline: routing task %s to testing", task_id)

    db = await get_db()
    try:
        # Update task status
        await db.execute(
            "UPDATE tasks SET status = 'testing', pipeline_stage = 'testing', updated_at = datetime('now') WHERE id = ?",
            (task_id,),
        )
        await db.commit()

        # Fetch updated task for broadcasting
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        task = dict(await cur.fetchone())

        # Ensure tester session exists
        tester_id = await _ensure_tester_session(workspace_id, db)

        # Create test queue entry
        entry_id = str(uuid.uuid4())
        await db.execute(
            """INSERT INTO test_queue (id, workspace_id, task_id, title, description, acceptance_criteria)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (entry_id, workspace_id, task_id,
             task.get("title", ""), task.get("description", ""),
             task.get("acceptance_criteria", "")),
        )
        await db.commit()
    finally:
        await db.close()

    # Broadcast task update
    if _broadcast_fn:
        await _broadcast_fn({"type": "task_update", "action": "updated", "task": task})

    await bus.emit(CommanderEvent.PIPELINE_TESTING_STARTED, {
        "task_id": task_id,
        "workspace_id": workspace_id,
        "title": task.get("title"),
        "tester_session_id": tester_id,
    }, source="pipeline")

    # Trigger test queue processing (import lazily to avoid circular)
    from server import _process_test_queue
    asyncio.ensure_future(_process_test_queue(workspace_id))


async def _route_to_documentor(task_id: str, workspace_id: str, test_results: str):
    """Route a pipeline task to the documentor session after tests pass."""
    logger.info("Pipeline: tests passed for task %s, routing to documentor", task_id)

    await bus.emit(CommanderEvent.PIPELINE_TEST_PASSED, {
        "task_id": task_id,
        "workspace_id": workspace_id,
    }, source="pipeline")

    db = await get_db()
    try:
        # Update task status
        await db.execute(
            "UPDATE tasks SET status = 'documenting', pipeline_stage = 'documenting', updated_at = datetime('now') WHERE id = ?",
            (task_id,),
        )
        await db.commit()

        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        task = dict(await cur.fetchone())

        # Ensure documentor session exists
        documentor_id = await _ensure_documentor_session(workspace_id, db)

        # Attach worker-board MCP so documentor can self-report completion
        await db.execute(
            "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
            (documentor_id, "builtin-worker-board"),
        )
        # Assign task to documentor so worker-board MCP is scoped
        await db.execute(
            "UPDATE sessions SET task_id = ? WHERE id = ?",
            (task_id, documentor_id),
        )
        await db.commit()
    finally:
        await db.close()

    # Broadcast task update
    if _broadcast_fn:
        await _broadcast_fn({"type": "task_update", "action": "updated", "task": task})

    # Build doc prompt and send to documentor PTY
    prompt = _build_doc_prompt(task, test_results)
    if _pty_mgr and _pty_mgr.is_alive(documentor_id):
        _pty_mgr.write(documentor_id, b"\x1b" + b"\x7f" * 20)
        await asyncio.sleep(0.15)
        _pty_mgr.write(documentor_id, prompt.encode("utf-8"))
        await asyncio.sleep(0.4)
        _pty_mgr.write(documentor_id, b"\r")

    await bus.emit(CommanderEvent.PIPELINE_DOCUMENTING_STARTED, {
        "task_id": task_id,
        "workspace_id": workspace_id,
        "title": task.get("title"),
        "documentor_session_id": documentor_id,
    }, source="pipeline")


async def _route_back_to_implementor(task_id: str, workspace_id: str, failure_details: str):
    """Route a failed pipeline task back to the implementor via iteration."""
    logger.info("Pipeline: tests failed for task %s, iterating back to implementor", task_id)

    await bus.emit(CommanderEvent.PIPELINE_TEST_FAILED, {
        "task_id": task_id,
        "workspace_id": workspace_id,
        "failure_details": failure_details,
    }, source="pipeline")

    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        row = await cur.fetchone()
        if not row:
            return
        task = dict(row)

        current_iteration = task.get("iteration") or 1
        max_iterations = task.get("pipeline_max_iterations") or 5

        # Check if max iterations exceeded
        if current_iteration >= max_iterations:
            logger.warning("Pipeline: task %s hit max iterations (%d), marking blocked", task_id, max_iterations)
            await db.execute(
                """UPDATE tasks SET status = 'blocked', pipeline_stage = 'blocked',
                   result_summary = ?, updated_at = datetime('now') WHERE id = ?""",
                (f"Pipeline hit max iterations ({max_iterations}). Last test failure:\n{failure_details}", task_id),
            )
            await db.commit()
            cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
            blocked_task = dict(await cur.fetchone())

            if _broadcast_fn:
                await _broadcast_fn({"type": "task_update", "action": "updated", "task": blocked_task})

            await bus.emit(CommanderEvent.PIPELINE_MAX_ITERATIONS_HIT, {
                "task_id": task_id,
                "workspace_id": workspace_id,
                "title": task.get("title"),
                "iterations": current_iteration,
                "max_iterations": max_iterations,
            }, source="pipeline")
            return

        # Snapshot current state into iteration history
        history_entry = {
            "iteration": current_iteration,
            "description": task.get("description"),
            "result_summary": task.get("result_summary"),
            "acceptance_criteria": task.get("acceptance_criteria"),
            "completed_at": task.get("completed_at"),
            "agent_session_id": task.get("assigned_session_id"),
            "lessons_learned": task.get("lessons_learned"),
            "important_notes": task.get("important_notes"),
            "pipeline_test_failure": failure_details,
        }

        # Pull session digest if available
        assigned = task.get("assigned_session_id")
        if assigned:
            try:
                dcur = await db.execute(
                    "SELECT discoveries, decisions, files_touched, current_focus FROM session_digests WHERE session_id = ?",
                    (assigned,),
                )
                drow = await dcur.fetchone()
                if drow:
                    history_entry["discoveries"] = json.loads(drow["discoveries"] or "[]")
                    history_entry["decisions"] = json.loads(drow["decisions"] or "[]")
                    history_entry["files_touched"] = json.loads(drow["files_touched"] or "[]")
            except Exception:
                pass

        existing_history = []
        if task.get("iteration_history"):
            try:
                existing_history = json.loads(task["iteration_history"])
            except (json.JSONDecodeError, TypeError):
                existing_history = []
        existing_history.append(history_entry)

        # Reset task for next iteration
        await db.execute(
            """UPDATE tasks SET
               iteration = ?,
               iteration_history = ?,
               last_agent_session_id = ?,
               status = 'todo',
               pipeline_stage = 'implementing',
               result_summary = NULL,
               completed_at = NULL,
               assigned_session_id = NULL,
               updated_at = datetime('now')
               WHERE id = ?""",
            (
                current_iteration + 1,
                json.dumps(existing_history),
                task.get("assigned_session_id"),
                task_id,
            ),
        )

        # Record event
        msg = f"Pipeline iteration {current_iteration + 1}: tests failed — {failure_details[:200]}"
        await db.execute(
            """INSERT INTO task_events (task_id, event_type, actor, old_value, new_value, message)
               VALUES (?, 'iteration_requested', 'pipeline', ?, ?, ?)""",
            (task_id, str(current_iteration), str(current_iteration + 1), msg),
        )

        await db.commit()
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        updated = dict(await cur.fetchone())
    finally:
        await db.close()

    if _broadcast_fn:
        await _broadcast_fn({"type": "task_update", "action": "updated", "task": updated})

    # Emit iteration event — auto_exec picks this up for re-dispatch
    await bus.emit(CommanderEvent.TASK_ITERATION_REQUESTED, {
        "task_id": task_id,
        "workspace_id": workspace_id,
        "title": updated.get("title"),
        "iteration": current_iteration + 1,
        "previous_session_id": task.get("assigned_session_id"),
    }, source="pipeline")


async def _maybe_complete_pipeline(task_id: str):
    """Complete pipeline when documentor marks task done."""
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        row = await cur.fetchone()
        if not row:
            return
        task = dict(row)
    finally:
        await db.close()

    if not task.get("pipeline") or task.get("pipeline_stage") != "documenting":
        return

    lock = _get_lock(task_id)
    if lock.locked():
        return
    async with lock:
        await _complete_pipeline(task_id, task.get("workspace_id"))


async def _complete_pipeline(task_id: str, workspace_id: str):
    """Mark a pipeline task as fully complete."""
    logger.info("Pipeline: task %s completed (implement → test → document)", task_id)

    db = await get_db()
    try:
        await db.execute(
            """UPDATE tasks SET status = 'done', pipeline_stage = 'done',
               completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?""",
            (task_id,),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        task = dict(await cur.fetchone())
    finally:
        await db.close()

    if _broadcast_fn:
        await _broadcast_fn({"type": "task_update", "action": "updated", "task": task})

    await bus.emit(CommanderEvent.PIPELINE_COMPLETED, {
        "task_id": task_id,
        "workspace_id": workspace_id,
        "title": task.get("title"),
        "iterations": task.get("iteration", 1),
    }, source="pipeline")


# ── Session helpers ──────────────────────────────────────────────────

async def _ensure_tester_session(workspace_id: str, db=None) -> str:
    """Find or create a tester session for the workspace. Returns session_id."""
    close_db = False
    if db is None:
        db = await get_db()
        close_db = True
    try:
        cur = await db.execute(
            """SELECT id FROM sessions
               WHERE workspace_id = ? AND session_type = 'tester'
               ORDER BY created_at DESC LIMIT 1""",
            (workspace_id,),
        )
        row = await cur.fetchone()
        if row:
            session_id = row["id"]
            # Start PTY if not alive
            if _pty_mgr and not _pty_mgr.is_alive(session_id):
                logger.info("Pipeline: starting tester PTY %s", session_id)
                # PTY start is handled by WebSocket start_pty — we just need the session to exist
                # The test queue processing will handle PTY start via the existing flow
            return session_id

        # No tester exists — create one
        from config import TESTER_SYSTEM_PROMPT
        from cli_profiles import get_profile

        cli_type = "claude"
        profile = get_profile(cli_type)
        session_id = str(uuid.uuid4())

        cur = await db.execute("SELECT name FROM workspaces WHERE id = ?", (workspace_id,))
        ws_row = await cur.fetchone()
        ws_name = ws_row["name"] if ws_row else "Workspace"

        await db.execute(
            """INSERT INTO sessions (id, workspace_id, name, model, permission_mode, effort,
               system_prompt, session_type, auto_approve_mcp, cli_type)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'tester', 1, ?)""",
            (session_id, workspace_id, f"Tester — {ws_name}",
             profile.default_tester_model,
             "plan" if profile.supports(Feature.PLAN_MODE) else profile.default_permission_mode,
             "high", TESTER_SYSTEM_PROMPT, cli_type),
        )

        # Attach Playwright MCP + testing guideline
        await db.execute(
            "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
            (session_id, "builtin-playwright"),
        )
        await db.execute(
            "INSERT OR IGNORE INTO session_guidelines (session_id, guideline_id) VALUES (?, ?)",
            (session_id, "builtin-testing-agent"),
        )
        await db.commit()

        logger.info("Pipeline: created tester session %s for workspace %s", session_id, workspace_id)

        if _broadcast_fn:
            cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
            session = dict(await cur.fetchone())
            await _broadcast_fn({"type": "session_created", "session": session})

        return session_id
    finally:
        if close_db:
            await db.close()


async def _ensure_documentor_session(workspace_id: str, db=None) -> str:
    """Find or create a documentor session for the workspace. Returns session_id."""
    close_db = False
    if db is None:
        db = await get_db()
        close_db = True
    try:
        cur = await db.execute(
            """SELECT id FROM sessions
               WHERE workspace_id = ? AND session_type = 'documentor'
               ORDER BY created_at DESC LIMIT 1""",
            (workspace_id,),
        )
        row = await cur.fetchone()
        if row:
            return row["id"]

        # No documentor exists — create one
        from config import DOCUMENTOR_SYSTEM_PROMPT, DOCUMENTOR_ALLOWED_TOOLS
        from cli_profiles import get_profile
        import json as _json

        cli_type = "claude"
        profile = get_profile(cli_type)
        session_id = str(uuid.uuid4())

        cur = await db.execute("SELECT name FROM workspaces WHERE id = ?", (workspace_id,))
        ws_row = await cur.fetchone()
        ws_name = ws_row["name"] if ws_row else "Workspace"

        permission_mode = "acceptEdits" if cli_type == "claude" else profile.default_permission_mode

        await db.execute(
            """INSERT INTO sessions (id, workspace_id, name, model, permission_mode, effort,
               system_prompt, session_type, auto_approve_mcp, auto_approve_plan, cli_type, allowed_tools)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'documentor', 1, 1, ?, ?)""",
            (session_id, workspace_id, f"Documentor — {ws_name}",
             profile.default_tester_model, permission_mode, "high",
             DOCUMENTOR_SYSTEM_PROMPT, cli_type, _json.dumps(DOCUMENTOR_ALLOWED_TOOLS)),
        )

        # Attach Documentor MCP + Playwright MCP + guideline
        for mcp_id in ("builtin-documentor", "builtin-playwright"):
            await db.execute(
                "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
                (session_id, mcp_id),
            )
        await db.execute(
            "INSERT OR IGNORE INTO session_guidelines (session_id, guideline_id) VALUES (?, ?)",
            (session_id, "builtin-documentation-agent"),
        )
        await db.commit()

        logger.info("Pipeline: created documentor session %s for workspace %s", session_id, workspace_id)

        if _broadcast_fn:
            cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
            session = dict(await cur.fetchone())
            await _broadcast_fn({"type": "session_created", "session": session})

        return session_id
    finally:
        if close_db:
            await db.close()


# ── Prompt builders ──────────────────────────────────────────────────

def _build_doc_prompt(task: dict, test_results: str) -> str:
    """Build the documentation prompt sent to the documentor."""
    parts = [
        f"Document this feature: {task.get('title', '')}",
        f"Task ID: {task.get('id', '')}",
    ]
    if task.get("description"):
        parts.append(f"\nDescription: {task['description']}")
    if task.get("acceptance_criteria"):
        parts.append(f"\nAcceptance criteria: {task['acceptance_criteria']}")
    if test_results:
        parts.append(f"\nTest results (all passed): {test_results[:500]}")
    parts.append(
        "\nDocument this feature: take screenshots, describe the functionality, "
        "and update the documentation site. When done, call update_my_task with status='done'."
    )
    return "\n".join(parts)


# ── Registration ─────────────────────────────────────────────────────

def register_subscribers():
    """Wire up event handlers. Called from on_startup()."""
    bus.subscribe(CommanderEvent.TASK_STATUS_CHANGED, _on_task_status_changed)
    bus.subscribe(CommanderEvent.TEST_QUEUE_ENTRY_COMPLETED, _on_test_completed)
    logger.info("Pipeline subscribers registered")
