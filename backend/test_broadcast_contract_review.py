"""Exercise delivery aggregation and worktree rejection with isolated dependencies."""
import ast
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from aiohttp import web
import route_guards


class Request(dict):
    def __init__(self, body):
        super().__init__()
        self.body = body
        self.match_info = {"id": "test-session"}
        self.path = "/api/broadcast"

    async def json(self):
        return self.body


def load_handler(name, **dependencies):
    tree = ast.parse(Path(__file__).with_name("server.py").read_text())
    handler = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == name)
    namespace = {"web": web, **dependencies}
    exec(compile(ast.Module(body=[handler], type_ignores=[]), "server.py", "exec"), namespace)
    return namespace[name]


class BroadcastContractTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.pty = SimpleNamespace(is_alive=Mock(return_value=True), write=Mock(return_value=True))
        self.emit = AsyncMock()
        self.visible = Mock(return_value=True)
        self.mode = Mock(return_value=None)
        self.config = AsyncMock(side_effect=lambda sid: {"id": sid, "cli_type": "gemini" if sid == "gemini" else "claude"})
        self.send = load_handler("broadcast_input", pty_mgr=self.pty, get_session_config=self.config,
            _session_visible_to_request=self.visible, get_auth=lambda _: None,
            _terminal_control_violation=self.mode, _record_terminal_mode_violation=AsyncMock(),
            _asyncio=SimpleNamespace(sleep=AsyncMock()), bus=SimpleNamespace(emit=self.emit),
            CommanderEvent=SimpleNamespace(COMMANDER_BROADCAST="broadcast"))

    async def request(self, ids=None, message="Hello"):
        response = await self.send(Request({"session_ids": ids or ["one", "two"], "message": message}))
        return response.status, json.loads(response.text)

    async def test_duplicate_recipients_receive_once_and_only_submitted_ids_are_announced(self):
        status, result = await self.request(["one", "one", "two"])
        self.assertEqual(status, 200)
        self.assertTrue(result["ok"])
        self.assertEqual(result["sent_to"], ["one", "two"])
        self.assertEqual(self.pty.write.call_count, 4)
        self.assertEqual(self.emit.call_args.args[1]["session_ids"], ["one", "two"])

    async def test_rejected_payload_never_counts_as_sent(self):
        self.pty.write.return_value = False
        status, result = await self.request()
        self.assertEqual(status, 409)
        self.assertFalse(result["ok"])
        self.assertEqual(result["sent_to"], [])
        self.assertEqual(result["failed"], ["one", "two"])
        self.assertEqual(result["partially_delivered"], [])
        self.emit.assert_not_awaited()

    async def test_partial_submission_is_explicit_and_failed_session_is_not_announced(self):
        self.pty.write.side_effect = lambda sid, data: not (sid == "two" and data == b"\r")
        status, result = await self.request()
        self.assertEqual(status, 200)
        self.assertFalse(result["ok"])
        self.assertEqual(result["sent_to"], ["one"])
        self.assertEqual(result["failed"], ["two"])
        self.assertEqual(result["partially_delivered"], ["two"])
        self.assertEqual(self.emit.call_args.args[1]["session_ids"], ["one"])

    async def test_exited_session_before_submit_is_reported_partial(self):
        self.pty.is_alive.side_effect = [True, False]
        status, result = await self.request(["one"])
        self.assertEqual(status, 409)
        self.assertEqual(result["partially_delivered"], ["one"])
        self.assertEqual(self.pty.write.call_count, 1)

    async def test_invisible_and_dead_recipients_fail_without_writes(self):
        self.visible.side_effect = lambda config, _: config["id"] != "invisible"
        self.pty.is_alive.return_value = False
        status, result = await self.request(["invisible", "dead"])
        self.assertEqual(status, 409)
        self.assertEqual(result["failed"], ["invisible", "dead"])
        self.pty.write.assert_not_called()

    async def test_mode_blocked_recipients_never_receive_input(self):
        self.mode.return_value = "Brief users cannot control workers"
        status, result = await self.request()
        self.assertEqual(status, 403)
        self.assertEqual(result["blocked"], ["one", "two"])
        self.pty.write.assert_not_called()

    async def test_multiline_payload_matches_each_cli(self):
        status, result = await self.request(["claude", "gemini"], "first\nsecond")
        self.assertEqual(status, 200)
        self.assertTrue(result["ok"])
        self.pty.write.assert_any_call("claude", b"\x1b[200~first\nsecond\x1b[201~")
        self.pty.write.assert_any_call("gemini", b"first second")


class WorktreeUpdateContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_or_unsupported_worktree_update_never_writes_session(self):
        for cli_type, requested in (("codex", True), ("codex", "yes"), ("claude", "perhaps"), ("claude", []), ("claude", {}), ("claude", 2)):
            with self.subTest(cli_type=cli_type, requested=requested):
                database = SimpleNamespace(execute=AsyncMock(), close=AsyncMock())
                database.execute.return_value = SimpleNamespace(fetchone=AsyncMock(return_value={"id": "test-session", "cli_type": cli_type}))
                handler = load_handler("update_session", get_db=AsyncMock(return_value=database), _session_visible_to_request=lambda *_: True)
                response = await handler(Request({"worktree": requested}))
                self.assertEqual(response.status, 400)
                self.assertEqual(json.loads(response.text)["code"], "unsupported_worktree")
                self.assertEqual(database.execute.call_count, 1, "Only the initial SELECT is allowed")
                database.close.assert_awaited_once()


class CascadeContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_cascade_mutation_routes_block_brief_joiners(self):
        source = Path(__file__).with_name("server.py")
        tree = ast.parse(source.read_text())
        for method, path, name in (("add_post", "/api/cascade-runs", "create_cascade_run"),
                                   ("add_put", "/api/cascade-runs/{id}", "update_cascade_run"),
                                   ("add_delete", "/api/cascade-runs/{id}", "delete_cascade_run")):
            with self.subTest(method=method):
                call = next(node for node in ast.walk(tree)
                    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr == method and node.args
                    and isinstance(node.args[0], ast.Constant) and node.args[0].value == path)
                handler = AsyncMock(return_value=web.json_response({"ok": True}))
                namespace = {name: handler, "_g": lambda fn, *modes: route_guards.requires_mode(*modes)(fn)}
                guarded = eval(compile(ast.Expression(call.args[1]), str(source), "eval"), namespace)
                request = Request({})
                request["auth"] = SimpleNamespace(is_owner=False, mode="brief")
                with patch.object(route_guards, "_emit_violation"):
                    response = await guarded(request)
                self.assertEqual(response.status, 403)
                handler.assert_not_awaited()

    async def test_cascade_handlers_check_visibility_and_terminal_control_before_mutations(self):
        runner = SimpleNamespace(get_run=AsyncMock(return_value={"session_id": "test-session"}),
                                 start_run=AsyncMock(), resume_run=AsyncMock(), stop_run=AsyncMock())
        for name in ("create_cascade_run", "update_cascade_run", "delete_cascade_run"):
            for config, reason, expected in ((None, None, 404), ({"id": "test-session"}, "read only", 403)):
                with self.subTest(handler=name, status=expected):
                    record = AsyncMock()
                    handler = load_handler(name, _get_visible_session_for_request=AsyncMock(return_value=config),
                        get_auth=lambda _: None, _terminal_control_violation=lambda *_: reason,
                        _record_terminal_mode_violation=record)
                    with patch.dict("sys.modules", {"cascade_runner": runner}):
                        response = await handler(Request({"session_id": "test-session", "steps": ["Do work"], "action": "resume"}))
                    self.assertEqual(response.status, expected)
                    runner.start_run.assert_not_awaited()
                    runner.resume_run.assert_not_awaited()
                    runner.stop_run.assert_not_awaited()
                    self.assertEqual(record.await_count, 1 if reason else 0)

    async def test_invalid_cascade_steps_are_client_error(self):
        runner = SimpleNamespace(start_run=AsyncMock(side_effect=ValueError("A cascade needs at least one non-empty text step.")))
        handler = load_handler("create_cascade_run", _get_visible_session_for_request=AsyncMock(return_value={"id": "test-session"}),
            get_auth=lambda _: None, _terminal_control_violation=lambda *_: None)
        with patch.dict("sys.modules", {"cascade_runner": runner}):
            response = await handler(Request({"session_id": "test-session", "steps": [42]}))
        self.assertEqual(response.status, 400)
        self.assertEqual(json.loads(response.text)["code"], "invalid_cascade")


if __name__ == "__main__":
    unittest.main()
