#!/usr/bin/env python3
"""Collect installed dependency license texts alongside the compiled app."""
import importlib.metadata
import json
from pathlib import Path
import re
import sys
import tomllib

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'packaging/build/notices'
OUT.mkdir(parents=True, exist_ok=True)
sections=[]

def notice(name, version, directory):
    files=[]
    for path in sorted(directory.iterdir()) if directory.is_dir() else []:
        if path.is_file() and re.match(r'(?i)^(license|licence|copying|notice)([._-]|$)', path.name):
            if path.stat().st_size < 2_000_000:
                files.append((path.name, path.read_text(errors='replace')))
        elif path.is_dir() and path.name.lower() in {'license', 'licenses'}:
            for child in sorted(path.rglob('*')):
                if child.is_file() and child.stat().st_size < 2_000_000:
                    files.append((str(child.relative_to(directory)), child.read_text(errors='replace')))
    if files:
        sections.append(f'\n{"="*72}\n{name} {version}\n' + ''.join(f'\n--- {label} ---\n{text}\n' for label,text in files))

notice('IVE', json.loads((ROOT/'frontend/src-tauri/tauri.conf.json').read_text())['version'], ROOT)
notice('Python', sys.version.split()[0], Path(sys.base_prefix)/'lib/python3.12')
notice('cloudflared (https://github.com/cloudflare/cloudflared)', '2026.10.0',
       ROOT/'packaging/artifacts/cloudflared-2026.10.0')
for distribution in sorted(importlib.metadata.distributions(),key=lambda d:d.metadata['Name']):
    for item in distribution.files or []:
        if str(item).endswith('.dist-info/METADATA'):
            notice(distribution.metadata['Name'], distribution.version, Path(distribution.locate_file(item)).parent)
            break
# npm's package-lock maps each installed version, including nested dependency versions.
lock=json.loads((ROOT/'frontend/package-lock.json').read_text())
for relative, metadata in sorted(lock.get('packages',{}).items()):
    if not relative or metadata.get('dev'):continue
    package=ROOT/'frontend'/relative
    if (package/'package.json').is_file():
        info=json.loads((package/'package.json').read_text())
        notice(info['name'],info.get('version',''),package)
lock=tomllib.loads((ROOT/'frontend/src-tauri/Cargo.lock').read_text())
registries=list((Path.home()/'.cargo/registry/src').glob('*'))
for package in lock['package']:
    for registry in registries:
        directory=registry/f"{package['name']}-{package['version']}"
        if directory.is_dir():
            notice(package['name'],package['version'],directory)
            break
(OUT/'THIRD-PARTY-NOTICES.txt').write_text('IVE includes third-party software. Collected license notices follow.\n'+''.join(sections))
print(f'Collected {len(sections)} dependency notices.')
