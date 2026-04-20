"""Plugin lifecycle: install, uninstall, sync, attach to sessions.

Plugins are stored in two states in the `plugins` table:
  • installed=0 → catalog rows from a registry sync (browsable)
  • installed=1 → locally installed (can be attached to sessions)

Catalog rows are wiped + repopulated on each sync; installed rows are
preserved across syncs and survive even if the source registry goes away.

A plugin's components (guidelines + scripts) live in plugin_components.
For installed plugins, individual guideline components can be attached to
sessions via session_plugin_components — same shape as session_guidelines
but at the component granularity so users can enable a guideline from a
plugin without enabling its scripts.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
import uuid

log = logging.getLogger(__name__)
from datetime import datetime, timezone
from typing import Any

from db import get_db
from registry_client import (
    RegistryError,
    fetch_plugin_package,
    fetch_registry_index,
    normalize_plugin_entry,
)

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ─── Registries ──────────────────────────────────────────────────────────


async def list_registries() -> list[dict[str, Any]]:
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT * FROM plugin_registries ORDER BY order_index, name"
        )
        rows = await cur.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


async def add_registry(name: str, url: str) -> dict[str, Any]:
    rid = str(uuid.uuid4())
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT COALESCE(MAX(order_index), 0) + 1 FROM plugin_registries"
        )
        row = await cur.fetchone()
        order_index = row[0] if row else 0
        await db.execute(
            """INSERT INTO plugin_registries
               (id, name, url, enabled, is_builtin, last_sync_status, order_index)
               VALUES (?, ?, ?, 1, 0, 'never', ?)""",
            (rid, name, url, order_index),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM plugin_registries WHERE id = ?", (rid,))
        row = await cur.fetchone()
        return dict(row)
    finally:
        await db.close()


async def update_registry(rid: str, *, name: str | None = None,
                          url: str | None = None, enabled: bool | None = None) -> dict[str, Any] | None:
    fields, values = [], []
    if name is not None:
        fields.append("name = ?")
        values.append(name)
    if url is not None:
        fields.append("url = ?")
        values.append(url)
    if enabled is not None:
        fields.append("enabled = ?")
        values.append(1 if enabled else 0)
    if not fields:
        return None
    values.append(rid)

    db = await get_db()
    try:
        await db.execute(
            f"UPDATE plugin_registries SET {', '.join(fields)} WHERE id = ?",
            values,
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM plugin_registries WHERE id = ?", (rid,))
        row = await cur.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()


async def delete_registry(rid: str) -> bool:
    """Delete a registry. Built-in registries cannot be deleted (only disabled).
    Returns True if deleted, False if not found or built-in."""
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT is_builtin FROM plugin_registries WHERE id = ?", (rid,)
        )
        row = await cur.fetchone()
        if not row:
            return False
        if row["is_builtin"]:
            return False
        # Wipe catalog entries from this registry (preserve installed)
        await db.execute(
            "DELETE FROM plugins WHERE registry_id = ? AND installed = 0", (rid,)
        )
        await db.execute("DELETE FROM plugin_registries WHERE id = ?", (rid,))
        await db.commit()
        return True
    finally:
        await db.close()


async def sync_registry(rid: str) -> dict[str, Any]:
    """Fetch the registry index and refresh its catalog rows.

    Catalog rows from this registry are wiped and replaced. Installed
    plugins are NEVER touched by sync — they're user data. Returns a status
    dict with plugin_count or error.
    """
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT * FROM plugin_registries WHERE id = ?", (rid,)
        )
        registry = await cur.fetchone()
        if not registry:
            return {"ok": False, "error": "registry not found"}
        if not registry["enabled"]:
            return {"ok": False, "error": "registry disabled"}
        url = registry["url"]
    finally:
        await db.close()

    # Fetch outside the DB connection so we don't hold it during network I/O.
    try:
        index = await fetch_registry_index(url)
    except RegistryError as e:
        await _record_sync_error(rid, str(e))
        return {"ok": False, "error": str(e)}

    plugins = index.get("plugins", [])
    db = await get_db()
    try:
        # Wipe catalog entries (installed=0) from this registry. Components
        # for catalog entries cascade-delete via FK.
        await db.execute(
            "DELETE FROM plugins WHERE registry_id = ? AND installed = 0", (rid,)
        )

        count = 0
        for entry in plugins:
            normalized = normalize_plugin_entry(entry, rid)
            if not normalized["id"]:
                continue
            # Skip if user already has this plugin installed (preserve their copy).
            cur = await db.execute(
                "SELECT 1 FROM plugins WHERE id = ? AND installed = 1",
                (normalized["id"],),
            )
            if await cur.fetchone():
                count += 1
                continue
            await db.execute(
                """INSERT INTO plugins
                   (id, registry_id, name, version, description, author, license,
                    source_url, source_format, categories, tags, security_tier,
                    contains_scripts, rating, install_count, package_url, checksum,
                    installed, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0, datetime('now'))""",
                (
                    normalized["id"],
                    normalized["registry_id"],
                    normalized["name"],
                    normalized["version"],
                    normalized["description"],
                    normalized["author"],
                    normalized["license"],
                    normalized["source_url"],
                    normalized["source_format"],
                    normalized["categories"],
                    normalized["tags"],
                    normalized["security_tier"],
                    normalized["contains_scripts"],
                    normalized["rating"],
                    normalized["install_count"],
                    normalized["package_url"],
                    normalized["checksum"],
                ),
            )
            count += 1

        await db.execute(
            """UPDATE plugin_registries
               SET last_synced_at = datetime('now'),
                   last_sync_status = 'ok',
                   last_sync_error = NULL,
                   plugin_count = ?
               WHERE id = ?""",
            (count, rid),
        )
        await db.commit()
        return {"ok": True, "plugin_count": count}
    finally:
        await db.close()


async def _record_sync_error(rid: str, error: str) -> None:
    db = await get_db()
    try:
        await db.execute(
            """UPDATE plugin_registries
               SET last_synced_at = datetime('now'),
                   last_sync_status = 'error',
                   last_sync_error = ?
               WHERE id = ?""",
            (error[:500], rid),
        )
        await db.commit()
    finally:
        await db.close()


# ─── Plugins ─────────────────────────────────────────────────────────────


async def list_plugins(*, installed_only: bool = False,
                       registry_id: str | None = None) -> list[dict[str, Any]]:
    """List plugins. Combines catalog + installed unless filtered."""
    sql = "SELECT * FROM plugins WHERE 1=1"
    params: list[Any] = []
    if installed_only:
        sql += " AND installed = 1"
    if registry_id:
        sql += " AND registry_id = ?"
        params.append(registry_id)
    sql += " ORDER BY installed DESC, install_count DESC, name"

    db = await get_db()
    try:
        cur = await db.execute(sql, params)
        rows = await cur.fetchall()
        return [_row_to_dict(r) for r in rows]
    finally:
        await db.close()


async def get_plugin(plugin_id: str) -> dict[str, Any] | None:
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM plugins WHERE id = ?", (plugin_id,))
        row = await cur.fetchone()
        if not row:
            return None
        plugin = _row_to_dict(row)

        cur = await db.execute(
            "SELECT * FROM plugin_components WHERE plugin_id = ? ORDER BY order_index, name",
            (plugin_id,),
        )
        comps = await cur.fetchall()
        plugin["components"] = [_component_to_dict(c) for c in comps]
        return plugin
    finally:
        await db.close()


def _row_to_dict(row) -> dict[str, Any]:
    d = dict(row)
    for key in ("categories", "tags", "skipped_components"):
        if d.get(key):
            try:
                d[key] = json.loads(d[key])
            except (json.JSONDecodeError, TypeError):
                d[key] = []
        else:
            d[key] = []
    return d


def _component_to_dict(row) -> dict[str, Any]:
    d = dict(row)
    if d.get("permissions"):
        try:
            d["permissions"] = json.loads(d["permissions"])
        except (json.JSONDecodeError, TypeError):
            d["permissions"] = []
    else:
        d["permissions"] = []
    return d


async def install_plugin(plugin_id: str, *, skip_scripts: bool = False) -> dict[str, Any]:
    """Install a plugin from its registry catalog entry.

    Fetches the full package from package_url, stores all components in
    plugin_components, and flips installed=1.
    """
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM plugins WHERE id = ?", (plugin_id,))
        row = await cur.fetchone()
        if not row:
            return {"ok": False, "error": "plugin not found"}
        if row["installed"]:
            return {"ok": False, "error": "already installed"}
        package_url = row["package_url"]
    finally:
        await db.close()

    if not package_url:
        return {"ok": False, "error": "no package_url for this plugin"}

    try:
        package = await fetch_plugin_package(package_url)
    except RegistryError as e:
        return {"ok": False, "error": str(e)}

    components = package.get("components") or []
    skipped: list[str] = []

    db = await get_db()
    try:
        # Replace any existing components (in case of reinstall)
        await db.execute("DELETE FROM plugin_components WHERE plugin_id = ?", (plugin_id,))

        for idx, comp in enumerate(components):
            comp_type = comp.get("type", "guideline")
            if comp_type == "script" and skip_scripts:
                skipped.append(comp.get("id") or comp.get("name", ""))
                continue
            cid = comp.get("id") or str(uuid.uuid4())
            activation = comp.get("activation", "always")
            await db.execute(
                """INSERT INTO plugin_components
                   (id, plugin_id, type, name, description, content, activation,
                    trigger, permissions, ai_explanation, risk_level, skippable,
                    order_index)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    cid,
                    plugin_id,
                    comp_type,
                    comp.get("name", "(unnamed)"),
                    comp.get("description", ""),
                    comp.get("content", ""),
                    activation,
                    comp.get("trigger"),
                    json.dumps(comp.get("permissions") or []),
                    comp.get("ai_explanation"),
                    comp.get("risk_level"),
                    1 if comp.get("skippable", True) else 0,
                    idx,
                ),
            )

        await db.execute(
            """UPDATE plugins
               SET installed = 1,
                   installed_at = datetime('now'),
                   scripts_approved = ?,
                   skipped_components = ?,
                   package_data = ?,
                   updated_at = datetime('now')
               WHERE id = ?""",
            (
                0 if skip_scripts else 1,
                json.dumps(skipped),
                json.dumps(package),
                plugin_id,
            ),
        )
        await db.commit()

        # Write on_demand components to disk as SKILL.md files
        on_demand = [c for c in components if c.get("activation") == "on_demand"
                     and c.get("type") == "guideline" and c.get("content")]
        if on_demand:
            from skill_installer import install_skill
            for comp in on_demand:
                name = comp.get("name", "unnamed")
                content = comp["content"]
                desc = comp.get("description", "")
                # Build SKILL.md with frontmatter
                skill_md = f"---\nname: {name}\ndescription: {desc}\n---\n\n{content}"
                try:
                    await install_skill(
                        name=name, content=skill_md,
                        cli_types=["claude", "gemini"], scope="user",
                    )
                except Exception as e:
                    log.warning("Failed to write on_demand skill %s to disk: %s", name, e)

        # Export as native plugin/extension to both CLIs
        try:
            from plugin_exporter import PluginExporter
            exporter = PluginExporter()

            # Fetch full plugin record for the exporter
            cur_p = await db.execute("SELECT * FROM plugins WHERE id = ?", (plugin_id,))
            plugin_row = dict(await cur_p.fetchone())

            from cli_profiles import PROFILES
            import os as _os
            dests = {}
            for cli_id, prof in PROFILES.items():
                cache_dir = Path(_os.path.expanduser(prof.plugin_cache_dir))
                # Use plugin_id for unique subdir, fall back to name for CLIs
                # that use name-based dirs (e.g. Gemini extensions)
                subdir = plugin_id if cli_id == "claude" else plugin_row.get("name", plugin_id)
                dests[cli_id] = cache_dir / subdir
            await exporter.export_to_both(
                plugin=plugin_row,
                components=components,
                claude_dest=dests.get("claude", Path.home() / ".claude" / "plugins" / "cache" / plugin_id),
                gemini_dest=dests.get("gemini", Path.home() / ".gemini" / "extensions" / plugin_row.get("name", plugin_id)),
            )
        except Exception as e:
            log.warning("Failed to export plugin %s to native format: %s", plugin_id, e)

        return {"ok": True, "plugin_id": plugin_id, "skipped": skipped}
    finally:
        await db.close()


async def uninstall_plugin(plugin_id: str) -> bool:
    """Uninstall a plugin. If it came from a registry, the catalog row is
    preserved (flip installed back to 0); if it was sideloaded, the row
    is deleted entirely. Components are deleted either way."""
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT registry_id, package_url FROM plugins WHERE id = ?", (plugin_id,)
        )
        row = await cur.fetchone()
        if not row:
            return False

        # Remove on_demand skills from disk before deleting components
        cur_od = await db.execute(
            """SELECT name FROM plugin_components
               WHERE plugin_id = ? AND type = 'guideline'
                 AND COALESCE(activation, 'always') = 'on_demand'""",
            (plugin_id,),
        )
        on_demand_names = [r["name"] for r in await cur_od.fetchall()]
        if on_demand_names:
            from skill_installer import uninstall_skill
            for name in on_demand_names:
                try:
                    await uninstall_skill(name=name, cli_types=["claude", "gemini"], scope="user")
                except Exception as e:
                    log.warning("Failed to remove on_demand skill %s from disk: %s", name, e)

        # Remove native exports
        try:
            from plugin_exporter import PluginExporter
            from cli_profiles import PROFILES
            import os as _os
            exporter = PluginExporter()
            # Get plugin name for name-based cache dirs (e.g. Gemini extensions)
            cur_name = await db.execute("SELECT name FROM plugins WHERE id = ?", (plugin_id,))
            name_row = await cur_name.fetchone()
            plugin_name = name_row["name"] if name_row else plugin_id
            for cli_id, prof in PROFILES.items():
                cache_dir = Path(_os.path.expanduser(prof.plugin_cache_dir))
                subdir = plugin_id if cli_id == "claude" else plugin_name
                await exporter.remove_export(cache_dir / subdir)
        except Exception as e:
            log.warning("Failed to remove native exports for %s: %s", plugin_id, e)

        await db.execute(
            "DELETE FROM plugin_components WHERE plugin_id = ?", (plugin_id,)
        )

        if row["registry_id"] and row["package_url"]:
            # Came from a registry — keep catalog row, just flip flag.
            await db.execute(
                """UPDATE plugins
                   SET installed = 0, installed_at = NULL,
                       scripts_approved = 0, skipped_components = NULL,
                       package_data = NULL, updated_at = datetime('now')
                   WHERE id = ?""",
                (plugin_id,),
            )
        else:
            # Sideloaded plugin — remove entirely.
            await db.execute("DELETE FROM plugins WHERE id = ?", (plugin_id,))

        await db.commit()
        return True
    finally:
        await db.close()


# ─── Session attachment ──────────────────────────────────────────────────


async def get_session_components(session_id: str) -> list[dict[str, Any]]:
    """List plugin components attached to a session."""
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT pc.*, p.name AS plugin_name
               FROM plugin_components pc
               JOIN session_plugin_components spc ON pc.id = spc.component_id
               JOIN plugins p ON p.id = pc.plugin_id
               WHERE spc.session_id = ?""",
            (session_id,),
        )
        rows = await cur.fetchall()
        return [_component_to_dict(r) for r in rows]
    finally:
        await db.close()


async def set_session_components(session_id: str, component_ids: list[str]) -> int:
    """Replace the set of plugin components attached to a session."""
    db = await get_db()
    try:
        await db.execute(
            "DELETE FROM session_plugin_components WHERE session_id = ?", (session_id,)
        )
        for cid in component_ids:
            await db.execute(
                "INSERT OR IGNORE INTO session_plugin_components (session_id, component_id) VALUES (?, ?)",
                (session_id, cid),
            )
        await db.commit()
        return len(component_ids)
    finally:
        await db.close()
