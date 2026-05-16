import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from cli_features import Feature, HookEvent
from cli_profiles import PROFILES, get_profile, _codex_permission
from cli_session import UnifiedSession, build_feature_matrix

# Authoritative Codex hook-event enum, extracted from the `HookEventNameWire`
# definition in the JSON schema embedded in the Codex CLI 0.130.0 native binary.
CODEX_NATIVE_HOOK_EVENTS = {
    "PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact",
    "PostCompact", "SessionStart", "UserPromptSubmit", "Stop",
}


class CodexProfileTests(unittest.TestCase):
    def test_codex_profile_is_registered(self):
        self.assertIn("codex", PROFILES)
        profile = get_profile("codex")

        self.assertEqual(profile.id, "codex")
        self.assertEqual(profile.binary, "codex")
        self.assertEqual(profile.auth_dir_name, ".codex")
        self.assertEqual(profile.default_model, "gpt-5.4")
        self.assertTrue(profile.supports(Feature.MODEL))
        self.assertTrue(profile.supports(Feature.PERMISSION_MODE))
        self.assertTrue(profile.supports(Feature.EFFORT))
        self.assertTrue(profile.supports(Feature.ADD_DIRS))
        self.assertTrue(profile.supports(Feature.ALLOWED_MCP_SERVERS))

    def test_codex_command_translates_session_features(self):
        session = UnifiedSession("codex", {
            "model": "gpt-5.5",
            "permission_mode": "auto",
            "effort": "high",
            "add_dirs": ["/tmp/sidecar"],
            "allowed_mcp_servers": ["commander", "deep-research"],
            "resume_id": "019e116c-ad33-7fb0-9089-6ce57d96cd4e",
        })

        self.assertEqual(session.build_command(), [
            "codex",
            "--model", "gpt-5.5",
            "-c", "model_reasoning_effort=\"high\"",
            "--add-dir", "/tmp/sidecar",
            "resume", "019e116c-ad33-7fb0-9089-6ce57d96cd4e",
            "--ask-for-approval", "never",
            "--sandbox", "workspace-write",
        ])

    def test_codex_plan_and_bypass_modes_are_safe_and_explicit(self):
        plan_cmd = UnifiedSession("codex", {
            "permission_mode": "plan",
        }).build_command()
        self.assertIn("--sandbox", plan_cmd)
        self.assertIn("read-only", plan_cmd)
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", plan_cmd)

        bypass_cmd = UnifiedSession("codex", {
            "permission_mode": "bypassPermissions",
        }).build_command()
        self.assertIn("--dangerously-bypass-approvals-and-sandbox", bypass_cmd)

    def test_codex_profile_is_exposed_in_feature_matrix(self):
        matrix = build_feature_matrix()
        codex = matrix["profiles"]["codex"]

        self.assertEqual(codex["label"], "Codex CLI")
        self.assertEqual(codex["home_dir"], "~/.codex")
        self.assertEqual(codex["ui_capabilities"]["theme"], "green")
        self.assertEqual(codex["message_markers"], ["codex", ">"])

    def test_profiles_expose_hook_install_metadata(self):
        expected = {
            "claude": ("CLAUDE_CONFIG_DIR", "claude-code.sh", "Bash", 30, "*"),
            "gemini": ("GEMINI_HOME", "gemini-cli.sh",
                       "shell_execute|run_shell_command|Bash", 30000,
                       "edit_file|write_file|create_file"),
            "codex":  ("CODEX_HOME", "codex-cli.sh",
                       "Bash|shell|shell_command", 30, "*"),
        }
        for cid, (env, script, matcher, timeout, tool_match) in expected.items():
            p = get_profile(cid)
            self.assertEqual(p.home_env_var, env, cid)
            self.assertEqual(p.avcp_hook_script, script, cid)
            self.assertEqual(p.avcp_matcher, matcher, cid)
            self.assertEqual(p.avcp_timeout, timeout, cid)
            self.assertEqual(p.tool_event_matcher, tool_match, cid)

    def test_codex_permission_covers_every_branch(self):
        # Highest-risk surface — must stay exhaustively pinned. acceptEdits /
        # dontAsk intentionally collapse to never+workspace-write: Codex has
        # no finer-grained approval policy, and `never` literally means
        # "never ask; failures returned to the model" (== dontAsk's intent).
        # `on-failure` is DEPRECATED in Codex 0.130.0, so we do not use it.
        bypass = ["--dangerously-bypass-approvals-and-sandbox"]
        plan = ["--ask-for-approval", "never", "--sandbox", "read-only"]
        auto = ["--ask-for-approval", "never", "--sandbox", "workspace-write"]
        interactive = ["--ask-for-approval", "on-request",
                       "--sandbox", "workspace-write"]
        cases = {
            "bypassPermissions": bypass,
            "plan": plan,
            "auto": auto,
            "acceptEdits": auto,
            "dontAsk": auto,
            "yolo": auto,
            "auto_edit": auto,
            "default": interactive,
            "": interactive,
            "totally-unknown": interactive,
        }
        for mode, expected in cases.items():
            self.assertEqual(_codex_permission(mode), expected, mode)
        # None / missing must be safe (interactive), never a crash.
        self.assertEqual(_codex_permission(None), interactive)

    def test_codex_system_prompt_uses_launch_flag_not_deferred_tui(self):
        # Codex's --append-system-prompt analogue is `-c
        # developer_instructions=` (verified against Codex 0.130.0:
        # the value is TOML-parsed with raw-string fallback, robust for
        # large multi-line/quoted prompts). Supporting APPEND_SYSTEM_PROMPT
        # routes the system prompt to launch args instead of the fragile
        # deferred-TUI-typing path (which never reliably lands while Codex's
        # codex_apps MCP TUI is still booting).
        self.assertTrue(
            get_profile("codex").supports(Feature.APPEND_SYSTEM_PROMPT)
        )
        self.assertTrue(
            get_profile("claude").supports(Feature.APPEND_SYSTEM_PROMPT)
        )
        cmd = (UnifiedSession("codex", {})
               .append_system_prompt("BE TERSE")
               .build_command())
        self.assertIn("developer_instructions=BE TERSE", cmd)
        # `-c` must immediately precede the developer_instructions= value.
        self.assertEqual(
            cmd[cmd.index("developer_instructions=BE TERSE") - 1], "-c"
        )

    def test_codex_hook_map_only_targets_real_codex_events(self):
        profile = get_profile("codex")

        bad_mapped = {
            ive_evt.name: native
            for ive_evt, native in profile.hook_event_map.items()
            if native not in CODEX_NATIVE_HOOK_EVENTS
        }
        self.assertEqual(
            bad_mapped, {},
            f"hook_event_map points at events Codex does not emit: {bad_mapped}",
        )

        bad_defaults = [
            e for e in profile.default_hook_events
            if e not in CODEX_NATIVE_HOOK_EVENTS
        ]
        self.assertEqual(
            bad_defaults, [],
            f"default_hook_events would write events Codex ignores: {bad_defaults}",
        )

        # Codex has no session-end hook (Stop = end of turn). SESSION_STOP must
        # not be mapped to a nonexistent "SessionEnd" or session-end tracking
        # silently never fires for Codex.
        self.assertNotIn(HookEvent.SESSION_STOP, profile.hook_event_map)


if __name__ == "__main__":
    unittest.main()
