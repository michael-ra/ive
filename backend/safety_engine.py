"""Safety Gate — general-purpose tool call safety engine.

Evaluates every CLI tool call (Bash, Write, Edit, Read, WebFetch, etc.)
against configurable rules and blocks dangerous operations before they
execute.  Complements AVCP (which only covers package installs).

The engine is called synchronously from the safety_gate.sh hook script via
POST /api/safety/evaluate.  Rules are cached in memory (1s TTL) so the hot
path is in-process matching with no DB I/O.

Adding rules:
  - Builtin rules are defined in BUILTIN_RULES and seeded on first enable.
  - Users can create custom rules via the UI / REST API.
  - Rules are scoped globally or per-workspace.
  - A rule whose subject is the STRUCTURE of a command (which program runs,
    with which flags, on which operand) carries a structural guard instead of
    a pattern — see _STRUCTURAL_GUARDS. Shell grammar is not a regular
    language, and a pattern that tries to read structure off raw text is
    wrong in a new way on every rephrasing, in both directions.
"""
from __future__ import annotations

import re
import shlex
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
    precedent_decision_ids: list[int] = field(default_factory=list)
    precedent_reason: str = ""
    precedent_class: str = ""
    operator_policy_ids: list[str] = field(default_factory=list)
    failure_closed: bool = False


# ─── Severity ordering ─────────────────────────────────────────────────

_SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}


class RuleLoadError(RuntimeError):
    """Enabled safety rules or mandatory builtins could not be loaded exactly."""


def _build_rule_set(rows) -> tuple[list[SafetyRule], dict[str, re.Pattern]]:
    """Validate and compile a complete DB rule snapshot or raise."""
    rules: list[SafetyRule] = []
    compiled: dict[str, re.Pattern] = {}
    by_id: dict[str, SafetyRule] = {}
    for row in rows:
        try:
            rule = SafetyRule(
                id=str(row["id"]),
                name=str(row["name"]),
                description=str(row["description"] or ""),
                category=str(row["category"]),
                severity=str(row["severity"]),
                tool_match=str(row["tool_match"]),
                pattern=str(row["pattern"]),
                pattern_field=str(row["pattern_field"] or ""),
                action=str(row["action"]).lower(),
                enabled=bool(row["enabled"]),
                is_builtin=bool(row["is_builtin"]),
                workspace_id=row["workspace_id"],
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise RuleLoadError("malformed safety rule row") from exc
        if not rule.id or rule.id in by_id:
            raise RuleLoadError("missing or duplicate safety rule id")
        if rule.action not in {"allow", "ask", "deny"}:
            raise RuleLoadError(f"rule {rule.id} has an invalid action")
        if rule.severity not in _SEVERITY_ORDER:
            raise RuleLoadError(f"rule {rule.id} has an invalid severity")
        if not rule.tool_match or not rule.pattern:
            raise RuleLoadError(f"rule {rule.id} is incomplete")
        if rule.enabled:
            try:
                compiled[rule.id] = re.compile(rule.pattern, re.IGNORECASE)
            except re.error as exc:
                raise RuleLoadError(f"rule {rule.id} has an invalid regex") from exc
        rules.append(rule)
        by_id[rule.id] = rule

    # The code-owned deny tier is mandatory.  A deleted, disabled, downgraded,
    # or edited DB copy is configuration corruption, never an invitation to run
    # with an empty/stale dynamic tier.
    for required in (item for item in BUILTIN_RULES if item["action"] == "deny"):
        loaded = by_id.get(required["id"])
        if (
            loaded is None
            or not loaded.is_builtin
            or not loaded.enabled
            or loaded.action != "deny"
            or loaded.category != required["category"]
            or loaded.severity != required["severity"]
            or loaded.tool_match != required["tool_match"]
            or loaded.pattern != required["pattern"]
            or loaded.pattern_field != required["pattern_field"]
            or loaded.workspace_id is not None
        ):
            raise RuleLoadError(f"mandatory rule {required['id']} is unavailable")

    rules.sort(key=lambda rule: (
        0 if rule.workspace_id else 1,
        _SEVERITY_ORDER[rule.severity],
    ))
    return rules, compiled


# ─── Rule cache ─────────────────────────────────────────────────────────

class RuleCache:
    """In-memory rule cache with compiled regexes and TTL-based refresh."""

    def __init__(self, ttl: float = 1.0):
        self._ttl = ttl
        self._rules: list[SafetyRule] = []
        self._compiled: dict[str, re.Pattern] = {}
        self._loaded_at: float = 0.0
        self._db_loader = None  # set by init()
        self._load_error: str | None = None

    def init(self, loader):
        """Register the async DB loader function."""
        self._db_loader = loader

    def invalidate(self):
        """Force reload on next access."""
        self._loaded_at = 0.0

    async def get_rules(self, workspace_id: Optional[str] = None) -> list[SafetyRule]:
        """Return cached rules, refreshing if stale."""
        if self._db_loader is None:
            self._load_error = "safety rule loader is not initialized"
            raise RuleLoadError(self._load_error)
        now = time.monotonic()
        if now - self._loaded_at > self._ttl:
            await self._reload()
        # Filter: global rules + workspace-specific rules
        return [
            r for r in self._rules
            if r.enabled and (r.workspace_id is None or r.workspace_id == workspace_id)
        ]

    async def _reload(self):
        try:
            rows = await self._db_loader()
            rules, compiled = _build_rule_set(rows)
            self._rules = rules
            self._compiled = compiled
            self._loaded_at = time.monotonic()
            self._load_error = None
        except Exception as e:
            self._rules = []
            self._compiled = {}
            self._loaded_at = 0.0
            self._load_error = str(e)
            logger.error("Failed to reload safety rules: %s", e)
            if isinstance(e, RuleLoadError):
                raise
            raise RuleLoadError("safety rule storage unavailable") from e


# Singleton cache
_cache = RuleCache()

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
# Case-insensitive: `foo=bar cmd` is as much an assignment prefix as
# `FOO=bar cmd`, and an upper-case-only class made a rule deny one spelling
# and allow the other — an asymmetry nobody chose.
_ENV_PREFIX_RE = re.compile(r'^(\s*[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+')
_MULTI_SPACE_RE = re.compile(r'\s+')

# ── Command-position wrappers — ONE table, every consumer ──────────────
#
# A wrapper is a word that stands in front of the real command and then runs
# it: sudo, env, nice, a shell with -c. Each round of this rule was refuted by
# a new spelling of one — `sudo -u root cmd` (the value of a value-taking
# option left standing where the command name goes), an assignment prefix, a
# quoted command word — so the knowledge of what a wrapper eats lives HERE,
# once, as data. Two consumers read it: the regex stripper used by
# _normalize_command (below) and the structural walker used by the guards
# (further below). Two hand-written copies were two chances to be wrong.

@dataclass(frozen=True)
class _Wrapper:
    """What one wrapper word consumes before the command it runs."""

    words: tuple[str, ...]
    #: short options that CONSUME A VALUE (`-u root` and `-uroot` both).
    value_shorts: str = ""
    #: long options that consume a value when spelled without `=`.
    value_longs: tuple[str, ...] = ()
    #: short options whose value is itself a COMMAND STRING to re-parse.
    cmd_shorts: str = ""
    cmd_longs: tuple[str, ...] = ()
    #: a command-string option may carry its value attached (`env -Scmd`,
    #: getopt style). A shell's -c never does: `sh -cx cmd` is two flags and
    #: the string is the next word.
    cmd_attached: bool = False
    #: options may follow a positional argument (`su root -c cmd`), so the
    #: scan does not stop at the first non-option word.
    scan_positionals: bool = False
    #: accepts NAME=value assignments between its options and the command.
    assignments: bool = False
    #: a shell builtin — no path may precede it.
    builtin: bool = False
    #: one positional argument (a duration) sits before the command.
    duration: bool = False
    #: what follows the options IS the command (sudo) rather than a script
    #: name or a user name (sh, su).
    argv_tail: bool = True
    #: the whole tail is re-joined and re-parsed as a command line (eval).
    restring: bool = False


_WRAPPER_SPECS = (
    _Wrapper(("sudo", "doas"),
             value_shorts="ugUChprtDRT",
             value_longs=("user", "group", "other-user", "close-from",
                          "prompt", "host", "role", "type", "chdir",
                          "chroot", "command-timeout"),
             assignments=True),
    _Wrapper(("env",),
             value_shorts="uCP",
             value_longs=("unset", "chdir", "block-signal",
                          "default-signal", "ignore-signal"),
             # -S/--split-string takes a whole command LINE, not an argv tail.
             cmd_shorts="S",
             cmd_longs=("split-string",),
             cmd_attached=True,
             assignments=True),
    _Wrapper(("nice",), value_shorts="n", value_longs=("adjustment",)),
    _Wrapper(("nohup", "setsid")),
    _Wrapper(("command", "builtin", "exec"), builtin=True),
    # Parser-only from here down: the regex stripper cannot skip a positional
    # argument or re-parse a quoted command string, and stripping a shell word
    # would leave the OTHER rules matching a script name as if it were a
    # command. The structural walker handles both correctly.
    _Wrapper(("timeout",), value_shorts="sk",
             value_longs=("signal", "kill-after"), duration=True),
    _Wrapper(("stdbuf",), value_shorts="ioe",
             value_longs=("input", "output", "error")),
    _Wrapper(("sh", "bash", "zsh", "dash", "ksh", "ash"),
             value_shorts="O", cmd_shorts="c", argv_tail=False),
    _Wrapper(("su",), value_shorts="sgG",
             value_longs=("shell", "group", "supp-group"),
             cmd_shorts="c", cmd_longs=("command",), cmd_attached=True,
             scan_positionals=True, argv_tail=False),
    _Wrapper(("eval",), argv_tail=False, restring=True),
)

_WRAPPERS_BY_WORD = {
    word: spec for spec in _WRAPPER_SPECS for word in spec.words
}

_OPT_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"


def _opt_chain(value_short: str, value_long: str = "") -> str:
    """Regex source for the run of option tokens belonging to ONE wrapper word.

    ``value_short`` lists the short options that CONSUME A VALUE. getopt
    bundling gives that value two spellings and BOTH must be eaten, or the
    value is left standing where the command name should be:
        -u root    the value is the next word
        -uroot     the value is the rest of the token
        -nu root   plain flags bundled ahead of the value-taking letter
    Once a value-taking letter appears in a bundle the rest of the token is
    its value, which is why the bundled form allows any trailing characters.
    The alternatives are mutually exclusive by construction — a token either
    contains a value-taking letter or it does not, and if it does the value
    is either attached or the next word — so the outer repetition never has
    to explore two readings of the same token.

    Case is pinned with (?-i:) on every option class: the rule set compiles
    with re.IGNORECASE and the normalizer does not, and `-h` (host, takes a
    value) is not `-H` (set HOME, takes none). Pinning is what keeps this
    stripper and the structural walker from disagreeing again.
    """
    plain = "".join(c for c in _OPT_LETTERS if c not in value_short) + "0-9"
    alts = []
    if value_long:
        alts.append(rf"--(?:{value_long})=[^\s;&|]*")
        alts.append(rf"--(?:{value_long})[ \t]+[^\s;&|]+")
    alts.append(r"--[a-zA-Z][a-zA-Z0-9-]*(?:=[^\s;&|]*)?")
    if value_short:
        # The leading run is PLAIN letters only — disjoint from the value-taking
        # class — so the position of the value-taking letter is determined, not
        # searched. With [a-zA-Z]* there instead, a long bundle made the two
        # runs ambiguous and matching went quadratic in the token's length: a
        # 2400-char option token cost 120ms on a tier that cannot be turned off.
        alts.append(rf"-(?-i:[{plain}]*[{value_short}])[^\s;&|]+")
        alts.append(rf"-(?-i:[{plain}]*[{value_short}])[ \t]+[^\s;&|]+")
    alts.append(rf"-(?-i:[{plain}]+)")
    # A bare `--` ends option parsing: `sudo -u root -- cmd ...`
    return r"(?:(?:" + "|".join(alts) + r")[ \t]+)*(?:--[ \t]+)?"


#: A command word may be spelled `\cmd` (escapes an alias/function) or with
#: any path in front of it (`/bin/cmd`, `./cmd`).
_CMD_WORD_PREFIX = r"(?:\\)?(?:[^\s;&|]*/)?"

#: Both `sudo VAR=val cmd` and `env VAR=val cmd` assign before the command.
_ASSIGN_PREFIX = r"(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]*[ \t]+)*"


def _wrapper_regex(spec: _Wrapper) -> str:
    """One wrapper alternative for the normalizer's stripper, from the table."""
    word = r"(?i:" + "|".join(spec.words) + r")"
    prefix = "" if spec.builtin else _CMD_WORD_PREFIX
    chain = _opt_chain(spec.value_shorts + spec.cmd_shorts,
                       "|".join(spec.value_longs + spec.cmd_longs))
    return prefix + word + r"[ \t]+" + chain + (_ASSIGN_PREFIX if spec.assignments else "")


_WRAPPERS = "|".join(
    _wrapper_regex(spec) for spec in _WRAPPER_SPECS
    # A duration positional or a command STRING cannot be stripped textually
    # without turning the rest of the line into something the other rules
    # would misread; those wrappers are handled by the parser only.
    if not spec.duration and spec.argv_tail
)

_CMD_PREFIX_STRIP_RE = re.compile(r"^\s*(?:" + _WRAPPERS + r")+")
_ALIAS_ESCAPE_RE = re.compile(r"^\\(?=[A-Za-z_])")


def _normalize_command(cmd: str, include_raw: bool = True) -> list[str]:
    """Canonicalize a shell command into one or more normalized forms.

    Returns a list because compound commands (&&, ;, |, subshells) are
    expanded into multiple segments — each checked independently against
    rules.  This catches bypass variants:
      - pushd/popd → cd
      - semicolons → &&
      - $(...) and backtick subshells → extracted as separate commands
      - env var prefixes stripped
      - command-position wrappers stripped (sudo/doas/env/nice/nohup/
        setsid/command, values of value-taking options included)
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
        # Strip command-position wrappers (sudo/doas/env/nice/nohup/setsid/
        # command) INCLUDING the values of their value-taking options, plus a
        # leading backslash that only escapes an alias, so every rule keyed on
        # a command name still sees the command.
        s = _CMD_PREFIX_STRIP_RE.sub('', s)
        s = _ALIAS_ESCAPE_RE.sub('', s)
        # Normalize pushd → cd (pushd changes directory just like cd)
        s = re.sub(r'\bpushd\b', 'cd', s)
        # Collapse whitespace
        s = _MULTI_SPACE_RE.sub(' ', s).strip()
        if s:
            normalized.append(s)

    # The RAW command must be a candidate for MATCHING. Normalization deliberately
    # strips env-var prefixes and sudo to defeat bypasses, but that also deletes
    # the very text some rules key on: "IVE_APP_WORKSPACE_READONLY=0 npm run dev"
    # normalized to "npm run dev", so a rule matching that assignment could never
    # fire. Adding the original can only ever match MORE, never less.
    #
    # include_raw=False is for CACHE KEYS (safety_classifier), where the opposite
    # is wanted: "rm -r ./build" and "rm   -r   ./build" must collapse to one key
    # so a build loop does not spray LLM calls.
    if include_raw and cmd not in normalized:
        normalized.append(cmd)

    return normalized if normalized else [cmd]


# ─── Structural command analysis ───────────────────────────────────────
#
# WHY THIS IS NOT A REGEX. Three rounds of pattern work on the recursive
# permission-change rule were refuted three times, each by a DIFFERENT
# rephrasing: a wrapper option that eats its value, an assignment prefix the
# pattern only recognised in upper case, the program's OWN `--`, a quoted mode,
# a quoted command word. That is not five bugs, it is one: env assignments,
# quoting, `--`, option-vs-operand and path spelling are STRUCTURE, and shell
# grammar is not a regular language — a pattern that reads structure off the
# raw text is wrong again on the next spelling, in both directions. Round 3's
# rule missed 9 of 42 catastrophic rephrasings AND fired on 4 ordinary
# commands.
#
# So the guards below decide on the PARSED command: tokenise once (quoting,
# escapes and adjacent-quote splices resolved by the tokenizer, not by us),
# split on real operators, drop assignments, peel wrappers with a table of
# what each one consumes, resolve the command word to a basename, then walk
# THAT program's own argument grammar. Everything the previous rounds tried
# to spell out in a pattern falls out of the parse for free.

#: Tokens made only of these characters separate one invocation from the next.
#: `\n` is in the set because a newline is a command SEPARATOR, not blank
#: space: two lines are two commands and must never merge into one argv.
_SHELL_OPERATORS = ";|&()<>\n`"

_ASSIGNMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_DURATION_RE = re.compile(r"^[0-9]+(?:\.[0-9]+)?[smhd]?$")

#: Shell keywords that may stand in front of a command inside one segment.
_LEADING_KEYWORDS = frozenset({"{", "!", "then", "else", "do", "time"})

#: Bound on wrapper chains and on re-parsing nested command strings.
_MAX_PEEL_DEPTH = 8


def _heredoc_delimiter(text: str, i: int) -> tuple[str, int]:
    """Read the word that ends a here-document, unquoting it as the shell does."""
    parts: list[str] = []
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in " \t\n" or ch in _SHELL_OPERATORS:
            break
        if ch == "\\":
            i += 1
            if i < n:
                parts.append(text[i])
                i += 1
            continue
        if ch in "'\"":
            quote = ch
            i += 1
            while i < n and text[i] != quote:
                parts.append(text[i])
                i += 1
            i += 1
            continue
        parts.append(ch)
        i += 1
    return "".join(parts), i


def _skip_heredoc_body(text: str, i: int, delimiter: str) -> int:
    """Skip from the start of a line to just past the delimiter line."""
    n = len(text)
    while i < n:
        end = text.find("\n", i)
        line, i = (text[i:], n) if end == -1 else (text[i:end], end + 1)
        if line.strip() == delimiter:
            return i
    return n


def _strip_shell_noise(command: str) -> str:
    """Remove the spans of a command line that are DATA, not commands.

    Two of them, and leaving either in costs false positives on ordinary work
    — which on an un-overridable tier is the expensive direction:

      * a `#` comment. `#` opens one only where a WORD could start and only
        outside quotes: `build#tag` is a filename and `echo "# heading"` is an
        argument, so the tokenizer's own comment support cannot be used (it
        cuts words in half). A note after a command — `... build  # never run
        the recursive form on /` — is a note, not a second command; a quoted
        `#` must not swallow the real command after it.
      * a here-document BODY. `cat <<EOF ... EOF` writes a file, and a file
        that documents a catastrophic command is not one. The body starts at
        the next NEWLINE, so anything after the redirect on the same line is
        still a command and stays; it ends at the delimiter line, and if the
        delimiter never comes the body runs to the end of the input, exactly
        as the shell reads it. `<<<` is a here-string, not a here-document.

    A body fed to an INTERPRETER (`bash <<EOF ... EOF`) is a deliberate miss,
    the same family as `find -exec` and `xargs`: the command arrives on stdin,
    where this rule's grammar does not reach, and the classifier still sees it.
    """
    out: list[str] = []
    state = "normal"
    escaped = False
    word_start = True
    pending: list[str] = []
    i = 0
    n = len(command)
    while i < n:
        ch = command[i]

        if escaped:
            out.append(ch)
            escaped = False
            word_start = False
            i += 1
            continue
        if state == "squote":
            out.append(ch)
            if ch == "'":
                state = "normal"
            i += 1
            continue
        if state == "dquote":
            if ch == "\\" and command[i + 1:i + 2] == "\n":
                i += 2          # a continuation inside quotes is still removed
                continue
            out.append(ch)
            if ch == "\\":
                escaped = True
            elif ch == '"':
                state = "normal"
            i += 1
            continue
        if state == "comment":
            if ch != "\n":
                i += 1
                continue
            state = "normal"

        if ch == "\n":
            out.append(ch)
            i += 1
            word_start = True
            while pending:
                i = _skip_heredoc_body(command, i, pending.pop(0))
            continue
        if ch == "\\":
            if command[i + 1:i + 2] == "\n":
                # A line continuation is not a line break: the shell removes
                # both characters, so `chmod -R 777 \<nl> /etc` is ONE command.
                # Leaving the newline in made it a command SEPARATOR and the
                # operand ended up in a segment of its own.
                i += 2
                continue
            out.append(ch)
            escaped = True
            word_start = False
            i += 1
            continue
        if ch in "'\"":
            out.append(ch)
            state = "squote" if ch == "'" else "dquote"
            word_start = False
            i += 1
            continue
        if ch == "#" and word_start:
            state = "comment"
            i += 1
            continue
        if ch == "<" and command[i + 1:i + 2] == "<" and command[i + 2:i + 3] != "<":
            j = i + 2
            if command[j:j + 1] == "-":
                j += 1
            while j < n and command[j] in " \t":
                j += 1
            delimiter, j = _heredoc_delimiter(command, j)
            if delimiter:
                pending.append(delimiter)
                word_start = True
                i = j
                continue
        out.append(ch)
        word_start = ch.isspace() or ch in _SHELL_OPERATORS
        i += 1
    return "".join(out)


#: Stands in the parsed text for a span whose VALUE cannot be read — a command
#: substitution, a backtick, a variable. NUL cannot occur in a real command
#: line (an argv string is NUL-terminated), so it can never collide with text
#: an operator actually typed; a NUL arriving anyway is itself unreadable and
#: is folded into the marker below.
_UNKNOWN_MARK = "\x00"

#: Cheap "is there anything expandable here at all" test, used to keep the
#: masker off the critical path of the overwhelming majority of commands.
#: It must list every character the masker can act on — a hint that misses one
#: turns the masker off for exactly the command that needed it.
_EXPANSION_HINT = ("$", "`", "~", _UNKNOWN_MARK)

#: A `$` introduces an expansion when it is followed by a name, a brace, or one
#: of the shell's special parameters. `$` before anything else — `cost: 5$`,
#: `awk '{print $}'` — is an ordinary character and must not turn its operand
#: unreadable, because that would fire this tier on ordinary work.
_VAR_START = re.compile(r"[A-Za-z0-9_{@*#?!$-]")


def _read_substitution(text: str, i: int, closer: str) -> tuple[str, int]:
    """Read a substitution body, returning it and the index past its closer.

    Quote- and nesting-aware so `$(echo "a)b")` and `$(f $(g))` end where the
    shell ends them. If the closer never comes, the body runs to the end of
    the input — an unterminated substitution is unreadable in exactly the way
    this whole function exists to record, so swallowing the tail is the
    conservative direction, not a loss.
    """
    start = i
    depth = 1
    n = len(text)
    state = "normal"
    while i < n:
        ch = text[i]
        if state == "squote":
            if ch == "'":
                state = "normal"
            i += 1
            continue
        if ch == "\\":
            i += 2
            continue
        if state == "dquote":
            if ch == '"':
                state = "normal"
            i += 1
            continue
        if ch == "'":
            state = "squote"
        elif ch == '"':
            state = "dquote"
        elif closer == ")" and ch == "(":
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return text[start:i], i + 1
        i += 1
    return text[start:], n


def _mask_expansions(command: str) -> tuple[str, list[str]]:
    """Replace every span whose value cannot be read with an opaque marker.

    Returns the masked text plus the command bodies found inside the
    substitutions, which still RUN and are parsed in their own right.

    Round 4's tokenizer treated `(`, `)` and a backtick as command
    SEPARATORS, so `chmod -R 777 $(echo /etc)` split into a chmod whose
    operand list was empty and a separate `echo /etc`. Masking keeps the
    operand where it belongs, marked as text nobody can read.

    Masking does not try to work out what a substitution expands to; nothing
    can. It only has to notice that something unreadable is standing in the
    operand, which is why the tests are crude ones — a substitution, a
    backtick, a variable, self-rewriting quoting, `~NAME` — rather than a
    second shell grammar to get wrong. Single quotes are honoured because
    inside them there is no expansion at all: `'$(echo /etc)'` names a file
    with an odd name, not /etc.

    What the marker MEANS is the caller's decision, and since round 6 the
    recursive-chmod guard reads it as OUT OF SCOPE rather than as suspicious:
    an operand carrying one is handed to the classifier. Round 5 read it as
    evidence and hard-denied 29% of ordinary developer commands.
    """
    out: list[str] = []
    inner: list[str] = []
    state = "normal"
    i = 0
    n = len(command)
    while i < n:
        ch = command[i]
        if state == "squote":
            out.append(ch)
            if ch == "'":
                state = "normal"
            i += 1
            continue
        if ch == "\\":
            # `\$` and `` \` `` are literal characters, not expansions.
            out.append(ch)
            if i + 1 < n:
                out.append(command[i + 1])
            i += 2
            continue
        if ch == "'" and state == "normal":
            state = "squote"
            out.append(ch)
            i += 1
            continue
        if ch == '"':
            state = "normal" if state == "dquote" else "dquote"
            out.append(ch)
            i += 1
            continue
        if ch == "`":
            body, i = _read_substitution(command, i + 1, "`")
            inner.append(body)
            out.append(_UNKNOWN_MARK)
            continue
        if (state == "normal" and ch == "~"
                and (command[i + 1:i + 2].isalpha() or command[i + 1:i + 2] == "_")
                and (not out or out[-1] in " \t\n" or out[-1] in _SHELL_OPERATORS)):
            # `~root` is /root or /var/root — a top-level system tree this
            # rule already claims. Only `~NAME` at a word start expands, so
            # `~/projects` (no name), a backup file `build~`, and a quoted
            # `"~root"` are all left exactly as they were.
            out.append(_UNKNOWN_MARK)
            i += 1
            continue
        if state == "normal" and ch == "$" and command[i + 1:i + 2] in ("'", '"'):
            # `$'\x2fetc'` IS /etc — ANSI-C quoting rewrites its own contents,
            # and `$"..."` is a translation lookup. Both are only special
            # outside double quotes.
            quote = command[i + 1]
            i += 2
            while i < n:
                if command[i] == "\\":
                    i += 2
                    continue
                if command[i] == quote:
                    i += 1
                    break
                i += 1
            out.append(_UNKNOWN_MARK)
            continue
        if ch == "$" and command[i + 1:i + 2] == "(":
            # `$((...))` is arithmetic, not a command, but the extra parens
            # balance out and re-parsing a number costs nothing.
            body, i = _read_substitution(command, i + 2, ")")
            inner.append(body)
            out.append(_UNKNOWN_MARK)
            continue
        if ch == "$" and _VAR_START.match(command[i + 1:i + 2] or ""):
            i += 1
            if command[i:i + 1] == "{":
                _, i = _read_substitution(command, i + 1, "}")
            elif command[i:i + 1].isalpha() or command[i:i + 1] == "_":
                while i < n and (command[i].isalnum() or command[i] == "_"):
                    i += 1
            else:
                i += 1          # $1, $@, $?, $$ … one character
            out.append(_UNKNOWN_MARK)
            continue
        out.append(_UNKNOWN_MARK if ch == _UNKNOWN_MARK else ch)
        i += 1
    return "".join(out), inner


def _shell_segments(command: str, depth: int = 0) -> list[tuple[list[str], bool]]:
    """Tokenise a command line into one argv per invocation.

    Returns ``(argv, truncated)`` pairs. ``truncated`` marks the segment whose
    tail could NOT be read — an unbalanced quote or a dangling escape. The
    prefix that was read is still returned, because "I could not read the
    whole line" is not the same as "there is nothing here", and treating it as
    nothing is how the previous rounds silently allowed things.

    Substitutions are masked before tokenising, so an unreadable span stays
    INSIDE the argv it belongs to instead of ending it; the commands nested in
    those substitutions are parsed as their own segments, because
    `echo $(chmod -R 777 /)` really does run that chmod.
    """
    text = _strip_shell_noise(command)
    inner: list[str] = []
    if any(hint in text for hint in _EXPANSION_HINT):
        text, inner = _mask_expansions(text)
    lexer = shlex.shlex(text, posix=True,
                        punctuation_chars=_SHELL_OPERATORS)
    lexer.whitespace_split = True
    lexer.whitespace = " \t\r"     # newline is an operator, see above
    lexer.commenters = ""          # `#` inside a word is not a comment, and
                                   # dropping the rest of the line would hide
                                   # the operand the decision turns on
    tokens: list[str] = []
    truncated = False
    try:
        for token in lexer:
            tokens.append(token)
    except ValueError:
        truncated = True

    segments: list[tuple[list[str], bool]] = []
    current: list[str] = []
    for token in tokens:
        if token and all(ch in _SHELL_OPERATORS for ch in token):
            segments.append((current, False))
            current = []
        else:
            current.append(token)
    segments.append((current, truncated))
    segments = [seg for seg in segments if seg[0]]
    if depth < _MAX_PEEL_DEPTH:
        for body in inner:
            segments.extend(_shell_segments(body, depth + 1))
    return segments


def _command_word(token: str) -> str:
    """The program a token names.

    Quoting is already gone — the tokenizer resolved `"chmod"`, `'chm''od'`
    and `ch\\mod` to the same word, which is precisely what no pattern could
    do. A leading backslash escapes an alias and a directory prefix selects
    the same program, so both are dropped. Compared in lower case: this runs
    on case-insensitive developer filesystems, where /bin/CHMOD is the same
    program, and the pattern it replaces matched case-insensitively too.
    """
    word = token.lstrip("\\")
    if "/" in word:
        word = word.rsplit("/", 1)[-1]
    return word.lower()


def _consume_wrapper_options(args: list[str], spec: _Wrapper) -> tuple[list[str], list[str]]:
    """Eat one wrapper word's options; return (remaining argv, command strings).

    Honours `--`, both getopt spellings of a value (`-u root`, `-uroot`), and
    bundles (`-nu root`). An option that consumes a value whose value is NOT
    eaten leaves that value standing where the command name goes — that single
    mistake is what made round 2's rule allow a wrapped invocation.
    """
    nested: list[str] = []
    i = 0
    while i < len(args):
        token = args[i]
        if token == "--":
            i += 1
            break
        if token.startswith("--") and len(token) > 2:
            name, sep, inline = token[2:].partition("=")
            if name in spec.cmd_longs:
                if sep:
                    nested.append(inline)
                elif i + 1 < len(args):
                    i += 1
                    nested.append(args[i])
            elif name in spec.value_longs and not sep and i + 1 < len(args):
                i += 1
            i += 1
            continue
        if token.startswith("-") and len(token) > 1:
            body = token[1:]
            for pos, letter in enumerate(body):
                if letter in spec.cmd_shorts:
                    tail = body[pos + 1:]
                    if tail and spec.cmd_attached:
                        nested.append(tail)
                    elif i + 1 < len(args):
                        i += 1
                        nested.append(args[i])
                    break
                if letter in spec.value_shorts:
                    if not body[pos + 1:] and i + 1 < len(args):
                        i += 1
                    break
            i += 1
            continue
        if spec.scan_positionals:
            i += 1
            continue
        break
    return args[i:], nested


def _peel_invocations(argv, truncated, depth=0) -> list[tuple[str, list[str], bool]]:
    """Resolve one segment to the (command word, args, truncated) it runs."""
    found: list[tuple[str, list[str], bool]] = []
    if depth > _MAX_PEEL_DEPTH:
        return found
    argv = list(argv)
    while argv:
        # Leading NAME=value assignments belong to the environment, not to the
        # command — dropped whatever their case, which is a property of the
        # parse rather than a character class somebody has to remember.
        if _ASSIGNMENT_RE.match(argv[0]) or argv[0] in _LEADING_KEYWORDS:
            argv.pop(0)
            continue
        break
    if not argv:
        return found

    word = _command_word(argv[0])
    spec = _WRAPPERS_BY_WORD.get(word)
    if spec is None:
        found.append((word, argv[1:], truncated))
        return found

    rest, nested = _consume_wrapper_options(argv[1:], spec)
    if spec.restring and rest:
        # eval joins its arguments and re-parses the result.
        nested.append(" ".join(rest))
        rest = []
    for text in nested:
        for inner_argv, inner_truncated in _shell_segments(text):
            found.extend(_peel_invocations(inner_argv, inner_truncated, depth + 1))
    if spec.duration and rest and _DURATION_RE.match(rest[0]):
        rest = rest[1:]
    if spec.argv_tail and rest:
        found.extend(_peel_invocations(rest, truncated, depth + 1))
    return found


def _invocations(command: str) -> list[tuple[str, list[str], bool]]:
    """Every (command word, args, truncated) a command line actually runs."""
    found: list[tuple[str, list[str], bool]] = []
    for argv, truncated in _shell_segments(command):
        found.extend(_peel_invocations(argv, truncated))
    return found


# ── chmod's own grammar ────────────────────────────────────────────────

#: The permission letters a MODE may be made of. chmod's mode operand can
#: begin with a dash — `-rwx` REMOVES bits — so a dash-token is only options
#: when it contains something that is not a permission letter.
_MODE_LETTERS = "rwxXst"


#: A chmod MODE, in either spelling. Used only where the command word itself
#: is unreadable, to tell "an unknown program doing -R to /" (this rule) from
#: "an unknown program doing an unrelated recursive thing to /" (not).
_MODE_OPERAND = re.compile(
    r"^(?:[0-7]{1,4}|[ugoa]*[-+=][rwxXstugo]*(?:,[ugoa]*[-+=][rwxXstugo]*)*)$")


def _chmod_recursive_and_targets(args: list[str]) -> tuple[bool, list[str], str]:
    """Walk chmod's arguments: is it recursive, and what does it operate on?

    Returns ``(recursive, targets, mode)``. ``recursive`` is PROVEN: a
    recursive flag standing in readable text in this invocation's own
    arguments. `chmod $(echo -R) 777 /` puts the flag behind a substitution
    and is deliberately not claimed — see _recursive_system_chmod's boundary.
    ``mode`` is the operand chmod would read as the mode (empty under
    `--reference`, which has none); only the unreadable-command-word branch
    needs it, and it comes from THIS walk so there is never a second opinion
    about where chmod's options end.

    Honours chmod's OWN `--` (round 3 allowed a recursive chmod of / written
    with one), `--reference=FILE` (which replaces the mode operand, so every
    operand is then a target), and the mode-vs-option ambiguity above.
    """
    recursive = False
    reference = False
    end_of_options = False
    operands: list[str] = []
    i = 0
    while i < len(args):
        token = args[i]
        i += 1
        if not end_of_options:
            if token == "--":
                end_of_options = True
                continue
            if token.startswith("--") and len(token) > 2:
                name, sep, _inline = token[2:].partition("=")
                if name == "recursive":
                    recursive = True
                elif name == "reference":
                    reference = True
                    if not sep and i < len(args):
                        i += 1
                continue
            if token.startswith("-") and len(token) > 1:
                body = token[1:]
                if all(ch in _MODE_LETTERS for ch in body):
                    operands.append(token)      # a mode, not options
                elif "R" in body:
                    # CASE-SENSITIVE on purpose: `-r` is "remove read".
                    recursive = True
                continue
        operands.append(token)
    # Without --reference the first operand is the mode; the rest are targets.
    if reference:
        return recursive, operands, ""
    return recursive, operands[1:], (operands[0] if operands else "")


#: Top-level directories whose whole tree is the operating system. A DEEPER
#: path (/usr/local/lib/..., a project, a build dir) is deliberately absent:
#: fixing permissions inside a tree is ordinary work and stays a judgment for
#: the classifier, which — unlike this tier — the operator can overrule.
_SYSTEM_TOPLEVEL = frozenset({
    "etc", "usr", "bin", "sbin", "var", "lib", "lib64", "boot", "opt", "dev",
    "proc", "sys", "root", "home", "users", "system", "library", "applications",
})


#: Characters that make a path component name something other than itself —
#: pathname expansion (`/et*`, `/us?`, `/[eu]tc`) and brace expansion
#: (`/{etc,usr}`, `/e{t,x}c`), which the shell performs before chmod ever
#: runs. An operand carrying one is not a literal path, so it is out of this
#: rule's scope.
_GLOB_CHARS = re.compile(r"[*?\[{]")


def _path_parts(target: str) -> list[str]:
    """Resolve a LITERAL path's structure: `.`, `..`, `//` and a trailing `/`.

    `/etc/..` is `/` however it is spelled. Only ever reached for an operand
    already known to carry no expansion and no glob, so nothing here has to
    guess what a component will turn into.
    """
    parts: list[str] = []
    for component in target.split("/"):
        if component in ("", "."):
            continue
        if component == "..":
            if parts:
                parts.pop()
            continue
        parts.append(component)
    return parts


def _is_literal_system_target(target: str) -> bool:
    """Read as written, is this operand `/` or a whole top-level system dir?

    THE RULE'S ENTIRE TARGET SCOPE IS THIS FUNCTION. Two conditions, both
    required, and both readable off the text without running anything:

      * the operand is wholly LITERAL — no command substitution, no backtick,
        no variable, no self-rewriting quote, no `~NAME` (every one of those
        reaches here as an opaque marker), and no glob or brace character
        anywhere in it;
      * spelled out and with `.`, `..`, `//` and a trailing slash resolved, it
        is `/` itself or exactly one top-level system component.

    Everything else answers False, and False here means OUT OF SCOPE, not
    proven harmless. `$(pwd)`, `$HOME/bin`, `"$VIRTUAL_ENV/lib"`, `/et*`,
    `/{etc,usr}`, `~root` and every relative path are handed to the LLM
    classifier, which the operator can overrule and this tier cannot be.

    ROUND 5 ANSWERED THIS DIFFERENTLY AND WAS UNSHIPPABLE. It read an
    unreadable operand's last LITERAL component and denied when that component
    was a top-level system name — but `bin`, `lib`, `var` and `opt` are
    ordinary PROJECT subdirectories, so `chmod -R 755 "$(pwd)/bin"`,
    `$HOME/bin`, `"$VIRTUAL_ENV/lib"` and 25 more ordinary developer commands
    were hard-denied in a tier nobody can override. A mandatory rule that
    fires on ordinary work teaches the operator to switch the whole tier off,
    and then everything is lost — a larger cost than the gap it was closing.
    Meanwhile it still missed deliberately obfuscated forms, and always would:
    `$(printf '/ /tmp')/dist` word-splits into two argv entries, and shell
    expansion cannot be resolved statically at all.
    """
    if _UNKNOWN_MARK in target or _GLOB_CHARS.search(target):
        return False
    if not target.startswith("/"):
        return False
    parts = _path_parts(target)
    return not parts or (len(parts) == 1 and parts[0].lower() in _SYSTEM_TOPLEVEL)


def _recursive_system_chmod(command: str) -> bool:
    """Does this command line recursively chmod a LITERAL system path?

    WHAT THIS RULE COVERS — the whole of it. Both properties must be PROVEN,
    read off the text as written:

      1. an invocation whose COMMAND WORD resolves to chmod — after the
         tokenizer has removed quoting and escapes, after leading assignments
         in any case are dropped, after wrapper words (sudo/env/nice/timeout/
         a shell's -c/eval) are peeled with a table of what each one consumes,
         and after a path is reduced to its basename;
      2. a RECURSIVE flag standing in readable text in that invocation's own
         arguments, honouring chmod's `--` and matched CASE-SENSITIVELY;
      3. an operand that is an unambiguous LITERAL ABSOLUTE path naming `/` or
         a whole top-level system directory — _is_literal_system_target.

    WHAT IT DELIBERATELY DOES NOT COVER. An honest boundary is worth more than
    an implied one, so it is written here rather than left to be discovered:

      * ANY target that is not literal. A command substitution, a backtick, a
        variable, `~NAME`, a glob or a brace ANYWHERE in the operand puts it
        out of scope, and out of scope means ALLOW — `chmod -R 777 $(echo /)`,
        `/et*`, `/{etc,usr}`, `~root`, `/*` and `/etc/*` all reach the
        classifier instead. This is a deliberate reduction in ambition, not an
        oversight: round 5 tried to judge unreadable operands and hard-denied
        28 of 95 ordinary developer commands (`"$(pwd)/bin"`, `$HOME/bin`,
        `"$VIRTUAL_ENV/lib"`) in a tier the operator cannot override.
      * A RECURSIVE FLAG that is not literal — `chmod $(echo -R) 777 /`. The
        same reason: the flag is not proven, and "not proven" is not evidence.
      * Obfuscation in general, permanently. `$(printf '/ /tmp')/dist`
        word-splits into two argv entries; `eval "$CMD"` and `$(cat script)`
        carry no argv at all. Shell expansion cannot be resolved statically,
        so no amount of grammar closes this and none is attempted.
      * chmod reached through find -exec, xargs or a here-document fed to an
        interpreter; a shell function or alias named chmod; a system path
        reached through a symlink; chown, chgrp, setfacl and every other way
        to change permissions.
      * Anything DEEPER than a top-level directory: /usr/local/lib and
        /etc/nginx are ordinary maintenance and are not matched.

    Everything on that list still faces the LLM classifier, the allow tier and
    every other deny rule. None of them is limited to this rule's grammar, and
    the classifier — unlike this tier — the operator can overrule.

    UNREADABLE COMMAND WORD: `$(echo chmod) -R 777 /` hides the program, not
    the operands. Applying chmod's grammar to an unknown program would deny
    `$(which grep) -R needle /etc`, so that branch additionally requires a
    first operand shaped like a chmod MODE — the signature of a chmod whose
    name is being spelled out of reach.

    UNPARSEABLE INPUT — round 4's policy, unchanged: a command whose tail
    cannot be tokenised does NOT silently pass. The prefix that WAS read is
    still walked, and

      * if it already establishes a recursive chmod and the operand is exactly
        what got cut off, the rule ESCALATES and denies. The dangerous shape is
        established; the missing piece cannot make it safe, and a broken quote
        would not have run in the shell either;
      * otherwise the rule ABSTAINS. Denying every unreadable line instead
        would fire this un-overridable tier on ordinary broken quoting.
    """
    # Fast path: the tokenizer only ever REMOVES characters (quotes, escapes),
    # so a token that resolves to chmod cannot come from text with no c in it
    # — UNLESS the word arrives from an expansion, whose text is not here at
    # all. Both halves are required for this shortcut to stay sound.
    if not command:
        return False
    if "c" not in command.lower() and not any(h in command for h in _EXPANSION_HINT):
        return False
    for word, args, truncated in _invocations(command):
        unknown_word = _UNKNOWN_MARK in word
        if word != "chmod" and not unknown_word:
            continue
        recursive, targets, mode = _chmod_recursive_and_targets(args)
        if not recursive:
            continue
        if unknown_word and not _MODE_OPERAND.match(mode):
            continue
        if any(_is_literal_system_target(target) for target in targets):
            return True
        # Round 4: a recursive chmod whose operand is exactly what got cut off.
        # Only for a chmod that is named as such — an unreadable command word
        # with an unreadable tail establishes nothing at all.
        if truncated and not targets and not unknown_word:
            return True
    return False


#: Pattern carried by a rule whose decision belongs to a structural guard.
#: Every rule must have a compilable pattern (the schema and the mandatory-tier
#: integrity check both require one) but this rule's must never match anything
#: on its own: a pattern that decided as well as the guard would be a second,
#: weaker definition of the same rule, and two definitions is how the last
#: round was lost.
_STRUCTURAL_ONLY = r"(?!)"


# ─── Evaluation ─────────────────────────────────────────────────────────

def _tool_classification(
    tool_name: str,
    tool_input: dict,
    tool_semantics=None,
    *,
    audit_unknown: bool = True,
):
    from tool_semantics import COMMON_TOOL_SEMANTICS, classify_tool_call

    semantics = COMMON_TOOL_SEMANTICS if tool_semantics is None else tool_semantics
    return classify_tool_call(
        tool_name,
        tool_input,
        tool_semantics=semantics,
        audit_unknown=audit_unknown,
    )


def _canonical_tool_name(tool_name: str, tool_semantics=None) -> str:
    # Rule-side aliases are metadata, not observed tool calls; canonicalizing
    # them must not consume or emit an unknown-shape audit slot.
    classification = _tool_classification(
        tool_name, {}, tool_semantics, audit_unknown=False
    )
    return classification.operation or tool_name.strip().lower()


def _tool_matches(
    tool_name: str,
    tool_match: str,
    tool_input: dict | None = None,
    tool_semantics=None,
) -> bool:
    """Check if a tool name matches a rule's tool_match pattern."""
    if tool_match == "*":
        return True
    candidates = [_canonical_tool_name(t) for t in tool_match.split("|")]
    classification = _tool_classification(tool_name, tool_input or {}, tool_semantics)
    canonical = classification.operation or tool_name.strip().lower()
    return canonical in candidates


def _extract_match_field(tool_name: str, tool_input: dict, tool_semantics=None) -> str:
    """Extract the classifier's canonical command/path/pattern/URL target."""
    return _tool_classification(tool_name, tool_input, tool_semantics).primary_target


def _expects_target(tool_name: str, tool_input: dict | None = None, tool_semantics=None) -> bool:
    """True when this tool is defined by a command/path/pattern/URL argument.

    Such a tool arriving WITHOUT one is malformed and worth stopping for.
    Every other tool simply has nothing for command-and-path rules to match.
    """
    classification = _tool_classification(tool_name, tool_input or {}, tool_semantics)
    return classification.operation in {"read", "mutate", "execute"}


def _is_command_tool(tool_name: str, tool_input: dict | None = None, tool_semantics=None) -> bool:
    """Check if this tool is a shell command tool (needs normalization)."""
    classification = _tool_classification(tool_name, tool_input or {}, tool_semantics)
    if classification.operation != "execute":
        return False
    return any(
        key not in {"script_path", "executable_path"}
        for key, _value in classification.targets
    )


def _match_rule(
    rules,
    action: str,
    tool_name: str,
    tool_input: dict,
    default_field: str,
    match_variants,
    compiled_patterns=None,
    tool_semantics=None,
    structural_sources=None,
):
    """Return (rule, matched_input) for the first rule with ``action`` that
    matches this call, or (None, None). Pure matching logic shared by the
    deny-pass and allow-pass — no decision construction here.

    ``rules`` is already sorted workspace-first then by severity (critical
    first), so "first match" == highest-severity match within the action tier.
    """
    for rule in rules:
        if rule.action != action:
            continue
        if not _tool_matches(tool_name, rule.tool_match, tool_input, tool_semantics):
            continue

        if rule.pattern_field:
            raw_target = tool_input.get(rule.pattern_field, "")
        else:
            raw_target = default_field
        if not raw_target:
            continue

        # A guarded rule is decided by PARSING the command, not by its pattern.
        # The pattern is not consulted at all: any prefilter would have to be a
        # regex over the raw text, and a regex over the raw text is what keeps
        # being wrong — `'chm''od'` and `ch\mod` are chmod to the shell and to
        # the tokenizer, and to no pattern. Sources are whole command lines
        # (the call's own, plus dry-run resolutions of it); the guard does its
        # own splitting, because the normalizer's textual split cuts inside
        # quotes and would hand the guard a broken fragment of a commit message.
        guard = _STRUCTURAL_GUARDS.get(rule.id)
        if guard is not None:
            sources = structural_sources or [raw_target]
            if any(guard(source) for source in sources if source):
                return rule, (default_field if match_variants and not rule.pattern_field
                              else raw_target)
            continue

        compiled = (compiled_patterns or _cache._compiled).get(rule.id)
        if not compiled:
            continue

        # Command tools: check every normalized segment (bypass-resistant).
        if match_variants and not rule.pattern_field:
            for variant in match_variants:
                if compiled.search(variant):
                    return rule, default_field
        else:
            if compiled.search(raw_target):
                return rule, raw_target

    return None, None


async def evaluate_mandatory(
    tool_name: str,
    tool_input: dict,
    *,
    env_hints: Optional[dict] = None,
    tool_semantics=None,
) -> SafetyDecision:
    """Evaluate only the immutable code-owned hard-deny boundary."""

    return await evaluate(
        tool_name,
        tool_input,
        enable_classifier=False,
        env_hints=env_hints,
        tool_semantics=tool_semantics,
        _mandatory_only=True,
    )


async def evaluate(
    tool_name: str,
    tool_input: dict,
    workspace_id: Optional[str] = None,
    *,
    classify_fn=None,
    enable_classifier: bool = True,
    classifier_context: Optional[dict] = None,
    env_hints: Optional[dict] = None,
    tool_semantics=None,
    _mandatory_only: bool = False,
) -> SafetyDecision:
    """Evaluate a tool call against safety rules — TIERED.

    Tier order (replaces the old single highest-severity pass):
      Pass A — DENY rules. First matching deny wins (explicit DENY list +
               the catastrophic deny builtins that mirror Tier-1). This runs
               FIRST so a deny is never overridden by an allow rule or the
               classifier. The classifier can never UPGRADE a deny to allow.
      Pass B — ALLOW rules. First matching allow wins (explicit ALLOW list).
               An explicit allow short-circuits the classifier.
      Pass C — CLASSIFIER. No deny, no allow matched (the gray zone the
               retired heuristic "ask" rules used to fill). Hand the call to
               the cheap LLM classifier (safety_classifier.classify) →
               allow|ask|deny. THIS is where false positives die: cd+git no
               longer has a heuristic ask rule, so it reaches the classifier,
               which says allow.
      Floor  — classifier intentionally disabled and every deny tier passed → allow.

    For Bash/execute tools the command is normalized before matching:
    pushd→cd, subshells extracted, compound commands split into segments;
    each segment is checked independently so bypass variants are caught.

    ``classify_fn`` is injectable for tests (default lazy-imports
    safety_classifier.classify). ``classifier_context`` carries model /
    fail_mode / hints through to the classifier (keeps the engine db-free).
    ``env_hints`` is an optional {var: value} snapshot the hook forwards
    (secrets pre-redacted) for the variable resolver.
    """
    start = time.monotonic()

    if not isinstance(tool_name, str) or not tool_name.strip() or not isinstance(tool_input, dict):
        return SafetyDecision(
            action="deny",
            reason="malformed safety operation (fail-closed)",
            severity="critical",
            latency_ms=int((time.monotonic() - start) * 1000),
            failure_closed=True,
        )

    classification = _tool_classification(tool_name, tool_input, tool_semantics)
    default_field = classification.primary_target
    if not default_field:
        # A tool that exposes no command, path, pattern or URL cannot match a
        # rule that is written about commands and paths. Asking the operator
        # here produced a dead-end prompt on every call of tools like
        # ScheduleWakeup or a notification sender — prompts that carry no
        # information and only train click-through, which is worse for safety
        # than not asking. ASK is kept only where a target was EXPECTED and is
        # missing, which is genuinely malformed.
        if classification.operation in {"read", "mutate", "execute"}:
            return SafetyDecision(
                action="ask",
                reason="operation has no analyzable target (fail-closed)",
                severity="high",
                latency_ms=int((time.monotonic() - start) * 1000),
                failure_closed=True,
            )
        return SafetyDecision(
            action="allow",
            reason=(
                f"{tool_name} exposes no command, path or URL for the safety "
                "rules to evaluate"
            ),
            latency_ms=int((time.monotonic() - start) * 1000),
        )
    is_cmd = _is_command_tool(tool_name, tool_input, tool_semantics)
    match_variants = _normalize_command(default_field) if (is_cmd and default_field) else None

    # ── Variable resolution (0-token dry-run) ────────────────────────────
    # Expand $VARs so the DENY pass matches what WOULD run — e.g.
    # `rm -rf "$DIR/"` with DIR unset collapses to `rm -rf /`, which the
    # catastrophic regexes then catch offline. Resolution feeds ONLY the
    # deny pass and the classifier context: an allow rule never matches a
    # resolved variant, so resolution can make the gate stricter but never
    # looser.
    resolution = None
    url_facts = None
    resolution_error = False
    deny_variants = match_variants
    # Structural guards get WHOLE command lines — never the normalizer's
    # segments, which are split textually and can cut a quoted string in half.
    # They get the call AS WRITTEN plus the dry-run's RESOLVED variant, which
    # substitutes only values the hook actually supplied. The WORST-CASE
    # variant is deliberately withheld: it is a guess that every unread
    # variable is empty, so it turns `chmod -R 755 "$VIRTUAL_ENV/lib"` into a
    # recursive chmod of /lib and hard-denies it. That guess is the exact
    # unknown-reads-as-dangerous move round 6 removed from the guard itself,
    # and re-importing it through the resolver would put back the false
    # positives on an un-overridable tier. The regex deny pass still sees the
    # worst case (deny_variants below), so `rm -rf "$DIR/"` is unaffected.
    structural_sources = [default_field] if (is_cmd and default_field) else None
    if classification.target_for("url") and default_field:
        try:
            from safety_resolver import resolve_url as _resolve_url  # lazy

            url_facts = _resolve_url(default_field)
        except Exception:
            url_facts = None
            resolution_error = True
    if is_cmd and default_field:
        try:
            from safety_resolver import resolve as _resolve  # lazy

            resolution = _resolve(default_field, env=env_hints)
            proven = resolution.get("resolved")
            if proven and structural_sources and proven not in structural_sources:
                structural_sources.append(proven)
            extra = []
            for variant in resolution.get("match_variants") or []:
                for seg in _normalize_command(variant):
                    if seg not in (match_variants or []) and seg not in extra:
                        extra.append(seg)
            if extra:
                deny_variants = (match_variants or []) + extra
        except Exception:
            resolution = None
            resolution_error = True

    def _decision(action, rule, matched_input):
        elapsed = int((time.monotonic() - start) * 1000)
        return SafetyDecision(
            action=action,
            reason=f"{rule.name}: {rule.description}",
            rule_id=rule.id,
            rule_name=rule.name,
            severity=rule.severity,
            matched_input=matched_input,
            latency_ms=elapsed,
        )

    # ── Mandatory hard deny — code-owned and independent of DB/feature flag ──
    try:
        mandatory_rules, mandatory_compiled = _mandatory_rule_set()
        deny_rule, deny_input = _match_rule(
            mandatory_rules,
            "deny",
            tool_name,
            tool_input,
            default_field,
            deny_variants,
            mandatory_compiled,
            tool_semantics,
            structural_sources,
        )
    except Exception as exc:
        logger.error("Mandatory safety rules unavailable: %s", exc)
        return SafetyDecision(
            action="deny",
            reason="mandatory safety rules unavailable (fail-closed)",
            severity="critical",
            latency_ms=int((time.monotonic() - start) * 1000),
            failure_closed=True,
        )
    if deny_rule is not None:
        decision = _decision("deny", deny_rule, deny_input)
        if resolution and resolution.get("notes"):
            decision.reason += " [dry-run: " + "; ".join(resolution["notes"][:2]) + "]"
        return decision

    if resolution_error:
        return SafetyDecision(
            action="ask",
            reason="operation resolution failed (fail-closed)",
            severity="high",
            matched_input=default_field,
            latency_ms=int((time.monotonic() - start) * 1000),
            failure_closed=True,
        )

    if _mandatory_only:
        return SafetyDecision(
            action="allow",
            reason="mandatory hard-deny rules passed",
            matched_input=default_field,
            latency_ms=int((time.monotonic() - start) * 1000),
        )

    try:
        rules = await _cache.get_rules(workspace_id)
    except RuleLoadError as exc:
        logger.error("Safety evaluation blocked: %s", exc)
        return SafetyDecision(
            action="ask",
            reason="safety rules unavailable (fail-closed)",
            severity="critical",
            matched_input=default_field,
            latency_ms=int((time.monotonic() - start) * 1000),
            failure_closed=True,
        )

    # ── Dynamic DENY rules remain active even with the classifier flag off. ──
    if rules:
        deny_rule, deny_input = _match_rule(
            rules, "deny", tool_name, tool_input, default_field, deny_variants,
            tool_semantics=tool_semantics, structural_sources=structural_sources,
        )
        if deny_rule is not None:
            decision = _decision("deny", deny_rule, deny_input)
            # A deny that fired via a resolved variant would otherwise cite a
            # pattern the raw command doesn't visibly contain — say why.
            if resolution and resolution.get("notes"):
                decision.reason += (
                    " [dry-run: " + "; ".join(resolution["notes"][:2]) + "]"
                )
            return decision

    # A native name absent from the active profile is an integration gap, not
    # an authorization signal.  Its suspicious shape has already gone through
    # the immutable and configured DENY passes above; require a human for what
    # remains instead of reaching either an allow rule, the LLM, or the
    # classifier-disabled allow floor.
    if classification.inferred and classification.operation in {"mutate", "execute"}:
        return SafetyDecision(
            action="ask",
            reason=(
                f"Unknown {classification.operation}-shaped tool "
                f"{tool_name} requires confirmation"
            ),
            rule_id="unknown_tool_shape",
            rule_name="Unknown Tool Shape",
            severity="high",
            matched_input=default_field,
            latency_ms=int((time.monotonic() - start) * 1000),
        )

    if rules:
        if not enable_classifier:
            return SafetyDecision(
                action="allow",
                reason="mandatory and configured deny rules passed; classifier disabled",
                matched_input=default_field,
                latency_ms=int((time.monotonic() - start) * 1000),
            )

        # ── Pass B — ASK (explicit confirm list) ─────────────────────────
        # The heuristic ask BUILTINS were retired in favour of the classifier,
        # but the ask ACTION was left with no pass to match it — so every
        # user-authored ask rule, and any builtin that needs a human rather than
        # a model (turning off sandbox isolation), was silently ignored.
        #
        # ASK RUNS BEFORE ALLOW, deliberately. Normalization hands the allow pass
        # a SANITIZED candidate ("IVE_APP_WORKSPACE_READONLY=0 npm run dev"
        # yields "npm run dev" with the env prefix stripped), so an allow rule as
        # narrow as ^npm run dev$ would otherwise match that candidate and return
        # before the ask pass ran — silently turning off isolation, which is the
        # exact chain the ask rule exists to interrupt. An allowlist is an opt-out
        # from the classifier's gray zone, not a way to skip an explicit confirm.
        # A human's prior approval of THIS input still downgrades it to allow.
        ask_rule, ask_input = _match_rule(
            rules, "ask", tool_name, tool_input, default_field, deny_variants,
            tool_semantics=tool_semantics,
        )
        if ask_rule is not None:
            return _decision("ask", ask_rule, ask_input)

        # ── Pass C — ALLOW (explicit allow list; short-circuits the classifier) ──
        allow_rule, allow_input = _match_rule(
            rules, "allow", tool_name, tool_input, default_field, match_variants,
            tool_semantics=tool_semantics,
        )
        if allow_rule is not None:
            return _decision("allow", allow_rule, allow_input)

    # ── Pass C — CLASSIFIER (the gray zone) ──────────────────────────────
    if enable_classifier and default_field:
        try:
            if classify_fn is None:
                from safety_classifier import classify as classify_fn  # lazy
            _cls_ctx = dict(classifier_context or {})
            if tool_semantics is not None:
                _cls_ctx.setdefault("tool_semantics", tool_semantics)
            if resolution and (resolution.get("changed") or resolution.get("unresolved")
                               or resolution.get("sourced_vars")):
                _cls_ctx.setdefault("resolved_command", resolution.get("resolved"))
                if resolution.get("worst_case"):
                    _cls_ctx.setdefault("worst_case_command", resolution["worst_case"])
                if resolution.get("notes"):
                    _cls_ctx.setdefault("resolution_notes", resolution["notes"])
                if resolution.get("unresolved"):
                    _cls_ctx.setdefault("unresolved_vars", resolution["unresolved"])
            if url_facts:
                _cls_ctx.setdefault("url_facts", url_facts)
            verdict = await classify_fn(
                tool_name, tool_input, context=_cls_ctx
            )
        except Exception:
            # classify() is total, but belt-and-braces: errors never authorize.
            verdict = {
                "decision": "ask",
                "reason": "classifier error (fail-closed)",
                "error": True,
            }

        from safety_classifier import SYNTHETIC_RULE_ID, SYNTHETIC_RULE_NAME

        action = str(verdict.get("decision", "ask")).lower()
        if action not in ("allow", "ask", "deny"):
            action = "ask"
            verdict["error"] = True
        reason = str(verdict.get("reason", "") or "classifier verdict")

        elapsed = int((time.monotonic() - start) * 1000)
        return SafetyDecision(
            action=action,
            # rule_id set only for ask/deny so the approval/log/event path keys
            # on the synthetic id; an allow stays rule_id=None (a clean
            # "no matching rule" allow, still eligible for the auto-mode upgrade).
            reason=f"LLM safety classifier: {reason}",
            rule_id=SYNTHETIC_RULE_ID if action in ("ask", "deny") else None,
            rule_name=SYNTHETIC_RULE_NAME if action in ("ask", "deny") else None,
            severity="medium" if action in ("ask", "deny") else None,
            matched_input=default_field,
            latency_ms=elapsed,
            precedent_decision_ids=list(verdict.get("precedent_decision_ids") or []),
            precedent_reason=str(verdict.get("precedent_reason") or ""),
            precedent_class=str(verdict.get("precedent_class") or ""),
            operator_policy_ids=list(verdict.get("operator_policy_ids") or []),
            failure_closed=bool(verdict.get("error")),
        )

    elapsed = int((time.monotonic() - start) * 1000)
    return SafetyDecision(
        action="allow",
        reason="mandatory and configured deny rules passed; classifier disabled",
        matched_input=default_field,
        latency_ms=elapsed,
    )


# ─── Builtin rules ─────────────────────────────────────────────────────

def _rule_id(name: str) -> str:
    """A builtin's id follows from its NAME — one definition, so the guard
    registry below and the rule row can never drift apart."""
    return f"builtin-{uuid.uuid5(uuid.NAMESPACE_DNS, name).hex[:12]}"


def _rule(name, desc, category, severity, tool_match, pattern, action="deny", pattern_field=""):
    return {
        "id": _rule_id(name),
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
        "Recursive permission change on a system path",
        "chmod -R against / or a top-level system directory — irreversible, and it "
        "breaks the OS whether the mode widens or narrows",
        "dangerous_command", "critical", "Bash",
        # DECIDED BY A STRUCTURAL GUARD, NOT BY THIS PATTERN.
        #
        # Three rounds of regex were refuted three times, each by a different
        # rephrasing, and the third round failed in BOTH directions at once:
        # 9 of 42 catastrophic spellings passed (a lower-case assignment
        # prefix, chmod's own `--`, a quoted mode, a quoted command word) while
        # 4 ordinary commands were denied. The pattern is not the fix for the
        # pattern: what those spellings differ in is STRUCTURE, and shell
        # grammar is not a regular language.
        #
        # _recursive_system_chmod (above) decides instead, on the parsed
        # command. It denies exactly three things together, so ordinary work
        # cannot trip it:
        #   1. an invocation whose COMMAND WORD resolves to chmod — after the
        #      tokenizer has removed quoting and escapes, after leading
        #      assignments are dropped, after wrapper words (sudo/env/nice/
        #      timeout/a shell's -c/eval) are peeled with a table of what each
        #      one consumes, and after a path is reduced to its basename. The
        #      word inside a string argument is not an invocation, so quoting a
        #      command in a grep, an echo or a commit message stays allowed;
        #   2. a RECURSIVE flag in that invocation's OWN arguments, honouring
        #      chmod's `--`, matched CASE-SENSITIVELY: `-r` is "remove read"
        #      and `-rwx` is a mode operand, not options — R is not a
        #      permission letter, so only an upper-case R in a dash-token that
        #      is not all permission letters means recursion;
        #   3. an operand that is an unambiguous LITERAL ABSOLUTE path naming
        #      / or a whole top-level system directory. This is the
        #      false-positive brake: a DEEPER path (/usr/local/lib/node_modules,
        #      a build dir, a home project) is deliberately not matched —
        #      fixing permissions inside a tree is ordinary work and stays a
        #      judgment for the classifier, which the operator can overrule and
        #      this tier cannot be.
        #
        # ROUND 6 NARROWED (3) TO LITERAL TARGETS ONLY, and this is a
        # deliberate reduction in ambition rather than a failure to try.
        # Rounds 4-5 tried to judge operands they could not read: round 5 fell
        # back on the last LITERAL component of an unreadable path and denied
        # when it was a top-level system name. But `bin`, `lib`, `var` and
        # `opt` are ordinary PROJECT subdirectories, so 28 of 95 ordinary
        # developer commands were HARD-DENIED — `chmod -R 755 "$(pwd)/bin"`,
        # `$HOME/bin`, `"$VIRTUAL_ENV/lib"`, `"$RAILS_ROOT/bin"` and the rest —
        # in a tier no operator can override. That gets the whole tier switched
        # off, and then everything is lost. It is a larger cost than the gap it
        # closed, especially since it never closed the deliberate cases anyway:
        # `$(printf '/ /tmp')/dist` word-splits into two argv entries, and
        # shell expansion cannot be resolved statically at any effort.
        #
        # So a non-literal target is now simply OUT OF THIS RULE'S SCOPE — not
        # "unknown, therefore deny", which is what produced the 29%. Both
        # properties must be PROVEN in readable text: the recursive flag and
        # the literal system path.
        #
        # WHAT THIS RULE DOES NOT COVER — an honest boundary is worth more
        # than an implied one. It is a rule about ONE program's argv, and:
        #   * ANY non-literal target. A substitution, a backtick, a variable,
        #     `~NAME`, a glob or a brace anywhere in the operand takes it out
        #     of scope: `chmod -R 777 $(echo /)`, `/et*`, `/{etc,usr}`,
        #     `~root`, `/*` and `/etc/*` all go to the classifier. The rule can
        #     tell that an operand is unreadable; it can never tell that an
        #     unreadable operand is dangerous, and guessing costs more than it
        #     pays;
        #   * a non-literal RECURSIVE flag — `chmod $(echo -R) 777 /`. Same
        #     reason: not proven is not evidence;
        #   * chmod reached through find -exec, xargs, or a here-document fed
        #     to an interpreter — the target arrives from a traversal or on
        #     stdin, not in this argv;
        #   * a shell function or alias named chmod, and a system path reached
        #     through a symlink;
        #   * chown, chgrp, setfacl and every other way to change permissions:
        #     only chmod's grammar is walked, plus an unreadable command word
        #     carrying `-R` and a chmod-shaped MODE;
        #   * anything DEEPER than a top-level directory — /usr/local/... and
        #     /etc/nginx are not matched, on purpose;
        #   * a command whose ENTIRE text arrives from an expansion —
        #     `$(echo chmod -R 777 /)`, `eval "$CMD"`, `$(cat script)`. There
        #     is no argv to walk: the marker stands alone where a program name
        #     goes, with nothing beside it to establish either recursion or a
        #     target. This is the same family as an interpreter reading stdin,
        #     and no grammar closes it — only the classifier sees that text.
        #     A substituted command word WITH arguments and a literal target
        #     (`$(echo chmod) -R 777 /`) is a different shape and IS covered.
        # All of these still face the LLM classifier, which — unlike this tier
        # — the operator can overrule.
        #
        # The pattern below is never consulted for this rule — see the guard
        # branch in _match_rule. It stays a compilable, never-matching
        # expression because the schema and the mandatory-tier integrity check
        # require every rule to carry one, and because a rule row that silently
        # matched something OTHER than the guard would be a second definition
        # of this rule — which is how round 2 was lost.
        _STRUCTURAL_ONLY,
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
        # Anchored to COMMAND position (start of a segment, or right after a
        # shell separator), optionally via sudo or an absolute path. A bare word
        # match blocked reading code: `grep "async def shutdown" f.py` and
        # `pb.shutdown()` both tripped the old rule, and no classifier could
        # rescue them because this tier is pure regex that runs first.
        # The trailing lookahead makes the WHOLE executable name the match:
        # "\b" alone let ./scripts/reboot-docs.sh through as a "reboot".
        r"(?:^|[;&|]\s*)(?:sudo\s+)?(?:\S*/)?(?:shutdown|reboot|halt|poweroff)(?=$|[\s;&|])"
        r"|(?:^|[;&|]\s*)(?:sudo\s+)?init\s+[06]\b",
    ),
    _rule(
        "Pipe to shell",
        "Downloading and piping directly to shell execution",
        "dangerous_command", "critical", "Bash",
        r"(curl|wget)\s+.*\|\s*(ba)?sh\b",
    ),
    _rule(
        "Kill init process",
        "Killing PID 1 can crash the system",
        "dangerous_command", "high", "Bash",
        r"kill\s+(-[a-zA-Z]*9[a-zA-Z]*\s+)?1\b",
    ),

    # ── Destructive git (Bash) ───────────────────────────────────────────
    # NOTE: the heuristic "ask" git rules (force push, hard reset, force clean,
    # force delete branch, and the false-positive "Compound cd + git → bare
    # repository attack") were RETIRED — they are pure regex guesses that fired
    # on routine agent work. Those gray-zone calls now fall through to the LLM
    # safety classifier (safety_classifier.classify), which judges the actual
    # branch/target instead of pattern-matching. See seed_builtin_rules' stale-
    # builtin reconciliation, which removes the retired rows from existing DBs.

    # ── Sandbox policy downgrades (any tool) ─────────────────────────────
    # ASK, not deny: the operator legitimately needs these switches. But the
    # AGENT RUNS OUTSIDE the sandboxes it starts, so it can edit .env / restart
    # the server, and the content it reads BACK from a sandbox (build logs,
    # dependency output) is untrusted. Without this, the chain "build fails with
    # EROFS -> log says set IVE_APP_WORKSPACE_READONLY=0 -> agent obliges" turns
    # off the isolation with nobody deciding that. One human confirmation is the
    # whole point; a named env var is an exact token, not a heuristic guess, so
    # this does not reintroduce the false-positive class the ask rules were
    # retired for.
    _rule(
        "Sandbox isolation downgrade",
        "Turns off sandbox isolation or egress restriction — confirm this is you, "
        "not something a build log or dependency asked for",
        "custom", "high", "Bash|execute|execute_command|run_command|shell_execute",
        # Anchored to an assignment actually being MADE: at command position or
        # after a separator, optionally via sudo/export. A bare mention does not
        # count — quoting the variable in a grep, a doc, or an API payload is
        # reading about the switch, not throwing it.
        #
        # Writing it into an .env file is deliberately NOT matched here. That text
        # is byte-identical whether the command performs the write or merely
        # describes it, so a regex cannot tell them apart — it fired on this
        # feature's own test payloads twice. Intent is the classifier's job, and
        # its prompt now treats privilege downgrades (including edits to env files
        # and start scripts) as ask, with the rule that instructions found in file
        # content or tool output are never authorization.
        # The prefix allows the ways an assignment actually reaches a process:
        # bare, via sudo (with flags), via env/-i (with flags), via export, and
        # with the whole assignment quoted. `env VAR=0 cmd` slipped through an
        # earlier version because the anchor only tolerated sudo/export.
        r"(?:^|[;&|]\s*)(?:sudo\s+(?:-\S+\s+)*)?(?:(?:\S*/)?env\s+(?:-\S+\s+)*)?"
        r"(?:export\s+)?[\"']?"
        r"(?:IVE_APP_WORKSPACE_READONLY|EGRESS_PROXY_ENFORCE|SANDBOX_FAIL_CLOSED)"
        r"\s*=\s*[\"']?(?:0|false|off|no)\b"
        r"|(?:^|[;&|]\s*)(?:sudo\s+(?:-\S+\s+)*)?(?:(?:\S*/)?env\s+(?:-\S+\s+)*)?"
        r"(?:export\s+)?[\"']?IVE_EGRESS_ALLOW_UNFILTERED"
        r"\s*=\s*[\"']?(?:1|true|on|yes)\b",
        action="ask",
        # Scoped to tools that RUN something. With tool_match="*" and no field,
        # the pattern was also tested against a Grep pattern or a WebSearch
        # query, so looking the variable up prompted for confirmation.
        pattern_field="command",
    ),

    # ── SQL destructive (Bash) ───────────────────────────────────────────
    _rule(
        "DROP TABLE/DATABASE",
        "Dropping tables or databases is irreversible",
        "sql_destructive", "critical", "Bash",
        r"DROP\s+(TABLE|DATABASE|SCHEMA)",
    ),
    # NOTE: "TRUNCATE TABLE" + "DELETE without WHERE" heuristic asks RETIRED —
    # regex-fragile; the classifier now judges these gray-zone SQL calls.

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
    # NOTE: the heuristic "ask" protected-path rules (Environment file, Shell
    # config), the credential "ask" rules (Private key file, Credentials file),
    # and the network "ask" rules (Suspicious TLD, Direct IP URL) were RETIRED.
    # These were the rest of the heuristic-ask false-positive class; the LLM
    # safety classifier now owns the gray zone (e.g. a .env edit inside the
    # project vs. exfiltration is a judgment, not a path regex). Catastrophic /
    # explicit-deny protected paths (.ssh/, /etc/, .git/) STAY as deny above.
]


#: Rules decided by PARSING the command instead of matching their pattern.
#: Code-owned and keyed by rule id, so the guard travels with the rule through
#: the DB copy the operator can see and reorder but not weaken: a row whose
#: pattern was edited already fails the mandatory-tier integrity check, and a
#: row that kept its id keeps its guard.
_STRUCTURAL_GUARDS = {
    _rule_id("Recursive permission change on a system path"): _recursive_system_chmod,
}


_MANDATORY_RULE_CACHE: tuple[list[SafetyRule], dict[str, re.Pattern]] | None = None


def _mandatory_rule_set() -> tuple[list[SafetyRule], dict[str, re.Pattern]]:
    """Compile the immutable hard-deny tier directly from code."""
    global _MANDATORY_RULE_CACHE
    if _MANDATORY_RULE_CACHE is not None:
        return _MANDATORY_RULE_CACHE
    rules: list[SafetyRule] = []
    compiled: dict[str, re.Pattern] = {}
    for raw in BUILTIN_RULES:
        if raw["action"] != "deny":
            continue
        rule = SafetyRule(
            id=raw["id"],
            name=raw["name"],
            description=raw["description"],
            category=raw["category"],
            severity=raw["severity"],
            tool_match=raw["tool_match"],
            pattern=raw["pattern"],
            pattern_field=raw["pattern_field"],
            action="deny",
            enabled=True,
            is_builtin=True,
            workspace_id=None,
        )
        try:
            compiled[rule.id] = re.compile(rule.pattern, re.IGNORECASE)
        except re.error as exc:
            raise RuleLoadError(f"mandatory rule {rule.id} has an invalid regex") from exc
        rules.append(rule)
    if not rules:
        raise RuleLoadError("mandatory hard-deny rule set is empty")
    _MANDATORY_RULE_CACHE = (rules, compiled)
    return _MANDATORY_RULE_CACHE


async def validate_required_rules(db) -> int:
    """Validate the durable rule snapshot used by evaluation/readiness."""
    cursor = await db.execute("SELECT * FROM safety_rules")
    rows = await cursor.fetchall()
    rules, _ = _build_rule_set(rows)
    _mandatory_rule_set()
    return len(rules)


async def seed_builtin_rules(db):
    """Insert/refresh builtin rules and RETIRE stale ones.

    The upsert now also syncs ``action`` and ``enabled`` (in addition to
    pattern/description) so flipping or disabling a builtin in BUILTIN_RULES
    actually takes effect on re-seed. This is needed because the heuristic
    "ask" builtins were retired in favor of the LLM classifier — without
    syncing action, an existing DB would keep the old noisy ask rows.

    Reconciliation: any builtin row whose id is no longer in BUILTIN_RULES
    (the retired heuristic asks: Compound cd+git, Recursive delete, chmod
    777/-R, force push/reset/clean/branch -D, TRUNCATE/DELETE, .env/shell-
    config/private-key/credentials, suspicious-TLD/IP) is DELETED so the
    classifier owns those judgments on existing installs.

    Scoped to is_builtin=1 throughout so user-authored custom rules are never
    touched, even if they happen to share an id namespace.
    """
    for rule in BUILTIN_RULES:
        await db.execute(
            """INSERT INTO safety_rules
               (id, name, description, category, severity, tool_match,
                pattern, pattern_field, action, enabled, is_builtin, workspace_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name,
                 pattern = excluded.pattern,
                 description = excluded.description,
                 category = excluded.category,
                 severity = excluded.severity,
                 tool_match = excluded.tool_match,
                 pattern_field = excluded.pattern_field,
                 action = excluded.action,
                 enabled = excluded.enabled,
                 is_builtin = excluded.is_builtin,
                 workspace_id = NULL
               WHERE safety_rules.is_builtin = 1""",
            (
                rule["id"], rule["name"], rule["description"],
                rule["category"], rule["severity"], rule["tool_match"],
                rule["pattern"], rule["pattern_field"], rule["action"],
                rule["enabled"], rule["is_builtin"], rule["workspace_id"],
            ),
        )

    # Retire stale builtins (the heuristic "ask" rules now owned by the
    # classifier). Only builtin rows are reconciled; custom rules are left as-is.
    current_ids = [r["id"] for r in BUILTIN_RULES]
    placeholders = ",".join("?" for _ in current_ids)
    await db.execute(
        f"DELETE FROM safety_rules WHERE is_builtin = 1 AND id NOT IN ({placeholders})",
        current_ids,
    )

    await db.commit()
    invalidate_cache()
    logger.info("Seeded %d builtin safety rules (mandatory denies + explicit confirms)",
                len(BUILTIN_RULES))
