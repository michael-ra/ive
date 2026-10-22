"""Compatibility seam for the optional sandbox runtime extension.

Runtime implementation belongs to ive-extensions/sandbox, not IVE Workspace.
"""
from extension_host import available as _extension_available
from extension_host import load_legacy_namespace as _load_extension
from extension_host import ExtensionUnavailable as _ExtensionUnavailable


def __getattr__(name):
    if name.startswith("__"):
        raise AttributeError(name)
    raise _ExtensionUnavailable("sandbox", f"{__name__}.{name} requires the sandbox extension")


def container_mode_enabled(env=None) -> bool:
    import os
    values = os.environ if env is None else env
    return str(values.get("IVE_BROWSER_CONTAINER", "")).strip().lower() in {"1", "true", "yes", "on"}


if _extension_available("sandbox"):
    _load_extension(globals(), "sandbox", "backend/browser_container.py")

