"""aiohttp server — REST routes + WebSocket with PTY terminal support."""

import asyncio
import codecs
import datetime
import hmac
import json
import logging
import uuid

import aiohttp
from aiohttp import web

from config import (HOST, PORT, VERSION, AVAILABLE_MODELS, PERMISSION_MODES, EFFORT_LEVELS,
                     COMMANDER_SYSTEM_PROMPT, COMMANDER_DISALLOWED_TOOLS,
                     TESTER_SYSTEM_PROMPT, TESTER_COMMANDER_SYSTEM_PROMPT,
                     DOCUMENTOR_SYSTEM_PROMPT, DOCUMENTOR_ALLOWED_TOOLS,
                     PLANNER_SYSTEM_PROMPT, WORKER_SYSTEM_PROMPT_FRAGMENT,
                     MCP_SERVER_PATH, MCP_CONFIG_DIR,
                     GEMINI_MODELS, GEMINI_APPROVAL_MODES, CLI_TYPES)
from cli_session import UnifiedSession
from cli_features import Feature
from cli_profiles import get_profile
from history_reader import (list_projects, read_session_messages,
                              export_session_as_markdown, normalize_jsonl_entry)
from db import init_db, get_db
from pty_manager import PTYManager
from output_capture import OutputCaptureProcessor
import plugin_manager
import experimental
from event_bus import bus
from commander_events import CommanderEvent, build_event_catalog
import ticket_indexer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

pty_mgr = PTYManager()
capture_proc = OutputCaptureProcessor()
ws_clients: set[web.WebSocketResponse] = set()

# ─── Multiplayer presence ────────────────────────────────────────────────
# Maps client_id -> { ws, name, color, viewing_session }
ws_peers: dict[str, dict] = {}

# Tracks which Playwright preview ids each WS is subscribed to, so we can
# unsubscribe everything on disconnect (otherwise headless pages leak).
ws_preview_subs: dict[int, set[str]] = {}


def _ws_subscriber_id(ws) -> str:
    """Pick a stable subscriber id for a ws — prefer the multiplayer
    client_id from `hello`, fall back to the ws object id."""
    for cid, info in ws_peers.items():
        if info.get("ws") is ws:
            return cid
    return f"ws-{id(ws)}"


# ─── Helpers ──────────────────────────────────────────────────────────────

from pathlib import Path as _Path


def _get_project_dir(workspace_path: str) -> _Path:
    """Get the Claude Code project directory for a workspace path."""
    normalized = workspace_path.replace("/", "-")
    return _Path.home() / ".claude" / "projects" / normalized


async def _get_code_bash_allowlist() -> list[str]:
    """Owner-configured Bash glob allowlist for Code-mode joiners.

    Stored in app_settings as comma-separated key 'code_mode_bash_allowlist'.
    Empty (default) means Bash is fully off in Code mode.
    """
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT value FROM app_settings WHERE key = 'code_mode_bash_allowlist'"
        )
        row = await cur.fetchone()
    finally:
        await db.close()
    if not row or not row["value"]:
        return []
    return [p.strip() for p in row["value"].split(",") if p.strip()]


def _snapshot_jsonl_files(workspace_path: str) -> set[str]:
    """Get set of existing .jsonl filenames in the project directory."""
    project_dir = _get_project_dir(workspace_path)
    if not project_dir.exists():
        return set()
    return {f.name for f in project_dir.glob("*.jsonl")}


def _get_gemini_chats_dir(workspace_path: str) -> _Path:
    """Get the Gemini CLI chats directory for a workspace path.

    Gemini uses SHA256(absolute_path) as the project dir name under ~/.gemini/tmp/.
    """
    import hashlib
    abs_path = os.path.abspath(workspace_path)
    project_hash = hashlib.sha256(abs_path.encode()).hexdigest()
    return _Path.home() / ".gemini" / "tmp" / project_hash / "chats"


def _snapshot_gemini_sessions(workspace_path: str) -> set[str]:
    """Get set of existing Gemini session .json filenames."""
    chats_dir = _get_gemini_chats_dir(workspace_path)
    if not chats_dir.exists():
        return set()
    return {f.name for f in chats_dir.glob("session-*.json")}


def _resolve_gemini_resume_index(workspace_path: str, stem: str) -> str | None:
    """Resolve a Gemini session filename stem to a --resume argument.

    Gemini --resume accepts 'latest' or an index (from --list-sessions).
    Indices shift as new sessions are added. We sort session files by mtime
    descending and find the index of our target file.

    Returns the index as a string, or None if not found.
    """
    chats_dir = _get_gemini_chats_dir(workspace_path)
    if not chats_dir.exists():
        return None
    target_file = chats_dir / f"{stem}.json"
    if not target_file.exists():
        return None
    # Sort by modification time, newest first (matches Gemini's --list-sessions order)
    files = sorted(chats_dir.glob("session-*.json"), key=lambda f: f.stat().st_mtime, reverse=True)
    for idx, f in enumerate(files):
        if f.name == target_file.name:
            return str(idx)
    return None


async def detect_gemini_session(session_id: str, workspace_path: str,
                                 pre_existing_files: set[str] | None = None):
    """Detect which Gemini session file belongs to this PTY.

    Similar to detect_claude_session but for Gemini's .json format.
    Stores the filename stem (e.g. 'session-2026-04-08T...') in native_session_id.
    Retries up to 20s to handle slow CLI startup.
    """
    target_file = None
    # Retry: check every 2s for up to 20s (hooks may resolve it first)
    for attempt in range(10):
        await _asyncio.sleep(2)

        # Check if hooks already resolved the native ID
        db_check = await get_db()
        try:
            cur = await db_check.execute(
                "SELECT native_session_id FROM sessions WHERE id = ?", (session_id,))
            row = await cur.fetchone()
            if row and row["native_session_id"]:
                logger.info(f"Gemini session {session_id[:8]}: native ID already resolved by hooks")
                return
        finally:
            await db_check.close()

        chats_dir = _get_gemini_chats_dir(workspace_path)
        if not chats_dir.exists():
            continue

        if pre_existing_files is not None:
            current = {f.name for f in chats_dir.glob("session-*.json")}
            new_files = current - pre_existing_files
            if len(new_files) == 1:
                target_file = chats_dir / new_files.pop()
            elif len(new_files) > 1:
                candidates = [chats_dir / f for f in new_files]
                target_file = max(candidates, key=lambda f: f.stat().st_mtime)

        if target_file:
            break

    if not target_file:
        logger.info(f"Gemini session {session_id[:8]}: file detection failed after retries")
        return

    # Read the session ID and slug from the file
    try:
        data = json.loads(target_file.read_text())
        gemini_sid = data.get("sessionId", target_file.stem)
    except Exception as e:
        logger.debug("Gemini session file parse fallback: %s", e)
        gemini_sid = target_file.stem

    # Store the filename stem (used for --resume later)
    file_stem = target_file.stem

    db = await get_db()
    try:
        await db.execute(
            "UPDATE sessions SET native_session_id = ? WHERE id = ?",
            (file_stem, session_id),
        )
        await db.commit()
    finally:
        await db.close()

    logger.info(f"Detected Gemini session: {session_id[:8]} → {file_stem}")


async def detect_claude_session(session_id: str, workspace_path: str,
                                 force_rename: bool = False,
                                 pre_existing_files: set[str] | None = None):
    """Detect which Claude Code conversation file belongs to this session.

    If pre_existing_files is provided, we diff against it to find the NEW file
    that was created by this specific session (avoids cross-session confusion
    when multiple sessions share a workspace).

    Retries up to 20s to handle slow CLI startup. If the hook-based capture
    (in hooks.py) already resolved the native ID, this function will detect
    that and skip file scanning — but still proceed to extract the slug for
    session renaming.
    """
    target_file = None
    existing_sid = None
    existing_name = None

    # Retry: check every 2s for up to 20s
    for attempt in range(10):
        await _asyncio.sleep(2)

        project_dir = _get_project_dir(workspace_path)
        if not project_dir.exists():
            continue

        # Check current DB state (hooks may have resolved the native ID already)
        db_check = await get_db()
        try:
            cur = await db_check.execute(
                "SELECT native_session_id, name FROM sessions WHERE id = ?", (session_id,))
            row = await cur.fetchone()
            existing_sid = row["native_session_id"] if row else None
            existing_name = row["name"] if row else None
        finally:
            await db_check.close()

        # 1. If we already have a session ID (from hooks or prior run), use that file
        if existing_sid:
            candidate = project_dir / f"{existing_sid}.jsonl"
            if candidate.exists():
                target_file = candidate
                break  # Got it — proceed to slug extraction

        # 2. Diff against snapshot to find the NEW file
        if not target_file and pre_existing_files is not None:
            current_files = {f.name for f in project_dir.glob("*.jsonl")}
            new_files = current_files - pre_existing_files
            if len(new_files) == 1:
                target_file = project_dir / new_files.pop()
                break
            elif len(new_files) > 1:
                candidates = [project_dir / f for f in new_files]
                target_file = max(candidates, key=lambda f: f.stat().st_mtime)
                break

        # 3. Last resort: newest file (only if no snapshot available)
        if not target_file and pre_existing_files is None:
            jsonl_files = sorted(project_dir.glob("*.jsonl"),
                                 key=lambda f: f.stat().st_mtime, reverse=True)
            if jsonl_files:
                target_file = jsonl_files[0]
                break

    if not target_file:
        logger.info(f"Claude session {session_id[:8]}: file detection failed after retries")
        return

    native_sid = target_file.stem

    # Read the slug from the session file
    slug = None
    try:
        with open(target_file, "r") as f:
            lines = f.readlines()
        for line in reversed(lines):
            try:
                entry = json.loads(line)
                if entry.get("slug"):
                    slug = entry["slug"]
                    break
            except json.JSONDecodeError:
                continue
    except Exception:
        pass

    if not slug and not native_sid:
        return

    # Store in DB
    db = await get_db()
    try:
        updates = ["native_session_id = ?"]
        values = [native_sid]
        new_name = None
        if slug:
            updates.append("native_slug = ?")
            values.append(slug)
            # Update session name if: force_rename, or still has default name
            if force_rename or not existing_name or existing_name.startswith("Session "):
                updates.append("name = ?")
                values.append(slug)
                new_name = slug
        values.append(session_id)
        await db.execute(
            f"UPDATE sessions SET {', '.join(updates)} WHERE id = ?",
            values,
        )
        await db.commit()
        if new_name:
            await broadcast({
                "type": "session_renamed",
                "session_id": session_id,
                "name": new_name,
                "native_session_id": native_sid,
                "native_slug": slug,
            })
    finally:
        await db.close()

    logger.info(f"Detected Claude session: {session_id} → {native_sid} ({slug})")


def _snapshot_files_for_detection(cli_type: str, workspace_path: str) -> set[str] | None:
    """Snapshot session files before PTY start (for new-file detection)."""
    if cli_type == "claude":
        return _snapshot_jsonl_files(workspace_path)
    elif cli_type == "gemini":
        return _snapshot_gemini_sessions(workspace_path)
    return None


def _schedule_session_detection(cli_type: str, session_id: str, workspace_path: str,
                                pre_files: set[str] | None):
    """Schedule async session detection after PTY starts."""
    if cli_type == "claude":
        _asyncio.ensure_future(detect_claude_session(
            session_id, workspace_path, pre_existing_files=pre_files))
    elif cli_type == "gemini":
        _asyncio.ensure_future(detect_gemini_session(
            session_id, workspace_path, pre_existing_files=pre_files))


async def get_session_config(session_id: str) -> dict | None:
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT s.*, w.path AS workspace_path
               FROM sessions s
               JOIN workspaces w ON s.workspace_id = w.id
               WHERE s.id = ?""",
            (session_id,),
        )
        row = await cur.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()


async def broadcast(event: dict):
    data = json.dumps(event)
    dead = []
    for ws in ws_clients:
        try:
            await ws.send_str(data)
        except (ConnectionResetError, ConnectionError, RuntimeError):
            dead.append(ws)
    for ws in dead:
        ws_clients.discard(ws)


# ─── PTY output batching ──────────────────────────────────────────────────
# Batch PTY output per session into ~16ms windows (one frame) before sending
# over WebSocket. This prevents Ink's full-screen TUI renders from being
# split across multiple messages, which causes garbled terminal output.

import asyncio as _asyncio
import time as _time

_output_buffers: dict[str, list[bytes]] = {}
_output_timers: dict[str, _asyncio.TimerHandle] = {}
# Per-session incremental UTF-8 decoder — holds incomplete codepoints across
# flushes so a multi-byte char split between chunks doesn't render as U+FFFD.
_output_decoders: dict[str, codecs.IncrementalDecoder] = {}
# Per-session bytes held back at flush time because they look like the start
# of an incomplete ANSI escape sequence. Prepended to the next flush.
_output_held_bytes: dict[str, bytes] = {}
# Per-session PTY start timestamp. During the first _INITIAL_COLLAPSE_MS
# after spawn, _flush_output looks for a full-screen-clear (\x1b[2J) in
# the accumulated buffer and drops bytes before it. This collapses the
# Claude Code "render banner once at default size, then SIGWINCH from
# fit-addon, then redraw at real size" sequence into a single render —
# the user no longer sees both banners in scrollback.
_pty_start_time: dict[str, float] = {}
_INITIAL_COLLAPSE_MS = 1500


def mark_pty_started(session_id: str) -> None:
    """Begin the initial-render collapse window for `session_id`."""
    _pty_start_time[session_id] = _time.time()


def _split_ansi_tail(data: bytes) -> tuple[bytes, bytes]:
    """Split data into (safe_to_emit, hold_for_next_flush).

    Detects an incomplete ANSI escape sequence at the tail of `data` and
    returns the trailing partial bytes separately so they can be combined
    with the next chunk. xterm.js's parser resets per write(), so emitting
    half of a CSI ends up rendering the leading bytes as garbled state and
    the trailing bytes as literal text — visible as the position drift in
    streamed Claude output.
    """
    if not data:
        return b"", b""
    last_esc = data.rfind(b"\x1b")
    if last_esc == -1:
        return data, b""
    rest = data[last_esc + 1:]
    if not rest:
        return data[:last_esc], data[last_esc:]
    first = rest[0]
    if first == 0x5B:  # CSI: ESC [ <params 0x30-0x3F>* <inter 0x20-0x2F>* <final 0x40-0x7E>
        for b in rest[1:]:
            if 0x40 <= b <= 0x7E:
                return data, b""  # complete CSI
            if not (0x20 <= b <= 0x3F):
                return data, b""  # malformed; let xterm handle
        return data[:last_esc], data[last_esc:]  # incomplete CSI
    if first == 0x5D:  # OSC: ESC ] ... <BEL or ST>
        if 0x07 in rest or b"\x1b\\" in rest:
            return data, b""
        return data[:last_esc], data[last_esc:]
    if first == 0x4F:  # SS3: ESC O <one byte>
        return (data, b"") if len(rest) >= 2 else (data[:last_esc], data[last_esc:])
    # Other ESC + 1 byte sequences are already complete (rest[0] is the byte)
    return data, b""


def _schedule_flush(session_id: str):
    if session_id in _output_timers:
        return  # Already scheduled
    loop = _asyncio.get_event_loop()
    _output_timers[session_id] = loop.call_later(0.016, lambda: _asyncio.ensure_future(_flush_output(session_id)))

# ─── PTY output flush ─────────────────────────────────────────────────
# Session state detection (idle/prompting/working) is now handled by CLI
# lifecycle hooks (see hooks.py). This function only batches and broadcasts
# raw PTY output for xterm display.


async def _flush_output(session_id: str):
    _output_timers.pop(session_id, None)
    chunks = _output_buffers.pop(session_id, [])
    held = _output_held_bytes.pop(session_id, b"")
    if not chunks and not held:
        return

    # If new chunks arrived, combine with held bytes and re-split the tail.
    # If only held bytes remain (timer fired with no new output), force-emit
    # them — they're either a genuinely partial sequence Claude never finished
    # or held bytes from a prior flush whose follow-up never came.
    if chunks:
        raw = held + b"".join(chunks)
    else:
        raw = held

    # During the initial-render window, drop everything before the LAST
    # "fresh-frame boundary" so Claude's pre-resize banner doesn't pile
    # up in xterm's scrollback alongside the post-resize one.
    #
    # Claude Code does NOT emit \x1b[2J (verified empirically — count=0
    # across a full startup capture). Its rendering strategy is cursor-
    # home (\x1b[H) followed by paint-over. So \x1b[H is the only
    # available frame boundary; collapsing to the last one drops the
    # earlier render's bytes before they reach xterm.
    #
    # We still also accept \x1b[2J as a boundary for tools that DO emit
    # it (Gemini and any non-Claude future CLI). After the window
    # expires, both sequences pass through untouched — clears outside
    # the startup window are legitimate.
    start_t = _pty_start_time.get(session_id)
    if start_t is not None:
        if (_time.time() - start_t) * 1000 < _INITIAL_COLLAPSE_MS:
            # Take whichever comes later (the actual most-recent frame
            # boundary). Position 0 doesn't count — that's the start of
            # a single-render stream and there's nothing to drop.
            last_2j = raw.rfind(b"\x1b[2J")
            last_h  = raw.rfind(b"\x1b[H")
            last_boundary = max(last_2j, last_h)
            if last_boundary > 0:
                raw = raw[last_boundary:]
                # Reset the UTF-8 decoder — we may have just thrown
                # away continuation bytes it was waiting on.
                _output_decoders.pop(session_id, None)
        else:
            _pty_start_time.pop(session_id, None)

    if chunks:
        safe, hold = _split_ansi_tail(raw)
    else:
        safe, hold = raw, b""

    if hold:
        _output_held_bytes[session_id] = hold
        # Schedule a stale flush so genuinely-partial sequences eventually
        # reach the terminal even if no further output arrives.
        if session_id not in _output_timers:
            loop = _asyncio.get_event_loop()
            _output_timers[session_id] = loop.call_later(
                0.1, lambda: _asyncio.ensure_future(_flush_output(session_id)))

    if not safe:
        return

    decoder = _output_decoders.get(session_id)
    if decoder is None:
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        _output_decoders[session_id] = decoder
    text = decoder.decode(safe)
    if not text:
        return
    msg = json.dumps({"session_id": session_id, "type": "output", "data": text})
    dead = []
    for ws in ws_clients:
        try:
            await ws.send_str(msg)
        except (ConnectionResetError, ConnectionError, RuntimeError):
            dead.append(ws)
    for ws in dead:
        ws_clients.discard(ws)

# ─── Trust prompt auto-acceptance ─────────────────────────────────────
# Both CLIs show interactive trust prompts for untrusted workspace folders.
# These fire BEFORE hooks are initialized, so hooks can't detect them.
# We detect the patterns in raw PTY output and auto-accept.
_TRUST_PATTERNS = [
    b"trust this folder",           # Claude: "Yes, I trust this folder"
    b"I trust this folder",         # Claude alternative
    b"safety check",                # Claude: "Quick safety check" header
    b"Itrustthisfolder",            # Claude TUI (spaces stripped in raw bytes)
    b"safetycheck",                 # Claude TUI (spaces stripped)
    b"Yes, I trust",                # Claude with spaces
    b"Trust folder",                # Gemini: "1. Trust folder"
    b"Trust parent folder",         # Gemini: "2. Trust parent folder"
    b"Enter to select",             # Gemini: generic selection prompt
]
_trust_handled: dict[str, float] = {}  # Track last auto-accept time per session (allow multiple)
_gemini_ready: set[str] = set()  # Sessions where Gemini TUI is ready for input


def _check_auto_trust(session_id: str, data: bytes):
    """Auto-accept trust prompts by sending Enter/1 to the PTY.

    Handles MULTIPLE prompts per session (Gemini has folder trust + MCP trust).
    Rate-limited to max once per 2 seconds per session to avoid loops.
    """
    import time as _time
    last = _trust_handled.get(session_id, 0)
    if _time.monotonic() - last < 2.0:
        return  # rate limit — don't spam Enter
    # Strip ANSI sequences for pattern matching (raw PTY output is full of them)
    import re as _re
    _ansi_bytes_re = _re.compile(rb'\x1b\[[0-9;]*[a-zA-Z~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]')
    stripped = _ansi_bytes_re.sub(b'', data)
    text_lower = stripped.lower()
    raw_lower = data.lower()
    for pattern in _TRUST_PATTERNS:
        pat_lower = pattern.lower()
        if pat_lower in text_lower or pat_lower in raw_lower:
            _trust_handled[session_id] = _time.monotonic()
            # Schedule the auto-accept slightly delayed so the UI renders first
            async def _auto_accept():
                await _asyncio.sleep(0.5)
                if pty_mgr.is_alive(session_id):
                    # Gemini uses numbered menu (send "1\r"), Claude uses Enter ("\r")
                    if b"Trust folder" in data or b"Trust parent" in data:
                        pty_mgr.write(session_id, b"1\r")  # Gemini: select option 1
                    else:
                        pty_mgr.write(session_id, b"\r")    # Claude: confirm default
                    logger.info(f"Auto-accepted trust prompt for session {session_id[:8]}")
            _asyncio.ensure_future(_auto_accept())
            return


async def handle_pty_output(session_id: str, data: bytes):
    _check_auto_trust(session_id, data)
    # Track Gemini readiness for deferred prompt injection
    if session_id not in _gemini_ready:
        if b"Type your message" in data or b"YOLO" in data:
            _gemini_ready.add(session_id)
    if session_id not in _output_buffers:
        _output_buffers[session_id] = []
    _output_buffers[session_id].append(data)
    _schedule_flush(session_id)


async def handle_pty_exit(session_id: str, code: int):
    from hooks import cleanup_session
    cleanup_session(session_id)
    await broadcast({"session_id": session_id, "type": "exit", "code": code})
    # Session Advisor: analyze session quality in background
    try:
        from session_advisor import analyze_session, clear_intent
        _fire_and_forget(analyze_session(session_id))
        clear_intent(session_id)
    except Exception:
        logger.debug("Session advisor cleanup skipped for %s", session_id[:8])
    # Skill Suggester: cleanup session state
    try:
        from skill_suggester import clear_session as clear_skill_session
        clear_skill_session(session_id)
    except Exception:
        logger.debug("Skill suggester cleanup skipped for %s", session_id[:8])
    # Auto-distill: extract reusable artifact on clean exit
    try:
        _fire_and_forget(_maybe_auto_distill(session_id, code))
    except Exception:
        logger.debug("Auto-distill skipped for %s", session_id[:8])
    # Auto-knowledge: extract durable codebase insights into workspace_knowledge
    try:
        _fire_and_forget(_maybe_auto_extract_knowledge(session_id, code))
    except Exception:
        logger.debug("Auto-knowledge skipped for %s", session_id[:8])
    # Auto-summary: generate short session summary on exit
    try:
        _fire_and_forget(_maybe_auto_summarize(session_id))
    except Exception:
        logger.debug("Auto-summary skipped for %s", session_id[:8])
    # Cleanup module-level per-session state to prevent memory leaks
    _gemini_ready.discard(session_id)
    _trust_handled.pop(session_id, None)
    _input_bufs.pop(session_id, None)
    _session_turns.pop(session_id, None)
    _input_esc.pop(session_id, None)
    _output_decoders.pop(session_id, None)
    _output_held_bytes.pop(session_id, None)
    _pty_start_time.pop(session_id, None)
    _session_workspace.pop(session_id, None)


async def _maybe_auto_distill(session_id: str, exit_code: int):
    """Auto-distill a session on clean exit if experimental flag is enabled.

    Gate conditions:
      - exit_code == 0 (clean exit)
      - experimental_auto_distill == "on"
      - 5+ conversation turns
      - session_type is worker or default (not commander/tester/documentor)
      - not a worktree/branch session
    """
    if exit_code != 0:
        return

    db = await get_db()
    try:
        # Check experimental flag
        cur = await db.execute(
            "SELECT value FROM app_settings WHERE key = 'experimental_auto_distill'"
        )
        row = await cur.fetchone()
        if not row or row["value"] != "on":
            return

        # Get session info
        cur = await db.execute(
            """SELECT s.*, w.path AS workspace_path
               FROM sessions s
               LEFT JOIN workspaces w ON s.workspace_id = w.id
               WHERE s.id = ?""",
            (session_id,),
        )
        sess = await cur.fetchone()
        if not sess:
            return
        sess = dict(sess)

        # Gate: skip special session types
        if sess.get("session_type") in ("commander", "tester", "documentor"):
            return

        # Gate: skip worktree/branch sessions
        if sess.get("worktree"):
            return

        # Gate: check conversation length (need 5+ turns)
        messages = []
        native_sid = sess.get("native_session_id")
        workspace_path = sess.get("workspace_path")
        if native_sid and workspace_path:
            jsonl_file = _get_project_dir(workspace_path) / f"{native_sid}.jsonl"
            if jsonl_file.exists():
                messages = read_session_messages(str(jsonl_file))

        if not messages:
            cur = await db.execute(
                "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at",
                (session_id,),
            )
            rows = await cur.fetchall()
            messages = [dict(r) for r in rows]

        if len(messages) < 5:
            return

        # Auto-detect best artifact type based on conversation content
        conversation = _format_conversation_for_distill(messages)
        if not conversation or len(conversation.strip()) < 100:
            return

        artifact_type = _detect_distill_type(conversation)
        cli = sess.get("cli_type") or "claude"
        session_name = sess.get("name") or session_id[:8]
    finally:
        await db.close()

    # Build and launch distill job
    prompt_template = _DISTILL_PROMPTS[artifact_type]
    prompt = prompt_template.format(
        conversation=conversation,
        instructions="This is an automatic distill — extract the single most reusable artifact from the session.",
    )

    job_id = str(uuid.uuid4())
    _background_jobs[job_id] = {
        "type": "distill",
        "status": "queued",
        "session_id": session_id,
        "artifact_type": artifact_type,
    }

    import asyncio as _asyncio
    _asyncio.ensure_future(_run_background_llm_job(
        job_id=job_id,
        job_type="distill",
        cli=cli,
        model=None,  # use CLI default (cheapest)
        prompt=prompt,
        extra={
            "session_id": session_id,
            "session_name": session_name,
            "artifact_type": artifact_type,
            "auto": True,
        },
    ))
    logger.info("Auto-distill started for session %s (type=%s)", session_id[:8], artifact_type)


def _detect_distill_type(conversation: str) -> str:
    """Heuristic to pick the best artifact type for auto-distill.

    Analyzes conversation text with keyword counting — no LLM call needed.
    """
    text_lower = conversation.lower()

    # Count correction indicators
    corrections = sum(1 for phrase in [
        "no, ", "not that", "actually,", "instead,", "wrong", "don't do",
        "stop ", "that's not", "let me rephrase", "i meant",
    ] if phrase in text_lower)

    # Count multi-step workflow indicators
    steps = sum(1 for phrase in [
        "step 1", "step 2", "first,", "then,", "next,", "finally,",
        "after that", "now let's", "phase 1", "phase 2",
    ] if phrase in text_lower)

    # Count convention/pattern indicators
    patterns = sum(1 for phrase in [
        "always ", "never ", "convention", "pattern", "style ",
        "architecture", "structure", "naming", "format",
    ] if phrase in text_lower)

    if corrections >= 3:
        return "guideline"  # corrections → extract rules to prevent recurrence
    elif steps >= 4:
        return "cascade"    # multi-step → extract as reusable cascade
    elif patterns >= 3:
        return "guideline"  # conventions → extract as guideline
    else:
        return "prompt"     # default → extract as reusable prompt template


_KNOWLEDGE_EXTRACTION_PROMPT = """You are analyzing a coding session to extract durable knowledge about THIS specific codebase that will help future agents working on it.

<conversation>
{conversation}
</conversation>

Extract ONLY high-signal, non-obvious insights about this codebase. Skip generic advice, single-task details, and anything obvious from reading the code.

GOOD examples (extract these):
- "Database migrations must run via /api/admin/migrate, NOT django-admin migrate — legacy auth wrapper does access checks"
- "REST APIs use snake_case but WebSocket payloads use camelCase — historical reason, do not normalize"
- "tools/ session_id is the hook id, not the PTY session id — they are not interchangeable"
- "All async DB calls must use get_db() then close in finally — pool will leak otherwise"

BAD examples (do NOT extract):
- "Use async/await for async functions"
- "The user wanted to add a button"
- "Tests should pass before merging"
- "Read the file before editing it"

Categories:
- architecture — structural decisions and the reason behind them
- convention — naming, formatting, organization rules specific to this repo
- gotcha — surprising behavior, footguns, things that look wrong but are correct
- pattern — recurring code patterns specific to this project
- api — internal API contracts, request/response shapes, auth flow
- setup — build, install, dev environment quirks

Return JSON in this exact shape:
{{
  "entries": [
    {{"category": "gotcha", "content": "...", "scope": "backend/auth"}},
    ...
  ]
}}

Rules:
- Return 0 to 5 entries — be ruthless about quality. {{"entries": []}} is the right answer if nothing meets the bar.
- "scope" is optional but encouraged — a directory, file, or subsystem name.
- Each "content" must be 1-3 sentences, specific, and actionable for a future agent.
- Return ONLY the JSON object. No markdown fences, no commentary."""


async def _maybe_auto_extract_knowledge(session_id: str, exit_code: int):
    """Auto-extract durable codebase insights from a session into workspace_knowledge.

    Gate conditions:
      - exit_code == 0 (clean exit OR idle-trigger from Stop hook)
      - workspace.auto_knowledge_enabled == 1
      - 5+ conversation turns
      - session_type is worker or default (skip commander/tester/documentor)
      - not a worktree/branch session
      - no auto-extract from this session in the last 60 minutes (idle debounce)
    """
    if exit_code != 0:
        return

    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT s.*, w.path AS workspace_path, w.auto_knowledge_enabled
               FROM sessions s
               LEFT JOIN workspaces w ON s.workspace_id = w.id
               WHERE s.id = ?""",
            (session_id,),
        )
        sess = await cur.fetchone()
        if not sess:
            return
        sess = dict(sess)

        if not sess.get("auto_knowledge_enabled"):
            return

        if sess.get("session_type") in ("commander", "tester", "documentor"):
            return

        if sess.get("worktree"):
            return

        ws_id = sess.get("workspace_id")
        if not ws_id:
            return

        # Idle debounce: if Stop fired, fired again, and fired again in a
        # long-running session, only let the LLM pass run at most once per
        # hour per session. The clean-exit path naturally only fires once
        # so this is effectively a no-op there.
        cur = await db.execute(
            """SELECT 1 FROM workspace_knowledge
               WHERE contributed_by = ?
                 AND created_at >= datetime('now', '-60 minutes')
               LIMIT 1""",
            (f"auto:{session_id}",),
        )
        if await cur.fetchone():
            return

        messages = []
        native_sid = sess.get("native_session_id")
        workspace_path = sess.get("workspace_path")
        if native_sid and workspace_path:
            jsonl_file = _get_project_dir(workspace_path) / f"{native_sid}.jsonl"
            if jsonl_file.exists():
                messages = read_session_messages(str(jsonl_file))

        if not messages:
            cur = await db.execute(
                "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at",
                (session_id,),
            )
            rows = await cur.fetchall()
            messages = [dict(r) for r in rows]

        if len(messages) < 5:
            return

        conversation = _format_conversation_for_distill(messages, max_chars=40_000)
        if not conversation or len(conversation.strip()) < 200:
            return

        cli = sess.get("cli_type") or "claude"
    finally:
        await db.close()

    prompt = _KNOWLEDGE_EXTRACTION_PROMPT.format(conversation=conversation)
    try:
        from llm_router import llm_call_json
        result = await llm_call_json(cli=cli, model=None, prompt=prompt, timeout=180)
    except Exception as e:
        logger.warning("Auto-knowledge extraction LLM call failed for %s: %s", session_id[:8], e)
        return

    entries = result.get("entries") if isinstance(result, dict) else None
    if not isinstance(entries, list) or not entries:
        return

    valid_categories = {"architecture", "convention", "gotcha", "pattern", "api", "setup"}
    saved_ids: list[str] = []
    db = await get_db()
    try:
        for e in entries[:5]:
            if not isinstance(e, dict):
                continue
            content = (e.get("content") or "").strip()
            category = (e.get("category") or "").strip().lower()
            scope = (e.get("scope") or "").strip()
            if not content or category not in valid_categories:
                continue
            entry_id = str(uuid.uuid4())
            await db.execute(
                """INSERT INTO workspace_knowledge (id, workspace_id, category, content, scope, contributed_by)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (entry_id, ws_id, category, content, scope, f"auto:{session_id}"),
            )
            saved_ids.append(entry_id)
        if not saved_ids:
            return
        await db.commit()

        ph = ",".join("?" * len(saved_ids))
        cur = await db.execute(
            f"SELECT * FROM workspace_knowledge WHERE id IN ({ph})", saved_ids,
        )
        saved_rows = [dict(r) for r in await cur.fetchall()]
    finally:
        await db.close()

    try:
        from embedder import embed_knowledge
        for row in saved_rows:
            try:
                await embed_knowledge(row)
            except Exception:
                pass
    except Exception:
        pass

    try:
        from event_bus import bus
        from commander_events import CommanderEvent
        await bus.emit(
            CommanderEvent.KNOWLEDGE_CONTRIBUTED,
            {
                "session_id": session_id,
                "workspace_id": ws_id,
                "count": len(saved_ids),
                "auto": True,
            },
            source="auto_extract",
        )
    except Exception:
        logger.exception("Failed to emit KNOWLEDGE_CONTRIBUTED event")

    logger.info(
        "Auto-knowledge extracted %d entries from session %s",
        len(saved_ids), session_id[:8],
    )


async def _maybe_auto_summarize(session_id: str):
    """Generate a 1-2 sentence summary for a session on exit.

    Gate: session must have 3+ conversation turns and no existing summary.
    Digest-aware: uses task_summary/discoveries as seed context when available.
    """
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT s.*, w.path AS workspace_path
               FROM sessions s
               LEFT JOIN workspaces w ON s.workspace_id = w.id
               WHERE s.id = ?""",
            (session_id,),
        )
        sess = await cur.fetchone()
        if not sess:
            return
        sess = dict(sess)

        # Skip if summary already exists
        if sess.get("summary"):
            return

        # Fetch conversation messages (JSONL first, then DB)
        messages = []
        native_sid = sess.get("native_session_id")
        workspace_path = sess.get("workspace_path")
        if native_sid and workspace_path:
            jsonl_file = _get_project_dir(workspace_path) / f"{native_sid}.jsonl"
            if jsonl_file.exists():
                messages = read_session_messages(str(jsonl_file))

        if not messages:
            cur2 = await db.execute(
                "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at",
                (session_id,),
            )
            rows = await cur2.fetchall()
            messages = [dict(r) for r in rows]

        if len(messages) < 3:
            return

        conversation = _format_conversation_for_distill(messages, max_chars=20_000)
        if not conversation or len(conversation.strip()) < 50:
            return

        # Fetch session digest for extra context if available
        digest_context = ""
        try:
            cur3 = await db.execute(
                "SELECT task_summary, discoveries, decisions FROM session_digests WHERE session_id = ?",
                (session_id,),
            )
            digest = await cur3.fetchone()
            if digest:
                parts = []
                if digest["task_summary"]:
                    parts.append(f"Task: {digest['task_summary']}")
                if digest["discoveries"] and digest["discoveries"] != "[]":
                    parts.append(f"Discoveries: {digest['discoveries']}")
                if digest["decisions"] and digest["decisions"] != "[]":
                    parts.append(f"Decisions: {digest['decisions']}")
                if parts:
                    digest_context = "\n\nWorker digest:\n" + "\n".join(parts)
        except Exception:
            pass

        cli = sess.get("cli_type") or "claude"
    finally:
        await db.close()

    # Generate summary via LLM
    from llm_router import llm_call
    try:
        summary = await llm_call(
            cli=cli,
            prompt=(
                "Summarize this coding session in 1-2 concise sentences. "
                "Focus on what was accomplished or attempted. Be specific about the task, not generic.\n\n"
                f"Session transcript:\n{conversation}{digest_context}"
            ),
            system="You are a concise summarizer. Return ONLY the 1-2 sentence summary, nothing else. No quotes, no prefix.",
            timeout=30,
        )
        summary = summary.strip()
        if not summary or len(summary) < 10:
            return

        db2 = await get_db()
        try:
            await db2.execute(
                "UPDATE sessions SET summary = ? WHERE id = ?",
                (summary, session_id),
            )
            await db2.commit()
        finally:
            await db2.close()

        await broadcast({
            "type": "session_summary",
            "session_id": session_id,
            "summary": summary,
        })
        logger.info("Auto-summary generated for session %s", session_id[:8])
    except Exception as e:
        logger.warning("Auto-summary failed for %s: %s", session_id[:8], e)


async def _maybe_unarchive_on_input(session_id: str):
    """Auto-unarchive a session when the user sends new input to it."""
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT archived FROM sessions WHERE id = ?", (session_id,)
        )
        row = await cur.fetchone()
        if row and row["archived"]:
            await db.execute(
                "UPDATE sessions SET archived = 0 WHERE id = ?", (session_id,)
            )
            await db.commit()
            await broadcast({
                "type": "session_archived",
                "session_id": session_id,
                "archived": 0,
            })
            logger.info("Auto-unarchived session %s on new input", session_id[:8])
    finally:
        await db.close()


# ─── Background task registry (prevents GC of fire-and-forget tasks) ──────
_bg_tasks: set[_asyncio.Task] = set()

def _fire_and_forget(coro):
    """Schedule a coroutine as a background task without risk of GC."""
    task = _asyncio.create_task(coro)
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


# ─── Branch session creation ─────────────────────────────────────────────

async def _open_original_as_tab(branch_session_id: str, original_native_id: str):
    """After /branch, open the ORIGINAL conversation as a new Commander tab.

    The current PTY (branch_session_id) is now running the branch.  We create
    a sibling session for the original conversation so the user can see both
    side-by-side.  The new session gets --resume <original_native_id> when its
    PTY starts.
    """
    db = await get_db()
    try:
        # Look up the branch session (was the parent before /branch)
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (branch_session_id,))
        parent = await cur.fetchone()
        if not parent:
            return
        parent = dict(parent)

        # Guard: don't create a duplicate if we already have a session for this native ID
        cur = await db.execute(
            "SELECT id FROM sessions WHERE native_session_id = ? AND id != ?",
            (original_native_id, branch_session_id),
        )
        if await cur.fetchone():
            return

        # Create session for the original conversation
        import uuid as _uuid
        new_id = str(_uuid.uuid4())
        original_name = parent["name"] or "Session"
        # Rename the branch session to indicate it's a branch
        branch_name = f"{original_name} (branch)"
        await db.execute(
            "UPDATE sessions SET name = ? WHERE id = ?",
            (branch_name, branch_session_id),
        )

        # ── Resolve branch group (peer linkage) ─────────────────────────
        from hooks import _generate_branch_label
        if parent.get("branch_group"):
            branch_group = parent["branch_group"]
            branch_label = parent.get("branch_label", "")
        else:
            branch_group = str(_uuid.uuid4())
            cur = await db.execute(
                "SELECT DISTINCT branch_label FROM sessions WHERE workspace_id = ? AND branch_label IS NOT NULL",
                (parent["workspace_id"],),
            )
            existing = {row["branch_label"] for row in await cur.fetchall()}
            branch_label = _generate_branch_label(branch_group, existing)
            # Tag the branch session (which was the original before /branch)
            await db.execute(
                "UPDATE sessions SET branch_group = ?, branch_label = ? WHERE id = ?",
                (branch_group, branch_label, branch_session_id),
            )

        await db.execute(
            """INSERT INTO sessions
               (id, workspace_id, name, model, permission_mode, effort,
                budget_usd, system_prompt, allowed_tools, disallowed_tools,
                add_dirs, cli_type, parent_session_id, native_session_id,
                branch_group, branch_label)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (new_id, parent["workspace_id"], original_name, parent["model"],
             parent["permission_mode"], parent["effort"],
             parent.get("budget_usd"), parent.get("system_prompt"),
             parent.get("allowed_tools"), parent.get("disallowed_tools"),
             parent.get("add_dirs"), parent.get("cli_type", "claude"),
             branch_session_id, original_native_id,
             branch_group, branch_label),
        )

        # Copy guidelines from the branch session (skip deleted guidelines)
        cur = await db.execute(
            """SELECT sg.guideline_id FROM session_guidelines sg
               JOIN guidelines g ON g.id = sg.guideline_id
               WHERE sg.session_id = ?""",
            (branch_session_id,),
        )
        for row in await cur.fetchall():
            await db.execute(
                "INSERT OR IGNORE INTO session_guidelines (session_id, guideline_id) VALUES (?, ?)",
                (new_id, row["guideline_id"]),
            )

        # Copy MCP servers from the branch session (skip deleted servers)
        cur = await db.execute(
            """SELECT sm.mcp_server_id, sm.auto_approve_override FROM session_mcp_servers sm
               JOIN mcp_servers m ON m.id = sm.mcp_server_id
               WHERE sm.session_id = ?""",
            (branch_session_id,),
        )
        for row in await cur.fetchall():
            await db.execute(
                "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, ?)",
                (new_id, row["mcp_server_id"], row["auto_approve_override"]),
            )

        await db.commit()

        # Clear stale native_session_id on the branch session — it still holds
        # the ORIGINAL's UUID but the PTY is now running a different conversation.
        # The next hook event from the branch will re-capture the correct ID.
        await db.execute(
            "UPDATE sessions SET native_session_id = NULL WHERE id = ?",
            (branch_session_id,),
        )
        await db.commit()
        from hooks import clear_native_id_cache
        clear_native_id_cache(branch_session_id)

        # Fetch the new session and broadcast
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (new_id,))
        new_session = dict(await cur.fetchone())

        # Re-fetch branch session so frontend gets updated branch_group/label + name
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (branch_session_id,))
        updated_branch = dict(await cur.fetchone())

        await broadcast({
            "type": "session_created",
            "session": new_session,
            "auto_open": True,
            "parent_session_id": branch_session_id,
            "updated_parent": updated_branch,
        })
        # Also broadcast the rename of the branch session
        await broadcast({
            "type": "session_renamed",
            "session_id": branch_session_id,
            "name": branch_name,
        })

        logger.info(
            "Branch detected: opened original %s as tab (branch=%s)",
            new_id[:8], branch_session_id[:8],
        )
    except Exception as e:
        logger.exception("Failed to open original as tab after /branch: %s", e)
    finally:
        await db.close()


# ─── Gemini /branch — Commander-layer implementation ─────────────────────
#
# Gemini CLI has no native /branch.  We intercept the slash command in the
# WebSocket input handler and implement branching ourselves: create a session
# for the original conversation (resumable via --resume), then stop + restart
# the current PTY fresh so it becomes the "branch."

async def _maybe_handle_gemini_branch(session_id: str) -> bool:
    """Intercept /branch for Gemini sessions (no native support).

    Returns True if handled (caller should swallow the input).
    """
    buf = _input_bufs.get(session_id, "").strip()
    if buf != "/branch":
        return False

    config = await get_session_config(session_id)
    if not config or config.get("cli_type") != "gemini":
        return False

    native_sid = config.get("native_session_id")
    if not native_sid:
        pty_mgr.write(session_id,
                      b"\r\n\x1b[33m[No conversation to branch \xe2\x80\x94 start chatting first]\x1b[0m\r\n")
        return True

    import uuid as _uuid
    from hooks import _generate_branch_label

    db = await get_db()
    try:
        # Guard: don't create duplicate
        cur = await db.execute(
            "SELECT id FROM sessions WHERE native_session_id = ? AND id != ?",
            (native_sid, session_id),
        )
        if await cur.fetchone():
            pty_mgr.write(session_id,
                          b"\r\n\x1b[33m[Branch already exists for this conversation]\x1b[0m\r\n")
            return True

        new_id = str(_uuid.uuid4())
        original_name = config["name"] or "Session"
        branch_name = f"{original_name} (branch)"

        # ── Branch group ──────────────────────────────────────────────
        if config.get("branch_group"):
            branch_group = config["branch_group"]
            branch_label = config.get("branch_label", "")
        else:
            branch_group = str(_uuid.uuid4())
            cur = await db.execute(
                "SELECT DISTINCT branch_label FROM sessions "
                "WHERE workspace_id = ? AND branch_label IS NOT NULL",
                (config["workspace_id"],),
            )
            existing = {row["branch_label"] for row in await cur.fetchall()}
            branch_label = _generate_branch_label(branch_group, existing)
            # Tag the branch session (current)
            await db.execute(
                "UPDATE sessions SET branch_group = ?, branch_label = ?, name = ? WHERE id = ?",
                (branch_group, branch_label, branch_name, session_id),
            )

        # ── Insert original session ───────────────────────────────────
        await db.execute(
            """INSERT INTO sessions
               (id, workspace_id, name, model, permission_mode, effort,
                budget_usd, system_prompt, allowed_tools, disallowed_tools,
                add_dirs, cli_type, parent_session_id, native_session_id,
                branch_group, branch_label)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (new_id, config["workspace_id"], original_name, config["model"],
             config["permission_mode"], config["effort"],
             config.get("budget_usd"), config.get("system_prompt"),
             config.get("allowed_tools"), config.get("disallowed_tools"),
             config.get("add_dirs"), "gemini",
             session_id, native_sid,
             branch_group, branch_label),
        )

        # ── Copy guidelines ───────────────────────────────────────────
        cur = await db.execute(
            """SELECT sg.guideline_id FROM session_guidelines sg
               JOIN guidelines g ON g.id = sg.guideline_id
               WHERE sg.session_id = ?""",
            (session_id,),
        )
        for row in await cur.fetchall():
            await db.execute(
                "INSERT OR IGNORE INTO session_guidelines (session_id, guideline_id) VALUES (?, ?)",
                (new_id, row["guideline_id"]),
            )

        # ── Copy MCP servers ─────────────────────────────────────────
        cur = await db.execute(
            """SELECT sm.mcp_server_id, sm.auto_approve_override FROM session_mcp_servers sm
               JOIN mcp_servers m ON m.id = sm.mcp_server_id
               WHERE sm.session_id = ?""",
            (session_id,),
        )
        for row in await cur.fetchall():
            await db.execute(
                "INSERT OR IGNORE INTO session_mcp_servers "
                "(session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, ?)",
                (new_id, row["mcp_server_id"], row["auto_approve_override"]),
            )

        # Keep native_session_id on the branch so it resumes with full context
        # (matches Claude's behavior: branch keeps conversation, original also preserved)
        await db.commit()

        # Fetch rows for broadcast
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (new_id,))
        new_session = dict(await cur.fetchone())
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        updated_branch = dict(await cur.fetchone())
    except Exception as e:
        logger.exception("Gemini /branch failed: %s", e)
        pty_mgr.write(session_id,
                      b"\r\n\x1b[31m[Branch failed \xe2\x80\x94 see server log]\x1b[0m\r\n")
        return True
    finally:
        await db.close()

    # Write feedback to terminal
    pty_mgr.write(session_id,
                  f"\r\n\x1b[35m\u2442 Branched! Original conversation saved as "
                  f"\"{original_name}\" tab.\x1b[0m\r\n".encode("utf-8"))

    # Broadcast original session (opens as background tab + toast)
    await broadcast({
        "type": "session_created",
        "session": new_session,
        "auto_open": True,
        "parent_session_id": session_id,
        "updated_parent": updated_branch,
    })
    await broadcast({
        "type": "session_renamed",
        "session_id": session_id,
        "name": branch_name,
    })

    # Stop PTY + auto-restart fresh (reuses switch_session_cli pattern)
    await pty_mgr.stop_session(session_id)
    from hooks import clear_native_id_cache
    clear_native_id_cache(session_id)
    await broadcast({
        "type": "session_switched",
        "session_id": session_id,
        "cli_type": "gemini",
        "model": config["model"],
    })

    logger.info("Gemini /branch: original %s, branch %s restarting fresh",
                new_id[:8], session_id[:8])
    return True


# ─── Conversation turn tracking ───────────────────────────────────────────

_input_bufs: dict[str, str] = {}
_session_turns: dict[str, list[str]] = {}
_input_esc: dict[str, int] = {}  # 0=normal, 1=got ESC, 2=CSI body
_session_workspace: dict[str, str] = {}  # session_id → workspace_id (for advisor)

def _track_input(session_id: str, raw: str):
    """Track user keystrokes, split into turns on Enter.

    Includes a small state machine to skip ANSI escape sequences
    (focus events, device-attribute responses, arrow keys, etc.) so
    they don't pollute the buffer with ``[I``, ``[?1;2c``, etc.
    """
    if session_id not in _input_bufs:
        _input_bufs[session_id] = ""
    state = _input_esc.get(session_id, 0)

    for ch in raw:
        code = ord(ch)

        # ── Inside escape sequence → skip until done ──────────
        if state == 1:                         # got ESC, next byte decides type
            if ch == '[':
                state = 2                      # CSI sequence (\x1b[...)
            elif ch == 'O':
                state = 3                      # SS3 (\x1bO + one byte)
            else:
                state = 0                      # unknown / bare ESC, done
            continue
        if state == 2:                         # CSI body — skip until final byte
            if 0x40 <= code <= 0x7E:           # final byte → sequence done
                state = 0
            continue
        if state == 3:                         # SS3 — skip one byte then done
            state = 0
            continue

        # ── Normal state ──────────────────────────────────────
        if ch == '\x1b':
            state = 1
        elif ch in ('\r', '\n'):
            line = _input_bufs[session_id].strip()
            if line:
                if session_id not in _session_turns:
                    _session_turns[session_id] = []
                _session_turns[session_id].append(line)
                # Session Advisor: feed intent accumulator
                try:
                    from session_advisor import update_intent
                    # Look up workspace_id for this session
                    ws_id = _session_workspace.get(session_id)
                    _fire_and_forget(update_intent(
                        session_id, line, source="user",
                        workspace_id=ws_id, broadcast_fn=broadcast,
                    ))
                except Exception:
                    pass
                # Skill Suggester: push real-time suggestions
                try:
                    from skill_suggester import maybe_suggest_skills
                    ws_id = _session_workspace.get(session_id)
                    _fire_and_forget(maybe_suggest_skills(
                        session_id, line,
                        workspace_id=ws_id, broadcast_fn=broadcast,
                    ))
                except Exception:
                    pass
            _input_bufs[session_id] = ""
        elif ch == '\x7f' or ch == '\x08':
            _input_bufs[session_id] = _input_bufs[session_id][:-1]
        elif code >= 32:
            _input_bufs[session_id] += ch

    _input_esc[session_id] = state


def get_session_turns(session_id: str) -> list[str]:
    return _session_turns.get(session_id, [])


# ─── @prompt:<name> token expansion on Enter ─────────────────────────────
#
# When the user presses Enter in the terminal and their accumulated input
# contains @prompt:<name> tokens, we expand them server-side before the
# message reaches Claude. The expansion is done by backspacing over the
# raw input in the PTY and retyping the expanded version — all in a single
# write so it's atomic from the terminal's perspective.
#
# This lives server-side (not client-side) because:
#   1. _input_bufs already tracks what the user typed (no duplication)
#   2. The DB with prompts is right here
#   3. It works for ALL input paths (terminal, paste, replay, etc.)

import re as _re

_PROMPT_TOKEN_RE = _re.compile(r'@prompt:(?:"([^"]+)"|(\S+))', _re.IGNORECASE)


def _find_prompt_by_name(prompts: list[dict], name: str):
    """Case-insensitive name lookup: exact → normalized → prefix."""
    lc = name.lower()
    for p in prompts:
        if p["name"].lower() == lc:
            return p
    norm = lc.replace(" ", "").replace("-", "").replace("_", "")
    for p in prompts:
        if p["name"].lower().replace(" ", "").replace("-", "").replace("_", "") == norm:
            return p
    for p in prompts:
        if p["name"].lower().startswith(lc):
            return p
    return None


def _expand_prompt_tokens(text: str, prompts: list[dict]) -> str:
    """Replace @prompt:<name> tokens with their content."""
    def _replacer(m):
        name = m.group(1) or m.group(2)
        hit = _find_prompt_by_name(prompts, name)
        return hit["content"] if hit else m.group(0)
    return _PROMPT_TOKEN_RE.sub(_replacer, text)




async def _maybe_expand_input(session_id: str, raw_input: str):
    """If raw_input contains Enter and the accumulated buffer has @prompt:
    tokens, return bytes to write to PTY instead (backspaces + expanded +
    Enter). Returns None when no expansion is needed.

    On expansion, also updates _input_bufs / _session_turns so the
    tracking state stays consistent, and emits a token_expanded event.
    """
    # Only trigger when the chunk contains Enter
    if "\r" not in raw_input and "\n" not in raw_input:
        return None

    # _input_bufs already has the accumulated (escape-cleaned) text from
    # prior _track_input calls. For the common case (Enter arrives as its
    # own chunk), this is the complete user input.
    buf = _input_bufs.get(session_id, "").strip()
    if not buf:
        return None

    # Quick regex check — skip the DB hit if there are no @prompt: tokens
    if not _PROMPT_TOKEN_RE.search(buf):
        return None

    logger.info("Token expansion: matched @prompt: in buffer (%d chars): %s", len(buf), buf[:80])

    # Fetch prompts from DB
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT id, name, content FROM prompts"
        )
        prompts = [dict(r) for r in rows]
    finally:
        await db.close()

    expanded = _expand_prompt_tokens(buf, prompts)
    if expanded == buf:
        return None  # Token was present but name didn't match anything

    # Collapse newlines → spaces. Ink's TextInput is single-line; any
    # \n in the prompt content would be interpreted as Enter (submitting
    # a partial message). For full multiline prompts use Composer (⌘E).
    expanded = expanded.replace("\r\n", " ").replace("\r", " ").replace("\n", " ")

    logger.info("Token expansion: expanded to %d chars", len(expanded))

    # Two-phase write mirroring the frontend's sendTerminalCommand.
    # Phase 1 (immediate): clear existing input
    # Phase 2 (after delay): expanded text + Enter
    # Use CLI-appropriate clear: Escape+DEL for Claude Ink, Ctrl-U for Gemini.
    cli_type = "claude"
    try:
        _cfg = await get_session_config(session_id)
        if _cfg:
            cli_type = _cfg.get("cli_type", "claude")
    except Exception:
        pass
    if cli_type == "gemini":
        pty_mgr.write(session_id, b"\x15")  # Ctrl-U
    else:
        pty_mgr.write(session_id, b"\x1b" + b"\x7f" * 50)

    async def _send_expanded():
        await _asyncio.sleep(0.3)
        # Write text and submit \r in *separate* writes. A combined
        # text+\r blob lets Claude's Ink paste-detection swallow the
        # trailing CR for any expansion past ~80 chars.
        pty_mgr.write(session_id, expanded.encode("utf-8"))
        await _asyncio.sleep(0.4)
        pty_mgr.write(session_id, b"\r")

    _asyncio.ensure_future(_send_expanded())

    # Update tracking state (what _track_input would have done)
    if session_id not in _session_turns:
        _session_turns[session_id] = []
    _session_turns[session_id].append(expanded.strip())
    _input_bufs[session_id] = ""

    # Emit event + broadcast (fire-and-forget)
    session = await get_session_config(session_id)
    _asyncio.ensure_future(bus.emit(
        "token_expanded",
        {
            "session_id": session_id,
            "workspace_id": session["workspace_id"] if session else None,
            "original": buf,
            "expanded_preview": expanded[:200],
            "tokens": [m.group(0) for m in _PROMPT_TOKEN_RE.finditer(buf)],
        },
        source="terminal",
    ))
    await broadcast({
        "session_id": session_id,
        "type": "token_expanded",
        "tokens": [m.group(0) for m in _PROMPT_TOKEN_RE.finditer(buf)],
    })

    # Return empty bytes — signals caller to NOT forward the original
    # Enter keystroke (we already scheduled the expanded text + Enter).
    return b""


async def _replay_turns(session_id: str, turns: list[str]):
    """Replay saved conversation turns into a session, waiting for each response."""
    import re

    # Broadcast replaying status
    await broadcast({"session_id": session_id, "type": "status", "status": "replaying"})

    for i, turn in enumerate(turns):
        # Wait for Claude Code to show input prompt (❯ or >)
        for _ in range(60):  # Max 30 seconds per turn
            buf = capture_proc.get_buffer(session_id, 5)
            if '❯' in buf or '> ' in buf or (i == 0 and 'shortcuts' in buf.lower()):
                break
            await asyncio.sleep(0.5)

        await asyncio.sleep(0.3)  # Small extra pause for Ink to settle

        # Type the message, then submit Enter as a separate write — a
        # combined blob can be paste-detected by Ink and the \r dropped.
        pty_mgr.write(session_id, turn.encode('utf-8'))
        await asyncio.sleep(0.4)
        pty_mgr.write(session_id, b'\r')

        # Wait for response to complete (prompt reappears)
        await asyncio.sleep(2)  # Minimum wait for response to start
        for _ in range(120):  # Max 60 seconds for response
            buf = capture_proc.get_buffer(session_id, 3)
            # Check if prompt appeared again (Claude is done)
            last_lines = buf.strip().split('\n')
            if any('❯' in l for l in last_lines[-3:]):
                break
            await asyncio.sleep(0.5)

    # Done replaying
    await broadcast({"session_id": session_id, "type": "status", "status": "idle"})
    await broadcast({"session_id": session_id, "type": "replay_done"})


async def _adopt_sessions(commander_id: str, target_ids: list[str]):
    """Set parent_session_id on targets if the source is a commander session."""
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT session_type FROM sessions WHERE id = ?", (commander_id,)
        )
        row = await cur.fetchone()
        if not row or row["session_type"] != "commander":
            return
        for sid in target_ids:
            await db.execute(
                "UPDATE sessions SET parent_session_id = ? WHERE id = ? AND (parent_session_id IS NULL OR parent_session_id != ?)",
                (commander_id, sid, commander_id),
            )
        await db.commit()
    finally:
        await db.close()


# ─── WebSocket ────────────────────────────────────────────────────────────

async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    ws_clients.add(ws)
    # Tag the socket with its joiner_session id (when present) so a
    # subsequent /api/sessions/auth/{id}/revoke can close live connections
    # the revoked joiner is holding open. Without this, revocation only
    # affects the next HTTP request — the existing WS keeps driving PTYs.
    auth_ctx = request.get("auth")
    ws._ive_actor_id = getattr(auth_ctx, "actor_id", None) if auth_ctx else None
    logger.info(f"WebSocket connected ({len(ws_clients)} total)")

    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue

                action = data.get("action")

                if action == "start_pty":
                    session_id = data.get("session_id")
                    cols = data.get("cols", 120)
                    rows = data.get("rows", 40)

                    if not session_id:
                        continue

                    if pty_mgr.is_alive(session_id):
                        # Already running — replay cached output to this viewer
                        # so a grid cell mounting an existing session sees the
                        # current TUI state instead of a blank terminal. Send
                        # only to the requesting ws (broadcasting would dupe
                        # the buffer to every other client). The xterm-side
                        # resize effect handles SIGWINCH separately.
                        cached = pty_mgr.get_cached_output(session_id)
                        if cached:
                            # Collapse to the last fresh-frame boundary so a
                            # rolling cache that accumulated multiple banner
                            # repaints (initial render + resize redraws + any
                            # subsequent /clear) doesn't pile them all into
                            # the new viewer's scrollback. Claude uses \x1b[H,
                            # other CLIs may use \x1b[2J — take whichever
                            # comes later.
                            last_2j = cached.rfind(b"\x1b[2J")
                            last_h  = cached.rfind(b"\x1b[H")
                            last_boundary = max(last_2j, last_h)
                            if last_boundary > 0:
                                cached = cached[last_boundary:]
                            try:
                                await ws.send_json({
                                    "session_id": session_id,
                                    "type": "output",
                                    "data": cached.decode("utf-8", errors="replace"),
                                })
                            except (ConnectionResetError, ConnectionError, RuntimeError):
                                pass
                        continue

                    config = await get_session_config(session_id)
                    if not config:
                        await ws.send_json({
                            "session_id": session_id,
                            "type": "error",
                            "message": "Session not found",
                        })
                        continue

                    # Fetch attached guidelines and build combined system prompt.
                    # Three sources stack into the final --append-system-prompt:
                    #   1. session.system_prompt (legacy free-text field)
                    #   2. Legacy guidelines (session_guidelines)
                    #   3. Plugin guideline components (session_plugin_components
                    #      where type='guideline') — from the plugin marketplace,
                    #      CLI-agnostic (works for both Claude and Gemini).
                    system_prompt_parts = []
                    if config.get("system_prompt"):
                        system_prompt_parts.append(config["system_prompt"])

                    _stype = (config.get("session_type") or "").strip()
                    if _stype == "planner":
                        system_prompt_parts.append(PLANNER_SYSTEM_PROMPT)
                    elif _stype in ("", "worker", "test_worker"):
                        system_prompt_parts.append(WORKER_SYSTEM_PROMPT_FRAGMENT)

                    # Track which guideline IDs are ACTUALLY loaded into the
                    # system prompt. Written back to sessions.active_guideline_ids
                    # so the GuidelinePanel can show accurate "active" vs "pending"
                    # labels and detect unchecked-but-still-cached guidelines.
                    loaded_guideline_ids = []

                    db_gl = await get_db()
                    try:
                        cur_gl = await db_gl.execute(
                            """SELECT g.id, g.content FROM guidelines g
                               JOIN session_guidelines sg ON g.id = sg.guideline_id
                               WHERE sg.session_id = ?""",
                            (session_id,),
                        )
                        for row_gl in await cur_gl.fetchall():
                            system_prompt_parts.append(row_gl["content"])
                            loaded_guideline_ids.append(row_gl["id"])

                        # Plugin guideline components:
                        #   • activation='always' → injected into system prompt
                        #   • activation='on_demand' → on disk as SKILL.md,
                        #     discovered natively by the CLI (not injected here)
                        cur_plugin = await db_gl.execute(
                            """SELECT pc.content
                               FROM plugin_components pc
                               JOIN session_plugin_components spc
                                    ON pc.id = spc.component_id
                               WHERE spc.session_id = ?
                                 AND pc.type = 'guideline'
                                 AND COALESCE(pc.activation, 'always') = 'always'
                               ORDER BY pc.order_index, pc.name""",
                            (session_id,),
                        )
                        for row_p in await cur_plugin.fetchall():
                            if row_p["content"]:
                                system_prompt_parts.append(row_p["content"])

                        # Experimental: checkpoint protocol injection.
                        cur_exp = await db_gl.execute(
                            "SELECT value FROM app_settings WHERE key = ?",
                            ("experimental_checkpoint_protocol",),
                        )
                        exp_row = await cur_exp.fetchone()
                        if exp_row and exp_row["value"] == "on":
                            system_prompt_parts.append(
                                experimental.CHECKPOINT_PROTOCOL_PROMPT
                            )

                        # Experimental: model switching prompt injection.
                        cur_ms = await db_gl.execute(
                            "SELECT value FROM app_settings WHERE key = ?",
                            ("experimental_model_switching",),
                        )
                        ms_row = await cur_ms.fetchone()
                        if ms_row and ms_row["value"] == "on":
                            pm = config.get("plan_model") or config.get("model", "opus")
                            em = config.get("execute_model") or config.get("model", "sonnet")
                            system_prompt_parts.append(
                                experimental.MODEL_SWITCHING_PROMPT.format(
                                    plan_model=pm, execute_model=em,
                                )
                            )

                        # Commander memory injection: append remembered context
                        # from Commander's memory_entries DB.  This is the key
                        # abstraction — every CLI (Claude, Gemini, future CLIs)
                        # gets the same memory entries regardless of whether
                        # the CLI has native auto-memory support.
                        _mem_info = None
                        _ws_id_mem = config.get("workspace_id", "")
                        _mem_max = 4000
                        try:
                            from memory_sync import sync_manager as _sync_mgr
                            _mem_settings = await _sync_mgr.get_settings(_ws_id_mem)
                            _mem_max = _mem_settings.get("memory_max_chars", 4000)
                        except Exception:
                            pass

                        # Aggressive output styles also compress the memory
                        # block (matches export_for_prompt's compact contract).
                        # Resolve effective style here so it can drive both the
                        # memory render and the later style-prompt injection.
                        try:
                            from output_styles import resolve_output_style as _resolve_style
                            _peek_ws_style = config.get("ws_output_style")
                            if not _peek_ws_style:
                                try:
                                    _peek_db = await get_db()
                                    _peek_cur = await _peek_db.execute(
                                        "SELECT output_style FROM workspaces WHERE id = ?",
                                        (_ws_id_mem,))
                                    _peek_row = await _peek_cur.fetchone()
                                    _peek_ws_style = _peek_row["output_style"] if _peek_row else None
                                    await _peek_db.close()
                                except Exception:
                                    _peek_ws_style = None
                            _peek_global = None
                            try:
                                _peek_gs = await get_db()
                                _peek_gc = await _peek_gs.execute(
                                    "SELECT value FROM app_settings WHERE key = 'output_style'")
                                _peek_gr = await _peek_gc.fetchone()
                                _peek_global = _peek_gr["value"] if _peek_gr else None
                                await _peek_gs.close()
                            except Exception:
                                pass
                            effective_style = _resolve_style(
                                config.get("output_style"), _peek_ws_style, _peek_global)
                        except Exception:
                            effective_style = "default"
                        _compact_memory = effective_style in ("caveman", "ultra", "dense")

                        try:
                            from memory_manager import memory_manager
                            _mem_entries = await memory_manager.list_entries(workspace_id=_ws_id_mem)
                            _mem_count = len(_mem_entries) if _mem_entries else 0
                            mem_prompt = await memory_manager.export_for_prompt(
                                workspace_id=_ws_id_mem,
                                max_chars=_mem_max,
                                compact=_compact_memory,
                            )
                            if mem_prompt:
                                system_prompt_parts.append(mem_prompt)
                                _mem_info = json.dumps({"count": _mem_count, "chars": len(mem_prompt)})
                        except Exception as mem_exc:
                            logger.debug("Memory injection skipped: %s", mem_exc)

                        # ── W2W: Inject workspace knowledge into system prompt ─
                        try:
                            _ws_id = config.get("workspace_id", "")
                            ws_db = await get_db()
                            try:
                                ws_cur = await ws_db.execute(
                                    "SELECT context_sharing_enabled, comms_enabled FROM workspaces WHERE id = ?",
                                    (_ws_id,),
                                )
                                ws_flags = await ws_cur.fetchone()
                            finally:
                                await ws_db.close()

                            if ws_flags and ws_flags["context_sharing_enabled"]:
                                # Inject accumulated knowledge (cap from workspace setting)
                                know_limit = 3000
                                try:
                                    _kl_db = await get_db()
                                    _kl_cur = await _kl_db.execute(
                                        "SELECT knowledge_context_limit FROM workspaces WHERE id = ?",
                                        (_ws_id,))
                                    _kl_row = await _kl_cur.fetchone()
                                    if _kl_row and _kl_row["knowledge_context_limit"]:
                                        know_limit = _kl_row["knowledge_context_limit"]
                                    await _kl_db.close()
                                except Exception:
                                    pass
                                know_db = await get_db()
                                try:
                                    know_cur = await know_db.execute(
                                        "SELECT * FROM workspace_knowledge WHERE workspace_id = ? ORDER BY confirmed_count DESC, updated_at DESC",
                                        (_ws_id,),
                                    )
                                    know_rows = [dict(r) for r in await know_cur.fetchall()]
                                finally:
                                    await know_db.close()

                                # Relevance-based ranking: if session has a task,
                                # rank knowledge by semantic similarity to the task
                                if know_rows and config.get("task_id"):
                                    try:
                                        import embedder
                                        _task_db = await get_db()
                                        _tc = await _task_db.execute(
                                            "SELECT title, description FROM tasks WHERE id = ?",
                                            (config["task_id"],))
                                        _tr = await _tc.fetchone()
                                        await _task_db.close()
                                        if _tr:
                                            task_context = f"{_tr['title']} {_tr['description'] or ''}"
                                            similar = await embedder.search_similar(
                                                task_context, "knowledge",
                                                workspace_id=_ws_id,
                                                limit=50, min_score=0.2)
                                            if similar:
                                                # Reorder know_rows by relevance score
                                                score_map = {s["entity_id"]: s["score"] for s in similar}
                                                know_rows.sort(
                                                    key=lambda kr: score_map.get(kr["id"], 0),
                                                    reverse=True)
                                    except Exception:
                                        pass  # fall back to popularity sort

                                if know_rows:
                                    sections: dict[str, list[str]] = {}
                                    total_len = 0
                                    for kr in know_rows:
                                        cat = kr["category"] or "general"
                                        entry = f"- {kr['content']}"
                                        if kr.get("scope"):
                                            entry += f" [{kr['scope']}]"
                                        if total_len + len(entry) > know_limit:
                                            break
                                        sections.setdefault(cat, []).append(entry)
                                        total_len += len(entry)

                                    lines = ["## Workspace Knowledge Base\n"]
                                    for cat, entries in sections.items():
                                        lines.append(f"### {cat.title()}")
                                        lines.extend(entries)
                                        lines.append("")
                                    system_prompt_parts.append("\n".join(lines))

                                # Inject recent file activity from peer sessions
                                try:
                                    fa_db = await get_db()
                                    try:
                                        fa_cur = await fa_db.execute(
                                            """SELECT file_path, session_name, task_summary, task_title,
                                                      MAX(created_at) AS last_edited
                                               FROM file_activity
                                               WHERE workspace_id = ? AND session_id != ?
                                                 AND created_at > datetime('now', '-2 hours')
                                               GROUP BY file_path, session_id
                                               ORDER BY last_edited DESC LIMIT 20""",
                                            (_ws_id, session_id),
                                        )
                                        fa_rows = await fa_cur.fetchall()
                                    finally:
                                        await fa_db.close()

                                    if fa_rows:
                                        fa_lines = ["## Recent File Activity (Peers)\n",
                                                     "Files recently edited by peer sessions:"]
                                        for fa in fa_rows:
                                            goal = fa["task_title"] or fa["task_summary"] or "unknown task"
                                            fa_lines.append(
                                                f"- `{fa['file_path']}` — {fa['session_name']} ({goal})"
                                            )
                                        fa_lines.append("")
                                        system_prompt_parts.append("\n".join(fa_lines))
                                except Exception:
                                    pass

                                # Auto-overlap detection: check if other sessions
                                # are doing similar work and inject warnings upfront
                                try:
                                    _overlap_intent = ""
                                    # Build intent from task or session name
                                    if config.get("task_id"):
                                        _ov_db = await get_db()
                                        try:
                                            _ov_c = await _ov_db.execute(
                                                "SELECT title, description FROM tasks WHERE id = ?",
                                                (config["task_id"],))
                                            _ov_r = await _ov_c.fetchone()
                                            if _ov_r:
                                                _overlap_intent = f"{_ov_r['title']} {_ov_r['description'] or ''}"
                                        finally:
                                            await _ov_db.close()
                                    elif config.get("session_name"):
                                        _overlap_intent = config["session_name"]

                                    if _overlap_intent and len(_overlap_intent.strip()) > 5:
                                        import embedder as _emb
                                        _overlaps = await _emb.check_overlap(
                                            _overlap_intent.strip(), _ws_id, exclude_session_id=session_id)
                                        if _overlaps:
                                            ov_lines = ["## Active Session Overlap\n",
                                                        "Other sessions in this workspace are doing related work:"]
                                            for _ov in _overlaps[:5]:
                                                _lvl = _ov.get("level", "?")
                                                _icon = "\u26d4" if _lvl == "conflict" else "\u26a0\ufe0f" if _lvl == "share" else "\u2139\ufe0f"
                                                _desc = _ov.get("dense_text", "")[:120]
                                                ov_lines.append(f"- {_icon} [{_lvl.upper()}] {_desc}")
                                            if any(_ov.get("level") == "conflict" for _ov in _overlaps):
                                                ov_lines.append(
                                                    "\n**CONFLICT detected** — another session is doing very similar work. "
                                                    "Call list_peers() and check_messages() immediately. "
                                                    "Coordinate before making changes to avoid duplicate/conflicting work.")
                                            elif any(_ov.get("level") == "share" for _ov in _overlaps):
                                                ov_lines.append(
                                                    "\nRelated work detected — call search_memory() to learn from "
                                                    "peer sessions and avoid duplicating effort.")
                                            ov_lines.append("")
                                            system_prompt_parts.append("\n".join(ov_lines))
                                except Exception as _ov_exc:
                                    logger.debug("Overlap detection skipped: %s", _ov_exc)

                                # Context sharing prompt fragment.
                                # Testers don't edit shared code, so they get a trimmed
                                # surface: no conflict-avoidance tools, no "before editing
                                # any file" rituals — just the memory/digest/knowledge loop
                                # they actually use. contribute_knowledge stays in the tester
                                # block because gotchas the tester finds (flaky selectors,
                                # UI quirks, "still broken" notes) should land in the shared
                                # KB so the next implementer sees them.
                                _session_type_w2w = (config.get("session_type") or "").strip()
                                _is_tester_w2w = _session_type_w2w in ("tester", "test_worker")
                                _is_commander_w2w = _session_type_w2w == "commander"
                                _is_documentor_w2w = _session_type_w2w == "documentor"

                                if _is_documentor_w2w:
                                    # Documentor MCP only exposes save_memory from the W2W
                                    # surface — no peer comms, no digests, no contribute_knowledge.
                                    # Skip the block entirely; documentor's role prompt covers
                                    # what it actually does.
                                    pass
                                elif _is_commander_w2w:
                                    system_prompt_parts.append(
                                        "## Shared Context (W2W) — Commander\n\n"
                                        "You orchestrate workers; you rarely edit code yourself, "
                                        "so you skip per-file conflict checks. Your loop is:\n\n"
                                        "### Before assigning or routing a task\n"
                                        "1. **search_memory(query)** — past tasks with lessons, worker digests, "
                                        "knowledge entries, and peer messages. Skipping this means re-routing the "
                                        "same task to the same worker class that already failed at it.\n"
                                        "2. **list_worker_digests()** — what every worker is currently doing. "
                                        "Use this to spot idle capacity and avoid double-booking.\n"
                                        "3. **check_coordination(intent=...)** — does this task overlap with "
                                        "active worker intents? Returns conflict / share / notify levels.\n\n"
                                        "### While orchestrating\n"
                                        "- **get_session_digest(session_id)** — pull a single worker's current "
                                        "task, focus, decisions, and discoveries.\n"
                                        "- **save_memory** — your private playbook. Save routing decisions, "
                                        "worker reliability notes, and user-correction feedback.\n"
                                        "- **contribute_knowledge(category='orchestration', content, scope?)** — "
                                        "share routing/team-formation lessons with the workspace KB so future "
                                        "commanders (and the next session of yours) inherit them.\n\n"
                                        "### You do NOT have\n"
                                        "update_digest, post_message, get_file_context, check_messages, "
                                        "list_peers, blocking_bulletin, find_similar_tasks — those are worker-only. "
                                        "Use the commander-side equivalents above."
                                    )
                                elif _is_tester_w2w:
                                    system_prompt_parts.append(
                                        "## Shared Context (W2W) — Tester\n\n"
                                        "You are a verifier, not an implementer. You don't edit shared code, "
                                        "so you skip the conflict-avoidance machinery. Your W2W loop is:\n\n"
                                        "### Before each test run\n"
                                        "1. **search_memory(query)** — has this feature been tested before? "
                                        "Any flaky tests, undocumented behavior, or known gotchas? "
                                        "Skipping this means rediscovering the same flake.\n"
                                        "2. **find_similar_tasks(query)** — has this exact bug been reported already?\n\n"
                                        "### While testing\n"
                                        "- **update_digest(task_summary?, current_focus?, discoveries?)** — keep your "
                                        "digest current so commander and the UI can see what you're testing right now.\n"
                                        "- **save_memory** — save flaky tests, undocumented behavior, reusable selectors, "
                                        "and user-correction feedback. See your role prompt for what to save.\n"
                                        "- **contribute_knowledge(category='gotcha'|'pattern', content, scope?)** — "
                                        "when you find a UI quirk, a selector that needs special handling, an "
                                        "unresolved 'still broken' issue, or a testing pattern that worked, write it "
                                        "to the shared KB so the next implementer or tester sees it in their prompt. "
                                        "This is how testers ship lasting value beyond a single report.\n\n"
                                        "### When you find a bug\n"
                                        "Report findings up — do NOT try to coordinate a fix yourself. "
                                        "Use update_my_task() with detailed reproduction steps and notes. "
                                        "Commander will file follow-up tasks for implementer workers."
                                    )
                                else:
                                    system_prompt_parts.append(
                                        "## Shared Context (W2W)\n\n"
                                        "### MANDATORY: Before starting work\n"
                                        "1. **search_memory(query)** — ALWAYS do this first. Searches ALL workspace "
                                        "memory: past tasks with lessons, session digests, knowledge base, peer "
                                        "messages, and file activity. Skipping this risks duplicating solved problems.\n"
                                        "2. **check_messages()** — Read the peer bulletin board for warnings and updates.\n"
                                        "3. **find_similar_tasks(query)** — Check if someone already solved this or a related problem.\n\n"
                                        "### MANDATORY: Before editing any file\n"
                                        "- **get_file_context(file_path)** — Check who else recently edited this file "
                                        "and what they were working on. If another session touched it in the last "
                                        "10 minutes, coordinate via post_message() before making changes.\n\n"
                                        "### While working\n"
                                        "- **update_digest(summary?, discoveries?, decisions?)** — Keep your digest current "
                                        "so peers can see what you're doing. Update after each major step.\n"
                                        "- **contribute_knowledge(category, content, scope?)** — Share codebase insights "
                                        "(gotchas, conventions, patterns) that would help other sessions.\n"
                                        "- **post_message(topic, content, priority, files?)** — Warn peers when your "
                                        "changes affect shared interfaces, schemas, configs, or APIs.\n\n"
                                        "### When completing a task\n"
                                        "Always provide lessons_learned and important_notes in update_my_task(). "
                                        "These are the most valuable knowledge artifacts — they help future sessions "
                                        "avoid your mistakes and build on your discoveries.\n\n"
                                        "Categories: architecture, convention, gotcha, pattern, api, setup"
                                    )

                            if ws_flags and ws_flags["comms_enabled"]:
                                if _is_documentor_w2w:
                                    # Documentor has no peer-comms tools — skip this block.
                                    pass
                                elif _is_commander_w2w:
                                    system_prompt_parts.append(
                                        "## Peer Communication (W2W) — Commander\n\n"
                                        "You talk to workers, not the other way around. Channels:\n\n"
                                        "- **send_message(session_id, message)** — direct a specific worker. "
                                        "Use this to redirect, ask a clarifying question, or hand off context.\n"
                                        "- **broadcast_message(message)** — fan out to all active workers in "
                                        "the workspace (e.g. user changed direction; merge freeze; new constraint).\n"
                                        "- **headsup(to='all'|session_id, message=...)** — non-blocking notice. "
                                        "Fire-and-continue when you want workers to SEE something but you're not "
                                        "waiting on them (e.g. \"reassigning the auth area to session X\").\n\n"
                                        "You do NOT have post_message, check_messages, or list_peers — "
                                        "those are worker bulletin-board tools. For peer state, use "
                                        "list_worker_digests / get_session_digest instead."
                                    )
                                elif _is_tester_w2w:
                                    system_prompt_parts.append(
                                        "## Peer Communication (W2W) — Tester\n\n"
                                        "You can talk to peers but rarely need to. Two channels:\n\n"
                                        "- **headsup(to='commander', message=...)** — surface a finding or "
                                        "escalation to commander when you've hit something they should see "
                                        "immediately (a critical regression, a blocker for the test plan).\n"
                                        "- **post_message(topic, content, priority='info')** — coordinate with "
                                        "sibling test-workers if you're running in parallel (e.g. \"I'm taking "
                                        "the login flow, you take signup\").\n\n"
                                        "You do NOT need to: lock files, send blocking bulletins, or warn peers "
                                        "about your edits — testers don't edit code."
                                    )
                                else:
                                    system_prompt_parts.append(
                                        "## Peer Communication (W2W)\n\n"
                                        "You share this workspace with other active agent sessions. "
                                        "You MUST coordinate to avoid conflicts:\n\n"
                                        "- **post_message(topic, content, priority, files?)** — Alert peers about your changes.\n"
                                        "  Use priority='blocking' + files=[...] when editing shared files.\n"
                                        "- **check_messages()** — Check the bulletin board BEFORE starting each work phase.\n"
                                        "- **list_peers()** — See who else is active and what they're working on.\n\n"
                                        "**Rules:**\n"
                                        "1. Before editing a shared file (config, schema, API, types), post a blocking "
                                        "message with the file path so peers know to wait.\n"
                                        "2. After finishing a batch of related edits, post an info message summarizing "
                                        "what changed so peers can adapt.\n"
                                        "3. If you receive a blocking warning about a file you need to edit, "
                                        "coordinate with the peer before proceeding.\n\n"
                                        "Priority levels: info (FYI), heads_up (peer notified at idle), "
                                        "blocking (immediate — file is locked by peer)."
                                    )

                            # ── Active ticket binding ─────────────────────
                            # Only worker/planner sessions get a per-turn active-ticket
                            # block. Commander orchestrates (no single ticket); tester
                            # surfaces bugs via update_my_task; documentor doesn't bind.
                            if not _is_documentor_w2w and not _is_commander_w2w and not _is_tester_w2w:
                                try:
                                    bd_db = await get_db()
                                    try:
                                        bd_cur = await bd_db.execute(
                                            "SELECT board_doc_mode FROM workspaces WHERE id = ?",
                                            (_ws_id,),
                                        )
                                        bd_row = await bd_cur.fetchone()
                                        bd_mode = (bd_row["board_doc_mode"] if bd_row else "agent_with_backstop") or "agent_with_backstop"

                                        if bd_mode != "off":
                                            sess_cur = await bd_db.execute(
                                                "SELECT active_ticket_id, task_id FROM sessions WHERE id = ?",
                                                (session_id,),
                                            )
                                            sess_row = await sess_cur.fetchone()
                                            active_tid = (sess_row["active_ticket_id"] if sess_row else None) or (sess_row["task_id"] if sess_row else None)
                                            if active_tid:
                                                tk_cur = await bd_db.execute(
                                                    "SELECT id, title, status FROM tasks WHERE id = ?",
                                                    (active_tid,),
                                                )
                                                tk_row = await tk_cur.fetchone()
                                                if tk_row:
                                                    short = (tk_row["id"] or "")[:8]
                                                    title = (tk_row["title"] or "").strip().replace("\n", " ")[:80]
                                                    status = tk_row["status"] or "?"
                                                    system_prompt_parts.append(
                                                        f"## Active Ticket\n\n"
                                                        f"[Active ticket: #{short} — {status}: \"{title}\"]\n\n"
                                                        "This is the ticket you're currently bound to. If your work "
                                                        "drifts from this ticket, call switch_active_ticket(ticket_id) "
                                                        "to rebind, or switch_active_ticket(null) to unbind. At completion, "
                                                        "document_to_board(action='update') uses this binding."
                                                    )
                                                else:
                                                    # Stale binding: ticket was deleted
                                                    system_prompt_parts.append(
                                                        "## Active Ticket\n\n"
                                                        "[No active ticket bound — prior binding pointed to a deleted ticket]\n\n"
                                                        "If feature-shaped work begins, call switch_active_ticket(ticket_id) "
                                                        "to bind to an existing ticket, or call document_to_board(action='create') "
                                                        "at completion to create a new one."
                                                    )
                                            else:
                                                system_prompt_parts.append(
                                                    "## Active Ticket\n\n"
                                                    "[No active ticket bound]\n\n"
                                                    "You're working unbound. If feature-shaped work begins, call "
                                                    "switch_active_ticket(ticket_id) to bind to an existing ticket, "
                                                    "or just call document_to_board(action='create') at completion "
                                                    "to create a new one."
                                                )
                                    finally:
                                        await bd_db.close()
                                except Exception as bd_exc:
                                    logger.debug("Active ticket block skipped: %s", bd_exc)
                        except Exception as w2w_exc:
                            logger.warning("W2W injection skipped: %s", w2w_exc)

                        # Write back the snapshot of which guidelines are NOW
                        # in the system prompt. This column is the single source
                        # of truth for "active in system prompt" vs "pending".
                        await db_gl.execute(
                            "UPDATE sessions SET active_guideline_ids = ? WHERE id = ?",
                            (json.dumps(loaded_guideline_ids), session_id),
                        )
                        # Write back memory injection metadata (mirrors active_guideline_ids)
                        await db_gl.execute(
                            "UPDATE sessions SET memory_injected_info = ? WHERE id = ?",
                            (_mem_info, session_id),
                        )
                        await db_gl.commit()
                    finally:
                        await db_gl.close()

                    # Fetch attached MCP servers for dynamic config generation
                    loaded_mcp_server_ids = []
                    mcp_servers_for_session = []
                    db_mcp = await get_db()
                    try:
                        cur_mcp = await db_mcp.execute(
                            """SELECT ms.*, sms.auto_approve_override
                               FROM mcp_servers ms
                               JOIN session_mcp_servers sms ON ms.id = sms.mcp_server_id
                               WHERE sms.session_id = ?""",
                            (session_id,),
                        )
                        for row_mcp in await cur_mcp.fetchall():
                            d = dict(row_mcp)
                            d["args"] = json.loads(d["args"] or "[]")
                            d["env"] = json.loads(d["env"] or "{}")
                            mcp_servers_for_session.append(d)
                            loaded_mcp_server_ids.append(d["id"])

                        await db_mcp.execute(
                            "UPDATE sessions SET active_mcp_server_ids = ? WHERE id = ?",
                            (json.dumps(loaded_mcp_server_ids), session_id),
                        )
                        await db_mcp.commit()
                    finally:
                        await db_mcp.close()

                    # Read AGENTS.md files from workspace directory hierarchy
                    # Walks from workspace root upward, scoped down per subfolder
                    ws_path = config.get("workspace_path", "")
                    if ws_path:
                        import os as _os
                        agents_contents = []
                        scan_dir = ws_path
                        # Walk up from workspace dir to find AGENTS.md files
                        for _ in range(10):  # Max 10 levels up
                            agents_file = _os.path.join(scan_dir, "AGENTS.md")
                            if _os.path.isfile(agents_file):
                                try:
                                    with open(agents_file, "r") as af:
                                        content = af.read().strip()
                                        if content:
                                            agents_contents.append(f"# From {agents_file}\n{content}")
                                except (OSError, IOError):
                                    pass
                            parent = _os.path.dirname(scan_dir)
                            if parent == scan_dir:
                                break
                            scan_dir = parent
                        if agents_contents:
                            # Reverse so root-level comes first, workspace-specific last (overrides)
                            agents_contents.reverse()
                            system_prompt_parts.append("# AGENTS.md\n" + "\n\n".join(agents_contents))

                    # ── Resolve output style (session → workspace → global) ──
                    from output_styles import resolve_output_style, get_style_prompt
                    _ws_style = config.get("ws_output_style")  # from workspace join
                    if not _ws_style:
                        # Fetch workspace output_style if not in config
                        try:
                            _ws_db = await get_db()
                            _ws_cur = await _ws_db.execute(
                                "SELECT output_style FROM workspaces WHERE id = ?",
                                (config.get("workspace_id", ""),))
                            _ws_row = await _ws_cur.fetchone()
                            _ws_style = _ws_row["output_style"] if _ws_row else None
                            await _ws_db.close()
                        except Exception:
                            _ws_style = None
                    _global_style = None
                    try:
                        _gs_db = await get_db()
                        _gs_cur = await _gs_db.execute(
                            "SELECT value FROM app_settings WHERE key = 'output_style'")
                        _gs_row = await _gs_cur.fetchone()
                        _global_style = _gs_row["value"] if _gs_row else None
                        await _gs_db.close()
                    except Exception:
                        pass
                    effective_style = resolve_output_style(
                        config.get("output_style"), _ws_style, _global_style)
                    style_prompt = get_style_prompt(effective_style)
                    if style_prompt:
                        system_prompt_parts.append(style_prompt)

                    # ── Auto Skill Suggestions: inject top-3 into system prompt ──
                    try:
                        _ask_db = await get_db()
                        try:
                            _ask_cur = await _ask_db.execute(
                                "SELECT value FROM app_settings WHERE key = 'experimental_auto_skill_suggestions'"
                            )
                            _ask_row = await _ask_cur.fetchone()
                        finally:
                            await _ask_db.close()
                        if _ask_row and _ask_row["value"] == "on":
                            from skill_suggester import suggest_for_session
                            # Build context from session name + purpose + existing system prompt,
                            # plus recent workspace digests so the match reflects what the user
                            # has actually been doing — not just static session config.
                            _skill_ctx_parts = []
                            if config.get("name"):
                                _skill_ctx_parts.append(config["name"])
                            if config.get("purpose"):
                                _skill_ctx_parts.append(config["purpose"])
                            if config.get("system_prompt"):
                                _skill_ctx_parts.append(config["system_prompt"][:300])
                            _ws_id = config.get("workspace_id")
                            if _ws_id:
                                try:
                                    _dg_db = await get_db()
                                    try:
                                        _dg_cur = await _dg_db.execute(
                                            "SELECT task_summary, current_focus FROM session_digests "
                                            "WHERE workspace_id = ? AND (task_summary != '' OR current_focus != '') "
                                            "ORDER BY updated_at DESC LIMIT 3",
                                            (_ws_id,),
                                        )
                                        for _dg_row in await _dg_cur.fetchall():
                                            for _f in ("task_summary", "current_focus"):
                                                _v = (_dg_row[_f] or "").strip()
                                                if _v:
                                                    _skill_ctx_parts.append(_v[:200])
                                    finally:
                                        await _dg_db.close()
                                except Exception as _dg_err:
                                    logger.debug("Skill ctx digest enrichment skipped: %s", _dg_err)
                            _skill_ctx = " ".join(_skill_ctx_parts)
                            if _skill_ctx.strip():
                                _skill_block = await suggest_for_session(_skill_ctx)
                                if _skill_block:
                                    system_prompt_parts.append(_skill_block)
                    except Exception as _skill_err:
                        logger.debug("Skill suggestion injection skipped: %s", _skill_err)

                    # ── Auto-upgrade worker-class sessions to bypassPermissions ───
                    # Claude Code's `auto` and `default` permission modes still
                    # show prompts the safety gate hook can't bypass — most
                    # notably the folder-scope grant ("Yes, and always allow
                    # access to X/ from this project"), which is evaluated
                    # separately from PreToolUse hooks per Anthropic's docs.
                    # When experimental_safety_gate is on, the gate's rule set
                    # is the actual safety net (rm -rf, DROP TABLE, package
                    # supply-chain scans, etc.), so worker-class sessions can
                    # safely run with `bypassPermissions` — Claude still
                    # protects .git/.env/.claude/.mcp.json regardless. The
                    # operator's mode choice for Commander/Tester/Documentor
                    # is left untouched.
                    try:
                        if (config.get("session_type") in ("worker", "test_worker", "planner")
                            and (config.get("permission_mode") or "").lower() in ("auto", "default")):
                            db_sg = await get_db()
                            try:
                                _cur_sg = await db_sg.execute(
                                    "SELECT value FROM app_settings WHERE key = 'experimental_safety_gate'"
                                )
                                _sg_row = await _cur_sg.fetchone()
                                if _sg_row and _sg_row["value"] == "on":
                                    config["permission_mode"] = "bypassPermissions"
                                    logger.info(
                                        "Worker session %s upgraded to bypassPermissions "
                                        "(safety gate active; rules are the gate)",
                                        session_id[:8],
                                    )
                            finally:
                                await db_sg.close()
                    except Exception as _sg_err:
                        logger.debug("Safety-gate mode upgrade skipped: %s", _sg_err)

                    # ── Build CLI command via UnifiedSession ─────────────────
                    cli_type = config.get("cli_type", "claude")
                    session_obj = UnifiedSession(cli_type, config)

                    # Inject system prompt (guidelines, plugins, AGENTS.md, output style)
                    # Gemini: DON'T use -i flag. After -i processes its turn, ANY subsequent
                    # PTY write causes Gemini to exit (code 0) — confirmed by testing raw
                    # bytes, Ctrl-U, bracketed paste, and plain text. The -i flag puts Gemini
                    # in a state where the next input triggers a clean exit, regardless of
                    # what bytes are sent. Instead, queue for injection as first user turn.
                    _gemini_deferred_prompt = None
                    if system_prompt_parts:
                        combined_prompt = "\n\n".join(system_prompt_parts)
                        if cli_type == "gemini":
                            _gemini_deferred_prompt = combined_prompt
                        else:
                            session_obj.append_system_prompt(combined_prompt)

                    # ── MCP servers: strategy-driven dispatch ──
                    if mcp_servers_for_session:
                        # Per-session Playwright MCP arg overrides. The
                        # tester_headed tag (set via the "Show browser"
                        # checkbox in the Tester picker) strips --headless so
                        # the browser is visible. Default is headless.
                        try:
                            _session_tags = json.loads(config.get("tags") or "[]")
                        except (TypeError, ValueError):
                            _session_tags = []
                        if "tester_headed" in _session_tags:
                            for srv in mcp_servers_for_session:
                                if srv["id"] == "builtin-playwright":
                                    srv["args"] = [a for a in srv.get("args", []) if a != "--headless"]

                        # In frozen (compiled) mode, rewrite builtin MCP servers
                        # to use compiled binaries instead of python3 + script.py
                        from resource_path import is_frozen as _is_frozen
                        if _is_frozen():
                            from config import (MCP_SERVER_PATH as _MCP_PATH,
                                                WORKER_MCP_SERVER_PATH as _WORKER_PATH,
                                                DOCUMENTOR_MCP_SERVER_PATH as _DOC_PATH,
                                                DEEP_RESEARCH_MCP_PATH as _RESEARCH_PATH)
                            _FROZEN_MCP_MAP = {
                                "builtin-commander": str(_MCP_PATH),
                                "builtin-worker-board": str(_WORKER_PATH),
                                "builtin-documentor": str(_DOC_PATH),
                                "builtin-deep-research": str(_RESEARCH_PATH),
                            }
                            # Also match by .py script path for non-builtin IDs
                            # Sorted longest-first so "worker_mcp_server.py" matches
                            # before the shorter "mcp_server.py" substring.
                            _FROZEN_PATH_MAP = [
                                ("documentor_mcp_server.py", str(_DOC_PATH)),
                                ("worker_mcp_server.py", str(_WORKER_PATH)),
                                ("deep-research/mcp_server.py", str(_RESEARCH_PATH)),
                                ("mcp_server.py", str(_MCP_PATH)),
                            ]
                            for srv in mcp_servers_for_session:
                                if srv["id"] in _FROZEN_MCP_MAP:
                                    srv["command"] = _FROZEN_MCP_MAP[srv["id"]]
                                    srv["args"] = []
                                else:
                                    # Match by script path in args (longest first)
                                    args_str = " ".join(str(a) for a in srv.get("args", []))
                                    for script, binary in _FROZEN_PATH_MAP:
                                        if script in args_str:
                                            srv["command"] = binary
                                            srv["args"] = []
                                            break

                        auto_approved_names = []
                        # Always reset per PTY-start. ws_handler is a long-lived
                        # coroutine — without an explicit reset, MCPs from the
                        # previous session linger in this scope and contaminate
                        # the next session's config file.
                        _mcp_json = {"mcpServers": {}}

                        # Snapshot W2W flags now so the worker MCP can read them
                        # from env at startup instead of API-roundtripping back to
                        # this server (which races with our own startup). Read
                        # all three flags from the workspaces row; default '0'
                        # if the row is missing or query fails.
                        _w2w_comms_env = "0"
                        _w2w_context_env = "0"
                        _w2w_coord_env = "0"
                        try:
                            _w2w_db = await get_db()
                            try:
                                _w2w_cur = await _w2w_db.execute(
                                    "SELECT comms_enabled, context_sharing_enabled, "
                                    "coordination_enabled FROM workspaces WHERE id = ?",
                                    (config.get("workspace_id", ""),),
                                )
                                _w2w_row = await _w2w_cur.fetchone()
                                if _w2w_row:
                                    _w2w_comms_env = "1" if _w2w_row["comms_enabled"] else "0"
                                    _w2w_context_env = "1" if _w2w_row["context_sharing_enabled"] else "0"
                                    _w2w_coord_env = "1" if _w2w_row["coordination_enabled"] else "0"
                            finally:
                                await _w2w_db.close()
                        except Exception as _w2w_exc:
                            logger.debug("W2W env-flag fetch skipped: %s", _w2w_exc)

                        for srv in mcp_servers_for_session:
                            resolved_env = {}
                            for ek, ev in srv["env"].items():
                                resolved_env[ek] = (
                                    str(ev)
                                    .replace("{host}", HOST)
                                    .replace("{port}", str(PORT))
                                    .replace("{workspace_id}", config.get("workspace_id", ""))
                                    .replace("{workspace_path}", config.get("workspace_path", ""))
                                    .replace("{session_id}", session_id)
                                    .replace("{session_type}", config.get("session_type") or "worker")
                                    .replace("{w2w_comms}", _w2w_comms_env)
                                    .replace("{w2w_context}", _w2w_context_env)
                                    .replace("{w2w_coordination}", _w2w_coord_env)
                                )
                            effective_approve = (
                                srv["auto_approve_override"]
                                if srv["auto_approve_override"] is not None
                                else srv["auto_approve"]
                            )
                            if session_obj.profile.mcp_strategy == "mcp_add":
                                # mcp_add strategy: register via subprocess
                                ws_path = config.get("workspace_path", "")
                                if ws_path:
                                    try:
                                        await _asyncio.create_subprocess_exec(
                                            session_obj.profile.binary, "mcp", "remove", srv["server_name"],
                                            "--scope", "project", cwd=ws_path,
                                            stdout=_asyncio.subprocess.DEVNULL,
                                            stderr=_asyncio.subprocess.DEVNULL,
                                        )
                                    except Exception:
                                        pass
                                    add_cmd = [
                                        session_obj.profile.binary, "mcp", "add", srv["server_name"],
                                        srv["command"], *srv["args"],
                                        "--scope", "project",
                                        "--transport", srv.get("server_type", "stdio"),
                                    ]
                                    if effective_approve:
                                        add_cmd.append("--trust")
                                    for ek, ev in resolved_env.items():
                                        add_cmd.extend(["-e", f"{ek}={ev}"])
                                    try:
                                        proc = await _asyncio.create_subprocess_exec(
                                            *add_cmd, cwd=ws_path,
                                            stdout=_asyncio.subprocess.PIPE,
                                            stderr=_asyncio.subprocess.PIPE,
                                        )
                                        await proc.communicate()
                                    except Exception as e:
                                        logger.warning(f"Failed to register MCP {srv['server_name']}: {e}")
                            else:
                                # config_file strategy: collect into JSON config.
                                # _mcp_json is reset before the loop above.
                                entry = {"command": srv["command"], "args": srv["args"]}
                                if resolved_env:
                                    entry["env"] = resolved_env
                                _mcp_json["mcpServers"][srv["server_name"]] = entry
                            if effective_approve:
                                auto_approved_names.append(srv["server_name"])

                        if session_obj.profile.mcp_strategy == "mcp_add":
                            if auto_approved_names:
                                session_obj.set(Feature.ALLOWED_MCP_SERVERS, auto_approved_names)
                        else:
                            # Write config file and set allowed tools
                            MCP_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
                            mcp_cfg_path = MCP_CONFIG_DIR / f"session-{session_id}.json"
                            mcp_cfg_path.write_text(json.dumps(_mcp_json, indent=2))
                            session_obj.set(Feature.MCP_CONFIG_PATH, str(mcp_cfg_path))
                            _raw_tools = session_obj.get(Feature.ALLOWED_TOOLS) or []
                            existing_tools = json.loads(_raw_tools) if isinstance(_raw_tools, str) else list(_raw_tools)
                            for sname in auto_approved_names:
                                existing_tools.append(f"mcp__{sname}__*")
                            if existing_tools:
                                session_obj.set(Feature.ALLOWED_TOOLS, existing_tools)
                    elif config.get("session_type") == "commander" and session_obj.profile.mcp_strategy == "mcp_add":
                        session_obj.set(Feature.ALLOWED_MCP_SERVERS, ["commander"])
                    elif config.get("mcp_config"):
                        # Legacy fallback: session has old mcp_config file path
                        session_obj.set(Feature.MCP_CONFIG_PATH, config["mcp_config"])
                        is_commander = config.get("session_type") == "commander"
                        if (is_commander or config.get("auto_approve_mcp")) and config.get("mcp_config"):
                            try:
                                mcp_path = _Path(config["mcp_config"])
                                if mcp_path.exists():
                                    mcp_data = json.loads(mcp_path.read_text())
                                    _raw_tools = session_obj.get(Feature.ALLOWED_TOOLS) or []
                                    existing_tools = json.loads(_raw_tools) if isinstance(_raw_tools, str) else list(_raw_tools)
                                    for server_name in mcp_data.get("mcpServers", {}):
                                        from mcp_server import TOOLS as _MCP_TOOLS
                                        for tool_name in _MCP_TOOLS:
                                            existing_tools.append(f"mcp__{server_name}__{tool_name}")
                                    if existing_tools:
                                        session_obj.set(Feature.ALLOWED_TOOLS, existing_tools)
                            except Exception as e:
                                logger.warning(f"Failed to resolve legacy MCP tools: {e}")

                    # ── Resume: resolve native session ID ──
                    native_sid = config.get("native_session_id")
                    if native_sid:
                        if session_obj.profile.mcp_strategy == "mcp_add":
                            # Gemini: resolve filename stem to session index
                            resume_arg = _resolve_gemini_resume_index(config["workspace_path"], native_sid)
                            if resume_arg:
                                session_obj.set(Feature.RESUME_ID, resume_arg)
                            else:
                                logger.info(f"Session {session_id[:8]}: resume target not found, starting fresh")
                        else:
                            session_obj.set(Feature.RESUME_ID, native_sid)

                    # Mode policy: clamp Code mode + reject Brief PTY starts
                    # before build_command() reads the (now-mutated) config.
                    _ws_ctx = request.get("auth")
                    if _ws_ctx is not None and not _ws_ctx.is_owner:
                        try:
                            import mode_policy as _mode_policy
                            _bash_allow = await _get_code_bash_allowlist()
                            _mode_policy.enforce_mode_for_pty(
                                session_obj, _ws_ctx.mode,
                                code_bash_allowlist=_bash_allow,
                            )
                        except Exception as _mode_err:
                            try:
                                bus.emit(
                                    CommanderEvent.MODE_VIOLATION_BLOCKED,
                                    payload={
                                        "path": "/ws:start_pty",
                                        "session_id": session_id,
                                        "actor_kind": _ws_ctx.actor_kind,
                                        "actor_id": _ws_ctx.actor_id,
                                        "mode": _ws_ctx.mode,
                                        "reason": str(_mode_err),
                                    },
                                )
                            except Exception:
                                pass
                            await ws.send_json({
                                "session_id": session_id,
                                "type": "error",
                                "message": f"Mode-blocked: {_mode_err}",
                            })
                            continue

                    # Build final command
                    cmd = session_obj.build_command()
                    cmd_binary = cmd[0]
                    cmd_args = cmd[1:]

                    # Inject account auth — API key or OAuth HOME sandbox
                    extra_env = {}
                    if config.get("account_id"):
                        from account_sandbox import get_sandbox_home
                        db_acc = await get_db()
                        try:
                            cur_acc = await db_acc.execute(
                                "SELECT * FROM accounts WHERE id = ?",
                                (config["account_id"],),
                            )
                            acc_row = await cur_acc.fetchone()
                            if acc_row:
                                acc = dict(acc_row)
                                if acc.get("api_key"):
                                    # API key mode
                                    extra_env["ANTHROPIC_API_KEY"] = acc["api_key"]
                                elif acc.get("type") == "oauth":
                                    # OAuth sandbox mode — override HOME and (for
                                    # claude) CLAUDE_CONFIG_DIR so each account
                                    # reads its own .credentials.json instead of
                                    # the shared macOS keychain entry.
                                    sandbox_home = get_sandbox_home(acc["id"])
                                    if sandbox_home:
                                        extra_env["HOME"] = sandbox_home
                                        cli_type_for_acc = (config.get("cli_type") or "claude").lower()
                                        if cli_type_for_acc == "claude":
                                            from account_sandbox import claude_config_dir
                                            extra_env["CLAUDE_CONFIG_DIR"] = str(claude_config_dir(acc["id"]))
                                        logger.info(f"Session {session_id} using sandboxed HOME: {sandbox_home}")
                        finally:
                            await db_acc.close()

                    # Inject hook relay env vars so the CLI hook script
                    # can POST lifecycle events back to Commander.
                    extra_env["COMMANDER_SESSION_ID"] = session_id
                    extra_env["COMMANDER_API_URL"] = f"http://{HOST}:{PORT}"
                    extra_env["COMMANDER_WORKSPACE_ID"] = config.get("workspace_id", "")
                    extra_env["COMMANDER_CLI_TYPE"] = cli_type

                    # Myelin coordination: when the experimental flag is on,
                    # inject agent identity + DB path so the coordination
                    # hooks can track this session in the shared workspace.
                    # The namespace defaults to per-workspace but can be
                    # overridden via workspaces.coordination_namespace so
                    # multiple workspaces (e.g. monorepo, shared libs) can
                    # share a coordination scope.
                    try:
                        db_exp2 = await get_db()
                        try:
                            cur_exp2 = await db_exp2.execute(
                                "SELECT value FROM app_settings WHERE key = ?",
                                ("experimental_myelin_coordination",),
                            )
                            exp2_row = await cur_exp2.fetchone()
                            if exp2_row and exp2_row["value"] == "on":
                                extra_env["MYELIN_AGENT_ID"] = f"commander_{session_id[:12]}"
                                extra_env["MYELIN_DB_PATH"] = os.path.expanduser("~/.myelin/coord.db")
                                # Check for workspace-level namespace override
                                ws_id_for_ns = config.get("workspace_id", "default")
                                cur_ns = await db_exp2.execute(
                                    "SELECT coordination_namespace FROM workspaces WHERE id = ?",
                                    (ws_id_for_ns,),
                                )
                                ns_row = await cur_ns.fetchone()
                                custom_ns = (ns_row["coordination_namespace"] if ns_row and ns_row["coordination_namespace"] else None)
                                extra_env["MYELIN_NAMESPACE"] = custom_ns or f"commander:{ws_id_for_ns}"
                        finally:
                            await db_exp2.close()
                    except Exception:
                        pass  # non-fatal

                    try:
                        # Snapshot existing session files BEFORE starting PTY (for resume detection)
                        pre_files = None
                        if not config.get("native_session_id"):
                            pre_files = _snapshot_files_for_detection(cli_type, config["workspace_path"])
                        mark_pty_started(session_id)
                        await pty_mgr.start_session(
                            session_id, config["workspace_path"], cols, rows, cmd_args, extra_env, cmd_binary
                        )
                        await broadcast({"session_id": session_id, "type": "status", "status": "running"})

                        # Gemini deferred system prompt: inject as first user turn after ready.
                        # See comment above — -i flag causes exit on any subsequent PTY write.
                        if _gemini_deferred_prompt:
                            async def _inject_gemini_prompt(sid, prompt_text):
                                try:
                                    # Wait for Gemini TUI to be ready (detected in handle_pty_output)
                                    for _ in range(60):
                                        await _asyncio.sleep(1)
                                        if not pty_mgr.is_alive(sid):
                                            return
                                        if sid in _gemini_ready:
                                            break
                                    await _asyncio.sleep(3)
                                    if not pty_mgr.is_alive(sid):
                                        return
                                    # Write in chunks to avoid PTY buffer overflow (EAGAIN).
                                    # macOS PTY buffer is ~4096 bytes; our prompt can be 3000+.
                                    msg = prompt_text.encode("utf-8")
                                    pty_mgr.write(sid, b"\x1b[200~")  # bracketed paste start
                                    chunk_size = 2048
                                    for i in range(0, len(msg), chunk_size):
                                        pty_mgr.write(sid, msg[i:i+chunk_size])
                                        await _asyncio.sleep(0.05)
                                    pty_mgr.write(sid, b"\x1b[201~")  # bracketed paste end
                                    await _asyncio.sleep(0.3)
                                    pty_mgr.write(sid, b"\r")
                                    logger.info("Gemini deferred prompt injected for session %s (%d chars)", sid[:8], len(prompt_text))
                                except Exception as e:
                                    logger.warning("Gemini deferred prompt failed: %s", e)
                            _asyncio.ensure_future(_inject_gemini_prompt(session_id, _gemini_deferred_prompt))

                        # Session Advisor: track workspace mapping + seed intent with purpose
                        if config.get("workspace_id"):
                            _session_workspace[session_id] = config["workspace_id"]
                        try:
                            from session_advisor import update_intent
                            purpose = config.get("purpose")
                            if purpose:
                                _fire_and_forget(update_intent(
                                    session_id, purpose, source="purpose",
                                    workspace_id=config.get("workspace_id"),
                                    broadcast_fn=broadcast,
                                ))
                        except Exception:
                            pass
                        # Detect this session's specific conversation file for resume
                        if not config.get("native_session_id"):
                            _schedule_session_detection(cli_type, session_id, config["workspace_path"], pre_files)
                    except Exception as e:
                        logger.exception(f"Failed to start PTY for {session_id}")
                        await ws.send_json({
                            "session_id": session_id,
                            "type": "error",
                            "message": str(e),
                        })

                elif action == "input":
                    session_id = data.get("session_id")
                    input_data = data.get("data", "")
                    # BUG L7: surface dead session_ids instead of silently
                    # dropping the keystrokes — clients had no way to learn
                    # the PTY is gone short of polling.
                    if session_id and input_data and not pty_mgr.is_alive(session_id):
                        await ws.send_json({
                            "session_id": session_id,
                            "type": "error",
                            "message": "Session not running",
                        })
                        continue
                    if session_id and input_data:
                        # ── Gemini /branch interception ──
                        # Gemini has no native /branch — intercept on Enter
                        # and handle it at the Commander layer.
                        if "\r" in input_data or "\n" in input_data:
                            try:
                                if await _maybe_handle_gemini_branch(session_id):
                                    _input_bufs[session_id] = ""
                                    continue
                            except Exception as _br_err:
                                logger.warning("Gemini /branch interception failed: %s", _br_err)

                        # Check for @prompt: token expansion on Enter.
                        # Wrapped in try/except so any bug degrades to the
                        # normal passthrough — never blocks terminal input.
                        expansion = None
                        try:
                            expansion = await _maybe_expand_input(session_id, input_data)
                        except Exception as _exp_err:
                            logger.warning("Token expansion failed: %s", _exp_err)
                        if expansion is not None:
                            pty_mgr.write(session_id, expansion)
                        else:
                            pty_mgr.write(session_id, input_data.encode("utf-8"))
                            _track_input(session_id, input_data)
                        # Auto-unarchive: if user sends input to an archived session
                        try:
                            _fire_and_forget(_maybe_unarchive_on_input(session_id))
                        except Exception:
                            pass
                        # Detect /rename command → re-scan session for updated slug
                        if "/rename" in input_data:
                            cfg = await get_session_config(session_id)
                            if cfg:
                                _asyncio.ensure_future(detect_claude_session(session_id, cfg["workspace_path"], force_rename=True))

                elif action == "replay_turns":
                    session_id = data.get("session_id")
                    turns = data.get("turns", [])
                    if session_id and turns:
                        # Validate the session is alive before scheduling the
                        # 90s replay coroutine. Without this check, bogus IDs
                        # broadcast a 'replaying' status to every connected
                        # client and run silently for 90s (BUG H5).
                        if not pty_mgr.is_alive(session_id):
                            await ws.send_json({
                                "session_id": session_id,
                                "type": "error",
                                "message": "Session not running",
                            })
                            continue
                        asyncio.create_task(_replay_turns(session_id, turns))

                elif action == "resize":
                    session_id = data.get("session_id")
                    cols = data.get("cols", 120)
                    rows = data.get("rows", 40)
                    if session_id:
                        if not pty_mgr.is_alive(session_id):
                            await ws.send_json({
                                "session_id": session_id,
                                "type": "error",
                                "message": "Session not running",
                            })
                            continue
                        pty_mgr.resize(session_id, cols, rows)

                elif action == "replay_cache":
                    # Frontend asks for the rolling output cache without
                    # creating/restarting a PTY. Used when TerminalView
                    # remounts onto a still-alive session (close+reopen tab,
                    # StrictMode dev double-mount) — the new xterm starts
                    # with an empty buffer and would otherwise stay blank
                    # until the CLI happens to emit fresh output.
                    session_id = data.get("session_id")
                    if session_id and pty_mgr.is_alive(session_id):
                        cached = pty_mgr.get_cached_output(session_id)
                        if cached:
                            try:
                                await ws.send_json({
                                    "session_id": session_id,
                                    "type": "output",
                                    "data": cached.decode("utf-8", errors="replace"),
                                })
                            except (ConnectionResetError, ConnectionError, RuntimeError):
                                pass

                elif action == "broadcast":
                    session_ids = data.get("session_ids", [])
                    input_data = data.get("data", "")
                    source_session_id = data.get("source_session_id")
                    if session_ids and input_data:
                        encoded = input_data.encode("utf-8")
                        for sid in session_ids:
                            pty_mgr.write(sid, encoded)
                        # If a commander session broadcasts to workers, adopt them
                        if source_session_id:
                            asyncio.create_task(
                                _adopt_sessions(source_session_id, session_ids)
                            )

                elif action == "stop":
                    session_id = data.get("session_id")
                    if session_id:
                        if not pty_mgr.is_alive(session_id):
                            await ws.send_json({
                                "session_id": session_id,
                                "type": "error",
                                "message": "Session not running",
                            })
                            continue
                        await pty_mgr.stop_session(session_id)

                # ── Live Preview (Playwright browser) ──────────────
                # Multi-peer: previews are coalesced by share_key
                # (workspace_id + port). All subscribers receive frames;
                # one subscriber at a time holds the driver role.
                elif action == "preview_start":
                    url = data.get("url", "").strip()
                    if not url:
                        continue
                    if not url.startswith(("http://", "https://")):
                        url = "https://" + url
                    pw = data.get("width", 1280)
                    ph = data.get("height", 720)
                    workspace_id = data.get("workspace_id")
                    try:
                        import preview_browser
                        sub_id = _ws_subscriber_id(ws)
                        share_key = preview_browser.share_key_for(url, workspace_id)

                        async def _send_frame(b64, _ws=ws):
                            await _ws.send_json({"type": "preview_frame", "data": b64})

                        async def _send_nav(new_url, _ws=ws):
                            await _ws.send_json({"type": "preview_navigated", "url": new_url})

                        async def _send_driver(driver, _ws=ws):
                            await _ws.send_json({
                                "type": "preview_driver_changed",
                                "driver_id": driver,
                            })

                        pid, started_new, driver_id = await preview_browser.start_or_attach(
                            url=url,
                            width=pw,
                            height=ph,
                            share_key=share_key,
                            subscriber_id=sub_id,
                            on_frame=_send_frame,
                            on_navigate=_send_nav,
                            on_driver_changed=_send_driver,
                        )
                        ws_preview_subs.setdefault(id(ws), set()).add(pid)
                        await ws.send_json({
                            "type": "preview_started",
                            "preview_id": pid,
                            "url": url,
                            "share_key": share_key,
                            "shared": share_key is not None,
                            "started_new": started_new,
                            "driver_id": driver_id,
                            "is_driver": driver_id == sub_id,
                            "subscriber_id": sub_id,
                            "subscriber_count": preview_browser.subscriber_count(pid),
                        })
                    except Exception as e:
                        logger.warning("Preview start failed: %s", e)
                        await ws.send_json({"type": "preview_error", "error": str(e)})

                elif action == "preview_input":
                    pid = data.get("preview_id")
                    evt = data.get("event")
                    if pid and evt:
                        import preview_browser
                        sub_id = _ws_subscriber_id(ws)
                        ok = await preview_browser.send_input(pid, sub_id, evt)
                        if not ok:
                            await ws.send_json({
                                "type": "preview_driver_denied",
                                "preview_id": pid,
                                "driver_id": preview_browser.get_driver(pid),
                            })

                elif action == "preview_navigate":
                    pid = data.get("preview_id")
                    url = data.get("url", "").strip()
                    if pid and url:
                        if not url.startswith(("http://", "https://")):
                            url = "https://" + url
                        import preview_browser
                        sub_id = _ws_subscriber_id(ws)
                        ok = await preview_browser.navigate(pid, sub_id, url)
                        if not ok:
                            await ws.send_json({
                                "type": "preview_driver_denied",
                                "preview_id": pid,
                                "driver_id": preview_browser.get_driver(pid),
                            })

                elif action == "preview_resize":
                    pid = data.get("preview_id")
                    pw = data.get("width", 1280)
                    ph = data.get("height", 720)
                    if pid:
                        import preview_browser
                        sub_id = _ws_subscriber_id(ws)
                        await preview_browser.resize(pid, sub_id, pw, ph)

                elif action == "preview_claim_driver":
                    pid = data.get("preview_id")
                    if pid:
                        import preview_browser
                        sub_id = _ws_subscriber_id(ws)
                        await preview_browser.claim_driver(pid, sub_id)

                elif action == "preview_screenshot":
                    pid = data.get("preview_id")
                    if pid:
                        import preview_browser
                        png = await preview_browser.screenshot_png(pid)
                        if png:
                            import base64
                            await ws.send_json({
                                "type": "preview_screenshot",
                                "preview_id": pid,
                                "data": base64.b64encode(png).decode(),
                            })

                elif action == "preview_stop":
                    # In the multi-peer model this is "I'm leaving" — the
                    # page only actually shuts down once subscribers hit 0
                    # and the grace period elapses.
                    pid = data.get("preview_id")
                    if pid:
                        import preview_browser
                        sub_id = _ws_subscriber_id(ws)
                        await preview_browser.unsubscribe(pid, sub_id)
                        subs = ws_preview_subs.get(id(ws))
                        if subs:
                            subs.discard(pid)

                # ── Multiplayer presence ──────────────────────
                elif action == "hello":
                    client_id = data.get("client_id")
                    name = data.get("name", "Anonymous")
                    color = data.get("color", "#6366f1")
                    if client_id:
                        ws_peers.pop(client_id, None)
                        ws_peers[client_id] = {
                            "ws": ws,
                            "name": name,
                            "color": color,
                            "viewing_session": None,
                        }
                        # Send snapshot of existing peers to the joiner
                        snapshot = []
                        for cid, info in ws_peers.items():
                            if cid != client_id:
                                snapshot.append({
                                    "client_id": cid,
                                    "name": info["name"],
                                    "color": info["color"],
                                    "viewing_session": info["viewing_session"],
                                })
                        await ws.send_json({
                            "type": "presence_snapshot",
                            "peers": snapshot,
                        })
                        # Broadcast join to everyone else
                        join_msg = json.dumps({
                            "type": "presence_join",
                            "client_id": client_id,
                            "name": name,
                            "color": color,
                        })
                        for other_ws in ws_clients:
                            if other_ws is not ws:
                                try:
                                    await other_ws.send_str(join_msg)
                                except (ConnectionResetError, ConnectionError, RuntimeError):
                                    pass

                elif action == "presence_update":
                    client_id = data.get("client_id")
                    if client_id and client_id in ws_peers:
                        if "viewing_session" in data:
                            ws_peers[client_id]["viewing_session"] = data["viewing_session"]
                        if "name" in data:
                            ws_peers[client_id]["name"] = data["name"]
                        if "color" in data:
                            ws_peers[client_id]["color"] = data["color"]
                        info = ws_peers[client_id]
                        update_msg = json.dumps({
                            "type": "presence_update",
                            "client_id": client_id,
                            "name": info["name"],
                            "color": info["color"],
                            "viewing_session": info["viewing_session"],
                        })
                        for other_ws in ws_clients:
                            if other_ws is not ws:
                                try:
                                    await other_ws.send_str(update_msg)
                                except (ConnectionResetError, ConnectionError, RuntimeError):
                                    pass

            elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                break
    finally:
        ws_clients.discard(ws)
        # Unsubscribe from any active Playwright previews so the headless
        # pages are torn down (after grace period) instead of leaking.
        owned_pids = ws_preview_subs.pop(id(ws), set())
        if owned_pids:
            try:
                import preview_browser
                sub_id = _ws_subscriber_id(ws)
                for pid in owned_pids:
                    await preview_browser.unsubscribe(pid, sub_id)
            except Exception as e:
                logger.debug("Preview unsubscribe on disconnect failed: %s", e)
        # Clean up peer presence and notify others
        leaving_id = None
        for cid, info in ws_peers.items():
            if info["ws"] is ws:
                leaving_id = cid
                break
        if leaving_id:
            ws_peers.pop(leaving_id, None)
            leave_msg = json.dumps({
                "type": "presence_leave",
                "client_id": leaving_id,
            })
            for other_ws in ws_clients:
                try:
                    await other_ws.send_str(leave_msg)
                except (ConnectionResetError, ConnectionError, RuntimeError):
                    pass
        logger.info(f"WebSocket disconnected ({len(ws_clients)} total)")

    return ws


# ─── REST: Workspaces ────────────────────────────────────────────────────

async def list_workspaces(request: web.Request) -> web.Response:
    db = await get_db()
    try:
        # Sort by user-defined order first (order_index, ascending), then by last_used_at as a tiebreaker.
        # Workspaces that have never been reordered have order_index = 0 and fall back to recency.
        cur = await db.execute(
            "SELECT * FROM workspaces ORDER BY order_index ASC, last_used_at DESC NULLS LAST"
        )
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


async def reorder_workspaces(request: web.Request) -> web.Response:
    body = await request.json()
    ids = body.get("ids") or []
    if not isinstance(ids, list):
        return web.json_response({"error": "ids must be a list"}, status=400)
    db = await get_db()
    try:
        # Order indices are 1-based and densely packed by the order in `ids`.
        for idx, wid in enumerate(ids, start=1):
            await db.execute("UPDATE workspaces SET order_index = ? WHERE id = ?", (idx, wid))
        await db.commit()
        return web.json_response({"ok": True, "count": len(ids)})
    finally:
        await db.close()


async def browse_folder(request: web.Request) -> web.Response:
    """POST /api/browse-folder — open native OS folder picker and return selected path."""
    import asyncio
    import sys

    if sys.platform == "darwin":
        cmd = [
            "osascript", "-e",
            'set f to POSIX path of (choose folder with prompt "Select project folder")',
        ]
    elif sys.platform == "linux":
        cmd = ["zenity", "--file-selection", "--directory", "--title=Select project folder"]
    else:
        return web.json_response({"error": "unsupported platform"}, status=400)

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode != 0:
            return web.json_response({"error": "cancelled"}, status=400)
        path = stdout.decode().strip().rstrip("/")
        return web.json_response({"path": path})
    except FileNotFoundError:
        return web.json_response({"error": "folder picker not available"}, status=500)


async def create_workspace(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON body"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"error": "expected JSON object"}, status=400)
    path = str(body.get("path") or "").strip()
    name = str(body.get("name") or "").strip() or path.rstrip("/").split("/")[-1]
    if not path:
        return web.json_response({"error": "path required"}, status=400)

    import os
    expanded = os.path.expanduser(path)
    if not os.path.isdir(expanded):
        return web.json_response({"error": f"directory not found: {path}"}, status=400)
    path = os.path.abspath(expanded)
    name = name or path.rstrip("/").split("/")[-1]

    ws_id = str(uuid.uuid4())
    db = await get_db()
    try:
        existing = await db.execute(
            "SELECT id, name, path FROM workspaces WHERE path = ?", (path,)
        )
        existing_row = await existing.fetchone()
        if existing_row:
            # Only return identifying fields — the workspaces row may carry
            # browser profile paths and other internal state we don't want
            # to leak across the 409 boundary.
            return web.json_response({
                "error": "workspace already exists for this path",
                "existing": {
                    "id": existing_row["id"],
                    "name": existing_row["name"],
                    "path": existing_row["path"],
                },
            }, status=409)
        await db.execute(
            "INSERT INTO workspaces (id, name, path, auto_knowledge_enabled) "
            "VALUES (?, ?, ?, 1)",
            (ws_id, name, path),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM workspaces WHERE id = ?", (ws_id,))
        row = await cur.fetchone()
        return web.json_response(dict(row), status=201)
    finally:
        await db.close()


async def update_workspace(request: web.Request) -> web.Response:
    ws_id = request.match_info["id"]
    body = await request.json()
    db = await get_db()
    try:
        allowed = ("name", "human_oversight", "tester_mode", "research_model", "research_llm_url", "color", "preview_url", "coordination_namespace", "default_worktree",
                   "comms_enabled", "coordination_enabled", "context_sharing_enabled", "output_style",
                   "knowledge_context_limit", "native_terminals_enabled", "auto_register_terminals",
                   "auto_exec_enabled", "commander_max_workers", "tester_max_workers",
                   "research_max_iterations", "pipeline_enabled",
                   "task_dependencies_enabled", "auto_knowledge_enabled",
                   "board_doc_mode", "board_doc_new_column", "board_doc_existing_column")
        fields, values = [], []
        for key in allowed:
            if key in body:
                fields.append(f"{key} = ?")
                values.append(body[key])
        if not fields:
            return web.json_response({"error": "no fields"}, status=400)
        values.append(ws_id)
        await db.execute(f"UPDATE workspaces SET {', '.join(fields)} WHERE id = ?", values)
        await db.commit()

        # Bust W2W flag cache when workspace toggles change
        if any(k in body for k in ("comms_enabled", "coordination_enabled", "context_sharing_enabled")):
            try:
                from hooks import invalidate_w2w_cache
                invalidate_w2w_cache()  # clear all — workspace change affects all sessions
            except Exception:
                pass

        cur = await db.execute("SELECT * FROM workspaces WHERE id = ?", (ws_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "workspace not found"}, status=404)
        return web.json_response(dict(row))
    finally:
        await db.close()


async def delete_workspace(request: web.Request) -> web.Response:
    ws_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("DELETE FROM workspaces WHERE id = ?", (ws_id,))
        await db.commit()
        if cur.rowcount == 0:
            return web.json_response({"error": "workspace not found"}, status=404)
        return web.json_response({"ok": True})
    finally:
        await db.close()


# ─── REST: Sessions ──────────────────────────────────────────────────────

async def list_sessions(request: web.Request) -> web.Response:
    # Accept both ?workspace= (legacy) and ?workspace_id= (CLAUDE.md docs +
    # most clients). Previously only ?workspace= worked, so workers calling
    # with ?workspace_id= got every session in every workspace (BUG C5).
    workspace_id = request.query.get("workspace_id") or request.query.get("workspace")
    db = await get_db()
    try:
        # Sort by user-defined order first; recency is the tiebreaker for sessions that have
        # never been reordered (order_index = 0).
        if workspace_id:
            cur = await db.execute(
                "SELECT * FROM sessions WHERE workspace_id = ? "
                "ORDER BY order_index ASC, last_active_at DESC NULLS LAST",
                (workspace_id,),
            )
        else:
            cur = await db.execute(
                "SELECT * FROM sessions ORDER BY order_index ASC, last_active_at DESC NULLS LAST"
            )
        rows = await cur.fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["status"] = "running" if pty_mgr.is_alive(d["id"]) else "idle"
            # Parse tags from JSON string
            try:
                d["tags"] = json.loads(d.get("tags") or "[]")
            except (json.JSONDecodeError, TypeError):
                d["tags"] = []
            result.append(d)
        return web.json_response(result)
    finally:
        await db.close()


async def get_session_by_id(request: web.Request) -> web.Response:
    """Return a single session row as dict. Used by worker MCP for self-lookup
    (active_ticket_id, task_id, workspace_id) — all of which need a single
    point of truth that the agent can read mid-turn.
    """
    sid = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (sid,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "session not found"}, status=404)
        d = dict(row)
        d["status"] = "running" if pty_mgr.is_alive(d["id"]) else "idle"
        try:
            d["tags"] = json.loads(d.get("tags") or "[]")
        except (json.JSONDecodeError, TypeError):
            d["tags"] = []
        return web.json_response(d)
    finally:
        await db.close()


async def reorder_sessions(request: web.Request) -> web.Response:
    """Reorder sessions within a workspace.

    Body: { "workspace_id": "...", "ids": ["sess1", "sess2", ...] }
    """
    body = await request.json()
    workspace_id = body.get("workspace_id")
    ids = body.get("ids") or []
    if not workspace_id or not isinstance(ids, list):
        return web.json_response({"error": "workspace_id and ids list required"}, status=400)
    db = await get_db()
    try:
        for idx, sid in enumerate(ids, start=1):
            await db.execute(
                "UPDATE sessions SET order_index = ? WHERE id = ? AND workspace_id = ?",
                (idx, sid, workspace_id),
            )
        await db.commit()
        return web.json_response({"ok": True, "count": len(ids)})
    finally:
        await db.close()


async def create_session(request: web.Request) -> web.Response:
    body = await request.json()
    workspace_id = body.get("workspace_id")
    if not workspace_id:
        return web.json_response({"error": "workspace_id required"}, status=400)

    # Validate workspace exists before INSERT — without this, a bogus
    # workspace_id leaked the SQLite FK error as a 500 (BUG H2).
    _check_db = await get_db()
    try:
        cur = await _check_db.execute("SELECT id FROM workspaces WHERE id = ?", (workspace_id,))
        if not await cur.fetchone():
            return web.json_response({"error": "workspace not found"}, status=404)
    finally:
        await _check_db.close()

    session_id = str(uuid.uuid4())
    cli_type = body.get("cli_type", "claude")
    name = body.get("name", "").strip() or f"Session {session_id[:8]}"
    model = body.get("model", get_profile(cli_type).default_model)
    permission_mode = body.get("permission_mode", "auto")
    effort = body.get("effort", "high")
    system_prompt = body.get("system_prompt", "")
    plan_model = body.get("plan_model")
    execute_model = body.get("execute_model")
    auto_approve_plan = 1 if body.get("auto_approve_plan") else 0
    purpose = body.get("purpose", "").strip() or None

    # Inherit worktree default from workspace if not explicitly set
    worktree = body.get("worktree")
    if worktree is None:
        # Look up workspace default
        tmp_db = await get_db()
        try:
            cur = await tmp_db.execute("SELECT default_worktree FROM workspaces WHERE id = ?", (workspace_id,))
            ws_row = await cur.fetchone()
            worktree = 1 if (ws_row and ws_row["default_worktree"]) else 0
        finally:
            await tmp_db.close()
    else:
        worktree = 1 if worktree else 0

    db = await get_db()
    try:
        session_type = body.get("session_type", "worker")
        await db.execute(
            """INSERT INTO sessions (id, workspace_id, name, model, permission_mode, effort, system_prompt, cli_type, plan_model, execute_model, auto_approve_plan, worktree, purpose, session_type)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (session_id, workspace_id, name, model, permission_mode, effort, system_prompt or None, cli_type, plan_model, execute_model, auto_approve_plan, worktree, purpose, session_type),
        )
        await db.commit()

        # Auto-attach MCP servers based on session type
        if session_type == "commander":
            await db.execute(
                "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
                (session_id, "builtin-commander"),
            )
            await db.commit()
        elif session_type == "test_worker":
            # Test workers get Playwright MCP for browser automation
            await db.execute(
                "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
                (session_id, "builtin-playwright"),
            )
            # Also attach testing-agent guideline
            await db.execute(
                "INSERT OR IGNORE INTO session_guidelines (session_id, guideline_id) VALUES (?, ?)",
                (session_id, "builtin-testing-agent"),
            )
            # Store session_type so it's visible in listings
            await db.execute(
                "UPDATE sessions SET session_type = 'test_worker' WHERE id = ?",
                (session_id,),
            )
            await db.commit()

        # Auto-attach worker-board MCP and assign task when task_id is provided
        task_id = body.get("task_id")
        if task_id and session_type != "commander":
            # Attach the worker-board MCP server
            await db.execute(
                "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
                (session_id, "builtin-worker-board"),
            )
            # Assign the task to this session
            await db.execute(
                "UPDATE tasks SET assigned_session_id = ?, updated_at = datetime('now') WHERE id = ?",
                (session_id, task_id),
            )
            # Set pipeline_stage to 'implementing' for pipeline tasks
            await db.execute(
                "UPDATE tasks SET pipeline_stage = 'implementing' WHERE id = ? AND pipeline = 1 AND (pipeline_stage IS NULL OR pipeline_stage = '')",
                (task_id,),
            )
            await db.execute(
                """INSERT INTO task_events (task_id, event_type, actor, old_value, new_value, message)
                   VALUES (?, 'assigned_session_id_changed', 'commander', NULL, ?, ?)""",
                (task_id, session_id, f"Task assigned to worker session {name}"),
            )
            await db.commit()

        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        row = await cur.fetchone()
        result = dict(row)

        # Notify all clients about the new session
        await broadcast({"type": "session_created", "session": result})

        # Auto-start PTY if requested (e.g., from MCP create_session, or
        # from the pipeline engine's _auto_create_session — see BUG H6).
        if body.get("auto_start", False):
            await _autostart_session_pty(session_id)
    finally:
        await db.close()

    await bus.emit(CommanderEvent.SESSION_SPAWNED, {
        "session_id": session_id,
        "workspace_id": result.get("workspace_id"),
        "name": result.get("name"),
        "cli_type": result.get("cli_type"),
        "model": result.get("model"),
        "session_type": result.get("session_type"),
    }, source="api", actor="user")
    return web.json_response(result, status=201)


async def _autostart_session_pty(session_id: str):
    """Start a PTY for an already-created session row.

    Used by:
      • create_session(auto_start=True)
      • pipeline_engine._auto_create_session — auto-created stage sessions
        previously left a session row with no PTY, so the very next stage
        crashed on the is_alive check (BUG H6).
    """
    config = await get_session_config(session_id)
    if not config:
        logger.warning(f"_autostart_session_pty: no config for {session_id}")
        return
    cli_type = config.get("cli_type") or "claude"
    model = config.get("model")
    permission_mode = config.get("permission_mode", "auto")
    effort = config.get("effort", "high")
    system_prompt = config.get("system_prompt") or ""
    session_type = config.get("session_type") or ""

    # Worker-class bypassPermissions upgrade (d4dd9e7): when safety gate is on,
    # workers/test_workers/planners on auto/default get bypassPermissions so
    # folder-scope grants don't stall them. Safety gate rules remain the gate.
    try:
        if (session_type in ("worker", "test_worker", "planner")
            and (permission_mode or "").lower() in ("auto", "default")):
            db_sg = await get_db()
            try:
                cur_sg = await db_sg.execute(
                    "SELECT value FROM app_settings WHERE key = 'experimental_safety_gate'"
                )
                sg_row = await cur_sg.fetchone()
                if sg_row and sg_row["value"] == "on":
                    permission_mode = "bypassPermissions"
                    config["permission_mode"] = "bypassPermissions"
                    logger.info(
                        "Worker session %s (auto-start) upgraded to bypassPermissions "
                        "(safety gate active; rules are the gate)",
                        session_id[:8],
                    )
            finally:
                await db_sg.close()
    except Exception as sg_err:
        logger.debug("Safety-gate mode upgrade skipped (auto-start): %s", sg_err)

    auto_sess = UnifiedSession(cli_type, {
        "model": model,
        "permission_mode": permission_mode,
        "effort": effort,
    })
    if system_prompt:
        auto_sess.append_system_prompt(system_prompt)

    if auto_sess.profile.mcp_strategy == "config_file":
        db_mcp = await get_db()
        try:
            cur_mcp = await db_mcp.execute(
                """SELECT ms.*, sms.auto_approve_override
                   FROM mcp_servers ms
                   JOIN session_mcp_servers sms ON ms.id = sms.mcp_server_id
                   WHERE sms.session_id = ?""",
                (session_id,),
            )
            mcp_rows = await cur_mcp.fetchall()
            if mcp_rows:
                from resource_path import is_frozen as _auto_is_frozen
                _auto_frozen_map = {}
                _auto_frozen_paths = []
                if _auto_is_frozen():
                    from config import (MCP_SERVER_PATH as _aMCP, WORKER_MCP_SERVER_PATH as _aWRK,
                                        DOCUMENTOR_MCP_SERVER_PATH as _aDOC, DEEP_RESEARCH_MCP_PATH as _aRES)
                    _auto_frozen_map = {
                        "builtin-commander": str(_aMCP), "builtin-worker-board": str(_aWRK),
                        "builtin-documentor": str(_aDOC), "builtin-deep-research": str(_aRES),
                    }
                    _auto_frozen_paths = [
                        ("documentor_mcp_server.py", str(_aDOC)),
                        ("worker_mcp_server.py", str(_aWRK)),
                        ("deep-research/mcp_server.py", str(_aRES)),
                        ("mcp_server.py", str(_aMCP)),
                    ]

                mcp_json = {"mcpServers": {}}
                auto_approved_names = []

                # Snapshot W2W flags for env-var injection — same approach as the
                # manual-start resolver above. Worker MCP reads these from env
                # so it doesn't have to API-roundtrip at startup.
                _a_w2w_comms = "0"
                _a_w2w_context = "0"
                _a_w2w_coord = "0"
                try:
                    _a_w2w_db = await get_db()
                    try:
                        _a_w2w_cur = await _a_w2w_db.execute(
                            "SELECT comms_enabled, context_sharing_enabled, "
                            "coordination_enabled FROM workspaces WHERE id = ?",
                            (config.get("workspace_id", ""),),
                        )
                        _a_w2w_row = await _a_w2w_cur.fetchone()
                        if _a_w2w_row:
                            _a_w2w_comms = "1" if _a_w2w_row["comms_enabled"] else "0"
                            _a_w2w_context = "1" if _a_w2w_row["context_sharing_enabled"] else "0"
                            _a_w2w_coord = "1" if _a_w2w_row["coordination_enabled"] else "0"
                    finally:
                        await _a_w2w_db.close()
                except Exception as _a_w2w_exc:
                    logger.debug("W2W env-flag fetch (autostart) skipped: %s", _a_w2w_exc)

                for row_mcp in mcp_rows:
                    srv = dict(row_mcp)
                    srv_args = json.loads(srv["args"] or "[]")
                    srv_env = json.loads(srv["env"] or "{}")
                    if srv["id"] in _auto_frozen_map:
                        srv["command"] = _auto_frozen_map[srv["id"]]
                        srv_args = []
                    elif _auto_frozen_paths:
                        args_str = " ".join(str(a) for a in srv_args)
                        for script, binary in _auto_frozen_paths:
                            if script in args_str:
                                srv["command"] = binary
                                srv_args = []
                                break

                    resolved_env = {}
                    for ek, ev in srv_env.items():
                        resolved_env[ek] = (
                            str(ev)
                            .replace("{host}", HOST)
                            .replace("{port}", str(PORT))
                            .replace("{workspace_id}", config.get("workspace_id", ""))
                            .replace("{session_id}", session_id)
                            .replace("{session_type}", config.get("session_type") or "worker")
                            .replace("{w2w_comms}", _a_w2w_comms)
                            .replace("{w2w_context}", _a_w2w_context)
                            .replace("{w2w_coordination}", _a_w2w_coord)
                        )
                    entry = {"command": srv["command"], "args": srv_args}
                    if resolved_env:
                        entry["env"] = resolved_env
                    mcp_json["mcpServers"][srv["server_name"]] = entry
                    effective_approve = (
                        srv["auto_approve_override"]
                        if srv["auto_approve_override"] is not None
                        else srv["auto_approve"]
                    )
                    if effective_approve:
                        auto_approved_names.append(srv["server_name"])
                MCP_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
                mcp_cfg_path = MCP_CONFIG_DIR / f"session-{session_id}.json"
                mcp_cfg_path.write_text(json.dumps(mcp_json, indent=2))
                auto_sess.set(Feature.MCP_CONFIG_PATH, str(mcp_cfg_path))
                existing_tools = []
                for sname in auto_approved_names:
                    existing_tools.append(f"mcp__{sname}__*")
                if existing_tools:
                    auto_sess.set(Feature.ALLOWED_TOOLS, existing_tools)
        finally:
            await db_mcp.close()

    cmd = auto_sess.build_command()

    # Mirror the manual-start path's extra_env construction so auto-started
    # PTYs also get account auth + hook relay env vars. Without these, hooks
    # can't POST lifecycle events back, breaking session_state, plan
    # detection, oversight, etc.
    extra_env: dict[str, str] = {}
    if config.get("account_id"):
        from account_sandbox import get_sandbox_home
        db_acc = await get_db()
        try:
            cur_acc = await db_acc.execute(
                "SELECT * FROM accounts WHERE id = ?",
                (config["account_id"],),
            )
            acc_row = await cur_acc.fetchone()
            if acc_row:
                acc = dict(acc_row)
                if acc.get("api_key"):
                    extra_env["ANTHROPIC_API_KEY"] = acc["api_key"]
                elif acc.get("type") == "oauth":
                    sandbox_home = get_sandbox_home(acc["id"])
                    if sandbox_home:
                        extra_env["HOME"] = sandbox_home
                        cli_type_for_acc = (config.get("cli_type") or "claude").lower()
                        if cli_type_for_acc == "claude":
                            from account_sandbox import claude_config_dir
                            extra_env["CLAUDE_CONFIG_DIR"] = str(claude_config_dir(acc["id"]))
        finally:
            await db_acc.close()

    extra_env["COMMANDER_SESSION_ID"] = session_id
    extra_env["COMMANDER_API_URL"] = f"http://{HOST}:{PORT}"
    extra_env["COMMANDER_WORKSPACE_ID"] = config.get("workspace_id", "")
    extra_env["COMMANDER_CLI_TYPE"] = cli_type

    try:
        pre_files = _snapshot_files_for_detection(cli_type, config["workspace_path"])
        mark_pty_started(session_id)
        await pty_mgr.start_session(session_id, config["workspace_path"], 120, 40, cmd[1:], extra_env, cmd[0])
        await broadcast({"session_id": session_id, "type": "status", "status": "running"})
        _schedule_session_detection(cli_type, session_id, config["workspace_path"], pre_files)
    except Exception as e:
        logger.warning(f"Auto-start PTY failed for {session_id}: {e}")


async def delete_session(request: web.Request) -> web.Response:
    session_id = request.match_info["id"]
    # MCP-S4: a worker MCP caller cannot kill sibling sessions. Allow only
    # commander or self-deletion.
    caller = await _resolve_caller(request)
    if caller and caller["session_type"] not in ("commander",):
        if caller["session_id"] != session_id:
            return web.json_response(
                {"error": "forbidden: only commander or the session itself can delete a session"},
                status=403,
            )
    await pty_mgr.stop_session(session_id)
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT workspace_id, name FROM sessions WHERE id = ?", (session_id,)
        )
        row = await cur.fetchone()
        session_meta = dict(row) if row else {}
        await db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        await db.commit()
    finally:
        await db.close()

    await bus.emit(CommanderEvent.SESSION_DELETED, {
        "session_id": session_id,
        "workspace_id": session_meta.get("workspace_id"),
        "name": session_meta.get("name"),
    }, source="api", actor="user")
    return web.json_response({"ok": True})


# ─── REST: Messages ──────────────────────────────────────────────────────

async def list_messages(request: web.Request) -> web.Response:
    session_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("SELECT 1 FROM sessions WHERE id = ?", (session_id,))
        if not await cur.fetchone():
            return web.json_response({"error": "session not found"}, status=404)
        cur = await db.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at",
            (session_id,),
        )
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


# ─── REST: Prompts ────────────────────────────────────────────────────────

async def list_prompts(request: web.Request) -> web.Response:
    category = request.query.get("category")
    quickaction = request.query.get("quickaction")
    db = await get_db()
    try:
        if quickaction == "1":
            cur = await db.execute(
                "SELECT * FROM prompts WHERE is_quickaction = 1 ORDER BY quickaction_order ASC, usage_count DESC"
            )
        elif category:
            cur = await db.execute(
                "SELECT * FROM prompts WHERE category = ? ORDER BY pinned DESC, usage_count DESC",
                (category,),
            )
        else:
            cur = await db.execute("SELECT * FROM prompts ORDER BY pinned DESC, usage_count DESC")
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


async def create_prompt(request: web.Request) -> web.Response:
    body = await request.json()
    name = body.get("name", "").strip()
    content = body.get("content", "").strip()
    if not name or not content:
        return web.json_response({"error": "name and content required"}, status=400)

    prompt_id = str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO prompts (id, name, category, content, variables, tags,
               is_quickaction, quickaction_order, icon, color, source_type, source_url)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (prompt_id, name, body.get("category", "General"),
             content, body.get("variables", ""), body.get("tags", ""),
             body.get("is_quickaction", 0), body.get("quickaction_order", 0),
             body.get("icon"), body.get("color"), body.get("source_type"), body.get("source_url")),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM prompts WHERE id = ?", (prompt_id,))
        row = await cur.fetchone()
        return web.json_response(dict(row), status=201)
    finally:
        await db.close()


async def update_prompt(request: web.Request) -> web.Response:
    prompt_id = request.match_info["id"]
    body = await request.json()
    db = await get_db()
    try:
        fields, values = [], []
        for key in ("name", "content", "category", "variables", "tags", "pinned",
                    "is_quickaction", "quickaction_order", "icon", "color"):
            if key in body:
                fields.append(f"{key} = ?")
                values.append(body[key])
        if not fields:
            return web.json_response({"error": "no fields to update"}, status=400)
        fields.append("updated_at = datetime('now')")
        values.append(prompt_id)
        await db.execute(f"UPDATE prompts SET {', '.join(fields)} WHERE id = ?", values)
        await db.commit()
        cur = await db.execute("SELECT * FROM prompts WHERE id = ?", (prompt_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "prompt not found"}, status=404)
        return web.json_response(dict(row))
    finally:
        await db.close()


async def delete_prompt(request: web.Request) -> web.Response:
    prompt_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("DELETE FROM prompts WHERE id = ?", (prompt_id,))
        await db.commit()
        if cur.rowcount == 0:
            return web.json_response({"error": "prompt not found"}, status=404)
        return web.json_response({"ok": True})
    finally:
        await db.close()


async def use_prompt(request: web.Request) -> web.Response:
    """Increment usage count and return the prompt."""
    prompt_id = request.match_info["id"]
    db = await get_db()
    try:
        await db.execute(
            "UPDATE prompts SET usage_count = usage_count + 1 WHERE id = ?",
            (prompt_id,),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM prompts WHERE id = ?", (prompt_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(dict(row))
    finally:
        await db.close()


async def reorder_quickactions(request: web.Request) -> web.Response:
    """Set quickaction_order for a list of prompt IDs."""
    body = await request.json()
    ids = body.get("ids", [])
    if not ids:
        return web.json_response({"error": "ids required"}, status=400)
    db = await get_db()
    try:
        for idx, pid in enumerate(ids):
            await db.execute(
                "UPDATE prompts SET quickaction_order = ? WHERE id = ?",
                (idx, pid),
            )
        await db.commit()
        return web.json_response({"ok": True})
    finally:
        await db.close()


# ─── REST: Guidelines ─────────────────────────────────────────────────────

async def list_guidelines(request: web.Request) -> web.Response:
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM guidelines ORDER BY is_default DESC, name")
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


async def create_guideline(request: web.Request) -> web.Response:
    body = await request.json()
    name = body.get("name", "").strip()
    content = body.get("content", "").strip()
    if not name or not content:
        return web.json_response({"error": "name and content required"}, status=400)

    gid = str(uuid.uuid4())
    when_to_use = body.get("when_to_use", "").strip() or None
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO guidelines (id, name, content, is_default, when_to_use) VALUES (?, ?, ?, ?, ?)",
            (gid, name, content, 1 if body.get("is_default") else 0, when_to_use),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM guidelines WHERE id = ?", (gid,))
        row = await cur.fetchone()
        result = dict(row)
        # Session Advisor: embed guideline for recommendation
        try:
            from embedder import embed_guideline
            _fire_and_forget(embed_guideline(result))
        except Exception:
            pass
        return web.json_response(result, status=201)
    finally:
        await db.close()


async def update_guideline(request: web.Request) -> web.Response:
    gid = request.match_info["id"]
    body = await request.json()
    db = await get_db()
    try:
        fields, values = [], []
        for key in ("name", "content", "is_default", "when_to_use"):
            if key in body:
                fields.append(f"{key} = ?")
                values.append(body[key])
        if not fields:
            return web.json_response({"error": "no fields to update"}, status=400)
        fields.append("updated_at = datetime('now')")
        values.append(gid)
        await db.execute(f"UPDATE guidelines SET {', '.join(fields)} WHERE id = ?", values)
        await db.commit()
        cur = await db.execute("SELECT * FROM guidelines WHERE id = ?", (gid,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "guideline not found"}, status=404)
        result = dict(row)
        # Session Advisor: re-embed guideline
        try:
            from embedder import embed_guideline
            _fire_and_forget(embed_guideline(result))
        except Exception:
            pass
        return web.json_response(result)
    finally:
        await db.close()


async def delete_guideline(request: web.Request) -> web.Response:
    gid = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("SELECT is_builtin FROM guidelines WHERE id = ?", (gid,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "not found"}, status=404)
        if row["is_builtin"]:
            return web.json_response(
                {"error": "Cannot delete built-in guideline. You can edit it instead."},
                status=403,
            )
        await db.execute("DELETE FROM guidelines WHERE id = ?", (gid,))
        await db.commit()
        # Session Advisor: remove embedding
        try:
            from embedder import remove_guideline_embedding
            _fire_and_forget(remove_guideline_embedding(gid))
        except Exception:
            pass
        return web.json_response({"ok": True})
    finally:
        await db.close()


async def get_session_guidelines(request: web.Request) -> web.Response:
    session_id = request.match_info["id"]
    db = await get_db()
    try:
        cur0 = await db.execute("SELECT 1 FROM sessions WHERE id = ?", (session_id,))
        if not await cur0.fetchone():
            return web.json_response({"error": "session not found"}, status=404)
        cur = await db.execute(
            """SELECT g.* FROM guidelines g
               JOIN session_guidelines sg ON g.id = sg.guideline_id
               WHERE sg.session_id = ?""",
            (session_id,),
        )
        rows = await cur.fetchall()
        guidelines = [dict(r) for r in rows]

        # Also return which guidelines are ACTUALLY in the running system
        # prompt (set at PTY start). The GuidelinePanel uses this to show
        # accurate "active" vs "pending" vs "still cached" labels.
        cur2 = await db.execute(
            "SELECT active_guideline_ids FROM sessions WHERE id = ?",
            (session_id,),
        )
        session_row = await cur2.fetchone()
        active_ids = []
        if session_row and session_row["active_guideline_ids"]:
            try:
                active_ids = json.loads(session_row["active_guideline_ids"])
            except (json.JSONDecodeError, TypeError):
                pass
        # BUG M14: when no PTY has started yet (or active list was never
        # written), surface the attachments as the effective active list so
        # the GuidelinePanel doesn't show every guideline as "pending"
        # immediately after the user attaches them.
        if not active_ids and guidelines:
            active_ids = [g["id"] for g in guidelines]

        return web.json_response({
            "guidelines": guidelines,
            "active_guideline_ids": active_ids,
        })
    finally:
        await db.close()


async def set_session_guidelines(request: web.Request) -> web.Response:
    session_id = request.match_info["id"]
    body = await request.json()
    guideline_ids = body.get("guideline_ids", [])
    db = await get_db()
    try:
        await db.execute("DELETE FROM session_guidelines WHERE session_id = ?", (session_id,))
        for gid in guideline_ids:
            await db.execute(
                "INSERT INTO session_guidelines (session_id, guideline_id) VALUES (?, ?)",
                (session_id, gid),
            )
        await db.commit()
        return web.json_response({"ok": True, "count": len(guideline_ids)})
    finally:
        await db.close()


# ─── REST: Session Advisor ─────────────────────────────────────────────────


async def recommend_session_guidelines(request: web.Request) -> web.Response:
    """GET /api/sessions/{id}/recommend-guidelines — advisor recommendations."""
    session_id = request.match_info["id"]
    limit = int(request.query.get("limit", "5"))
    min_confidence = float(request.query.get("min_confidence", "0.3"))

    # Get intent from accumulator, or build from session digest/purpose
    from session_advisor import get_intent_text, recommend_guidelines as _recommend
    intent = await get_intent_text(session_id)

    if not intent:
        # Fallback: try session purpose or digest
        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT purpose, workspace_id FROM sessions WHERE id = ?",
                (session_id,),
            )
            row = await cur.fetchone()
            if row:
                intent = row["purpose"] or ""
                workspace_id = row["workspace_id"]
            else:
                return web.json_response({"recommendations": [], "task_text": ""})

            if not intent:
                # Try digest
                cur2 = await db.execute(
                    "SELECT task_summary, current_focus FROM session_digests WHERE session_id = ?",
                    (session_id,),
                )
                digest_row = await cur2.fetchone()
                if digest_row:
                    parts = []
                    if digest_row["task_summary"]:
                        parts.append(digest_row["task_summary"])
                    if digest_row["current_focus"]:
                        parts.append(digest_row["current_focus"])
                    intent = " | ".join(parts)
        finally:
            await db.close()
    else:
        db = await get_db()
        try:
            cur = await db.execute("SELECT workspace_id FROM sessions WHERE id = ?", (session_id,))
            row = await cur.fetchone()
            workspace_id = row["workspace_id"] if row else None
        finally:
            await db.close()

    if not intent:
        return web.json_response({"recommendations": [], "task_text": ""})

    # Get currently attached + dismissed guideline IDs to exclude
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT guideline_id FROM session_guidelines WHERE session_id = ?",
            (session_id,),
        )
        attached = {row["guideline_id"] for row in await cur.fetchall()}
    finally:
        await db.close()

    # Also exclude dismissed recommendations from intent buffer
    from session_advisor import _intent_buffers, MIN_SCORE_EARLY, MIN_SCORE_NORMAL
    dismissed = set()
    buf = _intent_buffers.get(session_id)
    if buf:
        dismissed = buf._dismissed

    # Dynamic min_score: strict early, relaxes with context
    if buf and len(buf.user_messages) >= 3:
        effective_min_score = max(min_confidence, MIN_SCORE_NORMAL)
    else:
        effective_min_score = max(min_confidence, MIN_SCORE_EARLY)

    recs = await _recommend(
        intent, workspace_id=workspace_id, session_id=session_id,
        excluded=attached | dismissed, limit=limit, min_score=effective_min_score,
    )

    return web.json_response({"recommendations": recs, "task_text": intent[:200]})


async def get_guideline_effectiveness(request: web.Request) -> web.Response:
    """GET /api/guidelines/effectiveness — effectiveness leaderboard."""
    workspace_id = request.query.get("workspace_id")

    db = await get_db()
    try:
        if workspace_id:
            cur = await db.execute(
                """SELECT ge.*, g.name as guideline_name
                   FROM guideline_effectiveness ge
                   JOIN guidelines g ON ge.guideline_id = g.id
                   WHERE ge.workspace_id = ?
                   ORDER BY ge.avg_quality DESC""",
                (workspace_id,),
            )
        else:
            cur = await db.execute(
                """SELECT ge.*, g.name as guideline_name
                   FROM guideline_effectiveness ge
                   JOIN guidelines g ON ge.guideline_id = g.id
                   ORDER BY ge.avg_quality DESC""",
            )
        rows = await cur.fetchall()
        return web.json_response({"effectiveness": [dict(r) for r in rows]})
    finally:
        await db.close()


async def analyze_session_endpoint(request: web.Request) -> web.Response:
    """POST /api/sessions/{id}/analyze — manually trigger post-session analysis."""
    session_id = request.match_info["id"]

    from session_advisor import analyze_session
    _fire_and_forget(analyze_session(session_id))

    return web.json_response({"ok": True, "session_id": session_id, "status": "analyzing"})


async def dismiss_guideline_recommendation(request: web.Request) -> web.Response:
    """POST /api/sessions/{id}/dismiss-recommendation — dismiss a guideline recommendation."""
    session_id = request.match_info["id"]
    body = await request.json()
    guideline_id = body.get("guideline_id")
    if not guideline_id:
        return web.json_response({"error": "guideline_id required"}, status=400)

    from session_advisor import dismiss_recommendation
    await dismiss_recommendation(session_id, guideline_id)

    return web.json_response({"ok": True})


# ─── REST: MCP Servers ────────────────────────────────────────────────────


async def list_mcp_servers(request: web.Request) -> web.Response:
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM mcp_servers ORDER BY default_enabled DESC, name")
        rows = await cur.fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["args"] = json.loads(d["args"] or "[]")
            d["env"] = json.loads(d["env"] or "{}")
            result.append(d)
        return web.json_response(result)
    finally:
        await db.close()


async def create_mcp_server(request: web.Request) -> web.Response:
    body = await request.json()
    name = body.get("name", "").strip()
    server_name = body.get("server_name", "").strip()
    command = body.get("command", "").strip()
    if not name or not server_name or not command:
        return web.json_response({"error": "name, server_name, and command required"}, status=400)

    sid = str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO mcp_servers
               (id, name, server_name, description, server_type, command, args, env,
                auto_approve, default_enabled)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (sid, name, server_name, body.get("description", ""),
             body.get("server_type", "stdio"), command,
             json.dumps(body.get("args", [])),
             json.dumps(body.get("env", {})),
             1 if body.get("auto_approve") else 0,
             1 if body.get("default_enabled") else 0),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM mcp_servers WHERE id = ?", (sid,))
        row = await cur.fetchone()
        d = dict(row)
        d["args"] = json.loads(d["args"] or "[]")
        d["env"] = json.loads(d["env"] or "{}")
        return web.json_response(d, status=201)
    except Exception as e:
        if "UNIQUE" in str(e):
            return web.json_response({"error": f"server_name '{server_name}' already exists"}, status=409)
        raise
    finally:
        await db.close()


async def update_mcp_server(request: web.Request) -> web.Response:
    sid = request.match_info["id"]
    body = await request.json()
    db = await get_db()
    try:
        fields, values = [], []
        for key in ("name", "server_name", "description", "server_type", "command",
                     "auto_approve", "default_enabled"):
            if key in body:
                fields.append(f"{key} = ?")
                values.append(body[key])
        # JSON fields need encoding
        for key in ("args", "env"):
            if key in body:
                fields.append(f"{key} = ?")
                values.append(json.dumps(body[key]))
        if not fields:
            return web.json_response({"error": "no fields to update"}, status=400)
        fields.append("updated_at = datetime('now')")
        values.append(sid)
        await db.execute(f"UPDATE mcp_servers SET {', '.join(fields)} WHERE id = ?", values)
        await db.commit()
        cur = await db.execute("SELECT * FROM mcp_servers WHERE id = ?", (sid,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "not found"}, status=404)
        d = dict(row)
        d["args"] = json.loads(d["args"] or "[]")
        d["env"] = json.loads(d["env"] or "{}")
        return web.json_response(d)
    finally:
        await db.close()


async def delete_mcp_server(request: web.Request) -> web.Response:
    sid = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("SELECT is_builtin FROM mcp_servers WHERE id = ?", (sid,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "not found"}, status=404)
        if row["is_builtin"]:
            return web.json_response({"error": "cannot delete built-in MCP server"}, status=403)
        await db.execute("DELETE FROM mcp_servers WHERE id = ?", (sid,))
        await db.commit()
        return web.json_response({"ok": True})
    finally:
        await db.close()


async def parse_mcp_docs(request: web.Request) -> web.Response:
    """Launch a background job to parse MCP server docs into a server config."""
    body = await request.json()
    docs = (body.get("docs") or "").strip()
    if not docs:
        return web.json_response({"error": "docs text required"}, status=400)

    prompt = f"""Parse the following MCP server documentation and extract the configuration needed to run it.

Return ONLY a valid JSON object with these fields:
- "name": display name (e.g. "Playwright")
- "server_name": kebab-case identifier (e.g. "playwright")
- "description": one-line description of what the server does
- "command": the executable command (e.g. "npx", "uvx", "python3", "node")
- "args": array of command arguments (e.g. ["-y", "@playwright/mcp@latest"])
- "env": object of required environment variables with placeholder values (e.g. {{"API_KEY": "your-api-key-here"}})
- "server_type": "stdio" or "sse" (default "stdio")

If the docs mention multiple transport options, prefer stdio.
If environment variables are optional, still include them with descriptive placeholder values.

Documentation:
{docs}

Return ONLY the JSON object, no markdown fences, no explanation."""

    job_id = str(uuid.uuid4())
    _background_jobs[job_id] = {
        "type": "mcp_parse",
        "status": "queued",
    }

    import asyncio as _asyncio
    _asyncio.ensure_future(_run_background_llm_job(
        job_id=job_id,
        job_type="mcp_parse",
        cli=body.get("cli", "claude"),
        model=body.get("model") or "haiku",
        prompt=prompt,
        extra={},
        timeout=60,
    ))

    return web.json_response({"job_id": job_id, "status": "started"})


async def get_session_mcp_servers(request: web.Request) -> web.Response:
    session_id = request.match_info["id"]
    db = await get_db()
    try:
        cur0 = await db.execute("SELECT 1 FROM sessions WHERE id = ?", (session_id,))
        if not await cur0.fetchone():
            return web.json_response({"error": "session not found"}, status=404)
        cur = await db.execute(
            """SELECT ms.*, sms.auto_approve_override
               FROM mcp_servers ms
               JOIN session_mcp_servers sms ON ms.id = sms.mcp_server_id
               WHERE sms.session_id = ?""",
            (session_id,),
        )
        rows = await cur.fetchall()
        servers = []
        for r in rows:
            d = dict(r)
            d["args"] = json.loads(d["args"] or "[]")
            d["env"] = json.loads(d["env"] or "{}")
            servers.append(d)

        cur2 = await db.execute(
            "SELECT active_mcp_server_ids FROM sessions WHERE id = ?",
            (session_id,),
        )
        session_row = await cur2.fetchone()
        active_ids = []
        if session_row and session_row["active_mcp_server_ids"]:
            try:
                active_ids = json.loads(session_row["active_mcp_server_ids"])
            except (json.JSONDecodeError, TypeError):
                pass

        return web.json_response({
            "mcp_servers": servers,
            "active_mcp_server_ids": active_ids,
        })
    finally:
        await db.close()


async def set_session_mcp_servers(request: web.Request) -> web.Response:
    session_id = request.match_info["id"]
    body = await request.json()
    mcp_server_ids = body.get("mcp_server_ids", [])
    overrides = body.get("overrides", {})
    db = await get_db()
    try:
        await db.execute("DELETE FROM session_mcp_servers WHERE session_id = ?", (session_id,))
        for mid in mcp_server_ids:
            override = overrides.get(mid, {})
            auto_override = override.get("auto_approve_override")
            await db.execute(
                "INSERT INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, ?)",
                (session_id, mid, auto_override),
            )
        await db.commit()
        return web.json_response({"ok": True, "count": len(mcp_server_ids)})
    finally:
        await db.close()


# ─── REST: History & Export ────────────────────────────────────────────────

async def list_history_projects(request: web.Request) -> web.Response:
    projects = list_projects()
    return web.json_response(projects)


async def import_history(request: web.Request) -> web.Response:
    body = await request.json()
    file_path = body.get("file")
    workspace_id = body.get("workspace_id")
    session_name = body.get("name", "Imported Session")

    if not file_path or not workspace_id:
        return web.json_response({"error": "file and workspace_id required"}, status=400)

    messages = read_session_messages(file_path)
    if not messages:
        return web.json_response({"error": "no messages found"}, status=400)

    session_id = str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO sessions (id, workspace_id, name, is_imported)
               VALUES (?, ?, ?, 1)""",
            (session_id, workspace_id, session_name),
        )
        inserted = 0
        for msg in messages:
            normalized = normalize_jsonl_entry(msg)
            if normalized is None:
                continue
            role, content = normalized
            if isinstance(content, list):
                content = json.dumps(content)
            elif not isinstance(content, str):
                content = str(content)
            await db.execute(
                "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)",
                (session_id, role, content),
            )
            inserted += 1
        await db.commit()
        if inserted == 0:
            await db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            await db.commit()
            return web.json_response({"error": "no conversation messages found"}, status=400)
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        row = await cur.fetchone()
        return web.json_response(dict(row), status=201)
    finally:
        await db.close()


async def export_session(request: web.Request) -> web.Response:
    session_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at",
            (session_id,),
        )
        rows = await cur.fetchall()
        messages = [dict(r) for r in rows]

        cur2 = await db.execute(
            """SELECT s.scratchpad, s.native_session_id, w.path AS workspace_path
               FROM sessions s
               LEFT JOIN workspaces w ON s.workspace_id = w.id
               WHERE s.id = ?""",
            (session_id,),
        )
        sess_row = await cur2.fetchone()
        scratchpad = (sess_row["scratchpad"] or "") if sess_row else ""
        native_sid = sess_row["native_session_id"] if sess_row else None
        workspace_path = sess_row["workspace_path"] if sess_row else None
    finally:
        await db.close()

    # Live PTY sessions don't populate the `messages` DB table — their
    # transcript lives in Claude Code's native JSONL file. Fall back to that.
    if not messages and native_sid and workspace_path:
        jsonl_file = _get_project_dir(workspace_path) / f"{native_sid}.jsonl"
        if jsonl_file.exists():
            messages = read_session_messages(str(jsonl_file))

    fmt = request.query.get("format", "markdown")
    if fmt == "json":
        return web.json_response({"messages": messages, "scratchpad": scratchpad})

    md = export_session_as_markdown(messages)
    if scratchpad.strip():
        md += "\n\n---\n\n## Scratchpad\n\n" + scratchpad + "\n"
    return web.Response(
        text=md,
        content_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="session-{session_id[:8]}.md"'},
    )


# ─── REST: Distill Session ────────────────────────────────────────────────

_DISTILL_PROMPTS = {
    "guideline": """You are analyzing a coding session conversation to extract a reusable guideline.
A guideline is a set of principles, patterns, or rules that should be followed in future coding sessions.

<conversation>
{conversation}
</conversation>

{instructions}

Extract the key principles, patterns, and guidelines from this conversation. Focus on:
- Coding patterns and conventions discussed or demonstrated
- Architectural decisions and their rationale
- Style preferences expressed
- Testing approaches
- Error handling patterns
- Any explicit preferences or rules stated by the user

Return a JSON object with exactly these fields:
{{
  "name": "Short descriptive name for this guideline (max 60 chars)",
  "content": "The full guideline text in markdown format. Use bullet points, headers, and code examples where appropriate.",
  "when_to_use": "Short description of when this guideline should be applied (e.g. 'frontend React work', 'API endpoint development', 'database migrations'). This helps the session advisor automatically recommend it for similar tasks."
}}

Return ONLY the JSON object. No markdown fences, no explanation.""",

    "prompt": """You are analyzing a coding session conversation to create a reusable prompt template.
A prompt is a reusable instruction that can be sent to an AI coding assistant in future sessions.

<conversation>
{conversation}
</conversation>

{instructions}

Create a reusable prompt template that captures the core task or workflow demonstrated in this conversation. The prompt should:
- Be generic enough to reuse in different contexts
- Capture the key steps and approach
- Include placeholders for variable parts using {{{{variable_name}}}} syntax
- Be specific enough to produce useful results

Return a JSON object with exactly these fields:
{{
  "name": "Short descriptive name (max 60 chars)",
  "category": "Category (e.g. Coding, Testing, Refactoring, Analysis, DevOps, Debugging)",
  "content": "The full prompt template text",
  "variables": "comma-separated list of variable names used in the template, or empty string"
}}

Return ONLY the JSON object. No markdown fences, no explanation.""",

    "cascade": """You are analyzing a coding session conversation to create a prompt cascade.
A cascade is an ordered sequence of prompts that are sent to an AI coding assistant one after another,
each building on the results of the previous step.

<conversation>
{conversation}
</conversation>

{instructions}

Break down the workflow in this conversation into a sequence of discrete, self-contained prompt steps.
Each step should:
- Be a complete prompt that can stand on its own
- Build logically on the results of previous steps
- Be specific and actionable
- Use 3-8 steps total

Return a JSON object with exactly these fields:
{{
  "name": "Short descriptive name for this cascade (max 60 chars)",
  "steps": ["Step 1 prompt text", "Step 2 prompt text", "Step 3 prompt text"]
}}

Return ONLY the JSON object. No markdown fences, no explanation.""",
}


def _format_conversation_for_distill(messages: list[dict], max_chars: int = 80_000) -> str:
    """Format session messages into a compact transcript for the distill prompt."""
    lines = []
    for msg in messages:
        # Handle both DB rows and JSONL entries
        normalized = normalize_jsonl_entry(msg)
        if normalized is None:
            continue
        role, content = normalized

        # Parse list-shaped content from DB rows
        if isinstance(content, str) and content.startswith("["):
            try:
                parsed = json.loads(content)
                if isinstance(parsed, list):
                    content = parsed
            except json.JSONDecodeError:
                pass

        # Extract just the text parts (skip tool calls/results for brevity)
        if isinstance(content, list):
            text_parts = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text_parts.append(block.get("text", ""))
                elif isinstance(block, str):
                    text_parts.append(block)
            content = "\n".join(text_parts)

        if not content or not content.strip():
            continue

        label = "User" if role in ("human", "user") else "Assistant"
        lines.append(f"**{label}:**\n{content.strip()}\n")

    transcript = "\n".join(lines)
    # Truncate from the middle if too long, keeping first and last parts
    if len(transcript) > max_chars:
        half = max_chars // 2
        transcript = (
            transcript[:half]
            + "\n\n[... conversation truncated for brevity ...]\n\n"
            + transcript[-half:]
        )
    return transcript


_background_jobs: dict[str, dict] = {}


async def _run_background_llm_job(
    job_id: str, job_type: str, cli: str, model: str | None,
    prompt: str, extra: dict, timeout: int = 180,
):
    """Run an LLM call in the background and broadcast the result via WebSocket."""
    from llm_router import llm_call_json

    job = _background_jobs.get(job_id)
    if not job:
        return

    job["status"] = "running"
    try:
        result = await llm_call_json(cli=cli, model=model, prompt=prompt, timeout=timeout)
        job["status"] = "done"
        job["result"] = result
        await broadcast({
            "type": f"{job_type}_done",
            "job_id": job_id,
            "result": result,
            **extra,
        })
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
        await broadcast({
            "type": f"{job_type}_error",
            "job_id": job_id,
            "error": str(e),
            **extra,
        })


async def summarize_session(request: web.Request) -> web.Response:
    """Generate or regenerate a short session summary on demand."""
    session_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT s.*, w.path AS workspace_path
               FROM sessions s
               LEFT JOIN workspaces w ON s.workspace_id = w.id
               WHERE s.id = ?""",
            (session_id,),
        )
        sess = await cur.fetchone()
        if not sess:
            return web.json_response({"error": "session not found"}, status=404)
        sess = dict(sess)

        # Fetch conversation messages (JSONL first, then DB, then terminal buffer)
        messages = []
        native_sid = sess.get("native_session_id")
        workspace_path = sess.get("workspace_path")
        if native_sid and workspace_path:
            jsonl_file = _get_project_dir(workspace_path) / f"{native_sid}.jsonl"
            if jsonl_file.exists():
                messages = read_session_messages(str(jsonl_file))

        if not messages:
            cur2 = await db.execute(
                "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at",
                (session_id,),
            )
            rows = await cur2.fetchall()
            messages = [dict(r) for r in rows]

        if messages:
            conversation = _format_conversation_for_distill(messages, max_chars=20_000)
        else:
            conversation = capture_proc.get_buffer(session_id, 200)

        if not conversation or len(conversation.strip()) < 50:
            return web.json_response({"error": "not enough content to summarize"}, status=400)

        # Fetch session digest for extra context
        digest_context = ""
        try:
            cur3 = await db.execute(
                "SELECT task_summary, discoveries, decisions FROM session_digests WHERE session_id = ?",
                (session_id,),
            )
            digest = await cur3.fetchone()
            if digest:
                parts = []
                if digest["task_summary"]:
                    parts.append(f"Task: {digest['task_summary']}")
                if digest["discoveries"] and digest["discoveries"] != "[]":
                    parts.append(f"Discoveries: {digest['discoveries']}")
                if parts:
                    digest_context = "\n\nWorker digest:\n" + "\n".join(parts)
        except Exception:
            pass

        cli = sess.get("cli_type") or "claude"
    finally:
        await db.close()

    from llm_router import llm_call
    summary = await llm_call(
        cli=cli,
        prompt=(
            "Summarize this coding session in 1-2 concise sentences. "
            "Focus on what was accomplished or attempted. Be specific about the task, not generic.\n\n"
            f"Session transcript:\n{conversation}{digest_context}"
        ),
        system="You are a concise summarizer. Return ONLY the 1-2 sentence summary, nothing else. No quotes, no prefix.",
        timeout=30,
    )
    summary = summary.strip()

    db2 = await get_db()
    try:
        await db2.execute(
            "UPDATE sessions SET summary = ? WHERE id = ?",
            (summary, session_id),
        )
        await db2.commit()
    finally:
        await db2.close()

    await broadcast({
        "type": "session_summary",
        "session_id": session_id,
        "summary": summary,
    })

    return web.json_response({"summary": summary})


async def distill_session(request: web.Request) -> web.Response:
    """Launch a background job to extract a reusable artifact from a session."""
    session_id = request.match_info["id"]
    body = await request.json()

    artifact_type = (body.get("type") or "").strip().lower()
    if artifact_type not in _DISTILL_PROMPTS:
        return web.json_response(
            {"error": f"type must be one of: {', '.join(_DISTILL_PROMPTS.keys())}"},
            status=400,
        )

    cli = (body.get("cli") or "claude").strip().lower()
    model = body.get("model") or None
    instructions = (body.get("instructions") or "").strip()

    # ── Fetch full conversation content ─────────────────────────────
    # Priority: 1) JSONL file (full structured history)
    #           2) DB messages (imported sessions)
    #           3) Terminal buffer (fallback — partial, last ~64KB)
    conversation = None
    messages = []

    db = await get_db()
    try:
        cur2 = await db.execute(
            """SELECT s.native_session_id, s.cli_type, s.workspace_id,
                      w.path AS workspace_path
               FROM sessions s
               LEFT JOIN workspaces w ON s.workspace_id = w.id
               WHERE s.id = ?""",
            (session_id,),
        )
        sess_row = await cur2.fetchone()

        # 1) Try JSONL — full conversation history for live/exited sessions
        ws_id = None
        if sess_row:
            native_sid = sess_row["native_session_id"]
            workspace_path = sess_row["workspace_path"]
            ws_id = sess_row["workspace_id"]
            if native_sid and workspace_path:
                jsonl_file = _get_project_dir(workspace_path) / f"{native_sid}.jsonl"
                if jsonl_file.exists():
                    messages = read_session_messages(str(jsonl_file))

            # If native_session_id wasn't detected yet, scan for most recent.
            # Only do this for live/recently-exited sessions where the hook
            # hasn't populated native_session_id yet — NOT for sessions that
            # never had a PTY (e.g. test/seeded sessions), because the scan
            # would grab a random recent JSONL from the workspace.
            if not messages and workspace_path and native_sid:
                project_dir = _get_project_dir(workspace_path)
                if project_dir.exists():
                    cli_type = sess_row["cli_type"] or "claude"
                    glob_pat = get_profile(cli_type).session_file_pattern
                    candidates = sorted(
                        project_dir.glob(glob_pat),
                        key=lambda p: p.stat().st_mtime,
                        reverse=True,
                    )
                    for candidate in candidates[:3]:
                        try:
                            msgs = read_session_messages(str(candidate))
                            if msgs:
                                messages = msgs
                                break
                        except Exception:
                            continue

        # 2) Try DB messages (populated for imported sessions)
        if not messages:
            cur = await db.execute(
                "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at",
                (session_id,),
            )
            rows = await cur.fetchall()
            messages = [dict(r) for r in rows]

        if messages:
            conversation = _format_conversation_for_distill(messages)

        # 3) Terminal buffer fallback — partial but better than nothing
        if not conversation:
            terminal_text = capture_proc.get_buffer(session_id, 2000)
            if terminal_text and len(terminal_text.strip()) > 50:
                conversation = terminal_text.strip()

        # Grab session name
        cur3 = await db.execute("SELECT name FROM sessions WHERE id = ?", (session_id,))
        name_row = await cur3.fetchone()
        session_name = name_row["name"] if name_row else session_id[:8]
    finally:
        await db.close()

    if not conversation:
        return web.json_response(
            {"error": "No conversation content found for this session."},
            status=404,
        )

    # Resolve workspace output style for distill formatting
    from output_styles import resolve_output_style, OUTPUT_STYLES
    _ws_os, _gl_os = None, None
    _sdb = await get_db()
    try:
        if ws_id:
            _c = await _sdb.execute("SELECT output_style FROM workspaces WHERE id = ?", (ws_id,))
            _r = await _c.fetchone()
            _ws_os = _r["output_style"] if _r else None
        _c = await _sdb.execute("SELECT value FROM app_settings WHERE key = 'output_style'")
        _r = await _c.fetchone()
        _gl_os = _r["value"] if _r else None
    except Exception:
        pass
    finally:
        await _sdb.close()
    _eff_style = resolve_output_style(None, _ws_os, _gl_os)
    _style_hint = ""
    if _eff_style != "default":
        _desc = OUTPUT_STYLES.get(_eff_style, {}).get("description", "")
        _style_hint = (
            f"\nOutput style: {_eff_style} ({_desc}). "
            "Apply to generated content — signal over noise. JSON structure unchanged.\n"
        )
    _iparts = []
    if instructions:
        _iparts.append(f"Additional instructions from the user:\n{instructions}")
    if _style_hint:
        _iparts.append(_style_hint)
    instructions_block = "\n".join(_iparts)

    # Build the distill prompt
    prompt_template = _DISTILL_PROMPTS[artifact_type]
    prompt = prompt_template.format(
        conversation=conversation,
        instructions=instructions_block,
    )

    # Launch background job
    job_id = str(uuid.uuid4())
    _background_jobs[job_id] = {
        "type": "distill",
        "status": "queued",
        "session_id": session_id,
        "artifact_type": artifact_type,
    }

    import asyncio as _asyncio
    _asyncio.ensure_future(_run_background_llm_job(
        job_id=job_id,
        job_type="distill",
        cli=cli,
        model=model,
        prompt=prompt,
        extra={
            "session_id": session_id,
            "session_name": session_name,
            "artifact_type": artifact_type,
        },
    ))

    return web.json_response({
        "job_id": job_id,
        "status": "started",
        "artifact_type": artifact_type,
    })


# ─── REST: Search ─────────────────────────────────────────────────────────

async def search_messages(request: web.Request) -> web.Response:
    q = request.query.get("q", "").strip()
    if not q:
        return web.json_response([])

    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT m.*, s.name AS session_name, s.workspace_id
               FROM messages m
               JOIN sessions s ON m.session_id = s.id
               WHERE m.content LIKE ?
               ORDER BY m.created_at DESC
               LIMIT 100""",
            (f"%{q}%",),
        )
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


# ─── REST: Clone ──────────────────────────────────────────────────────────

async def clone_session(request: web.Request) -> web.Response:
    source_id = request.match_info["id"]
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (source_id,))
        source = await cur.fetchone()
        if not source:
            return web.json_response({"error": "session not found"}, status=404)

        source = dict(source)
        new_id = str(uuid.uuid4())

        # Support cross-CLI cloning: pass { cli_type: "gemini" } to clone
        # a Claude session as a Gemini session (or vice versa).
        target_cli = body.get("cli_type", source.get("cli_type", "claude"))
        source_cli = source.get("cli_type", "claude")
        is_cross_cli = target_cli != source_cli

        # Translate model/mode defaults if switching CLI
        if is_cross_cli:
            target_profile = get_profile(target_cli)
            new_model = body.get("model", target_profile.default_model)
            new_mode = body.get("permission_mode", target_profile.default_permission_mode)
        else:
            new_model = body.get("model", source["model"])
            new_mode = body.get("permission_mode", source["permission_mode"])

        new_name = f"{source['name']} (clone)"
        await db.execute(
            """INSERT INTO sessions (id, workspace_id, name, model, permission_mode, effort,
               budget_usd, system_prompt, allowed_tools, disallowed_tools, add_dirs,
               agent, worktree, mcp_config, cli_type, scratchpad, session_type, output_style)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (new_id, source["workspace_id"], new_name, new_model,
             new_mode, source["effort"], source["budget_usd"],
             source["system_prompt"], source["allowed_tools"], source["disallowed_tools"],
             source["add_dirs"], source["agent"], source["worktree"], source["mcp_config"],
             target_cli, source.get("scratchpad"), source.get("session_type", "worker"),
             source.get("output_style")),
        )

        # If cross-CLI clone, sync memory so the target CLI's file is up to date
        if is_cross_cli and source.get("workspace_id"):
            try:
                from memory_sync import sync_manager
                ws_path, _ = await _get_workspace_path_or_error(source["workspace_id"])
                if ws_path:
                    await sync_manager.sync(source["workspace_id"], ws_path)
            except Exception as exc:
                logger.warning("Memory sync during cross-CLI clone failed: %s", exc)

        # Copy guidelines
        cur = await db.execute(
            "SELECT guideline_id FROM session_guidelines WHERE session_id = ?",
            (source_id,),
        )
        for row in await cur.fetchall():
            await db.execute(
                "INSERT INTO session_guidelines (session_id, guideline_id) VALUES (?, ?)",
                (new_id, row["guideline_id"]),
            )

        # Copy MCP servers
        cur = await db.execute(
            "SELECT mcp_server_id, auto_approve_override FROM session_mcp_servers WHERE session_id = ?",
            (source_id,),
        )
        for row in await cur.fetchall():
            await db.execute(
                "INSERT INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, ?)",
                (new_id, row["mcp_server_id"], row["auto_approve_override"]),
            )

        await db.commit()
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (new_id,))
        row = await cur.fetchone()
        return web.json_response(dict(row), status=201)
    finally:
        await db.close()


# ─── REST: Merge Sessions ───────────────────────────────────────────────

async def merge_sessions(request: web.Request) -> web.Response:
    """Merge multiple sessions into one.

    Accepts { source_ids: [...], target_id: null | uuid, workspace_id: uuid }.
    Fetches messages/transcripts from each source, builds a combined context
    string, optionally creates a new session, and returns the target session
    plus the context text (the frontend sends it as PTY input).
    """
    body = await request.json()
    source_ids = body.get("source_ids", [])
    target_id = body.get("target_id")
    workspace_id = body.get("workspace_id")

    if len(source_ids) < 2:
        return web.json_response({"error": "need at least 2 source sessions"}, status=400)
    if not workspace_id:
        return web.json_response({"error": "workspace_id required"}, status=400)

    db = await get_db()
    try:
        # Validate all source sessions exist and belong to the workspace
        placeholders = ",".join("?" for _ in source_ids)
        cur = await db.execute(
            f"SELECT * FROM sessions WHERE id IN ({placeholders})", source_ids
        )
        sources = [dict(r) for r in await cur.fetchall()]
        if len(sources) != len(source_ids):
            return web.json_response({"error": "one or more sessions not found"}, status=404)
        for s in sources:
            if s["workspace_id"] != workspace_id:
                return web.json_response(
                    {"error": f"session {s['id'][:8]} belongs to a different workspace"},
                    status=400,
                )

        # Build ordered list matching source_ids order
        source_map = {s["id"]: s for s in sources}
        ordered = [source_map[sid] for sid in source_ids]

        # Gather messages / transcripts for each source
        context_parts = []
        for src in ordered:
            # Try DB messages first
            cur = await db.execute(
                "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at",
                (src["id"],),
            )
            messages = [dict(r) for r in await cur.fetchall()]

            # Fall back to JSONL transcript if no DB messages
            if not messages and src.get("native_session_id"):
                cur2 = await db.execute(
                    "SELECT path FROM workspaces WHERE id = ?",
                    (src["workspace_id"],),
                )
                ws_row = await cur2.fetchone()
                if ws_row:
                    jsonl_file = _get_project_dir(ws_row["path"]) / f"{src['native_session_id']}.jsonl"
                    if jsonl_file.exists():
                        messages = read_session_messages(str(jsonl_file))

            md = export_session_as_markdown(messages) if messages else "(no messages)"
            context_parts.append(
                f"## Session: {src['name']}\n"
                f"Model: {src.get('model', 'unknown')} | "
                f"Turns: {src.get('turn_count', 0)} | "
                f"Cost: ${src.get('total_cost_usd', 0):.4f}\n\n"
                f"{md}"
            )

        # Include workspace memory + auto-memory for richer merge context
        memory_section = ""
        try:
            from memory_sync import sync_manager
            cur_ws = await db.execute(
                "SELECT path FROM workspaces WHERE id = ?", (workspace_id,),
            )
            ws_row = await cur_ws.fetchone()
            if ws_row:
                ws_path = ws_row["path"]
                central = await sync_manager.read_central(workspace_id)
                auto = await sync_manager.read_all_auto_memory(ws_path)

                mem_parts = []
                if central:
                    mem_parts.append(f"## Project Memory\n{central[:4000]}")
                if auto:
                    lines = []
                    for cli, entries in auto.items():
                        for e in entries[:10]:
                            body_text = e.get("content", "")
                            if body_text:
                                lines.append(
                                    f"- **[{e.get('type','')}] {e.get('name','')}**: "
                                    f"{body_text[:200]}"
                                )
                    if lines:
                        mem_parts.append(
                            "## Remembered Context\n" + "\n".join(lines)
                        )
                if mem_parts:
                    memory_section = "\n\n".join(mem_parts) + "\n\n---\n\n"
        except Exception as exc:
            logger.debug("Failed to load memory for merge: %s", exc)

        session_names = ", ".join(f'"{s["name"]}"' for s in ordered)
        context = (
            f"Multiple sessions are being merged into this one ({session_names}). "
            "Below is the project memory and conversation history from each session.\n\n"
            "Please:\n"
            "1. Read through all the merged session content carefully\n"
            "2. Summarize the key findings, decisions, and progress from each session\n"
            "3. Save any important context to your memory so it persists\n"
            "4. Identify any open tasks, unresolved issues, or next steps\n"
            "5. Let me know what you've absorbed and what you're ready to continue working on\n\n"
            + memory_section
            + "\n\n---\n\n".join(context_parts)
        )

        # Create or validate target session
        if target_id:
            cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (target_id,))
            target = await cur.fetchone()
            if not target:
                return web.json_response({"error": "target session not found"}, status=404)
            target = dict(target)
        else:
            # Create a new session with merged name
            new_id = str(uuid.uuid4())
            merged_names = " + ".join(s["name"] for s in ordered[:3])
            if len(ordered) > 3:
                merged_names += f" +{len(ordered) - 3} more"
            new_name = f"Merged: {merged_names}"

            # Use config from the first source session
            first = ordered[0]
            await db.execute(
                """INSERT INTO sessions (id, workspace_id, name, model, permission_mode,
                   effort, system_prompt, cli_type)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (new_id, workspace_id, new_name, first.get("model", "sonnet"),
                 first.get("permission_mode", "auto"), first.get("effort", "high"),
                 first.get("system_prompt"), first.get("cli_type", "claude")),
            )

            # Merge guidelines from all sources (union, skip deleted)
            cur = await db.execute(
                f"""SELECT DISTINCT sg.guideline_id FROM session_guidelines sg
                    JOIN guidelines g ON g.id = sg.guideline_id
                    WHERE sg.session_id IN ({placeholders})""",
                source_ids,
            )
            for row in await cur.fetchall():
                await db.execute(
                    "INSERT OR IGNORE INTO session_guidelines (session_id, guideline_id) VALUES (?, ?)",
                    (new_id, row["guideline_id"]),
                )

            # Merge MCP servers from all sources (union, skip deleted)
            cur = await db.execute(
                f"""SELECT DISTINCT sm.mcp_server_id FROM session_mcp_servers sm
                    JOIN mcp_servers m ON m.id = sm.mcp_server_id
                    WHERE sm.session_id IN ({placeholders})""",
                source_ids,
            )
            for row in await cur.fetchall():
                await db.execute(
                    "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id) VALUES (?, ?)",
                    (new_id, row["mcp_server_id"]),
                )

            await db.commit()
            cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (new_id,))
            target = dict(await cur.fetchone())

        return web.json_response({"session": target, "context": context}, status=201)
    finally:
        await db.close()


# ─── REST: Session Management ────────────────────────────────────────────

async def rename_session(request: web.Request) -> web.Response:
    session_id = request.match_info["id"]
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        return web.json_response({"error": "name required"}, status=400)

    db = await get_db()
    try:
        cur = await db.execute("UPDATE sessions SET name = ? WHERE id = ?", (name, session_id))
        await db.commit()
        if cur.rowcount == 0:
            return web.json_response({"error": "session not found"}, status=404)
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "session not found"}, status=404)
        return web.json_response(dict(row))
    finally:
        await db.close()


async def update_session(request: web.Request) -> web.Response:
    """Update session config fields (model, permission_mode, effort, etc.)."""
    session_id = request.match_info["id"]
    body = await request.json()
    db = await get_db()
    try:
        allowed = ("name", "model", "permission_mode", "effort", "budget_usd",
                   "system_prompt", "allowed_tools", "disallowed_tools",
                   "add_dirs", "agent", "worktree", "mcp_config", "scratchpad",
                   "account_id", "native_session_id", "native_slug", "auto_approve_mcp", "cli_type",
                   "plan_model", "execute_model", "auto_approve_plan", "output_style", "tags",
                   "archived", "summary",
                   "task_id", "active_ticket_id",
                   "board_action", "board_action_at", "board_action_note")
        fields, values = [], []
        for key in allowed:
            if key in body:
                val = body[key]
                # Tags stored as JSON array
                if key == "tags" and isinstance(val, list):
                    val = json.dumps(val)
                fields.append(f"{key} = ?")
                values.append(val)
        if not fields:
            return web.json_response({"error": "no fields to update"}, status=400)

        # Read pre-update state for fields whose change we emit events for.
        old_active_ticket_id: str | None = None
        if "active_ticket_id" in body:
            pre_cur = await db.execute(
                "SELECT active_ticket_id FROM sessions WHERE id = ?", (session_id,),
            )
            pre_row = await pre_cur.fetchone()
            old_active_ticket_id = (pre_row["active_ticket_id"] if pre_row else None)

        values.append(session_id)
        await db.execute(
            f"UPDATE sessions SET {', '.join(fields)} WHERE id = ?", values
        )
        await db.commit()
        # Broadcast archive/summary state changes to all connected clients
        if "archived" in body:
            await broadcast({
                "type": "session_archived",
                "session_id": session_id,
                "archived": body["archived"],
            })
        if "summary" in body:
            await broadcast({
                "type": "session_summary",
                "session_id": session_id,
                "summary": body["summary"],
            })

        # Emit SESSION_TICKET_REBOUND only when the bound ticket actually
        # changed. switch_active_ticket and document_to_board both PUT
        # through this route, so a single emit point covers worker tools
        # and direct UI edits.
        if "active_ticket_id" in body:
            new_active_ticket_id = body.get("active_ticket_id")
            if new_active_ticket_id != old_active_ticket_id:
                try:
                    await bus.emit(CommanderEvent.SESSION_TICKET_REBOUND, {
                        "session_id": session_id,
                        "old_ticket_id": old_active_ticket_id,
                        "new_ticket_id": new_active_ticket_id,
                    }, source="api", actor="user")
                except Exception as e:
                    logger.debug("SESSION_TICKET_REBOUND emit failed: %s", e)

        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "session not found"}, status=404)
        return web.json_response(dict(row))
    finally:
        await db.close()


# ─── REST: Session Scratchpad ─────────────────────────────────────────────

async def get_session_scratchpad(request: web.Request) -> web.Response:
    session_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("SELECT scratchpad FROM sessions WHERE id = ?", (session_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "session not found"}, status=404)
        return web.json_response({"scratchpad": row["scratchpad"] or ""})
    finally:
        await db.close()


async def update_session_scratchpad(request: web.Request) -> web.Response:
    session_id = request.match_info["id"]
    body = await request.json()
    content = body.get("scratchpad", "")
    origin = body.get("origin")
    db = await get_db()
    try:
        await db.execute("UPDATE sessions SET scratchpad = ? WHERE id = ?", (content, session_id))
        await db.commit()
    finally:
        await db.close()
    await broadcast({
        "type": "scratchpad_updated",
        "session_id": session_id,
        "content": content,
        "origin": origin,
    })
    return web.json_response({"scratchpad": content})


# ─── REST: Worker Queue ──────────────────────────────────────────────────

async def get_session_queue(request: web.Request) -> web.Response:
    """Get tasks queued for a specific worker, ordered by queue_order."""
    session_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT * FROM tasks WHERE queued_for_session_id = ? ORDER BY queue_order ASC",
            (session_id,),
        )
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


async def queue_task_for_session(request: web.Request) -> web.Response:
    """Queue a task for a specific worker. Auto-calculates queue_order."""
    session_id = request.match_info["id"]
    body = await request.json()
    task_id = body.get("task_id")
    if not task_id:
        return web.json_response({"error": "task_id required"}, status=400)

    db = await get_db()
    try:
        # Verify session exists
        cur = await db.execute("SELECT id FROM sessions WHERE id = ?", (session_id,))
        if not await cur.fetchone():
            return web.json_response({"error": "session not found"}, status=404)

        # Verify task exists and isn't already assigned/queued
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        task_row = await cur.fetchone()
        if not task_row:
            return web.json_response({"error": "task not found"}, status=404)

        # Calculate next queue_order
        cur = await db.execute(
            "SELECT MAX(queue_order) as max_order FROM tasks WHERE queued_for_session_id = ?",
            (session_id,),
        )
        row = await cur.fetchone()
        next_order = (row["max_order"] or 0) + 1

        # Queue the task
        await db.execute(
            """UPDATE tasks SET queued_for_session_id = ?, queue_order = ?, updated_at = datetime('now')
               WHERE id = ?""",
            (session_id, next_order, task_id),
        )
        # Log event
        await db.execute(
            """INSERT INTO task_events (task_id, event_type, actor, old_value, new_value, message)
               VALUES (?, 'queued_for_session_id_changed', 'commander', NULL, ?, ?)""",
            (task_id, session_id, f"Task queued for worker session {session_id}"),
        )
        await db.commit()

        return web.json_response({
            "ok": True, "task_id": task_id,
            "queued_for_session_id": session_id,
            "queue_order": next_order,
        })
    finally:
        await db.close()


async def assign_task_to_session(request: web.Request) -> web.Response:
    """Assign a task to an idle worker session (worker reuse). Sends handoff prompt to PTY."""
    session_id = request.match_info["id"]
    body = await request.json()
    task_id = body.get("task_id")
    if not task_id:
        return web.json_response({"error": "task_id required"}, status=400)

    db = await get_db()
    try:
        # Verify session exists
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        sess_row = await cur.fetchone()
        if not sess_row:
            return web.json_response({"error": "session not found"}, status=404)

        # Verify task exists
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        task_row = await cur.fetchone()
        if not task_row:
            return web.json_response({"error": "task not found"}, status=404)
        task = dict(task_row)

        # Update task assignment
        old_assigned = task.get("assigned_session_id")
        await db.execute(
            """UPDATE tasks SET assigned_session_id = ?, queued_for_session_id = NULL,
               updated_at = datetime('now') WHERE id = ?""",
            (session_id, task_id),
        )
        # Update session's task_id
        await db.execute(
            "UPDATE sessions SET task_id = ? WHERE id = ?",
            (task_id, session_id),
        )
        # Log event
        await db.execute(
            """INSERT INTO task_events (task_id, event_type, actor, old_value, new_value, message)
               VALUES (?, 'assigned_session_id_changed', 'commander', ?, ?, ?)""",
            (task_id, old_assigned, session_id,
             f"Task reassigned to worker session {session_id} (worker reuse)"),
        )
        await db.commit()
    finally:
        await db.close()

    # Send handoff prompt to worker PTY if alive
    if pty_mgr.is_alive(session_id):
        message = body.get("message") or _build_worker_handoff_prompt(task)
        msg_bytes = message.encode("utf-8")
        cli_type = dict(sess_row).get("cli_type", "claude")
        if cli_type == "gemini":
            clean = message.replace("\n", " ").replace("\r", " ")
            pty_mgr.write(session_id, clean.encode("utf-8") + b"\r")
        else:
            pty_mgr.write(session_id, b"\x1b" + b"\x7f" * 20)
            await _asyncio.sleep(0.15)
            pty_mgr.write(session_id, msg_bytes)
            await _asyncio.sleep(0.4)
            pty_mgr.write(session_id, b"\r")

    return web.json_response({
        "ok": True, "task_id": task_id,
        "assigned_session_id": session_id,
    })


def _build_worker_handoff_prompt(task: dict) -> str:
    """Build the prompt sent to a worker when receiving a new task via reuse."""
    parts = [
        "--- NEW TASK ASSIGNMENT ---",
        "Your previous task is complete. Here is your next assignment.",
        "",
        f"Task: {task.get('title', '')}",
        f"Task ID: {task['id']}",
    ]
    if task.get("description"):
        parts.append(f"Description: {task['description']}")
    if task.get("acceptance_criteria"):
        parts.append(f"Acceptance criteria: {task['acceptance_criteria']}")
    if task.get("labels"):
        parts.append(f"Labels: {task['labels']}")
    parts.append("")
    parts.append(
        f"Call get_my_tasks to see full details. "
        f'Update status via update_my_task(task_id="{task["id"]}") as you work.'
    )
    return "\n".join(parts)


# ─── REST: Templates ──────────────────────────────────────────────────────

async def list_templates(request: web.Request) -> web.Response:
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM templates ORDER BY name")
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


async def create_template(request: web.Request) -> web.Response:
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        return web.json_response({"error": "name required"}, status=400)

    tid = str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO templates (id, name, model, permission_mode, effort,
               budget_usd, system_prompt, allowed_tools, guideline_ids, mcp_server_ids, conversation_turns,
               plan_model, execute_model, auto_approve_plan)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (tid, name, body.get("model"), body.get("permission_mode"),
             body.get("effort"), body.get("budget_usd"), body.get("system_prompt"),
             body.get("allowed_tools"), json.dumps(body.get("guideline_ids", [])),
             json.dumps(body.get("mcp_server_ids", [])),
             json.dumps(body.get("conversation_turns", [])),
             body.get("plan_model"), body.get("execute_model"),
             1 if body.get("auto_approve_plan") else 0),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM templates WHERE id = ?", (tid,))
        row = await cur.fetchone()
        return web.json_response(dict(row), status=201)
    finally:
        await db.close()


async def delete_template(request: web.Request) -> web.Response:
    tid = request.match_info["id"]
    db = await get_db()
    try:
        await db.execute("DELETE FROM templates WHERE id = ?", (tid,))
        await db.commit()
        return web.json_response({"ok": True})
    finally:
        await db.close()


async def apply_template(request: web.Request) -> web.Response:
    """Create a session from a template."""
    tid = request.match_info["id"]
    body = await request.json()
    workspace_id = body.get("workspace_id")
    if not workspace_id:
        return web.json_response({"error": "workspace_id required"}, status=400)

    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM templates WHERE id = ?", (tid,))
        tmpl = await cur.fetchone()
        if not tmpl:
            return web.json_response({"error": "template not found"}, status=404)
        tmpl = dict(tmpl)

        session_id = str(uuid.uuid4())
        name = body.get("name", "").strip() or f"{tmpl['name']} — {session_id[:8]}"
        await db.execute(
            """INSERT INTO sessions (id, workspace_id, name, model, permission_mode, effort,
               budget_usd, system_prompt, allowed_tools, plan_model, execute_model, auto_approve_plan)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (session_id, workspace_id, name, tmpl["model"], tmpl["permission_mode"],
             tmpl["effort"], tmpl["budget_usd"], tmpl["system_prompt"], tmpl["allowed_tools"],
             tmpl.get("plan_model"), tmpl.get("execute_model"),
             tmpl.get("auto_approve_plan", 0)),
        )

        # Apply template guidelines (skip any that were deleted)
        gids = json.loads(tmpl.get("guideline_ids") or "[]")
        if gids:
            placeholders = ",".join("?" for _ in gids)
            cur2 = await db.execute(f"SELECT id FROM guidelines WHERE id IN ({placeholders})", gids)
            existing_gids = {row["id"] for row in await cur2.fetchall()}
            for gid in gids:
                if gid in existing_gids:
                    await db.execute(
                        "INSERT OR IGNORE INTO session_guidelines (session_id, guideline_id) VALUES (?, ?)",
                        (session_id, gid),
                    )

        # Apply template MCP servers (skip any that were deleted)
        mcp_ids = json.loads(tmpl.get("mcp_server_ids") or "[]")
        if mcp_ids:
            placeholders = ",".join("?" for _ in mcp_ids)
            cur2 = await db.execute(f"SELECT id FROM mcp_servers WHERE id IN ({placeholders})", mcp_ids)
            existing_mids = {row["id"] for row in await cur2.fetchall()}
            for mid in mcp_ids:
                if mid in existing_mids:
                    await db.execute(
                        "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id) VALUES (?, ?)",
                        (session_id, mid),
                    )

        await db.commit()
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        row = await cur.fetchone()
        return web.json_response(dict(row), status=201)
    finally:
        await db.close()


# ─── REST: Grid templates ───────────────────────────────────────────
# A grid template defines a custom CSS-grid layout for the multi-terminal grid view.
# Each template owns its own cell-to-session assignments (which session lives in
# which cell), so swapping templates doesn't drop your in-progress placements.

def _serialize_grid_template(row) -> dict:
    d = dict(row)
    try:
        d["cells"] = json.loads(d.get("cells") or "[]")
    except Exception:
        d["cells"] = []
    try:
        d["cell_assignments"] = json.loads(d.get("cell_assignments") or "{}")
    except Exception:
        d["cell_assignments"] = {}
    return d


async def list_grid_templates(request: web.Request) -> web.Response:
    workspace_id = request.query.get("workspace")
    db = await get_db()
    try:
        if workspace_id:
            cur = await db.execute(
                "SELECT * FROM grid_templates WHERE workspace_id = ? OR workspace_id IS NULL ORDER BY created_at ASC",
                (workspace_id,),
            )
        else:
            cur = await db.execute("SELECT * FROM grid_templates ORDER BY created_at ASC")
        rows = await cur.fetchall()
        return web.json_response([_serialize_grid_template(r) for r in rows])
    finally:
        await db.close()


async def create_grid_template(request: web.Request) -> web.Response:
    body = await request.json()
    tid = body.get("id") or str(uuid.uuid4())
    workspace_id = body.get("workspace_id")
    name = (body.get("name") or "").strip() or "New layout"
    cols = max(1, min(6, int(body.get("cols") or 3)))
    cells = json.dumps(body.get("cells") or [])
    assignments = json.dumps(body.get("cell_assignments") or {})
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO grid_templates (id, workspace_id, name, cols, cells, cell_assignments) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (tid, workspace_id, name, cols, cells, assignments),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM grid_templates WHERE id = ?", (tid,))
        row = await cur.fetchone()
        return web.json_response(_serialize_grid_template(row), status=201)
    finally:
        await db.close()


async def update_grid_template(request: web.Request) -> web.Response:
    tid = request.match_info["id"]
    body = await request.json()
    fields, values = [], []
    if "name" in body:
        fields.append("name = ?")
        values.append((body.get("name") or "").strip() or "New layout")
    if "cols" in body:
        fields.append("cols = ?")
        values.append(max(1, min(6, int(body["cols"] or 3))))
    if "cells" in body:
        fields.append("cells = ?")
        values.append(json.dumps(body["cells"] or []))
    if "cell_assignments" in body:
        fields.append("cell_assignments = ?")
        values.append(json.dumps(body["cell_assignments"] or {}))
    if not fields:
        return web.json_response({"error": "no fields"}, status=400)
    fields.append("updated_at = datetime('now')")
    values.append(tid)
    db = await get_db()
    try:
        await db.execute(
            f"UPDATE grid_templates SET {', '.join(fields)} WHERE id = ?",
            values,
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM grid_templates WHERE id = ?", (tid,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(_serialize_grid_template(row))
    finally:
        await db.close()


async def delete_grid_template(request: web.Request) -> web.Response:
    tid = request.match_info["id"]
    db = await get_db()
    try:
        await db.execute("DELETE FROM grid_templates WHERE id = ?", (tid,))
        await db.commit()
        return web.json_response({"ok": True})
    finally:
        await db.close()


# ─── REST: Tab Groups ────────────────────────────────────────────────

def _serialize_tab_group(row):
    d = dict(row)
    d["session_ids"] = json.loads(d.get("session_ids") or "[]")
    return d


async def list_tab_groups(request: web.Request) -> web.Response:
    workspace_id = request.query.get("workspace")
    db = await get_db()
    try:
        if workspace_id:
            cur = await db.execute(
                "SELECT * FROM tab_groups WHERE workspace_id = ? ORDER BY created_at ASC",
                (workspace_id,),
            )
        else:
            cur = await db.execute("SELECT * FROM tab_groups ORDER BY created_at ASC")
        rows = await cur.fetchall()
        return web.json_response([_serialize_tab_group(r) for r in rows])
    finally:
        await db.close()


async def create_tab_group(request: web.Request) -> web.Response:
    body = await request.json()
    tid = body.get("id") or str(uuid.uuid4())
    workspace_id = body.get("workspace_id")
    name = (body.get("name") or "").strip() or "New group"
    session_ids = json.dumps(body.get("session_ids") or [])
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO tab_groups (id, workspace_id, name, session_ids) VALUES (?, ?, ?, ?)",
            (tid, workspace_id, name, session_ids),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM tab_groups WHERE id = ?", (tid,))
        row = await cur.fetchone()
        return web.json_response(_serialize_tab_group(row), status=201)
    finally:
        await db.close()


async def update_tab_group(request: web.Request) -> web.Response:
    tid = request.match_info["id"]
    body = await request.json()
    fields, values = [], []
    if "name" in body:
        fields.append("name = ?")
        values.append((body["name"] or "").strip() or "New group")
    if "session_ids" in body:
        fields.append("session_ids = ?")
        values.append(json.dumps(body["session_ids"] or []))
    if "is_active" in body:
        fields.append("is_active = ?")
        values.append(1 if body["is_active"] else 0)
    if not fields:
        return web.json_response({"error": "no fields"}, status=400)
    fields.append("updated_at = datetime('now')")
    values.append(tid)
    db = await get_db()
    try:
        await db.execute(
            f"UPDATE tab_groups SET {', '.join(fields)} WHERE id = ?", values
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM tab_groups WHERE id = ?", (tid,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(_serialize_tab_group(row))
    finally:
        await db.close()


async def delete_tab_group(request: web.Request) -> web.Response:
    tid = request.match_info["id"]
    db = await get_db()
    try:
        await db.execute("DELETE FROM tab_groups WHERE id = ?", (tid,))
        await db.commit()
        return web.json_response({"ok": True})
    finally:
        await db.close()


# ─── REST: Tasks ─────────────────────────────────────────────────────

async def list_tasks(request: web.Request) -> web.Response:
    workspace_id = request.query.get("workspace_id") or request.query.get("workspace")
    status = request.query.get("status")
    db = await get_db()
    try:
        conditions, params = [], []
        if workspace_id:
            conditions.append("workspace_id = ?")
            params.append(workspace_id)
        assigned_session = request.query.get("assigned_session")
        if assigned_session:
            conditions.append("assigned_session_id = ?")
            params.append(assigned_session)
        if status:
            conditions.append("status = ?")
            params.append(status)
        where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        cur = await db.execute(
            f"SELECT * FROM tasks{where} ORDER BY sort_order, created_at DESC", params
        )
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


async def create_task(request: web.Request) -> web.Response:
    body = await request.json()
    # MCP-S2: planner-gate at the route level. The worker MCP only exposes
    # create_task to planner sessions, but the underlying REST is open. Any
    # caller-with-shell could `curl POST /tasks` and bypass the gate. Enforce
    # the same role restriction here so the gate isn't theatre.
    caller = await _resolve_caller(request)
    if caller and caller["session_type"] == "worker":
        return web.json_response(
            {"error": "forbidden: only planner/commander sessions can create tasks"},
            status=403,
        )
    workspace_id = body.get("workspace_id")
    # MCP-S7-style guard: a worker/planner caller cannot file tasks into a
    # foreign workspace by passing someone else's workspace_id. Force it back
    # to the caller's bound workspace.
    if caller and caller["workspace_id"] and workspace_id and workspace_id != caller["workspace_id"]:
        workspace_id = caller["workspace_id"]
        body["workspace_id"] = workspace_id
    title = body.get("title", "").strip()
    if not workspace_id or not title:
        return web.json_response({"error": "workspace_id and title required"}, status=400)

    # ── Dedup-on-create gate ─────────────────────────────────────────────
    # If a CONFLICT-level ticket already exists for this intent, return a
    # warning instead of inserting. Caller re-POSTs with ?force=1 to skip.
    # Advisory only — empty index, retriever errors, and non-CONFLICT hits
    # all let the create proceed normally.
    def _truthy_force(v) -> bool:
        if isinstance(v, bool):
            return v
        if isinstance(v, (int, float)):
            return v != 0
        if isinstance(v, str):
            return v.strip().lower() in ("1", "true", "yes", "on")
        return False
    force_flag = _truthy_force(request.query.get("force")) or _truthy_force(body.get("force"))
    if not force_flag:
        try:
            import ticket_retriever
            from myelin.coordination.workspace import OverlapLevel
            dedup_query_parts = [title]
            if body.get("description"):
                dedup_query_parts.append(str(body["description"])[:600])
            dedup_query = ". ".join(dedup_query_parts)
            existing = await ticket_retriever.find_related(
                workspace_id=workspace_id,
                query=dedup_query,
                status_filter="open",
                limit=5,
            )
            conflicts = [c for c in existing if c.level == OverlapLevel.CONFLICT.value]
            if conflicts:
                # 409 so the frontend's request helper raises ApiError instead
                # of treating the response as "task created." `error` is what
                # ApiError surfaces in its `message`; `warning` and `candidates`
                # stay so MCP workers and any structured caller see the same
                # shape they did when this returned 200.
                return web.json_response(
                    {
                        "error": "possible_duplicate",
                        "warning": "possible_duplicate",
                        "message": (
                            "A near-duplicate open ticket already exists. "
                            "Re-POST with ?force=1 (or add force:true to the body) to "
                            "create anyway."
                        ),
                        "candidates": [c.to_dict() for c in conflicts],
                    },
                    status=409,
                )
        except Exception as e:
            logger.debug("dedup-on-create gate skipped: %s", e)

    task_id = str(uuid.uuid4())
    labels = body.get("labels")
    if isinstance(labels, list):
        labels = ",".join(str(l) for l in labels)

    depends_on = body.get("depends_on", "[]")
    if isinstance(depends_on, list):
        depends_on = json.dumps(depends_on)

    # Inherit pipeline from workspace when not explicitly set on task
    pipeline_val = body.get("pipeline")

    db = await get_db()
    try:
        # Validate workspace exists. Without this check, a bogus workspace_id
        # leaks the FK error as a 500 (BUG H2).
        cur = await db.execute("SELECT pipeline_enabled FROM workspaces WHERE id = ?", (workspace_id,))
        ws_row = await cur.fetchone()
        if not ws_row:
            return web.json_response({"error": "workspace not found"}, status=404)
        if pipeline_val is None:
            pipeline_val = (ws_row["pipeline_enabled"] if ws_row else 0) or 0

        await db.execute(
            """INSERT INTO tasks (id, workspace_id, title, description, acceptance_criteria,
               status, priority, sort_order, assigned_session_id, commander_session_id,
               parent_task_id, labels, pipeline, pipeline_max_iterations, depends_on,
               plan_first, ralph_loop, deep_research, test_with_agent)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (task_id, workspace_id, title, body.get("description"),
             body.get("acceptance_criteria"), body.get("status", "backlog"),
             body.get("priority", 0), body.get("sort_order", 0),
             body.get("assigned_session_id"), body.get("commander_session_id"),
             body.get("parent_task_id"), labels,
             pipeline_val, body.get("pipeline_max_iterations", 5), depends_on,
             1 if body.get("plan_first") else 0,
             1 if body.get("ralph_loop") else 0,
             1 if body.get("deep_research") else 0,
             1 if body.get("test_with_agent") else 0),
        )
        # Record creation event
        await db.execute(
            """INSERT INTO task_events (task_id, event_type, actor, new_value, message)
               VALUES (?, 'created', 'user', ?, ?)""",
            (task_id, body.get("status", "backlog"), f"Task created: {title}"),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        row = await cur.fetchone()
        task = dict(row)
    finally:
        await db.close()

    await broadcast({"type": "task_update", "action": "created", "task": task})
    # Fire canonical event for feature-board hook subscribers (plugins,
    # webhooks, live UI feed). Payload carries denormalized task metadata
    # so subscribers don't need to re-fetch.
    await bus.emit(CommanderEvent.TASK_CREATED, {
        "task_id": task_id,
        "workspace_id": task.get("workspace_id"),
        "title": task.get("title"),
        "status": task.get("status"),
        "priority": task.get("priority"),
        "labels": task.get("labels"),
        "plan_first": bool(task.get("plan_first")),
        "ralph_loop": bool(task.get("ralph_loop")),
        "deep_research": bool(task.get("deep_research")),
        "test_with_agent": bool(task.get("test_with_agent")),
        "pipeline": bool(task.get("pipeline")),
    }, source="api", actor="user")

    asyncio.create_task(ticket_indexer.index_ticket(task))
    return web.json_response(task, status=201)


async def get_task(request: web.Request) -> web.Response:
    task_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "task not found"}, status=404)
        return web.json_response(dict(row))
    finally:
        await db.close()


async def update_task(request: web.Request) -> web.Response:
    task_id = request.match_info["id"]
    body = await request.json()

    # Mode-aware field + status whitelist (Brief / Code).
    _ctx = request.get("auth")
    if _ctx is not None and not _ctx.is_owner and _ctx.mode != "full":
        import mode_policy as _mode_policy
        body, _dropped = _mode_policy.filter_task_update_body(body, _ctx.mode)
        if _dropped:
            return web.json_response(
                {
                    "error": f"Mode '{_ctx.mode}' cannot modify: {sorted(_dropped)}",
                    "your_mode": _ctx.mode,
                },
                status=403,
            )
        if _ctx.mode == "brief":
            err = _mode_policy.validate_brief_status_transition(body.get("status"))
            if err:
                return web.json_response(
                    {"error": err, "your_mode": _ctx.mode}, status=403,
                )

    # MCP-S1: when called via the worker MCP path, restrict mutations to the
    # caller's own task. Commander/planner/tester/documentor can update any
    # task in their workspace; plain workers cannot touch sibling tasks.
    caller = await _resolve_caller(request)

    db = await get_db()
    try:
        # Fetch current state for event tracking
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        old_row = await cur.fetchone()
        if not old_row:
            return web.json_response({"error": "task not found"}, status=404)
        old = dict(old_row)

        if caller and caller["session_type"] == "worker":
            if old.get("assigned_session_id") != caller["session_id"]:
                return web.json_response(
                    {"error": "forbidden: workers can only update their own assigned task"},
                    status=403,
                )

        allowed = ("title", "description", "acceptance_criteria", "status", "priority",
                   "sort_order", "assigned_session_id", "commander_session_id",
                   "parent_task_id", "labels", "result_summary", "scratchpad", "plan_first", "auto_approve_plan",
                   "ralph_loop", "ralph_iteration", "ralph_phase", "deep_research",
                   "test_with_agent", "lessons_learned", "important_notes",
                   "iteration", "last_agent_session_id", "iteration_history",
                   "queued_for_session_id", "queue_order",
                   "pipeline", "pipeline_max_iterations", "pipeline_stage",
                   "depends_on")
        fields, values = [], []
        for key in allowed:
            if key in body:
                val = body[key]
                if key == "labels" and isinstance(val, list):
                    val = ",".join(str(l) for l in val)
                if key == "depends_on" and isinstance(val, list):
                    val = json.dumps(val)
                fields.append(f"{key} = ?")
                values.append(val)
        if not fields:
            return web.json_response({"error": "no fields to update"}, status=400)

        # Auto-set timestamps for status changes
        new_status = body.get("status")
        if new_status and new_status != old.get("status"):
            if new_status == "in_progress" and not old.get("started_at"):
                fields.append("started_at = datetime('now')")
            if new_status in ("done", "verified"):
                fields.append("completed_at = datetime('now')")

        fields.append("updated_at = datetime('now')")
        values.append(task_id)
        await db.execute(f"UPDATE tasks SET {', '.join(fields)} WHERE id = ?", values)

        # Record events for key changes
        for key in ("status", "assigned_session_id", "priority", "queued_for_session_id"):
            if key in body and body[key] != old.get(key):
                await db.execute(
                    """INSERT INTO task_events (task_id, event_type, actor, old_value, new_value, message)
                       VALUES (?, ?, 'user', ?, ?, ?)""",
                    (task_id, f"{key}_changed", str(old.get(key)), str(body[key]),
                     f"{key} changed from {old.get(key)} to {body[key]}"),
                )

        # Auto-attach worker-board MCP when a task is assigned to a session
        new_assigned = body.get("assigned_session_id")
        if new_assigned and new_assigned != old.get("assigned_session_id"):
            await db.execute(
                "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
                (new_assigned, "builtin-worker-board"),
            )

        await db.commit()
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        row = await cur.fetchone()
        task = dict(row)
    finally:
        await db.close()

    await broadcast({"type": "task_update", "action": "updated", "task": task})

    _embed_changed = any(
        k in body and body[k] != old.get(k)
        for k in ("title", "description", "acceptance_criteria", "labels")
    )
    if _embed_changed:
        asyncio.create_task(ticket_indexer.reindex_ticket(task))
    else:
        _meta_fields = {
            k: task.get(k) for k in ("status", "assigned_session_id", "labels", "title")
            if k in body
        }
        if _meta_fields:
            asyncio.create_task(ticket_indexer.update_ticket_metadata(
                task.get("workspace_id"), task_id, _meta_fields,
            ))

    # Fire canonical events. We emit a general TASK_UPDATED plus specific
    # events for the transitions plugin authors will care most about
    # (status changes, assignment, plan lifecycle, completion).
    base_payload = {
        "task_id": task_id,
        "workspace_id": task.get("workspace_id"),
        "title": task.get("title"),
        "status": task.get("status"),
    }
    await bus.emit(CommanderEvent.TASK_UPDATED, base_payload,
                   source="api", actor="user")

    new_status = body.get("status")
    if new_status and new_status != old.get("status"):
        await bus.emit(CommanderEvent.TASK_STATUS_CHANGED, {
            **base_payload,
            "old_status": old.get("status"),
            "new_status": new_status,
        }, source="api", actor="user")
        # Transition-specific events for the common cases.
        if new_status == "in_progress":
            await bus.emit(CommanderEvent.TASK_STARTED, base_payload,
                           source="api", actor="user")
        elif new_status == "planning":
            await bus.emit(CommanderEvent.TASK_PLAN_READY, base_payload,
                           source="api", actor="user")
        elif new_status in ("done", "verified"):
            # W2W: Auto-flow digest discoveries → task lessons when completing
            try:
                assigned = task.get("assigned_session_id")
                if assigned and not task.get("lessons_learned"):
                    db2 = await get_db()
                    try:
                        dcur = await db2.execute(
                            "SELECT discoveries, decisions FROM session_digests WHERE session_id = ?",
                            (assigned,),
                        )
                        drow = await dcur.fetchone()
                        if drow:
                            disc = json.loads(drow["discoveries"] or "[]")
                            decs = json.loads(drow["decisions"] or "[]")
                            if disc or decs:
                                lessons = ""
                                if disc:
                                    lessons += "Discoveries:\n" + "\n".join(f"- {d}" for d in disc)
                                if decs:
                                    lessons += ("\n\n" if lessons else "") + "Decisions:\n" + "\n".join(f"- {d}" for d in decs)
                                await db2.execute(
                                    "UPDATE tasks SET lessons_learned = ? WHERE id = ? AND (lessons_learned IS NULL OR lessons_learned = '')",
                                    (lessons, task_id),
                                )
                                await db2.commit()
                                task["lessons_learned"] = lessons
                    finally:
                        await db2.close()
            except Exception:
                pass  # never block task completion

            # Auto-embed completed task for future similarity search
            try:
                from embedder import embed_task
                await embed_task(task)
            except Exception:
                pass

            await bus.emit(CommanderEvent.TASK_COMPLETED, {
                **base_payload,
                "result_summary": task.get("result_summary"),
            }, source="api", actor="user")
        elif new_status == "blocked":
            await bus.emit(CommanderEvent.TASK_BLOCKED, base_payload,
                           source="api", actor="user")

    if "assigned_session_id" in body and body["assigned_session_id"] != old.get("assigned_session_id"):
        new_sid = body["assigned_session_id"]
        await bus.emit(CommanderEvent.TASK_ASSIGNED, {
            **base_payload,
            "session_id": new_sid,
            "previous_session_id": old.get("assigned_session_id"),
        }, source="api", actor="user")

        # W2W: Auto-sync task → session digest on assignment
        if new_sid:
            try:
                db3 = await get_db()
                try:
                    # Ensure digest exists, then set task_summary from task title
                    cur3 = await db3.execute(
                        "SELECT id FROM session_digests WHERE session_id = ?", (new_sid,),
                    )
                    if not await cur3.fetchone():
                        await db3.execute(
                            "INSERT INTO session_digests (id, session_id, workspace_id, task_summary) VALUES (?, ?, ?, ?)",
                            (str(uuid.uuid4()), new_sid, task.get("workspace_id"), task.get("title", "")),
                        )
                    else:
                        await db3.execute(
                            "UPDATE session_digests SET task_summary = ?, updated_at = datetime('now') WHERE session_id = ?",
                            (task.get("title", ""), new_sid),
                        )
                    await db3.commit()

                    # Auto-embed the digest
                    from embedder import embed_digest
                    digest_data = {"session_id": new_sid, "workspace_id": task.get("workspace_id"),
                                   "task_summary": task.get("title", ""), "current_focus": "",
                                   "decisions": "[]", "discoveries": "[]", "files_touched": "[]"}
                    await embed_digest(digest_data)
                finally:
                    await db3.close()
            except Exception:
                pass

    # ── Live edit injection ──────────────────────────────────────────
    # If task is in_progress and has a running assigned session, inject
    # description/criteria changes directly into the agent's PTY.
    if old.get("status") == "in_progress" and task.get("assigned_session_id"):
        changed_fields = []
        if "description" in body and body["description"] != old.get("description"):
            changed_fields.append(("description", body["description"]))
        if "acceptance_criteria" in body and body["acceptance_criteria"] != old.get("acceptance_criteria"):
            changed_fields.append(("acceptance_criteria", body["acceptance_criteria"]))
        if "important_notes" in body and body["important_notes"] != old.get("important_notes"):
            changed_fields.append(("important_notes", body["important_notes"]))

        sid = task["assigned_session_id"]
        if changed_fields and pty_mgr.is_alive(sid):
            injection_parts = ["[Task Update] The task you're working on has been updated:"]
            for field_name, new_val in changed_fields:
                injection_parts.append(f"  {field_name}: {new_val}")
            injection_parts.append("Please take these changes into account in your current work.")
            injection_msg = "\n".join(injection_parts)
            try:
                msg_bytes = injection_msg.encode("utf-8")
                # CLI-aware clear: Gemini uses Ctrl-U, Claude uses Escape+DEL
                _inj_cfg = await get_session_config(sid)
                _inj_cli = _inj_cfg.get("cli_type", "claude") if _inj_cfg else "claude"
                if _inj_cli == "gemini":
                    # Gemini: raw passthrough, collapse newlines (no escape sequences)
                    clean_msg = injection_msg.replace("\n", " ").replace("\r", " ")
                    pty_mgr.write(sid, clean_msg.encode("utf-8") + b"\r")
                else:
                    pty_mgr.write(sid, b"\x1b" + b"\x7f" * 20)
                    await _asyncio.sleep(0.15)
                    pty_mgr.write(sid, msg_bytes)
                    await _asyncio.sleep(0.4)
                    pty_mgr.write(sid, b"\r")
                await bus.emit(CommanderEvent.TASK_EDIT_INJECTED, {
                    "task_id": task_id,
                    "workspace_id": task.get("workspace_id"),
                    "session_id": sid,
                    "changed_fields": [f[0] for f in changed_fields],
                }, source="api", actor="user")
            except Exception:
                logger.exception("Failed to inject task edit into session %s", sid)

    return web.json_response(task)


async def delete_task(request: web.Request) -> web.Response:
    task_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "task not found"}, status=404)
        task = dict(row)
        await db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        await db.commit()
    finally:
        await db.close()

    await broadcast({"type": "task_update", "action": "deleted", "task": task})
    await bus.emit(CommanderEvent.TASK_DELETED, {
        "task_id": task_id,
        "workspace_id": task.get("workspace_id"),
        "title": task.get("title"),
        "status_at_deletion": task.get("status"),
    }, source="api", actor="user")
    asyncio.create_task(ticket_indexer.delete_ticket_index(
        task.get("workspace_id"), task_id,
    ))
    return web.json_response({"ok": True})


async def list_task_events(request: web.Request) -> web.Response:
    task_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at DESC",
            (task_id,),
        )
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


async def iterate_task(request: web.Request) -> web.Response:
    """Request a revision/iteration on a completed task.

    Snapshots the current state into iteration_history, bumps the iteration
    counter, stores last_agent_session_id, resets status to 'todo'.
    Auto-exec will pick it up if enabled.
    """
    task_id = request.match_info["id"]
    body = await request.json()

    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "task not found"}, status=404)
        task = dict(row)

        if task["status"] not in ("done", "review", "verified"):
            return web.json_response(
                {"error": "can only iterate on done/review/verified tasks"}, status=400
            )

        current_iteration = task.get("iteration") or 1

        # Snapshot current state into history — include session digest for full context
        history_entry = {
            "iteration": current_iteration,
            "description": task.get("description"),
            "result_summary": task.get("result_summary"),
            "acceptance_criteria": task.get("acceptance_criteria"),
            "completed_at": task.get("completed_at"),
            "agent_session_id": task.get("assigned_session_id"),
            "lessons_learned": task.get("lessons_learned"),
            "important_notes": task.get("important_notes"),
        }

        # Pull session digest (discoveries, decisions, files_touched) if available
        assigned = task.get("assigned_session_id")
        if assigned:
            try:
                dcur = await db.execute(
                    "SELECT discoveries, decisions, files_touched, current_focus FROM session_digests WHERE session_id = ?",
                    (assigned,),
                )
                drow = await dcur.fetchone()
                if drow:
                    history_entry["discoveries"] = json.loads(drow["discoveries"] or "[]")
                    history_entry["decisions"] = json.loads(drow["decisions"] or "[]")
                    history_entry["files_touched"] = json.loads(drow["files_touched"] or "[]")
                    history_entry["current_focus"] = drow["current_focus"] or ""
            except Exception:
                pass

            # Also grab session name for display
            try:
                scur = await db.execute("SELECT name FROM sessions WHERE id = ?", (assigned,))
                srow = await scur.fetchone()
                if srow:
                    history_entry["agent_session_name"] = srow["name"]
            except Exception:
                pass

        existing_history = []
        if task.get("iteration_history"):
            try:
                existing_history = json.loads(task["iteration_history"])
            except (json.JSONDecodeError, TypeError):
                existing_history = []
        existing_history.append(history_entry)

        new_description = body.get("description", task.get("description"))
        new_acceptance = body.get("acceptance_criteria", task.get("acceptance_criteria"))
        revision_notes = body.get("revision_notes", "")

        await db.execute(
            """UPDATE tasks SET
               iteration = ?,
               iteration_history = ?,
               last_agent_session_id = ?,
               status = 'todo',
               result_summary = NULL,
               completed_at = NULL,
               assigned_session_id = NULL,
               description = ?,
               acceptance_criteria = ?,
               updated_at = datetime('now')
               WHERE id = ?""",
            (
                current_iteration + 1,
                json.dumps(existing_history),
                task.get("assigned_session_id"),
                new_description,
                new_acceptance,
                task_id,
            ),
        )

        # Record event
        msg = f"Iteration {current_iteration + 1} requested"
        if revision_notes:
            msg += f": {revision_notes}"
        await db.execute(
            """INSERT INTO task_events (task_id, event_type, actor, old_value, new_value, message)
               VALUES (?, 'iteration_requested', 'user', ?, ?, ?)""",
            (task_id, str(current_iteration), str(current_iteration + 1), msg),
        )

        await db.commit()
        cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
        updated = dict(await cur.fetchone())
    finally:
        await db.close()

    await broadcast({"type": "task_update", "action": "updated", "task": updated})
    await bus.emit(CommanderEvent.TASK_ITERATION_REQUESTED, {
        "task_id": task_id,
        "workspace_id": updated.get("workspace_id"),
        "title": updated.get("title"),
        "iteration": current_iteration + 1,
        "previous_session_id": task.get("assigned_session_id"),
    }, source="api", actor="user")

    return web.json_response(updated)


# ─── REST: Output Captures ───────────────────────────────────────────

async def list_session_captures(request: web.Request) -> web.Response:
    session_id = request.match_info["id"]
    capture_type = request.query.get("type")
    limit = int(request.query.get("limit", "20"))
    db = await get_db()
    try:
        cur = await db.execute("SELECT 1 FROM sessions WHERE id = ?", (session_id,))
        if not await cur.fetchone():
            return web.json_response({"error": "session not found"}, status=404)
        if capture_type:
            cur = await db.execute(
                """SELECT * FROM output_captures
                   WHERE session_id = ? AND capture_type = ?
                   ORDER BY created_at DESC LIMIT ?""",
                (session_id, capture_type, limit),
            )
        else:
            cur = await db.execute(
                """SELECT * FROM output_captures
                   WHERE session_id = ?
                   ORDER BY created_at DESC LIMIT ?""",
                (session_id, limit),
            )
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


async def _session_exists(session_id: str) -> bool:
    db = await get_db()
    try:
        cur = await db.execute("SELECT 1 FROM sessions WHERE id = ?", (session_id,))
        row = await cur.fetchone()
        return row is not None
    finally:
        await db.close()


async def get_session_output(request: web.Request) -> web.Response:
    session_id = request.match_info["id"]
    if not await _session_exists(session_id):
        return web.json_response({"error": "session not found"}, status=404)
    lines = int(request.query.get("lines", "100"))
    text = capture_proc.get_buffer(session_id, lines)
    return web.json_response({"session_id": session_id, "lines": lines, "text": text})


async def switch_session_cli(request: web.Request) -> web.Response:
    """Switch a session between Claude and Gemini CLI.

    Flow:
    1. Read last N lines of session output → build context summary
    2. Stop current PTY
    3. Update DB: cli_type, model, permission_mode
    4. Clear native_session_id (can't resume cross-CLI)
    5. Store context summary in system_prompt so next start_pty injects it
    6. Return success — frontend will re-trigger start_pty
    """
    session_id = request.match_info["id"]
    body = await request.json()
    new_cli_type = body.get("cli_type")
    if new_cli_type not in ("claude", "gemini"):
        return web.json_response({"error": "cli_type must be 'claude' or 'gemini'"}, status=400)

    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "session not found"}, status=404)
        current = dict(row)
    finally:
        await db.close()

    # Pick sensible defaults for the new CLI
    default_model = get_profile(new_cli_type).default_model
    default_mode = get_profile(new_cli_type).default_permission_mode
    new_model = body.get("model", default_model)
    new_mode = body.get("permission_mode", default_mode)

    # Build rich handoff context (replaces the old 3000-char terminal tail)
    context_summary = ""
    try:
        from memory_sync import sync_manager
        old_cli = current.get("cli_type", "claude")
        workspace_id = current.get("workspace_id", "")
        workspace_path = ""
        if workspace_id:
            db2 = await get_db()
            try:
                cur2 = await db2.execute("SELECT path FROM workspaces WHERE id = ?", (workspace_id,))
                ws_row = await cur2.fetchone()
                if ws_row:
                    workspace_path = ws_row["path"]
            finally:
                await db2.close()

        if workspace_path:
            # Sync memory before switching so central store is up to date
            await sync_manager.sync(workspace_id, workspace_path, source_cli=old_cli)
            context_summary = await sync_manager.build_handoff_context(
                session_id, workspace_id, workspace_path,
                old_cli, new_cli_type, capture_proc=capture_proc,
            )
        else:
            # Fallback if no workspace — use trimmed transcript
            raw_output = capture_proc.get_buffer(session_id, 30)
            clean = _strip_ansi_bytes(
                raw_output.encode("utf-8") if isinstance(raw_output, str) else raw_output
            ).decode("utf-8", errors="replace")
            tail = clean[-2000:].strip()
            if tail:
                context_summary = (
                    f"[Session handoff] Switching from {old_cli.upper()} to "
                    f"{new_cli_type.upper()}.\n\n```\n{tail}\n```"
                )
    except Exception as e:
        logger.warning(f"Failed to build handoff context: {e}")

    # Stop current PTY (kills the CLI process)
    await pty_mgr.stop_session(session_id)

    # Update DB
    db = await get_db()
    try:
        await db.execute(
            """UPDATE sessions SET cli_type = ?, model = ?, permission_mode = ?,
               native_session_id = NULL, native_slug = NULL, system_prompt = ?
               WHERE id = ?""",
            (new_cli_type, new_model, new_mode, context_summary or None, session_id),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        row = await cur.fetchone()
        result = dict(row)
    finally:
        await db.close()

    # Notify frontend — it will re-trigger start_pty with the new config
    await broadcast({
        "type": "session_switched",
        "session_id": session_id,
        "cli_type": new_cli_type,
        "model": new_model,
    })
    return web.json_response(result)


async def switch_model(request: web.Request) -> web.Response:
    """Switch a session's active model by injecting /model X into the PTY.

    Unlike switch_session_cli (which kills and restarts the PTY), this is a
    lightweight in-session model change. Both Claude Code and Gemini CLI
    support /model as a slash command.
    """
    session_id = request.match_info["id"]
    # MCP-S5: only commander or the session itself can flip its model. The
    # MCP gate at switch_model is meaningless if any worker can hit this
    # route directly and bump a peer to opus mid-run.
    caller = await _resolve_caller(request)
    if caller and caller["session_type"] != "commander" and caller["session_id"] != session_id:
        return web.json_response(
            {"error": "forbidden: only commander or the session itself can switch its model"},
            status=403,
        )
    body = await request.json()
    model_name = body.get("model", "").strip()
    if not model_name:
        return web.json_response({"error": "model required"}, status=400)

    if not pty_mgr.is_alive(session_id):
        return web.json_response({"error": "session not running"}, status=400)

    # Inject /model command into PTY (short command, no newlines)
    cmd = f"/model {model_name}"
    pty_mgr.write(session_id, cmd.encode("utf-8") + b"\r")

    # Update DB so UI reflects new model
    db = await get_db()
    try:
        await db.execute(
            "UPDATE sessions SET model = ? WHERE id = ?",
            (model_name, session_id),
        )
        await db.commit()
    finally:
        await db.close()

    # Broadcast model change to frontend
    await broadcast({
        "type": "model_changed",
        "session_id": session_id,
        "model": model_name,
    })

    return web.json_response({"ok": True, "session_id": session_id, "model": model_name})


async def send_session_input(request: web.Request) -> web.Response:
    """Type text into a running session's PTY. Used by MCP server's send_message tool."""
    session_id = request.match_info["id"]
    body = await request.json()
    message = body.get("message", "")
    if not message:
        return web.json_response({"error": "message required"}, status=400)

    if not pty_mgr.is_alive(session_id):
        return web.json_response({"error": "session not running"}, status=400)

    # Look up CLI type — Gemini's TUI handles escape sequences differently
    # than Claude Code's Ink-based TUI, so we use CLI-specific input strategies.
    cli_type = "claude"
    try:
        config = await get_session_config(session_id)
        if config:
            cli_type = config.get("cli_type", "claude")
    except Exception:
        pass  # fall back to claude behavior

    msg_bytes = message.encode("utf-8")

    if cli_type == "gemini":
        # Gemini CLI: Write text directly, same as WebSocket passthrough.
        #
        # Gemini's Ink TUI does NOT handle Ctrl-U, Escape, or bracketed paste
        # sequences the way Claude's does. These cause unexpected exits (code 0).
        # The WebSocket input handler (which the browser uses) works perfectly
        # because it just writes raw bytes — so we do the same here.
        #
        # For multi-line messages: collapse to single line. Gemini's TUI treats
        # \n as Enter (submits partial lines). The model will still understand
        # the intent from a single-line version.
        clean = message.replace("\n", " ").replace("\r", " ")
        pty_mgr.write(session_id, clean.encode("utf-8") + b"\r")
    elif len(message) < 100 and "\n" not in message:
        # Claude short messages / control keys: send directly (no Escape
        # prefix which would cancel active selection prompts like "trust
        # this folder")
        pty_mgr.write(session_id, msg_bytes + b"\r")
    else:
        # Claude long/multiline: Escape to clear Ink input, text, delay, Enter
        pty_mgr.write(session_id, b"\x1b" + b"\x7f" * 20)  # Escape + backspaces
        await _asyncio.sleep(0.15)
        pty_mgr.write(session_id, msg_bytes)
        await _asyncio.sleep(0.4)  # Wait for paste bracket to close
        pty_mgr.write(session_id, b"\r")
    return web.json_response({"ok": True, "session_id": session_id})


async def broadcast_input(request: web.Request) -> web.Response:
    """Type text into multiple sessions' PTYs."""
    body = await request.json()
    session_ids = body.get("session_ids", [])
    message = body.get("message", "")
    if not message or not session_ids:
        return web.json_response({"error": "session_ids and message required"}, status=400)

    sent = []
    msg_bytes = message.encode("utf-8")
    for sid in session_ids:
        if pty_mgr.is_alive(sid):
            # Split text and \r — a combined blob can be paste-detected
            # by Ink and the trailing CR dropped, leaving the prompt
            # typed but never submitted.
            pty_mgr.write(sid, msg_bytes)
            sent.append(sid)
    if sent:
        await _asyncio.sleep(0.4)
        for sid in sent:
            if pty_mgr.is_alive(sid):
                pty_mgr.write(sid, b"\r")
    if sent:
        await bus.emit(CommanderEvent.COMMANDER_BROADCAST, {
            "session_ids": sent,
            "session_count": len(sent),
            "message_length": len(message),
        }, source="api", actor="user")
    return web.json_response({"ok": True, "sent_to": sent})


# ─── REST: URL Screenshot ─────────────────────────────────────────────

def _check_screenshot_tools() -> str | None:
    """Return the available screenshot tool name, or None if nothing is installed."""
    import shutil
    if shutil.which("webkit2png"):
        return "webkit2png"
    # Check if playwright + chromium are importable
    import subprocess
    try:
        proc = subprocess.run(
            ["python3", "-c", "from playwright.sync_api import sync_playwright"],
            capture_output=True, timeout=5
        )
        if proc.returncode == 0:
            return "playwright"
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return None


# ─── REST: Preview Proxy ──────────────────────────────────────────────

async def preview_proxy(request: web.Request) -> web.Response:
    """Reverse-proxy a URL stripping X-Frame-Options / CSP so it loads in an iframe.
    Sub-resources resolve against the original server via an injected <base> tag."""
    from urllib.parse import urlparse, urljoin
    import re

    url = request.query.get("url", "").strip()
    if not url:
        return web.json_response({"error": "url required"}, status=400)
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    parsed = urlparse(url)
    base_origin = f"{parsed.scheme}://{parsed.netloc}"

    try:
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, allow_redirects=True, ssl=False) as resp:
                body = await resp.read()
                ct = resp.content_type or "text/html"

                # Build response headers — copy safe ones, drop frame-blockers
                drop = {
                    "x-frame-options", "content-security-policy",
                    "content-security-policy-report-only",
                    "content-type", "content-length",
                    "transfer-encoding", "content-encoding",
                }
                headers = {
                    k: v for k, v in resp.headers.items()
                    if k.lower() not in drop
                }

                # For HTML: inject <base> + fetch/XHR interceptor so the
                # proxied page can load sub-resources and make API calls
                if "html" in ct:
                    html = body.decode("utf-8", errors="replace")
                    import json as _json
                    base_tag = f'<base href="{base_origin}/">'
                    # Intercept fetch/XHR so JS API calls to the remote
                    # origin go through our proxy instead of being CORS-blocked
                    intercept_script = (
                        '<script data-preview-proxy>'
                        '(function(){'
                        'var R=' + _json.dumps(base_origin) + ';'
                        'var P=window.location.origin+"/api/preview-proxy?url=";'
                        'function rw(u){'
                        'try{var o=new URL(u,R);if(o.origin===R)return P+encodeURIComponent(o.href)}catch(e){}'
                        'return null}'
                        'var oF=window.fetch;'
                        'window.fetch=function(i,n){'
                        'if(typeof i==="string"){var r=rw(i);if(r)i=r}'
                        'else if(i instanceof Request){var r=rw(i.url);if(r)i=new Request(r,i)}'
                        'return oF.call(this,i,n)};'
                        'var oO=XMLHttpRequest.prototype.open;'
                        'XMLHttpRequest.prototype.open=function(m,u){'
                        'var r=rw(u);if(r)arguments[1]=r;'
                        'return oO.apply(this,arguments)};'
                        '})();'
                        '</script>'
                    )
                    inject = base_tag + intercept_script
                    if "<head" in html.lower():
                        html = re.sub(
                            r"(<head[^>]*>)", r"\1" + inject, html, count=1, flags=re.IGNORECASE
                        )
                    elif "<html" in html.lower():
                        html = re.sub(
                            r"(<html[^>]*>)", r"\1<head>" + inject + "</head>", html, count=1, flags=re.IGNORECASE
                        )
                    else:
                        html = inject + html
                    body = html.encode("utf-8")

                return web.Response(
                    body=body,
                    status=resp.status,
                    content_type=ct,
                    headers=headers,
                )
    except aiohttp.ClientConnectorError:
        return web.json_response({"error": f"Cannot connect to {base_origin}"}, status=502)
    except aiohttp.ClientError as e:
        return web.json_response({"error": str(e)}, status=502)
    except Exception as e:
        return web.json_response({"error": f"Proxy error: {e}"}, status=500)


def _capture_url_to_png(url: str, filepath) -> dict:
    """Capture `url` to `filepath` (PNG). Tries webkit2png then playwright.
    Returns {"ok": True} on success, or {"error": str, "reason": "no_tools"|"unreachable"|"timeout"|"capture_failed"}."""
    import subprocess

    # Sanitize: reject URLs with characters that could break subprocess args
    if any(c in url for c in ("'", '"', ';', '`', '$', '\\', '\n', '\r')):
        return {"error": f"Invalid characters in URL", "reason": "capture_failed"}

    try:
        # Method 1: macOS webkit2png (if installed)
        subprocess.run(
            ["webkit2png", "--fullsize", "--filename", str(filepath).replace('.png', ''), url],
            capture_output=True, timeout=30
        )
        fullpath = filepath.parent / (filepath.stem + "-full.png")
        if fullpath.exists():
            fullpath.rename(filepath)
        elif not filepath.exists():
            raise FileNotFoundError("webkit2png failed")
        return {"ok": True}
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # Method 2: playwright — pass URL and filepath via env to avoid injection
    import os
    env = {**os.environ, "_SCREENSHOT_URL": url, "_SCREENSHOT_PATH": str(filepath)}
    try:
        proc = subprocess.run(
            ["python3", "-c", """
import asyncio, os
from playwright.async_api import async_playwright
async def main():
    url = os.environ["_SCREENSHOT_URL"]
    path = os.environ["_SCREENSHOT_PATH"]
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1280, "height": 800})
        await page.goto(url, wait_until="networkidle", timeout=15000)
        await page.screenshot(path=path, full_page=False)
        await browser.close()
asyncio.run(main())
"""],
            capture_output=True, text=True, timeout=30, env=env,
        )
        if filepath.exists():
            return {"ok": True}
        # Playwright ran but failed — parse stderr for clues
        stderr = (proc.stderr or "").strip()
        if "ERR_CONNECTION_REFUSED" in stderr or "ERR_NAME_NOT_RESOLVED" in stderr or "NS_ERROR_UNKNOWN_HOST" in stderr:
            host = url.split("//")[-1].split("/")[0]
            return {"error": f"Site unreachable: {host}", "reason": "unreachable"}
        if "Timeout" in stderr or "timeout" in stderr:
            return {"error": f"Page load timed out for {url}", "reason": "timeout"}
        if "Executable doesn't exist" in stderr or "browserType.launch" in stderr:
            return {"error": "Chromium not installed. Run: playwright install chromium", "reason": "no_tools"}
        return {"error": f"Screenshot capture failed", "reason": "capture_failed", "detail": stderr[-300:] if stderr else ""}
    except FileNotFoundError:
        return {"error": "No screenshot tool available. Install playwright: pip3 install playwright && playwright install chromium", "reason": "no_tools"}
    except subprocess.TimeoutExpired:
        return {"error": f"Screenshot timed out after 30s for {url}", "reason": "timeout"}


async def _run_capture(url: str, filepath) -> dict:
    """Run _capture_url_to_png in a thread so we don't block the event loop."""
    import asyncio
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _capture_url_to_png, url, filepath)


async def take_screenshot(request: web.Request) -> web.Response:
    """Take a screenshot of a URL using macOS webkit or playwright if available."""
    import time

    url = request.query.get("url", "").strip()
    if not url:
        return web.json_response({"error": "url required"}, status=400)
    # Normalize: add https:// if no protocol specified
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    from config import DATA_DIR
    paste_dir = DATA_DIR / "pastes"
    paste_dir.mkdir(parents=True, exist_ok=True)
    filename = f"screenshot_{int(time.time())}.png"
    filepath = paste_dir / filename

    result = await _run_capture(url, filepath)
    if not result.get("ok"):
        status = 502 if result.get("reason") == "unreachable" else 504 if result.get("reason") == "timeout" else 500
        return web.json_response({"error": result["error"], "reason": result.get("reason", "capture_failed")}, status=status)

    return web.FileResponse(filepath, headers={
        "Content-Type": "image/png",
        "Content-Disposition": f'attachment; filename="{filename}"',
    })


async def get_workspace_preview_screenshot(request: web.Request) -> web.Response:
    """Screenshot the preview_url configured for a workspace.
    Convenience endpoint so the Commander MCP only needs a workspace_id."""
    import time
    ws_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("SELECT preview_url FROM workspaces WHERE id = ?", (ws_id,))
        row = await cur.fetchone()
    finally:
        await db.close()
    if not row:
        return web.json_response({"error": "workspace not found"}, status=404)
    url = (row["preview_url"] or "").strip()
    if not url:
        return web.json_response({"error": "no preview_url set for this workspace"}, status=400)
    # Normalize: add https:// if no protocol specified
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    from config import DATA_DIR
    paste_dir = DATA_DIR / "pastes"
    paste_dir.mkdir(parents=True, exist_ok=True)
    filename = f"preview_{ws_id}_{int(time.time())}.png"
    filepath = paste_dir / filename

    result = await _run_capture(url, filepath)
    if not result.get("ok"):
        status = 502 if result.get("reason") == "unreachable" else 504 if result.get("reason") == "timeout" else 500
        return web.json_response({"error": result["error"], "reason": result.get("reason", "capture_failed")}, status=status)

    return web.FileResponse(filepath, headers={
        "Content-Type": "image/png",
        "Content-Disposition": f'inline; filename="{filename}"',
    })


# ─── REST: Install Screenshot Tools ──────────────────────────────────

async def install_screenshot_tools(request: web.Request) -> web.Response:
    """Install playwright + chromium so the screenshot endpoints work.
    Runs pip3 install and playwright install as subprocesses."""
    import subprocess

    steps = []
    # Step 1: pip install playwright
    try:
        proc = subprocess.run(
            ["pip3", "install", "playwright"],
            capture_output=True, text=True, timeout=120,
        )
        steps.append({
            "step": "pip3 install playwright",
            "ok": proc.returncode == 0,
            "output": (proc.stdout + proc.stderr).strip()[-500:],  # last 500 chars
        })
        if proc.returncode != 0:
            return web.json_response({"ok": False, "steps": steps}, status=500)
    except Exception as e:
        steps.append({"step": "pip3 install playwright", "ok": False, "output": str(e)})
        return web.json_response({"ok": False, "steps": steps}, status=500)

    # Step 2: playwright install chromium
    try:
        proc = subprocess.run(
            ["python3", "-m", "playwright", "install", "chromium"],
            capture_output=True, text=True, timeout=300,
        )
        steps.append({
            "step": "playwright install chromium",
            "ok": proc.returncode == 0,
            "output": (proc.stdout + proc.stderr).strip()[-500:],
        })
        if proc.returncode != 0:
            return web.json_response({"ok": False, "steps": steps}, status=500)
    except Exception as e:
        steps.append({"step": "playwright install chromium", "ok": False, "output": str(e)})
        return web.json_response({"ok": False, "steps": steps}, status=500)

    return web.json_response({"ok": True, "steps": steps})


# ─── REST: Paste Image ────────────────────────────────────────────────

async def paste_image(request: web.Request) -> web.Response:
    """Save a pasted clipboard image, return its file path for Claude Code."""
    import os
    import time
    from config import DATA_DIR

    paste_dir = DATA_DIR / "pastes"
    paste_dir.mkdir(parents=True, exist_ok=True)

    reader = await request.multipart()
    field = await reader.next()
    if not field:
        return web.json_response({"error": "no file"}, status=400)

    # Determine extension from content type
    ct = field.headers.get('Content-Type', 'image/png')
    ext_map = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg'}
    ext = ext_map.get(ct, 'png')

    filename = f"paste_{int(time.time())}_{uuid.uuid4().hex[:6]}.{ext}"
    filepath = paste_dir / filename

    with open(filepath, 'wb') as f:
        while True:
            chunk = await field.read_chunk()
            if not chunk:
                break
            f.write(chunk)

    return web.json_response({
        "path": str(filepath),
        "url": f"/api/pastes/{filename}",
        "filename": filename,
        "size": os.path.getsize(filepath),
    }, status=201)


async def serve_paste(request: web.Request) -> web.Response:
    from config import DATA_DIR
    filename = request.match_info["filename"]
    base_dir = (DATA_DIR / "pastes").resolve()
    filepath = (base_dir / filename).resolve()
    if not filepath.is_relative_to(base_dir):
        return web.json_response({"error": "invalid path"}, status=400)
    try:
        return web.FileResponse(filepath)
    except (FileNotFoundError, IsADirectoryError):
        return web.json_response({"error": "not found"}, status=404)


# ─── REST: Attachments ────────────────────────────────────────────────

async def upload_attachment(request: web.Request) -> web.Response:
    """Upload an image/file attachment for a task."""
    import os
    from config import ATTACHMENTS_DIR

    task_id = request.match_info["id"]
    # Validate task exists. Without this, any UUID would create
    # ~/.ive/attachments/<random>/<file> — disk-fill DoS (BUG H3).
    _check_db = await get_db()
    try:
        cur = await _check_db.execute("SELECT id FROM tasks WHERE id = ?", (task_id,))
        if not await cur.fetchone():
            return web.json_response({"error": "task not found"}, status=404)
    finally:
        await _check_db.close()

    reader = await request.multipart()

    ATTACHMENTS_DIR.mkdir(parents=True, exist_ok=True)
    task_dir = ATTACHMENTS_DIR / task_id
    task_dir.mkdir(exist_ok=True)

    files_saved = []
    while True:
        field = await reader.next()
        if field is None:
            break
        if field.name == 'file':
            filename = field.filename or f"upload_{uuid.uuid4().hex[:8]}"
            # Sanitize filename
            safe_name = "".join(c for c in filename if c.isalnum() or c in '._-')
            filepath = task_dir / safe_name
            with open(filepath, 'wb') as f:
                while True:
                    chunk = await field.read_chunk()
                    if not chunk:
                        break
                    f.write(chunk)
            files_saved.append({
                "filename": safe_name,
                "url": f"/api/attachments/{task_id}/{safe_name}",
                "path": str(filepath),
                "size": os.path.getsize(filepath),
            })

    return web.json_response({"files": files_saved}, status=201)


async def serve_attachment(request: web.Request) -> web.Response:
    """Serve a task attachment file."""
    from config import ATTACHMENTS_DIR
    task_id = request.match_info["task_id"]
    filename = request.match_info["filename"]

    base_dir = ATTACHMENTS_DIR.resolve()
    filepath = (base_dir / task_id / filename).resolve()
    if not filepath.is_relative_to(base_dir):
        return web.json_response({"error": "invalid path"}, status=400)
    try:
        return web.FileResponse(filepath)
    except (FileNotFoundError, IsADirectoryError):
        return web.json_response({"error": "not found"}, status=404)


async def list_attachments(request: web.Request) -> web.Response:
    """List all attachments for a task."""
    import os
    from config import ATTACHMENTS_DIR
    task_id = request.match_info["id"]

    task_dir = ATTACHMENTS_DIR / task_id
    if not task_dir.exists():
        return web.json_response([])

    files = []
    for f in sorted(task_dir.iterdir()):
        if f.is_file():
            files.append({
                "filename": f.name,
                "url": f"/api/attachments/{task_id}/{f.name}",
                "path": str(f),
                "size": os.path.getsize(f),
            })
    return web.json_response(files)


# ─── REST: Research DB ────────────────────────────────────────────────

async def list_research(request: web.Request) -> web.Response:
    workspace_id = request.query.get("workspace_id") or request.query.get("workspace")
    feature = request.query.get("feature")
    db = await get_db()
    try:
        query = "SELECT * FROM research_entries"
        params = []
        conditions = []
        if workspace_id:
            conditions.append("workspace_id = ?")
            params.append(workspace_id)
        if feature:
            conditions.append("feature_tag = ?")
            params.append(feature)
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY updated_at DESC"
        cur = await db.execute(query, params)
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


async def create_research(request: web.Request) -> web.Response:
    body = await request.json()
    topic = body.get("topic", "").strip()
    if not topic:
        return web.json_response({"error": "topic required"}, status=400)

    entry_id = str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO research_entries (id, workspace_id, topic, query, feature_tag, status, session_id, findings_summary)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (entry_id, body.get("workspace_id"), topic, body.get("query", topic),
             body.get("feature_tag"), body.get("status", "pending"), body.get("session_id"),
             body.get("findings_summary")),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM research_entries WHERE id = ?", (entry_id,))
        row = await cur.fetchone()
        return web.json_response(dict(row), status=201)
    finally:
        await db.close()


async def update_research(request: web.Request) -> web.Response:
    entry_id = request.match_info["id"]
    body = await request.json()
    db = await get_db()
    try:
        allowed = ("topic", "query", "feature_tag", "status", "findings_summary", "session_id")
        fields, values = [], []
        for key in allowed:
            if key in body:
                fields.append(f"{key} = ?")
                values.append(body[key])
        if not fields:
            return web.json_response({"error": "no fields"}, status=400)
        fields.append("updated_at = datetime('now')")
        values.append(entry_id)
        await db.execute(f"UPDATE research_entries SET {', '.join(fields)} WHERE id = ?", values)
        await db.commit()
        cur = await db.execute("SELECT * FROM research_entries WHERE id = ?", (entry_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "research entry not found"}, status=404)
        return web.json_response(dict(row))
    finally:
        await db.close()


async def get_research_with_sources(request: web.Request) -> web.Response:
    entry_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM research_entries WHERE id = ?", (entry_id,))
        entry = await cur.fetchone()
        if not entry:
            return web.json_response({"error": "not found"}, status=404)
        entry = dict(entry)

        cur = await db.execute(
            "SELECT * FROM research_sources WHERE entry_id = ? ORDER BY relevance_score DESC, created_at",
            (entry_id,),
        )
        sources = [dict(r) for r in await cur.fetchall()]
        entry["sources"] = sources
        return web.json_response(entry)
    finally:
        await db.close()


async def add_research_source(request: web.Request) -> web.Response:
    entry_id = request.match_info["id"]
    body = await request.json()
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO research_sources (entry_id, url, title, content_summary, raw_content, relevance_score)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (entry_id, body.get("url"), body.get("title"), body.get("content_summary"),
             body.get("raw_content"), body.get("relevance_score", 0)),
        )
        await db.commit()
        return web.json_response({"ok": True})
    finally:
        await db.close()


async def delete_research(request: web.Request) -> web.Response:
    entry_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("DELETE FROM research_entries WHERE id = ?", (entry_id,))
        await db.commit()
        if cur.rowcount == 0:
            return web.json_response({"error": "research entry not found"}, status=404)
        return web.json_response({"ok": True})
    finally:
        await db.close()


async def search_research(request: web.Request) -> web.Response:
    """Full-text search across research entries and sources."""
    q = request.query.get("q", "").strip()
    workspace_id = request.query.get("workspace_id") or request.query.get("workspace")
    if not q:
        return web.json_response([])
    db = await get_db()
    try:
        query = """
            SELECT DISTINCT e.* FROM research_entries e
            LEFT JOIN research_sources s ON e.id = s.entry_id
            WHERE (e.topic LIKE ? OR e.findings_summary LIKE ? OR s.content_summary LIKE ? OR s.title LIKE ?)
        """
        params = [f"%{q}%"] * 4
        if workspace_id:
            query += " AND e.workspace_id = ?"
            params.append(workspace_id)
        query += " ORDER BY e.updated_at DESC LIMIT 50"
        cur = await db.execute(query, params)
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


# ─── REST: AGENTS.md ──────────────────────────────────────────────────

async def get_agents_md(request: web.Request) -> web.Response:
    """Read AGENTS.md files from workspace directory hierarchy."""
    workspace_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("SELECT path FROM workspaces WHERE id = ?", (workspace_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "workspace not found"}, status=404)
        ws_path = row["path"]
    finally:
        await db.close()

    import os
    agents_files = []
    scan_dir = ws_path
    for _ in range(10):
        agents_file = os.path.join(scan_dir, "AGENTS.md")
        if os.path.isfile(agents_file):
            try:
                with open(agents_file, "r") as f:
                    agents_files.append({
                        "path": agents_file,
                        "relative": os.path.relpath(agents_file, ws_path),
                        "content": f.read(),
                    })
            except (OSError, IOError):
                pass
        parent = os.path.dirname(scan_dir)
        if parent == scan_dir:
            break
        scan_dir = parent

    return web.json_response({
        "workspace_id": workspace_id,
        "workspace_path": ws_path,
        "files": agents_files,
    })


async def save_agents_md(request: web.Request) -> web.Response:
    """Create or update AGENTS.md in the workspace root."""
    workspace_id = request.match_info["id"]
    body = await request.json()
    content = body.get("content", "")

    db = await get_db()
    try:
        cur = await db.execute("SELECT path FROM workspaces WHERE id = ?", (workspace_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "workspace not found"}, status=404)
        ws_path = row["path"]
    finally:
        await db.close()

    import os
    agents_file = os.path.join(ws_path, "AGENTS.md")
    try:
        with open(agents_file, "w") as f:
            f.write(content)
        return web.json_response({"ok": True, "path": agents_file})
    except (OSError, IOError) as e:
        return web.json_response({"error": str(e)}, status=500)


# ─── REST: Git Operations (Code Review) ───────────────────────────────

import git_ops


async def _get_workspace_path(workspace_id: str) -> str | None:
    """Look up workspace path from DB. Returns None if not found."""
    db = await get_db()
    try:
        cur = await db.execute("SELECT path FROM workspaces WHERE id = ?", (workspace_id,))
        row = await cur.fetchone()
        return row["path"] if row else None
    finally:
        await db.close()


async def get_workspace_git_status(request: web.Request) -> web.Response:
    ws_path = await _get_workspace_path(request.match_info["id"])
    if not ws_path:
        return web.json_response({"error": "workspace not found"}, status=404)
    try:
        result = await git_ops.git_status(ws_path)
        return web.json_response(result)
    except Exception as e:
        logger.exception("git_status failed")
        return web.json_response({"error": str(e)}, status=500)


async def get_workspace_git_diff(request: web.Request) -> web.Response:
    ws_path = await _get_workspace_path(request.match_info["id"])
    if not ws_path:
        return web.json_response({"error": "workspace not found"}, status=404)
    staged = request.query.get("staged") == "1"
    commit_range = request.query.get("range")
    file_path = request.query.get("file")
    try:
        result = await git_ops.git_diff(ws_path, staged=staged, commit_range=commit_range, file_path=file_path)
        return web.json_response(result)
    except Exception as e:
        logger.exception("git_diff failed")
        return web.json_response({"error": str(e)}, status=500)


async def get_workspace_git_log(request: web.Request) -> web.Response:
    ws_path = await _get_workspace_path(request.match_info["id"])
    if not ws_path:
        return web.json_response({"error": "workspace not found"}, status=404)
    count = min(int(request.query.get("count", 20)), 100)
    try:
        commits = await git_ops.git_log(ws_path, count=count)
        return web.json_response({"commits": commits})
    except Exception as e:
        logger.exception("git_log failed")
        return web.json_response({"error": str(e)}, status=500)


IDE_COMMANDS = {
    "vscode": ["code"],
    "cursor": ["cursor"],
    "zed": ["zed"],
    "sublime": ["subl"],
    "idea": ["idea"],
    "webstorm": ["webstorm"],
    "vim": ["vim"],
    "neovim": ["nvim"],
    "antigravity": ["antigravity"],
}


async def open_in_ide(request: web.Request) -> web.Response:
    """Open a file (optionally at a line) in the user's configured IDE."""
    body = await request.json()
    file_path = body.get("file")
    workspace_id = body.get("workspace_id")
    line = body.get("line")

    if not file_path or not workspace_id or not isinstance(file_path, str):
        return web.json_response({"error": "file and workspace_id required"}, status=400)

    # Validate line number
    if line is not None:
        try:
            line = int(line)
            if line < 1 or line > 1_000_000:
                line = None
        except (ValueError, TypeError):
            line = None

    ws_path = await _get_workspace_path(workspace_id)
    if not ws_path:
        return web.json_response({"error": "workspace not found"}, status=404)

    import os
    full_path = os.path.normpath(os.path.join(ws_path, file_path))
    if not full_path.startswith(os.path.normpath(ws_path) + os.sep) and full_path != os.path.normpath(ws_path):
        return web.json_response({"error": "invalid path"}, status=400)
    if not os.path.exists(full_path):
        return web.json_response({"error": "file not found"}, status=404)

    # Get IDE preference from app_settings
    db = await get_db()
    try:
        cur = await db.execute("SELECT value FROM app_settings WHERE key = 'ide'")
        row = await cur.fetchone()
        ide = row["value"] if row else "vscode"
    finally:
        await db.close()

    cmd_parts = IDE_COMMANDS.get(ide, ["code"])

    # Build the file argument with optional line number
    if line and ide in ("vscode", "cursor"):
        file_arg = f"{full_path}:{line}"
        args = cmd_parts + ["--goto", file_arg]
    elif line and ide in ("sublime",):
        args = cmd_parts + [f"{full_path}:{line}"]
    elif line and ide in ("idea", "webstorm"):
        args = cmd_parts + ["--line", str(line), full_path]
    else:
        args = cmd_parts + [full_path]

    import subprocess
    try:
        subprocess.Popen(args, cwd=ws_path, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return web.json_response({"ok": True, "ide": ide, "file": file_path})
    except FileNotFoundError:
        return web.json_response(
            {"error": f"IDE command '{cmd_parts[0]}' not found. Is {ide} installed and in PATH?"},
            status=500,
        )
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ─── REST: Workspace Overview ─────────────────────────────────────────

IGNORE_DIRS = {'.git', 'node_modules', '__pycache__', '.next', 'dist', 'build', '.venv', 'venv', '.DS_Store'}

async def get_workspace_overview(request: web.Request) -> web.Response:
    workspace_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("SELECT path FROM workspaces WHERE id = ?", (workspace_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "workspace not found"}, status=404)
        ws_path = row["path"]
    finally:
        await db.close()

    import os
    tree_lines = []
    files_list = []
    total_files = 0

    for root, dirs, files in os.walk(ws_path):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        rel = os.path.relpath(root, ws_path)
        depth = 0 if rel == '.' else rel.count(os.sep) + 1
        if depth <= 3:
            indent = '  ' * depth
            dirname = os.path.basename(root) + '/' if rel != '.' else ''
            if dirname:
                tree_lines.append(f"{indent}{dirname}")
            for f in sorted(files):
                if f.startswith('.') and f != '.env.example':
                    continue
                total_files += 1
                fp = os.path.join(root, f)
                ext = os.path.splitext(f)[1].lstrip('.')
                try:
                    size = os.path.getsize(fp)
                except OSError:
                    size = 0
                tree_lines.append(f"{indent}  {f}")
                files_list.append({"path": os.path.relpath(fp, ws_path), "size": size, "type": ext})

    # Count by type
    by_type = {}
    for f in files_list:
        by_type[f["type"]] = by_type.get(f["type"], 0) + 1
    summary_parts = [f"{count} .{ext}" for ext, count in sorted(by_type.items(), key=lambda x: -x[1])]

    return web.json_response({
        "tree": "\n".join(tree_lines),
        "files": files_list[:200],
        "total_files": total_files,
        "summary": f"{total_files} files: {', '.join(summary_parts[:8])}",
    })


# ─── REST: Memory Sync ───────────────────────────────────────────────


async def _get_workspace_path_or_error(workspace_id: str):
    """Helper: look up workspace path. Returns (path, error_response)."""
    db = await get_db()
    try:
        cur = await db.execute("SELECT path FROM workspaces WHERE id = ?", (workspace_id,))
        row = await cur.fetchone()
        if not row:
            return None, web.json_response({"error": "workspace not found"}, status=404)
        return row["path"], None
    finally:
        await db.close()


async def get_workspace_memory(request: web.Request) -> web.Response:
    """GET /api/workspaces/{id}/memory — central memory + sync status."""
    workspace_id = request.match_info["id"]
    ws_path, err = await _get_workspace_path_or_error(workspace_id)
    if err:
        return err

    from memory_sync import sync_manager
    status = await sync_manager.get_status(workspace_id, ws_path)
    central = await sync_manager.read_central(workspace_id)

    return web.json_response({
        "content": central,
        "enabled": status.enabled,
        "auto_sync": status.auto_sync,
        "last_synced_at": status.last_synced_at,
        "central_content_length": status.central_content_length,
        "providers": status.providers,
    })


async def update_workspace_memory(request: web.Request) -> web.Response:
    """PUT /api/workspaces/{id}/memory — update central memory content."""
    workspace_id = request.match_info["id"]
    body = await request.json()
    content = body.get("content")
    if content is None:
        return web.json_response({"error": "content required"}, status=400)

    from memory_sync import sync_manager
    await sync_manager.write_central(workspace_id, content)
    return web.json_response({"ok": True, "content_length": len(content)})


async def sync_workspace_memory(request: web.Request) -> web.Response:
    """POST /api/workspaces/{id}/memory/sync — trigger sync."""
    workspace_id = request.match_info["id"]
    ws_path, err = await _get_workspace_path_or_error(workspace_id)
    if err:
        return err

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    from memory_sync import sync_manager
    import dataclasses
    result = await sync_manager.sync(
        workspace_id, ws_path,
        source_cli=body.get("source_cli"),
    )
    # After successful sync, also push Commander memory entries to CLI native format
    if result.status == "synced":
        import asyncio as _aio
        _aio.create_task(_sync_memory_to_cli(workspace_id))
    return web.json_response(dataclasses.asdict(result))


async def get_workspace_memory_diff(request: web.Request) -> web.Response:
    """GET /api/workspaces/{id}/memory/diff — preview what sync would change."""
    workspace_id = request.match_info["id"]
    ws_path, err = await _get_workspace_path_or_error(workspace_id)
    if err:
        return err

    from memory_sync import sync_manager
    diffs = await sync_manager.get_diff(workspace_id, ws_path)
    return web.json_response(diffs)


async def resolve_workspace_memory(request: web.Request) -> web.Response:
    """POST /api/workspaces/{id}/memory/resolve — resolve merge conflicts."""
    workspace_id = request.match_info["id"]
    ws_path, err = await _get_workspace_path_or_error(workspace_id)
    if err:
        return err

    body = await request.json()
    resolved = body.get("resolved_content")
    if resolved is None:
        return web.json_response({"error": "resolved_content required"}, status=400)

    from memory_sync import sync_manager
    import dataclasses
    # BUG M12: clients (frontend, MCP, tests) send the targets list under
    # either `push_to` or `providers`; honour whichever is supplied.
    targets = body.get("push_to") or body.get("providers")
    if isinstance(targets, str):
        targets = [t.strip() for t in targets.split(",") if t.strip()]
    result = await sync_manager.resolve_conflicts(
        workspace_id, ws_path, resolved,
        push_to=targets,
    )
    return web.json_response(dataclasses.asdict(result))


async def get_workspace_memory_settings(request: web.Request) -> web.Response:
    """GET /api/workspaces/{id}/memory/settings."""
    workspace_id = request.match_info["id"]
    from memory_sync import sync_manager
    settings = await sync_manager.get_settings(workspace_id)
    return web.json_response(settings)


async def update_workspace_memory_settings(request: web.Request) -> web.Response:
    """PUT /api/workspaces/{id}/memory/settings — toggle auto-sync, etc."""
    workspace_id = request.match_info["id"]
    body = await request.json()
    from memory_sync import sync_manager
    settings = await sync_manager.update_settings(workspace_id, body)
    return web.json_response(settings)


async def get_workspace_auto_memory(request: web.Request) -> web.Response:
    """GET /api/workspaces/{id}/memory/auto — auto-memory entries from all CLIs."""
    workspace_id = request.match_info["id"]
    ws_path, err = await _get_workspace_path_or_error(workspace_id)
    if err:
        return err

    from memory_sync import sync_manager
    entries = await sync_manager.read_all_auto_memory(ws_path)
    return web.json_response(entries)


# ─── REST: Memory Entries (Commander-owned auto-memory) ──────────────


async def _sync_memory_to_cli(workspace_id: str | None):
    """Background task: write Commander memory entries back to CLI native format."""
    if not workspace_id:
        return
    try:
        ws_path = await _get_workspace_path(workspace_id)
        if not ws_path:
            return
        from memory_manager import memory_manager
        await memory_manager.sync_to_claude_memory(ws_path, workspace_id=workspace_id)
    except Exception as exc:
        logger.debug("sync_to_claude_memory failed: %s", exc)


async def list_memory_entries(request: web.Request) -> web.Response:
    """GET /api/memory — list entries, optionally filtered.

    When ``?workspace=`` is supplied, NULL-scoped (global) rows are excluded
    by default so the UI doesn't display entries leaked from other workspaces.
    Pass ``?include_global=1`` to opt back in.
    """
    from memory_manager import memory_manager
    workspace_id = request.query.get("workspace") or request.query.get("workspace_id")
    include_global = request.query.get("include_global", "0").lower() in ("1", "true", "yes")
    entries = await memory_manager.list_entries(
        workspace_id=workspace_id,
        types=request.query.get("types", "").split(",") if request.query.get("types") else None,
        source_cli=request.query.get("source_cli"),
        limit=int(request.query.get("limit", "200")),
        include_global=include_global,
    )
    return web.json_response(entries)


async def create_memory_entry(request: web.Request) -> web.Response:
    """POST /api/memory — create a new entry."""
    from memory_manager import memory_manager
    body = await request.json()
    name = body.get("name", "").strip()
    etype = body.get("type", "").strip()
    content = body.get("content", "").strip()
    if not name or not etype or not content:
        return web.json_response({"error": "name, type, and content required"}, status=400)
    # MCP-S7: a worker/planner caller cannot pollute another workspace's
    # memory by passing a foreign workspace_id. Override with the caller's
    # bound workspace.
    caller = await _resolve_caller(request)
    workspace_id = body.get("workspace_id")
    if caller and caller["workspace_id"]:
        workspace_id = caller["workspace_id"]
    try:
        entry_id = await memory_manager.save(
            name=name, type=etype, content=content,
            workspace_id=workspace_id,
            description=body.get("description", ""),
            source_cli=body.get("source_cli", "commander"),
            tags=body.get("tags"),
        )
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    entry = await memory_manager.get(entry_id)
    import asyncio as _aio
    _aio.create_task(_sync_memory_to_cli(workspace_id))
    return web.json_response(entry, status=201)


async def autofill_vision(request: web.Request) -> web.Response:
    """POST /api/vision/autofill — route a free-form transcript into the
    four vision-modal fields via a single LLM call.

    Used by WorkspaceVisionOnboarding when the user dictates a product
    description: the browser does speech-to-text via Web Speech API,
    posts the transcript here, and we ask Claude/Gemini (whichever CLI
    is installed) to extract the four structured fields.

    No API key needed — uses whatever auth the local CLI has.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)

    transcript = (body.get("transcript") or "").strip()
    if not transcript:
        return web.json_response({"error": "no transcript"}, status=400)

    cli = body.get("cli") or "claude"
    model = body.get("model")  # None = CLI default

    system = (
        "You receive a free-form description of a software product (often "
        "spoken aloud then auto-transcribed, so expect filler words and "
        "loose grammar). Extract these four fields and return ONLY valid "
        "JSON with EXACTLY these keys: "
        '{"vision","audience","competitors","differentiator"}. '
        "Use an empty string for any field the description doesn't cover — "
        "do not invent details. Keep each field concise (1–3 sentences). "
        "Strip filler ('um', 'like', 'you know'). Tighten phrasing but "
        "preserve the speaker's specific terms (product names, jargon)."
    )

    try:
        from llm_router import llm_call_json
        result = await llm_call_json(
            cli=cli, model=model, prompt=transcript, system=system, timeout=45
        )
    except Exception as e:
        logger.warning("autofill_vision LLM call failed: %s", e)
        return web.json_response({"error": str(e)}, status=500)

    # Defensive normalize — guarantee the four keys exist as strings even
    # if the LLM returned partial / malformed JSON.
    if not isinstance(result, dict):
        result = {}
    safe = {
        "vision":         str(result.get("vision") or ""),
        "audience":       str(result.get("audience") or ""),
        "competitors":    str(result.get("competitors") or ""),
        "differentiator": str(result.get("differentiator") or ""),
    }
    return web.json_response(safe)


async def update_memory_entry(request: web.Request) -> web.Response:
    """PUT /api/memory/{id} — update an entry."""
    from memory_manager import memory_manager
    entry_id = request.match_info["id"]
    body = await request.json()
    try:
        found = await memory_manager.update(entry_id, **body)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    if not found:
        return web.json_response({"error": "not found"}, status=404)
    entry = await memory_manager.get(entry_id)
    import asyncio as _aio
    _aio.create_task(_sync_memory_to_cli(entry.get("workspace_id") if entry else None))
    return web.json_response(entry)


async def delete_memory_entry(request: web.Request) -> web.Response:
    """DELETE /api/memory/{id}."""
    from memory_manager import memory_manager
    entry_id = request.match_info["id"]
    # Fetch workspace_id before deletion for sync
    existing = await memory_manager.get(entry_id)
    found = await memory_manager.delete(entry_id)
    if not found:
        return web.json_response({"error": "not found"}, status=404)
    import asyncio as _aio
    _aio.create_task(_sync_memory_to_cli(existing.get("workspace_id") if existing else None))
    return web.json_response({"ok": True})


async def search_memory_entries(request: web.Request) -> web.Response:
    """GET /api/memory/search?q=...

    Mirrors ``/api/memory`` scoping: NULL-scoped rows are excluded when a
    workspace is supplied unless ``?include_global=1`` is passed.
    """
    from memory_manager import memory_manager
    query = request.query.get("q", "").strip()
    if not query:
        return web.json_response({"error": "q parameter required"}, status=400)
    workspace_id = request.query.get("workspace") or request.query.get("workspace_id")
    include_global = request.query.get("include_global", "0").lower() in ("1", "true", "yes")
    entries = await memory_manager.search(
        query,
        workspace_id=workspace_id,
        types=request.query.get("types", "").split(",") if request.query.get("types") else None,
        include_global=include_global,
    )
    return web.json_response(entries)


async def import_memory_from_cli(request: web.Request) -> web.Response:
    """POST /api/memory/import — import from a CLI's native memory format."""
    from memory_manager import memory_manager
    body = await request.json()
    workspace_id = body.get("workspace_id")
    workspace_path = body.get("workspace_path")

    if not workspace_path and workspace_id:
        ws_path = await _get_workspace_path(workspace_id)
        if not ws_path:
            return web.json_response({"error": "workspace not found"}, status=404)
        workspace_path = ws_path

    if not workspace_path:
        return web.json_response({"error": "workspace_path or workspace_id required"}, status=400)

    count = await memory_manager.import_from_claude_memory(
        workspace_path, workspace_id=workspace_id,
    )
    return web.json_response({"imported": count})


async def export_memory_prompt(request: web.Request) -> web.Response:
    """GET /api/memory/prompt?workspace=... — preview the prompt injection text."""
    from memory_manager import memory_manager
    from output_styles import resolve_output_style
    ws_id = request.query.get("workspace")
    # Resolve compact mode from workspace/global output style
    compact = False
    if ws_id:
        db_os = await get_db()
        try:
            _c = await db_os.execute("SELECT output_style FROM workspaces WHERE id = ?", (ws_id,))
            _r = await _c.fetchone()
            _ws_os = _r["output_style"] if _r else None
            _c2 = await db_os.execute("SELECT value FROM app_settings WHERE key = 'output_style'")
            _r2 = await _c2.fetchone()
            _gl_os = _r2["value"] if _r2 else None
            compact = resolve_output_style(None, _ws_os, _gl_os) not in ("default", "lite")
        except Exception:
            pass
        finally:
            await db_os.close()
    text = await memory_manager.export_for_prompt(
        workspace_id=ws_id,
        max_chars=int(request.query.get("max_chars", "4000")),
        compact=compact,
    )
    return web.json_response({"prompt": text, "length": len(text)})


_COMPACT_PROMPT = """\
Rewrite the following memory entry's CONTENT in dense/compact form.

Rules:
- Keep all technical substance — every fact, decision, constraint, file path, identifier.
- Drop filler (just/really/basically), hedging (I think/maybe/perhaps), pleasantries.
- Drop articles where readability survives. Use fragments and arrows (X → Y) where natural.
- Preserve "Why:" and "How to apply:" sections if present, just compress them.
- Keep markdown structure (bullets/bold) but no introductory wrapping.
- Output ONLY the rewritten content — no preamble, no explanation, no code fences.
- If the content is already terse (under ~120 chars or already dense form), return it UNCHANGED.

Original content:
---
{content}
---

Rewritten content:"""


async def compact_memory_entries(request: web.Request) -> web.Response:
    """POST /api/memory/compact — rewrite memory entry content into dense form.

    Body: {workspace_id?, ids?, style?, dry_run?, model?, cli?, min_chars?}
    """
    from memory_manager import memory_manager
    from llm_router import llm_call

    body = await request.json()
    workspace_id = body.get("workspace_id")
    only_ids = body.get("ids")
    style = (body.get("style") or "dense").lower()
    dry_run = bool(body.get("dry_run"))
    cli = body.get("cli") or "claude"
    model = body.get("model") or "haiku"
    min_chars = int(body.get("min_chars", 120))

    if style not in ("dense", "caveman", "ultra"):
        return web.json_response({"error": "style must be dense|caveman|ultra"}, status=400)

    if isinstance(only_ids, list) and only_ids:
        entries = []
        for eid in only_ids:
            e = await memory_manager.get(eid)
            if e:
                entries.append(e)
    else:
        entries = await memory_manager.list_entries(workspace_id=workspace_id)

    if not entries:
        return web.json_response({"updated": 0, "skipped": 0, "results": []})

    results = []
    updated = 0
    skipped = 0
    for e in entries:
        content = (e.get("content") or "").strip()
        if len(content) < min_chars:
            skipped += 1
            results.append({"id": e["id"], "name": e["name"], "status": "skipped_short",
                            "before_chars": len(content)})
            continue
        try:
            new_text = (await llm_call(
                cli=cli, model=model,
                prompt=_COMPACT_PROMPT.format(content=content),
                timeout=60,
            )).strip()
        except Exception as ex:
            skipped += 1
            results.append({"id": e["id"], "name": e["name"], "status": "llm_error", "error": str(ex)})
            continue

        if not new_text or new_text == content or len(new_text) >= len(content):
            skipped += 1
            results.append({"id": e["id"], "name": e["name"], "status": "no_gain",
                            "before_chars": len(content), "after_chars": len(new_text)})
            continue

        if not dry_run:
            try:
                await memory_manager.update(e["id"], content=new_text)
            except Exception as ex:
                skipped += 1
                results.append({"id": e["id"], "name": e["name"], "status": "write_error",
                                "error": str(ex)})
                continue

        updated += 1
        results.append({
            "id": e["id"], "name": e["name"],
            "status": "compacted",
            "before_chars": len(content),
            "after_chars": len(new_text),
            "preview": new_text[:200],
        })

    if not dry_run and updated:
        import asyncio as _aio
        _aio.create_task(_sync_memory_to_cli(workspace_id))

    return web.json_response({
        "updated": updated, "skipped": skipped, "dry_run": dry_run,
        "style": style, "model": f"{cli}/{model}",
        "results": results,
    })


# ─── REST: Commander ─────────────────────────────────────────────────

async def create_commander(request: web.Request) -> web.Response:
    workspace_id = request.match_info["id"]
    # Accept optional body to override CLI/model
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    cli_type = body.get("cli_type", "claude")

    # Auto-install safety_gate hook so the Commander delegation deny in
    # /api/safety/evaluate actually fires. Required for Gemini Commanders —
    # Gemini doesn't support --disallowedTools, so the runtime hook is the
    # only enforcement. Idempotent: skips if already installed.
    try:
        from hook_installer import (
            install_safety_gate_hooks,
            check_safety_gate_installation,
        )
        gate_state = check_safety_gate_installation()
        if not (gate_state.get("claude") and gate_state.get("script_exists")):
            install_safety_gate_hooks()
            logger.info("Safety gate hooks auto-installed for Commander deny enforcement")
    except Exception as gate_err:
        logger.warning("Safety gate auto-install skipped: %s", gate_err)
    default_model = get_profile(cli_type).default_commander_model
    model = body.get("model", default_model)
    default_mode = get_profile(cli_type).default_permission_mode
    permission_mode = body.get("permission_mode", default_mode)
    effort = body.get("effort", "max") if get_profile(cli_type).effort_levels else None

    db = await get_db()
    try:
        # Verify workspace exists
        cur = await db.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,))
        ws = await cur.fetchone()
        if not ws:
            return web.json_response({"error": "workspace not found"}, status=404)

        # Check if a commander session already exists for this workspace
        cur = await db.execute(
            """SELECT * FROM sessions
               WHERE workspace_id = ? AND session_type = 'commander'
               ORDER BY created_at DESC LIMIT 1""",
            (workspace_id,),
        )
        cli_label = get_profile(cli_type).label
        name = f"Commander ({cli_label}) — {dict(ws)['name']}"

        # Inject dynamic workspace limits into Commander system prompt
        ws_dict = dict(ws)
        max_w = ws_dict.get("commander_max_workers") or 3
        max_t = ws_dict.get("tester_max_workers") or 2
        dynamic_prompt = COMMANDER_SYSTEM_PROMPT + (
            f"\n\nWorkspace Limits: max_workers={max_w}, max_testers={max_t}. "
            "Do not exceed these concurrency limits when creating sessions."
        )

        existing = await cur.fetchone()
        if existing:
            # Heal older Commander rows on every click: rewrite name, system
            # prompt, auto_approve_mcp, and disallowed_tools, and ensure
            # builtin-commander is attached. Older rows can have NULL
            # system_prompt, auto_approve_mcp=0, or NULL disallowed_tools
            # (created before the orchestrator wiring), which silently breaks
            # Commander tool routing or lets it implement instead of delegate.
            await db.execute(
                """UPDATE sessions
                   SET name = ?, system_prompt = ?, auto_approve_mcp = 1,
                       disallowed_tools = ?
                   WHERE id = ?""",
                (name, dynamic_prompt, json.dumps(COMMANDER_DISALLOWED_TOOLS),
                 existing["id"]),
            )
            await db.execute(
                "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
                (existing["id"], "builtin-commander"),
            )
            await db.commit()
            cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (existing["id"],))
            row = await cur.fetchone()
            d = dict(row)
            d["status"] = "running" if pty_mgr.is_alive(d["id"]) else "idle"
            return web.json_response(d)

        # Commander sessions use the dynamic MCP server system.
        # The builtin-commander MCP server is attached via session_mcp_servers
        # instead of writing a raw config file. PTY start handles registration.
        session_id = str(uuid.uuid4())

        await db.execute(
            """INSERT INTO sessions (id, workspace_id, name, model, permission_mode, effort,
               system_prompt, session_type, auto_approve_mcp, cli_type,
               disallowed_tools)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'commander', 1, ?, ?)""",
            (session_id, workspace_id, name, model, permission_mode, effort or "high",
             dynamic_prompt, cli_type,
             json.dumps(COMMANDER_DISALLOWED_TOOLS)),
        )
        # Attach builtin-commander MCP server with auto-approve
        await db.execute(
            "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
            (session_id, "builtin-commander"),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        row = await cur.fetchone()
        return web.json_response(dict(row), status=201)
    finally:
        await db.close()


async def get_commander(request: web.Request) -> web.Response:
    workspace_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT * FROM sessions
               WHERE workspace_id = ? AND session_type = 'commander'
               ORDER BY created_at DESC LIMIT 1""",
            (workspace_id,),
        )
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "no commander session found"}, status=404)
        d = dict(row)
        d["status"] = "running" if pty_mgr.is_alive(d["id"]) else "idle"
        return web.json_response(d)
    finally:
        await db.close()


async def create_tester(request: web.Request) -> web.Response:
    """Create or return the workspace's Testing Agent session."""
    workspace_id = request.match_info["id"]
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    cli_type = body.get("cli_type", "claude")
    default_model = get_profile(cli_type).default_tester_model
    model = body.get("model", default_model)
    show_browser = bool(body.get("show_browser", False))

    db = await get_db()
    try:
        # Verify workspace exists
        cur = await db.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,))
        ws = await cur.fetchone()
        if not ws:
            return web.json_response({"error": "workspace not found"}, status=404)

        # Check if a tester session already exists for this workspace
        cur = await db.execute(
            """SELECT * FROM sessions
               WHERE workspace_id = ? AND session_type = 'tester'
               ORDER BY created_at DESC LIMIT 1""",
            (workspace_id,),
        )
        # Determine tester mode from workspace setting
        tester_mode = dict(ws).get("tester_mode", "direct")
        is_delegated = tester_mode == "delegated"
        cli_label = get_profile(cli_type).label
        mode_label = "Commander" if is_delegated else "Tester"
        name = f"{mode_label} ({cli_label}) — {dict(ws)['name']}"
        # tester_headed tag: when present, PTY-start strips --headless from the
        # Playwright MCP args so the user can watch the browser.
        new_tags = ["tester_headed"] if show_browser else []

        if is_delegated:
            # Delegated mode: tester is a test-commander that spawns test-workers
            # Needs commander MCP for session management, and auto permission mode
            system_prompt = TESTER_COMMANDER_SYSTEM_PROMPT
            permission_mode = get_profile(cli_type).default_permission_mode
            tester_mcp_id = "builtin-commander"
        else:
            # Direct mode: tester runs tests itself with Playwright
            system_prompt = TESTER_SYSTEM_PROMPT
            # Plan mode for Claude (read-only tester); auto for others
            permission_mode = "plan" if get_profile(cli_type).supports(Feature.PLAN_MODE) else get_profile(cli_type).default_permission_mode
            tester_mcp_id = "builtin-playwright"

        existing = await cur.fetchone()
        if existing:
            # Heal: rewrite name + system prompt + auto_approve_mcp on every
            # click so older Tester rows with NULL/stale fields recover. Also
            # reconcile the tester_headed tag with the latest checkbox state.
            existing_tags = json.loads(existing["tags"] or "[]")
            existing_tags = [t for t in existing_tags if t != "tester_headed"]
            if show_browser:
                existing_tags.append("tester_headed")
            await db.execute(
                """UPDATE sessions
                   SET name = ?, system_prompt = ?, auto_approve_mcp = 1, tags = ?
                   WHERE id = ?""",
                (name, system_prompt, json.dumps(existing_tags), existing["id"]),
            )
            await db.execute(
                "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
                (existing["id"], tester_mcp_id),
            )
            await db.execute(
                "INSERT OR IGNORE INTO session_guidelines (session_id, guideline_id) VALUES (?, ?)",
                (existing["id"], "builtin-testing-agent"),
            )
            await db.commit()
            cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (existing["id"],))
            row = await cur.fetchone()
            d = dict(row)
            d["status"] = "running" if pty_mgr.is_alive(d["id"]) else "idle"
            return web.json_response(d)

        # Create new tester session
        session_id = str(uuid.uuid4())

        await db.execute(
            """INSERT INTO sessions (id, workspace_id, name, model, permission_mode, effort,
               system_prompt, session_type, auto_approve_mcp, cli_type, tags)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'tester', 1, ?, ?)""",
            (session_id, workspace_id, name, model, permission_mode, "high",
             system_prompt, cli_type, json.dumps(new_tags)),
        )

        if is_delegated:
            # Delegated: attach commander MCP so tester can create/manage test-worker sessions
            await db.execute(
                "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
                (session_id, "builtin-commander"),
            )
        else:
            # Direct: attach Playwright MCP with auto-approve
            await db.execute(
                "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
                (session_id, "builtin-playwright"),
            )

        # Attach testing agent guideline in both modes
        await db.execute(
            "INSERT OR IGNORE INTO session_guidelines (session_id, guideline_id) VALUES (?, ?)",
            (session_id, "builtin-testing-agent"),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        row = await cur.fetchone()
        return web.json_response(dict(row), status=201)
    finally:
        await db.close()


async def get_tester(request: web.Request) -> web.Response:
    workspace_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT * FROM sessions
               WHERE workspace_id = ? AND session_type = 'tester'
               ORDER BY created_at DESC LIMIT 1""",
            (workspace_id,),
        )
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "no tester session found"}, status=404)
        d = dict(row)
        d["status"] = "running" if pty_mgr.is_alive(d["id"]) else "idle"
        return web.json_response(d)
    finally:
        await db.close()


# ─── REST: Documentor ────────────────────────────────────────────────


async def create_documentor(request: web.Request) -> web.Response:
    """Create or return the workspace's Documentor session."""
    workspace_id = request.match_info["id"]
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    cli_type = body.get("cli_type", "claude")
    default_model = get_profile(cli_type).default_tester_model  # same tier as tester
    model = body.get("model", default_model)
    allow_all_edits = body.get("allow_all_edits", False)

    db = await get_db()
    try:
        # Verify workspace exists
        cur = await db.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,))
        ws = await cur.fetchone()
        if not ws:
            return web.json_response({"error": "workspace not found"}, status=404)

        # Check if a documentor session already exists for this workspace
        cur = await db.execute(
            """SELECT * FROM sessions
               WHERE workspace_id = ? AND session_type = 'documentor'
               ORDER BY created_at DESC LIMIT 1""",
            (workspace_id,),
        )
        existing = await cur.fetchone()
        if existing:
            # Ensure permission_mode, auto-approve, and system_prompt are correct
            expected_perm = "acceptEdits" if cli_type == "claude" else get_profile(cli_type).default_permission_mode
            await db.execute(
                """UPDATE sessions
                   SET permission_mode = ?, auto_approve_plan = 1, auto_approve_mcp = 1,
                       allowed_tools = ?, system_prompt = ?
                   WHERE id = ?""",
                (expected_perm, json.dumps(DOCUMENTOR_ALLOWED_TOOLS),
                 DOCUMENTOR_SYSTEM_PROMPT, existing["id"]),
            )
            # Update allow_all_edits tag if changed
            if allow_all_edits:
                existing_tags = json.loads(existing["tags"] or "[]")
                if "unrestricted_edit" not in existing_tags:
                    existing_tags.append("unrestricted_edit")
                    await db.execute(
                        "UPDATE sessions SET tags = ? WHERE id = ?",
                        (json.dumps(existing_tags), existing["id"]),
                    )
            # Ensure Documentor MCP + Playwright MCP are attached
            await db.execute(
                "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
                (existing["id"], "builtin-documentor"),
            )
            await db.execute(
                "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
                (existing["id"], "builtin-playwright"),
            )
            await db.execute(
                "INSERT OR IGNORE INTO session_guidelines (session_id, guideline_id) VALUES (?, ?)",
                (existing["id"], "builtin-documentation-agent"),
            )
            await db.commit()
            cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (existing["id"],))
            row = await cur.fetchone()
            d = dict(row)
            d["status"] = "running" if pty_mgr.is_alive(d["id"]) else "idle"
            return web.json_response(d)

        # Create new documentor session
        session_id = str(uuid.uuid4())
        cli_label = get_profile(cli_type).label
        name = f"Documentor ({cli_label}) — {dict(ws)['name']}"

        # Documentor needs acceptEdits + pre-approved Bash commands for builds/sed/npm
        permission_mode = "acceptEdits" if cli_type == "claude" else get_profile(cli_type).default_permission_mode

        # Tags: "unrestricted_edit" bypasses the docs-only path guard
        tags = json.dumps(["unrestricted_edit"]) if allow_all_edits else "[]"

        await db.execute(
            """INSERT INTO sessions (id, workspace_id, name, model, permission_mode, effort,
               system_prompt, session_type, auto_approve_mcp, auto_approve_plan, cli_type, tags, allowed_tools)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'documentor', 1, 1, ?, ?, ?)""",
            (session_id, workspace_id, name, model, permission_mode, "high",
             DOCUMENTOR_SYSTEM_PROMPT, cli_type, tags, json.dumps(DOCUMENTOR_ALLOWED_TOOLS)),
        )

        # Attach Documentor MCP server (knowledge ingestion, screenshots, doc writing, build)
        await db.execute(
            "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
            (session_id, "builtin-documentor"),
        )
        # Attach Playwright MCP (direct browser automation for screenshots/GIFs)
        await db.execute(
            "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) VALUES (?, ?, 1)",
            (session_id, "builtin-playwright"),
        )
        # Attach documentation agent guideline
        await db.execute(
            "INSERT OR IGNORE INTO session_guidelines (session_id, guideline_id) VALUES (?, ?)",
            (session_id, "builtin-documentation-agent"),
        )
        await db.commit()

        # Emit event
        try:
            from event_bus import bus
            await bus.emit(CommanderEvent.DOCUMENTOR_STARTED, {
                "session_id": session_id,
                "workspace_id": workspace_id,
                "cli_type": cli_type,
                "model": model,
            }, source="api", actor="user")
        except Exception:
            pass

        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        row = await cur.fetchone()
        return web.json_response(dict(row), status=201)
    finally:
        await db.close()


async def get_documentor(request: web.Request) -> web.Response:
    workspace_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT * FROM sessions
               WHERE workspace_id = ? AND session_type = 'documentor'
               ORDER BY created_at DESC LIMIT 1""",
            (workspace_id,),
        )
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "no documentor session found"}, status=404)
        d = dict(row)
        d["status"] = "running" if pty_mgr.is_alive(d["id"]) else "idle"
        return web.json_response(d)
    finally:
        await db.close()


async def get_docs_status(request: web.Request) -> web.Response:
    """GET /api/workspaces/{id}/docs — docs manifest, tree, and coverage stats."""
    workspace_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("SELECT path FROM workspaces WHERE id = ?", (workspace_id,))
        ws = await cur.fetchone()
        if not ws:
            return web.json_response({"error": "workspace not found"}, status=404)
        ws_path = ws["path"]
    finally:
        await db.close()

    import os as _os

    docs_dir = _os.path.join(ws_path, "docs")
    manifest_path = _os.path.join(docs_dir, "docs_manifest.json")
    screenshots_dir = _os.path.join(docs_dir, "screenshots")
    gifs_dir = _os.path.join(docs_dir, "gifs")

    # Read manifest
    manifest = {}
    if _os.path.isfile(manifest_path):
        try:
            with open(manifest_path) as f:
                manifest = json.load(f)
        except Exception:
            pass

    # Count files
    page_count = 0
    screenshot_count = 0
    gif_count = 0
    screenshots: list[dict] = []
    gifs: list[dict] = []
    tree: list[str] = []

    if _os.path.isdir(docs_dir):
        for root, dirs, files in _os.walk(docs_dir):
            dirs[:] = [d for d in dirs if d not in ("node_modules", "cache", "dist", ".vitepress")]
            level = root.replace(docs_dir, "").count(_os.sep)
            folder = _os.path.basename(root) or "docs"
            tree.append("  " * level + folder + "/")
            for fn in sorted(files):
                tree.append("  " * (level + 1) + fn)
                full = _os.path.join(root, fn)
                if fn.endswith(".md"):
                    page_count += 1
                elif fn.endswith(".png"):
                    screenshot_count += 1
                    screenshots.append({
                        "name": fn,
                        "path": _os.path.relpath(full, docs_dir),
                        "size_kb": round(_os.path.getsize(full) / 1024, 1),
                    })
                elif fn.endswith(".gif"):
                    gif_count += 1
                    gifs.append({
                        "name": fn,
                        "path": _os.path.relpath(full, docs_dir),
                        "size_kb": round(_os.path.getsize(full) / 1024, 1),
                    })

    # Undocumented features
    documented_tasks = set(manifest.get("documented_tasks", []))
    undocumented: list[dict] = []
    try:
        db2 = await get_db()
        try:
            cur = await db2.execute(
                "SELECT id, title, status, labels FROM tasks WHERE status IN ('done', 'review')"
            )
            rows = await cur.fetchall()
            for r in rows:
                if r["id"] not in documented_tasks:
                    undocumented.append({"id": r["id"], "title": r["title"], "status": r["status"]})
        finally:
            await db2.close()
    except Exception:
        pass

    # Read VitePress dev port if running
    dev_port = None
    dev_port_file = _os.path.join(docs_dir, ".dev-port")
    if _os.path.isfile(dev_port_file):
        try:
            with open(dev_port_file) as f:
                dev_port = int(f.read().strip())
        except Exception:
            pass

    return web.json_response({
        "exists": _os.path.isdir(docs_dir),
        "manifest": manifest,
        "pages": page_count,
        "screenshots": screenshot_count,
        "gifs": gif_count,
        "screenshot_list": screenshots[:50],
        "gif_list": gifs[:50],
        "tree": tree,
        "undocumented_features": undocumented,
        "last_build": manifest.get("last_build_at"),
        "docs_path": docs_dir,
        "dev_port": dev_port,
    })


async def trigger_docs_build(request: web.Request) -> web.Response:
    """POST /api/workspaces/{id}/docs/build — trigger VitePress build."""
    workspace_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("SELECT path FROM workspaces WHERE id = ?", (workspace_id,))
        ws = await cur.fetchone()
        if not ws:
            return web.json_response({"error": "workspace not found"}, status=404)
        ws_path = ws["path"]
    finally:
        await db.close()

    import os as _os

    docs_dir = _os.path.join(ws_path, "docs")
    if not _os.path.isdir(docs_dir):
        return web.json_response({"error": "no docs/ directory found"}, status=404)

    # Auto-install if needed
    if _os.path.isfile(_os.path.join(docs_dir, "package.json")) and not _os.path.isdir(_os.path.join(docs_dir, "node_modules")):
        try:
            proc = await asyncio.create_subprocess_exec(
                "npm", "install", cwd=docs_dir,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=120)
        except Exception as e:
            return web.json_response({"error": f"npm install failed: {e}"}, status=500)

    try:
        proc = await asyncio.create_subprocess_exec(
            "npx", "vitepress", "build", cwd=docs_dir,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
        if proc.returncode != 0:
            return web.json_response({"error": stderr.decode()[:1000]}, status=500)

        # Update manifest
        manifest_path = _os.path.join(docs_dir, "docs_manifest.json")
        manifest = {}
        if _os.path.isfile(manifest_path):
            try:
                with open(manifest_path) as f:
                    manifest = json.load(f)
            except Exception:
                pass
        manifest["last_build_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)

        # Emit event
        try:
            from event_bus import bus
            await bus.emit(CommanderEvent.DOCS_BUILD_COMPLETED, {
                "workspace_id": workspace_id,
                "docs_path": docs_dir,
            }, source="api", actor="user")
        except Exception:
            pass

        dist_path = _os.path.join(docs_dir, ".vitepress", "dist")
        return web.json_response({
            "ok": True,
            "dist_path": dist_path,
            "stdout": stdout.decode()[-500:],
        })
    except asyncio.TimeoutError:
        return web.json_response({"error": "build timed out after 120s"}, status=500)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ─── REST: Observatory ───────────────────────────────────────────────

async def list_observatory_findings(request: web.Request) -> web.Response:
    """GET /api/observatory/findings"""
    import observatory
    params = {
        "workspace_id": request.query.get("workspace_id"),
        "source": request.query.get("source"),
        "status": request.query.get("status"),
        "min_score": float(request.query.get("min_score", 0)),
    }
    params = {k: v for k, v in params.items() if v}
    findings = await observatory.get_findings(**params)
    return web.json_response(findings)


# ─── REST: Observatory Profile + Search Targets ─────────────────────

async def get_observatory_profile(request: web.Request) -> web.Response:
    """GET /api/observatory/profile?workspace_id=..."""
    import observatory_profile
    workspace_id = request.query.get("workspace_id")
    if not workspace_id:
        return web.json_response({"error": "workspace_id required"}, status=400)
    row = await observatory_profile.get_profile(workspace_id)
    return web.json_response(row or {"profile": {}})


async def regenerate_observatory_profile(request: web.Request) -> web.Response:
    """POST /api/observatory/profile/regenerate body: {workspace_id}"""
    import observatory_profile
    body = await request.json()
    workspace_id = body.get("workspace_id")
    if not workspace_id:
        return web.json_response({"error": "workspace_id required"}, status=400)
    try:
        row = await observatory_profile.build_profile(workspace_id)
    except Exception as exc:
        logger.exception("profile regenerate failed")
        return web.json_response({"error": str(exc)}, status=500)
    return web.json_response(row)


async def update_observatory_profile(request: web.Request) -> web.Response:
    """PUT /api/observatory/profile body: {workspace_id, profile: {section: prose, ...}}"""
    import observatory_profile
    body = await request.json()
    workspace_id = body.get("workspace_id")
    profile = body.get("profile") or {}
    if not workspace_id:
        return web.json_response({"error": "workspace_id required"}, status=400)
    row = await observatory_profile.update_profile_text(workspace_id, profile)
    return web.json_response(row or {})


async def recalibrate_observatory_profile(request: web.Request) -> web.Response:
    """POST /api/observatory/profile/recalibrate body: {workspace_id}"""
    import observatory_profile
    body = await request.json()
    workspace_id = body.get("workspace_id")
    if not workspace_id:
        return web.json_response({"error": "workspace_id required"}, status=400)
    try:
        row = await observatory_profile.recalibrate_profile(workspace_id)
    except Exception as exc:
        logger.exception("profile recalibrate failed")
        return web.json_response({"error": str(exc)}, status=500)
    return web.json_response(row or {})


async def list_observatory_search_targets(request: web.Request) -> web.Response:
    """GET /api/observatory/search-targets?workspace_id=&source=&status="""
    import observatory_profile
    workspace_id = request.query.get("workspace_id")
    if not workspace_id:
        return web.json_response({"error": "workspace_id required"}, status=400)
    targets = await observatory_profile.list_targets(
        workspace_id,
        source=request.query.get("source"),
        status=request.query.get("status"),
    )
    return web.json_response(targets)


async def add_observatory_search_target(request: web.Request) -> web.Response:
    """POST /api/observatory/search-targets body: {workspace_id, source, target_type, value, rationale?, status?}"""
    import observatory_profile
    body = await request.json()
    try:
        row = await observatory_profile.add_target(
            body["workspace_id"], body["source"], body["target_type"], body["value"],
            rationale=body.get("rationale", ""),
            added_by="user",
            status=body.get("status", "active"),
        )
    except KeyError as exc:
        return web.json_response({"error": f"missing field: {exc.args[0]}"}, status=400)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    return web.json_response(row or {})


async def update_observatory_search_target(request: web.Request) -> web.Response:
    """PUT /api/observatory/search-targets/{id} body: {status?, signal_score?, rationale?}"""
    import observatory_profile
    target_id = request.match_info["id"]
    body = await request.json()
    row = await observatory_profile.update_target(target_id, body)
    if not row:
        return web.json_response({"error": "not found or no allowed updates"}, status=404)
    return web.json_response(row)


async def delete_observatory_search_target(request: web.Request) -> web.Response:
    """DELETE /api/observatory/search-targets/{id}"""
    import observatory_profile
    target_id = request.match_info["id"]
    ok = await observatory_profile.delete_target(target_id)
    return web.json_response({"ok": ok}, status=200 if ok else 404)


async def plan_observatory_search_targets(request: web.Request) -> web.Response:
    """POST /api/observatory/search-targets/plan body: {workspace_id, source}"""
    import observatory_profile
    body = await request.json()
    workspace_id = body.get("workspace_id")
    source = body.get("source")
    if not workspace_id or not source:
        return web.json_response({"error": "workspace_id and source required"}, status=400)
    try:
        plan = await observatory_profile.plan_targets(workspace_id, source)
    except Exception as exc:
        logger.exception("plan_targets failed")
        return web.json_response({"error": str(exc)}, status=500)
    return web.json_response(plan)


async def triage_observatory_items(request: web.Request) -> web.Response:
    """POST /api/observatory/triage body: {workspace_id, items: [...]}

    Diagnostic endpoint — lets the UI replay triage on a list of items
    (e.g. from a recent scan) without re-scraping. Returns each item
    annotated with `verdict` and `triage_reason`.
    """
    import observatory_profile
    body = await request.json()
    workspace_id = body.get("workspace_id")
    items = body.get("items") or []
    if not workspace_id:
        return web.json_response({"error": "workspace_id required"}, status=400)
    try:
        results = await observatory_profile.triage_items(workspace_id, items)
    except Exception as exc:
        logger.exception("triage failed")
        return web.json_response({"error": str(exc)}, status=500)
    return web.json_response(results)


async def trigger_observatory_smart_scan(request: web.Request) -> web.Response:
    """POST /api/observatory/scan/smart body: {workspace_id, source?, sources?[], wait?}

    Runs the LLM-staged smart pipeline (profile-aware, no keywords). When
    `wait=true` the response blocks until the scan finishes; otherwise it
    fires-and-forgets and returns the planned source list immediately.
    """
    import observatory_smart
    import observatory_profile
    body = await request.json()
    workspace_id = body.get("workspace_id")
    if not workspace_id:
        return web.json_response({"error": "workspace_id required"}, status=400)

    source = body.get("source")
    sources = body.get("sources")
    if source and source != "all":
        target_sources = [source]
    elif isinstance(sources, list) and sources:
        target_sources = sources
    else:
        target_sources = list(observatory_profile.VALID_SOURCES)

    invalid = [s for s in target_sources if s not in observatory_profile.VALID_SOURCES]
    if invalid:
        return web.json_response(
            {"error": f"invalid sources: {invalid}"}, status=400,
        )

    wait = bool(body.get("wait"))

    if wait:
        results = []
        for src in target_sources:
            try:
                summary = await observatory_smart.run_smart_scan(workspace_id, src)
                results.append(summary)
            except Exception as exc:
                logger.exception("smart scan failed for %s", src)
                results.append({"source": src, "status": "failed", "error": str(exc)})
        return web.json_response({"ok": True, "results": results})

    async def _run():
        for src in target_sources:
            try:
                await observatory_smart.run_smart_scan(workspace_id, src)
            except Exception as exc:
                logger.error("smart scan failed for %s: %s", src, exc)

    _fire_and_forget(_run())
    return web.json_response({"ok": True, "sources": target_sources, "status": "started"})


async def list_observatory_insights(request: web.Request) -> web.Response:
    """GET /api/observatory/insights?workspace_id=&type="""
    import observatory_smart
    workspace_id = request.query.get("workspace_id")
    insight_type = request.query.get("type")
    if not workspace_id:
        return web.json_response({"error": "workspace_id required"}, status=400)
    rows = await observatory_smart.list_insights(workspace_id, insight_type)
    return web.json_response(rows)


async def upsert_observatory_insight(request: web.Request) -> web.Response:
    """POST /api/observatory/insights body: {workspace_id, insight_type, name, summary, strength_delta?, evidence_finding_ids?}"""
    import observatory_smart
    body = await request.json()
    workspace_id = body.get("workspace_id")
    insight_type = body.get("insight_type")
    # Accept legacy aliases (`key`/`content`) but prefer schema-aligned names.
    name = body.get("name") or body.get("key")
    summary = body.get("summary") or body.get("content")
    if not (workspace_id and insight_type and name and summary):
        return web.json_response(
            {"error": "workspace_id, insight_type, name, summary required"}, status=400,
        )
    if insight_type not in observatory_smart.VALID_INSIGHT_TYPES:
        return web.json_response(
            {"error": f"insight_type must be one of {observatory_smart.VALID_INSIGHT_TYPES}"},
            status=400,
        )
    row = await observatory_smart.upsert_insight(
        workspace_id=workspace_id,
        insight_type=insight_type,
        name=name,
        summary=summary,
        evidence_finding_ids=body.get("evidence_finding_ids"),
        strength_delta=float(body.get("strength_delta", 0.1) or 0.1),
    )
    return web.json_response(row)


async def update_observatory_insight(request: web.Request) -> web.Response:
    """PUT /api/observatory/insights/{id} body: {summary?, name?, strength?}"""
    insight_id = request.match_info["id"]
    body = await request.json()
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT * FROM observatory_insights WHERE id = ?", (insight_id,),
        )
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "not found"}, status=404)
        sets, vals = [], []
        for field in ("summary", "name"):
            if field in body:
                sets.append(f"{field} = ?")
                vals.append(body[field])
        if "strength" in body:
            sets.append("strength = ?")
            vals.append(max(0.0, min(1.0, float(body["strength"]))))
        if not sets:
            return web.json_response(dict(row))
        sets.append("updated_at = datetime('now')")
        vals.append(insight_id)
        await db.execute(
            f"UPDATE observatory_insights SET {', '.join(sets)} WHERE id = ?", vals,
        )
        await db.commit()
        cur = await db.execute(
            "SELECT * FROM observatory_insights WHERE id = ?", (insight_id,),
        )
        updated = await cur.fetchone()
        return web.json_response(dict(updated))
    finally:
        await db.close()


async def delete_observatory_insight(request: web.Request) -> web.Response:
    """DELETE /api/observatory/insights/{id}"""
    insight_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute(
            "DELETE FROM observatory_insights WHERE id = ?", (insight_id,),
        )
        await db.commit()
        return web.json_response({"ok": cur.rowcount > 0})
    finally:
        await db.close()


async def update_observatory_finding(request: web.Request) -> web.Response:
    """PUT /api/observatory/findings/{id}"""
    import observatory
    finding_id = request.match_info["id"]
    body = await request.json()
    result = await observatory.update_finding(finding_id, body)
    if not result:
        return web.json_response({"error": "not found or no valid fields"}, status=404)
    return web.json_response(result)


async def delete_observatory_finding(request: web.Request) -> web.Response:
    """DELETE /api/observatory/findings/{id}"""
    import observatory
    finding_id = request.match_info["id"]
    ok = await observatory.delete_finding(finding_id)
    if not ok:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response({"ok": True})


async def promote_observatory_finding(request: web.Request) -> web.Response:
    """POST /api/observatory/findings/{id}/promote"""
    import observatory
    finding_id = request.match_info["id"]
    body = await request.json()
    workspace_id = body.get("workspace_id")
    if not workspace_id:
        return web.json_response({"error": "workspace_id required"}, status=400)
    result = await observatory.promote_to_task(finding_id, workspace_id)
    if not result:
        return web.json_response({"error": "finding not found"}, status=404)
    return web.json_response(result)


async def list_observatory_scans(request: web.Request) -> web.Response:
    """GET /api/observatory/scans"""
    import observatory
    source = request.query.get("source")
    scans = await observatory.get_scans(source)
    return web.json_response(scans)


async def trigger_observatory_scan(request: web.Request) -> web.Response:
    """POST /api/observatory/scan"""
    import observatory
    body = await request.json()
    source = body.get("source")  # None or "all" = scan all sources
    workspace_id = body.get("workspace_id")
    mode = body.get("mode", "both")
    keywords = body.get("keywords")

    sources = [source] if source and source != "all" else ["github", "producthunt", "hackernews"]

    # Run scan(s) in background
    async def _run():
        for src in sources:
            try:
                await observatory.run_scan(src, workspace_id, mode, keywords)
            except Exception as e:
                logger.error("Observatory scan failed for %s: %s", src, e)

    _fire_and_forget(_run())
    return web.json_response({"ok": True, "sources": sources, "status": "started"})


async def get_observatory_settings(request: web.Request) -> web.Response:
    """GET /api/observatory/settings"""
    import observatory
    workspace_id = request.query.get("workspace_id")
    rows = await observatory.get_source_settings(workspace_id)
    # Restructure as { sources: { github: {...}, producthunt: {...}, ... } }
    sources = {}
    for row in rows:
        src = row.get("source")
        if src:
            kw = row.get("keywords", "[]")
            # Parse JSON keywords array into comma-separated string for UI
            try:
                kw_list = json.loads(kw) if isinstance(kw, str) else kw
                kw_str = ", ".join(kw_list) if isinstance(kw_list, list) else str(kw)
            except (json.JSONDecodeError, TypeError):
                kw_str = str(kw) if kw else ""
            sources[src] = {
                "enabled": bool(row.get("enabled", 0)),
                "interval_hours": row.get("interval_hours", 24),
                "mode": row.get("mode", "both"),
                "keywords": kw_str,
            }
    return web.json_response({"sources": sources})


async def update_observatory_settings(request: web.Request) -> web.Response:
    """PUT /api/observatory/settings"""
    import observatory
    body = await request.json()
    workspace_id = body.get("workspace_id")

    # Support batch format: { sources: { github: {...}, producthunt: {...} } }
    sources = body.get("sources")
    if sources and isinstance(sources, dict):
        results = {}
        for source, cfg in sources.items():
            result = await observatory.update_source_settings(workspace_id, source, cfg)
            results[source] = result
        return web.json_response(results)

    # Single source format: { source: "github", enabled: true, ... }
    source = body.get("source")
    if not source:
        return web.json_response({"error": "source or sources required"}, status=400)
    result = await observatory.update_source_settings(workspace_id, source, body)
    return web.json_response(result)


async def get_observatory_api_keys(request: web.Request) -> web.Response:
    """GET /api/observatory/api-keys — (legacy) redirects to system API keys."""
    import api_keys
    status = await api_keys.get_all_status()
    return web.json_response(status)


async def set_observatory_api_key(request: web.Request) -> web.Response:
    """PUT /api/observatory/api-keys — (legacy) redirects to system API keys."""
    import api_keys
    body = await request.json()
    name = body.get("name")
    value = body.get("value", "")
    if not name:
        return web.json_response({"error": "name required"}, status=400)
    if not value:
        await api_keys.delete(name)
    else:
        ok = await api_keys.save(name, value)
        if not ok:
            return web.json_response({"error": f"unknown key: {name}"}, status=400)
    status = await api_keys.get_all_status()
    return web.json_response(status)


async def test_observatory_api_key(request: web.Request) -> web.Response:
    """POST /api/observatory/api-keys/test — (legacy) redirects to system test."""
    return await test_api_key(request)


# ── System-wide API key management ───────────────────────────────────

async def list_api_keys(request: web.Request) -> web.Response:
    """GET /api/api-keys — status of all optional API keys."""
    import api_keys
    status = await api_keys.get_all_status()
    return web.json_response(status)


async def save_api_key(request: web.Request) -> web.Response:
    """PUT /api/api-keys — save or delete an API key."""
    import api_keys
    body = await request.json()
    name = body.get("name")
    value = body.get("value", "")
    if not name:
        return web.json_response({"error": "name required"}, status=400)
    if not value:
        await api_keys.delete(name)
    else:
        ok = await api_keys.save(name, value)
        if not ok:
            return web.json_response({"error": f"unknown key: {name}"}, status=400)
    status = await api_keys.get_all_status()
    return web.json_response(status)


async def test_api_key(request: web.Request) -> web.Response:
    """POST /api/api-keys/test — validate an API key against its service."""
    import api_keys
    body = await request.json()
    name = body.get("name")
    if not name:
        return web.json_response({"error": "name required"}, status=400)

    key = await api_keys.resolve(name)
    if not key:
        return web.json_response({"ok": False, "error": "no key configured"})

    try:
        async with aiohttp.ClientSession() as session:
            if name == "github":
                async with session.get(
                    "https://api.github.com/rate_limit",
                    headers={"Authorization": f"token {key}", "Accept": "application/vnd.github.v3+json"},
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        limit = data.get("rate", {}).get("limit", 0)
                        remaining = data.get("rate", {}).get("remaining", 0)
                        return web.json_response({"ok": True, "rate_limit": limit, "remaining": remaining})
                    return web.json_response({"ok": False, "error": f"HTTP {resp.status}"})

            elif name == "producthunt":
                query = '{ viewer { id } }'
                async with session.post(
                    "https://api.producthunt.com/v2/api/graphql",
                    json={"query": query},
                    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    return web.json_response({"ok": resp.status == 200, "status": resp.status})

            elif name == "brave":
                async with session.get(
                    "https://api.search.brave.com/res/v1/web/search?q=test&count=1",
                    headers={"Accept": "application/json", "X-Subscription-Token": key},
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    return web.json_response({"ok": resp.status == 200, "status": resp.status})

            elif name == "anthropic":
                async with session.get(
                    "https://api.anthropic.com/v1/models",
                    headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    return web.json_response({"ok": resp.status == 200, "status": resp.status})

            elif name == "google":
                async with session.get(
                    f"https://generativelanguage.googleapis.com/v1beta/models?key={key}",
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    return web.json_response({"ok": resp.status == 200, "status": resp.status})

            elif name == "huggingface":
                async with session.get(
                    "https://huggingface.co/api/whoami-v2",
                    headers={"Authorization": f"Bearer {key}"},
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    return web.json_response({"ok": resp.status == 200, "status": resp.status})

            elif name == "searxng":
                # SearXNG is a URL, not a token — test connectivity
                url = key.rstrip("/") + "/search?q=test&format=json&engines=duckduckgo"
                async with session.get(
                    url,
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    return web.json_response({"ok": resp.status == 200, "status": resp.status})

        return web.json_response({"ok": False, "error": "unknown service"})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def create_observatorist(request: web.Request) -> web.Response:
    """POST /api/workspaces/{id}/observatorist — Create or return the Observatorist session."""
    import observatory
    workspace_id = request.match_info["id"]

    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,))
        ws = await cur.fetchone()
        if not ws:
            return web.json_response({"error": "workspace not found"}, status=404)

        # Check for existing observatorist session
        cur = await db.execute(
            "SELECT * FROM sessions WHERE workspace_id = ? AND session_type = 'observatorist' "
            "ORDER BY created_at DESC LIMIT 1",
            (workspace_id,),
        )
        existing = await cur.fetchone()
        if existing:
            d = dict(existing)
            d["status"] = "running" if pty_mgr.is_alive(d["id"]) else "idle"
            return web.json_response(d)

        session_id = str(uuid.uuid4())
        name = f"Observatorist — {dict(ws)['name']}"
        await db.execute(
            "INSERT INTO sessions (id, workspace_id, name, model, permission_mode, effort, "
            "system_prompt, session_type, auto_approve_mcp, cli_type) "
            "VALUES (?, ?, ?, 'sonnet', 'default', 'high', ?, 'observatorist', 1, 'claude')",
            (session_id, workspace_id, name, observatory.OBSERVATORIST_SYSTEM_PROMPT),
        )
        # Attach Deep Research MCP for search tools
        await db.execute(
            "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) "
            "VALUES (?, 'builtin-deep-research', 1)",
            (session_id,),
        )
        # Attach Commander MCP for accessing observatory data
        await db.execute(
            "INSERT OR IGNORE INTO session_mcp_servers (session_id, mcp_server_id, auto_approve_override) "
            "VALUES (?, 'builtin-commander', 1)",
            (session_id,),
        )
        await db.commit()

        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        row = await cur.fetchone()
        d = dict(row)
        d["status"] = "idle"

        await broadcast({"type": "session_created", "session": d})
        return web.json_response(d, status=201)
    finally:
        await db.close()


# ─── REST: Test Queue ────────────────────────────────────────────────

async def list_test_queue(request: web.Request) -> web.Response:
    """GET /api/workspaces/{id}/test-queue — list queued/running tests."""
    workspace_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT * FROM test_queue WHERE workspace_id = ? ORDER BY created_at ASC",
            (workspace_id,),
        )
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


async def enqueue_test(request: web.Request) -> web.Response:
    """POST /api/workspaces/{id}/test-queue — add a test to the queue.

    Body: { task_id?, title, description?, acceptance_criteria? }
    If task_id is provided, title/description/acceptance_criteria are pulled from the task.
    """
    workspace_id = request.match_info["id"]
    body = await request.json()
    task_id = body.get("task_id")

    db = await get_db()
    try:
        title = body.get("title", "")
        description = body.get("description", "")
        acceptance_criteria = body.get("acceptance_criteria", "")

        # If task_id provided, pull details from the task
        if task_id:
            cur = await db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
            task = await cur.fetchone()
            if task:
                task = dict(task)
                title = title or task.get("title", "")
                description = description or task.get("description", "")
                acceptance_criteria = acceptance_criteria or task.get("acceptance_criteria", "")

        if not title:
            return web.json_response({"error": "title required"}, status=400)

        entry_id = str(uuid.uuid4())
        await db.execute(
            """INSERT INTO test_queue (id, workspace_id, task_id, title, description, acceptance_criteria)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (entry_id, workspace_id, task_id, title, description, acceptance_criteria),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM test_queue WHERE id = ?", (entry_id,))
        row = await cur.fetchone()
        entry = dict(row)

        # Broadcast to WebSocket clients
        for ws in ws_clients:
            try:
                await ws.send_json({"type": "test_queue_update", "workspace_id": workspace_id, "entry": entry})
            except Exception:
                pass

        # Try to process the queue (start next test if tester is idle)
        import asyncio
        asyncio.ensure_future(_process_test_queue(workspace_id))

        return web.json_response(entry, status=201)
    finally:
        await db.close()


async def remove_from_test_queue(request: web.Request) -> web.Response:
    """DELETE /api/test-queue/{id} — remove a queued test."""
    entry_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM test_queue WHERE id = ?", (entry_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "not found"}, status=404)
        workspace_id = dict(row)["workspace_id"]
        await db.execute("DELETE FROM test_queue WHERE id = ?", (entry_id,))
        await db.commit()

        for ws in ws_clients:
            try:
                await ws.send_json({"type": "test_queue_update", "workspace_id": workspace_id, "removed": entry_id})
            except Exception:
                pass

        return web.json_response({"ok": True})
    finally:
        await db.close()


async def _process_test_queue(workspace_id: str):
    """Background: pick the next queued test and dispatch to the tester.

    In 'direct' mode: sends the test to the singleton tester session.
    In 'delegated' mode: spawns a new test-worker session for each test.
    """
    import asyncio

    db = await get_db()
    try:
        # Get workspace tester_mode
        cur = await db.execute("SELECT tester_mode FROM workspaces WHERE id = ?", (workspace_id,))
        ws_row = await cur.fetchone()
        tester_mode = dict(ws_row).get("tester_mode", "direct") if ws_row else "direct"

        if tester_mode == "direct":
            # Check if there's already a running test
            cur = await db.execute(
                "SELECT id FROM test_queue WHERE workspace_id = ? AND status = 'running' LIMIT 1",
                (workspace_id,),
            )
            if await cur.fetchone():
                return  # Already processing one

            # Get next queued item
            cur = await db.execute(
                "SELECT * FROM test_queue WHERE workspace_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1",
                (workspace_id,),
            )
            row = await cur.fetchone()
            if not row:
                return
            entry = dict(row)

            # Mark as running
            await db.execute(
                "UPDATE test_queue SET status = 'running', started_at = datetime('now') WHERE id = ?",
                (entry["id"],),
            )
            await db.commit()

            # Get or create tester session
            cur = await db.execute(
                "SELECT id FROM sessions WHERE workspace_id = ? AND session_type = 'tester' ORDER BY created_at DESC LIMIT 1",
                (workspace_id,),
            )
            tester_row = await cur.fetchone()
            if not tester_row:
                # No tester yet — can't process, revert to queued
                await db.execute(
                    "UPDATE test_queue SET status = 'queued', started_at = NULL WHERE id = ?",
                    (entry["id"],),
                )
                await db.commit()
                return

            tester_id = dict(tester_row)["id"]

            # Build test prompt and send to tester via PTY input
            prompt = _build_test_prompt(entry)
            if pty_mgr.is_alive(tester_id):
                msg_bytes = prompt.encode("utf-8")
                pty_mgr.write(tester_id, b"\x1b" + b"\x7f" * 20)
                await asyncio.sleep(0.15)
                pty_mgr.write(tester_id, msg_bytes)
                await asyncio.sleep(0.4)
                pty_mgr.write(tester_id, b"\r")  # CR submits in raw-mode CLI TUIs (LF would leave it unsubmitted)

            # Broadcast status update
            for ws in ws_clients:
                try:
                    await ws.send_json({
                        "type": "test_queue_update",
                        "workspace_id": workspace_id,
                        "entry": {**entry, "status": "running"},
                    })
                except Exception:
                    pass

        elif tester_mode == "delegated":
            # In delegated mode, pick ALL queued items and spawn a test-worker for each
            cur = await db.execute(
                "SELECT * FROM test_queue WHERE workspace_id = ? AND status = 'queued' ORDER BY created_at ASC",
                (workspace_id,),
            )
            queued = [dict(r) for r in await cur.fetchall()]
            if not queued:
                return

            # Get or create the tester (test-commander) session
            cur = await db.execute(
                "SELECT id FROM sessions WHERE workspace_id = ? AND session_type = 'tester' ORDER BY created_at DESC LIMIT 1",
                (workspace_id,),
            )
            tester_row = await cur.fetchone()
            if not tester_row:
                return

            tester_id = dict(tester_row)["id"]
            if not pty_mgr.is_alive(tester_id):
                return

            # Mark all as running and send batch to test-commander
            for entry in queued:
                await db.execute(
                    "UPDATE test_queue SET status = 'running', started_at = datetime('now') WHERE id = ?",
                    (entry["id"],),
                )
            await db.commit()

            # Build a batch prompt for the test-commander
            prompt_parts = ["New test requests to delegate to test-workers:\n"]
            for i, entry in enumerate(queued, 1):
                prompt_parts.append(f"## Test {i}: {entry['title']}")
                if entry.get("description"):
                    prompt_parts.append(f"Description: {entry['description']}")
                if entry.get("acceptance_criteria"):
                    prompt_parts.append(f"Acceptance Criteria: {entry['acceptance_criteria']}")
                prompt_parts.append(f"Queue ID: {entry['id']}")
                prompt_parts.append("")

            prompt_parts.append("Create test-worker sessions and delegate these tests. Report results when all workers complete.")
            batch_bytes = "\n".join(prompt_parts).encode("utf-8")
            pty_mgr.write(tester_id, b"\x1b" + b"\x7f" * 20)
            await asyncio.sleep(0.15)
            pty_mgr.write(tester_id, batch_bytes)
            await asyncio.sleep(0.4)
            pty_mgr.write(tester_id, b"\r")

            for ws in ws_clients:
                try:
                    await ws.send_json({
                        "type": "test_queue_update",
                        "workspace_id": workspace_id,
                        "batch_started": [e["id"] for e in queued],
                    })
                except Exception:
                    pass
    finally:
        await db.close()


def _build_test_prompt(entry: dict) -> str:
    """Build a test prompt from a queue entry."""
    parts = [f"Please test the following:\n\n## {entry['title']}"]
    if entry.get("description"):
        parts.append(f"\nDescription:\n{entry['description']}")
    if entry.get("acceptance_criteria"):
        parts.append(f"\nAcceptance Criteria:\n{entry['acceptance_criteria']}")
    parts.append("\nRun the tests now and report results with screenshots.")
    return "\n".join(parts)


async def update_test_queue_entry(request: web.Request) -> web.Response:
    """PUT /api/test-queue/{id} — update a queue entry (e.g. mark done/failed with summary)."""
    entry_id = request.match_info["id"]
    body = await request.json()
    db = await get_db()
    try:
        allowed = ("status", "result_summary", "assigned_session_id")
        fields, values = [], []
        for key in allowed:
            if key in body:
                fields.append(f"{key} = ?")
                values.append(body[key])
        if not fields:
            return web.json_response({"error": "no fields"}, status=400)

        # Auto-set completed_at when moving to done/failed
        if body.get("status") in ("done", "failed"):
            fields.append("completed_at = datetime('now')")

        values.append(entry_id)
        await db.execute(f"UPDATE test_queue SET {', '.join(fields)} WHERE id = ?", values)
        await db.commit()

        cur = await db.execute("SELECT * FROM test_queue WHERE id = ?", (entry_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "not found"}, status=404)
        entry = dict(row)

        # Broadcast
        for ws in ws_clients:
            try:
                await ws.send_json({
                    "type": "test_queue_update",
                    "workspace_id": entry["workspace_id"],
                    "entry": entry,
                })
            except Exception:
                pass

        # If this was the running test in direct mode and it's now done/failed, process next
        if body.get("status") in ("done", "failed"):
            import asyncio
            asyncio.ensure_future(_process_test_queue(entry["workspace_id"]))
            # Emit event for pipeline to pick up
            await bus.emit(CommanderEvent.TEST_QUEUE_ENTRY_COMPLETED, {
                "test_queue_id": entry_id,
                "task_id": entry.get("task_id"),
                "workspace_id": entry.get("workspace_id"),
                "status": body["status"],
                "result_summary": entry.get("result_summary"),
            }, source="test_queue")

        return web.json_response(entry)
    finally:
        await db.close()


# ─── REST: Session Tree ──────────────────────────────────────────────

async def get_session_tree(request: web.Request) -> web.Response:
    """Return a recursive tree of sessions rooted at the given session."""
    session_id = request.match_info["id"]
    db = await get_db()
    try:
        # Fetch root session
        cur = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        root = await cur.fetchone()
        if not root:
            return web.json_response({"error": "session not found"}, status=404)

        async def build_tree(sid: str) -> dict:
            cur2 = await db.execute("SELECT * FROM sessions WHERE id = ?", (sid,))
            row = await cur2.fetchone()
            if not row:
                return None
            node = dict(row)
            node["status"] = "running" if pty_mgr.is_alive(node["id"]) else "idle"
            # Find children
            cur3 = await db.execute(
                "SELECT id FROM sessions WHERE parent_session_id = ? ORDER BY created_at",
                (sid,),
            )
            child_rows = await cur3.fetchall()
            children = []
            for child in child_rows:
                child_tree = await build_tree(child["id"])
                if child_tree:
                    children.append(child_tree)
            node["children"] = children
            return node

        tree = await build_tree(session_id)
        return web.json_response(tree)
    finally:
        await db.close()


# ─── REST: Session Subagents ─────────────────────────────────────────

async def get_session_subagents(request: web.Request) -> web.Response:
    """Return the in-memory sub-agent list for a session (from CLI hooks)."""
    from hooks import get_subagents
    session_id = request.match_info["id"]
    if not await _session_exists(session_id):
        return web.json_response({"error": "session not found"}, status=404)
    return web.json_response(get_subagents(session_id))


async def get_subagent_transcript(request: web.Request) -> web.Response:
    """Read and return a sub-agent's transcript as formatted markdown."""
    from hooks import get_subagents
    from history_reader import read_session_messages, export_session_as_markdown

    session_id = request.match_info["id"]
    agent_id = request.match_info["agent_id"]

    # Find the agent in hook state
    agents = get_subagents(session_id)
    agent = next((a for a in agents if a.get("id") == agent_id), None)
    if not agent:
        return web.json_response({"error": "Agent not found"}, status=404)

    transcript_path = agent.get("transcript_path")
    if not transcript_path or not os.path.isfile(transcript_path):
        return web.json_response({
            "markdown": None,
            "agent": agent,
            "error": "Transcript file not available",
        })

    messages = read_session_messages(transcript_path)
    markdown = export_session_as_markdown(messages)
    return web.json_response({
        "markdown": markdown,
        "agent": agent,
    })


# ─── REST: Accounts ──────────────────────────────────────────────────

async def list_accounts(request):
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM accounts ORDER BY is_default DESC, name")
        rows = await cur.fetchall()
        # Mask API keys in response
        result = []
        for r in rows:
            d = dict(r)
            if d.get("api_key"):
                key = d["api_key"]
                d["api_key_masked"] = key[:8] + "..." + key[-4:] if len(key) > 12 else "***"
                del d["api_key"]  # Don't send raw key in list
            result.append(d)
        return web.json_response(result)
    finally:
        await db.close()

async def create_account(request):
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        return web.json_response({"error": "name required"}, status=400)

    acc_id = str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO accounts (id, name, type, api_key, is_default, browser_path, chrome_profile) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (acc_id, name, body.get("type", "api_key"), body.get("api_key"), 1 if body.get("is_default") else 0,
             body.get("browser_path"), body.get("chrome_profile")),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM accounts WHERE id = ?", (acc_id,))
        row = await cur.fetchone()
        return web.json_response(dict(row), status=201)
    finally:
        await db.close()

async def update_account(request):
    acc_id = request.match_info["id"]
    body = await request.json()
    db = await get_db()
    try:
        allowed = ("name", "type", "api_key", "is_default", "status", "quota_reset_at", "browser_path", "chrome_profile")
        fields, values = [], []
        for key in allowed:
            if key in body:
                fields.append(f"{key} = ?")
                values.append(body[key])
        if not fields:
            return web.json_response({"error": "no fields"}, status=400)
        values.append(acc_id)
        await db.execute(f"UPDATE accounts SET {', '.join(fields)} WHERE id = ?", values)
        await db.commit()
        cur = await db.execute("SELECT * FROM accounts WHERE id = ?", (acc_id,))
        row = await cur.fetchone()
        return web.json_response(dict(row))
    finally:
        await db.close()

async def delete_account(request):
    acc_id = request.match_info["id"]
    db = await get_db()
    try:
        await db.execute("DELETE FROM accounts WHERE id = ?", (acc_id,))
        await db.commit()
        return web.json_response({"ok": True})
    finally:
        await db.close()

async def test_account(request):
    """Test an API key by making a simple API call."""
    acc_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("SELECT api_key FROM accounts WHERE id = ?", (acc_id,))
        row = await cur.fetchone()
        if not row or not row["api_key"]:
            return web.json_response({"error": "no API key"}, status=400)

        import urllib.request
        import urllib.error
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": row["api_key"],
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            data=json.dumps({
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}],
            }).encode(),
            method="POST",
        )
        try:
            urllib.request.urlopen(req, timeout=10)
            await db.execute("UPDATE accounts SET status = 'active', last_used_at = datetime('now') WHERE id = ?", (acc_id,))
            await db.commit()
            return web.json_response({"status": "ok", "message": "API key is valid"})
        except urllib.error.HTTPError as e:
            status_code = e.code
            if status_code == 401:
                return web.json_response({"status": "error", "message": "Invalid API key"})
            elif status_code == 429:
                await db.execute(
                    "UPDATE accounts SET status = 'quota_exceeded', quota_reset_at = datetime('now', '+4 hours') WHERE id = ?",
                    (acc_id,),
                )
                await db.commit()
                return web.json_response({"status": "quota_exceeded", "message": "Rate limited — 4h cooldown started"})
            return web.json_response({"status": "error", "message": f"HTTP {status_code}"})
    finally:
        await db.close()


# ─── REST: Account Browser ───────────────────────────────────────────────

async def detect_browsers(request: web.Request) -> web.Response:
    """GET /api/browser/detect — find installed browsers and Chrome profiles.

    Lets the account-create UI offer dropdowns instead of forcing users
    to type paths and profile names.
    """
    import platform
    import shutil as _shutil

    browsers: list[dict] = []
    profiles: list[dict] = []
    local_state: str | None = None

    if platform.system() == "Darwin":
        candidates = [
            ("/Applications/Google Chrome.app", "Google Chrome"),
            ("/Applications/Brave Browser.app", "Brave Browser"),
            ("/Applications/Arc.app", "Arc"),
            ("/Applications/Microsoft Edge.app", "Microsoft Edge"),
            ("/Applications/Vivaldi.app", "Vivaldi"),
            ("/Applications/Opera.app", "Opera"),
            ("/Applications/Firefox.app", "Firefox"),
            ("/Applications/Safari.app", "Safari"),
        ]
        for path, name in candidates:
            if os.path.exists(path):
                browsers.append({"path": path, "name": name})
        local_state = os.path.expanduser(
            "~/Library/Application Support/Google Chrome/Local State"
        )
    elif platform.system() == "Linux":
        for binary in ("google-chrome", "google-chrome-stable", "chromium",
                       "brave-browser", "firefox", "microsoft-edge"):
            p = _shutil.which(binary)
            if p:
                browsers.append({"path": p, "name": binary})
        local_state = os.path.expanduser("~/.config/google-chrome/Local State")

    if local_state and os.path.exists(local_state):
        try:
            with open(local_state, "r") as f:
                data = json.load(f)
            info_cache = data.get("profile", {}).get("info_cache", {})
            for dir_name, info in info_cache.items():
                profiles.append({
                    "dir": dir_name,
                    "name": info.get("name") or dir_name,
                    "email": info.get("user_name") or "",
                })
            profiles.sort(key=lambda p: (p["dir"] != "Default", p["dir"]))
        except Exception as e:
            logger.debug("Failed to read Chrome Local State: %s", e)

    has_claude_auth = os.path.exists(os.path.expanduser("~/.claude"))
    has_gemini_auth = os.path.exists(os.path.expanduser("~/.gemini"))

    return web.json_response({
        "browsers": browsers,
        "profiles": profiles,
        "has_claude_auth": has_claude_auth,
        "has_gemini_auth": has_gemini_auth,
    })


_SAFE_BROWSER_NAMES = {
    "google chrome", "chrome", "chromium", "brave browser", "firefox",
    "safari", "arc", "microsoft edge", "vivaldi", "opera",
}


def _is_safe_browser(path: str) -> bool:
    if not path:
        return True
    lp = path.lower().strip()
    if lp.endswith(".app") or ".app/" in lp:
        app_name = lp.rsplit("/", 1)[-1].replace(".app", "").strip()
        return app_name in _SAFE_BROWSER_NAMES or lp.startswith("/applications/")
    # Bare names ("Google Chrome", "Brave Browser") get routed to `open -a` on
    # macOS, which resolves them via LaunchServices regardless of $PATH.
    if lp in _SAFE_BROWSER_NAMES:
        return True
    import shutil
    return shutil.which(os.path.basename(path)) is not None


def _is_bare_browser_name(path: str) -> bool:
    """True if path is a bare app name (no slashes, in the safe-name set)."""
    if not path:
        return False
    p = path.strip()
    if "/" in p or p.lower().endswith(".app"):
        return False
    return p.lower() in _SAFE_BROWSER_NAMES


def _is_safe_chrome_profile(name: str) -> bool:
    if not name:
        return True
    import re as _re
    return bool(_re.match(r'^[\w\s\-\.]+$', name))


def _login_url_for_cli(cli_type: str) -> str:
    """Pick the right OAuth/login start URL for a given CLI type."""
    try:
        from auth_cycler import _CLI_AUTH
        entry = _CLI_AUTH.get((cli_type or "").lower().strip())
        if entry and entry.get("login_url"):
            return entry["login_url"]
    except Exception:
        pass
    return "https://claude.ai"


async def open_account_browser(request: web.Request) -> web.Response:
    """Open a browser for a specific account using its configured browser/profile.

    Accepts optional `cli_type` and/or `url` in the JSON body. When `url`
    is omitted we pick the OAuth login URL matching `cli_type` (falling
    back to claude.ai). Previously this was hardcoded to claude.ai, which
    broke the button for Gemini accounts.
    """
    import subprocess
    acc_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM accounts WHERE id = ?", (acc_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "account not found"}, status=404)
        acc = dict(row)
    finally:
        await db.close()

    browser_path = acc.get("browser_path") or ""
    chrome_profile = acc.get("chrome_profile") or ""

    body = await request.json() if request.content_length else {}
    cli_type = (body.get("cli_type") or acc.get("cli_type") or "claude").lower()
    url = body.get("url") or _login_url_for_cli(cli_type)

    if browser_path and not _is_safe_browser(browser_path):
        return web.json_response({"error": "unrecognized browser path"}, status=400)

    if chrome_profile and not _is_safe_chrome_profile(chrome_profile):
        return web.json_response({"error": "invalid chrome profile name"}, status=400)

    try:
        if browser_path and chrome_profile:
            # Launch specific browser with profile
            if _is_bare_browser_name(browser_path):
                # Bare name — `open -a` resolves via LaunchServices
                subprocess.Popen(["open", "-na", browser_path, "--args", f"--profile-directory={chrome_profile}", url])
            elif browser_path.endswith(".app") or ".app/" in browser_path:
                # macOS .app bundle — use open -na
                subprocess.Popen(["open", "-na", browser_path, "--args", f"--profile-directory={chrome_profile}", url])
            else:
                subprocess.Popen([browser_path, f"--profile-directory={chrome_profile}", url])
        elif browser_path:
            # Browser without profile
            if _is_bare_browser_name(browser_path):
                subprocess.Popen(["open", "-na", browser_path, url])
            elif browser_path.endswith(".app") or ".app/" in browser_path:
                subprocess.Popen(["open", "-na", browser_path, url])
            else:
                subprocess.Popen([browser_path, url])
        elif chrome_profile:
            # Default Chrome with profile
            subprocess.Popen(["open", "-na", "Google Chrome", "--args", f"--profile-directory={chrome_profile}", url])
        else:
            # Just open URL in default browser
            subprocess.Popen(["open", url])

        return web.json_response({"ok": True, "account": acc["name"], "browser_path": browser_path, "chrome_profile": chrome_profile, "url": url})
    except Exception as e:
        logger.exception("open_account_browser failed for %s", acc.get("name"))
        return web.json_response({"error": str(e)}, status=500)


async def open_next_account(request: web.Request) -> web.Response:
    """Find the next usable non-API-key account and open its browser."""
    db = await get_db()
    try:
        # Find OAuth accounts that are active, ordered by least recently used
        cur = await db.execute(
            "SELECT * FROM accounts WHERE type != 'api_key' AND status = 'active' "
            "ORDER BY last_used_at ASC NULLS FIRST, created_at ASC"
        )
        rows = await cur.fetchall()
        if not rows:
            # Fallback: try quota_exceeded accounts whose reset time has passed
            cur = await db.execute(
                "SELECT * FROM accounts WHERE type != 'api_key' AND status = 'quota_exceeded' "
                "AND quota_reset_at <= datetime('now') "
                "ORDER BY quota_reset_at ASC"
            )
            rows = await cur.fetchall()

        if not rows:
            return web.json_response({"error": "no available accounts", "message": "All non-API accounts are exhausted or none configured"}, status=404)

        acc = dict(rows[0])

        # Mark this account as used now
        await db.execute(
            "UPDATE accounts SET last_used_at = datetime('now') WHERE id = ?",
            (acc["id"],),
        )
        await db.commit()
    finally:
        await db.close()

    # Open the browser for this account
    import subprocess
    browser_path = acc.get("browser_path") or ""
    chrome_profile = acc.get("chrome_profile") or ""

    body = await request.json() if request.content_length else {}
    cli_type = (body.get("cli_type") or acc.get("cli_type") or "claude").lower()
    url = body.get("url") or _login_url_for_cli(cli_type)

    if browser_path and not _is_safe_browser(browser_path):
        return web.json_response({"error": "unrecognized browser path"}, status=400)
    if chrome_profile and not _is_safe_chrome_profile(chrome_profile):
        return web.json_response({"error": "invalid chrome profile name"}, status=400)

    try:
        if browser_path and chrome_profile:
            if _is_bare_browser_name(browser_path) or browser_path.endswith(".app") or ".app/" in browser_path:
                subprocess.Popen(["open", "-na", browser_path, "--args", f"--profile-directory={chrome_profile}", url])
            else:
                subprocess.Popen([browser_path, f"--profile-directory={chrome_profile}", url])
        elif browser_path:
            if _is_bare_browser_name(browser_path) or browser_path.endswith(".app") or ".app/" in browser_path:
                subprocess.Popen(["open", "-na", browser_path, url])
            else:
                subprocess.Popen([browser_path, url])
        elif chrome_profile:
            subprocess.Popen(["open", "-na", "Google Chrome", "--args", f"--profile-directory={chrome_profile}", url])
        else:
            subprocess.Popen(["open", url])

        return web.json_response({
            "ok": True,
            "account_id": acc["id"],
            "account_name": acc["name"],
            "browser_path": browser_path,
            "chrome_profile": chrome_profile,
            "url": url,
        })
    except Exception as e:
        logger.exception("open_next_account failed")
        return web.json_response({"error": str(e)}, status=500)


# ─── REST: Account OAuth Sandbox ──────────────────────────────────────────

async def snapshot_account(request: web.Request) -> web.Response:
    """Snapshot current ~/.claude/ auth state for an OAuth account."""
    from account_sandbox import snapshot_current_auth
    acc_id = request.match_info["id"]
    # Validate the account row exists FIRST. Previously any UUID would copy
    # ~2 GB to ~/.ive/account_homes/<random>/ — disk-fill DoS once tunnel-
    # exposed (BUG C1).
    db = await get_db()
    try:
        cur = await db.execute("SELECT id FROM accounts WHERE id = ?", (acc_id,))
        row = await cur.fetchone()
    finally:
        await db.close()
    if not row:
        return web.json_response({"error": "account not found"}, status=404)
    result = snapshot_current_auth(acc_id)
    if result.get("error"):
        return web.json_response(result, status=400)

    # Mark account as oauth type with snapshot
    db = await get_db()
    try:
        await db.execute(
            "UPDATE accounts SET type = 'oauth', status = 'active', last_used_at = datetime('now') WHERE id = ?",
            (acc_id,),
        )
        await db.commit()
    finally:
        await db.close()

    return web.json_response(result)


# ─── REST: Playwright Auth Cycling ───────────────────────────────────────

async def playwright_setup_browser(request: web.Request) -> web.Response:
    """POST /api/accounts/{id}/setup-browser

    Launch a visible Playwright browser for the user to log in manually.
    Saves cookies in a persistent context for later headless re-auth.
    Body: { "cli_type": "claude" | "gemini" }
    """
    from auth_cycler import auth_cycler
    acc_id = request.match_info["id"]
    body = await request.json() if request.content_length else {}
    cli_type = body.get("cli_type")
    result = await auth_cycler.setup_browser(acc_id, cli_type=cli_type)
    status = 200 if result.get("ok") else 400
    return web.json_response(result, status=status)


async def playwright_auth(request: web.Request) -> web.Response:
    """POST /api/accounts/{id}/playwright-auth

    Automate ``claude auth login`` / ``gemini auth login`` using Playwright
    with stored cookies.
    Body: { "headless": true, "cli_type": "claude" | "gemini" }
    """
    from auth_cycler import auth_cycler
    acc_id = request.match_info["id"]
    body = await request.json() if request.content_length else {}
    headless = body.get("headless", True)
    cli_type = body.get("cli_type")
    result = await auth_cycler.playwright_auth(acc_id, cli_type=cli_type, headless=headless)
    status = 200 if result.get("status") == "success" else 400
    return web.json_response(result, status=status)


async def playwright_auth_status(request: web.Request) -> web.Response:
    """GET /api/accounts/{id}/auth-status

    Check whether an account has a Playwright browser context and valid auth snapshot.
    """
    from auth_cycler import auth_cycler
    from account_sandbox import has_snapshot, has_isolated_claude_credentials
    acc_id = request.match_info["id"]
    return web.json_response({
        "account_id": acc_id,
        "has_browser_context": auth_cycler.has_browser_context(acc_id),
        "has_auth_snapshot": has_snapshot(acc_id),
        "isolated_credentials": has_isolated_claude_credentials(acc_id),
    })


async def restart_with_account(request: web.Request) -> web.Response:
    """Stop a session and restart it with a different account (for quota failover)."""
    session_id = request.match_info["id"]
    body = await request.json()
    new_account_id = body.get("account_id")
    if not new_account_id:
        return web.json_response({"error": "account_id required"}, status=400)

    # Update session's account
    db = await get_db()
    try:
        await db.execute("UPDATE sessions SET account_id = ? WHERE id = ?", (new_account_id, session_id))
        await db.commit()
    finally:
        await db.close()

    # Stop current PTY (if running)
    await pty_mgr.stop_session(session_id)

    # The frontend will detect the exit and can restart via start_pty
    # which will pick up the new account_id and inject the right auth
    await broadcast({
        "session_id": session_id,
        "type": "account_switched",
        "new_account_id": new_account_id,
        "message": "Account switched. Session will restart with new auth.",
    })

    return web.json_response({"ok": True, "session_id": session_id, "new_account_id": new_account_id})


# ─── REST: Native Terminal Pop-Out ──────────────────────────────────────────

async def pop_out_session(request: web.Request) -> web.Response:
    """POST /api/sessions/{id}/pop-out

    Opens the session in a native OS terminal (Terminal.app / iTerm2 on macOS).
    Builds the same CLI command as start_pty would, but instead of spawning a
    PTY inside Commander, opens a real terminal window. Hooks still relay events
    back to Commander so session state, tool tracking, and subagent tracking
    all continue to work.

    The session is marked as is_external=1 so the frontend knows to show a
    status card instead of an xterm.js terminal.
    """
    import shlex
    import sys

    session_id = request.match_info["id"]

    config = await get_session_config(session_id)
    if not config:
        return web.json_response({"error": "Session not found"}, status=400)

    # Check workspace has native terminals enabled
    workspace_id = config.get("workspace_id", "")
    db_check = await get_db()
    try:
        cur = await db_check.execute(
            "SELECT native_terminals_enabled FROM workspaces WHERE id = ?",
            (workspace_id,),
        )
        ws_row = await cur.fetchone()
        if not ws_row or not ws_row["native_terminals_enabled"]:
            return web.json_response(
                {"error": "Native terminals not enabled for this workspace"},
                status=400,
            )
    finally:
        await db_check.close()

    # Stop existing PTY if running (can't have both)
    if pty_mgr.is_alive(session_id):
        await pty_mgr.stop_session(session_id)

    # Build CLI command via UnifiedSession (same logic as start_pty)
    cli_type = config.get("cli_type", "claude")
    session_obj = UnifiedSession(cli_type, config)

    # Minimal system prompt for pop-out (guidelines omitted — user manages their own)
    if config.get("system_prompt"):
        session_obj.append_system_prompt(config["system_prompt"])

    # Resume if native_session_id exists
    native_sid = config.get("native_session_id")
    if native_sid:
        session_obj.set(Feature.RESUME_ID, native_sid)

    cmd = session_obj.build_command()
    workspace_path = config.get("workspace_path", os.path.expanduser("~"))

    # Env vars for hook relay (critical — this is what keeps Commander connected)
    env_exports = (
        f'export COMMANDER_SESSION_ID="{session_id}"; '
        f'export COMMANDER_API_URL="http://{HOST}:{PORT}"; '
        f'export COMMANDER_WORKSPACE_ID="{workspace_id}"; '
        f'export COMMANDER_CLI_TYPE="{cli_type}"; '
    )
    cli_cmd = " ".join(shlex.quote(c) for c in cmd)
    full_cmd = f'{env_exports}cd {shlex.quote(workspace_path)} && {cli_cmd}'

    # Open in native terminal (macOS)
    if sys.platform == "darwin":
        # Try iTerm2 first, fall back to Terminal.app
        iterm_script = (
            f'tell application "iTerm"\n'
            f'  create window with default profile\n'
            f'  tell current session of current window\n'
            f'    write text {json.dumps(full_cmd)}\n'
            f'  end tell\n'
            f'end tell'
        )
        terminal_script = (
            f'tell application "Terminal"\n'
            f'  do script {json.dumps(full_cmd)}\n'
            f'  activate\n'
            f'end tell'
        )

        # Prefer iTerm2 if installed
        try:
            proc = await _asyncio.create_subprocess_exec(
                "osascript", "-e", iterm_script,
                stdout=_asyncio.subprocess.PIPE,
                stderr=_asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate()
            if proc.returncode != 0:
                raise RuntimeError(stderr.decode())
            terminal_app = "iTerm2"
        except Exception:
            # Fall back to Terminal.app
            proc = await _asyncio.create_subprocess_exec(
                "osascript", "-e", terminal_script,
                stdout=_asyncio.subprocess.PIPE,
                stderr=_asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate()
            if proc.returncode != 0:
                return web.json_response(
                    {"error": f"Failed to open terminal: {stderr.decode()[:200]}"},
                    status=500,
                )
            terminal_app = "Terminal.app"
    else:
        return web.json_response(
            {"error": "Native terminal pop-out is currently macOS-only"},
            status=400,
        )

    # Mark session as external
    db_up = await get_db()
    try:
        await db_up.execute(
            "UPDATE sessions SET is_external = 1 WHERE id = ?",
            (session_id,),
        )
        await db_up.commit()
    finally:
        await db_up.close()

    await broadcast({
        "session_id": session_id,
        "type": "session_popped_out",
        "terminal": terminal_app,
    })

    return web.json_response({
        "ok": True,
        "session_id": session_id,
        "terminal": terminal_app,
        "command": cli_cmd,
    })


async def handle_pipeline_result(request: web.Request) -> web.Response:
    """POST /api/hooks/pipeline-result

    Called by agents (via worker MCP report_pipeline_result tool) to report
    structured pass/fail results for pipeline stages. This gives the pipeline
    engine a definitive signal instead of keyword-matching terminal output.
    """
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)

    session_id = payload.get("session_id")
    status = payload.get("status", "pass")   # 'pass' or 'fail'
    summary = payload.get("summary", "")
    details = payload.get("details", "")

    if not session_id:
        return web.json_response({"error": "session_id required"}, status=400)

    # MCP-S6: reject body session_id that doesn't match the calling session.
    # Without this an attacker who knows another session's id can forge a
    # 'pass' result for that session's pipeline run.
    caller = await _resolve_caller(request)
    if caller and caller["session_id"] != session_id:
        return web.json_response(
            {"error": "forbidden: pipeline-result session_id must match calling session"},
            status=403,
        )

    import pipeline_engine
    run_id = pipeline_engine._session_to_run.get(session_id)
    if not run_id:
        return web.json_response({"ok": False, "message": "session not in active pipeline"})

    run = await pipeline_engine.get_run(run_id)
    if not run:
        return web.json_response({"ok": False, "message": "run not found"})

    # Find the stage for this session
    stage_history = run.get("stage_history", {})
    if isinstance(stage_history, str):
        import json as _json
        stage_history = _json.loads(stage_history)
    stage_id = None
    for sid, sh in stage_history.items():
        if sh.get("session_id") == session_id and sh.get("status") == "running":
            stage_id = sid
            break

    if not stage_id:
        return web.json_response({"ok": False, "message": "no active stage for session"})

    # Store the structured result — prefixed with __pipeline_result: so the
    # condition evaluator can detect it vs. raw terminal output
    result_output = f"__pipeline_result:{status}:{summary}"
    if details:
        result_output += f"\n{details[:1500]}"
    await pipeline_engine._update_stage_status(run_id, stage_id, "completed", output_summary=result_output)

    logger.info("Pipeline result: session %s stage %s → %s: %s", session_id[:8], stage_id, status, summary[:100])

    # Complete the stage and advance the pipeline
    import asyncio as _asyncio
    _asyncio.ensure_future(pipeline_engine._complete_stage(run_id, stage_id))

    return web.json_response({"ok": True, "stage_id": stage_id, "status": status})


async def handle_hook_discover(request: web.Request) -> web.Response:
    """POST /api/hooks/discover

    Called by the hook relay script when COMMANDER_SESSION_ID is NOT set but
    auto-register is enabled. The hook sends the workspace path (CWD) and
    CLI process PID. Commander matches the path to a workspace and, if
    auto_register_terminals is enabled, creates a session and returns the
    session_id so subsequent hook calls can include it.

    The hook script caches the returned session_id in a temp file keyed by
    PID so it only calls discover once per CLI process lifetime.
    """
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)

    cwd = payload.get("cwd", "")
    pid = payload.get("pid", "")
    cli_type = payload.get("cli_type", "claude")
    hook_event = payload.get("hook_event_name", "")

    if not cwd:
        return web.json_response({})

    # Normalize the CWD path
    cwd = os.path.realpath(cwd)

    # Find workspace matching this CWD
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM workspaces WHERE auto_register_terminals = 1")
        rows = await cur.fetchall()

        matched_ws = None
        for ws in rows:
            ws_path = os.path.realpath(ws["path"])
            if cwd == ws_path or cwd.startswith(ws_path + os.sep):
                matched_ws = dict(ws)
                break

        if not matched_ws:
            return web.json_response({})  # No matching workspace — ignore

        # Check if we already have a session for this PID
        cur2 = await db.execute(
            "SELECT id FROM sessions WHERE is_external = 1 AND external_pid = ? AND workspace_id = ?",
            (str(pid), matched_ws["id"]),
        )
        existing = await cur2.fetchone()
        if existing:
            return web.json_response({"session_id": existing["id"]})

        # Create a new external session
        session_id = str(uuid.uuid4())
        name = f"External {cli_type.title()} {session_id[:6]}"
        default_model = get_profile(cli_type).default_model

        await db.execute(
            """INSERT INTO sessions
               (id, workspace_id, name, model, cli_type, is_external, external_pid)
               VALUES (?, ?, ?, ?, ?, 1, ?)""",
            (session_id, matched_ws["id"], name, default_model, cli_type, str(pid)),
        )
        await db.commit()

        logger.info(
            "Auto-registered external %s session %s (PID %s) in workspace %s",
            cli_type, session_id[:8], pid, matched_ws["name"],
        )

        await broadcast({
            "type": "session_created",
            "session_id": session_id,
            "workspace_id": matched_ws["id"],
            "name": name,
            "is_external": True,
        })

        return web.json_response({"session_id": session_id})
    finally:
        await db.close()


# ─── REST: Config ─────────────────────────────────────────────────────────

_discovered_models: dict = {}  # Populated at startup


async def get_cli_info(request: web.Request) -> web.Response:
    import shutil
    return web.json_response({
        "version": VERSION,
        "models": _discovered_models.get("claude") or AVAILABLE_MODELS,
        "permission_modes": PERMISSION_MODES,
        "effort_levels": EFFORT_LEVELS,
        "gemini_models": _discovered_models.get("gemini") or GEMINI_MODELS,
        "gemini_approval_modes": GEMINI_APPROVAL_MODES,
        "cli_types": CLI_TYPES,
        "available_clis": {
            "claude": shutil.which("claude") is not None,
            "gemini": shutil.which("gemini") is not None,
        },
    })


async def get_cli_feature_matrix(request: web.Request) -> web.Response:
    """Return the unified feature compatibility matrix.

    Driven entirely by cli_profiles.py so CLI-capability information has a
    single source of truth. Consumed by the marketplace UI to render
    compatibility badges and by plugin tooling to check feature support.
    """
    from cli_session import build_feature_matrix
    return web.json_response(build_feature_matrix())


# ─── REST: Global app settings ────────────────────────────────────────────
#
# Simple key/value store. Today the main use is experimental feature flags
# which MUST be opt-in — nothing here takes effect until the user explicitly
# sets a value.

async def list_output_styles(request: web.Request) -> web.Response:
    """List available output styles for token-saving modes."""
    from output_styles import OUTPUT_STYLE_LIST
    return web.json_response(OUTPUT_STYLE_LIST)


async def list_app_settings(request: web.Request) -> web.Response:
    db = await get_db()
    try:
        cur = await db.execute("SELECT key, value, updated_at FROM app_settings")
        rows = await cur.fetchall()
        settings = {row["key"]: row["value"] for row in rows}
        return web.json_response(settings)
    finally:
        await db.close()


async def get_app_setting(request: web.Request) -> web.Response:
    key = request.match_info["key"]
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT value, updated_at FROM app_settings WHERE key = ?", (key,)
        )
        row = await cur.fetchone()
        if not row:
            return web.json_response({"key": key, "value": None})
        return web.json_response({
            "key": key,
            "value": row["value"],
            "updated_at": row["updated_at"],
        })
    finally:
        await db.close()


async def put_app_setting(request: web.Request) -> web.Response:
    key = request.match_info["key"]
    # BUG L2: reject obviously-malformed setting keys so we don't grow a junk
    # drawer of typos in app_settings. Real keys are lower_snake_case ASCII.
    import re
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,119}", key or ""):
        return web.json_response(
            {"error": "setting key must match [a-z][a-z0-9_]*, max 120 chars"},
            status=400,
        )
    body = await request.json()
    value = body.get("value")
    # BUG L1: settings are stored as TEXT; coerce ints/bools/JSON to a string
    # rather than rejecting them, so callers can write {"value": true} or 42.
    if value is not None and not isinstance(value, str):
        if isinstance(value, bool):
            value = "on" if value else "off"
        elif isinstance(value, (int, float)):
            value = str(value)
        elif isinstance(value, (dict, list)):
            value = json.dumps(value)
        else:
            return web.json_response(
                {"error": "value must be a string, number, bool, or JSON object"},
                status=400,
            )

    # If this key corresponds to a known experimental flag, require the
    # value to be "on" or "off" so we don't accidentally accept garbage.
    if experimental.is_known_feature(key) and value not in (None, "on", "off"):
        return web.json_response(
            {"error": "experimental flags must be 'on' or 'off'"},
            status=400,
        )

    db = await get_db()
    try:
        if value is None:
            await db.execute("DELETE FROM app_settings WHERE key = ?", (key,))
        else:
            await db.execute(
                """INSERT INTO app_settings (key, value, updated_at)
                   VALUES (?, ?, datetime('now'))
                   ON CONFLICT(key) DO UPDATE SET
                     value = excluded.value,
                     updated_at = excluded.updated_at""",
                (key, value),
            )
        await db.commit()
    finally:
        await db.close()

    # ── Side-effects for specific settings ──────────────────────────
    if key == "experimental_avcp_protection":
        from hook_installer import install_avcp_hooks, uninstall_avcp_hooks
        try:
            if value == "on":
                install_avcp_hooks()
            else:
                uninstall_avcp_hooks()
        except Exception as e:
            logger.warning(f"AVCP hook toggle failed: {e}")
            return web.json_response({
                "ok": True, "key": key, "value": value,
                "warning": f"Setting saved but hook installation failed: {e}",
            })

    if key == "experimental_safety_gate":
        from hook_installer import install_safety_gate_hooks, uninstall_safety_gate_hooks
        try:
            if value == "on":
                install_safety_gate_hooks()
                db2 = await get_db()
                try:
                    from safety_engine import seed_builtin_rules
                    await seed_builtin_rules(db2)
                finally:
                    await db2.close()
            else:
                uninstall_safety_gate_hooks()
        except Exception as e:
            logger.warning(f"Safety Gate hook toggle failed: {e}")
            return web.json_response({
                "ok": True, "key": key, "value": value,
                "warning": f"Setting saved but hook installation failed: {e}",
            })

    if key == "experimental_auto_skill_suggestions":
        if value == "on":
            try:
                from skill_suggester import ensure_index
                _fire_and_forget(ensure_index(force=True))
                logger.info("Skill index build kicked off (toggle on)")
            except Exception as e:
                logger.warning("Skill index kick failed: %s", e)

    if key == "experimental_myelin_coordination":
        from hook_installer import install_myelin_hooks, uninstall_myelin_hooks
        try:
            if value == "on":
                install_myelin_hooks()
            else:
                uninstall_myelin_hooks()
        except Exception as e:
            logger.warning(f"Myelin hook toggle failed: {e}")
            return web.json_response({
                "ok": True, "key": key, "value": value,
                "warning": f"Setting saved but hook installation failed: {e}",
            })

    return web.json_response({"ok": True, "key": key, "value": value})


# ─── REST: Safety Gate ────────────────────────────────────────────────────
#
# General-purpose tool call safety engine. Evaluates ALL tool calls against
# configurable rules. Called synchronously by the safety_gate.sh hook script.

import re as _re_safety

_PKG_INSTALL_PAT = _re_safety.compile(
    r'(?:^|\s)(?:sudo\s+)?(?:'
    r'(?:pip3?|python3?\s+-m\s+pip)\s+install'
    r'|(?:npm|yarn|pnpm|bun)\s+(?:install|add|i)\b'
    r'|cargo\s+(?:add|install)\b'
    r'|go\s+(?:get|install)\b'
    r'|gem\s+install\b'
    r'|composer\s+require\b'
    r'|brew\s+install\b'
    r')', _re_safety.I,
)


async def _avcp_scan_inline(command: str, session_id: str, workspace_id: str):
    """Run AVCP scanner inline for package manager commands.

    Returns (decision, reason, packages_list) or None if not a package command.
    """
    if not _PKG_INSTALL_PAT.search(command):
        return None

    import os

    # Reuse the detection/extraction from hooks.py
    try:
        from hooks import _detect_ecosystem, _extract_packages, _detect_install_scripts
    except ImportError:
        return None

    ecosystem = _detect_ecosystem(command)
    if ecosystem == "unknown":
        return None

    packages = _extract_packages(command, ecosystem)
    if not packages:
        return None

    from resource_path import project_root as _pr, is_frozen as _is_frz
    _frozen_avcp = _is_frz()
    if _frozen_avcp:
        scanner_bin = os.path.join(str(_pr()), "bin", "ive-avcp-scanner")
    else:
        scanner_path = os.path.join(str(_pr()), "anti-vibe-code-pwner", "lib", "scanner.py")

    def _run():
        import subprocess
        threshold = int(os.environ.get("AVCP_THRESHOLD", "7"))
        try:
            if _frozen_avcp:
                # In compiled mode, call the binary via subprocess
                import json as _json
                results = []
                for pkg in packages[:10]:
                    try:
                        proc = subprocess.run(
                            [scanner_bin, "--json", ecosystem, pkg, str(threshold)],
                            capture_output=True, text=True, timeout=30,
                        )
                        if proc.returncode == 0 and proc.stdout.strip():
                            results.append(_json.loads(proc.stdout))
                    except Exception:
                        pass
                return results or None
            else:
                # In source mode, import the scanner module directly
                import importlib.util
                spec = importlib.util.spec_from_file_location("avcp_scanner", scanner_path)
                if not spec or not spec.loader:
                    return None
                scanner = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(scanner)
                results = []
                for pkg in packages[:10]:
                    try:
                        r = scanner.full_check(ecosystem, pkg, threshold)
                        r["install_scripts"] = _detect_install_scripts(
                            ecosystem, pkg, r, scanner, subprocess,
                        )
                        results.append(r)
                    except Exception:
                        pass
                return results or None
        except Exception:
            return None

    loop = _asyncio.get_event_loop()
    results = await loop.run_in_executor(None, _run)
    if not results:
        return None

    # Persist scan results to package_scans table
    try:
        d = await get_db()
        try:
            for r in results:
                await d.execute(
                    """INSERT INTO package_scans
                       (session_id, workspace_id, package, ecosystem, version, age_days,
                        status, vuln_count, vuln_critical, known_malware, decision, reason,
                        advisories, install_scripts, llm_verdict, fallback)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        session_id, workspace_id,
                        r.get("package", ""), r.get("ecosystem", ""),
                        r.get("version", ""), r.get("age_days", -1),
                        r.get("status", "ok"), r.get("vuln_count", 0),
                        1 if r.get("vuln_critical") else 0,
                        1 if r.get("known_malware") else 0,
                        r.get("status", "ok"), r.get("reason", ""),
                        json.dumps(r.get("advisories", [])),
                        r.get("install_scripts", ""),
                        r.get("llm_verdict", ""),
                        r.get("fallback", ""),
                    ),
                )
            await d.commit()
        finally:
            await d.close()
    except Exception:
        pass

    # Build decision from results
    flagged = [r for r in results if r.get("status") == "flagged"]
    malware = [r for r in results if r.get("known_malware")]
    has_scripts = [r for r in results if r.get("install_scripts")]

    pkg_summaries = []
    for r in results:
        pkg_summaries.append({
            "package": r.get("package", ""),
            "version": r.get("version", ""),
            "status": r.get("status", "ok"),
            "vuln_count": r.get("vuln_count", 0),
            "vuln_critical": bool(r.get("vuln_critical")),
            "known_malware": bool(r.get("known_malware")),
            "install_scripts": r.get("install_scripts", ""),
            "age_days": r.get("age_days", -1),
            "fallback": r.get("fallback", ""),
        })

    if malware:
        names = ", ".join(r["package"] for r in malware)
        return ("deny", f"AVCP: KNOWN MALWARE detected in {names}. DO NOT INSTALL.", pkg_summaries)
    elif flagged:
        details = []
        for r in flagged:
            d = r["package"]
            if r.get("vuln_critical"):
                d += f" ({r.get('vuln_count', 0)} critical vulns)"
            elif r.get("age_days", -1) >= 0:
                d += f" ({r['age_days']}d old)"
            if r.get("fallback"):
                d += f" [safe: {r['fallback']}]"
            details.append(d)
        return ("deny", f"AVCP: {len(flagged)} package(s) flagged: {'; '.join(details)}", pkg_summaries)
    elif has_scripts:
        # ── Check install-script policy setting ──────────────────────
        block_all_scripts = False
        allowlisted_pkgs = set()
        try:
            _pol_db = await get_db()
            try:
                _cur = await _pol_db.execute(
                    "SELECT value FROM app_settings WHERE key = 'safety_block_install_scripts'"
                )
                _row = await _cur.fetchone()
                if _row and _row["value"] == "true":
                    block_all_scripts = True
                # Load allowlist
                _cur2 = await _pol_db.execute(
                    "SELECT package, ecosystem FROM install_script_allowlist"
                )
                for _alr in await _cur2.fetchall():
                    allowlisted_pkgs.add((_alr["package"], _alr["ecosystem"]))
            finally:
                await _pol_db.close()
        except Exception:
            pass

        # Filter out allowlisted packages
        non_allowed = [r for r in has_scripts
                       if (r["package"], r.get("ecosystem", ecosystem)) not in allowlisted_pkgs]

        if not non_allowed:
            # All packages with scripts are allowlisted — pass through
            pass
        else:
            # ── LLM analysis of install scripts ──────────────────────
            llm_verdict = ""
            try:
                from llm_router import llm_call
                scripts_detail = "\n\n".join(
                    f"Package: {r['package']} ({r.get('ecosystem', ecosystem)})\n"
                    f"Install scripts: {r['install_scripts'][:500]}"
                    for r in non_allowed
                )
                raw = await llm_call(
                    cli="claude", model="haiku",
                    prompt=scripts_detail,
                    system=(
                        "You are a supply chain security analyst. Analyze the following package "
                        "install scripts detected before installation. For each package, determine "
                        "if the install scripts are SAFE (normal build/compile steps), SUSPICIOUS "
                        "(unusual network calls, obfuscation, env var exfiltration), or MALICIOUS "
                        "(known attack patterns, data theft, backdoors).\n\n"
                        "Respond with ONLY a JSON object, no other text:\n"
                        "{\"verdict\": \"safe\"|\"suspicious\"|\"malicious\", "
                        "\"summary\": \"one-line explanation\", \"details\": [\"per-package detail\"]}"
                    ),
                    timeout=120,
                )
                # Extract JSON from response (handle fences + trailing text)
                import re as _re_llm
                _jblob = raw or ""
                if "```" in _jblob:
                    _fence = _re_llm.search(r'```(?:json)?\s*\n(.*?)```', _jblob, _re_llm.S)
                    if _fence:
                        _jblob = _fence.group(1)
                _brace_start = _jblob.find("{")
                _brace_end = _jblob.rfind("}")
                if _brace_start >= 0 and _brace_end > _brace_start:
                    _jblob = _jblob[_brace_start:_brace_end + 1]
                llm_result = json.loads(_jblob)
                llm_verdict = json.dumps(llm_result) if isinstance(llm_result, dict) else str(llm_result)

                # Persist LLM verdict to package_scans rows
                try:
                    _vdb = await get_db()
                    try:
                        for r in non_allowed:
                            await _vdb.execute(
                                "UPDATE package_scans SET llm_verdict = ? WHERE package = ? AND ecosystem = ? "
                                "ORDER BY id DESC LIMIT 1",
                                (llm_verdict, r["package"], r.get("ecosystem", ecosystem)),
                            )
                        await _vdb.commit()
                    finally:
                        await _vdb.close()
                except Exception:
                    pass

                # Use LLM verdict to decide
                verdict_str = llm_result.get("verdict", "").lower() if isinstance(llm_result, dict) else ""
                verdict_summary = llm_result.get("summary", "") if isinstance(llm_result, dict) else ""

                if verdict_str == "malicious":
                    names = ", ".join(r["package"] for r in non_allowed)
                    return ("deny", f"AVCP+LLM: MALICIOUS install scripts in {names} — {verdict_summary}", pkg_summaries)
                elif verdict_str == "suspicious" or block_all_scripts:
                    scripts_info = "; ".join(
                        f"{r['package']}: {r['install_scripts'][:100]}" for r in non_allowed
                    )
                    reason = f"AVCP+LLM: {verdict_summary}" if verdict_summary else f"AVCP: install scripts detected — {scripts_info}"
                    if block_all_scripts and verdict_str == "safe":
                        reason = f"Install scripts blocked by policy — {scripts_info}. LLM says: {verdict_summary}"
                    return ("ask", reason, pkg_summaries)
                # verdict == "safe" and not block_all_scripts → allow
            except Exception as _llm_err:
                # LLM unavailable — fall back to pattern-based decision
                logger.warning("LLM install script analysis failed: %s", _llm_err)
                scripts_info = "; ".join(
                    f"{r['package']}: {r['install_scripts'][:100]}" for r in non_allowed
                )
                if block_all_scripts:
                    return ("ask", f"Install scripts blocked by policy (LLM unavailable) — {scripts_info}", pkg_summaries)
                return ("ask", f"AVCP: install scripts detected — {scripts_info}", pkg_summaries)

    return None  # All clean


async def evaluate_safety(request: web.Request) -> web.Response:
    """POST /api/safety/evaluate — evaluate a tool call against safety rules.

    Called by safety_gate.sh hook script synchronously.
    Fast for normal tool calls (<50ms). Package manager commands take longer (AVCP scan).
    """
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"decision": "allow", "reason": "invalid input"})

    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})
    session_id = data.get("session_id") or ""
    workspace_id = data.get("workspace_id") or ""
    tool_use_id = data.get("tool_use_id") or ""

    # ── Commander delegation guard (always active, not behind feature flag) ─
    # Commander is a triage-and-route dispatcher — it must never implement,
    # plan, or run shell. The CLI's --disallowedTools flag is the primary
    # enforcement, set in create_commander; this is defense-in-depth in case
    # a legacy row is missing the deny-list, or a subagent inherits less
    # restrictively. Returning "deny" here surfaces a redirect message that
    # tells Commander exactly which MCP tools to use instead.
    _COMMANDER_BLOCKED = {
        "Edit", "Write", "MultiEdit", "NotebookEdit",
        "edit_file", "write_file", "Bash", "execute", "execute_command",
        # Native subagent dispatch — must go through MCP create_session instead
        # so spawned sessions are real, observable IVE workers/planners. This is
        # the primary enforcement for Gemini Commander (no --disallowedTools).
        "Task", "Agent", "Spawn",
    }
    if session_id and tool_name in _COMMANDER_BLOCKED:
        try:
            _db_cmdr = await get_db()
            try:
                _cur = await _db_cmdr.execute(
                    "SELECT session_type FROM sessions WHERE id = ?",
                    (session_id,),
                )
                _sess = await _cur.fetchone()
                if _sess and _sess["session_type"] == "commander":
                    return web.json_response({
                        "decision": "deny",
                        "reason": (
                            f"Commander cannot use {tool_name}. You are an "
                            "orchestrator: delegate to a worker via "
                            "create_session/assign_task_to_worker, send the "
                            "task with send_message, and monitor with "
                            "read_session_output / list_worker_digests. "
                            "If a worker is failing, escalate_worker."
                        ),
                    })
            finally:
                await _db_cmdr.close()
        except Exception as _e:
            logger.debug("Commander delegation guard check failed: %s", _e)

    # ── Documentor path guard (always active, not behind feature flag) ───
    # Documentor sessions can only write to docs-related paths unless
    # the "unrestricted_edit" tag is set (user opted in at creation).
    # Writes outside docs/ get "ask" so the user must confirm.
    if session_id and tool_name in ("Write", "Edit", "write_file", "edit_file"):
        file_path = tool_input.get("file_path", "")
        if file_path:
            try:
                _db_guard = await get_db()
                try:
                    _cur = await _db_guard.execute(
                        "SELECT session_type, workspace_id, tags FROM sessions WHERE id = ?",
                        (session_id,),
                    )
                    _sess = await _cur.fetchone()
                    if _sess and _sess["session_type"] == "documentor":
                        # Skip guard if user opted in to unrestricted edits
                        _tags = json.loads(_sess["tags"] or "[]") if _sess["tags"] else []
                        if "unrestricted_edit" not in _tags:
                            _cur2 = await _db_guard.execute(
                                "SELECT path FROM workspaces WHERE id = ?",
                                (_sess["workspace_id"],),
                            )
                            _ws = await _cur2.fetchone()
                            ws_path = _ws["path"] if _ws else ""
                            import os as _os_guard
                            abs_file = _os_guard.path.abspath(file_path)
                            docs_root = _os_guard.path.abspath(_os_guard.path.join(ws_path, "docs"))
                            is_docs = abs_file.startswith(docs_root + _os_guard.sep) or abs_file == docs_root
                            is_safe = _os_guard.path.basename(abs_file).lower() in (
                                "plan.md", "docs_manifest.json", "package.json", "package-lock.json",
                            )
                            if not is_docs and not is_safe:
                                return web.json_response({
                                    "decision": "ask",
                                    "reason": (
                                        f"Documentor wants to edit {_os_guard.path.basename(file_path)} "
                                        f"which is outside docs/. Allow?"
                                    ),
                                })
                finally:
                    await _db_guard.close()
            except Exception as _e:
                logger.debug("Documentor path guard check failed: %s", _e)

    # Check if feature is enabled
    db = await get_db()
    try:
        cur = await db.execute("SELECT value FROM app_settings WHERE key = 'experimental_safety_gate'")
        row = await cur.fetchone()
        if not row or row["value"] != "on":
            return web.json_response({"decision": "allow", "reason": "safety gate disabled"})
    finally:
        await db.close()

    from safety_engine import evaluate, init_cache, _extract_match_field

    # Ensure cache is initialized with DB loader
    async def _load_rules():
        d = await get_db()
        try:
            cur = await d.execute("SELECT * FROM safety_rules")
            return await cur.fetchall()
        finally:
            await d.close()

    init_cache(_load_rules)

    result = await evaluate(tool_name, tool_input, workspace_id=workspace_id or None)

    # ── AVCP package scanning (inline, blocks before install) ─────────
    # Only run if the regular rules didn't already deny, and it's a Bash command
    if result.action != "deny" and tool_name in ("Bash", "execute", "execute_command"):
        command = tool_input.get("command", "") or tool_input.get("script", "")
        if command:
            avcp_result = await _avcp_scan_inline(command, session_id, workspace_id)
            if avcp_result:
                # Override the decision if AVCP flagged something
                avcp_decision, avcp_reason, avcp_packages = avcp_result
                if avcp_decision in ("deny", "ask"):
                    result.action = avcp_decision
                    result.reason = avcp_reason
                    # Notify UI about flagged packages
                    _asyncio.ensure_future(bus.emit(
                        CommanderEvent.SAFETY_RULE_TRIGGERED,
                        {
                            "rule_id": "avcp_package_scan",
                            "rule_name": "AVCP Package Scan",
                            "severity": "high" if avcp_decision == "deny" else "medium",
                            "tool_name": tool_name,
                            "decision": avcp_decision,
                            "reason": avcp_reason,
                            "session_id": session_id,
                            "workspace_id": workspace_id,
                            "packages": avcp_packages,
                        },
                    ))

    # Log decision asynchronously if rule matched or decision is not allow
    if result.action != "allow" or result.rule_id:
        async def _log():
            try:
                from safety_learning import log_decision
                # Use matched_input as summary — it's the exact field the rule
                # matched against, so approval lookups correlate correctly.
                summary = result.matched_input or _extract_match_field(tool_name, tool_input)
                d = await get_db()
                try:
                    await log_decision(
                        d,
                        tool_use_id=tool_use_id or None,
                        session_id=session_id or None,
                        workspace_id=workspace_id or None,
                        tool_name=tool_name,
                        tool_input_summary=summary,
                        decision=result.action,
                        reason=result.reason,
                        matched_rule_id=result.rule_id,
                        latency_ms=result.latency_ms,
                    )
                finally:
                    await d.close()
            except Exception as e:
                logger.warning("Failed to log safety decision: %s", e)

        _asyncio.ensure_future(_log())

    # Emit event if rule triggered
    if result.rule_id:
        _asyncio.ensure_future(bus.emit(
            CommanderEvent.SAFETY_RULE_TRIGGERED,
            {
                "rule_id": result.rule_id,
                "rule_name": result.rule_name,
                "severity": result.severity,
                "tool_name": tool_name,
                "decision": result.action,
                "session_id": session_id,
                "workspace_id": workspace_id,
            },
        ))

    # ── Auto-mode override ──────────────────────────────────────────────
    # When no destructive rule matched (action stayed 'allow'), upgrade to
    # 'allow_auto' for sessions whose stored permission_mode is 'auto'. The
    # hook script translates 'allow_auto' into an explicit
    # `permissionDecision: "allow"` so Claude Code skips its native first-
    # tool-call menu. Sessions on 'default' get a normal 'allow' (exit 0,
    # pass through) so Claude's native gating still prompts the user as
    # they intended.
    if result.action == "allow" and session_id:
        try:
            db_mode = await get_db()
            try:
                cur = await db_mode.execute(
                    "SELECT permission_mode FROM sessions WHERE id = ?",
                    (session_id,),
                )
                row = await cur.fetchone()
                if row and (row["permission_mode"] or "").lower() == "auto":
                    return web.json_response({
                        "decision": "allow_auto",
                        "reason": "auto mode + no destructive rule matched",
                        "rule_id": None,
                        "latency_ms": result.latency_ms,
                    })
            finally:
                await db_mode.close()
        except Exception:
            pass  # fall through to plain allow

    return web.json_response({
        "decision": result.action,
        "reason": result.reason,
        "rule_id": result.rule_id,
        "latency_ms": result.latency_ms,
    })


async def list_safety_rules(request: web.Request) -> web.Response:
    """GET /api/safety/rules — list all safety rules."""
    workspace_id = request.query.get("workspace_id")
    db = await get_db()
    try:
        if workspace_id:
            cur = await db.execute(
                "SELECT * FROM safety_rules WHERE workspace_id IS NULL OR workspace_id = ? ORDER BY severity, name",
                (workspace_id,),
            )
        else:
            cur = await db.execute("SELECT * FROM safety_rules ORDER BY severity, name")
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


async def create_safety_rule(request: web.Request) -> web.Response:
    """POST /api/safety/rules — create a custom safety rule."""
    body = await request.json()
    name = (body.get("name") or "").strip()
    pattern = (body.get("pattern") or "").strip()
    if not name or not pattern:
        return web.json_response({"error": "name and pattern required"}, status=400)

    # Validate regex
    import re
    try:
        re.compile(pattern)
    except re.error as e:
        return web.json_response({"error": f"Invalid regex: {e}"}, status=400)

    rule_id = str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO safety_rules
               (id, name, description, category, severity, tool_match,
                pattern, pattern_field, action, enabled, is_builtin, workspace_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)""",
            (
                rule_id,
                name,
                body.get("description", ""),
                body.get("category", "custom"),
                body.get("severity", "medium"),
                body.get("tool_match", "Bash"),
                pattern,
                body.get("pattern_field", ""),
                body.get("action", "ask"),
                1 if body.get("enabled", True) else 0,
                body.get("workspace_id"),
            ),
        )
        await db.commit()
        from safety_engine import invalidate_cache
        invalidate_cache()
        return web.json_response({"ok": True, "id": rule_id})
    finally:
        await db.close()


async def update_safety_rule(request: web.Request) -> web.Response:
    """PUT /api/safety/rules/{id} — update a safety rule."""
    rule_id = request.match_info["id"]
    body = await request.json()
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM safety_rules WHERE id = ?", (rule_id,))
        existing = await cur.fetchone()
        if not existing:
            return web.json_response({"error": "rule not found"}, status=404)

        # Validate regex if pattern changed
        pattern = body.get("pattern", existing["pattern"])
        if pattern != existing["pattern"]:
            import re
            try:
                re.compile(pattern)
            except re.error as e:
                return web.json_response({"error": f"Invalid regex: {e}"}, status=400)

        await db.execute(
            """UPDATE safety_rules SET
                name = ?, description = ?, category = ?, severity = ?,
                tool_match = ?, pattern = ?, pattern_field = ?, action = ?,
                enabled = ?, workspace_id = ?, updated_at = datetime('now')
               WHERE id = ?""",
            (
                body.get("name", existing["name"]),
                body.get("description", existing["description"]),
                body.get("category", existing["category"]),
                body.get("severity", existing["severity"]),
                body.get("tool_match", existing["tool_match"]),
                pattern,
                body.get("pattern_field", existing["pattern_field"]),
                body.get("action", existing["action"]),
                1 if body.get("enabled", bool(existing["enabled"])) else 0,
                body.get("workspace_id", existing["workspace_id"]),
                rule_id,
            ),
        )
        await db.commit()
        from safety_engine import invalidate_cache
        invalidate_cache()
        return web.json_response({"ok": True})
    finally:
        await db.close()


async def delete_safety_rule(request: web.Request) -> web.Response:
    """DELETE /api/safety/rules/{id} — delete a custom rule (builtins cannot be deleted)."""
    rule_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("SELECT is_builtin FROM safety_rules WHERE id = ?", (rule_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "rule not found"}, status=404)
        if row["is_builtin"]:
            return web.json_response({"error": "cannot delete builtin rules — disable instead"}, status=400)
        await db.execute("DELETE FROM safety_rules WHERE id = ?", (rule_id,))
        await db.commit()
        from safety_engine import invalidate_cache
        invalidate_cache()
        return web.json_response({"ok": True})
    finally:
        await db.close()


async def seed_safety_rules(request: web.Request) -> web.Response:
    """POST /api/safety/rules/seed — reset builtin rules to defaults."""
    db = await get_db()
    try:
        from safety_engine import seed_builtin_rules
        await seed_builtin_rules(db)
        return web.json_response({"ok": True})
    finally:
        await db.close()


async def get_external_access_log(request: web.Request) -> web.Response:
    """GET /api/safety/access-log — compliance log of all external sources accessed."""
    session_id = request.query.get("session_id")
    workspace_id = request.query.get("workspace_id")
    domain = request.query.get("domain")
    source_type = request.query.get("source_type")
    limit = min(int(request.query.get("limit", "200")), 1000)
    offset = int(request.query.get("offset", "0"))

    where_parts = []
    params: list = []
    if session_id:
        where_parts.append("session_id = ?")
        params.append(session_id)
    if workspace_id:
        where_parts.append("workspace_id = ?")
        params.append(workspace_id)
    if domain:
        where_parts.append("domain = ?")
        params.append(domain)
    if source_type:
        where_parts.append("source_type = ?")
        params.append(source_type)

    where = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
    db = await get_db()
    try:
        cur = await db.execute(
            f"SELECT * FROM external_access_log {where} ORDER BY id DESC LIMIT ? OFFSET ?",
            params + [limit, offset],
        )
        rows = await cur.fetchall()
        # Also return unique domain counts for summary
        cur2 = await db.execute(
            f"SELECT domain, COUNT(*) as count FROM external_access_log {where} GROUP BY domain ORDER BY count DESC LIMIT 50",
            params,
        )
        domains = await cur2.fetchall()
        return web.json_response({
            "entries": [dict(r) for r in rows],
            "domains": [dict(d) for d in domains],
        })
    finally:
        await db.close()


async def get_command_log(request: web.Request) -> web.Response:
    """GET /api/safety/command-log — all commands executed by agents."""
    session_id = request.query.get("session_id")
    workspace_id = request.query.get("workspace_id")
    q = request.query.get("q", "")
    limit = min(int(request.query.get("limit", "200")), 1000)
    offset = int(request.query.get("offset", "0"))

    where_parts = []
    params: list = []
    if session_id:
        where_parts.append("session_id = ?")
        params.append(session_id)
    if workspace_id:
        where_parts.append("workspace_id = ?")
        params.append(workspace_id)
    if q:
        where_parts.append("command LIKE ?")
        params.append(f"%{q}%")

    where = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
    db = await get_db()
    try:
        cur = await db.execute(
            f"SELECT * FROM command_log {where} ORDER BY id DESC LIMIT ? OFFSET ?",
            params + [limit, offset],
        )
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


async def get_package_scans(request: web.Request) -> web.Response:
    """GET /api/safety/package-scans — AVCP package scan results."""
    session_id = request.query.get("session_id")
    workspace_id = request.query.get("workspace_id")
    limit = min(int(request.query.get("limit", "200")), 1000)
    offset = int(request.query.get("offset", "0"))

    where_parts = []
    params: list = []
    if session_id:
        where_parts.append("session_id = ?")
        params.append(session_id)
    if workspace_id:
        where_parts.append("workspace_id = ?")
        params.append(workspace_id)

    where = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
    db = await get_db()
    try:
        cur = await db.execute(
            f"SELECT * FROM package_scans {where} ORDER BY id DESC LIMIT ? OFFSET ?",
            params + [limit, offset],
        )
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


async def post_avcp_result(request: web.Request) -> web.Response:
    """POST /api/safety/avcp-result — receive AVCP scan results from hooks."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)

    session_id = data.get("session_id", "")
    workspace_id = data.get("workspace_id", "")
    packages = data.get("packages", [])
    decision = data.get("decision", "allow")
    reason = data.get("reason", "")
    install_scripts = data.get("install_scripts", "")

    if not packages:
        return web.json_response({"ok": True, "stored": 0})

    db = await get_db()
    try:
        for pkg in packages:
            await db.execute(
                """INSERT INTO package_scans
                   (session_id, workspace_id, package, ecosystem, version, age_days,
                    status, vuln_count, vuln_critical, known_malware, decision, reason,
                    advisories, install_scripts, fallback)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    session_id, workspace_id,
                    pkg.get("package", ""),
                    pkg.get("ecosystem", ""),
                    pkg.get("version", ""),
                    pkg.get("age_days", -1),
                    pkg.get("status", "ok"),
                    pkg.get("vuln_count", 0),
                    1 if pkg.get("vuln_critical") else 0,
                    1 if pkg.get("known_malware") else 0,
                    decision,
                    reason[:1000] if reason else "",
                    json.dumps(pkg.get("advisories", [])),
                    install_scripts[:2000] if install_scripts else "",
                    pkg.get("fallback", ""),
                ),
            )
        await db.commit()
        return web.json_response({"ok": True, "stored": len(packages)})
    finally:
        await db.close()


async def get_install_script_policy(request: web.Request) -> web.Response:
    """GET /api/safety/install-script-policy — get policy setting + allowlist."""
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT value FROM app_settings WHERE key = 'safety_block_install_scripts'"
        )
        row = await cur.fetchone()
        block_all = row["value"] == "true" if row else False

        cur2 = await db.execute(
            "SELECT * FROM install_script_allowlist ORDER BY created_at DESC"
        )
        allowlist = [dict(r) for r in await cur2.fetchall()]
        return web.json_response({"block_all": block_all, "allowlist": allowlist})
    finally:
        await db.close()


async def put_install_script_policy(request: web.Request) -> web.Response:
    """PUT /api/safety/install-script-policy — toggle block-all setting."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)

    block_all = bool(data.get("block_all", False))
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO app_settings (key, value) VALUES ('safety_block_install_scripts', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
            ("true" if block_all else "false",),
        )
        await db.commit()
        return web.json_response({"ok": True, "block_all": block_all})
    finally:
        await db.close()


async def add_install_script_allowlist(request: web.Request) -> web.Response:
    """POST /api/safety/install-script-allowlist — allowlist a package."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)

    package = data.get("package", "").strip()
    ecosystem = data.get("ecosystem", "").strip()
    reason = data.get("reason", "").strip()
    if not package or not ecosystem:
        return web.json_response({"error": "package and ecosystem required"}, status=400)

    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO install_script_allowlist (package, ecosystem, reason) VALUES (?, ?, ?) "
            "ON CONFLICT(package, ecosystem) DO UPDATE SET reason = excluded.reason",
            (package, ecosystem, reason),
        )
        await db.commit()
        return web.json_response({"ok": True, "package": package, "ecosystem": ecosystem})
    finally:
        await db.close()


async def remove_install_script_allowlist(request: web.Request) -> web.Response:
    """DELETE /api/safety/install-script-allowlist/{id} — remove from allowlist."""
    entry_id = request.match_info["id"]
    db = await get_db()
    try:
        await db.execute("DELETE FROM install_script_allowlist WHERE id = ?", (entry_id,))
        await db.commit()
        return web.json_response({"ok": True})
    finally:
        await db.close()


async def get_safety_decisions(request: web.Request) -> web.Response:
    """GET /api/safety/decisions — query the decision audit log."""
    session_id = request.query.get("session_id")
    workspace_id = request.query.get("workspace_id")
    limit = min(int(request.query.get("limit", "100")), 500)
    offset = int(request.query.get("offset", "0"))

    where_parts = []
    params: list = []
    if session_id:
        where_parts.append("session_id = ?")
        params.append(session_id)
    if workspace_id:
        where_parts.append("workspace_id = ?")
        params.append(workspace_id)

    where = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
    db = await get_db()
    try:
        cur = await db.execute(
            f"SELECT * FROM safety_decisions {where} ORDER BY id DESC LIMIT ? OFFSET ?",
            params + [limit, offset],
        )
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


async def get_safety_proposals(request: web.Request) -> web.Response:
    """GET /api/safety/proposals — get proposed rules from decision analysis."""
    workspace_id = request.query.get("workspace_id")
    db = await get_db()
    try:
        from safety_learning import analyze_patterns
        proposals = await analyze_patterns(db, workspace_id=workspace_id)
        return web.json_response([
            {
                "id": p.id,
                "tool_name": p.tool_name,
                "pattern_summary": p.pattern_summary,
                "suggested_pattern": p.suggested_pattern,
                "suggested_action": p.suggested_action,
                "sample_count": p.sample_count,
                "approve_count": p.approve_count,
                "deny_count": p.deny_count,
                "consistency": p.consistency,
                "confidence": p.confidence,
            }
            for p in proposals
        ])
    finally:
        await db.close()


async def accept_safety_proposal(request: web.Request) -> web.Response:
    """POST /api/safety/proposals/{id}/accept — accept a proposal and create a rule."""
    body = await request.json()
    rule_id = str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO safety_rules
               (id, name, description, category, severity, tool_match,
                pattern, pattern_field, action, enabled, is_builtin, workspace_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)""",
            (
                rule_id,
                body.get("name", "Learned rule"),
                body.get("description", body.get("pattern_summary", "")),
                "custom",
                "low",
                body.get("tool_name", "Bash"),
                body.get("pattern", ""),
                "",
                body.get("action", "allow"),
                body.get("workspace_id"),
            ),
        )
        await db.commit()
        from safety_engine import invalidate_cache
        invalidate_cache()

        await bus.emit(CommanderEvent.SAFETY_RULE_LEARNED, {
            "rule_id": rule_id,
            "pattern": body.get("pattern", ""),
            "action": body.get("action", "allow"),
        })

        return web.json_response({"ok": True, "rule_id": rule_id})
    finally:
        await db.close()


async def dismiss_safety_proposal(request: web.Request) -> web.Response:
    """POST /api/safety/proposals/{id}/dismiss — dismiss a proposal."""
    proposal_id = request.match_info["id"]
    from safety_learning import dismiss_proposal
    dismiss_proposal(proposal_id)
    return web.json_response({"ok": True})


async def report_safety_approved(request: web.Request) -> web.Response:
    """POST /api/safety/approved — report that a user approved an ask decision.

    Called by safety_gate_post.sh (PostToolUse hook).  Looks up the rule
    that triggered the ask and remembers it so it auto-allows next time.
    """
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"ok": False})

    tool_use_id = data.get("tool_use_id", "")
    if not tool_use_id:
        return web.json_response({"ok": False})

    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT matched_rule_id, tool_input_summary FROM safety_decisions WHERE tool_use_id = ? AND decision = 'ask'",
            (tool_use_id,),
        )
        row = await cur.fetchone()
        if row and row["matched_rule_id"] and row["tool_input_summary"]:
            from safety_engine import remember_approval
            remember_approval(row["matched_rule_id"], row["tool_input_summary"])
            # Also record user response for the learning system
            from safety_learning import record_user_response
            await record_user_response(db, tool_use_id, "approved")
    except Exception as e:
        logger.debug("Safety approval report failed: %s", e)
    finally:
        await db.close()

    return web.json_response({"ok": True})


async def get_safety_status(request: web.Request) -> web.Response:
    """GET /api/safety/status — check safety gate installation and status."""
    from hook_installer import check_safety_gate_installation
    installation = check_safety_gate_installation()

    db = await get_db()
    try:
        cur = await db.execute("SELECT value FROM app_settings WHERE key = 'experimental_safety_gate'")
        row = await cur.fetchone()
        enabled = row["value"] == "on" if row else False

        cur = await db.execute("SELECT COUNT(*) as cnt FROM safety_rules WHERE enabled = 1")
        rule_count = (await cur.fetchone())["cnt"]

        cur = await db.execute("SELECT COUNT(*) as cnt FROM safety_decisions")
        decision_count = (await cur.fetchone())["cnt"]

        return web.json_response({
            "enabled": enabled,
            "installation": installation,
            "rule_count": rule_count,
            "decision_count": decision_count,
        })
    finally:
        await db.close()


# ─── REST: Prompt Cascades ────────────────────────────────────────────────
#
# ── Pipeline Engine API (configurable graph pipelines) ────────────────

async def list_pipeline_definitions(request: web.Request) -> web.Response:
    import pipeline_engine
    workspace_id = request.query.get("workspace_id")
    defs = await pipeline_engine.list_definitions(workspace_id)
    return web.json_response(defs)


async def create_pipeline_definition(request: web.Request) -> web.Response:
    import pipeline_engine
    body = await request.json()
    defn = await pipeline_engine.create_definition(body)
    return web.json_response(defn, status=201)


async def get_pipeline_definition(request: web.Request) -> web.Response:
    import pipeline_engine
    pid = request.match_info["id"]
    defn = await pipeline_engine.get_definition(pid)
    if not defn:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response(defn)


async def update_pipeline_definition(request: web.Request) -> web.Response:
    import pipeline_engine
    pid = request.match_info["id"]
    body = await request.json()
    defn = await pipeline_engine.update_definition(pid, body)
    if not defn:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response(defn)


async def delete_pipeline_definition(request: web.Request) -> web.Response:
    import pipeline_engine
    pid = request.match_info["id"]
    ok = await pipeline_engine.delete_definition(pid)
    if not ok:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response({"ok": True})


async def list_pipeline_runs(request: web.Request) -> web.Response:
    import pipeline_engine
    workspace_id = request.query.get("workspace_id")
    pipeline_id = request.query.get("pipeline_id")
    # Accept "1", "true", "yes", "on" — previously only literal "1" worked
    # so ?active=true silently returned every run (BUG M2).
    active_only = (request.query.get("active") or "").strip().lower() in ("1", "true", "yes", "on")
    runs = await pipeline_engine.list_runs(workspace_id, pipeline_id, active_only)
    return web.json_response(runs)


async def start_pipeline_run(request: web.Request) -> web.Response:
    import pipeline_engine
    body = await request.json()
    pipeline_id = body.get("pipeline_id")
    if not pipeline_id:
        return web.json_response({"error": "pipeline_id required"}, status=400)
    pipeline = await pipeline_engine.get_definition(pipeline_id)
    if not pipeline:
        return web.json_response({"error": f"pipeline not found: {pipeline_id}"}, status=404)
    try:
        run = await pipeline_engine.start_run(
            pipeline_id,
            workspace_id=body.get("workspace_id"),
            task_id=body.get("task_id"),
            variables=body.get("variables"),
            trigger_type=body.get("trigger_type", "manual"),
        )
    except pipeline_engine.PipelineVariableError as e:
        return web.json_response({"error": str(e), "missing": e.missing}, status=400)
    if not run:
        return web.json_response({"error": "failed to start"}, status=400)
    return web.json_response(run, status=201)


async def get_pipeline_run(request: web.Request) -> web.Response:
    import pipeline_engine
    run_id = request.match_info["id"]
    run = await pipeline_engine.get_run(run_id)
    if not run:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response(run)


async def update_pipeline_run(request: web.Request) -> web.Response:
    import pipeline_engine
    run_id = request.match_info["id"]
    body = await request.json()
    action = body.get("action")
    if action == "pause":
        run = await pipeline_engine.pause_run(run_id)
    elif action == "resume":
        run = await pipeline_engine.resume_run(run_id)
    elif action == "cancel":
        run = await pipeline_engine.cancel_run(run_id)
    else:
        return web.json_response({"error": f"unknown action: {action}"}, status=400)
    if not run:
        return web.json_response({"error": "not found"}, status=404)
    # BUG M11: pause/resume previously returned 200 with stale state when
    # the run was already terminal. Surface that as 409 so callers can
    # distinguish ignored from succeeded.
    if isinstance(run, dict) and (run.pop("_pause_no_op", False) or run.pop("_resume_no_op", False)):
        return web.json_response(
            {"error": f"cannot {action}: run is in {run.get('status')} state", "run": run},
            status=409,
        )
    return web.json_response(run)


async def delete_pipeline_run(request: web.Request) -> web.Response:
    """DELETE /api/pipeline-runs/{id} — BUG M3. Cascade runs already had a
    DELETE route; pipeline runs accumulated forever. Cancels in-flight
    state before deletion."""
    import pipeline_engine
    run_id = request.match_info["id"]
    ok = await pipeline_engine.delete_run(run_id)
    if not ok:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response({"ok": True})


async def start_ralph_pipeline(request: web.Request) -> web.Response:
    """POST /api/pipeline-runs/ralph — quick-start a RALPH pipeline from @ralph token."""
    import pipeline_engine
    body = await request.json()
    session_id = body.get("session_id")
    task = body.get("task", "").strip()
    if not session_id or not task:
        return web.json_response({"error": "session_id and task required"}, status=400)
    run = await pipeline_engine.start_ralph(session_id, task, body.get("workspace_id"))
    if not run:
        return web.json_response({"error": "failed to start RALPH pipeline"}, status=400)
    return web.json_response(run, status=201)


# Cascades are ordered sequences of prompts. The runner lives on the frontend
# (watches session status → sends next prompt when idle). Backend is storage.

def _normalize_cascade_steps(raw):
    """Parse steps from DB, handling double-encoded JSON and object-format steps."""
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    # Handle double-encoded JSON (string instead of list)
    if isinstance(parsed, str):
        try:
            parsed = json.loads(parsed)
        except (json.JSONDecodeError, TypeError):
            return [parsed]
    if not isinstance(parsed, list):
        return []
    # Normalize object-format steps {prompt: "..."} to plain strings
    result = []
    for step in parsed:
        if isinstance(step, dict):
            result.append(step.get("prompt", str(step)))
        elif isinstance(step, str):
            result.append(step)
        else:
            result.append(str(step))
    return result


async def list_cascades(request: web.Request) -> web.Response:
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT * FROM cascades ORDER BY usage_count DESC, name"
        )
        rows = await cur.fetchall()
        results = []
        for row in rows:
            d = dict(row)
            d["steps"] = _normalize_cascade_steps(d.get("steps"))
            try:
                d["variables"] = json.loads(d["variables"]) if d.get("variables") else []
            except (json.JSONDecodeError, TypeError):
                d["variables"] = []
            results.append(d)
        return web.json_response(results)
    finally:
        await db.close()


async def create_cascade(request: web.Request) -> web.Response:
    body = await request.json()
    name = (body.get("name") or "").strip()
    steps = body.get("steps") or []
    if not name or not steps:
        return web.json_response(
            {"error": "name and steps (non-empty array) required"}, status=400
        )

    cascade_id = str(uuid.uuid4())
    db = await get_db()
    try:
        variables = body.get("variables", [])
        await db.execute(
            """INSERT INTO cascades (id, name, steps, loop, auto_approve, bypass_permissions, auto_approve_plan, variables, loop_reprompt)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (cascade_id, name, json.dumps(steps),
             1 if body.get("loop") else 0,
             1 if body.get("auto_approve") else 0,
             1 if body.get("bypass_permissions") else 0,
             1 if body.get("auto_approve_plan") else 0,
             json.dumps(variables),
             1 if body.get("loop_reprompt") else 0),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM cascades WHERE id = ?", (cascade_id,))
        row = await cur.fetchone()
        d = dict(row)
        d["steps"] = _normalize_cascade_steps(d.get("steps"))
        try:
            d["variables"] = json.loads(d["variables"]) if d.get("variables") else []
        except (json.JSONDecodeError, TypeError):
            d["variables"] = []
        return web.json_response(d, status=201)
    finally:
        await db.close()


async def update_cascade(request: web.Request) -> web.Response:
    cascade_id = request.match_info["id"]
    body = await request.json()
    db = await get_db()
    try:
        fields, values = [], []
        if "name" in body:
            fields.append("name = ?")
            values.append(body["name"])
        if "steps" in body:
            fields.append("steps = ?")
            values.append(json.dumps(body["steps"]))
        if "loop" in body:
            fields.append("loop = ?")
            values.append(1 if body["loop"] else 0)
        if "auto_approve" in body:
            fields.append("auto_approve = ?")
            values.append(1 if body["auto_approve"] else 0)
        if "bypass_permissions" in body:
            fields.append("bypass_permissions = ?")
            values.append(1 if body["bypass_permissions"] else 0)
        if "auto_approve_plan" in body:
            fields.append("auto_approve_plan = ?")
            values.append(1 if body["auto_approve_plan"] else 0)
        if "variables" in body:
            fields.append("variables = ?")
            values.append(json.dumps(body["variables"]))
        if "loop_reprompt" in body:
            fields.append("loop_reprompt = ?")
            values.append(1 if body["loop_reprompt"] else 0)
        if not fields:
            return web.json_response({"error": "no fields"}, status=400)
        fields.append("updated_at = datetime('now')")
        values.append(cascade_id)
        await db.execute(
            f"UPDATE cascades SET {', '.join(fields)} WHERE id = ?", values
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM cascades WHERE id = ?", (cascade_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "not found"}, status=404)
        d = dict(row)
        d["steps"] = _normalize_cascade_steps(d.get("steps"))
        try:
            d["variables"] = json.loads(d["variables"]) if d.get("variables") else []
        except (json.JSONDecodeError, TypeError):
            d["variables"] = []
        return web.json_response(d)
    finally:
        await db.close()


async def delete_cascade(request: web.Request) -> web.Response:
    cascade_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute("DELETE FROM cascades WHERE id = ?", (cascade_id,))
        await db.commit()
        if cur.rowcount == 0:
            return web.json_response({"error": "cascade not found"}, status=404)
        return web.json_response({"ok": True})
    finally:
        await db.close()


async def use_cascade(request: web.Request) -> web.Response:
    """Increment usage count when a cascade is run. Frontend calls this
    when starting a cascade so the most-used ones sort to the top."""
    cascade_id = request.match_info["id"]
    db = await get_db()
    try:
        await db.execute(
            "UPDATE cascades SET usage_count = usage_count + 1 WHERE id = ?",
            (cascade_id,),
        )
        await db.commit()
        return web.json_response({"ok": True})
    finally:
        await db.close()


# ─── REST: Cascade runs (server-side execution) ─────────────────────────


async def list_cascade_runs(request: web.Request) -> web.Response:
    """GET /api/cascade-runs — list runs, optionally filtered by session."""
    import cascade_runner
    session_id = request.query.get("session")
    # Accept "1", "true", "yes", "on" — previously only literal "1" worked
    # so ?active=true silently returned every run (BUG M2).
    active_only = (request.query.get("active") or "").strip().lower() in ("1", "true", "yes", "on")
    runs = await cascade_runner.list_runs(session_id=session_id, active_only=active_only)
    return web.json_response(runs)


async def create_cascade_run(request: web.Request) -> web.Response:
    """POST /api/cascade-runs — start a server-side cascade run."""
    import cascade_runner
    body = await request.json()
    session_id = body.get("session_id")
    if not session_id:
        return web.json_response({"error": "session_id required"}, status=400)

    steps = body.get("steps", [])
    if not steps:
        return web.json_response({"error": "steps required"}, status=400)

    # Track usage if cascade_id provided
    cascade_id = body.get("cascade_id")
    if cascade_id:
        db = await get_db()
        try:
            await db.execute(
                "UPDATE cascades SET usage_count = usage_count + 1 WHERE id = ?",
                (cascade_id,),
            )
            await db.commit()
        finally:
            await db.close()

    run = await cascade_runner.start_run(
        session_id,
        cascade_id=cascade_id,
        steps=steps,
        original_steps=body.get("original_steps"),
        loop=bool(body.get("loop")),
        auto_approve=bool(body.get("auto_approve")),
        bypass_permissions=bool(body.get("bypass_permissions")),
        auto_approve_plan=bool(body.get("auto_approve_plan")),
        variables=body.get("variables"),
        variable_values=body.get("variable_values"),
        loop_reprompt=bool(body.get("loop_reprompt")),
    )
    return web.json_response(run)


async def get_cascade_run(request: web.Request) -> web.Response:
    """GET /api/cascade-runs/:id — get a specific run."""
    import cascade_runner
    run = await cascade_runner.get_run(request.match_info["id"])
    if not run:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response(run)


async def update_cascade_run(request: web.Request) -> web.Response:
    """PUT /api/cascade-runs/:id — pause, resume, stop, or resume with variables."""
    import cascade_runner
    run_id = request.match_info["id"]
    body = await request.json()
    action = body.get("action")

    if action == "pause":
        run = await cascade_runner.pause_run(run_id)
    elif action == "resume":
        run = await cascade_runner.resume_run(run_id)
    elif action == "stop":
        run = await cascade_runner.stop_run(run_id)
    elif action == "resume_with_variables":
        values = body.get("variable_values", {})
        run = await cascade_runner.resume_with_variables(run_id, values)
    else:
        return web.json_response({"error": f"unknown action: {action}"}, status=400)

    if not run:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response(run)


async def delete_cascade_run(request: web.Request) -> web.Response:
    """DELETE /api/cascade-runs/:id — stop and remove a run."""
    import cascade_runner
    run_id = request.match_info["id"]
    await cascade_runner.stop_run(run_id)
    db = await get_db()
    try:
        await db.execute("DELETE FROM cascade_runs WHERE id = ?", (run_id,))
        await db.commit()
    finally:
        await db.close()
    return web.json_response({"ok": True})


# ─── REST: Broadcast groups ──────────────────────────────────────────────


async def list_broadcast_groups(request: web.Request) -> web.Response:
    workspace_id = request.query.get("workspace")
    db = await get_db()
    try:
        if workspace_id:
            cur = await db.execute(
                "SELECT * FROM broadcast_groups WHERE workspace_id = ? ORDER BY name",
                (workspace_id,),
            )
        else:
            cur = await db.execute(
                "SELECT * FROM broadcast_groups ORDER BY name"
            )
        rows = await cur.fetchall()
        results = []
        for row in rows:
            d = dict(row)
            try:
                d["session_ids"] = json.loads(d["session_ids"]) if d["session_ids"] else []
            except (json.JSONDecodeError, TypeError):
                d["session_ids"] = []
            results.append(d)
        return web.json_response(results)
    finally:
        await db.close()


async def create_broadcast_group(request: web.Request) -> web.Response:
    body = await request.json()
    name = (body.get("name") or "").strip()
    session_ids = body.get("session_ids") or []
    if not name or not session_ids:
        return web.json_response(
            {"error": "name and session_ids (non-empty array) required"}, status=400
        )

    group_id = str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO broadcast_groups (id, name, session_ids, workspace_id)
               VALUES (?, ?, ?, ?)""",
            (group_id, name, json.dumps(session_ids), body.get("workspace_id")),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM broadcast_groups WHERE id = ?", (group_id,))
        row = await cur.fetchone()
        d = dict(row)
        d["session_ids"] = json.loads(d["session_ids"])
        return web.json_response(d, status=201)
    finally:
        await db.close()


async def update_broadcast_group(request: web.Request) -> web.Response:
    group_id = request.match_info["id"]
    body = await request.json()
    db = await get_db()
    try:
        fields, values = [], []
        if "name" in body:
            fields.append("name = ?")
            values.append(body["name"])
        if "session_ids" in body:
            fields.append("session_ids = ?")
            values.append(json.dumps(body["session_ids"]))
        if not fields:
            return web.json_response({"error": "no fields"}, status=400)
        fields.append("updated_at = datetime('now')")
        values.append(group_id)
        await db.execute(
            f"UPDATE broadcast_groups SET {', '.join(fields)} WHERE id = ?", values
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM broadcast_groups WHERE id = ?", (group_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "not found"}, status=404)
        d = dict(row)
        d["session_ids"] = json.loads(d["session_ids"]) if d["session_ids"] else []
        return web.json_response(d)
    finally:
        await db.close()


async def delete_broadcast_group(request: web.Request) -> web.Response:
    group_id = request.match_info["id"]
    db = await get_db()
    try:
        await db.execute("DELETE FROM broadcast_groups WHERE id = ?", (group_id,))
        await db.commit()
        return web.json_response({"ok": True})
    finally:
        await db.close()


# ─── REST: Commander event bus ────────────────────────────────────────────
#
# The event bus is Commander's central state-change feed. Every mutation in
# the task board, session lifecycle, plugin marketplace, etc. fires a
# canonical CommanderEvent through bus.emit() which:
#
#   1. Writes to the commander_events audit log
#   2. Broadcasts over WebSocket to any connected UI
#   3. POSTs to matching webhook subscribers (event_subscriptions)
#   4. [future] Dispatches to plugin components subscribed to the event
#
# Routes exposed here:
#   GET    /api/events                        — query audit log (filters)
#   GET    /api/events/catalog                — list every known event type
#   POST   /api/events/emit                   — manual emission (testing / external)
#   GET    /api/events/subscriptions          — list subscribers
#   POST   /api/events/subscriptions          — create a webhook subscription
#   PUT    /api/events/subscriptions/{id}     — update a subscription
#   DELETE /api/events/subscriptions/{id}     — remove a subscription

async def list_events(request: web.Request) -> web.Response:
    try:
        limit = int(request.query.get("limit", "100"))
    except ValueError:
        limit = 100
    try:
        since_id = int(request.query["since_id"]) if "since_id" in request.query else None
    except ValueError:
        since_id = None
    events = await bus.query_events(
        limit=limit,
        event_type=request.query.get("type"),
        workspace_id=request.query.get("workspace"),
        session_id=request.query.get("session"),
        task_id=request.query.get("task"),
        since_id=since_id,
    )
    return web.json_response({"events": events, "count": len(events)})


async def get_event_catalog(request: web.Request) -> web.Response:
    """Return the full list of canonical events for plugin manifests + UI."""
    return web.json_response({"events": build_event_catalog()})


async def emit_event_handler(request: web.Request) -> web.Response:
    """Manually emit an event. For testing + external integrations.

    Body: {
        "event_type": "task_completed",
        "payload": {...},
        "source": "external",
        "actor": "..."
    }
    """
    body = await request.json()
    event_type = body.get("event_type", "").strip()
    if not event_type:
        return web.json_response({"error": "event_type required"}, status=400)

    # Validate against the canonical catalog so we don't log typo events.
    valid = {e.value for e in CommanderEvent}
    if event_type not in valid:
        return web.json_response(
            {"error": f"unknown event_type: {event_type}",
             "hint": "GET /api/events/catalog for the full list"},
            status=400,
        )

    record = await bus.emit(
        event_type,
        body.get("payload") or {},
        source=body.get("source") or "external",
        actor=body.get("actor"),
    )
    return web.json_response({
        "ok": True,
        "id": record.id,
        "event_type": record.event_type,
        "created_at": record.created_at,
    }, status=201)


async def list_event_subscriptions(request: web.Request) -> web.Response:
    subs = await bus.list_subscriptions()
    return web.json_response({"subscriptions": subs})


async def create_event_subscription(request: web.Request) -> web.Response:
    body = await request.json()
    name = (body.get("name") or "").strip()
    event_types = (body.get("event_types") or "").strip()
    delivery_type = body.get("delivery_type") or "webhook"
    webhook_url = body.get("webhook_url")
    webhook_secret = body.get("webhook_secret")

    if not name or not event_types:
        return web.json_response(
            {"error": "name and event_types required"}, status=400
        )
    if delivery_type == "webhook" and not webhook_url:
        return web.json_response(
            {"error": "webhook_url required for delivery_type=webhook"}, status=400
        )

    # Validate event_types against the catalog (allow * wildcard).
    if event_types != "*":
        valid = {e.value for e in CommanderEvent}
        wanted = {t.strip() for t in event_types.split(",") if t.strip()}
        unknown = wanted - valid
        if unknown:
            return web.json_response(
                {"error": f"unknown event types: {sorted(unknown)}",
                 "hint": "GET /api/events/catalog"},
                status=400,
            )

    sub = await bus.create_subscription(
        name=name,
        event_types=event_types,
        delivery_type=delivery_type,
        webhook_url=webhook_url,
        webhook_secret=webhook_secret,
        workspace_id=body.get("workspace_id"),
        created_by=body.get("created_by") or "user",
    )
    return web.json_response(sub, status=201)


async def update_event_subscription(request: web.Request) -> web.Response:
    sub_id = request.match_info["id"]
    body = await request.json()
    sub = await bus.update_subscription(sub_id, **body)
    if not sub:
        return web.json_response({"error": "subscription not found or no fields"}, status=400)
    return web.json_response(sub)


async def delete_event_subscription(request: web.Request) -> web.Response:
    sub_id = request.match_info["id"]
    ok = await bus.delete_subscription(sub_id)
    if not ok:
        return web.json_response({"error": "subscription not found"}, status=404)
    return web.json_response({"ok": True})


async def list_experimental_features(request: web.Request) -> web.Response:
    """Return every experimental feature + its current enabled state.

    The UI renders one toggle card per feature, showing the label,
    long_description, and a prominent warning if modifies_prompt is True.
    """
    features = experimental.features_as_dicts()

    # Fill in current state from app_settings so the UI can show the toggle
    # in its real position without a second round-trip.
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT key, value FROM app_settings WHERE key LIKE 'experimental_%'"
        )
        rows = await cur.fetchall()
        states = {row["key"]: row["value"] for row in rows}
    finally:
        await db.close()

    for f in features:
        f["enabled"] = states.get(f["key"]) == "on"

    return web.json_response({"features": features})


# ─── Deep Research integration ───────────────────────────────────────────

import os
import shlex
from pathlib import Path as _Path

# Project root for invoking deep_research as a module
from resource_path import project_root as _project_root
_PROJECT_ROOT = _project_root()
_RESEARCH_DIR = _PROJECT_ROOT / "research"

# Track running research jobs: { job_id: { proc, query, started_at, status, output_path } }
_research_jobs: dict[str, dict] = {}

# Per-job asyncio.Event used to gate the next iteration when the job is in
# "interactive" (pause-each-round) mode. Set when the user resumes via
# POST /api/research/jobs/:id/resume.
_research_pause_events: dict[str, "_asyncio.Event"] = {}


def _slugify_query(text: str) -> str:
    """Slugify a query the same way deep_research does, so we can locate
    the output directory it wrote. Lazy-imports the real `_slugify` from
    deep_research to avoid drift if it's ever changed there. Falls back to
    an inline copy if the import fails (e.g. deep_research moved/renamed)."""
    try:
        from deep_research.researcher import _slugify as _real_slugify
        return _real_slugify(text)
    except Exception:
        # Mirror of deep_research.researcher._slugify @ researcher.py:412.
        # Kept as a fallback in case the upstream module is unavailable —
        # if upstream changes the rules, the import branch above will still
        # produce correct paths; this branch will silently drift.
        import re as _re
        text = text.lower().strip()
        text = _re.sub(r"[^\w\s-]", "", text)
        text = _re.sub(r"[\s_]+", "-", text)
        return text[:60].rstrip("-")


def _read_findings(query: str) -> str | None:
    """After a deep_research job completes, locate its output dir and return
    a findings summary. Prefers comprehensive-report.md, falls back to
    scratchpad.md, returns None if neither exists."""
    topic_dir = _RESEARCH_DIR / _slugify_query(query)
    if not topic_dir.exists():
        return None
    for fname in ("comprehensive-report.md", "scratchpad.md"):
        f = topic_dir / fname
        if f.exists():
            try:
                return f.read_text(encoding="utf-8")
            except Exception:
                continue
    return None


async def _set_entry_status(entry_id: str | None, status: str, findings: str | None = None):
    """Update a research_entries row from a background job context."""
    if not entry_id:
        return
    db = await get_db()
    try:
        if findings is not None:
            await db.execute(
                "UPDATE research_entries SET status = ?, findings_summary = ?, "
                "updated_at = datetime('now') WHERE id = ?",
                (status, findings, entry_id),
            )
        else:
            await db.execute(
                "UPDATE research_entries SET status = ?, updated_at = datetime('now') "
                "WHERE id = ?",
                (status, entry_id),
            )
        await db.commit()
    finally:
        await db.close()


async def _check_standalone_llm(llm_url: str | None) -> bool:
    """Quick health check on the standalone LLM (Ollama/vLLM/etc.)."""
    url = (llm_url or "http://localhost:11434").rstrip("/")
    # Try the standard health / models endpoint
    for suffix in ("/v1/models", "/api/tags", "/"):
        try:
            proc = await _asyncio.create_subprocess_exec(
                "curl", "-s", "--max-time", "3", f"{url}{suffix}",
                stdout=_asyncio.subprocess.PIPE,
                stderr=_asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await _asyncio.wait_for(proc.communicate(), timeout=5)
            if proc.returncode == 0 and stdout:
                return True
        except Exception:
            continue
    return False


def _build_research_prompt(query: str, entry_id: str | None, job: dict) -> str:
    """Build the research prompt incorporating depth, recency, and cross-temporal options."""
    depth = job.get("depth", "standard")
    recency_months = job.get("recency_months")
    cross_temporal = job.get("cross_temporal", False)
    dig_deeper = job.get("dig_deeper", False)

    # Depth → rounds and scope
    depth_instructions = {
        "quick": (
            "Do a QUICK scan: 1-2 search rounds, focus on the top results. "
            "Prioritize breadth over depth. Keep it concise."
        ),
        "standard": (
            "Do at least 3 search rounds from different angles. "
            "Balance breadth and depth."
        ),
        "deep": (
            "Do a THOROUGH deep dive this round: 3-5 search rounds from different angles. "
            "Use extract_pages to read primary sources in full. "
            "Cross-reference claims across multiple sources. "
            "Verify key findings. Explore contrarian views and edge cases. "
            "You will be asked to continue for multiple iterations, so focus on "
            "QUALITY over trying to cover everything in one pass. "
            "Save findings with save_research after each round (include sources!). "
            "Do NOT call finish_research until you're told this is the final iteration "
            "or you're genuinely satisfied the research is exhaustive."
        ),
    }.get(depth, "Do at least 3 search rounds from different angles.")

    parts = [f"Deep research: {query}\n"]
    parts.append(
        "Follow the Deep Research Methodology from your guidelines. "
        "Use all available research tools (multi_search, extract_pages, gather, "
        "save_research, finish_research)."
    )
    parts.append(depth_instructions)

    # Recency filter
    if recency_months:
        parts.append(
            f"\nRECENCY FOCUS: Prioritize content from the last {recency_months} months. "
            f"Append '2025' or '2026' to search queries. Deprioritize results older than "
            f"{recency_months} months. For each finding, note when it was published."
        )

    # Cross-temporal: look at old paradigms applied to new systems
    if cross_temporal:
        parts.append(
            "\nCROSS-TEMPORAL ANALYSIS: Actively look for established paradigms, "
            "architectures, and solutions from older/adjacent fields that are being "
            "reapplied in this domain. Many 'new' systems are rephrasings of proven "
            "concepts (e.g., Unix philosophy in CLI tools, Actor model in AI agents, "
            "MapReduce patterns in LLM pipelines). Search for: "
            "'[topic] inspired by', '[topic] based on [classic concept]', "
            "'history of [approach]', '[topic] origins'. "
            "Include a dedicated 'Foundational Patterns' section in findings."
        )

    # Dig deeper: continuing from existing findings
    if dig_deeper:
        parts.append(
            "\nDIG DEEPER: This is a continuation of previous research on this topic. "
            "Start by calling get_research to see what's already been found. "
            "Focus on gaps, unverified claims, and new angles NOT covered in existing findings. "
            "Do NOT repeat what's already known. Update the existing entry with new findings."
        )

    # Collaborative plan — inject pre-built decomposition as search strategy
    plan = job.get("plan")
    if plan and isinstance(plan, dict):
        plan_parts = []
        if plan.get("sub_queries"):
            plan_parts.append("Sub-queries to investigate:\n" + "\n".join(f"  - {q}" for q in plan["sub_queries"]))
        if plan.get("reformulations"):
            plan_parts.append("Reformulations (different vocabulary):\n" + "\n".join(f"  - {q}" for q in plan["reformulations"]))
        if plan.get("cross_domain_queries"):
            plan_parts.append("Cross-domain queries:\n" + "\n".join(f"  - {q}" for q in plan["cross_domain_queries"]))
        if plan.get("key_entities"):
            plan_parts.append("Key entities to search for: " + ", ".join(plan["key_entities"]))
        if plan_parts:
            parts.append(
                "\nRESEARCH PLAN (user-approved search strategy — follow this plan):\n"
                + "\n".join(plan_parts)
            )

    # Source and entry management
    parts.append(
        f"\nSave findings incrementally with save_research after each round. "
        f"Use entry_id='{entry_id}' for all save_research and finish_research calls. "
        "IMPORTANT: Always include the sources array with ALL URLs you found. "
        "When done, call finish_research with the full report AND all source URLs."
    )

    return "\n".join(parts)


async def _run_research_via_cli(job_id: str, query: str, workspace_id: str | None,
                                 entry_id: str | None):
    """Run deep research via a CLI session with the deep-research plugin.

    Uses the REST API to create a session, attach tools, start the PTY, and
    send the prompt — same path as the UI. Monitors completion via hook-driven
    session state polling. No internal WebSocket needed."""
    _API = f"http://127.0.0.1:{PORT}"

    async def _rest(method: str, path: str, body: dict | None = None) -> dict | list:
        url = f"{_API}{path}"
        async with aiohttp.ClientSession() as http:
            async with http.request(method, url, json=body, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                return await resp.json()

    job = _research_jobs.get(job_id)
    if not job:
        return

    job["status"] = "running"
    job["started_at"] = _time.time()
    job["backend"] = "cli"
    job["entry_id"] = entry_id
    await _set_entry_status(entry_id, "in_progress")
    await broadcast({
        "type": "research_started", "job_id": job_id,
        "query": query, "entry_id": entry_id, "backend": "cli",
    })
    await broadcast({
        "type": "research_progress", "job_id": job_id,
        "line": "Standalone LLM unavailable — running via CLI session",
        "entry_id": entry_id,
    })

    session_id = None
    try:
        # Find the deep-research MCP server ID
        db = await get_db()
        try:
            dr_mcp_id = None
            for candidate_id in ("builtin-deep-research",):
                cur = await db.execute("SELECT id FROM mcp_servers WHERE id = ?", (candidate_id,))
                if await cur.fetchone():
                    dr_mcp_id = candidate_id
                    break
            if not dr_mcp_id:
                cur = await db.execute(
                    "SELECT id FROM mcp_servers WHERE server_name LIKE '%deep-research%' LIMIT 1"
                )
                row = await cur.fetchone()
                if row:
                    dr_mcp_id = row["id"]

            dr_guideline_id = None
            for candidate_id in ("builtin-deep-research",):
                cur = await db.execute("SELECT id FROM guidelines WHERE id = ?", (candidate_id,))
                if await cur.fetchone():
                    dr_guideline_id = candidate_id
                    break
            if not dr_guideline_id:
                cur = await db.execute(
                    "SELECT id FROM guidelines WHERE name LIKE '%Deep Research%' LIMIT 1"
                )
                row = await cur.fetchone()
                if row:
                    dr_guideline_id = row["id"]
        finally:
            await db.close()

        if not dr_mcp_id:
            raise RuntimeError(
                "Deep research MCP server not found. Restart backend or register it in MCP panel."
            )

        # 1. Create session via REST API (proper setup, same as UI)
        await broadcast({
            "type": "research_progress", "job_id": job_id,
            "line": "Creating research session...", "entry_id": entry_id,
        })
        # Derive CLI type from model id (gemini-* → gemini, else claude),
        # mirroring the convention used by /api/catchup and the LLM model bus.
        job_model = (job.get("model") or "").strip()
        sess_cli = "gemini" if job_model.startswith("gemini-") else "claude"
        sess_model = job_model or ("gemini-2.5-pro" if sess_cli == "gemini" else "sonnet")
        sess = await _rest("POST", "/api/sessions", {
            "name": f"Deep Research — {query[:50]}",
            "workspace_id": workspace_id,
            "model": sess_model,
            "cli_type": sess_cli,
            "permission_mode": "bypassPermissions",
        })
        if "id" not in sess:
            raise RuntimeError(f"session create failed: {sess}")
        session_id = sess["id"]
        job["session_id"] = session_id

        # 2. Attach MCP server + guideline (include user-selected MCP data sources)
        all_mcp_ids = [dr_mcp_id]
        user_mcp_ids = job.get("mcp_server_ids") or []
        for mid in user_mcp_ids:
            if mid not in all_mcp_ids:
                all_mcp_ids.append(mid)
        await _rest("PUT", f"/api/sessions/{session_id}/mcp-servers", {
            "mcp_server_ids": all_mcp_ids,
        })
        if dr_guideline_id:
            await _rest("PUT", f"/api/sessions/{session_id}/guidelines", {
                "guideline_ids": [dr_guideline_id],
            })

        # 3. Start PTY via the shared WebSocket (broadcast action)
        await broadcast({
            "type": "research_progress", "job_id": job_id,
            "line": "Starting CLI session...", "entry_id": entry_id,
        })
        # Use the WS handler's start_pty action via a brief connection
        async with aiohttp.ClientSession() as http:
            async with http.ws_connect(f"{_API}/ws") as ws:
                await ws.send_json({
                    "action": "start_pty",
                    "session_id": session_id,
                    "cols": 200, "rows": 50,
                })
                # Wait for PTY to start (idle state from hooks)
                t0 = _time.time()
                ready = False
                while _time.time() - t0 < 60:
                    try:
                        msg = await _asyncio.wait_for(ws.receive(), timeout=3)
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            data = json.loads(msg.data)
                            if data.get("type") == "session_state" and data.get("state") == "idle":
                                ready = True
                                break
                    except _asyncio.TimeoutError:
                        # Check if PTY is alive via pty_manager
                        if pty_mgr.is_alive(session_id):
                            ready = True
                            break
                if not ready:
                    raise RuntimeError("CLI session failed to start")

                # 4. Research loop — send prompt, wait for idle, nudge to continue
                depth = job.get("depth", "standard")
                default_max = {"quick": 1, "standard": 1, "deep": 5}.get(depth, 1)
                # Workspace-level override for max iterations
                ws_max = None
                if workspace_id:
                    try:
                        _db = await get_db()
                        try:
                            _cur = await _db.execute(
                                "SELECT research_max_iterations FROM workspaces WHERE id = ?",
                                (workspace_id,),
                            )
                            _row = await _cur.fetchone()
                            if _row and _row["research_max_iterations"]:
                                ws_max = _row["research_max_iterations"]
                        finally:
                            await _db.close()
                    except Exception:
                        pass
                max_iterations = ws_max or default_max
                done = False

                for iteration in range(max_iterations):
                    # Drain steered queries injected mid-research
                    steered = job.get("steer_queries") or []
                    steer_block = ""
                    if steered:
                        steer_block = (
                            "\n\nUSER-INJECTED SUB-QUERIES (investigate these additionally):\n"
                            + "\n".join(f"  - {q}" for q in steered)
                        )
                        job["steer_queries"] = []  # consumed
                        await broadcast({
                            "type": "research_progress", "job_id": job_id,
                            "line": f"Consuming {len(steered)} steered queries this round",
                            "entry_id": entry_id,
                            "phase": "steer", "consumed": True,
                            "round": iteration + 1,
                        })

                    # Build prompt: initial on first iteration, continuation on subsequent
                    if iteration == 0:
                        prompt = _build_research_prompt(query, entry_id, job)
                        if steer_block:
                            prompt += steer_block
                    else:
                        # Continuation nudge — push the agent to go deeper
                        prompt = (
                            f"Continue researching: {query}\n\n"
                            f"This is research iteration {iteration + 1}. "
                            f"Call get_research(entry_id='{entry_id}') to see what you've found so far. "
                            "Then:\n"
                            "1. Identify gaps — what aspects remain unexplored or weakly sourced?\n"
                            "2. Search for new angles NOT covered in existing findings\n"
                            "3. Verify key claims that only have one source\n"
                            "4. Look for contrarian views and edge cases\n"
                            "5. Update findings with save_research (include sources!)\n\n"
                            "If the research is genuinely thorough and saturated (new searches return "
                            "mostly known information), call finish_research with the complete report "
                            f"and ALL source URLs. entry_id='{entry_id}'"
                        )
                        if steer_block:
                            prompt += steer_block

                    await broadcast({
                        "type": "research_progress", "job_id": job_id,
                        "line": f"{'Sending initial prompt' if iteration == 0 else f'Iteration {iteration + 1}/{max_iterations} — nudging deeper'}...",
                        "entry_id": entry_id,
                    })
                    # Tier B prompt injection: write the multi-line prompt to a
                    # tmp file and send a single-line wrapper that references it.
                    # Avoids PTY fragmentation that breaks Claude Code (raw
                    # newlines become [Pasted text #N] placeholders) and Gemini
                    # CLI (Ink TUI exits on bracketed paste / Ctrl-U / Escape).
                    prompt_path = _Path(f"/tmp/ive_research_{job_id}_{iteration}.md")
                    prompt_path.write_text(prompt)
                    job.setdefault("tmp_files", []).append(str(prompt_path))
                    if sess_cli == "gemini":
                        wrapper = f"@{prompt_path} Execute the instructions in this file."
                    else:
                        wrapper = f"Read {prompt_path} and execute the instructions there exactly."
                    pty_mgr.write(session_id, wrapper.encode("utf-8") + b"\r")

                    # Monitor until idle (up to 5 min per iteration)
                    t0 = _time.time()
                    last_activity = _time.time()
                    round_done = False

                    while _time.time() - t0 < 300:
                        try:
                            msg = await _asyncio.wait_for(ws.receive(), timeout=5)
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                data = json.loads(msg.data)
                                mtype = data.get("type", "")
                                if mtype == "output":
                                    last_activity = _time.time()
                                elif mtype == "session_state":
                                    state = data.get("state", "")
                                    if state == "idle":
                                        round_done = True
                                        break
                                    last_activity = _time.time()
                                elif mtype == "session_idle":
                                    round_done = True
                                    break
                                elif mtype == "tool_event":
                                    tool = data.get("tool", "")
                                    if tool:
                                        # Map tool names to research phases
                                        tool_phase = "search"
                                        if tool in ("multi_search", "gather"):
                                            tool_phase = "search"
                                        elif tool == "extract_pages":
                                            tool_phase = "extract"
                                        elif tool in ("save_research", "finish_research"):
                                            tool_phase = "synthesize"
                                        await broadcast({
                                            "type": "research_progress", "job_id": job_id,
                                            "line": f"Tool: {tool}",
                                            "phase": tool_phase,
                                            "round": iteration + 1,
                                            "total_rounds": max_iterations,
                                            "elapsed": int(_time.time() - job.get("started_at", _time.time())),
                                            "entry_id": entry_id,
                                        })
                                    last_activity = _time.time()
                            elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
                                done = True
                                break
                        except _asyncio.TimeoutError:
                            if _time.time() - last_activity > 90:
                                break

                    if not round_done:
                        done = True
                        break

                    # If steer queries arrived during this iteration, ensure we
                    # get at least one more iteration to incorporate them
                    pending_steers = job.get("steer_queries") or []
                    if pending_steers and iteration >= max_iterations - 1:
                        max_iterations = iteration + 2  # add one more round
                        await broadcast({
                            "type": "research_progress", "job_id": job_id,
                            "line": f"Steered queries pending — extending to {max_iterations} iterations",
                            "entry_id": entry_id,
                        })

                    # Check if agent already called finish_research (status=complete)
                    db_check = await get_db()
                    try:
                        cur = await db_check.execute(
                            "SELECT status, findings_summary FROM research_entries WHERE id = ?",
                            (entry_id,),
                        )
                        row = await cur.fetchone()
                        if row and row["status"] == "complete":
                            await broadcast({
                                "type": "research_progress", "job_id": job_id,
                                "line": f"Research marked complete after iteration {iteration + 1}",
                                "entry_id": entry_id,
                            })
                            done = True
                            break
                        # Check if findings are substantial enough to stop
                        findings_len = len(row["findings_summary"] or "") if row else 0
                        if iteration > 0 and findings_len > 5000:
                            await broadcast({
                                "type": "research_progress", "job_id": job_id,
                                "line": f"Findings substantial ({findings_len} chars) — continuing to iteration {iteration + 2}",
                                "entry_id": entry_id,
                            })
                    finally:
                        await db_check.close()

                    done = round_done

                    # Interactive pause — wait for the user to resume before
                    # the next round. Only when this isn't the last iteration
                    # and the job hasn't already finished.
                    if (
                        job.get("interactive")
                        and not done
                        and iteration < max_iterations - 1
                    ):
                        # Snapshot what we know to give the user something to react to.
                        findings_count = 0
                        try:
                            db_p = await get_db()
                            try:
                                cur_p = await db_p.execute(
                                    "SELECT findings_summary FROM research_entries WHERE id = ?",
                                    (entry_id,),
                                )
                                row_p = await cur_p.fetchone()
                                findings_count = len(
                                    (row_p["findings_summary"] or "").split("\n\n")
                                ) if row_p else 0
                            finally:
                                await db_p.close()
                        except Exception:
                            pass

                        await broadcast({
                            "type": "research_progress", "job_id": job_id,
                            "line": f"Awaiting your steering before round {iteration + 2}",
                            "entry_id": entry_id,
                            "phase": "awaiting",
                            "round": iteration + 1,
                            "next_round": iteration + 2,
                            "total_rounds": max_iterations,
                            "findings_count": findings_count,
                            "elapsed": int(_time.time() - job.get("started_at", _time.time())),
                        })

                        ev = _research_pause_events.get(job_id)
                        if ev is None:
                            ev = _asyncio.Event()
                            _research_pause_events[job_id] = ev
                        ev.clear()
                        try:
                            # Cap the wait at 30 minutes so a forgotten browser
                            # tab can't hold the job forever.
                            await _asyncio.wait_for(ev.wait(), timeout=1800)
                        except _asyncio.TimeoutError:
                            await broadcast({
                                "type": "research_progress", "job_id": job_id,
                                "line": "Awaiting timed out — resuming automatically",
                                "entry_id": entry_id,
                                "phase": "awaiting", "auto_resumed": True,
                            })
                        finally:
                            _research_pause_events.pop(job_id, None)

                # 5. Stop the PTY
                try:
                    await ws.send_json({"action": "stop", "session_id": session_id})
                except Exception:
                    pass

        # 7. Check results — only mark complete when findings actually exist.
        # `done` can flip true on WS error/closed (line ~12479) or an empty
        # round (line ~12486), neither of which implies the agent saved
        # anything. Returncode-based completion was masking real failures
        # as "complete" with empty findings_summary.
        db = await get_db()
        try:
            cur = await db.execute("SELECT * FROM research_entries WHERE id = ?", (entry_id,))
            row = await cur.fetchone()
            if row:
                entry = dict(row)
                has_findings = bool((entry.get("findings_summary") or "").strip())
                already_complete = entry.get("status") == "complete"
                if already_complete or has_findings:
                    job["status"] = "completed"
                else:
                    # Loop exited but no findings were written. That's a
                    # failure regardless of the `done` flag — don't lie to
                    # the user.
                    job["status"] = "failed"
                    job["error"] = "no findings written"
                    await _set_entry_status(entry_id, "failed")
            else:
                # No entry row at all — nothing to show, treat as failed.
                job["status"] = "failed"
                job["error"] = "research entry missing"
        finally:
            await db.close()

        await broadcast({
            "type": "research_done", "job_id": job_id,
            "status": job["status"], "entry_id": entry_id, "backend": "cli",
            "error": job.get("error"),
        })

    except Exception as e:
        logger.exception("research CLI fallback failed: %s", e)
        job["status"] = "error"
        job["error"] = str(e)
        await _set_entry_status(entry_id, "failed")
        await broadcast({
            "type": "research_done", "job_id": job_id,
            "status": "error", "error": str(e), "entry_id": entry_id,
        })

    # Clean up tmp prompt files written during the iteration loop.
    for path_str in job.get("tmp_files", []) or []:
        try:
            _Path(path_str).unlink(missing_ok=True)
        except Exception:
            pass

    # Clean up session (keep it around for debugging — user can delete manually)
    if session_id:
        try:
            # Mark as idle so it doesn't show as "running" in sidebar
            db = await get_db()
            try:
                await db.execute(
                    "UPDATE sessions SET session_type = 'worker' WHERE id = ?",
                    (session_id,),
                )
                await db.commit()
            finally:
                await db.close()
        except Exception:
            pass


async def _run_research_job(job_id: str, query: str, model: str | None,
                             llm_url: str | None, workspace_path: str | None,
                             entry_id: str | None = None,
                             workspace_id: str | None = None):
    """Run deep_research — tries standalone engine first, falls back to CLI session.

    Backend selection:
      - 'standalone': force standalone engine (needs local LLM)
      - 'cli': force CLI session (uses deep-research plugin)
      - 'auto' (default): try standalone, fall back to CLI if LLM unavailable
    """
    job = _research_jobs.get(job_id)
    if not job:
        return

    # Check app setting for research backend preference
    backend_pref = "auto"
    try:
        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT value FROM app_settings WHERE key = 'research_backend'"
            )
            row = await cur.fetchone()
            if row and row["value"]:
                backend_pref = row["value"]
        finally:
            await db.close()
    except Exception:
        pass

    # Also allow per-request override
    backend_pref = job.get("backend") or backend_pref

    use_cli = False
    if backend_pref == "cli":
        use_cli = True
    elif backend_pref == "auto":
        # Check if standalone LLM is reachable
        llm_ok = await _check_standalone_llm(llm_url)
        if not llm_ok:
            use_cli = True
            logger.info("research job %s: standalone LLM unreachable, falling back to CLI", job_id)

    if use_cli:
        return await _run_research_via_cli(job_id, query, workspace_id, entry_id)

    # ── Standalone engine path ────────────────────────────────
    from resource_path import is_frozen
    if is_frozen():
        # In compiled distribution, use the compiled deep-research binary
        cmd = [str(_PROJECT_ROOT / "bin" / "ive-research"), "research", query]
    else:
        cmd = ["python3", "-m", "deep_research", "research", query]
    if model:
        cmd.extend(["--model", model])
    if llm_url:
        cmd.extend(["--llm-url", llm_url])
    if workspace_path:
        cmd.extend(["--codebase-dir", workspace_path])
    cmd.extend(["--output-dir", str(_RESEARCH_DIR)])

    job["status"] = "running"
    job["started_at"] = _time.time()
    job["cmd"] = cmd
    job["entry_id"] = entry_id
    job["backend"] = "standalone"
    await _set_entry_status(entry_id, "in_progress")
    await broadcast({
        "type": "research_started", "job_id": job_id,
        "query": query, "entry_id": entry_id, "backend": "standalone",
    })

    try:
        # Inject DB-stored API keys into subprocess env
        import api_keys as _api_keys
        env_overrides = await _api_keys.resolve_env_overrides()
        sub_env = {**os.environ, **env_overrides} if env_overrides else None

        proc = await _asyncio.create_subprocess_exec(
            *cmd, cwd=str(_PROJECT_ROOT),
            stdout=_asyncio.subprocess.PIPE,
            stderr=_asyncio.subprocess.STDOUT,
            env=sub_env,
        )
        job["proc"] = proc
        async for line in proc.stdout:
            decoded = line.decode("utf-8", errors="replace").rstrip()
            if not decoded:
                continue
            # Try to parse structured progress events from _emit()
            progress_msg = {
                "type": "research_progress", "job_id": job_id,
                "line": decoded, "entry_id": entry_id,
            }
            try:
                parsed = json.loads(decoded.replace("'", '"'))
                if isinstance(parsed, dict) and "phase" in parsed:
                    progress_msg.update({
                        "phase": parsed.get("phase"),
                        "detail": parsed.get("detail", decoded),
                        "round": parsed.get("round"),
                        "total_rounds": parsed.get("total_rounds"),
                        "confidence": parsed.get("confidence"),
                        "elapsed": parsed.get("elapsed"),
                        "findings_count": parsed.get("findings_count"),
                        "line": parsed.get("detail", decoded),
                    })
            except (json.JSONDecodeError, ValueError):
                pass
            await broadcast(progress_msg)
        await proc.wait()
        ok = proc.returncode == 0
        # Returncode 0 doesn't prove findings were written — deep_research
        # can exit cleanly when the LLM is unreachable mid-run, every
        # search backend rate-limits, or codebase profiling fails. Treat
        # "exit 0 but empty findings" as a failure so the UI doesn't
        # claim success on an empty entry.
        findings = _read_findings(query) if ok else None
        has_findings = bool((findings or "").strip())
        if ok and has_findings:
            job["status"] = "completed"
            await _set_entry_status(entry_id, "complete", findings)
        else:
            job["status"] = "failed"
            if ok and not has_findings:
                job["error"] = "no findings written (exit 0 but empty output)"
            elif not ok:
                job["error"] = f"deep_research exited with code {proc.returncode}"
            await _set_entry_status(entry_id, "failed", findings)
        await broadcast({
            "type": "research_done", "job_id": job_id,
            "status": job["status"], "code": proc.returncode,
            "entry_id": entry_id,
            "error": job.get("error"),
        })
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
        await _set_entry_status(entry_id, "failed")
        await broadcast({
            "type": "research_done", "job_id": job_id,
            "status": "error", "error": str(e), "entry_id": entry_id,
        })


async def start_research(request: web.Request) -> web.Response:
    """POST /api/research/jobs — start a deep research job.

    Optionally accepts an existing `entry_id` to attach the job to a
    `research_entries` row created via the panel's "+ new" button. If no
    entry_id is provided, one is auto-created so every job is recorded in
    the Research DB and shows up in the panel."""
    body = await request.json()
    query = body.get("query", "").strip()
    workspace_id = body.get("workspace_id")
    entry_id = body.get("entry_id")
    feature_tag = body.get("feature_tag")
    model = body.get("model")  # Override model
    llm_url = body.get("llm_url")  # Override LLM URL
    if not query:
        return web.json_response({"error": "query required"}, status=400)

    # Resolve entry first (so we can inherit its workspace), then resolve
    # workspace context, then either validate or auto-create the entry. The
    # ordering matters: if a slash-command caller passes only `entry_id`, we
    # still want the workspace path / model defaults.
    workspace_path = None
    db = await get_db()
    try:
        if entry_id:
            cur = await db.execute("SELECT * FROM research_entries WHERE id = ?", (entry_id,))
            row = await cur.fetchone()
            if not row:
                return web.json_response({"error": "entry_id not found"}, status=404)
            if not workspace_id:
                workspace_id = dict(row).get("workspace_id")

        if workspace_id:
            cur = await db.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,))
            ws = await cur.fetchone()
            if ws:
                ws_d = dict(ws)
                workspace_path = ws_d.get("path")
                if not model:
                    model = ws_d.get("research_model")
                if not llm_url:
                    llm_url = ws_d.get("research_llm_url")

        if not entry_id:
            entry_id = str(uuid.uuid4())
            await db.execute(
                """INSERT INTO research_entries
                   (id, workspace_id, topic, query, feature_tag, status)
                   VALUES (?, ?, ?, ?, ?, 'pending')""",
                (entry_id, workspace_id, query, query, feature_tag),
            )
            await db.commit()
    finally:
        await db.close()

    job_id = str(uuid.uuid4())
    backend = body.get("backend")  # Optional: 'standalone', 'cli', or 'auto'
    # Research options
    depth = body.get("depth", "standard")      # quick | standard | deep
    recency_months = body.get("recency_months") # int or None — restrict to recent N months
    cross_temporal = body.get("cross_temporal", False)  # look at old paradigms applied to new
    dig_deeper = body.get("dig_deeper", False)  # continuing from previous findings
    mcp_server_ids = body.get("mcp_server_ids", [])  # MCP servers as data sources
    plan = body.get("plan")  # Pre-built research plan (from collaborative planning)
    interactive = bool(body.get("interactive", False))  # pause for steering each round
    # If MCP servers are requested and backend is auto, prefer CLI path
    if mcp_server_ids and not backend:
        backend = "cli"
    # Interactive (pause-each-round) only meaningfully supported in CLI-brain mode
    if interactive:
        backend = "cli"
    _research_jobs[job_id] = {
        "query": query, "model": model, "status": "pending",
        "entry_id": entry_id, "backend": backend,
        "depth": depth, "recency_months": recency_months,
        "cross_temporal": cross_temporal, "dig_deeper": dig_deeper,
        "mcp_server_ids": mcp_server_ids, "plan": plan,
        "interactive": interactive,
        "steer_queries": [],  # for mid-research injection
    }
    _asyncio.ensure_future(_run_research_job(
        job_id, query, model, llm_url, workspace_path, entry_id,
        workspace_id=workspace_id,
    ))
    return web.json_response({"job_id": job_id, "entry_id": entry_id, "query": query})


async def decompose_research_plan(request: web.Request) -> web.Response:
    """POST /api/research/plan — decompose a query into an editable research plan.

    Uses llm_router to call the DECOMPOSE_QUERY prompt and return the plan
    for the user to review/edit before starting research.
    """
    body = await request.json()
    query = body.get("query", "").strip()
    if not query:
        return web.json_response({"error": "query required"}, status=400)

    # deep_research lives at project root, not in backend/
    import sys as _sys
    if str(_PROJECT_ROOT) not in _sys.path:
        _sys.path.insert(0, str(_PROJECT_ROOT))
    try:
        from deep_research.prompts import DECOMPOSE_QUERY, SYSTEM_RESEARCHER
    except ImportError:
        # Inline fallback if deep_research isn't available
        DECOMPOSE_QUERY = (
            "Break this research question into a comprehensive search strategy.\n\n"
            "Research question: {query}\n\n"
            'Return a JSON object with: {{"sub_queries": [...], "reformulations": [...], '
            '"cross_domain_queries": [...], "key_entities": [...]}}'
        )
        SYSTEM_RESEARCHER = "You are a research analyst."
    from llm_router import llm_call_json

    prompt = DECOMPOSE_QUERY.format(query=query)
    try:
        plan = await llm_call_json(
            cli="claude", model="sonnet",
            prompt=prompt, system=SYSTEM_RESEARCHER,
            timeout=60,
        )
    except Exception as e:
        logger.warning("research plan decomposition failed: %s", e)
        # Fallback: generate a minimal plan without LLM
        plan = {
            "sub_queries": [query],
            "reformulations": [],
            "cross_domain_queries": [],
            "key_entities": [],
        }
    return web.json_response({"plan": plan, "query": query})


async def steer_research_job(request: web.Request) -> web.Response:
    """POST /api/research/jobs/{job_id}/steer — inject sub-queries into running research.

    Accepts {queries: ["query1", "query2", ...]} and appends them to the job's
    steer_queries list. They'll be picked up on the next iteration of the
    research loop (either standalone via _steer_queue, or CLI via prompt injection).
    """
    job_id = request.match_info["job_id"]
    job = _research_jobs.get(job_id)
    if not job:
        return web.json_response({"error": "job not found"}, status=404)
    if job.get("status") not in ("running", "pending"):
        return web.json_response({"error": "job is not running"}, status=400)

    body = await request.json()
    queries = body.get("queries", [])
    if not queries:
        return web.json_response({"error": "queries array required"}, status=400)

    # Append to steer list (consumed by next iteration in CLI-brain mode)
    existing = job.get("steer_queries") or []
    existing.extend(queries)
    job["steer_queries"] = existing

    # Also write to <_RESEARCH_DIR>/steer-<entry_id>.md so the standalone subprocess
    # path picks them up on its next iteration via researcher.py's file poll.
    try:
        eid = job.get("entry_id")
        if eid:
            steer_path = _RESEARCH_DIR / f"steer-{eid}.md"
            steer_path.parent.mkdir(parents=True, exist_ok=True)
            existing_text = steer_path.read_text() if steer_path.exists() else ""
            with steer_path.open("a") as f:
                if existing_text and not existing_text.endswith("\n"):
                    f.write("\n")
                for q in queries:
                    f.write(q.strip() + "\n")
    except Exception as e:
        logger.warning("failed to write steer file: %s", e)

    await broadcast({
        "type": "research_progress", "job_id": job_id,
        "line": f"Steered: +{len(queries)} sub-queries queued",
        "entry_id": job.get("entry_id"),
        "phase": "steer", "queued": True,
    })
    for q in queries:
        await broadcast({
            "type": "research_progress", "job_id": job_id,
            "line": f"  ↳ {q}",
            "entry_id": job.get("entry_id"),
            "phase": "steer", "queued": True,
        })

    return web.json_response({"ok": True, "queued": len(existing)})


async def resume_research_job(request: web.Request) -> web.Response:
    """POST /api/research/jobs/{job_id}/resume — release a paused interactive job.

    Body: { queries?: [...], skip?: bool }
      - queries: optional steer queries to inject before the next round
      - skip: if true, do not inject queries even if present in body

    Only meaningful for jobs started with interactive=true (CLI-brain mode).
    """
    job_id = request.match_info["job_id"]
    job = _research_jobs.get(job_id)
    if not job:
        return web.json_response({"error": "job not found"}, status=404)

    body = await request.json() if request.can_read_body else {}
    queries = [] if body.get("skip") else (body.get("queries") or [])
    queries = [q.strip() for q in queries if isinstance(q, str) and q.strip()]

    if queries:
        existing = job.get("steer_queries") or []
        existing.extend(queries)
        job["steer_queries"] = existing
        await broadcast({
            "type": "research_progress", "job_id": job_id,
            "line": f"Resumed with {len(queries)} steered queries",
            "entry_id": job.get("entry_id"),
            "phase": "steer", "queued": True,
        })
    else:
        await broadcast({
            "type": "research_progress", "job_id": job_id,
            "line": "Resumed (no steers)",
            "entry_id": job.get("entry_id"),
            "phase": "steer", "queued": True,
        })

    ev = _research_pause_events.get(job_id)
    if ev and not ev.is_set():
        ev.set()
        return web.json_response({"ok": True, "resumed": True, "queued": len(queries)})
    return web.json_response({"ok": True, "resumed": False, "queued": len(queries)})


async def list_research_jobs(request: web.Request) -> web.Response:
    """GET /api/research/jobs — list active and recent research jobs."""
    jobs = []
    for jid, j in _research_jobs.items():
        jobs.append({
            "job_id": jid,
            "query": j.get("query"),
            "status": j.get("status"),
            "started_at": j.get("started_at"),
            "model": j.get("model"),
            "entry_id": j.get("entry_id"),
            "error": j.get("error"),
            "backend": j.get("backend"),
            "interactive": bool(j.get("interactive")),
        })
    return web.json_response(jobs)


async def stop_research_job(request: web.Request) -> web.Response:
    """DELETE /api/research/jobs/{job_id} — stop a running research job."""
    job_id = request.match_info["job_id"]
    job = _research_jobs.get(job_id)
    if not job:
        return web.json_response({"error": "job not found"}, status=404)
    proc = job.get("proc")
    if proc and proc.returncode is None:
        proc.terminate()
        try:
            await _asyncio.wait_for(proc.wait(), timeout=5)
        except _asyncio.TimeoutError:
            proc.kill()
    # Release a paused interactive job so its loop can exit cleanly.
    ev = _research_pause_events.pop(job_id, None)
    if ev and not ev.is_set():
        ev.set()
    job["status"] = "stopped"
    return web.json_response({"ok": True})


# ─── Research Schedules (cron-like recurring research) ────────────────────

_research_scheduler_task: _asyncio.Task | None = None


async def list_research_schedules(request: web.Request) -> web.Response:
    """GET /api/research/schedules — list all research schedules."""
    workspace_id = request.query.get("workspace_id")
    db = await get_db()
    try:
        if workspace_id:
            cur = await db.execute(
                "SELECT * FROM research_schedules WHERE workspace_id = ? ORDER BY created_at DESC",
                (workspace_id,),
            )
        else:
            cur = await db.execute("SELECT * FROM research_schedules ORDER BY created_at DESC")
        rows = await cur.fetchall()
        return web.json_response([_parse_schedule_row(r) for r in rows])
    finally:
        await db.close()


def _parse_schedule_row(row) -> dict:
    """Parse JSON string fields in a research_schedule row."""
    d = dict(row)
    for field in ("mcp_server_ids", "plan"):
        if isinstance(d.get(field), str):
            try:
                d[field] = json.loads(d[field])
            except (json.JSONDecodeError, TypeError):
                pass
    return d


async def create_research_schedule(request: web.Request) -> web.Response:
    """POST /api/research/schedules — create a recurring research schedule."""
    body = await request.json()
    query = body.get("query", "").strip()
    if not query:
        return web.json_response({"error": "query required"}, status=400)

    sid = str(uuid.uuid4())
    workspace_id = body.get("workspace_id")
    mode = body.get("mode", "auto")
    mcp_server_ids = json.dumps(body.get("mcp_server_ids", []))
    plan = json.dumps(body.get("plan", {}))
    interval_hours = body.get("interval_hours", 24)
    enabled = 1 if body.get("enabled", True) else 0

    # Compute next_run_at
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    next_run = (now + timedelta(hours=interval_hours)).strftime("%Y-%m-%d %H:%M:%S")

    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO research_schedules
               (id, workspace_id, query, mode, mcp_server_ids, plan, interval_hours, enabled, next_run_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (sid, workspace_id, query, mode, mcp_server_ids, plan, interval_hours, enabled, next_run),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM research_schedules WHERE id = ?", (sid,))
        row = await cur.fetchone()
        return web.json_response(_parse_schedule_row(row))
    finally:
        await db.close()


async def update_research_schedule(request: web.Request) -> web.Response:
    """PUT /api/research/schedules/{id} — update a research schedule."""
    sid = request.match_info["id"]
    body = await request.json()
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM research_schedules WHERE id = ?", (sid,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "not found"}, status=404)

        updates = []
        params = []
        for field in ("query", "mode", "interval_hours"):
            if field in body:
                updates.append(f"{field} = ?")
                params.append(body[field])
        if "enabled" in body:
            updates.append("enabled = ?")
            params.append(1 if body["enabled"] else 0)
        if "mcp_server_ids" in body:
            updates.append("mcp_server_ids = ?")
            params.append(json.dumps(body["mcp_server_ids"]))
        if "plan" in body:
            updates.append("plan = ?")
            params.append(json.dumps(body["plan"]))

        if updates:
            updates.append("updated_at = datetime('now')")
            # Recompute next_run if interval changed
            if "interval_hours" in body:
                from datetime import datetime, timedelta, timezone
                interval = body["interval_hours"]
                next_run = (datetime.now(timezone.utc) + timedelta(hours=interval)).strftime("%Y-%m-%d %H:%M:%S")
                updates.append("next_run_at = ?")
                params.append(next_run)

            params.append(sid)
            await db.execute(
                f"UPDATE research_schedules SET {', '.join(updates)} WHERE id = ?",
                params,
            )
            await db.commit()

        cur = await db.execute("SELECT * FROM research_schedules WHERE id = ?", (sid,))
        return web.json_response(_parse_schedule_row(await cur.fetchone()))
    finally:
        await db.close()


async def delete_research_schedule(request: web.Request) -> web.Response:
    """DELETE /api/research/schedules/{id} — delete a research schedule."""
    sid = request.match_info["id"]
    db = await get_db()
    try:
        await db.execute("DELETE FROM research_schedules WHERE id = ?", (sid,))
        await db.commit()
        return web.json_response({"ok": True})
    finally:
        await db.close()


async def _research_scheduler_loop():
    """Background loop that checks for due research schedules and triggers jobs."""
    while True:
        try:
            await _asyncio.sleep(60)  # check every minute
            from datetime import datetime, timezone

            db = await get_db()
            try:
                now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
                cur = await db.execute(
                    "SELECT * FROM research_schedules WHERE enabled = 1 AND next_run_at <= ?",
                    (now,),
                )
                due = await cur.fetchall()
            finally:
                await db.close()

            for row in due:
                sched = dict(row)
                logger.info("research scheduler: triggering job for schedule %s: %s", sched["id"], sched["query"])

                # Build a virtual request body and trigger via the internal API
                mcp_ids = []
                try:
                    mcp_ids = json.loads(sched.get("mcp_server_ids") or "[]")
                except Exception:
                    pass
                plan_data = {}
                try:
                    plan_data = json.loads(sched.get("plan") or "{}")
                except Exception:
                    pass

                job_id = str(uuid.uuid4())
                entry_id = str(uuid.uuid4())

                db2 = await get_db()
                try:
                    await db2.execute(
                        """INSERT INTO research_entries
                           (id, workspace_id, topic, query, status)
                           VALUES (?, ?, ?, ?, 'pending')""",
                        (entry_id, sched.get("workspace_id"), sched["query"], sched["query"]),
                    )
                    await db2.commit()
                finally:
                    await db2.close()

                _research_jobs[job_id] = {
                    "query": sched["query"], "model": None, "status": "pending",
                    "entry_id": entry_id, "backend": sched.get("mode", "auto"),
                    "depth": "standard", "mcp_server_ids": mcp_ids, "plan": plan_data,
                    "steer_queries": [], "scheduled": True,
                }

                # Resolve workspace path + model
                workspace_path = None
                model = None
                if sched.get("workspace_id"):
                    db3 = await get_db()
                    try:
                        cur3 = await db3.execute(
                            "SELECT path, research_model FROM workspaces WHERE id = ?",
                            (sched["workspace_id"],),
                        )
                        ws = await cur3.fetchone()
                        if ws:
                            workspace_path = ws["path"]
                            model = ws["research_model"]
                    finally:
                        await db3.close()

                _asyncio.ensure_future(_run_research_job(
                    job_id, sched["query"], model, None, workspace_path,
                    entry_id, workspace_id=sched.get("workspace_id"),
                ))

                # Update schedule: last_run_at + next_run_at
                from datetime import timedelta
                interval = sched.get("interval_hours", 24)
                next_run = (datetime.now(timezone.utc) + timedelta(hours=interval)).strftime("%Y-%m-%d %H:%M:%S")

                db4 = await get_db()
                try:
                    await db4.execute(
                        "UPDATE research_schedules SET last_run_at = ?, next_run_at = ?, last_job_id = ?, updated_at = datetime('now') WHERE id = ?",
                        (now, next_run, job_id, sched["id"]),
                    )
                    await db4.commit()
                finally:
                    await db4.close()

        except _asyncio.CancelledError:
            break
        except Exception:
            logger.exception("research scheduler error")
            await _asyncio.sleep(60)


# ─── Plan file read/write ─────────��──────────────────────────────────────

_PLANS_DIR = _Path.home() / ".claude" / "plans"


def _resolve_plan_path(raw_path: str) -> _Path | None:
    """Resolve a plan file path like ~/.claude/plans/foo.md safely."""
    expanded = _Path(os.path.expanduser(raw_path)).resolve()
    plans_dir = _PLANS_DIR.resolve()
    # Security: only allow files inside ~/.claude/plans/
    if not str(expanded).startswith(str(plans_dir)):
        return None
    if not expanded.suffix == ".md":
        return None
    return expanded


async def list_plan_files(request: web.Request) -> web.Response:
    """List all plan files in ~/.claude/plans/ with optional workspace filtering."""
    workspace_id = request.query.get("workspace_id")
    plans_dir = _PLANS_DIR.resolve()
    if not plans_dir.exists():
        return web.json_response({"plans": []})

    db = await get_db()
    try:
        # Always match against ALL sessions so we know each plan's workspace
        cur = await db.execute(
            "SELECT id, name, native_slug, workspace_id FROM sessions WHERE native_slug IS NOT NULL"
        )
        rows = await cur.fetchall()
        slug_to_session = {}
        for r in rows:
            slug_to_session[r["native_slug"]] = {
                "session_id": r["id"],
                "session_name": r["name"],
                "workspace_id": r["workspace_id"],
            }

        plans = []
        for f in sorted(plans_dir.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True):
            stem = f.stem  # e.g. "buzzing-dancing-snowglobe"
            stat = f.stat()
            entry = {
                "filename": f.name,
                "path": f"~/.claude/plans/{f.name}",
                "size": stat.st_size,
                "modified": stat.st_mtime,
            }
            # Match: exact slug, or slug is prefix (for agent sub-plans like slug-agent-xxx.md)
            matched = slug_to_session.get(stem)
            if matched:
                entry.update(matched)
            else:
                # Try prefix match for agent sub-plans
                for slug, sess in slug_to_session.items():
                    if stem.startswith(slug):
                        entry.update(sess)
                        entry["sub_plan"] = True
                        break

            # Filter to requested workspace: include matched plans belonging to
            # the workspace, plus unmatched plans (no session_id — orphaned)
            if workspace_id:
                plan_ws = entry.get("workspace_id")
                if plan_ws and plan_ws != workspace_id:
                    continue  # belongs to a different workspace — skip
            plans.append(entry)
        return web.json_response({"plans": plans})
    finally:
        await db.close()


async def get_plan_file(request: web.Request) -> web.Response:
    raw = request.query.get("path", "")
    workspace_id = request.query.get("workspace_id", "")
    # BUG L5: callers also need a way to look up the most recent CLI plan for
    # a workspace by id (the plan lives in _PLANS_DIR keyed by session slug).
    if not raw and workspace_id:
        db = await get_db()
        try:
            cur = await db.execute("SELECT id FROM workspaces WHERE id = ?", (workspace_id,))
            if not await cur.fetchone():
                return web.json_response({"error": "workspace not found"}, status=404)
            cur = await db.execute(
                """SELECT native_slug FROM sessions
                   WHERE workspace_id = ? AND native_slug IS NOT NULL
                   ORDER BY created_at DESC LIMIT 1""",
                (workspace_id,),
            )
            row = await cur.fetchone()
            if not row or not row["native_slug"]:
                return web.json_response({"error": "no plan found for workspace"}, status=404)
            raw = str(_PLANS_DIR / f"{row['native_slug']}.md")
        finally:
            await db.close()
    if not raw:
        return web.json_response({"error": "missing path or workspace_id"}, status=400)
    p = _resolve_plan_path(raw)
    if not p:
        return web.json_response({"error": "invalid path"}, status=400)
    if not p.exists():
        return web.json_response({"error": "file not found"}, status=404)
    content = p.read_text(encoding="utf-8")
    return web.json_response({"path": str(p), "content": content})


async def put_plan_file(request: web.Request) -> web.Response:
    body = await request.json()
    raw = body.get("path", "")
    content = body.get("content", "")
    if not raw:
        return web.json_response({"error": "missing path"}, status=400)
    p = _resolve_plan_path(raw)
    if not p:
        return web.json_response({"error": "invalid path"}, status=400)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return web.json_response({"ok": True, "path": str(p)})


# ─── App ──────────────────────────────────────────────────────────────────

@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        resp = web.Response()
    else:
        try:
            resp = await handler(request)
        except web.HTTPException:
            raise
        except json.JSONDecodeError as e:
            resp = web.json_response({"error": f"invalid JSON body: {e.msg}"}, status=400)
        except Exception as e:
            # JSONDecodeError sometimes surfaces wrapped — detect by class name
            if type(e).__name__ in ("JSONDecodeError",):
                resp = web.json_response({"error": f"invalid JSON body: {e}"}, status=400)
            else:
                logger.exception("Unhandled error")
                import telemetry
                telemetry.report_error_sync(
                    type(e).__name__, str(e),
                    f"{request.method} {request.path}",
                )
                resp = web.json_response({"error": str(e)}, status=500)
    # In multiplayer mode, restrict CORS to the actual request origin
    # instead of wildcard — this server grants shell access.
    if AUTH_TOKEN:
        origin = request.headers.get("Origin", "")
        if origin:
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Access-Control-Allow-Credentials"] = "true"
        # No Origin header (same-origin requests, curl) → no CORS header needed
    else:
        resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    return resp


# ─── Token auth middleware (multiplayer mode) ────────────────────────────
# When AUTH_TOKEN is set, every request must present the token via:
#   1. Cookie 'ive_token'  (set automatically via login form)
#   2. Authorization: Bearer <token>  (API clients)
#   3. Query param ?token=  (convenience — sets cookie and redirects)
# Token never needs to appear in a URL — the default flow uses a login form.
# Localhost hook endpoints (/api/hooks/*) are exempt (verified local).

AUTH_TOKEN: str | None = None  # Set by --multiplayer / --token flag
_TUNNEL_MODE: bool = False  # Set by --tunnel flag — disables blanket localhost trust
_MULTIPLAYER_MODE: bool = False  # Set by --multiplayer flag — enables preview proxy etc.

_LOCALHOST_ADDRS = {"127.0.0.1", "::1", "localhost"}
# Cloudflare-tunnel proxied requests arrive from 127.0.0.1 (cloudflared) but
# carry these headers. Used to distinguish real local traffic from tunnel
# traffic that should be auth-checked.
_CLOUDFLARE_FORWARD_HEADERS = ("Cf-Connecting-Ip", "Cf-Ray", "Cf-Connecting-IPv6")

# ── MCP caller resolution ────────────────────────────────────────────────
#
# Worker / Documentor / Commander MCP servers carry their bound session
# identity in three headers (set by api_call() in each MCP server):
#
#   X-IVE-Session-Id    — the session_id the MCP is running on behalf of
#   X-IVE-Session-Type  — worker / planner / commander / documentor / tester
#   X-IVE-Workspace-Id  — the workspace the session lives in
#
# The headers are advisory: any agent with shell access can spoof them. They
# exist so the legitimate MCP path is scoped (closing the easy hijack vectors
# from the MCP audit MCP-S1/S2/S4/S5/S7), and so a future authn boundary can
# bind them to a verified session_token. Tunnel mode AUTH_TOKEN already gates
# the whole REST surface against external attackers; these checks gate
# in-process workers from each other.

async def _resolve_caller(request: web.Request) -> dict | None:
    """Return {session_id, session_type, workspace_id, row} for the caller, or None.

    Validates the session exists in the DB so a forged ID for a deleted
    session won't grant scoped access.
    """
    sid = (request.headers.get("X-IVE-Session-Id") or "").strip()
    if not sid:
        return None
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT id, session_type, workspace_id FROM sessions WHERE id = ?",
            (sid,),
        )
        row = await cur.fetchone()
    finally:
        await db.close()
    if not row:
        return None
    return {
        "session_id": row["id"],
        "session_type": row["session_type"] or "worker",
        "workspace_id": row["workspace_id"],
    }


# ── Rate limiting for auth failures ──────────────────────────────────────
import time as _auth_time

_auth_failures: dict[str, list[float]] = {}  # IP → list of failure timestamps
_AUTH_MAX_ATTEMPTS = 5     # max failures per window
_AUTH_WINDOW_SECS = 60     # rolling window
_AUTH_LOCKOUT_SECS = 30    # lockout after exceeding limit


def _is_rate_limited(ip: str) -> bool:
    now = _auth_time.time()
    attempts = _auth_failures.get(ip, [])
    attempts = [t for t in attempts if now - t < _AUTH_WINDOW_SECS]
    _auth_failures[ip] = attempts
    if len(attempts) >= _AUTH_MAX_ATTEMPTS:
        return now - attempts[-1] < _AUTH_LOCKOUT_SECS
    return False


def _record_auth_failure(ip: str):
    now = _auth_time.time()
    if ip not in _auth_failures:
        _auth_failures[ip] = []
    _auth_failures[ip].append(now)
    # Trim to window
    _auth_failures[ip] = _auth_failures[ip][-_AUTH_MAX_ATTEMPTS * 2:]


def _make_cookie_params(request: web.Request) -> dict:
    """Cookie params with Secure flag when behind HTTPS. SameSite=Strict
    blocks cross-site cookie attachment, mitigating CSRF-driven token reuse
    on this server (which grants shell access)."""
    is_https = (
        request.scheme == "https"
        or request.headers.get("X-Forwarded-Proto") == "https"
    )
    return dict(httponly=True, samesite="Strict", max_age=86400 * 30, secure=is_https)


def _tokens_equal(a: str | None, b: str | None) -> bool:
    """Timing-safe constant-time token comparison. Returns False if either
    side is empty/None — guards against the empty-token bypass that would
    succeed if AUTH_TOKEN were ever cleared."""
    if not a or not b:
        return False
    try:
        return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))
    except (AttributeError, TypeError):
        return False


# ── Login form HTML ─────────────────────────────────────────────────��────
_LOGIN_HTML = """\
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IVE — Connect</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#e5e5e5;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center;width:300px">
<h2 style="color:#22d3ee;margin:0 0 4px">IVE</h2>
<p style="color:#555;font-size:13px;margin:0 0 28px">Integrated Vibecoding Environment</p>
{error}
<form method="POST" action="/auth" style="display:flex;flex-direction:column;gap:10px">
<input type="password" name="token" placeholder="Paste your access token" autofocus
 style="background:#141414;border:1px solid #2a2a2a;border-radius:8px;padding:11px 14px;
 color:#e5e5e5;font-size:14px;outline:none;font-family:ui-monospace,SFMono-Regular,monospace;
 transition:border-color .15s" onfocus="this.style.borderColor='#22d3ee'"
 onblur="this.style.borderColor='#2a2a2a'" />
<button type="submit" style="background:#22d3ee;color:#0a0a0a;border:none;border-radius:8px;
 padding:11px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .15s"
 onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">Connect</button>
</form>
<p style="color:#333;font-size:11px;margin-top:20px">Token is shown in the terminal where IVE was started</p>
</div></body></html>"""

_LOGIN_RATE_LIMITED_HTML = """\
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>IVE — Rate Limited</title></head>
<body style="font-family:system-ui;background:#0a0a0a;color:#e5e5e5;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
<h2 style="color:#f87171">Too many attempts</h2>
<p style="color:#666">Try again in {seconds} seconds</p>
</div></body></html>"""


async def auth_login(request: web.Request) -> web.Response:
    """POST /auth — validate token from login form, set cookie."""
    peername = request.transport.get_extra_info("peername")
    remote_ip = peername[0] if peername else "unknown"

    if _is_rate_limited(remote_ip):
        return web.Response(
            status=429, content_type="text/html",
            text=_LOGIN_RATE_LIMITED_HTML.format(seconds=_AUTH_LOCKOUT_SECS),
        )

    data = await request.post()
    token = data.get("token", "").strip()

    if not _tokens_equal(token, AUTH_TOKEN):
        _record_auth_failure(remote_ip)
        attempts = len([t for t in _auth_failures.get(remote_ip, [])
                        if _auth_time.time() - t < _AUTH_WINDOW_SECS])
        remaining = _AUTH_MAX_ATTEMPTS - attempts
        error_msg = (
            f'<p style="color:#f87171;font-size:13px;margin:0 0 16px">'
            f'Invalid token ({remaining} attempt{"s" if remaining != 1 else ""} remaining)</p>'
        )
        return web.Response(
            status=401, content_type="text/html",
            text=_LOGIN_HTML.format(error=error_msg),
        )

    resp = web.HTTPFound("/")
    # In tunnel mode the legacy ive_token cookie is intentionally ignored by
    # resolve_auth (so revoking a joiner_session can't be circumvented by a
    # bookmarked token). Mint a per-row joiner_session instead so the form
    # login still works AND remains revocable from the Sharing panel.
    if _TUNNEL_MODE:
        try:
            cookie_value, sess = await _joiner_sessions.create_session(
                mode="full",
                actor_kind="owner_legacy",
                ttl_seconds=86400,
                label="Owner (form login)",
                last_ip=remote_ip,
                last_user_agent=request.headers.get("User-Agent"),
            )
            resp.set_cookie(
                _auth_context.SESSION_COOKIE,
                cookie_value,
                **_make_cookie_params(request),
            )
            resp.del_cookie(_auth_context.LEGACY_COOKIE)
            _fire_and_forget(bus.emit(
                CommanderEvent.SESSION_MINTED,
                {
                    "session_id": sess.id,
                    "actor_kind": sess.actor_kind,
                    "mode": sess.mode,
                    "via": "tunnel_form_login",
                },
                source="commander",
            ))
            return resp
        except Exception:
            logger.exception("Failed to mint joiner session for tunnel form login; falling back to legacy cookie")
    resp.set_cookie("ive_token", AUTH_TOKEN, **_make_cookie_params(request))
    return resp


import auth_context as _auth_context
import joiner_sessions as _joiner_sessions


def _exempt_path(request: web.Request) -> bool:
    """Paths reachable WITHOUT a valid AuthContext (login, redeem, PWA, device pairing)."""
    p = request.path
    if p == "/auth" and request.method == "POST":
        return True
    if p == "/api/invite/redeem" and request.method == "POST":
        return True
    if p == "/join":
        return True
    if p in ("/sw.js", "/manifest.webmanifest"):
        return True
    # Device pairing: pair-complete is unauth (the signed challenge IS
    # the auth), and challenge issuance for an already-paired device is
    # unauth too (it just hands out a nonce — verification happens on
    # pair-complete). pair-init is owner-only and stays guarded.
    if p == "/api/devices/pair-complete" and request.method == "POST":
        return True
    if p.startswith("/api/devices/") and p.endswith("/challenge") and request.method == "GET":
        return True
    return False


@web.middleware
async def token_auth_middleware(request: web.Request, handler):
    if not AUTH_TOKEN:
        # No global auth token configured → fully open (single-user local dev).
        # Still attach a synthetic AuthContext so route guards can read .mode.
        request["auth"] = _auth_context.AuthContext(
            actor_kind="owner_legacy", actor_id=None, mode="full",
            brief_subscope=None, label=None, expires_at=None,
        )
        return await handler(request)

    if _exempt_path(request):
        return await handler(request)

    peername = request.transport.get_extra_info("peername")
    remote_ip = peername[0] if peername else "unknown"
    if _is_rate_limited(remote_ip):
        return web.json_response(
            {"error": "Too many auth attempts. Try again later."},
            status=429,
        )

    ctx = await _auth_context.resolve_auth(
        request, auth_token=AUTH_TOKEN, tunnel_mode=_TUNNEL_MODE,
    )
    if ctx is None:
        _record_auth_failure(remote_ip)
        if request.headers.get("Accept", "").startswith("text/html"):
            return web.Response(
                status=401, content_type="text/html",
                text=_LOGIN_HTML.format(error=""),
            )
        return web.json_response({"error": "Unauthorized"}, status=401)

    request["auth"] = ctx

    if (
        request.query.get("token")
        and request.method == "GET"
        and not request.path.startswith(("/api/", "/ws", "/preview/"))
        and _tokens_equal(request.query.get("token"), AUTH_TOKEN)
    ):
        clean_query = {k: v for k, v in request.query.items() if k != "token"}
        clean_url = str(request.url.with_query(clean_query))
        resp = web.HTTPFound(clean_url)
        # In tunnel mode, mint a per-row joiner_session so the visitor shows
        # up in /api/sessions/auth and can be revoked individually. Locally
        # we keep the legacy cookie path (single-user dev convenience).
        if _TUNNEL_MODE:
            try:
                cookie_value, sess = await _joiner_sessions.create_session(
                    mode="full",
                    actor_kind="owner_legacy",
                    ttl_seconds=86400,
                    label="Token link visitor",
                    last_ip=remote_ip,
                    last_user_agent=request.headers.get("User-Agent"),
                )
                resp.set_cookie(
                    _auth_context.SESSION_COOKIE,
                    cookie_value,
                    **_make_cookie_params(request),
                )
                resp.del_cookie(_auth_context.LEGACY_COOKIE)
                _fire_and_forget(bus.emit(
                    CommanderEvent.SESSION_MINTED,
                    {
                        "session_id": sess.id,
                        "actor_kind": sess.actor_kind,
                        "mode": sess.mode,
                        "via": "tunnel_token_link",
                    },
                    source="commander",
                ))
                return resp
            except Exception:
                logger.exception("Failed to mint joiner session for tunnel token link; falling back to legacy cookie")
        resp.set_cookie("ive_token", AUTH_TOKEN, **_make_cookie_params(request))
        return resp

    return await handler(request)


def get_auth(request: web.Request) -> _auth_context.AuthContext:
    """Route handler accessor for the middleware-attached AuthContext.
    Synthesizes a localhost/full context if missing (hook routes, tests)."""
    ctx = request.get("auth")
    if ctx is None:
        ctx = _auth_context.AuthContext(
            actor_kind="localhost", actor_id=None, mode="full",
            brief_subscope=None, label=None, expires_at=None,
        )
    return ctx


# ─── Invite routes (PR 1 of access overhaul) ────────────────────────────
# PR 1 stands up the invite primitive: a one-shot token redeemed for an
# authenticated session. PR 2 will replace the global AUTH_TOKEN cookie
# pass-through with per-row joiner_sessions; for now redemption sets the
# existing ive_token cookie so the redeemer immediately gets in.

import invites as _invites


def _invite_to_listing(row: dict) -> dict:
    """Strip the token_hash and return display-safe fields only."""
    if not row:
        return {}
    return {
        "id": row.get("id"),
        "encoded_speakable": row.get("encoded_speakable"),
        "encoded_compact": row.get("encoded_compact"),
        "mode": row.get("mode"),
        "brief_subscope": row.get("brief_subscope"),
        "ttl_seconds": row.get("ttl_seconds"),
        "label": row.get("label"),
        "redemption_attempts": row.get("redemption_attempts"),
        "redeemed_at": row.get("redeemed_at"),
        "redeemed_by_session_id": row.get("redeemed_by_session_id"),
        "burned_at": row.get("burned_at"),
        "expires_at": row.get("expires_at"),
        "created_at": row.get("created_at"),
        "created_by": row.get("created_by"),
    }


async def create_invite_handler(request: web.Request) -> web.Response:
    body = await request.json()
    mode = (body.get("mode") or "").strip().lower()
    ttl_seconds = body.get("ttl_seconds")
    label = (body.get("label") or "").strip() or None
    brief_subscope = body.get("brief_subscope")
    if isinstance(brief_subscope, str):
        brief_subscope = brief_subscope.strip().lower() or None

    try:
        ttl_seconds = int(ttl_seconds)
    except (TypeError, ValueError):
        return web.json_response({"error": "ttl_seconds must be an integer"}, status=400)

    try:
        created = await _invites.create_invite(
            mode=mode,
            ttl_seconds=ttl_seconds,
            label=label,
            brief_subscope=brief_subscope,
            created_by="owner",
        )
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)

    await bus.emit(
        CommanderEvent.INVITE_CREATED,
        {
            "invite_id": created.id,
            "mode": created.mode,
            "brief_subscope": created.brief_subscope,
            "ttl_seconds": created.ttl_seconds,
            "label": created.label,
            "expires_at": created.expires_at,
        },
        source="commander",
    )

    return web.json_response({
        "id": created.id,
        "mode": created.mode,
        "brief_subscope": created.brief_subscope,
        "ttl_seconds": created.ttl_seconds,
        "label": created.label,
        "expires_at": created.expires_at,
        # Three projections — the secret is returned exactly once.
        "secret_speakable": created.encoded_speakable,
        "secret_compact": created.encoded_compact,
        "secret_qr": created.encoded_qr_secret,
    })


async def list_invites_handler(request: web.Request) -> web.Response:
    rows = await _invites.list_invites()
    return web.json_response({"invites": [_invite_to_listing(r) for r in rows]})


async def revoke_invite_handler(request: web.Request) -> web.Response:
    invite_id = request.match_info.get("id", "").strip()
    if not invite_id:
        return web.json_response({"error": "missing id"}, status=400)
    burned = await _invites.revoke_invite(invite_id)
    if burned:
        await bus.emit(
            CommanderEvent.INVITE_BURNED,
            {"invite_id": invite_id, "reason": "owner_revoked"},
            source="commander",
        )
    return web.json_response({"ok": True, "burned": bool(burned)})


async def redeem_invite_handler(request: web.Request) -> web.Response:
    """Unauthenticated. Rate-limited via middleware."""
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        body = {}
    token_input = (body.get("token") or "").strip()
    if not token_input:
        return web.json_response({"error": "missing token"}, status=400)

    peername = request.transport.get_extra_info("peername")
    remote_ip = peername[0] if peername else "unknown"

    try:
        result = await _invites.redeem_invite(token_input)
    except _invites.InviteRedeemError as e:
        await bus.emit(
            CommanderEvent.INVITE_REDEEM_FAILED,
            {"reason": e.code, "remote_ip": remote_ip},
            source="commander",
        )
        # Map to HTTP. invalid_token / not_found → 404; burned/redeemed/expired → 410.
        status = 404 if e.code in ("not_found", "invalid_token") else 410
        return web.json_response({"error": e.code, "message": str(e)}, status=status)

    await bus.emit(
        CommanderEvent.INVITE_REDEEMED,
        {
            "invite_id": result.invite_id,
            "mode": result.mode,
            "brief_subscope": result.brief_subscope,
            "ttl_seconds": result.ttl_seconds,
            "label": result.label,
            "remote_ip": remote_ip,
        },
        source="commander",
    )

    # PR 2: mint a per-row joiner_sessions row + opaque cookie. The cookie
    # value is shown ONCE; only its hash is persisted. Sliding TTL is bumped
    # by auth_context.resolve_auth on each subsequent request.
    user_agent = request.headers.get("User-Agent")
    cookie_value, sess = await _joiner_sessions.create_session(
        mode=result.mode,
        actor_kind="joiner_session",
        ttl_seconds=result.ttl_seconds,
        label=result.label,
        brief_subscope=result.brief_subscope,
        invite_id=result.invite_id,
        last_ip=remote_ip,
        last_user_agent=user_agent,
    )

    payload = {
        "ok": True,
        "mode": result.mode,
        "brief_subscope": result.brief_subscope,
        "ttl_seconds": result.ttl_seconds,
        "label": result.label,
        "session_id": sess.id,
        "expires_at": sess.expires_at,
    }

    await bus.emit(
        CommanderEvent.SESSION_MINTED,
        {
            "session_id": sess.id,
            "actor_kind": sess.actor_kind,
            "mode": sess.mode,
            "invite_id": result.invite_id,
        },
        source="commander",
    )

    resp = web.json_response(payload)
    resp.set_cookie(_auth_context.SESSION_COOKIE, cookie_value, **_make_cookie_params(request))
    resp.del_cookie(_auth_context.LEGACY_COOKIE)
    return resp


_JOIN_HTML = """\
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IVE — Join</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#e5e5e5;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px">
<div style="text-align:center;width:340px">
<h2 style="color:#22d3ee;margin:0 0 4px">IVE</h2>
<p style="color:#666;font-size:13px;margin:0 0 24px">Paste your invite token to join</p>
<div id="error" style="color:#f87171;font-size:13px;margin:0 0 16px;min-height:18px"></div>
<form id="form" style="display:flex;flex-direction:column;gap:10px">
<input id="token" name="token" placeholder="four words, 12 letters, or scanned link"
 autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus
 style="background:#141414;border:1px solid #2a2a2a;border-radius:8px;padding:11px 14px;
 color:#e5e5e5;font-size:14px;outline:none;font-family:ui-monospace,SFMono-Regular,monospace;
 transition:border-color .15s" onfocus="this.style.borderColor='#22d3ee'"
 onblur="this.style.borderColor='#2a2a2a'" />
<button id="submit" type="submit" style="background:#22d3ee;color:#0a0a0a;border:none;
 border-radius:8px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;
 transition:opacity .15s">Join</button>
</form>
<p style="color:#333;font-size:11px;margin-top:20px">
The owner will have given you a four-word phrase, a short code, or a scannable link.</p>
</div>
<script>
(function () {
  var form = document.getElementById('form');
  var errEl = document.getElementById('error');
  var tokenEl = document.getElementById('token');
  var btn = document.getElementById('submit');

  function setError(msg) { errEl.textContent = msg || ''; }

  async function redeem(token) {
    setError('');
    btn.disabled = true; btn.textContent = 'Joining…';
    try {
      var r = await fetch('/api/invite/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token }),
        credentials: 'same-origin',
      });
      if (r.ok) {
        window.location.replace('/');
        return;
      }
      var data = {};
      try { data = await r.json(); } catch (e) {}
      var msg = data.message || data.error || ('Error ' + r.status);
      setError(msg);
    } catch (e) {
      setError(String(e));
    } finally {
      btn.disabled = false; btn.textContent = 'Join';
    }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var t = (tokenEl.value || '').trim();
    if (t) redeem(t);
  });

  // Magic-link autofill (?t=…). The token is read once and never re-read,
  // so back-button or refresh after a failure drops to the bare paste form.
  var params = new URLSearchParams(window.location.search);
  var pre = params.get('t');
  if (pre) {
    tokenEl.value = pre;
    history.replaceState({}, '', '/join');
    redeem(pre);
  }
})();
</script>
</body></html>"""


async def join_page_handler(request: web.Request) -> web.Response:
    return web.Response(text=_JOIN_HTML, content_type="text/html")


# ─── PR 2: AuthContext-aware introspection + revocation ──────────────────


async def whoami_handler(request: web.Request) -> web.Response:
    ctx = get_auth(request)
    return web.json_response({
        "actor_kind": ctx.actor_kind,
        "actor_id": ctx.actor_id,
        "mode": ctx.mode,
        "brief_subscope": ctx.brief_subscope,
        "label": ctx.label,
        "expires_at": ctx.expires_at,
        "device_id": ctx.device_id,
        "invite_id": ctx.invite_id,
        "is_owner": ctx.is_owner,
    })


async def list_auth_sessions_handler(request: web.Request) -> web.Response:
    """Owner-only: list active joiner_sessions rows so the owner can review
    and revoke individual cookies/devices."""
    ctx = get_auth(request)
    if not ctx.is_owner:
        return web.json_response({"error": "owner only"}, status=403)
    rows = await _joiner_sessions.list_active()
    return web.json_response({"sessions": rows, "current_id": ctx.actor_id})


async def revoke_auth_session_handler(request: web.Request) -> web.Response:
    ctx = get_auth(request)
    if not ctx.is_owner:
        return web.json_response({"error": "owner only"}, status=403)
    sid = request.match_info.get("id", "").strip()
    if not sid:
        return web.json_response({"error": "missing id"}, status=400)
    revoked = await _joiner_sessions.revoke(sid)
    if revoked:
        await bus.emit(
            CommanderEvent.SESSION_REVOKED,
            {"session_id": sid, "revoked_by": ctx.actor_kind},
            source="commander",
        )
        # Close any live WebSocket the revoked actor is holding so they
        # can't keep driving PTYs after revocation. Snapshot first because
        # ws.close() triggers the finally{} branch which mutates ws_clients.
        doomed = [w for w in ws_clients if getattr(w, "_ive_actor_id", None) == sid]
        for w in doomed:
            try:
                await w.close(code=1008, message=b"session revoked")
            except Exception:
                pass
    return web.json_response({"ok": True, "revoked": bool(revoked)})


async def logout_handler(request: web.Request) -> web.Response:
    """Self-revoke: clear cookies, revoke the current joiner_sessions row."""
    ctx = get_auth(request)
    if ctx.actor_kind == "joiner_session" and ctx.actor_id:
        await _joiner_sessions.revoke(ctx.actor_id)
    resp = web.json_response({"ok": True})
    resp.del_cookie(_auth_context.SESSION_COOKIE)
    resp.del_cookie(_auth_context.LEGACY_COOKIE)
    return resp


async def list_audit_log_handler(request: web.Request) -> web.Response:
    """Owner-only: list audit log entries.

    Filters: ?actor_id=, ?actor_kind=, ?since=, ?path_prefix=, ?limit= (default 200, max 2000)
    """
    ctx = get_auth(request)
    if not ctx.is_owner:
        return web.json_response({"error": "owner only"}, status=403)
    actor_id = request.query.get("actor_id")
    actor_kind = request.query.get("actor_kind")
    since = request.query.get("since")
    path_prefix = request.query.get("path_prefix")
    try:
        limit = max(1, min(2000, int(request.query.get("limit", "200"))))
    except ValueError:
        limit = 200

    where = []
    params: list = []
    if actor_id:
        where.append("actor_id = ?")
        params.append(actor_id)
    if actor_kind:
        where.append("actor_kind = ?")
        params.append(actor_kind)
    if since:
        where.append("ts >= ?")
        params.append(since)
    if path_prefix:
        where.append("path LIKE ?")
        params.append(path_prefix + "%")
    sql = (
        "SELECT id, actor_kind, actor_id, actor_label, mode, method, path, "
        "       status, ip, user_agent, summary, ts "
        "FROM audit_log"
    )
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY ts DESC LIMIT ?"
    params.append(limit)

    db = await get_db()
    try:
        cur = await db.execute(sql, tuple(params))
        rows = [dict(r) for r in await cur.fetchall()]
    finally:
        await db.close()
    return web.json_response({"entries": rows, "count": len(rows)})


# ─── PR 4: Catch-me-up digest + Web Push ────────────────────────────────


# ─── Runtime tunnel + multiplayer controls ──────────────────────────────
# Owner-only toggles for the cloudflared subprocess and the multiplayer
# preview-proxy mount. Boot-time CLI flags remain the source of truth at
# launch; these endpoints let the owner stop/start the tunnel and the
# multiplayer proxy without restarting the whole server.

_runtime_tunnel_url: str | None = None  # last known tunnel URL


async def runtime_status_handler(request: web.Request) -> web.Response:
    """GET /api/runtime/status — current tunnel + multiplayer state."""
    ctx = get_auth(request)
    if not ctx.is_owner:
        return web.json_response({"error": "owner only"}, status=403)
    proc_alive = bool(_tunnel_proc and _tunnel_proc.returncode is None)
    return web.json_response({
        "tunnel": {
            "enabled": _TUNNEL_MODE,
            "running": proc_alive,
            "url": _runtime_tunnel_url if proc_alive else None,
            # Surface the auth token so the runtime-controls UI can render
            # a QR that lands the visitor authenticated. Owner-only handler
            # so the token never leaks to a joiner.
            "token": (AUTH_TOKEN if proc_alive and AUTH_TOKEN else None),
        },
        "multiplayer": {
            "enabled": _MULTIPLAYER_MODE,
        },
        "cloudflared_installed": bool(__import__("shutil").which("cloudflared")),
    })


async def runtime_tunnel_start_handler(request: web.Request) -> web.Response:
    """POST /api/runtime/tunnel/start — launch the cloudflared subprocess.

    Mints a Cloudflare quick tunnel pointing at the local bind port. Sets
    _TUNNEL_MODE so the auth middleware stops blanket-trusting localhost
    (cloudflared connects as 127.0.0.1)."""
    global _TUNNEL_MODE, _runtime_tunnel_url, AUTH_TOKEN
    ctx = get_auth(request)
    if not ctx.is_owner:
        return web.json_response({"error": "owner only"}, status=403)
    if _tunnel_proc and _tunnel_proc.returncode is None:
        return web.json_response({
            "ok": True, "running": True, "url": _runtime_tunnel_url,
            "token": AUTH_TOKEN or None,
            "message": "tunnel already running",
        })
    # Pre-flight: cloudflared must be installed.
    import shutil as _shutil
    if not _shutil.which("cloudflared"):
        return web.json_response(
            {
                "ok": False,
                "error": "cloudflared is not installed. Install with: brew install cloudflare/cloudflare/cloudflared",
            },
            status=500,
        )
    # Auto-generate an AUTH_TOKEN if none exists. Without one, flipping
    # _TUNNEL_MODE = True would leave the public URL completely open
    # (the auth middleware short-circuits to owner_legacy when no token
    # is configured). We mint one on first runtime tunnel-up so the
    # owner can ship invites instead of a bare URL.
    if not AUTH_TOKEN:
        AUTH_TOKEN = _generate_token()
        logger.info("Auto-generated AUTH_TOKEN for runtime tunnel")
    bind_port = int(os.environ.get("PORT") or 5111)
    # Engage tunnel mode BEFORE spawning so a request that races in
    # via cloudflared doesn't sneak past the localhost-trust path.
    _TUNNEL_MODE = True
    url = await _start_cloudflare_tunnel(bind_port)
    if not url:
        _TUNNEL_MODE = False
        return web.json_response(
            {
                "ok": False,
                "error": "cloudflared started but no tunnel URL was emitted within 60s. Check network access and try again.",
            },
            status=500,
        )
    _runtime_tunnel_url = url
    # Kick off a background `npm run build` if no dist exists. Visitors
    # will see the proxy-to-Vite path until the build lands; once dist is
    # written, the SPA fallback transparently switches to serving it.
    _fire_and_forget(_ensure_frontend_built())
    return web.json_response({"ok": True, "running": True, "url": url, "token": AUTH_TOKEN})


async def _ensure_frontend_built():
    """Run `npm run build` in frontend/ if frontend/dist/ is missing.
    No-op if a build is already underway or dist already exists."""
    global _frontend_build_proc
    try:
        from resource_path import project_root as _rp
        dist = _rp() / "frontend" / "dist"
        if dist.is_dir() and (dist / "index.html").is_file():
            return
        if _frontend_build_proc and _frontend_build_proc.returncode is None:
            return
        frontend_dir = _rp() / "frontend"
        if not (frontend_dir / "package.json").is_file():
            logger.warning("frontend/package.json missing — can't auto-build")
            return
        logger.info("Auto-building frontend for runtime tunnel (dist missing)")
        _frontend_build_proc = await asyncio.create_subprocess_exec(
            "npm", "run", "build",
            cwd=str(frontend_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await _frontend_build_proc.communicate()
        rc = _frontend_build_proc.returncode
        if rc == 0:
            logger.info("Frontend build complete")
        else:
            logger.error("Frontend build failed (rc=%s):\n%s", rc, (out or b"").decode("utf-8", "replace")[-2000:])
    except Exception as e:
        logger.error("Frontend auto-build error: %s", e)


_frontend_build_proc = None


async def runtime_tunnel_stop_handler(request: web.Request) -> web.Response:
    """POST /api/runtime/tunnel/stop — terminate the cloudflared subprocess.

    If the stop request is coming through the tunnel itself, we can't
    kill cloudflared synchronously — the response would never reach the
    client (502 from the edge). Detach the kill so the response flushes
    cleanly first."""
    global _TUNNEL_MODE, _runtime_tunnel_url, _tunnel_proc
    ctx = get_auth(request)
    if not ctx.is_owner:
        return web.json_response({"error": "owner only"}, status=403)
    via_tunnel = bool(request.headers.get("Cf-Connecting-Ip"))
    proc = _tunnel_proc
    _tunnel_proc = None
    _runtime_tunnel_url = None
    _TUNNEL_MODE = False

    async def _kill_after_response():
        if via_tunnel:
            await asyncio.sleep(0.5)
        if not proc:
            return
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    _fire_and_forget(_kill_after_response())
    return web.json_response({"ok": True, "running": False})


async def runtime_mode_handler(request: web.Request) -> web.Response:
    """POST /api/runtime/mode — body {mode: 'off' | 'local' | 'tunnel'}.

    Single atomic switch consolidating multiplayer + tunnel:
      - off:    multiplayer=False, tunnel=False
      - local:  multiplayer=True,  tunnel=False  (LAN preview proxy)
      - tunnel: multiplayer=True,  tunnel=True   (public via cloudflared)
    """
    global _MULTIPLAYER_MODE, _TUNNEL_MODE, AUTH_TOKEN, _runtime_tunnel_url, _tunnel_proc
    ctx = get_auth(request)
    if not ctx.is_owner:
        return web.json_response({"error": "owner only"}, status=403)
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        body = {}
    mode = (body.get("mode") or "").strip().lower()
    if mode not in ("off", "local", "tunnel"):
        return web.json_response(
            {"error": "mode must be one of: off, local, tunnel"}, status=400,
        )

    target_multiplayer = mode in ("local", "tunnel")
    target_tunnel = mode == "tunnel"

    # Tear down cloudflared when leaving tunnel mode.
    if not target_tunnel and _tunnel_proc and _tunnel_proc.returncode is None:
        proc = _tunnel_proc
        _tunnel_proc = None
        _runtime_tunnel_url = None
        async def _kill():
            try:
                proc.terminate()
                await asyncio.wait_for(proc.wait(), timeout=3)
            except Exception:
                try: proc.kill()
                except Exception: pass
        _fire_and_forget(_kill())

    _MULTIPLAYER_MODE = target_multiplayer
    _TUNNEL_MODE = target_tunnel

    if target_tunnel and not (_tunnel_proc and _tunnel_proc.returncode is None):
        import shutil as _shutil
        if not _shutil.which("cloudflared"):
            _TUNNEL_MODE = False
            return web.json_response(
                {
                    "ok": False,
                    "error": "cloudflared is not installed. Install with: brew install cloudflare/cloudflare/cloudflared",
                },
                status=500,
            )
        if not AUTH_TOKEN:
            AUTH_TOKEN = _generate_token()
            logger.info("Auto-generated AUTH_TOKEN for runtime tunnel")
        bind_port = int(os.environ.get("PORT") or 5111)
        url = await _start_cloudflare_tunnel(bind_port)
        if not url:
            _TUNNEL_MODE = False
            return web.json_response(
                {
                    "ok": False,
                    "error": "cloudflared started but no tunnel URL was emitted within 60s. Check network access and try again.",
                },
                status=500,
            )
        _runtime_tunnel_url = url
        _fire_and_forget(_ensure_frontend_built())

    proc_alive = _tunnel_proc is not None and _tunnel_proc.returncode is None
    return web.json_response({
        "ok": True,
        "mode": mode,
        "multiplayer": {"enabled": _MULTIPLAYER_MODE},
        "tunnel": {
            "running": proc_alive,
            "url": _runtime_tunnel_url if proc_alive else None,
            "token": AUTH_TOKEN if (proc_alive and AUTH_TOKEN) else None,
        },
    })


async def runtime_multiplayer_toggle_handler(request: web.Request) -> web.Response:
    """POST /api/runtime/multiplayer — body {enabled: bool}.

    Flipping multiplayer at runtime only changes the soft gate that
    `_should_serve_preview` checks. The route is mounted at boot if
    EITHER tunnel or multiplayer was set; if neither was set at boot
    the preview proxy is not on the router and re-enabling here only
    flips the flag so the app advertises multiplayer features."""
    global _MULTIPLAYER_MODE
    ctx = get_auth(request)
    if not ctx.is_owner:
        return web.json_response({"error": "owner only"}, status=403)
    try:
        body = await request.json()
    except Exception:
        body = {}
    enabled = bool(body.get("enabled"))
    _MULTIPLAYER_MODE = enabled
    return web.json_response({"ok": True, "enabled": _MULTIPLAYER_MODE})


async def catchup_handler(request: web.Request) -> web.Response:
    """GET /api/catchup?since=&until=&workspace_id=&limit=&llm=&model=&cli=

    Returns a structured digest of events the caller missed. The `summary`
    field is an LLM-generated 2-4 sentence briefing by default; pass
    `?llm=false` to get the deterministic count summary. `summary_basic`
    always carries the deterministic fallback.
    """
    import catchup
    ctx = get_auth(request)
    since = request.query.get("since")
    until = request.query.get("until")
    workspace_id = request.query.get("workspace_id")
    try:
        limit = int(request.query.get("limit", "500"))
    except ValueError:
        limit = 500
    use_llm = request.query.get("llm", "true").lower() not in ("0", "false", "no")
    include_commits = request.query.get("commits", "true").lower() not in ("0", "false", "no")
    include_memory = request.query.get("memory", "true").lower() not in ("0", "false", "no")
    llm_model = request.query.get("model", "haiku")
    # Infer cli from the model id when the caller didn't pin one.
    # Keeps the frontend single-string (one model setting drives both).
    llm_cli = request.query.get("cli") or (
        "gemini" if str(llm_model).lower().startswith("gemini") else "claude"
    )
    digest = await catchup.build_digest(
        since_iso=since,
        until_iso=until,
        mode=ctx.mode,
        workspace_id=workspace_id,
        limit=limit,
        use_llm=use_llm,
        llm_cli=llm_cli,
        llm_model=llm_model,
        include_commits=include_commits,
        include_memory=include_memory,
    )
    return web.json_response(digest)


async def push_subscribe_handler(request: web.Request) -> web.Response:
    """POST /api/push/subscribe — register a Web Push endpoint."""
    import push
    ctx = get_auth(request)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    endpoint = (body or {}).get("endpoint")
    keys = (body or {}).get("keys") or {}
    p256dh = keys.get("p256dh")
    auth = keys.get("auth")
    if not (endpoint and p256dh and auth):
        return web.json_response({"error": "endpoint+keys required"}, status=400)
    sub = await push.upsert_subscription(
        actor_kind=ctx.actor_kind,
        actor_id=ctx.actor_id,
        endpoint=endpoint,
        p256dh=p256dh,
        auth=auth,
        user_agent=request.headers.get("User-Agent"),
    )
    return web.json_response({"ok": True, "subscription": sub})


async def push_unsubscribe_handler(request: web.Request) -> web.Response:
    """POST /api/push/unsubscribe — drop a Web Push endpoint."""
    import push
    ctx = get_auth(request)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    endpoint = (body or {}).get("endpoint", "").strip()
    if not endpoint:
        return web.json_response({"error": "endpoint required"}, status=400)
    removed = await push.remove_subscription(
        actor_kind=ctx.actor_kind,
        actor_id=ctx.actor_id,
        endpoint=endpoint,
    )
    return web.json_response({"ok": True, "removed": bool(removed)})


async def push_vapid_pubkey_handler(request: web.Request) -> web.Response:
    """GET /api/push/vapid-pubkey — public key for frontend subscribe()."""
    import push
    pk = push.get_public_key()
    return web.json_response({"public_key": pk, "configured": bool(pk)})


# ─── PR 2: Owner device pairing (Ed25519) ────────────────────────────────


async def device_pair_init_handler(request: web.Request) -> web.Response:
    """POST /api/devices/pair-init — owner registers a new device pubkey
    and gets a fresh challenge nonce. Body: {label, public_key}."""
    import devices
    ctx = get_auth(request)
    if not ctx.is_owner:
        return web.json_response({"error": "owner only"}, status=403)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    label = (body.get("label") or "").strip()
    pubkey = (body.get("public_key") or "").strip()
    if not (label and pubkey):
        return web.json_response({"error": "label+public_key required"}, status=400)
    try:
        device, nonce, expires = await devices.pair_init(
            label=label,
            public_key_b64url=pubkey,
            user_agent=request.headers.get("User-Agent"),
        )
    except ValueError as e:
        return web.json_response({"error": "invalid_key", "message": str(e)}, status=400)
    except PermissionError as e:
        return web.json_response({"error": "revoked", "message": str(e)}, status=403)
    return web.json_response({
        "device_id": device.id,
        "fingerprint": device.fingerprint,
        "challenge_nonce": nonce,
        "expires_at": expires.isoformat(),
    })


async def device_challenge_handler(request: web.Request) -> web.Response:
    """GET /api/devices/{id}/challenge — issue a fresh nonce for an
    already-paired device. Unauth (the signature is the auth)."""
    import devices
    device_id = (request.match_info.get("id") or "").strip()
    if not device_id:
        return web.json_response({"error": "missing id"}, status=400)
    try:
        nonce, expires = await devices.issue_challenge(device_id)
    except LookupError:
        return web.json_response({"error": "not_found"}, status=404)
    except PermissionError as e:
        return web.json_response({"error": "revoked", "message": str(e)}, status=403)
    return web.json_response({"challenge_nonce": nonce, "expires_at": expires.isoformat()})


async def device_pair_complete_handler(request: web.Request) -> web.Response:
    """POST /api/devices/pair-complete — verify Ed25519 signature over
    the challenge nonce and mint an owner-device joiner_sessions row.
    Body: {device_id, nonce, signed_nonce}."""
    import devices
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    device_id = (body.get("device_id") or "").strip()
    nonce = (body.get("nonce") or "").strip()
    signed = (body.get("signed_nonce") or "").strip()
    if not (device_id and nonce and signed):
        return web.json_response({"error": "device_id+nonce+signed_nonce required"}, status=400)

    peername = request.transport.get_extra_info("peername")
    remote_ip = peername[0] if peername else "unknown"

    try:
        device = await devices.pair_complete(
            device_id=device_id, nonce=nonce, signed_nonce_b64url=signed,
        )
    except LookupError:
        return web.json_response({"error": "not_found"}, status=404)
    except PermissionError as e:
        await bus.emit(
            CommanderEvent.INVITE_REDEEM_FAILED,
            {"reason": "device_pair_failed", "device_id": device_id, "remote_ip": remote_ip,
             "message": str(e)},
            source="commander",
        )
        return web.json_response({"error": "auth_failed", "message": str(e)}, status=401)
    except ValueError as e:
        return web.json_response({"error": "invalid_signature", "message": str(e)}, status=400)

    # Mint a joiner_sessions row tied to this device. Owner-equivalent.
    cookie_value, sess = await _joiner_sessions.create_session(
        mode="full",
        actor_kind="owner_device",
        ttl_seconds=devices.DEVICE_BEARER_TTL_SECONDS,
        label=device.label,
        device_id=device.id,
        last_ip=remote_ip,
        last_user_agent=request.headers.get("User-Agent"),
    )

    await bus.emit(
        CommanderEvent.DEVICE_PAIRED,
        {"device_id": device.id, "fingerprint": device.fingerprint,
         "label": device.label, "session_id": sess.id, "remote_ip": remote_ip},
        source="commander",
    )
    await bus.emit(
        CommanderEvent.SESSION_MINTED,
        {"session_id": sess.id, "actor_kind": sess.actor_kind, "mode": sess.mode,
         "device_id": device.id},
        source="commander",
    )

    payload = {
        "ok": True,
        "session_id": sess.id,
        "device_id": device.id,
        "mode": sess.mode,
        "expires_at": sess.expires_at,
        "session_token": cookie_value,  # also returned for non-cookie clients
    }
    resp = web.json_response(payload)
    resp.set_cookie(_auth_context.SESSION_COOKIE, cookie_value, **_make_cookie_params(request))
    resp.del_cookie(_auth_context.LEGACY_COOKIE)
    return resp


async def list_devices_handler(request: web.Request) -> web.Response:
    """GET /api/devices — owner-only list of paired devices (active + revoked)."""
    import devices
    ctx = get_auth(request)
    if not ctx.is_owner:
        return web.json_response({"error": "owner only"}, status=403)
    rows = await devices.list_devices()
    return web.json_response({"devices": rows})


async def revoke_device_handler(request: web.Request) -> web.Response:
    """POST /api/devices/{id}/revoke — owner-only. Cascades to joiner_sessions."""
    import devices
    ctx = get_auth(request)
    if not ctx.is_owner:
        return web.json_response({"error": "owner only"}, status=403)
    device_id = (request.match_info.get("id") or "").strip()
    if not device_id:
        return web.json_response({"error": "missing id"}, status=400)
    revoked = await devices.revoke_device(device_id)
    if revoked:
        await bus.emit(
            CommanderEvent.DEVICE_UNPAIRED,
            {"device_id": device_id, "revoked_by": ctx.actor_kind},
            source="commander",
        )
    return web.json_response({"ok": True, "revoked": bool(revoked)})


# ─── Cloudflare-tunnel-aware preview proxy ──────────────────────────────
# Forwards `GET /preview/<port>/<path>` to `http://127.0.0.1:<port>/<path>` so
# tunnel/multiplayer collaborators can view localhost dev servers running on
# the host. HTML responses get a `<base href>` injected so root-relative
# assets resolve under the `/preview/<port>/` prefix.

_PREVIEW_PROXY_DENY_PORTS = {
    5111,   # backend itself
    5173,   # Vite dev server (frontend)
    22,     # ssh
    3306,   # MySQL
    5432,   # PostgreSQL
    6379,   # Redis
    27017,  # MongoDB
}
_PREVIEW_PROXY_TIMEOUT = 30  # seconds, applied per upstream request
# Headers that should not be relayed upstream — hop-by-hop and tunnel artifacts.
_PREVIEW_PROXY_STRIP_REQ_HEADERS = {
    "host", "connection", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade",
}
# Response headers we drop because aiohttp's StreamResponse manages framing,
# OR because they would block embedding the proxied dev server in IVE's
# same-origin iframe (LivePreview). The CSP middleware also force-overwrites
# the security headers on /preview/* paths, but stripping at the proxy
# level keeps the response object clean so a downstream handler doesn't
# accidentally read the upstream values.
_PREVIEW_PROXY_STRIP_RESP_HEADERS = {
    "content-length", "content-encoding", "transfer-encoding", "connection",
    "keep-alive",
    "x-frame-options",
    "content-security-policy",
    "content-security-policy-report-only",
}


def _preview_port_allowed(port: int) -> bool:
    if port < 1024 or port > 65535:
        return False
    if port in _PREVIEW_PROXY_DENY_PORTS:
        return False
    return True


async def proxy_localhost(request: web.Request) -> web.StreamResponse:
    """Reverse-proxy a request to `127.0.0.1:<port>/<path>`.

    Streams the upstream response back so SSE / large assets work. For
    `text/html` responses a `<base href="/preview/<port>/">` tag is injected
    so root-relative URLs resolve back through the proxy.
    """
    # Live-gated on the runtime flags so toggling tunnel/multiplayer at
    # runtime actually opens up the preview proxy without restart. The
    # disabled-mode handler is still mounted as a fallback when neither
    # tunnel nor multiplayer was set at boot AND no client session has
    # one — see route registration below.
    if not (_TUNNEL_MODE or _MULTIPLAYER_MODE):
        return web.json_response(
            {
                "error": "preview proxy is disabled — enable tunnel or multiplayer "
                         "from Settings → Tunnel & Multiplayer first",
            },
            status=403,
        )
    port_str = request.match_info.get("port", "")
    try:
        port = int(port_str)
    except ValueError:
        return web.json_response({"error": "invalid port"}, status=400)
    if not _preview_port_allowed(port):
        return web.json_response(
            {"error": f"port {port} is not allowed by the preview proxy"},
            status=403,
        )

    path = request.match_info.get("path", "")
    upstream_path = "/" + path if path else "/"

    # Build upstream URL — explicitly hard-pinned to 127.0.0.1, never an
    # arbitrary host. Preserve query string verbatim.
    upstream_url = f"http://127.0.0.1:{port}{upstream_path}"
    if request.query_string:
        upstream_url = f"{upstream_url}?{request.query_string}"

    # WebSocket upgrade → return 501 for now. Bidirectional WS pumping is
    # tracked as a TODO; the HTML/HTTP path is the priority and most dev
    # servers (Vite, Next.js) gracefully degrade without the WS channel.
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return web.json_response(
            {"error": "websocket proxying not yet implemented"},
            status=501,
        )

    # Build upstream headers: drop hop-by-hop, Cloudflare tunnel artifacts,
    # and pin Host to the loopback target so virtual-hosted upstreams see
    # the right name.
    upstream_headers: dict[str, str] = {}
    for name, value in request.headers.items():
        lname = name.lower()
        if lname in _PREVIEW_PROXY_STRIP_REQ_HEADERS:
            continue
        if lname.startswith("cf-"):
            continue
        upstream_headers[name] = value
    upstream_headers["Host"] = f"127.0.0.1:{port}"

    session: aiohttp.ClientSession = request.app.get("preview_proxy_session")
    if session is None:
        # Lazily create the upstream session — it's only built at startup
        # when --tunnel/--multiplayer was set at boot, but a runtime toggle
        # can flip the flags later. Build on first preview request so that
        # works without a server restart.
        session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=_PREVIEW_PROXY_TIMEOUT),
            auto_decompress=False,
        )
        request.app["preview_proxy_session"] = session

    # Stream the request body so large uploads don't buffer in memory.
    has_body = request.method not in {"GET", "HEAD", "OPTIONS"}
    body = request.content if has_body else None
    timeout = aiohttp.ClientTimeout(total=_PREVIEW_PROXY_TIMEOUT)

    try:
        upstream = await session.request(
            request.method,
            upstream_url,
            headers=upstream_headers,
            data=body,
            allow_redirects=False,
            timeout=timeout,
        )
    except (aiohttp.ClientConnectorError, aiohttp.ServerDisconnectedError,
            aiohttp.ClientOSError, asyncio.TimeoutError) as e:
        return web.json_response(
            {"error": "upstream connection failed",
             "detail": str(e), "port": port},
            status=502,
        )
    except aiohttp.ClientError as e:
        return web.json_response(
            {"error": "upstream request failed",
             "detail": str(e), "port": port},
            status=502,
        )

    try:
        content_type = (upstream.headers.get("Content-Type") or "").lower()
        is_html = content_type.startswith("text/html")

        # ── Text/HTML branch — buffer + rewrite ──────────────────────
        # We need the full body to inject <base href> reliably, so for HTML
        # we read it eagerly. Streaming would be possible but the rewrite
        # is fragile if <head> spans chunk boundaries.
        if is_html:
            try:
                raw = await upstream.read()
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                return web.json_response(
                    {"error": "upstream read failed",
                     "detail": str(e), "port": port},
                    status=502,
                )

            base_tag = f'<base href="/preview/{port}/">'.encode()
            # Inject right after opening <head> tag (case-insensitive). Fall
            # back to "before the first '<' in body" if no <head> found —
            # tolerates fragments and stripped-down html.
            head_match = _re.search(rb"<head[^>]*>", raw, _re.IGNORECASE)
            if head_match:
                idx = head_match.end()
                rewritten = raw[:idx] + base_tag + raw[idx:]
            else:
                first_lt = raw.find(b"<")
                if first_lt >= 0:
                    rewritten = raw[:first_lt] + base_tag + raw[first_lt:]
                else:
                    rewritten = base_tag + raw

            resp = web.StreamResponse(status=upstream.status)
            for name, value in upstream.headers.items():
                if name.lower() in _PREVIEW_PROXY_STRIP_RESP_HEADERS:
                    continue
                resp.headers[name] = value
            resp.content_length = len(rewritten)
            await resp.prepare(request)
            await resp.write(rewritten)
            await resp.write_eof()
            return resp

        # ── Streaming pass-through for everything else ───────────────
        resp = web.StreamResponse(status=upstream.status)
        for name, value in upstream.headers.items():
            if name.lower() in _PREVIEW_PROXY_STRIP_RESP_HEADERS:
                continue
            resp.headers[name] = value
        # SSE / chunked: don't set Content-Length, let aiohttp chunk-encode.
        await resp.prepare(request)
        try:
            async for chunk in upstream.content.iter_any():
                if not chunk:
                    continue
                await resp.write(chunk)
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            logger.debug("preview proxy stream interrupted (port %s): %s", port, e)
        await resp.write_eof()
        return resp
    finally:
        upstream.release()


async def proxy_localhost_disabled(request: web.Request) -> web.Response:
    """Stub used in single-player local mode — preview proxy is unnecessary
    because collaborators always reach localhost directly."""
    return web.json_response(
        {"error": "preview proxy is only available in --tunnel or "
                  "--multiplayer mode"},
        status=404,
    )


async def on_startup(app: web.Application):
    # Shared aiohttp session for the preview proxy. Only created when the
    # proxy is actually mounted, but we always assign to keep handler code
    # simple.
    if _TUNNEL_MODE or _MULTIPLAYER_MODE:
        app["preview_proxy_session"] = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=_PREVIEW_PROXY_TIMEOUT),
            auto_decompress=False,  # passthrough compressed bytes
        )

    await init_db()

    # Hydrate os.environ with DB-stored API keys so in-process code that
    # reads env vars directly (peer_comms _build_workspace, ticket/knowledge
    # indexers, model libs) honors keys configured in the IVE settings UI
    # without each module having to call api_keys.resolve itself.
    try:
        import api_keys as _api_keys_startup
        env_overrides = await _api_keys_startup.resolve_env_overrides()
        for _k, _v in env_overrides.items():
            os.environ[_k] = _v
        if env_overrides:
            logger.info(
                "Hydrated %d API key(s) from app_settings into os.environ",
                len(env_overrides),
            )
    except Exception as e:
        logger.debug("API-key env hydration skipped: %s", e)

    pty_mgr.on_output(handle_pty_output)
    pty_mgr.on_output(capture_proc.process)
    pty_mgr.on_exit(handle_pty_exit)

    # ── Dynamic model discovery ────────────────────────────────────
    global _discovered_models
    try:
        from model_discovery import discover_all
        _discovered_models = await _asyncio.to_thread(discover_all)
        for cli, models in _discovered_models.items():
            if models:
                logger.info("Discovered %d %s models dynamically", len(models), cli)
    except Exception as e:
        logger.debug("Model discovery skipped: %s", e)

    # ── CLI lifecycle hooks ──────────────────────────────────────────
    from config import HOOKS_ENABLED
    if HOOKS_ENABLED:
        from hooks import set_broadcast_fn, set_capture_proc, set_pty_manager as hooks_set_pty
        from hook_installer import install_all
        set_broadcast_fn(broadcast)
        set_capture_proc(capture_proc)
        hooks_set_pty(pty_mgr)
        install_all()
        logger.info("CLI hooks installed and receiver ready")

    # ── Server-side cascade runner ──────────────────────────────────
    import cascade_runner
    cascade_runner.set_pty_manager(pty_mgr)
    cascade_runner.set_broadcast_fn(broadcast)
    await cascade_runner.recover_active_runs()
    logger.info("Cascade runner initialized")

    # ── Auto-exec: event-driven task dispatch ────────────────────────
    import auto_exec
    auto_exec.set_pty_manager(pty_mgr)
    auto_exec.set_broadcast_fn(broadcast)
    auto_exec.register_subscribers()

    # ── Worker queue: per-worker task auto-delivery ────────────────
    import worker_queue
    worker_queue.set_pty_manager(pty_mgr)
    worker_queue.set_broadcast_fn(broadcast)
    worker_queue.register_subscribers()

    # ── Idle reflection: PTY-injects a save-prompt after real idle ──
    import idle_reflection
    idle_reflection.set_pty_manager(pty_mgr)
    idle_reflection.set_broadcast_fn(broadcast)
    idle_reflection.register_subscribers()

    # ── Ticket index backfill: ensure every existing task has a myelin
    # node so retrieval works on day one (not only for tasks created after
    # the indexer shipped). Runs once per workspace, in the background.
    async def _backfill_ticket_index():
        try:
            db = await get_db()
            try:
                cur = await db.execute("SELECT id FROM workspaces")
                ws_rows = await cur.fetchall()
                import knowledge_indexer as _ki
                for ws_row in ws_rows:
                    try:
                        await ticket_indexer.backfill_workspace(ws_row["id"], db)
                    except Exception as e:
                        logger.debug("ticket backfill failed for %s: %s", ws_row["id"], e)
                    try:
                        await _ki.backfill_workspace(ws_row["id"], db)
                    except Exception as e:
                        logger.debug("knowledge backfill failed for %s: %s", ws_row["id"], e)
            finally:
                await db.close()
        except Exception as e:
            logger.debug("ticket backfill scheduler skipped: %s", e)
    asyncio.create_task(_backfill_ticket_index())

    # ── Board-doc backstop: hourly sweep that documents finished work
    # for sessions whose agent didn't call document_to_board themselves.
    import board_doc_backstop
    board_doc_backstop.set_broadcast_fn(broadcast)
    await board_doc_backstop.start(app)
    app.on_cleanup.append(board_doc_backstop.stop)

    # ── Pipeline: implement → test → document loop ──────────────────
    import pipeline
    pipeline.set_pty_manager(pty_mgr)
    pipeline.set_broadcast_fn(broadcast)
    pipeline.register_subscribers()

    # ── Pipeline Engine: configurable graph-based pipelines ──────────
    import pipeline_engine
    pipeline_engine.set_pty_manager(pty_mgr)
    pipeline_engine.set_broadcast_fn(broadcast)
    pipeline_engine.set_pty_start_fn(_autostart_session_pty)
    pipeline_engine.register_subscribers()
    await pipeline_engine.ensure_presets()
    await pipeline_engine.recover_active_runs()

    # ── Demo runner: per-workspace stable preview build ─────────────
    _demo_runner.set_broadcast_fn(broadcast)

    # ── Research scheduler (cron-like recurring research) ───────────
    global _research_scheduler_task
    _research_scheduler_task = _asyncio.ensure_future(_research_scheduler_loop())
    logger.info("Research scheduler started")

    # ── Telemetry (anonymous startup + daily heartbeat) ─────────────
    import telemetry
    telemetry.start_background()

    # ── Session supervisor: PTY health monitor + auto-restart ───────
    import session_supervisor
    session_supervisor.set_pty_manager(pty_mgr)
    await session_supervisor.start(app)
    app.on_cleanup.append(session_supervisor.stop)

    # ── Autolearn: passive insight extraction (gated by feature flag)
    import auto_learn
    await auto_learn.start(app)
    app.on_cleanup.append(auto_learn.stop)

    async def store_and_broadcast_capture(session_id: str, capture: dict):
        """Store capture in DB and broadcast via WebSocket."""
        db = await get_db()
        try:
            await db.execute(
                """INSERT INTO output_captures (session_id, capture_type, tool_name, raw_text, status)
                   VALUES (?, ?, ?, ?, ?)""",
                (session_id, capture.get("capture_type"), capture.get("tool_name"),
                 capture.get("raw_text"), capture.get("status", "pending")),
            )
            await db.commit()
        finally:
            await db.close()
        await broadcast({
            "type": "capture",
            "session_id": session_id,
            "capture": capture,
        })

        # Context-low pre-warning → dedicated event for the UI indicator.
        # Fired by output_capture when "Context left until auto-compact: N%"
        # crosses the warn threshold. Drives the same yellow/orange tab
        # indicator system as PreCompact/PostCompact hooks.
        if capture.get("capture_type") == "context_low":
            await broadcast({
                "type": "context_low",
                "session_id": session_id,
                "percent_left": capture.get("percent_left"),
            })

        # Quota exceeded → try auto-failover if enabled, else mark + notify
        if capture.get("capture_type") == "quota_exceeded":
            auto_cycled = False
            try:
                from auth_cycler import auth_cycler as _ac, _is_feature_enabled
                if await _is_feature_enabled():
                    result = await _ac.auto_failover(session_id)
                    if result:
                        auto_cycled = True
                        # Stop current PTY — frontend will auto-restart
                        await pty_mgr.stop_session(session_id)
                        await broadcast({
                            "type": "account_switched",
                            "session_id": session_id,
                            "old_account_id": result["old_account_id"],
                            "old_account_name": result["old_account_name"],
                            "new_account_id": result["new_account_id"],
                            "new_account_name": result["new_account_name"],
                            "message": f"Auto-cycled: {result['old_account_name']} → {result['new_account_name']}",
                        })
            except Exception as e:
                logger.error("Auto auth cycling failed: %s", e, exc_info=True)

            if not auto_cycled:
                # Manual fallback: just mark account + notify
                db2 = await get_db()
                try:
                    cur2 = await db2.execute("SELECT account_id FROM sessions WHERE id = ?", (session_id,))
                    row2 = await cur2.fetchone()
                    if row2 and row2["account_id"]:
                        await db2.execute(
                            "UPDATE accounts SET status = 'quota_exceeded', quota_reset_at = datetime('now', '+4 hours') WHERE id = ?",
                            (row2["account_id"],),
                        )
                        await db2.commit()
                finally:
                    await db2.close()
                await broadcast({
                    "type": "quota_exceeded",
                    "session_id": session_id,
                    "message": capture.get("raw_text", "Quota exceeded"),
                })

    capture_proc.on_capture(store_and_broadcast_capture)

    # ── Observatory: automated ecosystem scanner ─────────────────────
    import observatory
    await observatory.scheduler.start()

    logger.info(f"IVE v{VERSION} backend on http://{HOST}:{PORT}")


async def on_cleanup(app: web.Application):
    await pty_mgr.stop_all()
    try:
        import observatory
        await observatory.scheduler.stop()
    except Exception:
        pass
    try:
        import preview_browser
        await preview_browser.shutdown()
    except Exception:
        pass
    try:
        await _demo_runner.shutdown_all()
    except Exception:
        pass
    proxy_session = app.get("preview_proxy_session")
    if proxy_session is not None:
        try:
            await proxy_session.close()
        except Exception:
            pass
    for ws in list(ws_clients):
        await ws.close()


# ─── REST: Agent Skills ───────────────────────────────────────────────────

async def list_agent_skills(request: web.Request) -> web.Response:
    """List available skills from the Agent Skills ecosystem."""
    from skills_client import fetch_skills_index
    skills = await fetch_skills_index()
    # Strip full content from index (keep it lightweight)
    return web.json_response([
        {k: v for k, v in s.items() if k != "content"} for s in skills
    ])


async def get_agent_skill(request: web.Request) -> web.Response:
    """Get a single skill's full content."""
    skill_path = request.match_info["path"]
    repo = request.query.get("repo", "anthropics/skills")
    from skills_client import fetch_skill_content
    skill = await fetch_skill_content(skill_path, repo=repo)
    if not skill:
        return web.json_response({"error": "skill not found"}, status=404)
    return web.json_response(skill)


async def install_agent_skill(request: web.Request) -> web.Response:
    """Install a skill to disk for native CLI discovery."""
    from skill_installer import install_skill
    body = await request.json()
    name = body.get("name", "").strip()
    content = body.get("content", "").strip()
    if not name or not content:
        return web.json_response({"error": "name and content required"}, status=400)

    # Determine workspace path from query or body
    workspace_path = body.get("workspace_path")
    if not workspace_path:
        # Try to get from active workspace
        ws_id = body.get("workspace_id")
        if ws_id:
            db = await get_db()
            try:
                cur = await db.execute("SELECT path FROM workspaces WHERE id = ?", (ws_id,))
                row = await cur.fetchone()
                if row:
                    workspace_path = row["path"]
            finally:
                await db.close()

    cli_types = body.get("cli_types", ["claude", "gemini"])
    scope = body.get("scope", "project")

    results = await install_skill(
        name=name,
        content=content,
        workspace_path=workspace_path,
        cli_types=cli_types,
        scope=scope,
        source_url=body.get("source_url", ""),
        repo=body.get("repo", ""),
        skill_path=body.get("skill_path", ""),
    )
    return web.json_response({"ok": True, "results": results}, status=201)


async def uninstall_agent_skill(request: web.Request) -> web.Response:
    """Remove a skill from disk."""
    from skill_installer import uninstall_skill
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        return web.json_response({"error": "name required"}, status=400)

    workspace_path = body.get("workspace_path")
    if not workspace_path:
        ws_id = body.get("workspace_id")
        if ws_id:
            db = await get_db()
            try:
                cur = await db.execute("SELECT path FROM workspaces WHERE id = ?", (ws_id,))
                row = await cur.fetchone()
                if row:
                    workspace_path = row["path"]
            finally:
                await db.close()

    cli_types = body.get("cli_types", ["claude", "gemini"])
    scope = body.get("scope", "project")

    results = await uninstall_skill(
        name=name,
        workspace_path=workspace_path,
        cli_types=cli_types,
        scope=scope,
    )
    return web.json_response({"ok": True, "results": results})


async def list_installed_skills_handler(request: web.Request) -> web.Response:
    """List skills installed on disk for all CLIs."""
    from skill_installer import list_installed_skills

    workspace_path = request.query.get("workspace_path")
    if not workspace_path:
        ws_id = request.query.get("workspace_id")
        if ws_id:
            db = await get_db()
            try:
                cur = await db.execute("SELECT path FROM workspaces WHERE id = ?", (ws_id,))
                row = await cur.fetchone()
                if row:
                    workspace_path = row["path"]
            finally:
                await db.close()

    # Default to "all" so user-scope skills (e.g. installed via /api/skills/install
    # with scope=user) appear without forcing the caller to pass ?scope=user
    # explicitly (BUG H7). Project-scope still requires a workspace_path.
    scope = request.query.get("scope", "all")
    skills = list_installed_skills(workspace_path=workspace_path, scope=scope)
    return web.json_response(skills)


async def sync_agent_skill(request: web.Request) -> web.Response:
    """Sync a skill from one CLI to another."""
    from skill_installer import sync_skill
    body = await request.json()
    name = body.get("name", "").strip()
    from_cli = body.get("from_cli", "").strip()
    to_cli = body.get("to_cli", "").strip()
    if not name or not from_cli or not to_cli:
        return web.json_response({"error": "name, from_cli, to_cli required"}, status=400)

    workspace_path = body.get("workspace_path")
    if not workspace_path:
        ws_id = body.get("workspace_id")
        if ws_id:
            db = await get_db()
            try:
                cur = await db.execute("SELECT path FROM workspaces WHERE id = ?", (ws_id,))
                row = await cur.fetchone()
                if row:
                    workspace_path = row["path"]
            finally:
                await db.close()

    scope = body.get("scope", "project")
    result = await sync_skill(
        name=name, from_cli=from_cli, to_cli=to_cli,
        workspace_path=workspace_path, scope=scope,
    )
    return web.json_response(result)


# ─── REST: Plugin marketplace ─────────────────────────────────────────────

async def search_agent_skills(request: web.Request) -> web.Response:
    """Semantic search across the skills catalog. Used by MCP tools and UI."""
    query = request.query.get("q", "").strip()
    if not query:
        return web.json_response({"error": "q parameter required"}, status=400)
    limit = int(request.query.get("limit", "5"))
    from skill_suggester import search_skills, index_status
    results = await search_skills(query, limit=limit)
    status = index_status()
    return web.json_response({"results": results, "index": status})


async def get_agent_skill_content(request: web.Request) -> web.Response:
    """Get full SKILL.md content by name. Used by MCP tools."""
    name = request.query.get("name", "").strip()
    if not name:
        return web.json_response({"error": "name parameter required"}, status=400)
    from skill_suggester import get_skill_content
    result = await get_skill_content(name)
    if not result:
        return web.json_response({"error": "skill not found"}, status=404)
    return web.json_response(result)


async def dismiss_skill_suggestion(request: web.Request) -> web.Response:
    """Dismiss a skill suggestion for a session."""
    body = await request.json()
    session_id = body.get("session_id", "")
    entity_id = body.get("entity_id", "")
    if not session_id or not entity_id:
        return web.json_response({"error": "session_id and entity_id required"}, status=400)
    from skill_suggester import dismiss_skill
    dismiss_skill(session_id, entity_id)
    return web.json_response({"ok": True})


async def list_plugin_registries(request: web.Request) -> web.Response:
    regs = await plugin_manager.list_registries()
    return web.json_response(regs)


async def add_plugin_registry(request: web.Request) -> web.Response:
    body = await request.json()
    name = (body.get("name") or "").strip()
    url = (body.get("url") or "").strip()
    if not name or not url:
        return web.json_response({"error": "name and url required"}, status=400)
    if not (url.startswith("http://") or url.startswith("https://")):
        return web.json_response({"error": "url must start with http:// or https://"}, status=400)
    try:
        reg = await plugin_manager.add_registry(name, url)
        return web.json_response(reg, status=201)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)


async def update_plugin_registry(request: web.Request) -> web.Response:
    rid = request.match_info["id"]
    body = await request.json()
    reg = await plugin_manager.update_registry(
        rid,
        name=body.get("name"),
        url=body.get("url"),
        enabled=body.get("enabled"),
    )
    if not reg:
        return web.json_response({"error": "no fields to update or registry not found"}, status=400)
    return web.json_response(reg)


async def delete_plugin_registry(request: web.Request) -> web.Response:
    rid = request.match_info["id"]
    ok = await plugin_manager.delete_registry(rid)
    if not ok:
        return web.json_response({"error": "registry not found or built-in (cannot delete)"}, status=400)
    return web.json_response({"ok": True})


async def sync_plugin_registry(request: web.Request) -> web.Response:
    rid = request.match_info["id"]
    result = await plugin_manager.sync_registry(rid)
    if result.get("ok"):
        await bus.emit(CommanderEvent.REGISTRY_SYNCED, {
            "registry_id": rid,
            "plugin_count": result.get("plugin_count", 0),
        }, source="api", actor="user")
        return web.json_response(result, status=200)
    await bus.emit(CommanderEvent.REGISTRY_SYNC_FAILED, {
        "registry_id": rid,
        "error": result.get("error"),
    }, source="api", actor="user")
    return web.json_response(result, status=502)


async def sync_all_plugin_registries(request: web.Request) -> web.Response:
    regs = await plugin_manager.list_registries()
    results = []
    for reg in regs:
        if not reg.get("enabled"):
            continue
        result = await plugin_manager.sync_registry(reg["id"])
        results.append({"registry_id": reg["id"], "name": reg["name"], **result})
    return web.json_response({"results": results})


async def list_plugins_handler(request: web.Request) -> web.Response:
    installed_only = request.query.get("installed") == "1"
    registry_id = request.query.get("registry") or None
    plugins = await plugin_manager.list_plugins(
        installed_only=installed_only, registry_id=registry_id
    )
    return web.json_response(plugins)


async def get_plugin_handler(request: web.Request) -> web.Response:
    plugin_id = request.match_info["id"]
    plugin = await plugin_manager.get_plugin(plugin_id)
    if not plugin:
        return web.json_response({"error": "plugin not found"}, status=404)
    return web.json_response(plugin)


async def install_plugin_handler(request: web.Request) -> web.Response:
    plugin_id = request.match_info["id"]
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    skip_scripts = bool(body.get("skip_scripts"))
    result = await plugin_manager.install_plugin(plugin_id, skip_scripts=skip_scripts)
    if result.get("ok"):
        await bus.emit(CommanderEvent.PLUGIN_INSTALLED, {
            "plugin_id": plugin_id,
            "skip_scripts": skip_scripts,
            "skipped_components": result.get("skipped") or [],
        }, source="api", actor="user")
        return web.json_response(result, status=200)
    return web.json_response(result, status=400)


async def uninstall_plugin_handler(request: web.Request) -> web.Response:
    plugin_id = request.match_info["id"]
    ok = await plugin_manager.uninstall_plugin(plugin_id)
    if not ok:
        return web.json_response({"error": "plugin not found"}, status=404)
    await bus.emit(CommanderEvent.PLUGIN_UNINSTALLED, {
        "plugin_id": plugin_id,
    }, source="api", actor="user")
    return web.json_response({"ok": True})


async def get_session_plugin_components(request: web.Request) -> web.Response:
    session_id = request.match_info["id"]
    if not await _session_exists(session_id):
        return web.json_response({"error": "session not found"}, status=404)
    comps = await plugin_manager.get_session_components(session_id)
    return web.json_response(comps)


async def set_session_plugin_components(request: web.Request) -> web.Response:
    session_id = request.match_info["id"]
    body = await request.json()
    component_ids = body.get("component_ids") or []
    count = await plugin_manager.set_session_components(session_id, component_ids)
    return web.json_response({"ok": True, "count": count})


# ── W2W: Similar task search ──────────────────────────────────────────────

async def find_similar_tasks(request: web.Request) -> web.Response:
    """Find completed tasks similar to a query — uses embedding cosine with LIKE fallback."""
    query = (request.query.get("q") or "").strip()
    if not query:
        return web.json_response({"error": "q query param required"}, status=400)
    workspace_id = request.query.get("workspace_id")
    limit = int(request.query.get("limit", "10"))

    # Try semantic search first
    try:
        from embedder import search_similar
        semantic_results = await search_similar(
            query, entity_type="task", workspace_id=workspace_id,
            limit=limit, min_score=0.35,
        )
        if semantic_results:
            # Fetch full task data for matching entity_ids
            task_ids = [r["entity_id"] for r in semantic_results]
            scores = {r["entity_id"]: r["score"] for r in semantic_results}
            db = await get_db()
            try:
                placeholders = ",".join("?" for _ in task_ids)
                cur = await db.execute(
                    f"""SELECT id, workspace_id, title, description, status, result_summary,
                               lessons_learned, important_notes, labels, completed_at
                        FROM tasks WHERE id IN ({placeholders})""",
                    task_ids,
                )
                rows = await cur.fetchall()
                results = []
                for row in rows:
                    d = dict(row)
                    d["similarity_score"] = scores.get(d["id"], 0)
                    results.append(d)
                results.sort(key=lambda r: r["similarity_score"], reverse=True)
                return web.json_response(results)
            finally:
                await db.close()
    except Exception:
        pass  # fall through to keyword search

    # Fallback: keyword LIKE search
    db = await get_db()
    try:
        keywords = [w.strip() for w in query.split() if len(w.strip()) >= 2]
        if not keywords:
            return web.json_response([])

        conditions = []
        params: list = []
        for kw in keywords[:8]:
            like = f"%{kw}%"
            conditions.append(
                "(title LIKE ? OR description LIKE ? OR result_summary LIKE ? "
                "OR lessons_learned LIKE ? OR important_notes LIKE ?)"
            )
            params.extend([like, like, like, like, like])

        sql = f"""SELECT id, workspace_id, title, description, status, result_summary,
                         lessons_learned, important_notes, labels, completed_at
                  FROM tasks
                  WHERE status IN ('done', 'review', 'verified')
                    AND ({' OR '.join(conditions)})"""
        if workspace_id:
            sql += " AND workspace_id = ?"
            params.append(workspace_id)
        sql += " ORDER BY completed_at DESC LIMIT ?"
        params.append(limit)

        cur = await db.execute(sql, params)
        rows = await cur.fetchall()
        results = []
        for row in rows:
            d = dict(row)
            text = " ".join(str(d.get(c) or "") for c in ("title", "description", "result_summary", "lessons_learned"))
            hits = sum(1 for kw in keywords if kw.lower() in text.lower())
            d["relevance_hits"] = hits
            results.append(d)
        results.sort(key=lambda r: r["relevance_hits"], reverse=True)
        return web.json_response(results)
    finally:
        await db.close()


async def find_related_tickets(request: web.Request) -> web.Response:
    """Myelin-backed ticket retrieval. Different from find_similar_tasks
    (keyword/embedder) — this is the dedicated index for *open* work that
    powers dedup-on-create and the drift gate.

    POST body or GET query string accepted:
      {query, files_touched=[], status_filter="open"|"all"|<status>|[<...>],
       exclude_task_id=null, limit=10}
    """
    if request.method == "POST":
        body = await request.json()
    else:
        body = {
            "query": request.query.get("q") or request.query.get("query") or "",
            "limit": int(request.query.get("limit", "10")),
        }
    workspace_id = request.match_info.get("workspace_id") or body.get("workspace_id")
    if not workspace_id:
        return web.json_response({"error": "workspace_id required"}, status=400)
    query = (body.get("query") or "").strip()
    if not query:
        return web.json_response({"error": "query required"}, status=400)

    import ticket_retriever
    candidates = await ticket_retriever.find_related(
        workspace_id=workspace_id,
        query=query,
        files_touched=body.get("files_touched") or [],
        status_filter=body.get("status_filter"),
        exclude_task_id=body.get("exclude_task_id"),
        limit=int(body.get("limit", 10)),
    )
    return web.json_response({"candidates": [c.to_dict() for c in candidates]})


# ── W2W: Similar sessions search ─────────────────────────────────────────

async def find_similar_sessions(request: web.Request) -> web.Response:
    """Find sessions with similar work — uses digest embeddings."""
    query = (request.query.get("q") or "").strip()
    if not query:
        return web.json_response({"error": "q query param required"}, status=400)
    workspace_id = request.query.get("workspace_id")
    exclude = request.query.get("exclude_session")
    limit = int(request.query.get("limit", "10"))

    try:
        from embedder import search_similar
        results = await search_similar(
            query, entity_type="digest", workspace_id=workspace_id,
            limit=limit, min_score=0.35, exclude_id=exclude,
        )
        if not results:
            return web.json_response([])

        # Enrich with session info
        session_ids = [r["entity_id"] for r in results]
        scores = {r["entity_id"]: r["score"] for r in results}
        db = await get_db()
        try:
            placeholders = ",".join("?" for _ in session_ids)
            cur = await db.execute(
                f"""SELECT s.id, s.name, s.status, s.model, s.cli_type, s.workspace_id,
                           d.task_summary, d.current_focus, d.files_touched,
                           d.decisions, d.discoveries
                    FROM sessions s
                    LEFT JOIN session_digests d ON s.id = d.session_id
                    WHERE s.id IN ({placeholders})""",
                session_ids,
            )
            rows = await cur.fetchall()
            enriched = []
            for row in rows:
                d = dict(row)
                d["similarity_score"] = scores.get(d["id"], 0)
                for jf in ("files_touched", "decisions", "discoveries"):
                    d[jf] = _parse_json_field(d.get(jf))
                enriched.append(d)
            enriched.sort(key=lambda r: r["similarity_score"], reverse=True)
            return web.json_response(enriched)
        finally:
            await db.close()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ── W2W: Coordination overlap check ─────────────────────────────────────

async def check_coordination_overlap(request: web.Request) -> web.Response:
    """Check if a session's intent overlaps with active peers (Myelin-inspired)."""
    ws_id = request.match_info["id"]
    body = await request.json()
    intent = (body.get("intent") or "").strip()
    exclude_session = body.get("exclude_session")
    if not intent:
        return web.json_response({"error": "intent required"}, status=400)

    try:
        from embedder import check_overlap
        overlaps = await check_overlap(intent, ws_id, exclude_session)
        return web.json_response(overlaps)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ── W2W: Unified memory search ───────────────────────────────────────────

async def unified_memory_search(request: web.Request) -> web.Response:
    """Search across all W2W memory types: tasks, digests, knowledge, messages, file activity.

    Returns results grouped by type, each with relevance scores.
    Uses embedding cosine search with keyword fallback per type.
    """
    ws_id = request.match_info["id"]
    query = (request.query.get("q") or "").strip()
    if not query:
        return web.json_response({"error": "q query param required"}, status=400)
    types_param = request.query.get("types", "tasks,digests,knowledge,messages")
    requested = set(t.strip() for t in types_param.split(","))
    limit_per = int(request.query.get("limit", "5"))

    result: dict = {}

    # 1. Tasks (semantic + keyword fallback)
    if "tasks" in requested:
        try:
            from embedder import search_similar
            sem = await search_similar(query, "task", ws_id, limit=limit_per, min_score=0.35)
            if sem:
                task_ids = [r["entity_id"] for r in sem]
                scores = {r["entity_id"]: r["score"] for r in sem}
                db = await get_db()
                try:
                    ph = ",".join("?" for _ in task_ids)
                    cur = await db.execute(
                        f"SELECT id, title, status, result_summary, lessons_learned, important_notes, completed_at FROM tasks WHERE id IN ({ph})",
                        task_ids,
                    )
                    rows = await cur.fetchall()
                    result["tasks"] = sorted(
                        [{**dict(r), "score": scores.get(r["id"], 0)} for r in rows],
                        key=lambda x: x["score"], reverse=True
                    )
                finally:
                    await db.close()
        except Exception:
            pass
        if "tasks" not in result:
            # Keyword fallback
            db = await get_db()
            try:
                like = f"%{query}%"
                cur = await db.execute(
                    """SELECT id, title, status, result_summary, lessons_learned, important_notes, completed_at
                       FROM tasks WHERE workspace_id = ? AND (title LIKE ? OR description LIKE ? OR lessons_learned LIKE ?)
                       ORDER BY completed_at DESC LIMIT ?""",
                    (ws_id, like, like, like, limit_per),
                )
                result["tasks"] = [dict(r) for r in await cur.fetchall()]
            finally:
                await db.close()

    # 2. Session digests (semantic + keyword fallback)
    if "digests" in requested:
        try:
            from embedder import search_similar
            sem = await search_similar(query, "digest", ws_id, limit=limit_per, min_score=0.35)
            if sem:
                sids = [r["entity_id"] for r in sem]
                scores = {r["entity_id"]: r["score"] for r in sem}
                db = await get_db()
                try:
                    ph = ",".join("?" for _ in sids)
                    cur = await db.execute(
                        f"""SELECT s.id, s.name, s.status, s.cli_type, s.model,
                                   d.task_summary, d.current_focus, d.files_touched, d.decisions, d.discoveries
                            FROM sessions s LEFT JOIN session_digests d ON s.id = d.session_id
                            WHERE s.id IN ({ph})""",
                        sids,
                    )
                    rows = await cur.fetchall()
                    digests = []
                    for r in rows:
                        d = dict(r)
                        d["score"] = scores.get(d["id"], 0)
                        for jf in ("files_touched", "decisions", "discoveries"):
                            d[jf] = _parse_json_field(d.get(jf))
                        digests.append(d)
                    result["digests"] = sorted(digests, key=lambda x: x["score"], reverse=True)
                finally:
                    await db.close()
        except Exception:
            pass
        if "digests" not in result:
            db = await get_db()
            try:
                like = f"%{query}%"
                cur = await db.execute(
                    """SELECT s.id, s.name, s.status, s.cli_type, d.task_summary, d.current_focus,
                              d.files_touched, d.decisions, d.discoveries
                       FROM session_digests d JOIN sessions s ON d.session_id = s.id
                       WHERE d.workspace_id = ? AND (d.task_summary LIKE ? OR d.current_focus LIKE ?)
                       ORDER BY d.updated_at DESC LIMIT ?""",
                    (ws_id, like, like, limit_per),
                )
                rows = await cur.fetchall()
                result["digests"] = [{**dict(r), **{jf: _parse_json_field(dict(r).get(jf)) for jf in ("files_touched","decisions","discoveries")}} for r in rows]
            finally:
                await db.close()

    # 3. Knowledge entries (semantic + keyword fallback)
    if "knowledge" in requested:
        try:
            from embedder import search_similar
            sem = await search_similar(query, "knowledge", ws_id, limit=limit_per, min_score=0.35)
            if sem:
                kids = [r["entity_id"] for r in sem]
                scores = {r["entity_id"]: r["score"] for r in sem}
                db = await get_db()
                try:
                    ph = ",".join("?" for _ in kids)
                    cur = await db.execute(
                        f"SELECT * FROM workspace_knowledge WHERE id IN ({ph})", kids,
                    )
                    result["knowledge"] = sorted(
                        [{**dict(r), "score": scores.get(r["id"], 0)} for r in await cur.fetchall()],
                        key=lambda x: x["score"], reverse=True
                    )
                finally:
                    await db.close()
        except Exception:
            pass
        if "knowledge" not in result:
            db = await get_db()
            try:
                like = f"%{query}%"
                cur = await db.execute(
                    "SELECT * FROM workspace_knowledge WHERE workspace_id = ? AND content LIKE ? ORDER BY confirmed_count DESC LIMIT ?",
                    (ws_id, like, limit_per),
                )
                result["knowledge"] = [dict(r) for r in await cur.fetchall()]
            finally:
                await db.close()

    # 4. Peer messages (keyword only — not embedded)
    if "messages" in requested:
        db = await get_db()
        try:
            like = f"%{query}%"
            cur = await db.execute(
                """SELECT pm.*, s.name AS from_session_name
                   FROM peer_messages pm LEFT JOIN sessions s ON pm.from_session_id = s.id
                   WHERE pm.workspace_id = ? AND (pm.content LIKE ? OR pm.topic LIKE ?)
                   ORDER BY pm.created_at DESC LIMIT ?""",
                (ws_id, like, like, limit_per),
            )
            rows = await cur.fetchall()
            msgs = []
            for r in rows:
                d = dict(r)
                d["files"] = _parse_json_field(d.get("files"))
                d["read_by"] = _parse_json_field(d.get("read_by"))
                msgs.append(d)
            result["messages"] = msgs
        finally:
            await db.close()

    # 5. File activity (keyword on file path)
    if "files" in requested:
        db = await get_db()
        try:
            like = f"%{query}%"
            cur = await db.execute(
                """SELECT file_path, session_name, task_summary, task_title, tool_name,
                          MAX(created_at) AS last_edited
                   FROM file_activity WHERE workspace_id = ? AND (file_path LIKE ? OR task_summary LIKE ?)
                   GROUP BY file_path, session_id ORDER BY last_edited DESC LIMIT ?""",
                (ws_id, like, like, limit_per),
            )
            result["files"] = [dict(r) for r in await cur.fetchall()]
        finally:
            await db.close()

    return web.json_response(result)


# ── W2W: Export knowledge to native config files ────────────────────────

async def export_knowledge_to_config(request: web.Request) -> web.Response:
    """Export workspace knowledge to a native config file.

    Targets:
      - ``agents_md``   — shared AGENTS.md (CLI-agnostic, no sync needed)
      - ``claude_md``   — CLAUDE.md (writes + syncs to all CLI memory files)
      - ``gemini_md``   — GEMINI.md (writes + syncs to all CLI memory files)
      - ``memory_file`` — resolves via CLI profiles and writes through the
                          sync hub so every CLI's memory file stays in sync
    """
    ws_id = request.match_info["id"]
    body = await request.json()
    target = body.get("target", "agents_md")  # agents_md | claude_md | gemini_md | memory_file
    scope = body.get("scope", "")  # optional subfolder scope

    db = await get_db()
    try:
        # Get workspace path
        cur = await db.execute("SELECT path FROM workspaces WHERE id = ?", (ws_id,))
        ws = await cur.fetchone()
        if not ws:
            return web.json_response({"error": "workspace not found"}, status=404)
        ws_path = ws["path"]

        # Get knowledge entries (optionally scoped)
        sql = "SELECT * FROM workspace_knowledge WHERE workspace_id = ?"
        params: list = [ws_id]
        if scope:
            sql += " AND scope LIKE ?"
            params.append(f"%{scope}%")
        sql += " ORDER BY confirmed_count DESC, category, updated_at DESC"
        cur = await db.execute(sql, params)
        rows = await cur.fetchall()
        if not rows:
            return web.json_response({"error": "no knowledge entries to export"}, status=400)
    finally:
        await db.close()

    # Build the knowledge section
    sections: dict[str, list[str]] = {}
    for r in rows:
        cat = r["category"] or "general"
        entry = f"- {r['content']}"
        if r["scope"]:
            entry += f" [{r['scope']}]"
        sections.setdefault(cat, []).append(entry)

    lines = ["\n## Workspace Knowledge (auto-generated)\n"]
    for cat, entries in sections.items():
        lines.append(f"### {cat.title()}")
        lines.extend(entries)
        lines.append("")
    knowledge_block = "\n".join(lines)

    # Determine target file path(s) — profile-aware resolution
    import os as _os
    from cli_profiles import get_profile, PROFILES
    from memory_sync import sync_manager, get_provider

    if scope:
        base = _os.path.join(ws_path, scope)
    else:
        base = ws_path

    # Map target → (file_path, source_cli_for_sync)
    # source_cli is set when we write to a CLI-specific memory file and need
    # the sync hub to propagate the change to the other CLIs.
    source_cli: str | None = None

    if target == "agents_md":
        target_file = _os.path.join(base, "AGENTS.md")
    elif target == "memory_file":
        # Generic: pick first available CLI profile, write to its file,
        # then sync propagates to all others.
        first_cli = next(iter(PROFILES))
        profile = get_profile(first_cli)
        from cli_features import Feature as _Feat
        binding = profile.binding(_Feat.PROJECT_MEMORY_FILE)
        fname = binding.file_path if binding else "CLAUDE.md"
        target_file = _os.path.join(base, fname)
        source_cli = first_cli
    else:
        # CLI-specific target: claude_md, gemini_md, or future <cli>_md
        cli_id = target.replace("_md", "")
        if cli_id not in PROFILES:
            return web.json_response(
                {"error": f"unknown target '{target}', expected one of: "
                          f"agents_md, memory_file, "
                          + ", ".join(f"{c}_md" for c in PROFILES)},
                status=400,
            )
        profile = get_profile(cli_id)
        from cli_features import Feature as _Feat
        binding = profile.binding(_Feat.PROJECT_MEMORY_FILE)
        fname = binding.file_path if binding else f"{cli_id.upper()}.md"
        target_file = _os.path.join(base, fname)
        source_cli = cli_id

    # Read existing file and replace/append the knowledge section
    marker_start = "## Workspace Knowledge (auto-generated)"
    try:
        existing = ""
        if _os.path.isfile(target_file):
            with open(target_file, "r") as f:
                existing = f.read()

        if marker_start in existing:
            # Replace existing section (find next ## heading or EOF)
            start_idx = existing.index(marker_start)
            # Find next ## heading after our section
            rest = existing[start_idx + len(marker_start):]
            next_heading = -1
            for i, line in enumerate(rest.split("\n")):
                if i > 0 and line.startswith("## ") and "auto-generated" not in line:
                    next_heading = start_idx + len(marker_start) + sum(len(l) + 1 for l in rest.split("\n")[:i])
                    break
            if next_heading > 0:
                new_content = existing[:start_idx] + knowledge_block.strip() + "\n\n" + existing[next_heading:]
            else:
                new_content = existing[:start_idx] + knowledge_block.strip() + "\n"
        else:
            # Append to file
            new_content = existing.rstrip() + "\n\n" + knowledge_block.strip() + "\n"

        _os.makedirs(_os.path.dirname(target_file), exist_ok=True)
        with open(target_file, "w") as f:
            f.write(new_content)

        # If we wrote to a CLI-specific memory file, trigger the sync hub
        # so all other CLI memory files (CLAUDE.md ↔ GEMINI.md etc.) get
        # the update propagated via three-way merge.
        synced_to: list[str] = []
        if source_cli:
            try:
                result = await sync_manager.sync(
                    ws_id, ws_path, source_cli=source_cli,
                )
                synced_to = result.providers_updated
            except Exception as sync_err:
                logger.warning("Post-export sync failed: %s", sync_err)

        return web.json_response({
            "ok": True,
            "file": target_file,
            "entries": len(rows),
            "synced_to": synced_to,
        })
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ── W2W: Peer Messages ────────────────────────────────────────────────────

def _parse_json_field(val, fallback=None):
    if fallback is None:
        fallback = []
    if isinstance(val, (list, dict)):
        return val
    if isinstance(val, str):
        try:
            return json.loads(val)
        except (json.JSONDecodeError, TypeError):
            pass
    return fallback


async def list_peer_messages(request: web.Request) -> web.Response:
    ws_id = request.match_info["id"]
    since = request.query.get("since")
    topic = request.query.get("topic")
    priority = request.query.get("priority")
    exclude_from = request.query.get("exclude_from")
    db = await get_db()
    try:
        sql = "SELECT * FROM peer_messages WHERE workspace_id = ?"
        params: list = [ws_id]
        if since:
            sql += " AND created_at > ?"
            params.append(since)
        if topic:
            sql += " AND topic = ?"
            params.append(topic)
        if priority:
            sql += " AND priority = ?"
            params.append(priority)
        if exclude_from:
            sql += " AND from_session_id != ?"
            params.append(exclude_from)
        sql += " ORDER BY created_at DESC LIMIT 100"
        cur = await db.execute(sql, params)
        rows = await cur.fetchall()
        results = []
        for row in rows:
            d = dict(row)
            d["files"] = _parse_json_field(d.get("files"))
            d["read_by"] = _parse_json_field(d.get("read_by"))
            results.append(d)
        return web.json_response(results)
    finally:
        await db.close()


async def create_peer_message(request: web.Request) -> web.Response:
    ws_id = request.match_info["id"]
    body = await request.json()
    content = (body.get("content") or "").strip()
    if not content:
        return web.json_response({"error": "content required"}, status=400)

    msg_id = str(uuid.uuid4())
    blocking = 1 if body.get("blocking") else 0
    in_reply_to = body.get("in_reply_to") or None
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO peer_messages (id, workspace_id, from_session_id, topic, content, priority, files, blocking, in_reply_to)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (msg_id, ws_id, body.get("from_session_id", ""),
             body.get("topic", "general"), content,
             body.get("priority", "info"),
             body.get("files", "[]") if isinstance(body.get("files"), str) else json.dumps(body.get("files", [])),
             blocking, in_reply_to),
        )
        if in_reply_to:
            await db.execute(
                "UPDATE peer_messages SET reply_received = 1 WHERE id = ?",
                (in_reply_to,),
            )
        await db.commit()
        cur = await db.execute("SELECT * FROM peer_messages WHERE id = ?", (msg_id,))
        row = await cur.fetchone()
        d = dict(row)
        d["files"] = _parse_json_field(d.get("files"))
        d["read_by"] = _parse_json_field(d.get("read_by"))

        # Emit event
        try:
            from event_bus import bus
            from commander_events import CommanderEvent
            await bus.emit(
                CommanderEvent.PEER_MESSAGE_SENT,
                {
                    "message_id": msg_id,
                    "priority": d.get("priority"),
                    "topic": d.get("topic"),
                    "workspace_id": ws_id,
                    "session_id": body.get("from_session_id"),
                },
                source="w2w",
            )
        except Exception:
            logger.exception("Failed to emit PEER_MESSAGE_SENT event")

        return web.json_response(d, status=201)
    finally:
        await db.close()


async def mark_peer_message_read(request: web.Request) -> web.Response:
    msg_id = request.match_info["id"]
    body = await request.json()
    session_id = body.get("session_id", "")
    if not session_id:
        return web.json_response({"error": "session_id required"}, status=400)
    db = await get_db()
    try:
        cur = await db.execute("SELECT read_by FROM peer_messages WHERE id = ?", (msg_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "not found"}, status=404)
        read_by = _parse_json_field(row["read_by"])
        if session_id not in read_by:
            read_by.append(session_id)
            await db.execute(
                "UPDATE peer_messages SET read_by = ? WHERE id = ?",
                (json.dumps(read_by), msg_id),
            )
            await db.commit()
        return web.json_response({"ok": True})
    finally:
        await db.close()


# ── W2W: Session Digests ─────────────────────────────────────────────────

async def get_session_digest(request: web.Request) -> web.Response:
    session_id = request.match_info["id"]
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT * FROM session_digests WHERE session_id = ?", (session_id,)
        )
        row = await cur.fetchone()
        if not row:
            # Auto-create empty digest
            digest_id = str(uuid.uuid4())
            # Look up workspace_id from the session
            scur = await db.execute(
                "SELECT workspace_id FROM sessions WHERE id = ?", (session_id,)
            )
            srow = await scur.fetchone()
            ws_id = srow["workspace_id"] if srow else None
            await db.execute(
                """INSERT OR IGNORE INTO session_digests (id, session_id, workspace_id)
                   VALUES (?, ?, ?)""",
                (digest_id, session_id, ws_id),
            )
            await db.commit()
            cur = await db.execute(
                "SELECT * FROM session_digests WHERE session_id = ?", (session_id,)
            )
            row = await cur.fetchone()
        d = dict(row)
        d["files_touched"] = _parse_json_field(d.get("files_touched"))
        d["decisions"] = _parse_json_field(d.get("decisions"))
        d["discoveries"] = _parse_json_field(d.get("discoveries"))
        return web.json_response(d)
    finally:
        await db.close()


async def update_session_digest(request: web.Request) -> web.Response:
    session_id = request.match_info["id"]
    body = await request.json()
    db = await get_db()
    try:
        # Ensure digest exists first
        cur = await db.execute(
            "SELECT id FROM session_digests WHERE session_id = ?", (session_id,)
        )
        row = await cur.fetchone()
        if not row:
            digest_id = str(uuid.uuid4())
            scur = await db.execute(
                "SELECT workspace_id FROM sessions WHERE id = ?", (session_id,)
            )
            srow = await scur.fetchone()
            ws_id = srow["workspace_id"] if srow else None
            await db.execute(
                """INSERT INTO session_digests (id, session_id, workspace_id)
                   VALUES (?, ?, ?)""",
                (digest_id, session_id, ws_id),
            )

        fields, values = [], []
        for key in ("task_summary", "current_focus"):
            if key in body:
                fields.append(f"{key} = ?")
                values.append(body[key])
        for key in ("decisions", "discoveries"):
            if key in body:
                fields.append(f"{key} = ?")
                values.append(json.dumps(body[key]))
        if not fields:
            return web.json_response({"error": "nothing to update"}, status=400)
        fields.append("updated_at = datetime('now')")
        values.append(session_id)
        await db.execute(
            f"UPDATE session_digests SET {', '.join(fields)} WHERE session_id = ?",
            values,
        )
        await db.commit()

        # Emit event
        try:
            from event_bus import bus
            from commander_events import CommanderEvent
            await bus.emit(
                CommanderEvent.DIGEST_UPDATED,
                {"session_id": session_id},
                source="w2w",
            )
        except Exception:
            logger.exception("Failed to emit DIGEST_UPDATED event")

        cur = await db.execute(
            "SELECT * FROM session_digests WHERE session_id = ?", (session_id,)
        )
        row = await cur.fetchone()
        d = dict(row)
        d["files_touched"] = _parse_json_field(d.get("files_touched"))
        d["decisions"] = _parse_json_field(d.get("decisions"))
        d["discoveries"] = _parse_json_field(d.get("discoveries"))

        # Auto-embed digest for coordination overlap detection + session search
        try:
            from embedder import embed_digest
            await embed_digest(d)
        except Exception:
            pass

        # ── Drift gate ────────────────────────────────────────────────
        # Compare the new current_focus to the session's bound ticket.
        # If the focus has drifted out of the NOTIFY band (<0.55 cosine),
        # surface candidate tickets the worker should consider switching
        # to. Advisory only — never blocks the digest write.
        if "current_focus" in body and body.get("current_focus"):
            try:
                d["coordination"] = await _digest_drift_check(
                    session_id=session_id,
                    workspace_id=d.get("workspace_id"),
                    current_focus=body["current_focus"],
                )
            except Exception as e:
                logger.debug("digest drift check failed: %s", e)

        return web.json_response(d)
    finally:
        await db.close()


async def _digest_drift_check(session_id: str, workspace_id: str, current_focus: str) -> dict:
    """Inspect the worker's current_focus against the bound ticket.

    Returns a dict the MCP layer relays verbatim to the worker. Two shapes:
      - bound + drifted: {drift: {detected: true, score, current_ticket_id, candidates}}
      - unbound + focus reported: {suggestions: [...]}
      - bound + on-track: {drift: {detected: false, score, current_ticket_id}}
    """
    if not workspace_id:
        return {}

    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT active_ticket_id, task_id FROM sessions WHERE id = ?", (session_id,),
        )
        srow = await cur.fetchone()
    finally:
        await db.close()
    # Match worker_mcp_server.tool_document_to_board's binding rule: prefer
    # the explicit active_ticket_id but fall back to the commander-assigned
    # task_id so sessions that never called switch_active_ticket still get
    # drift checks against the work they were dispatched on.
    bound_ticket_id = (
        (srow["active_ticket_id"] or srow["task_id"]) if srow else None
    ) or None

    import ticket_retriever
    from myelin.coordination.workspace import OverlapLevel
    from myelin import _cosine_sim

    if bound_ticket_id:
        focus_emb = await ticket_retriever.embed_text(workspace_id, current_focus)
        ticket_emb = await ticket_retriever.get_ticket_embedding(workspace_id, bound_ticket_id)
        if focus_emb is None or ticket_emb is None:
            return {}
        score = _cosine_sim(focus_emb, ticket_emb)
        level = OverlapLevel.from_score(score)
        # NOTIFY band (0.55) is the lower edge of "still about the same
        # work." Below that we treat the focus as drifted.
        if level in (OverlapLevel.TANGENT, OverlapLevel.UNRELATED):
            candidates = await ticket_retriever.find_related(
                workspace_id=workspace_id,
                query=current_focus,
                status_filter="open",
                exclude_task_id=bound_ticket_id,
                limit=3,
            )
            return {
                "drift": {
                    "detected": True,
                    "score": round(score, 4),
                    "level": level.value,
                    "current_ticket_id": bound_ticket_id,
                    "message": (
                        "Your current_focus doesn't match the ticket you're bound to. "
                        "Consider switching tickets via switch_active_ticket, or update "
                        "the ticket description if the scope legitimately grew."
                    ),
                    "candidates": [c.to_dict() for c in candidates],
                },
            }
        return {
            "drift": {
                "detected": False,
                "score": round(score, 4),
                "level": level.value,
                "current_ticket_id": bound_ticket_id,
            },
        }

    # Unbound — one-shot suggestion list.
    candidates = await ticket_retriever.find_related(
        workspace_id=workspace_id,
        query=current_focus,
        status_filter="open",
        limit=3,
    )
    if not candidates:
        return {}
    return {
        "suggestions": {
            "message": "You're not bound to a ticket. Open tickets that look related:",
            "candidates": [c.to_dict() for c in candidates],
        },
    }


# ── W2W: Workspace Knowledge Base ────────────────────────────────────────


async def list_all_knowledge(request: web.Request) -> web.Response:
    """List knowledge entries across all workspaces (global view)."""
    category = request.query.get("category")
    query = request.query.get("query")
    workspace_id = request.query.get("workspace_id")  # optional filter
    db = await get_db()
    try:
        sql = "SELECT k.*, w.name as workspace_name FROM workspace_knowledge k LEFT JOIN workspaces w ON k.workspace_id = w.id"
        conditions, params = [], []
        if workspace_id:
            conditions.append("k.workspace_id = ?")
            params.append(workspace_id)
        if category:
            conditions.append("k.category = ?")
            params.append(category)
        if query:
            conditions.append("k.content LIKE ?")
            params.append(f"%{query}%")
        if conditions:
            sql += " WHERE " + " AND ".join(conditions)
        sql += " ORDER BY k.confirmed_count DESC, k.updated_at DESC LIMIT 500"
        cur = await db.execute(sql, params)
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


async def list_workspace_knowledge(request: web.Request) -> web.Response:
    ws_id = request.match_info["id"]
    category = request.query.get("category")
    scope = request.query.get("scope")
    query = request.query.get("query")
    db = await get_db()
    try:
        sql = "SELECT * FROM workspace_knowledge WHERE workspace_id = ?"
        params: list = [ws_id]
        if category:
            sql += " AND category = ?"
            params.append(category)
        if scope:
            sql += " AND scope LIKE ?"
            params.append(f"%{scope}%")
        if query:
            sql += " AND content LIKE ?"
            params.append(f"%{query}%")
        sql += " ORDER BY confirmed_count DESC, updated_at DESC LIMIT 200"
        cur = await db.execute(sql, params)
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


def _kb_norm(text: str) -> str:
    """Normalize knowledge content for dedup comparison: lowercase + collapse whitespace."""
    return _re.sub(r"\s+", " ", (text or "").lower()).strip()


async def create_knowledge_entry(request: web.Request) -> web.Response:
    ws_id = request.match_info["id"]
    body = await request.json()
    content = (body.get("content") or "").strip()
    category = (body.get("category") or "").strip()
    if not content or not category:
        return web.json_response({"error": "content and category required"}, status=400)

    scope = body.get("scope", "") or ""
    db = await get_db()
    try:
        # Dedup-on-write via the myelin semantic index (CONFLICT >= 0.80
        # cosine in same category/scope). When myelin is unavailable,
        # falls back to substring-containment over the same (category,
        # scope) so the dedup property is preserved offline.
        match_id = None
        try:
            import knowledge_indexer
            dup = await knowledge_indexer.find_duplicate(
                workspace_id=ws_id,
                category=category,
                scope=scope,
                content=content,
            )
            if dup:
                match_id = dup["entry_id"]
        except Exception as e:
            logger.debug("knowledge dedup via myelin failed: %s", e)

        if match_id is None:
            cur = await db.execute(
                """SELECT id, content FROM workspace_knowledge
                   WHERE workspace_id = ? AND category = ?
                     AND COALESCE(scope, '') = COALESCE(?, '')""",
                (ws_id, category, scope),
            )
            existing = [dict(r) for r in await cur.fetchall()]
            new_norm = _kb_norm(content)
            if len(new_norm) >= 30:
                for r in existing:
                    exist_norm = _kb_norm(r.get("content") or "")
                    if len(exist_norm) >= 30 and (new_norm in exist_norm or exist_norm in new_norm):
                        match_id = r["id"]
                        break

        if match_id is not None:
            await db.execute(
                "UPDATE workspace_knowledge SET confirmed_count = confirmed_count + 1, updated_at = datetime('now') WHERE id = ?",
                (match_id,),
            )
            await db.commit()
            try:
                from event_bus import bus
                from commander_events import CommanderEvent
                await bus.emit(
                    CommanderEvent.KNOWLEDGE_CONFIRMED,
                    {"entry_id": match_id, "via": "dedup_on_write"},
                    source="w2w",
                )
            except Exception:
                logger.exception("Failed to emit KNOWLEDGE_CONFIRMED event")
            cur = await db.execute("SELECT * FROM workspace_knowledge WHERE id = ?", (match_id,))
            row = await cur.fetchone()
            return web.json_response(dict(row), status=200)

        entry_id = str(uuid.uuid4())
        await db.execute(
            """INSERT INTO workspace_knowledge (id, workspace_id, category, content, scope, contributed_by)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (entry_id, ws_id, category, content, scope, body.get("contributed_by", "")),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM workspace_knowledge WHERE id = ?", (entry_id,))
        row = await cur.fetchone()

        try:
            from event_bus import bus
            from commander_events import CommanderEvent
            await bus.emit(
                CommanderEvent.KNOWLEDGE_CONTRIBUTED,
                {
                    "entry_id": entry_id,
                    "category": category,
                    "scope": scope,
                    "workspace_id": ws_id,
                    "session_id": body.get("contributed_by"),
                },
                source="w2w",
            )
        except Exception:
            logger.exception("Failed to emit KNOWLEDGE_CONTRIBUTED event")

        # Auto-embed for semantic search
        try:
            from embedder import embed_knowledge
            await embed_knowledge(dict(row))
        except Exception:
            pass

        # Mirror into the myelin knowledge index so the next dedup call
        # can match against this entry. Best-effort, fire-and-forget.
        try:
            import knowledge_indexer
            asyncio.create_task(knowledge_indexer.index_entry(
                workspace_id=ws_id,
                entry_id=entry_id,
                category=category,
                scope=scope,
                content=content,
                contributed_by=body.get("contributed_by"),
            ))
        except Exception:
            pass

        return web.json_response(dict(row), status=201)
    finally:
        await db.close()


async def update_knowledge_entry(request: web.Request) -> web.Response:
    entry_id = request.match_info["id"]
    body = await request.json()
    db = await get_db()
    try:
        # Special action: "confirm" increments confirmed_count
        if body.get("action") == "confirm":
            await db.execute(
                "UPDATE workspace_knowledge SET confirmed_count = confirmed_count + 1, updated_at = datetime('now') WHERE id = ?",
                (entry_id,),
            )
            await db.commit()
            try:
                from event_bus import bus
                from commander_events import CommanderEvent
                await bus.emit(
                    CommanderEvent.KNOWLEDGE_CONFIRMED,
                    {"entry_id": entry_id},
                    source="w2w",
                )
            except Exception:
                logger.exception("Failed to emit KNOWLEDGE_CONFIRMED event")
        else:
            fields, values = [], []
            for key in ("content", "category", "scope"):
                if key in body:
                    fields.append(f"{key} = ?")
                    values.append(body[key])
            if fields:
                fields.append("updated_at = datetime('now')")
                values.append(entry_id)
                await db.execute(
                    f"UPDATE workspace_knowledge SET {', '.join(fields)} WHERE id = ?",
                    values,
                )
                await db.commit()

        cur = await db.execute("SELECT * FROM workspace_knowledge WHERE id = ?", (entry_id,))
        row = await cur.fetchone()
        if not row:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(dict(row))
    finally:
        await db.close()


async def delete_knowledge_entry(request: web.Request) -> web.Response:
    entry_id = request.match_info["id"]
    db = await get_db()
    try:
        await db.execute("DELETE FROM workspace_knowledge WHERE id = ?", (entry_id,))
        await db.commit()
        return web.json_response({"ok": True})
    finally:
        await db.close()


async def get_knowledge_prompt(request: web.Request) -> web.Response:
    """Export workspace knowledge as a system prompt fragment for injection at PTY start."""
    ws_id = request.match_info["id"]
    scope = request.query.get("scope")
    max_chars = int(request.query.get("max_chars", "4000"))
    db = await get_db()
    try:
        sql = "SELECT * FROM workspace_knowledge WHERE workspace_id = ?"
        params: list = [ws_id]
        if scope:
            sql += " AND scope LIKE ?"
            params.append(f"%{scope}%")
        sql += " ORDER BY confirmed_count DESC, updated_at DESC"
        cur = await db.execute(sql, params)
        rows = await cur.fetchall()

        if not rows:
            return web.json_response({"prompt": ""})

        # Resolve output style for compact formatting
        from output_styles import resolve_output_style
        _ws_os = None
        try:
            _c = await db.execute("SELECT output_style FROM workspaces WHERE id = ?", (ws_id,))
            _r = await _c.fetchone()
            _ws_os = _r["output_style"] if _r else None
        except Exception:
            pass
        try:
            _c2 = await db.execute("SELECT value FROM app_settings WHERE key = 'output_style'")
            _r2 = await _c2.fetchone()
            _gl_os = _r2["value"] if _r2 else None
        except Exception:
            _gl_os = None
        compact = resolve_output_style(None, _ws_os, _gl_os) not in ("default", "lite")

        sections: dict[str, list[str]] = {}
        total_len = 0
        for row in rows:
            cat = row["category"] or "general"
            entry = f"- {row['content']}"
            if not compact and row["scope"]:
                entry += f" [{row['scope']}]"
            if total_len + len(entry) + 10 > max_chars:
                break
            sections.setdefault(cat, []).append(entry)
            total_len += len(entry) + 2

        if compact:
            lines = []
            for cat, entries in sections.items():
                lines.append(f"**{cat}**")
                lines.extend(entries)
        else:
            lines = ["## Workspace Knowledge Base", ""]
            for cat, entries in sections.items():
                lines.append(f"### {cat.title()}")
                lines.extend(entries)
                lines.append("")

        return web.json_response({"prompt": "\n".join(lines)})
    finally:
        await db.close()


# ── W2W: File Activity ────────────────────────────────────────────────────

async def get_file_activity(request: web.Request) -> web.Response:
    """Get recent edit activity for a file path — who touched it and what task they were on."""
    ws_id = request.match_info["id"]
    file_path = request.query.get("path", "")
    if not file_path:
        return web.json_response({"error": "path query param required"}, status=400)
    limit = int(request.query.get("limit", "20"))
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT * FROM file_activity
               WHERE workspace_id = ? AND file_path = ?
               ORDER BY created_at DESC LIMIT ?""",
            (ws_id, file_path, limit),
        )
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


async def list_recent_file_activity(request: web.Request) -> web.Response:
    """List recently edited files across the workspace with task context."""
    ws_id = request.match_info["id"]
    since = request.query.get("since")
    exclude_session = request.query.get("exclude_session")
    limit = int(request.query.get("limit", "50"))
    db = await get_db()
    try:
        sql = """SELECT file_path, session_id, session_name, task_summary, task_title,
                        tool_name, MAX(created_at) AS last_edited
                 FROM file_activity
                 WHERE workspace_id = ?"""
        params: list = [ws_id]
        if since:
            sql += " AND created_at > ?"
            params.append(since)
        if exclude_session:
            sql += " AND session_id != ?"
            params.append(exclude_session)
        sql += " GROUP BY file_path, session_id ORDER BY last_edited DESC LIMIT ?"
        params.append(limit)
        cur = await db.execute(sql, params)
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])
    finally:
        await db.close()


# ─── Session supervisor: health + restart ──────────────────────────

async def get_session_health(request: web.Request) -> web.Response:
    import session_supervisor
    sid = request.match_info["id"]
    health = await session_supervisor.get_health(sid)
    if health is None:
        return web.json_response({"error": "session not found"}, status=404)
    return web.json_response(health)


async def list_session_health(request: web.Request) -> web.Response:
    import session_supervisor
    return web.json_response(await session_supervisor.list_health())


async def restart_session(request: web.Request) -> web.Response:
    import session_supervisor
    sid = request.match_info["id"]
    try:
        result = await session_supervisor.restart(sid)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
    return web.json_response(result)


# ─── Autolearn: pending suggestions + approve/reject ───────────────

async def list_autolearn_pending(request: web.Request) -> web.Response:
    import auto_learn
    return web.json_response(await auto_learn.list_pending())


async def approve_autolearn(request: web.Request) -> web.Response:
    sid = request.match_info["id"]
    import auto_learn
    try:
        result = await auto_learn.approve(sid)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)
    return web.json_response(result)


async def reject_autolearn(request: web.Request) -> web.Response:
    sid = request.match_info["id"]
    import auto_learn
    try:
        await auto_learn.reject(sid)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)
    return web.json_response({"ok": True})


# ─── REST: Demo runner ─────────────────────────────────────────────────
# Per-workspace long-lived dev server for testers/reviewers. Workers can
# hack freely without restarting it; operators promote new builds via the
# explicit pull-latest action. See backend/demo_runner.py.

import demo_runner as _demo_runner


async def _demo_load_workspace(request: web.Request) -> tuple[str, str] | tuple[None, web.Response]:
    ws_id = request.match_info["id"]
    ws_path = await _get_workspace_path(ws_id)
    if not ws_path:
        return None, web.json_response({"error": "workspace not found"}, status=404)
    return ws_id, ws_path


async def _demo_workspace_settings(workspace_id: str) -> dict:
    """Pull demo_* settings off the workspaces row (best-effort)."""
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT demo_command, demo_branch, demo_port FROM workspaces WHERE id = ?",
            (workspace_id,),
        )
        row = await cur.fetchone()
        if not row:
            return {}
        return {
            "command": row["demo_command"] or "npm run dev",
            "branch": row["demo_branch"] or "main",
            "port": int(row["demo_port"] or 0),
        }
    except Exception:
        return {}
    finally:
        await db.close()


async def get_demo(request: web.Request) -> web.Response:
    loaded = await _demo_load_workspace(request)
    if loaded[0] is None:
        return loaded[1]
    ws_id, _ws_path = loaded
    info = await _demo_runner.status(ws_id)
    if info is None:
        defaults = await _demo_workspace_settings(ws_id)
        return web.json_response({"workspace_id": ws_id, "status": "stopped", **defaults})
    return web.json_response(info)


async def start_demo(request: web.Request) -> web.Response:
    loaded = await _demo_load_workspace(request)
    if loaded[0] is None:
        return loaded[1]
    ws_id, ws_path = loaded
    body = {}
    try:
        body = await request.json()
    except Exception:
        body = {}
    defaults = await _demo_workspace_settings(ws_id)
    branch = body.get("branch") or defaults.get("branch") or "main"
    command = body.get("command") or defaults.get("command") or "npm run dev"
    port = body.get("port") or defaults.get("port") or None
    if port == 0:
        port = None
    info = await _demo_runner.start(
        workspace_id=ws_id,
        workspace_path=ws_path,
        branch=branch,
        command=command,
        port=port,
    )
    return web.json_response(info)


async def stop_demo(request: web.Request) -> web.Response:
    loaded = await _demo_load_workspace(request)
    if loaded[0] is None:
        return loaded[1]
    ws_id, _ws_path = loaded
    info = await _demo_runner.stop(ws_id)
    return web.json_response(info)


async def pull_latest_demo(request: web.Request) -> web.Response:
    loaded = await _demo_load_workspace(request)
    if loaded[0] is None:
        return loaded[1]
    ws_id, _ws_path = loaded
    info = await _demo_runner.pull_latest(ws_id)
    return web.json_response(info)


async def list_demos(request: web.Request) -> web.Response:
    return web.json_response(await _demo_runner.list_all())


async def get_demo_log(request: web.Request) -> web.Response:
    loaded = await _demo_load_workspace(request)
    if loaded[0] is None:
        return loaded[1]
    ws_id, _ws_path = loaded
    info = await _demo_runner.status(ws_id)
    if info is None:
        return web.json_response({"workspace_id": ws_id, "lines": []})
    return web.json_response({"workspace_id": ws_id, "lines": info.get("build_log_tail", [])})


def create_app() -> web.Application:
    from middleware.rate_limiter import rate_limit_middleware
    from middleware.csp import csp_middleware
    from middleware.audit import audit_middleware
    # Order matters: CORS first (so 429s still get CORS headers), then
    # rate-limit (so brute-force attempts at /api/invite/redeem are
    # rejected before token auth even runs), then token auth, then audit
    # (so it sees the resolved AuthContext), then CSP (so headers land
    # on every response that flows back through).
    # token_auth_middleware is ALWAYS installed — it self-no-ops when
    # AUTH_TOKEN is None (line ~13796) and enforces when it's set. This
    # lets `Start tunnel` at runtime mint a token and have it actually
    # gate requests, since the middleware chain is frozen at app creation.
    middlewares = [cors_middleware, rate_limit_middleware, token_auth_middleware]
    middlewares.append(audit_middleware)
    middlewares.append(csp_middleware)
    app = web.Application(middlewares=middlewares)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    # PR 3: mode-aware route guards. _g(handler, *modes) returns the
    # handler decorated with requires_mode(*modes). Owner-equivalent
    # actors (localhost / owner_legacy / owner_device / hook) bypass.
    import route_guards as _route_guards
    def _g(handler, *modes):
        return _route_guards.requires_mode(*modes)(handler)
    def _owner(handler):
        return _route_guards.owner_only(handler)

    app.router.add_get("/ws", ws_handler)
    # /auth is always mounted — when AUTH_TOKEN is empty, the handler
    # itself short-circuits. Mounting unconditionally lets a runtime
    # tunnel-start (which auto-mints AUTH_TOKEN) immediately accept
    # logins from the public URL.
    app.router.add_post("/auth", auth_login)

    # Invite routes (access overhaul PR 1)
    # Mint + revoke are owner-only — joiners must never escalate themselves.
    # Redeem stays unauth (rate-limited) since the invite token IS the auth.
    app.router.add_post("/api/invite/create", _owner(create_invite_handler))
    app.router.add_get("/api/invites", _owner(list_invites_handler))
    app.router.add_post("/api/invite/{id}/revoke", _owner(revoke_invite_handler))
    app.router.add_post("/api/invite/redeem", redeem_invite_handler)
    app.router.add_get("/join", join_page_handler)
    # PR 2: per-row auth introspection / revocation
    app.router.add_get("/api/whoami", whoami_handler)
    app.router.add_get("/api/sessions/auth", list_auth_sessions_handler)
    app.router.add_post("/api/sessions/auth/{id}/revoke", revoke_auth_session_handler)
    app.router.add_post("/api/auth/logout", logout_handler)
    app.router.add_get("/api/audit", list_audit_log_handler)
    # Runtime tunnel + multiplayer toggles (owner-only)
    app.router.add_get("/api/runtime/status", runtime_status_handler)
    app.router.add_post("/api/runtime/tunnel/start", runtime_tunnel_start_handler)
    app.router.add_post("/api/runtime/tunnel/stop", runtime_tunnel_stop_handler)
    app.router.add_post("/api/runtime/multiplayer", runtime_multiplayer_toggle_handler)
    app.router.add_post("/api/runtime/mode", runtime_mode_handler)
    # PR 4: catch-me-up digest + Web Push subscriptions
    app.router.add_get("/api/catchup", catchup_handler)
    app.router.add_post("/api/push/subscribe", push_subscribe_handler)
    app.router.add_post("/api/push/unsubscribe", push_unsubscribe_handler)
    app.router.add_get("/api/push/vapid-pubkey", push_vapid_pubkey_handler)
    # PR 2: Owner device pairing (Ed25519). pair-init + list + revoke
    # are owner-only; pair-complete + challenge are unauth (the signed
    # challenge IS the auth — exempted in _exempt_path).
    app.router.add_post("/api/devices/pair-init", device_pair_init_handler)
    app.router.add_post("/api/devices/pair-complete", device_pair_complete_handler)
    app.router.add_get("/api/devices/{id}/challenge", device_challenge_handler)
    app.router.add_get("/api/devices", list_devices_handler)
    app.router.add_post("/api/devices/{id}/revoke", revoke_device_handler)

    app.router.add_get("/api/workspaces", list_workspaces)
    # Workspace mutations are owner-only — joiners can't add/rename/delete
    # workspaces or change paths (would escape mode clamps via path swap).
    app.router.add_post("/api/workspaces", _owner(create_workspace))
    app.router.add_post("/api/browse-folder", _owner(browse_folder))
    app.router.add_put("/api/workspaces/order", _owner(reorder_workspaces))
    app.router.add_put("/api/workspaces/{id}", _owner(update_workspace))
    app.router.add_delete("/api/workspaces/{id}", _owner(delete_workspace))
    app.router.add_get("/api/workspaces/{id}/preview-screenshot", get_workspace_preview_screenshot)

    app.router.add_get("/api/sessions", list_sessions)
    app.router.add_get("/api/sessions/{id}", get_session_by_id)
    app.router.add_post("/api/sessions", _g(create_session, "code", "full"))
    app.router.add_put("/api/sessions/order", reorder_sessions)
    app.router.add_delete("/api/sessions/{id}", _g(delete_session, "code", "full"))

    app.router.add_get("/api/sessions/{id}/messages", list_messages)

    app.router.add_get("/api/prompts", list_prompts)
    # Prompts/guidelines are content surfaces a Brief joiner shouldn't be
    # mutating (can carry @prompt: tokens that affect what code agents run).
    app.router.add_post("/api/prompts", _g(create_prompt, "code", "full"))
    app.router.add_put("/api/prompts/quickaction-order", _g(reorder_quickactions, "code", "full"))
    app.router.add_put("/api/prompts/{id}", _g(update_prompt, "code", "full"))
    app.router.add_delete("/api/prompts/{id}", _g(delete_prompt, "code", "full"))
    app.router.add_post("/api/prompts/{id}/use", use_prompt)

    app.router.add_get("/api/guidelines", list_guidelines)
    app.router.add_post("/api/guidelines", _g(create_guideline, "code", "full"))
    app.router.add_put("/api/guidelines/{id}", _g(update_guideline, "code", "full"))
    app.router.add_delete("/api/guidelines/{id}", _g(delete_guideline, "code", "full"))

    app.router.add_get("/api/sessions/{id}/guidelines", get_session_guidelines)
    app.router.add_put("/api/sessions/{id}/guidelines", _g(set_session_guidelines, "full"))

    # Session Advisor
    app.router.add_get("/api/sessions/{id}/recommend-guidelines", recommend_session_guidelines)
    app.router.add_get("/api/guidelines/effectiveness", get_guideline_effectiveness)
    app.router.add_post("/api/sessions/{id}/analyze", analyze_session_endpoint)
    app.router.add_post("/api/sessions/{id}/dismiss-recommendation", dismiss_guideline_recommendation)

    app.router.add_get("/api/mcp-servers", list_mcp_servers)
    app.router.add_post("/api/mcp-servers", _g(create_mcp_server, "full"))
    app.router.add_post("/api/mcp-servers/parse-docs", _g(parse_mcp_docs, "full"))
    app.router.add_put("/api/mcp-servers/{id}", _g(update_mcp_server, "full"))
    app.router.add_delete("/api/mcp-servers/{id}", _g(delete_mcp_server, "full"))
    app.router.add_get("/api/sessions/{id}/mcp-servers", get_session_mcp_servers)
    app.router.add_put("/api/sessions/{id}/mcp-servers", _g(set_session_mcp_servers, "full"))

    # Session config edits (model/permission_mode/effort/account_id/etc.) can
    # bypass mode clamps if a Brief joiner could PUT — block at the route.
    app.router.add_put("/api/sessions/{id}", _g(update_session, "code", "full"))
    app.router.add_put("/api/sessions/{id}/rename", _g(rename_session, "code", "full"))
    app.router.add_post("/api/sessions/merge", _g(merge_sessions, "code", "full"))
    app.router.add_post("/api/sessions/{id}/clone", _g(clone_session, "code", "full"))
    app.router.add_get("/api/sessions/{id}/export", export_session)
    app.router.add_post("/api/sessions/{id}/distill", _g(distill_session, "code", "full"))
    app.router.add_post("/api/sessions/{id}/summarize", _g(summarize_session, "code", "full"))
    app.router.add_get("/api/sessions/{id}/scratchpad", get_session_scratchpad)
    app.router.add_put("/api/sessions/{id}/scratchpad", update_session_scratchpad)
    app.router.add_get("/api/sessions/{id}/queue", get_session_queue)
    app.router.add_post("/api/sessions/{id}/queue", queue_task_for_session)
    app.router.add_post("/api/sessions/{id}/assign-task", assign_task_to_session)
    app.router.add_get("/api/search", search_messages)

    app.router.add_get("/api/history/projects", list_history_projects)
    app.router.add_post("/api/history/import", import_history)

    app.router.add_get("/api/templates", list_templates)
    app.router.add_post("/api/templates", create_template)
    app.router.add_delete("/api/templates/{id}", delete_template)
    app.router.add_post("/api/templates/{id}/apply", apply_template)

    app.router.add_get("/api/grid-templates", list_grid_templates)
    app.router.add_post("/api/grid-templates", create_grid_template)
    app.router.add_put("/api/grid-templates/{id}", update_grid_template)
    app.router.add_delete("/api/grid-templates/{id}", delete_grid_template)

    # Tab groups
    app.router.add_get("/api/tab-groups", list_tab_groups)
    app.router.add_post("/api/tab-groups", create_tab_group)
    app.router.add_put("/api/tab-groups/{id}", update_tab_group)
    app.router.add_delete("/api/tab-groups/{id}", delete_tab_group)

    # Tasks
    app.router.add_get("/api/tasks", list_tasks)
    app.router.add_post("/api/tasks", create_task)
    app.router.add_get("/api/tasks/similar", find_similar_tasks)  # before {id} to avoid match
    app.router.add_post("/api/workspaces/{workspace_id}/tickets/find_related", find_related_tickets)
    app.router.add_get("/api/workspaces/{workspace_id}/tickets/find_related", find_related_tickets)
    app.router.add_get("/api/tasks/{id}", get_task)
    app.router.add_put("/api/tasks/{id}", update_task)
    app.router.add_delete("/api/tasks/{id}", delete_task)
    app.router.add_get("/api/tasks/{id}/events", list_task_events)
    app.router.add_post("/api/tasks/{id}/iterate", iterate_task)

    # Output captures
    app.router.add_get("/api/sessions/{id}/captures", list_session_captures)
    app.router.add_get("/api/sessions/{id}/output", get_session_output)
    app.router.add_post("/api/sessions/{id}/input", _g(send_session_input, "code", "full"))
    app.router.add_post("/api/sessions/{id}/switch-cli", _g(switch_session_cli, "full"))
    app.router.add_post("/api/sessions/{id}/switch-model", _g(switch_model, "full"))
    app.router.add_post("/api/broadcast-input", _g(broadcast_input, "code", "full"))

    # Commander — Research DB
    # NOTE: order matters. Static path segments (`/jobs`, `/search`) MUST be
    # registered before the `/{id}` placeholder routes, otherwise aiohttp's
    # first-match dispatch sends e.g. `/api/research/jobs` into the {id}
    # handler with id="jobs" and the request 404s. Same for /search.
    app.router.add_get("/api/research", list_research)
    app.router.add_post("/api/research", create_research)
    # Deep-research jobs (subprocess runner) — kept on a distinct sub-path so
    # they don't collide with the DB CRUD routes above.
    app.router.add_post("/api/research/plan", decompose_research_plan)
    app.router.add_post("/api/research/jobs", _g(start_research, "code", "full"))
    app.router.add_get("/api/research/jobs", list_research_jobs)
    app.router.add_post("/api/research/jobs/{job_id}/steer", steer_research_job)
    app.router.add_post("/api/research/jobs/{job_id}/resume", resume_research_job)
    app.router.add_delete("/api/research/jobs/{job_id}", stop_research_job)
    app.router.add_get("/api/research/schedules", list_research_schedules)
    app.router.add_post("/api/research/schedules", create_research_schedule)
    app.router.add_put("/api/research/schedules/{id}", update_research_schedule)
    app.router.add_delete("/api/research/schedules/{id}", delete_research_schedule)
    app.router.add_get("/api/research/search", search_research)
    app.router.add_get("/api/research/{id}", get_research_with_sources)
    app.router.add_put("/api/research/{id}", update_research)
    app.router.add_delete("/api/research/{id}", delete_research)
    app.router.add_post("/api/research/{id}/sources", add_research_source)

    app.router.add_get("/api/workspaces/{id}/agents-md", get_agents_md)
    app.router.add_put("/api/workspaces/{id}/agents-md", save_agents_md)
    app.router.add_get("/api/workspaces/{id}/overview", get_workspace_overview)

    # Memory sync — static sub-paths before {id} placeholders
    app.router.add_get("/api/workspaces/{id}/memory/diff", get_workspace_memory_diff)
    app.router.add_get("/api/workspaces/{id}/memory/settings", get_workspace_memory_settings)
    app.router.add_put("/api/workspaces/{id}/memory/settings", update_workspace_memory_settings)
    app.router.add_get("/api/workspaces/{id}/memory/auto", get_workspace_auto_memory)
    app.router.add_post("/api/workspaces/{id}/memory/sync", sync_workspace_memory)
    app.router.add_post("/api/workspaces/{id}/memory/resolve", resolve_workspace_memory)
    app.router.add_get("/api/workspaces/{id}/memory", get_workspace_memory)
    app.router.add_put("/api/workspaces/{id}/memory", update_workspace_memory)

    # Memory entries (Commander-owned auto-memory)
    # Static sub-paths first, then {id} placeholder
    app.router.add_get("/api/memory/search", search_memory_entries)
    app.router.add_post("/api/memory/import", import_memory_from_cli)
    app.router.add_post("/api/memory/compact", compact_memory_entries)
    app.router.add_get("/api/memory/prompt", export_memory_prompt)
    app.router.add_get("/api/memory", list_memory_entries)
    app.router.add_post("/api/memory", create_memory_entry)
    app.router.add_put("/api/memory/{id}", update_memory_entry)
    app.router.add_delete("/api/memory/{id}", delete_memory_entry)

    # Vision-modal voice autofill — extracts the four onboarding fields
    # from a free-form transcript via the local CLI (no API key needed).
    app.router.add_post("/api/vision/autofill", autofill_vision)

    app.router.add_post("/api/workspaces/{id}/commander", create_commander)
    app.router.add_get("/api/workspaces/{id}/commander", get_commander)
    app.router.add_post("/api/workspaces/{id}/tester", create_tester)
    app.router.add_get("/api/workspaces/{id}/tester", get_tester)
    app.router.add_post("/api/workspaces/{id}/documentor", create_documentor)
    app.router.add_get("/api/workspaces/{id}/documentor", get_documentor)
    app.router.add_get("/api/workspaces/{id}/docs", get_docs_status)
    app.router.add_post("/api/workspaces/{id}/docs/build", trigger_docs_build)

    # Observatory
    app.router.add_get("/api/observatory/findings", list_observatory_findings)
    app.router.add_get("/api/observatory/scans", list_observatory_scans)
    app.router.add_get("/api/observatory/settings", get_observatory_settings)
    app.router.add_put("/api/observatory/settings", update_observatory_settings)
    app.router.add_post("/api/observatory/scan", trigger_observatory_scan)
    app.router.add_get("/api/observatory/api-keys", get_observatory_api_keys)
    app.router.add_put("/api/observatory/api-keys", set_observatory_api_key)
    app.router.add_post("/api/observatory/api-keys/test", test_observatory_api_key)
    app.router.add_put("/api/observatory/findings/{id}", update_observatory_finding)
    app.router.add_delete("/api/observatory/findings/{id}", delete_observatory_finding)

    # Observatory: profile + curated search targets (LLM-driven, no keywords)
    app.router.add_get("/api/observatory/profile", get_observatory_profile)
    app.router.add_put("/api/observatory/profile", update_observatory_profile)
    app.router.add_post("/api/observatory/profile/regenerate", regenerate_observatory_profile)
    app.router.add_post("/api/observatory/profile/recalibrate", recalibrate_observatory_profile)
    app.router.add_get("/api/observatory/search-targets", list_observatory_search_targets)
    app.router.add_post("/api/observatory/search-targets", add_observatory_search_target)
    app.router.add_put("/api/observatory/search-targets/{id}", update_observatory_search_target)
    app.router.add_delete("/api/observatory/search-targets/{id}", delete_observatory_search_target)
    app.router.add_post("/api/observatory/search-targets/plan", plan_observatory_search_targets)
    app.router.add_post("/api/observatory/triage", triage_observatory_items)
    app.router.add_post("/api/observatory/scan/smart", trigger_observatory_smart_scan)
    app.router.add_get("/api/observatory/insights", list_observatory_insights)
    app.router.add_post("/api/observatory/insights", upsert_observatory_insight)
    app.router.add_put("/api/observatory/insights/{id}", update_observatory_insight)
    app.router.add_delete("/api/observatory/insights/{id}", delete_observatory_insight)
    app.router.add_post("/api/observatory/findings/{id}/promote", promote_observatory_finding)
    app.router.add_post("/api/workspaces/{id}/observatorist", create_observatorist)

    # System-wide API key management — owner / Full only. Brief and Code
    # joiners get a 403 so the README promise ("your API keys never leave
    # your machine") holds end-to-end: even the 4-char preview, the
    # configured-which-keys map, and the test/probe surface are all gated.
    app.router.add_get("/api/api-keys", _g(list_api_keys, "full"))
    app.router.add_put("/api/api-keys", _g(save_api_key, "full"))
    app.router.add_post("/api/api-keys/test", _g(test_api_key, "full"))

    app.router.add_get("/api/workspaces/{id}/test-queue", list_test_queue)
    app.router.add_post("/api/workspaces/{id}/test-queue", enqueue_test)
    app.router.add_put("/api/test-queue/{id}", update_test_queue_entry)
    app.router.add_delete("/api/test-queue/{id}", remove_from_test_queue)

    # Git operations (code review)
    app.router.add_get("/api/workspaces/{id}/git/status", get_workspace_git_status)
    app.router.add_get("/api/workspaces/{id}/git/diff", get_workspace_git_diff)
    app.router.add_get("/api/workspaces/{id}/git/log", get_workspace_git_log)
    app.router.add_post("/api/open-in-ide", open_in_ide)

    # Demo runner — per-workspace stable dev-server preview
    app.router.add_get("/api/workspaces/{id}/demo", get_demo)
    app.router.add_post("/api/workspaces/{id}/demo/start", start_demo)
    app.router.add_post("/api/workspaces/{id}/demo/stop", stop_demo)
    app.router.add_post("/api/workspaces/{id}/demo/pull-latest", pull_latest_demo)
    app.router.add_get("/api/workspaces/{id}/demo/log", get_demo_log)
    app.router.add_get("/api/demos", list_demos)

    # Session tree + subagents
    app.router.add_get("/api/sessions/{id}/tree", get_session_tree)
    app.router.add_get("/api/sessions/{id}/subagents", get_session_subagents)
    app.router.add_get("/api/sessions/{id}/subagents/{agent_id}/transcript", get_subagent_transcript)

    async def _turns_handler(r: web.Request) -> web.Response:
        sid = r.match_info["id"]
        if not await _session_exists(sid):
            return web.json_response({"error": "session not found"}, status=404)
        return web.json_response(get_session_turns(sid))
    app.router.add_get("/api/sessions/{id}/turns", _turns_handler)
    app.router.add_get("/api/preview-proxy", preview_proxy)
    app.router.add_get("/api/screenshot", take_screenshot)
    app.router.add_post("/api/install-screenshot-tools", install_screenshot_tools)
    app.router.add_post("/api/paste-image", paste_image)
    app.router.add_get("/api/pastes/{filename}", serve_paste)

    app.router.add_post("/api/tasks/{id}/attachments", upload_attachment)
    app.router.add_get("/api/tasks/{id}/attachments", list_attachments)
    app.router.add_get("/api/attachments/{task_id}/{filename}", serve_attachment)

    # Accounts
    app.router.add_get("/api/browser/detect", detect_browsers)
    app.router.add_get("/api/accounts", list_accounts)
    app.router.add_post("/api/accounts", _g(create_account, "full"))
    app.router.add_post("/api/accounts/open-next", _g(open_next_account, "full"))
    app.router.add_put("/api/accounts/{id}", _g(update_account, "full"))
    app.router.add_delete("/api/accounts/{id}", _g(delete_account, "full"))
    app.router.add_post("/api/accounts/{id}/test", _g(test_account, "full"))
    app.router.add_post("/api/accounts/{id}/snapshot", _g(snapshot_account, "full"))
    app.router.add_post("/api/accounts/{id}/open-browser", _g(open_account_browser, "full"))
    app.router.add_post("/api/accounts/{id}/setup-browser", _g(playwright_setup_browser, "full"))
    app.router.add_post("/api/accounts/{id}/playwright-auth", _g(playwright_auth, "full"))
    app.router.add_get("/api/accounts/{id}/auth-status", playwright_auth_status)
    app.router.add_post("/api/sessions/{id}/restart-with-account", _g(restart_with_account, "full"))
    app.router.add_post("/api/sessions/{id}/pop-out", pop_out_session)

    app.router.add_get("/api/cli-info", get_cli_info)
    app.router.add_get("/api/cli-info/features", get_cli_feature_matrix)

    # App settings + experimental feature flags.
    # NOTE: order matters — static paths before {key} placeholders.
    app.router.add_get("/api/output-styles", list_output_styles)
    app.router.add_get("/api/settings/experimental", list_experimental_features)
    app.router.add_get("/api/settings", list_app_settings)
    app.router.add_get("/api/settings/{key}", get_app_setting)
    app.router.add_put("/api/settings/{key}", put_app_setting)

    # Safety Gate — tool call safety engine
    app.router.add_post("/api/safety/evaluate", evaluate_safety)
    app.router.add_post("/api/safety/approved", report_safety_approved)
    app.router.add_get("/api/safety/status", get_safety_status)
    app.router.add_get("/api/safety/rules", list_safety_rules)
    app.router.add_post("/api/safety/rules", create_safety_rule)
    app.router.add_post("/api/safety/rules/seed", seed_safety_rules)
    app.router.add_put("/api/safety/rules/{id}", update_safety_rule)
    app.router.add_delete("/api/safety/rules/{id}", delete_safety_rule)
    app.router.add_get("/api/safety/access-log", get_external_access_log)
    app.router.add_get("/api/safety/command-log", get_command_log)
    app.router.add_get("/api/safety/package-scans", get_package_scans)
    app.router.add_post("/api/safety/avcp-result", post_avcp_result)
    app.router.add_get("/api/safety/install-script-policy", get_install_script_policy)
    app.router.add_put("/api/safety/install-script-policy", put_install_script_policy)
    app.router.add_post("/api/safety/install-script-allowlist", add_install_script_allowlist)
    app.router.add_delete("/api/safety/install-script-allowlist/{id}", remove_install_script_allowlist)
    app.router.add_get("/api/safety/decisions", get_safety_decisions)
    app.router.add_get("/api/safety/proposals", get_safety_proposals)
    app.router.add_post("/api/safety/proposals/{id}/accept", accept_safety_proposal)
    app.router.add_post("/api/safety/proposals/{id}/dismiss", dismiss_safety_proposal)

    # Commander event bus. Order: static paths before {id} placeholders.
    app.router.add_get("/api/events/catalog", get_event_catalog)
    app.router.add_post("/api/events/emit", emit_event_handler)
    app.router.add_get("/api/events/subscriptions", list_event_subscriptions)
    app.router.add_post("/api/events/subscriptions", create_event_subscription)
    app.router.add_put("/api/events/subscriptions/{id}", update_event_subscription)
    app.router.add_delete("/api/events/subscriptions/{id}", delete_event_subscription)
    app.router.add_get("/api/events", list_events)

    # Prompt cascades
    app.router.add_get("/api/cascades", list_cascades)
    app.router.add_post("/api/cascades", create_cascade)
    app.router.add_put("/api/cascades/{id}", update_cascade)
    app.router.add_delete("/api/cascades/{id}", delete_cascade)
    app.router.add_post("/api/cascades/{id}/use", _g(use_cascade, "code", "full"))

    # Cascade runs (server-side execution)
    app.router.add_get("/api/cascade-runs", list_cascade_runs)
    app.router.add_post("/api/cascade-runs", create_cascade_run)
    app.router.add_get("/api/cascade-runs/{id}", get_cascade_run)
    app.router.add_put("/api/cascade-runs/{id}", update_cascade_run)
    app.router.add_delete("/api/cascade-runs/{id}", delete_cascade_run)

    # Pipeline Engine (configurable graph pipelines)
    app.router.add_get("/api/pipelines", list_pipeline_definitions)
    app.router.add_post("/api/pipelines", create_pipeline_definition)
    app.router.add_get("/api/pipelines/{id}", get_pipeline_definition)
    app.router.add_put("/api/pipelines/{id}", update_pipeline_definition)
    app.router.add_delete("/api/pipelines/{id}", delete_pipeline_definition)
    app.router.add_get("/api/pipeline-runs", list_pipeline_runs)
    app.router.add_post("/api/pipeline-runs", _g(start_pipeline_run, "code", "full"))
    app.router.add_post("/api/pipeline-runs/ralph", _g(start_ralph_pipeline, "code", "full"))
    app.router.add_get("/api/pipeline-runs/{id}", get_pipeline_run)
    app.router.add_put("/api/pipeline-runs/{id}", update_pipeline_run)
    app.router.add_delete("/api/pipeline-runs/{id}", delete_pipeline_run)

    # Broadcast groups
    app.router.add_get("/api/broadcast-groups", list_broadcast_groups)
    app.router.add_post("/api/broadcast-groups", create_broadcast_group)
    app.router.add_put("/api/broadcast-groups/{id}", update_broadcast_group)
    app.router.add_delete("/api/broadcast-groups/{id}", delete_broadcast_group)

    # Plugin marketplace
    # NOTE: order matters — static path segments before {id} placeholders so
    # /api/plugins/registries doesn't get dispatched into the plugin handler.
    app.router.add_get("/api/plugins/registries", list_plugin_registries)
    app.router.add_post("/api/plugins/registries", add_plugin_registry)
    app.router.add_post("/api/plugins/registries/sync", sync_all_plugin_registries)
    app.router.add_put("/api/plugins/registries/{id}", update_plugin_registry)
    app.router.add_delete("/api/plugins/registries/{id}", delete_plugin_registry)
    app.router.add_post("/api/plugins/registries/{id}/sync", sync_plugin_registry)
    app.router.add_get("/api/plugins", list_plugins_handler)
    app.router.add_get("/api/plugins/{id}", get_plugin_handler)
    app.router.add_post("/api/plugins/{id}/install", install_plugin_handler)
    app.router.add_delete("/api/plugins/{id}", uninstall_plugin_handler)
    app.router.add_get("/api/sessions/{id}/plugin-components", get_session_plugin_components)
    app.router.add_put("/api/sessions/{id}/plugin-components", set_session_plugin_components)

    # Agent Skills
    app.router.add_get("/api/skills", list_agent_skills)
    app.router.add_get("/api/skills/installed", list_installed_skills_handler)
    app.router.add_get("/api/skills/search", search_agent_skills)
    app.router.add_get("/api/skills/content", get_agent_skill_content)
    app.router.add_post("/api/skills/install", install_agent_skill)
    app.router.add_post("/api/skills/uninstall", uninstall_agent_skill)
    app.router.add_post("/api/skills/sync", sync_agent_skill)
    app.router.add_post("/api/skills/dismiss-suggestion", dismiss_skill_suggestion)
    app.router.add_get("/api/skills/{path:.*}", get_agent_skill)

    # Plan file
    app.router.add_get("/api/plan-files", list_plan_files)
    app.router.add_get("/api/plan-file", get_plan_file)
    app.router.add_put("/api/plan-file", put_plan_file)

    # W2W: Peer messages
    app.router.add_get("/api/workspaces/{id}/peer-messages", list_peer_messages)
    app.router.add_post("/api/workspaces/{id}/peer-messages", create_peer_message)
    app.router.add_put("/api/peer-messages/{id}/read", mark_peer_message_read)

    # W2W: Session digests
    app.router.add_get("/api/sessions/{id}/digest", get_session_digest)
    app.router.add_put("/api/sessions/{id}/digest", update_session_digest)

    # W2W: Workspace knowledge
    app.router.add_get("/api/knowledge", list_all_knowledge)
    app.router.add_get("/api/workspaces/{id}/knowledge", list_workspace_knowledge)
    app.router.add_post("/api/workspaces/{id}/knowledge", create_knowledge_entry)
    app.router.add_get("/api/workspaces/{id}/knowledge/prompt", get_knowledge_prompt)
    app.router.add_put("/api/knowledge/{id}", update_knowledge_entry)
    app.router.add_delete("/api/knowledge/{id}", delete_knowledge_entry)

    # W2W: File activity
    app.router.add_get("/api/workspaces/{id}/file-activity", list_recent_file_activity)
    app.router.add_get("/api/workspaces/{id}/file-activity/file", get_file_activity)

    # W2W: Semantic search + coordination
    app.router.add_get("/api/sessions/similar", find_similar_sessions)
    app.router.add_post("/api/workspaces/{id}/coordination/overlap", check_coordination_overlap)
    app.router.add_get("/api/workspaces/{id}/memory-search", unified_memory_search)

    # W2W: Export knowledge to native config files
    app.router.add_post("/api/workspaces/{id}/knowledge/export", export_knowledge_to_config)

    # Session supervisor: PTY health + restart
    app.router.add_get("/api/sessions/health", list_session_health)
    app.router.add_get("/api/sessions/{id}/health", get_session_health)
    app.router.add_post("/api/sessions/{id}/restart", restart_session)

    # Autolearn: pending suggestions + approve/reject
    app.router.add_get("/api/memory/autolearn/pending", list_autolearn_pending)
    app.router.add_post("/api/memory/autolearn/{id}/approve", approve_autolearn)
    app.router.add_delete("/api/memory/autolearn/{id}", reject_autolearn)

    # CLI lifecycle hooks (replaces ANSI-based state detection)
    from hooks import handle_hook_event
    app.router.add_post("/api/hooks/event", handle_hook_event)
    app.router.add_post("/api/hooks/discover", handle_hook_discover)
    app.router.add_post("/api/hooks/pipeline-result", handle_pipeline_result)

    # ── Cloudflare-tunnel-aware preview proxy ─────────────────────
    # Always mount the proxy routes. The handler itself is live-gated
    # on the _TUNNEL_MODE / _MULTIPLAYER_MODE flags so toggling either
    # at runtime opens up preview without a restart. In single-player
    # local mode the gate returns 403 and collaborators reach localhost
    # dev servers directly.
    if True:
        for method in ("GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"):
            app.router.add_route(
                method,
                r"/preview/{port:\d{2,5}}",
                proxy_localhost,
            )
            app.router.add_route(
                method,
                r"/preview/{port:\d{2,5}}/{path:.*}",
                proxy_localhost,
            )
    else:
        app.router.add_route(
            "*",
            r"/preview/{port:\d{2,5}}",
            proxy_localhost_disabled,
        )
        app.router.add_route(
            "*",
            r"/preview/{port:\d{2,5}}/{path:.*}",
            proxy_localhost_disabled,
        )

    # ── Static frontend serving (always mounted) ──────────────────────
    # The handlers below are registered unconditionally so a runtime
    # tunnel-start (no `--multiplayer` at boot) can serve the frontend
    # over the tunnel without a server restart.
    #
    # Behavior at request time:
    #   - If `frontend/dist/` exists → serve the built file.
    #   - Else if Vite is up on :5173 → reverse-proxy to it (dev mode).
    #     This keeps `./start.sh` (no flags) working through a runtime
    #     tunnel: the tunnel exposes the backend on :5111, and the
    #     backend transparently forwards non-API/WS/preview paths to
    #     the Vite dev server so the visitor sees the same UI you do
    #     locally on :5173.
    #   - Else → 503 with a clear "build the frontend" message.
    from resource_path import project_root as _project_root
    _dist = _project_root() / "frontend" / "dist"
    # Vite usually binds to "localhost" which on macOS resolves IPv6-first
    # (::1) but Python/aiohttp resolves IPv4-first (127.0.0.1). Try both
    # and cache the one that worked so we only pay the cost once.
    _vite_origins = ("http://127.0.0.1:5173", "http://[::1]:5173")
    _NO_FRONTEND_MSG = (
        "<!doctype html><meta charset=utf-8><title>IVE — building frontend…</title>"
        "<style>body{font-family:system-ui;max-width:36rem;margin:4rem auto;"
        "padding:1.5rem;background:#0a0a0a;color:#e4e4e7;border:1px solid #27272a;"
        "border-radius:8px}code{background:#18181b;padding:.15rem .35rem;"
        "border-radius:4px;color:#a1a1aa}h2{margin-top:0;color:#fafafa}</style>"
        "<meta http-equiv=refresh content=4>"
        "<h2>Building the frontend bundle…</h2>"
        "<p>This page auto-refreshes every 4s. The first build can take "
        "10–30s; subsequent loads are instant.</p>"
        "<p>If this persists for more than a minute, run "
        "<code>npm run build</code> in <code>frontend/</code> manually.</p>"
    )

    async def _try_proxy_vite(request: web.Request, sub_path: str):
        """Reverse-proxy `request` to Vite's dev server. Returns None if Vite
        isn't reachable on either IPv4 or IPv6 loopback."""
        sess: aiohttp.ClientSession = request.app.get("preview_proxy_session")
        if sess is None:
            sess = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=_PREVIEW_PROXY_TIMEOUT),
                auto_decompress=False,
            )
            request.app["preview_proxy_session"] = sess
        upstream_headers: dict[str, str] = {}
        for name, value in request.headers.items():
            lname = name.lower()
            if lname in _PREVIEW_PROXY_STRIP_REQ_HEADERS:
                continue
            if lname.startswith("cf-"):
                continue
            upstream_headers[name] = value
        upstream_headers["Host"] = "localhost:5173"
        if request.headers.get("Upgrade", "").lower() == "websocket":
            return web.json_response(
                {"error": "vite HMR websocket proxying not yet implemented"},
                status=501,
            )
        # Read body once — we may retry across origins.
        body_bytes = None
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            body_bytes = await request.read()
        # Order origins by which last succeeded.
        cached = request.app.get("vite_origin_cache")
        origins = (cached, *(o for o in _vite_origins if o != cached)) if cached else _vite_origins
        for origin in origins:
            if not origin:
                continue
            upstream_url = f"{origin}/{sub_path}"
            if request.query_string:
                upstream_url = f"{upstream_url}?{request.query_string}"
            try:
                up = await sess.request(
                    request.method, upstream_url, headers=upstream_headers,
                    data=body_bytes, allow_redirects=False,
                )
            except (aiohttp.ClientConnectorError, aiohttp.ServerDisconnectedError, asyncio.TimeoutError):
                continue
            request.app["vite_origin_cache"] = origin
            resp_headers: dict[str, str] = {}
            for name, value in up.headers.items():
                lname = name.lower()
                if lname in _PREVIEW_PROXY_STRIP_RESP_HEADERS:
                    continue
                resp_headers[name] = value
            body = await up.read()
            up.release()
            return web.Response(status=up.status, headers=resp_headers, body=body)
        return None

    async def _serve_manifest(request: web.Request) -> web.Response:
        f = _dist / "manifest.webmanifest"
        if f.is_file():
            return web.FileResponse(
                f, headers={"Content-Type": "application/manifest+json"},
            )
        proxied = await _try_proxy_vite(request, "manifest.webmanifest")
        if proxied is not None:
            return proxied
        return web.Response(status=404)

    async def _serve_sw(request: web.Request) -> web.Response:
        f = _dist / "sw.js"
        if f.is_file():
            return web.FileResponse(
                f,
                headers={
                    "Content-Type": "application/javascript",
                    "Service-Worker-Allowed": "/",
                    "Cache-Control": "no-cache",
                },
            )
        proxied = await _try_proxy_vite(request, "sw.js")
        if proxied is not None:
            return proxied
        return web.Response(status=404)

    async def _spa_fallback(request: web.Request) -> web.StreamResponse:
        path = request.match_info.get("_path", "")
        if _dist.is_dir():
            _index = _dist / "index.html"
            if path:
                candidate = (_dist / path).resolve()
                if candidate.is_file() and str(candidate).startswith(
                    str(_dist.resolve())
                ):
                    return web.FileResponse(candidate)
            return web.FileResponse(_index)
        # No built frontend — try Vite, otherwise show install hint.
        proxied = await _try_proxy_vite(request, path)
        if proxied is not None:
            return proxied
        return web.Response(
            status=503, content_type="text/html", text=_NO_FRONTEND_MSG,
        )

    # /assets is served by a request-time-deciding handler so that an
    # auto-build that lands AFTER app start automatically switches from
    # Vite proxy to disk serving without a restart.
    async def _assets_handler(request: web.Request) -> web.StreamResponse:
        sub = request.match_info.get("path", "")
        if (_dist / "assets").is_dir():
            candidate = (_dist / "assets" / sub).resolve()
            if candidate.is_file() and str(candidate).startswith(
                str((_dist / "assets").resolve())
            ):
                return web.FileResponse(candidate)
        proxied = await _try_proxy_vite(request, f"assets/{sub}")
        if proxied is not None:
            return proxied
        return web.Response(status=404)

    app.router.add_get("/assets/{path:.*}", _assets_handler)
    app.router.add_get("/manifest.webmanifest", _serve_manifest)
    app.router.add_get("/sw.js", _serve_sw)
    app.router.add_get("/{_path:.*}", _spa_fallback)

    return app


def _get_lan_ips():
    """Get LAN IP addresses for this machine."""
    import socket
    ips = []
    try:
        # Connect to an external address to find the primary LAN interface
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    return ips


def _get_hostname_local():
    """Get mDNS hostname (e.g. 'michaels-mbp.local')."""
    import socket
    try:
        hostname = socket.gethostname()
        if not hostname.endswith(".local"):
            hostname += ".local"
        return hostname
    except Exception:
        return None


def _generate_token():
    """Generate a random auth token and persist it."""
    import secrets
    token_dir = _Path.home() / ".ive"
    token_dir.mkdir(parents=True, exist_ok=True)
    token_file = token_dir / "token"
    if token_file.exists():
        stored = token_file.read_text().strip()
        if stored:
            return stored
    token = secrets.token_urlsafe(16)
    token_file.write_text(token)
    token_file.chmod(0o600)
    return token


_tunnel_proc = None  # Track for cleanup


async def _start_cloudflare_tunnel(port: int):
    """Start a cloudflared quick tunnel (no account required). Returns tunnel URL."""
    global _tunnel_proc
    import shutil
    cloudflared = shutil.which("cloudflared")
    if not cloudflared:
        logger.warning("cloudflared not found — install with: brew install cloudflare/cloudflare/cloudflared")
        return None

    _tunnel_proc = await asyncio.create_subprocess_exec(
        cloudflared, "tunnel", "--url", f"http://localhost:{port}",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    # cloudflared logs the URL on stderr in current versions, but earlier
    # builds wrote it to stdout. Read both in parallel so we work across
    # versions and survive any future format change. Also detect the
    # subprocess exiting early (binary missing libs, port conflict, etc.)
    # so we don't sit on a 60s timeout when the proc is already dead.
    import re
    url_pattern = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
    found_url: list[str] = []

    async def _scan(stream):
        if stream is None:
            return
        while True:
            line = await stream.readline()
            if not line:
                return
            text = line.decode("utf-8", errors="replace")
            m = url_pattern.search(text)
            if m:
                found_url.append(m.group(0))
                return

    scan_stderr = asyncio.create_task(_scan(_tunnel_proc.stderr))
    scan_stdout = asyncio.create_task(_scan(_tunnel_proc.stdout))
    proc_wait = asyncio.create_task(_tunnel_proc.wait())

    try:
        done, pending = await asyncio.wait(
            {scan_stderr, scan_stdout, proc_wait},
            timeout=60,
            return_when=asyncio.FIRST_COMPLETED,
        )
        # Give a brief grace period after first completion for the URL line
        # to land if it wasn't the one that triggered FIRST_COMPLETED.
        if not found_url and pending:
            done2, _ = await asyncio.wait(pending, timeout=5)
            done = done | done2
    finally:
        for t in (scan_stderr, scan_stdout, proc_wait):
            if not t.done():
                t.cancel()

    if found_url:
        return found_url[0]

    # Either the timeout fired or cloudflared exited without printing a URL.
    if _tunnel_proc and _tunnel_proc.returncode is not None:
        logger.warning(
            "cloudflared exited early with code %s — check `cloudflared --version` and network access",
            _tunnel_proc.returncode,
        )
    else:
        logger.warning("Could not detect cloudflared tunnel URL within 60s")
        # Kill the zombie so a retry can start fresh.
        try:
            _tunnel_proc.terminate()
            await asyncio.wait_for(_tunnel_proc.wait(), timeout=3)
        except Exception:
            try:
                _tunnel_proc.kill()
            except Exception:
                pass
    _tunnel_proc = None
    return None


def _start_mdns(port: int):
    """Register IVE as an mDNS service for LAN discovery (best-effort)."""
    import shutil
    import subprocess
    import sys

    if sys.platform == "darwin":
        dns_sd = shutil.which("dns-sd")
        if dns_sd:
            try:
                proc = subprocess.Popen(
                    [dns_sd, "-R", "IVE", "_http._tcp", "local", str(port)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                return proc
            except Exception as e:
                logger.debug("mDNS registration failed: %s", e)
    elif sys.platform.startswith("linux"):
        avahi = shutil.which("avahi-publish-service") or shutil.which("avahi-publish")
        if avahi:
            try:
                proc = subprocess.Popen(
                    [avahi, "IVE", "_http._tcp", str(port)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                return proc
            except Exception as e:
                logger.debug("mDNS registration failed: %s", e)
    return None


def _print_banner(host, port, token, tunnel_url=None):
    """Print the startup banner with network info."""
    lan_ips = _get_lan_ips()
    hostname = _get_hostname_local()
    local_url = f"http://localhost:{port}"

    # Scary warning when --tunnel is on. The PTY in IVE is a real shell
    # under the running user; anyone with the URL + token gets to drive
    # it. Print a red banner BEFORE the share box so it's the first
    # thing the operator sees at boot.
    if _TUNNEL_MODE:
        warn = [
            "",
            "  \033[1;41;97m  ⚠  --tunnel exposes this machine to the public internet  \033[0m",
            "  \033[1;31m   • Anyone with the URL + token can drive sessions, run shell commands,\033[0m",
            "  \033[1;31m     and read your filesystem under your user account.\033[0m",
            "  \033[1;31m   • Treat this token like an SSH key. Do NOT paste it in chat apps,\033[0m",
            "  \033[1;31m     email, or screenshots — preview bots will follow links and burn invites.\033[0m",
            "  \033[1;31m   • Mint short-TTL invites (Settings → Invites). Revoke when done.\033[0m",
            "",
        ]
        for ln in warn:
            print(ln, flush=True)

    lines = []
    lines.append("")
    lines.append("  \033[1;36mIVE\033[0m — Integrated Vibecoding Environment")
    lines.append(f"  v{VERSION}")
    lines.append("")
    lines.append(f"  \033[1mLocal:\033[0m     {local_url}")
    if host == "0.0.0.0":
        for ip in lan_ips:
            lines.append(f"  \033[1mNetwork:\033[0m   http://{ip}:{port}")
        if hostname:
            lines.append(f"  \033[1mBonjour:\033[0m   http://{hostname}:{port}")
    if tunnel_url:
        lines.append(f"  \033[1mTunnel:\033[0m    {tunnel_url}")
    if token:
        share_base = tunnel_url or (f"http://{lan_ips[0]}:{port}" if lan_ips else local_url)
        lines.append("")
        lines.append(f"  \033[1;33mToken:\033[0m     {token}")
        lines.append(f"  \033[1;32mShare:\033[0m     {share_base}")
        lines.append(f"  \033[90m           Teammates open the URL → paste token to connect\033[0m")
        lines.append(f"  \033[90m           Rate limited: {_AUTH_MAX_ATTEMPTS} attempts / {_AUTH_WINDOW_SECS}s, then {_AUTH_LOCKOUT_SECS}s lockout\033[0m")
    lines.append("")

    width = max(len(l.replace("\033[1;36m", "").replace("\033[0m", "").replace("\033[1m", "")
                      .replace("\033[1;33m", "").replace("\033[1;32m", "")) for l in lines if l) + 2
    border = "─" * width

    print(f"\n  \033[90m╭{border}╮\033[0m")
    for l in lines:
        if l:
            print(f"  \033[90m│\033[0m{l}")
        else:
            print(f"  \033[90m│\033[0m")
    print(f"  \033[90m╰{border}╯\033[0m\n", flush=True)


if __name__ == "__main__":
    import argparse
    import os

    parser = argparse.ArgumentParser(description="IVE backend server")
    parser.add_argument("--multiplayer", action="store_true",
                        help="Enable multiplayer mode (bind 0.0.0.0, require auth token)")
    parser.add_argument("--host", default=None,
                        help="Bind address (default: 127.0.0.1, or 0.0.0.0 with --multiplayer)")
    parser.add_argument("--port", type=int, default=None,
                        help=f"Port (default: {PORT})")
    parser.add_argument("--token", default=None,
                        help="Auth token (auto-generated if omitted with --multiplayer)")
    parser.add_argument("--headless", action="store_true",
                        help="Don't open browser on startup")
    parser.add_argument("--tunnel", action="store_true",
                        help="Start a Cloudflare tunnel for internet access")
    args = parser.parse_args()

    bind_host = args.host or ("0.0.0.0" if args.multiplayer or args.tunnel else HOST)
    bind_port = args.port or PORT

    # Token: required for multiplayer/tunnel, auto-generated if not provided
    if args.multiplayer or args.tunnel:
        AUTH_TOKEN = args.token or _generate_token()
    elif args.token:
        AUTH_TOKEN = args.token

    # Tunnel mode disables blanket 127.0.0.1 trust in the auth middleware,
    # since cloudflared proxies external traffic from the loopback address.
    if args.tunnel:
        _TUNNEL_MODE = True
    if args.multiplayer:
        _MULTIPLAYER_MODE = True

    # mDNS registration for LAN discovery
    mdns_proc = None
    if bind_host == "0.0.0.0":
        mdns_proc = _start_mdns(bind_port)

    # Cloudflare tunnel (async, started inside the event loop)
    tunnel_url_holder = [None]  # mutable for closure

    async def _startup_with_tunnel(app):
        if args.tunnel:
            tunnel_url_holder[0] = await _start_cloudflare_tunnel(bind_port)
            if tunnel_url_holder[0]:
                logger.info("Cloudflare tunnel: %s", tunnel_url_holder[0])
        _print_banner(bind_host, bind_port, AUTH_TOKEN, tunnel_url_holder[0])

    app = create_app()
    app.on_startup.append(_startup_with_tunnel)

    async def _cleanup_multiplayer(app):
        if mdns_proc:
            mdns_proc.terminate()
        if _tunnel_proc:
            try:
                _tunnel_proc.terminate()
                await asyncio.wait_for(_tunnel_proc.wait(), timeout=3)
            except Exception:
                _tunnel_proc.kill()

    app.on_cleanup.append(_cleanup_multiplayer)

    try:
        web.run_app(app, host=bind_host, port=bind_port, print=None)
    except Exception as fatal:
        logger.exception("Fatal server crash")
        import telemetry
        # Sync send — event loop is dead at this point
        import urllib.request
        try:
            payload = json.dumps({
                "api_key": telemetry.POSTHOG_API_KEY,
                "event": "ive_crash",
                "distinct_id": telemetry._machine_id(),
                "properties": {
                    "error_type": type(fatal).__name__,
                    "message": str(fatal)[:500],
                    "$lib": "ive-server",
                },
            }).encode()
            req = urllib.request.Request(
                f"{telemetry.POSTHOG_HOST}/capture/",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=3)
        except Exception:
            pass
        raise
