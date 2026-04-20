"""Deep Investigate — agentic transformation of research into engineering plans.

Unlike a pipeline, this is a real agent: it reads the research, thinks about
what it needs, and can use tools to gather more detail:
  - gather: search for implementation details, library comparisons
  - read_url: read documentation, API references, blog posts
  - search_code: grep the codebase for existing patterns
  - read_file: inspect specific source files

The agent loop runs until the investigator has enough context to produce
a detailed, actionable implementation plan.
"""

from __future__ import annotations

import logging
from pathlib import Path

from .codebase import profile_codebase
from .config import DeepResearchConfig
from .llm import LLMClient
from .prompts import SYSTEM_INVESTIGATOR
from .tools import INVESTIGATOR_TOOLS, ToolExecutor, run_with_tools

logger = logging.getLogger(__name__)

# Single prompt — the agent decides what to do
INVESTIGATE_AGENT_PROMPT = """\
You are investigating how to implement research findings in a real codebase.

## Research Report
{report}

## Codebase Context
{codebase}

## Your Task

Produce a detailed, actionable implementation plan. You have tools available:
- **gather**: search the web for implementation details, library comparisons, benchmarks
- **read_url**: read specific documentation pages or blog posts in detail
- **search_code**: grep the codebase to find existing patterns, imports, schemas
- **read_file**: read specific source files to understand current implementation

Use tools to fill in any gaps before writing the plan. For example:
- If the research mentions a library, search for its API docs
- If you need to know how the codebase handles X, search_code for it
- If you find a relevant file, read_file to understand it

When you have enough context, write the final plan in this structure:

# Implementation Plan

## Core Concept & Cross-Domain Application
(Architecture overview. Which cross-domain concepts are applied and how.)

## Proposed Architecture
(Tech stack, system design, data models, API boundaries.
Reference existing codebase components.)

## Step-by-Step Implementation

### Phase 1: Foundation & Prerequisites
(Config, dependencies, schema migrations)
- Step 1.1: ... (name specific files, commands)

### Phase 2: Core Implementation
(Main logic, data structures, algorithms)
- Step 2.1: ... (include code sketches for non-obvious parts)

### Phase 3: Integration & Testing
(Wire into existing system, test plan)

### Phase 4: Production Readiness
(Performance, monitoring)

## Known Risks & Mitigations

## Success Metrics

Rules:
- Every step MUST name specific files, functions, or commands
- Include code sketches for non-obvious algorithms
- Reference specific research findings
- A developer should be able to start Phase 1 immediately"""


class Investigator:
    """Agentic investigator — uses tools to build comprehensive plans."""

    def __init__(
        self,
        config: DeepResearchConfig | None = None,
        llm: LLMClient | None = None,
        on_progress: callable | None = None,
    ):
        self.config = config or DeepResearchConfig.from_env()
        self.llm = llm or LLMClient(self.config)
        self.progress = on_progress or (lambda msg: print(msg))

    async def investigate(
        self,
        topic_dir: str | Path,
        codebase_dir: str | Path | None = None,
        codebase_context: str | None = None,
    ) -> str:
        """Generate an actionable plan from research output.

        The investigator agent can call tools to gather additional context:
        searching the web, reading URLs, grepping the codebase, reading files.
        """
        topic_dir = Path(topic_dir)

        # ── Load research report ───────────────────────────────────
        report_path = topic_dir / "comprehensive-report.md"
        if not report_path.exists():
            raise FileNotFoundError(
                f"No comprehensive-report.md in {topic_dir}. Run deep-research first."
            )
        report = report_path.read_text(encoding="utf-8")
        self.progress(f"[1/2] Loaded research report ({len(report)} chars)")

        # ── Build or load codebase context ─────────────────────────
        if codebase_context is None:
            ctx_path = topic_dir.parent / "codebase" / "architecture-and-context.md"
            if ctx_path.exists():
                codebase_context = ctx_path.read_text(encoding="utf-8")
                self.progress(f"[1/2] Loaded existing codebase context")
            elif codebase_dir:
                self.progress(f"[1/2] Profiling codebase at {codebase_dir}...")
                codebase_context = profile_codebase(codebase_dir)
                ctx_path.parent.mkdir(parents=True, exist_ok=True)
                ctx_path.write_text(codebase_context, encoding="utf-8")
            else:
                codebase_context = "(No codebase context provided)"

        # ── Budget: use full context, don't truncate ───────────────
        budget = self.config.context_chars
        # Reserve space for prompt template + tool results
        prompt_overhead = 2000  # chars for the template itself
        available = budget - prompt_overhead
        # Split: 60% report, 40% codebase
        report_budget = int(available * 0.6)
        codebase_budget = int(available * 0.4)

        prompt = INVESTIGATE_AGENT_PROMPT.format(
            report=report[:report_budget],
            codebase=codebase_context[:codebase_budget],
        )

        # ── Run agentic loop ──────────────────────────────────────
        self.progress("[2/2] Investigator agent running (may call tools)...")
        executor = ToolExecutor(
            config=self.config,
            codebase_dir=str(codebase_dir) if codebase_dir else None,
        )

        plan = await run_with_tools(
            llm=self.llm,
            prompt=prompt,
            system=SYSTEM_INVESTIGATOR,
            tools=INVESTIGATOR_TOOLS,
            executor=executor,
            max_tool_rounds=5,
            task_hint="investigate_plan",
            on_progress=self.progress,
        )

        # ── Save ──────────────────────────────────────────────────
        plan_path = topic_dir / "actionable-plan.md"
        plan_path.write_text(plan, encoding="utf-8")

        self.progress(
            f"\nInvestigation complete\n"
            f"  Plan: {plan_path}"
        )
        return plan

    async def close(self):
        await self.llm.close()
