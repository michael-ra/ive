"""Core data types for Myelin graph memory."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass
class Node:
    """A piece of knowledge in the graph."""
    id: str
    namespace: str
    kind: str
    label: str
    properties: dict[str, Any] = field(default_factory=dict)
    embedding: list[float] | None = None
    confidence: float = 1.0
    visibility: str = "namespace"
    valid_from: datetime | None = None
    valid_until: datetime | None = None
    superseded_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass
class Edge:
    """A typed relationship between two nodes."""
    id: str
    namespace: str
    source_id: str
    target_id: str
    relation: str
    properties: dict[str, Any] = field(default_factory=dict)
    confidence: float = 1.0
    visibility: str = "namespace"
    valid_from: datetime | None = None
    valid_until: datetime | None = None
    created_at: datetime | None = None


@dataclass
class SchemaEntry:
    """An observed schema element (node kind or relation type)."""
    namespace: str
    entry_type: str
    name: str
    count: int = 1
    sample_props: list[str] = field(default_factory=list)
    first_seen: datetime | None = None
    last_seen: datetime | None = None
