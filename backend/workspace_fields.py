"""IVE workspace fields plus explicitly selected product-owned additions.

This is a response/write boundary, not a storage migration or policy-input
filter. Internal execution code must continue to read complete stored rows so
requested isolation and other core permission decisions are not weakened.
"""
from __future__ import annotations

import extension_host


CORE_FIELDS = frozenset({
    "id", "name", "path", "color", "human_oversight", "tester_mode", "auto_test_enabled",
    "research_model", "research_llm_url", "review_provider", "preview_url", "default_worktree",
    "comms_enabled", "coordination_enabled", "context_sharing_enabled", "alloy_enabled", "output_style",
    "orchestration_policy", "inherit_orchestration_policy_from", "order_index", "created_at", "last_used_at",
    "sandbox_type", "sandbox_network", "native_terminals_enabled", "auto_register_terminals",
    "auto_exec_enabled", "commander_max_workers", "tester_max_workers", "commander_max_epics",
    "auto_approve_blueprint", "advisor_auto_attach", "research_max_iterations", "pipeline_enabled",
    "task_dependencies_enabled", "demo_command", "demo_branch", "demo_port",
    "board_doc_mode", "board_doc_new_column", "board_doc_existing_column",
})

CORE_UPDATE_FIELDS = (
    "name", "human_oversight", "research_model", "review_provider", "color", "preview_url", "default_worktree",
    "comms_enabled", "coordination_enabled", "context_sharing_enabled", "output_style",
    "native_terminals_enabled", "auto_register_terminals", "auto_exec_enabled", "commander_max_workers",
    "tester_max_workers", "commander_max_epics", "auto_approve_blueprint", "auto_test_enabled",
    "research_max_iterations", "pipeline_enabled", "task_dependencies_enabled", "alloy_enabled",
    "board_doc_mode", "board_doc_new_column", "board_doc_existing_column", "sandbox_type", "sandbox_network",
    "orchestration_policy", "inherit_orchestration_policy_from",
)


def _contributors():
    """Trusted backend/workspace_fields.py convention; missing file is normal.

    READ_FIELDS declares existing owned columns. UPDATE_FIELDS is its writable
    subset, CREATE_VALUES supplies previous product defaults on registration,
    and MODEL_FIELDS is the ordered update subset using IVE model validation.
    Contributions do not grant any new permissions or run product services.
    """
    for metadata in extension_host.installed_extensions():
        owner = metadata["id"]
        root = extension_host.extension_path(owner)
        relative = "backend/workspace_fields.py"
        if (root / relative).is_file():
            yield extension_host.load_backend_module(owner, relative)


def _names(value, label: str) -> tuple[str, ...]:
    if (not isinstance(value, (tuple, list))
            or any(not isinstance(name, str) or not name.isidentifier() for name in value)
            or len(set(value)) != len(value)):
        raise ValueError(f"Invalid workspace {label} declaration")
    return tuple(value)


def _schema():
    read_fields = set(CORE_FIELDS)
    update_fields = list(CORE_UPDATE_FIELDS)
    create_values = {}
    model_fields = []
    for contribution in _contributors():
        owned = _names(getattr(contribution, "READ_FIELDS", ()), "read fields")
        writable = _names(getattr(contribution, "UPDATE_FIELDS", ()), "update fields")
        models = _names(getattr(contribution, "MODEL_FIELDS", ()), "model fields")
        defaults = getattr(contribution, "CREATE_VALUES", {})
        if set(owned) & read_fields:
            raise ValueError("Conflicting workspace field declaration")
        if (not set(writable) <= set(owned) or not set(models) <= set(writable)
                or not isinstance(defaults, dict) or not set(defaults) <= set(owned)):
            raise ValueError("Undeclared workspace field contribution")
        read_fields.update(owned)
        update_fields.extend(writable)
        create_values.update(defaults)
        model_fields.extend(models)
    # Existing product model validation ran before ordinary research validation.
    model_fields.append("research_model")
    return read_fields, update_fields, create_values, tuple(model_fields)


def project_row(row) -> dict:
    """Return core and enabled-owner fields without modifying stored columns."""
    fields, _updates, _defaults, _models = _schema()
    return {key: value for key, value in dict(row).items() if key in fields}


def update_values(source: dict) -> dict:
    """Retain legacy raw-value writes and ignore unsupported request keys."""
    _fields, updates, _defaults, _models = _schema()
    return {key: source[key] for key in updates if key in source}


def create_values() -> dict:
    """Only installed owners initialize their options; no disabled-owner writes."""
    _fields, _updates, defaults, _models = _schema()
    return dict(defaults)


def model_fields() -> tuple[str, ...]:
    """Validation is selected with ownership, before any database mutation."""
    _fields, _updates, _defaults, models = _schema()
    return models
