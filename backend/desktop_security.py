"""Browser boundary for the packaged app's private loopback backend."""
from __future__ import annotations

import os
import ipaddress
from urllib.parse import urlsplit

from aiohttp import web


_TRANSPORT = web.RequestKey("ive.desktop_transport", str)
_FORWARDING_HEADERS = {"forwarded", "cf-connecting-ip", "cf-ray", "cf-visitor", "true-client-ip", "x-real-ip"}


def desktop_proxy_config(request, config):
    """Apply only the transport classification made by the desktop guard.

    HTTP headers cannot set this internal key. A proven direct Mac request
    stays local when tunnel mode is on; a tunnel request never inherits the
    proxy socket's localhost privileges, including while a tunnel stops.
    """
    transport = request.get(_TRANSPORT)
    if transport in ("local", "tunnel"):
        return config.with_external_proxy(transport == "tunnel")
    return config


def _tunnel_origin(get_tunnel_url):
    if get_tunnel_url is None:
        return None
    try:
        raw = get_tunnel_url()
        if not isinstance(raw, str):
            return None
        parts = urlsplit(raw)
        if (parts.scheme != "https" or not parts.hostname or parts.username
                or parts.password or parts.query or parts.fragment
                or parts.path not in ("", "/") or parts.port not in (None, 443)):
            return None
        return f"https://{parts.netloc.lower()}"
    except (ValueError, TypeError):
        return None


def _loopback_peer(request):
    try:
        peer = request.transport.get_extra_info("peername") if request.transport else None
        return bool(peer and ipaddress.ip_address(peer[0]).is_loopback)
    except (ValueError, TypeError):
        return False


def _has_forwarding_headers(request):
    return any(name.lower().startswith("x-forwarded-") or name.lower() in _FORWARDING_HEADERS
               for name in request.headers)


def _cloudflare_headers_valid(request):
    clients = request.headers.getall("Cf-Connecting-Ip", [])
    schemes = request.headers.getall("X-Forwarded-Proto", [])
    if len(clients) != 1 or schemes != ["https"]:
        return False
    try:
        ipaddress.ip_address(clients[0])
        return True
    except ValueError:
        return False


def create_desktop_origin_guard(port: int, *, get_tunnel_url=None):
    """Restrict desktop browser traffic without changing the web/server edition.

    Local MCP and hook processes do not send Origin. They still need the exact
    bound Host, preventing a rebinding hostname from receiving localhost trust.
    Browser Origin checks run before CORS, authentication and WebSocket upgrade.
    A live IVE-owned HTTPS tunnel is an additional, exact transport boundary;
    allowing it through here never bypasses cookie, pairing, PIN or role checks.
    """
    enabled = bool(os.environ.get("IVE_DESKTOP_INSTANCE"))
    expected_host = f"127.0.0.1:{int(port)}"
    expected_origin = f"http://{expected_host}"

    @web.middleware
    async def desktop_origin_guard(request: web.Request, handler):
        if enabled:
            hosts = request.headers.getall("Host", [])
            origins = request.headers.getall("Origin", [])
            if not _loopback_peer(request) or len(hosts) != 1:
                return web.json_response(
                    {"error": "This desktop backend only accepts its local app address.",
                     "code": "desktop_host_rejected"}, status=403,
                )
            if hosts[0] == expected_host and not _has_forwarding_headers(request):
                if origins and origins != [expected_origin]:
                    return web.json_response(
                        {"error": "This browser origin cannot access the desktop backend.",
                         "code": "desktop_origin_rejected"}, status=403,
                    )
                request[_TRANSPORT] = "local"
                return await handler(request)

            tunnel_origin = _tunnel_origin(get_tunnel_url)
            if (not tunnel_origin or hosts[0] != tunnel_origin.removeprefix("https://")
                    or not _cloudflare_headers_valid(request)):
                return web.json_response(
                    {"error": "This desktop backend only accepts its local app or active tunnel address.",
                     "code": "desktop_host_rejected"}, status=403,
                )
            # A top-level navigation/script GET has no Origin. State-changing
            # fetches and WebSocket handshakes from the iOS webview do have one.
            needs_origin = (request.method not in ("GET", "HEAD")
                            or request.headers.get("Upgrade", "").lower() == "websocket")
            if (origins and origins != [tunnel_origin]) or (needs_origin and not origins):
                return web.json_response(
                    {"error": "This browser origin cannot access the desktop backend.",
                     "code": "desktop_origin_rejected"}, status=403,
                )
            request[_TRANSPORT] = "tunnel"
        return await handler(request)

    return desktop_origin_guard
