"""LLM-backed rolling session digest updates.

Runs on idle/turn-complete, gated by workspace context sharing. The updater
keeps one compact current digest in session_digests and appends a small audit
summary to session_turn_summaries.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any

from db import get_db
from orchestration_policy import role_model

logger = logging.getLogger(__name__)

_last_update_at: dict[str, float] = {}
_MIN_INTERVAL_SECONDS = 300


def _as_list(value: Any, limit: int = 12) -> list[str]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            value = [value] if value.strip() else []
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        text = str(item or "").strip()
        if text and text not in out:
            out.append(text[:300])
    return out[:limit]


def _safe_json_obj(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _fallback_digest(existing: dict[str, Any], recent_output: str) -> dict[str, Any]:
    """Build a low-cost digest when the LLM path is unavailable.

    The fallback is deliberately conservative: it records that the session made
    visible progress without inventing decisions or discoveries. This keeps the
    digest freshness fields meaningful and makes summary failures observable.
    """
    lines = []
    for raw in (recent_output or "").splitlines():
        text = " ".join(str(raw).strip().split())
        if not text:
            continue
        if text.startswith(("[Commander reflection]", "Default action:")):
            continue
        lines.append(text)

    last = lines[-1] if lines else "Session produced output, but no concise summary was available."
    turn_summary = last[:240]
    task_summary = (existing.get("task_summary") or turn_summary)[:1000]
    current_focus = (existing.get("current_focus") or turn_summary)[:1000]
    return {
        "turn_summary": turn_summary,
        "task_summary": task_summary,
        "current_focus": current_focus,
        "decisions": existing.get("decisions") or [],
        "discoveries": existing.get("discoveries") or [],
        "context_health": existing.get("context_health") or "unknown",
        "reuse_notes": existing.get("reuse_notes") or {},
    }


async def update_on_idle(session_id: str, recent_output: str) -> None:
    """Update rolling digest from the latest visible session output."""
    import background_ai
    if not await background_ai.enabled("digest"):
        return
    now = time.monotonic()
    if now - _last_update_at.get(session_id, 0.0) < _MIN_INTERVAL_SECONDS:
        return
    _last_update_at[session_id] = now

    recent_output = (recent_output or "").strip()
    if len(recent_output) < 120:
        return

    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT s.id, s.name, s.cli_type, s.session_type, s.workspace_id,
                      w.context_sharing_enabled, w.orchestration_policy,
                      d.task_summary, d.current_focus, d.decisions,
                      d.discoveries, d.files_touched, d.context_health,
                      d.reuse_notes
               FROM sessions s
               LEFT JOIN workspaces w ON s.workspace_id = w.id
               LEFT JOIN session_digests d ON s.id = d.session_id
               WHERE s.id = ?""",
            (session_id,),
        )
        row = await cur.fetchone()
        if not row:
            return
        sess = dict(row)
        if not sess.get("context_sharing_enabled"):
            return
    finally:
        await db.close()

    policy_cli, policy_model = role_model(sess.get("orchestration_policy"), "summary")
    cli = policy_cli or sess.get("cli_type") or "claude"

    existing = {
        "task_summary": sess.get("task_summary") or "",
        "current_focus": sess.get("current_focus") or "",
        "decisions": _as_list(sess.get("decisions")),
        "discoveries": _as_list(sess.get("discoveries")),
        "files_touched": _as_list(sess.get("files_touched"), limit=50),
        "context_health": sess.get("context_health") or "unknown",
        "reuse_notes": _safe_json_obj(sess.get("reuse_notes")),
    }

    prompt = f"""Update the rolling digest for one IVE coding-agent session.

Return ONLY JSON with this shape:
{{
  "turn_summary": "one concise sentence about the latest turn",
  "task_summary": "compact current/overall task summary",
  "current_focus": "what the session is doing or waiting on now",
  "decisions": ["durable decisions, max 8"],
  "discoveries": ["useful discoveries/gotchas, max 8"],
  "context_health": "good|mixed|stale|failed|unknown",
  "reuse_notes": {{
    "good_for": ["subsystems/tasks this session context is useful for"],
    "bad_for": ["subsystems/tasks this session should not be reused for"],
    "reason": "short reason"
  }}
}}

Rules:
- Compact, update-in-place semantics: merge the latest output into the existing digest; do not append repetitive history.
- Keep decisions and discoveries specific to this workspace, not generic coding advice.
- If the output is mostly idle chatter or permission text, keep the existing digest and write a minimal turn_summary.

Existing digest:
{json.dumps(existing, ensure_ascii=False)}

Latest visible output:
{recent_output[-3000:]}
"""

    used_fallback = False
    try:
        from llm_router import call_json, model_id_for_provider
        model_id = await model_id_for_provider(cli, policy_model)
        result = await background_ai.call_json(
            "digest", session_id, model_id, prompt, content=recent_output,
            timeout_s=60, allow_fallback=False,
        )
        if result is None:
            return
    except Exception as exc:
        logger.warning(
            "session digest LLM update failed for %s; using deterministic fallback: %s",
            session_id[:8], exc,
        )
        result = _fallback_digest(existing, recent_output)
        used_fallback = True

    if not isinstance(result, dict):
        result = _fallback_digest(existing, recent_output)
        used_fallback = True

    turn_summary = str(result.get("turn_summary") or "").strip()[:1000]
    task_summary = str(result.get("task_summary") or existing["task_summary"] or "").strip()[:1000]
    current_focus = str(result.get("current_focus") or existing["current_focus"] or "").strip()[:1000]
    decisions = _as_list(result.get("decisions") or existing["decisions"])
    discoveries = _as_list(result.get("discoveries") or existing["discoveries"])
    context_health = str(result.get("context_health") or existing["context_health"] or "unknown").strip().lower()
    if context_health not in {"good", "mixed", "stale", "failed", "unknown"}:
        context_health = "unknown"
    reuse_notes = _safe_json_obj(result.get("reuse_notes")) or existing["reuse_notes"]
    summary_model = (
        "deterministic:fallback"
        if used_fallback
        else f"{cli}:{policy_model or 'default'}"
    )

    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT id FROM session_digests WHERE session_id = ?", (session_id,)
        )
        drow = await cur.fetchone()
        if drow:
            await db.execute(
                """UPDATE session_digests
                   SET task_summary = ?, current_focus = ?, decisions = ?,
                       discoveries = ?, context_health = ?, reuse_notes = ?,
                       last_summary_at = datetime('now'), summary_model = ?,
                       updated_at = datetime('now')
                   WHERE session_id = ?""",
                (
                    task_summary,
                    current_focus,
                    json.dumps(decisions),
                    json.dumps(discoveries),
                    context_health,
                    json.dumps(reuse_notes),
                    summary_model,
                    session_id,
                ),
            )
        else:
            await db.execute(
                """INSERT INTO session_digests
                   (id, session_id, workspace_id, task_summary, current_focus,
                    decisions, discoveries, context_health, reuse_notes,
                    last_summary_at, summary_model)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)""",
                (
                    str(uuid.uuid4()),
                    session_id,
                    sess.get("workspace_id"),
                    task_summary,
                    current_focus,
                    json.dumps(decisions),
                    json.dumps(discoveries),
                    context_health,
                    json.dumps(reuse_notes),
                    summary_model,
                ),
            )

        if turn_summary:
            await db.execute(
                """INSERT INTO session_turn_summaries
                   (id, session_id, workspace_id, summary)
                   VALUES (?, ?, ?, ?)""",
                (str(uuid.uuid4()), session_id, sess.get("workspace_id"), turn_summary),
            )
        await db.commit()
    finally:
        await db.close()
