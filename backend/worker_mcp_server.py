#!/usr/bin/env python3
"""
Lightweight MCP server for worker sessions.

Gives workers visibility into their own assigned task(s) on the feature board
and lets them self-report status transitions (planning → in_progress → review → done).

Scoped by WORKER_SESSION_ID — workers can only read/update tasks assigned to them.
Runs as a stdio MCP server, same pattern as mcp_server.py.
"""

import json
import os
import sys
import urllib.request
import urllib.error
import urllib.parse

from extension_host import available as extension_available

API_URL = os.environ.get("COMMANDER_API_URL", "http://127.0.0.1:5111")
SESSION_ID = os.environ.get("WORKER_SESSION_ID", "")
WORKSPACE_ID = os.environ.get("WORKER_WORKSPACE_ID", "")
SESSION_TYPE = os.environ.get("WORKER_SESSION_TYPE", "worker")
IVE_ALLOY_ENABLED = os.environ.get("IVE_ALLOY_ENABLED", "")

SUPPORTED_BLUEPRINT_PLAN_DIRS = (
    "~/.claude/plans",
    "~/.codex/plans",
    "~/.gemini/plans",
)


def api_call(method: str, path: str, body: dict | None = None) -> dict | list:
    url = f"{API_URL}/api{path}"
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"} if body else {}
    # Identify the caller so the backend can apply per-session scoping
    # (task ownership, planner-only routes, workspace pinning). The headers
    # come from env injected at PTY start; see _autostart_session_pty and
    # the start_pty path in server.py.
    if SESSION_ID:
        headers["X-IVE-Session-Id"] = SESSION_ID
        # Session proof from the PTY env (see backend/session_proofs.py);
        # only when it belongs to the session this server speaks for.
        from os import environ as _environ
        _proof = _environ.get("COMMANDER_SESSION_PROOF", "")
        if _proof and (_environ.get("COMMANDER_SESSION_ID") or SESSION_ID) == SESSION_ID:
            headers["X-IVE-Session-Proof"] = _proof
    if SESSION_TYPE:
        headers["X-IVE-Session-Type"] = SESSION_TYPE
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
        # Try to surface the structured body for 4xx/5xx responses so callers
        # see the same shape as a successful response (e.g. the dedup-on-create
        # gate returns 409 with {error, warning, candidates} that workers must
        # be able to inspect). Fall back to the raw string for non-JSON bodies.
        raw = e.read().decode()
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                parsed.setdefault("status", e.code)
                return parsed
        except Exception:
            pass
        return {"error": raw, "status": e.code}
    except Exception as e:
        return {"error": str(e)}


def _is_supported_blueprint_path(raw_path: str) -> bool:
    if not raw_path:
        return False
    try:
        expanded = os.path.realpath(os.path.expanduser(raw_path))
    except Exception:
        return False
    if not expanded.endswith(".md"):
        return False
    for plan_dir in SUPPORTED_BLUEPRINT_PLAN_DIRS:
        root = os.path.realpath(os.path.expanduser(plan_dir))
        try:
            if os.path.commonpath([expanded, root]) == root:
                return True
        except ValueError:
            continue
    return False


# ─── Ownership check ────────────────────────────────────────────────────

def _is_my_task(task_id: str) -> dict | None:
    """Fetch a task and verify it's assigned to this session. Returns task or None."""
    task = api_call("GET", f"/tasks/{task_id}")
    if isinstance(task, dict) and task.get("assigned_session_id") == SESSION_ID:
        return task
    return None


def _read_my_task(task_id: str) -> dict:
    """Read an explicit pipeline assignment without granting mutation rights."""
    task = api_call("GET", f"/tasks/{urllib.parse.quote(task_id, safe='')}")
    if isinstance(task, dict) and task.get("error"):
        return task
    if not isinstance(task, dict) or not SESSION_ID or task.get("workspace_id") != WORKSPACE_ID:
        return {"error": "Task not found or not assigned to this session"}
    if task.get("assigned_session_id") == SESSION_ID:
        return task
    # Planners/reviewers share the task through sessions.task_id; they are
    # deliberately not made the implementation assignee on the task board.
    session = api_call("GET", f"/sessions/{urllib.parse.quote(SESSION_ID, safe='')}")
    if (isinstance(session, dict) and session.get("id") == SESSION_ID
            and session.get("workspace_id") == WORKSPACE_ID
            and session.get("task_id") == task_id):
        return task
    return {"error": "Task not found or not assigned to this session"}


# ─── Tool implementations ───────────────────────────────────────────────

def tool_get_my_tasks(args: dict) -> str:
    """List all tasks assigned to this worker session."""
    status = args.get("status_filter", "all")
    path = f"/tasks?assigned_session={SESSION_ID}"
    if status != "all":
        path += f"&status={status}"
    result = api_call("GET", path)
    if isinstance(result, list) and SESSION_ID:
        session = api_call("GET", f"/sessions/{urllib.parse.quote(SESSION_ID, safe='')}")
        task_id = session.get("task_id") if isinstance(session, dict) else None
        if task_id and session.get("workspace_id") == WORKSPACE_ID and not any(t.get("id") == task_id for t in result):
            task = _read_my_task(task_id)
            if not task.get("error") and (status == "all" or task.get("status") == status):
                result.append(task)
    return json.dumps(result, indent=2)


def tool_get_my_task(args: dict) -> str:
    """Get full details of an assigned task, including attachments."""
    task_id = args.get("task_id")
    if task_id is None:
        session = api_call("GET", f"/sessions/{urllib.parse.quote(SESSION_ID, safe='')}") if SESSION_ID else None
        if (isinstance(session, dict) and session.get("id") == SESSION_ID
                and session.get("workspace_id") == WORKSPACE_ID):
            task_id = session.get("task_id")
    if not isinstance(task_id, str) or not task_id.strip():
        return json.dumps({"error": "Provide task_id, or use a session bound to a task."})
    task = _read_my_task(task_id)
    if task.get("error"):
        return json.dumps(task)
    # Pull attachments separately — image paths land here so the worker
    # can actually read referenced screenshots/diagrams.
    attachments = api_call("GET", f"/tasks/{task_id}/attachments")
    if isinstance(attachments, list):
        task["attachments"] = attachments
    return json.dumps(task, indent=2)


def tool_update_my_task(args: dict) -> str:
    """Update status or result_summary of an assigned task."""
    task_id = args["task_id"]
    task = _is_my_task(task_id)
    if not task:
        return json.dumps({"error": "Task not found or not assigned to this session"})

    body = {}
    for key in ("status", "result_summary", "lessons_learned", "important_notes"):
        if key in args:
            body[key] = args[key]
    if not body:
        return json.dumps({"error": "Nothing to update. Provide status, result_summary, lessons_learned, or important_notes."})

    # Tag the update as coming from the worker
    result = api_call("PUT", f"/tasks/{task_id}", body)
    return json.dumps(result, indent=2)


def tool_task_ready(args: dict) -> str:
    """Check whether a task's dependencies are complete."""
    task_id = args["task_id"]
    result = api_call("GET", f"/tasks/{task_id}/ready")
    return json.dumps(result, indent=2)


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


def tool_get_workspace_runtime_env(args: dict) -> str:
    """Return detected workspace toolchain/interpreter guidance."""
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    if not ws_id:
        return json.dumps({"error": "workspace_id required"})
    result = api_call("GET", f"/workspaces/{ws_id}/runtime-env")
    return json.dumps(result, indent=2)


def tool_lease_port(args: dict) -> str:
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    if not ws_id:
        return json.dumps({"error": "workspace_id required"})
    body = {}
    for key in (
        "task_id", "preferred_port", "port", "start_port", "end_port",
        "ttl_seconds", "label", "metadata", "strict",
    ):
        if key in args:
            body[key] = args[key]
    if SESSION_ID:
        body["session_id"] = SESSION_ID
    result = api_call("POST", f"/workspaces/{ws_id}/ports/lease", body)
    return json.dumps(result, indent=2)


def tool_register_preview(args: dict) -> str:
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    if not ws_id:
        return json.dumps({"error": "workspace_id required"})
    body = {}
    for key in ("lease_id", "port", "url", "task_id"):
        if key in args:
            body[key] = args[key]
    if SESSION_ID:
        body["session_id"] = SESSION_ID
    result = api_call("POST", f"/workspaces/{ws_id}/previews/register", body)
    return json.dumps(result, indent=2)


def tool_alloy_register_server(args: dict) -> str:
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    if not ws_id:
        return json.dumps({"error": "workspace_id required"})
    body = {}
    for key in (
        "id", "slug", "name", "description", "command", "args", "cwd", "env",
        "manifest_path", "raw_spec_path", "normalized_spec_path", "sdk_path",
        "mcp_path", "write_manifest",
    ):
        if key in args:
            body[key] = args[key]
    result = api_call("POST", f"/workspaces/{ws_id}/alloy/servers", body)
    return json.dumps(result, indent=2)


def tool_alloy_record_run(args: dict) -> str:
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    if not ws_id:
        return json.dumps({"error": "workspace_id required"})
    body = {}
    for key in (
        "id", "server_id", "task_id", "engine", "language", "raw_spec_path",
        "normalized_spec_path", "output_path", "manifest_path", "status", "logs",
    ):
        if key in args:
            body[key] = args[key]
    result = api_call("POST", f"/workspaces/{ws_id}/alloy/runs", body)
    return json.dumps(result, indent=2)


def tool_alloy_list_servers(args: dict) -> str:
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    if not ws_id:
        return json.dumps({"error": "workspace_id required"})
    result = api_call("GET", f"/workspaces/{ws_id}/alloy/servers")
    return json.dumps(result, indent=2)


def tool_alloy_get_server(args: dict) -> str:
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    server_id = args["server_id"]
    if not ws_id:
        return json.dumps({"error": "workspace_id required"})
    result = api_call("GET", f"/workspaces/{ws_id}/alloy/servers/{urllib.parse.quote(server_id)}")
    return json.dumps(result, indent=2)


def tool_alloy_healthcheck(args: dict) -> str:
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    server_id = args["server_id"]
    if not ws_id:
        return json.dumps({"error": "workspace_id required"})
    result = api_call("POST", f"/workspaces/{ws_id}/alloy/servers/{urllib.parse.quote(server_id)}/healthcheck", {})
    return json.dumps(result, indent=2)


def tool_alloy_list_tools(args: dict) -> str:
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    server_id = args["server_id"]
    if not ws_id:
        return json.dumps({"error": "workspace_id required"})
    result = api_call("GET", f"/workspaces/{ws_id}/alloy/servers/{urllib.parse.quote(server_id)}/tools")
    return json.dumps(result, indent=2)


def tool_alloy_call_tool(args: dict) -> str:
    ws_id = args.get("workspace_id", WORKSPACE_ID)
    server_id = args["server_id"]
    if not ws_id:
        return json.dumps({"error": "workspace_id required"})
    body = {
        "tool_name": args["tool_name"],
        "arguments": args.get("arguments") or {},
    }
    if args.get("timeout") is not None:
        body["timeout"] = args["timeout"]
    result = api_call("POST", f"/workspaces/{ws_id}/alloy/servers/{urllib.parse.quote(server_id)}/call", body)
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


def tool_request_capability_handoff(args: dict) -> str:
    """Ask IVE to run this prompt in a testing/docs-capable worker."""
    body = {
        "capability": args["capability"],
        "prompt": args["prompt"],
        "workspace_id": args.get("workspace_id", WORKSPACE_ID),
        "source_session_id": args.get("source_session_id") or SESSION_ID,
    }
    for key in (
        "task_id", "reason", "reuse", "allow_busy", "show_browser",
        "allow_all_edits", "name", "cli_type", "model", "permission_mode",
    ):
        if key in args:
            body[key] = args[key]
    result = api_call("POST", "/capabilities/handoff", body)
    return json.dumps(result, indent=2)


# ─── Active ticket binding + completion-time documentation ─────────────

def _get_my_session() -> dict | None:
    """Fetch this session's row. Returns dict or None on failure."""
    result = api_call("GET", f"/sessions/{SESSION_ID}")
    if isinstance(result, dict) and not result.get("error"):
        return result
    return None


def _ticket_in_my_workspace(ticket_id: str) -> dict | None:
    """Validate that a ticket exists and belongs to this worker's workspace."""
    task = api_call("GET", f"/tasks/{ticket_id}")
    if not isinstance(task, dict) or task.get("error"):
        return None
    if WORKSPACE_ID and task.get("workspace_id") != WORKSPACE_ID:
        return None
    return task


def tool_switch_active_ticket(args: dict) -> str:
    """Bind/unbind this session to a feature-board ticket.

    The active ticket is shown in the session's per-turn system-prompt block as
    ambient context. Pass ``ticket_id=null`` to unbind. Cross-workspace bindings
    are rejected.
    """
    raw_id = args.get("ticket_id")
    new_id: str | None
    if raw_id is None or raw_id == "":
        new_id = None
    else:
        new_id = str(raw_id).strip() or None

    sess = _get_my_session()
    if not sess:
        return json.dumps({"ok": False, "error": "session lookup failed"})
    previous_id = sess.get("active_ticket_id") or None

    if new_id is not None:
        ticket = _ticket_in_my_workspace(new_id)
        if not ticket:
            return json.dumps({"ok": False, "error": "ticket not in workspace or not found"})

    if (previous_id or None) == (new_id or None):
        return json.dumps({
            "ok": True, "previous_ticket_id": previous_id, "new_ticket_id": new_id,
            "noop": True,
        })

    body = {"active_ticket_id": new_id}
    result = api_call("PUT", f"/sessions/{SESSION_ID}", body)
    if isinstance(result, dict) and result.get("error"):
        return json.dumps({"ok": False, **result})

    return json.dumps({
        "ok": True,
        "previous_ticket_id": previous_id,
        "new_ticket_id": new_id,
        "reason": (args.get("reason") or "").strip(),
    })


def _now_iso() -> str:
    import datetime as _dt
    return _dt.datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _ws_doc_settings() -> dict:
    """Read the workspace's board-doc policy. Defaults if anything fails."""
    defaults = {
        "mode": "agent_with_backstop",
        "new_column": "review",
        "existing_column": "review",
    }
    if not WORKSPACE_ID:
        return defaults
    workspaces = api_call("GET", "/workspaces")
    if not isinstance(workspaces, list):
        return defaults
    for ws in workspaces:
        if ws.get("id") == WORKSPACE_ID:
            return {
                "mode": ws.get("board_doc_mode") or defaults["mode"],
                "new_column": ws.get("board_doc_new_column") or defaults["new_column"],
                "existing_column": ws.get("board_doc_existing_column") or defaults["existing_column"],
            }
    return defaults


def tool_document_to_board(args: dict) -> str:
    """Stamp this session's work onto the feature board.

    action='create'  → POST a new ticket (uses workspace.board_doc_new_column).
    action='update'  → PUT the bound ticket to workspace.board_doc_existing_column,
                       appending body to result_summary. Target = active_ticket_id
                       or task_id (back-compat fallback).
    action='skip'    → mark sessions.board_action='skipped' so the backstop sweeper
                       and re-fires of the reflection prompt stop checking.

    Idempotent: re-calls return {ok: true, already_documented: true} if the session
    has already recorded a board_action.
    """
    action = (args.get("action") or "").strip()
    if action not in ("create", "update", "skip"):
        return json.dumps({"ok": False, "error": "action must be create, update, or skip"})

    sess = _get_my_session()
    if not sess:
        return json.dumps({"ok": False, "error": "session lookup failed"})

    prior = sess.get("board_action")
    if prior:
        return json.dumps({
            "ok": True,
            "already_documented": True,
            "action_recorded": prior,
            "ticket_id": sess.get("active_ticket_id") or sess.get("task_id"),
        })

    settings = _ws_doc_settings()
    if settings["mode"] == "off":
        return json.dumps({"ok": True, "action_recorded": "noop", "mode": "off"})

    now = _now_iso()
    skip_reason = (args.get("skip_reason") or "").strip()

    if action == "skip":
        body = {
            "board_action": "skipped",
            "board_action_at": now,
            "board_action_note": skip_reason or None,
        }
        result = api_call("PUT", f"/sessions/{SESSION_ID}", body)
        if isinstance(result, dict) and result.get("error"):
            return json.dumps({"ok": False, **result})
        return json.dumps({"ok": True, "action_recorded": "skipped"})

    if action == "create":
        if not WORKSPACE_ID:
            return json.dumps({"ok": False, "error": "no workspace bound to this session"})
        title = (args.get("title") or "").strip()
        if not title:
            return json.dumps({"ok": False, "error": "title required for action='create'"})
        body = {
            "workspace_id": WORKSPACE_ID,
            "title": title,
            "description": args.get("body") or "",
            "status": (args.get("target_column") or settings["new_column"]),
            "assigned_session_id": SESSION_ID,
        }
        if args.get("parent_task_id"):
            body["parent_task_id"] = args["parent_task_id"]
        ticket = api_call("POST", "/tasks", body)
        if not isinstance(ticket, dict) or ticket.get("error") or not ticket.get("id"):
            return json.dumps({
                "ok": False,
                "error": "ticket create failed",
                **(ticket if isinstance(ticket, dict) else {}),
            })
        ticket_id = ticket["id"]
        sess_body = {
            "task_id": ticket_id,
            "active_ticket_id": ticket_id,
            "board_action": "created",
            "board_action_at": now,
        }
        api_call("PUT", f"/sessions/{SESSION_ID}", sess_body)
        return json.dumps({"ok": True, "action_recorded": "created", "ticket_id": ticket_id})

    # action == "update"
    target = sess.get("active_ticket_id") or sess.get("task_id")
    if not target:
        return json.dumps({
            "ok": False,
            "error": "no active ticket — call switch_active_ticket first or use action='create'",
        })
    target_status = (args.get("target_column") or settings["existing_column"])
    update_body: dict = {"status": target_status}
    body_text = (args.get("body") or "").strip()
    if body_text:
        # Append to result_summary; preserve previous content.
        existing_task = api_call("GET", f"/tasks/{target}")
        prev_summary = ""
        if isinstance(existing_task, dict):
            prev_summary = (existing_task.get("result_summary") or "").rstrip()
        joined = (prev_summary + "\n\n" + body_text).strip() if prev_summary else body_text
        update_body["result_summary"] = joined
    task_result = api_call("PUT", f"/tasks/{target}", update_body)
    if isinstance(task_result, dict) and task_result.get("error"):
        return json.dumps({"ok": False, **task_result})
    sess_body = {
        "board_action": "updated",
        "board_action_at": now,
    }
    api_call("PUT", f"/sessions/{SESSION_ID}", sess_body)
    return json.dumps({"ok": True, "action_recorded": "updated", "ticket_id": target})


# ─── W2W: Peer communication tools ──────────────────────────────────────

def tool_post_message(args: dict) -> str:
    """Post a message to the workspace bulletin board for peer sessions."""
    body = {
        "from_session_id": SESSION_ID,
        "topic": args.get("topic", "general"),
        "content": args["content"],
        "priority": args.get("priority", "info"),
        "files": args.get("files", []),
    }
    result = api_call("POST", f"/workspaces/{WORKSPACE_ID}/peer-messages", body)
    return json.dumps(result, indent=2)


def tool_check_messages(args: dict) -> str:
    """Check the workspace bulletin board for unread messages from peers."""
    params = f"?exclude_from={SESSION_ID}"
    if args.get("since"):
        params += f"&since={args['since']}"
    result = api_call("GET", f"/workspaces/{WORKSPACE_ID}/peer-messages{params}")
    # Auto-mark as read
    if isinstance(result, list):
        for msg in result:
            read_by = msg.get("read_by")
            if isinstance(read_by, str):
                try:
                    read_by = json.loads(read_by)
                except Exception:
                    read_by = []
            if SESSION_ID not in (read_by or []):
                api_call("PUT", f"/peer-messages/{msg['id']}/read", {"session_id": SESSION_ID})
    return json.dumps(result, indent=2)


def tool_list_peers(args: dict) -> str:
    """List sibling sessions in the same workspace with their status and digest."""
    sessions = api_call("GET", f"/sessions?workspace_id={WORKSPACE_ID}")
    peers = []
    if isinstance(sessions, list):
        for s in sessions:
            if s["id"] == SESSION_ID:
                continue
            peer = {
                "id": s["id"],
                "name": s.get("name"),
                "status": s.get("status"),
                "cli_type": s.get("cli_type"),
                "model": s.get("model"),
            }
            # Try to get their digest
            digest = api_call("GET", f"/sessions/{s['id']}/digest")
            if isinstance(digest, dict) and not digest.get("error"):
                peer["task_summary"] = digest.get("task_summary", "")
                peer["current_focus"] = digest.get("current_focus", "")
                peer["files_touched"] = digest.get("files_touched", [])
                peer["context_health"] = digest.get("context_health", "unknown")
                peer["reuse_notes"] = digest.get("reuse_notes", {})
            peers.append(peer)
    return json.dumps(peers, indent=2)


# ─── W2W: Shared context tools ─────────────────────────────────────────

def tool_update_digest(args: dict) -> str:
    """Update your session's living digest — what you're working on, decisions, discoveries."""
    body = {}
    for key in ("task_summary", "current_focus", "decisions", "discoveries"):
        if key in args:
            body[key] = args[key]
    if not body:
        return json.dumps({"error": "Provide at least one of: task_summary, current_focus, decisions, discoveries"})
    result = api_call("PUT", f"/sessions/{SESSION_ID}/digest", body)
    return json.dumps(result, indent=2)


def tool_find_similar_tasks(args: dict) -> str:
    """Find completed tasks similar to a query — returns their lessons learned and important notes."""
    query = args.get("query", "")
    params = f"?q={urllib.parse.quote(query)}"
    if WORKSPACE_ID:
        params += f"&workspace_id={WORKSPACE_ID}"
    result = api_call("GET", f"/tasks/similar{params}")
    return json.dumps(result, indent=2)





def tool_get_file_context(args: dict) -> str:
    """Check who else has recently edited a file and what task they were working on."""
    file_path = args["file_path"]
    params = f"?path={urllib.parse.quote(file_path)}&limit=10"
    result = api_call("GET", f"/workspaces/{WORKSPACE_ID}/file-activity/file{params}")
    if isinstance(result, list):
        # Filter out own edits and format for readability
        peers = [r for r in result if r.get("session_id") != SESSION_ID]
        if not peers:
            return json.dumps({"message": f"No other sessions have recently edited {file_path}"})
        return json.dumps(peers, indent=2)
    return json.dumps(result, indent=2)


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
    ws_id = WORKSPACE_ID
    params = f"?q={urllib.parse.quote(query)}&types={','.join(selected)}&limit=5"
    from context_retrieval import search_result
    return search_result(api_call("GET", f"/workspaces/{ws_id}/memory-search{params}"), query)


# ─── Pipeline result reporting ─────────────────────────────────────────

def tool_search_skills(args: dict) -> str:
    """Search the skills catalog for relevant agent skills."""
    query = args.get("query", "")
    limit = args.get("limit", 5)
    params = f"?q={urllib.parse.quote(query)}&limit={limit}"
    result = api_call("GET", f"/skills/search{params}")
    if isinstance(result, list):
        # Format for readability
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


def tool_report_test_result(args: dict) -> str:
    """Report only the test-queue entry assigned to this worker (API enforced)."""
    entry_id = urllib.parse.quote(args["test_queue_id"], safe="")
    return json.dumps(api_call("PUT", f"/test-queue/{entry_id}/report", {
        "outcome": args["outcome"],
        "result_summary": args["result_summary"],
    }), indent=2)


def tool_report_pipeline_result(args: dict) -> str:
    """Report structured result for a pipeline stage.

    Called by agents in a pipeline run so the engine gets a definitive
    pass/fail signal instead of guessing from terminal output.
    """
    result = api_call("POST", "/hooks/pipeline-result", {
        "session_id": SESSION_ID,
        "status": args.get("status", "pass"),
        "summary": args.get("summary", ""),
        "details": args.get("details", ""),
    })
    return json.dumps(result)


def tool_submit_result(args: dict) -> str:
    """Submit a typed, schema-validated result object for a pipeline stage.

    This is the C1 typed-agent-contract superset of report_pipeline_result: the
    stage's declared result_schema is validated server-side, and the object is
    stored so the engine can branch on its fields (on_expr transitions) and pass
    it as structured context to later stages. If validation fails the backend
    returns {"ok": false, "validation_error": ...} and does NOT advance the
    stage — read the error and call submit_result again with a corrected payload.
    """
    payload = {"session_id": SESSION_ID}
    if args.get("result") is not None:
        payload["result"] = args["result"]
    if args.get("status"):
        payload["status"] = args["status"]
    if args.get("summary"):
        payload["summary"] = args["summary"]
    result = api_call("POST", "/hooks/pipeline-result", payload)
    return json.dumps(result)


# ─── Memory write (worker-side) ─────────────────────────────────────────

VALID_MEMORY_TYPES = {"user", "feedback", "project", "reference"}


def tool_save_memory(args: dict) -> str:
    """Save an explicit note, updating a matching name within this workspace."""
    name = (args.get("name") or "").strip()
    content = (args.get("content") or "").strip()
    mem_type = (args.get("type") or "").strip()
    description = (args.get("description") or "").strip()
    tags = args.get("tags") or []

    if not name or not content:
        return json.dumps({"ok": False, "error": "name and content are required"})
    if mem_type not in VALID_MEMORY_TYPES:
        return json.dumps({
            "ok": False,
            "error": f"type must be one of {sorted(VALID_MEMORY_TYPES)}",
        })
    if not (WORKSPACE_ID or "").strip():
        return json.dumps({
            "ok": False,
            "error": "WORKSPACE_ID not bound on this worker; refusing to save a global memory entry",
        })

    # Idempotent on `name` within this workspace: look up first, update if
    # already present, otherwise create fresh.
    existing = api_call(
        "GET",
        f"/memory?workspace_id={urllib.parse.quote(WORKSPACE_ID)}",
    )
    match_id = None
    if isinstance(existing, list):
        for e in existing:
            if (e.get("name") or "").strip().lower() == name.lower() and (
                (e.get("workspace_id") or "") == WORKSPACE_ID
            ):
                match_id = e.get("id")
                break

    body = {
        "name": name,
        "type": mem_type,
        "content": content,
        "description": description,
        "workspace_id": WORKSPACE_ID or None,
        "tags": tags,
        "source_cli": "worker",
    }

    if match_id:
        result = api_call("PUT", f"/memory/{match_id}", body)
        if isinstance(result, dict) and result.get("error"):
            return json.dumps({"ok": False, **result})
        return json.dumps({"ok": True, "id": match_id, "updated": True})

    result = api_call("POST", "/memory", body)
    if isinstance(result, dict) and result.get("error"):
        return json.dumps({"ok": False, **result})
    return json.dumps({
        "ok": True,
        "id": (result or {}).get("id"),
        "created": True,
    })


def tool_recall_memory(args: dict) -> str:
    """Retrieve a bounded page of a named note; preserve exact content and cursors."""
    name = (args.get("name") or "").strip()
    entry_id = str(args.get("id") or "").strip()
    if not name and not entry_id:
        return json.dumps({"ok": False, "error": "name or id is required"})

    # Workspace-scoped lookup — `/memory?workspace_id=` returns workspace +
    # global rows. We pull both and prefer the workspace match, falling
    # back to global so an agent can recall the user/global entries it
    # sees in the index.
    qs = ""
    if WORKSPACE_ID:
        qs = f"?workspace_id={urllib.parse.quote(WORKSPACE_ID)}&include_global=1"
    entries = api_call("GET", f"/memory{qs}")
    if not isinstance(entries, list):
        return json.dumps({"ok": False, "error": "memory list unavailable"})

    target = name.lower()
    workspace_match = None
    global_match = None
    for e in entries:
        if (str(e.get("id")) != entry_id if entry_id else (e.get("name") or "").strip().lower() != target):
            continue
        if (e.get("workspace_id") or "") == (WORKSPACE_ID or ""):
            workspace_match = e
            break
        if not e.get("workspace_id"):
            global_match = e

    hit = workspace_match or global_match
    if not hit:
        return json.dumps({
            "ok": False,
            "error": f"no memory entry named {name!r} in this workspace",
        })

    from context_retrieval import recall_result
    return recall_result(hit, "workspace" if workspace_match else "global", args)


def tool_headsup(args: dict) -> str:
    """Send a non-blocking notice to a peer or commander.

    Thin wrapper over the existing bulletin board with explicit recipient
    routing and `blocking=false`. Use this when you want a peer to *see*
    something but you're not waiting on them.
    """
    from peer_comms import post_peer_message

    to = (args.get("to") or "all").strip() or "all"
    message = (args.get("message") or "").strip()
    topic = (args.get("topic") or "general").strip() or "general"
    if not message:
        return json.dumps({"ok": False, "error": "message required"})

    result = post_peer_message(
        api_url=API_URL,
        workspace_id=WORKSPACE_ID,
        from_session_id=SESSION_ID,
        content=message,
        to=to,
        topic=topic,
        priority="heads_up",
        blocking=False,
    )
    if isinstance(result, dict) and result.get("error"):
        return json.dumps({"ok": False, **result})
    return json.dumps({"ok": True, "id": (result or {}).get("id"), "to": to})


def tool_blocking_bulletin(args: dict) -> str:
    """Post a blocking bulletin and wait synchronously for a peer reply.

    The MCP loop is single-threaded and that's the point — the agent
    pauses until commander/peer responds (or until timeout). On timeout
    we always return — never deadlock the agent.
    """
    from peer_comms import post_peer_message, wait_for_reply

    to = (args.get("to") or "commander").strip() or "commander"
    question = (args.get("question") or "").strip()
    timeout_secs = int(args.get("timeout_secs") or 600)
    if not question:
        return json.dumps({"ok": False, "error": "question required"})

    posted = post_peer_message(
        api_url=API_URL,
        workspace_id=WORKSPACE_ID,
        from_session_id=SESSION_ID,
        content=question,
        to=to,
        topic="blocking",
        priority="blocking",
        blocking=True,
    )
    if not isinstance(posted, dict) or posted.get("error") or not posted.get("id"):
        return json.dumps({"ok": False, "error": posted.get("error") if isinstance(posted, dict) else "post failed"})

    bulletin_id = posted["id"]
    reply = wait_for_reply(
        api_url=API_URL,
        workspace_id=WORKSPACE_ID,
        bulletin_id=bulletin_id,
        timeout_secs=timeout_secs,
    )
    if not reply:
        return json.dumps({
            "ok": False,
            "reason": "timeout",
            "bulletin_id": bulletin_id,
            "timeout_secs": timeout_secs,
        })

    return json.dumps({
        "ok": True,
        "bulletin_id": bulletin_id,
        "reply": {
            "id": reply.get("id"),
            "from_session_id": reply.get("from_session_id"),
            "content": reply.get("content"),
            "created_at": reply.get("created_at"),
        },
    })


# Optional semantic coordination and ordinary workspace file claims.─













def tool_acquire_file_claim(args: dict) -> str:
    """Request a cooperating-session file claim; not filesystem isolation."""
    path = args.get("file_path") or args.get("path") or ""
    body = {"path": path, "intent": args.get("intent", "")}
    if args.get("ttl_s"):
        body["ttl_s"] = args["ttl_s"]
    return json.dumps(api_call("POST", f"/workspaces/{WORKSPACE_ID}/claims", body), indent=2)


def tool_release_file_claim(args: dict) -> str:
    """C5: release your hard claim on a file (call when you finish editing it)."""
    body = {"path": args.get("file_path") or args.get("path")}
    if args.get("claim_id"):
        body["claim_id"] = args["claim_id"]
    return json.dumps(api_call("DELETE", f"/workspaces/{WORKSPACE_ID}/claims", body), indent=2)


def tool_list_file_claims(args: dict) -> str:
    """C5: list active hard file claims in this workspace."""
    return json.dumps(api_call("GET", f"/workspaces/{WORKSPACE_ID}/claims"), indent=2)


# Intelligent memory handlers are contributed by the optional product below.
















def _unavailable_product_tool(extension_id: str):
    def unavailable(_args: dict) -> str:
        return json.dumps({"ok": False, "available": False, "error": f"{extension_id} extension is not installed or enabled"})
    return unavailable

tool_contribute_knowledge = _unavailable_product_tool("myelin")
tool_query_knowledge = _unavailable_product_tool("myelin")
tool_find_similar_sessions = _unavailable_product_tool("swarmlock")
tool_myelin_search = _unavailable_product_tool("myelin")
tool_myelin_recall = _unavailable_product_tool("myelin")
tool_myelin_neighbors = _unavailable_product_tool("myelin")
tool_myelin_ingest_git = _unavailable_product_tool("myelin")
tool_myelin_save = _unavailable_product_tool("myelin")
tool_coord_check_overlap = _unavailable_product_tool("swarmlock")
tool_coord_acquire = _unavailable_product_tool("swarmlock")
tool_coord_release = _unavailable_product_tool("swarmlock")
tool_coord_peers = _unavailable_product_tool("swarmlock")
tool_find_related_tickets = _unavailable_product_tool("swarmlock")


# ─── Tool registry ──────────────────────────────────────────────────────

TOOLS = {
    "search_skills": {
        "handler": tool_search_skills,
        "description": (
            "Search the skills catalog (8000+ skills) for relevant agent skills. "
            "Returns top matches ranked by relevance. Use this to find skills that can "
            "help with your current task — e.g. search for 'docker' to find container skills, "
            "'testing' to find test frameworks, etc."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What you need help with (e.g. 'data visualization', 'API testing', 'docker deployment')."},
                "limit": {"type": "integer", "default": 5, "description": "Max results to return."},
            },
            "required": ["query"],
        },
    },
    "get_skill_content": {
        "handler": tool_get_skill_content,
        "description": (
            "Load the full instructions for a specific skill by name. "
            "Call this after search_skills to get the complete SKILL.md content "
            "for a skill you want to use."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Exact skill name from search_skills results."},
            },
            "required": ["name"],
        },
    },
    "report_test_result": {
        "handler": tool_report_test_result,
        "description": (
            "Report pass/fail for the running test-queue entry assigned to this session. "
            "This records test evidence in IVE and releases the next queued test; it does not edit project files."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "test_queue_id": {"type": "string", "description": "Exact assigned test-queue entry ID."},
                "outcome": {"type": "string", "enum": ["pass", "fail"]},
                "result_summary": {"type": "string", "maxLength": 2000, "description": "Actual test evidence and failures."},
            },
            "required": ["test_queue_id", "outcome", "result_summary"],
        },
    },
    "report_pipeline_result": {
        "handler": tool_report_pipeline_result,
        "description": (
            "Report the result of your pipeline stage. Call this when you finish your work "
            "so the pipeline can route to the next stage. Use status 'pass' when your work "
            "succeeded (tests pass, implementation complete, review approved) or 'fail' when "
            "it didn't (tests fail, issues found, changes requested). Always include a summary."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "enum": ["pass", "fail"],
                    "description": "Result of your work: 'pass' if successful, 'fail' if not.",
                },
                "summary": {
                    "type": "string",
                    "description": "Brief summary of what happened and why it passed/failed.",
                },
                "details": {
                    "type": "string",
                    "description": "Detailed output, test results, or error messages.",
                },
            },
            "required": ["status", "summary"],
        },
    },
    "submit_result": {
        "handler": tool_submit_result,
        "description": (
            "Submit a TYPED result object for your pipeline stage. Use this (instead of "
            "report_pipeline_result) when your stage was given a result schema — pass a JSON "
            "object in `result` matching that schema. The pipeline branches on its fields and "
            "hands it to later stages as structured context. If the backend replies with "
            "validation_error, fix the payload and call submit_result again."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "result": {
                    "type": "object",
                    "description": "The typed result payload, matching the schema you were given.",
                },
                "status": {
                    "type": "string",
                    "enum": ["pass", "fail"],
                    "description": "Optional overall pass/fail (else derived from result.verdict/status).",
                },
                "summary": {
                    "type": "string",
                    "description": "Optional brief human summary of the outcome.",
                },
            },
            "required": ["result"],
        },
    },
    "get_my_tasks": {
        "handler": tool_get_my_tasks,
        "description": "List tasks assigned to you on the feature board. Use this to see what you're working on.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "status_filter": {
                    "type": "string",
                    "enum": ["all", "backlog", "todo", "planning", "in_progress", "review", "done", "blocked"],
                    "default": "all",
                    "description": "Filter by status. Default: all.",
                },
            },
        },
    },
    "get_my_task": {
        "handler": tool_get_my_task,
        "description": "Get full details of one of your assigned tasks (description, acceptance criteria, status, etc.).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string", "description": "The task ID to fetch. Omit to read this session's bound task."},
            },
        },
    },
    "update_my_task": {
        "handler": tool_update_my_task,
        "description": (
            "Update the status or result summary of your assigned task on the feature board. "
            "Move your task through: planning → in_progress → review → done as you work. "
            "When completing a task, ALWAYS provide lessons_learned and important_notes — "
            "these help future sessions working on similar features."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string", "description": "The task ID to update."},
                "status": {
                    "type": "string",
                    "enum": ["planning", "in_progress", "review", "done", "blocked"],
                    "description": "New status for the task.",
                },
                "result_summary": {
                    "type": "string",
                    "description": "Summary of what was accomplished. Set this when moving to review or done.",
                },
                "lessons_learned": {
                    "type": "string",
                    "description": "Gotchas, surprises, and insights. What would you tell someone doing similar work?",
                },
                "important_notes": {
                    "type": "string",
                    "description": "Key facts about the codebase or feature area. What should someone know before touching this code again?",
                },
            },
            "required": ["task_id"],
        },
    },
    "task_ready": {
        "handler": tool_task_ready,
        "description": "Check whether a task's dependencies are complete. Returns {ready, blockers}.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string", "description": "Task ID to check."},
            },
            "required": ["task_id"],
        },
    },
    "list_port_leases": {
        "handler": tool_list_port_leases,
        "description": (
            "List active port leases for this workspace. Pass scan=true to report occupied "
            "ports in a bounded range before starting a dev server."
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
    "get_workspace_runtime_env": {
        "handler": tool_get_workspace_runtime_env,
        "description": (
            "Return detected workspace runtime/toolchain guidance: preferred Python venv, "
            "package-manager commands, Rust/Go/Java/native build commands, and a prompt-ready "
            "summary. Call this before running tests when the injected runtime block is missing "
            "or when you need the exact command."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
            },
        },
    },
    "lease_port": {
        "handler": tool_lease_port,
        "description": (
            "Reserve a local dev-server port through IVE before starting a server. "
            "The response includes blocked_ports for leased or occupied candidates."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
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
            "Register a preview URL from an active port lease after the dev server starts. "
            "This updates workspace preview state through IVE."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "lease_id": {"type": "string"},
                "port": {"type": "integer"},
                "url": {"type": "string"},
                "task_id": {"type": "string"},
            },
        },
    },
    "heartbeat_port_lease": {
        "handler": tool_heartbeat_port_lease,
        "description": "Extend an active port lease TTL while the dev server is still running.",
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
    "request_capability_handoff": {
        "handler": tool_request_capability_handoff,
        "description": (
            "Create or reuse a normal worker with testing or documentation capability and send it a handoff prompt. "
            "Call this when you decide the user's request needs browser-testing or documentation MCPs instead of "
            "trying to do it in your current session or asking the UI to guess from keywords."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "capability": {"type": "string", "enum": ["testing", "documentation"]},
                "prompt": {"type": "string", "description": "Full request to send to the capability worker."},
                "reason": {"type": "string", "description": "Why this should be handed off."},
                "workspace_id": {"type": "string"},
                "source_session_id": {"type": "string"},
                "task_id": {"type": "string", "description": "Optional active ticket to bind on the target worker."},
                "reuse": {"type": "boolean", "default": True},
                "allow_busy": {"type": "boolean", "default": False},
                "show_browser": {"type": "boolean", "default": False},
                "allow_all_edits": {"type": "boolean", "default": False},
                "name": {"type": "string"},
                "cli_type": {"type": "string", "enum": ["claude", "codex", "antigravity"]},
                "model": {"type": "string"},
                "permission_mode": {"type": "string"},
            },
            "required": ["capability", "prompt"],
        },
    },
    "switch_active_ticket": {
        "handler": tool_switch_active_ticket,
        "description": (
            "Bind this session to a feature-board ticket so it shows up as ambient context "
            "in your per-turn system prompt, AND so document_to_board(action='update') at "
            "completion writes to the right ticket. Pass ticket_id=null to unbind. "
            "Trigger checklist: (1) the active-ticket block in your prompt no longer matches "
            "what you're actually doing — switch. (2) you started feature-shaped work without "
            "a binding — switch to the ticket it belongs to (or stay unbound and let "
            "document_to_board(action='create') file a new one at completion). (3) commander "
            "redirected you to a different ticket mid-session — switch. Cross-workspace IDs "
            "are rejected."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "ticket_id": {
                    "type": ["string", "null"],
                    "description": "Ticket id to bind to, or null to unbind.",
                },
                "reason": {
                    "type": "string",
                    "description": "Optional one-line reason — useful when commander or the user reviews the audit trail.",
                },
            },
            "required": ["ticket_id"],
        },
    },
    "document_to_board": {
        "handler": tool_document_to_board,
        "description": (
            "Completion-time stamp for feature-board documentation. Call this once at the end "
            "of feature-shaped work. Idempotent: re-calls return already_documented=true.\n\n"
            "action='create' — file a new ticket in the workspace's configured new-ticket column "
            "(default 'review'). Required: title. Optional: body, parent_task_id, target_column. "
            "Sets active_ticket_id + task_id on this session to the new ticket.\n\n"
            "action='update' — move the bound ticket (active_ticket_id, falling back to task_id) "
            "to the workspace's existing-ticket column (default 'review'). Optional body is "
            "appended to result_summary.\n\n"
            "action='skip' — mark this session as 'no board write needed' so the backstop "
            "sweeper and reflection re-fires stop checking. Use for exploration, doc-only "
            "edits, or behavior-neutral refactors.\n\n"
            "If your work drifted from the active ticket, call switch_active_ticket FIRST."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "update", "skip"],
                    "description": "create | update | skip — see tool description.",
                },
                "title": {"type": "string", "description": "Required for create. Optional override for update."},
                "body": {"type": "string", "description": "Required for create. On update, appended to result_summary."},
                "parent_task_id": {"type": "string", "description": "Optional, for create — links to a parent story/epic."},
                "target_column": {"type": "string", "description": "Override the workspace-default column (e.g. 'todo', 'in_progress')."},
                "skip_reason": {"type": "string", "description": "Optional, for skip — one-line reason persisted on the session."},
            },
            "required": ["action"],
        },
    },
    "search_memory": {
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
            },
            "required": [
                "query",
            ],
        },
    },
    "save_memory": {
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
            },
            "required": [
                "name",
                "type",
                "content",
            ],
        },
    },
    "recall_memory": {
        "handler": tool_recall_memory,
        "description": (
            "Expand a memory entry from the Remembered Context index. When the system "
            "prompt shows entries as one-liners ('name — description'), call this with "
            "the name to fetch a bounded excerpt. Use next_offset only if needed. Skip entries you "
            "already have inlined in the prompt — only call when the description looks "
            "relevant to the current task and you need the details."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Exact entry name as shown in the Remembered Context index.",
                },
                "id": {"type": "string", "description": "Exact note id from a search hit; alternative to name."},
                "offset": {"type": "integer", "minimum": 0, "description": "Character offset from the previous next_offset; default 0."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 4000, "description": "Maximum content characters; default 2000."},
            },
            "anyOf": [{"required": ["name"]}, {"required": ["id"]}],
        },
    },
}

# W2W tools are conditionally merged in main() based on workspace feature flags.
W2W_COMMS_TOOLS = {
    "post_message": {
        "handler": tool_post_message,
        "description": (
            "Post a message to the workspace bulletin board for peer sessions. "
            "Use priority: 'info' for FYI, 'heads_up' for important updates, "
            "'blocking' for things peers must see before continuing."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "Message content."},
                "topic": {"type": "string", "description": "Topic tag (e.g., 'api-schema', 'auth', 'general'). Default: general."},
                "priority": {"type": "string", "enum": ["info", "heads_up", "blocking"], "description": "Priority level. Default: info."},
                "files": {"type": "array", "items": {"type": "string"}, "description": "File paths this message relates to."},
            },
            "required": ["content"],
        },
    },
    "check_messages": {
        "handler": tool_check_messages,
        "description": "Check the workspace bulletin board for messages from peer sessions. Messages are auto-marked as read.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "since": {"type": "string", "description": "ISO timestamp — only return messages after this time."},
            },
        },
    },
    "list_peers": {
        "handler": tool_list_peers,
        "description": "List sibling sessions in the workspace with their current task, status, and what files they're working on.",
        "inputSchema": {"type": "object", "properties": {}},
    },
}

W2W_CONTEXT_TOOLS = {
    # search_memory is now in base TOOLS — every worker should be able to
    # query its own workspace's memory regardless of W2W context-sharing.
    "find_similar_tasks": {
        "handler": tool_find_similar_tasks,
        "description": (
            "Find completed tasks similar to your current work. Returns their lessons learned, "
            "important notes, and result summaries — so you can learn from past experience "
            "before repeating the same mistakes or rediscovering the same things."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Describe what you're working on. Will match against past task titles, descriptions, and results.",
                },
            },
            "required": ["query"],
        },
    },

    "get_file_context": {
        "handler": tool_get_file_context,
        "description": (
            "Check who else has recently edited a file and what task they were working on. "
            "Use this before editing a file to see if a peer session has been working on it, "
            "so you can understand their intent and avoid conflicts."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Absolute path to the file."},
            },
            "required": ["file_path"],
        },
    },
    "update_digest": {
        "handler": tool_update_digest,
        "description": (
            "Update your session's living digest — a summary of what you're doing, "
            "key decisions, and discoveries. Other sessions can read your digest to "
            "understand your work without interrupting you."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_summary": {"type": "string", "description": "One-line summary of what you're working on."},
                "current_focus": {"type": "string", "description": "What you're doing right now."},
                "decisions": {"type": "array", "items": {"type": "string"}, "description": "Key decisions made (replaces previous list)."},
                "discoveries": {"type": "array", "items": {"type": "string"}, "description": "Codebase insights discovered (replaces previous list)."},
            },
        },
    },
}


if extension_available("myelin"):
    from extension_host import load_backend_module as _load_fact_provider
    _fact_provider = _load_fact_provider("myelin", "backend/mcp_fact_tools.py")
    _fact_tools = _fact_provider.build_tools({
        "api_call": lambda *args, **kwargs: api_call(*args, **kwargs),
        "get_workspace_id": lambda: WORKSPACE_ID,
        "get_agent_id": lambda: SESSION_ID,
        "extension_available": extension_available,
    }, role="worker")
    W2W_CONTEXT_TOOLS.update(_fact_tools)
    for _extension_tool_name, _extension_tool_spec in _fact_tools.items():
        globals()["tool_" + _extension_tool_name] = _extension_tool_spec["handler"]
    from extension_host import load_legacy_namespace as _load_extension_namespace
    _memory_guidance_namespace = {"__name__": "_ive_myelin_worker_guidance"}
    _load_extension_namespace(_memory_guidance_namespace, "myelin", "backend/mcp_memory_guidance.py")
    _memory_guidance_host = {"api_call": lambda *args, **kwargs: api_call(*args, **kwargs), "get_workspace_id": lambda: WORKSPACE_ID}
    _memory_guidance_namespace["extend_mcp_tools"](TOOLS, role="worker", host=_memory_guidance_host)
    _memory_guidance_namespace["extend_mcp_tools"](W2W_CONTEXT_TOOLS, role="worker", host=_memory_guidance_host)
    tool_search_memory = TOOLS["search_memory"]["handler"]


if extension_available("forge"):
    from forge_mcp import extend_mcp_tools
    extend_mcp_tools(W2W_CONTEXT_TOOLS, role="worker")


# ─── W2W: Headsup + blocking bulletins (gated on workspace.comms_enabled) ─

W2W_BULLETIN_TOOLS = {
    "headsup": {
        "handler": tool_headsup,
        "description": (
            "USE THIS WHENEVER you're about to touch a peer's domain or your work "
            "affects others. Non-blocking notice to a peer or commander — fire and "
            "continue. Trigger checklist: (1) starting on a file/area another worker may "
            "be in. (2) finishing a refactor that changes a shared interface. (3) "
            "discovering something a peer should know but doesn't need to act on. (4) "
            "blocked by something but continuing with a workaround. Examples: "
            "'starting on auth.py', 'finished sidebar refactor — file reorganized', "
            "'blocked by missing API key, continuing with mock'. They see it on their "
            "next bulletin check. Set `to` to 'all', 'commander', or a specific "
            "session_id. Silent overlap is how two workers stomp on the same file — "
            "send a headsup before that happens."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "to": {"type": "string", "description": "'all', 'commander', or a specific session_id."},
                "message": {"type": "string", "description": "Short notice content."},
                "topic": {"type": "string", "description": "Topic tag (e.g. 'api-schema'). Default: general."},
            },
            "required": ["to", "message"],
        },
    },
    "blocking_bulletin": {
        "handler": tool_blocking_bulletin,
        "description": "Ask a peer a question and wait for its reply when further work depends on the answer. Returns the reply or an explicit timeout result; the caller remains responsible for deciding how to proceed.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "to": {"type": "string", "description": "'commander' or a specific session_id."},
                "question": {"type": "string", "description": "What you need answered before you can proceed."},
                "timeout_secs": {"type": "integer", "default": 600, "description": "Max seconds to wait. Default 600."},
            },
            "required": ["to", "question"],
        },
    },
}


ALLOY_TOOLS = {
    "alloy_register_server": {
        "handler": tool_alloy_register_server,
        "description": (
            "Register or update a workspace-local Alloy generated stdio MCP server. "
            "Use this after generating project-owned MCP artifacts. This does not "
            "attach the server natively to sessions; it makes it available through "
            "the dynamic Alloy bridge."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "id": {"type": "string"},
                "slug": {"type": "string", "description": "Stable short id, e.g. stripe or billing-api."},
                "name": {"type": "string"},
                "description": {"type": "string"},
                "command": {"type": "string", "description": "Executable command, e.g. python3 or node."},
                "args": {"type": "array", "items": {"type": "string"}, "description": "Command arguments for the generated stdio MCP server."},
                "cwd": {"type": "string", "description": "Workspace-relative cwd. Must stay inside the workspace."},
                "env": {"type": "object", "description": "Environment needed by the generated server. Secret values are redacted in list responses."},
                "manifest_path": {"type": "string"},
                "raw_spec_path": {"type": "string"},
                "normalized_spec_path": {"type": "string"},
                "sdk_path": {"type": "string"},
                "mcp_path": {"type": "string"},
                "write_manifest": {"type": "boolean", "description": "Default true. Writes .ive/alloy/<slug>/alloy.json metadata."},
            },
            "required": ["command"],
        },
    },
    "alloy_record_run": {
        "handler": tool_alloy_record_run,
        "description": "Record an Alloy generation run: engine, language, spec paths, output path, manifest path, logs, and status.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "id": {"type": "string"},
                "server_id": {"type": "string"},
                "task_id": {"type": "string"},
                "engine": {"type": "string"},
                "language": {"type": "string"},
                "raw_spec_path": {"type": "string"},
                "normalized_spec_path": {"type": "string"},
                "output_path": {"type": "string"},
                "manifest_path": {"type": "string"},
                "status": {"type": "string"},
                "logs": {"type": "string"},
            },
        },
    },
    "alloy_list_servers": {
        "handler": tool_alloy_list_servers,
        "description": "List Alloy generated MCP servers registered in this workspace.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
            },
        },
    },
    "alloy_get_server": {
        "handler": tool_alloy_get_server,
        "description": "Fetch one Alloy server registration by id or slug.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "server_id": {"type": "string"},
            },
            "required": ["server_id"],
        },
    },
    "alloy_healthcheck": {
        "handler": tool_alloy_healthcheck,
        "description": "Start the registered stdio MCP server, run initialize + tools/list, cache the tool schemas, then stop it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "server_id": {"type": "string"},
            },
            "required": ["server_id"],
        },
    },
    "alloy_list_tools": {
        "handler": tool_alloy_list_tools,
        "description": "List tools exposed by a registered Alloy MCP server without restarting this IVE session.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "server_id": {"type": "string"},
            },
            "required": ["server_id"],
        },
    },
    "alloy_call_tool": {
        "handler": tool_alloy_call_tool,
        "description": "Call a tool on a registered Alloy MCP server through the dynamic bridge.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "server_id": {"type": "string"},
                "tool_name": {"type": "string"},
                "arguments": {"type": "object"},
                "timeout": {"type": "number", "description": "Seconds, clamped by backend."},
            },
            "required": ["server_id", "tool_name"],
        },
    },
}


# ─── Planner-only tools (gated on session_type='planner') ──────────────
#
# Planners decompose an intent task into sub-tasks on the feature board,
# then stop. They need create_task to file those sub-tasks. Regular workers
# (implementers, testers) must NOT have this — if they did, they could
# spawn arbitrary work mid-implementation and the orchestration tree would
# fan out uncontrollably. Workers that discover new work post a peer
# message instead and let the Commander decide.


def tool_create_task(args: dict) -> str:
    """Create a sub-task on the feature board.

    Allowed for planner sessions only. Auto-tags the new task as a sibling
    sub-task of the planner's currently-assigned intent task — depends_on
    can still be set explicitly when ordering between sub-tasks matters.
    """
    body = {
        "workspace_id": WORKSPACE_ID,
        "title": args["title"],
    }
    for key in (
        "description", "acceptance_criteria", "priority", "labels",
        "depends_on", "pipeline", "pipeline_max_iterations",
        "test_with_agent", "plan_first", "deep_research", "ralph_loop",
    ):
        if key in args:
            body[key] = args[key]
    # Link the sub-task to the planner's intent task. Without this the
    # orchestration tree is flat: seam-contract inheritance (auto_exec) and the
    # sibling-completion seam-fit check both key off parent_task_id, so an
    # unparented sub-task silently opts out of both. Explicit parent wins.
    if args.get("parent_task_id"):
        body["parent_task_id"] = args["parent_task_id"]
    else:
        sess = _get_my_session() or {}
        intent_id = sess.get("active_ticket_id") or sess.get("task_id")
        if intent_id:
            body["parent_task_id"] = intent_id
    result = api_call("POST", "/tasks", body)
    return json.dumps(result, indent=2)


def tool_set_seam_contract(args: dict) -> str:
    """Declare the integration contract between independent slices.

    Planner-only. Call this only when you split the intent into INDEPENDENT
    slices that must integrate at a seam (e.g. frontend↔backend API, service
    A↔service B). Write the exact interface each finished product must honor.
    Stored on your intent task and injected into every slice worker so they all
    build to the same seam. Skip it for linear chains / single-area work.
    """
    contract = (args.get("contract") or "").strip()
    if not contract:
        return json.dumps({"ok": False, "error": "contract text required"})
    sess = _get_my_session()
    if not sess:
        return json.dumps({"ok": False, "error": "session lookup failed"})
    intent_id = sess.get("active_ticket_id") or sess.get("task_id")
    if not intent_id:
        return json.dumps({"ok": False, "error": "no intent task bound to this planner session"})
    result = api_call("PUT", f"/tasks/{intent_id}", {"seam_contract": contract})
    if isinstance(result, dict) and result.get("error"):
        return json.dumps({"ok": False, **result})
    return json.dumps({"ok": True, "intent_task_id": intent_id, "seam_contract_set": True})




# ─── Architect-only tools (gated on session_type='architect') ───────────
# The Architect is the conception tier above the Planner: it carves a goal
# into coarse epics (file_epic) and, only for parallel epics that must
# integrate, declares a cross-epic seam on the goal (set_goal_seam_contract),
# then parks the goal for human approval (submit_blueprint). It never files
# sub-tasks (that stays planner-only) and never implements.


def tool_file_epic(args: dict) -> str:
    """File an epic under the Architect's goal. Architect-only.

    An epic is the coarse intent tier — a multi-day chunk a Planner will later
    slice into 5-12 sub-tasks. It is filed as a child of the goal in a
    non-dispatchable hold (status='blocked' + 'awaiting-blueprint' label) so
    nothing runs before the human approves the blueprint; approving releases
    it. `phase` + `depends_on` sequence epics through the existing dependency
    DAG, so a later phase only dispatches once its earlier-phase epics finish.
    Phase 0 is reserved for a single baseline audit/check epic when existing
    implementation state is uncertain; implementation epics that rely on that
    check must depend_on it.
    """
    sess = _get_my_session() or {}
    goal_id = (args.get("parent_task_id") or sess.get("active_ticket_id")
               or sess.get("task_id"))
    if not goal_id:
        return json.dumps({"ok": False, "error": "no goal task bound to this architect session"})
    labels = args.get("labels") or []
    if isinstance(labels, str):
        labels = [l.strip() for l in labels.split(",") if l.strip()]
    for tag in ("epic", "awaiting-blueprint"):
        if tag not in labels:
            labels.append(tag)
    body = {
        "workspace_id": WORKSPACE_ID,
        "title": args["title"],
        "parent_task_id": goal_id,
        "tier": "epic",
        "phase": args.get("phase", 1),
        "status": "blocked",
        "labels": labels,
    }
    for key in ("description", "acceptance_criteria", "depends_on", "priority"):
        if key in args:
            body[key] = args[key]
    result = api_call("POST", "/tasks", body)
    return json.dumps(result, indent=2)


def tool_set_goal_seam_contract(args: dict) -> str:
    """Declare a CROSS-EPIC integration contract on the goal. Architect-only.

    Use ONLY when two same-phase epics run in parallel and must integrate. Same
    shape as the Planner's set_seam_contract but one tier up: it lands on the
    goal, and the backend's seam-fit check fires at the goal tier once both
    parallel epics complete. Sequenced epics that hand off via the shared data
    model / API surface do NOT need this — that coherence lives in the
    north-star memory entry.
    """
    contract = (args.get("contract") or "").strip()
    if not contract:
        return json.dumps({"ok": False, "error": "contract text required"})
    sess = _get_my_session() or {}
    goal_id = sess.get("active_ticket_id") or sess.get("task_id")
    if not goal_id:
        return json.dumps({"ok": False, "error": "no goal task bound to this architect session"})
    result = api_call("PUT", f"/tasks/{goal_id}", {"seam_contract": contract})
    if isinstance(result, dict) and result.get("error"):
        return json.dumps({"ok": False, **result})
    return json.dumps({"ok": True, "goal_task_id": goal_id, "seam_contract_set": True})


def tool_submit_blueprint(args: dict) -> str:
    """Park the goal for human blueprint approval. Architect-only, call last.

    Sets the goal to tier='goal', status='planning' (which fires the plan_ready
    blocking notification), and records the prose blueprint path +
    blueprint_status='awaiting_approval'. After this, STOP — a human approves
    the blueprint, which releases the epics. Do not decompose epics yourself.
    """
    sess = _get_my_session() or {}
    goal_id = sess.get("active_ticket_id") or sess.get("task_id")
    if not goal_id:
        return json.dumps({"ok": False, "error": "no goal task bound to this architect session"})
    body = {
        "tier": "goal",
        "status": "planning",
        "blueprint_status": "awaiting_approval",
    }
    if args.get("blueprint_path"):
        blueprint_path = str(args["blueprint_path"]).strip()
        if not _is_supported_blueprint_path(blueprint_path):
            return json.dumps({
                "ok": False,
                "error": (
                    "blueprint_path must be a markdown file in a supported CLI plan directory "
                    "(~/.claude/plans, ~/.codex/plans, or ~/.gemini/plans) so the Blueprint viewer can load it"
                ),
            })
        body["blueprint_path"] = blueprint_path
    if args.get("summary"):
        body["result_summary"] = args["summary"]
    result = api_call("PUT", f"/tasks/{goal_id}", body)
    if isinstance(result, dict) and result.get("error"):
        return json.dumps({"ok": False, **result})
    return json.dumps({"ok": True, "goal_task_id": goal_id,
                       "blueprint_status": "awaiting_approval",
                       "parked_for_approval": True})


ARCHITECT_TOOLS = {
    "file_epic": {
        "handler": tool_file_epic,
        "description": (
            "File an epic under your goal. Architect-only. An epic is a coarse, "
            "multi-day subsystem (auth, billing, dashboard, public API, infra…) "
            "that a Planner will later slice into sub-tasks — NOT a single "
            "sub-task. Epics are filed in a hold state and do not run until the "
            "human approves the blueprint. Set `phase` and `depends_on` to "
            "sequence them; later phases dispatch only after earlier ones finish. "
            "Use phase 0 only for one baseline audit/check epic when existing "
            "implementation state is uncertain, and make affected build epics "
            "depend_on it. "
            "Aim for 3-8 epics total; if you exceed 12 you are decomposing, not "
            "conceiving — group them."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Short, subsystem-level title ('Authentication & sessions', not 'Add login button')."},
                "description": {"type": "string", "description": "Intent + constraints for the whole subsystem."},
                "acceptance_criteria": {"type": "string", "description": "What 'this epic is done' means at the subsystem level."},
                "phase": {"type": "integer", "description": "Execution phase. Use 0 only for one baseline audit/check epic when existing implementation state is uncertain; 1 is the first implementation phase. Epics in the same phase may run in parallel; later phases wait on earlier ones via depends_on.", "default": 1},
                "depends_on": {"type": "array", "items": {"type": "string"}, "description": "Epic IDs from earlier phases this epic needs first. This is how phasing is enforced."},
                "labels": {"type": "array", "items": {"type": "string"}, "description": "Domain labels for affinity routing, e.g. ['backend','auth']. 'epic' is added automatically."},
                "priority": {"type": "string", "enum": ["low", "medium", "high"], "description": "Default: medium."},
            },
            "required": ["title"],
        },
    },
    "set_goal_seam_contract": {
        "handler": tool_set_goal_seam_contract,
        "description": (
            "Declare a cross-epic integration contract on your goal. "
            "Architect-only. Use ONLY when two same-phase epics run in parallel "
            "and must integrate at a seam: spell out the exact interface (paths, "
            "request/response schema, message format, error + auth cases) the "
            "finished epics must honor. The backend judges the finished epics "
            "against it once both complete. Sequenced epics that share the "
            "north-star data model / API surface do NOT need this."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "contract": {
                    "type": "string",
                    "description": "The shared interface between the parallel epics, concrete enough that each side can build to it independently.",
                },
            },
            "required": ["contract"],
        },
    },
    "submit_blueprint": {
        "handler": tool_submit_blueprint,
        "description": (
            "Park the goal for human approval, then stop. Architect-only, call "
            "this LAST after the north-star is saved (save_memory) and all epics "
            "are filed. Sets the goal to planning/awaiting_approval and records "
            "the prose blueprint file path. The path must be a markdown file in "
            "the active CLI plan directory (~/.claude/plans, ~/.codex/plans, or "
            "~/.gemini/plans) so the Blueprint viewer can load and save it. "
            "A human then approves the blueprint, "
            "which releases the initial ready epics to the Commander. Do not implement "
            "or decompose epics after this."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "blueprint_path": {"type": "string", "description": "Absolute path to the prose blueprint markdown file you wrote in a supported CLI plan directory: ~/.claude/plans, ~/.codex/plans, or ~/.gemini/plans."},
                "summary": {"type": "string", "description": "One-line summary of the product + epic count for the approval card."},
            },
            "required": [],
        },
    },
}


# ─── Brainstormer-only tools (gated on session_type='brainstormer') ──────
#
# Brainstormers are per-person intake sessions. They can inspect shared
# workspace state and file candidate backlog items, but they do not execute
# implementation work or dispatch workers.

def _as_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return []
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, list):
                return [str(v).strip() for v in parsed if str(v).strip()]
        except Exception:
            pass
        return [p.strip() for p in stripped.split(",") if p.strip()]
    return [str(value).strip()] if str(value).strip() else []


def _merge_labels(labels, required: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for label in [*_as_list(labels), *required]:
        key = label.lower()
        if key and key not in seen:
            seen.add(key)
            out.append(label)
    return out


def _text_block(title: str, value) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        lines = [str(v).strip() for v in value if str(v).strip()]
        if not lines:
            return ""
        body = "\n".join(f"- {line}" for line in lines)
    else:
        body = str(value).strip()
    return f"## {title}\n{body}" if body else ""


def _sectioned_text(sections: list[tuple[str, object]]) -> str:
    return "\n\n".join(block for block in (_text_block(title, value) for title, value in sections) if block)


def tool_list_backlog(args: dict) -> str:
    """List shared workspace backlog/task state for intake and duplicate checks."""
    if not WORKSPACE_ID:
        return json.dumps({"error": "no workspace bound to this session"})
    status_filter = args.get("status_filter", "open")
    limit = int(args.get("limit", 100))
    path = f"/tasks?workspace={urllib.parse.quote(WORKSPACE_ID)}"
    if status_filter not in ("all", "open"):
        path += f"&status={urllib.parse.quote(str(status_filter))}"
    result = api_call("GET", path)
    if isinstance(result, list):
        if status_filter == "open":
            open_statuses = {"backlog", "todo", "planning", "in_progress", "review", "blocked"}
            result = [t for t in result if (t.get("status") or "backlog") in open_statuses]
        if limit > 0:
            result = result[:limit]
    return json.dumps(result, indent=2)


def tool_create_candidate_task(args: dict) -> str:
    """Create a candidate backlog ticket from a brainstorm."""
    if not WORKSPACE_ID:
        return json.dumps({"error": "no workspace bound to this session"})
    title = (args.get("title") or "").strip()
    if not title:
        return json.dumps({"error": "title required"})

    description = args.get("description")
    if not description:
        description = _sectioned_text([
            ("Rationale", args.get("rationale")),
            ("Problem", args.get("problem")),
            ("Proposed Solution", args.get("proposed_solution")),
            ("Non-goals", args.get("non_goals")),
            ("Dependencies / Related Work", args.get("dependencies_notes")),
            ("Risks / Unknowns", args.get("risks_unknowns")),
            ("Verification Ideas", args.get("verification")),
            ("Research / Observatory Evidence", args.get("evidence")),
            ("Duplicate-check Notes", args.get("duplicate_check_notes")),
        ])

    acceptance = args.get("acceptance_criteria")
    if isinstance(acceptance, list):
        acceptance = "\n".join(f"- {str(v).strip()}" for v in acceptance if str(v).strip())

    body = {
        "workspace_id": WORKSPACE_ID,
        "title": title,
        "description": description or "",
        "acceptance_criteria": acceptance or "",
        "status": "backlog",
        "priority": args.get("priority", 0),
        "labels": _merge_labels(
            args.get("labels"),
            ["candidate", "brainstormer", "intake", "needs-review"],
        ),
        "pipeline": False,
        "plan_first": False,
        "deep_research": False,
        "ralph_loop": False,
        "test_with_agent": False,
    }
    if args.get("parent_task_id"):
        body["parent_task_id"] = args["parent_task_id"]
    if args.get("depends_on"):
        body["depends_on"] = args["depends_on"]
    result = api_call("POST", "/tasks", body)
    return json.dumps(result, indent=2)


def tool_start_deep_research(args: dict) -> str:
    if not WORKSPACE_ID:
        return json.dumps({"error": "no workspace bound to this session"})
    query = (args.get("query") or "").strip()
    if not query:
        return json.dumps({"error": "query required"})
    body = {
        "query": query,
        "workspace_id": args.get("workspace_id") or WORKSPACE_ID,
    }
    for key in (
        "feature_tag", "task_id", "model", "backend", "depth",
        "recency_months", "cross_temporal", "dig_deeper", "interactive",
        "mcp_server_ids", "plan",
    ):
        if key in args:
            body[key] = args[key]
    result = api_call("POST", "/research/jobs", body)
    return json.dumps(result, indent=2)


def tool_list_deep_research_jobs(args: dict) -> str:
    result = api_call("GET", "/research/jobs")
    return json.dumps(result, indent=2)


def tool_list_research(args: dict) -> str:
    ws_id = args.get("workspace_id") or WORKSPACE_ID
    params = []
    if ws_id:
        params.append(f"workspace_id={urllib.parse.quote(ws_id)}")
    if args.get("feature_tag"):
        params.append(f"feature={urllib.parse.quote(str(args['feature_tag']))}")
    # Reuse-check filters → bounded candidate pool the agent reasons over.
    if args.get("status"):
        params.append(f"status={urllib.parse.quote(str(args['status']))}")
    if args.get("recency_days") not in (None, ""):
        params.append(f"recency_days={urllib.parse.quote(str(args['recency_days']))}")
    if args.get("limit") not in (None, ""):
        params.append(f"limit={urllib.parse.quote(str(args['limit']))}")
    suffix = "?" + "&".join(params) if params else ""
    result = api_call("GET", f"/research{suffix}")
    return json.dumps(result, indent=2)


def tool_get_research(args: dict) -> str:
    entry_id = (args.get("entry_id") or "").strip()
    if not entry_id:
        return json.dumps({"error": "entry_id required"})
    result = api_call("GET", f"/research/{urllib.parse.quote(entry_id)}")
    return json.dumps(result, indent=2)


def tool_search_research(args: dict) -> str:
    query = (args.get("query") or "").strip()
    if not query:
        return json.dumps({"error": "query required"})
    ws_id = args.get("workspace_id") or WORKSPACE_ID
    suffix = f"?q={urllib.parse.quote(query)}"
    if ws_id:
        suffix += f"&workspace_id={urllib.parse.quote(ws_id)}"
    result = api_call("GET", f"/research/search{suffix}")
    return json.dumps(result, indent=2)


def tool_list_observatory_findings(args: dict) -> str:
    ws_id = args.get("workspace_id") or WORKSPACE_ID
    params = []
    if ws_id:
        params.append(f"workspace_id={urllib.parse.quote(ws_id)}")
    for key in ("source", "status", "min_score"):
        if args.get(key) not in (None, ""):
            params.append(f"{key}={urllib.parse.quote(str(args[key]))}")
    suffix = "?" + "&".join(params) if params else ""
    result = api_call("GET", f"/observatory/findings{suffix}")
    limit = int(args.get("limit", 50))
    if isinstance(result, list) and limit > 0:
        result = result[:limit]
    return json.dumps(result, indent=2)


def tool_list_observatory_scans(args: dict) -> str:
    suffix = ""
    if args.get("source"):
        suffix = f"?source={urllib.parse.quote(str(args['source']))}"
    result = api_call("GET", f"/observatory/scans{suffix}")
    return json.dumps(result, indent=2)


def tool_trigger_observatory_scan(args: dict) -> str:
    ws_id = args.get("workspace_id") or WORKSPACE_ID
    if not ws_id:
        return json.dumps({"error": "workspace_id required"})
    body = {
        "workspace_id": ws_id,
        "source": args.get("source", "all"),
        "mode": args.get("mode", "both"),
    }
    if args.get("keywords") is not None:
        body["keywords"] = args["keywords"]
    result = api_call("POST", "/observatory/scan", body)
    return json.dumps(result, indent=2)


def tool_trigger_observatory_smart_scan(args: dict) -> str:
    ws_id = args.get("workspace_id") or WORKSPACE_ID
    if not ws_id:
        return json.dumps({"error": "workspace_id required"})
    body = {"workspace_id": ws_id}
    for key in ("source", "sources", "wait"):
        if key in args:
            body[key] = args[key]
    result = api_call("POST", "/observatory/scan/smart", body)
    return json.dumps(result, indent=2)


BRAINSTORMER_TOOLS = {
    "list_backlog": {
        "handler": tool_list_backlog,
        "description": "List shared workspace tickets before brainstorming or filing candidates. Use status_filter='open' for non-done work or 'all' for the full board.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "status_filter": {"type": "string", "enum": ["open", "all", "backlog", "todo", "planning", "in_progress", "review", "blocked", "done"], "default": "open"},
                "limit": {"type": "integer", "default": 100},
            },
        },
    },

    "create_candidate_task": {
        "handler": tool_create_candidate_task,
        "description": "Create a brainstorm/intake candidate ticket in backlog. It is labeled for review and does not start execution.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "description": {"type": "string"},
                "rationale": {"type": "string"},
                "problem": {"type": "string"},
                "proposed_solution": {"type": "string"},
                "acceptance_criteria": {"oneOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}]},
                "non_goals": {"oneOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}]},
                "dependencies_notes": {"type": "string"},
                "risks_unknowns": {"oneOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}]},
                "verification": {"oneOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}]},
                "evidence": {"type": "string"},
                "duplicate_check_notes": {"type": "string"},
                "priority": {"type": "integer", "default": 0},
                "labels": {"type": "array", "items": {"type": "string"}},
                "parent_task_id": {"type": "string"},
                "depends_on": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["title"],
        },
    },
    "start_deep_research": {
        "handler": tool_start_deep_research,
        "description": "Start a shared deep-research job for an idea whose feasibility, market context, or codebase history needs deeper evidence.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "workspace_id": {"type": "string"},
                "feature_tag": {"type": "string"},
                "task_id": {"type": "string", "description": "Optional feature-board task to PARK on this research: it waits in backlog and auto-resumes when the research completes (or unblocks if it fails)."},
                "depth": {"type": "string", "enum": ["quick", "standard", "deep"], "default": "standard"},
                "recency_months": {"type": "integer"},
                "cross_temporal": {"type": "boolean"},
                "dig_deeper": {"type": "boolean"},
                "interactive": {"type": "boolean"},
                "backend": {"type": "string"},
                "model": {"type": "string", "description": "Provider-qualified model id."},
                "mcp_server_ids": {"type": "array", "items": {"type": "string"}},
                "plan": {"type": "object"},
            },
            "required": ["query"],
        },
    },
    "list_deep_research_jobs": {
        "handler": tool_list_deep_research_jobs,
        "description": "List active and recent deep-research job status.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    "list_research": {
        "handler": tool_list_research,
        "description": "List completed or pending research library entries for the shared workspace.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "feature_tag": {"type": "string"},
            },
        },
    },
    "get_research": {
        "handler": tool_get_research,
        "description": "Fetch one research entry with sources.",
        "inputSchema": {
            "type": "object",
            "properties": {"entry_id": {"type": "string"}},
            "required": ["entry_id"],
        },
    },
    "search_research": {
        "handler": tool_search_research,
        "description": "Search shared research entries and source summaries.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "workspace_id": {"type": "string"},
            },
            "required": ["query"],
        },
    },
    "list_observatory_findings": {
        "handler": tool_list_observatory_findings,
        "description": "List shared observatory findings for product/ecosystem signals.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "source": {"type": "string"},
                "status": {"type": "string"},
                "min_score": {"type": "number"},
                "limit": {"type": "integer", "default": 50},
            },
        },
    },
    "list_observatory_scans": {
        "handler": tool_list_observatory_scans,
        "description": "List observatory scan runs and status.",
        "inputSchema": {
            "type": "object",
            "properties": {"source": {"type": "string"}},
        },
    },
    "trigger_observatory_scan": {
        "handler": tool_trigger_observatory_scan,
        "description": "Trigger a focused observatory scan from chat when market/ecosystem signal would clarify a brainstorm.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "source": {"type": "string", "default": "all"},
                "mode": {"type": "string", "default": "both"},
                "keywords": {"oneOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}]},
            },
        },
    },
    "trigger_observatory_smart_scan": {
        "handler": tool_trigger_observatory_smart_scan,
        "description": "Trigger the profile-aware smart observatory scan. Use this for exploratory product-signal gathering.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "source": {"type": "string"},
                "sources": {"type": "array", "items": {"type": "string"}},
                "wait": {"type": "boolean", "default": False},
            },
        },
    },
}


# Optional semantic coordination and ordinary workspace file claims.

FILE_CLAIM_TOOLS = {
    "acquire_file_claim": {
        "handler": tool_acquire_file_claim,
        "description": "Claim a workspace file for this session. If a live peer holds the path, returns granted:false and the current holder. Respect the result and release when finished. These cooperating-session claims are not filesystem isolation.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "File you want exclusive edit access to.",
                },
                "intent": {
                    "type": "string",
                    "description": "Optional description of what you're doing.",
                },
                "ttl_s": {
                    "type": "integer",
                    "description": "Optional claim lifetime in seconds (default 900).",
                },
            },
            "required": [
                "file_path",
            ],
        },
    },
    "release_file_claim": {
        "handler": tool_release_file_claim,
        "description": "Release this session's workspace file claim when finished.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "File you're done editing.",
                },
                "claim_id": {
                    "type": "string",
                    "description": "Optional exact claim id to release.",
                },
            },
        },
    },
    "list_file_claims": {
        "handler": tool_list_file_claims,
        "description": "List active workspace file claims and their holders.",
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
}

MYELIN_COORD_TOOLS = {}
_SWARMLOCK_CONTEXT_TOOLS = {}
_SWARMLOCK_BRAINSTORMER_CONTEXT_TOOLS = {}
if extension_available("swarmlock"):
    from extension_host import load_legacy_namespace as _load_extension_namespace
    _MYELIN_COORD_TOOLS_namespace = {"__name__": "_ive_swarmlock_worker_tools"}
    _load_extension_namespace(_MYELIN_COORD_TOOLS_namespace, "swarmlock", "backend/worker_tools.py")
    MYELIN_COORD_TOOLS = _MYELIN_COORD_TOOLS_namespace["build_tools"]({
        "api_call": lambda *args, **kwargs: api_call(*args, **kwargs),
        "get_workspace_id": lambda: WORKSPACE_ID,
        "get_agent_id": lambda: SESSION_ID,
    })
    for _extension_tool_name, _extension_tool_spec in MYELIN_COORD_TOOLS.items():
        globals()["tool_" + _extension_tool_name] = _extension_tool_spec["handler"]
    _context_host = {"api_call": lambda *args, **kwargs: api_call(*args, **kwargs), "get_workspace_id": lambda: WORKSPACE_ID, "get_agent_id": lambda: SESSION_ID}
    _SWARMLOCK_CONTEXT_TOOLS = _MYELIN_COORD_TOOLS_namespace["build_context_tools"](_context_host)
    _SWARMLOCK_BRAINSTORMER_CONTEXT_TOOLS = _MYELIN_COORD_TOOLS_namespace["build_context_tools"](_context_host, role="brainstormer")
    _MYELIN_COORD_TOOLS_namespace["extend_bulletin_tools"](W2W_BULLETIN_TOOLS)
    tool_find_related_tickets = _SWARMLOCK_CONTEXT_TOOLS["find_related_tickets"]["handler"]
    tool_find_similar_sessions = _SWARMLOCK_CONTEXT_TOOLS["find_similar_sessions"]["handler"]


# Optional Myelin product tools; backend workspace authorization still applies.

MYELIN_MEMORY_TOOLS = {}
if extension_available("myelin"):
    from extension_host import load_legacy_namespace as _load_extension_namespace
    _MYELIN_MEMORY_TOOLS_namespace = {"__name__": "_ive_myelin_worker_tools"}
    _load_extension_namespace(_MYELIN_MEMORY_TOOLS_namespace, "myelin", "backend/worker_tools.py")
    MYELIN_MEMORY_TOOLS = _MYELIN_MEMORY_TOOLS_namespace["build_tools"]({
        "api_call": lambda *args, **kwargs: api_call(*args, **kwargs),
        "get_workspace_id": lambda: WORKSPACE_ID,
        "get_agent_id": lambda: SESSION_ID,
    })
    for _extension_tool_name, _extension_tool_spec in MYELIN_MEMORY_TOOLS.items():
        globals()["tool_" + _extension_tool_name] = _extension_tool_spec["handler"]


# Optional product tools are installed through the trusted extension host.
# Keep this seam free of product schemas, prompts, graph validation, and URLs.
AGENT_SYSTEM_TOOLS = {}
if extension_available("agentario"):
    from extension_host import load_legacy_namespace as _load_extension_namespace
    _agentario_worker_namespace = {"__name__": "_ive_agentario_worker_tools"}
    _load_extension_namespace(
        _agentario_worker_namespace, "agentario", "backend/worker_tools.py",
    )
    AGENT_SYSTEM_TOOLS = _agentario_worker_namespace["build_tools"]({
        "api_call": lambda *args, **kwargs: api_call(*args, **kwargs),
        "get_workspace_id": lambda: WORKSPACE_ID,
    })
    # Transitional direct-call aliases for existing integrations and tests.
    for _extension_tool_name, _extension_tool_spec in AGENT_SYSTEM_TOOLS.items():
        globals()["tool_" + _extension_tool_name] = _extension_tool_spec["handler"]


# ─── MCP stdio protocol ─────────────────────────────────────────────────

def handle_request(req: dict) -> dict:
    method = req.get("method", "")
    rid = req.get("id")

    if method == "initialize":
        return {
            "jsonrpc": "2.0", "id": rid,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "worker-board", "version": "1.0.0"},
            },
        }

    if method == "notifications/initialized":
        return None  # no response needed

    if method == "tools/list":
        tools_list = []
        for name, spec in TOOLS.items():
            tools_list.append({
                "name": name,
                "description": spec["description"],
                "inputSchema": spec["inputSchema"],
            })
        return {"jsonrpc": "2.0", "id": rid, "result": {"tools": tools_list}}

    if method == "tools/call":
        tool_name = req.get("params", {}).get("name", "")
        arguments = req.get("params", {}).get("arguments", {})
        spec = TOOLS.get(tool_name)
        if not spec:
            return {
                "jsonrpc": "2.0", "id": rid,
                "result": {"content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}], "isError": True},
            }
        try:
            result_text = spec["handler"](arguments)
        except Exception as e:
            result_text = json.dumps({"error": str(e)})
        return {
            "jsonrpc": "2.0", "id": rid,
            "result": {"content": [{"type": "text", "text": result_text}]},
        }

    # Unknown method
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"Unknown method: {method}"}}


def _load_workspace_flags() -> dict:
    """Fetch W2W feature flags for the worker's workspace (once at startup).

    Two paths, in order of preference:

    1. **Env vars** (WORKER_W2W_COMMS / _CONTEXT / _COORDINATION) plumbed in
       at PTY-spawn time by server.py's MCP env resolver. Fast, no network,
       and side-steps the startup race where commander's API isn't ready
       when this MCP launches. This is the path used in the steady state.

    2. **API fallback**. Used when env vars are absent (e.g. a manually-
       installed worker-MCP entry that pre-dates this scheme, or an
       unsubstituted template like the literal string "{w2w_comms}").
       On failure, log loudly to stderr so the worker log captures the
       cause — otherwise the failure is undebuggable.

    Returns {} on any failure (fail-closed: don't register W2W tools the
    workspace hasn't opted into).
    """
    # ── Env-var path ────────────────────────────────────────────────
    placeholders = {"", "{w2w_comms}", "{w2w_context}", "{w2w_coordination}"}
    env_pairs = (
        ("comms", os.environ.get("WORKER_W2W_COMMS", "")),
        ("context", os.environ.get("WORKER_W2W_CONTEXT", "")),
        ("coordination", os.environ.get("WORKER_W2W_COORDINATION", "")),
    )
    if any(v not in placeholders for _, v in env_pairs):
        truthy = {"1", "true", "True", "yes", "on"}
        return {k: v in truthy for k, v in env_pairs}

    # ── API fallback ────────────────────────────────────────────────
    if not WORKSPACE_ID:
        return {}
    try:
        workspaces = api_call("GET", "/workspaces")
        if not isinstance(workspaces, list):
            print(
                f"[worker-mcp] W2W flag fetch failed (api_call returned non-list): {workspaces!r}. "
                "No W2W tools will register; prompt may still reference them.",
                file=sys.stderr, flush=True,
            )
            return {}
        for ws in workspaces:
            if ws.get("id") == WORKSPACE_ID:
                return {
                    "comms": bool(ws.get("comms_enabled")),
                    "coordination": bool(ws.get("coordination_enabled")),
                    "context": bool(ws.get("context_sharing_enabled")),
                }
        print(
            f"[worker-mcp] W2W flag fetch: workspace {WORKSPACE_ID} not found in /workspaces "
            f"(saw {len(workspaces)} workspaces). Likely a startup race — the worker MCP "
            "spawned before the workspace row was committed. No W2W tools will register.",
            file=sys.stderr, flush=True,
        )
    except Exception as e:
        print(
            f"[worker-mcp] W2W flag fetch raised: {type(e).__name__}: {e}. "
            "No W2W tools will register; prompt may still reference them.",
            file=sys.stderr, flush=True,
        )
    return {}


def _load_alloy_enabled() -> bool:
    placeholders = {"", "{alloy_enabled}"}
    if IVE_ALLOY_ENABLED not in placeholders:
        return IVE_ALLOY_ENABLED.strip().lower() in {"1", "true", "yes", "on"}
    if not WORKSPACE_ID:
        return False
    try:
        workspaces = api_call("GET", "/workspaces")
        if isinstance(workspaces, list):
            for ws in workspaces:
                if ws.get("id") == WORKSPACE_ID:
                    return bool(ws.get("alloy_enabled"))
    except Exception as e:
        print(
            f"[worker-mcp] Alloy flag fetch raised: {type(e).__name__}: {e}. "
            "No Alloy tools will register.",
            file=sys.stderr, flush=True,
        )
    return False


def _app_setting(key: str) -> str | None:
    """Fetch a single app_settings value. None on any failure (fail-safe)."""
    try:
        result = api_call("GET", f"/settings/{key}")
        if isinstance(result, dict):
            return result.get("value")
    except Exception:
        pass
    return None


BRAINSTORMER_DISABLED_TOOLS = {
    "report_pipeline_result",
    "submit_result",
    "get_my_tasks",
    "get_my_task",
    "update_my_task",
    "task_ready",
    "request_capability_handoff",
    "switch_active_ticket",
    "document_to_board",
    "list_port_leases",
    "get_workspace_runtime_env",
    "lease_port",
    "heartbeat_port_lease",
    "release_port_lease",
}


# ─── Secure-agent tools (gated on session_type='secure') ──────────────
#
# The Secure agent has NO host shell (Bash is blocked). Its ONLY execution path
# is run_in_secure_container, which routes the command through the scope-aware
# Sonnet pre-exec check on the backend and into the network-clamped Kali box.

def tool_get_scope(args: dict) -> str:
    """Return the AUTHORIZED scope for this offensive test."""
    return json.dumps(api_call("GET", "/secure/scope"), indent=2)


def tool_run_in_secure_container(args: dict) -> str:
    """Run a command INSIDE the sandboxed Kali box (the only execution path).

    The backend checks every command against the authorized scope BEFORE it runs;
    an out-of-scope or forbidden command is denied with a reason and NOT executed.
    """
    command = (args.get("command") or "").strip()
    if not command:
        return json.dumps({"error": "command required"})
    body = {"command": command}
    if args.get("script_content"):
        body["script_content"] = args["script_content"]
    return json.dumps(api_call("POST", "/secure/exec", body), indent=2)


def tool_write_finding(args: dict) -> str:
    """Record a confirmed finding from the authorized test."""
    title = (args.get("title") or "").strip()
    if not title:
        return json.dumps({"error": "title required"})
    body = {
        "title": title,
        "severity": args.get("severity", "info"),
        "detail": args.get("detail", ""),
        "reproduction": args.get("reproduction", ""),
        "target_ip": args.get("target_ip", ""),
    }
    return json.dumps(api_call("POST", "/secure/findings", body))


def tool_list_findings(args: dict) -> str:
    """List findings recorded for this Secure run so far."""
    res = api_call("GET", "/secure/run")
    if isinstance(res, dict):
        return json.dumps({"findings": res.get("findings", []),
                           "status": (res.get("run") or {}).get("status")}, indent=2)
    return json.dumps({"findings": []})


SECURE_TOOLS = {
    "get_scope": {
        "handler": tool_get_scope,
        "description": (
            "Return the AUTHORIZED scope for this offensive test: target IP(s)/port(s), "
            "rules of engagement, intensity, and whether general internet is allowed. "
            "Call this FIRST and stay strictly within it."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    "run_in_secure_container": {
        "handler": tool_run_in_secure_container,
        "description": (
            "Run a command INSIDE the sandboxed, network-clamped Kali box. This is the ONLY way "
            "to execute anything — you have no host shell. Every command is checked against the "
            "authorized scope first; out-of-scope or forbidden commands (targeting the host, or "
            "downloading+running internet exploit code) are denied with a reason and NOT executed. "
            "Returns {decision, output, exit_code}."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to run in the Kali box, e.g. 'nmap -sV 10.0.0.5' or a python exploit you wrote yourself."},
                "script_content": {"type": "string", "description": "Optional: full body of a script this command runs, so the safety check can read it."},
            },
            "required": ["command"],
        },
    },
    "write_finding": {
        "handler": tool_write_finding,
        "description": "Record a CONFIRMED, reproducible finding against the authorized target. Prefer demonstrated issues over speculation.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "severity": {"type": "string", "enum": ["info", "low", "medium", "high", "critical"]},
                "detail": {"type": "string", "description": "What the issue is and why it matters."},
                "reproduction": {"type": "string", "description": "Exact steps / request to reproduce it."},
                "target_ip": {"type": "string"},
            },
            "required": ["title", "severity", "detail"],
        },
    },
    "list_findings": {
        "handler": tool_list_findings,
        "description": "List the findings recorded for this Secure run so far.",
        "inputSchema": {"type": "object", "properties": {}},
    },
}


PLANNER_TOOLS = {
    "set_seam_contract": {
        "handler": tool_set_seam_contract,
        "description": (
            "Declare the integration contract between independent slices on your "
            "intent task. Planner-only. Use ONLY when you split the work into "
            "independent slices that must meet at a seam (frontend↔backend API, "
            "service↔service, producer↔consumer): spell out the exact interface "
            "(paths, request/response schema, message format, error + auth cases) "
            "each finished product must honor. It is injected into every slice "
            "worker so they build to the same seam. Skip it for linear depends_on "
            "chains or single-area work — there is no seam to honor."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "contract": {
                    "type": "string",
                    "description": "The shared interface between the independent slices, concrete enough that each side can build to it without seeing the other's code.",
                },
            },
            "required": ["contract"],
        },
    },
    "list_research": {
        "handler": tool_list_research,
        "description": (
            "List the workspace's research library entries — a bounded pool to "
            "scan when reuse-checking before you commission. Read-only. For a "
            "'does this already exist?' check pass status='complete' plus "
            "recency_days and limit to cap the pool; for a topic search use "
            "search_research instead. Check this before decomposing — a "
            "sub-task's external-context need may already be answered."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string"},
                "feature_tag": {"type": "string"},
                "status": {"type": "string", "description": "e.g. 'complete' to see only finished research."},
                "recency_days": {"type": "integer", "description": "Only entries updated within the last N days."},
                "limit": {"type": "integer", "description": "Cap the pool size (e.g. 30)."},
            },
        },
    },
    "search_research": {
        "handler": tool_search_research,
        "description": (
            "Search the research library by topic. Read-only. Use it to find "
            "prior findings relevant to the task you're decomposing so you can "
            "reuse them in the plan instead of leaving a gap."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "workspace_id": {"type": "string"},
            },
            "required": ["query"],
        },
    },
    "get_research": {
        "handler": tool_get_research,
        "description": "Fetch one research entry with its sources. Read-only.",
        "inputSchema": {
            "type": "object",
            "properties": {"entry_id": {"type": "string"}},
            "required": ["entry_id"],
        },
    },
    "start_deep_research": {
        "handler": tool_start_deep_research,
        "description": (
            "Commission deep research for a sub-task that genuinely can't be "
            "planned without external evidence (a library's API, a security "
            "advisory, a feasibility unknown). FIRST search_research — reuse an "
            "existing finding if one covers it. When you DO commission, pass "
            "task_id of the sub-task: it parks in the backlog and auto-resumes "
            "when the research completes (or unblocks if it fails) — so you can "
            "file it and stop, you do NOT wait or poll. Most planning needs none "
            "of this; don't gate routine sub-tasks on research."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "The research question."},
                "task_id": {"type": "string", "description": "Sub-task to park on this research until it completes."},
                "feature_tag": {"type": "string"},
                "depth": {"type": "string", "enum": ["quick", "standard", "deep"]},
            },
            "required": ["query"],
        },
    },
    "create_task": {
        "handler": tool_create_task,
        "description": (
            "File a new sub-task on the feature board. Planner-only. Use this "
            "to decompose your assigned intent task into one or more concrete "
            "sub-tasks for the Commander to dispatch. After filing, mark your "
            "own task status='review' and stop. Do not implement the sub-tasks "
            "yourself."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Short, action-oriented title."},
                "description": {"type": "string", "description": "What the task entails — concrete, scoped."},
                "acceptance_criteria": {"type": "string", "description": "Bulleted criteria for 'done'."},
                "priority": {"type": "string", "enum": ["low", "medium", "high"], "description": "Default: medium."},
                "labels": {"type": "array", "items": {"type": "string"}, "description": "e.g. ['implementation','frontend']."},
                "depends_on": {"type": "array", "items": {"type": "string"}, "description": "Task IDs this sub-task waits on. Use to encode ordering between sub-tasks."},
                "pipeline": {"type": "boolean", "description": "Override whether this task starts a visible pipeline run. Alloy tasks should default false unless pipeline tracking was explicitly requested."},
                "pipeline_max_iterations": {"type": "integer", "description": "Max retry loops for pipeline execution."},
                "test_with_agent": {"type": "boolean", "description": "Require a testing-capable worker. For Alloy, set true only when generated SDK/MCP artifacts need an explicit verification gate."},
                "plan_first": {"type": "boolean", "description": "Require implementation planning before edits."},
                "deep_research": {"type": "boolean", "description": "Run deep research before implementation."},
                "ralph_loop": {"type": "boolean", "description": "Run execute/verify/fix until checks pass."},
            },
            "required": ["title"],
        },
    },
}


_BASE_TOOLS = dict(TOOLS)


def compose_tool_registry(
    session_type: str,
    workspace_flags: dict | None = None,
    *,
    alloy_enabled: bool = False,
) -> tuple[dict, dict[str, str]]:
    """Return the exact worker-MCP tool set and each tool's registration seam.

    The stdio server and the session-capabilities dump both call this pure
    composer.  That keeps the transparency view honest when role or workspace
    gates change: it cannot drift into a second, hand-maintained tool list.
    """
    stype = (session_type or "worker").strip() or "worker"
    flags = workspace_flags or {}
    registry = dict(_BASE_TOOLS)
    sources = {name: "core" for name in registry}

    if stype == "brainstormer":
        for tool_name in BRAINSTORMER_DISABLED_TOOLS:
            registry.pop(tool_name, None)
            sources.pop(tool_name, None)

    def add(group: str, tools: dict) -> None:
        registry.update(tools)
        sources.update({name: group for name in tools})

    if stype not in ("brainstormer", "secure"):
        if flags.get("comms"):
            add("workspace-comms", W2W_COMMS_TOOLS)
            add("workspace-bulletins", W2W_BULLETIN_TOOLS)
        if flags.get("context"):
            add("workspace-context", W2W_CONTEXT_TOOLS)
            if extension_available("swarmlock"):
                add("workspace-context", _SWARMLOCK_CONTEXT_TOOLS)

    if flags.get("coordination") and stype != "secure":
        add("workspace-coordination", FILE_CLAIM_TOOLS)
        if extension_available("swarmlock"):
            add("workspace-coordination", MYELIN_COORD_TOOLS)
    if stype not in ("brainstormer", "secure") and alloy_enabled:
        add("alloy", ALLOY_TOOLS)

    if extension_available("myelin"):
        add("myelin-memory", MYELIN_MEMORY_TOOLS)
    if stype != "secure" and extension_available("agentario"):
        add("agent-system", AGENT_SYSTEM_TOOLS)
    if stype == "planner":
        add("planner", PLANNER_TOOLS)
    if stype == "architect":
        add("architect", ARCHITECT_TOOLS)
    if stype == "brainstormer":
        add("brainstormer", BRAINSTORMER_TOOLS)
        if extension_available("swarmlock"):
            add("brainstormer", _SWARMLOCK_BRAINSTORMER_CONTEXT_TOOLS)
    if stype == "secure":
        add("secure", SECURE_TOOLS)

    return registry, sources


def main():
    global TOOLS
    from mcp_exit_log import install, log_exit
    install("worker-board")

    if not SESSION_ID:
        log_exit("config-error", "(WORKER_SESSION_ID env var not set)")
        print("WORKER_SESSION_ID env var not set — cannot scope task access.", file=sys.stderr)
        sys.exit(1)

    flags = _load_workspace_flags()
    TOOLS, _tool_sources = compose_tool_registry(
        SESSION_TYPE,
        flags,
        alloy_enabled=_load_alloy_enabled(),
    )

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError:
                continue
            resp = handle_request(req)
            if resp is not None:
                try:
                    sys.stdout.write(json.dumps(resp) + "\n")
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
