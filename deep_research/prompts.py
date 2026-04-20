"""Prompt templates for the deep research pipeline.

Designed to work well with local models (Gemma, Llama, Qwen) — keeps
JSON schemas flat and simple, provides examples, and avoids complex nesting.
"""

SYSTEM_RESEARCHER = (
    "You are a world-class research analyst. You produce accurate, well-cited, "
    "comprehensive research reports. You never fabricate sources or claims. "
    "When uncertain, you say so explicitly."
)

# ── Phase 1: Query Decomposition ──────────────────────────────────

DECOMPOSE_QUERY = """\
Break this research question into a comprehensive search strategy.

Research question: {query}

Return a JSON object with exactly this structure:
{{
  "sub_queries": ["specific searchable query 1", "specific searchable query 2", ...],
  "reformulations": ["same concept but different vocabulary/phrasing", ...],
  "cross_domain_queries": ["query from an analogous field (biology, physics, sociology, etc.)"],
  "key_entities": ["key term 1", "key term 2"]
}}

Rules:
- sub_queries (3-5): Break the topic into distinct sub-aspects, each specific enough for search
- reformulations (3-5): Rephrase the SAME core concept using DIFFERENT vocabulary.
  This is critical — different fields and papers use different words for the same idea.
  Think: what would a researcher in a DIFFERENT sub-field call the same concept?
  Mix: academic phrasing, keyword-style, question-form, synonym-heavy variants.
  Each reformulation should use words that NONE of the sub_queries use.
- cross_domain_queries (2-3): Search for analogous solutions in OTHER fields
  (e.g., AI memory → neuroscience "episodic memory consolidation during sleep")
- key_entities (3-5): People, algorithms, frameworks, benchmark datasets
- ONLY output the JSON, nothing else"""

# ── Phase 2: Relevance Evaluation ─────────────────────────────────

EVALUATE_RESULTS = """\
Score each search result for relevance to the research query.

Research query: {query}

Search results:
{results_text}

Return a JSON object:
{{
  "scores": [
    {{"index": 0, "score": 8, "keep": true}},
    {{"index": 1, "score": 3, "keep": false}}
  ]
}}

Rules:
- Score each result 1-10 for relevance to the research query
- Set "keep": true only for scores >= 6
- Be selective — quality over quantity
- ONLY output the JSON, nothing else"""

# ── Phase 3: Gap Analysis ─────────────────────────────────────────

GAP_ANALYSIS = """\
Analyze what is still unknown and plan the next search strategy.

Original research question: {query}

Queries already searched: {searched}

Key findings so far:
{findings_summary}

Return a JSON object:
{{
  "gaps": ["What important aspect is still not covered"],
  "new_queries": ["Specific search query to fill gap 1", "..."],
  "reformulations": ["Try different vocabulary for concepts we found but need more on"],
  "cross_domain_suggestions": ["Search query in another field that could help"],
  "confidence": 0.6,
  "should_continue": true
}}

Rules:
- gaps (1-3): Genuine knowledge gaps not yet covered
- new_queries (2-4): Targeted queries to fill specific gaps
- reformulations (2-3): Re-search concepts we partially found but likely missed results
  due to vocabulary mismatch. Use DIFFERENT words than previous queries.
  Look at terminology used IN the findings — papers cite related work using
  their own vocabulary. Use THOSE terms to find more.
- cross_domain_suggestions (1-2): Other fields with analogous patterns
- confidence 0.0-1.0, should_continue=false if confidence > 0.85
- ONLY output the JSON, nothing else"""

# ── Phase 4: Batch Summarization ──────────────────────────────────

SUMMARIZE_BATCH = """\
Summarize the key findings from these sources that are relevant to the research query.

Research query: {query}

Sources:
{batch_text}

For each source, extract:
1. The most relevant facts, data points, or insights
2. Any specific numbers, benchmarks, or comparisons
3. Novel ideas or approaches mentioned

Write a concise summary (max 300 words per source). Preserve source numbers [1], [2] etc. for citation."""

# ── Phase 5: Final Synthesis ──────────────────────────────────────

SYNTHESIZE_REPORT = """\
Synthesize all research findings into a comprehensive report.

Research question: {query}

Research findings (summarized from {source_count} sources):
{findings}

Source index:
{source_list}

Write a comprehensive markdown research report with this structure:

# {query} — Research Report

## Executive Summary
(2-3 paragraphs covering the state of the art and key insights)

## Key Findings
(Organized by theme, not by source. Use inline citations like [1], [2])

## Cross-Domain Insights
(Analogies and transferable ideas from other fields)

## Technical Deep-Dive
(Algorithms, architectures, benchmarks, implementation details)

## Open Questions & Limitations
(What remains unknown, contradictions found, areas needing more research)

## Sources
(Numbered list matching inline citations)

Rules:
- Every factual claim MUST have an inline citation [N]
- Be thorough but not redundant
- Highlight contradictions between sources
- Distinguish between well-established facts and emerging/speculative ideas"""

# ── Phase 6: Claim Verification ───────────────────────────────────

VERIFY_CLAIMS = """\
Extract and verify the 5-10 most important claims from this research report.

Report excerpt:
{report_excerpt}

Available source content:
{source_content}

Return a JSON object:
{{
  "verifications": [
    {{
      "claim": "The specific claim being verified",
      "status": "VERIFIED",
      "sources": [1, 3],
      "note": "Found in both sources with consistent data"
    }}
  ]
}}

Status options:
- VERIFIED: Confirmed by 2+ independent sources
- LIKELY: Found in 1 source, consistent with general findings
- UNVERIFIED: Not directly supported by available sources
- CONTRADICTED: Sources disagree on this point

ONLY output the JSON, nothing else"""


# ═══════════════════════════════════════════════════════════════════
# DEEP INVESTIGATE prompts
# ═══════════════════════════════════════════════════════════════════

SYSTEM_INVESTIGATOR = (
    "You are a senior software architect. You transform research findings into "
    "concrete, actionable engineering plans. You consider existing codebase "
    "architecture, technical debt, and realistic implementation constraints. "
    "Your plans are specific enough that a developer can start coding immediately."
)

INVESTIGATE_BRAINSTORM = """\
You have a comprehensive research report and a codebase to improve. Brainstorm
how the research findings can be practically applied.

## Research Report (excerpt)
{report}

## Codebase Context
{codebase}

For each key finding in the research, answer:
1. How could this be applied to THIS specific codebase?
2. What existing code/infrastructure can be reused?
3. What are the cross-domain insights that could give us a unique advantage?
4. What are the risks and trade-offs?

Focus especially on the "Cross-Domain Insights" section of the research —
these often contain the most innovative and differentiating ideas.

Be specific: name files, functions, tables, and APIs from the codebase."""

INVESTIGATE_PLAN = """\
Generate a detailed, actionable implementation plan based on the research
findings and brainstorm analysis.

## Research Report (excerpt)
{report}

## Codebase Context
{codebase}

## Brainstorm Analysis
{brainstorm}

Write the plan in this markdown structure:

# Implementation Plan

## Core Concept & Cross-Domain Application
(Explain the architecture. Highlight which cross-domain concepts are being
applied and how they translate to engineering decisions.)

## Proposed Architecture
(Tech stack choices, system design, data models, API boundaries.
Reference existing codebase components where applicable.)

## Step-by-Step Implementation

### Phase 1: Foundation & Prerequisites
(Config, dependencies, schema migrations, scaffolding)
- Step 1.1: ...
- Step 1.2: ...

### Phase 2: Core Implementation
(Main logic, data structures, algorithms)
- Step 2.1: ...

### Phase 3: Integration & Testing
(Wire into existing system, edge cases, test plan)
- Step 3.1: ...

### Phase 4: Polish & Production Readiness
(Performance, monitoring, documentation)
- Step 4.1: ...

## Known Risks & Mitigations
(Technical challenges with fallback strategies)

## Success Metrics
(How to measure if the implementation achieved its goals)

Rules:
- Every step must name specific files, functions, or commands
- Include code sketches for non-obvious algorithms
- Reference specific research findings by quoting them
- A developer should be able to start Phase 1 immediately after reading this"""


# ═══════════════════════════════════════════════════════════════════
# DEEP ALIGNER prompts
# ═══════════════════════════════════════════════════════════════════

SYSTEM_ALIGNER = (
    "You are a technical alignment reviewer. You compare ongoing research "
    "findings against a real codebase to catch misalignments early: wrong "
    "language/framework assumptions, missed constraints, infeasible approaches, "
    "or unexplored angles that the codebase context reveals."
)

ALIGNER_ANALYZE = """\
Compare the current research findings against the codebase reality and
identify any misalignments or missed opportunities.

## Research Query
{query}

## Current Research Scratchpad
{scratchpad}

## Codebase Context
{codebase}

Return a JSON object:
{{
  "misalignments": [
    "Research discusses Flask but codebase uses aiohttp",
    "Research assumes PostgreSQL but codebase uses SQLite"
  ],
  "suggestions": [
    "Research should explore async patterns since codebase is fully async",
    "The graph engine in services/engine/ already handles X — research should build on this"
  ],
  "priority_queries": [
    "aiohttp middleware patterns for X",
    "pgvector integration with existing schema"
  ]
}}

Rules:
- Only flag genuine misalignments (wrong tech, wrong assumptions, infeasible approaches)
- Suggestions should leverage what ALREADY exists in the codebase
- Priority queries should be specific enough for a search engine
- Empty arrays are fine if research is well-aligned
- ONLY output the JSON, nothing else"""
