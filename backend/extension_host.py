"""Trusted, explicitly selected IVE extensions and transitional module loading.

This is a composition boundary, NOT a sandbox for third-party Python. Installed
backend extensions execute with the host's privileges. Public source packaging
is a separate, fail-closed release check; disabling a feature does not remove
its source, schemas or prompts from an existing checkout.
"""
from __future__ import annotations

import importlib.util
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from typing import Any

API_VERSION = 1
_ID = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
_PROFILES = {"integrated-dev", "workspace"}


class ExtensionUnavailable(RuntimeError):
    def __init__(self, extension_id: str, detail: str | None = None):
        self.extension_id = extension_id
        super().__init__(detail or f"IVE extension '{extension_id}' is not installed or enabled")


def edition() -> str:
    profile = os.environ.get("IVE_EDITION", "integrated-dev").strip()
    if profile not in _PROFILES:
        raise ValueError(f"Unknown IVE_EDITION: {profile!r}")
    return profile


def _roots() -> list[Path]:
    configured = os.environ.get("IVE_EXTENSION_PATHS")
    if configured is not None:
        return [Path(value).expanduser().resolve() for value in configured.split(os.pathsep) if value.strip()]
    if edition() == "integrated-dev":
        # Development convenience only. A shipped/team edition uses explicit
        # roots; never scan arbitrary workspace content for executable plugins.
        return [Path(__file__).resolve().parents[2] / "ive-extensions"]
    return []


def _selected(extension_id: str) -> bool:
    if not _ID.fullmatch(extension_id):
        return False
    profile = edition()  # validate even with an explicit selection
    value = os.environ.get("IVE_EXTENSIONS")
    if value is not None:
        selected = {item.strip() for item in value.split(",") if item.strip()}
        if any(not _ID.fullmatch(item) for item in selected):
            raise ValueError("IVE_EXTENSIONS must contain comma-separated extension IDs")
        return extension_id in selected
    return profile == "integrated-dev"


def _manifest(extension_id: str, visiting: frozenset[str] = frozenset()) -> tuple[Path, dict]:
    if not _selected(extension_id):
        raise ExtensionUnavailable(extension_id)
    if extension_id in visiting:
        raise ExtensionUnavailable(extension_id, "Cyclic IVE extension dependency")
    matches = []
    for root in _roots():
        package = root / extension_id
        candidate = package / "extension.json"
        if candidate.is_file():
            # Do not let a symlink in a configured collection substitute an
            # unrelated product/tree without making that root explicit.
            if not candidate.resolve().is_relative_to(root.resolve()):
                raise ExtensionUnavailable(extension_id, "Extension manifest escapes its configured root")
            matches.append((package.resolve(), candidate))
    if len(matches) != 1:
        raise ExtensionUnavailable(extension_id, f"Expected one installation of '{extension_id}', found {len(matches)}")
    package, candidate = matches[0]
    try:
        data = json.loads(candidate.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ExtensionUnavailable(extension_id, "Unreadable IVE extension manifest") from exc
    if (not isinstance(data, dict) or data.get("id") != extension_id
            or isinstance(data.get("api_version"), bool)
            or data.get("api_version") != API_VERSION):
        raise ExtensionUnavailable(extension_id, "Unsupported IVE extension manifest")
    requires = data.get("requires", [])
    if not isinstance(requires, list) or any(not isinstance(dep, str) or not _ID.fullmatch(dep) for dep in requires):
        raise ExtensionUnavailable(extension_id, "Invalid IVE extension dependencies")
    for dependency in requires:
        try:
            _manifest(dependency, visiting | {extension_id})
        except ExtensionUnavailable as exc:
            raise ExtensionUnavailable(extension_id, f"'{extension_id}' requires enabled extension '{dependency}'") from exc
    return package, data


def available(extension_id: str) -> bool:
    try:
        _manifest(extension_id)
        return True
    except (ExtensionUnavailable, ValueError):
        return False


def extension_path(extension_id: str, relative_file: str = "") -> Path:
    root, _data = _manifest(extension_id)
    relative = Path(relative_file)
    if relative.is_absolute() or ".." in relative.parts:
        raise ExtensionUnavailable(extension_id, "Extension resource must be package-relative")
    target = (root / relative).resolve()
    if not target.is_relative_to(root):
        raise ExtensionUnavailable(extension_id, "Extension resource escapes package")
    if not target.exists():
        raise ExtensionUnavailable(extension_id, f"Missing extension resource: {relative_file}")
    return target


def load_backend_module(extension_id: str, relative_file: str):
    """Load a trusted Python resource once, refusing disabled installations.

    Cache identity includes the resolved source path. Changing selected roots
    cannot reuse a module from a different installation. Source edits still
    require a process restart; this is not a hot-reload or isolation boundary.
    """
    path = extension_path(extension_id, relative_file)
    if path.suffix != ".py" or not path.is_file():
        raise ExtensionUnavailable(extension_id, "Backend resource must be a Python source file")
    digest = hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:20]
    name = "_ive_resource_" + extension_id.replace("-", "_") + "_" + digest
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ExtensionUnavailable(extension_id, "Invalid extension Python resource")
    module = importlib.util.module_from_spec(spec)
    module.__ive_extension__ = extension_id
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


def load_legacy_namespace(namespace: dict[str, Any], extension_id: str, relative_file: str) -> None:
    """Load relocated code without changing its existing import/patch identity.

    Compatibility only. New extensions should use the host registration API.
    The real source path is retained for package-owned assets and tracebacks.
    """
    path = extension_path(extension_id, relative_file)
    if path.suffix != ".py" or not path.is_file():
        raise ExtensionUnavailable(extension_id, "Legacy entry must be a Python source file")
    namespace["__file__"] = str(path)
    namespace["__ive_extension__"] = extension_id
    if path.name == "__init__.py":
        namespace["__path__"] = [str(path.parent)]
        # Resource readers consult the package spec/loader, not just __file__.
        # Keep package-owned assets in the relocated package for both APIs.
        spec = importlib.util.spec_from_file_location(namespace["__name__"], path,
                                                     submodule_search_locations=[str(path.parent)])
        namespace["__spec__"] = spec
        namespace["__loader__"] = spec.loader if spec is not None else None
    exec(compile(path.read_bytes(), str(path), "exec"), namespace)


def load_legacy_fragment(namespace: dict[str, Any], extension_id: str, relative_file: str) -> None:
    """Transitional source-only cut of a mixed module, retaining host identity.

    Unlike a complete legacy module move, a fragment must not replace the host
    module's file/package metadata. Functions keep the existing globals so old
    test patches, callbacks and process state still refer to the same objects.
    This is trusted code, not an isolation boundary or the final explicit-port
    API. Fragment-owned assets must resolve through extension_path, not __file__.
    """
    path = extension_path(extension_id, relative_file)
    if path.suffix != ".py" or not path.is_file():
        raise ExtensionUnavailable(extension_id, "Legacy fragment must be a Python source file")
    exec(compile(path.read_bytes(), str(path), "exec"), namespace)


def load_legacy_fragments(namespace: dict[str, Any], module_name: str) -> None:
    """Compose declared fragments once while their existing host imports.

    Call after defining the host services and before constructing the app.
    This is a restart-only compatibility bridge, not a hot-unload lifecycle.
    """
    for metadata in installed_extensions():
        extension_id = metadata["id"]
        _root, manifest = _manifest(extension_id)
        contributions = manifest.get("legacy_namespace_fragments", {})
        if not isinstance(contributions, dict):
            raise ExtensionUnavailable(extension_id, "Invalid namespace contributions")
        fragments = contributions.get(module_name, [])
        if isinstance(fragments, str):
            fragments = [fragments]
        if not isinstance(fragments, list) or any(not isinstance(path, str) for path in fragments):
            raise ExtensionUnavailable(extension_id, "Invalid namespace fragment paths")
        for relative_file in fragments:
            load_legacy_fragment(namespace, extension_id, relative_file)


def legacy_config_value(name: str):
    """Resolve an explicitly exported private setting without core defaults.

    Only selected manifests are inspected; unrelated settings modules are not
    imported. Conflicting providers fail rather than selecting an arbitrary one.
    Returned values are never copied into core config's global dictionary.
    """
    providers = []
    for metadata in installed_extensions():
        extension_id = metadata["id"]
        _root, manifest = _manifest(extension_id)
        backend = manifest.get("backend") or {}
        contribution = backend.get("config") if isinstance(backend, dict) else None
        if contribution is None:
            continue
        if not isinstance(contribution, dict):
            raise ExtensionUnavailable(extension_id, "Invalid configuration contribution")
        exports = contribution.get("exports")
        entry = contribution.get("entry")
        fallback = contribution.get("fallback", False)
        if (not isinstance(exports, list) or not isinstance(entry, str)
                or not isinstance(fallback, bool)
                or any(not isinstance(key, str) or not key.isidentifier() for key in exports)):
            raise ExtensionUnavailable(extension_id, "Invalid configuration exports")
        if name in exports:
            providers.append((extension_id, entry, fallback))
    if not providers:
        raise AttributeError(name)
    # An owning product can declare defaults for its own external adapter when
    # the dedicated integration provider is not selected. Explicit primary
    # providers take precedence; equal-priority conflicts still fail closed.
    providers = [provider for provider in providers if not provider[2]] or providers
    if len(providers) != 1:
        raise RuntimeError(f"Conflicting extension configuration providers for {name}")
    extension_id, entry, _fallback = providers[0]
    return getattr(load_backend_module(extension_id, entry), name)


def installed_extensions() -> list[dict[str, Any]]:
    """Non-executing, path-free capability metadata for the host UI."""
    ids: set[str] = set()
    for root in _roots():
        if root.is_dir():
            ids.update(path.name for path in root.iterdir() if path.is_dir() and _ID.fullmatch(path.name))
    result = []
    for extension_id in sorted(ids):
        if not available(extension_id):
            continue
        _root, data = _manifest(extension_id)
        result.append({
            "id": extension_id, "api_version": API_VERSION,
            "ownership": data.get("ownership", "unspecified"),
            "visibility": data.get("visibility", "private"),
            "requires": data.get("requires", []),
        })
    return result


def register_extensions(app, host: dict[str, Any] | None = None) -> None:
    """Register trusted installed backends before the aiohttp router freezes.

    Existing authentication/authorization middleware remains on the host. An
    extension owns its route handlers and must retain per-operation guards.
    """
    for metadata in installed_extensions():
        extension_id = metadata["id"]
        _root, data = _manifest(extension_id)
        backend = data.get("backend") or {}
        entry = backend.get("entry") if isinstance(backend, dict) else None
        if not entry:
            continue
        path = extension_path(extension_id, entry)
        name = "_ive_extension_" + extension_id.replace("-", "_")
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise ExtensionUnavailable(extension_id, "Invalid extension backend entry")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
            register = getattr(module, "register", None)
            if not callable(register):
                raise ExtensionUnavailable(extension_id, "Extension entry has no register(app, host)")
            register(app, host or {})
        except BaseException:
            sys.modules.pop(name, None)
            raise


async def manifest_handler(_request):
    from aiohttp import web
    return web.json_response({"edition": edition(), "extensions": installed_extensions()})
