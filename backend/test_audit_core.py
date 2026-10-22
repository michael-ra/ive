"""Regression tests for core runtime audit findings (hooks, supervisor, PTY)."""

import asyncio
import time
import unittest
from unittest import mock


class _FakeCursor:
    def __init__(self, row):
        self._row = row

    async def fetchone(self):
        return self._row


class _FakeDb:
    def __init__(self, row):
        self.row = row
        self.closed = False

    async def execute(self, _sql, _params=()):
        return _FakeCursor(self.row)

    async def close(self):
        self.closed = True


class IdleReflectionContextTests(unittest.TestCase):
    def test_lookup_returns_cli_type_and_workspace(self):
        import hooks

        db = _FakeDb({"cli_type": "gemini", "workspace_id": "ws-1"})

        async def fake_get_db():
            return db

        with mock.patch("db.get_db", fake_get_db):
            result = asyncio.run(hooks._idle_reflection_context("session-1"))
        self.assertEqual(result, ("gemini", "ws-1"))
        self.assertTrue(db.closed)

    def test_lookup_failure_is_logged_not_swallowed(self):
        import hooks

        async def broken_get_db():
            raise RuntimeError("db down")

        with mock.patch("db.get_db", broken_get_db), \
                self.assertLogs("hooks", level="WARNING") as logs:
            result = asyncio.run(hooks._idle_reflection_context("session-1"))
        self.assertEqual(result, (None, None))
        self.assertIn("Idle reflection", "\n".join(logs.output))


class CliSwitchTerminalHandoffTests(unittest.TestCase):
    def test_tail_handoff_strips_ansi_without_workspace(self):
        import server

        with mock.patch.object(server.capture_proc, "get_buffer",
                               return_value="\x1b[1mbuilt the parser\x1b[0m\nall tests green"):
            summary = server._terminal_tail_handoff("s1", "claude", "codex")
        self.assertIn("Switching from CLAUDE to CODEX", summary)
        self.assertIn("built the parser", summary)
        self.assertNotIn("\x1b", summary)

    def test_tail_handoff_empty_buffer(self):
        import server

        with mock.patch.object(server.capture_proc, "get_buffer", return_value=""):
            self.assertEqual(server._terminal_tail_handoff("s1", "claude", "codex"), "")


class SupervisorCrashLoopTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import session_supervisor as sup
        from types import SimpleNamespace

        self.sup = sup
        self.restarts = 0
        self.alive = False
        row = {"id": "s1", "status": "running", "cli_type": "claude", "workspace_id": "ws"}

        async def fake_restart(session_id, **_kw):
            self.restarts += 1
            h = sup._health[session_id]
            h.crashed_at = None
            h.alive = True
            h.last_restart_at = time.time()
            self.alive = True
            return {"ok": True}

        self.emit = mock.AsyncMock()
        patches = (
            mock.patch.object(sup, "RESTART_BACKOFF_SECS", (0, 0, 0)),
            mock.patch.object(sup, "_running", True),
            mock.patch.object(sup, "_pty_manager", SimpleNamespace(is_alive=lambda _sid: self.alive)),
            mock.patch.object(sup, "_load_session_row", mock.AsyncMock(return_value=row)),
            mock.patch.object(sup, "_auto_restart_enabled", mock.AsyncMock(return_value=True)),
            mock.patch.object(sup, "bus", SimpleNamespace(emit=self.emit)),
            mock.patch.object(sup, "restart", fake_restart),
            mock.patch.dict(sup._health, {}, clear=True),
            mock.patch.dict(sup._restart_tasks, {}, clear=True),
        )
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    async def _crash_and_settle(self):
        self.sup.mark_started("s1")
        self.alive = False
        self.assertEqual(await self.sup.record_exit("s1", 1), "crashed")
        task = self.sup._restart_tasks.get("s1")
        if task is not None:
            await task

    def _failed_events(self):
        from commander_events import CommanderEvent
        return [c for c in self.emit.await_args_list
                if c.args[0] == CommanderEvent.SESSION_RESTART_FAILED]

    async def test_immediate_crashes_exhaust_the_restart_budget(self):
        for _ in range(self.sup.RESTART_MAX_ATTEMPTS + 2):
            await self._crash_and_settle()
        self.assertEqual(self.restarts, self.sup.RESTART_MAX_ATTEMPTS)
        self.assertTrue(self._failed_events())

    async def test_stable_run_resets_the_budget(self):
        for _ in range(self.sup.RESTART_MAX_ATTEMPTS):
            await self._crash_and_settle()
        h = self.sup._health["s1"]
        h.last_restart_at = time.time() - self.sup.RESTART_STABLE_SECS - 1
        await self._crash_and_settle()
        self.assertEqual(self.restarts, self.sup.RESTART_MAX_ATTEMPTS + 1)
        self.assertFalse(self._failed_events())

    async def test_death_during_restart_is_not_lost(self):
        sup = self.sup
        calls = []

        async def restart_that_dies(session_id, **_kw):
            calls.append(session_id)
            h = sup._health[session_id]
            h.crashed_at = None
            h.last_restart_at = time.time()
            self.alive = len(calls) >= 2  # first replacement dies at once
            return {"ok": True}

        with mock.patch.object(sup, "restart", restart_that_dies):
            await self._crash_and_settle()
        self.assertEqual(len(calls), 2)
        self.assertTrue(self.alive)

    async def test_restart_task_errors_are_logged(self):
        async def boom(_sid):
            raise RuntimeError("driver broke")

        with mock.patch.object(self.sup, "_auto_restart_with_backoff", boom), \
                self.assertLogs("session_supervisor", level="ERROR") as logs:
            await self._crash_and_settle_raising()
        self.assertIn("auto-restart task", "\n".join(logs.output))

    async def _crash_and_settle_raising(self):
        self.sup.mark_started("s1")
        self.alive = False
        await self.sup.record_exit("s1", 1)
        task = self.sup._restart_tasks.get("s1")
        self.assertIsNotNone(task)
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.sleep(0)


class _RejectingMgr:
    """PTY manager stand-in whose input queue rejects one payload."""

    def __init__(self, rejected: bytes):
        self.rejected = rejected
        self.writes = []

    def is_alive(self, _sid):
        return True

    def write(self, _sid, data):
        self.writes.append(data)
        return data != self.rejected


class PtyInputFailureTests(unittest.IsolatedAsyncioTestCase):
    async def _drain(self, session):
        drain = asyncio.create_task(session._drain_writes())
        try:
            await asyncio.wait_for(session._input_queue.join(), timeout=2)
        finally:
            drain.cancel()
            await asyncio.gather(drain, return_exceptions=True)

    async def test_stalled_write_drops_the_queued_enter_and_reports(self):
        from pty_manager import PTYSession

        session = PTYSession("s1", "/tmp")
        session.master_fd = -1  # never touched: _write_blocking is replaced
        session._alive = True
        attempted = []
        errors = []

        def fake_write_blocking(data):
            attempted.append(data)
            return data != b"half a prompt"  # this write stalls

        async def on_error(session_id, info):
            errors.append((session_id, info))

        session._write_blocking = fake_write_blocking
        session.input_error_cb = on_error
        self.assertTrue(session.write(b"half a prompt"))
        self.assertTrue(session.write(b"\r"))
        await self._drain(session)
        self.assertEqual(attempted, [b"half a prompt"])
        self.assertEqual(errors, [("s1", {"reason": "input_stalled", "bytes": 13, "dropped": 1})])

        # Later, independent input is delivered again.
        self.assertTrue(session.write(b"next"))
        await self._drain(session)
        self.assertEqual(attempted[-1], b"next")

    async def test_submit_prompt_never_sends_enter_after_rejected_text(self):
        from pty_manager import submit_prompt

        mgr = _RejectingMgr(b"prompt")
        ok = await submit_prompt(mgr, "s1", b"prompt", clear_settle=0, submit_delay=0)
        self.assertFalse(ok)
        self.assertNotIn(b"\r", mgr.writes)

    async def test_idle_reflection_skips_enter_when_text_is_rejected(self):
        import idle_reflection

        mgr = _RejectingMgr(b"reflect now")

        async def no_db():
            raise RuntimeError("no db in this test")

        bus = mock.MagicMock(emit=mock.AsyncMock())
        with mock.patch.object(idle_reflection, "_pty_mgr", mgr), \
                mock.patch.object(idle_reflection, "get_db", no_db), \
                mock.patch.object(idle_reflection, "_build_prompt", return_value="reflect now"), \
                mock.patch.object(idle_reflection, "bus", bus), \
                mock.patch("pty_manager.asyncio.sleep", mock.AsyncMock()):
            await idle_reflection._fire("s1", "claude", "ws")
        self.assertEqual(mgr.writes[-1], b"reflect now")
        self.assertNotIn(b"\r", mgr.writes)
        bus.emit.assert_not_awaited()


class PtySpawnCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_command_preparation_closes_both_pty_fds(self):
        import os
        import pty
        from pty_manager import PTYSession

        opened = []
        real_openpty = pty.openpty

        def tracking_openpty():
            fds = real_openpty()
            opened.extend(fds)
            return fds

        async def noop(*_a):
            return None

        session = PTYSession("s1", "/tmp", cmd_binary="sh", plain_shell=True)
        with mock.patch("pty.openpty", tracking_openpty), \
                mock.patch("sandbox_engine.wrap_command_for_sandbox",
                           side_effect=RuntimeError("sandbox unavailable")), \
                mock.patch("os.fork") as fork:
            with self.assertRaises(RuntimeError):
                await session.start(noop, noop)
        fork.assert_not_called()
        self.assertEqual(len(opened), 2)
        for fd in opened:
            with self.assertRaises(OSError):
                os.fstat(fd)
        self.assertIsNone(session.master_fd)

    def test_statusline_configure_without_home_in_env(self):
        import provider_statusline

        env = {"PATH": "/usr/bin"}
        args = provider_statusline.configure([], env, "s1", "/nonexistent-workspace")
        self.assertIn("--settings", args)


class PipelineOwnershipTests(unittest.IsolatedAsyncioTestCase):
    """pipeline.py and pipeline_engine.py both hear TASK_STATUS_CHANGED."""

    async def asyncSetUp(self):
        import tempfile
        from pathlib import Path

        import db as database
        import pipeline_engine

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for name, value in (("DATA_DIR", Path(self.tmp.name)),
                            ("DB_PATH", Path(self.tmp.name) / "state.db")):
            p = mock.patch.object(database, name, value)
            p.start()
            self.addCleanup(p.stop)
        await database.init_db()
        self.db = await database.get_db()
        self.addAsyncCleanup(self.db.close)
        await self.db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws','Fixture',?)", (self.tmp.name,))
        await self.db.execute(
            "INSERT INTO tasks(id,workspace_id,title,status,pipeline) VALUES('t1','ws','Task','review',1)")
        await self.db.commit()
        self.engine = pipeline_engine
        p = mock.patch.object(pipeline_engine, "_pipeline_task_ids", set())
        p.start()
        self.addCleanup(p.stop)

    async def _deliver_review_event(self):
        import pipeline
        from commander_events import CommanderEvent

        payload = {"task_id": "t1", "new_status": "review", "workspace_id": "ws"}
        with mock.patch.object(pipeline, "_maybe_route_to_testing", mock.AsyncMock()) as route:
            await pipeline._on_task_status_changed(CommanderEvent.TASK_STATUS_CHANGED.value, payload)
        return route

    async def test_legacy_loop_handles_tasks_without_engine_run(self):
        route = await self._deliver_review_event()
        route.assert_awaited_once_with("t1")

    async def test_legacy_loop_skips_task_with_active_engine_run(self):
        defn = await self.engine.create_definition(
            {"workspace_id": "ws", "name": "Exec", "stages": [], "transitions": []})
        await self.db.execute(
            "INSERT INTO pipeline_runs(id,pipeline_id,workspace_id,task_id,status) "
            "VALUES('r1',?,'ws','t1','running')", (defn["id"],))
        await self.db.commit()
        route = await self._deliver_review_event()
        route.assert_not_awaited()

    async def test_legacy_loop_skips_when_engine_trigger_will_start_a_run(self):
        await self.engine.create_definition({
            "workspace_id": "ws", "name": "On review", "status": "active",
            "stages": [], "transitions": [],
            "triggers": [{"type": "board_column", "config": {"column": "review"}}],
        })
        route = await self._deliver_review_event()
        route.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
