"""Real isolated HTTP/WS checks for the desktop-only browser boundary."""
import ast
from pathlib import Path
import unittest
from unittest.mock import patch
from aiohttp import web, WSServerHandshakeError
from aiohttp.test_utils import TestClient, TestServer
from multidict import CIMultiDict
from desktop_security import create_desktop_origin_guard


class DesktopSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def client(self, enabled=True):
        self.requests=[]
        async def echo(request):
            self.requests.append((request.method,request.path))
            return web.json_response({'ok':True})
        async def ws(request):
            self.requests.append(('WS',request.path))
            response=web.WebSocketResponse();await response.prepare(request)
            await response.send_str('connected');await response.close();return response
        # Deliberately permissive existing CORS must never run on a rejection.
        @web.middleware
        async def cors(request,handler):
            if request.method=='OPTIONS': response=web.Response()
            else: response=await handler(request)
            if not response.prepared: response.headers['Access-Control-Allow-Origin']=request.headers.get('Origin','*')
            return response
        with patch.dict('os.environ', {'IVE_DESKTOP_INSTANCE':'fixture-nonce' if enabled else ''}):
            guard=create_desktop_origin_guard(5112)
        app=web.Application(middlewares=[guard,cors])
        app.router.add_route('*','/api/hooks/event',echo)
        app.router.add_route('*','/api/tasks',echo)
        app.router.add_get('/ws',ws)
        client=TestClient(TestServer(app));await client.start_server();self.addAsyncCleanup(client.close)
        return client

    async def test_exact_app_origin_can_read_and_write(self):
        client=await self.client()
        headers={'Host':'127.0.0.1:5112','Origin':'http://127.0.0.1:5112'}
        for method in ('GET','POST','PUT','DELETE'):
            response=await client.request(method,'/api/tasks',headers=headers)
            self.assertEqual(response.status,200);self.assertEqual(await response.json(),{'ok':True})
        self.assertEqual(len(self.requests),4)

    async def test_originless_local_mcp_and_hook_requests_still_work(self):
        client=await self.client()
        for path in ('/api/hooks/event','/api/tasks'):
            response=await client.post(path,headers={'Host':'127.0.0.1:5112'})
            self.assertEqual(response.status,200)
        self.assertEqual(len(self.requests),2)

    async def test_foreign_null_empty_alias_and_other_port_origins_are_rejected(self):
        client=await self.client()
        for origin in ('https://example.invalid','null','','http://localhost:5112','http://127.0.0.1:5111','https://127.0.0.1:5112','http://127.0.0.1:5112.attacker.invalid'):
            with self.subTest(origin=origin):
                response=await client.get('/api/tasks',headers={'Host':'127.0.0.1:5112','Origin':origin})
                self.assertEqual(response.status,403)
                self.assertEqual((await response.json())['code'],'desktop_origin_rejected')
                self.assertNotIn('Access-Control-Allow-Origin',response.headers)
        self.assertEqual(self.requests,[])

    async def test_foreign_origin_preflight_is_rejected_before_cors(self):
        client=await self.client()
        response=await client.options('/api/tasks',headers={'Host':'127.0.0.1:5112','Origin':'https://example.invalid','Access-Control-Request-Method':'POST'})
        self.assertEqual(response.status,403);self.assertNotIn('Access-Control-Allow-Origin',response.headers)
        self.assertEqual(self.requests,[])

    async def test_rebinding_alias_wrong_port_and_missing_host_are_rejected(self):
        client=await self.client()
        for host in ('attacker.invalid:5112','localhost:5112','127.0.0.1:5111','127.0.0.1',''):
            with self.subTest(host=host):
                response=await client.get('/api/tasks',headers={'Host':host})
                self.assertEqual(response.status,403)
                self.assertEqual((await response.json())['code'],'desktop_host_rejected')
        self.assertEqual(self.requests,[])

    async def test_duplicate_origin_is_not_accepted_from_first_header(self):
        client=await self.client()
        headers=CIMultiDict([('Host','127.0.0.1:5112'),('Origin','http://127.0.0.1:5112'),('Origin','https://example.invalid')])
        self.assertEqual((await client.get('/api/tasks',headers=headers)).status,403)
        self.assertEqual(self.requests,[])

    async def test_websocket_rejects_foreign_origin_before_upgrade(self):
        client=await self.client()
        with self.assertRaises(WSServerHandshakeError) as error:
            await client.ws_connect('/ws',headers={'Host':'127.0.0.1:5112','Origin':'https://example.invalid'})
        self.assertEqual(error.exception.status,403);self.assertEqual(self.requests,[])
        for origin in ('http://127.0.0.1:5112',None):
            headers={'Host':'127.0.0.1:5112'}
            if origin:headers['Origin']=origin
            ws=await client.ws_connect('/ws',headers=headers)
            self.assertEqual(await ws.receive_str(),'connected');await ws.close()

    async def test_server_edition_keeps_existing_behavior(self):
        client=await self.client(enabled=False)
        response=await client.get('/api/tasks',headers={'Host':'shared.example:5111','Origin':'https://existing-client.example'})
        self.assertEqual(response.status,200)
        self.assertEqual(response.headers['Access-Control-Allow-Origin'],'https://existing-client.example')

    def test_app_registers_guard_before_cors_and_auth(self):
        tree=ast.parse(Path(__file__).with_name('server.py').read_text())
        create_app=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='create_app')
        assignment=next(n for n in create_app.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='middlewares' for t in n.targets))
        names=[n.func.id if isinstance(n,ast.Call) else n.id for n in assignment.value.elts]
        self.assertLess(names.index('create_desktop_origin_guard'),names.index('cors_middleware'))
        self.assertLess(names.index('create_desktop_origin_guard'),names.index('token_auth_middleware'))


if __name__=='__main__':unittest.main()
