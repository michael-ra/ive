"""Native push (APNs): JWT, headers, token binding, 410 cleanup, revoke,
endpoints, and the curl HTTP/2 transport against a local fake server.
Temp SQLite + temp data dir; never talks to Apple.
"""
import base64
import json
import os
import stat
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import unittest

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

import apns
import auth_context
import db as database
import joiner_sessions
import phone_access

PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1 IVE-iOS/1.0"
REMOTE = {"X-Test-Peer": "192.168.1.50", "User-Agent": PHONE_UA}
TOKEN_A = "a1" * 32
TOKEN_B = "b2" * 32


def _p8() -> tuple[str, ec.EllipticCurvePrivateKey]:
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    return pem, key


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class FakeTransport:
    name = "fake"

    def __init__(self):
        self.calls = []
        self.replies = {}  # token -> (status, body dict)

    async def post(self, url, headers, body):
        self.calls.append({"url": url, "headers": dict(headers), "body": json.loads(body)})
        token = url.rsplit("/", 1)[-1]
        status, reply = self.replies.get(token, (200, None))
        return apns.ApnsResponse(status=status, body=json.dumps(reply).encode() if reply else b"")


class _Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "data"
        self.data.mkdir()
        for target, value in [("DATA_DIR", self.data), ("DB_PATH", self.data / "test.db")]:
            p = patch.object(database, target, value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.dict(os.environ, {"HOME": self.tmp.name})
        p.start()
        self.addCleanup(p.stop)
        os.environ.pop("IVE_APNS_TEST_ENDPOINT", None)
        await database.init_db()
        phone_access.codes = phone_access.PairingCodes()
        phone_access.lock = phone_access.PhoneLock()
        self.fake = FakeTransport()
        apns.set_transport(self.fake)
        self.addCleanup(apns.set_transport, None)
        apns._jwt_cache.clear()
        self.pem, self.key = _p8()

    async def _paired(self, label="iPhone"):
        code, _ = phone_access.codes.create()
        cookie, device, sess = await phone_access.complete_pairing(
            code=code, label=label, user_agent=PHONE_UA, remote_ip=None,
        )
        return cookie, device["id"], sess

    def _configure(self):
        apns.save_config(key_pem=self.pem, key_id="ABCDE12345", team_id="66Y43UAY3C", bundle_id="eu.aiforeu.ive")


class JwtAndConfigTests(_Base):
    async def test_jwt_is_es256_with_kid_iss_iat_and_verifies(self):
        self._configure()
        cfg = apns.load_config()
        token = apns.make_jwt(cfg, now=1_760_000_000)
        h, c, s = token.split(".")
        self.assertEqual(json.loads(_unb64(h)), {"alg": "ES256", "kid": "ABCDE12345"})
        self.assertEqual(json.loads(_unb64(c)), {"iss": "66Y43UAY3C", "iat": 1_760_000_000})
        raw = _unb64(s)
        self.assertEqual(len(raw), 64)  # JOSE raw r||s, not DER
        der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
        self.key.public_key().verify(der, f"{h}.{c}".encode(), ec.ECDSA(hashes.SHA256()))

    async def test_config_files_are_owner_only_and_status_hides_key(self):
        self._configure()
        for name in ("apns_key.p8", "apns.json"):
            mode = stat.S_IMODE((self.data / name).stat().st_mode)
            self.assertEqual(mode, 0o600, name)
        status = apns.public_status()
        self.assertTrue(status["configured"])
        self.assertEqual(status["key_id"], "ABCDE12345")
        self.assertNotIn("PRIVATE KEY", json.dumps(status))

    async def test_rejects_bad_key_and_ids(self):
        with self.assertRaises(apns.ApnsConfigError):
            apns.save_config(key_pem="not a key", key_id="ABCDE12345", team_id="66Y43UAY3C", bundle_id="eu.aiforeu.ive")
        rsa_like = ec.generate_private_key(ec.SECP384R1()).private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
        with self.assertRaises(apns.ApnsConfigError):
            apns.save_config(key_pem=rsa_like, key_id="ABCDE12345", team_id="66Y43UAY3C", bundle_id="eu.aiforeu.ive")
        with self.assertRaises(apns.ApnsConfigError):
            apns.save_config(key_pem=self.pem, key_id="short", team_id="66Y43UAY3C", bundle_id="eu.aiforeu.ive")
        self.assertIsNone(apns.load_config())

    async def test_jwt_is_cached_and_dropped_on_provider_error(self):
        self._configure()
        cfg = apns.load_config()
        first = apns._provider_token(cfg)
        self.assertEqual(apns._provider_token(cfg), first)
        self.fake.replies[TOKEN_A] = (403, {"reason": "ExpiredProviderToken"})
        result = await apns.send_one(cfg, TOKEN_A, "sandbox", {"aps": {}})
        self.assertFalse(result["ok"])
        self.assertFalse(result["dead"])
        self.assertEqual(apns._jwt_cache, {})


class SendTests(_Base):
    async def test_headers_hosts_and_payload(self):
        self._configure()
        _, dev_a, _ = await self._paired("A")
        _, dev_b, _ = await self._paired("B")
        apns.register_token(dev_a, TOKEN_A.upper(), "sandbox")
        apns.register_token(dev_b, TOKEN_B, "production")
        res = await apns.send_to_devices(title="Session done", body="Agent finished",
                                         path="/#session-s1", tag="idle:s1")
        self.assertEqual(res["sent"], 2)
        by_url = {c["url"]: c for c in self.fake.calls}
        self.assertIn(f"https://api.sandbox.push.apple.com/3/device/{TOKEN_A}", by_url)
        self.assertIn(f"https://api.push.apple.com/3/device/{TOKEN_B}", by_url)
        call = by_url[f"https://api.sandbox.push.apple.com/3/device/{TOKEN_A}"]
        h = call["headers"]
        self.assertEqual(h["apns-topic"], "eu.aiforeu.ive")
        self.assertEqual(h["apns-push-type"], "alert")
        self.assertEqual(h["apns-priority"], "10")
        self.assertEqual(h["apns-collapse-id"], "idle:s1")
        self.assertTrue(h["authorization"].startswith("bearer "))
        self.assertEqual(len(h["authorization"].split(" ", 1)[1].split(".")), 3)
        self.assertEqual(call["body"]["aps"]["alert"], {"title": "Session done", "body": "Agent finished"})
        self.assertEqual(call["body"]["aps"]["thread-id"], "s1")
        self.assertEqual(call["body"]["path"], "/#session-s1")
        self.assertTrue(apns.device_status(dev_a)["last_result"]["ok"])

    async def test_410_and_bad_device_token_delete_the_token(self):
        self._configure()
        _, dev_a, _ = await self._paired("A")
        _, dev_b, _ = await self._paired("B")
        apns.register_token(dev_a, TOKEN_A, "production")
        apns.register_token(dev_b, TOKEN_B, "sandbox")
        self.fake.replies[TOKEN_A] = (410, {"reason": "Unregistered"})
        self.fake.replies[TOKEN_B] = (400, {"reason": "BadDeviceToken"})
        res = await apns.send_to_devices(title="t", body="b")
        self.assertEqual(res["sent"], 0)
        self.assertTrue(res["results"][dev_a]["dead"])
        self.assertIsNone(apns.device_status(dev_a))
        self.assertIsNone(apns.device_status(dev_b))

    async def test_transient_error_keeps_token(self):
        self._configure()
        _, dev, _ = await self._paired()
        apns.register_token(dev, TOKEN_A, "production")
        self.fake.replies[TOKEN_A] = (503, {"reason": "ServiceUnavailable"})
        await apns.send_to_devices(title="t", body="b")
        st = apns.device_status(dev)
        self.assertEqual(st["last_result"]["reason"], "ServiceUnavailable")

    async def test_revoke_removes_token_and_revoked_devices_are_skipped(self):
        self._configure()
        _, dev, sess = await self._paired()
        apns.register_token(dev, TOKEN_A, "production")
        await phone_access.revoke_device(dev)
        self.assertIsNone(apns.device_status(dev))
        # Even a stale token entry for a revoked device is never used.
        tokens = apns._load_tokens()
        tokens[dev] = {"token": TOKEN_A, "environment": "production"}
        apns._save_tokens(tokens)
        res = await apns.send_to_devices(title="t", body="b")
        self.assertEqual(self.fake.calls, [])
        self.assertEqual(res["results"], {})

    async def test_expired_session_is_skipped(self):
        self._configure()
        _, dev, sess = await self._paired()
        apns.register_token(dev, TOKEN_A, "production")
        await joiner_sessions.revoke(sess.id)
        await apns.send_to_devices(title="t", body="b")
        self.assertEqual(self.fake.calls, [])

    async def test_unconfigured_is_a_noop(self):
        _, dev, _ = await self._paired()
        apns.register_token(dev, TOKEN_A, "production")
        res = await apns.send_to_devices(title="t", body="b")
        self.assertFalse(res["configured"])
        self.assertEqual(self.fake.calls, [])

    async def test_same_token_moves_to_the_new_device(self):
        _, dev_a, _ = await self._paired("A")
        _, dev_b, _ = await self._paired("B")
        apns.register_token(dev_a, TOKEN_A, "production")
        apns.register_token(dev_b, TOKEN_A, "production")
        self.assertIsNone(apns.device_status(dev_a))
        self.assertIsNotNone(apns.device_status(dev_b))

    async def test_hook_fans_out_to_apns(self):
        import hooks
        self._configure()
        _, dev, _ = await self._paired()
        apns.register_token(dev, TOKEN_A, "sandbox")
        hooks._push_cooldown.clear()
        with patch("push.send_to_owners", AsyncMock(return_value=0)):
            hooks._push_notify(tag="prompt:s9", title="Agent needs input", body="Allow Bash?", url="/#session-s9")
            import asyncio
            for _ in range(50):
                if self.fake.calls:
                    break
                await asyncio.sleep(0.02)
        self.assertEqual(len(self.fake.calls), 1)
        self.assertEqual(self.fake.calls[0]["body"]["path"], "/#session-s9")


def _peer(request):
    return request.headers.get("X-Test-Peer", "127.0.0.1")


class EndpointTests(_Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        import server
        self.server = server
        for name, value in [
            ("AUTH_TOKEN", "master-token"),
            ("bus", SimpleNamespace(emit=AsyncMock())),
            ("broadcast", AsyncMock()),
            ("_TUNNEL_MODE", False),
            ("_EXTERNAL_PROXY_MODE", False),
        ]:
            p = patch.object(server, name, value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(auth_context, "_socket_peer_ip", _peer)
        p.start()
        self.addCleanup(p.stop)
        server._auth_failures.clear()
        app = web.Application(middlewares=[server.cors_middleware, server.token_auth_middleware])
        app.router.add_post("/api/phone/apns-token", server.phone_apns_token_handler)
        app.router.add_delete("/api/phone/apns-token", server.phone_apns_token_handler)
        app.router.add_get("/api/phone/apns", server.phone_apns_status_handler)
        app.router.add_post("/api/phone/apns", server.phone_apns_config_handler)
        app.router.add_delete("/api/phone/apns", server.phone_apns_config_handler)
        app.router.add_post("/api/phone/apns/test", server.phone_apns_test_handler)
        app.router.add_post("/api/phone/devices/{id}/revoke", server.phone_device_revoke_handler)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    def _phone(self, cookie):
        return {**REMOTE, "Cookie": f"ive_session={cookie}"}

    async def test_only_a_paired_phone_registers(self):
        r = await self.client.post("/api/phone/apns-token", json={"token": TOKEN_A, "environment": "sandbox"})
        self.assertEqual(r.status, 403)  # the Mac itself is not a phone
        r = await self.client.post("/api/phone/apns-token", json={"token": TOKEN_A, "environment": "sandbox"},
                                   headers=REMOTE)
        self.assertEqual(r.status, 401)  # unpaired remote
        cookie, dev, _ = await self._paired()
        r = await self.client.post("/api/phone/apns-token", json={"token": "xyz", "environment": "sandbox"},
                                   headers=self._phone(cookie))
        self.assertEqual(r.status, 400)
        r = await self.client.post("/api/phone/apns-token", json={"token": TOKEN_A, "environment": "staging"},
                                   headers=self._phone(cookie))
        self.assertEqual(r.status, 400)
        r = await self.client.post("/api/phone/apns-token",
                                   json={"token": TOKEN_A, "environment": "sandbox", "bundle_id": "eu.aiforeu.ive"},
                                   headers=self._phone(cookie))
        self.assertEqual(r.status, 200)
        body = await r.json()
        self.assertEqual(body["environment"], "sandbox")
        self.assertFalse(body["apns_configured"])
        self.assertEqual(apns.device_status(dev)["environment"], "sandbox")

    async def test_config_is_mac_only_and_never_returns_the_key(self):
        cookie, dev, _ = await self._paired()
        payload = {"key_p8": self.pem, "key_id": "abcde12345", "team_id": "66Y43UAY3C", "bundle_id": "eu.aiforeu.ive"}
        r = await self.client.post("/api/phone/apns", json=payload, headers=self._phone(cookie))
        self.assertEqual(r.status, 403)
        r = await self.client.post("/api/phone/apns", json={**payload, "key_p8": "junk"})
        self.assertEqual(r.status, 400)
        r = await self.client.post("/api/phone/apns", json=payload)
        self.assertEqual(r.status, 200)
        text = await r.text()
        self.assertNotIn("PRIVATE", text)
        self.assertEqual((await r.json())["key_id"], "ABCDE12345")
        # Change only the ids, keep the key.
        r = await self.client.post("/api/phone/apns", json={"key_id": "ZZZZZ99999"})
        self.assertEqual(r.status, 200)
        self.assertEqual(apns.load_config().key_id, "ZZZZZ99999")
        r = await self.client.get("/api/phone/apns")
        st = await r.json()
        self.assertTrue(st["configured"])
        self.assertTrue(st["can_edit"])
        self.assertNotIn("PRIVATE", json.dumps(st))
        r = await self.client.get("/api/phone/apns", headers=self._phone(cookie))
        self.assertFalse((await r.json())["can_edit"])
        r = await self.client.delete("/api/phone/apns")
        self.assertFalse((await r.json())["configured"])

    async def test_test_send_and_revoke(self):
        r = await self.client.post("/api/phone/apns/test", json={})
        self.assertEqual(r.status, 400)  # no key yet
        self._configure()
        r = await self.client.post("/api/phone/apns/test", json={})
        self.assertEqual(r.status, 400)  # no phone registered
        cookie, dev, _ = await self._paired()
        await self.client.post("/api/phone/apns-token", json={"token": TOKEN_A, "environment": "production"},
                               headers=self._phone(cookie))
        r = await self.client.post("/api/phone/apns/test", json={"device_id": dev})
        self.assertEqual(r.status, 200)
        body = await r.json()
        self.assertTrue(body["ok"])
        self.assertEqual(self.fake.calls[-1]["body"]["aps"]["alert"]["title"], "IVE")
        st = await (await self.client.get("/api/phone/apns")).json()
        self.assertEqual(st["devices"][0]["apns"]["token_tail"], TOKEN_A[-6:])
        r = await self.client.post(f"/api/phone/devices/{dev}/revoke")
        self.assertEqual(r.status, 200)
        self.assertIsNone(apns.device_status(dev))

    async def test_phone_can_unregister_itself(self):
        cookie, dev, _ = await self._paired()
        await self.client.post("/api/phone/apns-token", json={"token": TOKEN_A, "environment": "production"},
                               headers=self._phone(cookie))
        r = await self.client.delete("/api/phone/apns-token", headers=self._phone(cookie))
        self.assertTrue((await r.json())["removed"])
        self.assertIsNone(apns.device_status(dev))


@unittest.skipUnless(apns.CurlHttp2Transport.available(), "curl with HTTP2 not available")
class CurlTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_round_trip_through_curl(self):
        seen = {}

        async def handler(request):
            seen["headers"] = request.headers.copy()  # case-insensitive
            seen["body"] = await request.read()
            seen["path"] = request.path
            return web.json_response({"reason": "Unregistered"}, status=410)

        app = web.Application()
        app.router.add_post("/3/device/{token}", handler)
        server = TestServer(app)
        await server.start_server()
        self.addAsyncCleanup(server.close)
        t = apns.CurlHttp2Transport(timeout=10)
        body = json.dumps({"aps": {"alert": {"title": 'Quote " and \\ and ü', "body": "x"}}}).encode()
        resp = await t.post(f"http://127.0.0.1:{server.port}/3/device/{TOKEN_A}",
                            {"authorization": "bearer a.b.c", "apns-topic": "eu.aiforeu.ive"}, body)
        self.assertEqual(resp.status, 410)
        self.assertEqual(json.loads(resp.body)["reason"], "Unregistered")
        self.assertEqual(seen["path"], f"/3/device/{TOKEN_A}")
        self.assertEqual(seen["headers"]["authorization"], "bearer a.b.c")
        self.assertEqual(seen["headers"]["apns-topic"], "eu.aiforeu.ive")
        self.assertEqual(seen["body"], body)

    async def test_connection_failure_is_reported(self):
        t = apns.CurlHttp2Transport(timeout=3)
        with self.assertRaises(apns.TransportUnavailable):
            await t.post("http://127.0.0.1:9/3/device/x", {}, b"{}")


if __name__ == "__main__":
    unittest.main()
