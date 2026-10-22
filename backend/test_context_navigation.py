"""Observable retrieval limits and exact, targeted recovery; no provider calls."""
import ast
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import urllib.parse
from unittest.mock import Mock

from context_navigation import read, search, MAX_SCAN_BYTES
from context_retrieval import encode, page, search_result, MAX_OUTPUT_CHARS
from session_handoff import write_handoff


def tool(filename, name, api):
    source = Path(__file__).with_name(filename)
    nodes = [n for n in ast.parse(source.read_text()).body if isinstance(n, ast.FunctionDef) and n.name == name]
    namespace = dict(api_call=api, json=json, urllib=urllib, WORKSPACE_ID="w")
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), "exec"), namespace)
    return namespace[name]


class MemoryRetrievalTests(unittest.TestCase):
    def test_real_mcp_handlers_return_small_search_excerpts_with_recall_offsets(self):
        bodies = [{"id": str(i), "name": f"Decision {i}", "content": "before " * 12000 + "ERR-719: exact failure" + " after" * 5000} for i in range(5)]
        response = {"results": {"memory": bodies}, "total": 5}
        for filename in ("mcp_server.py", "worker_mcp_server.py"):
            api = Mock(return_value=response)
            output = tool(filename, "tool_search_memory", api)({"query": "ERR-719", "types": "memory"})
            self.assertLessEqual(len(output), MAX_OUTPUT_CHARS)
            self.assertLess(len(output), len(json.dumps(response)) / 50)
            for hit in json.loads(output)["results"]["memory"]:
                self.assertIn("ERR-719: exact failure", hit["snippet"])
                note = dict(bodies[int(hit["id"])], workspace_id="w")
                api.return_value = [note]
                recalled = json.loads(tool(filename, "tool_recall_memory", api)(
                    {"name": note["name"], "offset": hit["snippet_offset"], "limit": 500}))
                self.assertIn("ERR-719: exact failure", recalled["content"])
                self.assertEqual(recalled["content"], note["content"][recalled["offset"]:recalled["next_offset"]])
                self.assertTrue(all(call.args[0] == "GET" for call in api.call_args_list))

    def test_recall_preserves_workspace_precedence_and_pages_large_unicode_notes(self):
        content = ('präzise 👋 "quoted"\n' + '\x01' * 20) * 300
        for filename in ("mcp_server.py", "worker_mcp_server.py"):
            api = Mock(return_value=[{"name": "Decision", "workspace_id": None, "content": "stale global"},
                                     {"name": "Decision", "workspace_id": "w", "content": content}])
            call = tool(filename, "tool_recall_memory", api)
            collected, offset = "", 0
            while offset is not None:
                output = call({"name": "Decision", "offset": offset, "limit": 1000000})
                self.assertLessEqual(len(output), MAX_OUTPUT_CHARS)
                row = json.loads(output)
                self.assertEqual(row["scope"], "workspace")
                self.assertLessEqual(len(row["content"]), 4000)
                self.assertTrue(row["content"])
                collected += row["content"]; offset = row["next_offset"]
            self.assertEqual(collected, content)

    def test_invalid_pages_and_api_errors_are_explicit(self):
        for offset in (-1, "0", True, 999):
            self.assertFalse(page("small", {}, offset=offset)["ok"])
        for limit in (0, -1, True, "all"):
            self.assertFalse(page("small", {}, limit=limit)["ok"])
        self.assertEqual(json.loads(search_result({"error": "Access denied", "status": 403}, "q"))["status"], 403)

    def test_search_ids_recall_long_named_notes_without_cross_workspace_access(self):
        for filename in ("mcp_server.py", "worker_mcp_server.py"):
            api = Mock(return_value=[{"id": "note-id", "name": "long name " * 100, "workspace_id": "w", "content": "Exact rule."}])
            call = tool(filename, "tool_recall_memory", api)
            self.assertEqual(json.loads(call({"id": "note-id"}))["content"], "Exact rule.")
            self.assertFalse(json.loads(call({"id": "not-in-this-workspace"}))["ok"])

    def test_many_record_types_and_control_characters_still_obey_output_cap(self):
        buckets = {kind: [{"id": str(i), "content": "needle" + '\x01' * 6000} for i in range(5)]
                   for kind in ("memory", "tasks", "files", "messages")}
        result = search_result({"results": buckets, "total": 20}, "needle")
        self.assertLessEqual(len(result), MAX_OUTPUT_CHARS)
        self.assertLessEqual(sum(len(rows) for rows in json.loads(result)["results"].values()), 5)
        self.assertTrue(json.loads(result)["truncated"])


class SnapshotNavigationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_handoff_skill_runs_with_spaces_and_quotes_and_finds_error_in_huge_record(self):
        root = self.root / "handoff space ' quoted"
        record = {"role": "assistant", "content": "irrelevant " * 30000 + "ERR-719: keep exact failure" + " trailing" * 1000}
        handoff = write_handoff(root, {"id": "original"}, [record])
        source = Path(handoff["path"]).parent
        before = hashlib.sha256((source / "transcript.jsonl").read_bytes()).hexdigest()
        executable = source / "skills/ive-context-navigation/scripts/navigate"
        output = subprocess.check_output([str(executable), "search", "ERR-719"], text=True)
        result = json.loads(output); self.assertEqual(len(result["matches"]), 1)
        self.assertIn("ERR-719: keep exact failure", result["matches"][0]["text"])
        self.assertLessEqual(len(output), MAX_OUTPUT_CHARS + 1)
        self.assertLess(len(output), (source / "transcript.jsonl").stat().st_size / 100)
        match = result["matches"][0]
        output = subprocess.check_output([str(executable), "read", "--offset", str(match["offset"]), "--limit", "10000000"], text=True)
        self.assertLessEqual(len(output), MAX_OUTPUT_CHARS + 1)
        self.assertIn("ERR-719: keep exact failure", json.loads(output)["text"])
        self.assertEqual(hashlib.sha256((source / "transcript.jsonl").read_bytes()).hexdigest(), before)
        self.assertLess(handoff["prompt_chars"], 1100)
        self.assertIn("SKILL.md", handoff["prompt"])

    def test_large_unicode_source_reassembles_without_losing_bytes(self):
        body = ('😀ä中 "quote"\n' * 600).encode()
        (self.root / "context.json").write_bytes(body)
        result = b""; offset = 0
        while offset is not None:
            hit = read(self.root, "context.json", offset, 137)
            self.assertLessEqual(len(encode(hit)), MAX_OUTPUT_CHARS)
            self.assertTrue(hit["text"])
            result += hit["text"].encode(); offset = hit["next_offset"]
        self.assertEqual(result, body)
        self.assertEqual(read(self.root, "context.json", 0, 1)["text"], '😀')

    def test_search_crosses_chunk_boundaries_and_continues_without_repeating_hits(self):
        body = "x" * 65534 + "NEEDLE" + ("y" * 700 + "NEEDLE") * 10
        (self.root / "transcript.jsonl").write_text(body)
        matches = []; after = 0
        while after is not None:
            hit = search(self.root, "transcript.jsonl", "NEEDLE", after)
            self.assertLessEqual(len(encode(hit)), MAX_OUTPUT_CHARS)
            matches.extend(row["match_offset"] for row in hit["matches"]); after = hit["next_offset"]
        self.assertEqual(len(matches), 11); self.assertEqual(len(set(matches)), 11)
        self.assertEqual(matches[0], 65534)

    def test_missing_search_is_bounded_and_traversal_and_symlinks_are_rejected(self):
        (self.root / "transcript.jsonl").write_bytes(b"x" * (MAX_SCAN_BYTES + 100))
        result = search(self.root, "transcript.jsonl", "absent")
        self.assertEqual(result["matches"], []); self.assertIsNotNone(result["next_offset"])
        outside = self.root / "private.txt"; outside.write_text("private")
        (self.root / "context.json").symlink_to(outside)
        for name in ("../private.txt", "private.txt", "context.json"):
            with self.assertRaises(ValueError): read(self.root, name)


if __name__ == "__main__":
    unittest.main()
