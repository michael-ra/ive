"""Resume/login, model ownership and bounded context regressions; no live agent."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import aiosqlite
from cli_session import UnifiedSession
from model_policy import switch_error, migrate_model_switching
from output_capture import OutputCaptureProcessor
from session_budget import read_context_usage, claude_compaction_env


class ContextUsageTests(unittest.TestCase):
    def read(self, *records):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'history.jsonl'
            path.write_text('\n'.join(json.dumps(r) for r in records))
            return read_context_usage(path)

    def assistant(self, **usage):
        return {'type': 'assistant', 'message': {'model': 'claude-opus-test', 'usage': usage}}

    def test_last_request_not_sum_and_cache_counts_toward_context(self):
        result = self.read(self.assistant(input_tokens=830000),
                           self.assistant(input_tokens=1000, cache_read_input_tokens=155000, cache_creation_input_tokens=2000))
        self.assertEqual(result['input_tokens'], 158000)
        self.assertTrue(result['warning'])

    def test_compaction_invalidates_old_usage_until_next_request(self):
        old = self.assistant(input_tokens=700000)
        boundary = {'type': 'system', 'subtype': 'compact_boundary'}
        self.assertIsNone(self.read(old, boundary))
        result = self.read(old, boundary, self.assistant(input_tokens=20000))
        self.assertEqual(result['input_tokens'], 20000)
        self.assertFalse(result['warning'])

    def test_codex_uses_last_not_total_and_does_not_count_cache_twice(self):
        result = self.read({'type': 'event_msg', 'payload': {'type': 'token_count', 'info': {
            'total_token_usage': {'input_tokens': 830000},
            'last_token_usage': {'input_tokens': 160000, 'cached_input_tokens': 150000}}}})
        self.assertEqual(result['input_tokens'], 160000)

    def test_bad_and_synthetic_usage_is_ignored(self):
        self.assertIsNone(self.read(self.assistant(input_tokens='1000')))
        self.assertIsNone(self.read(self.assistant(input_tokens=float('inf'))))
        self.assertIsNone(self.read({'type': 'assistant', 'message': {'model': '<synthetic>', 'usage': {'input_tokens': 700000}}}))

    def test_launch_keeps_opus_and_enables_native_compaction_without_global_writes(self):
        with patch.object(UnifiedSession, '_resolved_binary', return_value='claude'):
            cmd = UnifiedSession('claude', {'model': 'opus', 'resume_id': 'old-history'}).build_command()
        self.assertEqual(cmd[cmd.index('--model') + 1], 'opus')
        self.assertTrue(json.loads(cmd[cmd.index('--settings') + 1])['autoCompactEnabled'])
        self.assertEqual(claude_compaction_env()['CLAUDE_CODE_AUTO_COMPACT_WINDOW'], '200000')
        self.assertEqual(claude_compaction_env()['DISABLE_AUTO_COMPACT'], '0')

    def test_compaction_override_does_not_disable_quota_statusline(self):
        from provider_statusline import configure
        with TemporaryDirectory() as directory, patch('provider_limits.snapshot_path', return_value=Path('/tmp/isolated-snapshot')), patch('helper_command.helper_command', return_value=['ive-backend', '--helper', 'provider-statusline']):
            args = configure(['--model', 'opus', '--settings', '{"autoCompactEnabled":true}'], {'HOME':directory}, 's', directory)
        self.assertEqual(args.count('--settings'), 1)
        settings = json.loads(args[args.index('--settings') + 1])
        self.assertTrue(settings['autoCompactEnabled'])
        self.assertIn('provider-statusline', settings['statusLine']['command'])


class ResumeAuthTests(unittest.IsolatedAsyncioTestCase):
    async def test_replayed_errors_never_emit_auth_failed(self):
        capture = OutputCaptureProcessor()
        events = []
        async def received(sid, event): events.append(event)
        capture.on_capture(received)
        for text in ['Not logged in · Please run /login\n'] * 4:
            await capture.process('claude', text.encode())
        for text in ['Your access token could not be refreshed. Please sign in again\n'] * 4:
            await capture.process('codex', text.encode())
        self.assertFalse(any(e['capture_type'] == 'auth_failed' for e in events))
        self.assertEqual(len([e for e in events if e['capture_type'] == 'auth_suspected']), 2)

    async def test_unverified_capture_cannot_stop_session_or_change_account(self):
        import server
        with patch.object(server, 'get_db', AsyncMock()) as db, patch.object(server, '_stop_session_expected', AsyncMock()) as stop:
            await server._handle_auth_failed_capture('s', {'capture_type': 'auth_failed', 'raw_text': 'Please run /login'})
        db.assert_not_called()
        stop.assert_not_called()

    async def test_http_send_after_resume_does_not_return_startup_blocked(self):
        import server
        for cli, screen in [('claude', 'Not logged in · Please run /login\n❯ '),
                            ('codex', 'Your access token could not be refreshed. Please sign in again\n› ' )]:
            request = SimpleNamespace(match_info={'id':'s'}, json=AsyncMock(return_value={'message':'Continue', 'ready_timeout':0}), path='/api/sessions/s/input')
            with patch.object(server, '_get_visible_session_for_request', AsyncMock(return_value={'id':'s','cli_type':cli})), patch.object(server, 'get_auth', return_value=None), patch.object(server, '_terminal_control_violation', return_value=None), patch.object(server, '_session_cli_type', AsyncMock(return_value=cli)), patch.object(server, '_startup_blocker_text', return_value=screen), patch.object(server.pty_mgr, 'is_alive', return_value=True), patch.object(server.pty_mgr, 'write', return_value=True) as write, patch.object(server._asyncio, 'sleep', AsyncMock()):
                response = await server.send_session_input(request)
            self.assertEqual(response.status, 200, response.text)
            self.assertTrue(any(call.args[1] == b'Continue' for call in write.call_args_list))

    async def test_compact_cannot_interrupt_a_busy_session(self):
        import server
        request = SimpleNamespace(match_info={'id':'s'}, json=AsyncMock(return_value={'message':'/compact'}), path='/api/sessions/s/input')
        with patch.object(server, '_get_visible_session_for_request', AsyncMock(return_value={'id':'s','cli_type':'claude'})), patch.object(server, 'get_auth', return_value=None), patch.object(server, '_terminal_control_violation', return_value=None), patch.object(server, '_session_cli_type', AsyncMock(return_value='claude')), patch('hooks.get_session_logical_status', return_value='running'), patch.object(server.pty_mgr, 'is_alive', return_value=True), patch.object(server.pty_mgr, 'write', Mock()) as write:
            response = await server.send_session_input(request)
        self.assertEqual(response.status, 409)
        write.assert_not_called()

    def test_both_resumed_composers_accept_input_but_live_login_menus_still_block(self):
        from test_startup_blocker import _load
        ns = _load()
        for cli, text in [('claude', 'Not logged in · Please run /login\n❯ '),
                          ('codex', 'Your access token could not be refreshed. Please sign in again\n› Ask Codex to do anything')]:
            self.assertIsNone(ns['_detect_cli_startup_blocker'](cli, text))
            self.assertTrue(ns['_looks_ready_for_input'](cli, text))
        self.assertEqual(ns['_detect_cli_startup_blocker']('claude', 'Select login method:\n> 1. Claude account with subscription')['type'], 'auth_required')


class ModelPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def test_agent_cannot_create_fable_worker_under_opus_parent(self):
        import server
        with TemporaryDirectory() as directory:
            path = str(Path(directory) / 'db')
            async def connect():
                db = await aiosqlite.connect(path)
                db.row_factory = aiosqlite.Row
                return db
            db = await connect()
            await db.execute('CREATE TABLE workspaces (id TEXT, orchestration_policy TEXT, inherit_orchestration_policy_from TEXT, alloy_enabled INTEGER)')
            await db.execute("INSERT INTO workspaces VALUES ('w', NULL, NULL, 0)")
            await db.commit(); await db.close()
            request = SimpleNamespace(headers={'X-IVE-Session-Type':'commander', 'X-IVE-Session-Id':'parent'}, json=AsyncMock(return_value={'workspace_id':'w', 'model':'claude-fable-5-1'}))
            with patch.object(server, 'get_db', connect), patch.object(server, '_workspace_visible_to_auth', return_value=True), patch.object(server, 'get_auth', return_value=None), patch.object(server, 'get_session_config', AsyncMock(return_value={'model':'opus','cli_type':'claude'})), patch.object(server, '_registered_cli_availability', AsyncMock()) as launch:
                result = await server.create_session(request)
            self.assertEqual(result.status, 403)
            self.assertEqual(json.loads(result.text)['model'], 'opus')
            launch.assert_not_called()

    async def test_agent_put_cannot_change_model_or_grant_itself_switching(self):
        import server
        with TemporaryDirectory() as directory:
            path = str(Path(directory) / 'db')
            async def connect():
                db = await aiosqlite.connect(path)
                db.row_factory = aiosqlite.Row
                return db
            db = await connect()
            await db.execute('CREATE TABLE sessions (id TEXT, model TEXT, cli_type TEXT, account_id TEXT, plan_model TEXT, execute_model TEXT)')
            await db.execute("INSERT INTO sessions VALUES ('s','opus','claude',NULL,NULL,NULL)")
            await db.execute('CREATE TABLE app_settings (key TEXT, value TEXT)')
            await db.commit(); await db.close()
            for body in ({'model':'claude-fable-5-1'}, {'plan_model':'claude-fable-5-1'}):
                request = SimpleNamespace(match_info={'id':'s'}, headers={'X-IVE-Session-Type':'commander'}, json=AsyncMock(return_value=body))
                with patch.object(server, 'get_db', connect), patch.object(server, '_session_visible_to_request', return_value=True):
                    result = await server.update_session(request)
                self.assertEqual(result.status, 403)
            db = await connect()
            self.assertEqual((await (await db.execute("SELECT model FROM sessions WHERE id='s'")).fetchone())['model'], 'opus')
            await db.close()

    def test_switch_requires_opt_in_and_explicit_pair(self):
        config = {'model': 'opus', 'plan_model': 'opus', 'execute_model': 'sonnet'}
        self.assertIsNone(switch_error(config, 'opus', False))
        self.assertIsNotNone(switch_error(config, 'sonnet', False))
        self.assertIsNone(switch_error(config, 'sonnet', True))
        self.assertIsNotNone(switch_error(config, 'claude-fable-5-1', True))

    async def test_legacy_default_disabled_once_but_explicit_pair_preserved(self):
        for configured in (False, True):
            async with aiosqlite.connect(':memory:') as db:
                db.row_factory = aiosqlite.Row
                await db.execute('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)')
                await db.execute('CREATE TABLE sessions (plan_model TEXT, execute_model TEXT)')
                await db.execute("INSERT INTO app_settings VALUES ('experimental_model_switching', 'on')")
                if configured: await db.execute("INSERT INTO sessions VALUES ('opus','sonnet')")
                await migrate_model_switching(db)
                row = await (await db.execute("SELECT value FROM app_settings WHERE key='experimental_model_switching'")).fetchone()
                self.assertEqual(row['value'], 'on' if configured else 'off')
                await db.execute("UPDATE app_settings SET value='on' WHERE key='experimental_model_switching'")
                await migrate_model_switching(db)
                self.assertEqual((await (await db.execute("SELECT value FROM app_settings WHERE key='experimental_model_switching'")).fetchone())['value'], 'on')

    async def test_stale_mcp_switch_tool_is_rejected_before_pty_write(self):
        import server
        request = SimpleNamespace(match_info={'id':'s'}, headers={'X-IVE-Session-Type':'commander'}, json=AsyncMock(return_value={'model':'claude-fable-5-1'}))
        db = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(fetchone=AsyncMock(return_value={'value':'off'}))), close=AsyncMock())
        with patch.object(server, '_resolve_caller', AsyncMock(return_value={'session_type':'commander','session_id':'s'})), patch.object(server, 'get_session_config', AsyncMock(return_value={'model':'opus','cli_type':'claude'})), patch.object(server, '_session_visible_to_request', return_value=True), patch.object(server, 'get_db', AsyncMock(return_value=db)), patch.object(server.pty_mgr, 'write', Mock()) as write:
            result = await server.switch_model(request)
        self.assertEqual(result.status, 403)
        write.assert_not_called()

    async def test_cli_switch_cannot_bypass_model_choice(self):
        import server
        import session_supervisor
        for body in ({'cli_type':'claude','model':'claude-fable-5-1'}, {'cli_type':'codex','model':'gpt-6-astra'}):
            request = SimpleNamespace(match_info={'id':'s'}, headers={'X-IVE-Session-Type':'commander'}, json=AsyncMock(return_value=body))
            current = {'id':'s','model':'opus','cli_type':'claude'}
            db = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(fetchone=AsyncMock(return_value=current))), close=AsyncMock())
            with patch.object(server, 'get_db', AsyncMock(return_value=db)), patch.object(server, '_session_visible_to_request', return_value=True), patch('model_policy.switching_enabled', AsyncMock(return_value=False)), patch.object(session_supervisor, 'restart', AsyncMock()) as restart:
                response = await server.switch_session_cli(request)
            self.assertEqual(response.status, 403, response.text)
            restart.assert_not_called()


if __name__ == '__main__':
    unittest.main()
