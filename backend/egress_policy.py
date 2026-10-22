"""Egress policy core + IVE allowlist-deriver (supply-chain defense).

This module powers *deny-default* egress gating for sandboxed agent runs.
It is PURE policy/enforcement logic + config generation — it never opens a
socket, runs an installer, or starts a proxy. The decisions it makes are fed
to a real egress proxy (generated via :func:`to_proxy_config`) or to a host
firewall by a separate enforcement layer.

Threat model (why this exists):
  • Supply-chain attacks: a compromised dependency or a prompt-injected agent
    tries to exfiltrate secrets to an attacker-controlled host, or pull a
    second-stage payload from an arbitrary URL.
  • Deny-default means: unless a host is on the derived allowlist (package
    registries, manifest-declared URLs, configured connectors), it is blocked.

Matching rules (see :meth:`EgressPolicy.decide`):
  • Exact host match  — ``api.example.com`` matches only ``api.example.com``.
  • Wildcard glob     — ``*.npmjs.org`` matches ``registry.npmjs.org`` and
    ``a.b.npmjs.org`` but NOT the bare apex ``npmjs.org`` and crucially NOT
    the suffix-bypass ``api.x.com.attacker.com`` (matching is anchored on
    DNS LABEL boundaries, not raw substring/suffix).
  • Optional port     — an entry ``host:port`` only matches that port; a
    bare ``host`` entry matches any port.

The deny-default posture is preserved everywhere: an empty/None config with
``default_deny=True`` blocks everything. Callers that want the legacy
"no policy configured => allow" behavior should not construct a policy at all
(the absence of a policy object is the signal to skip gating).
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from typing import Iterable

logger = logging.getLogger(__name__)


# Registry hosts that must always be reachable for a given ecosystem to
# install/build. Keyed by a coarse ecosystem name. Kept conservative — only
# the hosts a default install actually touches.
REGISTRY_HOSTS: dict[str, tuple[str, ...]] = {
    "npm": ("registry.npmjs.org",),
    "pypi": ("pypi.org", "files.pythonhosted.org"),
    "cargo": ("crates.io", "static.crates.io"),
    "go": ("proxy.golang.org", "sum.golang.org"),
    "rubygems": ("rubygems.org", "index.rubygems.org"),
    "maven": ("repo.maven.apache.org", "repo1.maven.org"),
}

# Filenames (lowercased basenames) that imply an ecosystem. Used by
# derive_from_project to decide which registry hosts to always-include.
_MANIFEST_ECOSYSTEM: dict[str, str] = {
    "package.json": "npm",
    "package-lock.json": "npm",
    "npm-shrinkwrap.json": "npm",
    "yarn.lock": "npm",
    "pnpm-lock.yaml": "npm",
    "requirements.txt": "pypi",
    "requirements.in": "pypi",
    "pyproject.toml": "pypi",
    "setup.py": "pypi",
    "setup.cfg": "pypi",
    "pipfile": "pypi",
    "pipfile.lock": "pypi",
    "poetry.lock": "pypi",
    "cargo.toml": "cargo",
    "cargo.lock": "cargo",
    "go.mod": "go",
    "go.sum": "go",
    "gemfile": "rubygems",
    "gemfile.lock": "rubygems",
    "pom.xml": "maven",
    "build.gradle": "maven",
    "build.gradle.kts": "maven",
}

# Parse a registry/index URL from a SPECIFIC trusted field (e.g.
# package.json publishConfig.registry, .npmrc registry=, pip --index-url).
# This is applied ONLY to values pulled from those known-safe fields — never
# to free-form manifest text — and it STRIPS any userinfo before taking the
# host so that "https://registry.npmjs.org@attacker.evil.com" yields
# "attacker.evil.com" only via the host group (which we then validate). We
# deliberately capture host[:port] AFTER an optional userinfo so the real
# authority host is taken, not the userinfo label.
_REGISTRY_URL_RE = re.compile(
    r"""(?ix)
    ^\s*
    (?:https?://)?          # optional scheme
    (?:[^/@\s]+@)?          # optional userinfo (STRIPPED — never used as host)
    (?P<host>
        (?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+   # at least one dotted label
        [a-z]{2,}                                  # TLD
    )
    (?::(?P<port>\d{1,5}))? # optional :port
    (?:[/?\#].*)?           # optional path/query/fragment
    \s*$
    """,
)

# A DNS label: 1-63 chars, alnum + hyphen, no leading/trailing hyphen. We are
# lenient on length here (the proxy enforces real DNS rules); the point is the
# label *boundary*, not strict RFC validation.
_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?"


def _split_host_port(entry: str) -> tuple[str, int | None]:
    """Split ``host`` or ``host:port`` into (host, port|None).

    Lowercases the host. Strips a leading scheme and trailing path if a full
    URL is passed by mistake. Returns (``""``, None) for empty input.
    """
    if not entry:
        return "", None
    s = entry.strip()
    # Drop scheme if present.
    if "://" in s:
        s = s.split("://", 1)[1]
    # Drop any path/query.
    s = s.split("/", 1)[0]
    s = s.split("?", 1)[0]
    # IPv6 in brackets — keep as-is (no port split inside brackets).
    if s.startswith("["):
        host, _, rest = s.partition("]")
        host = host + "]"
        port = None
        if rest.startswith(":") and rest[1:].isdigit():
            port = int(rest[1:])
        return host.lower(), port
    host = s
    port: int | None = None
    if ":" in s:
        maybe_host, _, maybe_port = s.rpartition(":")
        if maybe_port.isdigit():
            host, port = maybe_host, int(maybe_port)
    return host.lower(), port


def _host_matches(pattern_host: str, host: str) -> bool:
    """True if ``host`` matches ``pattern_host`` on DNS label boundaries.

    Exact match is case-insensitive. A ``*.`` prefix is a wildcard over one
    or more leading labels — anchored so it cannot be bypassed by appending
    an attacker-controlled suffix.

    Examples::

        _host_matches("api.example.com", "api.example.com")        -> True
        _host_matches("api.example.com", "api.example.com.evil.io") -> False
        _host_matches("*.npmjs.org",     "registry.npmjs.org")      -> True
        _host_matches("*.npmjs.org",     "a.b.npmjs.org")           -> True
        _host_matches("*.npmjs.org",     "npmjs.org")               -> False
        _host_matches("*.npmjs.org",     "npmjs.org.attacker.com")  -> False
    """
    pattern_host = (pattern_host or "").lower().strip(".")
    host = (host or "").lower().strip(".")
    if not pattern_host or not host:
        return False

    if pattern_host.startswith("*."):
        # Suffix after the wildcard, e.g. "npmjs.org". The host must end with
        # ".npmjs.org" exactly (>=1 extra label in front). We build an
        # anchored regex so "npmjs.org.attacker.com" cannot match.
        suffix = pattern_host[2:]
        if not suffix:
            return False
        regex = r"^(?:" + _LABEL + r"\.)+" + re.escape(suffix) + r"$"
        return re.match(regex, host) is not None

    # No wildcard => exact, case-insensitive match. (We already lowered both.)
    return pattern_host == host


@dataclass
class EgressPolicy:
    """A deny-default egress allow/deny decision engine.

    Entries may be:
      • a bare host           — ``"registry.npmjs.org"`` (any port)
      • a host:port           — ``"example.com:443"`` (that port only)
      • a wildcard domain     — ``"*.npmjs.org"`` (any subdomain, any port)
      • a wildcard host:port   — ``"*.npmjs.org:443"`` (any subdomain, port 443)

    ``blocked`` entries take precedence over ``allowed`` (an explicit block
    always wins). With ``default_deny=True`` (the default) anything not on the
    allowlist is denied.
    """

    allowed: list[str] = field(default_factory=list)
    blocked: list[str] = field(default_factory=list)
    default_deny: bool = True

    def __post_init__(self) -> None:
        # Normalize: dedupe while preserving order, drop empties/whitespace.
        self.allowed = _dedupe([e.strip() for e in (self.allowed or []) if e and e.strip()])
        self.blocked = _dedupe([e.strip() for e in (self.blocked or []) if e and e.strip()])

    # ── decision ────────────────────────────────────────────────────────
    def decide(self, host: str, port: int | None = None) -> tuple[bool, str]:
        """Return (allow, reason) for a connection to ``host`` (optional port).

        Order of evaluation:
          1. Malformed/empty host           -> deny.
          2. Explicit block match           -> deny (block always wins).
          3. Allow match                    -> allow.
          4. default_deny=True              -> deny.
          5. default_deny=False             -> allow (allow-by-default mode).
        """
        host_norm, host_port = _split_host_port(host or "")
        if host_port is not None and port is None:
            port = host_port
        if not host_norm:
            return False, "deny: empty or malformed host"

        # 2. Explicit block wins.
        for entry in self.blocked:
            if self._entry_matches(entry, host_norm, port):
                return False, f"deny: blocked by rule {entry!r}"

        # 3. Allowlist.
        for entry in self.allowed:
            if self._entry_matches(entry, host_norm, port):
                return True, f"allow: matched rule {entry!r}"

        # 4 / 5. Default posture.
        if self.default_deny:
            return False, f"deny: {host_norm!r} not on allowlist (deny-default)"
        return True, f"allow: {host_norm!r} (default-allow, no rule matched)"

    def _entry_matches(self, entry: str, host: str, port: int | None) -> bool:
        """Does a single allow/block ``entry`` match (host, port)?"""
        ent_host, ent_port = _split_host_port(entry)
        if not _host_matches(ent_host, host):
            return False
        # Port semantics: an entry without a port matches any port. An entry
        # WITH a port matches only that port. A request without a port (None)
        # is treated as "any port" and matches a port-scoped entry too — the
        # host gate is the security boundary; port is a refinement.
        if ent_port is None:
            return True
        if port is None:
            return True
        return ent_port == port

    # ── construction helpers ────────────────────────────────────────────
    def to_dict(self) -> dict:
        return {
            "allowed": list(self.allowed),
            "blocked": list(self.blocked),
            "default_deny": self.default_deny,
        }


def _dedupe(items: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for it in items:
        key = it.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out


# ── Generic allow/deny network policy adapter ─────────────────────────────
def from_boundary(boundary_config: dict | None) -> EgressPolicy:
    """Build an :class:`EgressPolicy` from an allow/deny network-policy dict.

    Expected (lenient) shape::

        {
            "allowed_domains": ["*.npmjs.org", "github.com", ...],
            "blocked_domains": ["evil.example.com", ...],
            "default_deny": true,         # optional, defaults True
        }

    Aliases accepted for resilience across versions: ``allow``/``allowed`` /
    ``allowed_hosts`` for the allowlist, ``block``/``blocked`` /
    ``blocked_hosts`` for the blocklist. Anything else is ignored.
    A None/empty config yields a deny-default policy with no allowlist
    (i.e. block everything) — the safe default.
    """
    cfg = boundary_config or {}

    def _collect(*keys: str) -> list[str]:
        out: list[str] = []
        for k in keys:
            v = cfg.get(k)
            if v is None:
                continue
            if isinstance(v, str):
                out.append(v)
            elif isinstance(v, (list, tuple, set)):
                out.extend(str(x) for x in v)
        return out

    allowed = _collect("allowed_domains", "allowed_hosts", "allowed", "allow")
    blocked = _collect("blocked_domains", "blocked_hosts", "blocked", "block")
    default_deny = bool(cfg.get("default_deny", True))
    return EgressPolicy(allowed=allowed, blocked=blocked, default_deny=default_deny)


# ── derive_from_project: the IVE allowlist-deriver ──────────────────────────
def derive_from_project(
    manifests: dict[str, str | dict] | None,
    connector_hosts: Iterable[str] | None = None,
    *,
    extra_registries: Iterable[str] | None = None,
) -> EgressPolicy:
    """Derive a deny-default egress allowlist from project manifest CONTENTS.

    ``manifests`` maps a manifest filename (e.g. ``"package.json"``,
    ``"requirements.txt"``, ``"pyproject.toml"``, a lockfile name, or even a
    full path whose basename is one of those) to its CONTENTS. Contents may
    be a raw string OR a pre-parsed dict (for package.json). NOTHING is read
    from disk and NO installer/network call is made — the caller supplies the
    bytes.

    Derivation (SUPPLY-CHAIN HARDENED — no free-text URL scanning):
      1. For each manifest present, always-include that ecosystem's package
         registry hosts (npm -> registry.npmjs.org; pypi -> pypi.org +
         files.pythonhosted.org; etc.).
      2. Extract custom registry/index hosts from SPECIFIC TRUSTED FIELDS only
         (package.json ``publishConfig.registry``, ``.npmrc`` ``registry=`` /
         ``@scope:registry=`` lines, pip ``--index-url`` / ``--extra-index-url``
         / ``index-url =`` / ``extra-index-url =``). Any userinfo is STRIPPED
         and only the authority hostname is taken. We DO NOT scan descriptions,
         author emails, repository/homepage fields, comments, or any other free
         text — a malicious transitive dependency cannot open an egress hole.
      3. Add any ``connector_hosts`` (configured integrations the run needs).
      4. ``extra_registries`` (optional) are added verbatim.

    Everything else is denied (``default_deny=True``).
    """
    manifests = manifests or {}
    allowed: list[str] = []

    ecosystems: set[str] = set()
    for name, content in manifests.items():
        base = _basename(name).lower()
        eco = _MANIFEST_ECOSYSTEM.get(base)
        if eco:
            ecosystems.add(eco)
        # Pull custom registry/index hosts from trusted fields ONLY (keyed by
        # manifest type). Free-form text is never scanned.
        allowed.extend(_extract_registry_hosts(base, content))

    # 1. Always-include registry hosts for detected ecosystems.
    for eco in sorted(ecosystems):
        allowed.extend(REGISTRY_HOSTS.get(eco, ()))

    # 3. Connector hosts.
    for ch in connector_hosts or []:
        h, _ = _split_host_port(str(ch))
        if h:
            # Preserve a port if the connector specified one.
            allowed.append(str(ch).strip())

    # 4. Verbatim extras.
    for r in extra_registries or []:
        if r and str(r).strip():
            allowed.append(str(r).strip())

    return EgressPolicy(allowed=allowed, blocked=[], default_deny=True)


def _basename(path: str) -> str:
    p = str(path).replace("\\", "/")
    return p.rsplit("/", 1)[-1] if "/" in p else p


def _host_from_registry_url(value: str) -> str | None:
    """Parse one registry/index URL value -> ``host`` or ``host:port``.

    Userinfo is STRIPPED (never used as the host). Returns None if the value
    does not parse to a dotted hostname or is an obvious placeholder. This is
    the ONLY URL-parsing path in the deriver and it is fed exclusively from
    known-safe fields (see :func:`_extract_registry_hosts`).
    """
    if not value:
        return None
    m = _REGISTRY_URL_RE.match(str(value).strip())
    if not m:
        return None
    host = (m.group("host") or "").lower()
    port = m.group("port")
    if not host:
        return None
    if host in ("example.com", "example.org", "localhost"):
        return None
    return f"{host}:{port}" if port else host


def _extract_registry_hosts(manifest_base: str, content: str | dict | None) -> list[str]:
    """Extract custom registry/index hosts from TRUSTED fields only.

    No free-form text is scanned — only fields known to declare a registry or
    package index for the manifest type are consulted, and each is parsed with
    userinfo stripped. A malicious description / author email / repository
    field / comment therefore CANNOT inject an allowed host.

    Recognized sources:
      • package.json (dict or JSON string): ``publishConfig.registry`` and
        any ``publishConfig["@scope:registry"]`` entries.
      • .npmrc-style lines (also accepted inside package.json is NOT done):
        ``registry=...`` and ``@scope:registry=...``.
      • pip/requirements/pyproject/pip.conf: ``--index-url`` /
        ``--extra-index-url`` flags and ``index-url =`` / ``extra-index-url =``
        config keys.
    """
    hosts: list[str] = []
    if content is None:
        return hosts

    # ── npm: publishConfig.registry from parsed/JSON package.json ──────────
    parsed: dict | None = None
    if isinstance(content, dict):
        parsed = content
    elif manifest_base == "package.json" and isinstance(content, str):
        try:
            maybe = json.loads(content)
            if isinstance(maybe, dict):
                parsed = maybe
        except (ValueError, TypeError):
            parsed = None

    if isinstance(parsed, dict):
        pub = parsed.get("publishConfig")
        if isinstance(pub, dict):
            for key, val in pub.items():
                # registry, and any "@scope:registry" key
                if key == "registry" or (
                    isinstance(key, str) and key.endswith(":registry")
                ):
                    if isinstance(val, str):
                        h = _host_from_registry_url(val)
                        if h:
                            hosts.append(h)

    # ── text-line sources: .npmrc, requirements.txt, pip.conf, pyproject ──
    text: str | None = None
    if isinstance(content, str):
        text = content
    if text is not None:
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or line.startswith(";"):
                continue
            tokens = _registry_url_tokens(line)
            for tok in tokens:
                h = _host_from_registry_url(tok)
                if h:
                    hosts.append(h)
    return hosts


# Trusted config keys whose VALUE is a registry/index URL. Matched
# case-insensitively at the start of a config line (``key = value`` or
# ``key value`` or ``key: value``), or as a CLI flag (``--key value`` /
# ``--key=value``).
_REGISTRY_KEYS: tuple[str, ...] = (
    "index-url",
    "extra-index-url",
    "registry",
)
_REGISTRY_KEY_RE = re.compile(
    r"""(?ix)
    ^
    (?:--)?                                 # optional CLI dashes
    (?:@[a-z0-9._-]+:)?                      # optional @scope: prefix (npm)
    (?P<key>index-url|extra-index-url|registry)
    \s*[=:\ ]\s*                            # =, :, or whitespace separator
    (?P<val>\S.*)
    $
    """,
)


def _registry_url_tokens(line: str) -> list[str]:
    """Return registry/index URL value(s) declared on a single config line.

    Only lines whose key is a recognized registry/index key yield a value.
    All other lines (deps, comments, descriptions) yield nothing.
    """
    m = _REGISTRY_KEY_RE.match(line.strip())
    if not m:
        return []
    val = m.group("val").strip().strip('"').strip("'")
    # Take only the first whitespace-delimited token of the value (a URL has
    # no spaces; trailing tokens are unrelated).
    val = val.split()[0] if val.split() else ""
    return [val] if val else []


# ── to_proxy_config: generate a deny-default proxy allowlist ─────────────────
def to_proxy_config(policy: EgressPolicy, fmt: str = "tinyproxy") -> str:
    """Render ``policy`` as a deny-default config for a real egress proxy.

    Supported ``fmt`` values:
      • ``"tinyproxy"`` — a tinyproxy Filter file (default-deny filter list).
        Tinyproxy with ``FilterDefaultDeny Yes`` blocks everything not matched
        by an Allow line; we emit anchored regex Allow lines per allowed host.
      • ``"json"``      — a simple JSON document a custom proxy can consume,
        with explicit ``default``/``allow``/``deny`` sections.
      • ``"squid"``     — a Squid ACL fragment (dstdomain ACLs + a final deny).

    Generation ONLY — this never starts or contacts a proxy.
    """
    fmt = (fmt or "tinyproxy").lower()
    if fmt == "json":
        return _to_json_config(policy)
    if fmt == "squid":
        return _to_squid_config(policy)
    if fmt == "tinyproxy":
        return _to_tinyproxy_config(policy)
    raise ValueError(f"unknown proxy config format: {fmt!r}")


def _host_regex_body(host: str) -> str:
    """Anchored (no ^/$) regex BODY matching ``host`` on label boundaries.

    Mirrors :func:`_host_matches`: a ``*.`` prefix requires >=1 leading label
    (so the apex is NOT matched), an exact host matches only itself.
    """
    host = host.strip(".")
    if host.startswith("*."):
        suffix = host[2:]
        return r"(?:" + _LABEL + r"\.)+" + re.escape(suffix)
    return re.escape(host)


def _filter_regex_for(entry: str) -> str:
    """Anchored regex matching one allow entry on label boundaries.

    Mirrors :meth:`EgressPolicy.decide`:
      • ``*.glob`` requires at least one leading label (apex is NOT matched).
      • A port-scoped entry (``host:port``) includes the port so the proxy
        does not allow other ports the policy would deny. A bare host matches
        any port (an optional ``:port`` suffix is permitted but not required).
    """
    host, port = _split_host_port(entry)
    body = _host_regex_body(host)
    if port is not None:
        # Port-scoped: the host must be followed by exactly ``:port``.
        return r"^" + body + r":" + re.escape(str(port)) + r"$"
    # Bare host: match the host with or without any trailing :port.
    return r"^" + body + r"(?::\d{1,5})?$"


def _spaces_overlap(a_host: str, b_host: str) -> bool:
    """True if the host-spaces of two patterns (concrete or ``*.x``) intersect.

    Tested BIDIRECTIONALLY so a WILDCARD block (``*.S``) is caught even when the
    overlapping allow is itself a wildcard (e.g. block ``*.exfil.example.com``
    under allow ``*.example.com``). A representative host under each ``*.x``
    pattern probes that pattern's space; each pattern is then matched against the
    other's representative using the same matcher ``decide()`` uses.
    """
    def _rep(h: str) -> str:
        return ("ovlprobe." + h[2:]) if h.startswith("*.") else h
    ra, rb = _rep(a_host), _rep(b_host)
    return _host_matches(a_host, rb) or _host_matches(b_host, ra)


def _blocked_under_allow(policy: EgressPolicy) -> list[tuple[str, str]]:
    """Find blocked entries that would be matched by an allow pattern.

    Returns a list of ``(blocked_entry, allowed_entry)`` pairs where the
    blocked host falls UNDER an allow rule (e.g. blocked
    ``attacker-bucket.s3.amazonaws.com`` under allowed ``*.amazonaws.com``).
    Uses the same host/port matching as :meth:`EgressPolicy.decide`, so the
    answer is exactly "does block-within-allow occur for this policy".
    """
    overlaps: list[tuple[str, str]] = []
    for b_entry in policy.blocked:
        b_host, b_port = _split_host_port(b_entry)
        if not b_host:
            continue
        for a_entry in policy.allowed:
            a_host, a_port = _split_host_port(a_entry)
            # Overlap if the allow + block host-spaces intersect. Bidirectional
            # so a WILDCARD block under a wildcard/concrete allow is caught too
            # (the prior code skipped `*.` blocks → a wildcard block under a
            # wildcard allow slipped through and tinyproxy allowed it).
            if not _spaces_overlap(a_host, b_host):
                continue
            # Port semantics mirror _entry_matches: an allow without a port
            # covers all ports; with a port it only covers that port. A
            # blocked entry without a port denies all ports -> any allow on
            # this host is an overlap.
            if a_port is None or b_port is None or a_port == b_port:
                overlaps.append((b_entry, a_entry))
                break
    return overlaps


def _to_tinyproxy_config(policy: EgressPolicy) -> str:
    # FAIL-CLOSED: tinyproxy's single FilterDefaultDeny file cannot express
    # "deny within an allowed wildcard" — a blocked host that matches an Allow
    # line would be ALLOWED by the proxy (looser than decide(), which denies
    # it because block always wins). Rather than silently emit a config that
    # violates the policy, refuse to generate it. (Blocked hosts that match NO
    # allow line are already denied by FilterDefaultDeny — that is fine.)
    overlaps = _blocked_under_allow(policy)
    if overlaps:
        b_entry, a_entry = overlaps[0]
        raise ValueError(
            "cannot emit tinyproxy config: blocked host "
            f"{b_entry!r} matches allow rule {a_entry!r}; tinyproxy's "
            "FilterDefaultDeny cannot express deny-within-allow ('block "
            "always wins'). Use the 'squid' or 'json' format, which honor "
            "explicit blocks."
        )
    lines = [
        "# tinyproxy egress allowlist (DENY-DEFAULT) — generated by",
        "# backend/egress_policy.py. Do NOT edit by hand.",
        "#",
        "# Use with tinyproxy.conf:",
        "#   FilterDefaultDeny Yes",
        "#   FilterExtended    On",
        "#   FilterCaseSensitive Off",
        "#   Filter \"/path/to/this/file\"",
        "#",
        "# Each non-comment line is an extended (regex) Filter rule. With",
        "# FilterDefaultDeny Yes, a request is DENIED unless its host matches",
        "# one of these anchored Allow patterns. Suffix-bypass hosts like",
        "# 'api.x.com.attacker.com' do NOT match '*.x.com' (label-anchored).",
        f"# default_deny={policy.default_deny}",
        "",
    ]
    if not policy.allowed:
        lines.append("# (no allowed hosts — egress fully blocked)")
    for entry in policy.allowed:
        lines.append(f"# allow {entry}")
        lines.append(_filter_regex_for(entry))
    if policy.blocked:
        lines.append("")
        lines.append("# NOTE: the following hosts are explicitly blocked. With")
        lines.append("# FilterDefaultDeny Yes they are already denied unless they")
        lines.append("# would otherwise match an Allow line above; listed for audit:")
        for entry in policy.blocked:
            lines.append(f"#   blocked {entry}")
    return "\n".join(lines) + "\n"


def _to_squid_config(policy: EgressPolicy) -> str:
    """Render ``policy`` as a Squid ACL fragment that mirrors ``decide()``.

    We use ``dstdom_regex`` (anchored, label-boundary) rather than
    ``dstdomain`` so a ``*.glob`` rule does NOT match the apex — Squid's
    ``dstdomain .x.com`` would wrongly allow the apex ``x.com`` that
    :meth:`EgressPolicy.decide` denies. Port-scoped entries get a companion
    ``acl ... port`` so the allow only fires on that port.
    """
    lines = [
        "# Squid egress ACL fragment (DENY-DEFAULT) — generated by",
        "# backend/egress_policy.py. Do NOT edit by hand.",
        "# dstdom_regex is used (not dstdomain) so '*.x.com' does NOT match the",
        "# apex 'x.com' — mirroring EgressPolicy.decide()'s label semantics.",
        f"# default_deny={policy.default_deny}",
        "",
    ]
    # ── block ACLs (host regex, optional port) ────────────────────────────
    for i, entry in enumerate(policy.blocked):
        host, port = _split_host_port(entry)
        lines.append(f"acl egress_block_{i} dstdom_regex {_squid_regex(host)}")
        if port is not None:
            lines.append(f"acl egress_block_{i}_port port {port}")
    # ── allow ACLs (host regex, optional port) ────────────────────────────
    for i, entry in enumerate(policy.allowed):
        host, port = _split_host_port(entry)
        lines.append(f"acl egress_allow_{i} dstdom_regex {_squid_regex(host)}")
        if port is not None:
            lines.append(f"acl egress_allow_{i}_port port {port}")
    lines.append("")
    for i, entry in enumerate(policy.blocked):
        _, port = _split_host_port(entry)
        if port is not None:
            lines.append(f"http_access deny egress_block_{i} egress_block_{i}_port")
        else:
            lines.append(f"http_access deny egress_block_{i}")
    for i, entry in enumerate(policy.allowed):
        _, port = _split_host_port(entry)
        if port is not None:
            lines.append(f"http_access allow egress_allow_{i} egress_allow_{i}_port")
        else:
            lines.append(f"http_access allow egress_allow_{i}")
    lines.append("http_access deny all   # deny-default: nothing else gets out")
    return "\n".join(lines) + "\n"


def _squid_regex(host: str) -> str:
    """Anchored dstdom_regex body for a host, mirroring decide()'s semantics.

    A ``*.glob`` requires >=1 leading label (apex NOT matched); an exact host
    matches only itself. (Squid matches dstdom_regex against the host only, so
    port is enforced by a companion ``acl ... port``.)
    """
    return _host_regex_body(host).join(("^", "$"))


def _to_json_config(policy: EgressPolicy) -> str:
    doc = {
        "_comment": (
            "Deny-default egress allowlist generated by "
            "backend/egress_policy.py — do not edit by hand."
        ),
        "default": "deny" if policy.default_deny else "allow",
        "allow": list(policy.allowed),
        "deny": list(policy.blocked),
    }
    return json.dumps(doc, indent=2) + "\n"


# ════════════════════════════════════════════════════════════════════════════
# PROXY-START PATH (additive, OFF by default, NO auto-install, FAIL-CLOSED)
# ════════════════════════════════════════════════════════════════════════════
# Everything above this line is PURE policy + config GENERATION (it never opens
# a socket / starts a process). The section below is the ENFORCEMENT layer: it
# takes a generated config (to_proxy_config) and starts a real egress proxy
# bound to loopback, so the deny-default allowlist is actually enforced for a
# sandboxed run.
#
# Master gate: EGRESS_PROXY_ENFORCE (default OFF) — with it unset, nothing here
# changes existing behaviour. We NEVER install a proxy binary; detection is
# shutil.which only. When a caller demands egress control (``require=True``) and
# no proxy binary is present, we FAIL CLOSED: raise EgressUnavailable so the
# caller denies networked execution rather than silently granting open egress.

# config-format -> candidate executable names (looked up via shutil.which only).
PROXY_BINARIES: dict[str, tuple[str, ...]] = {
    "tinyproxy": ("tinyproxy",),
    "squid": ("squid",),
    "mitmproxy": ("mitmdump",),
}

# Priority order when no explicit kind is requested. tinyproxy is the lightest
# allowlist filter; squid honours explicit blocks (deny-within-allow); mitmproxy
# is detected but intentionally NOT wired in v1 (see start_egress_proxy).
_PROXY_PRIORITY: tuple[str, ...] = ("tinyproxy", "squid", "mitmproxy")

_TRUE_SET = {"1", "true", "yes", "on"}


def is_egress_enforced() -> bool:
    """True only when EGRESS_PROXY_ENFORCE (or its alias EGRESS_ENFORCE) is truthy.

    DEFAULT FALSE => unchanged behaviour for every caller. Both flag names are
    honoured so config.py's advertised "either name enables it" actually holds —
    a security flag must never silently no-op when set via the documented alias.
    """
    return (
        os.environ.get("EGRESS_PROXY_ENFORCE", "").strip().lower() in _TRUE_SET
        or os.environ.get("EGRESS_ENFORCE", "").strip().lower() in _TRUE_SET
    )


def detect_proxy(prefer: str | None = None) -> tuple[str | None, str | None]:
    """Locate a proxy binary WITHOUT installing anything.

    Returns ``(fmt, abs_path)`` for the first available proxy, or ``(None, None)``
    if none is found. Honours an explicit ``EGRESS_PROXY_BIN`` absolute-path
    override (paired with the requested/EGRESS_PROXY_KIND format). ``prefer``
    pins a specific format; otherwise the configured EGRESS_PROXY_KIND, then the
    default priority order, is searched. NEVER calls pip/brew/apt — shutil.which
    only.
    """
    kind = (prefer or os.environ.get("EGRESS_PROXY_KIND") or "").strip().lower() or None

    # Explicit absolute-path override (still no install — the operator points us
    # at an already-present binary).
    override = os.environ.get("EGRESS_PROXY_BIN", "").strip()
    if override:
        fmt = kind or "tinyproxy"
        if os.path.isfile(override) and os.access(override, os.X_OK):
            return fmt, override

    order: tuple[str, ...]
    if kind and kind in PROXY_BINARIES:
        order = (kind,)
    elif kind:
        # Unknown kind requested -> nothing matches (caller fails closed).
        return None, None
    else:
        order = _PROXY_PRIORITY

    for fmt in order:
        for exe in PROXY_BINARIES.get(fmt, ()):  # candidate executable names
            path = shutil.which(exe)
            if path:
                return fmt, path
    return None, None


@dataclass
class EgressProxyHandle:
    """Live handle to a started egress proxy (loopback-bound)."""

    pid: int
    port: int
    fmt: str
    config_path: str
    address: str          # e.g. "http://127.0.0.1:8123"
    work_dir: str | None = None
    _proc: subprocess.Popen | None = None


class EgressUnavailable(Exception):
    """Raised when egress control is REQUIRED but cannot be provided.

    Carries a machine-readable ``reason`` so the caller can deny networked
    execution and surface a clear cause:
      • ``no_proxy_binary``            — no tinyproxy/squid/mitmdump on PATH.
      • ``unsupported_proxy_kind``     — kind detected but not wired (mitmproxy).
      • ``policy_requires_egress_control`` — config generation refused (overlap).
      • ``spawn_failed``               — proxy launched but never bound / died.
    """

    def __init__(self, reason: str, message: str | None = None):
        self.reason = reason
        super().__init__(message or reason)


def _free_loopback_port() -> int:
    """Pick an ephemeral free loopback TCP port (bind :0, read it back)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _wait_listen(port: int, proc: subprocess.Popen, timeout: float = 2.0) -> bool:
    """Poll until ``port`` accepts a loopback connection or ``proc`` dies."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return False  # process exited before binding
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.15)
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    return True
        except OSError:
            pass
        time.sleep(0.05)
    return False


def _full_tinyproxy_conf(filter_path: str, port: int) -> str:
    """Wrap a generated tinyproxy FILTER FRAGMENT into a complete tinyproxy.conf.

    to_proxy_config('tinyproxy') emits a Filter file (allow regexes), not a
    standalone config. tinyproxy needs a real conf with Port/Listen + the
    FilterDefaultDeny directives pointing at that filter file.
    """
    return "\n".join([
        "# Auto-generated by egress_policy.start_egress_proxy — do not edit.",
        f"Port {port}",
        "Listen 127.0.0.1",
        "Timeout 600",
        "FilterDefaultDeny Yes",
        "FilterExtended On",
        "FilterCaseSensitive Off",
        f'Filter "{filter_path}"',
        "",
    ])


def _full_squid_conf(acl_path: str, port: int) -> str:
    """Wrap a generated squid ACL FRAGMENT into a minimal complete squid.conf."""
    return "\n".join([
        "# Auto-generated by egress_policy.start_egress_proxy — do not edit.",
        f"http_port 127.0.0.1:{port}",
        f'include "{acl_path}"',
        "",
    ])


def start_egress_proxy(
    policy: EgressPolicy,
    *,
    require: bool,
    kind: str | None = None,
    port: int | None = None,
    work_dir: str | None = None,
) -> EgressProxyHandle | None:
    """Start a loopback egress proxy enforcing ``policy`` (deny-default allowlist).

    Contract:
      • If not is_egress_enforced() and not ``require``: return None (no proxy
        layer was asked for — caller proceeds on its existing path).
      • Detect a proxy binary (shutil.which only — NEVER installs). If absent:
          - ``require`` True  -> FAIL CLOSED: raise EgressUnavailable
            ('no_proxy_binary'); the caller MUST deny networked execution.
          - ``require`` False -> log + return None (degrade to the caller's
            non-networked path; never silently grant open egress).
      • If present: render to_proxy_config to a temp file, wrap it into a
        complete conf, Popen the binary bound to 127.0.0.1, poll up to ~2s for
        the listen port. On failure: terminate, and raise EgressUnavailable
        ('spawn_failed') when ``require`` else return None.

    Returns an EgressProxyHandle on success (or None on the degrade paths).
    """
    if not is_egress_enforced() and not require:
        return None

    fmt, path = detect_proxy(kind)
    if not fmt or not path:
        msg = "no egress proxy binary found (tinyproxy/squid/mitmdump) — NOT installing"
        if require:
            logger.warning("egress: %s; failing closed (require=True)", msg)
            raise EgressUnavailable("no_proxy_binary", msg)
        logger.warning("egress: %s; degrading (require=False)", msg)
        return None

    # mitmproxy detected but intentionally not wired in v1 — never half-wire it.
    if fmt == "mitmproxy":
        msg = "mitmproxy/mitmdump egress proxy is not wired in v1 (use tinyproxy/squid)"
        if require:
            logger.warning("egress: %s; failing closed", msg)
            raise EgressUnavailable("unsupported_proxy_kind", msg)
        logger.warning("egress: %s; degrading", msg)
        return None

    # Render the deny-default config. tinyproxy raises ValueError on
    # block-within-allow overlap (fail-closed by design); fall back to squid if
    # available, else fail closed.
    try:
        fragment = to_proxy_config(policy, fmt)
    except ValueError as e:
        if fmt == "tinyproxy":
            sq_fmt, sq_path = detect_proxy("squid")
            if sq_fmt and sq_path:
                logger.warning(
                    "egress: tinyproxy cannot express this policy (%s); "
                    "falling back to squid", e,
                )
                fmt, path = sq_fmt, sq_path
                fragment = to_proxy_config(policy, fmt)
            elif require:
                raise EgressUnavailable(
                    "policy_requires_egress_control",
                    f"cannot render egress config: {e}",
                ) from e
            else:
                logger.warning("egress: cannot render config (%s); degrading", e)
                return None
        elif require:
            raise EgressUnavailable(
                "policy_requires_egress_control",
                f"cannot render egress config: {e}",
            ) from e
        else:
            logger.warning("egress: cannot render config (%s); degrading", e)
            return None

    wd = work_dir or tempfile.mkdtemp(prefix="ive-egress-")
    listen_port = int(port) if port else _free_loopback_port()

    frag_path = os.path.join(wd, f"egress-{fmt}.filter")
    conf_path = os.path.join(wd, f"egress-{fmt}.conf")
    try:
        with open(frag_path, "w", encoding="utf-8") as fh:
            fh.write(fragment)
        if fmt == "tinyproxy":
            conf = _full_tinyproxy_conf(frag_path, listen_port)
            argv = [path, "-d", "-c", conf_path]
        else:  # squid
            conf = _full_squid_conf(frag_path, listen_port)
            argv = [path, "-N", "-f", conf_path]
        with open(conf_path, "w", encoding="utf-8") as fh:
            fh.write(conf)
    except OSError as e:
        _cleanup_dir(wd)
        if require:
            raise EgressUnavailable("spawn_failed", f"could not write config: {e}") from e
        logger.warning("egress: could not write config (%s); degrading", e)
        return None

    try:
        proc = subprocess.Popen(
            argv,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            close_fds=True,
        )
    except (FileNotFoundError, PermissionError, OSError) as e:
        _cleanup_dir(wd)
        if require:
            raise EgressUnavailable("spawn_failed", f"failed to launch proxy: {e}") from e
        logger.warning("egress: failed to launch proxy (%s); degrading", e)
        return None

    if not _wait_listen(listen_port, proc):
        try:
            proc.terminate()
            proc.wait(timeout=2)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        _cleanup_dir(wd)
        msg = "egress proxy did not bind its port"
        if require:
            logger.warning("egress: %s; failing closed", msg)
            raise EgressUnavailable("spawn_failed", msg)
        logger.warning("egress: %s; degrading", msg)
        return None

    address = f"http://127.0.0.1:{listen_port}"
    logger.info("egress: started %s proxy pid=%s at %s", fmt, proc.pid, address)
    return EgressProxyHandle(
        pid=proc.pid,
        port=listen_port,
        fmt=fmt,
        config_path=conf_path,
        address=address,
        work_dir=wd,
        _proc=proc,
    )


def _cleanup_dir(path: str | None) -> None:
    if not path:
        return
    try:
        for name in os.listdir(path):
            try:
                os.unlink(os.path.join(path, name))
            except OSError:
                pass
        os.rmdir(path)
    except OSError:
        pass


def stop_egress_proxy(handle: EgressProxyHandle | None) -> None:
    """Stop a started egress proxy and clean up its temp config. Idempotent.

    SIGTERM -> 3s grace -> SIGKILL (mirrors the PTYSession kill escalation),
    then unlink the temp config + work_dir. Guards on None / already-dead.
    """
    if handle is None:
        return
    proc = handle._proc
    if proc is not None and proc.poll() is None:
        try:
            proc.send_signal(signal.SIGTERM)
        except (ProcessLookupError, OSError):
            pass
        try:
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except (ProcessLookupError, OSError):
                pass
            try:
                proc.wait(timeout=2)
            except Exception:
                pass
    _cleanup_dir(handle.work_dir)


class egress_proxy:
    """Context manager: start a proxy on enter, always stop on exit.

    Preferred call shape so a caller cannot leak a proxy process / temp config::

        with egress_proxy(policy, require=True) as handle:
            if handle is None:
                ...  # degraded (require=False path) — no enforcement available
            else:
                run_with(HTTP_PROXY=handle.address)
    """

    def __init__(self, policy: EgressPolicy, *, require: bool = False,
                 kind: str | None = None, port: int | None = None,
                 work_dir: str | None = None):
        self._policy = policy
        self._require = require
        self._kind = kind
        self._port = port
        self._work_dir = work_dir
        self._handle: EgressProxyHandle | None = None

    def __enter__(self) -> EgressProxyHandle | None:
        self._handle = start_egress_proxy(
            self._policy,
            require=self._require,
            kind=self._kind,
            port=self._port,
            work_dir=self._work_dir,
        )
        return self._handle

    def __exit__(self, exc_type, exc, tb) -> bool:
        stop_egress_proxy(self._handle)
        self._handle = None
        return False
