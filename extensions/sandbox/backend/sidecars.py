"""§2.4/§2.5: long-lived per-workspace sidecar containers and the host->sidecar hop.

A CONNECTOR is the callable capability (in/out data) an agent system invokes; a SIDECAR is the
long-lived container hosting one or more connectors. This module owns the sidecar lifecycle and
nothing else — it does not touch the one-shot session-sandbox tier (sandbox_engine) and does not
decide any isolation or egress posture.

Why a second container shape at all: the sandbox tier runs ``container run --rm -i``, so the
container dies with the command and ``--rm`` deletes it along with its logs. A connector host has
to outlive a single call, so sidecars are ``container run --detach`` and NEVER ``--rm``:

  * ``container logs`` keeps working after ``container stop`` — post-mortem audit survives, and
    old lines survive a restart. Only ``container rm``/``prune`` destroy them, which is why
    delete goes through capture_forensics first.
  * ``container stop`` + ``container start`` preserves the filesystem, so a restart is a restart
    and not a fresh machine.
  * THE IP CHANGES ACROSS A RESTART (observed 192.168.64.13 -> .14, monotonic allocation). Every
    address here is re-read from ``container inspect`` after a start; stop clears the recorded
    address so a stale one cannot outlive the container that owned it.
  * ``container exec`` output does NOT appear in ``container logs`` — only the init process's
    stdio does. Connector calls ride exec, so the IVE-side ledger in container_registry is the
    only place they are recorded.

Networking: connectors are reached at the container's own IP (see sidecar_http_target), so a
sidecar attaches to the default `container` network unless the caller passes network="none".
This module applies no egress filtering of its own and changes nothing about the sandbox tier's
posture.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time

from aiohttp import web

import container_registry as cr

logger = logging.getLogger(__name__)

DEFAULT_IMAGE = os.environ.get("IVE_SIDECAR_IMAGE", "docker.io/library/python:3.13-slim")
DEFAULT_HTTP_PORT = int(os.environ.get("IVE_SIDECAR_HTTP_PORT") or 8080)
DEFAULT_EXEC_TIMEOUT = float(os.environ.get("IVE_SIDECAR_EXEC_TIMEOUT_S") or 30.0)
START_SETTLE_S = float(os.environ.get("IVE_SIDECAR_START_SETTLE_S") or 0.0)
# Init process when the caller supplies none: stay up so connectors can be exec'd/served into it.
DEFAULT_COMMAND = ["sh", "-c", "exec sleep infinity"]
HEALTH_COMMAND = ["sh", "-c", "exit 0"]
LOGS_DEFAULT_TAIL = 200

# Container names are the join key between IVE and the CLI, so a bad component is REJECTED rather
# than sanitized: mangling two different workspace ids into one name would silently merge them.
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


class SidecarError(RuntimeError):
    pass


def _validate(workspace_id: str, name: str) -> tuple[str, str]:
    ws, nm = str(workspace_id or ""), str(name or "")
    if not _NAME_RE.match(ws):
        raise SidecarError(f"invalid workspace_id for a container name: {ws!r}")
    if not _NAME_RE.match(nm):
        raise SidecarError(f"invalid sidecar name: {nm!r}")
    return ws, nm


def container_name(workspace_id: str, name: str) -> str:
    ws, nm = _validate(workspace_id, name)
    return cr.sidecar_container_name(ws, nm)


# ── the one subprocess boundary (tests mock exactly here) ────────────────────

async def _run(*args: str, timeout: float | None = None) -> tuple[int, str, str]:
    """Run a `container` CLI command -> (rc, stdout, stderr). rc 127 == CLI absent."""
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode or 0, out.decode(errors="ignore"), err.decode(errors="ignore")
    except FileNotFoundError:
        return 127, "", "container CLI not found"
    except asyncio.TimeoutError:
        if proc is not None:
            try:
                proc.kill()
                await proc.wait()
            except Exception:
                pass
        return 124, "", f"timeout after {timeout}s"
    except Exception as exc:  # pragma: no cover
        logger.debug("sidecars _run failed: %s", exc)
        return 1, "", str(exc)


# ── inspect parsing ──────────────────────────────────────────────────────────

def _first_entry(text: str):
    try:
        data = json.loads(text)
    except Exception:
        return None
    if isinstance(data, list):
        return data[0] if data else None
    return data if isinstance(data, dict) else None


def parse_inspect(text: str) -> dict:
    """(state, ip, gateway, started_at, image, image_digest, provenance) from `container inspect`.

    IP lives at status.networks[0].ipv4Address with a /24 suffix that has to come off before the
    address is usable as a dial target.
    """
    entry = _first_entry(text)
    if not entry:
        return {}
    status = entry.get("status") if isinstance(entry.get("status"), dict) else {}
    cfg = entry.get("configuration") if isinstance(entry.get("configuration"), dict) else {}
    nets = status.get("networks") or []
    net0 = nets[0] if nets and isinstance(nets[0], dict) else {}
    ip = str(net0.get("ipv4Address") or "").split("/")[0].strip() or None
    # A STOPPED container reports status.networks == [] — the attachment only
    # survives under configuration.networks. The name is read from there as a
    # fallback; the ADDRESS deliberately is not, because a stopped container has
    # no valid address and reviving a stale one is the bug the IP re-read exists
    # to prevent.
    cfg_nets = cfg.get("networks") or []
    cfg_net0 = cfg_nets[0] if cfg_nets and isinstance(cfg_nets[0], dict) else {}
    image = cfg.get("image") if isinstance(cfg.get("image"), dict) else {}
    descriptor = image.get("descriptor") if isinstance(image.get("descriptor"), dict) else {}
    init = cfg.get("initProcess") if isinstance(cfg.get("initProcess"), dict) else {}
    return {
        "state": str(status.get("state") or "").lower() or "unknown",
        "ip": ip,
        "gateway": str(net0.get("ipv4Gateway") or "") or None,
        # The network a container was CREATED on. `container start` cannot move an
        # existing container to another network, so an egress posture change has to
        # be detected here rather than silently ignored on restart.
        "network": (str(net0.get("network") or "") or
                    str(cfg_net0.get("network") or "") or None),
        "started_at": status.get("startedDate"),
        "image": image.get("reference"),
        "image_digest": descriptor.get("digest"),
        "provenance": {
            "image": image.get("reference"),
            "image_digest": descriptor.get("digest"),
            "creation_date": cfg.get("creationDate"),
            "executable": init.get("executable"),
            "arguments": init.get("arguments"),
            # Names only: a connector sidecar's environment carries credentials, and provenance
            # is kept in the same DB the rest of IVE reads.
            "environment_keys": [str(e).split("=", 1)[0] for e in (init.get("environment") or [])],
            "cap_add": cfg.get("capAdd"),
            "cap_drop": cfg.get("capDrop"),
            "read_only": cfg.get("readOnly"),
        },
    }


async def _inspect(cname: str) -> dict:
    rc, out, err = await _run("container", "inspect", cname, timeout=DEFAULT_EXEC_TIMEOUT)
    if rc != 0:
        return {"state": "absent", "ip": None, "error": (err or out).strip()}
    parsed = parse_inspect(out)
    return parsed or {"state": "unknown", "ip": None}


async def refresh(workspace_id: str, name: str) -> dict:
    """Re-read live state from the CLI and write it to the row. The ONLY writer of `ip`."""
    ws, nm = _validate(workspace_id, name)
    info = await _inspect(container_name(ws, nm))
    state = info.get("state") or "unknown"
    fields = {"state": state, "ip": info.get("ip") if state == "running" else None}
    if info.get("started_at"):
        fields["started_at"] = info["started_at"]
    if info.get("image"):
        fields["image"] = info["image"]
    if info.get("image_digest"):
        fields["image_digest"] = info["image_digest"]
    if info.get("provenance"):
        fields["provenance"] = info["provenance"]
    return await cr.upsert_sidecar(ws, nm, **fields)


# ── lifecycle ────────────────────────────────────────────────────────────────

def _build_run_argv(cname: str, image: str, spec: dict) -> list[str]:
    argv = ["container", "run", "--detach", "--name", cname]
    # No --rm, ever: it would delete the container (and its logs) the moment the init process
    # exits, which is exactly the audit hole the sandbox tier has.
    if spec.get("cap_drop_all", True):
        argv += ["--cap-drop", "ALL"]
    network = spec.get("network")
    if network:
        argv += ["--network", str(network)]
    mount = spec.get("workspace_path")
    if mount:
        target = spec.get("mount_target") or "/ws"
        suffix = ",readonly" if spec.get("readonly") else ""
        argv += ["--mount", f"type=bind,source={mount},target={target}{suffix}",
                 "--workdir", target]
    # Additional binds, applied AFTER the workspace so a nested target shadows it
    # (an app container needs its own Linux node_modules over the host's macOS one).
    for extra in (spec.get("extra_mounts") or []):
        src = (extra or {}).get("source")
        dst = (extra or {}).get("target")
        if not src or not dst:
            continue
        ro = ",readonly" if (extra or {}).get("readonly") else ""
        argv += ["--mount", f"type=bind,source={src},target={dst}{ro}"]
    for key, value in (spec.get("env") or {}).items():
        argv += ["-e", f"{key}={value}"]
    argv.append(image)
    argv += list(spec.get("command") or DEFAULT_COMMAND)
    return argv


async def start_sidecar(workspace_id: str, name: str, image: str | None = None,
                        workspace_path: str | None = None, http_port: int | None = None,
                        connectors=None, env: dict | None = None, command=None,
                        network: str | None = None, readonly: bool = False,
                        cap_drop_all: bool = True,
                        egress: str | None = None,
                        allowed_hosts=None,
                        extra_mounts=None) -> dict:
    """Create+start a sidecar (idempotent when one is already running under that name).

    ``egress`` is an optional posture ("isolated" | "filtered" | "open"). When it
    is None the network handling is exactly what it always was (explicit
    ``network`` / IVE_SIDECAR_NETWORK / the default network). When it is set,
    ``sandbox_egress`` reconciles it against what this runtime can actually
    deliver and governs the network — a posture that cannot be honored refuses
    the start instead of quietly running with more network than was asked for.
    """
    ws, nm = _validate(workspace_id, name)
    cname = container_name(ws, nm)
    existing = await cr.get_sidecar(ws, nm)

    decision = None
    if egress is not None:
        import sandbox_egress as _se

        decision = _se.decide(
            egress, "apple-container",
            allowed_hosts=tuple(allowed_hosts or ()),
            scope=ws,
        )
        if decision.mode == _se.MODE_DENY:
            await cr.record_invocation(ws, nm, "lifecycle", "start (egress refused)",
                                       exit_code=126, detail=decision.audit())
            return {"ok": False, "error": f"egress posture refused: {decision.reason}",
                    "egress": decision.audit()}

    live = await _inspect(cname)
    if live.get("state") == "running":
        if decision is not None:
            import sandbox_egress as _se

            want = decision.network_name if decision.mode == _se.MODE_ISOLATED else None
            had = live.get("network")
            if not ((want == had) or (want is None and had in (None, "default"))):
                # Idempotent-start must not report success for a posture it is not
                # actually running under. Killing a live service to re-attach it is
                # the caller's decision, not ours.
                await cr.record_invocation(
                    ws, nm, "lifecycle", "start (posture mismatch while running)",
                    exit_code=126, detail={**decision.audit(), "actual_network": had})
                return {
                    "ok": False,
                    "already_running": True,
                    "error": (f"sidecar is already running on network {had or 'default'}, "
                              f"which does not satisfy egress posture "
                              f"'{decision.requested}' (needs {want or 'default'}); "
                              "stop it first to re-attach"),
                    "egress": decision.audit(),
                }
        row = await refresh(ws, nm)
        await cr.record_invocation(ws, nm, "lifecycle", "start (already running)",
                                   exit_code=0, detail={"ip": row.get("ip")})
        return {"ok": True, "already_running": True, "sidecar": row}

    image = image or (existing or {}).get("image") or DEFAULT_IMAGE
    spec = {
        "workspace_path": os.path.abspath(workspace_path) if workspace_path else None,
        "extra_mounts": list(extra_mounts) if extra_mounts else None,
        "env": env or {},
        "command": list(command) if command else None,
        "network": network if network is not None else (
            os.environ.get("IVE_SIDECAR_NETWORK") or None),
        "readonly": bool(readonly),
        "cap_drop_all": bool(cap_drop_all),
    }
    if existing and existing.get("spec"):
        merged = dict(existing["spec"])
        merged.update({k: v for k, v in spec.items() if v not in (None, {}, [])})
        spec = merged

    if decision is not None:
        import sandbox_egress as _se

        if decision.mode == _se.MODE_ISOLATED:
            if not await _se.ensure_isolated_network(decision.network_name, _run):
                await cr.record_invocation(ws, nm, "lifecycle", "start (network unavailable)",
                                           exit_code=126, detail=decision.audit())
                return {"ok": False,
                        "error": f"could not create isolated network {decision.network_name}",
                        "egress": decision.audit()}
            spec["network"] = decision.network_name
        elif decision.mode == _se.MODE_PROXY:
            spec["env"] = {**(spec.get("env") or {}), **decision.env}
        elif not spec.get("network"):
            # MODE_OPEN with nothing requested: the default network. An explicitly
            # requested network is LEFT ALONE — a per-workspace NAT network already
            # satisfies "unrestricted egress", and clobbering it here would quietly
            # move the workload back onto the shared default network.
            spec["network"] = None
        spec["egress"] = decision.audit()

        # `container start` reuses the network the container was CREATED on, so a
        # stopped container whose posture has since changed must be recreated
        # rather than restarted — otherwise the old (wider) network silently wins.
        if live.get("state") in ("stopped", "exited"):
            want = decision.network_name if decision.mode == _se.MODE_ISOLATED else None
            had = live.get("network")
            same = (want == had) or (want is None and had in (None, "default"))
            if not same:
                # rm takes the logs with it, so capture evidence first — same rule
                # delete_sidecar and the reaper follow.
                forensics = await capture_forensics(ws, nm)
                await cr.record_invocation(
                    ws, nm, "lifecycle", "start (posture changed; recreating)",
                    exit_code=0, detail={**decision.audit(), "previous_network": had,
                                         "forensics_ledger_id": forensics.get("ledger_id")})
                rc_rm, _o, _e = await _run("container", "rm", cname,
                                           timeout=DEFAULT_EXEC_TIMEOUT)
                if rc_rm != 0:
                    return {"ok": False,
                            "error": (f"posture changed to {decision.mode} but the existing "
                                      f"container on network {had!r} could not be removed; "
                                      "refusing to start it on the old network"),
                            "egress": decision.audit()}
                live = {"state": "absent"}

    started = time.monotonic()
    if live.get("state") in ("stopped", "exited"):
        # The container still exists — start it (filesystem and logs carry over).
        rc, out, err = await _run("container", "start", cname, timeout=DEFAULT_EXEC_TIMEOUT)
    else:
        rc, out, err = await _run(*_build_run_argv(cname, image, spec),
                                  timeout=max(DEFAULT_EXEC_TIMEOUT, 120.0))
    duration_ms = int((time.monotonic() - started) * 1000)

    if rc != 0:
        await cr.upsert_sidecar(ws, nm, image=image, state="error", ip=None,
                                http_port=http_port, spec=spec,
                                connectors=list(connectors or (existing or {}).get("connectors") or []))
        await cr.record_invocation(ws, nm, "lifecycle", "start", exit_code=rc,
                                   duration_ms=duration_ms, stdout=out, stderr=err)
        return {"ok": False, "error": (err or out).strip() or f"start failed rc={rc}"}

    if START_SETTLE_S:
        await asyncio.sleep(START_SETTLE_S)
    await cr.upsert_sidecar(
        ws, nm, image=image, spec=spec,
        http_port=int(http_port) if http_port else ((existing or {}).get("http_port")
                                                    or DEFAULT_HTTP_PORT),
        connectors=list(connectors or (existing or {}).get("connectors") or []))
    row = await refresh(ws, nm)  # assigns the IP; never carried over from a previous run
    await cr.record_invocation(ws, nm, "lifecycle", "start", exit_code=0,
                               duration_ms=duration_ms, stdout=out, stderr=err,
                               detail={"ip": row.get("ip"), "image": row.get("image"),
                                       "image_digest": row.get("image_digest")})
    return {"ok": True, "sidecar": row}


async def stop_sidecar(workspace_id: str, name: str) -> dict:
    """Stop the container and CLEAR the recorded IP.

    Clearing on stop is the design half of the address-reuse guard: the allocator hands the old
    address to whatever starts next, so a value that outlived its container would route a
    connector call into a stranger.
    """
    ws, nm = _validate(workspace_id, name)
    cname = container_name(ws, nm)
    started = time.monotonic()
    rc, out, err = await _run("container", "stop", cname, timeout=DEFAULT_EXEC_TIMEOUT)
    duration_ms = int((time.monotonic() - started) * 1000)
    await cr.upsert_sidecar(ws, nm, state="stopped", ip=None)
    await cr.record_invocation(ws, nm, "lifecycle", "stop", exit_code=rc,
                               duration_ms=duration_ms, stdout=out, stderr=err)
    row = await refresh(ws, nm)
    return {"ok": rc == 0, "sidecar": row,
            "error": None if rc == 0 else (err or out).strip()}


async def restart_sidecar(workspace_id: str, name: str) -> dict:
    """stop -> start -> RE-READ the address.

    The container keeps its filesystem across this, but not its IP. stop_sidecar drops the stored
    address and only refresh() (post-start inspect) can write a new one, so there is no code path
    that can hand out the pre-restart address.
    """
    ws, nm = _validate(workspace_id, name)
    before = await cr.get_sidecar(ws, nm) or {}
    await stop_sidecar(ws, nm)
    row = await cr.get_sidecar(ws, nm) or {}
    spec = row.get("spec") or {}
    res = await start_sidecar(
        ws, nm, image=row.get("image"), workspace_path=spec.get("workspace_path"),
        http_port=row.get("http_port"), connectors=row.get("connectors"),
        env=spec.get("env"), command=spec.get("command"), network=spec.get("network"),
        readonly=spec.get("readonly", False), cap_drop_all=spec.get("cap_drop_all", True))
    after = await cr.get_sidecar(ws, nm) or {}
    await cr.record_invocation(ws, nm, "lifecycle", "restart", exit_code=0 if res.get("ok") else 1,
                               detail={"ip_before": before.get("ip"), "ip_after": after.get("ip")})
    return {"ok": bool(res.get("ok")), "sidecar": after,
            "ip_before": before.get("ip"), "ip_after": after.get("ip"),
            "error": res.get("error")}


async def delete_sidecar(workspace_id: str, name: str) -> dict:
    """Capture forensics, then stop + rm, then tombstone the row.

    `container rm` destroys the container's logs, so the capture has to happen first — this is the
    only delete path, and reaping calls it too.
    """
    ws, nm = _validate(workspace_id, name)
    cname = container_name(ws, nm)
    forensics = await capture_forensics(ws, nm)
    await _run("container", "stop", cname, timeout=DEFAULT_EXEC_TIMEOUT)
    rc, out, err = await _run("container", "rm", cname, timeout=DEFAULT_EXEC_TIMEOUT)
    await cr.record_invocation(ws, nm, "lifecycle", "delete", exit_code=rc,
                               stdout=out, stderr=err,
                               detail={"forensics_ledger_id": forensics.get("ledger_id")})
    await cr.tombstone_sidecar(ws, nm)
    return {"ok": rc == 0, "forensics": forensics,
            "error": None if rc == 0 else (err or out).strip()}


# ── audit ────────────────────────────────────────────────────────────────────

async def get_logs(workspace_id: str, name: str, tail: int | None = LOGS_DEFAULT_TAIL) -> dict:
    """`container logs` — works while running AND after stop, and survives a restart."""
    ws, nm = _validate(workspace_id, name)
    cname = container_name(ws, nm)
    argv = ["container", "logs"]
    if tail:
        argv += ["-n", str(int(tail))]
    argv.append(cname)
    rc, out, err = await _run(*argv, timeout=DEFAULT_EXEC_TIMEOUT)
    return {"ok": rc == 0, "logs": out, "error": None if rc == 0 else (err or "").strip(),
            "tail": tail, "container": cname}


async def exec_in_sidecar(workspace_id: str, name: str, argv, timeout: float | None = None,
                          kind: str = "exec", label: str | None = None) -> dict:
    """Run a command inside the sidecar and LEDGER it.

    Connector invocations ride this path. `container exec` output never reaches `container logs`,
    so the ledger row written here is the only evidence the call happened.
    """
    ws, nm = _validate(workspace_id, name)
    cname = container_name(ws, nm)
    argv = [str(a) for a in (argv or [])]
    if not argv:
        raise SidecarError("exec_in_sidecar requires a command")
    started = time.monotonic()
    rc, out, err = await _run("container", "exec", cname, *argv,
                              timeout=timeout if timeout is not None else DEFAULT_EXEC_TIMEOUT)
    duration_ms = int((time.monotonic() - started) * 1000)
    await cr.record_invocation(ws, nm, kind, label or " ".join(argv), exit_code=rc,
                               duration_ms=duration_ms, stdout=out, stderr=err)
    return {"ok": rc == 0, "exit_code": rc, "stdout": out, "stderr": err,
            "duration_ms": duration_ms}


async def capture_forensics(workspace_id: str, name: str) -> dict:
    """Best-effort: persist `container logs` + inspect provenance into the ledger and the row.

    Runs before any removal so a deleted sidecar still leaves evidence — rm takes the logs with it.
    """
    ws, nm = _validate(workspace_id, name)
    cname = container_name(ws, nm)
    logs = ""
    provenance: dict = {}
    try:
        rc, out, err = await _run("container", "logs", cname, timeout=DEFAULT_EXEC_TIMEOUT)
        logs = out if rc == 0 else (out or err)
    except Exception:
        logger.debug("forensics logs capture failed for %s", cname, exc_info=True)
    try:
        info = await _inspect(cname)
        provenance = info.get("provenance") or {}
        provenance.setdefault("final_state", info.get("state"))
        provenance.setdefault("final_ip", info.get("ip"))
    except Exception:
        logger.debug("forensics inspect failed for %s", cname, exc_info=True)
    ledger_id = await cr.record_invocation(
        ws, nm, "forensics", f"capture_forensics {cname}", exit_code=0,
        stdout=logs, detail=provenance, container_name=cname)
    if provenance:
        await cr.upsert_sidecar(ws, nm, provenance=provenance)
    return {"ok": True, "ledger_id": ledger_id, "log_bytes": len(logs),
            "provenance": provenance}


# ── state ────────────────────────────────────────────────────────────────────

async def list_sidecars(workspace_id: str | None = None, refresh_live: bool = True) -> list[dict]:
    """Rows for a workspace, reconciled against the CLI when refresh_live."""
    rows = await cr.list_sidecar_rows(workspace_id)
    if not refresh_live:
        return rows
    out = []
    for row in rows:
        try:
            out.append(await refresh(row["workspace_id"], row["name"]))
        except Exception:
            out.append(row)
    return out


async def health(workspace_id: str, name: str) -> dict:
    """Cheap exec probe + IP refresh. The probe is an exec, so it lands in the ledger too."""
    ws, nm = _validate(workspace_id, name)
    probe = os.environ.get("IVE_SIDECAR_HEALTH_CMD")
    argv = ["sh", "-c", probe] if probe else list(HEALTH_COMMAND)
    res = await exec_in_sidecar(ws, nm, argv, timeout=DEFAULT_EXEC_TIMEOUT, kind="health",
                                label="health probe")
    row = await refresh(ws, nm)
    return {"ok": bool(res["ok"]) and row.get("state") == "running",
            "state": row.get("state"), "ip": row.get("ip"),
            "http_port": row.get("http_port"), "exit_code": res["exit_code"],
            "duration_ms": res["duration_ms"], "sidecar": row}


# ── §2.5 host -> sidecar hop ─────────────────────────────────────────────────

async def sidecar_http_target(workspace_id: str, server_ref: str) -> str | None:
    """"http://{ip}:{http_port}" for the RUNNING sidecar claiming server_ref, else None.

    The address is re-read from `container inspect` on every call rather than taken from the row:
    the row is a cache, and a cache that outlives a stop points at whatever container the
    allocator handed the address to next.
    """
    ws = str(workspace_id or "")
    ref = str(server_ref or "")
    if not ws or not ref:
        return None
    try:
        rows = await cr.list_sidecar_rows(ws)
    except Exception:
        logger.debug("sidecar lookup failed for %s/%s", ws, ref, exc_info=True)
        return None
    match = None
    for row in rows:
        if row.get("name") == ref or ref in (row.get("connectors") or []):
            match = row
            break
    if not match or match.get("state") == "deleted":
        return None
    try:
        live = await _inspect(match["container_name"])
    except Exception:
        return None
    if (live.get("state") or "") != "running" or not live.get("ip"):
        try:
            await cr.upsert_sidecar(ws, match["name"],
                                    state=live.get("state") or "unknown", ip=None)
        except Exception:
            pass
        return None
    ip = live["ip"]
    port = match.get("http_port") or DEFAULT_HTTP_PORT
    try:
        await cr.upsert_sidecar(ws, match["name"], state="running", ip=ip)
    except Exception:
        pass
    return f"http://{ip}:{int(port)}"


# ── HTTP surface ─────────────────────────────────────────────────────────────
# Thin wrappers: every decision lives in the functions above, so the handlers only
# shape request -> args and exception -> status.

def _sc_error(msg: str, status: int = 400) -> web.Response:
    return web.json_response({"ok": False, "error": msg}, status=status)


async def _workspace_path(workspace_id: str) -> str | None:
    """The workspace's own root from the DB. Indirection so tests can point it elsewhere."""
    from db import get_db
    db = await get_db()
    try:
        cur = await db.execute("SELECT path FROM workspaces WHERE id = ?", (workspace_id,))
        row = await cur.fetchone()
        return row["path"] if row else None
    finally:
        await db.close()


async def _sc_call(coro):
    """Run a lifecycle call, mapping its failure modes to status codes."""
    try:
        return web.json_response({"ok": True, **(await coro)})
    except SidecarError as e:
        return _sc_error(str(e), status=409)
    except FileNotFoundError:
        # The `container` CLI is absent — a deployment fact, not a client error.
        return _sc_error("the container runtime is not installed on this host", status=503)
    except Exception as e:  # noqa: BLE001
        logger.exception("sidecar call failed: %s", e)
        return _sc_error("sidecar call failed", status=500)


async def list_sidecars_handler(request: web.Request) -> web.Response:
    """GET /api/workspaces/{id}/sidecars -> {ok, sidecars:[...]}"""
    try:
        rows = await list_sidecars(request.match_info["id"])
    except FileNotFoundError:
        return _sc_error("the container runtime is not installed on this host", status=503)
    except Exception as e:  # noqa: BLE001
        logger.exception("sidecar list failed: %s", e)
        return _sc_error("sidecar list failed", status=500)
    return web.json_response({"ok": True, "sidecars": rows})


async def start_sidecar_handler(request: web.Request) -> web.Response:
    """POST /api/workspaces/{id}/sidecars — body {name, image?, http_port?, connectors?, ...}"""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return _sc_error("body must be JSON")
    if not isinstance(body, dict):
        return _sc_error("body must be a JSON object")
    name = str(body.get("name") or "").strip()
    if not name:
        return _sc_error("name is required")
    allowed = ("image", "http_port", "connectors", "env",
               "command", "network", "readonly", "cap_drop_all")
    kwargs = {k: body[k] for k in allowed if k in body}
    # The bind-mount source is NOT caller-supplied: `mount_workspace` mounts the workspace's own
    # root, read from the DB. A path taken from the body would mount any host directory into a
    # container over this endpoint.
    if body.get("mount_workspace"):
        path = await _workspace_path(request.match_info["id"])
        if not path:
            return _sc_error("workspace not found", status=404)
        kwargs["workspace_path"] = path
    return await _sc_call(start_sidecar(request.match_info["id"], name, **kwargs))


async def stop_sidecar_handler(request: web.Request) -> web.Response:
    """POST /api/workspaces/{id}/sidecars/{name}/stop"""
    return await _sc_call(stop_sidecar(request.match_info["id"], request.match_info["name"]))


async def restart_sidecar_handler(request: web.Request) -> web.Response:
    """POST /api/workspaces/{id}/sidecars/{name}/restart — the address is re-read, never reused."""
    return await _sc_call(restart_sidecar(request.match_info["id"], request.match_info["name"]))


async def delete_sidecar_handler(request: web.Request) -> web.Response:
    """DELETE /api/workspaces/{id}/sidecars/{name} — captures forensics before removal."""
    return await _sc_call(delete_sidecar(request.match_info["id"], request.match_info["name"]))


async def sidecar_health_handler(request: web.Request) -> web.Response:
    """GET /api/workspaces/{id}/sidecars/{name}/health"""
    return await _sc_call(health(request.match_info["id"], request.match_info["name"]))


async def sidecar_logs_handler(request: web.Request) -> web.Response:
    """GET /api/workspaces/{id}/sidecars/{name}/logs?tail=N — readable after a stop."""
    raw = request.query.get("tail")
    try:
        tail = max(1, min(int(raw), 5000)) if raw else LOGS_DEFAULT_TAIL
    except (TypeError, ValueError):
        return _sc_error("tail must be an integer")
    return await _sc_call(get_logs(request.match_info["id"], request.match_info["name"], tail))


async def sidecar_ledger_handler(request: web.Request) -> web.Response:
    """GET /api/workspaces/{id}/sidecars/{name}/ledger?limit=N

    The invocation ledger is the ONLY record of connector calls — `container exec`
    output never reaches `container logs`.
    """
    raw = request.query.get("limit")
    try:
        limit = max(1, min(int(raw), 1000)) if raw else 100
    except (TypeError, ValueError):
        return _sc_error("limit must be an integer")
    try:
        rows = await cr.list_invocations(request.match_info["id"],
                                         request.match_info["name"], limit=limit)
    except Exception as e:  # noqa: BLE001
        logger.exception("sidecar ledger read failed: %s", e)
        return _sc_error("sidecar ledger read failed", status=500)
    return web.json_response({"ok": True, "invocations": rows})
