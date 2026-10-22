#!/usr/bin/env python3
"""Read-only invocation guards against an explicitly ad-hoc test build.

Refuses a release-signed binary. Does not register a service or execute a power
operation: every request must fail before reaching those branches.
"""
import argparse
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve()
    signature = subprocess.run(["/usr/bin/codesign", "-dv", str(binary)], capture_output=True, text=True, check=True)
    if "Signature=adhoc" not in signature.stderr:
        raise SystemExit("Guard probes require an ad-hoc test build; refusing signed release")
    reports = []

    def rejected(executable, payload, expected):
        result = subprocess.run([str(executable)], input=json.dumps(payload), capture_output=True, text=True, timeout=10)
        response = json.loads(result.stdout)
        assert result.returncode == 1 and response.get("ok") is False and response.get("reason") == expected, response
        reports.append({"action": payload["action"], "reason": expected})

    for action in ["status", "start", "register"]:
        rejected(binary, {"action": action, "app_pid": 123, "allow_battery": True}, "helper_not_in_app_bundle")
    result = subprocess.run([str(binary), "--daemon"], capture_output=True, timeout=10)
    assert result.returncode == 77
    reports.append({"action": "daemon_as_user", "exit": 77})
    with tempfile.TemporaryDirectory(prefix="guards-", dir=binary.parent) as temporary:
        app = Path(temporary) / "IVE.app"
        contents = app / "Contents"
        macos = contents / "MacOS"
        macos.mkdir(parents=True)
        (contents / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": "com.ive.desktop", "CFBundleExecutable": "ive", "CFBundlePackageType": "APPL",
        }))
        tool = macos / "ive-phone-power"
        shutil.copy2(binary, tool)
        for action in ["status", "start", "register", "open-settings", "unregister"]:
            rejected(tool, {"action": action, "app_pid": 123, "allow_battery": True}, "untrusted_process")
    print(json.dumps({"checks": reports, "count": len(reports), "registered": False, "system_power_changed": False}, indent=2))


if __name__ == "__main__":
    main()
