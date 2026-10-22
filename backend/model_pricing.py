"""Per-model token pricing for REAL cost computation (replaces the old inferred total_cost_usd).

Cost is computed as: real tokens (parsed from each CLI's transcript) × published list rates here.
Rates are USD per 1,000,000 tokens, as (input, output, cache_write_5m, cache_read).

  * input        — uncached prompt tokens
  * output       — generated tokens
  * cache_write  — prompt-cache WRITE (Anthropic 5-minute TTL ≈ 1.25× input)
  * cache_read   — prompt-cache READ / "cached" prompt tokens (heavily discounted)

EDIT THESE FREELY — they're list prices and change over time. Unknown models fall back to the
closest family match, then to a conservative default, and are flagged `estimated=True` so the UI
can show which rows are exact vs. guessed.
"""
from __future__ import annotations

# model-id substring -> (input, output, cache_write, cache_read) USD / 1M tokens
# Order matters: more specific keys first (matched by longest substring hit).
PRICING: dict[str, tuple[float, float, float, float]] = {
    # ── Anthropic / Claude ────────────────────────────────────────────────
    "claude-opus-4":     (15.0, 75.0, 18.75, 1.50),
    "claude-opus":       (15.0, 75.0, 18.75, 1.50),
    "claude-sonnet-4":   (3.0,  15.0, 3.75,  0.30),
    "claude-sonnet":     (3.0,  15.0, 3.75,  0.30),
    "claude-haiku-4":    (1.0,  5.0,  1.25,  0.10),
    "claude-3-5-haiku":  (0.80, 4.0,  1.0,   0.08),
    "claude-haiku":      (1.0,  5.0,  1.25,  0.10),
    # ── OpenAI / Codex ────────────────────────────────────────────────────
    "gpt-5":             (1.25, 10.0, 1.25,  0.125),
    "o4-mini":           (1.10, 4.40, 1.10,  0.275),
    "o3":                (2.0,  8.0,  2.0,   0.50),
    "gpt-4.1":           (2.0,  8.0,  2.0,   0.50),
    "gpt-4o":            (2.50, 10.0, 2.50,  1.25),
    "codex":             (1.25, 10.0, 1.25,  0.125),
    # ── Google / Gemini ───────────────────────────────────────────────────
    "gemini-2.5-pro":    (1.25, 10.0, 1.25,  0.31),
    "gemini-2.5-flash":  (0.30, 2.50, 0.30,  0.075),
    "gemini-2.0":        (0.10, 0.40, 0.10,  0.025),
    "gemini":            (1.25, 10.0, 1.25,  0.31),
}

# Fallback when a model id matches nothing above (keeps cost finite + flags it estimated).
_DEFAULT = (3.0, 15.0, 3.75, 0.30)


def rates_for_model(model: str | None) -> tuple[tuple[float, float, float, float], bool]:
    """Return ((input, output, cache_write, cache_read), exact?) for a model id.

    exact=False means we fell back to the default table (UI should mark it estimated).
    """
    if not model:
        return _DEFAULT, False
    m = str(model).strip().lower()
    # longest matching key wins so "claude-opus-4" beats "claude-opus"
    best_key = None
    for key in PRICING:
        if key in m and (best_key is None or len(key) > len(best_key)):
            best_key = key
    if best_key is not None:
        return PRICING[best_key], True
    return _DEFAULT, False


def cost_usd(
    model: str | None,
    *,
    input_tokens: float = 0,
    output_tokens: float = 0,
    cache_write_tokens: float = 0,
    cache_read_tokens: float = 0,
) -> float:
    """Real USD cost for one model's token totals."""
    (pi, po, pcw, pcr), _ = rates_for_model(model)
    return (
        (input_tokens or 0) * pi
        + (output_tokens or 0) * po
        + (cache_write_tokens or 0) * pcw
        + (cache_read_tokens or 0) * pcr
    ) / 1_000_000.0


def is_estimated(model: str | None) -> bool:
    """True when the model id didn't match the table and used the default rate."""
    return not rates_for_model(model)[1]
