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


# Rolling cache per session for late-joining viewers (replay on tab remount /
# WS reconnect). 256KB was too small for long sessions: a chatty TUI can fill
# it in seconds with cursor-position sequences, leaving the start of the
# stream truncated and the replay landing mid-CSI. 1MB gives us enough
# headroom that the cache typically contains a complete screen-establishing
# sequence even after extended streaming.
_OUTPUT_BUFFER_MAX = 1024 * 1024  # 1MB


class PTYSession:
    def __init__(self, session_id: str, workspace_path: str,
                 cols: int = 120, rows: int = 40, cmd_args: list[str] | None = None,
                 extra_env: dict[str, str] | None = None, cmd_binary: str = "claude"):
        self.session_id = session_id
        self.workspace_path = workspace_path
        self.cols = max(cols, 80)
        self.rows = max(rows, 24)
        self.cmd_args = cmd_args or []
        self.extra_env = extra_env or {}
        self.cmd_binary = cmd_binary
        self.master_fd: Optional[int] = None
        self.pid: Optional[int] = None
        self._alive = False
        self._fd_lock = threading.Lock()  # serialize write() vs _close_fd()
        self._output_cb: Optional[Callable] = None
        self._exit_cb: Optional[Callable] = None
        # Rolling output cache so a viewer that mounts after start_pty (e.g. a
        # grid cell rendering an already-alive session) can be brought up to
        # the current TUI state — without it the terminal stays blank until
        # the CLI happens to write fresh bytes.
        self._output_cache = bytearray()

    async def start(self, output_cb: Callable, exit_cb: Callable):
        self._output_cb = output_cb
        self._exit_cb = exit_cb

        master_fd, slave_fd = pty.openpty()

        # Set terminal size on slave
        winsize = struct.pack("HHHH", self.rows, self.cols, 0, 0)
        fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)

        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["COLUMNS"] = str(self.cols)
        env["LINES"] = str(self.rows)
        env.pop("CI", None)

        # Inject per-session env (e.g., ANTHROPIC_API_KEY for account override)
        env.update(self.extra_env)
        env.pop("NON_INTERACTIVE", None)

        cmd = [self.cmd_binary] + self.cmd_args
        logger.info(f"Starting PTY: session={self.session_id} cmd={cmd} cwd={self.workspace_path} size={self.cols}x{self.rows}")

        pid = os.fork()
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
                os.execvpe(self.cmd_binary, cmd, env)
            except Exception as e:
                os.write(2, f"Failed to exec {self.cmd_binary}: {e}\n".encode())
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
            loop.add_reader(master_fd, self._on_readable)

            asyncio.create_task(self._wait_exit())
            logger.info(f"PTY started: session={self.session_id} pid={pid}")

    def _on_readable(self):
        try:
            data = os.read(self.master_fd, 65536)
            if data:
                self._output_cache.extend(data)
                overflow = len(self._output_cache) - _OUTPUT_BUFFER_MAX
                if overflow > 0:
                    del self._output_cache[:overflow]
                if self._output_cb:
                    asyncio.ensure_future(self._output_cb(self.session_id, data))
        except (OSError, IOError) as e:
            logger.debug(f"PTY read: {e}")

    def get_cached_output(self) -> bytes:
        return bytes(self._output_cache)

    async def _wait_exit(self):
        while self._alive:
            try:
                wpid, status = os.waitpid(self.pid, os.WNOHANG)
                if wpid != 0:
                    code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1
                    logger.info(f"PTY exited: session={self.session_id} code={code}")
                    self._alive = False
                    self._close_fd()
                    if self._exit_cb:
                        await self._exit_cb(self.session_id, code)
                    return
            except ChildProcessError:
                self._alive = False
                self._close_fd()
                return
            await asyncio.sleep(0.1)

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

    def write(self, data: bytes) -> bool:
        with self._fd_lock:
            if self.master_fd is None or not self._alive:
                return False
            import errno as _errno
            import time as _time
            offset = 0
            retries = 0
            while offset < len(data) and retries < 20:
                try:
                    written = os.write(self.master_fd, data[offset:])
                    offset += written
                    retries = 0  # reset on success
                except OSError as e:
                    if e.errno == _errno.EAGAIN:
                        # PTY buffer full — brief sleep to let the reader drain
                        retries += 1
                        _time.sleep(0.01)  # 10ms
                    else:
                        logger.error(f"PTY write error: session={self.session_id} err={e}")
                        return False
            return offset == len(data)

    def resize(self, cols: int, rows: int):
        if self.master_fd is None:
            return
        # Clamp into the unsigned-short range that struct.pack("HHHH") accepts.
        # Out-of-range values raise struct.error, which previously escaped the
        # WS dispatch loop and tore down the connection (BUG C3).
        try:
            cols = int(cols)
            rows = int(rows)
        except (TypeError, ValueError):
            return
        cols = max(1, min(cols, 9999))
        rows = max(1, min(rows, 9999))
        self.cols = cols
        self.rows = rows
        try:
            winsize = struct.pack("HHHH", rows, cols, 0, 0)
            fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, winsize)
            if self.pid:
                os.killpg(os.getpgid(self.pid), signal.SIGWINCH)
        except (OSError, ProcessLookupError, struct.error):
            pass

    def terminate(self):
        """Send signals but let _wait_exit detect the death and fire callbacks."""
        if self.pid:
            try:
                pgid = os.getpgid(self.pid)
                # SIGINT first (Claude Code handles this for graceful shutdown)
                os.killpg(pgid, signal.SIGINT)
            except (ProcessLookupError, PermissionError):
                pass
            # Schedule SIGTERM then SIGKILL as escalation
            asyncio.get_event_loop().call_later(2, self._escalate_kill, signal.SIGTERM)
            asyncio.get_event_loop().call_later(5, self._escalate_kill, signal.SIGKILL)

    def _escalate_kill(self, sig):
        """Send escalating signal if process is still alive."""
        if not self._alive or not self.pid:
            return
        try:
            os.killpg(os.getpgid(self.pid), sig)
        except (ProcessLookupError, PermissionError):
            pass


class PTYManager:
    def __init__(self):
        self._sessions: dict[str, PTYSession] = {}
        self._output_cbs: list[Callable] = []
        self._exit_cbs: list[Callable] = []

    def on_output(self, cb: Callable):
        self._output_cbs.append(cb)

    def on_exit(self, cb: Callable):
        self._exit_cbs.append(cb)

    async def _on_output(self, session_id: str, data: bytes):
        for cb in self._output_cbs:
            try:
                await cb(session_id, data)
            except Exception as e:
                logger.error(f"Output callback error: {e}")

    async def _on_exit(self, session_id: str, code: int):
        self._sessions.pop(session_id, None)
        for cb in self._exit_cbs:
            try:
                await cb(session_id, code)
            except Exception as e:
                logger.error(f"Exit callback error: {e}")

    async def start_session(self, session_id: str, workspace_path: str,
                            cols: int = 120, rows: int = 40, cmd_args: list[str] | None = None,
                            extra_env: dict[str, str] | None = None, cmd_binary: str = "claude"):
        if session_id in self._sessions:
            logger.warning(f"Session {session_id} already has a running PTY")
            return
        session = PTYSession(session_id, workspace_path, cols, rows, cmd_args, extra_env, cmd_binary)
        self._sessions[session_id] = session
        await session.start(self._on_output, self._on_exit)

    def write(self, session_id: str, data: bytes):
        s = self._sessions.get(session_id)
        if s:
            s.write(data)

    def resize(self, session_id: str, cols: int, rows: int):
        s = self._sessions.get(session_id)
        if s:
            s.resize(cols, rows)

    def is_alive(self, session_id: str) -> bool:
        return session_id in self._sessions

    def get_cached_output(self, session_id: str) -> bytes:
        s = self._sessions.get(session_id)
        return s.get_cached_output() if s else b""

    async def stop_session(self, session_id: str):
        s = self._sessions.get(session_id)
        if s:
            s.terminate()
            # _on_exit will pop from _sessions when waitpid detects death

    async def stop_all(self):
        for sid in list(self._sessions):
            await self.stop_session(sid)
