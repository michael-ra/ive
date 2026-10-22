# Run from any directory: pyinstaller --distpath packaging/dist --workpath packaging/build packaging/ive-backend.spec
from pathlib import Path
import hashlib
import json
import platform
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

from PyInstaller.utils.hooks import collect_submodules, copy_metadata

ROOT = Path(SPECPATH).resolve().parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(ROOT / "packaging"))
import importlib.util
helper_spec = importlib.util.spec_from_file_location("prepare_cloudflared", ROOT / "packaging/prepare-cloudflared.py")
helper = importlib.util.module_from_spec(helper_spec)
helper_spec.loader.exec_module(helper)
TUNNEL_HELPER = helper.prepare()
POWER_HELPER = ROOT / "packaging/build/phone-power/ive-phone-power"
if not POWER_HELPER.is_file():
    raise SystemExit("Build packaging/phone-power before packaging the backend")
STAGING = ROOT / "packaging" / "build" / "resources"
STAGING.mkdir(parents=True, exist_ok=True)
if not (ROOT / "frontend" / "dist" / "index.html").is_file():
    raise SystemExit("Build frontend/dist before packaging the backend")

# Runtime module dispatch and extension adapters use dynamic imports. Include
# only repository-owned backend modules, never tests, adjacent repositories,
# user state, credentials, node_modules or development virtual environments.
modules = []
source_files = []
for base, prefix in ((BACKEND, ""), (ROOT / "deep_research", "deep_research.")):
    for path in sorted(base.rglob("*.py")):
        rel = path.relative_to(base)
        if any(part.startswith("test") or part == "__pycache__" for part in rel.parts):
            continue
        module = prefix + ".".join(rel.with_suffix("").parts)
        if module.endswith(".__init__"):
            module = module[:-9]
        if module not in {"desktop_entry", "__init__"}:
            modules.append(module)
        source_files.append(path)

# Avoid the two different mcp_server.py module names colliding in the PYZ.
shutil.copyfile(ROOT / "plugins/deep-research/mcp_server.py", STAGING / "ive_research_mcp.py")
modules.append("ive_research_mcp")
modules += ["playwright.__main__", "playwright.async_api", "playwright.sync_api", "keyring.backends.macOS"]

datas = []
for name in ("skills_catalog.json", "mcp_config_template.json", "avcp.sh"):
    datas.append((str(BACKEND / name), "backend"))
for folder in ("frontend/dist", "extensions/sandbox", "anti-vibe-code-pwner", "backend/skills"):
    for path in sorted((ROOT / folder).rglob("*")):
        if path.is_file() and not any(part in {"__pycache__", ".git", "node_modules"} for part in path.parts):
            if path.suffix in {".pyc", ".log", ".db"} or path.name.startswith(".env"):
                continue
            datas.append((str(path), str(path.relative_to(ROOT).parent)))
datas.append((str(ROOT / "plugins/deep-research/SKILL.md"), "plugins/deep-research"))
datas.append((str(ROOT / "frontend/src/lib/informationArchitecture.js"), "frontend/src/lib"))
for distribution in ("keyring", "playwright", "aiohttp"):
    datas += copy_metadata(distribution)

version = re.search(r'^VERSION = "([^"]+)"', (BACKEND / "config.py").read_text(), re.M).group(1)
digest = hashlib.sha256()
digest.update(TUNNEL_HELPER.read_bytes())
digest.update(POWER_HELPER.read_bytes())
for source in sorted((ROOT / "packaging/phone-power").glob("*")):
    if source.is_file() and source.suffix in {".swift", ".plist", ".py"} and not source.name.endswith("Tests.swift"):
        digest.update(str(source.relative_to(ROOT)).encode())
        digest.update(source.read_bytes())
for path in sorted(source_files + [Path(source) for source, _ in datas if Path(source).is_file()]):
    digest.update(str(path.relative_to(ROOT)).encode() if path.is_relative_to(ROOT) else path.name.encode())
    digest.update(path.read_bytes())
try:
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
except (OSError, subprocess.CalledProcessError):
    revision = "unknown"
manifest = {
    "version": version, "frozen": True, "platform": sys.platform,
    "architecture": platform.machine(), "revision": revision,
    "source_sha256": digest.hexdigest(), "built_at": datetime.now(timezone.utc).isoformat(),
    "extensions": ["sandbox"], "python": platform.python_version(),
    "cloudflared": helper.build_metadata(TUNNEL_HELPER),
    "phone_power": {"sha256": hashlib.sha256(POWER_HELPER.read_bytes()).hexdigest(),
                    "identifier": "com.ive.desktop.phone-power", "minimum_macos": "13.5"},
}
(STAGING / "bundle-info.json").write_text(json.dumps(manifest, indent=2) + "\n")
datas.append((str(STAGING / "bundle-info.json"), "."))

a = Analysis(
    [str(BACKEND / "desktop_entry.py")],
    pathex=[str(BACKEND), str(ROOT), str(STAGING)],
    binaries=[(str(TUNNEL_HELPER), "tools")], datas=datas, hiddenimports=sorted(set(modules)),
    hookspath=[], hooksconfig={}, runtime_hooks=[],
    excludes=["tkinter", "pytest", "IPython", "matplotlib", "numpy", "pandas"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="ive-backend",
          debug=False, bootloader_ignore_signals=False, strip=False, upx=False,
          console=True, disable_windowed_traceback=False, target_arch=None,
          codesign_identity=None, entitlements_file=None, contents_directory="_internal")
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="ive-backend")
