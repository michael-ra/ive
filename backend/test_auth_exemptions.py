"""Auth middleware exemptions and the error body of the CORS middleware."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("IVE_DATA_DIR", str(Path(_TMP.name) / "data"))

from aiohttp.test_utils import make_mocked_request  # noqa: E402

import server  # noqa: E402


class ExemptPathTests(unittest.TestCase):
    def test_connectors_prefix_is_not_exempt(self):
        for path in ("/connectors/x", "/connectors/../api/sessions", "/connectors/"):
            req = make_mocked_request("GET", path)
            self.assertFalse(server._exempt_path(req), path)

    def test_known_public_paths_stay_exempt(self):
        self.assertTrue(server._exempt_path(make_mocked_request("GET", "/ready")))
        self.assertTrue(server._exempt_path(make_mocked_request("POST", "/auth")))


class CorsErrorBodyTests(unittest.IsolatedAsyncioTestCase):
    async def test_unhandled_exception_returns_generic_message(self):
        async def boom(request):
            raise RuntimeError("secret /Users/me/.ive/token=abc123")

        req = make_mocked_request("GET", "/api/x")
        import telemetry
        with patch.object(telemetry, "report_error_sync", lambda *a, **k: None), \
                self.assertLogs(server.logger, level="ERROR"):
            resp = await server.cors_middleware(req, boom)
        self.assertEqual(resp.status, 500)
        self.assertNotIn(b"secret", resp.body)
        self.assertNotIn(b"abc123", resp.body)
        self.assertIn(b"Internal server error", resp.body)


if __name__ == "__main__":
    unittest.main()
