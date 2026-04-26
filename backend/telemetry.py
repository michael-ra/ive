"""Minimal, transparent telemetry for IVE beta.

Sends anonymous pings to PostHog on startup + daily heartbeat so the
operator can see how many unique installs are active.  Zero PII.

Data sent per event:
    - distinct_id : SHA-256 of platform identifiers (not the raw values)
    - version     : IVE version string
    - platform    : e.g. "darwin-arm64"
    - sessions    : number of sessions in DB (engagement signal)
    - uptime_hrs  : hours since this process started

Opt-out:
    IVE_TELEMETRY=off  (env var)
"""

import asyncio
import hashlib
import json
import logging
import os
import platform
import time
import urllib.request
import urllib.error

logger = logging.getLogger("ive.telemetry")

_start_time = time.time()
_heartbeat_task = None
_HEARTBEAT_INTERVAL = 86400  # 24 hours

POSTHOG_API_KEY = "phc_s9qSEgbhfWNpsRshe44khbMCLpXSH7MCWxYPZhKYHyDx"
POSTHOG_HOST = "https://us.i.posthog.com"


def _machine_id() -> str:
    raw = f"{platform.node()}-{platform.machine()}-{platform.processor()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _platform_tag() -> str:
    return f"{platform.system().lower()}-{platform.machine()}"


def _build_payload(event: str, session_count: int = 0) -> dict:
    from config import VERSION
    return {
        "api_key": POSTHOG_API_KEY,
        "event": f"ive_{event}",
        "distinct_id": _machine_id(),
        "properties": {
            "version": VERSION,
            "platform": _platform_tag(),
            "sessions": session_count,
            "uptime_hrs": round((time.time() - _start_time) / 3600, 1),
            "$lib": "ive-server",
        },
    }


def _is_enabled() -> bool:
    flag = os.getenv("IVE_TELEMETRY", "on").lower()
    return flag not in ("off", "false", "0", "no")


async def _get_session_count() -> int:
    try:
        from db import get_db
        db = await get_db()
        try:
            row = await db.execute_fetchone("SELECT COUNT(*) FROM sessions")
            return row[0] if row else 0
        finally:
            await db.close()
    except Exception:
        return 0


async def _send(payload: dict):
    url = f"{POSTHOG_HOST}/capture/"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        await asyncio.to_thread(urllib.request.urlopen, req, timeout=5)
        logger.debug("Telemetry %s sent", payload["event"])
    except (urllib.error.URLError, OSError, TimeoutError):
        logger.debug("Telemetry ping failed (non-fatal)")


async def ping(event: str = "startup"):
    if not _is_enabled():
        return
    count = await _get_session_count()
    payload = _build_payload(event, count)
    logger.info(
        "Telemetry %s (mid=%s v=%s p=%s sessions=%d)",
        event, payload["distinct_id"], payload["properties"]["version"],
        payload["properties"]["platform"], count,
    )
    await _send(payload)


async def _heartbeat_loop():
    while True:
        await asyncio.sleep(_HEARTBEAT_INTERVAL)
        await ping("heartbeat")


def start_background():
    global _heartbeat_task
    if not _is_enabled():
        return
    _heartbeat_task = asyncio.ensure_future(_heartbeat_coroutine())


async def _heartbeat_coroutine():
    await ping("startup")
    await _heartbeat_loop()


async def report_error(error_type: str, message: str, context: str = ""):
    """Report a crash or error to PostHog. Fire-and-forget."""
    if not _is_enabled():
        return
    from config import VERSION
    payload = {
        "api_key": POSTHOG_API_KEY,
        "event": "ive_error",
        "distinct_id": _machine_id(),
        "properties": {
            "version": VERSION,
            "platform": _platform_tag(),
            "error_type": error_type,
            "message": message[:500],
            "context": context[:200],
            "uptime_hrs": round((time.time() - _start_time) / 3600, 1),
            "$lib": "ive-server",
        },
    }
    await _send(payload)


def report_error_sync(error_type: str, message: str, context: str = ""):
    """Sync wrapper for reporting errors outside async context."""
    if not _is_enabled():
        return
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(report_error(error_type, message, context))
    except RuntimeError:
        pass  # no event loop — can't report


def stop():
    global _heartbeat_task
    if _heartbeat_task:
        _heartbeat_task.cancel()
        _heartbeat_task = None
