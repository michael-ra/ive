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


def _deny_runtime(cmd, **kwargs) -> dict:
    return {
        "returncode": 126, "stdout": "",
        "stderr": "sandbox extension unavailable; refusing runtime execution",
        "timed_out": False, "killed": True,
        "network": kwargs.get("network", "none"),
        "allowed_hosts": list(kwargs.get("allowed_hosts") or ()),
    }


run_sandboxed = _deny_runtime


def select_runtime(name=None):
    return _deny_runtime


def run_in_selected_runtime(cmd, *, runtime=None, **kwargs) -> dict:
    return _deny_runtime(cmd, **kwargs)


if _extension_available("sandbox"):
    _load_extension(globals(), "sandbox", "backend/sandbox_runtime.py")
    from functools import wraps as _wraps

    _runtime_run = run_sandboxed
    _runtime_select = select_runtime
    _runtime_dispatch = run_in_selected_runtime

    @_wraps(_runtime_run)
    def run_sandboxed(cmd, **kwargs):
        if not _extension_available("sandbox"):
            return _deny_runtime(cmd, **kwargs)
        return _runtime_run(cmd, **kwargs)

    def select_runtime(name=None):
        if not _extension_available("sandbox"):
            return _deny_runtime
        return _runtime_select(name)

    @_wraps(_runtime_dispatch)
    def run_in_selected_runtime(cmd, *, runtime=None, **kwargs):
        if not _extension_available("sandbox"):
            return _deny_runtime(cmd, **kwargs)
        return _runtime_dispatch(cmd, runtime=runtime, **kwargs)
