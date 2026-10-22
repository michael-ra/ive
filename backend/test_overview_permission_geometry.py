"""Long Overview permission frames never borrow an active terminal's geometry."""
import ast
import json
from pathlib import Path
import re
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
from aiohttp import web
from output_capture import OutputCaptureProcessor
from pty_manager import PTYManager, PTYSession
from test_session_prompt_guard import MENU

LONG_MENU = MENU.replace('task_id: test-task', 'result:\n'+'\n'.join(f'  argument {i}: value' for i in range(70)))

class PermissionGeometryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.manager=PTYManager()
        self.session=PTYSession('session','/tmp',cols=120,rows=40)
        self.session.is_alive=Mock(return_value=True)
        self.manager._sessions['session']=self.session
        self.capture=OutputCaptureProcessor();self.capture.set_geometry_provider(self.manager.get_geometry)
        self.state=SimpleNamespace(is_owner=True)
        self.blocked=None
        self.captured_state=LONG_MENU.splitlines()[-40:]
        self.pending_frame=False
        self.streams={'session':object()}
        def resize(cols,rows):
            self.session.cols,self.session.rows=cols,rows
            self.pending_frame=True
            return True
        self.resize=Mock(side_effect=resize);self.session.resize=self.resize
        async def sleep(_):
            if self.pending_frame:
                self.pending_frame=False
                await self.capture.process('session',('\x1b[2J\x1b[H'+LONG_MENU.replace('\n','\r\n')).encode())
        names={'_session_permission_menu','_is_incomplete_permission_screen','_expand_overview_permission_screen','get_session_output'}
        tree=ast.parse(Path(__file__).with_name('server.py').read_text())
        self.ns={'re':re,'web':web,'pty_mgr':self.manager,'capture_proc':self.capture,
            '_terminal_streams':self.streams,'_asyncio':SimpleNamespace(sleep=sleep),
            '_get_readable_session_for_request':AsyncMock(return_value={'id':'session'}),
            '_session_cli_type':AsyncMock(return_value='claude'),
            '_detect_cli_startup_blocker':lambda *_:None,'_startup_blocker_text':lambda _: '',
            'get_auth':lambda _:self.state,'_terminal_control_violation':lambda *_:self.blocked}
        exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in names],type_ignores=[]),'server.py','exec'),self.ns)

    async def feed_long(self):
        await self.capture.process('session',LONG_MENU.replace('\n','\r\n').encode())
        self.assertNotIn('Tool use',self.capture.get_screen('session'))
        self.assertEqual(len(self.capture.get_screen('session').splitlines()),40)

    async def output(self,permission=True):
        req=SimpleNamespace(match_info={'id':'session'},query={'lines':'100',**({'permission_view':'1'} if permission else {})})
        response=await self.ns['get_session_output'](req)
        self.assertEqual(response.status,200)
        return json.loads(response.text)

    async def test_long_permission_redraw_gives_complete_current_frame(self):
        await self.feed_long()
        result=await self.output()
        self.assertEqual(result['permission_view_state'],'ready')
        self.assertIn('Tool use',result['screen'])
        self.assertIn('argument 0: value',result['screen'])
        self.assertIn('argument 69: value',result['screen'])
        self.assertIsNotNone(self.ns['_session_permission_menu'](result['screen']))
        self.resize.assert_called_once_with(120,200)
        self.assertIsNone(self.session.geometry_owner)

    async def test_active_geometry_owner_never_resized(self):
        await self.feed_long();self.session.geometry_owner='visible-terminal'
        result=await self.output()
        self.assertEqual(result['permission_view_state'],'terminal_in_use')
        self.assertNotIn('Tool use',result['screen']);self.resize.assert_not_called()
        self.assertEqual(self.session.rows,40)

    async def test_read_only_caller_cannot_resize_through_get(self):
        await self.feed_long();self.blocked='read-only visitor'
        result=await self.output()
        self.assertEqual(result['permission_view_state'],'control_unavailable')
        self.assertNotIn('Tool use',result['screen']);self.resize.assert_not_called()

    async def test_ordinary_output_get_never_changes_geometry(self):
        await self.feed_long();result=await self.output(permission=False)
        self.assertIsNone(result['permission_view_state']);self.resize.assert_not_called()

    async def test_complete_short_prompt_does_not_redraw(self):
        await self.capture.process('session',MENU.replace('\n','\r\n').encode())
        await self.output();self.resize.assert_not_called()

    async def test_emulator_tracks_real_terminal_geometry_on_every_frame(self):
        self.session.cols,self.session.rows=140,120
        await self.capture.process('session',LONG_MENU.replace('\n','\r\n').encode())
        self.assertIn('Tool use',self.capture.get_screen('session'))
        self.assertEqual((self.capture._screens['session'].cols,self.capture._screens['session'].rows),(140,120))
        self.session.cols,self.session.rows=80,25
        await self.capture.process('session',b'\x1b[2J\x1b[Hchanged')
        self.assertEqual((self.capture._screens['session'].cols,self.capture._screens['session'].rows),(80,25))

    async def test_overview_height_is_bounded(self):
        self.session.rows=200
        self.assertTrue(self.manager.expand_unowned_geometry('session')['changed'])
        self.assertEqual(self.session.rows,400)
        self.assertEqual(self.manager.expand_unowned_geometry('session'),{'changed':False,'state':'incomplete'})
        self.assertEqual(self.resize.call_count,1)

if __name__=='__main__':unittest.main()
