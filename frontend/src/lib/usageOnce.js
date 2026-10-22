// Claude Code writes one API response as several transcript rows (thinking,
// text, tool_use). Each row repeats the same `usage`, so summing every row
// counts a turn's tokens two to four times. Count usage once per API message:
// by its id when the backend passes it, else skip a row whose usage is
// identical to the row counted just before it.
export function createUsageOnceFilter() {
  const seenIds = new Set()
  let lastKey = null
  return (msg) => {
    const id = msg?.api_message_id
    if (id) {
      if (seenIds.has(id)) return false
      seenIds.add(id)
      lastKey = null
      return true
    }
    let key = null
    try { key = msg?.usage ? JSON.stringify(msg.usage) : null } catch { key = null }
    if (key && key !== '{}' && key === lastKey) return false
    lastKey = key
    return true
  }
}
