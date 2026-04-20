"""Extract structured events from raw PTY terminal output."""

import re
import logging
from collections import defaultdict

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


def strip_ansi(text: str) -> str:
    # First: turn cursor-position jumps into newlines to preserve layout
    text = CURSOR_POS_RE.sub('\n', text)
    # Then: strip all remaining escape sequences
    text = ANSI_RE.sub('', text)
    # Collapse excessive blank lines
    text = MULTI_NEWLINE_RE.sub('\n\n', text)
    return text

# Pattern matchers — tool calls, agents, edits, and compaction events are
# now detected by CLI lifecycle hooks (PreToolUse/PostToolUse/SubagentStart/
# SubagentStop/PreCompact/PreCompress). Only quota, error, and the
# context-low pre-warning still parse output.
ERROR_RE = re.compile(r'(?:Error|Exception|Traceback|FAILED|panic)', re.IGNORECASE)
QUOTA_RE = re.compile(r'quota.?exceed|credit.?(?:limit|exhaust)|usage.?limit.?(?:reach|exceed)|resource.?exhausted|RESOURCE_EXHAUSTED|tokens?.?per.?(?:day).?(?:limit|exceed)', re.IGNORECASE)

# --- Quota false-positive guards ---
# Lines starting with these prefixes are content (documentation, code, JSON,
# tool-call output) — not CLI error messages.
_CONTENT_PREFIX_RE = re.compile(
    r'^\s*(?:'
    r'[#*\->|`~\[{("]'         # markdown / JSON / code / quoted strings
    r'|\d+[.)\]]'              # numbered lists
    r'|/[/*]'                  # code comments
    r'|[⏺⎿]'                  # Claude tool-call / result markers
    r')'
)
_MAX_QUOTA_LINE_LEN = 300  # real error messages are short


def _is_quota_error(clean: str) -> bool:
    """Check for quota/rate-limit errors, line-by-line to avoid false positives.

    Content the agent writes (documentation, code, tool output) often contains
    strings like ``quota_exceeded`` or ``RESOURCE_EXHAUSTED`` as identifiers.
    By checking each line individually and filtering out lines that look like
    content, we only fire on actual CLI error messages.
    """
    for line in clean.split('\n'):
        stripped = line.strip()
        # Skip blank, very short, or very long lines
        if not stripped or len(stripped) < 8 or len(stripped) > _MAX_QUOTA_LINE_LEN:
            continue
        # Skip lines that look like content / documentation / code
        if _CONTENT_PREFIX_RE.match(stripped):
            continue
        if QUOTA_RE.search(stripped):
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

# Branch detection — matches "claude -r <uuid>" printed after /branch command.
# The UUID identifies the ORIGINAL conversation (pre-branch) that should open
# as a separate tab so the user keeps both conversations visible.
BRANCH_RE = re.compile(
    r'claude\s+-r\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
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


class OutputCaptureProcessor:
    """Processes PTY output to extract structured captures and maintain text buffers."""

    def __init__(self, buffer_size: int = 65536):
        self.buffer_size = buffer_size
        self._buffers: dict[str, str] = defaultdict(str)  # session_id -> clean text
        self._capture_callbacks: list = []
        # Tracks which sessions we've already warned about low context. The
        # entry is removed when the percentage rebounds (i.e. compaction
        # happened) so the next descent re-arms the warning.
        self._context_warned: set[str] = set()
        # One-shot guard: only fire branch_detected once per session to avoid
        # re-triggering when scrollback re-enters the ring buffer.
        self._branch_detected: set[str] = set()

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
        text = data.decode("utf-8", errors="replace")
        clean = strip_ansi(text)

        # Update ring buffer
        buf = self._buffers[session_id] + clean
        if len(buf) > self.buffer_size:
            buf = buf[-self.buffer_size:]
        self._buffers[session_id] = buf

        # Detect error/quota patterns (tool calls and agents are now tracked by hooks)
        if ERROR_RE.search(clean) and len(clean) > 20:
            await self._emit_capture(session_id, {
                "capture_type": "error",
                "raw_text": clean[:1000],
            })

        if _is_quota_error(clean):
            await self._emit_capture(session_id, {
                "capture_type": "quota_exceeded",
                "raw_text": clean[:500],
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

        # Branch detection — /branch switches the current PTY to the branch
        # conversation and prints a resume command for the original. We
        # capture the original's UUID so Commander can open it as a new tab.
        if session_id not in self._branch_detected:
            branch_m = BRANCH_RE.search(clean)
            if branch_m:
                self._branch_detected.add(session_id)
                await self._emit_capture(session_id, {
                    "capture_type": "branch_detected",
                    "original_native_id": branch_m.group(1),
                    "raw_text": clean[:500],
                })

    def get_buffer(self, session_id: str, lines: int = 100) -> str:
        """Get the last N lines of clean text from a session."""
        buf = self._buffers.get(session_id, "")
        all_lines = buf.split("\n")
        return "\n".join(all_lines[-lines:])

    def clear_buffer(self, session_id: str):
        self._buffers.pop(session_id, None)
        self._context_warned.discard(session_id)
        self._branch_detected.discard(session_id)

    def check_permission_question(self, session_id: str) -> str | None:
        """Check if the session's recent output ends with a permission question.

        Returns the matched line if found, None otherwise.  Only examines
        the last 5 non-empty lines — the question always appears at the
        tail of the model's response right before the session goes idle.
        """
        buf = self._buffers.get(session_id, "")
        tail_lines = [l for l in buf.split("\n") if l.strip()][-5:]
        for line in reversed(tail_lines):
            if PERMISSION_QUESTION_RE.search(line):
                return line.strip()
        return None

    def clear_context_warned(self, session_id: str):
        """Re-arm the context-low warning for this session. Called from
        hooks.py when PostCompact/PostCompress fires so the next time
        context fills back up the warning re-emits."""
        self._context_warned.discard(session_id)

