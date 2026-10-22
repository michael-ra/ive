"""Lean request correlation shared by IVE HTTP and executor seams.

The module deliberately does only three things: normalize/mint request IDs,
propagate ``X-Request-Id`` on outbound calls, and add the grep-friendly
``req=<id>`` token to log records created inside a correlated context.
"""
from __future__ import annotations

import contextvars
import functools
import logging
import re
import uuid
from contextlib import contextmanager
from typing import Any, Iterator, Mapping, Optional


HEADER = "X-Request-Id"
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_request_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "ive_request_id", default=None
)


def normalize_request_id(value: Any) -> Optional[str]:
    """Return a bounded log/header-safe request ID, or ``None``."""
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    return candidate if _SAFE_ID.fullmatch(candidate) else None


def current_request_id() -> Optional[str]:
    return _request_id.get()


def ensure_request_id(value: Any = None) -> str:
    """Adopt ``value``, reuse the active ID, or mint a compact UUID."""
    request_id = normalize_request_id(value) or current_request_id()
    if request_id is None:
        request_id = uuid.uuid4().hex
    _request_id.set(request_id)
    return request_id


def adopt_request_id(value: Any, request: Any = None) -> str:
    """Bind an ID discovered after middleware entry (for example in JSON)."""
    request_id = ensure_request_id(value)
    if request is not None:
        try:
            request["request_id"] = request_id
        except (KeyError, TypeError, AttributeError):
            pass
    return request_id


def request_headers(
    headers: Optional[Mapping[str, str]] = None,
    *,
    request_id: Any = None,
) -> dict[str, str]:
    """Copy headers and attach the active/minted correlation ID."""
    out = dict(headers or {})
    out[HEADER] = ensure_request_id(request_id)
    return out


@contextmanager
def request_context(value: Any = None) -> Iterator[str]:
    request_id = normalize_request_id(value) or uuid.uuid4().hex
    token = _request_id.set(request_id)
    try:
        yield request_id
    finally:
        _request_id.reset(token)


def correlated_envelope(fn):
    """Run an async ``(db, envelope, ...)`` function in its envelope context."""
    @functools.wraps(fn)
    async def wrapped(db, envelope, *args, **kwargs):
        if isinstance(envelope, Mapping):
            value = envelope.get("request_id")
        else:
            value = getattr(envelope, "request_id", None)
        with request_context(value):
            return await fn(db, envelope, *args, **kwargs)

    return wrapped


class RequestCorrelationFilter(logging.Filter):
    """Prefix correlated records without changing global log formatting."""
    def filter(self, record: logging.LogRecord) -> bool:
        request_id = current_request_id()
        if not request_id:
            return True
        message = record.getMessage()
        token = f"req={request_id}"
        if token not in message:
            record.msg = f"{token} {message}"
            record.args = ()
        return True


_FILTER = RequestCorrelationFilter()


def install_log_filter() -> None:
    """Attach the correlation filter idempotently to current root handlers."""
    for handler in logging.getLogger().handlers:
        if not any(isinstance(item, RequestCorrelationFilter) for item in handler.filters):
            handler.addFilter(_FILTER)
