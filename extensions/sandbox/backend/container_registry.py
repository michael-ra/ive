"""WS-5: control-plane registry + reconciler for IVE's Apple-container workloads.

Two container FAMILIES live under the `container` CLI, and they are kept strictly apart:

  ``ive-sess-<session_id>``            one-shot session sandboxes (see sandbox_engine). Run with
                                      ``--rm``: they vanish on exit, so the registry is the only
                                      control plane they have.
  ``ive-sidecar-<workspace_id>-<name>``  long-lived per-workspace sidecars hosting connectors
                                      (see sidecars.py). NEVER ``--rm`` — they must survive stop
                                      so logs and filesystem state stay auditable.

The prefixes are disjoint, which is what makes the two reapers safe: the session reaper only ever
sees ``ive-sess-*`` and the sidecar reaper only ever sees ``ive-sidecar-*``. Every classification
goes through _is_session_container / _is_sidecar_container so that invariant has one home.

Session side (unchanged):
  - list_ive_containers(): which session containers are running, mapped to their session
  - reap_orphans(): stop+remove session containers whose session is no longer live
Sidecar side (added):
  - sqlite-backed rows (workspace_id, name, image, image_digest, ip, http_port, state, started_at)
  - an invocation ledger, because `container exec` output never reaches `container logs`
  - reap_orphan_sidecars(): sidecars whose workspace is gone, deleted through a forensics-capturing
    callback so removal cannot erase the trail
  - reconcile(): one pass — fetch live sessions (and, when supplied, live workspaces) and reap

All shell-outs go through the `container` CLI; everything degrades to a no-op if it's absent.
"""
from __future__ import annotations
import asyncio
import json
import logging
import os
import pathlib

logger = logging.getLogger(__name__)

_SESSION_PREFIX = "ive-sess-"
_PREFIX = _SESSION_PREFIX  # pre-sidecar name, still referenced by callers/tests
SIDECAR_PREFIX = "ive-sidecar-"

# Per-row cap on retained exec output. The ledger is an audit record, not a log store.
LEDGER_OUTPUT_CAP = int(os.environ.get("IVE_SIDECAR_LEDGER_OUTPUT_CAP") or 4000)
# Ledger rows kept per sidecar; older rows are pruned after each write.
LEDGER_MAX_ROWS = int(os.environ.get("IVE_SIDECAR_LEDGER_MAX_ROWS") or 500)


async def _run(*args: str) -> tuple[int, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        out, _ = await proc.communicate()
        return proc.returncode or 0, out.decode(errors="ignore")
    except FileNotFoundError:
        return 127, ""
    except Exception as exc:  # pragma: no cover
        logger.debug("container_registry _run failed: %s", exc)
        return 1, ""


# ── name family classification ───────────────────────────────────────────────
# The one place that decides which reaper owns a container. `ive-sidecar-` does not start with
# `ive-sess-`, so the families cannot overlap; the explicit exclusion keeps that true even if a
# prefix is ever edited.

def _is_sidecar_container(name: str) -> bool:
    return bool(name) and name.startswith(SIDECAR_PREFIX)


def _is_session_container(name: str) -> bool:
    return bool(name) and name.startswith(_SESSION_PREFIX) and not _is_sidecar_container(name)


def sidecar_container_name(workspace_id: str, name: str) -> str:
    return f"{SIDECAR_PREFIX}{workspace_id}-{name}"


def split_sidecar_name(container_name: str, known_workspace_ids) -> tuple[str | None, str]:
    """(workspace_id, sidecar name) for a container name, or (None, remainder).

    Workspace ids contain '-', so the composed name is not parseable on its own; the split is
    resolved against ids the caller knows. Callers should consult the registry row first — it
    still names the workspace after that workspace has been deleted.
    """
    if not _is_sidecar_container(container_name):
        return None, container_name
    rest = container_name[len(SIDECAR_PREFIX):]
    for ws in (known_workspace_ids or []):
        if ws and rest.startswith(f"{ws}-"):
            return ws, rest[len(ws) + 1:]
    return None, rest


def _names_from_text(text: str) -> list[str]:
    found = []
    for line in text.splitlines():
        for tok in line.split():
            if tok.startswith(_SESSION_PREFIX):
                found.append(tok)
    return found


async def _ls_rows(include_stopped: bool = False) -> list[dict]:
    """`container ls [-a] --format json` rows, or [] when JSON isn't available."""
    args = ["container", "ls"] + (["-a"] if include_stopped else []) + ["--format", "json"]
    rc, out = await _run(*args)
    if rc != 0 or out.strip()[:1] not in ("[", "{"):
        return []
    try:
        data = json.loads(out)
    except Exception:
        return []
    rows = data if isinstance(data, list) else data.get("containers", [])
    return [r for r in rows if isinstance(r, dict)]


def _row_name(row: dict) -> str:
    # container CLI 1.1.0 keys the name as `id`; older/other shapes use `name`/`Name`.
    return str(row.get("name") or row.get("Name") or row.get("id") or row.get("ID") or "")


def _row_state(row: dict) -> str:
    status = row.get("status")
    if isinstance(status, dict):
        return str(status.get("state") or "").lower()
    return str(row.get("state") or row.get("State") or status or "").lower()


async def list_ive_containers() -> list[dict]:
    """Running IVE session containers as [{name, session_id}]. Empty if `container` is absent."""
    names = [_row_name(r) for r in await _ls_rows()]
    if not any(names):  # JSON unsupported/empty -> parse plain `container ls`
        _, out = await _run("container", "ls")
        names = _names_from_text(out)
    seen, items = set(), []
    for n in names:
        if _is_session_container(n) and n not in seen:
            seen.add(n)
            items.append({"name": n, "session_id": n[len(_SESSION_PREFIX):]})
    return items


async def reap_orphans(live_session_ids, dry_run: bool = False) -> dict:
    """Stop+remove SESSION containers whose session_id is NOT in live_session_ids.

    Only touches `ive-sess-*`; a sidecar can never reach this path (see _is_session_container).
    """
    live = set(live_session_ids or [])
    containers = await list_ive_containers()
    orphans = [c for c in containers if c["session_id"] not in live]
    reaped = []
    for c in orphans:
        if not dry_run:
            await _run("container", "stop", c["name"])
            await _run("container", "rm", c["name"])
        reaped.append(c["name"])
    if reaped and not dry_run:
        logger.info("container_registry reaped %d orphan container(s): %s", len(reaped), reaped)
    return {
        "running": len(containers),
        "orphans": [c["name"] for c in orphans],
        "reaped": reaped,
        "dry_run": dry_run,
    }


# ── sidecar persistence ──────────────────────────────────────────────────────
# Its own sqlite handle on the same file db.py uses (DB_PATH), so the module stays importable
# without the server and tests can point it at a tempfile.

SIDECAR_SCHEMA = """
CREATE TABLE IF NOT EXISTS container_sidecars (
    container_name TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    image TEXT,
    image_digest TEXT,
    ip TEXT,
    http_port INTEGER,
    state TEXT NOT NULL DEFAULT 'unknown',
    started_at TEXT,
    connectors TEXT DEFAULT '[]',
    spec TEXT DEFAULT '{}',
    provenance TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_container_sidecars_ws
    ON container_sidecars(workspace_id, state);

CREATE TABLE IF NOT EXISTS container_sidecar_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT,
    sidecar TEXT,
    container_name TEXT,
    kind TEXT NOT NULL,
    command TEXT,
    exit_code INTEGER,
    duration_ms INTEGER,
    stdout TEXT,
    stderr TEXT,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_container_sidecar_ledger_target
    ON container_sidecar_ledger(workspace_id, sidecar, id);
"""

_DB_PATH_OVERRIDE: str | None = None
_SCHEMA_DONE: set[str] = set()


def set_registry_db_path(path) -> None:
    """Point sidecar persistence at another sqlite file. Tests use a tempfile; never the live DB."""
    global _DB_PATH_OVERRIDE
    _DB_PATH_OVERRIDE = str(path) if path else None
    _SCHEMA_DONE.discard(str(path or ""))


def registry_db_path() -> str:
    if _DB_PATH_OVERRIDE:
        return _DB_PATH_OVERRIDE
    env = (os.environ.get("IVE_CONTAINER_REGISTRY_DB") or "").strip()
    if env:
        return env
    try:
        from config import DB_PATH
        return str(DB_PATH)
    except Exception:
        return str(pathlib.Path.home() / ".ive" / "data.db")


async def _registry_db():
    import aiosqlite
    path = registry_db_path()
    parent = os.path.dirname(path)
    if parent:
        try:
            os.makedirs(parent, exist_ok=True)
        except Exception:
            pass
    db = await aiosqlite.connect(path)
    db.row_factory = aiosqlite.Row
    if path not in _SCHEMA_DONE:
        await db.executescript(SIDECAR_SCHEMA)
        await db.commit()
        _SCHEMA_DONE.add(path)
    return db


def _json_loads(raw, fallback):
    if isinstance(raw, (dict, list)):
        return raw
    try:
        parsed = json.loads(raw or "")
    except Exception:
        return fallback
    return parsed if isinstance(parsed, type(fallback)) else fallback


def sidecar_row_to_dict(row) -> dict:
    data = dict(row)
    data["connectors"] = _json_loads(data.get("connectors"), [])
    data["spec"] = _json_loads(data.get("spec"), {})
    data["provenance"] = _json_loads(data.get("provenance"), {})
    return data


async def upsert_sidecar(workspace_id: str, name: str, **fields) -> dict:
    """Create/update one sidecar row. Unset fields keep their stored value."""
    container_name = fields.pop("container_name", None) or sidecar_container_name(workspace_id, name)
    for key in ("connectors", "spec", "provenance"):
        if key in fields and not isinstance(fields[key], str):
            fields[key] = json.dumps(fields[key])
    allowed = ("image", "image_digest", "ip", "http_port", "state", "started_at",
               "connectors", "spec", "provenance")
    sets = {k: v for k, v in fields.items() if k in allowed}
    db = await _registry_db()
    try:
        await db.execute(
            "INSERT OR IGNORE INTO container_sidecars (container_name, workspace_id, name) "
            "VALUES (?, ?, ?)", (container_name, workspace_id, name))
        if sets:
            assigns = ", ".join(f"{k} = ?" for k in sets)
            await db.execute(
                f"UPDATE container_sidecars SET {assigns}, updated_at = datetime('now') "
                "WHERE container_name = ?", (*sets.values(), container_name))
        else:
            await db.execute(
                "UPDATE container_sidecars SET updated_at = datetime('now') "
                "WHERE container_name = ?", (container_name,))
        await db.commit()
        cur = await db.execute(
            "SELECT * FROM container_sidecars WHERE container_name = ?", (container_name,))
        row = await cur.fetchone()
        return sidecar_row_to_dict(row) if row else {}
    finally:
        await db.close()


async def get_sidecar(workspace_id: str, name: str) -> dict | None:
    db = await _registry_db()
    try:
        cur = await db.execute(
            "SELECT * FROM container_sidecars WHERE workspace_id = ? AND name = ?",
            (workspace_id, name))
        row = await cur.fetchone()
        return sidecar_row_to_dict(row) if row else None
    finally:
        await db.close()


async def get_sidecar_by_container(container_name: str) -> dict | None:
    db = await _registry_db()
    try:
        cur = await db.execute(
            "SELECT * FROM container_sidecars WHERE container_name = ?", (container_name,))
        row = await cur.fetchone()
        return sidecar_row_to_dict(row) if row else None
    finally:
        await db.close()


async def list_sidecar_rows(workspace_id: str | None = None,
                            include_deleted: bool = False) -> list[dict]:
    where, params = [], []
    if workspace_id:
        where.append("workspace_id = ?")
        params.append(workspace_id)
    if not include_deleted:
        where.append("state != 'deleted'")
    sql = "SELECT * FROM container_sidecars"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY workspace_id, name"
    db = await _registry_db()
    try:
        cur = await db.execute(sql, params)
        return [sidecar_row_to_dict(r) for r in await cur.fetchall()]
    finally:
        await db.close()


async def set_sidecar_state(workspace_id: str, name: str, state: str, **fields) -> dict:
    return await upsert_sidecar(workspace_id, name, state=state, **fields)


async def tombstone_sidecar(workspace_id: str, name: str) -> dict:
    """Mark a sidecar removed but KEEP the row: `container rm` destroys the container's logs, so
    the row plus its forensics ledger entry are all that survive."""
    return await upsert_sidecar(workspace_id, name, state="deleted", ip=None)


def _truncate(text: str | None) -> str:
    text = text or ""
    if len(text) <= LEDGER_OUTPUT_CAP:
        return text
    return text[:LEDGER_OUTPUT_CAP] + f"\n…[truncated {len(text) - LEDGER_OUTPUT_CAP} chars]"


async def record_invocation(workspace_id: str, sidecar: str, kind: str, command: str,
                            exit_code: int | None = None, duration_ms: int | None = None,
                            stdout: str | None = None, stderr: str | None = None,
                            detail=None, container_name: str | None = None) -> int:
    """Append one ledger row.

    THE LEDGER IS THE ONLY RECORD OF CONNECTOR CALLS: `container exec` output never reaches
    `container logs` (only the init process's stdio does), so an invocation that is not written
    here leaves no evidence anywhere on the machine.
    """
    if detail is not None and not isinstance(detail, str):
        detail = json.dumps(detail)
    db = await _registry_db()
    try:
        cur = await db.execute(
            "INSERT INTO container_sidecar_ledger (workspace_id, sidecar, container_name, kind, "
            "command, exit_code, duration_ms, stdout, stderr, detail) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (workspace_id, sidecar,
             container_name or sidecar_container_name(workspace_id, sidecar),
             kind, command, exit_code, duration_ms,
             _truncate(stdout), _truncate(stderr), detail))
        row_id = cur.lastrowid
        await db.execute(
            "DELETE FROM container_sidecar_ledger WHERE workspace_id = ? AND sidecar = ? "
            "AND id NOT IN (SELECT id FROM container_sidecar_ledger WHERE workspace_id = ? "
            "AND sidecar = ? ORDER BY id DESC LIMIT ?)",
            (workspace_id, sidecar, workspace_id, sidecar, LEDGER_MAX_ROWS))
        await db.commit()
        return int(row_id or 0)
    finally:
        await db.close()


async def finalize_invocation(
    invocation_id: int,
    workspace_id: str,
    sidecar: str,
    *,
    exit_code: int,
    duration_ms: int,
    detail=None,
) -> None:
    """Finalize one pre-created ledger envelope exactly once.

    Connector proxy calls create their row before target resolution.  A missing,
    already-finalized, or unwritable row is an audit failure, not a best-effort
    telemetry event.
    """
    if detail is not None and not isinstance(detail, str):
        detail = json.dumps(detail, sort_keys=True)
    db = await _registry_db()
    try:
        cur = await db.execute(
            "UPDATE container_sidecar_ledger "
            "SET exit_code = ?, duration_ms = ?, detail = ? "
            "WHERE id = ? AND workspace_id = ? AND sidecar = ? AND exit_code IS NULL",
            (int(exit_code), int(duration_ms), detail, int(invocation_id), workspace_id, sidecar),
        )
        if cur.rowcount != 1:
            await db.rollback()
            raise RuntimeError("connector invocation ledger envelope was not finalizable")
        await db.commit()
    finally:
        await db.close()


async def list_invocations(workspace_id: str | None = None, sidecar: str | None = None,
                           kind: str | None = None, limit: int = 100) -> list[dict]:
    where, params = [], []
    if workspace_id:
        where.append("workspace_id = ?")
        params.append(workspace_id)
    if sidecar:
        where.append("sidecar = ?")
        params.append(sidecar)
    if kind:
        where.append("kind = ?")
        params.append(kind)
    sql = "SELECT * FROM container_sidecar_ledger"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(max(1, int(limit)))
    db = await _registry_db()
    try:
        cur = await db.execute(sql, params)
        return [dict(r) for r in await cur.fetchall()]
    finally:
        await db.close()


# ── sidecar reaping ──────────────────────────────────────────────────────────

async def list_sidecar_containers(include_stopped: bool = True) -> list[dict]:
    """Live `ive-sidecar-*` containers as [{name, state}] — stopped ones included by default,
    because a stopped sidecar still exists (no --rm) and still owns disk + logs."""
    rows = await _ls_rows(include_stopped=include_stopped)
    out = []
    seen = set()
    for r in rows:
        n = _row_name(r)
        if _is_sidecar_container(n) and n not in seen:
            seen.add(n)
            out.append({"name": n, "state": _row_state(r) or "unknown"})
    return out


async def reap_orphan_sidecars(live_workspace_ids, dry_run: bool = False,
                               delete_fn=None) -> dict:
    """Remove sidecars whose workspace is gone. Never touches `ive-sess-*`.

    Deletion is delegated to sidecars.delete_sidecar (or an injected delete_fn) so the forensics
    capture that runs there cannot be bypassed — `container rm` takes the logs with it.
    """
    live = set(live_workspace_ids or [])
    containers = await list_sidecar_containers()
    rows = await list_sidecar_rows(include_deleted=False)
    by_container = {r["container_name"]: r for r in rows}

    candidates: list[tuple[str, str, str]] = []  # (container_name, workspace_id|"", sidecar name)
    for c in containers:
        row = by_container.get(c["name"])
        if row:
            ws, nm = row["workspace_id"], row["name"]
        else:
            ws, nm = split_sidecar_name(c["name"], live)
        candidates.append((c["name"], ws or "", nm))
    # Rows whose container is already gone but whose workspace died too: tombstone them so the
    # registry stops advertising a sidecar nothing can reach.
    running_names = {c["name"] for c in containers}
    stale_rows = [r for r in rows
                  if r["container_name"] not in running_names and r["workspace_id"] not in live]

    orphans = [(cn, ws, nm) for cn, ws, nm in candidates if not ws or ws not in live]
    reaped = []
    for container_name, ws, nm in orphans:
        if not dry_run:
            if ws:
                fn = delete_fn
                if fn is None:
                    import sidecars  # lazy: sidecars imports this module at its top level
                    fn = sidecars.delete_sidecar
                await fn(ws, nm)
            else:
                # No workspace to attribute it to (registry row lost): capture what the CLI still
                # knows before rm destroys it.
                _, logs = await _run("container", "logs", container_name)
                _, inspect_out = await _run("container", "inspect", container_name)
                await record_invocation(
                    "", container_name, "forensics",
                    f"orphan sidecar {container_name}", stdout=logs, detail=inspect_out[:8000],
                    container_name=container_name)
                await _run("container", "stop", container_name)
                await _run("container", "rm", container_name)
        reaped.append(container_name)
    if not dry_run:
        for r in stale_rows:
            await tombstone_sidecar(r["workspace_id"], r["name"])
    if reaped and not dry_run:
        logger.info("container_registry reaped %d orphan sidecar(s): %s", len(reaped), reaped)
    return {
        "sidecars": len(containers),
        "orphans": [c for c, _, _ in orphans],
        "reaped": reaped,
        "tombstoned": [r["container_name"] for r in stale_rows] if not dry_run else [],
        "dry_run": dry_run,
    }


async def reconcile(get_live_session_ids, get_live_workspace_ids=None) -> dict:
    """One reconcile pass: reap orphaned session sandboxes, and — when the caller can name the
    live workspaces — orphaned sidecars too. Without get_live_workspace_ids no sidecar is touched
    (an unknown workspace set must never read as "no workspaces exist")."""
    live = get_live_session_ids()
    if asyncio.iscoroutine(live):
        live = await live
    result = await reap_orphans(live)
    if get_live_workspace_ids is not None:
        ws = get_live_workspace_ids()
        if asyncio.iscoroutine(ws):
            ws = await ws
        try:
            result["sidecar_reap"] = await reap_orphan_sidecars(ws)
        except Exception:
            logger.debug("sidecar reap pass failed", exc_info=True)
    return result
