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
        default_enabled=True,
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
        default_enabled=True,
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
        default_enabled=True,
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
        default_enabled=True,
        category="security",
        added_in="2026-04-16",
    ),
    "experimental_auto_skill_suggestions": ExperimentalFeature(
        key="experimental_auto_skill_suggestions",
        label="Auto Skill Suggestions",
        description=(
            "Automatically matches skills from the 8000+ skill catalog to your "
            "session context using semantic embeddings and injects the top 3 "
            "as short summaries the agent can discover and load on demand."
        ),
        long_description=(
            "When enabled, Commander embeds the full skills catalog on first use "
            "(name + description per skill) using BAAI/bge-small-en-v1.5. At "
            "session start, it matches the session context (name, purpose, system "
            "prompt) against the index and injects a short summary of the top 3 "
            "matching skills into the system prompt.\n\n"
            "The agent sees skill names and descriptions — not full SKILL.md "
            "content — and can load any skill's full instructions via the "
            "`search_skills` and `get_skill_content` MCP tools.\n\n"
            "How it works:\n"
            "  • First use: background-embeds all 8000+ skills (~20-40s one-time)\n"
            "  • Session start: finds top 3 skills, injects ~100 token summary\n"
            "  • MCP tools: agents can search for more skills mid-conversation\n"
            "  • Skill index is cached in SQLite and memory across restarts\n\n"
            "The `search_skills` and `get_skill_content` MCP tools are always "
            "available on both Commander and Worker MCP servers regardless of "
            "this flag — this toggle only controls the automatic injection "
            "into the system prompt and the real-time WS suggestions.\n\n"
            "⚠ Tradeoffs:\n"
            "  • First embedding run takes ~20-40s (one-time, background)\n"
            "  • Adds ~100 tokens to the system prompt per session\n"
            "  • Uses the same embedding model as coordination/advisor\n\n"
            "Recommended for: discovering useful skills you didn't know existed.\n\n"
            "Not recommended for: sessions where you want minimal system prompt."
        ),
        modifies_prompt=True,
        default_enabled=True,
        category="advisor",
        added_in="2026-04-21",
    ),
    "experimental_doom_loop_detection": ExperimentalFeature(
        key="experimental_doom_loop_detection",
        label="Doom Loop Detection",
        description=(
            "Detects when agents get stuck in repetitive tool call patterns "
            "(same tool 3+ times, A-B-A-B cycles) and injects corrective guidance "
            "to break the loop."
        ),
        long_description=(
            "When enabled, Commander tracks the last 30 tool calls per session "
            "in a sliding window and detects three patterns:\n\n"
            "  1. Consecutive repeats: same tool with identical input 3+ times\n"
            "  2. Length-2 cycles: A→B→A→B pattern (two full repetitions)\n"
            "  3. Length-3 cycles: A→B→C→A→B→C pattern\n\n"
            "When a pattern is detected, Commander:\n"
            "  - Broadcasts a doom_loop_warning WebSocket event to the UI\n"
            "  - Queues a corrective message for delivery to the agent's PTY\n"
            "    at the next idle, telling it to try a fundamentally different\n"
            "    approach\n\n"
            "Warnings are throttled to one per minute per session to avoid\n"
            "flooding the agent.\n\n"
            "Also enforces iteration limits on cascade loops (max 50 iterations)\n"
            "to prevent runaway cascades.\n\n"
            "⚠ Tradeoffs:\n"
            "  - Adds minimal overhead (in-memory deque + hash per tool call)\n"
            "  - The corrective nudge may occasionally interrupt legitimate\n"
            "    repeated operations (e.g. editing many similar files)\n"
            "  - Does not affect pipeline runs (they already have max_iterations)\n\n"
            "Recommended for: long-running autonomous sessions, RALPH mode,\n"
            "and any workflow where agents run unattended."
        ),
        modifies_prompt=False,
        default_enabled=True,
        category="hooks",
        added_in="2026-04-22",
    ),
    "experimental_auto_distill": ExperimentalFeature(
        key="experimental_auto_distill",
        label="Auto-Distill on Exit",
        description=(
            "Automatically extracts reusable artifacts (guidelines, prompts, "
            "cascades, or memory entries) from sessions when they exit cleanly "
            "with enough conversation history."
        ),
        long_description=(
            "When enabled, Commander automatically runs the distill system "
            "when a session exits cleanly (exit code 0) with 5+ conversation "
            "turns. The artifact type is auto-detected based on conversation "
            "content:\n\n"
            "  - Sessions with corrections/feedback → feedback memory entry\n"
            "  - Multi-step workflows → cascade\n"
            "  - Convention/pattern discussions → guideline\n"
            "  - Reusable tasks → prompt template\n\n"
            "Results appear in the notification inbox like manual distills. "
            "You can preview and save them as reusable artifacts.\n\n"
            "Gate conditions (all must be true):\n"
            "  - Clean exit (exit code 0)\n"
            "  - 5+ conversation turns\n"
            "  - Session type is worker or default (not commander/tester)\n"
            "  - Not a throwaway worktree/branch session\n\n"
            "⚠ Tradeoffs:\n"
            "  - Each auto-distill fires a background LLM call (billed normally)\n"
            "  - Short/trivial sessions may produce low-quality artifacts\n"
            "  - Results may accumulate in inbox if not reviewed\n\n"
            "Recommended for: teams that want to passively build up a library "
            "of guidelines and prompts from their daily work."
        ),
        modifies_prompt=False,
        default_enabled=True,
        category="advisor",
        added_in="2026-04-22",
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
        default_enabled=True,
        category="coordination",
        added_in="2026-04-14",
    ),
    "experimental_auto_auth_cycling": ExperimentalFeature(
        key="experimental_auto_auth_cycling",
        label="Auto Auth Cycling",
        description=(
            "Automatically switches to the next available account when a "
            "session hits its usage quota, and optionally uses Playwright "
            "to refresh expired OAuth tokens headlessly."
        ),
        long_description=(
            "When enabled, Commander intercepts quota-exceeded events and "
            "automatically:\n\n"
            "  1. Marks the exhausted account with a 4-hour cooldown\n"
            "  2. Selects the next active account (LRU order)\n"
            "  3. Stops the current PTY and restarts it with the new account\n"
            "  4. Shows a notification so you know what happened\n\n"
            "The session resumes seamlessly on a fresh account with no manual "
            "intervention required.\n\n"
            "**Playwright integration (optional)**\n\n"
            "For OAuth accounts, you can set up a Playwright browser context "
            "per account via Account Manager → 'Setup browser'. This saves "
            "your login cookies so Commander can re-authenticate headlessly "
            "when tokens expire:\n\n"
            "  • First time: visible browser opens — log in manually once\n"
            "  • After that: Playwright re-runs `claude auth login` headlessly\n"
            "    using stored cookies, auto-completing the OAuth flow\n\n"
            "Accounts without a Playwright context still cycle normally — they "
            "just can't auto-refresh expired tokens.\n\n"
            "Tradeoffs:\n"
            "  • Requires 2+ accounts configured in Account Manager\n"
            "  • Playwright features require: pip3 install playwright && "
            "playwright install chromium\n"
            "  • Session continuity depends on the CLI's --resume capability\n"
            "  • Browser cookies may expire; re-run 'Setup browser' if headless "
            "auth starts failing\n\n"
            "Recommended for: power users with multiple Claude subscriptions "
            "who want uninterrupted long-running sessions."
        ),
        modifies_prompt=False,
        default_enabled=True,
        category="accounts",
        added_in="2026-04-24",
    ),
    "experimental_stop_reflection": ExperimentalFeature(
        key="experimental_stop_reflection",
        label="Stop-hook reflection nudge",
        description=(
            "When a session finishes a turn, Commander asks the agent: "
            "'Did this turn surface anything worth save_memory / update_digest "
            "/ coord_check_overlap? If so, do it now.' Re-engages the model "
            "via Claude Code's Stop hook decision API."
        ),
        long_description=(
            "Many of Commander's worker-to-worker tools (save_memory, "
            "update_digest, coord_check_overlap, headsup, blocking_bulletin) "
            "are advertised in the system prompt but rarely fire — agents "
            "tend to stop the moment the user's literal question is answered. "
            "This flag installs a Stop-hook reflection prompt that nudges "
            "the model to consider those tools after every meaningful turn.\n\n"
            "Mechanism:\n"
            "  • At PostToolUse, Commander increments a per-session "
            "tool_uses_since_reflection counter.\n"
            "  • At Stop, if ≥ 3 tools fired since the last reflection AND it "
            "has been at least 5 minutes since the last nudge, Commander "
            "returns {\"decision\":\"block\",\"reason\":...} to Claude Code.\n"
            "  • Claude Code re-engages the model with the reflection prompt; "
            "the agent decides whether to call any tool.\n"
            "  • Default action in the prompt is 'do nothing' — most turns "
            "produce nothing worth persisting.\n\n"
            "Tradeoffs:\n"
            "  • Adds one extra round-trip after meaningful turns (billed at "
            "the usual rate). Throttle keeps it to once per ~5 min per session.\n"
            "  • Short clarifying turns (< 3 tool uses) are skipped, so chat-only "
            "sessions are unaffected.\n"
            "  • Gemini CLI honors the same hook-decision shape, so this also "
            "applies to Gemini sessions.\n\n"
            "Recommended for: anyone who wants the workspace memory pool, "
            "session digests, and conflict-detection coverage to grow "
            "passively from real work."
        ),
        modifies_prompt=False,
        default_enabled=True,
        category="hooks",
        added_in="2026-04-28",
    ),
    "experimental_autolearn": ExperimentalFeature(
        key="experimental_autolearn",
        label="Autolearn (passive lesson extraction)",
        description=(
            "After a session ends, distills the transcript into 1-3 durable "
            "memory entries that land in a review queue. Lets the workspace's "
            "knowledge pool grow passively from daily work."
        ),
        long_description=(
            "When enabled, Commander watches for session-ended signals "
            "(clean exit, idle, or analysis complete) and runs a focused LLM "
            "pass over the transcript to extract reusable insights. Results "
            "are written to memory_entries with auto=1 and confidence scores, "
            "so they appear in a review queue rather than the canonical pool — "
            "you approve or reject each one.\n\n"
            "Gate conditions:\n"
            "  • At least 5 conversation turns\n"
            "  • Per-session 1h debounce (no relearning the same session)\n"
            "  • Confidence ≥ 0.7 for an entry to be kept\n"
            "  • Cap of 3 entries per session\n\n"
            "Flowing into:\n"
            "  • Workspace memory pool (after approval)\n"
            "  • Observatory project profile (as 'product chatter' signal)\n\n"
            "⚠ Tradeoffs:\n"
            "  • Each session-end fires a background LLM call (billed normally)\n"
            "  • Short or trivial sessions may produce noise — use the review\n"
            "    queue rather than auto-promoting\n"
            "  • Privacy: transcript content is sent to the configured CLI;\n"
            "    don't enable on sessions handling sensitive secrets\n\n"
            "Recommended for: anyone who wants the workspace to remember more "
            "without writing memory manually."
        ),
        modifies_prompt=False,
        default_enabled=True,
        category="advisor",
        added_in="2026-04-28",
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
