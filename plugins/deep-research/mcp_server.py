#!/usr/bin/env python3
"""Deep Research MCP Server — exposes search, extract, and gather tools.

Wraps deep_research/search.py, extract.py, and gatherer.py as MCP tools
so any CLI agent (Claude Code, Gemini) can do multi-engine iterative research
natively. Communicates with Commander's Research DB via REST API.

Stdio JSON-RPC 2.0 (MCP protocol).
Zero external dependencies beyond what deep_research already requires.
"""

import asyncio
import json
import logging
import os
import sys
import urllib.request
import urllib.error

# Add project root to path so we can import deep_research
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _PROJECT_ROOT)

import re as _re
from datetime import datetime as _dt

from deep_research.config import DeepResearchConfig
from deep_research.search import build_search, SearchResult
from deep_research.extract import extract_multiple
from deep_research.gatherer import gather, summarize_results


# ── Recency boost ─────────────────────────────────────────────

_YEAR_RE = _re.compile(r'\b20[0-9]{2}\b')
_RECENCY_RE = _re.compile(
    r'\b(latest|recent|newest|new|current|state.of.the.art|sota|cutting.edge)\b',
    _re.IGNORECASE,
)


def _add_recency_queries(queries: list[str], include_recent: bool = True) -> list[str]:
    """Auto-inject recency-boosted variants for queries that lack temporal terms.

    For each query without an explicit year or recency keyword, appends:
      - year-qualified variants (current + previous year)
      - a "latest/recent" variant to catch evergreen recency signals

    RRF fusion naturally boosts results that appear across both the
    dated and undated searches.
    """
    if not include_recent:
        return queries

    current_year = _dt.now().year
    prev_year = current_year - 1
    extra = []
    for q in queries:
        has_year = bool(_YEAR_RE.search(q))
        has_recency = bool(_RECENCY_RE.search(q))
        if not has_year and not has_recency:
            extra.append(f"{q} {current_year}")
            extra.append(f"{q} {prev_year}")
            extra.append(f"latest {q}")
        elif not has_year:
            # Has recency words but no year — add year variants only
            extra.append(f"{q} {current_year}")
    return queries + extra

log = logging.getLogger("deep-research-mcp")

# ── Config ────────────────────────────────────────────────────────

API_URL = os.environ.get("COMMANDER_API_URL", "http://127.0.0.1:5111")
WORKSPACE_ID = os.environ.get("COMMANDER_WORKSPACE_ID", "")


def _build_config() -> DeepResearchConfig:
    """Build research config from environment."""
    return DeepResearchConfig.from_env()


# ── Commander REST API ────────────────────────────────────────────

def _api_call(method: str, path: str, body: dict | None = None) -> dict | list:
    """Call Commander REST API."""
    url = f"{API_URL}/api{path}"
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"} if body else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": e.read().decode(), "status": e.code}
    except Exception as e:
        return {"error": str(e)}


# ── Tool implementations ─────────────────────────────────────────

def tool_multi_search(args: dict) -> str:
    """Search across multiple engines simultaneously."""
    queries = args.get("queries", [])
    if isinstance(queries, str):
        queries = [queries]
    if not queries:
        return json.dumps({"error": "queries required (string or array)"})

    max_per_source = args.get("max_results_per_source", 8)
    include_recent = args.get("include_recent", True)

    # Auto-inject year-qualified variants for recency
    all_queries = _add_recency_queries(queries, include_recent)

    async def _run():
        config = _build_config()
        search = build_search(config)
        results: list[SearchResult] = await search.search_many(all_queries, max_per_source=max_per_source)
        return [
            {
                "title": r.title,
                "url": r.url,
                "snippet": r.snippet,
                "source": r.source,
                "score": round(r.score, 4),
            }
            for r in results
        ]

    try:
        results = asyncio.run(_run())
        return json.dumps({
            "total": len(results),
            "queries": queries,
            "queries_with_recency": all_queries,
            "results": results,
        }, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


def tool_extract_pages(args: dict) -> str:
    """Extract clean text content from web pages."""
    urls = args.get("urls", [])
    if isinstance(urls, str):
        urls = [urls]
    if not urls:
        return json.dumps({"error": "urls required (string or array)"})

    max_concurrent = args.get("max_concurrent", 8)

    try:
        extracted = asyncio.run(extract_multiple(urls, max_concurrent=max_concurrent))
        # Truncate very long content per page
        max_chars = args.get("max_chars_per_page", 12000)
        trimmed = {}
        for url, content in extracted.items():
            if len(content) > max_chars:
                trimmed[url] = content[:max_chars] + f"\n\n[...truncated, {len(content)} total chars]"
            else:
                trimmed[url] = content

        return json.dumps({
            "extracted": len(trimmed),
            "requested": len(urls),
            "pages": trimmed,
        }, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


def tool_gather(args: dict) -> str:
    """Combined search + extract: search multiple engines, fetch top results."""
    queries = args.get("queries", [])
    if isinstance(queries, str):
        queries = [queries]
    if not queries:
        return json.dumps({"error": "queries required (string or array)"})

    max_extract = args.get("max_extract", 10)
    include_recent = args.get("include_recent", True)

    # Auto-inject year-qualified variants for recency
    all_queries = _add_recency_queries(queries, include_recent)

    try:
        config = _build_config()
        result = asyncio.run(gather(all_queries, config=config, max_extract=max_extract))
        # Return the markdown summary (more useful to the agent than raw JSON)
        summary = summarize_results(result, top_n=15)
        return json.dumps({
            "stats": result.get("stats", {}),
            "queries": queries,
            "engines": result.get("search_engines", []),
            "summary": summary,
        }, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


def tool_save_research(args: dict) -> str:
    """Save a research finding to Commander's Research DB."""
    topic = args.get("topic", "").strip()
    if not topic:
        return json.dumps({"error": "topic required"})

    content = args.get("content", "")
    sources = args.get("sources", [])
    workspace_id = args.get("workspace_id") or WORKSPACE_ID or None

    # Create or update research entry
    entry_id = args.get("entry_id")
    if entry_id:
        # Update existing entry
        result = _api_call("PUT", f"/research/{entry_id}", {
            "findings_summary": content,
            "status": "in_progress",
        })
    else:
        # Create new entry
        result = _api_call("POST", "/research", {
            "topic": topic,
            "query": topic,
            "workspace_id": workspace_id,
            "status": "in_progress",
            "findings_summary": content,
        })
        if isinstance(result, dict):
            entry_id = result.get("id")

    # Add sources
    if entry_id and sources:
        for src in sources:
            if isinstance(src, str):
                src = {"url": src}
            _api_call("POST", f"/research/{entry_id}/sources", {
                "url": src.get("url", ""),
                "title": src.get("title", ""),
                "content_summary": src.get("summary", ""),
                "relevance_score": src.get("relevance", 0.5),
            })

    return json.dumps({
        "saved": True,
        "entry_id": entry_id,
        "topic": topic,
        "sources_added": len(sources),
    }, indent=2)


def tool_get_research(args: dict) -> str:
    """Retrieve existing research from Commander's Research DB."""
    topic = args.get("topic", "").strip()
    entry_id = args.get("entry_id")
    workspace_id = args.get("workspace_id") or WORKSPACE_ID or None

    if entry_id:
        result = _api_call("GET", f"/research/{entry_id}")
        return json.dumps(result, indent=2)

    if topic:
        result = _api_call("GET", f"/research/search?q={urllib.request.quote(topic)}")
        return json.dumps(result, indent=2)

    # List all for workspace
    path = "/research"
    if workspace_id:
        path += f"?workspace={workspace_id}"
    result = _api_call("GET", path)
    return json.dumps(result, indent=2)


def tool_finish_research(args: dict) -> str:
    """Mark a research entry as complete with final findings and sources."""
    entry_id = args.get("entry_id", "").strip()
    if not entry_id:
        return json.dumps({"error": "entry_id required"})

    findings = args.get("findings", "")
    sources = args.get("sources", [])

    result = _api_call("PUT", f"/research/{entry_id}", {
        "findings_summary": findings,
        "status": "complete",
    })

    # Save sources if provided
    sources_added = 0
    if sources:
        for src in sources:
            if isinstance(src, str):
                src = {"url": src}
            _api_call("POST", f"/research/{entry_id}/sources", {
                "url": src.get("url", ""),
                "title": src.get("title", ""),
                "content_summary": src.get("summary", ""),
                "relevance_score": src.get("relevance", 0.5),
            })
            sources_added += 1

    return json.dumps({
        "status": "complete",
        "entry_id": entry_id,
        "sources_added": sources_added,
    }, indent=2)


# ── Tool registry ────────────────────────────────────────────────

TOOLS = {
    "multi_search": {
        "handler": tool_multi_search,
        "description": (
            "Search across multiple engines simultaneously: Brave, DuckDuckGo, "
            "arXiv, Semantic Scholar, GitHub, and SearXNG. Returns deduplicated "
            "results ranked by Reciprocal Rank Fusion. Use for broad exploration "
            "— pass 3-5 diverse queries for best coverage."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "queries": {
                    "oneOf": [
                        {"type": "string", "description": "Single search query"},
                        {"type": "array", "items": {"type": "string"}, "description": "Multiple search queries"},
                    ],
                    "description": "Search queries — pass multiple for broader coverage",
                },
                "max_results_per_source": {
                    "type": "integer",
                    "description": "Max results per search engine (default: 8)",
                    "default": 8,
                },
                "include_recent": {
                    "type": "boolean",
                    "description": "Auto-add year-qualified query variants (2025/2026) for recency. Default: true.",
                    "default": True,
                },
            },
            "required": ["queries"],
        },
    },

    "extract_pages": {
        "handler": tool_extract_pages,
        "description": (
            "Extract clean text content from web pages. Strips HTML, ads, and "
            "navigation — returns the main article/document text. Use when you "
            "need to read a source in full, not just the search snippet."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "urls": {
                    "oneOf": [
                        {"type": "string", "description": "Single URL"},
                        {"type": "array", "items": {"type": "string"}, "description": "Multiple URLs"},
                    ],
                    "description": "URLs to extract content from",
                },
                "max_concurrent": {
                    "type": "integer",
                    "description": "Max concurrent extractions (default: 8)",
                    "default": 8,
                },
                "max_chars_per_page": {
                    "type": "integer",
                    "description": "Truncate each page's content to this many chars (default: 12000)",
                    "default": 12000,
                },
            },
            "required": ["urls"],
        },
    },

    "gather": {
        "handler": tool_gather,
        "description": (
            "Combined search + extract in one step. Searches multiple engines, "
            "then fetches full content from the top results. Returns a structured "
            "markdown summary ready for analysis. Use for focused deep dives on "
            "a specific research angle."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "queries": {
                    "oneOf": [
                        {"type": "string", "description": "Single search query"},
                        {"type": "array", "items": {"type": "string"}, "description": "Multiple search queries"},
                    ],
                    "description": "Search queries for the deep dive",
                },
                "max_extract": {
                    "type": "integer",
                    "description": "Max pages to fetch full content from (default: 10)",
                    "default": 10,
                },
                "include_recent": {
                    "type": "boolean",
                    "description": "Auto-add year-qualified query variants (2025/2026) for recency. Default: true.",
                    "default": True,
                },
            },
            "required": ["queries"],
        },
    },

    "save_research": {
        "handler": tool_save_research,
        "description": (
            "Save research findings to Commander's Research DB. Creates or updates "
            "a research entry with findings and source citations. Save incrementally "
            "after each round — don't wait until the end."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "topic": {
                    "type": "string",
                    "description": "Research topic / question",
                },
                "content": {
                    "type": "string",
                    "description": "Research findings (markdown)",
                },
                "sources": {
                    "type": "array",
                    "items": {
                        "oneOf": [
                            {"type": "string", "description": "URL"},
                            {
                                "type": "object",
                                "properties": {
                                    "url": {"type": "string"},
                                    "title": {"type": "string"},
                                    "summary": {"type": "string"},
                                    "relevance": {"type": "number"},
                                },
                            },
                        ],
                    },
                    "description": "Source citations (URLs or {url, title, summary, relevance} objects)",
                },
                "entry_id": {
                    "type": "string",
                    "description": "Existing entry ID to update (omit to create new)",
                },
                "workspace_id": {
                    "type": "string",
                    "description": "Workspace ID (auto-detected if not provided)",
                },
            },
            "required": ["topic", "content"],
        },
    },

    "get_research": {
        "handler": tool_get_research,
        "description": (
            "Retrieve existing research from Commander's Research DB. Check what's "
            "already been researched before starting new work. Search by topic, "
            "entry ID, or list all entries for the workspace."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "topic": {
                    "type": "string",
                    "description": "Search research entries by topic",
                },
                "entry_id": {
                    "type": "string",
                    "description": "Get a specific entry by ID (includes sources)",
                },
                "workspace_id": {
                    "type": "string",
                    "description": "Filter by workspace (auto-detected if not provided)",
                },
            },
        },
    },

    "finish_research": {
        "handler": tool_finish_research,
        "description": (
            "Mark a research entry as complete with final synthesized findings "
            "AND all source URLs. IMPORTANT: Always include the sources array "
            "with every URL you found during research. Sources are stored "
            "separately from findings and displayed as clickable links."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "entry_id": {
                    "type": "string",
                    "description": "Research entry ID to finalize",
                },
                "findings": {
                    "type": "string",
                    "description": "Final synthesized findings (markdown)",
                },
                "sources": {
                    "type": "array",
                    "items": {
                        "oneOf": [
                            {"type": "string", "description": "URL"},
                            {
                                "type": "object",
                                "properties": {
                                    "url": {"type": "string"},
                                    "title": {"type": "string"},
                                    "summary": {"type": "string"},
                                    "relevance": {"type": "number"},
                                },
                            },
                        ],
                    },
                    "description": "ALL source URLs found during research. REQUIRED — every URL referenced in findings must be listed here.",
                },
            },
            "required": ["entry_id", "findings", "sources"],
        },
    },
}


# ── MCP protocol handler ─────────────────────────────────────────

def handle_jsonrpc(request: dict) -> dict | None:
    """Handle a JSON-RPC 2.0 MCP request."""
    method = request.get("method", "")
    req_id = request.get("id")

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {
                    "name": "deep-research",
                    "version": "1.0.0",
                },
            },
        }

    if method == "notifications/initialized":
        return None

    if method == "tools/list":
        tools_list = []
        for name, spec in TOOLS.items():
            tools_list.append({
                "name": name,
                "description": spec["description"],
                "inputSchema": spec["inputSchema"],
            })
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"tools": tools_list},
        }

    if method == "tools/call":
        params = request.get("params", {})
        tool_name = params.get("name", "")
        tool_args = params.get("arguments", {})
        spec = TOOLS.get(tool_name)

        if not spec:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32601, "message": f"Unknown tool: {tool_name}"},
            }

        try:
            result_text = spec["handler"](tool_args)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": result_text}],
                },
            }
        except Exception as e:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": f"Error: {e}"}],
                    "isError": True,
                },
            }

    # Unknown method
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Unknown method: {method}"},
    }


# ── Main loop ─────────────────────────────────────────────────────

def main():
    logging.basicConfig(
        level=logging.WARNING,
        format="%(name)s %(levelname)s %(message)s",
        stream=sys.stderr,
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue

        response = handle_jsonrpc(request)
        if response is not None:
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
