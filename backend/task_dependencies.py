"""Shared task dependency readiness helpers."""
from __future__ import annotations

import json
from typing import Any

DONE_STATUSES = {"done", "verified"}


def parse_depends_on(raw: Any) -> list[str]:
    """Parse a task depends_on value into stable, de-duplicated task ids."""
    if raw is None or raw == "":
        return []
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, str):
        stripped = raw.strip()
        if not stripped or stripped == "[]":
            return []
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, list):
                items = parsed
            else:
                items = [parsed]
        except json.JSONDecodeError:
            items = [p.strip() for p in stripped.split(",")]
    else:
        items = [raw]

    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        dep_id = str(item or "").strip()
        if dep_id and dep_id not in seen:
            seen.add(dep_id)
            result.append(dep_id)
    return result


async def get_task_ready(db, task_id: str, task_row: dict | None = None) -> dict | None:
    """Return {ready, blockers} for a task, or None when task is missing."""
    if task_row is None:
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        row = await cur.fetchone()
        if not row:
            return None
        task_row = dict(row)

    dep_ids = parse_depends_on(task_row.get("depends_on"))
    blockers: list[dict] = []
    dep_rows: dict[str, dict] = {}

    if dep_ids:
        placeholders = ",".join("?" for _ in dep_ids)
        cur = await db.execute(
            f"SELECT id, workspace_id, title, status FROM tasks WHERE id IN ({placeholders})",
            dep_ids,
        )
        dep_rows = {row["id"]: dict(row) for row in await cur.fetchall()}

    for dep_id in dep_ids:
        dep = dep_rows.get(dep_id)
        if not dep:
            blockers.append({
                "id": dep_id,
                "title": None,
                "status": "missing",
                "missing": True,
            })
            continue
        status = dep.get("status") or "backlog"
        if status not in DONE_STATUSES:
            blockers.append({
                "id": dep["id"],
                "workspace_id": dep.get("workspace_id"),
                "title": dep.get("title"),
                "status": status,
                "missing": False,
            })

    # Research block: while a task points at an unfinished research entry it is
    # parked — not dispatchable and not manually assignable. The link is cleared
    # by auto_exec when RESEARCH_COMPLETED fires (success, failure, or cancel).
    research_id = (task_row.get("blocked_on_research_id") or "").strip()
    if research_id:
        blockers.append({
            "id": research_id,
            "kind": "research",
            "title": "blocked on research",
            "status": "in_progress",
            "missing": False,
        })

    return {
        "task_id": task_row.get("id") or task_id,
        "workspace_id": task_row.get("workspace_id"),
        "ready": not blockers,
        "dependency_ids": dep_ids,
        "blockers": blockers,
    }


def unmet_dependency_response(readiness: dict) -> dict:
    return {
        "error": "task_dependencies_unmet",
        "ready": False,
        "task_id": readiness.get("task_id"),
        "workspace_id": readiness.get("workspace_id"),
        "dependency_ids": readiness.get("dependency_ids", []),
        "blockers": readiness.get("blockers", []),
    }
