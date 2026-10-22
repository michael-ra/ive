import { notificationSessionId } from './operatorDesk.js'

// Only group notices with identical recovery semantics. Keep action/Undo
// notifications separate so no callback or session-specific decision is lost.
export function groupNotifications(notifications) {
  const groups = [], hooks = []
  for (const notice of notifications) {
    if (notice.reason === 'codex_hooks_untrusted') hooks.push(notice)
    else groups.push({ key: notice.id, notices: [notice], kind: 'single' })
  }
  if (hooks.length) groups.push({ key: 'codex-hooks', notices: hooks, kind: 'hooks' })
  return groups.sort((a,b) => Math.max(...b.notices.map(n=>n.timestamp||0)) - Math.max(...a.notices.map(n=>n.timestamp||0)))
}

export function affectedSessions(notices, sessions) {
  return [...new Set(notices.map(notificationSessionId).filter(Boolean))].map(id=>sessions[id]).filter(Boolean)
}

export function notificationDuration(notice) {
  // Recovery/approval messages stay until acknowledged. A hidden queued
  // notification does not start its timer until it actually renders.
  if (notice.action || ['warning','error','auth_failed','plan_ready','blueprint_ready','input_needed','permission_question','permission','memory_sync_conflict','distill_error','mcp_parse_error'].includes(notice.type)) return null
  return notice.type === 'success' ? 6000 : notice.type === 'info' ? 10000 : 30000
}

// Preserve the complete message behind Details; never discard an error or path.
export function notificationPreview(message, limit = 130) {
  const text = String(message ?? '').trim()
  const flat = text.replace(/\s+/g, ' ')
  if (flat.length <= limit) return { preview: flat, detail: '' }
  const first = flat.match(/^.{12,}?[.!?](?:\s|$)/)?.[0]?.trim()
  if (first && first.length <= limit) return { preview: first, detail: text }
  const head = flat.slice(0, limit - 1)
  const boundary = head.lastIndexOf(' ')
  return { preview: `${head.slice(0, boundary > limit / 2 ? boundary : head.length)}…`, detail: text }
}
