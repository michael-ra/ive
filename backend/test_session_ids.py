"""Native session id handling: Claude project-dir slug, /clear vs /branch,
account homes in transcript search, file-based Claude detection guards."""
import asyncio
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import aiosqlite

import hooks
import server
from ive_cli_profile import claude_project_dirname, claude_project_dirnames


REAL_SLEEP = asyncio.sleep


async def _fast_sleep(_delay, *args, **kwargs):
    await REAL_SLEEP(0)


def _iso(ts: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(ts))


class ClaudeProjectDirnameTests(unittest.TestCase):
    def test_every_non_alphanumeric_becomes_dash(self):
        cases = {
            "/Users/x/Projects/acme/site.dev": "-Users-x-Projects-acme-site-dev",
            "/Users/x/project_orbit-main": "-Users-x-project-orbit-main",
            "/Users/x/work desktop": "-Users-x-work-desktop",
            "/Users/x/Grünzeug": "-Users-x-Gr-nzeug",
            "/Users/x/.claude/projects": "-Users-x--claude-projects",
            "/tmp/a\U0001F600b": "-tmp-a--b",  # non-BMP = two UTF-16 units
        }
        for path, expected in cases.items():
            self.assertEqual(claude_project_dirname(path), expected, path)

    def test_long_path_truncated_with_djb2_hash(self):
        # Expected value computed with Claude 2.1.296's own JS (sanitizePath:
        # slice(0,200) + "-" + Math.abs(djb2(raw)).toString(36)) under node.
        path = "/Users/x/" + "very-long_dir.name/" * 12 + "\u00e4\U0001F600end"
        expected = ("-Users-x-" + "very-long-dir-name-" * 11 + "v")[:200] + "-v09au9"
        self.assertEqual(claude_project_dirname(path), expected)
        self.assertEqual(len(claude_project_dirname("/" + "a" * 199)), 200)
        self.assertEqual(claude_project_dirname("/" + "a" * 199), "-" + "a" * 199)
        self.assertTrue(claude_project_dirname("/" + "a" * 200).startswith("-" + "a" * 199 + "-"))

    def test_long_path_found_by_transcript_cwd(self):
        from ive_cli_profile import claude_long_project_dirs
        workspace = "/nonexistent-ive-test/" + "deep-folder/" * 20 + "ws"
        prefix = claude_project_dirname(workspace)[:200]
        with tempfile.TemporaryDirectory() as tmp:
            projects = Path(tmp)
            own = projects / f"{prefix}-otherhash"
            own.mkdir()
            (own / "s.jsonl").write_text(
                json.dumps({"type": "queue-operation"}) + "\n"
                + json.dumps({"type": "user", "cwd": workspace}) + "\n")
            foreign = projects / f"{prefix}-zzz"
            foreign.mkdir()
            (foreign / "t.jsonl").write_text(json.dumps({"cwd": workspace + "2"}) + "\n")
            self.assertEqual(claude_long_project_dirs(projects, workspace), [own])
            self.assertEqual(claude_long_project_dirs(projects, "/short/ws"), [])

    def test_history_reader_uses_transcript_cwd(self):
        import history_reader
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            proj = home / "projects" / "-Users-x-my-app-v2"
            proj.mkdir(parents=True)
            (proj / "s1.jsonl").write_text(
                json.dumps({"type": "user", "cwd": "/Users/x/my_app.v2"}) + "\n")
            bare = home / "projects" / "-Users-x-legacy"
            bare.mkdir()
            (bare / "s2.jsonl").write_text(json.dumps({"type": "ai-title"}) + "\n")
            with mock.patch.object(history_reader, "CLAUDE_HOME", home):
                got = {p["dir_name"]: p["project_path"]
                       for p in history_reader._list_claude_projects()}
        self.assertEqual(got["-Users-x-my-app-v2"], "/Users/x/my_app.v2")
        self.assertEqual(got["-Users-x-legacy"], "/Users/x/legacy")

    def test_candidates_keep_legacy_name_last(self):
        names = claude_project_dirnames("/nonexistent-ive-test/ive.dev")
        self.assertEqual(names[0], "-nonexistent-ive-test-ive-dev")
        self.assertEqual(names[-1], "-nonexistent-ive-test-ive.dev")

    def test_candidates_include_realpath(self):
        with tempfile.TemporaryDirectory() as tmp:
            real = Path(tmp) / "real_dir"
            real.mkdir()
            link = Path(tmp) / "link"
            link.symlink_to(real)
            names = claude_project_dirnames(str(link))
            self.assertIn(claude_project_dirname(os.path.realpath(link)), names)

    def test_memory_sync_uses_claude_name(self):
        from cli_profiles import get_profile
        from memory_sync import MemoryProvider
        provider = MemoryProvider(get_profile("claude"))
        ws = "/nonexistent-ive-test/my_ws.v2"
        default = provider._auto_memory_native_default(ws)
        self.assertEqual(default.parent.name, "-nonexistent-ive-test-my-ws-v2")
        candidates = provider._auto_memory_read_candidates(ws)
        names = [c.parent.name for c in candidates[1:]]
        self.assertEqual(names[0], "-nonexistent-ive-test-my-ws-v2")
        self.assertIn("-nonexistent-ive-test-my_ws.v2", names)


class TranscriptSearchTests(unittest.TestCase):
    """Slug fallback plus account homes in the Claude/Codex search roots."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.host_home = root / "host"
        self.account_homes = root / "account_homes"
        self.account_homes.mkdir()
        self.workspace = "/Users/x/Projects/acme/site.dev"
        for target, value in (
            ("candidate_data_dirs", lambda cli: [server.cli_data_dir(cli, self.host_home)]),
            ("ACCOUNT_HOMES_DIR", self.account_homes),
        ):
            patcher = mock.patch.object(server, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _claude_transcript(self, home: Path, name: str, sid: str) -> Path:
        path = home / ".claude" / "projects" / name / f"{sid}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"type": "user", "sessionId": sid}) + "\n")
        return path

    def test_transcript_found_under_claude_name(self):
        path = self._claude_transcript(self.host_home, claude_project_dirname(self.workspace), "s1")
        self.assertEqual(server._get_native_transcript_path("claude", self.workspace, "s1"), path)

    def test_transcript_found_under_legacy_name(self):
        path = self._claude_transcript(self.host_home, self.workspace.replace("/", "-"), "s2")
        self.assertEqual(server._get_native_transcript_path("claude", self.workspace, "s2"), path)

    def test_resume_mirrors_legacy_dir_into_claude_name(self):
        self._claude_transcript(self.host_home, self.workspace.replace("/", "-"), "s3")
        self.assertTrue(server._ensure_claude_resume_files("s3", self.workspace, str(self.host_home)))
        target = (self.host_home / ".claude" / "projects"
                  / claude_project_dirname(self.workspace) / "s3.jsonl")
        self.assertTrue(target.exists())

    def test_claude_resume_after_account_switch(self):
        acc_a = self.account_homes / "accA"
        acc_b = self.account_homes / "accB"
        acc_b.mkdir()
        self._claude_transcript(acc_a, claude_project_dirname(self.workspace), "sid1")
        self.assertTrue(server._ensure_claude_resume_files("sid1", self.workspace, str(acc_a)))
        self.assertTrue(server._ensure_claude_resume_files("sid1", self.workspace, str(acc_b)))
        self.assertEqual(
            server._get_native_transcript_path("claude", self.workspace, "sid1", cli_home=acc_b).parent.parent.parent.parent,
            acc_b,
        )

    def test_codex_rollout_in_account_home(self):
        rollout = (self.account_homes / "acct1" / ".codex" / "sessions" / "2026" / "10" / "10"
                   / "rollout-2026-10-10T10-00-00-abc123.jsonl")
        rollout.parent.mkdir(parents=True)
        rollout.write_text(json.dumps({"type": "session_meta", "payload": {"id": "abc123"}}) + "\n")
        self.assertEqual(server._find_codex_session_file("abc123"), rollout)
        self.assertIn(str(rollout), server._snapshot_codex_sessions())
        self.assertEqual(server._get_native_transcript_path("codex", self.workspace, "abc123"), rollout)
        default_codex = self.host_home / ".codex"
        self.assertTrue(server._ensure_codex_resume_files("abc123", None, str(default_codex)))
        self.assertTrue((default_codex / "sessions" / "2026" / "10" / "10" / rollout.name).exists())

    def test_gemini_uuid_resolves_to_file_stem(self):
        chats = Path(self.tmp.name) / "chats"
        chats.mkdir()
        (chats / "session-2026-10-10T10-00-aaaa.json").write_text(
            json.dumps({"sessionId": "11111111-2222", "messages": []}))
        with mock.patch.object(server, "_get_gemini_chats_dir", lambda ws: chats):
            self.assertEqual(server._resolve_gemini_native_id("/ws", "11111111-2222"),
                             "session-2026-10-10T10-00-aaaa")
            self.assertIsNone(server._resolve_gemini_native_id("/ws", "missing"))


class _DbCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.db_path = root / "test.db"
        self.workspace = str(root / "my_ws.v2")
        os.makedirs(self.workspace)
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT)")
            await db.execute(
                "CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT, cli_type TEXT, "
                "native_session_id TEXT, name TEXT, native_slug TEXT)")
            await db.execute("INSERT INTO workspaces VALUES ('w1', ?)", (self.workspace,))
            await db.commit()

        async def fake_get_db():
            conn = await aiosqlite.connect(self.db_path)
            conn.row_factory = aiosqlite.Row
            return conn

        self.fake_get_db = fake_get_db
        import db as db_module
        for module in (server, db_module):
            patcher = mock.patch.object(module, "get_db", fake_get_db)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(hooks._native_id_cache.clear)
        self.addCleanup(hooks._tentative_native_ids.clear)

    async def _add_session(self, sid, native=None, cli="claude", name="Session 1"):
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("INSERT INTO sessions VALUES (?, 'w1', ?, ?, ?, NULL)",
                             (sid, cli, native, name))
            await db.commit()

    async def _row(self, sid):
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (sid,))
            row = await cur.fetchone()
            return dict(row) if row else None


class HookPointerTests(_DbCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.open_tab = mock.AsyncMock()
        patcher = mock.patch.object(server, "_open_original_as_tab", self.open_tab)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def _hook(self, sid, event, native, **extra):
        await hooks._maybe_capture_native_id(
            sid, {"hook_event_name": event, "session_id": native, **extra})

    async def test_clear_replaces_pointer_without_branch(self):
        await self._add_session("A")
        await self._hook("A", "SessionStart", "old", source="startup")
        await self._hook("A", "UserPromptSubmit", "old")
        await self._hook("A", "SessionStart", "new", source="clear")
        await self._hook("A", "UserPromptSubmit", "new")
        self.open_tab.assert_not_awaited()
        self.assertEqual((await self._row("A"))["native_session_id"], "new")

    async def test_startup_and_compact_replace_pointer(self):
        await self._add_session("A", native="stale")
        await self._hook("A", "SessionStart", "fresh", source="startup")
        await self._hook("A", "SessionStart", "compacted", source="compact")
        self.open_tab.assert_not_awaited()
        self.assertEqual((await self._row("A"))["native_session_id"], "compacted")

    async def test_resume_with_new_id_is_branch(self):
        await self._add_session("A", native="orig")
        await self._hook("A", "SessionStart", "branched", source="resume")
        self.open_tab.assert_awaited_once_with("A", "orig")
        self.assertEqual((await self._row("A"))["native_session_id"], "branched")

    async def test_id_change_without_session_start_is_still_branch(self):
        await self._add_session("A", native="orig")
        await self._hook("A", "UserPromptSubmit", "other")
        self.open_tab.assert_awaited_once_with("A", "orig")

    async def test_tentative_file_guess_is_replaced_silently(self):
        await self._add_session("A", native="guess")
        hooks.mark_tentative_native_id("A", "guess")
        await self._hook("A", "UserPromptSubmit", "real")
        self.open_tab.assert_not_awaited()
        self.assertEqual((await self._row("A"))["native_session_id"], "real")
        self.assertNotIn("A", hooks._tentative_native_ids)

    async def test_gemini_hook_stores_file_stem(self):
        await self._add_session("G", cli="gemini")
        with mock.patch.object(server, "_resolve_gemini_native_id", lambda ws, sid: None):
            await self._hook("G", "SessionStart", "uuid-1", source="startup")
        self.assertIsNone((await self._row("G"))["native_session_id"])
        with mock.patch.object(server, "_resolve_gemini_native_id",
                               lambda ws, sid: "session-2026-x" if sid == "uuid-1" else None):
            await self._hook("G", "BeforeAgent", "uuid-1")
        self.assertEqual((await self._row("G"))["native_session_id"], "session-2026-x")
        self.open_tab.assert_not_awaited()

    def _file(self, name, *records):
        path = Path(self.tmp.name) / name
        path.write_text("".join(json.dumps(r) + "\n" for r in records))
        return str(path)

    async def test_claude_tui_resume_of_other_conversation_replaces(self):
        # /resume <older conversation> inside the TUI: SessionStart(resume)
        # with an id whose transcript was not branched from the current one.
        await self._add_session("A", native="orig")
        path = self._file("older.jsonl", {"type": "user", "sessionId": "older"})
        await self._hook("A", "SessionStart", "older", source="resume", transcript_path=path)
        self.open_tab.assert_not_awaited()
        self.assertEqual((await self._row("A"))["native_session_id"], "older")

    async def test_claude_branch_detected_from_forked_from(self):
        await self._add_session("A", native="orig")
        path = self._file("branched.jsonl",
                          {"type": "user", "sessionId": "branched",
                           "forkedFrom": {"sessionId": "orig", "messageUuid": "m1"}})
        await self._hook("A", "SessionStart", "branched", source="resume", transcript_path=path)
        self.open_tab.assert_awaited_once_with("A", "orig")

    async def test_codex_new_thread_replaces_without_branch(self):
        await self._add_session("C", native="thread-1", cli="codex")
        await self._hook("C", "SessionStart", "thread-2", source="clear", transcript_path=None)
        self.open_tab.assert_not_awaited()
        self.assertEqual((await self._row("C"))["native_session_id"], "thread-2")

    async def test_codex_fork_is_branch(self):
        await self._add_session("C", native="thread-1", cli="codex")
        await self._hook("C", "SessionStart", "thread-f", source="fork", transcript_path=None)
        self.open_tab.assert_awaited_once_with("C", "thread-1")

    async def test_codex_subagent_thread_is_ignored(self):
        await self._add_session("C", native="root-1", cli="codex")
        path = self._file("rollout-x-child-1.jsonl", {"type": "session_meta", "payload": {
            "id": "child-1", "session_id": "root-1", "thread_source": "subagent"}})
        await self._hook("C", "PreToolUse", "child-1", transcript_path=path)
        self.open_tab.assert_not_awaited()
        self.assertEqual((await self._row("C"))["native_session_id"], "root-1")
        # Also never bound on first contact.
        await self._add_session("D", cli="codex", name="Session 2")
        await self._hook("D", "PreToolUse", "child-1", transcript_path=path)
        self.assertIsNone((await self._row("D"))["native_session_id"])

    async def test_codex_new_root_without_session_start_replaces(self):
        await self._add_session("C", native="root-1", cli="codex")
        path = self._file("rollout-x-root-2.jsonl", {"type": "session_meta", "payload": {
            "id": "root-2", "session_id": "root-2", "thread_source": "user"}})
        with mock.patch.object(server, "_get_native_transcript_path", lambda *a, **k: None):
            await self._hook("C", "UserPromptSubmit", "root-3", transcript_path=None)
        self.assertEqual((await self._row("C"))["native_session_id"], "root-1")  # retry later
        await self._hook("C", "UserPromptSubmit", "root-2", transcript_path=path)
        self.open_tab.assert_not_awaited()
        self.assertEqual((await self._row("C"))["native_session_id"], "root-2")

    def test_claude_relay_includes_session_start(self):
        import hook_installer
        self.assertIn("SessionStart", hook_installer.CLAUDE_HOOK_EVENTS)
        self.assertIn("SessionStart", hook_installer.CODEX_HOOK_EVENTS)


class ClaudeFileDetectionTests(_DbCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.home = Path(self.tmp.name) / "home"
        self.project_dir = (self.home / ".claude" / "projects"
                            / claude_project_dirname(self.workspace))
        self.project_dir.mkdir(parents=True)
        for target, value in (
            ("candidate_data_dirs", lambda cli: [server.cli_data_dir(cli, self.home)]),
            ("ACCOUNT_HOMES_DIR", Path(self.tmp.name) / "no_accounts"),
            ("broadcast", mock.AsyncMock()),
        ):
            patcher = mock.patch.object(server, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        sleeper = mock.patch.object(server._asyncio, "sleep", _fast_sleep)
        sleeper.start()
        self.addCleanup(sleeper.stop)

    def _transcript(self, sid, ts):
        path = self.project_dir / f"{sid}.jsonl"
        path.write_text(json.dumps({"type": "user", "sessionId": sid, "timestamp": _iso(ts)}) + "\n"
                        + json.dumps({"slug": f"slug-{sid}"}) + "\n")
        return path

    async def _detect(self, sid, pre, started_at):
        await server.detect_claude_session(
            sid, self.workspace, pre_existing_files=pre, started_at=started_at)

    async def test_replacement_launch_invalidates_old_detector(self):
        await self._add_session("A")
        start = time.time()
        pre = server._snapshot_jsonl_files(self.workspace)
        self._transcript("exited-launch", start + 1)
        async def replacement_launch(_delay):
            server._begin_native_detection("A")
            await REAL_SLEEP(0)
        with mock.patch.object(server._asyncio, "sleep", replacement_launch):
            await self._detect("A", pre, start)
        self.assertIsNone((await self._row("A"))["native_session_id"])

    async def test_new_file_is_claimed_and_tentative(self):
        await self._add_session("A")
        start = time.time()
        pre = server._snapshot_jsonl_files(self.workspace)
        self._transcript("conv-a", start + 1)
        await self._detect("A", pre, start)
        row = await self._row("A")
        self.assertEqual(row["native_session_id"], "conv-a")
        self.assertEqual(row["name"], "slug-conv-a")
        self.assertEqual(hooks._tentative_native_ids.get("A"), "conv-a")

    async def test_hook_set_id_is_never_overwritten(self):
        await self._add_session("A", native="hook-id")
        start = time.time()
        pre = server._snapshot_jsonl_files(self.workspace)
        self._transcript("someone-else", start + 1)
        await self._detect("A", pre, start)
        self.assertEqual((await self._row("A"))["native_session_id"], "hook-id")

    async def test_file_owned_by_other_session_is_ignored(self):
        await self._add_session("A")
        await self._add_session("B", native="conv-b")
        start = time.time()
        pre = server._snapshot_jsonl_files(self.workspace)
        self._transcript("conv-b", start + 1)
        await self._detect("A", pre, start)
        self.assertIsNone((await self._row("A"))["native_session_id"])

    async def test_conversation_older_than_pty_is_ignored(self):
        await self._add_session("A")
        start = time.time()
        pre = server._snapshot_jsonl_files(self.workspace)
        self._transcript("terminal-claude", start - 600)  # resumed terminal convo
        await self._detect("A", pre, start)
        self.assertIsNone((await self._row("A"))["native_session_id"])


if __name__ == "__main__":
    unittest.main()


class SystemPromptSnapshotTests(unittest.TestCase):
    def setUp(self):
        import cli_session
        self.cli_session = cli_session
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        cli_session._SNAPSHOT_SUPPORT_CACHE.clear()
        env = mock.patch.dict(os.environ, {"IVE_CLAUDE_FRESH_SYSTEM_PROMPT": "1"})
        env.start()
        self.addCleanup(env.stop)

    def _fake_claude(self, text: str) -> str:
        path = Path(self.tmp.name) / "claude"
        path.write_text("#!/bin/sh\n# " + text + "\n")
        path.chmod(0o755)
        return str(path)

    def _argv(self, binary: str, **cfg) -> list[str]:
        sess = self.cli_session.UnifiedSession("claude", cfg)
        with mock.patch.object(sess, "_resolved_binary", return_value=binary):
            return sess.build_command()

    def test_resume_with_fresh_context_disables_snapshot(self):
        binary = self._fake_claude('"--system-prompt-snapshot <on|off>"')
        argv = self._argv(binary, resume_id="abc", append_system_prompt="ctx")
        i = argv.index("--system-prompt-snapshot")
        self.assertEqual(argv[i + 1], "off")

    def test_no_flag_without_resume_or_context(self):
        binary = self._fake_claude('"--system-prompt-snapshot <on|off>"')
        self.assertNotIn("--system-prompt-snapshot", self._argv(binary, append_system_prompt="ctx"))
        self.assertNotIn("--system-prompt-snapshot", self._argv(binary, resume_id="abc"))

    def test_default_keeps_claude_snapshot(self):
        binary = self._fake_claude('"--system-prompt-snapshot <on|off>"')
        with mock.patch.dict(os.environ, {"IVE_CLAUDE_FRESH_SYSTEM_PROMPT": ""}):
            argv = self._argv(binary, resume_id="abc", append_system_prompt="ctx")
        self.assertNotIn("--system-prompt-snapshot", argv)

    def test_old_binary_without_flag_is_left_alone(self):
        binary = self._fake_claude("an older claude")
        argv = self._argv(binary, resume_id="abc", append_system_prompt="ctx")
        self.assertNotIn("--system-prompt-snapshot", argv)
