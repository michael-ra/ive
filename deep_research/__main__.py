"""CLI entry point for deep-research with human-in-the-loop steering.

Subcommands:
    deep-research research "query"        — Run deep research
    deep-research investigate <topic>     — Generate implementation plan from research
    deep-research align <topic>           — Run alignment monitor against codebase
    deep-research profile [--dir .]       — Generate codebase profile
    deep-research status <topic>          — Show live status of research-in-progress

Human-in-the-loop:
    During research, drop a file called `steer.md` into the topic directory
    with your feedback. The research loop picks it up on the next iteration
    and adjusts course. Delete the file after it's been consumed.

    Or use --interactive mode for a live terminal steering interface.
"""

import argparse
import asyncio
import logging
import os
import sys
import time


def main():
    parser = argparse.ArgumentParser(
        prog="deep-research",
        description="Self-hosted deep research engine — quota-free, Perplexity-grade",
    )
    sub = parser.add_subparsers(dest="command")

    # ── research ───────────────────────────────────────────────────
    p_research = sub.add_parser(
        "research", aliases=["r"],
        help="Run deep research on a topic",
    )
    p_research.add_argument("query", help="Research question")
    p_research.add_argument("--model", default=None)
    p_research.add_argument("--llm-url", default=None)
    p_research.add_argument("--llm-key", default=None)
    p_research.add_argument("--time-limit", type=int, default=None, help="Minutes (default: 30)")
    p_research.add_argument("--max-iterations", type=int, default=None)
    p_research.add_argument("--output-dir", default=None)
    p_research.add_argument("--brave-key", default=None)
    p_research.add_argument("--searxng", default=None)
    p_research.add_argument("--no-cross-domain", action="store_true")
    p_research.add_argument("--no-verify", action="store_true")
    p_research.add_argument(
        "--codebase-dir", default=None,
        help="Path to codebase root — enables inline alignment checks each round",
    )
    p_research.add_argument(
        "--interactive", "-i", action="store_true",
        help="Enable interactive steering — pause after each round for feedback",
    )
    p_research.add_argument("--verbose", "-v", action="store_true")
    p_research.add_argument(
        "--auto-route", action="store_true",
        help="Auto-discover Ollama models and route tasks to right model tier",
    )

    # ── investigate ────────────────────────────────────────────────
    p_investigate = sub.add_parser(
        "investigate", aliases=["i"],
        help="Generate implementation plan from research output",
    )
    p_investigate.add_argument("topic_dir", help="Path to research topic directory")
    p_investigate.add_argument("--codebase-dir", default=".", help="Codebase root (default: .)")
    p_investigate.add_argument("--model", default=None)
    p_investigate.add_argument("--llm-url", default=None)
    p_investigate.add_argument("--llm-key", default=None)
    p_investigate.add_argument("--verbose", "-v", action="store_true")

    # ── align ──────────────────────────────────────────────────────
    p_align = sub.add_parser(
        "align", aliases=["a"],
        help="Run alignment monitor against codebase (background)",
    )
    p_align.add_argument("topic_dir", help="Path to research topic directory")
    p_align.add_argument("--codebase-dir", default=".", help="Codebase root (default: .)")
    p_align.add_argument("--poll-interval", type=int, default=60, help="Seconds between checks")
    p_align.add_argument("--max-iterations", type=int, default=10)
    p_align.add_argument("--model", default=None)
    p_align.add_argument("--llm-url", default=None)
    p_align.add_argument("--llm-key", default=None)
    p_align.add_argument("--verbose", "-v", action="store_true")

    # ── gather (brain/hands split — search+extract only, no LLM) ──
    p_gather = sub.add_parser(
        "gather", aliases=["g"],
        help="Search + extract only (no LLM). For hybrid mode where Claude/Gemini is the brain.",
    )
    p_gather.add_argument("-q", "--queries", nargs="+", required=True, help="Search queries")
    p_gather.add_argument("-o", "--output", required=True, help="Output JSON file path")
    p_gather.add_argument("--max-extract", type=int, default=15, help="Max URLs to extract")
    p_gather.add_argument("--brave-key", default=None)
    p_gather.add_argument("--searxng", default=None)
    p_gather.add_argument("--verbose", "-v", action="store_true")
    p_gather.add_argument(
        "--summary", action="store_true",
        help="Also print compact markdown summary to stdout (for piping to Claude)",
    )

    # ── profile ────────────────────────────────────────────────────
    p_profile = sub.add_parser(
        "profile", aliases=["p"],
        help="Generate codebase profile (no LLM needed)",
    )
    p_profile.add_argument("--dir", default=".", help="Codebase root (default: .)")
    p_profile.add_argument("--output", default=None, help="Output file (default: stdout)")

    # ── status ─────────────────────────────────────────────────────
    p_status = sub.add_parser(
        "status", aliases=["s"],
        help="Show status of research-in-progress",
    )
    p_status.add_argument("topic_dir", help="Path to research topic directory")

    # ── backward compat: bare query ────────────────────────────────
    # If no subcommand, treat first positional as research query
    args, remaining = parser.parse_known_args()

    if args.command is None:
        if remaining:
            # Backward compat: deep-research "query"
            sys.argv = [sys.argv[0], "research"] + remaining
            args = parser.parse_args()
        else:
            parser.print_help()
            sys.exit(0)

    # ── Dispatch ───────────────────────────────────────────────────

    if args.command in ("research", "r"):
        _cmd_research(args)
    elif args.command in ("investigate", "i"):
        _cmd_investigate(args)
    elif args.command in ("align", "a"):
        _cmd_align(args)
    elif args.command in ("profile", "p"):
        _cmd_profile(args)
    elif args.command in ("gather", "g"):
        _cmd_gather(args)
    elif args.command in ("status", "s"):
        _cmd_status(args)
    else:
        parser.print_help()


# ═══════════════════════════════════════════════════════════════════
# Command implementations
# ═══════════════════════════════════════════════════════════════════


def _build_config(args):
    from .config import DeepResearchConfig
    config = DeepResearchConfig.from_env()
    if getattr(args, "model", None):
        config.llm_model = args.model
    if getattr(args, "llm_url", None):
        config.llm_base_url = args.llm_url
    if getattr(args, "llm_key", None):
        config.llm_api_key = args.llm_key
    if getattr(args, "time_limit", None):
        config.time_limit_minutes = args.time_limit
    if getattr(args, "max_iterations", None):
        config.max_iterations = args.max_iterations
    if getattr(args, "output_dir", None):
        config.output_dir = args.output_dir
    if getattr(args, "brave_key", None):
        config.brave_api_key = args.brave_key
    if getattr(args, "searxng", None):
        config.searxng_url = args.searxng
    if getattr(args, "no_cross_domain", False):
        config.cross_domain = False
    if getattr(args, "no_verify", False):
        config.verify_claims = False
    return config


def _setup_logging(verbose: bool):
    level = logging.DEBUG if verbose else logging.WARNING
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )


def _cmd_research(args):
    _setup_logging(args.verbose)
    config = _build_config(args)

    print()
    print("Deep Research v0.1.0 — self-hosted, quota-free")
    print("=" * 50)

    from .researcher import DeepResearcher
    from .aligner import Aligner
    from .codebase import profile_codebase
    from .llm import LLMClient

    # Auto-route: discover available models and assign tiers
    router = None
    if getattr(args, "auto_route", False):
        from .model_router import ModelRouter
        router = ModelRouter(base_url=config.llm_base_url.replace("/v1", ""))
        asyncio.run(router.discover())
        if router._discovered:
            print(router.describe())
        else:
            print("Auto-route: could not discover models, using default")
            router = None

    llm = LLMClient(config, router=router)

    # Build codebase context if --codebase-dir provided (enables inline alignment)
    codebase_context = None
    if args.codebase_dir:
        print(f"Profiling codebase at {args.codebase_dir}...")
        codebase_context = profile_codebase(args.codebase_dir)

    researcher = DeepResearcher(config=config, llm=llm)

    # If interactive mode, wrap the research with steering hooks
    if args.interactive:
        researcher.progress = _interactive_progress
        # Monkey-patch _gap_analysis to pause for human input
        original_gap = researcher._gap_analysis

        async def _gap_with_steering(query, findings, searched):
            result = await original_gap(query, findings, searched)
            # Check for steer.md
            steer = _check_steer_file(config.output_dir, query)
            if steer:
                print(f"\n  [HUMAN STEERING] Incorporating feedback...")
                # Merge human queries into gap analysis
                result.setdefault("new_queries", []).extend(
                    [q.strip() for q in steer.split("\n") if q.strip() and not q.startswith("#")]
                )
                result["should_continue"] = True
            else:
                # Interactive pause
                feedback = _prompt_feedback()
                if feedback:
                    result.setdefault("new_queries", []).extend(
                        [q.strip() for q in feedback.split("\n") if q.strip()]
                    )
                    result["should_continue"] = True
                elif feedback == "":
                    pass  # Just continue
                # None means user typed 'q' to quit
                elif feedback is None:
                    result["should_continue"] = False
            return result

        researcher._gap_analysis = _gap_with_steering

    # If codebase context, hook aligner into each round
    if codebase_context:
        aligner = Aligner(config=config, llm=researcher.llm)
        original_gap = researcher._gap_analysis

        async def _gap_with_alignment(query, findings, searched):
            result = await original_gap(query, findings, searched)
            # Run inline alignment check
            from .researcher import _slugify
            from pathlib import Path
            scratchpad_path = Path(config.output_dir) / _slugify(query) / "scratchpad.md"
            if scratchpad_path.exists():
                scratchpad = scratchpad_path.read_text()
                alignment = await aligner.check(scratchpad, codebase_context, query)
                # Inject priority queries from aligner
                pq = alignment.get("priority_queries", [])
                if pq:
                    result.setdefault("new_queries", []).extend(pq)
                    print(f"    [ALIGNER] Injected {len(pq)} priority queries")
                mis = alignment.get("misalignments", [])
                if mis:
                    print(f"    [ALIGNER] {len(mis)} misalignments detected:")
                    for m in mis:
                        print(f"      - {m}")
            return result

        researcher._gap_analysis = _gap_with_alignment

    try:
        asyncio.run(_run_research(researcher, args.query))
    except KeyboardInterrupt:
        print("\nInterrupted — partial results saved")
        sys.exit(1)
    except RuntimeError as e:
        if "Cannot connect" in str(e) or "Connection refused" in str(e):
            print(f"\nError: Cannot connect to LLM at {config.llm_base_url}")
            print("Make sure Ollama is running: ollama serve")
            sys.exit(1)
        raise

    print("\nDone.")


def _cmd_investigate(args):
    _setup_logging(args.verbose)
    config = _build_config(args)

    print()
    print("Deep Investigate — research → actionable plan")
    print("=" * 50)

    from .investigator import Investigator
    inv = Investigator(config=config)

    try:
        asyncio.run(_run_investigate(inv, args.topic_dir, args.codebase_dir))
    except KeyboardInterrupt:
        print("\nInterrupted")
        sys.exit(1)
    except FileNotFoundError as e:
        print(f"\nError: {e}")
        sys.exit(1)

    print("\nDone.")


def _cmd_align(args):
    _setup_logging(args.verbose)
    config = _build_config(args)

    print()
    print("Deep Aligner — monitoring research alignment")
    print("=" * 50)

    from .aligner import Aligner
    al = Aligner(config=config)

    try:
        asyncio.run(_run_align(
            al, args.topic_dir, args.codebase_dir,
            args.poll_interval, args.max_iterations,
        ))
    except KeyboardInterrupt:
        print("\nAligner stopped")
        sys.exit(0)

    print("\nDone.")


def _cmd_gather(args):
    """Search + extract only. Zero LLM calls. For hybrid brain/hands mode."""
    _setup_logging(args.verbose)
    config = _build_config(args)

    print()
    print("Deep Research — Gather Mode (no LLM, search + extract only)")
    print("=" * 50)
    print(f"Queries: {args.queries}")
    print(f"Output: {args.output}")

    from .gatherer import gather, summarize_results
    from pathlib import Path

    try:
        result = asyncio.run(_run_gather(
            args.queries, config, args.max_extract, Path(args.output),
        ))
    except KeyboardInterrupt:
        print("\nInterrupted")
        sys.exit(1)

    stats = result["stats"]
    print(
        f"\nGathered: {stats['total_results']} results, "
        f"{stats['extracted']} extracted, "
        f"{stats['elapsed_seconds']}s"
    )
    print(f"Output: {args.output}")

    if args.summary:
        print("\n" + "=" * 50)
        print(summarize_results(result))

    print("\nDone.")


async def _run_gather(queries, config, max_extract, output_path):
    from .gatherer import gather
    return await gather(queries, config=config, max_extract=max_extract, output_path=output_path)


def _cmd_profile(args):
    from .codebase import profile_codebase
    profile = profile_codebase(args.dir)
    if args.output:
        from pathlib import Path
        Path(args.output).write_text(profile, encoding="utf-8")
        print(f"Profile written to {args.output}")
    else:
        print(profile)


def _cmd_status(args):
    from pathlib import Path
    topic = Path(args.topic_dir)

    if not topic.exists():
        print(f"No research directory at {topic}")
        sys.exit(1)

    print(f"\nResearch status: {topic.name}")
    print("-" * 40)

    scratchpad = topic / "scratchpad.md"
    report = topic / "comprehensive-report.md"
    plan = topic / "actionable-plan.md"
    hints = topic / "aligner-hints.md"
    steer = topic / "steer.md"

    files = [
        (scratchpad, "Scratchpad"),
        (report, "Report"),
        (plan, "Actionable Plan"),
        (hints, "Aligner Hints"),
        (steer, "Human Steering (pending)"),
    ]

    for path, label in files:
        if path.exists():
            size = path.stat().st_size
            mtime = time.strftime("%H:%M:%S", time.localtime(path.stat().st_mtime))
            print(f"  [{label}] {size:,} bytes, last modified {mtime}")
        else:
            print(f"  [{label}] not yet created")

    # Show last few lines of scratchpad
    if scratchpad.exists():
        lines = scratchpad.read_text().strip().split("\n")
        # Count rounds
        rounds = sum(1 for l in lines if l.startswith("## Round"))
        findings = sum(1 for l in lines if l.startswith("### ["))
        print(f"\n  Progress: {rounds} rounds, {findings} findings")


# ═══════════════════════════════════════════════════════════════════
# Human-in-the-loop helpers
# ═══════════════════════════════════════════════════════════════════

def _interactive_progress(msg: str):
    """Progress callback for interactive mode — adds visual flair."""
    print(msg)


def _prompt_feedback() -> str | None:
    """Prompt user for steering feedback between rounds.

    Returns:
        str: User's feedback (search queries, one per line)
        "": Empty string (just continue)
        None: User wants to stop
    """
    print()
    print("  ┌─ STEERING POINT ──────────────────────────────────────┐")
    print("  │ Enter search queries to steer next round (one/line)   │")
    print("  │ Press ENTER to continue automatically                 │")
    print("  │ Type 'q' to stop research and synthesize              │")
    print("  └──────────────────────────────────────────────────────┘")

    lines = []
    try:
        while True:
            line = input("  > ").strip()
            if line.lower() == "q":
                return None
            if line == "" and not lines:
                return ""
            if line == "":
                break
            lines.append(line)
    except EOFError:
        return ""

    return "\n".join(lines) if lines else ""


def _check_steer_file(output_dir: str, query: str) -> str | None:
    """Check for a steer.md file dropped by the user."""
    from .researcher import _slugify
    from pathlib import Path
    steer_path = Path(output_dir) / _slugify(query) / "steer.md"
    if steer_path.exists():
        content = steer_path.read_text(encoding="utf-8")
        steer_path.unlink()  # Consume it
        return content
    return None


# ═══════════════════════════════════════════════════════════════════
# Async runners
# ═══════════════════════════════════════════════════════════════════

async def _run_research(researcher, query: str):
    try:
        return await researcher.research(query)
    finally:
        await researcher.close()


async def _run_investigate(investigator, topic_dir, codebase_dir):
    try:
        return await investigator.investigate(topic_dir, codebase_dir=codebase_dir)
    finally:
        await investigator.close()


async def _run_align(aligner, topic_dir, codebase_dir, poll_interval, max_iters):
    try:
        return await aligner.watch(
            topic_dir, codebase_dir=codebase_dir,
            poll_interval=poll_interval, max_iterations=max_iters,
        )
    finally:
        await aligner.close()


if __name__ == "__main__":
    main()
