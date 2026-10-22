"""Real startup-menu layouts; deterministic PTY navigation without native CLIs."""
import ast
import asyncio
from pathlib import Path
import re
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock


CLAUDE = """Accessing workspace:
/test/project
Quick safety check: Is this a project you created or one you trust?
❯ No, exit
  Yes, I trust this folder
Enter to confirm · Esc to cancel
"""
CODEX = """Folder access
/test/project
Trust
this
folder?
Codex can read, edit, and run files here.
› 1. Trust and continue
2.
Quit
enter continue · esc quit
"""
# Codex 0.16x variant without the "Folder access" header and with
# "Open restricted" instead of "Quit".
CODEX_RESTRICTED = """Trust this folder? Codex can read, edit, and run files here, subject to your
permission settings. Continue only if you trust these files.

› 1. Trust and continue
  2. Open restricted
"""


def load_handlers(**dependencies):
    tree = ast.parse(Path(__file__).with_name("server.py").read_text())
    names = {"_strip_pty_control_bytes", "_compact_cli_text", "_trust_prompt_selection", "_check_auto_trust",
             "_detect_cli_startup_blocker", "_has_codex_update_prompt_text", "_looks_ready_for_input",
             "_looks_codex_busy", "_looks_antigravity_busy", "_has_codex_trust_prompt_text",
             "_codex_composer_ready"}
    nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    nodes += [n for n in tree.body if isinstance(n, ast.Assign) and any(getattr(t, "id", "") in {"_TRUST_PATTERNS", "_CODEX_MENU_CURSOR_RE"} for t in n.targets)]
    namespace = {"re": re, "_trust_handled": {}, "_pty_start_time": {"session": 1},
                 "_terminal_streams": {"session": object()}, **dependencies}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "server.py", "exec"), namespace)
    return namespace


class TrustMenuDetectionTests(unittest.TestCase):
    def setUp(self):
        self.ns = load_handlers()

    def test_current_claude_exit_default_is_not_affirmative(self):
        menu = self.ns["_trust_prompt_selection"](CLAUDE)
        self.assertEqual(menu["selected"], 0)
        self.assertEqual(menu["target"], 1)
        self.assertEqual(self.ns["_detect_cli_startup_blocker"]("claude", CLAUDE)["type"], "trust_required")
        self.assertFalse(self.ns["_looks_ready_for_input"]("claude", CLAUDE))

    def test_current_codex_numbered_menu_is_blocked_not_ready(self):
        menu = self.ns["_trust_prompt_selection"](CODEX)
        self.assertEqual(menu["selected"], menu["target"])
        self.assertEqual(self.ns["_detect_cli_startup_blocker"]("codex", CODEX)["type"], "trust_required")
        self.assertFalse(self.ns["_looks_ready_for_input"]("codex", CODEX))

    def test_codex_open_restricted_menu_is_recognized(self):
        menu = self.ns["_trust_prompt_selection"](CODEX_RESTRICTED)
        self.assertEqual(menu["cli_type"], "codex")
        self.assertEqual(menu["options"], ("trustandcontinue", "openrestricted"))
        self.assertEqual(menu["selected"], menu["target"])
        self.assertEqual(self.ns["_detect_cli_startup_blocker"]("codex", CODEX_RESTRICTED)["type"], "trust_required")
        self.assertFalse(self.ns["_looks_ready_for_input"]("codex", CODEX_RESTRICTED))
        self.assertTrue(self.ns["_looks_ready_for_input"]("codex", CODEX_RESTRICTED + "\n› "))

    def test_old_menu_above_returned_prompt_is_ignored(self):
        for cli, screen, prompt in (("claude", CLAUDE, "❯ "), ("codex", CODEX, "› ")):
            with self.subTest(cli=cli):
                self.assertIsNone(self.ns["_trust_prompt_selection"](screen + prompt))
                self.assertIsNone(self.ns["_detect_cli_startup_blocker"](cli, screen + prompt))

    def test_worktree_trust_error_explains_regular_session_recovery(self):
        text = "Error creating worktree: Workspace trust not yet accepted. Run `claude` once in this directory and accept the trust dialog, then retry with --worktree."
        blocker = self.ns["_detect_cli_startup_blocker"]("claude", text)
        self.assertEqual(blocker["type"], "trust_required")
        self.assertIn("regular Claude session", blocker["detail"])
        self.assertIn("worktree", blocker["label"])
        self.assertIsNone(self.ns["_trust_prompt_selection"](text))

    def test_claude_startup_text_alone_is_never_ready(self):
        for text in ("Welcome to Claude", "Loading workspace", "Quick safety check", "Error: startup failed"):
            self.assertFalse(self.ns["_looks_ready_for_input"]("claude", text))
        self.assertTrue(self.ns["_looks_ready_for_input"]("claude", "Claude Code\n❯ "))


class TrustMenuAcceptanceTests(unittest.IsolatedAsyncioTestCase):
    async def run_check(self, screen=CLAUDE, *, navigation=True, during_sleep=None):
        capture = SimpleNamespace(screen=screen)
        capture.get_screen = lambda _: capture.screen
        writes, tasks = [], []
        def write(_, data):
            writes.append(data)
            if navigation and data in (b"\x1b[B", b"\x1b[A"):
                capture.screen = capture.screen.replace("❯ No, exit", "  No, exit").replace("  Yes, I trust this folder", "❯ Yes, I trust this folder")
            return True
        async def sleep(delay):
            if during_sleep:
                during_sleep(delay, capture, ns, writes)
        def schedule(coro):
            task = asyncio.create_task(coro)
            tasks.append(task)
            return task
        ns = load_handlers(capture_proc=capture,
            pty_mgr=SimpleNamespace(is_alive=lambda _: True, write=write),
            _asyncio=SimpleNamespace(sleep=sleep, ensure_future=schedule), logger=SimpleNamespace(info=Mock()))
        ns["_check_auto_trust"]("session", b"trust")
        await asyncio.gather(*tasks)
        return writes

    async def test_claude_navigates_down_to_yes_before_enter(self):
        self.assertEqual(await self.run_check(), [b"\x1b[B", b"\r"])

    async def test_reversed_claude_order_navigates_up_before_enter(self):
        reversed_menu = CLAUDE.replace("❯ No, exit\n  Yes, I trust this folder", "  Yes, I trust this folder\n❯ No, exit")
        self.assertEqual(await self.run_check(reversed_menu), [b"\x1b[A", b"\r"])

    async def test_codex_selected_trust_never_gets_escape_or_prompt_clear(self):
        self.assertEqual(await self.run_check(CODEX), [b"\r"])

    async def test_codex_open_restricted_default_is_confirmed_with_enter(self):
        self.assertEqual(await self.run_check(CODEX_RESTRICTED), [b"\r"])

    async def test_stale_menu_before_delay_never_submits_prompt(self):
        def changed(delay, capture, *_):
            capture.screen = "Claude Code\n❯ unrelated draft"
        self.assertEqual(await self.run_check(during_sleep=changed), [])

    async def test_navigation_without_confirmed_redraw_never_presses_enter(self):
        self.assertEqual(await self.run_check(navigation=False), [b"\x1b[B"])

    async def test_ptys_restarted_during_delay_cannot_inherit_old_acceptance(self):
        def restarted(delay, capture, ns, writes):
            ns["_terminal_streams"]["session"] = object()
        self.assertEqual(await self.run_check(during_sleep=restarted), [])

    async def test_expiring_initial_render_timestamp_does_not_cancel_same_pty(self):
        def render_window_ended(delay, capture, ns, writes):
            if writes:
                ns["_pty_start_time"].pop("session", None)
        self.assertEqual(await self.run_check(during_sleep=render_window_ended), [b"\x1b[B", b"\r"])

    async def test_incomplete_arrow_redraw_waits_for_confirmed_affirmative(self):
        redraws = 0
        def redraw(delay, capture, ns, writes):
            nonlocal redraws
            if delay == 0.1:
                redraws += 1
                capture.screen = "" if redraws == 1 else CLAUDE.replace("❯ No, exit", "  No, exit").replace("  Yes,", "❯ Yes,")
        self.assertEqual(await self.run_check(during_sleep=redraw), [b"\x1b[B", b"\r"])

    async def test_selection_changed_just_before_enter_is_not_accepted(self):
        def changed(delay, capture, ns, writes):
            if delay == 0.15:
                capture.screen = CLAUDE
        self.assertEqual(await self.run_check(during_sleep=changed), [b"\x1b[B"])

    async def test_ambiguous_selection_never_accepts(self):
        screen = CLAUDE.replace("  Yes,", "❯ Yes,")
        self.assertEqual(await self.run_check(screen), [])


if __name__ == "__main__":
    unittest.main()
