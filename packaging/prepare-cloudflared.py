#!/usr/bin/env python3
"""Build pinned cloudflared for macOS 13.5 without installing a global Go.

Cloudflare's prebuilt 2026.10.0 arm64 release requires macOS 15. Build its exact
source commit with the official Go 1.26.9 toolchain instead (Go supports macOS12).
Every archive is checksum-pinned before extraction; modules use upstream go.sum.
Build tools/caches/output stay in ignored packaging/artifacts. The original
upstream executable, if present, is never overwritten.
"""
from pathlib import Path, PurePosixPath
import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

VERSION = '2026.10.0'
# Retained as upstream provenance only; this is NOT the compatible source build.
ARCHIVE_SHA = 'a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70'
BINARY_SHA = '72edfd3eea463aef4d5cb89e2e209cecb048cc756c2b01915de2e0ad7cb39830'
LICENSE_SHA = '58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd'
SOURCE_COMMIT = '18cdfe0a6fc7b72a0702d255a1f984e776ce0498'
SOURCE_SHA = '303c531b416b986bfcc2157c0a90556c94c519ec4d71e64d32abbe5c451f59ec'
GO_VERSION = '1.26.9'
GO_SHA = 'f9bb7c0a02506c5d9bf0d1eb1f7ee6c7684f844ae49558308a0427b830e022cc'
GO_MOD_SHA = '1a9fbf726b1816625d709fcaabfd27a24005ce89e16bee76838e70d2ee423fee'
GO_SUM_SHA = 'a99cd810e0a3ee653472c414a4d419f889565fb9c3f4c62f6fd1a0135a2b67e5'
BUILD_TIME = '2026-10-05T15:39:13Z'  # official annotated release tag timestamp
COMPAT_BINARY_SHA = 'e7e2785cfb53d7ec777a70ad4f0722bcdf0f29c1f49262ea8005337836c250dd'
NOTICES_SHA = 'd915d487457abf80312c448e89fa72cd5a8664481b1332fecbd104e32cf261b0'
ROOT = Path(__file__).resolve().parent
DEST = ROOT / 'artifacts' / f'cloudflared-{VERSION}'
COMPAT = DEST / 'compat'
SOURCE_URL = f'https://codeload.github.com/cloudflare/cloudflared/tar.gz/{SOURCE_COMMIT}'
GO_URL = f'https://go.dev/dl/go{GO_VERSION}.darwin-arm64.tar.gz'
MAX_MACOS = (13, 5, 0)


def sha(path):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f'Expected regular build input: {path.name}')
    digest = hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def checked_file(path, expected):
    if sha(path) != expected:
        raise RuntimeError(f'Pinned checksum mismatch: {path.name}; refusing build')
    return path


def archive(name, url, expected, limit=100_000_000):
    target = DEST / name
    if not target.exists():
        print(f'Downloading pinned {name}', file=sys.stderr, flush=True)
        request = urllib.request.Request(url, headers={'User-Agent': 'IVE-local-packaging'})
        with urllib.request.urlopen(request, timeout=90) as response:
            data = response.read(limit + 1)
        if len(data) > limit or hashlib.sha256(data).hexdigest() != expected:
            raise RuntimeError(f'Archive checksum/size mismatch: {name}')
        temporary = target.with_suffix(target.suffix + '.partial')
        if temporary.is_symlink():
            raise RuntimeError('Unsafe archive cache path')
        temporary.write_bytes(data)
        temporary.replace(target)
    return checked_file(target, expected)


def extract_checked(archive_path, target, root_name):
    """Extract only normal files/directories into a new, owned temporary tree."""
    with tempfile.TemporaryDirectory(prefix='extract-', dir=DEST) as temporary:
        staging = Path(temporary)
        with tarfile.open(archive_path, 'r:gz') as bundle:
            members = bundle.getmembers()
            total = 0
            for member in members:
                path = PurePosixPath(member.name)
                if (path.is_absolute() or '..' in path.parts or not path.parts or
                        path.parts[0] != root_name or not (member.isfile() or member.isdir())):
                    raise RuntimeError(f'Unsafe archive entry: {member.name}')
                total += member.size
                if member.size > 100_000_000 or total > 700_000_000:
                    raise RuntimeError('Unexpected uncompressed archive size')
            for member in members:
                output = staging.joinpath(*PurePosixPath(member.name).parts)
                if member.isdir():
                    output.mkdir(parents=True, exist_ok=True)
                    continue
                output.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, output.open('xb') as destination:
                    shutil.copyfileobj(source, destination)
                output.chmod(0o755 if member.mode & 0o111 else 0o644)
        if target.is_symlink():
            raise RuntimeError('Unsafe extracted cache path')
        if target.exists():
            shutil.rmtree(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        (staging / root_name).replace(target)


def version_tuple(text):
    fields = tuple(int(part) for part in text.split('.'))
    return fields + (0,) * (3 - len(fields))


def inspect_binary(binary):
    arches = subprocess.check_output(['/usr/bin/lipo', '-archs', str(binary)], text=True).strip()
    if arches != 'arm64':
        raise RuntimeError(f'Expected arm64 cloudflared, found {arches}')
    loads = subprocess.check_output(['/usr/bin/otool', '-l', str(binary)], text=True)
    minimums = []
    for command in re.split(r'Load command \d+', loads):
        if 'LC_BUILD_VERSION' in command:
            match = re.search(r'^\s*minos\s+([\d.]+)', command, re.M)
            platform_match = re.search(r'^\s*platform\s+(\S+)', command, re.M)
            if not platform_match or platform_match[1] not in {'1', 'MACOS', 'macos'}:
                raise RuntimeError('Unexpected Mach-O platform')
        elif 'LC_VERSION_MIN_MACOSX' in command:
            match = re.search(r'^\s*version\s+([\d.]+)', command, re.M)
        else:
            continue
        if not match or version_tuple(match[1]) > MAX_MACOS:
            raise RuntimeError('cloudflared exceeds macOS 13.5 minimum')
        minimums.append(match[1])
    if not minimums:
        raise RuntimeError('cloudflared has no verifiable minimum macOS version')
    linked = subprocess.check_output(['/usr/bin/otool', '-L', str(binary)], text=True)
    for line in linked.splitlines()[1:]:
        library = line.strip().split(' (')[0]
        if library and not library.startswith(('/usr/lib/', '/System/Library/')):
            raise RuntimeError(f'Non-system dynamic library: {library}')
    output = subprocess.check_output([str(binary), '--version'], text=True, timeout=15).strip()
    if not output.startswith(f'cloudflared version {VERSION} '):
        raise RuntimeError(f'Unexpected cloudflared runtime version: {output}')
    return {'architecture': arches, 'minimum_macos': max(minimums, key=version_tuple), 'version_output': output}


def build_metadata(binary):
    binary = Path(binary)
    if COMPAT_BINARY_SHA:
        checked_file(binary, COMPAT_BINARY_SHA)
    return {
        'version': VERSION, 'build_kind': 'pinned-source-cgo-disabled',
        'sha256': sha(binary), 'source_commit': SOURCE_COMMIT,
        'source_archive_sha256': SOURCE_SHA, 'toolchain': f'go{GO_VERSION}',
        'toolchain_archive_sha256': GO_SHA, 'go_sum_sha256': GO_SUM_SHA,
        'upstream_binary_sha256': BINARY_SHA, 'build_time': BUILD_TIME,
        **inspect_binary(binary),
    }


def go_environment(toolchain):
    # Only child processes receive these settings. HOME and shell profiles remain
    # untouched; ambient Go flags/workspaces/auto-downloaded toolchains are disabled.
    env = {key: value for key, value in os.environ.items() if not key.startswith(('GO', 'CGO_'))}
    for name in ('CC', 'CXX', 'LD', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'SDKROOT'):
        env.pop(name, None)
    directories = {name: DEST / value for name, value in {
        'GOPATH': 'go-work', 'GOMODCACHE': 'go-modules', 'GOCACHE': 'go-cache', 'GOTMPDIR': 'go-tmp',
    }.items()}
    for path in directories.values():
        path.mkdir(parents=True, exist_ok=True)
    env.update({name: str(path) for name, path in directories.items()})
    env.update({
        'GOROOT': str(toolchain), 'GOTOOLCHAIN': 'local', 'GOTELEMETRY': 'off',
        'GOENV': 'off', 'GOWORK': 'off', 'GOPROXY': 'https://proxy.golang.org',
        'GOSUMDB': 'sum.golang.org', 'GOFLAGS': '-mod=readonly',
        'GOOS': 'darwin', 'GOARCH': 'arm64', 'GOARM64': 'v8.0', 'CGO_ENABLED': '0',
        'MACOSX_DEPLOYMENT_TARGET': '13.5', 'GOMAXPROCS': '4',
        'SOURCE_DATE_EPOCH': '1791214753', 'TZ': 'UTC',
    })
    return env


def run_go(go, source, env, *arguments):
    print('cloudflared: go ' + ' '.join(arguments[:3]), file=sys.stderr, flush=True)
    return subprocess.check_output([str(go), *arguments], cwd=source, env=env, text=True, stderr=subprocess.STDOUT)


def json_records(text):
    decoder = json.JSONDecoder()
    offset = 0
    while offset < len(text):
        while offset < len(text) and text[offset].isspace():
            offset += 1
        if offset == len(text):
            break
        value, offset = decoder.raw_decode(text, offset)
        yield value


def collect_notices(go, source, toolchain, env):
    packages = json_records(run_go(go, source, env, 'list', '-deps', '-json', './cmd/cloudflared'))
    modules = {}
    for package in packages:
        module = package.get('Module')
        if module and not module.get('Main'):
            module = module.get('Replace', module)
            modules[(module['Path'], module.get('Version', ''))] = Path(module['Dir'])
    sections = [('Go runtime', GO_VERSION, (toolchain / 'LICENSE').read_text())]
    missing = []
    for (name, version), directory in sorted(modules.items()):
        files = [path for path in sorted(directory.iterdir()) if path.is_file() and
                 re.match(r'(?i)^(licen[cs]e|copying|notice)([._-]|$)', path.name)]
        if not files:
            missing.append(name)
        for path in files:
            if path.stat().st_size > 2_000_000:
                raise RuntimeError('Unexpected dependency license size')
            sections.append((name, version + ' / ' + path.name, path.read_text(errors='replace')))
    if missing:
        raise RuntimeError('Missing linked module license notices: ' + ', '.join(missing))
    text = 'IVE cloudflared compatibility build. Upstream source is unmodified.\n' + ''.join(
        f'\n{"=" * 72}\n{name} {version}\n\n{content}\n' for name, version, content in sections)
    (DEST / 'NOTICE-dependencies.txt').write_text(text)
    return len(modules)


def prepare():
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise RuntimeError('This installer target is macOS Apple Silicon')
    DEST.mkdir(parents=True, exist_ok=True)
    with (DEST / '.prepare.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        binary = COMPAT / 'cloudflared'
        manifest = COMPAT / 'build-info.json'
        if COMPAT_BINARY_SHA and binary.is_file() and manifest.is_file():
            metadata = build_metadata(binary)  # validates cached binary, architecture and minimum OS
            stored = json.loads(manifest.read_text())
            if any(stored.get(key) != value for key, value in metadata.items()):
                raise RuntimeError('Cached cloudflared provenance does not match pinned build')
            checked_file(DEST / 'LICENSE', LICENSE_SHA)
            if stored.get('notices_sha256') != NOTICES_SHA:
                raise RuntimeError('Cached dependency notice provenance mismatch')
            checked_file(DEST / 'NOTICE-dependencies.txt', NOTICES_SHA)
            return binary
        source_archive = archive(f'cloudflared-source-{SOURCE_COMMIT}.tar.gz', SOURCE_URL, SOURCE_SHA)
        go_archive = archive(f'go{GO_VERSION}.darwin-arm64.tar.gz', GO_URL, GO_SHA)
        source = DEST / 'source'
        toolchain = DEST / 'toolchain' / 'go'
        extract_checked(source_archive, source, f'cloudflared-{SOURCE_COMMIT}')
        extract_checked(go_archive, toolchain, 'go')
        checked_file(source / 'go.mod', GO_MOD_SHA)
        checked_file(source / 'go.sum', GO_SUM_SHA)
        shutil.copyfile(checked_file(source / 'LICENSE', LICENSE_SHA), DEST / 'LICENSE')
        go = toolchain / 'bin' / 'go'
        env = go_environment(toolchain)
        actual_go = run_go(go, source, env, 'version').strip()
        if actual_go != f'go version go{GO_VERSION} darwin/arm64':
            raise RuntimeError('Unexpected isolated Go version')
        # Without "all", Go downloads the module build list, not dependencies of
        # dependency tests whose extra sums are absent from upstream go.sum.
        downloads = run_go(go, source, env, 'mod', 'download')
        (DEST / 'module-download.log').write_text(downloads)
        checked_file(source / 'go.sum', GO_SUM_SHA)
        verification = run_go(go, source, env, 'mod', 'verify')
        if verification.strip() != 'all modules verified':
            raise RuntimeError('Go module checksum verification failed')
        (DEST / 'module-verification.log').write_text(verification)
        COMPAT.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='build-', dir=DEST) as temporary:
            output = Path(temporary) / 'cloudflared'
            flags = f'-s -w -buildid= -X main.Version={VERSION} -X main.BuildTime={BUILD_TIME} -X github.com/cloudflare/cloudflared/cmd/cloudflared/updater.BuiltForPackageManager=IVE'
            build_log = run_go(go, source, env, 'build', '-trimpath', '-buildvcs=false', '-ldflags', flags, '-o', str(output), './cmd/cloudflared')
            (DEST / 'build.log').write_text(build_log)
            checked_file(source / 'go.mod', GO_MOD_SHA)
            checked_file(source / 'go.sum', GO_SUM_SHA)
            metadata = build_metadata(output)
            count = collect_notices(go, source, toolchain, env)
            checked_file(DEST / 'NOTICE-dependencies.txt', NOTICES_SHA)
            metadata.update({'linked_module_count': count, 'notices_sha256': sha(DEST / 'NOTICE-dependencies.txt')})
            output.chmod(0o755)
            output.replace(binary)
            manifest.write_text(json.dumps(metadata, indent=2) + '\n')
        return binary


if __name__ == '__main__':
    try:
        print(prepare())
    except subprocess.CalledProcessError as error:
        print(error.output, file=sys.stderr)
        raise SystemExit(error.returncode)
