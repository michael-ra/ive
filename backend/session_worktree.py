"""Normalize workspace/session isolation requests against the actual CLI."""
from cli_features import Feature
from cli_profiles import get_profile


def resolve_worktree(cli_type: str, requested=None, *, default=False) -> int:
    value = default if requested is None else requested
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized not in {"", "0", "false", "off", "no", "1", "true", "on", "yes"}:
            raise ValueError("worktree must be true or false")
        enabled = normalized in {"1", "true", "on", "yes"}
    elif value in (None, False, True, 0, 1):
        enabled = bool(value)
    else:
        raise ValueError("worktree must be true or false")
    profile = get_profile(cli_type)
    if enabled and not profile.supports(Feature.WORKTREE):
        if requested is not None:
            raise ValueError(f"{profile.label} does not support automatic worktree creation in IVE. Choose a supported agent or connect an existing worktree folder.")
        return 0
    return int(enabled)
