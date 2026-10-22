// Acknowledging input, tool activity, and old transcript rows are not a reply.
function answerText(content) {
  if (typeof content === 'string') {
    if (/^\s*[\[{]/.test(content)) {
      try { return answerText(JSON.parse(content)) } catch { /* Plain text. */ }
    }
    return content.trim()
  }
  if (Array.isArray(content)) return content.map(answerText).filter(Boolean).join('\n')
  if (content?.type === 'text') return String(content.text || '').trim()
  if (content?.type === 'image' || content?.type === 'image_url') return '[image]'
  return ''
}

export function beginReplyWait(message, messages = [], now = Date.now()) {
  return { startedAt: now, messageId: message.id, text: String(message.content || '').trim(), baselineIds: messages.map(row => row.id) }
}

export function hasNewReply(wait, messages = []) {
  if (!wait) return false
  const baseline = new Set(wait.baselineIds)
  let anchor = -1
  messages.forEach((row, index) => {
    if (!['user', 'human'].includes(row.role) || baseline.has(row.id)) return
    if (row.id === wait.messageId || answerText(row.content) === wait.text) anchor = index
  })
  return messages.some((row, index) => {
    if (!['assistant', 'model'].includes(row.role) || baseline.has(row.id) || !answerText(row.content)) return false
    // A confirmed user row also works with transcripts whose timestamps are
    // missing or whose clock differs. Otherwise require a freshly dated reply.
    return (anchor >= 0 && index > anchor) || Date.parse(row.created_at || '') >= wait.startedAt
  })
}
