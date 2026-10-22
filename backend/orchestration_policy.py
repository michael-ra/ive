"""Workspace orchestration policy helpers.

The policy is stored as JSON on the workspaces row so the backend
orchestrator, Commander prompts, pipeline engine, and UI all share one source
of truth for model routing and reuse guidance.

Each role holds a list of *candidate* (cli_type, model) pairs with a priority
number — higher numbers win. When multiple candidates share the top priority,
one is chosen at random, which gives operators a cheap way to A/B between
models or spread load across providers.
"""
from __future__ import annotations

import json
import random
from typing import Any, Iterable


ROLE_LABELS: dict[str, str] = {
    "brain": "Brain / router",
    "summary": "Summary / memory",
    "brainstormer": "Product intake / brainstormer",
    "architect": "Architect / conception",
    "planner": "Planner",
    "plan_critic": "Plan reviewer",
    "research": "Deep research",
    "research_critic": "Research reviewer",
    "default_worker": "Default worker",
    "cheap_worker": "Cheap worker",
    "strong_worker": "Strong worker",
    "code_reviewer": "Code reviewer",
    "tester": "Tester",
    "documentor": "Documentor",
    "secure": "Secure / offensive tester",
}

ROLE_FALLBACKS: dict[str, tuple[str, ...]] = {
    "brainstormer": ("planner", "brain"),
    # Conception wants the strongest reasoning available; if no architect model
    # is configured, borrow the planner's, then the commander's (brain).
    "architect": ("planner", "brain"),
    # Deep research borrows the Commander/brain model when no research model is
    # explicitly configured — the runner still floors to claude/sonnet if both
    # are unset, so research never falls back to a quota-dead default.
    "research": ("brain",),
    # The research reviewer is an INDEPENDENT judge — prefer a model distinct
    # from the one that produced the findings; if unset, borrow the plan
    # reviewer, then the brain. (Runner floors to claude/sonnet like research.)
    "research_critic": ("plan_critic", "brain"),
    # Offensive testing wants strong reasoning (it writes its own exploits and
    # interprets tool output); borrow the strong worker, then default worker.
    "secure": ("strong_worker", "default_worker"),
}


SESSION_TYPE_POLICY_ROLE: dict[str, str] = {
    "commander": "brain",
    "brainstormer": "brainstormer",
    "architect": "architect",
    "planner": "planner",
    "worker": "default_worker",
    "test_worker": "tester",
    "tester": "tester",
    "documentor": "documentor",
    "secure": "secure",
}


def _normalize_candidate(cfg: Any) -> dict[str, Any] | None:
    """Coerce a candidate dict into {cli_type, model, priority} or None if empty."""
    if not isinstance(cfg, dict):
        return None
    cli_type = str(cfg.get("cli_type") or "").strip()
    model = str(cfg.get("model") or "").strip()
    if not cli_type and not model:
        return None
    try:
        priority = int(cfg.get("priority", 1))
    except (TypeError, ValueError):
        priority = 1
    return {"cli_type": cli_type, "model": model, "priority": priority}


def _normalize_candidates(role_cfg: Any) -> list[dict[str, Any]]:
    """Return a list of normalized candidates for a role config.

    Accepts both the new shape `{candidates: [...]}` and the legacy shape
    `{cli_type, model}` (wrapped as a single priority=1 candidate).
    """
    if not isinstance(role_cfg, dict):
        return []

    raw_candidates = role_cfg.get("candidates")
    if isinstance(raw_candidates, list):
        out: list[dict[str, Any]] = []
        for cand in raw_candidates:
            norm = _normalize_candidate(cand)
            if norm is not None:
                out.append(norm)
        return out

    legacy = _normalize_candidate(role_cfg)
    return [legacy] if legacy is not None else []


def parse_policy(raw: Any) -> dict[str, Any]:
    """Return a normalized policy dict from DB JSON/object/None."""
    if isinstance(raw, dict):
        policy = raw
    elif isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = {}
        policy = parsed if isinstance(parsed, dict) else {}
    else:
        policy = {}

    roles = policy.get("roles")
    if not isinstance(roles, dict):
        roles = {}

    normalized_roles: dict[str, dict[str, Any]] = {}
    for role_id in ROLE_LABELS:
        normalized_roles[role_id] = {"candidates": _normalize_candidates(roles.get(role_id))}

    return {
        "roles": normalized_roles,
        "routing_instructions": str(policy.get("routing_instructions") or "").strip(),
        "reuse_instructions": str(policy.get("reuse_instructions") or "").strip(),
        "summary_mode": str(policy.get("summary_mode") or "hybrid").strip() or "hybrid",
    }


def policy_role_for_session_type(session_type: str | None, explicit_role: str | None = None) -> str:
    """Resolve the model-policy role for a pipeline/session role."""
    if explicit_role in ROLE_LABELS:
        return explicit_role
    return SESSION_TYPE_POLICY_ROLE.get((session_type or "worker").strip(), "default_worker")


def _exclude_set(exclude: Iterable[tuple[str | None, str | None]] | None) -> set[tuple[str, str]]:
    if not exclude:
        return set()
    out: set[tuple[str, str]] = set()
    for item in exclude:
        if not item:
            continue
        cli, model = item
        out.add(((cli or "").strip(), (model or "").strip()))
    return out


def _candidates_for_role(
    policy: dict[str, Any],
    role_id: str,
    seen: set[str] | None = None,
) -> list[dict[str, Any]]:
    seen = seen or set()
    if role_id in seen:
        return []
    seen.add(role_id)

    cfg = policy["roles"].get(role_id) or {}
    candidates = cfg.get("candidates") or []
    if candidates:
        return candidates

    for fallback_role in ROLE_FALLBACKS.get(role_id, ()):
        fallback_candidates = _candidates_for_role(policy, fallback_role, seen)
        if fallback_candidates:
            return fallback_candidates

    return []


def role_model(
    policy_raw: Any,
    role_id: str,
    exclude: Iterable[tuple[str | None, str | None]] | None = None,
) -> tuple[str | None, str | None]:
    """Pick a (cli_type, model) for a role.

    Candidates are grouped by priority (higher number = higher priority); the
    top non-empty group is chosen and one of its candidates is picked at
    random. `exclude` lets a caller filter out already-tried (cli, model)
    tuples so it can fall through to the next priority tier on retry.
    """
    policy = parse_policy(policy_raw)
    candidates = _candidates_for_role(policy, role_id)
    blocked = _exclude_set(exclude)

    if blocked:
        candidates = [
            c for c in candidates
            if (c["cli_type"], c["model"]) not in blocked
        ]
    if not candidates:
        return None, None

    by_priority: dict[int, list[dict[str, Any]]] = {}
    for c in candidates:
        by_priority.setdefault(c["priority"], []).append(c)

    top = by_priority[max(by_priority)]
    pick = random.choice(top)
    return pick["cli_type"] or None, pick["model"] or None


def render_policy_for_prompt(policy_raw: Any) -> str:
    """Render policy as compact system-prompt guidance for Commander/Brain."""
    policy = parse_policy(policy_raw)
    lines = ["## Workspace Orchestration Policy"]

    configured = []
    for role_id, label in ROLE_LABELS.items():
        candidates = policy["roles"].get(role_id, {}).get("candidates") or []
        if not candidates:
            continue
        # Highest priority first; ties keep insertion order.
        ordered = sorted(candidates, key=lambda c: -c["priority"])
        rendered = ", ".join(
            f"{c['cli_type'] or 'default CLI'}/{c['model'] or 'default model'}(p={c['priority']})"
            for c in ordered
        )
        configured.append(f"- {label}: {rendered}")
    if configured:
        lines.append("\nRole model candidates (higher p = preferred; ties random):")
        lines.extend(configured)

    fallback_notes = []
    for role_id, fallback_roles in ROLE_FALLBACKS.items():
        labels = [ROLE_LABELS.get(r, r) for r in fallback_roles]
        fallback_notes.append(
            f"- {ROLE_LABELS.get(role_id, role_id)}: falls back to {', then '.join(labels)} when unset"
        )
    if fallback_notes:
        lines.append("\nRole fallbacks:")
        lines.extend(fallback_notes)

    if policy.get("routing_instructions"):
        lines.append("\nRouting instructions:")
        lines.append(policy["routing_instructions"])

    if policy.get("reuse_instructions"):
        lines.append("\nSession reuse instructions:")
        lines.append(policy["reuse_instructions"])

    lines.append(
        "\nUse this policy when choosing task complexity, pipeline shape, model tier, "
        "and whether to reuse an idle session or start a fresh one. The backend "
        "orchestrator reads the same policy."
    )
    return "\n".join(lines)
