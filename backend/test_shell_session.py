"""Plain terminal sessions (cli_type "shell").

Isolated: temp SQLite + temp home, real PTYs running /usr/bin/env or the
real login shell with a temp HOME. Never starts the server or an agent CLI.
"""
import asyncio
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import cli_profiles
import session_supervisor
import shell_session
from cli_features import Feature
from pty_manager import PTYManager, prepare_terminal_env
import test_quick_start as tqs
from test_quick_start import FakeRequest, payload, server_objects


class ShellProfileTests(unittest.TestCase):
    def test_profile_resolves_but_is_not_an_agent_cli(self):
        profile = cli_profiles.get_profile("shell")
        self.assertEqual((profile.id, profile.label), ("shell", "Terminal"))
        # Not registered: hook installation, MCP sync, model providers and
        # CLI availability only ever loop over PROFILES / all_profiles().
        self.assertNotIn("shell", cli_profiles.PROFILES)
        self.assertNotIn(profile, cli_profiles.all_profiles())
        self.assertNotIn(profile, cli_profiles.active_profiles())
        self.assertFalse(cli_profiles.is_active_cli("shell"))

    def test_profile_has_no_hooks_mcp_transcript_or_pickers(self):
        profile = cli_profiles.get_profile("shell")
        self.assertEqual(profile.hook_event_map, {})
        self.assertEqual(profile.default_hook_events, [])
        self.assertEqual(profile.hook_config_format, "")
        self.assertEqual(profile.mcp_strategy, "")
        self.assertEqual(profile.session_file_pattern, "")
        self.assertEqual(profile.home_dir, "")
        self.assertEqual(profile.settings_file, "")
        self.assertEqual((profile.available_models, profile.available_permission_modes, profile.effort_levels), ([], [], []))
        for feature in Feature:
            self.assertFalse(profile.supports(feature), feature)
        self.assertTrue(profile.ui_capabilities["plain_shell"])
        self.assertFalse(profile.ui_capabilities["chat_view"])

    def test_hook_installer_never_sees_the_shell(self):
        import hook_installer
        self.assertNotIn("shell", {p.id for p in hook_installer.PROFILES.values()})

    def test_unknown_profile_still_fails(self):
        with self.assertRaises(cli_profiles.UnknownCLIProfileError):
            cli_profiles.get_profile("bash")


class LoginShellTests(unittest.TestCase):
    def setUp(self):
        shell_session._directory_service_shell.cache_clear()

    def test_shell_from_env(self):
        self.assertEqual(shell_session.resolve_login_shell({"SHELL": "/bin/sh"}), "/bin/sh")

    def test_relative_or_missing_shell_falls_back(self):
        with patch.object(shell_session, "_directory_service_shell", return_value=None):
            self.assertEqual(shell_session.resolve_login_shell({"SHELL": "zsh", "USER": "x"}), "/bin/zsh")
            self.assertEqual(shell_session.resolve_login_shell({"SHELL": "/nope/zsh", "USER": "x"}), "/bin/zsh")

    def test_directory_service_shell_is_used_without_env(self):
        with patch.object(shell_session, "_directory_service_shell", return_value="/bin/bash"):
            self.assertEqual(shell_session.resolve_login_shell({"USER": "x"}), "/bin/bash")

    def test_login_interactive_argv(self):
        self.assertEqual(shell_session.shell_command("/bin/zsh"), ["/bin/zsh", "-l", "-i"])


class ShellEnvTests(unittest.TestCase):
    PARENT = {
        "HOME": "/Users/u", "USER": "u", "PATH": "/usr/bin:/bin", "SHELL": "/bin/zsh",
        "CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "cli", "CLAUDE_CODE_SESSION_ID": "abc",
        "CLAUDE_CODE_CHILD_SESSION": "1", "COMMANDER_SESSION_ID": "s1", "WORKER_SESSION_ID": "s1",
        "IVE_DATA_DIR": "/x", "FORCE_COLOR": "1", "CLICOLOR_FORCE": "1", "COLUMNS": "120",
        "LINES": "40", "SHLVL": "3", "TERM_PROGRAM": "iTerm.app", "TERM": "dumb",
        "ANTHROPIC_API_KEY": "user-key",
    }

    def test_agent_and_ive_identity_never_leaks(self):
        env = shell_session.shell_env(self.PARENT, {}, "/tmp/project")
        for key in env:
            self.assertFalse(key == "CLAUDECODE" or key.startswith(("CLAUDE_CODE_", "COMMANDER_", "WORKER_", "IVE_")), key)
        for key in ("FORCE_COLOR", "CLICOLOR_FORCE", "COLUMNS", "LINES", "SHLVL", "TERM_PROGRAM"):
            self.assertNotIn(key, env)
        self.assertEqual(env["TERM"], "xterm-256color")
        self.assertEqual(env["COLORTERM"], "truecolor")
        self.assertEqual(env["PWD"], "/tmp/project")
        # The user's own environment stays: home, path, shell, their keys.
        for key in ("HOME", "USER", "PATH", "SHELL", "ANTHROPIC_API_KEY"):
            self.assertEqual(env[key], self.PARENT[key])

    def test_lang_kept_or_set(self):
        self.assertEqual(shell_session.shell_env({"LANG": "de_DE.UTF-8"})["LANG"], "de_DE.UTF-8")
        with patch.object(shell_session, "_system_lang", return_value="de_DE.UTF-8"):
            self.assertEqual(shell_session.shell_env({})["LANG"], "de_DE.UTF-8")
        self.assertRegex(shell_session.shell_env({})["LANG"], r"\.UTF-8$")

    def test_prepare_terminal_env_plain_shell_mode(self):
        env = prepare_terminal_env(dict(self.PARENT), {"CLAUDE_CODE_X": "1"}, "/bin/zsh",
                                   plain_shell=True, cwd="/tmp")
        self.assertNotIn("CLAUDECODE", env)
        self.assertNotIn("CLAUDE_CODE_X", env)
        self.assertNotIn("CLAUDE_CODE_FORCE_SESSION_PERSISTENCE", env)
        # Agent terminals are unchanged.
        agent = prepare_terminal_env(dict(self.PARENT), {}, "/bin/claude")
        self.assertEqual(agent["CLAUDE_CODE_FORCE_SESSION_PERSISTENCE"], "1")
        self.assertEqual(agent["FORCE_COLOR"], "1")


class ShellPtyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.mgr = PTYManager()
        self.addAsyncCleanup(self.mgr.stop_all)
        self.output = bytearray()
        self.exits = []

        async def on_output(_sid, data):
            self.output.extend(data)

        async def on_exit(sid, code):
            self.exits.append((sid, code))

        self.mgr.on_output(on_output)
        self.mgr.on_exit(on_exit)

    async def wait_for(self, predicate, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            await asyncio.sleep(0.05)
        return False

    async def test_real_pty_env_is_clean(self):
        leaky = {"CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "parent", "COMMANDER_PORT": "5111",
                 "FORCE_COLOR": "1", "COLUMNS": "120"}
        with patch.dict(os.environ, leaky):
            await self.mgr.start_session("sh", self.tmp.name, cmd_binary="/usr/bin/env",
                                         cmd_args=[], plain_shell=True)
            self.assertTrue(await self.wait_for(lambda: self.exits))
        text = self.output.decode("utf-8", "replace")
        self.assertIn("TERM=xterm-256color", text)
        self.assertIn("LANG=", text)
        for leak in ("CLAUDECODE=", "CLAUDE_CODE_SESSION_ID=", "COMMANDER_PORT=", "FORCE_COLOR=", "COLUMNS="):
            self.assertNotIn(leak, text)

    async def test_login_shell_in_folder_with_isolated_home(self):
        home = Path(self.tmp.name, "home")
        project = Path(self.tmp.name, "project")
        home.mkdir()
        project.mkdir()
        # A real ~/.zshrc must never be read: HOME points at the temp dir.
        (home / ".zshrc").write_text("echo ZSHRC_FROM_TEMP_HOME\n")
        (home / ".bashrc").write_text("echo ZSHRC_FROM_TEMP_HOME\n")
        cmd = shell_session.shell_command("/bin/zsh" if os.path.exists("/bin/zsh") else "/bin/sh")
        with patch.dict(os.environ, {"HOME": str(home), "ZDOTDIR": str(home)}):
            await self.mgr.start_session("sh", str(project), cmd_binary=cmd[0],
                                         cmd_args=cmd[1:], plain_shell=True)
            self.mgr.write("sh", b"echo hello-$((40+2)); pwd\r")
            self.assertTrue(await self.wait_for(lambda: b"hello-42" in self.output), self.output[-400:])
            self.mgr.write("sh", b"exit 3\r")
            self.assertTrue(await self.wait_for(lambda: self.exits))
        text = self.output.decode("utf-8", "replace")
        self.assertTrue(str(project) in text or os.path.realpath(project) in text, text[-400:])
        if cmd[0] == "/bin/zsh":
            self.assertIn("ZSHRC_FROM_TEMP_HOME", text)
        self.assertEqual(self.exits[-1], ("sh", 3))


class ShellExitTests(unittest.IsolatedAsyncioTestCase):
    async def test_nonzero_exit_is_clean_and_never_restarts(self):
        row = {"id": "s1", "cli_type": "shell", "session_type": "shell", "status": "running"}
        crash = AsyncMock()
        with patch.object(session_supervisor, "_load_session_row", AsyncMock(return_value=row)), \
             patch.object(session_supervisor, "_record_crash", crash):
            self.assertEqual(await session_supervisor.record_exit("s1", 1), "clean")
        crash.assert_not_awaited()

    async def test_agent_nonzero_exit_still_crashes(self):
        row = {"id": "s2", "cli_type": "claude", "session_type": "worker", "status": "running"}
        with patch.object(session_supervisor, "_load_session_row", AsyncMock(return_value=row)), \
             patch.object(session_supervisor, "_record_crash", AsyncMock()), \
             patch.object(session_supervisor, "_auto_restart_enabled", AsyncMock(return_value=False)):
            self.assertEqual(await session_supervisor.record_exit("s2", 1), "crashed")


class ShellCreateTests(unittest.IsolatedAsyncioTestCase):
    """Reuses the quick-start harness (temp DB) for POST /api/sessions."""

    async def asyncSetUp(self):
        await tqs.QuickStartTests.asyncSetUp(self)

    async def visible_session(self, session_id, request):
        return await tqs.QuickStartTests.visible_session(self, session_id, request)

    def build_server(self):
        server = tqs.QuickStartTests.build_server(self)
        self.autostart = AsyncMock(return_value={"ok": True})
        extra = server_objects(
            "create_session", "_create_shell_session", "_workspace_visible_to_auth", "create_quick_session",
            "_QuickJsonRequest",
            get_db=__import__("db").get_db,
            get_auth=lambda request: request.get("auth"),
            _shell_session=shell_session,
            broadcast=self.broadcast,
            _autostart_session_pty=self.autostart,
            _quick_start=__import__("quick_start"),
            is_active_cli=lambda cli: (_ for _ in ()).throw(AssertionError("agent path used")),
        )
        server.create_shell = extra.create_session
        server.create_shell_row = extra._create_shell_session
        server.create_quick_shell = extra.create_quick_session
        return server

    async def workspace(self):
        await self.db.execute("INSERT INTO workspaces (id, name, path) VALUES ('w1', 'demo', ?)", (str(self.root),))
        await self.db.commit()
        return "w1"

    async def test_shell_session_row_has_no_agent_config(self):
        wid = await self.workspace()
        await self.db.execute(
            "INSERT INTO guidelines (id, name, content, is_default) VALUES ('g1','Default','Be nice',1)")
        await self.db.commit()
        res = await self.server.create_shell(FakeRequest({
            "workspace_id": wid, "cli_type": "shell", "name": " My shell ", "auto_start": True,
            "model": "opus", "permission_mode": "bypassPermissions", "guideline_ids": ["g1"],
        }))
        self.assertEqual(res.status, 201, res.text)
        row = payload(res)
        self.assertEqual((row["cli_type"], row["session_type"], row["name"]), ("shell", "shell", "My shell"))
        self.assertEqual((row["model"], row["permission_mode"], row["effort"], row["worktree"]), ("", "default", None, 0))
        mcp = await (await self.db.execute("SELECT * FROM session_mcp_servers WHERE session_id = ?", (row["id"],))).fetchall()
        guides = await (await self.db.execute("SELECT * FROM session_guidelines WHERE session_id = ?", (row["id"],))).fetchall()
        self.assertEqual((list(mcp), list(guides)), ([], []))
        self.autostart.assert_awaited_once_with(row["id"])

    async def test_quick_start_can_open_a_terminal(self):
        res = await self.server.create_quick_shell(FakeRequest({"cli_type": "shell", "name": "Terminal"}))
        self.assertEqual(res.status, 201, res.text)
        row = payload(res)
        self.assertEqual(row["cli_type"], "shell")
        self.assertTrue(row["quick"])

    async def test_restricted_mode_cannot_create_a_terminal(self):
        wid = await self.workspace()
        req = FakeRequest({"workspace_id": wid, "cli_type": "shell"})
        req["auth"] = SimpleNamespace(is_owner=False, actor_kind="joiner", actor_id="j", device_id=None,
                                      mode="code", workspace_id=None)
        res = await self.server.create_shell_row(req, {"cli_type": "shell"}, wid)
        self.assertEqual(res.status, 403)
        count = (await (await self.db.execute("SELECT COUNT(*) FROM sessions")).fetchone())[0]
        self.assertEqual(count, 0)


class ShellStartTests(unittest.IsolatedAsyncioTestCase):
    async def test_start_runs_login_shell_without_agent_assembly(self):
        pty = SimpleNamespace(start_session=AsyncMock(), is_alive=lambda sid: True)
        broadcast = AsyncMock()
        started = []
        cache = {}
        start_times = {}
        server = server_objects(
            "_start_shell_pty", "_autostart_session_pty",
            os=os, pty_mgr=pty, broadcast=broadcast, _shell_session=shell_session,
            capture_proc=SimpleNamespace(clear_buffer=lambda sid: None),
            _session_cli_type_cache=cache, _pty_start_time=start_times,
            mark_pty_started=lambda sid, mode: (started.append((sid, mode)), start_times.__setitem__(sid, 1)),
            _mark_session_pty_started=AsyncMock(),
            get_session_config=AsyncMock(return_value={
                "id": "s1", "cli_type": "shell", "session_type": "shell", "workspace_path": tempfile.gettempdir(),
            }),
            # Any agent assembly step is a failure for a plain terminal.
            _prepare_session_cli_env=AsyncMock(side_effect=AssertionError("hook/env assembly")),
            _apply_session_mcp=AsyncMock(side_effect=AssertionError("mcp")),
            _schedule_session_detection=lambda *a, **k: (_ for _ in ()).throw(AssertionError("detection")),
        )
        with patch.dict(os.environ, {"SHELL": "/bin/sh"}):
            outcome = await server._autostart_session_pty("s1", cols=100, rows=30)
        self.assertEqual(outcome, {"ok": True})
        args, kwargs = pty.start_session.await_args
        self.assertEqual(args[0], "s1")
        self.assertEqual(args[1], tempfile.gettempdir())
        self.assertEqual((args[2], args[3]), (100, 30))
        self.assertEqual((args[6], args[4], args[5]), ("/bin/sh", ["-l", "-i"], {}))
        self.assertTrue(kwargs["plain_shell"])
        self.assertEqual(kwargs["sandbox_type"], "none")
        self.assertEqual(cache["s1"], "shell")
        self.assertEqual(started, [("s1", "full")])
        self.assertNotIn("s1", start_times)  # no agent initial-render collapse
        broadcast.assert_awaited_with({"session_id": "s1", "type": "status", "status": "running", "pty_alive": True})


if __name__ == "__main__":
    unittest.main()
