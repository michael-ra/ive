import json
from pathlib import Path
import tempfile
import unittest

from phone_setup import PhoneSetup


class PhoneSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.setup = PhoneSetup(Path(self.temp.name))
        self.choice = dict(consent_version=1, remote_control=True, closed_lid=True, allow_battery=True)

    def test_fresh_desktop_requires_local_consent_without_breaking_server_edition(self):
        self.assertTrue(self.setup.status(desktop=True)["required"])
        self.assertFalse(self.setup.status(desktop=False)["required"])

    def test_acceptance_survives_restart_and_does_not_claim_os_permission(self):
        self.setup.accept(self.choice)
        status = PhoneSetup(Path(self.temp.name)).status(desktop=True)
        self.assertTrue(status["accepted"])
        self.assertTrue(status["allow_battery_requested"])
        self.assertNotIn("active", status)
        self.assertEqual(self.setup.path.stat().st_mode & 0o777, 0o600)

    def test_denied_stale_or_forged_consents_are_not_persisted(self):
        for override in [dict(remote_control=False), dict(remote_control="true"),
                         dict(consent_version=0), dict(consent_version=True),
                         dict(closed_lid=False), dict(allow_battery=1), dict(extra=True)]:
            with self.subTest(override=override), self.assertRaises(ValueError):
                self.setup.accept({**self.choice, **override})
            self.assertFalse(self.setup.path.exists())

    def test_corrupt_or_future_file_fails_closed(self):
        for text in ["{", "[]", json.dumps({**self.choice, "consent_version": 2}),
                     json.dumps({**self.choice, "consent_version": True}),
                     json.dumps({**self.choice, "closed_lid": False}), " " * 4097]:
            self.setup.path.write_text(text)
            self.assertFalse(self.setup.status(desktop=True)["accepted"])

    def test_symlink_is_not_read_or_followed_when_saving(self):
        other = Path(self.temp.name) / "unrelated.txt"
        other.write_text("untouched")
        self.setup.path.symlink_to(other)
        self.assertFalse(self.setup.status(desktop=True)["accepted"])
        self.setup.accept(self.choice)
        self.assertEqual(other.read_text(), "untouched")
        self.assertFalse(self.setup.path.is_symlink())


if __name__ == "__main__":
    unittest.main()
