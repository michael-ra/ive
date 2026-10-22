"""Gatherer — search + extract only, zero LLM calls.

This is the key module for hybrid orchestration:
  - Claude/Gemini = brain (thinking, cross-domain, planning)
  - Gatherer = hands (searching, fetching, extracting)

The brain decides WHAT to search. The gatherer does it fast and cheap.
Results come back as structured JSON for the brain to reason over.

Usage:
    # From CLI
    deep-research gather -q "query1" "query2" -o research/topic/round-1.json

    # From Python
    results = await gather(["query1", "query2"], output_path, config)

    # From Claude Code skill
    # Claude reads results, thinks, writes new queries, calls gather again
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path

from .config import DeepResearchConfig
from .extract import extract_multiple
from .search import MultiSearch, build_search

logger = logging.getLogger(__name__)


async def gather(
    queries: list[str],
    config: DeepResearchConfig | None = None,
    search: MultiSearch | None = None,
    max_extract: int = 15,
    output_path: Path | str | None = None,
) -> dict:
    """Search + extract content for given queries. No LLM calls.

    Args:
        queries: Search queries to run across all providers
        config: Config (uses env defaults if None)
        search: Pre-built MultiSearch (builds from config if None)
        max_extract: Max URLs to fetch full content from
        output_path: If provided, writes JSON results to this path

    Returns:
        Dict with: queries, results (with content), stats
    """
    config = config or DeepResearchConfig.from_env()
    search = search or build_search(config)
    start = time.time()

    # Search all queries across all providers with RRF fusion
    logger.info("Gathering: %d queries across %s", len(queries), ", ".join(search.active_names))
    all_results = await search.search_many(queries, config.max_results_per_source)
    logger.info("Search returned %d unique results", len(all_results))

    # Extract full content from top URLs
    top_urls = [r.url for r in all_results[:max_extract]]
    contents = await extract_multiple(top_urls)
    logger.info("Extracted %d/%d pages", len(contents), len(top_urls))

    # Build structured output
    output = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "queries": queries,
        "search_engines": search.active_names,
        "stats": {
            "total_results": len(all_results),
            "extracted": len(contents),
            "elapsed_seconds": round(time.time() - start, 1),
        },
        "results": [
            {
                "rank": i + 1,
                "title": r.title,
                "url": r.url,
                "snippet": r.snippet,
                "source_engine": r.source,
                "rrf_score": round(r.score, 6),
                "content": contents.get(r.url),  # None if not extracted
                "has_content": r.url in contents,
            }
            for i, r in enumerate(all_results)
        ],
    }

    if output_path:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(
            json.dumps(output, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        logger.info("Results written to %s", output_path)

    return output


async def gather_round(
    queries: list[str],
    topic_dir: Path | str,
    round_num: int,
    config: DeepResearchConfig | None = None,
) -> dict:
    """Run one gather round, saving to topic_dir/round-{N}.json.

    Designed for the skill orchestration loop:
      round 1 → round-1.json
      round 2 → round-2.json
      ...
    """
    topic_dir = Path(topic_dir)
    output_path = topic_dir / f"round-{round_num}.json"
    return await gather(queries, config=config, output_path=output_path)


def summarize_results(results: dict, top_n: int = 20) -> str:
    """Format gather results as compact markdown for the brain (Claude/Gemini).

    This is what gets fed into the thinking model's context —
    compact enough to fit, rich enough to reason over.
    """
    lines = [
        f"# Gathered Results — {results['timestamp']}",
        f"Queries: {', '.join(results['queries'])}",
        f"Stats: {results['stats']['total_results']} results, "
        f"{results['stats']['extracted']} extracted, "
        f"{results['stats']['elapsed_seconds']}s",
        "",
    ]

    for r in results["results"][:top_n]:
        lines.append(f"## [{r['rank']}] {r['title']}")
        lines.append(f"Source: {r['source_engine']} | URL: {r['url']}")
        lines.append(f"RRF: {r['rrf_score']:.4f}")
        if r.get("content"):
            # Truncate content for brain consumption
            content = r["content"][:2000]
            lines.append(f"\n{content}\n")
        else:
            lines.append(f"Snippet: {r['snippet']}\n")
        lines.append("---\n")

    return "\n".join(lines)
