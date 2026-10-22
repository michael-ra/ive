"""Codex 0.16x hook trust: IVE keeps its own config.toml hooks trusted, stable
and honestly attested.

Fully isolated: IVE_DATA_DIR and HOME point at a temp dir before any backend
import; every config.toml lives in that temp dir. Never touches ~/.codex.
"""
import os
import tempfile
import tomllib
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

_HOOKS_DIR = _ROOT / "state" / ".ive-team-state" / "hooks"
RELAY = str(_HOOKS_DIR / hi.HOOK_SCRIPT_NAME)
GATE = _HOOKS_DIR / "safety_gate.sh"
GATE_POST = _HOOKS_DIR / "safety_gate_post.sh"

USER_HOOKS = """model = "gpt-6-astra"

[[hooks.PreToolUse]]
matcher = "Bash"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "/Users/someone/bin/audit.sh"
"""


def _relay_groups():
    profile = get_profile("codex")
    return {
        event: [{"matcher": "", "hooks": [{"type": "command", "command": RELAY}]}]
        for event in hi.relay_hook_events(profile)
    }


def _gate_groups():
    return {
        "PreToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": str(GATE), "timeout": 135}]}],
        "PostToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": str(GATE_POST), "timeout": 2}]}],
    }


def _myelin_groups():
    return {
        "UserPromptSubmit": [{"matcher": "", "hooks": [{"type": "command", "command": "/py /m/hook.py --event user_prompt"}]}],
        "PreToolUse": [{"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "/py /m/hook.py --event pre_tool"}]}],
    }


def _states(path):
    return tomllib.loads(path.read_text()).get("hooks", {}).get("state", {})


class CodexHashTests(unittest.TestCase):
    # Same algorithm codex-cli 0.162.1 uses after /hooks review; the values were
    # first checked against hashes codex wrote itself, then recomputed for this path.
    P = "/Users/dev/ive/.ive-team-state/hooks/"

    def test_matches_codex_written_hashes(self):
        cases = [
            ("SessionStart", "", "hook.sh", None, "fc3acb23ec7a8dae97bce5df851f7668c9835003fcd66c92428d941b5722a266"),
            ("SessionEnd", "", "hook.sh", None, "268fec82e63e5400fab6ffdb6172b2e1bcc0479669b3d1c4c64a43f34204eca1"),
            ("Stop", "", "hook.sh", None, "f7a21e2a264ba3de6fdb0b1205e6591decda32f3f4853a2bd0db004f85f4b760"),
            ("UserPromptSubmit", "", "hook.sh", None, "2f0297a56fe38fac2a58712329f19ebdb1af2997d7c17a89299f25ba450d948d"),
            ("PreToolUse", "", "safety_gate.sh", 135, "8921c6d791737992329fcc3e1e624f947240adb63947670289f96bed0c1837f9"),
            ("PreToolUse", "", "hook.sh", None, "80ccbf17f4bb4c3923e3e675243ffbba4db2818f786c2979e2df685da8f72c20"),
            ("PostToolUse", "", "safety_gate_post.sh", 2, "75e021a0006e47a36b3b1363c3a8d1d53182003a29c2da89a032e5fb474665d5"),
            ("PermissionRequest", "", "hook.sh", None, "c190d74630b35e5aa857b06dfb0a2b9fb1b466ce78a79d7d9db2f9fb2df34453"),
            ("SubagentStop", "", "hook.sh", None, "386efc7228ca23d52ad0fb3d2ed1938e0fd2921466bcc8703eecf1d404ae60dd"),
        ]
        for event, matcher, script, timeout, expected in cases:
            handler = {"type": "command", "command": self.P + script}
            if timeout is not None:
                handler["timeout"] = timeout
            with self.subTest(event=event, script=script):
                self.assertEqual(
                    hi.codex_hook_hash(event, {"matcher": matcher}, handler),
                    "sha256:" + expected,
                )


class CodexTrustInstallTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir=_ROOT))
        self.codex_home = self.dir / ".codex"
        self.codex_home.mkdir()
        self.path = self.codex_home / "config.toml"
        self.key = str(self.codex_home.resolve()) + "/config.toml"

    def install_all_blocks(self):
        hi._install_toml_hook_block(self.path, hi._CODEX_SAFETY_HOOK_OWNER, _gate_groups())
        return hi._install_toml_hook_block(self.path, hi._CODEX_COMMANDER_HOOK_OWNER, _relay_groups())

    def test_trusts_only_ive_handlers(self):
        self.path.write_text(USER_HOOKS)
        report = self.install_all_blocks()
        self.assertTrue(report["all_ive_trusted"], report)
        states = _states(self.path)
        # User hook keeps index 0 and is NOT trusted by IVE.
        self.assertNotIn(f"{self.key}:pre_tool_use:0:0", states)
        self.assertIn(f"{self.key}:pre_tool_use:1:0", states)  # safety gate
        self.assertIn(f"{self.key}:pre_tool_use:2:0", states)  # relay
        user = [e for e in report["hooks"] if e["owner"] is None]
        self.assertEqual([e["status"] for e in user], ["untrusted"])
        self.assertIsNone(hi.codex_hooks_notice(report))
        self.assertTrue(tomllib.loads(self.path.read_text())["model"] == "gpt-6-astra")

    def test_reinstall_is_byte_identical(self):
        self.path.write_text(USER_HOOKS)
        self.install_all_blocks()
        before = self.path.read_bytes()
        mtime = self.path.stat().st_mtime_ns
        report = self.install_all_blocks()
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.path.stat().st_mtime_ns, mtime)
        self.assertEqual(report["auto_trusted"], 0)
        self.assertTrue(report["all_ive_trusted"])

    def test_codex_state_tables_inside_ive_block_survive(self):
        # Exactly what codex 0.162 did: it appended trust tables before the
        # trailing "<<< commander-relay" comment, i.e. inside IVE's block.
        self.path.write_text(USER_HOOKS)
        self.install_all_blocks()
        text = self.path.read_text()
        user_key = f"{self.key}:pre_tool_use:0:0"
        end = hi._toml_hook_marker(hi._CODEX_COMMANDER_HOOK_OWNER, end=True)
        # Move IVE's own trust tables inside the block too, and add the user's.
        block_end = text.index(end)
        tail = text[block_end + len(end):]
        text = text[:block_end] + tail.strip() + "\n\n" + hi._state_header(user_key) + '\ntrusted_hash = "sha256:userhash"\n' + end + "\n"
        self.path.write_text(text)
        tomllib.loads(text)
        report = self.install_all_blocks()
        states = _states(self.path)
        self.assertEqual(states[user_key]["trusted_hash"], "sha256:userhash")
        self.assertTrue(report["all_ive_trusted"], report)
        before = self.path.read_bytes()
        self.install_all_blocks()
        self.assertEqual(self.path.read_bytes(), before)
        # Uninstall keeps codex's trust tables as well.
        hi._uninstall_toml_hook_block(self.path, hi._CODEX_COMMANDER_HOOK_OWNER)
        self.assertEqual(_states(self.path)[user_key]["trusted_hash"], "sha256:userhash")

    def test_toggling_myelin_does_not_shift_relay_or_gate(self):
        self.install_all_blocks()
        keys = {e["key"] for e in hi.codex_hook_trust_report(self.path)["hooks"]
                if e["owner"] in (hi._CODEX_COMMANDER_HOOK_OWNER, hi._CODEX_SAFETY_HOOK_OWNER)}
        hi._install_toml_hook_block(self.path, hi._CODEX_MYELIN_HOOK_OWNER, _myelin_groups())
        report = self.install_all_blocks()
        self.assertTrue(report["all_ive_trusted"], report)
        after = {e["key"] for e in report["hooks"]
                 if e["owner"] in (hi._CODEX_COMMANDER_HOOK_OWNER, hi._CODEX_SAFETY_HOOK_OWNER)}
        self.assertEqual(keys, after)
        hi._uninstall_toml_hook_block(self.path, hi._CODEX_MYELIN_HOOK_OWNER)
        self.assertTrue(hi.codex_hook_trust_report(self.path)["all_ive_trusted"])

    def test_changed_handler_updates_existing_state_in_place(self):
        self.install_all_blocks()
        groups = _gate_groups()
        groups["PreToolUse"][0]["hooks"][0]["timeout"] = 140
        report = hi._install_toml_hook_block(self.path, hi._CODEX_SAFETY_HOOK_OWNER, groups)
        self.assertTrue(report["all_ive_trusted"], report)
        text = self.path.read_text()
        header = hi._state_header(f"{self.key}:pre_tool_use:0:0")
        self.assertEqual(text.count(header), 1)
        self.assertEqual(
            _states(self.path)[f"{self.key}:pre_tool_use:0:0"]["trusted_hash"],
            hi.codex_hook_hash("PreToolUse", groups["PreToolUse"][0], groups["PreToolUse"][0]["hooks"][0]),
        )

    def test_user_disabled_hook_stays_disabled_and_is_reported(self):
        self.install_all_blocks()
        key = f"{self.key}:stop:0:0"
        text = self.path.read_text().replace(
            hi._state_header(key) + "\n", hi._state_header(key) + "\nenabled = false\n"
        )
        self.path.write_text(text)
        report = self.install_all_blocks()
        self.assertFalse(report["all_ive_trusted"])
        self.assertIs(_states(self.path)[key]["enabled"], False)
        self.assertIn("disabled", hi.codex_hooks_notice(report))

    def test_auto_trust_off_reports_review_notice(self):
        with patch.dict(os.environ, {"IVE_CODEX_AUTO_TRUST_HOOKS": "0"}):
            report = self.install_all_blocks()
        self.assertFalse(report["all_ive_trusted"])
        self.assertEqual(_states(self.path), {})
        notice = hi.codex_hooks_notice(report)
        self.assertIn("/hooks", notice)
        self.assertIn("need review", notice)

    def test_account_codex_home_behind_symlink_uses_canonical_key(self):
        real = self.dir / "real-account"
        (real / ".codex").mkdir(parents=True)
        link = self.dir / "account-link"
        link.symlink_to(real)
        path = link / ".codex" / "config.toml"
        hi._install_toml_hook_block(path, hi._CODEX_COMMANDER_HOOK_OWNER, _relay_groups())
        states = _states(path)
        canonical = str((real / ".codex").resolve()) + "/config.toml"
        self.assertIn(f"{canonical}:session_start:0:0", states)

    def test_unindexable_layout_is_not_trusted(self):
        self.path.write_text(
            'model = "x"\n\n[hooks]\nStop = [{ matcher = "", hooks = [{ type = "command", command = "/u.sh" }] }]\n'
        )
        before = self.path.read_text()
        report = hi._install_toml_hook_block(self.path, hi._CODEX_COMMANDER_HOOK_OWNER, _relay_groups())
        self.assertFalse(report["all_ive_trusted"])
        self.assertEqual(report["reason"], "hook_block_conflict")
        self.assertEqual(self.path.read_text(), before)  # never write a config codex rejects
        self.assertIn("/hooks", hi.codex_hooks_notice(report))

    def test_inline_user_hooks_in_other_events_do_not_block_trust(self):
        # Inline user hooks for an event IVE does not use: that event cannot
        # be indexed, but IVE's own positions are still exact.
        self.path.write_text('[hooks]\nInterrupt = [{ hooks = [{ type = "command", command = "/u.sh" }] }]\n')
        report = hi._install_toml_hook_block(self.path, hi._CODEX_COMMANDER_HOOK_OWNER, _relay_groups())
        tomllib.loads(self.path.read_text())
        self.assertTrue(report["all_ive_trusted"], report)
        self.assertFalse(any(e["event"] == "Interrupt" for e in report["hooks"]))


class CodexSafetyGateAttestationTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(dir=_ROOT))
        self.codex_home = self.home / ".codex"
        self.codex_home.mkdir()
        self.path = self.codex_home / "config.toml"
        _HOOKS_DIR.mkdir(parents=True, exist_ok=True)
        self.patches = [
            patch.object(hi, "SAFETY_GATE_SCRIPT_PATH", GATE),
            patch.object(hi, "SAFETY_GATE_POST_SCRIPT_PATH", GATE_POST),
            patch.object(hi, "HOOKS_DIR", _HOOKS_DIR),
        ]
        for p in self.patches:
            p.start()
        hi.generate_safety_gate_script()
        self.env = {"HOME": str(self.home), "CODEX_HOME": str(self.codex_home)}

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_untrusted_gate_is_not_attested(self):
        with patch.dict(os.environ, {"IVE_CODEX_AUTO_TRUST_HOOKS": "0"}):
            hi._install_toml_hook_block(self.path, hi._CODEX_SAFETY_HOOK_OWNER, _gate_groups())
        evidence = hi.attest_runtime_safety_gate("codex", self.env)
        self.assertFalse(evidence["attested"])
        self.assertEqual(evidence["reason"], "codex_hook_untrusted")
        self.assertEqual(evidence["hook_trust"]["gate"][0]["status"], "untrusted")

    def test_trusted_gate_is_attested(self):
        hi._install_toml_hook_block(self.path, hi._CODEX_SAFETY_HOOK_OWNER, _gate_groups())
        evidence = hi.attest_runtime_safety_gate("codex", self.env)
        self.assertTrue(evidence["attested"], evidence)
        self.assertEqual(evidence["hook_trust"]["gate"][0]["status"], "trusted")


if __name__ == "__main__":
    unittest.main()
