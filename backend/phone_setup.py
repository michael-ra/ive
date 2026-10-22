"""Explicit local consent for phone control and optional Mac availability.

This file records a choice, never an OS permission or a successful sleep
assertion. The live power controller is the authority for availability.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import tempfile

CONSENT_VERSION = 1


class PhoneSetup:
    def __init__(self, data_dir: Path):
        self.path = Path(data_dir) / "phone_setup.json"

    def read(self) -> dict:
        try:
            if self.path.is_symlink() or self.path.stat().st_size > 4096:
                return {}
            value = json.loads(self.path.read_text())
            if (not isinstance(value, dict) or type(value.get("consent_version")) is not int
                    or value.get("consent_version") != CONSENT_VERSION):
                return {}
            if value.get("remote_control") is not True:
                return {}
            if any(type(value.get(key)) is not bool for key in ("closed_lid", "allow_battery")):
                return {}
            if value["allow_battery"] and not value["closed_lid"]:
                return {}
            return value
        except (OSError, ValueError, TypeError):
            return {}

    def accept(self, value: dict) -> dict:
        if not isinstance(value, dict) or set(value) != {
            "consent_version", "remote_control", "closed_lid", "allow_battery",
        }:
            raise ValueError("Review the iPhone setup choices before continuing.")
        if type(value["consent_version"]) is not int or value["consent_version"] != CONSENT_VERSION:
            raise ValueError("Please review the current iPhone setup.")
        if value["remote_control"] is not True:
            raise ValueError("Allow paired phones to control your IVE sessions to continue.")
        if any(type(value[key]) is not bool for key in ("closed_lid", "allow_battery")):
            raise ValueError("Choose the Mac availability options explicitly.")
        if value["allow_battery"] and not value["closed_lid"]:
            raise ValueError("Battery availability requires the keep-awake option.")
        saved = {**value, "accepted_at": datetime.now(timezone.utc).isoformat()}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".phone-setup-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w") as output:
                json.dump(saved, output)
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
        return saved

    def status(self, *, desktop: bool) -> dict:
        saved = self.read()
        return {
            "consent_version": CONSENT_VERSION,
            "desktop": desktop,
            "required": desktop and not bool(saved),
            "accepted": bool(saved),
            "closed_lid_requested": saved.get("closed_lid", False),
            "allow_battery_requested": saved.get("allow_battery", False),
            "accepted_at": saved.get("accepted_at"),
        }
