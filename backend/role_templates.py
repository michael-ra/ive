"""Role templates — C2 of the orchestrator redesign.

A role template is a versioned, harness-portable definition of an agent role:
what model/permission defaults it wants, which harnesses it prefers, what tools
it needs, a system-prompt fragment, and — critically — the JSON result_schema it
must return via the `submit_result` tool (the C1 typed agent contract).

This unifies the split-brain where tester/documentor lived half as `session_type`
special-cases and half as capability tags: a role is now one declarative object,
portable across claude/codex/antigravity. Model/permission defaults intentionally
mirror pipeline_engine.SESSION_TYPE_DEFAULTS and the orchestration_policy roles so
adopting a template changes nothing about model routing by default.

Pure module: no side effects, stdlib only, safe to import anywhere.
"""
from __future__ import annotations

from typing import Any, Optional


# Result schemas each role is asked to submit_result() against. Kept small and
# permissive (validate_against_schema in pipeline_engine is a minimal checker).
_TESTER_SCHEMA = {
    "type": "object",
    "required": ["verdict"],
    "properties": {
        "verdict": {"type": "string", "enum": ["pass", "fail"]},
        "failures": {"type": "array", "items": {"type": "string"}},
        "evidence": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
}
_SECURE_SCHEMA = {
    "type": "object",
    "required": ["scope_ok"],
    "properties": {
        "scope_ok": {"type": "boolean"},
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["severity", "title"],
                "properties": {
                    "severity": {"type": "string", "enum": ["info", "low", "medium", "high", "critical"]},
                    "title": {"type": "string"},
                    "detail": {"type": "string"},
                },
            },
        },
        "summary": {"type": "string"},
    },
}
_DOCUMENTOR_SCHEMA = {
    "type": "object",
    "required": ["summary"],
    "properties": {
        "pages_written": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
}
_PLANNER_SCHEMA = {
    "type": "object",
    "required": ["plan_steps"],
    "properties": {
        "plan_steps": {"type": "array", "items": {"type": "string"}},
        "risks": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
}
_REVIEWER_SCHEMA = {
    "type": "object",
    "required": ["verdict"],
    "properties": {
        "verdict": {"type": "string", "enum": ["pass", "fail"]},
        "issues": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
}
_WORKER_SCHEMA = {
    "type": "object",
    "required": ["verdict"],
    "properties": {
        "verdict": {"type": "string", "enum": ["pass", "fail"]},
        "changed_files": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
}


# role -> template. `policy_role` links a template to the orchestration_policy
# model-routing role; `session_type` is the storage/runtime session type the
# engine should spawn for this role (tester/documentor normalize to worker+tag).
ROLE_TEMPLATES: dict[str, dict[str, Any]] = {
    "worker": {
        "role": "worker", "version": 1,
        "policy_role": "default_worker", "session_type": "worker",
        "harness_pref": ["claude", "codex", "antigravity"],
        "model": "sonnet", "permission_mode": "auto", "effort": None,
        "tools": [],
        "system_fragment": "",
        "result_schema": _WORKER_SCHEMA,
    },
    "planner": {
        "role": "planner", "version": 1,
        "policy_role": "planner", "session_type": "planner",
        "harness_pref": ["claude", "codex", "antigravity"],
        "model": "opus", "permission_mode": "plan", "effort": None,
        "tools": [],
        "system_fragment": "Produce a concrete, ordered plan. Do not implement.",
        "result_schema": _PLANNER_SCHEMA,
    },
    "architect": {
        "role": "architect", "version": 1,
        "policy_role": "architect", "session_type": "architect",
        "harness_pref": ["claude", "codex", "antigravity"],
        "model": "opus", "permission_mode": "plan", "effort": None,
        "tools": [],
        "system_fragment": "Design the north-star architecture and epic roadmap. Do not implement.",
        "result_schema": _PLANNER_SCHEMA,
    },
    "plan_critic": {
        "role": "plan_critic", "version": 1,
        "policy_role": "plan_critic", "session_type": "planner",
        "harness_pref": ["claude", "codex", "antigravity"],
        "model": "opus", "permission_mode": "plan", "effort": None,
        "tools": [],
        "system_fragment": (
            "Review the supplied implementation plan against the task and repository evidence. "
            "Keep file and shell access read-only. Return a typed pass/fail verdict through "
            "the local IVE completion tool; do not create a CLI plan file or implement the plan."
        ),
        "result_schema": _REVIEWER_SCHEMA,
    },
    "tester": {
        "role": "tester", "version": 1,
        "policy_role": "tester", "session_type": "tester",  # normalized to worker+capability_testing
        "harness_pref": ["claude", "codex"],
        "model": "sonnet", "permission_mode": "auto", "effort": None,
        "tools": ["playwright", "testing-agent"],
        "system_fragment": (
            "You are verifying an implementation. Run tests, check behavior, and report a "
            "definitive verdict. Call submit_result with your typed verdict when done."
        ),
        "result_schema": _TESTER_SCHEMA,
    },
    "documentor": {
        "role": "documentor", "version": 1,
        "policy_role": "documentor", "session_type": "documentor",  # normalized to worker+capability_documentation
        "harness_pref": ["claude"],
        "model": "sonnet", "permission_mode": "auto", "effort": None,
        "tools": ["documentor", "playwright"],
        "system_fragment": "Document the change: update the docs site and report what you wrote.",
        "result_schema": _DOCUMENTOR_SCHEMA,
    },
    "code_reviewer": {
        "role": "code_reviewer", "version": 1,
        "policy_role": "code_reviewer", "session_type": "worker",
        "harness_pref": ["claude", "codex"],
        "model": "sonnet", "permission_mode": "auto", "effort": None,
        "tools": [],
        "system_fragment": "Review the diff for correctness and quality. Report a pass/fail verdict.",
        "result_schema": _REVIEWER_SCHEMA,
    },
    "secure": {
        "role": "secure", "version": 1,
        "policy_role": "secure", "session_type": "secure",
        "harness_pref": ["claude"],
        "model": "opus", "permission_mode": "auto", "effort": None,
        "tools": ["secure"],
        "system_fragment": (
            "You are an authorized offensive/security tester operating strictly within the "
            "provided scope. Execute only inside the secure container. Report findings."
        ),
        "result_schema": _SECURE_SCHEMA,
    },
    "brainstormer": {
        "role": "brainstormer", "version": 1,
        "policy_role": "brainstormer", "session_type": "brainstormer",
        "harness_pref": ["claude"],
        "model": "sonnet", "permission_mode": "plan", "effort": None,
        "tools": [],
        "system_fragment": "Intake and ideation only — propose candidate backlog items, do not implement.",
        "result_schema": None,
    },
}

# session_type (or its aliases) -> canonical role key, for callers that only have
# a session_type. Mirrors orchestration_policy.SESSION_TYPE_POLICY_ROLE intent.
_SESSION_TYPE_TO_ROLE = {
    "worker": "worker",
    "planner": "planner",
    "architect": "architect",
    "tester": "tester",
    "test_worker": "tester",
    "documentor": "documentor",
    "code_reviewer": "code_reviewer",
    "secure": "secure",
    "brainstormer": "brainstormer",
}


def get_role_template(role: Optional[str]) -> Optional[dict[str, Any]]:
    """Return the template for a role key or a session_type alias, else None."""
    if not role:
        return None
    if role in ROLE_TEMPLATES:
        return ROLE_TEMPLATES[role]
    mapped = _SESSION_TYPE_TO_ROLE.get(role)
    return ROLE_TEMPLATES.get(mapped) if mapped else None


def role_result_schema(role: Optional[str]) -> Optional[dict[str, Any]]:
    """Convenience: the result_schema for a role/session_type, or None."""
    tmpl = get_role_template(role)
    return tmpl.get("result_schema") if tmpl else None


def resolve_binding(
    role: Optional[str],
    active_clis: Optional[list[str]] = None,
    policy_raw: Any = None,
) -> dict[str, Any]:
    """Resolve a role to a concrete binding: {cli_type, model, permission_mode,
    effort, tools, system_fragment, result_schema, session_type}.

    Harness is the first template `harness_pref` entry present in `active_clis`
    (falls back to the template default / first pref). When a workspace policy is
    supplied, orchestration_policy.role_model gets first say over (cli, model) so
    operator routing still wins; the template only fills gaps. Never raises."""
    tmpl = get_role_template(role)
    if not tmpl:
        # Unknown role — return a minimal worker-ish binding so callers are safe.
        return {
            "cli_type": None, "model": None, "permission_mode": None,
            "effort": None, "tools": [], "system_fragment": "",
            "result_schema": None, "session_type": role or "worker",
        }

    cli_type: Optional[str] = None
    model: Optional[str] = None

    # Operator policy first (mirrors existing routing).
    if policy_raw is not None:
        try:
            import orchestration_policy
            cli_type, model = orchestration_policy.role_model(policy_raw, tmpl["policy_role"])
        except Exception:
            cli_type, model = None, None

    # Fill harness from preference ∩ available.
    if not cli_type:
        prefs = tmpl.get("harness_pref") or []
        if active_clis:
            cli_type = next((c for c in prefs if c in active_clis), None) or (prefs[0] if prefs else None)
        else:
            cli_type = prefs[0] if prefs else None
    if not model:
        model = tmpl.get("model")

    return {
        "cli_type": cli_type,
        "model": model,
        "permission_mode": tmpl.get("permission_mode"),
        "effort": tmpl.get("effort") or None,  # None = CLI default
        "tools": list(tmpl.get("tools") or []),
        "system_fragment": tmpl.get("system_fragment", ""),
        "result_schema": tmpl.get("result_schema"),
        "session_type": tmpl.get("session_type", "worker"),
    }
