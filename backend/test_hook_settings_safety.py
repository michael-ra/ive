"""Hook installers must never clobber a CLI settings file they cannot parse.

Fully isolated: IVE_DATA_DIR and HOME point at a temp dir before any backend
import; every settings path is patched into that temp dir.
"""
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_TMP = tempfile.TemporaryDirectory()
_ROOT = Path(_TMP.name)
os.environ["IVE_DATA_DIR"] = str(_ROOT / "state" / ".ive-team-state")
os.environ["HOME"] = str(_ROOT / "home")
(_ROOT / "home").mkdir(parents=True, exist_ok=True)

import hook_installer as hi  # noqa: E402
from cli_profiles import get_profile  # noqa: E402

BROKEN = '{\n  "model": "opus",\n  "permissions": {"allow": ["Bash(ls)"]},\n'  # truncated
JSONC = '{\n  // my theme\n  "theme": "dark"\n}\n'


class SettingsFailSafeTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir=_ROOT))
        self.claude = self.dir / "claude" / "settings.json"
        self.gemini = self.dir / "gemini" / "settings.json"
        self.codex = self.dir / "codex" / "config.toml"
        for p in (self.claude, self.gemini, self.codex):
            p.parent.mkdir(parents=True)
        avcp_hook = self.dir / "avcp.sh"
        avcp_hook.write_text("#!/bin/sh\n")
        for name, value in (
            ("CLAUDE_SETTINGS", self.claude),
            ("GEMINI_SETTINGS", self.gemini),
            ("CODEX_SETTINGS", self.codex),
            ("AVCP_CLAUDE_HOOK", avcp_hook),
            ("AVCP_GEMINI_HOOK", avcp_hook),
            ("HOOKS_DIR", self.dir / "hooks"),
            ("HOOK_SCRIPT_PATH", self.dir / "hooks" / "hook.sh"),
        ):
            p = patch.object(hi, name, value)
            p.start()
            self.addCleanup(p.stop)
        for name in ("generate_safety_gate_script",):
            p = patch.object(hi, name, lambda: None)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(hi, "_cli_available", lambda *_: False)
        p.start()
        self.addCleanup(p.stop)

    def _installers(self):
        import extension_host
        with patch.object(extension_host, "available", lambda *_: True):
            hi.install_safety_gate_hooks()
            hi.install_avcp_hooks()
            hi.install_myelin_hooks()
            hi.uninstall_avcp_hooks()
            hi.uninstall_myelin_hooks()
        hi.install_hooks_for_profile(get_profile("claude"), self.claude)
        hi.uninstall_hooks_for_profile(get_profile("claude"), self.claude)

    def test_unparsable_settings_are_left_untouched(self):
        self.claude.write_text(BROKEN)
        self.gemini.write_text(BROKEN)
        with self.assertLogs(hi.logger, level="WARNING"):
            self._installers()
        self.assertEqual(self.claude.read_text(), BROKEN)
        self.assertEqual(self.gemini.read_text(), BROKEN)

    def test_jsonc_gemini_settings_are_not_rewritten_but_readable(self):
        self.gemini.write_text(JSONC)
        hi.install_safety_gate_hooks()
        self.assertEqual(self.gemini.read_text(), JSONC)
        # Read-only inspection tolerates the comments.
        self.assertEqual(hi._read_settings(self.gemini), {"theme": "dark"})

    def test_valid_settings_keep_user_keys_and_mode(self):
        self.claude.write_text(json.dumps({"model": "opus", "hooks": {}}))
        os.chmod(self.claude, 0o600)
        hi.install_safety_gate_hooks()
        data = json.loads(self.claude.read_text())
        self.assertEqual(data["model"], "opus")
        self.assertIn("PreToolUse", data["hooks"])
        self.assertEqual(stat.S_IMODE(self.claude.stat().st_mode), 0o600)
        self.assertEqual(
            [p.name for p in self.claude.parent.iterdir()], ["settings.json"],
            "atomic write must not leave temp files behind",
        )

    def test_symlinked_settings_stay_a_symlink(self):
        real = self.dir / "dotfiles-settings.json"
        real.write_text(json.dumps({"model": "opus"}))
        self.claude.symlink_to(real)
        hi.install_safety_gate_hooks()
        self.assertTrue(self.claude.is_symlink())
        self.assertIn("hooks", json.loads(real.read_text()))

    def test_uninstall_does_not_create_missing_files(self):
        hi.uninstall_avcp_hooks()
        import extension_host
        with patch.object(extension_host, "available", lambda *_: True):
            hi.uninstall_myelin_hooks()
        hi.uninstall_hooks_for_profile(get_profile("claude"), self.claude)
        self.assertFalse(self.claude.exists())
        self.assertFalse(self.gemini.exists())

    def test_unreadable_toml_is_not_replaced(self):
        self.codex.write_text('model = "o3"\n')
        with patch.object(Path, "read_text", side_effect=OSError("boom")):
            result = hi._install_toml_hook_block(self.codex, "IVE test", {
                "PreToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": "x"}]}],
            })
        self.assertEqual(result.get("reason"), "settings_unreadable")
        self.assertEqual(self.codex.read_text(), 'model = "o3"\n')


if __name__ == "__main__":
    unittest.main()
