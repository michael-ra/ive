"""Desktop tunnel + real phone auth on isolated HTTP/WS and temporary SQLite.

No cloudflared, provider process, browser, user database or real device is used.
The proxy is represented by its actual loopback peer and edge headers; server
middleware/phone handlers execute directly from AST to avoid server bootstrap.
"""
import ast
import asyncio
import json
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
import urllib.parse

import aiosqlite
from aiohttp import web, WSServerHandshakeError, WSMsgType
from aiohttp.test_utils import TestClient, TestServer
from multidict import CIMultiDict

import auth_context
from commander_events import CommanderEvent
import db as database
import devices
import joiner_sessions
import phone_access
from phone_setup import PhoneSetup
from phone_availability import PhoneAvailability
import push
from desktop_security import create_desktop_origin_guard, desktop_proxy_config
from fresh_database_schema import SCHEMA_STATEMENTS


TUNNEL = "https://test-ive.trycloudflare.com"
LOCAL = {"Host": "127.0.0.1:5112", "Origin": "http://127.0.0.1:5112"}
REMOTE = {"Host": "test-ive.trycloudflare.com", "Origin": TUNNEL,
          "Cf-Connecting-Ip": "203.0.113.42", "X-Forwarded-Proto": "https",
          "User-Agent": "Mozilla/5.0 (iPhone) IVE-iOS/1.0"}


class DesktopPhoneTransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = TemporaryDirectory(prefix="ive-desktop-phone-")
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.path = self.data / "test.sqlite"
        db = await self.get_db()
        try:
            for statement in SCHEMA_STATEMENTS:
                await db.execute(statement)
            await db.commit()
        finally:
            await db.close()
        for module, name, value in (
            (database, "DATA_DIR", self.data), (database, "get_db", self.get_db),
            (joiner_sessions, "get_db", self.get_db), (devices, "get_db", self.get_db),
            (push, "get_db", self.get_db),
            (phone_access, "codes", phone_access.PairingCodes()),
            (phone_access, "lock", phone_access.PhoneLock()),
        ):
            context = patch.object(module, name, value)
            context.start()
            self.addCleanup(context.stop)
        self.active_url = TUNNEL
        self.server = self.load_server()
        with patch.dict(os.environ, {"IVE_DESKTOP_INSTANCE": "fixture-only"}):
            guard = create_desktop_origin_guard(5112, get_tunnel_url=lambda: self.active_url)
        app = web.Application(middlewares=[guard, self.server["cors_middleware"], self.server["token_auth_middleware"]])
        app[self.server["_PHONE_SETUP"]] = PhoneSetup(self.data)
        app[self.server["_PHONE_AVAILABILITY"]] = PhoneAvailability(connected=lambda: True)
        handlers = {
            ("GET", "/pair"): "phone_connect_page_handler",
            ("GET", "/pair.js"): "phone_pair_js_handler",
            ("GET", "/api/whoami"): "whoami_handler",
            ("GET", "/api/phone/status"): "phone_status_handler",
            ("POST", "/api/phone/setup"): "phone_setup_handler",
            ("POST", "/api/phone/availability/{action}"): "phone_availability_handler",
            ("GET", "/api/mac-power"): "mac_power_handler",
            ("POST", "/api/mac-power/{action}"): "mac_power_handler",
            ("POST", "/api/phone/pair/start"): "phone_pair_start_handler",
            ("POST", "/api/phone/pair/complete"): "phone_pair_complete_handler",
            ("GET", "/api/phone/devices"): "phone_devices_handler",
            ("POST", "/api/phone/devices/{id}/revoke"): "phone_device_revoke_handler",
            ("POST", "/api/phone/pin"): "phone_pin_set_handler",
            ("POST", "/api/phone/unlock"): "phone_unlock_handler",
            ("POST", "/api/phone/lock"): "phone_lock_handler",
        }
        for (method, path), name in handlers.items():
            app.router.add_route(method, path, self.server[name])
        async def protected(request):
            return web.json_response({"actor": self.server["get_auth"](request).actor_kind})
        async def ws(request):
            socket = web.WebSocketResponse()
            socket._ive_actor_id = self.server["get_auth"](request).actor_id
            await socket.prepare(request)
            self.server["ws_clients"].add(socket)
            try:
                await socket.send_json({"actor": self.server["get_auth"](request).actor_kind})
                async for _ in socket:
                    pass
            finally:
                self.server["ws_clients"].discard(socket)
            return socket
        app.router.add_get("/", protected)
        app.router.add_get("/assets/app.js", protected)
        app.router.add_get("/api/sessions", protected)
        app.router.add_get("/ws", ws)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def get_db(self):
        db = await aiosqlite.connect(self.path)
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA foreign_keys=ON")
        return db

    def load_server(self):
        names = {
            "cors_middleware", "_origin_allowed", "_proxy_trust_config", "_exempt_path", "token_auth_middleware",
            "_make_cookie_params", "get_auth", "_is_local_owner", "_local_owner_only", "_phone_lock_response",
            "_close_sockets_for_sessions", "_revoke_phone_device", "_phone_reachable_urls", "_phone_bind_info",
            "phone_status_handler", "phone_pair_start_handler", "phone_pair_complete_handler", "phone_devices_handler",
            "phone_setup_handler", "phone_availability_handler",
            "mac_power_handler",
            "phone_device_revoke_handler", "phone_pin_set_handler", "phone_unlock_handler", "phone_lock_handler",
            "_connect_page", "phone_connect_page_handler", "phone_pair_js_handler", "whoami_handler",
        }
        constants = {"_CONNECT_HTML", "_PAIR_JS", "_PHONE_LOCK_EXEMPT", "_PHONE_SENSITIVE_PREFIXES", "_PHONE_SETUP", "_PHONE_AVAILABILITY"}
        tree = ast.parse(Path(__file__).with_name("server.py").read_text())
        nodes = [node for node in tree.body if (
            isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names
        ) or (isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in constants for t in node.targets))]
        namespace = dict(
            __name__="phone_transport_fixture",
            web=web, json=json, os=os, urllib=urllib, asyncio=asyncio,
            PhoneSetup=PhoneSetup, PhoneAvailability=PhoneAvailability,
            _auth_context=auth_context, _phone_access=phone_access,
            _joiner_sessions=joiner_sessions, get_db=self.get_db,
            _DEFAULT_COOKIE_MAX_AGE=86400, AUTH_TOKEN="fixture-master-token",
            _TUNNEL_MODE=True, _EXTERNAL_PROXY_MODE=False, _PUBLIC_URL=None,
            _runtime_tunnel_url=TUNNEL, _tunnel_proc=SimpleNamespace(returncode=None),
            _BIND_HOST="127.0.0.1", _BIND_PORT=5112, PORT=5112,
            _PROXY_TRUST_BASE=auth_context.ProxyTrustConfig.from_values(
                trusted_proxy_peers=["127.0.0.1/32"], forwarded_headers=["Cf-Connecting-Ip", "X-Forwarded-Proto"],
            ),
            _LOOPBACK_ORIGIN_HOSTS={"localhost", "127.0.0.1", "::1", "[::1]"},
            _SHELL_ORIGINS={"tauri://localhost"},
            _is_rate_limited=lambda _: False, _record_auth_failure=lambda _: None,
            _is_token_link=lambda _: False, _find_cloudflared=lambda: "/synthetic/cloudflared",
            _apns_configured=lambda: False, ws_clients=set(),
            bus=SimpleNamespace(emit=AsyncMock()), broadcast=AsyncMock(),
            CommanderEvent=CommanderEvent, logger=Mock(),
        )
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "server.py", "exec"), namespace)
        # Push status is read-only, but point the imported helper at the fixture
        # rather than any actual provider configuration on the computer.
        context = patch.object(push, "get_public_key", lambda: None)
        context.start()
        self.addCleanup(context.stop)
        return namespace

    async def pair(self):
        response = await self.client.post("/api/phone/pair/start", headers=LOCAL)
        self.assertEqual(response.status, 200, await response.text())
        code = (await response.json())["code"]
        response = await self.client.post("/api/phone/pair/complete", headers=REMOTE, json={"code": code})
        self.assertEqual(response.status, 200, await response.text())
        cookie = response.cookies["ive_session"].value
        self.assertTrue(response.cookies["ive_session"]["secure"])
        self.assertTrue(response.cookies["ive_session"]["httponly"])
        self.assertEqual(response.cookies["ive_session"]["samesite"], "Strict")
        self.client.session.cookie_jar.clear()
        return {**REMOTE, "Cookie": f"ive_session={cookie}"}, (await response.json())["device"]["id"], code

    async def test_mac_stays_local_owner_and_can_manage_pairing_after_tunnel_start(self):
        response = await self.client.get("/api/phone/status", headers=LOCAL)
        body = await response.json()
        self.assertEqual(response.status, 200)
        self.assertEqual(body["actor_kind"], "localhost")
        self.assertTrue(body["is_local_owner"])
        self.assertFalse(body["bind"]["lan"])
        self.assertEqual(body["urls"][0]["url"], TUNNEL)
        self.assertEqual((await self.client.post("/api/phone/pair/start", headers=LOCAL)).status, 200)

    async def test_new_desktop_pairing_requires_explicit_local_consent(self):
        choices = dict(consent_version=1, remote_control=True, closed_lid=False, allow_battery=False)
        with patch.dict(os.environ, {"IVE_DESKTOP_INSTANCE": "fixture-only"}):
            self.assertEqual((await self.client.post("/api/phone/pair/start", headers=LOCAL)).status, 409)
            self.assertEqual((await self.client.post("/api/phone/setup", headers=LOCAL, json={**choices, "remote_control": False})).status, 400)
            self.assertEqual((await self.client.post("/api/phone/setup", headers=LOCAL, json=choices)).status, 200)
            self.assertEqual((await self.client.post("/api/phone/pair/start", headers=LOCAL)).status, 200)

    async def test_paired_phone_cannot_grant_os_consent_or_start_privileged_helper(self):
        headers, _, _ = await self.pair()
        choices = dict(consent_version=1, remote_control=True, closed_lid=True, allow_battery=True)
        for path in ("/api/phone/setup", "/api/phone/availability/start", "/api/phone/availability/approval", "/api/phone/availability/stop",
                     "/api/mac-power/start", "/api/mac-power/stop", "/api/mac-power/approval"):
            response = await self.client.post(path, headers=headers, json=choices)
            self.assertEqual(response.status, 403, await response.text())
        body = await (await self.client.get("/api/phone/status", headers=headers)).json()
        self.assertNotIn("lease_id", json.dumps(body))

    async def test_restricting_battery_consent_stops_lease_without_another_browser_request(self):
        setup = self.client.server.app[self.server["_PHONE_SETUP"]]
        choices = dict(consent_version=1, remote_control=True, closed_lid=True, allow_battery=True)
        setup.accept(choices)
        controller = self.client.server.app[self.server["_PHONE_AVAILABILITY"]]
        controller.lease = 'fixture-private-lease'
        controller.caller = AsyncMock(return_value={"ok": True, "status": "ready"})
        response = await self.client.post('/api/phone/setup', headers=LOCAL, json={**choices, "allow_battery": False})
        self.assertEqual(response.status, 200)
        controller.caller.assert_awaited_once()
        self.assertEqual(controller.caller.await_args.args[0]['action'], 'stop')
        self.assertIsNone(controller.lease)
        self.assertFalse(setup.read()['allow_battery'])

    async def test_unpaired_phone_only_gets_login_assets_never_localhost_privileges(self):
        navigation = {key: value for key, value in REMOTE.items() if key != "Origin"}
        for path in ("/pair", "/pair.js"):
            self.assertEqual((await self.client.get(path, headers=navigation)).status, 200)
        for path in ("/api/sessions", "/api/whoami", "/assets/app.js"):
            self.assertEqual((await self.client.get(path, headers=REMOTE)).status, 401)
        self.assertEqual((await self.client.get("/", headers={**navigation, "Accept": "text/html"})).status, 401)
        self.assertEqual((await self.client.post("/api/phone/pair/start", headers=REMOTE)).status, 401)
        self.assertEqual((await self.client.get("/api/sessions", headers={**REMOTE, "Authorization": "Bearer fixture-master-token"})).status, 401)
        with self.assertRaises(WSServerHandshakeError) as failure:
            await self.client.ws_connect("/ws", headers=REMOTE)
        self.assertEqual(failure.exception.status, 401)

    async def test_real_cookie_auth_single_use_pairing_and_remote_admin_rejection(self):
        auth, _, code = await self.pair()
        response = await self.client.get("/api/sessions", headers=auth)
        self.assertEqual(await response.json(), {"actor": "owner_device"})
        self.assertEqual((await self.client.get("/assets/app.js", headers=auth)).status, 200)
        self.assertEqual((await self.client.post("/api/phone/pair/complete", headers=REMOTE, json={"code": code})).status, 401)
        self.assertEqual((await self.client.post("/api/phone/pair/start", headers=auth)).status, 403)
        self.assertEqual((await self.client.post("/api/phone/pin", headers=auth, json={"pin": "294817"})).status, 403)
        self.assertEqual((await self.client.get("/api/sessions", headers={**REMOTE, "Cookie": "ive_session=wrong"})).status, 401)

    async def test_pin_blocks_http_and_websocket_until_correct_unlock_and_revoke_closes_socket(self):
        auth, device, _ = await self.pair()
        self.assertEqual((await self.client.post("/api/phone/pin", headers=LOCAL, json={"pin": "294817"})).status, 200)
        # Setting/changing the PIN intentionally locks previously paired phones.
        self.assertEqual((await self.client.get("/api/sessions", headers=auth)).status, 423)
        with self.assertRaises(WSServerHandshakeError) as failure:
            await self.client.ws_connect("/ws", headers=auth)
        self.assertEqual(failure.exception.status, 423)
        self.assertEqual((await self.client.post("/api/phone/unlock", headers=auth, json={"pin": "000000"})).status, 401)
        self.assertEqual((await self.client.post("/api/phone/unlock", headers=auth, json={"pin": "294817"})).status, 200)
        socket = await self.client.ws_connect("/ws", headers=auth)
        self.assertEqual(await socket.receive_json(), {"actor": "owner_device"})
        self.assertEqual((await self.client.post(f"/api/phone/devices/{device}/revoke", headers=LOCAL)).status, 200)
        self.assertEqual((await socket.receive(timeout=2)).type, WSMsgType.CLOSE)
        await socket.close()
        self.assertEqual((await self.client.get("/api/sessions", headers=auth)).status, 401)

    async def test_tunnel_ends_or_changes_fail_closed_without_affecting_mac(self):
        for active in (None, "https://next-ive.trycloudflare.com", "http://test-ive.trycloudflare.com"):
            self.active_url = active
            self.assertEqual((await self.client.get("/pair", headers=REMOTE)).status, 403)
            self.assertEqual((await self.client.get("/api/whoami", headers=LOCAL)).status, 200)

    async def test_tunnel_classification_stays_external_if_global_mode_changes(self):
        # A stop can flip the global mode after a proxy request passes the
        # transport guard. It must never gain the socket peer's owner powers.
        self.server["_TUNNEL_MODE"] = False
        self.assertEqual((await self.client.get("/api/sessions", headers=REMOTE)).status, 401)
        auth, _, _ = await self.pair()
        self.assertEqual((await self.client.get("/api/sessions", headers=auth)).status, 200)

    async def test_spoofed_hosts_origins_and_proxy_headers_never_reach_auth(self):
        variants = [
            {**REMOTE, "Host": "attacker.invalid"}, {**REMOTE, "Origin": "https://attacker.invalid"},
            {**REMOTE, "Origin": "http://test-ive.trycloudflare.com"}, {**REMOTE, "Origin": "null"},
            {**REMOTE, "X-Forwarded-Proto": "http"}, {**REMOTE, "Cf-Connecting-Ip": "garbage"},
            {**LOCAL, "Cf-Connecting-Ip": "203.0.113.42"}, {**LOCAL, "X-Forwarded-For": "203.0.113.42"},
            {**LOCAL, "Forwarded": "for=203.0.113.42"},
        ]
        for missing in ("Origin", "Cf-Connecting-Ip", "X-Forwarded-Proto"):
            variants.append({key: value for key, value in REMOTE.items() if key != missing})
        for headers in variants:
            with self.subTest(headers=headers):
                self.assertEqual((await self.client.post("/api/phone/pair/start", headers=headers)).status, 403)
        for name in ("Origin", "Cf-Connecting-Ip", "X-Forwarded-Proto"):
            headers = CIMultiDict(REMOTE)
            headers.add(name, REMOTE[name])
            self.assertEqual((await self.client.get("/pair", headers=headers)).status, 403)

    async def test_known_hostname_without_proxy_contract_never_becomes_local(self):
        self.assertEqual((await self.client.get("/pair", headers={"Host": "test-ive.trycloudflare.com"})).status, 403)
        request = {"X-IVE-Desktop-Transport": "local"}
        external = auth_context.ProxyTrustConfig(external_proxy=True)
        self.assertIs(desktop_proxy_config(request, external), external)


class DesktopTunnelConfigurationTests(unittest.IsolatedAsyncioTestCase):
    def load(self, name, **overrides):
        tree = ast.parse(Path(__file__).with_name("server.py").read_text())
        nodes = [node for node in tree.body
                 if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name]
        namespace = dict(
            web=web, os=os, json=json, AUTH_TOKEN="fixture-token", logger=Mock(),
            get_auth=lambda _: SimpleNamespace(is_owner=True),
            _is_local_owner=lambda *_: True, _tunnel_proc=None,
            _runtime_tunnel_url=None, _TUNNEL_MODE=False, _MULTIPLAYER_MODE=False,
            _BIND_PORT=5555, PORT=5112, _BIND_HOST="0.0.0.0", _PUBLIC_URL="https://configured.invalid",
            _get_lan_ips=lambda: ["192.0.2.44"],
            _find_cloudflared=lambda: "/synthetic/cloudflared",
            _start_cloudflare_tunnel=AsyncMock(return_value=TUNNEL),
            _ensure_frontend_built=lambda: None, _fire_and_forget=lambda _: None,
        )
        namespace.update(overrides)
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "server.py", "exec"), namespace)
        return namespace

    async def test_runtime_tunnel_uses_actual_bind_port_not_unrelated_port_environment(self):
        for name in ("runtime_tunnel_start_handler", "runtime_mode_handler"):
            for bind, expected in ((5555, 5555), (None, 5112)):
                with self.subTest(handler=name, bind=bind):
                    namespace = self.load(name, _BIND_PORT=bind)
                    request = SimpleNamespace(json=AsyncMock(return_value={"mode": "tunnel"}))
                    with patch.dict(os.environ, {"PORT": "not-the-ive-server-port"}):
                        response = await namespace[name](request)
                    self.assertEqual(response.status, 200)
                    namespace["_start_cloudflare_tunnel"].assert_awaited_once_with(expected)

    async def test_frozen_runtime_prefers_its_bundled_executable_over_user_path(self):
        namespace = self.load("_find_cloudflared")
        with TemporaryDirectory(prefix="ive-cloudflared-path-") as directory:
            executable = Path(directory) / "tools" / "cloudflared"
            executable.parent.mkdir()
            executable.write_text("fixture only; never executed")
            executable.chmod(0o700)
            with patch.object(sys, "frozen", True, create=True), \
                    patch.object(sys, "_MEIPASS", directory, create=True), \
                    patch("shutil.which", return_value="/synthetic/user/cloudflared"):
                self.assertEqual(namespace["_find_cloudflared"](), str(executable.resolve()))
                executable.chmod(0o600)
                self.assertEqual(namespace["_find_cloudflared"](), "/synthetic/user/cloudflared")
                executable.chmod(0o700)
                with patch.object(sys, "frozen", False):
                    self.assertEqual(namespace["_find_cloudflared"](), "/synthetic/user/cloudflared")

    async def test_tunnel_keeps_draining_both_pipes_after_url_and_disables_autoupdate(self):
        # An actual isolated child writes several pipe capacities after URL
        # discovery. This catches a hanging tunnel, not just a mocked call.
        with TemporaryDirectory(prefix="ive-cloudflared-drain-") as directory:
            marker = Path(directory) / "completed.json"
            executable = Path(directory) / "fake-cloudflared"
            executable.write_text(
                f"#!{sys.executable}\n"
                "import json, os, sys, time\n"
                f"os.write(2, {TUNNEL.encode()!r} + b'\\n')\n"
                "time.sleep(0.1)\n"
                "for _ in range(256):\n"
                "    os.write(1, b'x' * 8192)\n"
                "    os.write(2, b'y' * 8192)\n"
                f"with open({str(marker)!r}, 'w') as output: json.dump(sys.argv[1:], output)\n"
            )
            executable.chmod(0o700)
            drains = []
            namespace = self.load(
                "_start_cloudflare_tunnel", asyncio=asyncio,
                _configure_cloudflare_proxy_trust=lambda: None,
                _find_cloudflared=lambda: str(executable),
                _fire_and_forget=lambda coro: drains.append(asyncio.create_task(coro)),
            )
            try:
                self.assertEqual(await namespace["_start_cloudflare_tunnel"](5555), TUNNEL)
                proc = namespace["_tunnel_proc"]
                await asyncio.wait_for(proc.wait(), 5)
                await asyncio.wait_for(asyncio.gather(*drains), 1)
                self.assertEqual(proc.returncode, 0)
                self.assertEqual(json.loads(marker.read_text()),
                                 ["tunnel", "--no-autoupdate", "--url", "http://localhost:5555"])
            finally:
                proc = namespace.get("_tunnel_proc")
                if proc is not None and proc.returncode is None:
                    proc.kill()
                    await proc.wait()
                for task in drains:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*drains, return_exceptions=True)

    async def test_desktop_advertises_only_its_active_owned_tunnel(self):
        namespace = self.load("_phone_reachable_urls")
        with patch.dict(os.environ, {"IVE_DESKTOP_INSTANCE": "fixture"}):
            self.assertEqual(namespace["_phone_reachable_urls"](None), [])
            namespace.update(_tunnel_proc=SimpleNamespace(returncode=None), _runtime_tunnel_url=TUNNEL)
            urls = namespace["_phone_reachable_urls"](None)
            self.assertEqual([(u["kind"], u["url"]) for u in urls], [("tunnel", TUNNEL)])
            namespace["_tunnel_proc"].returncode = 0
            self.assertEqual(namespace["_phone_reachable_urls"](None), [])
        with patch.dict(os.environ, {"IVE_DESKTOP_INSTANCE": ""}):
            urls = namespace["_phone_reachable_urls"](None)
            self.assertEqual([u["kind"] for u in urls], ["public", "lan"])


if __name__ == "__main__":
    unittest.main()
