"""Codex rollout detection: lazy rollout files, claimed files, self-heal."""
import asyncio
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import aiosqlite

import server


REAL_SLEEP = asyncio.sleep


def _iso(ts: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(ts))


def _sqlite(ts: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(ts))


class CodexDetectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.db_path = root / "test.db"
        self.sessions_dir = root / "codex" / "sessions"
        (self.sessions_dir / "2026" / "10" / "10").mkdir(parents=True)
        self.workspace = str(root / "ws")
        os.makedirs(self.workspace)

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT)")
            await db.execute(
                "CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT, cli_type TEXT, "
                "native_session_id TEXT, created_at TEXT, status TEXT)")
            await db.execute("INSERT INTO workspaces VALUES ('w1', ?)", (self.workspace,))
            await db.commit()

        async def fake_get_db():
            conn = await aiosqlite.connect(self.db_path)
            conn.row_factory = aiosqlite.Row
            return conn

        for target, value in (
            ("get_db", fake_get_db),
            ("_get_codex_sessions_dirs", lambda: [self.sessions_dir]),
        ):
            patcher = mock.patch.object(server, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        alive = mock.patch.object(server.pty_mgr, "is_alive", lambda sid: True)
        alive.start()
        self.addCleanup(alive.stop)
        self.addCleanup(server._codex_detect_active.clear)
        self.addCleanup(server._native_detect_generation.clear)
        self.addCleanup(server._codex_self_heal_last.clear)

    async def _add_session(self, sid, native=None, created=None):
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "INSERT INTO sessions VALUES (?, 'w1', 'codex', ?, ?, 'running')",
                (sid, native, _sqlite(created or time.time())))
            await db.commit()

    async def _native(self, sid):
        async with aiosqlite.connect(self.db_path) as db:
            cur = await db.execute("SELECT native_session_id FROM sessions WHERE id = ?", (sid,))
            return (await cur.fetchone())[0]

    def _write_rollout(self, rollout_id, ts=None, cwd=None, **meta_extra):
        ts = ts or time.time()
        path = self.sessions_dir / "2026" / "10" / "10" / f"rollout-x-{rollout_id}.jsonl"
        meta = {"type": "session_meta", "payload": {
            "id": rollout_id, "timestamp": _iso(ts), "cwd": cwd or self.workspace, **meta_extra}}
        path.write_text(json.dumps(meta) + "\n")
        return path

    def _patch_sleep(self, on_tick):
        """Replace asyncio.sleep with a simulated clock; on_tick(elapsed) per call."""
        state = {"elapsed": 0.0, "calls": 0}

        async def fake_sleep(delay, *args, **kwargs):
            state["elapsed"] += delay
            state["calls"] += 1
            on_tick(state["elapsed"])
            await REAL_SLEEP(0)

        patcher = mock.patch.object(server._asyncio, "sleep", fake_sleep)
        patcher.start()
        self.addCleanup(patcher.stop)
        return state

    async def test_lazy_rollout_detected_after_fast_window(self):
        await self._add_session("s1")
        pre = server._snapshot_codex_sessions()
        start = time.time()
        created = {}

        def tick(elapsed):
            # Codex writes the rollout only at the first prompt, ~100 s in.
            if elapsed >= 100 and not created:
                created["p"] = self._write_rollout("lazy-1", ts=start + 1)

        state = self._patch_sleep(tick)
        await server.detect_codex_session("s1", self.workspace, pre_existing_files=pre)
        self.assertEqual(await self._native("s1"), "lazy-1")
        self.assertGreater(state["elapsed"], 20)
        self.assertNotIn("s1", server._codex_detect_active)

    async def test_detection_stops_when_pty_gone(self):
        await self._add_session("s1")
        state = self._patch_sleep(lambda elapsed: None)
        with mock.patch.object(server.pty_mgr, "is_alive", lambda sid: False):
            await server.detect_codex_session("s1", self.workspace,
                                              pre_existing_files=server._snapshot_codex_sessions())
        self.assertIsNone(await self._native("s1"))
        self.assertLess(state["elapsed"], 30)

    async def test_claimed_rollout_is_skipped(self):
        await self._add_session("other", native="taken-1")
        await self._add_session("s1")
        pre = server._snapshot_codex_sessions()
        start = time.time()

        def tick(elapsed):
            if elapsed >= 4 and not (self.sessions_dir / "2026/10/10/rollout-x-taken-1.jsonl").exists():
                self._write_rollout("taken-1", ts=start + 1)
            if elapsed >= 40 and not (self.sessions_dir / "2026/10/10/rollout-x-mine-1.jsonl").exists():
                self._write_rollout("mine-1", ts=start + 2)

        self._patch_sleep(tick)
        await server.detect_codex_session("s1", self.workspace, pre_existing_files=pre)
        self.assertEqual(await self._native("s1"), "mine-1")

    async def test_concurrent_detectors_split_by_start_time(self):
        await self._add_session("early")
        await self._add_session("late")
        pre = server._snapshot_codex_sessions()
        now = time.time()
        # "early" started 60 s before "late"; its rollout predates late's start.
        server._codex_detect_active["late"] = (os.path.abspath(self.workspace), now)
        self._write_rollout("late-rollout", ts=now + 10)

        def tick(elapsed):
            if elapsed >= 30 and not (self.sessions_dir / "2026/10/10/rollout-x-early-rollout.jsonl").exists():
                self._write_rollout("early-rollout", ts=now - 50)

        self._patch_sleep(tick)
        with mock.patch.object(server.time, "time", lambda: now - 60):
            task = asyncio.ensure_future(
                server.detect_codex_session("early", self.workspace, pre_existing_files=pre))
            await REAL_SLEEP(0)
        await task
        self.assertEqual(await self._native("early"), "early-rollout")

    async def test_other_workspace_rollout_is_ignored(self):
        await self._add_session("s1")
        pre = server._snapshot_codex_sessions()
        start = time.time()

        def tick(elapsed):
            if elapsed >= 4 and not (self.sessions_dir / "2026/10/10/rollout-x-elsewhere.jsonl").exists():
                self._write_rollout("elsewhere", ts=start + 1, cwd="/somewhere/else")
            if elapsed >= 30 and not (self.sessions_dir / "2026/10/10/rollout-x-here.jsonl").exists():
                self._write_rollout("here", ts=start + 2)

        self._patch_sleep(tick)
        await server.detect_codex_session("s1", self.workspace, pre_existing_files=pre)
        self.assertEqual(await self._native("s1"), "here")

    async def test_self_heal_resolves_lost_detection(self):
        now = time.time()
        await self._add_session("s1", created=now - 600)
        await self._add_session("claimer", native="taken-2", created=now - 900)
        self._write_rollout("before-session", ts=now - 1200)   # older than s1
        self._write_rollout("taken-2", ts=now - 500)           # owned elsewhere
        self._write_rollout("theirs", ts=now - 400, cwd="/other")  # wrong cwd
        self._write_rollout("mine-2", ts=now - 450)

        sess = {"id": "s1", "created_at": _sqlite(now - 600)}
        self.assertEqual(await server._self_heal_codex_native_session(sess, self.workspace), "mine-2")
        self.assertEqual(await self._native("s1"), "mine-2")

    async def test_self_heal_respects_later_unresolved_session(self):
        now = time.time()
        await self._add_session("s1", created=now - 600)
        await self._add_session("s2", created=now - 300)
        self._write_rollout("for-s2", ts=now - 290)  # belongs to the later session

        sess = {"id": "s1", "created_at": _sqlite(now - 600)}
        self.assertIsNone(await server._self_heal_codex_native_session(sess, self.workspace))
        sess2 = {"id": "s2", "created_at": _sqlite(now - 300)}
        self.assertEqual(await server._self_heal_codex_native_session(sess2, self.workspace), "for-s2")

    async def test_self_heal_is_throttled(self):
        now = time.time()
        await self._add_session("s1", created=now - 60)
        sess = {"id": "s1", "created_at": _sqlite(now - 60)}
        self.assertIsNone(await server._self_heal_codex_native_session(sess, self.workspace))
        self._write_rollout("late", ts=now - 30)
        self.assertIsNone(await server._self_heal_codex_native_session(sess, self.workspace))
        server._codex_self_heal_last.clear()
        self.assertEqual(await server._self_heal_codex_native_session(sess, self.workspace), "late")

    async def test_subagent_and_guardian_rollouts_are_skipped(self):
        await self._add_session("s1")
        pre = server._snapshot_codex_sessions()
        start = time.time()

        def tick(elapsed):
            day = self.sessions_dir / "2026/10/10"
            if elapsed >= 4 and not (day / "rollout-x-root-1.jsonl").exists():
                self._write_rollout("root-1", ts=start + 1, session_id="root-1", thread_source="user")
                # Written after the root thread: the newest file in the cwd.
                self._write_rollout("child-1", ts=start + 2, session_id="root-1",
                                    thread_source="subagent", source={"subagent": {}})
                self._write_rollout("guard-1", ts=start + 3, session_id="root-1",
                                    thread_source="guardian_review", source={"subagent": {}})
                for name in ("child-1", "guard-1"):
                    later = time.time() + 5
                    os.utime(day / f"rollout-x-{name}.jsonl", (later, later))

        self._patch_sleep(tick)
        await server.detect_codex_session("s1", self.workspace, pre_existing_files=pre)
        self.assertEqual(await self._native("s1"), "root-1")

    async def test_self_heal_skips_subagent_rollouts(self):
        now = time.time()
        await self._add_session("s1", created=now - 600)
        self._write_rollout("child-2", ts=now - 590, session_id="root-2", thread_source="subagent")
        self._write_rollout("root-2", ts=now - 580, session_id="root-2", thread_source="user")
        sess = {"id": "s1", "created_at": _sqlite(now - 600)}
        self.assertEqual(await server._self_heal_codex_native_session(sess, self.workspace), "root-2")

    def test_root_thread_filter(self):
        root = server._codex_meta_is_root_thread
        self.assertTrue(root({"id": "a", "cwd": "/x"}))  # old rollouts: no fields
        self.assertTrue(root({"id": "a", "session_id": "a", "thread_source": "user", "source": "cli"}))
        self.assertFalse(root({"id": "b", "session_id": "a", "thread_source": "user"}))
        self.assertFalse(root({"id": "a", "session_id": "a", "thread_source": "guardian_review"}))
        self.assertFalse(root({"id": "a", "source": {"subagent": {}}}))


class CodexHistoryNormalizationTests(unittest.TestCase):
    """codex 0.16x rollouts carry user turns only as item_completed UserMessage."""

    def _rows(self, entries):
        from history_adapters import normalize_history_entry
        return [r for r in (normalize_history_entry(e) for e in entries) if r]

    def test_new_shape_user_and_assistant(self):
        entries = [
            {"type": "session_meta", "payload": {"id": "t", "session_id": "t"}},
            {"type": "response_item", "payload": {"type": "message", "role": "developer",
                                                  "content": [{"type": "input_text", "text": "ctx"}]}},
            {"type": "response_item", "payload": {"type": "message", "role": "user",
                                                  "content": [{"type": "input_text", "text": "<environment_context/>"}]}},
            {"type": "event_msg", "payload": {"type": "task_started"}},
            {"type": "response_item", "payload": {"type": "message", "role": "user",
                                                  "content": [{"type": "input_text", "text": "hello"}]}},
            {"type": "event_msg", "payload": {"type": "item_completed", "item": {
                "type": "UserMessage", "id": "u1", "client_id": "c1",
                "content": [{"type": "text", "text": "hello", "text_elements": []}]}}},
            {"type": "response_item", "payload": {"type": "custom_tool_call", "call_id": "c", "name": "exec", "input": "ls"}},
            {"type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "CommandExecution", "id": "x"}}},
            {"type": "response_item", "payload": {"type": "custom_tool_call_output", "call_id": "c", "output": "a"}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant", "phase": "final_answer",
                                                  "content": [{"type": "output_text", "text": "hi there"}]}},
            {"type": "event_msg", "payload": {"type": "item_completed", "item": {
                "type": "AgentMessage", "id": "a1", "content": [{"Text": {"text": "hi there"}}]}}},
            {"type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "Reasoning", "id": "r"}}},
            {"type": "token_usage_record", "payload": {"usage": {}}},
            {"type": "event_msg", "payload": {"type": "task_complete"}},
        ]
        rows = self._rows(entries)
        self.assertEqual([r[0] for r in rows], ["user", "assistant", "tool_result", "assistant"])
        self.assertEqual(rows[0], ("user", "hello"))
        self.assertEqual(sum(1 for r in rows if r[0] == "user"), 1)

    def test_old_shape_user_message_still_supported(self):
        rows = self._rows([
            {"type": "event_msg", "payload": {"type": "user_message", "message": "old prompt"}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant",
                                                  "content": [{"type": "output_text", "text": "ok"}]}},
        ])
        self.assertEqual([r[0] for r in rows], ["user", "assistant"])
        self.assertEqual(rows[0][1], "old prompt")

    def test_claude_is_meta_rows_dropped(self):
        rows = self._rows([
            {"type": "user", "isMeta": True, "message": {"role": "user", "content": "<local-command-caveat>x"}},
            {"type": "user", "message": {"role": "user", "content": "real prompt"}},
        ])
        self.assertEqual(rows, [("user", "real prompt")])


class TranscriptListNormalizationTests(unittest.TestCase):
    def _rows(self, entries):
        from history_adapters import normalize_history_entries
        return [(role, content) for _, role, content in normalize_history_entries(entries)]

    @staticmethod
    def _ri_user(text):
        return {"type": "response_item", "payload": {"type": "message", "role": "user",
                                                     "content": [{"type": "input_text", "text": text}]}}

    @staticmethod
    def _um(text):
        return {"type": "event_msg", "payload": {"type": "item_completed", "item": {
            "type": "UserMessage", "content": [{"type": "text", "text": text}]}}}

    @staticmethod
    def _asst(text):
        return {"type": "response_item", "payload": {"type": "message", "role": "assistant",
                                                     "content": [{"type": "output_text", "text": text}]}}

    def test_event_user_wins_over_response_item_user(self):
        rows = self._rows([self._ri_user("<environment_context>x</environment_context>"),
                           self._ri_user("hi"), self._um("hi"), self._asst("yo")])
        self.assertEqual(rows, [("user", "hi"), ("assistant", [{"type": "text", "text": "yo"}])])

    def test_response_item_user_fallback_skips_injected_context(self):
        rows = self._rows([
            self._ri_user("# AGENTS.md instructions for /x\n\nbe nice"),
            self._ri_user("<environment_context>\n<cwd>/x</cwd>\n</environment_context>"),
            self._ri_user("<user_instructions>u</user_instructions>"),
            self._ri_user("real prompt"),
            self._asst("ok"),
        ])
        self.assertEqual([r[0] for r in rows], ["user", "assistant"])
        self.assertEqual(rows[0][1], "real prompt")

    def test_old_and_new_event_shapes_collapse_but_repeats_stay(self):
        old = {"type": "event_msg", "payload": {"type": "user_message", "message": "same"}}
        rows = self._rows([old, self._um("same"), self._asst("a")])
        self.assertEqual([r[0] for r in rows], ["user", "assistant"])
        # A prompt really sent twice (interrupted turn) keeps both rows.
        rows = self._rows([self._um("again"), self._um("again"), self._asst("a")])
        self.assertEqual([r[0] for r in rows], ["user", "user", "assistant"])

    def test_claude_slash_command_rows(self):
        from history_adapters import normalize_history_entry
        cmd = {"type": "user", "message": {"role": "user", "content":
               "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"}}
        self.assertEqual(normalize_history_entry(cmd), ("user", [{"type": "command", "name": "/clear"}]))
        model = {"type": "user", "message": {"role": "user", "content":
                 "<local-command-caveat>Caveat</local-command-caveat><command-name>/model</command-name>"
                 "<command-message>model</command-message><command-args>opus</command-args>"}}
        self.assertEqual(normalize_history_entry(model),
                         ("user", [{"type": "command", "name": "/model", "args": "opus"}]))
        for noise in ("<local-command-stdout>Set model to opus</local-command-stdout>",
                      "<local-command-caveat>Caveat: ...</local-command-caveat>",
                      "<local-command-stdout></local-command-stdout>"):
            self.assertIsNone(normalize_history_entry(
                {"type": "user", "message": {"role": "user", "content": noise}}), noise)
        plain = {"type": "user", "message": {"role": "user", "content": "explain <command-name> tags"}}
        self.assertEqual(normalize_history_entry(plain)[0], "user")


class CodexPermissionArgsTests(unittest.TestCase):
    """codex-cli 0.162 accepts only -a on-request|never and three sandboxes."""

    def test_every_mode_maps_to_valid_flags(self):
        from cli_profiles import CODEX_PERMISSION_MODES, _codex_permission_args
        for mode in CODEX_PERMISSION_MODES:
            args = _codex_permission_args(mode) or []
            for flag, allowed in (("--ask-for-approval", {"on-request", "never"}),
                                  ("--sandbox", {"read-only", "workspace-write", "danger-full-access"})):
                if flag in args:
                    self.assertIn(args[args.index(flag) + 1], allowed, mode)
        self.assertEqual(_codex_permission_args("plan"),
                         ["--sandbox", "read-only", "--ask-for-approval", "on-request"])
        self.assertIsNone(_codex_permission_args("default"))

    def test_unknown_modes_are_not_passed_raw(self):
        from cli_profiles import _codex_permission_args
        for mode in ("untrusted", "on-failure", "yolo", "auto_edit", "nonsense"):
            self.assertIsNone(_codex_permission_args(mode), mode)

    def test_profile_validation(self):
        from cli_profiles import get_profile, permission_mode_valid_for_profile
        codex, claude = get_profile("codex"), get_profile("claude")
        for mode in ("default", "plan", "auto", "acceptEdits", "dontAsk", "bypassPermissions", "", None):
            self.assertTrue(permission_mode_valid_for_profile(codex, mode), mode)
        for mode in ("untrusted", "on-failure", "yolo"):
            self.assertFalse(permission_mode_valid_for_profile(codex, mode), mode)
        self.assertTrue(permission_mode_valid_for_profile(claude, "plan"))
        self.assertFalse(permission_mode_valid_for_profile(claude, "read-only"))
        self.assertIsNotNone(server._permission_mode_error(codex, "untrusted"))
        self.assertIsNone(server._permission_mode_error(codex, "plan"))


if __name__ == "__main__":
    unittest.main()
