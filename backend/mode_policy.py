"""Mode policy for PTY start, hook denial, and task field filtering.

Three modes:
  • brief — no PTY, no execution. Task create/comment + thumbs-up only.
  • code  — drive sessions in auto/plan; no Bash unless allowlisted; no
            MCP/account/plugin mutation.
  • full  — owner-equivalent. TTL-bounded only.
"""
from __future__ import annotations

from cli_features import Feature

# Tools we consider safe for read/edit work in Code mode. Bash is
# deliberately omitted; if the owner has configured a Bash allowlist in
# app_settings, individual `Bash(<pattern>)` entries are appended below.
SAFE_CODING_TOOLS = [
    "Read", "Glob", "Grep", "Edit", "Write", "MultiEdit",
    "TodoWrite", "WebFetch", "WebSearch",
]

BRIEF_TASK_FIELDS = {
    "title", "description", "acceptance_criteria", "labels",
    "result_summary", "scratchpad", "lessons_learned",
    "important_notes",
}
CODE_TASK_FIELDS = BRIEF_TASK_FIELDS | {
    "status", "assigned_session_id", "commander_session_id",
    "queued_for_session_id", "queue_order", "iteration",
    "priority",
}

# Brief is allowed to move tasks between these statuses only — no
# in_progress / done transitions.
BRIEF_STATUS_WHITELIST = {"backlog", "todo"}


class ModePermissionError(PermissionError):
    """Raised when a session start is rejected by mode policy."""


def filter_task_update_body(body: dict, mode: str) -> tuple[dict, list[str]]:
    """Return (filtered_body, dropped_fields) for an update_task call.

    For Full mode, `body` is returned unchanged. For Code/Brief, fields
    not in the allowed set are stripped and reported back to the caller
    so the route handler can return a loud 403 instead of silently
    dropping them.
    """
    if mode == "full":
        return body, []
    allowed = CODE_TASK_FIELDS if mode == "code" else BRIEF_TASK_FIELDS
    filtered = {}
    dropped = []
    for k, v in body.items():
        if k in allowed:
            filtered[k] = v
        else:
            dropped.append(k)
    return filtered, dropped


def validate_brief_status_transition(new_status: str | None) -> str | None:
    """Return error string if Brief tries an unauthorized status. None on OK."""
    if new_status is None:
        return None
    if new_status not in BRIEF_STATUS_WHITELIST:
        return (
            f"Brief mode cannot move tasks to '{new_status}'. "
            f"Allowed transitions: {sorted(BRIEF_STATUS_WHITELIST)}."
        )
    return None


def enforce_mode_for_pty(unified_session, mode: str | None,
                         *, code_bash_allowlist: list[str] | None = None) -> None:
    """Mutate a UnifiedSession's config in-place to match the caller's mode.

    Raises ModePermissionError for Brief (Brief cannot start PTYs).
    For Code: clamps permission_mode away from yolo/dontAsk/bypass to
    'auto'; restricts allowed_tools to SAFE_CODING_TOOLS plus any
    Bash(<pattern>) entries from the owner's allowlist.
    """
    if not mode or mode == "full":
        return

    if mode == "brief":
        raise ModePermissionError("Brief mode cannot start PTY sessions.")

    if mode == "code":
        cur_pm = unified_session.config.get(Feature.PERMISSION_MODE.value, "default")
        if cur_pm in ("bypassPermissions", "dontAsk", "yolo"):
            unified_session.set(Feature.PERMISSION_MODE, "auto")

        # Tool allowlist. Different CLIs name things differently, but
        # the canonical Feature.ALLOWED_TOOLS slot is shared.
        allowed = list(SAFE_CODING_TOOLS)
        for pat in (code_bash_allowlist or []):
            if pat:
                allowed.append(f"Bash({pat})")
        try:
            unified_session.set(Feature.ALLOWED_TOOLS, allowed)
        except Exception:
            # Some profiles may not bind ALLOWED_TOOLS; tolerable since
            # the hook layer will still deny tools at runtime.
            pass
