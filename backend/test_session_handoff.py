"""Lossless handoffs and fresh sessions without a second provider call."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import db as database
from session_handoff import write_handoff, MAX_NOTE_CHARS

class HandoffFilesTests(unittest.TestCase):
    def test_long_history_keeps_exact_instructions_errors_and_rejected_work(self):
        with tempfile.TemporaryDirectory() as directory:
            records = [
                {'role':'user','content':'Never change the API contract. ' + 'Early instructions. '*800},
                {'role':'assistant','content':[{'type':'tool_result','content':'ERR_EXACT_719: expected 7, got 19\n' + 'trace\n'*1000}]},
                {'role':'user','content':'Rejected: do not retry the cached-token workaround.'},
                *[{'role':'assistant','content':str(i)+'x'*600} for i in range(500)],
                {'role':'user','content':'Continue the regression fix. '*500},
                {'role':'assistant','content':'Tests passed; packaging remains. '*800},
            ]
            source = {'id':'source','workspace_path':'/repo','system_prompt':'Exact instruction '*1000}
            digest = {'decisions':['Do not repeat approach A.']*100}
            first = write_handoff(Path(directory)/'handoffs', source, records, digest, records[:1])
            note = Path(first['path'])
            self.assertEqual(first['model_calls'],0)
            self.assertLess(first['prompt_chars'],1100)
            self.assertLessEqual(first['note_chars'],MAX_NOTE_CHARS)
            self.assertEqual([json.loads(x) for x in (note.parent/'transcript.jsonl').read_text().splitlines()],records)
            self.assertEqual(json.loads((note.parent/'context.json').read_text())['system_prompt'],source['system_prompt'])
            self.assertIn('transcript.jsonl:1',note.read_text())
            self.assertIn('Rejected: do not retry',(note.parent/'INDEX.md').read_text())
            modified=note.stat().st_mtime_ns
            self.assertEqual(write_handoff(Path(directory)/'handoffs',source,records,digest,records[:1]),first)
            self.assertEqual(note.stat().st_mtime_ns,modified)
            self.assertEqual(note.stat().st_mode&0o777,0o600)
            self.assertEqual(note.parent.stat().st_mode&0o777,0o700)
            changed=write_handoff(Path(directory)/'handoffs',source,records+[{'role':'user','content':'A new correction'}])
            self.assertNotEqual(changed['path'],first['path'])
            self.assertTrue(note.exists())

    def test_native_codex_and_claude_records_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            rows=[{'type':'user','message':{'role':'user','content':'Keep error E123 exactly.'}},
                  {'type':'response_item','payload':{'type':'function_call_output','call_id':'c1','output':'E123 exact failure'}},
                  {'type':'assistant','message':{'role':'assistant','content':[{'type':'tool_use','name':'Bash','input':{'command':'run tests'}}]}}]
            result=write_handoff(Path(directory),{'id':'native'},rows)
            self.assertEqual([json.loads(x) for x in (Path(result['path']).parent/'transcript.jsonl').read_text().splitlines()],rows)

class FreshSessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import server,config
        self.server=server
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        for module,name,value in [(database,'DATA_DIR',self.root),(database,'DB_PATH',self.root/'state.db'),(config,'DATA_DIR',self.root)]:
            p=patch.object(module,name,value);p.start();self.addCleanup(p.stop)
        await database.init_db()
        self.db=await database.get_db();self.addAsyncCleanup(self.db.close)
        await self.db.execute("INSERT INTO workspaces(id,name,path) VALUES ('w','Test',?)",(str(self.root),))
        await self.db.execute("""INSERT INTO sessions(id,workspace_id,name,cli_type,model,effort,permission_mode,native_session_id,system_prompt,scratchpad,status)
            VALUES ('s','w','Fix','claude','sonnet','high','default','native-1','Keep early rules exactly','Rejected attempt: A','idle')""")
        await self.db.execute("INSERT INTO messages(id,session_id,role,content) VALUES (1,'s','user','Keep the exact failure ERR-42')")
        await self.db.commit()
        async def session_config(sid):
            row=await (await self.db.execute('SELECT s.*, w.path AS workspace_path FROM sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE s.id=?',(sid,))).fetchone()
            return dict(row) if row else None
        for p in [patch.object(server,'get_session_config',session_config),patch.object(server,'_session_visible_to_request',return_value=True),
                  patch.object(server,'_get_native_transcript_path',return_value=None),patch.object(server.pty_mgr,'is_alive',return_value=False),
                  patch('llm_router.call_json',AsyncMock(side_effect=AssertionError('No paid handoff call')))]:
            p.start();self.addCleanup(p.stop)
    def request(self,mode):
        return SimpleNamespace(match_info={'id':'s'},headers={},json=AsyncMock(return_value={'context_mode':mode}))
    async def test_handoff_keeps_original_and_model_but_starts_empty_native_context(self):
        result=await self.server.clone_session(self.request('handoff'))
        self.assertEqual(result.status,201,result.text)
        created=json.loads(result.text)
        self.assertIsNone(created['native_session_id'])
        self.assertEqual((created['model'],created['effort'],created['permission_mode']),('sonnet','high','default'))
        self.assertIn('[IVE file-backed handoff]',created['system_prompt'])
        self.assertNotIn('ERR-42',created['system_prompt'])
        self.assertIsNone(created['scratchpad'])
        self.assertTrue(Path(created['handoff']['path']).is_file())
        old=await (await self.db.execute("SELECT native_session_id,system_prompt,scratchpad FROM sessions WHERE id='s'")).fetchone()
        self.assertEqual(tuple(old),('native-1','Keep early rules exactly','Rejected attempt: A'))
        self.assertEqual((await (await self.db.execute("SELECT COUNT(*) FROM messages WHERE session_id='s'")).fetchone())[0],1)
    async def test_new_topic_does_not_carry_previous_task(self):
        result=await self.server.clone_session(self.request('empty'))
        self.assertEqual(result.status,201,result.text)
        created=json.loads(result.text)
        self.assertIsNone(created['system_prompt']);self.assertIsNone(created['native_session_id']);self.assertIsNone(created['scratchpad'])
        self.assertNotIn('handoff',created)
        self.assertFalse((self.root/'handoffs').exists())
    async def test_busy_and_invisible_sources_are_not_copied(self):
        with patch.object(self.server.pty_mgr,'is_alive',return_value=True),patch('hooks.get_session_logical_status',return_value='working'):
            self.assertEqual((await self.server.clone_session(self.request('handoff'))).status,409)
        with patch.object(self.server,'_session_visible_to_request',return_value=False):
            self.assertEqual((await self.server.clone_session(self.request('handoff'))).status,404)
        self.assertEqual((await (await self.db.execute('SELECT COUNT(*) FROM sessions')).fetchone())[0],1)
    async def test_failed_snapshot_never_creates_a_partial_session(self):
        with patch.object(self.server,'_prepare_session_handoff',AsyncMock(side_effect=OSError('disk full'))):
            self.assertEqual((await self.server.clone_session(self.request('handoff'))).status,500)
        self.assertEqual((await (await self.db.execute('SELECT COUNT(*) FROM sessions')).fetchone())[0],1)

if __name__=='__main__':unittest.main()
