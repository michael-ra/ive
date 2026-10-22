"""Usage regressions with SQLite fixtures and intercepted provider calls."""
import asyncio
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import aiosqlite
import background_ai


class BackgroundAITests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name) / "test.db")
        self.db = await self.connect()
        self.addAsyncCleanup(self.db.close)
        await self.db.executescript("""
            CREATE TABLE app_settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
            CREATE TABLE workspaces(id TEXT PRIMARY KEY, path TEXT, orchestration_policy TEXT,
                                    inherit_orchestration_policy_from TEXT);
            CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, cli_type TEXT,
                model TEXT, native_session_id TEXT, session_type TEXT, worktree INTEGER, summary TEXT);
            CREATE TABLE session_digests(session_id TEXT, task_summary TEXT);
            INSERT INTO workspaces VALUES('ws','/test','{}',NULL);
            INSERT INTO sessions VALUES('s','ws','Session 1','claude','sonnet','native','worker',0,NULL);
            INSERT INTO sessions VALUES('s2','ws','Session 2','codex','default','native2','worker',0,NULL);
            INSERT INTO sessions VALUES('s3','ws','Session 3','claude','sonnet','native3','worker',0,NULL);
        """)
        await background_ai.initialize(self.db)
        await self.db.execute("ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'idle'")
        await self.db.commit()
        mock_db = patch.object(background_ai, "get_db", self.connect)
        mock_db.start(); self.addCleanup(mock_db.stop)

    async def connect(self):
        db = await aiosqlite.connect(self.path)
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA foreign_keys=ON")
        return db

    async def setting(self, key, value="on"):
        await self.db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,?)", (key, value))
        await self.db.commit()

    async def age_jobs(self, seconds):
        await self.db.execute("UPDATE automatic_ai_jobs SET started_at = started_at - ?", (seconds,))
        await self.db.execute("UPDATE automatic_ai_budget SET started_at = started_at - ?", (seconds,))
        await self.db.commit()

    async def test_no_provider_calls_without_opt_in(self):
        with patch("llm_router.call_json", AsyncMock()) as provider:
            for kind in background_ai.SETTINGS:
                self.assertIsNone(await background_ai.call_json(kind, "s", "claude:sonnet", "hello"))
            provider.assert_not_awaited()

    async def test_prompt_budget_counts_system_and_prompt_before_provider(self):
        await self.setting("automatic_session_summaries")
        with patch("llm_router.call_json", AsyncMock()) as provider:
            self.assertIsNone(await background_ai.call_json("summary", "s", "claude:sonnet", "x" * 11900, system="y" * 200))
            provider.assert_not_awaited()

    async def test_daily_budget_shared_across_features_sessions_and_restart(self):
        await self.setting("automatic_session_summaries")
        await self.setting("experimental_auto_distill")
        first = await background_ai.claim("summary", "s", "first", prompt_chars=12000)
        await background_ai.finish(first, success=True)
        second = await background_ai.claim("distill", "s2", "second", prompt_chars=12000)
        await background_ai.finish(second, success=True)
        await background_ai.initialize(self.db)
        await self.db.commit()
        self.assertIsNone(await background_ai.claim("digest", "s3", "third"))
        await self.age_jobs(86401)
        self.assertIsNotNone(await background_ai.claim("digest", "s3", "third"))

    async def test_failed_attempts_do_not_refund_session_budget(self):
        await self.setting("automatic_session_summaries")
        for _ in range(2):
            receipt = await background_ai.claim("summary", "s", "retry")
            self.assertIsNotNone(receipt)
            await background_ai.finish(receipt, success=False)
            await self.age_jobs(301)
        self.assertIsNone(await background_ai.claim("digest", "s", "different feature"))
        self.assertEqual((await (await self.db.execute("SELECT COUNT(*) FROM automatic_ai_budget")).fetchone())[0], 2)

    async def test_concurrent_exits_only_claim_once(self):
        await self.setting("experimental_auto_distill")
        receipts = await asyncio.gather(*(background_ai.claim("distill", "s", "same") for _ in range(9)))
        claimed = [r for r in receipts if r]
        self.assertEqual(len(claimed), 1)
        await background_ai.finish(claimed[0], success=True)
        await self.age_jobs(3600)
        self.assertIsNone(await background_ai.claim("distill", "s", "same"))
        self.assertIsNotNone(await background_ai.claim("distill", "s", "new work"))

    async def test_persisted_dedup_survives_initializer_and_completed_retries(self):
        await self.setting("experimental_auto_distill")
        receipt = await background_ai.claim("distill", "s", "same")
        await background_ai.finish(receipt, success=True)
        await self.age_jobs(3600)
        await background_ai.initialize(self.db)
        await self.db.commit()
        self.assertIsNone(await background_ai.claim("distill", "s", "same"))

    async def test_failure_retries_are_throttled_and_expired_lease_recovers(self):
        await self.setting("experimental_auto_distill")
        first = await background_ai.claim("distill", "s", "same")
        await background_ai.finish(first, success=False)
        self.assertIsNone(await background_ai.claim("distill", "s", "same"))
        await self.age_jobs(301)
        second = await background_ai.claim("distill", "s", "same")
        self.assertIsNotNone(second)
        await self.age_jobs(601)
        self.assertIsNone(await background_ai.claim("distill", "s", "same"))
        await self.age_jobs(86401)
        third = await background_ai.claim("distill", "s", "same")
        self.assertIsNotNone(third)
        # A late completion of an old process must not clear the new lease.
        await background_ai.finish(second, success=True)
        self.assertIsNone(await background_ai.claim("distill", "s", "changed"))

    async def test_optional_jobs_are_bounded_across_sessions(self):
        await self.setting("experimental_auto_distill")
        self.assertIsNotNone(await background_ai.claim("distill", "s", "a"))
        self.assertIsNotNone(await background_ai.claim("distill", "s2", "b"))
        self.assertIsNone(await background_ai.claim("distill", "s3", "c"))

    async def test_helper_uses_low_effort_and_success_is_deduplicated(self):
        await self.setting("automatic_session_summaries")
        with patch("llm_router.call_json", AsyncMock(return_value={"summary": "done"})) as provider:
            result = await background_ai.call_json("summary", "s", "claude:haiku", "prompt", timeout_s=30)
            self.assertEqual(result, {"summary": "done"})
            provider.assert_awaited_once_with("claude:haiku", "prompt", reasoning_effort="low", timeout_s=30)
            self.assertIsNone(await background_ai.call_json("summary", "s", "claude:haiku", "prompt"))

    async def test_provider_failure_releases_claim(self):
        await self.setting("automatic_session_summaries")
        with patch("llm_router.call_json", AsyncMock(side_effect=RuntimeError("offline"))):
            with self.assertRaises(RuntimeError):
                await background_ai.call_json("summary", "s", "claude:haiku", "prompt")
        row = await (await self.db.execute("SELECT status FROM automatic_ai_jobs")).fetchone()
        self.assertEqual(row[0], "failed")

    async def test_disabled_summary_exits_before_reading_transcript(self):
        import server
        with patch.object(server, "get_db", AsyncMock(side_effect=AssertionError("should not read session"))):
            await server._maybe_auto_summarize("s")

    async def test_settings_restart_does_not_schedule_exit_metadata(self):
        import server
        import session_supervisor
        with patch.object(server, "get_db", self.connect), \
                patch.object(server, "_flush_output", AsyncMock()), \
                patch.object(server, "broadcast", AsyncMock()), \
                patch.object(session_supervisor, "exit_is_expected", return_value=True), \
                patch.object(session_supervisor, "record_exit", AsyncMock(return_value="stopped")), \
                patch.object(server.pty_mgr, "is_session_start_blocked", return_value=False), \
                patch.object(server, "_maybe_auto_distill", AsyncMock()) as distill, \
                patch.object(server, "_maybe_auto_summarize", AsyncMock()) as summary, \
                patch.object(server, "_fire_and_forget", side_effect=lambda coro: coro.close()):
            await server.handle_pty_exit("s", 0)
            distill.assert_not_called()
            summary.assert_not_called()

    async def test_delivery_failure_never_repeats_a_completed_provider_call(self):
        import server
        await self.setting("experimental_auto_distill")
        receipt = await background_ai.claim("distill", "s", "same")
        server._background_jobs["usage-test"] = {"status": "queued"}
        self.addCleanup(server._background_jobs.pop, "usage-test", None)
        with patch("llm_router.call_json", AsyncMock(return_value={"text": "done"})), \
                patch.object(server, "broadcast", AsyncMock(side_effect=RuntimeError("disconnected"))):
            with self.assertRaises(RuntimeError):
                await server._run_background_llm_job("usage-test", "distill", "claude:sonnet", "same", {}, automatic_receipt=receipt)
        await self.age_jobs(3600)
        self.assertIsNone(await background_ai.claim("distill", "s", "same"))

    async def test_exit_summary_reuses_existing_digest_without_model(self):
        import server
        await self.setting("automatic_session_summaries")
        await self.db.execute("INSERT INTO session_digests VALUES('s','Fixed the save flow')")
        await self.db.commit()
        with patch.object(server, "get_db", self.connect), patch.object(server, "broadcast", AsyncMock()), \
                patch("llm_router.call_json", AsyncMock()) as provider:
            await server._maybe_auto_summarize("s")
            provider.assert_not_awaited()
        row = await (await self.db.execute("SELECT summary FROM sessions WHERE id='s'")).fetchone()
        self.assertEqual(row[0], "Fixed the save flow")

    async def test_actual_auto_distill_callback_does_not_reschedule_unchanged_content(self):
        import server
        await self.setting("experimental_auto_distill")
        transcript = Path(self.tmp.name) / "transcript.jsonl"
        transcript.touch()
        messages = [{"role": "user", "content": "Fix the same save bug with a regression check."} for _ in range(6)]
        with patch.object(server, "get_db", self.connect), \
                patch.object(server, "_get_native_transcript_path", return_value=transcript), \
                patch.object(server, "_session_transcript_home", return_value=None), \
                patch.object(server, "read_session_messages", return_value=messages), \
                patch("llm_router.model_id_for_provider", AsyncMock(return_value="claude:sonnet")), \
                patch.object(server, "_run_background_llm_job", AsyncMock()) as run:
            await asyncio.gather(*(server._maybe_auto_distill("s", 0) for _ in range(9)))
            await asyncio.sleep(0)
            self.assertEqual(run.await_count, 1)
            receipt = run.call_args.kwargs["automatic_receipt"]
            await background_ai.finish(receipt, success=True)
            await self.age_jobs(3600)
            await server._maybe_auto_distill("s", 0)
            await asyncio.sleep(0)
            self.assertEqual(run.await_count, 1)


class HelperEffortTests(unittest.TestCase):
    def test_only_explicit_helpers_override_effort_for_both_clis(self):
        from cli_profiles import get_profile
        from llm_router import _build_one_shot_command
        for cli in ("claude", "codex"):
            args = dict(cli=cli, profile=get_profile(cli), binary=cli, full_prompt="hello", model=None, use_stdin=False)
            ordinary = _build_one_shot_command(**args)
            helper = _build_one_shot_command(**args, reasoning_effort="low")
            self.assertNotIn("--effort", ordinary)
            self.assertFalse(any("model_reasoning_effort" in arg for arg in ordinary))
            if cli == "claude":
                self.assertEqual(helper[-2:], ["--effort", "low"])
            else:
                self.assertIn('model_reasoning_effort="low"', helper)

    def test_metadata_expensive_defaults_are_opt_in(self):
        import experimental
        for key in ("experimental_auto_distill", "experimental_checkpoint_protocol"):
            self.assertFalse(experimental.EXPERIMENTAL_FEATURES[key].default_enabled)


if __name__ == "__main__":
    unittest.main()
