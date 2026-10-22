"""Graceful backend shutdown and the one-backend-per-data-dir lock.

Isolated: temp dir only, a real PTY running `sleep` (no agent CLI), no server,
no network, no real IVE data dir.
"""
import ast
import asyncio
import json
import logging
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import aiohttp
from aiohttp import web

import instance_lock
import session_supervisor as supervisor
from pty_manager import PTYManager


def server_objects(*names, **dependencies):
    """Compile only the named top-level functions from server.py."""
    tree = ast.parse(Path(__file__).with_name("server.py").read_text())
    kinds = (ast.FunctionDef, ast.AsyncFunctionDef)
    included = set(names) | {"_settle_background_tasks"}
    subset = ast.Module(body=[n for n in tree.body if isinstance(n, kinds) and n.name in included], type_ignores=[])
    namespace = dict(web=web, json=json, asyncio=asyncio, _asyncio=asyncio, aiohttp=aiohttp,
                     _bg_tasks=set(), _server_stopping=False, logger=logging.getLogger("test"))
    namespace.update(dependencies)
    exec(compile(subset, "server.py", "exec"), namespace)
    return SimpleNamespace(**{name: namespace[name] for name in names})


class FakeWs:
    def __init__(self, log):
        self.log = log
        self.close_code = None

    async def close(self, code=None, message=b""):
        self.close_code = code
        self.log.append("ws_closed")


class GracefulShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.mgr = PTYManager()
        self.addAsyncCleanup(self.mgr.stop_all)
        self.classified = {}

        async def on_exit(session_id, code):
            # Same classification call as server.handle_pty_exit.
            self.classified[session_id] = await supervisor.record_exit(session_id, code)

        self.mgr.on_exit(on_exit)
        row = {"id": "s1", "status": "running", "cli_type": "claude", "workspace_id": "ws"}
        for p in (
            patch.object(supervisor, "_load_session_row", AsyncMock(return_value=row)),
            patch.object(supervisor, "_auto_restart_enabled", AsyncMock(return_value=True)),
            patch.object(supervisor, "bus", SimpleNamespace(emit=AsyncMock())),
            patch.object(supervisor, "_auto_restart_with_backoff", AsyncMock()),
        ):
            p.start()
            self.addCleanup(p.stop)

    async def start_pty(self, sid):
        await self.mgr.start_session(sid, self.tmp.name, cmd_binary="sleep", cmd_args=["60"])
        supervisor.mark_started(sid)
        self.assertTrue(self.mgr.is_alive(sid))

    async def test_shutdown_closes_sockets_then_stops_ptys_without_crash(self):
        await self.start_pty("s1")
        await self.start_pty("s2")
        log = []
        sockets = {FakeWs(log), FakeWs(log)}
        stop_all = self.mgr.stop_all

        async def logged_stop_all():
            log.append("ptys_stopping")
            await stop_all()

        self.mgr.stop_all = logged_stop_all
        srv = server_objects("_stop_all_ptys_expected", "on_shutdown", pty_mgr=self.mgr, ws_clients=sockets)
        with patch.object(supervisor, "stop", AsyncMock()) as sup_stop:
            await asyncio.wait_for(srv.on_shutdown(SimpleNamespace()), timeout=10)
        sup_stop.assert_awaited()
        self.assertEqual(log, ["ws_closed", "ws_closed", "ptys_stopping"])
        self.assertTrue(all(ws.close_code == aiohttp.WSCloseCode.GOING_AWAY for ws in sockets))
        self.assertEqual(self.classified, {"s1": "clean", "s2": "clean"})
        self.assertFalse(self.mgr.is_alive("s1"))
        supervisor.bus.emit.assert_not_awaited()

    async def test_unexpected_signal_exit_is_still_a_crash(self):
        await self.start_pty("s1")
        await self.mgr.stop_all()
        self.assertEqual(self.classified, {"s1": "crashed"})

    def test_wired_as_shutdown_handler(self):
        source = Path(__file__).with_name("server.py").read_text()
        self.assertIn("app.on_shutdown.append(on_shutdown)", source)


class InstanceLockTests(unittest.TestCase):
    def test_second_backend_on_same_data_dir_is_refused(self):
        with tempfile.TemporaryDirectory() as data_dir:
            fd = instance_lock.acquire(data_dir, wait_secs=0)
            try:
                self.assertEqual(Path(data_dir, instance_lock.LOCK_NAME).read_text().strip(), str(os.getpid()))
                with self.assertRaisesRegex(instance_lock.DataDirLocked, str(os.getpid())):
                    instance_lock.acquire(data_dir, wait_secs=0.3, poll_secs=0.05)
            finally:
                os.close(fd)
            # Released with the process (here: the fd) — the next start works.
            os.close(instance_lock.acquire(data_dir, wait_secs=0))


if __name__ == "__main__":
    unittest.main()
