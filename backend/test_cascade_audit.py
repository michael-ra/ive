"""Cascade delivery tests in disposable SQLite state and mocked PTYs."""
import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock,Mock,patch
import db as database
import cascade_runner as cascade

class CascadeAuditTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        for name,value in [('DATA_DIR',Path(self.tmp.name)),('DB_PATH',Path(self.tmp.name)/'state.db')]:
            p=patch.object(database,name,value);p.start();self.addCleanup(p.stop)
        await database.init_db();self.db=await database.get_db();self.addAsyncCleanup(self.db.close)
        await self.db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws','Cascade fixture',?)",(self.tmp.name,))
        await self.db.execute("INSERT INTO sessions(id,workspace_id,name) VALUES('s','ws','Cascade fixture')");await self.db.commit()
        p=patch.object(cascade,'_broadcast',AsyncMock());p.start();self.addCleanup(p.stop)

    async def test_invalid_steps_rejected_before_creation(self):
        for steps in [[],[''],['  '],['okay',None],'not a list']:
            with self.assertRaises(ValueError):await cascade.start_run('s',steps=steps)
        row=await (await self.db.execute('SELECT count(*) FROM cascade_runs')).fetchone()
        self.assertEqual(row[0],0)

    async def test_missing_manager_and_dead_session_fail_visibly(self):
        for manager in [None,SimpleNamespace(is_alive=lambda sid:False)]:
            with patch.object(cascade,'_pty_manager',manager):
                run=await cascade.start_run('s',steps=['hello'])
                self.assertEqual(run['status'],'failed');self.assertTrue(run['error'])

    async def test_rejected_text_and_submit_never_report_delivery(self):
        for replies in [[False],[True,False]]:
            manager=SimpleNamespace(is_alive=lambda sid:True,write=Mock(side_effect=replies))
            with patch.object(cascade,'_pty_manager',manager):
                run=await cascade.start_run('s',steps=['hello'])
                self.assertEqual(run['status'],'failed');self.assertTrue(run['error'])

    async def test_stop_during_paste_prevents_late_submit(self):
        typed=asyncio.Event()
        def write(sid,data):typed.set();return True
        manager=SimpleNamespace(is_alive=lambda sid:True,write=Mock(side_effect=write))
        with patch.object(cascade,'_pty_manager',manager):
            task=asyncio.create_task(cascade.start_run('s',steps=['hello']))
            await typed.wait()
            row=await (await self.db.execute('SELECT id FROM cascade_runs')).fetchone()
            await cascade.stop_run(row[0]);result=await task
            self.assertEqual(result['status'],'stopped')
            self.assertEqual(manager.write.call_count,1)

    async def test_multiline_is_one_paste_for_claude_and_codex(self):
        prompt='First line\nSecond line\r\nÜnicode'
        for cli_type in ['claude','codex']:
            await self.db.execute("UPDATE sessions SET cli_type=? WHERE id='s'",(cli_type,));await self.db.commit()
            manager=SimpleNamespace(is_alive=lambda sid:True,write=Mock(return_value=True))
            with patch.object(cascade,'_pty_manager',manager):
                run=await cascade.start_run('s',steps=[prompt])
            self.assertEqual(run['status'],'waiting_idle')
            self.assertEqual([c.args[1] for c in manager.write.call_args_list],[b'\x1b[200~'+prompt.encode()+b'\x1b[201~',b'\r'])

    async def test_gemini_multiline_is_flattened_before_separate_submit(self):
        await self.db.execute("UPDATE sessions SET cli_type='gemini' WHERE id='s'");await self.db.commit()
        manager=SimpleNamespace(is_alive=lambda sid:True,write=Mock(return_value=True))
        with patch.object(cascade,'_pty_manager',manager):
            run=await cascade.start_run('s',steps=['First\nSecond\rThird'])
        self.assertEqual(run['status'],'waiting_idle')
        self.assertEqual([c.args[1] for c in manager.write.call_args_list],[b'First Second Third',b'\r'])

    async def test_successful_step_advances_and_finishes(self):
        manager=SimpleNamespace(is_alive=lambda sid:True,write=Mock(return_value=True))
        with patch.object(cascade,'_pty_manager',manager):
            run=await cascade.start_run('s',steps=['first','second'])
            self.assertEqual(run['status'],'waiting_idle')
            await cascade._advance(run['id'])
            current=await cascade.get_run(run['id']);self.assertEqual(current['current_step'],1)
            await cascade._advance(run['id'])
            self.assertEqual((await cascade.get_run(run['id']))['status'],'completed')
            self.assertEqual([c.args[1] for c in manager.write.call_args_list],[b'first',b'\r',b'second',b'\r'])

if __name__=='__main__':unittest.main()
