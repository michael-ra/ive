// Cost and token figures for cards, the session header and the sidebar foot.
// GET /api/cost parses every transcript, so it is called once per minute (and
// after a turn ends), never per card. `today` is an approximation: the sum of
// per-session cost for sessions created or active since local midnight (the
// backend has no per-day breakdown yet, backend.md 5.h.5).
import { api } from './api.js'
import { toMillis } from './sessionVocabulary.js'

export function startOfToday(now = Date.now()) {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function summarizeCosts(payload, { sessions = null, now = Date.now() } = {}) {
  const rows = Array.isArray(payload?.per_session) ? payload.per_session : []
  const estimated = new Set(Array.isArray(payload?.estimated_models) ? payload.estimated_models : [])
  const bySession = {}
  let today = sessions ? 0 : null
  const midnight = startOfToday(now)
  for (const row of rows) {
    if (!row?.session_id) continue
    const tokens = ['input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens']
      .reduce((sum, key) => sum + (Number(row[key]) || 0), 0)
    const cost = Number(row.cost_usd)
    bySession[row.session_id] = {
      cost_usd: Number.isFinite(cost) ? cost : 0,
      tokens,
      estimated: (row.models || []).some((model) => estimated.has(model)),
      at: now,
    }
    if (sessions) {
      const session = sessions[row.session_id]
      const stamps = [session?.last_active_at, session?.created_at, row.last_active_at, row.created_at].map(toMillis)
      if (stamps.some((at) => Number.isFinite(at) && at >= midnight)) today += bySession[row.session_id].cost_usd
    }
  }
  return { bySession, today }
}

// → { bySession: {[id]: {cost_usd, tokens, estimated, at}}, today }
export async function loadCosts({ persist = false, sessions = null, now = Date.now() } = {}) {
  const payload = await api.getCost({ persist })
  // Mocked backends answer [] for /cost; that means "no figures", not an error.
  return summarizeCosts(Array.isArray(payload) ? {} : payload || {}, { sessions, now })
}
