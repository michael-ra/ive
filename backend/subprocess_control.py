"""Stop subprocesses and descendants started in their own process session."""
from __future__ import annotations

import os
import signal
import asyncio
import logging


async def terminate_process_group(process, *, timeout: float = 3.0) -> None:
    """Kill only the process group allocated to this owned child, then reap it.

    Callers must create the process with start_new_session=True on POSIX. A
    descendant may still own stdout/stderr after its parent has exited, so kill
    the group even when process.returncode is already available.
    """
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        elif process.returncode is None:
            process.kill()
    except ProcessLookupError:
        pass
    try:
        await asyncio.wait_for(process.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        # A cancelled communicate() can leave a paused stdout/stderr reader;
        # inherited pipe handles can also outlive the killed group leader.
        # Closing this owned process's transport releases those pipe waits.
        transport = getattr(process, "_transport", None)
        if transport is not None:
            transport.close()
        try:
            await asyncio.wait_for(process.wait(), timeout=1.0)
        except asyncio.TimeoutError:
            logging.getLogger(__name__).warning("Owned CLI process %s did not reap before the deadline", process.pid)
