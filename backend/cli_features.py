"""Canonical feature vocabulary for Commander's unified CLI layer.

This module is the single source of truth for what Commander considers a
"feature" that CLIs can expose. Every other part of Commander (pty_manager,
hooks, plugins, capability broker, marketplace compatibility badges) uses
these enums and nothing else to reason about CLI capabilities.

Adding a new capability:
  1. Add an enum member here (Feature or HookEvent).
  2. Add a FeatureBinding for each CLIProfile that supports it (cli_profiles.py).
     CLIs that don't support it simply leave the binding absent.
  3. Nothing else to update — the rest of Commander is profile-driven.

This layer is intentionally pure data. No I/O, no subprocess, no DB access.
It must stay cheap to import from anywhere.
"""
from __future__ import annotations

from enum import Enum


class Feature(str, Enum):
    """Every CLI-neutral configuration knob Commander understands.

    Values are snake_case strings so they can double as keys in a dict-shaped
    session config (which is how Commander already stores sessions). A new CLI
    that doesn't expose one of these features simply omits the binding.
    """

    # ── Session configuration ─────────────────────────────────────────────
    MODEL                 = "model"
    PERMISSION_MODE       = "permission_mode"        # default|auto|plan|acceptEdits|dontAsk|bypassPermissions|yolo
    EFFORT                = "effort"                 # low|medium|high|max (Claude-only today)
    BUDGET_USD            = "budget_usd"
    WORKTREE              = "worktree"               # bool — run in an isolated git worktree
    ADD_DIRS              = "add_dirs"               # list[str] — extra directories to expose
    RESUME_ID             = "resume_id"              # session id to resume

    # ── System prompt injection ────────────────────────────────────────────
    APPEND_SYSTEM_PROMPT  = "append_system_prompt"

    # ── Tools ──────────────────────────────────────────────────────────────
    ALLOWED_TOOLS         = "allowed_tools"          # list[str]
    DISALLOWED_TOOLS      = "disallowed_tools"       # list[str]
    MCP_CONFIG_PATH       = "mcp_config_path"        # str — path to mcp config json
    ALLOWED_MCP_SERVERS   = "allowed_mcp_servers"    # list[str]

    # ── Memory files (project and user) ─────────────────────────────────────
    PROJECT_MEMORY_FILE   = "project_memory_file"    # e.g. CLAUDE.md or GEMINI.md
    GLOBAL_MEMORY_FILE    = "global_memory_file"     # ~/.claude/CLAUDE.md, ~/.gemini/GEMINI.md

    # ── Skills / extensions ───────────────────────────────────────────────
    SKILLS_DIR            = "skills_dir"
    SKILLS_FORMAT         = "skills_format"          # "skill_md" for Claude and Gemini

    # ── Plan mode ─────────────────────────────────────────────────────────
    PLAN_MODE             = "plan_mode"              # supports structured planning
    PLAN_DEFAULT_ON       = "plan_default_on"        # plan mode is the default (Gemini 2026+)

    # ── Subagent orchestration ─────────────────────────────────────────────
    SUBAGENTS             = "subagents"

    # ── Agent identity ─────────────────────────────────────────────────────
    AGENT                 = "agent"                  # e.g. claude --agent <name>


class HookEvent(str, Enum):
    """Canonical lifecycle events. Each CLI profile maps these to its own
    native event names (e.g. Commander's PROMPT_SUBMIT → Claude's
    UserPromptSubmit or Gemini's BeforeAgent).

    Plugin scripts and Commander internals subscribe to these canonical
    names; the adapters translate when firing into the native CLI hook bus
    or when receiving events from it.

    Canonical events that are currently CLI-specific are kept here so plugin
    authors can still subscribe to them portably — they just no-op on CLIs
    that don't fire them. This keeps the vocabulary stable as CLIs converge.
    """

    # ── Session lifecycle ────────────────────────────────────────────────
    SESSION_START        = "session_start"        # session begins or is resumed
    SESSION_STOP         = "session_stop"         # session terminates
    INSTRUCTIONS_LOADED  = "instructions_loaded"  # CLAUDE.md / GEMINI.md loaded

    # ── Turn lifecycle (inside a session) ────────────────────────────────
    PROMPT_SUBMIT        = "prompt_submit"        # user submits a prompt
    TURN_COMPLETE        = "turn_complete"        # agent finishes one turn successfully
    TURN_FAILURE         = "turn_failure"         # turn ends with an error

    # ── Tool execution loop ───────────────────────────────────────────────
    PRE_TOOL             = "pre_tool"             # before a tool executes
    POST_TOOL            = "post_tool"            # after a tool returns successfully
    POST_TOOL_FAILURE    = "post_tool_failure"    # after a tool raises/fails
    PERMISSION_REQUEST   = "permission_request"   # about to show approval dialog
    PERMISSION_DENIED    = "permission_denied"    # approval was denied

    # ── Context management ───────────────────────────────────────────────
    PRE_COMPACT          = "pre_compact"          # before context compaction
    POST_COMPACT         = "post_compact"         # after context compaction

    # ── Subagent orchestration ───────────────────────────────────────────
    SUBAGENT_START       = "subagent_start"
    SUBAGENT_STOP        = "subagent_stop"

    # ── Filesystem / environment ─────────────────────────────────────────
    FILE_CHANGED         = "file_changed"         # watched file changed on disk
    CWD_CHANGED          = "cwd_changed"          # working directory changed
    CONFIG_CHANGE        = "config_change"        # config file changed mid-session

    # ── Worktree management ──────────────────────────────────────────────
    WORKTREE_CREATE      = "worktree_create"
    WORKTREE_REMOVE      = "worktree_remove"

    # ── Task / team orchestration ────────────────────────────────────────
    TASK_CREATED         = "task_created"
    TASK_COMPLETED       = "task_completed"
    TEAMMATE_IDLE        = "teammate_idle"

    # ── MCP elicitation ──────────────────────────────────────────────────
    ELICITATION          = "elicitation"          # MCP server asks user for input
    ELICITATION_RESULT   = "elicitation_result"   # user responded

    # ── Notifications ────────────────────────────────────────────────────
    NOTIFICATION         = "notification"

    # ── Model-level events (Gemini-only today) ───────────────────────────
    BEFORE_MODEL         = "before_model"
    AFTER_MODEL          = "after_model"
    BEFORE_TOOL_SELECTION = "before_tool_selection"


# Human-readable labels for UI rendering. Keep the dict in the same file as
# the enum so adding a member forces the author to add a label too (via the
# self-check below).
FEATURE_LABELS: dict[Feature, str] = {
    Feature.MODEL:                "Model selection",
    Feature.PERMISSION_MODE:      "Permission / approval mode",
    Feature.EFFORT:               "Reasoning effort level",
    Feature.BUDGET_USD:           "Per-session budget cap",
    Feature.WORKTREE:             "Git worktree isolation",
    Feature.ADD_DIRS:             "Additional exposed directories",
    Feature.RESUME_ID:            "Session resume by ID",
    Feature.APPEND_SYSTEM_PROMPT: "System prompt injection",
    Feature.ALLOWED_TOOLS:        "Tool allow-list",
    Feature.DISALLOWED_TOOLS:     "Tool deny-list",
    Feature.MCP_CONFIG_PATH:      "MCP server config",
    Feature.ALLOWED_MCP_SERVERS:  "MCP server allow-list",
    Feature.PROJECT_MEMORY_FILE:  "Project memory file",
    Feature.GLOBAL_MEMORY_FILE:   "Global memory file",
    Feature.SKILLS_DIR:           "Skills directory",
    Feature.SKILLS_FORMAT:        "Skill file format",
    Feature.PLAN_MODE:            "Plan mode",
    Feature.PLAN_DEFAULT_ON:      "Plan mode default-on",
    Feature.SUBAGENTS:            "Subagent orchestration",
    Feature.AGENT:                "Agent identity",
}

HOOK_EVENT_LABELS: dict[HookEvent, str] = {
    # Session lifecycle
    HookEvent.SESSION_START:         "Session start",
    HookEvent.SESSION_STOP:          "Session end",
    HookEvent.INSTRUCTIONS_LOADED:   "Instructions loaded (CLAUDE.md/GEMINI.md)",
    # Turn lifecycle
    HookEvent.PROMPT_SUBMIT:         "User prompt submitted",
    HookEvent.TURN_COMPLETE:         "Turn complete",
    HookEvent.TURN_FAILURE:          "Turn failed",
    # Tool loop
    HookEvent.PRE_TOOL:              "Before tool execution",
    HookEvent.POST_TOOL:             "After tool execution (success)",
    HookEvent.POST_TOOL_FAILURE:     "After tool execution (failure)",
    HookEvent.PERMISSION_REQUEST:    "Permission request shown",
    HookEvent.PERMISSION_DENIED:     "Permission denied",
    # Context mgmt
    HookEvent.PRE_COMPACT:           "Before context compaction",
    HookEvent.POST_COMPACT:          "After context compaction",
    # Subagent
    HookEvent.SUBAGENT_START:        "Subagent start",
    HookEvent.SUBAGENT_STOP:         "Subagent stop",
    # Filesystem / env
    HookEvent.FILE_CHANGED:          "File changed on disk",
    HookEvent.CWD_CHANGED:           "Working directory changed",
    HookEvent.CONFIG_CHANGE:         "Config file changed",
    # Worktree
    HookEvent.WORKTREE_CREATE:       "Worktree created",
    HookEvent.WORKTREE_REMOVE:       "Worktree removed",
    # Task / team
    HookEvent.TASK_CREATED:          "Task created",
    HookEvent.TASK_COMPLETED:        "Task completed",
    HookEvent.TEAMMATE_IDLE:         "Teammate idle",
    # MCP elicitation
    HookEvent.ELICITATION:           "MCP elicitation requested",
    HookEvent.ELICITATION_RESULT:    "MCP elicitation resolved",
    # Notifications
    HookEvent.NOTIFICATION:          "Notification",
    # Model-level (Gemini)
    HookEvent.BEFORE_MODEL:          "Before model call",
    HookEvent.AFTER_MODEL:           "After model call",
    HookEvent.BEFORE_TOOL_SELECTION: "Before tool selection",
}


# Self-check: every enum member must have a label. Failing this at import
# time is intentional — it's a correctness assertion, not a runtime concern.
_missing_feature_labels = [f for f in Feature if f not in FEATURE_LABELS]
assert not _missing_feature_labels, f"missing FEATURE_LABELS for: {_missing_feature_labels}"

_missing_hook_labels = [e for e in HookEvent if e not in HOOK_EVENT_LABELS]
assert not _missing_hook_labels, f"missing HOOK_EVENT_LABELS for: {_missing_hook_labels}"
