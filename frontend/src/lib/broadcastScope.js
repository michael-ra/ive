// The visible scope is the authority for sending and saving recipients. A stale
// selection or a saved global group must not reach hidden/closed sessions.
export function getBroadcastRecipients(selected, scopedTabs, openTabs, sessions) {
  const open = new Set(openTabs || [])
  return [...new Set(scopedTabs || [])].filter((id) => (
    Boolean(selected?.[id]) && open.has(id) && Boolean(sessions?.[id])
  ))
}
