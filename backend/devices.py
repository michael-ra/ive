"""Paired-device rows: revocation.

Devices are paired with a one-time code (phone_access.py, /api/phone/*).
The former Ed25519 challenge/response pairing (/api/devices/*) had no client
and was removed; the devices and device_challenges tables keep their schema.

Revoke device: sets devices.revoked_at AND revokes any joiner_sessions whose
device_id matches. phone_access.revoke_device adds push/APNs/socket cleanup.
"""
from __future__ import annotations

from datetime import datetime, timezone

from db import get_db


def _iso(d: datetime) -> str:
    # SQLite datetime('now') format, as used by every other devices column.
    return d.replace(microsecond=0).strftime("%Y-%m-%d %H:%M:%S")


async def revoke_device(device_id: str) -> bool:
    """Mark device revoked and revoke any tied joiner_sessions."""
    now = _iso(datetime.now(timezone.utc))
    db = await get_db()
    try:
        cur = await db.execute(
            """UPDATE devices SET revoked_at = ?
                WHERE id = ? AND revoked_at IS NULL""",
            (now, device_id),
        )
        await db.commit()
        if cur.rowcount == 0:
            return False
        # Cascade-revoke any joiner_sessions for this device.
        await db.execute(
            """UPDATE joiner_sessions SET revoked_at = ?
                WHERE device_id = ? AND revoked_at IS NULL""",
            (now, device_id),
        )
        await db.commit()
    finally:
        await db.close()
    return True
