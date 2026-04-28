"""Owner device pairing — Ed25519 challenge/response.

Pair-init (owner-authenticated):
    Body: { label, public_key }   public_key is base64url of raw 32 bytes.
    Returns: { device_id, fingerprint, challenge_nonce, expires_at }.
    Records the device row and issues a 5-minute challenge.

Pair-complete (unauth, rate-limited):
    Body: { device_id, signed_nonce }   signed_nonce is base64url of the
    Ed25519 signature over the raw nonce bytes.
    Returns: { session_token (cookie set), mode='full', expires_at }.
    Mints an owner-equivalent joiner_sessions row tied to this device.

Re-auth (joiner device wants a new bearer):
    GET /api/devices/{id}/challenge → fresh nonce.
    POST /api/devices/pair-complete → mints another session.

Revoke device (owner): sets devices.revoked_at AND revokes any
joiner_sessions whose device_id matches.
"""
from __future__ import annotations

import base64
import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from db import get_db

CHALLENGE_TTL_SECONDS = 300  # 5 minutes
DEVICE_BEARER_TTL_SECONDS = 86400  # 24 hours per challenge sign


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(d: datetime) -> str:
    return d.replace(microsecond=0).strftime("%Y-%m-%d %H:%M:%S")


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    s = s.replace("T", " ").replace("Z", "")
    try:
        return datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


@dataclass
class Device:
    id: str
    label: str
    public_key: str
    fingerprint: str
    user_agent: str | None
    paired_at: str
    last_seen_at: str
    revoked_at: str | None


def fingerprint_for(public_key_b64url: str) -> str:
    return hashlib.sha256(_b64url_decode(public_key_b64url)).hexdigest()


async def pair_init(
    *,
    label: str,
    public_key_b64url: str,
    user_agent: str | None = None,
) -> tuple[Device, str, datetime]:
    """Register a device pubkey + issue a fresh challenge nonce.

    If a device row already exists for this fingerprint and is not
    revoked, returns it (idempotent re-pair). If revoked, raises
    PermissionError. Otherwise creates a new row.

    Returns (device, challenge_nonce_b64url, expires_at).
    """
    raw = _b64url_decode(public_key_b64url)
    if len(raw) != 32:
        raise ValueError("public_key must decode to 32 raw Ed25519 bytes")
    # Validate by attempting to load it.
    try:
        Ed25519PublicKey.from_public_bytes(raw)
    except Exception as e:
        raise ValueError(f"invalid Ed25519 public key: {e}") from e

    fp = fingerprint_for(public_key_b64url)
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT * FROM devices WHERE fingerprint = ?", (fp,)
        )
        existing = await cur.fetchone()
        if existing:
            existing = dict(existing)
            if existing.get("revoked_at"):
                raise PermissionError("device fingerprint is revoked; pick a new key")
            device_id = existing["id"]
            await db.execute(
                "UPDATE devices SET last_seen_at = ?, label = COALESCE(?, label), user_agent = COALESCE(?, user_agent) WHERE id = ?",
                (_iso(_now()), label or None, user_agent, device_id),
            )
        else:
            device_id = str(uuid.uuid4())
            await db.execute(
                """INSERT INTO devices
                   (id, label, public_key, fingerprint, user_agent)
                   VALUES (?, ?, ?, ?, ?)""",
                (device_id, label, public_key_b64url, fp, user_agent),
            )

        # Issue a fresh challenge.
        nonce_bytes = secrets.token_bytes(32)
        nonce = _b64url_encode(nonce_bytes)
        expires = _now() + timedelta(seconds=CHALLENGE_TTL_SECONDS)
        await db.execute(
            """INSERT INTO device_challenges (nonce, device_id, expires_at)
               VALUES (?, ?, ?)""",
            (nonce, device_id, _iso(expires)),
        )
        await db.commit()

        cur = await db.execute("SELECT * FROM devices WHERE id = ?", (device_id,))
        row = dict(await cur.fetchone())
    finally:
        await db.close()

    return _row_to_device(row), nonce, expires


async def issue_challenge(device_id: str) -> tuple[str, datetime]:
    """Issue a fresh challenge for an already-paired (non-revoked) device."""
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT id, revoked_at FROM devices WHERE id = ?", (device_id,)
        )
        row = await cur.fetchone()
        if row is None:
            raise LookupError("device not found")
        row = dict(row)
        if row.get("revoked_at"):
            raise PermissionError("device is revoked")

        nonce_bytes = secrets.token_bytes(32)
        nonce = _b64url_encode(nonce_bytes)
        expires = _now() + timedelta(seconds=CHALLENGE_TTL_SECONDS)
        await db.execute(
            """INSERT INTO device_challenges (nonce, device_id, expires_at)
               VALUES (?, ?, ?)""",
            (nonce, device_id, _iso(expires)),
        )
        await db.commit()
    finally:
        await db.close()
    return nonce, expires


async def pair_complete(
    *,
    device_id: str,
    nonce: str,
    signed_nonce_b64url: str,
) -> Device:
    """Verify the Ed25519 signature against the stored challenge.

    Atomically consumes the challenge (single-use) — concurrent attempts
    lose. Returns the Device on success. Raises:
      LookupError → device or challenge missing
      PermissionError → device revoked, challenge expired or already
                        consumed, or signature invalid.
    """
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT * FROM devices WHERE id = ?", (device_id,)
        )
        drow = await cur.fetchone()
        if drow is None:
            raise LookupError("device not found")
        drow = dict(drow)
        if drow.get("revoked_at"):
            raise PermissionError("device is revoked")

        # Atomic single-use consume of the challenge.
        cur = await db.execute(
            """UPDATE device_challenges
                  SET consumed_at = ?
                WHERE nonce = ?
                  AND device_id = ?
                  AND consumed_at IS NULL
                  AND expires_at > ?""",
            (_iso(_now()), nonce, device_id, _iso(_now())),
        )
        await db.commit()
        if cur.rowcount == 0:
            raise PermissionError("challenge expired, missing, or already consumed")

        # Verify signature.
        try:
            pub = Ed25519PublicKey.from_public_bytes(_b64url_decode(drow["public_key"]))
            sig = _b64url_decode(signed_nonce_b64url)
            nonce_bytes = _b64url_decode(nonce)
            pub.verify(sig, nonce_bytes)
        except (InvalidSignature, ValueError) as e:
            raise PermissionError(f"signature verification failed: {e}") from e

        # Bump device last_seen_at on successful auth.
        await db.execute(
            "UPDATE devices SET last_seen_at = ? WHERE id = ?",
            (_iso(_now()), device_id),
        )
        await db.commit()

        cur = await db.execute("SELECT * FROM devices WHERE id = ?", (device_id,))
        drow = dict(await cur.fetchone())
    finally:
        await db.close()
    return _row_to_device(drow)


def _row_to_device(row: dict) -> Device:
    return Device(
        id=row["id"],
        label=row["label"],
        public_key=row["public_key"],
        fingerprint=row["fingerprint"],
        user_agent=row.get("user_agent"),
        paired_at=row.get("paired_at") or "",
        last_seen_at=row.get("last_seen_at") or "",
        revoked_at=row.get("revoked_at"),
    )


async def list_devices() -> list[dict]:
    """List all (active + revoked) devices for the owner UI."""
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT id, label, fingerprint, user_agent,
                      paired_at, last_seen_at, revoked_at
                 FROM devices
                ORDER BY paired_at DESC"""
        )
        rows = await cur.fetchall()
    finally:
        await db.close()
    return [dict(r) for r in rows]


async def revoke_device(device_id: str) -> bool:
    """Mark device revoked and revoke any tied joiner_sessions."""
    db = await get_db()
    try:
        cur = await db.execute(
            """UPDATE devices SET revoked_at = ?
                WHERE id = ? AND revoked_at IS NULL""",
            (_iso(_now()), device_id),
        )
        await db.commit()
        if cur.rowcount == 0:
            return False
        # Cascade-revoke any joiner_sessions for this device.
        await db.execute(
            """UPDATE joiner_sessions SET revoked_at = ?
                WHERE device_id = ? AND revoked_at IS NULL""",
            (_iso(_now()), device_id),
        )
        await db.commit()
    finally:
        await db.close()
    return True


async def cleanup_expired_challenges() -> int:
    """Reap challenges that have expired or been consumed >1h ago."""
    cutoff = _iso(_now() - timedelta(hours=1))
    db = await get_db()
    try:
        cur = await db.execute(
            """DELETE FROM device_challenges
                WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)""",
            (_iso(_now()), cutoff),
        )
        await db.commit()
        return cur.rowcount
    finally:
        await db.close()
