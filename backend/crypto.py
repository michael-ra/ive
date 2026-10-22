"""At-rest encryption for account secrets (opt-in, backward-compatible).

Default behaviour is UNCHANGED. With ``IVE_ENCRYPT_SECRETS`` unset,
``maybe_encrypt()`` is a passthrough and stored keys stay plaintext, exactly as
before. ``decrypt_secret()`` is ALWAYS a safe passthrough for values that aren't
encrypted, so read sites can route every ``accounts.api_key`` through it whether
or not encryption is turned on — that's what makes wiring decrypt at read sites
risk-free.

When ``IVE_ENCRYPT_SECRETS`` is truthy, newly written secrets are Fernet
encrypted under a master key held in the OS keychain (``keyring``) or, if
keyring isn't available, a ``0600`` key file at ``~/.ive/.secret_key``.
Encrypted values carry an ``enc:v1:`` prefix so ``decrypt_secret`` can tell them
apart from plaintext without a schema change.

To turn it on for an existing DB:
    1. export IVE_ENCRYPT_SECRETS=1
    2. run the ``encrypt_all_account_keys(db)`` migration once
Every account-key reader in the backend already routes through
``decrypt_secret`` (see call sites), so enabling it does not break auth.
"""

from __future__ import annotations

import logging
import os
import stat
from pathlib import Path
from typing import Optional

from config import DATA_DIR, ACCOUNT_HOMES_DIR

logger = logging.getLogger(__name__)

# Version-tagged so we can rotate the scheme later without ambiguity.
PREFIX = "enc:v1:"

_KEYRING_SERVICE = "ive"
_KEYRING_USER = "secrets-key"
_KEY_FILE = DATA_DIR / ".secret_key"

_fernet = None  # lazily initialised singleton


def _enabled() -> bool:
    return os.environ.get("IVE_ENCRYPT_SECRETS", "").strip().lower() in {"1", "true", "yes", "on"}


def _load_or_create_key() -> Optional[bytes]:
    """Return a urlsafe-base64 Fernet key, preferring the OS keychain.

    Falls back to a 0600 key file under DATA_DIR when keyring is unavailable
    (headless boxes, no Secret Service, etc.). Returns None only if we can't
    generate a key at all — callers treat that as "encryption unavailable".
    """
    try:
        from cryptography.fernet import Fernet
    except Exception:  # cryptography is normally present (pywebpush dep)
        logger.warning("crypto: cryptography not installed — secret encryption unavailable")
        return None

    # 1. Keychain (encrypted by the OS, no plaintext key on disk).
    try:
        import keyring

        existing = keyring.get_password(_KEYRING_SERVICE, _KEYRING_USER)
        if existing:
            return existing.encode()
        new_key = Fernet.generate_key()
        keyring.set_password(_KEYRING_SERVICE, _KEYRING_USER, new_key.decode())
        logger.info("crypto: generated new master key in OS keychain")
        return new_key
    except Exception as e:
        logger.info("crypto: keyring unavailable (%s) — using 0600 key file fallback", e)

    # 2. Key file fallback, locked to the owner.
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if _KEY_FILE.exists():
            return _KEY_FILE.read_bytes().strip()
        new_key = Fernet.generate_key()
        _KEY_FILE.write_bytes(new_key)
        try:
            os.chmod(_KEY_FILE, stat.S_IRUSR | stat.S_IWUSR)  # 0600
        except OSError:
            pass
        logger.info("crypto: generated new master key at %s", _KEY_FILE)
        return new_key
    except Exception as e:
        logger.error("crypto: could not create key file: %s", e)
        return None


def _get_fernet():
    global _fernet
    if _fernet is not None:
        return _fernet
    key = _load_or_create_key()
    if not key:
        return None
    try:
        from cryptography.fernet import Fernet

        _fernet = Fernet(key)
        return _fernet
    except Exception as e:
        logger.error("crypto: invalid master key: %s", e)
        return None


def encrypt_secret(value: Optional[str]) -> Optional[str]:
    """Encrypt a secret string. No-op on empty/None or already-encrypted input.

    Returns the original value unchanged if encryption is unavailable, so we
    never silently drop a secret.
    """
    if not value or value.startswith(PREFIX):
        return value
    f = _get_fernet()
    if f is None:
        return value
    try:
        return PREFIX + f.encrypt(value.encode()).decode()
    except Exception as e:
        logger.error("crypto: encrypt failed: %s", e)
        return value


def decrypt_secret(value: Optional[str]) -> Optional[str]:
    """Return the plaintext for a stored secret.

    ALWAYS safe to call on any read: plaintext (non-prefixed) values pass
    straight through, so a reader that routes through this keeps working whether
    or not encryption has ever been enabled.
    """
    if not value or not value.startswith(PREFIX):
        return value
    f = _get_fernet()
    if f is None:
        logger.error("crypto: found encrypted secret but no key available")
        return value
    try:
        return f.decrypt(value[len(PREFIX):].encode()).decode()
    except Exception as e:
        # Surfacing the ciphertext lets the downstream API call fail loudly
        # rather than masking a real key-management problem.
        logger.error("crypto: decrypt failed: %s", e)
        return value


def maybe_encrypt(value: Optional[str]) -> Optional[str]:
    """Encrypt on write only when IVE_ENCRYPT_SECRETS is on; else passthrough."""
    if not _enabled():
        return value
    return encrypt_secret(value)


def secure_data_dirs() -> None:
    """Best-effort tighten permissions on the secret-bearing data dirs (0700).

    Unconditional and safe — runs at startup regardless of the encryption flag.
    """
    browser_contexts = DATA_DIR / "browser_contexts"
    for d in (DATA_DIR, ACCOUNT_HOMES_DIR, browser_contexts):
        try:
            if d.exists():
                os.chmod(d, stat.S_IRWXU)  # 0700
        except OSError as e:
            logger.debug("crypto: chmod %s failed: %s", d, e)
    # DB and key file should be owner-only if present.
    for f in (DATA_DIR / "data.db", _KEY_FILE):
        try:
            if f.exists():
                os.chmod(f, stat.S_IRUSR | stat.S_IWUSR)  # 0600
        except OSError as e:
            logger.debug("crypto: chmod %s failed: %s", f, e)


async def encrypt_all_account_keys(db) -> int:
    """One-shot migration: encrypt every plaintext ``accounts.api_key`` in place.

    Idempotent — already-encrypted rows are skipped. Returns the count updated.
    Run this once after enabling IVE_ENCRYPT_SECRETS. Requires an open aiosqlite
    connection; the caller commits.
    """
    if not _enabled():
        logger.warning("encrypt_all_account_keys: IVE_ENCRYPT_SECRETS is off — nothing to do")
        return 0
    cur = await db.execute(
        "SELECT id, api_key FROM accounts WHERE api_key IS NOT NULL AND api_key != ''"
    )
    rows = await cur.fetchall()
    updated = 0
    for row in rows:
        raw = row["api_key"]
        if not raw or raw.startswith(PREFIX):
            continue
        enc = encrypt_secret(raw)
        if enc != raw:
            await db.execute("UPDATE accounts SET api_key = ? WHERE id = ?", (enc, row["id"]))
            updated += 1
    await db.commit()
    logger.info("encrypt_all_account_keys: encrypted %d account key(s)", updated)
    return updated
