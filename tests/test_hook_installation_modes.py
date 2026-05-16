import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import hook_installer
from cli_profiles import get_profile


class HookInstallationModeTests(unittest.TestCase):
    def test_runtime_prepare_generates_relay_without_global_settings_writes(self):
        with (
            mock.patch.object(hook_installer, "generate_hook_script") as generate,
            mock.patch.object(hook_installer, "install_hooks_for_profile") as install_profile,
        ):
            hook_installer.prepare_runtime_hooks()

        generate.assert_called_once()
        install_profile.assert_not_called()

    def test_uninstall_does_not_create_missing_global_settings_file(self):
        profile = get_profile("codex")
        with tempfile.TemporaryDirectory() as tmp:
            missing_settings = Path(tmp) / ".codex" / "hooks.json"
            with (
                mock.patch.object(hook_installer, "_settings_path_for", return_value=missing_settings),
                mock.patch.object(hook_installer, "_write_settings") as write_settings,
            ):
                hook_installer.uninstall_hooks_for_profile(profile)

            write_settings.assert_not_called()
            self.assertFalse(missing_settings.exists())

    def test_session_hook_home_writes_codex_hooks_without_touching_source_home(self):
        profile = get_profile("codex")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_home = root / "real-home"
            source_codex = source_home / ".codex"
            source_codex.mkdir(parents=True)
            source_settings = source_codex / "hooks.json"
            source_settings.write_text(json.dumps({
                "hooks": {
                    "PreToolUse": [{
                        "matcher": "Existing",
                        "hooks": [{"type": "command", "command": "/bin/true"}],
                    }]
                }
            }))
            (source_codex / "config.toml").write_text("model = \"gpt-5.4\"\n")

            with (
                mock.patch.object(hook_installer, "SESSION_HOMES_DIR", root / "session-homes"),
                mock.patch.object(hook_installer, "generate_hook_script"),
            ):
                env = hook_installer.prepare_session_hook_home(
                    profile,
                    "session-123",
                    source_home=source_home,
                )

            target_home = root / "session-homes" / "session-123"
            target_settings = target_home / ".codex" / "hooks.json"
            self.assertTrue(target_settings.exists())
            self.assertEqual(
                json.loads(source_settings.read_text())["hooks"]["PreToolUse"][0]["matcher"],
                "Existing",
            )

            target = json.loads(target_settings.read_text())
            commands = [
                hook["command"]
                for group in target["hooks"]["PreToolUse"]
                for hook in group.get("hooks", [])
            ]
            self.assertIn("/bin/true", commands)
            self.assertIn(str(hook_installer.HOOK_SCRIPT_PATH), commands)
            self.assertEqual(env["HOME"], str(target_home))
            self.assertEqual(env["CODEX_HOME"], str(target_home / ".codex"))

    def test_session_hook_home_can_include_session_scoped_safety_gate(self):
        profile = get_profile("codex")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with (
                mock.patch.object(hook_installer, "SESSION_HOMES_DIR", root / "session-homes"),
                mock.patch.object(hook_installer, "generate_hook_script"),
                mock.patch.object(hook_installer, "generate_safety_gate_script"),
            ):
                hook_installer.prepare_session_hook_home(
                    profile,
                    "session-456",
                    source_home=root / "real-home",
                    include_safety_gate=True,
                )

            settings = json.loads(
                (root / "session-homes" / "session-456" / ".codex" / "hooks.json").read_text()
            )
            pre_tool_commands = [
                hook["command"]
                for group in settings["hooks"]["PreToolUse"]
                for hook in group.get("hooks", [])
            ]
            post_tool_commands = [
                hook["command"]
                for group in settings["hooks"]["PostToolUse"]
                for hook in group.get("hooks", [])
            ]
            self.assertTrue(any("safety_gate.sh" in command for command in pre_tool_commands))
            self.assertTrue(any("safety_gate_post.sh" in command for command in post_tool_commands))

    def test_global_startup_installs_enabled_optional_hook_features(self):
        with (
            mock.patch.object(hook_installer, "install_all") as install_all,
            mock.patch.object(hook_installer, "install_avcp_hooks") as install_avcp,
            mock.patch.object(hook_installer, "install_safety_gate_hooks") as install_safety,
            mock.patch.object(hook_installer, "install_myelin_hooks") as install_myelin,
        ):
            hook_installer.install_global_hooks(
                include_avcp=True,
                include_safety_gate=True,
                include_myelin=False,
            )

        install_all.assert_called_once()
        install_avcp.assert_called_once()
        install_safety.assert_called_once()
        install_myelin.assert_not_called()

    def test_avcp_entry_is_profile_driven(self):
        for cid, script, matcher, timeout in [
            ("claude", "claude-code.sh", "Bash", 30),
            ("gemini", "gemini-cli.sh",
             "shell_execute|run_shell_command|Bash", 30000),
            ("codex", "codex-cli.sh", "Bash|shell|shell_command", 30),
        ]:
            entry = hook_installer._avcp_entry(get_profile(cid))
            self.assertEqual(entry["matcher"], matcher, cid)
            self.assertEqual(entry["hooks"][0]["timeout"], timeout, cid)
            self.assertTrue(
                entry["hooks"][0]["command"].endswith(script), cid
            )
        src = (BACKEND / "hook_installer.py").read_text()
        # No remaining per-CLI id branches anywhere in the installer.
        self.assertNotIn('profile.id == "codex"', src)
        self.assertNotIn("profile.id == 'codex'", src)
        self.assertNotIn('profile.id == "gemini"', src)
        self.assertNotIn("profile.id == 'gemini'", src)

    def test_home_env_and_tool_events_are_profile_driven(self):
        src = (BACKEND / "hook_installer.py").read_text()
        # _profile_home_env uses the profile field, not id branches.
        self.assertIn("profile.home_env_var", src)
        self.assertNotIn('env["CLAUDE_CONFIG_DIR"]', src)
        # Tool-event split comes from hook_event_map, not id checks.
        self.assertNotIn(
            '"BeforeTool" if profile.id == "gemini"', src
        )
        self.assertNotIn(
            '"edit_file|write_file|create_file" if profile.id == "gemini"', src
        )
        self.assertIn("profile.native_hook(HookEvent.PRE_TOOL)", src)
        self.assertIn("profile.tool_event_matcher", src)
        # Behavior preserved: gemini → BeforeTool, codex/claude → PreToolUse.
        from cli_features import HookEvent
        self.assertEqual(
            get_profile("gemini").native_hook(HookEvent.PRE_TOOL), "BeforeTool"
        )
        self.assertEqual(
            get_profile("codex").native_hook(HookEvent.PRE_TOOL), "PreToolUse"
        )
        self.assertEqual(
            get_profile("claude").native_hook(HookEvent.PRE_TOOL), "PreToolUse"
        )


if __name__ == "__main__":
    unittest.main()
