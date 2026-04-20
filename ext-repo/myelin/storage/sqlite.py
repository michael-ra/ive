"""SQLite storage backend for Myelin coordination.

Uses:
  - sqlite3 (stdlib) for all data
  - sqlite-vec for cosine similarity vector search (optional)
  - FTS5 for indexing (built into SQLite)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import struct
import uuid
from datetime import datetime, timezone
from pathlib import Path
from ..core.types import Edge, Node, SchemaEntry

logger = logging.getLogger("myelin.storage.sqlite")


def _serialize_f32(vector: list[float]) -> bytes:
    return struct.pack(f"{len(vector)}f", *vector)


def _deserialize_f32(blob: bytes) -> list[float]:
    n = len(blob) // 4
    return list(struct.unpack(f"{n}f", blob))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_dt(val) -> datetime | None:
    if not val:
        return None
    if isinstance(val, datetime):
        return val
    try:
        return datetime.fromisoformat(val)
    except (ValueError, TypeError):
        return None


def _derive_prefix(namespace: str) -> str:
    parts = namespace.split(":")
    return ":".join(parts[:2]) if len(parts) >= 2 else namespace


def _fts_content(label: str, properties: dict | None) -> str:
    """Build FTS index content from node fields."""
    props = properties or {}
    dense = props.get("_dense", "")
    return f"{label} {dense}" if dense else label


def _row_to_node(row) -> Node:
    props = json.loads(row["properties"]) if row["properties"] else {}
    emb = _deserialize_f32(row["embedding"]) if row["embedding"] else None
    return Node(
        id=row["id"],
        namespace=row["namespace"],
        kind=row["kind"],
        label=row["label"],
        properties=props,
        embedding=emb,
        confidence=row["confidence"],
        visibility=row["visibility"] or "namespace",
        valid_from=_parse_dt(row["valid_from"]),
        valid_until=_parse_dt(row["valid_until"]),
        superseded_by=row["superseded_by"],
        created_at=_parse_dt(row["created_at"]),
        updated_at=_parse_dt(row["updated_at"]),
    )


def _row_to_edge(row) -> Edge:
    props = json.loads(row["properties"]) if row["properties"] else {}
    return Edge(
        id=row["id"],
        namespace=row["namespace"],
        source_id=row["source_id"],
        target_id=row["target_id"],
        relation=row["relation"],
        properties=props,
        confidence=row["confidence"],
        visibility=row["visibility"] or "namespace",
        valid_from=_parse_dt(row["valid_from"]),
        valid_until=_parse_dt(row["valid_until"]),
        created_at=_parse_dt(row["created_at"]),
    )


def _node_dict(row, select: str = "*") -> dict:
    d = dict(row)
    if "properties" in d and isinstance(d["properties"], str):
        d["properties"] = json.loads(d["properties"]) if d["properties"] else {}
    if select != "*" and "embedding" not in select:
        d.pop("embedding", None)
    elif "embedding" in d and isinstance(d["embedding"], (bytes, memoryview)):
        d.pop("embedding", None)
    return d


_ALLOWED_NODE_COLS = {
    "id", "namespace", "kind", "label", "properties", "confidence",
    "visibility", "valid_from", "valid_until", "superseded_by",
    "created_at", "updated_at", "embedding",
}


def _safe_select(select: str, allowed: set[str]) -> str:
    if select == "*":
        return "*"
    cols = [c.strip() for c in select.split(",")]
    safe = [c for c in cols if c in allowed]
    return ", ".join(safe) if safe else "*"


class SQLiteStorage:
    """SQLite + sqlite-vec storage backend."""

    def __init__(
        self,
        db_path: str | Path | None = None,
        embedding_dims: int = 3072,
    ):
        self._path = Path(
            db_path or os.environ.get("MYELIN_DB_PATH", "~/.myelin/myelin.db")
        ).expanduser()
        self._dims = embedding_dims
        self._conn = None
        self._vec_enabled = False

    def _ensure_conn(self):
        if self._conn is not None:
            return self._conn

        import sqlite3

        self._path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self._path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")

        try:
            import sqlite_vec
            conn.enable_load_extension(True)
            sqlite_vec.load(conn)
            conn.enable_load_extension(False)
            self._vec_enabled = True
        except (ImportError, Exception) as e:
            logger.warning("sqlite-vec not available (%s) — vector search uses Python fallback", e)
            self._vec_enabled = False

        self._init_tables(conn)
        conn.commit()
        self._conn = conn
        return conn

    def _init_tables(self, conn):
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS myelin_nodes (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                kind TEXT NOT NULL,
                label TEXT NOT NULL,
                properties TEXT DEFAULT '{}',
                embedding BLOB,
                confidence REAL DEFAULT 1.0,
                visibility TEXT DEFAULT 'namespace',
                valid_from TEXT,
                valid_until TEXT,
                superseded_by TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS myelin_edges (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                source_id TEXT NOT NULL,
                target_id TEXT NOT NULL,
                relation TEXT NOT NULL,
                properties TEXT DEFAULT '{}',
                confidence REAL DEFAULT 1.0,
                visibility TEXT DEFAULT 'namespace',
                valid_from TEXT,
                valid_until TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS myelin_schema (
                namespace TEXT NOT NULL,
                entry_type TEXT NOT NULL,
                name TEXT NOT NULL,
                count INTEGER DEFAULT 1,
                sample_props TEXT DEFAULT '[]',
                first_seen TEXT,
                last_seen TEXT,
                PRIMARY KEY (namespace, entry_type, name)
            );
            CREATE INDEX IF NOT EXISTS idx_nodes_ns_kind
                ON myelin_nodes(namespace, kind) WHERE valid_until IS NULL;
            CREATE INDEX IF NOT EXISTS idx_nodes_ns_kind_label
                ON myelin_nodes(namespace, kind, label) WHERE valid_until IS NULL;
            CREATE INDEX IF NOT EXISTS idx_edges_source
                ON myelin_edges(source_id) WHERE valid_until IS NULL;
            CREATE INDEX IF NOT EXISTS idx_edges_target
                ON myelin_edges(target_id) WHERE valid_until IS NULL;
            CREATE INDEX IF NOT EXISTS idx_edges_ns
                ON myelin_edges(namespace) WHERE valid_until IS NULL;
            CREATE INDEX IF NOT EXISTS idx_edges_triple
                ON myelin_edges(source_id, target_id, relation) WHERE valid_until IS NULL;
        """)

        conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS myelin_fts USING fts5(
                node_id UNINDEXED, content, tokenize='porter unicode61'
            )
        """)

        if self._vec_enabled:
            try:
                conn.execute(f"""
                    CREATE VIRTUAL TABLE IF NOT EXISTS myelin_vec USING vec0(
                        node_id TEXT PRIMARY KEY,
                        embedding float[{self._dims}] distance_metric=cosine
                    )
                """)
            except Exception as e:
                logger.warning("Failed to create vec0 table: %s", e)
                self._vec_enabled = False

    # ── Namespace helpers ──

    def _ns_match(self, node_ns: str, query_ns: str, access_level: str) -> bool:
        if access_level in ("admin", "org"):
            prefix = _derive_prefix(query_ns)
            return node_ns.startswith(prefix)
        return node_ns == query_ns

    def _ns_where(self, namespace: str | None, namespace_prefix: str | None) -> tuple[str, list]:
        if namespace_prefix:
            return "namespace LIKE ?", [f"{namespace_prefix}%"]
        if namespace:
            return "namespace = ?", [namespace]
        return "1=1", []

    # ── Sync implementations ──

    def _upsert_node_sync(self, namespace, kind, label, properties, embedding, confidence, visibility):
        conn = self._ensure_conn()
        now = _now_iso()
        props_json = json.dumps(properties or {}, ensure_ascii=False)
        emb_blob = _serialize_f32(embedding) if embedding else None

        with conn:
            row = conn.execute(
                "SELECT * FROM myelin_nodes WHERE namespace=? AND kind=? AND label=? AND valid_until IS NULL",
                (namespace, kind, label),
            ).fetchone()

            if row:
                old_props = json.loads(row["properties"]) if row["properties"] else {}
                if row["confidence"] == confidence and old_props == (properties or {}):
                    conn.execute("UPDATE myelin_nodes SET updated_at=? WHERE id=?", (now, row["id"]))
                    if emb_blob and row["embedding"] != emb_blob:
                        conn.execute("UPDATE myelin_nodes SET embedding=? WHERE id=?", (emb_blob, row["id"]))
                        self._vec_upsert(conn, row["id"], emb_blob)
                    return _row_to_node(row)

            new_id = str(uuid.uuid4())

            if row:
                conn.execute(
                    "UPDATE myelin_nodes SET valid_until=?, superseded_by=? WHERE id=?",
                    (now, new_id, row["id"]),
                )
                conn.execute("DELETE FROM myelin_fts WHERE node_id=?", (row["id"],))
                self._vec_delete(conn, row["id"])

            conn.execute(
                "INSERT INTO myelin_nodes (id,namespace,kind,label,properties,embedding,confidence,visibility,valid_from,valid_until,superseded_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (new_id, namespace, kind, label, props_json, emb_blob, confidence, visibility, now, None, None, now, now),
            )

            conn.execute(
                "INSERT INTO myelin_fts (node_id, content) VALUES (?, ?)",
                (new_id, _fts_content(label, properties)),
            )
            if emb_blob:
                self._vec_upsert(conn, new_id, emb_blob)

        return Node(
            id=new_id, namespace=namespace, kind=kind, label=label,
            properties=properties or {}, embedding=embedding,
            confidence=confidence, visibility=visibility,
            valid_from=_parse_dt(now), valid_until=None, superseded_by=None,
            created_at=_parse_dt(now), updated_at=_parse_dt(now),
        )

    def _vec_upsert(self, conn, node_id: str, emb_blob: bytes):
        if not self._vec_enabled:
            return
        try:
            conn.execute("DELETE FROM myelin_vec WHERE node_id=?", (node_id,))
            conn.execute(
                "INSERT INTO myelin_vec (node_id, embedding) VALUES (?, ?)",
                (node_id, emb_blob),
            )
        except Exception as e:
            logger.debug("vec upsert failed: %s", e)

    def _vec_delete(self, conn, node_id: str):
        if not self._vec_enabled:
            return
        try:
            conn.execute("DELETE FROM myelin_vec WHERE node_id=?", (node_id,))
        except Exception:
            pass

    def _get_node_sync(self, node_id):
        conn = self._ensure_conn()
        row = conn.execute("SELECT * FROM myelin_nodes WHERE id=?", (node_id,)).fetchone()
        return _row_to_node(row) if row else None

    def _find_node_sync(self, namespace, kind, label):
        conn = self._ensure_conn()
        row = conn.execute(
            "SELECT * FROM myelin_nodes WHERE namespace=? AND kind=? AND label=? AND valid_until IS NULL LIMIT 1",
            (namespace, kind, label),
        ).fetchone()
        return _row_to_node(row) if row else None

    def _vector_search_sync(self, namespace, embedding, kind, limit, time_at, access_level):
        conn = self._ensure_conn()
        emb_blob = _serialize_f32(embedding)

        if self._vec_enabled:
            try:
                rows = conn.execute(
                    "SELECT node_id, distance FROM myelin_vec WHERE embedding MATCH ? AND k = ?",
                    (emb_blob, limit * 5),
                ).fetchall()
            except Exception as e:
                logger.debug("vec search failed (%s), using fallback", e)
                return self._brute_cosine(conn, namespace, embedding, kind, limit, access_level)
        else:
            return self._brute_cosine(conn, namespace, embedding, kind, limit, access_level)

        results = []
        for row in rows:
            node = self._get_node_sync(row["node_id"])
            if not node or node.valid_until is not None:
                continue
            if not self._ns_match(node.namespace, namespace, access_level):
                continue
            if kind and node.kind != kind:
                continue
            node.embedding = None
            results.append(node)
            if len(results) >= limit:
                break
        return results

    def _brute_cosine(self, conn, namespace, embedding, kind, limit, access_level):
        """Fallback: brute-force cosine similarity in Python."""
        import math
        rows = conn.execute(
            "SELECT id FROM myelin_nodes WHERE valid_until IS NULL AND embedding IS NOT NULL"
        ).fetchall()

        scored = []
        emb_len = math.sqrt(sum(x * x for x in embedding))
        if emb_len == 0:
            return []

        for row in rows:
            node = self._get_node_sync(row["id"])
            if not node or not node.embedding:
                continue
            if not self._ns_match(node.namespace, namespace, access_level):
                continue
            if kind and node.kind != kind:
                continue
            dot = sum(a * b for a, b in zip(embedding, node.embedding))
            b_len = math.sqrt(sum(x * x for x in node.embedding))
            sim = dot / (emb_len * b_len) if b_len else 0
            scored.append((sim, node))

        scored.sort(key=lambda x: x[0], reverse=True)
        results = []
        for _, node in scored[:limit]:
            node.embedding = None
            results.append(node)
        return results

    def _query_nodes_sync(self, *, namespace=None, namespace_prefix=None, kind=None,
                          label=None, label_contains=None, valid_only=True,
                          order_by=None, order_desc=False, limit=500, select="*"):
        conn = self._ensure_conn()
        sel = _safe_select(select, _ALLOWED_NODE_COLS)
        where, params = self._ns_where(namespace, namespace_prefix)
        if kind:
            where += " AND kind = ?"
            params.append(kind)
        if label:
            where += " AND label = ?"
            params.append(label)
        if label_contains:
            where += " AND label LIKE ?"
            params.append(f"%{label_contains}%")
        if valid_only:
            where += " AND valid_until IS NULL"

        sql = f"SELECT {sel} FROM myelin_nodes WHERE {where}"
        if order_by and order_by in _ALLOWED_NODE_COLS:
            sql += f" ORDER BY {order_by}"
            if order_desc:
                sql += " DESC"
        sql += " LIMIT ?"
        params.append(limit)

        rows = conn.execute(sql, params).fetchall()
        return [_node_dict(r, select) for r in rows]

    def _update_node_fields_sync(self, node_id, updates):
        conn = self._ensure_conn()
        now = _now_iso()
        sets = ["updated_at = ?"]
        params = [now]
        for key, val in updates.items():
            if key == "properties":
                sets.append("properties = ?")
                params.append(json.dumps(val, ensure_ascii=False))
            elif key == "embedding":
                sets.append("embedding = ?")
                emb_blob = _serialize_f32(val) if val else None
                params.append(emb_blob)
            elif key in _ALLOWED_NODE_COLS:
                sets.append(f"{key} = ?")
                params.append(val)
        params.append(node_id)
        with conn:
            conn.execute(f"UPDATE myelin_nodes SET {', '.join(sets)} WHERE id = ?", params)
            if "label" in updates or "properties" in updates:
                row = conn.execute("SELECT label, properties FROM myelin_nodes WHERE id=?", (node_id,)).fetchone()
                if row:
                    props = json.loads(row["properties"]) if row["properties"] else {}
                    conn.execute("DELETE FROM myelin_fts WHERE node_id=?", (node_id,))
                    conn.execute("INSERT INTO myelin_fts (node_id, content) VALUES (?, ?)", (node_id, _fts_content(row["label"], props)))
            if "embedding" in updates and updates["embedding"]:
                self._vec_upsert(conn, node_id, _serialize_f32(updates["embedding"]))
        return True

    def _get_edges_for_node_sync(self, node_id, direction):
        conn = self._ensure_conn()
        if direction == "out":
            rows = conn.execute("SELECT * FROM myelin_edges WHERE source_id=? AND valid_until IS NULL", (node_id,)).fetchall()
        elif direction == "in":
            rows = conn.execute("SELECT * FROM myelin_edges WHERE target_id=? AND valid_until IS NULL", (node_id,)).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM myelin_edges WHERE (source_id=? OR target_id=?) AND valid_until IS NULL",
                (node_id, node_id),
            ).fetchall()
        return [_row_to_edge(r) for r in rows]

    def _reassign_edges_sync(self, old_id, new_id):
        conn = self._ensure_conn()
        now = _now_iso()
        count = 0
        with conn:
            edges = conn.execute(
                "SELECT id, target_id, relation FROM myelin_edges WHERE source_id=? AND valid_until IS NULL",
                (old_id,),
            ).fetchall()
            for e in edges:
                existing = conn.execute(
                    "SELECT id FROM myelin_edges WHERE source_id=? AND target_id=? AND relation=? AND valid_until IS NULL",
                    (new_id, e["target_id"], e["relation"]),
                ).fetchone()
                if existing:
                    conn.execute("UPDATE myelin_edges SET valid_until=? WHERE id=?", (now, e["id"]))
                else:
                    conn.execute("UPDATE myelin_edges SET source_id=? WHERE id=?", (new_id, e["id"]))
                count += 1

            edges = conn.execute(
                "SELECT id, source_id, relation FROM myelin_edges WHERE target_id=? AND valid_until IS NULL",
                (old_id,),
            ).fetchall()
            for e in edges:
                existing = conn.execute(
                    "SELECT id FROM myelin_edges WHERE source_id=? AND target_id=? AND relation=? AND valid_until IS NULL",
                    (e["source_id"], new_id, e["relation"]),
                ).fetchone()
                if existing:
                    conn.execute("UPDATE myelin_edges SET valid_until=? WHERE id=?", (now, e["id"]))
                else:
                    conn.execute("UPDATE myelin_edges SET target_id=? WHERE id=?", (new_id, e["id"]))
                count += 1
        return count

    def _update_schema_sync(self, namespace, entry_type, name, prop_keys):
        conn = self._ensure_conn()
        now = _now_iso()
        props_json = json.dumps(prop_keys or [])
        with conn:
            conn.execute(
                "INSERT INTO myelin_schema (namespace, entry_type, name, count, sample_props, first_seen, last_seen) "
                "VALUES (?, ?, ?, 1, ?, ?, ?) "
                "ON CONFLICT(namespace, entry_type, name) DO UPDATE SET count=count+1, last_seen=?, sample_props=?",
                (namespace, entry_type, name, props_json, now, now, now, props_json),
            )

    def _get_schema_sync(self, namespace):
        conn = self._ensure_conn()
        rows = conn.execute("SELECT * FROM myelin_schema WHERE namespace=?", (namespace,)).fetchall()
        return [
            SchemaEntry(
                namespace=r["namespace"], entry_type=r["entry_type"], name=r["name"],
                count=r["count"], sample_props=json.loads(r["sample_props"]) if r["sample_props"] else [],
                first_seen=_parse_dt(r["first_seen"]), last_seen=_parse_dt(r["last_seen"]),
            )
            for r in rows
        ]

    def _get_nodes_batch_sync(self, node_ids):
        conn = self._ensure_conn()
        if not node_ids:
            return []
        placeholders = ",".join("?" for _ in node_ids)
        rows = conn.execute(f"SELECT * FROM myelin_nodes WHERE id IN ({placeholders})", node_ids).fetchall()
        return [_row_to_node(r) for r in rows]

    # ── Async public API ──

    async def upsert_node(self, namespace, kind, label, properties, embedding, confidence, visibility="namespace"):
        return await asyncio.to_thread(self._upsert_node_sync, namespace, kind, label, properties, embedding, confidence, visibility)

    async def get_node(self, node_id):
        return await asyncio.to_thread(self._get_node_sync, node_id)

    async def get_nodes_batch(self, node_ids):
        return await asyncio.to_thread(self._get_nodes_batch_sync, node_ids)

    async def find_node(self, namespace, kind, label):
        return await asyncio.to_thread(self._find_node_sync, namespace, kind, label)

    async def get_edges_for_node(self, node_id, direction="both"):
        return await asyncio.to_thread(self._get_edges_for_node_sync, node_id, direction)

    async def vector_search(self, namespace, embedding, kind, limit, time_at, access_level="namespace"):
        return await asyncio.to_thread(self._vector_search_sync, namespace, embedding, kind, limit, time_at, access_level)

    async def query_nodes(self, *, namespace=None, namespace_prefix=None, kind=None,
                          label=None, label_contains=None, valid_only=True,
                          order_by=None, order_desc=False, limit=500, select="*"):
        return await asyncio.to_thread(
            self._query_nodes_sync, namespace=namespace, namespace_prefix=namespace_prefix,
            kind=kind, label=label, label_contains=label_contains, valid_only=valid_only,
            order_by=order_by, order_desc=order_desc, limit=limit, select=select,
        )

    async def update_node_fields(self, node_id, updates):
        return await asyncio.to_thread(self._update_node_fields_sync, node_id, updates)

    async def reassign_edges(self, old_node_id, new_node_id):
        return await asyncio.to_thread(self._reassign_edges_sync, old_node_id, new_node_id)

    async def update_schema(self, namespace, entry_type, name, prop_keys=None):
        return await asyncio.to_thread(self._update_schema_sync, namespace, entry_type, name, prop_keys)

    async def get_schema(self, namespace):
        return await asyncio.to_thread(self._get_schema_sync, namespace)
