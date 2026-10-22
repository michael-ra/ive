"""Opt-in, bounded automatic session metadata; never changes interactive effort."""
from __future__ import annotations

import hashlib
import logging
import time
import uuid

from db import get_db

log = logging.getLogger(__name__)
SETTINGS = {
    "distill": "experimental_auto_distill",
    "digest": "automatic_session_summaries",
    "summary": "automatic_session_summaries",
    "title": "auto_session_titles",
}
MIN_INTERVAL = 300
LEASE_SECONDS = 600  # Longer than the bounded provider call, including cleanup.
MAX_RUNNING = 2
# Optional metadata work must stay small even when a user enables all features.
# Character reservations are conservative input limits, not billed token counts.
MAX_PROMPT_CHARS = 12_000
MAX_DAILY_PROMPT_CHARS = 24_000
MAX_DAILY_JOBS = 6
MAX_SESSION_DAILY_JOBS = 2


async def initialize(db):
    await db.execute("""CREATE TABLE IF NOT EXISTS automatic_ai_jobs (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, fingerprint TEXT NOT NULL, lease TEXT NOT NULL,
        status TEXT NOT NULL, started_at REAL NOT NULL, finished_at REAL,
        PRIMARY KEY (session_id, kind, fingerprint)
    )""")
    await db.execute("""INSERT OR IGNORE INTO app_settings(key, value)
                        VALUES ('automatic_session_summaries', 'off')""")
    await db.execute("""INSERT OR IGNORE INTO app_settings(key, value)
                        VALUES ('auto_session_titles', 'off')""")
    columns = {row[1] for row in await (await db.execute("PRAGMA table_info(automatic_ai_jobs)")).fetchall()}
    if "prompt_chars" not in columns:
        await db.execute("ALTER TABLE automatic_ai_jobs ADD COLUMN prompt_chars INTEGER NOT NULL DEFAULT 0")
    await db.execute("""CREATE TABLE IF NOT EXISTS automatic_ai_budget (
        lease TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        started_at REAL NOT NULL, prompt_chars INTEGER NOT NULL
    )""")
    await db.execute("""INSERT OR IGNORE INTO automatic_ai_budget
        SELECT lease, session_id, started_at, CASE WHEN prompt_chars > 0 THEN prompt_chars ELSE ? END
        FROM automatic_ai_jobs""", (MAX_PROMPT_CHARS,))


async def enabled(kind: str, db=None) -> bool:
    own_connection = db is None
    try:
        if own_connection:
            db = await get_db()
        cur = await db.execute("SELECT value FROM app_settings WHERE key = ?", (SETTINGS[kind],))
        row = await cur.fetchone()
        return bool(row and row["value"] == "on")
    except Exception:
        log.warning("Automatic %s skipped: settings unavailable", kind)
        return False
    finally:
        if own_connection and db is not None:
            await db.close()


async def claim(kind: str, session_id: str, content: str, *, prompt_chars: int | None = None):
    """Atomically deduplicate across concurrent callbacks and app restarts.

    Only hashes/metadata are persisted. Failures may retry after the cooldown;
    completed content never runs again. Optional work is skipped when busy.
    """
    prompt_chars = len(content) if prompt_chars is None else prompt_chars
    if prompt_chars < 0 or prompt_chars > MAX_PROMPT_CHARS:
        return None
    fingerprint = hashlib.sha256(content.encode()).hexdigest()
    now, lease = time.time(), str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute("BEGIN IMMEDIATE")
        if not await enabled(kind, db):
            return None
        cur = await db.execute("""SELECT COUNT(*) AS jobs,
            COALESCE(SUM(CASE WHEN prompt_chars > 0 THEN prompt_chars ELSE ? END), 0) AS chars,
            COALESCE(SUM(CASE WHEN session_id = ? THEN 1 ELSE 0 END), 0) AS session_jobs
            FROM automatic_ai_budget WHERE started_at > ?""",
            (MAX_PROMPT_CHARS, session_id, now - 86400))
        budget = await cur.fetchone()
        if (budget["jobs"] >= MAX_DAILY_JOBS
                or budget["session_jobs"] >= MAX_SESSION_DAILY_JOBS
                or budget["chars"] + prompt_chars > MAX_DAILY_PROMPT_CHARS):
            return None
        await db.execute("""UPDATE automatic_ai_jobs SET status = 'failed'
                            WHERE status = 'running' AND started_at < ?""", (now - LEASE_SECONDS,))
        cur = await db.execute("""SELECT 1 FROM automatic_ai_jobs WHERE
            (status = 'running' AND session_id = ?)
            OR (session_id = ? AND kind = ? AND
                (started_at > ? OR (fingerprint = ? AND status = 'done')))
            LIMIT 1""", (session_id, session_id, kind, now - MIN_INTERVAL, fingerprint))
        if await cur.fetchone():
            return None
        cur = await db.execute("SELECT COUNT(*) FROM automatic_ai_jobs WHERE status = 'running'")
        if (await cur.fetchone())[0] >= MAX_RUNNING:
            return None
        await db.execute("""INSERT INTO automatic_ai_jobs
            (session_id, kind, fingerprint, lease, status, started_at, finished_at, prompt_chars)
            VALUES (?, ?, ?, ?, 'running', ?, NULL, ?)
            ON CONFLICT(session_id, kind, fingerprint) DO UPDATE SET
                lease = excluded.lease, status = 'running',
                started_at = excluded.started_at, finished_at = NULL,
                prompt_chars = excluded.prompt_chars""",
            (session_id, kind, fingerprint, lease, now, prompt_chars))
        await db.execute("INSERT INTO automatic_ai_budget VALUES (?, ?, ?, ?)",
                         (lease, session_id, now, prompt_chars))
        await db.execute("DELETE FROM automatic_ai_budget WHERE started_at < ?", (now - 7 * 86400,))
        await db.commit()
        return (session_id, kind, fingerprint, lease)
    finally:
        await db.close()  # Also rolls back any unclaimed transaction.


async def finish(receipt, *, success: bool):
    db = await get_db()
    try:
        await db.execute("""UPDATE automatic_ai_jobs SET status = ?, finished_at = ?
            WHERE session_id = ? AND kind = ? AND fingerprint = ? AND lease = ?""",
            ("done" if success else "failed", time.time(), *receipt))
        await db.commit()
    finally:
        await db.close()


async def call_json(kind, session_id, model_id, prompt, *, content=None, **kwargs):
    """None means disabled, duplicate or busy; it is not a provider failure."""
    receipt = await claim(kind, session_id, content if content is not None else prompt,
                          prompt_chars=len(prompt) + len(kwargs.get("system") or ""))
    if receipt is None:
        return None
    success = False
    try:
        from llm_router import call_json as provider_call
        result = await provider_call(model_id, prompt, reasoning_effort="low", **kwargs)
        success = True
        return result
    finally:
        await finish(receipt, success=success)
