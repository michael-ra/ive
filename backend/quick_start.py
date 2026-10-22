"""Quick start: sessions that begin without choosing a project first.

A quick session lives in one ordinary workspace ("Quick sessions") whose path
is the quick start root (default ~/Projekte, else the home folder). Nothing in
the schema changes: the workspace id and the root are kept in app_settings.

The quick workspace is a harness, not a project, so IVE never writes project
memory files into its folder and no default guidelines are attached. Sessions
in it still go through every safety gate like any other session.

Later the agent's own tool calls tell us which project it is working on
(``observe_tool_use``), and a session can be attached to a real workspace
(``attach_session``) without restarting its terminal.
"""
from __future__ import annotations

import logging
import os
import re
import shlex
import time
import uuid
from pathlib import Path
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

ROOT_KEY = "quick_start_root"
WORKSPACE_KEY = "quick_start_workspace_id"
WORKSPACE_NAME = "Quick sessions"
DEFAULT_SESSION_NAME = "Quick session"
DEFAULT_PROJECT_SESSION_NAME = "New session"

# Last known quick workspace id, so synchronous serializers (session and
# workspace JSON) can mark quick rows without a database round trip. Refreshed
# by every read/write in this module and once at server startup.
_cached_workspace_id: Optional[str] = None


# ── Settings ────────────────────────────────────────────────────────────


async def _get_setting(db, key: str) -> Optional[str]:
    cur = await db.execute("SELECT value FROM app_settings WHERE key = ?", (key,))
    row = await cur.fetchone()
    return row["value"] if row and row["value"] else None


async def _set_setting(db, key: str, value: str) -> None:
    await db.execute(
        """INSERT INTO app_settings (key, value, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                          updated_at = excluded.updated_at""",
        (key, value),
    )


def default_root(home: Optional[str] = None) -> str:
    home = home or os.path.expanduser("~")
    projects = os.path.join(home, "Projekte")
    return projects if os.path.isdir(projects) else home


def validate_root(raw) -> str:
    """Return a normalized absolute directory or raise ValueError."""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("root is required")
    value = os.path.expanduser(raw.strip())
    if not os.path.isabs(value):
        raise ValueError("root must be an absolute path")
    value = os.path.normpath(value)
    if value == os.sep:
        raise ValueError("root must not be the filesystem root")
    if not os.path.isdir(value):
        raise ValueError(f"directory not found: {raw.strip()}")
    return value


async def get_root(db) -> str:
    stored = await _get_setting(db, ROOT_KEY)
    if stored and os.path.isdir(stored):
        return stored
    return default_root()


async def _quick_workspace_row(db) -> Optional[dict]:
    global _cached_workspace_id
    ws_id = await _get_setting(db, WORKSPACE_KEY)
    row = None
    if ws_id:
        cur = await db.execute("SELECT * FROM workspaces WHERE id = ?", (ws_id,))
        found = await cur.fetchone()
        row = dict(found) if found else None
    _cached_workspace_id = row["id"] if row else None
    return row


async def load_cache(db) -> Optional[str]:
    row = await _quick_workspace_row(db)
    return row["id"] if row else None


def cached_workspace_id() -> Optional[str]:
    return _cached_workspace_id


def is_quick_workspace_cached(workspace_id) -> bool:
    return bool(workspace_id) and workspace_id == _cached_workspace_id


async def is_quick_workspace(db, workspace_id) -> bool:
    if not workspace_id:
        return False
    return (await _get_setting(db, WORKSPACE_KEY)) == workspace_id


async def get_state(db) -> dict:
    """Response for GET /api/quick-start. Never creates anything."""
    row = await _quick_workspace_row(db)
    return {
        "root": row["path"] if row else await get_root(db),
        "workspace_id": row["id"] if row else None,
        "workspace_name": row["name"] if row else WORKSPACE_NAME,
    }


# ── Quick workspace ─────────────────────────────────────────────────────


async def _disable_project_memory(workspace_id: str) -> None:
    """The quick root is not a project: never sync memory files into it."""
    try:
        from memory_sync import sync_manager
        await sync_manager.update_settings(
            workspace_id, {"enabled": False, "auto_sync": False},
        )
    except Exception as exc:  # start_pty also skips sync for quick sessions
        logger.warning("Could not disable memory sync for quick workspace: %s", exc)


async def ensure_workspace(db) -> dict:
    """Return the quick workspace row, creating or repairing it lazily.

    * deleted by the user -> recreated
    * root setting changed -> path follows the root
    * another workspace already owns the root folder -> that workspace is
      adopted as the quick workspace (paths are unique in the schema)
    """
    global _cached_workspace_id
    root = await get_root(db)
    row = await _quick_workspace_row(db)
    if row and row["path"] == root:
        return row
    if row:
        return await _move_workspace(db, row, root)

    cur = await db.execute("SELECT * FROM workspaces WHERE path = ?", (root,))
    existing = await cur.fetchone()
    if existing:
        ws_id = existing["id"]
    else:
        import workspace_fields
        ws_id = str(uuid.uuid4())
        initial = {
            "id": ws_id, "name": WORKSPACE_NAME, "path": root,
            "comms_enabled": 1, "coordination_enabled": 1,
            "context_sharing_enabled": 1,
            **workspace_fields.create_values(),
            "default_worktree": 0,
        }
        await db.execute(
            f"INSERT INTO workspaces ({', '.join(initial)}) "
            f"VALUES ({', '.join('?' for _ in initial)})",
            tuple(initial.values()),
        )
    await _set_setting(db, WORKSPACE_KEY, ws_id)
    await db.commit()
    _cached_workspace_id = ws_id
    if not existing:
        await _disable_project_memory(ws_id)
    cur = await db.execute("SELECT * FROM workspaces WHERE id = ?", (ws_id,))
    return dict(await cur.fetchone())


async def _move_workspace(db, row: dict, root: str) -> dict:
    global _cached_workspace_id
    cur = await db.execute(
        "SELECT * FROM workspaces WHERE path = ? AND id != ?", (root, row["id"]),
    )
    owner = await cur.fetchone()
    if owner:
        # The folder is already a workspace; it becomes the quick workspace.
        # The old quick workspace stays an ordinary workspace with its sessions.
        await _set_setting(db, WORKSPACE_KEY, owner["id"])
        await db.commit()
        _cached_workspace_id = owner["id"]
        return dict(owner)
    await db.execute("UPDATE workspaces SET path = ? WHERE id = ?", (root, row["id"]))
    await db.commit()
    cur = await db.execute("SELECT * FROM workspaces WHERE id = ?", (row["id"],))
    return dict(await cur.fetchone())


async def set_root(db, raw) -> dict:
    """PUT /api/quick-start. Raises ValueError for an invalid folder."""
    root = validate_root(raw)
    await _set_setting(db, ROOT_KEY, root)
    await db.commit()
    row = await _quick_workspace_row(db)
    if row and row["path"] != root:
        await _move_workspace(db, row, root)
    return await get_state(db)


# ── Attach ──────────────────────────────────────────────────────────────


def _is_within(child: str, parent: str) -> bool:
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:
        return False


def normalize_dir(raw) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("path is required")
    value = os.path.expanduser(raw.strip())
    if not os.path.isabs(value):
        raise ValueError("path must be absolute")
    value = os.path.normpath(value)
    if not os.path.isdir(value):
        raise ValueError(f"directory not found: {raw.strip()}")
    return value


async def find_workspace_for_path(db, path: str, exclude_ids=()) -> Optional[dict]:
    """Exact match, else the deepest workspace containing ``path``, else the
    single workspace inside ``path``. The quick workspace never matches."""
    cur = await db.execute("SELECT * FROM workspaces")
    rows = [dict(r) for r in await cur.fetchall() if r["id"] not in exclude_ids]
    for row in rows:
        if os.path.normpath(row["path"]) == path:
            return row
    parents = [r for r in rows if _is_within(path, os.path.normpath(r["path"]))]
    if parents:
        return max(parents, key=lambda r: len(os.path.normpath(r["path"])))
    children = [r for r in rows if _is_within(os.path.normpath(r["path"]), path)]
    if len(children) == 1:
        return children[0]
    return None


async def find_or_create_workspace(db, path: str) -> tuple[dict, bool]:
    """Return (workspace row, created). ``path`` must be a normalized dir."""
    quick_id = await _get_setting(db, WORKSPACE_KEY)
    found = await find_workspace_for_path(db, path, exclude_ids={quick_id} if quick_id else ())
    if found:
        return found, False
    import workspace_fields
    ws_id = str(uuid.uuid4())
    initial = {
        "id": ws_id, "name": os.path.basename(path) or path, "path": path,
        "comms_enabled": 1, "coordination_enabled": 1, "context_sharing_enabled": 1,
        **workspace_fields.create_values(),
    }
    await db.execute(
        f"INSERT INTO workspaces ({', '.join(initial)}) "
        f"VALUES ({', '.join('?' for _ in initial)})",
        tuple(initial.values()),
    )
    await db.commit()
    cur = await db.execute("SELECT * FROM workspaces WHERE id = ?", (ws_id,))
    return dict(await cur.fetchone()), True


class AttachError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# Short-lived, session-bound receipts: Undo restores only the last move and
# cannot turn the ordinary project picker into a move-to-Quick action.
_attach_undos: dict[str, tuple[str, str, str, float]] = {}


async def attach_session(db, session_id: str, *, workspace_id=None, path=None, undo_token=None) -> dict:
    """Move a session into a project workspace.

    Returns {"session": row, "workspace": row, "workspace_created": bool}.
    The PTY is untouched: its cwd stays where it is.
    """
    cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
    session = await cur.fetchone()
    if not session:
        raise AttachError("session not found", 404)
    for token, receipt in list(_attach_undos.items()):
        if receipt[3] < time.monotonic():
            _attach_undos.pop(token, None)
    restoring = undo_token is not None
    if restoring:
        receipt = _attach_undos.get(undo_token) if isinstance(undo_token, str) else None
        if not receipt or receipt[0] != session_id or receipt[2] != session["workspace_id"]:
            raise AttachError("This move can no longer be undone. The session may have moved again.", 409)
        workspace_id, path = receipt[1], None
    quick_id = await _get_setting(db, WORKSPACE_KEY)
    created = False
    if workspace_id:
        cur = await db.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,))
        ws = await cur.fetchone()
        if not ws:
            raise AttachError("workspace not found", 404)
        workspace = dict(ws)
    elif path:
        try:
            normalized = normalize_dir(path)
        except ValueError as exc:
            raise AttachError(str(exc)) from exc
        workspace, created = await find_or_create_workspace(db, normalized)
    else:
        raise AttachError("workspace_id or path required")
    if workspace["id"] == quick_id and not restoring:
        raise AttachError("choose a project workspace, not the quick workspace")
    changed = await db.execute(
        "UPDATE sessions SET workspace_id = ? WHERE id = ? AND workspace_id = ?",
        (workspace["id"], session_id, session["workspace_id"]),
    )
    if changed.rowcount != 1:
        await db.rollback()
        raise AttachError("The session moved elsewhere. Refresh and try again.", 409)
    await db.execute(
        "UPDATE workspaces SET last_used_at = datetime('now') WHERE id = ?",
        (workspace["id"],),
    )
    await db.commit()
    hints.forget(session_id)
    for token, receipt in list(_attach_undos.items()):
        if receipt[0] == session_id:
            _attach_undos.pop(token, None)
    new_token = None
    if not restoring and session["workspace_id"] != workspace["id"]:
        new_token = uuid.uuid4().hex
        _attach_undos[new_token] = (session_id, session["workspace_id"], workspace["id"], time.monotonic() + 600)
        while len(_attach_undos) > 200:
            _attach_undos.pop(next(iter(_attach_undos)))
    cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
    return {
        "undo_token": new_token,
        "session": dict(await cur.fetchone()),
        "workspace": workspace,
        "workspace_created": created,
    }


# ── Project hint ────────────────────────────────────────────────────────

_PATH_KEYS = (
    "file_path", "path", "notebook_path", "absolute_path", "dir_path",
    "directory", "target_path",
)
_CD_RE = re.compile(r"(?:^|&&|\|\||;|\n|\()\s*(?:builtin\s+)?(?:cd|pushd)\s+([^;&|\n)]+)")
HINT_THRESHOLD = 2


def _cd_targets(command: str) -> list[str]:
    targets = []
    for match in _CD_RE.finditer(command or ""):
        raw = match.group(1).strip()
        try:
            parts = shlex.split(raw)
        except ValueError:
            parts = raw.split()
        if parts and parts[0] not in ("-", "--"):
            targets.append(parts[0])
    return targets


def candidate_paths(tool_input) -> list[str]:
    """Paths an agent tool call touches, from known tool_input keys."""
    if not isinstance(tool_input, dict):
        return []
    found = []
    for key in _PATH_KEYS:
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            found.append(value.strip())
    command = tool_input.get("command")
    if isinstance(command, str):
        found.extend(_cd_targets(command))
    return found


def resolve_project(raw: str, root: str, home: Optional[str] = None) -> Optional[str]:
    """Map a touched path to a project folder, or None.

    The git repository root wins; otherwise the first-level folder under the
    quick root. Only folders inside the home directory count, and never the
    quick root or home itself or hidden folders like ~/.claude.
    """
    home = os.path.normpath(home or os.path.expanduser("~"))
    root = os.path.normpath(root)
    value = os.path.expanduser(raw)
    if not os.path.isabs(value):
        value = os.path.join(root, value)
    value = os.path.normpath(value)
    if value in (home, root) or not (_is_within(value, home) or _is_within(value, root)):
        return None
    if _is_within(value, home):
        rel_home = os.path.relpath(value, home).split(os.sep)
        if rel_home and rel_home[0].startswith("."):
            return None

    probe = value
    while not os.path.isdir(probe) and probe not in (home, root, os.sep):
        probe = os.path.dirname(probe)
    while probe not in (home, root, os.sep):
        if os.path.exists(os.path.join(probe, ".git")):
            return probe
        parent = os.path.dirname(probe)
        if parent == probe:
            break
        probe = parent

    if root != home and _is_within(value, root) and value != root:
        first = os.path.relpath(value, root).split(os.sep)[0]
        if first and not first.startswith("."):
            candidate = os.path.join(root, first)
            if os.path.isdir(candidate):
                return candidate
    return None


class ProjectHints:
    """Per-session counters; one hint per (session, project path)."""

    def __init__(self, threshold: int = HINT_THRESHOLD):
        self.threshold = threshold
        self._counts: dict[str, dict[str, int]] = {}
        self._announced: dict[str, set[str]] = {}
        self._latest: dict[str, dict] = {}

    def observe(self, session_id: str, root: str, tool_input, home: Optional[str] = None) -> Optional[dict]:
        """Count one tool call. Returns {path, name} when a new hint is due."""
        projects = []
        for raw in candidate_paths(tool_input):
            project = resolve_project(raw, root, home)
            if project and project not in projects:
                projects.append(project)
        if not projects:
            return None
        counts = self._counts.setdefault(session_id, {})
        for project in projects:
            counts[project] = counts.get(project, 0) + 1
        best = max(counts, key=counts.get)
        best_count = counts[best]
        runner_up = max((c for p, c in counts.items() if p != best), default=0)
        if best_count < self.threshold or best_count <= runner_up:
            return None
        announced = self._announced.setdefault(session_id, set())
        if best in announced:
            return None
        announced.add(best)
        hint = {"path": best, "name": os.path.basename(best) or best}
        self._latest[session_id] = hint
        return dict(hint)

    def latest(self, session_id: str) -> Optional[dict]:
        hint = self._latest.get(session_id)
        return dict(hint) if hint else None

    def forget(self, session_id: str) -> None:
        self._counts.pop(session_id, None)
        self._announced.pop(session_id, None)
        self._latest.pop(session_id, None)


hints = ProjectHints()


async def _workspace_id_for_project(db, path: str) -> Optional[str]:
    quick_id = await _get_setting(db, WORKSPACE_KEY)
    found = await find_workspace_for_path(db, path, exclude_ids={quick_id} if quick_id else ())
    return found["id"] if found else None


async def observe_tool_use(
    session_id: str,
    tool_input,
    broadcast_fn: Optional[Callable[[dict], Awaitable[None]]] = None,
    *,
    home: Optional[str] = None,
) -> Optional[dict]:
    """Hook entry point (PostToolUse). Only quick sessions are observed.

    Broadcasts {type: "session_project_hint", session_id, path, name,
    workspace_id} once per (session, path) and returns that message.
    """
    if not session_id or not candidate_paths(tool_input):
        return None
    from db import get_db
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT s.workspace_id, w.path FROM sessions s
               JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?""",
            (session_id,),
        )
        row = await cur.fetchone()
        if not row or not await is_quick_workspace(db, row["workspace_id"]):
            return None
        hint = hints.observe(session_id, row["path"], tool_input, home)
        if not hint:
            return None
        message = {
            "type": "session_project_hint",
            "session_id": session_id,
            **hint,
            "workspace_id": await _workspace_id_for_project(db, hint["path"]),
        }
    finally:
        await db.close()
    if broadcast_fn:
        try:
            await broadcast_fn(message)
        except Exception as exc:
            logger.debug("project hint broadcast failed: %s", exc)
    return message


async def current_hint(db, session_id: str) -> dict:
    """GET /api/sessions/{id}/project-hint -> {path, name, workspace_id} | {}."""
    hint = hints.latest(session_id)
    if not hint:
        return {}
    cur = await db.execute("SELECT workspace_id FROM sessions WHERE id = ?", (session_id,))
    row = await cur.fetchone()
    if not row or not await is_quick_workspace(db, row["workspace_id"]):
        return {}
    hint["workspace_id"] = await _workspace_id_for_project(db, hint["path"])
    return hint
