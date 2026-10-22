const KEY_PREFIX = 'ive:recent-annotations:'
const MAX_RECENT_ANNOTATIONS = 40

export function annotationScopeKey(workspaceId) {
  return `${KEY_PREFIX}${workspaceId || 'global'}`
}

export function loadRecentAnnotations(workspaceId) {
  try {
    const raw = localStorage.getItem(annotationScopeKey(workspaceId))
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.filter((item) => item?.quote) : []
  } catch {
    return []
  }
}

export function saveRecentAnnotations(workspaceId, annotations) {
  const clean = Array.isArray(annotations) ? annotations.filter((item) => item?.quote) : []
  localStorage.setItem(
    annotationScopeKey(workspaceId),
    JSON.stringify(clean.slice(0, MAX_RECENT_ANNOTATIONS))
  )
  window.dispatchEvent(new CustomEvent('cc-annotations-updated', { detail: { workspaceId } }))
}

export function addRecentAnnotations(workspaceId, annotations, meta = {}) {
  const incoming = (Array.isArray(annotations) ? annotations : [annotations])
    .filter((item) => item?.quote)
    .map((item) => ({
      id: item.id || `ann-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      quote: item.quote,
      note: item.note || '',
      role: item.role || item.roleLabel || '',
      roleLabel: item.roleLabel || item.role || '',
      sourceLabel: item.sourceLabel || item.roleLabel || item.role || '',
      createdAt: item.createdAt || new Date().toISOString(),
      ...meta,
    }))

  if (!incoming.length) return loadRecentAnnotations(workspaceId)

  const existing = loadRecentAnnotations(workspaceId)
  const seen = new Set()
  const next = []
  for (const item of [...incoming, ...existing]) {
    const key = `${item.quote}\n${item.note || ''}\n${item.sourceLabel || item.roleLabel || item.role || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    next.push(item)
  }
  saveRecentAnnotations(workspaceId, next)
  return next.slice(0, MAX_RECENT_ANNOTATIONS)
}
