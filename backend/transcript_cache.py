"""Incremental cache for native CLI transcripts served by the chat view.

The chat view polls ``GET /api/sessions/{id}/messages`` every 1.5 s while a
session works. Long Codex rollouts reach 100-200 MB, so re-reading and
re-normalizing the whole file on every poll blocked the event loop for about a
second and produced ~100 MB of JSON per response.

This module is a layer *around* the existing "read transcript + normalize each
entry" step. It never interprets transcript records itself: callers pass a
``format_fn(raw_msg, raw_idx) -> (row | None, live)`` that does the existing
normalization. The cache only decides which raw records need formatting:

* rows are cached per (session key, path) and validated by inode/size/mtime;
* when a JSONL file only grew, only the appended complete lines are parsed;
* a rewrite (shrunk file, changed head, new inode) rebuilds from scratch under
  a new generation, which invalidates client cursors;
* ``live`` rows (content that depends on files outside the transcript, such as
  background-task output) are re-formatted on every response;
* callers can ask for only the rows after a cursor ``"<generation>:<count>"``;
* optional per-generation normalizer state (``state_factory``) for
  normalization that depends on earlier records (Codex user-row dedup):
  ``format_fn(raw_msg, raw_idx, state)`` while records are added, and
  ``state=None`` when an already listed (live) row is re-formatted. A state
  whose ``needs_rebuild`` turns True makes the cache rebuild the generation
  from the start with ``state_factory(old_state)``.

Everything here is blocking file IO and CPU work: call it via
``asyncio.to_thread``.
"""
from __future__ import annotations

import hashlib
import itertools
import json
import os
import threading
from collections import OrderedDict

_HEAD_BYTES = 4096
_MAX_ENTRIES = 8

# Response trimming. Cached rows keep at most this much of any single string;
# the full record stays on disk and can be fetched per message.
TRIM_STRING_CHARS = 24_000
_TRIM_HEAD_CHARS = 20_000
_TRIM_TAIL_CHARS = 2_000
_IMAGE_DATA_MIN_CHARS = 2_048

_generation = itertools.count(1)


class _Entry:
    __slots__ = (
        "lock", "gen", "ino", "dev", "size", "mtime_ns", "offset", "head_len",
        "head_hash", "raw_count", "rows", "row_ids", "live", "raw_spans", "jsonl",
        "state", "summaries",
    )

    def __init__(self):
        self.lock = threading.Lock()
        self.gen = None
        self.ino = self.dev = self.size = self.mtime_ns = None
        self.offset = 0
        self.head_len = 0
        self.head_hash = b""
        self.raw_count = 0
        self.rows: list[dict] = []
        self.row_ids: dict[str, int] = {}  # row id -> raw index
        self.live: dict[int, tuple[int, object]] = {}  # row pos -> (raw idx, raw msg)
        self.raw_spans: list[tuple[int, int]] = []  # raw idx -> (start, end) byte span
        self.jsonl = True
        self.state = None
        self.summaries: dict[int, dict] = {}  # prefix length -> summarize_rows


_entries: "OrderedDict[tuple, _Entry]" = OrderedDict()
_entries_lock = threading.Lock()


def clear():
    with _entries_lock:
        _entries.clear()


def _entry_for(key) -> _Entry:
    with _entries_lock:
        entry = _entries.get(key)
        if entry is None:
            entry = _Entry()
            _entries[key] = entry
        _entries.move_to_end(key)
        while len(_entries) > _MAX_ENTRIES:
            _entries.popitem(last=False)
        return entry


def _head_hash(path: str, length: int) -> bytes:
    if length <= 0:
        return b""
    with open(path, "rb") as f:
        return hashlib.blake2b(f.read(length), digest_size=16).digest()


def _reset(entry: _Entry, st, jsonl: bool, state_factory=None):
    entry.gen = str(next(_generation))
    entry.state = state_factory(entry.state) if state_factory else None
    entry.ino, entry.dev = st.st_ino, st.st_dev
    entry.size = entry.mtime_ns = None
    entry.offset = 0
    entry.head_len = 0
    entry.head_hash = b""
    entry.raw_count = 0
    entry.rows = []
    entry.row_ids = {}
    entry.live = {}
    entry.raw_spans = []
    entry.jsonl = jsonl
    entry.summaries = {}


def _prefix_summary(entry: _Entry, upto: int):
    if upto <= 0:
        return None
    cached = entry.summaries.get(upto)
    if cached is None:
        if len(entry.summaries) > 32:
            entry.summaries.clear()
        cached = entry.summaries[upto] = summarize_rows(entry.rows[:upto])
    return cached


def _add_raw(entry: _Entry, msg, format_fn):
    idx = entry.raw_count
    entry.raw_count += 1
    # Internally format_fn always takes (msg, idx, state); see _as_stateful.
    row, live = format_fn(msg, idx, entry.state)
    if row is None:
        return
    pos = len(entry.rows)
    entry.rows.append(row)
    row_id = row.get("id")
    if row_id is not None:
        entry.row_ids[str(row_id)] = idx
    if live:
        entry.live[pos] = (idx, msg)


def _read_jsonl_tail(entry: _Entry, path: str, format_fn):
    """Parse complete JSONL records from entry.offset to EOF.

    Mirrors history_reader._read_jsonl_session: blank and undecodable lines
    are skipped. A final line without newline is consumed only when it is
    already valid JSON; otherwise it is retried on the next refresh.
    """
    with open(path, "rb") as f:
        f.seek(entry.offset)
        offset = entry.offset
        for line in f:
            start = offset
            complete = line.endswith(b"\n")
            stripped = line.strip()
            if not stripped:
                if complete:
                    offset += len(line)
                continue
            try:
                msg = json.loads(stripped)
            except ValueError:
                if not complete:
                    break  # still being written; retry later
                offset += len(line)
                continue
            offset += len(line)
            entry.raw_spans.append((start, offset))
            _add_raw(entry, msg, format_fn)
    entry.offset = offset


def _as_stateful(format_fn, state_factory):
    if state_factory is not None:
        return format_fn
    return lambda msg, idx, _state: format_fn(msg, idx)


def _refresh(entry: _Entry, path: str, read_all, format_fn, state_factory=None) -> None:
    st = os.stat(path)
    jsonl = path.endswith(".jsonl") or not path.endswith(".json")
    if (
        entry.gen is not None
        and entry.ino == st.st_ino
        and entry.dev == st.st_dev
        and entry.size == st.st_size
        and entry.mtime_ns == st.st_mtime_ns
    ):
        return

    append_ok = (
        entry.gen is not None
        and jsonl
        and entry.jsonl
        and entry.ino == st.st_ino
        and entry.dev == st.st_dev
        and st.st_size >= entry.offset
        and _head_hash(path, entry.head_len) == entry.head_hash
    )
    if not append_ok:
        _reset(entry, st, jsonl, state_factory)

    if jsonl:
        _read_jsonl_tail(entry, path, format_fn)
        if entry.head_len < _HEAD_BYTES:
            entry.head_len = min(_HEAD_BYTES, entry.offset)
            entry.head_hash = _head_hash(path, entry.head_len)
    else:
        for msg in read_all(path):
            _add_raw(entry, msg, format_fn)
    entry.size = st.st_size
    entry.mtime_ns = st.st_mtime_ns


def _parse_cursor(cursor):
    if not cursor or not isinstance(cursor, str) or ":" not in cursor:
        return None, None
    gen, _, count = cursor.partition(":")
    try:
        return gen, int(count)
    except ValueError:
        return None, None


def get_rows(key, path: str, read_all, format_fn, cursor: str | None = None,
             state_factory=None, tail: int | None = None) -> dict:
    """Return ``{rows, start, updates, cursor, reset, raw_count, base, total}``.

    ``reset`` True: ``rows`` is the complete list and ``start`` is 0 (no usable
    cursor, or the file was rewritten). Otherwise ``rows`` are the rows from
    position ``start`` (the cursor's count) onward and ``updates`` lists
    ``[position, row]`` for live rows before ``start`` that the client
    replaces in place. Positions are exact, so duplicate ids are harmless.

    ``tail``: on a reset, return only the last ``tail`` rows. ``base`` is the
    position of the first returned row (0 when nothing was left out) and
    ``total`` the number of rows; older rows come from :func:`get_older`.
    """
    entry = _entry_for((key, path))
    format_fn = _as_stateful(format_fn, state_factory)
    with entry.lock:
        try:
            if entry.gen is not None and (entry.state is None) != (state_factory is None):
                entry.gen = None  # cached by a caller with the other mode
            _refresh(entry, path, read_all, format_fn, state_factory)
            if getattr(entry.state, "needs_rebuild", False):
                # Normalization of earlier rows changed (see module doc):
                # rebuild once from the start with what the state learned.
                entry.gen = None
                _refresh(entry, path, read_all, format_fn, state_factory)
        except Exception:
            # Leave no half-built state behind; next call rebuilds.
            entry.gen = None
            raise
        rows = entry.rows
        live = entry.live
        gen, count = _parse_cursor(cursor)
        reset = not (gen == entry.gen and count is not None and 0 <= count <= len(rows))

        def fresh(pos):
            raw_idx, msg = live[pos]
            row, _ = format_fn(msg, raw_idx, None)
            return row or rows[pos]

        base = 0
        if reset:
            start = 0
            updates = []
            if tail is not None and 0 <= tail < len(rows):
                base = start = len(rows) - tail
        else:
            start = count
            updates = [[pos, fresh(pos)] for pos in sorted(live) if pos < count]
        out = [fresh(pos) if pos in live else rows[pos] for pos in range(start, len(rows))]
        return {
            "rows": out,
            "start": start,
            "updates": updates,
            "cursor": f"{entry.gen}:{len(rows)}",
            "reset": reset,
            "raw_count": entry.raw_count,
            "base": base,
            "total": len(rows),
            "before": _prefix_summary(entry, base),
        }


def get_older(key, path: str, read_all, format_fn, before: str, limit: int,
              state_factory=None) -> dict:
    """Rows before position ``before`` (``"<generation>:<pos>"``).

    Returns ``{rows, start, cursor, stale}``: up to ``limit`` rows ending at
    ``pos``, with ``start`` the position of the first one. ``stale`` True means
    the generation changed (file rewritten): the client loads the tail again.
    """
    entry = _entry_for((key, path))
    format_fn = _as_stateful(format_fn, state_factory)
    with entry.lock:
        try:
            if entry.gen is not None and (entry.state is None) != (state_factory is None):
                entry.gen = None
            _refresh(entry, path, read_all, format_fn, state_factory)
            if getattr(entry.state, "needs_rebuild", False):
                entry.gen = None
                _refresh(entry, path, read_all, format_fn, state_factory)
        except Exception:
            entry.gen = None
            raise
        gen, pos = _parse_cursor(before)
        rows = entry.rows
        if gen != entry.gen or pos is None or not (0 <= pos <= len(rows)):
            return {"rows": [], "start": 0, "cursor": f"{entry.gen}:{len(rows)}", "stale": True, "before": None}
        start = max(0, pos - max(1, int(limit)))
        live = entry.live

        def fresh(p):
            raw_idx, msg = live[p]
            row, _ = format_fn(msg, raw_idx, None)
            return row or rows[p]

        out = [fresh(p) if p in live else rows[p] for p in range(start, pos)]
        return {
            "rows": out,
            "start": start,
            "cursor": f"{entry.gen}:{len(rows)}",
            "stale": False,
            "before": _prefix_summary(entry, start),
        }


# ─── Summary of rows left out of a tail response ───────────────────────────
# The chat header shows turns and tokens for the whole conversation. When only
# the tail is sent, the client adds this summary of the rows before it. Mirrors
# computeConversationStats / usageTokenBreakdown in ChatPanel.jsx.

def _first_positive(*values):
    for v in values:
        try:
            n = float(v)
        except (TypeError, ValueError):
            continue
        if n > 0 and n == n and n != float("inf"):
            return n
    return None


def _nested(source, *path):
    cur = source
    for k in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return _first_positive(cur)


def _usage_breakdown(row):
    usage = row.get("usage") if isinstance(row.get("usage"), dict) else {}
    inp = _first_positive(usage.get("input_tokens"), usage.get("prompt_tokens"),
                          usage.get("promptTokenCount"), usage.get("inputTokenCount"))
    if inp is None:
        inp = _first_positive(row.get("input_tokens"))
    out = _first_positive(row.get("output_tokens"), usage.get("output_tokens"), usage.get("completion_tokens"),
                          usage.get("candidatesTokenCount"), usage.get("outputTokenCount"))
    cache_creation = _first_positive(row.get("cache_creation_tokens"), usage.get("cache_creation_input_tokens"),
                                     usage.get("cacheCreationInputTokens"))
    direct_read = _first_positive(usage.get("cache_read_input_tokens"), usage.get("cacheReadInputTokens"))
    included_read = _first_positive(
        usage.get("cachedContentTokenCount"),
        _nested(usage, "input_tokens_details", "cached_tokens"),
        _nested(usage, "prompt_tokens_details", "cached_tokens"),
        _nested(usage, "inputTokensDetails", "cachedTokens"),
        _nested(usage, "promptTokensDetails", "cachedTokens"),
        usage.get("cached_tokens"), usage.get("cachedTokens"),
    )
    cache_read = direct_read or included_read or _first_positive(row.get("cache_read_tokens"))
    if inp is not None and direct_read is None and included_read is not None:
        inp = max(0, inp - included_read)
    reported = _first_positive(row.get("token_count"), usage.get("total_tokens"),
                               usage.get("totalTokenCount"), usage.get("token_count"))
    parts = [n for n in (inp, out, cache_creation) if n is not None]
    active = sum(parts) if parts else (0 if cache_read else reported)
    cached = cache_read or 0
    if not active and not cached and not reported:
        return None
    return (active or 0), cached


def _content_blocks(content):
    if isinstance(content, list):
        return content
    if isinstance(content, str):
        t = content.strip()
        if t.startswith("[") or t.startswith("{"):
            try:
                parsed = json.loads(t)
            except ValueError:
                return None
            if isinstance(parsed, list):
                return parsed
            if isinstance(parsed, dict):
                for k in ("content", "parts"):
                    if isinstance(parsed.get(k), list):
                        return parsed[k]
                return [parsed]
    return None


_TOOL_RESULT_TYPES = {"tool_result", "toolresult", "function_response", "functionresponse"}


def _is_user_turn(row) -> bool:
    role = str(row.get("role") or "").lower()
    if role not in ("user", "human"):
        return False
    content = row.get("content")
    if isinstance(content, str) and not content.lstrip().startswith(("[", "{")):
        return True
    blocks = _content_blocks(content)
    if not blocks:
        return True
    if all(isinstance(b, dict) and (str(b.get("type") or "").lower() in _TOOL_RESULT_TYPES
                                    or b.get("tool_result") or b.get("toolResult") or b.get("functionResponse"))
           for b in blocks):
        return False
    if all(isinstance(b, dict) and b.get("type") == "command" and b.get("name") for b in blocks):
        return False
    return True


def summarize_rows(rows) -> dict:
    """Turns and token totals of ``rows`` (the part a tail response left out)."""
    turns = tokens = cached = exact = 0
    est_chars = 0
    seen_ids = set()
    last_key = None
    for row in rows:
        if not isinstance(row, dict):
            continue
        if _is_user_turn(row):
            turns += 1
        content = row.get("content")
        est_chars += len(content) if isinstance(content, str) else 0
        mid = row.get("api_message_id")
        if mid:
            counts = mid not in seen_ids
            seen_ids.add(mid)
            last_key = None
        else:
            usage = row.get("usage")
            key = json.dumps(usage, sort_keys=False) if usage else None
            counts = not (key and key != "{}" and key == last_key)
            last_key = key
        b = _usage_breakdown(row)
        if b and counts:
            tokens += b[0]
            cached += b[1]
            exact += 1
    return {
        "rows": len(rows),
        "user_turns": turns,
        "tokens": int(tokens),
        "cached_tokens": int(cached),
        "exact_count": exact,
        "estimated_tokens": -(-est_chars // 4),
    }


def get_raw_message(key, path: str, row_id: str, read_all):
    """Return ``(raw_msg, raw_idx)`` for a cached row id, re-read from disk."""
    entry = _entry_for((key, path))
    with entry.lock:
        raw_idx = entry.row_ids.get(str(row_id))
        if raw_idx is None:
            return None, None
        if entry.jsonl and raw_idx < len(entry.raw_spans):
            start, end = entry.raw_spans[raw_idx]
            with open(path, "rb") as f:
                f.seek(start)
                data = f.read(end - start)
            try:
                return json.loads(data.strip()), raw_idx
            except ValueError:
                return None, None
    messages = read_all(path)
    if raw_idx < len(messages):
        return messages[raw_idx], raw_idx
    return None, None


# ─── Trimming ──────────────────────────────────────────────────────────────

def _trim_string(value: str) -> str:
    if len(value) <= TRIM_STRING_CHARS:
        return value
    omitted = len(value) - _TRIM_HEAD_CHARS - _TRIM_TAIL_CHARS
    return (
        value[:_TRIM_HEAD_CHARS]
        + f"\n\n[... {omitted:,} characters omitted in the chat view ...]\n\n"
        + value[-_TRIM_TAIL_CHARS:]
    )


def _image_payload_chars(block: dict) -> int:
    btype = str(block.get("type") or "").lower()
    source = block.get("source")
    if isinstance(source, dict) and isinstance(source.get("data"), str):
        if btype in ("image", "document") or source.get("type") == "base64":
            return len(source["data"])
    for key in ("image_url", "url", "data"):
        value = block.get(key)
        if isinstance(value, dict):
            value = value.get("url")
        if isinstance(value, str) and (
            value.startswith("data:") or (btype in ("image", "input_image") and key == "data")
        ):
            return len(value)
    inline = block.get("inlineData") or block.get("inline_data")
    if isinstance(inline, dict) and isinstance(inline.get("data"), str):
        return len(inline["data"])
    return 0


def trim_content(value):
    """Return ``(trimmed, changed)``; shrink huge strings and inline images.

    Unchanged sub-objects are returned as-is (no copy).
    """
    if isinstance(value, str):
        out = _trim_string(value)
        return out, out is not value
    if isinstance(value, list):
        changed = False
        out = []
        for item in value:
            new, c = trim_content(item)
            changed = changed or c
            out.append(new)
        return (out, True) if changed else (value, False)
    if isinstance(value, dict):
        payload = _image_payload_chars(value)
        if payload >= _IMAGE_DATA_MIN_CHARS:
            approx_kb = max(1, payload * 3 // 4 // 1024)
            return {
                "type": "text",
                "text": f"[Image omitted in the chat view (~{approx_kb} KB)]",
                "ive_omitted": "image",
            }, True
        changed = False
        out = {}
        for k, v in value.items():
            new, c = trim_content(v)
            changed = changed or c
            out[k] = new
        return (out, True) if changed else (value, False)
    return value, False
