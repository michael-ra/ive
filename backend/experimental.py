"""Experimental feature flags and their associated prompt fragments.

Everything in this module is gated behind an opt-in app_settings row. If a
user hasn't explicitly enabled a flag from the dashboard, nothing here takes
effect — no prompts are modified, no tools are injected, no behavior changes.

Adding a new experimental feature:
  1. Add an entry to EXPERIMENTAL_FEATURES with metadata the UI can render.
  2. If the feature modifies the system prompt, define the text fragment here.
  3. Wire a check in the relevant code path (e.g. PTY start) that reads the
     flag from app_settings and only activates behavior when == "on".
  4. The /api/settings endpoint auto-surfaces the flag to the frontend.

Every experimental feature MUST declare `modifies_prompt: bool` so the UI
can warn the user appropriately. "This feature adds text to the system
prompt" is the single most important thing a user should know before they
flip the toggle.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


# ─── The checkpoint protocol canary ──────────────────────────────────────
#
# When `experimental_checkpoint_protocol` is enabled, Commander appends this
# fragment to every session's system prompt. It instructs the model to call
# the `mcp__commander__checkpoint` tool at key decision points so Commander
# (and plugins) can observe or influence the model's mid-turn reasoning.
#
# This gives Commander an approximate equivalent of Gemini CLI's BeforeModel
# hook on Claude Code sessions via cooperative intercept. It is cooperative,
# not enforced — the model is instructed to call the tool but has no hard
# guarantee it will. The gain is read-write intercept capability; the cost
# is extra tokens (system prompt + periodic tool calls).

MODEL_SWITCHING_PROMPT = """## Commander Dual Model Switching (experimental)

You have access to the `mcp__commander__switch_model` tool that lets you change
your own model mid-conversation. Use this to optimize cost and capability:

### When to switch models

**Planning phase** (use your plan_model — higher capability):
  - Reading and understanding requirements
  - Exploring codebases, tracing dependencies
  - Architectural decisions, designing solutions
  - Writing implementation plans

**Execution phase** (use your execute_model — faster/cheaper):
  - Writing code, making edits
  - Running tools (file reads, grep, etc.)
  - Executing tests and builds
  - Applying known patterns

### How to switch

Call `mcp__commander__switch_model` with the model name:
  - Claude models: "opus", "sonnet", "haiku"
  - Gemini models: "gemini-2.5-pro", "gemini-2.5-flash"

### Protocol

1. Start each task in your plan_model ({plan_model})
2. Once you have a clear plan, call switch_model to your execute_model ({execute_model})
3. After execution is complete, switch back to your plan_model for review
4. For simple follow-ups that don't need planning, stay in execute_model

Do NOT switch models excessively — each switch adds a few seconds of latency.
Switch at natural phase boundaries, not between individual tool calls."""


CHECKPOINT_PROTOCOL_PROMPT = """## Commander Checkpoint Protocol (experimental)

Before major reasoning transitions, call the `mcp__commander__checkpoint`
tool with a short JSON payload describing what you're about to do. The tool
will respond with either `{"action": "proceed"}` or updated guidance you
must incorporate before continuing.

Call checkpoint when:
  • You are about to choose between multiple plausible tool calls
  • You have just received unexpected output from a tool and need to pivot
  • You are about to make a non-trivial architectural decision
  • You have completed one logical step and are about to start another

Do NOT call checkpoint:
  • For every single line of thinking
  • For trivial reasoning steps
  • When the current turn is nearly complete and no further decisions remain

Payload format:
  {
    "intent": "<one line: what you're about to do>",
    "context": "<optional: any relevant state>",
    "confidence": "low" | "medium" | "high"
  }

Response handling:
  • `{"action": "proceed"}` — continue as planned
  • `{"action": "modify", "guidance": "..."}` — incorporate the guidance
    into your next step before proceeding
  • `{"action": "abort", "reason": "..."}` — stop the current line of
    reasoning and report the reason to the user

This protocol is Commander-specific. Plugins subscribe to checkpoint events
to influence your reasoning without modifying the underlying Claude Code or
Gemini CLI binary."""


# ─── Experimental feature registry ───────────────────────────────────────

@dataclass(frozen=True)
class ExperimentalFeature:
    key: str                            # app_settings key
    label: str                          # short UI label
    description: str                    # 1-2 sentences for the toggle card
    long_description: str               # full explanation for the expanded view
    modifies_prompt: bool               # if True, UI warns prominently
    default_enabled: bool = False
    category: str = "hooks"
    added_in: str = ""                  # commander version / date string


EXPERIMENTAL_FEATURES: dict[str, ExperimentalFeature] = {
    "experimental_avcp_protection": ExperimentalFeature(
        key="experimental_avcp_protection",
        label="Anti-Pwning Protection (AVCP)",
        description=(
            "Supply chain security scanner — intercepts pip install, npm install, "
            "yarn add, etc. and blocks malicious or suspiciously recent packages "
            "before they reach your codebase."
        ),
        long_description=(
            "When enabled, Commander installs a PreToolUse hook into Claude Code "
            "(and BeforeTool on Gemini CLI) that intercepts every package manager "
            "command. Before the install runs, AVCP checks:\n\n"
            "  • Package recency (flagged if published within threshold, default 7 days)\n"
            "  • OSV.dev vulnerability database\n"
            "  • GitHub Advisory Database (known malware)\n"
            "  • npm install script analysis (postinstall hooks with suspicious patterns)\n\n"
            "Decisions:\n"
            "  • block — malware, critical CVEs, or highly suspicious packages are denied\n"
            "  • warn  — install scripts or low-risk anomalies prompt for confirmation\n"
            "  • allow — clean packages pass through with no delay\n\n"
            "Covers: npm, pip, yarn, pnpm, bun, cargo, go, gem, bundle, composer, brew.\n\n"
            "This is the same protection as the standalone anti-vibe-code-pwner tool, "
            "bundled into Commander so you can toggle it without touching shell config.\n\n"
            "Tradeoffs:\n"
            "  • Adds ~1-3s latency to package install commands (API lookups)\n"
            "  • Requires network access to registry APIs and vulnerability databases\n"
            "  • May occasionally flag legitimate recently-published packages\n"
            "  • No effect on direct shell usage outside of Claude Code / Gemini CLI\n\n"
            "Recommended for: any project where AI agents install packages autonomously."
        ),
        modifies_prompt=False,
        default_enabled=False,
        category="security",
        added_in="2026-04-12",
    ),
    "experimental_checkpoint_protocol": ExperimentalFeature(
        key="experimental_checkpoint_protocol",
        label="Mid-turn checkpoint protocol",
        description=(
            "Gives plugins the ability to intercept and influence the model "
            "mid-turn on Claude Code. Approximates Gemini CLI's BeforeModel "
            "hook via a cooperative tool-call pattern."
        ),
        long_description=(
            "When enabled, Commander appends a system prompt fragment to "
            "every new session instructing the model to call a special "
            "`mcp__commander__checkpoint` tool at key reasoning transitions.\n\n"
            "This unlocks mid-turn plugin interception on Claude Code, which "
            "has no native BeforeModel/AfterModel hooks. Gemini CLI already "
            "provides these natively so this flag has no effect on Gemini "
            "sessions.\n\n"
            "⚠ Tradeoffs:\n"
            "  • Adds ~500 tokens to the system prompt of every session.\n"
            "  • Claude will make occasional extra tool calls (billed at the\n"
            "    usual rate) to invoke commander__checkpoint.\n"
            "  • The protocol is cooperative — the model is instructed to\n"
            "    follow it but compliance isn't enforced.\n"
            "  • Existing guidelines + plugin components still stack normally\n"
            "    on top of the checkpoint prompt.\n\n"
            "Recommended for: plugin authors, users experimenting with "
            "cross-CLI plugin portability, or anyone who wants a plugin "
            "hook that fires mid-turn on Claude Code.\n\n"
            "Not recommended for: production workflows sensitive to token "
            "usage, or cases where you want the model to have maximal "
            "freedom with minimum injected context."
        ),
        modifies_prompt=True,
        default_enabled=False,
        category="hooks",
        added_in="2026-04-12",
    ),
    "experimental_model_switching": ExperimentalFeature(
        key="experimental_model_switching",
        label="Dual Model Switching",
        description=(
            "Lets the agent switch its own model mid-conversation via an MCP tool. "
            "Configure a 'plan model' (high capability) and 'execute model' (fast/cheap) "
            "and the agent will cycle between them automatically."
        ),
        long_description=(
            "When enabled, Commander exposes a `switch_model` MCP tool and injects "
            "a system prompt fragment instructing the agent to use different models "
            "for planning vs execution phases.\n\n"
            "Session config adds two optional fields:\n"
            "  - Plan Model: used for reasoning, planning, code review (e.g. opus)\n"
            "  - Execute Model: used for edits, tool calls, builds (e.g. sonnet)\n\n"
            "The agent decides when to switch — Commander just executes the `/model X` "
            "slash command in the PTY and updates the DB.\n\n"
            "Works on both Claude Code and Gemini CLI (both support `/model`).\n\n"
            "⚠ Tradeoffs:\n"
            "  - Adds ~400 tokens to the system prompt of every session\n"
            "  - Each model switch adds ~2-3s latency (PTY command + model load)\n"
            "  - The protocol is cooperative — the agent is instructed to follow it\n"
            "    but compliance isn't enforced\n\n"
            "Recommended for: long-running tasks where you want opus-level planning "
            "but sonnet-level execution costs.\n\n"
            "Not recommended for: short tasks, or when you want a single consistent "
            "model throughout the conversation."
        ),
        modifies_prompt=True,
        default_enabled=False,
        category="models",
        added_in="2026-04-13",
    ),
    "experimental_safety_gate": ExperimentalFeature(
        key="experimental_safety_gate",
        label="Safety Gate",
        description=(
            "General-purpose tool call safety engine — evaluates ALL tool calls "
            "(Bash, Write, Edit, WebFetch, etc.) against configurable rules and "
            "blocks dangerous operations before they execute."
        ),
        long_description=(
            "When enabled, Commander installs a PreToolUse hook (Claude Code) "
            "and BeforeTool hook (Gemini CLI) that intercepts EVERY tool call "
            "and evaluates it against a configurable rule set.\n\n"
            "Built-in rules cover:\n"
            "  • Dangerous commands: rm -rf, mkfs, dd, curl|bash, fork bombs\n"
            "  • Protected paths: .env, .ssh, .git, /etc, credentials\n"
            "  • Destructive git: force push, reset --hard, clean\n"
            "  • SQL injection: DROP TABLE, TRUNCATE\n"
            "  • Network safety: suspicious TLDs, pipe-to-shell downloads\n\n"
            "Two-tier evaluation:\n"
            "  • Tier 1 (local, 0ms): Critical patterns hardcoded in the hook\n"
            "    script — always works, even if Commander is down.\n"
            "  • Tier 2 (API, ~5-20ms): Full rule engine with custom rules,\n"
            "    workspace scoping, and decision logging for learning.\n\n"
            "If Commander is unreachable, Claude Code falls back to 'ask' (the\n"
            "normal permission prompt). Critical rules still work locally.\n\n"
            "The decision learning system observes your approve/deny patterns\n"
            "and proposes auto-rules over time.\n\n"
            "Tradeoffs:\n"
            "  • Adds ~5-20ms latency per tool call (local HTTP round-trip)\n"
            "  • May occasionally flag legitimate commands that match patterns\n"
            "  • Disabled rules still appear in the UI for easy re-enabling\n\n"
            "Complements AVCP (supply chain protection) — AVCP checks package\n"
            "installs, Safety Gate checks everything else. Zero overlap."
        ),
        modifies_prompt=False,
        default_enabled=False,
        category="security",
        added_in="2026-04-16",
    ),
    "experimental_myelin_coordination": ExperimentalFeature(
        key="experimental_myelin_coordination",
        label="Myelin Semantic Coordination",
        description=(
            "Multi-agent conflict detection using semantic similarity. "
            "Prevents concurrent sessions from doing overlapping work by "
            "comparing intent embeddings before destructive tool calls."
        ),
        long_description=(
            "When enabled, Commander uses local embeddings to detect and "
            "resolve conflicts between concurrent sessions working on the "
            "same codebase.\n\n"
            "How it works:\n"
            "  • Each session announces its intent (what the user asked)\n"
            "  • Before Write/Edit, the system checks for semantically\n"
            "    similar tasks in other active sessions\n"
            "  • Cosine similarity ≥0.80 → CONFLICT (blocked)\n"
            "  • 0.65–0.80 → SHARE (proceed + share lessons learned)\n"
            "  • 0.55–0.65 → NOTIFY (proceed + FYI)\n"
            "  • <0.55 → proceed silently\n\n"
            "Uses Commander's built-in embedding system:\n"
            "  • BAAI/bge-small-en-v1.5 via fastembed (384-dim, local CPU)\n"
            "  • No API keys required — everything runs locally\n"
            "  • Embeddings stored in SQLite as JSON float arrays\n\n"
            "When this flag is on, Commander:\n"
            "  1. Sets MYELIN_AGENT_ID env var on every PTY session\n"
            "  2. Installs UserPromptSubmit + PreToolUse coordination\n"
            "     hooks into the CLI settings\n"
            "  3. Checks intent overlap via /coordination/overlap before\n"
            "     destructive tool calls\n\n"
            "The coordination module (ext-repo/myelin/coordination/) "
            "integrates with Commander's event bus and hook system.\n\n"
            "⚠ Tradeoffs:\n"
            "  • First embedding load takes ~2s (33MB ONNX model download)\n"
            "  • Adds ~5ms per overlap check after model is loaded\n"
            "  • May occasionally block legitimate parallel work on\n"
            "    semantically similar (but intentionally separate) tasks\n\n"
            "Recommended for: workspaces with 2+ concurrent sessions "
            "working on the same repo.\n\n"
            "Not recommended for: single-session usage, or workspaces "
            "where sessions always work on unrelated files."
        ),
        modifies_prompt=False,
        default_enabled=False,
        category="coordination",
        added_in="2026-04-14",
    ),
}


def get_feature(key: str) -> Optional[ExperimentalFeature]:
    return EXPERIMENTAL_FEATURES.get(key)


def is_known_feature(key: str) -> bool:
    return key in EXPERIMENTAL_FEATURES


def features_as_dicts() -> list[dict]:
    """JSON-serializable list for the /api/settings/experimental endpoint."""
    return [
        {
            "key": f.key,
            "label": f.label,
            "description": f.description,
            "long_description": f.long_description,
            "modifies_prompt": f.modifies_prompt,
            "default_enabled": f.default_enabled,
            "category": f.category,
            "added_in": f.added_in,
        }
        for f in EXPERIMENTAL_FEATURES.values()
    ]
