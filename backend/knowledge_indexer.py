"""Index workspace knowledge entries as myelin nodes for semantic dedup.

Mirrors ticket_indexer's shape but uses a separate namespace
(`ive:knowledge:<workspace_id>`) and `kind=knowledge`. Dedup uses cosine
similarity at the CONFLICT threshold (>=0.80) — when an incoming entry
restates an existing one in the same (category, scope), we confirm the
existing entry instead of inserting.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from peer_comms import _LocalHashEmbedding, _ensure_myelin_path, _try_import_myelin

logger = logging.getLogger("ive.knowledge_indexer")

KNOWLEDGE_KIND = "knowledge"

_brain_cache: dict[str, Any] = {}
_brain_lock = asyncio.Lock()


def _ns(workspace_id: str) -> str:
    return f"ive:knowledge:{workspace_id}"


async def _get_brain(workspace_id: str):
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
            logger.warning("knowledge indexer init failed for %s: %s", workspace_id, e)
            _brain_cache[workspace_id] = None
            return None


def _label(entry_id: str) -> str:
    return f"knowledge:{entry_id}"


def _dense_form(category: str, scope: str, content: str) -> str:
    parts = [f"Knowledge ({category})"]
    if scope:
        parts.append(f"scope: {scope}")
    parts.append(content[:1200])
    return ". ".join(parts)


async def find_duplicate(
    workspace_id: str,
    category: str,
    scope: str,
    content: str,
) -> dict | None:
    """Return the existing knowledge entry whose semantic content matches
    the incoming entry at CONFLICT level (>=0.80). Filters to the same
    (category, scope) — different categories/scopes can express similar
    wording legitimately.

    Returns {entry_id, score} or None.
    """
    brain = await _get_brain(workspace_id)
    if brain is None or not content:
        return None

    from myelin import _cosine_sim
    from myelin.coordination.workspace import OverlapLevel

    await brain._ensure_init()
    q_text = _dense_form(category, scope, content)
    q_vecs = await brain._embedder.embed([q_text])
    if not q_vecs:
        return None
    q_emb = q_vecs[0]

    storage = brain._storage
    try:
        ranked = await storage.vector_search(
            namespace=_ns(workspace_id),
            embedding=q_emb,
            kind=KNOWLEDGE_KIND,
            limit=20,
            time_at=None,
            access_level="namespace",
        )
    except Exception:
        return None

    best: tuple[str, float] | None = None
    for it in ranked:
        if isinstance(it, tuple):
            node, score = it
        else:
            node, score = it, None
        if node.valid_until is not None:
            continue
        props = node.properties or {}
        if (props.get("category") or "") != (category or ""):
            continue
        if (props.get("scope") or "") != (scope or ""):
            continue
        if score is None:
            score = _cosine_sim(q_emb, node.embedding) if node.embedding else 0.0
        level = OverlapLevel.from_score(score)
        if level == OverlapLevel.CONFLICT:
            entry_id = props.get("entry_id")
            if entry_id and (best is None or score > best[1]):
                best = (entry_id, score)

    if best:
        return {"entry_id": best[0], "score": round(best[1], 4)}
    return None


async def index_entry(
    workspace_id: str,
    entry_id: str,
    category: str,
    scope: str,
    content: str,
    contributed_by: str | None = None,
) -> str | None:
    brain = await _get_brain(workspace_id)
    if brain is None or not content:
        return None
    props = {
        "entry_id": entry_id,
        "workspace_id": workspace_id,
        "category": category or "",
        "scope": scope or "",
        "contributed_by": contributed_by or "",
    }
    try:
        result = await brain.execute("myelin_remember", {
            "kind": KNOWLEDGE_KIND,
            "label": _label(entry_id),
            "dense_form": _dense_form(category, scope, content),
            "source_excerpt": content,
            "properties": props,
            "salience": 0.6,
        })
        return result.get("node_id") or result.get("id")
    except Exception as e:
        logger.warning("index_entry failed for %s: %s", entry_id, e)
        return None


async def backfill_workspace(workspace_id: str, db) -> int:
    brain = await _get_brain(workspace_id)
    if brain is None:
        return 0
    cur = await db.execute(
        "SELECT id, category, scope, content, contributed_by FROM workspace_knowledge "
        "WHERE workspace_id = ?",
        (workspace_id,),
    )
    rows = await cur.fetchall()
    if not rows:
        return 0
    indexed = 0
    for row in rows:
        d = dict(row)
        existing = await brain._storage.query_nodes(
            namespace=_ns(workspace_id),
            kind=KNOWLEDGE_KIND,
            label=_label(d["id"]),
            limit=1,
            select="id",
        )
        if existing:
            continue
        node_id = await index_entry(
            workspace_id=workspace_id,
            entry_id=d["id"],
            category=d.get("category") or "",
            scope=d.get("scope") or "",
            content=d.get("content") or "",
            contributed_by=d.get("contributed_by"),
        )
        if node_id:
            indexed += 1
    if indexed:
        logger.info("backfilled %d knowledge entries for workspace %s", indexed, workspace_id)
    return indexed
