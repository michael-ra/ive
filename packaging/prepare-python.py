#!/usr/bin/env python3
"""Pinned build interpreter; the installed app does not execute this downloader."""
import hashlib
from pathlib import Path
import platform
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent
VERSION = '3.12.15'
RELEASE = '20261009'
SHA256 = '233f8e15255b3e1d1fd47ea5dd5230dfed803f371138e896e54d98c60ae19f6f'
URL = f'https://github.com/astral-sh/python-build-standalone/releases/download/{RELEASE}/cpython-{VERSION}%2B{RELEASE}-aarch64-apple-darwin-install_only_stripped.tar.gz'


def prepare():
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise SystemExit('This release build targets Apple Silicon macOS. Intel requires a separate validated runtime.')
    destination = ROOT / '.python'
    interpreter = destination / 'python/bin/python3'
    receipt = destination / 'archive.sha256'
    if interpreter.is_file() and receipt.is_file() and receipt.read_text().strip() == SHA256:
        return interpreter
    destination.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='ive-python-') as temp:
        archive = Path(temp) / 'python.tar.gz'
        with urllib.request.urlopen(URL, timeout=60) as response, archive.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
            raise SystemExit('Python runtime checksum mismatch; refusing to extract.')
        # The archive has been verified against the pinned publisher digest.
        # macOS tar also works on build hosts with the system Python 3.9.
        subprocess.run(['/usr/bin/tar', '-xzf', str(archive), '-C', str(destination)], check=True)
        receipt.write_text(SHA256 + '\n')
    return interpreter


if __name__ == '__main__':
    print(prepare())
