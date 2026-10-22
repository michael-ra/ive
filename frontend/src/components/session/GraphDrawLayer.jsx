import { Fragment, useMemo } from 'react'
import { Square, ArrowUpRight, Highlighter, MousePointer, Eraser } from 'lucide-react'
import { Button } from '../ui'
import {
  normalizeMarks,
  unionBox,
  nodeCenter,
  boxEdgePoint,
  normalizeRect,
} from './graphMarks'

/**
 * GraphDrawLayer — the RENDER half of draw-marks-as-data.
 *
 * Draws persisted marks and the in-progress gesture in GRAPH space, i.e. inside
 * SystemGraph's transformed layout div, so everything pans/zooms with the graph
 * for free. Purely presentational: it owns no gesture state, no transform, no
 * fetches. `pointerEvents:none` throughout — the layer must never steal a click
 * from a node, a pan, or the canvas overlay panel.
 *
 * Marks are re-derived from LIVE positions on every render. A persisted box is
 * therefore an outline around wherever its elements are NOW, not a rectangle
 * replayed from stored pixels — which is the whole point (vision §1). A mark
 * whose elements have all disappeared renders nothing.
 *
 * `eraseMode` is the ONE exception to pointerEvents:none, and it is scoped to
 * the shapes themselves: their outlines become click targets so a box or an
 * arrow can be removed by clicking the thing you see. The interior of a box
 * stays transparent to the pointer (fill stays none), so the nodes inside it are
 * still reachable. With eraseMode off the layer is inert exactly as before.
 */

const ACCENT = 'var(--color-x-accent)'
const BOX_PAD = 12       // graph units of breathing room around the union box
const HEAD = 13          // arrowhead length, graph units
// A 2px outline is a hairline to aim at, so erase mode lays an invisible fat
// stroke over the same path. Non-scaling like the visible one, so the target is
// the same size at every zoom.
const HIT_STROKE = 16

/** Filled triangle at `tip`, pointing along `angle`. */
function headPath(tip, angle, size = HEAD) {
  const a1 = angle - 0.42
  const a2 = angle + 0.42
  return [
    `M ${tip.x} ${tip.y}`,
    `L ${tip.x - size * Math.cos(a1)} ${tip.y - size * Math.sin(a1)}`,
    `L ${tip.x - size * Math.cos(a2)} ${tip.y - size * Math.sin(a2)}`,
    'Z',
  ].join(' ')
}

/** Source/target positions → the trimmed segment between their card edges. */
function arrowGeometry(from, to, nodeW, nodeH) {
  const c1 = nodeCenter(from, nodeW, nodeH)
  const c2 = nodeCenter(to, nodeW, nodeH)
  const p1 = boxEdgePoint(c1, c2, nodeW / 2, nodeH / 2)
  const p2 = boxEdgePoint(c2, c1, nodeW / 2, nodeH / 2)
  return { p1, p2, angle: Math.atan2(p2.y - p1.y, p2.x - p1.x) }
}

export default function GraphDrawLayer({
  marks = null,
  posById = null,
  width = 0,
  height = 0,
  nodeW,
  nodeH,
  draft = null,
  color = null,
  eraseMode = false,
  onErase = null,
}) {
  const drawn = useMemo(() => normalizeMarks(marks), [marks])

  // Resolve every mark against the CURRENT layout. Anything that resolves to
  // nothing (all its elements are gone) is dropped here — stale-safe.
  const shapes = useMemo(() => {
    const out = []
    for (const m of drawn) {
      const stroke = m.color || ACCENT
      if (m.kind === 'arrow') {
        const from = posById && posById[m.sourceId]
        const to = posById && posById[m.targetId]
        if (!from || !to) continue
        out.push({
          ...arrowGeometry(from, to, nodeW, nodeH),
          type: 'arrow', kind: m.kind, key: m.key, id: m.id, stroke, title: m.text,
        })
        continue
      }
      if (m.kind === 'box') {
        const b = unionBox(posById, m.ids, nodeW, nodeH, BOX_PAD)
        if (!b) continue
        out.push({ type: 'box', kind: m.kind, key: m.key, id: m.id, stroke, box: b, title: m.text })
        continue
      }
      // highlight — the ring treatment belongs to the NODE (SystemGraph already
      // owns that look), so nothing is drawn here. Its ids are surfaced to the
      // host graph via markHighlightIds instead, and erasing one is therefore a
      // click on the node, not on this layer.
    }
    return out
  }, [drawn, posById, nodeW, nodeH])

  // Erase turns a shape into a target. A mark with no `id` has not come back
  // from a save yet, so there is nothing to delete — it says so rather than
  // silently ignoring the click, which would read as a dead tool.
  const eraseGroupProps = (s) => {
    if (!eraseMode) return null
    if (!s.id) {
      return {
        style: { pointerEvents: 'stroke', cursor: 'not-allowed' },
        eraseTitle: `This ${s.kind} is still being saved — it can be erased once it lands.`,
      }
    }
    return {
      style: { pointerEvents: 'stroke', cursor: 'pointer' },
      eraseTitle: `Erase this ${s.kind}`,
      onClick: (e) => { e.stopPropagation(); if (onErase) onErase(s.id) },
    }
  }

  // In-progress gesture. Rendered from raw graph coords, never persisted.
  const preview = useMemo(() => {
    if (!draft) return null
    if (draft.kind === 'box') {
      return { type: 'box', box: normalizeRect(draft.x0, draft.y0, draft.x1, draft.y1) }
    }
    if (draft.kind === 'arrow') {
      const from = posById && posById[draft.sourceId]
      if (!from) return null
      const c1 = nodeCenter(from, nodeW, nodeH)
      const tip = { x: draft.x1, y: draft.y1 }
      const p1 = boxEdgePoint(c1, tip, nodeW / 2, nodeH / 2)
      return { type: 'arrow', p1, p2: tip, angle: Math.atan2(tip.y - p1.y, tip.x - p1.x) }
    }
    return null
  }, [draft, posById, nodeW, nodeH])

  if (!shapes.length && !preview) return null
  const previewStroke = color || ACCENT

  // Not aria-hidden: a mark is authored content, and the per-shape <title> is
  // the only place its text is exposed to a screen reader. pointerEvents:none
  // throughout — the layer must never steal a click from a node or the pan.
  return (
    <svg
      width={width}
      height={height}
      className="absolute inset-0"
      style={{ overflow: 'visible', pointerEvents: 'none', zIndex: 20 }}
    >
      {shapes.map((s) => {
        // Erase replaces the mark's own text as the hover label: while the tool
        // is armed, what the pointer is about to DO outranks what the mark says.
        const { eraseTitle, ...groupProps } = eraseGroupProps(s) || {}
        const label = eraseTitle || s.title
        return s.type === 'box' ? (
          <g key={s.key} {...groupProps}>
            {label ? <title>{label}</title> : null}
            {eraseMode && (
              <rect
                x={s.box.x}
                y={s.box.y}
                width={s.box.w}
                height={s.box.h}
                rx="14"
                fill="none"
                stroke="transparent"
                strokeWidth={HIT_STROKE}
                vectorEffect="non-scaling-stroke"
              />
            )}
            <rect
              x={s.box.x}
              y={s.box.y}
              width={s.box.w}
              height={s.box.h}
              rx="14"
              fill="none"
              stroke={s.stroke}
              strokeWidth="2"
              strokeOpacity="0.85"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ) : (
          <g key={s.key} {...groupProps}>
            {label ? <title>{label}</title> : null}
            {eraseMode && (
              <line
                x1={s.p1.x}
                y1={s.p1.y}
                x2={s.p2.x}
                y2={s.p2.y}
                stroke="transparent"
                strokeWidth={HIT_STROKE}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
            <line
              x1={s.p1.x}
              y1={s.p1.y}
              x2={s.p2.x}
              y2={s.p2.y}
              stroke={s.stroke}
              strokeWidth="2"
              strokeOpacity="0.9"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            <path d={headPath(s.p2, s.angle)} fill={s.stroke} fillOpacity="0.9" />
          </g>
        )
      })}

      {preview && (preview.type === 'box' ? (
        <rect
          x={preview.box.x}
          y={preview.box.y}
          width={preview.box.w}
          height={preview.box.h}
          rx="10"
          fill={previewStroke}
          fillOpacity="0.08"
          stroke={previewStroke}
          strokeWidth="1.5"
          strokeDasharray="5 4"
          vectorEffect="non-scaling-stroke"
        />
      ) : (
        <g>
          <line
            x1={preview.p1.x}
            y1={preview.p1.y}
            x2={preview.p2.x}
            y2={preview.p2.y}
            stroke={previewStroke}
            strokeWidth="1.5"
            strokeDasharray="5 4"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          <path d={headPath(preview.p2, preview.angle)} fill={previewStroke} fillOpacity="0.7" />
        </g>
      ))}
    </svg>
  )
}

// ── DrawToolbar ─────────────────────────────────────────────────────────────
// Deliberately dumb: it renders four buttons and calls back. The mode lives in
// the HOST (which also owns the save callback), so a host can drive drawMode
// from a keyboard shortcut, a voice command, or anything else without this
// component existing at all.
//
// There is no pen button. A free stroke anchors to nothing, so it cannot become
// data — see NO_PEN in graphMarks.js. Erase is not a fourth way to draw and does
// not touch that rule: it only ever REMOVES a mark that already exists, which is
// why it sits behind a rule rather than in the same run of buttons.
const TOOLS = [
  { mode: 'box', icon: Square, label: 'Box', title: 'Box — drag over elements to mark them together' },
  { mode: 'arrow', icon: ArrowUpRight, label: 'Arrow', title: 'Arrow — press one element, release on another' },
  { mode: 'highlight', icon: Highlighter, label: 'Highlight', title: 'Highlight — click an element' },
  {
    mode: 'erase',
    icon: Eraser,
    label: 'Erase',
    title: 'Erase — click a mark or a note pin to remove it',
    apart: true,
  },
]

export function DrawToolbar({ mode = null, onChange, className = '', size = 'sm' }) {
  const pick = (next) => { if (onChange) onChange(mode === next ? null : next) }
  return (
    <div className={`flex items-center gap-1 ${className}`}>
      {TOOLS.map((t) => (
        <Fragment key={t.mode}>
          {t.apart && <span aria-hidden="true" className="w-px h-4 mx-1 shrink-0 bg-x-line" />}
          <Button
            size={size}
            icon={t.icon}
            selected={mode === t.mode}
            title={t.title}
            onClick={() => pick(t.mode)}
          >
            {t.label}
          </Button>
        </Fragment>
      ))}
      <Button
        size={size}
        icon={MousePointer}
        selected={!mode}
        title="Off — back to pan / select"
        onClick={() => { if (onChange) onChange(null) }}
      >
        Off
      </Button>
    </div>
  )
}
