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

from collections.abc import Mapping
from dataclasses import dataclass, replace
import extension_host
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


_CORE_FEATURES: dict[str, ExperimentalFeature] = {
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
            "    and model choices are restricted to your configured pair\n\n"
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
            "Optional AI review of tool calls. Off by default; the agent's chosen "
            "permission mode and IVE's deny rules remain active."
        ),
        long_description=(
            "Enable this only if you want an additional AI reviewer before tool calls. "
            "Choose a configured provider in Safety settings first. A missing API key "
            "prevents activation instead of prompting on every tool call.\n\n"
            "An enabled reviewer may ask for confirmation even in Auto mode. "
            "Provider outages retain the configured Ask or Deny response. "
            "Approvals from IVE always continue through the agent's native permissions; "
            "they never bypass its checks.\n\n"
            "Local critical-command blocks and configured deny rules remain active "
            "with the AI reviewer off. Package scanning is a separate optional feature."
        ),
        modifies_prompt=False,
        default_enabled=False,
        category="security",
        added_in="2026-04-16",
    ),
    "experimental_auto_skill_suggestions": ExperimentalFeature(
        key="experimental_auto_skill_suggestions",
        label="Auto Skill Suggestions",
        description="<extension:skill_suggestions_short>",
        long_description="<extension:skill_suggestions_long>",
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
        default_enabled=False,
        category="advisor",
        added_in="2026-04-22",
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
            "Optional follow-up prompt to save useful memories after substantial work. "
            "Off by default; enabling it can start another billed model turn."
        ),
        long_description=(
            "After at least 12 tool calls and five minutes of idle time, IVE may "
            "send a reflection prompt to the session. It is limited to once per "
            "30 minutes. User activity cancels a pending prompt.\n\n"
            "This feature can resume an otherwise finished agent and consume tokens. "
            "Enable it only when you want automatic memory and digest follow-ups. "
            "It does not block the agent's Stop hook."
        ),
        modifies_prompt=False,
        default_enabled=False,
        category="hooks",
        added_in="2026-04-28",
    ),

}


# Text slots keep the manual/core feature usable without advertising tools
# from an absent product. Contributors cannot replace core flags/defaults.
_CORE_TEXT_SLOTS = {
    "skill_suggestions_short": "Optional automatic skill recommendations; a selected recommendation provider is required.",
    "skill_suggestions_long": "This switch controls automatic recommendations only when a provider is installed. Manual search_skills and get_skill_content remain available independently. Without a provider no automatic recommendations are generated.",
    "reflection_short_tools": "",
    "reflection_catalog_tools": "",
    "reflection_goal_join": " and ",
    "reflection_goal_suffix": "",
}


def _experimental_contributors():
    """Optional trusted backend/experimental.py metadata convention.

    FEATURES adds product-owned ExperimentalFeature records; TEXT_SLOTS fills
    declared descriptive slots in core features. No database values are read
    or written here. A plugin without this contribution is normal.
    """
    for metadata in extension_host.installed_extensions():
        extension_id = metadata["id"]
        root = extension_host.extension_path(extension_id)
        relative = "backend/experimental.py"
        if (root / relative).is_file():
            yield extension_host.load_backend_module(extension_id, relative)


def _composed_features() -> dict[str, ExperimentalFeature]:
    features = dict(_CORE_FEATURES)
    slots = dict(_CORE_TEXT_SLOTS)
    claimed_slots = set()
    for contribution in _experimental_contributors():
        extra_features = getattr(contribution, "FEATURES", ())
        extra_slots = getattr(contribution, "TEXT_SLOTS", {})
        if (not isinstance(extra_features, (tuple, list))
                or not isinstance(extra_slots, dict)):
            raise ValueError("Invalid experimental feature contribution")
        for feature in extra_features:
            if (not isinstance(feature, ExperimentalFeature)
                    or not isinstance(feature.key, str) or not feature.key.isidentifier()
                    or not isinstance(feature.modifies_prompt, bool)
                    or not isinstance(feature.default_enabled, bool)
                    or any(not isinstance(getattr(feature, name), str) for name in (
                        "label", "description", "long_description", "category", "added_in"))):
                raise ValueError("Invalid experimental feature declaration")
            if feature.key in features:
                raise ValueError("Conflicting experimental feature declaration")
            features[feature.key] = feature
        if (any(key not in slots or not isinstance(value, str)
                for key, value in extra_slots.items())
                or claimed_slots.intersection(extra_slots)):
            raise ValueError("Invalid experimental description slot")
        slots.update(extra_slots)
        claimed_slots.update(extra_slots)

    for key, feature in features.items():
        values = {}
        for name in ("description", "long_description"):
            value = getattr(feature, name)
            for slot, replacement in slots.items():
                value = value.replace("<extension:" + slot + ">", replacement)
            values[name] = value
        features[key] = replace(feature, **values)
    return features


class _FeatureRegistry(Mapping):
    """Profile-aware read-only registry for existing DB seed/API callers."""

    def __getitem__(self, key):
        return _composed_features()[key]

    def __iter__(self):
        return iter(_composed_features())

    def __len__(self):
        return len(_composed_features())

    def values(self):
        return _composed_features().values()

    def items(self):
        return _composed_features().items()

    def copy(self):
        return _composed_features()


EXPERIMENTAL_FEATURES = _FeatureRegistry()


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
