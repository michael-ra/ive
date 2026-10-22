"""Sandbox provider — which runtime is here, and what can it actually do.

Three modules now put workloads in containers (`app_container`, `browser_container`,
`sandbox_exec`) and each one used to answer "can I?" by trying and failing. This
is the single place that answers it first, so a caller can fall back to the host
path deliberately instead of discovering the gap through a timeout.

Deliberately NOT a lifecycle facade: `sidecars` already owns start/stop/exec with
its ledger and forensics, and wrapping it again would only add a layer to keep in
sync. What was missing is capability reporting, so that is all this provides.

The capability rows carry what was MEASURED on this class of host rather than what
the docs promise, because three of these bit us:

  * `-p` publishing binds a host port but did not forward — drive containers at
    their own IP instead.
  * A container reaching a HOST service depends on the host firewall; with macOS
    "block all incoming" the handshake completes and no data flows, so an app on
    the host is not previewable from a container browser. Container-to-container
    is unaffected, which is why the app tier exists.
  * `--internal` networks are documented "host-only" but isolate completely.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
from dataclasses import dataclass, field
from typing import Callable, Optional

logger = logging.getLogger(__name__)

RUNTIME_APPLE = "apple-container"
RUNTIME_DOCKER = "docker"
RUNTIME_NONE = "none"

# CLI binary per runtime, in preference order.
_RUNTIME_BINARIES: tuple[tuple[str, str], ...] = (
    (RUNTIME_APPLE, "container"),
    (RUNTIME_DOCKER, "docker"),
)

_TRUE_SET = {"1", "true", "yes", "on"}
_PROBE_TTL_S = 30.0
_cache: dict = {"at": 0.0, "value": None}


@dataclass
class Capabilities:
    """What a runtime can do for IVE's container tiers."""
    runtime: str
    available: bool
    reason: str = ""
    version: str = ""
    # Egress, delegated to the module that owns that decision.
    filtering: str = "impossible"
    isolation: str = "impossible"
    # Container features IVE depends on.
    bind_mounts: bool = False
    nested_mounts: bool = False        # node_modules shadow over the workspace
    port_publishing: bool = False      # measured broken on apple-container
    host_reachable_from_container: bool = False   # firewall-dependent
    container_ip_addressable: bool = False        # how CDP is actually reached
    notes: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "runtime": self.runtime, "available": self.available,
            "reason": self.reason, "version": self.version,
            "egress": {"filtering": self.filtering, "isolation": self.isolation},
            "features": {
                "bind_mounts": self.bind_mounts,
                "nested_mounts": self.nested_mounts,
                "port_publishing": self.port_publishing,
                "host_reachable_from_container": self.host_reachable_from_container,
                "container_ip_addressable": self.container_ip_addressable,
            },
            "notes": list(self.notes),
        }

    @property
    def can_run_app(self) -> bool:
        """An app container needs the workspace mounted and a reachable address."""
        return self.available and self.bind_mounts and self.container_ip_addressable

    @property
    def can_run_browser(self) -> bool:
        """A browser container is driven over CDP at its own address."""
        return self.available and self.container_ip_addressable


def _which(binary: str, which_fn: Optional[Callable] = None) -> Optional[str]:
    return (which_fn or shutil.which)(binary)


KNOWN_RUNTIMES = frozenset({RUNTIME_APPLE, RUNTIME_DOCKER})


def forced_runtime() -> str:
    return str(os.environ.get("IVE_SANDBOX_RUNTIME", "")).strip().lower()


def detect_runtime(which_fn: Optional[Callable] = None) -> str:
    """First container runtime whose CLI is present. Honors IVE_SANDBOX_RUNTIME.

    An override naming something we have no capability row for resolves to NONE
    rather than being echoed back: an unknown name used to flow through as a
    "runtime" and inherit the fallback binary lookup, so a typo like
    IVE_SANDBOX_RUNTIME=container (the BINARY name, not the runtime id) reported
    a usable runtime that no capability row describes.
    """
    forced = forced_runtime()
    if forced:
        return forced if forced in KNOWN_RUNTIMES else RUNTIME_NONE
    for runtime, binary in _RUNTIME_BINARIES:
        if _which(binary, which_fn):
            return runtime
    return RUNTIME_NONE


def _capabilities_for(runtime: str, version: str = "") -> Capabilities:
    try:
        import sandbox_egress as se

        egress = se.capability_for(runtime)
        filtering, isolation = egress.filtering, egress.isolation
    except Exception:
        filtering = isolation = "impossible"

    if runtime == RUNTIME_APPLE:
        return Capabilities(
            runtime=runtime, available=True, version=version,
            filtering=filtering, isolation=isolation,
            bind_mounts=True, nested_mounts=True,
            port_publishing=False,          # measured: binds, does not forward
            host_reachable_from_container=False,   # firewall-dependent; see probe
            container_ip_addressable=True,
            notes=[
                "drive containers at their own IP; -p publishing does not forward",
                "an --internal network isolates completely, not host-only",
            ],
        )
    if runtime == RUNTIME_DOCKER:
        return Capabilities(
            runtime=runtime, available=True, version=version,
            filtering=filtering, isolation=isolation,
            bind_mounts=True, nested_mounts=True, port_publishing=True,
            host_reachable_from_container=True, container_ip_addressable=True,
            notes=["capabilities assumed from the docker model; unverified on this host"],
        )
    return Capabilities(
        runtime=RUNTIME_NONE, available=False,
        reason="no container runtime CLI found (looked for: container, docker)",
        notes=["container tiers stay disabled; host paths are used"],
    )


async def _run(argv: list, timeout: float = 5.0) -> tuple[int, str, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")
    except Exception as e:
        return 127, "", str(e)


def firewall_blocks_incoming(reader: Optional[Callable] = None) -> Optional[bool]:
    """True when the macOS firewall blocks incoming connections.

    That setting is why a container can complete a TCP handshake to a host
    service and then transfer nothing — the reason a host-run dev server is not
    previewable from a container. None means "unknown / not macOS".
    """
    path = "/usr/libexec/ApplicationFirewall/socketfilterfw"
    try:
        if reader is not None:
            text = reader()
        else:
            if not os.path.exists(path):
                return None
            import subprocess

            text = subprocess.run([path, "--getglobalstate"], capture_output=True,
                                  text=True, timeout=5).stdout
        low = str(text or "").lower()
        # State 2 = block ALL incoming. State 1 = firewall on, incoming allowed
        # only for listed/signed binaries — a dev server started by IVE is not
        # listed, so incoming to it is blocked just the same. State 0 / disabled
        # = not blocking. Anything else is genuinely unknown and says so.
        if "state = 2" in low or "block all" in low:
            return True
        if "state = 1" in low:
            return True
        if "state = 0" in low or "disabled" in low:
            return False
        return None
    except Exception:
        return None


def firewall_state(reader: Optional[Callable] = None) -> Optional[int]:
    """The raw numeric state (0/1/2), or None when it cannot be determined."""
    path = "/usr/libexec/ApplicationFirewall/socketfilterfw"
    try:
        if reader is not None:
            text = reader()
        else:
            if not os.path.exists(path):
                return None
            import subprocess

            text = subprocess.run([path, "--getglobalstate"], capture_output=True,
                                  text=True, timeout=5).stdout
        low = str(text or "").lower()
        for value in (2, 1, 0):
            if f"state = {value}" in low:
                return value
        return None
    except Exception:
        return None


async def probe(*, which_fn: Optional[Callable] = None,
                run_fn: Optional[Callable] = None,
                firewall_fn: Optional[Callable] = None,
                use_cache: bool = True) -> dict:
    """Report the runtime and its capabilities. Cheap, cached, never raises."""
    loop = asyncio.get_event_loop()
    if use_cache and _cache["value"] is not None and (loop.time() - _cache["at"]) < _PROBE_TTL_S:
        return dict(_cache["value"])

    try:
        runtime = detect_runtime(which_fn)
    except Exception as e:
        caps = _capabilities_for(RUNTIME_NONE)
        caps.reason = f"runtime detection failed: {str(e)[:120]}"
        result = caps.to_dict()
        result["can_run_app"] = result["can_run_browser"] = False
        _cache.update({"at": loop.time(), "value": result})
        return dict(result)

    bad_override = forced_runtime()
    if bad_override and runtime == RUNTIME_NONE:
        caps = _capabilities_for(RUNTIME_NONE)
        caps.reason = (f"IVE_SANDBOX_RUNTIME={bad_override!r} is not a known runtime "
                       f"({', '.join(sorted(KNOWN_RUNTIMES))})")
        result = caps.to_dict()
        result["can_run_app"] = result["can_run_browser"] = False
        _cache.update({"at": loop.time(), "value": result})
        return dict(result)
    version = ""
    if runtime != RUNTIME_NONE:
        binary = dict(_RUNTIME_BINARIES).get(runtime, runtime)
        try:
            rc, out, err = await (run_fn or _run)([binary, "--version"])
        except Exception as e:
            rc, out, err = 127, "", str(e)[:120]
        if rc == 0:
            version = (out or err).strip().splitlines()[0][:120] if (out or err) else ""
        else:
            caps = _capabilities_for(RUNTIME_NONE)
            caps.reason = f"{binary} present but not usable: {(err or out).strip()[:120]}"
            result = caps.to_dict()
            # Same keys on every return, or a caller reading result["can_run_app"]
            # gets a KeyError on exactly the unhappy path it needs to handle.
            result["can_run_app"] = result["can_run_browser"] = False
            _cache.update({"at": loop.time(), "value": result})
            return dict(result)

    caps = _capabilities_for(runtime, version)
    try:
        blocked = (firewall_fn or firewall_blocks_incoming)()
    except Exception:
        blocked = None   # unknown firewall state must not sink the whole probe
    if blocked is True:
        caps.host_reachable_from_container = False
        state = firewall_state() if firewall_fn is None else None
        detail = ("blocks ALL incoming" if state == 2 else
                  "is on and blocks incoming to unlisted binaries" if state == 1 else
                  "blocks incoming")
        caps.notes.append(
            f"host firewall {detail}: a host-run dev server is NOT reachable "
            "from a container — run the app in a container too")
    elif blocked is False and caps.runtime == RUNTIME_APPLE:
        caps.host_reachable_from_container = True
    elif blocked is None:
        caps.notes.append(
            "host firewall state unknown — treat host reachability from a container "
            "as unproven rather than assuming it works")

    result = caps.to_dict()
    result["can_run_app"] = caps.can_run_app
    result["can_run_browser"] = caps.can_run_browser
    _cache.update({"at": loop.time(), "value": result})
    return dict(result)


def clear_cache() -> None:
    _cache.update({"at": 0.0, "value": None})


async def readiness() -> dict:
    """One answer for the UI: which container tiers are usable here, and why not."""
    info = await probe()
    tiers = {
        "app": {
            "enabled": _flag("IVE_APP_CONTAINER"),
            "supported": bool(info.get("can_run_app")),
        },
        "browser": {
            "enabled": _flag("IVE_BROWSER_CONTAINER"),
            "supported": bool(info.get("can_run_browser")),
        },
    }
    for tier in tiers.values():
        tier["usable"] = tier["enabled"] and tier["supported"]
    return {"runtime": info, "tiers": tiers}


def _flag(name: str) -> bool:
    return str(os.environ.get(name, "")).strip().lower() in _TRUE_SET


# ─── Visual output ──────────────────────────────────────────────────────
#
# "Can I SEE the app, and stay safe from what it runs?" has three different
# answers depending on what the app is, and only two of them exist today.

VISUAL_SCREENSHOT = "screenshot"            # render and capture, no interaction
VISUAL_INTERACTIVE_WEB = "interactive-web"  # watch and click a WEB ui
VISUAL_DESKTOP = "desktop"                  # a real GUI app / OS desktop


async def visual_modes() -> dict:
    """What visual access is possible here, and what each one costs.

    The safety property that matters is the same in every case: the page's or
    app's code must execute somewhere that is not the user's machine, and only
    pixels plus input events should cross back. The web modes achieve that today
    through the browser container (CDP screencast); the desktop mode does not
    exist and cannot be faked, because a micro-VM/container has no display —
    that is exactly why the design reserves a streamed-desktop tier for it.
    """
    info = await probe()
    browser_ok = bool(info.get("can_run_browser"))
    reason = "" if browser_ok else (info.get("reason") or "no container runtime")
    return {
        VISUAL_SCREENSHOT: {
            "available": browser_ok,
            "how": "browser container + CDP Page.captureScreenshot",
            "isolated": browser_ok,
            "note": "" if browser_ok else reason,
        },
        VISUAL_INTERACTIVE_WEB: {
            "available": browser_ok,
            "how": "browser container + CDP screencast frames out, input events in "
                   "(preview_browser start_or_attach/send_input)",
            "isolated": browser_ok,
            "note": "the page's JS runs in the container; the host receives frames only"
                    if browser_ok else reason,
        },
        VISUAL_DESKTOP: {
            "available": False,
            "how": "not built — needs a Linux desktop image with a virtual display "
                   "streamed over web-VNC (e.g. kasmweb/chrome, m1k1o/neko)",
            "isolated": None,
            "note": "containers here are headless, so a native-GUI app has no display "
                    "to draw on; a screenshot of nothing is not a safety win",
        },
    }


async def select_visual_mode(need: str = VISUAL_INTERACTIVE_WEB) -> dict:
    """Pick the tier for a stated need, or say plainly why it cannot be served."""
    modes = await visual_modes()
    key = str(need or "").strip().lower()
    if key not in modes:
        key = VISUAL_INTERACTIVE_WEB
    chosen = modes[key]
    out = {"requested": need, "mode": key, **chosen}
    if not chosen["available"]:
        # Never silently downgrade to a weaker-but-available mode: being shown a
        # screenshot when you asked to drive the app is a different product.
        out["alternatives"] = [k for k, v in modes.items() if v["available"]]
    return out
