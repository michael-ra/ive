"""Web Push subscription management.

This module owns the `push_subscriptions` table CRUD. Actual VAPID
sending lives behind `pywebpush` — when that's installed and a VAPID
keypair is on disk, `send_to_actor()` will fan out; otherwise it
no-ops gracefully so the rest of the app never breaks because Push
isn't configured.
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
from typing import Optional

from db import get_db

logger = logging.getLogger(__name__)


async def upsert_subscription(
    *,
    actor_kind: str,
    actor_id: Optional[str],
    endpoint: str,
    p256dh: str,
    auth: str,
    user_agent: Optional[str],
) -> dict:
    """Create or refresh a Web Push subscription row."""
    sub_id = secrets.token_hex(8)
    db = await get_db()
    try:
        await db.execute(
            """
            INSERT INTO push_subscriptions
                (id, actor_kind, actor_id, endpoint, p256dh, auth, user_agent, last_used_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(actor_kind, actor_id, endpoint) DO UPDATE SET
                p256dh = excluded.p256dh,
                auth = excluded.auth,
                user_agent = excluded.user_agent,
                last_used_at = datetime('now')
            """,
            (sub_id, actor_kind, actor_id, endpoint, p256dh, auth, user_agent),
        )
        await db.commit()
        cur = await db.execute(
            "SELECT * FROM push_subscriptions WHERE actor_kind = ? AND COALESCE(actor_id,'') = COALESCE(?, '') AND endpoint = ?",
            (actor_kind, actor_id, endpoint),
        )
        row = await cur.fetchone()
        return dict(row) if row else {"id": sub_id}
    finally:
        await db.close()


async def remove_subscription(
    *,
    actor_kind: str,
    actor_id: Optional[str],
    endpoint: str,
) -> bool:
    db = await get_db()
    try:
        cur = await db.execute(
            "DELETE FROM push_subscriptions WHERE actor_kind = ? AND COALESCE(actor_id,'') = COALESCE(?, '') AND endpoint = ?",
            (actor_kind, actor_id, endpoint),
        )
        await db.commit()
        return cur.rowcount > 0
    finally:
        await db.close()


async def list_for_actor(actor_kind: str, actor_id: Optional[str]) -> list[dict]:
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT * FROM push_subscriptions WHERE actor_kind = ? AND COALESCE(actor_id,'') = COALESCE(?, '') ORDER BY created_at DESC",
            (actor_kind, actor_id),
        )
        rows = await cur.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


_OWNER_KINDS = ("localhost", "owner_legacy", "owner_device")


async def list_owner_subscriptions() -> list[dict]:
    """Every push subscription belonging to an owner-class actor.

    Used as the default fan-out scope for session-lifecycle pushes
    (session done, input needed). Joiner subscriptions are excluded
    so a tunnel guest doesn't get notified about owner-only events.
    """
    db = await get_db()
    try:
        placeholders = ",".join("?" for _ in _OWNER_KINDS)
        cur = await db.execute(
            f"SELECT * FROM push_subscriptions WHERE actor_kind IN ({placeholders}) "
            "ORDER BY last_used_at DESC",
            _OWNER_KINDS,
        )
        rows = await cur.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


async def _dispatch(
    subs: list[dict],
    *,
    title: str,
    body: str,
    url: Optional[str],
    tag: Optional[str],
) -> int:
    """Fan a payload out to a pre-fetched subscription list.

    pywebpush is synchronous (uses `requests`), so each call is offloaded
    to the default executor — otherwise a slow/dead push endpoint would
    block the entire event loop for the duration of the timeout. Dead
    endpoints (404/410) are pruned from the DB after the fan-out.
    """
    try:
        from pywebpush import webpush, WebPushException  # type: ignore
    except ImportError:
        logger.debug("pywebpush not installed — skipping push")
        return 0

    vapid = _load_vapid()
    if not vapid:
        logger.debug("VAPID not configured — skipping push")
        return 0

    if not subs:
        return 0

    payload_obj = {"title": title, "body": body, "url": url or "/"}
    if tag:
        payload_obj["tag"] = tag
    payload = json.dumps(payload_obj)
    loop = asyncio.get_event_loop()

    def _send_one(sub: dict) -> tuple[str, Optional[Exception]]:
        try:
            webpush(
                subscription_info={
                    "endpoint": sub["endpoint"],
                    "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
                },
                data=payload,
                vapid_private_key=vapid["private_key"],
                vapid_claims={"sub": vapid["sub"]},
            )
            return (sub["endpoint"], None)
        except Exception as e:  # WebPushException or transport error
            return (sub["endpoint"], e)

    results = await asyncio.gather(
        *(loop.run_in_executor(None, _send_one, s) for s in subs),
        return_exceptions=True,
    )

    sent = 0
    dead: list[tuple[str, Optional[str], str]] = []
    sub_by_endpoint = {s["endpoint"]: s for s in subs}
    for r in results:
        if isinstance(r, BaseException):
            logger.warning("Web Push executor error: %s", r)
            continue
        endpoint, err = r
        if err is None:
            sent += 1
            continue
        # Inspect WebPushException status if available; only 404/410 are
        # truly gone (subscription expired/revoked). Everything else is
        # a transient error the user's browser may recover from.
        status = getattr(getattr(err, "response", None), "status_code", None)
        s = sub_by_endpoint.get(endpoint)
        if status in (404, 410) and s is not None:
            dead.append((s["actor_kind"], s.get("actor_id"), endpoint))
        else:
            logger.warning("Web Push failed (%s): %s", status, err)

    for ak, aid, ep in dead:
        try:
            await remove_subscription(actor_kind=ak, actor_id=aid, endpoint=ep)
        except Exception:
            pass
    return sent


async def send_to_actor(
    *,
    actor_kind: str,
    actor_id: Optional[str],
    title: str,
    body: str,
    url: Optional[str] = None,
    tag: Optional[str] = None,
) -> int:
    """Fan-out a Web Push to every registered subscription for the actor.

    Returns the number of successful sends. Silently returns 0 if
    pywebpush isn't installed or VAPID isn't configured.
    """
    subs = await list_for_actor(actor_kind, actor_id)
    return await _dispatch(subs, title=title, body=body, url=url, tag=tag)


async def send_to_owners(
    *,
    title: str,
    body: str,
    url: Optional[str] = None,
    tag: Optional[str] = None,
) -> int:
    """Push to every owner-class subscription (every paired owner device).

    The right scope for session-lifecycle alerts in a single-owner
    deployment. Returns the number of successful sends. No-op if
    pywebpush/VAPID isn't configured.
    """
    subs = await list_owner_subscriptions()
    return await _dispatch(subs, title=title, body=body, url=url, tag=tag)


_VAPID_CACHE: Optional[dict] = None


def _generate_vapid_keypair() -> Optional[dict]:
    """Generate a fresh ECDSA P-256 VAPID keypair using py-vapid.

    Returns the {private_key, public_key, sub} dict on success, or None
    if py-vapid (a pywebpush dependency) is unavailable. py-vapid emits
    base64url-encoded keys directly suitable for both pywebpush
    consumption and the browser's `applicationServerKey`.
    """
    try:
        from py_vapid import Vapid  # type: ignore
    except ImportError:
        logger.debug("py-vapid not installed — cannot auto-generate VAPID keys")
        return None
    try:
        v = Vapid()
        v.generate_keys()
        # py-vapid stores keys as cryptography objects; serialize via
        # its private_pem()/public_key getters. The browser-friendly
        # base64url representation comes from the public_key bytes.
        import base64
        from cryptography.hazmat.primitives import serialization
        priv_pem = v.private_pem().decode("utf-8")
        pub_bytes = v.public_key.public_bytes(
            encoding=serialization.Encoding.X962,
            format=serialization.PublicFormat.UncompressedPoint,
        )
        pub_b64url = base64.urlsafe_b64encode(pub_bytes).rstrip(b"=").decode("ascii")
        return {
            "private_key": priv_pem,
            "public_key": pub_b64url,
            "sub": "mailto:ive@local",
        }
    except Exception as e:
        logger.warning("VAPID auto-generation failed: %s", e)
        return None


def _load_vapid() -> Optional[dict]:
    """Read VAPID config from $HOME/.ive/vapid.json (mode 0600).

    Auto-generates a keypair on first call if py-vapid is available
    and no file exists — keeps the release path working out of the
    box without an explicit setup step.
    """
    global _VAPID_CACHE
    if _VAPID_CACHE is not None:
        return _VAPID_CACHE or None
    try:
        from config import DATA_DIR
        path = DATA_DIR / "vapid.json"
        if not path.exists():
            generated = _generate_vapid_keypair()
            if not generated:
                _VAPID_CACHE = {}
                return None
            try:
                DATA_DIR.mkdir(parents=True, exist_ok=True)
                with open(path, "w") as f:
                    json.dump(generated, f)
                try:
                    import os
                    os.chmod(path, 0o600)
                except Exception:
                    pass
                logger.info("Generated VAPID keypair at %s", path)
            except Exception as e:
                logger.warning("Could not persist generated VAPID keypair: %s", e)
                # Still cache and return — push will work for this run.
            _VAPID_CACHE = generated
            return generated
        with open(path) as f:
            data = json.load(f)
        if not data.get("private_key") or not data.get("public_key") or not data.get("sub"):
            _VAPID_CACHE = {}
            return None
        _VAPID_CACHE = data
        return data
    except Exception as e:
        logger.warning("Failed to load VAPID config: %s", e)
        _VAPID_CACHE = {}
        return None


def get_public_key() -> Optional[str]:
    """Public VAPID key for frontend subscribe()."""
    v = _load_vapid()
    return v.get("public_key") if v else None
