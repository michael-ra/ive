"""Provider registry — where a model lives and how that endpoint behaves.

Every entry here was verified against the provider's own docs. The point is not
the base URL (that part is easy) but the quirks: which parameter carries the
output cap, whether `response_format` actually does anything, whether the key
goes in a header or the query string. Guessing those produces silent breakage —
Anthropic's OpenAI-compat layer, for instance, *ignores* `response_format`
rather than rejecting it, so JSON mode looks fine and quietly isn't.

Adding a provider = one entry below. Anything not listed still works via a raw
`--llm-url`, it just gets the conservative defaults.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

# Task tiers live here (not in model_router) so the registry can state defaults
# without importing the Ollama discovery machinery.
FAST, THINK, DEEP = "fast", "think", "deep"
TIERS = (FAST, THINK, DEEP)


@dataclass(frozen=True)
class Provider:
    name: str
    base_url: str
    # "openai" → POST {base_url}/chat/completions, Bearer auth
    # "gemini" → POST {base_url}/models/{model}:generateContent?key=…
    backend: str = "openai"
    key_envs: tuple[str, ...] = ()
    needs_key: bool = True
    # False → never send response_format; rely on prompt-level JSON + the parser
    json_mode: bool = True
    max_tokens_field: str = "max_tokens"
    temperature_max: float | None = None
    extra_headers: dict[str, str] = field(default_factory=dict)
    # Per-tier defaults, used by config.endpoint(tier) when no model is pinned.
    tier_models: dict[str, str] = field(default_factory=dict)
    # Embeddings are a separate endpoint from chat, and most chat providers do
    # not serve them. False here means /embeddings is absent (Cerebras: verified
    # 404), so a provider can be perfect for research and useless for memory.
    embeddings: bool = False
    embeddings_model: str = ""     # "" → supported, but name the model yourself
    note: str = ""

    def resolve_key(self) -> str | None:
        """First key found among this provider's own env vars.

        Deliberately does NOT consult DEEP_RESEARCH_LLM_KEY: that generic key
        belongs to the active endpoint only (see config.endpoint), and falling
        back to it here would hand one vendor's key to another vendor's host.
        """
        for env in self.key_envs:
            value = os.getenv(env)
            if value:
                return value
        return None

    def has_key(self) -> bool:
        return not self.needs_key or bool(self.resolve_key())


PROVIDERS: dict[str, Provider] = {
    # ── Hosted, OpenAI-compatible ──────────────────────────────────
    "cerebras": Provider(
        name="cerebras",
        base_url="https://api.cerebras.ai/v1",
        key_envs=("CEREBRAS_API_KEY",),
        tier_models={FAST: "gemma-4-31b", THINK: "gemma-4-31b", DEEP: "gpt-oss-120b"},
        embeddings=False,   # /v1/embeddings returns 404 (checked 2026-08-18)
        note="65k ctx free / 131k paid. Very fast; free tier throttles hard. "
             "Chat only — no embeddings endpoint.",
    ),
    "groq": Provider(
        name="groq",
        base_url="https://api.groq.com/openai/v1",
        key_envs=("GROQ_API_KEY",),
        note="Rejects logprobs/logit_bias/n>1. temperature=0 becomes 1e-8.",
    ),
    "openrouter": Provider(
        name="openrouter",
        base_url="https://openrouter.ai/api/v1",
        key_envs=("OPENROUTER_API_KEY",),
        extra_headers={"X-OpenRouter-Title": "deep-research"},
        note="Meta-provider: models are namespaced, e.g. 'openai/gpt-4o-mini'.",
    ),
    "together": Provider(
        name="together",
        base_url="https://api.together.ai/v1",
        key_envs=("TOGETHER_API_KEY",),
        embeddings=True,   # model must be named explicitly
    ),
    "deepinfra": Provider(
        name="deepinfra",
        base_url="https://api.deepinfra.com/v1/openai",
        key_envs=("DEEPINFRA_TOKEN", "DEEPINFRA_API_KEY"),
        embeddings=True,
    ),
    "fireworks": Provider(
        name="fireworks",
        base_url="https://api.fireworks.ai/inference/v1",
        key_envs=("FIREWORKS_API_KEY",),
        embeddings=True,
        note="Models are namespaced, e.g. 'accounts/fireworks/models/…'.",
    ),
    "xai": Provider(
        name="xai",
        base_url="https://api.x.ai/v1",
        key_envs=("XAI_API_KEY",),
    ),
    "openai": Provider(
        name="openai",
        base_url="https://api.openai.com/v1",
        key_envs=("OPENAI_API_KEY",),
        max_tokens_field="max_completion_tokens",
        embeddings=True,
        embeddings_model="text-embedding-3-small",
        note="Reasoning models require max_completion_tokens, not max_tokens.",
    ),
    "anthropic": Provider(
        name="anthropic",
        base_url="https://api.anthropic.com/v1",
        key_envs=("ANTHROPIC_API_KEY",),
        json_mode=False,
        temperature_max=1.0,
        tier_models={
            FAST: "claude-haiku-4-5",
            THINK: "claude-sonnet-5",
            DEEP: "claude-opus-5",
        },
        note=(
            "OpenAI-compat layer: response_format is IGNORED (no JSON mode) and "
            "temperature caps at 1. Anthropic documents it as a testing surface, "
            "not a production one."
        ),
    ),
    "gemini": Provider(
        name="gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta",
        backend="gemini",
        key_envs=("GEMINI_API_KEY", "GOOGLE_API_KEY"),
        embeddings=True,   # native embedding endpoint, not OpenAI-shaped
        embeddings_model="gemini-embedding-2-preview",
        note="Native generateContent API — key goes in the query string.",
    ),
    # ── Local ──────────────────────────────────────────────────────
    "ollama": Provider(
        name="ollama",
        base_url="http://localhost:11434/v1",
        needs_key=False,
        max_tokens_field="",  # Ollama dislikes an explicit cap — omit it
        embeddings=True,
        embeddings_model="nomic-embed-text",
        note="Local, no key. Embeddings too — `ollama pull nomic-embed-text` "
             "gives you 768d vectors for free.",
    ),
    "lmstudio": Provider(
        name="lmstudio",
        base_url="http://localhost:1234/v1",
        needs_key=False,
        embeddings=True,
    ),
    "vllm": Provider(
        name="vllm",
        base_url="http://localhost:8000/v1",
        needs_key=False,
        embeddings=True,
    ),
}

CUSTOM = Provider(
    name="custom",
    base_url="",
    key_envs=("DEEP_RESEARCH_LLM_KEY",),
    needs_key=False,
    note="Any other OpenAI-compatible endpoint, via --llm-url.",
)


def get(name: str) -> Provider:
    """Look up a provider by name, with a helpful error listing the known ones."""
    key = (name or "").strip().lower()
    if key in PROVIDERS:
        return PROVIDERS[key]
    if key in ("custom", ""):
        return CUSTOM
    known = ", ".join(sorted(PROVIDERS))
    raise KeyError(f"Unknown provider '{name}'. Known: {known}, custom")


def from_url(base_url: str) -> Provider:
    """Best-effort provider for a raw URL — keeps --llm-url working unchanged."""
    url = (base_url or "").rstrip("/")
    for provider in PROVIDERS.values():
        if url.rstrip("/") == provider.base_url.rstrip("/"):
            return provider
    host = url.split("//", 1)[-1].split("/", 1)[0]
    for provider in PROVIDERS.values():
        provider_host = provider.base_url.split("//", 1)[-1].split("/", 1)[0]
        if host and host == provider_host:
            return provider
    if "localhost" in url or "127.0.0.1" in url:
        return PROVIDERS["ollama"]
    return CUSTOM


def parse_spec(spec: str, default: Provider) -> tuple[Provider, str]:
    """Parse 'model' or 'provider:model' into (provider, model).

    A bare model name stays on `default`, so single-provider setups never have
    to think about this. 'cerebras:gemma-4-31b' pins one tier to one provider,
    which is what makes mixed routing (cheap FAST here, strong DEEP there) work.
    Model names that contain a slash before any colon — 'openai/gpt-4o-mini' on
    OpenRouter — are left alone.
    """
    text = (spec or "").strip()
    if ":" in text:
        head, tail = text.split(":", 1)
        head_l = head.strip().lower()
        if (head_l in PROVIDERS or head_l == "custom") and "/" not in head:
            return get(head_l), tail.strip()
    return default, text


def describe() -> str:
    """Registry as a table, marking which providers have a usable key present."""
    rows = []
    width = max(len(n) for n in PROVIDERS)
    for name in sorted(PROVIDERS):
        p = PROVIDERS[name]
        if not p.needs_key:
            status = "local"
        elif p.has_key():
            status = "key ok"
        else:
            status = "no key"
        envs = "/".join(p.key_envs) or "—"
        caps = "chat+embed" if p.embeddings else "chat only"
        rows.append(f"  {name:<{width}}  {status:<7}  {p.base_url}  [{caps}]")
        rows.append(f"  {'':<{width}}  {'':<7}  env: {envs}")
        if p.note:
            rows.append(f"  {'':<{width}}  {'':<7}  {p.note}")
    return "\n".join(rows)
