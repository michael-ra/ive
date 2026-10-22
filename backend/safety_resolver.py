"""Safety Gate — command variable resolver + dry-run preview.

The token-free tier between the static regexes and the LLM classifier.
A command like ``rm -rf "$STAGING_DIR/"`` is opaque to both regex rules and
a classifier reading raw text: what actually runs depends on what
``STAGING_DIR`` holds — and if it is UNSET, the command collapses to
``rm -rf /``. This module simulates that expansion WITHOUT executing
anything, so:

  * safety_engine's deny pass can regex-match what WOULD run (0 tokens),
  * the LLM classifier receives the resolved command + dry-run notes
    instead of guessing through variable indirection.

CLI-agnostic: operates on the raw shell command string any agent CLI
(claude / codex / gemini) hands the PreToolUse hook — nothing depends on
which agent produced it or on host shell state beyond the optional
``env`` hint dict the hook forwards.

Semantics honored (approximations, biased toward over-visibility):
  * statement-local assignments applied sequentially (``V=/x && rm $V``),
    including ``export V=...`` and env-prefix form ``V=x cmd``
  * ``$VAR`` / ``${VAR}`` / ``${VAR:-def}`` / ``${VAR:=def}`` / ``${VAR:+alt}``
  * single-quoted spans are literal; double-quoted spans expand
  * heredocs with a QUOTED delimiter (``<<'PY'``) keep their body literal;
    unquoted heredocs expand (matches shell behavior)
  * ``$(...)`` / backticks are NEVER executed — recorded as dynamic; a var
    assigned from one is "set but unknown" and never collapses to empty
  * env values redacted by the hook ("***") stay set-but-opaque
  * ``source <file>`` / ``. <file>`` marks every LATER unknown var as
    set-but-unknown (defined by the sourced file, value unreadable here) —
    it must NOT be reported unset or collapsed (the ``source .env && curl
    "$URL"`` pattern is routine config loading, not danger). Vars referenced
    BEFORE the source line keep full unset analysis.

Two outputs matter downstream:
  * ``resolved``   — known vars substituted, unknown left as-is
  * ``worst_case`` — unknown vars collapsed to empty (the dangerous read)

Pure + total: resolve() never raises and never touches the filesystem,
network, or a subprocess.
"""
from __future__ import annotations

import re
import shlex
from typing import Optional

# Set-but-unknown sentinel (dynamic $() value, or hook-redacted secret):
# must never collapse to empty in the worst case, never substituted.
_UNKNOWN = object()

_MAX_NOTES = 8

_ASSIGN_RE = re.compile(
    r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)="
    r"(\"(?:[^\"\\]|\\.)*\"|'[^']*'|\$\([^)]*\)|`[^`]*`|[^\s;|&]*)"
)
_VAR_RE = re.compile(
    r"(?<!\\)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)((?::?[-=+?])[^}]*)?\}"
    r"|([A-Za-z_][A-Za-z0-9_]*))"
)
_SINGLEQ_SPLIT_RE = re.compile(r"('[^']*')")
_STMT_SPLIT_RE = re.compile(r"(\s*(?:&&|\|\||;|\n)\s*)")
_SOURCE_RE = re.compile(r"^(?:source|\.)\s+(\S+)")
_SUBSHELL_RE = re.compile(r"\$\(([^)]+)\)")
_BACKTICK_RE = re.compile(r"`([^`]+)`")
_QUOTED_HEREDOC_RE = re.compile(r"<<-?\s*(?:'[^']+'|\"[^\"]+\"|\\\w+)")

# Verbs whose resolved targets are worth calling out in the dry-run notes.
_DESTRUCTIVE_VERBS = {
    "rm", "rmdir", "shred", "truncate", "dd", "mkfs",
    "chmod", "chown", "mv",
}
_DESTRUCTIVE_GIT_RE = re.compile(
    r"\bgit\b.*?(push\s+.*(--force\b|-f\b)|reset\s+--hard|clean\s+-\w*f|branch\s+-D)"
)
_FIND_DELETE_RE = re.compile(r"\bfind\b.*\s(-delete\b|-exec\s+rm\b)")
_RSYNC_DELETE_RE = re.compile(r"\brsync\b.*--delete\b")


def _empty_result(command: str) -> dict:
    return {
        "command": command,
        "resolved": command,
        "worst_case": None,
        "changed": False,
        "assignments": {},
        "unresolved": [],
        "sourced_files": [],
        "sourced_vars": [],
        "dynamic": [],
        "notes": [],
        "match_variants": [],
    }


def _split_literal_heredoc(command: str) -> tuple[str, str]:
    """Split off a quoted-heredoc body (literal per shell) → (head, tail)."""
    m = _QUOTED_HEREDOC_RE.search(command)
    if not m:
        return command, ""
    nl = command.find("\n", m.end())
    if nl < 0:
        return command, ""
    return command[: nl + 1], command[nl + 1:]


def _expand_text(text: str, scope: dict, unknown: str, unresolved: set,
                 state: Optional[dict] = None) -> str:
    """Expand vars outside single-quoted spans. unknown ∈ {'keep','empty'}.

    ``state`` (optional) carries source-file tracking: once state["sourced"]
    is set, an unknown var is assumed DEFINED by the sourced file — kept
    literal in both passes and recorded in state["from_source"] instead of
    ``unresolved``.
    """

    def _sub(m: "re.Match[str]") -> str:
        name = m.group(1) or m.group(3)
        raw_op = m.group(2) or ""  # e.g. ":-fallback" — operator char + body
        op = raw_op[1:2] if raw_op.startswith(":") else raw_op[0:1]
        body = raw_op[2:] if raw_op.startswith(":") else raw_op[1:]
        value = scope.get(name)
        if value is _UNKNOWN:
            return m.group(0)  # set but unknown — never substitute or collapse
        if value is not None:
            if op == "+":
                return body  # ${SET:+alt} → alt
            return str(value)
        # Unset — but a preceding `source file` means it may well be defined
        # there: treat as set-but-unknown, never as a collapse hazard.
        if state and state.get("sourced"):
            state.setdefault("from_source", set()).add(name)
            return m.group(0)
        if op in ("-", "="):
            if op == "=":
                scope[name] = body
            return body
        if op == "+":
            return ""  # ${UNSET:+alt} → empty
        unresolved.add(name)
        return m.group(0) if unknown == "keep" else ""

    parts = _SINGLEQ_SPLIT_RE.split(text)
    out = []
    for i, part in enumerate(parts):
        if i % 2 == 1:  # single-quoted span — literal
            out.append(part)
        else:
            out.append(_VAR_RE.sub(_sub, part))
    return "".join(out)


def _strip_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _expand_command(command: str, scope: dict, unknown: str, unresolved: set,
                    assignments: dict, state: Optional[dict] = None) -> str:
    """Walk statements in order, binding assignments then expanding.

    ``state`` tracks `source <file>` statements: everything referenced after
    one is assumed definable by the sourced file (see _expand_text).
    """
    state = state if state is not None else {}
    parts = _STMT_SPLIT_RE.split(command)
    out = []
    for i, part in enumerate(parts):
        if i % 2 == 1:  # separator (&&, ;, ||, newline)
            out.append(part)
            continue
        stmt = part
        rebuilt = ""
        # Peel leading assignment(s): V=x, export V=x, env-prefix V=x cmd.
        while True:
            m = _ASSIGN_RE.match(stmt.lstrip())
            if not m:
                break
            lead_ws = stmt[: len(stmt) - len(stmt.lstrip())]
            name, raw_value = m.group(1), m.group(2)
            if "$(" in raw_value or "`" in raw_value:
                scope[name] = _UNKNOWN
                assignments[name] = "<dynamic>"
                rebuilt += lead_ws + stmt.lstrip()[: m.end()]
            else:
                value = _expand_text(
                    _strip_quotes(raw_value), scope, unknown, unresolved, state
                )
                scope[name] = value
                assignments[name] = value
                rebuilt += lead_ws + f"{name}={raw_value}"
            stmt = stmt.lstrip()[m.end():]
            if not stmt or not stmt[0].isspace():
                break
        src = _SOURCE_RE.match(stmt.strip())
        if src:
            state["sourced"] = True
            state.setdefault("files", []).append(_strip_quotes(src.group(1)))
        out.append(rebuilt + _expand_text(stmt, scope, unknown, unresolved, state))
    return "".join(out)


def _quote_normalize(command: str) -> Optional[str]:
    """Token-join via shlex so `rm -rf "/"` regex-matches as `rm -rf /`."""
    try:
        tokens = shlex.split(command, posix=True)
        return " ".join(tokens) if tokens else None
    except ValueError:
        return None


def _dry_run_notes(original: str, resolved: str, worst: str,
                   unresolved: set, scope_before: dict) -> list:
    notes: list[str] = []

    # Unset-var collapse: show what each affected token becomes.
    for name in sorted(unresolved):
        if len(notes) >= _MAX_NOTES:
            break
        token_re = re.compile(r"\S*\$(?:\{%s[^}]*\}|%s\b)\S*" % (name, name))
        m = token_re.search(original)
        if not m:
            continue
        collapsed = _expand_text(m.group(0), dict(scope_before), "empty", set())
        collapsed = _strip_quotes(collapsed.strip()) or "''"
        notes.append(
            f"${name} is UNSET here — token {m.group(0)!r} would run as {collapsed!r}"
        )

    # Destructive verbs: name the resolved targets.
    for stmt in re.split(r"\s*(?:&&|\|\||;|\n)\s*", worst or resolved):
        if len(notes) >= _MAX_NOTES:
            break
        try:
            tokens = shlex.split(stmt, posix=True)
        except ValueError:
            tokens = stmt.split()
        while tokens and ("=" in tokens[0] or tokens[0] == "sudo"):
            tokens = tokens[1:]
        if not tokens:
            continue
        verb = tokens[0].rsplit("/", 1)[-1]
        if verb in _DESTRUCTIVE_VERBS:
            targets = [t for t in tokens[1:] if not t.startswith("-")]
            if targets:
                notes.append(f"{verb} would act on: {', '.join(targets[:6])}")
        elif _DESTRUCTIVE_GIT_RE.search(stmt):
            notes.append(f"destructive git operation would run: {stmt[:120]}")
        elif _FIND_DELETE_RE.search(stmt):
            notes.append(f"find with -delete/-exec rm would run: {stmt[:120]}")
        elif _RSYNC_DELETE_RE.search(stmt):
            notes.append(f"rsync --delete would run: {stmt[:120]}")

    return notes[:_MAX_NOTES]


# ── URL resolution (WebFetch / WebSearch tier) ──────────────────────────
#
# Same philosophy as command resolution: extract token-free FACTS about what
# a fetch would actually touch, so the deny rules / classifier / auto-allow
# policy judge the real target instead of a raw string. Never performs DNS,
# never fetches.

# Well-known dev/research domains — a REPUTATION HINT for the classifier and
# the fetch auto-allow policy, never a hard allow by itself. Subdomains match.
_KNOWN_DEV_DOMAINS = frozenset({
    "arxiv.org", "openreview.net", "semanticscholar.org", "aclanthology.org",
    "wikipedia.org", "wikimedia.org", "stackoverflow.com", "stackexchange.com",
    "github.com", "githubusercontent.com", "gist.github.com", "gitlab.com",
    "npmjs.com", "pypi.org", "crates.io", "docs.rs", "rubygems.org",
    "huggingface.co", "kaggle.com", "paperswithcode.com",
    "developer.mozilla.org", "readthedocs.io", "readthedocs.org",
    "docs.python.org", "nodejs.org", "go.dev", "rust-lang.org",
    "kubernetes.io", "docker.com", "hub.docker.com",
    "anthropic.com", "openai.com", "ai.google.dev", "modelcontextprotocol.io",
})

_URL_SHORTENERS = frozenset({
    "bit.ly", "t.co", "tinyurl.com", "goo.gl", "is.gd", "ow.ly", "buff.ly",
    "rb.gy", "cutt.ly", "shorturl.at",
})

_IPV4_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")


def _domain_matches(host: str, domains: frozenset) -> bool:
    return host in domains or any(host.endswith("." + d) for d in domains)


def resolve_url(url: str) -> dict:
    """Parse a fetch-tool URL into judgeable facts. Total: never raises,
    never resolves DNS or fetches.

    Returns {url, scheme, host, port, flags, known_dev_domain, local}.
    flags (each one a reason for suspicion):
      credentials_in_url — user@host deception (https://arxiv.org@evil.com)
      ip_literal_host    — raw IP instead of a hostname (non-local)
      punycode_host      — IDN/homograph potential (xn--)
      url_shortener      — destination hidden behind a shortener
      non_http_scheme    — file:, data:, ftp:, gopher: …
      unusual_port       — non-standard port on a non-local host
    """
    try:
        from urllib.parse import urlsplit

        raw = str(url or "").strip()
        if not raw:
            return {"url": "", "scheme": "", "host": "", "port": None,
                    "flags": [], "known_dev_domain": False, "local": False}
        parts = urlsplit(raw if "//" in raw else "https://" + raw)
        scheme = (parts.scheme or "").lower()
        host = (parts.hostname or "").lower().rstrip(".")
        try:
            port = parts.port
        except ValueError:
            port = None

        local = (
            host in ("localhost", "0.0.0.0", "::1")
            or host.endswith(".local")
            or host.startswith("127.")
            or host.startswith("192.168.")
            or host.startswith("10.")
        )

        flags = []
        if parts.username or parts.password:
            flags.append("credentials_in_url")
        if _IPV4_RE.match(host) and not local:
            flags.append("ip_literal_host")
        if host.startswith("xn--") or ".xn--" in host:
            flags.append("punycode_host")
        if _domain_matches(host, _URL_SHORTENERS):
            flags.append("url_shortener")
        if scheme not in ("http", "https"):
            flags.append("non_http_scheme")
        if port not in (None, 80, 443) and not local:
            flags.append("unusual_port")

        return {
            "url": raw[:500],
            "scheme": scheme,
            "host": host,
            "port": port,
            "flags": flags,
            "known_dev_domain": _domain_matches(host, _KNOWN_DEV_DOMAINS),
            "local": local,
        }
    except Exception:
        return {"url": str(url)[:500] if url else "", "scheme": "", "host": "",
                "port": None, "flags": [], "known_dev_domain": False,
                "local": False}


def resolve(command: str, env: Optional[dict] = None) -> dict:
    """Resolve variables in ``command`` and dry-run what WOULD execute.

    ``env`` is an optional {name: value} hint dict (the hook forwards only
    vars the command references, secrets pre-redacted to "***"). Returns a
    dict — see module docstring for the keys. Total: never raises.
    """
    try:
        if not command or not isinstance(command, str) or "$" not in command:
            return _empty_result(command if isinstance(command, str) else "")

        base_scope: dict = {}
        for k, v in (env or {}).items():
            if not isinstance(k, str) or not k:
                continue
            base_scope[k] = _UNKNOWN if str(v) == "***" else str(v)

        head, literal_tail = _split_literal_heredoc(command)

        dynamic = [s.strip() for s in _SUBSHELL_RE.findall(head)]
        dynamic += [s.strip() for s in _BACKTICK_RE.findall(head)]

        unresolved: set = set()
        assignments: dict = {}

        scope = dict(base_scope)
        src_state: dict = {}
        resolved = _expand_command(
            head, scope, "keep", unresolved, assignments, src_state
        ) + literal_tail

        worst_scope = dict(base_scope)
        worst = _expand_command(
            head, worst_scope, "empty", set(), {}, {}
        ) + literal_tail

        sourced_files = list(src_state.get("files") or [])
        sourced_vars = sorted(src_state.get("from_source") or set())

        if worst == resolved:
            worst_out = None
        else:
            worst_out = worst

        changed = resolved != command or worst_out is not None
        notes = (
            _dry_run_notes(head, resolved, worst, unresolved, base_scope)
            if (changed or unresolved) else []
        )
        if sourced_vars and len(notes) < _MAX_NOTES:
            notes.append(
                "sources " + ", ".join(sourced_files[:3])
                + " — likely defines: $" + ", $".join(sourced_vars[:8])
                + " (set at runtime, NOT unset)"
            )

        match_variants = []
        for variant in (resolved, worst if worst_out else None):
            if not variant or variant == command:
                continue
            if variant not in match_variants:
                match_variants.append(variant)
            normalized = _quote_normalize(variant)
            if normalized and normalized not in match_variants:
                match_variants.append(normalized)

        return {
            "command": command,
            "resolved": resolved,
            "worst_case": worst_out,
            "changed": changed,
            "assignments": {k: ("<dynamic>" if v is _UNKNOWN else v)
                            for k, v in assignments.items()},
            "unresolved": sorted(unresolved),
            "sourced_files": sourced_files[:8],
            "sourced_vars": sourced_vars[:16],
            "dynamic": dynamic[:8],
            "notes": notes,
            "match_variants": match_variants,
        }
    except Exception:
        return _empty_result(command if isinstance(command, str) else "")
