"""Optional VT100 screen model over raw PTY bytes (pyte-backed).

Screen-scraping the raw byte stream (strip ANSI with regexes, match on the
result) misses text a TUI redraws in place and mangles escape sequences that
split across read boundaries. A real terminal emulator maintains the rendered
grid, so you read a stable screen (like ``tmux capture-pane``) instead of a byte
soup.

This is OPTIONAL and additive: if ``pyte`` isn't installed, ``TerminalScreen``
reports ``available == False`` and callers fall back to their existing
regex-on-bytestream path. Nothing here changes behaviour unless pyte is present.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

try:  # optional dependency
    import pyte
except Exception:  # pragma: no cover - absence is a supported state
    pyte = None


class TerminalScreen:
    """Maintains the rendered screen for one PTY session using pyte.

    Feed it the same raw bytes you hand to the websocket; read ``text()`` for a
    stable, redraw-collapsed view of the visible screen.
    """

    def __init__(self, cols: int = 120, rows: int = 40):
        self.cols = max(int(cols), 1)
        self.rows = max(int(rows), 1)
        self._screen = None
        self._stream = None
        if pyte is not None:
            try:
                # HistoryScreen keeps scrollback so late content isn't lost when
                # the TUI scrolls; ByteStream feeds raw bytes (handles split
                # escapes across chunks internally).
                self._screen = pyte.Screen(self.cols, self.rows)
                self._stream = pyte.ByteStream(self._screen)
            except Exception as e:  # pragma: no cover
                logger.debug("terminal_screen: pyte init failed: %s", e)
                self._screen = None
                self._stream = None

    @property
    def available(self) -> bool:
        return self._stream is not None

    def feed(self, data: bytes) -> None:
        if self._stream is None:
            return
        try:
            self._stream.feed(data)
        except Exception as e:  # pyte can be strict on malformed input
            logger.debug("terminal_screen: feed error: %s", e)

    def resize(self, cols: int, rows: int) -> None:
        if self._screen is None:
            return
        try:
            self.cols = max(int(cols), 1)
            self.rows = max(int(rows), 1)
            self._screen.resize(self.rows, self.cols)
        except Exception as e:  # pragma: no cover
            logger.debug("terminal_screen: resize error: %s", e)

    def text(self) -> str:
        """Rendered visible screen as text (trailing blank lines trimmed)."""
        if self._screen is None:
            return ""
        try:
            lines = list(self._screen.display)
        except Exception:
            return ""
        while lines and not lines[-1].strip():
            lines.pop()
        return "\n".join(line.rstrip() for line in lines)
