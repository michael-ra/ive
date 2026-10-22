"""Claude worktree history and launch regression; temporary Git/SQLite/HOME only."""
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import aiosqlite
from cli_session import UnifiedSession
from ive_cli_profile import claude_project_dirname
import server
from test_task_flow import server_functions


class WorktreeHistoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.worktree = self.repo / '.claude' / 'worktrees' / 'review-branch'
        git = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false']
        for args in [['-c', 'init.templateDir=', 'init'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '--allow-empty', '-m', 'fixture'], ['worktree', 'add', '-b', 'review-branch', str(self.worktree)]]:
            subprocess.run(git + args, cwd=self.repo, check=True, capture_output=True)
        self.home = self.root / 'home'
        self.native = 'test-worktree-native-id'
        self.transcript = self.history_path(self.worktree)
        self.write_history(self.transcript, self.worktree)
        self.db_path = self.root / 'fixture.db'
        async with aiosqlite.connect(self.db_path) as db:
            await db.executescript('''
                CREATE TABLE workspaces(id TEXT, path TEXT, sandbox_type TEXT, sandbox_network INT, alloy_enabled INT);
                CREATE TABLE sessions(id TEXT, workspace_id TEXT, cli_type TEXT, native_session_id TEXT, worktree INT, account_id TEXT, session_type TEXT);
            ''')
            await db.execute("INSERT INTO workspaces VALUES('ws',?,NULL,NULL,0)", (str(self.repo),))
            await db.execute("INSERT INTO sessions VALUES('worktree-session','ws','claude',?,1,NULL,'tester')", (self.native,))
            await db.commit()
        async def get_db():
            db = await aiosqlite.connect(self.db_path)
            db.row_factory = aiosqlite.Row
            return db
        self.get_db = get_db
        for name, value in [
            ('get_db', get_db),
            ('candidate_data_dirs', lambda cli: [self.home / '.claude']),
            ('ACCOUNT_HOMES_DIR', self.root / 'empty-accounts'),
            ('_get_project_dir', lambda workspace: self.home / '.claude' / 'projects' / claude_project_dirname(workspace)),
        ]:
            p = patch.object(server, name, value); p.start(); self.addCleanup(p.stop)

    def history_path(self, cwd):
        return self.home / '.claude' / 'projects' / claude_project_dirname(str(cwd)) / f'{self.native}.jsonl'

    def write_history(self, path, cwd):
        path.parent.mkdir(parents=True, exist_ok=True)
        rows = [
            {'type': 'user', 'sessionId': self.native, 'cwd': str(cwd), 'message': {'role': 'user', 'content': 'Remember ORBIT-624'}},
            {'type': 'assistant', 'sessionId': self.native, 'cwd': str(cwd), 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'ORBIT-624 remembered'}]}},
        ]
        path.write_text(''.join(json.dumps(row) + '\n' for row in rows))

    def config(self):
        return {'cli_type': 'claude', 'workspace_path': str(self.repo), 'native_session_id': self.native, 'worktree': 1}

    async def test_parent_workspace_reads_live_worktree_answers_over_stale_parent_copy(self):
        stale = self.history_path(self.repo)
        self.write_history(stale, self.repo)
        os.utime(stale, (1, 1))
        resolved = server._get_native_transcript_path('claude', str(self.repo), self.native)
        self.assertEqual(resolved, self.transcript)
        rows = json.loads(server._transcript_rows_payload(resolved, 'worktree-session', None))
        self.assertEqual([row['role'] for row in rows], ['user', 'assistant'])
        self.assertIn('ORBIT-624 remembered', rows[1]['content'])
        self.assertIn(str(self.transcript), server._snapshot_jsonl_files(str(self.repo)))

    async def test_resume_uses_existing_worktree_and_initial_autostart_creates_one(self):
        manager = SimpleNamespace(start_session=AsyncMock(), is_alive=Mock(return_value=True))
        assembly = server_functions('_autostart_session_pty',
            get_session_config=server.get_session_config, _prepare_session_cli_env=AsyncMock(return_value={'HOME': str(self.home)}),
            _apply_worker_safety_gate_permission=AsyncMock(return_value='plan'), _launch_model_for_session=AsyncMock(return_value='sonnet'), UnifiedSession=UnifiedSession,
            _record_session_runtime_home=AsyncMock(), _apply_session_resume=server._apply_session_resume, _apply_session_mcp=AsyncMock(return_value={'w2w': ('1','1','1')}), HOST='127.0.0.1', PORT=0,
            _snapshot_files_for_detection=Mock(return_value=[]), capture_proc=SimpleNamespace(clear_buffer=Mock()), mark_pty_started=Mock(), pty_mgr=manager,
            _mark_session_pty_started=AsyncMock(), _clear_auth_failed_session_state=AsyncMock(), broadcast=AsyncMock(), _session_cli_type_cache={}, _schedule_session_detection=Mock(),
            bus=SimpleNamespace(emit=AsyncMock()), CommanderEvent=SimpleNamespace(SESSION_FAILED_TO_START='failed'))
        with patch.dict('sys.modules', {'git_attribution': SimpleNamespace(inject_git_attribution_env=AsyncMock()), 'hooks': SimpleNamespace(get_session_logical_status=lambda *args: 'idle')}):
            self.assertTrue((await assembly._autostart_session_pty('worktree-session'))['ok'])
            args = manager.start_session.call_args.args
            self.assertEqual(args[1], str(self.worktree))
            self.assertNotIn('--worktree', args[4])
            self.assertEqual(args[4][args[4].index('--resume') + 1], self.native)
            async with aiosqlite.connect(self.db_path) as db:
                await db.execute('UPDATE sessions SET native_session_id=NULL')
                await db.commit()
            self.assertTrue((await assembly._autostart_session_pty('worktree-session'))['ok'])
            args = manager.start_session.call_args.args
            self.assertEqual(args[1], str(self.repo))
            self.assertIn('--worktree', args[4])
            self.assertNotIn('--resume', args[4])

    async def test_deleted_worktree_history_remains_readable_without_reusing_cwd(self):
        subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', 'worktree', 'remove', str(self.worktree)], cwd=self.repo, check=True, capture_output=True)
        self.assertEqual(server._get_native_transcript_path('claude', str(self.repo), self.native), self.transcript)
        self.assertIsNone(server._claude_resume_worktree(self.config()))
        self.assertEqual((await server.get_session_config('worktree-session'))['workspace_path'], str(self.repo))

    async def test_unrelated_history_or_record_cannot_redirect_resume(self):
        foreign = self.root / 'unrelated-repo'
        foreign.mkdir(); (foreign / '.git').mkdir()
        self.write_history(self.transcript, foreign)
        self.assertIsNone(server._claude_resume_worktree(self.config()))
        self.transcript.unlink()
        self.write_history(self.history_path(foreign), foreign)
        resolved = server._get_native_transcript_path('claude', str(self.repo), self.native)
        self.assertFalse(resolved.exists())
        self.assertIsNone(server._claude_resume_worktree(self.config()))


if __name__ == '__main__':
    unittest.main()
