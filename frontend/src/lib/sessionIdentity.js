// Identity colors are separate from Ready/Working/Error status colors. A
// session keeps its pair across tab order, workspace moves, reloads and views.
export const SESSION_IDENTITY_PALETTE = [
  { name: 'blue', light: '#2457A7', dark: '#8BB6FF' },
  { name: 'violet', light: '#7143A7', dark: '#C7A2FF' },
  { name: 'teal', light: '#086A65', dark: '#64D1C4' },
  { name: 'copper', light: '#994322', dark: '#FFAD83' },
  { name: 'magenta', light: '#963873', dark: '#F0A0D0' },
  { name: 'olive', light: '#606819', dark: '#C5D779' },
  { name: 'cyan', light: '#12667F', dark: '#7AD3EF' },
  { name: 'indigo', light: '#4F53A8', dark: '#AAB0FF' },
  { name: 'bronze', light: '#805230', dark: '#DDB48C' },
  { name: 'plum', light: '#804586', dark: '#DEAFE5' },
  { name: 'emerald', light: '#216844', dark: '#7DD4AA' },
  { name: 'slate', light: '#425F6C', dark: '#A4C8D8' },
]

export const SESSION_IDENTITY_STORAGE_KEY = 'ive-session-identities-v1'

function preferredColorIndex(id) {
  // A hash gives a reproducible first choice, but cannot prevent collisions.
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619)
  return (hash >>> 0) % SESSION_IDENTITY_PALETTE.length
}

export function createSessionIdentityRegistry(storage) {
  const assignments = new Map()
  const size = SESSION_IDENTITY_PALETTE.length
  try {
    const saved = JSON.parse(storage?.getItem(SESSION_IDENTITY_STORAGE_KEY) || '{}')
    for (const [id, index] of Object.entries(saved)) {
      if (id && Number.isInteger(index) && index >= 0 && index < size) assignments.set(id, index)
    }
  } catch { /* Private browsing or corrupt storage still gets stable in-memory colors. */ }

  return (sessionOrId) => {
    const id = String(typeof sessionOrId === 'object' ? sessionOrId?.id || '' : sessionOrId || '')
    if (!id) return SESSION_IDENTITY_PALETTE[preferredColorIndex(id)]
    let index = assignments.get(id)
    if (index === undefined) {
      const usage = Array(size).fill(0)
      for (const value of assignments.values()) usage[value]++
      const leastUsed = Math.min(...usage)
      const preferred = preferredColorIndex(id)
      // Use every free color before reusing one. Beyond twelve identities,
      // reuse the least-used color; existing sessions never change color.
      for (let offset = 0; offset < size; offset++) {
        const candidate = (preferred + offset) % size
        if (usage[candidate] === leastUsed) { index = candidate; break }
      }
      assignments.set(id, index)
      try { storage?.setItem(SESSION_IDENTITY_STORAGE_KEY, JSON.stringify(Object.fromEntries(assignments))) }
      catch { /* Keep the same mapping in memory if persistence is unavailable. */ }
    }
    return SESSION_IDENTITY_PALETTE[index]
  }
}

let identityRegistry
export function getSessionIdentity(sessionOrId) {
  if (!identityRegistry) {
    let storage
    try { storage = typeof window === 'undefined' ? undefined : window.localStorage } catch { /* Browser storage may be disabled. */ }
    identityRegistry = createSessionIdentityRegistry(storage)
  }
  return identityRegistry(sessionOrId)
}

export function sessionIdentityStyle(sessionOrId) {
  const color = getSessionIdentity(sessionOrId)
  return { '--ive-session-light': color.light, '--ive-session-dark': color.dark }
}
