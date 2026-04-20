"""Server-side cascade execution engine.

Drives cascade step advancement from the backend so cascades survive
browser disconnect.  The engine is a SQLite-backed state machine:

    running → waiting_idle → (idle detected) → advance → running | completed

State transitions are triggered by hook events (session going idle)
rather than polling, keeping the system event-driven.

Design note — background session foundation:
    This module is intentionally decoupled from the frontend.  It writes
    directly to PTYs via pty_manager and persists all state in SQLite.
    If we later want sessions to keep running on a headless server (no
    browser at all), this module works unchanged — only the "start" and
    "pause/resume" entry points need a REST or CLI wrapper (which we
    already provide below).
"""

import json
import logging
import uuid
from typing import Optional

from db import get_db

logger = logging.getLogger(__name__)

# Injected at startup by server.py — same pattern as hooks.py
_pty_manager = None
_broadcast = None

# In-memory idle advance debounce: session_id -> scheduled asyncio.TimerHandle
_advance_timers: dict[str, object] = {}

ADVANCE_DELAY_S = 1.5  # seconds after idle before advancing (debounce)


def set_pty_manager(mgr):
    global _pty_manager
    _pty_manager = mgr


def set_broadcast_fn(fn):
    global _broadcast
    _broadcast = fn


# ─── State machine ──────────────────────────────────────────────────


async def start_run(
    session_id: str,
    *,
    cascade_id: Optional[str] = None,
    steps: list[str],
    original_steps: Optional[list[str]] = None,
    loop: bool = False,
    auto_approve: bool = False,
    bypass_permissions: bool = False,
    auto_approve_plan: bool = False,
    variables: Optional[list[dict]] = None,
    variable_values: Optional[dict] = None,
    loop_reprompt: bool = False,
) -> dict:
    """Create a cascade run and send the first step to the PTY."""
    run_id = str(uuid.uuid4())

    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO cascade_runs
               (id, cascade_id, session_id, status, current_step, iteration,
                steps, original_steps, loop, auto_approve, bypass_permissions,
                auto_approve_plan, variables, variable_values, loop_reprompt)
               VALUES (?, ?, ?, 'running', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                run_id, cascade_id, session_id,
                json.dumps(steps),
                json.dumps(original_steps or steps),
                1 if loop else 0,
                1 if auto_approve else 0,
                1 if bypass_permissions else 0,
                1 if auto_approve_plan else 0,
                json.dumps(variables or []),
                json.dumps(variable_values or {}),
                1 if loop_reprompt else 0,
            ),
        )
        await db.commit()
    finally:
        await db.close()

    # Send the first step
    await _send_step(session_id, run_id, steps, 0)

    run = await get_run(run_id)
    await _broadcast_progress(run)
    return run


async def on_session_idle(session_id: str):
    """Called from hooks.py when a session becomes idle.

    Checks if there's an active cascade run for this session and
    schedules advancement after a debounce delay.
    """
    import asyncio

    # Cancel any pending advance timer for this session
    timer = _advance_timers.pop(session_id, None)
    if timer:
        timer.cancel()

    # Check for active run
    run = await _get_active_run(session_id)
    if not run:
        return

    if run["status"] not in ("running", "waiting_idle"):
        return

    # Schedule advance after debounce
    loop = asyncio.get_event_loop()
    timer = loop.call_later(
        ADVANCE_DELAY_S,
        lambda: asyncio.ensure_future(_advance(run["id"])),
    )
    _advance_timers[session_id] = timer


async def pause_run(run_id: str) -> Optional[dict]:
    """Pause an active cascade run."""
    db = await get_db()
    try:
        await db.execute(
            "UPDATE cascade_runs SET status = 'paused' WHERE id = ? AND status IN ('running', 'waiting_idle')",
            (run_id,),
        )
        await db.commit()
    finally:
        await db.close()
    run = await get_run(run_id)
    if run:
        # Cancel any pending advance timer
        timer = _advance_timers.pop(run["session_id"], None)
        if timer:
            timer.cancel()
        await _broadcast_progress(run)
    return run


async def resume_run(run_id: str) -> Optional[dict]:
    """Resume a paused cascade run — re-sends the current step."""
    run = await get_run(run_id)
    if not run or run["status"] != "paused":
        return run

    steps = json.loads(run["steps"])
    step_idx = run["current_step"]

    db = await get_db()
    try:
        await db.execute(
            "UPDATE cascade_runs SET status = 'running' WHERE id = ?",
            (run_id,),
        )
        await db.commit()
    finally:
        await db.close()

    await _send_step(run["session_id"], run_id, steps, step_idx)
    run = await get_run(run_id)
    await _broadcast_progress(run)
    return run


async def stop_run(run_id: str) -> Optional[dict]:
    """Stop a cascade run permanently."""
    run = await get_run(run_id)
    if not run:
        return None

    # Cancel any pending advance timer
    timer = _advance_timers.pop(run["session_id"], None)
    if timer:
        timer.cancel()

    db = await get_db()
    try:
        await db.execute(
            "UPDATE cascade_runs SET status = 'stopped', completed_at = datetime('now') WHERE id = ?",
            (run_id,),
        )
        await db.commit()
    finally:
        await db.close()

    run = await get_run(run_id)
    await _broadcast_progress(run)
    return run


async def resume_with_variables(run_id: str, variable_values: dict) -> Optional[dict]:
    """Resume a loop-reprompt cascade with new variable values.

    Re-substitutes the original steps with fresh values and restarts
    the step sequence.
    """
    run = await get_run(run_id)
    if not run or run["status"] != "paused":
        return run

    original_steps = json.loads(run["original_steps"] or "[]")
    resolved = [_substitute_variables(s, variable_values) for s in original_steps]

    db = await get_db()
    try:
        await db.execute(
            """UPDATE cascade_runs
               SET status = 'running', current_step = 0,
                   steps = ?, variable_values = ?,
                   iteration = iteration + 1
               WHERE id = ?""",
            (json.dumps(resolved), json.dumps(variable_values), run_id),
        )
        await db.commit()
    finally:
        await db.close()

    await _send_step(run["session_id"], run_id, resolved, 0)
    run = await get_run(run_id)
    await _broadcast_progress(run)
    return run


# ─── Internal helpers ────────────────────────────────────────────────


async def _advance(run_id: str):
    """Advance a cascade run to the next step.

    Called after the idle debounce fires.
    """
    run = await get_run(run_id)
    if not run or run["status"] not in ("running", "waiting_idle"):
        return

    steps = json.loads(run["steps"])
    next_step = run["current_step"] + 1
    next_iteration = run["iteration"]

    if next_step >= len(steps):
        if run["loop"]:
            # Loop: check if reprompt needed
            if run["loop_reprompt"]:
                variables = json.loads(run["variables"] or "[]")
                if variables:
                    # Pause for variable re-input — frontend will call resume_with_variables
                    db = await get_db()
                    try:
                        await db.execute(
                            "UPDATE cascade_runs SET status = 'paused', iteration = iteration + 1 WHERE id = ?",
                            (run_id,),
                        )
                        await db.commit()
                    finally:
                        await db.close()
                    run = await get_run(run_id)
                    await _broadcast_progress(run, event="cascade_loop_reprompt")
                    return

            # Loop without reprompt — restart from step 0
            next_step = 0
            next_iteration += 1
        else:
            # Cascade completed
            db = await get_db()
            try:
                await db.execute(
                    "UPDATE cascade_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?",
                    (run_id,),
                )
                await db.commit()
            finally:
                await db.close()
            run = await get_run(run_id)
            await _broadcast_progress(run, event="cascade_completed")
            logger.info("Cascade run %s completed (%d steps)", run_id[:8], len(steps))
            return

    # Advance to next step
    db = await get_db()
    try:
        await db.execute(
            "UPDATE cascade_runs SET current_step = ?, iteration = ?, status = 'running' WHERE id = ?",
            (next_step, next_iteration, run_id),
        )
        await db.commit()
    finally:
        await db.close()

    await _send_step(run["session_id"], run_id, steps, next_step)
    run = await get_run(run_id)
    await _broadcast_progress(run)


async def _send_step(session_id: str, run_id: str, steps: list[str], step_idx: int):
    """Write a cascade step to the session's PTY."""
    if not _pty_manager:
        logger.error("cascade_runner: pty_manager not set")
        return

    if step_idx >= len(steps):
        return

    prompt = steps[step_idx]
    if not prompt:
        return

    # Write the prompt + Enter to the PTY
    data = (prompt + "\n").encode("utf-8")

    if not _pty_manager.is_alive(session_id):
        logger.warning("cascade_runner: session %s PTY not alive, marking run failed", session_id[:8])
        db = await get_db()
        try:
            await db.execute(
                "UPDATE cascade_runs SET status = 'failed', error = 'PTY not alive', completed_at = datetime('now') WHERE id = ?",
                (run_id,),
            )
            await db.commit()
        finally:
            await db.close()
        return

    _pty_manager.write(session_id, data)
    logger.info(
        "Cascade %s: sent step %d/%d to session %s",
        run_id[:8], step_idx + 1, len(steps), session_id[:8],
    )

    # Update status to waiting_idle
    db = await get_db()
    try:
        await db.execute(
            "UPDATE cascade_runs SET status = 'waiting_idle' WHERE id = ?",
            (run_id,),
        )
        await db.commit()
    finally:
        await db.close()


def _substitute_variables(template: str, values: dict) -> str:
    """Replace {variable_name} placeholders with values."""
    import re
    def replacer(m):
        key = m.group(1)
        return values.get(key, m.group(0))
    return re.sub(r'\{([a-zA-Z_]\w*)\}', replacer, template)


# ─── Query helpers ──────────────────────────────────────────────────


async def get_run(run_id: str) -> Optional[dict]:
    """Fetch a single cascade run by ID."""
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM cascade_runs WHERE id = ?", (run_id,))
        row = await cur.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()


async def _get_active_run(session_id: str) -> Optional[dict]:
    """Fetch the active cascade run for a session (if any)."""
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT * FROM cascade_runs WHERE session_id = ? AND status IN ('running', 'waiting_idle') LIMIT 1",
            (session_id,),
        )
        row = await cur.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()


async def list_runs(session_id: Optional[str] = None, active_only: bool = False) -> list[dict]:
    """List cascade runs, optionally filtered."""
    sql = "SELECT * FROM cascade_runs WHERE 1=1"
    params: list = []
    if session_id:
        sql += " AND session_id = ?"
        params.append(session_id)
    if active_only:
        sql += " AND status IN ('running', 'waiting_idle', 'paused')"
    sql += " ORDER BY started_at DESC LIMIT 50"

    db = await get_db()
    try:
        cur = await db.execute(sql, params)
        rows = await cur.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


# ─── WebSocket broadcast ────────────────────────────────────────────


async def _broadcast_progress(run: Optional[dict], event: str = "cascade_progress"):
    """Broadcast cascade run progress to connected clients."""
    if not run or not _broadcast:
        return

    steps = json.loads(run["steps"])
    await _broadcast({
        "type": event,
        "run_id": run["id"],
        "cascade_id": run.get("cascade_id"),
        "session_id": run["session_id"],
        "status": run["status"],
        "current_step": run["current_step"],
        "total_steps": len(steps),
        "iteration": run["iteration"],
        "loop": bool(run["loop"]),
        "loop_reprompt": bool(run.get("loop_reprompt")),
        "variables": json.loads(run.get("variables") or "[]"),
        "variable_values": json.loads(run.get("variable_values") or "{}"),
        "error": run.get("error"),
        "started_at": run.get("started_at"),
        "completed_at": run.get("completed_at"),
    })


# ─── Server startup recovery ────────────────────────────────────────


async def recover_active_runs():
    """On server restart, mark interrupted runs so they can be resumed.

    Runs that were 'running' or 'waiting_idle' when the server died are
    set to 'paused' — the user can resume them via the API. We don't
    auto-resume because the PTY may not have restarted yet.
    """
    db = await get_db()
    try:
        cur = await db.execute(
            "UPDATE cascade_runs SET status = 'paused' WHERE status IN ('running', 'waiting_idle')"
        )
        if cur.rowcount > 0:
            logger.info("Recovered %d interrupted cascade runs (set to paused)", cur.rowcount)
        await db.commit()
    finally:
        await db.close()
