"""Phone access: one-time pairing codes, owner-device credentials, PIN lock.

A terminal on the phone is full control of the Mac, so the flow is kept
small and strict:

* Pairing: the owner (on the Mac itself) asks for a pairing code. The code
  is random (40 bits), lives 5 minutes, is single use, only one code is
  active at a time, and it is burned after a few wrong guesses. Codes live
  in memory only, so a backend restart invalidates every open code.
* Credential: redeeming a code creates a `devices` row and a
  `joiner_sessions` row with actor_kind='owner_device'. The opaque cookie
  value is returned once (only its SHA-256 is stored), slides for 30 days
  of use and is capped at 90 days by joiner_sessions. Revoking the device
  revokes every session tied to it.
* Re-auth: WebAuthn/passkeys are not usable here (LAN is plain http, so no
  secure context; quick-tunnel hostnames change on every start, so a
  passkey's RP ID would not survive). Instead the owner can set a PIN on
  the Mac. With a PIN set, a paired phone locks after N idle minutes
  (and after a backend restart) and must enter the PIN again; sensitive
  actions additionally require a PIN entered within the last 5 minutes.
  Too many wrong PINs revoke the device.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import db as _db
import joiner_sessions

PAIR_CODE_TTL_SECONDS = 300
PAIR_CODE_MAX_FAILURES = 5
DEVICE_SESSION_TTL_SECONDS = 30 * 86400
DEVICE_COOKIE_MAX_AGE = joiner_sessions.HARD_CAP_DAYS * 86400
DEFAULT_IDLE_MINUTES = 15
REAUTH_WINDOW_SECONDS = 300
PIN_MAX_FAILURES = 5
PIN_MIN_LEN = 6
PIN_MAX_LEN = 12

# Crockford base32 minus easily confused glyphs; 8 chars = 40 bits.
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_CODE_LEN = 8


def _now() -> float:
    return time.time()


def normalize_code(raw: str | None) -> str:
    """Uppercase, drop separators, map look-alikes (O→0, I/L→1)."""
    if not raw:
        return ""
    s = "".join(ch for ch in str(raw).upper() if ch.isalnum())
    return s.replace("O", "0").replace("I", "1").replace("L", "1")[:32]


def display_code(code: str) -> str:
    return f"{code[:4]}-{code[4:]}" if len(code) == _CODE_LEN else code


@dataclass
class _PendingCode:
    code: str
    expires_at: float
    failures: int = 0


class PairingCodes:
    """At most one live pairing code; single use; burned after failures."""

    def __init__(self) -> None:
        self._pending: _PendingCode | None = None

    def create(self, *, ttl: int = PAIR_CODE_TTL_SECONDS) -> tuple[str, float]:
        code = "".join(secrets.choice(_ALPHABET) for _ in range(_CODE_LEN))
        self._pending = _PendingCode(code=code, expires_at=_now() + ttl)
        return code, self._pending.expires_at

    def cancel(self) -> None:
        self._pending = None

    def active(self) -> dict | None:
        p = self._pending
        if p is None or _now() >= p.expires_at:
            return None
        return {"expires_at": p.expires_at}

    def consume(self, raw: str | None) -> bool:
        """True exactly once for the live code. Wrong guesses count against it."""
        p = self._pending
        if p is None:
            return False
        if _now() >= p.expires_at:
            self._pending = None
            return False
        guess = normalize_code(raw)
        if guess and hmac.compare_digest(guess.encode(), p.code.encode()):
            self._pending = None
            return True
        p.failures += 1
        if p.failures >= PAIR_CODE_MAX_FAILURES:
            self._pending = None
        return False


codes = PairingCodes()


def device_label_from_ua(user_agent: str | None) -> str:
    ua = user_agent or ""
    if "iPhone" in ua:
        return "iPhone"
    if "iPad" in ua:
        return "iPad"
    if "Android" in ua:
        return "Android phone"
    return "Phone"


async def complete_pairing(
    *,
    code: str,
    label: str | None,
    user_agent: str | None,
    remote_ip: str | None,
) -> tuple[str, dict, joiner_sessions.JoinerSession] | None:
    """Redeem a pairing code. Returns (cookie_value, device, session) or None."""
    if not codes.consume(code):
        return None
    clean_label = (label or "").strip()[:60] or device_label_from_ua(user_agent)
    device_id = str(uuid.uuid4())
    # The devices table predates code pairing and expects an Ed25519 key.
    # Code-paired phones authenticate with their session cookie instead, so
    # store a marker and a unique, non-key fingerprint.
    fingerprint = hashlib.sha256(f"code-paired:{device_id}".encode()).hexdigest()
    conn = await _db.get_db()
    try:
        await conn.execute(
            """INSERT INTO devices (id, label, public_key, fingerprint, user_agent)
               VALUES (?, ?, ?, ?, ?)""",
            (device_id, clean_label, "code-paired", fingerprint, user_agent),
        )
        await conn.commit()
        cur = await conn.execute("SELECT * FROM devices WHERE id = ?", (device_id,))
        device = dict(await cur.fetchone())
    finally:
        await conn.close()
    cookie, sess = await joiner_sessions.create_session(
        mode="full",
        actor_kind="owner_device",
        ttl_seconds=DEVICE_SESSION_TTL_SECONDS,
        label=clean_label,
        device_id=device_id,
        last_ip=remote_ip,
        last_user_agent=user_agent,
    )
    lock.mark_unlocked(sess.id)
    return cookie, device, sess


async def list_devices() -> list[dict]:
    """Active (non-revoked) devices with their latest session activity."""
    conn = await _db.get_db()
    try:
        cur = await conn.execute(
            """SELECT d.id, d.label, d.user_agent, d.paired_at, d.last_seen_at,
                      d.public_key = 'code-paired' AS code_paired,
                      (SELECT MAX(js.last_used_at) FROM joiner_sessions js
                        WHERE js.device_id = d.id AND js.revoked_at IS NULL) AS last_used_at,
                      (SELECT MAX(js.last_ip) FROM joiner_sessions js
                        WHERE js.device_id = d.id AND js.revoked_at IS NULL) AS last_ip
                 FROM devices d
                WHERE d.revoked_at IS NULL
                ORDER BY d.paired_at DESC"""
        )
        rows = [dict(r) for r in await cur.fetchall()]
    finally:
        await conn.close()
    return rows


async def device_session_ids(device_id: str) -> list[str]:
    conn = await _db.get_db()
    try:
        cur = await conn.execute(
            "SELECT id FROM joiner_sessions WHERE device_id = ?", (device_id,)
        )
        return [r["id"] for r in await cur.fetchall()]
    finally:
        await conn.close()


async def revoke_device(device_id: str) -> tuple[bool, list[str]]:
    """Revoke a device, its sessions, its push subscriptions and APNs token.

    Returns (revoked, session_ids) so the caller can close live sockets.
    """
    import devices as _devices

    session_ids = await device_session_ids(device_id)
    revoked = await _devices.revoke_device(device_id)
    if session_ids:
        conn = await _db.get_db()
        try:
            marks = ",".join("?" for _ in session_ids)
            await conn.execute(
                f"DELETE FROM push_subscriptions WHERE actor_id IN ({marks})",
                tuple(session_ids),
            )
            await conn.commit()
        finally:
            await conn.close()
    for sid in session_ids:
        lock.forget(sid)
    try:
        import apns
        apns.remove_token(device_id)
    except Exception:
        pass
    return revoked, session_ids


# ─── PIN lock ──────────────────────────────────────────────────────────


def _lock_path() -> Path:
    return Path(_db.DATA_DIR) / "phone_lock.json"


def _hash_pin(pin: str, salt: bytes) -> str:
    return hashlib.scrypt(
        pin.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32
    ).hex()


def validate_pin(pin: str | None) -> str:
    pin = (pin or "").strip()
    if not pin.isdigit() or not (PIN_MIN_LEN <= len(pin) <= PIN_MAX_LEN):
        raise ValueError(f"PIN must be {PIN_MIN_LEN} to {PIN_MAX_LEN} digits")
    if len(set(pin)) == 1 or pin in "0123456789012345" or pin in "9876543210987654":
        raise ValueError("PIN is too easy to guess")
    return pin


class PhoneLock:
    """PIN config on disk (0600, scrypt) + per-session lock state in memory.

    Memory-only lock state means a backend restart locks every phone,
    which is the safe direction.
    """

    def __init__(self) -> None:
        self._cache: dict | None = None
        self._last_active: dict[str, float] = {}
        self._unlocked_at: dict[str, float] = {}
        self._failures: dict[str, int] = {}

    # config ------------------------------------------------------------
    def _config(self) -> dict:
        if self._cache is None:
            try:
                self._cache = json.loads(_lock_path().read_text())
            except (OSError, ValueError):
                self._cache = {}
        return self._cache

    def reload(self) -> None:
        self._cache = None

    def pin_enabled(self) -> bool:
        cfg = self._config()
        return bool(cfg.get("pin_hash") and cfg.get("salt"))

    def idle_seconds(self) -> int:
        try:
            minutes = int(self._config().get("idle_minutes") or DEFAULT_IDLE_MINUTES)
        except (TypeError, ValueError):
            minutes = DEFAULT_IDLE_MINUTES
        return max(1, min(minutes, 24 * 60)) * 60

    def set_pin(self, pin: str, *, idle_minutes: int | None = None) -> None:
        pin = validate_pin(pin)
        minutes = int(idle_minutes or DEFAULT_IDLE_MINUTES)
        if not 1 <= minutes <= 24 * 60:
            raise ValueError("idle_minutes must be between 1 and 1440")
        salt = secrets.token_bytes(16)
        data = {"pin_hash": _hash_pin(pin, salt), "salt": salt.hex(), "idle_minutes": minutes}
        path = _lock_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        os.replace(tmp, path)
        self._cache = data
        # A new PIN locks every phone once.
        self._unlocked_at.clear()
        self._failures.clear()

    def clear_pin(self) -> None:
        try:
            _lock_path().unlink()
        except FileNotFoundError:
            pass
        self._cache = {}
        self._failures.clear()

    def check_pin(self, pin: str | None) -> bool:
        cfg = self._config()
        if not self.pin_enabled():
            return False
        try:
            salt = bytes.fromhex(cfg["salt"])
        except (KeyError, ValueError):
            return False
        candidate = _hash_pin((pin or "").strip(), salt)
        return hmac.compare_digest(candidate, cfg["pin_hash"])

    # session state -----------------------------------------------------
    def mark_unlocked(self, session_id: str) -> None:
        now = _now()
        self._unlocked_at[session_id] = now
        self._last_active[session_id] = now
        self._failures.pop(session_id, None)

    def lock_now(self, session_id: str) -> None:
        self._unlocked_at.pop(session_id, None)
        self._last_active.pop(session_id, None)

    def forget(self, session_id: str) -> None:
        self.lock_now(session_id)
        self._failures.pop(session_id, None)

    def is_locked(self, session_id: str | None) -> bool:
        if not self.pin_enabled():
            return False
        if not session_id or session_id not in self._unlocked_at:
            return True
        last = self._last_active.get(session_id, 0.0)
        return _now() - last > self.idle_seconds()

    def touch(self, session_id: str | None) -> None:
        if session_id:
            self._last_active[session_id] = _now()

    def needs_reauth(self, session_id: str | None) -> bool:
        if not self.pin_enabled():
            return False
        unlocked = self._unlocked_at.get(session_id or "")
        return unlocked is None or _now() - unlocked > REAUTH_WINDOW_SECONDS

    def register_failure(self, session_id: str) -> int:
        """Count a wrong PIN; returns attempts left (0 → revoke the device)."""
        n = self._failures.get(session_id, 0) + 1
        self._failures[session_id] = n
        return max(0, PIN_MAX_FAILURES - n)

    def state(self, session_id: str | None) -> dict:
        return {
            "pin_enabled": self.pin_enabled(),
            "idle_minutes": self.idle_seconds() // 60,
            "locked": self.is_locked(session_id),
        }


lock = PhoneLock()


def iso_from_epoch(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).replace(microsecond=0).isoformat()
