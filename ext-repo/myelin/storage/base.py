"""Storage backend protocol for Myelin (coordination subset)."""
from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from ..core.types import Node, SchemaEntry


@runtime_checkable
class StorageBackend(Protocol):
    """Storage interface — only methods used by coordination."""

    # ── Node operations ──

    async def upsert_node(
        self,
        namespace: str,
        kind: str,
        label: str,
        properties: dict[str, Any],
        embedding: list[float] | None,
        confidence: float,
        visibility: str = "namespace",
    ) -> Node: ...

    async def get_node(self, node_id: str) -> Node | None: ...

    async def get_nodes_batch(self, node_ids: list[str]) -> list[Node]: ...

    async def find_node(
        self, namespace: str, kind: str, label: str
    ) -> Node | None: ...

    # ── Edge operations ──

    async def get_edges_for_node(
        self, node_id: str, direction: str = "both"
    ) -> list: ...

    # ── Vector search (pure cosine — used by coordination overlap checks) ──

    async def vector_search(
        self,
        namespace: str,
        embedding: list[float],
        kind: str | None,
        limit: int,
        time_at: str | None,
        access_level: str = "namespace",
    ) -> list[Node]: ...

    # ── Query ──

    async def query_nodes(
        self,
        *,
        namespace: str | None = None,
        namespace_prefix: str | None = None,
        kind: str | None = None,
        label: str | None = None,
        label_contains: str | None = None,
        valid_only: bool = True,
        order_by: str | None = None,
        order_desc: bool = False,
        limit: int = 500,
        select: str = "*",
    ) -> list[dict]: ...

    async def update_node_fields(
        self, node_id: str, updates: dict[str, Any]
    ) -> bool: ...

    async def reassign_edges(
        self, old_node_id: str, new_node_id: str
    ) -> int: ...

    # ── Schema ──

    async def update_schema(
        self,
        namespace: str,
        entry_type: str,
        name: str,
        prop_keys: list[str] | None = None,
    ) -> None: ...

    async def get_schema(self, namespace: str) -> list[SchemaEntry]: ...
