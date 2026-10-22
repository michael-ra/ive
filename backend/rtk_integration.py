"""Optional RTK command-output optimization integration.

RTK is an external binary. IVE never enables it from this module. The module:
  * exposes a disabled-by-default configuration surface,
  * checks whether a user-managed RTK binary is available,
  * installs a pinned RTK release only from explicit install requests,
  * rewrites eligible shell tool inputs when the user explicitly enables RTK.

IVE remains the owner of hooks, safety, audit logging, and permissions.
"""
from __future__ import annotations

import asyncio
import os
import platform
import re
import shutil
import stat
import tarfile
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiohttp

from config import DATA_DIR
from db import get_db


SETTING_ENABLED = "rtk_enabled"
SETTING_PRESET = "rtk_preset"
SETTING_BINARY_MODE = "rtk_binary_mode"
SETTING_BINARY_PATH = "rtk_binary_path"
SETTING_UPDATE_POLICY = "rtk_update_policy"

DEFAULT_PRESET = "balanced"
DEFAULT_BINARY_MODE = "existing_path"
DEFAULT_UPDATE_POLICY = "notify"
PINNED_STABLE_VERSION = "v0.42.0"
MINIMUM_VERSION = PINNED_STABLE_VERSION
RTK_REPO_URL = "https://github.com/rtk-ai/rtk"
RTK_TOOLS_DIR = DATA_DIR / "tools" / "rtk"
RTK_BIN_NAME = "rtk.exe" if os.name == "nt" else "rtk"

PRESETS = {
    "balanced": {
        "label": "Balanced",
        "description": "Rewrite only high-noise dev commands; preserve raw/interactive commands.",
    },
    "aggressive": {
        "label": "Aggressive",
        "description": "Let RTK decide on any non-excluded shell command.",
    },
    "debug": {
        "label": "Debug / raw",
        "description": "Keep exact command output; useful when investigating RTK behavior.",
    },
}

INSTALL_MODES = {
    "existing_path": {
        "label": "Use existing RTK from PATH",
        "description": "IVE checks for rtk on PATH and does not manage updates.",
        "downloads": False,
    },
    "managed_stable": {
        "label": "IVE-managed stable",
        "description": f"Download pinned RTK {PINNED_STABLE_VERSION} release binary after explicit approval.",
        "downloads": True,
    },
    "build_from_source": {
        "label": "Build from source",
        "description": f"Clone pinned RTK {PINNED_STABLE_VERSION} and run cargo build --release --locked.",
        "downloads": True,
    },
    "custom_path": {
        "label": "Custom binary path",
        "description": "Use a user-provided RTK executable path.",
        "downloads": False,
    },
}

UPDATE_POLICIES = {
    "notify": "Notify when a tested stable update is available.",
    "never": "Never check for RTK updates.",
}

COMMAND_TOOLS = {
    "bash",
    "execute",
    "execute_command",
    "run_command",
    "shell_execute",
    "run_shell_command",
}

BALANCED_PREFIXES = (
    "cargo test",
    "cargo nextest",
    "npm test",
    "npm run test",
    "npm run build",
    "npm run lint",
    "npm run typecheck",
    "pnpm test",
    "pnpm run test",
    "pnpm build",
    "pnpm lint",
    "pnpm typecheck",
    "yarn test",
    "yarn build",
    "yarn lint",
    "pytest",
    "python -m pytest",
    "python3 -m pytest",
    "vitest",
    "npx vitest",
    "go test",
    "mvn test",
    "mvn verify",
    "gradle test",
    "./gradlew test",
    "tsc",
    "npx tsc",
    "eslint",
    "npx eslint",
    "ruff",
    "mypy",
    "git diff",
    "git log",
    "rg ",
    "ripgrep ",
    "docker logs",
    "kubectl logs",
)

EXCLUDED_PREFIXES = (
    "rtk ",
    "cd ",
    "pwd",
    "echo ",
    "which ",
    "command -v ",
    "git rebase",
    "git cherry-pick",
    "git merge",
    "git push",
    "ssh ",
    "psql ",
    "mysql ",
    "sqlite3 ",
    "docker exec",
    "tail -f",
    "watch ",
    "less ",
    "more ",
    "vim ",
    "vi ",
    "nano ",
    "rails console",
)

EXCLUDED_EXACT = (
    "python",
    "python3",
    "node",
    "irb",
)

_CONFIG_CACHE: tuple[float, dict[str, Any]] | None = None
_CONFIG_CACHE_TTL = 5.0


def _on(value: Any) -> bool:
    return str(value or "").lower() in {"1", "true", "yes", "on"}


def _normalize_command(command: str) -> str:
    return re.sub(r"\s+", " ", command.strip())


def _strip_env_prefixes(command: str) -> str:
    parts = command.split()
    while parts and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", parts[0]):
        parts.pop(0)
    return " ".join(parts)


def _setting_dict(rows) -> dict[str, str]:
    return {row["key"]: row["value"] for row in rows}


async def get_config(*, use_cache: bool = False) -> dict[str, Any]:
    """Return RTK config from app_settings with safe defaults."""
    global _CONFIG_CACHE
    now = time.monotonic()
    if use_cache and _CONFIG_CACHE and (now - _CONFIG_CACHE[0]) < _CONFIG_CACHE_TTL:
        return dict(_CONFIG_CACHE[1])

    keys = (
        SETTING_ENABLED,
        SETTING_PRESET,
        SETTING_BINARY_MODE,
        SETTING_BINARY_PATH,
        SETTING_UPDATE_POLICY,
    )
    db = await get_db()
    try:
        placeholders = ",".join("?" for _ in keys)
        cur = await db.execute(
            f"SELECT key, value FROM app_settings WHERE key IN ({placeholders})",
            keys,
        )
        settings = _setting_dict(await cur.fetchall())
    finally:
        await db.close()

    preset = settings.get(SETTING_PRESET) or DEFAULT_PRESET
    if preset not in PRESETS:
        preset = DEFAULT_PRESET

    mode = settings.get(SETTING_BINARY_MODE) or DEFAULT_BINARY_MODE
    if mode not in INSTALL_MODES:
        mode = DEFAULT_BINARY_MODE

    update_policy = settings.get(SETTING_UPDATE_POLICY) or DEFAULT_UPDATE_POLICY
    if update_policy not in UPDATE_POLICIES:
        update_policy = DEFAULT_UPDATE_POLICY

    config = {
        "enabled": _on(settings.get(SETTING_ENABLED)),
        "preset": preset,
        "binary_mode": mode,
        "binary_path": settings.get(SETTING_BINARY_PATH) or "",
        "update_policy": update_policy,
        "minimum_version": MINIMUM_VERSION,
        "pinned_stable_version": PINNED_STABLE_VERSION,
    }
    _CONFIG_CACHE = (now, dict(config))
    return config


async def update_config(data: dict[str, Any]) -> dict[str, Any]:
    """Persist RTK integration settings.

    Enabling is allowed only when a usable local binary is already available.
    This prevents a UI toggle from creating a broken hook path.
    """
    global _CONFIG_CACHE
    current = await get_config()
    next_config = dict(current)

    if "preset" in data:
        preset = str(data.get("preset") or DEFAULT_PRESET)
        if preset not in PRESETS:
            raise ValueError("invalid RTK preset")
        next_config["preset"] = preset

    if "binary_mode" in data:
        mode = str(data.get("binary_mode") or DEFAULT_BINARY_MODE)
        if mode not in INSTALL_MODES:
            raise ValueError("invalid RTK install mode")
        next_config["binary_mode"] = mode

    if "binary_path" in data:
        next_config["binary_path"] = str(data.get("binary_path") or "").strip()

    if "update_policy" in data:
        policy = str(data.get("update_policy") or DEFAULT_UPDATE_POLICY)
        if policy not in UPDATE_POLICIES:
            raise ValueError("invalid RTK update policy")
        next_config["update_policy"] = policy

    if "enabled" in data:
        next_config["enabled"] = _on(data.get("enabled"))

    status = await get_status(config=next_config, probe_version=False)
    if next_config["enabled"] and not status["available"]:
        raise ValueError("RTK cannot be enabled until a local rtk binary is available")

    writes = {
        SETTING_ENABLED: "on" if next_config["enabled"] else "off",
        SETTING_PRESET: next_config["preset"],
        SETTING_BINARY_MODE: next_config["binary_mode"],
        SETTING_BINARY_PATH: next_config["binary_path"],
        SETTING_UPDATE_POLICY: next_config["update_policy"],
    }

    db = await get_db()
    try:
        for key, value in writes.items():
            await db.execute(
                """INSERT INTO app_settings (key, value, updated_at)
                   VALUES (?, ?, datetime('now'))
                   ON CONFLICT(key) DO UPDATE SET
                     value = excluded.value,
                     updated_at = excluded.updated_at""",
                (key, value),
            )
        await db.commit()
    finally:
        await db.close()

    _CONFIG_CACHE = None
    return await get_status(probe_version=True)


def resolve_binary(config: dict[str, Any]) -> str | None:
    path = (config.get("binary_path") or "").strip()
    if config.get("binary_mode") == "custom_path" and path:
        expanded = os.path.expanduser(path)
        return expanded if os.path.isfile(expanded) and os.access(expanded, os.X_OK) else None

    if path:
        expanded = os.path.expanduser(path)
        if os.path.isfile(expanded) and os.access(expanded, os.X_OK):
            return expanded

    return shutil.which("rtk")


async def _probe_version(binary: str | None) -> str | None:
    if not binary:
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            binary,
            "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=1.0)
    except Exception:
        return None
    text = (stdout or stderr or b"").decode("utf-8", errors="replace").strip()
    return text[:120] or None


async def get_status(
    *,
    config: dict[str, Any] | None = None,
    probe_version: bool = True,
) -> dict[str, Any]:
    config = dict(config or await get_config())
    binary = resolve_binary(config)
    version = await _probe_version(binary) if probe_version else None
    return {
        "id": "rtk",
        "name": "RTK Command Output Optimizer",
        "enabled": bool(config["enabled"]),
        "available": bool(binary),
        "binary": binary,
        "version": version,
        "config": config,
        "presets": [
            {"id": key, **value}
            for key, value in PRESETS.items()
        ],
        "install_modes": [
            {"id": key, **value}
            for key, value in INSTALL_MODES.items()
        ],
        "update_policies": [
            {"id": key, "description": value}
            for key, value in UPDATE_POLICIES.items()
        ],
        "balanced_candidate_prefixes": list(BALANCED_PREFIXES),
        "excluded_prefixes": list(EXCLUDED_PREFIXES),
        "pinned_stable_version": PINNED_STABLE_VERSION,
        "managed_install_path": str(_managed_bin_path(PINNED_STABLE_VERSION)),
        "runtime": {
            "hook_owner": "ive",
            "downloads_on_status_check": False,
            "downloads_on_enable": False,
            "supported_cli_types": ["claude"],
            "enabled_effective": bool(config["enabled"] and binary),
        },
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _version_dir(version: str = PINNED_STABLE_VERSION) -> Path:
    return RTK_TOOLS_DIR / version


def _managed_bin_path(version: str = PINNED_STABLE_VERSION) -> Path:
    return _version_dir(version) / "bin" / RTK_BIN_NAME


def _target_triple() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()

    if machine in {"x86_64", "amd64"}:
        arch = "x86_64"
    elif machine in {"arm64", "aarch64"}:
        arch = "aarch64"
    else:
        raise ValueError(f"unsupported RTK architecture: {platform.machine()}")

    if system == "darwin":
        return f"{arch}-apple-darwin"
    if system == "linux":
        if arch == "x86_64":
            return "x86_64-unknown-linux-musl"
        return "aarch64-unknown-linux-gnu"
    raise ValueError(f"unsupported RTK operating system: {platform.system()}")


def _release_archive_url(version: str = PINNED_STABLE_VERSION) -> str:
    target = _target_triple()
    return f"{RTK_REPO_URL}/releases/download/{version}/rtk-{target}.tar.gz"


async def _download_file(url: str, dest: Path, *, max_bytes: int = 100 * 1024 * 1024) -> None:
    timeout = aiohttp.ClientTimeout(total=180)
    bytes_read = 0
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(url) as resp:
            if resp.status != 200:
                raise RuntimeError(f"download failed with HTTP {resp.status}")
            with dest.open("wb") as f:
                async for chunk in resp.content.iter_chunked(1024 * 128):
                    bytes_read += len(chunk)
                    if bytes_read > max_bytes:
                        raise RuntimeError("download exceeded maximum allowed size")
                    f.write(chunk)


def _safe_extract_rtk_archive(archive: Path, final_bin: Path) -> None:
    with tarfile.open(archive, "r:gz") as tf:
        members = tf.getmembers()
        for member in members:
            path = Path(member.name)
            if path.is_absolute() or ".." in path.parts:
                raise RuntimeError("release archive contains unsafe paths")

        binary_member = None
        for member in members:
            name = Path(member.name).name
            if member.isfile() and name in {"rtk", "rtk.exe"}:
                binary_member = member
                break
        if binary_member is None:
            raise RuntimeError("release archive did not contain rtk binary")

        src = tf.extractfile(binary_member)
        if src is None:
            raise RuntimeError("failed to read rtk binary from archive")

        final_bin.parent.mkdir(parents=True, exist_ok=True)
        tmp = final_bin.with_suffix(final_bin.suffix + ".tmp")
        with src, tmp.open("wb") as out:
            shutil.copyfileobj(src, out)
        tmp.chmod(tmp.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        tmp.replace(final_bin)


async def _run_process(cmd: list[str], *, cwd: Path | None = None, timeout: int = 600) -> str:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(cwd) if cwd else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError as exc:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        raise RuntimeError(f"command timed out: {' '.join(cmd[:2])}") from exc

    text = (
        (stdout or b"").decode("utf-8", errors="replace")
        + (stderr or b"").decode("utf-8", errors="replace")
    )
    if proc.returncode != 0:
        tail = text[-2000:].strip()
        raise RuntimeError(f"command failed ({proc.returncode}): {' '.join(cmd)}\n{tail}")
    return text


async def _record_install(*, mode: str, binary_path: Path, version: str) -> None:
    global _CONFIG_CACHE
    db = await get_db()
    values = {
        SETTING_BINARY_MODE: mode,
        SETTING_BINARY_PATH: str(binary_path),
        "rtk_installed_version": version,
        "rtk_installed_at": _now_iso(),
        "rtk_install_source": mode,
    }
    try:
        for key, value in values.items():
            await db.execute(
                """INSERT INTO app_settings (key, value, updated_at)
                   VALUES (?, ?, datetime('now'))
                   ON CONFLICT(key) DO UPDATE SET
                     value = excluded.value,
                     updated_at = excluded.updated_at""",
                (key, value),
            )
        await db.commit()
    finally:
        await db.close()
    _CONFIG_CACHE = None


async def install(mode: str = "managed_stable") -> dict[str, Any]:
    """Install pinned RTK only when explicitly called by the user."""
    mode = mode or "managed_stable"
    if mode not in {"managed_stable", "build_from_source"}:
        raise ValueError("mode must be managed_stable or build_from_source")

    version = PINNED_STABLE_VERSION
    final_bin = _managed_bin_path(version)

    if mode == "managed_stable":
        url = _release_archive_url(version)
        final_bin.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="ive-rtk-download-") as td:
            archive = Path(td) / "rtk.tar.gz"
            await _download_file(url, archive)
            _safe_extract_rtk_archive(archive, final_bin)
    else:
        src_dir = _version_dir(version) / "source"
        if src_dir.exists():
            shutil.rmtree(src_dir)
        src_dir.parent.mkdir(parents=True, exist_ok=True)
        await _run_process(
            ["git", "clone", "--depth", "1", "--branch", version, RTK_REPO_URL, str(src_dir)],
            timeout=180,
        )
        await _run_process(
            ["cargo", "build", "--release", "--locked"],
            cwd=src_dir,
            timeout=1200,
        )
        built = src_dir / "target" / "release" / RTK_BIN_NAME
        if not built.exists():
            raise RuntimeError("cargo build completed but rtk binary was not produced")
        final_bin.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(built, final_bin)
        final_bin.chmod(final_bin.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    await _record_install(mode=mode, binary_path=final_bin, version=version)
    status = await get_status(probe_version=True)
    return {
        "ok": True,
        "mode": mode,
        "version": version,
        "binary": str(final_bin),
        "enabled": status["enabled"],
        "status": status,
    }


async def _session_cli_type(session_id: str) -> str:
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT cli_type FROM sessions WHERE id = ?",
            (session_id,),
        )
        row = await cur.fetchone()
        return (row["cli_type"] if row else "claude") or "claude"
    finally:
        await db.close()


def _is_candidate(command: str, preset: str) -> bool:
    normalized = _normalize_command(command)
    if not normalized:
        return False
    if "RTK_DISABLED=1" in normalized or "NO_RTK=1" in normalized:
        return False

    base = _strip_env_prefixes(normalized)
    lower = base.lower()
    if lower in EXCLUDED_EXACT:
        return False
    if any(lower == p.strip() or lower.startswith(p) for p in EXCLUDED_PREFIXES):
        return False

    if preset == "debug":
        return False
    if preset == "aggressive":
        return True
    return any(lower == p.strip() or lower.startswith(p) for p in BALANCED_PREFIXES)


async def _rewrite_command(binary: str, command: str) -> tuple[str | None, int | None]:
    try:
        proc = await asyncio.create_subprocess_exec(
            binary,
            "rewrite",
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _stderr = await asyncio.wait_for(proc.communicate(), timeout=1.0)
    except Exception:
        return None, None

    rewritten = stdout.decode("utf-8", errors="replace").strip()
    if proc.returncode in (0, 3) and rewritten:
        return rewritten, proc.returncode
    return None, proc.returncode


async def maybe_rewrite_pre_tool(session_id: str, payload: dict) -> dict[str, Any] | None:
    """Return a Claude PreToolUse decision that rewrites shell input, if enabled."""
    tool_name = str(payload.get("tool_name") or "").lower()
    if tool_name not in COMMAND_TOOLS:
        return None

    tool_input = payload.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        return None

    command_key = "command" if "command" in tool_input else "script" if "script" in tool_input else None
    if not command_key:
        return None

    command = str(tool_input.get(command_key) or "")
    if not command.strip():
        return None

    config = await get_config(use_cache=True)
    if not config["enabled"]:
        return None

    # Start conservatively: Claude Code has a documented updatedInput contract.
    # Other CLIs can be added once their rewrite contract is verified.
    if await _session_cli_type(session_id) != "claude":
        return None

    if not _is_candidate(command, config["preset"]):
        return None

    binary = resolve_binary(config)
    if not binary:
        return None

    rewritten, _code = await _rewrite_command(binary, command)
    if not rewritten or _normalize_command(rewritten) == _normalize_command(command):
        return None

    next_input = dict(tool_input)
    next_input[command_key] = rewritten
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "updatedInput": next_input,
        }
    }
