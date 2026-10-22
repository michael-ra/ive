"""Observational pending requests, independent of open browser terminals.

This module never approves a command or writes to a PTY. Hook lifecycle events
are authoritative; terminal fallback requires a currently visible dialog footer.
"""
import re
import time

_TOOL_INPUT_KEYS = 8
_TOOL_INPUT_VALUE = 240


def _trim_tool_input(tool_input):
    """A compact copy of the tool input for the question card (never the
    whole file content of a Write)."""
    if not isinstance(tool_input, dict) or not tool_input:
        return None
    out = {}
    for key in list(tool_input.keys())[:_TOOL_INPUT_KEYS]:
        value = tool_input[key]
        if isinstance(value, str):
            out[key] = value[:_TOOL_INPUT_VALUE]
        elif value is None or isinstance(value, (bool, int, float)):
            out[key] = value
        else:
            out[key] = str(value)[:_TOOL_INPUT_VALUE]
    return out

_pending: dict[str, dict] = {}
_last_screen: dict[str, str] = {}
_resolved_screen: dict[str, str] = {}


def get_attention(session_id):
    value = _pending.get(session_id)
    return dict(value) if value else None


def clear_attention(session_id):
    _pending.pop(session_id, None)
    _last_screen.pop(session_id, None)
    _resolved_screen.pop(session_id, None)


def details(data, source="hook"):
    context = str(data.get("context") or "")[-6000:]
    tool_input = data.get("tool_input") or {}
    operation = str(tool_input.get("command") or tool_input.get("cmd") or tool_input.get("file_path") or tool_input.get("path") or "")[:240] if isinstance(tool_input, dict) else ""
    message = str(data.get("reason") or data.get("message") or data.get("question") or operation)[:1200]
    compact = re.sub(r"\s+", "", message + context).lower()
    configuration = "safetygate" in compact and bool(re.search(r"missingapi_?key|notconfigured|classifierunavailable", compact))
    permission = configuration or data.get("tool_name") or re.search(r"permission|confirmation|proceed|approve", message, re.I)
    options = data.get("options")
    actions = data.get("actions")
    asked_at = data.get("asked_at")
    return {
        "kind": "configuration" if configuration else "permission" if permission else "question",
        "title": "Safety check needs setup" if configuration else "Permission needed" if permission else "Your answer is needed",
        "message": "The extra safety check is unavailable. Open Safety settings to fix its provider." if configuration else message or (f"Review the {data['tool_name']} request." if data.get("tool_name") else "The agent is waiting for your input."),
        "tool_name": data.get("tool_name") or "", "context": context, "source": source,
        # The question as data (backend.md 5.h.3): choices and keys from the
        # CLI notification, the trimmed tool input and when it was asked.
        "options": list(options) if isinstance(options, list) else [],
        "actions": list(actions) if isinstance(actions, list) else [],
        "notification_type": str(data.get("notification_type") or ""),
        "tool_input": _trim_tool_input(tool_input),
        "asked_at": float(asked_at) if isinstance(asked_at, (int, float)) else time.time(),
    }


def observe_event(event):
    sid = event.get("session_id")
    if not sid:
        return
    kind, state = event.get("type"), event.get("state")
    if ((kind == "session_state" and state == "prompting")
            or kind == "permission_question"
            or (kind == "permission_event" and event.get("phase") == "request")):
        _pending[sid] = details(event)
    elif ((kind == "session_state" and state in {"working", "idle"})
          or (kind == "permission_event" and event.get("phase") == "denied")):
        _pending.pop(sid, None)
        if sid in _last_screen:
            _resolved_screen[sid] = _last_screen[sid]


def detect_terminal_attention(text):
    tail = str(text or "")[-8000:]
    compact = re.sub(r"\s+", "", tail).lower()
    footer = compact.rfind("esctocancel")
    after = compact[footer:]
    if (footer < 0 or compact.rfind("esctointerrupt") > footer or len(after) > 260
            or re.search(r"interrupted|automodeon|bypasspermissions|shift\+tab|cogitated|workedfor", after)):
        return None
    before = compact[:footer]
    if not re.search(r"doyouwanttoproceed|wouldyouliketorun|readytocode|requiresconfirmation|allowthis|approve", before[-2500:]):
        return None
    if not re.search(r"[12][.)]", before[-1500:]):
        return None
    return details({"message": "Review the request in the terminal.", "tool_name": "command", "context": tail[-5000:]}, "terminal")


def observe_terminal(session_id, text):
    before = get_attention(session_id)
    _last_screen[session_id] = text
    if _resolved_screen.get(session_id) == text:
        return False
    _resolved_screen.pop(session_id, None)
    found = detect_terminal_attention(text)
    if found:
        # Prefer structured context, except when the terminal explains a
        # configuration failure that the CLI's hook didn't include.
        if not before or before.get("source") == "terminal" or found["kind"] == "configuration":
            _pending[session_id] = found
    elif before and before.get("source") == "terminal":
        clear_attention(session_id)
    return before != get_attention(session_id)
