"""
Lightweight embedding infrastructure using fastembed.

Uses BAAI/bge-small-en-v1.5 (33MB ONNX model, CPU-only, ~5ms per embedding).
Embeddings are stored in SQLite as JSON float arrays for cosine similarity search.

Inspired by Myelin's multi-channel retrieval but stripped to the essential:
cosine similarity over dense vectors. No graph traversal, no keyword channels.

Entity types:
  - task       : completed tasks (title + description + result + lessons)
  - digest     : session digests (task_summary + focus + decisions + discoveries)
  - knowledge  : workspace knowledge entries (category + content + scope)
  - session    : session dense summaries (for cross-session search)
"""

import asyncio
import json
import logging
import math

logger = logging.getLogger(__name__)

_model = None
_model_lock = asyncio.Lock()

EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"  # 384 dimensions, 33MB ONNX
EMBEDDING_DIM = 384

_reranker = None
_reranker_lock = asyncio.Lock()

RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2"  # ~23MB ONNX cross-encoder

# Myelin-inspired overlap levels for coordination
OVERLAP_CONFLICT = 0.80   # same task — block/warn
OVERLAP_SHARE = 0.65      # related work — suggest knowledge exchange
OVERLAP_NOTIFY = 0.55     # tangentially related — FYI


async def _get_model():
    """Lazy-load the embedding model on first use."""
    global _model
    if _model is None:
        async with _model_lock:
            if _model is None:
                try:
                    from fastembed import TextEmbedding
                    logger.info("Loading embedding model %s ...", EMBEDDING_MODEL)
                    _model = await asyncio.to_thread(
                        TextEmbedding, model_name=EMBEDDING_MODEL
                    )
                    logger.info("Embedding model loaded.")
                except ImportError:
                    logger.warning("fastembed not installed — embedding features disabled")
                    return None
                except Exception as exc:
                    logger.warning("Failed to load embedding model: %s", exc)
                    return None
    return _model


async def _get_reranker():
    """Lazy-load the cross-encoder reranker on first use."""
    global _reranker
    if _reranker is None:
        async with _reranker_lock:
            if _reranker is None:
                try:
                    from fastembed.rerank.cross_encoder import TextCrossEncoder
                    logger.info("Loading reranker model %s ...", RERANK_MODEL)
                    _reranker = await asyncio.to_thread(
                        TextCrossEncoder, model_name=RERANK_MODEL
                    )
                    logger.info("Reranker model loaded.")
                except ImportError:
                    logger.warning("fastembed reranker not available")
                    return None
                except Exception as exc:
                    logger.warning("Failed to load reranker model: %s", exc)
                    return None
    return _reranker


def _cosine(a: list[float], b: list[float]) -> float:
    """Pure-Python cosine similarity (no numpy dependency at module level)."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


async def embed(text: str) -> list[float] | None:
    """Embed a single text string. Returns a 384-dim float vector, or None if unavailable."""
    model = await _get_model()
    if model is None:
        return None
    vectors = await asyncio.to_thread(lambda: list(model.embed([text])))
    return [float(x) for x in vectors[0]]


async def embed_batch(texts: list[str]) -> list[list[float]] | None:
    """Embed multiple texts."""
    model = await _get_model()
    if model is None:
        return None
    vectors = await asyncio.to_thread(lambda: list(model.embed(texts)))
    return [[float(x) for x in v] for v in vectors]


async def rerank(query: str, documents: list[str]) -> list[float] | None:
    """Score query-document pairs with a cross-encoder.

    Returns raw logit scores in document order (one per document),
    or None if the reranker is unavailable. Caller handles normalization.
    """
    if not documents:
        return None
    reranker = await _get_reranker()
    if reranker is None:
        return None
    scores = await asyncio.to_thread(
        lambda: [float(s) for s in reranker.rerank(query, documents)]
    )
    return scores


# ── Dense text builders ──────────────────────────────────────────────────
# Following Myelin's "dense form" pattern: terse, self-contained sentences
# that drop articles and filler for better embedding quality.

def task_dense_text(task: dict) -> str:
    """Build dense text for a completed task."""
    parts = []
    if task.get("title"):
        parts.append(task["title"])
    if task.get("description"):
        parts.append(task["description"][:300])
    if task.get("result_summary"):
        parts.append(f"Result: {task['result_summary'][:200]}")
    if task.get("lessons_learned"):
        parts.append(f"Lessons: {task['lessons_learned'][:300]}")
    if task.get("important_notes"):
        parts.append(f"Notes: {task['important_notes'][:200]}")
    return " | ".join(parts) or "unknown task"


def digest_dense_text(digest: dict) -> str:
    """Build dense text for a session digest."""
    parts = []
    if digest.get("task_summary"):
        parts.append(digest["task_summary"])
    if digest.get("current_focus"):
        parts.append(f"Focus: {digest['current_focus']}")
    decisions = digest.get("decisions")
    if isinstance(decisions, str):
        try:
            decisions = json.loads(decisions)
        except Exception:
            decisions = []
    if decisions:
        parts.append(f"Decisions: {'; '.join(decisions[:5])}")
    discoveries = digest.get("discoveries")
    if isinstance(discoveries, str):
        try:
            discoveries = json.loads(discoveries)
        except Exception:
            discoveries = []
    if discoveries:
        parts.append(f"Discoveries: {'; '.join(discoveries[:5])}")
    files = digest.get("files_touched")
    if isinstance(files, str):
        try:
            files = json.loads(files)
        except Exception:
            files = []
    if files:
        parts.append(f"Files: {', '.join(files[-5:])}")
    return " | ".join(parts) or "unknown session"


def knowledge_dense_text(entry: dict) -> str:
    """Build dense text for a knowledge entry."""
    if entry.get("category") == "code_catalog":
        from code_catalog_parser import parse_line, dense_text
        parsed = parse_line(entry.get("content") or "")
        catalog_text = dense_text(parsed)
        if catalog_text:
            return catalog_text
    parts = [entry.get("category", ""), entry.get("content", "")]
    if entry.get("scope"):
        parts.append(f"[{entry['scope']}]")
    return " ".join(p for p in parts if p)


def guideline_dense_text(guideline: dict) -> str:
    """Build dense text for a guideline, including when_to_use for applicability matching."""
    parts = [guideline.get("name", "")]
    if guideline.get("when_to_use"):
        parts.append(f"Use when: {guideline['when_to_use']}")
    content = guideline.get("content", "")
    if content:
        parts.append(content[:400])
    return " | ".join(p for p in parts if p) or "unknown guideline"


# ── Storage helpers ──────────────────────────────────────────────────────

async def store_embedding(
    entity_type: str,
    entity_id: str,
    text: str,
    workspace_id: str | None = None,
):
    """Embed text and store in the embeddings table."""
    vector = await embed(text)
    if vector is None:
        return  # fastembed not available
    from db import get_db
    db = await get_db()
    try:
        await db.execute(
            """INSERT OR REPLACE INTO embeddings
               (entity_type, entity_id, workspace_id, dense_text, vector, updated_at)
               VALUES (?, ?, ?, ?, ?, datetime('now'))""",
            (entity_type, entity_id, workspace_id, text[:500], json.dumps(vector)),
        )
        await db.commit()
    finally:
        await db.close()


async def search_similar(
    query: str,
    entity_type: str,
    workspace_id: str | None = None,
    limit: int = 10,
    min_score: float = 0.3,
    exclude_id: str | None = None,
) -> list[dict]:
    """Find similar entities by cosine similarity."""
    query_vec = await embed(query)
    if query_vec is None:
        return []

    from db import get_db
    db = await get_db()
    try:
        sql = "SELECT entity_id, dense_text, vector FROM embeddings WHERE entity_type = ?"
        params: list = [entity_type]
        if workspace_id:
            sql += " AND workspace_id = ?"
            params.append(workspace_id)
        if exclude_id:
            sql += " AND entity_id != ?"
            params.append(exclude_id)
        cur = await db.execute(sql, params)
        rows = await cur.fetchall()
    finally:
        await db.close()

    results = []
    for row in rows:
        try:
            stored_vec = json.loads(row["vector"])
        except (json.JSONDecodeError, TypeError):
            continue
        score = _cosine(query_vec, stored_vec)
        if score >= min_score:
            results.append({
                "entity_id": row["entity_id"],
                "dense_text": row["dense_text"],
                "score": round(score, 4),
            })

    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:limit]


# ── Coordination: overlap detection ──────────────────────────────────────

async def check_overlap(
    intent: str,
    workspace_id: str,
    exclude_session_id: str | None = None,
) -> list[dict]:
    """Check if a session's intent overlaps with active peers (Myelin-inspired).

    Returns overlapping sessions with their overlap level:
      - conflict (>=0.80): very similar work
      - share (0.65-0.80): related, exchange knowledge
      - notify (0.55-0.65): tangentially related
    """
    results = await search_similar(
        query=intent,
        entity_type="digest",
        workspace_id=workspace_id,
        limit=10,
        min_score=OVERLAP_NOTIFY,
        exclude_id=exclude_session_id,
    )

    for r in results:
        score = r["score"]
        if score >= OVERLAP_CONFLICT:
            r["level"] = "conflict"
        elif score >= OVERLAP_SHARE:
            r["level"] = "share"
        else:
            r["level"] = "notify"

    return results


# ── Convenience: embed on entity lifecycle ───────────────────────────────

async def embed_task(task: dict):
    """Embed a completed task for future similarity search."""
    text = task_dense_text(task)
    await store_embedding("task", task["id"], text, task.get("workspace_id"))


async def embed_digest(digest: dict):
    """Embed a session digest for coordination and session search."""
    text = digest_dense_text(digest)
    await store_embedding(
        "digest", digest.get("session_id", digest.get("id", "")),
        text, digest.get("workspace_id"),
    )


async def embed_knowledge(entry: dict):
    """Embed a knowledge entry for semantic retrieval."""
    text = knowledge_dense_text(entry)
    await store_embedding("knowledge", entry["id"], text, entry.get("workspace_id"))


async def embed_guideline(guideline: dict):
    """Embed a guideline for semantic similarity search by the session advisor."""
    text = guideline_dense_text(guideline)
    await store_embedding("guideline", guideline["id"], text)


async def remove_guideline_embedding(guideline_id: str):
    """Remove a guideline's embedding when the guideline is deleted."""
    from db import get_db
    db = await get_db()
    try:
        await db.execute(
            "DELETE FROM embeddings WHERE entity_type = 'guideline' AND entity_id = ?",
            (guideline_id,),
        )
        await db.commit()
    finally:
        await db.close()
