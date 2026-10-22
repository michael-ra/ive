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
The separately installed Myelin extension owns graph/semantic memory.
The legacy engine name below is a transition adapter, not part of notes.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field, asdict
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


from memory_sync import _parse_frontmatter  # shared parser, single source


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
        include_global: bool = True,
    ) -> list[dict]:
        """List entries, optionally filtered.

        When ``workspace_id`` is supplied, ``include_global`` controls whether
        rows with ``workspace_id = NULL`` are also returned. Defaults to True
        so ``export_for_prompt`` keeps applying genuinely-global entries at
        PTY start; the API surface (``/api/memory``) sets it to False so the
        UI never silently shows entries leaked from other workspaces.
        """
        conditions = []
        params: list = []

        if workspace_id:
            if include_global:
                conditions.append("(workspace_id = ? OR workspace_id IS NULL)")
                params.append(workspace_id)
            else:
                conditions.append("workspace_id = ?")
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
                f"""SELECT * FROM memory_entries{where}
                    ORDER BY
                      CASE type
                        WHEN 'feedback' THEN 0
                        WHEN 'user' THEN 1
                        WHEN 'project' THEN 2
                        WHEN 'reference' THEN 3
                        ELSE 4
                      END,
                      datetime(updated_at) DESC,
                      name COLLATE NOCASE ASC
                    LIMIT ?""",
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
        include_global: bool = True,
    ) -> list[dict]:
        """Keyword search across name, description, and content.

        Storage-layer entry point (prompt-time recall in catchup.py) onto the
        same query both HTTP memory-search surfaces run — see
        ``search_memory_entries_rows``. Full rows, so ``tags`` come back
        decoded. Mixed-scope results (a workspace plus globals) now arrive
        workspace-scoped-first instead of pure recency; single-scope ordering
        is unchanged.
        """
        return await search_memory_entries_rows(
            query,
            workspace_id=workspace_id,
            include_global=include_global,
            types=types,
            limit=limit,
        )

    # ── Import from native CLI auto-memory dirs ──────────────────────

    async def import_from_provider_memory(
        self,
        cli_type: str,
        workspace_path: str,
        workspace_id: Optional[str] = None,
        *, consent: bool = False,
    ) -> int:
        """Import entries from a CLI provider's native auto-memory files.

        Skips entries that already exist (matched by name + workspace_id).
        Returns the number of new entries imported.
        """
        from memory_sync import get_provider, native_memory_allowed
        if not await native_memory_allowed(workspace_id, consent=consent):
            raise PermissionError("Native CLI memory import requires explicit consent")
        provider = get_provider(cli_type)
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
                source_cli=cli_type,
            )
            imported += 1

        return imported

    async def import_from_claude_memory(
        self,
        workspace_path: str,
        workspace_id: Optional[str] = None,
    ) -> int:
        """Backward-compat wrapper around ``import_from_provider_memory``."""
        return await self.import_from_provider_memory(
            "claude", workspace_path, workspace_id,
        )

    # ── Export for system prompt injection ────────────────────────────

    async def export_for_prompt(
        self,
        workspace_id: Optional[str] = None,
        max_chars: int = 4000,
        compact: bool = False,
        mode: str = "auto",
        exclude_ids: set[str] | None = None,
    ) -> str:
        """Format memory entries as a text block for system prompt injection.

        This is the key abstraction: ANY CLI gets the same memory, formatted
        identically, regardless of whether it has native auto-memory support.

        ``mode`` controls the inlining strategy:
          * ``"full"``  — legacy: inline ``name + full content`` per entry.
            Long entries crowd out short ones; once ``max_chars`` is hit the
            tail is silently dropped.
          * ``"index"`` — one-line entries (``name — description``). The
            agent calls ``recall_memory(name)`` to fetch a body on demand.
            Mirrors Claude Code's ``MEMORY.md`` index pattern; scales to
            many entries inside the same budget.
          * ``"auto"``  (default) — full mode if every entry's full body
            comfortably fits in ``max_chars``, otherwise index mode. This
            keeps small workspaces unchanged while large ones automatically
            move to the index pattern instead of silently truncating.

        When compact=True (triggered by dense/caveman/ultra output styles),
        uses abbreviated headers and drops bold formatting to save tokens.
        """
        entries = [entry for entry in await self.list_entries(workspace_id=workspace_id)
                   if entry["id"] not in (exclude_ids or set())]
        if not entries:
            return ""

        # Auto-mode decision: would full bodies fit? Use ~80% of budget as
        # the threshold so we keep some headroom for headers / hint footer
        # / accumulating content variability.
        if mode == "auto":
            full_size = sum(len(e.get("name", "")) + len(e.get("content", "")) + 8
                            for e in entries)
            mode = "full" if full_size <= int(max_chars * 0.8) else "index"

        if mode not in ("full", "index"):
            mode = "full"

        lines: list[str] = []
        char_count = 0
        rendered_count = 0
        total_entries = len(entries)
        budget_full = False

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
                name = e.get("name", "")
                if mode == "index":
                    # Prefer the curated description; fall back to a tight
                    # excerpt of content so legacy entries without a
                    # description still convey what they're about.
                    desc = (e.get("description") or "").strip()
                    if not desc:
                        body = (e.get("content") or "").strip().replace("\n", " ")
                        desc = body[:120] + ("…" if len(body) > 120 else "")
                    if compact:
                        entry_text = f"- {name} — {desc}"
                    else:
                        entry_text = f"- **{name}** — {desc}"
                else:
                    if compact:
                        entry_text = f"- {name}: {e.get('content', '')}"
                    else:
                        entry_text = f"- **{name}**: {e.get('content', '')}"
                if char_count + len(section) + len(entry_text) > max_chars:
                    budget_full = True
                    break
                section += entry_text + "\n"
                char_count += len(entry_text) + 1
                rendered_count += 1

            if section.count("\n") > 2:
                lines.append(section)

            if budget_full or char_count >= max_chars:
                break

        if not lines:
            return ""

        header = "**context**\n" if compact else "## Remembered Context\n"
        body = header + "".join(lines)
        omitted_count = max(0, total_entries - rendered_count)
        if mode == "index":
            hint = (
                "\n_call `recall_memory(name=...)` to expand any entry above._\n"
                if not compact else
                "\n_recall_memory(name=...) to expand_\n"
            )
            body += hint
        if omitted_count:
            body += (
                f"\n_{omitted_count} newer/lower-priority entr"
                f"{'y was' if omitted_count == 1 else 'ies were'} omitted by the memory budget. "
                "Use search_memory or recall_memory for more._\n"
            )
        return body

    # ── Sync back to a provider's native auto-memory format ──────────

    async def sync_to_provider(
        self,
        cli_type: str,
        workspace_path: str,
        workspace_id: Optional[str] = None,
        *, consent: bool = False,
    ) -> int:
        """Write Commander memory entries into ``cli_type``'s native dir.

        Delegates to ``MemoryProvider.write_auto_memory`` so the destination
        path matches where that CLI actually reads from (e.g. Claude Code's
        ``~/.claude/projects/<encoded>/memory`` rather than the workspace
        mirror). Returns the number of files written.
        """
        from memory_sync import get_provider, native_memory_allowed
        if not await native_memory_allowed(workspace_id, consent=consent):
            return 0
        provider = get_provider(cli_type)
        if not provider:
            return 0
        entries = await self.list_entries(workspace_id=workspace_id)
        if not entries:
            return 0
        written, _ = provider.write_auto_memory(workspace_path, entries)
        return written

    async def sync_to_all_providers(
        self,
        workspace_path: str,
        workspace_id: Optional[str] = None,
        *, consent: bool = False,
    ) -> dict[str, int]:
        """Write entries to every registered CLI's auto-memory dir.

        Returns a per-CLI count of files written. CLIs that have no auto-
        memory location simply contribute ``0``.
        """
        from memory_sync import all_providers, native_memory_allowed
        if not await native_memory_allowed(workspace_id, consent=consent):
            return {}
        entries = await self.list_entries(workspace_id=workspace_id)
        if not entries:
            return {}
        result: dict[str, int] = {}
        for prov in all_providers():
            written, _ = prov.write_auto_memory(workspace_path, entries)
            result[prov.cli_type] = written
        return result

    async def sync_to_claude_memory(
        self,
        workspace_path: str,
        workspace_id: Optional[str] = None,
    ) -> int:
        """Backward-compat wrapper around ``sync_to_provider('claude', ...)``."""
        return await self.sync_to_provider("claude", workspace_path, workspace_id)


# ─── Helpers ─────────────────────────────────────────────────────────

def _row_to_dict(row) -> dict:
    d = dict(row)
    if isinstance(d.get("tags"), str):
        try:
            d["tags"] = json.loads(d["tags"])
        except (json.JSONDecodeError, TypeError):
            d["tags"] = []
    return d


# ── Shared memory_entries keyword search ────────────────────────────────
# ONE query implementation behind EVERY memory-search surface:
#   • GET /api/memory/search                 → server.search_memory_entries
#   • GET /api/workspaces/{id}/memory-search → server.unified_memory_search
#                                              ('memory' bucket)
#   • MemoryManager.search()                 → prompt-time recall (catchup.py)
# Each surface used to carry its own copy of this SELECT. That split is exactly
# how the default-type drift in the unified surface stayed invisible: a fix
# applied to one query never reached the others, and nothing forced them to be
# read together. The SCOPING genuinely differs between the surfaces (see each
# route's docstring) so it stays parameterised here — but the LIKE columns, the
# type filter and the ordering are shared and change once.
#
# Lives in the storage layer, not in server.py, because the third caller is not
# an HTTP surface: server imports memory_manager, never the reverse.

# Column list the unified bucket ships to workers — deliberately narrower than
# ``*`` (no tags/timestamps) to keep the multi-bucket payload small.
_MEMORY_ENTRY_BUCKET_COLUMNS = "id, name, type, description, content, source_cli, workspace_id"


async def search_memory_entries_rows(
    query: str,
    *,
    workspace_id: str | None = None,
    include_global: bool = True,
    types: list[str] | None = None,
    limit: int = 20,
    columns: str = "*",
) -> list[dict]:
    """Keyword search over ``memory_entries`` (name / description / content).

    Args:
        query: substring matched with LIKE against name, description, content.
        workspace_id: scope to this workspace; ``None`` searches every row.
        include_global: when a workspace IS given, also return NULL-scoped
            (global) rows. The unified bucket wants them — a worker should see
            machine-wide facts — while the Memory window does not, so that it
            never lists an entry the user did not file under this workspace.
        types: optional ``type IN (...)`` filter.
        limit: row cap.
        columns: SELECT list. ``*`` returns full rows with ``tags`` decoded;
            the unified bucket passes ``_MEMORY_ENTRY_BUCKET_COLUMNS``.

    Ordering: workspace-scoped rows before global ones, then most recently
    updated first. The scoped-first key is only emitted when the result set can
    actually mix the two, so a single-scope query keeps pure recency order.
    """
    pattern = f"%{query}%"
    conditions = ["(name LIKE ? OR description LIKE ? OR content LIKE ?)"]
    params: list = [pattern, pattern, pattern]

    mixes_global = False
    if workspace_id:
        if include_global:
            conditions.append("(workspace_id = ? OR workspace_id IS NULL)")
            mixes_global = True
        else:
            conditions.append("workspace_id = ?")
        params.append(workspace_id)

    if types:
        placeholders = ",".join("?" for _ in types)
        conditions.append(f"type IN ({placeholders})")
        params.extend(types)

    order = "(workspace_id IS NULL) ASC, updated_at DESC" if mixes_global else "updated_at DESC"
    params.append(limit)

    from db import get_db
    db = await get_db()
    try:
        cur = await db.execute(
            f"SELECT {columns} FROM memory_entries "
            f"WHERE {' AND '.join(conditions)} "
            f"ORDER BY {order} LIMIT ?",
            params,
        )
        return [_row_to_dict(r) for r in await cur.fetchall()]
    finally:
        await db.close()


# ─── Basic notes singleton and optional legacy extension adapter ──────

memory_manager = MemoryManager()

from extension_host import (
    ExtensionUnavailable as _ExtensionUnavailable,
    available as _extension_available,
    load_legacy_namespace as _load_extension_namespace,
)

if _extension_available("myelin"):
    _load_extension_namespace(globals(), "myelin", "backend/memory_engine.py")
else:
    class _UnavailableMyelinEngine:
        """Keep legacy imports harmless; using private memory requires Myelin."""

        def __getattr__(self, name):
            raise _ExtensionUnavailable(
                "myelin", "Myelin code memory is not installed or enabled in this IVE edition"
            )

    myelin_memory_engine = _UnavailableMyelinEngine()
