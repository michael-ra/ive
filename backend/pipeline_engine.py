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
import time
import uuid
from typing import Optional

from commander_events import CommanderEvent
from db import get_db
from event_bus import bus

logger = logging.getLogger(__name__)

_pty_manager = None
_broadcast_fn = None
_pty_start_fn = None  # async (session_id) → None; injected from server.py to start PTYs for auto-created sessions (BUG H6)

# In-memory tracking for fast lookup — guarded by _state_lock
_session_to_run: dict[str, str] = {}        # session_id → run_id
_active_runs: dict[str, dict] = {}           # run_id → cached run state
_advance_timers: dict[str, object] = {}      # session_id → TimerHandle
_trigger_cooldowns: dict[str, float] = {}    # pipeline_id → last trigger time
_state_lock = asyncio.Lock()                 # protects all dicts above

ADVANCE_DELAY_S = 1.5
DEFAULT_MAX_ITERATIONS = 20


class PipelineVariableError(ValueError):
    """Raised when a pipeline run references unknown {variable} placeholders."""

    def __init__(self, missing: list[str]):
        self.missing = missing
        super().__init__(f"unknown variables: {', '.join(missing)}")


# Sensible defaults per session_type — used when stage has no explicit agent_config
SESSION_TYPE_DEFAULTS = {
    "worker":     {"model": "sonnet",  "permission_mode": "auto", "effort": "high"},
    "tester":     {"model": "sonnet",  "permission_mode": "auto", "effort": "high"},
    "commander":  {"model": "opus",    "permission_mode": "plan", "effort": "high"},
    "documentor": {"model": "sonnet",  "permission_mode": "auto", "effort": "high"},
}

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
    merged_vars = {**task_vars, **(variables or {})}
    # Drop empty user overrides so task defaults show through
    merged_vars = {k: v for k, v in merged_vars.items() if v}

    stages = defn.get("stages", [])
    transitions = defn.get("transitions", [])

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
                    DEFAULT_MAX_ITERATIONS,
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
        asyncio.ensure_future(_execute_stage(run_id, stage["id"]))

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
        await db.execute(
            "UPDATE pipeline_runs SET status = 'running', updated_at = datetime('now') WHERE id = ?",
            (run_id,),
        )
        await db.commit()
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
        if sh.get("status") in ("pending", "running"):
            asyncio.ensure_future(_execute_stage(run_id, sid))

    await _broadcast_run(run)
    return run


async def cancel_run(run_id: str) -> Optional[dict]:
    run = await get_run(run_id)
    if not run:
        return None
    # Clean up timers, mappings, and task tracking
    stage_history = json.loads(run["stage_history"]) if isinstance(run["stage_history"], str) else run["stage_history"]
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
            "UPDATE pipeline_runs SET status = 'cancelled', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
            (run_id,),
        )
        await db.commit()
    finally:
        await db.close()
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
    if active_only:
        sql += " AND status IN ('running', 'paused')"
    sql += " ORDER BY created_at DESC LIMIT 50"
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


async def _execute_stage(run_id: str, stage_id: str):
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
    logger.info("Pipeline %s: executing stage '%s' (%s)", run_id[:8], stage.get("name"), stage_type)

    # Update stage history
    await _update_stage_status(run_id, stage_id, "running")

    if stage_type == "agent":
        await _execute_agent_stage(run_id, stage_id, stage, run, defn)
    elif stage_type == "condition":
        await _execute_condition_stage(run_id, stage_id, stage, run, defn)
    elif stage_type == "delay":
        delay_s = stage.get("config", {}).get("delay_seconds", 5)
        await asyncio.sleep(delay_s)
        await _complete_stage(run_id, stage_id)
    else:
        logger.warning("Unknown stage type: %s", stage_type)
        await _complete_stage(run_id, stage_id)


async def _execute_agent_stage(
    run_id: str, stage_id: str, stage: dict, run: dict, defn: dict
):
    """Send a prompt to a session and wait for idle."""
    session_id = stage.get("session_id")
    session_type = stage.get("session_type")
    cli_type = stage.get("cli_type")  # 'claude', 'gemini', or None (any)
    agent_config = stage.get("agent_config") or {}
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
        session_id = await _resolve_session(
            ws_id, session_type, cli_type=cli_type, agent_config=agent_config,
        )
    if not session_id:
        logger.error("No session for stage '%s'", stage.get("name"))
        await _fail_stage(run_id, stage_id, "No session configured")
        return

    # Update stage with resolved session
    await _update_stage_session(run_id, stage_id, session_id)

    # Map session → run for idle detection
    async with _state_lock:
        _session_to_run[session_id] = run_id

    # Build prompt from template
    prompt = _build_prompt(stage, run)
    if not prompt:
        logger.warning("Empty prompt for stage '%s', advancing", stage.get("name"))
        await _complete_stage(run_id, stage_id)
        return

    # Inject failure context: when this stage was reached via an on_fail
    # transition, append the failing stage's output so the agent knows
    # exactly what went wrong and what to fix.
    transitions = defn.get("transitions", [])
    stage_history = run.get("stage_history", {})
    incoming_fail = [t for t in transitions
                     if t["target"] == stage_id and t.get("condition") == "on_fail"]
    for t in incoming_fail:
        src_hist = stage_history.get(t["source"], {})
        src_output = src_hist.get("output_summary", "")
        if src_output:
            src_stage = _find_stage(defn, t["source"])
            src_name = src_stage.get("name", t["source"]) if src_stage else t["source"]
            prompt += f"\n\n--- Failure from '{src_name}' ---\n{src_output}"

    # Send to PTY
    if not _pty_manager:
        await _fail_stage(run_id, stage_id, "PTY manager not available")
        return

    if not _pty_manager.is_alive(session_id):
        logger.warning("Session %s PTY not alive for stage '%s'", session_id[:8], stage.get("name"))
        await _fail_stage(run_id, stage_id, "Session PTY not running")
        return

    # CR (\r), not LF — raw-mode CLI TUIs interpret \r as Enter; \n leaves
    # the prompt sitting in the buffer unsubmitted, which previously made
    # workers appear to "finish" with no tool uses.
    data = (prompt + "\r").encode("utf-8")
    _pty_manager.write(session_id, data)
    logger.info("Pipeline %s: sent prompt to session %s for stage '%s'",
                run_id[:8], session_id[:8], stage.get("name"))

    await _broadcast_run(await get_run(run_id))


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
    for t in incoming:
        src = stage_history.get(t["source"], {})
        if src.get("output_summary"):
            prev_output = src["output_summary"]
            break

    # Evaluate condition — check output for pass/fail signals
    condition_result = _evaluate_condition(stage, prev_output)

    # Update stage with result
    await _update_stage_status(run_id, stage_id, "completed", output_summary=condition_result)

    # Find matching outgoing transition
    outgoing = [t for t in transitions if t["source"] == stage_id]
    next_stages = []

    for t in outgoing:
        cond = t.get("condition", "always")
        if cond == "always":
            next_stages.append(t["target"])
        elif cond == "on_pass" and condition_result == "pass":
            next_stages.append(t["target"])
        elif cond == "on_fail" and condition_result == "fail":
            next_stages.append(t["target"])
        elif cond == "on_match":
            pattern = t.get("condition_config", {}).get("pattern", "")
            if pattern and pattern.lower() in prev_output.lower():
                next_stages.append(t["target"])

    if next_stages:
        await _set_current_stages(run_id, next_stages)
        for sid in next_stages:
            asyncio.ensure_future(_execute_stage(run_id, sid))
    else:
        # No matching transitions — pipeline is done
        await _complete_run(run_id)


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
    if not run or run["status"] != "running":
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


# ── Stage Completion & Advancement ──────────────────────────────────


async def _complete_stage(run_id: str, stage_id: str):
    """Mark a stage as completed and advance to the next stage(s)."""
    run = await get_run(run_id)
    if not run or run["status"] != "running":
        return

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

    logger.info("Pipeline %s: stage '%s' completed", run_id[:8], stage_name)

    # Find outgoing transitions
    transitions = defn.get("transitions", [])
    outgoing = [t for t in transitions if t["source"] == stage_id]

    if not outgoing:
        # Terminal stage — check if all active stages are done
        await _check_run_completion(run_id, defn)
        return

    # Check for structured MCP result first (definitive)
    structured = _parse_structured_result(output_summary)

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

    if not next_stages:
        # No transitions matched — check completion
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

    # Set current stages and execute
    await _set_current_stages(run_id, next_stages)
    for sid in next_stages:
        asyncio.ensure_future(_execute_stage(run_id, sid))

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
    async with _state_lock:
        _active_runs.pop(run_id, None)
    await _broadcast_run(run)


# ── Stage State Helpers ─────────────────────────────────────────────


async def _update_stage_status(
    run_id: str, stage_id: str, status: str, output_summary: str = None
):
    db = await get_db()
    try:
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
            history[stage_id]["output_summary"] = output_summary[:2000]
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


async def _resolve_session(
    workspace_id: str, session_type: str, cli_type: str = None,
    agent_config: dict = None,
) -> Optional[str]:
    """Find or create a session by type (and optionally CLI type) in the workspace."""
    db = await get_db()
    try:
        # Try session_type + cli_type match first
        if cli_type:
            cur = await db.execute(
                """SELECT id FROM sessions
                   WHERE workspace_id = ? AND session_type = ? AND cli_type = ?
                   ORDER BY created_at DESC LIMIT 1""",
                (workspace_id, session_type, cli_type),
            )
            row = await cur.fetchone()
            if row:
                return row["id"]

        # Try session_type only (any CLI)
        cur = await db.execute(
            """SELECT id FROM sessions
               WHERE workspace_id = ? AND session_type = ?
               ORDER BY created_at DESC LIMIT 1""",
            (workspace_id, session_type),
        )
        row = await cur.fetchone()
        if row:
            return row["id"]

        # Try matching by name pattern
        sql = "SELECT id FROM sessions WHERE workspace_id = ? AND LOWER(name) LIKE ?"
        params = [workspace_id, f"%{session_type.lower()}%"]
        if cli_type:
            sql += " AND cli_type = ?"
            params.append(cli_type)
        cur = await db.execute(sql + " ORDER BY created_at DESC LIMIT 1", params)
        row = await cur.fetchone()
        if row:
            return row["id"]

        # No matching session — auto-create one
        return await _auto_create_session(db, workspace_id, session_type, cli_type, agent_config)
    finally:
        await db.close()


async def _auto_create_session(
    db, workspace_id: str, session_type: str, cli_type: str = None,
    agent_config: dict = None,
) -> Optional[str]:
    """Create a new session for a pipeline stage.

    Uses agent_config (from stage) with SESSION_TYPE_DEFAULTS fallback.
    """
    resolved_cli = cli_type or "claude"
    session_id = str(uuid.uuid4())
    cfg = agent_config or {}

    # Merge: explicit agent_config > session_type defaults > hardcoded
    defaults = SESSION_TYPE_DEFAULTS.get(session_type, SESSION_TYPE_DEFAULTS["worker"])

    model = cfg.get("model") or defaults.get("model")
    permission_mode = cfg.get("permission_mode") or defaults.get("permission_mode", "auto")
    effort = cfg.get("effort") or defaults.get("effort", "high")

    # Validate model against CLI type
    if resolved_cli == "gemini" and model in ("sonnet", "opus", "haiku"):
        model = "gemini-2.5-pro"
    elif resolved_cli == "claude" and model and model.startswith("gemini"):
        model = defaults.get("model", "sonnet")

    # Fall back to profile default if model still empty
    if not model:
        try:
            from cli_profiles import get_profile
            profile = get_profile(resolved_cli)
            model = profile.default_model
        except Exception:
            model = "sonnet" if resolved_cli == "claude" else "gemini-2.5-pro"

    # Build name
    cli_label = resolved_cli.capitalize()
    type_label = session_type.capitalize() if session_type != "worker" else "Worker"
    name = f"Pipeline {type_label} ({cli_label})"

    # Commander-typed pipeline stages need the orchestrator system prompt,
    # the tool deny-list, and the builtin-commander MCP attached — otherwise
    # the auto-created session is a bare Claude with no delegation tools and
    # no enforcement, so it falls back to implementing inline.
    extra_system_prompt = None
    extra_disallowed = None
    attach_commander_mcp = False
    if session_type == "commander":
        try:
            from config import COMMANDER_SYSTEM_PROMPT, COMMANDER_DISALLOWED_TOOLS
            extra_system_prompt = COMMANDER_SYSTEM_PROMPT
            extra_disallowed = json.dumps(COMMANDER_DISALLOWED_TOOLS)
            attach_commander_mcp = True
        except Exception as _e:
            logger.warning("Pipeline: could not load Commander config: %s", _e)

    await db.execute(
        """INSERT INTO sessions
           (id, workspace_id, name, model, permission_mode, effort,
            session_type, cli_type, auto_approve_mcp,
            system_prompt, disallowed_tools)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""",
        (session_id, workspace_id, name, model, permission_mode, effort,
         session_type, resolved_cli, extra_system_prompt, extra_disallowed),
    )
    if attach_commander_mcp:
        await db.execute(
            "INSERT OR IGNORE INTO session_mcp_servers "
            "(session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
            (session_id, "builtin-commander"),
        )
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
    try:
        from server import _output_monitor
        if _output_monitor:
            output = _output_monitor.get_buffer(session_id, lines=50)
            return output[:2000] if output else ""
        return ""
    except Exception:
        return ""


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
        source_pipeline = config.get("pipeline_id", "")
        return payload.get("pipeline_id") == source_pipeline

    return False


# ── Pipeline / Auto-exec Coordination ──────────────────────────


def is_task_in_pipeline(task_id: str) -> bool:
    """Return True if a pipeline run is currently handling this task.

    Called by auto_exec to skip tasks that pipelines own.
    """
    return task_id in _pipeline_task_ids


# ── Broadcast ───────────────────────────────────────────────────────


async def _broadcast_run(run: Optional[dict]):
    if not run or not _broadcast_fn:
        return
    await _broadcast_fn({
        "type": "pipeline_run_update",
        "run": run,
    })


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
                "agent_config": {"model": "sonnet", "permission_mode": "auto", "effort": "high"},
            },
            {
                "id": "plan", "name": "Plan", "type": "agent",
                "session_type": "commander", "prompt_template": "Based on the research findings, create implementation tasks. Branch if needed. Assign clear scope to each task.",
                "position": {"x": 320, "y": 200}, "config": {"icon": "map"},
                "agent_config": {"model": "opus", "permission_mode": "plan", "effort": "high"},
            },
            {
                "id": "implement", "name": "Implement", "type": "agent",
                "session_type": "worker", "prompt_template": "Implement the planned changes. Follow the task description and acceptance criteria. Write tests alongside code.",
                "position": {"x": 560, "y": 200}, "config": {"icon": "code"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto", "effort": "high"},
            },
            {
                "id": "test", "name": "Test", "type": "agent",
                "session_type": "tester", "prompt_template": "Run the test suite and verify the implementation. Report results clearly. When done, use the report_pipeline_result tool with status 'pass' or 'fail' and a summary.",
                "position": {"x": 800, "y": 200}, "config": {"icon": "check-circle"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto", "effort": "high"},
            },
            {
                "id": "evaluate", "name": "Evaluate", "type": "condition",
                "session_type": None, "prompt_template": "",
                "position": {"x": 1040, "y": 200},
                "config": {"mode": "keyword", "icon": "git-branch",
                           "pass_keywords": ["pass", "passed", "success", "all tests"],
                           "fail_keywords": ["fail", "failed", "error", "broken"]},
            },
            {
                "id": "document", "name": "Document", "type": "agent",
                "session_type": "documentor",
                "prompt_template": "Document the just-shipped changes for {topic}. Capture screenshots of new UI, record GIF workflows for new flows, and update the docs site. Use the documentor MCP tools (screenshot_page, record_workflow, update_docs_manifest, build_docs).",
                "position": {"x": 1280, "y": 200}, "config": {"icon": "book-open"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto", "effort": "high"},
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
                "agent_config": {"model": "sonnet", "permission_mode": "auto", "effort": "high"},
            },
            {
                "id": "test", "name": "Test", "type": "agent",
                "session_type": "tester", "prompt_template": "Run all tests. When done, use the report_pipeline_result tool with status 'pass' or 'fail' and a summary of results.",
                "position": {"x": 500, "y": 200}, "config": {"icon": "check-circle"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto", "effort": "high"},
            },
            {
                "id": "evaluate", "name": "Evaluate", "type": "condition",
                "session_type": None, "prompt_template": "",
                "position": {"x": 800, "y": 200},
                "config": {"mode": "keyword", "icon": "git-branch",
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
                "agent_config": {"model": "sonnet", "permission_mode": "auto", "effort": "high"},
            },
            {
                "id": "review", "name": "Review", "type": "agent",
                "session_type": "commander", "prompt_template": "Review the changes. Check code quality, correctness, and test coverage. Use the report_pipeline_result tool: 'pass' if approved or 'fail' with specific feedback.",
                "position": {"x": 500, "y": 200}, "config": {"icon": "eye"},
                "agent_config": {"model": "opus", "permission_mode": "plan", "effort": "high"},
            },
            {
                "id": "evaluate", "name": "Evaluate", "type": "condition",
                "session_type": None, "prompt_template": "",
                "position": {"x": 800, "y": 200},
                "config": {"mode": "keyword", "icon": "git-branch",
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
                "agent_config": {"model": "sonnet", "permission_mode": "auto", "effort": "high"},
            },
            {
                "id": "unit_eval", "name": "Unit Gate", "type": "condition",
                "session_type": None, "prompt_template": "",
                "position": {"x": 280, "y": 150},
                "config": {"mode": "keyword", "icon": "git-branch",
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
                "agent_config": {"model": "sonnet", "permission_mode": "auto", "effort": "high"},
            },
            {
                "id": "e2e_eval", "name": "E2E Gate", "type": "condition",
                "session_type": None, "prompt_template": "",
                "position": {"x": 640, "y": 150},
                "config": {"mode": "keyword", "icon": "git-branch",
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
                "agent_config": {"model": "opus", "permission_mode": "plan", "effort": "high"},
            },
            {
                "id": "quality_eval", "name": "Quality Gate", "type": "condition",
                "session_type": None, "prompt_template": "",
                "position": {"x": 1000, "y": 150},
                "config": {"mode": "keyword", "icon": "git-branch",
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
                "agent_config": {"model": "sonnet", "permission_mode": "auto", "effort": "high"},
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
                "agent_config": {"model": "sonnet", "permission_mode": "auto", "effort": "high"},
            },
            {
                "id": "verify", "name": "Verify", "type": "agent",
                "session_type": "tester", "prompt_template": "Verify the work is correct. Run tests, check output, validate behavior. When done, use the report_pipeline_result tool with status 'pass' or 'fail' and a summary.",
                "position": {"x": 450, "y": 200}, "config": {"icon": "shield"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto", "effort": "high"},
            },
            {
                "id": "evaluate", "name": "Evaluate", "type": "condition",
                "session_type": None, "prompt_template": "",
                "position": {"x": 750, "y": 200},
                "config": {"mode": "keyword", "icon": "git-branch",
                           "pass_keywords": ["pass", "verified", "correct"],
                           "fail_keywords": ["fail", "incorrect", "broken"]},
            },
            {
                "id": "fix", "name": "Fix", "type": "agent",
                "session_type": "worker",
                "reuse_session_from": "execute",
                "prompt_template": "Fix the issues found during verification. Apply the feedback.",
                "position": {"x": 600, "y": 380}, "config": {"icon": "wrench"},
                "agent_config": {"model": "sonnet", "permission_mode": "auto", "effort": "high"},
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

    # Save the patched definition as a temporary run-specific copy isn't needed —
    # we pass variables and the engine uses session_id from stage config.
    # But we need to persist the session override.  Easiest: update stage_history
    # after run creation.

    run = await start_run(
        pipeline_id,
        workspace_id=workspace_id,
        variables={"topic": task_prompt},
        trigger_type="ralph_token",
    )

    if not run:
        return None

    # Patch the execute + fix stages to point to the caller's session
    run_id = run["id"]
    await _update_stage_session(run_id, "execute", session_id)
    await _update_stage_session(run_id, "fix", session_id)

    return run


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
    """On server restart, pause any running pipelines and rebuild tracking."""
    db = await get_db()
    try:
        cur = await db.execute(
            "UPDATE pipeline_runs SET status = 'paused' WHERE status = 'running'"
        )
        if cur.rowcount > 0:
            logger.info("Recovered %d interrupted pipeline runs (set to paused)", cur.rowcount)
        await db.commit()

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
