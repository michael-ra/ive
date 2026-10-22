"""Local research artifacts, addressed by workspace and execution identity.

The completed JSON document is the commit marker. Readers never guess a
directory from a query or accept an unfinished scratchpad as a final report.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path


def validated_id(value: str, name: str = "id") -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", value):
        raise ValueError(f"invalid research {name}")
    return value


def run_directory(root: str | Path, workspace_id: str | None, run_id: str) -> Path:
    base = Path(root).resolve()
    parts = (["workspaces", validated_id(workspace_id, "workspace_id")]
             if workspace_id is not None else ["instance"])
    parts += ["runs", validated_id(run_id, "run_id")]
    path = base
    for part in parts:
        path = path / part
        if path.is_symlink():
            raise ValueError("research artifact path must not contain symlinks")
    return path


def read_completed_run(root: str | Path, workspace_id: str | None, run_id: str,
                       *, entry_id: str | None, query: str) -> tuple[str, dict]:
    directory = run_directory(root, workspace_id, run_id)
    if entry_id is not None:
        validated_id(entry_id, "entry_id")
    for name in ("research.json", "comprehensive-report.md"):
        if (directory / name).is_symlink():
            raise ValueError("research artifact must not be a symlink")
    run = json.loads((directory / "research.json").read_text(encoding="utf-8"))
    if not isinstance(run, dict) or any((
        run.get("run_id") != run_id, run.get("workspace_id") != workspace_id,
        run.get("entry_id") != entry_id, run.get("query") != query,
        run.get("artifact_version") != 1,
    )):
        raise ValueError("research artifact identity mismatch")
    report = (directory / "comprehensive-report.md").read_text(encoding="utf-8")
    if not report.strip() or run.get("report_sha256") != hashlib.sha256(report.encode("utf-8")).hexdigest():
        raise ValueError("research report is empty or does not match its completion marker")
    source_rows(run)  # Validate the complete batch before a caller persists it.
    return report, run


def source_rows(run: dict) -> list[dict]:
    """Translate the engine's source index to ordinary local report citations."""
    sources = run.get("sources")
    if not isinstance(sources, list):
        raise ValueError("research source index must be an array")
    findings = run.get("findings", [])
    if not isinstance(findings, list) or not all(isinstance(item, dict) for item in findings):
        raise ValueError("research findings must be an array of objects")
    excerpts = {item.get("url"): item.get("excerpt", "") for item in findings
                if isinstance(item.get("url"), str)}
    result = []
    for source in sources:
        if not isinstance(source, dict) or not isinstance(source.get("url"), str) or not source["url"].strip():
            raise ValueError("research source requires a URL")
        title = source.get("title", "")
        summary = excerpts.get(source["url"], "")
        score = source.get("relevance_score", 0.5)
        if not isinstance(title, str) or not isinstance(summary, str):
            raise ValueError("research source title and excerpt must be text")
        if not isinstance(score, (int, float)) or isinstance(score, bool) or not math.isfinite(score):
            raise ValueError("research source relevance must be finite")
        result.append({"url": source["url"], "title": title, "content_summary": summary,
                       "relevance_score": float(score)})
    return result
