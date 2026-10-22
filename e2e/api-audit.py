#!/usr/bin/env python3
"""Offline HTTP feature audit against an already-running e2e/serve.mjs sandbox.

Never accepts production ports, remote hosts, or a workspace outside the verified
temporary sandbox. Writes only uniquely named test objects and cleans them up.
Response content/credentials are not included in the JSON evidence report.
Usage: python e2e/api-audit.py --port 5191 --sandbox /tmp/ive-e2e-... --workspace UUID
"""
import argparse
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
import uuid


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Audit:
    def __init__(self, args):
        if args.port in (0, 5111, 5173, 5183) or not 1024 <= args.port <= 65535:
            raise ValueError("Refusing production/invalid port")
        self.root = Path(args.sandbox).resolve(strict=True)
        temporary = Path(tempfile.gettempdir()).resolve()
        if not self.root.name.startswith('ive-e2e-') or not self.root.is_relative_to(temporary):
            raise ValueError("Root must be an ive-e2e-* directory below the OS temp directory")
        for cli in ('claude', 'codex'):
            executable = self.root / 'bin' / cli
            if executable.is_symlink() or not executable.is_file():
                raise ValueError("Missing isolated fake CLI")
            if 'fake' not in executable.read_text().lower() and 'stand-in' not in executable.read_text().lower():
                raise ValueError("CLI executable is not the sandbox stand-in")
        self.base = f'http://127.0.0.1:{args.port}'
        self.workspace = args.workspace
        self.opener = build_opener(ProxyHandler({}), NoRedirect())
        self.records = []
        self.cleanup = []
        self.prefix = 'API audit ' + uuid.uuid4().hex[:8]
        self.session = None
        self.output = Path(args.output)
        self.started = time.time()
        self.verified = False

    def raw(self, method, path, body=None, *, data=None, content_type=None):
        if not path.startswith('/api/') or '://' in path or path.startswith('//'):
            raise ValueError('Only local API paths are allowed')
        if method != 'GET' and not self.verified:
            raise ValueError('Sandbox must be verified before mutations')
        if body is not None:
            data = json.dumps(body).encode()
            content_type = 'application/json'
        headers = {'Content-Type': content_type} if content_type else {}
        request = Request(self.base + path, data=data, headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=20)
        except HTTPError as error:
            response = error
        with response:
            status = response.status
            raw = response.read()
            mime = response.headers.get('Content-Type', '')
        try:
            payload = json.loads(raw) if 'json' in mime else raw.decode(errors='replace')
        except ValueError:
            payload = None
        return status, payload

    def check(self, feature, method, path, body=None, *, expect=(200,), verify=None, **options):
        start = time.monotonic()
        record = {'feature': feature, 'method': method, 'path': path.split('?')[0], 'expected_status': list(expect)}
        try:
            status, payload = self.raw(method, path, body, **options)
            record.update(status=status, passed=status in expect,
                          response_shape='object' if isinstance(payload, dict) else 'list' if isinstance(payload, list) else 'text')
            if status in expect and verify is not None:
                record['passed'] = bool(verify(payload))
                if not record['passed']:
                    record['issue'] = 'Response did not preserve expected test values'
            if status not in expect:
                record['issue'] = 'Unexpected HTTP status'
                if isinstance(payload, dict):
                    # Only bounded error diagnostics, never complete response state.
                    record['error_code'] = payload.get('code')
                    record['error'] = str(payload.get('error', ''))[:240]
        except Exception as error:
            payload = None
            record.update(passed=False, issue=type(error).__name__)
        record['duration_ms'] = round((time.monotonic() - start) * 1000)
        self.records.append(record)
        if not record['passed']:
            print(json.dumps(record), flush=True)
        # Retain created IDs for cleanup even if a semantic assertion fails.
        return payload if record.get('status') in expect else None

    def preflight(self):
        status, rows = self.raw('GET', '/api/workspaces')
        if status != 200 or not isinstance(rows, list):
            raise ValueError('Cannot verify sandbox workspace API')
        target = next((row for row in rows if row['id'] == self.workspace), None)
        if not target:
            raise ValueError('Workspace ID not present')
        self.repo = Path(target['path']).resolve(strict=True)
        self.workspace_flags = target
        if not self.repo.is_relative_to(self.root / 'home'):
            raise ValueError('Workspace is outside fake HOME')
        for row in rows:
            if not Path(row['path']).resolve().is_relative_to(self.root):
                raise ValueError('Server also exposes an outside workspace; refusing')
        db_path = self.root / 'state' / 'data.db'
        if db_path.is_symlink():
            raise ValueError('Sandbox DB must not be a symlink')
        with sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True) as connection:
            row = connection.execute('SELECT path FROM workspaces WHERE id=?', (self.workspace,)).fetchone()
        if not row or Path(row[0]).resolve() != self.repo:
            raise ValueError('HTTP server and isolated database do not match')
        self.verified = True

    def entity(self, feature, endpoint, body, update=None):
        created = self.check(feature + ': create', 'POST', endpoint, body, expect=(201,))
        if not created or not created.get('id'):
            return None
        identity = created['id']
        self.cleanup.append((feature + ': remove', 'DELETE', endpoint + '/' + identity, None))
        if update is not None:
            self.check(feature + ': update', 'PUT', endpoint + '/' + identity, update,
                       verify=lambda result: all(result.get(k) == v for k, v in update.items()))
        return identity

    def run(self):
        self.preflight()
        ws = self.workspace
        q = urlencode({'workspace': ws})
        reads = {
            'Overview': '/api/overview', 'Sessions': '/api/sessions', 'Prompts': '/api/prompts',
            'Guidelines': '/api/guidelines', 'MCP configurations': '/api/mcp-servers',
            'Session templates': '/api/templates', 'Grid layouts': '/api/grid-templates?' + q,
            'Tab groups': '/api/tab-groups?' + q, 'Task board': '/api/tasks?' + q,
            'Local history': '/api/history/projects', 'Message search': '/api/search?q=audit',
            'CLI profiles': '/api/cli-info', 'CLI feature matrix': '/api/cli-info/features',
            'Custom CLI profiles': '/api/cli-profiles', 'Output styles': '/api/output-styles',
            'Model providers': '/api/model-providers', 'Settings': '/api/settings',
            'Experimental flags': '/api/settings/experimental', 'Safety status': '/api/safety/status',
            'Safety rules': '/api/safety/rules', 'Safety decisions': '/api/safety/decisions',
            'Safety proposals': '/api/safety/proposals', 'Command log': '/api/safety/command-log',
            'Access log': '/api/safety/access-log', 'Package scans': '/api/safety/package-scans',
            'Script approvals': '/api/safety/script-approvals',
            'Install script policy': '/api/safety/install-script-policy',
            'Event catalog': '/api/events/catalog', 'Event log': '/api/events',
            'Event subscriptions': '/api/events/subscriptions', 'Cascades': '/api/cascades',
            'Cascade runs': '/api/cascade-runs', 'Broadcast groups': '/api/broadcast-groups',
            'Plugins': '/api/plugins', 'Plugin registries': '/api/plugins/registries',
            'Installed skills': '/api/skills/installed?' + urlencode({'workspace_id': ws}),
            'Cost metrics': '/api/cost?' + q, 'Fleet ports': '/api/fleet/ports',
            'Test attention': '/api/test-queue/attention', 'RTK integration': '/api/integrations/rtk',
        }
        workspace_reads = ('runtime-env', 'ports', 'claims', 'alloy/servers', 'alloy/runs', 'git/status',
                           'git/diff', 'git/log', 'agents-md', 'overview', 'files', 'memory',
                           'memory/settings', 'memory/auto', 'test-queue', 'docs', 'demo',
                           'peer-messages', 'workflow_runs', 'file-activity')
        reads.update({f'Workspace {name}': f'/api/workspaces/{ws}/{name}' for name in workspace_reads})
        for feature, path in reads.items():
            disabled_alloy = '/alloy/' in path and not self.workspace_flags.get('alloy_enabled')
            self.check(feature + ': read', 'GET', path, expect=(403,) if disabled_alloy else (200,),
                       verify=(lambda row: row.get('error') == 'alloy disabled for workspace') if disabled_alloy else None)
        self.check('MCP workspace context search', 'GET',
                   f'/api/workspaces/{ws}/memory-search?' + urlencode({'q': 'offline audit', 'limit': 5}),
                   verify=lambda row: isinstance(row, dict) and isinstance(row.get('results'), dict)
                   and set(row['results']) == {'tasks', 'knowledge', 'messages', 'files', 'memory'})

        prompt = self.entity('Prompt library', '/api/prompts', {'name': self.prefix, 'content': 'Explain {{topic}}',
                             'is_quickaction': 1}, {'content': 'Explain clearly {{topic}}'})
        if prompt:
            self.check('Prompt usage count', 'POST', f'/api/prompts/{prompt}/use', {}, verify=lambda row: row['usage_count'] == 1)
        template = self.entity('Session template', '/api/templates', {'name': self.prefix, 'model': 'sonnet',
                               'permission_mode': 'default', 'system_prompt': 'API-AUDIT-CONTEXT-314'})
        if template:
            session = self.check('Apply template', 'POST', f'/api/templates/{template}/apply',
                                 {'workspace_id': ws, 'name': self.prefix, 'cli_type': 'claude'}, expect=(201,),
                                 verify=lambda row: row.get('system_prompt') == 'API-AUDIT-CONTEXT-314')
            if session:
                self.session = session['id']
                self.cleanup.append(('Session remove', 'DELETE', f'/api/sessions/{self.session}', None))
        session = self.session
        codex_template = self.check('Codex preset preserves CLI', 'POST', '/api/templates',
                                    {'name': self.prefix + ' Codex', 'cli_type': 'codex', 'model': 'gpt-5.5'},
                                    expect=(201,), verify=lambda row: row.get('cli_type') == 'codex')
        if codex_template and codex_template.get('id'):
            tid = codex_template['id']
            self.cleanup.append(('Codex preset cleanup', 'DELETE', f'/api/templates/{tid}', None))
            applied = self.check('Codex preset applies native CLI', 'POST', f'/api/templates/{tid}/apply',
                                 {'workspace_id': ws, 'name': self.prefix + ' Codex'}, expect=(201,),
                                 verify=lambda row: row.get('cli_type') == 'codex')
            if applied and applied.get('id'):
                self.cleanup.append(('Codex preset session cleanup', 'DELETE', f"/api/sessions/{applied['id']}", None))
        self.entity('Grid layout', '/api/grid-templates', {'workspace_id': ws, 'name': self.prefix, 'cols': 2,
                    'cells': [{'id': 'cell-a'}], 'cell_assignments': {}}, {'name': self.prefix + ' edited', 'cols': 3})
        self.entity('Tab group', '/api/tab-groups', {'workspace_id': ws, 'name': self.prefix,
                    'session_ids': [session] if session else []}, {'name': self.prefix + ' edited'})
        cascade = self.entity('Cascade definition', '/api/cascades', {'name': self.prefix,
                              'steps': [{'prompt': 'Review the result', 'delay': 0}], 'loop': False},
                              {'name': self.prefix + ' edited'})
        if cascade:
            self.check('Cascade usage', 'POST', f'/api/cascades/{cascade}/use', {})
        if session:
            self.entity('Broadcast group', '/api/broadcast-groups', {'workspace_id': ws, 'name': self.prefix,
                        'session_ids': [session]}, {'name': self.prefix + ' edited'})
            self.check('Scratchpad save', 'PUT', f'/api/sessions/{session}/scratchpad', {'scratchpad': 'AUDIT-NOTE-314'},
                       verify=lambda row: row['scratchpad'] == 'AUDIT-NOTE-314')
            self.check('Scratchpad reload', 'GET', f'/api/sessions/{session}/scratchpad',
                       verify=lambda row: row['scratchpad'] == 'AUDIT-NOTE-314')
            for name in ('capabilities', 'runtime-model', 'queue', 'messages', 'tree', 'subagents', 'captures',
                         'attachments', 'guidelines', 'mcp-servers', 'plugin-components', 'digest', 'health'):
                self.check('Session ' + name, 'GET', f'/api/sessions/{session}/{name}')

        task = self.entity('Task', '/api/tasks', {'workspace_id': ws, 'title': self.prefix,
                           'description': 'Synthetic offline audit', 'status': 'backlog', 'pipeline': False},
                           {'description': 'Updated synthetic audit'})
        if task:
            for name in ('', '/ready', '/events', '/attachments'):
                self.check('Task read ' + (name or 'detail'), 'GET', f'/api/tasks/{task}{name}')
            boundary = 'ive-audit-' + uuid.uuid4().hex
            data = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audit-note.txt"\r\n'
                    'Content-Type: text/plain\r\n\r\nAUDIT-ATTACHMENT-314\r\n' + f'--{boundary}--\r\n').encode()
            uploaded = self.check('Task attachment upload', 'POST', f'/api/tasks/{task}/attachments',
                                  data=data, content_type=f'multipart/form-data; boundary={boundary}', expect=(201,),
                                  verify=lambda row: row['files'][0]['size'] == len('AUDIT-ATTACHMENT-314'))
            if uploaded:
                self.check('Task attachment download', 'GET', uploaded['files'][0]['url'],
                           verify=lambda text: text == 'AUDIT-ATTACHMENT-314')
            # User filenames can consist solely of characters removed by the
            # sanitizer. This must produce a fallback name, never a server error.
            boundary = 'ive-audit-' + uuid.uuid4().hex
            data = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="!!!"\r\n'
                    'Content-Type: text/plain\r\n\r\nAUDIT-UNUSUAL-FILENAME\r\n' + f'--{boundary}--\r\n').encode()
            self.check('Attachment unusual filename', 'POST', f'/api/tasks/{task}/attachments',
                       data=data, content_type=f'multipart/form-data; boundary={boundary}', expect=(201,),
                       verify=lambda row: bool(row['files'][0]['filename']))

        self.entity('Guideline', '/api/guidelines', {'name': self.prefix, 'content': 'Explain unfamiliar terms.'},
                    {'content': 'Explain unfamiliar terms with an example.'})
        self.entity('MCP config', '/api/mcp-servers', {'name': self.prefix, 'server_name': self.prefix.lower().replace(' ', '-'),
                    'command': 'unused-audit-only', 'args': [], 'env': {}, 'server_type': 'stdio'},
                    {'description': 'Offline configuration, never launched'})
        self.entity('Memory note', '/api/memory', {'name': self.prefix, 'type': 'project', 'content': 'AUDIT-MEMORY-314',
                    'workspace_id': ws}, {'content': 'AUDIT-MEMORY-315'})
        self.entity('Research note', '/api/research', {'workspace_id': ws, 'topic': self.prefix,
                    'findings_summary': 'Synthetic stored note, no research run'}, {'findings_summary': 'Updated stored note'})
        self.entity('Event log subscription', '/api/events/subscriptions', {'workspace_id': ws, 'name': self.prefix,
                    'event_types': '*', 'delivery_type': 'log'}, {'enabled': 0})

        setting = 'audit_roundtrip_' + uuid.uuid4().hex[:8]
        self.cleanup.append(('Preference cleanup', 'PUT', '/api/settings/' + setting, {'value': None}))
        self.check('Preference save', 'PUT', '/api/settings/' + setting, {'value': {'theme': 'audit'}})
        self.check('Preference reload', 'GET', '/api/settings/' + setting,
                   verify=lambda row: json.loads(row['value']) == {'theme': 'audit'})
        # Invalid calls are deliberate contract tests and must be client errors.
        for feature, path, body, statuses in (
            ('Prompt validation', '/api/prompts', {}, (400,)),
            ('Template validation', '/api/templates', {}, (400,)),
            ('Task validation', '/api/tasks', {'workspace_id': ws}, (400,)),
            ('Cascade validation', '/api/cascades', {'name': self.prefix}, (400,)),
            ('Event validation', '/api/events/emit', {'event_type': 'audit_not_registered'}, (400,)),
            ('Subscription validation', '/api/events/subscriptions', {'name': self.prefix, 'event_types': 'audit_not_registered'}, (400,)),
            ('Research configuration failure', '/api/research/jobs', {'workspace_id': ws, 'query': 'Offline audit', 'model': 'audit-missing/model'}, (400, 404, 503)),
            ('MCP parser configuration failure', '/api/mcp-servers/parse-docs', {'docs': 'Example', 'model': 'audit-missing/model'}, (400, 503)),
        ):
            self.check(feature, 'POST', path, body, expect=statuses)

        # Local installation content only; no URL/repository fields, so no downloads.
        skill_name = self.prefix.lower().replace(' ', '-')
        skill = {'workspace_id': ws, 'name': skill_name, 'content': '---\nname: Audit\ndescription: Offline audit\n---\nExplain plainly.',
                 'cli_types': ['claude', 'codex'], 'scope': 'project'}
        self.cleanup.append(('Local skill remove', 'POST', '/api/skills/uninstall', {k:v for k,v in skill.items() if k != 'content'}))
        self.check('Local skill install', 'POST', '/api/skills/install', skill, expect=(201,),
                   verify=lambda row: all(result['ok'] for result in row['results'].values()))
        self.check('Local skill discovery', 'GET', '/api/skills/installed?' + urlencode({'workspace_id': ws, 'scope': 'project'}),
                   verify=lambda rows: any(row.get('slug') == skill_name for row in rows))

    def finish(self):
        for feature, method, path, body in reversed(self.cleanup):
            self.check(feature, method, path, body, expect=(200, 204))
        report = {'sandbox_verified': self.verified, 'base_url': self.base, 'workspace': self.workspace,
                  'started_at_epoch': self.started, 'finished_at_epoch': time.time(),
                  'test_mode': 'real HTTP with fake CLIs and temporary HOME/SQLite',
                  'checks': self.records, 'passed': sum(r['passed'] for r in self.records),
                  'failed': sum(not r['passed'] for r in self.records),
                  'limitations': ['No external service calls, downloads, auth changes, paid model calls, or production mutations.',
                                  'Use code revision/restart metadata from the root audit to distinguish pre-fix and post-fix server results.']}
        self.output.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({k: report[k] for k in ('sandbox_verified', 'passed', 'failed')}), flush=True)
        return 0 if report['failed'] == 0 else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--sandbox', required=True)
    parser.add_argument('--workspace', required=True)
    parser.add_argument('--output', default='/tmp/ive-api-audit.json')
    args = parser.parse_args()
    audit = Audit(args)
    try:
        audit.run()
    finally:
        code = audit.finish()
    return code


if __name__ == '__main__':
    sys.exit(main())
