#!/usr/bin/env python3
"""Compile only. Never registers a daemon or modifies system power settings.

Copy the output binary to Contents/MacOS/ive-phone-power and the plist to
Contents/Library/LaunchDaemons before signing the containing IVE app.
The helper's Developer ID signing identifier must stay com.ive.desktop.phone-power.
"""
import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tests", action="store_true")
    parser.add_argument("--bundle-tests", action="store_true")
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    args.output.mkdir(parents=True, exist_ok=True)
    testing = args.tests or args.bundle_tests
    output = args.output / ("phone-power-bundle-tests" if args.bundle_tests else "phone-power-policy-tests" if args.tests else "ive-phone-power")
    main_source = "BundleValidationTests.swift" if args.bundle_tests else "PolicyTests.swift" if args.tests else "Native.swift"
    files = [source / "Policy.swift", source / "BundleValidation.swift", source / main_source]
    command = ["/usr/bin/xcrun", "swiftc", "-target", "arm64-apple-macos13.5", "-O",
               "-parse-as-library", *map(str, files), "-o", str(output)]
    subprocess.run(command, check=True)
    if testing:
        subprocess.run([str(output)], check=True)
    else:
        # Ad-hoc signature is a build input for Developer ID/cloud export, not
        # a usable privileged installation. Runtime rejects an ad-hoc client.
        subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", "--options", "runtime",
                        "--identifier", "com.ive.desktop.phone-power", str(output)], check=True)
    print(json.dumps({"binary": str(output.resolve()), "plist": str(source / "com.ive.desktop.phone-power.plist"),
                      "minimum_macos": "13.5", "registered": False, "system_power_changed": False}))


if __name__ == "__main__":
    main()
