"""Regression checks for REST context delivery, without a server or real CLI."""
import ast
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from aiohttp import web
import route_guards


SOURCE = Path(__file__).with_name("server.py")


class Request(dict):
    def __init__(self, body):
        super().__init__()
        self.body = body
        self.match_info = {"id": "session"}
        self.path = "/api/sessions/session/input"

    async def json(self):
        return self.body


class InputDeliveryContractTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.pty = SimpleNamespace(is_alive=Mock(return_value=True), write=Mock(return_value=True))
        self.ready = AsyncMock(return_value=True)
        self.blocker = Mock(return_value=None)
        self.cli = "claude"
        tree = ast.parse(SOURCE.read_text())
        handler = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "send_session_input")
        namespace = {
            "web": web, "pty_mgr": self.pty,
            "_get_visible_session_for_request": AsyncMock(return_value={"id": "session", "cli_type": "claude"}),
            "get_auth": lambda _: None,
            "_terminal_control_violation": lambda *_: None,
            "_session_cli_type": AsyncMock(side_effect=lambda _: self.cli),
            "_is_auth_recovery_input": lambda _: False,
            "_wait_for_cli_input_ready": self.ready,
            "_detect_cli_startup_blocker": self.blocker,
            "_startup_blocker_text": lambda _: "ready",
            "_asyncio": SimpleNamespace(sleep=AsyncMock()),
        }
        exec(compile(ast.Module(body=[handler], type_ignores=[]), str(SOURCE), "exec"), namespace)
        self.send = namespace["send_session_input"]

    async def test_multiline_context_is_one_bracketed_paste_with_separate_submit(self):
        response = await self.send(Request({"message": "Project context:\nKeep BLUE-314", "ready_timeout": 30}))
        self.assertEqual(response.status, 200)
        writes = [call.args[1] for call in self.pty.write.call_args_list]
        self.assertIn(b"\x1b[200~Project context:\nKeep BLUE-314\x1b[201~", writes)
        self.assertEqual(writes[-1], b"\r")

    async def test_failed_pty_writes_never_acknowledge_delivery(self):
        for body in ({"message": "Context", "raw": True}, {"message": "yes"}, {"message": "Project context", "ready_timeout": 30}):
            with self.subTest(body=body):
                self.pty.write.reset_mock()
                self.pty.write.return_value = False
                response = await self.send(Request(body))
                self.assertGreaterEqual(response.status, 400)
                self.assertFalse(json.loads(response.text).get("ok", False))

    async def test_failed_submit_does_not_acknowledge_partial_delivery(self):
        self.pty.write.side_effect = [True, True, False]
        response = await self.send(Request({"message": "Project context", "ready_timeout": 30}))
        self.assertGreaterEqual(response.status, 400)
        self.assertFalse(json.loads(response.text).get("ok", False))

    async def test_busy_context_is_not_written(self):
        self.ready.return_value = False
        response = await self.send(Request({"message": "Project context", "ready_timeout": 30}))
        self.assertEqual(response.status, 409)
        self.pty.write.assert_not_called()

    async def test_startup_blocked_context_is_not_written(self):
        self.blocker.return_value = {"type": "login_required", "label": "Sign in first"}
        response = await self.send(Request({"message": "Project context", "ready_timeout": 30}))
        self.assertEqual(response.status, 409)
        self.assertEqual(json.loads(response.text)["startup_blocker"]["type"], "login_required")
        self.pty.write.assert_not_called()

    async def test_gemini_context_keeps_existing_flattening(self):
        self.cli = "gemini"
        response = await self.send(Request({"message": "Project context:\nKeep BLUE-314", "ready_timeout": 30}))
        self.assertEqual(response.status, 200)
        writes = [call.args[1] for call in self.pty.write.call_args_list]
        self.assertIn(b"Project context: Keep BLUE-314", writes)
        self.assertEqual(writes[-1], b"\r")


class TemplateRouteContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_apply_preset_blocks_brief_joiners_like_session_creation(self):
        tree = ast.parse(SOURCE.read_text())
        registration = next(node for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == "add_post" and node.args
            and isinstance(node.args[0], ast.Constant)
            and node.args[0].value == "/api/templates/{id}/apply")
        handler = AsyncMock(return_value=web.json_response({"id": "created"}, status=201))
        namespace = {"apply_template": handler, "_g": lambda fn, *modes: route_guards.requires_mode(*modes)(fn)}
        guarded = eval(compile(ast.Expression(registration.args[1]), str(SOURCE), "eval"), namespace)
        request = Request({"workspace_id": "allowed"})
        request["auth"] = SimpleNamespace(is_owner=False, mode="brief", actor_kind="joiner_session", actor_id="test", label="test")
        request.method = "POST"
        with patch.object(route_guards, "_emit_violation"):
            response = await guarded(request)
        self.assertEqual(response.status, 403)
        handler.assert_not_awaited()

    async def test_preset_rejects_missing_workspace_before_writes(self):
        database = SimpleNamespace(execute=AsyncMock(), fetchone=AsyncMock(return_value=None), close=AsyncMock())
        database.execute.return_value = database
        handler = self.template_handler(database, visible=True)
        response = await handler(Request({"workspace_id": "deleted-workspace"}))
        self.assertEqual(response.status, 404)
        database.execute.assert_awaited_once_with("SELECT id FROM workspaces WHERE id = ?", ("deleted-workspace",))
        database.close.assert_awaited_once()

    async def test_preset_rejects_invisible_workspace_before_database_access(self):
        database = SimpleNamespace(execute=AsyncMock())
        handler = self.template_handler(database, visible=False)
        response = await handler(Request({"workspace_id": "other-workspace"}))
        self.assertEqual(response.status, 404)
        database.execute.assert_not_awaited()

    @staticmethod
    def template_handler(database, *, visible):
        tree = ast.parse(SOURCE.read_text())
        handler = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "apply_template")
        namespace = {"web": web, "get_db": AsyncMock(return_value=database),
                     "get_auth": lambda _: None, "_workspace_visible_to_auth": lambda *_: visible}
        exec(compile(ast.Module(body=[handler], type_ignores=[]), str(SOURCE), "exec"), namespace)
        return namespace["apply_template"]


if __name__ == "__main__":
    unittest.main()
