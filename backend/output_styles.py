"""Output style definitions for token-saving modes.

Cascading resolution: session → workspace → global app_setting → "default".
When the resolved style is not "default", the corresponding prompt fragment
is injected via append_system_prompt before PTY start.

Compression modes are inspired by the Caveman skill
(github.com/JuliusBrussee/caveman). Trusted selected extensions may add styles.
"""
from __future__ import annotations


# ─── Style definitions ───────────────────────────────────────────────

OUTPUT_STYLES: dict[str, dict] = {
    "default": {
        "label": "Default",
        "description": "Normal verbose output — no compression",
        "prompt": None,  # no injection
    },
    "lite": {
        "label": "Lite",
        "description": "Light compression — no filler or hedging, full sentences kept",
        "prompt": (
            "## Output Style: Lite Compression\n"
            "Drop filler words (just, really, basically, actually, simply, certainly), "
            "hedging (I think, maybe, perhaps, it seems), and pleasantries (Sure!, Happy to help). "
            "Keep full sentences and articles. Be direct — lead with the answer, not the reasoning."
        ),
    },
    "caveman": {
        "label": "Caveman",
        "description": "~50% token reduction — drop articles, fragments OK, terse",
        "prompt": (
            "## Output Style: Caveman Mode\n"
            "Respond terse like smart caveman. All technical substance stay. Only fluff die.\n\n"
            "Rules:\n"
            "- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging\n"
            "- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.\n"
            "- Pattern: [thing] [action] [reason]. [next step].\n"
            "- Not: \"Sure! I'd be happy to help you with that.\"\n"
            "- Yes: \"Bug in auth middleware. Fix:\"\n\n"
            "Auto-Clarity: drop caveman for security warnings, irreversible actions, "
            "user confused. Resume after.\n"
            "Boundaries: code/commits/PRs written normal."
        ),
    },
    "ultra": {
        "label": "Ultra",
        "description": "~75% token reduction — abbreviations, arrows, maximum compression",
        "prompt": (
            "## Output Style: Ultra Compression\n"
            "Maximum token efficiency. Every word must earn its place.\n\n"
            "Rules:\n"
            "- Drop: articles, filler, hedging, pleasantries, conjunctions where context suffices\n"
            "- Abbreviate: DB/auth/config/req/res/fn/impl/dep/env/pkg/repo/dir/msg/err/param/arg\n"
            "- Arrows for causality: X -> Y. Semicolons to chain: A; B; C.\n"
            "- Fragments mandatory. No full sentences unless quoting errors.\n"
            "- Code blocks: unchanged. Error messages: quoted exact.\n"
            "- Pattern: `[component] [state/action]. [evidence]. [fix/next].`\n\n"
            "Auto-Clarity: expand for security warnings and irreversible-action confirmations."
        ),
    },
}

# Selected providers own additional prompts and format policies.
from extension_host import load_legacy_fragments as _load_extension_fragments
_load_extension_fragments(globals(), "output_styles")

# Ordered list for UI dropdowns
OUTPUT_STYLE_LIST = [
    {"id": k, "label": v["label"], "description": v["description"]}
    for k, v in OUTPUT_STYLES.items()
]


def get_style_prompt(style: str) -> str | None:
    """Return the system prompt fragment for a style, or None for default."""
    return _style_entry(style)["prompt"]


def _style_entry(style: str) -> dict:
    if style not in OUTPUT_STYLES:
        raise ValueError(f"Output style {style!r} is unavailable; enable its provider or select an installed style")
    return OUTPUT_STYLES[style]


def style_compacts_memory(style: str) -> bool:
    """Query neutral rendering policy without naming optional formats."""
    entry = _style_entry(style)
    return bool(entry.get("compact_memory", style in ("caveman", "ultra")))


def resolve_output_style(
    session_style: str | None,
    workspace_style: str | None,
    global_style: str | None,
) -> str:
    """Resolve cascading output style: session → workspace → global → default."""
    for style in (session_style, workspace_style, global_style):
        if style and style != "default":
            _style_entry(style)
            return style
    return "default"
