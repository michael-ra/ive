// CatchUpPanel — modal panel showing the briefing + raw event digest.
//
// Lets the user pick a preset range or a custom start/end window, swap
// the summarizing model (haiku ↔ sonnet), and regenerate the briefing.

import { useEffect, useState } from 'react'
import { api } from '../../lib/api'

const RANGES = [
  { id: '1h', label: 'Last hour', ms: 60 * 60 * 1000 },
  { id: '8h', label: 'Last 8 hours', ms: 8 * 60 * 60 * 1000 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
]

const MODELS = [
  { id: 'haiku', label: 'Haiku', hint: 'Fast' },
  { id: 'sonnet', label: 'Sonnet', hint: 'Richer' },
]

// Format Date → "YYYY-MM-DDTHH:MM" for <input type="datetime-local">.
function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function CatchUpPanel({ initialDigest = null, onClose }) {
  const [digest, setDigest] = useState(initialDigest)
  const [range, setRange] = useState('24h')
  const [customOpen, setCustomOpen] = useState(false)
  const [customSince, setCustomSince] = useState(() =>
    toLocalInput(new Date(Date.now() - 24 * 60 * 60 * 1000))
  )
  const [customUntil, setCustomUntil] = useState(() => toLocalInput(new Date()))
  const [model, setModel] = useState('haiku')
  const [loading, setLoading] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  async function loadPreset(rangeId, modelOverride) {
    const r = RANGES.find((x) => x.id === rangeId) || RANGES[2]
    const since = new Date(Date.now() - r.ms).toISOString()
    return loadWindow({ since, until: undefined, modelOverride })
  }

  async function loadCustom(modelOverride) {
    if (!customSince) return
    const sinceIso = new Date(customSince).toISOString()
    const untilIso = customUntil ? new Date(customUntil).toISOString() : undefined
    return loadWindow({ since: sinceIso, until: untilIso, modelOverride })
  }

  async function loadWindow({ since, until, modelOverride }) {
    setLoading(true)
    try {
      const d = await api.getCatchup({
        since,
        until,
        limit: 500,
        model: modelOverride || model,
      })
      setDigest(d)
    } catch (e) {
      console.warn('catchup load failed', e)
    } finally {
      setLoading(false)
    }
  }

  // Initial load + reload when range/model changes (preset mode only).
  useEffect(() => {
    if (!customOpen) loadPreset(range)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, model, customOpen])

  const briefing = digest?.summary
  const briefingFromLLM =
    digest?.summary_source && digest.summary_source !== 'deterministic'

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-20"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-zinc-100">Briefing</div>
            <div className="text-xs text-zinc-500">
              {digest ? (
                <>
                  {digest.total_events} event{digest.total_events !== 1 ? 's' : ''}
                  {digest.total_commits > 0 && (
                    <> · {digest.total_commits} commit{digest.total_commits !== 1 ? 's' : ''}</>
                  )}
                  {digest.total_memory_changes > 0 && (
                    <> · {digest.total_memory_changes} memory</>
                  )}
                </>
              ) : 'Loading…'}
              {briefingFromLLM && (
                <span className="ml-2 text-zinc-600">· {digest.summary_source}</span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded px-2 py-0.5 text-zinc-400 hover:bg-zinc-800"
          >
            ✕
          </button>
        </div>

        {/* Range + model controls */}
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2">
          {RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => {
                setCustomOpen(false)
                setRange(r.id)
              }}
              className={`rounded border px-2 py-0.5 text-xs ${
                !customOpen && range === r.id
                  ? 'border-amber-500 bg-amber-500/10 text-amber-300'
                  : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
              }`}
            >
              {r.label}
            </button>
          ))}
          <button
            onClick={() => setCustomOpen((v) => !v)}
            className={`rounded border px-2 py-0.5 text-xs ${
              customOpen
                ? 'border-amber-500 bg-amber-500/10 text-amber-300'
                : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
            }`}
          >
            Custom…
          </button>

          <div className="ml-auto flex items-center gap-1">
            {MODELS.map((m) => (
              <button
                key={m.id}
                onClick={() => setModel(m.id)}
                title={m.hint}
                className={`rounded border px-2 py-0.5 text-xs ${
                  model === m.id
                    ? 'border-emerald-500/70 bg-emerald-500/10 text-emerald-300'
                    : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
                }`}
              >
                {m.label}
              </button>
            ))}
            <button
              onClick={() => (customOpen ? loadCustom() : loadPreset(range))}
              disabled={loading}
              className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              title="Regenerate briefing"
            >
              ↻
            </button>
          </div>
        </div>

        {customOpen && (
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2 text-xs text-zinc-400">
            <label className="flex items-center gap-1">
              From
              <input
                type="datetime-local"
                value={customSince}
                onChange={(e) => setCustomSince(e.target.value)}
                className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-zinc-200"
              />
            </label>
            <label className="flex items-center gap-1">
              To
              <input
                type="datetime-local"
                value={customUntil}
                onChange={(e) => setCustomUntil(e.target.value)}
                className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-zinc-200"
              />
            </label>
            <button
              onClick={() => loadCustom()}
              disabled={loading || !customSince}
              className="rounded border border-amber-600 bg-amber-500/10 px-2 py-0.5 text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
            >
              Brief me
            </button>
          </div>
        )}

        {/* Briefing prose + raw event detail */}
        <div className="max-h-[60vh] overflow-y-auto p-4 text-sm text-zinc-300">
          {loading && (
            <div className="text-zinc-500">
              {briefingFromLLM ? 'Re-briefing…' : 'Briefing…'}
            </div>
          )}

          {!loading && digest && (
            <>
              {digest.total_events === 0 &&
              (digest.total_commits || 0) === 0 &&
              (digest.total_memory_changes || 0) === 0 ? (
                <div className="text-zinc-500">No new activity in this window.</div>
              ) : (
                <>
                  <div className="mb-3 whitespace-pre-wrap rounded border border-zinc-800 bg-zinc-900/40 p-3 text-[0.95rem] leading-relaxed text-zinc-100">
                    {briefing}
                  </div>
                  {briefingFromLLM && digest.summary_basic && (
                    <div className="mb-3 text-xs text-zinc-500">
                      Counts: {digest.summary_basic}
                    </div>
                  )}

                  {Array.isArray(digest.commits) && digest.commits.length > 0 && (
                    <div className="mb-3 rounded border border-zinc-800 bg-zinc-900/30 p-2">
                      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">
                        Commits
                      </div>
                      {digest.commits.map((w) => (
                        <div key={w.workspace_id} className="mb-2 last:mb-0">
                          <div className="text-xs text-zinc-500">
                            {w.workspace_name || w.workspace_id}
                          </div>
                          <ul className="mt-1 space-y-0.5">
                            {w.commits.slice(0, 12).map((c) => (
                              <li
                                key={c.hash}
                                className="flex items-baseline gap-2 font-mono text-xs text-zinc-300"
                              >
                                <span className="text-amber-400">{c.short_hash}</span>
                                <span className="flex-1 truncate font-sans">{c.message}</span>
                                {(c.files_changed || 0) > 0 && (
                                  <span className="text-zinc-600">
                                    {c.files_changed}f +{c.insertions}/-{c.deletions}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}

                  {Array.isArray(digest.memory_changes) &&
                    digest.memory_changes.length > 0 && (
                      <div className="mb-3 rounded border border-zinc-800 bg-zinc-900/30 p-2">
                        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">
                          Memory
                        </div>
                        <ul className="space-y-0.5 text-xs text-zinc-400">
                          {digest.memory_changes.map((m) => (
                            <li key={`${m.workspace_id}-${m.scope}`}>
                              <span className="text-zinc-300">{m.scope}</span>{' '}
                              ws=<span className="font-mono">{(m.workspace_id || '').slice(0, 8)}</span>{' '}
                              · {m.content_length}b · {m.provider_count} providers · synced{' '}
                              {m.last_synced_at || 'never'}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                  <button
                    onClick={() => setShowRaw((v) => !v)}
                    className="mb-2 text-xs text-zinc-500 hover:text-zinc-300"
                  >
                    {showRaw ? '▾ Hide event log' : '▸ Show event log'}
                  </button>
                  {showRaw && (
                    <div className="space-y-2">
                      {digest.events?.map((e) => (
                        <div
                          key={e.id}
                          className="rounded border border-zinc-800 bg-zinc-900/40 p-2"
                        >
                          <div className="flex items-center gap-2 text-xs text-zinc-500">
                            <span className="font-mono text-zinc-400">{e.event_type}</span>
                            <span className="ml-auto">{e.created_at}</span>
                          </div>
                          {Object.keys(e.payload || {}).length > 0 && (
                            <pre className="mt-1 overflow-x-auto text-xs text-zinc-400">
                              {JSON.stringify(e.payload, null, 2)}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
