"""Per-session proof for hook and MCP callers (self-declared session ids).

Isolated: IVE_DATA_DIR / HOME point at a temp dir before backend imports and
config.DATA_DIR is patched per test.
"""
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

_TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("IVE_DATA_DIR", str(Path(_TMP.name) / "data"))

from aiohttp.test_utils import make_mocked_request  # noqa: E402

import config  # noqa: E402
import hook_installer  # noqa: E402
import hooks  # noqa: E402
import session_proofs  # noqa: E402


class _ProofTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir=_TMP.name))
        p = patch.object(config, "DATA_DIR", self.dir)
        p.start()
        self.addCleanup(p.stop)
        session_proofs._cache.clear()
        self.addCleanup(session_proofs._cache.clear)


class SessionProofStoreTests(_ProofTestCase):
    def test_issue_is_stable_persisted_and_private(self):
        proof = session_proofs.issue("s1")
        self.assertEqual(session_proofs.issue("s1"), proof)
        path = self.dir / "session_proofs.json"
        self.assertEqual(json.loads(path.read_text()), {"s1": proof})
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        # A restarted backend (fresh cache) still enforces it.
        session_proofs._cache.clear()
        self.assertEqual(session_proofs.check("s1", proof), session_proofs.OK)
        self.assertEqual(session_proofs.check("s1", "nope"), session_proofs.MISMATCH)
        self.assertEqual(session_proofs.check("s1", None), session_proofs.MISMATCH)

    def test_sessions_without_proof_are_legacy(self):
        self.assertEqual(session_proofs.check("old", None), session_proofs.LEGACY)
        self.assertEqual(session_proofs.check("old", "anything"), session_proofs.LEGACY)

    def test_env_name_survives_cli_env_filters(self):
        # Codex/Gemini drop env vars whose names contain these words.
        for word in ("KEY", "SECRET", "TOKEN", "PASSWORD", "AUTH", "CREDENTIAL"):
            self.assertNotIn(word, session_proofs.ENV_VAR)


class HookEventProofTests(_ProofTestCase):
    async def _post(self, headers):
        req = make_mocked_request("POST", "/api/hooks/event", headers=headers)
        req.json = AsyncMock(return_value={"hook_event_name": "IveProofProbe"})
        with patch.object(hooks, "_maybe_capture_native_id", AsyncMock()), \
                patch.object(hooks, "_emit_normalized", AsyncMock()), \
                patch.object(hooks, "_dispatch_plugin_hooks", AsyncMock()) as dispatch:
            resp = await hooks.handle_hook_event(req)
        return resp, dispatch

    async def test_forged_session_id_is_rejected(self):
        session_proofs.issue("victim")
        resp, dispatch = await self._post({"X-Commander-Session-Id": "victim"})
        self.assertEqual(resp.status, 403)
        dispatch.assert_not_awaited()
        resp, dispatch = await self._post({
            "X-Commander-Session-Id": "victim", "X-Commander-Session-Proof": "guess",
        })
        self.assertEqual(resp.status, 403)

    async def test_matching_proof_is_processed(self):
        proof = session_proofs.issue("s1")
        resp, dispatch = await self._post({
            "X-Commander-Session-Id": "s1", "X-Commander-Session-Proof": proof,
        })
        self.assertEqual(resp.status, 200)
        dispatch.assert_awaited_once()

    async def test_legacy_session_still_accepted(self):
        resp, dispatch = await self._post({"X-Commander-Session-Id": "pre-upgrade"})
        self.assertEqual(resp.status, 200)
        dispatch.assert_awaited_once()


class RelayScriptTests(unittest.TestCase):
    def test_shell_relay_sends_proof_on_every_event_post(self):
        script = hook_installer.HOOK_SCRIPT
        self.assertEqual(
            script.count('-H "X-Commander-Session-Proof: ${COMMANDER_SESSION_PROOF:-}"'),
            script.count("/api/hooks/event"),
        )

    def test_desktop_relay_sends_proof(self):
        import desktop_hook_relay
        seen = {}

        class _Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b"{}"

        def fake_urlopen(request, timeout):
            seen.update(dict(request.header_items()))
            return _Resp()

        with patch.dict(os.environ, {"COMMANDER_SESSION_PROOF": "p1"}), \
                patch.object(desktop_hook_relay.urllib.request, "urlopen", fake_urlopen), \
                patch.object(desktop_hook_relay.json, "load", lambda _r: {}):
            desktop_hook_relay.post("/api/hooks/event", {}, "s1")
        self.assertEqual(seen.get("X-commander-session-proof"), "p1")


class PipelineResultCallerTests(_ProofTestCase):
    async def asyncSetUp(self):
        import server
        self.server = server

    async def _post(self, headers, caller):
        req = make_mocked_request("POST", "/api/hooks/pipeline-result", headers=headers)
        req.json = AsyncMock(return_value={"session_id": "s1", "status": "pass"})
        with patch.object(self.server, "_resolve_caller", AsyncMock(return_value=caller)):
            return await self.server.handle_pipeline_result(req)

    async def test_missing_caller_identity_fails_closed(self):
        resp = await self._post({}, None)
        self.assertEqual(resp.status, 403)

    async def test_other_session_is_rejected(self):
        resp = await self._post({}, {"session_id": "s2", "verified": True})
        self.assertEqual(resp.status, 403)

    async def test_unverified_caller_rejected_once_proof_issued(self):
        session_proofs.issue("s1")
        resp = await self._post({}, {"session_id": "s1", "verified": False})
        self.assertEqual(resp.status, 403)

    async def test_resolve_caller_voids_mismatched_proof(self):
        session_proofs.issue("s1")
        req = make_mocked_request("GET", "/api/x", headers={
            "X-IVE-Session-Id": "s1", "X-IVE-Session-Proof": "forged",
        })
        self.assertIsNone(await self.server._resolve_caller(req))


if __name__ == "__main__":
    unittest.main()
