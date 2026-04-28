"""Per-row joiner session storage.

A joiner session is one row in `joiner_sessions` representing an active
bearer/cookie. Three actor_kind values:
  • 'owner_legacy'  — bootstrapped from AUTH_TOKEN; owner-equivalent
  • 'owner_device'  — Ed25519-paired phone/browser (PR 2-future)
  • 'joiner_session'— minted by redeeming an invite

Sliding TTL: each authenticated request bumps `last_used_at` and
`expires_at = min(now + ttl_seconds, hard_cap_at)`. Once `expires_at`
passes or `revoked_at` is set, lookups return None and the cookie is
cleared.

PR 1 left invite redemption pass-through to the legacy AUTH_TOKEN
cookie; PR 2 routes the redeemer onto a real joiner_sessions row with
a fresh opaque cookie value, and the auth middleware accepts the
cookie via this module instead of via AUTH_TOKEN equality.
"""
from __future__ import annotations

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from db import get_db

# 90-day hard cap on a joiner_sessions row, regardless of TTL slides.
HARD_CAP_DAYS = 90


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(d: datetime) -> str:
    # Drop subseconds + tz suffix to match the 'datetime("now")' SQLite
    # default format used elsewhere in the schema.
    return d.replace(microsecond=0).strftime("%Y-%m-%d %H:%M:%S")


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    s = s.replace("T", " ").replace("Z", "")
    try:
        return datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _hash_cookie(cookie_value: str) -> str:
    return hashlib.sha256(cookie_value.encode("utf-8")).hexdigest()


def new_cookie_value() -> str:
    """32 bytes of urlsafe entropy. Returned ONCE; only the hash is stored."""
    return secrets.token_urlsafe(32)


@dataclass
class JoinerSession:
    id: str
    label: str | None
    mode: str
    brief_subscope: str | None
    actor_kind: str
    device_id: str | None
    invite_id: str | None
    expires_at: str
    hard_cap_at: str
    created_at: str
    last_used_at: str
    last_ip: str | None
    last_user_agent: str | None


async def create_session(
    *,
    mode: str,
    actor_kind: str,
    ttl_seconds: int,
    label: str | None = None,
    brief_subscope: str | None = None,
    invite_id: str | None = None,
    device_id: str | None = None,
    last_ip: str | None = None,
    last_user_agent: str | None = None,
) -> tuple[str, JoinerSession]:
    """Mint a new joiner session row. Returns (cookie_value, session).

    The cookie value is shown ONCE — only its SHA-256 hash is persisted.
    """
    sid = str(uuid.uuid4())
    cookie = new_cookie_value()
    cookie_hash = _hash_cookie(cookie)

    now = _now()
    hard_cap = now + timedelta(days=HARD_CAP_DAYS)
    # ttl_seconds=0 → "session-only" (until hard cap; the redeemed link
    # itself expired already, but we still let the redeemer in for the
    # 90-day cap window). 1h/8h/30d clamp to whichever is sooner.
    if ttl_seconds <= 0:
        expires = hard_cap
    else:
        expires = min(now + timedelta(seconds=ttl_seconds), hard_cap)

    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO joiner_sessions
               (id, token_hash, invite_id, label, mode, brief_subscope,
                actor_kind, device_id, expires_at, hard_cap_at,
                last_ip, last_user_agent)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (sid, cookie_hash, invite_id, label, mode, brief_subscope,
             actor_kind, device_id, _iso(expires), _iso(hard_cap),
             last_ip, last_user_agent),
        )
        await db.commit()

        cur = await db.execute(
            "SELECT * FROM joiner_sessions WHERE id = ?", (sid,)
        )
        row = await cur.fetchone()
    finally:
        await db.close()

    return cookie, _row_to_session(dict(row))


def _row_to_session(row: dict) -> JoinerSession:
    return JoinerSession(
        id=row["id"],
        label=row.get("label"),
        mode=row["mode"],
        brief_subscope=row.get("brief_subscope"),
        actor_kind=row["actor_kind"],
        device_id=row.get("device_id"),
        invite_id=row.get("invite_id"),
        expires_at=row["expires_at"],
        hard_cap_at=row["hard_cap_at"],
        created_at=row.get("created_at") or "",
        last_used_at=row.get("last_used_at") or "",
        last_ip=row.get("last_ip"),
        last_user_agent=row.get("last_user_agent"),
    )


async def lookup(
    cookie_value: str,
    *,
    slide: bool = True,
    last_ip: str | None = None,
    last_user_agent: str | None = None,
    ttl_seconds: int | None = None,
) -> JoinerSession | None:
    """Look up a session by cookie value. Returns None if revoked or expired.

    When `slide=True` (the default), bumps last_used_at and slides expires_at
    forward by `ttl_seconds` (or 86400 if not provided), capped at hard_cap_at.
    """
    if not cookie_value:
        return None
    cookie_hash = _hash_cookie(cookie_value)
    now = _now()
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT * FROM joiner_sessions WHERE token_hash = ?", (cookie_hash,)
        )
        row = await cur.fetchone()
        if row is None:
            return None
        row = dict(row)
        if row.get("revoked_at"):
            return None
        expires = _parse_iso(row.get("expires_at"))
        if expires is None or now >= expires:
            return None

        if slide:
            hard_cap = _parse_iso(row.get("hard_cap_at")) or (now + timedelta(days=HARD_CAP_DAYS))
            slide_secs = ttl_seconds if (ttl_seconds and ttl_seconds > 0) else 86400
            new_expires = min(now + timedelta(seconds=slide_secs), hard_cap)
            await db.execute(
                """UPDATE joiner_sessions
                       SET last_used_at = ?,
                           expires_at = ?,
                           last_ip = COALESCE(?, last_ip),
                           last_user_agent = COALESCE(?, last_user_agent)
                     WHERE id = ?""",
                (_iso(now), _iso(new_expires), last_ip, last_user_agent, row["id"]),
            )
            await db.commit()
            row["last_used_at"] = _iso(now)
            row["expires_at"] = _iso(new_expires)
            row["last_ip"] = last_ip or row.get("last_ip")
            row["last_user_agent"] = last_user_agent or row.get("last_user_agent")
    finally:
        await db.close()

    return _row_to_session(row)


async def list_active() -> list[dict]:
    """List all non-revoked, unexpired joiner sessions for owner UI."""
    now_iso = _iso(_now())
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT id, label, mode, brief_subscope, actor_kind,
                      device_id, invite_id, created_at, last_used_at,
                      expires_at, hard_cap_at, last_ip, last_user_agent
                 FROM joiner_sessions
                WHERE revoked_at IS NULL AND expires_at > ?
                ORDER BY last_used_at DESC""",
            (now_iso,),
        )
        rows = await cur.fetchall()
    finally:
        await db.close()
    return [dict(r) for r in rows]


async def revoke(session_id: str) -> bool:
    db = await get_db()
    try:
        cur = await db.execute(
            """UPDATE joiner_sessions
                  SET revoked_at = ?
                WHERE id = ? AND revoked_at IS NULL""",
            (_iso(_now()), session_id),
        )
        await db.commit()
        return cur.rowcount > 0
    finally:
        await db.close()


async def revoke_by_invite(invite_id: str) -> int:
    db = await get_db()
    try:
        cur = await db.execute(
            """UPDATE joiner_sessions
                  SET revoked_at = ?
                WHERE invite_id = ? AND revoked_at IS NULL""",
            (_iso(_now()), invite_id),
        )
        await db.commit()
        return cur.rowcount
    finally:
        await db.close()
