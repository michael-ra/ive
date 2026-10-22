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


if _extension_available("sandbox"):
    _load_extension(globals(), "sandbox", "backend/sandbox_exec.py")

