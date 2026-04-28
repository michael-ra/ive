"""Mode-aware route guards.

`@requires_mode("code", "full")` blocks request handlers when the
AuthContext attached by `token_auth_middleware` doesn't match an allowed
mode. Owner-equivalent contexts (localhost, owner_legacy, owner_device,
hook) are always allowed regardless of declared mode — the mode bound to
the AuthContext is what's enforced for joiner_sessions.

The decorator emits a `MODE_VIOLATION_BLOCKED` event so owners see blocks
in real time in the activity feed.
"""
from __future__ import annotations

import asyncio
import functools
import logging
from typing import Iterable

from aiohttp import web

logger = logging.getLogger(__name__)


def _emit_violation(request, ctx, *, allowed_modes: Iterable[str]) -> None:
    try:
        from event_bus import bus
        from commander_events import CommanderEvent
        coro = bus.emit(
            CommanderEvent.MODE_VIOLATION_BLOCKED,
            payload={
                "path": request.path,
                "method": request.method,
                "actor_kind": ctx.actor_kind,
                "actor_id": ctx.actor_id,
                "mode": ctx.mode,
                "allowed_modes": list(allowed_modes),
                "label": ctx.label,
            },
        )
        # Fire-and-forget — handler is sync; bus.emit is async.
        asyncio.create_task(coro)
    except Exception as e:
        logger.warning("MODE_VIOLATION_BLOCKED emit failed: %s", e)


def requires_mode(*allowed: str):
    """Block the handler unless ctx.mode is in `allowed` OR ctx.is_owner.

    Joiner sessions bound to a mode are clamped — owner-equivalent
    actors (localhost, owner_legacy, owner_device, hook) bypass the
    mode check because they're already trusted with full access.
    """
    allowed_set = set(allowed)

    def _decorate(handler):
        @functools.wraps(handler)
        async def _wrapped(request: web.Request, *args, **kwargs):
            ctx = request.get("auth")
            if ctx is None:
                # Middleware always attaches; if missing, treat as
                # owner-equivalent (hooks, tests, no-auth boot) and allow.
                return await handler(request, *args, **kwargs)
            if ctx.is_owner:
                return await handler(request, *args, **kwargs)
            if ctx.mode in allowed_set:
                return await handler(request, *args, **kwargs)
            _emit_violation(request, ctx, allowed_modes=allowed_set)
            return web.json_response(
                {
                    "error": "Mode not allowed for this action.",
                    "your_mode": ctx.mode,
                    "required": sorted(allowed_set),
                },
                status=403,
            )
        return _wrapped
    return _decorate


def block_for_brief(handler):
    """Convenience: block Brief joiners, allow Code + Full."""
    return requires_mode("code", "full")(handler)


def owner_only(handler):
    """Convenience: only owners (legacy/device/localhost/hook) — no Full joiner."""
    @functools.wraps(handler)
    async def _wrapped(request: web.Request, *args, **kwargs):
        ctx = request.get("auth")
        if ctx is None or ctx.is_owner:
            return await handler(request, *args, **kwargs)
        _emit_violation(request, ctx, allowed_modes=["owner_only"])
        return web.json_response(
            {"error": "Owner-only action.", "your_mode": ctx.mode},
            status=403,
        )
    return _wrapped
