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


def api_call(method: str, path: str, body: dict | None = None) -> dict | list:
    url = f"{API_URL}/api{path}"
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"} if body else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": e.read().decode(), "status": e.code}
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
    """Get full details of an assigned task."""
    task_id = args["task_id"]
    task = _is_my_task(task_id)
    if not task:
        return json.dumps({"error": "Task not found or not assigned to this session"})
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


# ─── Tool registry ──────────────────────────────────────────────────────

TOOLS = {
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
    "search_memory": {
        "handler": tool_search_memory,
        "description": (
            "Search across ALL workspace memory — past tasks with lessons learned, session digests, "
            "knowledge base entries, peer messages, and file activity. This is your go-to tool for "
            "context before starting any work. Returns results grouped by type with relevance scores."
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
            "Use this when you discover something about the codebase that would help others."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "enum": ["architecture", "convention", "gotcha", "pattern", "api", "setup"],
                    "description": "Category of knowledge.",
                },
                "content": {"type": "string", "description": "The insight or knowledge to share."},
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
                "category": {"type": "string", "enum": ["architecture", "convention", "gotcha", "pattern", "api", "setup"], "description": "Filter by category."},
            },
        },
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
    """Fetch W2W feature flags for the worker's workspace (once at startup)."""
    if not WORKSPACE_ID:
        return {}
    try:
        workspaces = api_call("GET", "/workspaces")
        if isinstance(workspaces, list):
            for ws in workspaces:
                if ws.get("id") == WORKSPACE_ID:
                    return {
                        "comms": bool(ws.get("comms_enabled")),
                        "coordination": bool(ws.get("coordination_enabled")),
                        "context": bool(ws.get("context_sharing_enabled")),
                    }
    except Exception:
        pass
    return {}


def main():
    if not SESSION_ID:
        print("WORKER_SESSION_ID env var not set — cannot scope task access.", file=sys.stderr)
        sys.exit(1)

    # Conditionally register W2W tools based on workspace feature flags
    flags = _load_workspace_flags()
    if flags.get("comms"):
        TOOLS.update(W2W_COMMS_TOOLS)
    if flags.get("context"):
        TOOLS.update(W2W_CONTEXT_TOOLS)

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
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
