"""Apply a launch-setting change (permission mode, model, effort) to the CLI
that is already running.

The Perms menu, the model picker and the effort picker write the session row
(``permission_mode`` / ``model`` / ``effort``). The running Claude Code /
Codex process was started with the old flags and never hears about it. No CLI
we drive can switch these in-process without side effects (a Claude started
without bypass can never switch into it; Claude's ``/model`` and ``/effort``
also write the user's settings files), so the change is applied the same way
an account switch is: stop the PTY and start it again through the full spawn
path, which resumes the same native conversation (``--resume <id>`` /
``codex resume <id>`` / ...) and now passes the new flags. The conversation
and its context continue.

Rules (per session, all fields share one restart):

* A busy session (agent working, or waiting on an approval) is never cut
  off mid-answer. The change waits until the session is idle. ``apply_now``
  is the explicit "interrupt and apply" escape hatch.
* Rapid changes (Shift+Tab cycling, clicking through models) are debounced
  and coalesced: only the last chosen value per field is applied, and all
  pending fields go into one restart.
* Switching a field back to the value the process already runs with cancels
  that field; when no field is left, the pending restart is cancelled.
* A change that lands while a restart is in flight is applied afterwards.
* Every state change is broadcast per field so the UI can show
  "Switching to …", "Applies after the current answer", the new value, or an
  error. ``permission_mode`` keeps its original ``permission_mode_apply``
  event (``mode``/``from``); the other fields use ``launch_apply``
  (``field``/``value``/``from``).

The DB value changes immediately in ``update_session``; this module only
brings the process in line with it.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

BUSY_STATES = frozenset({"running", "waiting"})

# Fields a running session can take live, with the value that means "unset".
LAUNCH_FIELDS: dict[str, str] = {
    "permission_mode": "default",
    "model": "",
    "effort": "",
}

RestartFn = Callable[[str, dict], Awaitable[dict]]
IsAliveFn = Callable[[str], bool]
StatusFn = Callable[[str], str]
BroadcastFn = Callable[[dict], Awaitable[Any]]


# The server registers its one applier. Hooks use the mode of the running
# process while a replacement is pending, rather than the future DB setting.
_mode_snapshot = lambda session_id: None


def set_permission_mode_resolver(resolver):
    global _mode_snapshot
    _mode_snapshot = resolver


def effective_permission_mode(session_id: str, configured: str | None) -> str:
    # A newly requested read-only ceiling must never be deferred. This also
    # preserves immediate agent-origin narrowing while a user switch waits.
    if (configured or "").lower() == "plan":
        return "plan"
    snapshot = _mode_snapshot(session_id)
    return (snapshot.get("from") if snapshot else None) or configured or "default"


def _norm(field_name: str, value: Any) -> str:
    if value is None or value == "":
        return LAUNCH_FIELDS.get(field_name, "")
    return str(value)


@dataclass
class _Pending:
    session_id: str
    running: dict = field(default_factory=dict)   # field -> value the live process runs with
    target: dict = field(default_factory=dict)    # field -> value to apply (only changed fields)
    since: float = field(default_factory=time.time)
    applying_values: dict = field(default_factory=dict)  # restart in flight: field -> value
    waiting_announced: bool = False
    task: Optional[asyncio.Task] = None

    @property
    def applying(self) -> frozenset:
        return frozenset(self.applying_values)

    def field_snapshot(self, name: str, busy: bool | None = None) -> dict:
        value = self.target.get(name, self.applying_values.get(name))
        if name in self.applying_values and value == self.applying_values[name]:
            state = "applying"
        elif self.applying_values:
            state = "pending"          # waits for the restart in flight
        else:
            state = "pending" if busy else "scheduled"
        return _event_fields(self.session_id, name, state, value, self.running.get(name), since=self.since)


def _event_fields(session_id: str, name: str, state: str, value: Any, from_value: Any = None, **extra) -> dict:
    payload = {"session_id": session_id, "field": name, "state": state, "value": value}
    if from_value is not None:
        payload["from"] = from_value
    if name == "permission_mode":
        payload["mode"] = value
    payload.update({k: v for k, v in extra.items() if v is not None})
    return payload


class LiveLaunchApplier:
    def __init__(
        self,
        *,
        restart: RestartFn,
        is_alive: IsAliveFn,
        status: StatusFn,
        broadcast: BroadcastFn,
        debounce: float = 0.6,
        poll_interval: float = 0.5,
    ) -> None:
        self._restart = restart
        self._is_alive = is_alive
        self._status = status
        self._broadcast = broadcast
        self.debounce = debounce
        self.poll_interval = poll_interval
        self._pending: dict[str, _Pending] = {}
        self._failures: dict[str, dict] = {}

    # ── queries ──────────────────────────────────────────────────────────

    def _busy(self, session_id: str) -> bool:
        try:
            return (self._status(session_id) or "idle") in BUSY_STATES
        except Exception:
            return False

    def pending(self, session_id: str, field_name: str | None = None) -> dict | None:
        """Snapshot of one field's pending apply, or ``{field: snapshot}``."""
        p = self._pending.get(session_id)
        if p is None:
            return None
        busy = self._busy(session_id)
        names = [n for n in LAUNCH_FIELDS if n in p.target or n in p.applying]
        if field_name is not None:
            return p.field_snapshot(field_name, busy=busy) if field_name in names else None
        return {n: p.field_snapshot(n, busy=busy) for n in names} or None

    def snapshot(self, session_id: str, field_name: str) -> dict | None:
        """Keep failed changes visible across view switches and reconnects."""
        return self.pending(session_id, field_name) or self._failures.get(session_id, {}).get(field_name)

    # ── public API ───────────────────────────────────────────────────────

    async def request_field(self, session_id: str, field_name: str, running: Any, target: Any) -> dict:
        return (await self.request_fields(session_id, {field_name: (running, target)}))[field_name]

    async def request_fields(self, session_id: str, changes: dict) -> dict:
        """Schedule bringing the live process to the new values.

        ``changes`` maps field -> ``(running_value, target_value)`` where
        ``running_value`` is the DB value before this change. When a change
        is already pending, the process still runs with the pending entry's
        running value, so that one wins. Returns ``{field: snapshot}``.
        """
        for name in changes:
            if name not in LAUNCH_FIELDS:
                raise ValueError(f"not a live launch field: {name}")
        existing = self._pending.get(session_id)
        failures = self._failures.get(session_id, {})
        # A retry must compare against the last known running value, not the
        # already-saved target. Otherwise retrying the same choice is a no-op.
        changes = {n: (failures[n].get("from", r) if n in failures else r, t)
                   for n, (r, t) in changes.items()}
        for name in changes:
            failures.pop(name, None)

        restarting = existing is not None and bool(existing.applying)
        if not self._is_alive(session_id) and not restarting:
            # Nothing running: the next start reads the DB value anyway.
            if existing:
                self._drop(session_id)
            return {n: _event_fields(session_id, n, "saved", t) for n, (_r, t) in changes.items()}
        # While a restart is in flight the PTY is briefly dead. The change must
        # still be recorded so the run loop applies it once the restart ends;
        # otherwise the process stays on the intermediate value.

        p = existing
        if p is None:
            p = _Pending(session_id=session_id)
        result: dict[str, dict] = {}
        moved = False
        for name, (running, target) in changes.items():
            if name not in p.running:
                p.running[name] = running
            if name in p.applying:
                # A restart is in flight; never cancel it half way. The run
                # loop re-checks the target after the restart.
                p.target[name] = target
                result[name] = None  # filled below
                moved = True
                continue
            if _norm(name, target) == _norm(name, p.running[name]):
                had = name in p.target
                p.target.pop(name, None)
                result[name] = _event_fields(session_id, name, "unchanged", target)
                if had:
                    await self._emit(_event_fields(
                        session_id, name, "cancelled", target,
                        reason="process already runs with this value",
                    ))
                continue
            p.target[name] = target
            result[name] = None
            moved = True

        if not p.target and not p.applying:
            if existing is not None:
                self._drop(session_id)
            return result

        if existing is None:
            self._pending[session_id] = p
        busy = self._busy(session_id)
        if moved and not p.applying:
            p.since = time.time()
            p.waiting_announced = busy
            if p.task is not None:
                p.task.cancel()
            p.task = asyncio.create_task(self._run(session_id, immediate=False))
        for name, snap in list(result.items()):
            if snap is None:
                snap = p.field_snapshot(name, busy=busy)
                if name in p.applying:
                    snap["state"] = "pending"
                result[name] = snap
                await self._emit(snap)
        return result

    async def apply_now(self, session_id: str) -> dict:
        """Apply the pending change immediately, interrupting a running turn."""
        p = self._pending.get(session_id)
        if p is None:
            return {"session_id": session_id, "state": "none"}
        if p.applying:
            return {"session_id": session_id, "state": "applying", "fields": self.pending(session_id) or {}}
        if p.task is not None:
            p.task.cancel()
        p.task = None
        return await self._run(session_id, immediate=True)

    def cancel(self, session_id: str) -> None:
        p = self._pending.get(session_id)
        if p is not None and not p.applying:
            self._drop(session_id)

    # ── internals ────────────────────────────────────────────────────────

    def _drop(self, session_id: str) -> None:
        p = self._pending.pop(session_id, None)
        if p is not None and p.task is not None and p.task is not asyncio.current_task():
            p.task.cancel()

    async def _emit(self, payload: dict) -> None:
        kind = "permission_mode_apply" if payload.get("field") == "permission_mode" else "launch_apply"
        try:
            await self._broadcast({"type": kind, **payload})
        except Exception:
            logger.debug("%s broadcast failed", kind, exc_info=True)

    async def _emit_all(self, session_id: str, names, state: str, values: dict, **extra) -> None:
        for name in LAUNCH_FIELDS:
            if name in names:
                await self._emit(_event_fields(session_id, name, state, values.get(name), **extra))

    @staticmethod
    def _summary(session_id: str, state: str, values: dict, **extra) -> dict:
        out = {"session_id": session_id, "state": state, "fields": dict(values), **extra}
        if "permission_mode" in values:
            out["mode"] = values["permission_mode"]
        return out

    async def _run(self, session_id: str, *, immediate: bool) -> dict:
        while True:
            p = self._pending.get(session_id)
            if p is None:
                return {"session_id": session_id, "state": "none"}
            if not immediate:
                await asyncio.sleep(self.debounce)
                while True:
                    if not self._is_alive(session_id):
                        self._drop(session_id)
                        await self._emit_all(
                            session_id, p.target, "saved", p.target,
                            reason="session stopped; the next start uses this value",
                        )
                        return self._summary(session_id, "saved", p.target)
                    if not self._busy(session_id):
                        break
                    if not p.waiting_announced:
                        p.waiting_announced = True
                        for name in list(p.target):
                            await self._emit(p.field_snapshot(name, busy=True))
                    await asyncio.sleep(self.poll_interval)

            targets = dict(p.target)
            if not targets:
                self._pending.pop(session_id, None)
                return {"session_id": session_id, "state": "none"}
            p.applying_values = dict(targets)
            for name in list(targets):
                await self._emit(p.field_snapshot(name))
            try:
                result = await self._restart(session_id, targets) or {}
            except Exception as exc:  # restart must never kill the loop silently
                logger.exception("live launch apply failed for %s", session_id)
                result = {"ok": False, "error": str(exc)}
            p.applying_values = {}

            if not result.get("ok"):
                changed = result.get("changed") or {}
                if (
                    any(n in changed for n in targets)
                    and self._pending.get(session_id) is p
                    and any(p.target.get(n) != v for n, v in targets.items())
                ):
                    # A newer choice landed between scheduling and the
                    # restart; apply that one instead.
                    immediate = False
                    continue
                self._pending.pop(session_id, None)
                error = result.get("error") or "restart failed"
                for name in LAUNCH_FIELDS:
                    if name in p.target:
                        failure = _event_fields(
                            session_id, name, "failed", p.target[name],
                            p.running.get(name), error=error,
                        )
                        self._failures.setdefault(session_id, {})[name] = failure
                        await self._emit(failure)
                return self._summary(session_id, "failed", targets, error=error)

            p.running.update(targets)
            for name, value in targets.items():
                if name in p.target and _norm(name, p.target[name]) == _norm(name, value):
                    p.target.pop(name)
            resumed = bool(result.get("resumed"))
            if p.target and self._pending.get(session_id) is p:
                # The user picked other values while we were restarting.
                p.since = time.time()
                p.waiting_announced = False
                immediate = False
                await self._emit_all(session_id, targets, "applied", targets, resumed=resumed, more=True)
                continue
            self._pending.pop(session_id, None)
            native = result.get("native_session_id")
            await self._emit_all(
                session_id, targets, "applied", targets,
                resumed=resumed, native_session_id=native,
            )
            return self._summary(
                session_id, "applied", targets,
                resumed=resumed, native_session_id=native,
            )


class LiveModeApplier(LiveLaunchApplier):
    """Permission-mode-only facade with the original API."""

    def __init__(self, *, restart: Callable[[str, str], Awaitable[dict]], **kw) -> None:
        async def _restart(session_id: str, targets: dict) -> dict:
            return await restart(session_id, targets["permission_mode"])
        super().__init__(restart=_restart, **kw)

    async def request(self, session_id: str, running_mode: str, target_mode: str) -> dict:
        return await self.request_field(
            session_id, "permission_mode", running_mode or "default", target_mode or "default",
        )

    def pending(self, session_id: str, field_name: str | None = "permission_mode") -> dict | None:
        return super().pending(session_id, field_name)
