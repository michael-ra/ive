"""Startup-blocker detection: tight patterns, visible screen only. Never starts a server."""
import ast
import re
import unittest
from pathlib import Path


def _load(**deps):
    tree = ast.parse(Path(__file__).with_name("server.py").read_text())
    names = {"_compact_cli_text", "_detect_cli_startup_blocker", "_has_codex_update_prompt_text",
             "_startup_blocker_text", "_is_startup_control_input",
             "_has_codex_trust_prompt_text", "_codex_composer_ready", "_looks_ready_for_input",
             "_looks_codex_busy", "_trust_prompt_selection", "_strip_pty_control_bytes"}
    body = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    body += [n for n in tree.body if isinstance(n, ast.Assign)
             and any(getattr(t, "id", "") in {"_AUTH_BLOCKER_TYPES", "_STARTUP_BLOCKER_FALLBACK_LINES",
                                         "_CODEX_MENU_CURSOR_RE"} for t in n.targets)]
    ns = {"re": re, **deps}
    exec(compile(ast.Module(body=body, type_ignores=[]), "server.py", "exec"), ns)
    return ns


class FakeCapture:
    def __init__(self, screen="", buffer=""):
        self.screen, self.buffer, self.requested = screen, buffer, None

    def get_screen(self, session_id):
        return self.screen

    def get_buffer(self, session_id, lines=100):
        self.requested = lines
        return "\n".join(self.buffer.split("\n")[-lines:])


class StartupBlockerTests(unittest.TestCase):
    def setUp(self):
        self.ns = _load()
        self.detect = self.ns["_detect_cli_startup_blocker"]

    def test_codex_ordinary_login_text_is_not_a_blocker(self):
        for text in (
            "Added a Login button to the header.",
            "• Edited src/auth/login.tsx (+12 -3)\n› ",
            "Users can now sign in with Google.",
            "not authenticated: the test returns 401 as expected",
        ):
            self.assertIsNone(self.detect("codex", text), text)

    def test_codex_real_sign_in_screen_is_detected(self):
        screen = "Welcome to Codex\n> 1. Sign in with ChatGPT\n  2. Provide your own API key\n"
        self.assertEqual(self.detect("codex", screen)["type"], "auth_required")
        self.assertEqual(self.detect("codex", "Your access token could not be refreshed.")["type"], "auth_error")

    def test_claude_bare_401_in_test_output_is_not_a_blocker(self):
        for text in (
            "FAIL api.test.ts\n  expected 200, got API Error: 401",
            "Implemented the login expired banner",
        ):
            self.assertIsNone(self.detect("claude", text), text)

    def test_claude_real_auth_errors_are_detected(self):
        real = 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login'
        self.assertEqual(self.detect("claude", real)["type"], "auth_error")
        self.assertEqual(self.detect("claude", "Select login method:\n 1. Claude account with subscription")["type"], "auth_required")

    def test_scan_uses_visible_screen_not_scrollback(self):
        capture = FakeCapture(screen="› ready", buffer="Sign in with ChatGPT\n" + "x\n" * 300)
        ns = _load(capture_proc=capture)
        text = ns["_startup_blocker_text"]("s1")
        self.assertEqual(text, "› ready")
        self.assertIsNone(ns["_detect_cli_startup_blocker"]("codex", text))

    def test_without_screen_only_about_one_screen_of_output_is_scanned(self):
        old = "1. Sign in with ChatGPT\n" + "\n".join(f"line {i}" for i in range(200))
        capture = FakeCapture(screen="", buffer=old)
        ns = _load(capture_proc=capture)
        text = ns["_startup_blocker_text"]("s1")
        self.assertEqual(capture.requested, ns["_STARTUP_BLOCKER_FALLBACK_LINES"])
        self.assertIsNone(ns["_detect_cli_startup_blocker"]("codex", text))

    def test_auth_blockers_are_notice_only_types(self):
        self.assertEqual(self.ns["_AUTH_BLOCKER_TYPES"], frozenset({"auth_required", "auth_error"}))

    def test_ws_input_path_never_drops_input_for_auth_blockers(self):
        src = Path(__file__).with_name("server.py").read_text()
        start = src.index("startup_blocker = _detect_cli_startup_blocker(\n                            cli_type,\n                            _startup_blocker_text(session_id),")
        segment = src[start:start + 1500]
        auth = segment.index('in _AUTH_BLOCKER_TYPES')
        reset = segment.index("startup_blocker = None", auth)
        self.assertNotIn("continue", segment[auth:reset])
        send = src[src.index("async def send_session_input"):]
        send = send[:send.index("\nasync def ", 1)]
        self.assertIn("_startup_blocker_text(session_id)", send)
        self.assertNotIn("get_buffer(session_id, 160)", send)


CODEX_TRUST_SCREEN = (
    ">_ OpenAI Codex (v0.162.1)\n\n"
    "Trust this folder? Codex can read, edit, and run files here, subject to your\n"
    "permission settings. Your trust decision will be saved.\n\n"
    "› 1. Trust and continue\n"
    "  2. Open restricted\n"
)


class CodexTrustPromptTests(unittest.TestCase):
    def setUp(self):
        self.ns = _load()
        self.detect = self.ns["_detect_cli_startup_blocker"]
        self.ready = self.ns["_looks_ready_for_input"]

    def test_trust_menu_is_a_blocker_and_not_ready(self):
        self.assertEqual(self.detect("codex", CODEX_TRUST_SCREEN)["type"], "trust_required")
        # The "›" menu cursor must not be read as Codex's input line.
        self.assertFalse(self.ready("codex", CODEX_TRUST_SCREEN))

    def test_composer_after_accepting_trust_is_ready(self):
        after = CODEX_TRUST_SCREEN + "\nmodel: gpt-6-astra   directory: /x\n› "
        self.assertIsNone(self.detect("codex", after))
        self.assertTrue(self.ready("codex", after))

    def test_approval_menu_cursor_is_not_ready(self):
        screen = "• Working\nWould you like to run the following command?\n  $ rm -rf build\n› 1. Yes, proceed (y)\n  2. No\n"
        self.assertFalse(self.ready("codex", screen))
        self.assertTrue(self.ready("codex", screen + "✔ Ran rm -rf build\n› "))

    def test_plain_composer_is_ready(self):
        self.assertTrue(self.ready("codex", ">_ OpenAI Codex\n› "))
        self.assertTrue(self.ready("codex", "› Explain this codebase"))

    def test_trust_patterns_cover_codex(self):
        src = Path(__file__).with_name("server.py").read_text()
        start = src.index("_TRUST_PATTERNS = [")
        block = src[start:src.index("\n]\n", start)]
        self.assertIn('b"Trust and continue"', block)
        self.assertIn('b"Trustandcontinue"', block)


if __name__ == "__main__":
    unittest.main()
