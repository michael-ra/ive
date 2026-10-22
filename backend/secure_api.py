"""HTTP endpoints for the Secure (offensive self-test) agent (SECURE_AGENT_DESIGN.md §4).

Flow:
  * OPERATOR (UI) authorizes a scope + provisions the clamp:  POST /api/secure/provision
  * The Secure AGENT (worker MCP) drives the box:
      - GET  /api/secure/scope     — what's authorized
      - POST /api/secure/exec      — run a command (scope-aware Sonnet gate, then into Kali)
      - POST /api/secure/findings  — record a confirmed finding
  * OPERATOR can inspect / kill:    GET /api/secure/run, POST /api/secure/teardown|kill

Everything is keyed by run_id == the secure session's id (one run per secure session), so the
WS-5 reconciler can reap a run whose session has died. The scope-aware check is FAIL-CLOSED and
its verdicts are audited to secure_decisions.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone

from aiohttp import web

from db import get_db
import secure_net
import secure_command_check
from secure_scope import SecureScope, SecureScopeError

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sid(request: web.Request) -> str:
    return (request.headers.get("X-IVE-Session-Id") or "").strip()


async def _load_run(db, run_id: str):
    cur = await db.execute("SELECT * FROM secure_runs WHERE run_id = ?", (run_id,))
    return await cur.fetchone()


# ─── Operator: provision ───────────────────────────────────────────────────

async def secure_provision(request: web.Request) -> web.Response:
    """POST /api/secure/provision — authorize a scope + stand up the clamped Kali box.

    Body: {session_id?, scope:{targets:[{ip,ports}], allow_internet?, intensity?,
    rules_of_engagement?}, ttl_minutes?}. Fail-closed: an invalid scope or a failed clamp
    aborts and records status=error — there is never a box without its clamp.
    """
    body = await request.json()
    session_id = (body.get("session_id") or _sid(request) or "").strip()
    if not session_id:
        return web.json_response({"error": "session_id required"}, status=400)
    run_id = session_id
    scope_in = body.get("scope") if isinstance(body.get("scope"), dict) else body
    try:
        scope = SecureScope.from_dict({**scope_in, "run_id": run_id})
        scope.sign(created_by=(body.get("created_by") or session_id),
                   ttl_minutes=int(body.get("ttl_minutes", 120)))
    except (SecureScopeError, ValueError, TypeError) as e:
        return web.json_response({"error": f"invalid scope: {e}"}, status=400)

    workspace_id = body.get("workspace_id") or request.headers.get("X-IVE-Workspace-Id")
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO secure_runs
                   (run_id, session_id, workspace_id, scope_json, scope_hash, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'provisioning', ?, ?)
               ON CONFLICT(run_id) DO UPDATE SET
                   session_id=excluded.session_id, workspace_id=excluded.workspace_id,
                   scope_json=excluded.scope_json, scope_hash=excluded.scope_hash,
                   status='provisioning', error='', updated_at=excluded.updated_at""",
            (run_id, session_id, workspace_id, json.dumps(scope.to_dict()),
             scope.scope_hash(), _now(), _now()),
        )
        await db.commit()
        try:
            run = await secure_net.provision(run_id, scope)
        except secure_net.SecureNetError as e:
            await db.execute("UPDATE secure_runs SET status='error', error=?, updated_at=? WHERE run_id=?",
                             (str(e)[:500], _now(), run_id))
            await db.commit()
            return web.json_response({"error": f"provision failed: {e}", "status": "error"}, status=500)
        await db.execute(
            "UPDATE secure_runs SET status='active', inner_subnet=?, kali_ip=?, gateway_ip=?, updated_at=? WHERE run_id=?",
            (run.inner_subnet, run.kali_ip, run.gateway_inner_ip, _now(), run_id),
        )
        await db.commit()
        return web.json_response({"run_id": run_id, "status": "active", "scope": scope.to_dict(),
                                  "kali_ip": run.kali_ip, "targets": run.targets})
    finally:
        await db.close()


# ─── Agent: exec (scope-aware Sonnet gate) ─────────────────────────────────

async def secure_exec(request: web.Request) -> web.Response:
    """POST /api/secure/exec — run a command in the Kali box AFTER the scope-aware check.

    Body: {command, script_content?}. session from X-IVE-Session-Id. deny/ask => not executed.
    """
    body = await request.json()
    session_id = _sid(request) or body.get("session_id")
    command = (body.get("command") or "").strip()
    if not command:
        return web.json_response({"error": "command required"}, status=400)
    run_id = session_id
    db = await get_db()
    try:
        row = await _load_run(db, run_id)
        if not row or row["status"] != "active":
            return web.json_response(
                {"error": "no active secure run — an operator must authorize a scope first",
                 "decision": "deny"}, status=409)
        scope = SecureScope.from_dict(json.loads(row["scope_json"]))
        if scope.is_expired():
            return web.json_response({"error": "scope expired — re-authorize", "decision": "deny"}, status=403)

        verdict = await secure_command_check.check_command(
            command, scope, script_content=body.get("script_content", ""))
        await db.execute(
            """INSERT INTO secure_decisions
                   (id, run_id, session_id, command, decision, reason, confidence, scope_hash, cached)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (str(uuid.uuid4()), run_id, session_id, command[:2000], verdict["decision"],
             verdict.get("reason", ""), float(verdict.get("confidence", 0)),
             verdict.get("scope_hash", ""), 1 if verdict.get("cached") else 0),
        )
        await db.commit()

        if verdict["decision"] != "allow":
            return web.json_response({"decision": verdict["decision"], "reason": verdict.get("reason"),
                                      "blocked": True})
        rc, out = await secure_net.exec_in_kali(run_id, ["sh", "-c", command])
        return web.json_response({"decision": "allow", "reason": verdict.get("reason"),
                                  "exit_code": rc, "output": out[-20000:]})
    finally:
        await db.close()


# ─── Agent: scope + findings ───────────────────────────────────────────────

async def secure_scope(request: web.Request) -> web.Response:
    """GET /api/secure/scope — the authorized scope for this session's run."""
    run_id = _sid(request) or request.query.get("session_id")
    db = await get_db()
    try:
        row = await _load_run(db, run_id)
        if not row:
            return web.json_response({"error": "no active secure run"}, status=404)
        scope = json.loads(row["scope_json"])
        return web.json_response({"scope": scope, "status": row["status"], "kali_ip": row["kali_ip"],
                                  "summary": SecureScope.from_dict(scope).target_summary()})
    finally:
        await db.close()


async def secure_add_finding(request: web.Request) -> web.Response:
    """POST /api/secure/findings — record a confirmed finding."""
    body = await request.json()
    session_id = _sid(request) or body.get("session_id")
    run_id = session_id
    title = (body.get("title") or "").strip()
    if not title:
        return web.json_response({"error": "title required"}, status=400)
    sev = (body.get("severity") or "info").strip().lower()
    if sev not in ("info", "low", "medium", "high", "critical"):
        sev = "info"
    db = await get_db()
    try:
        row = await _load_run(db, run_id)
        if not row:
            return web.json_response({"error": "no active secure run"}, status=404)
        fid = str(uuid.uuid4())
        await db.execute(
            """INSERT INTO secure_findings
                   (id, run_id, session_id, title, severity, detail, reproduction, target_ip)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (fid, run_id, session_id, title[:300], sev, body.get("detail", ""),
             body.get("reproduction", ""), body.get("target_ip", "")),
        )
        await db.commit()
        return web.json_response({"id": fid, "ok": True}, status=201)
    finally:
        await db.close()


# ─── Operator: inspect + teardown/kill ─────────────────────────────────────

async def secure_get_run(request: web.Request) -> web.Response:
    """GET /api/secure/run?session_id=... — full run state for the UI (scope, findings, verdicts)."""
    run_id = request.query.get("session_id") or _sid(request)
    db = await get_db()
    try:
        row = await _load_run(db, run_id)
        if not row:
            return web.json_response({"run": None, "findings": [], "decisions": []})
        cur = await db.execute("SELECT * FROM secure_findings WHERE run_id=? ORDER BY created_at DESC", (run_id,))
        findings = [dict(r) for r in await cur.fetchall()]
        cur = await db.execute("SELECT * FROM secure_decisions WHERE run_id=? ORDER BY created_at DESC LIMIT 200", (run_id,))
        decisions = [dict(r) for r in await cur.fetchall()]
        run = dict(row)
        try:
            run["scope"] = json.loads(run.pop("scope_json", "{}") or "{}")
        except Exception:
            run["scope"] = {}
        return web.json_response({"run": run, "findings": findings, "decisions": decisions})
    finally:
        await db.close()


async def _do_teardown(run_id: str, killed: bool) -> web.Response:
    res = await secure_net.teardown(run_id)
    db = await get_db()
    try:
        await db.execute("UPDATE secure_runs SET status=?, updated_at=? WHERE run_id=?",
                         ("killed" if killed else "torndown", _now(), run_id))
        await db.commit()
    finally:
        await db.close()
    return web.json_response({"ok": True, "torndown": res, "status": "killed" if killed else "torndown"})


async def secure_teardown(request: web.Request) -> web.Response:
    """POST /api/secure/teardown — stop the box + delete its nets. Idempotent."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    run_id = body.get("run_id") or _sid(request) or request.query.get("session_id")
    if not run_id:
        return web.json_response({"error": "run_id required"}, status=400)
    return await _do_teardown(run_id, bool(body.get("kill")))


async def secure_kill(request: web.Request) -> web.Response:
    """POST /api/secure/kill — operator kill switch: immediate teardown, status=killed."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    run_id = body.get("run_id") or _sid(request) or request.query.get("session_id")
    if not run_id:
        return web.json_response({"error": "run_id required"}, status=400)
    return await _do_teardown(run_id, killed=True)


def register_secure_routes(app: web.Application) -> None:
    app.router.add_post("/api/secure/provision", secure_provision)
    app.router.add_post("/api/secure/exec", secure_exec)
    app.router.add_get("/api/secure/scope", secure_scope)
    app.router.add_post("/api/secure/findings", secure_add_finding)
    app.router.add_get("/api/secure/run", secure_get_run)
    app.router.add_post("/api/secure/teardown", secure_teardown)
    app.router.add_post("/api/secure/kill", secure_kill)
