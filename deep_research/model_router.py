"""Intelligent model routing for local LLMs.

Claude Code has auto-model (haiku/sonnet/opus). Gemini CLI has flash/pro.
Local Ollama has nothing — you pick one model and pray.

This module fixes that:
  1. Discovers what models are available via Ollama API
  2. Categorizes tasks by complexity (gather vs think vs synthesize)
  3. Routes to the right model automatically

Task tiers:
  FAST   — mechanical work: query generation, relevance scoring, classification
           → smallest available model (2b-9b), or skip LLM entirely
  THINK  — reasoning: cross-domain connections, gap analysis, trade-offs
           → medium model (12b-27b) or large if available
  DEEP   — synthesis: final reports, implementation plans, verification
           → largest available model, max context

This is the key insight: most research tokens are GATHER tokens (cheap),
not THINK tokens (expensive). Route accordingly.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum

import aiohttp

logger = logging.getLogger(__name__)


class TaskTier(Enum):
    FAST = "fast"    # Mechanical: scoring, classification, query gen
    THINK = "think"  # Reasoning: gaps, cross-domain, analysis
    DEEP = "deep"    # Synthesis: reports, plans, verification


@dataclass
class ModelInfo:
    name: str
    size_b: float  # Approximate parameter count in billions
    quantization: str = ""  # e.g., "q4_0", "q8_0", "fp16"


@dataclass
class ModelRouter:
    """Routes tasks to appropriate local models based on complexity."""

    base_url: str = "http://localhost:11434"
    models: dict[TaskTier, str] = field(default_factory=dict)
    fallback_model: str = "gemma3:27b"
    _discovered: bool = False

    async def discover(self):
        """Query Ollama API to find available models and assign tiers."""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{self.base_url}/api/tags",
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as resp:
                    if resp.status != 200:
                        logger.warning("Ollama API returned %d", resp.status)
                        return
                    data = await resp.json()
        except Exception as e:
            logger.warning("Cannot reach Ollama at %s: %s", self.base_url, e)
            return

        available: list[ModelInfo] = []
        for m in data.get("models", []):
            name = m.get("name", "")
            # Estimate size from model name
            size = _estimate_size(name)
            quant = _detect_quantization(name)
            available.append(ModelInfo(name=name, size_b=size, quantization=quant))

        if not available:
            logger.warning("No models found in Ollama")
            return

        # Sort by size
        available.sort(key=lambda m: m.size_b)

        logger.info(
            "Discovered %d models: %s",
            len(available),
            ", ".join(f"{m.name}({m.size_b:.0f}B)" for m in available),
        )

        # Assign tiers
        if len(available) == 1:
            # Only one model — use it for everything
            self.models[TaskTier.FAST] = available[0].name
            self.models[TaskTier.THINK] = available[0].name
            self.models[TaskTier.DEEP] = available[0].name
        elif len(available) == 2:
            self.models[TaskTier.FAST] = available[0].name
            self.models[TaskTier.THINK] = available[-1].name
            self.models[TaskTier.DEEP] = available[-1].name
        else:
            self.models[TaskTier.FAST] = available[0].name
            # Pick middle for THINK
            mid = len(available) // 2
            self.models[TaskTier.THINK] = available[mid].name
            self.models[TaskTier.DEEP] = available[-1].name

        self.fallback_model = available[-1].name
        self._discovered = True

        logger.info(
            "Model routing: FAST=%s, THINK=%s, DEEP=%s",
            self.models.get(TaskTier.FAST),
            self.models.get(TaskTier.THINK),
            self.models.get(TaskTier.DEEP),
        )

    def get_model(self, tier: TaskTier) -> str:
        """Get the model name for a given task tier."""
        return self.models.get(tier, self.fallback_model)

    def describe(self) -> str:
        """Human-readable description of current routing."""
        if not self._discovered:
            return f"Model routing: not discovered (using {self.fallback_model} for all)"
        lines = ["Model routing:"]
        for tier in TaskTier:
            model = self.models.get(tier, "?")
            lines.append(f"  {tier.value:6s} → {model}")
        return "\n".join(lines)


def _estimate_size(name: str) -> float:
    """Estimate model size in billions from name like 'gemma3:27b' or 'llama3:8b-q4'."""
    import re
    # Look for explicit size markers
    m = re.search(r"(\d+(?:\.\d+)?)[bB]", name)
    if m:
        return float(m.group(1))
    # Common size patterns
    for pattern, size in [
        ("70b", 70), ("34b", 34), ("27b", 27), ("13b", 13),
        ("12b", 12), ("9b", 9), ("8b", 8), ("7b", 7),
        ("3b", 3), ("2b", 2), ("1b", 1), ("0.5b", 0.5),
    ]:
        if pattern in name.lower():
            return size
    # Default assumption
    return 7.0


def _detect_quantization(name: str) -> str:
    """Detect quantization from model name."""
    import re
    m = re.search(r"(q[0-9]_[0-9kK]|fp16|fp32|int8|int4|gguf)", name.lower())
    return m.group(1) if m else ""


# ── Task classification ────────────────────────────────────────────

# Map prompt template names to task tiers
TASK_TIERS = {
    # FAST — mechanical tasks
    "decompose": TaskTier.FAST,
    "evaluate": TaskTier.FAST,

    # THINK — reasoning tasks
    "gap_analysis": TaskTier.THINK,
    "brainstorm": TaskTier.THINK,
    "aligner": TaskTier.THINK,

    # DEEP — synthesis tasks
    "synthesize": TaskTier.DEEP,
    "investigate_plan": TaskTier.DEEP,
    "verify": TaskTier.DEEP,
    "summarize": TaskTier.THINK,
}


def classify_task(task_name: str) -> TaskTier:
    """Classify a task name into a tier."""
    for key, tier in TASK_TIERS.items():
        if key in task_name.lower():
            return tier
    return TaskTier.THINK  # Default to middle tier
