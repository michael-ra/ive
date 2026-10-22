"""What effort a Claude Code session really runs with when IVE passes none.

IVE used to omit ``--effort`` for "high" on the assumption that "high" is
Claude Code's default. It is not: Claude Code reads (verified against the
2.1.296 binary)

1. ``CLAUDE_CODE_EFFORT_LEVEL`` from the environment,
2. ``modelSettings[<model>].effortLevel`` (written by ``/model``'s effort
   arrows, keyed by canonical model name),
3. ``effortLevel`` from the merged settings (local > project > user),
4. otherwise a per-model built-in default (e.g. "medium" or "high").

So when no effort is chosen IVE now passes nothing and shows the value this
module resolves, instead of pretending "high". Read-only; never writes any
settings file.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Mapping, Optional

# Values Claude Code accepts for --effort (claude --help, 2.1.296).
CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"]


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text())
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _valid(value) -> Optional[str]:
    if isinstance(value, str) and value.strip().lower() in CLAUDE_EFFORT_LEVELS:
        return value.strip().lower()
    return None


def _model_matches(key: str, model: str) -> bool:
    """modelSettings keys are canonical names; they also match dated, [1m]
    and provider spellings of the same model."""
    key = key.strip().lower()
    model = model.strip().lower()
    if not key or not model:
        return False
    if model == key:
        return True
    return any(model.startswith(key + sep) for sep in ("-2", "[", "@", ":"))


def resolve_claude_effort_default(
    *,
    model: str | None = None,
    workspace_path: str | None = None,
    home: str | os.PathLike | None = None,
    env: Mapping[str, str] | None = None,
) -> dict:
    """Return ``{"value": str|None, "source": str, "by_model": {...}}``.

    ``value`` is None when Claude falls back to its per-model built-in
    default, which IVE cannot know without the model catalogue.
    ``by_model`` lists ``modelSettings`` efforts so the UI can show the
    right default once a full model id is picked.
    """
    env = os.environ if env is None else env
    home_path = Path(home).expanduser() if home else Path.home()

    files: list[tuple[str, Path]] = []
    if workspace_path:
        ws = Path(workspace_path).expanduser()
        files.append(("project local settings", ws / ".claude" / "settings.local.json"))
        files.append(("project settings", ws / ".claude" / "settings.json"))
    files.append(("your Claude settings", home_path / ".claude" / "settings.json"))
    loaded = [(label, _read_json(path)) for label, path in files]

    by_model: dict[str, str] = {}
    for _label, data in reversed(loaded):  # lowest precedence first
        ms = data.get("modelSettings")
        if isinstance(ms, dict):
            for key, cfg in ms.items():
                lvl = _valid(cfg.get("effortLevel")) if isinstance(cfg, dict) else None
                if lvl:
                    by_model[str(key)] = lvl

    env_level = _valid(env.get("CLAUDE_CODE_EFFORT_LEVEL"))
    if env_level:
        return {"value": env_level, "source": "CLAUDE_CODE_EFFORT_LEVEL", "by_model": by_model}

    if model:
        for label, data in loaded:
            ms = data.get("modelSettings")
            if not isinstance(ms, dict):
                continue
            for key, cfg in ms.items():
                lvl = _valid(cfg.get("effortLevel")) if isinstance(cfg, dict) else None
                if lvl and _model_matches(str(key), model):
                    return {"value": lvl, "source": f"{label} for {key}", "by_model": by_model}

    for label, data in loaded:
        lvl = _valid(data.get("effortLevel"))
        if lvl:
            return {"value": lvl, "source": label, "by_model": by_model}

    return {"value": None, "source": "Claude default for the model", "by_model": by_model}


def default_label(resolved: dict) -> str:
    value = resolved.get("value")
    source = resolved.get("source") or ""
    if value:
        return f"Default ({value}, {source})"
    return "Default (Claude picks per model)"
