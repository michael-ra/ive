"""Typed contract registry for every cross-component backend event.

The registry is deliberately small: it owns event declarations and registration
metadata, while :mod:`event_bus` keeps transport concerns (audit rows, websocket
fan-out, and webhooks).  Both Commander events and the normalized CLI hook stream
live here so there is one mechanically checked catalog.
"""
from __future__ import annotations

import asyncio
import dataclasses
import inspect
import logging
import types
from collections import defaultdict
from dataclasses import dataclass
from enum import Enum
from types import MappingProxyType
from typing import (
    Any,
    Mapping,
    NotRequired,
    Required,
    TypedDict,
    get_args,
    get_origin,
    get_type_hints,
)

from cli_features import HookEvent, NormalizedEvent
from commander_events import (
    COMMANDER_EVENT_CATEGORIES,
    COMMANDER_EVENT_LABELS,
    CommanderEvent,
    CORE_EVENT_OVERRIDES,
    EVENT_CATEGORY_PAYLOADS,
    EVENT_DEFINITIONS,
)

logger = logging.getLogger(__name__)


class DispatchMode(str, Enum):
    """How registered in-process consumers are invoked."""

    SYNC = "sync"                  # registration order, completed before return
    ASYNC = "async"                # concurrent, completed before return
    FIRE_AND_FORGET = "fire_and_forget"  # scheduled; producer does not wait


class Durability(str, Enum):
    """What a restart preserves for an event contract."""

    DURABLE = "survives_restart"
    AUDIT_ONLY = "audit_only"
    IN_PROCESS_ONLY = "in_process_only"


class GenericEventPayload(TypedDict, total=False):
    workspace_id: str
    session_id: str
    task_id: str
    actor: str
    status: str
    reason: str
    error: Any


class TaskEventPayload(TypedDict, total=False):
    task_id: str
    workspace_id: str
    session_id: str
    title: str
    old_status: str
    new_status: str
    status: str
    reason: str
    iteration: int
    error: Any


class SessionEventPayload(TypedDict, total=False):
    session_id: str
    workspace_id: str
    cli_type: str
    old_status: str
    new_status: str
    status: str
    reason: str
    error: Any


class WorkspaceEventPayload(TypedDict, total=False):
    workspace_id: str
    name: str
    path: str
    status: str
    error: Any


class PluginEventPayload(TypedDict, total=False):
    plugin_id: str
    component_id: str
    registry_id: str
    workspace_id: str
    status: str
    error: Any


class ResearchEventPayload(TypedDict, total=False):
    entry_id: str
    workspace_id: str
    task_id: str
    topic: str
    status: str
    error: Any


class ResearchCompletedPayload(TypedDict, total=False):
    entry_id: Required[str]
    status: Required[str]
    workspace_id: str | None
    error: Any


class PipelineEventPayload(TypedDict, total=False):
    run_id: str
    pipeline_id: str
    workspace_id: str
    task_id: str
    status: str
    iterations: int
    error: Any


class CommunicationEventPayload(TypedDict, total=False):
    workspace_id: str
    session_id: str
    peer_id: str
    message_id: str
    status: str


class SafetyEventPayload(TypedDict, total=False):
    workspace_id: str
    session_id: str
    rule_id: str
    decision: str
    action: str
    reason: str
    command: str
    error: Any
    precedent_decision_ids: list[int]
    precedent_reason: str
    precedent_class: str


class SafetyRuleProposedPayload(TypedDict, total=False):
    suggestion_id: Required[str]
    suggestion: Required[dict[str, Any]]
    workspace_id: str | None


@dataclass(frozen=True)
class EventSpec:
    name: str
    payload_type: type
    dispatch_mode: DispatchMode
    durability: Durability
    durability_note: str
    namespace: str
    label: str
    category: str


class EventContractError(RuntimeError):
    """Base error for declaration/registration/emit contract violations."""


class UndeclaredEventError(EventContractError):
    pass


class DuplicateEventError(EventContractError):

    pass


class EventPayloadError(EventContractError):
    pass


_events: dict[str, EventSpec] = {}
_producers: dict[str, set[str]] = defaultdict(set)
_consumers: dict[str, set[str]] = defaultdict(set)


def hook_event_name(event: HookEvent | str) -> str:
    value = event.value if isinstance(event, HookEvent) else str(event)
    return f"hook.{value}"


def event_name(event: str | CommanderEvent | HookEvent) -> str:
    if isinstance(event, HookEvent):
        return hook_event_name(event)
    return event.value if isinstance(event, CommanderEvent) else str(event)


def declare_event(spec: EventSpec) -> EventSpec:
    """Declare one event; duplicate names are always a startup error."""
    if spec.name in _events:
        raise DuplicateEventError(f"event already declared: {spec.name}")
    if not (dataclasses.is_dataclass(spec.payload_type)
            or hasattr(spec.payload_type, "__required_keys__")):
        raise EventContractError(
            f"{spec.name}: payload_type must be a dataclass or TypedDict"
        )
    _events[spec.name] = spec
    return spec


def require_event(event: str | CommanderEvent | HookEvent) -> EventSpec:
    name = event_name(event)
    try:
        return _events[name]
    except KeyError as exc:
        raise UndeclaredEventError(f"undeclared event: {name}") from exc


def register_producer(
    event: str | CommanderEvent | HookEvent, site: str
) -> EventSpec:
    spec = require_event(event)
    _producers[spec.name].add(str(site))
    return spec


def register_consumer(
    event: str | CommanderEvent | HookEvent, site: str
) -> EventSpec:
    spec = require_event(event)
    _consumers[spec.name].add(str(site))
    return spec


def registration_site(*, stacklevel: int = 1) -> str:
    """Return a stable ``module.qualname`` for runtime registrations."""
    frame = inspect.currentframe()
    try:
        for _ in range(stacklevel):
            if frame is None:
                return "unknown"
            frame = frame.f_back
        if frame is None:
            return "unknown"
        module = frame.f_globals.get("__name__", "unknown")
        qualname = frame.f_code.co_qualname
        return f"{module}.{qualname}"
    finally:
        del frame


def validate_payload(event: str | CommanderEvent | HookEvent, payload: Any) -> None:
    """Enforce the declared payload container and required TypedDict keys.

    Python does not retain enough runtime information for exhaustive structural
    validation without a dependency.  The registry nevertheless rejects the two
    dangerous contract failures: the wrong payload container and missing fields
    explicitly marked required by a TypedDict.
    """
    spec = require_event(event)
    payload_type = spec.payload_type
    if dataclasses.is_dataclass(payload_type):
        if not isinstance(payload, payload_type):
            raise EventPayloadError(
                f"{spec.name}: expected {payload_type.__name__}, "
                f"got {type(payload).__name__}"
            )
        return
    if not isinstance(payload, Mapping):
        raise EventPayloadError(f"{spec.name}: TypedDict payload must be a mapping")
    missing = _required_keys(payload_type) - set(payload)
    if missing:
        raise EventPayloadError(
            f"{spec.name}: missing required payload keys: {sorted(missing)}"
        )


def all_events() -> tuple[EventSpec, ...]:
    return tuple(_events[name] for name in sorted(_events))


def producers_for(event: str | CommanderEvent | HookEvent) -> tuple[str, ...]:
    return tuple(sorted(_producers.get(require_event(event).name, ())))


def consumers_for(event: str | CommanderEvent | HookEvent) -> tuple[str, ...]:
    return tuple(sorted(_consumers.get(require_event(event).name, ())))


def registry_view() -> Mapping[str, EventSpec]:
    return MappingProxyType(_events)


class TypedEventDispatcher:
    """Small typed in-process dispatcher for streams without bus persistence."""

    def __init__(self) -> None:
        self._subscribers: dict[str, list[Any]] = defaultdict(list)

    def subscribe(self, event: str | CommanderEvent | HookEvent, handler: Any,
                  *, site: str) -> None:
        name = event_name(event)
        register_consumer(name, site)
        if handler not in self._subscribers[name]:
            self._subscribers[name].append(handler)

    def unsubscribe(self, event: str | CommanderEvent | HookEvent, handler: Any) -> None:
        name = event_name(event)
        try:
            self._subscribers.get(name, []).remove(handler)
        except ValueError:
            pass

    async def emit(self, event: str | CommanderEvent | HookEvent, payload: Any,
                   *, site: str) -> None:
        name = event_name(event)
        spec = register_producer(name, site)
        validate_payload(name, payload)
        handlers = list(self._subscribers.get(name, ()))
        if not handlers:
            return
        if spec.dispatch_mode is DispatchMode.SYNC:
            for handler in handlers:
                await self._invoke(handler, payload)
        elif spec.dispatch_mode is DispatchMode.ASYNC:
            await asyncio.gather(
                *(self._invoke(handler, payload) for handler in handlers),
                return_exceptions=True,
            )
        else:
            for handler in handlers:
                asyncio.create_task(self._invoke(handler, payload))

    @staticmethod
    async def _invoke(handler: Any, payload: Any) -> None:
        try:
            result = handler(payload)
            if inspect.isawaitable(result):
                await result
        except Exception:
            logger.exception("typed event subscriber failed")


def _type_name(annotation: Any) -> str:
    if annotation is type(None):
        return "None"
    origin = get_origin(annotation)
    if origin is not None:
        args = get_args(annotation)
        if origin is types.UnionType:
            return " | ".join(_type_name(arg) for arg in args)
        base = getattr(origin, "__name__", str(origin).replace("typing.", ""))
        if args:
            return f"{base}[{', '.join(_type_name(arg) for arg in args)}]"
        return base
    return getattr(annotation, "__name__", str(annotation).replace("typing.", ""))


def _required_keys(payload_type: type) -> set[str]:
    """TypedDict required keys, including postponed ``Required[T]`` hints."""
    required = set(getattr(payload_type, "__required_keys__", ()))
    for name, annotation in get_type_hints(payload_type, include_extras=True).items():
        if get_origin(annotation) is Required:
            required.add(name)
    return required


def payload_shape(payload_type: type) -> tuple[tuple[str, str, bool], ...]:
    """Return ``(field, type, required)`` rows for catalog generation."""
    hints = get_type_hints(payload_type, include_extras=True)
    if dataclasses.is_dataclass(payload_type):
        required = {
            field.name
            for field in dataclasses.fields(payload_type)
            if field.default is dataclasses.MISSING
            and field.default_factory is dataclasses.MISSING
        }
    else:
        required = _required_keys(payload_type)
    rows = []
    for name, annotation in hints.items():
        origin = get_origin(annotation)
        if origin in (NotRequired, Required):
            annotation = get_args(annotation)[0]
        rows.append((name, _type_name(annotation), name in required))
    return tuple(rows)


_CATEGORY_PAYLOADS: dict[str, type] = {
    "task_board": TaskEventPayload,
    "session": SessionEventPayload,
    "workspace": WorkspaceEventPayload,
    "plugins": PluginEventPayload,
    "research": ResearchEventPayload,
    "pipeline": PipelineEventPayload,
    "commander": GenericEventPayload,
    "w2w": CommunicationEventPayload,
    "safety": SafetyEventPayload,
    "access": SafetyEventPayload,
}

_PAYLOAD_OVERRIDES: dict[CommanderEvent, type] = {
    CommanderEvent.PIPELINE_COMPLETED: PipelineEventPayload,
    CommanderEvent.RESEARCH_COMPLETED: ResearchCompletedPayload,
    CommanderEvent.SAFETY_RULE_PROPOSED: SafetyRuleProposedPayload,
}

_SYNC_COMMANDER_EVENTS = {
    CommanderEvent.TASK_STATUS_CHANGED,
    CommanderEvent.TASK_COMPLETED,
    CommanderEvent.PIPELINE_COMPLETED,
    CommanderEvent.RESEARCH_COMPLETED,
    CommanderEvent.SESSION_FAILED_TO_START,
    CommanderEvent.SESSION_CRASHED,
}

_FIRE_AND_FORGET_EVENTS = {
    CommanderEvent.OBSERVATORY_SCAN_PROGRESS,
    CommanderEvent.IDLE_REFLECTION_FIRED,
}

_DURABLE_EVENTS: dict[CommanderEvent, str] = {
    CommanderEvent.TASK_STATUS_CHANGED: "Task state is stored in tasks; in-process completion delivery is not replayed by the workbench.",
    CommanderEvent.TASK_COMPLETED: "Task state is stored in tasks; in-process completion delivery is not replayed by the workbench.",
    CommanderEvent.PIPELINE_COMPLETED: "Run state is stored in pipeline_runs; in-process completion delivery is not replayed by the workbench.",
    CommanderEvent.RESEARCH_COMPLETED: "Research state is stored in research_entries; in-process completion delivery is not replayed by the workbench.",
}


_CATEGORY_PAYLOADS.update(EVENT_CATEGORY_PAYLOADS)

for _event in CommanderEvent:
    _definition = EVENT_DEFINITIONS.get(_event.value, {})
    _category = COMMANDER_EVENT_CATEGORIES[_event]
    if "dispatch_mode" in _definition:
        _mode = DispatchMode(_definition["dispatch_mode"])
    elif _event in _SYNC_COMMANDER_EVENTS:
        _mode = DispatchMode.SYNC
    elif _event in _FIRE_AND_FORGET_EVENTS:
        _mode = DispatchMode.FIRE_AND_FORGET
    else:
        _mode = DispatchMode.ASYNC
    _durability_note = _definition.get(
        "durability_note",
        CORE_EVENT_OVERRIDES.get(_event.value, {}).get("durability_note", _DURABLE_EVENTS.get(_event)),
    )
    declare_event(EventSpec(
        name=_event.value,
        payload_type=_definition.get("payload_type", _PAYLOAD_OVERRIDES.get(
            _event, _CATEGORY_PAYLOADS.get(_category, GenericEventPayload)
        )),
        dispatch_mode=_mode,
        durability=(Durability(_definition["durability"]) if "durability" in _definition
                    else Durability.DURABLE if _durability_note else Durability.AUDIT_ONLY),
        durability_note=(_durability_note or
                         "Audit row survives restart; in-process consumer delivery "
                         "is not replayed."),
        namespace="commander",
        label=COMMANDER_EVENT_LABELS[_event],
        category=_category,
    ))

for _hook_event in HookEvent:
    declare_event(EventSpec(
        name=hook_event_name(_hook_event),
        payload_type=NormalizedEvent,
        dispatch_mode=DispatchMode.SYNC,
        durability=Durability.IN_PROCESS_ONLY,
        durability_note="Typed CLI hook delivery is in-process only and is not replayed.",
        namespace="cli_hook",
        label=_hook_event.value.replace("_", " ").title(),
        category="cli_hook",
    ))
    register_producer(hook_event_name(_hook_event), "backend/hooks.py:_emit_normalized")
    register_consumer(hook_event_name(_hook_event), "backend/hooks.py:subscribe_normalized")


def validate_registry() -> None:
    """Startup assertion: enums, declarations, modes, and payload types agree."""
    expected = {event.value for event in CommanderEvent}
    expected.update(hook_event_name(event) for event in HookEvent)
    actual = set(_events)
    if actual != expected:
        raise EventContractError(
            f"event registry mismatch; missing={sorted(expected - actual)}, "
            f"extra={sorted(actual - expected)}"
        )
    for spec in _events.values():
        if not isinstance(spec.dispatch_mode, DispatchMode):
            raise EventContractError(f"{spec.name}: invalid dispatch mode")
        if not spec.durability_note.strip():
            raise EventContractError(f"{spec.name}: durability note is required")


validate_registry()
