"""Conflict resolution layer — turns overlap detections into tool result strings.

When the AgentObserver detects a conflict, the middleware needs to decide
what to RETURN as the tool result. This is the only intervention point in
the LLM tool-use loop — what we return becomes the next round's input.

The resolver doesn't pause or rerun anything. It produces an informative
tool result that the LLM reads in its NEXT turn and decides how to react.

Resolution actions per overlap level (thresholds live in OverlapLevel):
    CONFLICT  (>=0.80) → BLOCK with full context (LLM must yield/coordinate)
    SHARE     (>=0.65) → ALLOW + share lessons + warn merge concerns
    NOTIFY    (>=0.55) → ALLOW + brief FYI
    TANGENT   (>=0.48) → ALLOW silently (or minimal log)
    UNRELATED (<0.48)  → ALLOW silently

The LLM is responsible for resolving — middleware just provides info.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING

from .workspace import OverlapLevel

if TYPE_CHECKING:
    from .workspace import AgentTask, AgentWorkspace


class Action(str, Enum):
    """What the middleware should do with the tool call."""
    PROCEED = "proceed"           # Execute normally (no message or brief FYI)
    PROCEED_WITH_NOTE = "proceed_with_note"  # Execute + append info to result
    BLOCK = "block"               # Don't execute; return error as tool result
    DEFER = "defer"               # Queue for later (return queued message)


@dataclass
class Resolution:
    """The middleware's decision: what to do, and what message to inject."""
    action: Action
    message: str = ""             # to append to tool result (or replace it)
    blocked: bool = False         # True if action is BLOCK or DEFER

    def __bool__(self) -> bool:
        # Truthy if any coordination happened
        return bool(self.message)


class CoordinationResolver:
    """Decides how to handle detected overlaps. Pure logic, no I/O.

    Usage in middleware:
        conflicts = await observer.check_before_write(file_path)
        resolution = resolver.resolve(conflicts, action_type="edit")
        if resolution.blocked:
            return resolution.message  # don't execute the tool
        else:
            result = await actual_tool_call()
            if resolution.message:
                result += "\n\n" + resolution.message
            return result
    """

    def __init__(
        self,
        workspace: "AgentWorkspace | None" = None,
        block_on_conflict: bool = True,
        share_lessons: bool = True,
    ):
        self._workspace = workspace
        self._block_on_conflict = block_on_conflict
        self._share_lessons = share_lessons

    async def resolve(
        self,
        conflicts: list["AgentTask"],
        action_type: str = "edit",
    ) -> Resolution:
        """Decide what to do given a list of detected conflicts."""
        if not conflicts:
            return Resolution(action=Action.PROCEED)

        # Find the strongest conflict
        top = max(conflicts, key=lambda c: c.score)

        if top.level == OverlapLevel.CONFLICT:
            return await self._handle_conflict(top, action_type)

        if top.level == OverlapLevel.SHARE:
            return await self._handle_share(top, action_type)

        if top.level == OverlapLevel.NOTIFY:
            return self._handle_notify(top, action_type)

        # TANGENT or UNRELATED — proceed silently
        return Resolution(action=Action.PROCEED)

    # ── CONFLICT (>=0.80): hard block ──

    async def _handle_conflict(self, other: "AgentTask", action_type: str) -> Resolution:
        if not self._block_on_conflict:
            return Resolution(
                action=Action.PROCEED_WITH_NOTE,
                message=self._format_conflict_warning(other),
            )

        # Fetch full reasoning if workspace available
        full_reasoning = other.reasoning  # already truncated to 300
        if self._workspace:
            try:
                ctx = await self._workspace.get_context(other.id)
                full_reasoning = ctx.get("reasoning", other.reasoning)[:800]
            except Exception:
                pass

        msg = (
            f"⛔ COORDINATION HOLD — {action_type} blocked\n"
            f"\n"
            f"agent {other.agent_id} is doing very similar work (cosine={other.score:.2f}):\n"
            f"  intent: {other.intent}\n"
            f"  status: {other.status}\n"
            f"  started: {other.started_at}\n"
            f"  files: {', '.join(other.files_touched) if other.files_touched else '(unknown)'}\n"
            f"\n"
            f"Their full reasoning:\n"
            f"  {full_reasoning}\n"
            f"\n"
            f"Options:\n"
            f"  1. WAIT — poll the workspace and retry when their task completes\n"
            f"  2. COORDINATE — write a response task to share your concerns\n"
            f"  3. DIFFERENTIATE — take a non-overlapping approach\n"
            f"  4. OVERRIDE — proceed anyway (use this only if urgent)\n"
            f"\n"
            f"You should reason about which option fits and act in your next response."
        )
        return Resolution(action=Action.BLOCK, message=msg, blocked=True)

    # ── SHARE (0.65-0.80): allow + share lessons ──

    async def _handle_share(self, other: "AgentTask", action_type: str) -> Resolution:
        # Fetch lessons if available
        lessons_str = ""
        if self._share_lessons and self._workspace:
            try:
                ctx = await self._workspace.get_context(other.id)
                lessons = ctx.get("lessons_learned", []) or other.lessons_learned
                if lessons:
                    lessons_str = "\nTheir lessons learned so far:\n"
                    for lesson in lessons[:3]:
                        lessons_str += f"  • {lesson}\n"
            except Exception:
                pass

        msg = (
            f"\nℹ Similar work in progress (cosine={other.score:.2f}):\n"
            f"  agent {other.agent_id} is doing: {other.intent}\n"
            f"  status: {other.status}"
            f"{lessons_str}"
            f"\nConsider their approach to avoid duplicating effort or inconsistent patterns."
        )
        return Resolution(action=Action.PROCEED_WITH_NOTE, message=msg)

    # ── NOTIFY (0.55-0.65): brief FYI ──

    def _handle_notify(self, other: "AgentTask", action_type: str) -> Resolution:
        msg = (
            f"\n[fyi] agent {other.agent_id} is also active in a related area: "
            f"\"{other.intent[:60]}\" (cosine={other.score:.2f})"
        )
        return Resolution(action=Action.PROCEED_WITH_NOTE, message=msg)

    # ── Helper for non-blocking conflict warning ──

    def _format_conflict_warning(self, other: "AgentTask") -> str:
        return (
            f"\n⚠ HIGH OVERLAP WARNING (cosine={other.score:.2f}):\n"
            f"agent {other.agent_id} is doing very similar work: \"{other.intent}\".\n"
            f"You proceeded but may collide with their changes."
        )
