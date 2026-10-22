"""mcp_add (Codex) registration: one writer at a time, no rewrite when unchanged.

Isolated: server.py functions are compiled out of the file, every
`codex mcp add/remove` subprocess is a fake that only records its argv. No CLI,
no config file, no server.
"""
import ast
import asyncio
import json
import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Optional
import unittest

NAMES = (
    "_mcp_add_state_key", "_release_mcp_add_lock_later", "_prune_mcp_add_servers",
    "_register_mcp_add_server", "_render_mcp_argv", "_resolve_mcp_env_values",
    "_apply_session_mcp", "_apply_session_mcp_servers", "_finish_session_mcp",
    "_apply_frozen_mcp_binaries", "_mcp_config_entry_for_server",
    "UnsupportedMCPProfileError",
)


class FakeProc:
    def __init__(self, log, argv, delay):
        self.log, self.argv, self.delay, self.returncode = log, argv, delay, 0

    async def communicate(self):
        self.log.append(("begin", self.argv[1:3], self.argv[3] if len(self.argv) > 3 else ""))
        await asyncio.sleep(self.delay)
        self.log.append(("end", self.argv[1:3], self.argv[3] if len(self.argv) > 3 else ""))
        return b"", b""


class Session:
    def __init__(self):
        self.profile = SimpleNamespace(
            id="codex", mcp_strategy="mcp_add", mcp_config_adapter=None,
            mcp_add_argv=["{binary}", "mcp", "add", "{server_name}", "{env}", "--", "{command}", "{args}"],
            mcp_remove_argv=["{binary}", "mcp", "remove", "{server_name}"],
            mcp_env_argv=["--env", "{key}={value}"],
            mcp_auto_approve_argv=[],
        )
        self.values = {}

    def _resolved_binary(self):
        return "codex"

    def supports(self, _feature):
        return False

    def set(self, key, value):
        self.values[key] = value

    def get(self, key):
        return self.values.get(key)


SERVERS = [
    {"id": "builtin-commander", "server_name": "commander", "command": "python3",
     "args": ["mcp_server.py"], "env": {"WS": "{workspace_id}"},
     "auto_approve": 1, "auto_approve_override": None, "server_type": "stdio"},
    {"id": "builtin-worker-board", "server_name": "worker-board", "command": "python3",
     "args": ["worker_mcp_server.py"], "env": {"WORKER_SESSION_ID": "{session_id}"},
     "auto_approve": 1, "auto_approve_override": None, "server_type": "stdio"},
]


class McpAddSerialTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.log = []
        log = self.log

        async def fake_exec(*argv, **_kw):
            return FakeProc(log, list(argv), 0.05)

        async def owned():
            return {"commander", "worker-board", "documentor", "playwright"}

        async def servers(_sid, _config):
            return [dict(s, env=dict(s["env"])) for s in SERVERS]

        async def w2w(_ws):
            return ("0", "0", "0")

        tree = ast.parse(Path(__file__).with_name("server.py").read_text())
        kinds = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
        subset = ast.Module(body=[n for n in tree.body if isinstance(n, kinds) and n.name in NAMES], type_ignores=[])
        self.ns = dict(
            json=json, asyncio=asyncio, os=__import__("os"), Optional=Optional,
            logger=logging.getLogger("test"), UnifiedSession=object,
            Feature=SimpleNamespace(MCP_CONFIG_PATH="mcp", ALLOWED_MCP_SERVERS="allowed",
                                    MCP_CONFIG_PATH_X=None, ALLOWED_TOOLS="tools"),
            _asyncio=SimpleNamespace(create_subprocess_exec=fake_exec,
                                     subprocess=SimpleNamespace(DEVNULL=None, PIPE=None)),
            _ive_owned_mcp_server_names=owned, _load_session_mcp_servers=servers,
            _load_session_w2w_flags=w2w, HOST="127.0.0.1", PORT=0,
            _MCP_ADD_LOCK=asyncio.Lock(), _MCP_ADD_SETTLE_SECS=0.2, _MCP_ADD_STATE={},
        )
        exec(compile(subset, "server.py", "exec"), self.ns)
        self.ns["_apply_frozen_mcp_binaries"] = lambda _servers: None

    async def start(self, sid):
        config = {"workspace_id": "ws", "workspace_path": "/tmp", "session_type": "worker"}
        return await self.ns["_apply_session_mcp"](Session(), config, sid, {"HOME": "/h"})

    def calls(self):
        return [(c[1][1], c[2]) for c in self.log if c[0] == "begin"]

    async def test_second_start_only_rewrites_the_changed_server(self):
        await self.start("s1")
        first = self.calls()
        self.assertIn(("remove", "documentor"), first)
        self.assertIn(("add", "worker-board"), first)
        self.log.clear()
        await asyncio.sleep(0.3)  # settle window
        await self.start("s2")
        # Only worker-board carries the session id; stale servers are gone already.
        self.assertEqual(self.calls(), [("remove", "worker-board"), ("add", "worker-board")])
        self.log.clear()
        await asyncio.sleep(0.3)
        await self.start("s2")
        self.assertEqual(self.calls(), [])

    async def test_two_starts_at_once_never_interleave_config_writes(self):
        await asyncio.gather(self.start("a"), self.start("b"))
        depth = 0
        for kind, *_ in self.log:
            depth += 1 if kind == "begin" else -1
            self.assertLessEqual(depth, 1, self.log)
        # b's registration waits until a's CLI had time to read the config.
        ends = [i for i, c in enumerate(self.log) if c == ("end", ["mcp", "add"], "worker-board")]
        self.assertEqual(len(ends), 2)

    async def test_failed_add_is_retried_next_time(self):
        async def failing_exec(*argv, **_kw):
            p = FakeProc(self.log, list(argv), 0)
            if argv[2] == "add":
                p.returncode = 1
            return p

        self.ns["_asyncio"].create_subprocess_exec = failing_exec
        with self.assertRaises(RuntimeError):
            await self.start("s1")
        await asyncio.sleep(0)
        self.log.clear()

        async def ok_exec(*argv, **_kw):
            return FakeProc(self.log, list(argv), 0)

        self.ns["_asyncio"].create_subprocess_exec = ok_exec
        await asyncio.sleep(0.3)
        await self.start("s1")
        self.assertIn(("add", "commander"), self.calls())


if __name__ == "__main__":
    unittest.main()
