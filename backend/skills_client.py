"""Agent Skills client.

Fetches skills from the agentskills ecosystem via GitHub.
Skills are folders containing a SKILL.md file with YAML frontmatter + markdown
instructions. Sources:
  1. Official repos: github.com/anthropics/skills
  2. Community catalog: baked-in skills_catalog.json (8000+ skills)

Reference: https://agentskills.io/specification
"""

import json
import re
import time
import logging
import os
import aiohttp

log = logging.getLogger(__name__)

GITHUB_API = "https://api.github.com"
GITHUB_RAW = "https://raw.githubusercontent.com"

SKILL_REPOS = [
    "anthropics/skills",
    "Orchestra-Research/AI-research-SKILLs",
]

# Baked-in community catalog
from resource_path import backend_dir
_CATALOG_PATH = str(backend_dir() / "skills_catalog.json")
_catalog_cache = None

# In-memory caches with TTL
_index_cache = {"skills": [], "fetched_at": 0}
_INDEX_TTL = 300  # 5 minutes


def _load_catalog() -> list[dict]:
    """Load the baked-in skills catalog."""
    global _catalog_cache
    if _catalog_cache is not None:
        return _catalog_cache
    try:
        with open(_CATALOG_PATH, "r") as f:
            raw = json.load(f)
        _catalog_cache = [
            {
                "path": s.get("github_url", s.get("url", "")).rstrip("/").split("/tree/")[-1] if "/tree/" in s.get("github_url", s.get("url", "")) else s.get("name", "").lower().replace(" ", "-"),
                "repo": "/".join(s.get("github_url", s.get("url", "")).split("github.com/")[-1].split("/")[:2]) if "github.com/" in s.get("github_url", s.get("url", "")) else "",
                "name": s.get("name", ""),
                "description": s.get("description", ""),
                "category": s.get("category", ""),
                "author": s.get("author", ""),
                "tags": s.get("tags", ""),
                "source_url": s.get("github_url") or s.get("url", ""),
                "source": "catalog",
            }
            for s in raw
            if s.get("name")
        ]
        log.info("Loaded %d skills from catalog", len(_catalog_cache))
    except Exception as e:
        log.warning("Failed to load skills catalog: %s", e)
        _catalog_cache = []
    return _catalog_cache


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """Parse YAML frontmatter from a SKILL.md file. Returns (meta, body)."""
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)", text, re.DOTALL)
    if not m:
        return {}, text

    meta = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        colon = line.find(":")
        if colon > 0:
            key = line[:colon].strip()
            val = line[colon + 1:].strip().strip('"').strip("'")
            if key == "metadata":
                continue
            meta[key] = val
    return meta, m.group(2)


async def _fetch_repo_skills(session: aiohttp.ClientSession, repo: str) -> list[dict]:
    """Fetch all skills from a single GitHub repo."""
    skills = []
    url = f"{GITHUB_API}/repos/{repo}/git/trees/main?recursive=1"
    try:
        async with session.get(url, headers={"Accept": "application/vnd.github.v3+json"}) as resp:
            if resp.status != 200:
                log.warning("GitHub tree API returned %d for %s", resp.status, repo)
                return skills
            data = await resp.json()
    except Exception as e:
        log.warning("Failed to fetch tree for %s: %s", repo, e)
        return skills

    skill_paths = [
        item["path"]
        for item in data.get("tree", [])
        if item["type"] == "blob" and item["path"].endswith("/SKILL.md")
    ]

    for path in skill_paths:
        try:
            raw_url = f"{GITHUB_RAW}/{repo}/main/{path}"
            async with session.get(raw_url) as resp:
                if resp.status != 200:
                    continue
                text = await resp.text()

            meta, body = _parse_frontmatter(text)
            if not meta.get("name") and not meta.get("description"):
                continue

            dir_path = path.rsplit("/SKILL.md", 1)[0]
            skills.append({
                "path": dir_path,
                "repo": repo,
                "name": meta.get("name", dir_path.split("/")[-1]),
                "description": meta.get("description", ""),
                "license": meta.get("license", ""),
                "compatibility": meta.get("compatibility", ""),
                "allowed_tools": meta.get("allowed-tools", ""),
                "author": repo.split("/")[0],
                "content": body.strip(),
                "source_url": f"https://github.com/{repo}/tree/main/{dir_path}",
                "source": "official",
            })
        except Exception as e:
            log.warning("Failed to fetch skill %s/%s: %s", repo, path, e)
            continue

    return skills


def _kick_github_fetch():
    """Start a background task to fetch official repos (non-blocking)."""
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            loop.create_task(_fetch_official_repos_bg())
    except Exception:
        pass


async def _fetch_official_repos_bg():
    """Background: fetch official repos and update cache."""
    now = time.time()
    if _index_cache["skills"] and (now - _index_cache["fetched_at"]) < _INDEX_TTL:
        return  # Still fresh
    official = []
    try:
        async with aiohttp.ClientSession() as session:
            for repo in SKILL_REPOS:
                repo_skills = await _fetch_repo_skills(session, repo)
                official.extend(repo_skills)
        _index_cache["skills"] = official
        _index_cache["fetched_at"] = time.time()
        log.info("Background: fetched %d official skills", len(official))
    except Exception as e:
        log.warning("Background fetch failed: %s", e)


async def fetch_skills_index() -> list[dict]:
    """Fetch the full skills index (official repos + baked-in catalog).

    Returns the baked-in catalog immediately. Official repo skills are
    fetched in the background and merged once available.
    """
    # Load baked-in catalog (instant, from disk once)
    catalog = _load_catalog()

    # Use cached official skills if available, kick background fetch if stale
    official = _index_cache["skills"]
    now = time.time()
    if not official or (now - _index_cache["fetched_at"]) >= _INDEX_TTL:
        _kick_github_fetch()

    # Merge: official first (if any), then catalog (deduped by name)
    seen = set()
    merged = []
    for s in official:
        key = s["name"].lower()
        if key not in seen:
            seen.add(key)
            merged.append(s)
    for s in catalog:
        key = s["name"].lower()
        if key not in seen:
            seen.add(key)
            merged.append(s)

    return merged


async def fetch_skill_content(skill_path: str, repo: str = "anthropics/skills") -> dict | None:
    """Fetch the full content of a single skill by its directory path."""
    if not repo:
        # Catalog skills without a repo — return minimal info
        catalog = _load_catalog()
        for s in catalog:
            if s["path"] == skill_path or s["name"].lower().replace(" ", "-") == skill_path:
                return s
        return None

    try:
        async with aiohttp.ClientSession() as session:
            raw_url = f"{GITHUB_RAW}/{repo}/main/{skill_path}/SKILL.md"
            async with session.get(raw_url) as resp:
                if resp.status != 200:
                    return None
                text = await resp.text()

            meta, body = _parse_frontmatter(text)
            return {
                "path": skill_path,
                "repo": repo,
                "name": meta.get("name", skill_path.split("/")[-1]),
                "description": meta.get("description", ""),
                "license": meta.get("license", ""),
                "compatibility": meta.get("compatibility", ""),
                "allowed_tools": meta.get("allowed-tools", ""),
                "author": repo.split("/")[0],
                "content": body.strip(),
                "source_url": f"https://github.com/{repo}/tree/main/{skill_path}",
            }
    except Exception as e:
        log.warning("Failed to fetch skill %s/%s: %s", repo, skill_path, e)
        return None
