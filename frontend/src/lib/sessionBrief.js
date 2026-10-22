// Presentation uses recorded evidence only; it never infers that tests passed.
export function unwrapMessage(value, depth = 0) {
  if (depth > 8) return value
  if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed) && parsed.every(p => p && ['text', 'thinking', 'tool_use', 'tool_result', 'image'].includes(p.type)) || parsed?.role && 'content' in parsed || parsed?.type === 'text') return unwrapMessage(parsed, depth + 1)
    } catch {}
    return value
  }
  if (value?.role && 'content' in value) return unwrapMessage(value.content, depth + 1)
  if (Array.isArray(value)) return value.flatMap(p => {
    if (p?.type !== 'text') return [p]
    const text = unwrapMessage(p.text, depth + 1)
    return Array.isArray(text) ? text : [{ ...p, text }]
  })
  if (value?.type === 'text') return unwrapMessage(value.text, depth + 1)
  return value
}

export function messageText(value) {
  const v = unwrapMessage(value)
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(p => p?.type === 'text' ? messageText(p.text) : '').filter(Boolean).join('\n')
  return ''
}

export function presentText(value) {
  const sources = [], context = []
  // Preserve literal examples inside fenced code. Only generated metadata outside
  // fences is moved to disclosures, and original transcript/copy stay untouched.
  const text = String(value || '').split(/(```[\s\S]*?(?:```|$))/g).map(part => {
    if (part.startsWith('```')) return part
    part = part.replace(/<oai-mem-citation>[\s\S]*?(?:<\/oai-mem-citation>|$)/g, block => {
      const entries = block.match(/<citation_entries>([\s\S]*?)(?:<\/citation_entries>|$)/)?.[1] || ''
      for (const line of entries.split('\n')) {
        const path = line.split('|note=')[0].trim()
        if (path && !path.startsWith('<')) sources.push(path)
      }
      return ''
    })
    const at = part.search(/(?:^|\n)Referenced chat annotations:\s*\n/)
    if (at !== -1) { context.push(part.slice(at).replace(/^\s*Referenced chat annotations:\s*/, '')); part = part.slice(0, at) }
    return part
  }).join('').trim()
  return { text, sources: [...new Set(sources)], context: context.join('\n') }
}

export function plainExcerpt(value, limit = 220) {
  return presentText(messageText(value)).text.replace(/```[\s\S]*?(?:```|$)/g, ' [code] ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*#`]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

export function briefEvidence(messages = []) {
  const lastUser = messages.findLastIndex(m => ['user','human'].includes(m.role) && (messageText(m.content).trim() || (Array.isArray(unwrapMessage(m.content)) && unwrapMessage(m.content).some(b=>['image','file','document'].includes(b?.type)))))
  const current = messages.slice(Math.max(0, lastUser))
  const replies = current.filter(m => ['assistant','agent'].includes(m.role) && plainExcerpt(m.content))
  const tools = new Map(), checks = [], collaboration = []
  for (const msg of current) {
    let blocks = msg.content
    if (typeof blocks === 'string') { try { blocks = JSON.parse(blocks) } catch { continue } }
    if (!Array.isArray(blocks)) blocks = blocks?.content || [blocks]
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      if (b?.type === 'tool_use') tools.set(b.id, b)
      if (b?.type !== 'tool_result') continue
      const use = tools.get(b.tool_use_id)
      if (!use) continue
      const result = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
      const failed = b.is_error || /^(?:error|failed)\b/i.test(result || '') || /"(?:success|ok)"\s*:\s*false/.test(result || '') || /"(?:error|isError)"\s*:\s*(?:true|"[^"\s])/.test(result || '')
      const cmd = String(use.input?.command || use.input?.cmd || '')
      if (/\b(?:pytest|vitest|jest|playwright|npm (?:run )?test|pnpm (?:run )?test|cargo test|go test)\b/.test(cmd)) {
        checks.push({ id: msg.id, label: use.input?.description || cmd.slice(0,120), detail: failed ? 'Tool reported an error' : 'Output recorded · review the result', failed })
      }
      if (!failed && result?.trim() && /(?:search_memory|check_messages|post_message|update_digest)$/.test(use.name || '')) {
        collaboration.push({id: msg.id, label: /post_message$/.test(use.name) ? 'Project message sent' : /update_digest$/.test(use.name) ? 'Shared project notes updated' : /check_messages$/.test(use.name) ? 'Project messages checked' : 'Project context checked'})
      }
    }
  }
  return { latest: replies.at(-1), checks: checks.slice(-5), collaboration: collaboration.slice(-3), lastUser: messages[lastUser] }
}

export function activityTime(session) {
  const raw = session?.last_used_at || session?.last_active_at || session?.last_activity_at || session?.updated_at || session?.last_message_at || session?.created_at
  if (!raw) return 0
  return typeof raw === 'number' ? (raw < 1e12 ? raw*1000 : raw) : Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : raw.replace(' ', 'T')+'Z') || 0
}
export function relativeActivity(session, now = Date.now()) {
  const at = activityTime(session); if (!at) return ''
  const min = Math.max(0, Math.floor((now-at)/60000))
  return min < 1 ? 'just now' : min < 60 ? `${min}m ago` : min < 1440 ? `${Math.floor(min/60)}h ago` : `${Math.floor(min/1440)}d ago`
}
