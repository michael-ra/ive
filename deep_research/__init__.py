"""
Deep Research — Self-hosted, quota-free research engine.

Two operating modes:
  Mode A: AUTONOMOUS — local LLM does everything (fire and forget)
  Mode B: HYBRID     — Claude/Gemini = brain, local tool = hands (best quality)

Three agents:
  - Researcher:   Iterative search → extract → synthesize
  - Investigator: Research → actionable engineering plan
  - Aligner:      Real-time codebase alignment checks

Plus:
  - Gatherer:     Search + extract only (zero LLM). The hands for hybrid mode.
  - ModelRouter:  Auto-discover Ollama models, route by task complexity
  - Codebase:     Auto-profile any codebase (no LLM needed)

Human-in-the-loop:
  --interactive     pause after each round for terminal steering
  steer.md          drop a file with queries, consumed next round
  --codebase-dir    auto-checks alignment each round

Setup:
    brew install ollama && ollama pull gemma3:27b
    pip install -e ./deep-research[full]

Usage:
    # Autonomous (local model does everything)
    deep-research research "query"
    deep-research research --auto-route --codebase-dir . -i "query"

    # Hybrid (Claude is brain, this tool gathers)
    deep-research gather -q "query1" "query2" -o research/topic/round-1.json --summary

    # Post-research
    deep-research investigate research/topic/ --codebase-dir .
    deep-research align research/topic/ --codebase-dir .
    deep-research status research/topic/
    deep-research profile --dir .
"""

__version__ = "0.1.0"

from .researcher import DeepResearcher
from .investigator import Investigator
from .aligner import Aligner
from .gatherer import gather, gather_round, summarize_results
from .config import DeepResearchConfig
from .codebase import profile_codebase
from .model_router import ModelRouter, TaskTier

__all__ = [
    "DeepResearcher",
    "Investigator",
    "Aligner",
    "DeepResearchConfig",
    "ModelRouter",
    "TaskTier",
    "gather",
    "gather_round",
    "summarize_results",
    "profile_codebase",
]
