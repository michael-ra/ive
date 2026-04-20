---
title: Research
---

# Research

The Research Panel (⌘R) provides a self-hosted deep research engine with multi-source web search, source citation, and a persistent results database.

![Research panel](../screenshots/research.png)

## Starting a research job

1. Press **⌘R** to open the Research Panel
2. Click **New Research**
3. Enter your research topic or question
4. Choose a depth:
   - **Quick** — fast, fewer sources
   - **Standard** — balanced
   - **Deep** — thorough, more sources, slower
5. Click **Start**

The research runs as a background subprocess. A progress log shows what's happening in real-time.

## Research modes

| Mode | Description |
|------|-------------|
| **Autonomous** | Local LLM handles everything (no API quota used) |
| **Hybrid** | Claude/Gemini as the brain, local tools for search/extract |

## Search backends

| Backend | Requires |
|---------|---------|
| DuckDuckGo | Nothing (always available) |
| arXiv | Nothing (for academic papers) |
| Semantic Scholar | Nothing (for academic papers) |
| GitHub | Nothing (for code/repos) |
| Brave | `BRAVE_API_KEY` env var |
| SearXNG | `SEARXNG_URL` env var |

## Viewing results

Research entries appear in the panel with:
- **Title** and summary
- **Sources** — cited URLs with snippets
- **Date** and workspace tag
- Status (in-progress, complete)

Click any entry to expand the full findings.

## Filtering

Filter research by:
- Workspace (feature tag)
- Recency (last N months)
- Status

## Deep Research plugin

For richer research within a session, install the **Deep Research plugin** — it gives Claude Code or Gemini CLI a set of MCP tools (`multi_search`, `extract_pages`, `gather`, `save_research`) for iterative research.

See [Deep Research Plugin](./plugins/deep-research) for setup instructions.

## Related

- [Deep Research Plugin](./plugins/deep-research) — in-session research tools
- [API: Research](../api/research) — REST API reference
