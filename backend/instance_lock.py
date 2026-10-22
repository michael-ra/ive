"""One backend per data directory.

Two backends on one data dir share the SQLite DB, the hook scripts and the
PTY bookkeeping, and each believes it owns every session. That happened when
a new backend was started while the previous one was still shutting down.

The lock is an advisory ``flock`` on ``<data_dir>/backend.lock``. The kernel
drops it when the process exits, however it exits, so a crash never leaves a
stale lock behind. A starting backend waits a little for a previous one that
is still shutting down, then refuses to start.
"""
from __future__ import annotations

import fcntl
import os
import time
from pathlib import Path

LOCK_NAME = "backend.lock"


class DataDirLocked(RuntimeError):
    pass


def acquire(data_dir: Path | str, wait_secs: float = 20.0, poll_secs: float = 0.25) -> int:
    """Lock ``data_dir`` for this process and return the open lock fd.

    Keep the fd open for the life of the process. Raises DataDirLocked when
    another live backend still holds the lock after ``wait_secs``.
    """
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / LOCK_NAME
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    deadline = time.monotonic() + max(0.0, wait_secs)
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                holder = ""
                try:
                    holder = os.pread(fd, 64, 0).decode("ascii", "replace").strip()
                except OSError:
                    pass
                os.close(fd)
                raise DataDirLocked(
                    f"another IVE backend (pid {holder or 'unknown'}) is using {data_dir}"
                )
            time.sleep(poll_secs)
    os.ftruncate(fd, 0)
    os.pwrite(fd, f"{os.getpid()}\n".encode("ascii"), 0)
    return fd
