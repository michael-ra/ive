"""Plugin exporter — translates Commander canonical format to native CLI format.

Exports a Commander plugin (DB-backed) to native disk format so the CLI
discovers it natively:
  - Claude Code: ~/.claude/plugins/cache/{id}/ with .claude-plugin/plugin.json
  - Gemini CLI:  ~/.gemini/extensions/{name}/ with gemini-extension.json
  - Codex CLI:   ~/.codex/plugins/{name}/ with .codex-plugin/plugin.json

The exporter handles:
  1. Manifest translation (deterministic field mapping)
  2. Hook event name translation (via cli_profiles.py maps)
  3. Hook compatibility classification across registered CLI profiles
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

from cli_features import HookEvent
from cli_profiles import PROFILES, get_profile

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
    ("claude", "codex"): [
        ("${CLAUDE_PLUGIN_ROOT}", "${CODEX_PLUGIN_ROOT}"),
        ("${CLAUDE_PLUGIN_DATA}", "${CODEX_PLUGIN_ROOT}/data"),
        (".claude/skills/", ".agents/skills/"),
    ],
    ("codex", "claude"): [
        ("${CODEX_PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}"),
        (".agents/skills/", ".claude/skills/"),
    ],
    ("gemini", "codex"): [
        ("${extensionPath}", "${CODEX_PLUGIN_ROOT}"),
        (".gemini/skills/", ".agents/skills/"),
    ],
    ("codex", "gemini"): [
        ("${CODEX_PLUGIN_ROOT}", "${extensionPath}"),
        (".agents/skills/", ".gemini/skills/"),
    ],
}


# ─── Hook compatibility classification ──────────────────────────────────

def classify_hook(trigger: str) -> dict:
    """Determine which CLIs support a given hook trigger.

    Args:
        trigger: Canonical event name (e.g., "turn_complete") or native name

    Returns:
        {
            "claude": bool,
            "gemini": bool,
            "both": bool,  # backward-compatible Claude+Gemini support flag
            "canonical": str or None,
            "claude_name": str or None,
            "gemini_name": str or None,
            "codex_name": str or None,
        }
    """
    canonical = None

    # Try as canonical name first
    try:
        canonical = HookEvent(trigger)
    except ValueError:
        # Try as native name in either profile
        for profile in PROFILES.values():
            c = profile.canonical_hook(trigger)
            if c:
                canonical = c
                break

    if not canonical:
        result = {cli: False for cli in PROFILES}
        result.update({
            "both": False,
            "canonical": None,
            **{f"{cli}_name": None for cli in PROFILES},
        })
        return result

    native_names = {cli: profile.native_hook(canonical) for cli, profile in PROFILES.items()}
    result = {cli: native_names[cli] is not None for cli in PROFILES}
    result.update({
        "both": bool(result.get("claude") and result.get("gemini")),
        "canonical": canonical.value,
        **{f"{cli}_name": name for cli, name in native_names.items()},
    })
    return result


def classify_plugin_hooks(components: list[dict]) -> dict:
    """Classify all hook components by CLI compatibility.

    Returns:
        {
            "both": [comp, ...],        # works in both CLIs
            "claude_only": [comp, ...],  # only fires in Claude
            "gemini_only": [comp, ...],  # only fires in Gemini
            "codex_only": [comp, ...],   # only fires in Codex
            "unknown": [comp, ...],      # unrecognized trigger
            "summary": {
                "total": int,
                "both": int,
                "claude_only": int,
                "gemini_only": int,
                "codex_only": int,
                "unknown": int,
            }
        }
    """
    result = {
        "both": [],
        "claude_only": [],
        "gemini_only": [],
        "codex_only": [],
        "unknown": [],
    }

    scripts = [c for c in components if c.get("type") == "script"]
    for comp in scripts:
        trigger = comp.get("trigger", "")
        if not trigger:
            continue
        compat = classify_hook(trigger)
        if compat["both"]:
            result["both"].append(comp)
        else:
            supported = [cli for cli in PROFILES if compat.get(cli)]
            if len(supported) == 1 and f"{supported[0]}_only" in result:
                result[f"{supported[0]}_only"].append(comp)
            elif supported:
                result["both"].append(comp)
            else:
                result["unknown"].append(comp)

    result["summary"] = {
        "total": sum(len(v) for v in result.values() if isinstance(v, list)),
        "both": len(result["both"]),
        "claude_only": len(result["claude_only"]),
        "gemini_only": len(result["gemini_only"]),
        "codex_only": len(result["codex_only"]),
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


def _build_codex_manifest(plugin: dict, has_skills: bool = False,
                          has_hooks: bool = False) -> dict:
    """Commander plugin → Codex .codex-plugin/plugin.json."""
    manifest = {"name": _slugify(plugin.get("name", "unnamed"))}
    if plugin.get("version"):
        manifest["version"] = plugin["version"]
    if plugin.get("description"):
        manifest["description"] = plugin["description"]
    if plugin.get("author"):
        manifest["publisher"] = plugin["author"]
    if plugin.get("source_url"):
        manifest["repository"] = plugin["source_url"]
    if plugin.get("license"):
        manifest["license"] = plugin["license"]
    if has_skills:
        manifest["skills"] = "./skills/"
    if has_hooks:
        manifest["hooks"] = "./hooks/hooks.json"
    return manifest


# ─── Hook translation ────────────────────────────────────────────────────

def translate_hooks(hooks_data: dict, source_cli: str, target_cli: str) -> tuple[dict, list[str]]:
    """Translate hook event names between CLIs.

    Returns:
        (translated_hooks, warnings)
    """
    source_profile = get_profile(source_cli)
    target_profile = get_profile(target_cli)
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
        elif target_cli == "codex":
            return await self._export_codex(plugin, components, dest)
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

    async def _export_codex(self, plugin: dict, components: list[dict], dest: Path) -> dict:
        """Write as a Codex CLI plugin."""
        warnings = []
        hooks_summary = {"installed": 0, "skipped": 0, "skipped_events": []}
        try:
            dest.mkdir(parents=True, exist_ok=True)

            skills = [c for c in components if c.get("type") == "guideline" and c.get("activation") == "on_demand"]
            scripts = [c for c in components if c.get("type") == "script"]

            hooks_json = {"hooks": {}}
            if scripts:
                hooks_json, hw, hs = self._components_to_hooks_json(scripts, "codex")
                warnings.extend(hw)
                hooks_summary = hs

            manifest_dir = dest / ".codex-plugin"
            manifest_dir.mkdir(exist_ok=True)
            manifest = _build_codex_manifest(
                plugin,
                has_skills=bool(skills),
                has_hooks=bool(hooks_json.get("hooks")),
            )
            (manifest_dir / "plugin.json").write_text(
                json.dumps(manifest, indent=2), encoding="utf-8"
            )

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

            if hooks_json.get("hooks"):
                hooks_dir = dest / "hooks"
                hooks_dir.mkdir(exist_ok=True)
                (hooks_dir / "hooks.json").write_text(
                    json.dumps(hooks_json, indent=2), encoding="utf-8"
                )

            log.info("Exported plugin '%s' to Codex at %s", plugin.get("name"), dest)
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
        target_profile = get_profile(target_cli)
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
            # (cross-CLI fallback — multiple CLIs may be installed on the system)
            command = comp.get("content", "")
            for source_cli in PROFILES:
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
