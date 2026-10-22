"""Port lease and preview registration helpers."""
from __future__ import annotations

import asyncio
import errno
import json
import socket
import uuid
from typing import Any
from urllib.parse import urlparse

DEFAULT_START_PORT = 5173
DEFAULT_END_PORT = 5299
DEFAULT_TTL_SECONDS = 4 * 60 * 60

_LEASE_LOCK = asyncio.Lock()


def _json_dict(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def lease_to_dict(row) -> dict:
    data = dict(row)
    data["metadata"] = _json_dict(data.get("metadata"))
    return data


def _normalize_port(port: Any) -> int | None:
    try:
        p = int(port)
    except (TypeError, ValueError):
        return None
    if p < 1 or p > 65535:
        return None
    return p


def _candidate_ports(preferred_port: Any, start_port: Any, end_port: Any) -> list[int]:
    start = _normalize_port(start_port) or DEFAULT_START_PORT
    end = _normalize_port(end_port) or DEFAULT_END_PORT
    if end < start:
        start, end = end, start
    candidates: list[int] = []
    preferred = _normalize_port(preferred_port)
    if preferred is not None:
        candidates.append(preferred)
    candidates.extend(range(start, end + 1))
    seen: set[int] = set()
    result: list[int] = []
    for port in candidates:
        if port not in seen:
            seen.add(port)
            result.append(port)
    return result


def probe_port(port: int) -> dict:
    """Return whether a loopback port is already occupied."""
    port = int(port)
    for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as sock:
                sock.settimeout(0.15)
                if sock.connect_ex((host, port)) == 0:
                    return {
                        "port": port,
                        "host": host,
                        "occupied": True,
                        "reason": "accepting_connections",
                    }
        except OSError:
            continue

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("127.0.0.1", port))
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            return {
                "port": port,
                "host": "127.0.0.1",
                "occupied": True,
                "reason": "bind_failed",
                "detail": str(exc),
            }
        return {
            "port": port,
            "host": "127.0.0.1",
            "occupied": False,
            "reason": "bind_probe_unavailable",
            "detail": str(exc),
        }

    return {
        "port": port,
        "host": "127.0.0.1",
        "occupied": False,
        "reason": "available",
    }


async def cleanup_expired(db) -> None:
    await db.execute(
        """UPDATE port_leases
           SET status = 'expired', updated_at = datetime('now')
           WHERE status = 'active'
             AND expires_at IS NOT NULL
             AND expires_at < datetime('now')"""
    )


async def _active_lease_for_port(db, port: int):
    cur = await db.execute(
        """SELECT * FROM port_leases
           WHERE port = ? AND status = 'active'
           ORDER BY updated_at DESC LIMIT 1""",
        (port,),
    )
    return await cur.fetchone()


async def get_lease(db, lease_id: str) -> dict | None:
    await cleanup_expired(db)
    cur = await db.execute("SELECT * FROM port_leases WHERE id = ?", (lease_id,))
    row = await cur.fetchone()
    return lease_to_dict(row) if row else None


async def list_leases(db, workspace_id: str | None = None, active_only: bool = True) -> list[dict]:
    await cleanup_expired(db)
    sql = "SELECT * FROM port_leases"
    params: list[Any] = []
    clauses: list[str] = []
    if workspace_id:
        clauses.append("workspace_id = ?")
        params.append(workspace_id)
    if active_only:
        clauses.append("status = 'active'")
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY updated_at DESC, created_at DESC"
    cur = await db.execute(sql, params)
    return [lease_to_dict(row) for row in await cur.fetchall()]


async def lease_port(
    db,
    *,
    workspace_id: str,
    session_id: str | None = None,
    task_id: str | None = None,
    preferred_port: Any = None,
    start_port: Any = None,
    end_port: Any = None,
    label: str | None = None,
    ttl_seconds: Any = None,
    metadata: dict | None = None,
    strict: bool = False,
) -> dict:
    ttl = _normalize_port(ttl_seconds) or DEFAULT_TTL_SECONDS
    candidates = _candidate_ports(preferred_port, start_port, end_port)
    blocked_ports: list[dict] = []

    async with _LEASE_LOCK:
        await cleanup_expired(db)
        for port in candidates:
            lease_row = await _active_lease_for_port(db, port)
            if lease_row:
                lease = lease_to_dict(lease_row)
                if (
                    lease.get("workspace_id") == workspace_id
                    and session_id
                    and lease.get("session_id") == session_id
                ):
                    lease["reused"] = True
                    return {"ok": True, "lease": lease, "blocked_ports": blocked_ports}
                blocked_ports.append({
                    "port": port,
                    "reason": "leased",
                    "lease": lease,
                })
                if strict:
                    break
                continue

            probe = probe_port(port)
            if probe.get("occupied"):
                blocked_ports.append(probe)
                if strict:
                    break
                continue

            lease_id = str(uuid.uuid4())
            await db.execute(
                """INSERT INTO port_leases
                   (id, workspace_id, session_id, task_id, port, host, label, status,
                    metadata, expires_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, '127.0.0.1', ?, 'active', ?,
                           datetime('now', ?), datetime('now'))""",
                (
                    lease_id,
                    workspace_id,
                    session_id,
                    task_id,
                    port,
                    label,
                    json.dumps(metadata or {}),
                    f"+{ttl} seconds",
                ),
            )
            cur = await db.execute("SELECT * FROM port_leases WHERE id = ?", (lease_id,))
            row = await cur.fetchone()
            return {
                "ok": True,
                "lease": lease_to_dict(row),
                "blocked_ports": blocked_ports,
            }

    return {
        "ok": False,
        "error": "no_free_port",
        "blocked_ports": blocked_ports,
        "checked_ports": candidates,
    }


async def heartbeat_lease(db, lease_id: str, ttl_seconds: Any = None) -> dict | None:
    ttl = _normalize_port(ttl_seconds) or DEFAULT_TTL_SECONDS
    await cleanup_expired(db)
    await db.execute(
        """UPDATE port_leases
           SET expires_at = datetime('now', ?), updated_at = datetime('now')
           WHERE id = ? AND status = 'active'""",
        (f"+{ttl} seconds", lease_id),
    )
    return await get_lease(db, lease_id)


async def release_lease(db, lease_id: str) -> dict | None:
    await cleanup_expired(db)
    await db.execute(
        """UPDATE port_leases
           SET status = 'released', released_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ? AND status = 'active'""",
        (lease_id,),
    )
    return await get_lease(db, lease_id)


def _preview_url_for_port(port: int) -> str:
    return f"http://127.0.0.1:{int(port)}/"


def _port_from_url(url: str) -> int | None:
    try:
        parsed = urlparse(url)
        return parsed.port
    except Exception:
        return None


async def register_preview(
    db,
    *,
    workspace_id: str,
    lease_id: str | None = None,
    port: Any = None,
    url: str | None = None,
    session_id: str | None = None,
    task_id: str | None = None,
) -> dict:
    await cleanup_expired(db)
    lease: dict | None = None
    normalized_port = _normalize_port(port)

    if lease_id:
        lease = await get_lease(db, lease_id)
        if not lease or lease.get("status") != "active":
            return {"ok": False, "error": "active lease not found", "status": 404}
        if lease.get("workspace_id") != workspace_id:
            return {"ok": False, "error": "lease belongs to a different workspace", "status": 409}
        normalized_port = normalized_port or lease.get("port")
    elif normalized_port is not None:
        active = await _active_lease_for_port(db, normalized_port)
        if active:
            lease = lease_to_dict(active)
        if not lease or lease.get("workspace_id") != workspace_id:
            return {
                "ok": False,
                "error": "active port lease required before registering preview",
                "status": 409,
            }
    else:
        return {"ok": False, "error": "lease_id or port required", "status": 400}

    if not url:
        url = _preview_url_for_port(int(normalized_port))
    elif not url.startswith(("http://", "https://")):
        url = "http://" + url

    parsed_url = urlparse(url)
    if parsed_url.hostname not in {"localhost", "127.0.0.1", "::1"}:
        return {
            "ok": False,
            "error": "preview URL must point at localhost/127.0.0.1",
            "status": 400,
        }

    url_port = _port_from_url(url)
    if url_port and normalized_port and int(url_port) != int(normalized_port):
        return {
            "ok": False,
            "error": "preview URL port does not match lease",
            "status": 409,
            "lease_port": normalized_port,
            "url_port": url_port,
        }

    probe = probe_port(int(normalized_port))
    if not probe.get("occupied"):
        return {
            "ok": False,
            "error": "leased port is not accepting connections yet",
            "status": 409,
            "port": int(normalized_port),
            "probe": probe,
        }

    await db.execute(
        """UPDATE port_leases
           SET preview_url = ?, session_id = COALESCE(?, session_id),
               task_id = COALESCE(?, task_id), updated_at = datetime('now')
           WHERE id = ?""",
        (url, session_id, task_id, lease["id"]),
    )
    await db.execute(
        "UPDATE workspaces SET preview_url = ? WHERE id = ?",
        (url, workspace_id),
    )
    cur = await db.execute("SELECT * FROM port_leases WHERE id = ?", (lease["id"],))
    row = await cur.fetchone()
    return {
        "ok": True,
        "workspace_id": workspace_id,
        "preview_url": url,
        "lease": lease_to_dict(row),
    }
