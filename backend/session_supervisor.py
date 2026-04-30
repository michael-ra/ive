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
_probe_task: Optional[asyncio.Task] = None
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


# ── DB access helpers ─────────────────────────────────────────────────────

async def _load_session_row(session_id: str) -> Optional[dict]:
    """Return the sessions row as a dict, or None if missing."""
    try:
        from db import get_db
        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT * FROM sessions WHERE id = ?", (session_id,)
            )
            row = await cur.fetchone()
            return dict(row) if row else None
        finally:
            await db.close()
    except Exception:
        logger.exception("supervisor: failed to load session row %s", session_id)
        return None


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
        # Successful liveness resets crash state — useful after a successful
        # restart so subsequent crashes get a fresh backoff cycle.
        if h.crashed_at is not None:
            h.crashed_at = None
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

    # ── Crash detected ───────────────────────────────────────────────
    h.crashed_at = now
    logger.warning(
        "supervisor: detected crash for session=%s (status=%s, auto_restart=%s)",
        session_id, status, auto_restart,
    )
    try:
        await bus.emit(
            CommanderEvent.SESSION_CRASHED,
            {
                "session_id": session_id,
                "workspace_id": h.workspace_id,
                "cli_type": h.cli_type,
                "last_seen": h.last_seen,
                "detected_at": now,
            },
            source="session_supervisor",
        )
    except Exception:
        logger.exception("supervisor: failed to emit SESSION_CRASHED")

    if auto_restart:
        # Schedule restart asynchronously so the probe loop keeps moving.
        asyncio.create_task(_auto_restart_with_backoff(session_id))


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

    if config.get("system_prompt"):
        session.append_system_prompt(config["system_prompt"])
    if config.get("native_session_id"):
        try:
            session.set(Feature.RESUME_ID, config["native_session_id"])
        except Exception:
            pass  # feature not supported by this CLI

    cmd = session.build_command()
    cmd_binary = cmd[0]
    cmd_args = cmd[1:]

    extra_env = {
        "COMMANDER_SESSION_ID": row["id"],
        "COMMANDER_WORKSPACE_ID": row.get("workspace_id") or "",
        "COMMANDER_CLI_TYPE": cli_type,
    }

    await _pty_manager.start_session(
        row["id"],
        row.get("workspace_path") or row.get("path") or ".",
        120, 40,
        cmd_args,
        extra_env,
        cmd_binary,
    )


async def _auto_restart_with_backoff(session_id: str) -> None:
    """Driver for the (5s, 15s, 45s) auto-restart cascade."""
    h = _health.get(session_id)
    if h is None:
        return

    for attempt_idx in range(RESTART_MAX_ATTEMPTS):
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
            return
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

        # Spawn fresh PTY.
        try:
            await _spawn_pty_from_row(row)
        except Exception as e:
            logger.exception("supervisor: spawn failed for %s", session_id)
            return {"ok": False, "error": str(e), "attempt": _attempt}

        # Update health snapshot optimistically.
        h = _health.get(session_id) or _Health(session_id=session_id)
        h.alive = True
        h.last_seen = time.time()
        h.crashed_at = None
        h.last_restart_at = time.time()
        h.last_restart_status = "ok"
        h.last_restart_error = None
        h.cli_type = row.get("cli_type")
        h.workspace_id = row.get("workspace_id")
        _health[session_id] = h

        return {"ok": True, "error": None, "attempt": _attempt}


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
