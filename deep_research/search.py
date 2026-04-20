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


# ── DuckDuckGo ─────────────────────────────────────────────────────


class DuckDuckGoSearch(SearchProvider):
    """Free web search. Install `pip install duckduckgo-search` for best results."""

    name = "duckduckgo"

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
            logger.warning("DDG search failed: %s", e)
            return []


# ── Brave Search ───────────────────────────────────────────────────


class BraveSearch(SearchProvider):
    """Free tier: 2000 queries/month. https://brave.com/search/api/"""

    name = "brave"

    def __init__(self, api_key: str | None):
        self.api_key = api_key

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
                        return []
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
            logger.warning("Brave search failed: %s", e)
            return []


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
                        return []
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
            logger.warning("arXiv search failed: %s", e)
            return []


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
                        return []
                    data = await resp.json()
            results: list[SearchResult] = []
            for paper in data.get("data", []):
                paper_url = paper.get("url") or f"https://www.semanticscholar.org/paper/{paper.get('paperId', '')}"
                abstract = paper.get("abstract") or ""
                snippet = abstract[:500] if abstract else f"Year: {paper.get('year', '?')}, Citations: {paper.get('citationCount', 0)}"
                results.append(SearchResult(title=paper.get("title", ""), url=paper_url, snippet=snippet, source=self.name))
            return results
        except Exception as e:
            logger.warning("Semantic Scholar failed: %s", e)
            return []


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
                        return []
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
            logger.warning("GitHub search failed: %s", e)
            return []


# ── SearXNG (self-hosted meta-search) ─────────────────────────────


class SearXNGSearch(SearchProvider):
    """Self-hosted meta-search. Deploy: docker run -p 8888:8080 searxng/searxng"""

    name = "searxng"

    def __init__(self, base_url: str | None):
        self.base_url = base_url.rstrip("/") if base_url else None

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
                        return []
                    data = await resp.json()
            return [
                SearchResult(title=r.get("title", ""), url=r.get("url", ""), snippet=r.get("content", ""), source=self.name)
                for r in data.get("results", [])[:max_results]
            ]
        except Exception as e:
            logger.warning("SearXNG search failed: %s", e)
            return []


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
        self.providers = [p for p in providers if p is not None]
        if not self.providers:
            raise ValueError("At least one search provider must be configured")
        self.active_names = [p.name for p in self.providers]

    async def search(self, query: str, max_per_source: int = 10) -> list[SearchResult]:
        tasks = [p.search(query, max_per_source) for p in self.providers]
        raw = await asyncio.gather(*tasks, return_exceptions=True)
        valid: list[list[SearchResult]] = []
        counts: dict[str, int] = {}
        for i, r in enumerate(raw):
            if isinstance(r, Exception):
                logger.warning("%s error: %s", self.providers[i].name, r)
            elif r:
                valid.append(r)
                counts[self.providers[i].name] = len(r)
        if counts:
            logger.info("Search results: %s", ", ".join(f"{k}={v}" for k, v in counts.items()))
        return rrf_fuse(valid) if valid else []

    async def search_many(self, queries: list[str], max_per_source: int = 10) -> list[SearchResult]:
        """Search multiple queries, deduplicate by URL, keep highest score."""
        tasks = [self.search(q, max_per_source) for q in queries]
        all_results = await asyncio.gather(*tasks)
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
        BraveSearch(api_key=config.brave_api_key),
        SearXNGSearch(base_url=config.searxng_url),
    ])
