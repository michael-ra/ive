"""Daytona RUNTIME ADAPTER — inert unless configured (fail-CLOSED).

This is an ADAPTER, not a server. It implements the SAME sandbox interface as
:func:`sandbox_runtime.run_sandboxed` so :func:`sandbox_runtime.select_runtime`
can dispatch to it transparently when ``SANDBOX_RUNTIME=daytona``. It NEVER
stands up a Daytona server, makes NO network call on import, and NEVER auto-
installs the Daytona SDK/CLI.

Behaviour matrix (mirrors the wave-5 fail-closed contract):
  • not configured (no DAYTONA_API_URL/DAYTONA_API_KEY)  -> available() False;
    every run returns the 126 fail-closed DENY dict (never runs un-isolated).
  • configured but SDK absent                             -> available() False;
    same 126 DENY.
  • configured + SDK present                              -> available() True,
    but the execution body is an inert NotImplemented-style stub that ALSO
    fails closed (126) this wave — selection + interface conformance only; the
    real remote-exec body lands when a Daytona server actually exists.

126 = "command cannot execute" (distinct from 127 = local launch failure used
by the in-process tier) so callers can tell "selected runtime unavailable"
apart from "binary not found".

Pure stdlib + a LAZY, guarded optional SDK import (mirrors sandbox_runtime's
``import resource`` guard). Constructing the runtime is pure; no I/O on import.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Sequence

# Distinct from the local tier's 127 launch-failure so callers/telemetry can
# tell "daytona selected but unavailable" from "local binary not found".
_DENY_RETURNCODE = 126


def _deny(reason: str, network: str, allowed_hosts) -> dict:
    """The fail-closed DENY result — same SCHEMA as run_sandboxed, never runs."""
    return {
        "returncode": _DENY_RETURNCODE,
        "stdout": "",
        "stderr": reason,
        "timed_out": False,
        "killed": True,  # treated as denied/killed, not a clean exit
        "network": network,
        "allowed_hosts": list(allowed_hosts or ()),
    }


@dataclass
class DaytonaConfig:
    """Daytona connection config, read from env. Inert unless both URL+key set."""

    api_url: str | None = None
    api_key: str | None = None
    target: str | None = None
    default_image: str | None = None

    @classmethod
    def from_env(cls) -> "DaytonaConfig":
        return cls(
            api_url=os.environ.get("DAYTONA_API_URL") or None,
            api_key=os.environ.get("DAYTONA_API_KEY") or None,
            target=os.environ.get("DAYTONA_TARGET") or None,
            default_image=os.environ.get("DAYTONA_IMAGE") or None,
        )

    def is_configured(self) -> bool:
        return bool(self.api_url and self.api_key)


def _sdk_available() -> bool:
    """True iff the Daytona SDK is importable — detect only, NEVER install.

    Lazy + guarded so the module imports cleanly with no SDK present (mirrors
    sandbox_runtime's ``import resource`` try/except). No network call here.
    """
    try:
        import importlib.util

        return importlib.util.find_spec("daytona_sdk") is not None
    except Exception:  # pragma: no cover - defensive
        return False


class DaytonaRuntime:
    """Daytona adapter. Pure to construct — no I/O, no network, no server."""

    def __init__(self, config: DaytonaConfig | None = None):
        # Construction is pure: just snapshot config. NO client init, NO health
        # check, NO network — an eager init would violate "no standing up
        # servers" and could hang startup.
        self.config = config or DaytonaConfig.from_env()

    def available(self) -> bool:
        """True only when configured AND the SDK is importable. Never installs."""
        return self.config.is_configured() and _sdk_available()

    def run_sandboxed(
        self,
        cmd,
        *,
        cwd: str | None = None,
        env_allowlist: Sequence[str] = (),
        timeout: float = 30,
        network: str = "none",
        allowed_hosts: Sequence[str] = (),
        limits: dict[str, int] | None = None,
        policy=None,
    ) -> dict:
        """Run ``cmd`` in a Daytona sandbox — INERT/fail-closed this wave.

        Same signature + return dict as :func:`sandbox_runtime.run_sandboxed`
        (plus an optional ``policy`` carrying the egress allowlist into a real
        remote sandbox). When the runtime is unavailable it FAILS CLOSED with a
        126 DENY rather than running un-isolated. The available()-true branch is
        a deliberate inert stub that ALSO fails closed until a Daytona server is
        wired — nothing ever runs un-isolated through this adapter.
        """
        if not self.config.is_configured():
            return _deny(
                "daytona runtime selected but not configured "
                "(set DAYTONA_API_URL and DAYTONA_API_KEY)",
                network,
                allowed_hosts,
            )
        if not _sdk_available():
            return _deny(
                "daytona runtime configured but the daytona SDK is not "
                "installed (not auto-installing — fail-closed)",
                network,
                allowed_hosts,
            )
        # Configured + SDK present: the remote-exec body is intentionally not
        # built this wave (we must not stand up a Daytona server). Fail closed
        # so nothing runs un-isolated.
        return _deny(
            "daytona runtime adapter is selected and configured but the "
            "remote execution path is not yet implemented (fail-closed)",
            network,
            allowed_hosts,
        )


# Module-level convenience matching the run_sandboxed free-function shape so the
# selector can dispatch to either a callable or an instance method.
def run_sandboxed(cmd, **kwargs) -> dict:
    return DaytonaRuntime().run_sandboxed(cmd, **kwargs)


def available() -> bool:
    return DaytonaRuntime().available()


if __name__ == "__main__":
    # ── Self-test: inert + fail-closed without config (no net, no install) ───
    print("sandbox_daytona self-test")
    # Ensure no stray env makes it look configured.
    for k in ("DAYTONA_API_URL", "DAYTONA_API_KEY"):
        os.environ.pop(k, None)
    rt = DaytonaRuntime()
    assert rt.available() is False, "must be unavailable without config"
    res = rt.run_sandboxed(["echo", "hi"], timeout=5)
    assert res["returncode"] == _DENY_RETURNCODE, res
    assert res["killed"] is True, res
    assert res["stdout"] == "", res
    assert "daytona" in res["stderr"].lower(), res
    print("  [ok] unconfigured -> 126 fail-closed deny, no network/install")

    # Configured-but-SDK-absent (the realistic env here) still denies closed.
    os.environ["DAYTONA_API_URL"] = "https://example.invalid"
    os.environ["DAYTONA_API_KEY"] = "dummy"
    rt2 = DaytonaRuntime()
    res2 = rt2.run_sandboxed(["echo", "hi"], timeout=5)
    assert res2["returncode"] == _DENY_RETURNCODE, res2
    print("  [ok] configured + no SDK -> still fail-closed deny")
    for k in ("DAYTONA_API_URL", "DAYTONA_API_KEY"):
        os.environ.pop(k, None)

    print("ALL SELF-TESTS PASSED")
