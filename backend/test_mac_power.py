"""Lid power control tests: fake helper only; never changes host power or apps."""
import asyncio
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

from phone_availability import PhoneAvailability
from test_phone_availability import Helper


class MacPowerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.helper = Helper()
        async def call(payload):
            return {**await self.helper(payload), "lid_saver_supported": True,
                    "lid_low_power": True, "pause_apps": ["com.hnc.Discord"],
                    "lid_closed": False, "lid_saver_active": False}
        self.controller = PhoneAvailability(helper=Path('/unused-helper'), caller=call, connected=lambda: False)
        self.addAsyncCleanup(self.controller.close)
        self.options = dict(purpose='agent', duration_seconds=1800, allow_battery=True,
                            lid_low_power=True, pause_apps=['com.hnc.Discord'])

    async def test_agent_mode_works_without_phone_tunnel_and_never_leaks_lease(self):
        view = await self.controller.start(**self.options)
        self.assertEqual(view['mode_source'], 'agent')
        self.assertEqual(view['state'], 'active')
        self.assertFalse(view['lid_saver_active'])
        self.assertNotIn('lease_id', view)
        self.assertEqual(self.helper.calls[-1]['duration_seconds'], 1800)
        self.assertEqual(self.helper.calls[-1]['pause_apps'], ['com.hnc.Discord'])
        self.assertTrue(self.helper.calls[-1]['lid_low_power'])

    async def test_repeated_start_does_not_extend_timer(self):
        await asyncio.gather(self.controller.start(**self.options), self.controller.start(**self.options))
        self.assertEqual(sum(c['action'] == 'start' for c in self.helper.calls), 1)

    async def test_phone_consent_change_cannot_stop_independent_agent_mode(self):
        await self.controller.start(**self.options)
        await self.controller.stop_phone()
        self.assertIsNotNone(self.controller.lease)
        self.assertFalse(any(c['action'] == 'stop' for c in self.helper.calls))

    async def test_phone_mode_cannot_silently_replace_agent_mode(self):
        await self.controller.start(**self.options)
        with self.assertRaises(ValueError):
            await self.controller.start(allow_battery=True)
        self.assertFalse(any(c['action'] == 'stop' for c in self.helper.calls))

    async def test_invalid_or_dangerous_options_do_not_reach_native_helper(self):
        for change in [dict(duration_seconds=0), dict(duration_seconds=28801),
                       dict(duration_seconds=3600.0), dict(duration_seconds=True),
                       dict(allow_battery=1), dict(lid_low_power='true'),
                       dict(pause_apps=['com.apple.Terminal']), dict(pause_apps=['com.google.Chrome']),
                       dict(pause_apps=['com.hnc.Discord'] * 2), dict(pause_apps='Discord')]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                await self.controller.start(**{**self.options, **change})
        self.assertEqual(self.helper.calls, [])

    async def test_old_helper_cannot_claim_lid_saving_is_supported(self):
        self.controller.caller = self.helper
        with self.assertRaisesRegex(RuntimeError, 'Update'):
            await self.controller.start(**self.options)
        self.assertEqual([c['action'] for c in self.helper.calls], ['status'])

    async def test_unapproved_helper_never_starts_from_status(self):
        self.helper.phase = 'needs_approval'
        self.assertEqual((await self.controller.start(**self.options))['state'], 'needs_approval')
        self.assertEqual([c['action'] for c in self.helper.calls], ['status'])
        self.assertIsNone(self.controller.task)

    async def test_start_timeout_is_uncertain_not_ready(self):
        caller = self.controller.caller
        async def fail(payload):
            if payload['action'] == 'start':
                raise TimeoutError('fake timeout')
            return await caller(payload)
        self.controller.caller = fail
        with self.assertRaises(TimeoutError):
            await self.controller.start(**self.options)
        self.assertEqual(self.controller.last['state'], 'restoring')
        self.assertIsNone(self.controller.task)

    async def test_agent_heartbeat_survives_disconnected_tunnel(self):
        await self.controller.start(**self.options)
        await self.controller._cancel_heartbeat()
        calls = []
        async def renewed(payload):
            calls.append(payload)
            return {'ok': True, 'status': 'ready', 'reason': 'duration_ended'}
        self.controller.caller = renewed
        with patch('phone_availability.asyncio.sleep', new=AsyncMock()):
            await self.controller._heartbeat()
        self.assertEqual(calls[0]['action'], 'renew')
        self.assertIsNone(self.controller.lease)

    async def test_failed_stop_retains_token_for_explicit_retry(self):
        await self.controller.start(**self.options)
        caller = self.controller.caller
        async def fail(payload):
            if payload['action'] == 'stop':
                return {'ok': False, 'status': 'restore_failed'}
            return await caller(payload)
        self.controller.caller = fail
        self.assertEqual((await self.controller.stop())['state'], 'restore_failed')
        self.assertIsNotNone(self.controller.lease)
        self.controller.caller = caller
        await self.controller.stop()
        self.assertIsNone(self.controller.lease)


if __name__ == '__main__':
    unittest.main()
