"""Configuration for Deep Research engine."""

import os
from dataclasses import dataclass, field


@dataclass
class DeepResearchConfig:
    # ── LLM ────────────────────────────────────────────────────────
    # Any OpenAI-compatible endpoint: Ollama, vLLM, LM Studio, etc.
    llm_base_url: str = field(
        default_factory=lambda: os.getenv(
            "DEEP_RESEARCH_LLM_URL", "http://localhost:11434/v1"
        )
    )
    llm_model: str = field(
        default_factory=lambda: os.getenv("DEEP_RESEARCH_LLM_MODEL", "gemma3:27b")
    )
    llm_api_key: str = field(
        default_factory=lambda: os.getenv("DEEP_RESEARCH_LLM_KEY", "ollama")
    )
    llm_temperature: float = 0.3
    llm_max_tokens: int = 8192
    # Context budget in chars (~4 chars per token for English).
    # 100K chars ≈ 25K tokens — safe for 128K-context models.
    # Set higher for large-context models, lower for 8K models.
    context_chars: int = field(
        default_factory=lambda: int(os.getenv("DEEP_RESEARCH_CONTEXT_CHARS", "100000"))
    )

    # ── Search providers ───────────────────────────────────────────
    brave_api_key: str | None = field(
        default_factory=lambda: os.getenv("BRAVE_API_KEY")
    )
    searxng_url: str | None = field(
        default_factory=lambda: os.getenv("SEARXNG_URL")
    )
    github_token: str | None = field(
        default_factory=lambda: os.getenv("GITHUB_TOKEN")
    )
    max_results_per_source: int = 10

    # ── Research behaviour ─────────────────────────────────────────
    max_iterations: int = 8
    max_pages_to_fetch: int = 15
    time_limit_minutes: int = 30
    cross_domain: bool = True   # Explore analogous fields automatically
    verify_claims: bool = True  # Cross-reference key claims across sources

    # ── Output ─────────────────────────────────────────────────────
    output_dir: str = field(
        default_factory=lambda: os.getenv("DEEP_RESEARCH_OUTPUT", "research")
    )

    @classmethod
    def from_env(cls) -> "DeepResearchConfig":
        """Build config entirely from environment variables."""
        return cls()
