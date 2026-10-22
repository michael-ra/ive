"""Extract structured events from raw PTY terminal output."""

import codecs
import re
import time
import logging
from collections import defaultdict, deque

from terminal_screen import TerminalScreen

logger = logging.getLogger(__name__)

# Cursor-position sequences (CUP: \x1b[row;colH or \x1b[rowH) — these
# represent line boundaries in Ink-rendered UI, so replace with \n rather
# than stripping to preserve visual layout.
CURSOR_POS_RE = re.compile(r'\x1b\[\d+(?:;\d+)?H')

# All other ANSI/terminal escape sequences — stripped entirely.
# Includes CSI with optional ?/>/=/! modifiers, OSC, charset selectors,
# and stray control chars (\r, SO, SI).
ANSI_RE = re.compile(r'\x1b\[[?>=!]?[0-9;]*[a-zA-Z~]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x0f|\x0e|\r')

# Collapse runs of blank lines left after sequence replacement
MULTI_NEWLINE_RE = re.compile(r'\n{3,}')

# Unicode Block Elements (U+2580–U+259F) — used exclusively for TUI ASCII-art
# logos (e.g. Claude Code's banner: ▗ ▖ ▘ ▝).  They carry no semantic value
# in text and appear as garbage when the buffer is read programmatically.
BLOCK_ELEMENTS_RE = re.compile(r'[▀-▟]')


def strip_ansi(text: str) -> str:
    # First: turn cursor-position jumps into newlines to preserve layout
    text = CURSOR_POS_RE.sub('\n', text)
    # Then: strip all remaining escape sequences
    text = ANSI_RE.sub('', text)
    # Strip TUI block-element art characters (Claude Code banner, etc.)
    text = BLOCK_ELEMENTS_RE.sub('', text)
    # Collapse excessive blank lines
    text = MULTI_NEWLINE_RE.sub('\n\n', text)
    return text

# Pattern matchers — tool calls, agents, edits, and compaction events are
# now detected by CLI lifecycle hooks (PreToolUse/PostToolUse/SubagentStart/
# SubagentStop/PreCompact/PreCompress). Quota-looking prose is advisory only:
# terminal text is not trusted to move credentials.
ERROR_RE = re.compile(r'(?:Error|Exception|Traceback|FAILED|panic)', re.IGNORECASE)
# Anchored on the actual phrasings the two CLIs (and the underlying APIs)
# emit when usage is exhausted. Bare keywords like "quota_exceeded" or
# "RESOURCE_EXHAUSTED" appear constantly in implementation discussions,
# code, and docs — matching them caused a false-positive auto-failover
# (account marked quota_exceeded with no real signal). Each alternative
# below is distinctive enough to only show up in real CLI error output.
QUOTA_RE = re.compile(
    # Claude Code surface ("Claude AI usage limit reached|<unix-ts>"). The
    # trailing pipe carries the exact reset time — capture it so failover can
    # bench the account until the real reset instead of a hardcoded guess.
    r'Claude\s+AI\s+usage\s+limit\s+reached(?:\s*\|\s*(?P<reset>\d+))?'
    # Claude Code rolling-window banners ("5-hour limit reached", "Weekly limit reached")
    r'|\d+\s*-?\s*hour\s+limit\s+reached'
    r'|weekly\s+limit\s+reached'
    # Anthropic API: low credit balance message
    r'|credit\s+balance\s+is\s+too\s+low'
    # Gemini surface: JSON error envelope shape, not bare token
    r'|"code"\s*:\s*"RESOURCE_EXHAUSTED"'
    r'|"status"\s*:\s*"RESOURCE_EXHAUSTED"'
    # Generic 429-with-quota wording emitted by Gemini / OpenAI-compat APIs
    r'|exceeded\s+your\s+current\s+quota',
    re.IGNORECASE,
)

# Auth failure (expired/invalid/not-logged-in) — DISTINCT from quota. A quota
# hit means "wait / switch accounts"; an auth failure means "this login is
# broken, re-auth it". Anchored on the exact phrasings the CLIs/APIs emit so
# prose about API keys in a coding session doesn't trip it.
# Kept deliberately high-precision: bare "Invalid API key", "authentication_error",
# or "401" show up in ordinary dev/debug output during a coding session, so we
# anchor only on phrasings the CLIs actually emit when THEIR OWN login is broken.
AUTH_FAIL_RE = re.compile(
    # Claude Code's live OAuth-expiry surfaces. The 401 line can repeat on
    # every retry while the TUI's login banner is rendered separately.
    r'Claude\s+API\s+auth\s+error\s*\(\s*401\s*\)'
    r'|Login\s+expired'
    r'|OAuth\s+token\s+has\s+expired'
    r'|Invalid\s+API\s+key[^\n]{0,80}Please\s+run\s+/login'
    r'|Please\s+run\s+/login(?:\s+to\s+authenticate)?'
    r'|"type"\s*:\s*"authentication_error"'
    # Codex 0.147+ refresh/login wording (verified from the installed binary).
    r'|Your\s+access\s+token\s+could\s+not\s+be\s+refreshed[^\n]{0,240}'
        r'(?:Please\s+(?:log\s+out\s+and\s+)?sign\s+in\s+again|refresh\s+token\s+(?:has\s+expired|was\s+(?:already\s+used|revoked)))'
    r'|Your\s+authentication\s+session\s+could\s+not\s+be\s+refreshed[^\n]{0,120}'
        r'Please\s+log\s+out\s+and\s+sign\s+in\s+again'
    r'|Run\s+codex\s+login\s+again'
    # A plain stream disconnect is a network symptom, not auth. Classify it
    # only when Codex renders an adjacent 401/unauthorized signal.
    r'|stream\s+disconnected[^\n]{0,160}(?:401|unauthorized)'
    r'|(?:401|unauthorized)[^\n]{0,160}stream\s+disconnected',
    re.IGNORECASE,
)

_MAX_QUOTA_LINE_LEN = 600  # real error messages — Gemini's JSON envelope can be long

# Terminal auth matches are advisory even when repeated: --resume redraws
# saved errors as new PTY bytes. Emit at most one diagnostic per PTY; only
# independently verified live evidence may invalidate a login.
AUTH_FAILURE_HITS = 3
AUTH_FAILURE_WINDOW_S = 15.0
_AUTH_SCAN_OVERLAP = 800


def _scan_quota(clean: str) -> tuple[bool, int | None]:
    """Line-by-line quota scan. Returns (matched, reset_unix_or_None).

    QUOTA_RE is anchored on full CLI error phrasings rather than bare keywords,
    so prose discussions of these concepts no longer match. The line-by-line
    scan + length cap keep us off pathological inputs. When the Claude banner
    carries its "|<unix-ts>" reset time, we return it.
    """
    for line in clean.split('\n'):
        stripped = line.strip()
        if not stripped or len(stripped) < 8 or len(stripped) > _MAX_QUOTA_LINE_LEN:
            continue
        m = QUOTA_RE.search(stripped)
        if m:
            reset = m.group('reset')
            return True, (int(reset) if reset else None)
    return False, None


def _is_auth_failure(clean: str) -> bool:
    """Line-by-line auth-failure scan (see AUTH_FAIL_RE)."""
    for line in clean.split('\n'):
        stripped = line.strip()
        if not stripped or len(stripped) < 6 or len(stripped) > _MAX_QUOTA_LINE_LEN:
            continue
        if AUTH_FAIL_RE.search(stripped):
            return True
    return False

# Permission question detection — matches when a CLI session asks for
# permission to act instead of just acting.  Only checked against the
# last few lines of output when the Stop hook fires (session goes idle).
PERMISSION_QUESTION_RE = re.compile(
    r'(?:'
    r'(?:want|like)\s+me\s+to\b'               # "Want me to …"
    r'|shall\s+I\b'                              # "Shall I …"
    r'|should\s+I\b'                             # "Should I …"
    r'|would\s+you\s+(?:like|want)\b'           # "Would you like/want …"
    r'|do\s+you\s+(?:want|need)\s+me\s+to\b'   # "Do you want me to …"
    r'|ready\s+to\s+(?:implement|proceed|start|begin|make)\b'
    r'|let\s+me\s+know\s+(?:if|whether|when)\b' # "Let me know if …"
    r')\s*'
    r'.*\?',                                     # must end with ?
    re.IGNORECASE,
)
# Tight matchers for the two CLI status-line readouts. Each regex is
# specific to a single CLI's exact wording so it cannot false-positive
# on the word "compact" appearing anywhere else, AND so the format that
# matched tells us which CLI is running — letting us pick a CLI-specific
# warning threshold without needing the session's CLI type from the DB.
#
# Claude Code:  "Context left until auto-compact: 14%"
# Gemini CLI:   "gemini-2.5-pro (78% context left)"
CLAUDE_CONTEXT_RE = re.compile(
    r'context\s+left\s+until\s+auto[- ]?compact[:\s]+(\d+)\s*%',
    re.IGNORECASE,
)
GEMINI_CONTEXT_RE = re.compile(
    r'\((\d+)\s*%\s+context\s+left\)',
    re.IGNORECASE,
)

# Warn the UI once per session when context drops to (or below) the
# CLI-appropriate threshold. The two CLIs compact at different points so
# the warning needs to fire BEFORE each one's actual trigger:
#   - Claude Code auto-compacts at ~10% remaining → warn at 15% (5% buffer)
#   - Gemini CLI  auto-compresses at ~30% remaining (default
#     COMPRESSION_TOKEN_THRESHOLD = 0.7) → warn at 35% (5% buffer)
CLAUDE_WARN_THRESHOLD_PCT = 15
GEMINI_WARN_THRESHOLD_PCT = 35


def _find_and_parse_json(text: str) -> dict | None:
    import json
    idx = text.find('{')
    if idx == -1:
        return None

    depth = 0
    in_string = False
    escape = False

    for i in range(idx, len(text)):
        char = text[i]
        if escape:
            escape = False
            continue
        if char == '\\':
            escape = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if not in_string:
            if char == '{':
                depth += 1
            elif char == '}':
                depth -= 1
                if depth == 0:
                    json_str = text[idx:i+1]
                    try:
                        parsed = json.loads(json_str)
                        if isinstance(parsed, dict):
                            return parsed
                    except json.JSONDecodeError:
                        pass
                    return _find_and_parse_json(text[idx+1:])
    return _find_and_parse_json(text[idx+1:])


class OutputCaptureProcessor:
    """Processes PTY output to extract structured captures and maintain text buffers."""

    # Suppress duplicate quota suspicions fired within this window (seconds).
    # Auth uses the stricter N-hits + PTY-lifetime one-shot gate below.
    _EVENT_DEBOUNCE_S = 30.0

    def __init__(self, buffer_size: int = 65536):
        self.buffer_size = buffer_size
        self._buffers: dict[str, str] = defaultdict(str)  # session_id -> clean text
        self._capture_callbacks: list = []
        # Tracks which sessions we've already warned about low context. The
        # entry is removed when the percentage rebounds (i.e. compaction
        # happened) so the next descent re-arms the warning.
        self._context_warned: set[str] = set()
        # Per-session incremental UTF-8 decoders. Raw PTY reads split multi-byte
        # characters (and target phrases) across chunk boundaries; an
        # incremental decoder stitches partial code points instead of emitting
        # replacement chars mid-character.
        self._decoders: dict[str, codecs.IncrementalDecoder] = {}
        # Optional per-session VT screen models (no-op when pyte is absent).
        self._screens: dict[str, TerminalScreen] = {}
        # (session_id, kind) -> monotonic time of last emit, for debounce.
        self._event_debounce: dict[tuple[str, str], float] = {}
        # Incremental auth scanning counts only matches involving newly-read
        # PTY text, while retaining enough overlap to catch split-read phrases.
        self._auth_scan_tails: dict[str, str] = {}
        self._auth_hit_times: dict[str, deque[float]] = defaultdict(deque)
        self._auth_failed_sessions: set[str] = set()

    def _decoder(self, session_id: str) -> codecs.IncrementalDecoder:
        d = self._decoders.get(session_id)
        if d is None:
            d = codecs.getincrementaldecoder("utf-8")("replace")
            self._decoders[session_id] = d
        return d

    def _screen(self, session_id: str) -> TerminalScreen:
        s = self._screens.get(session_id)
        if s is None:
            s = TerminalScreen()
            self._screens[session_id] = s
        # The emulator must model the actual PTY, not a permanent 120x40 grid.
        # Otherwise long prompts are cut off even after a terminal resize.
        provider = getattr(self, "_geometry_provider", None)
        geometry = provider(session_id) if provider else None
        if geometry and (s.cols, s.rows) != (geometry["cols"], geometry["rows"]):
            s.resize(geometry["cols"], geometry["rows"])
        return s

    def set_geometry_provider(self, provider):
        self._geometry_provider = provider

    def _debounced(self, session_id: str, kind: str) -> bool:
        """True (and arms the window) if this (session, kind) may fire now."""
        now = time.monotonic()
        key = (session_id, kind)
        last = self._event_debounce.get(key, 0.0)
        if now - last < self._EVENT_DEBOUNCE_S:
            return False
        self._event_debounce[key] = now
        return True

    def _new_auth_hit_count(self, session_id: str, clean: str) -> int:
        """Count auth matches that involve this newly-read PTY chunk.

        Retaining a bounded overlap catches phrases split across reads. The
        end-position check prevents an old match in that overlap from being
        counted again just because another unrelated chunk arrived.
        """
        overlap = self._auth_scan_tails.get(session_id, "")
        scan = overlap + clean
        boundary = len(overlap)
        hits = sum(1 for match in AUTH_FAIL_RE.finditer(scan) if match.end() > boundary)
        self._auth_scan_tails[session_id] = scan[-_AUTH_SCAN_OVERLAP:]
        return hits

    def _record_auth_hits(self, session_id: str, hit_count: int) -> bool:
        """Return True exactly once after N auth hits inside the time window."""
        if hit_count <= 0 or session_id in self._auth_failed_sessions:
            return False
        now = time.monotonic()
        hits = self._auth_hit_times[session_id]
        cutoff = now - AUTH_FAILURE_WINDOW_S
        while hits and hits[0] < cutoff:
            hits.popleft()
        hits.extend(now for _ in range(hit_count))
        if len(hits) < AUTH_FAILURE_HITS:
            return False
        self._auth_failed_sessions.add(session_id)
        hits.clear()
        return True

    def on_capture(self, callback):
        self._capture_callbacks.append(callback)

    async def _emit_capture(self, session_id: str, capture: dict):
        for cb in self._capture_callbacks:
            try:
                await cb(session_id, capture)
            except Exception as e:
                logger.error(f"Capture callback error: {e}")

    async def process(self, session_id: str, data: bytes):
        """Process a chunk of PTY output. Called as a PTYManager callback."""
        # Incremental decode so a UTF-8 sequence split across two reads isn't
        # corrupted into replacement chars.
        text = self._decoder(session_id).decode(data)
        # Feed the optional VT screen model with the raw bytes (handles split
        # escape sequences internally). No-op when pyte isn't installed.
        self._screen(session_id).feed(data)
        clean = strip_ansi(text)

        # Update ring buffer
        buf = self._buffers[session_id] + clean
        if len(buf) > self.buffer_size:
            buf = buf[-self.buffer_size:]
        self._buffers[session_id] = buf

        # Detect quota / auth on the buffer TAIL, not just this chunk. A banner
        # that lands on a read boundary is otherwise scanned as two halves and
        # missed; by the time both halves are appended, the tail holds the whole
        # phrase. Debounce keeps a banner scrolling through the buffer from
        # re-firing failover on every subsequent read.
        tail = buf[-4000:]

        # Detect error patterns (tool calls and agents are now tracked by hooks)
        if ERROR_RE.search(clean) and len(clean) > 20:
            await self._emit_capture(session_id, {
                "capture_type": "error",
                "raw_text": clean[:1000],
            })

        quota_hit, reset_unix = _scan_quota(tail)
        if quota_hit and self._debounced(session_id, "quota_suspected"):
            await self._emit_capture(session_id, {
                "capture_type": "quota_suspected",
                "raw_text": tail[-500:],
                "evidence_source": "terminal_text",
                "requires_operator_confirmation": True,
                # Exact reset time from the Claude banner, when present.
                "reset_unix": reset_unix,
            })

        # Terminal redraws include old transcript errors on --resume. Repetition
        # is not fresh authentication evidence, even across separate reads.
        # Keep this diagnostic advisory; never stop a PTY or invalidate an account.
        auth_hit_count = self._new_auth_hit_count(session_id, clean)
        if self._record_auth_hits(session_id, auth_hit_count):
            await self._emit_capture(session_id, {
                "capture_type": "auth_suspected",
                "raw_text": tail[-500:],
                "evidence_source": "terminal_text",
                "requires_verification": True,
            })

        # Context-low pre-warning. Try Claude's wording first, then
        # Gemini's. The status line refreshes constantly so we one-shot
        # the warning per session; the warned flag is only re-armed when
        # hooks.py sees a PostCompact/PostCompress (definitive signal),
        # NOT by watching the percentage rebound — Gemini has a known bug
        # where it spuriously displays "(100% context left)" during
        # processing, which would otherwise cause warning spam.
        m = CLAUDE_CONTEXT_RE.search(clean)
        threshold = CLAUDE_WARN_THRESHOLD_PCT
        if not m:
            m = GEMINI_CONTEXT_RE.search(clean)
            threshold = GEMINI_WARN_THRESHOLD_PCT
        if m:
            try:
                pct = int(m.group(1))
            except ValueError:
                pct = None
            if pct is not None and pct <= threshold and session_id not in self._context_warned:
                self._context_warned.add(session_id)
                await self._emit_capture(session_id, {
                    "capture_type": "context_low",
                    "percent_left": pct,
                    "raw_text": m.group(0),
                })

    def get_buffer(self, session_id: str, lines: int = 100) -> str:
        """Get the last N lines of clean text from a session."""
        buf = self._buffers.get(session_id, "")
        all_lines = buf.split("\n")
        return "\n".join(all_lines[-lines:])

    def get_screen(self, session_id: str) -> str:
        """Current rendered screen; empty if no terminal emulator is available."""
        screen = self._screens.get(session_id)
        return screen.text() if screen and screen.available else ""

    def clear_buffer(self, session_id: str):
        self._buffers.pop(session_id, None)
        self._context_warned.discard(session_id)
        self._decoders.pop(session_id, None)
        self._screens.pop(session_id, None)
        self._auth_scan_tails.pop(session_id, None)
        self._auth_hit_times.pop(session_id, None)
        self._auth_failed_sessions.discard(session_id)
        for key in [k for k in self._event_debounce if k[0] == session_id]:
            self._event_debounce.pop(key, None)

    def check_permission_question(self, session_id: str) -> str | dict | None:
        """Check if the session's recent output ends with a permission question.

        Supports structured JSON questions and falls back to regex-based questions.
        """
        buf = self._buffers.get(session_id, "")
        tail = buf[-4000:]

        # 1. Search for JSON question blocks
        indices = [i for i, c in enumerate(tail) if c == '{']
        for idx in reversed(indices):
            parsed = _find_and_parse_json(tail[idx:])
            if parsed and isinstance(parsed, dict):
                if "questions" in parsed and isinstance(parsed["questions"], list) and len(parsed["questions"]) > 0:
                    question_obj = parsed["questions"][0]
                    question_text = question_obj.get("question", "")
                    raw_options = question_obj.get("options", [])
                elif "question" in parsed:
                    question_text = parsed.get("question", "")
                    raw_options = parsed.get("options", [])
                else:
                    continue

                options = []
                for o_idx, opt in enumerate(raw_options):
                    if isinstance(opt, dict):
                        label = opt.get("label", opt.get("text", ""))
                        desc = opt.get("description", "")
                        text = f"{label} — {desc}" if desc else label
                    else:
                        text = str(opt)
                    options.append({
                        "num": o_idx + 1,
                        "text": text
                    })
                return {
                    "question": question_text,
                    "options": options,
                    "is_json": True
                }

        # 2. Fall back to regex-based check
        tail_lines = [l for l in buf.split("\n") if l.strip()][-5:]
        for line in reversed(tail_lines):
            if PERMISSION_QUESTION_RE.search(line):
                return line.strip()

        # 3. Additive fallback: if a VT screen model is active (pyte installed),
        # re-check the redraw-collapsed rendered screen. This only ever finds
        # MORE than the byte-stream buffer — e.g. a question the TUI redrew in
        # place — never fewer, so it can't regress the existing paths above.
        screen = self._screens.get(session_id)
        if screen is not None and screen.available:
            stext = screen.text()
            if stext:
                for line in reversed([l for l in stext.split("\n") if l.strip()][-5:]):
                    if PERMISSION_QUESTION_RE.search(line):
                        return line.strip()
        return None

    def clear_context_warned(self, session_id: str):
        """Re-arm the context-low warning for this session. Called from
        hooks.py when PostCompact/PostCompress fires so the next time
        context fills back up the warning re-emits."""
        self._context_warned.discard(session_id)
