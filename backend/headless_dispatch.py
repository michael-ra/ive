"""Structured headless dispatch for Claude Code and Codex CLI.

Claude Code emits its ``stream-json`` protocol. Codex 0.147.0 emits JSONL
from ``codex exec --json`` with these top-level event names:

``thread.started``, ``turn.started``, ``turn.completed``, ``turn.failed``,
``item.started``, ``item.updated``, ``item.completed``, and ``error``.

Raw events remain available to callers. Codex lifecycle and tool boundaries
are additionally translated into :class:`cli_features.NormalizedEvent` and
validated/emitted through the central event registry.
"""

from __future__ import annotations

import asyncio
from subprocess_control import terminate_process_group
import inspect
import json
import logging
import os
from typing import Awaitable, Callable, Optional

from cli_features import HookEvent, NormalizedEvent
from event_registry import TypedEventDispatcher

logger = logging.getLogger(__name__)


CODEX_JSON_EVENT_TYPES = frozenset({
    "thread.started",
    "turn.started",
    "turn.completed",
    "turn.failed",
    "item.started",
    "item.updated",
    "item.completed",
    "error",
})

CODEX_JSON_ITEM_TYPES = frozenset({
    "agent_message",
    "reasoning",
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "web_search",
    "todo_list",
    "error",
})

_CODEX_TOOL_ITEM_TYPES = frozenset({
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "web_search",
})

_normalized_dispatcher = TypedEventDispatcher()

# Substrings that mark a usage/quota limit inside a structured error result.
_QUOTA_MARKERS = (
    "usage limit reached",
    "limit reached",
    "credit balance is too low",
    "rate_limit",
    "quota",
)
# Substrings that mark an auth failure inside a structured error result.
_AUTH_MARKERS = (
    "authentication_error",
    "invalid api key",
    "invalid x-api-key",
    "oauth token has expired",
    "please run /login",
    "not logged in",
    "unauthorized",
)


def _classify_error(text: str) -> Optional[str]:
    low = (text or "").lower()
    if any(marker in low for marker in _AUTH_MARKERS):
        return "auth_failed"
    if any(marker in low for marker in _QUOTA_MARKERS):
        return "quota_exceeded"
    return None


def _infer_cli_type(cli_binary: str, cli_type: Optional[str]) -> str:
    if cli_type:
        return str(cli_type).lower()
    name = os.path.basename(cli_binary).lower()
    return "codex" if name == "codex" or name.startswith("codex-") else "claude"


def build_headless_argv(
    prompt: str,
    *,
    cli_binary: str = "claude",
    cli_type: Optional[str] = None,
    model: Optional[str] = None,
    resume_id: Optional[str] = None,
    extra_args: Optional[list[str]] = None,
) -> list[str]:
    """Build the release-verified one-shot argv for a supported CLI."""
    selected_cli = _infer_cli_type(cli_binary, cli_type)
    if selected_cli == "codex":
        args = [cli_binary, "exec"]
        if resume_id:
            args.append("resume")
        args += ["--json", "--skip-git-repo-check"]
        if model:
            args += ["--model", model]
        if extra_args:
            args += list(extra_args)
        if resume_id:
            args.append(str(resume_id))
        args.append(prompt)
        return args

    args = [
        cli_binary,
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
    ]
    if model:
        args += ["--model", model]
    if resume_id:
        args += ["--resume", str(resume_id)]
    if extra_args:
        args += list(extra_args)
    return args


def _error_message(value) -> str:
    if isinstance(value, dict):
        return str(value.get("message") or value.get("error") or value)
    return str(value or "")


def _normalize_codex_event(
    event: dict, *, session_id: str
) -> Optional[NormalizedEvent]:
    """Translate one Codex JSONL record to the canonical lifecycle vocabulary."""
    native = str(event.get("type") or "")
    canonical: Optional[HookEvent] = None

    if native == "thread.started":
        canonical = HookEvent.SESSION_START
    elif native == "turn.started":
        canonical = HookEvent.PROMPT_SUBMIT
    elif native == "turn.completed":
        canonical = HookEvent.TURN_COMPLETE
    elif native == "turn.failed":
        canonical = HookEvent.TURN_FAILURE
    elif native in {"item.started", "item.completed"}:
        item = event.get("item") or {}
        if item.get("type") not in _CODEX_TOOL_ITEM_TYPES:
            return None
        if native == "item.started":
            canonical = HookEvent.PRE_TOOL
        else:
            failed = (
                item.get("status") == "failed"
                or (
                    item.get("exit_code") is not None
                    and item.get("exit_code") != 0
                )
            )
            canonical = (
                HookEvent.POST_TOOL_FAILURE if failed else HookEvent.POST_TOOL
            )

    if canonical is None:
        return None
    return NormalizedEvent(
        event=canonical,
        native=native,
        session_id=session_id,
        payload=event,
        cli="codex",
    )


async def _call_safely(callback, value, *, label: str) -> None:
    if callback is None:
        return
    try:
        result = callback(value)
        if inspect.isawaitable(result):
            await result
    except Exception as exc:  # callbacks must never kill the stream reader
        logger.error("headless %s callback error: %s", label, exc)


async def run_headless(
    prompt: str,
    cwd: str,
    *,
    cli_binary: str = "claude",
    cli_type: Optional[str] = None,
    model: Optional[str] = None,
    resume_id: Optional[str] = None,
    extra_args: Optional[list[str]] = None,
    extra_env: Optional[dict[str, str]] = None,
    timeout: Optional[float] = None,
    on_event: Optional[Callable[[dict], Awaitable[None]]] = None,
    on_normalized_event: Optional[
        Callable[[NormalizedEvent], Awaitable[None]]
    ] = None,
) -> dict:
    """Run one headless turn and return raw plus normalized structured events."""
    selected_cli = _infer_cli_type(cli_binary, cli_type)
    args = build_headless_argv(
        prompt,
        cli_binary=cli_binary,
        cli_type=selected_cli,
        model=model,
        resume_id=resume_id,
        extra_args=extra_args,
    )

    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)

    events: list[dict] = []
    normalized_events: list[NormalizedEvent] = []
    result_text = ""
    usage = None
    error_text = None
    pending_error = None
    error_kind = None
    thread_id = str(resume_id or "")

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=cwd,
            env=env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=(os.name == "posix"),
        )
    except FileNotFoundError:
        return {
            "ok": False,
            "result_text": "",
            "error_kind": None,
            "error": f"{cli_binary} not found on PATH",
            "usage": None,
            "events": [],
            "normalized_events": [],
            "session_id": thread_id or None,
            "exit_code": None,
        }

    async def _read_stream() -> None:
        nonlocal result_text, usage, error_text, pending_error, error_kind, thread_id
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict):
                continue
            events.append(event)
            await _call_safely(on_event, event, label="on_event")

            if selected_cli == "codex":
                if event.get("type") == "thread.started":
                    thread_id = str(event.get("thread_id") or thread_id)
                normalized = _normalize_codex_event(
                    event, session_id=thread_id
                )
                if normalized is not None:
                    normalized_events.append(normalized)
                    await _normalized_dispatcher.emit(
                        normalized.event,
                        normalized,
                        site="backend/headless_dispatch.py:_normalize_codex_event",
                    )
                    await _call_safely(
                        on_normalized_event,
                        normalized,
                        label="on_normalized_event",
                    )

                event_type = event.get("type")
                if event_type == "item.completed":
                    item = event.get("item") or {}
                    if item.get("type") == "agent_message":
                        result_text = str(item.get("text") or result_text)
                elif event_type == "turn.completed":
                    usage = event.get("usage") or usage
                elif event_type == "error":
                    pending_error = _error_message(event.get("message") or event)
                elif event_type == "turn.failed":
                    error_text = _error_message(event.get("error")) or pending_error
                    error_text = error_text or "unknown error"
                    error_kind = _classify_error(error_text)
                continue

            if event.get("type") == "result":
                usage = event.get("usage") or usage
                if event.get("is_error"):
                    error_text = _error_message(
                        event.get("result") or event.get("error")
                    ) or "unknown error"
                    error_kind = _classify_error(error_text)
                else:
                    result_text = str(event.get("result") or result_text)

    stderr_task = None
    if proc.stderr is not None:
        stderr_task = asyncio.create_task(proc.stderr.read())

    try:
        await asyncio.wait_for(_read_stream(), timeout=timeout)
        await asyncio.wait_for(proc.wait(), timeout=timeout)
    except asyncio.CancelledError:
        await terminate_process_group(proc)
        if stderr_task is not None:
            stderr_task.cancel()
            await asyncio.gather(stderr_task, return_exceptions=True)
        raise
    except asyncio.TimeoutError:
        await terminate_process_group(proc)
        if stderr_task is not None:
            stderr_task.cancel()
            await asyncio.gather(stderr_task, return_exceptions=True)
        return {
            "ok": False,
            "result_text": result_text,
            "error_kind": None,
            "error": "headless dispatch timed out",
            "usage": usage,
            "events": events,
            "normalized_events": normalized_events,
            "session_id": thread_id or None,
            "exit_code": None,
        }

    stderr = b""
    if stderr_task is not None:
        try:
            stderr = await stderr_task
        except asyncio.CancelledError:
            pass

    exit_code = proc.returncode
    if error_text is None and exit_code not in (0, None):
        error_text = pending_error
        if not error_text and stderr:
            error_text = stderr.decode("utf-8", errors="replace").strip()[:2000]
        error_text = error_text or f"headless process exited {exit_code}"
        error_kind = _classify_error(error_text)

    return {
        "ok": exit_code == 0 and error_text is None,
        "result_text": result_text,
        "error_kind": error_kind,
        "error": error_text,
        "usage": usage,
        "events": events,
        "normalized_events": normalized_events,
        "session_id": thread_id or None,
        "exit_code": exit_code,
    }
