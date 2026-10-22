"""Configuration for Deep Research engine."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from . import providers
from .providers import DEEP, FAST, THINK, TIERS, Provider


@dataclass(frozen=True)
class Endpoint:
    """A concrete place to send one request: where, which model, which key."""

    provider: Provider
    base_url: str
    model: str
    api_key: str | None

    @property
    def backend(self) -> str:
        return self.provider.backend

    def __str__(self) -> str:
        return f"{self.provider.name}:{self.model}"


def _same_host(a: str, b: str) -> bool:
    """Do two base URLs address the same host?

    Keys are scoped to a host, not to a provider name. Comparing hosts is what
    stops a configured provider's credential from following a redirected URL.
    """
    def host(u: str) -> str:
        return (u or "").split("//", 1)[-1].split("/", 1)[0].lower()
    return bool(host(a)) and host(a) == host(b)


def _env(*names: str, default: str = "") -> str:
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return default


@dataclass
class DeepResearchConfig:
    # ── LLM ────────────────────────────────────────────────────────
    # Pick a provider by name (see `deep-research providers`), or point
    # llm_base_url at any other OpenAI-compatible endpoint.
    llm_provider: str = field(
        default_factory=lambda: _env("DEEP_RESEARCH_PROVIDER")
    )
    # Empty → derive from the provider. Set → wins, and the provider is inferred.
    llm_base_url: str = field(
        default_factory=lambda: _env("DEEP_RESEARCH_LLM_URL")
    )
    llm_model: str = field(
        default_factory=lambda: _env("DEEP_RESEARCH_LLM_MODEL")
    )
    # Empty → look up the provider's own env var (CEREBRAS_API_KEY, …).
    llm_api_key: str = field(
        default_factory=lambda: _env("DEEP_RESEARCH_LLM_KEY")
    )
    # Per-tier overrides. Accept "model" (same provider) or "provider:model",
    # so a run can be cheap-and-fast for scoring and strong for synthesis.
    model_fast: str = field(
        default_factory=lambda: _env("DEEP_RESEARCH_MODEL_FAST")
    )
    model_think: str = field(
        default_factory=lambda: _env("DEEP_RESEARCH_MODEL_THINK")
    )
    model_deep: str = field(
        default_factory=lambda: _env("DEEP_RESEARCH_MODEL_DEEP")
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
    # Opaque local run identities, never query-derived directory names.
    run_id: str | None = None
    workspace_id: str | None = None
    entry_id: str | None = None
    last_output_dir: str | None = None

    # ── Resolution ─────────────────────────────────────────────────

    def provider(self) -> Provider:
        """The active provider: explicit name > inferred from URL > local default."""
        if self.llm_provider:
            return providers.get(self.llm_provider)
        if self.llm_base_url:
            return providers.from_url(self.llm_base_url)
        return providers.PROVIDERS["ollama"]

    def endpoint(self, tier: str | None = None) -> Endpoint:
        """Resolve where a request for `tier` should go.

        A tier override may name another provider entirely; anything it does not
        specify falls back to the active provider and its key.
        """
        active = self.provider()
        model = self.llm_model or active.tier_models.get(THINK) or _DEFAULT_MODEL
        target, model = (active, model)

        override = {
            FAST: self.model_fast,
            THINK: self.model_think,
            DEEP: self.model_deep,
        }.get(tier or "", "")
        if override:
            target, model = providers.parse_spec(override, active)
        elif tier and not self.llm_model and active.tier_models.get(tier):
            model = active.tier_models[tier]

        if target is active:
            base_url = self.llm_base_url or active.base_url
            if _same_host(base_url, active.base_url):
                api_key = self.llm_api_key or active.resolve_key()
            else:
                # An explicit --llm-url pointing somewhere else must NOT carry
                # the provider's key: naming a provider and then redirecting the
                # URL would send e.g. CEREBRAS_API_KEY to an arbitrary host.
                # Only a key given for this run travels there.
                api_key = self.llm_api_key or None
        else:
            # Cross-provider tier: never reuse the active provider's URL or key.
            base_url = target.base_url
            api_key = target.resolve_key()

        return Endpoint(provider=target, base_url=base_url, model=model, api_key=api_key)

    def tier_endpoints(self) -> dict[str, Endpoint]:
        return {tier: self.endpoint(tier) for tier in TIERS}

    def describe_routing(self) -> str:
        default = self.endpoint()
        lines = [f"Model: {default} @ {default.base_url}"]
        routed = {tier: str(ep) for tier, ep in self.tier_endpoints().items()}
        if len(set(routed.values())) > 1:
            lines.append("Routing: " + ", ".join(f"{t}={m}" for t, m in routed.items()))
        missing = [
            ep.provider.name
            for ep in {str(e): e for e in self.tier_endpoints().values()}.values()
            if ep.provider.needs_key and not ep.api_key
        ]
        if missing:
            lines.append(
                "Warning: no API key found for " + ", ".join(sorted(set(missing)))
            )
        return "\n".join(lines)

    @classmethod
    def from_env(cls) -> "DeepResearchConfig":
        """Build config entirely from environment variables."""
        return cls()


# Kept as the historical default so an unconfigured local run behaves as before.
_DEFAULT_MODEL = "gemma3:27b"
