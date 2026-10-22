"""Bounded background cleanup using owned test tasks/processes only."""
import asyncio
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from subprocess_control import terminate_process_group
from test_graceful_shutdown import server_objects
import session_supervisor


class BackgroundStopTests(unittest.IsolatedAsyncioTestCase):
    async def test_short_pending_write_finishes_before_background_cancellation(self):
        completed = []
        async def persist():
            await asyncio.sleep(.01)
            completed.append("persisted")
        jobs = set()
        functions = server_objects("_fire_and_forget", "_settle_background_tasks", _bg_tasks=jobs)
        functions._fire_and_forget(persist())
        await functions._settle_background_tasks(grace=.05, cancel_timeout=.1)
        self.assertEqual(completed, ["persisted"])
        self.assertFalse(jobs)

    async def test_stopping_does_not_spawn_summary_and_preserves_pty_bookkeeping(self):
        log, jobs = [], set()
        async def summary():
            log.append("summary started")
        async def stop_ptys():
            log.append("exit persisted")
            functions._fire_and_forget(summary())
        functions = server_objects("_fire_and_forget", "on_shutdown", _bg_tasks=jobs,
                                   ws_clients=set(), _stop_all_ptys_expected=stop_ptys)
        with patch.object(session_supervisor, "stop", AsyncMock()):
            await functions.on_shutdown(SimpleNamespace())
        await asyncio.sleep(0)
        self.assertEqual(log, ["exit persisted"])
        self.assertFalse(jobs)

    async def test_long_background_job_is_cancelled_and_awaited(self):
        started, closed = asyncio.Event(), asyncio.Event()
        async def background():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(.01)
                closed.set()
        jobs = set()
        functions = server_objects("_fire_and_forget", "_settle_background_tasks", _bg_tasks=jobs)
        functions._fire_and_forget(background())
        await started.wait()
        await asyncio.wait_for(functions._settle_background_tasks(grace=.01, cancel_timeout=.1), timeout=.3)
        self.assertTrue(closed.is_set())
        self.assertFalse(jobs)


class OwnedProcessStopTests(unittest.IsolatedAsyncioTestCase):
    async def test_killed_child_with_full_output_pipe_does_not_hold_backend_open(self):
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", "import os\nwhile True: os.write(1, b'x' * 65536)",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=1024, start_new_session=True,
        )
        self.addAsyncCleanup(terminate_process_group, process, timeout=.1)
        await asyncio.sleep(.1)
        await asyncio.wait_for(terminate_process_group(process, timeout=.1), timeout=1.5)
        self.assertIsNotNone(process.returncode)


if __name__ == "__main__":
    unittest.main()
