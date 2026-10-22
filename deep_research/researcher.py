"""Deep Research orchestrator — the brain.

Iterative deepening pipeline:
  Decompose → [Search → Evaluate → Extract → Gaps]* → Synthesize → Verify

Each round searches for what's missing, extracts content, identifies gaps,
and generates new queries.  Cross-domain exploration is mandatory — the
system actively searches for analogous solutions in unrelated fields.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import time
import uuid
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from .config import DeepResearchConfig
from .artifacts import run_directory, validated_id
from .extract import extract_multiple
from .llm import LLMClient
from .prompts import (
    DECOMPOSE_QUERY,
    EVALUATE_RESULTS,
    GAP_ANALYSIS,
    SUMMARIZE_BATCH,
    SYNTHESIZE_REPORT,
    SYSTEM_RESEARCHER,
    VERIFY_CLAIMS,
)
from .search import (MultiSearch, SearchResult, SearchUnavailable,
                     build_search)

logger = logging.getLogger(__name__)


# LLM JSON shapes drift between models and between runs. Everything below
# degrades to a usable default instead of killing a multi-round research run.
BAD_SHAPE = (ValueError, TypeError, KeyError, AttributeError, IndexError)


def _as_str_list(value) -> list[str]:
    """Flatten an LLM's "list of queries" into actual strings.

    Models nest — a sub_queries entry comes back as ["a", "b"] instead of "a b",
    or as {"query": "a"} — and the caller then puts an unhashable list into a set
    membership test. One choke point beats a guard at every use site.
    """
    out: list[str] = []
    if isinstance(value, (str, bytes)):
        value = [value]
    if not isinstance(value, (list, tuple)):
        return out
    for item in value:
        if isinstance(item, str):
            item = item.strip()
            if item:
                out.append(item)
        elif isinstance(item, (list, tuple)):
            out.extend(_as_str_list(item))          # nested list of queries
        elif isinstance(item, dict):
            # {"query": "..."} / {"text": "..."} shapes
            for key in ("query", "text", "q", "name", "entity"):
                if isinstance(item.get(key), str) and item[key].strip():
                    out.append(item[key].strip())
                    break
    return out


def _as_dict(data, default: dict) -> dict:
    """Coerce an LLM 'object' response that came back as something else."""
    if isinstance(data, dict):
        return data
    if isinstance(data, list):
        # Some models wrap the object in a single-element array.
        for item in data:
            if isinstance(item, dict):
                return item
    logger.warning("Expected a JSON object, got %s — using default", type(data).__name__)
    return default


def _kept_indices(data) -> set[int]:
    """Indices to keep, tolerating the shapes models actually emit for scores.

    Canonical:  {"scores": [{"index": 0, "score": 8, "keep": true}]}
    Also seen:  bare list instead of {"scores": ...}; ["index", 0, "score", 7,
                "keep", true] key/value flattening (gemma-4-31b does this on
                essentially every long list); [index, score, keep] tuples;
                plain indices; "true"/"yes" strings for keep.
    """
    scores = data.get("scores", data) if isinstance(data, dict) else data
    if not isinstance(scores, list):
        raise ValueError(f"scores is {type(scores).__name__}, not a list")

    kept: set[int] = set()
    for entry in scores:
        if isinstance(entry, dict):
            idx, keep = entry.get("index"), entry.get("keep", False)
        elif isinstance(entry, (list, tuple)) and entry:
            if len(entry) % 2 == 0 and all(isinstance(k, str) for k in entry[::2]):
                flat = dict(zip(entry[::2], entry[1::2]))
                idx, keep = flat.get("index"), flat.get("keep", False)
            else:
                # [index, score, keep?] — infer keep from the score when absent
                idx = entry[0]
                keep = entry[2] if len(entry) > 2 else (len(entry) > 1 and entry[1] >= 6)
        elif isinstance(entry, (int, float)) and not isinstance(entry, bool):
            idx, keep = entry, True   # a plain list of indices to keep
        else:
            continue
        if isinstance(keep, str):
            keep = keep.strip().lower() in ("true", "yes", "1", "keep")
        if keep and isinstance(idx, (int, float)) and not isinstance(idx, bool):
            kept.add(int(idx))
    return kept


class DeepResearcher:
    """Autonomous deep research engine with iterative deepening."""

    def __init__(
        self,
        config: DeepResearchConfig | None = None,
        llm: LLMClient | None = None,
        search: MultiSearch | None = None,
        on_progress: Callable | None = None,
    ):
        self.config = config or DeepResearchConfig.from_env()
        self.llm = llm or LLMClient(self.config)
        self.search = search or build_search(self.config)
        self.progress = on_progress or (lambda msg: print(msg))
        # Whether we own the callback. The default one prints to stdout, which
        # is what a parent process parses, so events go out as JSON there.
        self._emit_json = on_progress is None
        self._steer_queue: asyncio.Queue | None = None  # injected queries
        # Set by the caller (--steer-id) so this run drains only its own file.
        self.steer_id: str | None = None

    def set_steer_queue(self, queue: asyncio.Queue):
        """Set a queue for receiving injected sub-queries during research."""
        self._steer_queue = queue

    # ── Structured progress helper ──────────────────────────────

    def _emit(self, phase: str, detail: str, **extra):
        """Emit a structured progress event + human-readable line."""
        event = {"phase": phase, "detail": detail, **extra}
        # Default callback prints to stdout — emit JSON so a parent process can
        # parse it. (This used to test `self.progress is print`, which the
        # constructor's lambda never satisfies, so every event went out as a
        # Python repr that json.loads rejects.)
        if getattr(self, "_emit_json", False):
            import json as _json
            self.progress(_json.dumps(event, ensure_ascii=False))
        else:
            try:
                self.progress(event)
            except TypeError:
                self.progress(detail)

    # ── Public API ─────────────────────────────────────────────────

    async def decompose_only(self, query: str) -> dict:
        """Run Phase 1 only — return the research plan without executing.

        Returns dict with: sub_queries, reformulations, cross_domain_queries,
        key_entities. The caller can modify this and pass it to research_with_plan().
        """
        return await self._decompose(query)

    async def research_with_plan(self, query: str, plan: dict) -> str:
        """Run research using a pre-built/modified plan (skip decomposition)."""
        return await self._run(query, plan=plan)

    async def research(self, query: str) -> str:
        """Run a full deep research session. Returns the final report markdown."""
        return await self._run(query, plan=None)

    async def _run(self, query: str, plan: dict | None = None) -> str:
        """Core research loop. If plan is provided, skip decomposition."""
        start = time.time()
        deadline = start + self.config.time_limit_minutes * 60
        topic_slug = _slugify(query)
        run_id = self.config.run_id or str(uuid.uuid4())
        if self.config.entry_id is not None:
            validated_id(self.config.entry_id, "entry_id")
        if self.steer_id is not None:
            validated_id(self.steer_id, "steer_id")
        out_dir = run_directory(self.config.output_dir, self.config.workspace_id, run_id)
        out_dir.mkdir(parents=True, exist_ok=False)
        self.config.last_output_dir = str(out_dir)

        # Resolved routing, not the raw config fields: those are empty unless
        # explicitly set, and the provider/tier defaults fill them in.
        self._emit("init", (
            f"{self.config.describe_routing()}\n"
            f"Search: {', '.join(self.search.active_names)}\n"
            f"Time limit: {self.config.time_limit_minutes} minutes"
        ), elapsed=0, model=str(self.config.endpoint()))

        # ── Phase 1: Decompose (or use provided plan) ─────────────
        if plan:
            self._emit("decompose", "Using provided research plan", elapsed=int(time.time() - start))
            decomposition = plan
        else:
            self._emit("decompose", "Decomposing query...", elapsed=int(time.time() - start))
            decomposition = await self._decompose(query)

        sub_qs = _as_str_list(decomposition.get("sub_queries")) or [query]
        reformulations = _as_str_list(decomposition.get("reformulations"))
        cross_qs = _as_str_list(decomposition.get("cross_domain_queries"))
        entities = _as_str_list(decomposition.get("key_entities"))
        self._emit("decompose", (
            f"{len(sub_qs)} sub-queries, {len(reformulations)} reformulations, "
            f"{len(cross_qs)} cross-domain, {len(entities)} key entities"
        ), sub_queries=len(sub_qs), elapsed=int(time.time() - start))

        # ── Phase 2: Iterative research loop ───────────────────────
        findings: list[dict] = []         # {title, url, source, content, round}
        source_index: list[dict] = []     # ordered source list for citations
        searched_queries: set[str] = set()
        iteration = 0

        while time.time() < deadline and iteration < self.config.max_iterations:
            iteration += 1
            elapsed = int(time.time() - start)
            remaining = int((deadline - time.time()) / 60)
            self._emit("search", (
                f"Round {iteration}/{self.config.max_iterations} "
                f"({elapsed}s elapsed, ~{remaining}min left)"
            ), round=iteration, total_rounds=self.config.max_iterations,
               findings_count=len(findings), elapsed=elapsed)

            # Drain steer queue — inject user-supplied sub-queries
            if self._steer_queue:
                while not self._steer_queue.empty():
                    try:
                        steered = self._steer_queue.get_nowait()
                        if isinstance(steered, list):
                            sub_qs.extend(steered)
                        elif isinstance(steered, str):
                            sub_qs.append(steered)
                        self._emit("steer", f"Injected {len(steered) if isinstance(steered, list) else 1} steered queries",
                                   round=iteration, elapsed=int(time.time() - start))
                    except asyncio.QueueEmpty:
                        break

            # Steering is scoped to this exact execution, not a topic slug.
            #
            # Never glob other executions' steering files.
            candidates = [out_dir / "steer.md"]
            for steer_file in candidates:
                if not steer_file.exists():
                    continue
                try:
                    raw = steer_file.read_text().strip()
                    file_qs = [
                        ln.strip() for ln in raw.split("\n")
                        if ln.strip() and not ln.strip().startswith("#")
                    ]
                    if file_qs:
                        sub_qs.extend(file_qs)
                        self._emit("steer", f"Drained {len(file_qs)} steered queries from {steer_file.name}",
                                   round=iteration, consumed=True,
                                   elapsed=int(time.time() - start))
                    steer_file.unlink()  # consumed
                except Exception as e:
                    logger.warning("steer file read failed (%s): %s", steer_file, e)

            # Determine what to search — sub-queries + reformulations + cross-domain
            queries = list(sub_qs)
            queries.extend(reformulations)
            if self.config.cross_domain and cross_qs:
                queries.extend(cross_qs)
            queries = [q for q in queries if q not in searched_queries]

            if not queries:
                self._emit("search", "No new queries to search — stopping",
                           round=iteration, elapsed=int(time.time() - start))
                break

            self._emit("search", f"Searching {len(queries)} queries...",
                       round=iteration, query_count=len(queries), elapsed=int(time.time() - start))
            all_results = await self.search.search_many(
                queries, self.config.max_results_per_source
            )
            searched_queries.update(queries)

            # Deduplicate against already-fetched URLs
            known_urls = {f["url"] for f in findings}
            new_results = [r for r in all_results if r.url not in known_urls]
            self._emit("search", f"{len(new_results)} new unique results (RRF fused)",
                       round=iteration, results_count=len(new_results), elapsed=int(time.time() - start))

            if not new_results:
                if getattr(self.search, "last_round_blackout", False):
                    self._emit("search", "Every search provider failed this round "
                               "— search outage, not 'no results'",
                               round=iteration, elapsed=int(time.time() - start))
                    break
                self._emit("search", "No new results — stopping",
                           round=iteration, elapsed=int(time.time() - start))
                break

            # Evaluate relevance
            self._emit("evaluate", "Evaluating relevance...",
                       round=iteration, elapsed=int(time.time() - start))
            top = await self._evaluate(query, new_results[:40])
            self._emit("evaluate", f"{len(top)} results pass relevance filter",
                       round=iteration, relevant_count=len(top), elapsed=int(time.time() - start))

            if not top:
                sub_qs = []
                cross_qs = []
                continue

            # Extract content
            fetch_urls = [r.url for r in top[: self.config.max_pages_to_fetch]]
            self._emit("extract", f"Extracting content from {len(fetch_urls)} URLs...",
                       round=iteration, url_count=len(fetch_urls), elapsed=int(time.time() - start))
            contents = await extract_multiple(fetch_urls)
            self._emit("extract", f"{len(contents)}/{len(fetch_urls)} extracted",
                       round=iteration, extracted=len(contents), elapsed=int(time.time() - start))

            # Build findings
            new_count = 0
            for r in top:
                content = contents.get(r.url)
                if not content:
                    # Fall back to snippet if extraction failed
                    content = r.snippet if len(r.snippet) > 50 else None
                if content:
                    src_num = len(source_index) + 1
                    findings.append({
                        "title": r.title,
                        "url": r.url,
                        "source": r.source,
                        "content": content,
                        "round": iteration,
                        "source_num": src_num,
                    })
                    source_index.append({
                        "num": src_num,
                        "title": r.title,
                        "url": r.url,
                        "engine": r.source,
                    })
                    new_count += 1

            self._emit("extract", f"+{new_count} findings (total: {len(findings)})",
                       round=iteration, findings_count=len(findings), elapsed=int(time.time() - start))

            # Save scratchpad
            self._save_scratchpad(out_dir, query, findings, iteration)

            # Gap analysis
            self._emit("gaps", "Analyzing gaps...",
                       round=iteration, elapsed=int(time.time() - start))
            gaps = await self._gap_analysis(query, findings, searched_queries)
            confidence = gaps.get("confidence", 0.0)
            should_continue = gaps.get("should_continue", True)
            self._emit("gaps", (
                f"Confidence: {confidence:.0%} | "
                f"Continue: {should_continue} | "
                f"Gaps: {len(gaps.get('gaps', []))}"
            ), round=iteration, confidence=confidence,
               gap_count=len(gaps.get("gaps", [])), elapsed=int(time.time() - start))

            if not should_continue:
                self._emit("gaps", "Research sufficiently comprehensive — stopping",
                           round=iteration, confidence=confidence, elapsed=int(time.time() - start))
                break

            # Prepare next round — gaps feed new queries + reformulations
            sub_qs = _as_str_list(gaps.get("new_queries"))
            reformulations = _as_str_list(gaps.get("reformulations"))
            cross_qs = _as_str_list(gaps.get("cross_domain_suggestions"))

        # A run that consulted NOTHING because search was down is not completed
        # research. Synthesising here would produce a well-formed report over zero
        # sources and emit "done" — the outage would reach the user as an answer,
        # and the knowledge push would offer it as a finding. Fail loudly instead.
        if not findings and getattr(self.search, "blackouts", 0):
            raise SearchUnavailable(
                f"all search providers failed ({len(self.search.outages)} errors "
                f"across {len(self.search.active_names)} providers) — no sources "
                f"could be consulted"
            )

        # ── Phase 3: Synthesize ────────────────────────────────────
        self._emit("synthesize", f"Synthesizing {len(findings)} findings...",
                   findings_count=len(findings), sources_count=len(source_index),
                   elapsed=int(time.time() - start))
        report = await self._synthesize(query, findings, source_index)

        # ── Phase 4: Verify (optional) ─────────────────────────────
        verifications: list[dict] = []
        if self.config.verify_claims and findings:
            self._emit("verify", "Cross-referencing key claims...",
                       elapsed=int(time.time() - start))
            verification, verifications = await self._verify(report, findings)
            if verification:
                report += "\n\n## Claim Verification\n\n" + verification

        # ── Save ───────────────────────────────────────────────────
        report_path = out_dir / "comprehensive-report.md"
        report_path.write_text(report, encoding="utf-8")

        # Save source index as JSON
        (out_dir / "sources.json").write_text(
            json.dumps(source_index, indent=2, ensure_ascii=False), encoding="utf-8"
        )

        # Structured twin of the report. The markdown is for humans; this is
        # what another system (memory layer, dashboard) can consume without
        # parsing prose. Excerpts only — full text stays in scratchpad.md.
        run = {
            "query": query,
            "slug": topic_slug,
            "artifact_version": 1,
            "run_id": run_id,
            "workspace_id": self.config.workspace_id,
            "entry_id": self.config.entry_id,
            "report_sha256": hashlib.sha256(report.encode("utf-8")).hexdigest(),
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "endpoints": {
                tier: str(ep) for tier, ep in self.config.tier_endpoints().items()
            },
            "rounds": iteration,
            "elapsed_seconds": int(time.time() - start),
            "report_path": str(report_path),
            "sources": source_index,
            "findings": [
                {
                    "source_num": f["source_num"],
                    "title": f["title"],
                    "url": f["url"],
                    "engine": f["source"],
                    "round": f["round"],
                    "excerpt": f["content"][:600],
                }
                for f in findings
            ],
            "verifications": verifications,
        }
        marker = out_dir / "research.json.tmp"
        marker.write_text(
            json.dumps(run, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        marker.replace(out_dir / "research.json")

        elapsed_total = int(time.time() - start)
        self._emit("done", (
            f"Research complete in {elapsed_total}s — "
            f"{iteration} rounds, {len(findings)} sources consulted"
        ), rounds=iteration, findings_count=len(findings),
           sources_count=len(source_index), elapsed=elapsed_total, output_dir=str(out_dir))

        return report

    # ── Internal pipeline steps ────────────────────────────────────

    async def _decompose(self, query: str) -> dict:
        """Break query into sub-queries + cross-domain queries."""
        fallback = {"sub_queries": [query], "cross_domain_queries": [], "key_entities": []}
        try:
            data = await self.llm.generate_json(
                DECOMPOSE_QUERY.format(query=query),
                system=SYSTEM_RESEARCHER,
                task_hint="decompose",
            )
            return _as_dict(data, fallback)
        except (RuntimeError, *BAD_SHAPE) as e:
            logger.warning("Decomposition failed: %s — using query as-is", e)
            return fallback

    async def _evaluate(
        self, query: str, results: list[SearchResult]
    ) -> list[SearchResult]:
        """LLM-based relevance scoring of search results."""
        if not results:
            return []

        # Format results for the LLM
        results_text = "\n".join(
            f"[{i}] {r.title}\n    {r.url}\n    {r.snippet[:200]}"
            for i, r in enumerate(results)
        )

        try:
            data = await self.llm.generate_json(
                EVALUATE_RESULTS.format(query=query, results_text=results_text),
                system=SYSTEM_RESEARCHER,
                task_hint="evaluate",
            )
            keep_indices = _kept_indices(data)
            kept = [r for i, r in enumerate(results) if i in keep_indices]
            if not kept:
                logger.warning("Evaluation kept nothing — falling back to top RRF")
                return results[:15]
            return kept
        except (RuntimeError, *BAD_SHAPE) as e:
            logger.warning("Evaluation failed: %s — keeping top results by RRF", e)
            return results[:15]

    async def _gap_analysis(
        self,
        query: str,
        findings: list[dict],
        searched: set[str],
    ) -> dict:
        """Identify what's still missing and generate follow-up queries."""
        # Build a compact summary of findings
        summary_parts = []
        for f in findings[-20:]:  # Last 20 to keep context manageable
            summary_parts.append(
                f"- [{f['source_num']}] {f['title']}: {f['content'][:200]}..."
            )
        findings_summary = "\n".join(summary_parts)
        searched_str = ", ".join(list(searched)[:20])

        try:
            data = await self.llm.generate_json(
                GAP_ANALYSIS.format(
                    query=query,
                    searched=searched_str,
                    findings_summary=findings_summary,
                ),
                system=SYSTEM_RESEARCHER,
                task_hint="gap_analysis",
            )
            return _as_dict(data, {"should_continue": False, "confidence": 0.5})
        except (ValueError, RuntimeError, *BAD_SHAPE) as e:
            logger.warning("Gap analysis failed: %s — stopping", e)
            return {"should_continue": False, "confidence": 0.5}

    async def _synthesize(
        self,
        query: str,
        findings: list[dict],
        source_index: list[dict],
    ) -> str:
        """Two-step synthesis: batch summarize → final report."""
        budget = self.config.context_chars
        # Per-finding budget: leave room for prompt overhead
        per_finding = max(1000, int((budget * 0.7) / max(len(findings), 1)))
        batch_size = 5
        summaries: list[str] = []

        for i in range(0, len(findings), batch_size):
            batch = findings[i : i + batch_size]
            batch_text = "\n\n---\n\n".join(
                f"[{f['source_num']}] {f['title']} ({f['url']})\n{f['content'][:per_finding]}"
                for f in batch
            )
            try:
                summary = await self.llm.generate(
                    SUMMARIZE_BATCH.format(query=query, batch_text=batch_text),
                    system=SYSTEM_RESEARCHER,
                    task_hint="summarize",
                )
                summaries.append(summary)
            except RuntimeError as e:
                logger.warning("Batch summary failed: %s", e)
                # Fallback: use raw snippets
                summaries.append(batch_text[:2000])

        # Step 2: Final synthesis from summaries
        all_summaries = "\n\n---\n\n".join(summaries)
        source_list = "\n".join(
            f"[{s['num']}] {s['title']} — {s['url']}" for s in source_index
        )

        report = await self.llm.generate(
            SYNTHESIZE_REPORT.format(
                query=query,
                source_count=len(source_index),
                findings=all_summaries,
                source_list=source_list,
            ),
            system=SYSTEM_RESEARCHER,
            task_hint="synthesize",
        )
        return report

    async def _verify(
        self, report: str, findings: list[dict]
    ) -> tuple[str | None, list[dict]]:
        """Cross-reference key claims against source content."""
        budget = self.config.context_chars
        report_excerpt = report[:int(budget * 0.3)]
        per_source = max(500, int((budget * 0.4) / min(len(findings), 15)))
        source_content = "\n\n".join(
            f"[{f['source_num']}] {f['content'][:per_source]}"
            for f in findings[:15]
        )

        try:
            data = await self.llm.generate_json(
                VERIFY_CLAIMS.format(
                    report_excerpt=report_excerpt,
                    source_content=source_content,
                ),
                system=SYSTEM_RESEARCHER,
                task_hint="verify",
            )
            verifications = _as_dict(data, {}).get("verifications", [])
            if not verifications:
                return None, []

            entries = []
            lines = []
            status_emoji = {
                "VERIFIED": "V",
                "LIKELY": "~",
                "UNVERIFIED": "?",
                "CONTRADICTED": "X",
            }
            for v in verifications:
                if not isinstance(v, dict):
                    continue
                icon = status_emoji.get(v.get("status", ""), "?")
                sources = v.get("sources", [])
                entries.append({
                    "claim": v.get("claim", ""),
                    "status": v.get("status", "UNVERIFIED"),
                    "sources": [s for s in sources if isinstance(s, (int, str))],
                    "note": v.get("note", ""),
                })
                src_str = f" (sources: {', '.join(str(s) for s in sources)})" if sources else ""
                lines.append(
                    f"- **[{icon}]** {v.get('claim', '?')}{src_str}\n"
                    f"  {v.get('note', '')}"
                )
            return ("\n".join(lines) if lines else None), entries
        except (RuntimeError, *BAD_SHAPE) as e:
            logger.warning("Verification failed: %s", e)
            return None, []

    # ── Helpers ─────────────────────────────────────────────────────

    def _save_scratchpad(
        self,
        out_dir: Path,
        query: str,
        findings: list[dict],
        iteration: int,
    ):
        """Append current findings to scratchpad (monitorable by aligner)."""
        path = out_dir / "scratchpad.md"
        lines = [f"# Scratchpad — {query}\n\n"]
        current_round = None
        for f in findings:
            if f["round"] != current_round:
                current_round = f["round"]
                lines.append(f"\n## Round {current_round}\n\n")
            lines.append(
                f"### [{f['source_num']}] {f['title']}\n"
                f"- Source: {f['source']} | URL: {f['url']}\n"
                f"- {f['content'][:300]}...\n\n"
            )
        path.write_text("".join(lines), encoding="utf-8")

    async def close(self):
        await self.llm.close()


def _slugify(text: str) -> str:
    """Convert text to filesystem-safe slug."""
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    return text[:60].rstrip("-")
