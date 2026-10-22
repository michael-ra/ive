"""Commander events and session-less messages reach the right browsers."""
import ast
import asyncio
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import db as database
import board_doc_backstop
import event_bus
from commander_events import CommanderEvent
from test_worker_context_contract import load_functions


class TempDbCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ive-event-delivery-')
        self.addCleanup(self.tmp.cleanup)
        for key, value in [('DATA_DIR', Path(self.tmp.name)), ('DB_PATH', Path(self.tmp.name) / 'state.db')]:
            p = patch.object(database, key, value); p.start(); self.addCleanup(p.stop)
        await database.init_db()


class BusClientSinkTests(TempDbCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.bus = event_bus.EventBus()
        self.sent = []
        async def sink(envelope):
            self.sent.append(envelope)
        self.sink = sink

    async def settle(self):
        for _ in range(3):
            await asyncio.sleep(0)

    async def test_client_event_is_forwarded_with_top_level_scope(self):
        self.bus.set_client_sink(self.sink)
        await self.bus.emit(CommanderEvent.OBSERVATORY_SCAN_COMPLETED,
                            {'workspace_id': 'w1', 'scan_id': 's', 'source': 'github'})
        await self.settle()
        self.assertEqual(len(self.sent), 1)
        envelope = self.sent[0]
        self.assertEqual(envelope['type'], 'commander_event')
        self.assertEqual(envelope['workspace_id'], 'w1')
        self.assertIsNone(envelope['session_id'])
        self.assertEqual(envelope['event']['event_type'], 'observatory_scan_completed')
        self.assertEqual(envelope['event']['payload']['scan_id'], 's')

    async def test_server_only_events_stay_in_process(self):
        self.bus.set_client_sink(self.sink)
        await self.bus.emit(CommanderEvent.IDLE_REFLECTION_FIRED, {'session_id': 'x', 'workspace_id': 'w1'})
        await self.settle()
        self.assertEqual(self.sent, [])

    async def test_without_sink_nothing_is_scheduled(self):
        with patch.object(event_bus.asyncio, 'create_task') as create_task:
            await self.bus.emit(CommanderEvent.BLUEPRINT_READY, {'workspace_id': 'w1', 'task_id': 't'})
        create_task.assert_not_called()

    async def test_failing_sink_never_breaks_emit(self):
        async def broken(_):
            raise RuntimeError('socket gone')
        self.bus.set_client_sink(broken)
        with self.assertLogs('event_bus', level='ERROR'):
            record = await self.bus.emit(CommanderEvent.BLUEPRINT_READY, {'workspace_id': 'w1', 'task_id': 't'})
            await self.settle()
        self.assertEqual(record.event_type, 'blueprint_ready')

    def test_bus_owns_no_websocket_clients(self):
        self.assertFalse(hasattr(self.bus, '_ws_clients'))
        self.assertFalse(hasattr(self.bus, 'register_ws'))


class FakeSocket:
    def __init__(self, *, owner=False, workspace_id=None):
        self._ive_auth_ctx = SimpleNamespace(is_owner=owner, workspace_id=workspace_id)
        self.messages = []

    async def send_str(self, data):
        self.messages.append(json.loads(data))


class ScopedCommanderBroadcastTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.owner = FakeSocket(owner=True)
        self.joiner = FakeSocket(workspace_id='w1')
        self.other = FakeSocket(workspace_id='w2')
        clients = {self.owner, self.joiner, self.other}
        ns = load_functions('server.py', {'broadcast', '_broadcast_commander_event', '_workspace_visible_to_auth'},
            json=json, ws_clients=clients, asyncio=asyncio,
            get_session_config=AsyncMock(side_effect=lambda sid: {'id': sid, 'workspace_id': 'w1'} if sid == 's1' else None),
            _session_readable_to_auth=lambda session, ctx: ctx.is_owner or ctx.workspace_id == session.get('workspace_id'),
            _process_test_queue=AsyncMock())
        self.send = ns['_broadcast_commander_event']

    def envelope(self, **scope):
        record = event_bus.EventRecord(id=1, event_type='task_created', source='api', payload={'task_id': 't'},
            workspace_id=scope.get('workspace_id'), session_id=scope.get('session_id'), task_id='t',
            actor=None, created_at='now')
        return event_bus.client_envelope(record)

    def received(self):
        return [len(s.messages) for s in (self.owner, self.joiner, self.other)]

    async def test_workspace_event_reaches_owner_and_that_workspace_only(self):
        await self.send(self.envelope(workspace_id='w1'))
        self.assertEqual(self.received(), [1, 1, 0])

    async def test_session_event_is_scoped_through_the_session_row(self):
        await self.send(self.envelope(session_id='s1'))
        self.assertEqual(self.received(), [1, 1, 0])

    async def test_unscoped_event_goes_to_owners_only(self):
        await self.send(self.envelope())
        self.assertEqual(self.received(), [1, 0, 0])

    def test_startup_installs_the_scoped_sink(self):
        tree = ast.parse(Path(__file__).with_name('server.py').read_text())
        startup = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'on_startup')
        self.assertIn('bus.set_client_sink(_broadcast_commander_event)', ast.unparse(startup))


class BackstopBoardRefreshTests(TempDbCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        conn = await database.get_db()
        try:
            await conn.execute("INSERT INTO workspaces(id,name,path) VALUES('w1','W',?)", (self.tmp.name,))
            await conn.execute("INSERT INTO sessions(id,workspace_id,name) VALUES('s1','w1','Fix login')")
            await conn.execute("INSERT INTO tasks(id,workspace_id,title,status) VALUES('t1','w1','Login','in_progress')")
            await conn.commit()
        finally:
            await conn.close()
        self.sent = AsyncMock()
        p = patch.object(board_doc_backstop, '_broadcast_fn', self.sent); p.start(); self.addCleanup(p.stop)

    async def test_new_auto_triage_ticket_is_pushed_to_boards(self):
        await board_doc_backstop._process_session(
            {'id': 's1', 'name': 'Fix login', 'decisions': 'Use OAuth'}, 'w1', 'review', 'backlog')
        message = self.sent.await_args.args[0]
        self.assertEqual(message['type'], 'task_update')
        self.assertEqual(message['action'], 'created')
        self.assertEqual(message['task']['workspace_id'], 'w1')
        self.assertTrue(message['task']['title'].startswith('[auto-triage]'))

    async def test_updated_ticket_is_pushed_with_its_new_status(self):
        await board_doc_backstop._process_session(
            {'id': 's1', 'name': 'Fix login', 'task_id': 't1', 'decisions': 'Use OAuth'}, 'w1', 'review', 'backlog')
        message = self.sent.await_args.args[0]
        self.assertEqual((message['type'], message['action']), ('task_update', 'updated'))
        self.assertEqual((message['task']['id'], message['task']['status']), ('t1', 'review'))

    async def test_skipped_session_sends_nothing(self):
        await board_doc_backstop._process_session({'id': 's1', 'name': 'Idle'}, 'w1', 'review', 'backlog')
        self.sent.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
