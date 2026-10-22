"""Capability truth and owned subprocess cancellation, without real providers."""
import asyncio
from pathlib import Path
import shlex
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from cli_features import Feature
from cli_session import UnifiedSession
from session_worktree import resolve_worktree
from headless_dispatch import run_headless


class WorktreeCapabilityTests(unittest.TestCase):
    def test_ui_capability_matches_the_effective_cli_command(self):
        for cli_type in ['claude','gemini','codex','antigravity']:
            session=UnifiedSession(cli_type,{'worktree':1})
            command=session.build_command()
            self.assertEqual('--worktree' in command,session.supports(Feature.WORKTREE),cli_type)
        self.assertFalse(UnifiedSession('codex').supports(Feature.WORKTREE))

    def test_unsupported_explicit_request_is_rejected_but_default_is_not_faked(self):
        with self.assertRaisesRegex(ValueError,'does not support'):
            resolve_worktree('codex',True)
        self.assertEqual(resolve_worktree('codex',default=True),0)
        self.assertEqual(resolve_worktree('claude',default=True),1)
        self.assertEqual(resolve_worktree('claude',False,default=True),0)
        self.assertEqual(resolve_worktree('codex','false',default=True),0)
        with self.assertRaises(ValueError):resolve_worktree('claude','perhaps')


class HeadlessCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancellation_kills_owned_descendants(self):
        with TemporaryDirectory() as tmp:
            root=Path(tmp)
            script=root/'fake-cli'
            child_code = (
                "import json,time\nfrom pathlib import Path\n"
                "print(json.dumps({'type':'fixture_child_ready'}),flush=True)\n"
                "while not Path('release').exists():time.sleep(.01)\n"
                "Path('escaped').touch()\n"
            )
            script.write_text('#!'+sys.executable+'\n'+
                "import subprocess,sys,time\n"
                f"subprocess.Popen([sys.executable,'-c',{child_code!r}])\n"
                "time.sleep(10)\n")
            script.chmod(0o755)
            ready=asyncio.Event()
            async def on_event(event):
                if event.get('type')=='fixture_child_ready':ready.set()
            task=asyncio.create_task(run_headless('test',tmp,cli_binary=str(script),cli_type='claude',on_event=on_event))
            ready_task=asyncio.create_task(ready.wait())
            try:
                done,_=await asyncio.wait({task,ready_task},timeout=5,return_when=asyncio.FIRST_COMPLETED)
                if task in done:
                    result=await task  # propagate a launch/reader exception rather than hide it
                    self.fail(f'Headless fixture exited before cancellation: {result}')
                self.assertIn(ready_task,done,'Child did not announce readiness within 5s')
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):await asyncio.wait_for(task,5)
                # A surviving descendant would write once released. Holding it
                # until cancellation removes scheduling/startup-time races.
                (root/'release').touch()
                await asyncio.sleep(.45)
                self.assertFalse((root/'escaped').exists())
            finally:
                (root/'release').touch()
                for pending in (task,ready_task):
                    if not pending.done():pending.cancel()
                await asyncio.gather(task,ready_task,return_exceptions=True)

    async def test_timeout_kills_owned_descendants(self):
        with TemporaryDirectory() as tmp:
            root=Path(tmp);script=root/'fake-cli'
            script.write_text('#!'+sys.executable+'\n'+"import subprocess,sys,time\nsubprocess.Popen([sys.executable,'-c',\"import time;from pathlib import Path;time.sleep(.4);Path('escaped').touch()\"])\ntime.sleep(2)\n")
            script.chmod(0o755)
            result=await run_headless('test',tmp,cli_binary=str(script),cli_type='claude',timeout=.1)
            self.assertFalse(result['ok']);self.assertIn('timed out',result['error'])
            await asyncio.sleep(.45);self.assertFalse((root/'escaped').exists())

if __name__=='__main__':unittest.main()
