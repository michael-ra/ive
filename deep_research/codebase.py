"""Quick codebase profiler — generates architecture context for Investigator & Aligner.

No LLM needed. Reads directory structure, config files, and git history
to build a markdown profile that grounds research against codebase reality.
"""

from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

# Files that reveal architecture decisions
CONFIG_FILES = [
    "package.json", "pyproject.toml", "setup.py", "setup.cfg",
    "requirements.txt", "Pipfile", "Cargo.toml", "go.mod",
    "docker-compose.yml", "Dockerfile", "Makefile",
    "tsconfig.json", "vite.config.js", "vite.config.ts",
    "CLAUDE.md", ".env.template", ".env.example",
]

# Extensions to count for language breakdown
LANG_EXTENSIONS = {
    ".py": "Python", ".js": "JavaScript", ".ts": "TypeScript",
    ".jsx": "React JSX", ".tsx": "React TSX", ".go": "Go",
    ".rs": "Rust", ".java": "Java", ".rb": "Ruby", ".sql": "SQL",
}

IGNORE_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv",
    ".next", "dist", "build", ".cache", ".tox", "eggs",
}


def profile_codebase(root: str | Path, max_depth: int = 3) -> str:
    """Generate a markdown profile of the codebase at `root`."""
    root = Path(root).resolve()
    if not root.is_dir():
        return f"Error: {root} is not a directory"

    sections = [
        f"# Codebase Profile — {root.name}\n",
        _directory_tree(root, max_depth),
        _config_files(root),
        _language_breakdown(root),
        _git_context(root),
    ]
    return "\n\n".join(s for s in sections if s)


def _directory_tree(root: Path, max_depth: int) -> str:
    """Top-level directory tree."""
    lines = ["## Directory Structure\n", "```"]
    for item in sorted(root.iterdir()):
        if item.name.startswith(".") and item.name not in (".env.template",):
            continue
        if item.name in IGNORE_DIRS:
            continue
        if item.is_dir():
            lines.append(f"{item.name}/")
            if max_depth > 1:
                _walk_dir(item, lines, "  ", max_depth - 1)
        else:
            lines.append(item.name)
    lines.append("```")
    return "\n".join(lines)


def _walk_dir(path: Path, lines: list[str], indent: str, depth: int):
    try:
        children = sorted(path.iterdir())
    except PermissionError:
        return
    for item in children[:30]:  # cap per directory
        if item.name.startswith(".") or item.name in IGNORE_DIRS:
            continue
        if item.is_dir():
            lines.append(f"{indent}{item.name}/")
            if depth > 1:
                _walk_dir(item, lines, indent + "  ", depth - 1)
        else:
            lines.append(f"{indent}{item.name}")
    if len(children) > 30:
        lines.append(f"{indent}... ({len(children) - 30} more)")


def _config_files(root: Path) -> str:
    """Read key config files that reveal architecture."""
    sections = ["## Key Configuration Files\n"]
    found = False
    for name in CONFIG_FILES:
        path = root / name
        if path.exists() and path.is_file():
            found = True
            content = path.read_text(errors="replace")[:3000]
            sections.append(f"### {name}\n```\n{content}\n```")
    return "\n\n".join(sections) if found else ""


def _language_breakdown(root: Path) -> str:
    """Count files by language."""
    counts: dict[str, int] = {}
    total = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS and not d.startswith(".")]
        for f in filenames:
            ext = Path(f).suffix.lower()
            lang = LANG_EXTENSIONS.get(ext)
            if lang:
                counts[lang] = counts.get(lang, 0) + 1
                total += 1

    if not counts:
        return ""

    lines = ["## Language Breakdown\n", f"Total source files: {total}\n"]
    for lang, count in sorted(counts.items(), key=lambda x: -x[1]):
        pct = count / total * 100
        lines.append(f"- {lang}: {count} files ({pct:.0f}%)")
    return "\n".join(lines)


def _git_context(root: Path) -> str:
    """Recent git history and current state."""
    sections = ["## Git Context\n"]

    def _run(cmd: list[str]) -> str | None:
        try:
            r = subprocess.run(
                cmd, cwd=root, capture_output=True, text=True, timeout=10
            )
            return r.stdout.strip() if r.returncode == 0 else None
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return None

    # Current branch
    branch = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    if branch:
        sections.append(f"**Branch**: {branch}")

    # Recent commits
    log = _run(["git", "log", "--oneline", "-15"])
    if log:
        sections.append(f"### Recent Commits\n```\n{log}\n```")

    # Uncommitted changes summary
    diff_stat = _run(["git", "diff", "--stat", "HEAD"])
    if diff_stat:
        sections.append(f"### Uncommitted Changes\n```\n{diff_stat}\n```")

    return "\n\n".join(sections) if len(sections) > 1 else ""
