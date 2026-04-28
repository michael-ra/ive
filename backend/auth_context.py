"""Single source of truth for "who is making this request, in what mode?"

`resolve_auth(request)` is called by the auth middleware and (separately)
by the WebSocket upgrade handler. It returns an AuthContext or None.
None means the caller failed auth and should be 401'd / closed.

Resolution order:
  1. Localhost (and not tunnel-forwarded) → trusted owner_legacy / Full.
  2. ive_session cookie (or Authorization: Bearer) → joiner_sessions row
     lookup with sliding TTL.
  3. ive_token cookie / ?token= / Bearer matching AUTH_TOKEN → owner_legacy
     / Full. (Compatibility with the pre-overhaul login form.)
  4. Otherwise → None.

PR 3 reads `mode` and `brief_subscope` to enforce route guards and PTY
flag injection. PR 5 reads `actor_kind` to mark mobile-only sessions.
"""
from __future__ import annotations

import hmac
from dataclasses import dataclass
from typing import Optional

import joiner_sessions

# Cookie name for per-row joiner sessions (PR 2). The legacy AUTH_TOKEN
# cookie is still 'ive_token' and remains supported for backwards compat.
SESSION_COOKIE = "ive_session"
LEGACY_COOKIE = "ive_token"


@dataclass
class AuthContext:
    actor_kind: str           # 'owner_legacy' | 'owner_device' | 'joiner_session' | 'localhost' | 'hook'
    actor_id: Optional[str]   # joiner_sessions.id when applicable; None for localhost/legacy
    mode: str                 # 'brief' | 'code' | 'full'
    brief_subscope: Optional[str]
    label: Optional[str]
    expires_at: Optional[str]
    device_id: Optional[str] = None
    invite_id: Optional[str] = None

    @property
    def is_owner(self) -> bool:
        return self.actor_kind in ("owner_legacy", "owner_device", "localhost", "hook")

    @property
    def is_full(self) -> bool:
        return self.mode == "full"


_LOCALHOST_ADDRS = {"127.0.0.1", "::1", "localhost"}
_CF_FORWARD_HEADERS = ("Cf-Connecting-Ip", "Cf-Ray", "Cf-Connecting-IPv6")


def _tokens_equal(a: str | None, b: str | None) -> bool:
    if not a or not b:
        return False
    try:
        return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))
    except (AttributeError, TypeError):
        return False


def _is_real_localhost(request, tunnel_mode: bool) -> bool:
    peername = request.transport.get_extra_info("peername") if request.transport else None
    remote_ip = peername[0] if peername else "unknown"
    if remote_ip not in _LOCALHOST_ADDRS:
        return False
    if tunnel_mode and any(request.headers.get(h) for h in _CF_FORWARD_HEADERS):
        return False
    return True


async def resolve_auth(request, *, auth_token: str | None, tunnel_mode: bool) -> Optional[AuthContext]:
    """Resolve the AuthContext for an HTTP/WS request.

    Returns None if the request fails auth. Returns an AuthContext otherwise.
    Sliding TTL is bumped as a side effect when a joiner_session matches.
    """
    # 1. Localhost trust (preserved so the bootstrap CLI banner + MCP
    #    sub-processes always work even if all paired devices are gone).
    if not auth_token or _is_real_localhost(request, tunnel_mode):
        return AuthContext(
            actor_kind="localhost" if auth_token else "owner_legacy",
            actor_id=None,
            mode="full",
            brief_subscope=None,
            label=None,
            expires_at=None,
        )

    peername = request.transport.get_extra_info("peername") if request.transport else None
    remote_ip = peername[0] if peername else None
    user_agent = request.headers.get("User-Agent")

    # 2. ive_session cookie or Bearer header → per-row joiner session.
    bearer = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    cookie_value = request.cookies.get(SESSION_COOKIE) or bearer
    if cookie_value:
        sess = await joiner_sessions.lookup(
            cookie_value,
            slide=True,
            last_ip=remote_ip,
            last_user_agent=user_agent,
        )
        if sess:
            return AuthContext(
                actor_kind=sess.actor_kind,
                actor_id=sess.id,
                mode=sess.mode,
                brief_subscope=sess.brief_subscope,
                label=sess.label,
                expires_at=sess.expires_at,
                device_id=sess.device_id,
                invite_id=sess.invite_id,
            )

    # 3. Legacy ive_token cookie / ?token= / Bearer == AUTH_TOKEN.
    legacy = (
        request.cookies.get(LEGACY_COOKIE)
        or request.query.get("token")
        or bearer  # bearer might be the legacy token
    )
    if _tokens_equal(legacy, auth_token):
        return AuthContext(
            actor_kind="owner_legacy",
            actor_id=None,
            mode="full",
            brief_subscope=None,
            label="Owner (legacy token)",
            expires_at=None,
        )

    return None
