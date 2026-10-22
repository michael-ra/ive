"""server.py runs as __main__; helper back-imports must reach that same module."""

import os
import subprocess
import sys
import tempfile
import textwrap
import types
import unittest
from pathlib import Path
from unittest import mock

import server_runtime

BACKEND = Path(__file__).resolve().parent


class ServerRuntimeAccessorTests(unittest.TestCase):
    def test_accessor_prefers_registered_server_module(self):
        fake = types.ModuleType("__main__")
        fake._session_workspace = {"s1": "w1"}
        with mock.patch.dict(sys.modules, {"server": fake}):
            self.assertIs(server_runtime.module(), fake)
            self.assertEqual(server_runtime.attr("_session_workspace"), {"s1": "w1"})

    def test_helpers_have_no_direct_server_imports(self):
        for name in ("hooks.py", "pipeline.py", "pipeline_engine.py",
                     "session_supervisor.py", "review_brief.py"):
            source = (BACKEND / name).read_text()
            self.assertFalse("from server import" in source, name)
            self.assertFalse("import server as" in source, name)


class PipelineOutputSummaryTests(unittest.TestCase):
    def test_summary_reads_injected_output_capture(self):
        import asyncio
        import pipeline_engine
        from output_capture import OutputCaptureProcessor

        capture = OutputCaptureProcessor()
        asyncio.run(capture.process("s1", b"\x1b[32mstage done\x1b[0m\nresult: ok\n"))
        with mock.patch.object(pipeline_engine, "_output_buffer_fn", capture.get_buffer):
            summary = asyncio.run(pipeline_engine._capture_output_summary("s1"))
        self.assertIn("result: ok", summary)
        self.assertNotIn("\x1b", summary)

    def test_summary_without_capture_is_empty(self):
        import asyncio
        import pipeline_engine

        with mock.patch.object(pipeline_engine, "_output_buffer_fn", None):
            self.assertEqual(asyncio.run(pipeline_engine._capture_output_summary("s1")), "")


class ServerRunAsMainTests(unittest.TestCase):
    def test_import_server_under_main_reuses_the_running_module(self):
        script = textwrap.dedent(
            """
            import runpy, sys
            sys.argv = ["server.py", "--help"]
            try:
                runpy.run_module("server", run_name="__main__", alter_sys=True)
            except SystemExit:
                pass
            live = sys.modules["server"]
            assert live.__name__ == "__main__", live.__name__
            import server
            assert server is live
            import server_runtime, hooks
            assert server_runtime.module() is live
            assert server_runtime.attr("_session_workspace") is live.__dict__["_session_workspace"]
            assert server_runtime.attr("pty_mgr") is live.__dict__["pty_mgr"]
            copies = [m for m in list(sys.modules.values())
                      if getattr(m, "__file__", "") and m.__file__.endswith("backend/server.py")]
            assert len(copies) == 1, copies
            print("SAME-MODULE-OK")
            """
        )
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ)
            for key in ("HOME", "IVE_DATA_DIR", "TMPDIR"):
                path = Path(tmp) / key.lower()
                path.mkdir()
                env[key] = str(path)
            result = subprocess.run(
                [sys.executable, "-s", "-c", script],
                cwd=BACKEND, env=env, capture_output=True, text=True, timeout=180,
            )
        self.assertEqual(result.returncode, 0, result.stderr[-4000:])
        self.assertIn("SAME-MODULE-OK", result.stdout)


if __name__ == "__main__":
    unittest.main()
