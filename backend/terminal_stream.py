"""Bounded, sequenced terminal frames for reconnect and remount replay."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import uuid


@dataclass(frozen=True, slots=True)
class TerminalFrame:
    sequence: int
    data: str


@dataclass(frozen=True, slots=True)
class ReplayBatch:
    generation: str
    latest_sequence: int
    frames: tuple[TerminalFrame, ...]
    reset_required: bool
    reason: str | None


class TerminalStream:
    """Keep only complete outbound frames within fixed memory/count bounds."""

    def __init__(self, *, max_bytes: int = 1024 * 1024, max_frames: int = 1024):
        self.generation = uuid.uuid4().hex
        self.max_bytes = max(1, int(max_bytes))
        self.max_frames = max(1, int(max_frames))
        self.latest_sequence = 0
        self._frames: deque[tuple[TerminalFrame, int]] = deque()
        self._retained_bytes = 0

    def append(self, data: str) -> TerminalFrame:
        self.latest_sequence += 1
        frame = TerminalFrame(self.latest_sequence, data)
        size = len(data.encode("utf-8"))

        if size > self.max_bytes:
            self._frames.clear()
            self._retained_bytes = 0
            return frame

        self._frames.append((frame, size))
        self._retained_bytes += size
        while (
            len(self._frames) > self.max_frames
            or self._retained_bytes > self.max_bytes
        ):
            _, removed_size = self._frames.popleft()
            self._retained_bytes -= removed_size
        return frame

    def replay(self, *, after_sequence: int | None, generation: str | None) -> ReplayBatch:
        retained = tuple(frame for frame, _ in self._frames)
        if generation != self.generation:
            return ReplayBatch(
                self.generation,
                self.latest_sequence,
                retained,
                True,
                "new_view" if generation is None else "generation_changed",
            )

        if after_sequence is None:
            return ReplayBatch(
                self.generation,
                self.latest_sequence,
                retained,
                True,
                "missing_sequence",
            )

        try:
            after = int(after_sequence)
        except (TypeError, ValueError):
            return ReplayBatch(
                self.generation,
                self.latest_sequence,
                retained,
                True,
                "invalid_sequence",
            )

        oldest = retained[0].sequence if retained else self.latest_sequence + 1
        if after > self.latest_sequence:
            return ReplayBatch(
                self.generation,
                self.latest_sequence,
                retained,
                True,
                "client_ahead",
            )
        if after < oldest - 1:
            return ReplayBatch(
                self.generation,
                self.latest_sequence,
                retained,
                True,
                "retention_gap",
            )
        return ReplayBatch(
            self.generation,
            self.latest_sequence,
            tuple(frame for frame in retained if frame.sequence > after),
            False,
            None,
        )
