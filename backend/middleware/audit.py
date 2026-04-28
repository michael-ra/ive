"""Audit log middleware.

Records every authenticated mutating request (POST/PUT/DELETE/PATCH) to
the `audit_log` table so the owner can answer "what did joiner X actually
do, and from where?" — and revoke them based on real evidence rather
than mode + label alone.

Skipped paths: WebSocket upgrades, hook ingestion, owner-equivalent
self-introspection (`/api/whoami`), and other high-volume read-only or
pre-auth endpoints. The middleware never raises — failure to log must
not break a request.
"""
from __future__ import annotations

import json
import uuid
from typing import Optional

from aiohttp import web

from db import get_db


_SKIP_PATH_PREFIXES = (
    "/ws",
    "/preview/",
    "/screenshot",
    "/sw.js",
    "/manifest.webmanifest",
    "/api/hooks/",          # noisy CLI hook stream — separate event_bus already covers it
    "/api/whoami",
    "/api/observatory/findings",  # polled UI status
)

_SKIP_EXACT = {
    "/auth",
    "/join",
    "/api/invite/redeem",
}

_AUDITED_METHODS = {"POST", "PUT", "DELETE", "PATCH"}


def _should_audit(request: web.Request) -> bool:
    if request.method not in _AUDITED_METHODS:
        return False
    p = request.path
    if p in _SKIP_EXACT:
        return False
    for prefix in _SKIP_PATH_PREFIXES:
        if p.startswith(prefix):
            return False
    return True


def _peer_ip(request: web.Request) -> Optional[str]:
    fwd = request.headers.get("Cf-Connecting-Ip") or request.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
    peername = request.transport.get_extra_info("peername") if request.transport else None
    return peername[0] if peername else None


def _summary_for(request: web.Request, status: int) -> str:
    """Tiny JSON blob describing the action — keeps audit row inspectable
    without storing the full request body (which could be huge)."""
    parts = {}
    # Capture path-id parameters (router info is post-resolution)
    match_info = request.match_info
    if match_info:
        ids = {k: v for k, v in match_info.items() if k in ("id", "task_id", "session_id", "workspace_id")}
        if ids:
            parts["params"] = ids
    if request.query:
        q = {k: v for k, v in request.query.items() if k not in ("token",)}
        if q:
            parts["query"] = q
    parts["status"] = status
    try:
        return json.dumps(parts, separators=(",", ":"))[:500]
    except (TypeError, ValueError):
        return ""


@web.middleware
async def audit_middleware(request: web.Request, handler):
    # Run handler first — we want the response status in the row.
    response = await handler(request)
    try:
        if not _should_audit(request):
            return response
        ctx = request.get("auth")
        # When AUTH_TOKEN is unset, token_auth_middleware isn't installed
        # and request["auth"] is never populated. Treat that as the
        # "single-user local dev" owner_legacy case so we still get a log.
        if ctx is None:
            class _Synth:
                actor_kind = "owner_legacy"
                actor_id = None
                label = None
                mode = "full"
            ctx = _Synth()
        # Owner-legacy on localhost is the common case; we still log it
        # so the audit panel can show owner activity for symmetry, but
        # callers can filter via ?actor_kind=joiner_session.
        status = getattr(response, "status", 0) or 0
        # Don't log auth failures — those are a separate signal (and the
        # auth middleware already rejected before reaching here usually).
        if status in (401, 403):
            # Mode-violation 403s ARE worth logging — they're the
            # signal that a joiner *tried* to do something they couldn't.
            pass
        ip = _peer_ip(request)
        ua = request.headers.get("User-Agent")
        db = await get_db()
        try:
            await db.execute(
                """
                INSERT INTO audit_log
                    (id, actor_kind, actor_id, actor_label, mode,
                     method, path, status, ip, user_agent, summary)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    ctx.actor_kind,
                    ctx.actor_id,
                    ctx.label,
                    ctx.mode,
                    request.method,
                    request.path,
                    status,
                    ip,
                    ua,
                    _summary_for(request, status),
                ),
            )
            await db.commit()
        finally:
            await db.close()
    except Exception:
        # Audit must never break a request. Swallow.
        pass
    return response
