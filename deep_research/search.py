"""Multi-source search with Reciprocal Rank Fusion.

Providers (all free or self-hosted):
  - DuckDuckGo    — no API key, best general web coverage
  - Brave Search  — free tier 2000 queries/month, excellent quality
  - arXiv         — free, unlimited, academic papers
  - Semantic Scholar — free, academic graph with citations
  - GitHub        — code/repo search, optional token for rate limits
  - SearXNG       — self-hosted meta-search across 70+ engines
"""

import asyncio
import logging
import re
import xml.etree.ElementTree as ET
from abc import ABC, abstractmethod
from dataclasses import dataclass
from urllib.parse import quote_plus

import aiohttp

logger = logging.getLogger(__name__)


class SearchUnavailable(RuntimeError):
    """One provider could not answer — a transport error or a non-2xx response.

    This exists because every provider used to swallow its own failure and return
    ``[]``. An empty list is indistinguishable from "nothing matched", so a total
    search outage looked like a query with no hits: the round found nothing, the
    loop stopped, and the run synthesised zero findings and reported SUCCESS. A
    caller cannot tell "the web has no answer" from "we never asked anyone".

    Not configured and not installed still return ``[]`` — that is absence, not
    failure, and ``available()`` already filters those providers out.
    """


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str
    source: str
    score: float = 0.0


class SearchProvider(ABC):
    name: str = "base"

    @abstractmethod
    async def search(self, query: str, max_results: int = 10) -> list[SearchResult]:
        ...

    def available(self) -> bool:
        """Can this provider return anything at all?

        A missing package or key used to mean the provider silently returned []
        on every query while still being listed as active — which reads as full
        coverage when it is nothing of the sort.
        """
        return True


def _strip_html(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text or "").replace("&#x27;", "'").replace("&gt;", ">").replace("&lt;", "<").replace("&amp;", "&").strip()


# ── DuckDuckGo ─────────────────────────────────────────────────────


class DuckDuckGoSearch(SearchProvider):
    """Free web search. Install `pip install duckduckgo-search` for best results."""

    name = "duckduckgo"

    def available(self) -> bool:
        try:
            import ddgs  # noqa: F401
            return True
        except ImportError:
            try:
                import duckduckgo_search  # noqa: F401
                return True
            except ImportError:
                return False

    async def search(self, query: str, max_results: int = 10) -> list[SearchResult]:
        try:
            # Package renamed: duckduckgo-search → ddgs (try both)
            try:
                from ddgs import DDGS
            except ImportError:
                from duckduckgo_search import DDGS

            import asyncio
            loop = asyncio.get_event_loop()
            raw = await loop.run_in_executor(
                None, lambda: DDGS().text(query, max_results=max_results)
            )
            return [
                SearchResult(
                    title=r.get("title", ""),
                    url=r.get("href", ""),
                    snippet=r.get("body", ""),
                    source=self.name,
                )
                for r in raw
            ]
        except ImportError:
            logger.info("ddgs/duckduckgo-search not installed — skipping DDG")
            return []
        except Exception as e:
            raise SearchUnavailable(f"{self.name}: {e}") from e


# ── Brave Search ───────────────────────────────────────────────────


class BraveSearch(SearchProvider):
    """Free tier: 2000 queries/month. https://brave.com/search/api/"""

    name = "brave"

    def __init__(self, api_key: str | None):
        self.api_key = api_key

    def available(self) -> bool:
        return bool(self.api_key)

    async def search(self, query: str, max_results: int = 10) -> list[SearchResult]:
        if not self.api_key:
            return []
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    "https://api.search.brave.com/res/v1/web/search",
                    params={"q": query, "count": min(max_results, 20)},
                    headers={
                        "X-Subscription-Token": self.api_key,
                        "Accept": "application/json",
                    },
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    if resp.status != 200:
                        raise SearchUnavailable(
                            f"{self.name} HTTP {resp.status}")
                    data = await resp.json()
            return [
                SearchResult(
                    title=r.get("title", ""),
                    url=r.get("url", ""),
                    snippet=r.get("description", ""),
                    source=self.name,
                )
                for r in data.get("web", {}).get("results", [])
            ]
        except Exception as e:
            raise SearchUnavailable(f"{self.name}: {e}") from e


# ── arXiv ──────────────────────────────────────────────────────────


class ArxivSearch(SearchProvider):
    """Free, no key. Best for academic papers."""

    name = "arxiv"

    async def search(self, query: str, max_results: int = 10) -> list[SearchResult]:
        try:
            url = (
                f"http://export.arxiv.org/api/query"
                f"?search_query=all:{quote_plus(query)}"
                f"&max_results={max_results}"
                f"&sortBy=relevance&sortOrder=descending"
            )
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url, timeout=aiohttp.ClientTimeout(total=20)
                ) as resp:
                    if resp.status != 200:
                        raise SearchUnavailable(
                            f"{self.name} HTTP {resp.status}")
                    text = await resp.text()

            ns = {"atom": "http://www.w3.org/2005/Atom"}
            root = ET.fromstring(text)
            results: list[SearchResult] = []
            for entry in root.findall("atom:entry", ns):
                t = entry.find("atom:title", ns)
                s = entry.find("atom:summary", ns)
                i = entry.find("atom:id", ns)
                title = t.text.strip().replace("\n", " ") if t is not None and t.text else ""
                abstract = s.text.strip()[:500] if s is not None and s.text else ""
                paper_url = i.text.strip() if i is not None and i.text else ""
                if title and paper_url:
                    results.append(SearchResult(title=title, url=paper_url, snippet=abstract, source=self.name))
            return results
        except Exception as e:
            raise SearchUnavailable(f"{self.name}: {e}") from e


# ── Semantic Scholar ───────────────────────────────────────────────


class SemanticScholarSearch(SearchProvider):
    """Free API, rate-limited (~100 req / 5 min)."""

    name = "semantic_scholar"

    async def search(self, query: str, max_results: int = 10) -> list[SearchResult]:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    "https://api.semanticscholar.org/graph/v1/paper/search",
                    params={
                        "query": query,
                        "limit": min(max_results, 20),
                        "fields": "title,abstract,url,year,citationCount",
                    },
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    if resp.status != 200:
                        raise SearchUnavailable(
                            f"{self.name} HTTP {resp.status}")
                    data = await resp.json()
            results: list[SearchResult] = []
            for paper in data.get("data", []):
                paper_url = paper.get("url") or f"https://www.semanticscholar.org/paper/{paper.get('paperId', '')}"
                abstract = paper.get("abstract") or ""
                snippet = abstract[:500] if abstract else f"Year: {paper.get('year', '?')}, Citations: {paper.get('citationCount', 0)}"
                results.append(SearchResult(title=paper.get("title", ""), url=paper_url, snippet=snippet, source=self.name))
            return results
        except Exception as e:
            raise SearchUnavailable(f"{self.name}: {e}") from e


# ── GitHub ─────────────────────────────────────────────────────────


class GitHubSearch(SearchProvider):
    """Repo search. Optional token for higher rate limits."""

    name = "github"

    def __init__(self, token: str | None = None):
        self.token = token

    async def search(self, query: str, max_results: int = 10) -> list[SearchResult]:
        try:
            headers = {"Accept": "application/vnd.github.v3+json"}
            if self.token:
                headers["Authorization"] = f"token {self.token}"
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    "https://api.github.com/search/repositories",
                    params={"q": query, "per_page": min(max_results, 30), "sort": "stars"},
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    if resp.status != 200:
                        raise SearchUnavailable(
                            f"{self.name} HTTP {resp.status}")
                    data = await resp.json()
            return [
                SearchResult(
                    title=r.get("full_name", ""),
                    url=r.get("html_url", ""),
                    snippet=r.get("description", "") or f"Stars: {r.get('stargazers_count', 0)}",
                    source=self.name,
                )
                for r in data.get("items", [])
            ]
        except Exception as e:
            raise SearchUnavailable(f"{self.name}: {e}") from e


# ── Hacker News (Algolia index) ────────────────────────────────────


class HackerNewsSearch(SearchProvider):
    """Stories and comments via Algolia's HN index. No API key needed.

    The comments are the point: practitioner opinion on tooling that never
    makes it into a paper or a repo README.
    """

    name = "hackernews"

    async def search(self, query: str, max_results: int = 10) -> list[SearchResult]:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    "https://hn.algolia.com/api/v1/search",
                    params={
                        "query": query,
                        "tags": "(story,comment)",
                        "hitsPerPage": min(max_results, 50),
                    },
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    if resp.status != 200:
                        raise SearchUnavailable(
                            f"{self.name} HTTP {resp.status}")
                    data = await resp.json()
        except Exception as e:
            raise SearchUnavailable(f"{self.name}: {e}") from e

        results = []
        for hit in data.get("hits", []):
            discussion = f"https://news.ycombinator.com/item?id={hit.get('objectID', '')}"
            if hit.get("title"):
                title = hit["title"]
                url = hit.get("url") or discussion
                snippet = (
                    f"{hit.get('points') or 0} points, "
                    f"{hit.get('num_comments') or 0} comments on Hacker News"
                )
            else:
                # A comment: the text is the payload, the thread is the link.
                title = f"HN comment on: {hit.get('story_title') or 'unknown thread'}"
                url = discussion
                snippet = _strip_html(hit.get("comment_text", ""))[:400]
            if url:
                results.append(
                    SearchResult(title=title, url=url, snippet=snippet, source=self.name)
                )
        return results


# ── GitHub issues & PR discussions ─────────────────────────────────


class GitHubIssuesSearch(SearchProvider):
    """Issue/PR threads — where friction with a tool is actually written down.

    Repo search finds the project; this finds what people complain about in it.
    Unauthenticated works but is rate-limited hard; a token lifts that.
    """

    name = "github_issues"

    def __init__(self, token: str | None = None):
        self.token = token

    async def search(self, query: str, max_results: int = 10) -> list[SearchResult]:
        try:
            headers = {"Accept": "application/vnd.github.v3+json"}
            if self.token:
                headers["Authorization"] = f"token {self.token}"
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    "https://api.github.com/search/issues",
                    params={
                        "q": query,
                        "per_page": min(max_results, 30),
                        "sort": "updated",
                        "order": "desc",
                    },
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    if resp.status != 200:
                        if resp.status in (403, 429):
                            logger.info("GitHub issues rate-limited — set GITHUB_TOKEN")
                        raise SearchUnavailable(
                            f"{self.name} HTTP {resp.status}")
                    data = await resp.json()
        except Exception as e:
            raise SearchUnavailable(f"{self.name}: {e}") from e

        results = []
        for r in data.get("items", []):
            body = (r.get("body") or "").strip().replace("\r\n", " ")
            state = r.get("state", "")
            comments = r.get("comments", 0)
            snippet = body[:300] if body else f"{state}, {comments} comments"
            results.append(
                SearchResult(
                    title=r.get("title", ""),
                    url=r.get("html_url", ""),
                    snippet=f"[{state}, {comments} comments] {snippet}",
                    source=self.name,
                )
            )
        return results


# ── SearXNG (self-hosted meta-search) ─────────────────────────────


class SearXNGSearch(SearchProvider):
    """Self-hosted meta-search. Deploy: docker run -p 8888:8080 searxng/searxng"""

    name = "searxng"

    def __init__(self, base_url: str | None):
        self.base_url = base_url.rstrip("/") if base_url else None

    def available(self) -> bool:
        return bool(self.base_url)

    async def search(self, query: str, max_results: int = 10) -> list[SearchResult]:
        if not self.base_url:
            return []
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{self.base_url}/search",
                    params={"q": query, "format": "json", "pageno": 1},
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    if resp.status != 200:
                        raise SearchUnavailable(
                            f"{self.name} HTTP {resp.status}")
                    data = await resp.json()
            return [
                SearchResult(title=r.get("title", ""), url=r.get("url", ""), snippet=r.get("content", ""), source=self.name)
                for r in data.get("results", [])[:max_results]
            ]
        except Exception as e:
            raise SearchUnavailable(f"{self.name}: {e}") from e


# ── RRF Fusion ─────────────────────────────────────────────────────


def rrf_fuse(result_lists: list[list[SearchResult]], k: int = 60) -> list[SearchResult]:
    """Reciprocal Rank Fusion — results appearing in multiple sources get boosted."""
    url_scores: dict[str, float] = {}
    url_to_result: dict[str, SearchResult] = {}
    for results in result_lists:
        for rank, result in enumerate(results):
            url = result.url
            if url not in url_to_result:
                url_to_result[url] = result
            url_scores[url] = url_scores.get(url, 0.0) + 1.0 / (k + rank + 1)
    fused = []
    for url in sorted(url_scores, key=lambda u: url_scores[u], reverse=True):
        r = url_to_result[url]
        r.score = url_scores[url]
        fused.append(r)
    return fused


# ── Multi-source orchestrator ──────────────────────────────────────


class MultiSearch:
    """Parallel search across all configured providers with RRF fusion."""

    def __init__(self, providers: list[SearchProvider]):
        candidates = [p for p in providers if p is not None]
        self.providers = [p for p in candidates if p.available()]
        skipped = [p.name for p in candidates if not p.available()]
        if skipped:
            logger.info("Search providers unavailable (skipped): %s", ", ".join(skipped))
        if not self.providers:
            raise ValueError("At least one search provider must be configured")
        # Only providers that can actually answer — this string is reported to
        # the user and ends up in the report header.
        self.active_names = [p.name for p in self.providers]
        # Outage bookkeeping. A round where EVERY provider failed is NOT "no
        # results" — nobody was successfully asked. Keeping the two apart is the
        # whole point of SearchUnavailable; these counters carry it to the caller.
        self.outages: list[tuple[str, str]] = []
        self.blackouts = 0
        self.last_round_blackout = False

    async def search(self, query: str, max_per_source: int = 10) -> list[SearchResult]:
        tasks = [p.search(query, max_per_source) for p in self.providers]
        raw = await asyncio.gather(*tasks, return_exceptions=True)
        valid: list[list[SearchResult]] = []
        counts: dict[str, int] = {}
        failed: list[tuple[str, str]] = []
        for i, r in enumerate(raw):
            name = self.providers[i].name
            if isinstance(r, BaseException):
                failed.append((name, str(r)[:200]))
                logger.warning("%s error: %s", name, r)
            elif r:
                valid.append(r)
                counts[name] = len(r)
        if counts:
            logger.info("Search results: %s", ", ".join(f"{k}={v}" for k, v in counts.items()))
        if failed:
            self.outages.extend(failed)
        # BLACKOUT: every configured provider failed, so this query consulted
        # nothing at all. Returning [] here is honest as a RESULT, but the caller
        # must be able to see that it means "search is down", not "no matches".
        if failed and len(failed) == len(self.providers):
            self.blackouts += 1
            logger.error("Search blackout for %r — all %d providers failed",
                         query, len(self.providers))
        return rrf_fuse(valid) if valid else []

    async def search_many(self, queries: list[str], max_per_source: int = 10) -> list[SearchResult]:
        """Search multiple queries, deduplicate by URL, keep highest score."""
        before = self.blackouts
        tasks = [self.search(q, max_per_source) for q in queries]
        all_results = await asyncio.gather(*tasks)
        # True only when EVERY query in this round hit a total outage — the case a
        # caller must not read as "nothing new left to find".
        self.last_round_blackout = (
            bool(queries) and (self.blackouts - before) == len(queries))
        seen: dict[str, SearchResult] = {}
        for results in all_results:
            for r in results:
                if r.url not in seen or r.score > seen[r.url].score:
                    seen[r.url] = r
        return sorted(seen.values(), key=lambda r: r.score, reverse=True)


def build_search(config) -> MultiSearch:
    """Build MultiSearch from config, enabling all available providers."""
    return MultiSearch([
        DuckDuckGoSearch(),
        ArxivSearch(),
        SemanticScholarSearch(),
        GitHubSearch(token=config.github_token),
        GitHubIssuesSearch(token=config.github_token),
        HackerNewsSearch(),
        BraveSearch(api_key=config.brave_api_key),
        SearXNGSearch(base_url=config.searxng_url),
    ])
