"""Session snapshot isolation, native transcript and database fallback."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, patch
import aiosqlite
import server


class SessionContextTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = str(Path(self.temp.name) / 'test.db')
        async with aiosqlite.connect(self.path) as db:
            await db.executescript('''
                CREATE TABLE workspaces (id TEXT, name TEXT, path TEXT);
                CREATE TABLE sessions (id TEXT, workspace_id TEXT, name TEXT, status TEXT, task_id TEXT, active_ticket_id TEXT, native_session_id TEXT, cli_type TEXT);
                CREATE TABLE tasks (id TEXT, workspace_id TEXT, title TEXT, description TEXT, status TEXT);
                CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, created_at TEXT);
                INSERT INTO workspaces VALUES ('w','Website','/isolated/website');
                INSERT INTO sessions VALUES ('s','w','Checkout','working','task',NULL,NULL,'claude');
                INSERT INTO tasks VALUES ('task','w','Fix checkout','Keep the API stable','in_progress');
                INSERT INTO messages VALUES ('s','user','Preserve existing orders','2026-10-15T10:00:00Z');
                INSERT INTO messages VALUES ('other','user','OTHER_SESSION_PRIVATE','2026-10-15T10:01:00Z');
            ''')
            await db.commit()
        async def connect():
            db = await aiosqlite.connect(self.path)
            db.row_factory = aiosqlite.Row
            return db
        self.patch = patch('server.get_db', side_effect=connect)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    async def test_snapshot_contains_only_selected_session_and_task_without_writes(self):
        before = Path(self.path).read_bytes()
        result = await server._sidechat_session_context('s')
        self.assertEqual(result['task']['title'], 'Fix checkout')
        self.assertEqual(result['recent_conversation'][0]['content'], 'Preserve existing orders')
        self.assertNotIn('OTHER_SESSION_PRIVATE', json.dumps(result))
        self.assertEqual(Path(self.path).read_bytes(), before)
        with self.assertRaises(ValueError):
            await server._sidechat_session_context('gone')

    async def test_native_transcript_takes_precedence_and_uses_account_home(self):
        async with aiosqlite.connect(self.path) as db:
            await db.execute("UPDATE sessions SET native_session_id='native'")
            await db.commit()
        transcript = Path(self.temp.name) / 'native.jsonl'
        transcript.write_text('')
        payload = json.dumps({'rows': [{'role': 'assistant', 'content': 'Latest native reply'}], 'cursor': '1:1', 'total': 1}).encode()
        with patch('server._session_transcript_home', return_value='/isolated/account'), \
             patch('server._get_native_transcript_path', return_value=transcript) as locate, \
             patch('server._transcript_rows_payload', return_value=payload):
            result = await server._sidechat_session_context('s')
        self.assertEqual(result['recent_conversation'][0]['content'], 'Latest native reply')
        self.assertEqual(locate.call_args.kwargs['cli_home'], '/isolated/account')


if __name__ == '__main__':
    unittest.main()
