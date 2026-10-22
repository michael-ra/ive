"""Explicit Commander deletion survives automatic provisioning and restart.

Uses the real handler bodies and fresh SQLite schema in a temporary directory;
no server bootstrap, provider CLI, hooks, account state or live HTTP requests.
"""
import ast
import asyncio
import json
import logging
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import uuid

import aiosqlite
from aiohttp import web
from fresh_database_schema import SCHEMA_STATEMENTS


class Request:
    def __init__(self, identifier, body=None):
        self.match_info = {"id": identifier}
        self.body = body or {}

    async def json(self):
        return self.body


class CommanderDeletionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ive-commander-delete-")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "test.sqlite"
        db = await self.get_db()
        try:
            for statement in SCHEMA_STATEMENTS:
                await db.execute(statement)
            await db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws','Test','/tmp/synthetic-commander-delete')")
            await db.execute("INSERT INTO workspaces(id,name,path) VALUES('other','Other','/tmp/synthetic-commander-other')")
            await db.execute("INSERT INTO mcp_servers(id,name,server_name,command) VALUES('builtin-commander','Commander','commander','synthetic')")
            await db.commit()
        finally:
            await db.close()
        for name, module in {
            "orchestration_policy": SimpleNamespace(role_model=lambda *_: (None, None)),
            "hook_installer": SimpleNamespace(check_safety_gate_installation=lambda: {"claude": True, "script_exists": True}, install_safety_gate_hooks=lambda: self.fail("No real hook installation")),
            "hooks": SimpleNamespace(get_session_logical_status=lambda sid, alive, status: status),
        }.items():
            patcher = patch.dict("sys.modules", {name: module})
            patcher.start()
            self.addCleanup(patcher.stop)
        self.server = self.load_handlers()

    async def get_db(self):
        connection = await aiosqlite.connect(self.path, timeout=5)
        connection.row_factory = aiosqlite.Row
        await connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def load_handlers(self):
        names = {"_commander_provision_suppression_key", "delete_session", "_ensure_workspace_commander", "_ensure_commanders_for_all_workspaces", "create_commander"}
        tree = ast.parse(Path(__file__).with_name("server.py").read_text())
        selected = ast.Module(body=[node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names], type_ignores=[])
        profile = SimpleNamespace(id="claude", label="Claude", default_commander_model="test-model", default_permission_mode="default", effort_levels=[], available_models=[])
        namespace = dict(
            get_db=self.get_db, web=web, json=json, uuid=uuid,
            logger=logging.getLogger("test-commander-deletion"),
            _resolve_caller=AsyncMock(return_value=None),
            _session_visible_to_request=lambda *_: True,
            _stop_session_expected=AsyncMock(),
            bus=SimpleNamespace(emit=AsyncMock()),
            CommanderEvent=SimpleNamespace(SESSION_DELETED="session_deleted"),
            broadcast=AsyncMock(),
            is_active_cli=lambda cli: cli == "claude",
            active_profiles=lambda: [profile], get_profile=lambda _: profile,
            _profile_default_model_for_role=lambda *_: "test-model",
            _model_for_storage=lambda _profile, value, _role: value,
            _build_commander_dynamic_prompt=lambda _: "Synthetic commander",
            COMMANDER_DISALLOWED_TOOLS=[],
            _permission_mode_error=lambda *_: None,
            _inactive_cli_response=lambda _: web.json_response({"error": "inactive"}, status=400),
            pty_mgr=SimpleNamespace(is_alive=lambda _: False),
        )
        exec(compile(selected, "server.py", "exec"), namespace)
        return SimpleNamespace(**namespace)

    async def insert_session(self, sid="commander", kind="commander", workspace="ws"):
        db = await self.get_db()
        try:
            await db.execute("INSERT INTO sessions(id,workspace_id,name,session_type,cli_type) VALUES(?,?,?,?,?)", (sid, workspace, sid, kind, "claude"))
            await db.execute("INSERT INTO messages(session_id,role,content) VALUES(?,'user','Synthetic')", (sid,))
            await db.commit()
        finally:
            await db.close()

    async def scalar(self, sql, params=()):
        db = await self.get_db()
        try:
            return (await (await db.execute(sql, params)).fetchone())[0]
        finally:
            await db.close()

    async def suppressed(self, workspace="ws"):
        return await self.scalar("SELECT COUNT(*) FROM app_settings WHERE key=? AND value='1'", (self.server._commander_provision_suppression_key(workspace),))

    async def test_explicit_deletion_survives_reloaded_handlers_and_startup(self):
        await self.insert_session()
        response = await self.server.delete_session(Request("commander"))
        self.assertEqual(response.status, 200)
        self.assertEqual(await self.suppressed(), 1)
        self.assertEqual(await self.scalar("SELECT COUNT(*) FROM messages WHERE session_id='commander'"), 0)
        self.server._stop_session_expected.assert_awaited_once_with("commander")
        self.server.broadcast.assert_awaited_once()
        restarted = self.load_handlers()  # Fresh handler globals, same persisted DB.
        await restarted._ensure_commanders_for_all_workspaces()
        self.assertEqual(await self.scalar("SELECT COUNT(*) FROM sessions WHERE workspace_id='ws'"), 0)
        self.assertEqual(await self.scalar("SELECT COUNT(*) FROM sessions WHERE workspace_id='other' AND session_type='commander'"), 1)

    async def test_explicit_new_commander_clears_opt_out_only_after_success(self):
        await self.insert_session()
        await self.server.delete_session(Request("commander"))
        failed = await self.server.create_commander(Request("ws", {"cli_type": "disabled"}))
        self.assertEqual(failed.status, 400)
        self.assertEqual(await self.suppressed(), 1)
        created = await self.server.create_commander(Request("ws"))
        self.assertEqual(created.status, 201)
        sid = json.loads(created.text)["id"]
        self.assertNotEqual(sid, "commander")
        self.assertEqual(await self.suppressed(), 0)
        self.assertEqual((await self.server._ensure_workspace_commander("ws"))["id"], sid)
        self.assertEqual(await self.scalar("SELECT COUNT(*) FROM sessions WHERE workspace_id='ws'"), 1)

    async def test_explicit_reuse_of_another_existing_commander_clears_opt_out(self):
        await self.insert_session()
        await self.insert_session("remaining")
        await self.server.delete_session(Request("commander"))
        self.assertEqual(await self.suppressed(), 1)
        response = await self.server.create_commander(Request("ws"))
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.text)["id"], "remaining")
        self.assertEqual(await self.suppressed(), 0)

    async def test_worker_deletion_does_not_disable_default_commander(self):
        await self.insert_session("worker", "worker")
        self.assertEqual((await self.server.delete_session(Request("worker"))).status, 200)
        self.assertEqual(await self.suppressed(), 0)
        self.assertIsNotNone(await self.server._ensure_workspace_commander("ws"))

    async def test_denied_and_missing_deletions_do_not_persist_opt_out(self):
        await self.insert_session()
        self.server._resolve_caller.return_value = {"session_id": "worker", "session_type": "worker"}
        self.assertEqual((await self.server.delete_session(Request("commander"))).status, 403)
        self.server._resolve_caller.return_value = None
        self.assertEqual((await self.server.delete_session(Request("missing"))).status, 404)
        self.assertEqual(await self.suppressed(), 0)
        self.assertEqual(await self.scalar("SELECT COUNT(*) FROM sessions WHERE id='commander'"), 1)
        self.server._stop_session_expected.assert_not_awaited()

    async def test_failed_delete_rolls_back_tombstone_with_session(self):
        await self.insert_session()
        db = await self.get_db()
        try:
            await db.execute("CREATE TRIGGER reject_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END")
            await db.commit()
        finally:
            await db.close()
        with self.assertRaisesRegex(aiosqlite.IntegrityError, "synthetic delete failure"):
            await self.server.delete_session(Request("commander"))
        self.assertEqual(await self.suppressed(), 0)
        self.assertEqual(await self.scalar("SELECT COUNT(*) FROM sessions WHERE id='commander'"), 1)
        self.server.broadcast.assert_not_awaited()

    async def test_parallel_startup_checks_cannot_resurrect_explicitly_deleted_commander(self):
        await self.insert_session()
        results = await asyncio.gather(self.server.delete_session(Request("commander")), *[self.server._ensure_workspace_commander("ws") for _ in range(6)])
        self.assertEqual(results[0].status, 200)
        self.assertEqual(await self.suppressed(), 1)
        self.assertIsNone(await self.load_handlers()._ensure_workspace_commander("ws"))
        self.assertEqual(await self.scalar("SELECT COUNT(*) FROM sessions WHERE workspace_id='ws'"), 0)


if __name__ == "__main__":
    unittest.main()
