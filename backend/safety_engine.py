"""Safety Gate — general-purpose tool call safety engine.

Evaluates every CLI tool call (Bash, Write, Edit, Read, WebFetch, etc.)
against configurable rules and blocks dangerous operations before they
execute.  Complements AVCP (which only covers package installs).

The engine is called synchronously from the safety_gate.sh hook script via
POST /api/safety/evaluate.  Rules are cached in memory (1s TTL) so the hot
path is pure regex matching with no DB I/O.

Adding rules:
  - Builtin rules are defined in BUILTIN_RULES and seeded on first enable.
  - Users can create custom rules via the UI / REST API.
  - Rules are scoped globally or per-workspace.
"""
from __future__ import annotations

import re
import time
import uuid
import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


# ─── Data types ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class SafetyRule:
    id: str
    name: str
    description: str
    category: str          # dangerous_command, protected_path, credential, destructive_git, sql_destructive, network, custom
    severity: str          # critical, high, medium, low
    tool_match: str        # 'Bash', 'Write|Edit', '*'
    pattern: str           # regex
    pattern_field: str     # 'command', 'file_path', 'url', '' (auto-detect)
    action: str            # deny, ask, allow
    enabled: bool = True
    is_builtin: bool = False
    workspace_id: Optional[str] = None


@dataclass
class SafetyDecision:
    action: str            # deny, ask, allow
    reason: str
    rule_id: Optional[str] = None
    rule_name: Optional[str] = None
    severity: Optional[str] = None
    matched_input: str = ""   # the input that triggered the match (for approval scoping)
    latency_ms: int = 0


# ─── Severity ordering ─────────────────────────────────────────────────

_SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}


# ─── Rule cache ─────────────────────────────────────────────────────────

class RuleCache:
    """In-memory rule cache with compiled regexes and TTL-based refresh."""

    def __init__(self, ttl: float = 1.0):
        self._ttl = ttl
        self._rules: list[SafetyRule] = []
        self._compiled: dict[str, re.Pattern] = {}
        self._loaded_at: float = 0.0
        self._db_loader = None  # set by init()

    def init(self, loader):
        """Register the async DB loader function."""
        self._db_loader = loader

    def invalidate(self):
        """Force reload on next access."""
        self._loaded_at = 0.0

    async def get_rules(self, workspace_id: Optional[str] = None) -> list[SafetyRule]:
        """Return cached rules, refreshing if stale."""
        now = time.monotonic()
        if now - self._loaded_at > self._ttl and self._db_loader:
            await self._reload()
        # Filter: global rules + workspace-specific rules
        return [
            r for r in self._rules
            if r.enabled and (r.workspace_id is None or r.workspace_id == workspace_id)
        ]

    async def _reload(self):
        try:
            rows = await self._db_loader()
            rules = []
            compiled = {}
            for row in rows:
                rule = SafetyRule(
                    id=row["id"],
                    name=row["name"],
                    description=row["description"] or "",
                    category=row["category"],
                    severity=row["severity"],
                    tool_match=row["tool_match"],
                    pattern=row["pattern"],
                    pattern_field=row["pattern_field"] or "",
                    action=row["action"],
                    enabled=bool(row["enabled"]),
                    is_builtin=bool(row["is_builtin"]),
                    workspace_id=row["workspace_id"],
                )
                rules.append(rule)
                # Pre-compile regex
                try:
                    compiled[rule.id] = re.compile(rule.pattern, re.IGNORECASE)
                except re.error as e:
                    logger.warning("Bad regex in rule %s: %s", rule.id, e)
            # Sort: workspace-specific first, then by severity
            rules.sort(key=lambda r: (
                0 if r.workspace_id else 1,
                _SEVERITY_ORDER.get(r.severity, 99),
            ))
            self._rules = rules
            self._compiled = compiled
            self._loaded_at = time.monotonic()
        except Exception as e:
            logger.error("Failed to reload safety rules: %s", e)


# Singleton cache
_cache = RuleCache()

# ─── Approval memory ──────────────────────────────────────────────────
# When a user approves an "ask" rule, remember the specific (rule_id,
# input_summary) combo so that only the *same* operation auto-allows.
# e.g. approving `rm -r ./build` doesn't auto-allow `rm -r ~/Documents`.
# Only applies to "ask" rules — "deny" rules are never auto-allowed.
# Resets on server restart (intentional: fresh safety slate each boot).

_approved_inputs: set[tuple[str, str]] = set()


def remember_approval(rule_id: str, input_summary: str):
    """Remember a (rule, input) combo the user approved."""
    if rule_id and input_summary:
        _approved_inputs.add((rule_id, input_summary))
        logger.info("Safety Gate: remembered approval for rule %s (%s)", rule_id, input_summary[:80])


def is_approved(rule_id: str, input_summary: str) -> bool:
    """Check if a (rule, input) combo was previously approved."""
    return (rule_id, input_summary) in _approved_inputs


def clear_approvals():
    """Clear all remembered approvals."""
    _approved_inputs.clear()


def init_cache(loader):
    """Initialize the rule cache with a DB loader function."""
    _cache.init(loader)


def invalidate_cache():
    """Force cache reload on next evaluate()."""
    _cache.invalidate()


# ─── Command normalization ─────────────────────────────────────────────
#
# Canonicalizes shell commands before regex matching so bypass variants
# like pushd, subshells, backticks, and semicolons all reduce to the same
# form the rules expect.  Runs only on Bash/execute tool inputs.

# Regex compiled once at module level
_SUBSHELL_RE = re.compile(r'\$\(([^)]+)\)')
_BACKTICK_RE = re.compile(r'`([^`]+)`')
_ENV_PREFIX_RE = re.compile(r'^(\s*[A-Z_][A-Z0-9_]*=[^\s]*\s+)+')
_MULTI_SPACE_RE = re.compile(r'\s+')


def _normalize_command(cmd: str) -> list[str]:
    """Canonicalize a shell command into one or more normalized forms.

    Returns a list because compound commands (&&, ;, |, subshells) are
    expanded into multiple segments — each checked independently against
    rules.  This catches bypass variants:
      - pushd/popd → cd
      - semicolons → &&
      - $(...) and backtick subshells → extracted as separate commands
      - env var prefixes stripped
      - sudo stripped
      - leading/trailing whitespace normalized
    """
    if not cmd or not cmd.strip():
        return [cmd]

    # Extract subshell / backtick commands as additional segments
    extra: list[str] = []
    for m in _SUBSHELL_RE.finditer(cmd):
        extra.append(m.group(1).strip())
    for m in _BACKTICK_RE.finditer(cmd):
        extra.append(m.group(1).strip())

    # Split on && ; || and newlines to get individual commands
    # (preserve the original as-is too, so multi-part patterns like
    #  "cd ... && git" still match on the full string)
    parts = re.split(r'\s*(?:&&|\|\||;|\n)\s*', cmd)

    segments = [cmd]  # always include the original full command
    for part in parts:
        cleaned = part.strip()
        if not cleaned or cleaned == cmd:
            continue
        segments.append(cleaned)
    for e in extra:
        if e not in segments:
            segments.append(e)

    # Normalize each segment
    normalized = []
    for seg in segments:
        s = seg
        # Strip env var prefixes: FOO=bar BAZ=1 actual_command ...
        s = _ENV_PREFIX_RE.sub('', s)
        # Strip sudo
        s = re.sub(r'^sudo\s+(-[a-zA-Z]*\s+)*', '', s)
        # Normalize pushd → cd (pushd changes directory just like cd)
        s = re.sub(r'\bpushd\b', 'cd', s)
        # Collapse whitespace
        s = _MULTI_SPACE_RE.sub(' ', s).strip()
        if s:
            normalized.append(s)

    return normalized if normalized else [cmd]


# ─── Evaluation ─────────────────────────────────────────────────────────

def _tool_matches(tool_name: str, tool_match: str) -> bool:
    """Check if a tool name matches a rule's tool_match pattern."""
    if tool_match == "*":
        return True
    candidates = [t.strip().lower() for t in tool_match.split("|")]
    return tool_name.lower() in candidates


def _extract_match_field(tool_name: str, tool_input: dict) -> str:
    """Extract the primary field to match against from tool input."""
    tn = tool_name.lower()
    if tn in ("bash", "execute"):
        return tool_input.get("command", "")
    if tn in ("read", "read_file"):
        return tool_input.get("file_path", "")
    if tn in ("write", "write_file"):
        return tool_input.get("file_path", "")
    if tn in ("edit", "edit_file"):
        return tool_input.get("file_path", "")
    if tn in ("glob", "find_files"):
        return tool_input.get("pattern", "")
    if tn in ("grep", "search"):
        return tool_input.get("pattern", "")
    if tn in ("webfetch", "web_fetch"):
        return tool_input.get("url", "")
    if tn in ("websearch", "web_search"):
        return tool_input.get("query", "")
    # Fallback: try common keys
    for key in ("file_path", "path", "command", "url", "query"):
        if key in tool_input:
            return str(tool_input[key])
    return ""


def _is_command_tool(tool_name: str) -> bool:
    """Check if this tool is a shell command tool (needs normalization)."""
    return tool_name.lower() in ("bash", "execute")


async def evaluate(
    tool_name: str,
    tool_input: dict,
    workspace_id: Optional[str] = None,
) -> SafetyDecision:
    """Evaluate a tool call against safety rules.

    Returns the decision from the highest-severity matching rule.
    If no rules match, returns allow.

    For Bash/execute tools, the command is normalized before matching:
    pushd→cd, subshells extracted, compound commands split into segments.
    Each segment is checked independently so bypass variants are caught.
    """
    start = time.monotonic()

    rules = await _cache.get_rules(workspace_id)
    if not rules:
        elapsed = int((time.monotonic() - start) * 1000)
        return SafetyDecision(action="allow", reason="no rules loaded", latency_ms=elapsed)

    # Extract the default match field
    default_field = _extract_match_field(tool_name, tool_input)

    # For command tools, normalize into segments for bypass-resistant matching
    is_cmd = _is_command_tool(tool_name)
    if is_cmd and default_field:
        match_variants = _normalize_command(default_field)
    else:
        match_variants = None  # non-command tools don't need normalization

    for rule in rules:
        if not _tool_matches(tool_name, rule.tool_match):
            continue

        # Determine what to match against
        if rule.pattern_field:
            raw_target = tool_input.get(rule.pattern_field, "")
        else:
            raw_target = default_field

        if not raw_target:
            continue

        compiled = _cache._compiled.get(rule.id)
        if not compiled:
            continue

        # For command tools: check all normalized segments
        if match_variants and not rule.pattern_field:
            for variant in match_variants:
                if compiled.search(variant):
                    # Skip ask rules the user already approved for this exact input
                    if rule.action == "ask" and is_approved(rule.id, default_field):
                        break  # skip this rule, continue to next
                    elapsed = int((time.monotonic() - start) * 1000)
                    return SafetyDecision(
                        action=rule.action,
                        reason=f"{rule.name}: {rule.description}",
                        rule_id=rule.id,
                        rule_name=rule.name,
                        severity=rule.severity,
                        matched_input=default_field,
                        latency_ms=elapsed,
                    )
        else:
            if compiled.search(raw_target):
                # Skip ask rules the user already approved for this exact input
                if rule.action == "ask" and is_approved(rule.id, raw_target):
                    continue
                elapsed = int((time.monotonic() - start) * 1000)
                return SafetyDecision(
                    action=rule.action,
                    reason=f"{rule.name}: {rule.description}",
                    rule_id=rule.id,
                    rule_name=rule.name,
                    severity=rule.severity,
                    matched_input=raw_target,
                    latency_ms=elapsed,
                )

    elapsed = int((time.monotonic() - start) * 1000)
    return SafetyDecision(action="allow", reason="no matching rule", latency_ms=elapsed)


# ─── Builtin rules ─────────────────────────────────────────────────────

def _rule(name, desc, category, severity, tool_match, pattern, action="deny", pattern_field=""):
    return {
        "id": f"builtin-{uuid.uuid5(uuid.NAMESPACE_DNS, name).hex[:12]}",
        "name": name,
        "description": desc,
        "category": category,
        "severity": severity,
        "tool_match": tool_match,
        "pattern": pattern,
        "pattern_field": pattern_field,
        "action": action,
        "enabled": 1,
        "is_builtin": 1,
        "workspace_id": None,
    }


BUILTIN_RULES = [
    # ── Dangerous commands (Bash) ────────────────────────────────────────
    _rule(
        "Recursive force delete root",
        "rm -rf targeting root or home directory",
        "dangerous_command", "critical", "Bash",
        r"rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|(-[a-zA-Z]*f[a-zA-Z]*r))\s+(/\s*$|/\*|~/|/home)",
    ),
    _rule(
        "Recursive delete",
        "Recursive delete — verify target before running",
        "dangerous_command", "high", "Bash",
        r"rm\s+(-[a-zA-Z]*r|-R)\s",
        action="ask",
    ),
    _rule(
        "Disk format",
        "mkfs will format and erase a disk partition",
        "dangerous_command", "critical", "Bash",
        r"mkfs\.",
    ),
    _rule(
        "Raw disk write",
        "dd with device targets can destroy data",
        "dangerous_command", "critical", "Bash",
        r"dd\s+.*if=",
    ),
    _rule(
        "Write to device file",
        "Writing directly to /dev/ device files (excludes /dev/null, /dev/stdout, /dev/stderr)",
        "dangerous_command", "critical", "Bash",
        r">\s*/dev/(?!null|stdout|stderr|fd/)",
    ),
    _rule(
        "Fork bomb",
        "Shell fork bomb will crash the system",
        "dangerous_command", "critical", "Bash",
        r":\(\)\s*\{.*:\|:.*\}",
    ),
    _rule(
        "System shutdown",
        "Shutdown, reboot, or halt the system",
        "dangerous_command", "critical", "Bash",
        r"\b(shutdown|reboot|halt|poweroff|init\s+[06])\b",
    ),
    _rule(
        "Pipe to shell",
        "Downloading and piping directly to shell execution",
        "dangerous_command", "critical", "Bash",
        r"(curl|wget)\s+.*\|\s*(ba)?sh\b",
    ),
    _rule(
        "World-writable permissions",
        "chmod 777 makes files world-writable",
        "dangerous_command", "high", "Bash",
        r"chmod\s+(-[a-zA-Z]*\s+)*777",
        action="ask",
    ),
    _rule(
        "Recursive permission change",
        "Recursive chmod can break file permissions",
        "dangerous_command", "medium", "Bash",
        r"chmod\s+(-[a-zA-Z]*R|-[a-zA-Z]*r)",
        action="ask",
    ),
    _rule(
        "Kill init process",
        "Killing PID 1 can crash the system",
        "dangerous_command", "high", "Bash",
        r"kill\s+(-[a-zA-Z]*9[a-zA-Z]*\s+)?1\b",
    ),

    # ── Destructive git (Bash) ───────────────────────────────────────────
    _rule(
        "Git force push",
        "Force push can overwrite remote history",
        "destructive_git", "high", "Bash",
        r"git\s+push\s+.*--force",
        action="ask",
    ),
    _rule(
        "Git hard reset",
        "Hard reset discards uncommitted changes",
        "destructive_git", "medium", "Bash",
        r"git\s+reset\s+--hard",
        action="ask",
    ),
    _rule(
        "Git force clean",
        "Force clean removes untracked files permanently",
        "destructive_git", "medium", "Bash",
        r"git\s+clean\s+(-[a-zA-Z]*f)",
        action="ask",
    ),
    _rule(
        "Git force delete branch",
        "Force-deleting a branch cannot be easily undone",
        "destructive_git", "low", "Bash",
        r"git\s+branch\s+-D",
        action="ask",
    ),
    _rule(
        "Compound cd + git",
        "cd into a directory before running git can trigger bare repository attacks",
        "destructive_git", "high", "Bash",
        r"cd\s+.*&&\s*git\b",
        action="ask",
    ),

    # ── SQL destructive (Bash) ───────────────────────────────────────────
    _rule(
        "DROP TABLE/DATABASE",
        "Dropping tables or databases is irreversible",
        "sql_destructive", "critical", "Bash",
        r"DROP\s+(TABLE|DATABASE|SCHEMA)",
    ),
    _rule(
        "TRUNCATE TABLE",
        "Truncating a table deletes all rows",
        "sql_destructive", "high", "Bash",
        r"TRUNCATE\s+TABLE",
        action="ask",
    ),
    _rule(
        "DELETE without WHERE",
        "DELETE FROM without WHERE clause deletes all rows",
        "sql_destructive", "medium", "Bash",
        r"DELETE\s+FROM\s+\S+\s*;?\s*$",
        action="ask",
    ),

    # ── Protected paths (Write/Edit) ─────────────────────────────────────
    _rule(
        "SSH directory access",
        "SSH keys and config are sensitive",
        "protected_path", "critical", "Write|Edit|Read",
        r"[/~]\.ssh/",
    ),
    _rule(
        "System config directory",
        "/etc/ contains system configuration",
        "protected_path", "critical", "Write|Edit",
        r"^/etc/",
    ),
    _rule(
        "Git internals",
        ".git/ directory should not be modified directly",
        "protected_path", "high", "Write|Edit",
        r"/\.git/",
    ),
    _rule(
        "Environment file",
        ".env files may contain secrets",
        "protected_path", "high", "Write|Edit",
        r"\.env($|\.)",
        action="ask",
    ),
    _rule(
        "Shell config",
        "Shell config files affect the user's environment",
        "protected_path", "medium", "Write|Edit",
        r"[/~]\.(zshrc|bashrc|bash_profile|profile)$",
        action="ask",
    ),

    # ── Credential files (Write/Edit/Read) ───────────────────────────────
    _rule(
        "Private key file",
        "Private keys should not be read or modified by AI",
        "credential", "high", "Write|Edit|Read",
        r"(id_rsa|id_ed25519|id_ecdsa|\.pem|\.key)$",
        action="ask",
    ),
    _rule(
        "Credentials file",
        "Credential files contain authentication secrets",
        "credential", "high", "Write|Edit|Read",
        r"(credentials\.json|credentials\.yaml|\.npmrc|\.pypirc)$",
        action="ask",
    ),

    # ── Network (WebFetch / Bash) ────────────────────────────────────────
    _rule(
        "Suspicious TLD",
        "Domain uses a TLD commonly associated with abuse",
        "network", "medium", "WebFetch|Bash",
        r"https?://[^/]*\.(tk|ml|ga|cf|top|xyz|buzz|club|work)(/|$)",
        action="ask",
    ),
    _rule(
        "Direct IP URL",
        "URL uses a raw IP address instead of a domain name",
        "network", "medium", "WebFetch|Bash",
        r"https?://(?!127\.0\.0\.1\b|0\.0\.0\.0\b|10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b|192\.168\.\d{1,3}\.\d{1,3}\b)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}",
        action="ask",
    ),
]


async def seed_builtin_rules(db):
    """Insert builtin rules into DB if they don't exist yet."""
    for rule in BUILTIN_RULES:
        await db.execute(
            """INSERT INTO safety_rules
               (id, name, description, category, severity, tool_match,
                pattern, pattern_field, action, enabled, is_builtin, workspace_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 pattern = excluded.pattern,
                 description = excluded.description""",
            (
                rule["id"], rule["name"], rule["description"],
                rule["category"], rule["severity"], rule["tool_match"],
                rule["pattern"], rule["pattern_field"], rule["action"],
                rule["enabled"], rule["is_builtin"], rule["workspace_id"],
            ),
        )
    await db.commit()
    invalidate_cache()
    logger.info("Seeded %d builtin safety rules", len(BUILTIN_RULES))
