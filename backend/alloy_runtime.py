"""Workspace-local Alloy MCP bridge helpers.

Alloy keeps generated MCP servers project-owned and calls them through a
stable bridge so running IVE sessions do not need to restart when a generated
server changes.

Spawns go through the same containment seam PTY sessions use
(``sandbox_engine.wrap_command_for_sandbox``), keyed off the OWNING WORKSPACE's
``sandbox_type`` / ``sandbox_network`` columns. A workspace on the default
``sandbox_type='none'`` keeps the exact raw host spawn it had before.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)

SENSITIVE_ENV_RE = re.compile(r"(key|token|secret|password|credential|auth)", re.I)

_FALSE_SET = {"0", "false", "no", "off"}
_TRUE_SET = {"1", "true", "yes", "on"}

# Prefix for the synthetic session id handed to wrap_command_for_sandbox.
SANDBOX_SESSION_PREFIX = "alloy"


def slugify(value: str, fallback: str = "api") -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower()).strip("-")
    return slug or fallback


def parse_json_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def parse_json_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except Exception:
            return []
    return []


def redact_env(env: dict[str, Any]) -> dict[str, Any]:
    redacted = {}
    for key, value in (env or {}).items():
        redacted[key] = "***" if SENSITIVE_ENV_RE.search(str(key)) else value
    return redacted


def redaction_values(env: dict[str, Any]) -> list[str]:
    values = []
    for key, value in (env or {}).items():
        text = str(value)
        if len(text) >= 8 and SENSITIVE_ENV_RE.search(str(key)):
            values.append(text)
    return values


def redact_text(text: str, secrets: list[str]) -> str:
    out = text or ""
    for secret in secrets:
        if secret:
            out = out.replace(secret, "***")
    return out


def resolve_workspace_path(workspace_path: str, value: str | None) -> str | None:
    if not value:
        return None
    root = Path(workspace_path).expanduser().resolve()
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    candidate = candidate.resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"path must stay inside workspace: {value}") from exc
    return str(candidate)


# ── Sandbox wiring ───────────────────────────────────────────────────────────
# ALLOY_SANDBOX=0 pins every spawn back to the raw host process (rollback lever).


def sandbox_enabled() -> bool:
    return os.environ.get("ALLOY_SANDBOX", "").strip().lower() not in _FALSE_SET


def new_sandbox_session_id(prefix: str = SANDBOX_SESSION_PREFIX) -> str:
    """Per-call session id for the sandbox wrapper.

    The container tier names the container ``ive-sess-<session_id>``, the key
    container_registry matches on. Unique per call on purpose: reusing the owning
    session's id would collide with that session's own sandbox container, and two
    concurrent Alloy calls would collide with each other.
    """
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


async def _get_db():
    """Indirection so tests can point the workspace lookup at a tempfile DB."""
    from db import get_db

    return await get_db()


def _row_to_sandbox(row: Any) -> dict[str, Any]:
    network = row["sandbox_network"]
    return {
        "workspace_id": row["id"],
        "workspace_path": row["path"],
        "sandbox_type": (row["sandbox_type"] or "none").strip() or "none",
        "sandbox_network": bool(1 if network is None else network),
    }


def _norm_path(value: str) -> str:
    return os.path.realpath(os.path.expanduser(str(value)))


async def _workspace_row_for_cwd(db: Any, cwd: str) -> Any:
    """Longest workspace path that contains ``cwd``; None when nothing contains it."""
    cur = await db.execute("SELECT id, path, sandbox_type, sandbox_network FROM workspaces")
    rows = await cur.fetchall()
    target = _norm_path(cwd)
    best = None
    best_len = -1
    for row in rows:
        raw = row["path"]
        if not raw:
            continue
        root = _norm_path(raw)
        if target == root or target.startswith(root.rstrip(os.sep) + os.sep):
            if len(root) > best_len:
                best, best_len = row, len(root)
    return best


async def resolve_workspace_sandbox(
    workspace_id: str | None = None,
    cwd: str | None = None,
) -> dict[str, Any] | None:
    """Owning workspace's sandbox settings, or None => raw host spawn.

    An alloy_servers row carries no workspace pointer down to the spawn boundary:
    server.py knows the workspace_id at the HTTP layer, and brain_dispatch resolves
    Alloy servers by id alone. So the workspace comes from an explicit
    ``workspace_id`` when the caller has one, else from the server's registered
    ``cwd`` — registration forces cwd inside the workspace root (see
    resolve_workspace_path), which makes the longest-prefix match exact rather
    than a guess. Reads ``workspaces`` only; never raises.
    """
    if not sandbox_enabled():
        return None
    if not workspace_id and not cwd:
        return None
    db = None
    try:
        db = await _get_db()
        row = None
        if workspace_id:
            cur = await db.execute(
                "SELECT id, path, sandbox_type, sandbox_network FROM workspaces WHERE id = ?",
                (workspace_id,),
            )
            row = await cur.fetchone()
        if row is None and cwd:
            row = await _workspace_row_for_cwd(db, cwd)
        if row is None or not row["path"]:
            return None
        return _row_to_sandbox(row)
    except Exception:
        logger.debug("alloy sandbox lookup failed; falling back to host spawn", exc_info=True)
        return None
    finally:
        if db is not None:
            try:
                await db.close()
            except Exception:
                pass


def apply_sandbox(
    argv: list[str],
    sandbox: dict[str, Any] | None,
    extra_env: dict[str, Any] | None = None,
    session_id: str | None = None,
) -> list[str]:
    """Wrap ``argv`` with the workspace's sandbox tier, or return it untouched.

    Untouched (byte-identical to the pre-sandbox spawn) when there is no workspace
    match, no workspace path to contain, or sandbox_type is absent/'none'.

    LIFETIME (§0.9). The container tier is one-shot: ``container run --rm -i``
    lives exactly as long as the process it wraps. An MCP stdio server is
    long-lived in general, but IVE's only Alloy spawn path is this one-shot bridge
    (spawn -> initialize -> one operation -> terminate), so the two lifetimes
    already coincide. The wrapper does not redirect stdio: ``-i`` attaches the
    CLI's stdin/stdout/stderr to the container's, so JSON-RPC framing rides the
    same pipes create_subprocess_exec opened, and the process the caller signals
    in its finally-block is the ``container`` CLI — SIGTERM there ends the run and
    ``--rm`` reclaims the microVM. The name stays ``ive-sess-<session_id>`` so
    container_registry still maps and reaps it; the id is per-call, so a reap pass
    can only ever touch an Alloy container that outlived its call.
    """
    argv = list(argv)
    if not sandbox:
        return argv
    sandbox_type = (sandbox.get("sandbox_type") or "none").strip().lower()
    if not sandbox_type or sandbox_type == "none":
        return argv
    workspace_path = sandbox.get("workspace_path")
    if not workspace_path:
        return argv
    try:
        from sandbox_engine import wrap_command_for_sandbox
    except Exception as exc:
        # Mirror sandbox_engine's own posture: fail-closed when the operator asked
        # for it, degrade-and-warn otherwise.
        if _sandbox_fail_closed():
            raise RuntimeError(f"sandbox_engine unavailable ({exc}); refusing to run unsandboxed")
        logger.warning("sandbox_engine import failed (%s). Alloy spawning un-sandboxed.", exc)
        return argv
    return wrap_command_for_sandbox(
        argv,
        str(workspace_path),
        sandbox_type,
        bool(sandbox.get("sandbox_network", True)),
        session_id or new_sandbox_session_id(),
        dict(extra_env or {}),
    )


def _sandbox_fail_closed() -> bool:
    for name in ("SANDBOX_FAIL_CLOSED", "EGRESS_PROXY_ENFORCE"):
        if os.environ.get(name, "").strip().lower() in _TRUE_SET:
            return True
    return False


async def _read_stderr(proc: asyncio.subprocess.Process, limit: int = 32768) -> str:
    if not proc.stderr:
        return ""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await proc.stderr.read(4096)
        if not chunk:
            break
        if total < limit:
            keep = chunk[: max(0, limit - total)]
            chunks.append(keep)
            total += len(keep)
    return b"".join(chunks).decode("utf-8", "replace")


async def _read_jsonrpc_message(reader: asyncio.StreamReader, timeout: float) -> dict[str, Any]:
    while True:
        line = await asyncio.wait_for(reader.readline(), timeout=timeout)
        if not line:
            raise RuntimeError("MCP server closed stdout")
        text = line.decode("utf-8", "replace").strip()
        if not text:
            continue
        if text.lower().startswith("content-length:"):
            try:
                length = int(text.split(":", 1)[1].strip())
            except ValueError as exc:
                raise RuntimeError(f"invalid Content-Length header: {text}") from exc
            while True:
                header = await asyncio.wait_for(reader.readline(), timeout=timeout)
                if not header or header in (b"\r\n", b"\n"):
                    break
            payload = await asyncio.wait_for(reader.readexactly(length), timeout=timeout)
            return json.loads(payload.decode("utf-8", "replace"))
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            # Some generated servers log to stdout even though MCP requires JSON.
            # Skip those lines and keep waiting for the real protocol response.
            continue


async def _send_jsonrpc(
    proc: asyncio.subprocess.Process,
    method: str,
    params: dict[str, Any] | None,
    request_id: int | None,
) -> None:
    if not proc.stdin:
        raise RuntimeError("MCP server stdin unavailable")
    payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
    if request_id is not None:
        payload["id"] = request_id
    if params is not None:
        payload["params"] = params
    proc.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
    await proc.stdin.drain()


async def call_mcp_once(
    *,
    command: str,
    args: list[Any] | None = None,
    cwd: str | None = None,
    env: dict[str, Any] | None = None,
    operation: str,
    tool_name: str | None = None,
    arguments: dict[str, Any] | None = None,
    timeout: float = 30.0,
    workspace_id: str | None = None,
    sandbox: dict[str, Any] | None = None,
    sandbox_session_id: str | None = None,
) -> dict[str, Any]:
    """Start a stdio MCP server, run one operation, then terminate it.

    ``workspace_id`` / ``sandbox`` select the containment tier: a caller that
    already holds the workspace passes ``workspace_id``; a pre-resolved settings
    dict (workspace_path / sandbox_type / sandbox_network) can be passed as
    ``sandbox`` to skip the lookup. With neither, the workspace is inferred from
    ``cwd``. Every miss lands on sandbox_type 'none' — the raw host spawn.
    """
    args = [str(a) for a in (args or [])]
    raw_env = {str(k): str(v) for k, v in (env or {}).items()}
    proc_env = os.environ.copy()
    proc_env.update(raw_env)
    secrets = redaction_values(raw_env)
    proc: asyncio.subprocess.Process | None = None
    stderr_task: asyncio.Task[str] | None = None
    try:
        if sandbox is None:
            sandbox = await resolve_workspace_sandbox(workspace_id=workspace_id, cwd=cwd)
        # extra_env is the server's OWN declared env, not the host environment: the
        # container/docker tiers re-inject exactly what they are given and drop the
        # rest, and proc_env below still carries the host env for the wrapper itself.
        argv = apply_sandbox(
            [command, *args],
            sandbox,
            extra_env=raw_env,
            session_id=sandbox_session_id,
        )
        proc = await asyncio.create_subprocess_exec(
            argv[0],
            *argv[1:],
            cwd=cwd or None,
            env=proc_env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stderr_task = asyncio.create_task(_read_stderr(proc))

        req_id = 1
        await _send_jsonrpc(
            proc,
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "ive-alloy", "version": "1.0.0"},
            },
            req_id,
        )
        init_resp = await _read_jsonrpc_message(proc.stdout, timeout)
        if init_resp.get("error"):
            raise RuntimeError(f"initialize failed: {init_resp['error']}")
        await _send_jsonrpc(proc, "notifications/initialized", None, None)

        req_id += 1
        if operation in {"list_tools", "healthcheck"}:
            await _send_jsonrpc(proc, "tools/list", {}, req_id)
            resp = await _read_jsonrpc_message(proc.stdout, timeout)
            if resp.get("error"):
                raise RuntimeError(f"tools/list failed: {resp['error']}")
            result = resp.get("result") or {}
            tools = result.get("tools") if isinstance(result, dict) else []
            return {"ok": True, "operation": operation, "tools": tools or []}

        if operation == "call_tool":
            if not tool_name:
                raise ValueError("tool_name required for call_tool")
            await _send_jsonrpc(
                proc,
                "tools/call",
                {"name": tool_name, "arguments": arguments or {}},
                req_id,
            )
            resp = await _read_jsonrpc_message(proc.stdout, timeout)
            if resp.get("error"):
                raise RuntimeError(f"tools/call failed: {resp['error']}")
            return {"ok": True, "operation": operation, "result": resp.get("result")}

        raise ValueError(f"unsupported operation: {operation}")
    except Exception as exc:
        stderr = ""
        if stderr_task:
            try:
                stderr = await asyncio.wait_for(stderr_task, timeout=0.2)
            except Exception:
                stderr = ""
        return {
            "ok": False,
            "operation": operation,
            "error": str(exc),
            "stderr": redact_text(stderr, secrets),
        }
    finally:
        if proc and proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2)
            except Exception:
                proc.kill()
                try:
                    await proc.wait()
                except Exception:
                    pass
        if stderr_task and not stderr_task.done():
            stderr_task.cancel()
