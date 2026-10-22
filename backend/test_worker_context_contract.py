"""Worker task access and real HTTP memory-search contracts, all isolated."""
import ast
import asyncio
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
import urllib.request
import urllib.parse
import urllib.error

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import db as database


def load_functions(filename, names, **namespace):
    source = Path(__file__).with_name(filename)
    tree = ast.parse(source.read_text())
    nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), 'exec'), namespace)
    return namespace


class WorkerTaskReadTests(unittest.TestCase):
    def setUp(self):
        self.task = {'id': 'task', 'workspace_id': 'ws', 'assigned_session_id': None, 'status': 'planning'}
        self.session = {'id': 'planner', 'workspace_id': 'ws', 'task_id': 'task'}
        self.api = Mock(side_effect=self.respond)
        self.ns = load_functions('worker_mcp_server.py',
            {'_is_my_task', '_read_my_task', 'tool_get_my_task', 'tool_get_my_tasks', 'tool_update_my_task'},
            api_call=self.api, json=json, urllib=urllib, SESSION_ID='planner', WORKSPACE_ID='ws')

    def respond(self, method, path, *body):
        return {'/tasks/task': self.task.copy(), '/sessions/planner': self.session.copy(),
                '/tasks/task/attachments': [{'filename': 'requirements.txt'}],
                '/tasks?assigned_session=planner': [], '/tasks?assigned_session=planner&status=done': []}.get(path)

    def test_pipeline_planner_reads_explicit_session_task_with_attachments(self):
        result = json.loads(self.ns['tool_get_my_task']({'task_id':'task'}))
        self.assertEqual(result['id'], 'task')
        self.assertEqual(result['attachments'][0]['filename'], 'requirements.txt')

    def test_no_argument_reads_only_the_validated_session_bound_task(self):
        result = json.loads(self.ns['tool_get_my_task']({}))
        self.assertEqual(result['id'], 'task')
        self.assertEqual(result['attachments'][0]['filename'], 'requirements.txt')
        for change in ({'task_id':None}, {'workspace_id':'other'}, {'id':'other'}):
            original = self.session.copy(); self.session.update(change)
            self.api.reset_mock()
            self.assertIn('error', json.loads(self.ns['tool_get_my_task']({})))
            self.assertNotIn('/tasks/task', [call.args[1] for call in self.api.call_args_list])
            self.session = original

    def test_invalid_explicit_task_id_returns_validation_error_without_api_call(self):
        for value in ('', 7, [], {}):
            self.assertIn('error', json.loads(self.ns['tool_get_my_task']({'task_id':value})))
        self.api.assert_not_called()

    def test_pipeline_read_does_not_grant_task_update(self):
        result = json.loads(self.ns['tool_update_my_task']({'task_id':'task','status':'done'}))
        self.assertIn('error', result)
        self.assertTrue(all(call.args[0] == 'GET' for call in self.api.call_args_list))

    def test_unbound_or_other_workspace_session_cannot_read(self):
        for change in ({'task_id':'other'}, {'workspace_id':'other'}, {'id':'other'}):
            with self.subTest(change=change):
                original=self.session.copy(); self.session.update(change)
                result=json.loads(self.ns['tool_get_my_task']({'task_id':'task'}))
                self.assertIn('error',result)
                self.session=original
        self.task['workspace_id']='other'
        self.assertIn('error',json.loads(self.ns['tool_get_my_task']({'task_id':'task'})))

    def test_list_includes_bound_pipeline_task_and_respects_status_filter(self):
        result=json.loads(self.ns['tool_get_my_tasks']({}))
        self.assertEqual([t['id'] for t in result],['task'])
        self.assertEqual(json.loads(self.ns['tool_get_my_tasks']({'status_filter':'done'})),[])

    def test_original_assignee_read_still_works_without_session_fetch(self):
        self.task['assigned_session_id']='planner'
        self.assertEqual(json.loads(self.ns['tool_get_my_task']({'task_id':'task'}))['id'],'task')
        self.assertNotIn('/sessions/planner',[call.args[1] for call in self.api.call_args_list])

    def test_backend_error_preserved_instead_of_false_unassigned_message(self):
        self.api.side_effect=None; self.api.return_value={'error':'connection unavailable','status':503}
        self.assertEqual(json.loads(self.ns['tool_get_my_task']({'task_id':'task'})), self.api.return_value)

    def test_both_mcp_clients_report_non_json_api_response_explicitly(self):
        for filename in ('worker_mcp_server.py','mcp_server.py'):
            with self.subTest(filename=filename):
                ns=load_functions(filename,{'api_call'},json=json,urllib=urllib,API_URL='http://127.0.0.1:1',
                    SESSION_ID='session',SESSION_TYPE='planner',WORKSPACE_ID='ws',COMMANDER_SESSION_ID='commander')
                response=io.BytesIO(b'<html>SPA fallback</html>');response.status=200
                with patch.object(urllib.request,'urlopen',return_value=response):
                    result=ns['api_call']('GET','/workspaces/ws/memory-search?q=private-query')
                self.assertEqual(result['code'],'invalid_api_response')
                self.assertNotIn('private-query',result['error'])
                self.assertNotIn('<html>',result['error'])


class WorkspaceSearchHttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='ive-search-contract-');self.addCleanup(self.tmp.cleanup)
        for name,value in [('DATA_DIR',Path(self.tmp.name)),('DB_PATH',Path(self.tmp.name)/'state.db')]:
            p=patch.object(database,name,value);p.start();self.addCleanup(p.stop)
        await database.init_db()
        self.db=await database.get_db();self.addAsyncCleanup(self.db.close)
        for ws in ('ws','other'):
            await self.db.execute('INSERT INTO workspaces(id,name,path) VALUES(?,?,?)',(ws,ws,str(Path(self.tmp.name)/ws)))
            await self.db.execute('INSERT INTO tasks(id,workspace_id,title,description) VALUES(?,?,?,?)',(ws+'-task',ws,'Greeting task','Use greet for Freund'))
            await self.db.execute('INSERT INTO sessions(id,workspace_id,name) VALUES(?,?,?)',(ws+'-session',ws,'worker'))
            await self.db.execute('INSERT INTO peer_messages(id,workspace_id,from_session_id,content) VALUES(?,?,?,?)',(ws+'-message',ws,ws+'-session','Greeting bulletin'))
            await self.db.execute('INSERT INTO file_activity(workspace_id,file_path,task_summary) VALUES(?,?,?)',(ws,'src/greeting.js','Greeting source'))
            await self.db.execute('INSERT INTO memory_entries(id,workspace_id,name,type,content) VALUES(?,?,?,?,?)',(ws+'-memory',ws,'Greeting style','project','Freund fallback'))
        await self.db.execute("INSERT INTO memory_entries(id,name,type,content) VALUES('global','Greeting global','user','Shared owner note')")
        await self.db.commit()
        self.ctx=SimpleNamespace(is_owner=True,workspace_id='ws')
        async def resolve(request):
            sid=request.headers.get('X-IVE-Session-Id')
            if sid=='known': return {'session_id':sid,'workspace_id':'ws'}
            return None
        ns=load_functions('server.py',{'unified_memory_search'},web=web,get_db=database.get_db,
            get_auth=lambda _:self.ctx,_workspace_visible_to_auth=lambda ws,ctx:ctx.is_owner or ws==ctx.workspace_id,
            _resolve_caller=resolve)
        self.app=web.Application();self.app.router.add_get('/api/workspaces/{id}/memory-search',ns['unified_memory_search'])
        self.client=TestClient(TestServer(self.app));await self.client.start_server();self.addAsyncCleanup(self.client.close)

    async def search(self,ws='ws',headers=None,**query):
        response=await self.client.get(f'/api/workspaces/{ws}/memory-search',params={'q':'greeting greet Freund',**query},headers=headers)
        self.assertEqual(response.content_type,'application/json')
        return response.status,await response.json()

    async def test_real_http_multi_keyword_search_matches_all_core_buckets(self):
        status,data=await self.search()
        self.assertEqual(status,200)
        self.assertEqual([r['id'] for r in data['results']['tasks']],['ws-task'])
        self.assertEqual([r['id'] for r in data['results']['messages']],['ws-message'])
        self.assertEqual([r['file_path'] for r in data['results']['files']],['src/greeting.js'])
        self.assertEqual({r['id'] for r in data['results']['memory']},{'ws-memory','global'})
        self.assertEqual(data['results']['knowledge'],[])
        self.assertEqual(data['unavailable_types'],['knowledge'])
        self.assertNotIn('other-memory',json.dumps(data))

    async def test_selected_types_and_limit_are_honored(self):
        status,data=await self.search(types='tasks,memory',limit='1')
        self.assertEqual(status,200);self.assertEqual(set(data['results']),{'tasks','memory'})
        self.assertTrue(all(len(rows)<=1 for rows in data['results'].values()))
        self.assertEqual(data['unavailable_types'],[])

    async def test_unmatched_query_is_successful_empty_result(self):
        status,data=await self.search(q='NoRecordMatchesThis')
        self.assertEqual(status,200);self.assertEqual(data['total'],0)

    async def test_invalid_queries_are_json_client_errors(self):
        for args in ({'q':''},{'limit':'NaN'},{'limit':'0'},{'limit':'26'},{'types':'brain'},{'types':''}):
            with self.subTest(args=args):self.assertEqual((await self.search(**args))[0],400)

    async def test_unknown_workspace_or_cross_workspace_worker_is_not_readable(self):
        self.assertEqual((await self.search(ws='absent'))[0],404)
        self.assertEqual((await self.search(ws='other',headers={'X-IVE-Session-Id':'known'}))[0],404)
        self.assertEqual((await self.search(headers={'X-IVE-Session-Id':'deleted'}))[0],403)

    async def test_joiner_does_not_read_other_workspace_or_global_notes(self):
        self.ctx.is_owner=False
        self.assertEqual((await self.search(ws='other'))[0],404)
        status,data=await self.search(types='memory')
        self.assertEqual(status,200)
        self.assertEqual([r['id'] for r in data['results']['memory']],['ws-memory'])

    def test_core_route_registered_when_optional_provider_does_not_own_it(self):
        tree=ast.parse(Path(__file__).with_name('server.py').read_text())
        registration=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute)
            and n.func.attr=='add_get' and n.args and isinstance(n.args[0],ast.Constant)
            and n.args[0].value=='/api/workspaces/{id}/memory-search']
        self.assertEqual(len(registration),1)
        self.assertEqual(registration[0].args[1].id,'unified_memory_search')

if __name__=='__main__':unittest.main()
