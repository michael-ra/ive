"""Live activity of a session (last tool, finished turns) and the 'stopped'
status after a clean exit: what the board card shows after a reload."""
import ast
import asyncio
import json
import logging
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import AsyncMock, patch

from aiohttp import web

import db as database
import hooks
import quick_start
import session_supervisor


def server_objects(*names, **dependencies):
    """Compile only the named top-level functions from server.py."""
    tree = ast.parse(Path(__file__).with_name("server.py").read_text())
    kinds = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
    subset = ast.Module(
        body=[n for n in tree.body if isinstance(n, kinds) and n.name in names],
        type_ignores=[],
    )
    namespace = dict(
        web=web, uuid=uuid, json=json, asyncio=asyncio,
        logger=logging.getLogger("test"), **dependencies,
    )
    exec(compile(subset, "server.py", "exec"), namespace)
    missing = [n for n in names if n not in namespace]
    assert not missing, missing
    return SimpleNamespace(**{name: namespace[name] for name in names})


class ActivityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name).resolve()
        data = base / "data"
        data.mkdir()
        for target, value in [("DATA_DIR", data), ("DB_PATH", data / "test.db")]:
            p = patch.object(database, target, value); p.start(); self.addCleanup(p.stop)
        p = patch.dict(os.environ, {"HOME": str(base / "home")}); p.start(); self.addCleanup(p.stop)
        await database.init_db()
        self.sid = "activity-test"
        self.old_broadcast = hooks._broadcast
        self.addCleanup(setattr, hooks, "_broadcast", self.old_broadcast)
        self.addCleanup(hooks.cleanup_session, self.sid)
        self.sent = AsyncMock()
        hooks.set_broadcast_fn(self.sent)

    async def insert_session(self, status="running"):
        db = await database.get_db()
        try:
            await db.execute("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)", ("ws", "ws", self.tmp.name))
            await db.execute(
                "INSERT INTO sessions (id, workspace_id, name, cli_type, status) VALUES (?, ?, ?, ?, ?)",
                (self.sid, "ws", "Activity", "claude", status),
            )
            await db.commit()
        finally:
            await db.close()

    async def session_status(self):
        db = await database.get_db()
        try:
            row = await (await db.execute("SELECT status FROM sessions WHERE id = ?", (self.sid,))).fetchone()
            return row["status"]
        finally:
            await db.close()

    async def test_last_tool_and_turns_live_in_hook_state(self):
        self.assertEqual(hooks.get_session_activity(self.sid), {"last_activity": None, "turns_completed": 0, "last_event_at": None})
        await hooks._handle_pre_tool_use(self.sid, {"tool_name": "Read", "tool_input": {"file_path": "README.md"}})
        activity = hooks.get_session_activity(self.sid)
        self.assertEqual(activity["last_activity"]["tool_name"], "Read")
        self.assertEqual(activity["last_activity"]["summary"], "README.md")
        self.assertIsInstance(activity["last_activity"]["at"], float)
        self.assertEqual(activity["turns_completed"], 0)
        self.assertEqual(activity["last_event_at"], activity["last_activity"]["at"])
        # A subagent's tool call does not replace the main session's line.
        await hooks._handle_pre_tool_use(self.sid, {"tool_name": "Grep", "tool_input": {"pattern": "x"}, "agent_id": "a1", "agent_type": "explore"})
        self.assertEqual(hooks.get_session_activity(self.sid)["last_activity"]["tool_name"], "Read")
        await hooks._handle_stop(self.sid, {})
        activity = hooks.get_session_activity(self.sid)
        self.assertEqual(activity["turns_completed"], 1)
        # Kept on idle: a Done card still says what the last step was.
        self.assertEqual(activity["last_activity"]["tool_name"], "Read")
        hooks.cleanup_session(self.sid)
        self.assertIsNone(hooks.get_session_activity(self.sid)["last_activity"])

    async def test_decorated_session_carries_activity(self):
        server = server_objects(
            "_decorate_session_dict",
            pty_mgr=SimpleNamespace(is_alive=lambda sid: True),
            capture_proc=SimpleNamespace(get_buffer=lambda sid, n: ""),
            _looks_antigravity_busy=lambda cli, text: False,
            _is_brainstormer_session=lambda d: False,
            BRAINSTORMER_PUBLIC_TAG="brainstorm_public",
            _quick_start=quick_start,
        )
        await hooks._handle_pre_tool_use(self.sid, {"tool_name": "Bash", "tool_input": {"command": "npm test"}})
        d = server._decorate_session_dict({"id": self.sid, "status": "idle", "cli_type": "claude", "tags": "[]"})
        self.assertEqual(d["status"], "running")
        self.assertEqual(d["last_activity"]["summary"], "npm test")
        self.assertEqual(d["turns_completed"], 0)
        self.assertIsInstance(d["last_event_at"], float)
        dead = server._decorate_session_dict({"id": "never-started", "status": "idle", "cli_type": "claude", "tags": "[]"})
        self.assertEqual((dead["last_activity"], dead["turns_completed"], dead["last_event_at"]), (None, 0, None))

    async def test_clean_exit_is_stopped_not_idle(self):
        await self.insert_session("running")
        server = server_objects(
            "handle_pty_exit",
            _output_timers={}, _flush_output=AsyncMock(), get_db=database.get_db, broadcast=AsyncMock(),
            _terminal_streams={}, _terminal_stream_locks={}, _session_cli_type_cache={self.sid: "shell"},
            # Take the early return (as for deleted sessions and shells) so the
            # background jobs after the status update stay out of the test.
            pty_mgr=SimpleNamespace(is_session_start_blocked=lambda sid: True),
            _input_bufs={}, _session_turns={}, _input_esc={}, _output_decoders={}, _output_held_bytes={},
            _output_inferred_status={}, _pty_start_time={}, _session_workspace={},
        )
        with patch.object(session_supervisor, "record_exit", AsyncMock(return_value="clean")):
            await server.handle_pty_exit(self.sid, 0)
        self.assertEqual(await self.session_status(), "stopped")
        # Reload: the logical status keeps 'stopped' apart from 'idle' (never started).
        self.assertEqual(hooks.get_session_logical_status(self.sid, False, "stopped"), "stopped")
        self.assertEqual(hooks.get_session_logical_status("fresh", False, "idle"), "idle")
        with patch.object(session_supervisor, "record_exit", AsyncMock(return_value="crashed")):
            await server.handle_pty_exit(self.sid, 137)
        self.assertEqual(await self.session_status(), "error")


if __name__ == "__main__":
    unittest.main()
