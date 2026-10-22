"""Containerized browser tier — drive Chrome over CDP instead of on the host.

`preview_browser` launches Chromium on the host: the page's JavaScript, its WASM,
its font and image parsers all execute next to the user's keychain and SSH keys.
This module moves that execution into a disposable container and leaves only two
narrow channels crossing back — CDP protocol messages out to the driver, and
(later, for the interactive tier) video frames out to the viewer. Untrusted page
code stays inside.

Lifecycle rides `sidecars` rather than reimplementing it, so the browser gets the
same invocation ledger, forensics-before-delete, IP re-read on every start and
egress posture as every other IVE container.

MEASURED against Apple `container` 1.1.0 + chromedp/headless-shell (2026-07-27):

  * A host process CAN dial a default-network container directly at its own
    IP:9222 — that is the CDP path, verified end to end with Playwright
    (connect_over_cdp -> set_content -> inner_text -> screenshot).
  * `-p host:container` publishing BINDS a host port but did not forward traffic
    here (a TCP connect succeeds while HTTP returns nothing), so the container's
    own address is the reliable target, not a published port.
  * The container IP CHANGES across stop/start, so it must be re-read after every
    start and never cached across a restart.
  * The image has an ENTRYPOINT wrapper (chrome on 9223 + socat 9222->9223), so a
    "command" is appended as EXTRA CHROME FLAGS, not a replacement. Passing a URL
    among them makes chrome exit with "Multiple targets are not supported" —
    hence FLAGS ONLY, and navigation happens over CDP after connect.
  * A host service bound to LOOPBACK is unreachable from a container and its SYNs
    are dropped rather than refused, so a localhost dev-server URL must be
    rewritten to the gateway AND that server must bind 0.0.0.0 — see
    :func:`rewrite_url_for_container`.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Callable, Optional

logger = logging.getLogger(__name__)

CDP_PORT = int(os.environ.get("IVE_BROWSER_CDP_PORT") or 9222)
DEFAULT_BROWSER_IMAGE = os.environ.get(
    "IVE_BROWSER_IMAGE", "chromedp/headless-shell:latest")
# One browser container per workspace, named like any other sidecar.
BROWSER_SIDECAR_NAME = os.environ.get("IVE_BROWSER_SIDECAR_NAME", "browser")
# The default network's gateway is the only container-reachable host address.
HOST_GATEWAY = os.environ.get("IVE_CONTAINER_HOST_GATEWAY", "192.168.64.1")

_TRUE_SET = {"1", "true", "yes", "on"}
_LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]")


def container_mode_enabled(env: Optional[dict] = None) -> bool:
    """True when previews should run in a browser container rather than on the host."""
    src = env if env is not None else os.environ
    return str(src.get("IVE_BROWSER_CONTAINER", "")).strip().lower() in _TRUE_SET


def browser_flags(width: int = 1280, height: int = 800) -> list[str]:
    """Extra chrome flags for the entrypoint. FLAGS ONLY — never a URL.

    A positional URL reaches the wrapper's chrome invocation as a second target
    and chrome exits with "Multiple targets are not supported".
    """
    w = max(1, int(width or 1280))
    h = max(1, int(height or 800))
    return [f"--window-size={w},{h}", "--hide-scrollbars", "--mute-audio"]


def cdp_url(ip: str, port: int = CDP_PORT) -> str:
    return f"http://{ip}:{int(port)}"


def rewrite_url_for_container(url: str, gateway: str = HOST_GATEWAY) -> str:
    """Rewrite a host-local URL so a container can reach it.

    localhost/127.0.0.1 inside the container means the CONTAINER, so a preview of
    a host dev server has to be re-pointed at the gateway. This only helps if that
    server binds 0.0.0.0 — a loopback-bound server stays unreachable and its SYNs
    are dropped, which surfaces as a multi-second hang rather than a refusal.
    """
    try:
        text = str(url or "")
        if not text:
            return text
        from urllib.parse import urlsplit, urlunsplit

        parts = urlsplit(text if "//" in text else "http://" + text)
        host = (parts.hostname or "").lower()
        if host not in _LOOPBACK_HOSTS:
            return text
        netloc = gateway if parts.port is None else f"{gateway}:{parts.port}"
        if parts.username:
            cred = parts.username + (f":{parts.password}" if parts.password else "")
            netloc = f"{cred}@{netloc}"
        return urlunsplit((parts.scheme or "http", netloc, parts.path, parts.query, parts.fragment))
    except Exception:
        return url


def is_loopback_url(url: str) -> bool:
    try:
        from urllib.parse import urlsplit

        text = str(url or "")
        parts = urlsplit(text if "//" in text else "http://" + text)
        return (parts.hostname or "").lower() in _LOOPBACK_HOSTS
    except Exception:
        return False


# ─── CDP readiness ──────────────────────────────────────────────────────

async def _default_http_get(url: str, timeout: float) -> tuple[int, str]:
    import aiohttp

    async with aiohttp.ClientSession() as session:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
            return resp.status, await resp.text()


async def wait_for_cdp(
    ip: str,
    port: int = CDP_PORT,
    *,
    timeout: float = 30.0,
    interval: float = 0.5,
    http_get: Optional[Callable] = None,
) -> Optional[dict]:
    """Poll /json/version until chrome answers. Returns the version dict or None.

    Chrome needs several seconds before the endpoint answers; callers must not
    treat the first refusal as failure.
    """
    getter = http_get or _default_http_get
    deadline = asyncio.get_event_loop().time() + max(0.1, float(timeout))
    url = f"{cdp_url(ip, port)}/json/version"
    last_error = None
    while asyncio.get_event_loop().time() < deadline:
        try:
            status, body = await getter(url, 3.0)
            if status == 200:
                try:
                    return json.loads(body)
                except Exception:
                    return {"raw": body[:200]}
            last_error = f"HTTP {status}"
        except Exception as e:
            last_error = str(e)[:120]
        await asyncio.sleep(interval)
    logger.info("browser_container: CDP not ready at %s (%s)", url, last_error)
    return None


# ─── Lifecycle (delegates to sidecars) ──────────────────────────────────

async def ensure_browser(
    workspace_id: str,
    *,
    width: int = 1280,
    height: int = 800,
    image: Optional[str] = None,
    egress: Optional[str] = None,
    network: Optional[str] = None,
    start_fn: Optional[Callable] = None,
    inspect_fn: Optional[Callable] = None,
    http_get: Optional[Callable] = None,
    cdp_timeout: float = 30.0,
) -> dict:
    """Start (or reuse) the workspace's browser container and return its CDP endpoint.

    Returns ``{"ok", "cdp_url", "ip", "version", "container", "error"}``. Never
    raises: a failure returns ok=False so the caller can fall back to a host
    browser rather than losing the preview entirely.

    ``egress`` is passed through to the sidecar posture. A browser that must load
    third-party pages cannot be network-isolated; leaving this None keeps the
    default network, which is also the only one the host can dial for CDP.
    """
    ws = str(workspace_id or "").strip()
    if not ws:
        return {"ok": False, "error": "workspace_id required"}

    try:
        import sidecars
    except Exception as e:  # pragma: no cover - import guard
        return {"ok": False, "error": f"sidecars unavailable: {e}"}

    start = start_fn or sidecars.start_sidecar
    inspect = inspect_fn or sidecars._inspect
    name = BROWSER_SIDECAR_NAME

    # The browser must sit on the SAME network as the app it renders — containers
    # reach each other only within a network — while staying off the shared
    # default network, so another workspace's app cannot reach this browser (whose
    # CDP port would otherwise be an open door to every page it has loaded).
    if network is None:
        try:
            import app_container as _ac

            network = await _ac.ensure_workspace_network(ws)
        except Exception:
            network = None
    kwargs = dict(
        image=image or DEFAULT_BROWSER_IMAGE,
        network=network,
        command=browser_flags(width, height),   # flags only — a URL breaks chrome
        http_port=CDP_PORT,
    )
    if egress is not None:
        kwargs["egress"] = egress

    try:
        result = await start(ws, name, **kwargs)
    except Exception as e:
        return {"ok": False, "error": f"browser container start failed: {e}"}
    if not result.get("ok"):
        return {"ok": False, "error": result.get("error") or "browser container start failed",
                "egress": result.get("egress")}

    # Re-read the address: it changes across a restart, and a cached one routes to
    # whatever container the allocator handed it to next.
    ip = (result.get("sidecar") or {}).get("ip")
    if not ip:
        try:
            info = await inspect(sidecars.container_name(ws, name))
            ip = info.get("ip")
        except Exception:
            ip = None
    if not ip:
        return {"ok": False, "error": "browser container has no address yet"}

    version = await wait_for_cdp(ip, CDP_PORT, timeout=cdp_timeout, http_get=http_get)
    if version is None:
        return {"ok": False, "ip": ip, "cdp_url": cdp_url(ip),
                "error": "browser container started but CDP never became ready"}

    return {
        "ok": True,
        "ip": ip,
        "cdp_url": cdp_url(ip),
        "version": version,
        "container": sidecars.container_name(ws, name),
    }


async def stop_browser(workspace_id: str, *, stop_fn: Optional[Callable] = None) -> dict:
    """Stop the workspace's browser container (logs survive; nothing is deleted)."""
    try:
        import sidecars

        stop = stop_fn or sidecars.stop_sidecar
        return await stop(str(workspace_id or ""), BROWSER_SIDECAR_NAME)
    except Exception as e:
        return {"ok": False, "error": str(e)}
