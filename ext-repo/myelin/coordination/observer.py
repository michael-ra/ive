"""Passive observation layer — agents don't know coordination exists.

The Observer watches an agent's activity (user prompts, tool calls, recent
text) and automatically maintains a workspace task on its behalf. Agents use
their normal tools — coordination is transparent.

Architecture:
    Agent does its work normally
         │
         ▼
    Observer.record_user_prompt(text)
    Observer.record_tool_call(name, args, result)
         │
         ▼
    [periodic] Observer._extract_intent()
         │
         ├─ Heuristic intent (zero cost) — file paths + last user message
         └─ OR LLM intent (Claude CLI / local model) — when accuracy matters
         │
         ▼
    Auto-update workspace task

    [before destructive ops] Observer.check_before_write(file)
         │
         ▼
    workspace.check_overlap() → if CONFLICT, block the tool call

Three intent extraction tiers (chosen via constructor):
    "heuristic": pure string munging (zero LLM, instant)
    "claude_cli": calls `claude` binary for summarization (1-2s, accurate)
    "local_llm": small local model (future — Phi-3.5, Qwen 0.5B)
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .workspace import AgentWorkspace, AgentTask

logger = logging.getLogger("myelin.coordination.observer")


@dataclass
class ActivityBuffer:
    """Rolling buffer of recent agent activity used to extract intent."""
    user_prompts: list[str] = field(default_factory=list)
    tool_calls: list[tuple[str, dict, str]] = field(default_factory=list)  # (name, args, summary)
    text_snippets: list[str] = field(default_factory=list)
    files_touched: list[str] = field(default_factory=list)
    started_at: float = field(default_factory=time.time)

    def trim(self, max_items: int = 20) -> None:
        """Keep only the most recent N items per channel."""
        self.user_prompts = self.user_prompts[-max_items:]
        self.tool_calls = self.tool_calls[-max_items:]
        self.text_snippets = self.text_snippets[-max_items:]
        # files_touched is unique-keep-order
        seen = set()
        new_files = []
        for f in reversed(self.files_touched):
            if f and f not in seen:
                seen.add(f)
                new_files.append(f)
        self.files_touched = list(reversed(new_files))[-max_items:]


class AgentObserver:
    """Observes one agent's activity and maintains its workspace task transparently.

    Usage:
        observer = AgentObserver(workspace, agent_id="claude_1")
        observer.record_user_prompt("fix the JWT refresh bug")
        observer.record_tool_call("Read", {"path": "auth.py"}, "")
        observer.record_tool_call("Edit", {"path": "auth.py"}, "...")
        # Observer auto-announces intent in the background

        # Before destructive ops:
        conflict = await observer.check_before_write("auth.py")
        if conflict:
            # Yield, wait, or notify user
            ...
    """

    RE_EXTRACT_AFTER_N_TOOLS = 3

    def __init__(
        self,
        workspace: "AgentWorkspace",
        agent_id: str,
        intent_extractor: str = "heuristic",  # heuristic | claude_cli
        repo: str | None = None,
    ):
        self._workspace = workspace
        self._agent_id = agent_id
        self._intent_extractor = intent_extractor
        self._repo = repo
        self._activity = ActivityBuffer()
        self._task: "AgentTask | None" = None
        self._last_intent: str = ""
        self._last_extract_at: float = 0
        self._tools_since_extract: int = 0

    # ── Recording activity (called by tool middleware) ──

    def record_user_prompt(self, text: str) -> None:
        """Record the user's message — usually the source of intent."""
        if not text:
            return
        self._activity.user_prompts.append(text[:500])
        self._activity.trim()

    def record_tool_call(self, name: str, args: dict | None, result_summary: str | None = "") -> None:
        """Record a tool invocation — used to track what files are touched."""
        if not name:
            return
        args = args or {}
        result_summary = result_summary or ""
        self._activity.tool_calls.append((name, args, result_summary[:200]))

        # Extract file paths from common tool args
        for key in ("file_path", "path", "filepath"):
            if key in args and isinstance(args[key], str):
                self._activity.files_touched.append(args[key])
                break

        self._activity.trim()
        self._tools_since_extract += 1

        # Re-extract intent every N tool calls
        if self._tools_since_extract >= self.RE_EXTRACT_AFTER_N_TOOLS:
            asyncio.create_task(self._maybe_update_task())
            self._tools_since_extract = 0

    # ── Intent extraction ──

    async def _extract_intent(self) -> str:
        """Extract a terse intent string from recent activity."""
        if self._intent_extractor == "claude_cli":
            return await self._extract_via_claude_cli()
        return self._extract_heuristic()

    def _extract_heuristic(self) -> str:
        """Pure string heuristic — zero LLM cost."""
        prompt = self._activity.user_prompts[-1] if self._activity.user_prompts else ""
        files = self._activity.files_touched[-3:]

        if not prompt and not files:
            return ""

        # Use user prompt as-is for semantic matching.
        # Only append file path if the prompt doesn't mention it already.
        # Appending redundant file names changes the embedding and reduces
        # cosine similarity — a bug that turned CONFLICT (0.90) into NOTIFY (0.68).
        if prompt:
            if files:
                file_str = files[-1].split("/")[-1]
                if file_str.lower() not in prompt.lower():
                    return f"{prompt[:80]} ({file_str})"
            return prompt[:100]
        # No prompt — use file path as a minimal intent
        if files:
            return f"editing {files[-1]}"
        return ""

    async def _extract_via_claude_cli(self) -> str:
        """Use Claude CLI for summarization. ~1-2s per call."""
        prompt = self._activity.user_prompts[-1] if self._activity.user_prompts else ""
        recent_text = " | ".join(self._activity.text_snippets[-3:])
        recent_tools = ", ".join(f"{n}({a.get('path','')[:30]})"
                                  for n, a, _ in self._activity.tool_calls[-5:])

        summary_prompt = (
            f"Summarize this work in one terse sentence (max 15 words). "
            f"Focus on what's being done, not how.\n\n"
            f"User asked: {prompt}\n"
            f"Recent tools: {recent_tools}\n"
            f"Reasoning: {recent_text[:300]}"
        )

        try:
            proc = await asyncio.create_subprocess_exec(
                "claude", "--no-tools", "-p", summary_prompt,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
            return out.decode().strip().split("\n")[0][:200]
        except (FileNotFoundError, asyncio.TimeoutError):
            # Fall back to heuristic
            return self._extract_heuristic()

    # ── Workspace integration ──

    # Force a refresh after this many seconds even if Jaccard says "same intent".
    # Catches the case where word overlap is high but the actual meaning shifted
    # (e.g. "fix auth login" → "fix auth logout" → both have {fix, auth} ∩).
    INTENT_REFRESH_AFTER_SECS = 60

    async def _maybe_update_task(self) -> None:
        """Re-extract intent and update the workspace task if it changed meaningfully."""
        try:
            intent = await self._extract_intent()
            if not intent:
                return
            # Skip if intent hasn't changed much AND it's still recent.
            # Without the time clause, two intents that share lots of words
            # but mean different things get collapsed forever — a real bug
            # when work pivots within a coherent topic.
            now = time.time()
            stale = (now - self._last_extract_at) > self.INTENT_REFRESH_AFTER_SECS
            if (
                self._last_intent
                and self._jaccard(intent, self._last_intent) > 0.7
                and not stale
            ):
                return

            self._last_intent = intent
            self._last_extract_at = now

            if self._task is None:
                # First-time announce
                self._task = await self._workspace.announce(
                    agent_id=self._agent_id,
                    intent=intent,
                    reasoning=self._build_reasoning(),
                    files_touched=self._activity.files_touched[-5:],
                    repo=self._repo,
                )
                logger.debug("observer: %s announced intent: %s", self._agent_id, intent)
            else:
                # Update existing task
                await self._workspace._myelin.update_node(
                    self._task.id,
                    {"properties": {
                        **(await self._workspace.get_context(self._task.id)),
                        "_dense": intent,
                        "files_touched": self._activity.files_touched[-5:],
                        "last_updated": time.time(),
                    }},
                )
                logger.debug("observer: %s updated intent: %s", self._agent_id, intent)
        except Exception as e:
            logger.debug("observer update failed: %s", e)

    def _build_reasoning(self) -> str:
        """Build a context blob from recent activity (stored as _source)."""
        parts = []
        if self._activity.user_prompts:
            parts.append(f"User: {self._activity.user_prompts[-1]}")
        if self._activity.tool_calls:
            tool_str = "; ".join(f"{n}({list(a.values())[0] if a else ''})"
                                  for n, a, _ in self._activity.tool_calls[-5:])
            parts.append(f"Tools: {tool_str}")
        if self._activity.text_snippets:
            parts.append(f"Thinking: {self._activity.text_snippets[-1]}")
        return "\n".join(parts)

    @staticmethod
    def _jaccard(a: str, b: str) -> float:
        wa = set(a.lower().split())
        wb = set(b.lower().split())
        if not wa or not wb:
            return 0.0
        return len(wa & wb) / len(wa | wb)

    # ── Conflict checks (called before destructive ops) ──

    async def check_before_write(self, file_path: str) -> list:
        """Check for conflicts before performing a destructive write.

        Returns list of conflicting tasks (empty if no conflict).
        Caller (tool middleware) decides what to do: block, queue, or proceed.
        """
        # Force an intent extraction to make sure we're current
        await self._maybe_update_task()
        intent = self._last_intent or self._extract_heuristic()
        if not intent:
            intent = f"editing {file_path}"

        overlaps = await self._workspace.check_overlap(
            intent=intent,
            threshold=0.65,  # NOTIFY level
            exclude_agent=self._agent_id,
            only_active=True,
        )

        # Return CONFLICT, SHARE, AND NOTIFY — resolver decides what to do per level
        from .workspace import OverlapLevel
        return [
            o for o in overlaps
            if o.level in (OverlapLevel.CONFLICT, OverlapLevel.SHARE, OverlapLevel.NOTIFY)
        ]

