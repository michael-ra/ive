"""UnifiedSession — the single CLI-agnostic API Commander targets.

This is Layer 2 of Commander's three-layer CLI abstraction:

    Layer 3: Capability broker (MCP tools) — sits above, consumes this API
    Layer 2: UnifiedSession (this file) — what everything targets
    Layer 1: CLIProfile (cli_profiles.py) — per-CLI bindings

Usage pattern:

    session = UnifiedSession("claude", {"model": "sonnet", "effort": "high"})
    if session.supports(Feature.PLAN_MODE):
        session.set(Feature.PERMISSION_MODE, "plan")
    session.append_system_prompt("be terse")
    argv = session.build_command()
    # → ["claude", "--model", "sonnet", "--permission-mode", "plan",
    #    "--append-system-prompt", "be terse"]

The same code works for Gemini: pass "gemini" instead of "claude" and the
resulting argv automatically becomes the Gemini-native form. No caller
branches on cli_type anywhere outside this module.

This class intentionally has no I/O — it's a pure function from (cli_id,
config) to argv + capability queries. That makes it trivial to unit test
and cheap to construct.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional

from cli_features import Feature, HookEvent
from cli_profiles import CLIProfile, PROFILES, get_profile


class UnifiedSession:
    """CLI-agnostic session facade.

    Wraps a dict-shaped config (matching the `sessions` table row shape)
    and a CLIProfile. Provides:
      • Capability queries: supports(feature) → bool
      • Config mutation: set(feature, value), append_system_prompt(text)
      • Command building: build_command() → argv
      • Hook event translation: canonical ↔ native names
      • File-path lookups: memory_file(), skills_dir()
    """

    def __init__(self, cli_id: str, config: Optional[dict[str, Any]] = None):
        self.cli_id = cli_id
        self.profile: CLIProfile = get_profile(cli_id)
        # Copy so mutations on this session don't leak back to the caller's
        # dict (which is typically a DB row).
        self.config: dict[str, Any] = dict(config or {})

    # ── Capability queries ─────────────────────────────────────────────────

    def supports(self, feature: Feature) -> bool:
        """True iff this CLI supports the given canonical feature."""
        return self.profile.supports(feature)

    def notes(self, feature: Feature) -> str:
        """Human-readable notes for a feature binding (quirks, caveats)."""
        b = self.profile.features.get(feature)
        return b.notes if b else ""

    def flag_name(self, feature: Feature) -> Optional[str]:
        """Introspection helper: the canonical flag name for a feature, or
        None if the feature isn't supported or isn't flag-based."""
        b = self.profile.binding(feature)
        return b.flag if b else None

    # ── Config mutation ────────────────────────────────────────────────────

    def set(self, feature: Feature, value: Any) -> "UnifiedSession":
        """Set a config value keyed by its canonical Feature name."""
        self.config[feature.value] = value
        return self

    def get(self, feature: Feature, default: Any = None) -> Any:
        return self.config.get(feature.value, default)

    def append_system_prompt(self, text: str) -> "UnifiedSession":
        """Append to the running system prompt, joining with a blank line.

        Safe to call multiple times — each call concatenates. Commander uses
        this to stack multiple guideline fragments before emitting a single
        --append-system-prompt (or -i for Gemini).
        """
        if not text:
            return self
        existing = self.config.get(Feature.APPEND_SYSTEM_PROMPT.value, "") or ""
        self.config[Feature.APPEND_SYSTEM_PROMPT.value] = (
            f"{existing}\n\n{text}" if existing else text
        )
        return self

    # ── Command building ───────────────────────────────────────────────────

    def build_command(self, extra_args: Optional[list[str]] = None) -> list[str]:
        """Build the full argv for this session.

        Walks every supported binding on the profile, asks it to produce its
        argv contribution (or None to skip), and concatenates. The order of
        bindings in the profile's `features` dict determines the argv order.

        `extra_args` is appended verbatim at the end — used for flags that
        live outside the Feature vocabulary (e.g. session-type-specific
        arguments like --allowed-mcp-server-names commander).
        """
        cmd: list[str] = [self.profile.binary]

        for feature, binding in self.profile.features.items():
            if not binding.supported or not binding.build:
                continue
            value = self.config.get(feature.value)
            if value is None:
                continue
            tokens = binding.build(value)
            if tokens is None:
                # Binding explicitly chose to skip (e.g. default filtering).
                continue
            cmd.extend(tokens)

        if extra_args:
            cmd.extend(extra_args)

        return cmd

    # ── Hook event translation ─────────────────────────────────────────────

    def native_hook_name(self, canonical: HookEvent) -> Optional[str]:
        """Canonical → native event name for this CLI. None if unsupported."""
        return self.profile.native_hook(canonical)

    def canonical_hook_name(self, native: str) -> Optional[HookEvent]:
        """Native event name → canonical HookEvent. None if unknown."""
        return self.profile.canonical_hook(native)

    # ── File paths (memory, skills) ────────────────────────────────────────

    def memory_file(self) -> Optional[str]:
        """Project-level memory file name (CLAUDE.md / GEMINI.md)."""
        b = self.profile.binding(Feature.PROJECT_MEMORY_FILE)
        return b.file_path if b else None

    def global_memory_file(self) -> Optional[str]:
        """Global memory file path (~/.claude/CLAUDE.md, etc.)."""
        b = self.profile.binding(Feature.GLOBAL_MEMORY_FILE)
        return b.file_path if b else None

    def skills_dir(self) -> Optional[str]:
        """Directory where this CLI looks for skill files."""
        b = self.profile.binding(Feature.SKILLS_DIR)
        return b.file_path if b else None

    # ── Profile data accessors ────────────────────────────────────────────
    #
    # These expose CLIProfile metadata through the session facade so callers
    # never need to reach through to the profile directly.

    def home_path(self) -> Path:
        """Expanded home directory for this CLI (~/.claude → /Users/x/.claude)."""
        return Path(os.path.expanduser(self.profile.home_dir))

    def settings_path(self) -> Path:
        """Expanded path to this CLI's settings file."""
        return Path(os.path.expanduser(self.profile.settings_file))

    def plugin_cache_path(self) -> Path:
        """Expanded path to this CLI's plugin cache directory."""
        return Path(os.path.expanduser(self.profile.plugin_cache_dir))

    def default_model(self) -> str:
        """Default model for new sessions of this CLI type."""
        return self.profile.default_model

    def default_permission_mode(self) -> str:
        """Default permission/approval mode for this CLI type."""
        return self.profile.default_permission_mode

    def model_ladder(self) -> list[str]:
        """Model escalation ladder (weakest → strongest)."""
        return self.profile.model_ladder

    def mcp_strategy(self) -> str:
        """MCP registration strategy: 'config_file' or 'mcp_add'."""
        return self.profile.mcp_strategy

    # ── Debugging ──────────────────────────────────────────────────────────

    def __repr__(self) -> str:
        return f"<UnifiedSession cli={self.cli_id} config_keys={sorted(self.config.keys())}>"


# ─── Module-level convenience ────────────────────────────────────────────

def build_feature_matrix() -> dict[str, Any]:
    """Produce a JSON-serializable feature compatibility matrix.

    Shape:
    {
        "features": [{"id": "MODEL", "label": "Model selection"}, ...],
        "hook_events": [{"id": "SESSION_START", "label": "..."}, ...],
        "profiles": {
            "claude": {
                "id": "claude",
                "label": "Claude Code",
                "binary": "claude",
                "features": {
                    "MODEL": {"supported": true, "flag": "--model", "notes": "", "file_path": null},
                    "EFFORT": {"supported": true, ...},
                    ...
                },
                "hook_events": {"SESSION_START": "SessionStart", ...}
            },
            "gemini": { ... }
        }
    }

    Used by the marketplace UI to render compatibility badges and by the
    /api/cli-info/features endpoint for tooling.
    """
    from cli_features import FEATURE_LABELS, HOOK_EVENT_LABELS

    return {
        "features": [
            {"id": f.name, "value": f.value, "label": FEATURE_LABELS[f]}
            for f in Feature
        ],
        "hook_events": [
            {"id": e.name, "value": e.value, "label": HOOK_EVENT_LABELS[e]}
            for e in HookEvent
        ],
        "profiles": {
            profile.id: {
                "id": profile.id,
                "label": profile.label,
                "binary": profile.binary,
                "features": {
                    feature.name: {
                        "supported": binding.supported,
                        "flag": binding.flag,
                        "file_path": binding.file_path,
                        "notes": binding.notes,
                    }
                    for feature, binding in profile.features.items()
                },
                "hook_events": {
                    event.name: native
                    for event, native in profile.hook_event_map.items()
                },
                # Profile metadata — consumed by frontend for CLI-aware UI
                "home_dir": profile.home_dir,
                "default_model": profile.default_model,
                "default_permission_mode": profile.default_permission_mode,
                "available_models": profile.available_models,
                "available_permission_modes": profile.available_permission_modes,
                "effort_levels": profile.effort_levels,
                "model_ladder": profile.model_ladder,
                "message_markers": profile.message_markers,
                "ui_capabilities": profile.ui_capabilities,
                "mcp_strategy": profile.mcp_strategy,
            }
            for profile in PROFILES.values()
        },
    }
