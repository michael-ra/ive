import { useEffect, useMemo, useRef, useState } from 'react'
import { Boxes, Search, X } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'

const KIND_ORDER = [
  'session', 'cli', 'executor', 'auth', 'workspace', 'oversight', 'sandbox',
  'security', 'tool_policy', 'mcp_server', 'mcp_tool', 'connector', 'guideline',
  'skill', 'plugin', 'plugin_component', 'feature_flag', 'event_subscription',
]

function kindLabel(kind) {
  return String(kind || 'other').replaceAll('_', ' ')
}

function displayValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'none'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}

function detailRows(detail) {
  const rows = []
  for (const [key, value] of Object.entries(detail || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        rows.push([`${key}.${nestedKey}`, displayValue(nestedValue)])
      }
    } else {
      rows.push([key, displayValue(value)])
    }
  }
  return rows
}

export default function CapabilitiesPanel({ onClose }) {
  const activeSessionId = useStore((state) => state.activeSessionId)
  const session = useStore((state) => state.sessions[state.activeSessionId])
  const [capabilities, setCapabilities] = useState([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setCapabilities([])
    if (!activeSessionId) {
      setLoading(false)
      setError('No active session.')
      return () => { cancelled = true }
    }
    api.getSessionCapabilities(activeSessionId)
      .then((payload) => {
        if (!cancelled) setCapabilities(Array.isArray(payload?.capabilities) ? payload.capabilities : [])
      })
      .catch((requestError) => {
        if (!cancelled) setError(requestError?.message || 'Could not load capabilities.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [activeSessionId])

  useEffect(() => {
    inputRef.current?.focus()
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? capabilities.filter((capability) => JSON.stringify(capability).toLowerCase().includes(needle))
      : capabilities
    const byKind = new Map()
    for (const capability of filtered) {
      const kind = capability.kind || 'other'
      if (!byKind.has(kind)) byKind.set(kind, [])
      byKind.get(kind).push(capability)
    }
    return [...byKind.entries()].sort(([left], [right]) => {
      const leftIndex = KIND_ORDER.indexOf(left)
      const rightIndex = KIND_ORDER.indexOf(right)
      if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right)
      if (leftIndex === -1) return 1
      if (rightIndex === -1) return -1
      return leftIndex - rightIndex
    })
  }, [capabilities, query])

  return (
    <div
      className="fixed inset-0 z-[160] flex items-start justify-center bg-x-scrim px-3 pt-[7vh] backdrop-blur-[4px]"
      onClick={onClose}
      data-capabilities-panel
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Session capabilities"
        className="x-panel flex max-h-[84vh] w-[min(860px,calc(100vw-1.5rem))] flex-col overflow-hidden shadow-x-3 scale-in"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b border-x-line px-5 py-4">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-x-line bg-x-surface-2 text-x-accent">
            <Boxes size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[11px] font-medium uppercase tracking-[0.09em] text-x-muted">
              Session reality
            </div>
            <h2 className="mt-0.5 truncate text-base font-semibold text-x-ink">Capabilities</h2>
            <p className="mt-0.5 truncate text-[11px] text-x-muted">
              {session?.name || activeSessionId} · read-only composition dump
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="x-icon-tile"
            title="Close capabilities"
            aria-label="Close capabilities"
          >
            <X size={15} />
          </button>
        </header>

        <div className="border-b border-x-line bg-x-surface px-5 py-3">
          <label className="relative block">
            <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-x-muted" />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by capability, source, or state…"
              aria-label="Filter capabilities"
              className="h-9 w-full rounded-md border border-x-line bg-x-surface-2 pl-9 pr-3 font-mono text-[11px] text-x-ink outline-none transition-colors placeholder:text-x-faint focus:border-x-accent"
            />
          </label>
        </div>

        <div className="flex-1 overflow-y-auto bg-x-bg px-5 py-4">
          {loading && (
            <div className="py-14 text-center font-mono text-[11px] text-x-muted animate-pulse">
              Composing session state…
            </div>
          )}
          {!loading && error && (
            <div className="rounded-[10px] border border-x-accent-ink/30 bg-x-surface p-4 text-sm text-x-accent-ink">
              {error}
            </div>
          )}
          {!loading && !error && groups.length === 0 && (
            <div className="py-14 text-center text-xs text-x-muted">
              {query ? 'No capabilities match this filter.' : 'No capabilities declared.'}
            </div>
          )}
          {!loading && !error && groups.map(([kind, entries]) => (
            <section key={kind} className="mb-5 last:mb-0" data-capability-group={kind}>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-x-ink-secondary">
                  {kindLabel(kind)}
                </h3>
                <span className="rounded-full border border-x-line bg-x-surface px-1.5 py-0.5 font-mono text-[11px] leading-none text-x-muted">
                  {entries.length}
                </span>
                <span className="h-px flex-1 bg-x-line" />
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {entries.map((capability, index) => {
                  const rows = detailRows(capability.detail)
                  return (
                    <article
                      key={`${capability.name}-${capability.source?.ref || index}`}
                      className="rounded-[10px] border border-x-line bg-x-surface p-3 shadow-x-1"
                      data-capability-entry
                      data-capability-kind={kind}
                      data-capability-name={capability.name}
                    >
                      <div className="break-words font-mono text-[12px] font-semibold text-x-ink">
                        {capability.name}
                      </div>
                      <div className="mt-0.5 break-all font-mono text-[11px] leading-4 text-x-muted">
                        {capability.source?.type || 'unknown'} · {capability.source?.ref || 'unknown'}
                      </div>
                      {rows.length > 0 && (
                        <dl className="mt-2 space-y-1 border-t border-x-line-subtle pt-2">
                          {rows.map(([key, value]) => (
                            <div key={key} className="grid grid-cols-[minmax(100px,0.42fr)_1fr] gap-2 text-[11px] leading-4">
                              <dt className="break-all font-mono text-x-faint">{key}</dt>
                              <dd className="min-w-0 break-words font-mono text-x-ink-secondary">{value}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </article>
                  )
                })}
              </div>
            </section>
          ))}
        </div>

        <footer className="flex items-center justify-between border-t border-x-line bg-x-surface px-5 py-2.5 font-mono text-[11px] text-x-muted">
          <span>{capabilities.length} entries</span>
          <span>Values from secret-bearing environment/config fields are omitted</span>
        </footer>
      </section>
    </div>
  )
}
