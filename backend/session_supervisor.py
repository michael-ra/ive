"""Session Supervisor — health probing + crash detection + optional auto-restart.

The supervisor is the canonical answer to the question "is session X actually
alive?" — it owns a single asyncio task that polls every active PTY at a
configurable interval, reconciles the live state against the DB row, and
emits Commander events when something unexpected happens.

Design notes
------------
The supervisor is a strict observer of `pty_manager`; it never reaches inside
the PTY internals. It uses the public `is_alive()` / `start_session()` /
`stop_session()` API plus the session DB row as its evidence. Detection of a
crash vs. a clean exit is heuristic — we treat any session whose row was last
seen with `status = 'running'` and whose PTY just disappeared as a crash. If
the user cleanly stopped the session via the UI, `handle_pty_exit` flips the
row to `idle`/`exited` first, so the next probe sees a benign transition.

Race conditions handled
~~~~~~~~~~~~~~~~~~~~~~~
* **Probe vs. stop**: the probe loop honours `asyncio.CancelledError` and
  stops cleanly. No in-flight restart will be scheduled if cancelled.
* **Probe vs. manual restart**: `_get_lock(session_id)` serialises restart
  attempts, so two callers racing on the same session don't double-spawn.
* **Restart vs. lingering PTY**: before re-creating a PTY we wait (with
  timeout) for `is_alive()` to flip false so `pty_mgr.start_session` doesn't
  bail out with the "already has a running PTY" warning.
* **Backoff preservation**: backoff counters are in-memory only; if the
  supervisor itself is restarted, counters reset (acceptable per spec).

Settings
~~~~~~~~
Read from `app_settings` (same pattern as ``experimental.py``):

* ``supervisor_poll_interval_secs`` — polling cadence in seconds (default 5)
* ``session_auto_restart`` — ``"on"`` or ``"off"`` (default ``"off"``)

Public integration API (to be wired from server.py)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
* ``set_pty_manager(mgr)``  — wire the singleton (mirrors other modules)
* ``async start(app)``      — install on ``app.on_startup``
* ``async stop(app)``        — install on ``app.on_cleanup``
* ``async get_health(sid)`` — single-session health snapshot
* ``async list_health()``    — all known sessions
* ``async restart(sid)``     — force restart (returns dict result)
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field, asdict
from typing import Any, Optional

from commander_events import CommanderEvent
from event_bus import bus

logger = logging.getLogger(__name__)


# ── Configuration constants ──────────────────────────────────────────────

DEFAULT_POLL_INTERVAL_SECS = 5.0
DEFAULT_AUTO_RESTART = "off"
RESTART_BACKOFF_SECS = (5, 15, 45)        # max 3 attempts
RESTART_MAX_ATTEMPTS = len(RESTART_BACKOFF_SECS)
# A restarted CLI must stay up this long before its attempt budget resets.
# Without it a CLI that dies right after every successful restart would be
# restarted forever because each restart looks like a fresh first crash.
RESTART_STABLE_SECS = 60.0
PTY_DEATH_WAIT_TIMEOUT_SECS = 10.0        # how long we wait for old PTY to die
PTY_DEATH_WAIT_INTERVAL_SECS = 0.2

# Session statuses that mean "this session was supposed to be alive". If a
# session vanishes from pty_manager while its DB row is in one of these states,
# we treat it as a crash. Anything else (idle, exited, deleted) is benign.
_RUNNING_STATUSES = {"running", "working", "prompting"}


# ── Per-session in-memory health state ───────────────────────────────────

@dataclass
class _Health:
    session_id: str
    pid: Optional[int] = None
    alive: bool = False
    last_seen: float = 0.0          # last probe tick where alive==True
    last_probed: float = 0.0
    crashed_at: Optional[float] = None
    last_exit_code: Optional[int] = None
    restart_attempts: int = 0
    last_restart_at: Optional[float] = None
    last_restart_status: Optional[str] = None  # "ok" | "failed" | "skipped"
    last_restart_error: Optional[str] = None
    cli_type: Optional[str] = None
    workspace_id: Optional[str] = None

    def to_dict(self) -> dict:
        d = asdict(self)
        return d


# ── Module-level singletons (settable from server.py) ────────────────────

_pty_manager = None                                    # PTYManager instance
_health: dict[str, _Health] = {}                       # session_id → _Health
_locks: dict[str, asyncio.Lock] = {}                   # session_id → restart lock
_expected_exits: set[str] = set()                      # explicit stop/restart
_probe_task: Optional[asyncio.Task] = None
_restart_tasks: dict[str, asyncio.Task] = {}           # session_id → auto-restart driver
_running = False


def set_pty_manager(mgr) -> None:
    """Inject the PTYManager singleton (mirrors other backend modules)."""
    global _pty_manager
    _pty_manager = mgr


def _get_lock(session_id: str) -> asyncio.Lock:
    lock = _locks.get(session_id)
    if lock is None:
        lock = asyncio.Lock()
        _locks[session_id] = lock
    return lock


# ── Settings access (matches experimental.py / auth_cycler.py pattern) ───

async def _read_setting(key: str, default: str) -> str:
    """Read an app_settings row. Returns ``default`` if unset / on error."""
    try:
        from db import get_db
        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT value FROM app_settings WHERE key = ?", (key,)
            )
            row = await cur.fetchone()
            if row and row["value"] is not None:
                return str(row["value"])
        finally:
            await db.close()
    except Exception:
        logger.debug("supervisor: setting read failed for %s", key, exc_info=True)
    return default


async def _read_poll_interval() -> float:
    raw = await _read_setting(
        "supervisor_poll_interval_secs", str(DEFAULT_POLL_INTERVAL_SECS)
    )
    try:
        v = float(raw)
        # Clamp to a sane range — 1s lower bound prevents busy-loops; 600s
        # upper bound prevents the user from effectively disabling it.
        return max(1.0, min(v, 600.0))
    except (TypeError, ValueError):
        return DEFAULT_POLL_INTERVAL_SECS


async def _auto_restart_enabled() -> bool:
    val = await _read_setting("session_auto_restart", DEFAULT_AUTO_RESTART)
    return val.strip().lower() == "on"


def mark_started(session_id: str) -> None:
    """Record a confirmed PTY start so even a fast crash has a baseline."""
    now = time.time()
    h = _health.get(session_id) or _Health(session_id=session_id)
    h.alive = True
    h.last_seen = now
    h.last_probed = now
    h.crashed_at = None
    h.last_exit_code = None
    _health[session_id] = h
    _expected_exits.discard(session_id)


def exit_is_expected(session_id: str) -> bool:
    return session_id in _expected_exits


def expect_exit(session_id: str) -> None:
    """Mark a stop requested by IVE so its signal exit is not a crash."""
    if session_id:
        _expected_exits.add(session_id)


async def _record_crash(
    session_id: str,
    h: _Health,
    row: dict,
    now: float,
    auto_restart: bool,
) -> None:
    if h.crashed_at is not None:
        return
    h.crashed_at = now
    h.cli_type = row.get("cli_type")
    h.workspace_id = row.get("workspace_id")
    logger.warning(
        "supervisor: detected crash for session=%s (status=%s, exit=%s, auto_restart=%s)",
        session_id, row.get("status"), h.last_exit_code, auto_restart,
    )
    try:
        await bus.emit(
            CommanderEvent.SESSION_CRASHED,
            {
                "session_id": session_id,
                "workspace_id": h.workspace_id,
                "cli_type": h.cli_type,
                "exit_code": h.last_exit_code,
                "last_seen": h.last_seen,
                "detected_at": now,
            },
            source="session_supervisor",
        )
    except Exception:
        logger.exception("supervisor: failed to emit SESSION_CRASHED")

    if auto_restart:
        _schedule_auto_restart(session_id, h, now)


def _schedule_auto_restart(session_id: str, h: _Health, now: float) -> None:
    """Start the backoff driver once per session and keep a task reference."""
    existing = _restart_tasks.get(session_id)
    if existing is not None and not existing.done():
        return
    # Only a restart that stayed up for RESTART_STABLE_SECS earns a fresh
    # attempt budget; a crash right after a restart continues the cascade.
    if h.last_restart_at is None or now - h.last_restart_at >= RESTART_STABLE_SECS:
        h.restart_attempts = 0
    task = asyncio.create_task(
        _auto_restart_with_backoff(session_id),
        name=f"session_supervisor.restart:{session_id[:8]}",
    )
    _restart_tasks[session_id] = task
    task.add_done_callback(lambda t, sid=session_id: _restart_task_done(sid, t))


def _restart_task_done(session_id: str, task: asyncio.Task) -> None:
    if _restart_tasks.get(session_id) is task:
        _restart_tasks.pop(session_id, None)
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.error(
            "supervisor: auto-restart task for %s failed", session_id,
            exc_info=(type(exc), exc, exc.__traceback__),
        )


def _is_shell_row(row: Optional[dict]) -> bool:
    from shell_session import is_shell_session
    return is_shell_session(row)


async def record_exit(session_id: str, exit_code: int) -> str:
    """Classify a PTY callback as ``clean`` or ``crashed`` immediately."""
    now = time.time()
    expected = session_id in _expected_exits
    _expected_exits.discard(session_id)
    h = _health.get(session_id) or _Health(session_id=session_id)
    h.alive = False
    h.last_probed = now
    h.last_exit_code = exit_code
    _health[session_id] = h

    row = await _load_session_row(session_id)
    # A plain terminal ("shell") ends however the user's last command ended
    # (`exit 1`, Ctrl-D after a failure): that is not a crash and must never
    # trigger an auto-restart. It shows as Exited; restart = a new shell.
    if row is None or expected or exit_code == 0 or _is_shell_row(row):
        h.crashed_at = None
        return "clean"

    await _record_crash(
        session_id,
        h,
        row,
        now,
        await _auto_restart_enabled(),
    )
    return "crashed"


# ── DB access helpers ─────────────────────────────────────────────────────

async def _load_session_row(session_id: str) -> Optional[dict]:
    """Return the sessions row as a dict, or None if missing."""
    try:
        from db import get_db
        db = await get_db()
        try:
            cur = await db.execute(
                """SELECT s.*, w.path AS workspace_path,
                          w.sandbox_type, w.sandbox_network
                   FROM sessions s
                   LEFT JOIN workspaces w ON s.workspace_id = w.id
                   WHERE s.id = ?""",
                (session_id,),
            )
            row = await cur.fetchone()
            return dict(row) if row else None
        finally:
            await db.close()
    except Exception:
        logger.exception("supervisor: failed to load session row %s", session_id)
        return None


async def _write_restart_updates(session_id: str, updates: dict[str, Any]) -> None:
    allowed = {
        "account_id",
        "cli_type",
        "model",
        "permission_mode",
        "effort",
        "native_session_id",
        "native_slug",
        "system_prompt",
        "worktree",
    }
    unknown = set(updates) - allowed
    if unknown:
        raise ValueError(f"unsupported restart updates: {', '.join(sorted(unknown))}")
    if not updates:
        return
    from db import get_db
    db = await get_db()
    try:
        fields = ", ".join(f"{key} = ?" for key in updates)
        await db.execute(
            f"UPDATE sessions SET {fields} WHERE id = ?",
            [*updates.values(), session_id],
        )
        await db.commit()
    finally:
        await db.close()


# ── The probe loop ────────────────────────────────────────────────────────

async def _probe_once() -> None:
    """One full probe pass over all sessions tracked + currently active.

    The set of sessions to inspect is the union of:
      * sessions currently alive in pty_manager (so we discover new ones), and
      * sessions we have prior _Health entries for (so we notice dropouts).
    """
    if _pty_manager is None:
        return

    now = time.time()
    # pty_manager._sessions is private; use the public alive check and the
    # internal dict where available. Falling back to the public API keeps
    # us compatible if the internal name changes.
    try:
        active_ids = set(getattr(_pty_manager, "_sessions", {}).keys())
    except Exception:
        active_ids = set()

    candidate_ids = active_ids | set(_health.keys())

    auto_restart = await _auto_restart_enabled()

    for sid in candidate_ids:
        try:
            await _probe_session(sid, now, auto_restart)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("supervisor: probe error for %s", sid)


async def _probe_session(session_id: str, now: float, auto_restart: bool) -> None:
    is_alive = bool(_pty_manager and _pty_manager.is_alive(session_id))
    h = _health.get(session_id)

    if h is None:
        # First sighting — seed and move on. We can't say anything about
        # crash state until we have a baseline.
        h = _Health(session_id=session_id, alive=is_alive, last_probed=now)
        if is_alive:
            h.last_seen = now
        _health[session_id] = h
        return

    was_alive = h.alive
    h.alive = is_alive
    h.last_probed = now
    if is_alive:
        h.last_seen = now
        if h.crashed_at is not None:
            h.crashed_at = None
        # The attempt budget only resets once the process proved stable.
        if (h.restart_attempts and h.last_restart_at is not None
                and now - h.last_restart_at >= RESTART_STABLE_SECS):
            h.restart_attempts = 0
        return

    # Was alive last tick, not alive now → potential crash.
    if not was_alive:
        return  # already known dead, nothing to do

    # Transition alive → dead. Decide: clean or crash.
    row = await _load_session_row(session_id)
    if row is None:
        # Session was deleted from DB while we weren't looking — definitely
        # not a crash. Drop the health entry.
        _health.pop(session_id, None)
        _locks.pop(session_id, None)
        return

    status = (row.get("status") or "").lower()
    h.cli_type = row.get("cli_type")
    h.workspace_id = row.get("workspace_id")

    if status not in _RUNNING_STATUSES:
        # Clean exit — user/CLI marked it as no-longer-running before we
        # noticed the PTY was gone. Not a crash.
        return

    if _is_shell_row(row):
        return  # plain terminals never crash-restart (see record_exit)

    # ── Crash detected ───────────────────────────────────────────────
    await _record_crash(session_id, h, row, now, auto_restart)


# ── Restart machinery ─────────────────────────────────────────────────────

async def _wait_for_pty_death(session_id: str, timeout: float) -> bool:
    """Wait until pty_manager.is_alive(sid) is False or until timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not _pty_manager or not _pty_manager.is_alive(session_id):
            return True
        await asyncio.sleep(PTY_DEATH_WAIT_INTERVAL_SECS)
    return not (_pty_manager and _pty_manager.is_alive(session_id))


async def _spawn_pty_from_row(row: dict) -> None:
    """Re-spawn a PTY for the given session row using UnifiedSession.

    NOTE: this duplicates only the minimum command-build path. It does NOT
    rebuild guidelines / plugins / MCP / advisor injections — that complex
    pipeline lives in server.py at PTY-start time. Auto-restart from a
    crashed session is therefore best-effort: the agent comes back online
    in the same workspace with the same model/permission_mode/effort and a
    `--resume` if a native session ID is known, but transient context like
    runtime-attached MCP servers won't be re-applied.

    If a richer restart path is needed, refactor server.py's start_pty
    block into a helper and call it from here.
    """
    if _pty_manager is None:
        raise RuntimeError("pty_manager not wired")

    # Avoid heavy imports at module-load time; do them lazily here so that
    # the supervisor stays importable even if these modules change shape.
    from cli_session import UnifiedSession
    from cli_features import Feature

    cli_type = row.get("cli_type") or "claude"
    config = dict(row)
    session = UnifiedSession(cli_type, config)
    workspace_path = row.get("workspace_path") or row.get("path") or "."

    try:
        import server_runtime
        server_mod = server_runtime.module()
        _ensure_native_resume_files = getattr(server_mod, "_ensure_native_resume_files")
        _prepare_session_cli_env = getattr(server_mod, "_prepare_session_cli_env")
        _resolve_gemini_resume_index = getattr(server_mod, "_resolve_gemini_resume_index")
        extra_env = await _prepare_session_cli_env(config, row["id"])
    except Exception:
        logger.exception("supervisor: failed to prepare CLI env for %s", row["id"])
        extra_env = {}

    if config.get("system_prompt"):
        session.append_system_prompt(config["system_prompt"])
    if config.get("native_session_id"):
        try:
            native_sid = config["native_session_id"]
            if session.profile.id == "gemini":
                resume_arg = _resolve_gemini_resume_index(workspace_path, native_sid)
                if resume_arg:
                    session.set(Feature.RESUME_ID, resume_arg)
            else:
                _ensure_native_resume_files(session.profile.id, native_sid, workspace_path, extra_env)
                session.set(Feature.RESUME_ID, native_sid)
        except Exception:
            pass  # feature not supported by this CLI

    cmd = session.build_command()
    cmd_binary = cmd[0]
    cmd_args = cmd[1:]

    import session_proofs
    extra_env.update({
        "COMMANDER_SESSION_ID": row["id"],
        session_proofs.ENV_VAR: session_proofs.issue(row["id"]),
        "COMMANDER_WORKSPACE_ID": row.get("workspace_id") or "",
        "COMMANDER_CLI_TYPE": cli_type,
    })

    sandbox_type = "none"
    sandbox_network = True
    workspace_id = row.get("workspace_id")
    if workspace_id:
        try:
            from db import get_db
            db_ws = await get_db()
            try:
                cur_ws = await db_ws.execute(
                    "SELECT sandbox_type, sandbox_network FROM workspaces WHERE id = ?",
                    (workspace_id,)
                )
                ws_row = await cur_ws.fetchone()
                if ws_row:
                    sandbox_type = ws_row["sandbox_type"] or "none"
                    sandbox_network = bool(ws_row["sandbox_network"] if ws_row["sandbox_network"] is not None else 1)
            finally:
                await db_ws.close()
        except Exception:
            pass

    await _pty_manager.start_session(
        row["id"],
        workspace_path,
        row.get("_pty_cols", 120), row.get("_pty_rows", 40),
        cmd_args,
        extra_env,
        cmd_binary,
        sandbox_type=sandbox_type,
        sandbox_network=sandbox_network,
    )


async def _auto_restart_with_backoff(session_id: str) -> None:
    """Driver for the (5s, 15s, 45s) auto-restart cascade.

    Continues from ``h.restart_attempts`` so crashes shortly after a
    successful restart consume the same budget instead of starting over.
    """
    h = _health.get(session_id)
    if h is None:
        return

    for attempt_idx in range(h.restart_attempts, RESTART_MAX_ATTEMPTS):
        backoff = RESTART_BACKOFF_SECS[attempt_idx]
        try:
            await asyncio.sleep(backoff)
        except asyncio.CancelledError:
            return

        # If we've stopped, abort.
        if not _running:
            return

        # If the session came back to life (e.g. user manually restarted)
        # while we were sleeping, we're done.
        if _pty_manager and _pty_manager.is_alive(session_id):
            return

        attempt_no = attempt_idx + 1
        h.restart_attempts = attempt_no
        h.last_restart_at = time.time()
        result = await restart(session_id, _attempt=attempt_no, _from_supervisor=True)
        if result.get("ok"):
            h.last_restart_status = "ok"
            h.last_restart_error = None
            if not _pty_manager or _pty_manager.is_alive(session_id):
                return
            # It died again before this driver finished; that crash was not
            # rescheduled (a driver was still running), so keep going here.
            continue
        h.last_restart_status = "failed"
        h.last_restart_error = result.get("error") or "unknown"

    # Exhausted — emit final failure.
    try:
        await bus.emit(
            CommanderEvent.SESSION_RESTART_FAILED,
            {
                "session_id": session_id,
                "workspace_id": (h.workspace_id if h else None),
                "attempts": RESTART_MAX_ATTEMPTS,
                "last_error": (h.last_restart_error if h else None),
            },
            source="session_supervisor",
        )
    except Exception:
        logger.exception("supervisor: failed to emit SESSION_RESTART_FAILED")


# ── Public async API ─────────────────────────────────────────────────────

async def restart(
    session_id: str,
    *,
    updates: dict[str, Any] | None = None,
    expected: dict[str, Any] | None = None,
    _attempt: int = 1,
    _from_supervisor: bool = False,
) -> dict:
    """Force-restart a session. Safe to call manually or from auto-restart.

    Returns ``{"ok": bool, "error": Optional[str], "attempt": int}``.
    """
    if _pty_manager is None:
        return {"ok": False, "error": "pty_manager not wired", "attempt": _attempt}

    lock = _get_lock(session_id)
    async with lock:
        # Snapshot DB row first so even a fully-deleted session fails fast.
        row = await _load_session_row(session_id)
        if row is None:
            return {"ok": False, "error": "session not found in DB", "attempt": _attempt}
        changed = {
            key: {"expected": value, "actual": row.get(key)}
            for key, value in (expected or {}).items()
            if row.get(key) != value
        }
        if changed:
            return {
                "ok": False,
                "error": "session changed before restart",
                "attempt": _attempt,
                "changed": changed,
            }
        geometry_getter = getattr(_pty_manager, "get_geometry", None)
        restart_geometry = geometry_getter(session_id) if geometry_getter else None
        if restart_geometry:
            row["_pty_cols"] = restart_geometry.get("cols", 120)
            row["_pty_rows"] = restart_geometry.get("rows", 40)

        # Emit attempt event before doing anything expensive so observers
        # can see the cascade in real time.
        try:
            await bus.emit(
                CommanderEvent.SESSION_RESTART_ATTEMPTED,
                {
                    "session_id": session_id,
                    "workspace_id": row.get("workspace_id"),
                    "attempt": _attempt,
                    "source": "supervisor" if _from_supervisor else "manual",
                },
                source="session_supervisor",
            )
        except Exception:
            logger.exception("supervisor: failed to emit SESSION_RESTART_ATTEMPTED")

        # If still alive, kill first.
        if _pty_manager.is_alive(session_id):
            try:
                expect_exit(session_id)
                await _pty_manager.stop_session(session_id)
            except Exception as e:
                logger.warning("supervisor: stop_session failed for %s: %s", session_id, e)

            died = await _wait_for_pty_death(session_id, PTY_DEATH_WAIT_TIMEOUT_SECS)
            if not died:
                return {
                    "ok": False,
                    "error": "old PTY did not exit within timeout",
                    "attempt": _attempt,
                }

        original_values = {
            key: row.get(key) for key in (updates or {})
        }

        async def rollback_and_restart_original() -> tuple[bool, str | None]:
            if not updates:
                return False, None
            try:
                current_row = await _load_session_row(session_id)
                if current_row is None:
                    raise RuntimeError("session disappeared during restart rollback")
                if any(current_row.get(key) != value for key, value in original_values.items()):
                    await _write_restart_updates(session_id, original_values)
                    current_row = await _load_session_row(session_id)
                if current_row is None:
                    raise RuntimeError("session disappeared after restart rollback")
                if restart_geometry:
                    current_row["_pty_cols"] = restart_geometry.get("cols", 120)
                    current_row["_pty_rows"] = restart_geometry.get("rows", 40)
                await _spawn_pty_from_row(current_row)
                if not _pty_manager.is_alive(session_id):
                    raise RuntimeError("rollback PTY did not start")
                return True, None
            except Exception as rollback_exc:
                logger.exception("supervisor: rollback restart failed for %s", session_id)
                return False, str(rollback_exc)

        if updates:
            try:
                await _write_restart_updates(session_id, updates)
                row = await _load_session_row(session_id)
                if row is None:
                    raise RuntimeError("session disappeared while applying restart updates")
            except Exception as e:
                rollback_restarted, rollback_error = await rollback_and_restart_original()
                return {
                    "ok": False,
                    "error": str(e),
                    "attempt": _attempt,
                    "rolled_back": True,
                    "rollback_restarted": rollback_restarted,
                    "rollback_error": rollback_error,
                }

        # Spawn fresh PTY. The server-installed spawn hook reloads the DB row,
        # so updates are committed only after the old PTY is confirmed dead.
        if restart_geometry:
            row["_pty_cols"] = restart_geometry.get("cols", 120)
            row["_pty_rows"] = restart_geometry.get("rows", 40)
        try:
            await _spawn_pty_from_row(row)
            if not _pty_manager.is_alive(session_id):
                raise RuntimeError("replacement PTY did not start")
        except Exception as e:
            logger.exception("supervisor: spawn failed for %s", session_id)
            rollback_restarted, rollback_error = await rollback_and_restart_original()
            return {
                "ok": False,
                "error": str(e),
                "attempt": _attempt,
                "rolled_back": bool(updates),
                "rollback_restarted": rollback_restarted,
                "rollback_error": rollback_error,
            }

        # Update health snapshot optimistically.
        h = _health.get(session_id) or _Health(session_id=session_id)
        h.alive = True
        h.last_seen = time.time()
        h.crashed_at = None
        h.last_restart_at = time.time()
        h.last_restart_status = "ok"
        h.last_restart_error = None
        if not _from_supervisor:
            h.restart_attempts = 0  # a manual restart grants a fresh budget
        h.cli_type = row.get("cli_type")
        h.workspace_id = row.get("workspace_id")
        _health[session_id] = h

        return {
            "ok": True,
            "error": None,
            "attempt": _attempt,
            "applied_updates": dict(updates or {}),
        }


async def get_health(session_id: str) -> dict:
    """Return a health snapshot for a single session.

    Reflects the latest live state from `pty_manager` plus any historical
    crash/restart information the supervisor has tracked. Always returns a
    dict; missing sessions get a stub with ``known=False``.
    """
    h = _health.get(session_id)
    is_alive = bool(_pty_manager and _pty_manager.is_alive(session_id))
    if h is None:
        return {
            "session_id": session_id,
            "known": False,
            "alive": is_alive,
            "pid": None,
            "last_seen": None,
            "crashed_at": None,
            "restart_attempts": 0,
            "last_restart_at": None,
            "last_restart_status": None,
            "last_restart_error": None,
        }
    out = h.to_dict()
    out["known"] = True
    out["alive"] = is_alive  # always reflect live state, not the cached tick
    return out


async def list_health() -> list[dict]:
    """Return health snapshots for all known + currently-alive sessions."""
    if _pty_manager is None:
        return [h.to_dict() | {"known": True, "alive": False} for h in _health.values()]

    try:
        active_ids = set(getattr(_pty_manager, "_sessions", {}).keys())
    except Exception:
        active_ids = set()

    sids = active_ids | set(_health.keys())
    return [await get_health(sid) for sid in sorted(sids)]


# ── Lifecycle: start / stop ──────────────────────────────────────────────

async def _probe_loop() -> None:
    """Top-level coroutine for the supervisor's asyncio task."""
    logger.info("session_supervisor: probe loop started")
    try:
        while _running:
            interval = await _read_poll_interval()
            try:
                await _probe_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("supervisor: probe pass failed")
            try:
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                raise
    except asyncio.CancelledError:
        logger.info("session_supervisor: probe loop cancelled")
        raise
    finally:
        logger.info("session_supervisor: probe loop exited")


async def start(app=None) -> None:
    """Start the supervisor. Idempotent.

    Designed to be installed as ``app.on_startup.append(start)`` so the aiohttp
    Application contract (callable that takes the app) is satisfied — the app
    arg is unused but accepted for compatibility.
    """
    global _probe_task, _running
    if _running:
        return
    if _pty_manager is None:
        logger.warning(
            "session_supervisor: started without pty_manager wired — "
            "did you forget set_pty_manager()?"
        )
    _running = True
    _probe_task = asyncio.create_task(_probe_loop(), name="session_supervisor")


async def stop(app=None) -> None:
    """Stop the supervisor. Awaits in-flight probe to terminate cleanly."""
    global _probe_task, _running
    _running = False
    for restart_task in list(_restart_tasks.values()):
        restart_task.cancel()
    task = _probe_task
    _probe_task = None
    if task is None:
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception:
        logger.exception("supervisor: probe task raised on shutdown")
