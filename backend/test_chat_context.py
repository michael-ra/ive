"""Chat context endpoints: fuzzy file/folder search, .gitignore, traversal guard, uploads.

Runs against temp folders and an in-process aiohttp app; never starts IVE.
"""
import os
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from aiohttp import FormData, web
from aiohttp.test_utils import TestClient, TestServer

import chat_context


def git(root, *args):
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


class ChatContextTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        chat_context._index_cache.clear()
        self.tmp = TemporaryDirectory(ignore_cleanup_errors=True)
        base = Path(self.tmp.name).resolve()
        self.root = base / "project"
        self.outside = base / "outside"
        self.uploads = base / "uploads"
        self.outside.mkdir()
        (self.outside / "secret.txt").write_text("top secret\n")
        r = self.root
        (r / "src" / "components").mkdir(parents=True)
        (r / "docs").mkdir()
        (r / "node_modules" / "lib").mkdir(parents=True)
        (r / "src" / "app.js").write_text("console.log('app')\n")
        (r / "src" / "components" / "ChatPanel.jsx").write_text("export default 1\n")
        (r / "docs" / "README.md").write_text("# Docs\n" + "".join(f"line {i}\n" for i in range(100)))
        (r / "notes.md").write_text("# Notes\n")
        (r / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
        (r / "data.bin").write_bytes(b"\x00\x01\x02" * 100)
        (r / "big.log").write_text("x" * (chat_context.MAX_PROJECT_FILE_BYTES + 10))
        (r / ".env").write_text("TOKEN=1\n")
        (r / "build").mkdir()
        (r / "build" / "out.js").write_text("built\n")
        (r / "node_modules" / "lib" / "index.js").write_text("dep\n")
        (r / ".gitignore").write_text("node_modules/\nbuild/\n.env\n")
        os.symlink(self.outside / "secret.txt", r / "link-out.txt")
        os.symlink(self.outside, r / "linkdir")
        git(r, "init", "-q")
        git(r, "add", "-A")
        git(r, "commit", "-qm", "init")

        async def resolve_root(sid):
            return {"s1": self.root, "gone": base / "missing"}.get(sid)

        app = web.Application()
        chat_context.register(app, lambda h: h, resolve_root, lambda sid: self.uploads / sid)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.tmp.cleanup()

    async def get(self, url, **params):
        res = await self.client.get(url, params=params)
        return res.status, await res.json()

    async def test_search_mixes_files_and_folders_with_fuzzy_ranking(self):
        status, body = await self.get("/api/sessions/s1/context/search", q="chatpan")
        self.assertEqual(status, 200)
        self.assertEqual(body["items"][0]["path"], "src/components/ChatPanel.jsx")
        status, body = await self.get("/api/sessions/s1/context/search", q="scpanel")  # subsequence
        self.assertIn("src/components/ChatPanel.jsx", [i["path"] for i in body["items"]])
        status, body = await self.get("/api/sessions/s1/context/search", q="comp")
        first = body["items"][0]
        self.assertEqual((first["path"], first["kind"]), ("src/components", "dir"))

    async def test_empty_query_lists_top_level_folders_first(self):
        _, body = await self.get("/api/sessions/s1/context/search", q="")
        paths = [i["path"] for i in body["items"]]
        self.assertEqual(paths[:2], ["docs", "src"])
        self.assertIn("notes.md", paths)

    async def test_gitignore_and_heavy_folders_are_not_offered(self):
        _, body = await self.get("/api/sessions/s1/context/search", q="index")
        self.assertFalse([i for i in body["items"] if "node_modules" in i["path"]])
        _, body = await self.get("/api/sessions/s1/context/search", q="out")
        self.assertNotIn("build/out.js", [i["path"] for i in body["items"]])
        _, body = await self.get("/api/sessions/s1/context/search", q=".env")
        self.assertNotIn(".env", [i["path"] for i in body["items"]])

    async def test_walk_fallback_outside_git_skips_heavy_folders(self):
        chat_context._index_cache.clear()
        subprocess.run(["rm", "-rf", str(self.root / ".git")], check=True)
        _, body = await self.get("/api/sessions/s1/context/search", q="index")
        self.assertFalse([i for i in body["items"] if "node_modules" in i["path"]])

    async def test_binary_and_large_files_are_flagged(self):
        _, body = await self.get("/api/sessions/s1/context/search", q="data.bin")
        item = next(i for i in body["items"] if i["path"] == "data.bin")
        self.assertEqual(item["status"], "binary")
        _, body = await self.get("/api/sessions/s1/context/search", q="big.log")
        item = next(i for i in body["items"] if i["path"] == "big.log")
        self.assertEqual(item["status"], "too_large")
        self.assertIn("MB", item["reason"])
        _, body = await self.get("/api/sessions/s1/context/search", q="logo")
        item = next(i for i in body["items"] if i["path"] == "logo.png")
        self.assertEqual((item["status"], item["file_type"]), ("ok", "image"))

    async def test_symlink_out_of_the_folder_is_flagged_in_search(self):
        _, body = await self.get("/api/sessions/s1/context/search", q="link-out")
        item = next(i for i in body["items"] if i["path"] == "link-out.txt")
        self.assertEqual(item["status"], "outside")

    async def test_inspect_file_and_folder_preview(self):
        status, body = await self.get("/api/sessions/s1/context/inspect", path="docs/README.md")
        self.assertEqual(status, 200)
        self.assertEqual(body["kind"], "file")
        self.assertTrue(body["preview"].startswith("# Docs"))
        self.assertTrue(body["preview_truncated"])
        status, body = await self.get("/api/sessions/s1/context/inspect", path="src/")
        self.assertEqual((status, body["kind"], body["path"]), (200, "dir", "src"))
        self.assertEqual(body["children"], ["components/", "app.js"])

    async def test_traversal_absolute_and_symlink_escapes_are_refused(self):
        for bad in ["../outside/secret.txt", "src/../../outside/secret.txt", str(self.outside / "secret.txt"),
                    "~/secret.txt", "link-out.txt", "linkdir/secret.txt", "linkdir"]:
            status, body = await self.get("/api/sessions/s1/context/inspect", path=bad)
            self.assertEqual(status, 403, bad)
            self.assertNotIn("top secret", str(body))

    async def test_missing_path_session_and_folder(self):
        status, _ = await self.get("/api/sessions/s1/context/inspect", path="nope.md")
        self.assertEqual(status, 404)
        status, _ = await self.get("/api/sessions/unknown/context/search", q="x")
        self.assertEqual(status, 404)
        status, body = await self.get("/api/sessions/gone/context/search", q="x")
        self.assertEqual(status, 409)
        self.assertIn("missing", body["error"])

    async def upload(self, name, data, sid="s1"):
        form = FormData()
        form.add_field("file", data, filename=name, content_type="application/octet-stream")
        res = await self.client.post(f"/api/sessions/{sid}/context/upload", data=form)
        return res.status, await res.json()

    async def test_upload_text_is_content_addressed_and_deduplicated(self):
        s1, a = await self.upload("../../evil notes.md", b"# hello\n")
        s2, b = await self.upload("../../evil notes.md", b"# hello\n")
        self.assertEqual((s1, s2), (201, 201))
        self.assertEqual(a["path"], b["path"])
        p = Path(a["path"])
        self.assertTrue(p.is_relative_to(self.uploads / "s1"))
        self.assertTrue(p.name.endswith("-evil_notes.md"), p.name)
        self.assertEqual(len(list((self.uploads / "s1").iterdir())), 1)

    async def test_upload_refuses_binary_and_large_files_with_reason(self):
        status, body = await self.upload("report.pdf", b"%PDF-1.4\n\x00\x01")
        self.assertEqual((status, body["reason"]), (415, "binary"))
        self.assertIn("not a text file", body["error"])
        status, body = await self.upload("blob.txt", b"\x00\x00\x01binary")
        self.assertEqual(status, 415)
        status, body = await self.upload("huge.log", b"a" * (chat_context.MAX_UPLOAD_BYTES + 1))
        self.assertEqual((status, body["reason"]), (413, "too_large"))
        self.assertFalse((self.uploads / "s1").exists())

    async def test_inspect_upload_rechecks_only_this_sessions_attachments(self):
        _, up = await self.upload("notes.md", b"# kept\nline 2\n")
        status, body = await self.get("/api/sessions/s1/context/inspect", upload=up["path"])
        self.assertEqual((status, body["status"], body["size"]), (200, "ok", up["size"]))
        self.assertIn("# kept", body["preview"])
        # Outside the attachment folder (project file, another folder): refused.
        status, _ = await self.get("/api/sessions/s1/context/inspect", upload=str(self.outside / "secret.txt"))
        self.assertEqual(status, 403)
        status, _ = await self.get("/api/sessions/s1/context/inspect", upload=str(self.uploads / "s1" / ".." / ".." / "outside" / "secret.txt"))
        self.assertEqual(status, 403)
        # Removed copy: 404 with a readable reason.
        Path(up["path"]).unlink()
        status, body = await self.get("/api/sessions/s1/context/inspect", upload=up["path"])
        self.assertEqual(status, 404)
        self.assertIn("no longer", body["error"])
        status, _ = await self.get("/api/sessions/nope/context/inspect", upload=up["path"])
        self.assertEqual(status, 404)

    def test_fuzzy_score_prefers_name_hits(self):
        a = chat_context.fuzzy_score("app", "src/app.js")
        b = chat_context.fuzzy_score("app", "apps/other/x.js")
        self.assertGreater(a, b)
        self.assertIsNone(chat_context.fuzzy_score("zzz", "src/app.js"))


if __name__ == "__main__":
    unittest.main()
