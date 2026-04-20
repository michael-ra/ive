"""Agent workspace — coordination layer over a shared Myelin graph.

Uses only Myelin's public API (execute, batch_remember, recall). Zero core changes.

Data model:
    agent_task nodes: kind="agent_task", dense_form=intent, _source=full reasoning
    status tracked in properties: active | paused | completed
    agent_id, repo, files_touched, started_at in properties
    lessons learned appended as properties after completion
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from myelin import Myelin

logger = logging.getLogger("myelin.coordination")


class OverlapLevel(str, Enum):
    """Graduated coordination levels based on semantic similarity.

    The cosine threshold IS the lock granularity. Different levels
    require different responses from the agent.
    """
    CONFLICT = "conflict"      # >= 0.80 — same task, one must yield
    SHARE = "share"            # 0.65-0.80 — same pattern, exchange knowledge
    NOTIFY = "notify"          # 0.55-0.65 — related, FYI only
    TANGENT = "tangent"        # 0.48-0.55 — log for reference
    UNRELATED = "unrelated"    # < 0.48 — ignore

    # Calibrated on Gemini embedding-2 (3072d). Embeddings are fully
    # deterministic (cosine 1.0 for same text). Same-intent cross-agent
    # scores are 0.90+ (confirmed). Production scenarios:
    #   same task:      0.94-0.98  (CONFLICT)
    #   same pattern:   0.67-0.87  (SHARE)
    #   related:        0.55-0.66  (NOTIFY)
    #   unrelated:      <0.55      (TANGENT/UNRELATED)

    @classmethod
    def from_score(cls, score: float) -> "OverlapLevel":
        if score >= 0.80:
            return cls.CONFLICT
        if score >= 0.65:
            return cls.SHARE
        if score >= 0.55:
            return cls.NOTIFY
        if score >= 0.48:
            return cls.TANGENT
        return cls.UNRELATED


@dataclass
class AgentTask:
    """A task an agent is working on. Stored as a Myelin fact node."""
    id: str
    agent_id: str
    intent: str                      # short description, gets embedded
    reasoning: str = ""              # full context, stored as _source
    status: str = "active"           # active | paused | completed
    files_touched: list[str] = field(default_factory=list)
    started_at: str = ""
    completed_at: str = ""
    lessons_learned: list[str] = field(default_factory=list)
    score: float = 0.0               # overlap score vs query (set by check_overlap)
    level: OverlapLevel = OverlapLevel.UNRELATED


class AgentWorkspace:
    """Shared coordination layer over a Myelin graph.

    Multiple agents read and write to the same namespace.
    The graph becomes a blackboard for emergent coordination.
    """

    TASK_KIND = "agent_task"
    STALE_SECONDS = 120  # tasks without heartbeat for 2min = stale

    def __init__(self, myelin: "Myelin"):
        self._myelin = myelin

    async def announce(
        self,
        agent_id: str,
        intent: str,
        reasoning: str = "",
        files_touched: list[str] | None = None,
        repo: str | None = None,
    ) -> AgentTask:
        """Announce a task. Other agents can detect and coordinate.

        The `intent` is embedded for similarity matching.
        The `reasoning` is stored as source, fetched only on conflict.
        """
        now = datetime.now(timezone.utc).isoformat()
        props: dict = {
            "agent_id": agent_id,
            "status": "active",
            "started_at": now,
            "last_heartbeat": now,
            "files_touched": files_touched or [],
        }
        if repo:
            props["repo"] = repo

        result = await self._myelin.execute("myelin_remember", {
            "kind": self.TASK_KIND,
            "dense_form": intent,
            "source_excerpt": reasoning,
            "properties": props,
            "salience": 0.8,  # tasks are important signals
        })

        task_id = result.get("node_id", "")
        logger.info("agent %s announced task: %s (id=%s)", agent_id, intent[:60], task_id[:8])

        return AgentTask(
            id=task_id,
            agent_id=agent_id,
            intent=intent,
            reasoning=reasoning,
            status="active",
            files_touched=files_touched or [],
            started_at=now,
        )

    async def check_overlap(
        self,
        intent: str,
        threshold: float = 0.50,
        only_active: bool = True,
        exclude_agent: str | None = None,
        limit: int = 10,
    ) -> list[AgentTask]:
        """Check for semantic overlap with existing agent tasks.

        Uses pure embedding cosine via storage.vector_search.
        Scales via HNSW (Postgres) / sqlite-vec / numpy.
        Pure cosine — never RRF — because for coordination we want
        meaning overlap, not multi-signal fact retrieval.
        """
        # Ensure Myelin is initialized (embedder, storage available)
        await self._myelin._ensure_init()

        # Embed the query intent
        q_vecs = await self._myelin._embedder.embed([intent])
        if not q_vecs:
            return []
        q_emb = q_vecs[0]

        # Use storage.vector_search — indexed cosine, scales to millions
        storage = self._myelin._storage
        try:
            nodes_ranked = await storage.vector_search(
                namespace=self._myelin.namespace,
                embedding=q_emb,
                kind=self.TASK_KIND,
                limit=limit * 3,  # over-fetch for status filtering
                time_at=None,
                access_level=self._myelin.read_scope,
            )
        except Exception as e:
            logger.warning("vector_search failed (%s), falling back to linear scan", e)
            return await self._linear_scan(q_emb, threshold, only_active, exclude_agent, limit)

        # vector_search returns (Node, score) tuples or just Node — handle both.
        # SQLite/Memory backends strip embeddings to save memory; if missing,
        # re-fetch via get_nodes_batch to enable scoring.
        from myelin import _cosine_sim
        tasks = []
        # First pass: extract IDs of nodes lacking embeddings
        items_norm = []
        missing_emb_ids = []
        for item in nodes_ranked:
            if isinstance(item, tuple):
                node, score = item
                items_norm.append((node, score))
            else:
                node = item
                items_norm.append((node, None))
                if not node.embedding:
                    missing_emb_ids.append(node.id)

        # Refetch missing embeddings in one batch
        emb_map: dict = {}
        if missing_emb_ids:
            try:
                refetched = await storage.get_nodes_batch(missing_emb_ids)
                emb_map = {n.id: n.embedding for n in refetched if n.embedding}
            except Exception:
                pass

        for node, score in items_norm:
            if score is None:
                emb = node.embedding or emb_map.get(node.id)
                score = _cosine_sim(q_emb, emb) if emb else 0.0
            if score < threshold:
                continue
            if node.valid_until is not None:
                continue
            props = node.properties or {}
            if only_active and props.get("status") != "active":
                continue
            # Skip stale tasks (no heartbeat for STALE_SECONDS)
            if only_active and props.get("last_heartbeat"):
                try:
                    hb = datetime.fromisoformat(props["last_heartbeat"])
                    age = (datetime.now(timezone.utc) - hb).total_seconds()
                    if age > self.STALE_SECONDS:
                        continue  # likely crashed agent
                except (ValueError, TypeError):
                    pass
            if exclude_agent and props.get("agent_id") == exclude_agent:
                continue

            tasks.append(AgentTask(
                id=node.id,
                agent_id=props.get("agent_id", "unknown"),
                intent=props.get("_dense", node.label),
                reasoning=(props.get("_source", "") or "")[:300],
                status=props.get("status", "unknown"),
                files_touched=props.get("files_touched", []),
                started_at=props.get("started_at", ""),
                lessons_learned=props.get("lessons_learned", []),
                score=score,
                level=OverlapLevel.from_score(score),
            ))
            if len(tasks) >= limit:
                break

        return tasks

    async def _linear_scan(
        self, q_emb, threshold, only_active, exclude_agent, limit,
    ) -> list[AgentTask]:
        """Fallback: linear scan via list_nodes + batch fetch + cosine."""
        from myelin import _cosine_sim
        all_nodes = await self._myelin.list_nodes(kind=self.TASK_KIND, limit=200)
        node_ids = [n["id"] for n in all_nodes]
        if not node_ids:
            return []
        nodes_batch = await self._myelin._storage.get_nodes_batch(node_ids)

        scored = []
        for node in nodes_batch:
            if not node.embedding or node.valid_until is not None:
                continue
            props = node.properties or {}
            if only_active and props.get("status") != "active":
                continue
            if only_active and props.get("last_heartbeat"):
                try:
                    hb = datetime.fromisoformat(props["last_heartbeat"])
                    age = (datetime.now(timezone.utc) - hb).total_seconds()
                    if age > self.STALE_SECONDS:
                        continue
                except (ValueError, TypeError):
                    pass
            if exclude_agent and props.get("agent_id") == exclude_agent:
                continue
            score = _cosine_sim(q_emb, node.embedding)
            if score >= threshold:
                scored.append((node, score))

        scored.sort(key=lambda x: -x[1])
        tasks = []
        for node, score in scored[:limit]:
            props = node.properties or {}
            tasks.append(AgentTask(
                id=node.id,
                agent_id=props.get("agent_id", "unknown"),
                intent=props.get("_dense", node.label),
                reasoning=(props.get("_source", "") or "")[:300],
                status=props.get("status", "unknown"),
                files_touched=props.get("files_touched", []),
                started_at=props.get("started_at", ""),
                lessons_learned=props.get("lessons_learned", []),
                score=score,
                level=OverlapLevel.from_score(score),
            ))
        return tasks

    async def get_context(self, task_id: str) -> dict:
        """Fetch the full context of another agent's task.

        Call this AFTER check_overlap detects a conflict and you want
        to read the other agent's reasoning in full.
        """
        node = await self._myelin.get_node(task_id)
        if not node:
            return {}
        props = node.get("properties") or {}
        return {
            "id": task_id,
            "agent_id": props.get("agent_id"),
            "intent": (props.get("_dense") or node.get("label", "")),
            "reasoning": props.get("_source", ""),  # full text
            "status": props.get("status"),
            "files_touched": props.get("files_touched", []),
            "started_at": props.get("started_at"),
            "lessons_learned": props.get("lessons_learned", []),
        }

