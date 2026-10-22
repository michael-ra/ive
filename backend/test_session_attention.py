import unittest
from unittest.mock import AsyncMock

import hooks
import session_attention as attention


PROMPT = """Bash command
ls README.md
Hook PreToolUse:Bash requires confirmation for this command:
[Safety Gate] provider 'gemini_api' is not configured: missing API key
Do you want to proceed?
❯ 1. Yes
  2. No
Esc to cancel · Tab to amend"""


class AttentionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.old_broadcast = hooks._broadcast
        self.addCleanup(setattr, hooks, "_broadcast", self.old_broadcast)
        self.addCleanup(hooks.cleanup_session, "attention-test")
        self.sent = AsyncMock()
        hooks.set_broadcast_fn(self.sent)

    async def test_native_permission_survives_snapshot_and_clears_on_work(self):
        await hooks._handle_permission_request("attention-test", {"tool_name": "Bash", "tool_input": {"command": "ls"}})
        self.assertEqual(hooks.get_session_logical_status("attention-test", True, "idle"), "waiting")
        pending = attention.get_attention("attention-test")
        self.assertEqual(pending["tool_name"], "Bash")
        # The question as data: keys, trimmed input, type and time, so a card
        # can offer Allow / Reject without reading the terminal screen.
        self.assertEqual([a["key"] for a in pending["actions"]], ["enter", "escape"])
        self.assertEqual(pending["tool_input"], {"command": "ls"})
        self.assertEqual(pending["notification_type"], "permission_prompt")
        self.assertIsInstance(pending["asked_at"], float)
        self.assertEqual(pending["options"], [])
        self.assertEqual(hooks.get_session_logical_status("attention-test", False, "exited"), "exited")
        await hooks._broadcast({"type": "session_state", "session_id": "attention-test", "state": "working"})
        self.assertIsNone(attention.get_attention("attention-test"))

    async def test_denial_and_cleanup_remove_pending(self):
        await hooks._handle_permission_request("attention-test", {"tool_name": "Bash"})
        await hooks._handle_permission_denied("attention-test", {"tool_name": "Bash", "reason": "No"})
        self.assertIsNone(attention.get_attention("attention-test"))
        self.assertEqual(hooks.get_session_logical_status("attention-test", True, "idle"), "idle")
        attention.observe_terminal("attention-test", PROMPT)
        hooks.cleanup_session("attention-test")
        self.assertIsNone(attention.get_attention("attention-test"))

    def test_details_carry_options_and_trim_tool_input(self):
        found = attention.details({
            "message": "Which project?", "notification_type": "select", "asked_at": 12.5,
            "options": [{"num": 1, "text": "demo-app"}], "actions": [{"label": "Cancel", "key": "escape", "style": "default"}],
            "tool_input": {"file_path": "x.py", "content": "y" * 1000, "extra": {"nested": True}},
        })
        self.assertEqual(found["kind"], "question")
        self.assertEqual(found["options"][0]["text"], "demo-app")
        self.assertEqual(found["actions"][0]["key"], "escape")
        self.assertEqual(found["notification_type"], "select")
        self.assertEqual(found["asked_at"], 12.5)
        self.assertEqual(len(found["tool_input"]["content"]), 240)
        self.assertEqual(found["tool_input"]["extra"], "{'nested': True}")
        terminal = attention.detect_terminal_attention(PROMPT)
        self.assertIsNone(terminal["tool_input"])
        self.assertEqual(terminal["actions"], [])

    def test_current_prompt_reason_and_legacy_spacing(self):
        for text in (PROMPT, PROMPT.replace(" ", "").replace("\n", "")):
            self.assertEqual(attention.detect_terminal_attention(text)["kind"], "configuration")

    def test_answered_scrollback_is_not_a_live_request(self):
        for suffix in ("\nInterrupted · What should Claude do instead?\n❯\nauto mode on", "\nWorking... esc to interrupt", "\n" + "new output " * 80):
            self.assertIsNone(attention.detect_terminal_attention(PROMPT + suffix))
        self.assertTrue(attention.observe_terminal("attention-test", PROMPT))
        self.assertTrue(attention.observe_terminal("attention-test", "❯\nauto mode on"))
        self.assertIsNone(attention.get_attention("attention-test"))

    def test_output_absence_cannot_clear_a_structured_question(self):
        attention.observe_event({"type": "session_state", "state": "prompting", "session_id": "attention-test", "message": "Which project?"})
        attention.observe_terminal("attention-test", "")
        self.assertEqual(attention.get_attention("attention-test")["message"], "Which project?")

    def test_completed_prompt_cannot_reappear_from_an_unchanged_screen(self):
        attention.observe_terminal("attention-test", PROMPT)
        attention.observe_event({"type": "session_state", "session_id": "attention-test", "state": "working"})
        self.assertFalse(attention.observe_terminal("attention-test", PROMPT))
        self.assertIsNone(attention.get_attention("attention-test"))
        attention.observe_terminal("attention-test", "Working...")
        self.assertTrue(attention.observe_terminal("attention-test", PROMPT))


if __name__ == "__main__":
    unittest.main()
