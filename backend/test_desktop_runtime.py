"""Desktop resource/child-process contracts, with optional actual bundle smoke."""
import ast
import contextlib
import io
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.request
import urllib.error

import desktop_entry
import desktop_hook_relay
import helper_command
import resource_path


class DesktopRuntimeTests(unittest.TestCase):
    def test_frozen_resources_use_internal_root_and_ignore_inherited_dev_root(self):
        with patch.object(sys,'frozen',True,create=True),patch.object(sys,'_MEIPASS','/tmp/IVE App/_internal',create=True),patch.dict(os.environ,{'IVE_ROOT':'/private/developer/checkout'}):
            self.assertEqual(resource_path.project_root(),Path('/tmp/IVE App/_internal').resolve())
            self.assertEqual(resource_path.backend_dir(),Path('/tmp/IVE App/_internal/backend').resolve())

    def test_frozen_mcp_and_python_commands_use_the_dispatcher(self):
        with patch.object(sys,'frozen',True,create=True),patch.object(sys,'executable','/tmp/IVE App/ive-backend'):
            self.assertEqual(helper_command.helper_command('worker'),['/tmp/IVE App/ive-backend','--helper','worker'])
            self.assertEqual(helper_command.python_command('-m','deep_research'),['/tmp/IVE App/ive-backend','--python','-m','deep_research'])
            self.assertIn("'/tmp/IVE App/ive-backend' --python",helper_command.shell_python_function())
            with self.assertRaises(ValueError):helper_command.helper_command('../../unexpected')

    def test_dispatch_unknown_helpers_never_start_a_server(self):
        with patch.object(desktop_entry.runpy,'run_module') as run:
            with self.assertRaises(ValueError):desktop_entry.main(['--helper','../../server'])
            run.assert_not_called()

    def test_python_code_and_stdin_preserve_user_arguments(self):
        for args,stdin in [(['-c','import sys;print(sys.argv[1])','hello'],None),(['-','world'],'import sys;print(sys.argv[1])')]:
            out=io.StringIO()
            with patch.object(sys,'argv',sys.argv.copy()),patch.object(sys,'stdin',io.StringIO(stdin or '')),contextlib.redirect_stdout(out):
                desktop_entry.run_python(args)
            self.assertEqual(out.getvalue().strip(),args[-1])

    def test_python_module_dispatch_preserves_module_arguments(self):
        with patch.object(sys,'argv',sys.argv.copy()),patch.object(desktop_entry.runpy,'run_module') as run:
            desktop_entry.run_python(['-m','deep_research','--help'])
            self.assertEqual(sys.argv,['deep_research','--help'])
            run.assert_called_once_with('deep_research',run_name='__main__',alter_sys=True)

    def test_relay_forwards_real_permission_response_and_preserves_denial(self):
        with patch.dict(os.environ,{'COMMANDER_SESSION_ID':'session','COMMANDER_CLI_TYPE':'claude'},clear=True),patch.object(sys,'stdin',io.StringIO('{"hook_event_name":"PreToolUse"}')),patch.object(desktop_hook_relay,'post',return_value={'allow':False,'reason':'Locked "file"'}) as post,contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(desktop_hook_relay.main(),0)
            decision=json.loads(output.getvalue())['hookSpecificOutput']
            self.assertEqual(decision['permissionDecision'],'deny')
            self.assertEqual(decision['permissionDecisionReason'],'Locked "file"')
            self.assertEqual(post.call_args.args[2],'session')

    def test_relay_gemini_denial_uses_exit_code(self):
        with patch.dict(os.environ,{'COMMANDER_SESSION_ID':'session','COMMANDER_CLI_TYPE':'gemini'},clear=True),patch.object(sys,'stdin',io.StringIO('{"hook_event_name":"BeforeTool"}')),patch.object(desktop_hook_relay,'post',return_value={'allow':False}),contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(desktop_hook_relay.main(),2)


@unittest.skipUnless(os.environ.get('IVE_TEST_BUNDLE'), 'Set IVE_TEST_BUNDLE to smoke-test an actual packaged executable')
class FrozenBundleSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.binary=Path(os.environ['IVE_TEST_BUNDLE']).resolve()
        cls.tmp=tempfile.TemporaryDirectory(prefix='ive-frozen-smoke-')
        cls.root=Path(cls.tmp.name);(cls.root/'home').mkdir()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));cls.port=sock.getsockname()[1]
        cls.env={key:value for key,value in os.environ.items() if not key.startswith(('IVE_','COMMANDER_','WORKER_','CLAUDE_'))}
        cls.env.update(HOME=str(cls.root/'home'),PATH='/usr/bin:/bin:/usr/sbin:/sbin',IVE_DATA_DIR=str(cls.root/'data'),IVE_TELEMETRY='off',COMMANDER_HOST='127.0.0.1',COMMANDER_PORT=str(cls.port),IVE_DESKTOP_INSTANCE='frozen-smoke-nonce',IVE_ROOT='/unavailable-development-checkout')
        cls.log=(cls.root/'backend.log').open('w+')
        cls.proc=subprocess.Popen([str(cls.binary),'--headless'],cwd=cls.root,env=cls.env,stdout=cls.log,stderr=subprocess.STDOUT,start_new_session=True)
        cls.addClassCleanup(cls.cleanup_bundle)
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            if cls.proc.poll() is not None:break
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{cls.port}/ready',timeout=.5) as response:
                    cls.ready=json.load(response)
                    return
            except OSError:time.sleep(.1)
        cls.log.flush()
        raise AssertionError(f'Frozen startup failed (code={cls.proc.poll()}):\n'+(cls.root/'backend.log').read_text()[-9000:])

    @classmethod
    def cleanup_bundle(cls):
        if cls.proc.poll() is None:
            cls.proc.terminate()
            try:cls.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(cls.proc.pid,signal.SIGKILL);cls.proc.wait(timeout=5)
                raise AssertionError('Frozen backend required force termination')
        cls.log.close();cls.tmp.cleanup()

    def call(self,*args,input=None,extra_env=None):
        result=subprocess.run([str(self.binary),*args],env={**self.env,**(extra_env or {})},cwd=self.root,input=input,text=True,capture_output=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stderr[-3000:])
        return result.stdout

    def test_ready_has_exact_instance_and_real_bundle_metadata(self):
        self.assertEqual(self.ready['desktop_instance'],'frozen-smoke-nonce')
        self.assertTrue(self.ready['bundle']['frozen'])
        self.assertEqual(self.ready['bundle']['extensions'],['sandbox'])
        self.assertEqual(self.ready['version'],self.ready['bundle']['version'])
        self.assertEqual(self.ready['edition'],'integrated-dev')

    def test_frozen_desktop_enforces_host_origin_and_loads_sandbox_extension(self):
        request=urllib.request.Request(f'http://127.0.0.1:{self.port}/api/workspaces',headers={'Origin':'https://untrusted.invalid'})
        with self.assertRaises(urllib.error.HTTPError) as denied:
            urllib.request.urlopen(request,timeout=2)
        self.assertEqual(denied.exception.code,403)
        result=self.call('--python','-c','import extension_host,json;print(json.dumps({"sandbox":extension_host.available("sandbox"),"company":extension_host.available("company")}))')
        self.assertEqual(json.loads(result),{'sandbox':True,'company':False})

    def test_frontend_and_empty_database_come_from_bundle_and_isolated_state(self):
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/') as response:
            self.assertIn('<html',response.read().decode().lower())
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/api/workspaces') as response:
            self.assertEqual(json.load(response),[])
        self.assertTrue((self.root/'data/data.db').is_file())

    def test_all_five_builtin_mcp_helpers_speak_stdio_without_system_python(self):
        request='\n'.join(json.dumps(row) for row in [
            {'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'ive-smoke','version':'1'}}},
            {'jsonrpc':'2.0','id':2,'method':'tools/list','params':{}},
        ])+'\n'
        for helper in ('worker','commander','documentor','brainstormer','research-mcp'):
            with self.subTest(helper=helper):
                output=self.call('--helper',helper,input=request,extra_env={'WORKER_SESSION_ID':'fixture','WORKER_WORKSPACE_ID':'fixture','COMMANDER_WORKSPACE_ID':'fixture','COMMANDER_API_URL':f'http://127.0.0.1:{self.port}'})
                responses=[json.loads(line) for line in output.splitlines() if line.strip()]
                self.assertEqual([r['id'] for r in responses],[1,2])
                self.assertIn('tools',responses[1]['result'])

    def test_embedded_python_can_import_native_dependencies_and_run_research_cli(self):
        result=json.loads(self.call('--python','-c','import aiohttp,cryptography,pyte,json;print(json.dumps({"ok":True}))'))
        self.assertTrue(result['ok'])
        self.assertIn('research',self.call('--python','-m','deep_research','--help'))
        # Exercise the real bundled AVCP entry with network-bearing scanner
        # functions replaced at their boundary; no registry requests are sent.
        code='''import avcp_runtime,importlib.util,hooks
from types import SimpleNamespace
scanner=SimpleNamespace(full_check=lambda eco,pkg,days:{"package":pkg,"threshold":days})
loader=SimpleNamespace(exec_module=lambda module:None)
importlib.util.spec_from_file_location=lambda *args:SimpleNamespace(loader=loader)
importlib.util.module_from_spec=lambda *args:scanner
hooks._detect_install_scripts=lambda *args:[]
avcp_runtime.main(["npm","fixture","7"])
'''
        self.assertEqual(json.loads(self.call('--python','-c',code)),{'package':'fixture','threshold':7,'install_scripts':[]})

    def test_generated_hooks_and_git_wrapper_use_embedded_runtime(self):
        script='import hook_installer,git_attribution,json;hook_installer.generate_hook_script();hook_installer.generate_safety_gate_script();print(json.dumps({"git":str(git_attribution.ensure_git_wrapper()),"hook":str(hook_installer.HOOK_SCRIPT_PATH),"safety":str(hook_installer.SAFETY_GATE_SCRIPT_PATH)}))'
        generated=json.loads(self.call('--python','-c',script))
        hook=Path(generated['hook'])
        self.assertIn('--helper hook-relay',hook.read_text())
        self.assertIn('--python',Path(generated['safety']).read_text())
        result=subprocess.run([str(Path(generated['git'])/'git'),'--version'],env={**self.env,'IVE_REAL_GIT':'/usr/bin/git'},text=True,capture_output=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('git version',result.stdout)


if __name__=='__main__':unittest.main()
