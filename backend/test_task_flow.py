"""Isolated task pipeline / retry tests. Never starts a real CLI or touches user data."""
import ast
import asyncio
import json
import logging
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import AsyncMock, Mock, patch
from aiohttp import web
import db as database
import pipeline_engine as engine


def server_functions(*names, **dependencies):
    tree = ast.parse(Path(__file__).with_name('server.py').read_text())
    subset = ast.Module(body=[node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names], type_ignores=[])
    namespace = dict(web=web, uuid=uuid, json=json, asyncio=asyncio, logger=logging.getLogger('test'), **dependencies)
    exec(compile(subset, 'server.py', 'exec'), namespace)
    return SimpleNamespace(**{name: namespace[name] for name in names})


class TaskFlowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.initial_stage_jobs = set(engine._stage_jobs.values())
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for target, value in [('DATA_DIR', Path(self.tmp.name)), ('DB_PATH', Path(self.tmp.name)/'test.db')]:
            p = patch.object(database, target, value); p.start(); self.addCleanup(p.stop)
        await database.init_db()
        self.db = await database.get_db()
        await self.db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws','Test',?)", (self.tmp.name,))
        await self.db.execute("INSERT INTO tasks(id,workspace_id,title,status) VALUES('task','ws','Improve checkout','backlog')")
        await self.db.commit()
        self.addAsyncCleanup(self.db.close)
        engine._task_execution_lock = asyncio.Lock()
        engine._state_lock = asyncio.Lock()
        engine._active_runs.clear()
        engine._pipeline_task_ids.clear()
        self.events = SimpleNamespace(emit=AsyncMock())
        p = patch.object(engine, 'bus', self.events);p.start();self.addCleanup(p.stop)
        p = patch.object(engine, '_broadcast_fn', AsyncMock());p.start();self.addCleanup(p.stop)

    async def asyncTearDown(self):
        # A terminal DB status is committed before the stage coroutine's final
        # broadcasts/connections finish. Await owned work while this DB exists.
        deadline = asyncio.get_running_loop().time() + 3
        while True:
            await asyncio.sleep(0)  # Let a scheduled next-stage callback register.
            jobs = set(engine._stage_jobs.values()) - self.initial_stage_jobs
            if not jobs:
                break
            remaining = deadline - asyncio.get_running_loop().time()
            self.assertGreater(remaining, 0, "Pipeline fixture jobs did not settle")
            await asyncio.wait_for(asyncio.gather(*jobs), timeout=remaining)

    async def task(self):
        return dict(await (await self.db.execute("SELECT * FROM tasks WHERE id='task'")).fetchone())

    async def wait_status(self, run_id, statuses):
        for _ in range(200):
            run = await engine.get_run(run_id)
            if run['status'] in statuses: return run
            await asyncio.sleep(.01)
        self.fail(f"Run never reached {statuses}: {run}")

    async def test_guided_plan_approval_failed_verification_fix_and_review(self):
        called = []
        async def agent(run_id, stage_id, *args):
            called.append(stage_id)
            result = 'fail' if stage_id == 'verify' and called.count('verify') == 1 else 'pass'
            await engine._update_stage_status(run_id, stage_id, 'completed', output_summary=f'__pipeline_result:{result}:Evidence for {stage_id}')
            await engine._complete_stage(run_id, stage_id)
        with patch.object(engine, '_execute_agent_stage', agent):
            run = await engine.start_task_execution_pipeline('task', options={'plan_first': True, 'auto_approve_plan': False, 'test_with_agent': True, 'ralph_loop': True, 'require_result_review': True, 'pipeline_max_iterations': 3})
            paused = await self.wait_status(run['id'], ['paused'])
            self.assertEqual(called, ['plan', 'plan_critic'])
            self.assertEqual((await self.task())['pipeline_stage'], 'awaiting_plan_approval')
            self.assertIn('Evidence for plan', paused['stage_history']['plan']['output_summary'])
            await engine.resume_run(run['id'])
            done = await self.wait_status(run['id'], ['completed', 'failed', 'max_iterations'])
            self.assertEqual(done['status'], 'completed')
            self.assertEqual(called, ['plan', 'plan_critic', 'implement', 'verify', 'fix', 'verify'])
            self.assertEqual((await self.task())['status'], 'review')
            self.assertTrue(done['stage_history']['verify']['output_summary'].startswith('__pipeline_result:pass:'))

    async def test_legacy_verified_execution_still_completes(self):
        async def agent(run_id, stage_id, *args):
            await engine._update_stage_status(run_id, stage_id, 'completed', output_summary='__pipeline_result:pass:Tests passed')
            await engine._complete_stage(run_id, stage_id)
        with patch.object(engine, '_execute_agent_stage', agent):
            run = await engine.start_task_execution_pipeline('task', options={'test_with_agent': True})
            self.assertEqual((await self.wait_status(run['id'], ['completed']))['status'], 'completed')
            self.assertEqual((await self.task())['status'], 'done')

    async def test_concurrent_starts_and_lost_response_reuse_one_run(self):
        key = str(uuid.uuid4())
        with patch.object(engine, '_execute_stage', AsyncMock()):
            runs = await asyncio.gather(*(engine.start_task_execution_pipeline('task', options={'request_id': key}) for _ in range(6)))
            self.assertEqual(len({r['id'] for r in runs}), 1)
            await self.db.execute("UPDATE pipeline_runs SET status='completed' WHERE id=?", (runs[0]['id'],)); await self.db.commit()
            engine._active_runs.clear() # recovery must use persistent data
            retry = await engine.start_task_execution_pipeline('task', options={'request_id': key})
            self.assertEqual(retry['id'], runs[0]['id'])
            count = await (await self.db.execute('SELECT count(*) FROM pipeline_definitions')).fetchone()
            self.assertEqual(count[0], 1)

    async def test_concurrent_resume_schedules_stage_once(self):
        with patch.object(engine, '_execute_stage', AsyncMock()) as execute:
            run = await engine.start_task_execution_pipeline('task')
            await asyncio.sleep(.02)
            await engine.pause_run(run['id'])
            execute.reset_mock()
            results = await asyncio.gather(*(engine.resume_run(run['id']) for _ in range(4)))
            await asyncio.sleep(.02)
            self.assertEqual(execute.await_count, 1)
            self.assertEqual(sum(bool(r.get('_resume_no_op')) for r in results), 3)

    async def test_acceptance_rejects_stale_failed_and_active_runs(self):
        from task_review import validate_result_acceptance
        with patch.object(engine, '_execute_stage', AsyncMock()):
            run = await engine.start_task_execution_pipeline('task')
            await engine._update_stage_status(run['id'], 'verify', 'completed', output_summary='__pipeline_result:pass:Checked')
            await self.db.execute("UPDATE tasks SET status='review' WHERE id='task'")
            await self.db.commit()
            with self.assertRaises(ValueError): await validate_result_acceptance(self.db, await self.task(), run['id'])
            await self.db.execute("UPDATE pipeline_runs SET status='completed' WHERE id=?", (run['id'],)); await self.db.commit()
            await validate_result_acceptance(self.db, await self.task(), run['id'])
            with self.assertRaises(ValueError): await validate_result_acceptance(self.db, await self.task(), 'stale-id')
            await engine._update_stage_status(run['id'], 'verify', 'completed', output_summary='__pipeline_result:fail:Broken')
            with self.assertRaises(ValueError): await validate_result_acceptance(self.db, await self.task(), run['id'])
            await engine._update_stage_status(run['id'], 'verify', 'completed', output_summary='__pipeline_result:pass:Checked')
            newer = await engine.start_task_execution_pipeline('task')
            self.assertNotEqual(newer['id'], run['id'])
            with self.assertRaises(ValueError): await validate_result_acceptance(self.db, await self.task(), run['id'])

    async def test_long_evidence_is_preserved_and_truncation_is_visible(self):
        with patch.object(engine, '_execute_stage', AsyncMock()):
            run = await engine.start_task_execution_pipeline('task')
            text = '__pipeline_result:pass:' + 'evidence ' * 600
            await engine._update_stage_status(run['id'], 'plan', 'completed', output_summary=text)
            report = (await engine.get_run(run['id']))['stage_history']['plan']
            self.assertEqual(report['output_summary'], text)
            self.assertFalse(report['output_truncated'])
            await engine._update_stage_status(run['id'], 'plan', 'completed', output_summary='x' * 40000)
            report = (await engine.get_run(run['id']))['stage_history']['plan']
            self.assertEqual(len(report['output_summary']), 32000)
            self.assertTrue(report['output_truncated'])

    async def test_revision_limit_stops_persistently_failing_checks(self):
        async def agent(run_id, stage_id, *args):
            result = 'fail' if stage_id == 'verify' else 'pass'
            await engine._update_stage_status(run_id, stage_id, 'completed', output_summary=f'__pipeline_result:{result}:Test evidence')
            await engine._complete_stage(run_id, stage_id)
        with patch.object(engine, '_execute_agent_stage', agent):
            run = await engine.start_task_execution_pipeline('task', options={'test_with_agent':True,'ralph_loop':True,'pipeline_max_iterations':1,'require_result_review':True})
            stopped = await self.wait_status(run['id'], ['max_iterations','completed','failed'])
            self.assertEqual(stopped['status'], 'max_iterations')
            self.assertNotEqual((await self.task())['status'], 'done')

    async def test_keyed_task_creation_is_durable_and_emits_once(self):
        broadcast = AsyncMock()
        handler = server_functions('create_task', get_db=database.get_db, _resolve_caller=AsyncMock(return_value=None), _workspace_visible_to_auth=lambda *args: True, get_auth=lambda r: None, _task_create_advisory=AsyncMock(return_value=None), _exact_open_task_title_conflicts=AsyncMock(return_value=[]), broadcast=broadcast, bus=self.events, CommanderEvent=SimpleNamespace(TASK_CREATED='created'), extension_host=SimpleNamespace(available=lambda x:False))
        body = {'workspace_id': 'ws', 'title': 'Durable task', 'request_id': str(uuid.uuid4())}
        request = SimpleNamespace(json=AsyncMock(return_value=body), query={})
        responses = await asyncio.gather(*(handler.create_task(request) for _ in range(5)))
        self.assertEqual(len({json.loads(r.text)['id'] for r in responses}), 1)
        self.assertEqual(sorted(r.status for r in responses), [200,200,200,200,201])
        self.assertEqual(broadcast.await_count, 1)
        self.assertEqual((await (await self.db.execute("SELECT count(*) FROM task_events WHERE event_type='created'")).fetchone())[0], 1)
        request.json = AsyncMock(return_value={**body, 'request_id':'invalid'})
        self.assertEqual((await handler.create_task(request)).status, 400)


class RestartTests(unittest.IsolatedAsyncioTestCase):
    async def test_autostart_uses_default_and_forwarded_geometry_without_row(self):
        config = {'cli_type':'claude','model':'sonnet','workspace_path':'/isolated','workspace_id':'ws','session_type':'tester','permission_mode':'plan'}
        manager = SimpleNamespace(start_session=AsyncMock(), is_alive=Mock(return_value=True))
        cli = SimpleNamespace(profile=SimpleNamespace(managed_context_adapter=None,id='claude'), build_command=lambda:['fake-cli'], append_system_prompt=Mock())
        assembly = server_functions('_autostart_session_pty','_supervisor_spawn_pty_from_row',
            get_session_config=AsyncMock(return_value=config), _prepare_session_cli_env=AsyncMock(return_value={}), _apply_worker_safety_gate_permission=AsyncMock(return_value='plan'), _launch_model_for_session=AsyncMock(return_value='sonnet'), UnifiedSession=lambda *args:cli,
            _record_session_runtime_home=AsyncMock(), _apply_session_resume=AsyncMock(), _apply_session_mcp=AsyncMock(return_value={'w2w':('1','1','1')}), HOST='127.0.0.1', PORT=0,
            _snapshot_files_for_detection=Mock(return_value=[]), capture_proc=SimpleNamespace(clear_buffer=Mock()), mark_pty_started=Mock(), pty_mgr=manager, _mark_session_pty_started=AsyncMock(), _clear_auth_failed_session_state=AsyncMock(), broadcast=AsyncMock(), _session_cli_type_cache={}, _schedule_session_detection=Mock(), bus=SimpleNamespace(emit=AsyncMock()), CommanderEvent=SimpleNamespace(SESSION_FAILED_TO_START='failed'))
        # Out-of-band attribution and hooks are not needed to exercise spawning.
        with patch.dict('sys.modules', {'git_attribution':SimpleNamespace(inject_git_attribution_env=AsyncMock()), 'hooks':SimpleNamespace(get_session_logical_status=lambda *args:'idle')}):
            result = await assembly._autostart_session_pty('session')
            self.assertTrue(result['ok'])
            self.assertEqual(manager.start_session.call_args.args[2:4], (120,40))
            await assembly._supervisor_spawn_pty_from_row({'id':'session','_pty_cols':183,'_pty_rows':52})
            self.assertEqual(manager.start_session.call_args.args[2:4], (183,52))
            manager.start_session.side_effect = RuntimeError('binary missing')
            with self.assertRaisesRegex(RuntimeError, 'binary missing'):
                await assembly._supervisor_spawn_pty_from_row({'id':'session'})

    async def test_switch_preserves_geometry_and_rolls_back_on_spawn_failure(self):
        import session_supervisor as supervisor
        row = {'id':'s','cli_type':'claude','model':'sonnet','workspace_id':'ws'}
        alive = True
        attempts=[]
        async def stop(*args):
            nonlocal alive
            alive=False
        async def update(sid, changes): row.update(changes)
        async def spawn(value):
            nonlocal alive
            attempts.append(dict(value))
            if value['model']=='bad': raise RuntimeError('missing CLI')
            alive=True
        manager=SimpleNamespace(is_alive=lambda sid:alive,stop_session=stop,get_geometry=lambda sid:{'cols':165,'rows':45})
        with patch.object(supervisor,'_pty_manager',manager), patch.object(supervisor,'_load_session_row',AsyncMock(side_effect=lambda sid:dict(row))), patch.object(supervisor,'_write_restart_updates',update), patch.object(supervisor,'_spawn_pty_from_row',spawn), patch.object(supervisor,'bus',SimpleNamespace(emit=AsyncMock())):
            result=await supervisor.restart('s',updates={'model':'opus'})
            self.assertTrue(result['ok'])
            self.assertEqual((attempts[-1]['_pty_cols'],attempts[-1]['_pty_rows']),(165,45))
            failed=await supervisor.restart('s',updates={'model':'bad'})
            self.assertFalse(failed['ok']);self.assertTrue(failed['rollback_restarted'])
            self.assertEqual(row['model'],'opus');self.assertTrue(alive)

if __name__ == '__main__': unittest.main()
