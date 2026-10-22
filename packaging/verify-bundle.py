#!/usr/bin/env python3
"""Read-only macOS bundle guard: runtime architecture, OS floor, and local state.

Example: python3 packaging/verify-bundle.py --bundle IVE.app --max-macos 13.5 \
    --report bundle-verification.json

Requires Apple's otool, normally installed with the Xcode command-line tools.
The report describes the arm64 runtime slices; it does not claim notarization,
functional compatibility with older macOS releases, or exhaustive secret detection.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys


ARM64 = 0x0100000C
CPU_NAMES = {ARM64: 'arm64', 0x01000007: 'x86_64', 7: 'i386', 12: 'arm'}
THIN_MAGICS = {b'\xce\xfa\xed\xfe': '<', b'\xcf\xfa\xed\xfe': '<',
               b'\xfe\xed\xfa\xce': '>', b'\xfe\xed\xfa\xcf': '>'}
FAT_MAGICS = {b'\xca\xfe\xba\xbe': ('>', False), b'\xbe\xba\xfe\xca': ('<', False),
              b'\xca\xfe\xba\xbf': ('>', True), b'\xbf\xba\xfe\xca': ('<', True)}
# Mach-O object archives are not dynamically loadable runtime images.
RUNTIME_TYPES = {2, 6, 7, 8}  # MH_EXECUTE, MH_DYLIB, MH_DYLINKER, MH_BUNDLE
DYLIB_COMMANDS = {'LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB',
                  'LC_LOAD_UPWARD_DYLIB', 'LC_LAZY_LOAD_DYLIB'}
PRIVATE_KEY = re.compile(br'-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----')
PRIVATE_NAMES = {'credentials.json', '.credentials.json', 'credentials', 'auth.json',
                 'secrets.json', 'token.json', 'tokens.json', 'id_rsa', 'id_dsa',
                 'id_ecdsa', 'id_ed25519', 'login.keychain', 'login.keychain-db'}
STATE_DIRECTORIES = {'.ive', '.ive-team-state', 'account_homes', '.claude', '.codex',
                     '.gemini', '.aws', '.ssh'}
EXAMPLE_ENV_SUFFIXES = ('.example', '.sample', '.template', '.dist')


def version(value):
    if not re.fullmatch(r'\d+(?:\.\d+){0,2}', value):
        raise ValueError(f'Invalid macOS version: {value!r}')
    parts = tuple(map(int, value.split('.')))
    return parts + (0,) * (3 - len(parts))


def macho_slices(path):
    """Read bounded headers, including validated universal binaries (not Java)."""
    size = path.stat().st_size
    with path.open('rb') as source:
        head = source.read(8)
        magic = head[:4]
        if magic in THIN_MAGICS:
            source.seek(0)
            data = source.read(16)
            if len(data) < 16:
                raise ValueError('Truncated Mach-O header')
            cpu, subtype, kind = struct.unpack(THIN_MAGICS[magic] + 'III', data[4:16])
            return [{'cpu': cpu, 'subtype': subtype, 'type': kind}]
        if magic not in FAT_MAGICS or len(head) < 8:
            return []
        endian, fat64 = FAT_MAGICS[magic]
        count = struct.unpack(endian + 'I', head[4:8])[0]
        # Java class files share CAFEBABE but do not have a sane fat table.
        if count < 1 or count > 64:
            return []
        table_end = 8 + count * (32 if fat64 else 20)
        if table_end > size:
            return []
        records = []
        for _ in range(count):
            data = source.read(32 if fat64 else 20)
            fields = struct.unpack(endian + ('IIQQII' if fat64 else 'IIIII'), data)
            cpu, subtype, offset, length = fields[:4]
            if offset < table_end or length < 16 or offset + length > size:
                return []
            records.append((cpu, subtype, offset))
        result = []
        for cpu, subtype, offset in records:
            source.seek(offset)
            data = source.read(16)
            if data[:4] not in THIN_MAGICS:
                return []
            actual_cpu, actual_subtype, kind = struct.unpack(THIN_MAGICS[data[:4]] + 'III', data[4:16])
            if (cpu, subtype) != (actual_cpu, actual_subtype):
                raise ValueError('Universal slice disagrees with its Mach-O header')
            result.append({'cpu': cpu, 'subtype': subtype, 'type': kind})
        return result


def parse_load_commands(output):
    """Parse otool -l without interpreting command contents as shell input."""
    result = {'minimum_macos': [], 'platforms': [], 'dependencies': [], 'rpaths': []}
    command = None
    for raw in output.splitlines():
        line = raw.strip()
        if line.startswith('cmd '):
            command = line[4:].strip()
        elif command == 'LC_BUILD_VERSION':
            if line.startswith('platform '):
                result['platforms'].append(line.split(None, 1)[1].lower())
            elif line.startswith('minos '):
                result['minimum_macos'].append(line.split(None, 1)[1])
        elif command == 'LC_VERSION_MIN_MACOSX' and line.startswith('version '):
            result['platforms'].append('macos')
            result['minimum_macos'].append(line.split(None, 1)[1])
        elif command in DYLIB_COMMANDS and line.startswith('name '):
            result['dependencies'].append(re.sub(r' \(offset \d+\)$', '', line[5:]))
        elif command == 'LC_RPATH' and line.startswith('path '):
            result['rpaths'].append(re.sub(r' \(offset \d+\)$', '', line[5:]))
    return result


def unsafe_loader_path(value):
    if value in {'@loader_path', '@executable_path'}:
        return False
    if value.startswith(('@rpath/', '@loader_path/', '@executable_path/')):
        # A relative dyld token is expected. Reject embedded build-machine paths.
        return any(part in value for part in ('/opt/homebrew/', '/Users/', '/Library/Frameworks/'))
    if value.startswith(('/usr/lib/', '/System/Library/')):
        return False
    # Absolute non-system dependencies/rpaths make the app machine-dependent.
    return True


def state_reason(relative, path):
    """Only definite names/key markers; no token-like-string scan of libraries."""
    name = relative.name.lower()
    if any(part.lower() in STATE_DIRECTORIES for part in relative.parts[:-1]):
        return 'Private provider/account state directory'
    if name.endswith(('.db', '.sqlite', '.sqlite3', '.db-wal', '.db-shm')):
        return 'Runtime database or database journal'
    if (name == '.env' or name.startswith('.env.')) and not name.endswith(EXAMPLE_ENV_SUFFIXES):
        return 'Environment configuration file'
    if name in PRIVATE_NAMES:
        return 'Credential or private-key filename'
    # Public CA bundles (e.g. certifi/cacert.pem), Python keyring packages, and
    # code containing examples are legitimate runtime files, not credentials.
    if path.suffix.lower() in {'.pem', '.key'}:
        with path.open('rb') as source:
            if PRIVATE_KEY.search(source.read(2_097_152)):
                return 'PEM/OpenSSH private-key material'
    return None


def inspect_bundle(bundle, max_macos='13.5', otool=None):
    bundle = Path(bundle).resolve()
    ceiling = version(max_macos)
    report = {'bundle': str(bundle), 'required_architecture': 'arm64',
              'maximum_minimum_macos': max_macos, 'passed': False,
              'files_checked': 0, 'macho_images': [], 'ignored_macho_objects': [],
              'violations': []}
    def fail(path, code, detail):
        report['violations'].append({'path': str(path), 'code': code, 'detail': detail})
    if not bundle.is_dir():
        fail('.', 'bundle_missing', 'Bundle directory does not exist')
        return report
    otool = otool or shutil.which('otool')
    if not otool:
        fail('.', 'inspection_tool_missing', 'Apple otool is required to inspect Mach-O load commands')
    for directory, dirs, files in os.walk(bundle, followlinks=False):
        dirs.sort(); files.sort()
        for name in dirs + files:
            path = Path(directory) / name
            relative = path.relative_to(bundle)
            if path.is_symlink():
                target = path.resolve()
                if not target.is_relative_to(bundle):
                    fail(relative, 'external_symlink', 'Symlink points outside the bundle')
                elif not target.exists():
                    fail(relative, 'broken_symlink', 'Symlink target is absent')
                # Every internal target is inspected at its real tree location.
                continue
            if not path.is_file():
                continue
            report['files_checked'] += 1
            try:
                reason = state_reason(relative, path)
                if reason:
                    fail(relative, 'bundled_private_state', reason)
                slices = macho_slices(path)
                if not slices:
                    continue
                if not any(item['type'] in RUNTIME_TYPES for item in slices):
                    report['ignored_macho_objects'].append(str(relative))
                    continue
                entry = {'path': str(relative), 'architectures': sorted(set(
                    CPU_NAMES.get(item['cpu'], hex(item['cpu'])) for item in slices))}
                report['macho_images'].append(entry)
                # arm64e is a distinct ABI; it is not a substitute for arm64.
                arm = [item for item in slices if item['cpu'] == ARM64 and (item['subtype'] & 0xffffff) == 0]
                if not arm:
                    fail(relative, 'arm64_missing', 'Runtime image has no generic arm64 slice')
                    continue
                if not otool:
                    continue
                completed = subprocess.run([otool, '-arch', 'arm64', '-l', str(path)],
                    capture_output=True, text=True, timeout=30, check=False)
                if completed.returncode:
                    fail(relative, 'load_command_inspection_failed', f'otool exited {completed.returncode}')
                    continue
                commands = parse_load_commands(completed.stdout)
                entry.update(commands)
                if not commands['minimum_macos']:
                    fail(relative, 'minimum_macos_missing', 'No macOS deployment target was found')
                if any(platform not in {'1', 'macos', 'macosx'} for platform in commands['platforms']):
                    fail(relative, 'unsupported_platform', 'Runtime slice targets a platform other than macOS')
                for minimum in commands['minimum_macos']:
                    if version(minimum) > ceiling:
                        fail(relative, 'minimum_macos_too_new', f'Requires macOS {minimum}, exceeds {max_macos}')
                for kind in ('dependencies', 'rpaths'):
                    for dependency in commands[kind]:
                        if unsafe_loader_path(dependency):
                            fail(relative, 'external_loader_path', f'{kind}: {dependency}')
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                fail(relative, 'inspection_failed', f'{type(error).__name__}: {error}')
    if not report['macho_images']:
        fail('.', 'runtime_images_missing', 'No Mach-O runtime images were found')
    report['passed'] = not report['violations']
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True, help='Built .app or PyInstaller directory')
    parser.add_argument('--max-macos', default='13.5', help='Maximum arm64 deployment target (default: 13.5)')
    parser.add_argument('--report', type=Path, help='Also save the JSON report to this path')
    args = parser.parse_args()
    try:
        version(args.max_macos)
    except ValueError as error:
        parser.error(str(error))
    report = inspect_bundle(args.bundle, args.max_macos)
    serialized = json.dumps(report, indent=2) + '\n'
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(serialized)
    print(serialized, end='')
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
