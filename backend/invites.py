"""Invite tokens — three projections of one 51.7-bit secret.

An invite is a one-shot, short-TTL credential the owner shares so a guest can
mint a joiner session in their preferred mode. The *same* secret is rendered
three ways at create time so the owner can pick whichever fits the channel:

    speakable: ``purple-octopus-tango-mountain``  (4 EFF Long words)
    compact  : ``AB7K-9MQR-X2WP``                  (Crockford base32, 4-4-4)
    qr       : ``https://host/join?t=<base64url>``  (in-person scan only)

All three decode back to the same 7-byte secret. Only ``SHA256(secret)`` is
persisted in the ``invites`` table; the encoded forms are stored alongside
purely so the listing UI can show owners what they previously shared.

Threat model:
- Per-IP rate limit on /api/invite/redeem (5/min) makes brute-forcing the
  ~52-bit space infeasible.
- A real token that fails validation 5 times bumps ``redemption_attempts``
  and burns the row at 5; the per-IP rate limit handles unknown-token guesses.
- Single-use is enforced with ``UPDATE … WHERE redeemed_at IS NULL`` so two
  near-simultaneous redeems can't both win.
- The magic link form (``/join`` page) deliberately does NOT carry the token
  in the URL — paste-only — so chat preview bots can't burn a token by
  visiting a shared link. The QR projection is the documented exception (the
  scanner is the redeemer; in-person scan is the threat model).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import uuid
from base64 import urlsafe_b64decode, urlsafe_b64encode
from dataclasses import dataclass
from typing import Optional

from db import get_db
from wordlists import EFF_SAFE_INDICES, EFF_WORD_INDEX, EFF_WORDS

# ─── Constants ──────────────────────────────────────────────────────────

# Secret canonical form: a 51.7-bit unsigned integer in [0, 7772^4). Stored
# as 7 raw bytes (high 5 bits always zero). Both projections encode this
# integer; the QR form encodes the 7-byte big-endian representation.
_SECRET_BASE = len(EFF_SAFE_INDICES)  # 7772
_SECRET_MAX_EXCLUSIVE = _SECRET_BASE ** 4  # 4-word capacity ≈ 2**51.66
_SECRET_BYTES = 7

# Reverse map for decoding speakable: full EFF index → safe-subset position.
_SAFE_INDEX_TO_POS: dict[int, int] = {
    idx: pos for pos, idx in enumerate(EFF_SAFE_INDICES)
}

# Crockford base32 alphabet (https://www.crockford.com/base32.html). No I, L,
# O, U — they're easy to misread or misspeak. The decoder also tolerates
# lowercase plus the standard substitutions (I→1, L→1, O→0).
_CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_CROCKFORD_VALUE: dict[str, int] = {c: i for i, c in enumerate(_CROCKFORD_ALPHABET)}
# Tolerate common misreadings on input.
_CROCKFORD_VALUE.update({
    "I": 1, "i": 1, "L": 1, "l": 1, "O": 0, "o": 0,
})
for c, v in list(_CROCKFORD_VALUE.items()):
    _CROCKFORD_VALUE.setdefault(c.lower(), v)

# Modes accepted by /api/invite/create.
VALID_MODES = ("brief", "code", "full")
VALID_BRIEF_SUBSCOPES = ("read_only", "create_comment")

# TTL options surfaced in the UI. ``0`` is a browser-session cookie, protected
# by a separate short server-side cap if the opaque bearer is copied.
VALID_TTL_SECONDS = (0, 3600, 28_800, 2_592_000)  # session, 1h, 8h, 30d
INVITE_VALIDITY_SECONDS = 24 * 3600  # invite itself expires in 24h regardless of TTL

# Brute-force burn limit: this many wrong attempts on a *real* invite (i.e.
# the hash matched a row, but ``compare_digest`` rejected it — should never
# happen, since hash match implies secret match… we still increment the
# counter on any redeem attempt that targets this hash, defending against a
# theoretical SHA-256 prefix collision).
MAX_REDEMPTION_ATTEMPTS = 5


# ─── Codec — speakable (4 EFF words) ────────────────────────────────────


def encode_speakable(n: int) -> str:
    """``int`` → ``"purple-octopus-tango-mountain"``."""
    if not 0 <= n < _SECRET_MAX_EXCLUSIVE:
        raise ValueError("integer out of speakable range")
    parts: list[str] = []
    for _ in range(4):
        digit = n % _SECRET_BASE
        n //= _SECRET_BASE
        parts.append(EFF_WORDS[EFF_SAFE_INDICES[digit]])
    return "-".join(parts)


def decode_speakable(s: str) -> int:
    """Lenient inverse of ``encode_speakable``.

    Accepts any of: spaces, hyphens, underscores between words; mixed case;
    leading/trailing whitespace; common articles ("the", "a", "an", "and",
    "of") are stripped if the user inserted them while reading.
    """
    cleaned = s.strip().lower()
    # Normalize separators to single hyphens.
    for sep in (" ", "_", "\t", "\n", ","):
        cleaned = cleaned.replace(sep, "-")
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    parts = [p for p in cleaned.split("-") if p]
    # Strip filler words a user might say.
    parts = [p for p in parts if p not in {"the", "a", "an", "and", "of"}]
    if len(parts) != 4:
        raise ValueError(f"expected 4 words, got {len(parts)}")
    n = 0
    for word in reversed(parts):
        idx = EFF_WORD_INDEX.get(word)
        if idx is None:
            raise ValueError(f"unknown word: {word!r}")
        pos = _SAFE_INDEX_TO_POS.get(idx)
        if pos is None:
            # User pasted one of the four hyphenated EFF entries — encoder
            # never produces these, so it's a malformed/spoofed token.
            raise ValueError(f"word {word!r} not part of the safe encoder set")
        n = n * _SECRET_BASE + pos
    return n


# ─── Codec — compact (Crockford base32, 4-4-4) ──────────────────────────


def encode_compact(n: int) -> str:
    """``int`` → ``"AB7K-9MQR-X2WP"``."""
    if not 0 <= n < _SECRET_MAX_EXCLUSIVE:
        raise ValueError("integer out of compact range")
    chars: list[str] = []
    for _ in range(12):
        chars.append(_CROCKFORD_ALPHABET[n & 0x1F])
        n >>= 5
    chars.reverse()
    return f"{''.join(chars[0:4])}-{''.join(chars[4:8])}-{''.join(chars[8:12])}"


def decode_compact(s: str) -> int:
    """Lenient inverse of ``encode_compact``."""
    cleaned = s.strip()
    for sep in ("-", " ", "_", "\t"):
        cleaned = cleaned.replace(sep, "")
    if len(cleaned) != 12:
        raise ValueError(f"expected 12 base32 chars, got {len(cleaned)}")
    n = 0
    for ch in cleaned:
        v = _CROCKFORD_VALUE.get(ch)
        if v is None:
            raise ValueError(f"invalid base32 char: {ch!r}")
        n = (n << 5) | v
    if n >= _SECRET_MAX_EXCLUSIVE:
        # Encoder always produces values < _SECRET_MAX_EXCLUSIVE; anything
        # larger is a malformed token.
        raise ValueError("decoded value out of canonical range")
    return n


# ─── Codec — QR / raw base64url ─────────────────────────────────────────


def encode_qr_secret(n: int) -> str:
    """``int`` → ``"yE7Vp9Sx2Q"`` (base64url, no padding)."""
    raw = n.to_bytes(_SECRET_BYTES, "big")
    return urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_qr_secret(s: str) -> int:
    """Lenient inverse of ``encode_qr_secret``."""
    cleaned = s.strip()
    # Restore base64 padding (urlsafe_b64encode strips it).
    pad = (-len(cleaned)) % 4
    try:
        raw = urlsafe_b64decode(cleaned + "=" * pad)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"invalid base64url: {exc}") from exc
    if len(raw) != _SECRET_BYTES:
        raise ValueError(f"expected {_SECRET_BYTES} bytes, got {len(raw)}")
    n = int.from_bytes(raw, "big")
    if n >= _SECRET_MAX_EXCLUSIVE:
        raise ValueError("decoded value out of canonical range")
    return n


# ─── Best-effort multi-format decoder ───────────────────────────────────


def decode_any(token: str) -> Optional[int]:
    """Try each projection in turn. Returns the canonical int, or None."""
    token = token.strip()
    if not token:
        return None
    # Speakable wins if the input has ≥3 separators that look like word
    # boundaries — cheap heuristic before invoking each parser.
    for parser in (decode_speakable, decode_compact, decode_qr_secret):
        try:
            return parser(token)
        except ValueError:
            continue
    return None


# ─── Hashing ────────────────────────────────────────────────────────────


def hash_secret(n: int) -> str:
    """SHA-256 hex digest of the canonical 7-byte representation."""
    return hashlib.sha256(n.to_bytes(_SECRET_BYTES, "big")).hexdigest()


# ─── CRUD ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CreatedInvite:
    id: str
    workspace_id: str
    secret_int: int
    encoded_speakable: str
    encoded_compact: str
    encoded_qr_secret: str
    expires_at: str
    mode: str
    brief_subscope: Optional[str]
    ttl_seconds: int
    label: Optional[str]


async def create_invite(
    *,
    workspace_id: str,
    mode: str,
    ttl_seconds: int,
    label: Optional[str] = None,
    brief_subscope: Optional[str] = None,
    created_by: str = "owner",
) -> CreatedInvite:
    """Mint a fresh invite. Returns the secret ONCE — caller must surface it.

    Raises ValueError on invalid input. Persists only the SHA-256 of the
    secret plus the (cosmetic) encoded projections for the listing UI.
    """
    workspace_id = workspace_id.strip()
    if not workspace_id:
        raise ValueError("workspace_id is required")
    if mode not in VALID_MODES:
        raise ValueError(f"invalid mode {mode!r}; must be one of {VALID_MODES}")
    if ttl_seconds not in VALID_TTL_SECONDS:
        raise ValueError(
            f"invalid ttl_seconds {ttl_seconds}; must be one of {VALID_TTL_SECONDS}"
        )
    if mode == "brief":
        if brief_subscope is not None and brief_subscope not in VALID_BRIEF_SUBSCOPES:
            raise ValueError(f"invalid brief_subscope {brief_subscope!r}")
    elif brief_subscope is not None:
        raise ValueError("brief_subscope only valid when mode='brief'")

    secret_int = secrets.randbelow(_SECRET_MAX_EXCLUSIVE)
    token_hash = hash_secret(secret_int)
    encoded_speakable = encode_speakable(secret_int)
    encoded_compact = encode_compact(secret_int)
    encoded_qr = encode_qr_secret(secret_int)

    invite_id = str(uuid.uuid4())
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT 1 FROM workspaces WHERE id = ?", (workspace_id,)
        )
        if not await cur.fetchone():
            raise ValueError("workspace not found")
        await db.execute(
            """INSERT INTO invites
               (id, workspace_id, token_hash, encoded_speakable, encoded_compact, mode,
                brief_subscope, ttl_seconds, label, expires_at, created_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
                       datetime('now', ?), ?)""",
            (
                invite_id, workspace_id, token_hash, encoded_speakable, encoded_compact,
                mode, brief_subscope, ttl_seconds, label,
                f"+{INVITE_VALIDITY_SECONDS} seconds",
                created_by,
            ),
        )
        await db.commit()
        cur = await db.execute(
            "SELECT expires_at FROM invites WHERE id = ?", (invite_id,)
        )
        row = await cur.fetchone()
        expires_at = row["expires_at"] if row else ""
    finally:
        await db.close()

    return CreatedInvite(
        id=invite_id,
        workspace_id=workspace_id,
        secret_int=secret_int,
        encoded_speakable=encoded_speakable,
        encoded_compact=encoded_compact,
        encoded_qr_secret=encoded_qr,
        expires_at=expires_at,
        mode=mode,
        brief_subscope=brief_subscope,
        ttl_seconds=ttl_seconds,
        label=label,
    )


async def list_invites() -> list[dict]:
    """All invites, newest first. Cosmetic encodings + status — no secrets."""
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT id, workspace_id, encoded_speakable, encoded_compact, mode, brief_subscope,
                      ttl_seconds, label, redemption_attempts, redeemed_at,
                      redeemed_by_session_id, burned_at, expires_at, created_at,
                      created_by
                 FROM invites
                ORDER BY created_at DESC"""
        )
        rows = await cur.fetchall()
    finally:
        await db.close()
    return [dict(r) for r in rows]


async def revoke_invite(invite_id: str) -> bool:
    """Burn an invite. Idempotent — burning an already-burned row is a no-op.

    Returns True if a row exists (regardless of prior burn state), False if
    the id is unknown.
    """
    db = await get_db()
    try:
        cur = await db.execute("SELECT 1 FROM invites WHERE id = ?", (invite_id,))
        if not await cur.fetchone():
            return False
        await db.execute(
            "UPDATE invites SET burned_at = datetime('now') "
            "WHERE id = ? AND burned_at IS NULL",
            (invite_id,),
        )
        await db.commit()
    finally:
        await db.close()
    return True


@dataclass(frozen=True)
class RedeemResult:
    invite_id: str
    workspace_id: str
    mode: str
    brief_subscope: Optional[str]
    ttl_seconds: int
    label: Optional[str]


class InviteRedeemError(Exception):
    """Reasons an invite can't be redeemed.

    ``code`` is one of:
        not_found       — token doesn't match any row (or was never minted)
        burned          — invite was revoked or hit MAX_REDEMPTION_ATTEMPTS
        redeemed        — already used (single-use)
        expired         — past expires_at
        invalid_token   — couldn't decode any projection
        invalid_scope   — legacy/corrupt row has no enforceable workspace
    """

    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code


async def redeem_invite(token_input: str) -> RedeemResult:
    """Validate a user-supplied token in any projection. One-shot.

    On success, marks the row redeemed and returns the mode/subscope so the
    caller can mint the actual scoped session row.

    Raises ``InviteRedeemError`` with a stable ``code`` on every failure path.
    """
    secret_int = decode_any(token_input)
    if secret_int is None:
        raise InviteRedeemError("invalid_token", "could not decode token")
    token_hash = hash_secret(secret_int)

    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT id, workspace_id, token_hash, mode, brief_subscope, ttl_seconds, label,
                      redeemed_at, burned_at, expires_at, redemption_attempts
                 FROM invites
                WHERE token_hash = ?""",
            (token_hash,),
        )
        row = await cur.fetchone()
        if row is None:
            raise InviteRedeemError("not_found")

        # Constant-time double-check on the hash. Strictly speaking, finding
        # the row by token_hash already proves the secret — this guards
        # against hypothetical SHA-256 prefix-truncation bugs.
        if not hmac.compare_digest(row["token_hash"], token_hash):
            await _bump_attempts(db, row["id"])
            raise InviteRedeemError("not_found")

        if row["burned_at"] is not None:
            raise InviteRedeemError("burned")
        if row["redeemed_at"] is not None:
            raise InviteRedeemError("redeemed")
        if not row["workspace_id"]:
            raise InviteRedeemError(
                "invalid_scope", "invite has no enforceable workspace scope"
            )

        # Compare expires_at as a string in SQLite's `datetime('now')` form.
        cur2 = await db.execute(
            "SELECT (expires_at <= datetime('now')) AS expired "
            "FROM invites WHERE id = ?",
            (row["id"],),
        )
        exp = await cur2.fetchone()
        if exp and exp["expired"]:
            raise InviteRedeemError("expired")

        # Atomic single-use claim.
        cur3 = await db.execute(
            "UPDATE invites SET redeemed_at = datetime('now') "
            "WHERE id = ? AND redeemed_at IS NULL AND burned_at IS NULL",
            (row["id"],),
        )
        await db.commit()
        if cur3.rowcount == 0:
            # Lost a concurrent race.
            raise InviteRedeemError("redeemed")
    finally:
        await db.close()

    return RedeemResult(
        invite_id=row["id"],
        workspace_id=row["workspace_id"],
        mode=row["mode"],
        brief_subscope=row["brief_subscope"],
        ttl_seconds=row["ttl_seconds"],
        label=row["label"],
    )


async def _bump_attempts(db, invite_id: str) -> None:
    """Increment redemption_attempts; burn at MAX_REDEMPTION_ATTEMPTS."""
    await db.execute(
        "UPDATE invites SET redemption_attempts = redemption_attempts + 1 "
        "WHERE id = ?",
        (invite_id,),
    )
    await db.execute(
        "UPDATE invites SET burned_at = datetime('now') "
        "WHERE id = ? AND redemption_attempts >= ? AND burned_at IS NULL",
        (invite_id, MAX_REDEMPTION_ATTEMPTS),
    )
    await db.commit()
