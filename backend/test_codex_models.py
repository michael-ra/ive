"""Codex model menu comes from the account's models_cache.json, not a stale list.

Pure unit tests with temp CODEX_HOME dirs; never starts a server or a CLI.
"""
import copy
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

from cli_profiles import CODEX_PROFILE
from model_discovery import (
    apply_codex_discovery, codex_model_ladder, discover_codex_default_model,
    discover_codex_models,
)


CACHE = {
    "fetched_at": "2026-10-10T08:00:00Z",
    "client_version": "0.162.1",
    "models": [
        {"slug": "gpt-6-luna", "display_name": "GPT-6-Luna", "description": "Fast",
         "visibility": "list", "priority": 4,
         "supported_reasoning_levels": [{"effort": "low"}, {"effort": "medium"}],
         "default_reasoning_level": "medium"},
        {"slug": "gpt-6.1-sol", "display_name": "GPT-6.1-Sol", "description": "Workhorse",
         "visibility": "list", "priority": 1},
        {"slug": "gpt-5.5", "display_name": "GPT-5.5", "description": "Legacy",
         "visibility": "hide", "priority": 13},
        {"slug": "gpt-6-astra", "display_name": "GPT-6-Astra", "description": "Frontier",
         "visibility": "list", "priority": 2},
        {"slug": "codex-auto-review", "visibility": "hide", "priority": 43},
    ],
}


def _home(tmp, cache=CACHE, config='model = "gpt-6-astra"\n'):
    home = Path(tmp)
    if cache is not None:
        (home / "models_cache.json").write_text(json.dumps(cache))
    if config is not None:
        (home / "config.toml").write_text(config)
    return home


class DiscoverCodexModelsTests(unittest.TestCase):
    def test_only_visible_models_in_codex_priority_order(self):
        with TemporaryDirectory() as tmp:
            models = discover_codex_models(_home(tmp))
        self.assertEqual([m["id"] for m in models], ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"])
        self.assertEqual(models[0]["label"], "GPT-6.1-Sol")
        self.assertEqual(models[2]["effort_levels"], ["low", "medium"])

    def test_missing_or_broken_cache_returns_none(self):
        with TemporaryDirectory() as tmp:
            self.assertIsNone(discover_codex_models(_home(tmp, cache=None)))
            (Path(tmp) / "models_cache.json").write_text("{not json")
            self.assertIsNone(discover_codex_models(tmp))

    def test_reads_codex_home_env(self):
        with TemporaryDirectory() as tmp:
            _home(tmp)
            with mock.patch.dict(os.environ, {"CODEX_HOME": tmp}):
                self.assertEqual(discover_codex_default_model(), "gpt-6-astra")
                self.assertEqual(len(discover_codex_models()), 3)

    def test_ladder_is_weakest_first(self):
        self.assertEqual(
            codex_model_ladder([{"id": "a"}, {"id": "b"}, {"id": ""}]), ["b", "a"])


class ApplyCodexDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.profile = copy.deepcopy(CODEX_PROFILE)

    def test_static_profile_has_no_hardcoded_gpt_picks(self):
        self.assertEqual(CODEX_PROFILE.default_commander_model, "")
        self.assertEqual(CODEX_PROFILE.default_tester_model, "")
        self.assertEqual([m["id"] for m in CODEX_PROFILE.available_models], [""])

    def test_menu_and_role_defaults_follow_config(self):
        with TemporaryDirectory() as tmp:
            home = _home(tmp)
            apply_codex_discovery(self.profile, discover_codex_models(home),
                                  discover_codex_default_model(home))
        ids = [m["id"] for m in self.profile.available_models]
        self.assertEqual(ids, ["", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"])
        self.assertEqual(self.profile.available_models[0]["label"], "Default (gpt-6-astra)")
        self.assertEqual(self.profile.default_model, "gpt-6-astra")
        self.assertEqual(self.profile.default_commander_model, "gpt-6-astra")
        self.assertEqual(self.profile.default_tester_model, "gpt-6-astra")
        self.assertEqual(self.profile.model_ladder, ["gpt-6-luna", "gpt-6-astra", "gpt-6.1-sol"])

    def test_hidden_configured_model_stays_selectable(self):
        with TemporaryDirectory() as tmp:
            home = _home(tmp, config='model = "gpt-5.5"\n')
            apply_codex_discovery(self.profile, discover_codex_models(home),
                                  discover_codex_default_model(home))
        self.assertIn("gpt-5.5", [m["id"] for m in self.profile.available_models])
        self.assertEqual(self.profile.default_commander_model, "gpt-5.5")

    def test_no_cache_keeps_fallback_but_uses_config_default(self):
        apply_codex_discovery(self.profile, None, "gpt-6-astra")
        self.assertEqual([m["id"] for m in self.profile.available_models], ["", "gpt-6-astra"])
        self.assertEqual(self.profile.default_tester_model, "gpt-6-astra")


if __name__ == "__main__":
    unittest.main()
