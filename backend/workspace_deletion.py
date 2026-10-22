"""Remove an IVE workspace registration without removing its repository.

PTY shutdown must happen outside a SQLite write transaction: exit callbacks
write to SQLite themselves. Reserve starts first, then recheck the complete
session/run set under the transaction before deleting any persisted data.
"""
import asyncio
import json


_locks: dict[str, asyncio.Lock] = {}

# These core tables intentionally have no workspace FK (for global records or
# historical compatibility). Keep cleanup explicit; never touch other scopes.
_WORKSPACE_DATA = (
    "command_log", "commander_events", "event_subscriptions",
    "external_access_log", "file_claims", "memory_entries", "workspace_memory",
    "observatory_findings", "observatory_insights", "observatory_profiles",
    "observatory_scans", "observatory_search_targets", "observatory_sources",
    "package_scans", "research_schedules", "safety_approval_grants",
    "safety_decisions", "safety_rules", "script_approvals", "secure_runs",
    "tool_invocation_log",
)
_SESSION_DATA = (
    "command_log", "commander_events", "external_access_log", "file_claims",
    "package_scans", "safety_approval_grants", "safety_decisions",
    "secure_decisions", "secure_findings", "secure_runs", "tool_invocation_log",
)


class WorkspaceDeleteBusy(RuntimeError):
    pass


async def _snapshot(db, workspace_id):
    sessions = {row[0] for row in await (await db.execute(
        "SELECT id FROM sessions WHERE workspace_id = ?", (workspace_id,),
    )).fetchall()}
    pipelines = {row[0] for row in await (await db.execute(
        "SELECT id FROM pipeline_runs WHERE workspace_id = ? AND status IN ('running', 'paused')",
        (workspace_id,),
    )).fetchall()}
    cascades = {row[0] for row in await (await db.execute(
        """SELECT c.id FROM cascade_runs c JOIN sessions s ON s.id = c.session_id
           WHERE s.workspace_id = ? AND c.status NOT IN ('completed', 'stopped', 'failed')""",
        (workspace_id,),
    )).fetchall()}
    return sessions, pipelines, cascades


async def _delete_scoped_data(db, workspace_id):
    tables = {row[0] for row in await (await db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
    )).fetchall()}
    for table in _SESSION_DATA:
        if table in tables:
            await db.execute(
                f'DELETE FROM "{table}" WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?)',
                (workspace_id,),
            )
    for table in _WORKSPACE_DATA:
        if table in tables:
            await db.execute(f'DELETE FROM "{table}" WHERE workspace_id = ?', (workspace_id,))
    # Do not leave an opt-out/settings record attached to a nonexistent project.
    prefix = f"workspace:{workspace_id}:"
    await db.execute("DELETE FROM app_settings WHERE substr(key, 1, length(?)) = ?", (prefix, prefix))
    # Existing foreign keys cascade messages, tasks, runs, guidelines and layout
    # rows, but SET NULL on separate workspaces inheriting this one's policy.
    await db.execute("DELETE FROM workspaces WHERE id = ?", (workspace_id,))


async def delete_registration(workspace_id, *, get_db, pty_manager,
                              stop_session, cancel_pipeline, stop_cascade,
                              clear_session):
    """Return deleted metadata, None for a missing row, or raise without deleting.

    Successful start reservations remain for this process lifetime to reject
    stale requests that prepared a CLI before the DB row disappeared. New
    registrations use fresh UUIDs. Failed deletion releases its reservations.
    """
    async with _locks.setdefault(workspace_id, asyncio.Lock()):
        blocked = set()
        committed = False
        db = await get_db()
        try:
            workspace = await (await db.execute(
                "SELECT id, name, path FROM workspaces WHERE id = ?", (workspace_id,),
            )).fetchone()
            if workspace is None:
                return None
            memory_row = await (await db.execute(
                "SELECT settings FROM workspace_memory WHERE workspace_id = ? AND scope = 'project'",
                (workspace_id,),
            )).fetchone()
            try:
                memory_enabled = bool(memory_row and json.loads(memory_row[0]).get("enabled") is True)
            except (ValueError, TypeError, AttributeError):
                memory_enabled = False
            for _ in range(8):
                sessions, pipelines, cascades = await _snapshot(db, workspace_id)
                for session_id in sessions:
                    pty_manager.block_session_start(session_id)
                    blocked.add(session_id)
                    clear_session(session_id)
                for run_id in pipelines:
                    await cancel_pipeline(run_id)
                for run_id in cascades:
                    await stop_cascade(run_id)
                # Stop every target, including a child whose parent is stopped
                # first. No database write lock is held across an exit callback.
                stopped = await asyncio.gather(
                    *(stop_session(sid) for sid in sessions), return_exceptions=True,
                )
                for result in stopped:
                    if isinstance(result, BaseException):
                        raise result
                if any(pty_manager.is_alive(sid) for sid in sessions):
                    raise WorkspaceDeleteBusy("A project session is still stopping. Please retry.")
                for session_id in sessions:
                    clear_session(session_id)  # Also discard idle timers from the exit.
                await db.execute("BEGIN IMMEDIATE")
                current, live_pipelines, live_cascades = await _snapshot(db, workspace_id)
                if not current.issubset(sessions) or live_pipelines or live_cascades:
                    await db.rollback()
                    continue
                await _delete_scoped_data(db, workspace_id)
                await db.commit()
                committed = True
                return {**dict(workspace), "session_ids": sorted(current),
                        "native_memory_enabled": memory_enabled}
            raise WorkspaceDeleteBusy("The project changed while closing. Please retry.")
        finally:
            await db.close()  # Rolls back any incomplete metadata cleanup.
            if not committed:
                for session_id in blocked:
                    pty_manager.unblock_session_start(session_id)
