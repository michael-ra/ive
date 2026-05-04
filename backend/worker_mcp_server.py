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

API_URL = os.environ.get("COMMANDER_API_URL", "http://127.0.0.1:5111")
SESSION_ID = os.environ.get("WORKER_SESSION_ID", "")
WORKSPACE_ID = os.environ.get("WORKER_WORKSPACE_ID", "")
SESSION_TYPE = os.environ.get("WORKER_SESSION_TYPE", "worker")


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
    if SESSION_TYPE:
        headers["X-IVE-Session-Type"] = SESSION_TYPE
    if WORKSPACE_ID:
        headers["X-IVE-Workspace-Id"] = WORKSPACE_ID
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
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


# ─── Ownership check ────────────────────────────────────────────────────

def _is_my_task(task_id: str) -> dict | None:
    """Fetch a task and verify it's assigned to this session. Returns task or None."""
    task = api_call("GET", f"/tasks/{task_id}")
    if isinstance(task, dict) and task.get("assigned_session_id") == SESSION_ID:
        return task
    return None


# ─── Tool implementations ───────────────────────────────────────────────

def tool_get_my_tasks(args: dict) -> str:
    """List all tasks assigned to this worker session."""
    status = args.get("status_filter", "all")
    path = f"/tasks?assigned_session={SESSION_ID}"
    if status != "all":
        path += f"&status={status}"
    result = api_call("GET", path)
    return json.dumps(result, indent=2)


def tool_get_my_task(args: dict) -> str:
    """Get full details of an assigned task, including attachments."""
    task_id = args["task_id"]
    task = _is_my_task(task_id)
    if not task:
        return json.dumps({"error": "Task not found or not assigned to this session"})
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


def tool_contribute_knowledge(args: dict) -> str:
    """Contribute a codebase insight to the workspace knowledge base for other sessions."""
    body = {
        "category": args["category"],
        "content": args["content"],
        "scope": args.get("scope", ""),
        "contributed_by": SESSION_ID,
    }
    result = api_call("POST", f"/workspaces/{WORKSPACE_ID}/knowledge", body)
    return json.dumps(result, indent=2)


def tool_find_similar_sessions(args: dict) -> str:
    """Find past or active sessions that worked on something similar."""
    query = args.get("query", "")
    params = f"?q={urllib.parse.quote(query)}"
    if WORKSPACE_ID:
        params += f"&workspace_id={WORKSPACE_ID}"
    if SESSION_ID:
        params += f"&exclude_session={SESSION_ID}"
    result = api_call("GET", f"/sessions/similar{params}")
    return json.dumps(result, indent=2)


def tool_find_similar_tasks(args: dict) -> str:
    """Find completed tasks similar to a query — returns their lessons learned and important notes."""
    query = args.get("query", "")
    params = f"?q={urllib.parse.quote(query)}"
    if WORKSPACE_ID:
        params += f"&workspace_id={WORKSPACE_ID}"
    result = api_call("GET", f"/tasks/similar{params}")
    return json.dumps(result, indent=2)


def tool_find_related_tickets(args: dict) -> str:
    """Find OPEN tickets in the current workspace whose intent overlaps with
    the query. Backed by the myelin semantic index — different from
    find_similar_tasks (keyword/fallback over completed tasks).
    """
    if not WORKSPACE_ID:
        return json.dumps({"error": "no workspace bound to this session"})
    body = {
        "query": args.get("query", ""),
        "files_touched": args.get("files_touched") or [],
        "status_filter": args.get("status_filter", "open"),
        "limit": int(args.get("limit", 10)),
    }
    result = api_call("POST", f"/workspaces/{WORKSPACE_ID}/tickets/find_related", body)
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
    """Search across ALL workspace memory: past tasks (with lessons), session digests, knowledge base, peer messages, and file activity. Use this as your first stop when starting work on something — it surfaces everything the workspace knows about a topic."""
    query = args.get("query", "")
    types = args.get("types", "tasks,digests,knowledge,messages,files")
    params = f"?q={urllib.parse.quote(query)}&types={types}&limit=5"
    result = api_call("GET", f"/workspaces/{WORKSPACE_ID}/memory-search{params}")
    return json.dumps(result, indent=2)


def tool_query_knowledge(args: dict) -> str:
    """Search the workspace knowledge base for relevant codebase context."""
    params = []
    if args.get("query"):
        params.append(f"query={urllib.parse.quote(args['query'])}")
    if args.get("scope"):
        params.append(f"scope={urllib.parse.quote(args['scope'])}")
    if args.get("category"):
        params.append(f"category={urllib.parse.quote(args['category'])}")
    qs = "?" + "&".join(params) if params else ""
    result = api_call("GET", f"/workspaces/{WORKSPACE_ID}/knowledge{qs}")
    return json.dumps(result, indent=2)


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


# ─── Memory write (worker-side) ─────────────────────────────────────────

VALID_MEMORY_TYPES = {"user", "feedback", "project", "reference"}


def tool_save_memory(args: dict) -> str:
    """Persist a durable insight to the workspace memory pool.

    Workers historically had `search_memory` (read) but no write path, so
    everything they learned died with the session. This closes that gap.
    Entries are tagged `auto=0` (manually saved by the agent — deliberate)
    to keep them out of the autolearn review queue.
    """
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
    """Fetch the full body of a memory entry by name.

    The system prompt's Remembered Context block may be rendered in *index*
    mode (one line per entry: ``name — description``) when the workspace
    has more memory than fits inline. Use this to expand any entry whose
    description looks relevant to your current task.

    Looks first in the bound workspace, then falls back to global entries.
    Returns the entry as JSON: ``{ok, name, type, description, content,
    updated_at}`` or ``{ok: false, error}``.
    """
    name = (args.get("name") or "").strip()
    if not name:
        return json.dumps({"ok": False, "error": "name is required"})

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
        if (e.get("name") or "").strip().lower() != target:
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


# ─── Headsup + Blocking bulletin ────────────────────────────────────────

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


# ─── Myelin coordination tools (gated on experimental flag) ─────────────

def tool_coord_check_overlap(args: dict) -> str:
    from peer_comms import myelin_check_overlap
    file_path = args.get("file_path", "")
    intent = args.get("intent", "") or f"editing {file_path}"
    return json.dumps(myelin_check_overlap(SESSION_ID, intent, file_path), indent=2)


def tool_coord_acquire(args: dict) -> str:
    from peer_comms import myelin_acquire
    file_path = args.get("file_path", "")
    intent = args.get("intent", "")
    return json.dumps(myelin_acquire(SESSION_ID, file_path, intent), indent=2)


def tool_coord_release(args: dict) -> str:
    from peer_comms import myelin_release
    file_path = args.get("file_path", "")
    return json.dumps(myelin_release(SESSION_ID, file_path), indent=2)


def tool_coord_peers(args: dict) -> str:
    from peer_comms import myelin_peers
    return json.dumps(myelin_peers(SESSION_ID), indent=2)


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
                "task_id": {"type": "string", "description": "The task ID to fetch."},
            },
            "required": ["task_id"],
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
        "description": (
            "USE THIS BEFORE you start coding. The workspace's accumulated playbook lives "
            "here — past tasks with lessons learned, session digests, knowledge base entries, "
            "peer messages, and file activity. If a peer hit the same gotcha last week, the "
            "answer is searchable right now. Trigger checklist: (1) before editing an "
            "unfamiliar module — what conventions has this codebase settled on? (2) before "
            "picking an approach — was this rejected by a previous worker? (3) before "
            "asking the user — has the user already answered this for someone else? Returns "
            "results grouped by type with relevance scores."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to search for. Semantic matching for tasks/digests/knowledge, keyword for messages/files."},
                "types": {"type": "string", "description": "Comma-separated types to search: tasks,digests,knowledge,messages,files. Default: all."},
            },
            "required": ["query"],
        },
    },
    "save_memory": {
        "handler": tool_save_memory,
        "description": (
            "MEMORY IS YOUR FUTURE SELF — call this often. Use this whenever you make a "
            "significant decision, hit a non-obvious gotcha, get corrected by the user, "
            "discover a codebase pattern, reject an approach, or finish a task. "
            "Trigger checklist: (1) finished a task → save type='project' with what was done, "
            "why, what surprised you, what to watch for next time. (2) user corrected your "
            "approach → save type='feedback'. (3) discovered a convention or gotcha → save "
            "type='project' with reproduction context. (4) found a reusable pattern → "
            "save type='reference'. Don't save trivia (which file you opened); save the "
            "things a future agent would lose hours rediscovering. Idempotent on `name` — "
            "re-using a name updates the existing entry instead of duplicating it. "
            "If you finish a task without calling this at least once, you have failed your "
            "future self."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Short title (acts as the dedup key within the workspace).",
                },
                "type": {
                    "type": "string",
                    "enum": ["user", "feedback", "project", "reference"],
                    "description": (
                        "user = preferences/role; feedback = approach guidance from corrections; "
                        "project = ongoing goals/context; reference = pointers to external systems."
                    ),
                },
                "content": {
                    "type": "string",
                    "description": "The insight itself. One paragraph or a tight bullet list.",
                },
                "description": {
                    "type": "string",
                    "description": (
                        "One-line summary used in the Remembered Context index "
                        "(when the workspace has more memory than fits inline). "
                        "Make it specific enough that a future agent scanning a "
                        "list can decide whether to recall_memory the full body."
                    ),
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional tags for filtering.",
                },
            },
            "required": ["name", "type", "content"],
        },
    },
    "recall_memory": {
        "handler": tool_recall_memory,
        "description": (
            "Expand a memory entry from the Remembered Context index. When the system "
            "prompt shows entries as one-liners ('name — description'), call this with "
            "the name to fetch the full body before acting on it. No-op for entries you "
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
            },
            "required": ["name"],
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
    "find_similar_sessions": {
        "handler": tool_find_similar_sessions,
        "description": (
            "Find past or active sessions that worked on something similar to your current task. "
            "Returns their digest (what they worked on, files touched, decisions, discoveries) "
            "with a similarity score. Use this to learn from past sessions' experience."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Describe what you're working on. Will semantically match against session digests.",
                },
            },
            "required": ["query"],
        },
    },
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
    "find_related_tickets": {
        "handler": tool_find_related_tickets,
        "description": (
            "Find OPEN tickets in this workspace whose intent overlaps with your query. "
            "Backed by the workspace's semantic index. Use before opening a new ticket "
            "(to spot duplicates) and when picking up new work (to discover the right "
            "ticket to bind to). Returns each candidate with a `level` field "
            "(CONFLICT/SHARE/NOTIFY/TANGENT) — CONFLICT means very likely the same task."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What you're considering working on. A sentence describing intent works best.",
                },
                "files_touched": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional file paths you're editing — fuses file-set Jaccard with cosine via RRF.",
                },
                "status_filter": {
                    "type": "string",
                    "description": "'open' (default — excludes done/verified/cancelled), 'all', or a specific status.",
                },
                "limit": {"type": "integer", "default": 10},
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
    "contribute_knowledge": {
        "handler": tool_contribute_knowledge,
        "description": (
            "Contribute a codebase insight to the workspace knowledge base. "
            "Future sessions will receive this knowledge in their system prompt. "
            "Use this when you discover something about the codebase that would help others. "
            "\n\nFor `category=\"code_catalog\"`, `content` MUST be a single wire-format line: "
            "`<file>::<symbol>(<args>?): <purpose> [| →dep ←caller ↔shared] [◆effect]`. "
            "Examples: "
            "`backend/server.py::create_app(): registers routes | →get_db ◆reads config` ; "
            "`src/Foo.tsx::Foo(): renders panel | ←App.jsx`. "
            "Catalog rows are deduped by (workspace, file, symbol) — re-emitting the same line confirms it; "
            "emitting different content for the same symbol replaces it (prior version archived to history)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "enum": [
                        "architecture", "convention", "gotcha", "pattern", "api", "setup",
                        "code_catalog",
                    ],
                    "description": "Category of knowledge. `code_catalog` requires a single wire-format line in `content` (see tool description).",
                },
                "content": {"type": "string", "description": "The insight to share, OR a single catalog wire-format line if category='code_catalog'."},
                "scope": {"type": "string", "description": "Module or subsystem scope (e.g., 'backend/hooks', 'frontend/state'). Optional."},
            },
            "required": ["category", "content"],
        },
    },
    "query_knowledge": {
        "handler": tool_query_knowledge,
        "description": "Search the workspace knowledge base for codebase context contributed by other sessions.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query."},
                "scope": {"type": "string", "description": "Filter by module/subsystem scope."},
                "category": {
                    "type": "string",
                    "enum": [
                        "architecture", "convention", "gotcha", "pattern", "api", "setup",
                        "code_catalog",
                    ],
                    "description": "Filter by category.",
                },
            },
        },
    },
}


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
        "description": (
            "USE THIS WHENEVER you cannot safely proceed without an answer — and "
            "especially when coord_check_overlap returned a CONFLICT (≥0.80) with a "
            "peer's active work. Pauses you until commander or the peer replies, or "
            "until `timeout_secs` expires (default 600s). Trigger checklist: (1) about "
            "to delete or rewrite something a peer is actively editing. (2) need a "
            "decision between two non-trivial approaches. (3) ambiguous user "
            "requirement that would force expensive rework if guessed wrong. (4) hard "
            "conflict detected via coord_check_overlap — STOP and ask. Examples: "
            "'Should I prefer approach A or B?', 'About to delete src/x.py — peer is "
            "editing it, confirm?'. On timeout you're unblocked with "
            "{ok: false, reason: 'timeout'} so you can fall back to a documented "
            "default. Better to wait 30 seconds for an answer than ship a 30-minute "
            "rewrite of a peer's work."
        ),
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
    for key in ("description", "acceptance_criteria", "priority", "labels", "depends_on"):
        if key in args:
            body[key] = args[key]
    result = api_call("POST", "/tasks", body)
    return json.dumps(result, indent=2)


PLANNER_TOOLS = {
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
            },
            "required": ["title"],
        },
    },
}


# ─── Myelin coordination tools (gated on experimental flag) ────────────

MYELIN_COORD_TOOLS = {
    "coord_check_overlap": {
        "handler": tool_coord_check_overlap,
        "description": (
            "Check semantic overlap with peer agents before editing a file. "
            "Returns a list of active peers with overlap scores and levels "
            "(conflict ≥0.80, share 0.65–0.80, notify 0.55–0.65). Use this "
            "before starting destructive work to avoid stepping on a peer's toes."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "File you intend to edit."},
                "intent": {"type": "string", "description": "Short description of what you're about to do."},
            },
            "required": ["file_path", "intent"],
        },
    },
    "coord_acquire": {
        "handler": tool_coord_acquire,
        "description": (
            "Best-effort claim on a file — announces your task in the shared "
            "coordination graph so peers see your intent. Not a hard lock; "
            "peers can still proceed but they'll see your announcement on "
            "their overlap check."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "File you're starting to edit."},
                "intent": {"type": "string", "description": "Optional richer intent description."},
            },
            "required": ["file_path"],
        },
    },
    "coord_release": {
        "handler": tool_coord_release,
        "description": (
            "Release your claim on a file — marks your active coordination "
            "tasks for that file as completed. Call this when you finish "
            "editing so peers stop seeing you as active on it."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "File you're done editing."},
            },
            "required": ["file_path"],
        },
    },
    "coord_peers": {
        "handler": tool_coord_peers,
        "description": (
            "List active peer agents in this workspace's coordination namespace, "
            "with what they're working on. Read-only situational awareness."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
}


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


def _app_setting(key: str) -> str | None:
    """Fetch a single app_settings value. None on any failure (fail-safe)."""
    try:
        result = api_call("GET", f"/settings/{key}")
        if isinstance(result, dict):
            return result.get("value")
    except Exception:
        pass
    return None


def main():
    from mcp_exit_log import install, log_exit
    install("worker-board")

    if not SESSION_ID:
        log_exit("config-error", "(WORKER_SESSION_ID env var not set)")
        print("WORKER_SESSION_ID env var not set — cannot scope task access.", file=sys.stderr)
        sys.exit(1)

    # Conditionally register W2W tools based on workspace feature flags
    flags = _load_workspace_flags()
    if flags.get("comms"):
        TOOLS.update(W2W_COMMS_TOOLS)
        # Headsup + blocking_bulletin ride alongside the existing bulletin
        # board: same surface, same workspace flag.
        TOOLS.update(W2W_BULLETIN_TOOLS)
    if flags.get("context"):
        TOOLS.update(W2W_CONTEXT_TOOLS)

    # Myelin coord tools — only if the user has opted into the experimental
    # feature globally AND the workspace has coordination enabled. The MCP
    # server is started fresh per session, so toggling these requires a
    # session restart (matches the checkpoint/model-switching pattern).
    if flags.get("coordination") and _app_setting("experimental_myelin_coordination") == "on":
        TOOLS.update(MYELIN_COORD_TOOLS)

    # Planner-only tools (gated on the session type plumbed through env at
    # PTY-spawn time). Planners need create_task to decompose intent tasks
    # into sub-tasks; regular workers must not have it.
    if SESSION_TYPE == "planner":
        TOOLS.update(PLANNER_TOOLS)

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
