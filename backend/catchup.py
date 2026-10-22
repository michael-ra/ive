"""Catch-me-up digest builder.

`build_digest(actor_id, since_iso, until_iso, mode)` queries the
event bus for events in the window, buckets them by workspace and
session, and returns a structured payload the frontend can render.

The payload includes both:
  • `summary` — primary briefing string. When `use_llm` is true (default)
    this is a 2-4 sentence natural-language briefing produced by a small
    LLM via `llm_router`. Falls back to the deterministic summary when
    generation fails; invalid provider configuration is an explicit error.
    Empty or explicitly deterministic digests do not access a model provider.
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
    model_id: Optional[str] = None,
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
        "right_now": {"sessions": [...], "jobs": [...], "pipeline_runs": [...]},
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
        # Resolve only once there is something to narrate. A fresh installation
        # and the explicit deterministic path must work without any CLI/model.
        model_id = await _resolve_summary_model(model_id)
        llm_text = await _llm_summarize(
            events=events,
            by_type=by_type,
            mode=mode,
            commits_by_ws=commits_by_ws,
            memory_by_ws=memory_by_ws[:50],
            workspaces=workspaces,
            model_id=model_id,
            timeout=llm_timeout,
        )
        if llm_text:
            summary = llm_text
            summary_source = model_id

    # Intentionally collected after summary generation: live state is displayed
    # verbatim in the panel and never becomes narration in the retrospective LLM
    # prompt. Cockpit owns the collector so both surfaces share one read model.
    right_now = await _gather_right_now(workspace_id=workspace_id)

    return {
        "since": since_iso,
        "until": until_iso,
        "mode": mode,
        "total_events": len(events),
        "total_commits": total_commits,
        "total_memory_changes": total_memory_changes,
        "right_now": right_now,
        "by_workspace": by_workspace_payload,
        "by_type": dict(by_type),
        "events": events[:100],  # newest-first sample for the UI
        "commits": commits_by_ws,
        "memory_changes": memory_by_ws,
        "summary": summary,
        "summary_basic": basic_summary,
        "summary_source": summary_source,
    }


async def _resolve_summary_model(model_id: Optional[str]) -> str:
    """Load and validate a selection only for an actual narrated digest."""
    if not model_id:
        from db import get_db

        model_db = await get_db()
        try:
            model_cur = await model_db.execute(
                "SELECT value FROM app_settings WHERE key = 'catchup_model'"
            )
            model_row = await model_cur.fetchone()
            model_id = (
                model_row["value"] if model_row and model_row["value"]
                else "claude:haiku"
            )
        finally:
            await model_db.close()
    from llm_router import resolve_model

    await resolve_model(model_id, required_capability="json")
    return model_id


async def _gather_right_now(*, workspace_id: Optional[str] = None) -> dict[str, Any]:
    """Read cockpit live state without ever risking the historical digest."""
    try:
        from systems_cockpit import right_now_snapshot

        return await right_now_snapshot(workspace_id=workspace_id)
    except Exception as ex:  # noqa: BLE001 - this section is explicitly fail-soft
        log.warning("catchup: live state query failed: %s", ex)
        try:
            from systems_cockpit import unavailable_current_activity

            return unavailable_current_activity()
        except Exception:  # pragma: no cover - only if cockpit cannot import at all
            return {
                "available": False,
                "sessions": [],
                "jobs": [],
                "pipeline_runs": [],
                "caps": {"sessions": 0, "jobs": 0, "pipeline_runs": 0},
                "overflow": {"sessions": 0, "jobs": 0, "pipeline_runs": 0},
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
    "no bullets, no lists — just plain prose. Keep it tight. Return exactly "
    'one JSON object: {"text":"the briefing"}.'
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
    model_id: str,
    timeout: int,
) -> Optional[str]:
    """Quick LLM-generated briefing. Returns None on any failure so the
    caller can fall back to the deterministic count summary."""
    try:
        from llm_router import call_json
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
                if c.get("files"):
                    for f in c["files"][:8]:
                        commit_section.append(f"    - {f['path']} (+{f['insertions']}/-{f['deletions']})")
                    if len(c["files"]) > 8:
                        commit_section.append(f"    - ... and {len(c['files']) - 8} more files")
        sections.append("\n".join(commit_section))

    if memory_by_ws:
        mem_section: list[str] = ["\nMemory changes (all stores):"]
        for m in memory_by_ws:
            label = _ws_label(m.get("workspace_id"), workspaces)
            kind = m.get("kind") or "memory"
            if m.get("old_len") is not None and m.get("new_len") is not None:
                stat = f"size={m.get('old_len', 0)}b -> {m.get('new_len', 0)}b"
            else:
                stat = f"size={m.get('content_length', 0)}b"
            name = f" {m.get('name')}" if m.get("name") else ""
            stale = " stale" if m.get("stale") else ""
            mem_section.append(
                f"  ({label} / {kind}:{m.get('scope')}{name}{stale}) "
                f"updated_at={m.get('updated_at')} ({stat})"
            )
            if m.get("diff"):
                diff_text = m["diff"]
                if len(diff_text) > 800:
                    diff_text = diff_text[:797] + "..."
                mem_section.append(f"    Diff:\n{diff_text}")
        sections.append("\n".join(mem_section))

    user_prompt = "\n".join(sections)

    try:
        result = await call_json(
            model_id=model_id,
            prompt=user_prompt,
            system=_LLM_SYSTEM_PROMPT,
            timeout_s=timeout,
            allow_fallback=False,
        )
        text = str(result.get("text") or "")
    except Exception as ex:  # noqa: BLE001
        log.warning("catchup llm summary failed (%s): %s", model_id, ex)
        return None

    text = (text or "").strip()
    if not text:
        return None
    # Strip common LLM throat-clearing if it slipped through.
    for prefix in ("Here's a brief summary:", "Briefing:", "Summary:"):
        if text.lower().startswith(prefix.lower()):
            text = text[len(prefix):].strip()
    return text


_CHAT_TOOLS_DOC = """You can INVESTIGATE before answering with these READ-ONLY tools. Emit exactly ONE
JSON object per turn (you'll be called repeatedly, so take as many steps as you need):

  {"action":"search_memory","query":"<keywords>"}                 - search ALL saved memory entries (the
       whole store, not just this window). Use this for "what does memory say about X / look in memory".
  {"action":"recent_memory_changes","limit":15}                   - the memory entries that CHANGED during
       this briefing's time window (names, sizes, diffs).
  {"action":"list_events","event_type":"<optional>","limit":25}   - events in the window, optionally one type.
  {"action":"list_commits"}                                       - git commits in the window (msg + file stats).
  {"action":"answer","text":"<final answer>"}                     - finish. Ground EVERY claim in what the
       tools actually returned; if a tool came back empty, say so. Don't refuse to look — use the tools."""


async def _exec_chat_tool(action, args, events, commits, mem_changes, workspace_id) -> str:
    """Run one read-only briefing-chat tool and return a compact text observation."""
    try:
        if action == "search_memory":
            q = (args.get("query") or "").strip()
            if not q:
                return "search_memory needs a non-empty 'query'."
            try:
                from memory_manager import memory_manager
                entries = await memory_manager.search(q, workspace_id=workspace_id, include_global=True)
            except Exception as ex:  # noqa: BLE001
                return f"memory search failed: {ex}"
            if not entries:
                return f"No memory entries matched '{q}'."
            lines = []
            for e in entries[:8]:
                name = e.get("name") or e.get("title") or e.get("id")
                body = (e.get("content") or e.get("description") or "").strip().replace("\n", " ")[:400]
                lines.append(f"- [{e.get('type', 'memory')}] {name}: {body}")
            return f"{len(entries)} memory matches for '{q}' (top {len(lines)}):\n" + "\n".join(lines)

        if action == "recent_memory_changes":
            if not mem_changes:
                return "No memory changes recorded in this window."
            limit = int(args.get("limit") or 15)
            lines = []
            for m in mem_changes[:limit]:
                diff = f" diff: {m['diff'][:200]}" if m.get("diff") else ""
                lines.append(
                    f"- {m.get('kind', 'memory')}:{m.get('scope')} {m.get('name', '')} "
                    f"({m.get('old_len')}b->{m.get('new_len')}b){diff}"
                )
            return f"{len(mem_changes)} memory changes in window (showing {len(lines)}):\n" + "\n".join(lines)

        if action == "list_events":
            etype = args.get("event_type")
            limit = int(args.get("limit") or 25)
            evs = [e for e in events if (not etype or e.get("event_type") == etype)]
            if not evs:
                return f"No events{(' of type ' + etype) if etype else ''} in the sampled window."
            lines = [
                f"- {e.get('event_type')} @ {e.get('created_at', '')}: {json.dumps(e.get('payload', {}), default=str)[:200]}"
                for e in evs[:limit]
            ]
            return f"{len(evs)} events{(' of type ' + etype) if etype else ''} (showing {len(lines)}):\n" + "\n".join(lines)

        if action == "list_commits":
            lines = []
            for w in commits:
                for c in w.get("commits", [])[:15]:
                    lines.append(
                        f"- {c.get('short_hash')} {(c.get('message') or '')[:100]} "
                        f"[{c.get('files_changed', 0)}f +{c.get('insertions', 0)}/-{c.get('deletions', 0)}]"
                    )
            return ("Commits in window:\n" + "\n".join(lines)) if lines else "No git commits in this window."

        return f"Unknown tool '{action}'. Use search_memory, recent_memory_changes, list_events, list_commits, or answer."
    except Exception as ex:  # noqa: BLE001
        return f"Tool '{action}' errored: {ex}"


async def catchup_chat(
    digest,
    messages: list[dict],
    *,
    model_id: str = "claude:haiku",
    timeout: int = 120,
    max_steps: int = 6,
) -> Optional[str]:
    """Agentic, READ-ONLY chat about a briefing.

    Instead of being walled off to the summary text, the model can investigate via tools
    (search_memory / recent_memory_changes / list_events / list_commits) and then answer grounded in
    what it actually found. ``digest`` is the full catch-up digest dict (or a bare summary string);
    ``messages`` is the conversation [{role, content}, ...]. Returns the reply, or None on failure.
    """
    try:
        from llm_router import call_json
    except ImportError:
        return None

    if isinstance(digest, str):
        digest = {"summary": digest}
    digest = digest or {}
    summary = (digest.get("summary") or "").strip()
    workspace_id = digest.get("workspace_id")
    events = digest.get("events") or []
    commits = digest.get("commits") or []
    mem_changes = digest.get("memory_changes") or []

    convo = "\n".join(
        f"{(m.get('role') or 'user')}: {(m.get('content') or '').strip()}"
        for m in messages if (m.get('content') or '').strip()
    )
    if not convo:
        return None

    n_ev = len(events)
    n_co = sum(len(w.get("commits", [])) for w in commits)
    n_mem = len(mem_changes)
    sys_block = (
        "You are a research assistant answering questions about a work briefing the user is reading. "
        "You can READ the underlying data (saved memory, events, git commits) with the tools below — "
        "USE them to verify and dig in, never refuse to look. Everything is strictly read-only.\n\n"
        + _CHAT_TOOLS_DOC
    )
    context = (
        f"<briefing>\n{summary}\n</briefing>\n"
        f"<window>events_sampled={n_ev} commits={n_co} memory_changes_in_window={n_mem}</window>"
    )

    transcript: list[dict] = []
    for _step in range(max_steps):
        invest = "\n\n".join(
            f"STEP {i + 1} call: {t['call']}\nresult: {t['result']}" for i, t in enumerate(transcript)
        ) or "(nothing investigated yet)"
        prompt = (
            f"{sys_block}\n\n{context}\n\n<conversation>\n{convo}\n</conversation>\n\n"
            f"<investigation_so_far>\n{invest}\n</investigation_so_far>\n\n"
            "Emit your next action as a single JSON object."
        )
        try:
            res = await call_json(
                model_id=model_id,
                prompt=prompt,
                timeout_s=timeout,
                allow_fallback=False,
            )
        except Exception as ex:  # noqa: BLE001
            log.warning("catchup chat step failed (%s): %s", model_id, ex)
            break
        if not isinstance(res, dict):
            break
        action = (res.get("action") or "").strip()
        if action in ("answer", "final"):
            return (res.get("text") or res.get("answer") or "").strip() or None
        if not action and (res.get("text") or res.get("answer")):
            return (res.get("text") or res.get("answer")).strip() or None
        obs = await _exec_chat_tool(action, res, events, commits, mem_changes, workspace_id)
        transcript.append({
            "call": json.dumps({k: v for k, v in res.items() if k not in ("text", "answer")}, default=str)[:300],
            "result": (obs or "")[:4000],
        })

    # Out of steps (or stuck) — force a grounded final answer from what we gathered.
    invest = "\n\n".join(
        f"STEP {i + 1} call: {t['call']}\nresult: {t['result']}" for i, t in enumerate(transcript)
    ) or "(no investigation results)"
    try:
        final_result = await call_json(
            model_id=model_id,
            prompt=(
                f"{context}\n\n<conversation>\n{convo}\n</conversation>\n\n"
                f"<investigation>\n{invest}\n</investigation>\n\n"
                "Answer the user's latest message now, grounded ONLY in the investigation results above. "
                'Return exactly {"text":"your answer"}.'
            ),
            system=(
                "You answer questions about a work briefing, grounded only in the provided "
                "investigation results. Return one JSON object with a string field named text."
            ),
            timeout_s=timeout,
            allow_fallback=False,
        )
        final = str(final_result.get("text") or "")
        return (final or "").strip() or None
    except Exception as ex:  # noqa: BLE001
        log.warning("catchup chat final failed: %s", ex)
        return None


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
                include_files=True,
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
    """Return ordinary note/file-sync changes plus selected optional sources.

    The host owns workspace/time scoping, stable sorting and bounded grouping;
    each optional provider owns its storage queries and row representations.
    """
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
    ws_ids = [w["id"] for w in workspaces]
    where = [f"workspace_id IN ({placeholders})"]
    where.append("event_type = 'memory_synced'")
    if since:
        where.append("created_at >= ?")
        args.append(since)
    if until:
        where.append("created_at <= ?")
        args.append(until)
        
    sql = (
        "SELECT workspace_id, payload, created_at "
        "FROM commander_events WHERE " + " AND ".join(where) + " "
        "ORDER BY created_at DESC"
    )

    out: list[dict] = []
    try:
        db = await get_db()
        try:
            cur = await db.execute(sql, args)
            rows = await cur.fetchall()

            time_filters = []
            time_args: list = []
            if since:
                time_filters.append("datetime(updated_at) >= datetime(?)")
                time_args.append(since)
            if until:
                time_filters.append("datetime(updated_at) <= datetime(?)")
                time_args.append(until)
            time_sql = (" AND " + " AND ".join(time_filters)) if time_filters else ""

            cur_entries = await db.execute(
                f"""SELECT workspace_id, name, type, updated_at,
                           LENGTH(content) AS content_length
                      FROM memory_entries
                     WHERE workspace_id IN ({placeholders}){time_sql}
                     ORDER BY updated_at DESC""",
                [*ws_ids, *time_args],
            )
            entry_rows = await cur_entries.fetchall()

            from catchup_sources import memory_updates
            optional_rows = await memory_updates(db, ws_ids, since, until)
        finally:
            await db.close()
    except Exception as ex:  # noqa: BLE001
        log.warning("catchup: memory synced event query failed: %s", ex)
        return []

    for r in rows:
        payload = {}
        try:
            payload = json.loads(r["payload"] or "{}")
        except (TypeError, ValueError):
            pass
        out.append({
            "kind": "project_memory",
            "workspace_id": r["workspace_id"],
            "scope": payload.get("scope", "project"),
            "diff": payload.get("diff", ""),
            "old_len": payload.get("old_len", 0),
            "new_len": payload.get("new_len", 0),
            "updated_at": r["created_at"],
        })
    for r in entry_rows:
        out.append({
            "kind": "memory_entry",
            "workspace_id": r["workspace_id"],
            "scope": r["type"],
            "name": r["name"],
            "content_length": r["content_length"] or 0,
            "updated_at": r["updated_at"],
        })
    out.extend(optional_rows)
    out.sort(key=lambda item: item.get("updated_at") or "", reverse=True)
    return _collapse_bulk_memory_changes(out)


# A mass reindex (e.g. the L0 catalog walking 9k nodes) stamps thousands of
# rows in one window; enumerating them individually made a 46k-row digest that
# froze the panel and bloated the LLM prompt. Beyond this many rows per kind,
# the tail collapses into one summary row — the digest stays human-sized no
# matter what batch jobs did.
_BULK_PER_KIND = 20
_MAX_MEMORY_ROWS = 300


def _collapse_bulk_memory_changes(rows: list[dict]) -> list[dict]:
    by_kind: dict[str, list[dict]] = {}
    for r in rows:
        by_kind.setdefault(r.get("kind", "unknown"), []).append(r)
    out: list[dict] = []
    for kind, items in by_kind.items():
        if len(items) <= _BULK_PER_KIND:
            out.extend(items)
            continue
        kept, omitted = items[:_BULK_PER_KIND], items[_BULK_PER_KIND:]
        out.extend(kept)
        ws_counts: dict[str, int] = {}
        for it in omitted:
            ws = it.get("workspace_id") or ""
            ws_counts[ws] = ws_counts.get(ws, 0) + 1
        top_ws = max(ws_counts, key=ws_counts.get) if ws_counts else None
        out.append({
            "kind": f"{kind}_bulk",
            "workspace_id": top_ws,
            "count": len(omitted),
            "workspaces_affected": len(ws_counts),
            "name": f"{len(omitted)} more {kind} updates (bulk)",
            "updated_at": omitted[0].get("updated_at"),
        })
    out.sort(key=lambda item: item.get("updated_at") or "", reverse=True)
    return out[:_MAX_MEMORY_ROWS]


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
