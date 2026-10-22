"""Content Security Policy middleware.

Applies a moderately strict CSP to IVE-served HTML. The preview proxy
intentionally serves *third-party* dev servers and must stay CSP-free,
so we skip those paths.
"""
from __future__ import annotations

from aiohttp import web

# Style is allowed inline because Vite + Tailwind injects scoped styles
# at build time and at runtime via xterm.js. Tightening that is deferred.
CSP_HEADER = "; ".join([
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' wss: ws:",
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
])

# Always-applied minor headers — cheap defenses worth turning on
# unconditionally even when CSP is skipped (preview-proxy paths).
ALWAYS_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
}

# Subset applied to the preview-proxy and screenshot paths. We deliberately
# DROP X-Frame-Options: DENY here because the IVE main page embeds
# `/preview/<port>/...` in an iframe (LivePreview) — DENY would break that
# even on same-origin. We replace it with SAMEORIGIN so the iframe works
# but the proxied dev server still can't be framed by random sites.
PREVIEW_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "SAMEORIGIN",
    "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
}


def _csp_exempt(request: web.Request) -> bool:
    """Skip CSP on preview proxy (it serves arbitrary user dev servers)."""
    p = request.path
    return p.startswith("/preview/") or p.startswith("/screenshot")


@web.middleware
async def csp_middleware(request: web.Request, handler):
    response = await handler(request)
    try:
        is_preview = _csp_exempt(request)
        # On the preview path, force-overwrite X-Frame-Options/CSP because
        # the upstream dev server may have sent its own DENY/strict CSP
        # which would block our iframe even though it's same-origin.
        if is_preview:
            for k, v in PREVIEW_HEADERS.items():
                response.headers[k] = v
            # Strip any frame-ancestors-bearing CSP the dev server emitted.
            if "Content-Security-Policy" in response.headers:
                del response.headers["Content-Security-Policy"]
            if "Content-Security-Policy-Report-Only" in response.headers:
                del response.headers["Content-Security-Policy-Report-Only"]
        else:
            for k, v in ALWAYS_HEADERS.items():
                response.headers.setdefault(k, v)
            response.headers.setdefault("Content-Security-Policy", CSP_HEADER)
    except (AttributeError, TypeError):
        # Some response types (e.g. WebSocketResponse) may have read-only
        # headers; nothing to do in that case.
        pass
    return response
