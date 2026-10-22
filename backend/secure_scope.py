"""Secure-agent SCOPE — the signed authorization object for an offensive self-test run.

The scope is the single source of truth for a Secure run. It is the ONLY thing that authorizes
egress, and it drives two independent enforcement points (SECURE_AGENT_DESIGN.md):
  - the network clamp (secure_net): which IP(s)/port(s) the Kali box may reach — everything else,
    including the host Mac and the LAN, is dropped.
  - the Sonnet pre-exec check (secure_command_check): every command is judged against THIS scope.

Discipline (mirrors the §8 validation rule): a scope holds concrete, validated targets — never a
free-form "allow" string. `validate()` rejects host/loopback/multicast/broadcast/bad-port targets
by delegating to secure_net.validate_target, so a malformed or over-broad scope cannot be signed.

The scope HASH (sha256 over a canonical projection) is its identity: it threads into the network
clamp, the Sonnet check's cache key (so a verdict from one scope is never reused under another),
and the audit log. Change any target/port/window and the hash changes — by construction.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone, timedelta
from typing import Optional

logger = logging.getLogger(__name__)

_VALID_INTENSITIES = ("light", "normal", "aggressive")
_DEFAULT_TTL_MIN = 120  # a scope is good for 2h by default unless told otherwise


class SecureScopeError(ValueError):
    """Invalid scope. Fail-closed: an unvalidatable scope must never authorize a run."""


# ─── Target ────────────────────────────────────────────────────────────────

@dataclass
class SecureTarget:
    ip: str
    ports: list[int]
    hostname: Optional[str] = None   # informational only; the IP is what's enforced

    def to_dict(self) -> dict:
        d = {"ip": self.ip, "ports": sorted(set(int(p) for p in self.ports))}
        if self.hostname:
            d["hostname"] = self.hostname
        return d


# ─── Scope ─────────────────────────────────────────────────────────────────

@dataclass
class SecureScope:
    run_id: str
    targets: list[SecureTarget]
    allow_internet: bool = False         # Mode A (default): targets only, no general internet
    intensity: str = "normal"            # light | normal | aggressive (advisory; steers the prompt)
    rules_of_engagement: str = ""        # free text: what's in/out of bounds, do-not-touch, etc.
    created_by: str = ""                 # operator id / session that signed it
    created_at: str = ""                 # ISO8601 (UTC); set by sign()
    expires_at: str = ""                 # ISO8601 (UTC); set by sign()
    authorized: bool = False             # True only after an operator signs it
    notes: str = ""

    # ── construction ──
    @staticmethod
    def from_dict(d: dict) -> "SecureScope":
        if not isinstance(d, dict):
            raise SecureScopeError("scope must be an object")
        raw_targets = d.get("targets") or []
        if not isinstance(raw_targets, list):
            raise SecureScopeError("targets must be a list")
        targets = []
        for t in raw_targets:
            if not isinstance(t, dict):
                raise SecureScopeError("each target must be an object")
            ports = t.get("ports") or []
            if isinstance(ports, (int, str)):
                ports = [ports]
            targets.append(SecureTarget(
                ip=str(t.get("ip", "")).strip(),
                ports=list(ports),
                hostname=(str(t["hostname"]).strip() if t.get("hostname") else None),
            ))
        return SecureScope(
            run_id=str(d.get("run_id", "")).strip(),
            targets=targets,
            allow_internet=bool(d.get("allow_internet", False)),
            intensity=str(d.get("intensity", "normal")).strip().lower() or "normal",
            rules_of_engagement=str(d.get("rules_of_engagement", "") or ""),
            created_by=str(d.get("created_by", "") or ""),
            created_at=str(d.get("created_at", "") or ""),
            expires_at=str(d.get("expires_at", "") or ""),
            authorized=bool(d.get("authorized", False)),
            notes=str(d.get("notes", "") or ""),
        )

    def to_dict(self) -> dict:
        return {
            "run_id": self.run_id,
            "targets": [t.to_dict() for t in self.targets],
            "allow_internet": self.allow_internet,
            "intensity": self.intensity,
            "rules_of_engagement": self.rules_of_engagement,
            "created_by": self.created_by,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "authorized": self.authorized,
            "notes": self.notes,
            "scope_hash": self.scope_hash(),
        }

    # ── validation ──
    def validate(self) -> None:
        """Raise SecureScopeError unless the scope is concrete + safe. Delegates per-target IP/port
        checks to secure_net.validate_target (rejects host/loopback/multicast/broadcast/bad ports).
        We validate targets against a SYNTHETIC private network so the same reject-rules apply even
        before a real run subnet exists; the real subnet check happens again at provision time."""
        if not self.run_id:
            raise SecureScopeError("scope.run_id required")
        if self.intensity not in _VALID_INTENSITIES:
            raise SecureScopeError(f"intensity must be one of {_VALID_INTENSITIES}")
        if not self.targets:
            raise SecureScopeError("scope must declare at least one target")
        if len(self.targets) > 16:
            raise SecureScopeError("too many targets (max 16)")

        # Lazy import to avoid a hard cycle; secure_net imports nothing from us.
        try:
            from secure_net import validate_target as _vt, SecureNetError as _NetErr
        except Exception:  # pragma: no cover - secure_net should always be importable
            _vt, _NetErr = None, None

        synthetic = ipaddress.ip_network("10.255.255.0/24")
        seen = set()
        for t in self.targets:
            try:
                ip_obj = ipaddress.ip_address(t.ip)
            except ValueError as e:
                raise SecureScopeError(f"target ip invalid: {t.ip!r} ({e})")
            # loopback/multicast/unspecified/link-local are never legitimate targets
            if ip_obj.is_loopback or ip_obj.is_multicast or ip_obj.is_unspecified or ip_obj.is_link_local:
                raise SecureScopeError(f"target {t.ip} is a special/reserved address")
            key = str(ip_obj)
            if key in seen:
                raise SecureScopeError(f"duplicate target {t.ip}")
            seen.add(key)
            if _vt is not None:
                try:
                    _vt(t.ip, t.ports, inner_subnet=synthetic)
                except _NetErr as e:
                    # synthetic-subnet broadcast/network coincidences are not real errors; re-check
                    # only the port/format aspects by re-raising genuine ones.
                    msg = str(e)
                    if "network/broadcast" not in msg:
                        raise SecureScopeError(msg)
            else:
                if not t.ports or any(not (1 <= int(p) <= 65535) for p in t.ports):
                    raise SecureScopeError(f"target {t.ip} has invalid ports")

    # ── signing / authorization ──
    def sign(self, *, created_by: str = "", ttl_minutes: int = _DEFAULT_TTL_MIN,
             now: Optional[datetime] = None) -> "SecureScope":
        """Validate + stamp created/expires + mark authorized. Raises if invalid (fail-closed)."""
        self.validate()
        now = now or datetime.now(timezone.utc)
        self.created_by = created_by or self.created_by
        self.created_at = now.isoformat()
        self.expires_at = (now + timedelta(minutes=max(1, int(ttl_minutes)))).isoformat()
        self.authorized = True
        return self

    def is_expired(self, now: Optional[datetime] = None) -> bool:
        if not self.expires_at:
            return True
        try:
            exp = datetime.fromisoformat(self.expires_at)
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
        except ValueError:
            return True
        return (now or datetime.now(timezone.utc)) >= exp

    def is_active(self, now: Optional[datetime] = None) -> bool:
        return self.authorized and not self.is_expired(now)

    # ── identity / projections ──
    def canonical(self) -> dict:
        """Stable projection used for hashing — only the security-relevant fields, sorted."""
        return {
            "run_id": self.run_id,
            "targets": sorted(([t.ip, sorted(set(int(p) for p in t.ports))] for t in self.targets),
                              key=lambda x: x[0]),
            "allow_internet": self.allow_internet,
            "intensity": self.intensity,
            "roe": self.rules_of_engagement.strip(),
        }

    def scope_hash(self) -> str:
        payload = json.dumps(self.canonical(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode("utf-8", "replace")).hexdigest()

    def primary_target(self) -> SecureTarget:
        return self.targets[0]

    def all_target_ips(self) -> list[str]:
        return [t.ip for t in self.targets]

    def target_summary(self) -> str:
        """One-line human/LLM summary of what's in scope."""
        parts = []
        for t in self.targets:
            ports = ",".join(str(p) for p in sorted(set(int(p) for p in t.ports)))
            label = f"{t.hostname} ({t.ip})" if t.hostname else t.ip
            parts.append(f"{label}:[{ports}]")
        net = "internet-allowed" if self.allow_internet else "targets-only (no internet)"
        return f"{'; '.join(parts)} | {self.intensity} | {net}"


# ─── CLI (quick manual check) ─────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO)
    demo = SecureScope(
        run_id="demo1",
        targets=[SecureTarget(ip="192.168.64.10", ports=[80, 443], hostname="app.local")],
        rules_of_engagement="Web app only. No DoS. Stop on auth bypass.",
    )
    try:
        demo.sign(created_by="cli")
        print(json.dumps(demo.to_dict(), indent=2))
        print("summary:", demo.target_summary())
        print("hash:", demo.scope_hash())
    except SecureScopeError as e:
        print("INVALID:", e, file=sys.stderr)
        sys.exit(1)
