"""Real Git and history-reader regressions, confined to temporary repositories."""
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest

import git_ops
import history_reader


class RepoReviewTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(prefix="ive-repo-review-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.git("init", "-q")

    def git(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.root, check=True,
            capture_output=True, text=True,
        ).stdout

    def commit(self, message):
        self.git("-c", "user.name=IVE Test", "-c", "user.email=test@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", message)

    async def test_unicode_spaces_quotes_and_newlines_round_trip(self):
        names = ['Grüße.md', 'two words.txt', 'quote".txt', 'line\nbreak.txt', 'old -> new.txt']
        for name in names:
            (self.root / name).write_text("new content\n")
        status = await git_ops.git_status(str(self.root))
        self.assertEqual({row["path"] for row in status["untracked"]}, set(names))
        for row in status["untracked"]:
            diff = await git_ops.git_diff(str(self.root), file_path=row["path"])
            self.assertIn("+new content", diff["diff"])
            await git_ops.git_stage(str(self.root), row["path"])
        self.assertEqual(len((await git_ops.git_status(str(self.root)))["staged"]), len(names))

    async def test_stage_and_unstage_use_literal_file_names(self):
        for name in ("*.txt", "keep.txt", "-flag.txt"):
            (self.root / name).write_text(name)
        await git_ops.git_stage(str(self.root), "*.txt")
        status = await git_ops.git_status(str(self.root))
        self.assertEqual([row["path"] for row in status["staged"]], ["*.txt"])
        await git_ops.git_stage(str(self.root), "-flag.txt")
        await git_ops.git_unstage(str(self.root), "*.txt")
        status = await git_ops.git_status(str(self.root))
        self.assertEqual([row["path"] for row in status["staged"]], ["-flag.txt"])

    async def test_renames_keep_destination_and_do_not_consume_next_file(self):
        (self.root / "before.txt").write_text("original\n")
        self.git("add", ".")
        self.commit("initial")
        self.git("mv", "before.txt", "nachher Grüße.txt")
        (self.root / "z.txt").write_text("untracked\n")
        status = await git_ops.git_status(str(self.root))
        self.assertEqual(status["staged"], [{"path": "nachher Grüße.txt", "status": "R"}])
        self.assertEqual(status["untracked"], [{"path": "z.txt", "status": "?"}])

    async def test_commit_subject_separator_does_not_corrupt_author(self):
        (self.root / "one.txt").write_text("one\n")
        self.git("add", ".")
        self.commit("fix | preserve context")
        rows = await git_ops.git_log(str(self.root))
        self.assertEqual(rows[0]["message"], "fix | preserve context")
        self.assertEqual(rows[0]["author"], "IVE Test")
        window = await git_ops.git_log_window(str(self.root))
        self.assertEqual(window[0]["message"], "fix | preserve context")
        self.assertEqual(window[0]["author"], "IVE Test")
        self.assertEqual(window[0]["insertions"], 1)

    async def test_non_repository_is_reported(self):
        with TemporaryDirectory() as outside:
            self.assertFalse((await git_ops.git_status(outside))["is_git_repo"])


class HistoryJsonTests(unittest.TestCase):
    def test_supported_json_shapes_and_invalid_roots(self):
        messages = [{"role": "user", "content": "hello"}, {"role": "assistant", "content": "hi"}]
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "session.json"
            for data in (messages, {"messages": messages}, {"turns": messages}):
                with self.subTest(data=data):
                    path.write_text(json.dumps(data))
                    self.assertEqual(history_reader.read_session_messages(str(path)), messages)
            for data in (None, 7, "bad", {"messages": "bad"}):
                with self.subTest(data=data):
                    path.write_text(json.dumps(data))
                    self.assertEqual(history_reader.read_session_messages(str(path)), [])


if __name__ == "__main__":
    unittest.main()
