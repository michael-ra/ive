"""Guard Overview permission replies against stale screens and accidental Enter."""
import ast
import json
from pathlib import Path
import re
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock
from aiohttp import web
from test_input_contract_review import Request

MENU = """Tool use
worker-board — Get My Task Tool: (MCP)
task_id: test-task
Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for worker-board commands
      in /test/project
   3. No

Esc to cancel · Tab to amend"""

class SessionPromptGuardTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.screen, self.writes = MENU, []
        self.write_ok, self.navigate, self.alive = True, True, True
        self.after_write, self.on_sleep = None, None
        self.ns = {
            're': re, 'web': web, '_terminal_streams': {'session': object()}, '_session_prompt_replies': {},
            'capture_proc': SimpleNamespace(get_screen=lambda _: self.screen),
            'pty_mgr': SimpleNamespace(is_alive=lambda _: self.alive, write=self.write),
            '_asyncio': SimpleNamespace(sleep=self.sleep),
            '_get_visible_session_for_request': AsyncMock(return_value={'id':'session','cli_type':'claude'}),
            'get_auth': lambda _: None, '_terminal_control_violation': lambda *_: None,
            '_session_cli_type': AsyncMock(return_value='claude'), '_is_auth_recovery_input': Mock(return_value=False),
        }
        names = {'_canonical_prompt_screen','_session_permission_menu','_is_incomplete_permission_screen','_send_guarded_session_prompt','send_session_input'}
        tree = ast.parse(Path(__file__).with_name('server.py').read_text())
        nodes = [n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in names]
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'server.py','exec'),self.ns)
        self.send = self.ns['send_session_input']

    def write(self, _, data):
        self.writes.append(data)
        if not self.write_ok: return False
        if self.navigate and data in (b'\x1b[B',b'\x1b[A'):
            menu = self.ns['_session_permission_menu'](self.screen)
            before = int(menu['selected'])
            after = before + (1 if data == b'\x1b[B' else -1)
            self.screen = self.screen.replace(f' ❯ {before}.',f'   {before}.').replace(f'   {after}.',f' ❯ {after}.')
        if self.after_write: self.after_write(data)
        return True

    async def sleep(self, _):
        if self.on_sleep: self.on_sleep()

    async def reply(self, message='1', **body):
        return await self.send(Request({'message':message,'expected_screen':MENU,'ready_timeout':0,**body}))

    async def test_exact_live_menu_selected_yes_sends_only_enter(self):
        self.assertEqual((await self.reply()).status,200)
        self.assertEqual(self.writes,[b'\r'])
        self.ns['_is_auth_recovery_input'].assert_not_called()

    async def test_named_hook_menu_allows_only_current_explicit_choice(self):
        self.screen = MENU.replace('Tool use\nworker-board — Get My Task Tool: (MCP)',
            'ToolSearch\n│ Hook PreToolUse:ToolSearch requires confirmation for this tool:\n│ missing API key (fail-closed)')
        expected = self.screen
        self.assertEqual((await self.reply('3', expected_screen=expected)).status, 200)
        self.assertEqual(self.writes, [b'\x1b[B', b'\x1b[B', b'\r'])

    async def test_named_hook_menu_requires_matching_header_and_notice(self):
        screen = MENU.replace('Tool use\nworker-board — Get My Task Tool: (MCP)',
            'ToolSearch\n│ Hook PreToolUse:ToolSearch requires confirmation for this tool:')
        for invalid in [screen.replace('ToolSearch\n', '', 1), screen.replace('ToolSearch\n', 'Read\n', 1),
                        screen.replace('PreToolUse:ToolSearch', 'PreToolUse:Read')]:
            self.assertIsNone(self.ns['_session_permission_menu'](invalid))
        self.screen = screen.replace('PreToolUse:ToolSearch', 'PreToolUse:Read')
        self.assertEqual((await self.reply('1', expected_screen=screen)).status, 409)
        self.assertEqual(self.writes, [])

    async def test_no_moves_to_third_option_then_confirms(self):
        self.assertEqual((await self.reply('3')).status,200)
        self.assertEqual(self.writes,[b'\x1b[B',b'\x1b[B',b'\r'])
        self.assertEqual(self.ns['_session_permission_menu'](self.screen)['selected'],'3')

    async def test_two_choice_permission_can_allow_once(self):
        self.screen = MENU.replace("   2. Yes, and don't ask again for worker-board commands\n      in /test/project\n   3. No", "   2. No")
        self.assertEqual(self.ns['_session_permission_menu'](self.screen)['choices'], ('1', '2'))
        self.assertEqual((await self.reply('1', expected_screen=self.screen)).status, 200)
        self.assertEqual(self.writes, [b'\r'])

    async def test_two_choice_no_moves_once_and_does_not_allow_persistently(self):
        self.screen = MENU.replace("   2. Yes, and don't ask again for worker-board commands\n      in /test/project\n   3. No", "   2. No")
        self.assertEqual((await self.reply('2', expected_screen=self.screen)).status, 200)
        self.assertEqual(self.writes, [b'\x1b[B', b'\r'])

    async def test_changed_two_choice_request_never_gets_enter(self):
        expected = MENU.replace("   2. Yes, and don't ask again for worker-board commands\n      in /test/project\n   3. No", "   2. No")
        self.screen = expected.replace('test-task', 'delete-project')
        self.assertEqual((await self.reply('1', expected_screen=expected)).status, 409)
        self.assertEqual(self.writes, [])

    async def test_no_enter_without_redraw_confirmation(self):
        self.navigate=False
        self.assertEqual((await self.reply('2')).status,409)
        self.assertEqual(self.writes,[b'\x1b[B'])

    async def test_changed_menu_during_navigation_never_gets_enter(self):
        self.after_write=lambda _:setattr(self,'screen',MENU.replace('test-task','other-task'))
        self.assertEqual((await self.reply('2')).status,409)
        self.assertNotIn(b'\r',self.writes)

    async def test_stale_screen_has_zero_writes(self):
        self.screen=MENU.replace('test-task','other-task')
        response=await self.reply()
        self.assertEqual(response.status,409)
        self.assertEqual(json.loads(response.text)['code'],'stale_session_prompt')
        self.assertEqual(self.writes,[])

    async def test_duplicate_cannot_confirm_same_screen_twice(self):
        self.assertEqual((await self.reply()).status,200)
        self.assertEqual((await self.reply()).status,409)
        self.assertEqual(self.writes,[b'\r'])

    async def test_invalid_choice_and_raw_never_write(self):
        for body in ({'message':'yes'},{'message':'4'},{'raw':True},{'message':'1\n'}):
            with self.subTest(body=body):
                self.assertEqual((await self.reply(**body)).status,400)
                self.assertEqual(self.writes,[])

    async def test_auth_recovery_cannot_bypass_stale_guard(self):
        self.screen='different'
        self.assertEqual((await self.reply('/login',prompt_reply=True)).status,409)
        self.ns['_is_auth_recovery_input'].assert_not_called()
        self.assertEqual(self.writes,[])

    async def test_old_or_unknown_menu_does_not_offer_numeric_controls(self):
        for screen in (MENU+'\n❯ Try something',MENU.replace('3. No','3. Something else')):
            self.assertIsNone(self.ns['_session_permission_menu'](screen))
            self.screen=screen
            self.assertEqual((await self.reply(expected_screen=screen)).status,409 if 'Something else' in screen else 400)
            self.assertEqual(self.writes,[])

    async def test_manual_requires_flag_and_allows_only_echo_before_enter(self):
        self.screen='What name should I use?\n>'
        expected=self.screen
        self.assertEqual((await self.reply('Alice',expected_screen=expected)).status,400)
        self.assertEqual(self.writes,[])
        self.after_write=lambda data:setattr(self,'screen',expected+' Alice') if data!=b'\r' else None
        self.assertEqual((await self.reply('Alice',expected_screen=expected,prompt_reply=True)).status,200)
        self.assertEqual(self.writes,[b'Alice',b'\r'])

    async def test_changed_manual_question_does_not_receive_enter(self):
        self.screen='What name should I use?\n>'
        expected=self.screen
        self.after_write=lambda _:setattr(self,'screen','Proceed with deletion?\n> Yes')
        response=await self.reply('Alice',expected_screen=expected,prompt_reply=True)
        self.assertEqual(response.status,409)
        self.assertTrue(json.loads(response.text)['partial'])
        self.assertEqual(self.writes,[b'Alice'])

    async def test_restarted_pty_does_not_receive_enter(self):
        self.on_sleep=lambda:self.ns['_terminal_streams'].update(session=object())
        self.assertEqual((await self.reply('2')).status,409)
        self.assertNotIn(b'\r',self.writes)

    async def test_failed_submit_never_acknowledges_and_can_retry(self):
        self.write_ok=False
        response=await self.reply()
        self.assertEqual(response.status,503)
        self.assertFalse(json.loads(response.text).get('ok'))
        self.write_ok=True
        self.assertEqual((await self.reply()).status,200)

    async def test_crlf_and_outer_whitespace_normalization(self):
        self.assertEqual((await self.reply(expected_screen='\r\n'+MENU.replace('\n','\r\n')+'\r\n')).status,200)

    def test_unicode_cursor_and_wrapped_label(self):
        menu=self.ns['_session_permission_menu'](MENU.replace(' ❯ ',' ❯\u00a0'))
        self.assertEqual(menu['choices'],('1','2','3'))
        self.assertIn('in /test/project',menu['identity'])

    async def test_live_spinner_redraw_preserves_exact_permission_request(self):
        expected='⏺ Looking for project files\n✻ Working…\n'+MENU
        self.screen='⏺ Looking for project files\n✽ Working… (2s)\n'+MENU
        self.assertNotEqual(self.screen,expected)
        self.assertEqual((await self.reply(expected_screen=expected)).status,200)
        self.assertEqual(self.writes,[b'\r'])

    async def test_scrolled_previous_output_during_navigation_is_irrelevant(self):
        self.screen='Old transcript\n⏺ Reading files\n'+MENU
        expected=self.screen
        self.after_write=lambda data:setattr(self,'screen',self.screen.replace('Old transcript\n⏺ Reading files','Different preceding output\n  Reading files')) if data!=b'\r' else None
        self.assertEqual((await self.reply('3',expected_screen=expected)).status,200)
        self.assertEqual(self.writes,[b'\x1b[B',b'\x1b[B',b'\r'])

    async def test_changed_dialog_argument_tool_or_description_never_approved(self):
        for original,replacement in [('task_id: test-task','task_id: other-task'),
                                     ('Get My Task Tool','Delete Task Tool'),
                                     ('in /test/project','in /production/project')]:
            with self.subTest(change=original):
                self.screen='New previous output\n'+MENU.replace(original,replacement)
                self.assertEqual((await self.reply(expected_screen='Old previous output\n'+MENU)).status,409)
                self.assertEqual(self.writes,[])

    async def test_cropped_request_header_cannot_be_confirmed(self):
        self.screen=MENU[MENU.index('task_id:'):]
        self.assertIsNone(self.ns['_session_permission_menu'](self.screen))
        self.assertEqual((await self.reply(expected_screen=self.screen)).status,409)
        self.assertEqual((await self.reply(expected_screen=self.screen,prompt_reply=True)).status,409)
        self.assertEqual(self.writes,[])

    async def test_manual_question_still_requires_exact_full_screen(self):
        self.screen='Changed prior output\nWhat name should I use?\n>'
        response=await self.reply('Alice',expected_screen='Old prior output\nWhat name should I use?\n>',prompt_reply=True)
        self.assertEqual(response.status,409)
        self.assertEqual(self.writes,[])

if __name__=='__main__': unittest.main()
