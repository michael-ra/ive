"""Agent coordination via shared Myelin workspace.

Multiple agents coordinate through a shared graph without touching Myelin core.
Uses semantic similarity (vector cosine) for meaning-level conflict detection.

Unlike file locks (too coarse) or function locks (too granular), semantic locks
detect overlap at the level of WORK ITSELF — regardless of which files are touched.

Usage:
    from myelin import Myelin
    from myelin.coordination import AgentWorkspace

    brain = Myelin(namespace="org:acme:workspace")
    workspace = AgentWorkspace(brain)

    # Agent announces intent
    task = await workspace.announce(
        agent_id="claude_1",
        intent="refactoring auth.py JWT refresh using sliding window",
        reasoning="Detailed analysis...",
    )

    # Another agent checks for overlap
    overlaps = await workspace.check_overlap(
        intent="updating token expiry in auth module",
        threshold=0.80,
    )

    # On conflict, read the other agent's full context
    if overlaps:
        task_id, score, level = overlaps[0]
        context = await workspace.get_context(task_id)
        # Decide: merge, yield, or differentiate
"""
from .workspace import AgentWorkspace, AgentTask, OverlapLevel
from .observer import AgentObserver
from .resolver import CoordinationResolver, Resolution, Action

__all__ = [
    "AgentWorkspace", "AgentTask", "OverlapLevel",
    "AgentObserver",
    "CoordinationResolver", "Resolution", "Action",
]
