import asyncio
from pathlib import Path
import unittest

from phone_availability import PhoneAvailability, MAX_DURATION


class Helper:
    def __init__(self):
        self.calls = []
        self.phase = "ready"
        self.start_token = "private-test-lease"

    async def __call__(self, value):
        self.calls.append(value)
        action = value["action"]
        if action == "start":
            self.phase = "active"
        if action == "stop":
            self.phase = "stopped"
        result = {"ok": True, "status": self.phase, "battery_percent": 70,
                  "lease_id": self.start_token, "internal": "not-for-browser"}
        return result


class AvailabilityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.helper = Helper()
        self.connected = True
        self.controller = PhoneAvailability(helper=Path('/unused-test-helper'), caller=self.helper, connected=lambda: self.connected)
        self.addAsyncCleanup(self.controller.close)

    async def test_granted_session_stays_private_and_restores_on_app_close(self):
        result = await self.controller.start(allow_battery=True)
        self.assertEqual(result['state'], 'active')
        self.assertNotIn('lease_id', result)
        self.assertNotIn('internal', result)
        self.assertEqual(self.helper.calls[-1]['duration_seconds'], MAX_DURATION)
        self.assertTrue(self.helper.calls[-1]['allow_battery'])
        await self.controller.close()
        self.assertEqual(self.helper.calls[-1]['action'], 'stop')
        self.assertEqual(self.helper.calls[-1]['lease_id'], 'private-test-lease')
        self.assertIsNone(self.controller.lease)

    async def test_no_power_changes_before_secure_connection(self):
        self.connected = False
        with self.assertRaises(ValueError):
            await self.controller.start(allow_battery=True)
        self.assertEqual(self.helper.calls, [])

    async def test_os_approval_is_not_reported_as_active(self):
        self.helper.phase = 'needs_approval'
        result = await self.controller.start(allow_battery=True)
        self.assertEqual(result['state'], 'needs_approval')
        self.assertIsNone(self.controller.task)
        self.assertEqual([c['action'] for c in self.helper.calls], ['status'])

    async def test_missing_lease_is_a_failure_even_if_helper_claims_active(self):
        self.helper.start_token = None
        with self.assertRaises(RuntimeError):
            await self.controller.start(allow_battery=True)
        self.assertEqual(self.controller.last['state'], 'blocked')
        self.assertIsNone(self.controller.task)

    async def test_reading_status_does_not_register_or_start_helper(self):
        await self.controller.status()
        self.assertEqual([c['action'] for c in self.helper.calls], ['status'])

    async def test_duplicate_start_does_not_create_unmanaged_leases(self):
        await asyncio.gather(self.controller.start(allow_battery=True), self.controller.start(allow_battery=True))
        self.assertEqual(sum(c['action'] == 'start' for c in self.helper.calls), 1)

    async def delayed_status(self, result=None, error=None):
        """Hold one read while real controller lifecycle calls continue."""
        entered = asyncio.Event()
        release = asyncio.Event()
        captured = False

        async def caller(payload):
            nonlocal captured
            if payload['action'] == 'status' and not captured:
                captured = True
                entered.set()
                await release.wait()
                if error:
                    raise error
                return result
            return await self.helper(payload)

        self.controller.caller = caller
        self.controller.last_check = float('-inf')
        pending = asyncio.create_task(self.controller.status())

        async def finish_read():
            release.set()
            await asyncio.wait_for(pending, 1)

        self.addAsyncCleanup(finish_read)
        await asyncio.wait_for(entered.wait(), 1)
        return pending, release

    async def test_late_active_status_cannot_undo_acknowledged_stop(self):
        await self.controller.start(allow_battery=True)
        pending, release = await self.delayed_status(
            {'ok': True, 'status': 'active', 'lease_id': 'private-old-lease'})
        stopped = await asyncio.wait_for(self.controller.stop(), 1)
        self.assertFalse(pending.done(), 'Stop must not wait for the slow status read')
        self.assertEqual(stopped['state'], 'stopped')
        release.set()
        self.assertEqual(await pending, stopped)
        self.assertEqual(self.controller.last, stopped)
        self.assertIsNone(self.controller.lease)
        self.assertNotIn('lease_id', self.controller.last)

    async def test_late_ready_status_cannot_undo_acknowledged_start(self):
        pending, release = await self.delayed_status({'ok': True, 'status': 'ready'})
        started = await asyncio.wait_for(self.controller.start(allow_battery=True), 1)
        self.assertFalse(pending.done(), 'Start must not wait for the slow status read')
        self.assertEqual(started['state'], 'active')
        release.set()
        self.assertEqual(await pending, started)
        self.assertEqual(self.controller.last, started)
        self.assertEqual(self.controller.lease, 'private-test-lease')
        self.assertIsNotNone(self.controller.task)

    async def test_late_status_failure_cannot_replace_verified_restoration(self):
        await self.controller.start(allow_battery=True)
        pending, release = await self.delayed_status(error=RuntimeError('synthetic timeout'))
        stopped = await asyncio.wait_for(self.controller.stop(), 1)
        release.set()
        self.assertEqual(await pending, stopped)
        self.assertEqual(self.controller.last, stopped)
        self.assertNotIn('message', self.controller.last)


if __name__ == '__main__':
    unittest.main()
