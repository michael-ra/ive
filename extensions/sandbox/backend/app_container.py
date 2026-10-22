"""Containerized app runtime — run the workspace's dev server in a container.

`demo_runner` spawns `npm run dev` as a host subprocess bound to 127.0.0.1. That
is unreachable from a containerized browser, and on this machine it cannot be
made reachable at all: the macOS application firewall is in block-all-incoming
mode, so a container completes a TCP handshake to a host service and then no
data flows (measured 2026-07-27 — `socketfilterfw --getglobalstate` = State 2).
Container-to-container traffic is unaffected. So previewing a local app from a
sandboxed browser requires the app to be in a container too; this module is that.

Lifecycle rides `sidecars`, so an app container gets the same invocation ledger,
forensics-before-delete, IP re-read on start, and egress posture as everything
else.

Two things it must get right, both measured:

  * BIND ADDRESS. A dev server bound to 127.0.0.1 inside the container answers
    only itself. The command is run with HOST/HOSTNAME and the usual framework
    flags set to 0.0.0.0 so the address is reachable on the container network.
  * node_modules. The host's tree is macOS-native (esbuild, rollup, sharp…) and
    is useless — and dangerous to overwrite — inside a Linux container. The
    workspace is bind-mounted at /ws and a per-workspace host directory is
    mounted OVER /ws/node_modules, so the container installs its own Linux
    modules and the host's tree is neither read nor clobbered. Verified: with
    both mounts, /ws/node_modules shows only the container's contents while the
    host tree keeps its own.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shlex
from typing import Callable, Optional

logger = logging.getLogger(__name__)

DEFAULT_APP_IMAGE = os.environ.get("IVE_APP_IMAGE", "node:20-alpine")
APP_SIDECAR_NAME = os.environ.get("IVE_APP_SIDECAR_NAME", "app")
WS_MOUNT_TARGET = "/ws"
NODE_MODULES_TARGET = f"{WS_MOUNT_TARGET}/node_modules"
_STATE_ROOT = os.path.expanduser(
    os.environ.get("IVE_APP_CONTAINER_STATE", "~/.ive/app-containers"))

_TRUE_SET = {"1", "true", "yes", "on"}
# Dots are excluded deliberately: a workspace id of ".." would otherwise survive
# as a literal path segment and escape the state root by one level.
_SAFE_SEGMENT = re.compile(r"[^A-Za-z0-9_-]+")


def container_mode_enabled(env: Optional[dict] = None) -> bool:
    """True when the demo/dev server should run in a container. Opt-in."""
    src = env if env is not None else os.environ
    return str(src.get("IVE_APP_CONTAINER", "")).strip().lower() in _TRUE_SET


def node_modules_dir(workspace_id: str, *, create: bool = False) -> str:
    """Per-workspace host directory shadowed over /ws/node_modules."""
    token = _SAFE_SEGMENT.sub("-", str(workspace_id or "default")).strip("-_") or "default"
    path = os.path.join(_STATE_ROOT, token, "node_modules")
    if create:
        try:
            os.makedirs(path, exist_ok=True)
        except OSError as e:
            logger.warning("app_container: cannot create %s (%s)", path, e)
    return path


# Paths that get their own writable host directory under a read-only workspace.
#
# ONLY node_modules by default, and that is a deliberate retreat from a longer
# list. A writable overlay MASKS whatever the host had at that path: with
# ".next,dist,build" in here, a project with prebuilt output saw an EMPTY dist/
# inside the container and served nothing, with no error to explain it (measured
# — the host file was there, `ls` inside returned []). node_modules is the one
# path where masking is the POINT, because the host tree is macOS-native and
# unusable in a Linux container.
#
# Anything added via IVE_APP_WRITABLE_PATHS is seeded from the host's copy on
# first use (see _seed_overlay), so the container still sees what was there and
# only its WRITES stay local.
_DEFAULT_WRITABLE = ("node_modules",)
WRITABLE_SUBPATHS = tuple(
    dict.fromkeys(
        list(_DEFAULT_WRITABLE)
        + [p.strip() for p in (os.environ.get("IVE_APP_WRITABLE_PATHS") or "").split(",")
           if p.strip()]
    )
)
# Never copy the host's tree into this overlay: its binaries are the wrong platform.
_NEVER_SEED = frozenset({"node_modules"})


def one_way_enabled(env: Optional[dict] = None) -> bool:
    """True when the workspace is mounted read-only inside the container.

    ONE-WAY means: host edits are visible inside immediately (it is the same
    tree), but nothing inside can modify the host's source. The reverse
    direction — sandboxed code editing your real repo — is the one worth
    refusing by default, so this defaults to ON.
    """
    src = env if env is not None else os.environ
    value = str(src.get("IVE_APP_WORKSPACE_READONLY", "")).strip().lower()
    return value in _TRUE_SET if value else True


def writable_dir(workspace_id: str, subpath: str, *, create: bool = False) -> str:
    """Host directory backing one writable path inside the container."""
    token = _SAFE_SEGMENT.sub("-", str(workspace_id or "default")).strip("-_") or "default"
    leaf = _SAFE_SEGMENT.sub("-", str(subpath or "x")).strip("-_") or "x"
    path = os.path.join(_STATE_ROOT, token, leaf)
    if create:
        try:
            os.makedirs(path, exist_ok=True)
        except OSError as e:
            logger.warning("app_container: cannot create %s (%s)", path, e)
    return path


def mounts_for(workspace_id: str, *, create: bool = False,
               one_way: Optional[bool] = None,
               workspace_path: Optional[str] = None) -> list[dict]:
    """Writable mounts layered over the (possibly read-only) workspace.

    node_modules is always shadowed — the host tree is macOS-native and unusable
    in a Linux container. Under one-way mode the other build/cache directories
    get the same treatment, because a read-only project root would otherwise
    break every framework that writes beside its source.

    MEASURED CONSTRAINT: a mount target that does not already exist inside a
    READ-ONLY root cannot be created, and the container refuses to start at all
    ("mount failed with errno 30: failed to create directory"). So under one-way
    mode only subpaths that already exist in the workspace are overlaid — except
    node_modules, which is created on the host when missing because an install
    is impossible without it (an empty, gitignored directory in a JS project).
    """
    if one_way is None:
        one_way = one_way_enabled()
    # Without the workspace path we cannot check which targets exist, and naming
    # one that does not exist inside a read-only root stops the container from
    # starting at all. Claim only node_modules, which is created when missing.
    subpaths = (WRITABLE_SUBPATHS if (one_way and workspace_path) else ("node_modules",))
    mounts = []
    for sub in subpaths:
        sub = sub.strip().strip("/")
        if not sub:
            continue
        host_target = os.path.join(workspace_path, sub) if workspace_path else None
        if one_way and host_target and not os.path.isdir(host_target):
            # A mount target that does not exist inside a READ-ONLY root cannot be
            # created, and the container then refuses to start entirely. Create it
            # on the host (these are gitignored build/dep dirs, and every path here
            # is either node_modules or explicitly opted in) or skip.
            if not create:
                continue
            try:
                os.makedirs(host_target, exist_ok=True)
                logger.info("app_container: created %s so it can be overlaid under a "
                            "read-only workspace", host_target)
            except OSError as e:
                logger.warning("app_container: cannot create %s (%s) — skipping the "
                               "%s overlay", host_target, e, sub)
                continue
        source = writable_dir(workspace_id, sub, create=create)
        mounts.append({"source": source, "target": f"{WS_MOUNT_TARGET}/{sub}",
                       "seed_from": host_target if sub not in _NEVER_SEED else None})
    return mounts


SEED_MARKER = ".ive-overlay-seeded"


async def seed_overlays(mounts: list[dict]) -> None:
    """Seed overlays off the event loop.

    The copy is a real filesystem walk — a 400MB .next/ takes tens of seconds —
    and running it inline froze the whole backend: no websocket frames, no other
    request served, every other workspace stalled while one preview started.
    """
    for mount in mounts or []:
        src = (mount or {}).get("seed_from")
        dst = (mount or {}).get("source")
        if src and dst:
            await asyncio.to_thread(_seed_overlay, src, dst,
                                    str(mount.get("target") or dst).rsplit("/", 1)[-1])


def _seed_overlay(host_dir: str, overlay_dir: str, label: str) -> None:
    """Copy the host's contents into an EMPTY overlay, once.

    Without this the overlay hides whatever the host had at that path, so a
    project with prebuilt output serves nothing inside the container and the
    reason is invisible. Copying once restores the read side while writes still
    stay local — which is what one-way is supposed to mean. Only ever runs when
    the overlay is empty, so the sandbox's own output is never overwritten.
    """
    marker = os.path.join(overlay_dir, SEED_MARKER)
    try:
        if not os.path.isdir(host_dir):
            return
        # Completion is a MARKER, not "the directory has something in it". An
        # interrupted copy (disk full, restart, cancelled request) leaves a
        # partial tree that is non-empty, and an emptiness guard would then treat
        # it as done forever — the container would serve a silently incomplete
        # build with no way back short of deleting the overlay by hand.
        if os.path.exists(marker):
            return
        entries = os.listdir(host_dir)
        if not entries:
            return
        import shutil

        if os.listdir(overlay_dir):
            logger.info("app_container: %s overlay has partial content and no completion "
                        "marker — re-seeding over it", label)
        for name in entries:
            src = os.path.join(host_dir, name)
            dst = os.path.join(overlay_dir, name)
            if os.path.isdir(src) and not os.path.islink(src):
                shutil.copytree(src, dst, symlinks=True, dirs_exist_ok=True)
            else:
                shutil.copy2(src, dst, follow_symlinks=False)
        with open(marker, "w") as fh:      # only after every entry landed
            fh.write("seeded\n")
        logger.info("app_container: seeded the %s overlay from the workspace (%d entries) "
                    "so the container sees what the host had", label, len(entries))
    except Exception as e:
        logger.warning("app_container: could not seed the %s overlay (%s) — it may be "
                       "PARTIAL; it will be re-seeded on the next start", label, e)


INSTALL_MARKER = ".ive-install-complete"


def container_env(port: int, extra: Optional[dict] = None) -> dict:
    """Environment the container itself gets.

    PORT/HOST/HOSTNAME are passed as real container env rather than shell exports
    so the user's command can still override them deliberately (`PORT=4000 npm
    run dev` is a legitimate thing to write) without the wrapper silently winning
    or losing depending on concatenation order.
    """
    env = {"PORT": str(int(port)), "HOST": "0.0.0.0", "HOSTNAME": "0.0.0.0"}
    env.update({str(k): str(v) for k, v in (extra or {}).items()})
    return env


def build_shell_command(command: str, port: int, *, install: bool = False) -> list[str]:
    """Wrap the user's dev command for the container.

    PORT/HOST/HOSTNAME are also exported here as a floor for images that drop the
    container env, but the authoritative copy is `container_env` — see there for
    why. 0.0.0.0 matters because a server on 127.0.0.1 inside a container is
    reachable by nothing.

    The install guard keys on a COMPLETION MARKER, not on the directory being
    non-empty: the node_modules shadow is a persistent host directory, so an
    install that was interrupted (container killed, disk full, network drop)
    leaves a partial tree that "looks installed" forever and the dev server then
    fails on every subsequent start with no way to recover short of manual
    deletion. The marker is written only after npm exits 0.
    """
    cmd = str(command or "").strip() or "npm run dev"
    prefix = f"export PORT={int(port)} HOST=0.0.0.0 HOSTNAME=0.0.0.0; "
    if install:
        prefix += (
            f'if [ ! -f node_modules/{INSTALL_MARKER} ]; then '
            'npm install --no-audit --no-fund && '
            f'touch node_modules/{INSTALL_MARKER}; fi; '
        )
    return ["sh", "-lc", prefix + cmd]


def app_url(ip: str, port: int) -> str:
    return f"http://{ip}:{int(port)}"


# ─── Readiness ──────────────────────────────────────────────────────────

async def _default_probe(ip: str, port: int, timeout: float) -> bool:
    """TCP connect only — a dev server may 404 before it serves the app, and a
    connect is what "the port is up" actually means."""
    try:
        fut = asyncio.open_connection(ip, int(port))
        reader, writer = await asyncio.wait_for(fut, timeout=timeout)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return True
    except Exception:
        return False


async def wait_for_port(
    ip: str,
    port: int,
    *,
    timeout: float = 90.0,
    interval: float = 0.5,
    probe: Optional[Callable] = None,
) -> bool:
    """Poll until the app answers. Dev servers can take a minute with an install."""
    p = probe or _default_probe
    loop = asyncio.get_event_loop()
    deadline = loop.time() + max(0.1, float(timeout))
    while loop.time() < deadline:
        try:
            if await p(ip, port, 2.0):
                return True
        except Exception:
            pass
        await asyncio.sleep(interval)
    return False


# ─── Lifecycle ──────────────────────────────────────────────────────────

async def ensure_app(
    workspace_id: str,
    *,
    workspace_path: str,
    command: str = "npm run dev",
    port: int = 5173,
    image: Optional[str] = None,
    name: Optional[str] = None,
    env: Optional[dict] = None,
    egress: Optional[str] = None,
    install: bool = True,
    ready_timeout: float = 90.0,
    one_way: Optional[bool] = None,
    network: Optional[str] = None,
    start_fn: Optional[Callable] = None,
    inspect_fn: Optional[Callable] = None,
    probe: Optional[Callable] = None,
) -> dict:
    """Start (or reuse) the workspace's app container.

    Returns ``{"ok","url","ip","port","container","error"}``. Never raises — a
    failure returns ok=False so the caller can fall back to the host process
    rather than leaving the workspace with no dev server at all.
    """
    ws = str(workspace_id or "").strip()
    if not ws:
        return {"ok": False, "error": "workspace_id required"}
    if not workspace_path or not os.path.isdir(workspace_path):
        return {"ok": False, "error": f"workspace path not found: {workspace_path}"}

    try:
        import sidecars
    except Exception as e:  # pragma: no cover - import guard
        return {"ok": False, "error": f"sidecars unavailable: {e}"}

    start = start_fn or sidecars.start_sidecar
    inspect = inspect_fn or sidecars._inspect
    sc_name = name or APP_SIDECAR_NAME

    if one_way is None:
        one_way = one_way_enabled()
    if not one_way:
        # Loud on purpose: this is the state where sandboxed code can rewrite the
        # user's source tree, and it should never be reachable without someone
        # having chosen it. The safety gate asks before the switch can be set.
        logger.warning(
            "app_container: workspace %s mounted READ-WRITE for %s — sandboxed code "
            "can modify the real source tree (one-way isolation is off)",
            workspace_path, ws)
    net = network if network is not None else await ensure_workspace_network(ws)
    overlays = mounts_for(ws, create=True, one_way=one_way, workspace_path=workspace_path)
    await seed_overlays(overlays)          # off the event loop; see seed_overlays
    # `seed_from` is bookkeeping for the seeding step, not a mount option.
    extra = [{k: v for k, v in m.items() if k != "seed_from"} for m in overlays]
    kwargs = dict(
        image=image or DEFAULT_APP_IMAGE,
        network=net,
        workspace_path=workspace_path,
        # readonly makes the workspace mount one-way: host edits are seen inside
        # (same tree), container writes to the source are refused by the kernel.
        readonly=bool(one_way),
        extra_mounts=extra,
        command=build_shell_command(command, port, install=install),
        env=container_env(port, env),
        http_port=int(port),
    )
    if egress is not None:
        kwargs["egress"] = egress

    try:
        result = await start(ws, sc_name, **kwargs)
    except Exception as e:
        return {"ok": False, "error": f"app container start failed: {e}"}
    if not result.get("ok"):
        return {"ok": False, "error": result.get("error") or "app container start failed",
                "egress": result.get("egress")}

    ip = (result.get("sidecar") or {}).get("ip")
    if not ip:
        try:
            info = await inspect(sidecars.container_name(ws, sc_name))
            ip = info.get("ip")
        except Exception:
            ip = None
    if not ip:
        return {"ok": False, "error": "app container has no address yet"}

    ready = await wait_for_port(ip, port, timeout=ready_timeout, probe=probe)
    out = {
        "ok": bool(ready),
        "ip": ip,
        "port": int(port),
        "url": app_url(ip, port),
        "container": sidecars.container_name(ws, sc_name),
    }
    if not ready:
        # A dead container and a slow one look identical to a port poller, and
        # "nothing is listening" sends the reader looking in the wrong place when
        # the real answer is in the container's log. Report which it was.
        state, tail = await _post_mortem(ws, sc_name, inspect, sidecars)
        out["state"] = state
        if tail:
            out["log_tail"] = tail
        if state in ("stopped", "exited", "absent", "error"):
            out["error"] = (f"app container is {state} — the dev command exited "
                            f"instead of serving {port}")
        else:
            out["error"] = (f"app container is {state or 'running'} but nothing is "
                            f"listening on {port} after {ready_timeout:.0f}s")
    return out


async def _post_mortem(ws: str, sc_name: str, inspect: Callable, sidecars) -> tuple:
    """Container state + a short log tail, best effort. Never raises."""
    state = ""
    try:
        info = await inspect(sidecars.container_name(ws, sc_name))
        state = str(info.get("state") or "")
    except Exception:
        pass
    tail = ""
    try:
        res = await sidecars.get_logs(ws, sc_name, 20)
        tail = "\n".join((res.get("logs") or "").strip().splitlines()[-20:])
    except Exception:
        pass
    return state, tail


async def ensure_workspace_network(workspace_id: str) -> Optional[str]:
    """The per-workspace network the app and its browser share.

    Both must be on ONE network or the browser cannot load the app: containers
    only reach each other within a network. Using a per-workspace one instead of
    the shared default is what stops another workspace's untrusted app from
    reaching this one. Returns None (default network) if it cannot be created,
    because a demo that runs beats a demo that does not.
    """
    try:
        import sandbox_egress as se
        import sidecars

        name = se.workspace_network_name(workspace_id)
        if await se.ensure_workspace_network(name, sidecars._run):
            return name
        logger.warning("app_container: could not create %s — falling back to the "
                       "shared default network", name)
    except Exception as e:
        logger.warning("app_container: workspace network unavailable (%s)", e)
    return None


async def stop_app(workspace_id: str, *, name: Optional[str] = None,
                   stop_fn: Optional[Callable] = None) -> dict:
    """Stop the app container. Logs survive; nothing is deleted."""
    try:
        import sidecars

        stop = stop_fn or sidecars.stop_sidecar
        return await stop(str(workspace_id or ""), name or APP_SIDECAR_NAME)
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def app_logs(workspace_id: str, *, name: Optional[str] = None,
                   tail: int = 200, logs_fn: Optional[Callable] = None) -> dict:
    """`container logs` for the app container — survives stop and restart."""
    try:
        import sidecars

        getter = logs_fn or sidecars.get_logs
        return await getter(str(workspace_id or ""), name or APP_SIDECAR_NAME, tail)
    except Exception as e:
        return {"ok": False, "logs": "", "error": str(e)}


def describe(command: str, port: int, workspace_id: str) -> dict:
    """What ensure_app would do — for the UI / dry runs, no side effects."""
    return {
        "image": DEFAULT_APP_IMAGE,
        "command": build_shell_command(command, port),
        "workspace_target": WS_MOUNT_TARGET,
        "node_modules_host_dir": node_modules_dir(workspace_id),
        "node_modules_target": NODE_MODULES_TARGET,
        "port": int(port),
    }
