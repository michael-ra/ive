#!/usr/bin/env python3
"""Sign a separate IVE copy; optionally submit to Apple's notary service.

No credentials are accepted on the command line. Use an existing Developer ID
Application keychain identity and, only for an explicitly requested upload, an
existing notarytool keychain profile. This script never changes keychain ACLs.

  python3 packaging/sign-macos.py --app packaging/artifacts/installed/IVE.app \
    --identity 'Developer ID Application: COMPANY (TEAMID1234)' --dry-run

Remove --dry-run to sign (secure timestamps contact Apple). Add --notary-profile
PROFILE to upload both the app archive and signed DMG, wait, and staple tickets.
An existing output directory is always refused: previous deliveries stay intact.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('bundle_guard', HERE/'verify-bundle.py')
GUARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GUARD)
NODE = Path('Contents/Resources/backend/_internal/playwright/driver/node')
JIT_ENTITLEMENTS = {'com.apple.security.cs.allow-jit': True}
SOURCES = [
    'https://developer.apple.com/documentation/security/customizing-the-notarization-workflow',
    'https://developer.apple.com/documentation/apple-silicon/porting-just-in-time-compilers-to-apple-silicon',
    'https://pyinstaller.org/en/stable/feature-notes.html#macos-binary-code-signing',
]


def validate_identity(identity):
    if not re.fullmatch(r'Developer ID Application: [^\r\n]+ \([A-Z0-9]{10}\)', identity):
        raise ValueError('Use the full Developer ID Application identity, including its 10-character Team ID')
    return identity.rsplit('(', 1)[1][:-1]


def validate_paths(source, output):
    source, output = Path(source).resolve(), Path(output).resolve()
    if source.suffix != '.app' or not (source/'Contents/Info.plist').is_file():
        raise ValueError('Source must be a complete .app bundle')
    if output.exists():
        raise ValueError('Output directory already exists; choose a new directory (no overwrite)')
    if output.is_relative_to(source) or source.is_relative_to(output):
        raise ValueError('Source and output must not contain each other')
    return source, output


def signing_targets(source, audit):
    paths = {Path(item['path']) for item in audit['macho_images']}
    # Sign actual nested code bundles after their contents, never with --deep.
    paths.update(p.relative_to(source) for p in source.rglob('*')
                 if p.is_dir() and not p.is_symlink() and p.suffix in {'.app', '.framework', '.xpc', '.bundle'}
                 and (p/'Contents/Info.plist').is_file())
    return sorted(paths, key=lambda p: (-len(p.parts), str(p))) + [Path('.')]


def codesign_command(target, identity, entitlements=None):
    command = ['/usr/bin/codesign', '--force', '--sign', identity, '--timestamp', '--options', 'runtime']
    if entitlements:
        command += ['--entitlements', str(entitlements)]
    return command + [str(target)]


def run(command):
    result = subprocess.run([str(v) for v in command], capture_output=True, text=True, check=False)
    if result.returncode:
        # Don't echo tool output that could include keychain/account details.
        raise RuntimeError(f'{Path(command[0]).name} failed (exit {result.returncode}); inspect the local tool configuration')
    return result.stdout


def resolve_identity(identity):
    output = run(['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning'])
    matches = [fingerprint for fingerprint, name in re.findall(r'\b([0-9A-Fa-f]{40})\s+"([^"]+)"', output)
               if name == identity]
    if len(matches) != 1:
        raise ValueError('Exactly one valid matching Developer ID Application identity with private key is required')
    return matches[0]


def verify_signature(path, identity, team, node=False):
    run(['/usr/bin/codesign', '--verify', '--strict', str(path)])
    details = subprocess.run(['/usr/bin/codesign', '-d', '--verbose=4', str(path)],
                             capture_output=True, text=True, check=False)
    output = details.stdout + details.stderr
    if details.returncode or f'Authority={identity}\n' not in output or f'TeamIdentifier={team}\n' not in output:
        raise RuntimeError(f'Developer ID signature verification failed: {path.name}')
    if not re.search(r'^Timestamp=', output, re.M) or not re.search(r'flags=.*\bruntime\b', output):
        raise RuntimeError(f'Missing secure timestamp or hardened runtime: {path.name}')
    if node:
        entitlements = run(['/usr/bin/codesign', '-d', '--entitlements', '-', '--xml', str(path)])
        if plistlib.loads(entitlements.encode()) != JIT_ENTITLEMENTS:
            raise RuntimeError('Node must have exactly the allow-jit entitlement')


def notary_submit(path, profile, output):
    result = json.loads(run(['/usr/bin/xcrun', 'notarytool', 'submit', str(path),
                             '--keychain-profile', profile, '--wait', '--output-format', 'json']))
    receipt = {'id': result.get('id'), 'status': result.get('status'), 'artifact': path.name}
    (output/(path.name+'.notary.json')).write_text(json.dumps(receipt, indent=2)+'\n')
    if result.get('id'):
        run(['/usr/bin/xcrun', 'notarytool', 'log', result['id'], '--keychain-profile', profile,
             str(output/(path.name+'.notary-log.json'))])
    if result.get('status') != 'Accepted':
        raise RuntimeError(f'Apple did not accept {path.name}; inspect its local notary receipt/log')
    return receipt


def installation_notes(notarized):
    text = (HERE/'INSTALL-DE.txt').read_text()
    replacement = ('Diese App ist mit Developer ID signiert und von Apple notarisiert.\n'
                   'Die Notarisierungsbestätigung ist an die App angeheftet.' if notarized else
                   'Diese App ist mit Developer ID signiert, aber noch NICHT von Apple notarisiert.\n'
                   'Dies ist ein Signierkandidat, keine fertig notarisiert freigegebene Ausgabe.\n'
                   'macOS kann Downloads blockieren. Ändere keine globalen Sicherheitseinstellungen.')
    return re.sub(r'Diese lokale Vorschau ist ad hoc signiert,.*?Sicherheitseinstellungen\.',
                  replacement, text, count=1, flags=re.S)


def execute(source, output, identity, team, targets, profile, report):
    fingerprint = resolve_identity(identity)  # Before any destination mutation.
    output.mkdir(parents=True, exist_ok=False)
    app = output/source.name
    try:
        run(['/usr/bin/ditto', str(source), str(app)])
        entitlement_path = output/'node-entitlements.plist'
        entitlement_path.write_bytes(plistlib.dumps(JIT_ENTITLEMENTS))
        for relative in targets:
            target = app/relative
            run(codesign_command(target, fingerprint, entitlement_path if relative == NODE else None))
            verify_signature(target, identity, team, node=(relative == NODE))
        run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)])
        with (app/'Contents/Info.plist').open('rb') as stream:
            version = plistlib.load(stream)['CFBundleShortVersionString']
        stem = f'IVE-{version}-macOS-arm64'
        archive = output/f'{stem}.zip'
        run(['/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(archive)])
        report['signed'] = True
        if profile:
            report['app_notary'] = notary_submit(archive, profile, output)
            run(['/usr/bin/xcrun', 'stapler', 'staple', str(app)])
            run(['/usr/bin/xcrun', 'stapler', 'validate', str(app)])
            # ZIP cannot carry a stapled ticket itself. Repack the stapled app.
            archive.unlink()
            run(['/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(archive)])
        readme = output/'Bitte zuerst lesen.txt'
        readme.write_text(installation_notes(bool(profile)))
        dmg = output/f'{stem}.dmg'
        with tempfile.TemporaryDirectory(prefix='ive-signed-dmg-') as directory:
            stage = Path(directory)
            run(['/usr/bin/ditto', str(app), str(stage/app.name)])
            (stage/'Applications').symlink_to('/Applications')
            (stage/readme.name).write_text(readme.read_text())
            run(['/usr/bin/hdiutil', 'create', '-volname', 'IVE', '-srcfolder', str(stage), '-format', 'UDZO', str(dmg)])
        run(['/usr/bin/codesign', '--sign', fingerprint, '--timestamp', str(dmg)])
        run(['/usr/bin/codesign', '--verify', '--strict', str(dmg)])
        if profile:
            report['dmg_notary'] = notary_submit(dmg, profile, output)
            run(['/usr/bin/xcrun', 'stapler', 'staple', str(dmg)])
            run(['/usr/bin/xcrun', 'stapler', 'validate', str(dmg)])
            run(['/usr/sbin/spctl', '--assess', '--type', 'execute', '--verbose=2', str(app)])
            run(['/usr/sbin/spctl', '--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', str(dmg)])
            report['notarized'] = True
        checksums = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in [archive, dmg]}
        (output/f'{stem}.sha256').write_text(''.join(f'{digest}  {name}\n' for name, digest in checksums.items()))
        report['artifacts'] = checksums
        report['completed'] = True
    finally:
        (output/'signing-report.json').write_text(json.dumps(report, indent=2)+'\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, default=HERE/'artifacts/signed')
    parser.add_argument('--identity', required=True)
    parser.add_argument('--notary-profile', help='Explicitly upload to Apple using this existing keychain profile')
    parser.add_argument('--dry-run', action='store_true', help='Read-only audit/plan: no keychain use, copy, signing, or upload')
    args = parser.parse_args()
    team = validate_identity(args.identity)
    source, output = validate_paths(args.app, args.output_dir)
    audit = GUARD.inspect_bundle(source, max_macos='13.5')
    if not audit['passed']:
        raise RuntimeError('Bundle preflight failed: '+json.dumps(audit['violations']))
    targets = signing_targets(source, audit)
    report = {'source': str(source), 'output': str(output), 'team_id': team, 'dry_run': args.dry_run,
              'signed': False, 'notarized': False, 'completed': False,
              'upload_requested': bool(args.notary_profile), 'sources': SOURCES,
              'signing_order': [{'path': str(path), 'entitlements': JIT_ENTITLEMENTS if path == NODE else {}}
                                for path in targets]}
    if args.dry_run:
        print(json.dumps(report, indent=2))
        return
    execute(source, output, args.identity, team, targets, args.notary_profile, report)
    print(json.dumps({'completed': report['completed'], 'notarized': report['notarized'],
                      'report': str(output/'signing-report.json')}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
