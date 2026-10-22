"""Secure-agent network control plane — NO-SUDO single-IP egress allowlist.

Phase 0 of the Secure ("offensive self-test") capability. Confines a Kali container so it can
reach EXACTLY ONE target IP (internet, LAN, or another container) and nothing else — not the host
Mac, not the rest of the LAN, not the rest of the internet. Proven on `container` v1.0.0 /
macOS 26.5; see SECURE_AGENT_DESIGN.md §8.6.

Mechanism (zero host privilege — no pfctl, no sudo, no admin helper):
  - inner net  : `--internal` (no internet / host / LAN by routing)        ← Kali lives here
  - outer net  : normal network (has NAT/internet)                          ← only the gateway
  - gateway    : a container dual-homed on BOTH nets, with --cap-add NET_ADMIN, running an
                 iptables allowlist that FORWARDs Kali -> TARGET_IP only and MASQUERADEs out.
  - Kali       : inner-only; default route -> gateway. Its ONLY egress is the gateway, so even a
                 root agent cannot bypass (re-routing only self-isolates).

The allowlist enforcement runs inside the gateway's OWN microVM (hypervisor-isolated from Kali),
so the agent — root though it is in its own VM — cannot reach or rewrite it. Same "enforcement
outside the blast radius" property as host pf, without the privilege.

DISCIPLINE (mirrors the pf-helper spec, SECURE_AGENT_DESIGN.md §8): the caller hands this module a
*target to clamp to*, never rule text. Targets are parsed into typed `ipaddress` objects and only
those are formatted into the gateway's fixed iptables template; the host IP / gateway / self /
0.0.0.0 / broadcast are rejected. There is no input that can express "allow all".

Everything shells out to the `container` CLI and degrades to a clear error if it is absent.
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

_PREFIX = "ive-secure-"
# Pool of /24s we are willing to allocate for Secure runs (kept clear of container's `default`
# 192.168.64.0/24). inner = pool[0], outer = pool[1] offset from a per-run base.
_INNER_POOL_BASE = 96   # 192.168.96.x .. used as inner
_OUTER_POOL_BASE = 160  # 192.168.160.x .. used as outer
_MAX_PORTS = 32

_GATEWAY_IMAGE = os.environ.get("SECURE_GATEWAY_IMAGE", "alpine:3.20")
_KALI_IMAGE = os.environ.get("SECURE_CONTAINER_IMAGE", "alpine:3.20")  # alpine = dev stand-in


# ─── Errors ──────────────────────────────────────────────────────────────

class SecureNetError(RuntimeError):
    """Any provisioning/validation failure. Fail-closed: callers must abort the run."""


# ─── Input validation (the §8 discipline) ────────────────────────────────

def validate_target(target_ip: str, ports, *, inner_subnet: ipaddress.IPv4Network,
                    gateway_ip: Optional[str] = None, kali_ip: Optional[str] = None) -> tuple[str, list[int]]:
    """Parse + reject. Returns (canonical_ip, sorted_unique_ports) or raises SecureNetError.

    Rejects: unparseable, multicast/loopback/unspecified, the inner subnet's broadcast, the host
    gateway, Kali itself. A target INSIDE the inner subnet is allowed (it's a peer container); a
    target outside (LAN/internet) is allowed too — the gateway forwards to it. What is NEVER
    allowed is a value that can't be parsed to a single concrete host address.
    """
    try:
        ip = ipaddress.ip_address(target_ip)
    except ValueError as e:
        raise SecureNetError(f"target_ip not a valid IP: {target_ip!r} ({e})")
    if not isinstance(ip, ipaddress.IPv4Address):
        raise SecureNetError("only IPv4 targets are supported")
    if ip.is_loopback or ip.is_multicast or ip.is_unspecified or ip.is_link_local:
        raise SecureNetError(f"target {ip} is a special/reserved address")
    if ip == inner_subnet.broadcast_address or ip == inner_subnet.network_address:
        raise SecureNetError(f"target {ip} is a network/broadcast address")
    if gateway_ip and str(ip) == str(gateway_ip):
        raise SecureNetError("target is the gateway")
    if kali_ip and str(ip) == str(kali_ip):
        raise SecureNetError("target is Kali itself")

    try:
        port_list = sorted({int(p) for p in ports})
    except (TypeError, ValueError) as e:
        raise SecureNetError(f"ports must be integers: {ports!r} ({e})")
    if not port_list or len(port_list) > _MAX_PORTS:
        raise SecureNetError(f"port count must be 1..{_MAX_PORTS}")
    if any(not (1 <= p <= 65535) for p in port_list):
        raise SecureNetError("ports must be in 1..65535")
    return str(ip), port_list


# ─── container CLI plumbing ───────────────────────────────────────────────

async def _run(*args: str, timeout: float = 60.0) -> tuple[int, str]:
    """Run a command; return (rc, combined_output). rc=127 if the binary is missing."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            return 124, f"timeout after {timeout}s"
        return proc.returncode or 0, out.decode(errors="ignore")
    except FileNotFoundError:
        return 127, "container CLI not found"
    except Exception as exc:  # pragma: no cover
        logger.debug("secure_net _run failed: %s", exc)
        return 1, str(exc)


async def _exec(container: str, script: str, timeout: float = 60.0) -> tuple[int, str]:
    """Run a /bin/sh script inside a container via `container exec`."""
    return await _run("container", "exec", container, "sh", "-c", script, timeout=timeout)


async def _container_ipv4(name: str, subnet_prefix: str) -> Optional[str]:
    """The container's IPv4 on the network whose addresses start with `subnet_prefix`."""
    rc, out = await _run("container", "inspect", name)
    if rc != 0:
        return None
    try:
        data = json.loads(out)
    except Exception:
        return None
    rows = data if isinstance(data, list) else [data]
    for row in rows:
        # Runtime-assigned IPs live under status.networks[].ipv4Address (CIDR). The
        # configuration.networks only records the requested attachment (no IP yet).
        nets = ((row.get("status") or {}).get("networks")
                or row.get("networks")  # fallback for other CLI versions
                or [])
        for net in nets:
            addr = (net.get("ipv4Address") or "").split("/")[0]
            if addr.startswith(subnet_prefix):
                return addr
    return None


async def _wait_ipv4(name: str, subnet_prefix: str, tries: int = 15, delay: float = 0.6) -> Optional[str]:
    for _ in range(tries):
        ip = await _container_ipv4(name, subnet_prefix)
        if ip:
            return ip
        await asyncio.sleep(delay)
    return None


# ─── Run handle ────────────────────────────────────────────────────────────

@dataclass
class SecureRun:
    run_id: str
    inner_net: str
    outer_net: str
    inner_subnet: str
    outer_subnet: str
    gateway: str
    kali: str
    targets: list[dict]          # [{ip, ports:[...]}] — the validated allowlist
    gateway_inner_ip: str = ""
    kali_ip: str = ""
    notes: list[str] = field(default_factory=list)

    @property
    def target_ip(self) -> str:
        """Primary target IP (first) — convenience for single-target callers/UI."""
        return self.targets[0]["ip"] if self.targets else ""

    @property
    def ports(self) -> list[int]:
        return self.targets[0]["ports"] if self.targets else []


# ─── Provision / teardown ──────────────────────────────────────────────────

def _safe_name(run_id: str) -> str:
    """Container/network names must be lowercase [a-z0-9-]. A session id is usually a lowercase
    uuid (already safe → identity), but sanitize defensively so any id is valid + consistent
    (same id → same name, so teardown/GC line up)."""
    s = re.sub(r"[^a-z0-9-]", "-", str(run_id).lower()).strip("-")
    return (s or "run")[:48]


def _names(run_id: str) -> dict:
    base = f"{_PREFIX}{_safe_name(run_id)}"
    return {
        "inner": f"{base}-inner", "outer": f"{base}-outer",
        "gateway": f"{base}-gw", "kali": f"{base}-kali",
    }


def _normalize_targets(targets, inner_subnet: str) -> list[dict]:
    """Coerce + validate a target spec into [{ip, ports:[...]}] using validate_target.

    Accepts: a SecureScope (has .targets of SecureTarget), a list of dicts/tuples, or a single
    (ip, ports). Each target is run through validate_target (rejects host/loopback/broadcast/bad
    ports) so a malformed/over-broad allowlist can never be provisioned.
    """
    net = ipaddress.ip_network(inner_subnet)
    raw: list = []
    if hasattr(targets, "targets"):                 # SecureScope
        raw = [{"ip": t.ip, "ports": t.ports} for t in targets.targets]
    elif isinstance(targets, dict):
        raw = [targets]
    elif isinstance(targets, (list, tuple)):
        raw = list(targets)
    else:
        raise SecureNetError(f"unsupported targets spec: {type(targets).__name__}")
    if not raw:
        raise SecureNetError("at least one target required")
    out: list[dict] = []
    for item in raw:
        if isinstance(item, dict):
            ip, ports = item.get("ip"), item.get("ports")
        elif isinstance(item, (list, tuple)) and len(item) == 2:
            ip, ports = item
        else:
            raise SecureNetError(f"bad target entry: {item!r}")
        cip, cports = validate_target(ip, ports, inner_subnet=net)
        out.append({"ip": cip, "ports": cports})
    return out


async def provision(run_id: str, targets, *,
                    kali_image: Optional[str] = None,
                    gateway_image: Optional[str] = None) -> SecureRun:
    """Stand up the no-sudo clamp: nets + gateway(allowlist) + kali(routed). Fail-closed.

    `targets` may be a SecureScope, a list of {ip, ports}, or a single {ip, ports}. Aborts (raises
    SecureNetError) and best-effort tears down if any step fails — there is never a Kali container
    without its egress clamp in place.
    """
    n = _names(run_id)
    # Deterministic subnets from a stable digest of run_id (hash() is salted per-process; sha256
    # is reproducible across restarts so teardown/GC line up).
    idx = int(hashlib.sha256(run_id.encode()).hexdigest(), 16) % 32
    inner_subnet = f"192.168.{_INNER_POOL_BASE + idx}.0/24"
    outer_subnet = f"192.168.{_OUTER_POOL_BASE + idx}.0/24"
    inner_prefix = inner_subnet.rsplit(".", 1)[0] + "."   # "192.168.NN."
    outer_gw = outer_subnet.rsplit(".", 1)[0] + ".1"
    kali_image = kali_image or _KALI_IMAGE
    gateway_image = gateway_image or _GATEWAY_IMAGE

    target_list = _normalize_targets(targets, inner_subnet)

    run = SecureRun(run_id=run_id, inner_net=n["inner"], outer_net=n["outer"],
                    inner_subnet=inner_subnet, outer_subnet=outer_subnet,
                    gateway=n["gateway"], kali=n["kali"], targets=target_list)
    try:
        rc, out = await _run("container", "network", "create", "--internal",
                             "--subnet", inner_subnet, n["inner"])
        if rc != 0:
            raise SecureNetError(f"create inner net failed: {out.strip()}")
        rc, out = await _run("container", "network", "create",
                             "--subnet", outer_subnet, n["outer"])
        if rc != 0:
            raise SecureNetError(f"create outer net failed: {out.strip()}")

        # Gateway: dual-homed, NET_ADMIN. (--network order => eth0=inner, eth1=outer.)
        rc, out = await _run("container", "run", "-d", "--name", n["gateway"],
                             "--network", n["inner"], "--network", n["outer"],
                             "--cap-add", "NET_ADMIN", gateway_image, "sleep", "infinity")
        if rc != 0:
            raise SecureNetError(f"start gateway failed: {out.strip()}")
        run.gateway_inner_ip = await _wait_ipv4(n["gateway"], inner_prefix) or ""
        if not run.gateway_inner_ip:
            raise SecureNetError("gateway did not acquire an inner IP")

        await _install_gateway_allowlist(n["gateway"], inner_subnet, target_list, outer_gw)

        # Kali: inner-only, NET_ADMIN(route)+NET_RAW(scan tools). Default route -> gateway.
        rc, out = await _run("container", "run", "-d", "--name", n["kali"],
                             "--network", n["inner"], "--cap-add", "NET_ADMIN",
                             "--cap-add", "NET_RAW", kali_image, "sleep", "infinity")
        if rc != 0:
            raise SecureNetError(f"start kali failed: {out.strip()}")
        run.kali_ip = await _wait_ipv4(n["kali"], inner_prefix) or ""
        rc, out = await _exec(n["kali"], f"ip route replace default via {run.gateway_inner_ip}")
        if rc != 0:
            raise SecureNetError(f"set kali default route failed: {out.strip()}")
        tgt_str = ", ".join(f"{t['ip']}:{t['ports']}" for t in target_list)
        run.notes.append(f"kali {run.kali_ip} -> gw {run.gateway_inner_ip} -> [{tgt_str}]")
        return run
    except Exception:
        await teardown(run_id)
        raise


async def _install_gateway_allowlist(gateway: str, inner_subnet: str, targets: list[dict],
                                     outer_gw: str) -> None:
    """Program the gateway's iptables allowlist — one ACCEPT per validated target, default DROP.

    Production bakes iptables into the gateway image (SECURE_GATEWAY_IMAGE); on the alpine dev
    stand-in we `apk add` it only if missing. Rules are built from validated IP/port objects only —
    no raw caller strings ever reach iptables syntax.
    """
    rules = []
    for t in targets:
        ip = t["ip"]
        port_match = ",".join(str(p) for p in t["ports"])
        rules.append(f"iptables -A FORWARD -d {ip} -p tcp -m multiport --dports {port_match} -j ACCEPT")
        rules.append(f"iptables -A FORWARD -d {ip} -p udp -m multiport --dports {port_match} -j ACCEPT")
        rules.append(f"iptables -A FORWARD -d {ip} -p icmp -j ACCEPT")
    rules_str = "; ".join(rules)
    script = (
        # gateway needs internet to fetch iptables on the stand-in; route via outer net.
        f"ip route replace default via {outer_gw}; "
        "printf 'nameserver 1.1.1.1\\n' > /etc/resolv.conf; "
        "command -v iptables >/dev/null 2>&1 || apk add --no-cache iptables >/dev/null 2>&1; "
        "command -v iptables >/dev/null 2>&1 || { echo 'NO_IPTABLES'; exit 3; }; "
        "echo 1 > /proc/sys/net/ipv4/ip_forward; "
        "for f in /proc/sys/net/ipv4/conf/*/rp_filter; do echo 0 > $f; done; "
        "iptables -P FORWARD DROP; "
        f"{rules_str}; "
        "iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT; "
        f"iptables -t nat -A POSTROUTING -s {inner_subnet} ! -d {inner_subnet} -o eth1 -j MASQUERADE; "
        "echo OK"
    )
    rc, out = await _exec(gateway, script, timeout=120.0)
    if rc != 0 or "OK" not in out:
        raise SecureNetError(f"gateway allowlist setup failed: {out.strip()[-300:]}")


async def teardown(run_id: str) -> dict:
    """Stop+remove gateway/kali and delete both nets. Idempotent, best-effort."""
    n = _names(run_id)
    removed = []
    for c in (n["kali"], n["gateway"]):
        await _run("container", "stop", c)
        rc, _ = await _run("container", "rm", c)
        if rc == 0:
            removed.append(c)
    nets = []
    for net in (n["inner"], n["outer"]):
        rc, _ = await _run("container", "network", "delete", net)
        if rc == 0:
            nets.append(net)
    return {"containers_removed": removed, "networks_removed": nets}


# ─── Command bridge (Phase 2 will gate this behind the Sonnet check) ───────

async def exec_in_kali(run_id: str, argv: list[str], timeout: float = 300.0) -> tuple[int, str]:
    """Run a command inside the Secure (Kali) container. Phase 2 wraps this with the scope-aware
    Sonnet pre-exec check; on its own this is just the raw bridge."""
    n = _names(run_id)
    return await _run("container", "exec", n["kali"], *argv, timeout=timeout)


# ─── Verification harness (the Phase 0 GATE) ──────────────────────────────

async def verify_isolation(run: SecureRun, *, denied_probe_ip: Optional[str] = None) -> dict:
    """Prove the clamp from INSIDE Kali. Returns a report + overall `contained` verdict.

    Reliable signals (avoids the flaky busybox `nc -z` / HTTP-redirect false-negatives):
      * target_forwarded — after a Kali attempt, the GATEWAY's conntrack shows `dst=<target>`,
        proving the allow rule forwarded it (independent of whether the target actually replies).
      * denied_ip_blocked / host_gateway_blocked — a Kali ping that FAILS = blocked (a false ping
        failure only ever over-reports "blocked", which is the safe direction).
    """
    kali, gw = run.kali, run.gateway
    target = run.targets[0]
    tip, tport = target["ip"], target["ports"][0]
    inner_gw = run.inner_subnet.rsplit(".", 1)[0] + ".1"
    target_ips = {t["ip"] for t in run.targets}

    denied = denied_probe_ip or "8.8.8.8"
    for cand in ("8.8.8.8", "9.9.9.9", "203.0.113.7"):   # last is TEST-NET-3, never a real target
        if cand not in target_ips:
            denied = cand
            break

    async def _ping_ok(ip: str) -> bool:
        _, out = await _exec(kali, f"ping -c1 -W3 {ip} >/dev/null 2>&1 && echo HIT || echo MISS")
        return "HIT" in out

    # 1. allowed target: poke it from Kali, then read the gateway's iptables FORWARD counters.
    #    A nonzero packet count on an ACCEPT rule whose destination is the target proves the
    #    gateway FORWARDED the allowed traffic — reliable even when the target never replies and
    #    even on a stand-in image without /proc/net/nf_conntrack. Retry to absorb boot timing.
    target_forwarded = False
    for _ in range(3):
        await _exec(kali, f"(nc -w4 {tip} {tport} </dev/null >/dev/null 2>&1 &); "
                          f"ping -c1 -W2 {tip} >/dev/null 2>&1; sleep 1")
        _, fw = await _exec(gw, "iptables -L FORWARD -v -n 2>/dev/null")
        for line in fw.splitlines():
            cols = line.split()
            if tip in line and cols and cols[0].isdigit() and int(cols[0]) > 0:
                target_forwarded = True
                break
        if target_forwarded:
            break

    denied_blocked = not await _ping_ok(denied)
    host_blocked = not await _ping_ok(inner_gw)

    report = {
        "target_forwarded": target_forwarded,
        "denied_ip_blocked": denied_blocked,
        "host_gateway_blocked": host_blocked,
        "target_ip": tip,
        "denied_probe_ip": denied,
    }
    report["contained"] = bool(target_forwarded and denied_blocked and host_blocked)
    return report


# ─── Garbage collection (reconciler hook) ─────────────────────────────────

async def list_secure_artifacts() -> dict:
    """Running ive-secure-* containers and networks, grouped by run_id. For the WS-5 reconciler."""
    runs: dict[str, dict] = {}
    _, cout = await _run("container", "ls", "-a")
    for line in cout.splitlines():
        for tok in line.split():
            if tok.startswith(_PREFIX) and (tok.endswith("-gw") or tok.endswith("-kali")):
                rid = tok[len(_PREFIX):].rsplit("-", 1)[0]
                runs.setdefault(rid, {"containers": [], "networks": []})["containers"].append(tok)
    _, nout = await _run("container", "network", "ls")
    for line in nout.splitlines():
        for tok in line.split():
            if tok.startswith(_PREFIX) and (tok.endswith("-inner") or tok.endswith("-outer")):
                rid = tok[len(_PREFIX):].rsplit("-", 1)[0]
                runs.setdefault(rid, {"containers": [], "networks": []})["networks"].append(tok)
    return runs


async def reap_orphans(live_run_ids, dry_run: bool = False) -> dict:
    """Tear down any ive-secure run whose run_id is NOT in live_run_ids (crashed/leaked)."""
    # list_secure_artifacts keys are the SAFE name tokens (reverse-mapped from container/net
    # names), so sanitize the live ids the same way before comparing.
    live = {_safe_name(x) for x in (live_run_ids or [])}
    artifacts = await list_secure_artifacts()
    orphans = [rid for rid in artifacts if rid not in live]
    reaped = []
    for rid in orphans:
        if not dry_run:
            await teardown(rid)
        reaped.append(rid)
    if reaped and not dry_run:
        logger.info("secure_net reaped %d orphan run(s): %s", len(reaped), reaped)
    return {"runs": list(artifacts), "orphans": orphans, "reaped": reaped, "dry_run": dry_run}


# ─── CLI (codifies the Phase 0 gate so it's runnable end-to-end) ──────────

def _amain():
    import argparse
    ap = argparse.ArgumentParser(description="Secure-agent no-sudo network clamp (Phase 0).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    up = sub.add_parser("up", help="provision + verify")
    up.add_argument("run_id"); up.add_argument("target_ip")
    up.add_argument("--ports", default="80,443")
    up.add_argument("--kali-image", default=None); up.add_argument("--gateway-image", default=None)
    ex = sub.add_parser("exec"); ex.add_argument("run_id"); ex.add_argument("argv", nargs=argparse.REMAINDER)
    dn = sub.add_parser("down"); dn.add_argument("run_id")
    args = ap.parse_args()

    async def _go():
        if args.cmd == "up":
            ports = [int(p) for p in args.ports.split(",") if p.strip()]
            run = await provision(args.run_id, [{"ip": args.target_ip, "ports": ports}],
                                  kali_image=args.kali_image, gateway_image=args.gateway_image)
            print("provisioned:", json.dumps(run.__dict__, default=str, indent=2))
            print("verify:", json.dumps(await verify_isolation(run), indent=2))
        elif args.cmd == "exec":
            rc, out = await exec_in_kali(args.run_id, args.argv or ["sh", "-c", "id"])
            print(out); raise SystemExit(rc)
        elif args.cmd == "down":
            print(json.dumps(await teardown(args.run_id), indent=2))

    asyncio.run(_go())


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    _amain()
