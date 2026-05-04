"""Server-driven code-catalog bootstrap.

Walks `git ls-files` for a workspace, batches files (~10 per LLM call), asks
the configured catalog model to emit one wire-format line per public symbol,
then bulk-upserts the result.

Why this lives on the server (not as a worker-session skill):
- The user clicks one button instead of opening a session and typing a
  slash command. The skill stays as a fallback for scripted/advanced use.
- We reuse the existing `code_catalog.upsert_catalog_entry` path, so dedup
  and history work the same as session-end auto-extract.
- Model resolution honours `workspaces.code_catalog_model` (the setting that
  used to only affect session-end extract — now it affects bootstrap too).

Job state is in-memory per workspace. One bootstrap per workspace at a time.
Restarting the server cancels any in-flight bootstrap (the next request
returns 'no job').
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


# ── Tunables ─────────────────────────────────────────────────────────────

# Files per LLM call. Lower = more progress events + finer cancel; higher =
# fewer round-trips. 8 keeps the prompt under ~80KB at our per-file cap.
_FILES_PER_BATCH = 8

# Max bytes of a single file we'll send to the LLM. Files larger than this
# are head/tail-truncated with a marker.
_FILE_MAX_BYTES = 8_000

# Max bytes prompt-wide. If a batch of files exceeds this, we trim per-file
# until it fits or split the batch in half.
_PROMPT_BUDGET_BYTES = 80_000

# Per-batch timeout — bootstrap is allowed to be slower than session-end
# extract because the prompt is bigger.
_LLM_TIMEOUT_S = 240

# Hard cap on files cataloged in one bootstrap. Repos bigger than this are
# the user's call to do in chunks; 800 source files is already a lot.
_MAX_FILES = 800


# Files / paths we never want to feed to the LLM. Exact-match dirs are
# checked as a path component; suffixes match the file name.
_SKIP_DIRS = frozenset({
    "node_modules", "dist", "build", ".next", "out", "target", ".venv",
    "venv", "__pycache__", ".pytest_cache", ".mypy_cache", "coverage",
    ".git", ".idea", ".vscode", ".turbo", "vendor", "third_party",
    "site-packages", ".cache", "tmp", "temp",
})

_SKIP_NAME_SUFFIXES = (
    # binaries / media
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".webp", ".bmp", ".tiff",
    ".pdf", ".zip", ".tar", ".gz", ".tgz", ".bz2", ".7z", ".rar",
    ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".mov", ".avi", ".mkv",
    ".ttf", ".woff", ".woff2", ".eot", ".otf",
    ".so", ".dylib", ".dll", ".exe", ".o", ".a",
    ".pyc", ".class", ".jar", ".war",
    # generated / lockfiles
    ".lock", ".lockb",
    ".min.js", ".min.css", ".min.map", ".js.map", ".css.map",
    ".d.ts",  # type declarations are usually generated; cataloging them is noise
)

# Extensions we definitely want to catalog (others are kept too, but these
# get priority when we need to enforce _MAX_FILES).
_PRIORITY_EXTS = frozenset({
    ".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".go", ".rs", ".rb", ".php", ".java", ".kt", ".scala",
    ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hh",
    ".swift", ".m", ".mm",
    ".lua", ".sh", ".bash", ".zsh",
    ".css", ".scss", ".sass", ".vue", ".svelte",
    ".sql", ".prisma",
})


# ── Job state (in-memory) ────────────────────────────────────────────────

# {workspace_id: dict}. None of these keys are persisted; restarting the
# server clears the registry.
_JOBS: dict[str, dict[str, Any]] = {}
_JOB_LOCK = asyncio.Lock()


def _public_state(job: dict[str, Any]) -> dict[str, Any]:
    """Strip non-serializable members before returning to HTTP callers."""
    out = {k: v for k, v in job.items() if not k.startswith("_")}
    return out


def get_status(workspace_id: str) -> dict[str, Any] | None:
    j = _JOBS.get(workspace_id)
    return _public_state(j) if j else None


async def cancel(workspace_id: str) -> bool:
    """Flag the active bootstrap as cancelled. Returns True if there was one."""
    j = _JOBS.get(workspace_id)
    if not j or j.get("status") != "running":
        return False
    j["_cancel"] = True
    return True


# ── File discovery ───────────────────────────────────────────────────────


def _is_skipped(rel_path: str) -> bool:
    parts = rel_path.split("/")
    for p in parts[:-1]:
        if p in _SKIP_DIRS or p.startswith("."):
            # Allow well-known dotfiles dirs that are commonly source (.github
            # workflows, .config). Skip the rest.
            if p not in (".github", ".config"):
                return True
    name = parts[-1]
    if name.startswith("."):
        return True
    low = name.lower()
    for suf in _SKIP_NAME_SUFFIXES:
        if low.endswith(suf):
            return True
    # Common test patterns — skip catalog noise.
    if "_test." in low or low.endswith("_test.go") or ".test." in low or ".spec." in low:
        return True
    return False


async def list_workspace_files(workspace_path: str) -> list[str]:
    """Return workspace-relative paths suitable for cataloging.

    Uses `git ls-files` so we respect .gitignore. Falls back to a manual walk
    if the workspace isn't a git repo.
    """
    p = Path(workspace_path).resolve()
    if not p.exists():
        return []

    files: list[str] = []
    if (p / ".git").exists():
        proc = await asyncio.create_subprocess_exec(
            "git", "-C", str(p), "ls-files",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode == 0:
            files = [ln for ln in stdout.decode("utf-8", "replace").splitlines() if ln]
    if not files:
        for root, dirs, names in os.walk(p):
            dirs[:] = [d for d in dirs if d not in _SKIP_DIRS and not d.startswith(".")]
            for n in names:
                rel = os.path.relpath(os.path.join(root, n), p)
                files.append(rel)

    files = [f for f in files if not _is_skipped(f)]

    def _priority_key(rel: str) -> tuple[int, str]:
        ext = os.path.splitext(rel)[1].lower()
        # Priority extensions first, then everything else, alphabetical within
        # each bucket so the LLM sees coherent neighbourhoods.
        return (0 if ext in _PRIORITY_EXTS else 1, rel)

    files.sort(key=_priority_key)
    if len(files) > _MAX_FILES:
        files = files[:_MAX_FILES]
    return files


# ── Prompt + LLM call ────────────────────────────────────────────────────

_BOOTSTRAP_PROMPT = """You are bootstrapping a code catalog for a software project. For each file
provided below, emit ONE wire-format line per PUBLIC / EXPORTED symbol the
file defines.

WIRE FORMAT (one line per symbol, NO markdown bullets):

  <relative-path>::<symbol>(<args>?): <purpose> [| →<dep> ←<caller>] [◆<effect>]*

RULES (strict):
- Use the EXACT relative path shown in the === path === header. Do not invent paths.
- <symbol>: function name, or Class.method for methods. For HTTP routes use METHOD /path.
- <args>: comma-separated arg names, NO types. Omit "()" entirely if no args.
- <purpose>: present tense, ~10–15 words, no trailing period.
- <flow> after "|": "→dep" for things this calls; "←caller" only when non-obvious.
- <effect> after "◆": side effects ("◆writes db", "◆reads cache", "◆mutates state",
  "◆emits event:foo", "◆network", "◆fs"). Repeatable.
- One line per symbol. Skip private one-letter helpers, trivial getters, and tests.
- If a file has no public symbols (e.g. config, data), skip it — emit nothing.
- Keep each line under ~200 chars.

OUTPUT JSON, EXACTLY:
  {"entries": ["<line1>", "<line2>", ...]}

If no symbols found across all files, return {"entries": []}.

=== FILES ===
{files_block}
"""


def _truncate_file(content: str, max_bytes: int) -> str:
    """Head/tail truncation with a marker, so the LLM still sees the shape
    of large files (imports + exports usually live near the edges)."""
    b = content.encode("utf-8", errors="replace")
    if len(b) <= max_bytes:
        return content
    half = max_bytes // 2 - 40
    head = b[:half].decode("utf-8", errors="ignore")
    tail = b[-half:].decode("utf-8", errors="ignore")
    return f"{head}\n\n...[truncated {len(b) - max_bytes} bytes]...\n\n{tail}"


def _build_files_block(workspace_path: str, batch: list[str]) -> str:
    chunks = []
    budget = _PROMPT_BUDGET_BYTES
    per_file_cap = _FILE_MAX_BYTES
    for rel in batch:
        full = os.path.join(workspace_path, rel)
        try:
            with open(full, encoding="utf-8", errors="replace") as fh:
                txt = fh.read()
        except (OSError, UnicodeDecodeError):
            continue
        truncated = _truncate_file(txt, per_file_cap)
        chunk = f"=== {rel} ===\n{truncated}\n"
        b = len(chunk.encode("utf-8", errors="replace"))
        if b > budget and chunks:
            # Already have at least one file; stop the batch to stay in budget.
            break
        chunks.append(chunk)
        budget -= b
    return "\n".join(chunks)


def _resolve_model(ws_row: dict[str, Any] | None) -> tuple[str, str]:
    """(cli, model). Honours workspaces.code_catalog_model > research_model > default."""
    model = None
    if ws_row:
        model = (ws_row.get("code_catalog_model") or "").strip() or None
        if not model:
            model = (ws_row.get("research_model") or "").strip() or None
    if not model:
        model = "sonnet"  # safe default
    cli = "gemini" if model.startswith("gemini-") else "claude"
    return cli, model


# ── Orchestrator ─────────────────────────────────────────────────────────


async def _emit(event_name: str, payload: dict[str, Any]) -> None:
    try:
        from event_bus import bus
        from commander_events import CommanderEvent
        ev = CommanderEvent[event_name]
        await bus.emit(ev, payload, source="code_catalog_bootstrap")
    except Exception:
        logger.exception("bootstrap event emit failed: %s", event_name)


async def _process_batch(
    *,
    workspace_id: str,
    workspace_path: str,
    cli: str,
    model: str,
    batch: list[str],
    contributor: str,
) -> dict[str, int]:
    """Run one LLM call + upsert pass for a batch of files."""
    counts = {"inserted": 0, "confirmed": 0, "replaced": 0, "rejected": 0}

    files_block = _build_files_block(workspace_path, batch)
    if not files_block:
        return counts
    prompt = _BOOTSTRAP_PROMPT.format(files_block=files_block)

    try:
        from llm_router import llm_call_json
        result = await llm_call_json(
            cli=cli, model=model, prompt=prompt, timeout=_LLM_TIMEOUT_S,
        )
    except Exception as exc:
        logger.warning("bootstrap batch LLM call failed: %s", exc)
        counts["rejected"] += len(batch)
        return counts

    entries = result.get("entries") if isinstance(result, dict) else None
    if not isinstance(entries, list):
        return counts

    from code_catalog import upsert_catalog_entry
    for raw in entries:
        if not isinstance(raw, str) or not raw.strip():
            continue
        try:
            row = await upsert_catalog_entry(
                workspace_id=workspace_id,
                raw_line=raw,
                contributed_by=contributor,
            )
            kind = row.get("change_kind", "noop_invalid")
            if kind in counts:
                counts[kind] += 1
            elif kind == "noop_invalid":
                counts["rejected"] += 1
        except Exception:
            logger.exception("bootstrap upsert failed for: %r", raw[:120])
            counts["rejected"] += 1
    return counts


async def _run_bootstrap(
    *,
    workspace_id: str,
    workspace_path: str,
    cli: str,
    model: str,
    files: list[str],
    contributor: str,
) -> None:
    """The actual job loop. Mutates _JOBS[workspace_id] in-place."""
    job = _JOBS[workspace_id]
    started = time.time()

    await _emit("CODE_CATALOG_BOOTSTRAP_STARTED", {
        "workspace_id": workspace_id,
        "total_files": len(files),
        "model": model,
        "cli": cli,
    })

    try:
        for i in range(0, len(files), _FILES_PER_BATCH):
            if job.get("_cancel"):
                job["status"] = "cancelled"
                job["error"] = "cancelled by user"
                job["ended_at"] = datetime.now(timezone.utc).isoformat()
                await _emit("CODE_CATALOG_BOOTSTRAP_FAILED", {
                    "workspace_id": workspace_id,
                    "reason": "cancelled",
                    "completed_files": job["completed_files"],
                    "total_files": len(files),
                    "counts": dict(job["counts"]),
                })
                return

            batch = files[i:i + _FILES_PER_BATCH]
            job["current_files"] = batch[:]

            batch_counts = await _process_batch(
                workspace_id=workspace_id,
                workspace_path=workspace_path,
                cli=cli, model=model,
                batch=batch,
                contributor=contributor,
            )
            for k, v in batch_counts.items():
                job["counts"][k] = job["counts"].get(k, 0) + v
            job["completed_files"] += len(batch)

            await _emit("CODE_CATALOG_BOOTSTRAP_PROGRESS", {
                "workspace_id": workspace_id,
                "completed_files": job["completed_files"],
                "total_files": len(files),
                "counts": dict(job["counts"]),
                "recent_files": batch[:],
            })

        job["status"] = "completed"
        job["ended_at"] = datetime.now(timezone.utc).isoformat()
        await _emit("CODE_CATALOG_BOOTSTRAP_COMPLETED", {
            "workspace_id": workspace_id,
            "total_files": len(files),
            "completed_files": job["completed_files"],
            "counts": dict(job["counts"]),
            "duration_s": round(time.time() - started, 1),
            "model": model,
        })
    except Exception as exc:
        logger.exception("bootstrap crashed for %s", workspace_id)
        job["status"] = "failed"
        job["error"] = str(exc)
        job["ended_at"] = datetime.now(timezone.utc).isoformat()
        await _emit("CODE_CATALOG_BOOTSTRAP_FAILED", {
            "workspace_id": workspace_id,
            "reason": "exception",
            "error": str(exc),
            "completed_files": job["completed_files"],
            "total_files": len(files),
            "counts": dict(job["counts"]),
        })


# ── Public entrypoints ───────────────────────────────────────────────────


async def estimate(workspace_id: str) -> dict[str, Any]:
    """Quick file-count + model-name preview the UI shows in the confirm dialog."""
    from db import get_db
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT path, code_catalog_model, research_model
                 FROM workspaces WHERE id = ?""",
            (workspace_id,),
        )
        row = await cur.fetchone()
    finally:
        await db.close()
    if not row:
        return {"error": "workspace not found"}
    files = await list_workspace_files(row["path"])
    cli, model = _resolve_model(dict(row))
    return {
        "total_files": len(files),
        "model": model,
        "cli": cli,
        "model_source": (
            "code_catalog_model" if (row["code_catalog_model"] or "").strip()
            else "research_model" if (row["research_model"] or "").strip()
            else "default"
        ),
        "max_files": _MAX_FILES,
        "files_per_batch": _FILES_PER_BATCH,
    }


async def start(workspace_id: str, *, contributor: str = "bootstrap") -> dict[str, Any]:
    """Start a bootstrap. Idempotent: returns 'already_running' if one is active."""
    async with _JOB_LOCK:
        existing = _JOBS.get(workspace_id)
        if existing and existing.get("status") == "running":
            return {"status": "already_running", "job": _public_state(existing)}

        from db import get_db
        db = await get_db()
        try:
            cur = await db.execute(
                """SELECT path, code_catalog_model, research_model
                     FROM workspaces WHERE id = ?""",
                (workspace_id,),
            )
            row = await cur.fetchone()
        finally:
            await db.close()
        if not row:
            return {"status": "not_found"}

        files = await list_workspace_files(row["path"])
        if not files:
            return {"status": "no_files"}

        cli, model = _resolve_model(dict(row))

        job: dict[str, Any] = {
            "workspace_id": workspace_id,
            "status": "running",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "ended_at": None,
            "model": model,
            "cli": cli,
            "total_files": len(files),
            "completed_files": 0,
            "counts": {"inserted": 0, "confirmed": 0, "replaced": 0, "rejected": 0},
            "current_files": [],
            "error": None,
            "_cancel": False,
            "_task": None,
        }
        _JOBS[workspace_id] = job

        task = asyncio.create_task(_run_bootstrap(
            workspace_id=workspace_id,
            workspace_path=row["path"],
            cli=cli, model=model,
            files=files,
            contributor=contributor,
        ))
        job["_task"] = task

    return {"status": "started", "job": _public_state(job)}
