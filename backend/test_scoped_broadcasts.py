"""test_queue_update and phone_paired must not leak to invited joiners."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("IVE_DATA_DIR", str(Path(_TMP.name) / "data"))

import server  # noqa: E402
from auth_context import AuthContext  # noqa: E402


class _Socket:
    def __init__(self, ctx):
        self._ive_auth_ctx = ctx
        self.sent = []

    async def send_str(self, data):
        self.sent.append(json.loads(data))

    async def send_json(self, data):  # legacy path must not be used
        self.sent.append(data)


def _ctx(kind, workspace_id=None):
    return AuthContext(
        actor_kind=kind, actor_id=None if kind == "localhost" else "x",
        mode="full" if kind == "localhost" else "code", brief_subscope=None,
        label=None, expires_at=None, workspace_id=workspace_id,
    )


class ScopedBroadcastTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.owner = _Socket(_ctx("localhost"))
        self.member = _Socket(_ctx("joiner_session", "ws-a"))
        self.stranger = _Socket(_ctx("joiner_session", "ws-b"))
        p = patch.object(server, "ws_clients", {self.owner, self.member, self.stranger})
        p.start()
        self.addCleanup(p.stop)

    async def test_test_queue_update_is_workspace_scoped(self):
        await server._broadcast_test_queue_entry({"id": "t1", "workspace_id": "ws-a"})
        self.assertEqual([e["type"] for e in self.owner.sent], ["test_queue_update"])
        self.assertEqual(self.member.sent[0]["entry"]["id"], "t1")
        self.assertEqual(self.stranger.sent, [])

    async def test_phone_paired_reaches_owners_only(self):
        await server._broadcast_to_owners({"type": "phone_paired", "device_id": "d", "label": "Max's iPhone"})
        self.assertEqual(self.owner.sent[0]["label"], "Max's iPhone")
        self.assertEqual(self.member.sent, [])
        self.assertEqual(self.stranger.sent, [])


if __name__ == "__main__":
    unittest.main()
