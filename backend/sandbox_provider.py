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


RUNTIME_NONE = "none"


def detect_runtime(which_fn=None) -> str:
    return RUNTIME_NONE


async def probe(**kwargs) -> dict:
    return {
        "runtime": RUNTIME_NONE, "available": False,
        "reason": "sandbox extension unavailable", "version": "",
        "can_run_app": False, "can_run_browser": False,
        "egress": {"filtering": "impossible", "isolation": "impossible"},
        "features": {}, "notes": [],
    }


def clear_cache() -> None:
    pass


async def readiness() -> dict:
    import os
    truthy = {"1", "true", "yes", "on"}
    return {"runtime": await probe(), "tiers": {
        tier: {"enabled": os.environ.get(flag, "").strip().lower() in truthy,
               "supported": False, "usable": False}
        for tier, flag in (("app", "IVE_APP_CONTAINER"),
                           ("browser", "IVE_BROWSER_CONTAINER"))
    }}


if _extension_available("sandbox"):
    _load_extension(globals(), "sandbox", "backend/sandbox_provider.py")

