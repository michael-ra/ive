"""Isolated repository/context integration checks with a real temporary DB."""
import ast
import asyncio
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import uuid

from aiohttp import web
import db as database
import guideline_contributions
import memory_manager
import memory_sync
import session_capabilities
import skill_installer
import workspace_fields
import workspace_runtime


class Request:
    def __init__(self, body=None, **match_info):
        self.body = body
        self.match_info = match_info
        self.query = {}

    async def json(self):
        return self.body


class ContextWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ive-context-workflow-")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.repo = root / "repo"
        self.repo.mkdir()
        self.home = root / "home"
        self.home.mkdir()
        self.data = root / "state"
        self.data.mkdir()
        for target, value in (("DATA_DIR", self.data), ("DB_PATH", self.data / "test.db")):
            p = patch.object(database, target, value)
            p.start(); self.addCleanup(p.stop)
        p = patch.dict(os.environ, {"HOME": str(self.home), "IVE_NATIVE_MEMORY_OPT_IN": "1"})
        p.start(); self.addCleanup(p.stop)
        await database.init_db()
        self.db = await database.get_db()
        self.addAsyncCleanup(self.db.close)
        await self.db.execute("INSERT INTO workspaces (id, name, path) VALUES ('ws', 'Test repo', ?)", (str(self.repo),))
        await self.db.execute("INSERT INTO workspaces (id, name, path) VALUES ('other', 'Other repo', ?)", (str(root / 'other'),))
        await self.db.execute("INSERT INTO sessions (id, workspace_id, name, cli_type, status, active_guideline_ids) VALUES ('session', 'ws', 'Test', 'claude', 'running', '[]')")
        await self.db.commit()
        self.manager = memory_manager.MemoryManager()
        self.sync = memory_sync.MemorySyncManager()
        self.providers = [memory_sync.get_provider('claude'), memory_sync.get_provider('codex')]
        p = patch.object(memory_sync, "all_providers", return_value=self.providers)
        p.start(); self.addCleanup(p.stop)
        self.background = []
        def tracked_task(coro):
            task = asyncio.create_task(coro)
            self.background.append(task)
            return task
        names = {
            'create_workspace', 'create_guideline', 'set_session_guidelines', 'get_session_guidelines',
            'create_mcp_server', 'set_session_mcp_servers', 'get_session_mcp_servers',
        }
        source = ast.parse(Path(__file__).with_name('server.py').read_text())
        ns = dict(web=web, uuid=uuid, json=json, get_db=database.get_db,
                  workspace_fields=workspace_fields, _with_quick_flag=lambda row: row,
                  asyncio=SimpleNamespace(create_task=tracked_task),
                  _ensure_workspace_commander_safely=AsyncMock(), _sync_memory_to_cli=AsyncMock(),
                  _sync_zai_mcp_servers_for_session=AsyncMock(),
                  project_guidelines=guideline_contributions.project_guidelines)
        module = ast.Module(body=[n for n in source.body if isinstance(n, ast.AsyncFunctionDef) and n.name in names], type_ignores=[])
        exec(compile(module, 'server.py', 'exec'), ns)
        self.api = SimpleNamespace(**{name: ns[name] for name in names})

    async def asyncTearDown(self):
        if self.background:
            await asyncio.gather(*self.background)

    async def test_register_normal_repo_rejects_duplicate_and_missing_paths(self):
        new = Path(self.tmp.name) / 'new repo'
        new.mkdir()
        response = await self.api.create_workspace(Request({'path': str(new), 'name': 'Example'}))
        self.assertEqual(response.status, 201)
        self.assertEqual(json.loads(response.text)['path'], str(new.absolute()))
        self.assertEqual((await self.api.create_workspace(Request({'path': str(new)}))).status, 409)
        self.assertEqual((await self.api.create_workspace(Request({'path': str(new / 'missing')}))).status, 400)
        self.assertFalse((new / 'CLAUDE.md').exists())

    async def test_memory_crud_search_prompt_and_workspace_isolation(self):
        own = await self.manager.save('Style', 'project', 'Use BLUE-314', workspace_id='ws')
        await self.manager.save('Other', 'project', 'Use RED-992', workspace_id='other')
        await self.manager.save('Global', 'user', 'Use clear explanations')
        rows = await self.manager.list_entries(workspace_id='ws', include_global=False)
        self.assertEqual([row['id'] for row in rows], [own])
        self.assertEqual(len(await self.manager.search('BLUE', workspace_id='ws')), 1)
        self.assertEqual(await self.manager.search('RED', workspace_id='ws'), [])
        prompt = await self.manager.export_for_prompt(workspace_id='ws')
        self.assertIn('BLUE-314', prompt)
        self.assertIn('clear explanations', prompt)
        self.assertNotIn('RED-992', prompt)
        self.assertTrue(await self.manager.update(own, content='Use GREEN-518'))
        self.assertEqual((await self.manager.get(own))['content'], 'Use GREEN-518')
        self.assertTrue(await self.manager.delete(own))
        self.assertIsNone(await self.manager.get(own))

    async def test_native_memory_needs_opt_in_and_preserves_existing_context(self):
        (self.repo / 'CLAUDE.md').write_text('Existing project rules\n')
        result = await self.sync.sync('ws', str(self.repo))
        self.assertEqual(result.status, 'disabled')
        self.assertFalse((self.repo / 'AGENTS.md').exists())
        result = await self.sync.sync('ws', str(self.repo), consent=True)
        self.assertEqual(result.status, 'synced')
        self.assertEqual(await self.sync.read_central('ws'), 'Existing project rules\n')
        self.assertIn('Existing project rules', (self.repo / 'AGENTS.md').read_text())

    async def test_memory_conflict_is_reported_before_overwriting(self):
        await self.sync.write_central('ws', 'Color: blue\n')
        await self.sync.sync('ws', str(self.repo), consent=True)
        (self.repo / 'CLAUDE.md').write_text('Color: red\n')
        (self.repo / 'AGENTS.md').write_text('Color: green\n')
        result = await self.sync.sync('ws', str(self.repo), consent=True)
        self.assertEqual(result.status, 'conflicts')
        self.assertEqual((self.repo / 'CLAUDE.md').read_text(), 'Color: red\n')
        self.assertEqual((self.repo / 'AGENTS.md').read_text(), 'Color: green\n')
        resolved = await self.sync.resolve_conflicts('ws', str(self.repo), 'Color: purple\n', consent=True)
        self.assertEqual(resolved.status, 'synced')
        self.assertEqual((self.repo / 'CLAUDE.md').read_text().strip(), 'Color: purple')
        self.assertEqual((self.repo / 'AGENTS.md').read_text().strip(), 'Color: purple')

    async def test_legacy_codex_memory_migrates_without_editing_legacy_file(self):
        legacy = self.repo / 'CODEX.md'
        legacy.write_text('Legacy project context\n')
        result = await self.sync.sync('ws', str(self.repo), consent=True)
        self.assertEqual(result.status, 'synced')
        self.assertEqual(legacy.read_text(), 'Legacy project context\n')
        self.assertEqual((self.repo / 'AGENTS.md').read_text(), 'Legacy project context\n')

    async def test_codex_native_override_wins_and_existing_agents_is_preserved(self):
        (self.repo / 'CODEX.md').write_text('Legacy instructions\n')
        (self.repo / 'AGENTS.md').write_text('Base instructions\n')
        (self.repo / 'AGENTS.override.md').write_text('Effective instructions\n')
        self.assertEqual(self.providers[1].read_memory(str(self.repo)), 'Effective instructions\n')
        result = await self.sync.sync('ws', str(self.repo), consent=True)
        self.assertEqual(result.status, 'synced')
        self.assertEqual(await self.sync.read_central('ws'), 'Effective instructions\n')
        self.assertEqual((self.repo / 'AGENTS.md').read_text(), 'Base instructions\n')
        self.assertEqual((self.repo / 'CODEX.md').read_text(), 'Legacy instructions\n')

    async def test_failed_native_write_does_not_claim_success(self):
        (self.repo / 'AGENTS.md').mkdir()
        await self.sync.write_central('ws', 'Must reach the CLI\n')
        result = await self.sync.sync('ws', str(self.repo), consent=True)
        self.assertEqual(result.status, 'error')
        self.assertIn('AGENTS.md', result.error)

    async def test_structured_memory_entries_only_mirror_own_workspace(self):
        await self.manager.save('Own', 'project', 'PROJECT-314', workspace_id='ws')
        await self.manager.save('Other', 'project', 'OTHER-728', workspace_id='other')
        await self.manager.save('Global', 'user', 'GLOBAL-918')
        result = await self.sync.sync_entries_to_project_memory('ws', str(self.repo), consent=True)
        self.assertEqual(result.status, 'synced')
        for name in ('CLAUDE.md', 'AGENTS.md'):
            text = (self.repo / name).read_text()
            self.assertIn('PROJECT-314', text)
            self.assertNotIn('OTHER-728', text)
            self.assertNotIn('GLOBAL-918', text)

    async def test_attached_guideline_is_pending_until_prompt_is_started(self):
        created = await self.api.create_guideline(Request({'name': 'Explain terms', 'content': 'Explain terms plainly.'}))
        self.assertEqual(created.status, 201)
        gid = json.loads(created.text)['id']
        response = await self.api.set_session_guidelines(Request({'guideline_ids': [gid]}, id='session'))
        self.assertEqual(response.status, 200)
        response = await self.api.get_session_guidelines(Request(id='session'))
        self.assertEqual(json.loads(response.text)['active_guideline_ids'], [])
        with patch.object(session_capabilities, '_installed_skills', AsyncMock(return_value=[])):
            rows = await session_capabilities.collect_session_capabilities(self.db, {
                'id': 'session', 'workspace_id': 'ws', 'cli_type': 'claude', 'status': 'running',
                'active_guideline_ids': '[]',
            }, environ={})
        item = next(row for row in rows if row['kind'] == 'guideline' and row['source']['ref'] == gid)
        self.assertFalse(item['detail']['active'])

    async def test_mcp_config_attach_and_capabilities_do_not_expose_credentials(self):
        created = await self.api.create_mcp_server(Request({
            'name': 'Audit local tool', 'server_name': 'audit-local', 'command': 'unused',
            'env': {'TOKEN': 'SENTINEL-NOT-A-REAL-SECRET'}, 'args': ['private-argument'],
        }))
        self.assertEqual(created.status, 201)
        mid = json.loads(created.text)['id']
        response = await self.api.set_session_mcp_servers(Request({'mcp_server_ids': [mid]}, id='session'))
        self.assertEqual(response.status, 200)
        response = await self.api.get_session_mcp_servers(Request(id='session'))
        self.assertEqual(json.loads(response.text)['active_mcp_server_ids'], [])
        with patch.object(session_capabilities, '_installed_skills', AsyncMock(return_value=[])):
            capabilities = await session_capabilities.collect_session_capabilities(self.db, {
                'id': 'session', 'workspace_id': 'ws', 'cli_type': 'claude',
            }, environ={})
        text = json.dumps(capabilities)
        self.assertNotIn('SENTINEL-NOT-A-REAL-SECRET', text)
        self.assertNotIn('private-argument', text)
        item = next(row for row in capabilities if row['kind'] == 'mcp_server' and row['name'] == 'audit-local')
        self.assertEqual(item['detail']['env_keys'], ['TOKEN'])
        self.assertFalse(item['detail']['active'])

    async def test_runtime_guidance_detects_normal_javascript_and_python_repo(self):
        (self.repo / 'package.json').write_text(json.dumps({'scripts': {'test': 'node --test', 'build': 'vite build'}}))
        (self.repo / 'pnpm-lock.yaml').write_text('lockfileVersion: 9\n')
        (self.repo / 'requirements.txt').write_text('pytest\n')
        result = workspace_runtime.detect_workspace_runtime_env(self.repo)
        self.assertTrue(result['ok'])
        self.assertIn('javascript', result['sections'])
        self.assertIn('python', result['sections'])
        self.assertIn('pnpm run test', result['prompt'])
        self.assertIn('pnpm run build', result['prompt'])

    async def test_local_skill_install_discovery_and_removal(self):
        content = '---\nname: Explain tests\ndescription: Explain the test result.\n---\nExplain failed assertions plainly.\n'
        result = await skill_installer.install_skill('Explain tests', content,
                                                     workspace_path=str(self.repo), cli_types=['claude', 'codex'])
        self.assertTrue(all(item['ok'] for item in result.values()))
        listed = skill_installer.list_installed_skills(str(self.repo), scope='project')
        item = next(item for item in listed if item['slug'] == 'explain-tests')
        self.assertEqual(set(item['installed_for']), {'claude', 'codex'})
        result = await skill_installer.uninstall_skill('Explain tests',
                                                       workspace_path=str(self.repo), cli_types=['claude', 'codex'])
        self.assertTrue(all(item['removed'] for item in result.values()))
        self.assertEqual(skill_installer.list_installed_skills(str(self.repo), scope='project'), [])


if __name__ == '__main__':
    unittest.main()
