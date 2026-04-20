"""Disk-based skill installation.

Skills are written to the CLI's native skill directories so they're
auto-discovered by Claude Code and Gemini CLI without any system prompt
injection.

Paths:
  Claude project:  <workspace>/.claude/skills/<name>/SKILL.md
  Claude user:     ~/.claude/skills/<name>/SKILL.md
  Gemini project:  <workspace>/.gemini/skills/<name>/SKILL.md
  Gemini user:     ~/.gemini/skills/<name>/SKILL.md
"""

import logging
import os
import re
import shutil
from pathlib import Path

import aiohttp

from cli_features import Feature
from cli_profiles import PROFILES, get_profile

log = logging.getLogger(__name__)

GITHUB_RAW = "https://raw.githubusercontent.com"
GITHUB_API = "https://api.github.com"

# Backward-compat alias — derived from profiles now.
SKILL_DIRS = {p.id: p.binding(Feature.SKILLS_DIR).file_path
              for p in PROFILES.values()
              if p.binding(Feature.SKILLS_DIR)}


def _skill_base(cli_type: str, workspace_path: str | None, scope: str) -> Path:
    """Return the base skills directory for a CLI + scope combo."""
    profile = get_profile(cli_type)
    binding = profile.binding(Feature.SKILLS_DIR)
    subdir = binding.file_path if binding else ".claude/skills"
    if scope == "user":
        return Path.home() / subdir
    if not workspace_path:
        raise ValueError("workspace_path required for project-scope skills")
    return Path(workspace_path) / subdir


def _slugify(name: str) -> str:
    """Convert a skill name to a valid directory name."""
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9-]", "-", slug)
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug or "unnamed-skill"


async def install_skill(
    name: str,
    content: str,
    workspace_path: str | None = None,
    cli_types: list[str] | None = None,
    scope: str = "project",
    source_url: str = "",
    repo: str = "",
    skill_path: str = "",
) -> dict:
    """Write a skill to disk for the specified CLI(s).

    Args:
        name: Skill name (used for directory name)
        content: Full SKILL.md content (frontmatter + body)
        workspace_path: Workspace directory (required for project scope)
        cli_types: List of CLIs to install for (default: both)
        scope: "project" or "user"
        source_url: GitHub URL for attribution
        repo: GitHub repo (owner/name) for downloading full folder
        skill_path: Path within the repo for downloading extra files

    Returns:
        dict with install status per CLI
    """
    if cli_types is None:
        cli_types = ["claude", "gemini"]

    slug = _slugify(name)
    results = {}

    for cli in cli_types:
        try:
            base = _skill_base(cli, workspace_path, scope)
            skill_dir = base / slug
            skill_dir.mkdir(parents=True, exist_ok=True)

            # Write SKILL.md
            (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

            # Try to download additional files (scripts/, references/, assets/)
            if repo and skill_path:
                await _download_skill_extras(repo, skill_path, skill_dir)

            results[cli] = {"ok": True, "path": str(skill_dir)}
            log.info("Installed skill '%s' for %s at %s", name, cli, skill_dir)
        except Exception as e:
            results[cli] = {"ok": False, "error": str(e)}
            log.warning("Failed to install skill '%s' for %s: %s", name, cli, e)

    return results


async def uninstall_skill(
    name: str,
    workspace_path: str | None = None,
    cli_types: list[str] | None = None,
    scope: str = "project",
) -> dict:
    """Remove a skill from disk for the specified CLI(s)."""
    if cli_types is None:
        cli_types = ["claude", "gemini"]

    slug = _slugify(name)
    results = {}

    for cli in cli_types:
        try:
            base = _skill_base(cli, workspace_path, scope)
            skill_dir = base / slug
            if skill_dir.exists():
                shutil.rmtree(skill_dir)
                results[cli] = {"ok": True, "removed": True}
                log.info("Uninstalled skill '%s' for %s", name, cli)
            else:
                results[cli] = {"ok": True, "removed": False}
        except Exception as e:
            results[cli] = {"ok": False, "error": str(e)}
            log.warning("Failed to uninstall skill '%s' for %s: %s", name, cli, e)

    return results


def list_installed_skills(
    workspace_path: str | None = None,
    scope: str = "project",
) -> list[dict]:
    """Scan disk for installed skills across all CLIs.

    Returns a list of skill dicts with name, path, installed_for (which CLIs),
    and parsed frontmatter.
    """
    skills_by_name = {}  # slug → skill dict

    for cli in PROFILES:
        try:
            base = _skill_base(cli, workspace_path, scope)
            if not base.exists():
                continue

            for skill_dir in sorted(base.iterdir()):
                if not skill_dir.is_dir():
                    continue
                skill_md = skill_dir / "SKILL.md"
                if not skill_md.exists():
                    continue

                slug = skill_dir.name
                if slug not in skills_by_name:
                    # Parse frontmatter
                    text = skill_md.read_text(encoding="utf-8", errors="replace")
                    meta = _parse_frontmatter_meta(text)
                    has_scripts = (skill_dir / "scripts").is_dir()
                    has_references = (skill_dir / "references").is_dir()

                    skills_by_name[slug] = {
                        "slug": slug,
                        "name": meta.get("name", slug),
                        "description": meta.get("description", ""),
                        "license": meta.get("license", ""),
                        "compatibility": meta.get("compatibility", ""),
                        "has_scripts": has_scripts,
                        "has_references": has_references,
                        "installed_for": [],
                        "scope": scope,
                    }

                skills_by_name[slug]["installed_for"].append(cli)
        except Exception as e:
            log.warning("Failed to scan %s skills: %s", cli, e)

    return list(skills_by_name.values())


async def sync_skill(
    name: str,
    from_cli: str,
    to_cli: str,
    workspace_path: str | None = None,
    scope: str = "project",
) -> dict:
    """Copy a skill from one CLI's directory to another."""
    slug = _slugify(name)

    src_base = _skill_base(from_cli, workspace_path, scope)
    dst_base = _skill_base(to_cli, workspace_path, scope)

    src_dir = src_base / slug
    dst_dir = dst_base / slug

    if not src_dir.exists():
        return {"ok": False, "error": f"Skill '{name}' not found for {from_cli}"}

    try:
        if dst_dir.exists():
            shutil.rmtree(dst_dir)
        shutil.copytree(src_dir, dst_dir)
        log.info("Synced skill '%s' from %s to %s", name, from_cli, to_cli)
        return {"ok": True, "path": str(dst_dir)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _parse_frontmatter_meta(text: str) -> dict:
    """Quick frontmatter parse — just metadata, no body."""
    m = re.match(r"^---\s*\n(.*?)\n---", text, re.DOTALL)
    if not m:
        return {}
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
    return meta


async def _download_skill_extras(repo: str, skill_path: str, dest_dir: Path):
    """Download scripts/, references/, assets/ from GitHub if they exist."""
    try:
        async with aiohttp.ClientSession() as session:
            url = f"{GITHUB_API}/repos/{repo}/git/trees/main?recursive=1"
            async with session.get(
                url, headers={"Accept": "application/vnd.github.v3+json"}
            ) as resp:
                if resp.status != 200:
                    return
                data = await resp.json()

            prefix = skill_path + "/"
            for item in data.get("tree", []):
                if item["type"] != "blob":
                    continue
                if not item["path"].startswith(prefix):
                    continue
                rel = item["path"][len(prefix):]
                # Skip SKILL.md (already written)
                if rel == "SKILL.md":
                    continue
                # Only download from known subdirs
                if not any(rel.startswith(d) for d in ("scripts/", "references/", "assets/")):
                    continue

                raw_url = f"{GITHUB_RAW}/{repo}/main/{item['path']}"
                async with session.get(raw_url) as resp2:
                    if resp2.status != 200:
                        continue
                    content = await resp2.read()

                out_path = dest_dir / rel
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_bytes(content)

                # Make scripts executable
                if rel.startswith("scripts/"):
                    out_path.chmod(0o755)

                log.info("Downloaded extra: %s", rel)
    except Exception as e:
        log.warning("Failed to download extras for %s: %s", skill_path, e)
