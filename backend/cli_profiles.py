"""Per-CLI profiles: how each CLI realizes each canonical Feature.

A CLIProfile is a pure data description of one CLI's shape — its binary name,
which Features it supports, how those features translate into argv, and how
its native hook event names map to Commander's canonical event names.

Built-ins declare their complex bindings here. Operator-defined profiles use
the strict data shape in declarative_cli_profiles.py, which generates the same
runtime bindings and registers the resulting CLIProfile beside the built-ins.

This file performs no I/O or subprocess work. Runtime behavior lives only in
profile-owned builder callables, whether handwritten or generated from data.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from cli_features import Feature, HookEvent
from effort_defaults import CLAUDE_EFFORT_LEVELS
from tool_semantics import COMMON_TOOL_SEMANTICS


OneShotBuilder = Callable[[str, str, list[str], bool], list[str]]


def _common_tool_semantics() -> dict[str, dict[str, Any]]:
    return {
        name: {
            "operation": semantic["operation"],
            "target_keys": list(semantic["target_keys"]),
        }
        for name, semantic in COMMON_TOOL_SEMANTICS.items()
    }


_JSON_IDENTITY_PATHS = [
    "**.email", "**.emailAddress", "**.email_address", "**.user_email",
    "**.accountUuid", "**.account_id", "**.user_id", "**.sub",
    "**.id_token", "**.idToken",
]

_JSON_HOOK_ENTRY_SHAPE = {
    "groups_key": "hooks",
    "matcher_key": "matcher",
    "entry_type_key": "type",
    "entry_type_value": "command",
    "command_key": "command",
    "timeout_key": "timeout",
}


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


# codex-cli 0.16x accepts only these values (clap rejects anything else and
# the PTY exits with code 2 on start):
#   -a/--ask-for-approval  on-request | never
#   -s/--sandbox           read-only | workspace-write | danger-full-access
# Every IVE mode a Codex session can carry maps to an explicit, valid argv.
CODEX_PERMISSION_ARGS: dict[str, list[str]] = {
    "auto": ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
    "acceptEdits": ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
    "plan": ["--sandbox", "read-only", "--ask-for-approval", "on-request"],
    "manual": ["--ask-for-approval", "on-request"],
    "dontAsk": ["--ask-for-approval", "never"],
    "bypassPermissions": ["--dangerously-bypass-approvals-and-sandbox"],
    "read-only": ["--sandbox", "read-only"],
    "workspace-write": ["--sandbox", "workspace-write"],
    "danger-full-access": ["--sandbox", "danger-full-access"],
}
# Modes the Codex profile accepts on create/update ("default" emits nothing).
CODEX_PERMISSION_MODES = frozenset({"default", *CODEX_PERMISSION_ARGS})


def _codex_permission_args(value: Any) -> Optional[list[str]]:
    """Translate Commander's canonical permission modes to Codex CLI flags."""
    if not value or str(value) == "default":
        return None
    mode = str(value)
    args = CODEX_PERMISSION_ARGS.get(mode)
    if args is None:
        # Never pass an unknown mode through raw: codex would refuse to start.
        import logging
        logging.getLogger(__name__).warning(
            "Codex: ignoring unsupported permission mode %r (using Codex defaults)", mode)
        return None
    return list(args)


def permission_mode_valid_for_profile(profile: "CLIProfile", mode: Any) -> bool:
    """True when ``mode`` is a permission mode this profile can launch with.

    Empty means "profile default" and is always fine. Codex additionally
    accepts every mode in CODEX_PERMISSION_ARGS (e.g. legacy acceptEdits).
    """
    if mode in (None, ""):
        return True
    value = str(mode)
    if profile.id == "codex" and value in CODEX_PERMISSION_MODES:
        return True
    ids = {
        str(item.get("id"))
        for item in (profile.available_permission_modes or [])
        if isinstance(item, dict) and item.get("id") is not None
    }
    return not ids or value in ids


def permission_mode_error_payload(profile: "CLIProfile", mode: Any) -> Optional[dict]:
    """JSON error body when ``mode`` cannot be launched by ``profile``, else None."""
    if permission_mode_valid_for_profile(profile, mode):
        return None
    allowed = [
        str(item.get("id")) for item in (profile.available_permission_modes or [])
        if isinstance(item, dict) and item.get("id") is not None
    ]
    return {
        "error": f"permission_mode {mode!r} is not supported by {profile.label}",
        "code": "invalid_permission_mode",
        "cli_type": profile.id,
        "allowed": allowed,
    }


def _codex_developer_instructions_args(value: Any) -> Optional[list[str]]:
    """Inject IVE session context through Codex's developer-instructions config."""
    if not value:
        return None
    return ["-c", f"developer_instructions={json.dumps(str(value))}"]


def _antigravity_permission_args(value: Any) -> Optional[list[str]]:
    """Translate canonical permission modes to the installed agy CLI shape."""
    if not value or str(value) in ("default", "auto"):
        return None
    if str(value) in ("bypassPermissions", "dontAsk", "yolo"):
        return ["--dangerously-skip-permissions"]
    return None


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

    A profile is pure data plus small pure builder bindings. Declarative
    profiles generate those bindings from their persisted fields.
    """

    id: str
    label: str
    binary: str
    binary_candidates: list[str] = field(default_factory=list)
    adapter_kind: str = "builtin"
    oneshot_args: list[str] = field(default_factory=list)
    prompt_mode: str = "arg"
    model_flag: str = ""
    vision_path_capable: bool = False
    vision_permission_mode: str = ""
    config_dir_env: str = ""
    config_dir_subpath: str = ""
    account_isolation: str = ""
    credential_files: list[str] = field(default_factory=list)
    credential_identity_paths: list[str] = field(default_factory=list)
    auth_login_url: str = ""
    auth_command: list[str] = field(default_factory=list)
    auth_completion_patterns: list[str] = field(default_factory=list)
    auth_allowed_hosts: list[str] = field(default_factory=list)
    auth_provider: str = ""
    oneshot_build: Optional[OneShotBuilder] = None
    active: bool = True
    deprecated: bool = False
    features: dict[Feature, FeatureBinding] = field(default_factory=dict)
    feature_argv: dict[str, list[str]] = field(default_factory=dict)
    feature_paths: dict[str, str] = field(default_factory=dict)
    tool_semantics: dict[str, dict[str, Any]] = field(default_factory=dict)
    permission_mode_rank: list[str] = field(default_factory=list)
    hook_event_map: dict[HookEvent, str] = field(default_factory=dict)

    # ── Infrastructure paths (tilde-prefixed; callers expand with
    #    os.path.expanduser or Path.home()) ────────────────────────────
    home_dir: str = ""                          # "~/.claude" or "~/.gemini"
    settings_file: str = ""                     # "~/.claude/settings.json"
    hook_settings_file: str = ""                # optional override for hook installation
    mcp_config_file: str = ""                   # optional native/global MCP config path
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
    hook_config_format: str = ""
    hook_manifest_dialect: str = ""
    hook_decision_protocol: str = ""
    hook_entry_shape: dict[str, str] = field(default_factory=dict)

    # ── Verification / event delivery ───────────────────────────────
    verified_binary_version: str = ""
    event_sources: dict[str, str] = field(default_factory=dict)

    # ── MCP strategy ──────────────────────────────────────────────────
    mcp_strategy: str = ""
    mcp_add_argv: list[str] = field(default_factory=list)
    mcp_remove_argv: list[str] = field(default_factory=list)
    mcp_env_argv: list[str] = field(default_factory=list)
    mcp_auto_approve_argv: list[str] = field(default_factory=list)
    mcp_config_adapter: str = ""

    # ── Managed system context ────────────────────────────────────────
    managed_context_adapter: str = ""

    # ── Plugin export ─────────────────────────────────────────────────
    plugin_format: str = ""

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

    def build_one_shot(
        self,
        binary: str,
        full_prompt: str,
        model_args: list[str],
        use_stdin: bool,
    ) -> list[str]:
        """Build one one-shot invocation through this profile's adapter."""
        if self.oneshot_build is None:
            raise ValueError(f"CLI profile '{self.id}' has no one-shot adapter")
        return self.oneshot_build(binary, full_prompt, model_args, use_stdin)

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


def _claude_one_shot(
    binary: str, full_prompt: str, model_args: list[str], use_stdin: bool
) -> list[str]:
    if use_stdin:
        return [binary, "--print", *model_args]
    return [binary, "-p", full_prompt, *model_args]


def _gemini_one_shot(
    binary: str, full_prompt: str, model_args: list[str], use_stdin: bool
) -> list[str]:
    if use_stdin:
        return [binary, *model_args]
    return [binary, "-p", full_prompt, *model_args]


def _codex_one_shot(
    binary: str, full_prompt: str, model_args: list[str], use_stdin: bool
) -> list[str]:
    prompt_arg = "-" if use_stdin else full_prompt
    return [binary, "exec", "--skip-git-repo-check", *model_args, prompt_arg]


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
    oneshot_args=["-p"],
    prompt_mode="arg",
    model_flag="--model",
    vision_path_capable=True,
    vision_permission_mode="dontAsk",
    config_dir_env="CLAUDE_CONFIG_DIR",
    config_dir_subpath=".claude",
    account_isolation="config_dir",
    credential_files=[".claude/.credentials.json"],
    credential_identity_paths=list(_JSON_IDENTITY_PATHS),
    auth_login_url="https://console.anthropic.com/login",
    auth_command=["{binary}", "auth", "login"],
    auth_completion_patterns=[
        r"console\.anthropic\.com/(dashboard|settings|workbench|projects)",
    ],
    auth_allowed_hosts=[
        "claude.ai", "console.anthropic.com", "auth.anthropic.com",
        "login.anthropic.com", "api.anthropic.com", "accounts.google.com",
    ],
    auth_provider="Anthropic",
    oneshot_build=_claude_one_shot,
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
            build=lambda v: ["--effort", str(v).strip().lower()]
                if v and str(v).strip().lower() in CLAUDE_EFFORT_LEVELS else None,
            notes="Passed whenever a level is set. Empty means Claude's own "
                  "default (CLAUDE_CODE_EFFORT_LEVEL, modelSettings, "
                  "effortLevel in settings.json, else per-model); see "
                  "effort_defaults.py. 'high' is NOT Claude's default.",
        ),
        Feature.BUDGET_USD: FeatureBinding(
            flag="--max-budget-usd",
            build=lambda v: ["--max-budget-usd", str(v)] if v else None,
            notes="Claude only enforces this with --print (headless runs). "
                  "Interactive PTY sessions ignore it; IVE does not cap them.",
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
    tool_semantics=_common_tool_semantics(),
    permission_mode_rank=[
        "plan", "default", "auto", "acceptEdits", "dontAsk", "bypassPermissions",
    ],
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
    effort_levels=list(CLAUDE_EFFORT_LEVELS),
    model_ladder=["haiku", "sonnet", "opus"],
    message_markers=["\u23FA", ">"],
    ui_capabilities={"force_send": True},
    # ── Hook installation ─────────────────────────────────────────────
    # StopFailure / PostToolUseFailure / PermissionRequest / PermissionDenied
    # added 2026-07-06: the canonical TURN_FAILURE/POST_TOOL_FAILURE/PERMISSION_*
    # events were mapped in hook_event_map but never installed, so turn/tool
    # errors were only inferred from scraped output. Handlers live in hooks.py.
    # (Codex/antigravity NOT given these yet — native hook names unverified,
    #  binaries not installed here; see TESTING TODO in test_hook_failure_events.)
    default_hook_events=[
        # SessionStart carries `source` (startup/resume/clear/compact): /clear
        # hands out a new session_id, which must replace the stored pointer
        # instead of looking like /branch (hooks._maybe_capture_native_id).
        "SessionStart",
        "Stop", "StopFailure", "Notification", "UserPromptSubmit",
        "PreToolUse", "PostToolUse", "PostToolUseFailure",
        "PermissionRequest", "PermissionDenied",
        "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
        # NOT WorktreeCreate / WorktreeRemove: in Claude Code a hook on these
        # events REPLACES git worktree creation/removal and must print the
        # worktree path (create) or delete the directory (remove). The silent
        # relay broke `claude --worktree` and subagent isolation for every
        # user with IVE installed. hook_installer.RELAY_EXCLUDED_EVENTS
        # enforces this and strips stale entries on the next install.
    ],
    hook_config_format="json",
    hook_manifest_dialect="json_groups",
    hook_decision_protocol="claude_json",
    hook_entry_shape=dict(_JSON_HOOK_ENTRY_SHAPE),
    # ── MCP / session detection ───────────────────────────────────────
    mcp_strategy="config_file",
    plugin_format="claude",
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
    oneshot_args=["-p"],
    prompt_mode="arg",
    model_flag="--model",
    account_isolation="home_only",
    credential_files=[
        ".gemini/google_accounts.json",
        ".gemini/oauth_creds.json",
    ],
    credential_identity_paths=list(_JSON_IDENTITY_PATHS),
    oneshot_build=_gemini_one_shot,
    active=False,
    deprecated=True,
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
    tool_semantics=_common_tool_semantics(),
    permission_mode_rank=["plan", "default", "auto_edit", "yolo"],
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
        "AfterAgent", "BeforeAgent", "Notification", "BeforeTool", "AfterTool",
        "SessionStart", "SessionEnd", "PreCompress",
        # No WorktreeCreate / WorktreeRemove: not Gemini CLI events, and the
        # relay must never sit on behaviour-replacing events (see Claude).
    ],
    hook_config_format="json",
    hook_manifest_dialect="json_groups",
    hook_decision_protocol="exit_code",
    hook_entry_shape=dict(_JSON_HOOK_ENTRY_SHAPE),
    # ── MCP / session detection ───────────────────────────────────────
    mcp_strategy="mcp_add",
    mcp_add_argv=[
        "{binary}", "mcp", "add", "{server_name}", "{command}", "{args}",
        "--scope", "project", "--transport", "{transport}",
        "{auto_approve}", "{env}",
    ],
    mcp_remove_argv=["{binary}", "mcp", "remove", "{server_name}", "--scope", "project"],
    mcp_env_argv=["-e", "{key}={value}"],
    mcp_auto_approve_argv=["--trust"],
    plugin_format="gemini",
    session_file_pattern="*.json",
)


# ═══ Codex CLI profile ═══════════════════════════════════════════════════

CODEX_PROFILE = CLIProfile(
    id="codex",
    label="Codex CLI",
    binary="codex",
    oneshot_args=["exec", "--skip-git-repo-check"],
    prompt_mode="arg",
    model_flag="--model",
    config_dir_env="CODEX_HOME",
    config_dir_subpath=".codex",
    account_isolation="config_dir",
    credential_files=[".codex/auth.json"],
    credential_identity_paths=list(_JSON_IDENTITY_PATHS),
    auth_login_url="https://chatgpt.com",
    auth_command=["{binary}", "login"],
    auth_completion_patterns=[
        r"(chatgpt\.com|auth\.openai\.com|platform\.openai\.com)",
    ],
    auth_allowed_hosts=[
        "chatgpt.com", "auth.openai.com", "platform.openai.com",
        "accounts.google.com", "login.microsoftonline.com",
    ],
    auth_provider="OpenAI",
    oneshot_build=_codex_one_shot,
    features={
        Feature.MODEL: FeatureBinding(
            flag="--model",
            build=lambda v: ["--model", str(v)] if v else None,
        ),
        Feature.PERMISSION_MODE: FeatureBinding(
            flag="--ask-for-approval",
            build=_codex_permission_args,
            notes="Codex uses approval/sandbox flags instead of Claude's "
                  "--permission-mode vocabulary.",
        ),
        Feature.ADD_DIRS: FeatureBinding(
            flag="--add-dir",
            build=lambda v: sum(
                [["--add-dir", d] for d in _parse_list(v)], []
            ) or None,
        ),
        Feature.RESUME_ID: FeatureBinding(
            flag="resume",
            build=lambda v: ["resume", str(v)] if v else None,
        ),
        Feature.APPEND_SYSTEM_PROMPT: FeatureBinding(
            flag="-c developer_instructions",
            build=_codex_developer_instructions_args,
            notes="Codex CLI has no append-system-prompt flag; IVE maps the "
                  "combined prompt into Codex's per-invocation "
                  "developer_instructions config instead.",
        ),
        Feature.ALLOWED_TOOLS: FeatureBinding(
            supported=False,
            notes="No direct CLI flag for per-tool allow lists.",
        ),
        Feature.DISALLOWED_TOOLS: FeatureBinding(
            supported=False,
            notes="No direct CLI flag for per-tool deny lists.",
        ),
        Feature.MCP_CONFIG_PATH: FeatureBinding(
            notes="No --mcp-config flag. IVE passes each session's MCP servers "
                  "as `-c mcp_servers.<name>.*` overrides on the codex argv "
                  "(per process; ~/.codex/config.toml is not rewritten).",
        ),
        Feature.PROJECT_MEMORY_FILE: FeatureBinding(
            file_path="AGENTS.md",
            notes="Codex project instructions, read from the repository root down to the working directory; AGENTS.override.md takes precedence.",
        ),
        Feature.GLOBAL_MEMORY_FILE: FeatureBinding(
            file_path="~/.codex/AGENTS.md",
        ),
        Feature.SKILLS_DIR: FeatureBinding(
            file_path=".codex/skills",
            notes="Skill files use the SKILL.md format with YAML frontmatter.",
        ),
        Feature.SKILLS_FORMAT: FeatureBinding(
            notes="skill_md",
        ),
        Feature.SUBAGENTS: FeatureBinding(
            notes="Multi-agent tools with SubagentStart/SubagentStop lifecycle hooks.",
        ),
        Feature.PLAN_DEFAULT_ON: FeatureBinding(supported=False),
        Feature.ALLOWED_MCP_SERVERS: FeatureBinding(supported=False),
    },
    # Verified against codex-cli 0.147.0 (2026-08-16): these are the complete
    # native lifecycle hook names accepted and emitted by this binary. Codex
    # hooks live in config.toml and are distinct from both `codex exec --json`
    # events and the separate `notify` command callback.
    tool_semantics=_common_tool_semantics(),
    permission_mode_rank=["plan", "default", "auto", "dontAsk", "bypassPermissions"],
    hook_event_map={
        HookEvent.SESSION_START:        "SessionStart",
        HookEvent.SESSION_STOP:         "SessionEnd",
        HookEvent.PROMPT_SUBMIT:        "UserPromptSubmit",
        HookEvent.TURN_COMPLETE:        "Stop",
        HookEvent.PRE_TOOL:             "PreToolUse",
        HookEvent.POST_TOOL:            "PostToolUse",
        HookEvent.PERMISSION_REQUEST:   "PermissionRequest",
        HookEvent.PRE_COMPACT:          "PreCompact",
        HookEvent.POST_COMPACT:         "PostCompact",
        HookEvent.SUBAGENT_START:       "SubagentStart",
        HookEvent.SUBAGENT_STOP:        "SubagentStop",
    },
    home_dir="~/.codex",
    settings_file="~/.codex/config.toml",
    plugin_cache_dir="~/.codex/plugins/cache",
    auth_dir_name=".codex",
    default_model="",
    default_permission_mode="auto",
    # Empty = whatever the user's Codex config.toml says. At startup
    # model_discovery.apply_codex_discovery() replaces the menu with the
    # account's models from $CODEX_HOME/models_cache.json and sets every role
    # default to the configured model (no hardcoded gpt-* picks that go stale).
    default_commander_model="",
    default_tester_model="",
    available_models=[
        {"id": "", "label": "Default", "description": "Use Codex CLI config"},
    ],
    available_permission_modes=[
        {"id": "default", "label": "Default", "description": "Ask for each action"},
        {"id": "auto", "label": "Auto", "description": "Workspace writes allowed, ask when needed"},
        {"id": "plan", "label": "Plan", "description": "Read-only sandbox, no edits"},
        {"id": "dontAsk", "label": "Don't Ask", "description": "Never ask, deny if not allowed"},
        {"id": "bypassPermissions", "label": "Bypass All", "description": "Skip all permission checks"},
    ],
    effort_levels=[],
    model_ladder=[],  # filled from models_cache.json at startup
    message_markers=["\u23FA", ">"],
    ui_capabilities={"force_send": True},
    default_hook_events=[
        "SessionStart", "SessionEnd", "UserPromptSubmit", "Stop",
        "PreToolUse", "PermissionRequest", "PostToolUse",
        "PreCompact", "PostCompact", "SubagentStart", "SubagentStop",
    ],
    hook_config_format="toml",
    hook_manifest_dialect="toml_groups",
    hook_decision_protocol="claude_json",
    hook_entry_shape=dict(_JSON_HOOK_ENTRY_SHAPE),
    verified_binary_version="codex-cli 0.162.1",
    event_sources={
        "headless": "codex exec --json JSONL",
        "final_output": "codex exec --output-last-message <path>",
        "interactive": "config.toml lifecycle hooks plus PTY output classification",
        "notify": "config.toml notify command; emits agent-turn-complete only",
    },
    # Per-session `-c mcp_servers.<name>.{command,args,env,url,...}` on the
    # codex argv instead of `codex mcp add/remove` rewriting the global
    # config.toml (verified on codex-cli 0.162.1 with `codex -c ... mcp list`).
    mcp_strategy="config_override",
    session_file_pattern="*.jsonl",
)


ANTIGRAVITY_PROFILE = CLIProfile(
    id="antigravity",
    label="Antigravity CLI",
    binary="antigravity-cli",
    binary_candidates=["agy"],
    oneshot_args=["-p"],
    prompt_mode="arg",
    model_flag="",
    account_isolation="home_only",
    credential_files=[
        ".gemini/google_accounts.json",
        ".gemini/oauth_creds.json",
    ],
    credential_identity_paths=list(_JSON_IDENTITY_PATHS),
    auth_login_url="https://accounts.google.com/signin",
    auth_command=["{binary}"],
    auth_completion_patterns=[
        r"(myaccount\.google\.com|accounts\.google\.com/b/\d|antigravity\.google)",
    ],
    auth_allowed_hosts=[
        "accounts.google.com", "myaccount.google.com", "antigravity.google",
    ],
    auth_provider="Google",
    oneshot_build=_claude_one_shot,
    features={
        Feature.MODEL: FeatureBinding(
            notes="The installed agy CLI has no --model flag. IVE applies a non-empty model by updating Antigravity's CLI settings before launch.",
        ),
        Feature.PERMISSION_MODE: FeatureBinding(
            flag="--dangerously-skip-permissions",
            build=_antigravity_permission_args,
        ),
        Feature.APPEND_SYSTEM_PROMPT: FeatureBinding(
            notes="No append-system-prompt flag in agy; IVE launches with a process-private --add-dir containing an Antigravity Rule for session context.",
        ),
        Feature.ADD_DIRS: FeatureBinding(
            flag="--add-dir",
            build=lambda v: sum(
                [["--add-dir", d] for d in _parse_list(v)], []
            ) or None,
        ),
        Feature.RESUME_ID: FeatureBinding(
            flag="--conversation",
            build=lambda v: ["--conversation", str(v)] if v else None,
        ),
        Feature.PROJECT_MEMORY_FILE: FeatureBinding(
            file_path=".agents/rules/ive-project-memory.md",
            notes="Workspace-scoped durable memory is written as an Antigravity Rule.",
        ),
        Feature.GLOBAL_MEMORY_FILE: FeatureBinding(
            file_path="~/.gemini/GEMINI.md",
            notes="Global Antigravity rule applied across workspaces.",
        ),
        Feature.SKILLS_DIR: FeatureBinding(
            file_path=".gemini/skills",
        ),
        Feature.SKILLS_FORMAT: FeatureBinding(
            notes="skill_md",
        ),
        Feature.SUBAGENTS: FeatureBinding(
            notes="Task subagents via tool use.",
        ),
        Feature.ALLOWED_TOOLS: FeatureBinding(supported=False),
        Feature.DISALLOWED_TOOLS: FeatureBinding(supported=False),
        Feature.MCP_CONFIG_PATH: FeatureBinding(
            notes="agy reads MCP servers from ~/.gemini/config/mcp_config.json; IVE writes this native config before launch.",
            file_path="~/.gemini/config/mcp_config.json",
        ),
        Feature.ALLOWED_MCP_SERVERS: FeatureBinding(supported=False),
    },
    tool_semantics=_common_tool_semantics(),
    permission_mode_rank=["default", "auto", "dontAsk"],
    hook_event_map={
        HookEvent.SESSION_START:        "SessionStart",
        HookEvent.SESSION_STOP:         "SessionEnd",
        HookEvent.PROMPT_SUBMIT:        "BeforeAgent",
        HookEvent.TURN_COMPLETE:        "AfterAgent",
        HookEvent.PRE_TOOL:             "BeforeTool",
        HookEvent.POST_TOOL:            "AfterTool",
        HookEvent.PRE_COMPACT:          "PreCompress",
        HookEvent.NOTIFICATION:         "Notification",
    },
    home_dir="~/.gemini",
    settings_file="~/.gemini/antigravity-cli/settings.json",
    hook_settings_file="~/.gemini/settings.json",
    mcp_config_file="~/.gemini/config/mcp_config.json",
    plugin_cache_dir="~/.gemini/extensions",
    auth_dir_name=".gemini",
    default_model="",
    default_permission_mode="default",
    default_commander_model="Gemini 3.1 Pro (High)",
    default_tester_model="Gemini 3.5 Flash (High)",
    available_models=[
        {"id": "", "label": "Default", "description": "Use Antigravity CLI settings"},
        {"id": "Gemini 3.5 Flash (High)", "label": "Gemini 3.5 Flash High", "description": "Fast high-effort Antigravity setting"},
        {"id": "Gemini 3.1 Pro (High)", "label": "Gemini 3.1 Pro High", "description": "Highest Antigravity setting"},
        {"id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro", "description": "Gemini Pro"},
        {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash", "description": "Fast Gemini"},
    ],
    available_permission_modes=[
        {"id": "default", "label": "Default", "description": "Ask for each action"},
        {"id": "bypassPermissions", "label": "Bypass All", "description": "Skip permission prompts"},
    ],
    effort_levels=[],
    model_ladder=["gemini-2.5-flash", "Gemini 3.5 Flash (High)", "Gemini 3.1 Pro (High)"],
    message_markers=["\u23FA", ">"],
    ui_capabilities={"force_send": True},
    default_hook_events=[
        "AfterAgent", "BeforeAgent", "Notification", "BeforeTool", "AfterTool",
        "SessionStart", "SessionEnd", "PreCompress",
    ],
    hook_config_format="json",
    hook_manifest_dialect="json_groups",
    hook_decision_protocol="exit_code",
    hook_entry_shape=dict(_JSON_HOOK_ENTRY_SHAPE),
    mcp_strategy="global_config_file",
    mcp_config_adapter="antigravity",
    managed_context_adapter="antigravity_rules",
    plugin_format="gemini",
    session_file_pattern="*.jsonl",
)


# ─── Registry ────────────────────────────────────────────────────────────

PROFILES: dict[str, CLIProfile] = {
    "claude": CLAUDE_PROFILE,
    "gemini": GEMINI_PROFILE,
    "codex": CODEX_PROFILE,
    "antigravity": ANTIGRAVITY_PROFILE,
}


# ─── Plain terminal ("shell") ────────────────────────────────────────────
#
# The user's login shell, no agent (see shell_session.py). Deliberately NOT in
# PROFILES: hook installation, MCP sync, model providers, CLI availability and
# every other loop over the agent CLIs must never see it, and is_active_cli()
# stays False so agent-only paths (pipelines, model switch, capability
# workers) refuse it. get_profile("shell") still returns it so per-session
# lookups (labels, UI data) do not crash. Every Feature is unsupported, there
# are no hook events, no MCP strategy and no transcript.

SHELL_PROFILE = CLIProfile(
    id="shell",
    label="Terminal",
    binary="",
    adapter_kind="shell",
    prompt_mode="none",
    active=False,
    features={feature: FeatureBinding(supported=False) for feature in Feature},
    hook_event_map={},
    default_model="",
    default_permission_mode="default",
    available_models=[],
    available_permission_modes=[],
    effort_levels=[],
    message_markers=[],
    ui_capabilities={
        "plain_shell": True,
        "chat_view": False,
        "transcript": False,
        "hooks": False,
        "mcp": False,
        "model_picker": False,
        "permission_picker": False,
        "effort_picker": False,
    },
    default_hook_events=[],
    mcp_strategy="",
    session_file_pattern="",
)


class UnknownCLIProfileError(ValueError):
    """A runtime path referenced a CLI profile that is not registered."""


def get_profile(cli_id: str) -> CLIProfile:
    """Return the exact registered profile or fail with the requested id."""
    if cli_id == SHELL_PROFILE.id:
        return SHELL_PROFILE
    try:
        return PROFILES[cli_id]
    except (KeyError, TypeError) as exc:
        raise UnknownCLIProfileError(
            f"Unknown CLI profile id: {cli_id!r}"
        ) from exc


def all_profiles() -> list[CLIProfile]:
    return list(PROFILES.values())


def active_profiles() -> list[CLIProfile]:
    return [
        profile for profile in PROFILES.values()
        if profile.active and not profile.deprecated
    ]


def is_active_cli(cli_id: str) -> bool:
    profile = PROFILES.get(cli_id)
    return bool(profile and profile.active and not profile.deprecated)
