"""Workspace git + demo routes are mode-guarded like the file preview.

Brief joiners must not read diffs/logs or start demo commands. Builds the
real route table with create_app() (no server start) in an isolated HOME.
"""
import asyncio
import os
import tempfile
import unittest
from pathlib import Path

_TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("IVE_DATA_DIR", str(Path(_TMP.name) / "data"))

from aiohttp.test_utils import make_mocked_request  # noqa: E402

import demo_runner  # noqa: E402
import server  # noqa: E402
from auth_context import AuthContext  # noqa: E402

GUARDED = {
    ("GET", "/api/workspaces/{id}/git/status"),
    ("GET", "/api/workspaces/{id}/git/diff"),
    ("GET", "/api/workspaces/{id}/git/log"),
    ("POST", "/api/workspaces/{id}/git/stage"),
    ("POST", "/api/workspaces/{id}/git/unstage"),
    ("POST", "/api/workspaces/{id}/demo/start"),
    ("POST", "/api/workspaces/{id}/demo/stop"),
    ("POST", "/api/workspaces/{id}/demo/pull-latest"),
}


def _ctx(mode):
    return AuthContext(
        actor_kind="joiner_session", actor_id="j1", mode=mode,
        brief_subscope=None, label="guest", expires_at=None,
    )


class GitRouteGuardTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = server.create_app()

    def _handlers(self):
        found = {}
        for route in self.app.router.routes():
            key = (route.method, route.resource.canonical)
            if key in GUARDED:
                found[key] = route.handler
        self.assertEqual(set(found), GUARDED)
        return found

    async def test_brief_joiner_is_blocked(self):
        import route_guards
        from unittest.mock import patch
        with patch.object(route_guards, "_emit_violation", lambda *a, **k: None):
            await self._assert_brief_blocked()

    async def _assert_brief_blocked(self):
        for (method, path), handler in self._handlers().items():
            req = make_mocked_request(method, path.replace("{id}", "ws1"), match_info={"id": "ws1"})
            req["auth"] = _ctx("brief")
            resp = await handler(req)
            self.assertEqual(resp.status, 403, f"{method} {path}")

    async def test_missing_auth_context_fails_closed(self):
        for (method, path), handler in self._handlers().items():
            req = make_mocked_request(method, path.replace("{id}", "ws1"), match_info={"id": "ws1"})
            resp = await handler(req)
            self.assertEqual(resp.status, 401, f"{method} {path}")


class DemoBranchTests(unittest.TestCase):
    def test_option_shaped_branch_never_reaches_git(self):
        calls = []

        async def fake_run(cwd, argv, *a, **k):
            calls.append(argv)
            return 0, "", ""

        orig = demo_runner._run_subprocess
        demo_runner._run_subprocess = fake_run
        try:
            with self.assertRaises(RuntimeError):
                asyncio.run(demo_runner._git_pull("/nonexistent", "--upload-pack=touch /tmp/x"))
        finally:
            demo_runner._run_subprocess = orig
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
