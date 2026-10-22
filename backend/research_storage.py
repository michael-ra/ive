"""Atomic local research persistence; optional knowledge consumers run afterward."""
from __future__ import annotations

try:
    from deep_research.artifacts import source_rows, validated_id
except ModuleNotFoundError as exc:
    if exc.name != "deep_research":
        raise
    # The backend launcher starts inside backend/, while the standalone
    # research package lives beside it. Admit that trusted product root only.
    import sys
    from resource_path import project_root
    sys.path.insert(0, str(project_root()))
    from deep_research.artifacts import source_rows, validated_id


async def claim_research_run(get_db, *, entry_id: str, workspace_id: str | None,
                             run_id: str, query: str) -> None:
    """Acquire this entry for one execution, atomically across awaited starts."""
    validated_id(entry_id, "entry_id")
    validated_id(run_id, "run_id")
    if workspace_id is not None:
        validated_id(workspace_id, "workspace_id")
    db = await get_db()
    try:
        cur = await db.execute(
            "UPDATE research_entries SET status = 'in_progress', artifact_run_id = ?, "
            "artifact_workspace_id = ?, updated_at = datetime('now') "
            "WHERE id = ? AND query = ? AND (scope = 'company' OR workspace_id IS ?) "
            "AND NOT (status = 'in_progress' AND artifact_run_id IS NOT NULL)",
            (run_id, workspace_id, entry_id, query, workspace_id))
        if cur.rowcount != 1:
            raise ValueError("research entry is mismatched or owned by another active execution")
        await db.commit()
    except BaseException:
        await db.rollback()
        raise
    finally:
        await db.close()


async def persist_completed_run(get_db, *, entry_id: str, workspace_id: str | None,
                                run_id: str, query: str, report: str, run: dict) -> None:
    validated_id(entry_id, "entry_id")
    validated_id(run_id, "run_id")
    if workspace_id is not None:
        validated_id(workspace_id, "workspace_id")
    if (not report.strip() or run.get("entry_id") != entry_id or run.get("run_id") != run_id
            or run.get("query") != query or run.get("workspace_id") != workspace_id):
        raise ValueError("research result identity mismatch")
    sources = source_rows(run)
    db = await get_db()
    try:
        await db.execute("BEGIN IMMEDIATE")
        cur = await db.execute(
            "SELECT query, workspace_id, scope, status, artifact_run_id, artifact_workspace_id "
            "FROM research_entries WHERE id = ?", (entry_id,))
        row = await cur.fetchone()
        if (row is None or row["query"] != query
                or (row["scope"] != "company" and row["workspace_id"] != workspace_id)
                or row["status"] != "in_progress" or row["artifact_run_id"] != run_id
                or row["artifact_workspace_id"] != workspace_id):
            raise ValueError("research entry is missing, mismatched or no longer running")
        # A new execution replaces the previous report AND its citations in one
        # transaction. No observer sees a complete report with missing sources.
        await db.execute("DELETE FROM research_sources WHERE entry_id = ?", (entry_id,))
        for source in sources:
            await db.execute(
                "INSERT INTO research_sources (entry_id, url, title, content_summary, relevance_score) "
                "VALUES (?, ?, ?, ?, ?)",
                (entry_id, source["url"], source["title"], source["content_summary"], source["relevance_score"]))
        await db.execute(
            "UPDATE research_entries SET findings_summary = ?, status = 'complete', "
            "artifact_run_id = ?, artifact_workspace_id = ?, updated_at = datetime('now') WHERE id = ?",
            (report, run_id, workspace_id, entry_id))
        await db.commit()
    except BaseException:
        await db.rollback()
        raise
    finally:
        await db.close()


async def read_entry_result(get_db, entry_id: str, workspace_id: str | None) -> dict | None:
    """Pipelines consume the authoritative entry, for either research backend."""
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT id, status, findings_summary FROM research_entries "
            "WHERE id = ? AND workspace_id IS ?", (entry_id, workspace_id))
        row = await cur.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()
