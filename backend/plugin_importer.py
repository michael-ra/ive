"""Plugin importer — reads native CLI plugins and converts to Commander format.

Supports:
  - Claude Code plugins (.claude-plugin/plugin.json)
  - Gemini CLI extensions (gemini-extension.json)
  - Standalone skill folders (*/SKILL.md)
  - GitHub repos (auto-detect format)

Imported plugins are stored in Commander's DB and can then be exported
to either CLI format via plugin_exporter.py.
"""

import json
import logging
import re
import uuid
from pathlib import Path

import aiohttp

from cli_features import HookEvent
from cli_profiles import CLAUDE_PROFILE, GEMINI_PROFILE

log = logging.getLogger(__name__)

GITHUB_API = "https://api.github.com"
GITHUB_RAW = "https://raw.githubusercontent.com"


def _parse_skill_frontmatter(text: str) -> dict:
    """Extract YAML frontmatter from a SKILL.md file."""
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)", text, re.DOTALL)
    if not m:
        return {"body": text}
    meta = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        colon = line.find(":")
        if colon > 0:
            key = line[:colon].strip()
            val = line[colon + 1:].strip().strip('"').strip("'")
            if key != "metadata":
                meta[key] = val
    meta["body"] = m.group(2)
    return meta


class PluginImporter:
    """Import native CLI plugins into Commander's canonical format."""

    def detect_format(self, path: Path) -> str | None:
        """Auto-detect the plugin format at a path.

        Returns: "claude_plugin", "gemini_extension", "skills", or None
        """
        if (path / ".claude-plugin" / "plugin.json").exists():
            return "claude_plugin"
        if (path / ".claude-plugin").is_dir():
            return "claude_plugin"
        if (path / "gemini-extension.json").exists():
            return "gemini_extension"
        # Check for standalone skills
        if any(path.glob("*/SKILL.md")) or (path / "SKILL.md").exists():
            return "skills"
        return None

    async def import_from_path(self, path: Path) -> dict:
        """Auto-detect format and import.

        Returns:
            {"plugin": {db fields}, "components": [component dicts], "source_cli": str}
        """
        fmt = self.detect_format(path)
        if fmt == "claude_plugin":
            return await self.import_claude_plugin(path)
        elif fmt == "gemini_extension":
            return await self.import_gemini_extension(path)
        elif fmt == "skills":
            return await self.import_standalone_skills(path)
        else:
            raise ValueError(f"Unknown plugin format at {path}")

    async def import_from_github(self, repo: str, subpath: str = "") -> dict:
        """Download a repo/subpath from GitHub and import.

        Args:
            repo: "owner/name" GitHub repo
            subpath: Optional subdirectory within the repo
        """
        # Download the directory tree
        async with aiohttp.ClientSession() as session:
            url = f"{GITHUB_API}/repos/{repo}/git/trees/main?recursive=1"
            async with session.get(url, headers={"Accept": "application/vnd.github.v3+json"}) as resp:
                if resp.status != 200:
                    raise ValueError(f"GitHub API returned {resp.status}")
                tree_data = await resp.json()

            prefix = f"{subpath}/" if subpath else ""
            files = {}

            for item in tree_data.get("tree", []):
                if item["type"] != "blob":
                    continue
                if prefix and not item["path"].startswith(prefix):
                    continue
                rel_path = item["path"][len(prefix):] if prefix else item["path"]

                raw_url = f"{GITHUB_RAW}/{repo}/main/{item['path']}"
                async with session.get(raw_url) as resp:
                    if resp.status == 200:
                        files[rel_path] = await resp.text()

        # Detect format from downloaded files
        if ".claude-plugin/plugin.json" in files:
            return self._parse_claude_files(files, repo)
        elif "gemini-extension.json" in files:
            return self._parse_gemini_files(files, repo)
        else:
            # Check for skills
            skill_files = [k for k in files if k.endswith("/SKILL.md") or k == "SKILL.md"]
            if skill_files:
                return self._parse_skill_files(files, skill_files, repo)
            raise ValueError(f"No recognizable plugin format in {repo}/{subpath}")

    async def import_claude_plugin(self, path: Path) -> dict:
        """Parse a Claude Code plugin directory → Commander format."""
        # Read manifest
        manifest_path = path / ".claude-plugin" / "plugin.json"
        manifest = {}
        if manifest_path.exists():
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        plugin = {
            "id": f"imported-{str(uuid.uuid4())[:8]}",
            "name": manifest.get("name", path.name),
            "version": manifest.get("version", "0.0.0"),
            "description": manifest.get("description", ""),
            "author": manifest.get("author", {}).get("name", "") if isinstance(manifest.get("author"), dict) else manifest.get("author", ""),
            "license": manifest.get("license", ""),
            "source_url": manifest.get("repository", ""),
            "source_format": "claude_plugin",
            "categories": json.dumps(manifest.get("keywords", [])),
            "tags": "[]",
            "security_tier": 0,
            "contains_scripts": 0,
        }

        components = []

        # Skills → guideline components (on_demand)
        skills_dir = path / "skills"
        if skills_dir.is_dir():
            for skill_dir in sorted(skills_dir.iterdir()):
                if not skill_dir.is_dir():
                    continue
                skill_md = skill_dir / "SKILL.md"
                if skill_md.exists():
                    content = skill_md.read_text(encoding="utf-8", errors="replace")
                    meta = _parse_skill_frontmatter(content)
                    components.append({
                        "id": str(uuid.uuid4()),
                        "type": "guideline",
                        "activation": "on_demand",
                        "name": meta.get("name", skill_dir.name),
                        "description": meta.get("description", ""),
                        "content": content,
                    })

        # Hooks → script components
        hooks_file = path / "hooks" / "hooks.json"
        if hooks_file.exists():
            hooks_data = json.loads(hooks_file.read_text(encoding="utf-8"))
            hook_comps = self._hooks_to_components(hooks_data, "claude")
            components.extend(hook_comps)
            if hook_comps:
                plugin["contains_scripts"] = 1

        return {"plugin": plugin, "components": components, "source_cli": "claude"}

    async def import_gemini_extension(self, path: Path) -> dict:
        """Parse a Gemini CLI extension directory → Commander format."""
        manifest_path = path / "gemini-extension.json"
        manifest = {}
        if manifest_path.exists():
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        plugin = {
            "id": f"imported-{str(uuid.uuid4())[:8]}",
            "name": manifest.get("name", path.name),
            "version": manifest.get("version", "0.0.0"),
            "description": manifest.get("description", ""),
            "author": "",
            "license": "",
            "source_url": "",
            "source_format": "gemini_extension",
            "categories": "[]",
            "tags": "[]",
            "security_tier": 0,
            "contains_scripts": 0,
        }

        components = []

        # Skills
        skills_dir = path / "skills"
        if skills_dir.is_dir():
            for skill_dir in sorted(skills_dir.iterdir()):
                if not skill_dir.is_dir():
                    continue
                skill_md = skill_dir / "SKILL.md"
                if skill_md.exists():
                    content = skill_md.read_text(encoding="utf-8", errors="replace")
                    meta = _parse_skill_frontmatter(content)
                    components.append({
                        "id": str(uuid.uuid4()),
                        "type": "guideline",
                        "activation": "on_demand",
                        "name": meta.get("name", skill_dir.name),
                        "description": meta.get("description", ""),
                        "content": content,
                    })

        # Hooks
        hooks_file = path / "hooks" / "hooks.json"
        if hooks_file.exists():
            hooks_data = json.loads(hooks_file.read_text(encoding="utf-8"))
            hook_comps = self._hooks_to_components(hooks_data, "gemini")
            components.extend(hook_comps)
            if hook_comps:
                plugin["contains_scripts"] = 1

        return {"plugin": plugin, "components": components, "source_cli": "gemini"}

    async def import_standalone_skills(self, path: Path) -> dict:
        """Import a directory of standalone SKILL.md files."""
        plugin = {
            "id": f"imported-{str(uuid.uuid4())[:8]}",
            "name": path.name,
            "version": "1.0.0",
            "description": f"Skills imported from {path.name}",
            "source_format": "skill_md",
            "categories": '["Skills"]',
            "tags": "[]",
            "security_tier": 0,
            "contains_scripts": 0,
        }

        components = []
        # Check for SKILL.md directly or in subdirs
        for skill_md in sorted(path.rglob("SKILL.md")):
            content = skill_md.read_text(encoding="utf-8", errors="replace")
            meta = _parse_skill_frontmatter(content)
            components.append({
                "id": str(uuid.uuid4()),
                "type": "guideline",
                "activation": "on_demand",
                "name": meta.get("name", skill_md.parent.name),
                "description": meta.get("description", ""),
                "content": content,
            })

        return {"plugin": plugin, "components": components, "source_cli": None}

    def _hooks_to_components(self, hooks_data: dict, source_cli: str) -> list[dict]:
        """Convert a hooks.json structure to Commander script components.

        Translates native event names to canonical HookEvent values.
        """
        profile = CLAUDE_PROFILE if source_cli == "claude" else GEMINI_PROFILE
        components = []

        for event_name, matchers in hooks_data.get("hooks", {}).items():
            canonical = profile.canonical_hook(event_name)
            trigger = canonical.value if canonical else event_name

            for matcher_group in matchers:
                matcher = matcher_group.get("matcher", "")
                for hook in matcher_group.get("hooks", []):
                    hook_type = hook.get("type", "command")
                    content = hook.get("command", "") or hook.get("prompt", "") or hook.get("url", "")
                    if not content:
                        continue

                    components.append({
                        "id": str(uuid.uuid4()),
                        "type": "script",
                        "trigger": trigger,
                        "name": f"{event_name}-{matcher or 'all'}",
                        "description": matcher,
                        "content": content,
                        "risk_level": "medium" if hook_type == "command" else "low",
                    })

        return components

    def _parse_claude_files(self, files: dict, repo: str) -> dict:
        """Parse downloaded Claude plugin files into Commander format."""
        manifest = json.loads(files.get(".claude-plugin/plugin.json", "{}"))

        plugin = {
            "id": f"imported-{str(uuid.uuid4())[:8]}",
            "name": manifest.get("name", repo.split("/")[-1]),
            "version": manifest.get("version", "0.0.0"),
            "description": manifest.get("description", ""),
            "author": manifest.get("author", {}).get("name", "") if isinstance(manifest.get("author"), dict) else str(manifest.get("author", "")),
            "source_url": f"https://github.com/{repo}",
            "source_format": "claude_plugin",
            "categories": json.dumps(manifest.get("keywords", [])),
            "tags": "[]",
            "security_tier": 0,
            "contains_scripts": 0,
        }

        components = []

        # Skills
        for path, content in files.items():
            if path.startswith("skills/") and path.endswith("/SKILL.md"):
                meta = _parse_skill_frontmatter(content)
                name = path.split("/")[-2]
                components.append({
                    "id": str(uuid.uuid4()),
                    "type": "guideline",
                    "activation": "on_demand",
                    "name": meta.get("name", name),
                    "description": meta.get("description", ""),
                    "content": content,
                })

        # Hooks
        hooks_raw = files.get("hooks/hooks.json")
        if hooks_raw:
            hooks_data = json.loads(hooks_raw)
            hook_comps = self._hooks_to_components(hooks_data, "claude")
            components.extend(hook_comps)
            if hook_comps:
                plugin["contains_scripts"] = 1

        return {"plugin": plugin, "components": components, "source_cli": "claude"}

    def _parse_gemini_files(self, files: dict, repo: str) -> dict:
        """Parse downloaded Gemini extension files into Commander format."""
        manifest = json.loads(files.get("gemini-extension.json", "{}"))

        plugin = {
            "id": f"imported-{str(uuid.uuid4())[:8]}",
            "name": manifest.get("name", repo.split("/")[-1]),
            "version": manifest.get("version", "0.0.0"),
            "description": manifest.get("description", ""),
            "source_url": f"https://github.com/{repo}",
            "source_format": "gemini_extension",
            "categories": "[]",
            "tags": "[]",
            "security_tier": 0,
            "contains_scripts": 0,
        }

        components = []

        for path, content in files.items():
            if path.startswith("skills/") and path.endswith("/SKILL.md"):
                meta = _parse_skill_frontmatter(content)
                name = path.split("/")[-2]
                components.append({
                    "id": str(uuid.uuid4()),
                    "type": "guideline",
                    "activation": "on_demand",
                    "name": meta.get("name", name),
                    "description": meta.get("description", ""),
                    "content": content,
                })

        hooks_raw = files.get("hooks/hooks.json")
        if hooks_raw:
            hooks_data = json.loads(hooks_raw)
            hook_comps = self._hooks_to_components(hooks_data, "gemini")
            components.extend(hook_comps)
            if hook_comps:
                plugin["contains_scripts"] = 1

        return {"plugin": plugin, "components": components, "source_cli": "gemini"}

    def _parse_skill_files(self, files: dict, skill_paths: list[str], repo: str) -> dict:
        """Parse standalone skill files into Commander format."""
        plugin = {
            "id": f"imported-{str(uuid.uuid4())[:8]}",
            "name": repo.split("/")[-1],
            "version": "1.0.0",
            "description": f"Skills from {repo}",
            "source_url": f"https://github.com/{repo}",
            "source_format": "skill_md",
            "categories": '["Skills"]',
            "tags": "[]",
            "security_tier": 0,
            "contains_scripts": 0,
        }

        components = []
        for path in skill_paths:
            content = files.get(path, "")
            meta = _parse_skill_frontmatter(content)
            parts = path.rsplit("/SKILL.md", 1)
            name = parts[0].split("/")[-1] if parts[0] else "unnamed"
            components.append({
                "id": str(uuid.uuid4()),
                "type": "guideline",
                "activation": "on_demand",
                "name": meta.get("name", name),
                "description": meta.get("description", ""),
                "content": content,
            })

        return {"plugin": plugin, "components": components, "source_cli": None}
