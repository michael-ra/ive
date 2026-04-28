// CatchUpBanner — top-of-app conditional strip that surfaces missed
// activity when the local "last seen" timestamp is stale (>30 min).
//
// The banner self-loads digest data; clicking it expands a panel via
// the parent-controlled `onOpenPanel` callback. Dismiss persists for
// the current session in localStorage.

import { useEffect, useState } from 'react'
import { api } from '../../lib/api'

const SEEN_KEY = 'cc-last-seen-v1'
const DISMISS_KEY = 'cc-catchup-dismissed-v1'
const STALE_MS = 30 * 60 * 1000

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
  } catch {}
}

export default function CatchUpBanner({ onOpenPanel }) {
  const [digest, setDigest] = useState(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const lastSeen = readLastSeen()
    const now = Date.now()
    const stale = !lastSeen || now - lastSeen > STALE_MS
    if (!stale) return

    let dismissTs = 0
    try {
      dismissTs = parseInt(sessionStorage.getItem(DISMISS_KEY) || '0', 10)
    } catch {}
    if (dismissTs && now - dismissTs < 60 * 60 * 1000) {
      setDismissed(true)
      return
    }

    const since = lastSeen
      ? new Date(lastSeen).toISOString()
      : new Date(now - 24 * 60 * 60 * 1000).toISOString()

    api
      .getCatchup({ since, limit: 200 })
      .then((d) => {
        if (cancelled) return
        if (d?.total_events > 0) setDigest(d)
        touchLastSeen()
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [])

  if (!digest || dismissed) return null

  return (
    <div className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-200">
      <span aria-hidden className="text-amber-400">●</span>
      <div className="flex-1 truncate">
        <span className="font-medium">Catch up:</span>{' '}
        <span className="text-zinc-400">{digest.summary}</span>
      </div>
      <button
        type="button"
        onClick={() => onOpenPanel?.(digest)}
        className="rounded border border-zinc-700 px-2 py-0.5 text-xs hover:bg-zinc-800"
      >
        View
      </button>
      <button
        type="button"
        onClick={() => {
          try {
            sessionStorage.setItem(DISMISS_KEY, String(Date.now()))
          } catch {}
          setDismissed(true)
        }}
        className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:text-zinc-200"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  )
}
