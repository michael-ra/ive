"""Keyword search over ordinary, explicitly stored workspace records.

No transcript discovery, private extension storage, filesystem scanning, model
calls or network access. Knowledge remains owned by its optional provider.
"""
from db import get_db
from memory_manager import search_memory_entries_rows, _MEMORY_ENTRY_BUCKET_COLUMNS


SEARCH_TYPES = ("tasks", "knowledge", "messages", "files", "memory")
_BUCKETS = {
    "tasks": (
        "tasks", "id, title, description, acceptance_criteria, status, result_summary, lessons_learned, important_notes, updated_at",
        ("title", "description", "acceptance_criteria", "result_summary", "lessons_learned", "important_notes"), "updated_at",
    ),
    "messages": (
        "peer_messages", "id, from_session_id, topic, content, priority, created_at",
        ("topic", "content"), "created_at",
    ),
    "files": (
        "file_activity", "id, file_path, session_id, session_name, task_summary, task_title, tool_name, created_at",
        ("file_path", "task_summary", "task_title"), "created_at",
    ),
}


async def search_workspace_context(workspace_id, query, types, limit, *, include_global=False):
    terms = list(dict.fromkeys(query.split()))[:12]
    results = {kind: [] for kind in types}
    db = await get_db()
    try:
        for kind in types:
            if kind not in _BUCKETS:
                continue
            table, columns, fields, order = _BUCKETS[kind]
            clauses, params = [], [workspace_id]
            for term in terms:
                escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                clauses.extend(f"{field} LIKE ? ESCAPE '\\'" for field in fields)
                params.extend([f"%{escaped}%"] * len(fields))
            cur = await db.execute(
                f"SELECT {columns} FROM {table} WHERE workspace_id = ? "
                f"AND ({' OR '.join(clauses)}) ORDER BY {order} DESC, id DESC LIMIT ?",
                (*params, limit),
            )
            results[kind] = [dict(row) for row in await cur.fetchall()]
    finally:
        await db.close()
    if "memory" in types:
        # Reuse the notes query shared with the Memory window. Try the phrase
        # first, then individual terms so natural multi-keyword MCP queries work.
        seen = set()
        for term in dict.fromkeys([query, *terms]):
            rows = await search_memory_entries_rows(
                term, workspace_id=workspace_id, include_global=include_global,
                limit=limit, columns=_MEMORY_ENTRY_BUCKET_COLUMNS,
            )
            for row in rows:
                if row["id"] not in seen:
                    seen.add(row["id"])
                    results["memory"].append(row)
            if len(results["memory"]) >= limit:
                break
        results["memory"] = results["memory"][:limit]
    return {
        "workspace_id": workspace_id, "query": query, "results": results,
        "total": sum(len(rows) for rows in results.values()),
        "unavailable_types": ["knowledge"] if "knowledge" in types else [],
        "notes": (["Knowledge search is unavailable in the installed context provider."]
                  if "knowledge" in types else []),
    }
