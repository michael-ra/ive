"""Commander central event bus.

Single point of truth for every state change in Commander. Any code that
mutates state (task board, sessions, plugins, workspace, research) calls
`bus.emit(event, payload)` instead of just mutating silently. The bus then:

    1. Persists the event to the commander_events audit log.
    2. Notifies in-process async subscribers (for real-time UI updates).
    3. Broadcasts the event to connected WebSocket clients.
    4. Delivers webhooks to subscriptions matching the event type.
    5. [future] Dispatches to plugin component handlers.

Calling convention — emit is fire-and-forget from the caller's POV but
returns an awaitable so any step that might raise (webhook delivery) can
be awaited or ignored at the caller's discretion. Persistence runs first
and is awaited before any side-effects so the audit log is the source of
truth even if a downstream subscriber crashes.

Design notes:
  • The bus is a singleton module-level object `bus`. One per process.
  • Subscriber callbacks receive (event_name, payload) and are awaited.
  • WebSocket broadcast uses a set of clients registered at connect time.
  • Webhook delivery runs in a background task so slow HTTP doesn't block
    the emit caller's request path.
  • Every emit automatically denormalizes payload fields like
    workspace_id/session_id/task_id into their own columns so activity
    feeds can filter efficiently without JSON parsing.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

import aiohttp

from commander_events import CommanderEvent
from db import get_db

logger = logging.getLogger(__name__)


# Callback signature for in-process subscribers.
SubscriberFn = Callable[[str, dict], Awaitable[None]]


@dataclass
class EventRecord:
    """One event as persisted in commander_events."""
    id: int
    event_type: str
    source: str
    payload: dict
    workspace_id: Optional[str]
    session_id: Optional[str]
    task_id: Optional[str]
    actor: Optional[str]
    created_at: str


class EventBus:
    """Central dispatcher. Single instance lives at module level."""

    def __init__(self) -> None:
        self._subscribers: dict[str, list[SubscriberFn]] = {}
        self._wildcard_subscribers: list[SubscriberFn] = []
        self._ws_clients: set = set()
        self._webhook_timeout = aiohttp.ClientTimeout(total=10)

    # ── In-process subscription ────────────────────────────────────────

    def subscribe(self, event: str | CommanderEvent, handler: SubscriberFn) -> None:
        """Register an in-process async subscriber for one event type."""
        key = event.value if isinstance(event, CommanderEvent) else event
        self._subscribers.setdefault(key, []).append(handler)

    def subscribe_all(self, handler: SubscriberFn) -> None:
        """Register a subscriber that sees every event fired."""
        self._wildcard_subscribers.append(handler)

    def unsubscribe(self, event: str | CommanderEvent, handler: SubscriberFn) -> None:
        key = event.value if isinstance(event, CommanderEvent) else event
        if key in self._subscribers:
            try:
                self._subscribers[key].remove(handler)
            except ValueError:
                pass

    # ── WebSocket fan-out ──────────────────────────────────────────────

    def register_ws(self, client) -> None:
        """Called from the WebSocket handler when a new client connects."""
        self._ws_clients.add(client)

    def unregister_ws(self, client) -> None:
        self._ws_clients.discard(client)

    # ── Emission ───────────────────────────────────────────────────────

    async def emit(
        self,
        event: str | CommanderEvent,
        payload: Optional[dict] = None,
        *,
        source: str = "commander",
        actor: Optional[str] = None,
    ) -> EventRecord:
        """Emit an event. Persists, then notifies subscribers asynchronously.

        Returns the EventRecord so callers can chain on its ID if needed.
        Never raises — subscriber failures are logged but don't propagate.
        """
        event_name = event.value if isinstance(event, CommanderEvent) else event
        payload = dict(payload or {})

        # Denormalize common filter fields out of the payload so the
        # activity feed query doesn't need JSON parsing.
        workspace_id = payload.get("workspace_id")
        session_id = payload.get("session_id")
        task_id = payload.get("task_id")

        # Persist first — audit log wins over anything else.
        record = await self._persist(
            event_name, payload, source, actor,
            workspace_id, session_id, task_id,
        )

        # Notify in-process subscribers (awaited, concurrent).
        subs = list(self._subscribers.get(event_name, [])) + list(self._wildcard_subscribers)
        if subs:
            await asyncio.gather(
                *(self._invoke_subscriber(s, event_name, payload) for s in subs),
                return_exceptions=True,
            )

        # WebSocket broadcast — best effort, not awaited.
        if self._ws_clients:
            asyncio.create_task(self._broadcast_ws(record))

        # Webhook delivery — best effort, not awaited.
        asyncio.create_task(self._deliver_webhooks(record))

        return record

    async def _invoke_subscriber(self, handler: SubscriberFn, event: str, payload: dict) -> None:
        try:
            await handler(event, payload)
        except Exception:
            logger.exception(f"event subscriber failed for {event}")

    # ── Persistence ────────────────────────────────────────────────────

    async def _persist(
        self,
        event_name: str,
        payload: dict,
        source: str,
        actor: Optional[str],
        workspace_id: Optional[str],
        session_id: Optional[str],
        task_id: Optional[str],
    ) -> EventRecord:
        db = await get_db()
        try:
            cur = await db.execute(
                """INSERT INTO commander_events
                   (event_type, source, payload, workspace_id, session_id, task_id, actor)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    event_name,
                    source,
                    json.dumps(payload),
                    workspace_id,
                    session_id,
                    task_id,
                    actor,
                ),
            )
            await db.commit()
            row_id = cur.lastrowid
            cur2 = await db.execute(
                "SELECT created_at FROM commander_events WHERE id = ?", (row_id,)
            )
            row = await cur2.fetchone()
            created_at = row["created_at"] if row else ""
        finally:
            await db.close()

        return EventRecord(
            id=row_id,
            event_type=event_name,
            source=source,
            payload=payload,
            workspace_id=workspace_id,
            session_id=session_id,
            task_id=task_id,
            actor=actor,
            created_at=created_at,
        )

    # ── WebSocket broadcast ────────────────────────────────────────────

    async def _broadcast_ws(self, record: EventRecord) -> None:
        """Best-effort fan-out to all connected WebSocket clients."""
        if not self._ws_clients:
            return
        message = {
            "type": "commander_event",
            "event": {
                "id": record.id,
                "event_type": record.event_type,
                "source": record.source,
                "payload": record.payload,
                "workspace_id": record.workspace_id,
                "session_id": record.session_id,
                "task_id": record.task_id,
                "actor": record.actor,
                "created_at": record.created_at,
            },
        }
        dead = []
        for client in list(self._ws_clients):
            try:
                # Duck-type check: aiohttp WebSocketResponse has send_json
                send_json = getattr(client, "send_json", None)
                if send_json is None:
                    continue
                await send_json(message)
            except Exception:
                dead.append(client)
        for d in dead:
            self._ws_clients.discard(d)

    # ── Webhook delivery ───────────────────────────────────────────────

    async def _deliver_webhooks(self, record: EventRecord) -> None:
        """Query matching subscriptions and POST the event to each webhook URL.

        Runs in a background task so emit() never blocks on HTTP. Delivery
        failures are recorded in the subscription row but never raise.
        """
        try:
            subscriptions = await self._find_matching_subscriptions(record)
        except Exception:
            logger.exception("failed to look up event subscriptions")
            return

        if not subscriptions:
            return

        async with aiohttp.ClientSession(timeout=self._webhook_timeout) as session:
            await asyncio.gather(
                *(self._post_webhook(session, sub, record) for sub in subscriptions),
                return_exceptions=True,
            )

    async def _find_matching_subscriptions(self, record: EventRecord) -> list[dict]:
        """Return every enabled subscription that wants this event.

        Matching rules:
          • event_types == "*" → matches everything
          • event_types CSV contains the event_type exactly
          • workspace_id null → applies to all workspaces
          • workspace_id set → must match the event's workspace_id
        """
        db = await get_db()
        try:
            cur = await db.execute(
                """SELECT * FROM event_subscriptions
                   WHERE enabled = 1
                     AND delivery_type = 'webhook'
                     AND (workspace_id IS NULL OR workspace_id = ?)""",
                (record.workspace_id or "",),
            )
            rows = await cur.fetchall()
        finally:
            await db.close()

        matching = []
        for row in rows:
            types = (row["event_types"] or "").strip()
            if types == "*":
                matching.append(dict(row))
                continue
            wanted = {t.strip() for t in types.split(",") if t.strip()}
            if record.event_type in wanted:
                matching.append(dict(row))
        return matching

    async def _post_webhook(
        self, session: aiohttp.ClientSession, sub: dict, record: EventRecord
    ) -> None:
        url = sub.get("webhook_url") or ""
        if not url:
            return

        body = {
            "id": record.id,
            "event_type": record.event_type,
            "source": record.source,
            "payload": record.payload,
            "workspace_id": record.workspace_id,
            "session_id": record.session_id,
            "task_id": record.task_id,
            "actor": record.actor,
            "created_at": record.created_at,
        }
        body_bytes = json.dumps(body).encode()
        headers = {"Content-Type": "application/json"}

        # Optional HMAC signing — gives the receiver a way to verify the
        # payload came from this Commander instance.
        secret = sub.get("webhook_secret")
        if secret:
            sig = hmac.new(
                secret.encode(), body_bytes, hashlib.sha256
            ).hexdigest()
            headers["X-Commander-Signature"] = f"sha256={sig}"

        status = "ok"
        error: Optional[str] = None
        try:
            async with session.post(url, data=body_bytes, headers=headers) as resp:
                if resp.status >= 400:
                    status = "error"
                    error = f"HTTP {resp.status}"
        except Exception as e:
            status = "error"
            error = str(e)[:500]

        # Record delivery status on the subscription row.
        db = await get_db()
        try:
            await db.execute(
                """UPDATE event_subscriptions
                   SET delivery_count = delivery_count + 1,
                       last_delivery_at = datetime('now'),
                       last_delivery_status = ?,
                       last_delivery_error = ?
                   WHERE id = ?""",
                (status, error, sub["id"]),
            )
            await db.commit()
        finally:
            await db.close()

    # ── Query helpers (used by REST API) ───────────────────────────────

    async def query_events(
        self,
        *,
        limit: int = 100,
        event_type: Optional[str] = None,
        workspace_id: Optional[str] = None,
        session_id: Optional[str] = None,
        task_id: Optional[str] = None,
        since_id: Optional[int] = None,
    ) -> list[dict]:
        """Query the audit log with optional filters. Returns newest first."""
        sql = "SELECT * FROM commander_events WHERE 1=1"
        params: list[Any] = []
        if event_type:
            sql += " AND event_type = ?"
            params.append(event_type)
        if workspace_id:
            sql += " AND workspace_id = ?"
            params.append(workspace_id)
        if session_id:
            sql += " AND session_id = ?"
            params.append(session_id)
        if task_id:
            sql += " AND task_id = ?"
            params.append(task_id)
        if since_id is not None:
            sql += " AND id > ?"
            params.append(since_id)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(min(max(limit, 1), 1000))

        db = await get_db()
        try:
            cur = await db.execute(sql, params)
            rows = await cur.fetchall()
            results = []
            for row in rows:
                d = dict(row)
                try:
                    d["payload"] = json.loads(d["payload"]) if d["payload"] else {}
                except Exception:
                    d["payload"] = {}
                results.append(d)
            return results
        finally:
            await db.close()

    # ── Subscription CRUD (used by REST API) ───────────────────────────

    async def list_subscriptions(self) -> list[dict]:
        db = await get_db()
        try:
            cur = await db.execute(
                "SELECT * FROM event_subscriptions ORDER BY created_at DESC"
            )
            rows = await cur.fetchall()
            return [dict(r) for r in rows]
        finally:
            await db.close()

    async def create_subscription(
        self,
        *,
        name: str,
        event_types: str,
        delivery_type: str = "webhook",
        webhook_url: Optional[str] = None,
        webhook_secret: Optional[str] = None,
        plugin_id: Optional[str] = None,
        workspace_id: Optional[str] = None,
        created_by: str = "user",
    ) -> dict:
        sub_id = str(uuid.uuid4())
        db = await get_db()
        try:
            await db.execute(
                """INSERT INTO event_subscriptions
                   (id, name, event_types, workspace_id, delivery_type,
                    webhook_url, webhook_secret, plugin_id, enabled,
                    created_by, last_delivery_status)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'pending')""",
                (
                    sub_id, name, event_types, workspace_id, delivery_type,
                    webhook_url, webhook_secret, plugin_id, created_by,
                ),
            )
            await db.commit()
            cur = await db.execute(
                "SELECT * FROM event_subscriptions WHERE id = ?", (sub_id,)
            )
            row = await cur.fetchone()
            return dict(row)
        finally:
            await db.close()

    async def update_subscription(self, sub_id: str, **fields) -> Optional[dict]:
        allowed = {"name", "event_types", "webhook_url", "webhook_secret",
                   "enabled", "workspace_id"}
        updates = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return None
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [sub_id]

        db = await get_db()
        try:
            await db.execute(
                f"UPDATE event_subscriptions SET {set_clause} WHERE id = ?",
                values,
            )
            await db.commit()
            cur = await db.execute(
                "SELECT * FROM event_subscriptions WHERE id = ?", (sub_id,)
            )
            row = await cur.fetchone()
            return dict(row) if row else None
        finally:
            await db.close()

    async def delete_subscription(self, sub_id: str) -> bool:
        db = await get_db()
        try:
            cur = await db.execute(
                "DELETE FROM event_subscriptions WHERE id = ?", (sub_id,)
            )
            await db.commit()
            return cur.rowcount > 0
        finally:
            await db.close()


# Global singleton — import this in route handlers and mutator functions.
bus = EventBus()


# ─── Convenience helpers ─────────────────────────────────────────────────

async def emit(event: str | CommanderEvent, payload: Optional[dict] = None, **kwargs) -> EventRecord:
    """Shorthand for `bus.emit(...)` so callers don't need to import `bus`."""
    return await bus.emit(event, payload, **kwargs)
