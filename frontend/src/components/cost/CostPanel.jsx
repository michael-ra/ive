import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '../../lib/api'
import { Button, Modal } from '../ui'

// Recorded token usage and cost estimates from saved model list prices.

const fmtUsd = (n) => `$${(Number(n) || 0).toFixed(2)}`
const fmtUsd4 = (n) => `$${(Number(n) || 0).toFixed(4)}`
const fmtNum = (n) => (Number(n) || 0).toLocaleString()

const CLI_COLOR = {
  claude: 'text-x-accent-ink border-x-accent-ink/30 bg-x-accent-ink/10',
  codex: 'text-x-good border-x-good/30 bg-x-good/10',
  gemini: 'text-x-accent border-x-accent/30 bg-x-accent/10',
  antigravity: 'text-x-ink-secondary border-x-line-strong bg-x-hover',
}

function Section({ title, children }) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-x-muted">{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function Row({ label, cost, sub, total }) {
  const pct = total > 0 ? Math.min(100, (cost / total) * 100) : 0
  return (
    <div className="rounded-md border border-x-line bg-x-surface p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          {label}
          <div className="mt-0.5 text-[11px] text-x-muted tabular-nums">{sub}</div>
        </div>
        <div className="text-sm text-x-ink tabular-nums">{fmtUsd(cost)}</div>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-x-surface-2">
        <div className="h-full bg-x-accent/50" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function CostPanel({ onClose, workspaceId = null }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await api.getCost(workspaceId ? { workspace_id: workspaceId } : {})
      setData(r)
    } catch (e) {
      setError(e?.message || 'Failed to load cost metrics')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const t = data?.totals
  const hasUsage = Number(t?.messages) > 0

  return (
    <Modal
      onClose={onClose}
      title="Cost & Tokens"
      subtitle={hasUsage
        ? `${data.session_count} session${data.session_count !== 1 ? 's' : ''} with recorded usage`
        : 'Recorded token usage and cost estimates'}
      className="!w-[min(896px,calc(100vw-2rem))] !h-auto !max-h-[85vh] rounded-xl"
      bodyClassName="overflow-hidden"
    >
        <div className="flex shrink-0 justify-end border-b border-x-line px-5 py-2">
          <Button
            size="sm"
            icon={RefreshCw}
            onClick={load}
            disabled={loading}
            loading={loading}
            aria-label="Refresh cost and token usage"
          >
            Refresh
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5" aria-busy={loading}>
          <p className="text-xs leading-relaxed text-x-muted">
            Token counts come from recorded session usage. Cost estimates use saved model list prices;
            your provider's current prices, subscription, discounts, and bill may differ.
          </p>
          {loading && <div role="status" className="text-sm text-x-muted">Reading recorded usage…</div>}
          {error && <div role="alert" className="text-sm text-x-danger">{error}</div>}

          {data && !loading && !error && !hasUsage && (
            <div className="rounded-lg border border-x-line bg-x-surface-2 p-4">
              <div className="text-sm font-semibold text-x-ink">No recorded usage yet</div>
              <p className="mt-1 text-xs leading-relaxed text-x-muted">
                No token usage was found for these sessions. Start a conversation, then refresh.
                Estimates appear when your agent records usage.
              </p>
            </div>
          )}

          {t && hasUsage && !loading && !error && (
            <>
              <div className="rounded-lg border border-x-line bg-x-surface p-4">
                <div className="text-2xl font-semibold text-x-ink tabular-nums">{fmtUsd(t.cost_usd)}</div>
                <div className="mt-1 text-xs text-x-ink-secondary">
                  estimated cost · {fmtNum(t.messages)} messages with recorded usage
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  {[
                    ['Input', t.input_tokens],
                    ['Output', t.output_tokens],
                    ['Cache write', t.cache_write_tokens],
                    ['Cache read', t.cache_read_tokens],
                  ].map(([label, v]) => (
                    <div key={label} className="rounded-md border border-x-line bg-x-surface-2 p-2">
                      <div className="text-x-muted">{label}</div>
                      <div className="text-x-ink tabular-nums">{fmtNum(v)}</div>
                    </div>
                  ))}
                </div>
              </div>

              <Section title="By CLI">
                {(data.per_cli || []).map((c) => (
                  <Row
                    key={c.cli}
                    label={
                      <span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${CLI_COLOR[c.cli] || 'border-x-line text-x-ink-secondary'}`}>
                        {c.cli}
                      </span>
                    }
                    cost={c.cost_usd}
                    sub={`${fmtNum(c.input_tokens)} in · ${fmtNum(c.output_tokens)} out · ${fmtNum(c.cache_read_tokens)} cache-read`}
                    total={t.cost_usd}
                  />
                ))}
              </Section>

              <Section title="By model">
                {(data.per_model || []).map((m) => {
                  const est = data.estimated_models?.includes(m.model)
                  return (
                    <Row
                      key={m.model}
                      label={
                        <span className="font-mono text-xs text-x-ink-secondary">
                          {m.model}
                          {est && (
                            <span className="ml-1 text-x-accent-ink" title="This model has no saved price. Its estimate uses a general fallback rate.">
                              fallback rate
                            </span>
                          )}
                        </span>
                      }
                      cost={m.cost_usd}
                      sub={`${fmtNum(m.messages)} msgs · ${fmtNum(m.output_tokens)} out`}
                      total={t.cost_usd}
                    />
                  )
                })}
              </Section>

              <Section title="By session">
                <div className="space-y-1">
                  {(data.per_session || []).map((s) => (
                    <div
                      key={s.session_id}
                      className="flex items-center justify-between gap-3 border-b border-x-line-subtle py-1.5 text-xs last:border-b-0 [content-visibility:auto] [contain-intrinsic-size:auto_32px]"
                    >
                      <span className="flex-1 truncate text-x-ink-secondary">{s.name || s.session_id.slice(0, 8)}</span>
                      <span className={`rounded-md border px-1 text-[11px] ${CLI_COLOR[s.cli] || 'border-x-line text-x-muted'}`}>
                        {s.cli}
                      </span>
                      <span className="w-24 text-right text-x-muted tabular-nums">
                        {fmtNum((s.input_tokens || 0) + (s.output_tokens || 0))} tok
                      </span>
                      <span className="w-20 text-right text-x-ink tabular-nums">{fmtUsd4(s.cost_usd)}</span>
                    </div>
                  ))}
                </div>
              </Section>

              <div className="text-[11px] leading-relaxed text-x-muted">
                Only sessions with recorded token usage are included. Missing usage can make this estimate incomplete.{' '}
                {data.estimated_models?.length > 0 && (
                  <>
                    Models marked <span className="text-x-accent-ink">fallback rate</span> use a general rate because their model price is unavailable.
                  </>
                )}
              </div>
            </>
          )}
        </div>
    </Modal>
  )
}
