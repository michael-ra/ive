"""Strict data adapter and persistence for operator-defined CLI profiles."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path, PurePath
from typing import Any
from urllib.parse import urlparse

from cli_features import Feature, HookEvent
from cli_profiles import CLIProfile, FeatureBinding, PROFILES


CLI_PROFILES_SETTING = "cli_profiles"
DECLARATIVE_PROFILE_FIELDS = frozenset({
    "id",
    "label",
    "binary",
    "binary_candidates",
    "oneshot_args",
    "prompt_mode",
    "model_flag",
    "config_dir_env",
    "config_dir_subpath",
    "account_isolation",
    "credential_files",
    "credential_identity_paths",
    "auth_login_url",
    "auth_command",
    "auth_completion_patterns",
    "auth_allowed_hosts",
    "auth_provider",
    "feature_argv",
    "feature_paths",
    "tool_semantics",
    "permission_mode_rank",
    "hook_event_map",
    "default_hook_events",
    "hook_config_format",
    "hook_manifest_dialect",
    "hook_decision_protocol",
    "hook_entry_shape",
    "home_dir",
    "settings_file",
    "hook_settings_file",
    "mcp_config_file",
    "plugin_cache_dir",
    "auth_dir_name",
    "default_model",
    "available_models",
    "session_file_pattern",
    "mcp_strategy",
    "mcp_add_argv",
    "mcp_remove_argv",
    "mcp_env_argv",
    "mcp_auto_approve_argv",
    "mcp_config_adapter",
    "managed_context_adapter",
    "plugin_format",
})
BUILTIN_PROFILE_IDS = frozenset({
    profile_id
    for profile_id, profile in PROFILES.items()
    if profile.adapter_kind == "builtin"
})
_PROFILE_ID_RE = re.compile(r"[a-z][a-z0-9_-]{0,62}")
_ENV_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_MCP_STRATEGIES = frozenset({"config_file", "mcp_add", "global_config_file"})
_OPERATIONS = frozenset({"read", "mutate", "execute", "delegate"})
_HOOK_MANIFEST_DIALECTS = frozenset({"", "json_groups", "toml_groups"})
_HOOK_DECISION_PROTOCOLS = frozenset({"", "claude_json", "exit_code"})
_PLUGIN_FORMATS = frozenset({"", "claude", "gemini"})
_FEATURE_TEMPLATE_FIELDS = frozenset({"value", "item"})
_TEMPLATE_FIELD_RE = re.compile(r"[{]([A-Za-z_][A-Za-z0-9_]*)[}]")
_HOST_RE = re.compile(r"[A-Za-z0-9.-]+")


class DeclarativeCLIProfileError(ValueError):
    """A user profile failed its single persisted data contract."""

    def __init__(self, message: str, *, code: str = "invalid_cli_profile") -> None:
        super().__init__(message)
        self.code = code


def _require_string(value: Any, field: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise DeclarativeCLIProfileError(f"CLI profile field '{field}' must be a string")
    clean = value.strip()
    if not clean and not allow_empty:
        raise DeclarativeCLIProfileError(f"CLI profile field '{field}' cannot be empty")
    return clean


def _string_list(value: Any, field: str, *, allow_empty: bool = True) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise DeclarativeCLIProfileError(
            f"CLI profile field '{field}' must be a JSON list of strings"
        )
    clean = [item.strip() for item in value]
    if any(not item for item in clean):
        raise DeclarativeCLIProfileError(f"CLI profile field '{field}' contains an empty value")
    if len(clean) != len(set(clean)):
        raise DeclarativeCLIProfileError(f"CLI profile field '{field}' contains duplicates")
    if not clean and not allow_empty:
        raise DeclarativeCLIProfileError(f"CLI profile field '{field}' cannot be empty")
    return clean


def _relative_path_list(value: Any, field: str) -> list[str]:
    paths = _string_list(value, field)
    for item in paths:
        path = PurePath(item)
        if path.is_absolute() or ".." in path.parts:
            raise DeclarativeCLIProfileError(
                f"CLI profile field '{field}' must contain account-relative paths"
            )
    return paths


def _template_list(value: Any, field: str, *, placeholders: set[str]) -> list[str]:
    template = _string_list(value, field)
    for token in template:
        unknown = set(_TEMPLATE_FIELD_RE.findall(token)) - placeholders
        if unknown:
            raise DeclarativeCLIProfileError(
                f"CLI profile field '{field}' contains unsupported placeholders: "
                + ", ".join(sorted(unknown))
            )
    return template


def _normalize_feature_bindings(
    argv_value: Any,
    path_value: Any,
) -> tuple[dict[str, list[str]], dict[str, str]]:
    if not isinstance(argv_value, dict):
        raise DeclarativeCLIProfileError("feature_argv must be a JSON object")
    if not isinstance(path_value, dict):
        raise DeclarativeCLIProfileError("feature_paths must be a JSON object")
    feature_values = {feature.value for feature in Feature}
    feature_argv: dict[str, list[str]] = {}
    for name, raw_template in argv_value.items():
        if name not in feature_values:
            raise DeclarativeCLIProfileError(f"feature_argv contains unknown feature '{name}'")
        if name == Feature.MODEL.value:
            raise DeclarativeCLIProfileError("feature_argv.model competes with model_flag")
        template = _template_list(
            raw_template,
            f"feature_argv.{name}",
            placeholders=set(_FEATURE_TEMPLATE_FIELDS),
        )
        if not template:
            raise DeclarativeCLIProfileError(f"feature_argv.{name} cannot be empty")
        if any("{item}" in token for token in template) and any(
            "{value}" in token for token in template
        ):
            raise DeclarativeCLIProfileError(
                f"feature_argv.{name} cannot mix value and item placeholders"
            )
        feature_argv[name] = template

    feature_paths: dict[str, str] = {}
    for name, raw_path in path_value.items():
        if name not in feature_values:
            raise DeclarativeCLIProfileError(f"feature_paths contains unknown feature '{name}'")
        path = _require_string(raw_path, f"feature_paths.{name}")
        feature_paths[name] = path
    if set(feature_argv) & set(feature_paths):
        overlap = sorted(set(feature_argv) & set(feature_paths))
        raise DeclarativeCLIProfileError(
            "features cannot declare both argv and path bindings: " + ", ".join(overlap)
        )
    return feature_argv, feature_paths


def _feature_template_builder(template: tuple[str, ...], feature_name: str):
    def build(value: Any) -> list[str] | None:
        if value is None or value is False or value == "":
            return None
        if any("{item}" in token for token in template):
            values = value
            if isinstance(values, str):
                try:
                    values = json.loads(values)
                except json.JSONDecodeError as exc:
                    raise ValueError(f"{feature_name} requires a list") from exc
            if not isinstance(values, list):
                raise ValueError(f"{feature_name} requires a list")
            return [
                token.replace("{item}", str(item))
                for item in values
                for token in template
            ] or None
        return [token.replace("{value}", str(value)) for token in template]

    return build


def _normalize_tool_semantics(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict):
        raise DeclarativeCLIProfileError("tool_semantics must be a JSON object")
    normalized: dict[str, dict[str, Any]] = {}
    seen: set[str] = set()
    for raw_name, raw_semantic in value.items():
        name = _require_string(raw_name, "tool_semantics tool name")
        folded = name.lower()
        if folded in seen:
            raise DeclarativeCLIProfileError(f"tool_semantics duplicates '{name}'")
        seen.add(folded)
        if not isinstance(raw_semantic, dict) or set(raw_semantic) != {"operation", "target_keys"}:
            raise DeclarativeCLIProfileError(
                f"tool_semantics.{name} must contain exactly operation and target_keys"
            )
        operation = _require_string(
            raw_semantic["operation"], f"tool_semantics.{name}.operation"
        ).lower()
        if operation not in _OPERATIONS:
            raise DeclarativeCLIProfileError(
                f"tool_semantics.{name}.operation is not canonical"
            )
        target_keys = _string_list(
            raw_semantic["target_keys"], f"tool_semantics.{name}.target_keys"
        )
        if operation in {"mutate", "execute"} and not target_keys:
            raise DeclarativeCLIProfileError(
                f"tool_semantics.{name} must declare target keys for {operation}"
            )
        normalized[name] = {"operation": operation, "target_keys": target_keys}
    return normalized


def _normalize_string_map(value: Any, field: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise DeclarativeCLIProfileError(f"{field} must be a JSON object")
    return {
        _require_string(key, f"{field} key"): _require_string(item, f"{field}.{key}")
        for key, item in value.items()
    }


def _resolved_profile_path(value: str, field: str) -> Path:
    if not value.startswith("~/") and not Path(value).is_absolute():
        raise DeclarativeCLIProfileError(
            f"CLI profile field '{field}' must be absolute or start with '~/': {value}"
        )
    return Path(os.path.expanduser(value)).resolve(strict=False)


def _validate_declared_paths(data: dict[str, Any]) -> None:
    home = _resolved_profile_path(data["home_dir"], "home_dir")
    for field in (
        "settings_file", "hook_settings_file", "mcp_config_file", "plugin_cache_dir"
    ):
        value = data[field]
        if not value:
            continue
        candidate = _resolved_profile_path(value, field)
        try:
            candidate.relative_to(home)
        except ValueError as exc:
            raise DeclarativeCLIProfileError(
                f"CLI profile field '{field}' resolves outside declared home_dir"
            ) from exc


def _normalize_models(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list) or not value:
        raise DeclarativeCLIProfileError(
            "CLI profile field 'available_models' must be a non-empty JSON list"
        )
    models: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        if not isinstance(item, dict) or not {"id", "label"}.issubset(item):
            raise DeclarativeCLIProfileError(
                f"available_models[{index}] must contain string id and label fields"
            )
        if set(item) - {"id", "label", "description"}:
            raise DeclarativeCLIProfileError(
                f"available_models[{index}] only accepts id, label, and description"
            )
        model_id = _require_string(item["id"], f"available_models[{index}].id")
        label = _require_string(item["label"], f"available_models[{index}].label")
        description = _require_string(
            item.get("description", ""),
            f"available_models[{index}].description",
            allow_empty=True,
        )
        if model_id in seen:
            raise DeclarativeCLIProfileError(f"model '{model_id}' is duplicated")
        seen.add(model_id)
        models.append({"id": model_id, "label": label, "description": description})
    return models


def _declarative_one_shot_builder(
    args: tuple[str, ...], prompt_mode: str, profile_id: str
):
    def build(
        binary: str, full_prompt: str, model_args: list[str], use_stdin: bool
    ) -> list[str]:
        command = [binary, *args, *model_args]
        if prompt_mode == "stdin":
            return command
        if use_stdin:
            raise ValueError(
                f"CLI profile '{profile_id}' only accepts prompt_mode 'arg'; "
                "the prompt is too large for argv"
            )
        return [*command, full_prompt]

    return build


def declarative_profile_from_data(raw: object) -> CLIProfile:
    """Validate the one persisted shape and generate its runtime bindings."""
    if not isinstance(raw, dict) or set(raw) != DECLARATIVE_PROFILE_FIELDS:
        missing = sorted(DECLARATIVE_PROFILE_FIELDS - set(raw) if isinstance(raw, dict) else DECLARATIVE_PROFILE_FIELDS)
        extra = sorted(set(raw) - DECLARATIVE_PROFILE_FIELDS) if isinstance(raw, dict) else []
        detail = f"missing={missing}, extra={extra}"
        raise DeclarativeCLIProfileError(f"CLI profile must contain exactly the declared fields: {detail}")

    data = dict(raw)
    profile_id = _require_string(data["id"], "id").lower()
    if not _PROFILE_ID_RE.fullmatch(profile_id):
        raise DeclarativeCLIProfileError(f"CLI profile id '{profile_id}' is invalid")
    if profile_id in BUILTIN_PROFILE_IDS:
        raise DeclarativeCLIProfileError(
            f"CLI profile id '{profile_id}' is reserved for a built-in profile",
            code="reserved_cli_profile",
        )

    label = _require_string(data["label"], "label")
    binary = _require_string(data["binary"], "binary")
    binary_candidates = _string_list(data["binary_candidates"], "binary_candidates")
    if binary in binary_candidates:
        raise DeclarativeCLIProfileError("binary_candidates must not repeat binary")
    oneshot_args = _string_list(data["oneshot_args"], "oneshot_args")
    prompt_mode = _require_string(data["prompt_mode"], "prompt_mode")
    if prompt_mode not in {"stdin", "arg"}:
        raise DeclarativeCLIProfileError("prompt_mode must be 'stdin' or 'arg'")
    model_flag = _require_string(data["model_flag"], "model_flag", allow_empty=True)

    config_dir_env = _require_string(
        data["config_dir_env"], "config_dir_env", allow_empty=True
    )
    config_dir_subpath = _require_string(
        data["config_dir_subpath"], "config_dir_subpath", allow_empty=True
    )
    if bool(config_dir_env) != bool(config_dir_subpath):
        raise DeclarativeCLIProfileError(
            "config_dir_env and config_dir_subpath must either both be set or both be empty"
        )
    if config_dir_env and not _ENV_NAME_RE.fullmatch(config_dir_env):
        raise DeclarativeCLIProfileError("config_dir_env is not a valid environment variable")
    if config_dir_subpath:
        config_path = PurePath(config_dir_subpath)
        if config_path.is_absolute() or ".." in config_path.parts:
            raise DeclarativeCLIProfileError(
                "config_dir_subpath must stay below the account HOME"
            )

    account_isolation = _require_string(
        data["account_isolation"], "account_isolation", allow_empty=True
    )
    if account_isolation not in {"", "config_dir", "home_only"}:
        raise DeclarativeCLIProfileError(
            "account_isolation must be config_dir, home_only, or empty for unsupported"
        )
    if config_dir_env and account_isolation != "config_dir":
        raise DeclarativeCLIProfileError(
            "declared config_dir_env requires account_isolation=config_dir"
        )
    if account_isolation == "config_dir" and not config_dir_env:
        raise DeclarativeCLIProfileError(
            "account_isolation=config_dir requires config_dir_env and config_dir_subpath"
        )
    if account_isolation == "home_only" and config_dir_env:
        raise DeclarativeCLIProfileError(
            "account_isolation=home_only cannot declare a config redirect"
        )

    credential_files = _relative_path_list(data["credential_files"], "credential_files")
    credential_identity_paths = _string_list(
        data["credential_identity_paths"], "credential_identity_paths"
    )
    if bool(credential_files) != bool(credential_identity_paths):
        raise DeclarativeCLIProfileError(
            "credential_files and credential_identity_paths must be declared together"
        )

    auth_login_url = _require_string(
        data["auth_login_url"], "auth_login_url", allow_empty=True
    )
    auth_command = _template_list(
        data["auth_command"], "auth_command", placeholders={"binary"}
    )
    auth_completion_patterns = _string_list(
        data["auth_completion_patterns"], "auth_completion_patterns"
    )
    for pattern in auth_completion_patterns:
        try:
            re.compile(pattern)
        except re.error as exc:
            raise DeclarativeCLIProfileError(
                f"auth_completion_patterns contains invalid regex: {exc}"
            ) from exc
    auth_allowed_hosts = _string_list(data["auth_allowed_hosts"], "auth_allowed_hosts")
    if any(not _HOST_RE.fullmatch(host) for host in auth_allowed_hosts):
        raise DeclarativeCLIProfileError("auth_allowed_hosts contains an invalid hostname")
    auth_provider = _require_string(data["auth_provider"], "auth_provider", allow_empty=True)
    auth_parts = (
        bool(auth_login_url), bool(auth_command), bool(auth_completion_patterns),
        bool(auth_allowed_hosts), bool(auth_provider),
    )
    if any(auth_parts) and not all(auth_parts):
        raise DeclarativeCLIProfileError(
            "auth metadata must declare URL, command, completion patterns, hosts, and provider together"
        )
    if auth_login_url:
        parsed_login = urlparse(auth_login_url)
        if parsed_login.scheme != "https" or not parsed_login.hostname:
            raise DeclarativeCLIProfileError("auth_login_url must be an absolute HTTPS URL")
        if not credential_files or not account_isolation:
            raise DeclarativeCLIProfileError(
                "auth-capable profiles require credential evidence and explicit account isolation"
            )

    feature_argv, feature_paths = _normalize_feature_bindings(
        data["feature_argv"], data["feature_paths"]
    )
    tool_semantics = _normalize_tool_semantics(data["tool_semantics"])
    permission_mode_rank = _string_list(
        data["permission_mode_rank"], "permission_mode_rank"
    )

    event_map_raw = data["hook_event_map"]
    if not isinstance(event_map_raw, dict):
        raise DeclarativeCLIProfileError("hook_event_map must be a JSON object")
    hook_event_map: dict[HookEvent, str] = {}
    for canonical, native in event_map_raw.items():
        try:
            event = HookEvent(canonical)
        except (TypeError, ValueError) as exc:
            raise DeclarativeCLIProfileError(
                f"hook_event_map contains unknown canonical event '{canonical}'"
            ) from exc
        hook_event_map[event] = _require_string(native, f"hook_event_map.{canonical}")
    default_hook_events = _string_list(data["default_hook_events"], "default_hook_events")
    unknown_native_events = sorted(set(default_hook_events) - set(hook_event_map.values()))
    if unknown_native_events:
        raise DeclarativeCLIProfileError(
            "default_hook_events are missing from hook_event_map: "
            + ", ".join(unknown_native_events)
        )
    hook_config_format = _require_string(data["hook_config_format"], "hook_config_format")
    if hook_config_format not in {"json", "toml"}:
        raise DeclarativeCLIProfileError("hook_config_format must be 'json' or 'toml'")
    hook_manifest_dialect = _require_string(
        data["hook_manifest_dialect"], "hook_manifest_dialect", allow_empty=True
    )
    if hook_manifest_dialect not in _HOOK_MANIFEST_DIALECTS:
        raise DeclarativeCLIProfileError("unsupported hook_manifest_dialect")
    hook_decision_protocol = _require_string(
        data["hook_decision_protocol"], "hook_decision_protocol", allow_empty=True
    )
    if hook_decision_protocol not in _HOOK_DECISION_PROTOCOLS:
        raise DeclarativeCLIProfileError("unsupported hook_decision_protocol")
    hook_entry_shape = _normalize_string_map(data["hook_entry_shape"], "hook_entry_shape")
    if default_hook_events:
        if not hook_manifest_dialect or not hook_decision_protocol or not hook_entry_shape:
            raise DeclarativeCLIProfileError(
                "profiles with hook events must declare manifest dialect, decision protocol, and entry shape"
            )
        expected_format = "json" if hook_manifest_dialect == "json_groups" else "toml"
        if hook_config_format != expected_format:
            raise DeclarativeCLIProfileError(
                "hook_config_format does not match hook_manifest_dialect"
            )

    home_dir = _require_string(data["home_dir"], "home_dir")
    settings_file = _require_string(data["settings_file"], "settings_file")
    hook_settings_file = _require_string(
        data["hook_settings_file"], "hook_settings_file", allow_empty=True
    )
    mcp_config_file = _require_string(
        data["mcp_config_file"], "mcp_config_file", allow_empty=True
    )
    plugin_cache_dir = _require_string(
        data["plugin_cache_dir"], "plugin_cache_dir"
    )
    _validate_declared_paths({
        "home_dir": home_dir,
        "settings_file": settings_file,
        "hook_settings_file": hook_settings_file,
        "mcp_config_file": mcp_config_file,
        "plugin_cache_dir": plugin_cache_dir,
    })

    auth_dir_name = _require_string(data["auth_dir_name"], "auth_dir_name", allow_empty=True)
    if auth_dir_name and (Path(auth_dir_name).is_absolute() or ".." in PurePath(auth_dir_name).parts):
        raise DeclarativeCLIProfileError("auth_dir_name must stay below the account HOME")
    if bool(auth_dir_name) != bool(account_isolation):
        raise DeclarativeCLIProfileError(
            "auth_dir_name and account_isolation must either both be declared or both be empty"
        )
    default_model = _require_string(data["default_model"], "default_model")
    available_models = _normalize_models(data["available_models"])
    model_ids = [item["id"] for item in available_models]
    if default_model not in model_ids:
        raise DeclarativeCLIProfileError("default_model must name one available_models entry")
    if not model_flag and len(available_models) != 1:
        raise DeclarativeCLIProfileError(
            "a profile without model_flag must declare exactly one implicit model"
        )

    session_file_pattern = _require_string(
        data["session_file_pattern"], "session_file_pattern"
    )
    mcp_strategy = _require_string(data["mcp_strategy"], "mcp_strategy")
    if mcp_strategy not in _MCP_STRATEGIES:
        raise DeclarativeCLIProfileError(
            "mcp_strategy must be config_file, mcp_add, or global_config_file"
        )
    mcp_add_argv = _template_list(
        data["mcp_add_argv"],
        "mcp_add_argv",
        placeholders={
            "binary", "server_name", "command", "args", "transport", "env",
            "auto_approve",
        },
    )
    mcp_remove_argv = _template_list(
        data["mcp_remove_argv"],
        "mcp_remove_argv",
        placeholders={"binary", "server_name"},
    )
    mcp_env_argv = _template_list(
        data["mcp_env_argv"],
        "mcp_env_argv",
        placeholders={"key", "value"},
    )
    mcp_auto_approve_argv = _template_list(
        data["mcp_auto_approve_argv"],
        "mcp_auto_approve_argv",
        placeholders=set(),
    )
    mcp_config_adapter = _require_string(
        data["mcp_config_adapter"], "mcp_config_adapter", allow_empty=True
    )
    if mcp_config_adapter:
        raise DeclarativeCLIProfileError(
            "declarative profiles cannot name an unimplemented MCP config adapter"
        )
    if mcp_strategy == "mcp_add":
        if not mcp_add_argv or not mcp_remove_argv:
            raise DeclarativeCLIProfileError(
                "mcp_add profiles require add and remove argv templates"
            )
    elif any((mcp_add_argv, mcp_remove_argv, mcp_env_argv, mcp_auto_approve_argv)):
        raise DeclarativeCLIProfileError(
            "MCP argv templates require mcp_strategy=mcp_add"
        )
    if mcp_strategy == "global_config_file":
        raise DeclarativeCLIProfileError(
            "global_config_file requires a verified code adapter"
        )

    managed_context_adapter = _require_string(
        data["managed_context_adapter"],
        "managed_context_adapter",
        allow_empty=True,
    )
    if managed_context_adapter:
        raise DeclarativeCLIProfileError(
            "declarative profiles cannot name an unimplemented managed-context adapter"
        )

    plugin_format = _require_string(
        data["plugin_format"], "plugin_format", allow_empty=True
    )
    if plugin_format not in _PLUGIN_FORMATS:
        raise DeclarativeCLIProfileError("unsupported plugin_format")

    features: dict[Feature, FeatureBinding] = {}
    if model_flag:
        features[Feature.MODEL] = FeatureBinding(
            flag=model_flag,
            build=lambda value, flag=model_flag: [flag, str(value)] if value else None,
        )
    for feature_name, template in feature_argv.items():
        feature = Feature(feature_name)
        features[feature] = FeatureBinding(
            flag=template[0] if template else None,
            build=_feature_template_builder(tuple(template), feature_name),
        )
    for feature_name, file_path in feature_paths.items():
        features[Feature(feature_name)] = FeatureBinding(file_path=file_path)
    if mcp_strategy == "config_file" and Feature.MCP_CONFIG_PATH not in features:
        raise DeclarativeCLIProfileError(
            "config_file MCP strategy requires a feature_argv.mcp_config_path binding"
        )

    return CLIProfile(
        id=profile_id,
        label=label,
        binary=binary,
        binary_candidates=binary_candidates,
        adapter_kind="declarative",
        oneshot_args=oneshot_args,
        prompt_mode=prompt_mode,
        model_flag=model_flag,
        config_dir_env=config_dir_env,
        config_dir_subpath=config_dir_subpath,
        account_isolation=account_isolation,
        credential_files=credential_files,
        credential_identity_paths=credential_identity_paths,
        auth_login_url=auth_login_url,
        auth_command=auth_command,
        auth_completion_patterns=auth_completion_patterns,
        auth_allowed_hosts=auth_allowed_hosts,
        auth_provider=auth_provider,
        oneshot_build=_declarative_one_shot_builder(
            tuple(oneshot_args), prompt_mode, profile_id
        ),
        features=features,
        feature_argv=feature_argv,
        feature_paths=feature_paths,
        tool_semantics=tool_semantics,
        permission_mode_rank=permission_mode_rank,
        hook_event_map=hook_event_map,
        home_dir=home_dir,
        settings_file=settings_file,
        hook_settings_file=hook_settings_file,
        mcp_config_file=mcp_config_file,
        plugin_cache_dir=plugin_cache_dir,
        auth_dir_name=auth_dir_name,
        default_model=default_model,
        available_models=available_models,
        default_hook_events=default_hook_events,
        hook_config_format=hook_config_format,
        hook_manifest_dialect=hook_manifest_dialect,
        hook_decision_protocol=hook_decision_protocol,
        hook_entry_shape=hook_entry_shape,
        mcp_strategy=mcp_strategy,
        mcp_add_argv=mcp_add_argv,
        mcp_remove_argv=mcp_remove_argv,
        mcp_env_argv=mcp_env_argv,
        mcp_auto_approve_argv=mcp_auto_approve_argv,
        mcp_config_adapter=mcp_config_adapter,
        managed_context_adapter=managed_context_adapter,
        plugin_format=plugin_format,
        session_file_pattern=session_file_pattern,
    )


def declarative_profile_to_data(profile: CLIProfile) -> dict[str, Any]:
    if profile.adapter_kind != "declarative":
        raise DeclarativeCLIProfileError(f"CLI profile '{profile.id}' is not declarative")
    return {
        "id": profile.id,
        "label": profile.label,
        "binary": profile.binary,
        "binary_candidates": list(profile.binary_candidates),
        "oneshot_args": list(profile.oneshot_args),
        "prompt_mode": profile.prompt_mode,
        "model_flag": profile.model_flag,
        "config_dir_env": profile.config_dir_env,
        "config_dir_subpath": profile.config_dir_subpath,
        "account_isolation": profile.account_isolation,
        "credential_files": list(profile.credential_files),
        "credential_identity_paths": list(profile.credential_identity_paths),
        "auth_login_url": profile.auth_login_url,
        "auth_command": list(profile.auth_command),
        "auth_completion_patterns": list(profile.auth_completion_patterns),
        "auth_allowed_hosts": list(profile.auth_allowed_hosts),
        "auth_provider": profile.auth_provider,
        "feature_argv": {
            name: list(template) for name, template in profile.feature_argv.items()
        },
        "feature_paths": dict(profile.feature_paths),
        "tool_semantics": {
            name: {
                "operation": semantic["operation"],
                "target_keys": list(semantic.get("target_keys") or []),
            }
            for name, semantic in profile.tool_semantics.items()
        },
        "permission_mode_rank": list(profile.permission_mode_rank),
        "hook_event_map": {
            event.value: native for event, native in profile.hook_event_map.items()
        },
        "default_hook_events": list(profile.default_hook_events),
        "hook_config_format": profile.hook_config_format,
        "hook_manifest_dialect": profile.hook_manifest_dialect,
        "hook_decision_protocol": profile.hook_decision_protocol,
        "hook_entry_shape": dict(profile.hook_entry_shape),
        "home_dir": profile.home_dir,
        "settings_file": profile.settings_file,
        "hook_settings_file": profile.hook_settings_file,
        "mcp_config_file": profile.mcp_config_file,
        "plugin_cache_dir": profile.plugin_cache_dir,
        "auth_dir_name": profile.auth_dir_name,
        "default_model": profile.default_model,
        "available_models": [dict(model) for model in profile.available_models],
        "session_file_pattern": profile.session_file_pattern,
        "mcp_strategy": profile.mcp_strategy,
        "mcp_add_argv": list(profile.mcp_add_argv),
        "mcp_remove_argv": list(profile.mcp_remove_argv),
        "mcp_env_argv": list(profile.mcp_env_argv),
        "mcp_auto_approve_argv": list(profile.mcp_auto_approve_argv),
        "mcp_config_adapter": profile.mcp_config_adapter,
        "managed_context_adapter": profile.managed_context_adapter,
        "plugin_format": profile.plugin_format,
    }


def replace_declarative_profiles(profiles: list[CLIProfile]) -> None:
    for profile_id in list(PROFILES):
        if PROFILES[profile_id].adapter_kind == "declarative":
            del PROFILES[profile_id]
    for profile in profiles:
        if profile.id in PROFILES:
            raise DeclarativeCLIProfileError(f"CLI profile '{profile.id}' is duplicated")
        PROFILES[profile.id] = profile


async def load_declarative_cli_profiles(db) -> list[CLIProfile]:
    cur = await db.execute(
        "SELECT value FROM app_settings WHERE key = ?", (CLI_PROFILES_SETTING,)
    )
    row = await cur.fetchone()
    if not row:
        replace_declarative_profiles([])
        return []
    try:
        decoded = json.loads(row["value"])
    except (TypeError, json.JSONDecodeError) as exc:
        raise DeclarativeCLIProfileError(
            "stored CLI profiles contain invalid JSON"
        ) from exc
    if not isinstance(decoded, list):
        raise DeclarativeCLIProfileError("stored CLI profiles must be a JSON list")
    profiles = [declarative_profile_from_data(item) for item in decoded]
    if len({profile.id for profile in profiles}) != len(profiles):
        raise DeclarativeCLIProfileError("stored CLI profiles contain duplicate ids")
    replace_declarative_profiles(profiles)
    return profiles


async def store_declarative_cli_profiles(db, values: object) -> list[CLIProfile]:
    if not isinstance(values, list):
        raise DeclarativeCLIProfileError("CLI profiles must be a JSON list")
    profiles = [declarative_profile_from_data(item) for item in values]
    if len({profile.id for profile in profiles}) != len(profiles):
        raise DeclarativeCLIProfileError("CLI profiles contain duplicate ids")
    encoded = json.dumps(
        [declarative_profile_to_data(profile) for profile in profiles],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    await db.execute(
        """INSERT INTO app_settings (key, value, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value, updated_at = excluded.updated_at""",
        (CLI_PROFILES_SETTING, encoded),
    )
    replace_declarative_profiles(profiles)
    return profiles
