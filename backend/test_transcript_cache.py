import json
import os
import tempfile
import unittest

import transcript_cache as tc
from history_reader import read_session_messages


def fmt(msg, idx):
    if not isinstance(msg, dict) or msg.get("skip"):
        return None, False
    return {"id": msg.get("id") or f"msg-{idx}", "content": msg.get("text", "")}, bool(msg.get("live"))


class TranscriptCacheTests(unittest.TestCase):
    def setUp(self):
        tc.clear()
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "t.jsonl")
        self.calls = []

    def fmt(self, msg, idx):
        self.calls.append(idx)
        return fmt(msg, idx)

    def write(self, *records, mode="a", raw=None):
        with open(self.path, mode) as f:
            if raw is not None:
                f.write(raw)
            for r in records:
                f.write(json.dumps(r) + "\n")

    def rows(self, cursor=None):
        return tc.get_rows("s", self.path, read_session_messages, self.fmt, cursor=cursor)

    def test_matches_full_reader_and_appends_incrementally(self):
        self.write({"text": "a"}, {"skip": 1}, {"text": "b"}, mode="w", raw="\nnot json\n")
        first = self.rows("")
        self.assertTrue(first["reset"])
        expected = [r for r in (fmt(m, i)[0] for i, m in enumerate(read_session_messages(self.path))) if r]
        self.assertEqual(first["rows"], expected)
        self.assertEqual(first["raw_count"], 3)
        self.calls.clear()
        self.write({"text": "c"})
        delta = self.rows(first["cursor"])
        self.assertFalse(delta["reset"])
        self.assertEqual(delta["start"], 2)
        self.assertEqual(delta["rows"], [{"id": "msg-3", "content": "c"}])
        self.assertEqual(self.calls, [3], "only the appended record is formatted")
        unchanged = self.rows(delta["cursor"])
        self.assertEqual(unchanged["rows"], [])
        self.assertEqual(unchanged["cursor"], delta["cursor"])

    def test_tail_returns_last_rows_and_older_pages(self):
        self.write(*[{"text": f"r{i}"} for i in range(10)], mode="w")
        first = tc.get_rows("s", self.path, read_session_messages, self.fmt, cursor="", tail=3)
        self.assertTrue(first["reset"])
        self.assertEqual([r["content"] for r in first["rows"]], ["r7", "r8", "r9"])
        self.assertEqual((first["base"], first["start"], first["total"]), (7, 7, 10))
        self.assertEqual(first["before"]["rows"], 7)
        gen = first["cursor"].split(":")[0]
        older = tc.get_older("s", self.path, read_session_messages, self.fmt, before=f"{gen}:7", limit=4)
        self.assertFalse(older["stale"])
        self.assertEqual(older["start"], 3)
        self.assertEqual([r["content"] for r in older["rows"]], ["r3", "r4", "r5", "r6"])
        self.assertEqual(older["before"]["rows"], 3)
        oldest = tc.get_older("s", self.path, read_session_messages, self.fmt, before=f"{gen}:3", limit=4)
        self.assertEqual((oldest["start"], len(oldest["rows"]), oldest["before"]), (0, 3, None))
        # An incremental poll with tail still returns only what is new.
        self.write({"text": "r10"})
        delta = tc.get_rows("s", self.path, read_session_messages, self.fmt, cursor=first["cursor"], tail=3)
        self.assertFalse(delta["reset"])
        self.assertEqual((delta["start"], delta["base"]), (10, 0))
        self.assertEqual([r["content"] for r in delta["rows"]], ["r10"])
        # Stale generation after a rewrite.
        self.write({"text": "z"}, mode="w")
        stale = tc.get_older("s", self.path, read_session_messages, self.fmt, before=f"{gen}:3", limit=4)
        self.assertTrue(stale["stale"])

    def test_tail_larger_than_transcript_returns_everything(self):
        self.write({"text": "a"}, {"text": "b"}, mode="w")
        first = tc.get_rows("s", self.path, read_session_messages, self.fmt, cursor="", tail=50)
        self.assertEqual((first["base"], len(first["rows"]), first["before"]), (0, 2, None))

    def test_summarize_rows_counts_turns_and_usage_once(self):
        rows = [
            {"role": "user", "content": "hi"},
            {"role": "user", "content": json.dumps([{"type": "tool_result", "content": "x"}])},
            {"role": "user", "content": json.dumps([{"type": "command", "name": "/model"}])},
            {"role": "assistant", "content": "a", "api_message_id": "m1",
             "usage": {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 100}},
            {"role": "assistant", "content": "b", "api_message_id": "m1",
             "usage": {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 100}},
        ]
        out = tc.summarize_rows(rows)
        self.assertEqual(out["user_turns"], 1)
        self.assertEqual((out["tokens"], out["cached_tokens"], out["exact_count"]), (15, 100, 1))

    def test_partial_last_line_waits_until_complete(self):
        self.write({"text": "a"}, mode="w", raw="")
        with open(self.path, "a") as f:
            f.write('{"text": "b"')
        first = self.rows("")
        self.assertEqual([r["content"] for r in first["rows"]], ["a"])
        with open(self.path, "a") as f:
            f.write(', "x": 1}\n')
        delta = self.rows(first["cursor"])
        self.assertEqual([r["content"] for r in delta["rows"]], ["b"])

    def test_rewrite_starts_a_new_generation(self):
        self.write({"text": "a"}, {"text": "b"}, mode="w")
        first = self.rows("")
        self.write({"text": "z"}, mode="w")
        again = self.rows(first["cursor"])
        self.assertTrue(again["reset"])
        self.assertEqual([r["content"] for r in again["rows"]], ["z"])
        self.assertNotEqual(again["cursor"].split(":")[0], first["cursor"].split(":")[0])

    def test_live_rows_are_reformatted_and_sent_as_updates(self):
        self.write({"text": "task", "live": True}, {"text": "b"}, mode="w")
        first = self.rows("")
        self.calls.clear()
        delta = self.rows(first["cursor"])
        self.assertEqual(delta["updates"], [[0, {"id": "msg-0", "content": "task"}]])
        self.assertEqual(self.calls, [0])

    def test_raw_message_by_row_id(self):
        self.write({"text": "a"}, {"id": "x9", "text": "b"}, mode="w")
        self.rows()
        msg, idx = tc.get_raw_message("s", self.path, "x9", read_session_messages)
        self.assertEqual((msg["text"], idx), ("b", 1))

    def test_gemini_json_is_reread_on_change(self):
        path = os.path.join(self.dir.name, "session-1.json")
        with open(path, "w") as f:
            json.dump({"messages": [{"text": "a"}]}, f)
        r = tc.get_rows("s", path, read_session_messages, fmt, cursor="")
        with open(path, "w") as f:
            json.dump({"messages": [{"text": "a"}, {"text": "bb"}]}, f)
        r2 = tc.get_rows("s", path, read_session_messages, fmt, cursor=r["cursor"])
        self.assertTrue(r2["reset"])
        self.assertEqual(len(r2["rows"]), 2)


class TrimTests(unittest.TestCase):
    def test_trims_long_strings_and_images_without_copying_small_content(self):
        small = [{"type": "text", "text": "hi"}]
        out, changed = tc.trim_content(small)
        self.assertIs(out, small)
        self.assertFalse(changed)
        big = [
            {"type": "tool_result", "content": "x" * 100_000},
            {"type": "image", "source": {"type": "base64", "data": "A" * 50_000}},
        ]
        out, changed = tc.trim_content(big)
        self.assertTrue(changed)
        self.assertLess(len(out[0]["content"]), tc.TRIM_STRING_CHARS + 200)
        self.assertIn("characters omitted", out[0]["content"])
        self.assertEqual(out[1]["ive_omitted"], "image")
        self.assertEqual(len(big[0]["content"]), 100_000, "input untouched")


class ListMessagesPayloadTests(unittest.TestCase):
    def setUp(self):
        tc.clear()

    def test_payload_matches_uncached_formatting(self):
        import server
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "s.jsonl")
            records = [
                {"type": "user", "message": {"role": "user", "content": "hello"}, "timestamp": "t1"},
                {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "y" * 30_000}]}},
            ]
            with open(path, "w") as f:
                for r in records:
                    f.write(json.dumps(r) + "\n")
            body = json.loads(server._transcript_rows_payload(path, "sess", None))
            expected = [server._format_transcript_message(m, i, "sess")[0] for i, m in enumerate(records)]
            self.assertEqual(body, [e for e in expected if e])
            self.assertTrue(body[1].get("content_truncated"))
            inc = json.loads(server._transcript_rows_payload(path, "sess", ""))
            self.assertEqual(inc["rows"], body)
            self.assertEqual(set(inc), {"rows", "start", "updates", "cursor", "reset"})

    def test_background_task_prefilter_keeps_matches(self):
        import server
        self.assertIsNone(server._parse_background_task_start_text("plain output " * 1000))
        started = server._parse_background_task_start_text(
            "Command running in background with ID: b1. Output is being written to: /tmp/tasks/b1.output")
        self.assertEqual(started["task_id"], "b1")
        done = server._parse_background_task_start_text("Done (ID: b2). Output: ok")
        self.assertEqual(done["status"], "completed")


def _ri_user(text):
    return {"type": "response_item", "payload": {"type": "message", "role": "user",
                                                 "content": [{"type": "input_text", "text": text}]}}


def _um(text):
    return {"type": "event_msg", "payload": {"type": "item_completed", "item": {
        "type": "UserMessage", "content": [{"type": "text", "text": text}]}}}


def _old_um(text):
    return {"type": "event_msg", "payload": {"type": "user_message", "message": text}}


def _asst(text):
    return {"type": "response_item", "payload": {"type": "message", "role": "assistant",
                                                 "content": [{"type": "output_text", "text": text}]}}


class CodexIncrementalNormalizationTests(unittest.TestCase):
    """The cached chat rows equal a whole-transcript normalize_history_entries
    after every appended chunk (Codex user-row dedup across chunk borders)."""

    def setUp(self):
        tc.clear()
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "rollout.jsonl")
        open(self.path, "w").close()

    @staticmethod
    def fmt(msg, idx, state):
        from history_adapters import normalize_history_entry_standalone
        normalized = state.feed(msg) if state is not None else normalize_history_entry_standalone(msg)
        if normalized is None:
            return None, False
        return {"id": f"msg-{idx}", "role": normalized[0], "content": normalized[1]}, False

    def append(self, *records):
        with open(self.path, "a") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")

    def rows(self, cursor):
        from history_adapters import HistoryNormalizer
        return tc.get_rows("codex", self.path, read_session_messages, self.fmt, cursor=cursor,
                           state_factory=HistoryNormalizer.next_generation)

    def expected(self):
        from history_adapters import normalize_history_entries
        return [{"id": f"msg-{i}", "role": r, "content": c}
                for i, r, c in normalize_history_entries(read_session_messages(self.path))]

    def follow(self, chunks):
        """Poll after every chunk like the chat view; return the client's rows."""
        client, cursor = [], ""
        for chunk in chunks:
            self.append(*chunk)
            out = self.rows(cursor)
            if out["reset"]:
                client = list(out["rows"])
            else:
                self.assertEqual(out["start"], len(client))
                client += out["rows"]
            cursor = out["cursor"]
            self.assertEqual(client, self.expected())
        return client

    def test_user_event_after_fallback_rows_rebuilds_to_one_user_row(self):
        client = self.follow([
            [_ri_user("<environment_context>x</environment_context>"), _ri_user("hello")],
            [_um("hello"), _asst("hi there")],
        ])
        self.assertEqual([(r["role"], r["content"]) for r in client],
                         [("user", "hello"), ("assistant", [{"type": "text", "text": "hi there"}])])

    def test_two_event_shapes_split_across_chunks_stay_one_row(self):
        client = self.follow([
            [_um("first"), _asst("a")],
            [_old_um("second")],
            [_um("second")],
            [_asst("b")],
        ])
        self.assertEqual([r["role"] for r in client], ["user", "assistant", "user", "assistant"])

    def test_rollout_without_user_events_keeps_fallback_rows(self):
        client = self.follow([
            [_ri_user("# AGENTS.md instructions for /x\n\nbe nice"), _ri_user("real prompt")],
            [_asst("ok")],
            [_ri_user("next")],
        ])
        self.assertEqual([(r["role"], r["content"]) for r in client][0], ("user", "real prompt"))
        self.assertEqual([r["role"] for r in client], ["user", "assistant", "user"])


if __name__ == "__main__":
    unittest.main()
