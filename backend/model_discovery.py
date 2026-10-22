"""Dynamic model discovery for Claude and Gemini CLIs.

Queries available models at server startup so the UI dropdown stays current
without hardcoding. Falls back to the static list in cli_profiles.py if
discovery fails (no API key, network error, CLI not installed).

Claude: Uses aliases (haiku/sonnet/opus) which auto-resolve to latest.
        Full model IDs discovered via Anthropic API if ANTHROPIC_API_KEY is set,
        or by parsing `claude --model` help text.

Gemini: Queries the Google GenAI REST API using GEMINI_API_KEY / GOOGLE_API_KEY,
        or falls back to the static list.

Antigravity: Keeps agy's native label-based model choices, then appends any
        public Gemini API models discovered from the Google API.
"""

import json
import logging
import os
import re
from pathlib import Path
import urllib.request

try:
    import tomllib
except Exception:  # pragma: no cover - Python < 3.11 fallback
    tomllib = None

logger = logging.getLogger(__name__)

_ANTIGRAVITY_NATIVE_MODELS = [
    {"id": "", "label": "Default", "description": "Use Antigravity CLI settings"},
    {"id": "Gemini 3.5 Flash (High)", "label": "Gemini 3.5 Flash High", "description": "Fast high-effort Antigravity setting"},
    {"id": "Gemini 3.1 Pro (High)", "label": "Gemini 3.1 Pro High", "description": "Highest Antigravity setting"},
    {"id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro", "description": "Gemini Pro"},
    {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash", "description": "Fast Gemini"},
]


def _codex_home(home: str | os.PathLike | None = None) -> Path:
    """The Codex home to read: explicit arg, else $CODEX_HOME, else ~/.codex."""
    from cli_profiles import get_profile

    profile = get_profile("codex")
    configured_home = (
        os.environ.get(profile.config_dir_env) if profile.config_dir_env else None
    )
    return Path(home or configured_home or profile.home_dir).expanduser()


def discover_codex_models(home: str | os.PathLike | None = None) -> list[dict] | None:
    """Models this Codex account offers, from ``$CODEX_HOME/models_cache.json``.

    codex-cli 0.16x refreshes that cache from the server and its own /model
    picker shows exactly the entries with ``visibility == "list"``, ordered by
    ``priority`` (lower first). We mirror that, so the IVE dropdown never
    offers models the account does not have. Returns None when the cache is
    missing or unreadable (callers keep the static fallback).
    """
    path = _codex_home(home) / "models_cache.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        logger.debug("Codex models cache unreadable (%s): %s", path, e)
        return None
    raw = data.get("models") if isinstance(data, dict) else data
    if not isinstance(raw, list):
        return None
    entries = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        slug = str(item.get("slug") or "").strip()
        if not slug or item.get("visibility") != "list":
            continue
        try:
            priority = float(item.get("priority"))
        except (TypeError, ValueError):
            priority = 1e9
        efforts = [
            str(level.get("effort"))
            for level in (item.get("supported_reasoning_levels") or [])
            if isinstance(level, dict) and level.get("effort")
        ]
        option = {
            "id": slug,
            "label": str(item.get("display_name") or slug),
            "description": str(item.get("description") or ""),
        }
        if efforts:
            option["effort_levels"] = efforts
        if item.get("default_reasoning_level"):
            option["default_effort"] = str(item["default_reasoning_level"])
        entries.append((priority, len(entries), option))
    if not entries:
        return None
    entries.sort(key=lambda e: (e[0], e[1]))
    return [option for _, _, option in entries]


def codex_model_ladder(models: list[dict] | None) -> list[str]:
    """Escalation ladder (weakest first) from the discovered model list.

    Codex lists its recommended/strongest models first (lowest priority), so
    the ladder is that order reversed. Empty when nothing was discovered.
    """
    ids = [str(m.get("id")) for m in (models or []) if isinstance(m, dict) and m.get("id")]
    return list(reversed(ids))


def discover_codex_default_model(home: str | os.PathLike | None = None) -> str | None:
    """Read the Codex CLI's configured default model from config.toml.

    Codex can omit ``--model`` and rely on ``~/.codex/config.toml``. Legacy IVE
    rows may store that as an empty session model, so startup resolves the
    default for display, new sessions, and DB backfill.
    """
    path = _codex_home(home) / "config.toml"
    if not path.exists():
        return None

    try:
        if tomllib:
            with path.open("rb") as f:
                data = tomllib.load(f)
            value = data.get("model")
            if value is not None:
                return str(value).strip() or None
    except Exception as e:
        logger.debug("Codex config TOML parse failed: %s", e)

    try:
        text = path.read_text(encoding="utf-8")
        match = re.search(r'(?m)^model\s*=\s*["\']([^"\']+)["\']\s*$', text)
        if match:
            return match.group(1).strip() or None
    except Exception as e:
        logger.debug("Codex config fallback parse failed: %s", e)

    return None


def apply_codex_discovery(profile, models: list[dict] | None, default_model: str | None) -> None:
    """Point the Codex profile at what this machine's Codex really offers.

    ``models`` comes from discover_codex_models(), ``default_model`` from
    config.toml. The configured model becomes the default for every role
    (commander/tester included) instead of IVE's hardcoded picks, and it is
    kept in the menu even when the cache hides it.
    """
    if models:
        options = [{"id": "", "label": "Default", "description": "Use Codex CLI config"}]
        options.extend(dict(m) for m in models)
        profile.available_models = options
        ladder = codex_model_ladder(models)
        if ladder:
            profile.model_ladder = ladder
    if not default_model:
        return
    profile.default_model = default_model
    profile.default_commander_model = default_model
    profile.default_tester_model = default_model
    if not any(isinstance(m, dict) and m.get("id") == default_model
               for m in profile.available_models):
        profile.available_models.append({
            "id": default_model,
            "label": default_model,
            "description": "Codex CLI config default",
        })
    profile.available_models = [
        {
            **m,
            "label": f"Default ({default_model})",
            "description": f"Use Codex CLI config ({default_model})",
        } if isinstance(m, dict) and (m.get("id") or "") == "" else m
        for m in profile.available_models
    ]


def discover_gemini_models() -> list[dict] | None:
    """Query Google GenAI API for available Gemini models.

    Returns list of {"id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro", "description": "..."}
    or None if discovery fails.
    """
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY", "")
    if not key:
        # Try to read from Gemini CLI's cached OAuth — but the API needs an API key, not OAuth
        # Fall back to None
        logger.debug("No GEMINI_API_KEY/GOOGLE_API_KEY — skipping Gemini model discovery")
        return None

    try:
        url = f"https://generativelanguage.googleapis.com/v1beta/models?key={key}"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())

        models = []
        seen = set()
        for m in data.get("models", []):
            name = m.get("name", "")
            display = m.get("displayName", "")
            # Only include gemini models suitable for code generation
            if not name.startswith("models/gemini"):
                continue
            model_id = name.replace("models/", "")
            # Skip non-code variants (audio, image, robotics, TTS, embedding, etc.)
            if any(skip in model_id for skip in [
                "tts", "embedding", "imagen", "veo", "thinking", "audio",
                "image", "robotics", "nano", "computer-use", "customtools",
            ]):
                continue
            # Skip generic "latest" aliases — the versioned models are more useful
            if model_id.endswith("-latest"):
                continue
            # Deduplicate (keep shorter/canonical ID)
            base = model_id.rsplit("-", 1)[0] if model_id.endswith("-001") else model_id
            if base in seen:
                continue
            seen.add(base)

            # Build label from display name or ID
            label = display if display else model_id.replace("-", " ").title()
            desc = _gemini_model_desc(model_id)
            models.append({"id": model_id, "label": label, "description": desc})

        if models:
            models = sort_model_options(models)
            logger.info("Discovered %d Gemini models via API", len(models))
            return models
    except Exception as e:
        logger.debug("Gemini model discovery failed: %s", e)

    return None


def discover_antigravity_models(gemini_models: list[dict] | None) -> list[dict] | None:
    """Return agy-native models plus discovered public Gemini API models.

    Antigravity stores model selection as labels such as
    ``Gemini 3.1 Pro (High)`` in ``~/.gemini/antigravity-cli/settings.json``.
    Those labels are not returned by the public Gemini models API, so dynamic
    discovery must augment the native list instead of replacing it.
    """
    if not gemini_models:
        return None

    merged = []
    seen = set()
    for model in [*_ANTIGRAVITY_NATIVE_MODELS, *gemini_models]:
        model_id = model.get("id")
        if model_id in seen:
            continue
        seen.add(model_id)
        merged.append(model)
    return sort_model_options(merged)


def sort_model_options(models: list[dict]) -> list[dict]:
    """Sort model menu options deterministically.

    Keep "Default" first, then order by family/name, descending numeric
    version, and capability tier for models with the same version.
    """
    return sorted(models, key=_model_sort_key)


def _model_sort_key(model: dict) -> tuple:
    model_id = str(model.get("id") or "")
    label = _model_label(model)
    if not model_id:
        return (0, "", (), 0, 0, label.lower())
    return (
        1,
        _model_family(label),
        tuple(-part for part in _version_parts(label)),
        _model_tier(label),
        _model_quality(label),
        label.lower(),
    )


def _model_label(model: dict) -> str:
    return str(model.get("label") or model.get("id") or "")


def _version_parts(label: str) -> list[int]:
    match = re.search(r"\d+(?:\.\d+)*", label)
    if not match:
        return []
    return [int(part) for part in match.group(0).split(".")]


def _model_family(label: str) -> str:
    text = label.lower()
    text = re.sub(r"\d+(?:\.\d+)*", " ", text)
    text = re.sub(r"\([^)]*\)", " ", text)
    text = re.sub(
        r"\b(pro|flash|lite|mini|spark|codex|opus|sonnet|haiku|high|medium|low|preview|stable|default)\b",
        " ",
        text,
    )
    text = re.sub(r"[^a-z0-9]+", " ", text).strip()
    return text or label.lower()


def _model_tier(label: str) -> int:
    text = label.lower()
    if re.search(r"\b(pro|opus)\b", text):
        return 0
    if re.search(r"\bsonnet\b", text):
        return 1
    if re.search(r"\bflash\b", text) and not re.search(r"\b(lite|mini)\b", text):
        return 2
    if re.search(r"\b(lite|mini|spark)\b", text):
        return 3
    if re.search(r"\bhaiku\b", text):
        return 4
    return 5


def _model_quality(label: str) -> int:
    text = label.lower()
    if re.search(r"\bhigh\b", text):
        return 0
    if re.search(r"\bmedium\b", text):
        return 1
    if re.search(r"\blow\b", text):
        return 2
    return 3


def discover_claude_models() -> list[dict] | None:
    """Discover Claude model aliases.

    Claude Code uses aliases (haiku, sonnet, opus) that auto-resolve to the
    latest version. We also try to discover full model IDs via the Anthropic API
    if available. Returns None if discovery adds nothing beyond the static list.
    """
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        return None

    try:
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/models",
            headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())

        models = []
        seen_families = set()
        for m in data.get("data", []):
            mid = m.get("id", "")
            display = m.get("display_name", "")
            # Only claude models
            if "claude" not in mid:
                continue
            # Group by family (haiku/sonnet/opus)
            family = None
            for f in ("opus", "sonnet", "haiku"):
                if f in mid:
                    family = f
                    break
            if not family or family in seen_families:
                continue
            seen_families.add(family)
            models.append({
                "id": family,
                "label": family.title(),
                "description": display or f"Claude {family.title()}",
                "full_id": mid,
            })

        if models:
            # Sort: opus > sonnet > haiku
            order = {"opus": 0, "sonnet": 1, "haiku": 2}
            models.sort(key=lambda m: order.get(m["id"], 9))
            logger.info("Discovered %d Claude models via API", len(models))
            return models
    except Exception as e:
        logger.debug("Claude model discovery failed: %s", e)

    return None


def _gemini_model_desc(model_id: str) -> str:
    """Generate a short description from model ID."""
    if "pro" in model_id:
        return "Maximum capability"
    if "flash-lite" in model_id:
        return "Ultra-fast, cheapest"
    if "flash" in model_id:
        return "Fast & capable"
    return "Gemini model"


def discover_all() -> dict:
    """Run all model discovery and return results.

    Returns {"claude": [...] | None, "gemini": [...] | None,
    "antigravity": [...] | None}
    None means discovery failed — caller should use static fallback.
    """
    gemini_models = discover_gemini_models()
    return {
        "claude": discover_claude_models(),
        "gemini": gemini_models,
        "antigravity": discover_antigravity_models(gemini_models),
    }
