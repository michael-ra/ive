"""Small profile-driven helpers shared by backend routes and tests."""

from __future__ import annotations

import shutil
from collections.abc import Callable
from typing import Any

from cli_profiles import PROFILES, get_profile
from config import (
    AVAILABLE_MODELS,
    EFFORT_LEVELS,
    GEMINI_APPROVAL_MODES,
    GEMINI_MODELS,
    PERMISSION_MODES,
    VERSION,
)


def cli_install_error(
    cli_id: str, *, which: Callable[[str], str | None] = shutil.which
) -> str | None:
    """None if the CLI's binary is on PATH, else a user-facing message.

    Uses the same ``which(profile.binary)`` check that powers
    ``available_clis``, so detection has exactly one implementation.
    """
    profile = get_profile(cli_id)
    if which(profile.binary) is not None:
        return None
    return (
        f"{profile.label} (binary '{profile.binary}') is not installed. "
        f"Install it to start {cli_id} sessions."
    )


def validate_cli_type(cli_type: str | None) -> str:
    """Return a registered CLI id or raise ValueError."""
    cli_id = (cli_type or "claude").lower().strip()
    if cli_id not in PROFILES:
        allowed = ", ".join(sorted(PROFILES))
        raise ValueError(f"cli_type must be one of: {allowed}")
    return cli_id


def cli_for_model(model: str | None) -> str:
    """Resolve which registered CLI owns a model id (profile-driven).

    An exact match against any profile's `available_models` / `model_ladder`
    wins; otherwise id-prefix heuristics route `gemini*` → gemini and
    `gpt-*`/`o3`/`o4`/`codex*` → codex. Unknown/empty → "claude" (preserves
    the old `startswith("gemini-") else "claude"` behavior).
    """
    m = (model or "").strip().lower()
    if not m:
        return "claude"
    for cli_id, profile in PROFILES.items():
        known = {x["id"].lower() for x in profile.available_models}
        known |= {x.lower() for x in profile.model_ladder}
        if m in known:
            return cli_id
    if m.startswith("gemini"):
        return "gemini"
    if m.startswith(("gpt-", "gpt5", "o3", "o4", "codex")):
        return "codex"
    return "claude"


def build_cli_info_payload(
    discovered_models: dict[str, list[dict] | None] | None = None,
    *,
    which: Callable[[str], str | None] = shutil.which,
) -> dict[str, Any]:
    """Build the /api/cli-info response from registered CLI profiles."""
    discovered_models = discovered_models or {}
    profile_models = {
        cli_id: discovered_models.get(cli_id) or profile.available_models
        for cli_id, profile in PROFILES.items()
    }

    return {
        "version": VERSION,
        # Backward-compatible fields consumed by older frontend code.
        "models": profile_models.get("claude") or AVAILABLE_MODELS,
        "permission_modes": PERMISSION_MODES,
        "effort_levels": EFFORT_LEVELS,
        "gemini_models": profile_models.get("gemini") or GEMINI_MODELS,
        "gemini_approval_modes": GEMINI_APPROVAL_MODES,
        # Profile-driven fields.
        "cli_types": [{"id": p.id, "label": p.label} for p in PROFILES.values()],
        "available_clis": {
            cli_id: which(profile.binary) is not None
            for cli_id, profile in PROFILES.items()
        },
        "profile_models": profile_models,
        "default_models": {
            cli_id: get_profile(cli_id).default_model
            for cli_id in PROFILES
        },
    }
