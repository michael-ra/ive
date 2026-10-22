"""Configurable Pipeline Engine — visual graph-based agent orchestration.

Users design pipeline graphs in a node editor: stages (agent work, conditions,
fan-out) connected by transitions (always, on_pass, on_fail, on_match).
Pipelines can be triggered by Feature Board column moves, schedules, webhooks,
or manual activation.

Wired into the system via:
- hooks.py on_session_idle → pipeline_engine.on_session_idle()
- event_bus subscription → trigger evaluation
- server.py REST routes → CRUD + run control

The engine is event-driven (no polling): stages send prompts to PTY sessions,
then wait for session_idle hooks to advance.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
import time
import uuid
import weakref
from pathlib import Path
from typing import Optional

from commander_events import CommanderEvent
from cli_profiles import active_profiles, get_profile, is_active_cli
from db import get_db
from event_bus import bus
from subprocess_control import terminate_process_group

logger = logging.getLogger(__name__)


def _brain_capability_resync_on() -> bool:
    return False


async def _brain_emit_pipeline_capability(db, pid: str) -> None:
    return None


from extension_host import available as _extension_available, load_legacy_fragment
if _extension_available("company"):
    load_legacy_fragment(globals(), "company", "backend/pipeline_capabilities.py")

_pty_manager = None
_broadcast_fn = None
_pty_start_fn = None  # async (session_id) → None; injected from server.py to start PTYs for auto-created sessions (BUG H6)
_input_ready_fn = None  # async (session_id, cli_type, timeout) → bool
_output_buffer_fn = None  # (session_id, lines) → str; clean recent terminal text

# In-memory tracking for fast lookup — guarded by _state_lock
_session_to_run: dict[str, str] = {}        # session_id → run_id
_active_runs: dict[str, dict] = {}           # run_id → cached run state
_advance_timers: dict[str, object] = {}      # session_id → TimerHandle
_trigger_cooldowns: dict[str, float] = {}    # pipeline_id → last trigger time
_state_lock = asyncio.Lock()                 # protects all dicts above
_task_execution_lock = asyncio.Lock()       # serialize task-run creation, not agent work
_advance_locks = weakref.WeakValueDictionary()
_stage_jobs: dict[tuple[str, str], asyncio.Task] = {}

ADVANCE_DELAY_S = 1.5
DEFAULT_MAX_ITERATIONS = 20


class PipelineVariableError(ValueError):
    """Raised when a pipeline run references unknown {variable} placeholders."""

    def __init__(self, missing: list[str]):
        self.missing = missing
        super().__init__(f"unknown variables: {', '.join(missing)}")


class TaskAssigneeReuseError(ValueError):
    """The task's existing worker is no longer safe to reuse implicitly."""


# Sensible defaults per session_type — used when stage has no explicit agent_config
SESSION_TYPE_DEFAULTS = {
    "worker":     {"model": "sonnet",  "permission_mode": "auto"},
    "planner":    {"model": "opus",    "permission_mode": "plan"},
    "tester":     {"model": "sonnet",  "permission_mode": "auto"},
    "commander":  {"model": "opus",    "permission_mode": "plan"},
    "documentor": {"model": "sonnet",  "permission_mode": "auto"},
}


def _fallback_cli_type(cli_type: str | None) -> str:
    if cli_type and is_active_cli(cli_type):
        return cli_type
    if is_active_cli("claude"):
        return "claude"
    profiles = active_profiles()
    return profiles[0].id if profiles else "claude"


def _role_default_model(profile, session_type: str | None) -> str:
    role = session_type or "worker"
    if role in {"commander", "planner", "brainstormer"} and profile.default_commander_model:
        return profile.default_commander_model
    if role in {"tester", "test_worker", "documentor"} and profile.default_tester_model:
        return profile.default_tester_model
    return profile.default_model


def _capability_tag_for_session_type(session_type: str | None) -> str | None:
    if session_type in {"tester", "test_worker"}:
        return "capability_testing"
    if session_type == "documentor":
        return "capability_documentation"
    return None


def _storage_session_type(session_type: str | None) -> str | None:
    return "worker" if session_type in {"tester", "documentor"} else session_type


def _parse_session_tags(raw_tags) -> list[str]:
    if isinstance(raw_tags, list):
        return [str(t) for t in raw_tags]
    if isinstance(raw_tags, str) and raw_tags:
        try:
            parsed = json.loads(raw_tags)
            if isinstance(parsed, list):
                return [str(t) for t in parsed]
        except Exception:
            return []
    return []


async def _add_session_tags(db, session_id: str, extra_tags: list[str]) -> None:
    if not extra_tags:
        return
    cur = await db.execute("SELECT tags FROM sessions WHERE id = ?", (session_id,))
    row = await cur.fetchone()
    if not row:
        return
    tags = _parse_session_tags(row["tags"])
    changed = False
    for tag in extra_tags:
        if tag not in tags:
            tags.append(tag)
            changed = True
    if changed:
        await db.execute("UPDATE sessions SET tags = ? WHERE id = ?", (json.dumps(tags), session_id))


def _valid_profile_value(options: list, value: str | None, allow_empty: bool = True) -> bool:
    if value in (None, ""):
        return allow_empty
    ids = {str(item.get("id")) for item in options if isinstance(item, dict) and "id" in item}
    return not ids or str(value) in ids

# Track task_ids currently being handled by a pipeline run so auto_exec can skip
_pipeline_task_ids: set[str] = set()


def set_pty_manager(mgr):
    global _pty_manager
    _pty_manager = mgr


def set_broadcast_fn(fn):
    global _broadcast_fn
    _broadcast_fn = fn


def set_pty_start_fn(fn):
    """Inject server.py's _autostart_session_pty so the engine can boot PTYs
    for sessions it auto-creates without forcing a circular import."""
    global _pty_start_fn
    _pty_start_fn = fn


def set_input_ready_fn(fn):
    """Inject the same CLI readiness check used by Overview input delivery."""
    global _input_ready_fn
    _input_ready_fn = fn


def set_output_buffer_fn(fn):
    """Inject the output capture buffer reader (OutputCaptureProcessor.get_buffer)."""
    global _output_buffer_fn
    _output_buffer_fn = fn


# ── CRUD for Pipeline Definitions ───────────────────────────────────


async def create_definition(data: dict) -> dict:
    pid = str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO pipeline_definitions
               (id, name, description, workspace_id, stages, transitions,
                triggers, preset, preset_key, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                pid,
                data.get("name", "Untitled Pipeline"),
                data.get("description", ""),
                data.get("workspace_id"),
                json.dumps(data.get("stages") if isinstance(data.get("stages"), list) else []),
                json.dumps(data.get("transitions") if isinstance(data.get("transitions"), list) else []),
                json.dumps(data.get("triggers") if isinstance(data.get("triggers"), list) else []),
                1 if data.get("preset") else 0,
                data.get("preset_key"),
                data.get("status", "draft"),
            ),
        )
        await db.commit()
        return await _fetch_definition(db, pid)
    finally:
        await db.close()






async def update_definition(pid: str, data: dict) -> Optional[dict]:
    db = await get_db()
    try:
        cur = await db.execute("SELECT id FROM pipeline_definitions WHERE id = ?", (pid,))
        if not await cur.fetchone():
            return None
        fields, values = [], []
        allowed = ("name", "description", "workspace_id", "status")
        for key in allowed:
            if key in data:
                fields.append(f"{key} = ?")
                values.append(data[key])
        for key in ("stages", "transitions", "triggers"):
            if key in data:
                fields.append(f"{key} = ?")
                values.append(json.dumps(data[key]))
        if not fields:
            return await _fetch_definition(db, pid)
        fields.append("updated_at = datetime('now')")
        values.append(pid)
        await db.execute(
            f"UPDATE pipeline_definitions SET {', '.join(fields)} WHERE id = ?",
            values,
        )
        await db.commit()
        # An installed publication consumer may observe this completed update.
        # The ordinary local pipeline remains independent of that consumer.
        if data.get("status") == "published":
            await _brain_emit_pipeline_capability(db, pid)
        return await _fetch_definition(db, pid)
    finally:
        await db.close()


async def delete_definition(pid: str) -> bool:
    db = await get_db()
    try:
        cur = await db.execute("DELETE FROM pipeline_definitions WHERE id = ?", (pid,))
        await db.commit()
        return cur.rowcount > 0
    finally:
        await db.close()


async def get_definition(pid: str) -> Optional[dict]:
    db = await get_db()
    try:
        return await _fetch_definition(db, pid)
    finally:
        await db.close()


async def list_definitions(workspace_id: str = None) -> list[dict]:
    db = await get_db()
    try:
        if workspace_id:
            cur = await db.execute(
                """SELECT * FROM pipeline_definitions
                   WHERE workspace_id = ? OR workspace_id IS NULL
                   ORDER BY preset DESC, name""",
                (workspace_id,),
            )
        else:
            cur = await db.execute(
                "SELECT * FROM pipeline_definitions ORDER BY preset DESC, name"
            )
        rows = await cur.fetchall()
        return [_deserialize_definition(dict(r)) for r in rows]
    finally:
        await db.close()


async def _fetch_definition(db, pid: str) -> Optional[dict]:
    cur = await db.execute("SELECT * FROM pipeline_definitions WHERE id = ?", (pid,))
    row = await cur.fetchone()
    return _deserialize_definition(dict(row)) if row else None


def _deserialize_definition(d: dict) -> dict:
    for key in ("stages", "transitions", "triggers"):
        if isinstance(d.get(key), str):
            try:
                d[key] = json.loads(d[key])
            except (json.JSONDecodeError, TypeError):
                d[key] = []
    return d


# ── Task Variable Injection ─────────────────────────────────────────


async def _build_task_variables(task_id: str) -> dict:
    """Fetch full task data and return a variable dict for prompt templates."""
    if not task_id:
        return {}
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        row = await cur.fetchone()
        if not row:
            return {"task_id": task_id}
        task = dict(row)
    finally:
        await db.close()

    title = task.get("title", "")
    desc = task.get("description", "")
    criteria = task.get("acceptance_criteria", "")

    variables = {
        "task_id": task_id,
        "task_title": title,
        "task_description": desc,
        "task_criteria": criteria,
        "task_labels": task.get("labels", ""),
        "task_priority": str(task.get("priority", "")),
        "task_status": task.get("status", ""),
        # {topic} = combined title + description — so presets Just Work
        "topic": f"{title}\n{desc}".strip() if desc else title,
    }
    return variables


# ── Pipeline Run Management ─────────────────────────────────────────


async def start_run(
    pipeline_id: str,
    *,
    workspace_id: str = None,
    task_id: str = None,
    variables: dict = None,
    trigger_type: str = "manual",
    max_iterations: int | None = None,
) -> Optional[dict]:
    """Start a new pipeline run. Returns the run dict or None on error."""
    defn = await get_definition(pipeline_id)
    if not defn:
        logger.error("Pipeline definition %s not found", pipeline_id)
        return None

    ws_id = workspace_id or defn.get("workspace_id")
    if not ws_id:
        logger.error("No workspace_id for pipeline run")
        return None

    # Auto-populate variables from task data; user-provided values override
    task_vars = await _build_task_variables(task_id)
    # Empty optional fields are valid bindings, not unknown variables. Keep
    # task defaults when an empty override is supplied and preserve 0/False.
    merged_vars = {key: ("" if value is None else value) for key, value in task_vars.items()}
    for key, value in (variables or {}).items():
        if value in (None, "") and task_vars.get(key):
            continue
        merged_vars[key] = "" if value is None else value

    stages = defn.get("stages", [])
    transitions = defn.get("transitions", [])
    _validate_runnable_definition(stages, transitions)

    # BUG M10: validate that every {var} in stage prompts has a binding,
    # otherwise the literal "{var}" reaches the agent and looks like a typo.
    referenced = _collect_referenced_variables(stages)
    missing = sorted(v for v in referenced if v not in merged_vars)
    if missing:
        raise PipelineVariableError(missing)

    run_id = str(uuid.uuid4())

    # Find entry stages (no incoming transitions)
    target_ids = {t["target"] for t in transitions}
    entry_stages = [s for s in stages if s["id"] not in target_ids]
    if not entry_stages:
        entry_stages = stages[:1]  # fallback to first

    # Initialize stage history
    stage_history = {}
    for s in stages:
        stage_history[s["id"]] = {
            "status": "pending",
            "started_at": None,
            "completed_at": None,
            "session_id": None,
            "output_summary": None,
        }

    # Claim the task BEFORE the DB commit so any concurrent auto_exec
    # dispatch sees the pipeline ownership immediately. If the commit
    # fails we discard the claim — better to drop a transient claim than
    # leave the DB committed without the in-memory marker (which would
    # let auto_exec double-dispatch).
    if task_id:
        async with _state_lock:
            _pipeline_task_ids.add(task_id)

    db = await get_db()
    try:
        try:
            await db.execute(
                """INSERT INTO pipeline_runs
                   (id, pipeline_id, workspace_id, task_id, status,
                    current_stages, iteration, max_iterations,
                    variables, stage_history, trigger_type)
                   VALUES (?, ?, ?, ?, 'running', ?, 1, ?, ?, ?, ?)""",
                (
                    run_id, pipeline_id, ws_id, task_id,
                    json.dumps([s["id"] for s in entry_stages]),
                    max_iterations or DEFAULT_MAX_ITERATIONS,
                    json.dumps(merged_vars),
                    json.dumps(stage_history),
                    trigger_type,
                ),
            )
            await db.commit()
        except Exception:
            # Roll back the in-memory claim if persistence failed.
            if task_id:
                async with _state_lock:
                    _pipeline_task_ids.discard(task_id)
            raise
    finally:
        await db.close()

    run = await get_run(run_id)
    async with _state_lock:
        _active_runs[run_id] = run

    await bus.emit(CommanderEvent.PIPELINE_STARTED, {
        "pipeline_id": pipeline_id,
        "run_id": run_id,
        "workspace_id": ws_id,
        "task_id": task_id,
        "pipeline_name": defn.get("name"),
        "trigger_type": trigger_type,
    }, source="pipeline_engine")

    await _broadcast_run(run)

    # Execute entry stages
    for stage in entry_stages:
        _schedule_stage(run_id, stage["id"])

    return run


async def pause_run(run_id: str) -> Optional[dict]:
    # BUG M11: previously this UPDATE silently no-op'd on terminal-state
    # runs and the caller still got 200 with the stale row, so they
    # couldn't tell "paused" from "ignored because already failed". Reject
    # explicitly when the run is not running.
    run = await get_run(run_id)
    if not run:
        return None
    if run["status"] != "running":
        return {"_pause_no_op": True, **run}
    db = await get_db()
    try:
        await db.execute(
            "UPDATE pipeline_runs SET status = 'paused', updated_at = datetime('now') WHERE id = ? AND status = 'running'",
            (run_id,),
        )
        await db.commit()
    finally:
        await db.close()
    run = await get_run(run_id)
    if run:
        async with _state_lock:
            _active_runs.pop(run_id, None)
        await _broadcast_run(run)
    return run


async def resume_run(run_id: str) -> Optional[dict]:
    run = await get_run(run_id)
    if not run:
        return None
    status = run["status"]
    if status != "paused":
        # BUG M11: signal "ignored, was not paused" via sentinel so the
        # REST handler can return 409 instead of 200 with stale state.
        # Terminal states (cancelled/completed/failed) are an even harder
        # rejection — a finished run cannot be brought back to life.
        # We still use the same sentinel for backwards compatibility with
        # the REST handler that pops _resume_no_op.
        return {"_resume_no_op": True, **run}
    db = await get_db()
    try:
        changed = await db.execute(
            "UPDATE pipeline_runs SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status = 'paused'",
            (run_id,),
        )
        await db.commit()
        if not changed.rowcount:
            return {"_resume_no_op": True, **(await get_run(run_id) or run)}
    finally:
        await db.close()
    run = await get_run(run_id)
    async with _state_lock:
        _active_runs[run_id] = run

    # Re-execute current stages that were pending/running
    stage_history = json.loads(run["stage_history"]) if isinstance(run["stage_history"], str) else run["stage_history"]
    current = json.loads(run["current_stages"]) if isinstance(run["current_stages"], str) else run["current_stages"]
    for sid in current:
        sh = stage_history.get(sid, {})
        if sh.get("status") in ("completed", "skipped"):
            asyncio.ensure_future(_complete_stage(run_id, sid))
        elif sh.get("status") in ("pending", "running"):
            job = _stage_jobs.get((run_id, sid))
            session_id = sh.get("session_id")
            if (job and not job.done()) or (session_id and _session_to_run.get(session_id) == run_id):
                continue  # paused work is still finishing; never deliver it twice
            _schedule_stage(run_id, sid)

    await _broadcast_run(run)
    return run


async def cancel_run(run_id: str) -> Optional[dict]:
    lock = _advance_locks.setdefault(run_id, asyncio.Lock())
    async with lock:
        return await _cancel_run(run_id)


async def _stop_run_work(run_id: str, stage_history: dict, owned_sessions=None):
    """Stop only work still owned by a terminal run; never await ourselves."""
    current = asyncio.current_task()
    jobs = [task for (rid, _), task in list(_stage_jobs.items())
            if rid == run_id and task is not current and not task.done()]
    for task in jobs:
        task.cancel()
    if jobs:
        await asyncio.gather(*jobs, return_exceptions=True)
    if owned_sessions is None:
        owned_sessions = {sh.get("session_id") for sh in stage_history.values()
                          if sh.get("status") == "running"
                          and _session_to_run.get(sh.get("session_id")) == run_id}
    if _pty_manager and owned_sessions:
        db = await get_db()
        try:
            for session_id in owned_sessions:
                if not session_id or not _pty_manager.is_alive(session_id):
                    continue
                row = await (await db.execute(
                    "SELECT cli_type FROM sessions WHERE id = ?", (session_id,),
                )).fetchone()
                if not row:
                    continue
                # Claude's permission menu ignores Ctrl-C. Escape rejects the
                # pending request and interrupts its active turn without ever
                # approving a tool; other CLIs retain their usual interrupt.
                interrupt = b"\x1b" if (row["cli_type"] or "claude") == "claude" else b"\x03"
                _pty_manager.write(session_id, interrupt)
        finally:
            await db.close()


async def _cancel_run(run_id: str) -> Optional[dict]:
    run = await get_run(run_id)
    if not run:
        return None
    if run["status"] not in ("running", "paused"):
        return {"_cancel_no_op": True, **run}
    # Clean up timers, mappings, and task tracking
    stage_history = json.loads(run["stage_history"]) if isinstance(run["stage_history"], str) else run["stage_history"]
    owned_sessions = {sh.get("session_id") for sh in stage_history.values()
                      if sh.get("status") == "running"
                      and _session_to_run.get(sh.get("session_id")) == run_id}
    async with _state_lock:
        for sid, sh in stage_history.items():
            sess = sh.get("session_id")
            if sess:
                _session_to_run.pop(sess, None)
                timer = _advance_timers.pop(sess, None)
                if timer:
                    timer.cancel()
        _active_runs.pop(run_id, None)
        task_id = run.get("task_id")
        if task_id:
            _pipeline_task_ids.discard(task_id)

    db = await get_db()
    try:
        await db.execute(
            "UPDATE pipeline_runs SET status = 'cancelled', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status IN ('running', 'paused')",
            (run_id,),
        )
        await db.commit()
    finally:
        await db.close()
    await _stop_run_work(run_id, stage_history, owned_sessions)
    run = await get_run(run_id)
    await _broadcast_run(run)
    return run


async def get_run(run_id: str) -> Optional[dict]:
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM pipeline_runs WHERE id = ?", (run_id,))
        row = await cur.fetchone()
        return _deserialize_run(dict(row)) if row else None
    finally:
        await db.close()


async def delete_run(run_id: str) -> bool:
    """Hard-delete a run row. Cancels in-flight state first so callers don't
    leak timers/mappings. Mirrors cascade_runs which already had DELETE."""
    run = await get_run(run_id)
    if not run:
        return False
    if run["status"] in ("running", "paused"):
        await cancel_run(run_id)
    db = await get_db()
    try:
        cur = await db.execute("DELETE FROM pipeline_runs WHERE id = ?", (run_id,))
        await db.commit()
        return cur.rowcount > 0
    finally:
        await db.close()


async def list_runs(
    workspace_id: str = None,
    pipeline_id: str = None,
    task_id: str = None,
    active_only: bool = False,
) -> list[dict]:
    sql = "SELECT * FROM pipeline_runs WHERE 1=1"
    params = []
    if workspace_id:
        sql += " AND workspace_id = ?"
        params.append(workspace_id)
    if pipeline_id:
        sql += " AND pipeline_id = ?"
        params.append(pipeline_id)
    if task_id:
        sql += " AND task_id = ?"
        params.append(task_id)
    if active_only:
        sql += " AND status IN ('running', 'paused')"
    sql += " ORDER BY created_at DESC, rowid DESC LIMIT 50"
    db = await get_db()
    try:
        cur = await db.execute(sql, params)
        rows = await cur.fetchall()
        return [_deserialize_run(dict(r)) for r in rows]
    finally:
        await db.close()


def _deserialize_run(d: dict) -> dict:
    for key in ("current_stages", "variables"):
        if isinstance(d.get(key), str):
            try:
                d[key] = json.loads(d[key])
            except (json.JSONDecodeError, TypeError):
                d[key] = [] if key == "current_stages" else {}
    if isinstance(d.get("stage_history"), str):
        try:
            d["stage_history"] = json.loads(d["stage_history"])
        except (json.JSONDecodeError, TypeError):
            d["stage_history"] = {}
    return d


# ── Stage Execution ─────────────────────────────────────────────────

def _validate_runnable_definition(stages, transitions):
    if not isinstance(stages, list) or not stages:
        raise ValueError("Add at least one stage before running this pipeline.")
    supported = {"agent", "sweep", "research", "approval", "task_update", "command", "condition", "delay"}
    ids = set()
    for stage in stages:
        if not isinstance(stage, dict) or not isinstance(stage.get("id"), str) or not stage["id"]:
            raise ValueError("Each pipeline stage needs a non-empty id.")
        if stage["id"] in ids:
            raise ValueError(f"Duplicate pipeline stage: {stage['id']}")
        ids.add(stage["id"])
        if stage.get("type", "agent") not in supported:
            raise ValueError(f"Unsupported stage type: {stage.get('type')}")
        if stage.get("config") is not None and not isinstance(stage["config"], dict):
            raise ValueError(f"Stage {stage['id']} needs a configuration object.")
    if not isinstance(transitions, list):
        raise ValueError("Pipeline connections must be a list.")
    for edge in transitions:
        if not isinstance(edge, dict) or edge.get("source") not in ids or edge.get("target") not in ids:
            raise ValueError("Every connection must link existing pipeline stages.")
        if edge.get("condition", "always") not in {"always", "on_pass", "on_fail", "on_match", "on_expr"}:
            raise ValueError(f"Unsupported connection condition: {edge.get('condition')}")


def _budget_exceeded(run: dict) -> Optional[str]:
    """C6: return a reason if the run exceeded its (optional) budget, else None.
    Null budget columns → never exceeded, so no-budget runs behave exactly as
    before this change."""
    bt = run.get("budget_tokens")
    if bt:
        try:
            if int(run.get("spent_tokens") or 0) >= int(bt):
                return f"token budget reached ({run.get('spent_tokens') or 0}/{bt})"
        except (TypeError, ValueError):
            pass
    bw = run.get("budget_wall_s")
    if bw:
        try:
            import datetime as _dt
            started = run.get("started_at")
            if started:
                t0 = _dt.datetime.strptime(str(started)[:19], "%Y-%m-%d %H:%M:%S")
                if (_dt.datetime.utcnow() - t0).total_seconds() >= float(bw):
                    return f"wall-clock budget reached (>{bw}s)"
        except Exception:
            pass
    return None


async def add_spent_tokens(run_id: str, n: int) -> None:
    """C6: accumulate a run's spent-token count (best-effort). Executors that have
    a token signal (e.g. a headless driver reading CLI usage) call this; the PTY
    path has no reliable per-stage token signal yet — see followup in the design
    doc. No-op for falsy n."""
    if not n:
        return
    db = await get_db()
    try:
        await db.execute(
            "UPDATE pipeline_runs SET spent_tokens = COALESCE(spent_tokens, 0) + ? WHERE id = ?",
            (int(n), run_id),
        )
        await db.commit()
    finally:
        await db.close()


def stage_cache_key(stage: dict, run: dict) -> str:
    """C6: content-address a stage by (role/session_type, prompt template, input)
    so resume-from-cache can skip re-executing an already-completed stage."""
    import hashlib
    role = (stage.get("agent_config") or {}).get("role") or stage.get("session_type") or ""
    prompt = stage.get("prompt_template") or ""
    inp = json.dumps(stage.get("input") or {}, sort_keys=True)
    return hashlib.sha256(f"{role}\x00{prompt}\x00{inp}".encode()).hexdigest()[:16]


def _schedule_stage(run_id: str, stage_id: str):
    previous = _stage_jobs.get((run_id, stage_id))
    if previous and not previous.done():
        # A loop may target the very stage that is just completing. Let its
        # coroutine finish before starting the next iteration.
        previous.add_done_callback(lambda _: asyncio.ensure_future(_execute_stage(run_id, stage_id)))
    else:
        asyncio.ensure_future(_execute_stage(run_id, stage_id))


async def _execute_stage(run_id: str, stage_id: str):
    key = (run_id, stage_id)
    current = asyncio.current_task()
    existing = _stage_jobs.get(key)
    if existing and not existing.done() and existing is not current:
        return
    _stage_jobs[key] = current
    try:
        await _execute_stage_body(run_id, stage_id)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.exception("Pipeline stage %s failed", stage_id)
        run = await get_run(run_id)
        if run and run["status"] in ("running", "paused"):
            await _fail_stage(run_id, stage_id, str(exc))
    finally:
        if _stage_jobs.get(key) is current:
            _stage_jobs.pop(key, None)


async def _execute_stage_body(run_id: str, stage_id: str):
    """Execute a single pipeline stage."""
    run = await get_run(run_id)
    if not run or run["status"] != "running":
        return

    defn = await get_definition(run["pipeline_id"])
    if not defn:
        return

    stage = _find_stage(defn, stage_id)
    if not stage:
        logger.error("Stage %s not found in pipeline %s", stage_id, run["pipeline_id"])
        return

    stage_type = stage.get("type", "agent")

    # C6: enforce per-run budget (no-op unless a budget was set on the run).
    reason = _budget_exceeded(run)
    if reason:
        logger.warning("Pipeline %s: %s — halting run before stage '%s'",
                       run_id[:8], reason, stage.get("name"))
        await _complete_run(run_id, status="budget_exceeded")
        return

    # C6: resume-from-cache — when explicitly enabled on the run, do not re-execute
    # a stage that already completed with a stored typed result (e.g. after a
    # restart re-drive); advance from it instead. Default OFF → unchanged behavior.
    variables = run.get("variables") or {}
    if isinstance(variables, dict) and variables.get("resume_from_cache"):
        sh = (run.get("stage_history") or {}).get(stage_id, {})
        if sh.get("status") == "completed" and isinstance(sh.get("result"), dict):
            logger.info("Pipeline %s: stage '%s' cache-hit — skipping re-execution",
                        run_id[:8], stage.get("name"))
            await _complete_stage(run_id, stage_id)
            return

    logger.info("Pipeline %s: executing stage '%s' (%s)", run_id[:8], stage.get("name"), stage_type)

    # Update stage history
    await _update_stage_status(run_id, stage_id, "running")

    if stage_type == "agent":
        await _execute_agent_stage(run_id, stage_id, stage, run, defn)
    elif stage_type == "sweep":
        await _execute_sweep_stage(run_id, stage_id, stage, run, defn)
    elif stage_type == "research":
        await _execute_research_stage(run_id, stage_id, stage, run)
    elif stage_type == "approval":
        await _execute_approval_stage(run_id, stage_id, stage, run)
    elif stage_type == "task_update":
        await _execute_task_update_stage(run_id, stage_id, stage, run)
    elif stage_type == "command":
        await _execute_command_stage(run_id, stage_id, stage, run)
    elif stage_type == "condition":
        await _execute_condition_stage(run_id, stage_id, stage, run, defn)
    elif stage_type == "delay":
        delay_s = stage.get("config", {}).get("delay_seconds", 5)
        await asyncio.sleep(delay_s)
        await _complete_stage(run_id, stage_id)
    else:
        logger.warning("Unknown stage type: %s", stage_type)
        await _complete_stage(run_id, stage_id)


async def _execute_sweep_stage(
    run_id: str, stage_id: str, stage: dict, run: dict, defn: dict
):
    """Dynamic fan-out stage: run N agents in parallel via sweep_engine, then
    advance on the synthesized output. Reuses run_sweep, so no PTY/session is
    held for the duration. This is the pipeline's "parallel fan-out within a
    stage" primitive; compose it with a downstream `condition` stage (and a
    synthesis_prompt that emits PASS/FAIL) for an adversarial-verify gate.

    stage['config']:
      prompts:          explicit list of agent prompts (overrides template/fanout)
      fanout:           N identical agents from the stage prompt_template (default 3, cap 16)
      lenses:           list of perspective strings — one diverse agent per lens
      parallel:         max concurrency (default 4)
      synthesize:       merge agent outputs (default True)
      synthesis_prompt: custom merge instruction (e.g. "End with PASS or FAIL.")
    The synthesis becomes the stage output_summary, so on_pass/on_fail/on_match
    transitions evaluate it exactly like an agent stage.
    """
    ws_id = run.get("workspace_id")
    cfg = stage.get("config") or {}

    prompts = cfg.get("prompts")
    if not prompts:
        base = _build_prompt(stage, run)
        if not base:
            await _fail_stage(run_id, stage_id, "sweep stage has no prompts or prompt_template")
            return
        lenses = cfg.get("lenses")
        if lenses:
            prompts = [f"{base}\n\nFocus your analysis through this lens: {lens}" for lens in lenses]
        else:
            fanout = max(1, min(int(cfg.get("fanout") or 3), 16))
            prompts = [base for _ in range(fanout)]

    if _is_review_stage(stage):
        first = str(prompts[0]) if prompts else ""
        enriched = await _with_review_intent(first, stage, run, defn)
        if first and enriched.endswith(first):
            intent_prefix = enriched[:-len(first)]
            prompts = [intent_prefix + str(candidate) for candidate in prompts]
        elif prompts:
            prompts = [enriched, *(str(candidate) for candidate in prompts[1:])]

    from sweep_engine import run_sweep
    result = await run_sweep(
        ws_id, prompts,
        label=stage.get("name") or "pipeline sweep",
        parallel=int(cfg.get("parallel") or 4),
        synthesize=bool(cfg.get("synthesize", True)),
        synthesis_prompt=cfg.get("synthesis_prompt"),
        kind=cfg.get("kind", "sweep"),
        runtime="pipeline",
    )
    if result.get("error"):
        await _fail_stage(run_id, stage_id, f"sweep failed: {result['error']}")
        return

    synthesis = result.get("synthesis") or "\n\n".join(
        r["text"] for r in result.get("results", []) if r.get("ok"))
    if not synthesis and not result.get("agents_done"):
        await _fail_stage(run_id, stage_id, "sweep produced no output (all agents failed)")
        return

    logger.info("Pipeline %s: sweep stage '%s' fanned out %d agents (%d ok)",
                run_id[:8], stage.get("name"), result.get("agents_total", 0),
                result.get("agents_done", 0))

    # Stash the synthesis as the stage output so _complete_stage's transition
    # logic (on_pass/on_fail/on_match) evaluates it just like an agent stage.
    await _update_stage_status(run_id, stage_id, "running", output_summary=synthesis)
    await _complete_stage(run_id, stage_id)


async def _execute_agent_stage(
    run_id: str, stage_id: str, stage: dict, run: dict, defn: dict
):
    """Send a prompt to a session and wait for idle."""
    session_id = stage.get("session_id")
    session_type = stage.get("session_type")
    cli_type = stage.get("cli_type")  # active CLI id, or None (any)
    agent_config = stage.get("agent_config") or {}
    stage_config = stage.get("config") or {}
    ws_id = run.get("workspace_id")

    # Session reuse: rerun in the same session as another stage
    if not session_id:
        reuse_from = stage.get("reuse_session_from")
        if reuse_from == "__from_failure__":
            session_id = _resolve_failure_session(defn, run, stage_id)
            if session_id:
                logger.info("Pipeline %s: stage '%s' reusing session from failure chain",
                            run_id[:8], stage.get("name"))
        elif reuse_from:
            stage_history = run.get("stage_history", {})
            sh = stage_history.get(reuse_from, {})
            session_id = sh.get("session_id")
            if session_id:
                logger.info("Pipeline %s: stage '%s' reusing session from stage '%s'",
                            run_id[:8], stage.get("name"), reuse_from)

    # Resolve session
    if not session_id and session_type:
        fresh_session = bool(stage.get("fresh_session") or stage_config.get("fresh_session"))
        if fresh_session:
            db_fresh = await get_db()
            try:
                session_id = await _auto_create_session(
                    db_fresh, ws_id, session_type, cli_type, agent_config,
                    task_id=run.get("task_id"),
                )
            finally:
                await db_fresh.close()
        else:
            session_id = await _resolve_session(
                ws_id, session_type, cli_type=cli_type, agent_config=agent_config,
                task_id=run.get("task_id"),
            )
    if not session_id:
        logger.error("No session for stage '%s'", stage.get("name"))
        await _fail_stage(run_id, stage_id, "No session configured")
        return

    # Update stage with resolved session
    await _update_stage_session(run_id, stage_id, session_id)
    if stage_config.get("require_existing_assignment"):
        db = await get_db()
        try:
            await db.execute("BEGIN IMMEDIATE")
            await _validate_existing_task_assignee(db, run["task_id"], ws_id, session_id, run_id=run_id)
            await _ensure_pipeline_stage_tools(session_id, session_type, run.get("task_id"), db=db)
            await db.commit()
        finally:
            await db.close()
        if _pty_manager and not _pty_manager.is_alive(session_id) and _pty_start_fn:
            await _pty_start_fn(session_id)
    else:
        await _ensure_pipeline_stage_tools(session_id, session_type, run.get("task_id"))

    # Build prompt from template
    prompt = _build_prompt(stage, run)
    if not prompt:
        logger.warning("Empty prompt for stage '%s', advancing", stage.get("name"))
        await _complete_stage(run_id, stage_id)
        return

    stage_history = run.get("stage_history", {})

    # Inject requested stage context. Task-owned pipelines use this to carry
    # research, plan, critic, and implementation summaries forward without
    # making the next agent inspect raw terminal history.
    context_from = stage.get("context_from") or stage_config.get("context_from") or []
    if isinstance(context_from, str):
        context_from = [context_from]
    if context_from:
        context_blocks = []
        for source_id in context_from:
            src_hist = stage_history.get(source_id, {})
            src_stage = _find_stage(defn, source_id)
            src_name = src_stage.get("name", source_id) if src_stage else source_id
            # C1: prefer the typed result object when a source stage produced one,
            # so downstream agents receive structured context, not scraped text.
            src_result = src_hist.get("result")
            if isinstance(src_result, dict):
                context_blocks.append(
                    f"--- {src_name} (structured result) ---\n"
                    + json.dumps(src_result, indent=2)[:1500]
                )
                continue
            src_output = src_hist.get("output_summary", "")
            if not src_output:
                continue
            context_blocks.append(f"--- {src_name} ---\n{src_output}")
        if context_blocks:
            prompt += "\n\nPipeline context:\n" + "\n\n".join(context_blocks)

    # Inject failure context: when this stage was reached via an on_fail
    # transition, append the failing stage's output so the agent knows
    # exactly what went wrong and what to fix.
    transitions = defn.get("transitions", [])
    incoming_fail = [t for t in transitions
                     if t["target"] == stage_id and t.get("condition") == "on_fail"]
    for t in incoming_fail:
        src_hist = stage_history.get(t["source"], {})
        src_output = src_hist.get("output_summary", "")
        if src_output:
            src_stage = _find_stage(defn, t["source"])
            src_name = src_stage.get("name", t["source"]) if src_stage else t["source"]
            prompt += f"\n\n--- Failure from '{src_name}' ---\n{src_output}"

    # C2: apply the role template for this stage's role/session_type — prepend its
    # system fragment and (when the stage didn't set one) default the result_schema
    # from the template. Explicit stage config always wins; unknown roles no-op.
    result_schema = stage.get("result_schema") or stage_config.get("result_schema")
    try:
        import role_templates
        _role = agent_config.get("role") or session_type
        _tmpl = role_templates.get_role_template(_role)
        if _tmpl:
            frag = _tmpl.get("system_fragment")
            if frag:
                prompt = f"{frag}\n\n{prompt}"
            if not result_schema:
                result_schema = _tmpl.get("result_schema")
    except Exception:
        pass

    prompt = await _with_review_intent(prompt, stage, run, defn)
    if result_schema or "report_pipeline_result" in prompt:
        # Keep the final completion contract outside reference-data wrappers,
        # and choose one tool so a typed result is never followed by a second
        # legacy report after the stage has already advanced.
        prompt += "\n\n" + _pipeline_completion_instructions(result_schema)

    # Send to PTY
    if not _pty_manager:
        await _fail_stage(run_id, stage_id, "PTY manager not available")
        return

    if not _pty_manager.is_alive(session_id):
        logger.warning("Session %s PTY not alive for stage '%s'", session_id[:8], stage.get("name"))
        await _fail_stage(run_id, stage_id, "Session PTY not running")
        return

    db = await get_db()
    try:
        row = await (await db.execute(
            "SELECT cli_type FROM sessions WHERE id = ?", (session_id,),
        )).fetchone()
    finally:
        await db.close()
    if not row:
        await _fail_stage(run_id, stage_id, "Session no longer exists")
        return
    # Reused/explicit sessions may use a different CLI from the stage recipe.
    actual_cli_type = row["cli_type"] or "claude"
    if not _input_ready_fn:
        await _fail_stage(run_id, stage_id, "Session input readiness service not available")
        return
    ready = await _input_ready_fn(session_id, actual_cli_type, 30)
    current_run = await get_run(run_id)
    if not current_run or current_run["status"] != "running":
        return  # resume can retry an unsent stage; never type after pause/stop
    if not ready:
        await _fail_stage(
            run_id, stage_id,
            "Session is not ready for input. Check its sign-in, startup, or permission prompt before retrying.",
        )
        return

    try:
        if not await _bind_pipeline_worker_task(run_id, stage_id, session_id):
            return  # pause/cancel won the race while the session was starting
    except ValueError:
        current_run = await get_run(run_id)
        if not current_run or current_run["status"] != "running":
            return
        raise

    # Keep multiline prompts in one paste, then send Enter separately so CLI
    # paste detection does not absorb the submission key into the prompt.
    payload = prompt.encode("utf-8")
    if actual_cli_type == "gemini":
        payload = prompt.replace("\r", " ").replace("\n", " ").encode("utf-8")
    elif "\n" in prompt or "\r" in prompt:
        payload = b"\x1b[200~" + payload + b"\x1b[201~"
    if _pty_manager.write(session_id, payload) is False:
        await _fail_stage(run_id, stage_id, "Session rejected the pipeline prompt; it was not submitted")
        return
    paste_delay = max(0.8 if actual_cli_type in {"codex", "antigravity"} else 0.4,
                      min(1.5, len(payload) / 600))
    try:
        await asyncio.sleep(paste_delay)
        async with _state_lock:
            submitted = _pty_manager.write(session_id, b"\r") is not False
            if submitted:
                # Startup/paste idle events cannot complete an unsent stage.
                _session_to_run[session_id] = run_id
    except asyncio.CancelledError:
        # This stage owns the unsent paste. Clear it when cancellation stops
        # the delivery task, rather than leaving it for the next user message.
        _pty_manager.write(session_id, b"\x03")
        raise
    if not submitted:
        _pty_manager.write(session_id, b"\x03")
        await _fail_stage(
            run_id, stage_id,
            "Pipeline prompt was typed but could not be submitted. Check the session before retrying.",
        )
        return
    logger.info("Pipeline %s: sent prompt to session %s for stage '%s'",
                run_id[:8], session_id[:8], stage.get("name"))

    await _broadcast_run(await get_run(run_id))


async def _execute_research_stage(run_id: str, stage_id: str, stage: dict, run: dict):
    """Run a backend deep-research job as a visible pipeline stage."""
    query = _build_prompt(stage, run).strip()
    if not query:
        query = str((run.get("variables") or {}).get("topic") or "").strip()
    if not query:
        await _update_stage_status(run_id, stage_id, "completed", output_summary="__pipeline_result:pass:No research query supplied.")
        await _complete_stage(run_id, stage_id)
        return

    workspace_id = run.get("workspace_id")
    entry_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())
    model = None
    workspace_path = None

    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT path, research_model FROM workspaces WHERE id = ?",
            (workspace_id,),
        )
        ws = await cur.fetchone()
        if ws:
            workspace_path = ws["path"]
            model = ws["research_model"]
        await db.execute(
            """INSERT INTO research_entries
               (id, workspace_id, topic, query, feature_tag, status)
               VALUES (?, ?, ?, ?, ?, 'pending')""",
            (entry_id, workspace_id, query[:240], query, f"pipeline:{run_id}"),
        )
        await db.commit()
    finally:
        await db.close()

    try:
        import server_runtime
        _research_jobs = server_runtime.attr("_research_jobs")
        _run_research_job = server_runtime.attr("_run_research_job")
        from research_storage import read_entry_result
        stage_config = stage.get("config") or {}
        _research_jobs[job_id] = {
            "query": query,
            "model": model,
            "status": "pending",
            "entry_id": entry_id,
            "backend": stage_config.get("backend"),
            "depth": stage_config.get("depth", "standard"),
            "recency_months": None,
            "cross_temporal": False,
            "dig_deeper": False,
            "mcp_server_ids": [],
            "plan": None,
            "interactive": False,
            "steer_queries": [],
        }
        await _run_research_job(
            job_id, query, model, workspace_path, entry_id,
            workspace_id=workspace_id,
        )
        job = _research_jobs.get(job_id, {})
        result = await read_entry_result(get_db, entry_id, workspace_id)
        findings = str((result or {}).get("findings_summary") or "").strip()
        if job.get("status") == "completed" and result and result["status"] == "complete" and findings:
            summary = findings[:1800]
            await _update_stage_status(
                run_id, stage_id, "completed",
                output_summary=f"__pipeline_result:pass:Research complete. entry_id={entry_id}\n{summary}",
            )
        else:
            await _update_stage_status(
                run_id, stage_id, "completed",
                output_summary=f"__pipeline_result:fail:Research failed. entry_id={entry_id}. {job.get('error') or 'No completed report persisted for this entry.'}",
            )
    except Exception as exc:
        logger.exception("Pipeline research stage failed")
        await _update_stage_status(
            run_id, stage_id, "completed",
            output_summary=f"__pipeline_result:fail:Research stage error: {exc}",
        )
    await _complete_stage(run_id, stage_id)


async def _execute_approval_stage(run_id: str, stage_id: str, stage: dict, run: dict):
    """Pause a run for human plan approval, then complete on resume."""
    stage_config = stage.get("config") or {}
    if stage_config.get("auto_approve"):
        await _update_stage_status(run_id, stage_id, "completed", output_summary="__pipeline_result:pass:Plan auto-approved.")
        await _complete_stage(run_id, stage_id)
        return

    stage_history = run.get("stage_history", {})
    previous = (stage_history.get(stage_id, {}) or {}).get("output_summary") or ""
    if "waiting_for_plan_approval" in previous:
        await _update_stage_status(run_id, stage_id, "completed", output_summary="__pipeline_result:pass:Plan approved by resuming the pipeline run.")
        await _complete_stage(run_id, stage_id)
        return

    task_id = run.get("task_id")
    db = await get_db()
    try:
        if task_id:
            await db.execute(
                """UPDATE tasks
                   SET status = 'planning', pipeline_stage = 'awaiting_plan_approval',
                       updated_at = datetime('now')
                   WHERE id = ?""",
                (task_id,),
            )
        await db.execute(
            "UPDATE pipeline_runs SET status = 'paused', updated_at = datetime('now') WHERE id = ?",
            (run_id,),
        )
        await db.commit()
    finally:
        await db.close()

    await _update_stage_status(
        run_id, stage_id, "running",
        output_summary="waiting_for_plan_approval: resume this pipeline run after approving the plan.",
    )
    async with _state_lock:
        _active_runs.pop(run_id, None)
    await _broadcast_run(await get_run(run_id))


async def _execute_task_update_stage(run_id: str, stage_id: str, stage: dict, run: dict):
    """Update the task as a first-class pipeline stage."""
    task_id = run.get("task_id")
    config = stage.get("config", {}) or {}
    status = config.get("status")
    pipeline_stage = config.get("pipeline_stage")
    result_summary = _build_prompt(stage, run).strip() or config.get("result_summary") or ""

    if task_id and (status or pipeline_stage or result_summary):
        fields, values = [], []
        if status:
            fields.append("status = ?")
            values.append(status)
        if pipeline_stage:
            fields.append("pipeline_stage = ?")
            values.append(pipeline_stage)
        if result_summary:
            fields.append("result_summary = ?")
            values.append(result_summary[:4000])
        fields.append("updated_at = datetime('now')")
        values.append(task_id)
        db = await get_db()
        try:
            await db.execute(f"UPDATE tasks SET {', '.join(fields)} WHERE id = ?", values)
            await db.execute(
                """INSERT INTO task_events (task_id, event_type, actor, new_value, message)
                   VALUES (?, 'pipeline_stage_changed', 'pipeline', ?, ?)""",
                (task_id, pipeline_stage or status or "", result_summary[:500] or f"Pipeline set task to {status or pipeline_stage}"),
            )
            await db.commit()
        finally:
            await db.close()

    await _update_stage_status(
        run_id, stage_id, "completed",
        output_summary=f"__pipeline_result:pass:{result_summary or 'Task updated.'}",
    )
    await _complete_stage(run_id, stage_id)


def _command_prefix_allowed(command: str, allowed_prefixes: list[str]) -> bool:
    """Return True when command argv starts with an allowed argv prefix."""
    if not allowed_prefixes:
        return False
    try:
        command_argv = shlex.split(command)
    except ValueError:
        return False
    if not command_argv:
        return False
    for prefix in allowed_prefixes:
        prefix = str(prefix or "").strip()
        if not prefix:
            continue
        try:
            prefix_argv = shlex.split(prefix)
        except ValueError:
            continue
        if prefix_argv and command_argv[:len(prefix_argv)] == prefix_argv:
            return True
    return False


def _resolve_command_cwd(workspace_path: str, cwd_value: str | None) -> Optional[str]:
    """Resolve a command cwd, constraining relative paths inside workspace."""
    if not workspace_path:
        return None
    root = Path(workspace_path).expanduser().resolve()
    raw = str(cwd_value or "").strip()
    target = (root / raw).resolve() if raw else root
    try:
        target.relative_to(root)
    except ValueError:
        return None
    return str(target)


def _log_tail(text: str, limit: int = 60000) -> str:
    text = text or ""
    return text if len(text) <= limit else text[-limit:]


async def _execute_command_stage(run_id: str, stage_id: str, stage: dict, run: dict):
    """Run a deterministic command stage with stage-scoped safety policy."""
    config = stage.get("config", {}) or {}
    command = _build_prompt(stage, run).strip() or str(config.get("command") or "").strip()
    if not command:
        await _update_stage_status(run_id, stage_id, "completed", output_summary="__pipeline_result:fail:No command configured.")
        await _complete_stage(run_id, stage_id)
        return

    policy = config.get("policy") if isinstance(config.get("policy"), dict) else {}
    policy_mode = str(policy.get("mode") or config.get("policy_mode") or "safety_checked").strip()
    if policy_mode == "safety_excluded" and str(policy.get("safety_excluded_command") or "").strip() != command:
        policy_mode = "safety_checked"
    allowed_prefixes = policy.get("allowed_prefixes")
    if not isinstance(allowed_prefixes, list):
        allowed_prefixes = config.get("allowed_prefixes")
    if isinstance(allowed_prefixes, str):
        allowed_prefixes = [line.strip() for line in allowed_prefixes.splitlines() if line.strip()]
    if not isinstance(allowed_prefixes, list):
        allowed_prefixes = []

    if policy_mode == "allowlisted" and not _command_prefix_allowed(command, allowed_prefixes):
        await _update_stage_status(
            run_id, stage_id, "completed",
            output_summary="__pipeline_result:fail:Command is not allowed by this stage allowlist.",
        )
        await _complete_stage(run_id, stage_id)
        return

    stage_history = run.get("stage_history", {})
    previous = (stage_history.get(stage_id, {}) or {}).get("output_summary") or ""
    if policy_mode == "approval_required" and "waiting_for_command_approval" not in previous:
        db = await get_db()
        try:
            await db.execute(
                "UPDATE pipeline_runs SET status = 'paused', updated_at = datetime('now') WHERE id = ?",
                (run_id,),
            )
            await db.commit()
        finally:
            await db.close()
        await _update_stage_status(
            run_id, stage_id, "running",
            output_summary=f"waiting_for_command_approval: resume this pipeline run to approve command stage.\nCommand: {command[:500]}",
        )
        async with _state_lock:
            _active_runs.pop(run_id, None)
        await _broadcast_run(await get_run(run_id))
        return

    if policy_mode == "safety_excluded":
        decision = None
    else:
        try:
            import safety_engine
            decision = await safety_engine.evaluate("Bash", {"command": command}, run.get("workspace_id"))
        except Exception as exc:
            logger.warning("Pipeline command safety evaluation failed: %s", exc)
            await _fail_stage(run_id, stage_id, f"Command safety check could not complete: {exc}. Retry when the safety service is available.")
            return

    approved_after_pause = "waiting_for_command_approval" in previous
    if decision and decision.action == "deny":
        await _update_stage_status(
            run_id, stage_id, "completed",
            output_summary=f"__pipeline_result:fail:Command blocked by safety policy: {decision.reason}",
        )
        await _complete_stage(run_id, stage_id)
        return
    if decision and decision.action == "ask" and not approved_after_pause:
        db = await get_db()
        try:
            await db.execute(
                "UPDATE pipeline_runs SET status = 'paused', updated_at = datetime('now') WHERE id = ?",
                (run_id,),
            )
            await db.commit()
        finally:
            await db.close()
        await _update_stage_status(
            run_id, stage_id, "running",
            output_summary=f"waiting_for_command_approval: safety policy requires approval before running.\n{decision.reason}\nCommand: {command[:500]}",
        )
        async with _state_lock:
            _active_runs.pop(run_id, None)
        await _broadcast_run(await get_run(run_id))
        return

    db = await get_db()
    try:
        cur = await db.execute("SELECT path FROM workspaces WHERE id = ?", (run.get("workspace_id"),))
        ws = await cur.fetchone()
        workspace_path = ws["path"] if ws else ""
    finally:
        await db.close()
    cwd = _resolve_command_cwd(workspace_path, config.get("cwd"))
    if not cwd:
        await _update_stage_status(
            run_id, stage_id, "completed",
            output_summary="__pipeline_result:fail:Command cwd must be inside the workspace.",
        )
        await _complete_stage(run_id, stage_id)
        return

    try:
        argv = shlex.split(command)
    except ValueError as exc:
        await _update_stage_status(
            run_id, stage_id, "completed",
            output_summary=f"__pipeline_result:fail:Invalid command syntax: {exc}",
        )
        await _complete_stage(run_id, stage_id)
        return
    if not argv:
        await _update_stage_status(run_id, stage_id, "completed", output_summary="__pipeline_result:fail:No command argv.")
        await _complete_stage(run_id, stage_id)
        return

    timeout_s = int(config.get("timeout_seconds") or 300)
    timeout_s = max(1, min(timeout_s, 3600))
    started = time.monotonic()
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=(os.name == "posix"),
        )
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        code = proc.returncode
        duration = time.monotonic() - started
        stdout = stdout_b.decode("utf-8", errors="replace")
        stderr = stderr_b.decode("utf-8", errors="replace")
        combined = "\n".join(part for part in [stdout.strip(), stderr.strip()] if part)
        status = "pass" if code == 0 else "fail"
        summary = (
            f"Command: {command}\n"
            f"Exit code: {code}\n"
            f"Duration: {duration:.1f}s\n"
            f"{combined[:1600]}"
        ).strip()
        await _update_stage_status(
            run_id, stage_id, "completed",
            output_summary=f"__pipeline_result:{status}:{summary}",
            logs={
                "kind": "command",
                "command": command,
                "cwd": cwd,
                "exit_code": code,
                "duration_s": round(duration, 2),
                "stdout": _log_tail(stdout),
                "stderr": _log_tail(stderr),
            },
        )
    except asyncio.CancelledError:
        if proc:
            await terminate_process_group(proc)
        raise
    except asyncio.TimeoutError:
        if proc:
            await terminate_process_group(proc)
        await _update_stage_status(
            run_id, stage_id, "completed",
            output_summary=f"__pipeline_result:fail:Command timed out after {timeout_s}s: {command}",
            logs={
                "kind": "command",
                "command": command,
                "cwd": cwd,
                "timeout_s": timeout_s,
                "timed_out": True,
            },
        )
    except Exception as exc:
        await _update_stage_status(
            run_id, stage_id, "completed",
            output_summary=f"__pipeline_result:fail:Command execution error: {exc}",
            logs={
                "kind": "command",
                "command": command,
                "cwd": cwd,
                "error": str(exc),
            },
        )
    await _complete_stage(run_id, stage_id)


async def _execute_condition_stage(
    run_id: str, stage_id: str, stage: dict, run: dict, defn: dict
):
    """Evaluate a condition based on the previous stage's output."""
    # Get the incoming transition to find the source stage
    transitions = defn.get("transitions", [])
    incoming = [t for t in transitions if t["target"] == stage_id]

    # Try to get output from the most recent completed stage
    stage_history = run.get("stage_history", {})
    prev_output = ""
    prev_result = None
    for t in incoming:
        src = stage_history.get(t["source"], {})
        if not prev_output and src.get("output_summary"):
            prev_output = src["output_summary"]
        if prev_result is None:
            r = get_stage_result(run, t["source"])
            if r is not None:
                prev_result = r
        if prev_output and prev_result is not None:
            break

    # Evaluate condition — check output for pass/fail signals
    condition_result = _evaluate_condition(stage, prev_output)
    if (stage.get("config") or {}).get("require_report") and _parse_structured_result(prev_output) not in ("pass", "fail"):
        prev_output = "Missing verification report: the reviewing agent must call report_pipeline_result with pass or fail and the checks it performed.\n" + prev_output

    # Conditions use the same advancement path as every other stage so branch
    # tracking and the iteration limit apply to condition-only loops as well.
    await _update_stage_status(
        run_id, stage_id, "completed",
        output_summary=f"__pipeline_result:{condition_result}:{prev_output}",
        result=prev_result,
    )
    await _complete_stage(run_id, stage_id)


def get_stage_result(run: dict, stage_id: str) -> Optional[dict]:
    """Return the typed (schema-validated) result object a stage submitted via
    the submit_result MCP tool, or None if the stage produced no typed result."""
    history = run.get("stage_history", {}) or {}
    if isinstance(history, str):
        try:
            history = json.loads(history)
        except (json.JSONDecodeError, TypeError):
            history = {}
    r = (history.get(stage_id) or {}).get("result")
    return r if isinstance(r, dict) else None


import ast as _ast

# AST nodes permitted inside an `on_expr` transition condition. Deliberately
# excludes Call, Attribute, comprehensions, and everything else that could have
# side effects or reach outside the supplied result — this is a pure boolean
# predicate over a typed result, not a scripting surface.
_EXPR_ALLOWED = (
    _ast.Expression, _ast.BoolOp, _ast.UnaryOp, _ast.BinOp, _ast.Compare,
    _ast.Name, _ast.Load, _ast.Constant, _ast.Subscript,
    _ast.List, _ast.Tuple, _ast.Set,
    _ast.And, _ast.Or, _ast.Not, _ast.USub, _ast.UAdd,
    _ast.Eq, _ast.NotEq, _ast.Lt, _ast.LtE, _ast.Gt, _ast.GtE,
    _ast.In, _ast.NotIn, _ast.Is, _ast.IsNot,
    _ast.Add, _ast.Sub, _ast.Mult, _ast.Div, _ast.Mod,
)


def _safe_eval_expr(expr: str, result: dict) -> bool:
    """Safely evaluate a boolean `on_expr` transition condition over a typed
    stage result. The result dict is exposed as `result`, and each of its
    string-identifier top-level keys is exposed as a bare name (so both
    `result['verdict'] == 'pass'` and `verdict == 'pass'` work). Any disallowed
    node, unknown name, or evaluation error yields False — it never raises, so a
    malformed condition simply fails to match rather than crashing the run."""
    if not expr or not isinstance(result, dict):
        return False
    try:
        tree = _ast.parse(expr, mode="eval")
    except Exception:
        return False
    for node in _ast.walk(tree):
        if not isinstance(node, _EXPR_ALLOWED):
            return False
    names = {"result": result, "true": True, "false": False, "null": None}
    for k, v in result.items():
        if isinstance(k, str) and k.isidentifier() and k not in names:
            names[k] = v
    try:
        return bool(eval(compile(tree, "<on_expr>", "eval"), {"__builtins__": {}}, names))
    except Exception:
        return False


def validate_against_schema(obj, schema: dict) -> Optional[str]:
    """Minimal, dependency-free JSON-Schema check for typed stage results.

    Supports the subset the orchestrator emits: type, required, enum,
    properties, items. Returns None when valid, else a human-readable error
    string. Unknown/unsupported keywords are ignored (permissive), so this
    never rejects a result for a keyword it doesn't understand."""
    if not isinstance(schema, dict):
        return None
    t = schema.get("type")
    _JSON_TYPES = {
        "object": dict, "array": list, "string": str,
        "number": (int, float), "integer": int, "boolean": bool, "null": type(None),
    }
    if t and t in _JSON_TYPES:
        py = _JSON_TYPES[t]
        # bool is a subclass of int — don't let True satisfy integer/number
        if t in ("integer", "number") and isinstance(obj, bool):
            return f"expected {t}, got boolean"
        if not isinstance(obj, py):
            return f"expected {t}, got {type(obj).__name__}"
    if "enum" in schema and obj not in schema["enum"]:
        return f"value {obj!r} not in enum {schema['enum']}"
    if isinstance(obj, dict):
        for req in schema.get("required", []) or []:
            if req not in obj:
                return f"missing required field '{req}'"
        props = schema.get("properties") or {}
        for key, subschema in props.items():
            if key in obj:
                err = validate_against_schema(obj[key], subschema)
                if err:
                    return f"{key}: {err}"
    if isinstance(obj, list) and isinstance(schema.get("items"), dict):
        for i, item in enumerate(obj):
            err = validate_against_schema(item, schema["items"])
            if err:
                return f"[{i}]: {err}"
    return None


def _parse_structured_result(output: str) -> Optional[str]:
    """Check if output contains a structured pipeline result from MCP.

    Returns 'pass' or 'fail' if found, None if not (fallback to keywords).
    """
    if not output:
        return None
    for line in output.split("\n"):
        if line.startswith("__pipeline_result:"):
            parts = line.split(":", 2)
            if len(parts) >= 2:
                return parts[1].strip().lower()
    return None


def _evaluate_condition(stage: dict, output: str) -> str:
    """Evaluate condition stage — returns 'pass' or 'fail'.

    Checks for structured MCP-reported results first (definitive),
    falls back to keyword matching on terminal output.
    """
    # Structured result from report_pipeline_result MCP tool — always wins
    structured = _parse_structured_result(output)
    if structured in ("pass", "fail"):
        return structured

    config = stage.get("config", {})
    if config.get("require_report"):
        return "fail"
    mode = config.get("mode", "keyword")

    output_lower = output.lower() if output else ""

    if mode == "keyword":
        fail_keywords = config.get("fail_keywords", ["fail", "error", "failed", "broken"])
        pass_keywords = config.get("pass_keywords", ["pass", "success", "passed", "ok", "done"])
        for kw in fail_keywords:
            if kw.lower() in output_lower:
                return "fail"
        for kw in pass_keywords:
            if kw.lower() in output_lower:
                return "pass"
        return config.get("default", "pass")

    elif mode == "always_pass":
        return "pass"
    elif mode == "always_fail":
        return "fail"

    return "pass"


# ── Idle Event Handler ──────────────────────────────────────────────


async def on_session_idle(session_id: str):
    """Called from hooks.py when a session becomes idle.

    Finds the active pipeline run waiting on this session and
    schedules stage completion after a debounce delay.
    """
    async with _state_lock:
        run_id = _session_to_run.get(session_id)
        if not run_id:
            return
        # Cancel any pending timer
        timer = _advance_timers.pop(session_id, None)
        if timer:
            timer.cancel()

    run = await get_run(run_id)
    if not run or run["status"] not in ("running", "paused"):
        async with _state_lock:
            _session_to_run.pop(session_id, None)
        return

    # Find the stage that uses this session
    stage_history = run.get("stage_history", {})
    stage_id = None
    for sid, sh in stage_history.items():
        if sh.get("session_id") == session_id and sh.get("status") == "running":
            stage_id = sid
            break

    if not stage_id:
        return

    # Debounce before advancing
    loop = asyncio.get_event_loop()
    timer = loop.call_later(
        ADVANCE_DELAY_S,
        lambda sid=stage_id: asyncio.ensure_future(_complete_stage(run_id, sid)),
    )
    _advance_timers[session_id] = timer


async def on_session_error(session_id: str, error: str = "turn failed"):
    """Called from hooks.py (``_handle_turn_failure``) when a session's turn
    ends with an error (Claude ``StopFailure``).

    :func:`on_session_idle` advances the stage as *completed*; a failed turn
    must instead FAIL the stage, or the run hangs on this stage forever — the
    success idle signal that :func:`on_session_idle` waits for never arrives.

    Reuses :func:`_fail_stage` (marks the stage failed, fails the run with the
    error, emits ``PIPELINE_COMPLETED(status='failed')`` so the Brain
    completion bridge doesn't strand the job, and cleans up the session maps).
    No-op when the session isn't driving a live run.
    """
    async with _state_lock:
        run_id = _session_to_run.get(session_id)
        if not run_id:
            return
        # A failed turn cancels any pending success-advance for this session.
        timer = _advance_timers.pop(session_id, None)
        if timer:
            timer.cancel()

    run = await get_run(run_id)
    if not run or run["status"] != "running":
        async with _state_lock:
            _session_to_run.pop(session_id, None)
        return

    stage_id = None
    for sid, sh in (run.get("stage_history") or {}).items():
        if sh.get("session_id") == session_id and sh.get("status") == "running":
            stage_id = sid
            break
    if not stage_id:
        return

    logger.info("Pipeline %s: stage '%s' failed (turn error: %s)",
                run_id[:8], stage_id, str(error)[:120])
    await _fail_stage(run_id, stage_id, f"Turn failed: {error}")


# ── Stage Completion & Advancement ──────────────────────────────────


async def _complete_stage(run_id: str, stage_id: str):
    # Two parallel agents can finish in the same event-loop tick. Advancing the
    # complete frontier under one lock prevents them overwriting each other.
    lock = _advance_locks.setdefault(run_id, asyncio.Lock())
    async with lock:
        await _advance_stage(run_id, stage_id)


async def _advance_stage(run_id: str, stage_id: str):
    """Mark a stage as completed and advance to the next stage(s)."""
    run = await get_run(run_id)
    if not run or run["status"] not in ("running", "paused"):
        return

    if stage_id not in run.get("current_stages", []):
        return  # duplicate idle event for an already advanced stage

    defn = await get_definition(run["pipeline_id"])
    if not defn:
        return

    stage = _find_stage(defn, stage_id)
    stage_name = stage.get("name", stage_id) if stage else stage_id

    # Capture output summary if we have a session.
    # If the stage already has output_summary (set by MCP report_pipeline_result),
    # use that instead of capturing terminal output.
    stage_history = run.get("stage_history", {})
    sh = stage_history.get(stage_id, {})
    sess_id = sh.get("session_id")
    output_summary = sh.get("output_summary") or ""
    if not output_summary and sess_id:
        output_summary = await _capture_output_summary(sess_id)
        await _update_stage_status(run_id, stage_id, "completed", output_summary=output_summary)
    else:
        await _update_stage_status(run_id, stage_id, "completed")
    if sess_id:
        _session_to_run.pop(sess_id, None)

    if run["status"] == "paused":
        return  # retain completed evidence; resume advances without repeating work

    logger.info("Pipeline %s: stage '%s' completed", run_id[:8], stage_name)

    # Find outgoing transitions
    transitions = defn.get("transitions", [])
    outgoing = [t for t in transitions if t["source"] == stage_id]

    if not outgoing:
        await _set_current_stages(run_id, [sid for sid in run.get("current_stages", []) if sid != stage_id])
        await _check_run_completion(run_id, defn)
        return

    # Check for structured MCP result first (definitive)
    structured = _parse_structured_result(output_summary)
    # C1: typed result object (if the stage submitted one) for on_expr branching
    typed_result = get_stage_result(run, stage_id)

    # Evaluate transitions
    next_stages = []
    for t in outgoing:
        cond = t.get("condition", "always")
        if cond == "always":
            next_stages.append(t["target"])
        elif cond == "on_pass":
            if structured == "pass" or (structured is None and (not output_summary or "fail" not in output_summary.lower())):
                next_stages.append(t["target"])
        elif cond == "on_fail":
            if structured == "fail" or (structured is None and output_summary and "fail" in output_summary.lower()):
                next_stages.append(t["target"])
        elif cond == "on_match":
            pattern = t.get("condition_config", {}).get("pattern", "")
            if pattern and pattern.lower() in (output_summary or "").lower():
                next_stages.append(t["target"])
        elif cond == "on_expr":
            # Branch on a boolean predicate over the stage's typed result.
            expr = (t.get("condition_config") or {}).get("expr", "")
            if _safe_eval_expr(expr, typed_result or {}):
                next_stages.append(t["target"])

    if not next_stages:
        await _set_current_stages(run_id, [sid for sid in run.get("current_stages", []) if sid != stage_id])
        await _check_run_completion(run_id, defn)
        return

    # Check iteration limits for loops
    run = await get_run(run_id)
    iteration = run.get("iteration", 1)
    max_iter = run.get("max_iterations", DEFAULT_MAX_ITERATIONS)

    # Detect if any next stage was already completed (loop detection)
    stage_history = run.get("stage_history", {})
    is_loop = any(stage_history.get(sid, {}).get("status") == "completed" for sid in next_stages)

    if is_loop:
        if iteration >= max_iter:
            logger.warning("Pipeline %s: max iterations (%d) reached", run_id[:8], max_iter)
            await _complete_run(run_id, status="max_iterations")
            return
        # Increment iteration and reset stage statuses for the loop
        await _increment_iteration(run_id, next_stages, defn)

    # Preserve parallel branches. Only schedule targets not already active.
    remaining = [sid for sid in run.get("current_stages", []) if sid != stage_id]
    to_start = [sid for sid in dict.fromkeys(next_stages) if sid not in remaining]
    await _set_current_stages(run_id, list(dict.fromkeys([*remaining, *next_stages])))
    for sid in to_start:
        _schedule_stage(run_id, sid)

    await _broadcast_run(await get_run(run_id))


async def _check_run_completion(run_id: str, defn: dict):
    """Check if all stages are done and complete the run."""
    run = await get_run(run_id)
    if not run:
        return
    stage_history = run.get("stage_history", {})
    all_done = all(
        sh.get("status") in ("completed", "skipped")
        for sh in stage_history.values()
    )
    current = run.get("current_stages", [])
    current_done = all(
        stage_history.get(sid, {}).get("status") in ("completed", "skipped")
        for sid in current
    )
    if current_done:
        await _complete_run(run_id)


async def _complete_run(run_id: str, status: str = "completed"):
    """Mark a pipeline run as complete."""
    db = await get_db()
    try:
        await db.execute(
            "UPDATE pipeline_runs SET status = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
            (status, run_id),
        )
        await db.commit()
    finally:
        await db.close()

    run = await get_run(run_id)
    if run and status != "completed":
        await _stop_run_work(run_id, run.get("stage_history") or {})
    async with _state_lock:
        _active_runs.pop(run_id, None)
        # Clean up session mappings and task tracking
        if run:
            stage_history = run.get("stage_history", {})
            for sh in stage_history.values():
                sess = sh.get("session_id")
                if sess:
                    _session_to_run.pop(sess, None)
            task_id = run.get("task_id")
            if task_id:
                _pipeline_task_ids.discard(task_id)

    logger.info("Pipeline run %s %s (iteration %d)",
                run_id[:8], status, run.get("iteration", 1) if run else 0)

    if run:
        await bus.emit(CommanderEvent.PIPELINE_COMPLETED, {
            "run_id": run_id,
            "pipeline_id": run.get("pipeline_id"),
            "workspace_id": run.get("workspace_id"),
            "task_id": run.get("task_id"),
            "status": status,
            "iterations": run.get("iteration", 1),
        }, source="pipeline_engine")

    await _broadcast_run(run)


async def _fail_stage(run_id: str, stage_id: str, error: str):
    """Mark a stage as failed and fail the run."""
    await _update_stage_status(run_id, stage_id, "failed", output_summary=error)
    db = await get_db()
    try:
        await db.execute(
            "UPDATE pipeline_runs SET status = 'failed', error = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
            (error, run_id),
        )
        await db.commit()
    finally:
        await db.close()
    run = await get_run(run_id)
    if run:
        await _stop_run_work(run_id, run.get("stage_history") or {})
    async with _state_lock:
        _active_runs.pop(run_id, None)
        # Clean up session mappings + task tracking (mirror _complete_run) so a
        # failed run doesn't leak its task into _pipeline_task_ids / session maps.
        if run:
            for sh in (run.get("stage_history") or {}).values():
                sess = sh.get("session_id")
                if sess:
                    _session_to_run.pop(sess, None)
            task_id = run.get("task_id")
            if task_id:
                _pipeline_task_ids.discard(task_id)

    # Emit PIPELINE_COMPLETED(status='failed') so a FAILED run reaches the Brain
    # completion bridge (brain_pipeline_bridge), exactly like _complete_run does on
    # success. Without this a failed pipeline COMPOSE strands its Brain job at
    # 'dispatched' until the TTL sweep. (A chaining "pipeline_complete" trigger
    # filters this out — it fires success-only; see _trigger_matches.)
    if run:
        await bus.emit(CommanderEvent.PIPELINE_COMPLETED, {
            "run_id": run_id,
            "pipeline_id": run.get("pipeline_id"),
            "workspace_id": run.get("workspace_id"),
            "task_id": run.get("task_id"),
            "status": "failed",
            "error": error,
            "iterations": run.get("iteration", 1),
        }, source="pipeline_engine")

    await _broadcast_run(run)


# ── Stage State Helpers ─────────────────────────────────────────────


async def _update_stage_status(
    run_id: str,
    stage_id: str,
    status: str,
    output_summary: str = None,
    logs: dict | None = None,
    artifacts: list | None = None,
    result: dict | None = None,
):
    db = await get_db()
    try:
        await db.execute("BEGIN IMMEDIATE")
        cur = await db.execute("SELECT stage_history FROM pipeline_runs WHERE id = ?", (run_id,))
        row = await cur.fetchone()
        if not row:
            return
        history = json.loads(row["stage_history"]) if row["stage_history"] else {}
        if stage_id not in history:
            history[stage_id] = {}
        history[stage_id]["status"] = status
        if status == "running":
            history[stage_id]["started_at"] = time.time()
        elif status in ("completed", "failed"):
            history[stage_id]["completed_at"] = time.time()
        if output_summary is not None:
            # Plans and verification evidence must remain reviewable. Bound
            # storage, and make truncation explicit instead of silently losing it.
            history[stage_id]["output_summary"] = output_summary[:32000]
            history[stage_id]["output_truncated"] = len(output_summary) > 32000
        if logs is not None:
            history[stage_id]["logs"] = logs
        if artifacts is not None:
            history[stage_id]["artifacts"] = artifacts
        # C1 typed agent contract: persist the schema-validated result object so
        # transitions can branch on its fields (on_expr) and downstream stages can
        # receive it as structured context. Stored alongside the legacy
        # output_summary string, which stays the source of truth for pass/fail.
        if result is not None:
            history[stage_id]["result"] = result
        await db.execute(
            "UPDATE pipeline_runs SET stage_history = ?, updated_at = datetime('now') WHERE id = ?",
            (json.dumps(history), run_id),
        )
        await db.commit()
    finally:
        await db.close()


async def _update_stage_session(run_id: str, stage_id: str, session_id: str):
    db = await get_db()
    try:
        await db.execute("BEGIN IMMEDIATE")
        cur = await db.execute("SELECT stage_history FROM pipeline_runs WHERE id = ?", (run_id,))
        row = await cur.fetchone()
        if not row:
            return
        history = json.loads(row["stage_history"]) if row["stage_history"] else {}
        if stage_id not in history:
            history[stage_id] = {}
        history[stage_id]["session_id"] = session_id
        await db.execute(
            "UPDATE pipeline_runs SET stage_history = ?, updated_at = datetime('now') WHERE id = ?",
            (json.dumps(history), run_id),
        )
        await db.commit()
    finally:
        await db.close()


async def _set_current_stages(run_id: str, stage_ids: list[str]):
    db = await get_db()
    try:
        await db.execute(
            "UPDATE pipeline_runs SET current_stages = ?, updated_at = datetime('now') WHERE id = ?",
            (json.dumps(stage_ids), run_id),
        )
        await db.commit()
    finally:
        await db.close()


async def _increment_iteration(run_id: str, reset_stage_ids: list[str], defn: dict):
    """Increment iteration counter and reset stages for a new loop cycle."""
    db = await get_db()
    try:
        await db.execute("BEGIN IMMEDIATE")
        cur = await db.execute("SELECT stage_history, iteration FROM pipeline_runs WHERE id = ?", (run_id,))
        row = await cur.fetchone()
        if not row:
            return
        history = json.loads(row["stage_history"]) if row["stage_history"] else {}

        # Reset all stages that are downstream of the loop target
        stages_to_reset = set(reset_stage_ids)
        transitions = defn.get("transitions", [])
        # BFS to find all downstream stages
        queue = list(reset_stage_ids)
        while queue:
            sid = queue.pop(0)
            for t in transitions:
                if t["source"] == sid and t["target"] not in stages_to_reset:
                    stages_to_reset.add(t["target"])
                    queue.append(t["target"])

        # Identify stages that dynamically resolve sessions (reuse_session_from)
        # so we clear their session on reset instead of preserving it
        dynamic_session_stages = set()
        for s in defn.get("stages", []):
            if s.get("reuse_session_from"):
                dynamic_session_stages.add(s["id"])

        for sid in stages_to_reset:
            if sid in history:
                history[sid] = {
                    "status": "pending",
                    "started_at": None,
                    "completed_at": None,
                    # Keep session for static stages, clear for dynamic (reuse_session_from)
                    "session_id": None if sid in dynamic_session_stages else history[sid].get("session_id"),
                    "output_summary": None,
                }

        await db.execute(
            "UPDATE pipeline_runs SET stage_history = ?, iteration = ?, updated_at = datetime('now') WHERE id = ?",
            (json.dumps(history), row["iteration"] + 1, run_id),
        )
        await db.commit()
    finally:
        await db.close()


# ── Session Resolution ──────────────────────────────────────────────


PIPELINE_PLANNER_SYSTEM_PROMPT = """You are the Planner for one IVE pipeline stage.
Follow the supplied stage task: prepare its implementation plan, or independently review the supplied plan when this is a review stage. Inspect repository evidence using read-only tools. Do not implement, run shell commands, write a native CLI plan file, create board sub-tasks, or save memory as a prerequisite to finishing this stage.
The local worker-board MCP result tool records your plan/review in IVE and is part of this read-only workflow. It does not edit the project. Discover it with ToolSearch when deferred, then use the stage's completion contract to submit the result. A blocked Bash or Write call does not mean this local result tool is blocked. Do not request broader permissions or exit Plan mode to submit a result. A successful result response completes your stage; stop without a duplicate report. If the actual result call fails, state that failure accurately."""


def _pipeline_completion_instructions(result_schema: dict | None) -> str:
    tool = "submit_result" if result_schema else "report_pipeline_result"
    instructions = (
        "# Pipeline completion contract\n"
        f"Use the local worker-board MCP `{tool}` tool to finish this stage. "
        f"If it is deferred, use ToolSearch to find `{tool}` first. "
        "This records only the stage result in IVE; it does not edit project files, "
        "run a shell command, or require leaving read-only Plan mode. "
        "Do not write a native CLI plan file or request broader permissions. "
        "Include the actual pass/fail verdict and evidence. A prose verdict alone cannot advance the pipeline. "
        "After the tool returns ok=true, stop: do not submit another result. "
        "If it returns a validation error, correct the payload and retry; report other tool failures accurately.\n"
    )
    if result_schema:
        instructions += (
            "Use submit_result instead of report_pipeline_result even if an earlier stage instruction names the latter. "
            "Pass the typed object in `result`, plus `status` ('pass' or 'fail') and a concise `summary`. "
            "The result must match this schema:\n" + json.dumps(result_schema, indent=2)
        )
    else:
        instructions += "Pass `status` ('pass' or 'fail'), `summary`, and optional evidence in `details`."
    return instructions


async def _bind_pipeline_worker_task(run_id: str, stage_id: str, session_id: str) -> bool:
    """Give a running implementation worker its task, without stealing an assignee.

    Planners/testers keep their read-only sessions.task_id binding. All authority
    checks and the assignment share one write transaction with pause/cancel and
    concurrent board assignment updates.
    """
    db = await get_db()
    try:
        await db.execute("BEGIN IMMEDIATE")
        row = await (await db.execute("SELECT * FROM pipeline_runs WHERE id = ?", (run_id,))).fetchone()
        if not row:
            return False
        run = _deserialize_run(dict(row))
        history = run.get("stage_history") or {}
        current = history.get(stage_id) or {}
        if (run["status"] != "running" or stage_id not in run.get("current_stages", [])
                or current.get("status") != "running" or current.get("session_id") != session_id):
            return False
        definition = await (await db.execute(
            "SELECT stages FROM pipeline_definitions WHERE id = ?", (run["pipeline_id"],),
        )).fetchone()
        stages = json.loads(definition["stages"]) if definition else []
        stage = next((s for s in stages if s.get("id") == stage_id), {})
        if (not run.get("task_id") or stage.get("session_type") != "worker"
                or _is_review_stage(stage)):
            return True
        if (stage.get("config") or {}).get("require_existing_assignment"):
            # Recheck under this same write transaction: a person may have
            # removed the assignment or reused the worker during planning.
            await _validate_existing_task_assignee(
                db, run["task_id"], run["workspace_id"], session_id, run_id=run_id,
            )
        session = await (await db.execute(
            "SELECT workspace_id, task_id, session_type FROM sessions WHERE id = ?", (session_id,),
        )).fetchone()
        task = await (await db.execute(
            "SELECT workspace_id, assigned_session_id FROM tasks WHERE id = ?", (run["task_id"],),
        )).fetchone()
        if (not session or not task or session["session_type"] != "worker"
                or session["workspace_id"] != run["workspace_id"]
                or task["workspace_id"] != run["workspace_id"]
                or session["task_id"] != run["task_id"]):
            raise ValueError("Pipeline worker and task must belong to the run's workspace and task")
        previous = task["assigned_session_id"]
        if previous and previous != session_id:
            # Only a completed executor in this run may hand off. A historical
            # run cannot authorize taking over a session's current manual work.
            handoff = any(
                old.get("session_id") == previous and old.get("status") == "completed"
                and any(s.get("id") == old_id and s.get("session_type") == "worker"
                        and not _is_review_stage(s) for s in stages)
                for old_id, old in history.items()
            )
            active_elsewhere = False
            rows = await (await db.execute(
                "SELECT stage_history FROM pipeline_runs WHERE status IN ('running', 'paused')"
            )).fetchall()
            for candidate in rows:
                old_history = json.loads(candidate["stage_history"] or "{}")
                for old_stage in old_history.values():
                    if old_stage.get("session_id") != previous:
                        continue
                    if old_stage.get("status") == "running":
                        active_elsewhere = True
            if not handoff or active_elsewhere:
                raise ValueError("Task is assigned to another session; its assignment was preserved")
        await db.execute(
            "UPDATE tasks SET assigned_session_id = ?, updated_at = datetime('now') WHERE id = ?",
            (session_id, run["task_id"]),
        )
        await db.commit()
        return True
    finally:
        await db.close()


async def _validate_existing_task_assignee(
    db, task_id: str, workspace_id: str, session_id: str, *, run_id: str | None = None,
) -> None:
    """Preserve an exact task/worker binding; never infer a new assignment."""
    task = await (await db.execute(
        "SELECT workspace_id, assigned_session_id FROM tasks WHERE id=?", (task_id,),
    )).fetchone()
    session = await (await db.execute(
        "SELECT workspace_id, task_id, session_type, status FROM sessions WHERE id=?", (session_id,),
    )).fetchone()
    if (not task or not session or task["workspace_id"] != workspace_id
            or task["assigned_session_id"] != session_id or session["workspace_id"] != workspace_id
            or session["task_id"] != task_id or session["session_type"] != "worker"):
        raise TaskAssigneeReuseError(
            "The existing task assignment changed or is not a compatible worker. Review the task assignment before retrying."
        )
    from hooks import get_session_logical_status
    alive = bool(_pty_manager and _pty_manager.is_alive(session_id))
    status = get_session_logical_status(session_id, alive, session["status"])
    if status not in ({"idle"} if alive else {"idle", "exited", "stopped"}):
        raise TaskAssigneeReuseError("The assigned worker is busy or needs attention. Finish its current turn before retrying.")
    owner = _session_to_run.get(session_id)
    if owner and owner != run_id:
        raise TaskAssigneeReuseError("The assigned worker is already owned by another pipeline run.")
    rows = await (await db.execute(
        "SELECT id, stage_history FROM pipeline_runs WHERE status IN ('running','paused')",
    )).fetchall()
    for row in rows:
        if row["id"] == run_id:
            continue
        if any(stage.get("session_id") == session_id and stage.get("status") == "running"
               for stage in json.loads(row["stage_history"] or "{}").values()):
            raise TaskAssigneeReuseError("The assigned worker is already owned by another pipeline run.")


async def _ensure_pipeline_stage_tools(
    session_id: str,
    session_type: str | None,
    task_id: str | None = None,
    db=None,
) -> None:
    """Attach MCP/tools needed by pipeline stages.

    Pipeline prompts rely on report_pipeline_result, which lives in the
    Worker Board MCP. Test and document stages also need their domain MCPs.
    """
    owns_db = db is None
    if owns_db:
        db = await get_db()
    try:
        await db.execute(
            "INSERT OR IGNORE INTO session_mcp_servers "
            "(session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
            (session_id, "builtin-worker-board"),
        )
        if task_id:
            await db.execute(
                "UPDATE sessions SET task_id = ? WHERE id = ?",
                (task_id, session_id),
            )
        capability_tag = _capability_tag_for_session_type(session_type)
        if capability_tag:
            await _add_session_tags(db, session_id, [capability_tag])
        if session_type in {"tester", "test_worker"}:
            await db.execute(
                "INSERT OR IGNORE INTO session_mcp_servers "
                "(session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
                (session_id, "builtin-playwright"),
            )
            await db.execute(
                "INSERT OR IGNORE INTO session_guidelines (session_id, guideline_id) VALUES (?, ?)",
                (session_id, "builtin-testing-agent"),
            )
        if session_type == "documentor":
            await db.execute(
                "INSERT OR IGNORE INTO session_mcp_servers "
                "(session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
                (session_id, "builtin-documentor"),
            )
            await db.execute(
                "INSERT OR IGNORE INTO session_mcp_servers "
                "(session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
                (session_id, "builtin-playwright"),
            )
            await db.execute(
                "INSERT OR IGNORE INTO session_guidelines (session_id, guideline_id) VALUES (?, ?)",
                (session_id, "builtin-documentation-agent"),
            )
        if owns_db:
            await db.commit()
    finally:
        if owns_db:
            await db.close()


async def _resolve_session(
    workspace_id: str, session_type: str, cli_type: str = None,
    agent_config: dict = None,
    task_id: str | None = None,
) -> Optional[str]:
    """Find or create a session by type (and optionally CLI type) in the workspace."""
    db = await get_db()
    try:
        lookup_type = _storage_session_type(session_type)
        capability_tag = _capability_tag_for_session_type(session_type)
        tag_filter = " AND tags LIKE ?" if capability_tag else ""
        tag_params = [f"%{capability_tag}%"] if capability_tag else []
        # Try session_type + cli_type match first
        if cli_type:
            cur = await db.execute(
                """SELECT id FROM sessions
                   WHERE workspace_id = ? AND session_type = ? AND cli_type = ?"""
                + tag_filter +
                """ ORDER BY created_at DESC LIMIT 1""",
                (workspace_id, lookup_type, cli_type, *tag_params),
            )
            row = await cur.fetchone()
            if row:
                await _ensure_pipeline_stage_tools(row["id"], session_type, task_id)
                return row["id"]

        # Try session_type only (any CLI)
        cur = await db.execute(
            """SELECT id FROM sessions
               WHERE workspace_id = ? AND session_type = ?"""
            + tag_filter +
            """ ORDER BY created_at DESC LIMIT 1""",
            (workspace_id, lookup_type, *tag_params),
        )
        row = await cur.fetchone()
        if row:
            await _ensure_pipeline_stage_tools(row["id"], session_type, task_id)
            return row["id"]

        # Try matching by name pattern
        sql = "SELECT id FROM sessions WHERE workspace_id = ? AND LOWER(name) LIKE ?"
        params = [workspace_id, f"%{session_type.lower()}%"]
        if capability_tag:
            sql += " AND session_type = ? AND tags LIKE ?"
            params.extend([lookup_type, f"%{capability_tag}%"])
        if cli_type:
            sql += " AND cli_type = ?"
            params.append(cli_type)
        cur = await db.execute(sql + " ORDER BY created_at DESC LIMIT 1", params)
        row = await cur.fetchone()
        if row:
            await _ensure_pipeline_stage_tools(row["id"], session_type, task_id)
            return row["id"]

        # No matching session — auto-create one
        return await _auto_create_session(db, workspace_id, session_type, cli_type, agent_config, task_id=task_id)
    finally:
        await db.close()


async def _auto_create_session(
    db, workspace_id: str, session_type: str, cli_type: str = None,
    agent_config: dict = None,
    task_id: str | None = None,
) -> Optional[str]:
    """Create a new session for a pipeline stage.

    Uses agent_config (from stage) with SESSION_TYPE_DEFAULTS fallback.
    """
    session_id = str(uuid.uuid4())
    cfg = agent_config or {}

    policy_cli = None
    policy_model = None
    policy_role = None
    try:
        from orchestration_policy import policy_role_for_session_type, role_model
        policy_role = policy_role_for_session_type(session_type, cfg.get("role"))
        cur = await db.execute(
            "SELECT orchestration_policy, inherit_orchestration_policy_from FROM workspaces WHERE id = ?", (workspace_id,)
        )
        ws = await cur.fetchone()
        if ws:
            policy_str = ws["orchestration_policy"]
            if ws["inherit_orchestration_policy_from"]:
                from db import resolve_workspace_orchestration_policy
                policy_str = await resolve_workspace_orchestration_policy(db, workspace_id)
            policy_cli, policy_model = role_model(policy_str, policy_role)
    except Exception as exc:
        logger.debug("Pipeline: orchestration policy lookup skipped: %s", exc)

    # Explicit stage CLI wins; otherwise role policy can choose the provider.
    resolved_cli = _fallback_cli_type(cli_type or policy_cli)
    profile = get_profile(resolved_cli)

    # Merge: explicit agent_config > CLI profile role defaults > legacy defaults.
    defaults = SESSION_TYPE_DEFAULTS.get(session_type, SESSION_TYPE_DEFAULTS["worker"])
    default_model = policy_model or _role_default_model(profile, session_type)
    if policy_model and not _valid_profile_value(profile.available_models, policy_model):
        logger.info(
            "Pipeline: policy model %r for role %s is not valid for %s; using profile default",
            policy_model, policy_role or session_type, resolved_cli,
        )
        default_model = _role_default_model(profile, session_type)
    default_permission_mode = profile.default_permission_mode

    model = cfg.get("model")
    if model in (None, ""):
        model = default_model
    elif not _valid_profile_value(profile.available_models, model):
        logger.info(
            "Pipeline: replacing stale model %r for %s with %r",
            model, resolved_cli, default_model,
        )
        model = default_model

    permission_mode = cfg.get("permission_mode")
    if permission_mode in (None, ""):
        permission_mode = default_permission_mode or defaults.get("permission_mode", "auto")
    elif not _valid_profile_value(profile.available_permission_modes, permission_mode, allow_empty=False):
        logger.info(
            "Pipeline: replacing stale permission mode %r for %s with %r",
            permission_mode, resolved_cli, default_permission_mode,
        )
        permission_mode = default_permission_mode or defaults.get("permission_mode", "auto")

    if profile.effort_levels:
        # None = the CLI's own default (the user's effortLevel for Claude).
        effort = cfg.get("effort") or defaults.get("effort") or None
        if effort and effort not in profile.effort_levels:
            effort = defaults.get("effort") or None
    else:
        effort = None

    # Build name
    cli_label = profile.label
    if session_type == "tester":
        type_label = "Testing Worker"
    elif session_type == "documentor":
        type_label = "Documentation Worker"
    else:
        type_label = session_type.capitalize() if session_type != "worker" else "Worker"
    name = f"Pipeline {type_label} ({cli_label})"
    db_session_type = _storage_session_type(session_type)
    initial_tags = []
    capability_tag = _capability_tag_for_session_type(session_type)
    if capability_tag:
        initial_tags.append(capability_tag)

    # Commander-typed pipeline stages need the orchestrator system prompt,
    # the tool deny-list, and the builtin-commander MCP attached — otherwise
    # the auto-created session is a bare Claude with no delegation tools and
    # no enforcement, so it falls back to implementing inline.
    extra_system_prompt = None
    extra_disallowed = None
    attach_commander_mcp = False
    if session_type == "planner":
        extra_system_prompt = PIPELINE_PLANNER_SYSTEM_PROMPT
    elif session_type == "commander":
        try:
            from config import COMMANDER_SYSTEM_PROMPT, COMMANDER_DISALLOWED_TOOLS
            extra_system_prompt = COMMANDER_SYSTEM_PROMPT
            try:
                from orchestration_policy import render_policy_for_prompt
                cur = await db.execute(
                    "SELECT orchestration_policy, inherit_orchestration_policy_from FROM workspaces WHERE id = ?", (workspace_id,)
                )
                ws = await cur.fetchone()
                if ws:
                    policy_str = ws["orchestration_policy"]
                    if ws["inherit_orchestration_policy_from"]:
                        from db import resolve_workspace_orchestration_policy
                        policy_str = await resolve_workspace_orchestration_policy(db, workspace_id)
                    extra_system_prompt += "\n\n" + render_policy_for_prompt(policy_str)
            except Exception as policy_exc:
                logger.debug("Pipeline: commander policy prompt skipped: %s", policy_exc)
            extra_disallowed = json.dumps(COMMANDER_DISALLOWED_TOOLS)
            attach_commander_mcp = True
        except Exception as _e:
            logger.warning("Pipeline: could not load Commander config: %s", _e)

    await db.execute(
        """INSERT INTO sessions
           (id, workspace_id, name, model, permission_mode, effort,
            session_type, cli_type, auto_approve_mcp, task_id,
            system_prompt, disallowed_tools, tags)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)""",
        (session_id, workspace_id, name, model, permission_mode, effort,
         db_session_type, resolved_cli, task_id, extra_system_prompt, extra_disallowed,
         json.dumps(initial_tags)),
    )
    if attach_commander_mcp:
        await db.execute(
            "INSERT OR IGNORE INTO session_mcp_servers "
            "(session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
            (session_id, "builtin-commander"),
        )
    await _ensure_pipeline_stage_tools(session_id, session_type, task_id, db=db)
    await db.commit()

    logger.info("Pipeline: auto-created %s %s session %s", resolved_cli, session_type, session_id[:8])

    if _broadcast_fn:
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        session = dict(await cur.fetchone())
        await _broadcast_fn({"type": "session_created", "session": session})

    # BUG H6: previously the row was inserted but no PTY was ever started, so
    # the very next stage failed the is_alive check. Boot the PTY now via the
    # injected hook (set_pty_start_fn). Without it the auto-create silently
    # leaves the run unable to advance.
    if _pty_start_fn:
        try:
            await _pty_start_fn(session_id)
        except Exception as e:
            logger.warning("Pipeline auto-start PTY failed for %s: %s", session_id[:8], e)

    return session_id


async def _capture_output_summary(session_id: str) -> str:
    """Get a brief output summary from a session's recent output."""
    if _output_buffer_fn is None:
        return ""
    try:
        output = _output_buffer_fn(session_id, 50)
    except Exception:
        logger.warning("Pipeline: output summary capture failed for %s", session_id[:8], exc_info=True)
        return ""
    # Keep the tail: the end of the buffer holds the stage's final answer.
    return output[-2000:] if output else ""


_VAR_RE = None


def _collect_referenced_variables(stages: list[dict]) -> set[str]:
    """Find every {var} placeholder referenced in any stage prompt template."""
    import re
    global _VAR_RE
    if _VAR_RE is None:
        _VAR_RE = re.compile(r'\{([a-zA-Z_]\w*)\}')
    seen: set[str] = set()
    for s in stages or []:
        tpl = s.get("prompt_template") or ""
        if not tpl:
            continue
        for m in _VAR_RE.findall(tpl):
            seen.add(m)
    return seen


def _build_prompt(stage: dict, run: dict) -> str:
    """Build prompt from stage template with variable substitution."""
    template = stage.get("prompt_template", "")
    if not template:
        return ""
    variables = run.get("variables", {})
    if isinstance(variables, str):
        try:
            variables = json.loads(variables)
        except (json.JSONDecodeError, TypeError):
            variables = {}
    # Substitute {variable} placeholders
    import re
    def replacer(m):
        key = m.group(1)
        return str(variables.get(key, m.group(0)))
    return re.sub(r'\{([a-zA-Z_]\w*)\}', replacer, template)


def _is_review_stage(stage: dict) -> bool:
    """Recognize tester/reviewer stages without requiring a special node type."""
    session_type = str(stage.get("session_type") or "").lower()
    role = str((stage.get("agent_config") or {}).get("role") or "").lower()
    if session_type in {"tester", "test_worker", "reviewer"}:
        return True
    if role in {"tester", "code_reviewer", "plan_critic", "reviewer"}:
        return True
    import re
    label = f"{stage.get('id', '')} {stage.get('name', '')}".lower()
    tokens = set(re.findall(r"[a-z0-9]+", label))
    return bool(tokens & {"test", "tests", "tester", "verify", "verification", "review", "reviewer", "audit", "critic"})


def _review_handoff_source(stage: dict, run: dict, defn: dict) -> tuple[str, str | None]:
    """Return the nearest implementation summary and its session id."""
    history = run.get("stage_history") or {}
    config = stage.get("config") or {}
    configured = stage.get("context_from") or config.get("context_from") or []
    if isinstance(configured, str):
        configured = [configured]
    incoming = [
        t.get("source") for t in (defn.get("transitions") or [])
        if t.get("target") == stage.get("id")
    ]
    candidates = list(dict.fromkeys([*configured, *reversed(incoming)]))

    # Prefer an implementation/fix result even if a condition node sits
    # directly between it and the reviewer.
    stage_by_id = {candidate.get("id"): candidate for candidate in defn.get("stages") or []}
    direct_implementation_ids = []
    for sid in candidates:
        candidate = stage_by_id.get(sid) or {}
        words = str(f"{sid} {candidate.get('name', '')}").lower()
        if any(term in words for term in ("implement", "execute", "work", "fix")):
            direct_implementation_ids.append(sid)

    implementation_ids = []
    for candidate in defn.get("stages") or []:
        sid = candidate.get("id")
        if sid == stage.get("id") or sid not in history:
            continue
        words = str(f"{sid} {candidate.get('name', '')}").lower()
        if any(term in words for term in ("implement", "execute", "work", "fix")):
            implementation_ids.append(sid)
    candidates = list(dict.fromkeys([
        *reversed(direct_implementation_ids),
        *reversed(implementation_ids),
        *candidates,
    ]))

    for source_id in candidates:
        source = history.get(source_id) or {}
        summary = source.get("output_summary")
        if not summary and isinstance(source.get("result"), dict):
            summary = json.dumps(source["result"], indent=2)
        if summary:
            return str(summary), source.get("session_id")
    return "", None


async def _with_review_intent(prompt: str, stage: dict, run: dict, defn: dict) -> str:
    """Apply the shared review brief policy to every pipeline review stage."""
    if not _is_review_stage(stage):
        return prompt
    try:
        variables = run.get("variables") or {}
        if isinstance(variables, str):
            variables = json.loads(variables)
        original_prompt = str(
            variables.get("original_prompt")
            or variables.get("user_prompt")
            or variables.get("topic")
            or ""
        ).strip()
        handoff_notes, reviewed_session_id = _review_handoff_source(stage, run, defn)
        task_id = run.get("task_id")
        card = None
        db = await get_db()
        try:
            from review_brief import resolve_review_intent_sources
            resolved_original, card = await resolve_review_intent_sources(
                db,
                reviewed_session_id=reviewed_session_id if not original_prompt else None,
                task_id=task_id,
                fallback_original_prompt=original_prompt,
            )
        finally:
            await db.close()
        from review_brief import build_review_brief
        return build_review_brief(
            prompt,
            original_prompt=resolved_original,
            board_card=card,
            handoff_notes=handoff_notes or (card or {}).get("result_summary"),
        )
    except Exception:
        return prompt


def _resolve_failure_session(defn: dict, run: dict, stage_id: str) -> Optional[str]:
    """Find the session from the stage that triggered this one via on_fail.

    Traces backwards through the graph from the on_fail source (often a
    condition node with no session) until it finds the nearest agent stage
    that has a session_id in stage_history.
    """
    transitions = defn.get("transitions", [])
    stage_history = run.get("stage_history", {})

    incoming_fail = [t for t in transitions
                     if t["target"] == stage_id and t.get("condition") == "on_fail"]

    for t in incoming_fail:
        source_id = t["source"]
        src_hist = stage_history.get(source_id, {})
        # Only follow paths where the source actually completed (i.e. this
        # on_fail edge was the one that fired, not a stale previous iteration)
        if src_hist.get("status") != "completed":
            continue

        # If the source itself has a session, use it
        if src_hist.get("session_id"):
            return src_hist["session_id"]

        # Otherwise BFS backwards to find the nearest stage with a session
        visited = {source_id}
        queue = [source_id]
        while queue:
            current = queue.pop(0)
            incoming = [t2 for t2 in transitions if t2["target"] == current]
            for t2 in incoming:
                pred_id = t2["source"]
                if pred_id in visited:
                    continue
                visited.add(pred_id)
                pred_hist = stage_history.get(pred_id, {})
                if pred_hist.get("session_id"):
                    return pred_hist["session_id"]
                queue.append(pred_id)

    return None


def _find_stage(defn: dict, stage_id: str) -> Optional[dict]:
    for s in defn.get("stages", []):
        if s["id"] == stage_id:
            return s
    return None


# ── Trigger System ──────────────────────────────────────────────────


async def check_triggers(event_name: str, payload: dict):
    """Called by event bus subscribers to check if any pipeline trigger matches."""
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT * FROM pipeline_definitions WHERE status = 'active'"
        )
        rows = await cur.fetchall()
    finally:
        await db.close()

    for row in rows:
        defn = _deserialize_definition(dict(row))
        triggers = defn.get("triggers", [])
        for trigger in triggers:
            if not trigger.get("enabled", True):
                continue
            if await _trigger_matches(trigger, event_name, payload, defn):
                # Guard: cooldown
                cooldown = trigger.get("guards", {}).get("cooldown_seconds", 0)
                now = time.time()
                last = _trigger_cooldowns.get(defn["id"], 0)
                if cooldown and (now - last) < cooldown:
                    continue

                # Guard: max concurrent
                max_conc = trigger.get("guards", {}).get("max_concurrent", 0)
                if max_conc:
                    active = await list_runs(pipeline_id=defn["id"], active_only=True)
                    if len(active) >= max_conc:
                        continue

                _trigger_cooldowns[defn["id"]] = now
                logger.info("Pipeline trigger matched: %s for pipeline '%s'",
                           trigger["type"], defn["name"])

                # start_run auto-populates from task_id — just pass trigger context
                asyncio.ensure_future(start_run(
                    defn["id"],
                    workspace_id=payload.get("workspace_id") or defn.get("workspace_id"),
                    task_id=payload.get("task_id"),
                    variables={"trigger_type": trigger["type"]},
                    trigger_type=trigger["type"],
                ))


async def _trigger_matches(
    trigger: dict, event_name: str, payload: dict, defn: dict
) -> bool:
    """Check if a trigger config matches the given event."""
    ttype = trigger.get("type")
    config = trigger.get("config", {})
    filters = trigger.get("filters", {})

    if ttype == "board_column":
        if event_name != CommanderEvent.TASK_STATUS_CHANGED.value:
            return False
        target_column = config.get("column", "")
        new_status = payload.get("new_status", "")
        if target_column and new_status != target_column:
            return False
        # Check filters
        if filters.get("labels"):
            task_labels = payload.get("labels", "")
            if isinstance(task_labels, str):
                task_labels = [l.strip() for l in task_labels.split(",") if l.strip()]
            if not any(l in task_labels for l in filters["labels"]):
                return False
        if filters.get("priority"):
            if payload.get("priority") not in filters["priority"]:
                return False
        # Check workspace match
        if defn.get("workspace_id"):
            if payload.get("workspace_id") != defn["workspace_id"]:
                return False
        return True

    elif ttype == "pipeline_complete":
        if event_name != str(CommanderEvent.PIPELINE_COMPLETED):
            return False
        # A chaining "pipeline_complete" trigger fires on a SUCCESSFUL upstream run
        # only. PIPELINE_COMPLETED is now also emitted on a FAILED run (so the Brain
        # completion bridge sees failures — _fail_stage), but a failed upstream must
        # NOT kick off a downstream chain. Preserve the prior behavior: only a
        # success status ("completed"/"max_iterations") chains.
        if str(payload.get("status") or "").lower() not in ("completed", "max_iterations"):
            return False
        source_pipeline = config.get("pipeline_id", "")
        return payload.get("pipeline_id") == source_pipeline

    return False


# ── Pipeline / Auto-exec Coordination ──────────────────────────


def is_task_in_pipeline(task_id: str) -> bool:
    """Return True if a pipeline run is currently handling this task.

    Called by auto_exec to skip tasks that pipelines own.
    """
    return task_id in _pipeline_task_ids


async def task_owned_by_engine(task_id: str, event_name: str | None = None,
                               payload: dict | None = None) -> bool:
    """Whether this engine owns ``task_id``'s flow, so the legacy
    implement → test → document loop in pipeline.py must stay out.

    Owned means an active run already handles the task, or the given task
    event matches an enabled trigger and will start one. Task execution
    runs set ``tasks.pipeline = 1``, so without this check both engines
    reacted to the same TASK_STATUS_CHANGED (e.g. a worker reporting
    "review" was routed to the legacy tester while the run's own Verify
    stage ran too).
    """
    if not task_id:
        return False
    if task_id in _pipeline_task_ids:
        return True
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT 1 FROM pipeline_runs WHERE task_id = ? AND status IN ('running', 'paused') LIMIT 1",
            (task_id,),
        )
        if await cur.fetchone():
            return True
        if event_name is None:
            return False
        cur = await db.execute("SELECT * FROM pipeline_definitions WHERE status = 'active'")
        rows = await cur.fetchall()
    finally:
        await db.close()
    for row in rows:
        defn = _deserialize_definition(dict(row))
        for trigger in defn.get("triggers", []):
            if trigger.get("enabled", True) and await _trigger_matches(trigger, event_name, payload or {}, defn):
                return True
    return False


# ── Broadcast ───────────────────────────────────────────────────────


async def _broadcast_run(run: Optional[dict]):
    if not run or not _broadcast_fn:
        return
    await _broadcast_fn({
        "type": "pipeline_run_update",
        "run": run,
    })


# ── Task Execution Pipelines ────────────────────────────────────────


def _task_stage_prompt() -> str:
    return (
        "Task ID: {task_id}\n"
        "Title: {task_title}\n"
        "Description:\n{task_description}\n\n"
        "Acceptance criteria:\n{task_criteria}\n\n"
        "Labels: {task_labels}\n"
        "{execution_context}"
    )


def _bool_execution_option(options: dict, key: str, fallback: bool) -> bool:
    """Read a bool-ish execution option while preserving omitted values."""
    if key not in options or options.get(key) is None:
        return fallback
    value = options.get(key)
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return fallback


def _int_execution_option(options: dict, key: str, fallback: int) -> int:
    if key not in options or options.get(key) in (None, ""):
        return fallback
    try:
        return int(options.get(key))
    except (TypeError, ValueError):
        return fallback


def _policy_role_option(policy_roles: dict, keys: list[str], fallback: str) -> str:
    """Resolve a requested policy role from aliases, falling back if unknown."""
    try:
        from orchestration_policy import ROLE_LABELS
        allowed = set(ROLE_LABELS)
    except Exception:
        allowed = {
            "brain", "summary", "brainstormer", "planner", "plan_critic",
            "default_worker", "cheap_worker", "strong_worker",
            "code_reviewer", "tester", "documentor",
        }
    for key in keys:
        role = str(policy_roles.get(key) or "").strip()
        if role in allowed:
            return role
    return fallback


async def start_task_execution_pipeline(
    task_id: str,
    *,
    execution_context: str = "",
    assigned_session_id: str | None = None,
    options: dict | None = None,
) -> Optional[dict]:
    """Reuse active runs and keyed retries, including after server restarts."""
    options = options if isinstance(options, dict) else {}
    request_id = options.get("request_id")
    if request_id is not None:
        try:
            request_id = str(uuid.UUID(request_id))
        except (ValueError, TypeError, AttributeError):
            raise ValueError("request_id must be a UUID")
        options = {**options, "request_id": request_id}
    async with _task_execution_lock:
        db = await get_db()
        try:
            cur = await db.execute(
                """SELECT * FROM pipeline_runs WHERE task_id = ? AND
                   (status IN ('running', 'paused') OR
                    (? IS NOT NULL AND json_extract(variables, '$.request_id') = ?))
                   ORDER BY CASE WHEN status IN ('running', 'paused') THEN 0 ELSE 1 END,
                            created_at DESC, rowid DESC LIMIT 1""",
                (task_id, request_id, request_id),
            )
            existing = await cur.fetchone()
            if existing:
                return _deserialize_run(dict(existing))
        finally:
            await db.close()
        return await _start_task_execution_pipeline(
            task_id, execution_context=execution_context,
            assigned_session_id=assigned_session_id, options=options,
        )


async def _start_task_execution_pipeline(
    task_id: str,
    *,
    execution_context: str = "",
    assigned_session_id: str | None = None,
    options: dict | None = None,
) -> Optional[dict]:
    """Create a visible pipeline run for a task's complex execution flags."""
    options = options if isinstance(options, dict) else {}
    policy_roles = options.get("policy_roles") if isinstance(options.get("policy_roles"), dict) else {}
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        row = await cur.fetchone()
        if not row:
            return None
        task = dict(row)
        reuse_existing_assignment = not assigned_session_id and bool(task.get("assigned_session_id"))
        if reuse_existing_assignment:
            assigned_session_id = task["assigned_session_id"]
            await _validate_existing_task_assignee(db, task_id, task["workspace_id"], assigned_session_id)
    finally:
        await db.close()

    workspace_id = task.get("workspace_id")
    title = task.get("title") or f"Task {task_id[:8]}"
    plan_first = _bool_execution_option(options, "plan_first", bool(task.get("plan_first")))
    auto_approve_plan = _bool_execution_option(options, "auto_approve_plan", bool(task.get("auto_approve_plan")))
    deep_research = _bool_execution_option(options, "deep_research", bool(task.get("deep_research")))
    ralph_loop = _bool_execution_option(options, "ralph_loop", bool(task.get("ralph_loop")))
    test_with_agent = _bool_execution_option(options, "test_with_agent", bool(task.get("test_with_agent")))
    pipeline_enabled = _bool_execution_option(options, "pipeline", bool(task.get("pipeline")))
    max_iterations = _int_execution_option(options, "pipeline_max_iterations", int(task.get("pipeline_max_iterations") or DEFAULT_MAX_ITERATIONS))
    should_verify = test_with_agent or ralph_loop
    require_result_review = _bool_execution_option(options, "require_result_review", False)
    planner_role = _policy_role_option(policy_roles, ["planner", "plan"], "planner")
    critic_role = _policy_role_option(policy_roles, ["plan_critic", "critic"], "plan_critic")
    implement_role = _policy_role_option(
        policy_roles, ["implement", "worker"], "strong_worker" if ralph_loop else "default_worker"
    )
    verify_role = _policy_role_option(policy_roles, ["verify", "tester"], "tester")
    fix_role = _policy_role_option(policy_roles, ["fix", "implement", "worker"], "strong_worker")

    stages: list[dict] = []
    transitions: list[dict] = []

    def add_stage(stage: dict):
        stages.append(stage)

    def link(source: str, target: str, condition: str = "always", label: str = ""):
        transitions.append({
            "id": f"t{len(transitions) + 1}",
            "source": source,
            "target": target,
            "condition": condition,
            "label": label,
            "condition_config": {},
        })

    previous: str | None = None
    context_sources: list[str] = []

    if deep_research:
        add_stage({
            "id": "research",
            "name": "Research",
            "type": "research",
            "prompt_template": "Research implementation context for this task:\n\n" + _task_stage_prompt(),
            "position": {"x": 80, "y": 180},
            "config": {"icon": "search", "depth": "standard"},
        })
        previous = "research"
        context_sources.append("research")

    if plan_first:
        add_stage({
            "id": "plan",
            "name": "Plan",
            "type": "agent",
            "session_type": "planner",
            "fresh_session": True,
            "prompt_template": (
                "Create an implementation plan for this task. Do not edit files. "
                "Use get_my_task first. When the plan is complete, call report_pipeline_result "
                "with status='pass' and put the plan in the summary.\n\n" + _task_stage_prompt()
            ),
            "context_from": list(context_sources),
            "position": {"x": 300, "y": 180},
            "config": {"icon": "map"},
            "agent_config": {"role": planner_role, "permission_mode": "plan"},
        })
        if previous:
            link(previous, "plan")

        add_stage({
            "id": "plan_critic",
            "name": "Plan Review",
            "type": "agent",
            "session_type": "planner",
            "fresh_session": True,
            "prompt_template": (
                "Review the proposed plan before implementation. Do not edit files. "
                "Return status='pass' if the plan is concrete and safe to execute, or "
                "status='fail' with specific gaps if it needs revision. Use report_pipeline_result.\n\n"
                + _task_stage_prompt()
            ),
            "context_from": ["plan", *context_sources],
            "position": {"x": 520, "y": 180},
            "config": {"icon": "shield"},
            "agent_config": {"role": critic_role, "permission_mode": "plan"},
        })
        link("plan", "plan_critic")

        add_stage({
            "id": "plan_gate",
            "name": "Plan Gate",
            "type": "condition",
            "position": {"x": 740, "y": 180},
            "config": {
                "mode": "keyword", "require_report": True,
                "icon": "git-branch",
                "pass_keywords": ["__pipeline_result:pass", "pass", "approved"],
                "fail_keywords": ["__pipeline_result:fail", "fail", "gap", "unsafe"],
            },
        })
        link("plan_critic", "plan_gate")
        link("plan_gate", "plan", "on_fail", "Revise plan")

        if auto_approve_plan:
            previous = "plan_gate"
        else:
            add_stage({
                "id": "approval",
                "name": "Plan Approval",
                "type": "approval",
                "position": {"x": 960, "y": 180},
                "config": {"icon": "pause", "auto_approve": False},
            })
            link("plan_gate", "approval", "on_pass", "Approve")
            previous = "approval"
        context_sources.extend(["plan", "plan_critic"])

    add_stage({
        "id": "implement",
        "name": "Implement",
        "type": "agent",
        "session_type": "worker",
        "session_id": assigned_session_id,
        "fresh_session": not bool(assigned_session_id),
        "prompt_template": (
            "Implement this task completely. Use get_my_task first. "
            "Update the task to in_progress when you start. When implementation is complete, "
            "call report_pipeline_result with status='pass' and a concise summary. "
            "In the summary explain the previous behavior, the new behavior, files changed, "
            "and any remaining limitations. Include a preview URL only if you actually started and checked it. "
            "Do not mark the task done; the pipeline owns final status.\n\n" + _task_stage_prompt()
        ),
        "context_from": list(context_sources),
        "position": {"x": 1180 if plan_first else 320, "y": 180},
        "config": {"icon": "code", "require_existing_assignment": reuse_existing_assignment},
        "agent_config": {"role": implement_role, "permission_mode": "auto"},
    })
    if previous:
        link(previous, "implement", "on_pass" if previous == "plan_gate" else "always")
    previous = "implement"

    if should_verify:
        add_stage({
            "id": "verify",
            "name": "Verify",
            "type": "agent",
            "session_type": "tester",
            "fresh_session": True,
            "prompt_template": (
                "Verify this task against the acceptance criteria. Run relevant tests/builds and, "
                "for UI work, use Playwright/browser checks. Do not edit source files. "
                "Use report_pipeline_result with status='pass' only if verification passes; otherwise status='fail'.\n\n"
                "Include the commands run and their results, acceptance criteria checked, "
                "and anything that could not be verified. Never claim an unrun check passed.\n\n"
                + _task_stage_prompt()
            ),
            "context_from": ["implement", *context_sources],
            "position": {"x": 1400 if plan_first else 540, "y": 180},
            "config": {"icon": "check-circle"},
            "agent_config": {"role": verify_role, "permission_mode": "auto"},
        })
        link("implement", "verify")

        add_stage({
            "id": "verify_gate",
            "name": "Verify Gate",
            "type": "condition",
            "position": {"x": 1620 if plan_first else 760, "y": 180},
            "config": {
                "mode": "keyword", "require_report": True,
                "icon": "git-branch",
                "pass_keywords": ["__pipeline_result:pass", "pass", "passed", "verified"],
                "fail_keywords": ["__pipeline_result:fail", "fail", "failed", "broken", "error"],
            },
        })
        link("verify", "verify_gate")

        if ralph_loop:
            add_stage({
                "id": "fix",
                "name": "Fix",
                "type": "agent",
                "session_type": "worker",
                "reuse_session_from": "implement",
                "prompt_template": (
                    "Fix the issues found by verification. Address root causes, then call "
                    "report_pipeline_result with status='pass' and a concise fix summary.\n\n"
                    + _task_stage_prompt()
                ),
                "context_from": ["verify", "implement", *context_sources],
                "position": {"x": 1400 if plan_first else 540, "y": 360},
                "config": {"icon": "wrench"},
                "agent_config": {"role": fix_role, "permission_mode": "auto"},
            })
            link("verify_gate", "fix", "on_fail", "Fix")
            link("fix", "verify", "always", "Re-verify")
        else:
            add_stage({
                "id": "blocked",
                "name": "Mark Blocked",
                "type": "task_update",
                "prompt_template": "Verification failed. See pipeline verification summary.",
                "position": {"x": 1840 if plan_first else 980, "y": 300},
                "config": {"icon": "x", "status": "blocked", "pipeline_stage": "blocked"},
            })
            link("verify_gate", "blocked", "on_fail", "Blocked")

        add_stage({
            "id": "done",
            "name": "Ready for Review" if require_result_review else "Mark Done",
            "type": "task_update",
            "prompt_template": "Verification passed. Review the implementation and verification reports before accepting." if require_result_review else "Pipeline completed successfully.",
            "position": {"x": 1840 if plan_first else 980, "y": 120},
            "config": {"icon": "check", "status": "review" if require_result_review else "done", "pipeline_stage": "review" if require_result_review else "done"},
        })
        link("verify_gate", "done", "on_pass", "Done")
    else:
        add_stage({
            "id": "review",
            "name": "Mark Review",
            "type": "task_update",
            "prompt_template": "Implementation completed and is ready for review.",
            "position": {"x": 1400 if plan_first else 540, "y": 180},
            "config": {"icon": "eye", "status": "review", "pipeline_stage": "review"},
        })
        link("implement", "review")

    definition = await create_definition({
        "name": f"Task Execution - {title[:80]}",
        "description": "Generated visible task execution pipeline.",
        "workspace_id": workspace_id,
        "stages": stages,
        "transitions": transitions,
        "triggers": [],
        "status": "active",
    })

    db = await get_db()
    try:
        await db.execute(
            """UPDATE tasks
               SET plan_first = ?, auto_approve_plan = ?, deep_research = ?,
                   ralph_loop = ?, test_with_agent = ?, pipeline = 1,
                   pipeline_max_iterations = ?, pipeline_stage = 'queued', status = ?,
                   updated_at = datetime('now')
               WHERE id = ?""",
            (
                1 if plan_first else 0,
                1 if auto_approve_plan else 0,
                1 if deep_research else 0,
                1 if ralph_loop else 0,
                1 if test_with_agent else 0,
                max(1, min(max_iterations, 20)),
                "planning" if plan_first else "in_progress",
                task_id,
            ),
        )
        await db.commit()
    finally:
        await db.close()

    return await start_run(
        definition["id"],
        workspace_id=workspace_id,
        task_id=task_id,
        variables={"execution_context": execution_context or "", "request_id": options.get("request_id"), "require_result_review": require_result_review},
        trigger_type="task_execute",
        max_iterations=max(1, min(max_iterations, 20)),
    )


# ── Presets ─────────────────────────────────────────────────────────


PRESETS = {
    "research-loop": {
        "name": "Research Loop",
        "description": "Research -> Plan -> Implement -> Test -> Document -> Loop. The full CI/CD agent cycle, ending with docs once tests pass.",
        "stages": [
            {
                "id": "research", "name": "Research", "type": "agent",
                "session_type": "worker", "prompt_template": "Research improvements and opportunities for {topic}. Focus on actionable findings with clear implementation paths.",
                "position": {"x": 80, "y": 200}, "config": {"icon": "search"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto"},
            },
            {
                "id": "plan", "name": "Plan", "type": "agent",
                "session_type": "commander", "prompt_template": "Based on the research findings, create implementation tasks. Branch if needed. Assign clear scope to each task.",
                "position": {"x": 320, "y": 200}, "config": {"icon": "map"},
                "agent_config": {"model": "opus", "permission_mode": "plan"},
            },
            {
                "id": "implement", "name": "Implement", "type": "agent",
                "session_type": "worker", "prompt_template": "Implement the planned changes. Follow the task description and acceptance criteria. Write tests alongside code.",
                "position": {"x": 560, "y": 200}, "config": {"icon": "code"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto"},
            },
            {
                "id": "test", "name": "Test", "type": "agent",
                "session_type": "tester", "prompt_template": "Run the test suite and verify the implementation. Report results clearly. When done, use the report_pipeline_result tool with status 'pass' or 'fail' and a summary.",
                "position": {"x": 800, "y": 200}, "config": {"icon": "check-circle"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto"},
            },
            {
                "id": "evaluate", "name": "Evaluate", "type": "condition",
                "session_type": None, "prompt_template": "",
                "position": {"x": 1040, "y": 200},
                "config": {"mode": "keyword", "require_report": True, "icon": "git-branch",
                           "pass_keywords": ["pass", "passed", "success", "all tests"],
                           "fail_keywords": ["fail", "failed", "error", "broken"]},
            },
            {
                "id": "document", "name": "Document", "type": "agent",
                "session_type": "documentor",
                "prompt_template": "Document the just-shipped changes for {topic}. Inspect the relevant git commits, capture screenshots of new UI, record GIF workflows for new flows, and update the docs site. Use the documentor MCP tools (get_changes_since, screenshot_page, record_workflow, update_docs_manifest, build_docs), and include task IDs plus relevant commit_shas in update_docs_manifest.",
                "position": {"x": 1280, "y": 200}, "config": {"icon": "book-open"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto"},
            },
        ],
        "transitions": [
            {"id": "t1", "source": "research", "target": "plan", "condition": "always", "label": ""},
            {"id": "t2", "source": "plan", "target": "implement", "condition": "always", "label": ""},
            {"id": "t3", "source": "implement", "target": "test", "condition": "always", "label": ""},
            {"id": "t4", "source": "test", "target": "evaluate", "condition": "always", "label": ""},
            {"id": "t5", "source": "evaluate", "target": "document", "condition": "on_pass", "label": "Document", "condition_config": {}},
            {"id": "t6", "source": "evaluate", "target": "implement", "condition": "on_fail", "label": "Retry", "condition_config": {}},
            {"id": "t7", "source": "document", "target": "research", "condition": "always", "label": "Next cycle"},
        ],
        "triggers": [],
    },
    "tdd-loop": {
        "name": "TDD Loop",
        "description": "Implement -> Test -> Fix -> Repeat until green.",
        "stages": [
            {
                "id": "implement", "name": "Implement", "type": "agent",
                "session_type": "worker", "prompt_template": "Implement the feature: {topic}. Write code with tests.",
                "position": {"x": 200, "y": 200}, "config": {"icon": "code"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto"},
            },
            {
                "id": "test", "name": "Test", "type": "agent",
                "session_type": "tester", "prompt_template": "Run all tests. When done, use the report_pipeline_result tool with status 'pass' or 'fail' and a summary of results.",
                "position": {"x": 500, "y": 200}, "config": {"icon": "check-circle"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto"},
            },
            {
                "id": "evaluate", "name": "Evaluate", "type": "condition",
                "session_type": None, "prompt_template": "",
                "position": {"x": 800, "y": 200},
                "config": {"mode": "keyword", "require_report": True, "icon": "git-branch",
                           "pass_keywords": ["pass", "passed", "success"],
                           "fail_keywords": ["fail", "failed", "error"]},
            },
        ],
        "transitions": [
            {"id": "t1", "source": "implement", "target": "test", "condition": "always", "label": ""},
            {"id": "t2", "source": "test", "target": "evaluate", "condition": "always", "label": ""},
            {"id": "t3", "source": "evaluate", "target": "implement", "condition": "on_fail", "label": "Fix", "condition_config": {}},
        ],
        "triggers": [],
    },
    "review-loop": {
        "name": "Review Loop",
        "description": "Implement -> Code Review -> Revise -> Repeat until approved.",
        "stages": [
            {
                "id": "implement", "name": "Implement", "type": "agent",
                "session_type": "worker", "prompt_template": "Implement: {topic}",
                "position": {"x": 200, "y": 200}, "config": {"icon": "code"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto"},
            },
            {
                "id": "review", "name": "Review", "type": "agent",
                "session_type": "commander", "prompt_template": "Review the changes. Check code quality, correctness, and test coverage. Use the report_pipeline_result tool: 'pass' if approved or 'fail' with specific feedback.",
                "position": {"x": 500, "y": 200}, "config": {"icon": "eye"},
                "agent_config": {"model": "opus", "permission_mode": "plan"},
            },
            {
                "id": "evaluate", "name": "Evaluate", "type": "condition",
                "session_type": None, "prompt_template": "",
                "position": {"x": 800, "y": 200},
                "config": {"mode": "keyword", "require_report": True, "icon": "git-branch",
                           "pass_keywords": ["approved", "pass", "lgtm"],
                           "fail_keywords": ["changes requested", "fail", "rejected"]},
            },
        ],
        "transitions": [
            {"id": "t1", "source": "implement", "target": "review", "condition": "always", "label": ""},
            {"id": "t2", "source": "review", "target": "evaluate", "condition": "always", "label": ""},
            {"id": "t3", "source": "evaluate", "target": "implement", "condition": "on_fail", "label": "Revise", "condition_config": {}},
        ],
        "triggers": [],
    },
    "verification-cascade": {
        "name": "Verification Cascade",
        "description": "Unit Tests -> E2E Tests -> Quality Audit, with fix-and-restart at every level. Escalating verification that checks if outputs are actually useful, not just working.",
        "stages": [
            {
                "id": "unit_test", "name": "Unit Tests", "type": "agent",
                "session_type": "tester",
                "prompt_template": (
                    "Run unit tests for {topic}. Use pytest or the project's test framework. "
                    "If relevant tests don't exist yet, write them first — cover core logic, edge cases, and gating conditions. "
                    "When done, use the report_pipeline_result tool with status 'pass' if all tests pass, or 'fail' with the failure summary."
                ),
                "position": {"x": 100, "y": 150}, "config": {"icon": "test-tubes"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto"},
            },
            {
                "id": "unit_eval", "name": "Unit Gate", "type": "condition",
                "session_type": None, "prompt_template": "",
                "position": {"x": 280, "y": 150},
                "config": {"mode": "keyword", "require_report": True, "icon": "git-branch",
                           "pass_keywords": ["pass", "passed", "success", "all tests"],
                           "fail_keywords": ["fail", "failed", "error", "broken"]},
            },
            {
                "id": "e2e_test", "name": "E2E Tests", "type": "agent",
                "session_type": "tester",
                "prompt_template": (
                    "Test {topic} end-to-end against the running system. Hit real API endpoints, start real sessions, "
                    "verify WebSocket events arrive, check database state. Don't mock — test actual behavior. "
                    "Verify the feature behaves as intended, not just that it doesn't crash. "
                    "When done, use the report_pipeline_result tool with 'pass' or 'fail' and a behavioral summary."
                ),
                "position": {"x": 460, "y": 150}, "config": {"icon": "monitor"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto"},
            },
            {
                "id": "e2e_eval", "name": "E2E Gate", "type": "condition",
                "session_type": None, "prompt_template": "",
                "position": {"x": 640, "y": 150},
                "config": {"mode": "keyword", "require_report": True, "icon": "git-branch",
                           "pass_keywords": ["pass", "passed", "success", "verified"],
                           "fail_keywords": ["fail", "failed", "error", "broken", "unexpected"]},
            },
            {
                "id": "quality_audit", "name": "Quality Audit", "type": "agent",
                "session_type": "commander",
                "prompt_template": (
                    "Audit the output quality of {topic}. This is NOT a correctness check — the previous stages already verified that. "
                    "Your job: run the feature with realistic inputs and evaluate whether the outputs are actually USEFUL to a human user. "
                    "Check: Are generated texts meaningful and relevant? Are suggestions actionable? Do edge cases produce reasonable results or garbage? "
                    "Test with at least 3 different realistic scenarios. Compare outputs against what a good human-crafted version would look like. "
                    "Report 'pass' via report_pipeline_result only if outputs are production-quality. "
                    "Report 'fail' with specific examples of low-quality output and what 'good' would look like."
                ),
                "position": {"x": 820, "y": 150}, "config": {"icon": "eye"},
                "agent_config": {"model": "opus", "permission_mode": "plan"},
            },
            {
                "id": "quality_eval", "name": "Quality Gate", "type": "condition",
                "session_type": None, "prompt_template": "",
                "position": {"x": 1000, "y": 150},
                "config": {"mode": "keyword", "require_report": True, "icon": "git-branch",
                           "pass_keywords": ["pass", "production-quality", "approved", "useful"],
                           "fail_keywords": ["fail", "low-quality", "garbage", "misleading", "wrong"]},
            },
            {
                "id": "fix", "name": "Fix", "type": "agent",
                "session_type": "worker",
                "reuse_session_from": "__from_failure__",
                "prompt_template": (
                    "Fix the issues found during verification of {topic}. Address the root cause, not just symptoms. "
                    "If the quality audit flagged misleading outputs, fix the data/context the feature uses, not just the formatting. "
                    "If unit or e2e tests failed, fix the code and update tests if needed."
                ),
                "position": {"x": 550, "y": 350}, "config": {"icon": "wrench"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto"},
            },
        ],
        "transitions": [
            {"id": "t1", "source": "unit_test", "target": "unit_eval", "condition": "always", "label": ""},
            {"id": "t2", "source": "unit_eval", "target": "e2e_test", "condition": "on_pass", "label": "Tests pass", "condition_config": {}},
            {"id": "t3", "source": "unit_eval", "target": "fix", "condition": "on_fail", "label": "Tests fail", "condition_config": {}},
            {"id": "t4", "source": "e2e_test", "target": "e2e_eval", "condition": "always", "label": ""},
            {"id": "t5", "source": "e2e_eval", "target": "quality_audit", "condition": "on_pass", "label": "Behavior OK", "condition_config": {}},
            {"id": "t6", "source": "e2e_eval", "target": "fix", "condition": "on_fail", "label": "Behavior wrong", "condition_config": {}},
            {"id": "t7", "source": "quality_audit", "target": "quality_eval", "condition": "always", "label": ""},
            {"id": "t8", "source": "quality_eval", "target": "fix", "condition": "on_fail", "label": "Quality issues", "condition_config": {}},
            {"id": "t9", "source": "fix", "target": "unit_test", "condition": "always", "label": "Re-verify from start"},
        ],
        "triggers": [],
    },
    "ralph-pipeline": {
        "name": "RALPH Pipeline",
        "description": "Execute -> Verify -> Fix -> Repeat. Multi-agent version of RALPH mode.",
        "stages": [
            {
                "id": "execute", "name": "Execute", "type": "agent",
                "session_type": "worker", "prompt_template": "Execute the task: {topic}. Do the work completely.",
                "position": {"x": 150, "y": 200}, "config": {"icon": "zap"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto"},
            },
            {
                "id": "verify", "name": "Verify", "type": "agent",
                "session_type": "tester", "prompt_template": "Verify the work is correct. Run tests, check output, validate behavior. When done, use the report_pipeline_result tool with status 'pass' or 'fail' and a summary.",
                "position": {"x": 450, "y": 200}, "config": {"icon": "shield"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto"},
            },
            {
                "id": "evaluate", "name": "Evaluate", "type": "condition",
                "session_type": None, "prompt_template": "",
                "position": {"x": 750, "y": 200},
                "config": {"mode": "keyword", "require_report": True, "icon": "git-branch",
                           "pass_keywords": ["pass", "verified", "correct"],
                           "fail_keywords": ["fail", "incorrect", "broken"]},
            },
            {
                "id": "fix", "name": "Fix", "type": "agent",
                "session_type": "worker",
                "reuse_session_from": "execute",
                "prompt_template": "Fix the issues found during verification. Apply the feedback.",
                "position": {"x": 600, "y": 380}, "config": {"icon": "wrench"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto"},
            },
        ],
        "transitions": [
            {"id": "t1", "source": "execute", "target": "verify", "condition": "always", "label": ""},
            {"id": "t2", "source": "verify", "target": "evaluate", "condition": "always", "label": ""},
            {"id": "t3", "source": "evaluate", "target": "fix", "condition": "on_fail", "label": "Fix issues", "condition_config": {}},
            {"id": "t4", "source": "fix", "target": "verify", "condition": "always", "label": "Re-verify"},
        ],
        "triggers": [],
    },
    "auto-dispatch": {
        "name": "Auto-Dispatch",
        "description": (
            "When a task enters Todo, automatically route it to Commander to spawn a worker "
            "and begin implementation. Enable the board_column trigger to make todo tasks "
            "self-dispatching. Commander checks current in_progress load before acting."
        ),
        "stages": [
            {
                "id": "dispatch",
                "name": "Dispatch to Worker",
                "type": "agent",
                "session_type": "commander",
                "prompt_template": (
                    "A task just entered the Todo queue and needs a worker:\n\n"
                    "Title: {task_title}\n"
                    "Task ID: {task_id}\n"
                    "Priority: {task_priority}\n"
                    "Description: {task_description}\n"
                    "Acceptance criteria: {task_criteria}\n\n"
                    "Steps:\n"
                    "1. Call list_tasks(status_filter='in_progress') to check current workload.\n"
                    "2. If the task is already in_progress (another agent claimed it), stop — do nothing.\n"
                    "3. If you have capacity under your max_workers limit, call "
                    "create_session(task_id='{task_id}') to spawn a worker. "
                    "The worker will automatically mark the task in_progress and update status when done.\n"
                    "4. If at max capacity, call update_task(task_id='{task_id}', status='backlog', "
                    "result_summary='Queue full — requeued to backlog') to hold it until a slot opens."
                ),
                "position": {"x": 300, "y": 200},
                "config": {"icon": "send"},
                "agent_config": {"model": "opus", "permission_mode": "auto"},
            }
        ],
        "transitions": [],
        "triggers": [
            {
                "type": "board_column",
                "config": {"column": "todo"},
                "guards": {"max_concurrent": 10, "cooldown_seconds": 2},
                "enabled": True,
            }
        ],
    },
}


async def start_ralph(session_id: str, task_prompt: str, workspace_id: str = None) -> Optional[dict]:
    """Quick-start a RALPH pipeline run wired to the given session.

    Called by the @ralph token expansion.  Uses the current session as the
    executor (execute + fix stages) and auto-resolves a tester session.
    """
    # Find the RALPH preset definition
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT id FROM pipeline_definitions WHERE preset_key = 'ralph-pipeline' LIMIT 1"
        )
        row = await cur.fetchone()
        if not row:
            logger.error("RALPH preset not found — run ensure_presets() first")
            return None
        pipeline_id = row["id"]

        # Resolve workspace from session if not provided
        if not workspace_id:
            cur = await db.execute(
                "SELECT workspace_id FROM sessions WHERE id = ?", (session_id,)
            )
            srow = await cur.fetchone()
            workspace_id = srow["workspace_id"] if srow else None
    finally:
        await db.close()

    if not workspace_id:
        logger.error("Cannot start RALPH — no workspace for session %s", session_id)
        return None

    # Override the execute + fix stages to use the caller's session
    defn = await get_definition(pipeline_id)
    if not defn:
        return None

    # Patch stage session_ids: execute + fix → caller session
    for stage in defn.get("stages", []):
        if stage["id"] in ("execute", "fix"):
            stage["session_id"] = session_id
            stage["prompt_template"] = task_prompt if stage["id"] == "execute" else stage["prompt_template"]

    # Persist a private recipe BEFORE scheduling any work. Mutating the loaded
    # dict or stage_history after start_run loses overrides and races the first
    # stage; editing the shared preset would also cross-wire concurrent callers.
    run_definition = await create_definition({
        "name": "Auto-fix loop",
        "description": "Session-specific execute, verify, and fix workflow.",
        "workspace_id": workspace_id,
        "stages": defn.get("stages", []),
        "transitions": defn.get("transitions", []),
        "triggers": [],
        "status": "draft",
    })
    return await start_run(
        run_definition["id"],
        workspace_id=workspace_id,
        variables={"topic": task_prompt},
        trigger_type="ralph_token",
    )


async def ensure_presets():
    """Create or update built-in preset pipelines."""
    db = await get_db()
    try:
        # BUG L9: older code paths inserted presets with preset_key=NULL, so
        # repeat startups accumulated duplicates. Backfill preset_key on
        # legacy rows by matching on name (the only stable identifier we
        # had at the time) and then delete any extra duplicates that share
        # the same preset_key, keeping the oldest.
        for key, preset in PRESETS.items():
            await db.execute(
                """UPDATE pipeline_definitions
                   SET preset_key = ?
                   WHERE preset_key IS NULL AND preset = 1 AND name = ?""",
                (key, preset["name"]),
            )
            # Keep oldest, delete the rest
            await db.execute(
                """DELETE FROM pipeline_definitions
                   WHERE preset_key = ?
                     AND id NOT IN (
                         SELECT id FROM pipeline_definitions
                         WHERE preset_key = ?
                         ORDER BY created_at ASC, id ASC
                         LIMIT 1
                     )""",
                (key, key),
            )

        for key, preset in PRESETS.items():
            cur = await db.execute(
                "SELECT id FROM pipeline_definitions WHERE preset_key = ?", (key,)
            )
            existing = await cur.fetchone()
            if existing:
                # Update existing preset with latest stages/transitions/prompts
                await db.execute(
                    """UPDATE pipeline_definitions
                       SET name = ?, description = ?, stages = ?, transitions = ?,
                           updated_at = datetime('now')
                       WHERE preset_key = ?""",
                    (
                        preset["name"], preset["description"],
                        json.dumps(preset["stages"]),
                        json.dumps(preset["transitions"]),
                        key,
                    ),
                )
            else:
                pid = str(uuid.uuid4())
                await db.execute(
                    """INSERT INTO pipeline_definitions
                       (id, name, description, stages, transitions, triggers,
                        preset, preset_key, status)
                       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'active')""",
                    (
                        pid, preset["name"], preset["description"],
                        json.dumps(preset["stages"]),
                        json.dumps(preset["transitions"]),
                        json.dumps(preset.get("triggers", [])),
                        key,
                    ),
                )
        await db.commit()
        logger.info("Pipeline presets ensured")
    finally:
        await db.close()


# ── Event Bus Subscriptions ─────────────────────────────────────────


def register_subscribers():
    """Wire up event handlers for trigger evaluation."""
    bus.subscribe(CommanderEvent.TASK_STATUS_CHANGED, _on_event)
    bus.subscribe(CommanderEvent.PIPELINE_COMPLETED, _on_event)
    logger.info("Pipeline engine subscribers registered")


async def _on_event(event_name: str, payload: dict):
    """Route events to the trigger checker."""
    try:
        await check_triggers(event_name, payload)
    except Exception as e:
        logger.error("Pipeline trigger check failed: %s", e)


# ── Startup Recovery ────────────────────────────────────────────────


async def recover_active_runs():
    """On server restart, pause interrupted pipelines and rebuild tracking.

    C6: runs whose variables set resumable=true are RE-DRIVEN from their current
    stages instead of paused (opt-in; pair with resume_from_cache to avoid
    re-executing already-completed stages). Default (no flag) is unchanged — every
    running run is paused, exactly as before."""
    db = await get_db()
    try:
        # Identify resumable runs before the blanket pause so we can re-drive them.
        resumable: list[tuple[str, list]] = []
        try:
            cur = await db.execute(
                "SELECT id, current_stages, variables FROM pipeline_runs WHERE status = 'running'"
            )
            for row in await cur.fetchall():
                try:
                    vars_ = json.loads(row["variables"]) if row["variables"] else {}
                except (json.JSONDecodeError, TypeError):
                    vars_ = {}
                if isinstance(vars_, dict) and vars_.get("resumable") is True:
                    try:
                        stages = json.loads(row["current_stages"]) if row["current_stages"] else []
                    except (json.JSONDecodeError, TypeError):
                        stages = []
                    resumable.append((row["id"], stages if isinstance(stages, list) else []))
        except Exception:
            resumable = []

        resumable_ids = {rid for rid, _ in resumable}
        # Pause every running run EXCEPT the opt-in resumable ones.
        cur = await db.execute("SELECT id FROM pipeline_runs WHERE status = 'running'")
        running_ids = [r["id"] for r in await cur.fetchall()]
        to_pause = [rid for rid in running_ids if rid not in resumable_ids]
        for rid in to_pause:
            await db.execute("UPDATE pipeline_runs SET status = 'paused' WHERE id = ?", (rid,))
        if to_pause:
            logger.info("Recovered %d interrupted pipeline runs (set to paused)", len(to_pause))
        await db.commit()

        # Re-drive resumable runs from their current stages (opt-in).
        for rid, stages in resumable:
            logger.info("Pipeline %s: resumable — re-driving %d current stage(s) on restart",
                        rid[:8], len(stages))
            for sid in stages:
                _schedule_stage(rid, sid)

        # Rebuild _pipeline_task_ids from paused runs so auto_exec doesn't
        # steal tasks that a paused pipeline still owns
        cur = await db.execute(
            "SELECT task_id FROM pipeline_runs WHERE status = 'paused' AND task_id IS NOT NULL"
        )
        rows = await cur.fetchall()
        for row in rows:
            _pipeline_task_ids.add(row["task_id"])
        if rows:
            logger.info("Rebuilt pipeline task tracking: %d tasks owned by paused pipelines", len(rows))
    finally:
        await db.close()
