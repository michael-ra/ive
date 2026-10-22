"""Compose selected local event declarations without importing event consumers.

Owner modules are declarative: they may define payload types and metadata but
must not import the registry, start services, or inspect application state.
Composition happens before the public enum and registry are constructed.
"""
from __future__ import annotations

import re

from extension_host import extension_path, installed_extensions, load_backend_module


def compose_members(core: dict[str, str], groups: list[dict]) -> tuple[dict, dict]:
    """Preserve core/owner order and reject aliases, duplicate names, or anchors."""
    members = dict(core)
    names = set(core)
    wires = set(core.values())
    definitions = {}
    pending = []
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get("after"), str):
            raise ValueError("Event group needs a string insertion anchor")
        entries = group.get("events")
        if not isinstance(entries, (list, tuple)) or not entries:
            raise ValueError("Event group needs a non-empty declaration list")
        normalized = []
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError("Event declaration must be a mapping")
            name, value = entry.get("name"), entry.get("value")
            if not isinstance(name, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]*", name):
                raise ValueError("Invalid event enum member name")
            if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", value):
                raise ValueError("Invalid Commander event wire name")
            if name in names or value in wires:
                raise ValueError(f"Duplicate event member or wire name: {name}")
            if any(not isinstance(entry.get(key), str) or not entry[key] for key in ("label", "category")):
                raise ValueError(f"Event {name} needs label and category")
            if "payload_type" not in entry:
                raise ValueError(f"Event {name} needs a payload type")
            names.add(name)
            wires.add(value)
            definitions[value] = dict(entry)
            normalized.append((name, value))
        pending.append((group["after"], normalized))

    anchors_used = set()
    while pending:
        deferred = []
        for anchor, entries in pending:
            if anchor not in members:
                deferred.append((anchor, entries))
                continue
            if anchor in anchors_used:
                raise ValueError(f"Duplicate event insertion anchor: {anchor}")
            anchors_used.add(anchor)
            ordered = []
            for name, value in members.items():
                ordered.append((name, value))
                if name == anchor:
                    ordered.extend(entries)
            members = dict(ordered)
        if len(deferred) == len(pending):
            raise ValueError(f"Missing or cyclic event insertion anchors: {sorted(anchor for anchor, _ in deferred)}")
        pending = deferred
    return members, definitions


def selected_declarations() -> tuple[list[dict], dict, dict]:
    """Read only selected owner metadata; duplicate overlays fail startup."""
    groups = []
    category_payloads = {}
    core_overrides = {}
    for extension in installed_extensions():
        owner = extension["id"]
        path = extension_path(owner) / "backend/events.py"
        if not path.is_file():
            continue
        provider = load_backend_module(owner, "backend/events.py")
        contributed = getattr(provider, "EVENT_GROUPS", ())
        if not isinstance(contributed, (list, tuple)):
            raise ValueError(f"Invalid event groups from {owner}")
        groups.extend(contributed)
        for attribute, target in (("CATEGORY_PAYLOADS", category_payloads), ("CORE_EVENT_OVERRIDES", core_overrides)):
            value = getattr(provider, attribute, {})
            if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
                raise ValueError(f"Invalid {attribute} from {owner}")
            duplicate = target.keys() & value.keys()
            if duplicate:
                raise ValueError(f"Duplicate {attribute}: {sorted(duplicate)}")
            target.update(value)
    return groups, category_payloads, core_overrides
