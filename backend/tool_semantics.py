"""Canonical tool-operation classification shared by guards and telemetry.

CLI profiles may declare native tool names and the input keys that carry their
targets.  Calls without a declaration are classified conservatively from
their *shape*: command-bearing fields and mutation-shaped path/content pairs
are recognized, while prompts and descriptions are never treated as shell
commands merely because they are strings.
"""
from __future__ import annotations

import json
import logging
import re
import shlex
import time
from dataclasses import dataclass
from typing import Any, Mapping

logger = logging.getLogger(__name__)

CANONICAL_OPERATIONS = frozenset({"read", "mutate", "execute", "delegate"})

_COMMAND_KEYS = (
    "command", "cmd", "shell_command", "command_line", "script", "script_body",
)
_SCRIPT_PATH_KEYS = ("script_path", "executable_path")
_ARGV_KEYS = ("argv", "command_args", "exec_args")
_PATH_KEYS = (
    "file_path", "path", "target_path", "destination", "destination_path",
    "notebook_path",
)
_MUTATION_VALUE_KEYS = (
    "content", "patch", "diff", "old_string", "new_string", "replacement",
    "new_content", "edits",
)
_READ_TARGET_KEYS = ("file_path", "path", "pattern", "query", "url")
_DELEGATE_TARGET_KEYS = ("agent", "agent_id", "subagent_type", "task", "prompt")

_EXECUTE_WORDS = frozenset({"bash", "shell", "execute", "exec", "command", "terminal", "script", "run"})
_MUTATE_WORDS = frozenset({
    "write", "edit", "create", "delete", "remove", "patch", "replace", "save",
    "move", "copy", "rename", "mutate", "update", "apply",
})
_READ_WORDS = frozenset({"read", "get", "find", "search", "list", "glob", "grep", "fetch", "view"})
_DELEGATE_WORDS = frozenset({"agent", "task", "spawn", "delegate", "subagent", "handoff"})
_PROSE_WORDS = frozenset({"description", "instruction", "instructions", "prompt"})

_URI_RE = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)
_WINDOWS_PATH_RE = re.compile(r"^[a-z]:[\\/]", re.IGNORECASE)

_UNKNOWN_AUDIT_INTERVAL_S = 60.0
_UNKNOWN_AUDIT_MAX_KEYS = 128
_unknown_audit_last: dict[tuple[str, str, tuple[str, ...]], float] = {}


@dataclass(frozen=True)
class ToolClassification:
    operation: str | None
    target_keys: tuple[str, ...] = ()
    targets: tuple[tuple[str, str], ...] = ()
    declared: bool = False
    inferred: bool = False

    @property
    def primary_target(self) -> str:
        return self.targets[0][1] if self.targets else ""

    def target_for(self, *keys: str) -> str:
        wanted = set(keys)
        for key, value in self.targets:
            if key in wanted:
                return value
        return ""


def _name_words(tool_name: str) -> set[str]:
    expanded = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", tool_name or "")
    return {part for part in re.split(r"[^a-z0-9]+", expanded.lower()) if part}


def _string_value(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list) and value and all(isinstance(item, str) for item in value):
        return shlex.join(value)
    return ""


def _looks_like_filesystem_path(value: Any) -> bool:
    """Recognize path syntax without treating arbitrary prose as a target."""
    text = _string_value(value)
    if not text or "\x00" in text or "\n" in text or "\r" in text:
        return False
    if _URI_RE.match(text):
        return False
    if text.startswith("/"):
        # Slash commands such as "/loop keep working" are prose, not paths.
        return not any(char.isspace() for char in text) or text.count("/") > 1
    if text.startswith(("~/", "./", "../", "\\\\")):
        return True
    if _WINDOWS_PATH_RE.match(text):
        return True
    return (
        ("/" in text or "\\" in text)
        and not any(char.isspace() for char in text)
        and not any(token in text for token in (";", "|", "`", "$("))
    )


def _shape_targets(
    tool_input: Mapping[str, Any],
) -> tuple[tuple[tuple[str, str], ...], tuple[tuple[str, str], ...]]:
    """Return path-shaped values and non-path payload values, in input order."""
    paths: list[tuple[str, str]] = []
    payloads: list[tuple[str, str]] = []
    for raw_key, raw_value in tool_input.items():
        if not isinstance(raw_key, str) or _name_words(raw_key) & _PROSE_WORDS:
            continue
        value = _string_value(raw_value)
        if _looks_like_filesystem_path(raw_value):
            paths.append((raw_key, value))
        elif isinstance(raw_value, str):
            payloads.append((raw_key, value))
        elif isinstance(raw_value, (bytes, bytearray, Mapping, list, tuple)) and raw_value:
            payloads.append((raw_key, value))
    return tuple(paths), tuple(payloads)


def _targets(tool_input: Mapping[str, Any], keys: tuple[str, ...]) -> tuple[tuple[str, str], ...]:
    found: list[tuple[str, str]] = []
    for key in keys:
        value = _string_value(tool_input.get(key))
        if value:
            found.append((key, value))
    return tuple(found)


def _declared_semantic(
    tool_name: str,
    tool_semantics: Mapping[str, Mapping[str, Any]] | None,
) -> Mapping[str, Any] | None:
    normalized = (tool_name or "").strip().lower()
    for native_name, semantic in (tool_semantics or {}).items():
        if str(native_name).strip().lower() == normalized and isinstance(semantic, Mapping):
            return semantic
    return None


def _audit_unknown_shape(tool_name: str, classification: ToolClassification) -> None:
    if classification.operation not in {"mutate", "execute", "delegate"}:
        return
    key = (
        (tool_name or "").strip().lower(),
        classification.operation,
        tuple(name for name, _ in classification.targets),
    )
    now = time.monotonic()
    previous = _unknown_audit_last.get(key, 0.0)
    if now - previous < _UNKNOWN_AUDIT_INTERVAL_S:
        return
    if len(_unknown_audit_last) >= _UNKNOWN_AUDIT_MAX_KEYS:
        oldest = min(_unknown_audit_last, key=_unknown_audit_last.get)
        _unknown_audit_last.pop(oldest, None)
    _unknown_audit_last[key] = now
    logger.warning(
        "unknown_tool_shape %s",
        json.dumps({
            "event": "unknown_tool_shape",
            "tool_name": tool_name,
            "operation": classification.operation,
            "target_keys": [name for name, _ in classification.targets],
        }, sort_keys=True),
    )


def classify_tool_call(
    tool_name: str,
    tool_input: Mapping[str, Any] | None,
    *,
    tool_semantics: Mapping[str, Mapping[str, Any]] | None = None,
    audit_unknown: bool = True,
) -> ToolClassification:
    """Classify a native tool call as read/mutate/execute/delegate.

    Declared profile semantics win.  On a miss, only meaningful key/name
    combinations infer a privileged operation; arbitrary prompt and
    description strings remain targetless.
    """
    inputs = tool_input if isinstance(tool_input, Mapping) else {}
    declared = _declared_semantic(tool_name, tool_semantics)
    if declared is not None:
        operation = str(declared.get("operation") or "").strip().lower()
        raw_keys = declared.get("target_keys") or []
        keys = tuple(str(key) for key in raw_keys if isinstance(key, str) and key)
        if operation in CANONICAL_OPERATIONS:
            return ToolClassification(
                operation=operation,
                target_keys=keys,
                targets=_targets(inputs, keys),
                declared=True,
            )
        # A malformed declaration must not suppress shape detection.  Falling
        # through keeps suspicious command/mutation fields fail-closed and
        # emits the same unknown-shape audit as an undeclared native tool.

    words = _name_words(tool_name)
    command_targets = _targets(inputs, _COMMAND_KEYS)
    script_targets = _targets(inputs, _SCRIPT_PATH_KEYS)
    argv_targets = _targets(inputs, _ARGV_KEYS)
    path_targets = _targets(inputs, _PATH_KEYS)
    mutation_values = _targets(inputs, _MUTATION_VALUE_KEYS)
    shaped_paths, shaped_payloads = _shape_targets(inputs)
    execute_keys_present = any(
        key in inputs for key in (*_COMMAND_KEYS, *_SCRIPT_PATH_KEYS, *_ARGV_KEYS)
    )
    path_keys_present = any(key in inputs for key in _PATH_KEYS)
    mutation_keys_present = any(key in inputs for key in _MUTATION_VALUE_KEYS)

    classification = ToolClassification(operation=None)
    if command_targets or script_targets or argv_targets or execute_keys_present:
        classification = ToolClassification(
            operation="execute",
            target_keys=tuple((*_COMMAND_KEYS, *_SCRIPT_PATH_KEYS, *_ARGV_KEYS)),
            targets=tuple((*command_targets, *script_targets, *argv_targets)),
            inferred=True,
        )
    elif (
        (path_keys_present and mutation_keys_present)
        or (path_keys_present and words & _MUTATE_WORDS)
        or (mutation_keys_present and words & _MUTATE_WORDS)
        or (shaped_paths and shaped_payloads)
        or (shaped_paths and words & _MUTATE_WORDS)
        or len(shaped_paths) > 1
    ):
        mutation_targets = tuple(dict.fromkeys((
            *shaped_paths,
            *path_targets,
            *mutation_values,
            *shaped_payloads,
        )))
        classification = ToolClassification(
            operation="mutate",
            target_keys=tuple(dict.fromkeys((
                *_PATH_KEYS,
                *_MUTATION_VALUE_KEYS,
                *(key for key, _value in mutation_targets),
            ))),
            targets=mutation_targets,
            inferred=True,
        )
    elif words & _EXECUTE_WORDS:
        classification = ToolClassification(
            operation="execute",
            target_keys=tuple((*_COMMAND_KEYS, *_SCRIPT_PATH_KEYS, *_ARGV_KEYS)),
            targets=(),
            inferred=True,
        )
    elif words & _DELEGATE_WORDS:
        classification = ToolClassification(
            operation="delegate",
            target_keys=_DELEGATE_TARGET_KEYS,
            targets=_targets(inputs, _DELEGATE_TARGET_KEYS),
            inferred=True,
        )
    elif words & _READ_WORDS:
        classification = ToolClassification(
            operation="read",
            target_keys=_READ_TARGET_KEYS,
            targets=_targets(inputs, _READ_TARGET_KEYS),
            inferred=True,
        )

    if audit_unknown and classification.inferred:
        _audit_unknown_shape(tool_name, classification)
    return classification


def semantic(operation: str, *target_keys: str) -> dict[str, Any]:
    """Small helper for readable built-in CLI profile declarations."""
    return {"operation": operation, "target_keys": list(target_keys)}


COMMON_TOOL_SEMANTICS: dict[str, dict[str, Any]] = {
    # Reads and searches.
    "Read": semantic("read", "file_path", "path"),
    "read_file": semantic("read", "file_path", "path"),
    "Glob": semantic("read", "pattern", "path"),
    "find_files": semantic("read", "pattern", "path"),
    "Grep": semantic("read", "pattern", "path"),
    "search": semantic("read", "pattern", "path", "query"),
    "WebFetch": semantic("read", "url"),
    "web_fetch": semantic("read", "url"),
    "WebSearch": semantic("read", "query"),
    "web_search": semantic("read", "query"),
    # File mutations observed across Claude, Gemini, and Antigravity hooks.
    "Write": semantic("mutate", "file_path", "path"),
    "Edit": semantic("mutate", "file_path", "path"),
    "MultiEdit": semantic("mutate", "file_path", "path"),
    "NotebookEdit": semantic("mutate", "notebook_path", "file_path", "path"),
    "write_file": semantic("mutate", "file_path", "path"),
    "edit_file": semantic("mutate", "file_path", "path"),
    "create_file": semantic("mutate", "file_path", "path"),
    "delete_file": semantic("mutate", "file_path", "path"),
    "save_file": semantic("mutate", "file_path", "path"),
    "write_to_file": semantic("mutate", "file_path", "path"),
    "replace_file_content": semantic("mutate", "file_path", "path"),
    "multi_replace_file_content": semantic("mutate", "file_path", "path"),
    # Native command aliases already observed by the safety/hook adapters.
    "Bash": semantic("execute", "command", "script"),
    "execute": semantic("execute", "command", "cmd", "script"),
    "execute_command": semantic("execute", "command", "cmd", "script"),
    "run_command": semantic("execute", "command", "cmd", "script"),
    "shell_execute": semantic("execute", "command", "cmd", "script"),
    "run_shell_command": semantic("execute", "command", "cmd", "script"),
    # Native subagent dispatch must not bypass Commander delegation policy.
    "Task": semantic("delegate", "prompt", "description", "subagent_type"),
    "Agent": semantic("delegate", "prompt", "description", "subagent_type"),
    "Spawn": semantic("delegate", "prompt", "description", "subagent_type"),
    "spawn_agent": semantic("delegate", "prompt", "description", "subagent_type"),
    "delegate": semantic("delegate", "prompt", "description", "agent"),
}
