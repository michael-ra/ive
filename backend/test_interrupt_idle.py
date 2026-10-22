"""Esc / Ctrl+C in Claude moves the hook state to idle (review finding 7)."""
import unittest
from unittest.mock import AsyncMock, patch

import hooks

INTERRUPTED = """> fix the tests
⏺ Running the suite
  ⎿  Interrupted · What should Claude do instead?

╭────────────────────────────╮
│ >                          │
╰────────────────────────────╯
  ? for shortcuts"""

STILL_BUSY = """  ⎿  Interrupted · What should Claude do instead?
> next prompt
⏺ Reading files
✻ Cogitating… (4s · ↓ 120 tokens · esc to interrupt)"""


class InterruptIdleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.old = hooks._broadcast
        self.addCleanup(setattr, hooks, "_broadcast", self.old)
        self.addCleanup(hooks.cleanup_session, "int-test")
        self.sent = AsyncMock()
        hooks.set_broadcast_fn(self.sent)
        hooks._get_state("int-test")["state"] = "working"

    def states(self):
        return [c.args[0] for c in self.sent.await_args_list if c.args[0].get("type") == "session_state"]

    def test_screen_detection(self):
        self.assertTrue(hooks.claude_screen_shows_interrupt(INTERRUPTED))
        self.assertTrue(hooks.claude_screen_shows_interrupt("⎿  Interrupted by user\n>"))
        self.assertFalse(hooks.claude_screen_shows_interrupt(STILL_BUSY), "stale notice while busy")
        self.assertFalse(hooks.claude_screen_shows_interrupt("✻ Working… (esc to interrupt)"))
        old_notice = "⎿  Interrupted by user\n" + "\n".join(f"line {i}" for i in range(30))
        self.assertFalse(hooks.claude_screen_shows_interrupt(old_notice), "notice scrolled far up")
        self.assertTrue(hooks.claude_screen_shows_interrupt("⎿ Interrupted · What should Claude do instead?\n❯\u00a0\n⏸ plan mode on"))
        self.assertFalse(hooks.claude_screen_shows_interrupt("⎿ Interrupted by user\n❯ next task"))
        self.assertFalse(hooks.claude_screen_shows_interrupt("⎿ Interrupted by user\n❯\nDo you want to proceed?\n1. Yes\n2. No\nEsc to cancel"))

    async def test_mark_interrupted_broadcasts_idle_once(self):
        self.assertTrue(await hooks.mark_interrupted("int-test", "interrupt_input"))
        self.assertEqual(hooks.get_session_logical_status("int-test", True, "running"), "idle")
        self.assertEqual(self.states(), [{"type": "session_state", "session_id": "int-test", "state": "idle", "source": "interrupt_input"}])
        self.assertFalse(await hooks.mark_interrupted("int-test"), "already idle: no second broadcast")

    async def test_server_checks_after_esc_input(self):
        import server
        screens = iter([STILL_BUSY, INTERRUPTED])
        capture = type("C", (), {"get_screen": lambda self, sid: next(screens), "get_buffer": lambda self, sid, n: ""})()
        with patch.object(server, "capture_proc", capture), \
                patch.object(server, "_CLAUDE_INTERRUPT_CHECK_DELAYS", (0.0, 0.01, 0.02)), \
                patch.object(server.pty_mgr, "is_alive", lambda sid: True):
            await server._confirm_claude_interrupt_after_input("int-test")
        self.assertEqual(hooks._hook_sessions["int-test"]["state"], "idle")
        self.assertEqual([s["source"] for s in self.states()], ["interrupt_input"])

    async def test_output_check_ignores_idle_or_busy_sessions(self):
        import server
        self.assertFalse(await server._maybe_mark_claude_interrupted("int-test", STILL_BUSY))
        hooks._get_state("int-test")["state"] = "idle"
        self.assertFalse(await server._maybe_mark_claude_interrupted("int-test", INTERRUPTED))
        self.assertEqual(self.states(), [])

    async def test_cancelled_permission_clears_attention_only_after_empty_prompt(self):
        import server
        from session_attention import get_attention, observe_event
        hooks._get_state("int-test")["state"] = "prompting"
        observe_event({"type": "permission_event", "phase": "request", "session_id": "int-test", "tool_name": "submit_result"})
        dialog = "⎿ Interrupted by user\n❯\nDo you want to proceed?\n1. Yes\n2. No\nEsc to cancel"
        self.assertFalse(await server._maybe_mark_claude_interrupted("int-test", dialog))
        self.assertIsNotNone(get_attention("int-test"))
        self.assertTrue(await server._maybe_mark_claude_interrupted("int-test", INTERRUPTED))
        self.assertIsNone(get_attention("int-test"))
        self.assertEqual(hooks.get_session_logical_status("int-test", True, "waiting"), "idle")
        self.assertEqual(len(self.states()), 1)


if __name__ == "__main__":
    unittest.main()
