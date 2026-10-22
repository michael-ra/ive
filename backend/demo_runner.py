"""Per-workspace demo runner.

Spawns a long-lived dev server (e.g. ``npm run dev``) representing a known-good
build. The demo lives independently of any worker session — workers can hack
freely without restarting the demo. Operators promote new builds via the
explicit ``pull_latest`` action: git fetch + checkout + (optional reinstall) +
restart on the SAME port so testers don't need to refresh URLs.

State is held in a module-level dict keyed by workspace_id. The runner is
broadcast-aware (UI consumers get ``demo_state`` / ``demo_log`` ws events) and
broadcast-injectable so server.py can wire it after import without circular
imports.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import socket
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

# Ports that the preview proxy refuses to forward — keep our auto-allocator in
# lockstep so an auto-picked port can always be reached through the tunnel.
_DENY_PORTS = {5111, 5173, 22, 3306, 5432, 6379, 27017}

_LOG_TAIL_MAX = 200
_LOG_BROADCAST_INTERVAL_S = 0.1

_broadcast_fn = None  # type: Optional[callable]


def set_broadcast_fn(fn):
    """Inject the WebSocket broadcaster (called once from on_startup)."""
    global _broadcast_fn
    _broadcast_fn = fn


@dataclass
class Demo:
    workspace_id: str
    workspace_path: str
    branch: str = "main"
    command: str = "npm run dev"
    port: int = 0
    pid: Optional[int] = None
    status: str = "stopped"  # stopped | starting | running | building | error
    last_commit: Optional[str] = None
    last_pull_at: Optional[float] = None
    build_log_tail: list = field(default_factory=list)
    error: Optional[str] = None
    _process: Optional[asyncio.subprocess.Process] = field(default=None, repr=False)
    _log_task: Optional[asyncio.Task] = field(default=None, repr=False)
    # Set instead of _process when the demo runs as a container: {"url","ip","container"}.
    # A container has no host pid, so pid stays None and teardown goes through
    # the sidecar stop path rather than killpg.
    _container: Optional[dict] = field(default=None, repr=False)

    def to_dict(self) -> dict:
        return {
            "workspace_id": self.workspace_id,
            "workspace_path": self.workspace_path,
            "branch": self.branch,
            "command": self.command,
            "port": self.port,
            "pid": self.pid,
            "status": self.status,
            "last_commit": self.last_commit,
            "last_pull_at": self.last_pull_at,
            "build_log_tail": list(self.build_log_tail),
            "error": self.error,
            # Additive: None for a host demo (consumers keep building their own
            # localhost URL), the container address when containerized — which is
            # the only address a containerized browser can actually reach.
            "runtime": "container" if self._container else "host",
            "url": (self._container or {}).get("url"),
            "container": (self._container or {}).get("container"),
        }


_demos: dict[str, Demo] = {}
_lock = asyncio.Lock()


# ── Helpers ────────────────────────────────────────────────────────────


def _pick_free_port() -> int:
    """Bind to port 0, read what the kernel handed out, retry on deny-list hits."""
    for _ in range(20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        if port not in _DENY_PORTS:
            return port
    # Vanishingly unlikely; pick something high explicitly.
    return 38123


def _broadcast_state(demo: Demo) -> None:
    if _broadcast_fn is None:
        return
    payload = {"type": "demo_state", "demo": demo.to_dict()}
    try:
        coro = _broadcast_fn(payload)
        if asyncio.iscoroutine(coro):
            asyncio.ensure_future(coro)
    except Exception:
        logger.exception("demo broadcast_state failed")


def _broadcast_log(demo: Demo, lines: list) -> None:
    if _broadcast_fn is None or not lines:
        return
    payload = {
        "type": "demo_log",
        "workspace_id": demo.workspace_id,
        "lines": lines,
    }
    try:
        coro = _broadcast_fn(payload)
        if asyncio.iscoroutine(coro):
            asyncio.ensure_future(coro)
    except Exception:
        logger.exception("demo broadcast_log failed")


def _append_log(demo: Demo, line: str) -> None:
    demo.build_log_tail.append(line)
    if len(demo.build_log_tail) > _LOG_TAIL_MAX:
        del demo.build_log_tail[: len(demo.build_log_tail) - _LOG_TAIL_MAX]


async def _read_log(demo: Demo) -> None:
    """Stream stdout+stderr line-by-line; batch-broadcast every 100ms."""
    proc = demo._process
    if proc is None or proc.stdout is None:
        return
    buf: list = []
    last_flush = 0.0

    async def _flush():
        nonlocal buf, last_flush
        if buf:
            _broadcast_log(demo, buf)
            buf = []
        last_flush = asyncio.get_event_loop().time()

    try:
        while True:
            try:
                raw = await asyncio.wait_for(proc.stdout.readline(), timeout=_LOG_BROADCAST_INTERVAL_S)
            except asyncio.TimeoutError:
                await _flush()
                if proc.returncode is not None:
                    break
                continue
            if not raw:
                break
            line = raw.decode("utf-8", errors="replace").rstrip("\n")
            _append_log(demo, line)
            buf.append(line)
            now = asyncio.get_event_loop().time()
            if now - last_flush >= _LOG_BROADCAST_INTERVAL_S:
                await _flush()
        await _flush()
    except asyncio.CancelledError:
        await _flush()
        raise
    except Exception:
        logger.exception("demo log reader crashed")


async def _run_subprocess(cwd: str, argv: list, env: Optional[dict] = None) -> tuple[int, str, str]:
    """Run a one-shot subprocess and capture stdout/stderr."""
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=cwd,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    return proc.returncode or 0, out.decode("utf-8", errors="replace"), err.decode("utf-8", errors="replace")


async def _git_head(repo_path: str) -> Optional[str]:
    rc, out, _ = await _run_subprocess(repo_path, ["git", "rev-parse", "HEAD"])
    return out.strip() if rc == 0 else None


async def _git_pull(repo_path: str, branch: str) -> tuple[str, str]:
    """Returns (old_sha, new_sha). Raises RuntimeError on failure."""
    import git_ops
    if not git_ops.is_safe_revision(branch):
        raise RuntimeError("invalid branch name")
    old = await _git_head(repo_path) or ""

    rc, _out, err = await _run_subprocess(repo_path, ["git", "fetch", "origin", branch])
    if rc != 0:
        raise RuntimeError(f"git fetch failed: {err.strip()}")

    rc, _out, err = await _run_subprocess(repo_path, ["git", "checkout", branch])
    if rc != 0:
        raise RuntimeError(f"git checkout failed: {err.strip()}")

    rc, _out, err = await _run_subprocess(repo_path, ["git", "pull", "--ff-only", "origin", branch])
    if rc != 0:
        raise RuntimeError(f"git pull failed: {err.strip()}")

    new = await _git_head(repo_path) or ""
    return old, new


async def _files_changed(repo_path: str, old_sha: str, new_sha: str, paths: list) -> bool:
    if not old_sha or not new_sha or old_sha == new_sha:
        return False
    rc, out, _err = await _run_subprocess(
        repo_path, ["git", "diff", "--name-only", old_sha, new_sha, "--", *paths]
    )
    return rc == 0 and bool(out.strip())


async def _spawn_container(demo: Demo) -> bool:
    """Start the demo as a container. False means the caller must deny launch.

    A containerized demo is what makes the app reachable from a containerized
    browser: a host process bound to 127.0.0.1 is not, and on a machine whose
    firewall blocks incoming connections it cannot be made so.
    """
    try:
        import app_container as ac

        info = await ac.ensure_app(
            demo.workspace_id,
            workspace_path=demo.workspace_path,
            command=demo.command,
            port=demo.port,
        )
    except Exception as e:
        demo.error = f"Container start failed: {type(e).__name__}"
        logger.warning("demo container start failed (%s) — refusing host fallback", e)
        return False
    if not info.get("ok"):
        demo.error = f"Container unavailable: {info.get('error')}"
        logger.warning("demo container unavailable (%s) — refusing host fallback",
                       info.get("error"))
        return False

    demo._container = info
    demo._process = None
    demo.pid = None
    demo.status = "running"
    demo.error = None
    _broadcast_state(demo)
    demo._log_task = asyncio.ensure_future(_read_container_log(demo))
    return True


async def _read_container_log(demo: Demo) -> None:
    """Poll `container logs` and broadcast new lines.

    `container exec` output never reaches `container logs`, but the init process
    (the dev server) does, which is exactly what this needs.

    Position is tracked by CONTENT, not by line count. `container logs -n N`
    returns a fixed-size WINDOW of the last N lines, so once the log passes N the
    length pins at N forever — a count-based cursor concludes "nothing new" and
    the demo's output silently stops updating at exactly the point a long-running
    dev server gets interesting. Matching on the last line already emitted
    survives the window sliding; when that anchor has scrolled out of the window
    the whole window is emitted, which is the honest response to a gap.
    """
    import app_container as ac

    anchor: Optional[str] = None
    while True:
        try:
            res = await ac.app_logs(demo.workspace_id, tail=_LOG_TAIL_MAX)
            lines = (res.get("logs") or "").splitlines()
            if lines:
                if anchor is None:
                    fresh = lines
                elif anchor in lines:
                    idx = len(lines) - 1 - lines[::-1].index(anchor)
                    fresh = lines[idx + 1:]
                else:
                    fresh = lines          # anchor scrolled out (or log reset)
                if fresh:
                    # Mirror the host reader: the tail feeds to_dict/status readers,
                    # the broadcast feeds live subscribers. Doing only the latter
                    # left every container demo with an empty build_log_tail.
                    for line in fresh:
                        _append_log(demo, line)
                    _broadcast_log(demo, fresh)
                anchor = lines[-1]
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("demo container log poll failed", exc_info=True)
        await asyncio.sleep(1.0)


async def _spawn(demo: Demo) -> None:
    """Start the dev-server process and wire the log reader."""
    import app_container as ac

    if ac.container_mode_enabled():
        if not await _spawn_container(demo):
            raise RuntimeError(demo.error or "Container required; refusing host fallback")
        return

    env = os.environ.copy()
    env["PORT"] = str(demo.port)
    env["HOST"] = "127.0.0.1"

    # Use shell=True equivalent so users can pass `npm run dev` etc directly.
    proc = await asyncio.create_subprocess_shell(
        demo.command,
        cwd=demo.workspace_path,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        start_new_session=True,
    )
    demo._process = proc
    demo.pid = proc.pid
    demo.status = "running"
    demo.error = None
    _broadcast_state(demo)

    demo._log_task = asyncio.ensure_future(_read_log(demo))


async def _terminate(demo: Demo) -> None:
    if demo._container is not None:
        # Container demo: stop through the sidecar path (logs survive; nothing is
        # deleted), then drop the log poller.
        try:
            import app_container as ac

            await ac.stop_app(demo.workspace_id)
        except Exception:
            logger.exception("demo container stop failed")
        demo._container = None
        demo.pid = None
        if demo._log_task is not None:
            demo._log_task.cancel()
            try:
                await demo._log_task
            except (asyncio.CancelledError, Exception):
                pass
            demo._log_task = None
        return

    proc = demo._process
    if proc is None:
        return
    if proc.returncode is None:
        try:
            # Kill the whole process group so child Node, etc. die too.
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    proc.kill()
                await proc.wait()
        except Exception:
            logger.exception("demo terminate failed")
    demo._process = None
    demo.pid = None

    if demo._log_task is not None:
        demo._log_task.cancel()
        try:
            await demo._log_task
        except (asyncio.CancelledError, Exception):
            pass
        demo._log_task = None


# ── Public API ─────────────────────────────────────────────────────────


async def start(
    workspace_id: str,
    workspace_path: str,
    branch: str = "main",
    command: Optional[str] = None,
    port: Optional[int] = None,
) -> dict:
    """Idempotent — calling twice returns the running demo."""
    async with _lock:
        existing = _demos.get(workspace_id)
        if existing and existing.status in ("running", "starting", "building"):
            return existing.to_dict()

        cmd = command or (existing.command if existing else None) or "npm run dev"
        chosen_port = port or (existing.port if existing and existing.port else 0) or _pick_free_port()

        demo = existing or Demo(
            workspace_id=workspace_id,
            workspace_path=workspace_path,
            branch=branch,
            command=cmd,
            port=chosen_port,
        )
        demo.workspace_path = workspace_path
        demo.branch = branch
        demo.command = cmd
        demo.port = chosen_port
        demo.status = "starting"
        demo.error = None
        _demos[workspace_id] = demo
        _broadcast_state(demo)

        try:
            demo.last_commit = await _git_head(workspace_path)
        except Exception:
            demo.last_commit = None

        try:
            await _spawn(demo)
        except Exception as e:
            demo.status = "error"
            demo.error = str(e)
            _broadcast_state(demo)
            logger.exception("demo start failed")

        return demo.to_dict()


async def stop(workspace_id: str) -> dict:
    async with _lock:
        demo = _demos.get(workspace_id)
        if demo is None:
            return {"workspace_id": workspace_id, "status": "stopped"}
        await _terminate(demo)
        demo.status = "stopped"
        _broadcast_state(demo)
        return demo.to_dict()


async def status(workspace_id: str) -> Optional[dict]:
    demo = _demos.get(workspace_id)
    if demo is None:
        return None
    # Reap zombies — if process exited but we never noticed, mark stopped.
    if demo._process is not None and demo._process.returncode is not None and demo.status == "running":
        demo.status = "stopped"
        demo.pid = None
    elif demo._container is not None and demo.status == "running":
        # A container demo has no _process, so the check above can never fire for
        # it: a container that died would have been reported "running" forever.
        # The container's own state is the equivalent signal.
        try:
            import sidecars

            info = await sidecars._inspect(
                sidecars.container_name(demo.workspace_id, _container_sidecar_name()))
            if str(info.get("state") or "").lower() in ("stopped", "exited", "absent", "error"):
                demo.status = "stopped"
                demo.pid = None
        except Exception:
            logger.debug("demo container status check failed", exc_info=True)
    return demo.to_dict()


def _container_sidecar_name() -> str:
    try:
        import app_container as ac

        return ac.APP_SIDECAR_NAME
    except Exception:
        return "app"


async def list_all() -> list:
    return [d.to_dict() for d in _demos.values()]


async def pull_latest(workspace_id: str) -> dict:
    """Fetch + checkout + reinstall (if needed) + restart on the SAME port."""
    async with _lock:
        demo = _demos.get(workspace_id)
        if demo is None:
            return {"error": "no demo for workspace", "workspace_id": workspace_id}

        prior_port = demo.port or _pick_free_port()
        demo.port = prior_port
        demo.status = "building"
        demo.error = None
        _append_log(demo, f"[demo-runner] pulling latest on {demo.branch}…")
        _broadcast_state(demo)

        try:
            old_sha, new_sha = await _git_pull(demo.workspace_path, demo.branch)
            _append_log(demo, f"[demo-runner] git: {old_sha[:7] or 'unknown'} → {new_sha[:7] or 'unknown'}")

            need_install = await _files_changed(
                demo.workspace_path, old_sha, new_sha, ["package.json", "package-lock.json"]
            )
            if need_install:
                _append_log(demo, "[demo-runner] package manifest changed — running npm install")
                _broadcast_state(demo)
                rc, _out, err = await _run_subprocess(demo.workspace_path, ["npm", "install"])
                if rc != 0:
                    raise RuntimeError(f"npm install failed: {err.strip()[:400]}")

            await _terminate(demo)
            await _spawn(demo)
            demo.last_commit = new_sha
            import time

            demo.last_pull_at = time.time()
            _broadcast_state(demo)
            return demo.to_dict()
        except Exception as e:
            demo.status = "error"
            demo.error = str(e)
            _append_log(demo, f"[demo-runner] ERROR: {e}")
            _broadcast_state(demo)
            logger.exception("demo pull_latest failed")
            return demo.to_dict()


async def shutdown_all() -> None:
    """Called from on_cleanup to SIGTERM every demo."""
    for demo in list(_demos.values()):
        try:
            await _terminate(demo)
            demo.status = "stopped"
        except Exception:
            logger.exception("demo shutdown failed for %s", demo.workspace_id)


# ── Test helpers ───────────────────────────────────────────────────────
# These are intentionally underscore-prefixed; tests import them explicitly.

def _reset_for_tests() -> None:
    _demos.clear()
