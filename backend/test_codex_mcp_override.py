"""Codex MCP servers go on the codex argv as `-c mcp_servers.*`, never into
the shared config.toml.

Temp dirs only; the DB/loader calls are patched. The real-codex check is
opt-in (IVE_TEST_REAL_CODEX=1) and only runs `codex mcp list` in a temp
CODEX_HOME.
"""
import asyncio
import json
import os
import shutil
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

import server
from cli_profiles import CODEX_PROFILE
from cli_session import UnifiedSession


def _values(args):
    """Parse the `-c key=value` pairs back the way codex does (value = TOML)."""
    out = {}
    for flag, item in zip(args[::2], args[1::2]):
        assert flag == "-c", args
        key, _, raw = item.partition("=")
        out[key] = tomllib.loads(f"v = {raw}")["v"]
    return out


WORKER = {
    "id": "builtin-worker-board", "server_name": "worker-board", "server_type": "stdio",
    "command": "/usr/bin/python3", "args": ["/ive/backend/worker_mcp_server.py"],
    "env": {"WORKER_SESSION_ID": "{session_id}", "COMMANDER_API_URL": "http://{host}:{port}",
            "GITHUB_TOKEN": "ghp_secret"},
    "auto_approve": 0, "auto_approve_override": None, "is_builtin": 1,
}


class OverrideArgsTests(unittest.TestCase):
    def test_stdio_server_round_trips_and_keeps_secrets_off_argv(self):
        env = {}
        entry = {"command": "py", "args": ["a b", 'q"uote'],
                 "env": {"WORKER_SESSION_ID": "s-1", "API_KEY": "sk-123"}}
        args = server._codex_mcp_override_args("worker-board", entry, env)
        values = _values(args)
        self.assertEqual(values["mcp_servers.worker-board.command"], "py")
        self.assertEqual(values["mcp_servers.worker-board.args"], ["a b", 'q"uote'])
        self.assertEqual(values["mcp_servers.worker-board.env"], {"WORKER_SESSION_ID": "s-1"})
        self.assertEqual(values["mcp_servers.worker-board.env_vars"], ["API_KEY"])
        self.assertTrue(values["mcp_servers.worker-board.enabled"])
        self.assertNotIn("sk-123", " ".join(args))
        self.assertEqual(env["API_KEY"], "sk-123")

    def test_http_server_secret_header_goes_through_env(self):
        env = {}
        args = server._codex_mcp_override_args(
            "zai", {"type": "http", "url": "https://x/mcp",
                    "headers": {"Authorization": "Bearer t", "X-Mode": "1"}}, env)
        values = _values(args)
        self.assertEqual(values["mcp_servers.zai.url"], "https://x/mcp")
        self.assertEqual(values["mcp_servers.zai.http_headers"], {"X-Mode": "1"})
        env_name = values["mcp_servers.zai.env_http_headers"]["Authorization"]
        self.assertEqual(env[env_name], "Bearer t")
        self.assertNotIn("Bearer t", " ".join(args))

    def test_unusable_name_is_skipped(self):
        self.assertEqual(server._codex_mcp_override_args("a.b", {"command": "x"}, {}), [])

    def test_profile_uses_config_override(self):
        self.assertEqual(CODEX_PROFILE.mcp_strategy, "config_override")
        self.assertEqual(CODEX_PROFILE.mcp_add_argv, [])

    def test_launch_args_land_in_argv_after_resume(self):
        session = UnifiedSession("codex", {"resume_id": "thread-1"})
        session.launch_args.extend(["-c", "mcp_servers.x.command=\"y\""])
        argv = session.build_command()
        self.assertLess(argv.index("resume"), argv.index("mcp_servers.x.command=\"y\""))


class ApplySessionMcpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        # Left over by an older IVE: `codex mcp add` entries in config.toml.
        self.config = self.home / "config.toml"
        self.config.write_text(
            '[mcp_servers.worker-board]\ncommand = "old"\n[mcp_servers.worker-board.env]\n'
            'WORKER_SESSION_ID = "stale"\n\n[mcp_servers.commander]\ncommand = "old"\n'
            '\n[mcp_servers.mine]\ncommand = "user"\n')
        self.before = self.config.read_bytes()
        patches = {
            "_load_session_w2w_flags": mock.AsyncMock(return_value=("0", "0", "0")),
            "_load_session_mcp_servers": mock.AsyncMock(
                side_effect=lambda sid, cfg: [json.loads(json.dumps(WORKER))]),
            "_ive_owned_mcp_server_names": mock.AsyncMock(
                return_value={"worker-board", "commander"}),
        }
        for name, value in patches.items():
            p = mock.patch.object(server, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.spawn = mock.patch.object(server._asyncio, "create_subprocess_exec",
                                       mock.AsyncMock(side_effect=AssertionError("no subprocess")))
        self.spawn.start()
        self.addCleanup(self.spawn.stop)

    async def _start(self, sid):
        session = UnifiedSession("codex", {})
        env = {"CODEX_HOME": str(self.home)}
        await server._apply_session_mcp(session, {"workspace_path": self.tmp.name,
                                                  "workspace_id": "w1"}, sid, env)
        return session, env

    async def test_two_sessions_get_their_own_ids_without_touching_config(self):
        (s1, env1), (s2, env2) = await asyncio.gather(self._start("sess-1"), self._start("sess-2"))
        v1, v2 = _values(s1.launch_args), _values(s2.launch_args)
        self.assertEqual(v1["mcp_servers.worker-board.env"]["WORKER_SESSION_ID"], "sess-1")
        self.assertEqual(v2["mcp_servers.worker-board.env"]["WORKER_SESSION_ID"], "sess-2")
        # IVE-owned but unselected: off for this process; user servers untouched.
        self.assertIs(v1["mcp_servers.commander.enabled"], False)
        self.assertNotIn("mcp_servers.mine.enabled", v1)
        self.assertEqual(env1["GITHUB_TOKEN"], "ghp_secret")
        self.assertNotIn("ghp_secret", " ".join(s1.launch_args))
        self.assertEqual(self.config.read_bytes(), self.before)
        self.assertFalse(server._MCP_ADD_LOCK.locked())

    @unittest.skipUnless(os.environ.get("IVE_TEST_REAL_CODEX") == "1" and shutil.which("codex"),
                         "set IVE_TEST_REAL_CODEX=1 to check against the installed codex")
    async def test_real_codex_reads_the_overrides(self):
        session, env = await self._start("sess-real")
        out = subprocess.run(
            ["codex", *session.launch_args, "mcp", "list", "--json"],
            cwd=self.tmp.name, env={**os.environ, **env}, capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        listed = {s["name"]: s for s in json.loads(out.stdout)}
        worker = listed["worker-board"]["transport"]
        self.assertEqual(worker["env"]["WORKER_SESSION_ID"], "sess-real")
        self.assertEqual(worker["env_vars"], ["GITHUB_TOKEN"])
        self.assertFalse(listed["commander"]["enabled"])
        self.assertTrue(listed["mine"]["enabled"])
        self.assertEqual(self.config.read_bytes(), self.before)


if __name__ == "__main__":
    unittest.main()
