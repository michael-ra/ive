"""Normalize native CLI history rows into IVE's canonical message blocks.

The frontend should render this small internal vocabulary, not each CLI's
native transcript shape. Native adapters here are intentionally permissive:
structured events are preferred, text parsing is only a compatibility fallback.
"""

from __future__ import annotations

import html
import json
import re
from typing import Any


CanonicalMessage = tuple[str, object]

_TASK_NOTIFICATION_RE = re.compile(
    r"<task-notification\b[^>]*>(?P<body>.*?)</task-notification>",
    re.IGNORECASE | re.DOTALL,
)
_BACKGROUND_START_RE = re.compile(
    r"Command running in background with ID:\s*`?(?P<id>[A-Za-z0-9_-]+)`?\.\s*"
    r"Output is being written to:\s*(?P<output_file>\S+)",
    re.IGNORECASE,
)
_BACKGROUND_RUNNING_RE = re.compile(
    r"(?:Background process started|Running(?: in the background)?)\s*"
    r"\(ID:\s*`?(?P<id>[A-Za-z0-9_-]+)`?\)",
    re.IGNORECASE,
)
_BACKGROUND_DONE_RE = re.compile(
    r"(?:^|\n)\s*(?:Done|Completed)\s*\(ID:\s*`?(?P<id>[A-Za-z0-9_-]+)`?\)\.\s*"
    r"Output(?:\s+was)?:\s*(?P<output>[\s\S]*)$",
    re.IGNORECASE,
)

_TASK_EVENT_STATUS = {
    "task.started": "running",
    "task_started": "running",
    "task.start": "running",
    "task.running": "running",
    "task.progress": "running",
    "task_progress": "running",
    "task.completed": "completed",
    "task_completed": "completed",
    "task.complete": "completed",
    "task.done": "completed",
    "task.failed": "failed",
    "task_failed": "failed",
    "task.error": "failed",
    "background_task.started": "running",
    "background_task_started": "running",
    "background_task.completed": "completed",
    "background_task_completed": "completed",
    "background_task.failed": "failed",
    "background_task_failed": "failed",
}


def normalize_history_entry(entry: dict, cli_type: str | None = None) -> CanonicalMessage | None:
    """Return ``(role, content)`` for one native history row.

    Canonical roles are ``user``, ``assistant``, and ``tool_result``. Canonical
    content is either plain text or a list of blocks such as ``text``,
    ``thinking``, ``tool_use``, ``tool_result``, and ``task_notification``.
    """
    if not isinstance(entry, dict):
        return None

    task_blocks = _task_notification_from_entry(entry)
    if task_blocks:
        return "tool_result", task_blocks

    # Claude marks injected rows (skill bodies, <local-command-caveat>,
    # <command-message> expansions) with isMeta. The user never typed them,
    # so they must not render as (often huge) user bubbles.
    if entry.get("isMeta") is True:
        return None

    codex = _normalize_codex_entry(entry)
    if codex:
        return codex

    antigravity = _normalize_antigravity_entry(entry)
    if antigravity:
        return antigravity

    acp = _normalize_acp_session_update(entry)
    if acp:
        return acp

    response_item = _normalize_response_item(entry)
    if response_item:
        return response_item

    if isinstance(entry.get("message"), dict):
        entry_type = _clean_type(entry.get("type"))
        if entry_type and entry_type not in ("user", "assistant", "human", "message"):
            return None
        inner = entry["message"]
        role = inner.get("role") or entry_type or "unknown"
        content = inner.get("content", "")
        if _normalize_role(role) == "user":
            command = _claude_command_row(content)
            if command is not None:
                return command or None
        return _normalize_role_content(role, content)

    role = (
        entry.get("role")
        or entry.get("author")
        or entry.get("speaker")
        or (entry.get("type") if _clean_type(entry.get("type")) in ("user", "assistant", "human", "model", "tool") else None)
    )
    if role:
        content = _entry_content(entry)
        return _normalize_role_content(role, content)

    return None


_CLAUDE_CMD_NAME_RE = re.compile(r"<command-name>\s*(.*?)\s*</command-name>", re.DOTALL)
_CLAUDE_CMD_ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.DOTALL)
_CLAUDE_CMD_NOISE_RE = re.compile(
    r"<(local-command-caveat|local-command-stdout|local-command-stderr)>.*?</\1>", re.DOTALL)
_CLAUDE_CMD_TAG_RE = re.compile(
    r"</?(command-name|command-message|command-args|local-command-caveat|"
    r"local-command-stdout|local-command-stderr)>")


def _claude_command_row(content: object) -> CanonicalMessage | tuple | None:
    """Claude slash-command rows (/clear, /model, /exit, ...).

    Returns None when ``content`` is not a command row, ``()`` when it is
    pure noise to drop (caveat / local stdout), or a ``("user", [command])``
    row with one compact ``command`` block.
    """
    if isinstance(content, str):
        text = content
    elif isinstance(content, list) and content and all(
        isinstance(b, dict) and _clean_type(b.get("type")) == "text" for b in content
    ):
        text = "\n".join(str(b.get("text") or "") for b in content)
    else:
        return None
    if not _CLAUDE_CMD_TAG_RE.search(text):
        return None
    name = _CLAUDE_CMD_NAME_RE.search(text)
    if name and name.group(1).strip():
        args = _CLAUDE_CMD_ARGS_RE.search(text)
        block = {"type": "command", "name": name.group(1).strip()}
        if args and args.group(1).strip():
            block["args"] = args.group(1).strip()
        return "user", [block]
    rest = _CLAUDE_CMD_NOISE_RE.sub("", text).strip()
    if not rest:
        return ()
    return None


def _entry_content(entry: dict) -> object:
    for key in ("content", "parts", "items", "text", "message"):
        value = entry.get(key)
        if value not in (None, ""):
            return value
    return ""


def _normalize_role_content(role: object, content: object) -> CanonicalMessage | None:
    role_name = _normalize_role(role)
    if role_name is None:
        return None

    normalized_content = normalize_content(content)
    if normalized_content is None:
        return None

    blocks = _content_blocks(normalized_content)
    if blocks and all(_is_tool_result_block(block) or _is_task_notification_block(block) for block in blocks):
        role_name = "tool_result"
    elif blocks and all(_is_tool_use_block(block) for block in blocks):
        role_name = "assistant"

    return role_name, normalized_content


def normalize_content(content: object) -> object | None:
    """Normalize native content into canonical block lists where useful."""
    if content is None:
        return ""

    if isinstance(content, str):
        task = _task_notification_from_text(content)
        if task:
            return task
        return content

    if isinstance(content, list):
        blocks: list[object] = []
        for item in content:
            normalized = _normalize_content_item(item)
            if normalized is None:
                continue
            if isinstance(normalized, list):
                blocks.extend(normalized)
            else:
                blocks.append(normalized)
        return blocks

    if isinstance(content, dict):
        task = _task_notification_from_entry(content)
        if task:
            return task
        if isinstance(content.get("content"), list):
            return normalize_content(content["content"])
        if isinstance(content.get("parts"), list):
            return normalize_content(content["parts"])
        normalized = _normalize_content_item(content)
        if normalized is None:
            return [content]
        return normalized if isinstance(normalized, list) else [normalized]

    return str(content)


def _normalize_content_item(item: object) -> object | list[object] | None:
    if item is None:
        return None
    if isinstance(item, str):
        task = _task_notification_from_text(item)
        return task if task else item
    if not isinstance(item, dict):
        return str(item)

    task = _task_notification_from_entry(item)
    if task:
        return task

    if "functionCall" in item:
        return _function_call_to_tool_use(item.get("functionCall"))
    if "functionResponse" in item:
        return _function_response_to_tool_result(item.get("functionResponse"))
    if isinstance(item.get("content"), dict) and _clean_type(item.get("type")) == "content":
        return _normalize_content_item(item["content"])

    block_type = _clean_type(item.get("type"))
    if block_type == "text" or (not block_type and "text" in item):
        text = str(item.get("text") or item.get("content") or "")
        task_text = _task_notification_from_text(text)
        return task_text if task_text else {"type": "text", "text": text}

    if block_type in ("thinking", "reasoning", "agent_thought", "thought"):
        text = _first_text(item, "thinking", "text", "summary", "content")
        return {"type": "thinking", "thinking": text}

    if block_type in ("tool_use", "tooluse", "tool_call", "function_call", "custom_tool_call", "mcp_tool_call", "dynamic_tool_call"):
        return _tool_call_to_tool_use(item)

    if block_type in (
        "tool_result",
        "toolresult",
        "tool_output",
        "tool_call_output",
        "tool_call_update",
        "function_response",
        "function_call_output",
        "custom_tool_call_output",
    ):
        return _tool_output_to_tool_result(item)

    if block_type == "message" and "content" in item:
        return _content_blocks(normalize_content(item.get("content"))) or []

    if isinstance(item.get("tool_calls"), list):
        return [_tool_call_to_tool_use(call) for call in item["tool_calls"] if isinstance(call, dict)]

    if item.get("text"):
        text = str(item.get("text"))
        task_text = _task_notification_from_text(text)
        return task_text if task_text else {"type": "text", "text": text}

    return item


def _normalize_acp_session_update(entry: dict) -> CanonicalMessage | None:
    update = entry.get("update") if isinstance(entry.get("update"), dict) else entry
    kind = _clean_type(update.get("sessionUpdate") or update.get("session_update"))
    if not kind:
        return None

    content = update.get("content")
    if content is None:
        content = update.get("contentDelta") or update.get("delta") or update.get("text") or ""

    if kind == "user_message_chunk":
        return _normalize_role_content("user", content)
    if kind == "agent_message_chunk":
        return _normalize_role_content("assistant", content)
    if kind == "agent_thought_chunk":
        text = _text_value(content)
        return "assistant", [{"type": "thinking", "thinking": text}]

    if kind == "tool_call":
        return "assistant", [_tool_call_to_tool_use(update)]
    if kind == "tool_call_update":
        return "tool_result", [_tool_output_to_tool_result(update)]

    if kind == "plan":
        text = _format_plan_update(update)
        return ("assistant", [{"type": "text", "text": text}]) if text else None

    return None


def _normalize_response_item(item: dict) -> CanonicalMessage | None:
    item_type = _clean_type(item.get("type"))
    if item_type == "message":
        role = item.get("role") or "assistant"
        return _normalize_role_content(role, item.get("content", ""))
    if item_type in ("reasoning", "thought"):
        text = _reasoning_text(item)
        return ("assistant", [{"type": "thinking", "thinking": text}]) if text else None
    if item_type in ("function_call", "custom_tool_call", "tool_call"):
        return "assistant", [_tool_call_to_tool_use(item)]
    if item_type in ("function_call_output", "custom_tool_call_output", "tool_call_output"):
        return "tool_result", [_tool_output_to_tool_result(item)]
    return None


def _normalize_codex_entry(entry: dict) -> CanonicalMessage | None:
    entry_type = _clean_type(entry.get("type"))
    payload = entry.get("payload") if isinstance(entry.get("payload"), dict) else None
    if not payload:
        return None

    if entry_type == "session_meta" or entry_type == "turn_context":
        return None

    if entry_type == "response_item":
        payload_type = _clean_type(payload.get("type"))
        if payload_type == "message" and _clean_type(payload.get("role")) != "assistant":
            return None
        return _normalize_response_item(payload)

    if entry_type == "event_msg":
        event_type = _clean_type(payload.get("type"))
        if event_type == "user_message":
            # Codex <= 0.148 (and the Desktop app) shape.
            return _normalize_role_content("user", payload.get("message", ""))
        if event_type == "item_completed":
            # Codex 0.149+ (codex-tui 0.16x) records user turns only as
            # item_completed{item:{type:"UserMessage"}}. AgentMessage,
            # Reasoning and CommandExecution items duplicate response_item
            # rows, so only the user turn is taken from here.
            item = payload.get("item") if isinstance(payload.get("item"), dict) else {}
            if _clean_type(item.get("type")) == "usermessage":
                return _codex_user_item(item)
            return None
        if event_type in ("agent_reasoning", "agent_reasoning_delta"):
            text = _first_text(payload, "message", "text")
            return ("assistant", [{"type": "thinking", "thinking": text}]) if text else None
        # Codex also emits agent_message, but response_item carries the same
        # assistant turn with structured content. Skipping avoids duplicates.
        return None

    return None


_CODEX_INJECTED_RE = re.compile(r"^\s*<([A-Za-z_][\w-]*)\b[^>]*>[\s\S]*</\1>\s*$")
_CODEX_INJECTED_PREFIXES = ("# AGENTS.md instructions", "<environment_context", "<user_instructions",
                            "<permissions", "<INSTRUCTIONS")


def _is_codex_event_user(entry: dict) -> bool:
    if _clean_type(entry.get("type")) != "event_msg" or not isinstance(entry.get("payload"), dict):
        return False
    payload = entry["payload"]
    event_type = _clean_type(payload.get("type"))
    if event_type == "user_message":
        return True
    item = payload.get("item") if isinstance(payload.get("item"), dict) else {}
    return event_type == "item_completed" and _clean_type(item.get("type")) == "usermessage"


def _codex_response_user(entry: dict) -> CanonicalMessage | None:
    """User prompt from a codex ``response_item`` role=user, minus injected context."""
    if _clean_type(entry.get("type")) != "response_item" or not isinstance(entry.get("payload"), dict):
        return None
    payload = entry["payload"]
    if _clean_type(payload.get("type")) != "message" or _clean_type(payload.get("role")) != "user":
        return None
    content = payload.get("content")
    parts = content if isinstance(content, list) else [{"type": "input_text", "text": content}]
    texts = []
    for part in parts:
        if not isinstance(part, dict):
            continue
        text = str(part.get("text") or "")
        if not text.strip():
            continue
        if text.lstrip().startswith(_CODEX_INJECTED_PREFIXES) or _CODEX_INJECTED_RE.match(text):
            continue
        texts.append(text)
    return ("user", "\n".join(texts)) if texts else None


class HistoryNormalizer:
    """Incremental form of :func:`normalize_history_entries`.

    ``feed(entry)`` returns ``(role, content)`` or None, one entry at a time,
    in transcript order. Used by the chat transcript cache, which parses only
    appended lines. Codex user prompts appear in up to three record shapes
    (see normalize_history_entries); the same back-to-back dedup runs here
    across chunk boundaries because the state lives on this object.

    ``response_item`` user rows are a fallback for rollouts without any user
    event. When a user event shows up after such a fallback row was already
    returned, the earlier rows are wrong: ``needs_rebuild`` turns True and the
    caller re-normalizes from the start with ``has_event_user=True``.
    """

    def __init__(self, has_event_user: bool = False):
        self.has_event_user = has_event_user
        self.used_response_fallback = False
        self.needs_rebuild = False
        self._last_codex_user = None

    @classmethod
    def next_generation(cls, prev: "HistoryNormalizer | None" = None) -> "HistoryNormalizer":
        """Normalizer for a new pass over the transcript (cache state_factory).

        After a rebuild request the new pass starts knowing that the rollout
        has user events; any other new pass (file rewritten) starts fresh.
        """
        carry = bool(prev is not None and prev.needs_rebuild and prev.has_event_user)
        return cls(has_event_user=carry)

    def feed(self, entry) -> CanonicalMessage | None:
        if not isinstance(entry, dict):
            return None
        if not self.has_event_user and _is_codex_event_user(entry):
            self.has_event_user = True
            if self.used_response_fallback:
                self.needs_rebuild = True
        normalized = normalize_history_entry(entry)
        if normalized is None and not self.has_event_user:
            normalized = _codex_response_user(entry)
            if normalized is not None:
                self.used_response_fallback = True
        if normalized is None:
            return None
        role, content = normalized
        entry_type = _clean_type(entry.get("type"))
        if role == "user" and entry_type in ("response_item", "event_msg"):
            payload = entry.get("payload") if isinstance(entry.get("payload"), dict) else {}
            shape = (entry_type, _clean_type(payload.get("type")))
            key = (content if isinstance(content, str) else _text_value(content)).strip()
            # Same prompt in a second record shape right after the first one.
            # A prompt the user really sent twice has the same shape both times.
            if self._last_codex_user and key == self._last_codex_user[0] and shape != self._last_codex_user[1]:
                return None
            self._last_codex_user = (key, shape)
        else:
            self._last_codex_user = None
        return role, content


def normalize_history_entry_standalone(entry) -> CanonicalMessage | None:
    """One row without transcript context (re-format of an already listed row).

    Like normalize_history_entry, plus the Codex ``response_item`` user
    fallback: such a row is only listed when the rollout has no user events.
    """
    if not isinstance(entry, dict):
        return None
    return normalize_history_entry(entry) or _codex_response_user(entry)


def normalize_history_entries(entries: list) -> list[tuple[int, str, object]]:
    """Normalize a whole transcript: ``[(index, role, content), ...]``.

    Adds what a single row cannot know. Codex records each user prompt up to
    three times (``response_item`` role=user, ``event_msg user_message`` in
    <=0.148, ``event_msg item_completed UserMessage`` in 0.149+). The event
    form is the typed text, so it wins; ``response_item`` user rows are used
    only when a rollout has no user event at all, with injected context
    (<environment_context>, AGENTS.md, ...) skipped. The same prompt in two
    record shapes back to back (old + new event) collapses to one row.
    """
    has_event_user = any(isinstance(e, dict) and _is_codex_event_user(e) for e in entries)
    normalizer = HistoryNormalizer(has_event_user=has_event_user)
    rows: list[tuple[int, str, object]] = []
    for idx, entry in enumerate(entries):
        normalized = normalizer.feed(entry)
        if normalized is not None:
            rows.append((idx, normalized[0], normalized[1]))
    return rows


def _codex_user_item(item: dict) -> CanonicalMessage | None:
    content = item.get("content")
    if isinstance(content, list):
        blocks = []
        for part in content:
            if not isinstance(part, dict):
                continue
            part_type = _clean_type(part.get("type"))
            if part_type in ("text", "input_text") or (not part_type and part.get("text")):
                text = str(part.get("text") or "")
                if text:
                    blocks.append({"type": "text", "text": text})
            elif part_type in ("image", "local_image", "input_image"):
                blocks.append({"type": "text", "text": "[image]"})
        if not blocks:
            return None
        if all(b.get("type") == "text" for b in blocks):
            return "user", "\n".join(b["text"] for b in blocks)
        return "user", blocks
    if isinstance(content, str) and content.strip():
        return "user", content
    return None


def _normalize_antigravity_entry(entry: dict) -> CanonicalMessage | None:
    source = _clean_type(entry.get("source"))
    entry_type = _clean_type(entry.get("type"))
    if not source or not entry_type:
        return None

    if source == "user_explicit" and entry_type == "user_input":
        content = _extract_user_request(entry.get("content")) or entry.get("content", "")
        return _normalize_role_content("user", content)

    if source == "model" and entry_type == "planner_response":
        blocks = []
        thinking = _first_text(entry, "thinking")
        if thinking:
            blocks.append({"type": "thinking", "thinking": thinking})
        content = _first_text(entry, "content")
        if content:
            blocks.append({"type": "text", "text": content})
        tool_calls = entry.get("tool_calls")
        if isinstance(tool_calls, list):
            for call in tool_calls:
                if isinstance(call, dict):
                    blocks.append(_tool_call_to_tool_use(call))
        return ("assistant", blocks) if blocks else None

    if source == "model" and entry_type in {
        "view_file",
        "list_directory",
        "list_dir",
        "grep_search",
        "run_command",
        "code_action",
        "edit_file",
        "write_to_file",
        "replace_file_content",
    }:
        return "tool_result", [_tool_output_to_tool_result({
            "id": entry.get("tool_call_id") or entry.get("step_index"),
            "status": entry.get("status"),
            "content": entry.get("content") or entry.get("error") or "",
        })]

    if source == "system" and entry_type == "error_message":
        return "tool_result", [_tool_output_to_tool_result({
            "status": "error",
            "content": entry.get("error") or entry.get("content") or "",
        })]

    return None


def _task_notification_from_entry(entry: dict) -> list[dict] | None:
    entry_type = _clean_type(entry.get("type") or entry.get("event") or entry.get("kind") or entry.get("name"))
    role = _clean_type(entry.get("role"))
    allow_prose_task = entry_type in (
        "text",
        "tool_result",
        "toolresult",
        "function_response",
        "functionresponse",
    ) or role in ("assistant", "tool", "tool_result", "toolresult")

    for key in ("content", "prompt", "text", "message"):
        value = entry.get(key)
        parsed = _task_notification_from_text(value, allow_prose=allow_prose_task)
        if parsed:
            return parsed

    attachment = entry.get("attachment") if isinstance(entry.get("attachment"), dict) else None
    if attachment:
        parsed = _task_notification_from_text(attachment.get("prompt"), allow_prose=False)
        if parsed:
            return parsed

    status = _TASK_EVENT_STATUS.get(entry_type)
    if entry_type == "task_notification" or status:
        block = _task_block_from_mapping(entry, status=status)
        return [block] if block else None

    if any(key in entry for key in ("backgroundTaskId", "background_task_id", "taskId", "task_id")):
        block = _task_block_from_mapping(entry)
        return [block] if block else None

    return None


def _task_notification_from_text(value: object, allow_prose: bool = True) -> list[dict] | None:
    if not isinstance(value, str) or not value.strip():
        return None

    if "<task-notification" in value:
        match = _TASK_NOTIFICATION_RE.search(value)
        if match:
            body = match.group("body")
            block = {
                "type": "task_notification",
                "task_id": _xml_field(body, "task-id"),
                "tool_use_id": _xml_field(body, "tool-use-id"),
                "output_file": _xml_field(body, "output-file"),
                "status": _normalize_task_status(_xml_field(body, "status")),
                "summary": _xml_field(body, "summary"),
                "result": _xml_field(body, "result"),
            }
            block = _compact(block)
            return [block] if len(block) > 1 else None

    if not allow_prose:
        return None

    start = _BACKGROUND_START_RE.search(value)
    if start:
        return [{
            "type": "task_notification",
            "task_id": start.group("id"),
            "status": "running",
            "summary": "Background command started",
            "output_file": start.group("output_file"),
        }]

    running = _BACKGROUND_RUNNING_RE.search(value)
    if running:
        return [{
            "type": "task_notification",
            "task_id": running.group("id"),
            "status": "running",
            "summary": "Background command started",
        }]

    done = _BACKGROUND_DONE_RE.search(value)
    if done:
        return [{
            "type": "task_notification",
            "task_id": done.group("id"),
            "status": "completed",
            "summary": "Background command completed",
            "output_text": _strip_single_fence(done.group("output")),
        }]

    return None


def _task_block_from_mapping(entry: dict, status: str | None = None) -> dict | None:
    task_id = _first_text(entry, "task_id", "taskId", "backgroundTaskId", "background_task_id", "id")
    if not task_id:
        return None

    raw_output = entry.get("output_text")
    if raw_output is None:
        raw_output = entry.get("output") or entry.get("stdout")
    if isinstance(raw_output, dict):
        raw_output = _raw_output_to_text(raw_output)

    block = {
        "type": "task_notification",
        "task_id": task_id,
        "tool_use_id": _first_text(entry, "tool_use_id", "toolUseId", "toolCallId", "call_id"),
        "status": _normalize_task_status(status or entry.get("status") or entry.get("state")),
        "summary": _first_text(entry, "summary", "message", "title", "description"),
        "result": _first_text(entry, "result"),
        "output_text": _strip_single_fence(raw_output) if isinstance(raw_output, str) else "",
        "output_file": _first_text(entry, "output_file", "outputFile", "path", "file"),
    }
    return _compact(block)


def _tool_call_to_tool_use(call: dict | None) -> dict:
    call = call if isinstance(call, dict) else {}
    function = call.get("function") if isinstance(call.get("function"), dict) else {}
    name = call.get("name") or call.get("title") or call.get("kind") or call.get("tool_name") or function.get("name")
    raw_input = call.get("input")
    if raw_input is None:
        raw_input = call.get("rawInput")
    if raw_input is None:
        raw_input = call.get("arguments")
    if raw_input is None and isinstance(call.get("function"), dict):
        raw_input = call["function"].get("arguments")

    return _compact({
        "type": "tool_use",
        "id": _first_text(call, "id", "tool_use_id", "toolUseId", "toolCallId", "call_id", "callId"),
        "name": str(name or "tool"),
        "input": _coerce_json(raw_input),
        "status": _first_text(call, "status"),
    })


def _function_call_to_tool_use(call: object) -> dict:
    call = call if isinstance(call, dict) else {}
    return _tool_call_to_tool_use({
        "id": call.get("id") or call.get("call_id"),
        "name": call.get("name"),
        "arguments": call.get("args") or call.get("arguments"),
    })


def _function_response_to_tool_result(response: object) -> dict:
    response = response if isinstance(response, dict) else {"content": response}
    return _tool_output_to_tool_result({
        "tool_use_id": response.get("id") or response.get("name"),
        "content": response.get("response") or response.get("content") or response,
    })


def _tool_output_to_tool_result(output: dict | None) -> dict:
    output = output if isinstance(output, dict) else {}
    raw = output.get("content")
    if raw is None:
        raw = output.get("output")
    if raw is None:
        raw = output.get("rawOutput")
    if raw is None:
        raw = output.get("result")
    if raw is None:
        raw = output.get("text")

    status = _clean_type(output.get("status"))
    return _compact({
        "type": "tool_result",
        "tool_use_id": _first_text(output, "tool_use_id", "toolUseId", "toolCallId", "call_id", "callId", "id"),
        "content": _raw_output_to_text(raw),
        "is_error": bool(output.get("is_error") or output.get("error") or status in ("failed", "error", "cancelled")),
        "status": status,
    })


def _raw_output_to_text(raw: object) -> str:
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    if isinstance(raw, list):
        return "\n".join(_text_value(item) for item in raw if _text_value(item))
    if isinstance(raw, dict):
        parts = []
        for key in ("stdout", "stderr", "content", "output", "message", "text"):
            value = raw.get(key)
            if value not in (None, ""):
                parts.append(str(value))
        if parts:
            return "\n".join(parts)
        return json.dumps(raw, sort_keys=True)
    return str(raw)


def _format_plan_update(update: dict) -> str:
    entries = update.get("entries") or update.get("plan") or update.get("tasks") or []
    if not isinstance(entries, list):
        return str(entries) if entries else ""
    lines = []
    for item in entries:
        if not isinstance(item, dict):
            lines.append(f"- {item}")
            continue
        title = _first_text(item, "title", "content", "description", "task") or "Task"
        status = _first_text(item, "status") or "pending"
        lines.append(f"- [{status}] {title}")
    return "\n".join(lines)


def _reasoning_text(item: dict) -> str:
    text = _first_text(item, "thinking", "text", "content")
    if text:
        return text
    summary = item.get("summary")
    if isinstance(summary, list):
        return "\n".join(_text_value(part) for part in summary if _text_value(part))
    return _raw_output_to_text(summary)


def _content_blocks(content: object) -> list[object] | None:
    if isinstance(content, list):
        return content
    if isinstance(content, dict):
        if isinstance(content.get("content"), list):
            return content["content"]
        if isinstance(content.get("parts"), list):
            return content["parts"]
        return [content]
    return None


def _is_tool_result_block(block: object) -> bool:
    return isinstance(block, dict) and _clean_type(block.get("type")) in (
        "tool_result",
        "toolresult",
        "function_response",
        "functionresponse",
    )


def _is_tool_use_block(block: object) -> bool:
    return isinstance(block, dict) and _clean_type(block.get("type")) in ("tool_use", "tooluse")


def _is_task_notification_block(block: object) -> bool:
    return isinstance(block, dict) and _clean_type(block.get("type")) == "task_notification"


def _normalize_role(role: object) -> str | None:
    role_name = _clean_type(role)
    if role_name in ("human",):
        return "user"
    if role_name in ("model", "agent"):
        return "assistant"
    if role_name in ("tool", "tool_result", "toolresult", "function_response", "functionresponse"):
        return "tool_result"
    if role_name in ("user", "assistant"):
        return role_name
    return None


def _normalize_task_status(status: object) -> str:
    value = _clean_type(status)
    if value in ("complete", "completed", "done", "success", "succeeded"):
        return "completed"
    if value in ("failed", "failure", "error", "errored"):
        return "failed"
    if value in ("running", "started", "progress", "pending", "in_progress"):
        return "running"
    return value or "updated"


def _xml_field(body: str, tag: str) -> str:
    match = re.search(
        rf"<{re.escape(tag)}\b[^>]*>(?P<value>.*?)</{re.escape(tag)}>",
        body,
        re.IGNORECASE | re.DOTALL,
    )
    return html.unescape(match.group("value")).strip() if match else ""


def _first_text(mapping: dict, *keys: str) -> str:
    for key in keys:
        value = mapping.get(key)
        if value not in (None, ""):
            return _text_value(value)
    return ""


def _text_value(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        if value.get("type") == "text" and value.get("text") is not None:
            return str(value["text"])
        for key in ("text", "content", "message", "summary"):
            if value.get(key) not in (None, ""):
                return _text_value(value[key])
        return json.dumps(value, sort_keys=True)
    if isinstance(value, list):
        return "\n".join(_text_value(item) for item in value if _text_value(item))
    return str(value)


def _coerce_json(value: object) -> object:
    if isinstance(value, str):
        stripped = value.strip()
        if stripped and stripped[0] in "[{":
            try:
                return json.loads(stripped)
            except json.JSONDecodeError:
                return value
    return value if value is not None else {}


def _strip_single_fence(value: object) -> str:
    text = _text_value(value).strip()
    match = re.fullmatch(r"```[A-Za-z0-9_-]*\n(?P<body>[\s\S]*?)\n?```", text)
    return match.group("body").strip() if match else text


def _extract_user_request(value: object) -> str:
    if not isinstance(value, str):
        return ""
    match = re.search(
        r"<USER_REQUEST>\s*(?P<body>[\s\S]*?)\s*</USER_REQUEST>",
        value,
        re.IGNORECASE,
    )
    return html.unescape(match.group("body")).strip() if match else ""


def _clean_type(value: object) -> str:
    return str(value or "").strip().lower().replace("-", "_")


def _compact(mapping: dict) -> dict:
    return {key: value for key, value in mapping.items() if value not in (None, "", [], {})}
