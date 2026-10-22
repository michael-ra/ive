"""Readiness regressions from a live Claude 2.1.296 planner screen."""
import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_trust_menu_review import CLAUDE, load_handlers

# Exact prompt/placeholder characters observed via the test session's output
# API. U+00A0 after the prompt made a ready real planner time out for 30 s.
CLAUDE_IDLE_SCREEN = '\n▗ ▗   ▖ ▖  Claude Code v2.1.296\n Opus 5.5 · Claude Max\n' + (
    '─' * 80 + '\n❯\u00a0Try "refactor <filepath>"\n' + '─' * 80
    + '\n  ⏸ plan mode on (shift+tab to cycle) · ← 4 agents'
)


class ClaudeReadinessTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.ns = load_handlers()

    def test_live_nbsp_placeholder_is_an_input_prompt(self):
        self.assertTrue(self.ns['_looks_ready_for_input']('claude', CLAUDE_IDLE_SCREEN))
        for space in [' ', '\t', '\u00a0', '\u2002', '\u2009', '\u202f']:
            with self.subTest(space=repr(space)):
                self.assertTrue(self.ns['_looks_ready_for_input']('claude', f'Claude Code\n{space}❯{space}Try a prompt'))

    def test_auth_setup_and_trust_remain_blocked_with_unicode_spacing(self):
        for screen in [CLAUDE.replace('❯ ', '❯\u00a0'),
                       'Select login method\n❯\u00a0Claude account with subscription',
                       'Choose the text style\n❯\u00a0Dark mode']:
            with self.subTest(screen=screen):
                self.assertFalse(self.ns['_looks_ready_for_input']('claude', screen))

    def test_inline_arrows_and_non_prompt_banner_are_not_ready(self):
        for screen in ['Loading workspace', 'Claude ❯\u00a0still starting', '❯Try without a separator', '\u2028❯\u00a0not a terminal line']:
            with self.subTest(screen=screen):
                self.assertFalse(self.ns['_looks_ready_for_input']('claude', screen))

    async def test_actual_waiter_accepts_live_prompt_after_stable_screen_check(self):
        tree = ast.parse(Path(__file__).with_name('server.py').read_text())
        nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                 and node.name in {'_wait_for_cli_input_ready', '_startup_blocker_text'}]
        self.ns.update(_asyncio=asyncio, _STARTUP_BLOCKER_FALLBACK_LINES=40,
            pty_mgr=SimpleNamespace(is_alive=lambda _: True),
            capture_proc=SimpleNamespace(get_screen=lambda _: CLAUDE_IDLE_SCREEN, get_buffer=lambda *_: ''))
        exec(compile(ast.Module(body=nodes, type_ignores=[]), 'server.py', 'exec'), self.ns)
        with patch.dict('sys.modules', {'hooks': SimpleNamespace(get_session_logical_status=lambda *_: 'idle')}):
            self.assertTrue(await self.ns['_wait_for_cli_input_ready']('planner', 'claude', 1))


if __name__ == '__main__':
    unittest.main()
