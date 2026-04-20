"""Graph operations — remember only (coordination subset)."""
from __future__ import annotations

import logging
from typing import Any, TYPE_CHECKING

from .embeddings import EmbeddingProvider, build_embed_text
from .schema_tracker import SchemaTracker

if TYPE_CHECKING:
    from ..storage.base import StorageBackend

logger = logging.getLogger("myelin.graph")


class GraphOperations:
    """Core graph mutation operations."""

    def __init__(
        self,
        storage: StorageBackend,
        embedder: EmbeddingProvider,
        schema_tracker: SchemaTracker,
        *,
        org_prefix: str = "",
        read_scope: str = "self",
    ):
        self._storage = storage
        self._embedder = embedder
        self._schema = schema_tracker

    async def remember(
        self,
        namespace: str,
        kind: str,
        label: str,
        properties: dict[str, Any] | None = None,
        confidence: float = 1.0,
        salience: float | None = None,
        provenance: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Store or update a node. Returns {node_id, kind, label, status}."""
        properties = properties or {}

        if salience is not None:
            properties["_salience"] = salience
        if provenance:
            properties["_provenance"] = provenance

        embed_text = build_embed_text(kind, label, properties)
        vectors = await self._embedder.embed([embed_text])
        embedding = vectors[0] if vectors else None

        existing = await self._storage.find_node(namespace, kind, label)

        if existing:
            merged = {**existing.properties, **properties}
            old_id = existing.id
            node = await self._storage.upsert_node(
                namespace, kind, label, merged, embedding, confidence
            )
            if old_id != node.id:
                await self._storage.reassign_edges(old_id, node.id)
            status = "updated"
        else:
            node = await self._storage.upsert_node(
                namespace, kind, label, properties, embedding, confidence
            )
            status = "created"

        prop_keys = list(properties.keys()) if properties else None
        await self._schema.observe_node(namespace, kind, prop_keys)

        return {
            "node_id": node.id,
            "kind": node.kind,
            "label": node.label,
            "status": status,
        }
