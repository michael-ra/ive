// Context chips per session (files and folders attached to the next message).
//
// Kept like the composer draft and queue (lib/composerQueue.js): in memory
// keyed by session id, and in localStorage so they survive a reload. Only the
// reference is stored (path, size, hash), never the preview text.
//
// After a reload a chip is not trusted blindly: it comes back as "checking"
// (sending waits, like a chip that is still loading) and is checked again the
// first time its session's composer is shown. A file that is gone stays as a
// "missing" chip with the reason; it is never sent, and sending is refused
// until the user removes it, so nothing is dropped silently.

export const CONTEXT_STORAGE_KEY = 'ive-composer-context-v1'

const chipsBySession = new Map()
const listeners = new Set()
const EMPTY = Object.freeze([])
const checking = new Set() // session ids whose restored chips are being checked

function storage() {
  try { return globalThis.localStorage || null } catch { return null }
}

/** The part of a chip worth keeping across a reload. */
export function storableChip(chip) {
  if (!chip?.key || !(chip.path || chip.absPath)) return null
  if (chip.status === 'uploading' || String(chip.key).startsWith('pending:')) return null
  const { key, source, kind, path, absPath, name, size, sha256 } = chip
  return { key, source, kind, path, absPath, name, size, sha256 }
}

function persist() {
  try {
    const out = {}
    for (const [sid, chips] of chipsBySession) {
      const kept = chips.map(storableChip).filter(Boolean)
      if (kept.length) out[sid] = kept
    }
    if (Object.keys(out).length) storage()?.setItem(CONTEXT_STORAGE_KEY, JSON.stringify(out))
    else storage()?.removeItem(CONTEXT_STORAGE_KEY)
  } catch { /* memory only */ }
}

/** Parse what a previous page left behind; restored chips wait for a check. */
export function parseStoredChips(raw) {
  let parsed
  try { parsed = raw ? JSON.parse(raw) : {} } catch { return {} }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out = {}
  for (const [sid, list] of Object.entries(parsed)) {
    if (!Array.isArray(list)) continue
    const chips = list.map(storableChip).filter(Boolean).map((c) => ({ ...c, status: 'checking', restored: true }))
    if (chips.length) out[sid] = chips
  }
  return out
}

function restore() {
  const saved = parseStoredChips(storage()?.getItem?.(CONTEXT_STORAGE_KEY))
  for (const [sid, chips] of Object.entries(saved)) {
    if (!chipsBySession.has(sid)) chipsBySession.set(sid, chips)
  }
}

export function getChips(sessionId) { return chipsBySession.get(sessionId) || EMPTY }

export function setChips(sessionId, update) {
  if (!sessionId) return
  const next = typeof update === 'function' ? update(getChips(sessionId)) : update
  if (next.length) chipsBySession.set(sessionId, next)
  else chipsBySession.delete(sessionId)
  persist()
  listeners.forEach((fn) => fn())
}

export function subscribeChips(fn) { listeners.add(fn); return () => listeners.delete(fn) }

/** Chips that can't be sent: their file or folder is gone. */
export const missingChips = (chips) => (chips || []).filter((c) => c.status === 'missing')

/** Readable reason sending is refused, or '' when it may go. */
export function missingContextMessage(chips) {
  const gone = missingChips(chips)
  if (!gone.length) return ''
  const names = gone.map((c) => (c.source === 'upload' ? c.name : c.path)).join(', ')
  return `${names} ${gone.length === 1 ? 'is' : 'are'} no longer there. Remove ${gone.length === 1 ? 'it' : 'them'} from the context, then send again.`
}

/**
 * Check the chips restored after a reload for one session. `inspect(chip)`
 * resolves to the backend's inspect answer or throws (the error's message is
 * shown on the chip).
 */
export async function checkRestoredChips(sessionId, inspect) {
  if (!sessionId || checking.has(sessionId)) return
  const todo = getChips(sessionId).filter((c) => c.restored)
  if (!todo.length) return
  checking.add(sessionId)
  try {
    await Promise.all(todo.map(async (chip) => {
      let patch
      try {
        const info = await inspect(chip)
        if (info?.status && info.status !== 'ok') throw new Error(info.reason || 'unsupported file')
        patch = {
          status: 'ok', size: info?.size ?? chip.size,
          ...(chip.source === 'upload' ? {} : { kind: info?.kind || chip.kind, absPath: info?.abs_path }),
          preview: info?.preview, previewTruncated: info?.preview_truncated, children: info?.children, more: info?.more,
        }
      } catch (err) {
        patch = { status: 'missing', error: err?.body?.error || err?.message || 'could not be checked' }
      }
      setChips(sessionId, (prev) => prev.map((c) => (c.key === chip.key && c.restored ? { ...c, ...patch, restored: false } : c)))
    }))
  } finally {
    checking.delete(sessionId)
  }
}

// Tests only: forget memory; keepStorage simulates a reload.
export function __resetContextChips({ keepStorage = false } = {}) {
  chipsBySession.clear()
  checking.clear()
  if (!keepStorage) { try { storage()?.removeItem(CONTEXT_STORAGE_KEY) } catch { /* ignore */ } }
  restore()
  listeners.forEach((fn) => fn())
}

restore()
