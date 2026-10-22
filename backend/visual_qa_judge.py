#!/usr/bin/env python3
"""Registry-routed vision judge for the Playwright visual QA sweep."""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from llm_router import call_json, resolve_model
from model_providers import ModelProviderError


SYSTEM_PROMPT = """You are a deterministic visual QA inspector.
Inspect only visible pixels in the supplied screenshot(s). Apply only the named
rubric rules. Do not score taste, infer hidden DOM/CSS, or report expected empty
data called out in the screen context. A finding is valid only when it names one
rubric rule and one precise visible element/location. If the pixels do not make
a violation clear, omit it. Return one JSON object and no prose outside JSON."""

SEVERITIES = frozenset({"critical", "high", "medium", "low"})
DEFAULT_JUDGE_TIMEOUT_S = 40.0


def _prompt_for(capture: dict[str, Any], rubric: dict[str, Any], baseline: bool) -> str:
    rules = "\n".join(
        f"- {rule['id']} — {rule['name']}: {rule['requirement']}"
        for rule in rubric["rules"]
    )
    severity = "\n".join(
        f"- {name}: {description}"
        for name, description in rubric["severity"].items()
    )
    comparison = (
        "Two images are attached in this exact order: (1) approved baseline, "
        "(2) current capture. Report only named-rule violations that are new or "
        "visibly worse in the current capture. If nothing worsened, return an "
        "empty findings array even when both images share an old defect."
        if baseline
        else
        "One current capture is attached. Report only unambiguous visible rule violations."
    )
    return f"""Screen: {capture['screen']}
Surface: {capture['label']}
State context: {capture['state_note']}
Comparison mode: {'baseline' if baseline else 'absolute'}
{comparison}

Rubric:
{rules}

Severity definitions:
{severity}

Required response shape:
{{
  "screen": "{capture['screen']}",
  "findings": [
    {{
      "element_location": "specific visible region and element",
      "rule_id": "one rubric id above",
      "severity": "critical|high|medium|low",
      "evidence": "short description of what is visibly wrong"
    }}
  ]
}}

Do not estimate exact CSS values from subtle antialiasing. Geometry findings must
be visually obvious, such as a card rendered as a pill, a blank icon button,
clipped text, overlap, overflow, a blue control, or visibly ragged columns."""


def _normalize_findings(
    raw: Any,
    capture: dict[str, Any],
    rule_by_id: dict[str, dict[str, str]],
) -> tuple[list[dict[str, str]], int]:
    candidates = raw.get("findings") if isinstance(raw, dict) else None
    if not isinstance(candidates, list):
        raise ValueError("vision response must contain a findings array")

    findings: list[dict[str, str]] = []
    rejected = 0
    for candidate in candidates:
        if not isinstance(candidate, dict):
            rejected += 1
            continue
        location = str(candidate.get("element_location") or "").strip()
        rule_id = str(candidate.get("rule_id") or "").strip()
        severity = str(candidate.get("severity") or "").strip().lower()
        evidence = str(candidate.get("evidence") or "").strip()
        if not location or rule_id not in rule_by_id or severity not in SEVERITIES:
            rejected += 1
            continue
        rule = rule_by_id[rule_id]
        findings.append({
            "screen": capture["screen"],
            "element_location": location,
            "rule_id": rule_id,
            "rule_violated": f"{rule['name']}: {rule['requirement']}",
            "severity": severity,
            "evidence": evidence,
        })
    return findings, rejected


async def _judge(request: dict[str, Any]) -> dict[str, Any]:
    model_id = str(request.get("model") or "").strip()
    if not model_id:
        raise ModelProviderError(
            "judge request field 'model' must contain provider:model",
            code="provider_not_configured",
        )

    await resolve_model(model_id, required_capability="json")
    await resolve_model(model_id, required_capability="vision")

    rubric = request.get("rubric")
    captures = request.get("captures")
    if not isinstance(rubric, dict) or not isinstance(rubric.get("rules"), list):
        raise ValueError("judge request has no valid rubric")
    if not isinstance(captures, list):
        raise ValueError("judge request has no capture list")

    rule_by_id = {
        rule["id"]: rule
        for rule in rubric["rules"]
        if isinstance(rule, dict) and isinstance(rule.get("id"), str)
    }
    mode = "baseline" if request.get("mode") == "baseline" else "absolute"
    try:
        timeout_s = float(os.environ.get(
            "IVE_VISUAL_QA_TIMEOUT_S", str(DEFAULT_JUDGE_TIMEOUT_S)
        ))
    except ValueError as exc:
        raise ModelProviderError(
            "IVE_VISUAL_QA_TIMEOUT_S must be a positive number",
            code="invalid_timeout",
        ) from exc
    all_findings: list[dict[str, str]] = []
    errors: list[dict[str, Any]] = []
    rejected_findings = 0
    judged = 0

    for capture in captures:
        screen = str(capture.get("screen") or "") if isinstance(capture, dict) else ""
        try:
            current_path = Path(capture["path"])
            image_inputs = []
            if mode == "baseline":
                image_inputs.append({"path": str(Path(capture["baseline_path"])), "media_type": "image/png"})
            image_inputs.append({"path": str(current_path), "media_type": "image/png"})
            raw = await call_json(
                model_id,
                _prompt_for(capture, rubric, mode == "baseline"),
                system=SYSTEM_PROMPT,
                images=image_inputs,
                timeout_s=timeout_s,
                allow_fallback=False,
            )
            findings, rejected = _normalize_findings(raw, capture, rule_by_id)
            all_findings.extend(findings)
            rejected_findings += rejected
            judged += 1
        except ModelProviderError as exc:
            error: dict[str, Any] = {
                "screen": screen,
                "code": exc.code,
                "message": str(exc),
            }
            if exc.provider_code:
                error["provider_code"] = exc.provider_code
            if exc.retry_after_s is not None:
                error["retry_after_s"] = exc.retry_after_s
            errors.append(error)
        except (KeyError, OSError, TypeError, ValueError) as exc:
            errors.append({
                "screen": screen,
                "code": "invalid_judge_input",
                "message": type(exc).__name__,
            })

    return {
        "status": "complete" if not errors else "partial" if judged else "failed",
        "model": model_id,
        "mode": mode,
        "judged": judged,
        "finding_count": len(all_findings),
        "rejected_finding_count": rejected_findings,
        "findings": all_findings,
        "errors": errors,
    }


async def _main() -> int:
    request: dict[str, Any] = {}
    try:
        raw_request = json.load(sys.stdin)
        if not isinstance(raw_request, dict):
            raise ValueError("judge request must be a JSON object")
        request = raw_request
        result = await _judge(request)
    except ModelProviderError as exc:
        result = {
            "status": "configuration_error",
            "model": str(request.get("model") or ""),
            "mode": "baseline" if request.get("mode") == "baseline" else "absolute",
            "judged": 0,
            "finding_count": 0,
            "rejected_finding_count": 0,
            "findings": [],
            "errors": [{
                "screen": "",
                "code": exc.code,
                "message": f"vision provider not configured: {exc}",
            }],
        }
        json.dump(result, sys.stdout)
        sys.stdout.write("\n")
        return 2
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        result = {
            "status": "invalid_request",
            "findings": [],
            "errors": [{"screen": "", "code": "invalid_request", "message": str(exc)}],
        }
        json.dump(result, sys.stdout)
        sys.stdout.write("\n")
        return 2

    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    return 0 if result["status"] == "complete" else 3


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
