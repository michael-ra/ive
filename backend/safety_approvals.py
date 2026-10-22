"""Signed one-time safety decisions and durable, exactly-scoped approvals."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import secrets
import time
from typing import Any


_TOKEN_AUDIENCE = "ive-safety-approval"
_TOKEN_VERSION = 1
_DECISION_TOKEN_TTL_SECONDS = 300
_APPROVAL_TTL_SECONDS = 300
_SIGNING_KEY = secrets.token_bytes(32)


class InvalidDecisionToken(ValueError):
    """The callback token is absent, malformed, expired, forged, or consumed."""


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    try:
        return base64.b64decode(value + padding, altchars=b"-_", validate=True)
    except (ValueError, TypeError) as exc:
        raise InvalidDecisionToken("malformed decision token") from exc


def _canonical_value(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("operation contains a non-finite number")
        return value
    if isinstance(value, list):
        return [_canonical_value(item) for item in value]
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise ValueError("operation object keys must be strings")
        return {key: _canonical_value(value[key]) for key in sorted(value)}
    raise ValueError(f"unsupported operation value: {type(value).__name__}")


def normalize_operation(tool_name: str, tool_input: dict[str, Any]) -> str:
    """Return the exact canonical operation used for approval binding.

    Object key order and line endings are canonicalized, but security-relevant
    shell syntax is preserved byte-for-byte otherwise. Changing privilege,
    environment, quoting, flags, paths, targets, or payloads produces a new digest.
    """
    if not isinstance(tool_name, str) or not tool_name.strip():
        raise ValueError("tool_name must be a non-empty string")
    if not isinstance(tool_input, dict):
        raise ValueError("tool_input must be an object")
    normalized_input = _canonical_value(tool_input)
    canonical_tool = tool_name.strip().lower()
    from tool_semantics import classify_tool_call

    classification = classify_tool_call(tool_name, normalized_input, audit_unknown=False)
    if classification.operation == "execute":
        for command_key, _command in classification.targets:
            command = normalized_input.get(command_key)
            if isinstance(command, str):
                normalized_input[command_key] = command.replace("\r\n", "\n").replace(
                    "\r", "\n"
                ).strip()
    return json.dumps(
        {"tool_name": canonical_tool, "tool_input": normalized_input},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def operation_digest(tool_name: str, tool_input: dict[str, Any]) -> str:
    normalized = normalize_operation(tool_name, tool_input)
    return hashlib.sha256(normalized.encode("utf-8", "strict")).hexdigest()


def _signed_token(claims: dict[str, Any]) -> str:
    payload = json.dumps(
        claims, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    encoded = _b64encode(payload)
    signature = hmac.new(_SIGNING_KEY, encoded.encode("ascii"), hashlib.sha256).digest()
    return f"{encoded}.{_b64encode(signature)}"


def _verify_token(token: str, *, now_epoch: int | None = None) -> dict[str, Any]:
    if not isinstance(token, str) or not token:
        raise InvalidDecisionToken("decision token required")
    try:
        encoded, supplied_signature = token.split(".", 1)
    except ValueError as exc:
        raise InvalidDecisionToken("malformed decision token") from exc
    expected = hmac.new(
        _SIGNING_KEY, encoded.encode("ascii"), hashlib.sha256
    ).digest()
    if not hmac.compare_digest(expected, _b64decode(supplied_signature)):
        raise InvalidDecisionToken("invalid decision token signature")
    try:
        claims = json.loads(_b64decode(encoded))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise InvalidDecisionToken("malformed decision token payload") from exc
    required = {
        "v", "aud", "nonce", "decision_id", "tool_use_id", "actor_kind",
        "actor_id", "workspace_id", "session_id", "rule_id",
        "operation_digest", "exp",
    }
    if not isinstance(claims, dict) or set(claims) != required:
        raise InvalidDecisionToken("invalid decision token claims")
    if claims["v"] != _TOKEN_VERSION or claims["aud"] != _TOKEN_AUDIENCE:
        raise InvalidDecisionToken("invalid decision token audience")
    for key in required - {"v", "decision_id", "exp"}:
        if not isinstance(claims[key], str) or not claims[key]:
            raise InvalidDecisionToken(f"invalid {key} claim")
    if not isinstance(claims["decision_id"], int) or claims["decision_id"] <= 0:
        raise InvalidDecisionToken("invalid decision id claim")
    if not isinstance(claims["exp"], int):
        raise InvalidDecisionToken("invalid decision token expiry")
    now = int(time.time()) if now_epoch is None else int(now_epoch)
    if claims["exp"] < now:
        raise InvalidDecisionToken("decision token expired")
    return claims


async def issue_decision_token(
    db,
    *,
    decision_id: int,
    tool_use_id: str,
    actor_kind: str,
    actor_id: str,
    workspace_id: str,
    session_id: str,
    rule_id: str,
    operation_digest_value: str,
    now_epoch: int | None = None,
) -> str:
    """Persist a pending decision and return its signed callback bearer."""
    values = {
        "tool_use_id": tool_use_id,
        "actor_kind": actor_kind,
        "actor_id": actor_id,
        "workspace_id": workspace_id,
        "session_id": session_id,
        "rule_id": rule_id,
        "operation_digest": operation_digest_value,
    }
    if any(not isinstance(value, str) or not value for value in values.values()):
        raise ValueError("complete approval scope is required")
    now = int(time.time()) if now_epoch is None else int(now_epoch)
    nonce = secrets.token_urlsafe(24)
    claims = {
        "v": _TOKEN_VERSION,
        "aud": _TOKEN_AUDIENCE,
        "nonce": nonce,
        "decision_id": int(decision_id),
        **values,
        "exp": now + _DECISION_TOKEN_TTL_SECONDS,
    }
    token = _signed_token(claims)
    await db.execute(
        """INSERT INTO safety_approval_grants
           (nonce, decision_id, token_hash, actor_kind, actor_id, workspace_id,
            session_id, rule_id, operation_digest, token_expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            nonce,
            int(decision_id),
            hashlib.sha256(token.encode("ascii")).hexdigest(),
            actor_kind,
            actor_id,
            workspace_id,
            session_id,
            rule_id,
            operation_digest_value,
            claims["exp"],
        ),
    )
    return token


async def approve_decision_token(
    db,
    token: str,
    *,
    tool_use_id: str,
    now_epoch: int | None = None,
) -> dict[str, Any]:
    """Verify and atomically consume one callback token, activating its grant."""
    claims = _verify_token(token, now_epoch=now_epoch)
    if not isinstance(tool_use_id, str) or not hmac.compare_digest(
        claims["tool_use_id"], tool_use_id
    ):
        raise InvalidDecisionToken("tool use does not match decision token")
    now = int(time.time()) if now_epoch is None else int(now_epoch)
    token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
    cursor = await db.execute(
        """UPDATE safety_approval_grants
              SET callback_consumed_at = datetime('now'),
                  approved_at = datetime('now'),
                  approval_expires_at = ?
            WHERE nonce = ? AND decision_id = ? AND token_hash = ?
              AND actor_kind = ? AND actor_id = ? AND workspace_id = ?
              AND session_id = ? AND rule_id = ? AND operation_digest = ?
              AND callback_consumed_at IS NULL AND token_expires_at >= ?
              AND EXISTS (
                    SELECT 1 FROM safety_decisions
                     WHERE id = ? AND tool_use_id = ? AND decision = 'ask'
                       AND user_response IS NULL
              )""",
        (
            now + _APPROVAL_TTL_SECONDS,
            claims["nonce"],
            claims["decision_id"],
            token_hash,
            claims["actor_kind"],
            claims["actor_id"],
            claims["workspace_id"],
            claims["session_id"],
            claims["rule_id"],
            claims["operation_digest"],
            now,
            claims["decision_id"],
            claims["tool_use_id"],
        ),
    )
    if cursor.rowcount != 1:
        await db.rollback()
        raise InvalidDecisionToken("decision token expired, consumed, or unknown")
    await db.execute(
        """UPDATE safety_decisions SET user_response = 'approved'
             WHERE id = ? AND tool_use_id = ? AND user_response IS NULL""",
        (claims["decision_id"], claims["tool_use_id"]),
    )
    await db.commit()
    return claims


async def consume_approval(
    db,
    *,
    actor_kind: str,
    actor_id: str,
    workspace_id: str,
    session_id: str,
    rule_id: str,
    operation_digest_value: str,
    now_epoch: int | None = None,
) -> bool:
    """Atomically consume one unexpired grant for the exact scoped operation."""
    now = int(time.time()) if now_epoch is None else int(now_epoch)
    cursor = await db.execute(
        """UPDATE safety_approval_grants
              SET operation_consumed_at = datetime('now')
            WHERE nonce = (
                SELECT nonce FROM safety_approval_grants
                 WHERE actor_kind = ? AND actor_id = ? AND workspace_id = ?
                   AND session_id = ? AND rule_id = ? AND operation_digest = ?
                   AND approved_at IS NOT NULL
                   AND operation_consumed_at IS NULL
                   AND approval_expires_at >= ?
                 ORDER BY approved_at ASC, nonce ASC
                 LIMIT 1
            )
              AND operation_consumed_at IS NULL""",
        (
            actor_kind,
            actor_id,
            workspace_id,
            session_id,
            rule_id,
            operation_digest_value,
            now,
        ),
    )
    await db.commit()
    return cursor.rowcount == 1
