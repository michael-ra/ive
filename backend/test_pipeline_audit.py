"""Pipeline audit regressions: isolated SQLite and temporary repository only."""
import asyncio
from contextlib import ExitStack
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import db as database
import pipeline_engine as engine


class PipelineAuditTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for name, value in [('DATA_DIR', Path(self.tmp.name)), ('DB_PATH', Path(self.tmp.name) / 'state.db')]:
            p = patch.object(database, name, value); p.start(); self.addCleanup(p.stop)
        await database.init_db()
        self.db = await database.get_db()
        self.addAsyncCleanup(self.db.close)
        await self.db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws','Audit fixture',?)", (self.tmp.name,))
        await self.db.commit()
        engine._state_lock = asyncio.Lock()
        engine._active_runs.clear(); engine._pipeline_task_ids.clear(); engine._advance_locks.clear()
        engine._session_to_run.clear()
        for timer in engine._advance_timers.values(): timer.cancel()
        engine._advance_timers.clear()
        p = patch.object(engine, 'bus', SimpleNamespace(emit=AsyncMock())); p.start(); self.addCleanup(p.stop)
        p = patch.object(engine, '_broadcast_fn', AsyncMock()); p.start(); self.addCleanup(p.stop)

    async def asyncTearDown(self):
        jobs=list(engine._stage_jobs.values())
        if jobs: await asyncio.wait_for(asyncio.gather(*jobs, return_exceptions=True), timeout=2)

    async def definition(self, stages, edges=None):
        return await engine.create_definition({'workspace_id':'ws','name':'Audit fixture', 'stages':stages,'transitions':edges or []})

    async def settle(self, run_id):
        for _ in range(250):
            run = await engine.get_run(run_id)
            if run['status'] not in ('running','paused'): return run
            await asyncio.sleep(.01)
        self.fail(f'Run did not settle: {run}')

    async def agent_delivery(self, cli_type='claude', prompt='hello', ready=None, write=None, role=None):
        session_id=f'session-{cli_type}'
        await self.db.execute("INSERT OR REPLACE INTO sessions(id,workspace_id,name,cli_type) VALUES(?,'ws','Delivery fixture',?)",(session_id,cli_type))
        await self.db.commit()
        manager=SimpleNamespace(is_alive=lambda sid:True,write=write or Mock(return_value=True))
        ready=ready or AsyncMock(return_value=True)
        patches=ExitStack();self.addCleanup(patches.close)
        patches.enter_context(patch.object(engine,'_pty_manager',manager))
        patches.enter_context(patch.object(engine,'_input_ready_fn',ready))
        patches.enter_context(patch.object(engine,'_ensure_pipeline_stage_tools',AsyncMock()))
        async def no_review(prompt,*args):return prompt
        patches.enter_context(patch.object(engine,'_with_review_intent',no_review))
        # Recipe CLI deliberately differs from the actual reused session.
        p=await self.definition([{'id':'agent','session_id':session_id,'cli_type':'gemini' if cli_type!='gemini' else 'claude','prompt_template':prompt,'agent_config':{'role':role} if role else {}}])
        return await engine.start_run(p['id']),session_id,manager,ready

    async def wait_delivery(self, run_id):
        for _ in range(300):
            run=await engine.get_run(run_id)
            if run['stage_history']['agent']['status']!='pending' and (run_id,'agent') not in engine._stage_jobs:
                return run
            await asyncio.sleep(.01)
        self.fail('Agent delivery did not settle')

    async def test_agent_multiline_uses_actual_session_cli_and_separate_enter(self):
        prompt='First\nSecond\r\nÜnicode'
        for cli_type in ['claude','codex','gemini']:
            with self.subTest(cli_type=cli_type):
                run,sid,manager,ready=await self.agent_delivery(cli_type,prompt)
                current=await self.wait_delivery(run['id'])
                self.assertEqual(current['status'],'running')
                ready.assert_awaited_once_with(sid,cli_type,30)
                payload=prompt.replace('\r',' ').replace('\n',' ').encode() if cli_type=='gemini' else b'\x1b[200~'+prompt.encode()+b'\x1b[201~'
                self.assertEqual([call.args[1] for call in manager.write.call_args_list],[payload,b'\r'])
                self.assertEqual(engine._session_to_run[sid],run['id'])

    async def test_agent_rejected_paste_or_enter_fails_visibly(self):
        for replies in [[False],[True,False,True]]:
            with self.subTest(replies=replies):
                run,sid,manager,_=await self.agent_delivery(write=Mock(side_effect=replies))
                current=await self.wait_delivery(run['id'])
                self.assertEqual(current['status'],'failed')
                self.assertIn('submitted',current['error'])
                self.assertNotIn(sid,engine._session_to_run)
                if len(replies)==1:self.assertEqual(manager.write.call_count,1)

    async def test_plan_critic_discovers_typed_result_tool_without_widening_permissions(self):
        import role_templates
        from cli_session import UnifiedSession
        with patch.object(engine, '_pty_start_fn', AsyncMock()) as start:
            sid = await engine._auto_create_session(self.db, 'ws', 'planner', 'claude', {'role':'plan_critic','permission_mode':'plan'})
        row = dict(await (await self.db.execute('SELECT * FROM sessions WHERE id=?', (sid,))).fetchone())
        self.assertEqual(row['permission_mode'], 'plan')
        argv = UnifiedSession('claude', row).build_command()
        self.assertEqual(argv[argv.index('--permission-mode') + 1], 'plan')
        self.assertIn('You are the Planner for one IVE pipeline stage', row['system_prompt'])
        self.assertIn('ToolSearch', row['system_prompt'])
        self.assertIn('does not mean this local result tool is blocked', row['system_prompt'])
        attached = await (await self.db.execute("SELECT auto_approve_override FROM session_mcp_servers WHERE session_id=? AND mcp_server_id='builtin-worker-board'", (sid,))).fetchone()
        self.assertEqual(attached[0], 1)
        start.assert_awaited_once_with(sid)
        template = role_templates.get_role_template('plan_critic')
        self.assertEqual(template['permission_mode'], 'plan')
        self.assertIn('verdict', template['result_schema']['required'])

    async def test_plan_critic_submits_one_validated_report_while_remaining_read_only(self):
        from test_task_flow import server_functions
        run, sid, manager, _ = await self.agent_delivery(
            prompt='Review the proposed plan. Use report_pipeline_result.', role='plan_critic')
        await self.wait_delivery(run['id'])
        prompt = manager.write.call_args_list[0].args[1].decode()
        self.assertIn('ToolSearch to find `submit_result`', prompt)
        self.assertIn('Use submit_result instead of report_pipeline_result', prompt)
        self.assertIn('After the tool returns ok=true, stop', prompt)
        self.assertIn('"verdict"', prompt)
        await self.db.execute("UPDATE sessions SET permission_mode='plan' WHERE id=?", (sid,))
        await self.db.commit()
        handler = server_functions('handle_pipeline_result', _resolve_caller=AsyncMock(return_value={'session_id':sid}))
        request = SimpleNamespace(json=AsyncMock(return_value={'session_id':sid,'result':{'summary':'Missing required verdict'}}))
        invalid = json.loads((await handler.handle_pipeline_result(request)).text)
        self.assertIn('validation_error', invalid)
        self.assertEqual((await engine.get_run(run['id']))['status'], 'running')
        request.json = AsyncMock(return_value={'session_id':sid,'result':{'verdict':'fail','issues':['Missing rollback step'],'summary':'Plan needs revision'}})
        valid = json.loads((await handler.handle_pipeline_result(request)).text)
        self.assertTrue(valid['ok']); self.assertEqual(valid['status'], 'fail')
        done = await self.settle(run['id'])
        self.assertEqual(done['stage_history']['agent']['result']['verdict'], 'fail')
        row = await (await self.db.execute('SELECT permission_mode FROM sessions WHERE id=?', (sid,))).fetchone()
        self.assertEqual(row['permission_mode'], 'plan')

    async def test_cancel_interrupts_using_actual_cli_without_approving_permission(self):
        for cli_type, interrupt in [('claude', b'\x1b'), ('codex', b'\x03'), ('gemini', b'\x03')]:
            with self.subTest(cli_type=cli_type):
                run, sid, manager, _ = await self.agent_delivery(cli_type)
                await self.wait_delivery(run['id'])
                manager.write.reset_mock()
                result = await engine.cancel_run(run['id'])
                self.assertEqual(result['status'], 'cancelled')
                self.assertNotIn(sid, engine._session_to_run)
                manager.write.assert_called_once_with(sid, interrupt)

    async def test_agent_not_ready_never_receives_input(self):
        run,sid,manager,_=await self.agent_delivery(ready=AsyncMock(return_value=False))
        current=await self.wait_delivery(run['id'])
        self.assertEqual(current['status'],'failed');self.assertIn('not ready',current['error'])
        manager.write.assert_not_called();self.assertNotIn(sid,engine._session_to_run)

    async def test_startup_idle_cannot_complete_unsent_agent_stage(self):
        checking=asyncio.Event();release=asyncio.Event()
        async def ready(*args):checking.set();await release.wait();return True
        run,sid,manager,_=await self.agent_delivery(ready=ready)
        await asyncio.wait_for(checking.wait(),1)
        await engine.on_session_idle(sid)
        self.assertNotIn(sid,engine._advance_timers);manager.write.assert_not_called()
        self.assertEqual((await engine.get_run(run['id']))['status'],'running')
        release.set();await self.wait_delivery(run['id'])
        self.assertEqual(manager.write.call_count,2)

    async def test_pause_before_ready_does_not_type_and_resume_delivers_once(self):
        checking=asyncio.Event();release=asyncio.Event()
        async def ready(*args):checking.set();await release.wait();return True
        run,sid,manager,_=await self.agent_delivery(ready=ready)
        await asyncio.wait_for(checking.wait(),1);await engine.pause_run(run['id'])
        release.set();await self.wait_delivery(run['id'])
        manager.write.assert_not_called();self.assertNotIn(sid,engine._session_to_run)
        await engine.resume_run(run['id']);await self.wait_delivery(run['id'])
        self.assertEqual([c.args[1] for c in manager.write.call_args_list],[b'hello',b'\r'])

    async def test_cancel_during_paste_clears_buffer_without_submit(self):
        typed=asyncio.Event()
        def write(sid,data):typed.set();return True
        run,sid,manager,_=await self.agent_delivery(write=Mock(side_effect=write))
        await asyncio.wait_for(typed.wait(),1)
        # A paste-triggered idle event must be ignored too.
        await engine.on_session_idle(sid);self.assertNotIn(sid,engine._advance_timers)
        await engine.cancel_run(run['id'])
        self.assertEqual((await engine.get_run(run['id']))['status'],'cancelled')
        self.assertEqual([c.args[1] for c in manager.write.call_args_list],[b'hello',b'\x03'])
        self.assertNotIn(sid,engine._session_to_run)

    async def test_parallel_branches_cannot_finish_run_early(self):
        with patch.object(engine, '_execute_stage', AsyncMock()):
            p = await self.definition([{'id':s} for s in ['a','b','c']], [{'source':'a','target':'c'}])
            run = await engine.start_run(p['id'])
            await engine._update_stage_status(run['id'],'b','running')
            await engine._complete_stage(run['id'],'a')
            await engine._complete_stage(run['id'],'c')
            pending = await engine.get_run(run['id'])
            self.assertEqual(pending['status'],'running')
            self.assertEqual(pending['current_stages'],['b'])
            await engine._complete_stage(run['id'],'b')
            self.assertEqual((await engine.get_run(run['id']))['status'],'completed')

    async def test_parallel_history_updates_and_finishes_are_not_lost(self):
        with patch.object(engine, '_execute_stage', AsyncMock()):
            p = await self.definition([{'id':str(i)} for i in range(8)])
            run = await engine.start_run(p['id'])
            await asyncio.gather(*(engine._update_stage_status(run['id'],str(i),'running',output_summary=f'evidence {i}') for i in range(8)))
            await asyncio.gather(*(engine._complete_stage(run['id'],str(i)) for i in range(8)))
            done = await engine.get_run(run['id'])
            self.assertEqual(done['status'],'completed')
            self.assertEqual([s['output_summary'] for s in done['stage_history'].values()],[f'evidence {i}' for i in range(8)])
            self.assertTrue(all(s['status']=='completed' for s in done['stage_history'].values()))

    async def test_duplicate_idle_does_not_advance_branch_twice(self):
        with patch.object(engine, '_execute_stage', AsyncMock()) as execute:
            p=await self.definition([{'id':'a'},{'id':'b'}],[{'source':'a','target':'b'}])
            run=await engine.start_run(p['id']);await asyncio.sleep(.01);execute.reset_mock()
            await asyncio.gather(engine._complete_stage(run['id'],'a'),engine._complete_stage(run['id'],'a'))
            await asyncio.sleep(.01)
            self.assertEqual(execute.await_count,1)
            self.assertEqual((await engine.get_run(run['id']))['iteration'],1)

    async def test_condition_only_loop_obeys_iteration_limit(self):
        p=await self.definition([{'id':'condition','type':'condition'}],[{'source':'condition','target':'condition','condition':'always'}])
        run=await engine.start_run(p['id'],max_iterations=2)
        done=await self.settle(run['id'])
        self.assertEqual(done['status'],'max_iterations');self.assertEqual(done['iteration'],2)

    async def test_terminal_cancel_preserves_result(self):
        with patch.object(engine,'_execute_stage',AsyncMock()):
            p=await self.definition([{'id':'a'}]);run=await engine.start_run(p['id'])
            await engine._complete_stage(run['id'],'a')
            result=await engine.cancel_run(run['id'])
            self.assertTrue(result['_cancel_no_op']);self.assertEqual(result['status'],'completed')

    async def test_invalid_graphs_fail_before_creating_runs(self):
        cases=[([],[]),([{'id':'a'},{'id':'a'}],[]),([{'id':'a'}],[{'source':'a','target':'missing'}]),([{'id':'a','type':'imaginary'}],[])]
        for stages,edges in cases:
            p=await self.definition(stages,edges)
            with self.assertRaises(ValueError):await engine.start_run(p['id'])
        count=await (await self.db.execute('SELECT count(*) FROM pipeline_runs')).fetchone()
        self.assertEqual(count[0],0)

    async def test_command_safety_failure_never_launches_command(self):
        import safety_engine
        p=await self.definition([{'id':'check','type':'command','prompt_template':'echo should-not-run'}])
        with patch.object(safety_engine,'evaluate',AsyncMock(side_effect=RuntimeError('unavailable'))), patch.object(asyncio,'create_subprocess_exec',AsyncMock()) as launch:
            run=await engine.start_run(p['id']);done=await self.settle(run['id'])
            self.assertEqual(done['status'],'failed');self.assertIn('safety check',done['error'])
            launch.assert_not_called()

    async def test_ralph_binds_each_caller_before_any_stage_starts(self):
        await engine.ensure_presets()
        seen=[]
        async def agent(run_id,stage_id,stage,*args):
            if stage_id=='execute':seen.append((stage['session_id'],stage['prompt_template']))
        with patch.object(engine,'_execute_agent_stage',agent):
            runs=await asyncio.gather(engine.start_ralph('caller-a','Task alpha','ws'),engine.start_ralph('caller-b','Task beta','ws'))
            for _ in range(100):
                if len(seen)==2:break
                await asyncio.sleep(.01)
            self.assertCountEqual(seen,[('caller-a','Task alpha'),('caller-b','Task beta')])
            self.assertNotEqual(runs[0]['pipeline_id'],runs[1]['pipeline_id'])
            for run in runs:
                definition=await engine.get_definition(run['pipeline_id'])
                caller=next(x for x in definition['stages'] if x['id']=='execute')['session_id']
                self.assertEqual(next(x for x in definition['stages'] if x['id']=='fix')['session_id'],caller)
            presets=await engine.list_definitions()
            preset=next(p for p in presets if p['preset_key']=='ralph-pipeline')
            self.assertNotIn('session_id',preset['stages'][0])

    async def test_built_in_gate_requires_explicit_report(self):
        stage=next(s for s in engine.PRESETS['ralph-pipeline']['stages'] if s['type']=='condition')
        for text in ['', 'I could not run checks', 'It looks correct', 'All tests passed']:
            self.assertEqual(engine._evaluate_condition(stage,text),'fail')
        self.assertEqual(engine._evaluate_condition(stage,'__pipeline_result:pass:Ran the test suite'),'pass')
        self.assertEqual(engine._evaluate_condition(stage,'__pipeline_result:fail:Tests failed'),'fail')

    async def test_pause_resume_does_not_duplicate_running_work(self):
        started=asyncio.Event();release=asyncio.Event();calls=[]
        async def agent(run_id,stage_id,*args):
            calls.append(stage_id);started.set();await release.wait()
            await engine._complete_stage(run_id,stage_id)
        p=await self.definition([{'id':'a'}])
        with patch.object(engine,'_execute_agent_stage',agent):
            run=await engine.start_run(p['id']);await started.wait()
            await engine.pause_run(run['id']);await engine.resume_run(run['id'])
            await asyncio.sleep(.01);self.assertEqual(calls,['a'])
            release.set();self.assertEqual((await self.settle(run['id']))['status'],'completed')

    async def test_work_completed_while_paused_advances_without_repeating(self):
        started = {stage: asyncio.Event() for stage in ('a', 'b')}
        executions = []

        async def stage_started(run_id, stage_id):
            executions.append(asyncio.current_task())
            started[stage_id].set()

        with patch.object(engine,'_execute_stage',AsyncMock(side_effect=stage_started)) as execute:
            p=await self.definition([{'id':'a'},{'id':'b'}],[{'source':'a','target':'b'}])
            run=await engine.start_run(p['id'])
            await asyncio.wait_for(started['a'].wait(), timeout=5)
            await engine.pause_run(run['id']);await engine._complete_stage(run['id'],'a')
            paused=await engine.get_run(run['id'])
            self.assertEqual(paused['stage_history']['a']['status'],'completed')
            await engine.resume_run(run['id'])
            await asyncio.wait_for(started['b'].wait(), timeout=5)
            # resume_run schedules the completed stage's advancement. Wait for
            # its DB/broadcast work too, instead of assuming a fixed sleep is
            # sufficient on a busy machine. No scheduled call may arrive after
            # the duplicate assertion or after the temporary DB is removed.
            async with asyncio.timeout(5):
                async with engine._advance_locks[run['id']]:
                    pass
                await asyncio.gather(*executions)
            self.assertEqual(execute.await_count, 2)
            self.assertEqual([call.args for call in execute.await_args_list],
                             [(run['id'], 'a'), (run['id'], 'b')])
            await engine._complete_stage(run['id'], 'b')
            done = await engine.get_run(run['id'])
            self.assertEqual(done['status'], 'completed')
            self.assertEqual(execute.await_count, 2)

    async def test_cancel_stops_real_command_before_it_writes(self):
        root=Path(self.tmp.name)
        (root/'slow.py').write_text("from pathlib import Path\nimport time\nPath('started').touch()\ntime.sleep(.4)\nPath('finished').touch()\n")
        cmd=shlex.join([sys.executable,'slow.py'])
        p=await self.definition([{'id':'command','type':'command','prompt_template':cmd,'config':{'policy':{'mode':'safety_excluded','safety_excluded_command':cmd}}}])
        run=await engine.start_run(p['id'])
        for _ in range(100):
            if (root/'started').exists():break
            await asyncio.sleep(.01)
        self.assertTrue((root/'started').exists())
        self.assertEqual((await engine.cancel_run(run['id']))['status'],'cancelled')
        await asyncio.sleep(.45)
        self.assertFalse((root/'finished').exists())

    async def test_cancel_stops_command_descendants(self):
        root=Path(self.tmp.name)
        (root/'tree.py').write_text("import subprocess,sys,time\nfrom pathlib import Path\nsubprocess.Popen([sys.executable,'-c',\"import time;from pathlib import Path;time.sleep(.4);Path('escaped').touch()\"])\nPath('started').touch()\ntime.sleep(2)\n")
        cmd=shlex.join([sys.executable,'tree.py'])
        p=await self.definition([{'id':'command','type':'command','prompt_template':cmd,'config':{'policy':{'mode':'safety_excluded','safety_excluded_command':cmd}}}])
        run=await engine.start_run(p['id'])
        for _ in range(100):
            if (root/'started').exists():break
            await asyncio.sleep(.01)
        self.assertTrue((root/'started').exists())
        await engine.cancel_run(run['id']);await asyncio.sleep(.45)
        self.assertFalse((root/'escaped').exists())

    async def test_iteration_limit_stops_parallel_command(self):
        root=Path(self.tmp.name)
        # The writer waits for an explicit release, so scheduler load cannot
        # make it finish before the pipeline has reached its iteration limit.
        child = "import os,time\nfrom pathlib import Path\nPath('child-started').write_text(str(os.getpid()))\nwhile not Path('release').exists(): time.sleep(.01)\nPath('after-limit').touch()\n"
        (root/'slow.py').write_text(
            "import os,subprocess,sys,time\nfrom pathlib import Path\n"
            f"subprocess.Popen([sys.executable,'-c',{child!r}])\n"
            "Path('started').write_text(str(os.getpid()))\ntime.sleep(60)\n"
        )
        cmd=shlex.join([sys.executable,'slow.py'])
        stages=[{'id':'start','type':'delay','config':{'delay_seconds':0}}, {'id':'loop','type':'condition'},
                {'id':'command','type':'command','prompt_template':cmd,'config':{'policy':{'mode':'safety_excluded','safety_excluded_command':cmd}}}]
        p=await self.definition(stages,[{'source':'start','target':'loop'},{'source':'loop','target':'loop'}])
        tree_started=asyncio.Event()
        original_stage=engine._execute_stage_body
        async def wait_for_process_tree(run_id,stage_id):
            if stage_id=='start':
                await asyncio.wait_for(tree_started.wait(),5)
            await original_stage(run_id,stage_id)
        with patch.object(engine,'_execute_stage_body',wait_for_process_tree):
            run=await engine.start_run(p['id'],max_iterations=1)
            try:
                async with asyncio.timeout(5):
                    while not all((root/name).exists() for name in ('started','child-started')):
                        await asyncio.sleep(.01)
                pids=[int((root/name).read_text()) for name in ('started','child-started')]
                tree_started.set()
                done=await self.settle(run['id'])
            finally:
                tree_started.set()
                current=await engine.get_run(run['id'])
                if current['status'] in ('running','paused'):
                    await engine.cancel_run(run['id'])
        self.assertEqual(done['status'],'max_iterations')
        (root/'release').touch()
        async with asyncio.timeout(5):
            for pid in pids:
                while True:
                    try: os.kill(pid,0)
                    except ProcessLookupError: break
                    await asyncio.sleep(.01)
        self.assertFalse((root/'after-limit').exists())

    async def test_real_command_loop_fixes_then_verifies_in_temporary_git_repo(self):
        # Real commands and exit codes, no model/network/real repository writes.
        subprocess.run(['git','init','-q',self.tmp.name],check=True)
        root=Path(self.tmp.name)
        (root/'verify.py').write_text("from pathlib import Path\nraise SystemExit(0 if Path('fixed.txt').exists() else 1)\n")
        (root/'fix.py').write_text("from pathlib import Path\nPath('fixed.txt').write_text('fixed')\n")
        stages=[]
        for name in ['verify','fix']:
            cmd=shlex.join([sys.executable,f'{name}.py'])
            stages.append({'id':name,'type':'command','prompt_template':cmd,'config':{'policy':{'mode':'safety_excluded','safety_excluded_command':cmd}}})
        p=await self.definition(stages,[{'source':'verify','target':'fix','condition':'on_fail'},{'source':'fix','target':'verify','condition':'always'}])
        run=await engine.start_run(p['id'],max_iterations=3)
        done=await self.settle(run['id'])
        self.assertEqual(done['status'],'completed');self.assertEqual(done['iteration'],2)
        self.assertEqual(done['stage_history']['verify']['logs']['exit_code'],0)
        self.assertEqual((root/'fixed.txt').read_text(),'fixed')

if __name__=='__main__':unittest.main()
