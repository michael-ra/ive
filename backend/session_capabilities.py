"""Secret-safe composition dump for one IVE session.

This module answers "what state will this session actually run with?" from
the registries and attachment seams that already own that state.  It never
serializes prompts, credentials, MCP commands/arguments, or environment
values.  Environment-backed features expose only a whitelisted key name and
presence/boolean state.
"""
from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Mapping
from typing import Any

from cli_profiles import get_profile
from event_registry import hook_event_name, require_event
import extension_host
import plugin_manager


_TRUE = {"1", "true", "yes", "on", "enabled"}

# Only session/runtime composition gates belong here.  Values are deliberately
# never returned; even URL-shaped settings can contain embedded credentials.
_ENV_FEATURES: tuple[tuple[str, bool], ...] = (
    ("COMMANDER_HOOKS_ENABLED", True),
    ("IVE_USE_HOST_LOGIN", True),
    ("IVE_AGY_ISOLATED_PROFILE", False),
    ("ORCHESTRATOR_V2", False),
)

_WORKSPACE_FLAG_FIELDS = (
    "tester_mode",
    "default_worktree",
    "comms_enabled",
    "coordination_enabled",
    "context_sharing_enabled",
    "alloy_enabled",
    "output_style",
    "native_terminals_enabled",
    "auto_register_terminals",
    "auto_exec_enabled",
    "commander_max_workers",
    "tester_max_workers",
    "commander_max_epics",
    "auto_approve_blueprint",
    "pipeline_enabled",
    "task_dependencies_enabled",
    "board_doc_mode",
)

_BOOLEAN_WORKSPACE_FIELDS = {
    name for name in _WORKSPACE_FLAG_FIELDS
    if name.endswith("_enabled") or name.startswith("auto_") or name in {
        "default_worktree", "alloy_enabled", "pipeline_enabled",
        "task_dependencies_enabled",
    }
}


def _capability(
    kind: str,
    name: str,
    source_type: str,
    source_ref: str,
    detail: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "kind": str(kind),
        "name": str(name),
        "source": {"type": str(source_type), "ref": str(source_ref)},
        "detail": dict(detail or {}),
    }


def _json_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return []
    return [str(item) for item in parsed] if isinstance(parsed, list) else []


def _json_keys(value: Any) -> list[str]:
    """Return config key names only; malformed/raw values are never reflected."""
    if isinstance(value, Mapping):
        return sorted(str(key) for key in value)
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return []
    return sorted(str(key) for key in parsed) if isinstance(parsed, dict) else []


def _env_state(environ: Mapping[str, str], key: str, default: bool, *,
               presence_enables=(), mode_enables=None) -> dict[str, bool]:
    present = key in environ and bool(str(environ.get(key) or "").strip())
    if not present:
        return {"present": False, "enabled": default}
    if key in presence_enables:
        return {"present": True, "enabled": True}
    if key in (mode_enables or {}):
        return {
            "present": True,
            "enabled": str(environ.get(key) or "").strip().lower() == mode_enables[key],
        }
    return {
        "present": True,
        "enabled": str(environ.get(key) or "").strip().lower() in _TRUE,
    }


def _auth_mode(session: Mapping[str, Any], environ: Mapping[str, str]) -> str:
    if session.get("account_id"):
        return "isolated_account"
    cli = str(session.get("cli_type") or "claude").lower()
    host_login = _env_state(environ, "IVE_USE_HOST_LOGIN", True)["enabled"]
    agy_isolated = _env_state(environ, "IVE_AGY_ISOLATED_PROFILE", False)["enabled"]
    if host_login or (cli in {"gemini", "antigravity"} and not agy_isolated):
        return "host_login"
    return "managed_profile"


async def _installed_skills(workspace_path: str | None) -> list[dict[str, Any]]:
    """Filesystem discovery is small but blocking, so keep it off aiohttp's loop."""
    from skill_installer import list_installed_skills

    return await asyncio.to_thread(
        list_installed_skills,
        workspace_path=workspace_path,
        scope="all",
    )


def _declared_pairs(module, name: str) -> tuple[tuple[str, bool], ...]:
    pairs = getattr(module, name, ())
    if not isinstance(pairs, (tuple, list)):
        raise ValueError("Invalid session diagnostic declarations")
    for pair in pairs:
        if (not isinstance(pair, (tuple, list)) or len(pair) != 2
                or not isinstance(pair[0], str) or not pair[0].isidentifier()
                or type(pair[1]) is not bool):
            raise ValueError("Invalid session diagnostic declaration")
    return tuple((key, option) for key, option in pairs)


def _diagnostic_contributors():
    """Discover opt-in, trusted diagnostic contributions from selected packages.

    Convention: backend/session_capabilities.py may declare ENV_FEATURES as
    (key, default-bool) pairs and WORKSPACE_FIELDS as (key, boolean-coercion)
    pairs. Optional PRESENCE_ENABLES/MODE_ENABLES refine boolean env parsing.
    An async collect_capabilities(db, session, workspace, environ) may return
    additional records using the same kind/name/source/detail contract.

    Missing contribution files are normal. Existing resources pass through the
    extension host's path/enablement checks; declarations may not override core
    or another contributor. This is trusted in-process code, not an isolation
    boundary. Contributors must never return prompts or raw credential/config
    values; environment declarations are rendered centrally as booleans only.
    """
    contributors = []
    seen_env = {key for key, _default in _ENV_FEATURES}
    seen_fields = set(_WORKSPACE_FLAG_FIELDS) | {
        "orchestration_policy_declared", "inherits_orchestration_policy",
    }
    relative = "backend/session_capabilities.py"
    for metadata in extension_host.installed_extensions():
        extension_id = metadata["id"]
        root = extension_host.extension_path(extension_id)
        if not (root / relative).is_file():
            continue
        module = extension_host.load_backend_module(extension_id, relative)
        features = _declared_pairs(module, "ENV_FEATURES")
        fields = _declared_pairs(module, "WORKSPACE_FIELDS")
        for pairs, seen in ((features, seen_env), (fields, seen_fields)):
            for key, _option in pairs:
                if key in seen:
                    raise ValueError("Conflicting session diagnostic declaration")
                seen.add(key)
        feature_names = {key for key, _default in features}
        presence = getattr(module, "PRESENCE_ENABLES", ())
        modes = getattr(module, "MODE_ENABLES", {})
        if (not isinstance(presence, (tuple, list, set, frozenset))
                or any(not isinstance(key, str) for key in presence)
                or not set(presence).issubset(feature_names)
                or not isinstance(modes, Mapping)
                or not set(modes).issubset(feature_names)
                or any(not isinstance(value, str) for value in modes.values())):
            raise ValueError("Invalid session diagnostic environment modes")
        contributors.append((module, features, fields, presence, modes))
    return contributors


async def collect_session_capabilities(
    db,
    session: Mapping[str, Any],
    *,
    environ: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Build the structured, provenance-bearing reality for ``session``.

    ``db`` is caller-owned so the route can perform one consistent, read-only
    view.  No writes, subprocesses, network calls, or secret decryption occur.
    """
    env = os.environ if environ is None else environ
    contributors = _diagnostic_contributors()
    session_id = str(session["id"])
    workspace_id = str(session.get("workspace_id") or "")

    cur = await db.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,))
    workspace_row = await cur.fetchone()
    workspace = dict(workspace_row) if workspace_row else {}

    account: dict[str, Any] | None = None
    if session.get("account_id"):
        cur = await db.execute(
            """SELECT id, name, type, api_key_provider, status,
                      CASE WHEN COALESCE(api_key, '') != '' THEN 1 ELSE 0 END
                          AS credential_configured,
                      CASE WHEN COALESCE(base_url, '') != '' THEN 1 ELSE 0 END
                          AS base_url_configured
               FROM accounts WHERE id = ?""",
            (session["account_id"],),
        )
        account_row = await cur.fetchone()
        account = dict(account_row) if account_row else None

    capabilities: list[dict[str, Any]] = []

    # Session-local declaration (safe subset only — prompts and free-form
    # config are intentionally excluded).
    capabilities.append(_capability(
        "session",
        str(session.get("session_type") or "worker"),
        "session",
        session_id,
        {
            "status": session.get("status") or "idle",
            "model": session.get("model") or "",
            "effort": session.get("effort") or "",
            "worktree": bool(session.get("worktree")),
            "imported": bool(session.get("is_imported")),
        },
    ))

    cli_id = str(session.get("cli_type") or "claude").lower()
    profile = get_profile(cli_id)
    capabilities.append(_capability(
        "cli",
        profile.id,
        "cli_profile",
        f"cli_profiles.py:{profile.id}",
        {
            "label": profile.label,
            "binary": profile.binary,
            "profile_active": bool(profile.active and not profile.deprecated),
            "mcp_strategy": profile.mcp_strategy,
            "model": session.get("model") or profile.default_model,
            "permission_mode": session.get("permission_mode") or profile.default_permission_mode,
            "supported_features": sorted(feature.value for feature in profile.features if profile.supports(feature)),
        },
    ))


    if account:
        capabilities.append(_capability(
            "auth",
            str(account.get("name") or account.get("type") or "account"),
            "account",
            str(account["id"]),
            {
                "mode": _auth_mode(session, env),
                "type": account.get("type") or "unknown",
                "provider": account.get("api_key_provider") or "",
                "status": account.get("status") or "unknown",
                "credential_configured": bool(account.get("credential_configured")),
                "base_url_configured": bool(account.get("base_url_configured")),
            },
        ))
    else:
        capabilities.append(_capability(
            "auth",
            _auth_mode(session, env),
            "environment",
            "IVE_USE_HOST_LOGIN",
            {
                "mode": _auth_mode(session, env),
                "account_attached": False,
                **_env_state(env, "IVE_USE_HOST_LOGIN", True),
            },
        ))

    workspace_flags: dict[str, Any] = {}
    fields = [(key, key in _BOOLEAN_WORKSPACE_FIELDS) for key in _WORKSPACE_FLAG_FIELDS]
    for _module, _features, extra_fields, _presence, _modes in contributors:
        fields.extend(extra_fields)
    for key, as_boolean in fields:
        if key not in workspace or workspace.get(key) is None:
            continue
        value = workspace[key]
        workspace_flags[key] = bool(value) if as_boolean else value
    workspace_flags["orchestration_policy_declared"] = bool(
        str(workspace.get("orchestration_policy") or "").strip() not in {"", "{}"}
    )
    workspace_flags["inherits_orchestration_policy"] = bool(
        workspace.get("inherit_orchestration_policy_from")
    )
    capabilities.append(_capability(
        "workspace",
        str(workspace.get("name") or workspace_id or "unknown"),
        "workspace",
        workspace_id,
        {
            "path": workspace.get("path") or "",
            "flags": workspace_flags,
        },
    ))

    capabilities.append(_capability(
        "oversight",
        str(workspace.get("human_oversight") or "approve_plans"),
        "workspace_setting",
        f"{workspace_id}:human_oversight",
        {"mode": workspace.get("human_oversight") or "approve_plans"},
    ))


    secure_enabled = str(session.get("session_type") or "") == "secure"
    capabilities.append(_capability(
        "security",
        "secure-agent" if secure_enabled else "standard-session",
        "session_type",
        f"sessions:{session_id}:session_type",
        {
            "secure_mode": secure_enabled,
            "host_shell": not secure_enabled,
            "scoped_container_tool": secure_enabled,
        },
    ))

    capabilities.append(_capability(
        "tool_policy",
        str(session.get("permission_mode") or profile.default_permission_mode),
        "session_config",
        f"sessions:{session_id}:permission_mode",
        {
            "allowed_tools": _json_list(session.get("allowed_tools")),
            "disallowed_tools": _json_list(session.get("disallowed_tools")),
            "auto_approve_mcp": bool(session.get("auto_approve_mcp")),
        },
    ))

    # Attached MCP server configs: only identity, transport, approval state,
    # and ENV KEY NAMES. Commands, arguments, URLs, headers, and values never
    # cross this boundary.
    active_mcp_ids = set(_json_list(session.get("active_mcp_server_ids")))
    cur = await db.execute(
        """SELECT ms.id, ms.name, ms.server_name, ms.server_type, ms.env,
                  ms.auto_approve, ms.is_builtin, sms.auto_approve_override
           FROM mcp_servers ms
           JOIN session_mcp_servers sms ON sms.mcp_server_id = ms.id
           WHERE sms.session_id = ?
           ORDER BY ms.server_name""",
        (session_id,),
    )
    mcp_servers = [dict(row) for row in await cur.fetchall()]
    for server in mcp_servers:
        server_id = str(server["id"])
        override = server.get("auto_approve_override")
        effective_auto_approve = bool(
            server.get("auto_approve") if override is None else override
        )
        capabilities.append(_capability(
            "mcp_server",
            str(server.get("server_name") or server.get("name") or server_id),
            "session_mcp_attachment",
            server_id,
            {
                "label": server.get("name") or "",
                "transport": server.get("server_type") or "stdio",
                "builtin": bool(server.get("is_builtin")),
                "declared": True,
                "active": server_id in active_mcp_ids,
                "auto_approve": effective_auto_approve,
                "env_keys": _json_keys(server.get("env")),
            },
        ))

        if server_id == "builtin-worker-board":
            from worker_mcp_server import compose_tool_registry

            tools, sources = compose_tool_registry(
                str(session.get("session_type") or "worker"),
                {
                    "comms": bool(workspace.get("comms_enabled")),
                    "context": bool(workspace.get("context_sharing_enabled")),
                    "coordination": bool(workspace.get("coordination_enabled")),
                },
                alloy_enabled=bool(workspace.get("alloy_enabled")),
            )
            for tool_name in sorted(tools):
                group = sources.get(tool_name, "core")
                capabilities.append(_capability(
                    "mcp_tool",
                    tool_name,
                    "worker_mcp_registry",
                    f"worker_mcp_server.py:{group}",
                    {
                        "server": "worker-board",
                        "registration_group": group,
                        "active": server_id in active_mcp_ids,
                    },
                ))


    cur = await db.execute(
        """SELECT g.id, g.name
           FROM guidelines g
           JOIN session_guidelines sg ON sg.guideline_id = g.id
           WHERE sg.session_id = ?
           ORDER BY g.name""",
        (session_id,),
    )
    guidelines = [dict(row) for row in await cur.fetchall()]
    active_guidelines = set(_json_list(session.get("active_guideline_ids")))
    # Attachment alone does not change a running CLI's prompt. Only the
    # startup snapshot is evidence that a guideline is already active.
    for guideline in guidelines:
        capabilities.append(_capability(
            "guideline",
            str(guideline["name"]),
            "session_guideline_attachment",
            str(guideline["id"]),
            {"active": str(guideline["id"]) in active_guidelines},
        ))

    plugin_components = await plugin_manager.get_session_components_from_db(db, session_id)
    plugins_seen: set[str] = set()
    for component in plugin_components:
        plugin_id = str(component.get("plugin_id") or "")
        if plugin_id and plugin_id not in plugins_seen:
            plugins_seen.add(plugin_id)
            capabilities.append(_capability(
                "plugin",
                str(component.get("plugin_name") or plugin_id),
                "plugin_manager",
                plugin_id,
                {"attached": True},
            ))
        component_type = str(component.get("type") or "component")
        activation = str(component.get("activation") or "always")
        if component_type == "guideline" and activation == "on_demand":
            kind = "skill"
        elif component_type == "guideline":
            kind = "guideline"
        else:
            kind = "plugin_component"
        capabilities.append(_capability(
            kind,
            str(component.get("name") or component.get("id") or "component"),
            "plugin_manager",
            str(component.get("id") or plugin_id),
            {
                "plugin": component.get("plugin_name") or plugin_id,
                "component_type": component_type,
                "activation": activation,
                "trigger": component.get("trigger") or "",
                "permissions": list(component.get("permissions") or []),
                "risk_level": component.get("risk_level") or "",
            },
        ))

    try:
        installed_skills = await _installed_skills(workspace.get("path"))
    except (OSError, ValueError):
        installed_skills = []
    for skill in installed_skills:
        installed_for = [str(item) for item in skill.get("installed_for") or []]
        if profile.id not in installed_for:
            continue
        capabilities.append(_capability(
            "skill",
            str(skill.get("name") or skill.get("slug") or "skill"),
            "skill_installer",
            f"{skill.get('scope') or 'unknown'}:{skill.get('slug') or ''}",
            {
                "scope": skill.get("scope") or "unknown",
                "cli": profile.id,
                "has_scripts": bool(skill.get("has_scripts")),
                "has_references": bool(skill.get("has_references")),
            },
        ))

    feature_groups = [(_ENV_FEATURES, (), {})]
    for module, features, _fields, presence, modes in contributors:
        feature_groups.append((features, presence, modes))
        collector = getattr(module, "collect_capabilities", None)
        if collector is not None:
            if not callable(collector):
                raise ValueError("Invalid session diagnostic collector")
            records = await collector(db, session, workspace, env)
            if not isinstance(records, list):
                raise ValueError("Invalid session diagnostic records")
            for record in records:
                if (not isinstance(record, Mapping)
                        or set(record) != {"kind", "name", "source", "detail"}
                        or not isinstance(record["kind"], str) or not isinstance(record["name"], str)
                        or not isinstance(record["source"], Mapping)
                        or set(record["source"]) != {"type", "ref"}
                        or not all(isinstance(value, str) for value in record["source"].values())
                        or not isinstance(record["detail"], Mapping)):
                    raise ValueError("Invalid session diagnostic record")
            capabilities.extend(records)

    for features, presence, modes in feature_groups:
        for key, default in features:
            capabilities.append(_capability(
                "feature_flag",
                key,
                "environment",
                key,
                _env_state(env, key, default, presence_enables=presence, mode_enables=modes),
            ))

    # A CLI profile declares precisely which normalized hook contracts this
    # session can subscribe to.  Enrich those declarations from the typed event
    # registry instead of maintaining a second event description table.
    for hook_event, native_name in sorted(
        profile.hook_event_map.items(), key=lambda item: item[0].value
    ):
        registry_name = hook_event_name(hook_event)
        spec = require_event(registry_name)
        capabilities.append(_capability(
            "event_subscription",
            registry_name,
            "event_registry",
            registry_name,
            {
                "native_event": native_name,
                "dispatch_mode": spec.dispatch_mode.value,
                "durability": spec.durability.value,
            },
        ))

    return sorted(
        capabilities,
        key=lambda capability: (
            capability["kind"], capability["name"].lower(),
            capability["source"]["ref"],
        ),
    )
