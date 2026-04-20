"""Live browser preview via Playwright CDP screencast.

Manages a shared Chromium instance with per-preview pages. Streams JPEG
frames via a callback and accepts mouse/keyboard input forwarded from the
frontend via WebSocket.
"""
import asyncio
import logging
from typing import Callable, Optional, Awaitable
import uuid

log = logging.getLogger(__name__)

_playwright = None
_browser = None
_previews: dict[str, dict] = {}


async def _ensure_browser():
    """Lazy-init a shared Playwright Chromium instance."""
    global _playwright, _browser
    if _browser and _browser.is_connected():
        return _browser
    try:
        from playwright.async_api import async_playwright
        _playwright = await async_playwright().start()
        _browser = await _playwright.chromium.launch(headless=True)
        log.info("Preview browser launched")
        return _browser
    except Exception as e:
        log.error("Failed to launch preview browser: %s", e)
        raise


async def start_preview(
    url: str,
    width: int = 1280,
    height: int = 720,
    on_frame: Optional[Callable[[str], Awaitable[None]]] = None,
    on_navigate: Optional[Callable[[str], Awaitable[None]]] = None,
) -> str:
    """Start a live preview session. Returns preview_id.

    on_frame(base64_jpeg) is called for each screencast frame.
    on_navigate(new_url) is called when the page navigates.
    """
    browser = await _ensure_browser()
    preview_id = uuid.uuid4().hex[:8]

    page = await browser.new_page(viewport={"width": width, "height": height})

    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=15000)
    except Exception as e:
        log.warning("Preview navigation to %s: %s", url, e)

    cdp = await page.context.new_cdp_session(page)

    preview = {
        "page": page,
        "cdp": cdp,
        "url": url,
        "on_frame": on_frame,
        "on_navigate": on_navigate,
        "width": width,
        "height": height,
    }
    _previews[preview_id] = preview

    # Stream frames via CDP screencast
    async def handle_frame(params):
        try:
            await cdp.send("Page.screencastFrameAck", {"sessionId": params["sessionId"]})
        except Exception:
            pass
        cb = preview.get("on_frame")
        if cb:
            try:
                await cb(params["data"])
            except Exception:
                pass

    cdp.on("Page.screencastFrame", handle_frame)
    await cdp.send("Page.startScreencast", {
        "format": "jpeg",
        "quality": 70,
        "maxWidth": width,
        "maxHeight": height,
        "everyNthFrame": 2,
    })

    # Track navigation
    page.on("framenavigated", lambda frame: _on_nav(preview_id, frame))

    return preview_id


def _on_nav(preview_id: str, frame):
    """Handle page navigation events."""
    preview = _previews.get(preview_id)
    if not preview:
        return
    try:
        page = preview["page"]
        if frame == page.main_frame:
            new_url = page.url
            preview["url"] = new_url
            cb = preview.get("on_navigate")
            if cb:
                asyncio.ensure_future(cb(new_url))
    except Exception:
        pass


async def stop_preview(preview_id: str):
    """Stop and clean up a preview session."""
    preview = _previews.pop(preview_id, None)
    if not preview:
        return
    try:
        await preview["cdp"].send("Page.stopScreencast")
    except Exception:
        pass
    try:
        await preview["page"].close()
    except Exception:
        pass
    log.info("Preview %s stopped", preview_id)


async def send_input(preview_id: str, event: dict):
    """Forward a mouse/keyboard/scroll event to the preview page via CDP."""
    preview = _previews.get(preview_id)
    if not preview:
        return

    cdp = preview["cdp"]
    etype = event.get("type")

    try:
        if etype in ("mousedown", "mouseup", "mousemove"):
            cdp_type = {
                "mousedown": "mousePressed",
                "mouseup": "mouseReleased",
                "mousemove": "mouseMoved",
            }[etype]
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
            # Emit char event for printable characters
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


async def navigate(preview_id: str, url: str):
    """Navigate the preview page to a new URL."""
    preview = _previews.get(preview_id)
    if not preview:
        return
    try:
        await preview["page"].goto(url, wait_until="domcontentloaded", timeout=15000)
        preview["url"] = url
    except Exception as e:
        log.warning("Preview navigate to %s: %s", url, e)


async def get_current_url(preview_id: str) -> Optional[str]:
    """Return the page's current URL."""
    preview = _previews.get(preview_id)
    if not preview:
        return None
    try:
        return preview["page"].url
    except Exception:
        return preview.get("url")


async def screenshot_png(preview_id: str) -> Optional[bytes]:
    """Take a high-quality PNG screenshot of the current page."""
    preview = _previews.get(preview_id)
    if not preview:
        return None
    try:
        return await preview["page"].screenshot(type="png")
    except Exception as e:
        log.warning("Preview screenshot error: %s", e)
        return None


async def resize(preview_id: str, width: int, height: int):
    """Resize the preview viewport and restart screencast."""
    preview = _previews.get(preview_id)
    if not preview:
        return
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


def _modifiers(event: dict) -> int:
    """Convert JS modifier flags to CDP modifier bitmask."""
    m = 0
    if event.get("altKey"):   m |= 1
    if event.get("ctrlKey"):  m |= 2
    if event.get("metaKey"):  m |= 4
    if event.get("shiftKey"): m |= 8
    return m


def active_previews() -> list[str]:
    """Return list of active preview IDs."""
    return list(_previews.keys())


async def shutdown():
    """Clean up all previews and the shared browser."""
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
