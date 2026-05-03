"""Idle reflection — fires the reflection prompt when a session is *truly* idle.

Replaces the old per-Stop reflection nudge (which fired every turn end after
12 tool uses + 30 min cooldown) and the per-Stop auto-knowledge extractor
(which ran a separate LLM scan on every Stop). Both were redundant: the agent
that just did the work has better context than an external LLM scan, and we
don't need to fire on every turn boundary — only on real pauses.

Flow:

  1. ``schedule(session_id, cli_type, ...)`` is called from the Stop hook.
     It cancels any pending timer for this session and starts a new one
     (default 5 min). If the session already had a reflection within the
     30-min throttle window, scheduling is a no-op.

  2. ``cancel(session_id)`` is called from the PreToolUse hook. The session
     is active again, so the pending timer is cancelled and we wait for the
     next Stop to schedule a fresh one.

  3. When the timer fires uncancelled, ``_fire`` PTY-injects the reflection
     prompt into the session (CLI-aware: gemini gets a flat single line,
     claude gets the escape-clear + delay + write + delay + Enter pattern
     used everywhere else for prompt injection). Emits IDLE_REFLECTION_FIRED.

CLI-agnostic: the PTY injection mirrors worker_queue._do_deliver so any
CLI we add later only needs a profile entry, not a fork in this module.
"""
from __future__ import annotations

import asyncio
import logging
import time

from commander_events import CommanderEvent
from event_bus import bus
from db import get_db

logger = logging.getLogger(__name__)

# ── Tunables ─────────────────────────────────────────────────────────
IDLE_DELAY = 300.0          # seconds of pure quiet before we fire
MIN_TOOL_USES = 12          # below this the turn isn't substantive enough
THROTTLE_SECS = 1800.0      # don't re-fire within this window per session

# Bullets are split by which MCP exposes the tool, so each session_type
# only sees prompts it can actually act on.
#
#   save_memory    — present on worker MCP, commander MCP, documentor MCP
#   headsup,       — worker MCP + commander MCP
#   coord_check_overlap
#   update_digest, — worker MCP only (tester sessions also use worker MCP)
#   contribute_knowledge,
#   blocking_bulletin
#
# Documentor MCP (documentor_mcp_server.py) is the most trimmed: only
# save_memory from the list above.

_SAVE_MEMORY_BULLET = (
    "  • Durable user preference, project decision, or non-obvious gotcha "
    "→ save_memory (type=user/feedback/project/reference).\n"
)

_COORD_BULLETS = (
    "  • You're about to keep editing the same files in the next turn → "
    "coord_check_overlap to see if a peer is touching them.\n"
    "  • A peer agent is about to step on a footgun you just hit → headsup.\n"
)

_WORKER_KB_BULLETS = (
    "  • Concrete progress, decisions, files touched, or discoveries another "
    "agent should know about → update_digest.\n"
    "  • A reusable codebase insight (gotcha, pattern, convention, api, setup) "
    "→ contribute_knowledge.\n"
    "  • A live blocker that would waste anyone else's turn until resolved → "
    "blocking_bulletin.\n"
    "  • Your work drifted from the active ticket shown in your context → "
    "switch_active_ticket(ticket_id | null) before document_to_board so the "
    "write lands on the right ticket.\n"
    "  • You finished feature-shaped work this turn → document_to_board "
    "(action='create' for new, 'update' for the bound ticket). "
    "If the edits weren't feature-shaped (exploration, doc-only, refactor "
    "with no behavior change), call action='skip' so the system stops "
    "checking on this session.\n"
)

# Commander has its own contribute_knowledge (mcp_server.py) for routing/team
# patterns. Distinct from workers' use because commander rarely has direct
# code insights — its lessons are about which worker fits which task class.
_COMMANDER_KB_BULLET = (
    "  • A routing/orchestration lesson worth keeping (which worker class fits "
    "which task, model-tier patterns, team formation rules) → "
    "contribute_knowledge (category='orchestration').\n"
)

# Testers have the worker MCP attached (per server.py:2113), so they have
# update_digest/contribute_knowledge/headsup. They don't lock files, so
# blocking_bulletin is dropped; framing is bug-surface-via-update_my_task
# rather than direct fix.
_TESTER_BULLETS = (
    "  • Concrete test progress, current focus, or coverage notes → update_digest.\n"
    "  • A flaky test, UI quirk, undocumented behavior, or 'still broken' note "
    "→ contribute_knowledge (category='gotcha').\n"
    "  • A bug to surface — use update_my_task with reproduction steps; "
    "commander will file follow-up tasks for implementers.\n"
    "  • Pure verification with no implementer-facing follow-up → "
    "document_to_board(action='skip'). If your bound ticket was a "
    "verification task itself, action='update' moves it through.\n"
)

_WORKER_LIKE_TYPES = {"worker", "planner", ""}  # empty = legacy default
_TESTER_LIKE_TYPES = {"tester", "test_worker"}


def _build_prompt(session_type: str | None) -> str:
    """Build the reflection prompt with bullets the session can actually act on.

    Each session_type has a different MCP surface; we emit only the bullets
    that resolve to real tools for this session. Documentor in particular
    has no W2W tooling beyond save_memory.
    """
    stype = (session_type or "").strip()
    body = _SAVE_MEMORY_BULLET

    if stype in _WORKER_LIKE_TYPES:
        body += _COORD_BULLETS + _WORKER_KB_BULLETS
    elif stype in _TESTER_LIKE_TYPES:
        body += _COORD_BULLETS + _TESTER_BULLETS
    elif stype == "commander":
        body += _COORD_BULLETS + _COMMANDER_KB_BULLET
    # documentor and unknown types get save_memory only.

    return (
        "[Commander reflection] Before you stop, take one quiet moment.\n"
        "\n"
        "Did this turn surface anything worth saving for future you, your peers, "
        "or the workspace? Specifically — and only call a tool if the answer is yes:\n"
        "\n"
        f"{body}"
        "\n"
        "Default action: do nothing. Most turns don't need any of these. "
        "If you do call a tool, keep it terse — one entry, factual, no narration. "
        "For contribute_knowledge specifically: that entry is auto-loaded into "
        "every future session's system prompt, so reference durable symbols "
        "(function/class names, file paths) — never line numbers, which rot."
    )


# ── Module state ─────────────────────────────────────────────────────
_pty_mgr = None
_broadcast_fn = None

_pending_timers: dict[str, asyncio.Task] = {}
_last_fired_at: dict[str, float] = {}


def set_pty_manager(mgr):
    global _pty_mgr
    _pty_mgr = mgr


def set_broadcast_fn(fn):
    global _broadcast_fn
    _broadcast_fn = fn


# ── Settings gate ────────────────────────────────────────────────────
_settings_cache: dict[str, float | bool] = {}
_SETTINGS_TTL = 30.0


async def _is_enabled() -> bool:
    """Honor experimental_stop_reflection (default ON unless explicitly off)."""
    cached_ts = float(_settings_cache.get("ts") or 0.0)
    if time.monotonic() - cached_ts < _SETTINGS_TTL:
        return bool(_settings_cache.get("enabled", True))
    try:
        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT value FROM app_settings WHERE key = 'experimental_stop_reflection'"
            )
            row = await cur.fetchone()
            enabled = not (row and row["value"] == "off")
            _settings_cache["enabled"] = enabled
            _settings_cache["ts"] = time.monotonic()
            return enabled
        finally:
            await db.close()
    except Exception:
        return True


# ── Public API ───────────────────────────────────────────────────────
def schedule(session_id: str, cli_type: str | None, tool_uses: int,
             workspace_id: str | None = None, delay: float = IDLE_DELAY) -> None:
    """Schedule a reflection to fire after `delay` seconds of pure idle.

    Cancels any prior pending timer for this session. No-op if the agent
    didn't do enough work, or we're inside the throttle window.
    """
    if not session_id:
        return
    if tool_uses < MIN_TOOL_USES:
        return
    last = _last_fired_at.get(session_id, 0.0)
    if last and (time.monotonic() - last) < THROTTLE_SECS:
        return

    cancel(session_id)
    try:
        task = asyncio.create_task(_run(session_id, cli_type, workspace_id, delay))
        _pending_timers[session_id] = task
    except RuntimeError:
        # No running loop (shouldn't happen in server context, but be defensive)
        return


def cancel(session_id: str) -> None:
    """Cancel any pending reflection timer for this session."""
    task = _pending_timers.pop(session_id, None)
    if task and not task.done():
        task.cancel()


def clear_session(session_id: str) -> None:
    """Drop all per-session state (call on session_deleted)."""
    cancel(session_id)
    _last_fired_at.pop(session_id, None)


# ── Timer body ───────────────────────────────────────────────────────
async def _run(session_id: str, cli_type: str | None,
               workspace_id: str | None, delay: float):
    try:
        await asyncio.sleep(delay)
    except asyncio.CancelledError:
        return
    # We slept the full delay without being cancelled → real idle.
    _pending_timers.pop(session_id, None)
    try:
        if not await _is_enabled():
            return
        await _fire(session_id, cli_type, workspace_id)
    except Exception:
        logger.exception("Idle reflection fire failed for session %s", session_id[:8])


async def _fire(session_id: str, cli_type: str | None, workspace_id: str | None):
    if not _pty_mgr or not _pty_mgr.is_alive(session_id):
        logger.debug("idle_reflection: session %s not alive, skip", session_id[:8])
        return

    # Look up session_type so the prompt only mentions tools this session
    # can actually call. Falls back to the worker-like prompt on lookup
    # failure (the most common session type).
    session_type: str | None = None
    try:
        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT session_type FROM sessions WHERE id = ?", (session_id,))
            row = await cur.fetchone()
            if row:
                session_type = row["session_type"]
        finally:
            await db.close()
    except Exception:
        pass

    prompt = _build_prompt(session_type)
    cli = (cli_type or "claude").lower()
    msg_bytes = prompt.encode("utf-8")

    if cli == "gemini":
        clean = prompt.replace("\n", " ").replace("\r", " ")
        _pty_mgr.write(session_id, clean.encode("utf-8") + b"\r")
    else:
        # Same pattern as worker_queue / auto_exec: clear input, write, Enter.
        _pty_mgr.write(session_id, b"\x1b" + b"\x7f" * 20)
        await asyncio.sleep(0.15)
        _pty_mgr.write(session_id, msg_bytes)
        await asyncio.sleep(0.4)
        _pty_mgr.write(session_id, b"\r")

    _last_fired_at[session_id] = time.monotonic()
    logger.info("Idle reflection fired for session %s", session_id[:8])

    try:
        await bus.emit(CommanderEvent.IDLE_REFLECTION_FIRED, {
            "session_id": session_id,
            "workspace_id": workspace_id,
        }, source="idle_reflection")
    except Exception:
        logger.exception("Failed to emit IDLE_REFLECTION_FIRED")

    if _broadcast_fn:
        try:
            await _broadcast_fn({
                "type": "idle_reflection_fired",
                "session_id": session_id,
            })
        except Exception:
            logger.debug("idle_reflection broadcast failed")


# ── Registration ─────────────────────────────────────────────────────
def register_subscribers():
    """Reserved for future event-driven hooks. No-op for now."""
    logger.info("Idle reflection registered")
