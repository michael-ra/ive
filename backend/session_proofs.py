"""Per-session proof for hook / MCP callers that claim a session identity.

`X-Commander-Session-Id` (hook relay) and `X-IVE-Session-Id` (IVE MCP servers)
are self-declared: any local process could name any session. At PTY spawn IVE
issues a random proof per session and passes it to the CLI process only via
the environment (``COMMANDER_SESSION_PROOF``). The hook relay and IVE's MCP
servers echo it back in a header; the backend compares it in constant time.

The name deliberately avoids KEY/SECRET/TOKEN: Codex and Gemini strip env vars
matching those words before running hooks and tools, which would silently
break every legitimate hook call.

Sessions spawned before this existed have no proof registered. They keep the
old trust model (accepted, logged once) until their next spawn issues one.
Proofs persist in the data dir (0600) so a backend restart keeps enforcing
them for PTYs that outlive it.
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import secrets
import tempfile
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

ENV_VAR = "COMMANDER_SESSION_PROOF"
HOOK_HEADER = "X-Commander-Session-Proof"
MCP_HEADER = "X-IVE-Session-Proof"

OK = "ok"
LEGACY = "legacy"
MISMATCH = "mismatch"

_lock = threading.Lock()
_cache: dict[str, dict[str, str]] = {}
_legacy_logged: set[str] = set()


def _store_path() -> Path:
    import config
    return Path(config.DATA_DIR) / "session_proofs.json"


def _load(path: Path) -> dict[str, str]:
    key = str(path)
    if key in _cache:
        return _cache[key]
    data: dict[str, str] = {}
    try:
        raw = json.loads(path.read_text())
        if isinstance(raw, dict):
            data = {str(k): str(v) for k, v in raw.items() if isinstance(v, str) and v}
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as exc:
        logger.warning("Could not read session proofs from %s: %s", path, exc)
    _cache[key] = data
    return data


def _save(path: Path, data: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".session_proofs.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(data, fh)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def issue(session_id: str) -> str:
    """Return the proof for ``session_id``, creating and persisting it once.

    Stable across respawns of the same session so a still-running MCP child
    of a previous PTY never ends up with a stale value.
    """
    path = _store_path()
    with _lock:
        data = _load(path)
        proof = data.get(session_id)
        if proof:
            return proof
        proof = secrets.token_hex(32)
        data[session_id] = proof
        try:
            _save(path, data)
        except OSError as exc:
            # Still enforce for this backend's lifetime; only a restart would
            # fall back to the legacy behaviour for this session.
            logger.warning("Could not persist session proof: %s", exc)
        return proof


def forget(session_id: str) -> None:
    path = _store_path()
    with _lock:
        data = _load(path)
        if data.pop(session_id, None) is not None:
            try:
                _save(path, data)
            except OSError as exc:
                logger.warning("Could not persist session proofs: %s", exc)


def check(session_id: str, presented: str | None) -> str:
    """OK, LEGACY (no proof issued for this session) or MISMATCH."""
    if not session_id:
        return MISMATCH
    with _lock:
        expected = _load(_store_path()).get(session_id)
    if not expected:
        if session_id not in _legacy_logged:
            _legacy_logged.add(session_id)
            logger.info(
                "Session %s has no hook proof (started before proofs existed or "
                "discovered externally); accepting its self-declared identity",
                session_id[:8],
            )
        return LEGACY
    if presented and hmac.compare_digest(
        expected.encode("utf-8"), str(presented).strip().encode("utf-8")
    ):
        return OK
    return MISMATCH


def check_request(request, session_id: str, *, header: str) -> str:
    return check(session_id, request.headers.get(header))
