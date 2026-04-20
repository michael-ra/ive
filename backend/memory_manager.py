"""Commander memory abstraction layer — unified auto-memory for all CLIs.

Commander owns the memory.  Every CLI (Claude, Gemini, future CLIs) reads
from the same pool of memory entries, injected into the system prompt at
session start.  Claude can still write to its native ``.claude/memory/``
format, and Commander imports those entries; but the DB is the source of
truth.

Memory entry types mirror Claude Code's auto-memory taxonomy:
  - **user**      — role, preferences, knowledge
  - **feedback**  — corrections and validations of approach
  - **project**   — ongoing work, goals, deadlines
  - **reference** — pointers to external systems

This module is intentionally storage-only (no embeddings, no vector search).
Semantic search can be layered on top via Myelin when the experimental
coordination flag is enabled.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

VALID_TYPES = {"user", "feedback", "project", "reference"}


# ─── Data types ──────────────────────────────────────────────────────

@dataclass
class MemoryEntry:
    id: str
    workspace_id: Optional[str]        # None = global (applies everywhere)
    name: str
    type: str                           # user | feedback | project | reference
    description: str = ""
    content: str = ""
    source_cli: str = "commander"       # which CLI created this
    tags: list[str] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        d["tags"] = json.dumps(d["tags"]) if isinstance(d["tags"], list) else d["tags"]
        return d


# ─── Frontmatter parser (shared with memory_sync) ───────────────────

def _parse_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---"):
        return {}, text.strip()
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text.strip()
    header = text[4:end]
    body = text[end + 4:]
    meta: dict[str, str] = {}
    for line in header.split("\n"):
        line = line.strip()
        if ":" in line:
            key, _, val = line.partition(":")
            meta[key.strip()] = val.strip().strip('"').strip("'")
    return meta, body.strip()


# ─── Memory Manager ─────────────────────────────────────────────────

class MemoryManager:
    """CRUD + import/export for Commander-owned memory entries."""

    # ── CRUD ─────────────────────────────────────────────────────────

    async def save(
        self,
        name: str,
        type: str,
        content: str,
        workspace_id: Optional[str] = None,
        description: str = "",
        source_cli: str = "commander",
        tags: Optional[list[str]] = None,
    ) -> str:
        """Create a new memory entry. Returns the entry ID."""
        if type not in VALID_TYPES:
            raise ValueError(f"type must be one of {VALID_TYPES}, got {type!r}")

        entry_id = str(uuid.uuid4())
        from db import get_db
        db = await get_db()
        try:
            await db.execute(
                """INSERT INTO memory_entries
                   (id, workspace_id, name, type, description, content,
                    source_cli, tags)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (entry_id, workspace_id, name, type, description, content,
                 source_cli, json.dumps(tags or [])),
            )
            await db.commit()
            return entry_id
        finally:
            await db.close()

    async def get(self, entry_id: str) -> Optional[dict]:
        from db import get_db
        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT * FROM memory_entries WHERE id = ?", (entry_id,),
            )
            row = await cur.fetchone()
            return _row_to_dict(row) if row else None
        finally:
            await db.close()

    async def update(self, entry_id: str, **kwargs) -> bool:
        """Update fields on an existing entry. Returns True if found."""
        allowed = {"name", "type", "description", "content", "source_cli",
                    "tags", "workspace_id"}
        fields = []
        values = []
        for k, v in kwargs.items():
            if k not in allowed:
                continue
            if k == "tags" and isinstance(v, list):
                v = json.dumps(v)
            if k == "type" and v not in VALID_TYPES:
                raise ValueError(f"type must be one of {VALID_TYPES}")
            fields.append(f"{k} = ?")
            values.append(v)

        if not fields:
            return False

        fields.append("updated_at = datetime('now')")
        values.append(entry_id)

        from db import get_db
        db = await get_db()
        try:
            cur = await db.execute(
                f"UPDATE memory_entries SET {', '.join(fields)} WHERE id = ?",
                values,
            )
            await db.commit()
            return cur.rowcount > 0
        finally:
            await db.close()

    async def delete(self, entry_id: str) -> bool:
        from db import get_db
        db = await get_db()
        try:
            cur = await db.execute(
                "DELETE FROM memory_entries WHERE id = ?", (entry_id,),
            )
            await db.commit()
            return cur.rowcount > 0
        finally:
            await db.close()

    async def list_entries(
        self,
        workspace_id: Optional[str] = None,
        types: Optional[list[str]] = None,
        source_cli: Optional[str] = None,
        limit: int = 200,
    ) -> list[dict]:
        """List entries, optionally filtered. Always includes global entries."""
        conditions = []
        params: list = []

        if workspace_id:
            # Include workspace-specific AND global entries
            conditions.append("(workspace_id = ? OR workspace_id IS NULL)")
            params.append(workspace_id)

        if types:
            placeholders = ",".join("?" for _ in types)
            conditions.append(f"type IN ({placeholders})")
            params.extend(types)

        if source_cli:
            conditions.append("source_cli = ?")
            params.append(source_cli)

        where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        params.append(limit)

        from db import get_db
        db = await get_db()
        try:
            cur = await db.execute(
                f"SELECT * FROM memory_entries{where} ORDER BY type, name LIMIT ?",
                params,
            )
            return [_row_to_dict(r) for r in await cur.fetchall()]
        finally:
            await db.close()

    async def search(
        self,
        query: str,
        workspace_id: Optional[str] = None,
        types: Optional[list[str]] = None,
        limit: int = 20,
    ) -> list[dict]:
        """Keyword search across name, description, and content."""
        conditions = ["(name LIKE ? OR description LIKE ? OR content LIKE ?)"]
        pattern = f"%{query}%"
        params: list = [pattern, pattern, pattern]

        if workspace_id:
            conditions.append("(workspace_id = ? OR workspace_id IS NULL)")
            params.append(workspace_id)

        if types:
            placeholders = ",".join("?" for _ in types)
            conditions.append(f"type IN ({placeholders})")
            params.extend(types)

        params.append(limit)

        from db import get_db
        db = await get_db()
        try:
            cur = await db.execute(
                f"SELECT * FROM memory_entries WHERE {' AND '.join(conditions)} "
                f"ORDER BY updated_at DESC LIMIT ?",
                params,
            )
            return [_row_to_dict(r) for r in await cur.fetchall()]
        finally:
            await db.close()

    # ── Import from Claude's native .claude/memory/ ──────────────────

    async def import_from_claude_memory(
        self,
        workspace_path: str,
        workspace_id: Optional[str] = None,
    ) -> int:
        """Import entries from Claude's .claude/memory/*.md files.

        Skips entries that already exist (matched by name + workspace_id).
        Returns the number of new entries imported.
        """
        from memory_sync import get_provider
        provider = get_provider("claude")
        if not provider:
            return 0

        entries = provider.read_auto_memory(workspace_path)
        if not entries:
            return 0

        imported = 0
        for entry in entries:
            name = entry.get("name", entry.get("filename", ""))
            etype = entry.get("type", "project")
            if etype not in VALID_TYPES:
                etype = "project"

            # Check for duplicate
            from db import get_db
            db = await get_db()
            try:
                cur = await db.execute(
                    """SELECT id FROM memory_entries
                       WHERE name = ? AND (workspace_id = ? OR (workspace_id IS NULL AND ? IS NULL))""",
                    (name, workspace_id, workspace_id),
                )
                if await cur.fetchone():
                    continue  # already exists
            finally:
                await db.close()

            await self.save(
                name=name,
                type=etype,
                content=entry.get("content", ""),
                description=entry.get("description", ""),
                workspace_id=workspace_id,
                source_cli="claude",
            )
            imported += 1

        return imported

    # ── Export for system prompt injection ────────────────────────────

    async def export_for_prompt(
        self,
        workspace_id: Optional[str] = None,
        max_chars: int = 4000,
        compact: bool = False,
    ) -> str:
        """Format memory entries as a text block for system prompt injection.

        This is the key abstraction: ANY CLI gets the same memory, formatted
        identically, regardless of whether it has native auto-memory support.

        When compact=True (triggered by dense/caveman/ultra output styles),
        uses abbreviated headers and drops bold formatting to save tokens.
        """
        entries = await self.list_entries(workspace_id=workspace_id)
        if not entries:
            return ""

        lines: list[str] = []
        char_count = 0

        by_type: dict[str, list[dict]] = {}
        for e in entries:
            by_type.setdefault(e["type"], []).append(e)

        type_labels = {
            "user": "User Context",
            "feedback": "Approach Guidance",
            "project": "Project Context",
            "reference": "External References",
        }
        compact_labels = {
            "user": "user",
            "feedback": "guidance",
            "project": "project",
            "reference": "refs",
        }

        for etype in ("feedback", "user", "project", "reference"):
            group = by_type.get(etype, [])
            if not group:
                continue

            if compact:
                label = compact_labels.get(etype, etype)
                section = f"\n**{label}**\n"
            else:
                label = type_labels.get(etype, etype)
                section = f"\n### {label}\n"

            for e in group:
                if compact:
                    entry_text = f"- {e['name']}: {e['content']}"
                else:
                    entry_text = f"- **{e['name']}**: {e['content']}"
                if char_count + len(section) + len(entry_text) > max_chars:
                    break
                section += entry_text + "\n"
                char_count += len(entry_text) + 1

            if section.count("\n") > 2:
                lines.append(section)

            if char_count >= max_chars:
                break

        if not lines:
            return ""

        header = "**context**\n" if compact else "## Remembered Context\n"
        return header + "".join(lines)

    # ── Sync back to Claude's native format ──────────────────────────

    async def sync_to_claude_memory(
        self,
        workspace_path: str,
        workspace_id: Optional[str] = None,
    ) -> int:
        """Write Commander memory entries to Claude's .claude/memory/ format.

        Creates/updates .md files with YAML frontmatter so standalone Claude
        Code sessions (outside Commander) also benefit from the memory.
        """
        entries = await self.list_entries(workspace_id=workspace_id)
        if not entries:
            return 0

        # Find or create the memory dir
        memory_dir = Path(workspace_path) / ".claude" / "memory"
        memory_dir.mkdir(parents=True, exist_ok=True)

        written = 0
        index_lines = ["# Memory Index\n"]

        for e in entries:
            # Sanitize filename
            safe_name = "".join(
                c if c.isalnum() or c in "-_" else "_"
                for c in e["name"]
            ).strip("_")[:60]
            filename = f"{e['type']}_{safe_name}.md"
            filepath = memory_dir / filename

            content = (
                f"---\n"
                f"name: {e['name']}\n"
                f"description: {e['description']}\n"
                f"type: {e['type']}\n"
                f"---\n\n"
                f"{e['content']}\n"
            )

            try:
                filepath.write_text(content, encoding="utf-8")
                written += 1
                desc_short = e["description"][:80] if e["description"] else e["content"][:80]
                index_lines.append(f"- [{e['name']}]({filename}) — {desc_short}")
            except Exception as exc:
                logger.warning("Failed to write memory file %s: %s", filepath, exc)

        # Write MEMORY.md index
        try:
            (memory_dir / "MEMORY.md").write_text(
                "\n".join(index_lines) + "\n", encoding="utf-8",
            )
        except Exception as exc:
            logger.warning("Failed to write MEMORY.md: %s", exc)

        return written


# ─── Helpers ─────────────────────────────────────────────────────────

def _row_to_dict(row) -> dict:
    d = dict(row)
    if isinstance(d.get("tags"), str):
        try:
            d["tags"] = json.loads(d["tags"])
        except (json.JSONDecodeError, TypeError):
            d["tags"] = []
    return d


# ─── Module-level singleton ─────────────────────────────────────────

memory_manager = MemoryManager()
