"""Peer communication helpers for worker/commander MCP servers.

Provides:
  • `post_peer_message`     — wrap REST POST /workspaces/{id}/peer-messages
                              with the new `blocking` / `in_reply_to` fields.
  • `wait_for_reply`        — synchronous polling until a reply arrives or
                              the timeout elapses. Used by `blocking_bulletin`.
  • `myelin_*`              — optional legacy wrappers supplied by the separately
                              installed SwarmLock extension. Without it these
                              report unavailable; messaging still works.

These helpers are intentionally storage-agnostic: they call the local REST
API (which the MCP servers already have configured via COMMANDER_API_URL)
and never touch sqlite directly. Keeping the abstraction at the HTTP layer
means we don't have to thread async DB pools through the MCP stdio loop.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


# ─── REST helper (thin wrapper, mirrors the one in each MCP server) ─────

def _api_call(api_url: str, method: str, path: str, body: dict | None = None) -> Any:
    url = f"{api_url}/api{path}"
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


# ─── Peer message primitives ────────────────────────────────────────────

def post_peer_message(
    api_url: str,
    workspace_id: str,
    from_session_id: str,
    content: str,
    *,
    to: str = "all",
    topic: str = "general",
    priority: str = "info",
    blocking: bool = False,
    in_reply_to: str | None = None,
    files: list[str] | None = None,
) -> dict:
    """POST a peer message. `to` is encoded into topic for now (recipient
    routing isn't a first-class column — workers filter their bulletin feed
    by topic, so we tag the recipient as `topic=to:<id>` when not 'all').

    Returns the created message row (or {"error": ...}).
    """
    effective_topic = topic
    if to and to != "all":
        # Prefix recipient so the receiving side can filter quickly without
        # needing a new column. Original topic is preserved as a suffix.
        effective_topic = f"to:{to}|{topic}"

    body = {
        "from_session_id": from_session_id,
        "topic": effective_topic,
        "content": content,
        "priority": priority,
        "files": files or [],
        "blocking": 1 if blocking else 0,
    }
    if in_reply_to:
        body["in_reply_to"] = in_reply_to
    return _api_call(api_url, "POST", f"/workspaces/{workspace_id}/peer-messages", body)


def wait_for_reply(
    api_url: str,
    workspace_id: str,
    bulletin_id: str,
    timeout_secs: int = 600,
    poll_interval: float = 2.0,
) -> dict | None:
    """Block until a peer posts a message with `in_reply_to == bulletin_id`,
    or until `timeout_secs` elapses.

    Returns the reply message dict on success, None on timeout.

    Polls the bulletin board endpoint at `poll_interval` seconds. The MCP
    stdio loop is single-threaded so this WILL block the worker — that's
    by design (the agent is supposed to pause).
    """
    deadline = time.time() + max(1, timeout_secs)
    seen_ids: set[str] = set()

    while time.time() < deadline:
        # Fetch recent messages — bulletin endpoint returns newest first.
        msgs = _api_call(api_url, "GET", f"/workspaces/{workspace_id}/peer-messages")
        if isinstance(msgs, list):
            for m in msgs:
                mid = m.get("id")
                if not mid or mid in seen_ids:
                    continue
                seen_ids.add(mid)
                if m.get("in_reply_to") == bulletin_id:
                    return m
        # Sleep before next poll. Keep poll_interval coarse — agents that
        # ask blocking questions are fine waiting a couple seconds.
        time.sleep(poll_interval)

    return None


# ─── Optional legacy extension adapters (no semantic implementation) ───

from extension_host import (
    ExtensionUnavailable as _ExtensionUnavailable,
    available as _extension_available,
    load_legacy_namespace as _load_extension_namespace,
)


def _unavailable_coordination(*args, **kwargs) -> dict:
    return {"available": False, "reason": "SwarmLock extension is not installed or enabled"}


myelin_check_overlap = _unavailable_coordination
myelin_acquire = _unavailable_coordination
myelin_release = _unavailable_coordination
myelin_peers = _unavailable_coordination


def _try_import_myelin() -> bool:
    return False


def _ensure_myelin_path() -> None:
    raise _ExtensionUnavailable("myelin")


class _LocalHashEmbedding:
    def __init__(self, *args, **kwargs):
        raise _ExtensionUnavailable("myelin")


if _extension_available("myelin"):
    _load_extension_namespace(globals(), "myelin", "backend/peer_memory.py")

if _extension_available("swarmlock"):
    _load_extension_namespace(globals(), "swarmlock", "backend/peer_coordination.py")
