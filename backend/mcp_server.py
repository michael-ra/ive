#!/usr/bin/env python3
"""
MCP server for IVE's Commander agent.
Wraps the REST API as MCP tools so Claude Code can orchestrate worker sessions.

Runs as a stdio MCP server — Claude Code connects to it via --mcp-config.
Uses urllib (stdlib) to call the local REST API. No external dependencies.
"""

import base64
import json
import os
import sys
import urllib.request
import urllib.error
import urllib.parse

API_URL = os.environ.get("COMMANDER_API_URL", "http://127.0.0.1:5111")
WORKSPACE_ID = os.environ.get("COMMANDER_WORKSPACE_ID", "")
COMMANDER_SESSION_ID = os.environ.get("COMMANDER_SESSION_ID", "")


def api_call(method: str, path: str, body: dict | None = None) -> dict:
    url = f"{API_URL}/api{path}"
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"} if body else {}
    if COMMANDER_SESSION_ID:
        headers["X-IVE-Session-Id"] = COMMANDER_SESSION_ID
        headers["X-IVE-Session-Type"] = "commander"
    if WORKSPACE_ID:
        headers["X-IVE-Workspace-Id"] = WORKSPACE_ID
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": e.read().decode(), "status": e.code}
    except Exception as e:
        return {"error": str(e)}


# ─── Tool implementations ────────────────────────────────────────────────

def tool_list_sessions(args: dict) -> str:
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    status_filter = args.get("status_filter", "all")
    sessions = api_call("GET", f"/sessions?workspace={ws_id}")
    if isinstance(sessions, list) and status_filter != "all":
        sessions = [s for s in sessions if s.get("status") == status_filter]
    return json.dumps(sessions, indent=2)


PLAN_FIRST_PROMPT = """IMPORTANT — PLAN FIRST MODE:
This task requires planning before implementation. You MUST:
1. Research the codebase and understand the current state
2. Create a detailed implementation plan (use plan mode or write a numbered plan)
3. Present the plan and STOP. Do NOT make any code changes yet.
4. Wait for the user to review, edit, and approve your plan
5. Only after explicit approval (e.g. "approved", "proceed", "looks good") should you begin implementation

Do NOT skip ahead to coding. The user needs to review your plan first."""


RALPH_LOOP_PROMPT = """## Ralph Mode — Persistent Execution Loop

You are operating in Ralph mode. You MUST keep working until the task is genuinely complete. Do not stop after a single attempt. Follow this loop:

### Loop: Execute → Verify → Fix → Repeat

**Phase 1 — Execute**: Implement the requested changes.

**Phase 2 — Verify (MANDATORY)**: After every implementation pass, you MUST verify with fresh evidence:
- Run the test suite — read the ACTUAL output
- Run the build — confirm it succeeds
- Run the linter if configured
- NEVER say "should work" — RUN IT and show proof

**Phase 3 — Fix**: If any verification step fails, fix the root cause and go back to Phase 2.

**Phase 4 — Completion Check**: Before declaring done, ALL must be true:
- All tests pass (show output)
- Build succeeds (show output)
- The original requirement is fully met
- No regressions introduced

If ANY check fails, go back to Phase 1. Maximum 20 iterations.
Each iteration: state phase and iteration number (e.g., "Ralph iteration 3 — Verify").
When genuinely complete, say: "Ralph complete — all checks pass" with evidence."""


WORKER_BOARD_PROMPT = """## Feature Board — Self-Report Your Progress

You have MCP tools to manage your assigned task on the feature board. Use them to keep the board up to date as you work:

1. Start: Call get_my_tasks to see your assignment — read the description and acceptance criteria
2. Planning: When you begin researching/planning, call update_my_task with status="planning"
3. In Progress: When you start writing code, call update_my_task with status="in_progress"
4. Review: When you believe the task is complete, call update_my_task with status="review" and a result_summary describing what you did
5. Done: If explicitly told work is accepted, call update_my_task with status="done"
6. Blocked: If you hit a blocker you can't resolve, call update_my_task with status="blocked" and explain in result_summary

Keep transitions honest — don't skip to "done" without verification. The board is visible to the user in real time."""


def tool_create_session(args: dict) -> str:
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    body = {
        "workspace_id": ws_id,
        "name": args.get("name", "Worker"),
        "model": args.get("model", "sonnet"),
        "permission_mode": args.get("permission_mode", "auto"),
    }
    # Support session_type for specialized sessions (e.g., "test_worker" gets Playwright MCP)
    session_type = args.get("session_type")
    if session_type:
        body["session_type"] = session_type
    system_prompt = args.get("system_prompt", "")
    # Enforce plan_first by prepending plan-first instructions
    if args.get("plan_first"):
        system_prompt = PLAN_FIRST_PROMPT + ("\n\n" + system_prompt if system_prompt else "")
    # Inject ralph loop instructions
    if args.get("ralph_loop"):
        system_prompt = RALPH_LOOP_PROMPT + ("\n\n" + system_prompt if system_prompt else "")
    # When a task_id is provided, inject worker board instructions
    task_id = args.get("task_id")
    if task_id:
        body["task_id"] = task_id
        system_prompt = WORKER_BOARD_PROMPT + ("\n\n" + system_prompt if system_prompt else "")
    if system_prompt:
        body["system_prompt"] = system_prompt
    body["auto_start"] = True  # Auto-start PTY so send_message works immediately
    result = api_call("POST", "/sessions", body)

    # Auto-kickoff: PTY spawn brings up Claude Code at its welcome screen,
    # which idles until a user message arrives. The system prompt is appended
    # via --append-system-prompt and tells the worker WHAT to do, but doesn't
    # itself trigger the first turn — Claude needs a user message to begin.
    # Without this, planners and workers sit silent until the Commander
    # remembers to chain a send_message, which it often forgets.
    #
    # Only auto-kickoff when a task_id is set (i.e., the worker has a clear
    # assignment). Skip for ad-hoc sessions where the user wants to compose
    # their own first message. Override with kickoff_message="" to opt out
    # explicitly, or pass a custom string to override the default.
    if task_id and isinstance(result, dict) and result.get("id") and not result.get("error"):
        kickoff = args.get("kickoff_message")
        if kickoff is None:
            kickoff = "Begin work on your assigned task."
        if kickoff:
            import time as _time
            _time.sleep(3.0)  # PTY boot + Claude TUI ready (mirrors frontend delay)
            api_call("POST", f"/sessions/{result['id']}/input", {"message": kickoff})

    return json.dumps(result, indent=2)


def tool_send_message(args: dict) -> str:
    session_id = args["session_id"]
    message = args["message"]
    result = api_call("POST", f"/sessions/{session_id}/input", {"message": message})
    return json.dumps(result)


def tool_read_session_output(args: dict) -> str:
    session_id = args["session_id"]
    lines = args.get("lines", 100)
    result = api_call("GET", f"/sessions/{session_id}/output?lines={lines}")
    return json.dumps(result) if isinstance(result, dict) else str(result)


def tool_get_session_status(args: dict) -> str:
    session_id = args["session_id"]
    sessions = api_call("GET", "/sessions")
    if isinstance(sessions, list):
        for s in sessions:
            if s.get("id") == session_id:
                return json.dumps(s, indent=2)
    return json.dumps({"error": "session not found"})


def tool_deep_research(args: dict) -> str:
    """Start a deep research job. Returns job_id for the Commander to track."""
    body = {
        "query": args["query"],
        "workspace_id": args.get("workspace_id", WORKSPACE_ID),
    }
    if args.get("model"):
        body["model"] = args["model"]
    if args.get("llm_url"):
        body["llm_url"] = args["llm_url"]
    result = api_call("POST", "/research/jobs", body)
    return json.dumps(result, indent=2)


def tool_list_research_jobs(args: dict) -> str:
    """List research entries and their status."""
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    result = api_call("GET", f"/research?workspace={ws_id}")
    return json.dumps(result, indent=2)


def tool_get_research(args: dict) -> str:
    """Get a research entry with all its sources and findings."""
    entry_id = args["entry_id"]
    result = api_call("GET", f"/research/{entry_id}")
    return json.dumps(result, indent=2)


def tool_search_research(args: dict) -> str:
    """Search across all research findings and sources."""
    q = args.get("query", "")
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    result = api_call("GET", f"/research/search?q={q}&workspace={ws_id}")
    return json.dumps(result, indent=2)


def tool_save_research(args: dict) -> str:
    """Save a research entry with findings."""
    body = {
        "workspace_id": args.get("workspace_id", WORKSPACE_ID),
        "topic": args["topic"],
        "query": args.get("query", args["topic"]),
        "feature_tag": args.get("feature_tag"),
        "status": args.get("status", "complete"),
        "findings_summary": args.get("findings_summary"),
    }
    result = api_call("POST", "/research", body)
    entry_id = result.get("id")

    # Add sources if provided
    for source in args.get("sources", []):
        api_call("POST", f"/research/{entry_id}/sources", source)

    return json.dumps(result, indent=2)


def tool_stop_session(args: dict) -> str:
    session_id = args["session_id"]
    result = api_call("DELETE", f"/sessions/{session_id}")
    return json.dumps(result)


def tool_escalate_worker(args: dict) -> str:
    """Stop a failing worker and restart with a more capable model.

    Preserves the task assignment, system prompt, and permission mode.
    The commander should send the task prompt to the new session after escalation.
    """
    session_id = args["session_id"]
    new_model = args.get("model")  # explicit override, or auto-escalate
    reason = args.get("reason", "Worker failed to complete task")

    # 1. Find current session
    sessions = api_call("GET", "/sessions")
    session = None
    if isinstance(sessions, list):
        for s in sessions:
            if s.get("id") == session_id:
                session = s
                break
    if not session:
        return json.dumps({"error": "session not found"})

    # 2. Determine escalation model based on CLI type
    cli_type = session.get("cli_type", "claude")
    # Inline model ladders — avoids importing cli_profiles which isn't
    # bundled in the compiled MCP binary.
    _MODEL_LADDERS = {
        "claude": ["haiku", "sonnet", "opus"],
        "gemini": ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro"],
    }
    ladder = _MODEL_LADDERS.get(cli_type, _MODEL_LADDERS["claude"])
    current_model = session.get("model", ladder[1] if len(ladder) > 1 else ladder[0])
    max_model = ladder[-1]
    if not new_model:
        idx = ladder.index(current_model) if current_model in ladder else len(ladder) - 2
        if idx >= len(ladder) - 1:
            return json.dumps({
                "error": "already_at_max_model",
                "model": current_model,
                "cli_type": cli_type,
                "suggestion": (
                    f"Worker is already running the most capable {cli_type} model ({max_model}). "
                    "Mark the task as 'blocked' and ask the user for help. Include: "
                    "what the worker tried, what errors were observed, and suggested approaches."
                ),
            })
        new_model = ladder[idx + 1]

    # 3. Preserve config from old session
    task_id = session.get("task_id")
    system_prompt = session.get("system_prompt") or ""
    old_name = session.get("name", "Worker")
    permission_mode = session.get("permission_mode", "auto")
    effort = session.get("effort", "high")

    # 4. Stop old session
    api_call("DELETE", f"/sessions/{session_id}")

    # 5. Create new session with upgraded model via REST API directly
    #    (system_prompt already has injected prompts from the original creation)
    body = {
        "workspace_id": session.get("workspace_id", WORKSPACE_ID),
        "name": f"{old_name} ({current_model}\u2192{new_model})",
        "model": new_model,
        "permission_mode": permission_mode,
        "effort": effort,
        "auto_start": True,
    }
    if task_id:
        body["task_id"] = task_id
    if system_prompt:
        body["system_prompt"] = system_prompt

    result = api_call("POST", "/sessions", body)

    new_id = result.get("id", "unknown")
    return json.dumps({
        "escalated": True,
        "old_session_id": session_id,
        "old_model": current_model,
        "new_model": new_model,
        "new_session_id": new_id,
        "task_id": task_id,
        "reason": reason,
        "next_step": (
            f"Worker escalated from {current_model} to {new_model}. "
            f"Send the task prompt to the new session (id: {new_id})."
        ),
    }, indent=2)


def tool_list_tasks(args: dict) -> str:
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    status = args.get("status_filter", "all")
    path = f"/tasks?workspace={ws_id}"
    if status != "all":
        path += f"&status={status}"
    result = api_call("GET", path)
    return json.dumps(result, indent=2)


def tool_get_task(args: dict) -> str:
    """Fetch a single task with all fields + attachment file paths.
    Dispatch prompts filter out empty fields, so Commander needs this
    to actually see description / acceptance / labels / images on a
    ticket it was just handed."""
    task_id = args["task_id"]
    task = api_call("GET", f"/tasks/{task_id}")
    if isinstance(task, dict) and "error" not in task:
        attachments = api_call("GET", f"/tasks/{task_id}/attachments")
        if isinstance(attachments, list):
            task["attachments"] = attachments
    return json.dumps(task, indent=2)


def tool_create_task(args: dict) -> str:
    body = {
        "workspace_id": args.get("workspace_id", WORKSPACE_ID),
        "title": args["title"],
    }
    for key in ("description", "acceptance_criteria", "priority", "labels", "depends_on"):
        if key in args:
            body[key] = args[key]
    result = api_call("POST", "/tasks", body)
    return json.dumps(result, indent=2)


def tool_update_task(args: dict) -> str:
    task_id = args["task_id"]
    body = {}
    for key in ("status", "assigned_session_id", "result_summary", "description", "title",
                 "lessons_learned", "important_notes", "depends_on"):
        if key in args:
            body[key] = args[key]
    result = api_call("PUT", f"/tasks/{task_id}", body)
    return json.dumps(result, indent=2)


def tool_broadcast_message(args: dict) -> str:
    session_ids = args["session_ids"]
    message = args["message"]
    result = api_call("POST", "/broadcast-input", {"session_ids": session_ids, "message": message})
    return json.dumps(result)


def tool_get_output_captures(args: dict) -> str:
    session_id = args["session_id"]
    cap_type = args.get("capture_type", "all")
    limit = args.get("limit", 20)
    result = api_call("GET", f"/sessions/{session_id}/captures?type={cap_type}&limit={limit}")
    return json.dumps(result, indent=2)


# ─── Preview tools (workspace-scoped browser preview) ───────────────────

def tool_set_preview_url(args: dict) -> str:
    """Set the workspace's preview URL — typically a localhost dev server.
    The user can press ⌘P to open it in a new browser tab."""
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    url = args.get("url", "").strip()
    if not ws_id:
        return json.dumps({"error": "workspace_id required"})
    result = api_call("PUT", f"/workspaces/{ws_id}", {"preview_url": url or None})
    return json.dumps(result, indent=2)


def tool_get_preview_url(args: dict) -> str:
    """Get the workspace's currently configured preview URL."""
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    workspaces = api_call("GET", "/workspaces")
    if isinstance(workspaces, list):
        for w in workspaces:
            if w.get("id") == ws_id:
                return json.dumps({"workspace_id": ws_id, "preview_url": w.get("preview_url")})
    return json.dumps({"error": "workspace not found"})


def tool_screenshot_preview(args: dict) -> dict:
    """Screenshot the workspace's preview URL and return it as an MCP image
    content block (base64). Returns a special dict the dispatcher unpacks."""
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    if not ws_id:
        return {"_error": "workspace_id required"}
    url = f"{API_URL}/api/workspaces/{ws_id}/preview-screenshot"
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            ct = resp.headers.get("Content-Type", "")
            data = resp.read()
            if not ct.startswith("image/"):
                # Backend returned a JSON error
                try:
                    return {"_error": json.loads(data).get("error", "screenshot failed")}
                except Exception:
                    return {"_error": "screenshot failed"}
            return {
                "_image": base64.b64encode(data).decode("ascii"),
                "_mime": ct,
            }
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read()).get("error", str(e))
        except Exception:
            err = str(e)
        return {"_error": err}
    except Exception as e:
        return {"_error": str(e)}


def tool_checkpoint(args: dict) -> str:
    """Experimental: mid-turn intercept via cooperative canary pattern.

    Gated behind the `experimental_checkpoint_protocol` app setting. When
    that flag is on, Commander injects a system prompt instructing Claude
    Code to call this tool at major reasoning transitions, then Commander
    (or subscribed plugins) can return guidance to shape the next step.

    For the first pass this handler is a stub that always returns
    `{"action": "proceed"}`. Future work: dispatch to installed plugin
    components whose manifest subscribes to the `checkpoint` canonical
    event, aggregate their responses, and return the strongest directive.
    """
    intent = (args.get("intent") or "").strip()
    context = (args.get("context") or "").strip()
    confidence = args.get("confidence") or "medium"

    # POST a minimal record to the backend so the UI / future plugin
    # dispatch layer can observe checkpoints. Best-effort — never block the
    # tool response on logging.
    try:
        api_call("POST", "/hooks/event", {
            "hook_event_name": "CheckpointProtocol",
            "session_id": os.environ.get("COMMANDER_SESSION_ID", ""),
            "payload": {
                "intent": intent,
                "context": context,
                "confidence": confidence,
            },
        })
    except Exception:
        pass  # never let logging failures affect the model

    return json.dumps({
        "action": "proceed",
        "note": (
            "Commander received your checkpoint. No plugin interventions "
            "registered. Continue with your planned next step."
        ),
    })


def tool_switch_model(args: dict) -> str:
    """Switch the current session's active model by injecting /model into the PTY.

    Gated behind the `experimental_model_switching` app setting. When enabled,
    the agent can call this tool to change its own model mid-conversation for
    cost/capability optimization (e.g., opus for planning, sonnet for execution).
    """
    model_name = (args.get("model") or "").strip()
    if not model_name:
        return json.dumps({"error": "model name required"})

    session_id = os.environ.get("COMMANDER_SESSION_ID", "")
    if not session_id:
        return json.dumps({"error": "COMMANDER_SESSION_ID not set — cannot determine session"})

    result = api_call("POST", f"/sessions/{session_id}/switch-model", {"model": model_name})

    if result.get("error"):
        return json.dumps({"error": result["error"]})

    return json.dumps({
        "ok": True,
        "model": model_name,
        "message": f"Model switched to {model_name}. The /model command has been sent to the CLI.",
    })


# ─── MCP Protocol (simplified stdio) ─────────────────────────────────────
#
# Experimental tool gating: some tools are only registered when the user
# has explicitly toggled a corresponding app_settings flag. The MCP server
# is spawned fresh per session, so checking the flag once at module load
# time mirrors how the system prompt injection works (resolved at PTY start,
# frozen for the lifetime of the session — toggling the flag mid-session
# requires a session restart to take effect).
#
# Fail-safe default: if the backend check fails for any reason, the tool
# is NOT registered. The user's opt-in is treated as unconfirmed.

def _app_setting(key: str) -> str | None:
    """Fetch an app_settings value from the backend. None on any failure."""
    try:
        result = api_call("GET", f"/settings/{key}")
        if isinstance(result, dict):
            return result.get("value")
    except Exception:
        pass
    return None


# Tool spec for the checkpoint canary. Defined up here so it lives alongside
# the tool_checkpoint handler, but registered conditionally below after the
# main TOOLS dict is built.
_CHECKPOINT_TOOL_SPEC = {
    "handler": tool_checkpoint,
    "description": (
        "[EXPERIMENTAL] Commander checkpoint protocol. Call this tool "
        "at major reasoning transitions when the checkpoint protocol "
        "is active (system prompt will instruct you). Returns either "
        "{\"action\": \"proceed\"} or updated guidance to incorporate "
        "before your next step. Do NOT call this tool unless the "
        "system prompt has activated the Commander Checkpoint Protocol."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "intent": {
                "type": "string",
                "description": "One-line description of what you're about to do.",
            },
            "context": {
                "type": "string",
                "description": "Optional: relevant state, recent observations, or reasoning.",
            },
            "confidence": {
                "type": "string",
                "enum": ["low", "medium", "high"],
                "description": "Your confidence in the planned next step.",
            },
        },
        "required": ["intent"],
    },
}

_SWITCH_MODEL_TOOL_SPEC = {
    "handler": tool_switch_model,
    "description": (
        "[EXPERIMENTAL] Switch this session's active model mid-conversation. "
        "Injects `/model <name>` into the PTY. Use this to optimize cost: "
        "switch to a higher-capability model (opus) for planning, then to a "
        "faster model (sonnet) for execution. Do NOT call this tool unless "
        "the system prompt has activated Commander Dual Model Switching."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "model": {
                "type": "string",
                "description": (
                    "Model name to switch to. Claude: 'opus', 'sonnet', 'haiku'. "
                    "Gemini: 'gemini-2.5-pro', 'gemini-2.5-flash'."
                ),
            },
        },
        "required": ["model"],
    },
}


# ─── W2W: Commander memory tools ────────────────────────────────────────

def tool_search_memory(args: dict) -> str:
    """Search across ALL workspace memory: past tasks with lessons, session digests, knowledge, peer messages, file activity."""
    query = args.get("query", "")
    types = args.get("types", "tasks,digests,knowledge,messages,files")
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    params = f"?q={urllib.parse.quote(query)}&types={types}&limit=5"
    result = api_call("GET", f"/workspaces/{ws_id}/memory-search{params}")
    return json.dumps(result, indent=2)


_VALID_MEMORY_TYPES = {"user", "feedback", "project", "reference"}


def tool_save_memory(args: dict) -> str:
    """Persist a durable insight to the workspace memory pool (Commander side)."""
    name = (args.get("name") or "").strip()
    content = (args.get("content") or "").strip()
    mem_type = (args.get("type") or "").strip()
    description = (args.get("description") or "").strip()
    tags = args.get("tags") or []
    ws_id = (args.get("workspace_id") or WORKSPACE_ID or "").strip()

    if not name or not content:
        return json.dumps({"ok": False, "error": "name and content are required"})
    if mem_type not in _VALID_MEMORY_TYPES:
        return json.dumps({"ok": False, "error": f"type must be one of {sorted(_VALID_MEMORY_TYPES)}"})
    if not ws_id:
        return json.dumps({"ok": False, "error": "workspace_id is required (no WORKSPACE_ID bound on this MCP session); refusing to save a global memory entry"})

    existing = api_call("GET", f"/memory?workspace={urllib.parse.quote(ws_id)}")
    match_id = None
    if isinstance(existing, list):
        for e in existing:
            if (e.get("name") or "").strip().lower() == name.lower() and (e.get("workspace_id") or "") == ws_id:
                match_id = e.get("id")
                break

    body = {
        "name": name, "type": mem_type, "content": content,
        "description": description,
        "workspace_id": ws_id or None, "tags": tags, "source_cli": "commander",
    }
    if match_id:
        result = api_call("PUT", f"/memory/{match_id}", body)
        if isinstance(result, dict) and result.get("error"):
            return json.dumps({"ok": False, **result})
        return json.dumps({"ok": True, "id": match_id, "updated": True})
    result = api_call("POST", "/memory", body)
    if isinstance(result, dict) and result.get("error"):
        return json.dumps({"ok": False, **result})
    return json.dumps({"ok": True, "id": (result or {}).get("id"), "created": True})


def tool_recall_memory(args: dict) -> str:
    """Fetch the full body of a memory entry by name.

    The Remembered Context block in the system prompt may render as an
    *index* (one line per entry) when the workspace has more memory than
    fits inline. Use this to expand any entry whose description is
    relevant to the current routing decision or task.
    """
    name = (args.get("name") or "").strip()
    ws_id = (args.get("workspace_id") or WORKSPACE_ID or "").strip()
    if not name:
        return json.dumps({"ok": False, "error": "name is required"})

    qs = ""
    if ws_id:
        qs = f"?workspace={urllib.parse.quote(ws_id)}&include_global=1"
    entries = api_call("GET", f"/memory{qs}")
    if not isinstance(entries, list):
        return json.dumps({"ok": False, "error": "memory list unavailable"})

    target = name.lower()
    workspace_match = None
    global_match = None
    for e in entries:
        if (e.get("name") or "").strip().lower() != target:
            continue
        if (e.get("workspace_id") or "") == ws_id:
            workspace_match = e
            break
        if not e.get("workspace_id"):
            global_match = e

    hit = workspace_match or global_match
    if not hit:
        return json.dumps({
            "ok": False,
            "error": f"no memory entry named {name!r}",
        })

    return json.dumps({
        "ok": True,
        "id": hit.get("id"),
        "name": hit.get("name"),
        "type": hit.get("type"),
        "description": hit.get("description") or "",
        "content": hit.get("content") or "",
        "tags": hit.get("tags") or [],
        "updated_at": hit.get("updated_at") or "",
        "scope": "workspace" if workspace_match else "global",
    })


def tool_headsup(args: dict) -> str:
    """Commander-side headsup: non-blocking notice to a peer or worker."""
    to = (args.get("to") or "all").strip() or "all"
    message = (args.get("message") or "").strip()
    topic = (args.get("topic") or "general").strip() or "general"
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    if not message:
        return json.dumps({"ok": False, "error": "message required"})
    # peer_messages.from_session_id has an FK to sessions(id). Use the
    # commander's real session id when available; NULL bypasses the FK
    # constraint so headsups still work when the MCP runs out-of-band
    # (e.g. tests or a global commander).
    body = {
        "from_session_id": COMMANDER_SESSION_ID or None,
        "content": message, "topic": topic, "priority": "heads_up",
        "blocking": False,
    }
    if to and to not in ("all",):
        # post_peer_message in peer_comms encodes recipient into the topic
        # prefix ("to:<id>|<topic>"); replicate that here so worker filters
        # see the headsup as targeted.
        body["topic"] = f"to:{to}|{topic}"
    result = api_call("POST", f"/workspaces/{ws_id}/peer-messages", body)
    if isinstance(result, dict) and result.get("error"):
        return json.dumps({"ok": False, **result})
    return json.dumps({"ok": True, "id": (result or {}).get("id"), "to": to})


_KNOWLEDGE_CATEGORIES = (
    "architecture", "convention", "gotcha", "pattern",
    "api", "setup", "orchestration", "code_catalog",
)


def tool_contribute_knowledge(args: dict) -> str:
    """Commander-side: write a routing/orchestration insight to the workspace KB.

    Same backend as the worker-side tool, just exposed on the commander MCP
    so commander can persist routing patterns, team-formation insights, and
    cross-task observations. Use category='orchestration' for commander-
    specific lessons (e.g. "frontend tasks succeed faster on Sonnet workers
    when scoped to a single panel"); other categories are also accepted but
    workers usually own those.
    """
    category = (args.get("category") or "").strip()
    content = (args.get("content") or "").strip()
    if not content or not category:
        return json.dumps({"ok": False, "error": "category and content required"})
    ws_id = (args.get("workspace_id") or WORKSPACE_ID or "").strip()
    if not ws_id:
        return json.dumps({"ok": False, "error": "workspace_id required"})
    body = {
        "category": category,
        "content": content,
        "scope": args.get("scope", ""),
        "contributed_by": COMMANDER_SESSION_ID or "",
    }
    result = api_call("POST", f"/workspaces/{ws_id}/knowledge", body)
    if isinstance(result, dict) and result.get("error"):
        return json.dumps({"ok": False, **result})
    return json.dumps({"ok": True, "id": (result or {}).get("id"), "category": category})


def tool_list_worker_digests(args: dict) -> str:
    """Get a birds-eye view of what all workers are currently doing — their task, focus, decisions, discoveries, files touched, and domain tags."""
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    sessions = api_call("GET", f"/sessions?workspace={ws_id}")
    digests = []
    if isinstance(sessions, list):
        for s in sessions:
            if s.get("session_type") == "commander":
                continue
            entry = {
                "session_id": s["id"],
                "session_name": s.get("name", ""),
                "status": s.get("status", ""),
                "cli_type": s.get("cli_type", ""),
                "model": s.get("model", ""),
                "tags": s.get("tags", []),
                "task_id": s.get("task_id"),
            }
            d = api_call("GET", f"/sessions/{s['id']}/digest")
            if isinstance(d, dict) and not d.get("error"):
                entry["task_summary"] = d.get("task_summary", "")
                entry["current_focus"] = d.get("current_focus", "")
                entry["files_touched"] = d.get("files_touched", [])
                entry["decisions"] = d.get("decisions", [])
                entry["discoveries"] = d.get("discoveries", [])
            # Include queued task count
            queue = api_call("GET", f"/sessions/{s['id']}/queue")
            if isinstance(queue, list):
                entry["queued_task_count"] = len(queue)
            digests.append(entry)
    return json.dumps(digests, indent=2)


def tool_get_session_digest(args: dict) -> str:
    """Get a specific worker's digest — what they're working on, decisions, discoveries, files touched."""
    session_id = args["session_id"]
    d = api_call("GET", f"/sessions/{session_id}/digest")
    return json.dumps(d, indent=2)


def tool_check_coordination(args: dict) -> str:
    """Check if a task intent overlaps with any active worker's current work. Use this before assigning tasks to avoid conflicts."""
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    intent = args.get("intent", "")
    exclude = args.get("exclude_session", "")
    result = api_call("POST", f"/workspaces/{ws_id}/coordination/overlap",
                      {"intent": intent, "exclude_session": exclude})
    return json.dumps(result, indent=2)


# ─── Myelin coordination tools (commander side) ─────────────────────────
# Mirror of the worker-side tools so commander can also coordinate
# (e.g. before dispatching a worker, or while doing its own edits).

_COMMANDER_AGENT_ID = f"commander_{WORKSPACE_ID or 'global'}"


def tool_coord_check_overlap(args: dict) -> str:
    from peer_comms import myelin_check_overlap
    file_path = args.get("file_path", "")
    intent = args.get("intent", "") or f"editing {file_path}"
    return json.dumps(myelin_check_overlap(_COMMANDER_AGENT_ID, intent, file_path), indent=2)


def tool_coord_acquire(args: dict) -> str:
    from peer_comms import myelin_acquire
    file_path = args.get("file_path", "")
    intent = args.get("intent", "")
    return json.dumps(myelin_acquire(_COMMANDER_AGENT_ID, file_path, intent), indent=2)


def tool_coord_release(args: dict) -> str:
    from peer_comms import myelin_release
    file_path = args.get("file_path", "")
    return json.dumps(myelin_release(_COMMANDER_AGENT_ID, file_path), indent=2)


def tool_coord_peers(args: dict) -> str:
    from peer_comms import myelin_peers
    return json.dumps(myelin_peers(_COMMANDER_AGENT_ID), indent=2)


# ─── Worker queue tools ────────────────────────────────────────────────────

def tool_tag_session(args: dict) -> str:
    """Set domain tags on a worker session for affinity-based routing."""
    session_id = args["session_id"]
    tags = args["tags"]
    result = api_call("PUT", f"/sessions/{session_id}", {"tags": tags})
    return json.dumps(result, indent=2)


def tool_queue_task_for_worker(args: dict) -> str:
    """Queue a task for a specific busy worker. The server auto-delivers it when the worker finishes its current task."""
    task_id = args["task_id"]
    session_id = args["session_id"]
    result = api_call("POST", f"/sessions/{session_id}/queue", {"task_id": task_id})
    return json.dumps(result, indent=2)


def tool_assign_task_to_worker(args: dict) -> str:
    """Assign a task to an idle worker session, reusing it instead of creating a new one. Sends a handoff prompt to the worker's terminal."""
    task_id = args["task_id"]
    session_id = args["session_id"]
    body = {"task_id": task_id}
    if args.get("message"):
        body["message"] = args["message"]
    result = api_call("POST", f"/sessions/{session_id}/assign-task", body)
    return json.dumps(result, indent=2)


def tool_request_docs_update(args: dict) -> str:
    """Request the Documentor to update documentation. Emits DOCS_UPDATE_NEEDED event and optionally sends a message to the Documentor session."""
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    reason = args.get("reason", "Changes detected")
    affected = args.get("affected_features", [])

    # Emit event
    api_call("POST", "/events/emit", {
        "event_type": "docs_update_needed",
        "payload": {"reason": reason, "affected_features": affected, "workspace_id": ws_id},
    })

    # Try to send a message to the Documentor session if it exists
    doc_session = api_call("GET", f"/workspaces/{ws_id}/documentor")
    if doc_session and not doc_session.get("error"):
        session_id = doc_session.get("id")
        if session_id:
            features_str = ", ".join(affected) if affected else "unspecified features"
            msg = f"Documentation update needed: {reason}. Affected features: {features_str}. Please check get_changes_since() and update relevant pages."
            api_call("POST", f"/sessions/{session_id}/input", {"message": msg})  # CR submits in raw-mode CLI TUIs (LF would leave it unsubmitted)
            return f"Docs update requested. Reason: {reason}. Message sent to Documentor session {session_id}."

    return f"Docs update event emitted. Reason: {reason}. No active Documentor session found — event is queued."


def tool_search_skills(args: dict) -> str:
    """Search the skills catalog for relevant agent skills."""
    query = args.get("query", "")
    limit = args.get("limit", 5)
    params = f"?q={urllib.parse.quote(query)}&limit={limit}"
    result = api_call("GET", f"/skills/search{params}")
    if isinstance(result, list):
        lines = []
        for s in result:
            score = s.get("score", 0)
            lines.append(f"- **{s.get('name', '?')}** (match: {int(score * 100)}%) — {s.get('description', '')}")
        if lines:
            return "Matching skills:\n" + "\n".join(lines) + "\n\nCall `get_skill_content` with a skill name to load its full instructions."
        return "No matching skills found."
    return json.dumps(result, indent=2)


def tool_get_skill_content(args: dict) -> str:
    """Get full SKILL.md instructions for a specific skill."""
    name = args.get("name", "")
    params = f"?name={urllib.parse.quote(name)}"
    result = api_call("GET", f"/skills/content{params}")
    if isinstance(result, dict) and result.get("content"):
        return f"# {result.get('name', name)}\n\n{result['content']}"
    if isinstance(result, dict) and result.get("description"):
        return f"# {result.get('name', name)}\n\n{result['description']}"
    if isinstance(result, dict) and result.get("error"):
        return f"Skill not found: {name}"
    return json.dumps(result, indent=2)


TOOLS = {
    "search_skills": {
        "handler": tool_search_skills,
        "description": (
            "Search the skills catalog (8000+ skills) for relevant agent skills. "
            "Returns top matches ranked by relevance. Use this to find skills that can "
            "help with your current task."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What you need help with."},
                "limit": {"type": "integer", "default": 5, "description": "Max results."},
            },
            "required": ["query"],
        },
    },
    "get_skill_content": {
        "handler": tool_get_skill_content,
        "description": (
            "Load the full instructions for a specific skill by name. "
            "Call this after search_skills to get the complete SKILL.md content."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Exact skill name from search_skills results."},
            },
            "required": ["name"],
        },
    },
    "list_sessions": {
        "handler": tool_list_sessions,
        "description": "List all sessions in the workspace with status and config.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "status_filter": {"type": "string", "enum": ["all", "running", "idle", "exited"], "default": "all"},
            },
        },
    },
    "create_session": {
        "handler": tool_create_session,
        "description": "Create a new worker session. Pass task_id to auto-assign a feature board task and give the worker tools to update its own ticket status. When task_id is set, the worker is also auto-kickoffed with a brief 'Begin work on your assigned task.' user message after PTY boot — so you do NOT need to chain a send_message immediately after create_session for the worker to start. Override the kickoff text via kickoff_message='...' or pass kickoff_message='' to opt out and compose the first message yourself. Set plan_first=true for planning before implementation. Set ralph_loop=true for persistent execute→verify→fix loop until genuinely complete. Set session_type='test_worker' to create a test worker with Playwright MCP for browser automation.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "name": {"type": "string"},
                "model": {"type": "string", "enum": ["haiku", "sonnet", "opus"], "default": "sonnet"},
                "permission_mode": {"type": "string", "default": "auto"},
                "system_prompt": {"type": "string"},
                "session_type": {"type": "string", "enum": ["worker", "test_worker", "planner"], "default": "worker", "description": "Session type. 'test_worker' auto-attaches Playwright MCP for browser testing. 'planner' injects the Planner system prompt — use it to decompose vague/large tasks into sub-tasks; the planner stops after filing sub-tasks, never implements."},
                "task_id": {"type": "string", "description": "Feature board task ID to assign to this worker. The worker gets MCP tools to update its own task status (planning/in_progress/review/done)."},
                "plan_first": {"type": "boolean", "default": False, "description": "If true, worker must plan and wait for user approval before implementing."},
                "ralph_loop": {"type": "boolean", "default": False, "description": "If true, worker uses Ralph mode — persistent execution loop that keeps going until all tests/build pass."},
            },
            "required": ["name"],
        },
    },
    "send_message": {
        "handler": tool_send_message,
        "description": "Send a message to a running session's terminal.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "message": {"type": "string"},
            },
            "required": ["session_id", "message"],
        },
    },
    "read_session_output": {
        "handler": tool_read_session_output,
        "description": "Read recent clean text output from a session.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "lines": {"type": "integer", "default": 100},
            },
            "required": ["session_id"],
        },
    },
    "get_session_status": {
        "handler": tool_get_session_status,
        "description": "Get detailed status of a session.",
        "inputSchema": {
            "type": "object",
            "properties": {"session_id": {"type": "string"}},
            "required": ["session_id"],
        },
    },
    "stop_session": {
        "handler": tool_stop_session,
        "description": "Stop a running session.",
        "inputSchema": {
            "type": "object",
            "properties": {"session_id": {"type": "string"}},
            "required": ["session_id"],
        },
    },
    "escalate_worker": {
        "handler": tool_escalate_worker,
        "description": "Escalate a failing worker by stopping it and restarting with a more capable model. Claude: haiku→sonnet→opus. Gemini: gemini-2.0-flash→gemini-2.5-flash→gemini-2.5-pro. Auto-detects CLI type. Preserves task assignment and system prompt. Use when a worker fails after receiving guidance. Returns 'already_at_max_model' if already at the top — mark task as blocked and ask the user.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string", "description": "The failing worker's session ID"},
                "model": {"type": "string", "description": "Explicit target model. If omitted, auto-escalates to the next tier up. Claude: haiku/sonnet/opus. Gemini: gemini-2.0-flash/gemini-2.5-flash/gemini-2.5-pro."},
                "reason": {"type": "string", "description": "Why the worker is being escalated (for audit trail)."},
            },
            "required": ["session_id"],
        },
    },
    "list_tasks": {
        "handler": tool_list_tasks,
        "description": "List tasks on the feature board.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "status_filter": {"type": "string", "enum": ["all", "backlog", "todo", "in_progress", "review", "done", "blocked"], "default": "all"},
            },
        },
    },
    "get_task": {
        "handler": tool_get_task,
        "description": (
            "Fetch a single task by ID with all fields populated — title, description, "
            "acceptance_criteria, labels, priority, status, scratchpad, lessons_learned, "
            "important_notes, iteration count, AND the list of file attachments (image paths). "
            "Call this FIRST when you receive a 'Pick up task: ...' dispatch — the dispatch "
            "prompt only includes non-empty fields, so checking the full record is the only way "
            "to see attached images, labels, or fields the owner filled in but you weren't shown."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
            },
            "required": ["task_id"],
        },
    },
    "create_task": {
        "handler": tool_create_task,
        "description": "Create a new task on the feature board.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "title": {"type": "string"},
                "description": {"type": "string"},
                "acceptance_criteria": {"type": "string"},
                "priority": {"type": "integer", "enum": [0, 1, 2]},
                "labels": {"type": "array", "items": {"type": "string"}},
                "depends_on": {"type": "array", "items": {"type": "string"}, "description": "Task IDs this task depends on (must complete before this task starts)"},
            },
            "required": ["title"],
        },
    },
    "update_task": {
        "handler": tool_update_task,
        "description": "Update a task's status, assignment, summary, or notes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
                "status": {"type": "string", "enum": ["backlog", "todo", "planning", "in_progress", "review", "done", "blocked"]},
                "assigned_session_id": {"type": "string"},
                "result_summary": {"type": "string"},
                "description": {"type": "string"},
                "title": {"type": "string"},
                "lessons_learned": {"type": "string", "description": "Key findings or lessons from this task"},
                "important_notes": {"type": "string", "description": "Critical notes for future iterations"},
                "depends_on": {"type": "array", "items": {"type": "string"}, "description": "Task IDs this task depends on (must complete before this task starts)"},
            },
            "required": ["task_id"],
        },
    },
    "broadcast_message": {
        "handler": tool_broadcast_message,
        "description": "Send the same message to multiple sessions.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_ids": {"type": "array", "items": {"type": "string"}},
                "message": {"type": "string"},
            },
            "required": ["session_ids", "message"],
        },
    },
    "get_output_captures": {
        "handler": tool_get_output_captures,
        "description": "Get structured captures (tool calls, edits, errors) from a session.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "capture_type": {"type": "string", "enum": ["all", "tool_call", "edit_diff", "error"]},
                "limit": {"type": "integer", "default": 20},
            },
            "required": ["session_id"],
        },
    },
    "deep_research": {
        "handler": tool_deep_research,
        "description": "Start a deep research job using the local deep_research engine. Returns a job_id. Use this BEFORE creating worker sessions for tasks that need background context, codebase analysis, or external knowledge gathering. The research runs in the background and produces a structured research output that can be used to enrich subsequent worker prompts.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Research question or topic"},
                "workspace_id": {"type": "string"},
                "model": {"type": "string", "description": "Override LLM model (e.g. gemma3:27b)"},
                "llm_url": {"type": "string", "description": "Override LLM URL (e.g. http://localhost:11434/v1)"},
            },
            "required": ["query"],
        },
    },
    "list_research": {
        "handler": tool_list_research_jobs,
        "description": "List all research entries for the workspace.",
        "inputSchema": {
            "type": "object",
            "properties": {"workspace_id": {"type": "string"}},
        },
    },
    "get_research": {
        "handler": tool_get_research,
        "description": "Get a research entry with all sources and findings.",
        "inputSchema": {
            "type": "object",
            "properties": {"entry_id": {"type": "string"}},
            "required": ["entry_id"],
        },
    },
    "search_research": {
        "handler": tool_search_research,
        "description": "Search across all research findings and sources for this workspace.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "workspace_id": {"type": "string"},
            },
            "required": ["query"],
        },
    },
    "set_preview_url": {
        "handler": tool_set_preview_url,
        "description": "Set the workspace's browser preview URL (typically a localhost dev server like http://localhost:3000). Once set, the user can press ⌘P to open it in a new browser tab. Use this when you've started a dev server for the user and want to register it for one-keystroke preview.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string", "description": "Workspace id (defaults to current Commander workspace)"},
                "url": {"type": "string", "description": "Full URL including scheme, e.g. http://localhost:3000. Pass empty string to clear."},
            },
            "required": ["url"],
        },
    },
    "get_preview_url": {
        "handler": tool_get_preview_url,
        "description": "Get the workspace's currently configured browser preview URL, if any.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
            },
        },
    },
    "screenshot_preview": {
        "handler": tool_screenshot_preview,
        "description": "Capture a screenshot of the workspace's preview URL and return it inline as an image. Use this to visually confirm UI changes after editing frontend code, or to show the user what their dev server currently looks like. The preview_url must be set first via set_preview_url.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
            },
        },
    },
    "save_research": {
        "handler": tool_save_research,
        "description": "Save research findings with sources to the research DB. Other agents can then access these findings.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "topic": {"type": "string"},
                "query": {"type": "string"},
                "feature_tag": {"type": "string", "description": "Tag to group research by feature"},
                "findings_summary": {"type": "string"},
                "status": {"type": "string", "enum": ["pending", "in_progress", "complete"]},
                "sources": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "url": {"type": "string"},
                            "title": {"type": "string"},
                            "content_summary": {"type": "string"},
                        },
                    },
                },
            },
            "required": ["topic"],
        },
    },
}


# ─── Conditional tool registration ────────────────────────────────────
# Checkpoint tool ONLY exposes itself when the user has opted into the
# experimental flag. The flag is checked once at MCP server startup (which
# is once per session). If toggling mid-session, restart the session.

if _app_setting("experimental_checkpoint_protocol") == "on":
    TOOLS["checkpoint"] = _CHECKPOINT_TOOL_SPEC

if _app_setting("experimental_model_switching") == "on":
    TOOLS["switch_model"] = _SWITCH_MODEL_TOOL_SPEC

# W2W memory tools — always available for Commander
TOOLS["search_memory"] = {
    "handler": tool_search_memory,
    "description": (
        "USE THIS BEFORE every routing decision. The workspace's accumulated "
        "playbook lives here — past tasks with lessons learned, session digests, "
        "knowledge base, peer messages, file activity. If a similar task was "
        "routed last week and the worker hit a wall, that lesson is searchable "
        "right now. Trigger checklist: (1) before creating a task — has this been "
        "done before? (2) before picking a worker — which one succeeded at this "
        "domain? (3) before escalating — was this same failure pattern seen "
        "elsewhere? Memory is the workspace's playbook; reading it costs a few "
        "tokens, ignoring it costs hours of repeated mistakes."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to search for."},
            "types": {"type": "string", "description": "Comma-separated: tasks,digests,knowledge,messages,files. Default: all."},
            "workspace_id": {"type": "string"},
        },
        "required": ["query"],
    },
}
TOOLS["list_worker_digests"] = {
    "handler": tool_list_worker_digests,
    "description": (
        "Birds-eye view of ALL workers — what each is working on, their focus, "
        "decisions, discoveries, and files touched. Use this instead of reading "
        "raw session output for a quick status check."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {"workspace_id": {"type": "string"}},
    },
}
TOOLS["get_session_digest"] = {
    "handler": tool_get_session_digest,
    "description": "Get a specific worker session's digest — their task, focus, decisions, discoveries, and files.",
    "inputSchema": {
        "type": "object",
        "properties": {"session_id": {"type": "string"}},
        "required": ["session_id"],
    },
}
TOOLS["save_memory"] = {
    "handler": tool_save_memory,
    "description": (
        "MEMORY IS YOUR PLAYBOOK — call this after every routing decision, escalation, "
        "or completed task. Use this whenever something happened that a future Commander "
        "should know: which worker succeeded at which domain, which model was needed for "
        "this task class, what the user's preference was, what kept failing. "
        "Trigger checklist: (1) finished routing a task → save type='project' with what "
        "happened end-to-end. (2) user corrected your routing → save type='feedback'. "
        "(3) discovered a worker is great at X → save type='reference'. (4) escalated to "
        "max model and still failed → save type='project' with the failure pattern. "
        "Idempotent on `name` — re-using a name updates instead of duplicating. "
        "Skipping this means the next Commander has to relearn everything from scratch."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Short title (dedup key within workspace)."},
            "type": {"type": "string", "enum": ["user", "feedback", "project", "reference"]},
            "content": {"type": "string", "description": "The insight."},
            "description": {
                "type": "string",
                "description": (
                    "One-line summary used in the Remembered Context index. Make it "
                    "specific enough that a future Commander scanning a list can "
                    "decide whether to recall_memory the full body."
                ),
            },
            "tags": {"type": "array", "items": {"type": "string"}},
            "workspace_id": {"type": "string"},
        },
        "required": ["name", "type", "content"],
    },
}
TOOLS["recall_memory"] = {
    "handler": tool_recall_memory,
    "description": (
        "Expand a memory entry from the Remembered Context index. When the system "
        "prompt shows entries as one-liners ('name — description'), call this with "
        "the name to fetch the full body before acting on it. Don't call for entries "
        "you already have inlined — only when an index description looks relevant and "
        "you need the details."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Exact entry name from the index."},
            "workspace_id": {"type": "string"},
        },
        "required": ["name"],
    },
}
TOOLS["headsup"] = {
    "handler": tool_headsup,
    "description": (
        "Non-blocking notice to workers — fire and continue. Use when you want a worker "
        "or all workers to SEE something but you're not waiting on them. Trigger checklist: "
        "(1) reassigning a file area another worker was previously in. (2) merging two "
        "tasks. (3) telling all workers the user changed direction. Set `to` to 'all' "
        "or a specific session_id."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "to": {"type": "string", "description": "'all' or a specific session_id."},
            "message": {"type": "string"},
            "topic": {"type": "string", "description": "Topic tag. Default: general."},
            "workspace_id": {"type": "string"},
        },
        "required": ["to", "message"],
    },
}
TOOLS["contribute_knowledge"] = {
    "handler": tool_contribute_knowledge,
    "description": (
        "Persist a routing/orchestration insight or codebase fact to the workspace "
        "knowledge base. The entry shows up in every future session's system prompt "
        "under the category header. Use category='orchestration' for commander-only "
        "lessons (which worker class fits which task, model-tier patterns, team "
        "formation rules); other categories work but are usually written by workers. "
        "Keep entries terse and actionable — one fact, one line."
        "\n\nFor `category=\"code_catalog\"`, `content` MUST be a single wire-format line: "
        "`<file>::<symbol>(<args>?): <purpose> [| →dep ←caller ↔shared] [◆effect]`. "
        "Catalog rows dedup by (workspace, file, symbol) — same content confirms; "
        "different content replaces (prior version archived to history)."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "category": {
                "type": "string",
                "enum": list(_KNOWLEDGE_CATEGORIES),
                "description": "Knowledge category. Commanders typically use 'orchestration'.",
            },
            "content": {"type": "string", "description": "The insight (one line, factual)."},
            "scope": {"type": "string", "description": "Optional module/subsystem scope."},
            "workspace_id": {"type": "string"},
        },
        "required": ["category", "content"],
    },
}
TOOLS["check_coordination"] = {
    "handler": tool_check_coordination,
    "description": (
        "Check if a task intent overlaps with any active worker's current work. "
        "Use this BEFORE assigning tasks to detect potential conflicts. "
        "Returns overlap levels: conflict (>0.80), share (0.65-0.80), notify (0.55-0.65)."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "intent": {"type": "string", "description": "Describe the task/intent to check for overlaps."},
            "workspace_id": {"type": "string"},
            "exclude_session": {"type": "string", "description": "Session ID to exclude from overlap check."},
        },
        "required": ["intent"],
    },
}

# Myelin coordination — gated on experimental flag. These let commander
# directly query/announce in the shared coord graph (same primitives the
# workers get). Useful when commander is doing its own edits or forming a
# team and wants ground truth on who's already working on what.
if _app_setting("experimental_myelin_coordination") == "on":
    TOOLS["coord_check_overlap"] = {
        "handler": tool_coord_check_overlap,
        "description": (
            "Check semantic overlap with active peer agents in the shared "
            "coordination graph. Returns overlaps with score + level "
            "(conflict/share/notify/tangent/unrelated)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "File you intend to edit."},
                "intent": {"type": "string", "description": "Short description of intended work."},
            },
            "required": ["file_path", "intent"],
        },
    }
    TOOLS["coord_acquire"] = {
        "handler": tool_coord_acquire,
        "description": "Best-effort claim: announce a task in the shared coordination graph.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "File being claimed."},
                "intent": {"type": "string", "description": "Optional richer intent description."},
            },
            "required": ["file_path"],
        },
    }
    TOOLS["coord_release"] = {
        "handler": tool_coord_release,
        "description": "Mark this agent's coord tasks for the file as completed.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "File you're done editing."},
            },
            "required": ["file_path"],
        },
    }
    TOOLS["coord_peers"] = {
        "handler": tool_coord_peers,
        "description": "List active peer agents in the coordination namespace.",
        "inputSchema": {"type": "object", "properties": {}},
    }

# Worker queue tools
TOOLS["tag_session"] = {
    "handler": tool_tag_session,
    "description": (
        "Set domain tags on a worker session for affinity-based routing. "
        "Tags like ['frontend', 'react', 'state'] mark a worker's specialization. "
        "Use this when forming a team so you can route future tasks by domain affinity."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "session_id": {"type": "string", "description": "Worker session to tag."},
            "tags": {
                "type": "array", "items": {"type": "string"},
                "description": "Domain tags, e.g. ['frontend', 'components'] or ['backend', 'hooks', 'db'].",
            },
        },
        "required": ["session_id", "tags"],
    },
}
TOOLS["queue_task_for_worker"] = {
    "handler": tool_queue_task_for_worker,
    "description": (
        "Queue a task for a specific busy worker. When that worker finishes its current task "
        "and goes idle, the server auto-delivers this task to the worker's terminal. "
        "Use this to pre-assign work to the best-fit worker without waiting for them to finish."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "task_id": {"type": "string", "description": "Task ID to queue."},
            "session_id": {"type": "string", "description": "Worker session ID to queue the task for."},
        },
        "required": ["task_id", "session_id"],
    },
}
TOOLS["assign_task_to_worker"] = {
    "handler": tool_assign_task_to_worker,
    "description": (
        "Assign a task to an idle worker, reusing the session instead of creating a new one. "
        "Sends a handoff prompt to the worker's terminal. The worker keeps its codebase context "
        "and domain expertise from previous tasks. Prefer this over create_session when an idle "
        "worker with matching domain tags exists."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "task_id": {"type": "string", "description": "Task ID to assign."},
            "session_id": {"type": "string", "description": "Idle worker session to reuse."},
            "message": {"type": "string", "description": "Optional custom handoff message. If omitted, a standard handoff prompt is generated."},
        },
        "required": ["task_id", "session_id"],
    },
}

TOOLS["request_docs_update"] = {
    "handler": tool_request_docs_update,
    "description": (
        "Request the Documentor agent to update documentation. Emits a DOCS_UPDATE_NEEDED event "
        "and sends a message to the Documentor session if one is running. Use this after completing "
        "features, shipping tasks, or making significant changes that should be reflected in docs."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "workspace_id": {"type": "string", "description": "Workspace ID. Defaults to current workspace."},
            "reason": {"type": "string", "description": "Why docs need updating (e.g. 'Cascade loops feature completed')"},
            "affected_features": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of feature names/areas affected (e.g. ['cascades', 'prompt-library'])",
            },
        },
        "required": ["reason"],
    },
}


def handle_jsonrpc(request: dict) -> dict:
    """Handle a JSON-RPC 2.0 request."""
    method = request.get("method", "")
    req_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "commander", "version": "1.0.0"},
            },
        }

    if method == "notifications/initialized":
        return None  # No response for notifications

    if method == "tools/list":
        tools_list = []
        for name, spec in TOOLS.items():
            tools_list.append({
                "name": name,
                "description": spec["description"],
                "inputSchema": spec["inputSchema"],
            })
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"tools": tools_list},
        }

    if method == "tools/call":
        tool_name = params.get("name", "")
        tool_args = params.get("arguments", {})
        spec = TOOLS.get(tool_name)
        if not spec:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32601, "message": f"Unknown tool: {tool_name}"},
            }
        try:
            handler_result = spec["handler"](tool_args)
            # Most tools return a string. Tools that return an image return
            # a dict with _image/_mime (or _error) so the dispatcher can emit
            # an MCP image content block.
            if isinstance(handler_result, dict) and "_image" in handler_result:
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [{
                            "type": "image",
                            "data": handler_result["_image"],
                            "mimeType": handler_result.get("_mime", "image/png"),
                        }],
                    },
                }
            if isinstance(handler_result, dict) and "_error" in handler_result:
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [{"type": "text", "text": f"Error: {handler_result['_error']}"}],
                        "isError": True,
                    },
                }
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": handler_result}],
                },
            }
        except Exception as e:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": f"Error: {e}"}],
                    "isError": True,
                },
            }

    # Unknown method
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Unknown method: {method}"},
    }


def main():
    """Run the MCP server on stdio."""
    from mcp_exit_log import install, log_exit
    install("commander")
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                continue

            response = handle_jsonrpc(request)
            if response is not None:
                try:
                    sys.stdout.write(json.dumps(response) + "\n")
                    sys.stdout.flush()
                except BrokenPipeError:
                    log_exit("stdout-broken-pipe", "(parent stopped reading)")
                    return
        log_exit("stdin-eof", "(parent closed stdin)")
    except SystemExit:
        raise
    except BaseException as e:
        log_exit("unhandled-exception", f"{type(e).__name__}: {e}")
        raise


if __name__ == "__main__":
    main()
