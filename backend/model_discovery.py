"""Dynamic model discovery for Claude and Gemini CLIs.

Queries available models at server startup so the UI dropdown stays current
without hardcoding. Falls back to the static list in cli_profiles.py if
discovery fails (no API key, network error, CLI not installed).

Claude: Uses aliases (haiku/sonnet/opus) which auto-resolve to latest.
        Full model IDs discovered via Anthropic API if ANTHROPIC_API_KEY is set,
        or by parsing `claude --model` help text.

Gemini: Queries the Google GenAI REST API using GEMINI_API_KEY / GOOGLE_API_KEY,
        or falls back to the static list.
"""

import json
import logging
import os
import subprocess
import urllib.request
import urllib.error

logger = logging.getLogger(__name__)


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
            # Sort: latest version first, pro before flash
            models.sort(key=lambda m: (
                -_version_key(m["id"]),
                0 if "pro" in m["id"] else 1,
                0 if "flash-lite" not in m["id"] else 2,
            ))
            logger.info("Discovered %d Gemini models via API", len(models))
            return models
    except Exception as e:
        logger.debug("Gemini model discovery failed: %s", e)

    return None


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


def _version_key(model_id: str) -> float:
    """Extract version number for sorting (higher = newer)."""
    for part in model_id.split("-"):
        try:
            return float(part)
        except ValueError:
            continue
    return 0


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

    Returns {"gemini": [...] | None, "claude": [...] | None}
    None means discovery failed — caller should use static fallback.
    """
    return {
        "gemini": discover_gemini_models(),
        "claude": discover_claude_models(),
    }
