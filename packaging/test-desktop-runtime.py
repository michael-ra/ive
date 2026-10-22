#!/usr/bin/env python3
"""Native macOS app lifecycle smoke test; stdlib only, isolated data/ports.

Run only after building the real app:
  python3 packaging/test-desktop-runtime.py --app /path/to/IVE.app --report /tmp/ive-native-smoke.json

This opens the built app, but performs no UI automation or model calls. It never
connects to 5111/5112, modifies existing IVE data, or kills unowned processes.
"""
from __future__ import annotations
import argparse
import copy
from contextlib import contextmanager
import http.server as http_server
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid


BLOCKED_PORTS = {5111, 5112}
ACTIVE_HOOK_SNAPSHOT = None


def _managed_hook(handler):
    command = str(handler.get('command', '')) if isinstance(handler, dict) else ''
    return bool(re.search(r'/hooks/(?:hook|safety_gate|safety_gate_post)\.sh(?:[\s\"\']|$)', command)) and any(
        marker in command for marker in ('/.ive/', '/.ive-team-state/', '/.claude-commander/',
                                         '/com.ive.desktop/', '/ive-desktop-smoke-'))


def _json_managed_groups(document):
    result = {}
    for event, groups in document.get('hooks', {}).items():
        if not isinstance(groups, list):
            continue
        selected = []
        for group in groups:
            handlers = [h for h in group.get('hooks', []) if _managed_hook(h)]
            if handlers:
                selected.append({**group, 'hooks': handlers})
        if selected:
            result[event] = selected
    return result


_IVE_BLOCK = re.compile(
    r'^# >>> IVE managed hooks: (commander-relay|safety-gate)\n.*?'
    r'^# <<< IVE managed hooks: \1(?:\n|$)', re.M | re.S)
_TRUST_TABLE = re.compile(r'^(\[hooks\.state\."([^"\n]+)"\][^\n]*\n)([^\[]*)', re.M)


def _toml_blocks(text):
    blocks = {}
    for match in _IVE_BLOCK.finditer(text):
        owner = match.group(1)
        check(owner not in blocks, f'Duplicate managed Codex hook block: {owner}')
        check('[hooks.state.' not in match.group(), 'Embedded Codex trust tables require manual preservation')
        blocks[owner] = match.group()
    return blocks


def _toml_owned_keys(text, path, test_root):
    """Index the generated IVE blocks only; leave foreign trust rows alone."""
    owner = None
    groups = {}
    handlers = {}
    keys = set()
    for line in text.splitlines():
        if line.startswith('# >>> IVE managed hooks: '):
            owner = line.split(': ', 1)[1]
        elif line.startswith('# <<< IVE managed hooks: '):
            owner = None
        group = re.match(r'^\s*\[\[hooks\.([A-Za-z]+)\]\]', line)
        handler = re.match(r'^\s*\[\[hooks\.([A-Za-z]+)\.hooks\]\]', line)
        if group:
            event = group.group(1)
            groups[event] = groups.get(event, -1) + 1
            handlers[event] = -1
        if handler:
            event = handler.group(1)
            handlers[event] = handlers.get(event, -1) + 1
        if owner in {'commander-relay', 'safety-gate'} and line.lstrip().startswith('command = ') and test_root in line:
            label = re.sub(r'(?<!^)(?=[A-Z])', '_', event).lower()
            keys.add(f'{path}:{label}:{groups[event]}:{handlers[event]}')
    return keys


def _trusted_hashes(text):
    values = {}
    for match in _TRUST_TABLE.finditer(text):
        value = re.search(r'^\s*trusted_hash\s*=\s*("[^"\n]+")\s*$', match.group(3), re.M)
        values[match.group(2)] = value.group(1) if value else None
    return values


class HookSnapshot:
    """Undo this test's hook edits, merging into current config, never restoring whole files."""
    def __init__(self, test_root, paths=None):
        self.test_root = str(test_root)
        self.paths = paths or [Path.home()/'.claude/settings.json', Path.home()/'.gemini/settings.json',
                               Path.home()/'.codex/config.toml']
        self.paths = [path.resolve() for path in self.paths]
        self.before = {path: path.read_bytes() if path.exists() else b'' for path in self.paths}
        self.observed = dict(self.before)
        for path, content in self.before.items():
            if path.suffix == '.toml':
                _toml_blocks(content.decode())
            elif content:
                _json_managed_groups(json.loads(content))

    def capture(self):
        self.observed = {path: path.read_bytes() if path.exists() else b'' for path in self.paths}

    def restore(self):
        conflicts = []
        for path in self.paths:
            current = path.read_bytes() if path.exists() else b''
            if self.test_root not in current.decode():
                continue
            original = self.before[path].decode()
            observed = self.observed[path].decode()
            try:
                if path.suffix == '.toml':
                    text = current.decode()
                    old_blocks = _toml_blocks(original)
                    seen_blocks = _toml_blocks(observed)
                    current_blocks = _toml_blocks(text)
                    keys = _toml_owned_keys(text, path, self.test_root)
                    observed_keys = _toml_owned_keys(observed, path, self.test_root)
                    check(not observed_keys or keys == observed_keys,
                          'Concurrent change to Codex hook indices; trust restoration refused')
                    old_hashes = _trusted_hashes(original)
                    seen_hashes = _trusted_hashes(observed)
                    for owner, block in current_blocks.items():
                        if self.test_root not in block:
                            continue
                        check(owner not in seen_blocks or self.test_root not in seen_blocks[owner] or
                              seen_blocks[owner] == block, f'Concurrent change to Codex {owner} block')
                        text = text.replace(block, old_blocks.get(owner, ''), 1)
                    def restore_hash(match):
                        key = match.group(2)
                        if key not in keys:
                            return match.group()
                        body = match.group(3)
                        value = re.search(r'^\s*trusted_hash\s*=\s*("[^"\n]+")\s*$', body, re.M)
                        current_hash = value.group(1) if value else None
                        check(key not in seen_hashes or self.test_root not in observed or
                              seen_hashes[key] == current_hash, 'Concurrent change to Codex hook trust')
                        restored = old_hashes.get(key)
                        body = re.sub(r'^\s*trusted_hash\s*=.*\n?', '', body, flags=re.M)
                        if restored:
                            body = f'trusted_hash = {restored}\n' + body
                        return match.group(1) + body
                    updated = _TRUST_TABLE.sub(restore_hash, text)
                else:
                    doc = json.loads(current)
                    old = _json_managed_groups(json.loads(original or '{}'))
                    seen = _json_managed_groups(json.loads(observed or '{}'))
                    managed = _json_managed_groups(doc)
                    for event, groups in list(doc.get('hooks', {}).items()):
                        test_groups = [g for g in managed.get(event, []) if self.test_root in json.dumps(g)]
                        if not test_groups:
                            continue
                        seen_test = [g for g in seen.get(event, []) if self.test_root in json.dumps(g)]
                        check(not seen_test or seen_test == test_groups, f'Concurrent change to {event} test hooks')
                        kept = []
                        for group in groups:
                            handlers = [h for h in group.get('hooks', []) if self.test_root not in str(h.get('command', ''))]
                            if handlers:
                                kept.append({**group, 'hooks': handlers})
                        for group in old.get(event, []):
                            if group not in kept:
                                kept.append(copy.deepcopy(group))
                        if kept:
                            doc['hooks'][event] = kept
                        else:
                            doc['hooks'].pop(event, None)
                    if not doc.get('hooks'):
                        doc.pop('hooks', None)
                    updated = json.dumps(doc, indent=2, ensure_ascii=False) + '\n'
                check(self.test_root not in updated, 'Test hook reference remains after targeted restoration')
                check((path.read_bytes() if path.exists() else b'') == current, 'Config changed while preparing hook restoration')
                path.write_text(updated)
            except Exception as error:
                conflicts.append(f'{path}: {error}')
        return conflicts


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def wait_for(predicate, timeout, description, process=None):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        if process is not None and process.poll() is not None:
            raise AssertionError(f"App exited before {description}, returncode={process.returncode}")
        time.sleep(.1)
    raise AssertionError(f"Timed out waiting for {description}")


def unused_port():
    while True:
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        if port not in BLOCKED_PORTS:
            return port


def http(port, path, method='GET', body=None, headers=None, timeout=2):
    check(port not in BLOCKED_PORTS, 'Refusing existing IVE ports')
    request = urllib.request.Request(f'http://127.0.0.1:{port}{path}', method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={**({'Content-Type':'application/json'} if body is not None else {}), **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def ready(port, timeout=2):
    try:
        status, _, body = http(port, '/ready', timeout=timeout)
        return json.loads(body) if status == 200 else None
    except (OSError, ValueError):
        return None


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def runtime(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def child_of(pid, parent):
    try:
        return int(subprocess.check_output(['/bin/ps','-p',str(pid),'-o','ppid='],text=True).strip()) == parent
    except (ValueError, subprocess.CalledProcessError):
        return False


def process_identity(pid):
    try:
        return subprocess.check_output(['/bin/ps','-p',str(pid),'-o','lstart=','-o','comm='],text=True).strip()
    except subprocess.CalledProcessError:
        return None


@contextmanager
def app_process(binary, data_dir, port, label):
    log_path = data_dir.parent / f'{label}-app.log'
    env = os.environ.copy()
    for key in list(env):
        if key.startswith(('IVE_', 'COMMANDER_')) or key in {'PYTHONPATH','PYTHONHOME','VIRTUAL_ENV'}:
            env.pop(key, None)
    # Exercise the Finder launch path, not this test process's richer shell PATH.
    env.update(IVE_DESKTOP_PORT=str(port), IVE_DESKTOP_DATA_DIR=str(data_dir),
               IVE_TELEMETRY='off', PATH='/usr/bin:/bin:/usr/sbin:/sbin')
    with log_path.open('wb') as output:
        process = subprocess.Popen([str(binary)], cwd=data_dir.parent, env=env,
            stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
            start_new_session=True)
        try:
            yield process
        except BaseException:
            # Capture process state before cleanup so an external app exit can
            # be distinguished from the test's own termination signal.
            # Observe before sending any cleanup signal. These probes are
            # diagnostic only: a failed request still fails the entire test.
            for _ in range(5):
                info = runtime(data_dir/'desktop-runtime.json') or {}
                pid = info.get('pid')
                returncode = process.poll()
                backend_alive = isinstance(pid, int) and alive(pid)
                owned = (returncode is None and info.get('app_pid') == process.pid
                         and info.get('port') == port and backend_alive
                         and child_of(pid, process.pid))
                # An occupied port may deliberately belong to an unrelated
                # service. Diagnostics must not probe it without proven ownership.
                payload = ready(port, timeout=.2) if owned else None
                output.write((json.dumps({'test_failure_process_state': {
                    'time_unix': time.time(), 'monotonic': time.monotonic(),
                    'app_pid': process.pid, 'app_returncode': returncode,
                    'backend_pid': pid, 'backend_alive': backend_alive,
                    'backend_owned': owned, 'ready_probed': owned,
                    'ready': payload is not None,
                    'ready_version': (payload or {}).get('version'),
                    'ready_owned': str((payload or {}).get('desktop_instance', '')).startswith(f'{process.pid}-'),
                }}) + '\n').encode())
                output.flush()
                time.sleep(.4)
            raise
        finally:
            info = runtime(data_dir/'desktop-runtime.json') or {}
            pid = info.get('pid')
            owned = (info.get('app_pid') == process.pid and isinstance(pid,int)
                     and alive(pid) and child_of(pid,process.pid))
            identity = process_identity(pid) if owned else None
            if process.poll() is None:
                output.write((json.dumps({'test_cleanup_signal': 'SIGTERM', 'app_pid': process.pid,
                                         'time_unix': time.time(), 'monotonic': time.monotonic()}) + '\n').encode())
                output.flush()
                process.send_signal(signal.SIGTERM)
                try:
                    process.wait(timeout=18)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=5)
            # Only an exact direct child recorded by THIS launch is eligible
            # for emergency cleanup. Never use a port-wide pkill/lsof kill.
            if owned and identity and alive(pid) and process_identity(pid) == identity:
                os.kill(pid, signal.SIGTERM)
                deadline=time.monotonic()+5
                while alive(pid) and time.monotonic()<deadline: time.sleep(.1)
                if alive(pid) and process_identity(pid)==identity:
                    os.kill(pid,signal.SIGKILL)


def bundle_expectations(binary):
    contents = binary.parent.parent
    with (contents/'Info.plist').open('rb') as source:
        metadata = plistlib.load(source)
    version = metadata.get('CFBundleShortVersionString')
    check(bool(version) and metadata.get('CFBundleVersion') == version,
          'App Info.plist versions disagree')
    manifest = json.loads((contents/'Resources/backend/_internal/bundle-info.json').read_text())
    check(manifest.get('version') == version, 'App and bundled backend manifest versions disagree')
    helper = manifest.get('cloudflared')
    if helper:
        binary = contents/'Resources/backend/_internal/tools/cloudflared'
        check(binary.is_file() and os.access(binary, os.X_OK), 'Bundled phone connection helper is missing')
        result = subprocess.run([str(binary), '--version'], capture_output=True, text=True, timeout=15)
        check(result.returncode == 0 and helper['version'] in result.stdout,
              'Bundled phone connection helper cannot execute or has the wrong version')
    power_helper = manifest.get('phone_power')
    if power_helper:
        binary = contents/'MacOS/ive-phone-power'
        plist = contents/'Library/LaunchDaemons/com.ive.desktop.phone-power.plist'
        check(binary.is_file() and os.access(binary, os.X_OK) and plist.is_file(),
              'Bundled Mac availability helper or registration plist is missing')
        data = plistlib.loads(plist.read_bytes())
        check(data.get('BundleProgram') == 'Contents/MacOS/ive-phone-power', 'Availability helper launch path mismatch')
    return {'version': version, 'source_sha256': manifest.get('source_sha256'), 'cloudflared': helper, 'phone_power': power_helper}


def verify_phone_api(port, *, expect_bundled_helper=False, expect_power_helper=False):
    responses = {}
    for endpoint in ('/api/phone/status', '/api/phone/devices'):
        status, headers, body = http(port, endpoint)
        check(status == 200, f'Phone endpoint {endpoint} failed ({status})')
        check(headers.get('Content-Type', '').split(';')[0].strip() == 'application/json',
              f'Phone endpoint {endpoint} returned a non-JSON fallback')
        payload = json.loads(body)
        check(isinstance(payload, dict), f'Phone endpoint {endpoint} did not return an object')
        responses[endpoint] = payload
    state = responses['/api/phone/status']
    check(state.get('is_local_owner') is True, 'Fixture phone status did not recognize the local owner')
    if expect_bundled_helper:
        check(state.get('tunnel', {}).get('cloudflared_installed') is True,
              'Frozen backend cannot discover its bundled phone connection helper')
        check(state.get('urls') == [] and state.get('bind', {}).get('lan') is False,
              'Fresh desktop advertises an unreachable or unintended network address')
    check(all(isinstance(state.get(key), bool) for key in ('pin_enabled', 'locked', 'apns_configured')),
          'Phone status is missing its PIN, lock, or APNs fields')
    if expect_power_helper:
        check(state.get('desktop') is True and state.get('setup', {}).get('required') is True,
              'Fresh Mac fixture did not require explicit phone setup')
        check(state.get('availability', {}).get('state') in ('not_registered', 'needs_approval', 'ready'),
              f'Bundled availability helper cannot report its real macOS approval state: {state.get("availability")}')
        check('lease_id' not in json.dumps(state), 'Phone API leaked a privileged lease credential')
    devices = responses['/api/phone/devices']
    power = None
    if state.get('availability', {}).get('lid_saver_supported') is True:
        status, headers, body = http(port, '/api/mac-power')
        check(status == 200 and headers.get('Content-Type', '').startswith('application/json'),
              'Mac power endpoint did not return JSON')
        power = json.loads(body)
        check(power.get('protocol_version') == 2 and power.get('lid_saver_supported') is True,
              'Native helper does not support the new lid actions')
        check(power.get('state') in ('not_registered', 'needs_approval', 'ready') and 'lease_id' not in power,
              'Read-only Mac power status activated or leaked a lease')
    check(devices.get('devices') == [] and devices.get('current_device_id') is None,
          'Fresh phone fixture unexpectedly contains paired devices')
    return {'status_json': True, 'devices_json': True, 'paired_devices': 0,
            'bundled_helper_available': bool(expect_bundled_helper),
            'availability': state.get('availability') if expect_power_helper else None,
            'mac_power': power}


def launch_ready(process, data_dir, port, expected):
    info = wait_for(lambda: (r if (r:=runtime(data_dir/'desktop-runtime.json')) and r.get('app_pid')==process.pid else None),
                    85, 'runtime identity', process)
    payload = wait_for(lambda: ready(port), 85, 'backend readiness', process)
    if ACTIVE_HOOK_SNAPSHOT is not None:
        ACTIVE_HOOK_SNAPSHOT.capture()
    check(info['port']==port, 'Desktop runtime used a different port')
    check(child_of(info['pid'],process.pid), 'Backend is not owned by the current app process')
    check(str(payload.get('desktop_instance','')).startswith(f'{process.pid}-'), 'Readiness identity is from another app launch')
    bundle = payload.get('bundle') or {}
    check(bundle.get('frozen') is True, 'Ready endpoint is not a frozen backend')
    check(bool(re.fullmatch(r'[0-9a-f]{64}',bundle.get('source_sha256',''))), 'Missing bundled source fingerprint')
    check(info.get('version') == payload.get('version') == bundle.get('version') == expected['version'],
          'Native runtime, backend, bundle manifest, and installed app versions disagree')
    check(bundle.get('source_sha256') == expected['source_sha256'],
          'Running backend fingerprint differs from the selected app bundle')
    receipt = wait_for(lambda: (r if (r:=runtime(data_dir/'desktop-window.json'))
        and r.get('app_pid')==process.pid and r.get('loaded') is True
        and r.get('url')==f'http://127.0.0.1:{port}/' else None),
        30, 'WKWebView bundled frontend page load', process)
    check(receipt.get('version') == expected['version'], 'WKWebView receipt came from another app version')
    info['window_receipt'] = receipt
    info['phone_api'] = verify_phone_api(port, expect_bundled_helper=bool(expected.get('cloudflared')), expect_power_helper=bool(expected.get('phone_power')))
    status, headers, body = http(port,'/')
    check(status==200 and 'text/html' in headers.get('Content-Type','') and b'<html' in body.lower(), 'Bundled frontend is unavailable')
    status, _, body = http(port,'/api/cli-info')
    check(status==200 and isinstance(json.loads(body).get('available_clis'),dict), 'Provider discovery failed')
    return info,payload,json.loads(body)['available_clis']


def stop_and_verify(process, info, port):
    process.send_signal(signal.SIGTERM)
    process.wait(timeout=18)
    wait_for(lambda: not alive(info['pid']), 5, 'owned backend process termination')
    check(ready(port) is None, 'Backend still serves requests after app SIGTERM')


def seed_saved_session(root, data_dir, workspace_id):
    """Seed only our stopped fixture; never use session creation (which starts a CLI)."""
    database = data_dir/'data.db'
    check(data_dir.resolve().parent == root.resolve(), 'Fixture data escaped the temporary test directory')
    check(database.is_file() and not database.is_symlink(), 'Missing fixture database or unexpected database symlink')
    info = runtime(data_dir/'desktop-runtime.json') or {}
    check(isinstance(info.get('pid'), int) and not alive(info['pid']), 'Refusing to seed a running backend')
    session_id = str(uuid.uuid4())
    commander_id = str(uuid.uuid4())
    cascade_session_id = str(uuid.uuid4())
    messages = []
    with sqlite3.connect(database) as connection:
        connection.execute('PRAGMA foreign_keys=ON')
        identity = connection.execute('SELECT identity FROM ive_fresh_database').fetchall()
        check(identity == [('ive-team-fresh',)], 'Unexpected fixture database identity')
        connection.execute(
            'INSERT INTO sessions (id, workspace_id, name, status, cli_type, is_imported, archived) '
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
            (session_id, workspace_id, 'Archive persistence fixture', 'exited', 'claude', 1, 0),
        )
        for index, (role, content) in enumerate((
            ('user', 'Keep this saved conversation when its session is archived.'),
            ('assistant', 'This saved reply must survive archiving and an app restart.'),
        )):
            cursor = connection.execute(
                'INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)',
                (session_id, role, content, f'2026-01-01 00:00:0{index}'),
            )
            messages.append({'id': cursor.lastrowid, 'role': role, 'content': content})
        # Workspace creation may already have provisioned a dormant Commander.
        # Reuse that fixture row so the test never creates a duplicate Commander.
        commanders = connection.execute(
            "SELECT id FROM sessions WHERE workspace_id = ? AND session_type = 'commander'",
            (workspace_id,),
        ).fetchall()
        check(len(commanders) <= 1, 'Fixture workspace already contains duplicate Commanders')
        if commanders:
            commander_id = commanders[0][0]
            connection.execute(
                "UPDATE sessions SET status = 'exited', is_imported = 1, native_session_id = NULL WHERE id = ?",
                (commander_id,),
            )
        else:
            connection.execute(
                'INSERT INTO sessions (id, workspace_id, name, status, cli_type, is_imported, session_type) '
                'VALUES (?, ?, ?, ?, ?, ?, ?)',
                (commander_id, workspace_id, 'Deletion fixture Commander', 'exited', 'claude', 1, 'commander'),
            )
        connection.execute(
            'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
            (commander_id, 'assistant', 'This synthetic Commander history must be removed by explicit deletion.'),
        )
        # Keep a separate saved child until workspace deletion. Otherwise the
        # earlier individual deletes would leave no child/history to cascade.
        connection.execute(
            'INSERT INTO sessions (id, workspace_id, name, status, cli_type, is_imported) '
            'VALUES (?, ?, ?, ?, ?, ?)',
            (cascade_session_id, workspace_id, 'Workspace deletion fixture child', 'exited', 'claude', 1),
        )
        connection.execute(
            'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
            (cascade_session_id, 'assistant', 'Remove this saved history with its workspace, but keep the project files.'),
        )
    return session_id, messages, commander_id, cascade_session_id


def verify_saved_session(port, workspace_id, session_id, messages, archived):
    status, _, body = http(port, f'/api/sessions?workspace_id={workspace_id}')
    check(status == 200, f'Session listing failed ({status})')
    rows = json.loads(body)
    check(isinstance(rows, list), 'Session listing did not return a list')
    matches = [row for row in rows if row.get('id') == session_id]
    check(len(matches) == 1, 'Saved session disappeared or was duplicated')
    session = matches[0]
    check(session.get('workspace_id') == workspace_id, 'Saved session changed workspace')
    check(session.get('archived') == archived, 'Saved session archive state did not persist')
    check(session.get('pty_alive') is False, 'Saved session unexpectedly started a provider process')
    status, _, body = http(port, f'/api/sessions/{session_id}/messages')
    check(status == 200, f'Saved history is unavailable ({status})')
    history = json.loads(body)
    check(isinstance(history, list), 'Saved history did not return a list')
    actual = [{key: message.get(key) for key in ('id', 'role', 'content')} for message in history]
    check(actual == messages, 'Archiving/restarting deleted, duplicated, or changed saved messages')


def verify_deleted_sessions(port, workspace_id, session_ids):
    status, _, body = http(port, f'/api/sessions?workspace_id={workspace_id}')
    check(status == 200, f'Deleted-session listing failed ({status})')
    rows = json.loads(body)
    check(isinstance(rows, list), 'Deleted-session listing did not return a list')
    check(not any(row.get('id') in session_ids for row in rows), 'Deleted session reappeared in the session list')
    check(not any(row.get('session_type') == 'commander' for row in rows),
          'Explicitly deleted Commander was automatically recreated')
    for session_id in session_ids:
        for suffix in ('', '/messages'):
            status, headers, body = http(port, f'/api/sessions/{session_id}{suffix}')
            check(status == 404 and 'application/json' in headers.get('Content-Type', ''),
                  'Deleted session or its history remained readable')
            check(json.loads(body).get('error') == 'session not found', 'Unexpected missing-session response')


def verify_deleted_workspace(port, workspace_id, session_ids, retained_workspace_id, project_files):
    status, _, body = http(port, '/api/workspaces')
    check(status == 200, f'Workspace listing after deletion failed ({status})')
    rows = json.loads(body)
    check(isinstance(rows, list), 'Workspace listing after deletion did not return a list')
    check(not any(row.get('id') == workspace_id for row in rows), 'Deleted workspace reappeared')
    check(any(row.get('id') == retained_workspace_id for row in rows), 'Deleting a workspace removed an unrelated workspace')
    status, _, body = http(port, '/api/sessions')
    check(status == 200, f'Session listing after workspace deletion failed ({status})')
    sessions = json.loads(body)
    check(isinstance(sessions, list), 'Session listing after workspace deletion did not return a list')
    check(not any(row.get('workspace_id') == workspace_id for row in sessions),
          'Workspace deletion left or recreated child sessions')
    verify_deleted_sessions(port, workspace_id, session_ids)
    for path, content in project_files.items():
        check(path.is_file() and path.read_text() == content, 'Workspace deletion removed or changed a project file')


def test_lifecycle(binary, root, results):
    data = root/'lifecycle-state'; port=unused_port(); project=root/'fixture-project'; project.mkdir()
    retained_project = root/'retained-project'; retained_project.mkdir()
    project_files = {
        project/'keep-project-file.txt': 'Disconnecting this IVE workspace must preserve its project files.\n',
        retained_project/'keep-unrelated-file.txt': 'This unrelated project must remain registered and unchanged.\n',
    }
    for path, content in project_files.items():
        path.write_text(content)
    expected = bundle_expectations(binary)
    with app_process(binary,data,port,'first') as process:
        first,payload,providers=launch_ready(process,data,port,expected)
        status,_,body=http(port,'/api/workspaces','POST',{'name':'Desktop persistence fixture','path':str(project)})
        check(status in (200,201),f'Fixture workspace creation failed ({status})')
        workspace=json.loads(body); workspace_id=workspace['id']
        status,_,body=http(port,'/api/workspaces','POST',{'name':'Retained desktop fixture','path':str(retained_project)})
        check(status in (200,201),f'Retained fixture workspace creation failed ({status})')
        retained_workspace_id=json.loads(body)['id']
        status,headers,_=http(port,'/api/workspaces',headers={'Origin':'https://example.invalid'})
        check(status==403 and 'Access-Control-Allow-Origin' not in headers,'Foreign browser origin was admitted')
        stop_and_verify(process,first,port)
        results.append({'test':'first_launch_fingerprint_finder_path_origin_shutdown','passed':True,
                        'app_pid':process.pid,'backend_pid':first['pid'],'port':port,
                        'bundle':payload['bundle'],'available_clis':providers,
                        'matched_app_version':expected['version'],'phone_api':first['phone_api'],
                        'window_receipt':first['window_receipt']})
    session_id, messages, commander_id, cascade_session_id = seed_saved_session(root, data, workspace_id)
    with app_process(binary,data,port,'restart') as process:
        second,payload,_=launch_ready(process,data,port,expected)
        check(second['pid']!=first['pid'],'Relaunch reused the previous backend process')
        status,_,body=http(port,'/api/workspaces')
        rows=json.loads(body)
        check(status==200 and any(item.get('id')==workspace_id for item in rows),'Workspace did not persist across app restart')
        verify_saved_session(port, workspace_id, session_id, messages, archived=0)
        status, _, body = http(port, f'/api/sessions/{session_id}', 'PUT', {'archived': 1})
        check(status == 200, f'Session archive request failed ({status})')
        archived = json.loads(body)
        check(archived.get('id') == session_id and archived.get('archived') == 1,
              'Archive response did not confirm the saved session')
        verify_saved_session(port, workspace_id, session_id, messages, archived=1)
        stop_and_verify(process,second,port)
        results.append({'test':'restart_persists_workspace_and_stops_owned_backend','passed':True,
                        'app_pid':process.pid,'backend_pid':second['pid'],'port':port,
                        'window_receipt':second['window_receipt']})
        results.append({'test':'archive_preserves_saved_session_and_messages','passed':True,
                        'session_id':session_id,'message_ids':[message['id'] for message in messages],
                        'archived':1,'pty_alive':False})
    with app_process(binary,data,port,'archive-restart') as process:
        third,_,_=launch_ready(process,data,port,expected)
        check(third['pid'] not in (first['pid'],second['pid']), 'Archive relaunch reused a previous backend process')
        verify_saved_session(port, workspace_id, session_id, messages, archived=1)
        results.append({'test':'restart_preserves_archived_session_and_saved_messages','passed':True,
                        'app_pid':process.pid,'backend_pid':third['pid'],'port':port,
                        'session_id':session_id,'message_ids':[message['id'] for message in messages],
                        'archived':1,'pty_alive':False,'window_receipt':third['window_receipt']})
        status, _, body = http(port, f'/api/sessions/{commander_id}')
        check(status == 200 and json.loads(body).get('pty_alive') is False,
              'Fixture Commander is missing or unexpectedly started a provider process')
        for deleted_id in (session_id, commander_id):
            status, _, body = http(port, f'/api/sessions/{deleted_id}', 'DELETE')
            check(status == 200 and json.loads(body).get('ok') is True, 'Explicit fixture session deletion failed')
        verify_deleted_sessions(port, workspace_id, (session_id, commander_id))
        stop_and_verify(process,third,port)
        results.append({'test':'explicit_delete_removes_session_commander_and_histories','passed':True,
                        'session_id':session_id,'commander_id':commander_id})
    with app_process(binary,data,port,'delete-restart') as process:
        fourth,_,_=launch_ready(process,data,port,expected)
        # Startup provisions dormant Commanders asynchronously. Check repeatedly
        # after readiness so the test catches resurrection during startup too.
        for _ in range(5):
            verify_deleted_sessions(port, workspace_id, (session_id, commander_id))
            time.sleep(.4)
        results.append({'test':'restart_keeps_deleted_sessions_absent_without_new_commander','passed':True,
                        'app_pid':process.pid,'backend_pid':fourth['pid'],'port':port,
                        'session_id':session_id,'commander_id':commander_id,
                        'matched_app_version':expected['version'],'phone_api':fourth['phone_api'],
                        'window_receipt':fourth['window_receipt']})
        status, _, body = http(port, f'/api/sessions/{cascade_session_id}')
        check(status == 200 and json.loads(body).get('pty_alive') is False,
              'Workspace deletion child is missing or unexpectedly started a provider process')
        status, _, body = http(port, f'/api/sessions/{cascade_session_id}/messages')
        check(status == 200 and len(json.loads(body)) == 1, 'Workspace deletion child has no saved history to remove')
        status, _, body = http(port, f'/api/workspaces/{workspace_id}', 'DELETE')
        check(status == 200 and json.loads(body).get('ok') is True, 'Explicit fixture workspace deletion failed')
        deleted_ids = (session_id, commander_id, cascade_session_id)
        verify_deleted_workspace(port, workspace_id, deleted_ids, retained_workspace_id, project_files)
        stop_and_verify(process,fourth,port)
        results.append({'test':'workspace_delete_removes_children_and_preserves_project_files','passed':True,
                        'workspace_id':workspace_id,'deleted_session_ids':list(deleted_ids),
                        'retained_workspace_id':retained_workspace_id,'preserved_project_files':len(project_files)})
    with app_process(binary,data,port,'workspace-delete-restart') as process:
        fifth,_,_=launch_ready(process,data,port,expected)
        for _ in range(5):
            verify_deleted_workspace(port, workspace_id, deleted_ids, retained_workspace_id, project_files)
            time.sleep(.4)
        stop_and_verify(process,fifth,port)
        results.append({'test':'restart_keeps_deleted_workspace_absent_and_unrelated_project_intact','passed':True,
                        'app_pid':process.pid,'backend_pid':fifth['pid'],'port':port,
                        'workspace_id':workspace_id,'deleted_session_ids':list(deleted_ids),
                        'retained_workspace_id':retained_workspace_id,'preserved_project_files':len(project_files),
                        'matched_app_version':expected['version'],'phone_api':fifth['phone_api'],
                        'window_receipt':fifth['window_receipt']})


def test_collision(binary, root, results):
    requests=[]
    class ForeignService(http_server.BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            data=b'{"foreign_service":true,"desktop_instance":"not-the-app"}'
            self.send_response(200);self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        def log_message(self,*_): pass
    server=http_server.ThreadingHTTPServer(('127.0.0.1',0),ForeignService)
    port=server.server_address[1]
    check(port not in BLOCKED_PORTS,'Unexpected protected port allocation')
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
    try:
        data=root/'collision-state'
        with app_process(binary,data,port,'collision') as process:
            wait_for(lambda: data.exists(),10,'collision preflight',process)
            receipt=wait_for(lambda: (r if (r:=runtime(data/'desktop-window.json'))
                and r.get('app_pid')==process.pid and r.get('loaded') is True
                and r.get('url')=='tauri://localhost/desktop-startup.html' else None),
                20, 'WKWebView port collision startup page', process)
            # Allow the native error page to settle. There must be no backend
            # launch metadata and no handshake with the pre-existing service.
            time.sleep(2)
            returncode = process.poll()
            check(returncode is None,
                  f'App exited while displaying the port conflict, returncode={returncode}; expected the window to remain open')
            check(not (data/'desktop-runtime.json').exists(),'App spawned a backend on an occupied port')
            check(requests==[],'App contacted or adopted the unrelated service')
            process.send_signal(signal.SIGTERM);process.wait(timeout=18)
            status,_,body=http(port,'/ready')
            check(status==200 and json.loads(body).get('foreign_service') is True,'App shutdown affected the unrelated service')
            results.append({'test':'port_collision_never_contacts_or_kills_foreign_service','passed':True,'port':port,
                            'window_receipt':receipt})
    finally:
        server.shutdown();server.server_close();worker.join(timeout=3)


def main():
    global ACTIVE_HOOK_SNAPSHOT
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app',type=Path,required=True,help='.app bundle or Contents/MacOS/ive binary')
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args()
    binary=args.app.resolve()
    if binary.suffix=='.app': binary=binary/'Contents/MacOS/ive'
    check(binary.is_file() and os.access(binary,os.X_OK),f'App binary not found: {binary}')
    report={'app':str(binary),'checks':[],'passed':False}
    with tempfile.TemporaryDirectory(prefix='ive-desktop-smoke-') as directory:
        root=Path(directory)
        try:
            hooks = HookSnapshot(root)
            ACTIVE_HOOK_SNAPSHOT = hooks
            try:
                test_lifecycle(binary,root,report['checks'])
                test_collision(binary,root,report['checks'])
            finally:
                ACTIVE_HOOK_SNAPSHOT = None
                conflicts = hooks.restore()
                report['hook_restore'] = {'passed': not conflicts, 'conflicts': conflicts}
                check(not conflicts, 'Managed hook restoration conflicted; current configs were preserved: ' + '; '.join(conflicts))
            report['passed']=True
        except Exception as error:
            report['error']=f'{type(error).__name__}: {error}'
            # Preserve fixture logs only, never include user credentials/data.
            args.report.parent.mkdir(parents=True,exist_ok=True)
            logs=args.report.with_suffix('.logs');logs.mkdir(exist_ok=True)
            for source in root.rglob('*.log'):
                (logs/str(source.relative_to(root)).replace('/','-')).write_bytes(source.read_bytes())
            raise
        finally:
            args.report.parent.mkdir(parents=True,exist_ok=True)
            args.report.write_text(json.dumps(report,indent=2)+'\n')
            print(json.dumps({'passed':report['passed'],'checks':len(report['checks']),'report':str(args.report)}))


if __name__=='__main__':main()
