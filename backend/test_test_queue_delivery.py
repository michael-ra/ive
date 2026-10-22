"""Test queue delivery, acceptance and worker reporting against isolated SQLite."""
import ast
import asyncio
import json
import logging
from pathlib import Path
import re
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
import urllib.parse
import uuid
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import db as database
import hooks
import pipeline_engine
from commander_events import CommanderEvent
from test_worker_context_contract import load_functions


class TestQueueDeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ive-test-queue-')
        self.addCleanup(self.tmp.cleanup)
        for key, value in [('DATA_DIR', Path(self.tmp.name)), ('DB_PATH', Path(self.tmp.name)/'state.db')]:
            p = patch.object(database, key, value); p.start(); self.addCleanup(p.stop)
        await database.init_db()
        self.db = await database.get_db(); self.addAsyncCleanup(self.db.close)
        await self.db.execute("INSERT INTO workspaces(id,name,path,auto_test_enabled) VALUES('ws','Tests',?,1)", (self.tmp.name,))
        await self.db.execute("INSERT INTO sessions(id,workspace_id,name,tags,cli_type,status) VALUES('tester','ws','Test agent','[\"capability_testing\"]','claude','idle')")
        await self.db.execute("INSERT INTO tasks(id,workspace_id,title,status) VALUES('task','ws','Greeting','review')")
        await self.db.commit()
        self.pty = SimpleNamespace(is_alive=Mock(return_value=True), write=Mock(return_value=True))
        self.logical = Mock(return_value='idle')
        p = patch.object(hooks, 'get_session_logical_status', self.logical); p.start(); self.addCleanup(p.stop)
        p = patch.object(pipeline_engine, '_session_to_run', {}); p.start(); self.addCleanup(p.stop)
        self.sleep = AsyncMock()
        async_stub = SimpleNamespace(Lock=asyncio.Lock, create_task=asyncio.create_task, sleep=self.sleep)
        self.ns = load_functions('server.py', {
            '_insert_test_queue_entry', '_auto_enqueue_test_for_task', 'update_task',
            '_test_queue_session_available', '_find_testing_worker', '_process_test_queue',
            '_process_test_queue_locked', '_build_test_prompt', 'report_test_queue_result',
        }, web=web, json=json, uuid=uuid, re=re, asyncio=async_stub,
            get_db=database.get_db, logger=logging.getLogger('queue-contract'), pty_mgr=self.pty,
            _test_queue_dispatch_locks={}, TEST_QUEUE_RUNNING_TIMEOUT_SECONDS=1800, TEST_QUEUE_MAX_ATTEMPTS=2,
            _session_cli_type=AsyncMock(return_value='claude'), _wait_for_cli_input_ready=AsyncMock(return_value=True),
            _startup_blocker_text=Mock(return_value='❯\u00a0'), _session_permission_menu=Mock(return_value=None),
            _autostart_session_pty=AsyncMock(), _recheck_test_queue_after_timeout=AsyncMock(),
            _broadcast_test_queue_entry=AsyncMock(), _continue_after_test_queue_terminal=AsyncMock(),
            _resolve_caller=AsyncMock(return_value=None), broadcast=AsyncMock(),
            _publish_test_queue_entry=AsyncMock(), bus=SimpleNamespace(emit=AsyncMock()),
            CommanderEvent=CommanderEvent, extension_host=SimpleNamespace(available=lambda _:False),
            _maybe_trigger_seam_check=AsyncMock(), _maybe_rollup_parent=AsyncMock(),
            _process_pending_dispatch_intents=AsyncMock())
        p = patch.dict(sys.modules, {'embedder': SimpleNamespace(embed_task=AsyncMock())}); p.start(); self.addCleanup(p.stop)
        app = web.Application()
        app.router.add_put('/tasks/{id}', self.ns['update_task'])
        app.router.add_put('/test-queue/{id}/report', self.ns['report_test_queue_result'])
        self.client = TestClient(TestServer(app)); await self.client.start_server(); self.addAsyncCleanup(self.client.close)

    async def enqueue(self):
        entry, _ = await self.ns['_insert_test_queue_entry'](self.db, workspace_id='ws', task_id=None,
            task_revision=None, title='Run npm test', description='Use existing Node project.\nDo not change files.',
            acceptance_criteria='Four existing tests pass.')
        await self.db.commit()
        return entry

    async def entry(self, eid):
        return dict(await (await self.db.execute('SELECT * FROM test_queue WHERE id=?', (eid,))).fetchone())

    async def accept(self, body):
        response = await self.client.put('/tasks/task', json=body)
        return response.status, await response.json()

    async def completed_run(self, result='pass'):
        history = {'verify': {'status':'completed', 'output_summary':f'__pipeline_result:{result}:npm test 4/4'}}
        await self.db.execute("INSERT INTO pipeline_runs(id,workspace_id,task_id,status,stage_history) VALUES('run','ws','task','completed',?)", (json.dumps(history),))
        await self.db.commit()

    async def test_accept_verified_run_does_not_launch_duplicate_auto_test(self):
        await self.completed_run()
        self.assertEqual((await self.accept({'status':'done','reviewed_run_id':'run'}))[0], 200)
        self.assertEqual(await self.db.execute_fetchall('SELECT * FROM test_queue'), [])
        self.ns['_publish_test_queue_entry'].assert_not_awaited()
        self.assertEqual((await self.db.execute_fetchall("SELECT status FROM tasks WHERE id='task'"))[0][0], 'done')

    async def test_ordinary_done_still_enqueues_auto_test(self):
        self.assertEqual((await self.accept({'status':'done'}))[0], 200)
        entries = await self.db.execute_fetchall('SELECT * FROM test_queue')
        self.assertEqual(len(entries), 1); self.assertEqual(entries[0]['task_id'], 'task')
        self.ns['_publish_test_queue_entry'].assert_awaited_once()

    async def test_unverified_acceptance_cannot_skip_queue_or_complete_task(self):
        await self.completed_run('fail')
        self.assertEqual((await self.accept({'status':'done','reviewed_run_id':'run'}))[0], 409)
        self.assertEqual((await self.db.execute_fetchall("SELECT status FROM tasks WHERE id='task'"))[0][0], 'review')
        self.assertEqual(await self.db.execute_fetchall('SELECT * FROM test_queue'), [])

    async def test_multiline_delivery_keeps_exact_id_and_requires_separate_submit(self):
        entry = await self.enqueue(); await self.ns['_process_test_queue']('ws')
        writes = [c.args[1] for c in self.pty.write.call_args_list]
        self.assertEqual(len(writes), 2)
        self.assertTrue(writes[0].startswith(b'Run this IVE test-queue assignment'))
        self.assertIn(b'\x1b[200~', writes[0]); self.assertTrue(writes[0].endswith(b'\x1b[201~'))
        self.assertIn(entry['id'].encode(), writes[0]); self.assertIn(b'report_test_result', writes[0])
        self.assertEqual(writes[1], b'\r'); self.assertEqual((await self.entry(entry['id']))['status'], 'running')
        self.ns['_wait_for_cli_input_ready'].assert_awaited_once_with('tester', 'claude', 30)

    async def test_gemini_flattens_multiline_without_escape_sequences(self):
        await self.enqueue(); self.ns['_session_cli_type'].return_value = 'gemini'
        await self.ns['_process_test_queue']('ws')
        payload = self.pty.write.call_args_list[0].args[1]
        for byte in (b'\n',b'\r',b'\x1b'): self.assertNotIn(byte, payload)
        self.assertEqual(self.pty.write.call_args_list[1].args[1], b'\r')

    async def test_not_ready_remains_queued_without_attempt_or_write(self):
        entry = await self.enqueue(); self.ns['_wait_for_cli_input_ready'].return_value = False
        await self.ns['_process_test_queue']('ws'); self.pty.write.assert_not_called()
        current = await self.entry(entry['id'])
        self.assertEqual(current['status'], 'queued'); self.assertEqual(current['attempt_count'], 0)

    async def test_busy_or_waiting_tester_is_not_interrupted(self):
        entry = await self.enqueue()
        for status in ('running','waiting'):
            self.logical.return_value = status; await self.ns['_process_test_queue']('ws')
        self.pty.write.assert_not_called(); self.ns['_wait_for_cli_input_ready'].assert_not_awaited()
        self.assertEqual((await self.entry(entry['id']))['status'], 'queued')

    async def test_active_pipeline_tester_is_not_repurposed_even_when_idle(self):
        entry = await self.enqueue(); pipeline_engine._session_to_run['tester'] = ('run','verify')
        await self.ns['_process_test_queue']('ws')
        self.pty.write.assert_not_called(); self.assertEqual((await self.entry(entry['id']))['status'], 'queued')

    async def test_confirmed_idle_wakes_queued_test_without_interruption(self):
        entry = await self.enqueue(); self.logical.return_value = 'running'
        await self.ns['_process_test_queue']('ws'); self.pty.write.assert_not_called()
        jobs = []
        def schedule(coro):
            job = asyncio.create_task(coro); jobs.append(job); return job
        session = dict(await (await self.db.execute("SELECT * FROM sessions WHERE id='tester'")).fetchone())
        notify = load_functions('server.py', {'broadcast'}, json=json, ws_clients=set(),
            get_session_config=AsyncMock(return_value=session),
            asyncio=SimpleNamespace(create_task=schedule), _process_test_queue=self.ns['_process_test_queue'])['broadcast']
        await notify({'type':'session_state','session_id':'tester','state':'working'})
        self.assertEqual(jobs, [])
        self.logical.return_value = 'idle'
        await notify({'type':'session_state','session_id':'tester','state':'idle'})
        self.assertEqual(len(jobs), 1); await asyncio.gather(*jobs)
        self.assertEqual((await self.entry(entry['id']))['status'], 'running')
        self.assertEqual(self.pty.write.call_count, 2)

    async def test_tester_becoming_busy_after_paste_is_not_submitted(self):
        entry = await self.enqueue()
        async def became_busy(_): self.logical.return_value = 'running'
        self.sleep.side_effect = became_busy
        await self.ns['_process_test_queue']('ws')
        self.pty.write.assert_called_once()
        current = await self.entry(entry['id']); self.assertEqual(current['status'], 'failed')
        self.assertIn('became busy', current['result_summary'])

    async def test_manual_draft_or_permission_is_never_cleared(self):
        entry = await self.enqueue(); self.ns['_startup_blocker_text'].return_value = '❯\u00a0My unfinished message'
        await self.ns['_process_test_queue']('ws')
        self.ns['_startup_blocker_text'].return_value = '❯\u00a0'; self.ns['_session_permission_menu'].return_value = {'choices':['Yes','No']}
        await self.ns['_process_test_queue']('ws')
        self.pty.write.assert_not_called(); self.assertEqual((await self.entry(entry['id']))['status'], 'queued')

    async def test_busy_latest_tester_does_not_hide_available_tester(self):
        await self.db.execute("INSERT INTO sessions(id,workspace_id,name,tags,created_at) VALUES('busy','ws','Busy','[\"capability_testing\"]','2999-01-01')")
        await self.db.commit(); self.logical.side_effect = lambda sid,*_: 'running' if sid=='busy' else 'idle'
        await self.enqueue(); await self.ns['_process_test_queue']('ws')
        self.assertEqual({c.args[0] for c in self.pty.write.call_args_list}, {'tester'})

    async def test_rejected_paste_fails_honestly_without_submit(self):
        entry = await self.enqueue(); self.pty.write.return_value = False
        await self.ns['_process_test_queue']('ws'); self.pty.write.assert_called_once()
        current = await self.entry(entry['id']); self.assertEqual(current['status'], 'failed')
        self.assertIn('No test result', current['result_summary']); self.ns['_continue_after_test_queue_terminal'].assert_awaited_once()

    async def test_rejected_submit_is_failed_not_fake_running(self):
        entry = await self.enqueue(); self.pty.write.side_effect = [True,False]
        await self.ns['_process_test_queue']('ws')
        current = await self.entry(entry['id']); self.assertEqual(current['status'], 'failed')
        self.assertIn('could not be submitted', current['result_summary'])

    async def test_cancel_during_paste_never_submits_or_overwrites_cancellation(self):
        entry = await self.enqueue()
        async def cancel(_):
            await self.db.execute("UPDATE test_queue SET status='failed',result_summary='Cancelled by owner' WHERE id=?", (entry['id'],)); await self.db.commit()
        self.sleep.side_effect = cancel; await self.ns['_process_test_queue']('ws')
        self.pty.write.assert_called_once(); self.assertEqual((await self.entry(entry['id']))['result_summary'], 'Cancelled by owner')

    async def test_two_dispatches_submit_one_assignment_only(self):
        await self.enqueue(); await self.enqueue()
        await asyncio.gather(self.ns['_process_test_queue']('ws'), self.ns['_process_test_queue']('ws'))
        self.assertEqual(self.pty.write.call_count, 2)
        self.assertCountEqual([r[0] for r in await self.db.execute_fetchall('SELECT status FROM test_queue')], ['running','queued'])

    async def test_only_assigned_worker_can_report_once_and_release_queue(self):
        entry = await self.enqueue(); await self.ns['_process_test_queue']('ws')
        payload = {'outcome':'pass','result_summary':'npm test: 4/4 passed'}; path = f"/test-queue/{entry['id']}/report"
        for sid in ('','other'):
            self.assertEqual((await self.client.put(path,json=payload,headers={'X-IVE-Session-Id':sid})).status,403)
        response = await self.client.put(path,json=payload,headers={'X-IVE-Session-Id':'tester'})
        self.assertEqual(response.status,200); self.assertEqual((await response.json())['status'],'done')
        self.ns['_continue_after_test_queue_terminal'].assert_awaited_once()
        self.assertEqual((await self.client.put(path,json=payload,headers={'X-IVE-Session-Id':'tester'})).status,409)


class WorkerQueueToolTests(unittest.TestCase):
    def test_registered_worker_tool_lists_and_calls_narrow_result_endpoint(self):
        api = Mock(return_value={'status':'done'})
        ns = load_functions('worker_mcp_server.py', {'tool_report_test_result','handle_request'}, json=json, urllib=urllib, api_call=api)
        tree = ast.parse(Path(__file__).with_name('worker_mcp_server.py').read_text())
        tools = next(n.value for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='TOOLS' for t in n.targets))
        spec = next(v for k,v in zip(tools.keys,tools.values) if isinstance(k,ast.Constant) and k.value=='report_test_result')
        ns['TOOLS'] = {'report_test_result':eval(compile(ast.Expression(spec),'worker_mcp_server.py','eval'),ns)}
        listing = ns['handle_request']({'id':1,'method':'tools/list'})
        self.assertEqual(listing['result']['tools'][0]['name'],'report_test_result')
        self.assertEqual(set(listing['result']['tools'][0]['inputSchema']['required']),{'test_queue_id','outcome','result_summary'})
        result = ns['handle_request']({'id':2,'method':'tools/call','params':{'name':'report_test_result','arguments':{'test_queue_id':'queue/id','outcome':'pass','result_summary':'npm test 4/4'}}})
        api.assert_called_once_with('PUT','/test-queue/queue%2Fid/report',{'outcome':'pass','result_summary':'npm test 4/4'})
        self.assertIn('done',result['result']['content'][0]['text'])


if __name__=='__main__': unittest.main()
