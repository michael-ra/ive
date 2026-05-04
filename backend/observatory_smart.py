"""Smart observatory pipeline — orchestrates the LLM-staged scan flow.

Sits on top of `observatory_profile` (profile + curated targets +
triage) and produces persisted findings + aggregated insights without a
single keyword-config touch. Stage chain:

  1. plan_targets       — LLM picks which sub-sources to scan
  2. scrape per-target  — direct API calls keyed off target value
  3. dedup              — drop URLs we've already analyzed
  4. triage (batched)   — one LLM call → verdict per item
  5. deep analyze       — LLM + page extract for verdict='analyze' / 'competitor_track'
  6. voice extract      — LLM extracts pain_points/competitor_mentions/
                          feature_requests/notable_quotes for verdict='voice_only'
  7. insight merge      — LLM proposes insert/update/no-op against
                          existing observatory_insights
  8. record yields      — update target signal_score so the planner
                          favors productive sub-sources next run

Reddit scanner is included here (keyless `.json` endpoint) — it's the
first new source the pipeline gates on. GitHub/HN/PH scanners reuse
the existing implementations in `observatory.py` but route through
target values instead of static keyword arrays.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote as url_quote

import aiohttp

import api_keys
import observatory
import observatory_profile
from db import get_db
from event_bus import bus
from commander_events import CommanderEvent

logger = logging.getLogger(__name__)


# ══════════════════════════════════════════════════════════════════════
# Reddit scanner (keyless .json)
# ══════════════════════════════════════════════════════════════════════

_REDDIT_UA = "ive-observatory/0.1 (+https://github.com/anthropics/ive)"


async def scan_reddit_subreddit(sub: str, limit: int = 30, sort: str = "hot", t: str = "") -> list[dict]:
    """Pull recent posts from a single subreddit using the keyless .json API.

    `sub` may be 'r/Name', '/r/Name', or 'Name' — all normalized.
    `sort` may be 'hot' (default homepage), 'top', 'new'. `t` is the
    time window for top ('day','week','month').
    """
    name = sub.strip().lstrip("/").removeprefix("r/").strip()
    if not name:
        return []
    sort = sort if sort in ("hot", "top", "new") else "hot"
    suffix = f"/{sort}/.json?limit={limit}"
    if sort == "top" and t:
        suffix += f"&t={t}"
    url = f"https://www.reddit.com/r/{url_quote(name)}{suffix}"
    items: list[dict] = []
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                url,
                headers={"User-Agent": _REDDIT_UA},
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status != 200:
                    logger.info("Reddit %s returned %d", name, resp.status)
                    return []
                data = await resp.json()
    except Exception as exc:
        logger.warning("Reddit fetch failed for %s: %s", name, exc)
        return []

    for child in (data.get("data", {}).get("children", []) or []):
        post = child.get("data", {}) or {}
        title = (post.get("title") or "").strip()
        if not title:
            continue
        body = (post.get("selftext") or "")[:1500]
        permalink = post.get("permalink") or ""
        items.append({
            "source": "reddit",
            "source_url": f"https://www.reddit.com{permalink}" if permalink else (post.get("url") or ""),
            "title": title,
            "description": body,
            "metadata": {
                "subreddit": post.get("subreddit"),
                "ups": post.get("ups", 0),
                "num_comments": post.get("num_comments", 0),
                "author": post.get("author"),
                "created_utc": post.get("created_utc"),
                "url": post.get("url"),
            },
        })
    return items


async def fetch_reddit_top_comments(permalink: str, limit: int = 12) -> list[str]:
    """Best-effort top-comment fetch for voice-mode extraction. Returns
    a list of comment bodies. Silent on failure."""
    if not permalink:
        return []
    url = f"https://www.reddit.com{permalink}.json?limit={limit}"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                url,
                headers={"User-Agent": _REDDIT_UA},
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status != 200:
                    return []
                data = await resp.json()
    except Exception:
        return []
    if not isinstance(data, list) or len(data) < 2:
        return []
    comments_listing = data[1].get("data", {}).get("children", []) or []
    out: list[str] = []
    for c in comments_listing[:limit]:
        body = (c.get("data") or {}).get("body") or ""
        if body and body != "[deleted]" and body != "[removed]":
            out.append(body[:1200])
    return out


# ══════════════════════════════════════════════════════════════════════
# Target-driven scrapers (route target.value → API call)
# ══════════════════════════════════════════════════════════════════════

async def scrape_for_target(target: dict) -> list[dict]:
    """Dispatch to the right per-source scraper based on a target row."""
    source = target["source"]
    t_type = target["target_type"]
    value = (target["value"] or "").strip()
    if not value:
        return []

    try:
        if source == "github":
            return await _scrape_github_target(t_type, value)
        if source == "reddit":
            return await _scrape_reddit_target(t_type, value)
        if source == "hackernews":
            return await _scrape_hackernews_target(t_type, value)
        if source == "producthunt":
            return await _scrape_producthunt_target(t_type, value)
        # x is intentionally not implemented — keyless scraping is unreliable.
        # The planner can still propose hashtags; we just won't scrape them.
        logger.info("No scraper for source=%s — skipping target %s", source, value)
        return []
    except Exception as exc:
        logger.warning("scrape_for_target failed (%s/%s/%s): %s", source, t_type, value, exc)
        return []


async def _scrape_github_target(target_type: str, value: str) -> list[dict]:
    """target_type = 'topic' (single GitHub topic), 'search_query', or 'trending'.

    Uses pushed:>since instead of created:>since so we catch actively
    maintained repos, not just brand-new ones (the latter rarely have
    enough stars to be interesting).
    """
    since = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
    if target_type == "topic":
        q = f"topic:{value} pushed:>{since} stars:>10"
    elif target_type == "search_query":
        q = f"{value} pushed:>{since} stars:>5"
    elif target_type == "trending":
        # Daily trending across the platform — sort by stars in last 24h.
        since_day = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
        q = f"created:>{since_day} stars:>5"
    else:
        return []
    url = (
        f"https://api.github.com/search/repositories?"
        f"q={url_quote(q)}&sort=stars&order=desc&per_page=20"
    )
    headers = {"Accept": "application/vnd.github.v3+json"}
    gh_token = await api_keys.resolve("github")
    if gh_token:
        headers["Authorization"] = f"token {gh_token}"

    items: list[dict] = []
    async with aiohttp.ClientSession() as session:
        try:
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                if resp.status != 200:
                    return []
                data = await resp.json()
                for repo in (data.get("items") or [])[:20]:
                    items.append({
                        "source": "github",
                        "source_url": repo["html_url"],
                        "title": repo["full_name"],
                        "description": repo.get("description") or "",
                        "metadata": {
                            "stars": repo.get("stargazers_count", 0),
                            "language": repo.get("language"),
                            "topics": repo.get("topics", []),
                            "created_at": repo.get("created_at"),
                            "forks": repo.get("forks_count", 0),
                            "matched_target": value,
                        },
                    })
        except Exception as exc:
            logger.debug("GitHub scrape failed: %s", exc)
    return items


async def _scrape_reddit_target(target_type: str, value: str) -> list[dict]:
    if target_type == "subreddit":
        return await scan_reddit_subreddit(value, limit=30, sort="hot")
    if target_type == "top_today":
        # Daily top of a subreddit — what the community ranked highest in 24h.
        return await scan_reddit_subreddit(value, limit=30, sort="top", t="day")
    if target_type == "search_query":
        url = (
            f"https://www.reddit.com/search.json?q={url_quote(value)}"
            f"&sort=new&t=week&limit=30"
        )
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url,
                    headers={"User-Agent": _REDDIT_UA},
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    if resp.status != 200:
                        return []
                    data = await resp.json()
        except Exception:
            return []
        items: list[dict] = []
        for child in (data.get("data", {}).get("children", []) or []):
            post = child.get("data", {}) or {}
            title = (post.get("title") or "").strip()
            if not title:
                continue
            permalink = post.get("permalink") or ""
            items.append({
                "source": "reddit",
                "source_url": f"https://www.reddit.com{permalink}" if permalink else (post.get("url") or ""),
                "title": title,
                "description": (post.get("selftext") or "")[:1500],
                "metadata": {
                    "subreddit": post.get("subreddit"),
                    "ups": post.get("ups", 0),
                    "num_comments": post.get("num_comments", 0),
                    "matched_target": value,
                },
            })
        return items
    return []


async def _scrape_hackernews_target(target_type: str, value: str) -> list[dict]:
    """HN scraping. 'search_query' uses Algolia. 'front_page' walks the
    Firebase topstories list (the actual HN homepage ranking) — this is
    how we surface the daily front-page intel.
    """
    if target_type == "front_page":
        return await _scrape_hn_front_page(limit=30)
    if target_type != "search_query":
        return []
    url = (
        f"http://hn.algolia.com/api/v1/search?query={url_quote(value)}"
        f"&tags=story&hitsPerPage=30"
    )
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                if resp.status != 200:
                    return []
                data = await resp.json()
    except Exception:
        return []
    items: list[dict] = []
    for hit in (data.get("hits") or [])[:30]:
        title = (hit.get("title") or hit.get("story_title") or "").strip()
        if not title:
            continue
        story_id = hit.get("objectID") or hit.get("story_id")
        permalink = f"https://news.ycombinator.com/item?id={story_id}" if story_id else None
        items.append({
            "source": "hackernews",
            "source_url": hit.get("url") or permalink or "",
            "title": title,
            "description": f"Score: {hit.get('points', 0)} | Comments: {hit.get('num_comments', 0)}",
            "metadata": {
                "hn_id": story_id,
                "hn_url": permalink,
                "score": hit.get("points", 0),
                "comments": hit.get("num_comments", 0),
                "by": hit.get("author"),
                "created_at_i": hit.get("created_at_i"),
                "matched_target": value,
            },
        })
    return items


async def _scrape_hn_front_page(limit: int = 30) -> list[dict]:
    """Pull the top N stories from HN's actual front-page ranking via
    the Firebase topstories endpoint. Each id is then hydrated.
    """
    items: list[dict] = []
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                "https://hacker-news.firebaseio.com/v0/topstories.json",
                timeout=aiohttp.ClientTimeout(total=20),
            ) as resp:
                if resp.status != 200:
                    return []
                ids = await resp.json()

            ids = (ids or [])[:limit]
            sem = asyncio.Semaphore(8)

            async def _fetch_one(story_id: int) -> dict | None:
                async with sem:
                    try:
                        async with session.get(
                            f"https://hacker-news.firebaseio.com/v0/item/{story_id}.json",
                            timeout=aiohttp.ClientTimeout(total=15),
                        ) as r:
                            if r.status != 200:
                                return None
                            return await r.json()
                    except Exception:
                        return None

            stories = await asyncio.gather(*[_fetch_one(i) for i in ids])
    except Exception as exc:
        logger.debug("HN front_page fetch failed: %s", exc)
        return []

    for story in stories:
        if not story or story.get("type") != "story":
            continue
        title = (story.get("title") or "").strip()
        if not title:
            continue
        story_id = story.get("id")
        permalink = f"https://news.ycombinator.com/item?id={story_id}" if story_id else None
        items.append({
            "source": "hackernews",
            "source_url": story.get("url") or permalink or "",
            "title": title,
            "description": f"Score: {story.get('score', 0)} | Comments: {story.get('descendants', 0)}",
            "metadata": {
                "hn_id": story_id,
                "hn_url": permalink,
                "score": story.get("score", 0),
                "comments": story.get("descendants", 0),
                "by": story.get("by"),
                "created_at_i": story.get("time"),
                "matched_target": "front_page",
            },
        })
    return items


_PH_EXTRACT_SYSTEM = (
    "You extract Product Hunt daily-leaderboard entries from cleaned page "
    "text. Return a JSON object {products:[{title, tagline, slug}]}. The "
    "slug is the URL-fragment after /posts/ (lowercase-hyphenated). Skip "
    "navigation/footer noise. Empty list is valid when nothing matches."
)


async def _scrape_ph_front_page(limit: int = 25) -> list[dict]:
    """Agentic scrape of Product Hunt's public daily leaderboard.

    PH has no keyless API for the daily leaderboard, so we fetch the page,
    feed the cleaned text to an LLM, and let it extract the list. We never
    regex-parse PH's HTML — markup churn would silently break us.
    """
    today = datetime.now(timezone.utc)
    url = f"https://www.producthunt.com/leaderboard/daily/{today.year}/{today.month}/{today.day}"
    page_text = await _extract_page_text(url, timeout=25)
    if not page_text or len(page_text) < 200:
        # Fall back to the existing DDG-search shim used elsewhere — also
        # agentic-friendly, no regex.
        return await observatory._scan_ph_search(["product hunt daily"])

    from llm_router import llm_call_json
    try:
        result = await llm_call_json(
            cli="claude",
            model="haiku",
            prompt=(
                f"## Page text (Product Hunt daily leaderboard {today:%Y-%m-%d})\n\n"
                f"{page_text[:6000]}\n\n## Output\n\n"
                "Return ONLY: {\"products\":[{\"title\":\"...\",\"tagline\":\"...\","
                "\"slug\":\"...\"}, ...]}"
            ),
            system=_PH_EXTRACT_SYSTEM,
            timeout=120,
        )
    except Exception as exc:
        logger.debug("PH front_page agentic extract failed: %s", exc)
        return []

    items: list[dict] = []
    for entry in (result.get("products") or [])[:limit]:
        title = (entry.get("title") or "").strip()
        slug = (entry.get("slug") or "").strip().strip("/")
        if not title or not slug:
            continue
        items.append({
            "source": "producthunt",
            "source_url": f"https://www.producthunt.com/posts/{slug}",
            "title": title,
            "description": (entry.get("tagline") or "").strip()
                or f"Daily Leaderboard {today:%Y-%m-%d}",
            "metadata": {
                "ph_slug": slug,
                "leaderboard_date": today.strftime("%Y-%m-%d"),
                "matched_target": "front_page",
            },
        })
    return items


async def _scrape_producthunt_target(target_type: str, value: str) -> list[dict]:
    """PH GraphQL search by topic; falls back to DDG search when no token."""
    if target_type == "front_page":
        return await _scrape_ph_front_page(limit=25)
    ph_token = await api_keys.resolve("producthunt")
    if ph_token and target_type in ("topic", "category"):
        query = """
        query($topic: String!) {
          posts(topic: $topic, order: VOTES, first: 20) {
            edges { node { id name tagline description url votesCount website
              topics { edges { node { name slug } } } } }
          }
        }
        """
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    "https://api.producthunt.com/v2/api/graphql",
                    json={"query": query, "variables": {"topic": value}},
                    headers={
                        "Authorization": f"Bearer {ph_token}",
                        "Content-Type": "application/json",
                    },
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    if resp.status != 200:
                        return []
                    data = await resp.json()
        except Exception:
            return []
        items: list[dict] = []
        for edge in ((data.get("data") or {}).get("posts", {}) or {}).get("edges", []) or []:
            node = edge["node"]
            topics = [t["node"]["name"] for t in (node.get("topics", {}).get("edges", []) or [])]
            items.append({
                "source": "producthunt",
                "source_url": node.get("url") or node.get("website") or "",
                "title": node.get("name") or "",
                "description": node.get("tagline") or node.get("description") or "",
                "metadata": {
                    "ph_id": node.get("id"),
                    "votes": node.get("votesCount", 0),
                    "topics": topics,
                    "website": node.get("website"),
                    "matched_target": value,
                },
            })
        return items

    # Fallback: search DuckDuckGo for site:producthunt.com matching value.
    return await observatory._scan_ph_search([value])


# ══════════════════════════════════════════════════════════════════════
# Page extraction (deep analysis input)
# ══════════════════════════════════════════════════════════════════════

async def _extract_page_text(url: str, timeout: int = 20) -> str:
    """Best-effort page extraction for deep analysis. Reuses
    deep_research/extract.py if importable, otherwise returns ''.
    Reddit URLs are skipped (we use top comments instead).
    """
    if not url:
        return ""
    if "reddit.com" in url:
        return ""
    try:
        from deep_research.extract import _fetch_html, _trafilatura_extract
        html = await _fetch_html(url, timeout=timeout)
        if not html:
            return ""
        text = _trafilatura_extract(html)
        return (text or "")[:8000]
    except Exception as exc:
        logger.debug("page extract failed %s: %s", url, exc)
        return ""


# ══════════════════════════════════════════════════════════════════════
# Deep analysis (profile-aware, page-aware)
# ══════════════════════════════════════════════════════════════════════

_ANALYZE_SYSTEM = (
    "You are the Observatory deep analyst. Given a project profile, an "
    "item scraped from one of GitHub / Reddit / Hacker News / Product "
    "Hunt, extracted page content, and the workspace's existing insights, "
    "produce a SPECIFIC verdict tied to this project. Name files in the "
    "repo when proposing integrations. Name features when proposing what "
    "to copy. Never produce generic 'this might be useful' prose. If the "
    "extracted content is thin, say so explicitly and downscore."
)


def _analyze_prompt(
    profile_prose: str,
    item: dict,
    page_text: str,
    insights: list[dict],
    triage_reason: str,
) -> str:
    insight_lines = "\n".join(
        f"- [{i['insight_type']}] {i['name']}: {i['summary']}"
        for i in insights[:30]
    ) or "(none yet)"
    meta = json.dumps(item.get("metadata", {}), indent=2)[:800]
    return f"""## Project profile

{profile_prose or '(no profile yet)'}

## Existing insights memory

{insight_lines}

## Item to analyze

- title: {item.get('title', '')}
- source: {item.get('source', '')}
- url: {item.get('source_url', '')}
- description: {item.get('description', '')}
- triage_reason: {triage_reason}
- metadata: {meta}

## Extracted page content (may be empty)

{page_text or '(no extraction available)'}

## Output

Return a JSON object:

  "relevance_score":  float 0..1 (be honest; thin content = lower)
  "category":         "integrate" | "steal" | "competitor"
  "proposal":         specific 2-4 sentences naming concrete files,
                      functions, or features in OUR project that this
                      affects. No generic prose.
  "steal_targets":    array of strings (1-3 specific features) — empty
                      unless category == 'steal' or competitor analysis
                      reveals copyable features.
  "tags":             array of 2-4 short strings.
  "competitor_name":  string (only if this names a competitor; '' otherwise)
  "files_to_touch":   array of strings (paths in OUR repo) — empty if N/A.

Return ONLY the JSON object."""


async def deep_analyze(
    workspace_id: str,
    item: dict,
    triage_reason: str = "",
) -> dict | None:
    """Profile-aware deep analysis with page extraction + insights memory."""
    from llm_router import llm_call_json

    profile_row = await observatory_profile.get_profile(workspace_id)
    profile_prose = observatory_profile.render_profile_prose(
        (profile_row or {}).get("profile", {})
    )
    insights = await list_insights(workspace_id)

    page_text = await _extract_page_text(item.get("source_url") or "")

    prompt = _analyze_prompt(profile_prose, item, page_text, insights, triage_reason)
    try:
        result = await llm_call_json(
            cli="claude", model="sonnet", prompt=prompt, system=_ANALYZE_SYSTEM, timeout=180
        )
    except Exception as exc:
        logger.warning("deep_analyze failed for %s: %s", item.get("title"), exc)
        return None

    score = result.get("relevance_score", 0)
    try:
        score = max(0.0, min(1.0, float(score)))
    except Exception:
        score = 0.0
    cat = result.get("category")
    if cat not in ("integrate", "steal", "competitor"):
        cat = "integrate"

    return {
        "relevance_score": score,
        "category": cat,
        "proposal": str(result.get("proposal", "")).strip(),
        "steal_targets": list(result.get("steal_targets") or []),
        "tags": list(result.get("tags") or []),
        "competitor_name": str(result.get("competitor_name", "")).strip(),
        "files_to_touch": list(result.get("files_to_touch") or []),
        "extracted_chars": len(page_text),
    }


# ══════════════════════════════════════════════════════════════════════
# Voice extraction (Reddit / HN community signal)
# ══════════════════════════════════════════════════════════════════════

_VOICE_SYSTEM = (
    "You are the Observatory voice-of-customer extractor. Given a "
    "project profile and a community thread (post + top comments), "
    "extract structured signal about what real users say. Be quote-faithful. "
    "Tie everything back to the profile — 'competitor' means OUR competitors, "
    "not random tools. Discard unrelated chatter."
)


def _voice_prompt(profile_prose: str, post: dict, comments: list[str]) -> str:
    comment_blob = "\n\n".join(f"- {c}" for c in comments) or "(no comments fetched)"
    return f"""## Project profile

{profile_prose}

## Community thread

- title: {post.get('title', '')}
- source: {post.get('source', '')}
- url: {post.get('source_url', '')}
- post body: {(post.get('description') or '')[:2000]}

### Top comments

{comment_blob}

## Output

Return a JSON object:

  "pain_points":         array of {{quote: str, summary: str}}
  "competitor_mentions": array of {{competitor: str, quote: str, sentiment: 'positive'|'negative'|'neutral'}}
  "feature_requests":    array of {{request: str, quote: str}}
  "notable_quotes":      array of strings (verbatim)
  "summary":             1-2 sentence prose summary of the thread vs profile

Return ONLY the JSON. Empty arrays are fine when no signal is present."""


async def voice_extract(workspace_id: str, item: dict) -> dict:
    from llm_router import llm_call_json

    profile_row = await observatory_profile.get_profile(workspace_id)
    profile_prose = observatory_profile.render_profile_prose(
        (profile_row or {}).get("profile", {})
    )

    comments: list[str] = []
    if item.get("source") == "reddit":
        permalink = (item.get("source_url") or "").replace("https://www.reddit.com", "")
        comments = await fetch_reddit_top_comments(permalink)
    elif item.get("source") == "hackernews":
        hn_id = (item.get("metadata") or {}).get("hn_id")
        if hn_id:
            comments = await _fetch_hn_top_comments(hn_id)

    prompt = _voice_prompt(profile_prose, item, comments)
    try:
        result = await llm_call_json(
            cli="claude", model="haiku", prompt=prompt, system=_VOICE_SYSTEM, timeout=180
        )
    except Exception as exc:
        logger.warning("voice_extract failed for %s: %s", item.get("title"), exc)
        return {}
    return {
        "pain_points": result.get("pain_points") or [],
        "competitor_mentions": result.get("competitor_mentions") or [],
        "feature_requests": result.get("feature_requests") or [],
        "notable_quotes": result.get("notable_quotes") or [],
        "summary": str(result.get("summary", "")),
    }


async def _fetch_hn_top_comments(hn_id: int, limit: int = 12) -> list[str]:
    """Pull top-level comment bodies from the HN Firebase API."""
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"https://hacker-news.firebaseio.com/v0/item/{hn_id}.json",
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                if resp.status != 200:
                    return []
                story = await resp.json()
            kid_ids = (story or {}).get("kids", [])[:limit]
            tasks = [
                session.get(
                    f"https://hacker-news.firebaseio.com/v0/item/{kid}.json",
                    timeout=aiohttp.ClientTimeout(total=10),
                )
                for kid in kid_ids
            ]
            comments: list[str] = []
            for fut in asyncio.as_completed([asyncio.ensure_future(t) for t in tasks]):
                try:
                    r = await fut
                    if r.status == 200:
                        c = await r.json()
                        text = (c or {}).get("text", "")
                        if text:
                            text_clean = re.sub(r"<[^>]+>", "", text).strip()
                            if text_clean:
                                comments.append(text_clean[:1200])
                except Exception:
                    pass
            return comments
    except Exception:
        return []


# ══════════════════════════════════════════════════════════════════════
# Insights memory (aggregation across findings)
# ══════════════════════════════════════════════════════════════════════

VALID_INSIGHT_TYPES = ("competitor", "pain_point", "feature_gap", "integration_done")


async def list_insights(workspace_id: str, insight_type: str | None = None) -> list[dict]:
    db = await get_db()
    try:
        if insight_type:
            cur = await db.execute(
                "SELECT * FROM observatory_insights WHERE workspace_id = ? AND insight_type = ? "
                "ORDER BY strength DESC, last_seen_at DESC",
                (workspace_id, insight_type),
            )
        else:
            cur = await db.execute(
                "SELECT * FROM observatory_insights WHERE workspace_id = ? "
                "ORDER BY strength DESC, last_seen_at DESC",
                (workspace_id,),
            )
        rows = await cur.fetchall()

        # Collect every distinct finding id referenced by any insight, then
        # hydrate them in a single round-trip. Avoids N+1 queries when the
        # workspace has many insights.
        all_ids: set[str] = set()
        parsed: list[tuple[dict, list[str]]] = []
        for r in rows:
            d = dict(r)
            try:
                ev = json.loads(d.get("evidence") or "[]")
                if not isinstance(ev, list):
                    ev = []
            except Exception:
                ev = []
            d["evidence"] = ev
            parsed.append((d, ev))
            all_ids.update(ev)

        finding_map: dict[str, dict] = {}
        if all_ids:
            placeholders = ",".join("?" * len(all_ids))
            cur = await db.execute(
                f"SELECT id, title, source, source_url, status, relevance_score "
                f"FROM observatory_findings WHERE id IN ({placeholders})",
                tuple(all_ids),
            )
            for r in await cur.fetchall():
                fr = dict(r)
                finding_map[fr["id"]] = fr
    finally:
        await db.close()

    out: list[dict] = []
    for d, ev in parsed:
        d["evidence_findings"] = [finding_map[fid] for fid in ev if fid in finding_map]
        out.append(d)
    return out


async def upsert_insight(
    workspace_id: str,
    insight_type: str,
    name: str,
    summary: str,
    evidence_finding_ids: list[str] | None = None,
    strength_delta: float = 0.1,
) -> dict:
    if insight_type not in VALID_INSIGHT_TYPES:
        raise ValueError(f"invalid insight_type: {insight_type}")
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT * FROM observatory_insights "
            "WHERE workspace_id = ? AND insight_type = ? AND name = ?",
            (workspace_id, insight_type, name),
        )
        existing = await cur.fetchone()

        if existing:
            try:
                ev = json.loads(existing["evidence"] or "[]")
            except Exception:
                ev = []
            ev = list(dict.fromkeys(ev + (evidence_finding_ids or [])))[:50]
            new_strength = min(1.0, (existing["strength"] or 0.5) + strength_delta)
            await db.execute(
                "UPDATE observatory_insights SET "
                "summary = ?, evidence = ?, strength = ?, "
                "last_seen_at = datetime('now'), updated_at = datetime('now') "
                "WHERE id = ?",
                (summary or existing["summary"], json.dumps(ev), new_strength, existing["id"]),
            )
            iid = existing["id"]
        else:
            iid = str(uuid.uuid4())
            await db.execute(
                "INSERT INTO observatory_insights "
                "(id, workspace_id, insight_type, name, summary, evidence, strength, last_seen_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
                (
                    iid, workspace_id, insight_type, name, summary,
                    json.dumps(evidence_finding_ids or []),
                    max(0.0, min(1.0, 0.4 + strength_delta)),
                ),
            )
        await db.commit()
        cur = await db.execute("SELECT * FROM observatory_insights WHERE id = ?", (iid,))
        row = await cur.fetchone()
    finally:
        await db.close()
    return dict(row) if row else {}


_MERGE_SYSTEM = (
    "You are the Observatory Insight Merger. Given a finding's analysis "
    "and the workspace's existing insights, decide which insights to "
    "create or update. Be conservative — only emit insights that are "
    "clearly supported. Use stable canonical names so future findings "
    "merge into the same insight (e.g. 'Cline', not 'cline.bot' one time "
    "and 'cline-extension' another)."
)


def _merge_prompt(finding: dict, analysis: dict, voice: dict, insights: list[dict]) -> str:
    insight_lines = "\n".join(
        f"- id={i['id']} type={i['insight_type']} name={i['name']!r} strength={i['strength']:.2f} :: {i['summary']}"
        for i in insights[:60]
    ) or "(none yet)"
    return f"""## Existing insights memory

{insight_lines}

## New finding

- title: {finding.get('title', '')}
- source: {finding.get('source', '')}
- url: {finding.get('source_url', '')}
- category: {analysis.get('category')}
- proposal: {analysis.get('proposal', '')}
- competitor_name: {analysis.get('competitor_name', '')}

## Voice signal (if any)

{json.dumps(voice, indent=2)[:2000] if voice else '(none)'}

## Output

Return a JSON object: {{"updates": [
  {{"action": "upsert" | "noop",
    "insight_type": "competitor" | "pain_point" | "feature_gap" | "integration_done",
    "name": "<canonical short name>",
    "summary": "<1-2 sentence prose>",
    "strength_delta": 0.05..0.25 }}
]}}

Rules:
  - Use existing names verbatim when proposing updates so they merge
    with prior evidence, instead of creating a duplicate.
  - 'integration_done' is for tools we ALREADY use (read from profile
    current_stack section) — emit so the scanner stops re-flagging them.
  - Most findings produce 0-2 insights. Quality > volume.

Return ONLY the JSON object."""


async def merge_insights_for_finding(
    workspace_id: str,
    finding: dict,
    analysis: dict,
    voice: dict | None,
) -> list[dict]:
    from llm_router import llm_call_json
    insights = await list_insights(workspace_id)

    prompt = _merge_prompt(finding, analysis, voice or {}, insights)
    try:
        result = await llm_call_json(
            cli="claude", model="haiku", prompt=prompt, system=_MERGE_SYSTEM, timeout=120
        )
    except Exception as exc:
        logger.warning("merge_insights_for_finding failed: %s", exc)
        return []

    applied: list[dict] = []
    for upd in (result.get("updates") or [])[:8]:
        if upd.get("action") != "upsert":
            continue
        try:
            row = await upsert_insight(
                workspace_id,
                upd.get("insight_type", ""),
                upd.get("name", "").strip(),
                upd.get("summary", "").strip(),
                evidence_finding_ids=[finding.get("id")] if finding.get("id") else None,
                strength_delta=float(upd.get("strength_delta", 0.1)),
            )
            if row:
                applied.append(row)
        except Exception as exc:
            logger.warning("Insight upsert failed: %s", exc)
    return applied


# ══════════════════════════════════════════════════════════════════════
# Orchestrator
# ══════════════════════════════════════════════════════════════════════

async def run_smart_scan(
    workspace_id: str,
    source: str,
) -> dict:
    """End-to-end scan for one source: plan → scrape per target → triage →
    deep analyze + voice + insights → persist findings. Returns summary.
    """
    if source not in observatory_profile.VALID_SOURCES:
        raise ValueError(f"invalid source: {source}")

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
        "smart": True,
    })

    summary = {
        "scan_id": scan_id, "source": source, "status": "running",
        "targets_scanned": 0, "items_scraped": 0, "items_triaged_in": 0,
        "findings_created": 0, "insights_touched": 0,
    }

    async def _progress(phase: str, **extra):
        """Emit a per-phase scan progress event for the live UI."""
        await bus.emit(CommanderEvent.OBSERVATORY_SCAN_PROGRESS, {
            "scan_id": scan_id, "source": source, "workspace_id": workspace_id,
            "phase": phase, **extra,
        })

    try:
        await _progress("plan")
        # 1. Plan: pick / propose / retire targets via LLM.
        plan = await observatory_profile.plan_targets(workspace_id, source)
        scan_target_ids = plan.get("to_scan_target_ids", []) or []

        # Load full target rows for scraping.
        targets_by_id: dict[str, dict] = {}
        if scan_target_ids:
            db = await get_db()
            try:
                placeholders = ",".join("?" * len(scan_target_ids))
                cur = await db.execute(
                    f"SELECT * FROM observatory_search_targets WHERE id IN ({placeholders})",
                    scan_target_ids,
                )
                for r in await cur.fetchall():
                    targets_by_id[r["id"]] = dict(r)
            finally:
                await db.close()

        await _progress("scrape", target_count=len(scan_target_ids))
        # 2. Scrape each target. Tag scraped items with their target_id.
        all_items: list[dict] = []
        for tid in scan_target_ids:
            tgt = targets_by_id.get(tid)
            if not tgt:
                continue
            items = await scrape_for_target(tgt)
            for it in items:
                it["_target_id"] = tid
            all_items.extend(items)
            summary["targets_scanned"] += 1
            await _progress(
                "scrape_target",
                target=tgt.get("value"),
                target_type=tgt.get("target_type"),
                items_found=len(items),
                progress=summary["targets_scanned"],
                total=len(scan_target_ids),
            )

        summary["items_scraped"] = len(all_items)

        # 3. Dedup against existing findings.
        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT source_url FROM observatory_findings WHERE workspace_id = ?",
                (workspace_id,),
            )
            existing_urls = {r["source_url"] for r in await cur.fetchall()}
        finally:
            await db.close()
        new_items = [i for i in all_items if i.get("source_url") and i["source_url"] not in existing_urls]

        # 4. Batched triage.
        await _progress("triage", new_items=len(new_items))
        triaged: list[dict] = []
        if new_items:
            triaged = await observatory_profile.triage_items(workspace_id, new_items)

        # Track yields per-target so we can update signal scores.
        target_hits: dict[str, int] = {}
        target_yields: dict[str, int] = {}
        for it in new_items:
            tid = it.get("_target_id")
            if tid:
                target_hits[tid] = target_hits.get(tid, 0) + 1

        # 5. Process per-verdict.
        kept = [it for it in triaged if it.get("verdict") != "skip"]
        await _progress("analyze", to_analyze=len(kept))
        for it in triaged:
            verdict = it.get("verdict", "skip")
            if verdict == "skip":
                continue

            # Voice extraction first if applicable
            voice: dict = {}
            if verdict in ("voice_only", "competitor_track") and it.get("source") in ("reddit", "hackernews"):
                voice = await voice_extract(workspace_id, it)

            analysis: dict | None = None
            if verdict in ("analyze", "competitor_track"):
                analysis = await deep_analyze(workspace_id, it, triage_reason=it.get("triage_reason", ""))
            elif verdict == "voice_only":
                # Synthesize a thin analysis from voice signal so it's still
                # filterable in the findings list.
                analysis = {
                    "relevance_score": 0.5 if voice else 0.3,
                    "category": "steal",
                    "proposal": (voice or {}).get("summary", ""),
                    "steal_targets": [r.get("request", "") for r in (voice.get("feature_requests") or [])[:3]],
                    "tags": ["voice"],
                    "competitor_name": "",
                    "files_to_touch": [],
                    "extracted_chars": 0,
                }

            if not analysis:
                continue

            score = analysis.get("relevance_score", 0)
            if score < 0.2:
                continue

            finding_id = str(uuid.uuid4())
            tid = it.get("_target_id")

            db = await get_db()
            try:
                await db.execute(
                    "INSERT INTO observatory_findings "
                    "(id, workspace_id, source, source_url, title, description, "
                    " category, relevance_score, proposal, steal_targets, tags, "
                    " status, metadata, scan_id, "
                    " verdict, triage_reason, voice, extracted_url, extracted_chars, target_id) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, "
                    "        ?, ?, ?, ?, ?, ?)",
                    (
                        finding_id, workspace_id, it["source"],
                        it.get("source_url", ""), it["title"], it.get("description", ""),
                        analysis["category"],
                        analysis["relevance_score"],
                        analysis["proposal"],
                        json.dumps(analysis.get("steal_targets", [])),
                        json.dumps(analysis.get("tags", [])),
                        json.dumps(it.get("metadata", {})),
                        scan_id,
                        verdict,
                        it.get("triage_reason", ""),
                        json.dumps(voice),
                        it.get("source_url", "") if analysis.get("extracted_chars", 0) else "",
                        analysis.get("extracted_chars", 0),
                        tid,
                    ),
                )
                await db.commit()
            finally:
                await db.close()

            summary["findings_created"] += 1
            if tid:
                target_yields[tid] = target_yields.get(tid, 0) + 1

            # Stream the finding to the panel so the Insights tab can populate
            # in real-time rather than waiting for SCAN_COMPLETED.
            await bus.emit(CommanderEvent.OBSERVATORY_FINDING_CREATED, {
                "finding_id": finding_id, "scan_id": scan_id,
                "workspace_id": workspace_id, "source": it["source"],
                "title": it["title"], "category": analysis["category"],
                "relevance_score": analysis["relevance_score"],
            })

            # 6. Insight merge (only on findings that survived deep analysis)
            if score >= 0.4:
                finding_payload = {**it, "id": finding_id}
                applied = await merge_insights_for_finding(
                    workspace_id, finding_payload, analysis, voice
                )
                summary["insights_touched"] += len(applied)

        # 7. Update target signal scores
        for tid in scan_target_ids:
            await observatory_profile.record_target_scan(
                tid, target_hits.get(tid, 0), target_yields.get(tid, 0)
            )

        # 8. Mark scan complete
        db = await get_db()
        try:
            await db.execute(
                "UPDATE observatory_scans SET status = 'completed', findings_count = ?, "
                "completed_at = datetime('now') WHERE id = ?",
                (summary["findings_created"], scan_id),
            )
            await db.commit()
        finally:
            await db.close()

        await bus.emit(CommanderEvent.OBSERVATORY_SCAN_COMPLETED, {
            "scan_id": scan_id, "source": source,
            "findings_count": summary["findings_created"],
            "total_scraped": summary["items_scraped"],
            "workspace_id": workspace_id,
            "smart": True,
        })

        summary["status"] = "completed"
        summary["plan"] = {
            "added": [t["value"] for t in plan.get("added", [])],
            "retired": [r["id"] for r in plan.get("retired", [])],
        }
        # Count voice-only findings
        summary["items_triaged_in"] = sum(
            1 for t in triaged if t.get("verdict") in ("analyze", "voice_only", "competitor_track")
        )
        return summary

    except Exception as exc:
        logger.exception("smart scan failed")
        db = await get_db()
        try:
            await db.execute(
                "UPDATE observatory_scans SET status = 'failed', error = ?, "
                "completed_at = datetime('now') WHERE id = ?",
                (str(exc), scan_id),
            )
            await db.commit()
        finally:
            await db.close()
        summary["status"] = "failed"
        summary["error"] = str(exc)
        return summary
