"""Effort flag building, effective-default resolution and runtime model reads.

Pure unit tests: temp dirs only, never starts a server or a CLI.
"""
import ast
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

from cli_features import Feature
from cli_profiles import CLAUDE_PROFILE, CODEX_PROFILE
from cli_session import UnifiedSession
from effort_defaults import (
    CLAUDE_EFFORT_LEVELS, default_label, resolve_claude_effort_default,
)
from runtime_model import read_runtime_model


def _effort_args(cli, value):
    argv = UnifiedSession(cli, {"effort": value}).build_command()
    if "--effort" in argv:
        i = argv.index("--effort")
        return argv[i:i + 2]
    return []


def _server_fn(name):
    tree = ast.parse(Path(__file__).with_name("server.py").read_text())
    node = next(n for n in tree.body if getattr(n, "name", None) == name)
    ns = {}
    exec(compile(ast.Module(body=[node], type_ignores=[]), "server.py", "exec"), ns)
    return ns[name]


class ClaudeEffortFlagTests(unittest.TestCase):
    def test_levels_match_claude_cli(self):
        self.assertEqual(CLAUDE_PROFILE.effort_levels, ["low", "medium", "high", "xhigh", "max"])
        self.assertEqual(CLAUDE_EFFORT_LEVELS, CLAUDE_PROFILE.effort_levels)

    def test_every_set_level_is_passed_including_high(self):
        for level in CLAUDE_EFFORT_LEVELS:
            self.assertEqual(_effort_args("claude", level), ["--effort", level])

    def test_empty_or_unknown_means_claude_default(self):
        for value in (None, "", "ultra", "bogus"):
            self.assertEqual(_effort_args("claude", value), [], value)

    def test_value_is_normalised(self):
        self.assertEqual(_effort_args("claude", " XHigh "), ["--effort", "xhigh"])

    def test_codex_stays_on_its_own_config(self):
        # Codex reads model_reasoning_effort from config.toml; IVE does not
        # offer or pass an effort for it (no Feature.EFFORT binding).
        self.assertEqual(CODEX_PROFILE.effort_levels, [])
        self.assertFalse(CODEX_PROFILE.supports(Feature.EFFORT))
        argv = UnifiedSession("codex", {"effort": "high"}).build_command()
        self.assertNotIn("--effort", argv)
        self.assertFalse(any("reasoning_effort" in a for a in argv))


class EffortStorageTests(unittest.TestCase):
    def setUp(self):
        self.fn = _server_fn("_effort_for_storage")
        self.claude = SimpleNamespace(effort_levels=list(CLAUDE_EFFORT_LEVELS))

    def test_nothing_chosen_is_stored_as_none_not_high(self):
        self.assertIsNone(self.fn(self.claude, None))
        self.assertIsNone(self.fn(self.claude, ""))

    def test_valid_levels_kept(self):
        self.assertEqual(self.fn(self.claude, "xhigh"), "xhigh")
        self.assertEqual(self.fn(self.claude, "MAX"), "max")

    def test_invalid_or_unsupported(self):
        self.assertIsNone(self.fn(self.claude, "ultra"))
        self.assertIsNone(self.fn(SimpleNamespace(effort_levels=[]), "high"))


class EffortDefaultTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.ws = Path(self.tmp.name) / "ws"
        (self.home / ".claude").mkdir(parents=True)
        (self.ws / ".claude").mkdir(parents=True)

    def write(self, path, data):
        path.write_text(json.dumps(data))

    def resolve(self, **kw):
        kw.setdefault("env", {})
        return resolve_claude_effort_default(home=self.home, **kw)

    def test_no_settings_falls_back_to_claude(self):
        r = self.resolve()
        self.assertIsNone(r["value"])
        self.assertEqual(default_label(r), "Default (Claude picks per model)")

    def test_user_effort_level(self):
        self.write(self.home / ".claude" / "settings.json", {"effortLevel": "xhigh"})
        r = self.resolve()
        self.assertEqual((r["value"], r["source"]), ("xhigh", "your Claude settings"))
        self.assertEqual(default_label(r), "Default (xhigh, your Claude settings)")

    def test_project_local_beats_project_beats_user(self):
        self.write(self.home / ".claude" / "settings.json", {"effortLevel": "xhigh"})
        self.write(self.ws / ".claude" / "settings.json", {"effortLevel": "medium"})
        self.assertEqual(self.resolve(workspace_path=str(self.ws))["value"], "medium")
        self.write(self.ws / ".claude" / "settings.local.json", {"effortLevel": "low"})
        self.assertEqual(self.resolve(workspace_path=str(self.ws))["value"], "low")

    def test_model_settings_and_env(self):
        self.write(self.home / ".claude" / "settings.json", {
            "effortLevel": "xhigh",
            "modelSettings": {"claude-opus-5": {"effortLevel": "low"}, "x": "junk"},
        })
        self.assertEqual(self.resolve(model="claude-opus-5")["value"], "low")
        self.assertEqual(self.resolve(model="claude-opus-5[1m]")["value"], "low")
        self.assertEqual(self.resolve(model="claude-opus-5-5")["value"], "xhigh")
        self.assertEqual(self.resolve(model="opus")["value"], "xhigh")
        self.assertEqual(self.resolve()["by_model"], {"claude-opus-5": "low"})
        r = self.resolve(env={"CLAUDE_CODE_EFFORT_LEVEL": "max"})
        self.assertEqual((r["value"], r["source"]), ("max", "CLAUDE_CODE_EFFORT_LEVEL"))

    def test_invalid_values_ignored(self):
        self.write(self.home / ".claude" / "settings.json", {"effortLevel": "turbo"})
        self.assertIsNone(self.resolve()["value"])
        (self.home / ".claude" / "settings.json").write_text("{not json")
        self.assertIsNone(self.resolve()["value"])


class RuntimeModelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def write(self, records):
        path = Path(self.tmp.name) / "t.jsonl"
        path.write_text("\n".join(json.dumps(r) for r in records) + "\n")
        return path

    def test_claude_last_assistant_wins_and_synthetic_skipped(self):
        path = self.write([
            {"type": "assistant", "message": {"model": "claude-sonnet-5"}, "effort": "high"},
            {"type": "user", "message": {"content": "/model opus"}},
            {"type": "assistant", "message": {"model": "claude-opus-5-5"}, "effort": "xhigh"},
            {"type": "assistant", "message": {"model": "<synthetic>"}},
        ])
        self.assertEqual(read_runtime_model(path), {"model": "claude-opus-5-5", "effort": "xhigh"})

    def test_codex_turn_context(self):
        path = self.write([
            {"type": "session_meta", "payload": {}},
            {"type": "turn_context", "payload": {"model": "gpt-6-astra", "effort": "xhigh"}},
            {"type": "response_item", "payload": {}},
        ])
        self.assertEqual(read_runtime_model(path), {"model": "gpt-6-astra", "effort": "xhigh"})

    def test_missing_or_empty(self):
        self.assertIsNone(read_runtime_model(None))
        self.assertIsNone(read_runtime_model(Path(self.tmp.name) / "nope.jsonl"))
        self.assertIsNone(read_runtime_model(self.write([{"type": "user"}])))

    def test_only_tail_is_read(self):
        import runtime_model
        old = runtime_model.TAIL_BYTES
        runtime_model.TAIL_BYTES = 200
        self.addCleanup(setattr, runtime_model, "TAIL_BYTES", old)
        recs = [{"type": "assistant", "message": {"model": "old-model"}, "effort": "low"}]
        recs += [{"type": "user", "pad": "x" * 50} for _ in range(10)]
        recs += [{"type": "assistant", "message": {"model": "new-model"}}]
        self.assertEqual(read_runtime_model(self.write(recs)), {"model": "new-model", "effort": None})


class FakeHighMigrationTests(unittest.IsolatedAsyncioTestCase):
    """The one-shot migration that drops IVE's old fake 'high' default."""

    async def asyncSetUp(self):
        import os
        from unittest.mock import patch
        import db as database
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        data = Path(self.tmp.name) / "data"
        data.mkdir()
        for target, value in [("DATA_DIR", data), ("DB_PATH", data / "test.db")]:
            p = patch.object(database, target, value); p.start(); self.addCleanup(p.stop)
        p = patch.dict(os.environ, {"HOME": str(Path(self.tmp.name))}); p.start(); self.addCleanup(p.stop)
        self.database = database
        await database.init_db()
        self.db = await database.get_db()
        self.addAsyncCleanup(self.db.close)

    async def effort(self, table, row_id):
        cur = await self.db.execute(f"SELECT effort FROM {table} WHERE id = ?", (row_id,))
        return (await cur.fetchone())["effort"]

    async def test_marker_written_on_init_and_old_high_rows_cleared_once(self):
        from effort_migration import MARKER, migrate_fake_high_effort
        cur = await self.db.execute("SELECT 1 FROM app_settings WHERE key = ?", (MARKER,))
        self.assertIsNotNone(await cur.fetchone(), "fresh init records the marker")

        # Simulate a database from before fix/effort: marker absent, old rows.
        await self.db.execute("DELETE FROM app_settings WHERE key = ?", (MARKER,))
        rows = [
            ("s-claude-high", "claude", "high"), ("s-null-cli-high", None, "high"),
            ("s-claude-xhigh", "claude", "xhigh"), ("s-claude-null", "claude", None),
            ("s-codex-high", "codex", "high"),
        ]
        for sid, cli, eff in rows:
            await self.db.execute(
                "INSERT INTO sessions (id, name, cli_type, effort) VALUES (?, ?, ?, ?)",
                (sid, sid, cli, eff),
            )
        await self.db.execute(
            "INSERT INTO sessions (id, name) VALUES ('s-schema-default', 'x')")  # DEFAULT 'high'
        for tid, cli, eff in [("t-claude-high", "claude", "high"), ("t-claude-max", "claude", "max"),
                              ("t-codex-high", "codex", "high")]:
            await self.db.execute(
                "INSERT INTO templates (id, name, cli_type, effort) VALUES (?, ?, ?, ?)",
                (tid, tid, cli, eff),
            )
        await self.db.commit()

        counts = await migrate_fake_high_effort(self.db)
        await self.db.commit()
        self.assertEqual(counts, {"sessions": 3, "templates": 1})
        self.assertIsNone(await self.effort("sessions", "s-claude-high"))
        self.assertIsNone(await self.effort("sessions", "s-null-cli-high"))
        self.assertIsNone(await self.effort("sessions", "s-schema-default"))
        self.assertEqual(await self.effort("sessions", "s-claude-xhigh"), "xhigh")
        self.assertEqual(await self.effort("sessions", "s-codex-high"), "high")
        self.assertIsNone(await self.effort("templates", "t-claude-high"))
        self.assertEqual(await self.effort("templates", "t-claude-max"), "max")
        self.assertEqual(await self.effort("templates", "t-codex-high"), "high")

        # The user now really picks "high": neither a rerun nor a restart touches it.
        await self.db.execute("UPDATE sessions SET effort = 'high' WHERE id = 's-claude-high'")
        await self.db.commit()
        self.assertIsNone(await migrate_fake_high_effort(self.db))
        await self.db.close()
        await self.database.init_db()
        self.db = await self.database.get_db()
        self.addAsyncCleanup(self.db.close)
        self.assertEqual(await self.effort("sessions", "s-claude-high"), "high")


class PresetEffortTests(unittest.TestCase):
    """Role/pipeline presets leave effort empty so the user's setting applies."""

    def test_no_hard_coded_high_left_in_presets(self):
        for name in ("pipeline_engine.py", "role_templates.py", "pipeline.py"):
            src = Path(__file__).with_name(name).read_text()
            self.assertNotIn('"effort": "high"', src, name)

    def test_session_type_defaults_and_presets(self):
        import pipeline_engine
        for role, cfg in pipeline_engine.SESSION_TYPE_DEFAULTS.items():
            self.assertFalse(cfg.get("effort"), role)
        for pid, preset in pipeline_engine.PRESETS.items():
            for stage in preset.get("stages", []):
                self.assertFalse((stage.get("agent_config") or {}).get("effort"), (pid, stage.get("id")))

    def test_role_templates_and_binding(self):
        import role_templates
        for role, tmpl in role_templates.ROLE_TEMPLATES.items():
            self.assertFalse(tmpl.get("effort"), role)
        self.assertIsNone(role_templates.resolve_binding("worker")["effort"])
        self.assertIsNone(role_templates.resolve_binding("no-such-role")["effort"])

    def test_pipeline_effort_helper(self):
        import pipeline
        claude = SimpleNamespace(effort_levels=list(CLAUDE_EFFORT_LEVELS))
        self.assertIsNone(pipeline._effort_for_profile(claude))
        self.assertEqual(pipeline._effort_for_profile(claude, "xhigh"), "xhigh")
        self.assertIsNone(pipeline._effort_for_profile(claude, "ultra"))
        self.assertIsNone(pipeline._effort_for_profile(SimpleNamespace(effort_levels=[]), "high"))


if __name__ == "__main__":
    unittest.main()
