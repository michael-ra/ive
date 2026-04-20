"""Per-CLI profiles: how each CLI realizes each canonical Feature.

A CLIProfile is a pure data description of one CLI's shape — its binary name,
which Features it supports, how those features translate into argv, and how
its native hook event names map to Commander's canonical event names.

Adding a new CLI (e.g. Aider, Cursor agent, a future Anthropic tool) means
writing ONE new CLIProfile in this file. Every other part of Commander
(pty_manager, hooks, plugins, capability broker, marketplace) automatically
picks it up because they all target the Feature/HookEvent vocabulary rather
than CLI-specific branches.

This file is also pure data — no I/O, no subprocess. The only logic lives in
the builder callables inside each FeatureBinding.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from cli_features import Feature, HookEvent


# Permission-mode translation (Claude's canonical names → Gemini's names).
# Lives here so the profile is self-contained; config.py re-exports it for
# backward compat with code that hasn't migrated yet.
CLAUDE_TO_GEMINI_MODE = {
    "default":           "default",
    "auto":              "auto_edit",
    "plan":              "plan",
    "acceptEdits":       "auto_edit",
    "dontAsk":           "yolo",
    "bypassPermissions": "yolo",
}


def _parse_list(value: Any) -> list[str]:
    """Coerce a config value into a list of strings.

    Config fields like `allowed_tools` and `add_dirs` may arrive as:
      • a Python list already
      • a JSON-encoded string (how they're stored in SQLite)
      • None / empty (treat as no entries)
    """
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return [str(v) for v in value]
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
            if isinstance(decoded, list):
                return [str(v) for v in decoded]
            return [str(decoded)]
        except json.JSONDecodeError:
            return [value]
    return [str(value)]


def _is_truthy_worktree(value: Any) -> bool:
    """Worktree can be stored as bool, int, or string. Match pty_manager.py."""
    return value not in (None, 0, "0", False, "", "false", "False")


# ─── FeatureBinding ───────────────────────────────────────────────────────

@dataclass
class FeatureBinding:
    """How one CLI realizes one canonical Feature.

    The `build` callable is the source of truth for command-line translation.
    It receives the raw config value and returns either:
      • a list of tokens to append to argv (may be empty for flag-only flags),
      • or None to signal "don't emit anything for this feature in this config"
        (used for default filtering, e.g. omit --permission-mode if value is
        "default" to stay consistent with pty_manager.py's original behavior).

    The `flag` field is advisory — used for documentation, feature matrices,
    and debugging. The actual command generation uses `build` exclusively so
    that complex cases (repeated flags, value translation, default filtering)
    stay in one place.
    """

    supported: bool = True
    flag: Optional[str] = None                                 # primary flag name (for docs)
    build: Optional[Callable[[Any], Optional[list[str]]]] = None  # None → skip emission
    file_path: Optional[str] = None                            # for file-based features
    notes: str = ""                                            # human-readable quirks/caveats


@dataclass
class CLIProfile:
    """Everything Commander needs to know about one CLI.

    A profile is pure data — all behavior comes from the bindings' `build`
    callables, which are themselves small pure functions.
    """

    id: str
    label: str
    binary: str
    features: dict[Feature, FeatureBinding] = field(default_factory=dict)
    hook_event_map: dict[HookEvent, str] = field(default_factory=dict)

    # ── Infrastructure paths (tilde-prefixed; callers expand with
    #    os.path.expanduser or Path.home()) ────────────────────────────
    home_dir: str = ""                          # "~/.claude" or "~/.gemini"
    settings_file: str = ""                     # "~/.claude/settings.json"
    plugin_cache_dir: str = ""                  # "~/.claude/plugins/cache"
    auth_dir_name: str = ""                     # ".claude" (for account sandboxing)

    # ── Defaults ──────────────────────────────────────────────────────
    default_model: str = ""
    default_permission_mode: str = "default"
    default_commander_model: str = ""           # e.g. "opus" or "gemini-2.5-pro"
    default_tester_model: str = ""              # e.g. "sonnet" or "gemini-2.5-flash"

    # ── UI data (served to frontend via /api/cli-info) ────────────────
    available_models: list = field(default_factory=list)
    available_permission_modes: list = field(default_factory=list)
    effort_levels: list = field(default_factory=list)
    model_ladder: list = field(default_factory=list)
    message_markers: list = field(default_factory=list)
    ui_capabilities: dict = field(default_factory=dict)

    # ── Hook installation (native event names for hook_installer) ─────
    default_hook_events: list = field(default_factory=list)

    # ── MCP strategy ──────────────────────────────────────────────────
    mcp_strategy: str = "config_file"           # "config_file" or "mcp_add"

    # ── Session detection ─────────────────────────────────────────────
    session_file_pattern: str = "*.jsonl"

    # ── Feature introspection ─────────────────────────────────────────────
    def supports(self, f: Feature) -> bool:
        b = self.features.get(f)
        return bool(b and b.supported)

    def binding(self, f: Feature) -> Optional[FeatureBinding]:
        """Return the binding iff supported. Absent or supported=False → None."""
        b = self.features.get(f)
        return b if (b and b.supported) else None

    # ── Hook event translation ────────────────────────────────────────────
    def native_hook(self, e: HookEvent) -> Optional[str]:
        """Canonical HookEvent → this CLI's native event name (None if unsupported)."""
        return self.hook_event_map.get(e)

    def canonical_hook(self, native: str) -> Optional[HookEvent]:
        """This CLI's native event name → canonical HookEvent (None if unknown)."""
        for event, mapped in self.hook_event_map.items():
            if mapped == native:
                return event
        return None


# ═══ Claude Code profile ══════════════════════════════════════════════════
#
# Source of truth for Claude's flag set: the switch/case block in server.py
# that runs under `if cli_type == "claude"` in the PTY start handler (roughly
# lines 535–580 at time of writing). Every binding below corresponds to one
# conditional in that block.

CLAUDE_PROFILE = CLIProfile(
    id="claude",
    label="Claude Code",
    binary="claude",
    features={
        Feature.MODEL: FeatureBinding(
            flag="--model",
            build=lambda v: ["--model", str(v)] if v else None,
        ),
        Feature.PERMISSION_MODE: FeatureBinding(
            flag="--permission-mode",
            build=lambda v: ["--permission-mode", str(v)]
                if v and str(v) != "default" else None,
        ),
        Feature.EFFORT: FeatureBinding(
            flag="--effort",
            build=lambda v: ["--effort", str(v)]
                if v and str(v) != "high" else None,
            notes="Claude defaults to 'high'; omitted when the config matches.",
        ),
        Feature.BUDGET_USD: FeatureBinding(
            flag="--max-budget-usd",
            build=lambda v: ["--max-budget-usd", str(v)] if v else None,
        ),
        Feature.WORKTREE: FeatureBinding(
            flag="--worktree",
            build=lambda v: ["--worktree"] if _is_truthy_worktree(v) else None,
        ),
        Feature.ADD_DIRS: FeatureBinding(
            flag="--add-dir",
            build=lambda v: sum(
                [["--add-dir", d] for d in _parse_list(v)], []
            ) or None,
        ),
        Feature.RESUME_ID: FeatureBinding(
            flag="--resume",
            build=lambda v: ["--resume", str(v)] if v else None,
        ),
        Feature.APPEND_SYSTEM_PROMPT: FeatureBinding(
            flag="--append-system-prompt",
            build=lambda v: ["--append-system-prompt", str(v)] if v else None,
        ),
        Feature.ALLOWED_TOOLS: FeatureBinding(
            flag="--allowedTools",
            build=lambda v: sum(
                [["--allowedTools", t] for t in _parse_list(v)], []
            ) or None,
        ),
        Feature.DISALLOWED_TOOLS: FeatureBinding(
            flag="--disallowedTools",
            build=lambda v: sum(
                [["--disallowedTools", t] for t in _parse_list(v)], []
            ) or None,
        ),
        Feature.MCP_CONFIG_PATH: FeatureBinding(
            flag="--mcp-config",
            build=lambda v: ["--mcp-config", str(v)] if v else None,
        ),
        Feature.AGENT: FeatureBinding(
            flag="--agent",
            build=lambda v: ["--agent", str(v)] if v else None,
        ),
        Feature.PROJECT_MEMORY_FILE: FeatureBinding(
            file_path="CLAUDE.md",
            notes="Project-level memory file, read from the workspace root upward.",
        ),
        Feature.GLOBAL_MEMORY_FILE: FeatureBinding(
            file_path="~/.claude/CLAUDE.md",
        ),
        Feature.SKILLS_DIR: FeatureBinding(
            file_path=".claude/skills",
            notes="Skill files use the SKILL.md format with YAML frontmatter.",
        ),
        Feature.SKILLS_FORMAT: FeatureBinding(
            notes="skill_md",
        ),
        Feature.PLAN_MODE: FeatureBinding(
            notes="Enter via --permission-mode plan. Has a structured Plan subagent.",
        ),
        Feature.SUBAGENTS: FeatureBinding(
            notes="Task subagents via tool use. Subagent lifecycle exposed as hooks.",
        ),
        # Not supported by Claude Code as a CLI flag
        Feature.PLAN_DEFAULT_ON: FeatureBinding(supported=False),
        Feature.ALLOWED_MCP_SERVERS: FeatureBinding(supported=False,
            notes="Claude uses --allowedTools with mcp__<server>__<tool> instead."),
    },
    # Hook event map verified against Claude Code docs (April 2026).
    # Claude Code has ~26 hook events; the map below covers the ones with
    # corresponding canonical HookEvent members. Claude-only events that
    # Gemini doesn't fire simply don't appear in the Gemini profile.
    hook_event_map={
        # Session lifecycle
        HookEvent.SESSION_START:        "SessionStart",
        HookEvent.SESSION_STOP:         "SessionEnd",               # FIXED: was "SessionStop"
        HookEvent.INSTRUCTIONS_LOADED:  "InstructionsLoaded",
        # Turn lifecycle
        HookEvent.PROMPT_SUBMIT:        "UserPromptSubmit",
        HookEvent.TURN_COMPLETE:        "Stop",                     # NEW: one-turn-done event
        HookEvent.TURN_FAILURE:         "StopFailure",              # NEW: turn ended with API error
        # Tool execution loop
        HookEvent.PRE_TOOL:             "PreToolUse",
        HookEvent.POST_TOOL:            "PostToolUse",
        HookEvent.POST_TOOL_FAILURE:    "PostToolUseFailure",       # NEW: tool call failed
        HookEvent.PERMISSION_REQUEST:   "PermissionRequest",        # NEW: approval dialog about to show
        HookEvent.PERMISSION_DENIED:    "PermissionDenied",         # NEW: approval denied
        # Context management
        HookEvent.PRE_COMPACT:          "PreCompact",
        HookEvent.POST_COMPACT:         "PostCompact",
        # Subagent
        HookEvent.SUBAGENT_START:       "SubagentStart",
        HookEvent.SUBAGENT_STOP:        "SubagentStop",
        # Filesystem / env
        HookEvent.FILE_CHANGED:         "FileChanged",
        HookEvent.CWD_CHANGED:          "CwdChanged",               # NEW
        HookEvent.CONFIG_CHANGE:        "ConfigChange",             # NEW
        # Worktree
        HookEvent.WORKTREE_CREATE:      "WorktreeCreate",           # NEW
        HookEvent.WORKTREE_REMOVE:      "WorktreeRemove",           # NEW
        # Task / team orchestration
        HookEvent.TASK_CREATED:         "TaskCreated",              # NEW
        HookEvent.TASK_COMPLETED:       "TaskCompleted",            # NEW
        HookEvent.TEAMMATE_IDLE:        "TeammateIdle",             # NEW
        # MCP elicitation
        HookEvent.ELICITATION:          "Elicitation",              # NEW
        HookEvent.ELICITATION_RESULT:   "ElicitationResult",        # NEW
        # Notifications
        HookEvent.NOTIFICATION:         "Notification",
    },
    # ── Infrastructure ────────────────────────────────────────────────
    home_dir="~/.claude",
    settings_file="~/.claude/settings.json",
    plugin_cache_dir="~/.claude/plugins/cache",
    auth_dir_name=".claude",
    # ── Defaults ──────────────────────────────────────────────────────
    default_model="sonnet",
    default_permission_mode="auto",
    default_commander_model="opus",
    default_tester_model="sonnet",
    # ── UI data ───────────────────────────────────────────────────────
    available_models=[
        {"id": "haiku", "label": "Haiku", "description": "Fast & cheap"},
        {"id": "sonnet", "label": "Sonnet", "description": "Balanced"},
        {"id": "opus", "label": "Opus", "description": "Maximum capability"},
    ],
    available_permission_modes=[
        {"id": "default", "label": "Default", "description": "Ask for each action"},
        {"id": "auto", "label": "Auto", "description": "Approve most actions automatically"},
        {"id": "plan", "label": "Plan", "description": "Planning only, no edits"},
        {"id": "acceptEdits", "label": "Accept Edits", "description": "Auto-approve file edits"},
        {"id": "dontAsk", "label": "Don't Ask", "description": "Never ask, deny if not allowed"},
        {"id": "bypassPermissions", "label": "Bypass All", "description": "Skip all permission checks"},
    ],
    effort_levels=["low", "medium", "high", "max"],
    model_ladder=["haiku", "sonnet", "opus"],
    message_markers=["\u23FA", ">"],
    ui_capabilities={"force_send": True},
    # ── Hook installation ─────────────────────────────────────────────
    default_hook_events=[
        "Stop", "Notification", "PreToolUse", "PostToolUse",
        "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
        "WorktreeCreate", "WorktreeRemove",
    ],
    # ── MCP / session detection ───────────────────────────────────────
    mcp_strategy="config_file",
    session_file_pattern="*.jsonl",
)


# ═══ Gemini CLI profile ══════════════════════════════════════════════════
#
# Source of truth for Gemini's flag set: the block in server.py under
# `if cli_type == "gemini"` in the PTY start handler.

GEMINI_PROFILE = CLIProfile(
    id="gemini",
    label="Gemini CLI",
    binary="gemini",
    features={
        Feature.MODEL: FeatureBinding(
            flag="--model",
            build=lambda v: ["--model", str(v)] if v else None,
        ),
        Feature.PERMISSION_MODE: FeatureBinding(
            flag="--approval-mode",
            build=lambda v: (
                ["--approval-mode", CLAUDE_TO_GEMINI_MODE.get(str(v), str(v))]
                if v and str(v) != "default" else None
            ),
            notes="Gemini calls it 'approval mode'. Commander uses Claude's "
                  "mode names as canonical and translates here.",
        ),
        Feature.APPEND_SYSTEM_PROMPT: FeatureBinding(
            flag="-i",
            build=lambda v: ["-i", str(v)] if v else None,
            notes="Gemini uses -i (prompt-interactive) instead of a dedicated "
                  "system-prompt flag. Same end effect: prepends to context.",
        ),
        Feature.ADD_DIRS: FeatureBinding(
            flag="--include-directories",
            build=lambda v: sum(
                [["--include-directories", d] for d in _parse_list(v)], []
            ) or None,
        ),
        Feature.WORKTREE: FeatureBinding(
            flag="--worktree",
            build=lambda v: ["--worktree"] if _is_truthy_worktree(v) else None,
        ),
        Feature.RESUME_ID: FeatureBinding(
            flag="--resume",
            build=lambda v: ["--resume", str(v)] if v else None,
            notes="Gemini --resume takes 'latest' or a numeric index; Commander "
                  "resolves the stored stem to an index in pty_manager.",
        ),
        Feature.ALLOWED_MCP_SERVERS: FeatureBinding(
            flag="--allowed-mcp-server-names",
            build=lambda v: sum(
                [["--allowed-mcp-server-names", s] for s in _parse_list(v)], []
            ) or None,
        ),
        Feature.PROJECT_MEMORY_FILE: FeatureBinding(
            file_path="GEMINI.md",
            notes="Gemini's equivalent of CLAUDE.md.",
        ),
        Feature.GLOBAL_MEMORY_FILE: FeatureBinding(
            file_path="~/.gemini/GEMINI.md",
        ),
        Feature.SKILLS_DIR: FeatureBinding(
            file_path=".gemini/skills",
            notes="Standalone skills use .gemini/skills/; extensions (packages) "
                  "live in .gemini/extensions/. Same SKILL.md format as Claude.",
        ),
        Feature.SKILLS_FORMAT: FeatureBinding(
            notes="skill_md",
        ),
        Feature.PLAN_MODE: FeatureBinding(
            notes="Plan mode is DEFAULT as of Gemini CLI 2026. /plan or Shift+Tab "
                  "also toggles it. Commander's plan permission mode maps directly.",
        ),
        Feature.PLAN_DEFAULT_ON: FeatureBinding(
            notes="Gemini enables plan mode by default; Claude does not.",
        ),
        Feature.SUBAGENTS: FeatureBinding(
            notes="Agent loop lifecycle exposed as BeforeAgent/AfterAgent hooks.",
        ),
        # Explicitly unsupported (verified April 2026):
        Feature.EFFORT: FeatureBinding(
            supported=False,
            notes="No per-call effort flag in Gemini CLI; quality is model-tier driven.",
        ),
        Feature.BUDGET_USD: FeatureBinding(
            supported=False,
            notes="No equivalent budget cap flag.",
        ),
        Feature.ALLOWED_TOOLS: FeatureBinding(
            supported=False,
            notes="Gemini uses ALLOWED_MCP_SERVERS instead; tool allow-listing "
                  "happens at the MCP server level.",
        ),
        Feature.DISALLOWED_TOOLS: FeatureBinding(supported=False),
        Feature.MCP_CONFIG_PATH: FeatureBinding(
            supported=False,
            notes="Gemini registers MCP servers via `gemini mcp add` command, "
                  "persisted in .gemini/settings.json.",
        ),
        Feature.AGENT: FeatureBinding(supported=False),
    },
    # Hook event map verified against Gemini CLI docs (April 2026).
    # Gemini's "BeforeAgent" / "AfterAgent" are the turn-start / turn-end
    # events — analogous to Claude's "UserPromptSubmit" / "Stop".
    # Gemini exposes fewer total events than Claude; the Claude-only events
    # (FileChanged, CwdChanged, ConfigChange, permission events, worktree
    # events, task events, elicitation, etc.) simply aren't mapped here and
    # plugins subscribing to those canonical events no-op on Gemini sessions.
    hook_event_map={
        # Session lifecycle
        HookEvent.SESSION_START:         "SessionStart",
        HookEvent.SESSION_STOP:          "SessionEnd",
        # Turn lifecycle — BeforeAgent / AfterAgent wrap one agent loop iteration
        HookEvent.PROMPT_SUBMIT:         "BeforeAgent",
        HookEvent.TURN_COMPLETE:         "AfterAgent",   # NEW: cross-CLI turn-done event
        # Tool execution
        HookEvent.PRE_TOOL:              "BeforeTool",
        HookEvent.POST_TOOL:             "AfterTool",
        # Context management
        HookEvent.PRE_COMPACT:           "PreCompress",
        # Notifications
        HookEvent.NOTIFICATION:          "Notification",
        # Model-level events — unique to Gemini
        HookEvent.BEFORE_MODEL:          "BeforeModel",
        HookEvent.AFTER_MODEL:           "AfterModel",
        HookEvent.BEFORE_TOOL_SELECTION: "BeforeToolSelection",
    },
    # ── Infrastructure ────────────────────────────────────────────────
    home_dir="~/.gemini",
    settings_file="~/.gemini/settings.json",
    plugin_cache_dir="~/.gemini/extensions",
    auth_dir_name=".gemini",
    # ── Defaults ──────────────────────────────────────────────────────
    default_model="gemini-2.5-pro",
    default_permission_mode="auto_edit",
    default_commander_model="gemini-2.5-pro",
    default_tester_model="gemini-2.5-flash",
    # ── UI data ───────────────────────────────────────────────────────
    available_models=[
        {"id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro", "description": "Gemini Pro"},
        {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash", "description": "Fast Gemini"},
        {"id": "gemini-2.0-flash", "label": "Gemini 2.0 Flash", "description": "Previous gen flash"},
    ],
    available_permission_modes=[
        {"id": "default", "label": "Default", "description": "Prompt for approval"},
        {"id": "auto_edit", "label": "Auto Edit", "description": "Auto-approve edit tools"},
        {"id": "yolo", "label": "YOLO", "description": "Auto-approve all tools"},
        {"id": "plan", "label": "Plan", "description": "Read-only mode"},
    ],
    effort_levels=[],
    model_ladder=["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro"],
    message_markers=["\u2726", ">"],
    ui_capabilities={"force_send": False},
    # ── Hook installation ─────────────────────────────────────────────
    default_hook_events=[
        "AfterAgent", "Notification", "BeforeTool", "AfterTool",
        "SessionStart", "SessionEnd", "PreCompress",
    ],
    # ── MCP / session detection ───────────────────────────────────────
    mcp_strategy="mcp_add",
    session_file_pattern="*.json",
)


# ─── Registry ────────────────────────────────────────────────────────────

PROFILES: dict[str, CLIProfile] = {
    "claude": CLAUDE_PROFILE,
    "gemini": GEMINI_PROFILE,
}


def get_profile(cli_id: str) -> CLIProfile:
    """Return the profile for `cli_id`, falling back to Claude for unknown ids.

    Falls back rather than raising so Commander keeps running on any legacy
    cli_type value stored in an old sessions row.
    """
    return PROFILES.get(cli_id, CLAUDE_PROFILE)


def all_profiles() -> list[CLIProfile]:
    return list(PROFILES.values())
