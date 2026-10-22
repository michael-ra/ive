import asyncio
import io
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

import provider_limits as limits
import provider_statusline as statusline


class ParseTests(TestCase):
    def test_codex_windows_use_reported_durations_and_keep_independent_buckets(self):
        result = limits.codex_windows({"rateLimitsByLimitId": {
            "codex": {"primary": {"usedPercent": 0, "windowDurationMins": 300, "resetsAt": 2000000000},
                      "secondary": {"usedPercent": 100, "windowDurationMins": 10080, "resetsAt": 2000000400}},
            "other": {"primary": {"usedPercent": 25, "windowDurationMins": 60, "resetsAt": 2000000500}}}})
        self.assertEqual([x["label"] for x in result], ["5h", "Week", "60 min"])
        self.assertEqual([x["remaining_percent"] for x in result], [100, 0, 75])
        self.assertEqual(result[-1]["bucket"], "other")

    def test_missing_or_malformed_usage_is_unknown_not_a_full_quota(self):
        for value in (None, True, "20", float('nan'), -1, 101):
            self.assertIsNone(limits.window('5h', value, 2000000000))
        self.assertEqual(limits.codex_windows({}), [])
        self.assertEqual(limits.claude_windows({"rate_limits": {"five_hour": {"resets_at": 2000000000}}}), [])
        self.assertIsNone(limits.window('5h', 10, None)['resets_at'])

    def test_claude_windows_are_optional_and_not_token_derived(self):
        data = {"rate_limits": {"seven_day": {"used_percentage": 42.5, "resets_at": 2000000000}}, "usage": {"output_tokens": 9000}}
        self.assertEqual(limits.claude_windows(data)[0]['remaining_percent'], 57.5)
        self.assertEqual(len(limits.claude_windows(data)), 1)

    def test_statusline_collects_only_quota_fields_and_preserves_custom_command(self):
        with TemporaryDirectory() as folder:
            home = Path(folder)
            (home / '.claude').mkdir()
            (home / '.claude/settings.json').write_text(json.dumps({'statusLine': {'type': 'command', 'command': 'echo custom'}}))
            env = {'HOME': folder, 'IVE_PROVIDER_LIMITS_SCOPE': 'account-a'}
            with patch.object(limits, 'DATA_DIR', home):
                args = statusline.configure(['--model', 'sonnet'], env, 'session-1', folder)
                self.assertEqual(args[:2], ['--model', 'sonnet'])
                self.assertEqual(env['IVE_STATUSLINE_ORIGINAL'], 'echo custom')
                payload = {'rate_limits': {'five_hour': {'used_percentage': 12, 'resets_at': 2000000000}}, 'transcript_path': 'private', 'secret': 'do-not-save'}
                with patch.dict(os.environ, env), patch('sys.stdin', io.StringIO(json.dumps(payload))), patch('subprocess.run') as run:
                    statusline.main()
                    run.assert_called_once()
                content = limits.snapshot_path('session-1').read_text()
                self.assertNotIn('private', content)
                self.assertNotIn('do-not-save', content)
                self.assertEqual(limits.read_claude_snapshot('session-1', 'account-a')['windows'][0]['remaining_percent'], 88)
                self.assertIsNone(limits.read_claude_snapshot('session-1', 'account-b'))

    def test_explicit_cli_settings_are_preserved(self):
        args = ['--settings', '{"permissions":{}}']
        self.assertEqual(statusline.configure(args, {}, 's', '/unused'), args)


class FetchTests(IsolatedAsyncioTestCase):
    def setUp(self):
        limits._cache.clear()
        limits._locks.clear()

    async def test_cache_is_shared_by_account_but_never_across_accounts(self):
        def home(cli, account_id=None): return Path('/isolated') / (account_id or 'host')
        read = AsyncMock(return_value={'windows': [], 'updated_at': 100})
        account = {'type': 'oauth', 'cli_type': 'codex', 'credentials_verified_at': 'yes'}
        with patch('ive_cli_profile.runtime_home_for_cli', side_effect=home), patch.object(limits, 'read_codex_limits', read):
            await asyncio.gather(*[limits.limits_for_session({'cli_type': 'codex', 'account_id': 'a'}, account) for _ in range(3)])
            self.assertEqual(read.await_count, 1)
            await limits.limits_for_session({'cli_type': 'codex', 'account_id': 'b'}, account)
            self.assertEqual(read.await_count, 2)
            self.assertEqual(read.await_args.args[0], Path('/isolated/b'))

    async def test_invalid_or_api_key_account_never_falls_back_to_host(self):
        with patch.object(limits, 'read_codex_limits', AsyncMock()) as read:
            for account in (None, {'type': 'api_key'}, {'type': 'oauth', 'cli_type': 'claude', 'credentials_verified_at': 'yes'}):
                result = await limits.limits_for_session({'cli_type': 'codex', 'account_id': 'a'}, account)
                self.assertEqual(result['windows'], [])
            read.assert_not_called()

    async def test_network_failure_keeps_previous_snapshot_as_stale(self):
        home = Path('/isolated')
        limits._cache[str(home)] = (0, {'windows': [{'remaining_percent': 30}], 'updated_at': 123})
        with patch('ive_cli_profile.runtime_home_for_cli', return_value=home), patch.object(limits, 'read_codex_limits', AsyncMock(side_effect=OSError('offline'))):
            result = await limits.limits_for_session({'cli_type': 'codex'})
            self.assertTrue(result['stale'])
            self.assertEqual(result['updated_at'], 123)
            self.assertEqual(result['windows'][0]['remaining_percent'], 30)
            self.assertNotIn('offline', result['message'])

    async def test_endpoint_rejects_non_owner_before_reading_any_account(self):
        from aiohttp.test_utils import make_mocked_request
        from types import SimpleNamespace
        import server
        with patch.object(server, 'get_auth', return_value=SimpleNamespace(actor_kind='joiner_session')), patch.object(server, 'get_db', AsyncMock()) as db:
            response = await server.get_provider_limits(make_mocked_request('GET', '/api/provider-limits'))
            self.assertEqual(response.status, 403)
            db.assert_not_called()
