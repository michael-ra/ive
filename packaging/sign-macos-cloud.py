#!/usr/bin/env python3
"""Export a prebuilt IVE app through Xcode's cloud-managed Developer ID.

Uses the synthetic archive layout accepted by local Xcode 27. This is an adapter
for this bundle, not a promise that arbitrary non-Xcode archives are supported.
The source and existing deliveries are never modified. A real run contacts Apple
using an account already configured in Xcode; no credentials or ACL changes here.
This exports signed code only; it neither requests nor claims notarization.

  python3 packaging/sign-macos-cloud.py --app packaging/artifacts/installed/IVE.app \
    --output-dir packaging/artifacts/cloud-export-NEW --team-id 66Y43UAY3C --dry-run

Remove --dry-run only when ready to request cloud signing. After a successful
export, repeat native runtime tests against export/IVE.app before notarization.
"""
from __future__ import annotations
import argparse
import datetime
import importlib.util
import json
from pathlib import Path
import plistlib
import re
import subprocess
import sys

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('local_signing', HERE/'sign-macos.py')
SIGN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SIGN)


def validate_team(team):
    if not re.fullmatch(r'[A-Z0-9]{10}', team):
        raise ValueError('Team ID must contain exactly 10 uppercase letters/digits')
    return team


def export_options(team):
    return {'method': 'developer-id', 'destination': 'export', 'signingStyle': 'automatic',
            'teamID': validate_team(team), 'manageAppVersionAndBuildNumber': False,
            'stripSwiftSymbols': False}


def archive_metadata(source, team):
    with (source/'Contents/Info.plist').open('rb') as stream:
        info = plistlib.load(stream)
    return {'ArchiveVersion': 2, 'CreationDate': datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None),
            'Name': source.stem, 'SchemeName': source.stem,
            'ApplicationProperties': {
                'ApplicationPath': f'Applications/{source.name}', 'Architectures': ['arm64'],
                'CFBundleIdentifier': info['CFBundleIdentifier'],
                'CFBundleShortVersionString': info['CFBundleShortVersionString'],
                'CFBundleVersion': info['CFBundleVersion'], 'SigningIdentity': '-', 'Team': validate_team(team)}}


def adhoc_command(target, entitlements=None):
    command = ['/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none', '--options', 'runtime']
    if target.name == 'ive-phone-power':
        command += ['--identifier', 'com.ive.desktop.phone-power']
    if entitlements:
        command += ['--entitlements', str(entitlements)]
    return command + [str(target)]


def export_command(archive, output, options):
    return ['/usr/bin/xcodebuild', '-exportArchive', '-archivePath', str(archive),
            '-exportPath', str(output), '-exportOptionsPlist', str(options), '-allowProvisioningUpdates']


def verify_export(app, expected_paths, team):
    """Every Mach-O, even those stored under Resources, must be cloud-signed."""
    audit = SIGN.GUARD.inspect_bundle(app, max_macos='13.5')
    if not audit['passed']:
        raise RuntimeError('Exported bundle failed architecture/dependency/state verification')
    actual_paths = {item['path'] for item in audit['macho_images']}
    if actual_paths != set(expected_paths):
        raise RuntimeError('Export changed the Mach-O inventory; refusing incomplete signature verification')
    # The explicit Apple anchor + Developer ID OID also rules out a self-signed
    # identity that merely has an identical display name or team identifier.
    requirement = ('=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists '
                   f'and certificate leaf[subject.OU] = "{validate_team(team)}"')
    verified = []
    for relative in sorted(actual_paths) + ['.']:
        path = app/relative
        details = subprocess.run(['/usr/bin/codesign', '-d', '--verbose=4', str(path)],
                                 capture_output=True, text=True, check=False)
        authorities = re.findall(r'^Authority=(Developer ID Application: .+)$', details.stdout+details.stderr, re.M)
        if details.returncode or len(authorities) != 1 or SIGN.validate_identity(authorities[0]) != team:
            raise RuntimeError(f'Export did not Developer-ID-sign required code: {relative}')
        SIGN.verify_signature(path, authorities[0], team, node=(Path(relative) == SIGN.NODE))
        SIGN.run(['/usr/bin/codesign', '--verify', '--strict', '-R', requirement, str(path)])
        if Path(relative).name == 'ive-phone-power':
            SIGN.run(['/usr/bin/codesign', '--verify', '--strict', '-R',
                      '=identifier "com.ive.desktop.phone-power" and ' + requirement.removeprefix('='), str(path)])
        verified.append({'path': relative, 'team_id': team, 'developer_id': True,
                         'secure_timestamp': True, 'hardened_runtime': True,
                         'jit': Path(relative) == SIGN.NODE})
    SIGN.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)])
    return verified


def perform_export(source, output, team, audit, targets, report):
    output.mkdir(parents=True, exist_ok=False)
    archive = output/f'{source.stem}.xcarchive'
    app = archive/'Products/Applications'/source.name
    options = output/'ExportOptions.plist'
    log = output/'xcode-export.log'
    try:
        app.parent.mkdir(parents=True)
        SIGN.run(['/usr/bin/ditto', str(source), str(app)])
        entitlements = output/'node-entitlements.plist'
        entitlements.write_bytes(plistlib.dumps(SIGN.JIT_ENTITLEMENTS))
        for relative in targets:
            SIGN.run(adhoc_command(app/relative, entitlements if relative == SIGN.NODE else None))
        SIGN.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)])
        (archive/'Info.plist').write_bytes(plistlib.dumps(archive_metadata(source, team)))
        options.write_bytes(plistlib.dumps(export_options(team)))
        # Account diagnostics stay in a private local file, not terminal output.
        with log.open('x') as stream:
            log.chmod(0o600)
            result = subprocess.run(export_command(archive, output/'export', options),
                                    stdout=stream, stderr=subprocess.STDOUT, check=False)
        report['xcode_exit_code'] = result.returncode
        if result.returncode:
            raise RuntimeError(f'Xcode cloud export failed (exit {result.returncode}); inspect {log}')
        exported_app = output/'export'/source.name
        if not exported_app.is_dir():
            raise RuntimeError('Xcode returned success without the expected exported app')
        expected = [item['path'] for item in audit['macho_images']]
        report['verified_signatures'] = verify_export(exported_app, expected, team)
        report['exported_app'] = str(exported_app)
        report['signed'] = True
        report['completed'] = True
    except Exception as error:
        report['error'] = str(error)
        raise
    finally:
        (output/'cloud-signing-report.json').write_text(json.dumps(report, indent=2)+'\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True, help='New directory; existing paths are refused')
    parser.add_argument('--team-id', required=True)
    parser.add_argument('--dry-run', action='store_true', help='Read-only plan; no copying, signing, account/network operation')
    args = parser.parse_args()
    team = validate_team(args.team_id)
    source, output = SIGN.validate_paths(args.app, args.output_dir)
    audit = SIGN.GUARD.inspect_bundle(source, max_macos='13.5')
    if not audit['passed']:
        raise RuntimeError('Bundle preflight failed: '+json.dumps(audit['violations']))
    targets = SIGN.signing_targets(source, audit)
    if SIGN.NODE not in targets:
        raise RuntimeError('Expected IVE Playwright Node runtime is missing')
    report = {'source': str(source), 'output': str(output), 'team_id': team,
              'dry_run': args.dry_run, 'completed': False, 'signed': False, 'notarized': False,
              'export_options': export_options(team), 'macho_count': len(audit['macho_images']),
              'signing_order': [{'path': str(path), 'entitlements': SIGN.JIT_ENTITLEMENTS if path == SIGN.NODE else {}}
                                for path in targets],
              'export_command': export_command(output/f'{source.stem}.xcarchive', output/'export', output/'ExportOptions.plist')}
    if args.dry_run:
        print(json.dumps(report, indent=2))
        return
    perform_export(source, output, team, audit, targets, report)
    print(json.dumps({'completed': report['completed'], 'signed': report['signed'], 'notarized': False,
                      'report': str(output/'cloud-signing-report.json')}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
