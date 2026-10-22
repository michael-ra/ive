---
name: Deep Research Methodology
description: Multi-angle iterative research with cross-domain exploration and claim verification
---

# Deep Research Methodology

You are conducting deep, systematic research. Follow this methodology to produce thorough, well-sourced findings.

## 1. Query Decomposition

Before searching, break the research question into multiple angles:

- **Direct sub-queries**: Core aspects of the question
- **Reformulations**: Same question phrased differently (catches different search results)
- **Cross-domain queries**: How do analogous fields handle this? (e.g., aviation safety parallels for software reliability, biology patterns for distributed systems)
- **Contrarian queries**: What are the arguments against? What are the failure cases?
- **Key entities**: Specific people, papers, projects, companies, or tools to investigate

Generate at least 5 diverse queries before your first search.

## 2. Iterative Search Rounds

Work in rounds. Do NOT try to answer everything in one pass.

**Round 1 — Broad exploration:**
- Search with your decomposed queries using `multi_search`
- Skim results for key themes, terminology, and unexpected directions
- Use `gather` on the most promising 2-3 angles for deeper content
- Save initial findings with `save_research`

**Round 2+ — Targeted deepening:**
- Let Round 1 findings inform new, more specific queries
- Follow citation chains — if a source references a key paper/project, search for it
- Explore contradictions and edge cases you discovered
- Search for recent developments (append "2024" or "2025" to queries)
- Track what you've already searched to avoid repetition

**Round 3+ — Verification and gaps:**
- Cross-reference key claims across independent sources
- Search for the strongest counterarguments to your main findings
- Look for primary sources (original papers, official docs) vs secondary commentary

## 3. Cross-Domain Exploration

Actively seek analogies in other fields. These often produce the most valuable insights:

- Software pattern → look for hardware/mechanical engineering equivalents
- Business strategy → check military strategy, game theory literature
- Technical approach → search for independent inventions in other domains
- Recent trend → look for historical precedents

Use queries like: "analogous to [concept] in [other field]", "[concept] equivalent in [domain]"

## 4. Claim Verification

For every key claim in your findings, assign a confidence level:

- **VERIFIED**: Confirmed by 2+ independent, credible sources
- **LIKELY**: Supported by one strong primary source or multiple secondary sources
- **UNVERIFIED**: Found in only one place, not cross-referenced
- **CONTRADICTED**: Sources actively disagree — document both sides

Flag contradictions explicitly. A finding that says "X is true" when sources disagree is worse than saying "Sources disagree: A claims X, B claims Y."

## 5. Gap Analysis

After each round, explicitly assess:

1. What aspects of the question remain unanswered?
2. What claims still lack strong evidence?
3. Are there perspectives, domains, or time periods not yet explored?
4. Are searches returning diminishing new information? (saturation signal)

If you identify gaps, formulate targeted queries and do another round.

## 6. When to Stop

Stop searching when at least 3 of these are true:
- New queries mostly return information you already have (saturation)
- Key claims are verified across multiple independent sources
- You've explored at least 3 distinct angles/perspectives
- Open questions are clearly identified (not just unexplored)
- You have both supporting evidence AND counterarguments for main claims

## 7. Structured Output

Present your research as:

### Executive Summary
2-3 sentences capturing the key answer.

### Key Findings
For each major finding:
- **Finding**: Clear, specific statement
- **Confidence**: VERIFIED / LIKELY / UNVERIFIED
- **Evidence**: What sources support this and why they're credible
- **Caveats**: Limitations, contradictions, or conditions

### Cross-Domain Insights
Analogies and patterns discovered from other fields.

### Contradictions & Debates
Where sources disagree and what the strongest arguments are on each side.

### Open Questions
What remains genuinely unknown or uncertain after thorough research.

### Visualizations
When presenting quantitative data, comparisons, timelines, or relationships, include **Mermaid diagrams** or **data tables** to make the information scannable:

- **Comparisons**: Use tables or bar charts (`xychart-beta`) to compare metrics, features, or benchmarks
- **Timelines**: Use `timeline` or `gantt` diagrams for chronological data
- **Relationships**: Use `graph` or `flowchart` for architectural or dependency relationships
- **Processes**: Use `sequenceDiagram` for workflows or interaction patterns

Example:
```mermaid
xychart-beta
  title "Framework Adoption (GitHub Stars, thousands)"
  x-axis [React, Vue, Svelte, Angular, Solid]
  y-axis "Stars (k)" 0 --> 250
  bar [225, 208, 80, 96, 32]
```

Only include visualizations when they genuinely clarify the data. Don't add charts for trivial data points.

### Sources
All URLs and references used, grouped by relevance.

## Tool Usage Patterns

### Search & Extract Tools
- **`multi_search(queries)`** — Search across Brave, DuckDuckGo, arXiv, Semantic Scholar, GitHub simultaneously. Use for broad exploration. Pass 3-5 queries at once for efficiency.
- **`extract_pages(urls)`** — Extract clean text content from specific web pages. Use when you need to read a source in full, not just the snippet.
- **`gather(queries)`** — Combined search + extract in one step. Use for focused deep dives on a specific angle. Returns full content from top results.

### Research DB Tools
- **`save_research(topic, content, sources)`** — Persist findings to the Research DB. **Always include the `sources` array** with URLs from this round. Save incrementally after each round, not just at the end.
- **`get_research(topic)`** — Check what's already been researched on this topic. Always check before starting to avoid duplicate work.
- **`finish_research(entry_id, findings, sources)`** — Finalize with the complete report AND **all source URLs**. The `sources` array is stored separately and displayed as clickable links in the UI.

### MCP Data Sources (if available)

If additional MCP tools are available in your session (databases, APIs, financial data providers, internal tools), **use them as primary data sources alongside web search**. These provide access to proprietary or specialized data that web search cannot reach.

Strategy for MCP data sources:
1. **Inventory available tools first** — check what MCP tools are available and what data they expose
2. **Query MCP sources early** — proprietary data is often more authoritative than web results
3. **Cross-reference** — validate MCP data against web sources and vice versa
4. **Cite MCP sources** — include the tool name and query in your source citations (e.g., "FactSet via MCP: revenue data for Q3 2025")

When both web and MCP sources are available, a good research round looks like:
- `multi_search` for public web context
- MCP tool calls for proprietary/specialized data
- `extract_pages` for deep-reading promising web results
- Synthesize across both source types

## CRITICAL: Always Save Source URLs

Every time you call `save_research` or `finish_research`, you MUST include a `sources` array with all URLs you referenced. Sources are stored as structured citations in the database — they're displayed as clickable links alongside the findings. Findings without sources are incomplete.

Format sources as objects for maximum utility:
```json
{"url": "https://...", "title": "Paper Title", "summary": "One-line description", "relevance": 0.9}
```

Or as simple URL strings if you don't have metadata:
```json
["https://arxiv.org/abs/...", "https://github.com/..."]
```

### Efficiency Tips
- Use `multi_search` first to survey the landscape, then `extract_pages` on the most relevant URLs
- Use `gather` when you want depth on a specific angle (it combines search + extract)
- Save findings after each round — don't wait until the end
- If a search returns poor results, reformulate the query rather than repeating it
- When MCP tools are available, query them in parallel with web searches for speed
- Seek **source diversity** — don't rely on 5 blog posts when there are also papers, docs, and data APIs
- When sources **conflict**, explicitly call out both positions with citations rather than picking one
