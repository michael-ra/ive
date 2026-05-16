import json
import os
import sys
import tempfile
import unittest
import asyncio
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import account_sandbox
import history_reader
import hooks
import hook_installer
import pipeline_engine
import server
import llm_router
import model_discovery
import mcp_registration
import skill_installer
import cli_registry
import codex_sessions
import plugin_exporter
from cli_profiles import PROFILES, get_profile
from cli_session import UnifiedSession
from cli_features import Feature


class CodexBackendSurfaceTests(unittest.TestCase):
    def test_cli_info_payload_is_profile_driven(self):
        payload = cli_registry.build_cli_info_payload(
            {"codex": [{"id": "gpt-x", "label": "GPT X"}]},
            which=lambda binary: binary == "codex",
        )

        self.assertIn({"id": "codex", "label": "Codex CLI"}, payload["cli_types"])
        self.assertIn("codex", payload["available_clis"])
        self.assertEqual(payload["profile_models"]["codex"], [{"id": "gpt-x", "label": "GPT X"}])

    def test_validate_cli_type_accepts_registered_codex(self):
        self.assertEqual(cli_registry.validate_cli_type("codex"), "codex")
        self.assertEqual(cli_registry.validate_cli_type("claude"), "claude")
        with self.assertRaises(ValueError):
            cli_registry.validate_cli_type("bogus")

    def test_account_api_key_env_uses_openai_vars_for_codex(self):
        self.assertEqual(
            account_sandbox.api_key_env_for_cli("codex", "sk-test"),
            {"OPENAI_API_KEY": "sk-test", "CODEX_API_KEY": "sk-test"},
        )
        self.assertEqual(
            account_sandbox.api_key_env_for_cli("claude", "sk-ant"),
            {"ANTHROPIC_API_KEY": "sk-ant"},
        )

    def test_model_discovery_includes_codex_key(self):
        discovered = model_discovery.discover_all()
        self.assertIn("codex", discovered)

    def test_llm_router_builds_codex_exec_command(self):
        cmd, stdin_data = llm_router.build_llm_command(
            "codex", "gpt-5.4-mini", "hello", "system"
        )

        self.assertEqual(cmd[:3], ["codex", "exec", "--model"])
        self.assertIn("gpt-5.4-mini", cmd)
        self.assertIn("--sandbox", cmd)
        self.assertIn("read-only", cmd)
        self.assertIsNone(stdin_data)
        self.assertIn("system", cmd[-1])
        self.assertIn("hello", cmd[-1])

    def test_history_reader_lists_codex_projects_from_session_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / ".codex"
            sessions_dir = home / "sessions" / "2026" / "05" / "10"
            sessions_dir.mkdir(parents=True)
            session_id = "019e116c-ad33-7fb0-9089-6ce57d96cd4e"
            rollout = sessions_dir / f"rollout-2026-05-10T12-26-35-{session_id}.jsonl"
            rollout.write_text(json.dumps({"type": "message", "role": "user", "content": "hi"}) + "\n")
            (home / "session_index.jsonl").write_text(
                json.dumps({
                    "id": session_id,
                    "thread_name": "IVE codex smoke test",
                    "updated_at": "2026-05-10T10:26:35Z",
                }) + "\n"
            )

            with mock.patch.dict(os.environ, {"CODEX_HOME": str(home)}):
                projects = history_reader._list_codex_projects()

        self.assertEqual(len(projects), 1)
        self.assertEqual(projects[0]["cli_type"], "codex")
        self.assertEqual(projects[0]["sessions"][0]["session_id"], session_id)
        self.assertEqual(projects[0]["sessions"][0]["file"], str(rollout))

    def test_title_model_is_valid_for_each_cli(self):
        # Claude keeps its cheap haiku title model.
        self.assertEqual(hooks._title_model("claude"), "haiku")
        self.assertEqual(hooks._title_model("gemini"), "gemini-2.5-flash")
        # Codex must NOT inherit a Gemini model — that builds an invalid
        # `codex exec --model gemini-2.5-flash` and every Codex auto-title fails.
        codex_model = hooks._title_model("codex")
        self.assertEqual(codex_model, "gpt-5.4-mini")
        codex_ids = {m["id"] for m in get_profile("codex").available_models}
        self.assertIn(codex_model, codex_ids)

    def test_env_for_cli_home_is_profile_driven(self):
        for cli, var in [("claude", "CLAUDE_CONFIG_DIR"),
                         ("codex", "CODEX_HOME"), ("gemini", "GEMINI_HOME")]:
            env = server._env_for_cli_home(cli, "/tmp/h")
            self.assertEqual(env["HOME"], "/tmp/h")
            self.assertIn(var, env)
            self.assertTrue(
                env[var].endswith(get_profile(cli).auth_dir_name), cli
            )
        # Must derive the var from the profile field, not id branches.
        src = (BACKEND / "server.py").read_text()
        fn = src.split("def _env_for_cli_home")[1].split("\ndef ")[0]
        self.assertIn("profile.home_env_var", fn)
        self.assertNotIn('profile.id == "claude"', fn)
        self.assertNotIn('profile.id == "codex"', fn)

    def test_pick_codex_rollout_selection_logic(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            a = base / "rollout-a.jsonl"; a.write_text("{}")
            b = base / "rollout-b.jsonl"; b.write_text("{}")
            c = base / "rollout-c.jsonl"; c.write_text("{}")
            # Force a deterministic mtime ordering: a < b < c.
            os.utime(a, (1000, 1000))
            os.utime(b, (2000, 2000))
            os.utime(c, (3000, 3000))
            A, B, C = str(a), str(b), str(c)

            pick = server._pick_codex_rollout
            # Empty snapshot → nothing yet (caller retries).
            self.assertIsNone(pick(set(), set()))
            # Exactly one new file vs pre-existing → that file.
            self.assertEqual(pick({A, B}, {A}), b)
            # Multiple new files → newest by mtime.
            self.assertEqual(pick({A, B, C}, {A}), c)
            # No new files (snapshot == pre-existing) → None (keep waiting).
            self.assertIsNone(pick({A, B}, {A, B}))
            # No pre-existing baseline → newest overall.
            self.assertEqual(pick({A, B, C}, None), c)

    def _run_deferred(self, cli_type, prompt):
        writes = []

        class _PTY:
            def is_alive(self, sid):
                return True

            def write(self, sid, data):
                writes.append(data)

        async def _nosleep(*a, **k):
            return None

        with mock.patch.object(server, "pty_mgr", _PTY()), \
                mock.patch.object(server._asyncio, "sleep", _nosleep):
            asyncio.run(server._inject_deferred_initial_prompt(
                "sid-1", prompt, cli_type))
        return b"".join(writes)

    def test_codex_deferred_prompt_uses_no_bracketed_paste(self):
        # Codex's paste-burst composer echoes \x1b[200~/201~ literally and
        # treats \n as submit — the deferred prompt is Codex's ONLY
        # system-prompt channel, so it must go in clean.
        blob = self._run_deferred("codex", "line one\nline two")
        self.assertNotIn(b"\x1b[200~", blob)
        self.assertNotIn(b"\x1b[201~", blob)
        self.assertIn(b"line one", blob)
        self.assertIn(b"line two", blob)
        self.assertNotIn(b"\n", blob)        # newlines collapsed
        self.assertTrue(blob.endswith(b"\r"))  # submitted

    def test_claude_deferred_prompt_keeps_bracketed_paste(self):
        # Claude's Ink TUI relies on bracketed paste — must NOT regress.
        blob = self._run_deferred("claude", "sys prompt")
        self.assertIn(b"\x1b[200~", blob)
        self.assertIn(b"\x1b[201~", blob)

    def test_pipeline_auto_create_blocks_uninstalled_cli(self):
        # Pipeline stages INSERT sessions directly (not via POST /api/sessions),
        # so the spawn guard must be applied here too — before any DB write.
        class _BoomDB:
            async def execute(self, *a, **k):
                raise AssertionError("DB write attempted for uninstalled CLI")

            async def commit(self):
                raise AssertionError("commit attempted for uninstalled CLI")

        with mock.patch.object(
            pipeline_engine, "cli_install_error",
            return_value="Codex CLI (binary 'codex') is not installed.",
        ):
            result = asyncio.run(pipeline_engine._auto_create_session(
                _BoomDB(), "ws-1", "worker", "codex", {}
            ))
        self.assertIsNone(result)

    def test_pipeline_stage_model_coercion_is_profile_driven(self):
        coerce = pipeline_engine._coerce_stage_model
        # The bug: a Codex stage inherits a Claude alias from SESSION_TYPE_DEFAULTS.
        self.assertEqual(coerce("codex", "sonnet"), "gpt-5.4")
        self.assertEqual(coerce("codex", "opus"), "gpt-5.4")
        # A valid Codex model is left untouched.
        self.assertEqual(coerce("codex", "gpt-5.5"), "gpt-5.5")
        # Existing Claude/Gemini cross-CLI behavior preserved.
        self.assertEqual(coerce("gemini", "sonnet"), "gemini-2.5-pro")
        self.assertEqual(coerce("claude", "gemini-2.5-flash"), "sonnet")
        self.assertEqual(coerce("claude", "opus"), "opus")
        # Empty model is left for the caller's own default fallback.
        self.assertIsNone(coerce("codex", None))

    def test_pty_input_mode_is_profile_driven(self):
        # Codex must resolve to its own readline strategy, NOT Claude's Ink
        # path — sending Ink bracketed-paste/Escape sequences corrupts Codex's
        # paste-burst composer.
        self.assertEqual(server._pty_input_mode("codex"), "readline")
        self.assertEqual(server._pty_input_mode("gemini"), "gemini")
        self.assertEqual(server._pty_input_mode("claude"), "ink")

    def test_skill_install_defaults_do_not_hardcode_two_clis(self):
        # Spec invariant: skill/plugin install must default to every registered
        # CLI (incl. Codex), never a hardcoded ["claude", "gemini"] pair.
        self.assertIn("codex", skill_installer.default_cli_types())
        self.assertEqual(
            skill_installer.default_cli_types(), list(PROFILES),
        )
        offenders = []
        for mod in ("server.py", "plugin_manager.py"):
            for n, line in enumerate(
                (BACKEND / mod).read_text().splitlines(), start=1
            ):
                if '["claude", "gemini"]' in line:
                    offenders.append(f"{mod}:{n}")
        self.assertEqual(
            offenders, [],
            "two-CLI skill default hardcoded (Codex silently skipped) at: "
            f"{offenders}. Use skill_installer.default_cli_types().",
        )

    def test_cli_install_error_is_profile_driven(self):
        present = lambda b: "/usr/bin/" + b
        absent = lambda b: None
        self.assertIsNone(
            cli_registry.cli_install_error("codex", which=present)
        )
        msg = cli_registry.cli_install_error("codex", which=absent)
        self.assertIsInstance(msg, str)
        self.assertIn("codex", msg.lower())
        # Unknown id resolves a profile (claude fallback) but still checks its binary.
        self.assertIsNone(
            cli_registry.cli_install_error("claude", which=present)
        )

    def test_server_session_entry_points_call_install_guard(self):
        src = (BACKEND / "server.py").read_text()
        # create_session must validate + guard the cli_type, not silently
        # fall back to claude for an unknown/uninstalled CLI.
        self.assertIn("cli_install_error(", src)
        # Guard must be referenced at least twice (create + switch).
        self.assertGreaterEqual(src.count("cli_install_error("), 2)
        self.assertIn("from cli_registry import", src)

    def test_cli_for_model_routes_codex_models(self):
        # The bug: gpt-5.x never routed to Codex (fell through to claude).
        self.assertEqual(cli_registry.cli_for_model("gpt-5.4"), "codex")
        self.assertEqual(cli_registry.cli_for_model("gpt-5.3-codex"), "codex")
        # Existing routing preserved.
        self.assertEqual(cli_registry.cli_for_model("gemini-2.5-pro"), "gemini")
        self.assertEqual(cli_registry.cli_for_model("haiku"), "claude")
        self.assertEqual(cli_registry.cli_for_model("sonnet"), "claude")
        # Empty / unknown defaults to claude (back-compat with old inference).
        self.assertEqual(cli_registry.cli_for_model(""), "claude")
        self.assertEqual(cli_registry.cli_for_model(None), "claude")

    def test_codex_mcp_registration_command_uses_codex_flags(self):
        profile = get_profile("codex")
        server_cfg = {
            "server_name": "commander",
            "command": "python3",
            "args": ["backend/mcp_server.py"],
            "server_type": "stdio",
        }

        remove_cmd = mcp_registration.build_mcp_remove_command(profile, server_cfg)
        add_cmd = mcp_registration.build_mcp_add_command(
            profile,
            server_cfg,
            {"IVE_TOKEN": "abc"},
            effective_approve=True,
        )

        self.assertEqual(remove_cmd, ["codex", "mcp", "remove", "commander"])
        self.assertEqual(add_cmd, [
            "codex", "mcp", "add", "commander",
            "--env", "IVE_TOKEN=abc",
            "--", "python3", "backend/mcp_server.py",
        ])

    def test_gemini_mcp_registration_command_keeps_existing_flags(self):
        profile = get_profile("gemini")
        server_cfg = {
            "server_name": "commander",
            "command": "python3",
            "args": ["backend/mcp_server.py"],
            "server_type": "stdio",
        }

        add_cmd = mcp_registration.build_mcp_add_command(
            profile,
            server_cfg,
            {"IVE_TOKEN": "abc"},
            effective_approve=True,
        )

        self.assertIn("--scope", add_cmd)
        self.assertIn("--transport", add_cmd)
        self.assertIn("--trust", add_cmd)
        self.assertIn("-e", add_cmd)

    def test_skill_installer_defaults_to_all_registered_profiles(self):
        self.assertEqual(skill_installer.default_cli_types(), list(PROFILES))

    def test_hook_installation_status_is_profile_driven(self):
        with mock.patch.object(hook_installer, "_read_settings", return_value={}):
            status = hook_installer.check_installation()

        self.assertIn("codex", status)
        self.assertFalse(status["codex"])

    def test_codex_rollout_snapshot_uses_codex_home(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / ".codex"
            rollout_dir = home / "sessions" / "2026" / "05" / "10"
            rollout_dir.mkdir(parents=True)
            session_id = "019e116c-ad33-7fb0-9089-6ce57d96cd4e"
            rollout = rollout_dir / f"rollout-2026-05-10T12-26-35-{session_id}.jsonl"
            rollout.write_text("{}\n")

            with mock.patch.dict(os.environ, {"CODEX_HOME": str(home)}):
                snapshot = codex_sessions.snapshot_codex_sessions("/unused")

        self.assertEqual(snapshot, {str(rollout)})
        self.assertEqual(codex_sessions.codex_session_id_from_rollout(rollout), session_id)

    def test_resume_feature_distinguishes_codex_from_gemini(self):
        codex = UnifiedSession("codex", {})
        applied = codex_sessions.set_native_resume_feature(
            codex,
            "/tmp/workspace",
            "019e116c-ad33-7fb0-9089-6ce57d96cd4e",
            lambda _workspace, _native_sid: None,
        )

        self.assertTrue(applied)
        self.assertIn("resume", codex.build_command())
        self.assertIn("019e116c-ad33-7fb0-9089-6ce57d96cd4e", codex.build_command())

        gemini = UnifiedSession("gemini", {})
        applied = codex_sessions.set_native_resume_feature(
            gemini,
            "/tmp/workspace",
            "session-stem",
            lambda _workspace, _native_sid: "2",
        )

        self.assertTrue(applied)
        self.assertEqual(gemini.get(Feature.RESUME_ID), "2")

    def test_plugin_exporter_supports_codex_plugins_and_hooks(self):
        compatibility = plugin_exporter.classify_hook("PreToolUse")
        self.assertTrue(compatibility["codex"])
        self.assertEqual(compatibility["codex_name"], "PreToolUse")

        exporter = plugin_exporter.PluginExporter()
        plugin = {"name": "Codex Helper", "version": "1.0.0", "description": "Test plugin"}
        components = [
            {
                "type": "guideline",
                "activation": "on_demand",
                "name": "Say Hi",
                "content": "---\nname: say-hi\ndescription: Say hi.\n---\nSay hi.",
            },
            {
                "type": "script",
                "name": "Check Shell",
                "trigger": "PreToolUse",
                "content": "echo ok",
            },
        ]
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "codex-helper"
            result = asyncio.run(exporter.export(plugin, components, "codex", dest))

            self.assertTrue(result["ok"])
            manifest = json.loads((dest / ".codex-plugin" / "plugin.json").read_text())
            hooks = json.loads((dest / "hooks" / "hooks.json").read_text())
            self.assertEqual(manifest["name"], "codex-helper")
            self.assertEqual(manifest["skills"], "./skills/")
            self.assertEqual(manifest["hooks"], "./hooks/hooks.json")
            self.assertIn("PreToolUse", hooks["hooks"])


if __name__ == "__main__":
    unittest.main()
