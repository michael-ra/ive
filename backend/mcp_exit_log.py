"""Per-MCP-subprocess exit logger.

Wires up signal handlers + atexit so that whichever way an MCP subprocess
dies — stdin EOF, SIGTERM, SIGKILL won't reach this, BrokenPipe, or an
unhandled exception — leaves a one-line record in ~/.ive/mcp-exits.log
identifying who, when, and why.

Without this, the MCP main loops have no exception handlers and four of
the five teardown paths produce zero stderr; from the IVE backend's
perspective the subprocess simply disappears with no trail.
"""

import atexit
import os
import signal
import sys
from datetime import datetime
from pathlib import Path

_EXIT_LOG = Path(os.getenv("IVE_DATA_DIR", str(Path.home() / ".ive"))) / "mcp-exits.log"
_logged = False
_pid = os.getpid()
_ppid = os.getppid()
_server_name = "unknown"


def _ident() -> str:
    parts = [f"server={_server_name}", f"pid={_pid}", f"ppid={_ppid}"]
    for k in ("WORKER_SESSION_ID", "COMMANDER_WORKSPACE_ID"):
        v = os.environ.get(k)
        if v:
            parts.append(f"{k.lower()}={v[:12]}")
    return " ".join(parts)


def log_exit(reason: str, details: str = "") -> None:
    """Record an MCP exit. Idempotent — first call wins."""
    global _logged
    if _logged:
        return
    _logged = True
    try:
        _EXIT_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(_EXIT_LOG, "a") as f:
            ts = datetime.now().isoformat(timespec="seconds")
            line = f"[{ts}] {_ident()} reason={reason}"
            if details:
                line += f" {details}"
            f.write(line + "\n")
    except Exception:
        # Never let logging crash the exit path itself.
        pass


def install(server_name: str) -> None:
    """Register signal handlers + atexit. Call once at the top of main()."""
    global _server_name
    _server_name = server_name

    _SIG_NAMES = {
        signal.SIGTERM: "SIGTERM",
        signal.SIGINT: "SIGINT",
        signal.SIGHUP: "SIGHUP",
        signal.SIGPIPE: "SIGPIPE",
    }

    def _on_signal(signum, _frame):
        log_exit(f"signal-{signum}", f"({_SIG_NAMES.get(signum, '?')})")
        sys.exit(128 + signum)

    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGPIPE):
        try:
            signal.signal(s, _on_signal)
        except (ValueError, OSError):
            # Some signals are not settable in all environments; ignore.
            pass

    # Catch-all for any path that doesn't go through an explicit log_exit
    # (e.g., sys.exit() called from an unforeseen branch, interpreter
    # shutdown via os._exit-elsewhere — though os._exit bypasses atexit too).
    atexit.register(lambda: log_exit("clean-exit", "(no explicit cause logged)"))
