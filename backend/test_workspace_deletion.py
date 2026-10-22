"""Workspace deregistration uses isolated SQLite and never runs provider CLIs."""
import ast
import asyncio
import json
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import aiosqlite
from aiohttp import web
from fresh_database_schema import SCHEMA_STATEMENTS
import workspace_deletion as deletion


class WorkspaceDeletionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ive-workspace-delete-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db_path = self.root / "test.sqlite"
        self.project = self.root / "repo"
        self.project.mkdir()
        self.marker = self.project / "CLAUDE.md"
        self.marker.write_text("User-authored repository instructions\n")
        deletion._locks.clear()
        db = await self.get_db()
        try:
            for statement in SCHEMA_STATEMENTS:
                await db.execute(statement)
            for wid in ("ws", "child-workspace", "other"):
                await db.execute("INSERT INTO workspaces(id,name,path) VALUES(?,?,?)", (wid, wid, str(self.project / wid)))
            await db.execute("UPDATE workspaces SET inherit_orchestration_policy_from='ws' WHERE id='child-workspace'")
            for sid, wid, parent in (("parent", "ws", None), ("child", "ws", "parent"), ("foreign-child", "child-workspace", "parent"), ("other-session", "other", None)):
                await db.execute("INSERT INTO sessions(id,workspace_id,name,parent_session_id) VALUES(?,?,?,?)", (sid, wid, sid, parent))
                await db.execute("INSERT INTO messages(session_id,role,content) VALUES(?,'user','Test context')", (sid,))
            for wid in ("ws", "other", None):
                key = wid or "global"
                await db.execute("INSERT INTO memory_entries(id,workspace_id,name,type,content) VALUES(?,?,?,'note','context')", (key, wid, key))
            await db.execute("INSERT INTO workspace_memory(id,workspace_id,content) VALUES('memory','ws','project context')")
            await db.execute("INSERT INTO file_claims(id,workspace_id,session_id,path,expires_at) VALUES('claim','ws','child','file.py','2099-01-01')")
            await db.execute("INSERT INTO research_schedules(id,workspace_id,query) VALUES('schedule','ws','scheduled question')")
            await db.execute("INSERT INTO pipeline_runs(id,workspace_id,status) VALUES('pipeline','ws','running')")
            await db.execute("INSERT INTO cascade_runs(id,session_id,status) VALUES('cascade','child','waiting_idle')")
            await db.execute("INSERT INTO app_settings(key,value) VALUES('workspace:ws:commander_auto_provision_suppressed','1')")
            await db.commit()
        finally:
            await db.close()
        self.blocked = set()
        self.alive = {"parent", "child", "foreign-child", "other-session"}
        self.manager = SimpleNamespace(
            block_session_start=self.blocked.add, unblock_session_start=self.blocked.discard,
            is_alive=lambda sid: sid in self.alive,
        )
        self.stop = AsyncMock(side_effect=self.stop_session)
        self.clear = Mock()
        self.cancel = AsyncMock(side_effect=self.cancel_pipeline)
        self.stop_cascade = AsyncMock(side_effect=self.cancel_cascade)

    async def cancel_pipeline(self, rid):
        await self.execute("UPDATE pipeline_runs SET status='cancelled' WHERE id=?", (rid,))

    async def cancel_cascade(self, rid):
        await self.execute("UPDATE cascade_runs SET status='stopped' WHERE id=?", (rid,))

    async def get_db(self):
        db = await aiosqlite.connect(self.db_path, timeout=0.5)
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA foreign_keys=ON")
        return db

    async def execute(self, sql, params=()):
        db = await self.get_db()
        try:
            cursor = await db.execute(sql, params)
            rows = await cursor.fetchall()
            await db.commit()
            return rows
        finally:
            await db.close()

    async def count(self, table, clause="1", params=()):
        return (await self.execute(f"SELECT COUNT(*) FROM {table} WHERE {clause}", params))[0][0]

    async def stop_session(self, sid):
        self.assertIn(sid, self.blocked)
        # Model the real exit callback's DB write. Holding BEGIN IMMEDIATE in
        # the deletion while awaiting this would fail with database-is-locked.
        await self.execute("UPDATE sessions SET status='idle' WHERE id=?", (sid,))
        self.alive.discard(sid)

    async def delete(self, wid="ws"):
        return await deletion.delete_registration(
            wid, get_db=self.get_db, pty_manager=self.manager,
            stop_session=self.stop, cancel_pipeline=self.cancel,
            stop_cascade=self.stop_cascade, clear_session=self.clear,
        )

    async def test_deletes_all_local_descendants_context_and_jobs_preserving_other_projects_and_files(self):
        result = await self.delete()
        self.assertEqual(result["session_ids"], ["child", "parent"])
        self.assertEqual({call.args[0] for call in self.stop.await_args_list}, {"child", "parent"})
        self.cancel.assert_awaited_once_with("pipeline")
        self.stop_cascade.assert_awaited_once_with("cascade")
        for table in ("workspace_memory", "file_claims", "research_schedules", "pipeline_runs", "app_settings"):
            self.assertEqual(await self.count(table), 0, table)
        self.assertEqual(await self.count("messages"), 2)
        self.assertEqual(await self.count("memory_entries"), 2)  # Global + other.
        self.assertEqual(await self.count("workspaces"), 2)
        self.assertEqual((await self.execute("SELECT parent_session_id FROM sessions WHERE id='foreign-child'"))[0][0], None)
        self.assertEqual((await self.execute("SELECT inherit_orchestration_policy_from FROM workspaces WHERE id='child-workspace'"))[0][0], None)
        self.assertEqual(self.alive, {"foreign-child", "other-session"})
        self.assertEqual(self.marker.read_text(), "User-authored repository instructions\n")
        self.assertEqual(self.blocked, {"child", "parent"})
        # Fresh helper globals/DB reads cannot restore a deleted registration.
        deletion._locks.clear()
        self.assertIsNone(await self.delete())

    async def test_concurrent_delete_is_idempotent_and_stops_only_once(self):
        results = await asyncio.gather(self.delete(), self.delete())
        self.assertEqual(sum(value is None for value in results), 1)
        self.assertEqual(self.stop.await_count, 2)

    async def test_failure_rolls_back_metadata_and_releases_start_reservations(self):
        await self.execute("CREATE TRIGGER fail_workspace_delete BEFORE DELETE ON workspaces BEGIN SELECT RAISE(ABORT,'test failure'); END")
        with self.assertRaisesRegex(aiosqlite.IntegrityError, "test failure"):
            await self.delete()
        self.assertEqual(await self.count("workspaces"), 3)
        self.assertEqual(await self.count("workspace_memory"), 1)
        self.assertEqual(await self.count("messages"), 4)
        self.assertEqual(await self.count("file_claims"), 1)
        self.assertEqual(self.blocked, set())

    async def test_failed_stop_does_not_delete_any_rows_or_release_other_stops_early(self):
        completed = asyncio.Event()
        async def stop(sid):
            if sid == "child":
                raise RuntimeError("synthetic stop failure")
            await asyncio.sleep(0)
            self.assertIn(sid, self.blocked)
            completed.set()
        self.stop.side_effect = stop
        with self.assertRaisesRegex(RuntimeError, "synthetic stop failure"):
            await self.delete()
        self.assertTrue(completed.is_set())
        self.assertEqual(await self.count("workspaces"), 3)
        self.assertEqual(await self.count("messages"), 4)
        self.assertFalse(self.blocked)

    async def test_still_alive_process_blocks_delete(self):
        self.stop.side_effect = None
        with self.assertRaises(deletion.WorkspaceDeleteBusy):
            await self.delete()
        self.assertEqual(await self.count("workspaces"), 3)
        self.assertFalse(self.blocked)

    async def test_session_created_while_stopping_is_reserved_and_stopped_before_commit(self):
        inserted = False
        async def stop(sid):
            nonlocal inserted
            if not inserted:
                inserted = True
                await self.execute("INSERT INTO sessions(id,workspace_id,name) VALUES('late','ws','Late')")
                self.alive.add("late")
            await self.stop_session(sid)
        self.stop.side_effect = stop
        result = await self.delete()
        self.assertEqual(result["session_ids"], ["child", "late", "parent"])
        self.assertNotIn("late", self.alive)
        self.assertIn("late", self.blocked)

    async def test_missing_workspace_has_no_runtime_side_effects(self):
        self.assertIsNone(await self.delete("missing"))
        self.stop.assert_not_awaited()
        self.cancel.assert_not_awaited()
        self.assertFalse(self.blocked)

    async def test_handler_broadcasts_after_commit_and_keeps_managed_cleanup_opt_in(self):
        await self.execute("UPDATE workspace_memory SET settings=? WHERE workspace_id='ws'", ('{"enabled":true}',))
        async def after_commit(event):
            self.assertEqual(await self.count("workspaces", "id='ws'"), 0)
            self.assertEqual(event, {"type": "workspace_deleted", "workspace_id": "ws", "session_ids": ["child", "parent"]})
        broadcast = AsyncMock(side_effect=after_commit)
        strip = AsyncMock()
        tree = ast.parse(Path(__file__).with_name("server.py").read_text())
        node = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "delete_workspace")
        namespace = dict(web=web, get_db=self.get_db, pty_mgr=self.manager,
                         _stop_session_expected=self.stop, broadcast=broadcast,
                         bus=SimpleNamespace(emit=AsyncMock()), logger=Mock(),
                         CommanderEvent=SimpleNamespace(WORKSPACE_DELETED="workspace_deleted"))
        exec(compile(ast.Module(body=[node], type_ignores=[]), "server.py", "exec"), namespace)
        modules = {
            "idle_reflection": SimpleNamespace(clear_session=self.clear),
            "pipeline_engine": SimpleNamespace(cancel_run=self.cancel),
            "cascade_runner": SimpleNamespace(stop_run=self.stop_cascade),
            "memory_sync": SimpleNamespace(sync_manager=SimpleNamespace(strip_managed_blocks=strip)),
        }
        with patch.dict("sys.modules", modules):
            response = await namespace["delete_workspace"](SimpleNamespace(match_info={"id": "ws"}))
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.text)["session_ids"], ["child", "parent"])
        broadcast.assert_awaited_once()
        strip.assert_awaited_once_with(str(self.project / "ws"), consent=True)
        self.assertEqual(await self.count("workspace_memory"), 0)


class PtyDeletionReservationTests(unittest.IsolatedAsyncioTestCase):
    def make_manager(self):
        # Execute the real manager class with a fake PTY constructor. No forks,
        # provider setup, account/environment changes or real filesystem writes.
        tree = ast.parse(Path(__file__).with_name("pty_manager.py").read_text())
        node = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "PTYManager")
        constructor = Mock(return_value=SimpleNamespace(start=AsyncMock()))
        namespace = {"Callable": object, "PTYSession": constructor, "asyncio": asyncio, "logger": Mock()}
        exec(compile(ast.Module(body=[node], type_ignores=[]), "pty_manager.py", "exec"), namespace)
        return namespace["PTYManager"](), constructor

    async def test_block_rejects_stale_start_and_failed_delete_can_unblock(self):
        mgr, constructor = self.make_manager()
        mgr.block_session_start("deleted")
        with self.assertRaisesRegex(RuntimeError, "being deleted"):
            await mgr.start_session("deleted", "/synthetic")
        constructor.assert_not_called()

        mgr.unblock_session_start("deleted")
        await mgr.start_session("deleted", "/synthetic")
        constructor.assert_called_once()

    async def test_reservation_while_old_process_is_closing_prevents_replacement(self):
        mgr, constructor = self.make_manager()
        async def close():
            mgr.block_session_start("closing")
        mgr._sessions["closing"] = SimpleNamespace(is_alive=lambda: False, wait_closed=close)
        with self.assertRaisesRegex(RuntimeError, "being deleted"):
            await mgr.start_session("closing", "/synthetic")
        constructor.assert_not_called()


class ManagedMemoryCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_existing_cleanup_removes_only_generated_block_and_preserves_repo(self):
        tree = ast.parse(Path(__file__).with_name("memory_sync.py").read_text())
        names = {"_strip_memory_entries_block", "strip_managed_blocks"}
        nodes = [node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
        start = "<!-- ive-managed-memory-entries:start -->"
        end = "<!-- ive-managed-memory-entries:end -->"
        with tempfile.TemporaryDirectory(prefix="ive-managed-cleanup-") as directory:
            path = Path(directory) / "CLAUDE.md"
            path.write_text(f"User instructions\n{start}\nGenerated context\n{end}\nUser footer\n")
            untouched = Path(directory) / "source.py"
            untouched.write_text("print('keep source')\n")
            allowed = AsyncMock(return_value=True)
            namespace = dict(re=re, logger=Mock(), native_memory_allowed=allowed,
                             _IVE_ENTRIES_START=start, _IVE_ENTRIES_END=end,
                             all_providers=lambda: [SimpleNamespace(cli_type="claude", memory_file_path=lambda _: path)])
            exec(compile(ast.Module(body=nodes, type_ignores=[]), "memory_sync.py", "exec"), namespace)
            self.assertEqual(await namespace["strip_managed_blocks"](None, directory, consent=True), ["claude"])
            self.assertEqual(path.read_text(), "User instructions\nUser footer\n")
            self.assertEqual(untouched.read_text(), "print('keep source')\n")
            allowed.assert_awaited_once_with(None, consent=True)


if __name__ == "__main__":
    unittest.main()
