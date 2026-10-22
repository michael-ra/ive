// Text matching for "Find in session" (chat and terminal). Pure functions,
// no DOM, so they can be unit-tested; ChatFindBar / TerminalFindBar map the
// offsets back to DOM ranges or terminal cells.

export const MAX_FIND_MATCHES = 2000

/**
 * Case-insensitive, non-overlapping occurrences of `query` in `text`.
 * Returns start offsets. An empty or whitespace-only query matches nothing.
 */
export function findOffsets(text, query, limit = MAX_FIND_MATCHES) {
  if (typeof text !== 'string' || typeof query !== 'string' || !query.trim()) return []
  const hay = text.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  // toLocaleLowerCase can change the length of some characters (İ → i̇);
  // offsets are only valid when it did not.
  if (hay.length !== text.length || needle.length !== query.length) return findOffsetsExact(text, query, limit)
  const out = []
  let from = 0
  while (out.length < limit) {
    const idx = hay.indexOf(needle, from)
    if (idx < 0) break
    out.push(idx)
    from = idx + needle.length
  }
  return out
}

function findOffsetsExact(text, query, limit) {
  const out = []
  let from = 0
  while (out.length < limit) {
    const idx = text.indexOf(query, from)
    if (idx < 0) break
    out.push(idx)
    from = idx + query.length
  }
  return out
}

/**
 * Matches in terminal buffer lines. `lines` is [{ text, isWrapped }] in buffer
 * order (isWrapped = continuation of the previous row, as xterm reports it).
 * Wrapped rows are joined so a word broken across the right edge is found.
 * Returns [{ row, col, length }] where row/col is the first cell of the match
 * (col counts characters of translateToString, which equals cells for
 * single-width text).
 */
export function findInTerminalLines(lines, query, limit = MAX_FIND_MATCHES) {
  if (!Array.isArray(lines) || !query || !query.trim()) return []
  const out = []
  let i = 0
  while (i < lines.length && out.length < limit) {
    // Collect one logical line: row i plus following wrapped rows.
    const rows = [i]
    let text = lines[i]?.text || ''
    let j = i + 1
    while (j < lines.length && lines[j]?.isWrapped) {
      rows.push(j)
      text += lines[j].text || ''
      j++
    }
    if (text) {
      // Row starts inside the joined text, to map offsets back to rows.
      const starts = []
      let acc = 0
      for (const r of rows) { starts.push(acc); acc += (lines[r].text || '').length }
      for (const off of findOffsets(text, query, limit - out.length)) {
        let k = starts.length - 1
        while (k > 0 && starts[k] > off) k--
        out.push({ row: rows[k], col: off - starts[k], length: query.length })
      }
    }
    i = j
  }
  return out
}

/** Index of the first match at or after the anchor (row, col); wraps to 0. */
export function firstMatchFrom(matches, row, col = 0) {
  if (!matches.length) return -1
  const idx = matches.findIndex((m) => m.row > row || (m.row === row && m.col >= col))
  return idx < 0 ? 0 : idx
}

/** Step through `count` matches with wrap-around. */
export function stepIndex(index, count, direction) {
  if (!count) return -1
  if (index < 0) return direction < 0 ? count - 1 : 0
  return (index + (direction < 0 ? -1 : 1) + count) % count
}

/** "3 of 12", "No matches", "" (no query yet), "2000+ …" when capped. */
export function formatFindStatus(query, count, index, capped = false) {
  if (!query || !query.trim()) return ''
  if (!count) return 'No matches'
  const total = capped ? `${count}+` : String(count)
  return `${index >= 0 ? index + 1 : 0} of ${total}`
}
