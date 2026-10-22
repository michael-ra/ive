import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'

// "You were away for a while: n things happened." The last-seen stamp lives
// in localStorage; after 30 minutes the digest is fetched once (no LLM call)
// and shown as a dot badge on Board; open() shows the full CatchUpPanel.
const SEEN_KEY = 'cc-last-seen-v1'
const STALE_MS = 30 * 60 * 1000
const DIGEST_LIMIT = 200

function readLastSeen() {
  try {
    const v = localStorage.getItem(SEEN_KEY)
    return v ? parseInt(v, 10) : 0
  } catch {
    return 0
  }
}

export function touchLastSeen() {
  try {
    localStorage.setItem(SEEN_KEY, String(Date.now()))
  } catch { /* privacy mode */ }
}

export function isLastSeenStale(now = Date.now()) {
  const lastSeen = readLastSeen()
  return !lastSeen || now - lastSeen > STALE_MS
}

export async function loadCatchUpDigest({ now = Date.now(), llm = false } = {}) {
  const lastSeen = readLastSeen()
  const since = lastSeen ? new Date(lastSeen).toISOString() : new Date(now - 24 * 60 * 60 * 1000).toISOString()
  const model = await api.getAppSetting('catchup_model').then((res) => res?.value || 'claude:haiku').catch(() => 'claude:haiku')
  return api.getCatchup({ since, limit: DIGEST_LIMIT, model, llm })
}

export default function useCatchUp() {
  const [digest, setDigest] = useState(null)

  useEffect(() => {
    if (!isLastSeenStale()) return undefined
    let cancelled = false
    loadCatchUpDigest()
      .then((d) => {
        if (cancelled) return
        if (d?.total_events > 0) setDigest(d)
        touchLastSeen()
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const open = useCallback(() => {
    touchLastSeen()
    setDigest(null)
    window.dispatchEvent(new CustomEvent('open-panel', { detail: 'catch-up' }))
  }, [])

  const dismiss = useCallback(() => {
    touchLastSeen()
    setDigest(null)
  }, [])

  const count = Number(digest?.total_events) || 0
  return { stale: count > 0, count, digest, open, dismiss }
}
