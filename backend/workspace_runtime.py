"""Workspace runtime/toolchain detection for agent test guidance.

The detector is intentionally static: it reads project files and existing
environment markers but does not run installers or version probes. Startup and
tester prompt injection should never block on package managers or network.
"""

from __future__ import annotations

import json
import os
import shlex
import fnmatch
from pathlib import Path
from typing import Any


SKIP_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".tox",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "target",
    "vendor",
    "ext-repo",
}


def _safe_path(raw: str | os.PathLike[str] | None) -> Path | None:
    if not raw:
        return None
    try:
        return Path(raw).expanduser().resolve()
    except Exception:
        return None


def _shell_path(path: Path, root: Path | None = None) -> str:
    try:
        if root:
            rel = path.relative_to(root)
            text = "." if not rel.parts else f"./{rel.as_posix()}"
            return shlex.quote(text)
    except ValueError:
        pass

    home = Path.home().resolve()
    try:
        rel_home = path.relative_to(home)
        text = f"$HOME/{rel_home.as_posix()}"
        if " " not in text and "'" not in text:
            return text
    except ValueError:
        pass

    return shlex.quote(str(path))


def _rel_dir(path: Path, root: Path) -> str:
    try:
        rel = path.relative_to(root)
        return "." if not rel.parts else rel.as_posix()
    except ValueError:
        return str(path)


def _find_files(root: Path, filename: str, *, max_depth: int = 3) -> list[Path]:
    found: list[Path] = []

    def walk(directory: Path, depth: int) -> None:
        if depth > max_depth:
            return
        try:
            entries = list(directory.iterdir())
        except OSError:
            return
        for entry in entries:
            if entry.name in SKIP_DIRS:
                continue
            if entry.is_file() and entry.name == filename:
                found.append(entry)
            elif entry.is_dir():
                walk(entry, depth + 1)

    walk(root, 0)
    found.sort(key=lambda p: (_rel_dir(p.parent, root), p.name))
    return found


def _find_matching_files(root: Path, patterns: tuple[str, ...], *, max_depth: int = 3) -> list[Path]:
    found: list[Path] = []

    def walk(directory: Path, depth: int) -> None:
        if depth > max_depth:
            return
        try:
            entries = list(directory.iterdir())
        except OSError:
            return
        for entry in entries:
            if entry.name in SKIP_DIRS:
                continue
            if entry.is_file() and any(fnmatch.fnmatch(entry.name, pattern) for pattern in patterns):
                found.append(entry)
            elif entry.is_dir():
                walk(entry, depth + 1)

    walk(root, 0)
    found.sort(key=lambda p: (_rel_dir(p, root), p.name))
    return found


def _has_any(root: Path, names: tuple[str, ...]) -> bool:
    return any((root / name).exists() for name in names)


def _load_package_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _package_manager(project_dir: Path) -> str:
    if (project_dir / "pnpm-lock.yaml").exists():
        return "pnpm"
    if (project_dir / "yarn.lock").exists():
        return "yarn"
    if (project_dir / "bun.lockb").exists() or (project_dir / "bun.lock").exists():
        return "bun"
    if (project_dir / "package-lock.json").exists() or (project_dir / "npm-shrinkwrap.json").exists():
        return "npm"
    return "npm"


def _pkg_run(pm: str, project_dir: str, script: str) -> str:
    quoted_dir = shlex.quote(project_dir)
    if project_dir == ".":
        if pm == "yarn":
            return f"yarn run {script}"
        return f"{pm} run {script}"
    if pm == "npm":
        return f"npm --prefix {quoted_dir} run {script}"
    if pm == "pnpm":
        return f"pnpm --dir {quoted_dir} run {script}"
    if pm == "yarn":
        return f"yarn --cwd {quoted_dir} run {script}"
    if pm == "bun":
        return f"bun --cwd {quoted_dir} run {script}"
    return f"{pm} --prefix {quoted_dir} run {script}"


def _pkg_install(pm: str, project_dir: str) -> str:
    quoted_dir = shlex.quote(project_dir)
    if project_dir == ".":
        return f"{pm} install" if pm != "yarn" else "yarn install"
    if pm == "npm":
        return f"npm --prefix {quoted_dir} install"
    if pm == "pnpm":
        return f"pnpm --dir {quoted_dir} install"
    if pm == "yarn":
        return f"yarn --cwd {quoted_dir} install"
    if pm == "bun":
        return f"bun --cwd {quoted_dir} install"
    return f"{pm} --prefix {quoted_dir} install"


def _script_for(scripts: dict[str, Any], kind: str) -> str | None:
    if kind in scripts:
        return kind
    suffix = f":{kind}"
    matches = sorted(k for k in scripts if k.endswith(suffix))
    return matches[0] if matches else None


def _detect_python(root: Path) -> dict[str, Any] | None:
    project_markers = (
        "pyproject.toml",
        "requirements.txt",
        "setup.py",
        "setup.cfg",
        "tox.ini",
        "pytest.ini",
    )
    nested_requirements = _find_files(root, "requirements.txt", max_depth=2)
    python_tests = _find_matching_files(root, ("test_*.py", "*_test.py"), max_depth=3)
    has_python = _has_any(root, project_markers) or bool(nested_requirements) or bool(python_tests)
    if not has_python:
        return None

    candidates: list[dict[str, Any]] = []
    for rel in (
        ".venv/bin/python",
        ".venv/bin/python3",
        "venv/bin/python",
        "venv/bin/python3",
        "env/bin/python",
        "env/bin/python3",
    ):
        p = root / rel
        if p.exists():
            candidates.append({
                "command": _shell_path(p, root),
                "path": str(p),
                "reason": f"workspace {rel}",
            })

    ive_venv = Path.home() / ".ive" / "venv" / "bin" / "python3"
    if (
        not candidates
        and ive_venv.exists()
        and (root / "start.sh").exists()
        and (root / "backend" / "requirements.txt").exists()
    ):
        candidates.append({
            "command": _shell_path(ive_venv),
            "path": str(ive_venv),
            "reason": "IVE start.sh-managed venv",
        })

    if not candidates:
        candidates.append({
            "command": "python3",
            "path": None,
            "reason": "no workspace venv detected",
        })

    python_cmd = candidates[0]["command"]
    test_commands: list[str] = []
    if (root / "pytest.ini").exists() or (root / "pyproject.toml").exists() or (root / "tox.ini").exists():
        test_commands.append(f"{python_cmd} -m pytest")

    for test_file in sorted(python_tests, key=lambda p: _rel_dir(p, root))[:4]:
        test_commands.append(f"{python_cmd} {_shell_path(test_file, root)}")

    commands = {
        "python": python_cmd,
        "pip": f"{python_cmd} -m pip",
        "pytest": f"{python_cmd} -m pytest",
    }
    if test_commands:
        commands["tests"] = test_commands

    return {
        "detected": True,
        "preferred": candidates[0],
        "candidates": candidates,
        "requirements": [_rel_dir(p, root) for p in nested_requirements],
        "commands": commands,
        "notes": [
            "Use the preferred python command for tests and dependency checks; avoid bare python3 when it differs.",
        ],
    }


def _detect_javascript(root: Path) -> dict[str, Any] | None:
    package_files = _find_files(root, "package.json", max_depth=3)
    projects: list[dict[str, Any]] = []
    for pkg in package_files:
        project_dir = pkg.parent
        data = _load_package_json(pkg)
        scripts = data.get("scripts") if isinstance(data.get("scripts"), dict) else {}
        pm = _package_manager(project_dir)
        rel = _rel_dir(project_dir, root)
        commands: dict[str, str] = {"install": _pkg_install(pm, rel)}
        for kind in ("test", "build", "lint", "typecheck", "dev", "preview"):
            script = _script_for(scripts, kind)
            if script:
                commands[kind] = _pkg_run(pm, rel, script)
        projects.append({
            "path": rel,
            "package_manager": pm,
            "scripts": sorted(scripts.keys()),
            "commands": commands,
        })

    if not projects:
        return None
    return {
        "detected": True,
        "projects": projects,
        "notes": [
            "Use the package manager implied by each lockfile; do not mix npm/pnpm/yarn/bun in the same package directory.",
        ],
    }


def _detect_rust(root: Path) -> dict[str, Any] | None:
    cargo_files = _find_files(root, "Cargo.toml", max_depth=3)
    if not cargo_files:
        return None
    toolchain = None
    for name in ("rust-toolchain.toml", "rust-toolchain"):
        if (root / name).exists():
            toolchain = name
            break
    projects = []
    for cargo in cargo_files:
        rel = _rel_dir(cargo.parent, root)
        prefix = "" if rel == "." else f"--manifest-path {shlex.quote(rel + '/Cargo.toml')} "
        projects.append({
            "path": rel,
            "commands": {
                "test": f"cargo test {prefix}".strip(),
                "build": f"cargo build {prefix}".strip(),
                "check": f"cargo check {prefix}".strip(),
            },
        })
    return {
        "detected": True,
        "toolchain_file": toolchain,
        "projects": projects,
    }


def _detect_go(root: Path) -> dict[str, Any] | None:
    if not (root / "go.mod").exists():
        return None
    return {
        "detected": True,
        "commands": {
            "test": "go test ./...",
            "build": "go build ./...",
        },
    }


def _detect_java(root: Path) -> dict[str, Any] | None:
    if (root / "gradlew").exists():
        return {
            "detected": True,
            "tool": "gradle-wrapper",
            "commands": {"test": "./gradlew test", "build": "./gradlew build"},
        }
    if (root / "pom.xml").exists():
        return {
            "detected": True,
            "tool": "maven",
            "commands": {"test": "mvn test", "build": "mvn package"},
        }
    return None


def _detect_native(root: Path) -> dict[str, Any] | None:
    commands: dict[str, str] = {}
    markers: list[str] = []
    if (root / "CMakeLists.txt").exists():
        markers.append("CMakeLists.txt")
        commands["configure"] = "cmake -S . -B build"
        commands["build"] = "cmake --build build"
        commands["test"] = "ctest --test-dir build --output-on-failure"
    if (root / "Makefile").exists() or (root / "makefile").exists():
        markers.append("Makefile")
        commands.setdefault("build", "make")
        commands.setdefault("test", "make test")
    if (root / "meson.build").exists():
        markers.append("meson.build")
        commands.setdefault("configure", "meson setup build")
        commands.setdefault("build", "meson compile -C build")
        commands.setdefault("test", "meson test -C build")
    if not markers:
        return None
    return {
        "detected": True,
        "markers": markers,
        "commands": commands,
    }


def detect_workspace_runtime_env(workspace_path: str | os.PathLike[str] | None) -> dict[str, Any]:
    root = _safe_path(workspace_path)
    if not root or not root.exists() or not root.is_dir():
        return {
            "ok": False,
            "error": "workspace path not found",
            "workspace_path": str(workspace_path or ""),
        }

    sections: dict[str, Any] = {}
    for key, detector in (
        ("python", _detect_python),
        ("javascript", _detect_javascript),
        ("rust", _detect_rust),
        ("go", _detect_go),
        ("java", _detect_java),
        ("native", _detect_native),
    ):
        detected = detector(root)
        if detected:
            sections[key] = detected

    return {
        "ok": True,
        "workspace_path": str(root),
        "sections": sections,
        "prompt": render_runtime_prompt(sections),
    }


def _add_command(lines: list[str], label: str, command: str | None) -> None:
    if command:
        lines.append(f"- {label}: `{command}`")


def render_runtime_prompt(sections: dict[str, Any]) -> str:
    if not sections:
        return ""

    lines = [
        "## Workspace Runtime Environment",
        "",
        "Use these detected commands when testing or verifying this workspace. Prefer them over generic interpreter names.",
    ]

    py = sections.get("python")
    if py:
        preferred = py.get("preferred") or {}
        lines.append("")
        lines.append("### Python")
        _add_command(lines, "Preferred Python", preferred.get("command"))
        _add_command(lines, "Pip", (py.get("commands") or {}).get("pip"))
        tests = (py.get("commands") or {}).get("tests") or []
        for cmd in tests[:4]:
            _add_command(lines, "Test", cmd)
        if preferred.get("reason"):
            lines.append(f"- Reason: {preferred['reason']}")

    js = sections.get("javascript")
    if js:
        lines.append("")
        lines.append("### JavaScript / TypeScript")
        for project in (js.get("projects") or [])[:4]:
            commands = project.get("commands") or {}
            visible_commands = {k: v for k, v in commands.items() if k != "install"}
            if not visible_commands:
                continue
            rel = project.get("path") or "."
            pm = project.get("package_manager") or "npm"
            lines.append(f"- Project `{rel}` uses `{pm}`")
            for label in ("test", "build", "lint", "typecheck"):
                if commands.get(label):
                    lines.append(f"  - {label}: `{commands[label]}`")

    rust = sections.get("rust")
    if rust:
        lines.append("")
        lines.append("### Rust")
        if rust.get("toolchain_file"):
            lines.append(f"- Toolchain file: `{rust['toolchain_file']}`")
        for project in (rust.get("projects") or [])[:3]:
            rel = project.get("path") or "."
            lines.append(f"- Project `{rel}`")
            commands = project.get("commands") or {}
            _add_command(lines, "  test", commands.get("test"))
            _add_command(lines, "  check", commands.get("check"))

    for key, title in (("go", "Go"), ("java", "Java"), ("native", "Native Build")):
        sec = sections.get(key)
        if not sec:
            continue
        lines.append("")
        lines.append(f"### {title}")
        for label, command in (sec.get("commands") or {}).items():
            _add_command(lines, label, command)

    return "\n".join(lines).strip()
