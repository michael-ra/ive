"""Skill Suggester — semantic skill discovery via embeddings.

Embeds the full skills catalog (name + description) using BAAI/bge-small-en-v1.5
(same model as session_advisor and coordinator). Provides:

  1. **Background indexing**: Batch-embeds all skills on first use. Cached in
     SQLite (entity_type='skill') and in-memory. Re-indexes when catalog changes.

  2. **Semantic search**: `search_skills(query, limit)` for MCP tools and REST.

  3. **Session auto-match**: `suggest_for_session(context)` returns top-3 skills
     formatted as a short system prompt block. Agents see name + description and
     can call `search_skills` / `get_skill_content` MCP tools for full content.

  4. **Auto-suggestion WS push**: When `experimental_auto_skill_suggestions` is
     enabled, pushes top-3 matches to the frontend as the session's intent
     accumulates (same pattern as guideline recommendations).

  5. **Two-stage filter**: embedding pre-filter → Haiku judge confirms each
     candidate is *actually* useful for the current context. Drift gate skips
     the LLM call when the in-session context hasn't shifted meaningfully
     (cosine ≥ 0.85 vs. last-judged context).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time

logger = logging.getLogger(__name__)

# ── In-memory vector cache ─────────────────────────────────────────────────

_skill_vectors: list[tuple[str, str, list[float]]] = []  # (entity_id, dense_text, vector)
_skill_meta: dict[str, dict] = {}  # entity_id → skill metadata
_vectors_loaded = False
_vectors_lock = asyncio.Lock()

_index_building = False
_index_hash: str = ""

_EMBED_BATCH_SIZE = 64
SUGGEST_MIN_SCORE = 0.50
_SUGGEST_COOLDOWN = 240.0
_DRIFT_THRESHOLD = 0.85  # cosine ≥ this → topic unchanged → reuse last result
_JUDGE_MODEL = "claude-haiku-4-5-20251001"
_JUDGE_API_URL = "https://api.anthropic.com/v1/messages"
_JUDGE_TIMEOUT = 10.0

_last_suggest: dict[str, float] = {}
_dismissed: dict[str, set[str]] = {}
_last_judged_ctx_vec: dict[str, list[float]] = {}
_last_judged_results: dict[str, list[dict]] = {}


def _skill_entity_id(skill: dict) -> str:
    name = skill.get("name", "")
    return "skill:" + name.lower().replace(" ", "-").replace("/", "-")[:80]


def _skill_dense_text(skill: dict) -> str:
    parts = [skill.get("name", "")]
    if skill.get("description"):
        parts.append(skill["description"][:200])
    if skill.get("category"):
        parts.append(f"[{skill['category']}]")
    tags = skill.get("tags")
    if tags:
        if isinstance(tags, list):
            tags = ", ".join(tags[:5])
        parts.append(f"tags: {tags}")
    return " | ".join(p for p in parts if p)


def _catalog_hash(skills: list[dict]) -> str:
    names = sorted(s.get("name", "") for s in skills)
    return hashlib.md5("|".join(names).encode()).hexdigest()


# ── Index ──────────────────────────────────────────────────────────────────

async def ensure_index(force: bool = False) -> bool:
    """Ensure skill embeddings are built. Returns True if ready."""
    global _vectors_loaded, _index_building

    if _vectors_loaded and not force:
        return True

    async with _vectors_lock:
        if _vectors_loaded and not force:
            return True
        if await _load_from_db():
            return True
        if not _index_building:
            _index_building = True
            asyncio.create_task(_build_index())
        return _vectors_loaded


async def _load_from_db() -> bool:
    global _skill_vectors, _skill_meta, _vectors_loaded

    try:
        from db import get_db
        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT entity_id, dense_text, vector FROM embeddings WHERE entity_type = 'skill'"
            )
            rows = await cur.fetchall()
        finally:
            await db.close()

        if not rows or len(rows) < 10:
            return False

        vectors = []
        for row in rows:
            try:
                vec = json.loads(row["vector"])
                vectors.append((row["entity_id"], row["dense_text"], vec))
            except (json.JSONDecodeError, TypeError):
                continue

        if len(vectors) < 10:
            return False

        _skill_vectors = vectors

        # Rebuild meta from dense_text (name is first part before |)
        meta = {}
        for eid, dense, _ in vectors:
            parts = dense.split(" | ")
            meta[eid] = {"name": parts[0] if parts else eid, "description": parts[1] if len(parts) > 1 else ""}
        _skill_meta = meta
        _vectors_loaded = True
        logger.info("Loaded %d skill embeddings from DB cache", len(vectors))
        return True
    except Exception as e:
        logger.warning("Failed to load skill embeddings from DB: %s", e)
        return False


async def _build_index():
    global _skill_vectors, _skill_meta, _vectors_loaded, _index_building, _index_hash

    try:
        from skills_client import fetch_skills_index
        from embedder import embed_batch

        skills = await fetch_skills_index()
        if not skills:
            logger.warning("No skills in catalog — skipping index build")
            return

        new_hash = _catalog_hash(skills)
        if new_hash == _index_hash and _vectors_loaded:
            return

        logger.info("Building skill embeddings for %d skills...", len(skills))
        start = time.time()

        items = []
        for s in skills:
            eid = _skill_entity_id(s)
            dense = _skill_dense_text(s)
            if dense:
                items.append((eid, dense, s))

        all_vectors = []
        for i in range(0, len(items), _EMBED_BATCH_SIZE):
            batch = items[i : i + _EMBED_BATCH_SIZE]
            texts = [dense for _, dense, _ in batch]
            vecs = await embed_batch(texts)
            if vecs is None:
                logger.warning("Embedding model unavailable — aborting skill index")
                return
            all_vectors.extend(vecs)

        from db import get_db
        db = await get_db()
        try:
            await db.execute("DELETE FROM embeddings WHERE entity_type = 'skill'")
            for (eid, dense, _), vec in zip(items, all_vectors):
                await db.execute(
                    """INSERT OR REPLACE INTO embeddings
                       (entity_type, entity_id, workspace_id, dense_text, vector, updated_at)
                       VALUES ('skill', ?, NULL, ?, ?, datetime('now'))""",
                    (eid, dense[:500], json.dumps([float(x) for x in vec])),
                )
            await db.commit()
        finally:
            await db.close()

        memory_vectors = []
        meta = {}
        for (eid, dense, skill), vec in zip(items, all_vectors):
            fvec = [float(x) for x in vec]
            memory_vectors.append((eid, dense, fvec))
            meta[eid] = {
                "name": skill.get("name", ""),
                "description": skill.get("description", ""),
                "source_url": skill.get("source_url", ""),
                "path": skill.get("path", ""),
                "repo": skill.get("repo", ""),
                "category": skill.get("category", ""),
                "author": skill.get("author", ""),
                "source": skill.get("source", ""),
            }

        _skill_vectors = memory_vectors
        _skill_meta = meta
        _index_hash = new_hash
        _vectors_loaded = True
        logger.info("Skill index: %d skills embedded in %.1fs", len(memory_vectors), time.time() - start)

    except Exception:
        logger.exception("Skill index build failed")
    finally:
        _index_building = False


# ── Search ─────────────────────────────────────────────────────────────────

async def search_skills(
    query: str,
    limit: int = 5,
    min_score: float = SUGGEST_MIN_SCORE,
    exclude_ids: set[str] | None = None,
) -> list[dict]:
    """Semantic search across all skills."""
    if not query.strip():
        return []

    await ensure_index()

    if not _skill_vectors:
        return await _keyword_fallback(query, limit)

    from embedder import embed, _cosine

    query_vec = await embed(query)
    if query_vec is None:
        return await _keyword_fallback(query, limit)

    exclude = exclude_ids or set()
    results = []

    for eid, dense_text, vec in _skill_vectors:
        if eid in exclude:
            continue
        score = _cosine(query_vec, vec)
        if score >= min_score:
            meta = _skill_meta.get(eid, {})
            results.append({
                "entity_id": eid,
                "name": meta.get("name") or dense_text.split("|")[0].strip(),
                "description": meta.get("description", ""),
                "score": round(score, 4),
                "source_url": meta.get("source_url", ""),
                "path": meta.get("path", ""),
                "repo": meta.get("repo", ""),
                "category": meta.get("category", ""),
                "author": meta.get("author", ""),
                "source": meta.get("source", ""),
            })

    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:limit]


async def _keyword_fallback(query: str, limit: int) -> list[dict]:
    """Simple keyword search when embeddings aren't ready."""
    try:
        from skills_client import fetch_skills_index
        skills = await fetch_skills_index()
    except Exception:
        return []

    query_lower = query.lower()
    terms = query_lower.split()
    scored = []

    for s in skills:
        name = (s.get("name") or "").lower()
        desc = (s.get("description") or "").lower()
        text = f"{name} {desc}"
        hits = sum(1 for t in terms if t in text)
        if hits == 0:
            continue
        name_bonus = 0.2 if any(t in name for t in terms) else 0.0
        score = (hits / len(terms)) * 0.8 + name_bonus
        scored.append({
            "entity_id": _skill_entity_id(s),
            "name": s.get("name", ""),
            "description": s.get("description", ""),
            "score": round(score, 4),
            "source_url": s.get("source_url", ""),
            "path": s.get("path", ""),
            "repo": s.get("repo", ""),
            "category": s.get("category", ""),
            "author": s.get("author", ""),
            "source": s.get("source", "keyword_fallback"),
        })

    scored.sort(key=lambda r: r["score"], reverse=True)
    return scored[:limit]


# ── LLM Judge ──────────────────────────────────────────────────────────────

async def _get_anthropic_api_key() -> str | None:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        return key
    try:
        from db import get_db
        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT api_key FROM accounts WHERE type = 'api_key' "
                "AND api_key IS NOT NULL AND api_key != '' AND status = 'active' LIMIT 1"
            )
            row = await cur.fetchone()
            if row:
                return row["api_key"]
        finally:
            await db.close()
    except Exception:
        pass
    return None


async def judge_candidates(context: str, candidates: list[dict]) -> list[dict]:
    """Ask Haiku which candidates are actually relevant. Returns the kept subset.

    Falls back to returning all candidates if the API key is missing or the call
    fails — keeps current behavior intact when the judge can't run.
    """
    if not candidates:
        return []

    api_key = await _get_anthropic_api_key()
    if not api_key:
        return candidates

    catalog_lines = []
    for i, c in enumerate(candidates):
        desc = (c.get("description") or "").strip().replace("\n", " ")[:160]
        catalog_lines.append(f"{i}. {c['name']} — {desc}")
    catalog = "\n".join(catalog_lines)

    prompt = (
        f"Context (what the user is working on):\n{context[:1200]}\n\n"
        f"Candidate skills (from semantic match):\n{catalog}\n\n"
        f"Return ONLY the indices of skills that would clearly help with this "
        f"specific work — be strict, prefer returning fewer or none over noise. "
        f'Respond with raw JSON only: {{"keep": [<indices>]}}'
    )

    try:
        import aiohttp
        async with aiohttp.ClientSession() as http:
            resp = await http.post(
                _JUDGE_API_URL,
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": _JUDGE_MODEL,
                    "max_tokens": 128,
                    "messages": [{"role": "user", "content": prompt}],
                },
                timeout=aiohttp.ClientTimeout(total=_JUDGE_TIMEOUT),
            )
            body = await resp.json()
        if resp.status != 200:
            logger.debug("skill judge: API %d, falling back to embedding results", resp.status)
            return candidates
        raw = body.get("content", [{}])[0].get("text", "").strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
            if raw.endswith("```"):
                raw = raw[:-3]
        data = json.loads(raw.strip())
        keep_idx = [int(i) for i in data.get("keep", []) if isinstance(i, (int, float))]
        kept = [candidates[i] for i in keep_idx if 0 <= i < len(candidates)]
        return kept
    except Exception as e:
        logger.debug("skill judge: %s — falling back to embedding results", e)
        return candidates


# ── Session System Prompt Injection ────────────────────────────────────────

async def suggest_for_session(context: str, limit: int = 3) -> str | None:
    """Build a short system prompt block with top-N skill suggestions.

    Returns a formatted string to append to the session's system prompt,
    or None if no matches / index not ready.
    """
    if not context.strip():
        return None

    results = await search_skills(context, limit=limit, min_score=SUGGEST_MIN_SCORE)
    if not results:
        return None

    results = await judge_candidates(context, results)
    if not results:
        return None

    lines = ["## Suggested Skills"]
    lines.append(
        "These skills were auto-matched to your session context. "
        "Call `search_skills` to find more or `get_skill_content` with a skill name "
        "to load its full instructions."
    )
    for r in results:
        name = r["name"]
        desc = r["description"]
        if desc:
            lines.append(f"- **{name}** — {desc}")
        else:
            lines.append(f"- **{name}**")

    return "\n".join(lines)


# ── Full Skill Content Retrieval ───────────────────────────────────────────

async def get_skill_content(name: str) -> dict | None:
    """Get full skill content by name. Tries catalog then official repos."""
    from skills_client import fetch_skills_index, fetch_skill_content

    name_lower = name.lower().strip()
    skills = await fetch_skills_index()

    for s in skills:
        if (s.get("name") or "").lower() == name_lower:
            # If it already has content (official repo skill), return it
            if s.get("content"):
                return s
            # Otherwise fetch full content
            path = s.get("path", "")
            repo = s.get("repo", "")
            if path and repo:
                full = await fetch_skill_content(path, repo=repo)
                if full:
                    return full
            return s

    return None


# ── Auto-Suggestion via WS ────────────────────────────────────────────────

async def maybe_suggest_skills(
    session_id: str,
    intent_text: str,
    workspace_id: str | None = None,
    broadcast_fn=None,
):
    """Push top-3 skill suggestions via WebSocket if flag is enabled."""
    try:
        from db import get_db
        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT value FROM app_settings WHERE key = 'experimental_auto_skill_suggestions'"
            )
            row = await cur.fetchone()
            if not row or row["value"] != "on":
                return
        finally:
            await db.close()
    except Exception:
        return

    now = time.time()
    if now - _last_suggest.get(session_id, 0) < _SUGGEST_COOLDOWN:
        return
    _last_suggest[session_id] = now

    dismissed = _dismissed.get(session_id, set())
    results = await search_skills(intent_text, limit=3, min_score=SUGGEST_MIN_SCORE, exclude_ids=dismissed)
    if not results:
        return

    # Drift gate: if the topic hasn't shifted meaningfully since the last
    # judged push, reuse the prior judge result instead of re-asking Haiku.
    from embedder import embed, _cosine
    ctx_vec = await embed(intent_text)
    last_vec = _last_judged_ctx_vec.get(session_id)
    if ctx_vec is not None and last_vec is not None and _cosine(ctx_vec, last_vec) >= _DRIFT_THRESHOLD:
        cached = _last_judged_results.get(session_id)
        if cached is not None:
            results = cached
        else:
            results = await judge_candidates(intent_text, results)
    else:
        results = await judge_candidates(intent_text, results)
        if ctx_vec is not None:
            _last_judged_ctx_vec[session_id] = ctx_vec
        _last_judged_results[session_id] = results

    if not results:
        return

    if broadcast_fn:
        try:
            await broadcast_fn({
                "type": "skill_suggestion",
                "session_id": session_id,
                "skills": results,
                "index_building": _index_building,
            })
        except Exception:
            logger.warning("Failed to broadcast skill suggestions")

    try:
        from event_bus import emit
        from commander_events import CommanderEvent
        await emit(CommanderEvent.SKILL_SUGGESTED, {
            "session_id": session_id,
            "workspace_id": workspace_id,
            "count": len(results),
            "top_skill": results[0]["name"] if results else None,
        })
    except Exception:
        pass


def dismiss_skill(session_id: str, entity_id: str):
    if session_id not in _dismissed:
        _dismissed[session_id] = set()
    _dismissed[session_id].add(entity_id)


def clear_session(session_id: str):
    _last_suggest.pop(session_id, None)
    _dismissed.pop(session_id, None)
    _last_judged_ctx_vec.pop(session_id, None)
    _last_judged_results.pop(session_id, None)


def index_status() -> dict:
    """Return current state of the skill embedding index."""
    return {
        "ready": _vectors_loaded,
        "building": _index_building,
        "count": len(_skill_vectors),
    }
