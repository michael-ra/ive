import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from project_finder import ProjectIndex
from route_guards import owner_only


class ProjectFinderTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.index = ProjectIndex(self.home)

    def project(self, name, *, description="", marker="package.json"):
        path = self.home / name
        path.mkdir(parents=True)
        if marker == ".git":
            (path / marker).mkdir()
        else:
            (path / marker).write_text(json.dumps({"name": path.name, "description": description}))
        return path

    def test_natural_language_matches_project_not_generic_app(self):
        target = self.project("Projects/acme", description="Digital customer loyalty cards")
        self.project("Projects/another-app")
        result = self.index.search("Ich möchte die Acme App bearbeiten")
        self.assertEqual([item["path"] for item in result["matches"]], [str(target)])

    def test_same_named_projects_remain_choices(self):
        self.project("Code/ive-team", marker=".git")
        self.project("Code/ive.dev", marker="index.html")
        review = self.home / "IVE UI review"
        review.mkdir()
        (review / "README.md").write_text("# IVE notes")
        self.project("demo-site")
        result = self.index.search("I want to work on IVE")
        self.assertEqual([item["name"] for item in result["matches"]], ["ive-team", "ive.dev"])

    def test_descriptions_are_searchable_without_running_manifests(self):
        path = self.project("tools/billing", description="Invoices for customers")
        self.assertEqual(self.index.search("edit customer invoices")["matches"][0]["path"], str(path))

    def test_known_workspace_is_deduplicated_and_keeps_id(self):
        path = self.project("customer-site")
        known = [{"id": "ws-1", "name": "Acme Website", "path": str(path)}]
        result = self.index.search("Acme website", known)
        self.assertEqual(len(result["matches"]), 1)
        self.assertEqual(result["matches"][0]["workspace_id"], "ws-1")

    def test_unicode_and_hyphens(self):
        target = self.project("Jäger-Portal")
        self.assertEqual(self.index.search("Ich will am Jaeger Portal arbeiten")["matches"][0]["path"], str(target))

    def test_skips_dependencies_hidden_directories_and_symlinks(self):
        self.project("node_modules/ive")
        self.project(".private/ive")
        self.project("Library/ive")
        with TemporaryDirectory() as outside:
            target = Path(outside) / "ive"
            target.mkdir()
            (target / "package.json").write_text("{}")
            (self.home / "ive-link").symlink_to(target, target_is_directory=True)
            self.assertEqual(self.index.search("IVE")["matches"], [])

    def test_skips_symlinked_metadata(self):
        root = self.project("ive", marker=".git")
        with TemporaryDirectory() as outside:
            secret = Path(outside) / "secret"
            secret.write_text("# ConfidentialCustomer")
            (root / "README.md").symlink_to(secret)
            self.assertEqual(self.index.search("ConfidentialCustomer")["matches"], [])

    def test_bounds_and_empty_query(self):
        self.project("one/project")
        limited = ProjectIndex(self.home, max_dirs=1)
        self.assertTrue(limited.search("project")["needs_project_name"])
        self.assertTrue(limited.search("one")["partial"])
        for query in ["", "a", "a" * 241]:
            with self.assertRaises(ValueError):
                self.index.search(query)

    def test_malformed_metadata_does_not_break_results(self):
        path = self.project("ive")
        (path / "package.json").write_text("invalid json")
        self.assertEqual(self.index.search("IVE")["matches"][0]["path"], str(path))

    def test_reading_does_not_modify_project_files(self):
        path = self.project("ive")
        before = (path / "package.json").read_bytes()
        self.index.search("IVE")
        self.assertEqual((path / "package.json").read_bytes(), before)


class ProjectSearchAuthorizationTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_owner_can_enter_scanner(self):
        handler = AsyncMock(return_value="ok")
        guarded = owner_only(handler)
        missing = await guarded({})
        self.assertEqual(missing.status, 401)
        # A Full-mode invite still must not expose the host's other folders.
        with patch("route_guards._emit_violation") as audit:
            joiner = await guarded({"auth": SimpleNamespace(is_owner=False, mode="full")})
            audit.assert_called_once()
        self.assertEqual(joiner.status, 403)
        handler.assert_not_called()
        self.assertEqual(await guarded({"auth": SimpleNamespace(is_owner=True)}), "ok")


if __name__ == "__main__":
    unittest.main()
