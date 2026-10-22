#!/usr/bin/env python3
"""
MCP server for IVE's Brainstormer agent.

Exposes the per-person Product Intake Brainstormer as its own MCP-connectible
surface — "just like the Commander" — so GI, the Commander, and external agents
can ASK it questions and READ its intake/backlog/research/observatory state.

CRITICAL: the Brainstormer is an ANSWER / READ endpoint, NEVER a dispatch
target. It does not implement, edit files, dispatch workers, or report
JOB_COMPLETED — routing it through the Brain's dispatch loop would hang. This
server therefore exposes ONLY intake/answer/read tools (no create_session,
send_message, dispatch, or write-to-board tools).

Runs as a stdio MCP server, same pattern as mcp_server.py /
worker_mcp_server.py / documentor_mcp_server.py. Uses urllib (stdlib) to call
the local REST API. No external dependencies.

Owner threading: the Brainstormer is per-person (unlike the workspace-singular
Commander). WHICH person's Brainstormer this server talks to is carried in the
seed-row env: BRAINSTORMER_OWNER_KIND / BRAINSTORMER_OWNER_ID. When the caller
is itself a running session (X-IVE-Session-Id set), the backend resolves the
owner from that session's auth context; the explicit owner headers let an
out-of-band caller (GI / external agent) pin the right person's Brainstormer.
The backend enforces the owner guards either way (_brainstormer_owner_key /
_session_readable_to_request), so one operator's Brainstormer never leaks to
another.
"""

import json
import os
import sys
import urllib.request
import urllib.error
import urllib.parse

API_URL = os.environ.get("COMMANDER_API_URL", "http://127.0.0.1:5111")
WORKSPACE_ID = os.environ.get("COMMANDER_WORKSPACE_ID", "")
# The session that this MCP server is attached to (e.g. a Commander). Used so
# the backend can resolve the owner from the caller's auth context and apply
# per-session read scoping, exactly like the Commander/worker MCP servers.
SESSION_ID = os.environ.get("BRAINSTORMER_CALLER_SESSION_ID", "")
SESSION_TYPE = os.environ.get("BRAINSTORMER_CALLER_SESSION_TYPE", "")
# Per-person owner identity. Carried in the seed-row env so an out-of-band
# caller (GI / external agent with no session) still pins the right person's
# Brainstormer. Empty owner_kind => owner ("" id), the single-operator default.
OWNER_KIND = os.environ.get("BRAINSTORMER_OWNER_KIND", "")
OWNER_ID = os.environ.get("BRAINSTORMER_OWNER_ID", "")


def api_call(method: str, path: str, body: dict | None = None) -> dict | list:
    url = f"{API_URL}/api{path}"
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"} if body else {}
    # Identify the caller so the backend can resolve the per-person owner and
    # apply read scoping. Mirrors the worker/commander MCP header dance.
    if SESSION_ID:
        headers["X-IVE-Session-Id"] = SESSION_ID
        # Session proof from the PTY env (see backend/session_proofs.py);
        # only when it belongs to the session this server speaks for.
        from os import environ as _environ
        _proof = _environ.get("COMMANDER_SESSION_PROOF", "")
        if _proof and (_environ.get("COMMANDER_SESSION_ID") or SESSION_ID) == SESSION_ID:
            headers["X-IVE-Session-Proof"] = _proof
        headers["X-IVE-Session-Type"] = SESSION_TYPE or "brainstormer-client"
    if WORKSPACE_ID:
        headers["X-IVE-Workspace-Id"] = WORKSPACE_ID
    # Owner pin for out-of-band callers (GI / external agent). The backend
    # treats these as advisory and still enforces its own owner guards.
    if OWNER_KIND:
        headers["X-IVE-Brainstormer-Owner-Kind"] = OWNER_KIND
    if OWNER_ID:
        headers["X-IVE-Brainstormer-Owner-Id"] = OWNER_ID
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raw = e.read().decode() if e.fp else str(e)
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


def _ws_id(args: dict) -> str:
    return (args.get("workspace_id") or WORKSPACE_ID or "").strip()


# ─── Tool implementations ────────────────────────────────────────────────

def tool_ask_brainstormer(args: dict) -> str:
    """Ask the per-person Brainstormer a question and get a SETTLED structured
    answer. Proxies the new /brainstormer/ask endpoint, which delivers the
    message to the owner's Brainstormer session and returns its reply once the
    turn settles (event/idle driven) — not a fragile terminal-buffer scrape."""
    ws_id = _ws_id(args)
    message = (args.get("message") or "").strip()
    if not ws_id:
        return json.dumps({"ok": False, "error": "workspace_id required"})
    if not message:
        return json.dumps({"ok": False, "error": "message required"})
    body = {"message": message}
    if args.get("timeout_secs") is not None:
        body["timeout_secs"] = args["timeout_secs"]
    result = api_call(
        "POST",
        f"/workspaces/{urllib.parse.quote(ws_id)}/brainstormer/ask",
        body,
    )
    return json.dumps(result, indent=2)


def tool_list_candidate_tickets(args: dict) -> str:
    """Read the brainstorm/intake candidate backlog — tickets the Brainstormer
    has shaped for later Commander/Planner routing. Read-only."""
    ws_id = _ws_id(args)
    if not ws_id:
        return json.dumps({"ok": False, "error": "workspace_id required"})
    status = (args.get("status_filter") or "all").strip()
    path = f"/tasks?workspace={urllib.parse.quote(ws_id)}"
    if status and status != "all":
        path += f"&status={urllib.parse.quote(status)}"
    result = api_call("GET", path)
    return json.dumps(result, indent=2)


def tool_get_candidate_ticket(args: dict) -> str:
    """Read one candidate/backlog ticket in full (description, acceptance
    criteria, labels, rationale). Read-only."""
    task_id = (args.get("task_id") or "").strip()
    if not task_id:
        return json.dumps({"ok": False, "error": "task_id required"})
    result = api_call("GET", f"/tasks/{urllib.parse.quote(task_id)}")
    return json.dumps(result, indent=2)


def tool_start_intake_research(args: dict) -> str:
    """Start a deep-research job for product intake. Returns a job id the
    caller can poll. This is an evidence-gathering action the Brainstormer
    system prompt authorizes — it does NOT dispatch implementation work."""
    ws_id = _ws_id(args)
    query = (args.get("query") or "").strip()
    if not ws_id:
        return json.dumps({"ok": False, "error": "workspace_id required"})
    if not query:
        return json.dumps({"ok": False, "error": "query required"})
    body = {"query": query, "workspace_id": ws_id}
    for key in ("model", "backend", "depth", "feature_tag"):
        if args.get(key):
            body[key] = args[key]
    result = api_call("POST", "/research/jobs", body)
    return json.dumps(result, indent=2)


def tool_trigger_observatory_scan(args: dict) -> str:
    """Trigger an observatory scan for market/ecosystem product signal. Backs
    the observatory action the Brainstormer system prompt authorizes. Fire-and-
    forget by default; the scan results land in the shared observatory store."""
    ws_id = _ws_id(args)
    if not ws_id:
        return json.dumps({"ok": False, "error": "workspace_id required"})
    body = {"workspace_id": ws_id}
    for key in ("source", "mode", "keywords"):
        if args.get(key) is not None:
            body[key] = args[key]
    result = api_call("POST", "/observatory/scan", body)
    return json.dumps(result, indent=2)


# ─── Interactive Canvas: annotation data layer ───────────────────────────
# Same MCP surface the Commander gets (mcp_server.py §Interactive Canvas), given
# to the Brainstormer because a brainstorm is exactly the session whose output
# should OUTLIVE the chat: the elements it argues about are graph elements, and
# an annotation pinned to one is a durable mark anyone opening the graph later
# sees. Proxies the same backend HTTP endpoints through this server's api_call
# (which carries the owner/session headers), so no new transport is introduced.
_CANVAS_ANNOTATION_KINDS = ("note", "box", "arrow", "highlight", "pen", "mark")


def tool_canvas_get_context(args: dict) -> str:
    """Read the structured annotation context a model reasons over for a canvas."""
    ws_id = _ws_id(args)
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
    ws_id = _ws_id(args)
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
    ws_id = _ws_id(args)
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


# ─── Tool registry ──────────────────────────────────────────────────────

TOOLS = {
    "ask_brainstormer": {
        "handler": tool_ask_brainstormer,
        "description": (
            "Ask the per-person Product Intake Brainstormer a question and get a "
            "SETTLED structured answer back. Use this to have the Brainstormer "
            "weigh whether something is worth building, challenge a premise, shape "
            "a candidate backlog item, or summarize intake evidence. The "
            "Brainstormer is an ANSWER endpoint only — it never implements, "
            "dispatches workers, or marks execution tasks done, so do NOT route "
            "implementation work through it."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "The question or intake prompt for the Brainstormer."},
                "workspace_id": {"type": "string", "description": "Workspace id. Defaults to the bound workspace."},
                "timeout_secs": {"type": "integer", "description": "Max seconds to wait for the settled reply (backend-clamped)."},
            },
            "required": ["message"],
        },
    },
    "list_candidate_tickets": {
        "handler": tool_list_candidate_tickets,
        "description": (
            "Read the brainstorm/intake candidate backlog — the shaped tickets the "
            "Brainstormer has filed for later Commander/Planner routing. Read-only; "
            "use status_filter to narrow (e.g. 'backlog')."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string", "description": "Workspace id. Defaults to the bound workspace."},
                "status_filter": {"type": "string", "description": "Filter by board status (e.g. 'backlog', 'todo'). Default: all."},
            },
        },
    },
    "get_candidate_ticket": {
        "handler": tool_get_candidate_ticket,
        "description": (
            "Read one candidate/backlog ticket in full — description, acceptance "
            "criteria, labels, rationale, risks. Read-only."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string", "description": "The candidate ticket id to read."},
            },
            "required": ["task_id"],
        },
    },
    "start_intake_research": {
        "handler": tool_start_intake_research,
        "description": (
            "Start a deep-research job for product intake evidence and return the "
            "job id to poll. This is an evidence-gathering action only — it does "
            "NOT dispatch implementation work."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to research."},
                "workspace_id": {"type": "string", "description": "Workspace id. Defaults to the bound workspace."},
                "model": {"type": "string", "description": "Provider-qualified model id."},
                "depth": {"type": "string"},
                "feature_tag": {"type": "string"},
            },
            "required": ["query"],
        },
    },
    "trigger_observatory_scan": {
        "handler": tool_trigger_observatory_scan,
        "description": (
            "Trigger an observatory scan for market/ecosystem product signal. "
            "Results land in the shared observatory store as intake evidence. "
            "Fire-and-forget; this is signal gathering, not work dispatch."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace_id": {"type": "string", "description": "Workspace id. Defaults to the bound workspace."},
                "source": {"type": "string", "description": "Optional single source (e.g. 'github', 'producthunt', 'hackernews'); omit or 'all' for all."},
                "mode": {"type": "string", "description": "Scan mode (default 'both')."},
                "keywords": {"type": "array", "items": {"type": "string"}, "description": "Optional keyword focus."},
            },
        },
    },
}

# Canvas tools registered separately (same semantics/schemas as the Commander's
# mcp_server.py) — a brainstorm should leave marks on the graph, not only in the
# transcript.
TOOLS["canvas_get_context"] = {
    "handler": tool_canvas_get_context,
    "description": (
        "Read the structured annotation context for an interactive canvas/graph. "
        "Returns {annotations:[{kind,target_id,text,color,author,coords}], "
        "highlighted_ids:[...]} — the human's element-anchored marks as DATA (not a "
        "screenshot) plus the distinct element ids that are highlighted or model-marked. "
        "Call this FIRST when brainstorming over a graph: it tells you what the human "
        "already pointed at, and what earlier sessions have already marked up."
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
        "DEPOSIT a durable mark on a graph element (author='model'); annotations render "
        "as pins on the canvas, so this is how a brainstorm outlives its transcript. "
        "Whenever you land on a judgement about a specific element — 'this is the "
        "bottleneck', 'this belongs to the other bounded context', 'candidate to delete' — "
        "anchor it here with target_id + text instead of only saying it. kind must be one "
        "of note|box|arrow|highlight|pen|mark; use 'note' for a written judgement. For "
        "lighting up several elements at once, prefer canvas_highlight."
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
        "Light up the graph elements the current brainstorm thread is ABOUT — records a "
        "highlight annotation per element id (author='model') so the viewer shows them "
        "marked. Use it as you name a cluster ('these four services are the blast "
        "radius') so the human's canvas keeps up with the discussion. Returns the count "
        "recorded."
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


# ─── MCP Protocol (simplified stdio) ─────────────────────────────────────

def handle_jsonrpc(request: dict) -> dict | None:
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
                "serverInfo": {"name": "brainstormer", "version": "1.0.0"},
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
    install("brainstormer")
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
