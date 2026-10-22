import unittest
from unittest.mock import patch

from pty_manager import PTYSession


class PtyGeometryTests(unittest.TestCase):
    def make(self, owner=None):
        session = PTYSession("geo-test", "/tmp", cols=160, rows=31, geometry_owner=owner)
        return session

    def test_attach_without_size_never_resizes(self):
        # Hidden / Overview terminals resume without cols/rows: the PTY keeps
        # its size and the reply reports it (no SIGWINCH, no CLI redraw).
        session = self.make()
        with patch.object(PTYSession, "resize", return_value=True) as resize:
            geometry = session.request_geometry("ws:1", None, None)
        resize.assert_not_called()
        self.assertEqual(geometry, {"authoritative": True, "changed": False, "cols": 160, "rows": 31})
        self.assertEqual(session.geometry_owner, "ws:1")

    def test_owner_with_size_resizes(self):
        session = self.make(owner="ws:1")
        with patch.object(PTYSession, "resize", return_value=True) as resize:
            geometry = session.request_geometry("ws:1", 106, 31)
        resize.assert_called_once_with(106, 31)
        self.assertTrue(geometry["changed"])

    def test_non_owner_never_resizes(self):
        session = self.make(owner="ws:1")
        with patch.object(PTYSession, "resize", return_value=True) as resize:
            geometry = session.request_geometry("ws:2", 80, 24)
        resize.assert_not_called()
        self.assertFalse(geometry["authoritative"])
        self.assertEqual((geometry["cols"], geometry["rows"]), (160, 31))

    def test_claim_takes_ownership_and_resizes(self):
        # Phone remote: the full-screen phone view takes the PTY size.
        session = self.make(owner="ws:mac")
        with patch.object(PTYSession, "resize", return_value=True) as resize:
            previous, geometry = session.claim_geometry("ws:phone", 48, 40)
        resize.assert_called_once_with(48, 40)
        self.assertEqual(previous, "ws:mac")
        self.assertTrue(geometry["authoritative"])
        self.assertEqual(session.geometry_owner, "ws:phone")
        # The Mac is a viewer now; after the phone releases, it owns it again.
        with patch.object(PTYSession, "resize", return_value=True) as resize:
            self.assertFalse(session.request_geometry("ws:mac", 160, 31)["authoritative"])
            resize.assert_not_called()
            self.assertTrue(session.release_geometry("ws:phone"))
            self.assertTrue(session.request_geometry("ws:mac", 160, 31)["authoritative"])
            resize.assert_called_once_with(160, 31)


if __name__ == "__main__":
    unittest.main()
