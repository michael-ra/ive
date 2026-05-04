"""Standalone tests for code_catalog upsert + history engine.

Run with:  python backend/code_catalog_test.py
Exits 0 on pass, 1 on any failure. Spins up a temp SQLite DB; no pytest.

Uses the same DB initialization path as the real server (db.init_db) so
the workspace_knowledge + code_catalog_history schemas are exercised.
"""

import asyncio
import os
import sys
import tempfile
import traceback
import uuid
from pathlib import Path


# ── Bring up a temp DB before importing anything that touches db.py ──────


_tmpdir = Path(tempfile.mkdtemp(prefix="ive_catalog_test_"))

import db as db_mod  # noqa: E402

# Re-point module-level names that get_db reads on every connect.
db_mod.DATA_DIR = _tmpdir
db_mod.DB_PATH = _tmpdir / "data.db"

# Many code paths import event_bus + commander_events at module-import time.
# Stub the event bus so our upsert path doesn't fan out to the real bus.
import commander_events  # noqa: E402,F401 — ensures self-checks run
import event_bus as _bus_mod  # noqa: E402


_emitted: list[tuple[str, dict]] = []


class _FakeBus:
    async def emit(self, event, payload, source=None):  # noqa: ARG002
        try:
            _emitted.append((event.value, dict(payload)))
        except Exception:
            _emitted.append((str(event), {}))


_bus_mod.bus = _FakeBus()  # monkey-patch the singleton

# Skip the heavy embedder model load.
import embedder as _emb_mod  # noqa: E402


async def _noop_embed(entry):  # noqa: ARG001
    return None


_emb_mod.embed_knowledge = _noop_embed

import code_catalog as cc  # noqa: E402


# ── Test runner ──────────────────────────────────────────────────────────

_results: list[tuple[str, bool, str]] = []
_registered: list[tuple[str, "callable"]] = []


def case(name):
    def deco(fn):
        async def runner():
            try:
                await fn()
                _results.append((name, True, ""))
            except AssertionError as e:
                _results.append((name, False, f"{e}\n{traceback.format_exc()}"))
            except Exception as e:
                _results.append((name, False, f"unexpected: {e}\n{traceback.format_exc()}"))
        runner.__name__ = f"runner_{len(_registered)}"
        _registered.append((name, runner))
        return runner
    return deco


# ── Per-test fixture ─────────────────────────────────────────────────────


async def _setup_workspace() -> str:
    """Insert a workspace row and return its id. Each test gets its own."""
    db = await db_mod.get_db()
    try:
        ws_id = str(uuid.uuid4())
        await db.execute(
            "INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)",
            (ws_id, f"test-{ws_id[:6]}", f"/tmp/fake-{ws_id}"),
        )
        await db.commit()
    finally:
        await db.close()
    _emitted.clear()
    return ws_id


# ── Tests ────────────────────────────────────────────────────────────────


@case("insert: fresh symbol creates a row + emits UPDATED")
async def _():
    ws = await _setup_workspace()
    r = await cc.upsert_catalog_entry(ws, "a.py::foo(): does X", contributed_by="s1")
    assert r["change_kind"] == "inserted", r
    assert r["symbol_file"] == "a.py"
    assert r["symbol_name"] == "foo"
    assert r["symbol_kind"] == "function"
    assert r["confirmed_count"] == 1
    assert any(e[0] == "code_catalog_updated" for e in _emitted)


@case("confirm: same content + different contributor bumps confirmed_count")
async def _():
    ws = await _setup_workspace()
    await cc.upsert_catalog_entry(ws, "a.py::foo(): does X", contributed_by="s1")
    r = await cc.upsert_catalog_entry(ws, "a.py::foo(): does X", contributed_by="s2")
    assert r["change_kind"] == "confirmed", r
    assert r["confirmed_count"] == 2, r["confirmed_count"]


@case("confirm: same content + same contributor does NOT bump confirmed_count")
async def _():
    ws = await _setup_workspace()
    await cc.upsert_catalog_entry(ws, "a.py::foo(): does X", contributed_by="s1")
    r = await cc.upsert_catalog_entry(ws, "a.py::foo(): does X", contributed_by="s1")
    assert r["change_kind"] == "confirmed"
    assert r["confirmed_count"] == 1, r["confirmed_count"]


@case("confirm: whitespace / flow-order differences treated as same content")
async def _():
    ws = await _setup_workspace()
    await cc.upsert_catalog_entry(
        ws, "a.py::foo(): does X | →d1 →d2", contributed_by="s1"
    )
    r = await cc.upsert_catalog_entry(
        ws, "a.py::foo():   does X | →d2  →d1", contributed_by="s2"
    )
    assert r["change_kind"] == "confirmed", r["change_kind"]


@case("replace: different purpose snapshots prior into history + emits REPLACED")
async def _():
    ws = await _setup_workspace()
    a = await cc.upsert_catalog_entry(ws, "a.py::foo(): does X", contributed_by="s1")
    _emitted.clear()
    b = await cc.upsert_catalog_entry(ws, "a.py::foo(): does Y", contributed_by="s2")
    assert b["change_kind"] == "replaced", b
    assert b["confirmed_count"] == 1, "replace resets confirmation count"
    assert b["id"] == a["id"], "replace updates the same row, doesn't create new"
    assert a["content"] != b["content"]

    # history row landed
    hist = await cc.get_catalog_history(ws)
    assert len(hist) == 1
    assert hist[0]["prior_content"] == a["content"]
    assert hist[0]["prior_contributed_by"] == "s1"
    assert hist[0]["replaced_by_session"] == "s2"

    # both events emitted, in the right order
    evs = [e[0] for e in _emitted]
    assert "code_catalog_updated" in evs
    assert "code_catalog_replaced" in evs
    assert evs.index("code_catalog_updated") < evs.index("code_catalog_replaced")


@case("replace: flow / effects changes count as content disagreement")
async def _():
    ws = await _setup_workspace()
    await cc.upsert_catalog_entry(ws, "a.py::foo(): does X", contributed_by="s1")
    r = await cc.upsert_catalog_entry(
        ws, "a.py::foo(): does X | →new_dep", contributed_by="s2"
    )
    assert r["change_kind"] == "replaced", r["change_kind"]


@case("dedup key: same symbol in different files is independent")
async def _():
    ws = await _setup_workspace()
    a = await cc.upsert_catalog_entry(ws, "a.py::foo(): does X", contributed_by="s1")
    b = await cc.upsert_catalog_entry(ws, "b.py::foo(): does Y", contributed_by="s1")
    assert a["id"] != b["id"]
    assert a["symbol_file"] != b["symbol_file"]


@case("dedup key: cross-workspace isolation")
async def _():
    ws1 = await _setup_workspace()
    ws2 = await _setup_workspace()
    a = await cc.upsert_catalog_entry(ws1, "a.py::foo(): X", contributed_by="s1")
    b = await cc.upsert_catalog_entry(ws2, "a.py::foo(): X", contributed_by="s1")
    assert a["id"] != b["id"]
    assert a["workspace_id"] != b["workspace_id"]


@case("unparseable: persisted as keyless row, no embed, change_kind=noop_invalid")
async def _():
    ws = await _setup_workspace()
    r = await cc.upsert_catalog_entry(ws, "this is garbage", contributed_by="s1")
    assert r["change_kind"] == "noop_invalid", r["change_kind"]
    assert r["symbol_name"] is None
    assert r["symbol_file"] is None
    # event still fires (with change_kind=noop_invalid) so audit can see it
    assert any(
        e[0] == "code_catalog_updated" and e[1].get("change_kind") == "noop_invalid"
        for e in _emitted
    )


@case("Class.method dotted symbol round-trips through upsert")
async def _():
    ws = await _setup_workspace()
    r = await cc.upsert_catalog_entry(
        ws, "x.py::Foo.bar(self, x): does Y", contributed_by="s1"
    )
    assert r["change_kind"] == "inserted"
    assert r["symbol_name"] == "Foo.bar"
    assert r["symbol_kind"] == "method"
    # second emission with same content should confirm, not replace
    r2 = await cc.upsert_catalog_entry(
        ws, "x.py::Foo.bar(self, x): does Y", contributed_by="s2"
    )
    assert r2["change_kind"] == "confirmed", r2["change_kind"]
    assert r2["id"] == r["id"]


@case("get_catalog_for_files: filters to the right workspace + files")
async def _():
    ws = await _setup_workspace()
    other = await _setup_workspace()
    await cc.upsert_catalog_entry(ws, "a.py::foo(): X", contributed_by="s1")
    await cc.upsert_catalog_entry(ws, "b.py::bar(): Y", contributed_by="s1")
    await cc.upsert_catalog_entry(other, "a.py::ghost(): Z", contributed_by="s1")

    rows = await cc.get_catalog_for_files(ws, ["a.py"])
    assert len(rows) == 1
    assert rows[0]["symbol_name"] == "foo"

    rows2 = await cc.get_catalog_for_files(ws, ["a.py", "b.py"])
    names = sorted(r["symbol_name"] for r in rows2)
    assert names == ["bar", "foo"], names


@case("get_catalog_summary: aggregates per file + per kind, plus stale counts")
async def _():
    ws = await _setup_workspace()
    await cc.upsert_catalog_entry(ws, "a.py::foo(): X", contributed_by="s1")
    await cc.upsert_catalog_entry(ws, "a.py::Foo.bar(self): Y", contributed_by="s1")
    await cc.upsert_catalog_entry(ws, "b.py::EVENT_FIRED(): emitted", contributed_by="s1")

    await cc.mark_file_stale(ws, ["a.py"])

    summary = await cc.get_catalog_summary(ws)
    assert summary["total"] == 3, summary
    assert summary["stale_total"] == 2  # foo + Foo.bar
    files = {f["file"]: f for f in summary["by_file"]}
    assert files["a.py"]["n"] == 2
    assert files["a.py"]["stale"] == 2
    assert files["b.py"]["n"] == 1
    assert files["b.py"]["stale"] == 0
    assert summary["by_kind"]["function"] >= 1
    assert summary["by_kind"]["method"] == 1
    assert summary["by_kind"]["event"] == 1


@case("mark_file_stale + clear_stale toggle stale_since")
async def _():
    ws = await _setup_workspace()
    await cc.upsert_catalog_entry(ws, "a.py::foo(): X", contributed_by="s1")
    n = await cc.mark_file_stale(ws, ["a.py"])
    assert n == 1
    rows = await cc.get_catalog_for_file(ws, "a.py")
    assert rows[0]["stale_since"] is not None
    n2 = await cc.clear_stale(ws, ["a.py"])
    assert n2 == 1
    rows = await cc.get_catalog_for_file(ws, "a.py")
    assert rows[0]["stale_since"] is None


@case("confirm clears stale_since (re-emit means current)")
async def _():
    ws = await _setup_workspace()
    await cc.upsert_catalog_entry(ws, "a.py::foo(): X", contributed_by="s1")
    await cc.mark_file_stale(ws, ["a.py"])
    r = await cc.upsert_catalog_entry(ws, "a.py::foo(): X", contributed_by="s2")
    assert r["change_kind"] == "confirmed"
    assert r["stale_since"] is None, "confirm should clear stale_since"


@case("delete_for_file: removes catalog rows + cascades history")
async def _():
    ws = await _setup_workspace()
    await cc.upsert_catalog_entry(ws, "a.py::foo(): X", contributed_by="s1")
    await cc.upsert_catalog_entry(ws, "a.py::foo(): Y", contributed_by="s2")  # replace
    hist_before = await cc.get_catalog_history(ws)
    assert len(hist_before) == 1
    n = await cc.delete_for_file(ws, "a.py")
    assert n == 1
    rows = await cc.get_catalog_for_file(ws, "a.py")
    assert rows == []
    hist_after = await cc.get_catalog_history(ws)
    assert hist_after == [], "history should cascade-delete with the parent row"


@case("bulk_upsert: returns counts and processes all lines")
async def _():
    ws = await _setup_workspace()
    res = await cc.bulk_upsert_catalog_entries(
        ws,
        [
            "a.py::foo(): X",
            "a.py::bar(): Y",
            "garbage line",
            "a.py::foo(): X",  # confirm
            "a.py::foo(): Z",  # replace
        ],
        contributed_by="s1",
    )
    counts = res["counts"]
    assert counts["inserted"] == 2, counts
    assert counts["confirmed"] == 1, counts
    assert counts["replaced"] == 1, counts
    assert counts["noop_invalid"] == 1, counts
    assert len(res["rows"]) == 5


@case("repeated replace: history accumulates")
async def _():
    ws = await _setup_workspace()
    await cc.upsert_catalog_entry(ws, "a.py::foo(): X1", contributed_by="s1")
    await cc.upsert_catalog_entry(ws, "a.py::foo(): X2", contributed_by="s2")
    await cc.upsert_catalog_entry(ws, "a.py::foo(): X3", contributed_by="s3")
    hist = await cc.get_catalog_history(ws)
    assert len(hist) == 2, hist
    # Most recent first (DESC by replaced_at)
    contents = [h["prior_content"] for h in hist]
    assert "X1" in contents[1]  # earliest
    assert "X2" in contents[0]  # most recent


# ── Main ─────────────────────────────────────────────────────────────────


async def _run_all() -> int:
    await db_mod.init_db()
    for _name, runner in _registered:
        await runner()

    passed = sum(1 for _, ok, _ in _results if ok)
    failed = [(n, msg) for n, ok, msg in _results if not ok]
    total = len(_results)

    for name, ok, _ in _results:
        mark = "PASS" if ok else "FAIL"
        print(f"  [{mark}] {name}")
    print()
    print(f"  {passed}/{total} passed, {len(failed)} failed")
    if failed:
        print()
        for n, msg in failed:
            print(f"--- {n} ---")
            print(msg)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(_run_all()))
