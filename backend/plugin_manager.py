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
import os
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


class PluginUninstallError(RuntimeError):
    """A plugin uninstall could not complete without unsafe filesystem work."""


def _native_export_removal_plan(
    profiles, plugin_id: str, plugin_name: str
) -> list[tuple[str, Path, Path, Path]]:
    """Validate every profile cache before the uninstall mutates anything."""
    from plugin_exporter import PluginExportRemovalError, validate_export_removal

    plan: list[tuple[str, Path, Path, Path]] = []
    for profile in profiles:
        declared_cache = (profile.plugin_cache_dir or "").strip()
        if not declared_cache:
            raise PluginUninstallError(
                f"CLI profile '{profile.id}' has no declared plugin_cache_dir"
            )
        cache_root = Path(os.path.expanduser(declared_cache))
        if not cache_root.is_absolute():
            raise PluginUninstallError(
                f"CLI profile '{profile.id}' has a relative plugin_cache_dir: "
                f"{declared_cache}"
            )
        plugin_format = (profile.plugin_format or "").strip()
        if not plugin_format:
            logger.warning(
                "Plugin uninstall: CLI profile '%s' is unsupported for native export",
                profile.id,
            )
            continue
        declared_home = (profile.home_dir or "").strip()
        profile_home = Path(os.path.expanduser(declared_home))
        if not declared_home or not profile_home.is_absolute():
            raise PluginUninstallError(
                f"CLI profile '{profile.id}' has no absolute home_dir"
            )
        subdir = plugin_id if plugin_format == "claude" else plugin_name
        destination = cache_root / subdir
        try:
            validate_export_removal(cache_root, destination, profile_home)
        except PluginExportRemovalError as exc:
            raise PluginUninstallError(
                f"Unsafe plugin cache for CLI profile '{profile.id}': {exc}"
            ) from exc
        plan.append((profile.id, cache_root, destination, profile_home))
    return plan


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

        # Write on_demand components to every profile's declared native
        # skills directory.  Unsupported profiles remain visible in the
        # result instead of borrowing Claude's path.
        skill_exports: dict[str, list[dict[str, Any]]] = {}
        on_demand = [c for c in components if c.get("activation") == "on_demand"
                     and c.get("type") == "guideline" and c.get("content")]
        if on_demand:
            from skill_installer import install_skill
            from cli_profiles import active_profiles
            active_cli_types = [profile.id for profile in active_profiles()]
            for comp in on_demand:
                name = comp.get("name", "unnamed")
                content = comp["content"]
                desc = comp.get("description", "")
                # Build SKILL.md with frontmatter
                skill_md = f"---\nname: {name}\ndescription: {desc}\n---\n\n{content}"
                per_cli = await install_skill(
                    name=name, content=skill_md,
                    cli_types=active_cli_types, scope="user",
                )
                for cli_id, result in per_cli.items():
                    skill_exports.setdefault(cli_id, []).append({
                        "skill": name,
                        **result,
                    })

        # Export once per active profile using its declared native format and
        # cache location.  Missing metadata is an explicit unsupported result.
        from cli_profiles import active_profiles
        from plugin_exporter import PluginExporter

        exporter = PluginExporter()
        cur_p = await db.execute("SELECT * FROM plugins WHERE id = ?", (plugin_id,))
        plugin_row = dict(await cur_p.fetchone())
        native_exports: dict[str, dict[str, Any]] = {}
        for profile in active_profiles():
            plugin_format = (profile.plugin_format or "").strip()
            cache_dir = (profile.plugin_cache_dir or "").strip()
            if not plugin_format or not cache_dir:
                native_exports[profile.id] = {
                    "ok": False,
                    "status": "unsupported",
                    "error": "profile does not declare native plugin export metadata",
                }
                continue
            cache_root = Path(os.path.expanduser(cache_dir))
            if not cache_root.is_absolute():
                native_exports[profile.id] = {
                    "ok": False,
                    "status": "unsupported",
                    "error": "profile plugin cache is not absolute",
                }
                continue
            export_name = (
                plugin_id
                if plugin_format == "claude"
                else str(plugin_row.get("name") or plugin_id)
            )
            try:
                native_exports[profile.id] = await exporter.export(
                    plugin_row,
                    components,
                    plugin_format,
                    cache_root / export_name,
                )
            except Exception as exc:
                native_exports[profile.id] = {
                    "ok": False,
                    "status": "failed",
                    "error": str(exc),
                }

        failed_skill_exports = [
            (cli_id, result)
            for cli_id, results in skill_exports.items()
            for result in results
            if not result.get("ok")
        ]
        failed_native_exports = [
            cli_id for cli_id, result in native_exports.items()
            if not result.get("ok")
        ]
        complete = not failed_skill_exports and not failed_native_exports
        return {
            "ok": complete,
            "status": "installed" if complete else "partial",
            "installed": True,
            "plugin_id": plugin_id,
            "skipped": skipped,
            "skill_exports": skill_exports,
            "native_exports": native_exports,
        }
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

        # Preflight every recursive target before deleting any export, skill,
        # component, or catalog row. One unsafe profile aborts the uninstall.
        from cli_profiles import active_profiles
        from plugin_exporter import PluginExporter, PluginExportRemovalError

        cur_name = await db.execute("SELECT name FROM plugins WHERE id = ?", (plugin_id,))
        name_row = await cur_name.fetchone()
        plugin_name = name_row["name"] if name_row else plugin_id
        profiles = active_profiles()
        removal_plan = _native_export_removal_plan(profiles, plugin_id, plugin_name)

        exporter = PluginExporter()
        for profile_id, cache_root, destination, profile_home in removal_plan:
            try:
                await exporter.remove_export(
                    destination,
                    cache_root=cache_root,
                    profile_home=profile_home,
                )
            except PluginExportRemovalError as exc:
                raise PluginUninstallError(
                    f"Failed to remove native export for CLI profile "
                    f"'{profile_id}': {exc}"
                ) from exc

        # Remove on_demand skills only after native-export preflight/removal.
        cur_od = await db.execute(
            """SELECT name FROM plugin_components
               WHERE plugin_id = ? AND type = 'guideline'
                 AND COALESCE(activation, 'always') = 'on_demand'""",
            (plugin_id,),
        )
        on_demand_names = [r["name"] for r in await cur_od.fetchall()]
        if on_demand_names:
            from skill_installer import uninstall_skill
            active_cli_types = [profile.id for profile in profiles]
            for name in on_demand_names:
                try:
                    await uninstall_skill(name=name, cli_types=active_cli_types, scope="user")
                except Exception as e:
                    log.warning("Failed to remove on_demand skill %s from disk: %s", name, e)

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


async def get_session_components_from_db(
    db, session_id: str,
) -> list[dict[str, Any]]:
    """List attached components using a caller-owned DB connection.

    Composition/introspection endpoints often already hold a consistent read
    connection for the session and workspace rows.  Keeping this query in the
    plugin manager preserves the attachment seam without opening a second
    connection or duplicating its joins elsewhere.
    """
    cur = await db.execute(
        """SELECT pc.*, p.name AS plugin_name
           FROM plugin_components pc
           JOIN session_plugin_components spc ON pc.id = spc.component_id
           JOIN plugins p ON p.id = pc.plugin_id
           WHERE spc.session_id = ?
           ORDER BY p.name, pc.order_index, pc.name""",
        (session_id,),
    )
    rows = await cur.fetchall()
    return [_component_to_dict(r) for r in rows]


async def get_session_components(session_id: str) -> list[dict[str, Any]]:
    """List plugin components attached to a session."""
    db = await get_db()
    try:
        return await get_session_components_from_db(db, session_id)
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
