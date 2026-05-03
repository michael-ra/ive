"""Board-doc backstop sweeper.

Hourly background task that catches worker/planner sessions that exited or
went idle without calling document_to_board themselves. Two-hour idle threshold
prevents racing with the agent's own reflection (which fires within 5 min of
idle).

Modes (workspace.board_doc_mode):
  off                — sweeper skips the workspace entirely.
  agent_only         — sweeper skips; only the agent can document.
  agent_with_backstop — sweeper runs (default).

Behaviour per session:
  - Has a digest with artifacts AND an active/task ticket → PUT ticket to
    workspace.board_doc_existing_column (default 'review') + mark updated.
  - Has artifacts but no ticket → POST a new [auto-triage] ticket in backlog
    + mark created.
  - No artifacts → mark skipped (board_action='skipped', no ticket touched).
"""
from __future__ import annotations

import asyncio
import logging

from db import get_db

logger = logging.getLogger(__name__)

SWEEP_INTERVAL = 3600        # seconds between sweeps
STARTUP_DELAY  = 180         # seconds after server start before first sweep
IDLE_THRESHOLD = "'-2 hours'"  # SQL: sessions idle for at least this long

_broadcast_fn = None
_task: asyncio.Task | None = None
_running = False


def set_broadcast_fn(fn) -> None:
    global _broadcast_fn
    _broadcast_fn = fn


async def start(app=None) -> None:
    global _task, _running
    if _running:
        return
    _running = True
    _task = asyncio.create_task(_loop())
    logger.info("Board-doc backstop sweeper started")


async def stop(app=None) -> None:
    global _running, _task
    _running = False
    if _task:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
    logger.info("Board-doc backstop sweeper stopped")


async def _loop() -> None:
    await asyncio.sleep(STARTUP_DELAY)
    while _running:
        try:
            await _check_and_run()
        except Exception:
            logger.exception("Board-doc backstop sweep failed")
        await asyncio.sleep(SWEEP_INTERVAL)


async def _check_and_run() -> None:
    db = await get_db()
    try:
        ws_cur = await db.execute(
            "SELECT id, board_doc_mode, board_doc_new_column, board_doc_existing_column "
            "FROM workspaces WHERE board_doc_mode = 'agent_with_backstop'"
        )
        workspaces = [dict(r) for r in await ws_cur.fetchall()]
    finally:
        await db.close()

    for ws in workspaces:
        try:
            await _sweep_workspace(ws)
        except Exception:
            logger.exception("Backstop sweep failed for workspace %s", ws["id"][:8])


async def _sweep_workspace(ws: dict) -> None:
    ws_id = ws["id"]
    existing_col = ws["board_doc_existing_column"] or "review"
    new_col = ws["board_doc_new_column"] or "review"

    db = await get_db()
    try:
        sess_cur = await db.execute(
            f"""SELECT s.id, s.name, s.task_id, s.active_ticket_id, s.session_type,
                       sd.discoveries, sd.decisions, sd.files_touched
                FROM sessions s
                LEFT JOIN session_digests sd ON sd.session_id = s.id
                WHERE s.workspace_id = ?
                  AND s.last_active_at < datetime('now', {IDLE_THRESHOLD})
                  AND s.board_action IS NULL
                  AND s.session_type IN ('worker', 'planner')""",
            (ws_id,),
        )
        sessions = [dict(r) for r in await sess_cur.fetchall()]
    finally:
        await db.close()

    for s in sessions:
        try:
            await _process_session(s, ws_id, existing_col, new_col)
        except Exception:
            logger.exception("Backstop: failed to process session %s", s["id"][:8])


def _has_artifacts(s: dict) -> bool:
    def _nonempty(v):
        if not v:
            return False
        import json as _j
        try:
            parsed = _j.loads(v)
            return bool(parsed)  # non-empty list/dict
        except Exception:
            return bool(v.strip())
    return _nonempty(s.get("discoveries")) or _nonempty(s.get("decisions")) or _nonempty(s.get("files_touched"))


async def _mark_board_action(
    session_id: str,
    action: str,
    note: str,
    task_id: str | None = None,
    active_ticket_id: str | None = None,
) -> None:
    db = await get_db()
    try:
        updates: dict = {"board_action": action, "board_action_note": note}
        if task_id is not None:
            updates["task_id"] = task_id
        if active_ticket_id is not None:
            updates["active_ticket_id"] = active_ticket_id

        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [session_id]
        await db.execute(
            f"UPDATE sessions SET {set_clause} WHERE id = ?", values
        )
        await db.commit()
    finally:
        await db.close()


async def _append_task_result(task_id: str, note: str, status: str) -> bool:
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT result_summary FROM tasks WHERE id = ?", (task_id,)
        )
        row = await cur.fetchone()
        if not row:
            return False
        existing = row["result_summary"] or ""
        separator = "\n\n---\n" if existing else ""
        new_summary = existing + separator + note
        await db.execute(
            "UPDATE tasks SET status = ?, result_summary = ? WHERE id = ?",
            (status, new_summary, task_id),
        )
        await db.commit()
        return True
    finally:
        await db.close()


async def _create_task(ws_id: str, session_id: str, name: str,
                        digest_text: str) -> str | None:
    import uuid as _uuid
    task_id = str(_uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO tasks
               (id, workspace_id, title, description, status, labels,
                assigned_session_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))""",
            (
                task_id, ws_id,
                f"[auto-triage] {name}",
                digest_text,
                "backlog",
                "auto-triage",
                session_id,
            ),
        )
        await db.commit()
        return task_id
    except Exception:
        logger.exception("Backstop: failed to create task for session %s", session_id[:8])
        return None
    finally:
        await db.close()


def _digest_summary(s: dict) -> str:
    parts = []
    if s.get("discoveries"):
        parts.append(f"Discoveries: {s['discoveries']}")
    if s.get("decisions"):
        parts.append(f"Decisions: {s['decisions']}")
    if s.get("files_touched"):
        parts.append(f"Files touched: {s['files_touched']}")
    return "\n".join(parts) if parts else "(no digest available)"


async def _process_session(s: dict, ws_id: str, existing_col: str, new_col: str) -> None:
    sid = s["id"]

    if not _has_artifacts(s):
        await _mark_board_action(sid, "skipped", "backstop: no artifacts")
        logger.debug("Backstop: skipped session %s (no artifacts)", sid[:8])
        return

    target = s.get("active_ticket_id") or s.get("task_id")
    digest_text = _digest_summary(s)

    if target:
        ok = await _append_task_result(
            target,
            f"[auto-documented by backstop]\n{digest_text}",
            existing_col,
        )
        if ok:
            await _mark_board_action(sid, "updated", "backstop")
            logger.info("Backstop: updated ticket %s for session %s", target[:8], sid[:8])
        else:
            target = None

    if not target:
        task_id = await _create_task(ws_id, sid, s.get("name", sid[:8]), digest_text)
        if task_id:
            await _mark_board_action(sid, "created", "backstop",
                                     task_id=task_id, active_ticket_id=task_id)
            logger.info("Backstop: created [auto-triage] ticket %s for session %s",
                        task_id[:8], sid[:8])

    if _broadcast_fn:
        try:
            await _broadcast_fn({"type": "board_doc_backstop_ran", "session_id": sid})
        except Exception:
            pass
