"""Index IVE tickets as myelin nodes for semantic retrieval.

One myelin namespace per workspace (`ive:tickets:<workspace_id>`), one node
per ticket (label=`ticket:<task_id>`). The dense form combines title +
description + acceptance_criteria + labels so retrieval matches on intent,
not just title fragments. The full description is preserved as `_source`
and only fetched on demand.

Reuses the same SQLite/embedder stack as `peer_comms` so coord DB and
ticket index share storage; only the namespace differs.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from peer_comms import _LocalHashEmbedding, _ensure_myelin_path, _try_import_myelin

logger = logging.getLogger("ive.ticket_indexer")

TICKET_KIND = "ticket"

_brain_cache: dict[str, Any] = {}
_brain_lock = asyncio.Lock()


def _ns(workspace_id: str) -> str:
    return f"ive:tickets:{workspace_id}"


async def _get_brain(workspace_id: str):
    """Lazy-init one Myelin per workspace. Returns None if myelin unavailable."""
    if workspace_id in _brain_cache:
        return _brain_cache[workspace_id]
    async with _brain_lock:
        if workspace_id in _brain_cache:
            return _brain_cache[workspace_id]
        if not _try_import_myelin():
            _brain_cache[workspace_id] = None
            return None
        _ensure_myelin_path()
        from myelin import Myelin
        from myelin.core.embeddings import GeminiEmbedding
        from myelin.storage.sqlite import SQLiteStorage

        db_path = os.environ.get("MYELIN_DB_PATH", os.path.expanduser("~/.myelin/coord.db"))

        if os.environ.get("GOOGLE_API_KEY"):
            embedder: Any = GeminiEmbedding()
        else:
            embedder = _LocalHashEmbedding()

        try:
            os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
            storage = SQLiteStorage(db_path=db_path, embedding_dims=3072)
            brain = Myelin(namespace=_ns(workspace_id), storage=storage, embedder=embedder)
            _brain_cache[workspace_id] = brain
            return brain
        except Exception as e:
            logger.warning("ticket indexer init failed for %s: %s", workspace_id, e)
            _brain_cache[workspace_id] = None
            return None


def _dense_form(task: dict) -> str:
    """Self-contained sentence used as the embedding input.

    Order matters: title first (highest signal), then AC (concrete intent),
    then a bounded slice of description (avoid drowning embedding in prose),
    then labels.
    """
    title = (task.get("title") or "").strip()
    desc = (task.get("description") or "").strip()
    ac = (task.get("acceptance_criteria") or "").strip()
    labels_raw = task.get("labels") or ""
    if isinstance(labels_raw, list):
        labels = ", ".join(str(x) for x in labels_raw)
    else:
        labels = str(labels_raw).replace(",", ", ")

    parts = [f'Ticket: "{title}"']
    if ac:
        parts.append(f"Acceptance: {ac[:400]}")
    if desc:
        parts.append(f"Description: {desc[:600]}")
    if labels:
        parts.append(f"Labels: {labels}")
    return ". ".join(parts)


def _label(task_id: str) -> str:
    return f"ticket:{task_id}"


async def _find_node_id(brain, workspace_id: str, task_id: str) -> str | None:
    """Look up a ticket node id by deterministic label."""
    try:
        await brain._ensure_init()
        rows = await brain._storage.query_nodes(
            namespace=_ns(workspace_id),
            kind=TICKET_KIND,
            label=_label(task_id),
            limit=1,
            select="id",
        )
        if rows:
            return rows[0]["id"]
    except Exception as e:
        logger.debug("find_node_id failed for %s: %s", task_id, e)
    return None


async def index_ticket(task: dict) -> str | None:
    """Insert a myelin node for a newly created ticket. Idempotent: re-uses
    existing node when one already exists for this task_id (treats it as
    a reindex)."""
    workspace_id = task.get("workspace_id")
    task_id = task.get("id")
    if not workspace_id or not task_id:
        return None

    brain = await _get_brain(workspace_id)
    if brain is None:
        return None

    existing = await _find_node_id(brain, workspace_id, task_id)
    if existing:
        return await reindex_ticket(task)

    dense = _dense_form(task)
    props = {
        "task_id": task_id,
        "workspace_id": workspace_id,
        "title": task.get("title"),
        "status": task.get("status") or "backlog",
        "assigned_session_id": task.get("assigned_session_id"),
        "labels": task.get("labels") or "",
    }
    try:
        result = await brain.execute("myelin_remember", {
            "kind": TICKET_KIND,
            "label": _label(task_id),
            "dense_form": dense,
            "source_excerpt": task.get("description") or "",
            "properties": props,
            "salience": 0.7,
        })
        return result.get("node_id") or result.get("id")
    except Exception as e:
        logger.warning("index_ticket failed for %s: %s", task_id, e)
        return None


async def reindex_ticket(task: dict) -> str | None:
    """Re-embed a ticket whose title/description/AC/labels changed.

    Strategy: tombstone the old node (set valid_until) and insert a fresh
    node. Cheaper than mutating embeddings in place and gives a free audit
    trail of past intents in the graph.
    """
    workspace_id = task.get("workspace_id")
    task_id = task.get("id")
    if not workspace_id or not task_id:
        return None

    brain = await _get_brain(workspace_id)
    if brain is None:
        return None

    old_id = await _find_node_id(brain, workspace_id, task_id)
    if old_id:
        try:
            from datetime import datetime, timezone
            await brain._ensure_init()
            await brain._storage.update_node_fields(old_id, {
                "valid_until": datetime.now(timezone.utc).isoformat(),
            })
        except Exception as e:
            logger.debug("reindex tombstone failed for %s: %s", task_id, e)

    dense = _dense_form(task)
    props = {
        "task_id": task_id,
        "workspace_id": workspace_id,
        "title": task.get("title"),
        "status": task.get("status") or "backlog",
        "assigned_session_id": task.get("assigned_session_id"),
        "labels": task.get("labels") or "",
    }
    try:
        result = await brain.execute("myelin_remember", {
            "kind": TICKET_KIND,
            "label": _label(task_id),
            "dense_form": dense,
            "source_excerpt": task.get("description") or "",
            "properties": props,
            "salience": 0.7,
        })
        return result.get("node_id") or result.get("id")
    except Exception as e:
        logger.warning("reindex_ticket failed for %s: %s", task_id, e)
        return None


async def update_ticket_metadata(workspace_id: str, task_id: str, fields: dict) -> None:
    """Update non-embedding properties (status, assigned_session_id) without
    re-embedding. Use this when a status changes but the intent hasn't —
    avoids burning embedding API quota on every status flip."""
    if not workspace_id or not task_id or not fields:
        return
    brain = await _get_brain(workspace_id)
    if brain is None:
        return
    node_id = await _find_node_id(brain, workspace_id, task_id)
    if not node_id:
        return
    try:
        node = await brain._storage.get_node(node_id)
        if not node:
            return
        new_props = dict(node.properties or {})
        new_props.update({k: v for k, v in fields.items() if k in (
            "status", "assigned_session_id", "labels", "title",
        )})
        await brain._storage.update_node_fields(node_id, {"properties": new_props})
    except Exception as e:
        logger.debug("update_ticket_metadata failed for %s: %s", task_id, e)


async def delete_ticket_index(workspace_id: str, task_id: str) -> None:
    """Tombstone (set valid_until) the ticket's myelin node. We don't hard-
    delete: deleted tickets remain queryable as historical context."""
    brain = await _get_brain(workspace_id)
    if brain is None:
        return
    node_id = await _find_node_id(brain, workspace_id, task_id)
    if not node_id:
        return
    try:
        from datetime import datetime, timezone
        await brain._ensure_init()
        await brain._storage.update_node_fields(node_id, {
            "valid_until": datetime.now(timezone.utc).isoformat(),
        })
    except Exception as e:
        logger.debug("delete_ticket_index failed for %s: %s", task_id, e)


async def backfill_workspace(workspace_id: str, db) -> int:
    """Scan tasks in a workspace and index any that don't yet have a myelin
    node. Returns the number of tickets newly indexed.

    Caller passes an open aiosqlite connection so this can run on startup
    without contending with the per-request DB pool."""
    brain = await _get_brain(workspace_id)
    if brain is None:
        return 0

    cur = await db.execute(
        "SELECT id, workspace_id, title, description, acceptance_criteria, status, "
        "assigned_session_id, labels FROM tasks WHERE workspace_id = ?",
        (workspace_id,),
    )
    rows = await cur.fetchall()

    indexed = 0
    for row in rows:
        task = dict(row)
        existing = await _find_node_id(brain, workspace_id, task["id"])
        if existing:
            continue
        node_id = await index_ticket(task)
        if node_id:
            indexed += 1
    if indexed:
        logger.info("backfilled %d tickets for workspace %s", indexed, workspace_id)
    return indexed


def _embedder_for_workspace(workspace_id: str):
    """Expose the brain's embedder for retriever code that needs to embed
    queries with the same model the index was built with."""
    brain = _brain_cache.get(workspace_id)
    return brain._embedder if brain else None
