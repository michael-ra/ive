"""Durable, workspace-scoped canvas annotations and visual geometry.

The core stores explicit marks/highlights and exposes their CRUD handlers.
Optional products can derive additional artifacts after persistence; missing
or failed projections never discard the original annotation.
"""
import json
import logging
import uuid

from aiohttp import web

from db import get_db
from extension_host import available as _extension_available

logger = logging.getLogger("canvas_annotations")

# The set of valid annotation kinds (vision §1: box|arrow|note|highlight|pen,
# plus the generic 'mark' the voice/model path emits).
VALID_KINDS = {"note", "box", "arrow", "highlight", "pen", "mark"}

_MAX_TEXT = 8000
_MAX_ELEMENT_IDS = 500

def _row_to_annotation(row) -> dict:
    """Shape a DB row into the structured annotation a model reasons over."""
    coords = None
    raw = row["coords_json"]
    if raw:
        try:
            coords = json.loads(raw)
        except (ValueError, TypeError):
            coords = None
    return {
        # `id` is what makes a mark addressable after the fact — without it the
        # DELETE route below has no handle and a mis-drawn mark is permanent.
        "id": row["id"],
        "kind": row["kind"],
        "target_id": row["target_id"],
        "text": row["text"],
        "color": row["color"],
        "author": row["author"],
        "coords": coords,
        "created_at": row["created_at"],
    }


# ─── Async core (importable; also wrapped by the HTTP handlers) ──────────────

async def get_context(workspace_id: str, canvas_id: str) -> dict:
    """Return the structured context a model reasons over for one canvas.

    {annotations:[{id,kind,target_id,text,color,author,coords,created_at}],
     highlighted_ids:[…]}
    where highlighted_ids = distinct target_ids of kind='highlight' OR of any
    model-authored mark (i.e. what a viewer should light up). `id` is the row's
    handle for `delete_annotation`.
    """
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT id, kind, target_id, coords_json, text, color, author, created_at
                 FROM canvas_annotations
                WHERE workspace_id = ? AND canvas_id = ?
                ORDER BY created_at ASC""",
            (workspace_id, canvas_id),
        )
        rows = await cur.fetchall()
    finally:
        await db.close()

    annotations = [_row_to_annotation(r) for r in rows]

    # highlighted_ids = distinct target_ids that are either explicit highlights
    # or any model-authored mark, preserving first-seen order.
    highlighted: list[str] = []
    seen: set[str] = set()
    for a in annotations:
        tid = a.get("target_id")
        if not tid:
            continue
        if a["kind"] == "highlight" or a["author"] == "model":
            if tid not in seen:
                seen.add(tid)
                highlighted.append(tid)

    return {"annotations": annotations, "highlighted_ids": highlighted}


async def annotate(
    workspace_id: str,
    canvas_id: str,
    kind: str,
    target_id: str | None = None,
    text: str | None = None,
    color: str | None = None,
    coords=None,
    author: str = "model",
) -> dict:
    """Insert one annotation. Returns {ok, id, kind} or {ok:False, error}.

    Validates `kind` in {note,box,arrow,highlight,pen,mark}. `coords` is any
    JSON-serializable shape (stored as coords_json).
    """
    kind = (kind or "").strip()
    if kind not in VALID_KINDS:
        return {"ok": False, "error": f"invalid kind {kind!r}; must be one of {sorted(VALID_KINDS)}"}

    coords_json = None
    if coords is not None:
        try:
            coords_json = json.dumps(coords)
        except (TypeError, ValueError):
            return {"ok": False, "error": "coords must be JSON-serializable"}

    if text is not None:
        text = str(text)[:_MAX_TEXT]

    ann_id = str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            """INSERT INTO canvas_annotations
                   (id, workspace_id, canvas_id, kind, target_id, coords_json, text, color, author)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (ann_id, workspace_id, canvas_id, kind, target_id, coords_json, text, color, author),
        )
        await db.commit()
    finally:
        await db.close()

    result = {"ok": True, "id": ann_id, "kind": kind}

    # Extensions may derive artifacts only after the visual record is durable.
    try:
        result.update(await _after_annotation_saved(workspace_id, canvas_id, target_id, text))
    except Exception as e:
        logger.warning("canvas annotation %s saved, but an optional projection failed: %s",
                       ann_id, e, exc_info=True)
    return result


async def highlight(workspace_id: str, canvas_id: str, element_ids: list) -> dict:
    """Record one highlight annotation per element_id (kind='highlight',
    author='model') so a viewer can render them. Returns {ok, count, ids}.
    """
    if not isinstance(element_ids, list):
        return {"ok": False, "error": "element_ids must be a list"}
    # De-dupe while preserving order; drop empties; cap.
    cleaned: list[str] = []
    seen: set[str] = set()
    for eid in element_ids:
        s = str(eid).strip()
        if not s or s in seen:
            continue
        seen.add(s)
        cleaned.append(s)
        if len(cleaned) >= _MAX_ELEMENT_IDS:
            break
    if not cleaned:
        return {"ok": False, "error": "element_ids required"}

    new_ids: list[str] = []
    db = await get_db()
    try:
        for eid in cleaned:
            ann_id = str(uuid.uuid4())
            await db.execute(
                """INSERT INTO canvas_annotations
                       (id, workspace_id, canvas_id, kind, target_id, author)
                   VALUES (?, ?, ?, 'highlight', ?, 'model')""",
                (ann_id, workspace_id, canvas_id, eid),
            )
            new_ids.append(ann_id)
        await db.commit()
    finally:
        await db.close()
    return {"ok": True, "count": len(new_ids), "ids": new_ids}


async def delete_annotation(
    workspace_id: str, canvas_id: str, annotation_id: str
) -> dict:
    """Remove one annotation by id. Returns {ok, deleted} — deleted is 0 or 1.

    The DELETE carries workspace_id + canvas_id as well as the row id, so an id
    from one board can never erase a mark on another; a row outside this
    (workspace, canvas) scope is indistinguishable from a missing one (deleted 0).

    This removes only the addressed visual record. Extension-created artifacts
    follow their owner's independent lifecycle.
    """
    db = await get_db()
    try:
        cur = await db.execute(
            """DELETE FROM canvas_annotations
                WHERE id = ? AND workspace_id = ? AND canvas_id = ?""",
            (annotation_id, workspace_id, canvas_id),
        )
        await db.commit()
        deleted = cur.rowcount or 0
    finally:
        await db.close()
    if deleted <= 0:
        return {"ok": False, "deleted": 0}
    return {"ok": True, "deleted": deleted}


# ─── aiohttp handlers (registered in server.py) ─────────────────────────────

def register_canvas_routes(app: web.Application) -> None:
    """Register IVE's visual records independently of optional graph products.

    The host's authentication and workspace-access middleware applies to these
    routes just as it does to the other workspace resources.
    """
    base = "/api/workspaces/{id}/canvas/{canvas_id}"
    app.router.add_get(base + "/context", get_canvas_context_handler)
    app.router.add_post(base + "/annotate", annotate_canvas_handler)
    app.router.add_post(base + "/highlight", highlight_canvas_handler)
    app.router.add_delete(base + "/annotations/{annotation_id}", delete_annotation_handler)


async def get_canvas_context_handler(request: web.Request) -> web.Response:
    ws_id = request.match_info["id"]
    canvas_id = request.match_info["canvas_id"]
    try:
        ctx = await get_context(ws_id, canvas_id)
    except Exception as e:
        logger.exception("canvas get_context failed: %s", e)
        return web.json_response({"ok": False, "error": "get_context failed"}, status=500)
    return web.json_response({"ok": True, **ctx})


async def annotate_canvas_handler(request: web.Request) -> web.Response:
    ws_id = request.match_info["id"]
    canvas_id = request.match_info["canvas_id"]
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON"}, status=400)

    result = await annotate(
        workspace_id=ws_id,
        canvas_id=canvas_id,
        kind=body.get("kind"),
        target_id=body.get("target_id"),
        text=body.get("text"),
        color=body.get("color"),
        coords=body.get("coords"),
        author=body.get("author") or "model",
    )
    status = 201 if result.get("ok") else 400
    return web.json_response(result, status=status)


async def highlight_canvas_handler(request: web.Request) -> web.Response:
    ws_id = request.match_info["id"]
    canvas_id = request.match_info["canvas_id"]
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON"}, status=400)

    result = await highlight(ws_id, canvas_id, body.get("element_ids") or [])
    status = 201 if result.get("ok") else 400
    return web.json_response(result, status=status)


async def delete_annotation_handler(request: web.Request) -> web.Response:
    ws_id = request.match_info["id"]
    canvas_id = request.match_info["canvas_id"]
    annotation_id = request.match_info["annotation_id"]
    try:
        result = await delete_annotation(ws_id, canvas_id, annotation_id)
    except Exception as e:
        logger.exception("canvas delete_annotation failed: %s", e)
        return web.json_response({"ok": False, "deleted": 0}, status=500)
    status = 200 if result.get("ok") else 404
    return web.json_response(result, status=status)


# Optional projection port; basic geometry never imports a graph implementation.
async def _no_projection(*args, **kwargs):
    return None


async def _after_annotation_saved(*args, **kwargs) -> dict:
    return {}


_remember_insight = _remember_annotation = _no_projection

if _extension_available("myelin"):
    from extension_host import load_legacy_namespace as _load_projection
    _load_projection(globals(), "myelin", "backend/canvas_memory.py")
