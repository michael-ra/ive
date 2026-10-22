"""Manage Claude Code in real PTY sessions for full interactive terminal experience."""

import asyncio
import fcntl
import logging
import os
import pty
import signal
import struct
import termios
import threading
from typing import Callable, Optional

logger = logging.getLogger(__name__)


_INPUT_QUEUE_MAX = 256
# Give up on a PTY write only when the CLI reads nothing for this long.
_WRITE_STALL_SECS = 30.0
_OUTPUT_QUEUE_MAX = 64


def prepare_terminal_env(inherited: dict, extra: dict, cmd_binary: str,
                         plain_shell: bool = False, cwd: str | None = None) -> dict:
    """An IVE terminal is its own conversation, even when IVE was launched by Claude."""
    if plain_shell:
        # A plain terminal (cli_type "shell"): no agent identity, no forced
        # colours or fixed size, nothing from IVE's own process.
        from shell_session import shell_env
        return shell_env(inherited, extra, cwd)
    env = {**inherited, **extra}
    if os.path.basename(cmd_binary) in {"claude", "claude.exe"}:
        # These describe the parent agent, not this interactive session. In
        # particular CHILD_SESSION disables the transcript that Chat reads.
        # Keep account/config/security settings intact; only detach identity.
        for key in ("CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID"):
            env.pop(key, None)
        env["CLAUDE_CODE_FORCE_SESSION_PERSISTENCE"] = "1"
    return env


class PTYSession:
    def __init__(self, session_id: str, workspace_path: str,
                 cols: int = 120, rows: int = 40, cmd_args: list[str] | None = None,
                 extra_env: dict[str, str] | None = None, cmd_binary: str = "claude",
                 sandbox_type: str = "none", sandbox_network: bool = True,
                 geometry_owner: str | None = None, plain_shell: bool = False):
        self.session_id = session_id
        self.plain_shell = bool(plain_shell)
        self.workspace_path = workspace_path
        self.cols = max(cols, 80)
        self.rows = max(rows, 24)
        self.cmd_args = cmd_args or []
        self.extra_env = extra_env or {}
        self.cmd_binary = cmd_binary
        self.sandbox_type = sandbox_type
        self.sandbox_network = bool(sandbox_network)
        self.master_fd: Optional[int] = None
        self.pid: Optional[int] = None
        self._alive = False
        # Egress proxy handle (Wave 5). Started lazily inside
        # wrap_command_for_sandbox (docker tier) only when EGRESS_PROXY_ENFORCE
        # is on; torn down by this session on close. None in the default path.
        self._egress_handle = None
        self._fd_lock = threading.Lock()  # serialize write() vs _close_fd()
        self._output_cb: Optional[Callable] = None
        self._exit_cb: Optional[Callable] = None
        # async (session_id, info: dict) → None; told when queued input is lost
        self.input_error_cb: Optional[Callable] = None
        self._input_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=_INPUT_QUEUE_MAX)
        self._output_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=_OUTPUT_QUEUE_MAX)
        self._writer_task: Optional[asyncio.Task] = None
        self._output_task: Optional[asyncio.Task] = None
        self._reader_paused = False
        self._exit_notified = False
        self._closed_event = asyncio.Event()
        self.geometry_owner = geometry_owner

    async def start(self, output_cb: Callable, exit_cb: Callable):
        self._output_cb = output_cb
        self._exit_cb = exit_cb

        master_fd, slave_fd = pty.openpty()
        try:
            env, wrapped_cmd = self._prepare_spawn(slave_fd)
            pid = os.fork()
        except BaseException:
            # Never leak the PTY pair (or a started egress proxy) when
            # preparing the command or forking fails.
            try:
                os.close(slave_fd)
            except OSError:
                pass
            self.master_fd = master_fd
            self._close_fd()
            raise
        if pid == 0:
            # ── Child process ──
            try:
                os.close(master_fd)
                os.setsid()
                fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
                os.dup2(slave_fd, 0)
                os.dup2(slave_fd, 1)
                os.dup2(slave_fd, 2)
                if slave_fd > 2:
                    os.close(slave_fd)
                os.chdir(self.workspace_path)
                os.execvpe(wrapped_cmd[0], wrapped_cmd, env)
            except Exception as e:
                os.write(2, f"Failed to exec {wrapped_cmd[0]}: {e}\n".encode())
                os._exit(1)
        else:
            # ── Parent process ──
            os.close(slave_fd)
            self.master_fd = master_fd
            self.pid = pid
            self._alive = True

            # Non-blocking reads
            flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
            fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

            loop = asyncio.get_event_loop()
            self._writer_task = asyncio.create_task(self._drain_writes())
            self._output_task = asyncio.create_task(self._drain_output())
            loop.add_reader(master_fd, self._on_readable)

            asyncio.create_task(self._wait_exit())
            logger.info(f"PTY started: session={self.session_id} pid={pid}")

    def _prepare_spawn(self, slave_fd: int) -> tuple[dict, list[str]]:
        """Size the slave, build the env and the (sandbox-wrapped) command."""
        # Set terminal size on slave
        winsize = struct.pack("HHHH", self.rows, self.cols, 0, 0)
        fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)

        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["CLICOLOR"] = "1"
        env["CLICOLOR_FORCE"] = "1"
        env["FORCE_COLOR"] = "1"
        env["COLUMNS"] = str(self.cols)
        env["LINES"] = str(self.rows)
        env.pop("CI", None)
        env.pop("NO_COLOR", None)

        # Inject per-session env (e.g., ANTHROPIC_API_KEY for account override)
        env = prepare_terminal_env(env, self.extra_env, self.cmd_binary,
                                   plain_shell=self.plain_shell, cwd=self.workspace_path)
        env.pop("NON_INTERACTIVE", None)

        from sandbox_engine import wrap_command_for_sandbox
        cmd = [self.cmd_binary] + self.cmd_args
        if not self.plain_shell and self.sandbox_type == "none" and os.path.basename(self.cmd_binary) in {"claude", "claude.exe"}:
            from provider_statusline import configure
            cmd = [self.cmd_binary] + configure(self.cmd_args, env, self.session_id, self.workspace_path)
        # ctx is a return-channel for an egress-proxy handle (Wave 5). It's only
        # populated when EGRESS_PROXY_ENFORCE is on + the docker tier starts a
        # proxy; otherwise it stays empty and behaviour is unchanged.
        sandbox_ctx: dict = {}
        try:
            wrapped_cmd = wrap_command_for_sandbox(cmd, self.workspace_path, self.sandbox_type, self.sandbox_network, self.session_id, env, ctx=sandbox_ctx)
        finally:
            # Record a started proxy even on failure so _close_fd stops it.
            self._egress_handle = sandbox_ctx.get("egress_proxy")
        logger.info(f"Starting PTY: session={self.session_id} cmd={wrapped_cmd} cwd={self.workspace_path} size={self.cols}x{self.rows}")
        return env, wrapped_cmd

    def _on_readable(self):
        if self.master_fd is None or not self._alive:
            return
        if self._output_queue.full():
            self._pause_reader()
            return
        try:
            data = os.read(self.master_fd, 65536)
            if data:
                self._output_queue.put_nowait(data)
                if self._output_queue.full():
                    self._pause_reader()
            else:
                self._pause_reader()
        except (OSError, IOError) as e:
            logger.debug(f"PTY read: {e}")

    def _pause_reader(self) -> None:
        if self._reader_paused or self.master_fd is None:
            return
        try:
            asyncio.get_event_loop().remove_reader(self.master_fd)
            self._reader_paused = True
        except (RuntimeError, ValueError):
            pass

    def _resume_reader(self) -> None:
        if not self._reader_paused or self.master_fd is None or not self._alive:
            return
        try:
            asyncio.get_event_loop().add_reader(self.master_fd, self._on_readable)
            self._reader_paused = False
        except (RuntimeError, ValueError):
            pass

    async def _drain_output(self) -> None:
        """Run at most one ordered callback chain for this session."""
        while True:
            data = await self._output_queue.get()
            self._resume_reader()
            try:
                if self._output_cb:
                    await self._output_cb(self.session_id, data)
            finally:
                self._output_queue.task_done()

    async def _wait_exit(self):
        while self._alive:
            try:
                wpid, status = os.waitpid(self.pid, os.WNOHANG)
                if wpid != 0:
                    code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1
                    logger.info(f"PTY exited: session={self.session_id} code={code}")
                    await self._finalize_exit(code)
                    return
            except ChildProcessError:
                await self._finalize_exit(-1)
                return
            await asyncio.sleep(0.1)

    async def _finalize_exit(self, code: int) -> None:
        if self._exit_notified:
            return
        self._exit_notified = True
        self._alive = False
        self._pause_reader()
        await self._drain_fd_tail()
        self._close_fd()
        try:
            await asyncio.wait_for(self._output_queue.join(), timeout=2.0)
        except asyncio.TimeoutError:
            logger.warning("PTY output drain timed out: session=%s", self.session_id)
        for task in (self._output_task, self._writer_task):
            if task is not None:
                task.cancel()
        await asyncio.gather(
            *(task for task in (self._output_task, self._writer_task) if task is not None),
            return_exceptions=True,
        )
        try:
            if self._exit_cb:
                await self._exit_cb(self.session_id, code, self)
        finally:
            self._closed_event.set()

    async def _drain_fd_tail(self) -> None:
        """Capture bytes already buffered by the kernel before closing the PTY."""
        while self.master_fd is not None:
            try:
                data = os.read(self.master_fd, 65536)
            except BlockingIOError:
                return
            except OSError:
                return
            if not data:
                return
            await self._output_queue.put(data)

    async def wait_closed(self) -> None:
        await self._closed_event.wait()

    def is_alive(self) -> bool:
        return bool(self._alive and self.pid is not None and self.master_fd is not None)

    def _close_fd(self):
        with self._fd_lock:
            if self.master_fd is not None:
                try:
                    asyncio.get_event_loop().remove_reader(self.master_fd)
                except Exception:
                    pass
                try:
                    os.close(self.master_fd)
                except OSError:
                    pass
                self.master_fd = None
                self._reader_paused = False
        # Tear down any egress proxy started for this session (Wave 5). Idempotent
        # and a no-op when no proxy was started (the default path). Outside the
        # fd_lock so a slow proxy kill never blocks write()/_close_fd contention.
        handle = self._egress_handle
        if handle is not None:
            self._egress_handle = None
            try:
                import egress_policy
                egress_policy.stop_egress_proxy(handle)
            except Exception as e:  # never let teardown crash session shutdown
                logger.warning(f"egress proxy teardown failed: session={self.session_id} err={e}")

    def write(self, data: bytes) -> bool:
        """Queue input without blocking the event-loop thread."""
        if self.master_fd is None or not self._alive:
            return False
        try:
            self._input_queue.put_nowait(bytes(data))
            return True
        except asyncio.QueueFull:
            logger.warning("PTY input queue full: session=%s", self.session_id)
            return False

    async def _drain_writes(self) -> None:
        """Write queued input in order on a worker thread."""
        while True:
            data = await self._input_queue.get()
            try:
                written = await asyncio.to_thread(self._write_blocking, data)
                if not written and self._alive:
                    await self._abort_queued_input(len(data))
            finally:
                self._input_queue.task_done()

    async def _abort_queued_input(self, failed_bytes: int) -> None:
        """Drop input queued behind a failed write and report it.

        Queued items belong to the same delivery (text, then a separate
        Enter). Writing them after a partial write would submit a truncated
        prompt, so everything still queued is discarded.
        """
        dropped = 0
        while True:
            try:
                self._input_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            self._input_queue.task_done()
            dropped += 1
        logger.error(
            "PTY input write incomplete: session=%s bytes=%d; dropped %d queued input(s)",
            self.session_id, failed_bytes, dropped,
        )
        if self.input_error_cb is not None:
            try:
                await self.input_error_cb(self.session_id, {
                    "reason": "input_stalled",
                    "bytes": failed_bytes,
                    "dropped": dropped,
                })
            except Exception:
                logger.exception("PTY input error callback failed: session=%s", self.session_id)

    def _write_blocking(self, data: bytes) -> bool:
        """Retry a non-blocking PTY write without sleeping under ``_fd_lock``.

        The kernel's PTY input buffer is small (about 1 KB on macOS). A paste
        larger than that only goes through as fast as the CLI reads it, and a
        busy CLI may not read for a while. Keep retrying as long as the
        session lives and the reader makes progress within
        ``_WRITE_STALL_SECS``; a fixed retry count truncated every paste
        larger than the buffer.
        """
        import errno as _errno
        import time as _time

        offset = 0
        delay = 0.002
        last_progress = _time.monotonic()
        while offset < len(data):
            would_block = False
            with self._fd_lock:
                if self.master_fd is None or not self._alive:
                    return False
                try:
                    written = os.write(self.master_fd, data[offset:])
                    offset += written
                    if written:
                        last_progress = _time.monotonic()
                        delay = 0.002
                except OSError as exc:
                    if exc.errno in (_errno.EAGAIN, _errno.EWOULDBLOCK, _errno.EINTR):
                        would_block = True
                    else:
                        logger.error(
                            "PTY write error: session=%s err=%s",
                            self.session_id,
                            exc,
                        )
                        return False
            if would_block:
                if _time.monotonic() - last_progress > _WRITE_STALL_SECS:
                    logger.error(
                        "PTY input stalled: session=%s wrote %d of %d bytes",
                        self.session_id, offset, len(data),
                    )
                    return False
                _time.sleep(delay)
                delay = min(delay * 2, 0.05)
        return True

    def resize(self, cols: int, rows: int) -> bool:
        # Clamp into the unsigned-short range that struct.pack("HHHH") accepts.
        # Out-of-range values raise struct.error, which previously escaped the
        # WS dispatch loop and tore down the connection (BUG C3).
        try:
            cols = int(cols)
            rows = int(rows)
        except (TypeError, ValueError):
            return False
        cols = max(1, min(cols, 9999))
        rows = max(1, min(rows, 9999))
        if cols == self.cols and rows == self.rows:
            return False
        pid = self.pid
        try:
            with self._fd_lock:
                if self.master_fd is None or not self._alive:
                    return False
                winsize = struct.pack("HHHH", rows, cols, 0, 0)
                fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, winsize)
                self.cols = cols
                self.rows = rows
            if pid:
                self._signal_owned_process(signal.SIGWINCH)
            return True
        except (OSError, ProcessLookupError, struct.error):
            return False

    def request_geometry(self, viewer_id: str, cols: int | None, rows: int | None) -> dict:
        """Let one viewer own PTY geometry; all others use its dimensions.

        cols/rows None: report the geometry without resizing the PTY.
        """
        if self.geometry_owner is None:
            self.geometry_owner = viewer_id
        authoritative = self.geometry_owner == viewer_id
        wants_size = cols is not None and rows is not None
        changed = self.resize(cols, rows) if authoritative and wants_size else False
        return {
            "authoritative": authoritative,
            "changed": changed,
            "cols": self.cols,
            "rows": self.rows,
        }

    def release_geometry(self, viewer_id: str) -> bool:
        if self.geometry_owner != viewer_id:
            return False
        self.geometry_owner = None
        return True

    def _signal_owned_process(self, sig: int) -> bool:
        """Never signal an inherited process group while the child starts.

        fork() returns in the parent before the child necessarily calls setsid().
        Until the child leads its own group, only its PID belongs to this PTY.
        """
        pid = self.pid
        if not self._alive or not pid or pid <= 0 or pid == os.getpid():
            return False
        try:
            pgid = os.getpgid(pid)
            if pgid == pid and pgid != os.getpgrp():
                os.killpg(pid, sig)
            else:
                os.kill(pid, sig)
            return True
        except (ProcessLookupError, PermissionError):
            return False

    def claim_geometry(self, viewer_id: str, cols: int, rows: int) -> tuple[str | None, dict]:
        """Take PTY geometry from whoever owns it (a phone opening a session
        full screen). Returns the previous owner and the new geometry."""
        previous = self.geometry_owner
        self.geometry_owner = viewer_id
        changed = self.resize(cols, rows) if cols is not None and rows is not None else False
        return previous, {"authoritative": True, "changed": changed, "cols": self.cols, "rows": self.rows}

    def terminate(self):
        """Send signals but let _wait_exit detect the death and fire callbacks."""
        if self._alive and self.pid:
            # SIGINT first (Claude Code handles this for graceful shutdown).
            self._signal_owned_process(signal.SIGINT)
            # Schedule SIGTERM then SIGKILL as escalation
            asyncio.get_event_loop().call_later(2, self._escalate_kill, signal.SIGTERM)
            asyncio.get_event_loop().call_later(5, self._escalate_kill, signal.SIGKILL)

    def _escalate_kill(self, sig):
        """Send escalating signal if process is still alive."""
        if not self._alive or not self.pid:
            return
        self._signal_owned_process(sig)


class PTYManager:
    def __init__(self):
        self._sessions: dict[str, PTYSession] = {}
        self._blocked_starts: set[str] = set()
        self._output_cbs: list[Callable] = []
        self._exit_cbs: list[Callable] = []
        self._input_error_cbs: list[Callable] = []

    def on_output(self, cb: Callable):
        self._output_cbs.append(cb)

    def on_input_error(self, cb: Callable):
        """async cb(session_id, info) when queued input was dropped."""
        self._input_error_cbs.append(cb)

    async def _on_input_error(self, session_id: str, info: dict):
        for cb in self._input_error_cbs:
            try:
                await cb(session_id, info)
            except Exception as e:
                logger.error(f"Input error callback error: {e}")

    def on_exit(self, cb: Callable):
        self._exit_cbs.append(cb)

    async def _on_output(self, session_id: str, data: bytes):
        for cb in self._output_cbs:
            try:
                await cb(session_id, data)
            except Exception as e:
                logger.error(f"Output callback error: {e}")

    async def _on_exit(self, session_id: str, code: int, source: PTYSession):
        for cb in self._exit_cbs:
            try:
                await cb(session_id, code)
            except Exception as e:
                logger.error(f"Exit callback error: {e}")
        if self._sessions.get(session_id) is source:
            self._sessions.pop(session_id, None)

    async def start_session(self, session_id: str, workspace_path: str,
                            cols: int = 120, rows: int = 40, cmd_args: list[str] | None = None,
                            extra_env: dict[str, str] | None = None, cmd_binary: str = "claude",
                            sandbox_type: str = "none", sandbox_network: bool = True,
                            geometry_owner: str | None = None, plain_shell: bool = False):
        if self.is_session_start_blocked(session_id):
            raise RuntimeError("session is being deleted")
        existing = self._sessions.get(session_id)
        if existing and existing.is_alive():
            logger.warning(f"Session {session_id} already has a running PTY")
            return
        if existing:
            await existing.wait_closed()
            if self._sessions.get(session_id) is existing:
                self._sessions.pop(session_id, None)
        # A deletion may have reserved the session while wait_closed yielded.
        # From this check through fork(), PTYSession.start does not yield.
        if self.is_session_start_blocked(session_id):
            raise RuntimeError("session is being deleted")
        session = PTYSession(
            session_id, workspace_path, cols, rows, cmd_args, extra_env,
            cmd_binary, sandbox_type, sandbox_network, geometry_owner,
            plain_shell=plain_shell,
        )
        session.input_error_cb = self._on_input_error
        self._sessions[session_id] = session
        try:
            await session.start(self._on_output, self._on_exit)
        except Exception:
            if self._sessions.get(session_id) is session:
                self._sessions.pop(session_id, None)
            session._closed_event.set()
            raise

    def write(self, session_id: str, data: bytes):
        s = self._sessions.get(session_id)
        return s.write(data) if s else False

    def resize(self, session_id: str, cols: int, rows: int):
        s = self._sessions.get(session_id)
        return s.resize(cols, rows) if s else False

    def request_geometry(self, session_id: str, viewer_id: str, cols: int, rows: int) -> dict | None:
        session = self._sessions.get(session_id)
        return session.request_geometry(viewer_id, cols, rows) if session and session.is_alive() else None

    def get_launch_model(self, session_id: str) -> str | None:
        session = self._sessions.get(session_id)
        if not session or not session.is_alive():
            return None
        args = session.cmd_args
        model = None
        for i, arg in enumerate(args):
            if arg in ("--model", "-m") and i + 1 < len(args):
                model = args[i + 1]
            elif arg.startswith("--model="):
                model = arg.partition("=")[2]
        return model

    def get_geometry(self, session_id: str) -> dict | None:
        session = self._sessions.get(session_id)
        if not session or not session.is_alive():
            return None
        return {"cols": session.cols, "rows": session.rows}

    def expand_unowned_geometry(self, session_id: str) -> dict | None:
        """Give Overview a complete current prompt without taking a viewer's PTY."""
        session = self._sessions.get(session_id)
        if not session or not session.is_alive():
            return None
        if session.geometry_owner is not None:
            return {"changed": False, "state": "terminal_in_use"}
        rows = min(400, max(200, session.rows * 2))
        if session.rows >= rows:
            return {"changed": False, "state": "incomplete"}
        changed = session.resize(session.cols, rows)
        return {"changed": changed, "state": "refreshing" if changed else "incomplete"}

    def claim_geometry(self, session_id: str, viewer_id: str, cols: int, rows: int):
        session = self._sessions.get(session_id)
        if not session or not session.is_alive():
            return None, None
        return session.claim_geometry(viewer_id, cols, rows)

    def release_geometry(self, session_id: str, viewer_id: str) -> bool:
        session = self._sessions.get(session_id)
        return bool(session and session.release_geometry(viewer_id))

    def release_geometry_owner(self, viewer_id: str) -> list[str]:
        return [
            session_id for session_id, session in self._sessions.items()
            if session.release_geometry(viewer_id)
        ]

    def session_ids(self) -> list[str]:
        return list(self._sessions)

    def block_session_start(self, session_id: str) -> None:
        self._blocked_starts.add(session_id)

    def unblock_session_start(self, session_id: str) -> None:
        self._blocked_starts.discard(session_id)

    def is_session_start_blocked(self, session_id: str) -> bool:
        return session_id in self._blocked_starts

    def is_alive(self, session_id: str) -> bool:
        s = self._sessions.get(session_id)
        return bool(s and s.is_alive())

    async def stop_session(self, session_id: str):
        s = self._sessions.get(session_id)
        if s:
            s.terminate()
            await s.wait_closed()

    async def stop_all(self):
        sessions = list(self._sessions.values())
        for session in sessions:
            session.terminate()
        await asyncio.gather(*(session.wait_closed() for session in sessions))


CLEAR_INPUT = b"\x1b" + b"\x7f" * 20


async def submit_prompt(
    mgr,
    session_id: str,
    payload: bytes,
    *,
    clear: Optional[bytes] = CLEAR_INPUT,
    clear_settle: float = 0.15,
    submit_delay: float = 0.4,
) -> bool:
    """Clear the input line, type ``payload`` and press Enter.

    Text and Enter are separate writes (Ink paste detection swallows a
    trailing CR). Enter is only sent when every earlier write was accepted,
    so a rejected prompt (full input queue, dead PTY) is never half
    submitted. ``mgr`` is anything with ``write(session_id, data)``.
    """
    if clear is not None:
        if mgr.write(session_id, clear) is False:
            logger.warning("Prompt not delivered (clear rejected): session=%s", session_id)
            return False
        await asyncio.sleep(clear_settle)
    if mgr.write(session_id, payload) is False:
        logger.warning("Prompt not delivered (text rejected): session=%s", session_id)
        return False
    await asyncio.sleep(submit_delay)
    if mgr.write(session_id, b"\r") is False:
        logger.warning("Prompt typed but Enter rejected: session=%s", session_id)
        return False
    return True
