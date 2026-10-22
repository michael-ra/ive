"""Exercise real workspace HTTP handlers without starting services or CLIs."""
import ast
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

from aiohttp import web


def handlers(**dependencies):
    tree = ast.parse(Path(__file__).with_name("server.py").read_text())
    names = {"list_workspace_files", "get_workspace_git_log"}
    module = ast.Module(body=[node for node in tree.body
                             if isinstance(node, ast.AsyncFunctionDef) and node.name in names],
                        type_ignores=[])
    namespace = {"web": web, **dependencies}
    exec(compile(module, "server.py", "exec"), namespace)
    return SimpleNamespace(**{name: namespace[name] for name in names})


class WorkspaceFilesTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(prefix="ive-workspace-files-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / "repo"
        self.root.mkdir()
        self.outside = self.base / "outside"
        self.outside.mkdir()
        (self.outside / "outside-marker.txt").write_text("outside")
        (self.root / "src").mkdir()
        (self.root / "src" / "Grüße.txt").write_text("inside")
        (self.root / "escape").symlink_to(self.outside, target_is_directory=True)
        (self.root / "inside").symlink_to(self.root / "src", target_is_directory=True)
        database = SimpleNamespace(
            execute=AsyncMock(), fetchone=AsyncMock(return_value={"path": str(self.root)}),
            close=AsyncMock(),
        )
        database.execute.return_value = database
        self.git_log = AsyncMock(return_value=[])
        self.api = handlers(
            get_db=AsyncMock(return_value=database),
            get_auth=lambda request: None,
            _workspace_visible_to_auth=lambda *_: True,
            _get_workspace_path=AsyncMock(return_value=str(self.root)),
            git_ops=SimpleNamespace(git_log=self.git_log),
            logger=SimpleNamespace(exception=lambda *_: None),
        )

    async def browse(self, path=""):
        return await self.api.list_workspace_files(
            SimpleNamespace(match_info={"id": "test"}, query={"path": path}))

    async def test_inside_directory_and_symlink_remain_browsable(self):
        for path in ("src", "inside"):
            response = await self.browse(path)
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.text)["items"][0]["name"], "Grüße.txt")

    async def test_outside_symlink_cannot_be_browsed(self):
        self.assertEqual((await self.browse("escape")).status, 403)

    async def test_path_traversal_and_absolute_paths_are_rejected(self):
        for path in ("../outside", "..", "src/../../outside", str(self.outside)):
            with self.subTest(path=path):
                self.assertEqual((await self.browse(path)).status, 403)

    async def test_root_listing_does_not_offer_outside_symlink(self):
        response = await self.browse()
        names = {row["name"] for row in json.loads(response.text)["items"]}
        self.assertIn("inside", names)
        self.assertNotIn("escape", names)

    async def test_malformed_git_count_is_a_client_error(self):
        for count in ("abc", "-1", "0"):
            response = await self.api.get_workspace_git_log(
                SimpleNamespace(match_info={"id": "test"}, query={"count": count}))
            self.assertEqual(response.status, 400)
        self.git_log.assert_not_awaited()

    async def test_large_git_count_is_bounded(self):
        response = await self.api.get_workspace_git_log(
            SimpleNamespace(match_info={"id": "test"}, query={"count": "1000000"}))
        self.assertEqual(response.status, 200)
        self.git_log.assert_awaited_once_with(str(self.root), count=100)


if __name__ == "__main__":
    unittest.main()
