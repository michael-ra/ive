"""Live browser preview via Playwright CDP screencast.

Manages a shared Chromium instance with per-preview pages. Multiple peers
can subscribe to the same preview (keyed by share_key, e.g. workspace+port)
and receive frames in parallel. One subscriber at a time holds the *driver*
role and can dispatch input / navigate / resize. When a preview's
subscriber count reaches zero it is torn down after a short grace period
(handles flaky networks and quick reloads without thrashing Chromium).
"""
import asyncio
import logging
import os
import re
from typing import Callable, Optional, Awaitable
import uuid

log = logging.getLogger(__name__)

_playwright = None
_browser = None
_previews: dict[str, dict] = {}
_keys_to_pid: dict[str, str] = {}
# Seconds to wait between "last subscriber left" and tearing the page down.
# Bridges WS reconnects, tab reloads, and brief network blips so we don't
# thrash Chromium. Override via IVE_PREVIEW_GRACE_SEC.
_GRACE_PERIOD_SEC = float(os.environ.get("IVE_PREVIEW_GRACE_SEC", "5.0"))


def normalize_preview_url(url: str) -> str:
    """Turn `<origin>/preview/<port>/<path>` URLs into `http://127.0.0.1:<port>/<path>`.

    Tunnel/multiplayer peers send proxied URLs, but Playwright runs on the
    host and should hit localhost directly — otherwise navigation cycles
    out through cloudflared and back, which is wasteful and breaks if the
    tunnel rate-limits.
    """
    m = re.match(r'^https?://[^/]+/preview/(\d+)(/.*)?$', url)
    if not m:
        return url
    port = m.group(1)
    path = m.group(2) or '/'
    return f"http://127.0.0.1:{port}{path}"


def share_key_for(url: str, workspace_id: Optional[str]) -> Optional[str]:
    """Derive a stable share_key from a URL + workspace.

    Returns None if the URL doesn't look like a localhost dev server (in
    which case the preview is treated as private to the requesting peer).
    """
    if not workspace_id:
        return None
    m = re.match(r'^https?://(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)', url, re.I)
    if not m:
        m = re.search(r'/preview/(\d+)(?:/|$)', url)
    if not m:
        return None
    return f"{workspace_id}:{m.group(1)}"


async def _ensure_browser():
    global _playwright, _browser
    if _browser and _browser.is_connected():
        return _browser
    from playwright.async_api import async_playwright
    _playwright = await async_playwright().start()
    _browser = await _playwright.chromium.launch(headless=True)
    log.info("Preview browser launched")
    return _browser


async def start_or_attach(
    *,
    url: str,
    width: int,
    height: int,
    share_key: Optional[str],
    subscriber_id: str,
    on_frame: Callable[[str], Awaitable[None]],
    on_navigate: Optional[Callable[[str], Awaitable[None]]] = None,
    on_driver_changed: Optional[Callable[[Optional[str]], Awaitable[None]]] = None,
) -> tuple[str, bool, str]:
    """Start a new preview or attach to an existing one with the same share_key.

    Returns (preview_id, started_new, driver_id).
    """
    if share_key and share_key in _keys_to_pid:
        pid = _keys_to_pid[share_key]
        preview = _previews.get(pid)
        if preview:
            preview["subscribers"][subscriber_id] = {
                "on_frame": on_frame,
                "on_navigate": on_navigate,
                "on_driver_changed": on_driver_changed,
            }
            t = preview.get("teardown_task")
            if t and not t.done():
                t.cancel()
            preview["teardown_task"] = None
            asyncio.ensure_future(_send_keyframe(pid, subscriber_id))
            log.info("Subscriber %s attached to existing preview %s (key=%s)", subscriber_id, pid, share_key)
            return pid, False, preview["driver_id"]

    nav_url = normalize_preview_url(url)
    browser = await _ensure_browser()
    preview_id = uuid.uuid4().hex[:8]
    page = await browser.new_page(viewport={"width": width, "height": height})

    try:
        await page.goto(nav_url, wait_until="domcontentloaded", timeout=15000)
    except Exception as e:
        log.warning("Preview navigation to %s: %s", nav_url, e)

    cdp = await page.context.new_cdp_session(page)

    preview = {
        "page": page,
        "cdp": cdp,
        "url": nav_url,
        "share_key": share_key,
        "width": width,
        "height": height,
        "subscribers": {
            subscriber_id: {
                "on_frame": on_frame,
                "on_navigate": on_navigate,
                "on_driver_changed": on_driver_changed,
            }
        },
        "driver_id": subscriber_id,
        "teardown_task": None,
    }
    _previews[preview_id] = preview
    if share_key:
        _keys_to_pid[share_key] = preview_id

    async def handle_frame(params):
        try:
            await cdp.send("Page.screencastFrameAck", {"sessionId": params["sessionId"]})
        except Exception:
            pass
        await _fanout_frame(preview_id, params["data"])

    cdp.on("Page.screencastFrame", handle_frame)
    await cdp.send("Page.startScreencast", {
        "format": "jpeg",
        "quality": 70,
        "maxWidth": width,
        "maxHeight": height,
        "everyNthFrame": 2,
    })

    page.on("framenavigated", lambda frame: _on_nav(preview_id, frame))

    log.info("Preview %s started: %s (key=%s, driver=%s)", preview_id, nav_url, share_key, subscriber_id)
    return preview_id, True, subscriber_id


async def _send_keyframe(preview_id: str, subscriber_id: str):
    """Push an immediate JPEG to a freshly-attached subscriber so they don't
    stare at a blank canvas waiting for the next screencast frame."""
    preview = _previews.get(preview_id)
    if not preview:
        return
    sub = preview["subscribers"].get(subscriber_id)
    if not sub:
        return
    try:
        png = await preview["page"].screenshot(type="jpeg", quality=70)
    except Exception:
        return
    import base64
    b64 = base64.b64encode(png).decode()
    cb = sub.get("on_frame")
    if cb:
        try:
            await cb(b64)
        except Exception:
            await unsubscribe(preview_id, subscriber_id)


async def _fanout_frame(preview_id: str, b64_jpeg: str):
    preview = _previews.get(preview_id)
    if not preview:
        return
    dead: list[str] = []
    for sid, sub in list(preview["subscribers"].items()):
        cb = sub.get("on_frame")
        if not cb:
            continue
        try:
            await cb(b64_jpeg)
        except Exception:
            dead.append(sid)
    for sid in dead:
        await unsubscribe(preview_id, sid)


def _on_nav(preview_id: str, frame):
    preview = _previews.get(preview_id)
    if not preview:
        return
    try:
        page = preview["page"]
        if frame == page.main_frame:
            new_url = page.url
            preview["url"] = new_url
            for sid, sub in list(preview["subscribers"].items()):
                cb = sub.get("on_navigate")
                if cb:
                    asyncio.ensure_future(_safe_invoke(preview_id, sid, cb, new_url))
    except Exception:
        pass


async def _safe_invoke(preview_id: str, sid: str, cb, *args):
    try:
        await cb(*args)
    except Exception:
        await unsubscribe(preview_id, sid)


async def unsubscribe(preview_id: str, subscriber_id: str):
    """Remove a subscriber. If they were the driver, hand off to the next
    subscriber in arrival order. If subscribers reach zero, schedule
    teardown after a short grace period."""
    preview = _previews.get(preview_id)
    if not preview:
        return
    preview["subscribers"].pop(subscriber_id, None)

    if preview["driver_id"] == subscriber_id:
        next_driver = next(iter(preview["subscribers"].keys()), None)
        preview["driver_id"] = next_driver
        if next_driver:
            await _broadcast_driver_change(preview_id)

    if not preview["subscribers"]:
        old = preview.get("teardown_task")
        if old and not old.done():
            old.cancel()
        preview["teardown_task"] = asyncio.create_task(_teardown_after_grace(preview_id))


async def _broadcast_driver_change(preview_id: str):
    preview = _previews.get(preview_id)
    if not preview:
        return
    driver = preview["driver_id"]
    for sid, sub in list(preview["subscribers"].items()):
        cb = sub.get("on_driver_changed")
        if cb:
            asyncio.ensure_future(_safe_invoke(preview_id, sid, cb, driver))


async def _teardown_after_grace(preview_id: str):
    try:
        await asyncio.sleep(_GRACE_PERIOD_SEC)
    except asyncio.CancelledError:
        return
    preview = _previews.get(preview_id)
    if not preview or preview["subscribers"]:
        return
    log.info("Preview %s torn down (grace period elapsed)", preview_id)
    await stop_preview(preview_id)


async def claim_driver(preview_id: str, subscriber_id: str) -> bool:
    preview = _previews.get(preview_id)
    if not preview or subscriber_id not in preview["subscribers"]:
        return False
    if preview["driver_id"] == subscriber_id:
        return True
    preview["driver_id"] = subscriber_id
    await _broadcast_driver_change(preview_id)
    return True


def get_driver(preview_id: str) -> Optional[str]:
    preview = _previews.get(preview_id)
    return preview["driver_id"] if preview else None


def subscriber_count(preview_id: str) -> int:
    preview = _previews.get(preview_id)
    return len(preview["subscribers"]) if preview else 0


async def stop_preview(preview_id: str):
    preview = _previews.pop(preview_id, None)
    if not preview:
        return
    sk = preview.get("share_key")
    if sk and _keys_to_pid.get(sk) == preview_id:
        _keys_to_pid.pop(sk, None)
    t = preview.get("teardown_task")
    if t and not t.done():
        t.cancel()
    try:
        await preview["cdp"].send("Page.stopScreencast")
    except Exception:
        pass
    try:
        await preview["page"].close()
    except Exception:
        pass
    log.info("Preview %s stopped", preview_id)


async def send_input(preview_id: str, subscriber_id: str, event: dict) -> bool:
    """Forward input only if subscriber holds the driver role."""
    preview = _previews.get(preview_id)
    if not preview:
        return False
    if preview["driver_id"] != subscriber_id:
        return False

    cdp = preview["cdp"]
    etype = event.get("type")
    try:
        if etype in ("mousedown", "mouseup", "mousemove"):
            cdp_type = {"mousedown": "mousePressed", "mouseup": "mouseReleased", "mousemove": "mouseMoved"}[etype]
            params = {
                "type": cdp_type,
                "x": event.get("x", 0),
                "y": event.get("y", 0),
                "button": event.get("button", "left"),
                "modifiers": _modifiers(event),
            }
            if etype == "mousedown":
                params["clickCount"] = event.get("clickCount", 1)
            await cdp.send("Input.dispatchMouseEvent", params)

        elif etype == "wheel":
            await cdp.send("Input.dispatchMouseEvent", {
                "type": "mouseWheel",
                "x": event.get("x", 0),
                "y": event.get("y", 0),
                "deltaX": event.get("deltaX", 0),
                "deltaY": event.get("deltaY", 0),
                "modifiers": _modifiers(event),
            })

        elif etype in ("keydown", "keyup"):
            cdp_type = "keyDown" if etype == "keydown" else "keyUp"
            key = event.get("key", "")
            code = event.get("code", "")
            text = event.get("text", "")
            mods = _modifiers(event)

            await cdp.send("Input.dispatchKeyEvent", {
                "type": cdp_type,
                "key": key,
                "code": code,
                "modifiers": mods,
                "text": text if cdp_type == "keyDown" and len(text) == 1 else "",
                "windowsVirtualKeyCode": event.get("keyCode", 0),
            })
            if cdp_type == "keyDown" and len(text) == 1 and not mods & 6:
                await cdp.send("Input.dispatchKeyEvent", {
                    "type": "char",
                    "text": text,
                    "key": key,
                    "code": code,
                    "modifiers": mods,
                })
    except Exception as e:
        log.debug("Preview input error: %s", e)
    return True


async def navigate(preview_id: str, subscriber_id: str, url: str) -> bool:
    """Driver-only navigation."""
    preview = _previews.get(preview_id)
    if not preview or preview["driver_id"] != subscriber_id:
        return False
    nav_url = normalize_preview_url(url)
    try:
        await preview["page"].goto(nav_url, wait_until="domcontentloaded", timeout=15000)
        preview["url"] = nav_url
    except Exception as e:
        log.warning("Preview navigate to %s: %s", nav_url, e)
    return True


async def get_current_url(preview_id: str) -> Optional[str]:
    preview = _previews.get(preview_id)
    if not preview:
        return None
    try:
        return preview["page"].url
    except Exception:
        return preview.get("url")


async def screenshot_png(preview_id: str) -> Optional[bytes]:
    preview = _previews.get(preview_id)
    if not preview:
        return None
    try:
        return await preview["page"].screenshot(type="png")
    except Exception as e:
        log.warning("Preview screenshot error: %s", e)
        return None


async def resize(preview_id: str, subscriber_id: str, width: int, height: int) -> bool:
    """Driver-only — viewport size is shared state."""
    preview = _previews.get(preview_id)
    if not preview or preview["driver_id"] != subscriber_id:
        return False
    try:
        await preview["page"].set_viewport_size({"width": width, "height": height})
        preview["width"] = width
        preview["height"] = height
        cdp = preview["cdp"]
        try:
            await cdp.send("Page.stopScreencast")
        except Exception:
            pass
        await cdp.send("Page.startScreencast", {
            "format": "jpeg",
            "quality": 70,
            "maxWidth": width,
            "maxHeight": height,
            "everyNthFrame": 2,
        })
    except Exception as e:
        log.warning("Preview resize error: %s", e)
    return True


def _modifiers(event: dict) -> int:
    m = 0
    if event.get("altKey"):   m |= 1
    if event.get("ctrlKey"):  m |= 2
    if event.get("metaKey"):  m |= 4
    if event.get("shiftKey"): m |= 8
    return m


def active_previews() -> list[str]:
    return list(_previews.keys())


async def shutdown():
    global _browser, _playwright
    for pid in list(_previews.keys()):
        await stop_preview(pid)
    if _browser:
        try:
            await _browser.close()
        except Exception:
            pass
        _browser = None
    if _playwright:
        try:
            await _playwright.stop()
        except Exception:
            pass
        _playwright = None
    log.info("Preview browser shut down")
