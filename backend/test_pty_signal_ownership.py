"""Signals must never escape the PTY's owned child during fork/setsid startup."""
import asyncio
import os
import signal
import tempfile
import unittest
from unittest.mock import patch

from pty_manager import PTYManager, PTYSession


class PtySignalOwnershipTests(unittest.TestCase):
    def make(self):
        session=PTYSession('signal-fixture','/tmp')
        session.pid=123456789
        session._alive=True
        return session

    def test_inherited_or_foreign_group_receives_no_signal(self):
        for pgid in (os.getpgrp(),123456788):
            with self.subTest(pgid=pgid),patch('pty_manager.os.getpgid',return_value=pgid),patch('pty_manager.os.kill') as kill,patch('pty_manager.os.killpg') as killpg:
                session=self.make()
                self.assertTrue(session._signal_owned_process(signal.SIGINT))
                kill.assert_called_once_with(session.pid,signal.SIGINT)
                killpg.assert_not_called()

    def test_verified_child_group_receives_signal_for_descendants(self):
        session=self.make()
        with patch('pty_manager.os.getpgid',return_value=session.pid),patch('pty_manager.os.kill') as kill,patch('pty_manager.os.killpg') as killpg:
            self.assertTrue(session._signal_owned_process(signal.SIGTERM))
            killpg.assert_called_once_with(session.pid,signal.SIGTERM)
            kill.assert_not_called()

    def test_escalation_uses_the_same_parent_group_guard(self):
        session=self.make()
        with patch('pty_manager.os.getpgid',return_value=os.getpgrp()),patch('pty_manager.os.kill') as kill,patch('pty_manager.os.killpg') as killpg:
            session._escalate_kill(signal.SIGKILL)
            kill.assert_called_once_with(session.pid,signal.SIGKILL)
            killpg.assert_not_called()

    def test_resize_never_signals_inherited_parent_group(self):
        session=self.make();session.master_fd=987654321
        with patch('pty_manager.fcntl.ioctl'),patch('pty_manager.os.getpgid',return_value=os.getpgrp()),patch('pty_manager.os.kill') as kill,patch('pty_manager.os.killpg') as killpg:
            self.assertTrue(session.resize(140,60))
            kill.assert_called_once_with(session.pid,signal.SIGWINCH)
            killpg.assert_not_called()

    def test_finished_or_missing_child_is_not_signalled(self):
        session=self.make();session._alive=False
        with patch('pty_manager.os.getpgid') as getpgid,patch('pty_manager.os.kill') as kill,patch('pty_manager.os.killpg') as killpg:
            self.assertFalse(session._signal_owned_process(signal.SIGKILL))
            session._escalate_kill(signal.SIGKILL)
            getpgid.assert_not_called();kill.assert_not_called();killpg.assert_not_called()
        session._alive=True
        with patch('pty_manager.os.getpgid',side_effect=ProcessLookupError),patch('pty_manager.os.kill') as kill,patch('pty_manager.os.killpg') as killpg:
            self.assertFalse(session._signal_owned_process(signal.SIGKILL))
            kill.assert_not_called();killpg.assert_not_called()


class PtyForkStartupTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_child_can_be_stopped_before_setsid_without_signalling_parent(self):
        ready_r,ready_w=os.pipe()
        gate_r,gate_w=os.pipe()
        os.set_blocking(ready_r,False)
        actual_setsid=os.setsid
        def blocked_setsid():
            # Runs only in the new child. Keep it in the parent's process group
            # until the test has observed the exact startup race window.
            signal.signal(signal.SIGINT,signal.SIG_DFL)
            os.write(ready_w,b'1')
            os.read(gate_r,1)
            return actual_setsid()
        manager=PTYManager()
        try:
            with tempfile.TemporaryDirectory(prefix='ive-pty-startup-') as root:
                with patch('pty_manager.os.setsid',blocked_setsid):
                    await manager.start_session('race',root,cmd_binary='sleep',cmd_args=['60'])
                async with asyncio.timeout(5):
                    while True:
                        try:
                            if os.read(ready_r,1):break
                        except BlockingIOError:
                            pass
                        await asyncio.sleep(.01)
                child=manager._sessions['race'].pid
                self.assertEqual(os.getpgid(child),os.getpgrp())
                await asyncio.wait_for(manager.stop_all(),5)
                self.assertFalse(manager.is_alive('race'))
                with self.assertRaises(ProcessLookupError):os.kill(child,0)
        finally:
            # Release a surviving child if an assertion failed, then clean up
            # only this fixture's PTY; no live server or CLI is involved.
            try:os.write(gate_w,b'1')
            except BrokenPipeError:pass
            await asyncio.wait_for(manager.stop_all(),7)
            for fd in (ready_r,ready_w,gate_r,gate_w):os.close(fd)


if __name__=='__main__':unittest.main()
