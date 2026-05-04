"""Code Catalog: upsert + history layer over workspace_knowledge.

This is the *engine* for the code_catalog memory category. It rides on
the existing `workspace_knowledge` table (category='code_catalog'), uses
the existing `embeddings` table for semantic search, and adds a small
sidecar `code_catalog_history` for replace-audit (latest-write-wins).

Dedup key for catalog rows is **(workspace_id, symbol_file, symbol_name)**
— not the generic content-hash dedup that knowledge_indexer applies to
gotchas / patterns. Two emissions for the same symbol always converge
onto the same row.

Conflict resolution (decision §10.1, locked):
  • New raw == existing raw  → noop, just bump confirmed_count if the
    contributing session is *different* from the prior contributor.
  • New raw != existing raw  → REPLACE. Snapshot the prior row into
    code_catalog_history, then UPDATE the row with new content. Reset
    confirmed_count to 1 (the new content has only one voice so far).

Events emitted:
  • CODE_CATALOG_UPDATED — every successful upsert (insert / confirm / replace)
  • CODE_CATALOG_REPLACED — only on true content disagreement, AFTER the
    UPDATED event. Payload includes prior_content + history_id.

Embedding is best-effort; the embedder hook in embedder.knowledge_dense_text
detects category=='code_catalog' and uses parsed symbol_name + purpose so
flow/effects don't dominate the vector.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)


from code_catalog_parser import (
    parse_line,
    emit_line,
    normalized_eq,
    empty_parsed,
)


# ── Internal helpers ─────────────────────────────────────────────────────


def _norm_args(s: str | None) -> str:
    return ' '.join((s or '').split())


def _row_to_dict(row) -> dict[str, Any] | None:
    if row is None:
        return None
    return dict(row)


async def _emit(event_value: str, payload: dict[str, Any], source: str = "code_catalog") -> None:
    """Best-effort event emission. Never raises."""
    try:
        from event_bus import bus
        from commander_events import CommanderEvent

        # Resolve string -> enum so callers can pass shorthand.
        evt = CommanderEvent(event_value) if isinstance(event_value, str) else event_value
        await bus.emit(evt, payload, source=source)
    except Exception:
        logger.exception("code_catalog: failed to emit %s", event_value)


async def _embed(entry: dict[str, Any]) -> None:
    """Best-effort embedding. Never raises."""
    try:
        from embedder import embed_knowledge
        await embed_knowledge(entry)
    except Exception:
        logger.debug("code_catalog: embed_knowledge failed", exc_info=True)


# ── Lookup ───────────────────────────────────────────────────────────────


async def find_existing(
    db,
    workspace_id: str,
    symbol_file: str,
    symbol_name: str,
) -> dict[str, Any] | None:
    """Return the existing catalog row for (workspace, file, symbol), or None."""
    cur = await db.execute(
        """SELECT * FROM workspace_knowledge
           WHERE workspace_id = ?
             AND category = 'code_catalog'
             AND symbol_file = ?
             AND symbol_name = ?
           LIMIT 1""",
        (workspace_id, symbol_file, symbol_name),
    )
    row = await cur.fetchone()
    return _row_to_dict(row)


async def get_catalog_for_files(
    workspace_id: str,
    files: list[str],
    *,
    include_stale: bool = True,
) -> list[dict[str, Any]]:
    """Return all catalog entries whose symbol_file is in `files`.

    Used by handoff / research injection so the worker sees the symbols
    that live in the files it's about to touch.
    """
    if not files:
        return []

    from db import get_db
    db = await get_db()
    try:
        placeholders = ','.join('?' * len(files))
        sql = f"""
            SELECT * FROM workspace_knowledge
             WHERE workspace_id = ?
               AND category = 'code_catalog'
               AND symbol_file IN ({placeholders})
        """
        params: list[Any] = [workspace_id, *files]
        if not include_stale:
            sql += " AND stale_since IS NULL"
        sql += " ORDER BY symbol_file, symbol_name"
        cur = await db.execute(sql, params)
        rows = await cur.fetchall()
    finally:
        await db.close()

    return [dict(r) for r in rows]


async def get_catalog_for_file(
    workspace_id: str,
    file: str,
    *,
    include_stale: bool = True,
) -> list[dict[str, Any]]:
    return await get_catalog_for_files(workspace_id, [file], include_stale=include_stale)


async def get_catalog_summary(workspace_id: str) -> dict[str, Any]:
    """Per-file + per-kind counts for the UI overview."""
    from db import get_db
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT symbol_file, symbol_kind, COUNT(*) AS n,
                      SUM(CASE WHEN stale_since IS NOT NULL THEN 1 ELSE 0 END) AS stale_n
                 FROM workspace_knowledge
                WHERE workspace_id = ? AND category = 'code_catalog'
                GROUP BY symbol_file, symbol_kind""",
            (workspace_id,),
        )
        rows = [dict(r) for r in await cur.fetchall()]

        cur2 = await db.execute(
            """SELECT COUNT(*) AS total,
                      SUM(CASE WHEN stale_since IS NOT NULL THEN 1 ELSE 0 END) AS stale_total
                 FROM workspace_knowledge
                WHERE workspace_id = ? AND category = 'code_catalog'""",
            (workspace_id,),
        )
        totals = dict(await cur2.fetchone() or {})
    finally:
        await db.close()

    by_file: dict[str, dict[str, Any]] = {}
    by_kind: dict[str, int] = {}
    for r in rows:
        f = r["symbol_file"] or "(unknown)"
        k = r["symbol_kind"] or "function"
        n = r["n"] or 0
        stale_n = r["stale_n"] or 0
        slot = by_file.setdefault(f, {"file": f, "n": 0, "stale": 0, "kinds": {}})
        slot["n"] += n
        slot["stale"] += stale_n
        slot["kinds"][k] = slot["kinds"].get(k, 0) + n
        by_kind[k] = by_kind.get(k, 0) + n

    return {
        "total": totals.get("total", 0) or 0,
        "stale_total": totals.get("stale_total", 0) or 0,
        "by_file": sorted(by_file.values(), key=lambda x: -x["n"]),
        "by_kind": by_kind,
    }


async def get_catalog_history(
    workspace_id: str,
    *,
    knowledge_id: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Recent replace events for the audit view."""
    from db import get_db
    db = await get_db()
    try:
        if knowledge_id:
            cur = await db.execute(
                """SELECT * FROM code_catalog_history
                    WHERE workspace_id = ? AND knowledge_id = ?
                    ORDER BY replaced_at DESC LIMIT ?""",
                (workspace_id, knowledge_id, limit),
            )
        else:
            cur = await db.execute(
                """SELECT * FROM code_catalog_history
                    WHERE workspace_id = ?
                    ORDER BY replaced_at DESC LIMIT ?""",
                (workspace_id, limit),
            )
        rows = await cur.fetchall()
    finally:
        await db.close()
    return [dict(r) for r in rows]


# ── Upsert ───────────────────────────────────────────────────────────────


async def upsert_catalog_entry(
    workspace_id: str,
    raw_line: str,
    contributed_by: str | None = None,
    *,
    scope: str = "",
    parsed: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Upsert a single catalog line.

    Returns a dict with the resulting `workspace_knowledge` row plus a
    top-level `change_kind` ∈ {'inserted', 'confirmed', 'replaced', 'noop_invalid'}.

    `parsed` may be passed by callers that already parsed the line (avoids
    a re-parse). When omitted, this function parses internally.
    """
    parsed = parsed if parsed is not None else parse_line(raw_line)

    file = parsed.get("symbol_file")
    name = parsed.get("symbol_name")
    kind = parsed.get("symbol_kind")
    args = _norm_args(parsed.get("args"))
    raw = (raw_line or "").strip()

    # Loose mode: if the line couldn't be parsed (no symbol), persist the
    # raw line as a generic catalog row without a key. We embed nothing
    # because there's no semantic content; the row exists so the audit
    # view can show "this LLM emission was malformed."
    if not name or not file:
        return await _insert_unkeyed(
            workspace_id=workspace_id,
            raw=raw,
            contributed_by=contributed_by,
            scope=scope,
        )

    from db import get_db
    db = await get_db()
    try:
        existing = await find_existing(db, workspace_id, file, name)

        # ── Path 1: fresh insert ───────────────────────────────────────
        if existing is None:
            entry_id = str(uuid.uuid4())
            await db.execute(
                """INSERT INTO workspace_knowledge
                       (id, workspace_id, category, content, scope,
                        contributed_by, symbol_name, symbol_file, symbol_kind)
                   VALUES (?, ?, 'code_catalog', ?, ?, ?, ?, ?, ?)""",
                (entry_id, workspace_id, raw, scope, contributed_by, name, file, kind),
            )
            await db.commit()
            cur = await db.execute(
                "SELECT * FROM workspace_knowledge WHERE id = ?", (entry_id,)
            )
            row = dict(await cur.fetchone())
            change_kind = "inserted"

        # ── Path 2: same content (or normalized-equal) → confirm ──────
        elif normalized_eq(existing["content"], raw):
            # Only bump confirmed_count if this is a *different* contributor
            # session than the prior writer. Same-session re-emits (long
            # worker runs, refreshers) shouldn't inflate the count.
            same_contributor = (
                contributed_by
                and existing.get("contributed_by")
                and contributed_by == existing["contributed_by"]
            )
            updates = ["updated_at = datetime('now')", "stale_since = NULL"]
            params: list[Any] = []
            if not same_contributor:
                updates.append("confirmed_count = confirmed_count + 1")
            await db.execute(
                f"UPDATE workspace_knowledge SET {', '.join(updates)} WHERE id = ?",
                (*params, existing["id"]),
            )
            await db.commit()
            cur = await db.execute(
                "SELECT * FROM workspace_knowledge WHERE id = ?", (existing["id"],)
            )
            row = dict(await cur.fetchone())
            change_kind = "confirmed"

        # ── Path 3: content disagreement → replace + history ──────────
        else:
            history_id = str(uuid.uuid4())
            await db.execute(
                """INSERT INTO code_catalog_history
                       (id, knowledge_id, workspace_id, symbol_name,
                        prior_content, prior_contributed_by,
                        prior_confirmed_count, replaced_by_session)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    history_id,
                    existing["id"],
                    workspace_id,
                    existing.get("symbol_name") or name,
                    existing.get("content") or "",
                    existing.get("contributed_by"),
                    existing.get("confirmed_count") or 1,
                    contributed_by,
                ),
            )
            await db.execute(
                """UPDATE workspace_knowledge
                      SET content = ?,
                          contributed_by = ?,
                          symbol_kind = ?,
                          confirmed_count = 1,
                          stale_since = NULL,
                          updated_at = datetime('now')
                    WHERE id = ?""",
                (raw, contributed_by, kind, existing["id"]),
            )
            await db.commit()
            cur = await db.execute(
                "SELECT * FROM workspace_knowledge WHERE id = ?", (existing["id"],)
            )
            row = dict(await cur.fetchone())
            row["_replaced_history_id"] = history_id
            row["_prior_content"] = existing.get("content")
            change_kind = "replaced"

    finally:
        await db.close()

    # Embed (only for keyed rows with valid symbol). Best-effort.
    await _embed(row)

    # Emit events. UPDATED always fires; REPLACED fires after when applicable.
    await _emit(
        "code_catalog_updated",
        {
            "entry_id": row["id"],
            "workspace_id": workspace_id,
            "symbol_file": file,
            "symbol_name": name,
            "symbol_kind": kind,
            "change_kind": change_kind,
            "contributed_by": contributed_by,
        },
    )
    if change_kind == "replaced":
        await _emit(
            "code_catalog_replaced",
            {
                "entry_id": row["id"],
                "workspace_id": workspace_id,
                "symbol_file": file,
                "symbol_name": name,
                "history_id": row.get("_replaced_history_id"),
                "prior_contributed_by": (
                    # surfacing for audit subscribers; drop heavy field
                    None
                ),
                "replaced_by": contributed_by,
            },
        )

    row["change_kind"] = change_kind
    return row


async def _insert_unkeyed(
    *,
    workspace_id: str,
    raw: str,
    contributed_by: str | None,
    scope: str,
) -> dict[str, Any]:
    """Persist an unparseable catalog line as a keyless row. No embedding."""
    from db import get_db
    db = await get_db()
    try:
        entry_id = str(uuid.uuid4())
        await db.execute(
            """INSERT INTO workspace_knowledge
                   (id, workspace_id, category, content, scope, contributed_by)
               VALUES (?, ?, 'code_catalog', ?, ?, ?)""",
            (entry_id, workspace_id, raw, scope, contributed_by),
        )
        await db.commit()
        cur = await db.execute(
            "SELECT * FROM workspace_knowledge WHERE id = ?", (entry_id,)
        )
        row = dict(await cur.fetchone())
    finally:
        await db.close()

    await _emit(
        "code_catalog_updated",
        {
            "entry_id": row["id"],
            "workspace_id": workspace_id,
            "symbol_file": None,
            "symbol_name": None,
            "symbol_kind": None,
            "change_kind": "noop_invalid",
            "contributed_by": contributed_by,
        },
    )
    row["change_kind"] = "noop_invalid"
    return row


async def bulk_upsert_catalog_entries(
    workspace_id: str,
    raw_lines: list[str],
    contributed_by: str | None = None,
    *,
    scope: str = "",
) -> dict[str, Any]:
    """Upsert many lines. Returns counts per change_kind + the rows.

    Used by /api/workspaces/{id}/code_catalog/bulk_upsert and by the
    /code-catalog-init bootstrap skill.
    """
    counts = {"inserted": 0, "confirmed": 0, "replaced": 0, "noop_invalid": 0}
    rows: list[dict[str, Any]] = []
    for raw in raw_lines:
        try:
            r = await upsert_catalog_entry(
                workspace_id=workspace_id,
                raw_line=raw,
                contributed_by=contributed_by,
                scope=scope,
            )
            counts[r.get("change_kind", "inserted")] = (
                counts.get(r.get("change_kind", "inserted"), 0) + 1
            )
            rows.append(r)
        except Exception:
            logger.exception("code_catalog: bulk upsert row failed: %r", raw[:120])
            counts["noop_invalid"] += 1
    return {"counts": counts, "rows": rows}


# ── Staleness / refresh ──────────────────────────────────────────────────


async def mark_file_stale(workspace_id: str, files: list[str]) -> int:
    """Mark all catalog rows for these files as stale (verify pending)."""
    if not files:
        return 0
    from db import get_db
    db = await get_db()
    try:
        placeholders = ','.join('?' * len(files))
        cur = await db.execute(
            f"""UPDATE workspace_knowledge
                   SET stale_since = COALESCE(stale_since, datetime('now')),
                       updated_at = datetime('now')
                 WHERE workspace_id = ?
                   AND category = 'code_catalog'
                   AND symbol_file IN ({placeholders})""",
            (workspace_id, *files),
        )
        await db.commit()
        return cur.rowcount or 0
    finally:
        await db.close()


async def clear_stale(workspace_id: str, files: list[str]) -> int:
    """Clear stale_since on rows for these files (after a verify pass)."""
    if not files:
        return 0
    from db import get_db
    db = await get_db()
    try:
        placeholders = ','.join('?' * len(files))
        cur = await db.execute(
            f"""UPDATE workspace_knowledge
                   SET stale_since = NULL, updated_at = datetime('now')
                 WHERE workspace_id = ?
                   AND category = 'code_catalog'
                   AND symbol_file IN ({placeholders})""",
            (workspace_id, *files),
        )
        await db.commit()
        return cur.rowcount or 0
    finally:
        await db.close()


async def delete_for_file(workspace_id: str, file: str) -> int:
    """Hard-delete catalog rows for a file (used when the file is removed)."""
    from db import get_db
    db = await get_db()
    try:
        # Cascade: code_catalog_history.knowledge_id -> workspace_knowledge.id
        # is ON DELETE CASCADE, so history rows go too.
        cur = await db.execute(
            """DELETE FROM workspace_knowledge
                WHERE workspace_id = ? AND category = 'code_catalog' AND symbol_file = ?""",
            (workspace_id, file),
        )
        await db.commit()
        return cur.rowcount or 0
    finally:
        await db.close()


__all__ = [
    "upsert_catalog_entry",
    "bulk_upsert_catalog_entries",
    "find_existing",
    "get_catalog_for_files",
    "get_catalog_for_file",
    "get_catalog_summary",
    "get_catalog_history",
    "mark_file_stale",
    "clear_stale",
    "delete_for_file",
]
