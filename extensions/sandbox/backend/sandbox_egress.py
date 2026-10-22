"""Sandbox egress posture — one honest answer to "what network does this run get?".

Every sandbox tier already had its own partial story: ``sandbox_engine`` builds a
Seatbelt profile and (when ``EGRESS_PROXY_ENFORCE`` is on) forces the
``egress_policy`` proxy, ``sandbox_runtime`` carries an advisory ``network`` field
plus the ``check_egress`` allowlist decision, and ``sidecars`` attaches Apple
``container`` workloads to the default network with no filtering at all. Nothing
reconciled a caller's REQUEST against what a given runtime can actually DELIVER,
so a request for restricted egress could be answered with unrestricted network
and no one would know.

This module is that reconciliation, and nothing else: pure decision logic, no
sockets, no subprocess (the one command builder returns argv for the caller to
run). It maps

    requested posture  ×  runtime capability  →  delivered mode (+ how)

THE ONE RULE: a request for less network never resolves to more. ``filtered``
degrades to ``isolated`` (a strict subset of what was asked for) or to ``deny``
— never to ``open``. Widening only happens when an operator sets
``IVE_EGRESS_ALLOW_UNFILTERED``, and then the decision says so in ``reason`` and
carries ``downgraded=True`` for the audit ledger.

RUNTIME CAPABILITIES (measured on this machine 2026-07-27, Apple ``container``
1.1.0 — probe containers on ``alpine``, baseline-controlled, cleaned up after):

  * ``container network create --internal`` is documented as "Restrict to
    host-only network" but delivers TOTAL isolation: a container on such a
    network reached neither the internet (``NET_FAIL`` while an identical
    container on the default network got ``NET_OK`` at the same moment) nor a
    host service (the internal gateway ``192.168.128.1`` is never plumbed onto
    the host — binding a listener to it fails "address not on host") nor a
    container on another network (``CROSS_ISOLATED``).
  * So ISOLATION is enforceable on Apple container, and FILTERING is not:
    per-destination rules have no primitive, and the usual escape hatch —
    internal network plus a host-side allowlisting proxy, which works on Docker
    because raw sockets have nowhere else to go — cannot work here, because the
    host itself is unreachable from an internal network.

The honest cost of that, which callers must surface rather than paper over: an
isolated container reaches no package registry, so "filtered, but npm needs
registry.npmjs.org" resolves to "no install".
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from typing import Callable, Iterable, Optional

# ─── Requested postures (what a caller asks for) ────────────────────────
POSTURE_ISOLATED = "isolated"   # no egress at all
POSTURE_FILTERED = "filtered"   # egress only to an allowlist
POSTURE_OPEN = "open"           # unrestricted egress
_POSTURES = (POSTURE_ISOLATED, POSTURE_FILTERED, POSTURE_OPEN)

# ─── Delivered modes (what a runtime can actually do) ───────────────────
MODE_ISOLATED = "isolated"      # attached to a network with no route out
MODE_PROXY = "proxy"            # egress forced through an allowlisting proxy
MODE_OPEN = "open"              # default network, unrestricted
MODE_DENY = "deny"              # refuse to run — the request cannot be honored

# ─── Capability grades ──────────────────────────────────────────────────
ENFORCED = "enforced"           # the runtime makes it structurally true
BEST_EFFORT = "best_effort"     # honored by cooperating clients only
IMPOSSIBLE = "impossible"       # no primitive exists

_OVERRIDE_ENV = "IVE_EGRESS_ALLOW_UNFILTERED"
_TRUE_SET = {"1", "true", "yes", "on"}

# Name prefix for the per-scope internal networks used by MODE_ISOLATED.
ISOLATED_NETWORK_PREFIX = "ive-isolated"

# configuration.mode reported by `container network inspect`: an --internal
# network reports "hostOnly", the default NAT network reports "nat".
INTERNAL_NETWORK_MODE = "hostonly"


@dataclass(frozen=True)
class RuntimeCapability:
    """What a runtime can enforce about egress."""
    runtime: str
    filtering: str      # ENFORCED | BEST_EFFORT | IMPOSSIBLE
    isolation: str      # ENFORCED | BEST_EFFORT | IMPOSSIBLE
    note: str = ""


CAPABILITIES: dict[str, RuntimeCapability] = {
    # Measured — see module docstring.
    "apple-container": RuntimeCapability(
        "apple-container", filtering=IMPOSSIBLE, isolation=ENFORCED,
        note="--internal network cuts internet, host and cross-network; no per-destination primitive",
    ),
    # Container networks can be made internal while an allowlisting proxy sits
    # on a reachable host/bridge address, so raw sockets have no way around it.
    "docker": RuntimeCapability(
        "docker", filtering=ENFORCED, isolation=ENFORCED,
        note="internal network + reachable host proxy makes an allowlist unbypassable",
    ),
    # Seatbelt/bubblewrap: no network namespace. HTTP_PROXY is honored by
    # cooperating clients; a raw socket ignores it. network='none' is advisory.
    "process": RuntimeCapability(
        "process", filtering=BEST_EFFORT, isolation=BEST_EFFORT,
        note="proxy env honored by cooperating clients only; no network namespace",
    ),
    # Remote runtime: we cannot verify what it enforces from here.
    "daytona": RuntimeCapability(
        "daytona", filtering=IMPOSSIBLE, isolation=IMPOSSIBLE,
        note="remote runtime; posture not verifiable from this host",
    ),
}

_DEFAULT_CAPABILITY = RuntimeCapability(
    "unknown", filtering=IMPOSSIBLE, isolation=IMPOSSIBLE,
    note="unrecognized runtime; treated as enforcing nothing",
)


def capability_for(runtime: Optional[str]) -> RuntimeCapability:
    """Capability record for ``runtime``; unknown names enforce nothing."""
    key = (runtime or "").strip().lower()
    return CAPABILITIES.get(key, _DEFAULT_CAPABILITY)


@dataclass(frozen=True)
class EgressDecision:
    """The reconciled answer. ``mode`` is what the caller must actually do."""
    mode: str
    requested: str
    runtime: str
    reason: str
    enforceable: bool
    downgraded: bool
    container_args: tuple[str, ...] = ()
    env: dict = field(default_factory=dict)
    network_name: Optional[str] = None
    allowed_hosts: tuple[str, ...] = ()

    @property
    def blocked(self) -> bool:
        return self.mode == MODE_DENY

    def audit(self) -> dict:
        """Flat dict for the sidecar invocation ledger / decision log."""
        return {
            "egress_requested": self.requested,
            "egress_mode": self.mode,
            "egress_runtime": self.runtime,
            "egress_enforceable": self.enforceable,
            "egress_downgraded": self.downgraded,
            "egress_reason": self.reason,
            "egress_network": self.network_name,
            "egress_allowed_hosts": list(self.allowed_hosts),
        }


def normalize_posture(value: Optional[str]) -> str:
    """Coerce free-form input to a known posture; unknown → the safest one."""
    v = (value or "").strip().lower()
    if v in _POSTURES:
        return v
    if v in ("none", "off", "no", "false", "0"):
        return POSTURE_ISOLATED
    if v in ("all", "any", "unrestricted", "true", "1", "yes"):
        return POSTURE_OPEN
    return POSTURE_ISOLATED


def requested_posture(sandbox_network, boundary: Optional[dict] = None) -> str:
    """Map IVE's existing config onto a posture.

    ``sandbox_network`` is the workspaces column (INTEGER DEFAULT 1); ``boundary``
    is an allow/deny network-policy dict. Network off → isolated. Network on with an
    allow/block list → filtered. Network on with no list → open.
    """
    if not sandbox_network:
        return POSTURE_ISOLATED
    if isinstance(boundary, dict):
        for key in ("allowed_domains", "blocked_domains", "allowed_hosts", "allow", "deny"):
            if boundary.get(key):
                return POSTURE_FILTERED
    return POSTURE_OPEN


def isolated_network_name(scope: Optional[str] = None) -> str:
    """Deterministic internal-network name for a scope (usually workspace id).

    Per-scope rather than one shared network: --internal cuts internet, host and
    CROSS-network traffic, but containers on the SAME network still reach each
    other, and a connector sidecar's environment carries credentials.

    The readable token is only a label — uniqueness comes from the digest of the
    full scope. A bare truncation would collapse ids sharing a prefix
    ("customer-alpha-01"/"-02") onto one network and silently make two
    workspaces peers.
    """
    raw = "" if scope is None else str(scope)
    token = "".join(ch for ch in raw if ch.isalnum())[:8].lower() or "default"
    digest = hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest()[:10]
    return f"{ISOLATED_NETWORK_PREFIX}-{token}-{digest}"


WORKLOAD_NETWORK_PREFIX = "ive-net"


def workspace_network_name(scope: Optional[str] = None) -> str:
    """Per-workspace NAT network shared by a workspace's own containers.

    The app and the browser that renders it must reach EACH OTHER, and the app
    usually needs a registry, so this network is NAT (not --internal). What it
    buys over the shared default network is the other direction: cross-network
    traffic is cut, so one workspace's untrusted app cannot reach another
    workspace's containers — and a connector sidecar's environment carries
    credentials. The host can still dial in, which is how CDP works.
    """
    raw = "" if scope is None else str(scope)
    token = "".join(ch for ch in raw if ch.isalnum())[:8].lower() or "default"
    digest = hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest()[:10]
    return f"{WORKLOAD_NETWORK_PREFIX}-{token}-{digest}"


def create_workload_network_argv(name: str) -> list[str]:
    """NAT, deliberately: these containers need each other and the registry."""
    return ["container", "network", "create", name]


async def ensure_workspace_network(name: str, runner: Callable) -> bool:
    """Ensure the shared per-workspace NAT network exists.

    Unlike the isolated network this does NOT require hostOnly mode — requiring
    it would be wrong, since the whole point is that these containers can talk.
    """
    try:
        rc, _out, _err = await runner(*network_exists_argv(name))
        if rc == 0:
            return True
    except Exception:
        pass
    try:
        rc, _out, err = await runner(*create_workload_network_argv(name))
        if rc == 0:
            return True
        if "exist" not in str(err).lower():
            return False
        rc2, _o2, _e2 = await runner(*network_exists_argv(name))
        return rc2 == 0
    except Exception:
        return False


def override_enabled(env: Optional[dict] = None) -> bool:
    """True when an operator has explicitly allowed unfiltered fallback."""
    src = env if env is not None else os.environ
    return str(src.get(_OVERRIDE_ENV, "")).strip().lower() in _TRUE_SET


def proxy_env(proxy_url: str, allowed_hosts: Iterable[str] = ()) -> dict:
    """Standard proxy env for a run whose egress is forced through a proxy."""
    no_proxy = ",".join(["localhost", "127.0.0.1", *[h for h in allowed_hosts if h]])
    return {
        "HTTP_PROXY": proxy_url, "http_proxy": proxy_url,
        "HTTPS_PROXY": proxy_url, "https_proxy": proxy_url,
        "NO_PROXY": no_proxy, "no_proxy": no_proxy,
    }


def decide(
    requested,
    runtime: str,
    *,
    allowed_hosts: Iterable[str] = (),
    proxy_url: Optional[str] = None,
    scope: Optional[str] = None,
    env: Optional[dict] = None,
) -> EgressDecision:
    """Reconcile a requested posture against what ``runtime`` can deliver.

    ``proxy_url`` is an already-running allowlisting proxy the sandbox can reach
    (callers get one from ``egress_policy.start_egress_proxy``); absent, filtering
    cannot be delivered. ``scope`` names the isolated network (workspace id).
    Never raises.
    """
    posture = normalize_posture(requested if isinstance(requested, str) else
                                (POSTURE_OPEN if requested else POSTURE_ISOLATED))
    cap = capability_for(runtime)
    hosts = tuple(h for h in (allowed_hosts or ()) if h)
    allow_open_fallback = override_enabled(env)

    def _isolated(reason: str, downgraded: bool) -> EgressDecision:
        name = isolated_network_name(scope)
        args: tuple[str, ...] = ()
        if cap.runtime in ("apple-container", "docker"):
            args = ("--network", name)
        return EgressDecision(
            mode=MODE_ISOLATED, requested=posture, runtime=cap.runtime, reason=reason,
            enforceable=(cap.isolation == ENFORCED), downgraded=downgraded,
            container_args=args, network_name=name, allowed_hosts=hosts,
        )

    def _deny(reason: str) -> EgressDecision:
        return EgressDecision(
            mode=MODE_DENY, requested=posture, runtime=cap.runtime, reason=reason,
            enforceable=True, downgraded=False, allowed_hosts=hosts,
        )

    def _open(reason: str, downgraded: bool) -> EgressDecision:
        return EgressDecision(
            mode=MODE_OPEN, requested=posture, runtime=cap.runtime, reason=reason,
            enforceable=False, downgraded=downgraded, allowed_hosts=hosts,
        )

    # ── open: nothing to reconcile ───────────────────────────────────────
    if posture == POSTURE_OPEN:
        return _open("unrestricted egress requested", downgraded=False)

    # ── isolated: deliverable wherever isolation is not impossible ───────
    if posture == POSTURE_ISOLATED:
        if cap.isolation == ENFORCED:
            return _isolated(f"isolated network enforced by {cap.runtime}", downgraded=False)
        if cap.isolation == BEST_EFFORT:
            return _isolated(
                f"{cap.runtime} cannot cut the socket layer; isolation is advisory only",
                downgraded=False,
            )
        return _deny(f"{cap.runtime} cannot withhold network access ({cap.note})")

    # ── filtered: the case the whole module exists for ───────────────────
    if not hosts:
        # An empty allowlist is a request for nothing, not for everything.
        return _isolated("filtered egress requested with an empty allowlist", downgraded=False)

    if cap.filtering in (ENFORCED, BEST_EFFORT) and proxy_url:
        return EgressDecision(
            mode=MODE_PROXY, requested=posture, runtime=cap.runtime,
            reason=(
                f"egress forced through {proxy_url} ({len(hosts)} host(s) allowed)"
                if cap.filtering == ENFORCED else
                f"proxy env set for {proxy_url}, but {cap.runtime} cannot stop a client that ignores it"
            ),
            enforceable=(cap.filtering == ENFORCED), downgraded=False,
            env=proxy_env(proxy_url, hosts), allowed_hosts=hosts,
        )

    if cap.filtering in (ENFORCED, BEST_EFFORT) and not proxy_url:
        reason = f"{cap.runtime} can filter but no egress proxy is running"
        if cap.isolation != IMPOSSIBLE:
            return _isolated(reason + "; narrowed to no egress", downgraded=True)
        if allow_open_fallback:
            return _open(reason + f"; {_OVERRIDE_ENV} widened it to unrestricted", downgraded=True)
        return _deny(reason + "; refusing rather than widening to unrestricted")

    # filtering IMPOSSIBLE on this runtime.
    reason = f"{cap.runtime} has no per-destination filtering ({cap.note})"
    if cap.isolation != IMPOSSIBLE:
        return _isolated(
            reason + "; narrowed to no egress (a subset of the requested allowlist) — "
            "package registries are unreachable in this mode",
            downgraded=True,
        )
    if allow_open_fallback:
        return _open(reason + f"; {_OVERRIDE_ENV} widened it to unrestricted", downgraded=True)
    return _deny(reason + "; refusing rather than widening to unrestricted")


# ─── Internal-network provisioning (argv only; caller executes) ─────────

def create_network_argv(name: str) -> list[str]:
    """argv that creates the isolated network. Idempotent at the caller: an
    existing network makes this fail with "already exists", which is success."""
    return ["container", "network", "create", "--internal", name]


def network_exists_argv(name: str) -> list[str]:
    return ["container", "network", "inspect", name]


def network_is_internal(inspect_output: str) -> bool:
    """True only when `container network inspect` proves the network is internal.

    Unparseable output or a missing/!= hostOnly mode returns False: a network
    that merely has the right NAME is not evidence of isolation, and treating it
    as such is precisely the silent-widening this module exists to prevent.
    """
    try:
        data = json.loads(inspect_output)
        entry = data[0] if isinstance(data, list) and data else data
        if not isinstance(entry, dict):
            return False
        cfg = entry.get("configuration")
        cfg = cfg if isinstance(cfg, dict) else {}
        return str(cfg.get("mode") or "").strip().lower() == INTERNAL_NETWORK_MODE
    except Exception:
        return False


async def ensure_isolated_network(
    name: str,
    runner: Callable,
) -> bool:
    """Ensure an ACTUALLY-internal network of this name exists.

    ``runner(*argv) -> (rc, out, err)``. Returns True only when the network
    exists AND inspect confirms it is internal — an existing NAT network that
    happens to carry the name is rejected rather than used. Injectable runner so
    a unit run never touches the real CLI.
    """
    try:
        rc, out, _err = await runner(*network_exists_argv(name))
        if rc == 0:
            return network_is_internal(out)
    except Exception:
        pass
    try:
        rc, _out, err = await runner(*create_network_argv(name))
        if rc == 0:
            return True
        if "exist" not in str(err).lower():
            return False
        # Lost a race with a concurrent create — confirm what actually landed.
        rc2, out2, _err2 = await runner(*network_exists_argv(name))
        return rc2 == 0 and network_is_internal(out2)
    except Exception:
        return False


def describe_capabilities() -> list[dict]:
    """Capability table for the settings UI / API."""
    return [
        {
            "runtime": c.runtime,
            "filtering": c.filtering,
            "isolation": c.isolation,
            "note": c.note,
        }
        for c in CAPABILITIES.values()
    ]
