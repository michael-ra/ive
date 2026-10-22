"""Optional research metadata/output ports; local research storage stays IVE-owned."""
from __future__ import annotations

import extension_host

CORE_FIELDS = {
    "entry": frozenset({"id", "workspace_id", "scope", "topic", "query", "feature_tag", "modes",
                        "status", "findings_summary", "session_id", "request_id", "created_at", "updated_at"}),
    "schedule": frozenset({"id", "scope", "workspace_id", "context_workspace_id", "query", "modes", "plan",
                           "depth", "cross_temporal", "interval_hours", "enabled", "last_run_at", "next_run_at",
                           "last_job_id", "created_at", "updated_at"}),
    "job": frozenset({"query", "model", "status", "entry_id", "backend", "depth", "recency_months",
                      "cross_temporal", "dig_deeper", "plan", "modes", "scope", "interactive", "request_id",
                      "steer_queries", "scheduled", "started_at", "session_id", "error", "error_code", "cmd", "proc"}),
}


def _contributors():
    """Trusted backend/research_options.py convention, not an isolation layer.

    FIELDS declares product-owned fields in existing resources. values(resource,
    operation, source) normalizes optional additions; on_complete(entry_id, job)
    consumes successful output behind that product's own approval policy.
    No product implementation is required for local research or its scheduler.
    """
    for metadata in extension_host.installed_extensions():
        owner = metadata["id"]
        root = extension_host.extension_path(owner)
        relative = "backend/research_options.py"
        if (root / relative).is_file():
            yield extension_host.load_backend_module(owner, relative)


def _schema(resource: str):
    if resource not in CORE_FIELDS:
        raise ValueError("Unknown research resource")
    seen = set(CORE_FIELDS[resource])
    providers = []
    for contribution in _contributors():
        declarations = getattr(contribution, "FIELDS", {})
        if not isinstance(declarations, dict) or any(key not in CORE_FIELDS for key in declarations):
            raise ValueError("Invalid research field declarations")
        names = declarations.get(resource, ())
        if (not isinstance(names, (tuple, list, set, frozenset))
                or any(not isinstance(name, str) or not name.isidentifier() for name in names)):
            raise ValueError("Invalid research field declaration")
        fields = set(names)
        if len(fields) != len(names) or fields & seen:
            raise ValueError("Conflicting research field declaration")
        seen.update(fields)
        providers.append((contribution, fields))
    return seen, providers


def project_row(resource: str, row) -> dict:
    """Hide unowned fields in responses without changing any persisted value."""
    fields, _providers = _schema(resource)
    return {key: value for key, value in dict(row).items() if key in fields}


def values(resource: str, operation: str, source: dict) -> dict:
    """Validated extra columns/values; unknown request fields remain ignored."""
    _fields, providers = _schema(resource)
    result = {}
    for contribution, fields in providers:
        normalize = getattr(contribution, "values", None)
        if normalize is None:
            continue
        extra = normalize(resource, operation, dict(source))
        if not isinstance(extra, dict) or any(key not in fields for key in extra):
            raise ValueError("Invalid research metadata contribution")
        result.update(extra)
    return result


async def on_complete(entry_id: str | None, job: dict) -> None:
    """Notify installed output consumers only; their policy gates remain local."""
    for contribution in _contributors():
        callback = getattr(contribution, "on_complete", None)
        if callback is not None:
            await callback(entry_id, job)
