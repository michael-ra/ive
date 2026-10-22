"""Per-row joiner session storage.

A joiner session is one row in `joiner_sessions` representing an active
bearer/cookie. Three actor_kind values:
  • 'owner_legacy'  — bootstrapped from AUTH_TOKEN; owner-equivalent
  • 'owner_device'  — Ed25519-paired phone/browser
  • 'joiner_session'— minted by redeeming an invite

Invite-backed credentials have the absolute TTL selected by the owner.
Owner/device credentials retain their sliding TTL. Once `expires_at` passes
or `revoked_at` is set, lookups return None and the cookie is cleared.

Invite redemption mints a fresh opaque cookie value; the auth middleware
resolves that cookie through this module instead of global token equality.
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
SESSION_ONLY_SERVER_CAP_SECONDS = 24 * 3600


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
    workspace_id: str | None
    label: str | None
    mode: str
    brief_subscope: str | None
    actor_kind: str
    device_id: str | None
    invite_id: str | None
    ttl_seconds: int
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
    workspace_id: str | None = None,
    device_id: str | None = None,
    last_ip: str | None = None,
    last_user_agent: str | None = None,
) -> tuple[str, JoinerSession]:
    """Mint a new joiner session row. Returns (cookie_value, session).

    The cookie value is shown ONCE — only its SHA-256 hash is persisted.
    """
    if ttl_seconds < 0:
        raise ValueError("ttl_seconds cannot be negative")
    if actor_kind == "joiner_session" and (not invite_id or not workspace_id):
        raise ValueError("invite-backed sessions require invite_id and workspace_id")

    sid = str(uuid.uuid4())
    cookie = new_cookie_value()
    cookie_hash = _hash_cookie(cookie)

    now = _now()
    hard_cap = now + timedelta(days=HARD_CAP_DAYS)
    # A browser-session cookie has no persistent Max-Age. Keep a short server
    # cap as defense in depth for a copied bearer; fixed-duration invites use
    # the exact duration selected by the owner.
    if ttl_seconds <= 0:
        expires = min(
            now + timedelta(seconds=SESSION_ONLY_SERVER_CAP_SECONDS), hard_cap
        )
    else:
        expires = min(now + timedelta(seconds=ttl_seconds), hard_cap)

    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO joiner_sessions
               (id, token_hash, invite_id, workspace_id, label, mode, brief_subscope,
                ttl_seconds, actor_kind, device_id, expires_at, hard_cap_at,
                last_ip, last_user_agent)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (sid, cookie_hash, invite_id, workspace_id, label, mode, brief_subscope,
             ttl_seconds, actor_kind, device_id, _iso(expires), _iso(hard_cap),
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
        workspace_id=row.get("workspace_id"),
        label=row.get("label"),
        mode=row["mode"],
        brief_subscope=row.get("brief_subscope"),
        actor_kind=row["actor_kind"],
        device_id=row.get("device_id"),
        invite_id=row.get("invite_id"),
        ttl_seconds=int(row.get("ttl_seconds") or 0),
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
) -> JoinerSession | None:
    """Look up a session by cookie value. Returns None if revoked or expired.

    When `slide=True` (the default), bumps last_used_at. Owner/device rows also
    slide by their stored TTL; invite-backed rows keep their absolute expiry.
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
            new_expires = expires
            if not row.get("invite_id"):
                slide_secs = int(row.get("ttl_seconds") or 0)
                if slide_secs <= 0:
                    return None
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
            """SELECT id, workspace_id, label, mode, brief_subscope, actor_kind,
                      device_id, invite_id, ttl_seconds, created_at, last_used_at,
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
