"""Isolated regressions: no real agent/tool, provider call or user data."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import AsyncMock, patch
import aiosqlite
import safety_setup
from model_providers import default_model_providers


class OptionalSafetyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name) / 'settings.db')
        self.db = await self.connect()
        await self.db.execute('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
        await self.set('model_providers', json.dumps(default_model_providers()))
        self.addAsyncCleanup(self.db.close)

    async def connect(self):
        db = await aiosqlite.connect(self.path)
        db.row_factory = aiosqlite.Row
        return db

    async def set(self, key, value):
        await self.db.execute('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', (key, value))
        await self.db.commit()

    async def value(self, key):
        cursor = await self.db.execute('SELECT value FROM app_settings WHERE key = ?', (key,))
        row = await cursor.fetchone()
        return row['value'] if row else None

    async def test_fresh_defaults_do_not_add_checks_or_followup_turns(self):
        from database_seeds import seed_experimental_flags
        await seed_experimental_flags(self.db)
        for key in ('experimental_safety_gate', 'experimental_avcp_protection', 'experimental_stop_reflection'):
            self.assertEqual(await self.value(key), 'off')

    async def test_keyless_legacy_install_is_repaired_once(self):
        await self.set('experimental_safety_gate', 'on')
        await safety_setup.migrate_unconfigured_classifier(self.db)
        self.assertEqual(await self.value('experimental_safety_gate'), 'off')
        await self.set('experimental_safety_gate', 'on')
        await safety_setup.migrate_unconfigured_classifier(self.db)
        self.assertEqual(await self.value('experimental_safety_gate'), 'on')

    async def test_configured_legacy_opt_in_is_preserved(self):
        await self.set('experimental_safety_gate', 'on')
        await self.set('api_key_gemini_api', 'test-only-placeholder')
        await safety_setup.migrate_unconfigured_classifier(self.db)
        self.assertEqual(await self.value('experimental_safety_gate'), 'on')

    async def test_deny_list_only_needs_no_provider_key(self):
        setup = await safety_setup.classifier_setup(self.db, model='')
        self.assertEqual(setup, {'ready': True, 'model': '', 'issue': None})

    async def test_missing_key_has_actionable_configuration_issue(self):
        setup = await safety_setup.classifier_setup(self.db)
        self.assertFalse(setup['ready'])
        self.assertEqual(setup['code'], 'provider_not_configured')
        self.assertIn('API key', setup['issue'])

    async def test_settings_api_refuses_keyless_activation_without_saving(self):
        import server
        with patch.object(server, 'get_db', self.connect):
            result = await server._put_registry_guarded_setting('experimental_safety_gate', 'on')
        self.assertEqual(result.status, 400)
        self.assertIsNone(await self.value('experimental_safety_gate'))

    async def test_settings_api_accepts_configured_opt_in_and_disable(self):
        import server
        await self.set('api_key_gemini_api', 'test-only-placeholder')
        with patch.object(server, 'get_db', self.connect):
            for value in ('on', 'off'):
                result = await server._put_registry_guarded_setting('experimental_safety_gate', value)
                self.assertEqual(result.status, 200)
                self.assertEqual(await self.value('experimental_safety_gate'), value)

    async def test_unconfigured_model_cannot_replace_active_deny_list_mode(self):
        import server
        await self.set('experimental_safety_gate', 'on')
        await self.set('safety_classifier_model', '')
        with patch.object(server, 'get_db', self.connect):
            result = await server._put_registry_guarded_setting('safety_classifier_model', None)
        self.assertEqual(result.status, 400)
        self.assertEqual(await self.value('safety_classifier_model'), '')

    async def test_reflection_needs_opt_in_and_stays_quiet_on_settings_failure(self):
        import idle_reflection as reflection
        self.addCleanup(reflection._settings_cache.clear)
        with patch.object(reflection, 'get_db', self.connect):
            for setting, expected in ((None, False), ('on', True), ('off', False)):
                if setting is not None:
                    await self.set('experimental_stop_reflection', setting)
                reflection._settings_cache.clear()
                self.assertEqual(await reflection._is_enabled(), expected)
        reflection._settings_cache.clear()
        with patch.object(reflection, 'get_db', AsyncMock(side_effect=RuntimeError('offline'))):
            self.assertFalse(await reflection._is_enabled())


class HookPermissionTests(unittest.TestCase):
    def setUp(self):
        from hook_installer import SAFETY_GATE_SCRIPT
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.script = Path(self.tmp.name) / 'gate.sh'
        self.script.write_text(SAFETY_GATE_SCRIPT)
        self.decision = 'allow'
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get('content-length', 0)))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({'decision': owner.decision, 'reason': 'test verdict'}).encode())
            def log_message(self, *_):
                pass
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.http.server_close)
        self.addCleanup(self.http.shutdown)

    def run_hook(self, payload, protocol='claude_json'):
        env = {**os.environ, 'HOME': self.tmp.name, 'IVE_DATA_DIR': self.tmp.name,
               'TMPDIR': self.tmp.name, 'COMMANDER_SESSION_ID': 'test-session',
               'COMMANDER_API_URL': f'http://127.0.0.1:{self.http.server_port}',
               'COMMANDER_CLI_TYPE': 'claude', 'COMMANDER_HOOK_DECISION_PROTOCOL': protocol}
        return subprocess.run(['/bin/bash', str(self.script)], input=json.dumps(payload),
                              text=True, capture_output=True, env=env, timeout=15)

    def test_allow_and_legacy_auto_allow_never_bypass_native_permissions(self):
        for decision in ('allow', 'allow_auto'):
            self.decision = decision
            result = self.run_hook({'tool_name': 'Read', 'tool_input': {'file_path': '/tmp/readme'}})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, '', 'native permissions must receive no explicit allow')

    def test_opted_in_ask_and_deny_are_not_silently_approved(self):
        for decision in ('ask', 'deny'):
            self.decision = decision
            result = self.run_hook({'tool_name': 'Read', 'tool_input': {'file_path': '/tmp/readme'}})
            self.assertEqual(json.loads(result.stdout)['hookSpecificOutput']['permissionDecision'], decision)

    def test_local_critical_deny_still_wins_over_api_allow(self):
        result = self.run_hook({'tool_name': 'Bash', 'tool_input': {'command': 'rm -rf /'}})
        self.assertEqual(json.loads(result.stdout)['hookSpecificOutput']['permissionDecision'], 'deny')

    def test_gemini_neutral_allow_and_deny_protocol(self):
        payload = {'tool_name': 'read_file', 'tool_input': {'path': '/tmp/readme'}}
        self.assertEqual(self.run_hook(payload, 'exit_code').returncode, 0)
        self.decision = 'deny'
        self.assertEqual(self.run_hook(payload, 'exit_code').returncode, 2)


class SafetyEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import db as database
        import server
        from safety_engine import seed_builtin_rules
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for name, value in [('DATA_DIR', Path(self.tmp.name)), ('DB_PATH', Path(self.tmp.name) / 'data.db')]:
            p = patch.object(database, name, value)
            p.start(); self.addCleanup(p.stop)
        await database.init_db()
        db = await database.get_db()
        try:
            await seed_builtin_rules(db)
            await db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws','Test',?)", (self.tmp.name,))
            await db.execute("INSERT INTO sessions(id,workspace_id,name,cli_type,permission_mode) VALUES('s1','ws','Test','claude','auto')")
            await db.commit()
        finally:
            await db.close()
        self.database = database
        self.server = server

    async def evaluate(self, tool, value):
        from types import SimpleNamespace
        request = {'auth': SimpleNamespace(actor_kind='owner', actor_id='test', device_id='', is_owner=True)}
        class Request(dict):
            async def json(self):
                return {'tool_name': tool, 'tool_input': value, 'tool_use_id': 'test-call', 'session_id': 's1'}
        response = await self.server.evaluate_safety(Request(request))
        return response.status, json.loads(response.body)

    async def test_keyless_auto_session_read_is_neutral_without_ai(self):
        status, result = await self.evaluate('Read', {'file_path': '/tmp/readme'})
        self.assertEqual(status, 200, result)
        self.assertEqual(result['decision'], 'allow', result)

    async def test_package_scanner_is_not_called_when_off(self):
        scanner = AsyncMock(side_effect=AssertionError('disabled scanner must not run'))
        with patch.object(self.server, '_avcp_scan_inline', scanner):
            status, result = await self.evaluate('Bash', {'command': 'npm install example-package'})
        self.assertEqual(status, 200, result)
        self.assertEqual(result['decision'], 'allow', result)
        scanner.assert_not_awaited()

    async def test_enabled_package_scanner_preserves_its_denial(self):
        db = await self.database.get_db()
        await db.execute("UPDATE app_settings SET value='on' WHERE key='experimental_avcp_protection'")
        await db.commit(); await db.close()
        scanner = AsyncMock(return_value=('deny', 'test package blocked', [], False))
        with patch.object(self.server, '_avcp_scan_inline', scanner):
            status, result = await self.evaluate('Bash', {'command': 'npm install example-package'})
        self.assertEqual(result['decision'], 'deny', result)
        scanner.assert_awaited_once()

    async def test_known_fetch_domain_does_not_bypass_native_permissions(self):
        status, result = await self.evaluate('WebFetch', {'url': 'https://github.com/example/project'})
        self.assertEqual(status, 200, result)
        self.assertEqual(result['decision'], 'allow', result)

    async def test_mandatory_deny_still_applies_with_optional_checks_off(self):
        status, result = await self.evaluate('Bash', {'command': 'rm -rf /'})
        self.assertEqual(result['decision'], 'deny', result)


if __name__ == '__main__':
    unittest.main()
