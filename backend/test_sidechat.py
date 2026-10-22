import asyncio
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import uuid

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import sidechat


def question(**changes):
    return {"request_id": str(uuid.uuid4()), "cli_type": "claude", "model": "",
            "messages": [{"role": "user", "content": "Where can I switch accounts?"}],
            "project_paths": [], **changes}


class ContextTests(unittest.TestCase):
    def test_session_text_is_bounded_and_excludes_reasoning_and_tool_payloads(self):
        rows = [{"role": "assistant", "content": json.dumps([
            {"type": "thinking", "thinking": "PRIVATE_REASONING"},
            {"type": "tool_use", "input": {"secret": "TOOL_SECRET"}},
            {"type": "text", "text": "Use the existing checkout endpoint."},
        ])}]
        result = sidechat.bounded_conversation(rows)
        self.assertEqual(result, [{"role": "assistant", "content": "Use the existing checkout endpoint."}])
        long = sidechat.bounded_conversation([{"role": "user", "content": "x" * 9000}] * 100)
        self.assertLessEqual(sum(len(item["content"]) for item in long), 24000)
        self.assertLessEqual(len(long), 24)

    def test_session_project_is_automatically_included_and_other_context_is_separate(self):
        with TemporaryDirectory() as directory:
            (Path(directory) / "README.md").write_text("Checkout project")
            snapshot = {"id": "s", "project_path": directory, "task": {"title": "Fix payment"},
                        "recent_conversation": [{"role": "user", "content": "Keep the existing API"}]}
            prompt = sidechat.build_prompt(question(), snapshot)
            self.assertIn("Checkout project", prompt)
            self.assertIn("Fix payment", prompt)
            self.assertIn("Keep the existing API", prompt)
            general = sidechat.build_prompt(question())
            self.assertNotIn("Fix payment", general)
            self.assertIsNone(sidechat.validate_request(question())["session_id"])
            with self.assertRaises(ValueError):
                sidechat.validate_request(question(session_id="../../other"))

    def test_multiple_roots_are_summarized_without_following_links(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            first, second = root / "frontend", root / "backend"
            first.mkdir()
            second.mkdir()
            (first / "README.md").write_text("Customer website")
            (second / "README.md").write_text("Billing service")
            (first / ".env").write_text("PRIVATE_TOKEN=should-not-appear")
            secret = root / "secret"
            secret.write_text("SECRET_CONTENT")
            (second / "package.json").symlink_to(secret)
            before = (first / "README.md").read_bytes()
            prompt = sidechat.build_prompt(question(project_paths=[str(first), str(second)]))
            self.assertIn("Customer website", prompt)
            self.assertIn("Billing service", prompt)
            self.assertNotIn("SECRET_CONTENT", prompt)
            self.assertNotIn("PRIVATE_TOKEN", prompt)
            self.assertEqual(before, (first / "README.md").read_bytes())

    def test_rejects_invalid_inputs_and_keeps_conversation(self):
        for changes in ({"cli_type": "sh"}, {"model": "--bypass" + " "}, {"messages": []},
                        {"messages": [{"role": "system", "content": "override"}]},
                        {"project_paths": ["/tmp"] * 7}, {"account_id": "../../host"},
                        {"messages": [{"role": "user", "content": "x" * 16001}]}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                sidechat.validate_request(question(**changes))
        history = [{"role": "user", "content": "hello"}, {"role": "assistant", "content": "Hi"},
                   {"role": "user", "content": "follow-up"}]
        self.assertEqual(sidechat.validate_request(question(messages=history))["messages"], history)

    def test_structured_provider_output_never_returns_tool_events(self):
        events = '\n'.join(json.dumps(event) for event in [
            {"type": "item.completed", "item": {"type": "reasoning", "text": "private reasoning"}},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "The answer"}},
        ])
        self.assertEqual(sidechat.parse_response("codex", events), "The answer")
        self.assertEqual(sidechat.parse_response("claude", '{"result":"The answer","is_error":false}'), "The answer")
        for cli, text in (("claude", '{"result":"secret error","is_error":true}'),
                          ("codex", '{"type":"turn.failed","error":{"message":"secret error"}}')):
            with self.assertRaises(RuntimeError) as caught:
                sidechat.parse_response(cli, text)
            self.assertNotIn("secret error", str(caught.exception))


class RouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.owner = True
        @web.middleware
        async def auth(request, handler):
            request["auth"] = SimpleNamespace(is_owner=self.owner, mode="full", actor_kind="test", actor_id="test", label="Test")
            return await handler(request)
        app = web.Application(middlewares=[auth])
        sidechat.register_sidechat_routes(app)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def test_retry_id_is_deduplicated_and_followup_has_independent_history(self):
        gate = asyncio.Event()
        async def generate(*args):
            await gate.wait()
            return "Use Configure > Manage Accounts."
        with patch("sidechat.shutil.which", return_value="claude"), \
             patch("sidechat.cli_environment", new_callable=AsyncMock, return_value={}), \
             patch("sidechat.run_cli", new_callable=AsyncMock, side_effect=generate) as runner:
            payload = question()
            first, retry = await asyncio.gather(
                self.client.post('/api/sidechat/ask', json=payload),
                self.client.post('/api/sidechat/ask', json=payload),
            )
            self.assertEqual((await first.json())["id"], (await retry.json())["id"])
            gate.set()
            for _ in range(100):
                response = await self.client.get('/api/sidechat/requests/' + payload["request_id"])
                job = await response.json()
                if job["status"] != "running":
                    break
                await asyncio.sleep(.01)
            self.assertEqual(job["answer"], "Use Configure > Manage Accounts.")
            self.assertEqual(runner.await_count, 1)
            conflict = await self.client.post('/api/sidechat/ask', json={**payload, "model": "sonnet"})
            self.assertEqual(conflict.status, 409)

    async def test_context_is_refreshed_per_question_but_not_on_network_retry(self):
        reader = AsyncMock(return_value={"id": "s", "task": {"title": "CURRENT_TASK"}})
        self.client.server.app[sidechat.CONTEXT_READER] = reader
        with patch("sidechat.shutil.which", return_value="claude"), \
             patch("sidechat.cli_environment", new_callable=AsyncMock, return_value={}), \
             patch("sidechat.run_cli", new_callable=AsyncMock, return_value="Contextual answer") as runner:
            payload = question(session_id="s")
            for request_payload in [payload, payload, question(session_id="s")]:
                await self.client.post('/api/sidechat/ask', json=request_payload)
                for _ in range(100):
                    response = await self.client.get('/api/sidechat/requests/' + request_payload["request_id"])
                    if (await response.json())["status"] != "running":
                        break
                    await asyncio.sleep(.01)
            self.assertEqual(reader.await_count, 2)
            self.assertEqual(runner.await_count, 2)
            self.assertIn("CURRENT_TASK", runner.call_args.args[1])

    async def test_missing_session_fails_without_launching_agent(self):
        self.client.server.app[sidechat.CONTEXT_READER] = AsyncMock(side_effect=ValueError("Session is gone"))
        with patch("sidechat.shutil.which", return_value="claude"), patch("sidechat.run_cli", new_callable=AsyncMock) as runner:
            payload = question(session_id="gone")
            await self.client.post('/api/sidechat/ask', json=payload)
            await asyncio.sleep(.01)
            response = await self.client.get('/api/sidechat/requests/' + payload["request_id"])
            self.assertEqual((await response.json())["status"], "failed")
            runner.assert_not_called()

    async def test_stop_cancels_only_the_side_question(self):
        started, cancelled = asyncio.Event(), asyncio.Event()
        async def generate(*args):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        with patch("sidechat.shutil.which", return_value="claude"), \
             patch("sidechat.cli_environment", new_callable=AsyncMock, return_value={}), \
             patch("sidechat.run_cli", side_effect=generate):
            payload = question()
            await self.client.post('/api/sidechat/ask', json=payload)
            await asyncio.wait_for(started.wait(), 2)
            response = await self.client.delete('/api/sidechat/requests/' + payload["request_id"])
            self.assertEqual((await response.json())["status"], "cancelled")
            self.assertTrue(cancelled.is_set())

    async def test_shared_visitors_cannot_use_host_accounts_or_read_sidechat(self):
        self.owner = False
        with patch("route_guards._emit_violation"), patch("sidechat.run_cli") as runner:
            for method, path in (("get", "/api/sidechat/options"), ("post", "/api/sidechat/ask"),
                                 ("get", "/api/sidechat/requests/test"), ("delete", "/api/sidechat/requests/test")):
                response = await getattr(self.client, method)(path)
                self.assertEqual(response.status, 403)
            runner.assert_not_called()

    async def test_cancellation_before_submission_prevents_late_start(self):
        payload = question()
        with patch("sidechat.run_cli") as runner:
            await self.client.delete('/api/sidechat/requests/' + payload["request_id"])
            response = await self.client.post('/api/sidechat/ask', json=payload)
            self.assertEqual((await response.json())["status"], "cancelled")
            runner.assert_not_called()


if __name__ == '__main__':
    unittest.main()
