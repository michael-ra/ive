/**
 * graphMarks — the DATA half of draw-marks-as-data (vision §1's cardinal rule).
 *
 * A mark is STRUCTURED, ELEMENT-ANCHORED DATA, never pixels. Everything a
 * gesture has to decide — *which graph elements did the human just cover?* — is
 * pure geometry over the layout SystemGraph already owns, so it lives here:
 * no React, no DOM, no JSX. That makes it directly importable by a node probe
 * (the shipped source IS what gets asserted, not a copy of it) and keeps the
 * component free of math.
 *
 * ── Coordinate spaces ────────────────────────────────────────────────────────
 * SystemGraph paints its layout into a div carrying
 *     transform: translate(tx, ty) scale(s);  transform-origin: 0 0
 * inside a `position:relative` container. So:
 *     local  = client − containerRect.topLeft      (container pixels)
 *     graph  = (local − t) / s                     (LAYOUT units)
 * All anchoring math runs in GRAPH space. Doing it in screen space would make a
 * mark mean something different at every zoom level — and a mark that changes
 * meaning when you scroll is a picture, not data.
 *
 * ── Why no `rect` is used to RENDER a persisted box ─────────────────────────
 * A stored rect is a memory of where the pointer was. The elements are the
 * mark. So rendering recomputes the union box from LIVE positions: relayout the
 * graph, add a node, switch level — the outline follows its elements.
 */

// ── Geometry ────────────────────────────────────────────────────────────────

/**
 * Axis-aligned overlap test. Boxes are {x, y, w, h} in the SAME space.
 * Inclusive on the edges (a band drawn exactly along a card's border counts as
 * covering it) — a human aiming at an element should not lose the mark to a
 * sub-pixel miss.
 */
export function rectsIntersect(a, b) {
  if (!a || !b) return false
  return (
    a.x <= b.x + b.w &&
    b.x <= a.x + a.w &&
    a.y <= b.y + b.h &&
    b.y <= a.y + a.h
  )
}

/** Two drag endpoints → a normalized {x, y, w, h} (drag any direction). */
export function normalizeRect(x0, y0, x1, y1) {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  }
}

/**
 * Container-relative client point → graph-space point. Exact inverse of the
 * `translate(x,y) scale(s)` the component applies (and of the wheel handler's
 * zoom-about-cursor math), so a pointer at any zoom/pan resolves to the layout
 * coordinate actually under it.
 *
 * `rect` is a DOMRect-like {left, top}; `transform` is {x, y, scale}.
 */
export function screenToGraph(clientX, clientY, rect, transform) {
  const s = (transform && transform.scale) || 1
  const tx = (transform && transform.x) || 0
  const ty = (transform && transform.y) || 0
  const left = (rect && rect.left) || 0
  const top = (rect && rect.top) || 0
  return { x: (clientX - left - tx) / s, y: (clientY - top - ty) / s }
}

/** One positioned entry ({node,x,y}) → its box in graph space. */
export function nodeBox(p, nodeW, nodeH) {
  return { x: p.x, y: p.y, w: nodeW, h: nodeH }
}

/**
 * THE anchoring step: which elements does this rubber-band rect cover?
 * `positioned` is SystemGraph's layout array [{node:{id,…}, x, y}]. Returns ids
 * in layout order. An empty result is meaningful — the caller must DISCARD the
 * mark rather than save an unanchored one (vision §1).
 */
export function nodeIdsInRect(positioned, rect, nodeW, nodeH) {
  const out = []
  for (const p of positioned || []) {
    if (!p || !p.node) continue
    if (rectsIntersect(rect, nodeBox(p, nodeW, nodeH))) out.push(p.node.id)
  }
  return out
}

/**
 * Hit-test a single graph-space point → the element id under it (or null).
 * Walks last-painted-first so the topmost card wins where boxes overlap.
 */
export function nodeAtPoint(positioned, pt, nodeW, nodeH) {
  if (!pt) return null
  const list = positioned || []
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i]
    if (!p || !p.node) continue
    if (pt.x >= p.x && pt.x <= p.x + nodeW && pt.y >= p.y && pt.y <= p.y + nodeH) {
      return p.node.id
    }
  }
  return null
}

/** Center of a positioned node's card, in graph space. */
export function nodeCenter(p, nodeW, nodeH) {
  return { x: p.x + nodeW / 2, y: p.y + nodeH / 2 }
}

/**
 * Union bounding box of the LIVE positions of `ids`. Ids that no longer exist
 * are skipped; if none survive the mark is stale and this returns null so the
 * renderer draws nothing (stale-safe, per the brief).
 * `pad` insets outward so the outline sits around the cards, not on them.
 */
export function unionBox(posById, ids, nodeW, nodeH, pad = 0) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let found = 0
  for (const id of ids || []) {
    const p = posById && posById[id]
    if (!p) continue
    found += 1
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + nodeW)
    maxY = Math.max(maxY, p.y + nodeH)
  }
  if (!found) return null
  return {
    x: minX - pad,
    y: minY - pad,
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2,
  }
}

/**
 * Point where the segment from a box's center toward `to` leaves that box.
 * Used so an arrow touches the CARD EDGE instead of burying its head under the
 * card. Degenerate (same point) returns the center.
 */
export function boxEdgePoint(center, to, halfW, halfH) {
  const dx = to.x - center.x
  const dy = to.y - center.y
  if (dx === 0 && dy === 0) return { x: center.x, y: center.y }
  const sx = dx === 0 ? Infinity : halfW / Math.abs(dx)
  const sy = dy === 0 ? Infinity : halfH / Math.abs(dy)
  const s = Math.min(sx, sy)
  return { x: center.x + dx * s, y: center.y + dy * s }
}

// ── Mark normalization (the round-trip shape) ───────────────────────────────

/** Kinds this layer DRAWS. `note` keeps SystemGraph's existing pin rendering;
 *  `pen` is deliberately absent — see NO_PEN below. */
export const DRAWN_KINDS = new Set(['box', 'arrow', 'highlight'])

/**
 * NO FREE PEN TOOL — deliberate.
 * The backend's VALID_KINDS still accepts 'pen' (the standalone HTML canvas
 * writes it), but this layer neither creates nor renders one: a pen stroke is a
 * bag of pixels with no element behind it, which is exactly the thing vision §1
 * forbids. Every gesture here resolves to element ids or is thrown away.
 */
export const NO_PEN = true

function firstArray(...candidates) {
  for (const c of candidates) if (Array.isArray(c) && c.length) return c
  return null
}

/**
 * A row's own server id, as a string, or null when it has none.
 *
 * Null is a REAL state, not a missing field: a mark rendered optimistically the
 * instant it was drawn lives in the list with no id until the context refresh
 * replaces it with the stored row. That row is drawable but not erasable — the
 * delete endpoint is keyed on this id and there is nothing to address yet.
 */
export function markId(m) {
  const id = m ? m.id : null
  return (id === null || id === undefined || id === '') ? null : String(id)
}

/**
 * One persisted annotation (the GET-context row shape) → the render shape.
 *
 * Accepts BOTH the wire row — {kind, target_id, coords:{target_ids,rect,source_id}}
 * — and an already-rich object ({kind, target_ids, source_id, rect}), so a host
 * can feed back either the server's rows or its own optimistic marks.
 * Returns null for kinds this layer doesn't draw.
 *
 * `key` still falls back to the index when there is no id, because an
 * optimistic mark has to render before it has one; `id` stays null in that case
 * rather than borrowing the fallback, so nothing can mistake a render key for a
 * row that exists server-side.
 */
export function normalizeMark(m, index = 0) {
  if (!m) return null
  const kind = String(m.kind || '').toLowerCase()
  if (!DRAWN_KINDS.has(kind)) return null
  const coords = (m.coords && typeof m.coords === 'object') ? m.coords : {}
  const id = markId(m)

  if (kind === 'arrow') {
    const sourceId = m.source_id || coords.source_id || null
    // The DB column anchors an arrow to the element at its TIP (same convention
    // as the reference canvas), so target_id is the head.
    const targetId = m.target_id || coords.target_id || null
    if (!sourceId || !targetId) return null
    return {
      id,
      key: id || `arrow:${sourceId}->${targetId}:${index}`,
      kind,
      sourceId,
      targetId,
      ids: [sourceId, targetId],
      color: m.color || null,
      text: m.text || '',
      author: m.author || null,
    }
  }

  const ids = firstArray(m.target_ids, coords.target_ids)
    || (m.target_id ? [m.target_id] : [])
  if (!ids.length) return null
  return {
    id,
    key: id || `${kind}:${ids.join(',')}:${index}`,
    kind,
    ids: ids.map(String),
    color: m.color || null,
    text: m.text || '',
    author: m.author || null,
  }
}

/** Whole annotation list → drawable marks (unknown kinds dropped). */
export function normalizeMarks(marks) {
  const out = []
  const list = Array.isArray(marks) ? marks : []
  for (let i = 0; i < list.length; i++) {
    const n = normalizeMark(list[i], i)
    if (n) out.push(n)
  }
  return out
}

// ── Erase (the remove side of the same layer) ───────────────────────────────

/**
 * Every element id one stored row covers, in stored order.
 *
 * `coords.target_ids` is the real anchor set when a row has one (a box's
 * covered cards, an arrow's two ends); otherwise the single `target_id` column
 * is all there is. Deliberately KIND-AGNOSTIC — a note covers the element it is
 * pinned to exactly like a one-element highlight does, and both the erase pick
 * and the Commander handoff have to reason over the whole layer, not just the
 * kinds this module draws.
 */
export function annotationElementIds(a) {
  if (!a) return []
  const coords = (a.coords && typeof a.coords === 'object') ? a.coords : {}
  const out = []
  const push = (v) => {
    const s = (v === null || v === undefined) ? '' : String(v)
    if (s && !out.includes(s)) out.push(s)
  }
  const ids = firstArray(a.target_ids, coords.target_ids)
  if (ids) for (const v of ids) push(v)
  push(a.source_id || coords.source_id)
  push(a.target_id || coords.target_id)
  return out
}

/**
 * ERASE target: given the whole annotation list and the element the human
 * clicked, WHICH single row does that click remove?
 *
 * Marks stack — a note, a highlight and a band that happens to span the card can
 * all sit on one element — so the click has to pick one rather than clear the
 * pile (clearing would take marks nobody pointed at). It picks the most
 * SPECIFIC: the fewer elements a mark covers, the more it is about the one that
 * was clicked (note/highlight cover 1, an arrow 2, a band across a layer many).
 * Ties go to the LAST row in the list — the newest — so repeated clicks peel the
 * stack newest-first instead of stalling on the same mark.
 *
 * Returns null when nothing on the list touches that element.
 */
export function pickEraseTarget(annotations, elementId) {
  const want = (elementId === null || elementId === undefined) ? '' : String(elementId)
  if (!want) return null
  const list = Array.isArray(annotations) ? annotations : []
  let best = null
  let bestSpan = Infinity
  for (const a of list) {
    const ids = annotationElementIds(a)
    if (!ids.includes(want)) continue
    if (ids.length <= bestSpan) { bestSpan = ids.length; best = a }
  }
  return best
}

/**
 * Build the emitted mark for a committed BOX gesture, or null when the gesture
 * covered nothing. Returning null IS the discard decision — an unanchored mark
 * is meaningless, so it is never handed to the host and never saved.
 */
export function buildBoxMark(positioned, rect, nodeW, nodeH, color) {
  const ids = nodeIdsInRect(positioned, rect, nodeW, nodeH)
  if (!ids.length) return null
  return {
    kind: 'box',
    target_ids: ids,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.w),
      h: Math.round(rect.h),
    },
    ...(color ? { color } : {}),
  }
}

/** Emitted mark for a committed ARROW gesture (null when either end misses). */
export function buildArrowMark(sourceId, targetId, color) {
  if (!sourceId || !targetId || sourceId === targetId) return null
  return {
    kind: 'arrow',
    source_id: sourceId,
    target_id: targetId,
    target_ids: [sourceId, targetId],
    ...(color ? { color } : {}),
  }
}

/** Emitted mark for a HIGHLIGHT click. */
export function buildHighlightMark(id, color) {
  if (!id) return null
  return {
    kind: 'highlight',
    target_ids: [id],
    ...(color ? { color } : {}),
  }
}
