"""Observatory — Automated AI ecosystem scanner.

Monitors GitHub Trending, Product Hunt, and Hacker News for new tools,
libraries, and features relevant to the current workspace project. Findings
are analyzed by LLM for relevance and scored for integration or feature-
stealing potential.

Two configurable modes per source:
  integrate — Find tools/libs to integrate into the workspace project
  steal     — Find features from other tools the project should adopt

Sources run on configurable intervals (default: 24h for GitHub/PH, 12h for HN).
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import quote as url_quote, unquote

import aiohttp

from db import get_db
from event_bus import bus
from commander_events import CommanderEvent
import api_keys

logger = logging.getLogger(__name__)


# ── API key resolution — delegates to centralized api_keys module ─────

async def _resolve_api_key(name: str) -> str | None:
    return await api_keys.resolve(name)


# ── Source defaults ──────────────────────────────────────────────────

SOURCE_DEFAULTS = {
    "github": {
        "label": "GitHub Trending",
        "interval_hours": 24,
        "keywords": [
            "ai-agent", "llm", "mcp-server", "developer-tools",
            "ai-tools", "rag", "memory-system", "tool-use",
        ],
    },
    "producthunt": {
        "label": "Product Hunt",
        "interval_hours": 24,
        "keywords": ["ai", "developer-tools", "productivity", "coding"],
    },
    "hackernews": {
        "label": "Hacker News",
        "interval_hours": 12,
        "keywords": ["AI", "LLM", "Claude", "agent", "MCP", "coding", "developer tool"],
    },
    # Smart-pipeline-only sources (legacy keyword scanner has no implementation
    # for these; the scheduler routes them through observatory_smart.run_smart_scan).
    "reddit": {
        "label": "Reddit",
        "interval_hours": 12,
        "keywords": [],
    },
    "x": {
        "label": "X / Twitter",
        "interval_hours": 24,
        "keywords": [],
    },
}

# Observatorist session type
OBSERVATORIST_SYSTEM_PROMPT = """You are the Observatorist — an AI ecosystem analyst that monitors and researches tools, libraries, and features relevant to this workspace project.

Your role:
1. Search GitHub, Product Hunt, Hacker News, and other sources for relevant tools and features
2. Analyze discoveries for integration potential or feature adoption opportunities
3. Help the user understand the ecosystem around their project
4. Make concrete recommendations: what to integrate, what features to steal, and why

Use the Deep Research MCP tools (multi_search, extract_pages, gather) for broad searches.
Use the Observatory findings already collected for pre-analyzed discoveries.

When the user asks about tools or features, be specific:
- Name the tool/library, what it does, and why it's relevant to THIS project
- For integrations: how to install, what it replaces/augments, estimated effort
- For feature stealing: what specifically to adopt, where in the codebase, example implementation

Be opinionated. Don't just list options — recommend the best one and explain why."""


# ── GitHub scanner ───────────────────────────────────────────────────

async def scan_github(keywords: list[str] | None = None, since_hours: int = 72) -> list[dict]:
    """Search GitHub for recently created/trending repos matching keywords."""
    keywords = keywords or SOURCE_DEFAULTS["github"]["keywords"]
    since = (datetime.now(timezone.utc) - timedelta(hours=since_hours)).strftime("%Y-%m-%d")

    items = []
    async with aiohttp.ClientSession() as session:
        # Topic-based search for trending repos
        topic_q = " ".join(f"topic:{kw}" for kw in keywords[:5])
        q = f"{topic_q} created:>{since} stars:>20"
        url = (
            f"https://api.github.com/search/repositories?"
            f"q={url_quote(q)}&sort=stars&order=desc&per_page=30"
        )

        headers = {"Accept": "application/vnd.github.v3+json"}
        gh_token = await _resolve_api_key("github")
        if gh_token:
            headers["Authorization"] = f"token {gh_token}"

        try:
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    for repo in data.get("items", [])[:30]:
                        items.append({
                            "source": "github",
                            "source_url": repo["html_url"],
                            "title": repo["full_name"],
                            "description": repo.get("description") or "",
                            "metadata": {
                                "stars": repo["stargazers_count"],
                                "language": repo.get("language"),
                                "topics": repo.get("topics", []),
                                "created_at": repo["created_at"],
                                "forks": repo.get("forks_count", 0),
                            },
                        })
                else:
                    logger.warning("GitHub API returned %d: %s", resp.status, await resp.text())
        except Exception as e:
            logger.error("GitHub scan failed: %s", e)

    return items


# ── Hacker News scanner ─────────────────────────────────────────────

async def scan_hackernews(keywords: list[str] | None = None, max_stories: int = 60) -> list[dict]:
    """Fetch top HN stories and filter for relevance."""
    keywords = keywords or SOURCE_DEFAULTS["hackernews"]["keywords"]
    kw_lower = [k.lower() for k in keywords]

    items = []
    async with aiohttp.ClientSession() as session:
        try:
            async with session.get(
                "https://hacker-news.firebaseio.com/v0/topstories.json",
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                if resp.status != 200:
                    return items
                story_ids = await resp.json()

            # Fetch story details in parallel
            tasks = [_fetch_hn_item(session, sid) for sid in story_ids[:max_stories]]
            stories = await asyncio.gather(*tasks, return_exceptions=True)

            for story in stories:
                if isinstance(story, Exception) or not story:
                    continue
                if story.get("type") != "story":
                    continue
                title_lower = (story.get("title") or "").lower()
                # Quick keyword filter — LLM does deeper analysis later
                if any(kw in title_lower for kw in kw_lower):
                    items.append({
                        "source": "hackernews",
                        "source_url": story.get("url") or f"https://news.ycombinator.com/item?id={story['id']}",
                        "title": story.get("title", ""),
                        "description": f"HN Score: {story.get('score', 0)} | Comments: {story.get('descendants', 0)}",
                        "metadata": {
                            "hn_id": story["id"],
                            "score": story.get("score", 0),
                            "comments": story.get("descendants", 0),
                            "by": story.get("by", ""),
                        },
                    })
        except Exception as e:
            logger.error("HN scan failed: %s", e)

    return items


async def _fetch_hn_item(session: aiohttp.ClientSession, item_id: int) -> dict | None:
    try:
        async with session.get(
            f"https://hacker-news.firebaseio.com/v0/item/{item_id}.json",
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            if resp.status == 200:
                return await resp.json()
    except Exception:
        pass
    return None


# ── Product Hunt scanner ─────────────────────────────────────────────

async def scan_producthunt(keywords: list[str] | None = None) -> list[dict]:
    """Fetch recent Product Hunt launches.

    Uses GraphQL API if PH_ACCESS_TOKEN is set, otherwise searches DuckDuckGo.
    """
    keywords = keywords or SOURCE_DEFAULTS["producthunt"]["keywords"]
    ph_token = await _resolve_api_key("producthunt")

    if ph_token:
        return await _scan_ph_api(ph_token)
    return await _scan_ph_search(keywords)


async def _scan_ph_api(token: str) -> list[dict]:
    """Product Hunt GraphQL API scan."""
    items = []
    query = """
    query {
      posts(order: VOTES, first: 30) {
        edges {
          node {
            id name tagline description url votesCount website
            topics { edges { node { name } } }
          }
        }
      }
    }
    """
    async with aiohttp.ClientSession() as session:
        try:
            async with session.post(
                "https://api.producthunt.com/v2/api/graphql",
                json={"query": query},
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    for edge in data.get("data", {}).get("posts", {}).get("edges", []):
                        node = edge["node"]
                        topics = [t["node"]["name"] for t in node.get("topics", {}).get("edges", [])]
                        items.append({
                            "source": "producthunt",
                            "source_url": node.get("url") or node.get("website", ""),
                            "title": node["name"],
                            "description": node.get("tagline") or node.get("description") or "",
                            "metadata": {
                                "ph_id": node["id"],
                                "votes": node.get("votesCount", 0),
                                "topics": topics,
                                "website": node.get("website"),
                            },
                        })
                else:
                    logger.warning("PH API returned %d", resp.status)
        except Exception as e:
            logger.error("PH API scan failed: %s", e)
    return items


async def _scan_ph_search(keywords: list[str]) -> list[dict]:
    """Fallback: search DuckDuckGo for recent PH launches."""
    items = []
    query = f"site:producthunt.com {' '.join(keywords[:3])} AI tool"

    async with aiohttp.ClientSession() as session:
        try:
            url = f"https://html.duckduckgo.com/html/?q={url_quote(query)}"
            async with session.get(
                url,
                headers={"User-Agent": "Mozilla/5.0 (compatible; Observatory/1.0)"},
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                if resp.status == 200:
                    text = await resp.text()
                    results = _parse_ddg_html(text)
                    for r in results[:20]:
                        if "producthunt.com" in r.get("url", ""):
                            items.append({
                                "source": "producthunt",
                                "source_url": r["url"],
                                "title": r.get("title", ""),
                                "description": r.get("snippet", ""),
                                "metadata": {"via": "search"},
                            })
        except Exception as e:
            logger.error("PH search scan failed: %s", e)
    return items


def _parse_ddg_html(html: str) -> list[dict]:
    """Basic DuckDuckGo HTML result parser."""
    results = []
    for m in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.+?)</a>', html):
        href = m.group(1)
        title = re.sub(r"<[^>]+>", "", m.group(2))
        url_match = re.search(r"uddg=([^&]+)", href)
        actual_url = unquote(url_match.group(1)) if url_match else href
        results.append({"url": actual_url, "title": title, "snippet": ""})
    return results


# ── Workspace context builder ────────────────────────────────────────

async def _get_workspace_context(workspace_id: str | None) -> str:
    """Build a description of the workspace for LLM analysis."""
    if not workspace_id:
        return "No specific workspace context available."

    db = await get_db()
    try:
        cur = await db.execute("SELECT name, path FROM workspaces WHERE id = ?", (workspace_id,))
        ws = await cur.fetchone()
        if not ws:
            return "No specific workspace context available."

        context_parts = [f"Project: {ws['name']}", f"Path: {ws['path']}"]

        # Try to read CLAUDE.md or README for project context
        from pathlib import Path
        ws_path = Path(ws["path"])
        for fname in ("CLAUDE.md", "README.md", "package.json", "pyproject.toml", "Cargo.toml"):
            fpath = ws_path / fname
            if fpath.is_file():
                try:
                    content = fpath.read_text(encoding="utf-8")[:2000]
                    context_parts.append(f"\n{fname} (first 2000 chars):\n{content}")
                    break  # One context file is enough
                except Exception:
                    pass

        return "\n".join(context_parts)
    finally:
        await db.close()


# ── LLM Analysis ────────────────────────────────────────────────────

async def analyze_finding(item: dict, mode: str = "both", workspace_context: str = "") -> dict | None:
    """Use LLM to analyze a finding's relevance and actionability.

    Returns analysis dict or None if LLM call fails.
    """
    from llm_router import llm_call_json

    mode_instruction = {
        "integrate": "Only evaluate whether this can be integrated into the project as a dependency, tool, or library.",
        "steal": "Only evaluate what features or patterns the project should adopt from this tool.",
        "both": "Evaluate both: (1) integration as a dependency/tool, AND (2) features worth adopting.",
    }

    meta_str = json.dumps(item.get("metadata", {}), indent=2)
    prompt = f"""Analyze this discovery for a software project:

**Title:** {item["title"]}
**Description:** {item["description"]}
**Source:** {item["source"]}
**Metadata:** {meta_str}

**Project Context:**
{workspace_context or "General software project."}

**Mode:** {mode_instruction.get(mode, mode_instruction["both"])}

Return a JSON object:
- "relevance_score": float 0.0-1.0 (how relevant to this project? 0.3+ = worth showing)
- "category": "integrate" or "steal"
- "proposal": string (2-3 sentences: what specifically to do and why)
- "steal_targets": array of strings (if "steal": 1-3 specific features to adopt; empty if "integrate")
- "tags": array of 2-4 strings (e.g. "frontend", "database", "testing", "ai", "security")

Be selective — score below 0.3 for irrelevant discoveries. Only 0.6+ for directly applicable tools.
Return ONLY the JSON object."""

    try:
        result = await llm_call_json(cli="claude", model="haiku", prompt=prompt, timeout=60)
        # Validate and clamp
        if not isinstance(result.get("relevance_score"), (int, float)):
            result["relevance_score"] = 0.0
        result["relevance_score"] = max(0.0, min(1.0, float(result["relevance_score"])))
        if result.get("category") not in ("integrate", "steal"):
            result["category"] = "integrate"
        result.setdefault("proposal", "")
        result.setdefault("steal_targets", [])
        result.setdefault("tags", [])
        return result
    except Exception as e:
        logger.warning("LLM analysis failed for %s: %s", item.get("title", "?"), e)
        return None


# ── CRUD ────────────────────────────────────────────────────────────

async def get_findings(
    workspace_id: str | None = None,
    source: str | None = None,
    status: str | None = None,
    min_score: float = 0.0,
    limit: int = 200,
) -> list[dict]:
    """Fetch observatory findings with optional filters."""
    db = await get_db()
    try:
        conditions = ["1=1"]
        params: list = []
        if workspace_id:
            conditions.append("workspace_id = ?")
            params.append(workspace_id)
        if source:
            conditions.append("source = ?")
            params.append(source)
        if status:
            conditions.append("status = ?")
            params.append(status)
        if min_score > 0:
            conditions.append("relevance_score >= ?")
            params.append(min_score)

        where = " AND ".join(conditions)
        params.append(limit)
        cur = await db.execute(
            f"SELECT * FROM observatory_findings WHERE {where} "
            "ORDER BY relevance_score DESC, created_at DESC LIMIT ?",
            params,
        )
        rows = await cur.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


async def get_finding(finding_id: str) -> dict | None:
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM observatory_findings WHERE id = ?", (finding_id,))
        row = await cur.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()


async def update_finding(finding_id: str, updates: dict) -> dict | None:
    db = await get_db()
    try:
        allowed = {"status", "notes", "relevance_score", "category", "proposal"}
        sets, params = [], []
        for k, v in updates.items():
            if k in allowed:
                sets.append(f"{k} = ?")
                params.append(v)
        if not sets:
            return None
        sets.append("updated_at = datetime('now')")
        params.append(finding_id)
        await db.execute(
            f"UPDATE observatory_findings SET {', '.join(sets)} WHERE id = ?", params,
        )
        await db.commit()
        return await get_finding(finding_id)
    finally:
        await db.close()


async def delete_finding(finding_id: str) -> bool:
    db = await get_db()
    try:
        cur = await db.execute("DELETE FROM observatory_findings WHERE id = ?", (finding_id,))
        await db.commit()
        return cur.rowcount > 0
    finally:
        await db.close()


async def promote_to_task(finding_id: str, workspace_id: str) -> dict | None:
    """Create a Feature Board task from an observatory finding."""
    finding = await get_finding(finding_id)
    if not finding:
        return None

    cat_label = "Integration" if finding.get("category") == "integrate" else "Feature Adoption"
    title = f"[Observatory] {cat_label}: {finding['title']}"

    steal_section = ""
    if finding.get("steal_targets"):
        targets = json.loads(finding["steal_targets"]) if isinstance(finding["steal_targets"], str) else finding["steal_targets"]
        if targets:
            steal_section = "\n\n**Features to adopt:**\n" + "\n".join(f"- {t}" for t in targets)

    description = (
        f"## {cat_label} Proposal\n\n"
        f"**Source:** {finding['source']} — [{finding['title']}]({finding.get('source_url', '')})\n"
        f"**Relevance:** {finding.get('relevance_score', 0):.0%}\n\n"
        f"### Proposal\n{finding.get('proposal', 'No proposal generated.')}"
        f"{steal_section}\n\n"
        f"### Source Details\n{finding.get('description', '')}\n\n"
        f"---\n*Auto-generated by Observatory from {finding['source']} scan.*"
    )

    tags_raw = finding.get("tags")
    tags_list = json.loads(tags_raw) if isinstance(tags_raw, str) else (tags_raw or [])
    labels = json.dumps(["observatory", finding["source"]] + tags_list[:3])

    task_id = str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO tasks (id, workspace_id, title, description, status, labels) "
            "VALUES (?, ?, ?, ?, 'backlog', ?)",
            (task_id, workspace_id, title[:200], description, labels),
        )
        await db.execute(
            "UPDATE observatory_findings SET status = 'promoted', promoted_task_id = ?, "
            "updated_at = datetime('now') WHERE id = ?",
            (task_id, finding_id),
        )
        await db.commit()
    finally:
        await db.close()

    await bus.emit(CommanderEvent.OBSERVATORY_FINDING_PROMOTED, {
        "finding_id": finding_id, "task_id": task_id, "workspace_id": workspace_id,
    })
    await bus.emit(CommanderEvent.TASK_CREATED, {
        "task_id": task_id, "workspace_id": workspace_id,
        "title": title[:200], "source": "observatory",
    })

    return {"task_id": task_id, "finding_id": finding_id}


# ── Scan orchestrator ───────────────────────────────────────────────

SCANNERS = {
    "github": scan_github,
    "producthunt": scan_producthunt,
    "hackernews": scan_hackernews,
}


async def run_scan(
    source: str,
    workspace_id: str | None = None,
    mode: str = "both",
    keywords: list[str] | None = None,
    analyze: bool = True,
) -> dict:
    """Run a scan for a specific source. Returns scan summary."""
    scanner = SCANNERS.get(source)
    if not scanner:
        raise ValueError(f"Unknown source: {source}")

    scan_id = str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO observatory_scans (id, workspace_id, source, status, started_at) "
            "VALUES (?, ?, ?, 'running', datetime('now'))",
            (scan_id, workspace_id, source),
        )
        await db.commit()
    finally:
        await db.close()

    await bus.emit(CommanderEvent.OBSERVATORY_SCAN_STARTED, {
        "scan_id": scan_id, "source": source, "workspace_id": workspace_id,
    })

    try:
        # Run the scraper
        raw_items = await scanner(keywords)

        # Dedup against existing findings
        db = await get_db()
        try:
            cur = await db.execute("SELECT source_url FROM observatory_findings")
            existing_urls = {r["source_url"] for r in await cur.fetchall()}
        finally:
            await db.close()

        new_items = [i for i in raw_items if i.get("source_url") not in existing_urls]

        # Get workspace context for LLM analysis
        ws_context = await _get_workspace_context(workspace_id) if analyze else ""

        findings_created = 0
        for item in new_items:
            analysis = None
            if analyze:
                analysis = await analyze_finding(item, mode, ws_context)

            score = analysis.get("relevance_score", 0) if analysis else 0
            if score < 0.2 and analysis is not None:
                continue  # Too irrelevant

            finding_id = str(uuid.uuid4())
            db = await get_db()
            try:
                await db.execute(
                    "INSERT INTO observatory_findings "
                    "(id, workspace_id, source, source_url, title, description, "
                    "category, relevance_score, proposal, steal_targets, tags, "
                    "status, metadata, scan_id) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)",
                    (
                        finding_id, workspace_id, item["source"],
                        item.get("source_url", ""), item["title"], item["description"],
                        (analysis or {}).get("category", "integrate"),
                        score,
                        (analysis or {}).get("proposal", ""),
                        json.dumps((analysis or {}).get("steal_targets", [])),
                        json.dumps((analysis or {}).get("tags", [])),
                        json.dumps(item.get("metadata", {})),
                        scan_id,
                    ),
                )
                await db.commit()
                findings_created += 1
            finally:
                await db.close()

        # Update scan status
        db = await get_db()
        try:
            await db.execute(
                "UPDATE observatory_scans SET status = 'completed', findings_count = ?, "
                "completed_at = datetime('now') WHERE id = ?",
                (findings_created, scan_id),
            )
            await db.commit()
        finally:
            await db.close()

        await bus.emit(CommanderEvent.OBSERVATORY_SCAN_COMPLETED, {
            "scan_id": scan_id, "source": source,
            "findings_count": findings_created, "total_scraped": len(raw_items),
            "workspace_id": workspace_id,
        })

        return {
            "scan_id": scan_id, "source": source, "status": "completed",
            "total_scraped": len(raw_items), "new_items": len(new_items),
            "findings_created": findings_created,
        }

    except Exception as e:
        logger.error("Scan %s failed: %s", source, e)
        db = await get_db()
        try:
            await db.execute(
                "UPDATE observatory_scans SET status = 'failed', error = ?, "
                "completed_at = datetime('now') WHERE id = ?",
                (str(e), scan_id),
            )
            await db.commit()
        finally:
            await db.close()
        return {"scan_id": scan_id, "source": source, "status": "failed", "error": str(e)}


async def get_scans(source: str | None = None, limit: int = 20) -> list[dict]:
    db = await get_db()
    try:
        if source:
            cur = await db.execute(
                "SELECT * FROM observatory_scans WHERE source = ? ORDER BY started_at DESC LIMIT ?",
                (source, limit),
            )
        else:
            cur = await db.execute(
                "SELECT * FROM observatory_scans ORDER BY started_at DESC LIMIT ?", (limit,),
            )
        return [dict(r) for r in await cur.fetchall()]
    finally:
        await db.close()


# ── Source settings ──────────────────────────────────────────────────

async def get_source_settings(workspace_id: str | None = None) -> list[dict]:
    """Get observatory source settings, filling in defaults for unconfigured sources."""
    db = await get_db()
    try:
        wid = workspace_id or "__global__"
        cur = await db.execute(
            "SELECT * FROM observatory_sources WHERE workspace_id = ?", (wid,),
        )
        rows = {r["source"]: dict(r) for r in await cur.fetchall()}

        result = []
        for source_id, defaults in SOURCE_DEFAULTS.items():
            if source_id in rows:
                row = rows[source_id]
                row["label"] = defaults["label"]
                result.append(row)
            else:
                result.append({
                    "source": source_id,
                    "workspace_id": wid,
                    "label": defaults["label"],
                    "enabled": 0,
                    "interval_hours": defaults["interval_hours"],
                    "mode": "both",
                    "keywords": json.dumps(defaults["keywords"]),
                    "last_scan_at": None,
                })
        return result
    finally:
        await db.close()


async def update_source_settings(workspace_id: str | None, source: str, settings: dict) -> dict:
    """Create or update source settings."""
    wid = workspace_id or "__global__"

    # Keywords can arrive as comma-separated string from UI or as a list
    kw_raw = settings.get("keywords", SOURCE_DEFAULTS.get(source, {}).get("keywords", []))
    if isinstance(kw_raw, str):
        kw_list = [k.strip() for k in kw_raw.split(",") if k.strip()]
    elif isinstance(kw_raw, list):
        kw_list = kw_raw
    else:
        kw_list = []

    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO observatory_sources (workspace_id, source, enabled, interval_hours, mode, keywords) "
            "VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(workspace_id, source) DO UPDATE SET "
            "enabled = excluded.enabled, interval_hours = excluded.interval_hours, "
            "mode = excluded.mode, keywords = excluded.keywords",
            (
                wid, source,
                1 if settings.get("enabled", True) else 0,
                settings.get("interval_hours", SOURCE_DEFAULTS.get(source, {}).get("interval_hours", 24)),
                settings.get("mode", "both"),
                json.dumps(kw_list),
            ),
        )
        await db.commit()
    finally:
        await db.close()

    sources = await get_source_settings(workspace_id)
    return next((s for s in sources if s["source"] == source), {})


# ── Background scheduler ───────────────────────────────────────────

class ObservatoryScheduler:
    """Background task that checks scan intervals and triggers scans."""

    def __init__(self):
        self._task: asyncio.Task | None = None
        self._running = False

    async def start(self):
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        logger.info("Observatory scheduler started")

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Observatory scheduler stopped")

    async def _loop(self):
        # Wait 2 minutes after server startup before first check
        await asyncio.sleep(120)
        while self._running:
            try:
                await self._check_and_run()
            except Exception as e:
                logger.error("Observatory scheduler error: %s", e)
            await asyncio.sleep(3600)  # Check every hour

    async def _check_and_run(self):
        sources = await get_source_settings()
        now = datetime.now(timezone.utc)

        for src in sources:
            if not src.get("enabled"):
                continue

            interval = timedelta(hours=src.get("interval_hours", 24))
            last_scan = src.get("last_scan_at")

            if last_scan:
                try:
                    last_dt = datetime.fromisoformat(last_scan.replace("Z", "+00:00"))
                    if now - last_dt < interval:
                        continue
                except (ValueError, TypeError):
                    pass

            source_id = src["source"]
            mode = src.get("mode", "both")
            keywords = json.loads(src["keywords"]) if isinstance(src.get("keywords"), str) else src.get("keywords")
            workspace_id = src.get("workspace_id")
            if workspace_id == "__global__":
                workspace_id = None

            logger.info("Observatory: auto-scanning %s (mode=%s)", source_id, mode)

            # Prefer the smart pipeline whenever the workspace has a profile
            # built. Falls back to the legacy keyword scanner if the profile is
            # missing or the smart run errors. Smart-only sources (reddit, x)
            # always go through the smart path — the legacy path has no
            # scanner for them.
            ran_smart = False
            if workspace_id:
                try:
                    import observatory_profile  # local import to avoid circular
                    import observatory_smart
                    profile = await observatory_profile.get_profile(workspace_id)
                    if profile or source_id in ("reddit", "x"):
                        await observatory_smart.run_smart_scan(workspace_id, source_id)
                        ran_smart = True
                except Exception as exc:
                    logger.warning("smart scan failed, falling back to legacy: %s", exc)

            if not ran_smart and source_id in SCANNERS:
                await run_scan(source_id, workspace_id, mode, keywords)

            # Update last_scan_at
            db = await get_db()
            try:
                await db.execute(
                    "UPDATE observatory_sources SET last_scan_at = datetime('now') "
                    "WHERE source = ? AND workspace_id = ?",
                    (source_id, workspace_id or "__global__"),
                )
                await db.commit()
            finally:
                await db.close()


# Module-level singleton
scheduler = ObservatoryScheduler()
