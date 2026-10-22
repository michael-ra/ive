"""Large pastes reach the CLI in full.

The PTY input buffer is about 1 KB on macOS. The old write loop gave up after
20 EAGAINs (~200 ms), so any paste larger than the buffer was cut off when the
CLI did not read at once. Isolated: temp dir, a real PTY running a small
Python reader, no server, no agent CLI.
"""
import asyncio
import sys
import tempfile
import time
import unittest
from pathlib import Path

from pty_manager import PTYManager

READER = r"""
import os, sys, time, tty
tty.setraw(0)
os.write(1, b"READY")
n, out, delay = int(sys.argv[1]), sys.argv[2], float(sys.argv[3])
time.sleep(delay)
buf = b""
while len(buf) < n:
    chunk = os.read(0, 65536)
    if not chunk:
        break
    buf += chunk
    time.sleep(0.001)
open(out, "wb").write(buf)
"""


class LargePasteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.mgr = PTYManager()
        self.addAsyncCleanup(self.mgr.stop_all)
        self.output = bytearray()

        async def on_output(_sid, data):
            self.output.extend(data)

        self.mgr.on_output(on_output)

    async def paste_and_collect(self, size: int, reader_delay: float) -> bytes:
        out = Path(self.tmp.name, "received.bin")
        script = Path(self.tmp.name, "reader.py")
        script.write_text(READER)
        await self.mgr.start_session(
            "paste", self.tmp.name,
            cmd_binary=sys.executable,
            cmd_args=[str(script), str(size), str(out), str(reader_delay)],
        )
        # Like a real CLI, the reader is in raw mode before anyone pastes.
        deadline = time.monotonic() + 10
        while b"READY" not in self.output and time.monotonic() < deadline:
            await asyncio.sleep(0.02)
        self.assertIn(b"READY", bytes(self.output))
        payload = bytes((ord("a") + i % 26) for i in range(size))
        self.assertTrue(self.mgr.write("paste", payload))
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and not out.exists():
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.1)
        self.assertTrue(out.exists(), "reader never got the whole paste")
        return out.read_bytes(), payload

    async def test_paste_larger_than_pty_buffer_survives_slow_reader(self):
        # The reader starts reading only after 1 s: far beyond the old
        # 20 x 10 ms retry budget.
        received, payload = await self.paste_and_collect(64 * 1024, reader_delay=1.0)
        self.assertEqual(len(received), len(payload))
        self.assertEqual(received, payload)


if __name__ == "__main__":
    unittest.main()
