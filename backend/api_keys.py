"""Centralized optional API key management.

Stores and resolves optional API keys used across IVE subsystems (Observatory,
Deep Research, model discovery, plugins). Resolution chain: app_settings DB →
environment variable → None.

Each key has a logical name, a DB storage key in app_settings, the env var it
falls back to, a human label, a description, and which IVE feature(s) use it.
"""
from __future__ import annotations

import os
import logging
from dataclasses import dataclass

from db import get_db

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ApiKeyDef:
    """Definition of an optional API key."""
    name: str           # Logical name (e.g. "github")
    settings_key: str   # Key in app_settings table
    env_var: str        # Environment variable fallback
    label: str          # Human-readable label
    description: str    # What it enables
    used_by: list[str]  # Which features use it


# ── Registry of all optional keys ─────────────────────────────────────

API_KEYS: dict[str, ApiKeyDef] = {}


def _register(*defs: ApiKeyDef):
    for d in defs:
        API_KEYS[d.name] = d


_register(
    ApiKeyDef(
        name="github",
        settings_key="api_key_github_token",
        env_var="GITHUB_TOKEN",
        label="GitHub Token",
        description="Raises API rate limit from 60 to 5000 req/hr. Used by Observatory scanner and Deep Research GitHub search.",
        used_by=["observatory", "deep_research"],
    ),
    ApiKeyDef(
        name="brave",
        settings_key="api_key_brave",
        env_var="BRAVE_API_KEY",
        label="Brave Search API Key",
        description="Enables Brave web search. Free tier: 2000 queries/month. Used by Observatory, Deep Research, and research plugins.",
        used_by=["observatory", "deep_research", "plugins"],
    ),
    ApiKeyDef(
        name="producthunt",
        settings_key="api_key_producthunt",
        env_var="PH_ACCESS_TOKEN",
        label="Product Hunt Access Token",
        description="Enables Product Hunt GraphQL API for trending product scanning. Without it, falls back to DuckDuckGo scraping.",
        used_by=["observatory"],
    ),
    ApiKeyDef(
        name="searxng",
        settings_key="api_key_searxng_url",
        env_var="SEARXNG_URL",
        label="SearXNG Instance URL",
        description="Self-hosted meta-search engine URL (e.g. http://localhost:8888). Adds a private search backend for Deep Research.",
        used_by=["deep_research", "plugins"],
    ),
    ApiKeyDef(
        name="anthropic",
        settings_key="api_key_anthropic",
        env_var="ANTHROPIC_API_KEY",
        label="Anthropic API Key",
        description="Enables Claude model discovery (auto-detect latest model IDs). Sessions use CLI auth by default — this is only for model listing.",
        used_by=["model_discovery"],
    ),
    ApiKeyDef(
        name="google",
        settings_key="api_key_google",
        env_var="GOOGLE_API_KEY",
        label="Google / Gemini API Key",
        description="Enables Gemini model discovery and Myelin coordination embeddings. Also accepts GEMINI_API_KEY env var.",
        used_by=["model_discovery", "myelin"],
    ),
    ApiKeyDef(
        name="huggingface",
        settings_key="api_key_huggingface",
        env_var="HF_TOKEN",
        label="Hugging Face Token",
        description="Authenticated access to private HF repos/models via the HF Explorer plugin.",
        used_by=["plugins"],
    ),
)


# ── Resolution ────────────────────────────────────────────────────────

async def resolve(name: str) -> str | None:
    """Resolve an API key: check app_settings first, then fall back to env var."""
    defn = API_KEYS.get(name)
    if not defn:
        return None

    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT value FROM app_settings WHERE key = ?", (defn.settings_key,)
        )
        row = await cur.fetchone()
        if row and row["value"]:
            return row["value"]
    finally:
        await db.close()

    # Google key has a second env var alias
    if name == "google":
        return os.getenv(defn.env_var) or os.getenv("GEMINI_API_KEY")

    return os.getenv(defn.env_var) if defn.env_var else None


async def get_all_status() -> dict:
    """Return status of all registered API keys (no values exposed)."""
    result = {}
    for name, defn in API_KEYS.items():
        db = await get_db()
        db_value = None
        try:
            cur = await db.execute(
                "SELECT value FROM app_settings WHERE key = ?", (defn.settings_key,)
            )
            row = await cur.fetchone()
            has_db = bool(row and row["value"])
            if has_db:
                db_value = row["value"]
        finally:
            await db.close()

        env_value = os.getenv(defn.env_var)
        # Google alias
        if not env_value and name == "google":
            env_value = os.getenv("GEMINI_API_KEY")
        has_env = bool(env_value)

        raw = db_value if has_db else (env_value if has_env else None)
        preview = (raw[:4] + "••••••••") if raw and len(raw) > 4 else None

        result[name] = {
            "configured": has_db or has_env,
            "source": "settings" if has_db else ("env" if has_env else "none"),
            "preview": preview,
            "label": defn.label,
            "description": defn.description,
            "env_var": defn.env_var,
            "used_by": defn.used_by,
        }
    return result


async def save(name: str, value: str) -> bool:
    """Store an API key in app_settings."""
    defn = API_KEYS.get(name)
    if not defn:
        return False
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO app_settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
            (defn.settings_key, value),
        )
        await db.commit()
        return True
    finally:
        await db.close()


async def delete(name: str) -> bool:
    """Remove an API key from app_settings (env var still works as fallback)."""
    defn = API_KEYS.get(name)
    if not defn:
        return False
    db = await get_db()
    try:
        await db.execute("DELETE FROM app_settings WHERE key = ?", (defn.settings_key,))
        await db.commit()
        return True
    finally:
        await db.close()


async def resolve_env_overrides() -> dict[str, str]:
    """Resolve all configured keys and return as {ENV_VAR: value} dict.

    Useful for injecting DB-stored keys into subprocess environments so that
    child processes (deep_research, plugins) see them as regular env vars.
    Only includes keys that are actually configured (DB or env).
    """
    overrides = {}
    for name, defn in API_KEYS.items():
        value = await resolve(name)
        if value:
            overrides[defn.env_var] = value
            # Google has an alias
            if name == "google":
                overrides["GEMINI_API_KEY"] = value
    return overrides
