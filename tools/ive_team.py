"""Fresh, explicit IVE team installation profile; no action occurs on import.

This file is exported as tools/ive_team.py. It does not load shell env files,
copy existing app state, discover sibling extensions, or prefetch embeddings.
It is an installation selector, not a sandbox for IVE or installed CLI tools.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Mapping, Sequence


PROFILE = {
    "schema_version": 1,
    "name": "ive-team",
    "edition": "integrated-dev",
    "extensions": ["sandbox"],
    "extension_root": "extensions",
    "state_directory": ".ive-team-state",
}
BUILD_PROFILE = {key: PROFILE[key] for key in ("schema_version", "name", "edition", "extensions")}
STATE_MARKER = {"schema_version": 1, "profile": "ive-team", "kind": "fresh-install-state"}
_ENVIRONMENT_KEYS = (
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE",
    "SHELL", "TERM", "COLORTERM", "TMPDIR", "TMP", "TEMP",
    "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR",
    "SSL_CERT_FILE", "SSL_CERT_DIR",
    # Telemetry is off unless the operator opts in for this launch.
    "IVE_TELEMETRY",
)

# Local operator configuration is separate from the immutable base product.
# It is not exported and contains no automatic sibling discovery.
LOCAL_CONFIG = "ive-local.json"
_PRODUCT_ID = re.compile(r"^[a-z][a-z0-9-]{0,63}$")


def local_configuration(root: Path) -> dict:
    path = _inside(root, LOCAL_CONFIG)
    data = _read_json(path) if path.exists() else {"schema_version": 1}
    if (not isinstance(data, dict) or type(data.get("schema_version")) is not int or data.get("schema_version") != 1
            or set(data) - {"schema_version", "sandbox", "products"}):
        raise ProfileError("Unsupported local installation configuration")
    products = data.get("products", [])
    if not isinstance(products, list):
        raise ProfileError("Products must be an explicit reviewed package list")
    selected, roots, fingerprints, requirements = ["sandbox"], [str(root / "extensions")], {}, []
    manifests = {}
    for item in products:
        if not isinstance(item, dict) or set(item) != {"id", "path", "files"}:
            raise ProfileError("Each product requires an id, absolute path, and reviewed file hashes")
        owner, supplied, inventory = item["id"], item["path"], item["files"]
        if not isinstance(owner, str) or not _PRODUCT_ID.fullmatch(owner) or owner in selected:
            raise ProfileError("Invalid or duplicate product selection")
        if not isinstance(supplied, str) or not Path(supplied).is_absolute():
            raise ProfileError("Product paths must be explicitly absolute")
        package = Path(supplied)
        if package.is_symlink() or package.resolve() != package or package.name != owner or not package.is_dir():
            raise ProfileError("Product directory must be canonical, named by id, and not a symlink")
        if package.is_relative_to(root):
            raise ProfileError("Separate products must remain outside the base IVE package")
        if (not isinstance(inventory, dict) or "extension.json" not in inventory
                or any(not isinstance(key, str) or not isinstance(value, str)
                       or not re.fullmatch(r"[a-f0-9]{64}", value) for key, value in inventory.items())):
            raise ProfileError("A complete reviewed SHA256 source inventory is required")
        actual = {}
        for candidate in package.rglob("*"):
            if candidate.is_symlink():
                raise ProfileError("Symlinked product files are not supported")
            if candidate.is_dir() and (candidate.name.startswith(".") or candidate.name in {"node_modules", "__pycache__"}):
                raise ProfileError("Product package includes runtime/private-state or dependency artifacts")
            if not candidate.is_file() and not candidate.is_dir():
                raise ProfileError("Product packages may contain only regular source files and directories")
            if not candidate.is_file():
                continue
            relative = candidate.relative_to(package).as_posix()
            if (any(part.startswith(".") or part in {"node_modules", "__pycache__"} for part in candidate.relative_to(package).parts[:-1])
                    or candidate.name.startswith(".env") or candidate.suffix in {".db", ".sqlite", ".sqlite3", ".pyc"}):
                raise ProfileError("Product package includes runtime/private-state or dependency artifacts")
            actual[relative] = hashlib.sha256(candidate.read_bytes()).hexdigest()
        if actual != inventory:
            raise ProfileError("Product files differ from the explicit reviewed inventory")
        manifest = _read_json(package / "extension.json")
        if (not isinstance(manifest, dict) or manifest.get("id") != owner
                or type(manifest.get("api_version")) is not int or manifest["api_version"] != 1):
            raise ProfileError("Incompatible product API")
        dependencies = manifest.get("requires", [])
        if not isinstance(dependencies, list) or any(not isinstance(dep, str) or not _PRODUCT_ID.fullmatch(dep) for dep in dependencies):
            raise ProfileError("Invalid product dependencies")
        if (package / "backend/database.py").exists() and not (manifest.get("backend") or {}).get("storage"):
            raise ProfileError("Product storage has no supported versioned contract")
        install = manifest.get("installation", {})
        if not isinstance(install, dict) or set(install) - {"python_requirements"}:
            raise ProfileError("Unsupported product installation declaration")
        if install.get("python_requirements"):
            relative = install["python_requirements"]
            if not isinstance(relative, str) or relative not in inventory:
                raise ProfileError("Product requirements must be a reviewed owned file")
            dependency_path = package / relative
            # No recursive requirements, editable/path URLs or index commands.
            for line in dependency_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#") and not re.fullmatch(r"[A-Za-z0-9_.-]+(?:\[[A-Za-z0-9_,.-]+\])?==[A-Za-z0-9_.+!-]+", line):
                    raise ProfileError("Product Python requirements must use explicit version pins")
            requirements.append(str(dependency_path))
        selected.append(owner)
        manifests[owner] = manifest
        roots.append(str(package.parent))
        fingerprints[owner] = hashlib.sha256(json.dumps(inventory, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    for manifest in manifests.values():
        if not set(manifest.get("requires", [])) <= set(selected):
            raise ProfileError("A selected product dependency has not been explicitly installed")
    def visit(owner, pending):
        if owner in pending:
            raise ProfileError("Cyclic product dependencies")
        for dependency in manifests.get(owner, {}).get("requires", []):
            visit(dependency, pending | {owner})
    for owner in manifests:
        visit(owner, set())
    return {"extensions": sorted(selected), "roots": list(dict.fromkeys(roots)),
            "fingerprints": fingerprints, "requirements": requirements,
            "sandbox_environment": sandbox_environment(data.get("sandbox", {}))}


def sandbox_environment(config: dict) -> dict[str, str]:
    if not isinstance(config, dict):
        raise ProfileError("Sandbox configuration must be an object")
    env = {}
    fields = {
        "runtime": ("IVE_SANDBOX_RUNTIME", {"none", "docker", "apple-container"}),
        "one_shot_runtime": ("SANDBOX_RUNTIME", {"process", "daytona"}),
        "app_container": ("IVE_APP_CONTAINER", bool),
        "browser_container": ("IVE_BROWSER_CONTAINER", bool),
        "container_readonly": ("SANDBOX_CONTAINER_READONLY", bool),
        "docker_image": ("SANDBOX_DOCKER_IMAGE", str),
        "container_image": ("SANDBOX_CONTAINER_IMAGE", str),
        "app_image": ("IVE_APP_IMAGE", str),
        "browser_image": ("IVE_BROWSER_IMAGE", str),
    }
    if set(config) - fields.keys():
        raise ProfileError("Unknown Sandbox setting; secret passthrough and security bypasses are not accepted")
    for key, value in config.items():
        name, kind = fields[key]
        if kind is bool:
            if type(value) is not bool:
                raise ProfileError("Sandbox switches must be booleans")
            env[name] = "1" if value else "0"
        elif kind is str:
            if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}", value):
                raise ProfileError("Invalid Sandbox image reference")
            env[name] = value
        else:
            if not isinstance(value, str) or value not in kind:
                raise ProfileError("Unsupported Sandbox runtime selection")
            env[name] = value
    return env


class ProfileError(ValueError):
    """An installation/profile precondition failed before starting services."""


def _read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ProfileError(f"Invalid or missing profile file: {path}") from exc


def _inside(root: Path, relative: str) -> Path:
    root = root.resolve()
    target = root / relative
    if target.is_symlink() or not target.resolve().is_relative_to(root):
        raise ProfileError(f"Package path must stay inside the installation: {relative}")
    return target


def validate_package(root: Path) -> Path:
    root = root.resolve()
    if _read_json(_inside(root, "ive-team.json")) != PROFILE:
        raise ProfileError("This launcher requires the unmodified IVE team profile")
    for relative in (
        "backend/server.py", "backend/config.py", "backend/requirements.txt",
        "frontend/package.json", "frontend/package-lock.json",
        "frontend/vite.config.js", "frontend/extension-build.mjs",
    ):
        if not _inside(root, relative).is_file():
            raise ProfileError(f"Package is missing {relative}")
    extensions = _inside(root, PROFILE["extension_root"])
    if not extensions.is_dir():
        raise ProfileError("Package is missing its explicit extensions directory")
    packages = sorted(path.name for path in extensions.iterdir() if path.is_dir() or path.is_symlink())
    if packages != PROFILE["extensions"]:
        raise ProfileError("The team package must contain only its selected Sandbox extension")
    manifest = _read_json(_inside(root, "extensions/sandbox/extension.json"))
    if not isinstance(manifest, dict) or manifest.get("id") != "sandbox" or manifest.get("api_version") != 1:
        raise ProfileError("Invalid Sandbox extension manifest")
    if manifest.get("requires", []) != []:
        raise ProfileError("The team Sandbox extension cannot require an unselected product")
    return root


def selected_environment(root: Path, inherited: Mapping[str, str]) -> dict[str, str]:
    """Allow only process plumbing, never inherited product settings or keys.

    HOME is preserved unchanged for normal OS/CLI operation; this is not
    user-home isolation. Backend application state is explicitly separate.
    """
    env = {key: inherited[key] for key in _ENVIRONMENT_KEYS if key in inherited}
    env.setdefault("PATH", os.defpath)
    state = root / PROFILE["state_directory"]
    configuration = local_configuration(root)
    env.update({
        "IVE_ROOT": str(root),
        "IVE_EDITION": PROFILE["edition"],
        "IVE_EXTENSIONS": ",".join(configuration["extensions"]),
        "IVE_EXTENSION_PATHS": os.pathsep.join(configuration["roots"]),
        "IVE_NATIVE_MEMORY_OPT_IN": "1",
        "IVE_DATA_DIR": str(state),
        "IVE_APP_CONTAINER_STATE": str(state / "app-containers"),
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PLAYWRIGHT_BROWSERS_PATH": str(state / "browsers"),
        "PIP_CONFIG_FILE": os.devnull,
        "PIP_NO_INPUT": "1",
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        "NPM_CONFIG_USERCONFIG": os.devnull,
        # Distinct files avoid npm's duplicate-config-path rejection. A fresh
        # install has no global npmrc here; never consult the operator's one.
        "NPM_CONFIG_GLOBALCONFIG": str(state / "npm-globalrc"),
        "NPM_CONFIG_CACHE": str(state / "npm-cache"),
    })
    env.update(configuration["sandbox_environment"])
    return env


def validate_state(root: Path, *, require_initialized: bool = False) -> Path:
    state = _inside(root, PROFILE["state_directory"])
    if not state.exists():
        if require_initialized:
            raise ProfileError("Run install.sh first to initialize this installation's fresh state")
        return state
    if not state.is_dir():
        raise ProfileError("The installation state path is not a directory")
    marker = _inside(root, f"{PROFILE['state_directory']}/instance.json")
    if marker.exists():
        if _read_json(marker) != STATE_MARKER:
            raise ProfileError("The existing state directory belongs to a different installation profile")
    elif any(state.iterdir()) or require_initialized:
        raise ProfileError("Refusing existing unclaimed state; no database or settings will be imported")
    return state


def initialize_state(root: Path) -> Path:
    state = validate_state(root)
    state.mkdir(mode=0o700, exist_ok=True)
    marker = state / "instance.json"
    if not marker.exists():
        # Exclusive creation avoids overwriting a concurrently claimed marker.
        with marker.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(STATE_MARKER, indent=2) + "\n")
        marker.chmod(0o600)
    return state


def validate_frontend(root: Path) -> None:
    if not _inside(root, "frontend/dist/index.html").is_file():
        raise ProfileError("Frontend is not built; run install.sh")
    selection = local_configuration(root)
    expected = {**BUILD_PROFILE, "extensions": selection["extensions"]}
    if selection["fingerprints"]:
        expected["product_fingerprints"] = selection["fingerprints"]
    if _read_json(_inside(root, "frontend/dist/ive-build-profile.json")) != expected:
        raise ProfileError("Frontend/backend profile mismatch; rebuild using install.sh")


def validate_node_version(value: str) -> None:
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?", value.strip())
    if not match or tuple(map(int, match.groups())) < (22, 12, 0):
        raise ProfileError("IVE team requires Node.js 22.12 or newer for its frontend build")


def installation_plan(root: Path, *, browser: bool = False) -> list[dict[str, object]]:
    python = str(root / ".venv/bin/python")
    steps: list[dict[str, object]] = [
        {"cwd": str(root), "argv": [sys.executable, "-I", "-m", "venv", str(root / ".venv")]},
        {"cwd": str(root), "argv": [python, "-I", "-m", "pip", "install", "--requirement", str(root / "backend/requirements.txt")]},
        {"cwd": str(root / "frontend"), "argv": ["npm", "ci", "--include=dev"]},
        {"cwd": str(root / "frontend"), "argv": ["npm", "run", "build"]},
    ]
    for requirements in local_configuration(root)["requirements"]:
        steps.insert(2, {"cwd": str(root), "argv": [python, "-I", "-m", "pip", "install", "--requirement", requirements]})
    if browser:
        steps.append({"cwd": str(root), "argv": [python, "-I", "-m", "playwright", "install", "chromium"]})
    return steps


def run_plan(root: Path, server_args: Sequence[str]) -> dict[str, object]:
    return {"cwd": str(root / "backend"), "argv": [str(root / ".venv/bin/python"), "-s", str(root / "backend/server.py"), *server_args]}


# AVCP hooks are left alone: their markers also match a separately installed AVCP.
REMOVE_HOOKS = "import hook_installer as h; h.uninstall_all(); h.uninstall_safety_gate_hooks()"


def remove_hooks(root: Path, env: Mapping[str, str]) -> None:
    """Undo what a running IVE wrote into ~/.claude, ~/.codex and ~/.gemini."""
    executable = root / ".venv/bin/python"
    if not executable.is_file():
        print("No installed IVE Python found; no hooks to remove.")
        return
    subprocess.run([str(executable), "-s", "-c", REMOVE_HOOKS], cwd=root / "backend", env=env, check=True)
    print("Removed IVE hooks from the Claude Code, Codex and Gemini CLI settings.")


def _redacted(step: Mapping[str, object]) -> dict[str, object]:
    argv = list(step["argv"])
    for index, item in enumerate(argv):
        if item == "--token" and index + 1 < len(argv):
            argv[index + 1] = "[redacted]"
        elif isinstance(item, str) and item.startswith("--token="):
            argv[index] = "--token=[redacted]"
    return {**step, "argv": argv}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Install or start the explicit IVE team package")
    parser.add_argument("--root", required=True, type=Path)
    actions = parser.add_subparsers(dest="action", required=True)
    install = actions.add_parser("install", help="Install dependencies and build; never starts IVE")
    install.add_argument("--browser", action="store_true", help="Also download isolated Playwright Chromium")
    install.add_argument("--plan", action="store_true", help="Print the plan without writes or commands")
    run = actions.add_parser("run", help="Start this installation using its already built frontend")
    run.add_argument("--plan", action="store_true", help="Print the plan without writes or commands")
    actions.add_parser("remove-hooks", help="Remove IVE's hooks from the coding CLIs' settings files")
    args, server_args = parser.parse_known_args(argv)
    if args.action == "install" and server_args:
        parser.error("Unexpected installer arguments")
    if server_args[:1] == ["--"]:
        server_args = server_args[1:]
    try:
        if sys.version_info < (3, 11) or os.name != "posix":
            raise ProfileError("IVE team requires Python 3.11+ on macOS or Linux")
        root = validate_package(args.root)
        env = selected_environment(root, os.environ)
        if args.action == "remove-hooks":
            if server_args:
                parser.error("Unexpected arguments")
            remove_hooks(root, env)
            return 0
        validate_state(root, require_initialized=args.action == "run" and not args.plan)
        if args.action == "install":
            steps = installation_plan(root, browser=args.browser)
        else:
            steps = [run_plan(root, server_args)]
        if args.plan:
            print(json.dumps({"profile": PROFILE, "state": str(root / PROFILE["state_directory"]), "commands": [_redacted(step) for step in steps]}, indent=2))
            return 0
        if args.action == "install":
            node = shutil.which("node", path=env["PATH"])
            if not node or not shutil.which("npm", path=env["PATH"]):
                raise ProfileError("Install Node.js 22.12+ and npm first")
            validate_node_version(subprocess.run([node, "--version"], env=env, check=True, capture_output=True, text=True).stdout)
            _inside(root, ".venv")
            initialize_state(root)
            for step in steps:
                subprocess.run(step["argv"], cwd=step["cwd"], env=env, check=True)
            validate_frontend(root)
            print("Installed. Nothing was started. Run bin/ive to start IVE in the background, or bash start.sh to run it in this terminal.")
            return 0
        validate_frontend(root)
        executable = root / ".venv/bin/python"
        if not executable.is_file():
            raise ProfileError("Installation Python is missing; run install.sh")
        step = steps[0]
        os.chdir(step["cwd"])
        os.execve(executable, step["argv"], env)
        return 0
    except (ProfileError, OSError, subprocess.CalledProcessError) as exc:
        # Do not print CalledProcessError.cmd: run arguments can contain a token.
        detail = "A dependency command failed; installation did not start IVE" if isinstance(exc, subprocess.CalledProcessError) else str(exc)
        print(f"IVE team: {detail}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
