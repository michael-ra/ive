"""Read existing CLI sessions from ~/.claude/projects/ and ~/.gemini/tmp/ for import."""

import hashlib
import json
import logging
import os
from pathlib import Path

from config import CLAUDE_HOME
from cli_profiles import PROFILES, get_profile

logger = logging.getLogger(__name__)


def list_projects() -> list[dict]:
    """List projects from all CLI session directories."""
    results = []
    results.extend(_list_claude_projects())
    results.extend(_list_gemini_projects())
    return results


def _list_claude_projects() -> list[dict]:
    """List Claude Code projects from ~/.claude/projects/."""
    projects_dir = CLAUDE_HOME / "projects"
    if not projects_dir.exists():
        return []

    results = []
    for entry in sorted(projects_dir.iterdir()):
        if not entry.is_dir():
            continue

        dir_name = entry.name
        project_path = "/" + dir_name.lstrip("-").replace("-", "/")

        sessions = list_project_sessions(entry)
        if sessions:
            results.append({
                "dir_name": dir_name,
                "project_path": project_path,
                "session_count": len(sessions),
                "sessions": sessions,
                "cli_type": "claude",
            })

    return results


def _list_gemini_projects() -> list[dict]:
    """List Gemini CLI projects from ~/.gemini/tmp/*/chats/."""
    gemini_home = Path(os.path.expanduser(get_profile("gemini").home_dir))
    tmp_dir = gemini_home / "tmp"
    if not tmp_dir.exists():
        return []

    results = []
    for hash_dir in sorted(tmp_dir.iterdir()):
        if not hash_dir.is_dir():
            continue
        chats_dir = hash_dir / "chats"
        if not chats_dir.exists():
            continue

        sessions = _list_gemini_sessions(chats_dir)
        if sessions:
            # Try to reverse the hash to a workspace path by checking known workspaces
            project_path = _reverse_gemini_hash(hash_dir.name) or f"(gemini:{hash_dir.name[:12]})"
            results.append({
                "dir_name": hash_dir.name,
                "project_path": project_path,
                "session_count": len(sessions),
                "sessions": sessions,
                "cli_type": "gemini",
            })

    return results


def _list_gemini_sessions(chats_dir: Path) -> list[dict]:
    """List Gemini session files in a chats directory."""
    sessions = []
    for f in sorted(chats_dir.glob("session-*.json")):
        stat = f.stat()
        sessions.append({
            "session_id": f.stem,
            "file": str(f),
            "size_bytes": stat.st_size,
            "modified": stat.st_mtime,
        })
    return sessions


def _reverse_gemini_hash(hash_name: str) -> str | None:
    """Try to match a Gemini project hash back to a workspace path.

    Gemini uses SHA256(abs_path) as the directory name. We check known
    workspace paths to see if any match.
    """
    try:
        from db import get_db
        import asyncio
        loop = asyncio.get_event_loop()
        if loop.is_running():
            return None  # Can't do sync DB call from async context
        async def _check():
            db = await get_db()
            try:
                cur = await db.execute("SELECT path FROM workspaces")
                rows = await cur.fetchall()
                for row in rows:
                    ws_path = os.path.abspath(row["path"])
                    if hashlib.sha256(ws_path.encode()).hexdigest() == hash_name:
                        return ws_path
            finally:
                await db.close()
            return None
        return loop.run_until_complete(_check())
    except Exception:
        return None


def list_project_sessions(project_dir: Path) -> list[dict]:
    """List sessions within a Claude Code project directory."""
    sessions = []

    # Look for session files — Claude stores them as JSONL
    for f in sorted(project_dir.glob("*.jsonl")):
        session_id = f.stem
        stat = f.stat()
        sessions.append({
            "session_id": session_id,
            "file": str(f),
            "size_bytes": stat.st_size,
            "modified": stat.st_mtime,
        })

    # Also check for session directories
    for d in sorted(project_dir.iterdir()):
        if d.is_dir() and not d.name.startswith("."):
            # Check for conversation.jsonl or similar
            for pattern in ("*.jsonl", "conversation.json"):
                for f in d.glob(pattern):
                    stat = f.stat()
                    sessions.append({
                        "session_id": d.name,
                        "file": str(f),
                        "size_bytes": stat.st_size,
                        "modified": stat.st_mtime,
                    })

    return sessions


def read_session_messages(file_path: str) -> list[dict]:
    """Read messages from a CLI session file (JSONL or JSON)."""
    if file_path.endswith(".json") and not file_path.endswith(".jsonl"):
        return _read_gemini_session(file_path)
    return _read_jsonl_session(file_path)


def _read_jsonl_session(file_path: str) -> list[dict]:
    """Read messages from a Claude Code JSONL session file."""
    messages = []
    try:
        with open(file_path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                    messages.append(msg)
                except json.JSONDecodeError:
                    continue
    except (OSError, IOError) as e:
        logger.error(f"Failed to read session file {file_path}: {e}")
    return messages


def _read_gemini_session(file_path: str) -> list[dict]:
    """Read messages from a Gemini CLI JSON session file."""
    messages = []
    try:
        with open(file_path, "r") as f:
            data = json.loads(f.read())
        # Gemini stores messages in a "messages" or "turns" array
        turns = data.get("messages") or data.get("turns") or []
        if isinstance(turns, list):
            for turn in turns:
                if isinstance(turn, dict) and turn.get("role"):
                    messages.append(turn)
        # If the file is just a flat array of messages
        if not messages and isinstance(data, list):
            messages = [m for m in data if isinstance(m, dict) and m.get("role")]
    except (OSError, IOError, json.JSONDecodeError) as e:
        logger.error(f"Failed to read Gemini session file {file_path}: {e}")
    return messages


def normalize_jsonl_entry(entry: dict) -> tuple[str, object] | None:
    """Extract (role, content) from a Claude Code JSONL entry or flat message.

    Returns None for non-conversation rows (metadata, file snapshots, etc.).
    `content` may be a string or a list of content blocks — callers that
    need to store it as text should json.dumps() lists themselves.
    """
    # Claude Code JSONL format: {type, message: {role, content}, ...}
    if "message" in entry and isinstance(entry["message"], dict):
        entry_type = entry.get("type")
        if entry_type not in ("user", "assistant", "human"):
            return None
        inner = entry["message"]
        role = inner.get("role", entry_type)
        return role, inner.get("content", "")

    # Flat shape: already {role, content}
    role = entry.get("role", entry.get("type", "unknown"))
    if role not in ("user", "assistant", "human"):
        return None
    return role, entry.get("content", "")


def export_session_as_markdown(messages: list[dict]) -> str:
    """Convert a list of session messages to readable markdown.

    Accepts both flat DB rows ({role, content}) and raw Claude Code JSONL
    entries, which nest the actual message under a `message` key and
    interleave non-conversation records like `file-history-snapshot`.
    """
    lines = ["# Claude Code Session Export\n"]

    for msg in messages:
        normalized = normalize_jsonl_entry(msg)
        if normalized is None:
            continue
        role, content = normalized

        # DB rows from import_history store list-shaped content as a JSON
        # string. Reparse so the block renderer below can format it properly.
        if isinstance(content, str) and content.startswith("["):
            try:
                parsed = json.loads(content)
                if isinstance(parsed, list):
                    content = parsed
            except json.JSONDecodeError:
                pass

        if isinstance(content, list):
            # Content blocks
            parts = []
            for block in content:
                if isinstance(block, dict):
                    btype = block.get("type", "")
                    if btype == "text":
                        parts.append(block.get("text", ""))
                    elif btype == "thinking":
                        parts.append(f"<details><summary>Thinking</summary>\n\n{block.get('thinking', '')}\n\n</details>")
                    elif btype == "tool_use":
                        tool = block.get("name", "tool")
                        inp = json.dumps(block.get("input", {}), indent=2)
                        parts.append(f"**{tool}**\n```json\n{inp}\n```")
                    elif btype == "tool_result":
                        result = block.get("content", "")
                        if isinstance(result, list):
                            result = "\n".join(
                                c.get("text", "") for c in result if isinstance(c, dict)
                            )
                        parts.append(f"```\n{result}\n```")
                elif isinstance(block, str):
                    parts.append(block)
            content = "\n\n".join(parts)

        if role in ("human", "user"):
            lines.append(f"## User\n\n{content}\n")
        elif role in ("assistant",):
            lines.append(f"## Assistant\n\n{content}\n")

    return "\n".join(lines)
