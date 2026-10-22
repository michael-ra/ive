"""Optional trusted research command/completion contributions.

Ordinary research has no storage-provider dependency. Product commands and
post-run output actions are composed only from explicitly selected extensions;
their arguments, result formats and clients remain with the owner.
"""
from __future__ import annotations

import importlib
import json


def _host():
    # Both IVE's backend launcher and ``python -m deep_research`` are supported.
    # A standalone research installation without the host has no contributions.
    for name in ("extension_host", "backend.extension_host"):
        try:
            return importlib.import_module(name)
        except ModuleNotFoundError as exc:
            if exc.name not in (name, name.split(".")[0]):
                raise
    return None


def load_owner_module(owner: str, relative_file: str):
    """Compatibility helper for selected product clients, never discovery."""
    host = _host()
    if host is None:
        raise RuntimeError("No extension host is available for this research client")
    return host.load_backend_module(owner, relative_file)


def _cli_providers():
    host = _host()
    if host is None:
        return []
    result = []
    for metadata in host.installed_extensions():
        owner = metadata["id"]
        manifest = json.loads(host.extension_path(owner, "extension.json").read_text(encoding="utf-8"))
        backend = manifest.get("backend") or {}
        contribution = backend.get("research_cli") if isinstance(backend, dict) else None
        if contribution is None:
            continue
        if (not isinstance(contribution, dict)
                or not isinstance(contribution.get("entry"), str)):
            raise ValueError(f"Invalid research command contribution: {owner}")
        provider = host.load_backend_module(owner, contribution["entry"])
        if not callable(getattr(provider, "register_cli", None)):
            raise ValueError(f"Missing research command registrar: {owner}")
        result.append(provider)
    return result


def register_cli(subparsers, research_parser) -> None:
    for provider in _cli_providers():
        provider.register_cli(subparsers, research_parser)


def after_research(args, config) -> None:
    """Notify selected output contributors after local results are saved."""
    for provider in _cli_providers():
        callback = getattr(provider, "after_research", None)
        if callable(callback):
            callback(args, config)
