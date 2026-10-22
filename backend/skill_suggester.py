"""IVE skill lookup with optional separately owned semantic recommendations.

Keyword lookup and source-content retrieval remain usable without an index.
No vector representation, learned ranking or private judge prompt lives here.
"""
from extension_host import available, load_legacy_namespace


def _skill_entity_id(skill: dict) -> str:
    name = skill.get("name", "")
    return "skill:" + name.lower().replace(" ", "-").replace("/", "-")[:80]


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


async def search_skills(query, limit=5, min_score=None, exclude_ids=None):
    if not query.strip():
        return []
    return await _keyword_fallback(query, limit)


async def ensure_index(force=False):
    return False


async def suggest_for_session(*args, **kwargs):
    return None


async def maybe_suggest_skills(*args, **kwargs):
    return None


def dismiss_skill(*args, **kwargs):
    return None


def clear_session(*args, **kwargs):
    return None


def index_status():
    return {"ready": False, "building": False, "count": 0}


if available("myelin"):
    load_legacy_namespace(globals(), "myelin", "backend/skill_suggester.py")
