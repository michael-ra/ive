import { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import { Network, MessageSquare, AlertTriangle, Check, Pin, Minus, Plus } from 'lucide-react'
import { isExtensionAvailable } from '../../lib/extensionRegistry'
import { Button, IconButton, Chip, Dot, Spinner, StatusBar, EmptyState } from '../ui'
import CanvasControls from './CanvasControls'
import GraphDrawLayer from './GraphDrawLayer'
import {
  screenToGraph,
  normalizeRect,
  nodeAtPoint,
  buildBoxMark,
  buildArrowMark,
  buildHighlightMark,
  normalizeMarks,
} from './graphMarks'

// ── Layout constants ─────────────────────────────────────────────
const NODE_W = 210
const NODE_H = 78 // taller than the L0 card to fit a typed header row (Task #11)
const COLUMN_GAP = 56
const RANK_GAP = 36
const GRID_ROW_GAP = 32
const SECTION_GAP = 52
const PAD = 60

// Zone → accent color (local / fleet / cloud / external). Theme-aware CSS
// variables (defined by the design-system foundation in index.css) so the
// functional encoding reads correctly in BOTH themes as a quiet dot.
const ZONE_COLOR = {
  local:    'var(--x-good)',
  fleet:    'var(--x-accent)',
  cloud:    'var(--x-link)',
  external: 'color-mix(in srgb, var(--x-accent) 48%, var(--x-muted))',
}
const ZONE_LABEL = {
  local: 'Local', fleet: 'Fleet', cloud: 'Cloud', external: 'External',
}

function zoneColor(zone) {
  return ZONE_COLOR[zone] || 'var(--x-muted)'
}

// A deliberately small graph-local categorical palette. Every value is derived
// from a canonical Xirp token; no graph-only hex colors leak into the theme.
// When a graph has more type names than this palette can communicate, the least
// frequent names share the muted "Other" encoding instead of pretending that
// fourteen almost-identical dots are useful.
const NODE_TYPE_PALETTE = [
  'var(--x-accent)',
  'var(--x-good)',
  'var(--x-link)',
  'color-mix(in srgb, var(--x-accent-ink) 62%, var(--x-muted))',
  'color-mix(in srgb, var(--x-link) 58%, var(--x-muted))',
]
const OTHER_TYPE_COLOR = 'var(--x-muted)'
const MAX_NAMED_LEGEND_TYPES = NODE_TYPE_PALETTE.length

function normalizeType(type) {
  return String(type || 'node').trim().toLowerCase() || 'node'
}

function displayType(type) {
  return String(type || 'node')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}
// Short, upper display label for a node type's header chip (falls back to 'node').
function nodeTypeLabel(type) {
  return String(type || 'node').toUpperCase()
}

// Theme-aware edge chrome (CSS variables resolve per theme).
const EDGE_COLOR = 'var(--x-line-strong)'

// A drag shorter than this (in GRAPH units, so it means the same thing at any
// zoom) is a click that wobbled, not a box gesture. Discarded silently — the
// "nothing covered" hint is reserved for a real drag that missed.
const MIN_DRAG = 6
const MIN_ZOOM = 0.2
const MAX_ZOOM = 2.5
const MIN_READABLE_FIT_ZOOM = 0.75
const EDGE_LABEL_MIN_ZOOM = 0.6

/**
 * Cycle-safe longest-path dependency ranks.
 *
 * Strongly connected components are collapsed first. Their condensed graph is
 * a DAG, so a back-edge cannot stretch a small cycle across the whole canvas.
 * Nodes with no valid incident edge are kept aside for the grid fallback.
 */
function computeDependencyRanks(nodes, edges) {
  const ids = new Set(nodes.map((node) => node.id))
  const validEdges = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
  const incident = new Set()
  const adjacency = new Map(nodes.map((node) => [node.id, []]))
  for (const edge of validEdges) {
    adjacency.get(edge.source).push(edge.target)
    incident.add(edge.source)
    incident.add(edge.target)
  }

  let nextIndex = 0
  const indexById = new Map()
  const lowById = new Map()
  const stack = []
  const onStack = new Set()
  const components = []

  function visit(id) {
    indexById.set(id, nextIndex)
    lowById.set(id, nextIndex)
    nextIndex += 1
    stack.push(id)
    onStack.add(id)

    for (const target of adjacency.get(id) || []) {
      if (!indexById.has(target)) {
        visit(target)
        lowById.set(id, Math.min(lowById.get(id), lowById.get(target)))
      } else if (onStack.has(target)) {
        lowById.set(id, Math.min(lowById.get(id), indexById.get(target)))
      }
    }

    if (lowById.get(id) !== indexById.get(id)) return
    const component = []
    while (stack.length) {
      const member = stack.pop()
      onStack.delete(member)
      component.push(member)
      if (member === id) break
    }
    components.push(component)
  }

  for (const node of nodes) {
    if (incident.has(node.id) && !indexById.has(node.id)) visit(node.id)
  }

  const componentById = new Map()
  components.forEach((component, index) => {
    for (const id of component) componentById.set(id, index)
  })

  const outgoing = components.map(() => new Set())
  const incomingCount = components.map(() => 0)
  let hasCycle = components.some((component) => component.length > 1)
  for (const edge of validEdges) {
    const from = componentById.get(edge.source)
    const to = componentById.get(edge.target)
    if (from === to) {
      if (edge.source === edge.target) hasCycle = true
      continue
    }
    if (!outgoing[from].has(to)) {
      outgoing[from].add(to)
      incomingCount[to] += 1
    }
  }

  const componentRank = components.map(() => 0)
  const queue = incomingCount
    .map((count, index) => ({ count, index }))
    .filter(({ count }) => count === 0)
    .map(({ index }) => index)
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const component = queue[cursor]
    for (const target of outgoing[component]) {
      componentRank[target] = Math.max(componentRank[target], componentRank[component] + 1)
      incomingCount[target] -= 1
      if (incomingCount[target] === 0) queue.push(target)
    }
  }

  const rankById = {}
  let maxRank = 0
  for (const [id, component] of componentById) {
    rankById[id] = componentRank[component]
    maxRank = Math.max(maxRank, componentRank[component])
  }

  return {
    rankById,
    maxRank,
    hasCycle,
    validEdges,
    connected: nodes.filter((node) => incident.has(node.id)),
    isolated: nodes.filter((node) => !incident.has(node.id)),
  }
}

function balancedGridColumns(count, targetAspect) {
  if (count <= 1) return Math.max(1, count)
  let best = { columns: 1, score: Infinity }
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns)
    const width = columns * NODE_W + (columns - 1) * COLUMN_GAP
    const height = rows * NODE_H + (rows - 1) * GRID_ROW_GAP
    const aspectPenalty = Math.abs(Math.log((width / height) / targetAspect))
    const emptyPenalty = ((rows * columns) - count) / count * 0.12
    const score = aspectPenalty + emptyPenalty
    if (score < best.score) best = { columns, score }
  }
  return best.columns
}

function buildTypeLegend(nodes) {
  const counts = new Map()
  nodes.forEach((node, firstSeen) => {
    const key = normalizeType(node.type)
    const current = counts.get(key)
    if (current) current.count += 1
    else counts.set(key, { key, label: displayType(node.type), count: 1, firstSeen })
  })
  const ordered = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.firstSeen - b.firstSeen,
  )
  const named = ordered.slice(0, MAX_NAMED_LEGEND_TYPES)
  const legend = named.map((entry, index) => ({
    ...entry,
    color: NODE_TYPE_PALETTE[index],
    typeKeys: [entry.key],
  }))
  const grouped = ordered.slice(MAX_NAMED_LEGEND_TYPES)
  if (grouped.length > 0) {
    legend.push({
      key: 'other',
      label: 'Other',
      count: grouped.reduce((total, entry) => total + entry.count, 0),
      color: OTHER_TYPE_COLOR,
      typeKeys: grouped.map((entry) => entry.key),
      groupedLabels: grouped.map((entry) => entry.label),
    })
  }
  return legend
}

/**
 * Product-neutral supplied-graph renderer. Layout, selection, pan/zoom and draw
 * gestures are local. Optional hosts provide loading/error/toolbar/empty state
 * and may enable an independently installed interactive-canvas contribution.
 * Annotation writes stay host callbacks; this renderer never fetches a graph.
 */
export default function GraphRenderer({
  workspaceId,
  graph: graphProp,
  legendKind = 'type',
  toolbarStart = null,
  toolbarActions = null,
  emptyState = null,
  loading = false,
  error = null,
  onNodeClick,
  selectedNodeId,
  canvasId = 'archgraph',
  toolbarExtra,
  systemContext,
  overlayBadges = null,
  selectable = false,
  selectedIds = null,
  onToggleSelect = null,
  pins = null,
  highlightIds = null,
  drawMode = null,
  onDrawMark = null,
  marks = null,
  drawColor = null,
  eraseMode = false,
  onEraseMark = null,
}) {
  const explicit = legendKind === 'type'
  const canvasAvailable = isExtensionAvailable('forge')
  const graph = useMemo(() => ({
    nodes: Array.isArray(graphProp?.nodes) ? graphProp.nodes : [],
    edges: Array.isArray(graphProp?.edges) ? graphProp.edges : [],
  }), [graphProp])

  const containerRef = useRef(null)
  const panRef = useRef(null)
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 })
  const [hoverNodeId, setHoverNodeId] = useState(null)
  const [viewportSize, setViewportSize] = useState({ width: 1150, height: 760 })

  // ── Interactive canvas state ────────────────────────────────────
  const [canvasOpen, setCanvasOpen] = useState(false)
  const [highlightedIds, setHighlightedIds] = useState(() => new Set())

  // The no-edge grid follows the pane rather than a fixed desktop ratio. A
  // ResizeObserver also reflows it when the inspector opens beside the graph.
  useEffect(() => {
    const element = containerRef.current
    if (!element) return undefined
    const measure = () => {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      setViewportSize((current) => (
        Math.abs(current.width - rect.width) < 1 && Math.abs(current.height - rect.height) < 1
          ? current
          : { width: rect.width, height: rect.height }
      ))
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [graph.nodes.length])

  // ── Layout ──────────────────────────────────────────────────────
  const layout = useMemo(() => {
    const { nodes, edges } = graph
    if (nodes.length === 0) {
      return { positioned: [], posById: {}, drawEdges: [], width: 400, height: 200, hasCycle: false }
    }

    const {
      rankById,
      hasCycle,
      validEdges,
      connected,
      isolated,
    } = computeDependencyRanks(nodes, edges)
    const sortNodes = (a, b) => (a.name || a.id || '').localeCompare(b.name || b.id || '')
    const rankGroups = new Map()
    for (const node of connected) {
      const rank = rankById[node.id] ?? 0
      if (!rankGroups.has(rank)) rankGroups.set(rank, [])
      rankGroups.get(rank).push(node)
    }
    const rankRows = [...rankGroups]
      .sort(([a], [b]) => a - b)
      .map(([rank, group]) => {
        group.sort(sortNodes)
        return {
          rank,
          nodes: group,
          width: group.length * NODE_W + Math.max(0, group.length - 1) * COLUMN_GAP,
        }
      })

    const isolatedNodes = [...isolated].sort(sortNodes)
    const targetAspect = Math.max(0.75, viewportSize.width / Math.max(1, viewportSize.height))
    const gridColumns = balancedGridColumns(isolatedNodes.length, targetAspect)
    const gridRows = gridColumns > 0 ? Math.ceil(isolatedNodes.length / gridColumns) : 0
    const gridWidth = gridColumns > 0
      ? gridColumns * NODE_W + (gridColumns - 1) * COLUMN_GAP
      : 0
    const gridHeight = gridRows > 0
      ? gridRows * NODE_H + (gridRows - 1) * GRID_ROW_GAP
      : 0
    const rankedWidth = rankRows.reduce((max, row) => Math.max(max, row.width), 0)
    const rankedHeight = rankRows.length > 0
      ? rankRows.length * NODE_H + (rankRows.length - 1) * RANK_GAP
      : 0
    const contentWidth = Math.max(NODE_W, rankedWidth, gridWidth)
    const isolatedTop = PAD + rankedHeight + (rankedHeight > 0 && gridHeight > 0 ? SECTION_GAP : 0)
    const positioned = []
    const posById = {}
    rankRows.forEach((row, rowIndex) => {
      const startX = PAD + (contentWidth - row.width) / 2
      const y = PAD + rowIndex * (NODE_H + RANK_GAP)
      row.nodes.forEach((node, column) => {
        const point = {
          node,
          x: startX + column * (NODE_W + COLUMN_GAP),
          y,
          layer: row.rank,
        }
        positioned.push(point)
        posById[node.id] = point
      })
    })
    const gridStartX = PAD + (contentWidth - gridWidth) / 2
    isolatedNodes.forEach((node, index) => {
      const point = {
        node,
        x: gridStartX + (index % gridColumns) * (NODE_W + COLUMN_GAP),
        y: isolatedTop + Math.floor(index / gridColumns) * (NODE_H + GRID_ROW_GAP),
        layer: null,
      }
      positioned.push(point)
      posById[node.id] = point
    })

    const drawEdges = []
    validEdges.forEach((edge, index) => {
      const from = posById[edge.source]
      const to = posById[edge.target]
      if (from && to) {
        const id = `${edge.source}:${edge.target}:${index}`
        if (edge.source === edge.target) {
          drawEdges.push({
            id,
            kind: 'self',
            x1: from.x + NODE_W,
            y1: from.y + NODE_H * 0.35,
            x2: from.x + NODE_W,
            y2: from.y + NODE_H * 0.65,
            controlX: from.x + NODE_W + 34,
            labelX: from.x + NODE_W + 30,
            labelY: from.y + NODE_H / 2,
            label: edge.label,
          })
        } else if (from.layer === to.layer) {
          const forward = from.x < to.x
          const x1 = from.x + (forward ? NODE_W : 0)
          const x2 = to.x + (forward ? 0 : NODE_W)
          const arcY = from.y - RANK_GAP / 2
          drawEdges.push({
            id,
            kind: 'same-rank',
            x1,
            y1: from.y + NODE_H / 2,
            x2,
            y2: to.y + NODE_H / 2,
            controlY: arcY,
            labelX: (x1 + x2) / 2,
            labelY: arcY,
            label: edge.label,
          })
        } else {
          const x1 = from.x + NODE_W / 2
          const y1 = from.y + NODE_H
          const x2 = to.x + NODE_W / 2
          const y2 = to.y
          const span = Math.max(RANK_GAP, y2 - y1)
          const labelProgress = Math.min(0.5, (RANK_GAP / 2) / span)
          drawEdges.push({
            id,
            kind: 'rank',
            x1,
            y1,
            x2,
            y2,
            labelX: x1 + (x2 - x1) * labelProgress,
            labelY: y1 + RANK_GAP / 2,
            label: edge.label,
          })
        }
      }
    })

    // Several relations often cross the same inter-rank band. Preserve their
    // preferred path-adjacent position, then pack the pills across that band so
    // repeated labels do not stack into a dark smudge. Widths are estimated at
    // the 75% counter-scaled floor, which is the widest a visible label gets in
    // graph coordinates.
    const labelBands = new Map()
    for (const edge of drawEdges) {
      if (!edge.label) continue
      const band = Math.round(edge.labelY)
      if (!labelBands.has(band)) labelBands.set(band, [])
      labelBands.get(band).push(edge)
    }
    const labelGap = 8
    const labelLeft = PAD
    const labelRight = PAD + contentWidth
    for (const bandEdges of labelBands.values()) {
      bandEdges.sort((a, b) => a.labelX - b.labelX)
      const widths = bandEdges.map((edge) => (
        Math.min(180, String(edge.label).length * 7 + 14) / MIN_READABLE_FIT_ZOOM
      ))
      for (let index = 0; index < bandEdges.length; index += 1) {
        const half = widths[index] / 2
        const leftBound = index === 0
          ? labelLeft + half
          : bandEdges[index - 1].labelX + widths[index - 1] / 2 + labelGap + half
        bandEdges[index].labelX = Math.max(leftBound, Math.min(labelRight - half, bandEdges[index].labelX))
      }
      for (let index = bandEdges.length - 1; index >= 0; index -= 1) {
        const half = widths[index] / 2
        const rightBound = index === bandEdges.length - 1
          ? labelRight - half
          : bandEdges[index + 1].labelX - widths[index + 1] / 2 - labelGap - half
        bandEdges[index].labelX = Math.min(rightBound, bandEdges[index].labelX)
      }
    }

    return {
      positioned,
      // Same entries keyed by id — the mark layer resolves element ids → live
      // positions on every render, which is what makes a mark follow the layout.
      posById,
      drawEdges,
      width: Math.max(400, PAD * 2 + contentWidth),
      height: Math.max(
        200,
        PAD + rankedHeight + (rankedHeight > 0 && gridHeight > 0 ? SECTION_GAP : 0) + gridHeight + PAD,
      ),
      hasCycle,
    }
  }, [graph, viewportSize])

  const { positioned, posById, drawEdges, width, height, hasCycle } = layout

  const edgePath = useCallback((edge) => {
    if (edge.kind === 'self') {
      return `M ${edge.x1} ${edge.y1} C ${edge.controlX} ${edge.y1}, ${edge.controlX} ${edge.y2}, ${edge.x2} ${edge.y2}`
    }
    if (edge.kind === 'same-rank') {
      return `M ${edge.x1} ${edge.y1} C ${edge.x1} ${edge.controlY}, ${edge.x2} ${edge.controlY}, ${edge.x2} ${edge.y2}`
    }
    const dy = Math.abs(edge.y2 - edge.y1)
    const cp = Math.max(18, dy * 0.42)
    return `M ${edge.x1} ${edge.y1} C ${edge.x1} ${edge.y1 + cp}, ${edge.x2} ${edge.y2 - cp}, ${edge.x2} ${edge.y2}`
  }, [])

  // ── Draw-marks-as-data (inert unless `drawMode` is set) ─────────
  // A gesture never becomes pixels. It resolves, in GRAPH space, to the element
  // ids it covered — and that id set IS the mark. Zero coverage → discarded.
  const [draft, setDraft] = useState(null)   // {kind,x0,y0,x1,y1,sourceId?} graph coords
  const draftRef = useRef(null)              // handlers read the live value, not a closure
  const [drawHint, setDrawHint] = useState('')
  const hintTimerRef = useRef(null)
  // Only box/arrow take over the drag. Highlight is a plain click, so pan keeps
  // working while it's active (you still need to reach the element).
  const drawArmed = drawMode === 'box' || drawMode === 'arrow'

  const updateDraft = useCallback((next) => {
    draftRef.current = next
    setDraft(next)
  }, [])

  const showHint = useCallback((msg) => {
    setDrawHint(msg)
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
    hintTimerRef.current = setTimeout(() => setDrawHint(''), 1800)
  }, [])
  useEffect(() => () => { if (hintTimerRef.current) clearTimeout(hintTimerRef.current) }, [])

  // Pointer → layout coordinate: the exact inverse of this container's own
  // transform, so a gesture means the same thing at every zoom and pan.
  const toGraphPoint = useCallback((e) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return null
    return screenToGraph(e.clientX, e.clientY, rect, transform)
  }, [transform])

  const emitMark = useCallback((mark) => {
    if (mark && onDrawMark) onDrawMark(mark)
  }, [onDrawMark])

  const commitDraft = useCallback((e) => {
    const d = draftRef.current
    updateDraft(null)
    if (!d) return
    const pt = toGraphPoint(e)
    if (d.kind === 'box') {
      const rect = normalizeRect(d.x0, d.y0, pt ? pt.x : d.x1, pt ? pt.y : d.y1)
      // Too small to be a drag — that was a click that wobbled. Silent: the
      // hint is for a real gesture that missed, not for a stray click.
      if (rect.w < MIN_DRAG && rect.h < MIN_DRAG) return
      const mark = buildBoxMark(positioned, rect, NODE_W, NODE_H, drawColor)
      if (!mark) { showHint('Nothing covered — mark discarded'); return }
      emitMark(mark)
      return
    }
    if (d.kind === 'arrow') {
      const targetId = pt ? nodeAtPoint(positioned, pt, NODE_W, NODE_H) : null
      const mark = buildArrowMark(d.sourceId, targetId, drawColor)
      if (!mark) {
        showHint(targetId ? 'An arrow needs two different elements' : 'Release on an element')
        return
      }
      emitMark(mark)
    }
  }, [updateDraft, toGraphPoint, positioned, drawColor, emitMark, showHint])

  // While a gesture is live the listeners sit on WINDOW, so dragging past the
  // container edge doesn't silently drop the mark. Attached only for the
  // duration of the gesture — nothing is registered when drawMode is null.
  const drawing = draft != null
  useEffect(() => {
    if (!drawing) return
    const onMove = (ev) => {
      const d = draftRef.current
      if (!d) return
      const pt = toGraphPoint(ev)
      if (!pt) return
      updateDraft({ ...d, x1: pt.x, y1: pt.y })
    }
    const onUp = (ev) => commitDraft(ev)
    // ESC abandons the gesture: nothing emitted, nothing saved.
    const onKey = (ev) => { if (ev.key === 'Escape') updateDraft(null) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [drawing, toGraphPoint, updateDraft, commitDraft])

  // Leaving draw mode mid-gesture drops it rather than committing a mark the
  // human can no longer see themselves making.
  useEffect(() => { if (!drawMode) updateDraft(null) }, [drawMode, updateDraft])

  // ── Pan ─────────────────────────────────────────────────────────
  const handleMouseDown = useCallback((e) => {
    // Don't start a pan when interacting with the canvas overlay panel.
    if (e.target.closest('[data-canvas-panel]')) return
    // A draw gesture arms ONLY when drawMode is set, and then it takes the drag
    // — including drags that start on a card — instead of the pan.
    if (drawArmed) {
      const pt = toGraphPoint(e)
      if (!pt) return
      // preventDefault is required here: without it the browser's native
      // text/image drag hijacks the gesture halfway through.
      e.preventDefault()
      if (drawMode === 'box') {
        updateDraft({ kind: 'box', x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y })
      } else {
        const sourceId = nodeAtPoint(positioned, pt, NODE_W, NODE_H)
        if (!sourceId) { showHint('Start an arrow on an element'); return }
        updateDraft({ kind: 'arrow', sourceId, x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y })
      }
      return
    }
    if (e.target.closest('[data-node]')) return
    e.preventDefault()
    panRef.current = { startX: e.clientX, startY: e.clientY, startTx: transform.x, startTy: transform.y }
  }, [transform, drawArmed, drawMode, toGraphPoint, positioned, updateDraft, showHint])

  const handleMouseMove = useCallback((e) => {
    // Capture the pan anchor ONCE. The setTransform updater below runs deferred
    // (React commit phase); panRef.current can be nulled by a mouseup in between,
    // so dereferencing it inside the updater throws "null is not an object". Close
    // over the local `pan` instead.
    const pan = panRef.current
    if (!pan) return
    const dx = e.clientX - pan.startX
    const dy = e.clientY - pan.startY
    setTransform((t) => ({ ...t, x: pan.startTx + dx, y: pan.startTy + dy }))
  }, [])

  const handleMouseUp = useCallback(() => { panRef.current = null }, [])

  // ── Zoom ────────────────────────────────────────────────────────
  const setZoomAt = useCallback((nextScale, mx, my) => {
    setTransform((t) => {
      const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextScale))
      if (scale === t.scale) return t
      return {
        scale,
        x: mx - (mx - t.x) * (scale / t.scale),
        y: my - (my - t.y) * (scale / t.scale),
      }
    })
  }, [])

  const zoomBy = useCallback((factor) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    setTransform((t) => {
      const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, t.scale * factor))
      if (scale === t.scale) return t
      const mx = rect.width / 2
      const my = rect.height / 2
      return {
        scale,
        x: mx - (mx - t.x) * (scale / t.scale),
        y: my - (my - t.y) * (scale / t.scale),
      }
    })
  }, [])

  const handleWheel = useCallback((e) => {
    // Let the canvas overlay panel scroll its own content (chat, etc).
    if (e.target.closest && e.target.closest('[data-canvas-panel]')) return
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.92 : 1.08
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    setZoomAt(transform.scale * delta, e.clientX - rect.left, e.clientY - rect.top)
  }, [setZoomAt, transform.scale])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // ── Fit to view ─────────────────────────────────────────────────
  const fitView = useCallback(() => {
    const el = containerRef.current
    if (!el || positioned.length === 0) return
    const rect = el.getBoundingClientRect()
    const scaleX = (rect.width - 60) / width
    const scaleY = (rect.height - 60) / height
    // Fit both dimensions now that ranks use the pane vertically, but retain the
    // 75% readability floor. Very deep graphs remain pannable instead of being
    // reduced to illegible miniatures.
    const scale = Math.max(MIN_READABLE_FIT_ZOOM, Math.min(1, scaleX, scaleY))
    const scaledWidth = width * scale
    const scaledHeight = height * scale
    el.scrollLeft = 0
    el.scrollTop = 0
    setTransform({
      x: scaledWidth <= rect.width - 60 ? (rect.width - scaledWidth) / 2 : 30,
      y: scaledHeight <= rect.height - 60 ? (rect.height - scaledHeight) / 2 : 30,
      scale,
    })
  }, [positioned.length, width, height])

  useEffect(() => { fitView() }, [fitView])

  // ── Focus: center + zoom the transform onto a set of node ids ─────
  // Reuses the same screen-space math as fitView, but bounded to the
  // bounding box of the requested nodes so the tour can frame a region.
  const focusNodes = useCallback((ids) => {
    const el = containerRef.current
    if (!el || !ids || !ids.length) return
    const wanted = new Set(ids)
    const pts = positioned.filter((p) => wanted.has(p.node.id))
    if (!pts.length) return

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of pts) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x + NODE_W)
      maxY = Math.max(maxY, p.y + NODE_H)
    }
    // Padding around the region so highlighted nodes aren't flush to edges.
    const margin = 80
    minX -= margin; minY -= margin; maxX += margin; maxY += margin
    const regionW = maxX - minX
    const regionH = maxY - minY

    const rect = el.getBoundingClientRect()
    const scaleX = rect.width / regionW
    const scaleY = rect.height / regionH
    // Cap zoom so a single node doesn't fill the whole viewport.
    const scale = Math.max(0.4, Math.min(1.6, Math.min(scaleX, scaleY)))
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const nx = rect.width / 2 - cx * scale
    const ny = rect.height / 2 - cy * scale
    // Bail out when the framing is already correct: the highlight effect below
    // re-runs whenever this callback's identity changes, and an unconditional
    // setTransform would re-render → new identity → re-run, forever.
    setTransform((t) => (
      t.scale === scale && t.x === nx && t.y === ny ? t : { scale, x: nx, y: ny }
    ))
  }, [positioned])

  // ── Overlay lookups (all empty unless a host opts in) ───────────
  // Accept a Set or an array for both id collections so callers can pass
  // whichever they already hold without converting on every render.
  const selectedSet = useMemo(() => (
    selectedIds instanceof Set ? selectedIds : new Set(selectedIds || [])
  ), [selectedIds])

  const externalHighlight = useMemo(() => (
    highlightIds == null
      ? null
      : (highlightIds instanceof Set ? highlightIds : new Set(highlightIds))
  ), [highlightIds])

  // Group pins by element once — a node may carry several authored marks and the
  // marker shows a count rather than stacking icons.
  const pinsByElement = useMemo(() => {
    const map = {}
    for (const p of (Array.isArray(pins) ? pins : [])) {
      const id = p && p.element_id
      if (!id) continue
      ;(map[id] = map[id] || []).push(p)
    }
    return map
  }, [pins])

  // A host-driven highlight also frames its nodes: the narration says "look
  // here", so the viewport has to go there without the host touching transform.
  useEffect(() => {
    if (!externalHighlight || externalHighlight.size === 0) return
    focusNodes([...externalHighlight])
  }, [externalHighlight, focusNodes])

  // Opening a 340px inspector shrinks the graph viewport from the right. Keep
  // the selected card inside the remaining pane without changing its zoom; the
  // user should see the thing the inspector describes beside the inspector.
  const keepSelectedVisible = useCallback(() => {
    const el = containerRef.current
    const point = selectedNodeId == null ? null : posById[String(selectedNodeId)]
    if (!el || !point) return
    const rect = el.getBoundingClientRect()
    const margin = 24
    setTransform((t) => {
      let x = t.x
      let y = t.y
      const left = point.x * t.scale + x - el.scrollLeft
      const right = (point.x + NODE_W) * t.scale + x - el.scrollLeft
      const top = point.y * t.scale + y - el.scrollTop
      const bottom = (point.y + NODE_H) * t.scale + y - el.scrollTop
      if (right > rect.width - margin) x -= right - (rect.width - margin)
      if (left < margin) x += margin - left
      if (bottom > rect.height - margin) y -= bottom - (rect.height - margin)
      if (top < margin) y += margin - top
      return x === t.x && y === t.y ? t : { ...t, x, y }
    })
  }, [selectedNodeId, posById])

  useEffect(() => {
    if (selectedNodeId == null) return undefined
    const el = containerRef.current
    if (!el) return undefined
    const frame = requestAnimationFrame(keepSelectedVisible)
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(keepSelectedVisible)
    observer?.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [selectedNodeId, keepSelectedVisible])

  // Persisted `highlight` marks ring their elements with the SAME treatment a
  // model highlight gets — but they must not move the viewport (only a
  // host-driven narration earns that), so they stay out of `externalHighlight`.
  const markHighlightIds = useMemo(() => {
    const s = new Set()
    for (const m of normalizeMarks(marks)) {
      if (m.kind === 'highlight') for (const id of m.ids) s.add(id)
    }
    return s
  }, [marks])

  // Click semantics stay backward-compatible: plain click → onNodeClick (the
  // inspector), modifier-click → toggle selection. Without onToggleSelect the
  // modifier branch never fires, so existing callers are untouched.
  const handleNodeClick = useCallback((e, id) => {
    e.stopPropagation()
    // In draw mode the click IS the gesture. Highlight marks the element; box
    // and arrow swallow the trailing click so a drag that ends on a card can't
    // also open the inspector. Both branches are dead when drawMode is null.
    if (drawMode === 'highlight') {
      emitMark(buildHighlightMark(id, drawColor))
      return
    }
    if (drawArmed) return
    if (onToggleSelect && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      onToggleSelect(id)
      return
    }
    if (onNodeClick) onNodeClick(id)
  }, [drawMode, drawArmed, emitMark, drawColor, onToggleSelect, onNodeClick])

  // ── Project current graph nodes → canvas elements [{id,label,status}] ──
  const getElements = useCallback(() => (
    graph.nodes.map((n) => ({
      id: n.id,
      label: n.name || n.id,
      status: n.status || '',
      // Carry the type so canvas chat/journey can reason over node kinds.
      ...(n.type ? { type: n.type } : {}),
    }))
  ), [graph.nodes])

  const typeLegend = useMemo(
    () => (explicit ? buildTypeLegend(graph.nodes) : []),
    [explicit, graph.nodes],
  )
  const typeColorByKey = useMemo(() => {
    const colors = new Map()
    for (const entry of typeLegend) {
      for (const key of entry.typeKeys) colors.set(key, entry.color)
    }
    return colors
  }, [typeLegend])
  const zoneLegend = useMemo(() => {
    if (explicit) return []
    const seen = new Set()
    const entries = []
    for (const node of graph.nodes) {
      const key = String(node.zone || '').trim().toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      entries.push({
        key,
        label: ZONE_LABEL[key] || displayType(key),
        color: zoneColor(key),
        typeKeys: [key],
      })
    }
    return entries
  }, [explicit, graph.nodes])
  const legendEntries = explicit ? typeLegend : zoneLegend

  // ── Toolbar (level switcher + actions) ──────────────────────────
  const toolbar = (
    <div className="flex items-center gap-3 px-5 py-3 border-b border-x-line shrink-0">
      {toolbarStart}
      {toolbarExtra}

      <div className="flex-1" />

      {/* The legend is strictly data-derived. An empty graph renders no stale
          defaults, and a high-cardinality type set ends in one honest Other. */}
      {legendEntries.length > 0 && (
        <div
          className="flex items-center gap-3 flex-wrap justify-end"
          aria-label="Graph legend"
          data-legend-kind={explicit ? 'type' : 'zone'}
        >
          {legendEntries.map((entry) => (
            <span
              key={entry.key}
              className="flex items-center gap-1.5 text-[11px] text-x-muted"
              data-legend-label={entry.label}
              data-legend-types={entry.typeKeys.join(',')}
              title={entry.groupedLabels ? `Other: ${entry.groupedLabels.join(', ')}` : undefined}
            >
              <Dot color={entry.color} size={7} />
              {entry.label}
            </span>
          ))}
        </div>
      )}

      {hasCycle && (
        <Chip
          color="amber"
          icon={AlertTriangle}
          title="Some edges form a loop. Nodes in each loop share one dependency rank; the remaining ranks still read from top to bottom."
        >
          Cycle detected
        </Chip>
      )}

      {toolbarActions}
      <div className="flex items-center gap-1" aria-label="Graph zoom controls">
        <IconButton
          icon={Minus}
          label="Zoom out"
          size="sm"
          disabled={transform.scale <= MIN_ZOOM}
          onClick={() => zoomBy(1 / 1.15)}
        />
        <span
          className="min-w-[44px] text-center text-[11px] font-mono tabular-nums text-x-muted"
          title="Current graph zoom"
          aria-label={`Graph zoom ${Math.round(transform.scale * 100)} percent`}
        >
          {Math.round(transform.scale * 100)}%
        </span>
        <IconButton
          icon={Plus}
          label="Zoom in"
          size="sm"
          disabled={transform.scale >= MAX_ZOOM}
          onClick={() => zoomBy(1.15)}
        />
      </div>
      <Button size="sm" onClick={fitView} title="Fit graph to a readable view">
        Fit
      </Button>
      <Button
        size="sm"
        icon={MessageSquare}
        selected={canvasOpen}
        disabled={!canvasAvailable}
        onClick={() => setCanvasOpen((v) => !v)}
        title={canvasAvailable ? "Interactive canvas — chat + narrated tour" : "Interactive canvas requires the Forge extension"}
      >
        Canvas
      </Button>
    </div>
  )

  // ── Empty state ─────────────────────────────────────────────────
  const isEmpty = !loading && positioned.length === 0

  // min-w-0 for the same reason the pan surface below is overflow-hidden: the
  // transformed graph layer carries an explicit pixel width, so a flex item's
  // default `min-width:auto` would size this to the GRAPH, not to its
  // container — the graph then paints outside whatever panel holds it.
  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {toolbar}

      {error && (
        <StatusBar tone="error">{error}</StatusBar>
      )}

      {isEmpty ? (
        emptyState || <EmptyState icon={Network} title="No nodes yet" description="This graph has no nodes to display." />
      ) : (
        <div
          ref={containerRef}
          className={`flex-1 overflow-auto ${
            drawArmed ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'
          } relative`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => { panRef.current = null }}
        >
          {loading && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-3 py-1.5 rounded-full bg-x-surface border border-x-line shadow-x-1">
              <Spinner size={12} />
              <span className="text-[12px] text-x-muted">Loading…</span>
            </div>
          )}

          {/* Discard hint — a mark that covered no element is thrown away, and
              this is the only trace it leaves. Deliberately quiet and transient:
              the doctrine is that an unanchored mark is not data, not that the
              human did something wrong. */}
          {drawHint && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 px-2.5 py-1 rounded-full bg-x-surface border border-x-line shadow-x-1 text-[11px] text-x-muted pointer-events-none">
              {drawHint}
            </div>
          )}

          <div
            style={{
              transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
              transformOrigin: '0 0',
              width,
              height,
              position: 'relative',
            }}
          >
            {/* Edges */}
            <svg
              width={width}
              height={height}
              className="absolute inset-0 pointer-events-none"
              style={{ overflow: 'visible' }}
            >
              <defs>
                <marker id="sysgraph-arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                  <polygon points="0 0, 8 3, 0 6" style={{ fill: EDGE_COLOR }} />
                </marker>
              </defs>
              {drawEdges.map((edge) => (
                <g key={edge.id}>
                  <path
                    d={edgePath(edge)}
                    fill="none"
                    style={{ stroke: EDGE_COLOR }}
                    strokeWidth="1.5"
                    markerEnd="url(#sysgraph-arrow)"
                  />
                </g>
              ))}
            </svg>

            {/* Nodes — refined glass cards (Task #11). The accent is driven by node
                TYPE for agent systems (richer, agentario-like), falling back to ZONE
                color for the L0 code-catalog graph where nodes are zone-tagged. The
                type encoding shows as a small dot + sans label, never a loud band. */}
            {positioned.map((p) => {
              const n = p.node
              const accent = explicit
                ? (typeColorByKey.get(normalizeType(n.type)) || OTHER_TYPE_COLOR)
                : zoneColor(n.zone)
              const isHover = hoverNodeId === n.id
              const isHighlit = highlightedIds.has(n.id)
                || !!externalHighlight?.has(n.id)
                || markHighlightIds.has(n.id)
              const isSelected = selectedNodeId != null && selectedNodeId === n.id
              // Overlay reads — all no-ops when the host passed nothing.
              const badge = overlayBadges ? overlayBadges[n.id] : null
              const heat = Math.max(0, Math.min(1, Number(badge?.heat) || 0))
              const isPicked = selectedSet.has(n.id)
              const nodePins = pinsByElement[n.id] || []
              const clickable = !!(onNodeClick || onToggleSelect || drawMode === 'highlight')
              return (
                <div
                  key={n.id}
                  data-node={n.id}
                  data-node-type={explicit ? normalizeType(n.type) : String(n.zone || '').toLowerCase()}
                  data-node-rank={p.layer == null ? 'grid' : p.layer}
                  onClick={clickable ? (e) => handleNodeClick(e, n.id) : undefined}
                  className={`absolute select-none overflow-hidden bg-x-surface border rounded-[10px] shadow-x-1 transition-colors duration-[80ms] ease-x ${
                    clickable && !drawArmed ? 'cursor-pointer' : ''
                  } ${
                    isSelected || isPicked
                      ? 'border-x-accent ring-2 ring-x-accent/60 z-10'
                      : isHighlit
                      ? 'border-x-accent ring-2 ring-x-accent/40 z-10'
                      : isHover
                      ? 'border-x-line-strong bg-x-hover'
                      : 'border-x-line'
                  }`}
                  style={{
                    left: p.x,
                    top: p.y,
                    width: NODE_W,
                    height: NODE_H,
                  }}
                  onMouseEnter={() => setHoverNodeId(n.id)}
                  onMouseLeave={() => setHoverNodeId(null)}
                >
                  {/* Heat tint — an accent wash whose strength is the element's
                      share of the window's churn. Painted UNDER the content
                      (explicit z-index; positioned children otherwise paint over
                      static siblings regardless of DOM order). */}
                  {heat > 0 && (
                    <span
                      className="absolute inset-0 pointer-events-none"
                      style={{
                        background: 'var(--color-x-accent)',
                        opacity: 0.05 + heat * 0.18,
                        zIndex: 0,
                      }}
                    />
                  )}

                  {/* Badges — changed-file count + the two docs flags. Corner-
                      anchored so they never reflow the existing header row. */}
                  {badge && (badge.count > 0 || badge.stale || badge.undocumented) && (
                    <div className="absolute top-1.5 right-1.5 z-[2] flex items-center gap-1">
                      {badge.stale && (
                        <span
                          title="Docs are stale — this element changed after the last docs build"
                          className="inline-block w-[7px] h-[7px] rounded-full"
                          style={{ background: 'var(--x-accent-ink)' }}
                        />
                      )}
                      {badge.undocumented && (
                        <span
                          title="Undocumented — no docs page covers this element"
                          className="inline-block w-[7px] h-[7px] rounded-full border border-x-muted"
                        />
                      )}
                      {badge.count > 0 && (
                        <span
                          title={`${badge.count} changed file${badge.count === 1 ? '' : 's'}`}
                          className="inline-flex items-center h-[15px] px-1.5 rounded-full border border-x-accent/40 bg-x-accent/15 text-[10px] font-medium tabular-nums text-x-accent"
                        >
                          {badge.count}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Authored marks (canvas annotations) as a pin. Hover carries
                      the text — the graph stays readable, the note stays one
                      hover away. */}
                  {nodePins.length > 0 && (
                    <div
                      className="absolute bottom-1.5 right-1.5 z-[2] flex items-center gap-0.5 text-x-accent"
                      title={nodePins.map((pin) => `${pin.kind ? `[${pin.kind}] ` : ''}${pin.text || ''}`).join('\n')}
                    >
                      <Pin size={10} strokeWidth={2} />
                      {nodePins.length > 1 && (
                        <span className="text-[10px] tabular-nums">{nodePins.length}</span>
                      )}
                    </div>
                  )}

                  {/* Restrained header row — a small type dot + sans uppercase type
                      label, with a quiet status chip when present. No colored band. */}
                  <div className="relative z-[1] flex items-center gap-1.5 px-3 pt-2.5">
                    {selectable && (
                      <button
                        onClick={(e) => { e.stopPropagation(); if (onToggleSelect) onToggleSelect(n.id) }}
                        title={isPicked ? 'Remove from selection' : 'Add to selection'}
                        className={`flex items-center justify-center h-[13px] w-[13px] rounded-[3px] border shrink-0 transition-colors duration-[80ms] ${
                          isPicked
                            ? 'bg-x-accent border-transparent text-x-on-accent'
                            : 'border-x-line-strong text-transparent hover:border-x-accent'
                        }`}
                      >
                        <Check size={9} strokeWidth={3} />
                      </button>
                    )}
                    <Dot color={accent} size={7} />
                    <span className="text-[11px] font-medium uppercase tracking-wide text-x-muted truncate">
                      {nodeTypeLabel(n.type)}
                    </span>
                    {n.status && (
                      <Chip
                        color={STATUS_CHIP_COLOR[n.status] || 'neutral'}
                        className="ml-auto !px-1.5 !py-0 !text-[11px]"
                      >
                        {n.status}
                      </Chip>
                    )}
                  </div>
                  {/* Body — the node label, plus zone tag when present (L0 graph). */}
                  <div className="relative z-[1] flex flex-col justify-center px-3 pb-2.5 pt-1 gap-0.5" style={{ height: NODE_H - 28 }}>
                    <span className="text-[12.5px] font-medium text-x-ink leading-tight line-clamp-2 break-words">
                      {n.name || n.id}
                    </span>
                    {n.zone && (
                      <span className="flex items-center gap-1 text-[11px] text-x-muted truncate">
                        <Dot color={zoneColor(n.zone)} size={5} />
                        {ZONE_LABEL[n.zone] || n.zone}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}

            {/* Draw marks — persisted annotations + the in-flight gesture, both
                re-anchored to CURRENT positions every render (a mark follows its
                elements; it is not a replayed rectangle). Renders nothing at all
                when there's neither a mark nor a gesture, and never takes a
                pointer event — except under eraseMode, where a mark's own
                outline is the thing you click to remove it. */}
            <GraphDrawLayer
              marks={marks}
              posById={posById}
              width={width}
              height={height}
              nodeW={NODE_W}
              nodeH={NODE_H}
              draft={draft}
              color={drawColor}
              eraseMode={eraseMode}
              onErase={onEraseMark}
            />

            {/* Edge labels use their own HTML layer above cards, matching the
                editor pattern in agentario. Counter-scaling holds an 11px
                screen-size floor through Fit; below 60% the layer disappears
                instead of becoming an unreadable smear. */}
            {transform.scale >= EDGE_LABEL_MIN_ZOOM && (
              <div
                className="absolute inset-0 pointer-events-none"
                style={{ zIndex: 30 }}
                aria-label="Graph edge labels"
                data-edge-label-layer="visible"
              >
                {drawEdges.filter((edge) => edge.label).map((edge) => (
                  <span
                    key={edge.id}
                    className="system-graph-edge-label"
                    data-edge-label={String(edge.label)}
                    style={{
                      left: edge.labelX,
                      top: edge.labelY,
                      transform: `translate(-50%, -50%) scale(${1 / Math.min(1, transform.scale)})`,
                    }}
                  >
                    {edge.label}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Interactive canvas overlay (chat + narrated tour) */}
          <CanvasControls
            open={canvasOpen}
            onClose={() => setCanvasOpen(false)}
            onHighlight={setHighlightedIds}
            onFocus={focusNodes}
            getElements={getElements}
            workspaceId={workspaceId}
            canvasId={canvasId}
            systemContext={systemContext}
          />
        </div>
      )}
    </div>
  )
}

// Status → Chip color (semantic only — status surfaces are the one place colors
// beyond the cyan accent are allowed). Unknown statuses fall back to neutral.
const STATUS_CHIP_COLOR = {
  active: 'emerald',
  healthy: 'emerald',
  ok: 'emerald',
  stale: 'amber',
  degraded: 'amber',
  planned: 'accent',
  deprecated: 'red',
  error: 'red',
}
