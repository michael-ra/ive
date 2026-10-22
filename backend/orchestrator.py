"""orchestrator.py — C4 of the orchestrator redesign: a GATED, deterministic
workflow orchestrator ("Commander as workflow orchestrator").

It composes C1 (typed, schema-validated stage results) and C2 (harness-portable
role templates) into a controller whose control flow is decided IN CODE from the
typed result objects of each node — not from PTY-paste + terminal-idle heuristics
+ keyword scraping. It supports fan-out and a real fan-in BARRIER (a join node
waits for all its parents' typed results before running, so a synthesis/integration
node actually receives every branch's structured output).

Design constraints (deliberate):
  * ADDITIVE and OFF by default. Enabled only when ORCHESTRATOR_V2 is truthy. The
    existing four deciders (Commander/auto_exec/worker_queue/Brain) are untouched
    and remain the default path. Nothing here is wired into default dispatch.
  * Node execution is DEPENDENCY-INJECTED: run_workflow(graph, executor) takes an
    async `executor(node, parent_results) -> dict` (the typed result). This makes
    the control flow unit-testable with a fake executor, and lets a real executor
    that rides pipeline_engine's PTY sessions be supplied later WITHOUT changing
    control flow. (C3 HeadlessDriver will provide a non-PTY real executor.)
  * The harness for each node comes from the role template (C2), so a single graph
    can mix claude/codex/antigravity nodes.

This module is import-safe: heavy backend modules are imported lazily inside
functions, so importing orchestrator never pulls in the whole server.
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Awaitable, Callable, Optional


# ── Gating ──────────────────────────────────────────────────────────────────

def is_enabled() -> bool:
    """The deterministic orchestrator is opt-in. Off unless ORCHESTRATOR_V2 is
    set to a truthy value in the environment (or a workspace flag flips it via a
    future wiring). Keeps the running system on the existing dispatch path."""
    return str(os.environ.get("ORCHESTRATOR_V2", "")).strip().lower() in ("1", "true", "yes", "on")


# ── Edge evaluation over typed results ────────────────────────────────────────

def _edge_fires(edge: dict, result: Optional[dict]) -> bool:
    """Does this outgoing edge fire, given the source node's typed result?

    Conditions: always | on_pass | on_fail | on_expr | on_match. on_pass/on_fail
    read result.verdict/status (and a schema-validation error counts as fail);
    on_expr evaluates a safe boolean predicate (shared with pipeline_engine)."""
    cond = edge.get("condition", "always")
    if cond == "always":
        return True
    res = result if isinstance(result, dict) else {}
    verdict = str(res.get("verdict") or res.get("status") or "").lower()
    if cond == "on_pass":
        return verdict == "pass" or (verdict == "" and not res.get("_schema_error"))
    if cond == "on_fail":
        return verdict == "fail" or bool(res.get("_schema_error"))
    if cond == "on_expr":
        expr = (edge.get("condition_config") or {}).get("expr", "")
        try:
            from pipeline_engine import _safe_eval_expr
            return _safe_eval_expr(expr, res)
        except Exception:
            return False
    if cond == "on_match":
        pat = (edge.get("condition_config") or {}).get("pattern", "")
        return bool(pat) and pat.lower() in json.dumps(res).lower()
    return False


def _collect_edges(nodes: dict) -> list[dict]:
    """Flatten per-node `transitions` into a global edge list."""
    edges: list[dict] = []
    for nid, node in nodes.items():
        for t in node.get("transitions", []) or []:
            edges.append({
                "source": nid,
                "target": t["target"],
                "condition": t.get("condition", "always"),
                "condition_config": t.get("condition_config") or {},
            })
    return edges


# ── Deterministic controller ──────────────────────────────────────────────────

async def run_workflow(
    graph: dict,
    executor: Callable[[dict, dict], Awaitable[dict]],
    budget: Optional[dict] = None,
    seed_results: Optional[dict] = None,
) -> dict:
    """Deterministically execute a typed node graph.

    graph = {
      "nodes": { node_id: {role, prompt?, input?, result_schema?, join?: "all"|"any",
                           transitions: [{condition, target, condition_config?}]} },
      "entry": [node_id, ...]   # optional; defaults to nodes with no parents
    }
    executor(node, parent_results) -> dict  (the node's typed result)

    Control flow: entry nodes run concurrently (fan-out); when a node completes,
    its outgoing edges are evaluated against its typed result and matching targets
    become eligible. A node with join="all" is a BARRIER — it runs only once every
    parent has completed, and its executor receives all parent results (for
    synthesis). budget={"max_nodes": N} caps total node launches (runaway guard).

    seed_results (resume support): {node_id: typed_result} from a PRIOR run of the
    same graph. Seeded nodes are marked completed/launched WITHOUT re-executing —
    their edges are evaluated against the seeded result so downstream nodes become
    eligible exactly as if they had just run. Seeded nodes count toward max_nodes
    (the launch budget bounds the plan across its whole life, resumes included).

    Returns {results, completed, fired_edges, budget_hit}."""
    nodes: dict = graph["nodes"]
    edges = graph.get("edges") or _collect_edges(nodes)
    parents: dict[str, set] = {nid: set() for nid in nodes}
    for e in edges:
        if e["target"] in parents:
            parents[e["target"]].add(e["source"])
    entry = graph.get("entry") or [nid for nid in nodes if not parents[nid]]

    results: dict[str, dict] = {}
    completed: set[str] = set()
    launched: set[str] = set()
    fired_edges: list[dict] = []
    budget = budget or {}
    max_nodes = budget.get("max_nodes")
    budget_hit = {"v": False}
    lock = asyncio.Lock()
    tasks: dict[str, asyncio.Future] = {}

    # Seed prior-run terminals (resume): completed + launched, never re-executed.
    for _nid, _res in (seed_results or {}).items():
        if _nid in nodes and isinstance(_res, dict):
            results[_nid] = _res
            completed.add(_nid)
            launched.add(_nid)

    def _ready(nid: str) -> bool:
        ps = parents[nid]
        if not ps:
            return True
        node = nodes[nid]
        if node.get("join") == "all":
            # Barrier: wait for every parent to complete (regardless of which
            # branch edge fired) so a synthesis node sees all branches.
            return all(p in completed for p in ps)
        # default "any": at least one fired edge from a completed parent targets us
        return any(
            e["target"] == nid and e["source"] in completed and _edge_fires(e, results.get(e["source"]))
            for e in edges
        )

    async def _maybe_launch(nid: str) -> None:
        async with lock:
            if nid in launched or nid not in nodes:
                return
            if not _ready(nid):
                return
            if max_nodes is not None and len(launched) >= max_nodes:
                budget_hit["v"] = True
                return
            launched.add(nid)
        tasks[nid] = asyncio.ensure_future(_run_node(nid))

    async def _run_node(nid: str) -> None:
        node = nodes[nid]
        parent_results = {p: results.get(p) for p in parents[nid] if p in completed}
        try:
            res = await executor(node, parent_results)
        except Exception as exc:  # a node failure is a typed 'fail', not a crash
            res = {"verdict": "fail", "error": str(exc)}
        if not isinstance(res, dict):
            res = {"verdict": "pass", "value": res}
        schema = node.get("result_schema")
        if schema:
            try:
                from pipeline_engine import validate_against_schema
                err = validate_against_schema(res, schema)
                if err:
                    res = {**res, "_schema_error": err}
            except Exception:
                pass
        async with lock:
            results[nid] = res
            completed.add(nid)
        # Evaluate outgoing edges; collect children to (re)check for readiness.
        children: set[str] = set()
        for e in edges:
            if e["source"] != nid:
                continue
            children.add(e["target"])
            if _edge_fires(e, res):
                fired_edges.append({"source": nid, "target": e["target"], "condition": e["condition"]})
        # Also re-check barrier nodes whose last parent may have just completed.
        for cid, ps in parents.items():
            if nid in ps and nodes.get(cid, {}).get("join") == "all":
                children.add(cid)
        await asyncio.gather(*[_maybe_launch(c) for c in children])

    initial: list[str] = list(entry)
    if completed:
        # Resume: seeded nodes' edges fire against their seeded results so their
        # children (and any barrier whose parents are all seeded) become eligible.
        for e in edges:
            if e["source"] in completed and _edge_fires(e, results.get(e["source"])):
                fired_edges.append({"source": e["source"], "target": e["target"],
                                    "condition": e["condition"]})
                initial.append(e["target"])
        for cid, ps in parents.items():
            if ps and nodes.get(cid, {}).get("join") == "all" and ps & completed:
                initial.append(cid)
    await asyncio.gather(*[_maybe_launch(nid) for nid in dict.fromkeys(initial)])
    # Drain: children scheduled during a node's completion get picked up here.
    while True:
        pending = [t for t in tasks.values() if not t.done()]
        if not pending:
            break
        await asyncio.gather(*pending, return_exceptions=True)

    return {
        "results": results,
        "completed": sorted(completed),
        "fired_edges": fired_edges,
        "budget_hit": budget_hit["v"],
    }


# ── Graph construction from a goal ────────────────────────────────────────────

def build_graph_from_goal(goal: str, workspace_id: Optional[str] = None) -> dict:
    """Build a typed plan→implement→verify→(fix loop)→done graph, drawing each
    node's result_schema from the C2 role templates. This is the typed-node
    expression of the existing dynamic task pipeline; a real executor turns each
    node into an agent run, but control flow is decided from typed results."""
    try:
        import role_templates
        planner_schema = role_templates.role_result_schema("planner")
        worker_schema = role_templates.role_result_schema("worker")
        tester_schema = role_templates.role_result_schema("tester")
    except Exception:
        planner_schema = worker_schema = tester_schema = None

    nodes = {
        "plan": {
            "role": "planner",
            "prompt": f"Produce an ordered implementation plan for: {goal}",
            "result_schema": planner_schema,
            "transitions": [{"condition": "always", "target": "implement"}],
        },
        "implement": {
            "role": "worker",
            "prompt": f"Implement the plan for: {goal}",
            "result_schema": worker_schema,
            "context_from": ["plan"],
            "transitions": [{"condition": "always", "target": "verify"}],
        },
        "verify": {
            "role": "tester",
            "prompt": "Verify the implementation. Run tests and report a typed verdict.",
            "original_prompt": goal,
            "result_schema": tester_schema,
            "context_from": ["implement"],
            "transitions": [
                {"condition": "on_expr", "condition_config": {"expr": "verdict == 'pass'"}, "target": "done"},
                {"condition": "on_expr", "condition_config": {"expr": "verdict == 'fail'"}, "target": "fix"},
            ],
        },
        "fix": {
            "role": "worker",
            "prompt": "Fix the failures reported by verification.",
            "result_schema": worker_schema,
            "context_from": ["verify"],
            "transitions": [{"condition": "always", "target": "verify"}],  # loop back
        },
        "done": {
            "role": "worker",
            "prompt": "Summarize the completed work.",
            "transitions": [],
        },
    }
    return {"nodes": nodes, "entry": ["plan"], "goal": goal, "workspace_id": workspace_id}


# ── C3: HeadlessDriver — run orchestrated nodes via a CLI in headless mode ────
#
# The deterministic controller above is executor-agnostic. This driver is a REAL
# executor that runs each node as a one-shot headless CLI invocation returning a
# JSON object on stdout — no PTY, no terminal-idle heuristic, no scrollback
# scraping. The harness for each node comes from its C2 role template, so a graph
# can mix claude/codex/antigravity nodes. The argv builder is pluggable so the
# same driver runs a real CLI in production and a deterministic stub in tests.

def _extract_json_object(text: str) -> Optional[dict]:
    """Extract the last top-level JSON object from CLI stdout. Tolerates leading
    log lines / trailing prose around the object. Returns None if none found."""
    if not text:
        return None
    # Fast path: whole output is JSON.
    stripped = text.strip()
    try:
        obj = json.loads(stripped)
        return obj if isinstance(obj, dict) else None
    except Exception:
        pass
    # Scan for the last balanced {...} block.
    depth = 0
    start = -1
    candidate = None
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    chunk = text[start:i + 1]
                    try:
                        obj = json.loads(chunk)
                        if isinstance(obj, dict):
                            candidate = obj
                    except Exception:
                        pass
    return candidate


def _default_argv_builder(cli_type: Optional[str], model: Optional[str], prompt: str) -> list[str]:
    """Build a headless CLI command line for the given harness. Only `claude` is
    wired for real here (Claude Code print mode); codex/antigravity slots are
    provided but must be validated against an installed CLI before use."""
    if cli_type in (None, "claude"):
        argv = ["claude", "-p", prompt]
        if model:
            argv += ["--model", model]
        return argv
    if cli_type == "codex":
        return ["codex", "exec", prompt]
    if cli_type == "antigravity":
        return ["antigravity", "run", prompt]
    return ["claude", "-p", prompt]


def _build_node_prompt(node: dict, parent_results: dict) -> str:
    """Compose the headless prompt: role system fragment + node prompt + parents'
    typed results + a strict JSON-only instruction bound to the node's schema."""
    parts: list[str] = []
    role = node.get("role")
    try:
        import role_templates
        tmpl = role_templates.get_role_template(role)
        if tmpl and tmpl.get("system_fragment"):
            parts.append(tmpl["system_fragment"])
    except Exception:
        pass
    if node.get("prompt"):
        parts.append(str(node["prompt"]))
    compact = {}
    if parent_results:
        compact = {k: v for k, v in parent_results.items() if v is not None}
        if compact:
            parts.append("Upstream results:\n" + json.dumps(compact, indent=2)[:4000])
    schema = node.get("result_schema")
    if schema:
        parts.append(
            "Respond with ONLY a single JSON object (no prose, no code fence) "
            "matching this schema:\n" + json.dumps(schema, indent=2)
        )
    else:
        parts.append('Respond with ONLY a JSON object, e.g. {"verdict": "pass", "summary": "..."}.')
    prompt = "\n\n".join(parts)
    if str(node.get("role") or "").lower() in {"tester", "code_reviewer", "plan_critic", "reviewer"}:
        try:
            from review_brief import build_review_brief
            prompt = build_review_brief(
                prompt,
                original_prompt=node.get("original_prompt"),
                board_card=node.get("board_card"),
                handoff_notes=json.dumps(compact, indent=2) if compact else None,
            )
        except Exception:
            pass
    return prompt


def make_headless_executor(
    argv_builder: Optional[Callable[[Optional[str], Optional[str], str], list[str]]] = None,
    *,
    active_clis: Optional[list[str]] = None,
    policy_raw: Any = None,
    cwd: Optional[str] = None,
    timeout: float = 600.0,
    env: Optional[dict] = None,
):
    """Return an async executor(node, parent_results) -> typed dict that runs each
    node as a headless CLI subprocess and parses a JSON result from stdout. The
    harness/model come from the node's C2 role template (resolve_binding). Any
    failure (spawn error, timeout, non-JSON output) becomes a typed
    {"verdict": "fail", ...} rather than raising, so the graph keeps flowing."""
    build_argv = argv_builder or _default_argv_builder

    async def _executor(node: dict, parent_results: dict) -> dict:
        role = node.get("role")
        cli_type = model = None
        try:
            import role_templates
            binding = role_templates.resolve_binding(role, active_clis=active_clis, policy_raw=policy_raw)
            cli_type, model = binding.get("cli_type"), binding.get("model")
        except Exception:
            pass
        prompt = _build_node_prompt(node, parent_results)
        argv = build_argv(cli_type, model, prompt)
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=env,
            )
        except FileNotFoundError as exc:
            return {"verdict": "fail", "error": f"harness not found: {exc}"}
        except Exception as exc:
            return {"verdict": "fail", "error": f"spawn failed: {exc}"}
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except Exception:
                pass
            return {"verdict": "fail", "error": f"headless node timed out after {timeout}s"}
        stdout = (out or b"").decode("utf-8", "replace")
        result = _extract_json_object(stdout)
        if result is None:
            return {
                "verdict": "fail",
                "error": "no JSON object in headless output",
                "raw_tail": stdout[-500:],
                "stderr_tail": (err or b"").decode("utf-8", "replace")[-300:],
            }
        return result

    return _executor


# ── Self-test (no PTY / no CLI needed) ────────────────────────────────────────

async def run_selftest() -> dict:
    """Exercise the deterministic control flow with a FAKE executor returning
    canned typed results — no real CLI/PTY. Verifies: (1) on_expr branching on a
    typed field routes to the right node, (2) a join='all' barrier waits for all
    parents and receives their results. Returns a report dict; raises AssertionError
    on failure so a verifier can gate on it."""
    trace: list[str] = []

    # Test 1: branch on typed verdict.
    async def exec_branch(node, parents):
        trace.append(node.get("_id", "?"))
        if node["role"] == "tester":
            return {"verdict": "pass"}
        return {"verdict": "pass"}

    graph1 = {
        "nodes": {
            "a": {"_id": "a", "role": "worker", "transitions": [
                {"condition": "on_expr", "condition_config": {"expr": "verdict == 'pass'"}, "target": "b_pass"},
                {"condition": "on_expr", "condition_config": {"expr": "verdict == 'fail'"}, "target": "b_fail"},
            ]},
            "b_pass": {"_id": "b_pass", "role": "worker", "transitions": []},
            "b_fail": {"_id": "b_fail", "role": "worker", "transitions": []},
        },
        "entry": ["a"],
    }
    r1 = await run_workflow(graph1, exec_branch)
    assert "b_pass" in r1["completed"], f"expected b_pass to run, got {r1['completed']}"
    assert "b_fail" not in r1["completed"], f"b_fail should NOT run, got {r1['completed']}"

    # Test 2: fan-out A,B -> barrier C that must see both parents' results.
    seen_parents = {}

    async def exec_barrier(node, parents):
        if node["_id"] == "c":
            seen_parents.update(parents)
        return {"verdict": "pass", "who": node["_id"]}

    graph2 = {
        "nodes": {
            "a": {"_id": "a", "role": "worker", "transitions": [{"condition": "always", "target": "c"}]},
            "b": {"_id": "b", "role": "worker", "transitions": [{"condition": "always", "target": "c"}]},
            "c": {"_id": "c", "role": "worker", "join": "all", "transitions": []},
        },
        "entry": ["a", "b"],
    }
    r2 = await run_workflow(graph2, exec_barrier)
    assert "c" in r2["completed"], "barrier node c must run"
    assert set(seen_parents.keys()) == {"a", "b"}, f"barrier must see both parents, saw {set(seen_parents)}"

    # Test 3: budget cap stops runaway.
    async def exec_pass(node, parents):
        return {"verdict": "pass"}
    long_nodes = {f"n{i}": {"role": "worker", "transitions": ([{"condition": "always", "target": f"n{i+1}"}] if i < 9 else [])} for i in range(10)}
    r3 = await run_workflow({"nodes": long_nodes, "entry": ["n0"]}, exec_pass, budget={"max_nodes": 3})
    assert r3["budget_hit"] is True, "budget cap should trip"
    assert len(r3["completed"]) <= 3, f"budget should cap launches, ran {r3['completed']}"

    return {"ok": True, "test1": r1["completed"], "test2_parents": sorted(seen_parents), "test3_completed": r3["completed"]}


async def run_headless_selftest() -> dict:
    """Prove the HeadlessDriver end-to-end with a deterministic STUB cli: build a
    real subprocess per node, parse its JSON stdout into a typed result, and
    branch on it via on_expr — with no dependency on a real (authed) CLI. This
    exercises the exact production path (spawn → stdout → _extract_json_object →
    schema-validate → typed result → deterministic branch)."""
    import sys
    import tempfile
    import os as _os

    stub = (
        "import sys, json\n"
        "prompt = sys.argv[-1] if len(sys.argv) > 1 else ''\n"
        # Emit leading noise + a code fence to prove robust extraction.
        "print('booting stub cli...')\n"
        "verdict = 'fail' if 'FORCE_FAIL' in prompt else 'pass'\n"
        "print('```json'); print(json.dumps({'verdict': verdict, 'summary': prompt[:24]})); print('```')\n"
    )
    fd, stub_path = tempfile.mkstemp(suffix="_stubcli.py")
    with _os.fdopen(fd, "w") as f:
        f.write(stub)
    try:
        def argv_builder(cli_type, model, prompt):
            return [sys.executable, stub_path, prompt]

        executor = make_headless_executor(argv_builder=argv_builder, timeout=30.0)

        graph = {
            "nodes": {
                "gen": {"role": "worker",
                        "prompt": "produce something",
                        "result_schema": {"type": "object", "required": ["verdict"],
                                          "properties": {"verdict": {"type": "string", "enum": ["pass", "fail"]}}},
                        "transitions": [
                            {"condition": "on_expr", "condition_config": {"expr": "verdict == 'pass'"}, "target": "ship"},
                            {"condition": "on_expr", "condition_config": {"expr": "verdict == 'fail'"}, "target": "rollback"},
                        ]},
                "ship": {"role": "worker", "prompt": "ship it", "transitions": []},
                "rollback": {"role": "worker", "prompt": "FORCE_FAIL rollback", "transitions": []},
            },
            "entry": ["gen"],
        }
        r = await run_workflow(graph, executor)
        assert "ship" in r["completed"], f"headless: expected ship to run, got {r['completed']}"
        assert "rollback" not in r["completed"], f"headless: rollback should not run, got {r['completed']}"
        gen_result = r["results"].get("gen") or {}
        assert gen_result.get("verdict") == "pass", f"headless: gen must parse typed verdict, got {gen_result}"
        return {"ok": True, "completed": r["completed"], "gen_result": gen_result}
    finally:
        try:
            _os.unlink(stub_path)
        except Exception:
            pass


if __name__ == "__main__":
    import sys
    if "--headless" in sys.argv:
        print(json.dumps(asyncio.run(run_headless_selftest()), indent=2))
    else:
        print(json.dumps(asyncio.run(run_selftest()), indent=2))
