"""IVE-hosted sweep — a server-side multi-agent fan-out any runtime can invoke.

Claude Code brings its own Workflow engine; agy/codex do not. `run_sweep` gives
them (and Claude) an ephemeral parallel fan-out: N prompts run concurrently
through `llm_router`, each result is recorded as provenance in `workflow_runs`,
and an optional synthesis pass merges them. The sweep's actual FINDINGS should
still be written to their durable home by the caller (`contribute_knowledge`
for facts/patterns, `code_catalog` for symbols) — this engine records the run
and returns the synthesis, it does not persist domain knowledge itself.

Exposed via the `run_sweep` MCP tool → POST /api/orchestration/sweeps (the same
shared MCP surface every runtime connects to).
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid

from aiohttp import web

logger = logging.getLogger(__name__)

_MAX_PROMPTS = 32
_DEFAULT_PARALLEL = 4
_MAX_PARALLEL = 8
_PER_AGENT_TIMEOUT_S = 180


async def _record(run_id: str, **fields) -> None:
    """Patch a subset of mutable columns on a workflow_runs row."""
    from db import get_db
    db = await get_db()
    try:
        sets, vals = [], []
        for key, val in fields.items():
            sets.append(f"{key} = ?")
            vals.append(json.dumps(val) if isinstance(val, (dict, list)) else val)
        if fields.get("status") in ("completed", "failed", "cancelled"):
            sets.append("completed_at = datetime('now')")
        sets.append("updated_at = datetime('now')")
        vals.append(run_id)
        await db.execute(f"UPDATE workflow_runs SET {', '.join(sets)} WHERE id = ?", vals)
        await db.commit()
    finally:
        await db.close()


async def run_sweep(
    workspace_id: str,
    prompts: list[str],
    *,
    label: str = "sweep",
    parallel: int = _DEFAULT_PARALLEL,
    model_id: str = "claude:sonnet",
    synthesize: bool = True,
    synthesis_prompt: str | None = None,
    kind: str = "sweep",
    runtime: str = "ive",
    session_id: str | None = None,
) -> dict:
    """Run `prompts` concurrently (bounded by `parallel`), record provenance in
    workflow_runs, and optionally synthesize. Returns the run id + per-agent
    results + synthesis. A single agent failing does not abort the sweep.
    """
    if not isinstance(prompts, list):
        return {"error": "prompts (non-empty list of strings) required"}
    prompts = [p for p in prompts if isinstance(p, str) and p.strip()]
    if not prompts:
        return {"error": "prompts (non-empty list of strings) required"}
    if len(prompts) > _MAX_PROMPTS:
        logger.info("run_sweep: capping %d prompts to %d", len(prompts), _MAX_PROMPTS)
        prompts = prompts[:_MAX_PROMPTS]
    try:
        parallel = max(1, min(int(parallel or _DEFAULT_PARALLEL), _MAX_PARALLEL))
    except (TypeError, ValueError, OverflowError):
        return {"error": "parallel must be a whole number from 1 to 8", "field": "parallel"}
    if synthesis_prompt is not None and not isinstance(synthesis_prompt, str):
        return {"error": "synthesis_prompt must be text", "field": "synthesis_prompt"}
    from llm_router import call_json, resolve_model
    from model_providers import ModelProviderError
    try:
        await resolve_model(model_id, required_capability="json")
    except ModelProviderError as exc:
        return {"error": str(exc), "code": exc.code, "field": "model"}

    run_id = str(uuid.uuid4())
    from db import get_db
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO workflow_runs (id, workspace_id, session_id, kind, label, "
            "source, runtime, status, agents_total, params) "
            "VALUES (?, ?, ?, ?, ?, 'ive_run_sweep', ?, 'running', ?, ?)",
            (run_id, workspace_id, session_id, kind, label, runtime, len(prompts),
             json.dumps({"prompts": prompts, "parallel": parallel,
                         "model": model_id, "synthesize": synthesize})),
        )
        await db.commit()
    finally:
        await db.close()

    sem = asyncio.Semaphore(parallel)
    results: list[dict] = [{} for _ in prompts]

    async def _one(idx: int, prompt: str) -> None:
        async with sem:
            try:
                response = await call_json(
                    model_id,
                    prompt,
                    system=(
                        "Complete the requested work. Return exactly one JSON object "
                        "with a string field named text containing your full result."
                    ),
                    timeout_s=_PER_AGENT_TIMEOUT_S,
                    allow_fallback=True,
                )
                text = str(response.get("text") or "")
                results[idx] = {"idx": idx, "ok": True, "text": text or "", "error": None}
            except Exception as exc:
                logger.warning("run_sweep agent %d failed: %s", idx, exc)
                results[idx] = {"idx": idx, "ok": False, "text": "", "error": str(exc)}

    try:
        await asyncio.gather(*[_one(i, p) for i, p in enumerate(prompts)])
    except asyncio.CancelledError:
        await _record(run_id, status="cancelled", agents_done=sum(1 for r in results if r.get("ok")))
        raise

    subagents = [{
        "agent_id": str(r["idx"]),
        "label": f"agent {r['idx']}",
        "status": "completed" if r["ok"] else "failed",
        "result_preview": (r["text"][:200] or None) if r["ok"] else (r["error"] or "")[:200],
    } for r in results]
    done = sum(1 for r in results if r["ok"])

    synthesis: str | None = None
    if synthesize and done:
        joined = "\n\n".join(f"## Agent {r['idx']}\n{r['text']}" for r in results if r["ok"])
        instr = synthesis_prompt or (
            "Synthesize the results of a parallel sweep. Merge the agent outputs "
            "below into one cohesive, de-duplicated answer; note any disagreements.\n\n"
        )
        try:
            synthesis_result = await call_json(
                model_id,
                instr + joined,
                system=(
                    "Return exactly one JSON object with a string field named text "
                    "containing the complete synthesis."
                ),
                timeout_s=_PER_AGENT_TIMEOUT_S,
                allow_fallback=True,
            )
            synthesis = str(synthesis_result.get("text") or "") or None
        except asyncio.CancelledError:
            await _record(run_id, status="cancelled", agents_done=done, subagents=subagents)
            raise
        except Exception as exc:
            logger.warning("run_sweep synthesis failed: %s", exc)

    status = "completed" if done else "failed"
    final_result = synthesis if synthesis is not None else "\n\n".join(
        r["text"] for r in results if r["ok"])
    await _record(run_id, status=status, agents_done=done, subagents=subagents,
                  result=final_result)

    return {
        "run_id": run_id,
        "status": status,
        "agents_total": len(prompts),
        "agents_done": done,
        "synthesis": synthesis,
        "results": [{"idx": r["idx"], "ok": r["ok"], "text": r["text"],
                     "error": r["error"]} for r in results],
    }


async def handle_run_sweep(request: web.Request) -> web.Response:
    """POST /api/orchestration/sweeps — runtime-agnostic sweep entrypoint."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        return web.json_response({"error": "request body must be an object"}, status=400)
    workspace_id = body.get("workspace_id") or (request.headers.get("X-IVE-Workspace-Id") or "").strip()
    if not workspace_id:
        return web.json_response({"error": "workspace_id required"}, status=400)
    prompts = body.get("prompts")
    if not isinstance(prompts, list) or not prompts:
        return web.json_response({"error": "prompts (non-empty list) required"}, status=400)
    session_id = (request.headers.get("X-IVE-Session-Id") or "").strip() or None
    if "cli" in body:
        return web.json_response({
            "error": "use one provider-qualified model id; the separate cli field was removed",
            "code": "legacy_model_shape",
        }, status=400)

    result = await run_sweep(
        workspace_id,
        prompts,
        label=body.get("label", "sweep"),
        parallel=body.get("parallel", _DEFAULT_PARALLEL),
        model_id=body.get("model") or "claude:sonnet",
        synthesize=bool(body.get("synthesize", True)),
        synthesis_prompt=body.get("synthesis_prompt"),
        kind=body.get("kind", "sweep"),
        runtime=body.get("runtime", "ive"),
        session_id=session_id,
    )
    return web.json_response(result, status=400 if result.get("error") else 200)
