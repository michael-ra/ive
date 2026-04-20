"""CLI-agnostic memory synchronization — Commander as central memory hub.

Architecture:
  Commander's SQLite DB is the canonical memory store.  Each CLI (Claude,
  Gemini, future CLIs) is a "provider" with its own memory file format.
  Sync is always hub-and-spoke: provider ↔ central, never provider ↔
  provider directly.

Detection layers (highest → lowest priority):
  1. Hook-based: PreToolUse → check if Write/Edit targets a memory file
     Claude also fires FileChanged natively for belt-and-suspenders.
  2. Session lifecycle: SessionStart → push central, SessionEnd → pull.
  3. File watcher: (future) watchdog/FSEvents for external edits.
  4. Manual: API endpoint for on-demand sync.

Merge strategy: ``git merge-file`` for three-way merge when both sides
changed since last sync.  First sync uses ``--union`` to combine.

Adding a new CLI: define a CLIProfile in cli_profiles.py — this module
auto-discovers it via the PROFILES registry and wraps it in a
MemoryProvider.  No other changes needed.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from cli_features import Feature
from cli_profiles import PROFILES, CLIProfile

logger = logging.getLogger(__name__)


# ─── Data types ──────────────────────────────────────────────────────

@dataclass
class SyncResult:
    """Outcome of a sync operation."""
    status: str  # "synced" | "up_to_date" | "conflicts" | "error"
    providers_updated: list[str] = field(default_factory=list)
    merged_content: Optional[str] = None
    conflict_count: int = 0
    conflicts: Optional[list[dict]] = None  # parsed conflict hunks
    diffs: dict[str, str] = field(default_factory=dict)
    error: Optional[str] = None


@dataclass
class SyncStatus:
    """Current sync state for a workspace."""
    enabled: bool
    auto_sync: bool
    last_synced_at: Optional[str]
    central_content_length: int
    providers: dict[str, dict]
    # provider dict shape:
    #   file: str, file_exists: bool, file_hash: str|None,
    #   synced: bool, changed: bool, content_length: int


# ─── Frontmatter parser (no PyYAML dependency) ──────────────────────

def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """Parse simple key: value frontmatter from ``---`` fences."""
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


# ─── Memory Provider (wraps CLIProfile) ─────────────────────────────

class MemoryProvider:
    """Thin adapter around CLIProfile for memory-specific operations.

    Each registered CLIProfile automatically gets a MemoryProvider.  The
    provider exposes read/write/detect methods for that CLI's memory
    files without leaking CLI internals to the sync manager.
    """

    def __init__(self, profile: CLIProfile):
        self._profile = profile

    @property
    def cli_type(self) -> str:
        return self._profile.id

    @property
    def memory_filename(self) -> Optional[str]:
        """e.g. ``CLAUDE.md`` or ``GEMINI.md``."""
        b = self._profile.binding(Feature.PROJECT_MEMORY_FILE)
        return b.file_path if b else None

    @property
    def global_memory_path(self) -> Optional[Path]:
        """e.g. ``~/.claude/CLAUDE.md``."""
        b = self._profile.binding(Feature.GLOBAL_MEMORY_FILE)
        if not b or not b.file_path:
            return None
        return Path(os.path.expanduser(b.file_path))

    def memory_file_path(self, workspace_path: str) -> Optional[Path]:
        name = self.memory_filename
        return Path(workspace_path) / name if name else None

    def auto_memory_dir(self, workspace_path: str) -> Optional[Path]:
        """Directory for structured auto-memory entries (if the CLI has one)."""
        from cli_profiles import get_profile
        profile = get_profile(self.cli_type)
        auth = profile.auth_dir_name  # ".claude" or ".gemini"

        # Local auto-memory: <workspace>/.<cli>/memory/
        local = Path(workspace_path) / auth / "memory"
        if local.exists():
            return local

        # Claude-specific: global projects path at ~/.claude/projects/<encoded>/memory/
        # This is a documented exception — only Claude stores project memory
        # outside the workspace directory.
        if self.cli_type == "claude":
            encoded = workspace_path.replace("/", "-")
            home = Path(os.path.expanduser(profile.home_dir))
            global_dir = home / "projects" / encoded / "memory"
            if global_dir.exists():
                return global_dir

        return None

    def is_memory_path(self, file_path: str) -> bool:
        """Check whether *file_path* belongs to this provider's memory system."""
        name = self.memory_filename
        if name and os.path.basename(file_path) == name:
            return True
        from cli_profiles import get_profile
        profile = get_profile(self.cli_type)
        auth = profile.auth_dir_name  # ".claude" or ".gemini"
        if f"/{auth}/memory/" in file_path:
            return True
        # Claude-specific: global projects path (documented exception —
        # only Claude stores project memory outside the workspace).
        if self.cli_type == "claude":
            if f"/{auth}/projects/" in file_path and "/memory/" in file_path:
                return True
        return False

    # ── I/O ──────────────────────────────────────────────────────────

    def read_memory(self, workspace_path: str) -> Optional[str]:
        path = self.memory_file_path(workspace_path)
        if not path or not path.exists():
            return None
        try:
            return path.read_text(encoding="utf-8")
        except Exception as exc:
            logger.warning("Failed to read %s: %s", path, exc)
            return None

    def write_memory(self, workspace_path: str, content: str) -> None:
        path = self.memory_file_path(workspace_path)
        if not path:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        except Exception as exc:
            logger.error("Failed to write %s: %s", path, exc)

    def read_auto_memory(self, workspace_path: str) -> list[dict]:
        """Read structured auto-memory entries (e.g. Claude's .claude/memory/*.md)."""
        auto_dir = self.auto_memory_dir(workspace_path)
        if not auto_dir:
            return []
        entries = []
        for md in sorted(auto_dir.glob("*.md")):
            if md.name == "MEMORY.md":
                continue  # index file, not an entry
            try:
                text = md.read_text(encoding="utf-8")
                meta, body = _parse_frontmatter(text)
                if body:
                    entries.append({
                        "filename": md.name,
                        "name": meta.get("name", md.stem),
                        "type": meta.get("type", "unknown"),
                        "description": meta.get("description", ""),
                        "content": body,
                    })
            except Exception as exc:
                logger.warning("Failed to read auto-memory %s: %s", md, exc)
        return entries


# ─── Provider registry ──────────────────────────────────────────────

_providers: dict[str, MemoryProvider] = {}


def _ensure_providers():
    if not _providers:
        for cli_type, profile in PROFILES.items():
            _providers[cli_type] = MemoryProvider(profile)


def get_provider(cli_type: str) -> Optional[MemoryProvider]:
    _ensure_providers()
    return _providers.get(cli_type)


def all_providers() -> list[MemoryProvider]:
    _ensure_providers()
    return list(_providers.values())


def is_memory_path(file_path: str) -> bool:
    """Check if *file_path* belongs to ANY provider's memory system."""
    for p in all_providers():
        if p.is_memory_path(file_path):
            return True
    return False


# ─── Git merge utilities ─────────────────────────────────────────────

def _sha256(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def git_merge_file(
    base: str,
    ours: str,
    theirs: str,
    ours_label: str = "ours",
    theirs_label: str = "theirs",
    union: bool = False,
) -> tuple[str, bool, int]:
    """Three-way merge via ``git merge-file``.

    Returns ``(merged_content, has_conflicts, conflict_count)``.
    *conflict_count* is the git exit code: 0 = clean, >0 = # of conflicts.
    """
    paths: list[str] = []
    try:
        for content in (ours, base, theirs):
            fd, path = tempfile.mkstemp(suffix=".md")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(content)
            paths.append(path)

        cmd = [
            "git", "merge-file",
            "-L", ours_label, "-L", "base", "-L", theirs_label,
        ]
        if union:
            cmd.append("--union")
        cmd.extend(paths)

        result = subprocess.run(cmd, capture_output=True)

        with open(paths[0], "r", encoding="utf-8") as f:
            merged = f.read()

        return merged, result.returncode > 0, max(0, result.returncode)
    finally:
        for p in paths:
            try:
                os.unlink(p)
            except OSError:
                pass


def git_diff(old: str, new: str, old_label: str = "before", new_label: str = "after") -> str:
    """Unified diff between two strings using ``git diff --no-index``."""
    paths: list[str] = []
    try:
        for content in (old, new):
            fd, path = tempfile.mkstemp(suffix=".md")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(content)
            paths.append(path)

        result = subprocess.run(
            ["git", "diff", "--no-index", "--unified=3", "--no-color",
             paths[0], paths[1]],
            capture_output=True, text=True,
        )
        diff = result.stdout
        diff = diff.replace(paths[0], f"a/{old_label}")
        diff = diff.replace(paths[1], f"b/{new_label}")
        return diff
    finally:
        for p in paths:
            try:
                os.unlink(p)
            except OSError:
                pass


def parse_conflict_markers(content: str) -> list[dict]:
    """Parse ``<<<<<<<`` / ``=======`` / ``>>>>>>>`` markers into hunks."""
    hunks: list[dict] = []
    lines = content.split("\n")
    i = 0
    hunk_id = 0

    while i < len(lines):
        if lines[i].startswith("<<<<<<<"):
            ours_label = lines[i][7:].strip()
            ours_lines: list[str] = []
            theirs_lines: list[str] = []
            theirs_label = ""
            i += 1
            in_ours = True
            while i < len(lines):
                if lines[i].startswith("======="):
                    in_ours = False
                    i += 1
                    continue
                if lines[i].startswith(">>>>>>>"):
                    theirs_label = lines[i][7:].strip()
                    break
                (ours_lines if in_ours else theirs_lines).append(lines[i])
                i += 1
            hunks.append({
                "id": hunk_id,
                "ours_label": ours_label,
                "theirs_label": theirs_label,
                "ours": "\n".join(ours_lines),
                "theirs": "\n".join(theirs_lines),
            })
            hunk_id += 1
        i += 1

    return hunks


# ─── Sync Manager ────────────────────────────────────────────────────

class MemorySyncManager:
    """Orchestrates memory sync between Commander (central) and CLI providers."""

    def __init__(self):
        self._debounce_tasks: dict[str, asyncio.Task] = {}

    # ── DB helpers ───────────────────────────────────────────────────

    async def _get_or_create(self, workspace_id: str, scope: str = "project") -> dict:
        from db import get_db
        import uuid as _uuid
        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT * FROM workspace_memory WHERE workspace_id = ? AND scope = ?",
                (workspace_id, scope),
            )
            row = await cur.fetchone()
            if row:
                return dict(row)
            rid = str(_uuid.uuid4())
            await db.execute(
                """INSERT INTO workspace_memory
                   (id, workspace_id, scope, content, provider_hashes, settings)
                   VALUES (?, ?, ?, '', '{}', '{}')""",
                (rid, workspace_id, scope),
            )
            await db.commit()
            cur = await db.execute("SELECT * FROM workspace_memory WHERE id = ?", (rid,))
            return dict(await cur.fetchone())
        finally:
            await db.close()

    async def _save(self, workspace_id: str, scope: str,
                    content: str, provider_hashes: dict,
                    settings: Optional[dict] = None):
        from db import get_db
        db = await get_db()
        try:
            if settings is not None:
                await db.execute(
                    """UPDATE workspace_memory
                       SET content = ?, provider_hashes = ?, settings = ?,
                           last_synced_at = datetime('now'), updated_at = datetime('now')
                       WHERE workspace_id = ? AND scope = ?""",
                    (content, json.dumps(provider_hashes), json.dumps(settings),
                     workspace_id, scope),
                )
            else:
                await db.execute(
                    """UPDATE workspace_memory
                       SET content = ?, provider_hashes = ?,
                           last_synced_at = datetime('now'), updated_at = datetime('now')
                       WHERE workspace_id = ? AND scope = ?""",
                    (content, json.dumps(provider_hashes), workspace_id, scope),
                )
            await db.commit()
        finally:
            await db.close()

    # ── Core sync ────────────────────────────────────────────────────

    async def sync(
        self,
        workspace_id: str,
        workspace_path: str,
        scope: str = "project",
        source_cli: Optional[str] = None,
    ) -> SyncResult:
        """Synchronize memory between central store and all providers.

        If *source_cli* is set, that provider is treated as authoritative
        (e.g. after a session ends we know which CLI might have changed).
        """
        record = await self._get_or_create(workspace_id, scope)
        central = record["content"] or ""
        stored = json.loads(record.get("provider_hashes", "{}"))

        # Snapshot every provider
        states: dict[str, dict] = {}
        for prov in all_providers():
            content = prov.read_memory(workspace_path)
            cur_hash = _sha256(content) if content is not None else None
            prev_hash = stored.get(prov.cli_type, {}).get("hash")
            states[prov.cli_type] = {
                "content": content,
                "hash": cur_hash,
                "prev_hash": prev_hash,
                "changed": cur_hash is not None and cur_hash != prev_hash,
                "exists": content is not None,
            }

        changed = [c for c, s in states.items() if s["changed"]]
        if source_cli:
            changed = [source_cli] if source_cli in states and states[source_cli]["changed"] else []

        # ── Nothing changed ──────────────────────────────────────────
        if not changed:
            # Push central to providers that don't have a file yet
            if central:
                pushed: list[str] = []
                new_hashes = dict(stored)
                for prov in all_providers():
                    if not states[prov.cli_type]["exists"]:
                        prov.write_memory(workspace_path, central)
                        new_hashes[prov.cli_type] = {"hash": _sha256(central)}
                        pushed.append(prov.cli_type)
                if pushed:
                    await self._save(workspace_id, scope, central, new_hashes)
                    return SyncResult(status="synced", providers_updated=pushed)
            return SyncResult(status="up_to_date")

        # ── Single provider changed ──────────────────────────────────
        if len(changed) == 1:
            src = changed[0]
            new_content = states[src]["content"]
            new_hashes = dict(stored)
            pushed = []
            for prov in all_providers():
                new_hashes[prov.cli_type] = {"hash": _sha256(new_content)}
                if prov.cli_type != src:
                    prov.write_memory(workspace_path, new_content)
                    pushed.append(prov.cli_type)
            await self._save(workspace_id, scope, new_content, new_hashes)
            return SyncResult(status="synced", providers_updated=pushed,
                              merged_content=new_content)

        # ── Multiple providers changed → three-way merge ─────────────
        merged = central
        total_conflicts = 0
        all_diffs: dict[str, str] = {}

        for cli in changed:
            content = states[cli]["content"]
            prov = get_provider(cli)
            label = (prov.memory_filename if prov else cli) or cli
            diff = git_diff(central or "", content, "central", label)
            if diff:
                all_diffs[cli] = diff

            use_union = not central  # first sync → union
            result_text, _has, count = git_merge_file(
                central or "", merged, content,
                ours_label="merged", theirs_label=label,
                union=use_union,
            )
            merged = result_text
            total_conflicts += count

        if total_conflicts > 0:
            return SyncResult(
                status="conflicts",
                merged_content=merged,
                conflict_count=total_conflicts,
                conflicts=parse_conflict_markers(merged),
                diffs=all_diffs,
            )

        # Clean merge — push everywhere
        new_hashes = {}
        pushed = []
        for prov in all_providers():
            prov.write_memory(workspace_path, merged)
            new_hashes[prov.cli_type] = {"hash": _sha256(merged)}
            pushed.append(prov.cli_type)
        await self._save(workspace_id, scope, merged, new_hashes)
        return SyncResult(status="synced", providers_updated=pushed,
                          merged_content=merged, diffs=all_diffs)

    # ── Conflict resolution ──────────────────────────────────────────

    async def resolve_conflicts(
        self,
        workspace_id: str,
        workspace_path: str,
        resolved_content: str,
        push_to: Optional[list[str]] = None,
        scope: str = "project",
    ) -> SyncResult:
        targets = push_to or [p.cli_type for p in all_providers()]
        new_hashes: dict[str, dict] = {}
        pushed: list[str] = []

        for prov in all_providers():
            if prov.cli_type in targets:
                prov.write_memory(workspace_path, resolved_content)
                pushed.append(prov.cli_type)
            current = prov.read_memory(workspace_path)
            if current is not None:
                new_hashes[prov.cli_type] = {"hash": _sha256(current)}

        await self._save(workspace_id, scope, resolved_content, new_hashes)
        return SyncResult(status="synced", providers_updated=pushed,
                          merged_content=resolved_content)

    # ── Status / diff / settings ─────────────────────────────────────

    async def get_status(self, workspace_id: str, workspace_path: str,
                         scope: str = "project") -> SyncStatus:
        record = await self._get_or_create(workspace_id, scope)
        central = record["content"] or ""
        stored = json.loads(record.get("provider_hashes", "{}"))
        settings = json.loads(record.get("settings", "{}"))

        providers: dict[str, dict] = {}
        for prov in all_providers():
            content = prov.read_memory(workspace_path)
            cur_hash = _sha256(content) if content is not None else None
            prev_hash = stored.get(prov.cli_type, {}).get("hash")
            providers[prov.cli_type] = {
                "file": str(prov.memory_file_path(workspace_path) or ""),
                "filename": prov.memory_filename or "",
                "file_exists": content is not None,
                "file_hash": cur_hash,
                "synced": cur_hash == prev_hash,
                "changed": cur_hash is not None and cur_hash != prev_hash,
                "content_length": len(content) if content else 0,
            }

        return SyncStatus(
            enabled=settings.get("enabled", False),
            auto_sync=settings.get("auto_sync", False),
            last_synced_at=record.get("last_synced_at"),
            central_content_length=len(central),
            providers=providers,
        )

    async def get_diff(self, workspace_id: str, workspace_path: str,
                       scope: str = "project") -> dict:
        record = await self._get_or_create(workspace_id, scope)
        central = record["content"] or ""
        diffs: dict[str, dict] = {}
        for prov in all_providers():
            content = prov.read_memory(workspace_path)
            if content is not None and content != central:
                label = prov.memory_filename or prov.cli_type
                diffs[prov.cli_type] = {
                    "filename": label,
                    "diff": git_diff(central, content, "central", label),
                }
        return diffs

    async def get_settings(self, workspace_id: str, scope: str = "project") -> dict:
        record = await self._get_or_create(workspace_id, scope)
        return json.loads(record.get("settings", "{}"))

    async def update_settings(self, workspace_id: str, settings: dict,
                              scope: str = "project") -> dict:
        record = await self._get_or_create(workspace_id, scope)
        current = json.loads(record.get("settings", "{}"))
        current.update(settings)
        hashes = json.loads(record.get("provider_hashes", "{}"))
        await self._save(workspace_id, scope, record["content"] or "", hashes,
                         settings=current)
        return current

    # ── Central memory CRUD ──────────────────────────────────────────

    async def read_central(self, workspace_id: str, scope: str = "project") -> str:
        record = await self._get_or_create(workspace_id, scope)
        return record["content"] or ""

    async def write_central(self, workspace_id: str, content: str,
                            scope: str = "project") -> None:
        record = await self._get_or_create(workspace_id, scope)
        hashes = json.loads(record.get("provider_hashes", "{}"))
        await self._save(workspace_id, scope, content, hashes)

    # ── Auto-memory ──────────────────────────────────────────────────

    async def read_all_auto_memory(self, workspace_path: str) -> dict[str, list[dict]]:
        result: dict[str, list[dict]] = {}
        for prov in all_providers():
            entries = prov.read_auto_memory(workspace_path)
            if entries:
                result[prov.cli_type] = entries
        return result

    # ── Rich handoff context (replaces dumb terminal tail) ───────────

    async def build_handoff_context(
        self,
        session_id: str,
        workspace_id: str,
        workspace_path: str,
        old_cli: str,
        new_cli: str,
        capture_proc=None,
    ) -> str:
        """Build structured context for a CLI switch.

        Replaces the old 3000-char raw terminal tail with:
          1. Central / project memory
          2. Auto-memory entries (user prefs, feedback)
          3. Active tasks from the workspace
          4. Session guidelines
          5. Trimmed recent conversation
        """
        parts: list[str] = []
        parts.append(
            f"[Session handoff] Switching from {old_cli.upper()} to {new_cli.upper()}. "
            f"Continue where the previous session left off."
        )

        # 1. Project memory (central or fall back to old CLI's file)
        central = await self.read_central(workspace_id)
        if not central:
            prov = get_provider(old_cli)
            if prov:
                central = prov.read_memory(workspace_path) or ""
        if central:
            parts.append(f"## Project Memory\n{central[:4000]}")

        # 2. Auto-memory
        all_auto = await self.read_all_auto_memory(workspace_path)
        if all_auto:
            lines: list[str] = []
            for cli, entries in all_auto.items():
                for entry in entries[:10]:
                    name = entry.get("name", "")
                    etype = entry.get("type", "")
                    body = entry.get("content", "")
                    if body:
                        lines.append(f"- **[{etype}] {name}**: {body[:200]}")
            if lines:
                parts.append("## Remembered Context\n" + "\n".join(lines))

        # 3. Active tasks
        try:
            from db import get_db
            db = await get_db()
            try:
                cur = await db.execute(
                    """SELECT title, status FROM tasks
                       WHERE workspace_id = ? AND status IN ('in_progress','todo','backlog')
                       ORDER BY status, sort_order LIMIT 10""",
                    (workspace_id,),
                )
                tasks = [dict(r) for r in await cur.fetchall()]
            finally:
                await db.close()
            if tasks:
                parts.append(
                    "## Active Tasks\n"
                    + "\n".join(f"- [{t['status']}] {t['title']}" for t in tasks)
                )
        except Exception:
            pass

        # 4. Session guidelines
        try:
            from db import get_db
            db = await get_db()
            try:
                cur = await db.execute(
                    """SELECT g.name, g.content FROM guidelines g
                       JOIN session_guidelines sg ON g.id = sg.guideline_id
                       WHERE sg.session_id = ?""",
                    (session_id,),
                )
                guidelines = [dict(r) for r in await cur.fetchall()]
            finally:
                await db.close()
            if guidelines:
                g_parts = [f"### {g['name']}\n{g['content'][:500]}" for g in guidelines]
                parts.append("## Guidelines\n" + "\n\n".join(g_parts))
        except Exception:
            pass

        # 5. Recent conversation (trimmed)
        if capture_proc:
            try:
                raw = capture_proc.get_buffer(session_id, 20)
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", errors="replace")
                clean = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", raw)
                tail = clean[-1500:].strip()
                if tail:
                    parts.append(f"## Recent Conversation\n```\n{tail}\n```")
            except Exception:
                pass

        return "\n\n".join(parts)

    # ── Debounced sync trigger ───────────────────────────────────────

    async def debounced_sync(
        self,
        workspace_id: str,
        workspace_path: str,
        source_cli: Optional[str] = None,
        delay: float = 3.0,
    ):
        """Trigger a sync after *delay* seconds, coalescing rapid calls."""
        key = f"{workspace_id}:{source_cli or 'all'}"

        existing = self._debounce_tasks.get(key)
        if existing and not existing.done():
            existing.cancel()

        async def _run():
            await asyncio.sleep(delay)
            try:
                result = await self.sync(workspace_id, workspace_path,
                                         source_cli=source_cli)
                if result.status == "synced":
                    logger.info(
                        "Memory auto-synced for workspace %s: updated %s",
                        workspace_id[:8], result.providers_updated,
                    )
                elif result.status == "conflicts":
                    logger.warning(
                        "Memory sync conflicts for workspace %s: %d conflicts",
                        workspace_id[:8], result.conflict_count,
                    )
                    # Notify frontend
                    try:
                        from hooks import _broadcast
                        if _broadcast:
                            await _broadcast({
                                "type": "memory_sync_conflict",
                                "workspace_id": workspace_id,
                                "conflict_count": result.conflict_count,
                            })
                    except Exception:
                        pass
            except Exception as exc:
                logger.error("Debounced memory sync failed: %s", exc)
            finally:
                self._debounce_tasks.pop(key, None)

        self._debounce_tasks[key] = asyncio.create_task(_run())


# ─── Module-level singleton ─────────────────────────────────────────

sync_manager = MemorySyncManager()


# ─── Hook integration helpers ────────────────────────────────────────

async def on_memory_file_changed(
    session_id: str,
    file_path: str,
    workspace_id: Optional[str] = None,
    workspace_path: Optional[str] = None,
):
    """Called when a hook indicates a memory file was written / edited.

    Resolves workspace from session if not provided, checks if auto-sync
    is enabled, and triggers a debounced sync.
    """
    if not workspace_id or not workspace_path:
        from db import get_db
        db = await get_db()
        try:
            cur = await db.execute(
                """SELECT s.workspace_id, w.path FROM sessions s
                   JOIN workspaces w ON s.workspace_id = w.id
                   WHERE s.id = ?""",
                (session_id,),
            )
            row = await cur.fetchone()
            if not row:
                return
            workspace_id = row["workspace_id"]
            workspace_path = row["path"]
        finally:
            await db.close()

    settings = await sync_manager.get_settings(workspace_id)
    if not settings.get("enabled") or not settings.get("auto_sync"):
        return

    source_cli = None
    for prov in all_providers():
        if prov.is_memory_path(file_path):
            source_cli = prov.cli_type
            break

    debounce_sec = settings.get("debounce_sec", 3.0)
    await sync_manager.debounced_sync(
        workspace_id, workspace_path,
        source_cli=source_cli,
        delay=debounce_sec,
    )
