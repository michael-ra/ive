"""Non-Docker process-isolation sandbox tier + egress BOUNDARY allowlist hook.

This is the LIGHT isolation tier for running local subprocess work safely:
process-level confinement (minimal env, confined cwd, wall-clock timeout, and
``resource.setrlimit`` caps) WITHOUT a kernel/network namespace. It is "~free"
and same-kernel, matching the **Process sandbox** row in the sandbox tier table
(vision/SANDBOX_ARCHITECTURE.md §0).

  Browser sandbox  → app-level (Docker)
  Process sandbox  → THIS MODULE (Seatbelt/bubblewrap also live here)   ← light
  Container        → Docker (the DEFAULT runtime decision, 2026-06-06)  ← higher
  Hard-iso microVM → Firecracker / Apple `container`                    ← highest

HIGHER TIER ON HOLD (documented, not built here):
  The Docker container tier (OrbStack on mac → containerd on Linux prod) and the
  hard-isolation micro-VM tier (Firecracker / Apple ``container``) are the
  stronger boundaries. Per the 2026-06-06 decision, Docker is the eventual
  DEFAULT runtime, but it is **currently on hold** — this module is the stopgap
  that confines local subprocess work without requiring a container runtime.
  This tier does NOT provide a kernel boundary or a real network namespace; for
  untrusted/hostile code, escalate to the container/micro-VM tier when built.

What this module is HONEST about (limits — same as the rest of the design):
  • Same-kernel: ``setrlimit`` + minimal env raise the cost of a misbehaving
    subprocess but do NOT contain a determined attacker the way a VM does.
  • ``network='none'`` here is ADVISORY at this tier — without a network
    namespace we cannot truly cut the socket layer from a single subprocess.
    The real enforcement point is the egress proxy at the container/VM network
    (vision §3). :func:`check_egress` / :class:`EgressPolicy` implement the
    deny-default BOUNDARY allowlist *decision* so callers (and the future proxy)
    share one matching rule. Decision logic mirrors ``egress_policy.py`` (the
    richer supply-chain allowlist-deriver) on purpose — same label-boundary
    anchoring — but this module is intentionally dependency-free.

Pure stdlib only: subprocess, resource, shlex, os, signal (+ re for matching).
"""
from __future__ import annotations

import os
import re
import shlex
import signal
import subprocess
from dataclasses import dataclass, field
from typing import Iterable, Sequence

try:
    # POSIX-only. Absent on Windows; every setrlimit call is guarded below so
    # the module still imports and run_sandboxed still works (sans rlimits).
    import resource  # type: ignore
except ImportError:  # pragma: no cover - non-POSIX hosts
    resource = None  # type: ignore


# A deliberately MINIMAL, safe PATH handed to sandboxed subprocesses. We never
# inherit the caller's PATH (which can point at attacker-writable dirs or pull
# in shimmed tooling). Homebrew prefixes are included so common dev tools still
# resolve on macOS/Linux without leaking the full host environment.
SAFE_PATH = ":".join([
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/opt/homebrew/bin",  # Apple-Silicon Homebrew
    "/opt/homebrew/sbin",
])

# Default resource limits for a sandboxed run. Conservative but generous enough
# for typical build/test commands. Tunable per-call via the limits override.
# Values are in the units setrlimit expects (seconds / bytes / count).
DEFAULT_LIMITS: dict[str, int] = {
    "cpu_seconds": 30,                 # RLIMIT_CPU — CPU time (SIGXCPU then SIGKILL)
    "address_space": 2 * 1024 ** 3,    # RLIMIT_AS  — 2 GiB virtual memory ceiling
    "file_size": 256 * 1024 ** 2,      # RLIMIT_FSIZE — 256 MiB max single file write
    "open_files": 256,                 # RLIMIT_NOFILE — open file descriptors
}


# ── Egress BOUNDARY allowlist ───────────────────────────────────────────────
# DNS label: 1–63 chars, alnum + internal hyphens. Used to anchor wildcard
# matches on label boundaries so "npmjs.org.attacker.com" cannot match
# "*.npmjs.org" via a naive suffix check. Mirrors egress_policy._LABEL.
_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"


def _normalize_host(host: str) -> str:
    """Lowercase, strip scheme/userinfo/path/port and surrounding dots.

    ``"https://user@API.Example.com:443/x"`` -> ``"api.example.com"``. We strip
    any userinfo BEFORE taking the host so a crafted URL like
    ``"https://good.com@evil.com"`` resolves to the real authority host
    (``evil.com``), never the userinfo label.
    """
    h = (host or "").strip()
    if not h:
        return ""
    # Drop scheme.
    if "://" in h:
        h = h.split("://", 1)[1]
    # Drop path/query/fragment.
    for sep in ("/", "?", "#"):
        h = h.split(sep, 1)[0]
    # Drop userinfo (anything before the last '@' in the authority).
    if "@" in h:
        h = h.rsplit("@", 1)[1]
    # Drop port (bracket-safe for IPv6 literals).
    if h.startswith("["):
        h = h.partition("]")[0] + "]"
    elif ":" in h:
        maybe_host, _, maybe_port = h.rpartition(":")
        if maybe_port.isdigit():
            h = maybe_host
    return h.lower().strip(".")


def _host_matches(pattern: str, host: str) -> bool:
    """True if ``host`` matches allowlist ``pattern`` on DNS label boundaries.

    Exact match is case-insensitive. A leading ``*.`` is a wildcard over one or
    more leading labels, anchored so an attacker-appended suffix cannot bypass
    it. Examples::

        _host_matches("api.example.com", "api.example.com")          -> True
        _host_matches("api.example.com", "api.example.com.evil.io")  -> False
        _host_matches("*.npmjs.org",     "registry.npmjs.org")       -> True
        _host_matches("*.npmjs.org",     "a.b.npmjs.org")            -> True
        _host_matches("*.npmjs.org",     "npmjs.org")                -> False
        _host_matches("*.npmjs.org",     "npmjs.org.attacker.com")   -> False
    """
    pat = (pattern or "").lower().strip(".")
    h = _normalize_host(host)
    if not pat or not h:
        return False
    if pat.startswith("*."):
        suffix = pat[2:]
        if not suffix:
            return False
        regex = r"^(?:" + _LABEL + r"\.)+" + re.escape(suffix) + r"$"
        return re.match(regex, h) is not None
    return pat == h


def check_egress(host: str, allowed_hosts: Iterable[str]) -> bool:
    """BOUNDARY allowlist check: may a connection to ``host`` proceed?

    Deny-default: returns True ONLY if ``host`` matches an entry in
    ``allowed_hosts`` (exact or ``*.`` wildcard, label-boundary anchored).
    An empty/None allowlist denies everything — the safe posture. This is the
    decision the egress proxy will enforce at the container/VM network once the
    higher tier ships; at the process tier it is advisory (see module docstring).
    """
    if not host:
        return False
    for pattern in (allowed_hosts or ()):
        if _host_matches(pattern, host):
            return True
    return False


@dataclass
class EgressPolicy:
    """Small deny-default egress policy: allowlist + explicit blocklist.

    ``blocked`` always wins over ``allowed``. Decision rule matches
    :func:`check_egress` (label-boundary anchored, deny-default). For the
    richer supply-chain allowlist-DERIVER (manifest parsing, proxy-config
    generation, allow/deny policy import) use ``egress_policy.EgressPolicy``;
    this one is the lightweight check that ships with the process sandbox.
    """

    allowed: list[str] = field(default_factory=list)
    blocked: list[str] = field(default_factory=list)
    default_deny: bool = True

    def __post_init__(self) -> None:
        # Normalize: drop empties/whitespace, preserve order.
        self.allowed = [e.strip() for e in (self.allowed or []) if e and e.strip()]
        self.blocked = [e.strip() for e in (self.blocked or []) if e and e.strip()]

    def is_allowed(self, host: str) -> bool:
        """True iff ``host`` may be reached under this policy."""
        if not _normalize_host(host):
            return False
        # Explicit block always wins.
        if any(_host_matches(b, host) for b in self.blocked):
            return False
        if check_egress(host, self.allowed):
            return True
        # Nothing matched -> default posture.
        return not self.default_deny

    def to_dict(self) -> dict:
        return {
            "allowed": list(self.allowed),
            "blocked": list(self.blocked),
            "default_deny": self.default_deny,
        }


# ── Process sandbox ─────────────────────────────────────────────────────────
def _build_min_env(env_allowlist: Sequence[str]) -> dict[str, str]:
    """Construct a MINIMAL environment for the subprocess.

    Only keys named in ``env_allowlist`` are copied from the parent env; every
    other host variable (API keys, tokens, AWS creds, ...) is dropped. A safe
    PATH and a benign locale are always set. PATH is deliberately NOT taken from
    the parent even if 'PATH' is allowlisted — we force :data:`SAFE_PATH`.
    """
    env: dict[str, str] = {
        "PATH": SAFE_PATH,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }
    for key in env_allowlist or ():
        if key == "PATH":
            # Never let the caller widen PATH back to the host's — that would
            # reintroduce the attacker-writable-dir risk SAFE_PATH closes.
            continue
        val = os.environ.get(key)
        if val is not None:
            env[key] = val
    return env


def _make_preexec(limits: dict[str, int]):
    """Return a preexec_fn that applies rlimits + starts a new process group.

    Runs in the CHILD after fork, before exec. The new session/process group
    (``os.setsid``) lets us SIGKILL the whole tree on timeout — a shell that
    spawns children would otherwise outlive a kill aimed at just the leader.
    rlimits are best-effort and individually guarded so an unsupported limit on
    one platform never aborts the launch.
    """
    if os.name != "posix":  # pragma: no cover - non-POSIX hosts
        return None

    def _preexec() -> None:  # pragma: no cover - runs in forked child
        # Detach into our own session/process group for group-kill on timeout.
        try:
            os.setsid()
        except OSError:
            pass
        if resource is None:
            return
        # Map our friendly names to (RLIMIT constant, value). Each is wrapped:
        # macOS notably refuses RLIMIT_AS for some processes, so we never let a
        # single rejected limit take down the whole run.
        plan = [
            ("RLIMIT_CPU", limits.get("cpu_seconds")),
            ("RLIMIT_AS", limits.get("address_space")),
            ("RLIMIT_FSIZE", limits.get("file_size")),
            ("RLIMIT_NOFILE", limits.get("open_files")),
        ]
        for name, value in plan:
            if value is None:
                continue
            rlimit_const = getattr(resource, name, None)
            if rlimit_const is None:
                continue  # limit not defined on this platform
            try:
                soft, hard = resource.getrlimit(rlimit_const)
                # Don't exceed an existing hard ceiling; clamp to it.
                new_hard = hard if hard != resource.RLIM_INFINITY and hard < value else value
                resource.setrlimit(rlimit_const, (new_hard, new_hard))
            except (ValueError, OSError):
                # Unsupported on this OS (e.g. RLIMIT_AS on macOS) — skip it.
                continue

    return _preexec


def _kill_group(proc: subprocess.Popen, sig: int) -> None:
    """Signal the subprocess's whole process group, falling back to the pid.

    Because we ``setsid`` in the child, the child's pid IS its process-group
    id, so ``killpg`` reaps any grandchildren too. On non-POSIX or if the group
    is already gone, fall back to killing the leader directly.
    """
    try:
        if os.name == "posix":
            os.killpg(proc.pid, sig)
        else:  # pragma: no cover - non-POSIX hosts
            proc.send_signal(sig)
    except (ProcessLookupError, OSError):
        try:
            proc.send_signal(sig)
        except (ProcessLookupError, OSError):
            pass


def run_sandboxed(
    cmd,
    *,
    cwd: str | None = None,
    env_allowlist: Sequence[str] = (),
    timeout: float = 30,
    network: str = "none",
    allowed_hosts: Sequence[str] = (),
    limits: dict[str, int] | None = None,
) -> dict:
    """Run ``cmd`` as a confined subprocess and return a structured result.

    Confinement applied:
      • MINIMAL env — only ``env_allowlist`` keys + a forced safe PATH/locale
        (host secrets are NOT inherited). See :func:`_build_min_env`.
      • Confined cwd — runs in ``cwd`` (default: current dir). The caller is
        responsible for pointing this at the sandbox workspace; we resolve it
        and fail fast if it doesn't exist.
      • Wall-clock timeout — killed (whole process group) on expiry.
      • Resource limits via ``resource.setrlimit`` where available (CPU time,
        address space, file size, open files), each guarded for macOS.

    Args:
      cmd: a list of args (preferred) OR a string (split safely via shlex —
        NEVER run through a shell, so no shell-injection surface).
      cwd: working directory to confine to (must exist).
      env_allowlist: env var names to pass through (PATH is always forced safe).
      timeout: wall-clock seconds before the process group is killed.
      network: advisory at this tier. ``'none'`` documents intent that the run
        should not touch the network; true enforcement is the egress proxy at
        the higher (container/VM) tier. Recorded back in the result for callers.
      allowed_hosts: BOUNDARY allowlist carried alongside the run for the egress
        layer; checked via :func:`check_egress` by whatever enforces the network.
      limits: optional override of :data:`DEFAULT_LIMITS` (per-key merge).

    Returns:
      ``{returncode, stdout, stderr, timed_out, killed, network, allowed_hosts}``.
      On launch failure (e.g. binary not found) returncode is 127 and stderr
      carries the reason — we never raise out of a sandbox run.
    """
    # Accept either a string or an argv list; shlex.split avoids shell=True.
    if isinstance(cmd, str):
        argv = shlex.split(cmd)
    else:
        argv = list(cmd)
    if not argv:
        return {
            "returncode": 127,
            "stdout": "",
            "stderr": "empty command",
            "timed_out": False,
            "killed": False,
            "network": network,
            "allowed_hosts": list(allowed_hosts or ()),
        }

    run_cwd = os.path.abspath(cwd) if cwd else os.getcwd()
    if not os.path.isdir(run_cwd):
        return {
            "returncode": 127,
            "stdout": "",
            "stderr": f"cwd does not exist: {run_cwd}",
            "timed_out": False,
            "killed": False,
            "network": network,
            "allowed_hosts": list(allowed_hosts or ()),
        }

    merged_limits = dict(DEFAULT_LIMITS)
    if limits:
        merged_limits.update(limits)

    env = _build_min_env(env_allowlist)
    preexec = _make_preexec(merged_limits)

    timed_out = False
    killed = False

    try:
        proc = subprocess.Popen(
            argv,
            cwd=run_cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,  # no interactive input to a sandboxed run
            text=True,
            preexec_fn=preexec,  # None on non-POSIX -> standard behavior
            close_fds=True,
        )
    except (FileNotFoundError, PermissionError, OSError) as e:
        # Don't leak an exception out of the sandbox boundary — report it.
        return {
            "returncode": 127,
            "stdout": "",
            "stderr": f"failed to launch: {e}",
            "timed_out": False,
            "killed": False,
            "network": network,
            "allowed_hosts": list(allowed_hosts or ()),
        }

    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        # Escalate SIGTERM -> SIGKILL across the whole process group so a shell
        # that forked children can't survive the kill.
        timed_out = True
        killed = True
        _kill_group(proc, signal.SIGTERM)
        try:
            stdout, stderr = proc.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            _kill_group(proc, signal.SIGKILL)
            try:
                stdout, stderr = proc.communicate(timeout=3)
            except subprocess.TimeoutExpired:  # pragma: no cover - extreme case
                stdout, stderr = "", "process did not die after SIGKILL"

    return {
        "returncode": proc.returncode,
        "stdout": stdout or "",
        "stderr": stderr or "",
        "timed_out": timed_out,
        "killed": killed,
        "network": network,
        "allowed_hosts": list(allowed_hosts or ()),
    }


# ── Runtime selection seam (additive; default 'process' = this module) ───────
# The single dispatch point so callers don't branch on the configured runtime.
# Default 'process' returns this module's run_sandboxed unchanged. 'daytona'
# returns the inert Daytona adapter (lazy import, fail-closed when unconfigured).
# 'docker' is supported by the separate PTY/container adapter, not this one-shot
# primitive: selecting it here must deny rather than run a weaker process tier.
_TRUE_SET = {"1", "true", "yes", "on"}


def select_runtime(name: str | None = None):
    """Return a callable with the run_sandboxed signature for the chosen tier.

    ``name`` (or SANDBOX_RUNTIME env, default 'process'):
      • 'process' / 'local' -> this module's :func:`run_sandboxed`.
      • 'daytona'           -> the Daytona adapter's run_sandboxed (lazy import;
        inert/fail-closed unless DAYTONA_API_URL+KEY are set AND the SDK exists).
      • 'docker' / unknown  -> deny; these are not implemented by this one-shot
        selector. The separate PTY adapter does implement Docker execution.
    """
    chosen = (name or os.environ.get("SANDBOX_RUNTIME") or "process").strip().lower()
    if chosen == "daytona":
        try:
            from sandbox_daytona import DaytonaRuntime
            return DaytonaRuntime().run_sandboxed
        except Exception:
            return _unavailable_runtime
    if chosen in {"process", "local"}:
        return run_sandboxed
    return _unavailable_runtime


def _unavailable_runtime(cmd, **kwargs) -> dict:
    """Never substitute process execution for a missing isolation adapter."""
    return {
        "returncode": 126, "stdout": "",
        "stderr": "Selected one-shot runtime is unavailable; refusing process fallback",
        "timed_out": False, "killed": True,
        "network": kwargs.get("network", "none"),
        "allowed_hosts": list(kwargs.get("allowed_hosts") or ()),
    }


def run_in_selected_runtime(cmd, *, runtime: str | None = None, **kwargs) -> dict:
    """Convenience: dispatch ``cmd`` through :func:`select_runtime`'s callable.

    Keeps the result schema identical regardless of tier. ``policy`` is accepted
    and forwarded only to adapters that take it (the Daytona adapter) so the
    in-process tier signature is unchanged.
    """
    fn = select_runtime(runtime)
    # The local tier's run_sandboxed has no 'policy' kwarg; drop it for that tier.
    if fn is run_sandboxed:
        kwargs.pop("policy", None)
    return fn(cmd, **kwargs)


if __name__ == "__main__":
    # ── Self-test: process sandbox + egress allowlist ───────────────────────
    # Run: /usr/local/bin/python3.13 sandbox_runtime.py
    print("sandbox_runtime self-test")

    # 1. A trivial command runs and returns its output, env-minimized.
    res = run_sandboxed(["echo", "hi"], timeout=5)
    assert res["returncode"] == 0, res
    assert res["stdout"].strip() == "hi", res
    assert res["timed_out"] is False, res
    assert res["killed"] is False, res
    print("  [ok] echo hi ->", repr(res["stdout"].strip()))

    # 2. The minimal env is enforced: a host secret is NOT visible inside the
    #    sandbox unless explicitly allowlisted; an allowlisted var IS.
    os.environ["SANDBOX_SELFTEST_SECRET"] = "leak-me"
    os.environ["SANDBOX_SELFTEST_OK"] = "passthrough"
    leaked = run_sandboxed(
        'python3 -c "import os;print(os.environ.get(\'SANDBOX_SELFTEST_SECRET\',\'<absent>\'))"',
        env_allowlist=(),
        timeout=10,
    )
    assert leaked["stdout"].strip() == "<absent>", leaked
    allowed = run_sandboxed(
        'python3 -c "import os;print(os.environ.get(\'SANDBOX_SELFTEST_OK\',\'<absent>\'))"',
        env_allowlist=("SANDBOX_SELFTEST_OK",),
        timeout=10,
    )
    assert allowed["stdout"].strip() == "passthrough", allowed
    print("  [ok] minimal env: secret dropped, allowlisted var passed through")

    # 3. Wall-clock timeout kills a hung process.
    slow = run_sandboxed(["sleep", "10"], timeout=1)
    assert slow["timed_out"] is True, slow
    assert slow["killed"] is True, slow
    print("  [ok] timeout killed a 10s sleep at 1s")

    # 4. Egress allowlist: allow exact + wildcard, deny everything else, and
    #    resist the suffix-bypass attack.
    allow = ("registry.npmjs.org", "*.pypi.org")
    assert check_egress("registry.npmjs.org", allow) is True
    assert check_egress("files.pypi.org", allow) is True
    assert check_egress("evil.com", allow) is False
    assert check_egress("npmjs.org.attacker.com", allow) is False  # suffix bypass
    assert check_egress("https://files.pypi.org/x", allow) is True  # URL normalized
    assert check_egress("anything", ()) is False  # empty allowlist = deny-all
    print("  [ok] egress allow/deny + suffix-bypass resistance")

    # 5. EgressPolicy: explicit block beats allow; default-deny posture.
    pol = EgressPolicy(allowed=["*.example.com"], blocked=["bad.example.com"])
    assert pol.is_allowed("api.example.com") is True
    assert pol.is_allowed("bad.example.com") is False  # block wins
    assert pol.is_allowed("other.com") is False        # deny-default
    print("  [ok] EgressPolicy block-wins + deny-default")

    # 6. select_runtime: default 'process' dispatches to THIS module unchanged.
    os.environ.pop("SANDBOX_RUNTIME", None)
    assert select_runtime() is run_sandboxed
    assert select_runtime("process") is run_sandboxed
    assert select_runtime("unknown-tier")(["echo", "no"])["returncode"] == 126
    sel = run_in_selected_runtime(["echo", "via-selector"], timeout=5)
    assert sel["returncode"] == 0 and sel["stdout"].strip() == "via-selector", sel
    print("  [ok] select_runtime default 'process' -> in-process run_sandboxed")

    print("ALL SELF-TESTS PASSED")
