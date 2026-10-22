"""One-shot: drop IVE's fake "high" effort from rows created before fix/effort.

Before fix/effort, IVE stored effort='high' as its own default and then
omitted --effort for it, so those Claude sessions really ran at the user's
effortLevel (e.g. xhigh). IVE now passes --effort whenever a value is
stored, so the old rows would silently downgrade to high. This migration
sets them to NULL (= the CLI's own default), which keeps their real
behaviour.

It runs once: the marker row in app_settings is written in the same
transaction, so later runs never touch values the user picks afterwards.
Codex/other CLIs are left alone (they had no effort setting anyway).
"""
from __future__ import annotations

MARKER = "_migr_effort_fake_high_v1"

_CLAUDE = "(cli_type IS NULL OR cli_type = '' OR lower(cli_type) = 'claude')"


async def migrate_fake_high_effort(db) -> dict | None:
    """Return counts when the migration ran, None when it already had."""
    cur = await db.execute("SELECT 1 FROM app_settings WHERE key = ?", (MARKER,))
    if await cur.fetchone() is not None:
        return None
    counts = {}
    for table in ("sessions", "templates"):
        cur = await db.execute(
            f"UPDATE {table} SET effort = NULL "
            f"WHERE lower(trim(effort)) = 'high' AND {_CLAUDE}"
        )
        counts[table] = cur.rowcount if cur.rowcount is not None else 0
    await db.execute(
        "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)",
        (MARKER, f"sessions={counts['sessions']} templates={counts['templates']}"),
    )
    return counts
