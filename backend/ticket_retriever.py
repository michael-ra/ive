"""Semantic ticket retrieval over the myelin index.

Pure cosine via myelin's `vector_search` is the default. When a caller
supplies `files_touched`, we fuse cosine rank with file-set Jaccard rank
via Reciprocal Rank Fusion — this lets a worker that's editing
`backend/auth.py` find the open ticket about auth even when the title
doesn't quite match.

The level bands (CONFLICT/SHARE/NOTIFY/TANGENT/UNRELATED) come straight
from `OverlapLevel` in the myelin coordination module, so there are no
magic numbers in IVE code.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from ticket_indexer import TICKET_KIND, _get_brain, _ns

logger = logging.getLogger("ive.ticket_retriever")

RRF_K = 60  # Standard RRF constant; the tail is what matters, not the value.


@dataclass
class TicketCandidate:
    task_id: str
    title: str
    score: float
    level: str
    status: str
    assigned_session_id: str | None
    snippet: str
    files_touched: list[str] = field(default_factory=list)
    rank_signals: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "title": self.title,
            "score": round(self.score, 4),
            "level": self.level,
            "status": self.status,
            "assigned_session_id": self.assigned_session_id,
            "snippet": self.snippet,
            "files_touched": self.files_touched,
            "rank_signals": self.rank_signals,
        }


def _node_to_candidate(node, score: float, level_cls) -> TicketCandidate:
    props = node.properties or {}
    title = props.get("title") or props.get("_dense") or node.label or ""
    snippet = (props.get("_source") or "")[:280]
    return TicketCandidate(
        task_id=props.get("task_id", ""),
        title=title,
        score=score,
        level=level_cls.from_score(score).value,
        status=props.get("status") or "",
        assigned_session_id=props.get("assigned_session_id"),
        snippet=snippet,
        files_touched=list(props.get("files_touched") or []),
    )


def _jaccard(a: list[str], b: list[str]) -> float:
    if not a or not b:
        return 0.0
    sa, sb = set(a), set(b)
    inter = len(sa & sb)
    union = len(sa | sb)
    return inter / union if union else 0.0


async def find_related(
    workspace_id: str,
    query: str,
    files_touched: list[str] | None = None,
    status_filter: str | list[str] | None = None,
    exclude_task_id: str | None = None,
    limit: int = 10,
) -> list[TicketCandidate]:
    """Return ranked ticket candidates for a query.

    `status_filter`:
      - None: no filter
      - "open": exclude done/verified/cancelled
      - explicit list: keep only those statuses
    """
    brain = await _get_brain(workspace_id)
    if brain is None or not query:
        return []

    from myelin import _cosine_sim
    from myelin.coordination.workspace import OverlapLevel

    await brain._ensure_init()
    q_vecs = await brain._embedder.embed([query])
    if not q_vecs:
        return []
    q_emb = q_vecs[0]

    storage = brain._storage
    ns = _ns(workspace_id)

    # Over-fetch so we can drop tombstoned/filtered nodes and still hit `limit`.
    over = max(limit * 4, 20)
    try:
        ranked = await storage.vector_search(
            namespace=ns,
            embedding=q_emb,
            kind=TICKET_KIND,
            limit=over,
            time_at=None,
            access_level="namespace",
        )
    except Exception as e:
        logger.warning("vector_search failed (%s) — falling back to linear scan", e)
        return await _linear_fallback(
            brain, q_emb, ns, files_touched, status_filter, exclude_task_id, limit,
        )

    items: list[tuple[Any, float]] = []
    missing_ids: list[str] = []
    for it in ranked:
        if isinstance(it, tuple):
            node, score = it
        else:
            node, score = it, None
        items.append((node, score))
        if score is None and not node.embedding:
            missing_ids.append(node.id)

    emb_map: dict[str, list[float]] = {}
    if missing_ids:
        try:
            refetched = await storage.get_nodes_batch(missing_ids)
            emb_map = {n.id: n.embedding for n in refetched if n.embedding}
        except Exception:
            pass

    open_excludes = {"done", "verified", "cancelled", "deleted"}
    keep_statuses: set[str] | None = None
    if isinstance(status_filter, list):
        keep_statuses = {s.lower() for s in status_filter}
    elif isinstance(status_filter, str) and status_filter not in ("open", "all", ""):
        keep_statuses = {status_filter.lower()}

    cosine_ranked: list[tuple[Any, float]] = []
    for node, score in items:
        if node.valid_until is not None:
            continue
        props = node.properties or {}
        if exclude_task_id and props.get("task_id") == exclude_task_id:
            continue
        status = (props.get("status") or "").lower()
        if status_filter == "open" and status in open_excludes:
            continue
        if keep_statuses is not None and status not in keep_statuses:
            continue
        if score is None:
            emb = node.embedding or emb_map.get(node.id)
            score = _cosine_sim(q_emb, emb) if emb else 0.0
        cosine_ranked.append((node, score))

    cosine_ranked.sort(key=lambda t: -t[1])

    if not files_touched:
        candidates = [_node_to_candidate(n, s, OverlapLevel) for n, s in cosine_ranked[:limit]]
        for c, (_, s) in zip(candidates, cosine_ranked[:limit]):
            c.rank_signals = {"cosine": round(s, 4)}
        return candidates

    # File-set RRF fusion. Compute Jaccard against each candidate's
    # files_touched, then combine with cosine rank.
    jaccard_scored = [
        (n, _jaccard(files_touched, list((n.properties or {}).get("files_touched") or [])))
        for n, _ in cosine_ranked
    ]
    jaccard_ranked = sorted(jaccard_scored, key=lambda t: -t[1])

    cosine_rank = {n.id: i for i, (n, _) in enumerate(cosine_ranked)}
    jaccard_rank = {n.id: i for i, (n, _) in enumerate(jaccard_ranked)}
    fused: list[tuple[Any, float, float, float]] = []
    for node, cos in cosine_ranked:
        cr = cosine_rank.get(node.id, len(cosine_ranked))
        jr = jaccard_rank.get(node.id, len(jaccard_ranked))
        # RRF: contributions decay by 1/(k+rank). Cosine still dominates
        # via its raw value used as the candidate's reported score.
        rrf = 1.0 / (RRF_K + cr) + 1.0 / (RRF_K + jr)
        jac = next((j for n, j in jaccard_scored if n.id == node.id), 0.0)
        fused.append((node, cos, jac, rrf))

    fused.sort(key=lambda t: -t[3])
    out: list[TicketCandidate] = []
    for node, cos, jac, rrf in fused[:limit]:
        cand = _node_to_candidate(node, cos, OverlapLevel)
        cand.rank_signals = {
            "cosine": round(cos, 4),
            "file_jaccard": round(jac, 4),
            "rrf": round(rrf, 4),
        }
        out.append(cand)
    return out


async def _linear_fallback(
    brain, q_emb, ns, files_touched, status_filter, exclude_task_id, limit,
):
    from myelin import _cosine_sim
    from myelin.coordination.workspace import OverlapLevel

    rows = await brain._storage.query_nodes(
        namespace=ns, kind=TICKET_KIND, limit=500,
        select="id, namespace, kind, label, properties",
    )
    if not rows:
        return []
    nodes = await brain._storage.get_nodes_batch([r["id"] for r in rows])

    open_excludes = {"done", "verified", "cancelled", "deleted"}
    keep_statuses: set[str] | None = None
    if isinstance(status_filter, list):
        keep_statuses = {s.lower() for s in status_filter}
    elif isinstance(status_filter, str) and status_filter not in ("open", "all", ""):
        keep_statuses = {status_filter.lower()}

    scored: list[tuple[Any, float]] = []
    for node in nodes:
        if not node.embedding or node.valid_until is not None:
            continue
        props = node.properties or {}
        if exclude_task_id and props.get("task_id") == exclude_task_id:
            continue
        status = (props.get("status") or "").lower()
        if status_filter == "open" and status in open_excludes:
            continue
        if keep_statuses is not None and status not in keep_statuses:
            continue
        scored.append((node, _cosine_sim(q_emb, node.embedding)))
    scored.sort(key=lambda t: -t[1])
    return [_node_to_candidate(n, s, OverlapLevel) for n, s in scored[:limit]]


async def get_ticket_embedding(workspace_id: str, task_id: str) -> list[float] | None:
    """Fetch the stored embedding for a specific ticket. Used by the drift
    gate to compare a worker's current_focus against its bound ticket
    without re-embedding the ticket text."""
    from ticket_indexer import _find_node_id
    brain = await _get_brain(workspace_id)
    if brain is None:
        return None
    node_id = await _find_node_id(brain, workspace_id, task_id)
    if not node_id:
        return None
    try:
        await brain._ensure_init()
        node = await brain._storage.get_node(node_id)
        if node and node.embedding:
            return list(node.embedding)
    except Exception as e:
        logger.debug("get_ticket_embedding failed for %s: %s", task_id, e)
    return None


async def embed_text(workspace_id: str, text: str) -> list[float] | None:
    """Embed an arbitrary string with the same embedder the index uses."""
    brain = await _get_brain(workspace_id)
    if brain is None or not text:
        return None
    try:
        await brain._ensure_init()
        vecs = await brain._embedder.embed([text])
        return vecs[0] if vecs else None
    except Exception as e:
        logger.debug("embed_text failed for %s: %s", workspace_id, e)
        return None
