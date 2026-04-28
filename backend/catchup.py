"""Catch-me-up digest builder.

`build_digest(actor_id, since_iso, until_iso, mode)` queries the
event bus for events in the window, buckets them by workspace and
session, and returns a structured payload the frontend can render.

The payload includes both:
  • `summary` — primary briefing string. When `use_llm` is true (default)
    this is a 2-4 sentence natural-language briefing produced by a small
    LLM via `llm_router`. Falls back to the deterministic summary when
    the LLM is unavailable or fails.
  • `summary_basic` — always-present deterministic fallback (raw counts).

Mode-aware filtering:
  • brief → only TASK_*, PIPELINE_COMPLETED, PLAN_READY events
    (strip diff/tool noise that wouldn't matter to the joiner).
  • code/full → everything; payloads truncated at 2 KB so the digest
    stays bounded.
"""
from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

log = logging.getLogger(__name__)


# Events relevant to a Brief joiner who can't drive sessions.
# Stored event_type values are lowercase (CommanderEvent enum values).
_BRIEF_EVENT_PREFIXES = (
    "task_",
    "pipeline_",
    "plan_",
    "brief_approval_",
    "workspace_",
    "peer_message_",
    "knowledge_",
    "digest_",
    "memory_",
)

# Cap individual payload string size to keep digest bounded.
_PAYLOAD_BUDGET = 2048


def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _to_sqlite_format(s: Optional[str]) -> Optional[str]:
    """Convert ISO 8601 (`2026-04-28T09:57:46+00:00`) to SQLite's
    `datetime('now')` format (`2026-04-28 09:57:46`), so string
    comparison against the stored `created_at` column works."""
    dt = _parse_iso(s)
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def _truncate_payload(payload: dict) -> dict:
    """Drop massively large fields so the digest stays bounded."""
    if not isinstance(payload, dict):
        return {}
    out = {}
    for k, v in payload.items():
        try:
            s = json.dumps(v, default=str)
        except (TypeError, ValueError):
            s = str(v)
        if len(s) > _PAYLOAD_BUDGET:
            out[k] = f"<truncated:{len(s)}b>"
        else:
            out[k] = v
    return out


def _is_relevant_for_mode(event_type: str, mode: str) -> bool:
    if mode == "brief":
        et = (event_type or "").lower()
        return any(et.startswith(p) for p in _BRIEF_EVENT_PREFIXES)
    return True


async def build_digest(
    *,
    since_iso: Optional[str] = None,
    until_iso: Optional[str] = None,
    mode: str = "full",
    workspace_id: Optional[str] = None,
    limit: int = 500,
    use_llm: bool = True,
    llm_cli: str = "claude",
    llm_model: str = "haiku",
    llm_timeout: int = 20,
    include_commits: bool = True,
    include_memory: bool = True,
) -> dict[str, Any]:
    """Build a structured catch-up digest.

    Returns:
      {
        "since": iso,
        "until": iso,
        "mode": mode,
        "total_events": int,
        "by_workspace": [
            {"workspace_id": ..., "count": ..., "events": [...]}
        ],
        "by_type": {event_type: count},
        "summary": "Plain-language summary string."
      }
    """
    from event_bus import bus

    # Default window: last 24h if neither since nor until given.
    if since_iso is None and until_iso is None:
        since_iso = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()

    raw = await bus.query_events(
        limit=limit,
        workspace_id=workspace_id,
        since_iso=_to_sqlite_format(since_iso),
        until_iso=_to_sqlite_format(until_iso),
    )

    # Filter by mode + truncate payloads.
    events = []
    by_type: dict[str, int] = defaultdict(int)
    by_ws: dict[Optional[str], list[dict]] = defaultdict(list)
    for e in raw:
        et = e.get("event_type", "")
        if not _is_relevant_for_mode(et, mode):
            continue
        e["payload"] = _truncate_payload(e.get("payload") or {})
        events.append(e)
        by_type[et] += 1
        by_ws[e.get("workspace_id")].append(e)

    by_workspace_payload = [
        {
            "workspace_id": ws,
            "count": len(es),
            "events": es[:50],  # keep per-ws sample bounded
        }
        for ws, es in by_ws.items()
    ]

    # Pull non-event-bus context: git commits + memory state per workspace.
    workspaces = await _list_workspaces(workspace_id=workspace_id)
    commits_by_ws: list[dict] = []
    memory_by_ws: list[dict] = []
    if include_commits:
        commits_by_ws = await _gather_commits(workspaces, since_iso, until_iso)
    if include_memory:
        memory_by_ws = await _gather_memory_changes(workspaces, since_iso, until_iso)

    total_commits = sum(len(w["commits"]) for w in commits_by_ws)
    total_memory_changes = len(memory_by_ws)

    basic_summary = _synthesize_summary(
        events, by_type, mode,
        n_commits=total_commits,
        n_memory=total_memory_changes,
    )
    summary = basic_summary
    summary_source = "deterministic"

    have_signal = bool(events) or total_commits > 0 or total_memory_changes > 0
    if use_llm and have_signal:
        llm_text = await _llm_summarize(
            events=events,
            by_type=by_type,
            mode=mode,
            commits_by_ws=commits_by_ws,
            memory_by_ws=memory_by_ws,
            workspaces=workspaces,
            cli=llm_cli,
            model=llm_model,
            timeout=llm_timeout,
        )
        if llm_text:
            summary = llm_text
            summary_source = f"{llm_cli}/{llm_model}"

    return {
        "since": since_iso,
        "until": until_iso,
        "mode": mode,
        "total_events": len(events),
        "total_commits": total_commits,
        "total_memory_changes": total_memory_changes,
        "by_workspace": by_workspace_payload,
        "by_type": dict(by_type),
        "events": events[:100],  # newest-first sample for the UI
        "commits": commits_by_ws,
        "memory_changes": memory_by_ws,
        "summary": summary,
        "summary_basic": basic_summary,
        "summary_source": summary_source,
    }


_LLM_SYSTEM_PROMPT = (
    "You are briefing a developer who stepped away from their dev environment. "
    "Read the recent activity — orchestration events, code commits, memory "
    "changes, and worker-to-worker communication — and produce 2-5 short, "
    "conversational sentences summarizing what happened. Be concrete: cite "
    "commit messages or file change counts when notable, name distinctive "
    "workspaces or session titles, group repetitive activity ('cleaned up 32 "
    "sessions'), and surface what likely matters most — code that landed, "
    "plans ready for review, failures, peer messages, knowledge writes, "
    "memory shifts. If commits exist, mention them; do not pretend nothing "
    "happened just because the event count is low. No preamble. No markdown, "
    "no bullets, no lists — just plain prose. Keep it tight."
)

_LLM_EVENT_CAP = 120  # max events fed to the LLM
_LLM_PAYLOAD_KEYS = (
    "title", "name", "status", "from_status", "to_status", "result",
    "task_title", "session_name", "stage_name", "pipeline_name",
    "model", "cli_type", "reason", "error",
)


def _format_event_line(e: dict) -> str:
    t = (e.get("created_at") or "").split(".")[0]
    et = e.get("event_type", "?")
    sid = (e.get("session_id") or "")[:8]
    wid = (e.get("workspace_id") or "")[:8]
    payload = e.get("payload") or {}
    bits: list[str] = []
    if isinstance(payload, dict):
        for k in _LLM_PAYLOAD_KEYS:
            v = payload.get(k)
            if v is None or not isinstance(v, (str, int, float, bool)):
                continue
            s = str(v).replace("\n", " ").strip()
            if not s:
                continue
            if len(s) > 60:
                s = s[:57] + "..."
            bits.append(f"{k}={s}")
    suffix = (" " + " ".join(bits)) if bits else ""
    return f"[{t}] {et} ws={wid} sid={sid}{suffix}"


def _ws_label(ws_id: Optional[str], workspaces: list[dict]) -> str:
    if not ws_id:
        return "global"
    for w in workspaces:
        if w["id"] == ws_id:
            return w.get("name") or ws_id[:8]
    return ws_id[:8]


async def _llm_summarize(
    *,
    events: list[dict],
    by_type: dict,
    mode: str,
    commits_by_ws: list[dict],
    memory_by_ws: list[dict],
    workspaces: list[dict],
    cli: str,
    model: str,
    timeout: int,
) -> Optional[str]:
    """Quick LLM-generated briefing. Returns None on any failure so the
    caller can fall back to the deterministic count summary."""
    try:
        from llm_router import llm_call
    except ImportError:
        return None

    sample = events[-_LLM_EVENT_CAP:]  # newest events live at the tail
    event_lines = [_format_event_line(e) for e in sample]
    counts = ", ".join(
        f"{c}× {t}" for t, c in sorted(by_type.items(), key=lambda kv: -kv[1])[:8]
    )

    sections: list[str] = [
        f"Mode: {mode}",
        f"Total events in window: {len(events)} (showing {len(sample)})",
        f"Top event types: {counts or '(none)'}",
    ]

    if event_lines:
        sections.append("\nEvents (oldest first):\n" + "\n".join(event_lines))

    if commits_by_ws:
        commit_section: list[str] = ["\nGit commits in window:"]
        for w in commits_by_ws:
            label = _ws_label(w.get("workspace_id"), workspaces)
            for c in w.get("commits", [])[:15]:
                stat = ""
                if c.get("files_changed") or c.get("insertions") or c.get("deletions"):
                    stat = (
                        f" [{c.get('files_changed', 0)}f "
                        f"+{c.get('insertions', 0)}/-{c.get('deletions', 0)}]"
                    )
                msg = (c.get("message") or "")[:120]
                commit_section.append(
                    f"  ({label}) {c.get('short_hash', '')} {msg}{stat}"
                )
        sections.append("\n".join(commit_section))

    if memory_by_ws:
        mem_section: list[str] = ["\nMemory changes (workspace memory hub):"]
        for m in memory_by_ws:
            label = _ws_label(m.get("workspace_id"), workspaces)
            mem_section.append(
                f"  ({label}) synced_at={m.get('last_synced_at')} "
                f"size={m.get('content_length', 0)}b "
                f"providers={m.get('provider_count', 0)}"
            )
        sections.append("\n".join(mem_section))

    user_prompt = "\n".join(sections)

    try:
        text = await llm_call(
            cli=cli, model=model, prompt=user_prompt,
            system=_LLM_SYSTEM_PROMPT, timeout=timeout,
        )
    except Exception as ex:  # noqa: BLE001
        log.warning("catchup llm summary failed (%s/%s): %s", cli, model, ex)
        return None

    text = (text or "").strip()
    if not text:
        return None
    # Strip common LLM throat-clearing if it slipped through.
    for prefix in ("Here's a brief summary:", "Briefing:", "Summary:"):
        if text.lower().startswith(prefix.lower()):
            text = text[len(prefix):].strip()
    return text


async def _list_workspaces(*, workspace_id: Optional[str] = None) -> list[dict]:
    """Read workspaces straight from sqlite. Async-safe via aiosqlite."""
    try:
        from db import get_db
    except ImportError:
        return []
    try:
        db = await get_db()
        try:
            if workspace_id:
                cur = await db.execute(
                    "SELECT id, name, path FROM workspaces WHERE id = ?",
                    (workspace_id,),
                )
            else:
                cur = await db.execute(
                    "SELECT id, name, path FROM workspaces ORDER BY order_index ASC"
                )
            rows = await cur.fetchall()
        finally:
            await db.close()
        return [{"id": r["id"], "name": r["name"], "path": r["path"]} for r in rows if r["path"]]
    except Exception as ex:  # noqa: BLE001
        log.warning("catchup: failed to list workspaces: %s", ex)
        return []


async def _gather_commits(
    workspaces: list[dict],
    since_iso: Optional[str],
    until_iso: Optional[str],
) -> list[dict]:
    """For each workspace, return commits inside the window. Skips repos
    that fail or have no commits in window."""
    try:
        from git_ops import git_log_window
    except ImportError:
        return []

    out: list[dict] = []
    for ws in workspaces:
        path = ws.get("path")
        if not path:
            continue
        try:
            commits = await git_log_window(
                path, since_iso=since_iso, until_iso=until_iso, limit=30,
            )
        except Exception as ex:  # noqa: BLE001
            log.debug("catchup: git_log_window failed for %s: %s", path, ex)
            continue
        if commits:
            out.append({
                "workspace_id": ws["id"],
                "workspace_name": ws.get("name"),
                "commits": commits,
            })
    return out


async def _gather_memory_changes(
    workspaces: list[dict],
    since_iso: Optional[str],
    until_iso: Optional[str],
) -> list[dict]:
    """Return workspace_memory rows whose updated_at falls in the window.
    Each entry includes content size + provider count so the LLM can speak
    to *something* even though we don't store per-edit diffs."""
    try:
        from db import get_db
    except ImportError:
        return []

    since = _to_sqlite_format(since_iso)
    until = _to_sqlite_format(until_iso)
    if not workspaces:
        return []

    placeholders = ",".join("?" * len(workspaces))
    args: list = [w["id"] for w in workspaces]
    where = [f"workspace_id IN ({placeholders})"]
    if since:
        where.append("updated_at >= ?")
        args.append(since)
    if until:
        where.append("updated_at <= ?")
        args.append(until)
    sql = (
        "SELECT workspace_id, scope, content, provider_hashes, "
        "last_synced_at, updated_at "
        "FROM workspace_memory WHERE " + " AND ".join(where) + " "
        "ORDER BY updated_at DESC"
    )

    out: list[dict] = []
    try:
        db = await get_db()
        try:
            cur = await db.execute(sql, args)
            rows = await cur.fetchall()
        finally:
            await db.close()
    except Exception as ex:  # noqa: BLE001
        log.warning("catchup: memory query failed: %s", ex)
        return []

    for r in rows:
        provider_count = 0
        try:
            provider_count = len(json.loads(r["provider_hashes"] or "{}"))
        except (TypeError, ValueError):
            pass
        out.append({
            "workspace_id": r["workspace_id"],
            "scope": r["scope"],
            "content_length": len(r["content"] or ""),
            "provider_count": provider_count,
            "last_synced_at": r["last_synced_at"],
            "updated_at": r["updated_at"],
        })
    return out


def _synthesize_summary(
    events: list[dict],
    by_type: dict,
    mode: str,
    *,
    n_commits: int = 0,
    n_memory: int = 0,
) -> str:
    """Cheap, deterministic English summary — no LLM required."""
    if not events and n_commits == 0 and n_memory == 0:
        return "No new activity in this window."
    parts: list[str] = []
    if events:
        n = len(events)
        parts.append(f"{n} event{'s' if n != 1 else ''}")
        top = sorted(by_type.items(), key=lambda kv: -kv[1])[:3]
        if top:
            cats = ", ".join(f"{c}× {t}" for t, c in top)
            parts.append(f"top: {cats}")
        sessions = {e.get("session_id") for e in events if e.get("session_id")}
        if sessions:
            parts.append(
                f"across {len(sessions)} session{'s' if len(sessions) != 1 else ''}"
            )
    if n_commits:
        parts.append(f"{n_commits} commit{'s' if n_commits != 1 else ''}")
    if n_memory:
        parts.append(
            f"{n_memory} memory change{'s' if n_memory != 1 else ''}"
        )
    return "; ".join(parts) + "."
