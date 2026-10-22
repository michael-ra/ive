// Incremental chat transcript polling.
//
// GET /api/sessions/{id}/messages?cursor=<c>&tail=<n> answers either a plain
// array (DB fallback, full list) or { rows, start, updates, cursor, reset,
// base, total, before }:
// - reset: rows is the list from position `base` (0, or total - tail when
//   the server left older rows out; `before` sums up those rows)
// - otherwise rows continue the list at position `start`, and `updates`
//   holds [position, row] pairs for earlier rows that changed in place.
// Positions are absolute; the client holds rows from position `base` on.
// Older rows come page by page from ?before=<generation>:<base>&limit=<n>
// (see prependOlderRows).

/**
 * Merge a messages response into the rows the client already holds.
 * Returns { rows, cursor, changed, base, before } or { refetch: true } when
 * the client state does not line up with the server cursor (ask again with
 * cursor ''). `base` is the position of rows[0]; `before` is the server's
 * summary of rows left out before it (null when nothing is left out or the
 * response did not say).
 */
export function applyMessageDelta(previous, response, previousBase = 0, previousBefore = null) {
  if (Array.isArray(response)) {
    return { rows: response, cursor: null, changed: true, base: 0, before: null }
  }
  if (!response || !Array.isArray(response.rows)) return { invalid: true }
  const cursor = typeof response.cursor === 'string' ? response.cursor : null
  if (response.reset || !Array.isArray(previous)) {
    const base = Number.isInteger(response.base) && response.base > 0 ? response.base : 0
    return { rows: response.rows, cursor, changed: true, base, before: base ? (response.before || null) : null }
  }
  const base = Number.isInteger(previousBase) && previousBase > 0 ? previousBase : 0
  const before = base ? previousBefore : null
  const start = Number(response.start)
  if (!Number.isInteger(start) || start < base || start > base + previous.length) {
    return { refetch: true }
  }
  const updates = Array.isArray(response.updates) ? response.updates : []
  const changedUpdates = updates.filter(([pos, row]) => (
    Number.isInteger(pos) && pos >= base && pos < start && !sameRow(previous[pos - base], row)
  ))
  if (!response.rows.length && !changedUpdates.length && start === base + previous.length) {
    return { rows: previous, cursor, changed: false, base, before }
  }
  const rows = previous.slice(0, start - base)
  for (const [pos, row] of changedUpdates) rows[pos - base] = row
  for (const row of response.rows) rows.push(row)
  return { rows, cursor, changed: true, base, before }
}

/** "<generation>:<count>" -> generation, or null. */
export function cursorGeneration(cursor) {
  if (typeof cursor !== 'string' || !cursor.includes(':')) return null
  return cursor.slice(0, cursor.indexOf(':'))
}

/**
 * Put a page of older rows (?before= response) in front of the held rows.
 * Returns { rows, base, before } or { stale: true } when the transcript was
 * rewritten or the page does not end where the held rows start.
 */
export function prependOlderRows(previous, base, response) {
  if (!response || response.stale || !Array.isArray(response.rows) || !Array.isArray(previous)) {
    return { stale: true }
  }
  const start = Number(response.start)
  if (!Number.isInteger(start) || start < 0 || start + response.rows.length !== base) {
    return { stale: true }
  }
  return {
    rows: [...response.rows, ...previous],
    base: start,
    before: start > 0 ? (response.before || null) : null,
  }
}

function sameRow(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return a.id === b.id && a.content === b.content && a.role === b.role
}

/**
 * Wrap an async task so at most one run is in flight; calls made while it
 * runs collapse into a single follow-up run.
 */
export function coalesce(task) {
  let running = null
  let again = false
  const run = async () => {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      try {
        do {
          again = false
          await task()
        } while (again)
      } finally {
        running = null
      }
    })()
    return running
  }
  return run
}
