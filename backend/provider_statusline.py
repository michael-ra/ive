"""Capture only Claude's official quota fields; preserve a custom status line."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time


def configure(args, env, session_id, cwd):
    args = list(args)
    budget_settings = {}
    # UnifiedSession's launch-only compaction override must share one
    # --settings object with this status line. Two flags can replace each
    # other, and skipping the wrapper would lose quota telemetry.
    if '--settings' in args:
        index = args.index('--settings')
        if index + 1 < len(args) and args[index + 1] == '{"autoCompactEnabled":true}':
            budget_settings = {'autoCompactEnabled': True}
            del args[index:index + 2]
    # An explicit --settings already owns precedence; never discard its settings.
    if any(arg == "--settings" or arg.startswith("--settings=") for arg in args):
        return args
    from provider_limits import snapshot_path
    from helper_command import helper_command
    home = env.get("HOME") or os.path.expanduser("~")
    config_dir = Path(env.get("CLAUDE_CONFIG_DIR") or Path(home) / ".claude")
    original = None
    for path in (config_dir / "settings.json", Path(cwd) / ".claude/settings.json", Path(cwd) / ".claude/settings.local.json"):
        try:
            settings = json.loads(path.read_text())
            if "statusLine" in settings:
                original = settings["statusLine"]
        except (OSError, ValueError, TypeError):
            pass
    env["IVE_PROVIDER_LIMITS_FILE"] = str(snapshot_path(session_id))
    env.pop("IVE_STATUSLINE_ORIGINAL", None)
    if isinstance(original, dict) and original.get("type") == "command" and original.get("command"):
        env["IVE_STATUSLINE_ORIGINAL"] = original["command"]
    settings = {**budget_settings, "statusLine": {"type": "command", "command": shlex.join(helper_command("provider-statusline"))}}
    return [*args, "--settings", json.dumps(settings)]


def main():
    raw = sys.stdin.read(1024 * 1024)
    try:
        from provider_limits import claude_windows
        payload = json.loads(raw)
        windows = claude_windows(payload)
        rates = {}
        for item in windows:
            key = "five_hour" if item["window_minutes"] == 300 else "seven_day"
            rates[key] = {"used_percentage": item["used_percent"], "resets_at": item["resets_at"]}
        target = os.environ.get("IVE_PROVIDER_LIMITS_FILE")
        if target:
            path = Path(target)
            path.parent.mkdir(parents=True, exist_ok=True)
            data = {"rate_limits": rates, "updated_at": time.time(), "scope": os.environ.get("IVE_PROVIDER_LIMITS_SCOPE", "host")}
            with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as handle:
                json.dump(data, handle)
                temporary = handle.name
            os.replace(temporary, path)
    except (OSError, ValueError, TypeError):
        windows = []
    original = os.environ.get("IVE_STATUSLINE_ORIGINAL")
    if original:
        try:
            subprocess.run(original, shell=True, input=raw, text=True, timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            pass
    elif windows:
        print(" | ".join(f"{item['label']}: {item['remaining_percent']:g}% left" for item in windows))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
