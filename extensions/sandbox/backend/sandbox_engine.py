"""Sandboxing engine for IVE session containment.

Provides wrappers to launch CLI sessions under macOS sandbox-exec or Linux bubblewrap.

A higher-isolation 'docker' tier is also available: it runs the command inside a
fresh container with the workspace bind-mounted and (by default) the host
environment dropped. This requires the Docker daemon to be running and is the
strongest isolation tier in our model (see vision/SANDBOX_ARCHITECTURE).
"""

import os
import sys
import shlex
import shutil
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_TRUE_SET = {"1", "true", "yes", "on"}


class SandboxUnavailable(Exception):
    """Raised when isolation was requested but
    its backing binary is missing — the caller must refuse to launch rather than
    run un-sandboxed. Carries a machine-readable ``reason``.
    """

    def __init__(self, reason: str, message: str | None = None):
        self.reason = reason
        super().__init__(message or reason)


def _fail_closed_enabled() -> bool:
    """A requested containment boundary may not silently become host execution."""
    return True


def _deny_stub(reason: str) -> list[str]:
    """An argv that exits non-zero with a clear message — the fail-CLOSED stub.

    The PTY child execs this instead of the real command, so a missing sandbox
    binary becomes a hard DENY (exit 126) rather than an unsandboxed run.
    """
    msg = f"SANDBOX FAIL-CLOSED: {reason}; refusing to run unsandboxed"
    return ["/bin/sh", "-c", f'echo {shlex.quote(msg)} >&2; exit 126']

def generate_macos_sandbox_profile(workspace_path: str, sandbox_network: bool, session_id: str, extra_env: dict) -> str:
    """Generate a macOS seatbelt (sandbox-exec) profile file.
    
    Returns the path to the written .sb profile.
    """
    profile_path = f"/tmp/ive-sandbox-{session_id}.sb"
    
    # Resolve paths and escape them for Scheme strings
    workspace_esc = os.path.abspath(workspace_path).replace('"', '\\"')
    
    real_home = os.path.expanduser("~")
    real_home_esc = real_home.replace('"', '\\"')
    
    active_home = extra_env.get("HOME") or real_home
    active_home_esc = os.path.abspath(active_home).replace('"', '\\"')
    
    network_rule = "(allow network-outbound)" if sandbox_network else ""
    
    profile_content = f"""; IVE Session Sandbox Profile
(version 1)
(deny default)

;; Basic process controls
(allow process-fork)
(allow process-exec)
(allow sysctl-read)

;; System directories (Read-only)
(allow file-read* (subpath "/usr"))
(allow file-read* (subpath "/System"))
(allow file-read* (subpath "/Library"))
(allow file-read* (subpath "/private/var"))
(allow file-read* (subpath "/var"))
(allow file-read-data (path "/etc"))
(allow file-read* (subpath "/dev"))
(allow file-read* (subpath "/opt")) ; Essential for Homebrew on Apple Silicon

;; Executable paths
(allow file-read* (subpath "/bin"))
(allow file-read* (subpath "/sbin"))

;; Project Workspace (Read-Write)
(allow file-read* (subpath "{workspace_esc}"))
(allow file-write* (subpath "{workspace_esc}"))

;; Temporary paths
(allow file-read* file-write* (subpath "/tmp"))
(allow file-read* file-write* (subpath "/private/tmp"))

;; Real HOME path permissions
(allow file-read* (subpath "{real_home_esc}"))
(deny file-read* (subpath "{real_home_esc}/.ssh"))

;; Allow read-write to IVE and CLI configuration folders in real HOME
(allow file-read* file-write* (subpath "{real_home_esc}/.claude"))
(allow file-read* file-write* (subpath "{real_home_esc}/.gemini"))
(allow file-read* file-write* (subpath "{real_home_esc}/.ive"))
(allow file-read* file-write* (subpath "{real_home_esc}/.npm"))
(allow file-read* file-write* (subpath "{real_home_esc}/.config"))
(allow file-read* file-write* (subpath "{real_home_esc}/.cache"))
(allow file-read* file-write* (subpath "{real_home_esc}/.local"))
(allow file-read* file-write* (subpath "{real_home_esc}/.nvm"))

;; Active HOME path permissions (handles isolated account sandbox HOME)
(if (not (string=? "{real_home_esc}" "{active_home_esc}"))
    (begin
        (allow file-read* file-write* (subpath "{active_home_esc}"))
        (deny file-read* (subpath "{active_home_esc}/.ssh"))
    )
)

;; Allow read access to standard shell profile configs
(allow file-read* (path "{real_home_esc}/.zshrc"))
(allow file-read* (path "{real_home_esc}/.bashrc"))
(allow file-read* (path "{real_home_esc}/.bash_profile"))
(allow file-read* (path "{real_home_esc}/.profile"))
(allow file-read* (path "{real_home_esc}/.gitconfig"))

;; Network control
{network_rule}
"""
    
    with open(profile_path, "w", encoding="utf-8") as f:
        f.write(profile_content)
        
    logger.info(f"Generated macOS sandbox profile at {profile_path}")
    return profile_path

def wrap_command_for_sandbox(cmd: list[str], workspace_path: str, sandbox_type: str, sandbox_network: bool, session_id: str, extra_env: dict, ctx: dict | None = None, boundary: dict | None = None) -> list[str]:
    """Wrap the execution command list with sandbox commands based on host platform.

    Backward-compatible additive params (existing callers pass neither):
      • ``ctx``      — a mutable dict the function may stash an egress-proxy handle
        into under key ``"egress_proxy"`` so the CALLER (PTYSession) can tear it
        down later. The proxy outlives this synchronous call, so teardown
        ownership lives with the caller, not here.
      • ``boundary`` — an allow/deny network-policy dict used to build the egress policy
        when egress enforcement is on. None -> falls back to EGRESS_BOUNDARY_JSON
        env or an empty (deny-default) policy.

    FAIL-CLOSED: when a sandbox_type is requested but its backing binary is
    missing, return a deny-stub argv (exit 126) instead of the bare command.
    """
    if not sandbox_type or sandbox_type == "none":
        return cmd

    sandbox_type = sandbox_type.lower()
    fail_closed = _fail_closed_enabled()

    if sandbox_type == "sandbox-exec" or (sandbox_type == "auto" and sys.platform == "darwin"):
        # Verify sandbox-exec exists
        sandbox_exec_bin = shutil.which("sandbox-exec")
        if not sandbox_exec_bin:
            if fail_closed:
                logger.warning("sandbox-exec not found on macOS. FAIL-CLOSED: denying run.")
                return _deny_stub("sandbox-exec unavailable")
            logger.warning("sandbox-exec not found on macOS. Running un-sandboxed.")
            return cmd

        profile_path = generate_macos_sandbox_profile(workspace_path, sandbox_network, session_id, extra_env)
        return [sandbox_exec_bin, "-f", profile_path] + cmd

    elif sandbox_type == "bubblewrap" or (sandbox_type == "auto" and sys.platform.startswith("linux")):
        bwrap_bin = shutil.which("bwrap")
        if not bwrap_bin:
            if fail_closed:
                logger.warning("bwrap (Bubblewrap) not found on Linux. FAIL-CLOSED: denying run.")
                return _deny_stub("bubblewrap unavailable")
            logger.warning("bwrap (Bubblewrap) not found on Linux. Running un-sandboxed.")
            return cmd

        real_home = os.path.expanduser("~")
        active_home = extra_env.get("HOME") or real_home
        
        # Build bubblewrap arguments
        bwrap_cmd = [
            bwrap_bin,
            "--ro-bind", "/usr", "/usr",
            "--ro-bind", "/bin", "/bin",
            "--ro-bind", "/etc", "/etc",
            "--dir", "/tmp",
            "--proc", "/proc",
            "--dev", "/dev",
            "--bind", os.path.abspath(workspace_path), os.path.abspath(workspace_path),
            "--chdir", os.path.abspath(workspace_path),
        ]
        
        # Add basic paths that exist
        for path in ["/lib", "/lib64", "/sbin", "/opt", "/var"]:
            if os.path.exists(path):
                bwrap_cmd.extend(["--ro-bind", path, path])
                
        # Bubblewrap retains the host network unless explicitly unshared.
        if not sandbox_network:
            bwrap_cmd.append("--unshare-net")

        # Isolate home by mounting the active HOME first. For per-account
        # OAuth sandboxes, active_home already contains the CLI auth dir; do
        # not hide it by bind-mounting the real ~/.gemini or ~/.codex over it.
        active_home_path = Path(active_home)
        if active_home_path.exists():
            bwrap_cmd.extend(["--bind", active_home, active_home])
        else:
            bwrap_cmd.extend(["--dir", active_home])

        for folder in [".claude", ".codex", ".gemini", ".ive", ".npm", ".config", ".cache", ".local", ".nvm"]:
            src_folder = Path(real_home) / folder
            dst_folder = Path(active_home) / folder
            if src_folder.exists() and (active_home == real_home or not dst_folder.exists()):
                bwrap_cmd.extend(["--bind", str(src_folder), str(dst_folder)])
                
        # Bind dotfiles
        for dotfile in [".zshrc", ".bashrc", ".bash_profile", ".profile", ".gitconfig"]:
            src_file = Path(real_home) / dotfile
            dst_file = Path(active_home) / dotfile
            if src_file.exists():
                bwrap_cmd.extend(["--ro-bind", str(src_file), str(dst_file)])
                
        return bwrap_cmd + cmd

    elif sandbox_type == "docker":
        # Higher-isolation tier: run the command inside a fresh container.
        # Requires the Docker daemon to be running (see vision/SANDBOX_ARCHITECTURE).
        docker_bin = shutil.which("docker")
        if not docker_bin:
            if fail_closed:
                logger.warning("docker not found on host. FAIL-CLOSED: denying run.")
                return _deny_stub("docker unavailable")
            logger.warning("docker not found on host. Running un-sandboxed.")
            return cmd

        # Image is configurable; default to a sensible slim Python base.
        image = os.environ.get("SANDBOX_DOCKER_IMAGE", "python:3.13-slim")

        # --rm cleans up the container on exit; -i keeps stdin open for the CLI.
        # The workspace is bind-mounted at /ws and used as the working directory.
        docker_cmd = [
            docker_bin, "run", "--rm", "-i",
            "--workdir", "/ws",
            "-v", f"{os.path.abspath(workspace_path)}:/ws",
        ]

        # ── Egress wiring (additive, OFF by default) ──────────────────────────
        # When networking is requested AND egress enforcement is on, force the
        # container's HTTP(S) traffic through a deny-default allowlist proxy
        # started on the host loopback (reachable from the container via
        # host.docker.internal). FAIL-CLOSED: if the proxy can't start, deny.
        # Honest limit: HTTP_PROXY only gates HTTP-aware clients; true
        # enforcement needs a network namespace + transparent redirect.
        if sandbox_network and _egress_enforced():
            try:
                import egress_policy as _ep
                policy = _ep.from_boundary(_resolve_boundary(boundary))
                handle = _ep.start_egress_proxy(policy, require=True)
                if handle is None:
                    # require=True returns a handle or raises; None is defensive.
                    raise _ep.EgressUnavailable("no_proxy_binary", "no egress proxy")
                if ctx is not None:
                    ctx["egress_proxy"] = handle  # caller owns teardown
                # On Linux the default bridge has no host.docker.internal route;
                # add a host-gateway mapping so the proxy address resolves.
                docker_cmd.extend(["--add-host", "host.docker.internal:host-gateway"])
                proxy_url = handle.address.replace("127.0.0.1", "host.docker.internal")
                docker_cmd.extend([
                    "-e", f"HTTP_PROXY={proxy_url}",
                    "-e", f"HTTPS_PROXY={proxy_url}",
                    "-e", f"http_proxy={proxy_url}",
                    "-e", f"https_proxy={proxy_url}",
                    "-e", "NO_PROXY=localhost,127.0.0.1,::1",
                    "-e", "no_proxy=localhost,127.0.0.1,::1",
                ])
            except Exception as e:  # EgressUnavailable or any setup failure -> deny
                reason = getattr(e, "reason", None) or str(e)
                logger.warning("docker egress enforcement failed (%s). FAIL-CLOSED: denying run.", reason)
                return _deny_stub(f"egress control unavailable ({reason})")

        # Network: isolate by default, allow the default bridge when requested.
        # When the egress proxy is wired we keep the default bridge (so the
        # container can reach the host proxy) rather than --network=none.
        if not sandbox_network:
            docker_cmd.append("--network=none")

        # Pass only the explicitly provided extra_env into the container; the
        # host environment is intentionally dropped for isolation.
        for key, value in (extra_env or {}).items():
            docker_cmd.extend(["-e", f"{key}={value}"])

        docker_cmd.append(image)

        return docker_cmd + cmd

    elif sandbox_type == "container":
        # Apple `container` (macOS Virtualization.framework): one Linux microVM per
        # run — the strongest *local* isolation tier on macOS (real kernel boundary,
        # host filesystem invisible). Flags differ from Docker: --mount (not -v),
        # --workdir, `--network none` for isolation, `--cap-drop ALL` hardening.
        container_bin = shutil.which("container")
        if not container_bin:
            if fail_closed:
                logger.warning("apple `container` not found. FAIL-CLOSED: denying run.")
                return _deny_stub("apple container unavailable")
            logger.warning("apple `container` not found. Running un-sandboxed.")
            return cmd

        # Egress allow-listing on this tier is IMPOSSIBLE on Apple `container`,
        # not merely unverified (measured 2026-07-27, vision/SANDBOX_ARCHITECTURE
        # §3a-measured): there is no per-destination primitive, and the usual
        # workaround — internal network plus a host-side allowlisting proxy —
        # cannot work either, because the host is unreachable from an internal
        # network. So this refusal is PERMANENT for filtered egress, not a
        # placeholder. What the same measurements proved possible is the opposite
        # end: `container network create --internal` cuts egress completely, and
        # backend/sandbox_egress.py already turns a requested posture into
        # isolated/proxy/open/deny for the sidecar and app tiers. Routing this
        # branch through sandbox_egress.decide() would give the container tier
        # "narrow to isolated rather than refuse" — deliberately NOT done here
        # yet, because it widens what this tier will run and that is the user's
        # call (vision/CONVERGENCE_AND_CANVAS_TODO §2.3).
        if sandbox_network and _egress_enforced():
            logger.warning("container tier cannot filter egress on this runtime "
                           "(no per-destination primitive). FAIL-CLOSED: denying run.")
            return _deny_stub("container egress control unavailable")

        image = os.environ.get("SANDBOX_CONTAINER_IMAGE", "docker.io/library/python:3.13-slim")
        ws_abs = os.path.abspath(workspace_path)

        # Read-only workspace mount when requested (Tester / QA); else read-write so
        # worker sessions can edit code. cap-drop ALL is always applied.
        ro_requested = str(
            (extra_env or {}).get("SANDBOX_CONTAINER_READONLY")
            or os.environ.get("SANDBOX_CONTAINER_READONLY", "")
        ).strip().lower() in _TRUE_SET
        mount_spec = f"type=bind,source={ws_abs},target=/ws" + (",readonly" if ro_requested else "")

        container_cmd = [
            container_bin, "run", "--rm", "-i",
            # Name the container after the session so container_registry (WS-5) can map running
            # containers -> sessions and reap orphans (a session that died but left its container).
            "--name", f"ive-sess-{session_id}",
            "--cap-drop", "ALL",
            "--workdir", "/ws",
            "--mount", mount_spec,
        ]
        # Isolate the network by default (real VM netns — a true cut, unlike the
        # process tier's advisory one); attach the default NAT net only when asked.
        if not sandbox_network:
            container_cmd.extend(["--network", "none"])

        # Pass only explicitly provided extra_env; the host environment is dropped
        # for isolation (mirrors the docker tier).
        for key, value in (extra_env or {}).items():
            if key == "SANDBOX_CONTAINER_READONLY":
                continue
            container_cmd.extend(["-e", f"{key}={value}"])

        container_cmd.append(image)
        return container_cmd + cmd

    return _deny_stub(f"unsupported sandbox type: {sandbox_type}")


def _egress_enforced() -> bool:
    """True when EGRESS_PROXY_ENFORCE (the master egress switch) is set.

    Delegates to egress_policy.is_egress_enforced when importable so the two
    stay in lockstep; falls back to reading the env directly.
    """
    try:
        import egress_policy as _ep
        return _ep.is_egress_enforced()
    except Exception:  # pragma: no cover - import guard
        return os.environ.get("EGRESS_PROXY_ENFORCE", "").strip().lower() in _TRUE_SET


def _resolve_boundary(boundary: dict | None) -> dict | None:
    """Pick the allow/deny network-policy dict for egress policy derivation.

    Order: an explicit ``boundary`` arg (per-workspace), then EGRESS_BOUNDARY_JSON
    env, else None (-> deny-default policy via from_boundary). Never raises.
    """
    if isinstance(boundary, dict):
        return boundary
    raw = os.environ.get("EGRESS_BOUNDARY_JSON", "").strip()
    if raw:
        try:
            import json
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            logger.warning("EGRESS_BOUNDARY_JSON is not valid JSON; using deny-default policy")
    return None
