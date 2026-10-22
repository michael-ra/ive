"""Files and folders as chat context (the composer's `@` picker and drops).

Three endpoints, all scoped to one session:

  GET  /api/sessions/{id}/context/search?q=<fuzzy>&limit=<n>
       Fuzzy search over the session's working folder (its worktree, else the
       workspace path). Files come from `git ls-files --cached --others
       --exclude-standard`, so .gitignore is honoured; outside git a walk that
       skips the usual heavy folders (node_modules, .git, .venv, dist, ...).
       Folders are derived from the file list. Each returned file carries a
       `status`: ok, binary or too_large, so the UI can refuse it up front.

  GET  /api/sessions/{id}/context/inspect?path=<relative path>
  GET  /api/sessions/{id}/context/inspect?upload=<absolute attachment path>
       Validates one entry before (and after) it becomes a chip and returns a
       short preview: the first lines of a text file, the first children of a
       folder. Absolute paths, `..` and symlinks that leave the working folder
       are refused (403), so nothing outside the project can be read here.

  POST /api/sessions/{id}/context/upload   (multipart, field "file")
       A text file dropped from outside the project. Stored content-addressed
       in <IVE data>/attachments/sessions/<id>/context/<sha8>-<name> (the same
       content twice gives the same path) and referenced by that absolute path.
       Binary files and files over MAX_UPLOAD_BYTES are refused with a reason.

How the chips reach the CLI is defined in frontend/src/lib/chatContext.js:
Claude and Gemini get `@path` mentions (their CLIs read the file when the
prompt is submitted), Codex and every other CLI get plain paths that the
agent opens with its own tools. Contents are never pasted into the prompt.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Awaitable, Callable

from aiohttp import web

MAX_PROJECT_FILE_BYTES = 1024 * 1024          # bigger project files are refused as context
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_UPLOAD_BYTES = 1024 * 1024
MAX_INDEX_ENTRIES = 20000
INDEX_TTL_SECONDS = 10.0
PREVIEW_LINES = 40
PREVIEW_CHILDREN = 40

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
BINARY_EXTS = {
    ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".tar", ".jar",
    ".exe", ".dll", ".so", ".dylib", ".o", ".a", ".class", ".pyc", ".wasm",
    ".mp3", ".mp4", ".mov", ".m4a", ".wav", ".avi", ".mkv", ".webm", ".flac",
    ".ttf", ".otf", ".woff", ".woff2", ".ico", ".icns", ".psd", ".sketch",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".key", ".numbers", ".pages",
    ".sqlite", ".db", ".bin", ".dmg", ".iso", ".heic", ".tif", ".tiff", ".bmp",
}
WALK_SKIP_DIRS = {
    ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build",
    ".next", ".nuxt", ".cache", "target", ".idea", ".pytest_cache", ".mypy_cache",
    ".tox", "coverage", ".turbo", ".parcel-cache", ".svelte-kit", "Pods",
}


class ContextPathError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ─── classification ──────────────────────────────────────────────────

def looks_like_text(data: bytes) -> bool:
    if not data:
        return True
    if b"\x00" in data:
        return False
    sample = data[:4096]
    control = sum(1 for b in sample if b < 32 and b not in (9, 10, 12, 13, 27))
    if control / max(len(sample), 1) >= 0.08:
        return False
    try:
        sample.decode("utf-8")
        return True
    except UnicodeDecodeError as exc:
        # A multi-byte character cut at the sample end is still text.
        return exc.start >= len(sample) - 3


def human_size(size: int) -> str:
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    if size >= 1024:
        return f"{size / 1024:.0f} KB"
    return f"{size} B"


def classify_file(path: Path) -> dict:
    """status ok / binary / too_large plus a reason the UI can show."""
    try:
        size = path.stat().st_size
    except OSError:
        return {"status": "missing", "reason": "File can't be read.", "size": None}
    ext = path.suffix.lower()
    if ext in IMAGE_EXTS:
        if size > MAX_IMAGE_BYTES:
            return {"status": "too_large", "size": size,
                    "reason": f"Image is {human_size(size)}; the limit is {human_size(MAX_IMAGE_BYTES)}."}
        return {"status": "ok", "size": size, "file_type": "image"}
    if ext in BINARY_EXTS:
        return {"status": "binary", "size": size,
                "reason": f"{ext[1:].upper()} files are binary; only text files, folders and images can be context."}
    if size > MAX_PROJECT_FILE_BYTES:
        return {"status": "too_large", "size": size,
                "reason": f"File is {human_size(size)}; the limit for context files is {human_size(MAX_PROJECT_FILE_BYTES)}."}
    try:
        with open(path, "rb") as f:
            head = f.read(8192)
    except OSError:
        return {"status": "missing", "size": size, "reason": "File can't be read."}
    if not looks_like_text(head):
        return {"status": "binary", "size": size,
                "reason": "Binary file; only text files, folders and images can be context."}
    return {"status": "ok", "size": size, "file_type": "text"}


# ─── safe path resolution ────────────────────────────────────────────

def resolve_in_root(root: Path, raw: str) -> tuple[Path, str]:
    """Resolve a user path inside root. Returns (absolute path, posix rel path).

    Refuses absolute paths, `~`, NUL bytes and anything (including symlinks)
    that resolves outside root.
    """
    text = (raw or "").strip()
    if not text:
        raise ContextPathError("path is required")
    if "\x00" in text:
        raise ContextPathError("invalid path")
    if text.startswith(("/", "~", "\\")) or re.match(r"^[A-Za-z]:[\\/]", text):
        raise ContextPathError("path must be relative to the session folder", 403)
    root = root.resolve()
    candidate = (root / text.rstrip("/")).resolve()
    if candidate != root and not candidate.is_relative_to(root):
        raise ContextPathError("path is outside the session folder", 403)
    rel = candidate.relative_to(root).as_posix()
    return candidate, ("." if rel in ("", ".") else rel)


# ─── project index ───────────────────────────────────────────────────

_index_cache: dict[str, tuple[float, list[str], bool]] = {}


def _git_files(root: Path) -> list[str] | None:
    try:
        proc = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            capture_output=True, timeout=8, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    out = proc.stdout.decode("utf-8", errors="replace")
    return [p for p in out.split("\x00") if p]


def _walk_files(root: Path) -> list[str]:
    files: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if d not in WALK_SKIP_DIRS)
        rel_dir = Path(dirpath).relative_to(root)
        for name in sorted(filenames):
            if name == ".DS_Store":
                continue
            files.append((rel_dir / name).as_posix() if str(rel_dir) != "." else name)
            if len(files) >= MAX_INDEX_ENTRIES:
                return files
    return files


def build_index(root: Path) -> tuple[list[str], bool]:
    """Sorted list of entries (folders end with "/"), and whether it was capped."""
    key = str(root)
    hit = _index_cache.get(key)
    if hit and time.monotonic() - hit[0] < INDEX_TTL_SECONDS:
        return hit[1], hit[2]
    files = _git_files(root)
    if files is None:
        files = _walk_files(root)
    # git also lists files inside submodule-less nested paths; drop anything
    # that went away since (deleted but still in the index).
    capped = len(files) > MAX_INDEX_ENTRIES
    files = files[:MAX_INDEX_ENTRIES]
    dirs: set[str] = set()
    for f in files:
        parts = f.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            dirs.add("/".join(parts[:i]) + "/")
    entries = sorted(dirs) + sorted(files)
    _index_cache[key] = (time.monotonic(), entries, capped)
    return entries, capped


def fuzzy_score(query: str, path: str) -> float | None:
    """fzf-like score; None = no match. Every query term must match."""
    p = path.lower().rstrip("/")
    name = p.rsplit("/", 1)[-1]
    total = 0.0
    for term in query.lower().split():
        if term in name:
            s = 100.0 + (30.0 if name.startswith(term) else 0.0) + (20.0 if name == term or name.split(".")[0] == term else 0.0)
        elif term in p:
            s = 60.0 + (10.0 if p.startswith(term) else 0.0)
        else:
            # subsequence with gap penalty
            pos, gaps, last = 0, 0, -1
            for ch in term:
                idx = p.find(ch, pos)
                if idx < 0:
                    return None
                if last >= 0:
                    gaps += idx - last - 1
                last, pos = idx, idx + 1
            s = max(1.0, 40.0 - gaps * 0.8)
        total += s
    return total - len(p) * 0.05 - p.count("/") * 0.5


def search(root: Path, query: str, limit: int = 30) -> dict:
    entries, capped = build_index(root)
    q = (query or "").strip()
    if not q:
        top = [e for e in entries if e.rstrip("/").count("/") == 0]
        ranked = sorted(top, key=lambda e: (not e.endswith("/"), e.lower()))
        hits = ranked[:limit]
    else:
        scored = []
        for e in entries:
            s = fuzzy_score(q, e)
            if s is not None:
                scored.append((s, e))
        scored.sort(key=lambda t: (-t[0], t[1]))
        hits = [e for _, e in scored[:limit]]
    items = []
    for e in hits:
        if e.endswith("/"):
            rel = e.rstrip("/")
            items.append({"path": rel, "kind": "dir", "name": rel.rsplit("/", 1)[-1], "status": "ok"})
            continue
        target = root / e
        if not target.resolve().is_relative_to(root.resolve()):
            items.append({"path": e, "kind": "file", "name": e.rsplit("/", 1)[-1], "status": "outside",
                          "reason": "Link points outside the session folder."})
            continue
        info = classify_file(target)
        if info["status"] == "missing":
            continue
        items.append({"path": e, "kind": "file", "name": e.rsplit("/", 1)[-1], **info})
    return {"items": items, "capped": capped, "root_name": root.name}


def inspect(root: Path, raw: str) -> dict:
    path, rel = resolve_in_root(root, raw)
    if not path.exists():
        raise ContextPathError(f"{rel} no longer exists in the session folder", 404)
    if path.is_dir():
        children = []
        try:
            for child in sorted(path.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower())):
                if child.name in WALK_SKIP_DIRS or child.name == ".DS_Store":
                    continue
                children.append(child.name + ("/" if child.is_dir() else ""))
                if len(children) >= PREVIEW_CHILDREN + 1:
                    break
        except OSError as exc:
            raise ContextPathError(f"folder can't be read: {exc.strerror}", 500)
        return {"path": rel, "kind": "dir", "name": path.name, "status": "ok", "abs_path": str(path),
                "children": children[:PREVIEW_CHILDREN], "more": len(children) > PREVIEW_CHILDREN}
    info = classify_file(path)
    out = {"path": rel, "kind": "file", "name": path.name, "abs_path": str(path), **info}
    if info["status"] == "ok" and info.get("file_type") == "text":
        with open(path, "rb") as f:
            data = f.read(16 * 1024)
        lines = data.decode("utf-8", errors="replace").splitlines()
        out["preview"] = "\n".join(lines[:PREVIEW_LINES])
        out["preview_truncated"] = len(lines) > PREVIEW_LINES or info["size"] > len(data)
    return out


def inspect_upload(folder: Path, raw: str) -> dict:
    """Re-check a file dropped earlier (chips restored after a reload). Only
    paths inside this session's attachment folder are answered."""
    if not raw:
        raise ContextPathError("no attachment path given", 400)
    try:
        base = folder.resolve()
        path = Path(raw).resolve()
    except (OSError, RuntimeError):
        raise ContextPathError("invalid attachment path", 400)
    if not path.is_relative_to(base):
        raise ContextPathError("not an attachment of this session", 403)
    if not path.is_file():
        raise ContextPathError(f"{path.name} is no longer in this session's attachments", 404)
    size = path.stat().st_size
    with open(path, "rb") as f:
        data = f.read(16 * 1024)
    lines = data.decode("utf-8", errors="replace").splitlines()
    return {"kind": "upload", "status": "ok", "path": str(path), "abs_path": str(path), "size": size,
            "preview": "\n".join(lines[:PREVIEW_LINES]),
            "preview_truncated": len(lines) > PREVIEW_LINES or size > len(data)}


def safe_upload_name(name: str) -> str:
    from urllib.parse import unquote
    base = os.path.basename(unquote(name or "").replace("\\", "/"))
    safe = "".join(c if (c.isalnum() or c in "._-") else "_" for c in base).strip("._")
    return (safe or "attachment")[:80]


# ─── aiohttp handlers ────────────────────────────────────────────────

RootResolver = Callable[[str], Awaitable[Path | None]]


def _err(message: str, status: int, **extra) -> web.Response:
    return web.json_response({"error": message, **extra}, status=status)


def make_handlers(resolve_root: RootResolver, attachments_dir: Callable[[str], Path]):
    """Build the three handlers. resolve_root(session_id) -> working folder or
    None (unknown session); attachments_dir(session_id) -> upload folder."""

    async def _root(request):
        sid = request.match_info["id"]
        root = await resolve_root(sid)
        if root is None:
            raise ContextPathError("session not found", 404)
        if not root.is_dir():
            raise ContextPathError(f"the session folder {root} is missing", 409)
        return sid, root

    async def search_handler(request: web.Request) -> web.Response:
        try:
            _, root = await _root(request)
            try:
                limit = max(1, min(int(request.query.get("limit", "30")), 100))
            except ValueError:
                limit = 30
            result = await asyncio.to_thread(search, root, request.query.get("q", ""), limit)
            return web.json_response(result)
        except ContextPathError as exc:
            return _err(str(exc), exc.status)

    async def inspect_handler(request: web.Request) -> web.Response:
        upload = request.query.get("upload")
        if upload is not None:
            sid = request.match_info["id"]
            try:
                if await resolve_root(sid) is None:
                    raise ContextPathError("session not found", 404)
                return web.json_response(await asyncio.to_thread(inspect_upload, attachments_dir(sid), upload))
            except ContextPathError as exc:
                return _err(str(exc), exc.status)
        try:
            _, root = await _root(request)
            result = await asyncio.to_thread(inspect, root, request.query.get("path", ""))
            return web.json_response(result)
        except ContextPathError as exc:
            return _err(str(exc), exc.status)

    async def upload_handler(request: web.Request) -> web.Response:
        try:
            sid, _ = await _root(request)
        except ContextPathError as exc:
            return _err(str(exc), exc.status)
        try:
            reader = await request.multipart()
        except Exception:
            return _err("expected a multipart upload with a file field", 400)
        field = await reader.next()
        while field is not None and field.name != "file":
            field = await reader.next()
        if field is None:
            return _err("no file in the upload", 400)
        name = field.filename or "attachment.txt"
        buf = bytearray()
        while True:
            chunk = await field.read_chunk()
            if not chunk:
                break
            buf.extend(chunk)
            if len(buf) > MAX_UPLOAD_BYTES:
                return _err(f"{name} is larger than {human_size(MAX_UPLOAD_BYTES)}. Add big files from the project with @ instead.",
                            413, reason="too_large", name=name)
        data = bytes(buf)
        ext = Path(name).suffix.lower()
        if ext in BINARY_EXTS or ext in IMAGE_EXTS or not looks_like_text(data):
            return _err(f"{name} is not a text file. Drop text files (code, Markdown, logs) or images; "
                        "PDFs, archives and other binary files are not supported.", 415, reason="binary", name=name)
        digest = hashlib.sha256(data).hexdigest()
        folder = attachments_dir(sid)
        await asyncio.to_thread(folder.mkdir, parents=True, exist_ok=True)
        target = folder / f"{digest[:8]}-{safe_upload_name(name)}"
        if not target.exists():
            await asyncio.to_thread(target.write_bytes, data)
        return web.json_response({
            "kind": "upload", "name": name, "path": str(target), "size": len(data), "sha256": digest,
        }, status=201)

    return search_handler, inspect_handler, upload_handler


def register(app: web.Application, guard, resolve_root: RootResolver, attachments_dir: Callable[[str], Path]):
    search_handler, inspect_handler, upload_handler = make_handlers(resolve_root, attachments_dir)
    app.router.add_get("/api/sessions/{id}/context/search", guard(search_handler))
    app.router.add_get("/api/sessions/{id}/context/inspect", guard(inspect_handler))
    app.router.add_post("/api/sessions/{id}/context/upload", guard(upload_handler))
