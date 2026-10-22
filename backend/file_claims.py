"""file_claims.py — C5 coordinator hard seam: a durable, deadlock-safe file-claim ledger.

myelin coordination provides ADVISORY, embedding-based overlap detection ("two
workers might be editing the same area") but, by its own docs, is *not a hard
lock*. This module adds an ENFORCEABLE claim: acquiring a path is authoritative —
a worker that asks for a path a *live* peer already holds is BLOCKED.

It cannot deadlock. Every claim carries a TTL (`expires_at`) and is ignored the
moment its holder session is no longer alive (checked against the `sessions`
table). So a crashed, hung, or forgotten worker's claim self-heals — the worst
case is a bounded wait, never a permanent stall. Re-acquiring a path you already
hold just refreshes the TTL (reentrant).

The advisory myelin overlap path is unchanged and complementary: overlap tells
you *someone might conflict*; a claim *guarantees* serialization on an exact path.
"""
from __future__ import annotations

import uuid
from typing import Optional

import db as _db

DEFAULT_TTL_S = 900  # 15 minutes

# Session states that mean the holder is gone → its claims are dead and ignored.
_DEAD_SESSION_STATES = {"exited", "offline", "stopped", "disconnected", "error", "killed"}


def _norm(path: str) -> str:
    return (path or "").strip().rstrip("/")


async def _holder_alive(conn, session_id: Optional[str]) -> bool:
    """A claim's holder is alive unless its session row is missing or in a
    terminal state. Missing session → dead (claim ignored). This is what makes
    the lock deadlock-proof independent of the TTL."""
    if not session_id:
        return False
    cur = await conn.execute("SELECT status FROM sessions WHERE id = ?", (session_id,))
    row = await cur.fetchone()
    if not row:
        return False
    try:
        status = str(row["status"] or "").lower()
    except (KeyError, IndexError, TypeError):
        status = ""
    return status not in _DEAD_SESSION_STATES


async def acquire(
    workspace_id: Optional[str],
    path: str,
    session_id: str,
    *,
    agent_id: Optional[str] = None,
    intent: str = "",
    ttl_s: int = DEFAULT_TTL_S,
    conn=None,
) -> dict:
    """Try to claim `path` for `session_id`. Returns {"granted": True, claim_id,...}
    on success, or {"granted": False, "held_by": {...}} if a LIVE peer holds it.
    Reentrant: re-acquiring your own path refreshes the TTL."""
    path = _norm(path)
    if not path:
        return {"granted": False, "reason": "empty path"}
    if not session_id:
        return {"granted": False, "reason": "session_id required"}
    own = conn is None
    conn = conn or await _db.get_db()
    try:
        cur = await conn.execute(
            "SELECT id, session_id, agent_id, intent, expires_at FROM file_claims "
            "WHERE path = ? AND released_at IS NULL AND expires_at > datetime('now')",
            (path,),
        )
        rows = [dict(r) for r in await cur.fetchall()]
        # Is a LIVE peer (not us) already holding it?
        for r in rows:
            if r["session_id"] == session_id:
                continue
            if await _holder_alive(conn, r["session_id"]):
                return {
                    "granted": False,
                    "path": path,
                    "held_by": {
                        "session_id": r["session_id"],
                        "agent_id": r.get("agent_id"),
                        "expires_at": r["expires_at"],
                    },
                }
        # Grant: refresh our own live claim if present, else insert a new one.
        mine = next((r for r in rows if r["session_id"] == session_id), None)
        if mine:
            await conn.execute(
                "UPDATE file_claims SET expires_at = datetime('now', ?), intent = ? WHERE id = ?",
                (f"+{int(ttl_s)} seconds", intent or mine.get("intent") or "", mine["id"]),
            )
            claim_id = mine["id"]
        else:
            claim_id = str(uuid.uuid4())
            await conn.execute(
                "INSERT INTO file_claims (id, workspace_id, path, session_id, agent_id, intent, expires_at) "
                "VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))",
                (claim_id, workspace_id, path, session_id, agent_id, intent, f"+{int(ttl_s)} seconds"),
            )
        await conn.commit()
        return {"granted": True, "claim_id": claim_id, "path": path, "ttl_s": int(ttl_s)}
    finally:
        if own:
            await conn.close()


async def release(session_id: str, *, path: Optional[str] = None, claim_id: Optional[str] = None, conn=None) -> dict:
    """Release a claim you hold — by claim_id, by path, or (both None) all of
    yours. Only affects claims owned by `session_id`."""
    own = conn is None
    conn = conn or await _db.get_db()
    try:
        if claim_id:
            cur = await conn.execute(
                "UPDATE file_claims SET released_at = datetime('now') "
                "WHERE id = ? AND session_id = ? AND released_at IS NULL",
                (claim_id, session_id),
            )
        elif path is not None:
            cur = await conn.execute(
                "UPDATE file_claims SET released_at = datetime('now') "
                "WHERE path = ? AND session_id = ? AND released_at IS NULL",
                (_norm(path), session_id),
            )
        else:
            cur = await conn.execute(
                "UPDATE file_claims SET released_at = datetime('now') "
                "WHERE session_id = ? AND released_at IS NULL",
                (session_id,),
            )
        await conn.commit()
        return {"released": True, "count": cur.rowcount}
    finally:
        if own:
            await conn.close()


async def is_claimed(workspace_id: Optional[str], path: str, *, other_than: Optional[str] = None, conn=None) -> Optional[dict]:
    """Return the live holder of `path` (optionally excluding `other_than`), or
    None. This is the primitive an edit-time hook calls to enforce claims."""
    path = _norm(path)
    if not path:
        return None
    own = conn is None
    conn = conn or await _db.get_db()
    try:
        cur = await conn.execute(
            "SELECT session_id, agent_id, expires_at FROM file_claims "
            "WHERE path = ? AND released_at IS NULL AND expires_at > datetime('now')",
            (path,),
        )
        for r in await cur.fetchall():
            r = dict(r)
            if other_than and r["session_id"] == other_than:
                continue
            if await _holder_alive(conn, r["session_id"]):
                return {"session_id": r["session_id"], "agent_id": r.get("agent_id"), "expires_at": r["expires_at"]}
        return None
    finally:
        if own:
            await conn.close()


async def list_claims(workspace_id: Optional[str] = None, *, conn=None) -> list[dict]:
    """List currently-active (unreleased, unexpired, live-holder) claims."""
    own = conn is None
    conn = conn or await _db.get_db()
    try:
        if workspace_id is None:
            cur = await conn.execute(
                "SELECT * FROM file_claims WHERE released_at IS NULL AND expires_at > datetime('now')"
            )
        else:
            cur = await conn.execute(
                "SELECT * FROM file_claims WHERE workspace_id = ? AND released_at IS NULL "
                "AND expires_at > datetime('now')",
                (workspace_id,),
            )
        out = []
        for r in await cur.fetchall():
            r = dict(r)
            if await _holder_alive(conn, r["session_id"]):
                out.append(r)
        return out
    finally:
        if own:
            await conn.close()


async def sweep_expired(conn=None) -> int:
    """Housekeeping: mark expired unreleased claims released. Optional — the read
    queries already ignore expired rows; this just keeps the table tidy."""
    own = conn is None
    conn = conn or await _db.get_db()
    try:
        cur = await conn.execute(
            "UPDATE file_claims SET released_at = datetime('now') "
            "WHERE released_at IS NULL AND expires_at <= datetime('now')"
        )
        await conn.commit()
        return cur.rowcount
    finally:
        if own:
            await conn.close()
