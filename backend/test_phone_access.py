"""Phone access: pairing code, device credential, expiry, revoke, PIN lock,
remote rejection, Origin guard. Temp SQLite + temp data dir; no real server,
no cloudflared. Remote callers are emulated by patching the socket peer IP.
"""
import asyncio
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import unittest

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import auth_context
import db as database
import joiner_sessions
import phone_access
from phone_setup import PhoneSetup

PHONE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
)
REMOTE = {"X-Test-Peer": "192.168.1.50", "User-Agent": PHONE_UA}


def _peer(request):
    return request.headers.get("X-Test-Peer", "127.0.0.1")


class _Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        data = Path(self.tmp.name) / "data"
        data.mkdir()
        for target, value in [("DATA_DIR", data), ("DB_PATH", data / "test.db")]:
            p = patch.object(database, target, value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.dict(os.environ, {"HOME": self.tmp.name})
        p.start()
        self.addCleanup(p.stop)
        await database.init_db()
        # Fresh in-memory state per test.
        phone_access.codes = phone_access.PairingCodes()
        phone_access.lock = phone_access.PhoneLock()


class PairingCodeTests(unittest.TestCase):
    def test_single_use(self):
        codes = phone_access.PairingCodes()
        code, _ = codes.create()
        self.assertEqual(len(code), 8)
        self.assertTrue(codes.consume(code))
        self.assertFalse(codes.consume(code))

    def test_normalizes_display_form(self):
        codes = phone_access.PairingCodes()
        code, _ = codes.create()
        typed = phone_access.display_code(code).lower()
        self.assertTrue(codes.consume(f" {typed} "))

    def test_expires(self):
        codes = phone_access.PairingCodes()
        code, _ = codes.create(ttl=-1)
        self.assertFalse(codes.consume(code))
        self.assertIsNone(codes.active())

    def test_burned_after_wrong_guesses(self):
        codes = phone_access.PairingCodes()
        code, _ = codes.create()
        for _ in range(phone_access.PAIR_CODE_MAX_FAILURES):
            self.assertFalse(codes.consume("ZZZZZZZZ" if code != "ZZZZZZZZ" else "YYYYYYYY"))
        self.assertFalse(codes.consume(code))

    def test_new_code_replaces_old(self):
        codes = phone_access.PairingCodes()
        first, _ = codes.create()
        second, _ = codes.create()
        if first != second:
            self.assertFalse(codes.consume(first))
        self.assertTrue(codes.consume(second))

    def test_weak_pins_rejected(self):
        for pin in ("12345", "111111", "123456", "987654", "12a456", ""):
            with self.assertRaises(ValueError):
                phone_access.validate_pin(pin)
        self.assertEqual(phone_access.validate_pin("294817"), "294817")


class DeviceCredentialTests(_Base):
    def _req(self, cookie=None, peer="192.168.1.50", token=None):
        cookies = {}
        if cookie:
            cookies[auth_context.SESSION_COOKIE] = cookie
        if token:
            cookies[auth_context.LEGACY_COOKIE] = token
        return SimpleNamespace(
            headers={"User-Agent": PHONE_UA},
            cookies=cookies,
            query={},
            transport=SimpleNamespace(get_extra_info=lambda name: (peer, 1234)),
        )

    async def _resolve(self, req):
        return await auth_context.resolve_auth(
            req, auth_token="master-token",
            proxy_config=auth_context.ProxyTrustConfig(),
        )

    async def test_pairing_mints_owner_device(self):
        code, _ = phone_access.codes.create()
        cookie, device, sess = await phone_access.complete_pairing(
            code=code, label="", user_agent=PHONE_UA, remote_ip="192.168.1.50",
        )
        self.assertEqual(device["label"], "iPhone")
        self.assertEqual(sess.actor_kind, "owner_device")
        self.assertEqual(sess.device_id, device["id"])
        ctx = await self._resolve(self._req(cookie))
        self.assertEqual(ctx.actor_kind, "owner_device")
        self.assertTrue(ctx.is_owner)
        self.assertEqual(ctx.device_id, device["id"])
        # Only the hash is stored.
        conn = await database.get_db()
        try:
            cur = await conn.execute("SELECT token_hash FROM joiner_sessions WHERE id = ?", (sess.id,))
            self.assertNotEqual((await cur.fetchone())["token_hash"], cookie)
        finally:
            await conn.close()

    async def test_wrong_code_mints_nothing(self):
        phone_access.codes.create()
        self.assertIsNone(await phone_access.complete_pairing(
            code="AAAAAAAA", label="", user_agent=PHONE_UA, remote_ip=None,
        ))
        self.assertEqual(await phone_access.list_devices(), [])

    async def test_remote_without_credential_rejected(self):
        self.assertIsNone(await self._resolve(self._req()))
        self.assertIsNone(await self._resolve(self._req("not-a-real-cookie")))

    async def test_remote_master_token_is_not_a_credential(self):
        self.assertIsNone(await self._resolve(self._req(token="master-token")))
        local = await self._resolve(self._req(peer="127.0.0.1"))
        self.assertEqual(local.actor_kind, "localhost")

    async def test_expired_credential_rejected(self):
        code, _ = phone_access.codes.create()
        cookie, _, sess = await phone_access.complete_pairing(
            code=code, label="Max", user_agent=PHONE_UA, remote_ip=None,
        )
        conn = await database.get_db()
        try:
            await conn.execute(
                "UPDATE joiner_sessions SET expires_at = '2000-01-01 00:00:00' WHERE id = ?",
                (sess.id,),
            )
            await conn.commit()
        finally:
            await conn.close()
        self.assertIsNone(await self._resolve(self._req(cookie)))

    async def test_revoke_kills_credential_and_push(self):
        code, _ = phone_access.codes.create()
        cookie, device, sess = await phone_access.complete_pairing(
            code=code, label="", user_agent=PHONE_UA, remote_ip=None,
        )
        import push
        await push.upsert_subscription(
            actor_kind="owner_device", actor_id=sess.id,
            endpoint="https://web.push.apple.com/x", p256dh="k", auth="a",
            user_agent=PHONE_UA,
        )
        self.assertEqual(len(await push.list_owner_subscriptions()), 1)
        revoked, sids = await phone_access.revoke_device(device["id"])
        self.assertTrue(revoked)
        self.assertEqual(sids, [sess.id])
        self.assertIsNone(await self._resolve(self._req(cookie)))
        self.assertEqual(await push.list_owner_subscriptions(), [])
        self.assertEqual(await phone_access.list_devices(), [])

    async def test_push_skips_revoked_session_subscriptions(self):
        import push
        _, sess = await joiner_sessions.create_session(
            mode="full", actor_kind="owner_device", ttl_seconds=3600,
        )
        await push.upsert_subscription(
            actor_kind="owner_device", actor_id=sess.id,
            endpoint="https://e/1", p256dh="k", auth="a", user_agent=None,
        )
        await push.upsert_subscription(
            actor_kind="localhost", actor_id=None,
            endpoint="https://e/2", p256dh="k", auth="a", user_agent=None,
        )
        self.assertEqual(len(await push.list_owner_subscriptions()), 2)
        await joiner_sessions.revoke(sess.id)
        subs = await push.list_owner_subscriptions()
        self.assertEqual([s["endpoint"] for s in subs], ["https://e/2"])


class PinLockTests(_Base):
    async def test_lock_cycle(self):
        lock = phone_access.lock
        self.assertFalse(lock.is_locked("s1"))  # no PIN → never locked
        lock.set_pin("294817", idle_minutes=15)
        self.assertTrue((Path(database.DATA_DIR) / "phone_lock.json").exists())
        self.assertEqual(oct((Path(database.DATA_DIR) / "phone_lock.json").stat().st_mode & 0o777), "0o600")
        self.assertTrue(lock.is_locked("s1"))  # never unlocked since start
        self.assertFalse(lock.check_pin("000000"))
        self.assertTrue(lock.check_pin("294817"))
        lock.mark_unlocked("s1")
        self.assertFalse(lock.is_locked("s1"))
        self.assertFalse(lock.needs_reauth("s1"))
        with patch.object(phone_access, "_now", return_value=phone_access._now() + 16 * 60):
            self.assertTrue(lock.is_locked("s1"))
            self.assertTrue(lock.needs_reauth("s1"))
        lock.lock_now("s1")
        self.assertTrue(lock.is_locked("s1"))
        # A fresh instance (backend restart) reads the PIN and starts locked.
        fresh = phone_access.PhoneLock()
        self.assertTrue(fresh.pin_enabled())
        self.assertTrue(fresh.is_locked("s1"))
        lock.clear_pin()
        self.assertFalse(lock.is_locked("s1"))

    async def test_failures_count_down(self):
        lock = phone_access.lock
        lock.set_pin("294817")
        left = [lock.register_failure("s1") for _ in range(phone_access.PIN_MAX_FAILURES)]
        self.assertEqual(left[-1], 0)
        self.assertEqual(left[0], phone_access.PIN_MAX_FAILURES - 1)


class HttpFlowTests(_Base):
    """The real middleware + handlers from server.py on a tiny aiohttp app."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        import server
        self.server = server
        for name, value in [
            ("AUTH_TOKEN", "master-token"),
            ("bus", SimpleNamespace(emit=AsyncMock())),
            ("broadcast", AsyncMock()),
            ("_BIND_HOST", "0.0.0.0"),
            ("_BIND_PORT", 5272),
            ("_get_lan_ips", lambda: ["192.168.1.10"]),
            ("_TUNNEL_MODE", False),
            ("_find_cloudflared", lambda: None),
            ("_EXTERNAL_PROXY_MODE", False),
        ]:
            p = patch.object(server, name, value)
            p.start()
            self.addCleanup(p.stop)
        import push
        p = patch.object(push, "get_public_key", lambda: None)
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(auth_context, "_socket_peer_ip", _peer)
        p.start()
        self.addCleanup(p.stop)
        server._auth_failures.clear()

        async def sessions(request):
            return web.json_response({"ok": True, "actor": server.get_auth(request).actor_kind})

        async def ws(request):
            sock = web.WebSocketResponse()
            await sock.prepare(request)
            await sock.close()
            return sock

        app = web.Application(middlewares=[server.cors_middleware, server.token_auth_middleware])
        app[server._PHONE_SETUP] = PhoneSetup(Path(self.tmp.name))
        app[server._PHONE_AVAILABILITY] = SimpleNamespace(
            status=AsyncMock(return_value={"state": "unavailable"}),
        )
        app.router.add_get("/api/sessions", sessions)
        app.router.add_post("/api/invite/create", sessions)
        app.router.add_get("/ws", ws)
        app.router.add_get("/", lambda r: web.Response(text="<html>app</html>", content_type="text/html"))
        app.router.add_get("/pair", server.phone_connect_page_handler)
        app.router.add_get("/pair.js", server.phone_pair_js_handler)
        app.router.add_get("/api/phone/status", server.phone_status_handler)
        app.router.add_post("/api/phone/pair/start", server.phone_pair_start_handler)
        app.router.add_post("/api/phone/pair/complete", server.phone_pair_complete_handler)
        app.router.add_get("/api/phone/devices", server.phone_devices_handler)
        app.router.add_post("/api/phone/devices/{id}/revoke", server.phone_device_revoke_handler)
        app.router.add_post("/api/phone/pin", server.phone_pin_set_handler)
        app.router.add_post("/api/phone/unlock", server.phone_unlock_handler)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def _pair(self):
        r = await self.client.post("/api/phone/pair/start")
        self.assertEqual(r.status, 200)
        body = await r.json()
        self.assertEqual(body["urls"][0]["pair_url"], f"http://192.168.1.10:5272/pair#{body['code']}")
        r = await self.client.post(
            "/api/phone/pair/complete", json={"code": body["code_display"]}, headers=REMOTE,
        )
        self.assertEqual(r.status, 200)
        set_cookie = r.headers.get("Set-Cookie", "")
        self.assertIn("HttpOnly", set_cookie)
        self.assertIn("SameSite=Strict", set_cookie)
        cookie = r.cookies[auth_context.SESSION_COOKIE].value
        self.client.session.cookie_jar.clear()
        return cookie, (await r.json())["device"]["id"]

    async def test_remote_without_credential_is_rejected_everywhere(self):
        r = await self.client.get("/api/sessions", headers=REMOTE)
        self.assertEqual(r.status, 401)
        r = await self.client.get("/", headers={**REMOTE, "Accept": "text/html"})
        self.assertEqual(r.status, 401)
        html = await r.text()
        self.assertIn("Pairing code", html)
        self.assertNotIn("app</html>", html)
        r = await self.client.get("/ws", headers={**REMOTE, "Upgrade": "websocket", "Connection": "Upgrade",
                                                   "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ=="})
        self.assertEqual(r.status, 401)
        # The connect page and its script are public, but carry no data.
        self.assertEqual((await self.client.get("/pair", headers=REMOTE)).status, 200)
        self.assertEqual((await self.client.get("/pair.js", headers=REMOTE)).status, 200)

    async def test_pair_start_is_mac_only(self):
        r = await self.client.post("/api/phone/pair/start", headers=REMOTE)
        self.assertEqual(r.status, 401)
        cookie, _ = await self._pair()
        # A paired phone is an owner, but still cannot mint pairing codes.
        r = await self.client.post("/api/phone/pair/start", headers={**REMOTE, "Cookie": f"ive_session={cookie}"})
        self.assertEqual(r.status, 403)
        r = await self.client.post("/api/phone/pin", json={"pin": "294817"}, headers={**REMOTE, "Cookie": f"ive_session={cookie}"})
        self.assertEqual(r.status, 403)

    async def test_paired_phone_gets_in_until_revoked(self):
        cookie, device_id = await self._pair()
        auth = {**REMOTE, "Cookie": f"ive_session={cookie}"}
        r = await self.client.get("/api/sessions", headers=auth)
        self.assertEqual(r.status, 200)
        self.assertEqual((await r.json())["actor"], "owner_device")
        r = await self.client.get("/api/phone/devices")
        self.assertEqual([d["id"] for d in (await r.json())["devices"]], [device_id])
        r = await self.client.post(f"/api/phone/devices/{device_id}/revoke")
        self.assertEqual(r.status, 200)
        self.assertEqual((await self.client.get("/api/sessions", headers=auth)).status, 401)

    async def test_code_is_single_use(self):
        r = await self.client.post("/api/phone/pair/start")
        code = (await r.json())["code"]
        r1 = await self.client.post("/api/phone/pair/complete", json={"code": code}, headers=REMOTE)
        self.assertEqual(r1.status, 200)
        self.client.session.cookie_jar.clear()
        r2 = await self.client.post("/api/phone/pair/complete", json={"code": code}, headers=REMOTE)
        self.assertEqual(r2.status, 401)

    async def test_cross_origin_refused(self):
        evil = {"Origin": "https://evil.example"}
        r = await self.client.post("/api/invite/create", headers=evil)
        self.assertEqual(r.status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", r.headers)
        r = await self.client.post("/api/phone/pair/complete", json={"code": "x"}, headers={**REMOTE, **evil})
        self.assertEqual(r.status, 403)
        r = await self.client.options("/api/sessions", headers=evil)
        self.assertNotIn("Access-Control-Allow-Origin", r.headers)
        # Same-origin and the loopback dev server stay fine.
        host = f"{self.client.host}:{self.client.port}"
        r = await self.client.get("/api/sessions", headers={"Origin": f"http://{host}"})
        self.assertEqual(r.status, 200)
        r = await self.client.get("/api/sessions", headers={"Origin": "http://localhost:5173"})
        self.assertEqual(r.status, 200)

    async def test_pin_lock_blocks_idle_phone(self):
        cookie, _ = await self._pair()
        r = await self.client.post("/api/phone/pin", json={"pin": "294817", "idle_minutes": 15})
        self.assertEqual(r.status, 200)
        auth = {**REMOTE, "Cookie": f"ive_session={cookie}"}
        # Setting a PIN locks every phone once.
        r = await self.client.get("/api/sessions", headers=auth)
        self.assertEqual(r.status, 423)
        r = await self.client.get("/", headers={**auth, "Accept": "text/html"})
        self.assertEqual(r.status, 423)
        self.assertIn('data-mode="unlock"', await r.text())
        r = await self.client.get("/api/phone/status", headers=auth)
        self.assertTrue((await r.json())["locked"])
        r = await self.client.post("/api/phone/unlock", json={"pin": "000000"}, headers=auth)
        self.assertEqual(r.status, 401)
        r = await self.client.post("/api/phone/unlock", json={"pin": "294817"}, headers=auth)
        self.assertEqual(r.status, 200)
        self.assertEqual((await self.client.get("/api/sessions", headers=auth)).status, 200)
        # Sensitive action needs a recent PIN.
        later = phone_access._now() + phone_access.REAUTH_WINDOW_SECONDS + 5
        with patch.object(phone_access, "_now", return_value=later):
            r = await self.client.post("/api/invite/create", headers=auth)
            self.assertEqual(r.status, 423)
            self.assertEqual((await r.json())["error"], "reauth_required")

    async def test_lan_token_link_mints_revocable_session(self):
        # Before: a LAN visitor with ?token= got the raw master token as a
        # cookie. Now it is exchanged for a per-row, revocable session.
        r = await self.client.get("/?token=master-token", headers=REMOTE, allow_redirects=False)
        self.assertEqual(r.status, 302)
        self.assertIn(auth_context.SESSION_COOKIE, r.cookies)
        self.assertNotIn(auth_context.LEGACY_COOKIE, {k for k, v in r.cookies.items() if v.value})
        rows = await joiner_sessions.list_active()
        self.assertEqual([row["actor_kind"] for row in rows], ["owner_legacy"])

    async def test_wrong_pins_revoke_phone(self):
        cookie, _ = await self._pair()
        await self.client.post("/api/phone/pin", json={"pin": "294817"})
        auth = {**REMOTE, "Cookie": f"ive_session={cookie}"}
        statuses = []
        for _ in range(phone_access.PIN_MAX_FAILURES):
            r = await self.client.post("/api/phone/unlock", json={"pin": "000000"}, headers=auth)
            statuses.append((r.status, (await r.json()).get("error")))
        self.assertEqual(statuses[-1], (401, "revoked"))
        self.assertEqual((await self.client.get("/api/phone/status", headers=auth)).status, 401)
        self.assertEqual(await phone_access.list_devices(), [])


if __name__ == "__main__":
    unittest.main()
