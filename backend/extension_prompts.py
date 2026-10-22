"""Optional text contributions; no product schemas or prompt payloads live here.

Contributors are trusted local extensions, selected exactly like route providers.
Keys name host insertion points; values are plain text, never format strings to
be recursively evaluated. A duplicate key is a composition error, not precedence.
"""
from collections import defaultdict

import extension_host


def slots(surface: str, **context) -> dict[str, str]:
    result = {}
    for extension in extension_host.installed_extensions():
        owner = extension["id"]
        candidate = extension_host.extension_path(owner) / "backend/prompts.py"
        if not candidate.is_file():
            continue
        provider = extension_host.load_backend_module(owner, "backend/prompts.py")
        contribution = provider.prompt_slots(surface, **context)
        if not isinstance(contribution, dict) or any(
            not isinstance(key, str) or not isinstance(value, str)
            for key, value in contribution.items()
        ):
            raise ValueError(f"Invalid prompt contribution from {owner}")
        duplicates = result.keys() & contribution.keys()
        if duplicates:
            raise ValueError(f"Duplicate prompt slots: {sorted(duplicates)}")
        result.update(contribution)
    return result


def render(template: str, surface: str, **context) -> str:
    """Render host-owned insertion points; absent contributions are empty."""
    return template.format_map(defaultdict(str, slots(surface, **context)))
