"""Plugin registry client.

A registry is just a URL pointing to a static JSON index. The index lists
plugins with their metadata; full plugin packages are fetched on install.

Index format (registry_index.json):
{
    "registry_version": "1.0",
    "name": "Commander Official",
    "updated_at": "2026-04-11T00:00:00Z",
    "plugins": [
        {
            "id": "caveman-output",
            "name": "Caveman Output",
            "version": "2.1.0",
            "description": "...",
            "author": "JuliusBrussee",
            "license": "MIT",
            "source_url": "https://github.com/JuliusBrussee/caveman",
            "source_format": "skill_md",
            "categories": ["output-mode"],
            "tags": ["brevity", "tokens"],
            "security_tier": 1,
            "contains_scripts": true,
            "rating": 4.2,
            "install_count": 3400,
            "package_url": "https://.../caveman-2.1.0.json",
            "checksum": "sha256:..."
        },
        ...
    ]
}

Package format (full plugin.yaml/.json fetched on install):
{
    "id": "caveman-output",
    "version": "2.1.0",
    ... (all index fields) ...
    "components": [
        {
            "id": "caveman-full",
            "type": "guideline",
            "name": "Caveman Full",
            "description": "Drop articles, fragments OK",
            "content": "<system prompt fragment text>"
        },
        {
            "id": "caveman-activate",
            "type": "script",
            "name": "Session Activator",
            "description": "Sets active mode flag",
            "content": "<script source>",
            "trigger": "session_start",
            "permissions": ["file_write"],
            "risk_level": "low"
        }
    ]
}

The client is intentionally lenient with missing fields — registries are
user-configurable and may be sparse.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)

REGISTRY_FETCH_TIMEOUT = 15  # seconds


class RegistryError(Exception):
    """Raised when a registry index can't be fetched or parsed."""


async def fetch_registry_index(url: str) -> dict[str, Any]:
    """Fetch and parse a registry index JSON file.

    Returns the parsed dict on success. Raises RegistryError on any failure
    so callers can record a sync error against the registry row.
    """
    timeout = aiohttp.ClientTimeout(total=REGISTRY_FETCH_TIMEOUT)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as resp:
                if resp.status != 200:
                    raise RegistryError(f"HTTP {resp.status} from {url}")
                text = await resp.text()
    except asyncio.TimeoutError as e:
        raise RegistryError(f"Timeout fetching {url}") from e
    except aiohttp.ClientError as e:
        raise RegistryError(f"Network error fetching {url}: {e}") from e

    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise RegistryError(f"Invalid JSON from {url}: {e}") from e

    if not isinstance(data, dict):
        raise RegistryError(f"Registry root must be an object, got {type(data).__name__}")
    if "plugins" not in data or not isinstance(data["plugins"], list):
        raise RegistryError(f"Registry missing 'plugins' array")

    return data


async def fetch_plugin_package(package_url: str) -> dict[str, Any]:
    """Fetch the full plugin package (with components) from its package_url.

    Used at install time when the user clicks Install on a catalog entry.
    """
    timeout = aiohttp.ClientTimeout(total=REGISTRY_FETCH_TIMEOUT)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(package_url) as resp:
                if resp.status != 200:
                    raise RegistryError(f"HTTP {resp.status} fetching package from {package_url}")
                text = await resp.text()
    except asyncio.TimeoutError as e:
        raise RegistryError(f"Timeout fetching package {package_url}") from e
    except aiohttp.ClientError as e:
        raise RegistryError(f"Network error fetching package: {e}") from e

    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise RegistryError(f"Invalid package JSON: {e}") from e


def normalize_plugin_entry(entry: dict[str, Any], registry_id: str) -> dict[str, Any]:
    """Lenient normalization of a registry plugin entry into our DB row shape.

    Missing fields default to safe values so a sparse registry can still
    populate the catalog.
    """
    return {
        "id": entry.get("id") or entry.get("slug") or "",
        "registry_id": registry_id,
        "name": entry.get("name") or entry.get("id") or "(unnamed)",
        "version": entry.get("version") or "0.0.0",
        "description": entry.get("description") or "",
        "author": entry.get("author") or "",
        "license": entry.get("license") or "",
        "source_url": entry.get("source_url") or "",
        "source_format": entry.get("source_format") or "unknown",
        "categories": json.dumps(entry.get("categories") or []),
        "tags": json.dumps(entry.get("tags") or []),
        "security_tier": int(entry.get("security_tier") or 0),
        "contains_scripts": 1 if entry.get("contains_scripts") else 0,
        "rating": float(entry.get("rating") or 0),
        "install_count": int(entry.get("install_count") or 0),
        "package_url": entry.get("package_url") or "",
        "checksum": entry.get("checksum") or "",
    }
