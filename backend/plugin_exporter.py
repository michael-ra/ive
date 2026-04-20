"""Plugin exporter — translates Commander canonical format to native CLI format.

Exports a Commander plugin (DB-backed) to native disk format so the CLI
discovers it natively:
  - Claude Code: ~/.claude/plugins/cache/{id}/ with .claude-plugin/plugin.json
  - Gemini CLI:  ~/.gemini/extensions/{name}/ with gemini-extension.json

The exporter handles:
  1. Manifest translation (deterministic field mapping)
  2. Hook event name translation (via cli_profiles.py maps)
  3. Hook compatibility classification (both / claude-only / gemini-only)
  4. MCP variable translation (${CLAUDE_PLUGIN_ROOT} ↔ ${extensionPath})
  5. Skills — copied as-is (100% portable via Agent Skills spec)
  6. Script commands — translated where possible, left as-is for cross-CLI
     fallback when no equivalent exists (both CLIs installed on system)
"""

import json
import logging
import re
import shutil
from pathlib import Path

from cli_features import Feature, HookEvent
from cli_profiles import CLAUDE_PROFILE, GEMINI_PROFILE

log = logging.getLogger(__name__)

# ─── Variable substitution maps ──────────────────────────────────────────

_VAR_MAPS = {
    ("claude", "gemini"): [
        ("${CLAUDE_PLUGIN_ROOT}", "${extensionPath}"),
        ("${CLAUDE_PLUGIN_DATA}", "${extensionPath}/data"),
    ],
    ("gemini", "claude"): [
        ("${extensionPath}", "${CLAUDE_PLUGIN_ROOT}"),
    ],
}

# ─── Profile lookup ──────────────────────────────────────────────────────

_PROFILES = {
    "claude": CLAUDE_PROFILE,
    "gemini": GEMINI_PROFILE,
}


def _get_profile(cli: str):
    return _PROFILES.get(cli, CLAUDE_PROFILE)


# ─── Hook compatibility classification ──────────────────────────────────

def classify_hook(trigger: str) -> dict:
    """Determine which CLIs support a given hook trigger.

    Args:
        trigger: Canonical event name (e.g., "turn_complete") or native name

    Returns:
        {
            "claude": bool,
            "gemini": bool,
            "both": bool,
            "canonical": str or None,
            "claude_name": str or None,
            "gemini_name": str or None,
        }
    """
    canonical = None

    # Try as canonical name first
    try:
        canonical = HookEvent(trigger)
    except ValueError:
        # Try as native name in either profile
        for profile in (CLAUDE_PROFILE, GEMINI_PROFILE):
            c = profile.canonical_hook(trigger)
            if c:
                canonical = c
                break

    if not canonical:
        return {
            "claude": False, "gemini": False, "both": False,
            "canonical": None, "claude_name": None, "gemini_name": None,
        }

    claude_name = CLAUDE_PROFILE.native_hook(canonical)
    gemini_name = GEMINI_PROFILE.native_hook(canonical)

    return {
        "claude": claude_name is not None,
        "gemini": gemini_name is not None,
        "both": claude_name is not None and gemini_name is not None,
        "canonical": canonical.value,
        "claude_name": claude_name,
        "gemini_name": gemini_name,
    }


def classify_plugin_hooks(components: list[dict]) -> dict:
    """Classify all hook components by CLI compatibility.

    Returns:
        {
            "both": [comp, ...],        # works in both CLIs
            "claude_only": [comp, ...],  # only fires in Claude
            "gemini_only": [comp, ...],  # only fires in Gemini
            "unknown": [comp, ...],      # unrecognized trigger
            "summary": {
                "total": int,
                "both": int,
                "claude_only": int,
                "gemini_only": int,
                "unknown": int,
            }
        }
    """
    result = {"both": [], "claude_only": [], "gemini_only": [], "unknown": []}

    scripts = [c for c in components if c.get("type") == "script"]
    for comp in scripts:
        trigger = comp.get("trigger", "")
        if not trigger:
            continue
        compat = classify_hook(trigger)
        if compat["both"]:
            result["both"].append(comp)
        elif compat["claude"] and not compat["gemini"]:
            result["claude_only"].append(comp)
        elif compat["gemini"] and not compat["claude"]:
            result["gemini_only"].append(comp)
        else:
            result["unknown"].append(comp)

    result["summary"] = {
        "total": sum(len(v) for v in result.values() if isinstance(v, list)),
        "both": len(result["both"]),
        "claude_only": len(result["claude_only"]),
        "gemini_only": len(result["gemini_only"]),
        "unknown": len(result["unknown"]),
    }
    return result


# ─── Manifest translation ───────────────────────────────────────────────

def _build_claude_manifest(plugin: dict) -> dict:
    """Commander plugin → Claude plugin.json."""
    manifest = {"name": plugin.get("name", "unnamed")}
    if plugin.get("version"):
        manifest["version"] = plugin["version"]
    if plugin.get("description"):
        manifest["description"] = plugin["description"]
    if plugin.get("author"):
        manifest["author"] = {"name": plugin["author"]}
    if plugin.get("source_url"):
        manifest["repository"] = plugin["source_url"]
    if plugin.get("license"):
        manifest["license"] = plugin["license"]
    cats = plugin.get("categories")
    if cats:
        if isinstance(cats, str):
            try:
                cats = json.loads(cats)
            except (json.JSONDecodeError, TypeError):
                cats = [cats]
        manifest["keywords"] = cats
    return manifest


def _build_gemini_manifest(plugin: dict) -> dict:
    """Commander plugin → gemini-extension.json."""
    manifest = {"name": plugin.get("name", "unnamed")}
    if plugin.get("version"):
        manifest["version"] = plugin["version"]
    if plugin.get("description"):
        manifest["description"] = plugin["description"]
    return manifest


# ─── Hook translation ────────────────────────────────────────────────────

def translate_hooks(hooks_data: dict, source_cli: str, target_cli: str) -> tuple[dict, list[str]]:
    """Translate hook event names between CLIs.

    Returns:
        (translated_hooks, warnings)
    """
    source_profile = _get_profile(source_cli)
    target_profile = _get_profile(target_cli)
    warnings = []
    translated = {}

    raw_hooks = hooks_data.get("hooks", hooks_data)
    if not isinstance(raw_hooks, dict):
        return {"hooks": {}}, ["hooks data is not a dict"]

    for event_name, matchers in raw_hooks.items():
        canonical = source_profile.canonical_hook(event_name)
        if not canonical:
            warnings.append(f"Unknown {source_cli} event: {event_name} (skipped)")
            continue

        target_name = target_profile.native_hook(canonical)
        if not target_name:
            warnings.append(
                f"Event {event_name} ({canonical.value}) not supported in {target_cli} (dropped)"
            )
            continue

        translated[target_name] = matchers

    return {"hooks": translated}, warnings


# ─── MCP variable translation ────────────────────────────────────────────

def translate_mcp_vars(text: str, source_cli: str, target_cli: str) -> str:
    """Substitute CLI-specific variables in MCP configs and scripts."""
    key = (source_cli, target_cli)
    for old, new in _VAR_MAPS.get(key, []):
        text = text.replace(old, new)
    return text


def translate_mcp_config(mcp_data: dict, source_cli: str, target_cli: str) -> dict:
    """Translate MCP server config variable references."""
    raw = json.dumps(mcp_data)
    translated = translate_mcp_vars(raw, source_cli, target_cli)
    return json.loads(translated)


# ─── Full export ─────────────────────────────────────────────────────────

class PluginExporter:
    """Export a Commander plugin to native CLI format on disk."""

    async def export(
        self,
        plugin: dict,
        components: list[dict],
        target_cli: str,
        dest: Path,
    ) -> dict:
        """Export a plugin to native format at dest.

        Only installs hooks that the target CLI actually supports.
        Returns a result with hooks_summary showing what was installed vs skipped.
        """
        if target_cli == "claude":
            return await self._export_claude(plugin, components, dest)
        elif target_cli == "gemini":
            return await self._export_gemini(plugin, components, dest)
        else:
            return {"ok": False, "error": f"Unknown target CLI: {target_cli}"}

    async def export_to_both(
        self,
        plugin: dict,
        components: list[dict],
        claude_dest: Path | None = None,
        gemini_dest: Path | None = None,
    ) -> dict:
        """Export to both CLIs, intelligently routing hooks.

        - Hooks supported by both CLIs → installed in both
        - Claude-only hooks → only installed in Claude export
        - Gemini-only hooks → only installed in Gemini export
        """
        classification = classify_plugin_hooks(components)
        results = {"hooks_classification": classification["summary"]}

        if claude_dest:
            # Claude gets: both + claude-only hooks
            claude_scripts = classification["both"] + classification["claude_only"]
            claude_components = [c for c in components if c.get("type") != "script"] + claude_scripts
            results["claude"] = await self.export(plugin, claude_components, "claude", claude_dest)

        if gemini_dest:
            # Gemini gets: both + gemini-only hooks
            gemini_scripts = classification["both"] + classification["gemini_only"]
            gemini_components = [c for c in components if c.get("type") != "script"] + gemini_scripts
            results["gemini"] = await self.export(plugin, gemini_components, "gemini", gemini_dest)

        return results

    async def _export_claude(self, plugin: dict, components: list[dict], dest: Path) -> dict:
        """Write as a Claude Code plugin."""
        warnings = []
        hooks_summary = {"installed": 0, "skipped": 0, "skipped_events": []}
        try:
            dest.mkdir(parents=True, exist_ok=True)

            # 1. Manifest
            manifest_dir = dest / ".claude-plugin"
            manifest_dir.mkdir(exist_ok=True)
            manifest = _build_claude_manifest(plugin)
            (manifest_dir / "plugin.json").write_text(
                json.dumps(manifest, indent=2), encoding="utf-8"
            )

            # 2. Skills (copy as-is)
            skills = [c for c in components if c.get("type") == "guideline" and c.get("activation") == "on_demand"]
            if skills:
                skills_dir = dest / "skills"
                skills_dir.mkdir(exist_ok=True)
                for skill in skills:
                    name = _slugify(skill.get("name", "unnamed"))
                    skill_dir = skills_dir / name
                    skill_dir.mkdir(exist_ok=True)
                    (skill_dir / "SKILL.md").write_text(
                        skill.get("content", ""), encoding="utf-8"
                    )

            # 3. Hooks — only install supported ones
            scripts = [c for c in components if c.get("type") == "script"]
            if scripts:
                hooks_json, hw, hs = self._components_to_hooks_json(scripts, "claude")
                warnings.extend(hw)
                hooks_summary = hs
                if hooks_json.get("hooks"):
                    hooks_dir = dest / "hooks"
                    hooks_dir.mkdir(exist_ok=True)
                    (hooks_dir / "hooks.json").write_text(
                        json.dumps(hooks_json, indent=2), encoding="utf-8"
                    )

            log.info("Exported plugin '%s' to Claude at %s", plugin.get("name"), dest)
            return {"ok": True, "path": str(dest), "warnings": warnings, "hooks_summary": hooks_summary}

        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def _export_gemini(self, plugin: dict, components: list[dict], dest: Path) -> dict:
        """Write as a Gemini CLI extension."""
        warnings = []
        hooks_summary = {"installed": 0, "skipped": 0, "skipped_events": []}
        try:
            dest.mkdir(parents=True, exist_ok=True)

            # 1. Manifest
            manifest = _build_gemini_manifest(plugin)
            (dest / "gemini-extension.json").write_text(
                json.dumps(manifest, indent=2), encoding="utf-8"
            )

            # 2. Skills (copy as-is)
            skills = [c for c in components if c.get("type") == "guideline" and c.get("activation") == "on_demand"]
            if skills:
                skills_dir = dest / "skills"
                skills_dir.mkdir(exist_ok=True)
                for skill in skills:
                    name = _slugify(skill.get("name", "unnamed"))
                    skill_dir = skills_dir / name
                    skill_dir.mkdir(exist_ok=True)
                    (skill_dir / "SKILL.md").write_text(
                        skill.get("content", ""), encoding="utf-8"
                    )

            # 3. Hooks — only install supported ones
            scripts = [c for c in components if c.get("type") == "script"]
            if scripts:
                hooks_json, hw, hs = self._components_to_hooks_json(scripts, "gemini")
                warnings.extend(hw)
                hooks_summary = hs
                if hooks_json.get("hooks"):
                    hooks_dir = dest / "hooks"
                    hooks_dir.mkdir(exist_ok=True)
                    (hooks_dir / "hooks.json").write_text(
                        json.dumps(hooks_json, indent=2), encoding="utf-8"
                    )

            log.info("Exported plugin '%s' to Gemini at %s", plugin.get("name"), dest)
            return {"ok": True, "path": str(dest), "warnings": warnings, "hooks_summary": hooks_summary}

        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _components_to_hooks_json(
        self, script_components: list[dict], target_cli: str
    ) -> tuple[dict, list[str], dict]:
        """Convert script components to native hooks.json format.

        Only includes hooks whose trigger is supported by the target CLI.
        Script commands are translated (variables/paths) where possible;
        CLI-specific commands are left as-is (cross-CLI fallback since both
        CLIs are installed on the system).

        Returns:
            (hooks_json, warnings, hooks_summary)
        """
        target_profile = _get_profile(target_cli)
        hooks = {}
        warnings = []
        installed = 0
        skipped = 0
        skipped_events = []

        for comp in script_components:
            trigger = comp.get("trigger", "")
            if not trigger:
                continue

            # Classify compatibility
            compat = classify_hook(trigger)

            if not compat[target_cli]:
                skipped += 1
                skipped_events.append(trigger)
                warnings.append(
                    f"Hook '{comp.get('name', '?')}' on {trigger} — "
                    f"{target_cli} doesn't support this event (skipped, "
                    f"will only fire in {'gemini' if target_cli == 'claude' else 'claude'})"
                )
                continue

            # Get native event name for target
            native_name = compat.get(f"{target_cli}_name") or trigger
            installed += 1

            if native_name not in hooks:
                hooks[native_name] = []

            # Translate variables in command content, but leave CLI commands as-is
            # (cross-CLI fallback — both CLIs are installed on the system)
            command = comp.get("content", "")
            for source_cli in ("claude", "gemini"):
                if source_cli != target_cli:
                    command = translate_mcp_vars(command, source_cli, target_cli)

            hook_entry = {"type": "command", "command": command}
            matcher = comp.get("description", "")

            hooks[native_name].append({
                "matcher": matcher,
                "hooks": [hook_entry],
            })

        summary = {
            "installed": installed,
            "skipped": skipped,
            "skipped_events": skipped_events,
        }
        return {"hooks": hooks}, warnings, summary

    async def remove_export(self, dest: Path) -> bool:
        """Remove an exported plugin directory."""
        try:
            if dest.exists():
                shutil.rmtree(dest)
                return True
        except Exception as e:
            log.warning("Failed to remove export at %s: %s", dest, e)
        return False


def _slugify(name: str) -> str:
    """Convert a name to a valid directory name."""
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9-]", "-", slug)
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug or "unnamed"
