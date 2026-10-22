"""Real SQLite regressions for implementation assignment and MCP task access."""
import asyncio
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import db as database
import pipeline_engine as engine
from test_worker_context_contract import load_functions
import urllib.parse


class PipelineTaskBindingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory(prefix='ive-task-binding-')
        self.addCleanup(self.tmp.cleanup)
        for key, value in [('DATA_DIR',Path(self.tmp.name)), ('DB_PATH',Path(self.tmp.name)/'state.db')]:
            p=patch.object(database,key,value); p.start(); self.addCleanup(p.stop)
        await database.init_db()
        self.db=await database.get_db(); self.addAsyncCleanup(self.db.close)
        await self.db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws','Fixture',?)",(self.tmp.name,))
        await self.db.execute("INSERT INTO workspaces(id,name,path) VALUES('other','Other',?)",(str(Path(self.tmp.name)/'other'),))
        await self.db.execute("INSERT INTO tasks(id,workspace_id,title) VALUES('task','ws','Fixture')")
        for sid in ('worker','previous','second'):
            await self.db.execute("INSERT INTO sessions(id,workspace_id,name,task_id,session_type) VALUES(?,'ws',?,'task','worker')",(sid,sid))
        self.stages=[{'id':'implement','type':'agent','session_type':'worker','session_id':'worker','prompt_template':'Implement fixture'}]
        await self.db.execute("INSERT INTO pipeline_definitions(id,workspace_id,name,stages) VALUES('def','ws','Fixture',?)",(json.dumps(self.stages),))
        await self.run_row('run','worker')
        await self.db.commit()

    async def run_row(self,rid,sid,status='running',stage_status='running'):
        history={'implement':{'status':stage_status,'session_id':sid}}
        await self.db.execute("INSERT INTO pipeline_runs(id,pipeline_id,workspace_id,task_id,status,current_stages,stage_history) VALUES(?,'def','ws','task',?, '[\"implement\"]',?)",(rid,status,json.dumps(history)))

    async def assignee(self):
        return (await (await self.db.execute("SELECT assigned_session_id FROM tasks WHERE id='task'")).fetchone())[0]

    async def set_assignee(self,sid):
        await self.db.execute("UPDATE tasks SET assigned_session_id=? WHERE id='task'",(sid,)); await self.db.commit()

    async def test_implementation_binding_supports_omitted_read_and_strict_worker_update(self):
        self.assertTrue(await engine._bind_pipeline_worker_task('run','implement','worker'))
        self.assertEqual(await self.assignee(),'worker')
        task=dict(await (await self.db.execute("SELECT * FROM tasks WHERE id='task'")).fetchone())
        session=dict(await (await self.db.execute("SELECT * FROM sessions WHERE id='worker'")).fetchone())
        def respond(method,path,*body):
            if method=='PUT': return {'ok':True,**body[0]}
            return {'/sessions/worker':session,'/tasks/task':task,'/tasks/task/attachments':[]}.get(path)
        api=Mock(side_effect=respond)
        ns=load_functions('worker_mcp_server.py',{'_read_my_task','_is_my_task','tool_get_my_task','tool_update_my_task'},api_call=api,json=json,urllib=urllib,SESSION_ID='worker',WORKSPACE_ID='ws')
        self.assertEqual(json.loads(ns['tool_get_my_task']({}))['id'],'task')
        self.assertEqual(json.loads(ns['tool_update_my_task']({'task_id':'task','status':'in_progress'})),{'ok':True,'status':'in_progress'})
        self.assertEqual(api.call_args.args,('PUT','/tasks/task',{'status':'in_progress'}))

    async def test_planner_and_tester_stages_remain_read_only_task_bindings(self):
        for role in ('planner','tester','documentor'):
            self.stages[0]['session_type']=role
            await self.db.execute("UPDATE pipeline_definitions SET stages=?",(json.dumps(self.stages),)); await self.db.commit()
            self.assertTrue(await engine._bind_pipeline_worker_task('run','implement','worker'))
            self.assertIsNone(await self.assignee())

    async def test_workspace_task_and_actual_worker_role_are_required(self):
        for column,value in [('workspace_id','other'),('task_id',None),('session_type','planner')]:
            await self.db.execute(f"UPDATE sessions SET {column}=? WHERE id='worker'",(value,)); await self.db.commit()
            with self.assertRaisesRegex(ValueError,'workspace and task'):
                await engine._bind_pipeline_worker_task('run','implement','worker')
            self.assertIsNone(await self.assignee())
            await self.db.execute("UPDATE sessions SET workspace_id='ws',task_id='task',session_type='worker' WHERE id='worker'"); await self.db.commit()
        await self.db.execute("UPDATE tasks SET workspace_id='other' WHERE id='task'"); await self.db.commit()
        with self.assertRaises(ValueError): await engine._bind_pipeline_worker_task('run','implement','worker')

    async def test_worker_backed_code_reviewer_does_not_receive_task_mutation_rights(self):
        self.stages[0]['agent_config']={'role':'code_reviewer'}
        await self.db.execute("UPDATE pipeline_definitions SET stages=?",(json.dumps(self.stages),)); await self.db.commit()
        self.assertTrue(await engine._bind_pipeline_worker_task('run','implement','worker'))
        self.assertIsNone(await self.assignee())

    async def test_paused_cancelled_or_stale_stage_never_assigns(self):
        for status in ('paused','cancelled','completed'):
            await self.db.execute("UPDATE pipeline_runs SET status=? WHERE id='run'",(status,)); await self.db.commit()
            self.assertFalse(await engine._bind_pipeline_worker_task('run','implement','worker'))
            self.assertIsNone(await self.assignee())
        await self.db.execute("UPDATE pipeline_runs SET status='running',current_stages='[]' WHERE id='run'"); await self.db.commit()
        self.assertFalse(await engine._bind_pipeline_worker_task('run','implement','worker'))
        await self.db.execute("UPDATE pipeline_runs SET current_stages='[\"implement\"]' WHERE id='run'"); await self.db.commit()
        self.assertFalse(await engine._bind_pipeline_worker_task('run','implement','second'))

    async def test_unrelated_manual_assignee_is_never_overwritten(self):
        await self.set_assignee('previous')
        with self.assertRaisesRegex(ValueError,'assignment was preserved'):
            await engine._bind_pipeline_worker_task('run','implement','worker')
        self.assertEqual(await self.assignee(),'previous')

    async def test_completed_executor_can_hand_off_within_same_run(self):
        await self.set_assignee('previous')
        history={'implement':{'status':'running','session_id':'worker'},'previous':{'status':'completed','session_id':'previous'}}
        self.stages.append({'id':'previous','type':'agent','session_type':'worker'})
        await self.db.execute("UPDATE pipeline_definitions SET stages=?",(json.dumps(self.stages),))
        await self.db.execute("UPDATE pipeline_runs SET stage_history=? WHERE id='run'",(json.dumps(history),)); await self.db.commit()
        self.assertTrue(await engine._bind_pipeline_worker_task('run','implement','worker'))
        self.assertEqual(await self.assignee(),'worker')

    async def test_completed_past_run_cannot_authorize_new_assignment(self):
        await self.set_assignee('previous')
        await self.run_row('old','previous','completed','completed')
        await self.db.commit()
        with self.assertRaises(ValueError): await engine._bind_pipeline_worker_task('run','implement','worker')
        self.assertEqual(await self.assignee(),'previous')

    async def test_same_run_completed_executor_active_elsewhere_cannot_hand_off(self):
        await self.set_assignee('previous')
        history={'implement':{'status':'running','session_id':'worker'},'previous':{'status':'completed','session_id':'previous'}}
        self.stages.append({'id':'previous','type':'agent','session_type':'worker'})
        await self.db.execute("UPDATE pipeline_definitions SET stages=?",(json.dumps(self.stages),))
        await self.db.execute("UPDATE pipeline_runs SET stage_history=? WHERE id='run'",(json.dumps(history),))
        await self.run_row('active','previous','paused','running'); await self.db.commit()
        with self.assertRaises(ValueError): await engine._bind_pipeline_worker_task('run','implement','worker')
        self.assertEqual(await self.assignee(),'previous')

    async def test_concurrent_workers_cannot_both_claim_unassigned_task(self):
        await self.run_row('second-run','second'); await self.db.commit()
        results=await asyncio.gather(engine._bind_pipeline_worker_task('run','implement','worker'),engine._bind_pipeline_worker_task('second-run','implement','second'),return_exceptions=True)
        self.assertEqual(sum(result is True for result in results),1)
        self.assertEqual(sum(isinstance(result,ValueError) for result in results),1)
        self.assertIn(await self.assignee(),('worker','second'))

    async def test_dispatch_assigns_before_the_first_prompt_write(self):
        writes=[]
        async def binding(*args):
            result=await real_binding(*args)
            writes.append(('binding',await self.assignee()))
            return result
        real_binding=engine._bind_pipeline_worker_task
        manager=SimpleNamespace(is_alive=lambda _:True,write=lambda sid,data:writes.append(('write',data)) or True)
        run=await engine.get_run('run')
        async def no_review(prompt,*_):return prompt
        with patch.object(engine,'_pty_manager',manager),patch.object(engine,'_input_ready_fn',AsyncMock(return_value=True)),patch.object(engine,'_bind_pipeline_worker_task',binding),patch.object(engine,'_with_review_intent',no_review),patch.object(engine,'_broadcast_run',AsyncMock()):
            await engine._execute_agent_stage('run','implement',self.stages[0],run,{'stages':self.stages})
        self.assertEqual(writes[0],('binding','worker'))
        self.assertEqual([kind for kind,_ in writes],['binding','write','write'])
        engine._session_to_run.pop('worker',None)

    async def test_pause_or_cancel_winning_before_binding_sends_nothing_and_preserves_status(self):
        real_binding=engine._bind_pipeline_worker_task
        manager=SimpleNamespace(is_alive=lambda _:True,write=Mock(return_value=True))
        async def no_review(prompt,*_):return prompt
        for status in ('paused','cancelled'):
            await self.db.execute("UPDATE pipeline_runs SET status='running' WHERE id='run'"); await self.db.commit()
            run=await engine.get_run('run')
            async def pause_before_binding(*args):
                await self.db.execute("UPDATE pipeline_runs SET status=? WHERE id='run'",(status,)); await self.db.commit()
                return await real_binding(*args)
            with patch.object(engine,'_pty_manager',manager),patch.object(engine,'_input_ready_fn',AsyncMock(return_value=True)),patch.object(engine,'_bind_pipeline_worker_task',pause_before_binding),patch.object(engine,'_with_review_intent',no_review),patch.object(engine,'_fail_stage',AsyncMock()) as fail:
                await engine._execute_agent_stage('run','implement',self.stages[0],run,{'stages':self.stages})
            self.assertEqual((await engine.get_run('run'))['status'],status)
            self.assertIsNone(await self.assignee())
            fail.assert_not_awaited()
        manager.write.assert_not_called()

if __name__=='__main__':unittest.main()
