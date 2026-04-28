"""Observatory profile + curated search-target memory — LLM-driven, no keywords.

Every decision in the observatory pipeline is an LLM judgment over prose
context. There is no string matching, no keyword config the user has to
maintain. The profile captures what the project IS and what we'd like to
find; the search-target list captures WHERE we look (subreddits, GitHub
topics, Product Hunt categories, X hashtags, search queries) and grows
with use.

Stages this module exposes:

  build_profile(workspace_id)
      LLM ingests CLAUDE.md + README + workspace_memory + auto-memory +
      memory_entries + recent session digests + recent user turns +
      observatory promote/dismiss history. Emits a prose profile JSON
      (markdown strings under named keys). One sonnet call, periodic.

  plan_targets(workspace_id, source)
      LLM reads {profile, source, existing targets with yield stats} and
      decides {targets_to_scan, targets_to_add, targets_to_retire}.
      Persists additions and retirements. Replaces the static
      `keywords` config — profile changes propagate automatically.

  triage_items(workspace_id, items)
      Single batched LLM call over the scraped item list:
      "given this profile, classify each as skip / analyze / voice_only /
      competitor_track + 1-line reason." Replaces per-item haiku.

  record_target_scan(target_id, yielded)
      Bookkeeping after a scan: hit_count++, yield_count++, last_*_at,
      signal_score recalculation. Called by the scanner orchestrator.

  recalibrate_profile(workspace_id)
      LLM rewrites the profile prose given recent promote/dismiss signal
      and new insights. Replaces an explicit anti_keywords bucket.

Storage:
  observatory_profiles       — one row per workspace (JSON of markdown)
  observatory_search_targets — curated sub-sources the LLM aggregated

This module never imports or calls observatory.py — it's the upstream of
that pipeline. observatory.py will (in a follow-up wiring) consume these
functions instead of its current keyword-config flow.
"""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from db import get_db

logger = logging.getLogger(__name__)


# ── Constants ─────────────────────────────────────────────────────────

PROFILE_SECTIONS = (
    "identity",
    "interests",
    "current_stack",
    "competitors",
    "audience",
    "tone",
    "dismissal_patterns",
)

# How much of each input we feed the profile LLM. Bounded so we don't
# blow past Sonnet's context on a chunky workspace.
_INPUT_LIMITS = {
    "claude_md": 6000,
    "readme": 4000,
    "package_meta": 1500,
    "workspace_memory": 5000,
    "auto_memory": 5000,
    "memory_entries": 5000,
    "session_digests": 6000,
    "user_turns": 8000,
    "promote_history": 2500,
    "dismiss_history": 1500,
}

VALID_TARGET_TYPES = {
    "topic", "subreddit", "category", "hashtag", "search_query", "user", "domain",
    "front_page", "top_today", "trending",
}
VALID_SOURCES = {"github", "reddit", "hackernews", "producthunt", "x"}


# ══════════════════════════════════════════════════════════════════════
# Input collection
# ══════════════════════════════════════════════════════════════════════

async def _collect_inputs(workspace_id: str) -> dict[str, Any]:
    """Pull every signal source the profile builder needs.

    Returns a dict with bounded-size strings under each key. Empty/missing
    sources resolve to "" so the prompt template is simple.
    """
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT id, name, path FROM workspaces WHERE id = ?", (workspace_id,)
        )
        ws = await cur.fetchone()
        if not ws:
            return {}
        ws_path = Path(ws["path"])
        ws_name = ws["name"]
    finally:
        await db.close()

    inputs: dict[str, Any] = {
        "workspace_name": ws_name,
        "workspace_path": str(ws_path),
    }

    # ─ Code identity ─
    inputs["claude_md"] = _read_file_truncated(ws_path / "CLAUDE.md", _INPUT_LIMITS["claude_md"])
    inputs["readme"] = _read_file_truncated(ws_path / "README.md", _INPUT_LIMITS["readme"])
    inputs["package_meta"] = _collect_package_meta(ws_path, _INPUT_LIMITS["package_meta"])

    # ─ Memory: central + auto + curated entries ─
    inputs["workspace_memory"] = await _read_workspace_memory(workspace_id, _INPUT_LIMITS["workspace_memory"])
    inputs["auto_memory"] = await _read_auto_memory(str(ws_path), _INPUT_LIMITS["auto_memory"])
    inputs["memory_entries"] = await _read_memory_entries(workspace_id, _INPUT_LIMITS["memory_entries"])

    # ─ Session signal: digests + recent user turns ─
    inputs["session_digests"] = await _read_session_digests(workspace_id, _INPUT_LIMITS["session_digests"])
    inputs["user_turns"] = await _read_recent_user_turns(workspace_id, _INPUT_LIMITS["user_turns"])

    # ─ Calibration signal: what the user has promoted vs dismissed ─
    inputs["promote_history"] = await _read_promote_history(workspace_id, _INPUT_LIMITS["promote_history"])
    inputs["dismiss_history"] = await _read_dismiss_history(workspace_id, _INPUT_LIMITS["dismiss_history"])

    inputs["inputs_hash"] = _hash_inputs(inputs)
    return inputs


def _read_file_truncated(path: Path, limit: int) -> str:
    if not path.is_file():
        return ""
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return ""
    return text if len(text) <= limit else text[:limit] + "\n\n[…truncated]"


def _collect_package_meta(ws_path: Path, limit: int) -> str:
    """Tiny snapshot of package.json / pyproject.toml / Cargo.toml for stack hints."""
    parts: list[str] = []
    for fname in ("package.json", "pyproject.toml", "Cargo.toml", "go.mod"):
        f = ws_path / fname
        if f.is_file():
            try:
                text = f.read_text(encoding="utf-8")[: limit // 2]
                parts.append(f"### {fname}\n{text}")
            except Exception:
                pass
    out = "\n\n".join(parts)
    return out[:limit]


async def _read_workspace_memory(workspace_id: str, limit: int) -> str:
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT content FROM workspace_memory WHERE workspace_id = ? AND scope = 'project'",
            (workspace_id,),
        )
        row = await cur.fetchone()
        content = (row["content"] if row else "") or ""
    finally:
        await db.close()
    return content[:limit]


async def _read_auto_memory(ws_path_str: str, limit: int) -> str:
    """Pull CLI-side auto-memory (e.g. .claude/memory/*.md) via memory_sync."""
    try:
        from memory_sync import sync_manager
        all_auto = await sync_manager.read_all_auto_memory(ws_path_str)
    except Exception as exc:
        logger.debug("read_all_auto_memory failed: %s", exc)
        return ""

    parts: list[str] = []
    for cli_type, entries in (all_auto or {}).items():
        if not entries:
            continue
        parts.append(f"### {cli_type}")
        for e in entries:
            name = e.get("name") or e.get("filename", "")
            desc = e.get("description") or ""
            content = (e.get("content") or "")[:500]
            parts.append(f"- **{name}**: {desc}\n  {content}")
    out = "\n".join(parts)
    return out[:limit]


async def _read_memory_entries(workspace_id: str, limit: int) -> str:
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT type, name, description, content FROM memory_entries "
            "WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 40",
            (workspace_id,),
        )
        rows = await cur.fetchall()
    finally:
        await db.close()

    parts: list[str] = []
    for r in rows:
        body = (r["description"] or r["content"] or "")[:300]
        parts.append(f"- [{r['type']}] {r['name']} — {body}")
    out = "\n".join(parts)
    return out[:limit]


async def _read_session_digests(workspace_id: str, limit: int) -> str:
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT task_summary, current_focus, decisions, discoveries, files_touched "
            "FROM session_digests WHERE workspace_id = ? "
            "ORDER BY updated_at DESC LIMIT 15",
            (workspace_id,),
        )
        rows = await cur.fetchall()
    finally:
        await db.close()

    parts: list[str] = []
    for r in rows:
        block = []
        if r["task_summary"]:
            block.append(f"task: {r['task_summary']}")
        if r["current_focus"]:
            block.append(f"focus: {r['current_focus']}")
        for fld in ("decisions", "discoveries"):
            try:
                items = json.loads(r[fld] or "[]")
                if items:
                    block.append(f"{fld}: " + "; ".join(str(x)[:120] for x in items[:5]))
            except Exception:
                pass
        if block:
            parts.append("- " + " | ".join(block))
    out = "\n".join(parts)
    return out[:limit]


async def _read_recent_user_turns(workspace_id: str, limit: int) -> str:
    """Last user-role messages across this workspace's sessions, last 30 days."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT m.content, s.name AS sname, m.created_at "
            "FROM messages m JOIN sessions s ON m.session_id = s.id "
            "WHERE s.workspace_id = ? AND m.role = 'user' AND m.created_at >= ? "
            "ORDER BY m.created_at DESC LIMIT 80",
            (workspace_id, cutoff),
        )
        rows = await cur.fetchall()
    finally:
        await db.close()

    parts: list[str] = []
    for r in rows:
        body = (r["content"] or "").strip()
        if not body:
            continue
        body = body[:280]
        parts.append(f"- [{r['sname']}] {body}")
    out = "\n".join(parts)
    return out[:limit]


async def _read_promote_history(workspace_id: str, limit: int) -> str:
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT title, source, category, proposal FROM observatory_findings "
            "WHERE workspace_id = ? AND status = 'promoted' "
            "ORDER BY updated_at DESC LIMIT 25",
            (workspace_id,),
        )
        rows = await cur.fetchall()
    finally:
        await db.close()

    parts: list[str] = []
    for r in rows:
        prop = (r["proposal"] or "")[:200]
        parts.append(f"- [{r['source']}/{r['category']}] {r['title']} — {prop}")
    out = "\n".join(parts)
    return out[:limit]


async def _read_dismiss_history(workspace_id: str, limit: int) -> str:
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT title, source FROM observatory_findings "
            "WHERE workspace_id = ? AND status IN ('dismissed', 'rejected') "
            "ORDER BY updated_at DESC LIMIT 40",
            (workspace_id,),
        )
        rows = await cur.fetchall()
    finally:
        await db.close()
    parts = [f"- [{r['source']}] {r['title']}" for r in rows]
    out = "\n".join(parts)
    return out[:limit]


def _hash_inputs(inputs: dict[str, Any]) -> str:
    """Stable hash so we can short-circuit no-op rebuilds."""
    keys = sorted(k for k in inputs if k != "inputs_hash")
    h = hashlib.sha256()
    for k in keys:
        h.update(k.encode())
        h.update(b"\x00")
        h.update(str(inputs[k]).encode())
        h.update(b"\x01")
    return h.hexdigest()


# ══════════════════════════════════════════════════════════════════════
# Profile build
# ══════════════════════════════════════════════════════════════════════

_PROFILE_SYSTEM = (
    "You are the Observatory Profile Builder. Your job is to produce a "
    "rich, prose profile of a software project that downstream LLM stages "
    "will consume as context. The profile drives an automated ecosystem "
    "scanner — what it searches for, what it considers a competitor, what "
    "it triages out as noise. Be specific, opinionated, and concrete. "
    "Avoid hedging language. Never invent facts not supported by the "
    "inputs; when a section has no signal, say so explicitly."
)


def _build_profile_prompt(inputs: dict[str, Any]) -> str:
    def _section(label: str, body: str) -> str:
        return f"### {label}\n\n{body or '(empty)'}\n"

    return f"""# Project: {inputs.get('workspace_name', '?')}

You are building a profile that another LLM will read to decide what's
worth surfacing from GitHub, Reddit, Hacker News, Product Hunt, and X.

## Source signal

{_section('CLAUDE.md', inputs.get('claude_md', ''))}
{_section('README.md', inputs.get('readme', ''))}
{_section('Package metadata', inputs.get('package_meta', ''))}
{_section('Central workspace memory', inputs.get('workspace_memory', ''))}
{_section('Auto-memory entries (CLI-generated)', inputs.get('auto_memory', ''))}
{_section('Curated memory entries', inputs.get('memory_entries', ''))}
{_section('Recent session digests', inputs.get('session_digests', ''))}
{_section('Recent user turns (last 30d)', inputs.get('user_turns', ''))}
{_section('Past promoted observatory findings', inputs.get('promote_history', ''))}
{_section('Past dismissed observatory findings', inputs.get('dismiss_history', ''))}

## Output format

Return a single JSON object with these markdown-string keys (each value is
prose, headed with a `##` heading):

  - identity            — what this project is, in 1-2 paragraphs
  - interests           — what kinds of tools, libraries, papers, posts,
                          and product launches we'd love to find. Describe
                          categories richly; do NOT emit a keyword list.
  - current_stack       — what we already use, so the scanner can avoid
                          re-flagging tools we depend on
  - competitors         — named entities we compete or overlap with, with
                          a 1-line reason each. Inferred from chats too,
                          not just docs.
  - audience            — who uses this project / who's adjacent in the
                          discourse (informs subreddits, hashtags)
  - tone                — how the user/team talks about the project
                          (vibe, vocabulary). Useful for voice-mode
                          extraction from comments.
  - dismissal_patterns  — what categories of findings we keep skipping;
                          inferred from dismiss_history vs promote_history.
                          Replaces any anti-keyword list.

Return ONLY the JSON object. No commentary, no fences."""


async def build_profile(workspace_id: str) -> dict[str, Any]:
    """Generate a fresh profile for the workspace via LLM. Upserts the row."""
    from llm_router import llm_call_json

    inputs = await _collect_inputs(workspace_id)
    if not inputs:
        raise ValueError(f"workspace {workspace_id} not found")

    prompt = _build_profile_prompt(inputs)
    profile = await llm_call_json(
        cli="claude", model="sonnet", prompt=prompt, system=_PROFILE_SYSTEM, timeout=180
    )

    profile_clean = {k: str(profile.get(k, "")).strip() for k in PROFILE_SECTIONS}

    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO observatory_profiles "
            "(workspace_id, profile, inputs_hash, generated_at, updated_at) "
            "VALUES (?, ?, ?, datetime('now'), datetime('now')) "
            "ON CONFLICT(workspace_id) DO UPDATE SET "
            "profile = excluded.profile, "
            "inputs_hash = excluded.inputs_hash, "
            "generated_at = excluded.generated_at, "
            "updated_at = excluded.updated_at",
            (workspace_id, json.dumps(profile_clean), inputs["inputs_hash"]),
        )
        await db.commit()
    finally:
        await db.close()

    return await get_profile(workspace_id) or {}


async def get_profile(workspace_id: str) -> dict[str, Any] | None:
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT * FROM observatory_profiles WHERE workspace_id = ?", (workspace_id,)
        )
        row = await cur.fetchone()
    finally:
        await db.close()
    if not row:
        return None
    out = dict(row)
    try:
        out["profile"] = json.loads(out["profile"] or "{}")
    except Exception:
        out["profile"] = {}
    return out


async def update_profile_text(
    workspace_id: str, profile: dict[str, str]
) -> dict[str, Any] | None:
    """Replace profile sections with user-edited prose. Sections not in the
    payload are preserved from the existing row.
    """
    existing = await get_profile(workspace_id)
    base: dict[str, str] = (existing or {}).get("profile", {}) or {}
    merged = {**base, **{k: str(v) for k, v in (profile or {}).items() if k in PROFILE_SECTIONS}}

    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO observatory_profiles "
            "(workspace_id, profile, user_edited_at, updated_at) "
            "VALUES (?, ?, datetime('now'), datetime('now')) "
            "ON CONFLICT(workspace_id) DO UPDATE SET "
            "profile = excluded.profile, "
            "user_edited_at = excluded.user_edited_at, "
            "updated_at = excluded.updated_at",
            (workspace_id, json.dumps(merged)),
        )
        await db.commit()
    finally:
        await db.close()
    return await get_profile(workspace_id)


def render_profile_prose(profile_dict: dict[str, str]) -> str:
    """Flatten the section dict to a single markdown blob for downstream prompts."""
    if not profile_dict:
        return "(no profile yet — defaulting to empty)"
    return "\n\n".join(
        profile_dict.get(k, "") for k in PROFILE_SECTIONS if profile_dict.get(k)
    )


# ══════════════════════════════════════════════════════════════════════
# Search-target curation
# ══════════════════════════════════════════════════════════════════════

async def list_targets(
    workspace_id: str, source: str | None = None, status: str | None = None
) -> list[dict]:
    db = await get_db()
    try:
        conds, params = ["workspace_id = ?"], [workspace_id]
        if source:
            conds.append("source = ?")
            params.append(source)
        if status:
            conds.append("status = ?")
            params.append(status)
        cur = await db.execute(
            f"SELECT * FROM observatory_search_targets WHERE {' AND '.join(conds)} "
            "ORDER BY signal_score DESC, last_yielded_at DESC NULLS LAST",
            params,
        )
        rows = await cur.fetchall()
    finally:
        await db.close()
    return [dict(r) for r in rows]


async def add_target(
    workspace_id: str,
    source: str,
    target_type: str,
    value: str,
    rationale: str = "",
    added_by: str = "user",
    status: str = "active",
) -> dict | None:
    if source not in VALID_SOURCES:
        raise ValueError(f"invalid source: {source}")
    if target_type not in VALID_TARGET_TYPES:
        raise ValueError(f"invalid target_type: {target_type}")

    tid = str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            "INSERT OR IGNORE INTO observatory_search_targets "
            "(id, workspace_id, source, target_type, value, rationale, status, added_by) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (tid, workspace_id, source, target_type, value.strip(), rationale, status, added_by),
        )
        await db.commit()
        cur = await db.execute(
            "SELECT * FROM observatory_search_targets "
            "WHERE workspace_id = ? AND source = ? AND target_type = ? AND value = ?",
            (workspace_id, source, target_type, value.strip()),
        )
        row = await cur.fetchone()
    finally:
        await db.close()
    return dict(row) if row else None


async def update_target(target_id: str, updates: dict) -> dict | None:
    allowed = {"status", "signal_score", "rationale"}
    sets, params = [], []
    for k, v in (updates or {}).items():
        if k in allowed:
            sets.append(f"{k} = ?")
            params.append(v)
    if not sets:
        return None
    sets.append("updated_at = datetime('now')")
    params.append(target_id)
    db = await get_db()
    try:
        await db.execute(
            f"UPDATE observatory_search_targets SET {', '.join(sets)} WHERE id = ?", params
        )
        await db.commit()
        cur = await db.execute(
            "SELECT * FROM observatory_search_targets WHERE id = ?", (target_id,)
        )
        row = await cur.fetchone()
    finally:
        await db.close()
    return dict(row) if row else None


async def delete_target(target_id: str) -> bool:
    db = await get_db()
    try:
        cur = await db.execute(
            "DELETE FROM observatory_search_targets WHERE id = ?", (target_id,)
        )
        await db.commit()
        return cur.rowcount > 0
    finally:
        await db.close()


async def record_target_scan(target_id: str, hits: int, yielded: int) -> None:
    """Update bookkeeping after a scan ran against this target.

    Signal score is a smoothed yield rate so a target's productivity
    decays if it stops surfacing useful items, without flapping on a
    single empty scan.
    """
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT hit_count, yield_count, signal_score FROM observatory_search_targets WHERE id = ?",
            (target_id,),
        )
        row = await cur.fetchone()
        if not row:
            return
        new_hits = (row["hit_count"] or 0) + max(hits, 0)
        new_yield = (row["yield_count"] or 0) + max(yielded, 0)
        scan_yield_rate = (yielded / hits) if hits > 0 else 0.0
        prior = row["signal_score"] if row["signal_score"] is not None else 0.5
        new_score = round(0.7 * prior + 0.3 * scan_yield_rate, 4)

        await db.execute(
            "UPDATE observatory_search_targets SET "
            "hit_count = ?, yield_count = ?, signal_score = ?, "
            "last_scanned_at = datetime('now'), "
            "last_yielded_at = CASE WHEN ? > 0 THEN datetime('now') ELSE last_yielded_at END, "
            "updated_at = datetime('now') WHERE id = ?",
            (new_hits, new_yield, new_score, yielded, target_id),
        )
        await db.commit()
    finally:
        await db.close()


# ── Target planner (LLM) ────────────────────────────────────────────

_PLANNER_SYSTEM = (
    "You are the Observatory Target Planner. Given a project profile and "
    "the project's currently curated list of sub-sources for a single "
    "platform, decide (a) which existing targets to scan this run, (b) "
    "which new sub-sources to add to the curated list, and (c) which "
    "low-signal targets to retire. Be concrete: name real subreddits, "
    "real GitHub topic slugs, real Product Hunt category slugs, real X "
    "hashtags. Do not invent platforms. Justify every addition in one "
    "sentence so the user can audit your reasoning later."
)

_TARGET_TYPES_BY_SOURCE = {
    "github":      ("topic", "search_query", "trending"),
    "reddit":      ("subreddit", "search_query", "top_today"),
    "hackernews":  ("search_query", "front_page"),
    "producthunt": ("category", "topic", "search_query", "front_page"),
    "x":           ("hashtag", "user", "search_query"),
}


def _planner_prompt(profile_prose: str, source: str, existing: list[dict]) -> str:
    types_allowed = ", ".join(_TARGET_TYPES_BY_SOURCE.get(source, ("search_query",)))
    existing_lines = "\n".join(
        f"- [{t['target_type']}] {t['value']} "
        f"(status={t['status']}, hits={t['hit_count']}, yields={t['yield_count']}, "
        f"signal={t['signal_score']:.2f}, rationale={t.get('rationale') or '?'})"
        for t in existing
    ) or "(none yet)"

    return f"""## Project profile

{profile_prose or '(empty profile — propose conservatively)'}

## Platform: {source}

Allowed target_type values for this platform: {types_allowed}

## Currently curated targets

{existing_lines}

## Your task

Return a JSON object with three lists:

  "targets_to_scan": [
    {{"id": "<existing target id>", "reason": "why it's worth re-scanning this run"}}
  ]
  "targets_to_add": [
    {{"target_type": "<one of allowed>", "value": "<concrete identifier>",
      "rationale": "why this matches the profile in 1 sentence"}}
  ]
  "targets_to_retire": [
    {{"id": "<existing target id>", "reason": "why it's underperforming"}}
  ]

Rules:
  - Prefer keeping high-signal_score targets active.
  - Retire targets with hit_count > 5 and yield_count == 0, unless the
    user pinned them (status='pinned').
  - Add 0-5 new targets per run; only add when you can justify each.
  - Never include keyword lists. Each target is a single concrete value
    (one subreddit, one topic, one hashtag).
  - Use canonical slugs: subreddits as "r/Name", topics as lowercase-hyphenated,
    hashtags as "#thing".

Return ONLY the JSON object."""


async def plan_targets(workspace_id: str, source: str) -> dict[str, Any]:
    """LLM-plan additions/retirements/scan-list for a source.

    Persists added + retired targets immediately. Returns the plan plus the
    concrete list of target_ids the caller should now scan.
    """
    if source not in VALID_SOURCES:
        raise ValueError(f"invalid source: {source}")

    from llm_router import llm_call_json

    profile_row = await get_profile(workspace_id)
    profile_prose = render_profile_prose((profile_row or {}).get("profile", {}))
    existing = await list_targets(workspace_id, source=source)

    prompt = _planner_prompt(profile_prose, source, existing)
    plan = await llm_call_json(
        cli="claude", model="haiku", prompt=prompt, system=_PLANNER_SYSTEM, timeout=120
    )

    to_scan_ids: list[str] = []
    added: list[dict] = []
    retired: list[dict] = []

    # Apply additions
    for entry in (plan.get("targets_to_add") or [])[:5]:
        try:
            t_type = (entry.get("target_type") or "").strip()
            value = (entry.get("value") or "").strip()
            rationale = (entry.get("rationale") or "").strip()
            if not t_type or not value:
                continue
            if t_type not in _TARGET_TYPES_BY_SOURCE.get(source, ()):
                logger.info("Planner proposed disallowed target_type %s for %s — skipping", t_type, source)
                continue
            row = await add_target(
                workspace_id, source, t_type, value, rationale=rationale, added_by="planner"
            )
            if row:
                added.append(row)
                to_scan_ids.append(row["id"])
        except Exception as exc:
            logger.warning("Failed to add planned target %r: %s", entry, exc)

    # Apply retirements (status = 'retired' but rows kept for audit)
    for entry in (plan.get("targets_to_retire") or []):
        tid = entry.get("id")
        if not tid:
            continue
        await update_target(tid, {"status": "retired", "rationale": entry.get("reason", "")})
        retired.append({"id": tid, "reason": entry.get("reason", "")})

    # Build scan list (existing actives + new additions)
    chosen_existing = {e.get("id") for e in (plan.get("targets_to_scan") or []) if e.get("id")}
    for t in existing:
        if t["status"] in ("retired", "paused"):
            continue
        if t["id"] in chosen_existing or t["status"] == "pinned":
            to_scan_ids.append(t["id"])

    return {
        "source": source,
        "to_scan_target_ids": list(dict.fromkeys(to_scan_ids)),
        "added": added,
        "retired": retired,
        "raw_plan": plan,
    }


# ══════════════════════════════════════════════════════════════════════
# Triage (batched LLM)
# ══════════════════════════════════════════════════════════════════════

_TRIAGE_SYSTEM = (
    "You are the Observatory Triage classifier. Given a project profile "
    "and a batch of raw scraped items, classify each item as one of "
    "skip / analyze / voice_only / competitor_track. Be strict: 'analyze' "
    "is for items that warrant a full deep-extraction; 'voice_only' is "
    "for community discussion (Reddit/HN comment threads) where we want "
    "user voice-of-customer signal; 'competitor_track' is for items that "
    "name a competitor we already track or a new candidate; everything "
    "else is 'skip'. Provide a 1-line reason per item."
)


def _triage_prompt(profile_prose: str, items: list[dict]) -> str:
    listing = "\n".join(
        f"{i}. [{it.get('source','?')}] title={it.get('title','')!r} | "
        f"desc={(it.get('description','') or '')[:200]!r} | "
        f"meta={json.dumps(it.get('metadata') or {})[:200]}"
        for i, it in enumerate(items)
    )
    return f"""## Project profile

{profile_prose or '(empty profile — be conservative)'}

## Items to triage ({len(items)} total)

{listing}

## Output

Return a JSON object: {{"verdicts": [
  {{"index": <int>, "verdict": "skip" | "analyze" | "voice_only" | "competitor_track",
    "reason": "<1 sentence>"}},
  ...
]}}

Cover every index 0..{len(items)-1}. Return ONLY the JSON object."""


async def triage_items(workspace_id: str, items: list[dict]) -> list[dict]:
    """One batched LLM call → per-item verdicts. Returns items annotated
    with `verdict` and `triage_reason` keys (originals preserved).
    """
    if not items:
        return []
    from llm_router import llm_call_json

    profile_row = await get_profile(workspace_id)
    profile_prose = render_profile_prose((profile_row or {}).get("profile", {}))

    prompt = _triage_prompt(profile_prose, items)
    result = await llm_call_json(
        cli="claude", model="haiku", prompt=prompt, system=_TRIAGE_SYSTEM, timeout=180
    )

    verdicts_by_idx: dict[int, dict] = {}
    for v in (result.get("verdicts") or []):
        try:
            verdicts_by_idx[int(v["index"])] = v
        except (TypeError, KeyError, ValueError):
            continue

    out: list[dict] = []
    for idx, item in enumerate(items):
        v = verdicts_by_idx.get(idx) or {}
        verdict = v.get("verdict") or "skip"
        if verdict not in ("skip", "analyze", "voice_only", "competitor_track"):
            verdict = "skip"
        out.append({**item, "verdict": verdict, "triage_reason": v.get("reason", "")})
    return out


# ══════════════════════════════════════════════════════════════════════
# Recalibration (replaces anti_keywords)
# ══════════════════════════════════════════════════════════════════════

_RECALIB_SYSTEM = (
    "You are the Observatory Profile Recalibrator. Rewrite the existing "
    "project profile to incorporate recent promote/dismiss signal. "
    "Sharpen the dismissal_patterns section especially — these are the "
    "kinds of findings the user has been rejecting. Keep all existing "
    "sections, only rewriting where the new signal demands it. Never "
    "produce a keyword list."
)


def _recalib_prompt(profile_dict: dict[str, str], promotes: str, dismisses: str) -> str:
    current = json.dumps(profile_dict, indent=2)
    return f"""## Current profile

{current}

## Recent promote signal (what the user kept)

{promotes or '(none)'}

## Recent dismiss signal (what the user rejected)

{dismisses or '(none)'}

## Task

Return the same JSON shape as the input profile, with sections rewritten
where the new signal warrants. Especially focus dismissal_patterns on
patterns inferred from the rejections above. Return ONLY the JSON."""


async def recalibrate_profile(workspace_id: str) -> dict[str, Any] | None:
    from llm_router import llm_call_json

    existing = await get_profile(workspace_id)
    if not existing or not existing.get("profile"):
        # Bootstrap if nothing exists yet
        return await build_profile(workspace_id)

    promotes = await _read_promote_history(workspace_id, _INPUT_LIMITS["promote_history"])
    dismisses = await _read_dismiss_history(workspace_id, _INPUT_LIMITS["dismiss_history"])

    prompt = _recalib_prompt(existing["profile"], promotes, dismisses)
    new_profile = await llm_call_json(
        cli="claude", model="sonnet", prompt=prompt, system=_RECALIB_SYSTEM, timeout=180
    )
    profile_clean = {k: str(new_profile.get(k, existing["profile"].get(k, ""))).strip()
                     for k in PROFILE_SECTIONS}

    db = await get_db()
    try:
        await db.execute(
            "UPDATE observatory_profiles SET "
            "profile = ?, "
            "last_recalibration_notes = ?, "
            "updated_at = datetime('now') "
            "WHERE workspace_id = ?",
            (json.dumps(profile_clean),
             f"recalibrated at {datetime.now(timezone.utc).isoformat()}",
             workspace_id),
        )
        await db.commit()
    finally:
        await db.close()
    return await get_profile(workspace_id)
