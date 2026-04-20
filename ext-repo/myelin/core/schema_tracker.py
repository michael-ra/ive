"""Emergent schema tracker — observes what the AI creates, doesn't enforce it."""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..storage.base import StorageBackend


class SchemaTracker:
    """Tracks emerging schema patterns without enforcing them."""

    def __init__(self, storage: StorageBackend):
        self._storage = storage

    async def observe_node(
        self, namespace: str, kind: str, prop_keys: list[str] | None = None
    ) -> None:
        """Record that a node of this kind was created/updated."""
        await self._storage.update_schema(
            namespace, "node_kind", kind, prop_keys
        )

