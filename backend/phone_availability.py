"""Narrow, local bridge to the signed macOS phone-availability helper.

Lease credentials stay in this process. HTTP clients only receive sanitized
status. There is no shell, configurable executable, or arbitrary root command.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time

MAX_DURATION = 8 * 60 * 60
BATTERY_FLOOR = 20
_VISIBLE = {"battery_percent", "battery_floor", "expires_at", "last_verified_at",
            "allow_battery", "reason", "message", "approval_required", "on_battery",
            "service_status", "bundle_verified"}
_VISIBLE.update({"protocol_version", "lid_saver_supported", "lid_closed", "lid_saver_active",
                 "low_power_active", "lid_low_power", "pause_apps", "paused_processes"})
PAUSE_APPS = {"com.tinyspeck.slackmacgap", "com.hnc.Discord", "net.whatsapp.WhatsApp", "com.spotify.client"}
_MESSAGES = {
    "macos_helper_approval_required": "Approve the IVE background helper in macOS, then choose Continue after approval.",
    "macos_helper_not_registered": "Complete the one-time Mac helper setup to enable closed-lid availability.",
    "battery_cutoff": "Availability ended because the battery reached 20%.",
    "thermal_cutoff": "Availability ended because this Mac is too warm.",
    "battery_not_allowed": "Connect the power adapter or explicitly allow battery use in Review permissions.",
    "sleep_already_disabled_elsewhere": "Another app or system setting already prevents sleep. Restore normal sleep there before enabling IVE availability.",
    "duration_ended": "The timer has ended. Normal sleep behavior is restored.",
    "heartbeat_expired": "The connection to IVE stopped. Normal sleep behavior is restored.",
    "app_exited": "IVE stopped. Normal sleep behavior is restored.",
    "helper_restarted": "The helper restarted and restored normal sleep behavior.",
    "restore_failed": "Normal sleep could not be verified. Keep the lid open and check the Mac before leaving it unattended.",
    "recovery_journal_unreadable": "The helper could not verify a previous availability session. Keep the lid open and check Mac sleep settings.",
    "untrusted_process": "The Mac helper could not verify IVE's signature. Use the signed app in Applications.",
    "helper_connection_failed": "The approved Mac helper could not be reached. Check its background-item approval and retry.",
    "not_found": "The Mac helper is missing. Install the latest IVE Mac app.",
}


def helper_path() -> Path | None:
    if sys.platform != "darwin" or not getattr(sys, "frozen", False) or not os.getenv("IVE_DESKTOP_INSTANCE"):
        return None
    for parent in Path(sys.executable).resolve().parents:
        if parent.suffix == ".app":
            path = parent / "Contents/MacOS/ive-phone-power"
            return path if path.is_file() and os.access(path, os.X_OK) else None
    return None


class PhoneAvailability:
    def __init__(self, *, connected, helper=None, caller=None):
        self.connected = connected
        self.helper = helper if helper is not None else helper_path()
        self.caller = caller or self._call
        self.app_pid = os.getppid()
        self.lease = None
        self.task = None
        self.lock = asyncio.Lock()
        self.last = {"state": "unavailable", "battery_floor": BATTERY_FLOOR}
        self.last_check = float("-inf")
        self.revision = 0
        self.purpose = None
        self.options = None

    async def _call(self, payload):
        if self.helper is None:
            return {"ok": False, "status": "unavailable", "message": "Install the latest IVE Mac app to use closed-lid availability."}
        proc = await asyncio.create_subprocess_exec(
            str(self.helper), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(json.dumps(payload).encode() + b"\n"), 25)
        except BaseException:
            if proc.returncode is None:
                proc.kill()
            await proc.wait()
            raise
        if len(out) > 65536:
            raise RuntimeError("The Mac availability helper returned an invalid response.")
        try:
            result = json.loads(out)
        except (ValueError, TypeError):
            raise RuntimeError("The Mac availability helper did not respond. Review macOS approval, then try again.") from None
        if not isinstance(result, dict):
            raise RuntimeError("The Mac availability helper returned an invalid response.")
        return result

    def _remember(self, result):
        self.revision += 1
        phase = result.get("status", result.get("state", "blocked"))
        if phase == "active" and result.get("ok") is not True:
            phase = "blocked"
        self.last = {"state": phase, "battery_floor": BATTERY_FLOOR,
                     **{k: v for k, v in result.items() if k in _VISIBLE}}
        if self.purpose and phase in {"active", "restoring", "restore_failed"}:
            self.last["mode_source"] = self.purpose
        for key in ("expires_at", "last_verified_at"):
            value = self.last.get(key)
            if type(value) in (int, float):
                try:
                    self.last[key] = datetime.fromtimestamp(value, timezone.utc).isoformat()
                except (ValueError, OverflowError, OSError):
                    self.last.pop(key, None)
        reason = self.last.get("reason")
        if reason and not self.last.get("message"):
            self.last["message"] = _MESSAGES.get(reason, f"Mac availability needs attention ({str(reason).replace('_', ' ')}).")
        self.last_check = time.monotonic()
        return dict(self.last)

    async def status(self):
        if self.helper is None:
            return dict(self.last)
        if time.monotonic() - self.last_check < 2:
            return dict(self.last)
        revision = self.revision
        try:
            result = await self.caller({"action": "status", "app_pid": self.app_pid})
        except Exception:
            result = {"state": "blocked", "battery_floor": BATTERY_FLOOR,
                      "message": "Could not verify Mac availability. Keep the lid open until the helper is available again."}
        # A slow read must never undo an acknowledged lifecycle change, even
        # when it fails. Do not lock this IPC: Stop must remain able to proceed
        # while a status helper is slow or unavailable.
        if revision != self.revision:
            return dict(self.last)
        return self._remember(result)

    async def start(self, *, allow_battery, duration_seconds=MAX_DURATION,
                    purpose="phone", lid_low_power=False, pause_apps=None):
        pause_apps = [] if pause_apps is None else pause_apps
        if (type(allow_battery) is not bool or type(lid_low_power) is not bool
                or type(duration_seconds) is not int or not 60 <= duration_seconds <= MAX_DURATION
                or purpose not in {"phone", "agent"} or not isinstance(pause_apps, list)
                or any(type(app) is not str or app not in PAUSE_APPS for app in pause_apps)
                or len(pause_apps) != len(set(pause_apps))):
            raise ValueError("Choose a timer between 1 minute and 8 hours and supported battery/app options.")
        options = (purpose, allow_battery, duration_seconds, lid_low_power, tuple(sorted(pause_apps)))
        async with self.lock:
            self.revision += 1
            if self.lease:
                if self.options == options:
                    return await self.status()
                if self.purpose != "phone" or purpose != "phone":
                    raise ValueError("A Mac power session is already running. Stop it before changing modes.")
                await self._cancel_heartbeat()
                result = await self._stop_lease()
                if result["state"] not in {"ready", "stopped"}:
                    raise RuntimeError("Restore normal sleep before changing battery availability.")
            if purpose == "phone" and not self.connected():
                raise ValueError("Start the secure iPhone connection before keeping this Mac available.")
            status = await self.caller({"action": "status", "app_pid": self.app_pid})
            if (lid_low_power or pause_apps) and status.get("lid_saver_supported") is not True:
                raise RuntimeError("Update the IVE Mac app to use lid-triggered power saving.")
            if status.get("status") == "needs_approval":
                return self._remember(status)
            if status.get("status") in {"not_registered", "unregistered"}:
                status = await self.caller({"action": "register", "app_pid": self.app_pid})
                if status.get("ok") is not True or status.get("status") != "ready":
                    return self._remember(status)
            payload = {"action": "start", "app_pid": self.app_pid,
                       "duration_seconds": duration_seconds, "allow_battery": allow_battery}
            if lid_low_power or pause_apps:
                payload.update(lid_low_power=lid_low_power, pause_apps=pause_apps)
            try:
                result = await self.caller(payload)
            except Exception:
                self._remember({"state": "restoring", "message": "Start could not be confirmed. Check status before retrying; the helper restores an unrenewed session automatically."})
                raise
            view = self._remember(result)
            if result.get("ok") is True and result.get("status") == "active" and isinstance(result.get("lease_id"), str) and result["lease_id"]:
                self.lease = result["lease_id"]
                self.purpose = purpose
                self.options = options
                self.last["mode_source"] = purpose
                view = dict(self.last)
                self.task = asyncio.create_task(self._heartbeat())
            else:
                if view["state"] == "active":
                    self.last = {"state": "blocked", "battery_floor": BATTERY_FLOOR,
                                 "message": "The helper did not return a valid availability lease."}
                raise RuntimeError(self.last.get("message") or "Mac availability could not start.")
            return view

    async def open_approval(self):
        return self._remember(await self.caller({"action": "open-settings", "app_pid": self.app_pid}))

    async def _heartbeat(self):
        try:
            while self.lease:
                await asyncio.sleep(10)
                if self.purpose == "phone" and not self.connected():
                    await self._stop_lease()
                    return
                result = await self.caller({"action": "renew", "lease_id": self.lease, "app_pid": self.app_pid})
                self._remember(result)
                if not result.get("ok") or result.get("status") != "active":
                    if result.get("status") in {"ready", "stopped"}:
                        self.lease = None
                    else:
                        await self._stop_lease()
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            # The independent privileged helper expires an unrenewed lease.
            self.lease = None
            self._remember({"state": "restoring", "battery_floor": BATTERY_FLOOR,
                            "message": "Connection to the availability helper was lost. Its safety timeout restores normal sleep."})

    async def _stop_lease(self):
        self.revision += 1
        lease = self.lease
        if lease:
            try:
                view = self._remember(await self.caller({"action": "stop", "lease_id": lease, "app_pid": self.app_pid}))
                if view["state"] in {"ready", "stopped"}:
                    self.lease = None
                    self.purpose = None
                    self.options = None
                return view
            except Exception:
                self._remember({"state": "restoring", "battery_floor": BATTERY_FLOOR,
                                "message": "Waiting for the helper's safety timeout to restore normal sleep."})
        return dict(self.last)

    async def stop_phone(self):
        if self.purpose == "agent":
            return {"state": "ready"}
        return await self.stop()

    async def stop(self):
        async with self.lock:
            self.revision += 1
            await self._cancel_heartbeat()
            return await self._stop_lease()

    async def _cancel_heartbeat(self):
        task, self.task = self.task, None
        if task and task is not asyncio.current_task():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def close(self):
        await self.stop()
