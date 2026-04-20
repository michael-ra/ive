"""Deep Aligner — real-time course correction for research-in-progress.

Monitors the research scratchpad, compares findings against codebase reality,
and writes steering hints that the research loop picks up on the next iteration.

Can run in two modes:
  1. Inline: called after each research round (tight feedback loop)
  2. Standalone: polls scratchpad.md on an interval (original 3-agent pattern)
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from .codebase import profile_codebase
from .config import DeepResearchConfig
from .llm import LLMClient
from .prompts import ALIGNER_ANALYZE, SYSTEM_ALIGNER

logger = logging.getLogger(__name__)


class Aligner:
    """Monitors research and provides codebase-grounded course corrections."""

    def __init__(
        self,
        config: DeepResearchConfig | None = None,
        llm: LLMClient | None = None,
        on_progress: callable | None = None,
    ):
        self.config = config or DeepResearchConfig.from_env()
        self.llm = llm or LLMClient(self.config)
        self.progress = on_progress or (lambda msg: print(msg))

    # ── Inline mode: single check ──────────────────────────────────

    async def check(
        self,
        scratchpad: str,
        codebase_context: str,
        query: str,
    ) -> dict:
        """Run one alignment check. Returns parsed hints.

        Used by the research loop after each round to get immediate feedback.
        Returns dict with keys: misalignments, suggestions, priority_queries.
        """
        try:
            budget = self.config.context_chars
            return await self.llm.generate_json(
                ALIGNER_ANALYZE.format(
                    query=query,
                    scratchpad=scratchpad[:int(budget * 0.5)],
                    codebase=codebase_context[:int(budget * 0.3)],
                ),
                system=SYSTEM_ALIGNER,
            )
        except (ValueError, RuntimeError) as e:
            logger.warning("Aligner check failed: %s", e)
            return {"misalignments": [], "suggestions": [], "priority_queries": []}

    # ── Standalone mode: polling loop ──────────────────────────────

    async def watch(
        self,
        topic_dir: str | Path,
        codebase_dir: str | Path | None = None,
        codebase_context: str | None = None,
        poll_interval: int = 60,
        max_iterations: int = 10,
    ):
        """Run the aligner as a standalone polling loop.

        Monitors scratchpad.md and writes aligner-hints.md.
        Research loop can read hints to adjust course.
        """
        topic_dir = Path(topic_dir)
        scratchpad_path = topic_dir / "scratchpad.md"
        hints_path = topic_dir / "aligner-hints.md"

        # Build codebase context
        if codebase_context is None:
            ctx_path = topic_dir.parent / "codebase" / "architecture-and-context.md"
            if ctx_path.exists():
                codebase_context = ctx_path.read_text(encoding="utf-8")
            elif codebase_dir:
                self.progress(f"Profiling codebase at {codebase_dir}...")
                codebase_context = profile_codebase(codebase_dir)
            else:
                codebase_context = "(No codebase context provided)"

        # Infer query from scratchpad header
        query = "(unknown)"
        if scratchpad_path.exists():
            first_line = scratchpad_path.read_text(encoding="utf-8").split("\n")[0]
            if first_line.startswith("# Scratchpad"):
                query = first_line.replace("# Scratchpad", "").strip(" —\t")

        self.progress(
            f"Aligner watching: {topic_dir}\n"
            f"  Poll interval: {poll_interval}s\n"
            f"  Max iterations: {max_iterations}\n"
        )

        last_scratchpad = ""
        all_hints: list[str] = []

        for i in range(max_iterations):
            # Wait for scratchpad changes
            if i > 0:
                self.progress(f"\n[Aligner] Waiting {poll_interval}s for next check...")
                await asyncio.sleep(poll_interval)

            if not scratchpad_path.exists():
                self.progress("[Aligner] No scratchpad yet — waiting...")
                continue

            current = scratchpad_path.read_text(encoding="utf-8")
            if current == last_scratchpad:
                self.progress("[Aligner] No changes since last check — skipping")
                continue

            last_scratchpad = current
            self.progress(f"[Aligner] Iteration {i + 1}/{max_iterations} — analyzing...")

            result = await self.check(current, codebase_context, query)

            # Format hints
            timestamp = time.strftime("%Y-%m-%d %H:%M")
            hint_lines = [f"## [{timestamp}] Aligner Hints (Round {i + 1})\n"]

            misalignments = result.get("misalignments", [])
            if misalignments:
                hint_lines.append("### Misalignments\n")
                for m in misalignments:
                    hint_lines.append(f"- {m}")
                hint_lines.append("")

            suggestions = result.get("suggestions", [])
            if suggestions:
                hint_lines.append("### Suggestions\n")
                for s in suggestions:
                    hint_lines.append(f"- {s}")
                hint_lines.append("")

            priority = result.get("priority_queries", [])
            if priority:
                hint_lines.append("### Priority Queries for Next Round\n")
                for q in priority:
                    hint_lines.append(f"- `{q}`")
                hint_lines.append("")

            hint_block = "\n".join(hint_lines)
            all_hints.append(hint_block)

            # Write cumulative hints file
            hints_path.write_text("\n\n".join(all_hints), encoding="utf-8")

            self.progress(
                f"  {len(misalignments)} misalignments, "
                f"{len(suggestions)} suggestions, "
                f"{len(priority)} priority queries"
            )
            self.progress(f"  Hints written to {hints_path}")

            if not misalignments and not suggestions:
                self.progress("[Aligner] Research well-aligned — no corrections needed")

        self.progress(f"\nAligner done ({max_iterations} iterations)")

    async def close(self):
        await self.llm.close()
