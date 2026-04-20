"""Myelin — coordination-only subset.

This is a stripped-down version of the Myelin graph memory library,
containing only the pieces needed by the coordination module
(multi-agent conflict detection via semantic overlap).

Full Myelin lives in its own repo. This subset avoids exposing the
full library (RRF retrieval, consolidation, thought agent, MCP server,
tool declarations, etc.) while keeping coordination functional.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from .core.embeddings import GeminiEmbedding, auto_detect_embedder
from .core.graph import GraphOperations
from .core.schema_tracker import SchemaTracker

__all__ = [
    "Myelin",
    "GeminiEmbedding",
    "auto_detect_embedder",
    "_cosine_sim",
]

logger = logging.getLogger("myelin")


def _cosine_sim(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two vectors. Handles dimension mismatch."""
    if not a or not b:
        return 0.0
    min_len = min(len(a), len(b))
    dot = sum(a[i] * b[i] for i in range(min_len))
    mag_a = sum(x * x for x in a[:min_len]) ** 0.5
    mag_b = sum(x * x for x in b[:min_len]) ** 0.5
    if mag_a == 0 or mag_b == 0:
        return 0.0
    return dot / (mag_a * mag_b)


def _derive_label(dense: str, max_len: int = 60) -> str:
    """Auto-derive a label from a dense form sentence."""
    if not dense:
        return ""
    label = dense.strip().rstrip(".")
    if len(label) > max_len:
        label = label[:max_len].rsplit(" ", 1)[0]
    return label


class Myelin:
    """Coordination-only Myelin API.

    Supports: remember (task announce), list_nodes, get_node, update_node.
    Does NOT include: recall, traverse, consolidate, pre_recall, aggregate,
    check_contradiction, checkout, diff, branch, merge, thought agent, etc.
    """

    def __init__(
        self,
        namespace: str,
        *,
        readable_namespaces: list[str] | None = None,
        writable_namespaces: list[str] | None = None,
        storage=None,
        embedder=None,
    ):
        self.namespace = namespace
        self.readable_namespaces = readable_namespaces or [namespace]
        self.writable_namespaces = writable_namespaces or [namespace]
        self._injected_storage = storage
        self._injected_embedder = embedder
        self._graph: GraphOperations | None = None
        self._schema_tracker: SchemaTracker | None = None
        self._storage = None
        self._embedder = None
        self._initialized = False

    # ── Permissions ──

    def can_read(self, target_namespace: str) -> bool:
        return _matches_any(target_namespace, self.readable_namespaces)

    def can_write(self, target_namespace: str) -> bool:
        return _matches_any(target_namespace, self.writable_namespaces)

    @property
    def read_scope(self) -> str:
        if self.readable_namespaces == [self.namespace]:
            return "namespace"
        for pat in self.readable_namespaces:
            if pat.endswith(":*"):
                return "admin"
        return "org"

    @property
    def org_prefix(self) -> str:
        for pat in self.readable_namespaces:
            if pat.endswith(":*"):
                return pat[:-2]
        return _derive_prefix(self.namespace)

    # ── Init ──

    async def _ensure_init(self) -> None:
        if self._initialized:
            return

        if self._injected_storage:
            self._storage = self._injected_storage
        else:
            from .storage.sqlite import SQLiteStorage
            self._storage = SQLiteStorage()

        self._embedder = self._injected_embedder or auto_detect_embedder()
        if not self._embedder:
            api_key = os.environ.get("GOOGLE_API_KEY", "")
            if api_key:
                self._embedder = GeminiEmbedding(api_key=api_key)

        self._schema_tracker = SchemaTracker(self._storage)
        self._graph = GraphOperations(
            self._storage, self._embedder, self._schema_tracker,
            org_prefix=self.org_prefix,
            read_scope=self.read_scope,
        )
        self._initialized = True

    # ── Tool interface (coordination only uses myelin_remember) ──

    async def execute(self, tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
        await self._ensure_init()

        if tool_name == "myelin_remember":
            props = dict(args.get("properties") or {})
            if args.get("source_excerpt"):
                props["_source"] = args["source_excerpt"]
            if args.get("dense_form"):
                props["_dense"] = args["dense_form"]
            label = args.get("label") or _derive_label(args.get("dense_form", ""))
            return await self._graph.remember(
                self.namespace,
                kind=args["kind"],
                label=label,
                properties=props,
                confidence=args.get("confidence", 1.0),
                salience=args.get("salience"),
                provenance=args.get("provenance"),
            )

        return {"status": "error", "message": f"Unknown tool: {tool_name}"}

    # ── Query API (used by coordination workspace) ──

    async def list_nodes(
        self,
        kind: str | None = None,
        q: str | None = None,
        namespace: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        await self._ensure_init()

        ns, ns_prefix = self._resolve_read_scope(namespace)
        if namespace and not self.can_read(namespace):
            return []

        rows = await self._storage.query_nodes(
            namespace=ns,
            namespace_prefix=ns_prefix,
            kind=kind,
            label_contains=q,
            order_by="updated_at",
            order_desc=True,
            limit=limit,
            select="id, namespace, kind, label, properties, confidence, valid_from, created_at, updated_at",
        )
        for node in rows:
            node["editable"] = self.can_write(node.get("namespace", ""))
        return rows

    async def get_node(self, node_id: str) -> dict | None:
        await self._ensure_init()

        node_obj = await self._storage.get_node(node_id)
        if not node_obj:
            return None
        if not self.can_read(node_obj.namespace):
            return None

        node = {
            "id": node_obj.id, "namespace": node_obj.namespace,
            "kind": node_obj.kind, "label": node_obj.label,
            "properties": node_obj.properties, "confidence": node_obj.confidence,
            "visibility": node_obj.visibility,
            "valid_from": node_obj.valid_from.isoformat() if node_obj.valid_from else None,
            "valid_until": node_obj.valid_until.isoformat() if node_obj.valid_until else None,
            "superseded_by": node_obj.superseded_by,
            "created_at": node_obj.created_at.isoformat() if node_obj.created_at else None,
            "updated_at": node_obj.updated_at.isoformat() if node_obj.updated_at else None,
        }
        node["editable"] = self.can_write(node_obj.namespace)

        edges = await self._storage.get_edges_for_node(node_id)
        edge_list = []
        for e in edges:
            ed = {
                "id": e.id, "source_id": e.source_id, "target_id": e.target_id,
                "relation": e.relation, "properties": e.properties,
                "confidence": e.confidence, "namespace": e.namespace,
                "created_at": e.created_at.isoformat() if e.created_at else None,
            }
            edge_list.append(ed)

        connected_ids = set()
        for e in edge_list:
            connected_ids.add(e["source_id"])
            connected_ids.add(e["target_id"])
        connected_ids.discard(node_id)
        labels = {}
        if connected_ids:
            batch = await self._storage.get_nodes_batch(list(connected_ids))
            labels = {n.id: {"id": n.id, "kind": n.kind, "label": n.label, "namespace": n.namespace} for n in batch}

        for e in edge_list:
            other_id = e["target_id"] if e["source_id"] == node_id else e["source_id"]
            other = labels.get(other_id, {})
            e["other_kind"] = other.get("kind", "")
            e["other_label"] = other.get("label", "")
            e["other_namespace"] = other.get("namespace", "")
            e["direction"] = "out" if e["source_id"] == node_id else "in"

        node["edges"] = edge_list
        return node

    async def update_node(self, node_id: str, updates: dict) -> dict | None:
        await self._ensure_init()

        node_obj = await self._storage.get_node(node_id)
        if not node_obj:
            return None
        if not self.can_write(node_obj.namespace):
            return None

        data = {}
        for key in ("properties", "label", "confidence"):
            if key in updates:
                data[key] = updates[key]
        if not data:
            return {"id": node_obj.id, "namespace": node_obj.namespace}

        await self._storage.update_node_fields(node_id, data)
        updated = await self._storage.get_node(node_id)
        if not updated:
            return None
        return {"id": updated.id, "namespace": updated.namespace, "kind": updated.kind,
                "label": updated.label, "properties": updated.properties, "confidence": updated.confidence}

    # ── Internal ──

    def _resolve_read_scope(self, override_namespace: str | None = None) -> tuple[str | None, str | None]:
        if override_namespace:
            return override_namespace, None
        if self.readable_namespaces == [self.namespace]:
            return self.namespace, None
        for pat in self.readable_namespaces:
            if pat.endswith(":*"):
                prefix = pat[:-2]
                return None, prefix
        if len(self.readable_namespaces) == 1:
            return self.readable_namespaces[0], None
        return self.namespace, None


def _matches_any(namespace: str, patterns: list[str]) -> bool:
    for pat in patterns:
        if pat.endswith(":*"):
            prefix = pat[:-1]
            if namespace.startswith(prefix) or namespace == prefix[:-1]:
                return True
        elif pat == namespace:
            return True
    return False


def _derive_prefix(namespace: str) -> str:
    parts = namespace.split(":")
    if len(parts) >= 2:
        return f"{parts[0]}:{parts[1]}"
    return namespace
