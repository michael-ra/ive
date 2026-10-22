"""Rerun an owned task without rebinding another task/session or resuming revoked work."""
import asyncio
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import db as database
import hooks
import pipeline_engine as engine
from test_worker_context_contract import load_functions


class AssigneeReuseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory(prefix='ive-assignee-reuse-'); self.addCleanup(self.tmp.cleanup)
        for key,value in [('DATA_DIR',Path(self.tmp.name)),('DB_PATH',Path(self.tmp.name)/'state.db')]:
            p=patch.object(database,key,value);p.start();self.addCleanup(p.stop)
        await database.init_db(); self.db=await database.get_db();self.addAsyncCleanup(self.db.close)
        await self.db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws','Fixture',?)",(self.tmp.name,))
        await self.db.execute("INSERT INTO workspaces(id,name,path) VALUES('other','Other',?)",(str(Path(self.tmp.name)/'other'),))
        await self.db.execute("INSERT INTO tasks(id,workspace_id,title,status) VALUES('task','ws','Rerun fixture','done')")
        await self.db.execute("INSERT INTO tasks(id,workspace_id,title) VALUES('other-task','ws','Different assignment')")
        await self.db.execute("INSERT INTO sessions(id,workspace_id,name,task_id,session_type,status) VALUES('worker','ws','Original executor','task','worker','idle')")
        await self.db.execute("UPDATE tasks SET assigned_session_id='worker' WHERE id='task'")
        await self.db.execute("INSERT INTO pipeline_runs(id,workspace_id,task_id,status,stage_history) VALUES('old-run','ws','task','completed','{}')")
        await self.db.commit()
        self.pty=SimpleNamespace(is_alive=Mock(return_value=True),write=Mock(return_value=True))
        self.status=Mock(return_value='idle')
        p=patch.object(hooks,'get_session_logical_status',self.status);p.start();self.addCleanup(p.stop)
        for key,value in [('_pty_manager',self.pty),('_pty_start_fn',AsyncMock()),('_input_ready_fn',AsyncMock(return_value=True)),
                          ('_session_to_run',{}),('_active_runs',{}),('_pipeline_task_ids',set()),
                          ('_task_execution_lock',asyncio.Lock()),('_state_lock',asyncio.Lock()),
                          ('_schedule_stage',Mock()),('_broadcast_fn',AsyncMock()),('bus',SimpleNamespace(emit=AsyncMock()))]:
            p=patch.object(engine,key,value);p.start();self.addCleanup(p.stop)

    async def start(self):
        return await engine.start_task_execution_pipeline('task',options={'plan_first':False,'test_with_agent':True,'require_result_review':True})

    async def stage(self,run):
        definition=await engine.get_definition(run['pipeline_id'])
        stage=next(s for s in definition['stages'] if s['id']=='implement')
        return definition,stage

    async def dispatch(self,run):
        definition,stage=await self.stage(run)
        await engine._update_stage_status(run['id'],'implement','running')
        async def no_review(prompt,*_): return prompt
        with patch.object(engine,'_with_review_intent',no_review):
            await engine._execute_agent_stage(run['id'],'implement',stage,await engine.get_run(run['id']),definition)

    async def test_new_run_reuses_exact_existing_worker_and_does_not_create_session(self):
        run=await self.start(); self.assertNotEqual(run['id'],'old-run')
        _,stage=await self.stage(run)
        self.assertEqual(stage['session_id'],'worker'); self.assertFalse(stage['fresh_session'])
        self.assertTrue(stage['config']['require_existing_assignment'])
        await self.dispatch(run)
        self.assertEqual(self.pty.write.call_count,2)
        self.assertEqual({c.args[0] for c in self.pty.write.call_args_list},{'worker'})
        self.assertEqual((await self.db.execute_fetchall('SELECT count(*) FROM sessions'))[0][0],1)
        self.assertEqual((await self.db.execute_fetchall("SELECT assigned_session_id FROM tasks WHERE id='task'"))[0][0],'worker')

    async def test_stopped_own_worker_is_restarted_before_readiness_and_delivery(self):
        self.pty.is_alive.return_value=False
        self.status.side_effect=lambda sid,alive,db_status:'idle' if alive else 'stopped'
        async def start(sid): self.pty.is_alive.return_value=True
        engine._pty_start_fn.side_effect=start
        run=await self.start(); await self.dispatch(run)
        engine._pty_start_fn.assert_awaited_once_with('worker')
        engine._input_ready_fn.assert_awaited_once_with('worker','claude',30)
        self.assertEqual(self.pty.write.call_count,2)

    async def test_busy_or_permission_waiting_worker_does_not_create_run_or_change_task(self):
        for status in ('running','waiting','error'):
            self.status.return_value=status
            with self.assertRaises(engine.TaskAssigneeReuseError): await self.start()
        self.assertEqual((await self.db.execute_fetchall('SELECT count(*) FROM pipeline_runs'))[0][0],1)
        self.assertEqual((await self.db.execute_fetchall("SELECT status FROM tasks WHERE id='task'"))[0][0],'done')
        self.pty.write.assert_not_called()

    async def test_wrong_workspace_role_or_other_task_is_not_rebound(self):
        for column,value in [('workspace_id','other'),('session_type','planner'),('task_id','other-task'),('task_id',None)]:
            await self.db.execute(f"UPDATE sessions SET {column}=? WHERE id='worker'",(value,));await self.db.commit()
            with self.assertRaises(engine.TaskAssigneeReuseError): await self.start()
            row=(await self.db.execute_fetchall("SELECT * FROM sessions WHERE id='worker'"))[0]
            self.assertEqual(row[column],value)
            await self.db.execute("UPDATE sessions SET workspace_id='ws',session_type='worker',task_id='task' WHERE id='worker'");await self.db.commit()
        self.assertEqual((await self.db.execute_fetchall('SELECT count(*) FROM pipeline_runs'))[0][0],1)

    async def test_other_active_or_paused_pipeline_ownership_prevents_reuse(self):
        history=json.dumps({'work':{'status':'running','session_id':'worker'}})
        await self.db.execute("INSERT INTO pipeline_runs(id,workspace_id,task_id,status,stage_history) VALUES('other-run','ws','other-task','paused',?)",(history,));await self.db.commit()
        with self.assertRaisesRegex(engine.TaskAssigneeReuseError,'another pipeline'): await self.start()
        self.pty.write.assert_not_called()

    async def test_assignment_revoked_after_start_is_not_recreated(self):
        run=await self.start()
        await self.db.execute("UPDATE tasks SET assigned_session_id=NULL WHERE id='task'");await self.db.commit()
        with self.assertRaises(engine.TaskAssigneeReuseError): await self.dispatch(run)
        self.pty.write.assert_not_called(); engine._pty_start_fn.assert_not_awaited()
        self.assertIsNone((await self.db.execute_fetchall("SELECT assigned_session_id FROM tasks WHERE id='task'"))[0][0])

    async def test_worker_rebound_to_another_task_while_planning_is_not_overwritten(self):
        run=await self.start()
        await self.db.execute("UPDATE sessions SET task_id='other-task' WHERE id='worker'");await self.db.commit()
        with self.assertRaises(engine.TaskAssigneeReuseError): await self.dispatch(run)
        self.pty.write.assert_not_called()
        self.assertEqual((await self.db.execute_fetchall("SELECT task_id FROM sessions WHERE id='worker'"))[0][0],'other-task')

    async def test_assignment_revoked_during_readiness_is_checked_before_first_write(self):
        run=await self.start()
        async def revoke(*_):
            await self.db.execute("UPDATE tasks SET assigned_session_id=NULL WHERE id='task'");await self.db.commit();return True
        engine._input_ready_fn.side_effect=revoke
        with self.assertRaises(engine.TaskAssigneeReuseError): await self.dispatch(run)
        self.pty.write.assert_not_called()
        self.assertIsNone((await self.db.execute_fetchall("SELECT assigned_session_id FROM tasks WHERE id='task'"))[0][0])

    async def test_busy_assignee_api_error_is_explicit_conflict(self):
        self.status.return_value='running'
        ns=load_functions('server.py',{'execute_task_pipeline'},web=web,json=json,
            _task_readiness=AsyncMock(return_value={'ready':True}))
        app=web.Application();app.router.add_post('/tasks/{id}/execute',ns['execute_task_pipeline'])
        client=TestClient(TestServer(app));await client.start_server();self.addAsyncCleanup(client.close)
        response=await client.post('/tasks/task/execute',json={'plan_first':False})
        self.assertEqual(response.status,409);self.assertIn('busy',(await response.json())['error'])


if __name__=='__main__':unittest.main()
