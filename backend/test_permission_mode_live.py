"""Live permission-mode apply: never starts a real CLI or touches user data."""
import ast
import asyncio
import json
import logging
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp import web

import db as database
from cli_features import Feature
from cli_profiles import get_profile
from commander_events import CommanderEvent
from permission_mode_live import LiveLaunchApplier, LiveModeApplier


class FakeSession:
    def __init__(self):
        self.alive = True
        self.status = "idle"
        self.restarts = []
        self.events = []
        self.restart_result = {"ok": True, "resumed": True, "native_session_id": "native-1"}
        self.restart_gate = None

    async def restart(self, sid, mode):
        self.restarts.append((sid, mode))
        if self.restart_gate is not None:
            await self.restart_gate.wait()
        return dict(self.restart_result)

    async def broadcast(self, event):
        self.events.append(event)

    def states(self):
        return [(e["state"], e.get("mode")) for e in self.events]


def make(fake, **kw):
    return LiveModeApplier(
        restart=fake.restart,
        is_alive=lambda sid: fake.alive,
        status=lambda sid: fake.status,
        broadcast=fake.broadcast,
        debounce=kw.get("debounce", 0.01),
        poll_interval=0.01,
    )


async def settle(applier, sid, timeout=2.0):
    for _ in range(int(timeout / 0.01)):
        if applier.pending(sid) is None:
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"apply never settled: {applier.pending(sid)}")


class LiveModeApplierTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_change_remains_visible_and_same_choice_can_retry(self):
        fake = FakeSession()
        fake.restart_result = {"ok": False, "error": "test failure"}
        applier = make(fake)
        await applier.request("s1", "default", "plan")
        await settle(applier, "s1")
        self.assertEqual(applier.snapshot("s1", "permission_mode")["from"], "default")
        self.assertEqual(applier.snapshot("s1", "permission_mode")["state"], "failed")
        fake.restart_result = {"ok": True, "resumed": True}
        result = await applier.request("s1", "plan", "plan")
        self.assertEqual(result["state"], "scheduled")
        self.assertEqual(result["from"], "default")
        await settle(applier, "s1")
        self.assertEqual(len(fake.restarts), 2)
        self.assertIsNone(applier.snapshot("s1", "permission_mode"))

    async def test_idle_session_restarts_once_with_new_mode(self):
        fake = FakeSession()
        applier = make(fake)
        res = await applier.request("s1", "auto", "plan")
        self.assertEqual(res["state"], "scheduled")
        await settle(applier, "s1")
        self.assertEqual(fake.restarts, [("s1", "plan")])
        self.assertEqual(fake.states(), [("scheduled", "plan"), ("applying", "plan"), ("applied", "plan")])
        self.assertTrue(fake.events[-1]["resumed"])
        self.assertTrue(all(e["type"] == "permission_mode_apply" for e in fake.events))

    async def test_busy_session_waits_for_idle(self):
        fake = FakeSession()
        fake.status = "running"
        applier = make(fake)
        res = await applier.request("s1", "auto", "plan")
        self.assertEqual(res["state"], "pending")
        await asyncio.sleep(0.1)
        self.assertEqual(fake.restarts, [], "must not cut off a running answer")
        self.assertEqual(applier.pending("s1")["state"], "pending")
        fake.status = "idle"
        await settle(applier, "s1")
        self.assertEqual(fake.restarts, [("s1", "plan")])
        self.assertEqual(fake.states()[-1], ("applied", "plan"))

    async def test_waiting_for_approval_counts_as_busy(self):
        fake = FakeSession()
        fake.status = "waiting"
        applier = make(fake)
        self.assertEqual((await applier.request("s1", "auto", "plan"))["state"], "pending")
        await asyncio.sleep(0.05)
        self.assertEqual(fake.restarts, [])
        applier.cancel("s1")

    async def test_rapid_changes_coalesce_into_one_restart(self):
        fake = FakeSession()
        applier = make(fake, debounce=0.05)
        await applier.request("s1", "auto", "acceptEdits")
        await applier.request("s1", "acceptEdits", "dontAsk")
        await applier.request("s1", "dontAsk", "plan")
        await settle(applier, "s1")
        self.assertEqual(fake.restarts, [("s1", "plan")])

    async def test_switching_back_to_running_mode_cancels(self):
        fake = FakeSession()
        fake.status = "running"
        applier = make(fake)
        await applier.request("s1", "auto", "plan")
        res = await applier.request("s1", "plan", "auto")
        self.assertEqual(res["state"], "unchanged")
        self.assertIsNone(applier.pending("s1"))
        fake.status = "idle"
        await asyncio.sleep(0.05)
        self.assertEqual(fake.restarts, [])
        self.assertEqual(fake.states()[-1], ("cancelled", "auto"))

    async def test_stopped_session_only_saves(self):
        fake = FakeSession()
        fake.alive = False
        applier = make(fake)
        res = await applier.request("s1", "auto", "plan")
        self.assertEqual(res["state"], "saved")
        self.assertEqual(fake.restarts, [])
        self.assertEqual(fake.events, [])

    async def test_session_stopping_while_waiting_drops_pending(self):
        fake = FakeSession()
        fake.status = "running"
        applier = make(fake)
        await applier.request("s1", "auto", "plan")
        fake.alive = False
        await settle(applier, "s1")
        self.assertEqual(fake.restarts, [])
        self.assertEqual(fake.states()[-1], ("saved", "plan"))

    async def test_apply_now_interrupts_busy_session(self):
        fake = FakeSession()
        fake.status = "running"
        applier = make(fake)
        await applier.request("s1", "auto", "bypassPermissions")
        res = await applier.apply_now("s1")
        self.assertEqual(res["state"], "applied")
        self.assertEqual(fake.restarts, [("s1", "bypassPermissions")])
        self.assertIsNone(applier.pending("s1"))
        self.assertEqual((await applier.apply_now("s1"))["state"], "none")

    async def test_restart_failure_is_reported(self):
        fake = FakeSession()
        fake.restart_result = {"ok": False, "error": "replacement PTY did not start"}
        applier = make(fake)
        await applier.request("s1", "auto", "plan")
        await settle(applier, "s1")
        last = fake.events[-1]
        self.assertEqual(last["state"], "failed")
        self.assertIn("did not start", last["error"])
        self.assertIsNone(applier.pending("s1"))

    async def test_change_during_restart_applies_again_afterwards(self):
        fake = FakeSession()
        fake.restart_gate = asyncio.Event()
        applier = make(fake)
        await applier.request("s1", "auto", "plan")
        for _ in range(100):
            if fake.restarts:
                break
            await asyncio.sleep(0.01)
        self.assertEqual(applier.pending("s1")["state"], "applying")
        res = await applier.request("s1", "plan", "acceptEdits")
        self.assertEqual(res["state"], "pending")
        fake.restart_gate.set()
        await settle(applier, "s1")
        self.assertEqual(fake.restarts, [("s1", "plan"), ("s1", "acceptEdits")])
        self.assertEqual(fake.states()[-1], ("applied", "acceptEdits"))

    async def test_switching_back_after_inflight_restart_restores_mode(self):
        fake = FakeSession()
        fake.restart_gate = asyncio.Event()
        applier = make(fake)
        await applier.request("s1", "auto", "plan")
        for _ in range(100):
            if fake.restarts:
                break
            await asyncio.sleep(0.01)
        await applier.request("s1", "plan", "auto")
        fake.restart_gate.set()
        await settle(applier, "s1")
        # The process was already restarted into plan; going back needs one more.
        self.assertEqual(fake.restarts, [("s1", "plan"), ("s1", "auto")])

    async def test_change_while_restart_has_pty_down_wins_afterwards(self):
        fake = FakeSession()
        fake.restart_gate = asyncio.Event()
        applier = make(fake)
        await applier.request("s1", "auto", "plan")
        for _ in range(100):
            if fake.restarts:
                break
            await asyncio.sleep(0.01)
        fake.alive = False  # old PTY stopped, replacement not started yet
        res = await applier.request("s1", "plan", "acceptEdits")
        self.assertEqual(res["state"], "pending")
        fake.alive = True
        fake.restart_gate.set()
        await settle(applier, "s1")
        self.assertEqual(fake.restarts, [("s1", "plan"), ("s1", "acceptEdits")])
        self.assertEqual(fake.states()[-1], ("applied", "acceptEdits"))


class LaunchFieldFake(FakeSession):
    async def restart(self, sid, targets):
        self.restarts.append((sid, dict(targets)))
        if self.restart_gate is not None:
            await self.restart_gate.wait()
        return dict(self.restart_result)

    def field_states(self):
        return [(e["type"], e.get("field"), e["state"], e.get("value")) for e in self.events]


def make_launch(fake, **kw):
    return LiveLaunchApplier(
        restart=fake.restart,
        is_alive=lambda sid: fake.alive,
        status=lambda sid: fake.status,
        broadcast=fake.broadcast,
        debounce=kw.get("debounce", 0.01),
        poll_interval=0.01,
    )


class LiveLaunchApplierTests(unittest.IsolatedAsyncioTestCase):
    async def test_model_change_restarts_with_model_and_uses_launch_event(self):
        fake = LaunchFieldFake()
        applier = make_launch(fake)
        res = await applier.request_field("s1", "model", "opus", "sonnet")
        self.assertEqual(res["state"], "scheduled")
        await settle(applier, "s1")
        self.assertEqual(fake.restarts, [("s1", {"model": "sonnet"})])
        self.assertEqual([e["type"] for e in fake.events], ["launch_apply"] * 3)
        self.assertEqual([e["state"] for e in fake.events], ["scheduled", "applying", "applied"])
        self.assertTrue(all(e["field"] == "model" and e["value"] == "sonnet" for e in fake.events))

    async def test_model_effort_and_perms_share_one_restart(self):
        fake = LaunchFieldFake()
        applier = make_launch(fake, debounce=0.05)
        await applier.request_field("s1", "model", "opus", "sonnet")
        await applier.request_field("s1", "effort", "", "max")
        await applier.request_field("s1", "permission_mode", "default", "plan")
        await settle(applier, "s1")
        self.assertEqual(fake.restarts, [("s1", {"model": "sonnet", "effort": "max", "permission_mode": "plan"})])
        applied = {(e["type"], e["field"]) for e in fake.events if e["state"] == "applied"}
        self.assertEqual(applied, {("launch_apply", "model"), ("launch_apply", "effort"), ("permission_mode_apply", "permission_mode")})

    async def test_busy_waits_and_apply_now_applies_every_field(self):
        fake = LaunchFieldFake()
        fake.status = "running"
        applier = make_launch(fake)
        await applier.request_fields("s1", {"model": ("opus", "sonnet"), "effort": ("high", "low")})
        await asyncio.sleep(0.05)
        self.assertEqual(fake.restarts, [])
        self.assertEqual(applier.pending("s1", "effort")["state"], "pending")
        self.assertEqual(set(applier.pending("s1")), {"model", "effort"})
        res = await applier.apply_now("s1")
        self.assertEqual(res["state"], "applied")
        self.assertEqual(res["fields"], {"model": "sonnet", "effort": "low"})
        self.assertEqual(fake.restarts, [("s1", {"model": "sonnet", "effort": "low"})])

    async def test_reverting_one_field_keeps_the_other(self):
        fake = LaunchFieldFake()
        fake.status = "running"
        applier = make_launch(fake)
        await applier.request_fields("s1", {"model": ("opus", "sonnet"), "effort": ("", "max")})
        res = await applier.request_field("s1", "effort", "max", "")
        self.assertEqual(res["state"], "unchanged")
        self.assertIsNone(applier.pending("s1", "effort"))
        self.assertIsNotNone(applier.pending("s1", "model"))
        fake.status = "idle"
        await settle(applier, "s1")
        self.assertEqual(fake.restarts, [("s1", {"model": "sonnet"})])
        self.assertIn(("launch_apply", "effort", "cancelled", ""), fake.field_states())

    async def test_reverting_all_fields_cancels_restart(self):
        fake = LaunchFieldFake()
        fake.status = "running"
        applier = make_launch(fake)
        await applier.request_field("s1", "model", "opus", "sonnet")
        await applier.request_field("s1", "model", "sonnet", "opus")
        self.assertIsNone(applier.pending("s1"))
        fake.status = "idle"
        await asyncio.sleep(0.05)
        self.assertEqual(fake.restarts, [])

    async def test_none_and_empty_effort_are_the_same_value(self):
        fake = LaunchFieldFake()
        applier = make_launch(fake)
        res = await applier.request_field("s1", "effort", None, "")
        self.assertEqual(res["state"], "unchanged")
        self.assertEqual(fake.restarts, [])

    async def test_other_field_during_restart_is_applied_afterwards(self):
        fake = LaunchFieldFake()
        fake.restart_gate = asyncio.Event()
        applier = make_launch(fake)
        await applier.request_field("s1", "model", "opus", "sonnet")
        for _ in range(100):
            if fake.restarts:
                break
            await asyncio.sleep(0.01)
        self.assertEqual(applier.pending("s1", "model")["state"], "applying")
        res = await applier.request_field("s1", "effort", "", "low")
        self.assertEqual(res["state"], "pending")
        fake.restart_gate.set()
        await settle(applier, "s1")
        self.assertEqual(fake.restarts, [("s1", {"model": "sonnet"}), ("s1", {"effort": "low"})])

    async def test_failure_reports_each_field(self):
        fake = LaunchFieldFake()
        fake.restart_result = {"ok": False, "error": "replacement PTY did not start"}
        applier = make_launch(fake)
        await applier.request_fields("s1", {"model": ("opus", "sonnet"), "effort": ("", "max")})
        await settle(applier, "s1")
        failed = {e["field"] for e in fake.events if e["state"] == "failed"}
        self.assertEqual(failed, {"model", "effort"})

    async def test_unknown_field_rejected(self):
        applier = make_launch(LaunchFieldFake())
        with self.assertRaises(ValueError):
            await applier.request_field("s1", "system_prompt", "a", "b")


def server_functions(*names, **dependencies):
    tree = ast.parse(Path(__file__).with_name("server.py").read_text())
    subset = ast.Module(body=[n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names], type_ignores=[])
    namespace = dict(web=web, json=json, asyncio=asyncio, logger=logging.getLogger("test"), **dependencies)
    exec(compile(subset, "server.py", "exec"), namespace)
    return SimpleNamespace(**{name: namespace[name] for name in names})


class UpdateSessionLiveApplyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for target, value in [("DATA_DIR", Path(self.tmp.name)), ("DB_PATH", Path(self.tmp.name) / "test.db")]:
            p = patch.object(database, target, value); p.start(); self.addCleanup(p.stop)
        await database.init_db()
        db = await database.get_db()
        try:
            await db.execute("INSERT INTO workspaces(id,name,path) VALUES('ws','Test',?)", (self.tmp.name,))
            await db.execute("INSERT INTO sessions(id, workspace_id, name, cli_type, permission_mode) VALUES('s1','ws','S','claude','auto')")
            await db.execute("INSERT INTO sessions(id, workspace_id, name, cli_type, permission_mode) VALUES('c1','ws','C','codex','auto')")
            await db.commit()
        finally:
            await db.close()
        async def _request_fields(sid, changes):
            return {f: {"session_id": sid, "field": f, "state": "scheduled", "value": t, "mode": t if f == "permission_mode" else None} for f, (_r, t) in changes.items()}
        self.applier = SimpleNamespace(request_fields=AsyncMock(side_effect=_request_fields))
        self.fns = server_functions(
            "update_session", "_cli_supports_live_permission_mode", "_cli_supports_live_launch_field",
            "_model_for_storage", "_profile_default_model_for_role",
            get_db=database.get_db,
            bus=SimpleNamespace(emit=AsyncMock()),
            broadcast=AsyncMock(),
            CommanderEvent=CommanderEvent,
            _session_visible_to_request=lambda row, req: True,
            _quick_start=SimpleNamespace(is_quick_workspace_cached=lambda _ws: False),
            get_profile=get_profile,
            Feature=Feature,
            _LIVE_LAUNCH_FEATURES={"permission_mode": "PERMISSION_MODE", "model": "MODEL", "effort": "EFFORT"},
            _get_permission_live_applier=lambda: self.applier,
        )

    def req(self, sid, body, agent=False):
        headers = {"X-IVE-Session-Type": "worker"} if agent else {}
        return SimpleNamespace(match_info={"id": sid}, json=AsyncMock(return_value=body), headers=headers, get=lambda key, default=None: None)

    async def mode(self, sid):
        db = await database.get_db()
        try:
            return (await (await db.execute("SELECT permission_mode FROM sessions WHERE id=?", (sid,))).fetchone())[0]
        finally:
            await db.close()

    async def test_apply_live_hands_change_to_applier(self):
        resp = await self.fns.update_session(self.req("s1", {"permission_mode": "plan", "apply_live": True}))
        self.assertEqual(resp.status, 200)
        body = json.loads(resp.text)
        self.assertEqual(body["permission_apply"]["state"], "scheduled")
        self.assertEqual(await self.mode("s1"), "plan")
        self.applier.request_fields.assert_awaited_once_with("s1", {"permission_mode": ("auto", "plan")})

    async def test_codex_profile_is_supported(self):
        await self.fns.update_session(self.req("c1", {"permission_mode": "dontAsk", "apply_live": True}))
        self.applier.request_fields.assert_awaited_once_with("c1", {"permission_mode": ("auto", "dontAsk")})

    async def test_without_flag_only_saves(self):
        resp = await self.fns.update_session(self.req("s1", {"permission_mode": "plan"}))
        self.assertNotIn("permission_apply", json.loads(resp.text))
        self.applier.request_fields.assert_not_awaited()

    async def test_agent_cannot_widen_and_never_restarts(self):
        resp = await self.fns.update_session(self.req("s1", {"permission_mode": "bypassPermissions", "apply_live": True}, agent=True))
        self.assertEqual(resp.status, 403)
        self.assertEqual(await self.mode("s1"), "auto")
        self.applier.request_fields.assert_not_awaited()

    async def test_agent_narrowing_saves_without_restart(self):
        resp = await self.fns.update_session(self.req("s1", {"permission_mode": "plan", "apply_live": True}, agent=True))
        self.assertEqual(resp.status, 200)
        self.assertEqual(await self.mode("s1"), "plan")
        self.applier.request_fields.assert_not_awaited()

    async def col(self, sid, name):
        db = await database.get_db()
        try:
            return (await (await db.execute(f"SELECT {name} FROM sessions WHERE id=?", (sid,))).fetchone())[0]
        finally:
            await db.close()

    async def test_model_and_effort_apply_live_in_one_call(self):
        await self.fns.update_session(self.req("s1", {"model": "opus"}))
        resp = await self.fns.update_session(self.req("s1", {"model": "sonnet", "effort": "max", "apply_live": True}))
        self.assertEqual(resp.status, 200)
        body = json.loads(resp.text)
        self.assertEqual(set(body["launch_apply"]), {"model", "effort"})
        self.assertNotIn("permission_apply", body)
        self.applier.request_fields.assert_awaited_once_with("s1", {"model": ("opus", "sonnet"), "effort": ("high", "max")})
        self.assertEqual(await self.col("s1", "effort"), "max")

    async def test_effort_is_validated_and_normalized(self):
        resp = await self.fns.update_session(self.req("s1", {"effort": "turbo", "apply_live": True}))
        self.assertEqual(resp.status, 400)
        self.applier.request_fields.assert_not_awaited()
        await self.fns.update_session(self.req("s1", {"effort": "XHigh"}))
        self.assertEqual(await self.col("s1", "effort"), "xhigh")

    async def test_codex_effort_is_unsupported_but_model_is_live(self):
        resp = await self.fns.update_session(self.req("c1", {"model": "gpt-x", "effort": "high", "apply_live": True}))
        body = json.loads(resp.text)
        self.assertEqual(body["launch_apply"]["effort"]["state"], "unsupported")
        args = self.applier.request_fields.await_args.args
        self.assertEqual(list(args[1]), ["model"])

    async def test_agent_model_change_never_restarts(self):
        resp = await self.fns.update_session(self.req("s1", {"model": "sonnet", "apply_live": True}, agent=True))
        self.assertEqual(resp.status, 200)
        self.applier.request_fields.assert_not_awaited()

    async def test_model_without_flag_only_saves(self):
        resp = await self.fns.update_session(self.req("s1", {"model": "sonnet"}))
        self.assertNotIn("launch_apply", json.loads(resp.text))
        self.applier.request_fields.assert_not_awaited()

    def test_profiles_map_model_and_effort_to_flags(self):
        from cli_session import UnifiedSession
        argv = UnifiedSession("claude", {"model": "sonnet", "effort": "max", "resume_id": "abc"}).build_command()
        self.assertEqual(argv[argv.index("--model") + 1], "sonnet")
        self.assertEqual(argv[argv.index("--effort") + 1], "max")

    def test_profiles_map_modes_to_flags_and_resume(self):
        from cli_session import UnifiedSession
        claude = UnifiedSession("claude", {"permission_mode": "plan", "resume_id": "abc"}).build_command()
        self.assertIn("--permission-mode", claude)
        self.assertEqual(claude[claude.index("--permission-mode") + 1], "plan")
        self.assertEqual(claude[claude.index("--resume") + 1], "abc")
        codex = UnifiedSession("codex", {"permission_mode": "dontAsk", "resume_id": "xyz"}).build_command()
        self.assertEqual(codex[codex.index("--ask-for-approval") + 1], "never")
        self.assertEqual(codex[codex.index("resume") + 1], "xyz")


class SharedPermissionModeTests(unittest.IsolatedAsyncioTestCase):
    async def test_hooks_keep_running_mode_until_change_applied(self):
        from permission_mode_live import set_permission_mode_resolver, effective_permission_mode
        fake = FakeSession()
        fake.status = "waiting"
        applier = make(fake)
        set_permission_mode_resolver(lambda sid: applier.snapshot(sid, "permission_mode"))
        try:
            await applier.request("s1", "default", "auto")
            self.assertEqual(effective_permission_mode("s1", "auto"), "default")
            self.assertEqual(effective_permission_mode("s1", "plan"), "plan")
            await applier.apply_now("s1")
            self.assertEqual(effective_permission_mode("s1", "auto"), "auto")
        finally:
            set_permission_mode_resolver(lambda sid: None)
            applier.cancel("s1")

    async def test_safety_gate_never_silently_widens_selected_mode(self):
        fns = server_functions("_apply_worker_safety_gate_permission")
        for cli in ("claude", "codex"):
            for mode in ("auto", "default", "plan", "bypassPermissions"):
                config = {"cli_type": cli, "session_type": "worker", "permission_mode": mode}
                actual = await fns._apply_worker_safety_gate_permission(config, "s1", {}, auto_start=True)
                self.assertEqual(actual, mode)
                self.assertEqual(config["permission_mode"], mode)


class RuntimeModelTimestampTests(unittest.TestCase):
    def test_timestamp_is_returned_as_epoch(self):
        from runtime_model import read_runtime_model
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "t.jsonl"
            path.write_text(json.dumps({"type": "assistant", "timestamp": "2026-10-10T10:00:00.000Z", "message": {"model": "claude-opus-5-5"}}) + "\n")
            found = read_runtime_model(path)
        self.assertEqual(found["model"], "claude-opus-5-5")
        self.assertAlmostEqual(found["at"], 1791626400.0)


if __name__ == "__main__":
    unittest.main()
