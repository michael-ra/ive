"""Core sandbox launch contract. Requested containment must never become host execution.

Adapters live in the optional sandbox extension. Explicit none remains the
user-selected host mode; missing, unsupported, or failing adapters deny launch.
The legacy opaque boundary argument remains for installed integrations only.
"""
import shlex as _core_shlex

from extension_host import available as _extension_available
from extension_host import load_legacy_namespace as _load_extension


class SandboxUnavailable(RuntimeError):
    def __init__(self, reason: str, message: str | None = None):
        self.reason = reason
        super().__init__(message or reason)


def _core_deny(reason: str) -> list[str]:
    message = f"SANDBOX FAIL-CLOSED: {reason}; refusing to run unsandboxed"
    return ["/bin/sh", "-c", f"echo {_core_shlex.quote(message)} >&2; exit 126"]


_extension_wrap = None
if _extension_available("sandbox"):
    _load_extension(globals(), "sandbox", "backend/sandbox_engine.py")
    _extension_wrap = wrap_command_for_sandbox


def wrap_command_for_sandbox(
    cmd: list[str], workspace_path: str, sandbox_type: str, sandbox_network: bool,
    session_id: str, extra_env: dict, ctx: dict | None = None,
    boundary: dict | None = None,
) -> list[str]:
    requested = str(sandbox_type or "none").strip().lower()
    if requested == "none":
        return cmd
    if not _extension_available("sandbox") or _extension_wrap is None:
        return _core_deny("sandbox extension unavailable")
    try:
        wrapped = _extension_wrap(cmd, workspace_path, requested, sandbox_network,
                                  session_id, extra_env, ctx=ctx, boundary=boundary)
    except Exception as error:
        # A broken adapter must not turn a containment request into host work.
        return _core_deny(f"sandbox adapter failed ({type(error).__name__})")
    if not wrapped or wrapped == cmd:
        return _core_deny(f"sandbox adapter did not provide isolation for {requested}")
    return wrapped

