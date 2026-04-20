---
title: Deep Research Plugin
---

# Deep Research Plugin

The Deep Research plugin turns any Claude Code or Gemini session into a deep researcher, using the session's own LLM reasoning combined with local search and extraction tools.

## Architecture

```
Session (Claude Opus/Sonnet as brain)
  └── MCP tools (search + extract)
        ├── multi_search — Brave, DuckDuckGo, arXiv, GitHub, Semantic Scholar
        ├── extract_pages — clean text extraction from URLs
        ├── gather — search + extract in one call
        ├── save_research — write findings to Commander Research DB
        ├── get_research — query existing research entries
        └── finish_research — mark entry complete with final synthesis
```

## MCP tools

| Tool | Description |
|------|-------------|
| `multi_search` | Search multiple backends simultaneously, RRF-fused ranking |
| `extract_pages` | Extract clean text from web pages |
| `gather` | Combined search + extract → markdown summary |
| `save_research` | Write findings + citations to the Research DB |
| `get_research` | Query existing research by topic, ID, or workspace |
| `finish_research` | Mark an entry complete with final synthesized findings |

## Setup

### 1. Register the MCP server

In the MCP Servers panel (⌘⇧S), add a new server:

- **Name**: Deep Research
- **Type**: stdio
- **Command**: `python3`
- **Args**: `["plugins/deep-research/mcp_server.py"]`

### 2. Import the guideline

1. Open Guidelines (⌘G)
2. Click **Import** → select `plugins/deep-research/SKILL.md`
3. The research methodology guideline is now available

### 3. Attach to a session

1. Create a new session (⌘N)
2. In the New Session form, attach the Deep Research MCP server
3. Attach the Deep Research guideline

## Required API keys (optional)

The plugin works without any keys — DuckDuckGo, arXiv, Semantic Scholar, and GitHub all work keyless. For better results:

| Service | Env var |
|---------|---------|
| Brave Search | `BRAVE_API_KEY` |
| SearXNG | `SEARXNG_URL` |

## Research methodology

The plugin injects a methodology guideline that instructs the session to:
- Approach topics from multiple angles
- Cross-reference sources before concluding
- Cite all sources with URLs
- Iterate if initial results are insufficient

## Related

- [Research Panel](../research) — the standalone deep research engine
- [MCP Servers](../mcp-servers) — registering MCP servers
- [Marketplace](../marketplace) — installing the plugin via the Marketplace
