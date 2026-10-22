"""Preflight: prove that every home/state path IVE resolves lies in the sandbox.

Run by e2e/run.mjs with the exact sandbox environment the backend will get,
BEFORE the backend is started. Imports modules only (no server start, no
writes) and prints a JSON report. Exit code 0 = isolated, 3 = leak found.

usage: python isolation_check.py <sandbox_root> <real_home> <backend_dir>
"""
import json
import os
import sys
from pathlib import Path

sandbox, real_home, backend = (Path(p).resolve() for p in sys.argv[1:4])
sys.path.insert(0, str(backend))
sys.path.insert(0, str(backend.parent / "extensions" / "sandbox" / "backend"))

checks = {}
problems = []


def record(name, value):
    if value is None or value == "":
        checks[name] = None
        return
    path = Path(str(value)).expanduser().resolve(strict=False)
    checks[name] = str(path)
    inside = path == sandbox or sandbox in path.parents
    if not inside:
        problems.append(f"{name} -> {path} is outside the sandbox")
    if path == real_home or real_home in path.parents:
        problems.append(f"{name} -> {path} is inside the REAL home")


env_home = os.environ.get("HOME")
record("env:HOME", env_home)
record("Path.home()", Path.home())
record("expanduser(~)", os.path.expanduser("~"))
record("env:IVE_DATA_DIR", os.environ.get("IVE_DATA_DIR"))
record("env:TMPDIR", os.environ.get("TMPDIR"))
record("env:IVE_APP_CONTAINER_STATE", os.environ.get("IVE_APP_CONTAINER_STATE"))

import config  # noqa: E402

for attr in ("DATA_DIR", "DB_PATH", "ATTACHMENTS_DIR", "ACCOUNT_HOMES_DIR", "HOOKS_DIR",
             "PLUGINS_DIR", "CLAUDE_HOME"):
    record(f"config.{attr}", getattr(config, attr))
checks["config.PORT"] = config.PORT
checks["config.HOST"] = config.HOST
checks["config.IVE_BASE_URL"] = config.IVE_BASE_URL

import hook_installer  # noqa: E402

for attr in ("HOOK_SCRIPT_PATH", "CLAUDE_SETTINGS", "GEMINI_SETTINGS", "CODEX_SETTINGS"):
    record(f"hook_installer.{attr}", getattr(hook_installer, attr))
from cli_profiles import PROFILES  # noqa: E402

for pid, profile in PROFILES.items():
    for field in ("home_dir", "settings_file", "hook_settings_file", "mcp_config_file", "plugin_cache_dir"):
        value = getattr(profile, field, "")
        if value:
            record(f"profile[{pid}].{field}", os.path.expanduser(value))
    try:
        record(f"hook_installer.settings_path[{pid}]", hook_installer._settings_path_for(profile))
    except Exception as exc:  # pragma: no cover - reported, not fatal
        checks[f"hook_installer.settings_path[{pid}]"] = f"error: {exc}"

import ive_cli_profile  # noqa: E402

record("ive_cli_profile._real_home()", ive_cli_profile._real_home())
for cli in ("claude", "gemini", "codex", "antigravity"):
    record(f"runtime_home_for_cli({cli})", ive_cli_profile.runtime_home_for_cli(cli))
    record(f"managed_home({cli})", ive_cli_profile.managed_home(cli))

import mcp_exit_log  # noqa: E402

record("mcp_exit_log._EXIT_LOG", mcp_exit_log._EXIT_LOG)
import crypto  # noqa: E402

record("crypto._KEY_FILE", crypto._KEY_FILE)
# The OS keychain must be unreachable so crypto falls back to the sandbox key file.
try:
    import keyring
    try:
        keyring.get_password("ive-e2e-probe", "probe")
        problems.append("keyring is reachable (PYTHON_KEYRING_BACKEND not effective)")
    except Exception as exc:
        checks["keyring"] = f"disabled ({type(exc).__name__})"
except ImportError:
    checks["keyring"] = "not installed"

import skill_installer  # noqa: E402

import shutil  # noqa: E402

for binary in ("claude", "gemini", "codex", "antigravity-cli", "security", "osascript", "open",
               "cloudflared", "rtk"):
    found = shutil.which(binary)
    checks[f"which:{binary}"] = found
    if found and binary in ("claude", "gemini", "codex", "security", "osascript", "open"):
        record(f"which:{binary}", found)
    elif found:
        problems.append(f"{binary} resolves to {found}; it must not be reachable in the sandbox")

port = int(os.environ.get("COMMANDER_PORT", "0"))
if port in (0, 5111, 5173, 5183):
    problems.append(f"refusing port {port}")
# Hook scripts default to :5111 (the real IVE) when these are unset.
for var in ("COMMANDER_API_URL", "IVE_API_URL", "IVE_BASE_URL"):
    api = os.environ.get(var, "")
    if not api.endswith(f":{port}"):
        problems.append(f"{var} {api!r} does not point at the sandbox port")

print(json.dumps({"isolated": not problems, "problems": problems, "checks": checks}, indent=2))
sys.exit(0 if not problems else 3)
