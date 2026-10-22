"""Regression: launching IVE from Claude must not disable its terminals' history."""
import ast
import asyncio
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from pty_manager import PTYManager, prepare_terminal_env


class TerminalEnvironmentTests(unittest.TestCase):
    def test_detaches_parent_identity_after_session_overrides(self):
        parent = {"CLAUDECODE": "1", "CLAUDE_CODE_CHILD_SESSION": "1",
                  "CLAUDE_CODE_SESSION_ID": "parent", "PATH": "/bin"}
        extra = {"CLAUDE_CODE_CHILD_SESSION": "1", "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE": "0",
                 "CLAUDE_CONFIG_DIR": "/account/.claude", "ANTHROPIC_API_KEY": "test-only",
                 "CLAUDE_CODE_EFFORT_LEVEL": "high", "IVE_SESSION_ID": "own"}
        env = prepare_terminal_env(parent, extra, "/bin/claude")
        for key in ("CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID"):
            self.assertNotIn(key, env)
        self.assertEqual(env["CLAUDE_CODE_FORCE_SESSION_PERSISTENCE"], "1")
        for key in ("CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "CLAUDE_CODE_EFFORT_LEVEL", "IVE_SESSION_ID"):
            self.assertEqual(env[key], extra[key])
        self.assertEqual(parent["CLAUDE_CODE_CHILD_SESSION"], "1", "parent unchanged")
        self.assertEqual(extra["CLAUDE_CODE_CHILD_SESSION"], "1", "overrides unchanged")

    def test_other_executables_keep_their_environment(self):
        env = {"CLAUDE_CODE_CHILD_SESSION": "1", "CODEX_HOME": "/account/.codex"}
        self.assertEqual(prepare_terminal_env(env, {}, "codex"), env)


class RealTerminalEnvironmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_pty_child_gets_independent_persistent_session(self):
        # A real PTY/exec boundary, but no account, CLI network call or home writes.
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp, "env.json")
            exe = Path(tmp, "claude")
            exe.write_text(f"#!{sys.executable}\nimport os,json\n"
                           f"open({str(out)!r}, 'w').write(json.dumps(dict(os.environ)))\n")
            exe.chmod(0o755)
            mgr = PTYManager()
            try:
                with patch.dict(os.environ, {"CLAUDECODE": "1", "CLAUDE_CODE_CHILD_SESSION": "1"}):
                    await mgr.start_session("sync-test", tmp, cmd_binary=str(exe))
                async with asyncio.timeout(5):
                    while not out.exists() or not out.stat().st_size:
                        await asyncio.sleep(0.02)
                env = json.loads(out.read_text())
                self.assertNotIn("CLAUDE_CODE_CHILD_SESSION", env)
                self.assertNotIn("CLAUDECODE", env)
                self.assertEqual(env["CLAUDE_CODE_FORCE_SESSION_PERSISTENCE"], "1")
            finally:
                await mgr.stop_all()


class ChatTranscriptIssueTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tree = ast.parse(Path(__file__).with_name("server.py").read_text())
        body = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_chat_transcript_issue"]
        ns = {"re": re}
        exec(compile(ast.Module(body=body, type_ignores=[]), "server.py", "exec"), ns)
        cls.detect = staticmethod(ns["_chat_transcript_issue"])

    def test_claude_warning_with_terminal_line_wraps(self):
        screen = "Hallo!\n⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_\nSESSION marker"
        self.assertIn("export", self.detect("claude", screen))
        self.assertIsNone(self.detect("codex", screen))

    def test_new_empty_and_healthy_conversations_are_not_errors(self):
        for screen in ("", "Claude Code\n❯", "❯ hallo\n⏺ Hallo!", "CLAUDE_CODE_CHILD_SESSION"):
            self.assertIsNone(self.detect("claude", screen))


class OverviewFollowupInputTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import server
        self.server = server
        self.capture = SimpleNamespace(
            get_screen=lambda sid: "• Hallo C, ZEDER-906 gemerkt.\n\n› Ask Codex to do anything\n  GPT-6-Astra xhigh",
            # Real failure: title/spinner redraws have pushed the prompt out
            # of raw output. Codex is idle, but the old check never sees ›.
            get_buffer=lambda sid, lines: "⠏\n⠋\n⠙\nMerke\nZEDER-906\n",
        )
        for mock in (
            patch.object(server, "capture_proc", self.capture),
            patch.object(server.pty_mgr, "is_alive", return_value=True),
            patch("hooks.get_session_logical_status", return_value="idle"),
        ):
            mock.start()
            self.addCleanup(mock.stop)

    async def test_second_overview_message_uses_visible_prompt_after_redraws(self):
        self.assertTrue(await self.server._wait_for_cli_input_ready("codex-test", "codex", 1))
        self.assertTrue(await self.server._wait_for_cli_input_ready("codex-test", "codex", 0))

    async def test_old_ready_prompt_cannot_override_current_busy_screen(self):
        self.capture.get_screen = lambda sid: "› previous prompt\nWorking… esc to interrupt"
        self.capture.get_buffer = lambda sid, lines: "› old idle prompt"
        self.assertFalse(await self.server._wait_for_cli_input_ready("codex-test", "codex", 0))

    async def test_debounce_rechecks_current_screen(self):
        screens = iter(["› ready", "› prompt\nWorking… esc to interrupt"])
        self.capture.get_screen = lambda sid: next(screens, "Working… esc to interrupt")
        self.assertFalse(await self.server._wait_for_cli_input_ready("codex-test", "codex", 0.55))

    async def test_without_screen_falls_back_to_recent_output(self):
        self.capture.get_screen = lambda sid: ""
        self.capture.get_buffer = lambda sid, lines: "› ready"
        self.assertTrue(await self.server._wait_for_cli_input_ready("codex-test", "codex", 0))


if __name__ == "__main__":
    unittest.main()
