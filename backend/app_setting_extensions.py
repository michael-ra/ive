"""Optional setting ownership/validation with value-free persisted provenance.

Unknown keys remain ordinary custom settings. Ownership cannot be reconstructed
from an absent product's source: initialize once with an old owner installed
before removing it if its legacy rows must be protected by this boundary.
"""
from __future__ import annotations

import re
import extension_host

SCHEMA = """
CREATE TABLE IF NOT EXISTS app_settings_ownership (
    key TEXT PRIMARY KEY,
    extension_id TEXT NOT NULL
);
"""

_CORE_RESERVED_KEYS = frozenset({
    "model_providers", "catchup_model", "secure_command_check_model", "secure_build_vet_model",
    "experimental_avcp_protection", "experimental_safety_gate", "experimental_auto_skill_suggestions",
})
_CORE_RESERVED_PREFIXES = ("api_key_", "safety_")


class SettingUnavailable(RuntimeError):
    """A proven setting owner is unavailable; do not read, write or clear it."""


def _contributors():
    """Selected backend/app_settings.py declarations; no absent-source reads.

    KEYS declares exact legacy names and PREFIXES declares dynamic namespaces.
    normalize(key, value), when supplied, validates the already-text-coerced
    value. Providers are trusted source, not a sandbox or permission bypass.
    """
    for metadata in extension_host.installed_extensions():
        owner = metadata["id"]
        root = extension_host.extension_path(owner)
        relative = "backend/app_settings.py"
        if (root / relative).is_file():
            yield owner, extension_host.load_backend_module(owner, relative)


def _names(value) -> tuple[str, ...]:
    if (not isinstance(value, (tuple, list))
            or any(not isinstance(name, str) or not name or name != name.strip() for name in value)
            or len(set(value)) != len(value)):
        raise ValueError("Invalid extension setting declaration")
    return tuple(value)


def _declarations():
    declarations = []
    for owner, module in _contributors():
        keys = _names(getattr(module, "KEYS", ()))
        prefixes = _names(getattr(module, "PREFIXES", ()))
        if any(key in _CORE_RESERVED_KEYS or key.startswith(_CORE_RESERVED_PREFIXES) for key in keys):
            raise ValueError("Extension cannot own core guarded settings")
        if any(any(key.startswith(prefix) for key in _CORE_RESERVED_KEYS)
               or any(core.startswith(prefix) or prefix.startswith(core) for core in _CORE_RESERVED_PREFIXES)
               for prefix in prefixes):
            raise ValueError("Extension cannot own core guarded settings")
        for other_owner, _other_module, other_keys, other_prefixes in declarations:
            if other_owner == owner:
                raise ValueError("Duplicate extension setting provider")
            if (set(keys) & set(other_keys) or any(key.startswith(other_prefixes) for key in keys)
                    or any(key.startswith(prefixes) for key in other_keys)
                    or any(left.startswith(right) or right.startswith(left) for left in prefixes for right in other_prefixes)):
                raise ValueError("Conflicting extension setting declarations")
        declarations.append((owner, module, keys, prefixes))
    return declarations


async def refresh_ownership(db, *, commit: bool = True) -> dict[str, str]:
    """Idempotently register selected owners without changing setting values.

    Exact names are recorded even while unset. Dynamic prefixes register only
    existing rows, so private direct writers of new dynamic names must arrange
    registration before their owner is removed. Proof intentionally survives a
    value deletion. The initialization caller controls its own final commit.
    """
    declarations = _declarations()
    await db.execute(SCHEMA)
    cursor = await db.execute("SELECT key, extension_id FROM app_settings_ownership")
    ownership = {row["key"]: row["extension_id"] for row in await cursor.fetchall()}
    if any(not isinstance(owner, str) or not re.fullmatch(r"[a-z][a-z0-9_-]*", owner)
           for owner in ownership.values()):
        raise ValueError("Invalid persisted setting ownership")
    existing_keys = ()
    if any(prefixes for _owner, _module, _keys, prefixes in declarations):
        cursor = await db.execute("SELECT key FROM app_settings")
        existing_keys = tuple(row["key"] for row in await cursor.fetchall())
    claimed = {}
    for owner, _module, keys, prefixes in declarations:
        names = set(keys) | {key for key in existing_keys if key.startswith(prefixes)}
        for key in names:
            previous = ownership.get(key)
            if previous is not None and previous != owner:
                raise ValueError("Conflicting persisted setting ownership")
            claimed[key] = owner
    changed = False
    for key, owner in sorted(claimed.items()):
        if key not in ownership:
            await db.execute(
                "INSERT INTO app_settings_ownership (key, extension_id) VALUES (?, ?) "
                "ON CONFLICT(key) DO NOTHING", (key, owner))
            changed = True
    if changed:
        cursor = await db.execute("SELECT key, extension_id FROM app_settings_ownership")
        ownership = {row["key"]: row["extension_id"] for row in await cursor.fetchall()}
        if any(ownership.get(key) != owner for key, owner in claimed.items()):
            raise ValueError("Conflicting concurrent setting ownership")
        if commit:
            await db.commit()
    return ownership


def visible(key: str, ownership: dict[str, str]) -> bool:
    owner = ownership.get(key)
    return owner is None or extension_host.available(owner)


def normalize(key: str, value, ownership: dict[str, str]):
    """Unavailable proven owners reject updates, including value deletion."""
    owner = ownership.get(key)
    if owner is None:
        return value
    if not extension_host.available(owner):
        raise SettingUnavailable("setting belongs to an unavailable extension")
    for provider_owner, module, _keys, _prefixes in _declarations():
        if provider_owner == owner:
            validator = getattr(module, "normalize", None)
            result = value if validator is None else validator(key, value)
            if result is not None and not isinstance(result, str):
                raise ValueError("Extension setting validator must return text or null")
            return result
    raise SettingUnavailable("setting owner has no installed settings provider")
