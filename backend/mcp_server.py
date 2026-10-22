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

from extension_host import available as extension_available

API_URL = os.environ.get("COMMANDER_API_URL", "http://127.0.0.1:5111")
WORKSPACE_ID = os.environ.get("COMMANDER_WORKSPACE_ID", "")
COMMANDER_SESSION_ID = os.environ.get("COMMANDER_SESSION_ID", "")
COMMANDER_CLI_TYPE = os.environ.get("COMMANDER_CLI_TYPE", "claude")

try:
    from config import (
        ALLOY_WORKER_SYSTEM_PROMPT_FRAGMENT,
        ALLOY_TESTER_SYSTEM_PROMPT_FRAGMENT,
        ALLOY_DOCUMENTOR_SYSTEM_PROMPT_FRAGMENT,
    )
except Exception:
    ALLOY_WORKER_SYSTEM_PROMPT_FRAGMENT = ""
    ALLOY_TESTER_SYSTEM_PROMPT_FRAGMENT = ""
    ALLOY_DOCUMENTOR_SYSTEM_PROMPT_FRAGMENT = ""


def api_call(method: str, path: str, body: dict | None = None) -> dict:
    url = f"{API_URL}/api{path}"
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"} if body else {}
    if COMMANDER_SESSION_ID:
        headers["X-IVE-Session-Id"] = COMMANDER_SESSION_ID
        # Session proof from the PTY env (see backend/session_proofs.py);
        # only when it belongs to the session this server speaks for.
        from os import environ as _environ
        _proof = _environ.get("COMMANDER_SESSION_PROOF", "")
        if _proof and (_environ.get("COMMANDER_SESSION_ID") or COMMANDER_SESSION_ID) == COMMANDER_SESSION_ID:
            headers["X-IVE-Session-Proof"] = _proof
        headers["X-IVE-Session-Type"] = "commander"
    if WORKSPACE_ID:
        headers["X-IVE-Workspace-Id"] = WORKSPACE_ID
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            try:
                return json.loads(resp.read())
            except (ValueError, UnicodeDecodeError):
                return {"error": f"IVE API returned a non-JSON response for {path.split('?')[0]}",
                        "code": "invalid_api_response", "status": resp.status}
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

GIT_ATTRIBUTION_PROMPT = """## Git Commits and IVE Attribution

Use normal human-readable Git commit messages only. Do not add IVE session IDs,
session names, ticket IDs, ticket names, or other IVE metadata to commit
subjects, trailers, author emails, committer emails, or repo-local Git config.
IVE records commit attribution internally."""


MEMORY_REUSE_PROMPT = ""  # Optional context-provider contribution, not a core strategy.


def _task_labels(task: dict | None) -> set[str]:
    labels = (task or {}).get("labels")
    if isinstance(labels, list):
        raw = labels
    else:
        raw = str(labels or "").replace(";", ",").split(",")
    return {str(label).strip().lower() for label in raw if str(label).strip()}


def _task_is_alloy(task: dict | None) -> bool:
    labels = _task_labels(task)
    return "alloy" in labels or "ive-alloy" in labels


def tool_create_session(args: dict) -> str:
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    body = {
        "workspace_id": ws_id,
        "name": args.get("name", "Worker"),
    }
    if args.get("cli_type"):
        body["cli_type"] = args.get("cli_type")
    if args.get("policy_role") or args.get("role"):
        body["policy_role"] = args.get("policy_role") or args.get("role")
    if args.get("model") is not None:
        body["model"] = args.get("model")
    if args.get("permission_mode") is not None:
        body["permission_mode"] = args.get("permission_mode")
    # Support legacy/specialized session_type values; normal testing/docs are capabilities below.
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
    if session_type in (None, "", "worker", "test_worker", "planner", "brainstormer"):
        system_prompt = GIT_ATTRIBUTION_PROMPT + ("\n\n" + system_prompt if system_prompt else "")
        if MEMORY_REUSE_PROMPT:
            system_prompt = MEMORY_REUSE_PROMPT + "\n\n" + system_prompt
    # When a task_id is provided, inject worker board instructions
    task_id = args.get("task_id")
    task = None
    if task_id:
        body["task_id"] = task_id
        system_prompt = WORKER_BOARD_PROMPT + ("\n\n" + system_prompt if system_prompt else "")
        task = api_call("GET", f"/tasks/{task_id}")
        if _task_is_alloy(task):
            if args.get("testing"):
                alloy_prompt = ALLOY_TESTER_SYSTEM_PROMPT_FRAGMENT
            elif args.get("documentation"):
                alloy_prompt = ALLOY_DOCUMENTOR_SYSTEM_PROMPT_FRAGMENT
            else:
                alloy_prompt = ALLOY_WORKER_SYSTEM_PROMPT_FRAGMENT
            if alloy_prompt and alloy_prompt not in system_prompt:
                system_prompt = alloy_prompt + ("\n\n" + system_prompt if system_prompt else "")
    if system_prompt:
        body["system_prompt"] = system_prompt
    body["auto_start"] = True  # Auto-start PTY so send_message works immediately
    result = api_call("POST", "/sessions", body)
    if isinstance(result, dict) and result.get("id") and not result.get("error"):
        mcp_ids = []
        guideline_ids = []
        overrides = {}
        tags = []
        if args.get("testing"):
            mcp_ids.append("builtin-playwright")
            guideline_ids.append("builtin-testing-agent")
            overrides["builtin-playwright"] = {"auto_approve_override": 1}
            tags.append("capability_testing")
            if args.get("show_browser"):
                tags.append("tester_headed")
        if args.get("documentation"):
            for mid in ("builtin-documentor", "builtin-playwright"):
                if mid not in mcp_ids:
                    mcp_ids.append(mid)
                overrides[mid] = {"auto_approve_override": 1}
            guideline_ids.append("builtin-documentation-agent")
            tags.append("capability_documentation")
            if args.get("allow_all_edits"):
                tags.append("unrestricted_edit")
        if task_id and mcp_ids and "builtin-worker-board" not in mcp_ids:
            mcp_ids.insert(0, "builtin-worker-board")
            overrides["builtin-worker-board"] = {"auto_approve_override": 1}
        if mcp_ids:
            api_call("PUT", f"/sessions/{result['id']}/mcp-servers", {
                "mcp_server_ids": mcp_ids,
                "overrides": overrides,
            })
        if guideline_ids:
            api_call("PUT", f"/sessions/{result['id']}/guidelines", {
                "guideline_ids": guideline_ids,
            })
        if tags:
            result = api_call("PUT", f"/sessions/{result['id']}", {"tags": tags})

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
        if kickoff and (args.get("testing") or session_type == "test_worker"):
            try:
                enriched = api_call("POST", "/review/brief", {
                    "instructions": kickoff,
                    "reviewed_session_id": (task or {}).get("assigned_session_id"),
                    "task_id": task_id,
                    "handoff_notes": (task or {}).get("result_summary"),
                })
                if isinstance(enriched, dict) and enriched.get("brief"):
                    kickoff = enriched["brief"]
                else:
                    from review_brief import build_review_brief
                    kickoff = build_review_brief(
                        kickoff,
                        board_card=task if isinstance(task, dict) else None,
                        handoff_notes=(task or {}).get("result_summary") if isinstance(task, dict) else None,
                    )
            except Exception:
                try:
                    from review_brief import build_review_brief
                    kickoff = build_review_brief(
                        kickoff,
                        board_card=task if isinstance(task, dict) else None,
                        handoff_notes=(task or {}).get("result_summary") if isinstance(task, dict) else None,
                    )
                except Exception:
                    pass
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
    for key in ("model", "backend", "depth", "feature_tag", "task_id"):
        if args.get(key):
            body[key] = args[key]
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
    if _app_setting("experimental_model_switching") != "on":
        return json.dumps({"error": "Model changes are user-controlled. Choose the worker model in IVE.", "code": "model_choice_locked"})
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
        "codex": [],  # discovered per account; see /api/cli-info
        "antigravity": [
            "gemini-2.5-flash",
            "Gemini 3.5 Flash (High)",
            "Gemini 3.1 Pro (High)",
        ],
    }
    # Prefer the backend's live ladder: for Codex it is built from the
    # account's models_cache.json at startup, so it never names models the
    # account does not have. The inline table is only an offline fallback.
    ladder = []
    info = api_call("GET", "/cli-info")
    if isinstance(info, dict):
        live = ((info.get("profiles") or {}).get(cli_type) or {}).get("model_ladder")
        if isinstance(live, list):
            ladder = [str(m) for m in live if m]
    if not ladder:
        ladder = _MODEL_LADDERS.get(cli_type, _MODEL_LADDERS["claude"])
    if not ladder and not new_model:
        return json.dumps({
            "error": "no_model_ladder",
            "cli_type": cli_type,
            "suggestion": "No known model list for this CLI. Pass an explicit 'model'.",
        })
    fallback_model = (ladder[1] if len(ladder) > 1 else ladder[0]) if ladder else ""
    current_model = session.get("model") or fallback_model
    max_model = ladder[-1] if ladder else ""
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
    effort = session.get("effort") or None  # None = CLI default

    # Create the replacement first: a rejected model must never delete the old chat.
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
    if result.get("error") or not result.get("id"):
        return json.dumps(result)
    # Preserve the old chat for review instead of deleting its history.
    api_call("PUT", f"/sessions/{session_id}", {"archived": 1})
    new_id = result["id"]
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



def tool_create_workspace(args: dict) -> str:
    body = {"path": args["path"]}
    for key in ("name", "create_dir"):
        if key in args:
            body[key] = args[key]
    result = api_call("POST", "/workspaces", body)
    return json.dumps(result, indent=2)


def _task_body_contribution(args: dict) -> dict:
    """Optional product metadata for a task; ordinary task fields remain core."""
    return {}


def tool_create_task(args: dict) -> str:
    body = {
        "workspace_id": args.get("workspace_id", WORKSPACE_ID),
        "title": args["title"],
    }
    for key in (
        "description", "acceptance_criteria", "status", "priority", "labels",
        "depends_on", "parent_task_id", "phase", "tier",
        "blueprint_path", "blueprint_status",
        "pipeline", "pipeline_max_iterations",
        "test_with_agent", "plan_first", "deep_research", "ralph_loop",
    ):
        if key in args:
            body[key] = args[key]
    body.update(_task_body_contribution(args))
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


def tool_report_test_result(args: dict) -> str:
    """Close the test-queue entry assigned to this bound MCP session."""
    entry_id = urllib.parse.quote(args["test_queue_id"], safe="")
    result = api_call("PUT", f"/test-queue/{entry_id}/report", {
        "outcome": args["outcome"],
        "result_summary": args["result_summary"],
    })
    return json.dumps(result, indent=2)


def tool_task_ready(args: dict) -> str:
    """Check whether a task's dependencies are complete."""
    task_id = args["task_id"]
    result = api_call("GET", f"/tasks/{task_id}/ready")
    return json.dumps(result, indent=2)


def tool_dispatch_task_when_ready(args: dict) -> str:
    """Persist a dispatch intent and fire it once dependencies are done."""
    task_id = args["task_id"]
    body = {}
    for key in ("mode", "target_session_id", "session_id"):
        if key in args:
            body[key] = args[key]
    result = api_call("POST", f"/tasks/{task_id}/dispatch-when-ready", body)
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


def tool_list_port_leases(args: dict) -> str:
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    if not ws_id:
        return json.dumps({"error": "workspace_id required"})
    params = []
    if args.get("scan"):
        params.append("scan=1")
    for key in ("start_port", "end_port"):
        if args.get(key) is not None:
            params.append(f"{key}={urllib.parse.quote(str(args[key]))}")
    suffix = "?" + "&".join(params) if params else ""
    result = api_call("GET", f"/workspaces/{ws_id}/ports{suffix}")
    return json.dumps(result, indent=2)


def tool_lease_port(args: dict) -> str:
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    if not ws_id:
        return json.dumps({"error": "workspace_id required"})
    body = {}
    for key in (
        "session_id", "task_id", "preferred_port", "port", "start_port",
        "end_port", "ttl_seconds", "label", "metadata", "strict",
    ):
        if key in args:
            body[key] = args[key]
    if COMMANDER_SESSION_ID and "session_id" not in body:
        body["session_id"] = COMMANDER_SESSION_ID
    result = api_call("POST", f"/workspaces/{ws_id}/ports/lease", body)
    return json.dumps(result, indent=2)


def tool_register_preview(args: dict) -> str:
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    if not ws_id:
        return json.dumps({"error": "workspace_id required"})
    body = {}
    for key in ("lease_id", "port", "url", "session_id", "task_id"):
        if key in args:
            body[key] = args[key]
    if COMMANDER_SESSION_ID and "session_id" not in body:
        body["session_id"] = COMMANDER_SESSION_ID
    result = api_call("POST", f"/workspaces/{ws_id}/previews/register", body)
    return json.dumps(result, indent=2)


def tool_heartbeat_port_lease(args: dict) -> str:
    lease_id = args["lease_id"]
    body = {}
    if args.get("ttl_seconds") is not None:
        body["ttl_seconds"] = args["ttl_seconds"]
    result = api_call("POST", f"/ports/{lease_id}/heartbeat", body)
    return json.dumps(result, indent=2)


def tool_release_port_lease(args: dict) -> str:
    lease_id = args["lease_id"]
    result = api_call("DELETE", f"/ports/{lease_id}")
    return json.dumps(result, indent=2)


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
    """Search explicitly selected ordinary workspace records and saved notes."""
    allowed = ("tasks", "knowledge", "messages", "files", "memory")
    requested = args.get("types") or ",".join(allowed)
    if not isinstance(requested, str):
        return json.dumps({"ok": False, "error": "types must be a comma-separated string"})
    selected = [item.strip() for item in requested.split(",") if item.strip()]
    if not selected or any(item not in allowed for item in selected):
        return json.dumps({"ok": False, "error": "Unsupported search types for the installed context provider"})
    query = args.get("query", "")
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    params = f"?q={urllib.parse.quote(query)}&types={','.join(selected)}&limit=5"
    from context_retrieval import search_result
    return search_result(api_call("GET", f"/workspaces/{ws_id}/memory-search{params}"), query)


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
    """Retrieve a bounded page of a named note; preserve exact content and cursors."""
    name = (args.get("name") or "").strip()
    ws_id = (args.get("workspace_id") or WORKSPACE_ID or "").strip()
    entry_id = str(args.get("id") or "").strip()
    if not name and not entry_id:
        return json.dumps({"ok": False, "error": "name or id is required"})

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
        if (str(e.get("id")) != entry_id if entry_id else (e.get("name") or "").strip().lower() != target):
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

    from context_retrieval import recall_result
    return recall_result(hit, "workspace" if workspace_match else "global", args)


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
                entry["context_health"] = d.get("context_health", "unknown")
                entry["reuse_notes"] = d.get("reuse_notes", {})
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





# ─── Myelin coordination tools (commander side) ─────────────────────────
# Mirror of the worker-side tools so commander can also coordinate
# (e.g. before dispatching a worker, or while doing its own edits).

_COMMANDER_AGENT_ID = f"commander_{WORKSPACE_ID or 'global'}"














def _unavailable_product_tool(extension_id: str):
    def unavailable(_args: dict) -> str:
        return json.dumps({"ok": False, "available": False, "error": f"{extension_id} extension is not installed or enabled"})
    return unavailable

tool_contribute_knowledge = _unavailable_product_tool("myelin")
tool_coord_check_overlap = _unavailable_product_tool("swarmlock")
tool_coord_acquire = _unavailable_product_tool("swarmlock")
tool_coord_release = _unavailable_product_tool("swarmlock")
tool_coord_peers = _unavailable_product_tool("swarmlock")
tool_check_coordination = _unavailable_product_tool("swarmlock")


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


def tool_request_capability_handoff(args: dict) -> str:
    """Create/reuse a capability worker and send it the handoff prompt."""
    body = {
        "capability": args["capability"],
        "prompt": args["prompt"],
        "workspace_id": args.get("workspace_id", WORKSPACE_ID),
        "source_session_id": args.get("source_session_id") or COMMANDER_SESSION_ID,
    }
    for key in (
        "task_id", "reason", "reuse", "allow_busy", "show_browser",
        "allow_all_edits", "name", "cli_type", "model", "permission_mode",
    ):
        if key in args:
            body[key] = args[key]
    result = api_call("POST", "/capabilities/handoff", body)
    return json.dumps(result, indent=2)


def tool_start_task_pipeline(args: dict) -> str:
    """Start the backend-owned visible execution pipeline for a task."""
    task_id = args["task_id"]
    body = {
        "execution_context": args.get("execution_context", ""),
        "assigned_session_id": args.get("assigned_session_id"),
    }
    options = {}
    for key in (
        "plan_first", "auto_approve_plan", "deep_research", "ralph_loop",
        "test_with_agent", "pipeline", "pipeline_max_iterations",
        "policy_roles",
    ):
        if key in args:
            options[key] = args.get(key)
    if options:
        body["options"] = options
    result = api_call("POST", f"/tasks/{task_id}/execute", body)
    return json.dumps(result, indent=2)


def tool_request_docs_update(args: dict) -> str:
    """Request documentation upkeep; optionally nudges a docs-capable worker."""
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    reason = args.get("reason", "Changes detected")
    affected = args.get("affected_features", [])

    # Emit event
    api_call("POST", "/events/emit", {
        "event_type": "docs_update_needed",
        "payload": {"reason": reason, "affected_features": affected, "workspace_id": ws_id},
    })

    # Try to send a message to a documentation-capable worker if one exists.
    sessions = api_call("GET", f"/sessions?workspace={urllib.parse.quote(ws_id)}")
    doc_session = None
    if isinstance(sessions, list):
        for sess in sessions:
            tags = sess.get("tags") or []
            if isinstance(tags, str):
                try:
                    tags = json.loads(tags or "[]")
                except Exception:
                    tags = []
            if "capability_documentation" in tags:
                doc_session = sess
                break
    if doc_session and not doc_session.get("error"):
        session_id = doc_session.get("id")
        if session_id:
            features_str = ", ".join(affected) if affected else "unspecified features"
            msg = f"Documentation update needed: {reason}. Affected features: {features_str}. Please check get_changes_since() and update relevant pages."
            api_call("POST", f"/sessions/{session_id}/input", {"message": msg})  # CR submits in raw-mode CLI TUIs (LF would leave it unsubmitted)
            return f"Docs update requested. Reason: {reason}. Message sent to documentation-capable session {session_id}."

    return f"Docs update event emitted. Reason: {reason}. No documentation-capable session found — event is queued."


# ─── Interactive Canvas: annotation data layer ────────────────────────────
# MCP surface over the canvas annotation store (vision/INTERACTIVE_CANVAS_FRAMEWORK.md
# §3) so ANY model can read the human's marks and write its own. These proxy to
# the backend HTTP endpoints (canvas_annotations.py) like every other tool here.
_CANVAS_ANNOTATION_KINDS = ("note", "box", "arrow", "highlight", "pen", "mark")


def tool_canvas_get_context(args: dict) -> str:
    """Read the structured annotation context a model reasons over for a canvas."""
    ws_id = (args.get("workspace_id") or WORKSPACE_ID or "").strip()
    canvas_id = (args.get("canvas_id") or "").strip()
    if not ws_id or not canvas_id:
        return json.dumps({"ok": False, "error": "workspace_id and canvas_id required"})
    result = api_call(
        "GET",
        f"/workspaces/{urllib.parse.quote(ws_id)}/canvas/{urllib.parse.quote(canvas_id)}/context",
    )
    return json.dumps(result, indent=2)


def tool_canvas_annotate(args: dict) -> str:
    """Write one annotation (author='model') onto a canvas."""
    ws_id = (args.get("workspace_id") or WORKSPACE_ID or "").strip()
    canvas_id = (args.get("canvas_id") or "").strip()
    kind = (args.get("kind") or "").strip()
    if not ws_id or not canvas_id:
        return json.dumps({"ok": False, "error": "workspace_id and canvas_id required"})
    if kind not in _CANVAS_ANNOTATION_KINDS:
        return json.dumps({"ok": False, "error": f"invalid kind {kind!r}; must be one of {list(_CANVAS_ANNOTATION_KINDS)}"})
    body = {"kind": kind, "author": "model"}
    for key in ("target_id", "text", "color", "coords"):
        if args.get(key) is not None:
            body[key] = args[key]
    result = api_call(
        "POST",
        f"/workspaces/{urllib.parse.quote(ws_id)}/canvas/{urllib.parse.quote(canvas_id)}/annotate",
        body,
    )
    return json.dumps(result, indent=2)


def tool_canvas_highlight(args: dict) -> str:
    """Record highlight annotations (one per element id, author='model')."""
    ws_id = (args.get("workspace_id") or WORKSPACE_ID or "").strip()
    canvas_id = (args.get("canvas_id") or "").strip()
    element_ids = args.get("element_ids") or []
    if not ws_id or not canvas_id:
        return json.dumps({"ok": False, "error": "workspace_id and canvas_id required"})
    if not isinstance(element_ids, list) or not element_ids:
        return json.dumps({"ok": False, "error": "element_ids must be a non-empty list"})
    result = api_call(
        "POST",
        f"/workspaces/{urllib.parse.quote(ws_id)}/canvas/{urllib.parse.quote(canvas_id)}/highlight",
        {"element_ids": element_ids},
    )
    return json.dumps(result, indent=2)


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
            "Search the available skills catalog for relevant agent skills. "
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
        "description": "Create a new worker session. Omit cli_type/model to use the workspace orchestration policy for the selected role; override cli_type only when the user asks for a specific CLI. Pass task_id to auto-assign a feature board task and give the worker tools to update its own ticket status. When task_id is set, the worker is also auto-kickoffed with a brief 'Begin work on your assigned task.' user message after PTY boot. Set testing=true to attach browser-testing MCP/guidelines or documentation=true to attach documentation MCP/guidelines while keeping the session a normal worker.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "name": {"type": "string"},
                "cli_type": {"type": "string", "enum": ["claude", "codex", "antigravity"], "description": "CLI family for the new session. Omit to use workspace policy/defaults."},
                "policy_role": {"type": "string", "enum": ["brain", "summary", "brainstormer", "architect", "planner", "plan_critic", "default_worker", "cheap_worker", "strong_worker", "code_reviewer", "tester", "documentor", "secure"], "description": "Workspace orchestration role used for model/provider defaults when model or cli_type is omitted."},
                "model": {"type": "string", "description": "Model id for the selected CLI. Omit to use the workspace policy or CLI profile role default."},
                "permission_mode": {"type": "string", "description": "Permission mode for the selected CLI. Omit to use the CLI profile default."},
                "system_prompt": {"type": "string"},
                "session_type": {"type": "string", "enum": ["worker", "test_worker", "planner", "architect", "brainstormer"], "default": "worker", "description": "Session type. Prefer worker plus testing/documentation capabilities for normal work. 'planner' injects the Planner system prompt and decomposes one bounded intent into sub-tasks; 'architect' injects the Architect system prompt and turns a whole-application/greenfield goal into a north-star + epic roadmap for approval; 'brainstormer' is for intake and candidate backlog ideation, not implementation."},
                "task_id": {"type": "string", "description": "Feature board task ID to assign to this worker. The worker gets MCP tools to update its own task status (planning/in_progress/review/done)."},
                "plan_first": {"type": "boolean", "default": False, "description": "If true, worker must plan and wait for user approval before implementing."},
                "ralph_loop": {"type": "boolean", "default": False, "description": "If true, worker uses Ralph mode — persistent execution loop that keeps going until all tests/build pass."},
                "testing": {"type": "boolean", "default": False, "description": "Attach Playwright MCP and the testing-agent guideline to this worker."},
                "show_browser": {"type": "boolean", "default": False, "description": "When testing=true, run Playwright headed for visible browser debugging."},
                "documentation": {"type": "boolean", "default": False, "description": "Attach Documentor MCP, Playwright MCP, and the documentation-agent guideline to this worker."},
                "allow_all_edits": {"type": "boolean", "default": False, "description": "When documentation=true, tag the worker to allow documentation edits outside docs."},
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
        "description": "Escalate a failing worker by stopping it and restarting with a more capable model. Auto-detects Claude, Codex, or Antigravity CLI type. Preserves task assignment and system prompt. Use when a worker fails after receiving guidance. Returns 'already_at_max_model' if already at the top — mark task as blocked and ask the user.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string", "description": "The failing worker's session ID"},
                "model": {"type": "string", "description": "Explicit target model. If omitted, auto-escalates to the next tier up for the session's active CLI."},
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
    "create_workspace": {
        "handler": tool_create_workspace,
        "description": "Create a folder/directory on disk and register it as a project workspace. THE tool for any 'create a folder / neuen Ordner erstellen / new directory / new project' request — set create_dir true and the folder is created (with parents) wherever path points, e.g. on the Desktop.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "REQUIRED. Absolute or ~-relative project directory, e.g. ~/Desktop/my-project. When the user names no location, derive a kebab-case folder name from the project name and default to ~/Desktop/<kebab-name> with create_dir=true."},
                "name": {"type": "string", "description": "Display name; defaults to the directory basename."},
                "create_dir": {"type": "boolean", "description": "Create the directory when it does not exist instead of failing. Set true whenever starting a brand-new project."},
            },
            "required": ["path"],
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
                "status": {"type": "string", "enum": ["backlog", "todo", "planning", "in_progress", "review", "done", "blocked"]},
                "priority": {"type": "integer", "enum": [0, 1, 2]},
                "labels": {"type": "array", "items": {"type": "string"}},
                "depends_on": {"type": "array", "items": {"type": "string"}, "description": "Task IDs this task depends on (must complete before this task starts)"},
                "parent_task_id": {"type": "string", "description": "Parent task ID for hierarchical tasks."},
                "phase": {"type": "integer", "description": "Execution phase for epic-tier tasks. Use 0 only for baseline audit/check work; 1 is the first implementation phase."},
                "tier": {"type": "string", "enum": ["goal", "epic"], "description": "Long-horizon orchestration tier. Use goal for a whole-app blueprint root; epics are normally filed by the Architect."},
                "blueprint_path": {"type": "string", "description": "Goal-only path to the prose blueprint markdown file."},
                "blueprint_status": {"type": "string", "enum": ["draft", "awaiting_approval", "approved", "rejected", "revision_requested"], "description": "Goal-only blueprint lifecycle status."},
                "pipeline": {"type": "boolean", "description": "Override whether this task starts a visible pipeline run. Alloy tickets should default false unless the user explicitly asks for pipeline tracking."},
                "pipeline_max_iterations": {"type": "integer", "description": "Max retry loops for pipeline execution."},
                "test_with_agent": {"type": "boolean", "description": "Require a testing-capable worker. For Alloy, set true when generated SDK/MCP tools will be relied on, shipped, promoted, or reused."},
                "plan_first": {"type": "boolean", "description": "Require implementation planning before edits."},
                "deep_research": {"type": "boolean", "description": "Run deep research before implementation."},
                "ralph_loop": {"type": "boolean", "description": "Run execute/verify/fix until checks pass."},
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
    "report_test_result": {
        "handler": tool_report_test_result,
        "description": (
            "Report pass/fail for the running test-queue entry assigned to this "
            "session. A successful report completes the entry and releases the next test."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "test_queue_id": {"type": "string", "description": "Assigned test-queue entry ID."},
                "outcome": {"type": "string", "enum": ["pass", "fail"]},
                "result_summary": {
                    "type": "string",
                    "maxLength": 2000,
                    "description": "Short test result summary, including key evidence or failures.",
                },
            },
            "required": ["test_queue_id", "outcome", "result_summary"],
        },
    },
    "task_ready": {
        "handler": tool_task_ready,
        "description": "Check whether a task's dependencies are complete. Returns {ready, blockers}.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
            },
            "required": ["task_id"],
        },
    },
    "dispatch_task_when_ready": {
        "handler": tool_dispatch_task_when_ready,
        "description": (
            "Persist a dispatch intent for a task. If dependencies are ready, IVE sends it "
            "to Commander now; otherwise IVE dispatches it when blockers move to done/verified."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
                "mode": {"type": "string", "default": "commander"},
                "target_session_id": {"type": "string"},
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
                "model": {"type": "string", "description": "Provider-qualified research model id (for example claude:sonnet). Omit to use the workspace setting."},
                "backend": {"type": "string", "enum": ["auto", "cli", "standalone"], "description": "Research mode: 'cli' = an agent decomposes and researches itself (recommended); 'standalone' = direct engine; 'auto' = pick based on availability."},
                "depth": {"type": "string", "enum": ["quick", "standard", "deep"], "description": "How thorough the research should be."},
                "feature_tag": {"type": "string", "description": "Optional label grouping this research under a feature/topic."},
                "task_id": {"type": "string", "description": "Optional feature-board task to PARK on this research: the task waits in backlog and auto-resumes when the research completes (or unblocks if it fails). Use when a task can't proceed until this research lands."},
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
    "list_port_leases": {
        "handler": tool_list_port_leases,
        "description": (
            "List active port leases for a workspace. Pass scan=true to also report occupied "
            "ports in a bounded range, so agents can see which ports are blocked and why."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "scan": {"type": "boolean"},
                "start_port": {"type": "integer"},
                "end_port": {"type": "integer"},
            },
        },
    },
    "lease_port": {
        "handler": tool_lease_port,
        "description": (
            "Ask IVE to reserve a local dev-server port before starting a server. "
            "The response includes the lease and blocked_ports for ports that were leased or already occupied."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "session_id": {"type": "string"},
                "task_id": {"type": "string"},
                "preferred_port": {"type": "integer"},
                "start_port": {"type": "integer"},
                "end_port": {"type": "integer"},
                "ttl_seconds": {"type": "integer"},
                "label": {"type": "string"},
                "metadata": {"type": "object"},
                "strict": {"type": "boolean"},
            },
        },
    },
    "register_preview": {
        "handler": tool_register_preview,
        "description": (
            "Register a preview URL from an active port lease. Use after the dev server starts; "
            "this updates the workspace preview_url through IVE."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "lease_id": {"type": "string"},
                "port": {"type": "integer"},
                "url": {"type": "string"},
                "session_id": {"type": "string"},
                "task_id": {"type": "string"},
            },
        },
    },
    "heartbeat_port_lease": {
        "handler": tool_heartbeat_port_lease,
        "description": "Extend an active port lease TTL while a dev server is still running.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "lease_id": {"type": "string"},
                "ttl_seconds": {"type": "integer"},
            },
            "required": ["lease_id"],
        },
    },
    "release_port_lease": {
        "handler": tool_release_port_lease,
        "description": "Release a port lease when the dev server is stopped.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "lease_id": {"type": "string"},
            },
            "required": ["lease_id"],
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
    "description": "Find at most five short excerpts from workspace tasks, knowledge, peer messages, file activity and saved notes. Narrow types/query before fetching details.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Text to search for.",
            },
            "types": {
                "type": "string",
                "description": "Comma-separated: tasks,knowledge,messages,files,memory. Default: all listed types.",
            },
            "workspace_id": {
                "type": "string",
            },
        },
        "required": [
            "query",
        ],
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
    "description": "Save an explicit workspace note. Reusing its name updates the existing note in the same workspace. Include canonical source file paths for file-backed notes.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Note title; identifies this note within its workspace.",
            },
            "type": {
                "type": "string",
                "enum": [
                    "user",
                    "feedback",
                    "project",
                    "reference",
                ],
            },
            "content": {
                "type": "string",
                "description": "Note text. Include source file paths when applicable.",
            },
            "description": {
                "type": "string",
                "description": "Optional short summary for the notes index.",
            },
            "tags": {
                "type": "array",
                "items": {
                    "type": "string",
                },
            },
            "workspace_id": {
                "type": "string",
            },
        },
        "required": [
            "name",
            "type",
            "content",
        ],
    },
}
TOOLS["recall_memory"] = {
    "handler": tool_recall_memory,
    "description": (
        "Expand a memory entry from the Remembered Context index. When the system "
        "prompt shows entries as one-liners ('name — description'), call this with "
        "the name to fetch a bounded excerpt. Use next_offset only if needed. Don't call for entries "
        "you already have inlined — only when an index description looks relevant and "
        "you need the details."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Exact entry name from the index."},
            "workspace_id": {"type": "string"},
            "id": {"type": "string", "description": "Exact note id from a search hit; alternative to name."},
            "offset": {"type": "integer", "minimum": 0, "description": "Character offset from the previous next_offset; default 0."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 4000, "description": "Maximum content characters; default 2000."},
        },
        "anyOf": [{"required": ["name"]}, {"required": ["id"]}],
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
if extension_available("myelin"):
    from extension_host import load_backend_module as _load_fact_provider
    _fact_provider = _load_fact_provider("myelin", "backend/mcp_fact_tools.py")
    _fact_tools = _fact_provider.build_tools({
        "api_call": lambda *args, **kwargs: api_call(*args, **kwargs),
        "get_workspace_id": lambda: WORKSPACE_ID,
        "get_agent_id": lambda: COMMANDER_SESSION_ID,
        "extension_available": extension_available,
    }, role="commander")
    TOOLS.update(_fact_tools)
    for _extension_tool_name, _extension_tool_spec in _fact_tools.items():
        globals()["tool_" + _extension_tool_name] = _extension_tool_spec["handler"]



def tool_record_run(args: dict) -> str:
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    body = {k: v for k, v in args.items() if k != "workspace_id"}
    result = api_call("POST", f"/workspaces/{ws_id}/workflow_runs", body)
    return json.dumps(result, indent=2)


def tool_list_workflow_runs(args: dict) -> str:
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    qs = []
    for key in ("status", "kind", "limit"):
        if args.get(key) not in (None, ""):
            qs.append(f"{key}={args[key]}")
    path = f"/workspaces/{ws_id}/workflow_runs" + ("?" + "&".join(qs) if qs else "")
    result = api_call("GET", path, None)
    return json.dumps(result, indent=2)


TOOLS["record_run"] = {
    "handler": tool_record_run,
    "description": (
        "Persist the provenance of a 'sweep' / multi-agent fan-out so its structure "
        "survives after the ephemeral agents exit. A Claude Code Workflow, an IVE-hosted "
        "sweep, or any runtime (agy/codex) calls this once at start (status='running') and "
        "again at the end (status='completed'|'failed') with the SAME `id` — it upserts. "
        "Send the sweep's `result` synthesis and the per-agent `subagents` list for a durable "
        "record. NOTE: the sweep's actual FINDINGS should still be written to their normal "
        "home (save_memory for selected notes); this tool "
        "records the run itself, not the knowledge it produced."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "Stable run id — reuse across start/finish calls to upsert one row. Omit to mint a new one."},
            "kind": {"type": "string", "description": "sweep | review | research | code_understanding | custom"},
            "label": {"type": "string", "description": "Human label / workflow name."},
            "source": {"type": "string", "description": "claude_workflow | ive_run_sweep | external"},
            "runtime": {"type": "string", "description": "claude | codex | antigravity | gemini"},
            "status": {"type": "string", "description": "running | completed | failed | cancelled"},
            "agents_total": {"type": "integer"},
            "agents_done": {"type": "integer"},
            "subagents": {"type": "array", "items": {"type": "object"}, "description": "[{agent_id,label,status,result_preview,transcript_path}]"},
            "params": {"type": "object", "description": "The sweep request / input params."},
            "result": {"type": "string", "description": "Final synthesis (text or JSON)."},
            "error": {"type": "string"},
            "workspace_id": {"type": "string"},
        },
    },
}
TOOLS["list_workflow_runs"] = {
    "handler": tool_list_workflow_runs,
    "description": (
        "List recent sweep / workflow runs for the workspace (newest first). Use to warm-start: "
        "before launching a fresh sweep, check whether a recent run of the same kind already "
        "covered this ground, and read its `result`/`subagents` instead of re-running."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "status": {"type": "string", "description": "Filter by status."},
            "kind": {"type": "string", "description": "Filter by kind."},
            "limit": {"type": "integer", "description": "Max rows (default 50, cap 500)."},
            "workspace_id": {"type": "string"},
        },
    },
}


def tool_run_sweep(args: dict) -> str:
    body = dict(args)
    body.setdefault("workspace_id", WORKSPACE_ID)
    result = api_call("POST", "/orchestration/sweeps", body)
    return json.dumps(result, indent=2)


TOOLS["run_sweep"] = {
    "handler": tool_run_sweep,
    "description": (
        "Run an IVE-hosted 'sweep' — a parallel multi-agent fan-out — and get back a "
        "synthesized result. Each string in `prompts` runs concurrently as its own agent; "
        "an optional synthesis pass merges them. Use this when you want ephemeral fan-out "
        "but have no native Workflow engine (e.g. from agy/codex), or to offload a fan-out "
        "server-side. The run is recorded in workflow_runs (see list_workflow_runs). Write "
        "durable FINDINGS to their home yourself (save_memory)."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "prompts": {"type": "array", "items": {"type": "string"}, "description": "One prompt per parallel agent (max 32)."},
            "label": {"type": "string", "description": "Human label for the run."},
            "parallel": {"type": "integer", "description": "Max concurrent agents (1-8, default 4)."},
            "synthesize": {"type": "boolean", "description": "Run a final pass merging agent outputs (default true)."},
            "synthesis_prompt": {"type": "string", "description": "Custom instruction for the synthesis pass."},
            "model": {"type": "string", "description": "Provider-qualified model id (default claude:sonnet)."},
            "kind": {"type": "string", "description": "sweep | review | research | code_understanding"},
            "workspace_id": {"type": "string"},
        },
        "required": ["prompts"],
    },
}

# Optional semantic coordination belongs to SwarmLock.
_SWARMLOCK_TOOLS = {}
if extension_available("swarmlock"):
    from extension_host import load_legacy_namespace as _load_extension_namespace
    __SWARMLOCK_TOOLS_namespace = {"__name__": "_ive_swarmlock_commander_tools"}
    _load_extension_namespace(__SWARMLOCK_TOOLS_namespace, "swarmlock", "backend/commander_tools.py")
    _SWARMLOCK_TOOLS = __SWARMLOCK_TOOLS_namespace["build_tools"]({
        "api_call": lambda *args, **kwargs: api_call(*args, **kwargs),
        "get_workspace_id": lambda: WORKSPACE_ID,
        "get_agent_id": lambda: _COMMANDER_AGENT_ID,
    })
    for _extension_tool_name, _extension_tool_spec in _SWARMLOCK_TOOLS.items():
        globals()["tool_" + _extension_tool_name] = _extension_tool_spec["handler"]
TOOLS.update(_SWARMLOCK_TOOLS)
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

TOOLS["request_capability_handoff"] = {
    "handler": tool_request_capability_handoff,
    "description": (
        "Create or reuse a normal worker with a specific capability and send it a handoff prompt. "
        "Use this when the current session decides the request needs browser testing or documentation "
        "tools instead of doing keyword-based UI routing or mutating the current session midstream."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "capability": {"type": "string", "enum": ["testing", "documentation"], "description": "Capability worker needed."},
            "prompt": {"type": "string", "description": "Full user/request prompt to send to the capability worker."},
            "reason": {"type": "string", "description": "Why this should be handled by a capability worker."},
            "workspace_id": {"type": "string", "description": "Workspace id. Defaults to this Commander workspace."},
            "source_session_id": {"type": "string", "description": "Session requesting the handoff. Defaults to this Commander session."},
            "task_id": {"type": "string", "description": "Optional feature board task to bind as the active ticket."},
            "reuse": {"type": "boolean", "default": True, "description": "Reuse an idle matching capability worker when possible."},
            "allow_busy": {"type": "boolean", "default": False, "description": "Allow sending to a running matching worker."},
            "show_browser": {"type": "boolean", "default": False, "description": "For testing, request headed Playwright."},
            "allow_all_edits": {"type": "boolean", "default": False, "description": "For documentation, allow edits outside docs/."},
            "name": {"type": "string", "description": "Optional name when a new worker is created."},
            "cli_type": {"type": "string", "enum": ["claude", "codex", "antigravity"], "description": "Optional CLI override."},
            "model": {"type": "string", "description": "Optional model override."},
            "permission_mode": {"type": "string", "description": "Optional permission-mode override."},
        },
        "required": ["capability", "prompt"],
    },
}

TOOLS["start_task_pipeline"] = {
    "handler": tool_start_task_pipeline,
    "description": (
        "Start the backend-owned visible execution pipeline for a task. Use this instead of "
        "hand-rolling plan/deep-research/Ralph/tester flows in Commander. The backend creates "
        "a pipeline run with stage history and task status updates. Pass explicit options when "
        "Commander is choosing the execution shape at run time."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "task_id": {"type": "string", "description": "Task ID to execute via visible pipeline."},
            "execution_context": {"type": "string", "description": "Optional scratchpad, attachment, or handoff context."},
            "assigned_session_id": {"type": "string", "description": "Optional implementation session to use for the implement/fix stages."},
            "plan_first": {"type": "boolean", "description": "Override whether the run starts with planner + critic stages."},
            "auto_approve_plan": {"type": "boolean", "description": "Override whether plan approval pauses the run."},
            "deep_research": {"type": "boolean", "description": "Override whether the run starts with backend deep research."},
            "ralph_loop": {"type": "boolean", "description": "Override whether verification failure loops through fix + re-verify."},
            "test_with_agent": {"type": "boolean", "description": "Override whether tester verification is required."},
            "pipeline": {"type": "boolean", "description": "Force a visible pipeline run even for otherwise simple execution."},
            "pipeline_max_iterations": {"type": "integer", "description": "Maximum loop iterations for this task run, clamped by the backend."},
            "policy_roles": {
                "type": "object",
                "description": "Optional model-policy role overrides by stage, e.g. planner, plan_critic, implement, verify, fix.",
                "additionalProperties": {"type": "string"},
            },
        },
        "required": ["task_id"],
    },
}

TOOLS["request_docs_update"] = {
    "handler": tool_request_docs_update,
    "description": (
        "Request documentation updates. Emits a DOCS_UPDATE_NEEDED event "
        "and sends a message to a documentation-capable session if one is running. Use this after completing "
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
TOOLS["canvas_get_context"] = {
    "handler": tool_canvas_get_context,
    "description": (
        "Read the structured annotation context for an interactive canvas/graph. "
        "Returns {annotations:[{kind,target_id,text,color,author,coords}], "
        "highlighted_ids:[...]} — the human's element-anchored marks as DATA (not a "
        "screenshot) plus the distinct element ids that are highlighted or model-marked. "
        "Call this FIRST to see what the human pointed at before you reason or reply."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "workspace_id": {"type": "string", "description": "Workspace ID. Defaults to current workspace."},
            "canvas_id": {"type": "string", "description": "The canvas/graph identifier whose annotations to read."},
        },
        "required": ["canvas_id"],
    },
}
TOOLS["canvas_annotate"] = {
    "handler": tool_canvas_annotate,
    "description": (
        "Write one annotation onto an interactive canvas/graph (author='model') so the "
        "human's viewer can render it. Use this to point back at the elements you mean: "
        "anchor a mark to a graph element via target_id, optionally with text/color/coords. "
        "kind must be one of note|box|arrow|highlight|pen|mark. For lighting up several "
        "elements at once, prefer canvas_highlight."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "workspace_id": {"type": "string", "description": "Workspace ID. Defaults to current workspace."},
            "canvas_id": {"type": "string", "description": "The canvas/graph identifier to annotate."},
            "kind": {
                "type": "string",
                "enum": list(_CANVAS_ANNOTATION_KINDS),
                "description": "Annotation kind.",
            },
            "target_id": {"type": "string", "description": "Graph element id this mark anchors to (what makes it interpretable)."},
            "text": {"type": "string", "description": "Optional note/label for the mark."},
            "color": {"type": "string", "description": "Optional render color (e.g. '#ffd33d')."},
            "coords": {"type": "object", "description": "Optional pixel-sharp render coords (any JSON shape)."},
        },
        "required": ["canvas_id", "kind"],
    },
}
TOOLS["canvas_highlight"] = {
    "handler": tool_canvas_highlight,
    "description": (
        "Highlight one or more graph elements on an interactive canvas — records a "
        "highlight annotation per element id (author='model') so the viewer lights them "
        "up. This is how a model 'points' at the elements its answer is about. Returns "
        "the count recorded."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "workspace_id": {"type": "string", "description": "Workspace ID. Defaults to current workspace."},
            "canvas_id": {"type": "string", "description": "The canvas/graph identifier to highlight on."},
            "element_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Graph element ids to highlight.",
            },
        },
        "required": ["canvas_id", "element_ids"],
    },
}


if extension_available("myelin"):
    from extension_host import load_legacy_namespace as _load_extension_namespace
    _memory_guidance_namespace = {"__name__": "_ive_myelin_commander_guidance"}
    _load_extension_namespace(_memory_guidance_namespace, "myelin", "backend/mcp_memory_guidance.py")
    MEMORY_REUSE_PROMPT = _memory_guidance_namespace["memory_reuse_prompt"](
        catalogue_available=extension_available("forge"),
    )
    _memory_guidance_host = {"api_call": lambda *args, **kwargs: api_call(*args, **kwargs), "get_workspace_id": lambda: WORKSPACE_ID}
    _memory_guidance_namespace["extend_mcp_tools"](TOOLS, role="commander", host=_memory_guidance_host)
    tool_search_memory = TOOLS["search_memory"]["handler"]


if extension_available("forge"):
    from forge_mcp import extend_mcp_tools, task_body_contribution as _task_body_contribution
    extend_mcp_tools(TOOLS, role="commander")


if extension_available("company"):
    from extension_host import load_backend_module as _load_company_tools
    _company_tool_provider = _load_company_tools("company", "backend/commander_tools.py")
    _company_tools = _company_tool_provider.build_tools({
        "api_call": lambda *args, **kwargs: api_call(*args, **kwargs),
    })
    TOOLS.update(_company_tools)
    for _extension_tool_name, _extension_tool_spec in _company_tools.items():
        globals()["tool_" + _extension_tool_name] = _extension_tool_spec["handler"]


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
