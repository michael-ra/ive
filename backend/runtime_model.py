"""Model and effort a CLI session actually used on its latest turn.

The user often switches model inside the terminal (``/model`` in Claude,
``/model`` in Codex). IVE's DB only knows the launch value, so the header
would lie. Both CLIs record the real values in their transcript:

* Claude Code: each ``assistant`` record has ``message.model`` and a
  top-level ``effort`` (2.1.x; ``perTurnEffort`` too).
* Codex: each ``turn_context`` record has ``payload.model`` and
  ``payload.effort``.

Only the tail of the file is read (transcripts grow to many MB), and only
these fields are returned. Read-only.
"""
from __future__ import annotations

import json
import os
from typing import Optional

TAIL_BYTES = 512 * 1024


def _tail_lines(path: str, tail_bytes: int = TAIL_BYTES) -> list[str]:
    with open(path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        start = max(0, size - tail_bytes)
        fh.seek(start)
        data = fh.read()
    lines = data.decode("utf-8", errors="replace").splitlines()
    if start > 0 and lines:
        lines = lines[1:]  # first line is probably cut in half
    return lines


def _with_time(found: dict, rec: dict) -> dict:
    """Attach the record's epoch time (``at``) when it carries a timestamp."""
    ts = rec.get("timestamp")
    if isinstance(ts, str) and ts:
        try:
            from datetime import datetime
            found["at"] = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    return found


def _from_record(rec: dict) -> Optional[dict]:
    if not isinstance(rec, dict):
        return None
    if rec.get("type") == "assistant":
        msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
        model = msg.get("model")
        if not model or model == "<synthetic>":
            return None
        effort = rec.get("effort") or rec.get("perTurnEffort")
        return _with_time({"model": str(model), "effort": str(effort) if effort else None}, rec)
    if rec.get("type") == "turn_context":
        payload = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}
        model = payload.get("model")
        if not model:
            return None
        effort = payload.get("effort")
        return _with_time({"model": str(model), "effort": str(effort) if effort else None}, rec)
    return None


def read_runtime_model(path: str | os.PathLike | None) -> Optional[dict]:
    """Return ``{"model", "effort"}`` from the newest matching record, or None."""
    if not path or not os.path.isfile(path):
        return None
    try:
        lines = _tail_lines(str(path))
    except OSError:
        return None
    for line in reversed(lines):
        line = line.strip()
        if not line or ('"assistant"' not in line and '"turn_context"' not in line):
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        found = _from_record(rec)
        if found:
            return found
    return None
