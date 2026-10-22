"""Native push for the IVE iPhone app (APNs, token-based auth).

Three pieces, all small:

* Config: the APNs auth key (.p8), its Key ID, the Team ID and the bundle id.
  The key lives in ``DATA_DIR/apns_key.p8`` and the ids in
  ``DATA_DIR/apns.json``, both written 0600. Neither the key nor the signed
  JWT is ever logged or returned by the API; status only says "configured"
  plus the Key ID.
* Tokens: each paired phone (``devices`` row) may register one APNs device
  token with its environment (sandbox for Xcode debug builds, production for
  TestFlight/App Store). Stored in ``DATA_DIR/apns_tokens.json`` (0600) keyed
  by device id, so no schema change. Revoking the device deletes the token;
  sending skips devices that are revoked or have no live session.
* Sending: ES256 JWT (header kid, claims iss/iat, cached ~50 min) and one
  HTTP/2 POST per token to api.push.apple.com / api.sandbox.push.apple.com.
  The transport is an interface. In the shipped venv there is no HTTP/2
  client library (no httpx[http2]/h2), so the default transport hands the
  request to the system curl (built with nghttp2 on macOS) via a config on
  stdin, which keeps the bearer token out of the process list. If httpx with
  h2 is importable it is used instead. Tests inject a fake transport.

410 Unregistered and 400 BadDeviceToken delete the token; 403 provider-token
errors drop the cached JWT so the next send signs a fresh one.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Protocol

logger = logging.getLogger(__name__)

DEFAULT_TEAM_ID = "66Y43UAY3C"
DEFAULT_BUNDLE_ID = "eu.aiforeu.ive"
HOSTS = {
    "production": "https://api.push.apple.com",
    "sandbox": "https://api.sandbox.push.apple.com",
}
ENVIRONMENTS = tuple(HOSTS)
JWT_MAX_AGE = 50 * 60  # Apple: refresh at most every 20 min, valid for 60.
_TOKEN_RE = re.compile(r"^[0-9a-fA-F]{32,200}$")
_KEY_ID_RE = re.compile(r"^[A-Z0-9]{10}$")
_TEAM_ID_RE = re.compile(r"^[A-Z0-9]{10}$")
_BUNDLE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.\-]{0,154}$")
# Tokens Apple says are dead for good.
_DEAD_REASONS = {"BadDeviceToken", "Unregistered", "ExpiredToken"}
_PROVIDER_TOKEN_REASONS = {"InvalidProviderToken", "ExpiredProviderToken", "MissingProviderToken"}


# ─── storage helpers ──────────────────────────────────────────────────


def _data_dir() -> Path:
    import db as _db
    return Path(_db.DATA_DIR)


def _config_path() -> Path:
    return _data_dir() / "apns.json"


def _key_path() -> Path:
    return _data_dir() / "apns_key.p8"


def _tokens_path() -> Path:
    return _data_dir() / "apns_tokens.json"


def _write_private(path: Path, data: str) -> None:
    """Atomic owner-only write (0600 from the first byte)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(data)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


# ─── config ───────────────────────────────────────────────────────────


class ApnsConfigError(ValueError):
    pass


@dataclass(frozen=True)
class ApnsConfig:
    key_pem: str
    key_id: str
    team_id: str
    bundle_id: str


def _load_private_key(pem: str):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    try:
        key = serialization.load_pem_private_key(pem.encode("utf-8"), password=None)
    except Exception as exc:  # never echo the key material
        raise ApnsConfigError("This is not a valid .p8 key file.") from exc
    if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
        raise ApnsConfigError("The .p8 key must be an APNs key (EC P-256).")
    return key


def load_config() -> Optional[ApnsConfig]:
    meta = _read_json(_config_path())
    try:
        pem = _key_path().read_text()
    except OSError:
        return None
    key_id = str(meta.get("key_id") or "")
    if not (pem.strip() and key_id):
        return None
    return ApnsConfig(
        key_pem=pem,
        key_id=key_id,
        team_id=str(meta.get("team_id") or DEFAULT_TEAM_ID),
        bundle_id=str(meta.get("bundle_id") or DEFAULT_BUNDLE_ID),
    )


def save_config(*, key_pem: Optional[str], key_id: str, team_id: str, bundle_id: str) -> dict:
    """Validate and store. ``key_pem=None`` keeps the stored key (ids only)."""
    key_id = (key_id or "").strip().upper()
    team_id = (team_id or DEFAULT_TEAM_ID).strip().upper()
    bundle_id = (bundle_id or DEFAULT_BUNDLE_ID).strip()
    if not _KEY_ID_RE.match(key_id):
        raise ApnsConfigError("Key ID is the 10-character id shown next to the key (e.g. AB12CD34EF).")
    if not _TEAM_ID_RE.match(team_id):
        raise ApnsConfigError("Team ID is 10 characters (e.g. 66Y43UAY3C).")
    if not _BUNDLE_RE.match(bundle_id):
        raise ApnsConfigError("Bundle ID looks wrong (e.g. eu.aiforeu.ive).")
    if key_pem is not None:
        pem = key_pem.strip()
        if len(pem) > 10_000:
            raise ApnsConfigError("This is not a valid .p8 key file.")
        _load_private_key(pem)
        _write_private(_key_path(), pem + "\n")
    elif not _key_path().exists():
        raise ApnsConfigError("Choose the .p8 key file.")
    _write_private(_config_path(), json.dumps(
        {"key_id": key_id, "team_id": team_id, "bundle_id": bundle_id, "updated_at": int(time.time())}
    ))
    _jwt_cache.clear()
    return public_status()


def clear_config() -> None:
    for p in (_key_path(), _config_path()):
        try:
            p.unlink()
        except FileNotFoundError:
            pass
    _jwt_cache.clear()


def public_status() -> dict:
    """Safe to show anywhere: never the key, never a JWT."""
    cfg = load_config()
    meta = _read_json(_config_path())
    return {
        "configured": cfg is not None,
        "key_id": cfg.key_id if cfg else (meta.get("key_id") or None),
        "team_id": cfg.team_id if cfg else DEFAULT_TEAM_ID,
        "bundle_id": cfg.bundle_id if cfg else DEFAULT_BUNDLE_ID,
        "transport": default_transport_name(),
    }


# ─── tokens ───────────────────────────────────────────────────────────


def _load_tokens() -> dict:
    data = _read_json(_tokens_path())
    return {k: v for k, v in data.items() if isinstance(v, dict) and v.get("token")}


def _save_tokens(tokens: dict) -> None:
    _write_private(_tokens_path(), json.dumps(tokens))


def validate_token(token: str | None, environment: str | None) -> tuple[str, str]:
    token = (token or "").strip()
    environment = (environment or "").strip().lower()
    if not _TOKEN_RE.match(token):
        raise ApnsConfigError("token must be the hex APNs device token")
    if environment not in ENVIRONMENTS:
        raise ApnsConfigError("environment must be sandbox or production")
    return token.lower(), environment


def register_token(device_id: str, token: str, environment: str, *, bundle_id: str | None = None,
                   model: str | None = None) -> dict:
    token, environment = validate_token(token, environment)
    tokens = _load_tokens()
    # One phone, one token: the same token on another device row (re-paired
    # phone) moves here.
    for other, entry in list(tokens.items()):
        if other != device_id and entry.get("token") == token:
            tokens.pop(other, None)
    prev = tokens.get(device_id) or {}
    entry = {
        "token": token,
        "environment": environment,
        "bundle_id": (bundle_id or "")[:155] or None,
        "model": (model or "")[:40] or None,
        "registered_at": prev.get("registered_at") if prev.get("token") == token else int(time.time()),
        "updated_at": int(time.time()),
        "last_result": prev.get("last_result") if prev.get("token") == token else None,
    }
    tokens[device_id] = entry
    _save_tokens(tokens)
    return entry


def remove_token(device_id: str) -> bool:
    tokens = _load_tokens()
    if tokens.pop(device_id, None) is None:
        return False
    _save_tokens(tokens)
    return True


def device_status(device_id: str) -> Optional[dict]:
    """Per-device status for the settings UI (token shortened)."""
    entry = _load_tokens().get(device_id)
    if not entry:
        return None
    return {
        "environment": entry.get("environment"),
        "registered_at": entry.get("registered_at"),
        "updated_at": entry.get("updated_at"),
        "token_tail": entry["token"][-6:],
        "last_result": entry.get("last_result"),
    }


def _record_result(device_id: str, token: str, result: dict) -> None:
    tokens = _load_tokens()
    entry = tokens.get(device_id)
    if not entry or entry.get("token") != token:
        return
    entry["last_result"] = {k: result.get(k) for k in ("ok", "status", "reason")} | {"at": int(time.time())}
    _save_tokens(tokens)


async def _live_device_ids() -> set[str]:
    """Devices that are not revoked and still have a live session."""
    import db as _db
    conn = await _db.get_db()
    try:
        cur = await conn.execute(
            """SELECT DISTINCT d.id FROM devices d
                 JOIN joiner_sessions js ON js.device_id = d.id
                WHERE d.revoked_at IS NULL AND js.revoked_at IS NULL
                  AND js.expires_at > datetime('now')"""
        )
        return {r["id"] for r in await cur.fetchall()}
    finally:
        await conn.close()


# ─── JWT ──────────────────────────────────────────────────────────────


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_jwt(cfg: ApnsConfig, *, now: Optional[int] = None) -> str:
    """ES256 provider token: {alg, kid} . {iss, iat} . raw r||s signature."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    key = _load_private_key(cfg.key_pem)
    header = _b64url(json.dumps({"alg": "ES256", "kid": cfg.key_id}, separators=(",", ":")).encode())
    claims = _b64url(json.dumps({"iss": cfg.team_id, "iat": int(now if now is not None else time.time())},
                                separators=(",", ":")).encode())
    signing_input = f"{header}.{claims}".encode("ascii")
    der = key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return f"{header}.{claims}.{_b64url(sig)}"


_jwt_cache: dict = {}


def _provider_token(cfg: ApnsConfig) -> str:
    cache_key = (cfg.key_id, cfg.team_id, hash(cfg.key_pem))
    hit = _jwt_cache.get(cache_key)
    if hit and time.time() - hit[1] < JWT_MAX_AGE:
        return hit[0]
    token = make_jwt(cfg)
    _jwt_cache.clear()
    _jwt_cache[cache_key] = (token, time.time())
    return token


# ─── transport ────────────────────────────────────────────────────────


@dataclass
class ApnsResponse:
    status: int
    body: bytes = b""


class ApnsTransport(Protocol):
    async def post(self, url: str, headers: dict[str, str], body: bytes) -> ApnsResponse: ...


class TransportUnavailable(RuntimeError):
    pass


def _curl_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t") + '"'


class CurlHttp2Transport:
    """HTTP/2 via the system curl. Secrets go through stdin (``-K -``)."""

    name = "curl"

    def __init__(self, curl: Optional[str] = None, timeout: float = 15.0) -> None:
        self.curl = curl or shutil.which("curl") or "/usr/bin/curl"
        self.timeout = timeout

    @staticmethod
    def available(curl: Optional[str] = None) -> bool:
        path = curl or shutil.which("curl")
        if not path:
            return False
        try:
            import subprocess
            out = subprocess.run([path, "-V"], capture_output=True, text=True, timeout=5).stdout
        except Exception:
            return False
        return "HTTP2" in out

    async def post(self, url: str, headers: dict[str, str], body: bytes) -> ApnsResponse:
        lines = [
            f"url = {_curl_quote(url)}",
            "http2",
            "silent",
            "show-error",
            f"max-time = {int(self.timeout)}",
            'request = "POST"',
            'write-out = "\\n%{http_code}"',
        ]
        for k, v in headers.items():
            lines.append(f"header = {_curl_quote(f'{k}: {v}')}")
        lines.append(f"data-binary = {_curl_quote(body.decode('utf-8'))}")
        config = ("\n".join(lines) + "\n").encode("utf-8")
        proc = await asyncio.create_subprocess_exec(
            self.curl, "-K", "-",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(config), timeout=self.timeout + 5)
        except asyncio.TimeoutError:
            proc.kill()
            raise TransportUnavailable("curl timed out")
        text = out.decode("utf-8", "replace")
        body_text, _, code = text.rpartition("\n")
        try:
            status = int(code.strip())
        except ValueError:
            status = 0
        if status == 0:
            # Connection-level failure; stderr has curl's reason (no secrets in it).
            raise TransportUnavailable((err.decode("utf-8", "replace").strip() or "no response")[:200])
        return ApnsResponse(status=status, body=body_text.encode("utf-8"))


class HttpxTransport:
    """Used only when httpx with HTTP/2 (h2) happens to be installed."""

    name = "httpx"

    def __init__(self, timeout: float = 15.0) -> None:
        import httpx  # noqa: F401
        import h2  # noqa: F401
        self.timeout = timeout

    async def post(self, url: str, headers: dict[str, str], body: bytes) -> ApnsResponse:
        import httpx
        async with httpx.AsyncClient(http2=True, timeout=self.timeout) as client:
            r = await client.post(url, headers=headers, content=body)
            return ApnsResponse(status=r.status_code, body=r.content)


_transport_override: Optional[ApnsTransport] = None


def set_transport(transport: Optional[ApnsTransport]) -> None:
    """Tests (and only tests) swap the transport."""
    global _transport_override
    _transport_override = transport


def default_transport_name() -> Optional[str]:
    if _transport_override is not None:
        return getattr(_transport_override, "name", "custom")
    try:
        import httpx  # noqa: F401
        import h2  # noqa: F401
        return "httpx"
    except ImportError:
        pass
    return "curl" if CurlHttp2Transport.available() else None


def _transport() -> ApnsTransport:
    if _transport_override is not None:
        return _transport_override
    name = default_transport_name()
    if name == "httpx":
        return HttpxTransport()
    if name == "curl":
        return CurlHttp2Transport()
    raise TransportUnavailable("No HTTP/2 client: install httpx[http2] or use a curl with HTTP2.")


def _base_url(environment: str) -> str:
    # Test hook for the e2e fake APNs server; never set in normal use.
    override = os.environ.get("IVE_APNS_TEST_ENDPOINT", "").strip().rstrip("/")
    return override or HOSTS[environment]


# ─── sending ──────────────────────────────────────────────────────────


def build_payload(*, title: str, body: str, path: Optional[str] = None,
                  thread: Optional[str] = None) -> dict:
    alert = {"title": title[:120], "body": body[:400]}
    aps: dict = {"alert": alert, "sound": "default"}
    if thread:
        aps["thread-id"] = thread[:64]
    payload: dict = {"aps": aps}
    if path:
        payload["path"] = path
    return payload


async def send_one(cfg: ApnsConfig, token: str, environment: str, payload: dict,
                   *, collapse_id: Optional[str] = None) -> dict:
    """One push. Returns {ok, status, reason, dead}."""
    headers = {
        "authorization": f"bearer {_provider_token(cfg)}",
        "apns-topic": cfg.bundle_id,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
    }
    if collapse_id:
        headers["apns-collapse-id"] = collapse_id.encode("utf-8")[:64].decode("utf-8", "ignore")
    url = f"{_base_url(environment)}/3/device/{token}"
    data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    try:
        resp = await _transport().post(url, headers, data)
    except TransportUnavailable as exc:
        return {"ok": False, "status": 0, "reason": str(exc), "dead": False}
    except Exception as exc:
        return {"ok": False, "status": 0, "reason": type(exc).__name__, "dead": False}
    reason = None
    if resp.status != 200:
        try:
            reason = json.loads(resp.body or b"{}").get("reason")
        except ValueError:
            reason = None
        reason = reason or f"HTTP {resp.status}"
    if reason in _PROVIDER_TOKEN_REASONS:
        _jwt_cache.clear()
    dead = resp.status == 410 or reason in _DEAD_REASONS
    return {"ok": resp.status == 200, "status": resp.status, "reason": reason, "dead": dead}


async def send_to_devices(*, title: str, body: str, path: Optional[str] = None,
                          tag: Optional[str] = None, device_ids: Optional[set[str]] = None) -> dict:
    """Fan out to every live paired phone with a token. Returns per-device results."""
    cfg = load_config()
    if cfg is None:
        return {"configured": False, "sent": 0, "results": {}}
    tokens = _load_tokens()
    if not tokens:
        return {"configured": True, "sent": 0, "results": {}}
    live = await _live_device_ids()
    targets = {d: e for d, e in tokens.items()
               if d in live and (device_ids is None or d in device_ids)}
    payload = build_payload(title=title, body=body, path=path, thread=tag.split(":", 1)[-1] if tag else None)

    async def one(device_id: str, entry: dict):
        return device_id, entry, await send_one(cfg, entry["token"], entry.get("environment") or "production",
                                                payload, collapse_id=tag)

    results = await asyncio.gather(*(one(d, e) for d, e in targets.items()))
    out: dict = {}
    sent = 0
    for device_id, entry, result in results:
        if result["dead"]:
            remove_token(device_id)
            logger.info("APNs token for device %s is gone (%s); removed", device_id[:8], result["reason"])
        else:
            _record_result(device_id, entry["token"], result)
            if not result["ok"]:
                logger.warning("APNs push failed for device %s: %s", device_id[:8], result["reason"])
        sent += 1 if result["ok"] else 0
        out[device_id] = {k: result[k] for k in ("ok", "status", "reason", "dead")}
    return {"configured": True, "sent": sent, "results": out}
