"""Isolated quick start tests. Temp SQLite + temp home; never starts a server or CLI."""
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
import quick_start
import workspace_fields


def server_objects(*names, **dependencies):
    """Compile only the named top-level functions/classes from server.py."""
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


class FakeRequest(dict):
    def __init__(self, body=None, match_info=None):
        super().__init__(auth=SimpleNamespace(
            is_owner=True, actor_kind="localhost", actor_id=None,
            device_id=None, mode="full", workspace_id=None,
        ))
        self._body = body
        self.match_info = match_info or {}

    async def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


def payload(response):
    return json.loads(response.text)


class QuickStartTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name).resolve()
        self.home = base / "home"
        self.root = self.home / "Projekte"
        self.root.mkdir(parents=True)
        data = base / "data"
        data.mkdir()
        for target, value in [("DATA_DIR", data), ("DB_PATH", data / "test.db")]:
            p = patch.object(database, target, value); p.start(); self.addCleanup(p.stop)
        p = patch.dict(os.environ, {"HOME": str(self.home)}); p.start(); self.addCleanup(p.stop)
        quick_start._cached_workspace_id = None
        quick_start.hints = quick_start.ProjectHints()
        await database.init_db()
        self.db = await database.get_db()
        self.addAsyncCleanup(self.db.close)
        self.broadcast = AsyncMock()
        self.server = self.build_server()

    def build_server(self, permission_modes=()):
        profile = SimpleNamespace(
            id="claude", label="Claude", available_models=[], default_permission_mode="auto",
            available_permission_modes=list(permission_modes),
            effort_levels=["high"],
        )
        deps = dict(
            get_db=database.get_db,
            get_auth=lambda request: request.get("auth"),
            is_active_cli=lambda cli: True,
            _inactive_cli_response=lambda cli: web.json_response({}, status=409),
            _registered_cli_availability=AsyncMock(return_value={"claude": True, "gemini": True}),
            get_profile=lambda cli: profile,
            _profile_default_model_for_role=lambda prof, stype: "sonnet",
            _model_for_storage=lambda prof, model, stype: model,
            ALLOY_TESTER_SYSTEM_PROMPT_FRAGMENT="", ALLOY_WORKER_SYSTEM_PROMPT_FRAGMENT="",
            _is_alloy_task=lambda labels: False,
            COMMANDER_DISALLOWED_TOOLS=[], SECURE_DISALLOWED_TOOLS=[],
            _brainstormer_owner_key=lambda ctx: ("localhost", "owner"),
            _sync_zai_mcp_servers_for_session=AsyncMock(),
            broadcast=self.broadcast,
            bus=SimpleNamespace(emit=AsyncMock()),
            CommanderEvent=SimpleNamespace(SESSION_SPAWNED="session_spawned"),
            _autostart_session_pty=AsyncMock(return_value={"ok": True}),
            get_task_ready=AsyncMock(), unmet_dependency_response=lambda r: {},
            _quick_start=quick_start,
            workspace_fields=workspace_fields,
            _get_visible_session_for_request=self.visible_session,
            _decorate_session_dict=lambda d: dict(
                d, quick=quick_start.is_quick_workspace_cached(d.get("workspace_id"))),
            _ensure_workspace_commander_safely=AsyncMock(),
            _get_workspace_path=AsyncMock(return_value=None),
        )
        server = server_objects(
            "create_session", "create_quick_session", "_permission_mode_error", "_QuickJsonRequest",
            "_workspace_visible_to_auth", "get_quick_start", "put_quick_start",
            "attach_session_to_workspace", "get_session_project_hint",
            "get_session_config", "_with_quick_flag", "_sync_memory_to_cli",
            "ensure_quick_workspace",
            "_effort_for_storage",
            **deps,
        )
        return server

    async def visible_session(self, session_id, request):
        row = await (await self.db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))).fetchone()
        return dict(row) if row else None

    async def quick_session(self, **body):
        response = await self.server.create_quick_session(FakeRequest(body))
        self.assertEqual(response.status, 201, response.text)
        return payload(response)

    # ── Creation ─────────────────────────────────────────────────────

    async def test_quick_session_without_any_workspace(self):
        count = (await (await self.db.execute("SELECT COUNT(*) FROM workspaces")).fetchone())[0]
        self.assertEqual(count, 0)
        session = await self.quick_session()
        self.assertTrue(session["quick"])
        self.assertEqual(session["name"], "Quick session")
        ws = dict(await (await self.db.execute(
            "SELECT * FROM workspaces WHERE id = ?", (session["workspace_id"],))).fetchone())
        self.assertEqual(ws["name"], "Quick sessions")
        self.assertEqual(ws["path"], str(self.root))
        self.assertEqual(ws["default_worktree"], 0)
        self.assertEqual(session["worktree"], 0)
        state = payload(await self.server.get_quick_start(FakeRequest()))
        self.assertEqual(state, {"root": str(self.root), "workspace_id": ws["id"],
                                 "workspace_name": "Quick sessions"})
        # Second quick session reuses the same workspace and keeps a given name.
        second = await self.quick_session(name="  Fix login  ", cli_type="gemini", model="x")
        self.assertEqual(second["workspace_id"], ws["id"])
        self.assertEqual((second["name"], second["cli_type"], second["model"]),
                         ("Fix login", "gemini", "x"))
        self.broadcast.assert_any_await({"type": "session_created", "session": second})

    async def test_quick_session_passes_permission_mode_and_effort(self):
        # The Home composer chooses permissions and effort before the session
        # exists; both reach create_session and are validated per CLI profile.
        self.server = self.build_server(permission_modes=[{"id": "plan"}, {"id": "auto"}])
        session = await self.quick_session(permission_mode="plan", effort="high")
        self.assertEqual((session["permission_mode"], session["effort"]), ("plan", "high"))
        plain = await self.quick_session()
        self.assertEqual(plain["permission_mode"], "auto")
        self.assertIsNone(plain["effort"])
        response = await self.server.create_quick_session(FakeRequest({"permission_mode": "untrusted"}))
        self.assertEqual(response.status, 400, response.text)
        self.assertEqual(payload(response)["code"], "invalid_permission_mode")

    async def test_get_state_before_creation_creates_nothing(self):
        state = payload(await self.server.get_quick_start(FakeRequest()))
        self.assertEqual(state, {"root": str(self.root), "workspace_id": None,
                                 "workspace_name": "Quick sessions"})
        count = (await (await self.db.execute("SELECT COUNT(*) FROM workspaces")).fetchone())[0]
        self.assertEqual(count, 0)

    async def test_default_root_falls_back_to_home(self):
        self.root.rmdir()
        self.assertEqual(quick_start.default_root(), str(self.home))

    async def test_no_default_guidelines_or_optional_mcp(self):
        await self.db.execute(
            "INSERT INTO guidelines (id, name, content, is_default) VALUES ('g1','Default','Be nice',1)")
        await self.db.commit()
        session = await self.quick_session()
        guidelines = await (await self.db.execute(
            "SELECT guideline_id FROM session_guidelines WHERE session_id = ?", (session["id"],))).fetchall()
        self.assertEqual(guidelines, [])
        mcp = [r[0] for r in await (await self.db.execute(
            "SELECT mcp_server_id FROM session_mcp_servers WHERE session_id = ?", (session["id"],))).fetchall()]
        self.assertEqual(mcp, ["builtin-worker-board"])

    async def test_project_target_starts_in_that_project_with_defaults(self):
        project = self.root / "demo"
        project.mkdir()
        await self.db.execute(
            "INSERT INTO workspaces (id, name, path, default_worktree) VALUES ('w1','demo',?,0)",
            (str(project),))
        await self.db.execute(
            "INSERT INTO guidelines (id, name, content, is_default) VALUES ('g1','Default','Be nice',1)")
        await self.db.execute(
            "INSERT INTO guidelines (id, name, content, is_default) VALUES ('g2','Other','x',0)")
        await self.db.commit()
        session = await self.quick_session(workspace_id="w1", name="Was macht dieses Projekt")
        self.assertEqual(session["workspace_id"], "w1")
        self.assertFalse(session["quick"])
        self.assertEqual(session["name"], "Was macht dieses Projekt")
        guidelines = [r[0] for r in await (await self.db.execute(
            "SELECT guideline_id FROM session_guidelines WHERE session_id = ?", (session["id"],))).fetchall()]
        self.assertEqual(guidelines, ["g1"])
        # No quick workspace is created for a project start.
        state = payload(await self.server.get_quick_start(FakeRequest()))
        self.assertIsNone(state["workspace_id"])
        unnamed = await self.quick_session(workspace_id="w1")
        self.assertEqual(unnamed["name"], "New session")

    async def test_project_target_errors_and_quick_workspace_id(self):
        missing = await self.server.create_quick_session(FakeRequest({"workspace_id": "nope"}))
        self.assertEqual(missing.status, 404)
        bad = await self.server.create_quick_session(FakeRequest({"workspace_id": 7}))
        self.assertEqual(bad.status, 400)
        first = await self.quick_session()
        again = await self.quick_session(workspace_id=first["workspace_id"])
        self.assertTrue(again["quick"])
        self.assertEqual(again["workspace_id"], first["workspace_id"])

    async def test_ensure_quick_workspace_route(self):
        ws = payload(await self.server.ensure_quick_workspace(FakeRequest()))
        self.assertTrue(ws["is_quick"])
        self.assertEqual(ws["path"], str(self.root))
        again = payload(await self.server.ensure_quick_workspace(FakeRequest()))
        self.assertEqual(again["id"], ws["id"])
        session = await self.quick_session()
        self.assertEqual(session["workspace_id"], ws["id"])

    async def test_session_config_resolves_for_quick_session(self):
        session = await self.quick_session()
        config = await self.server.get_session_config(session["id"])
        self.assertIsNotNone(config)
        self.assertEqual(config["workspace_path"], str(self.root))
        self.assertEqual(config["sandbox_type"], "none")

    async def test_deleted_quick_workspace_is_recreated(self):
        first = await self.quick_session()
        await self.db.execute("DELETE FROM workspaces WHERE id = ?", (first["workspace_id"],))
        await self.db.commit()
        second = await self.quick_session()
        self.assertNotEqual(second["workspace_id"], first["workspace_id"])
        self.assertTrue(second["quick"])
        self.assertEqual(quick_start.cached_workspace_id(), second["workspace_id"])

    # ── Memory ───────────────────────────────────────────────────────

    async def test_memory_sync_is_off_and_writes_nothing_into_root(self):
        session = await self.quick_session()
        from memory_sync import sync_manager
        settings = await sync_manager.get_settings(session["workspace_id"])
        self.assertFalse(settings["enabled"])
        self.assertFalse(settings["auto_sync"])
        result = await sync_manager.sync_entries_to_project_memory(
            session["workspace_id"], str(self.root))
        self.assertEqual(result.status, "up_to_date")
        self.assertEqual(sorted(os.listdir(self.root)), [])
        # The background writer bails out before even resolving the path.
        await self.server._sync_memory_to_cli(session["workspace_id"])
        self.server._sync_memory_to_cli.__globals__["_get_workspace_path"].assert_not_awaited()

    async def test_start_pty_memory_sync_is_guarded(self):
        source = Path(__file__).with_name("server.py").read_text()
        guard = "and not _quick_start.is_quick_workspace_cached(_ws_id_mem)"
        self.assertIn(guard, source)
        self.assertLess(source.index(guard), source.index("sync_entries_to_project_memory(\n"))

    # ── Root setting ─────────────────────────────────────────────────

    async def test_put_root_validation(self):
        a_file = self.home / "file.txt"
        a_file.write_text("x")
        for bad in (None, "", "relative/dir", "/", str(self.home / "missing"), str(a_file)):
            response = await self.server.put_quick_start(FakeRequest({"root": bad}))
            self.assertEqual(response.status, 400, bad)
        response = await self.server.put_quick_start(FakeRequest(ValueError("bad json")))
        self.assertEqual(response.status, 400)
        stored = await (await self.db.execute(
            "SELECT value FROM app_settings WHERE key = 'quick_start_root'")).fetchone()
        self.assertIsNone(stored)

    async def test_put_root_moves_quick_workspace(self):
        session = await self.quick_session()
        other = self.home / "Code"
        other.mkdir()
        response = await self.server.put_quick_start(FakeRequest({"root": str(other) + "/"}))
        self.assertEqual(response.status, 200)
        self.assertEqual(payload(response), {"root": str(other), "workspace_id": session["workspace_id"],
                                             "workspace_name": "Quick sessions"})
        path = (await (await self.db.execute(
            "SELECT path FROM workspaces WHERE id = ?", (session["workspace_id"],))).fetchone())[0]
        self.assertEqual(path, str(other))
        # "~" is expanded.
        response = await self.server.put_quick_start(FakeRequest({"root": "~/Projekte"}))
        self.assertEqual(payload(response)["root"], str(self.root))

    async def test_workspace_json_marks_quick_workspace(self):
        session = await self.quick_session()
        row = await (await self.db.execute(
            "SELECT * FROM workspaces WHERE id = ?", (session["workspace_id"],))).fetchone()
        self.assertTrue(self.server._with_quick_flag(workspace_fields.project_row(row))["is_quick"])
        self.assertFalse(self.server._with_quick_flag({"id": "other"})["is_quick"])

    # ── Attach ───────────────────────────────────────────────────────

    async def attach(self, session_id, body):
        return await self.server.attach_session_to_workspace(
            FakeRequest(body, {"id": session_id}))

    async def test_attach_by_path_creates_then_finds_workspace(self):
        project = self.root / "shop"
        (project / "src").mkdir(parents=True)
        first = await self.quick_session()
        response = await self.attach(first["id"], {"path": str(project)})
        self.assertEqual(response.status, 200, response.text)
        body = payload(response)
        self.assertEqual(body["workspace"]["path"], str(project))
        self.assertEqual(body["workspace"]["name"], "shop")
        self.assertFalse(body["workspace"]["is_quick"])
        self.assertEqual(body["session"]["workspace_id"], body["workspace"]["id"])
        self.assertFalse(body["session"]["quick"])
        # session_id is required: the browser drops session events without it.
        self.broadcast.assert_any_await({
            "type": "session_update",
            "session_id": body["session"]["id"],
            "workspace_id": body["workspace"]["id"],
            "session": body["session"],
        })
        commander = self.server.attach_session_to_workspace.__globals__["_ensure_workspace_commander_safely"]
        self.assertEqual(commander.call_count, 1)

        # A subfolder resolves to the same workspace, no second one is created.
        second = await self.quick_session()
        response = await self.attach(second["id"], {"path": str(project / "src")})
        self.assertEqual(payload(response)["workspace"]["id"], body["workspace"]["id"])
        count = (await (await self.db.execute("SELECT COUNT(*) FROM workspaces")).fetchone())[0]
        self.assertEqual(count, 2)
        self.assertEqual(commander.call_count, 1)
        config = await self.server.get_session_config(second["id"])
        self.assertEqual(config["workspace_path"], str(project))

    async def test_attach_by_workspace_id_and_errors(self):
        session = await self.quick_session()
        project = self.home / "elsewhere"
        project.mkdir()
        await self.db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws-x','X',?)", (str(project),))
        await self.db.commit()
        response = await self.attach(session["id"], {"workspace_id": "ws-x"})
        self.assertEqual(payload(response)["session"]["workspace_id"], "ws-x")
        cases = [
            ({}, 400),
            ({"path": "relative"}, 400),
            ({"path": str(self.home / "missing")}, 400),
            ({"workspace_id": "nope"}, 404),
            ({"workspace_id": session["workspace_id"]}, 400),
        ]
        for body, status in cases:
            self.assertEqual((await self.attach(session["id"], body)).status, status, body)
        self.assertEqual((await self.attach("no-such", {"workspace_id": "ws-x"})).status, 404)

    async def test_undo_attach_restores_quick_and_rejects_stale_receipts(self):
        session = await self.quick_session()
        project = self.root / "undo-project"
        project.mkdir()
        moved = payload(await self.attach(session["id"], {"path": str(project)}))
        token = moved["undo_token"]
        self.assertTrue(token)
        other = await self.quick_session()
        self.assertEqual((await self.attach(other["id"], {"undo_token": token})).status, 409)
        restored = payload(await self.attach(session["id"], {"undo_token": token}))
        self.assertEqual(restored["session"]["workspace_id"], session["workspace_id"])
        self.assertTrue(restored["session"]["quick"])
        self.assertTrue(restored["workspace"]["is_quick"])
        self.assertIsNone(restored["undo_token"])
        self.assertEqual((await self.attach(session["id"], {"undo_token": token})).status, 409)
        moved = payload(await self.attach(session["id"], {"path": str(project)}))
        next_project = self.root / "new-project"
        next_project.mkdir()
        await self.attach(session["id"], {"path": str(next_project)})
        self.assertEqual((await self.attach(session["id"], {"undo_token": moved["undo_token"]})).status, 409)

    # ── Project hint ─────────────────────────────────────────────────

    async def observe(self, session_id, tool_input):
        return await quick_start.observe_tool_use(
            session_id, tool_input, self.broadcast, home=str(self.home))

    def hint_messages(self):
        return [c.args[0] for c in self.broadcast.await_args_list
                if c.args[0].get("type") == "session_project_hint"]

    async def test_project_hint_from_hook_events(self):
        repo = self.root / "alpha"
        (repo / ".git").mkdir(parents=True)
        (repo / "src").mkdir()
        (self.root / "beta").mkdir()
        session = await self.quick_session()
        sid = session["id"]
        self.assertIsNone(await self.observe(sid, {"file_path": str(repo / "src" / "a.py")}))
        self.assertEqual(self.hint_messages(), [])
        hint = await self.observe(sid, {"command": "cd alpha && npm test"})
        self.assertEqual(hint, {"type": "session_project_hint", "session_id": sid,
                                "path": str(repo), "name": "alpha", "workspace_id": None})
        # Further events in the same repo do not repeat the hint.
        await self.observe(sid, {"path": str(repo / "src")})
        await self.observe(sid, {"file_path": str(repo / "README.md")})
        self.assertEqual(len(self.hint_messages()), 1)
        response = await self.server.get_session_project_hint(FakeRequest(None, {"id": sid}))
        self.assertEqual(payload(response), {"path": str(repo), "name": "alpha", "workspace_id": None})

    async def test_project_hint_ignores_noise_and_non_quick_sessions(self):
        (self.root / "beta" / "lib").mkdir(parents=True)
        session = await self.quick_session()
        sid = session["id"]
        noise = [
            {"file_path": str(self.home / ".claude" / "settings.json")},
            {"command": "ls -la"},
            {"path": str(self.root)},
            {"file_path": "/etc/hosts"},
            {"pattern": "*.py"},
        ]
        for event in noise * 2:
            self.assertIsNone(await self.observe(sid, event))
        # Non-git folder under the root falls back to its first-level folder.
        await self.observe(sid, {"file_path": "beta/lib/x.py"})
        hint = await self.observe(sid, {"notebook_path": str(self.root / "beta" / "n.ipynb")})
        self.assertEqual(hint["path"], str(self.root / "beta"))

        other = self.home / "plain"
        other.mkdir()
        await self.db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws-p','P',?)", (str(other),))
        await self.db.execute(
            "INSERT INTO sessions(id, workspace_id, name) VALUES('s-plain','ws-p','P')")
        await self.db.commit()
        for _ in range(3):
            self.assertIsNone(await self.observe("s-plain", {"file_path": str(self.root / "beta" / "y.py")}))
        response = await self.server.get_session_project_hint(FakeRequest(None, {"id": "s-plain"}))
        self.assertEqual(payload(response), {})

    async def test_project_hint_reports_known_workspace_and_clears_on_attach(self):
        repo = self.root / "gamma"
        (repo / ".git").mkdir(parents=True)
        await self.db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws-g','Gamma',?)", (str(repo),))
        await self.db.commit()
        session = await self.quick_session()
        await self.observe(session["id"], {"file_path": str(repo / "a.py")})
        hint = await self.observe(session["id"], {"command": f"cd '{repo}'"})
        self.assertEqual(hint["workspace_id"], "ws-g")
        await self.attach(session["id"], {"workspace_id": hint["workspace_id"]})
        response = await self.server.get_session_project_hint(FakeRequest(None, {"id": session["id"]}))
        self.assertEqual(payload(response), {})
        self.assertIsNone(await self.observe(session["id"], {"file_path": str(repo / "b.py")}))

    def test_dominance_requires_a_clear_leader(self):
        tracker = quick_start.ProjectHints()
        root = self.root
        (root / "one").mkdir()
        (root / "two").mkdir()
        home = str(self.home)
        self.assertIsNone(tracker.observe("s", str(root), {"file_path": str(root / "one" / "a")}, home))
        self.assertIsNone(tracker.observe("s", str(root), {"file_path": str(root / "two" / "a")}, home))
        # Tied at one each: no hint. Two beats one: hint for "two".
        self.assertIsNone(tracker.latest("s"))
        hint = tracker.observe("s", str(root), {"file_path": str(root / "two" / "b")}, home)
        self.assertEqual(hint, {"path": str(root / "two"), "name": "two"})
        # Tie at two: no new hint for "one".
        self.assertIsNone(tracker.observe("s", str(root), {"file_path": str(root / "one" / "b")}, home))

    def test_cd_parsing(self):
        self.assertEqual(quick_start._cd_targets('cd "my app" && ls; (cd ../x) || pushd ~/y'),
                         ["my app", "../x", "~/y"])
        self.assertEqual(quick_start._cd_targets("echo cd foo"), [])


if __name__ == "__main__":
    unittest.main()
