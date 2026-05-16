"""Codex session file and resume helpers."""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Callable

from cli_features import Feature
from cli_profiles import get_profile


def codex_home(home: str | Path | None = None) -> Path:
    """Return the active Codex home directory."""
    if home:
        return Path(home)
    return Path(os.environ.get("CODEX_HOME") or os.path.expanduser(get_profile("codex").home_dir))


def snapshot_codex_sessions(workspace_path: str, home: str | Path | None = None) -> set[str]:
    """Get set of existing Codex rollout files.

    Codex stores resumable sessions under ~/.codex/sessions/YYYY/MM/DD as
    rollout-...-<uuid>.jsonl. Use absolute paths because files span nested
    date directories.
    """
    sessions_dir = codex_home(home) / "sessions"
    if not sessions_dir.exists():
        return set()
    return {str(f) for f in sessions_dir.glob("**/rollout-*.jsonl")}


def codex_session_id_from_rollout(path: Path | str) -> str | None:
    """Extract the Codex UUID suffix from a rollout JSONL filename."""
    parts = Path(path).stem.split("-")
    if len(parts) < 6:
        return None
    candidate = "-".join(parts[-5:])
    try:
        uuid.UUID(candidate)
        return candidate
    except ValueError:
        return None


def codex_thread_name(native_session_id: str, home: str | Path | None = None) -> str | None:
    """Look up a Codex thread name from session_index.jsonl if available."""
    index_path = codex_home(home) / "session_index.jsonl"
    if not index_path.exists():
        return None
    try:
        lines = index_path.read_text().splitlines()
    except Exception:
        return None
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("id") == native_session_id:
            return entry.get("thread_name") or None
    return None


def set_native_resume_feature(session_obj, workspace_path: str, native_sid: str,
                              gemini_resolver: Callable[[str, str], str | None]) -> bool:
    """Set the profile-native resume argument for a stored native session ID."""
    if not native_sid:
        return False
    if session_obj.profile.id == "gemini":
        resume_arg = gemini_resolver(workspace_path, native_sid)
        if not resume_arg:
            return False
        session_obj.set(Feature.RESUME_ID, resume_arg)
        return True
    session_obj.set(Feature.RESUME_ID, native_sid)
    return True
