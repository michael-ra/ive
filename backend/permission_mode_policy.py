"""Permission-mode ceiling enforcement.

The user picks a session's permission mode in the UI. That choice is the
*ceiling* — agents calling back via the local MCP server (recognised by
the `X-IVE-Session-Type: commander` header in middleware) can request
a narrower mode (e.g. user picked `auto`, agent wants `plan`) but cannot
widen beyond it, and cannot unilaterally exit `plan`.

Without this, an agent in plan mode can simply PUT `permission_mode: "auto"`
on its own session and walk out — the plan-mode tool guard in hooks.py
only blocks tools, not mode changes. See update_session in server.py.
"""
from __future__ import annotations

from cli_profiles import UnknownCLIProfileError, get_profile

def _rank(cli_type: str, mode: str) -> int | None:
    try:
        table = get_profile(cli_type).permission_mode_rank
    except UnknownCLIProfileError:
        return None
    if not table:
        return None
    try:
        return table.index(mode)
    except ValueError:
        return None


def is_widening(cli_type: str, current: str, proposed: str) -> bool:
    """True if `proposed` is more permissive than `current`.

    Unknown modes return True (treat as widening / unsafe) so the caller
    rejects rather than silently accepts a typo.
    """
    if current == proposed:
        return False
    c = _rank(cli_type, current)
    p = _rank(cli_type, proposed)
    if c is None or p is None:
        return True
    return p > c


def is_plan_exit(current: str, proposed: str) -> bool:
    """True if the change exits plan mode."""
    return (current or "").lower() == "plan" and (proposed or "").lower() != "plan"


def validate_agent_mode_change(
    cli_type: str, current: str, proposed: str
) -> str | None:
    """Return rejection reason if an agent-sourced change is disallowed.

    Returns None when the change is allowed.

    Plan exit is a special form of widening (plan is the strictest mode in
    every profile that has it), so we surface that message specifically —
    it tells the user the actionable reason ("plan exit is user-only") rather
    than the generic "widening" framing.
    """
    if current == proposed:
        return None
    if is_plan_exit(current, proposed):
        return (
            f"Agent cannot exit plan mode ({current} → {proposed}). "
            "Plan exit is user-only — change the mode from the Perms menu in the IVE UI."
        )
    if is_widening(cli_type, current, proposed):
        return (
            f"Agent cannot widen permissions ({current} → {proposed}). "
            "The current ceiling was set by the user — change it from the Perms menu in the IVE UI to allow this."
        )
    return None


def is_agent_origin(request) -> bool:
    """True when the request came from the local MCP server (the agent),
    not the IVE UI or a paired-device user.

    The MCP server (`backend/mcp_server.py`) always sets the
    `X-IVE-Session-Type` header on its outbound calls; the UI does not.
    Use this as the user-vs-agent discriminator inside permissive
    owner-equivalent auth (localhost trust covers both today).
    """
    try:
        return bool(request.headers.get("X-IVE-Session-Type"))
    except Exception:
        return False
