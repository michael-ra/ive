"""Shared configuration contract for Safety Gate precedent behavior."""
from __future__ import annotations


SAFETY_PRECEDENT_MODES = ("off", "propose", "verdict")
DEFAULT_SAFETY_PRECEDENT_MODE = "propose"


def resolve_safety_precedent_mode(value: object) -> str:
    """Return a valid mode; absent or malformed settings resolve to propose."""
    normalized = str(value or "").strip().lower()
    if normalized in SAFETY_PRECEDENT_MODES:
        return normalized
    return DEFAULT_SAFETY_PRECEDENT_MODE


async def get_safety_precedent_mode(db) -> str:
    """Resolve the app setting without inserting a default row."""
    row = await db.execute_fetchall(
        "SELECT value FROM app_settings WHERE key = 'safety_precedent_mode'"
    )
    return resolve_safety_precedent_mode(row[0]["value"] if row else None)
