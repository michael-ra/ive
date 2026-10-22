"""Single source of truth for "who is making this request, in what mode?"

`resolve_auth(request)` is called by the auth middleware and (separately)
by the WebSocket upgrade handler. It returns an AuthContext or None.
None means the caller failed auth and should be 401'd / closed.

Resolution order:
  1. Direct localhost (only outside external-proxy mode) → trusted / Full.
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
import ipaddress
import re
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
    workspace_id: Optional[str] = None

    @property
    def is_owner(self) -> bool:
        return self.actor_kind in ("owner_legacy", "owner_device", "localhost", "hook")

    @property
    def is_full(self) -> bool:
        return self.mode == "full"


_LOCALHOST_ADDRS = {"127.0.0.1", "::1", "localhost"}
_HEADER_NAME_RE = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+")


@dataclass(frozen=True)
class ProxyTrustConfig:
    """Explicit proxy boundary: mode, trusted socket peers, and accepted headers."""

    external_proxy: bool = False
    trusted_proxy_peers: tuple[
        ipaddress.IPv4Network | ipaddress.IPv6Network, ...
    ] = ()
    forwarded_headers: tuple[str, ...] = ()

    @classmethod
    def from_values(
        cls,
        *,
        external_proxy: bool = False,
        trusted_proxy_peers: tuple[str, ...] | list[str] = (),
        forwarded_headers: tuple[str, ...] | list[str] = (),
    ) -> "ProxyTrustConfig":
        peers = tuple(
            ipaddress.ip_network(value.strip(), strict=False)
            for value in trusted_proxy_peers
            if value.strip()
        )
        headers: list[str] = []
        seen: set[str] = set()
        for value in forwarded_headers:
            header = value.strip()
            if not header or not _HEADER_NAME_RE.fullmatch(header):
                raise ValueError(f"invalid trusted proxy header: {value!r}")
            lowered = header.lower()
            if lowered not in seen:
                seen.add(lowered)
                headers.append(header)
        return cls(
            external_proxy=external_proxy,
            trusted_proxy_peers=peers,
            forwarded_headers=tuple(headers),
        )

    def with_external_proxy(self, enabled: bool) -> "ProxyTrustConfig":
        return ProxyTrustConfig(
            external_proxy=enabled,
            trusted_proxy_peers=self.trusted_proxy_peers,
            forwarded_headers=self.forwarded_headers,
        )


def _tokens_equal(a: str | None, b: str | None) -> bool:
    if not a or not b:
        return False
    try:
        return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))
    except (AttributeError, TypeError):
        return False


def _socket_peer_ip(request) -> str | None:
    peername = request.transport.get_extra_info("peername") if request.transport else None
    return peername[0] if peername else None


def _peer_is_trusted_proxy(peer_ip: str | None, config: ProxyTrustConfig) -> bool:
    if not peer_ip:
        return False
    try:
        address = ipaddress.ip_address(peer_ip)
    except ValueError:
        return False
    return any(address in network for network in config.trusted_proxy_peers)


def _is_real_localhost(request, proxy_config: ProxyTrustConfig) -> bool:
    """Return True only for a direct local socket in direct-local mode."""
    remote_ip = _socket_peer_ip(request)
    return bool(
        remote_ip in _LOCALHOST_ADDRS
        and not proxy_config.external_proxy
    )


def forwarded_value(
    request, proxy_config: ProxyTrustConfig, header_name: str
) -> str | None:
    """Read one configured forwarded header only from a trusted socket peer."""
    if not _peer_is_trusted_proxy(_socket_peer_ip(request), proxy_config):
        return None
    if header_name.lower() not in {
        header.lower() for header in proxy_config.forwarded_headers
    }:
        return None
    value = request.headers.get(header_name)
    return value.strip() if value and value.strip() else None


def is_forwarded_request(request, proxy_config: ProxyTrustConfig) -> bool:
    if not _peer_is_trusted_proxy(_socket_peer_ip(request), proxy_config):
        return False
    return any(request.headers.get(header) for header in proxy_config.forwarded_headers)


def client_ip(request, proxy_config: ProxyTrustConfig) -> str | None:
    if _peer_is_trusted_proxy(_socket_peer_ip(request), proxy_config):
        for header in proxy_config.forwarded_headers:
            value = request.headers.get(header)
            if not value:
                continue
            candidate = value.split(",", 1)[0].strip()
            try:
                return str(ipaddress.ip_address(candidate))
            except ValueError:
                continue
    return _socket_peer_ip(request)


async def resolve_auth(
    request,
    *,
    auth_token: str | None,
    proxy_config: ProxyTrustConfig,
) -> Optional[AuthContext]:
    """Resolve authentication using one explicit proxy trust boundary."""
    # Direct-local trust remains the single-user default. External proxy mode
    # disables it even when the backend socket peer itself is loopback.
    if not auth_token:
        if proxy_config.external_proxy:
            return None
        return AuthContext(
            actor_kind="owner_legacy",
            actor_id=None,
            mode="full",
            brief_subscope=None,
            label=None,
            expires_at=None,
        )
    if _is_real_localhost(request, proxy_config):
        return AuthContext(
            actor_kind="localhost",
            actor_id=None,
            mode="full",
            brief_subscope=None,
            label=None,
            expires_at=None,
        )

    remote_ip = client_ip(request, proxy_config)
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
                workspace_id=sess.workspace_id,
            )

    # 3. Legacy ive_token cookie / ?token= / Bearer == AUTH_TOKEN.
    # Only for a loopback socket peer outside external-proxy mode. The master
    # token never grants a remote (LAN/tunnel) caller access directly: the
    # token-link and form-login exchanges in server.py mint a revocable
    # joiner session instead, so every remote credential can be revoked.
    if (
        not proxy_config.external_proxy
        and _socket_peer_ip(request) in _LOCALHOST_ADDRS
    ):
        legacy = (
            request.cookies.get(LEGACY_COOKIE)
            or request.query.get("token")
            or bearer
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
