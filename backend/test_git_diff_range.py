"""git diff `range` must never reach git as an option (e.g. --output=<file>).

Uses a throwaway repository in a temp dir; never touches the real checkout.
"""
import asyncio
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import git_ops


def _git(cwd, *args):
    subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True,
        env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull},
    )


class RevisionRangeValidationTests(unittest.TestCase):
    def test_accepts_revision_syntax(self):
        for value in (
            "HEAD~1", "HEAD^", "HEAD^!", "main..feature/x", "v1.0...HEAD",
            "abc1234", "origin/main..", "..HEAD", "HEAD@{1}", "release-2.0",
        ):
            self.assertEqual(git_ops.validate_revision_range(value), value)

    def test_rejects_options_and_garbage(self):
        for value in (
            "--output=/tmp/x", "-p", "HEAD..--output=/tmp/x", "--", "..",
            "a..b..c", "HEAD feature", "HEAD\n--output=x", "", "HEAD:secret.txt",
            "x" * 300, "....",
        ):
            with self.assertRaises(git_ops.InvalidRevisionError, msg=value):
                git_ops.validate_revision_range(value)

    def test_safe_revision_for_branch_names(self):
        self.assertTrue(git_ops.is_safe_revision("feature/login-v2"))
        self.assertFalse(git_ops.is_safe_revision("--upload-pack=touch /tmp/pwn"))
        self.assertFalse(git_ops.is_safe_revision("main..evil"))


class GitDiffInjectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        _git(self.repo, "init", "-q")
        _git(self.repo, "config", "user.email", "t@example.invalid")
        _git(self.repo, "config", "user.name", "t")
        (self.repo / "a.txt").write_text("one\n")
        _git(self.repo, "add", "a.txt")
        _git(self.repo, "commit", "-qm", "one")
        (self.repo / "a.txt").write_text("two\n")
        _git(self.repo, "commit", "-qam", "two")

    def test_output_option_is_rejected_and_writes_nothing(self):
        victim = Path(self.tmp.name) / "victim.txt"
        victim.write_text("precious\n")
        with self.assertRaises(git_ops.InvalidRevisionError):
            asyncio.run(git_ops.git_diff(str(self.repo), commit_range=f"--output={victim}"))
        self.assertEqual(victim.read_text(), "precious\n")

    def test_valid_range_still_diffs(self):
        result = asyncio.run(git_ops.git_diff(str(self.repo), commit_range="HEAD~1..HEAD"))
        self.assertIn("+two", result["diff"])
        result = asyncio.run(git_ops.git_diff(str(self.repo), commit_range="HEAD~1"))
        self.assertIn("+two", result["diff"])


if __name__ == "__main__":
    unittest.main()
