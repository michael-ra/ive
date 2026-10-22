"""Hook installer: never register the relay on behaviour-replacing events,
and replace stale IVE relay entries instead of accumulating them.

Fully isolated: IVE_DATA_DIR and HOME point at a temp dir before any backend
import, and every settings file lives in that temp dir. Never touches the real
~/.claude, ~/.codex, ~/.gemini or .ive-team-state.
"""
import json
import os
import shlex
import subprocess
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
from cli_profiles import PROFILES, get_profile  # noqa: E402

# Other test modules may have imported config first (HOOKS_DIR = real ~/.ive),
# so pin the relay path explicitly instead of trusting import order.
_HOOKS_DIR = _ROOT / "state" / ".ive-team-state" / "hooks"
_HOOK_SCRIPT = _HOOKS_DIR / hi.HOOK_SCRIPT_NAME
CURRENT = str(_HOOK_SCRIPT)
STALE_CAPTURE = "/somewhere/launch-film/.runtime/capture-ive-001/.ive-team-state/hooks/hook.sh"
STALE_DEFAULT = "/Users/someone/.ive/hooks/hook.sh"
USER_WORKTREE = "/Users/someone/bin/my-svn-worktree.sh"
USER_PRETOOL = "/Users/someone/bin/audit.sh"
SAFETY_GATE = "/somewhere/.ive-team-state/hooks/safety_gate.sh"


def _group(command, matcher=""):
    return {"matcher": matcher, "hooks": [{"type": "command", "command": command}]}


def _commands(settings, event):
    return [
        h["command"]
        for g in settings.get("hooks", {}).get(event, [])
        for h in g.get("hooks", [])
    ]


class HookInstallerWorktreeTests(unittest.TestCase):
    def setUp(self):
        for name, value in (
            ("HOOKS_DIR", _HOOKS_DIR),
            ("HOOK_SCRIPT_PATH", _HOOK_SCRIPT),
            ("_HOOK_MARKERS", (CURRENT, ".claude-commander/hooks/hook.sh")),
        ):
            p = patch.object(hi, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.dir = tempfile.TemporaryDirectory(dir=_ROOT)
        self.addCleanup(self.dir.cleanup)
        self.settings_path = Path(self.dir.name) / "settings.json"

    def _write(self, data):
        self.settings_path.write_text(json.dumps(data, indent=2))

    def _read(self):
        return json.loads(self.settings_path.read_text())

    def test_isolated_paths(self):
        self.assertTrue(str(hi.HOOK_SCRIPT_PATH).startswith(str(_ROOT)))
        self.assertTrue(str(hi._hook_entry()["command"]).startswith(str(_ROOT)))

    def test_hook_commands_execute_paths_with_spaces(self):
        script = Path(self.dir.name) / "Application Support" / "IVE's hooks" / "hook.sh"
        script.parent.mkdir(parents=True)
        script.write_text("#!/bin/sh\nprintf 'hook-ok'\n")
        script.chmod(0o700)
        for variable, entry in (
            ("HOOK_SCRIPT_PATH", lambda: hi._hook_entry()),
            ("HOOK_SCRIPT_PATH", lambda: hi._hook_entry(get_profile("claude"))),
            ("SAFETY_GATE_SCRIPT_PATH", lambda: hi._safety_gate_entry()["hooks"][0]),
            ("SAFETY_GATE_POST_SCRIPT_PATH", lambda: hi._safety_gate_post_entry()["hooks"][0]),
        ):
            with self.subTest(variable=variable), patch.object(hi, variable, script):
                command = entry()["command"]
                result = subprocess.run(["/bin/sh", "-c", command], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, "hook-ok")
                self.assertEqual(hi._hook_command_path(command), script.resolve())
        self.assertIsNone(hi._hook_command_path(str(script)))
        self.assertIsNone(hi._hook_command_path(shlex.quote(str(script)) + " --extra"))

    def test_relay_events_exclude_behaviour_replacing_events(self):
        for profile in PROFILES.values():
            events = hi.relay_hook_events(profile)
            self.assertFalse(set(events) & hi.RELAY_EXCLUDED_EVENTS, profile.id)
        self.assertNotIn("WorktreeCreate", get_profile("claude").default_hook_events)
        self.assertNotIn("WorktreeRemove", get_profile("claude").default_hook_events)
        self.assertNotIn("WorktreeCreate", hi.CLAUDE_HOOK_EVENTS)
        self.assertNotIn("WorktreeCreate", hi.GEMINI_HOOK_EVENTS)

    def test_merge_never_adds_excluded_events_even_if_asked(self):
        merged = hi._merge_hooks({}, ["Stop", "WorktreeCreate", "WorktreeRemove"])
        self.assertEqual(set(merged["hooks"]), {"Stop"})

    def test_install_removes_stale_ive_entries_and_keeps_user_hooks(self):
        self._write({
            "model": "opus",
            "hooks": {
                "WorktreeCreate": [
                    _group(STALE_CAPTURE), _group(CURRENT), _group(USER_WORKTREE),
                ],
                "WorktreeRemove": [_group(STALE_CAPTURE), _group(CURRENT)],
                "PreToolUse": [
                    _group(STALE_CAPTURE), _group(SAFETY_GATE), _group(CURRENT),
                    _group(USER_PRETOOL, matcher="Bash"),
                ],
                "Stop": [_group(STALE_DEFAULT), _group(STALE_CAPTURE), _group(CURRENT)],
            },
        })
        profile = get_profile("claude")
        hi.install_hooks_for_profile(profile, settings_path=self.settings_path)
        after = self._read()

        self.assertEqual(after["model"], "opus")
        # Relay gone from the worktree events, user hook kept, empty event dropped.
        self.assertEqual(_commands(after, "WorktreeCreate"), [USER_WORKTREE])
        self.assertNotIn("WorktreeRemove", after["hooks"])
        # Exactly one current relay per relay event; stale paths replaced.
        for event in hi.relay_hook_events(profile):
            cmds = _commands(after, event)
            self.assertEqual(cmds.count(CURRENT), 1, event)
            self.assertNotIn(STALE_CAPTURE, cmds, event)
            self.assertNotIn(STALE_DEFAULT, cmds, event)
        pre = _commands(after, "PreToolUse")
        self.assertIn(SAFETY_GATE, pre)
        self.assertIn(USER_PRETOOL, pre)
        bash_group = [g for g in after["hooks"]["PreToolUse"] if g["matcher"] == "Bash"]
        self.assertEqual(len(bash_group), 1)

        # Idempotent: a second install changes nothing.
        hi.install_hooks_for_profile(profile, settings_path=self.settings_path)
        self.assertEqual(self._read(), after)

    def test_gemini_install_has_no_worktree_events(self):
        self._write({"hooks": {"WorktreeCreate": [_group(CURRENT)]}})
        hi.install_hooks_for_profile(get_profile("gemini"), settings_path=self.settings_path)
        after = self._read()
        self.assertNotIn("WorktreeCreate", after["hooks"])
        self.assertNotIn("WorktreeRemove", after["hooks"])
        self.assertIn(CURRENT, _commands(after, "BeforeTool"))

    def test_uninstall_removes_stale_relays_too(self):
        self._write({"hooks": {
            "WorktreeCreate": [_group(STALE_CAPTURE), _group(USER_WORKTREE)],
            "Stop": [_group(STALE_DEFAULT)],
        }})
        hi.uninstall_hooks_for_profile(get_profile("claude"), settings_path=self.settings_path)
        self.assertEqual(self._read(), {"hooks": {"WorktreeCreate": [_group(USER_WORKTREE)]}})

    def test_ownership_detection(self):
        relay_elsewhere = Path(self.dir.name) / "custom-state" / "hooks" / "hook.sh"
        relay_elsewhere.parent.mkdir(parents=True)
        relay_elsewhere.write_text(hi.HOOK_SCRIPT)
        user_hook_sh = Path(self.dir.name) / "mine" / "hooks" / "hook.sh"
        user_hook_sh.parent.mkdir(parents=True)
        user_hook_sh.write_text("#!/bin/bash\necho mine\n")

        owned = [CURRENT, STALE_CAPTURE, STALE_DEFAULT, str(relay_elsewhere),
                 "/old/.claude-commander/hooks/hook.sh", f'"{STALE_CAPTURE}"']
        not_owned = [USER_WORKTREE, SAFETY_GATE, str(user_hook_sh),
                     "/missing/somewhere/hooks/hook.sh",
                     f"bash {STALE_DEFAULT} --extra", "", None]
        for cmd in owned:
            self.assertTrue(hi._is_ive_relay_command(cmd), cmd)
        for cmd in not_owned:
            self.assertFalse(hi._is_ive_relay_command(cmd), cmd)

    def test_dry_run_preview_has_no_worktree_events(self):
        profile = get_profile("claude")
        merged = hi._merge_hooks(
            {"hooks": {"WorktreeCreate": [_group(STALE_CAPTURE)]}},
            hi.relay_hook_events(profile), profile,
        )
        self.assertNotIn("WorktreeCreate", merged["hooks"])


if __name__ == "__main__":
    unittest.main()
