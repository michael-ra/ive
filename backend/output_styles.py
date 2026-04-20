"""Output style definitions for token-saving modes.

Cascading resolution: session → workspace → global app_setting → "default".
When the resolved style is not "default", the corresponding prompt fragment
is injected via append_system_prompt before PTY start.

Inspired by the Caveman skill (github.com/JuliusBrussee/caveman) for
compression modes, and Myelin's dense_form pattern for embedding-quality
terse output.
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
    "dense": {
        "label": "Dense",
        "description": "Dense form — signal over noise, architectural decisions over mechanics",
        "prompt": (
            "## Output Style: Dense Form\n"
            "Each statement self-contained, entity-first. Optimize for signal, not completeness.\n\n"
            "### What to keep (signal)\n"
            "- Architectural decisions and design patterns chosen\n"
            "- Non-obvious constraints, tradeoffs, or surprises\n"
            "- Novel relationships between components\n"
            "- Why something works the way it does (when not self-evident)\n"
            "- Breaking changes, behavioral shifts, edge cases\n\n"
            "### What to drop (noise)\n"
            "- File counts, line counts, test counts, metrics (unless surprising)\n"
            "- Mechanical details: renames, migrations, import changes, boilerplate\n"
            "- Obvious consequences (\"updated X\" when X was the stated goal)\n"
            "- Implementation logistics (\"read file, then edited\") — show the result\n"
            "- Reassurance (\"everything works\", \"no issues\", \"build clean\")\n\n"
            "### Format rules\n"
            "- Every sentence stands alone — no pronouns referring to prior sentences\n"
            "- Entity-first: name the subject (\"EventBus dispatches via canonical map\" not \"It uses a map\")\n"
            "- Bold the component/concept on first mention for scanability\n"
            "- Use `code` for identifiers. Use **bold** for concepts.\n"
            "- Bullet lists over prose. Tables when data is tabular.\n"
            "- Code blocks unchanged. Error messages quoted exact.\n\n"
            "Pattern: `**[Concept].** [Entity] [design choice]. [Non-obvious constraint/reason].`"
        ),
    },
}

# Ordered list for UI dropdowns
OUTPUT_STYLE_LIST = [
    {"id": k, "label": v["label"], "description": v["description"]}
    for k, v in OUTPUT_STYLES.items()
]


def get_style_prompt(style: str) -> str | None:
    """Return the system prompt fragment for a style, or None for default."""
    entry = OUTPUT_STYLES.get(style)
    return entry["prompt"] if entry else None


def resolve_output_style(
    session_style: str | None,
    workspace_style: str | None,
    global_style: str | None,
) -> str:
    """Resolve cascading output style: session → workspace → global → default."""
    for style in (session_style, workspace_style, global_style):
        if style and style != "default" and style in OUTPUT_STYLES:
            return style
    return "default"
