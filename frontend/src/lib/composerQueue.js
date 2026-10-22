// Composer queue: messages typed while a Claude/Codex session works.
//
// Like Claude Code / Codex: Enter while the agent works does not block, the
// message waits in this session's queue and goes out at the next turn end.
//
//   queued     waits for the turn end (removable, editable)
//   sending    being typed into the CLI through the acknowledged input
//              endpoint (POST /sessions/:id/input)
//   sent       the CLI took it; waiting for the transcript to show it
//   delivered  the transcript shows it (row dropped a moment later)
//   failed     not taken, or not sure it was: never resent on its own
//   unconfirmed taken by the CLI, but the transcript never showed it
//
// Rules:
//   - The queue belongs to its session id (persisted in localStorage, survives
//     session switches and reloads). Delivery always targets that id.
//   - Delivery only when the socket is up and the session is observed idle
//     (status "Ready", not "Needs you"), idle for SETTLE_MS, and after an
//     earlier send its turn was seen working, or SEND_GAP_MS passed. The
//     backend checks readiness once more (ready_timeout) and answers 409 busy
//     instead of typing into a running turn.
//   - All queued messages of a session go out together as one prompt (Claude
//     Code merges queued messages the same way; side chat does too).
//   - Stop / interrupt, a session exit or a delivery error pause the queue
//     until the user presses "Send queued now".
//   - A send whose outcome is unknown (network error, page closed mid-send) is
//     checked against the transcript; if it is not there it becomes "failed"
//     and waits for the user. Nothing is ever sent twice automatically.
import useStore from '../state/store'
import { api } from './api'
import { getSessionDisplayStatus } from './sessionStatus'
import { prepareCommandForDelivery } from './terminal'

export const QUEUE_STORAGE_KEY = 'ive-composer-queue-v1'
export const DRAFT_STORAGE_KEY = 'ive-composer-drafts-v1'
export const QUEUE_CLIS = new Set(['claude', 'codex'])

const timing = {
  SETTLE_MS: 1200,      // idle must hold this long before a delivery
  SEND_GAP_MS: 12000,   // after a send: wait for its turn, or this long
  CONFIRM_POLL_MS: 1500,
  CONFIRM_TIMEOUT_MS: 90000,
  UNCERTAIN_TIMEOUT_MS: 20000,
  DELIVERED_LINGER_MS: 4000,
  TICK_MS: 500,
}
export function setQueueTiming(patch) { Object.assign(timing, patch) }

let state = {}            // sessionId -> { items: [], hold: null | { reason, message, at } }
const listeners = new Set()
const runtime = new Map() // sessionId -> { idleSince, lastSendAt, sawWorkSinceSend, tone }
const inFlight = new Set()
const confirming = new Set()
let started = false
const unsubscribers = []
let epoch = 0 // bumped by the test reset so old loops stop
let tickTimer = null
const EMPTY = Object.freeze({ items: Object.freeze([]), hold: null })

const now = () => Date.now()
const newId = () => (globalThis.crypto?.randomUUID?.() || `${now()}-${Math.random().toString(36).slice(2)}`)

function storage() {
  try { return globalThis.localStorage || null } catch { return null }
}
function readStored() {
  try {
    const raw = storage()?.getItem(QUEUE_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}
function writeStored() {
  try {
    const compact = Object.fromEntries(Object.entries(state).filter(([, q]) => q.items.length || q.hold))
    storage()?.setItem(QUEUE_STORAGE_KEY, JSON.stringify(compact))
  } catch { /* memory only */ }
}
function emit() { for (const fn of listeners) { try { fn() } catch { /* listener bug */ } } }

// Every change goes through here: fresh copy from storage first, so a second
// tab's change is not overwritten, then persist and notify.
function mutate(sessionId, fn) {
  const fromDisk = readStored()
  if (Object.keys(fromDisk).length || storage()) state = { ...fromDisk, ...pickLocalOnly(fromDisk) }
  const current = state[sessionId] || { items: [], hold: null }
  const next = fn({ items: current.items.map((i) => ({ ...i })), hold: current.hold ? { ...current.hold } : null })
  if (!next) return
  state = { ...state, [sessionId]: { items: next.items, hold: next.hold || null } }
  writeStored()
  emit()
}
// Sessions only in memory (storage unavailable) must not vanish on mutate.
function pickLocalOnly(fromDisk) {
  if (storage()) return {}
  return Object.fromEntries(Object.entries(state).filter(([sid]) => !(sid in fromDisk)))
}

export function getQueue(sessionId) {
  return state[sessionId] || EMPTY
}
export function subscribeQueue(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function queueSupported(session) {
  return !!session && QUEUE_CLIS.has(session.cli_type || 'claude') && !session.read_only
}
export function hasPendingQueue(sessionId) {
  return getQueue(sessionId).items.some((i) => i.state === 'queued' || i.state === 'sending' || i.state === 'failed')
}

// ── user actions ──────────────────────────────────────────────────────────
// `text` is what the CLI gets. Optional `extra.body` (the typed part without
// the context block) and `extra.context` (chips) let the row show and Edit
// restore what the user composed instead of the raw context block.
export function enqueueMessage(sessionId, text, extra = {}) {
  const clean = String(text || '').trim()
  if (!sessionId || !clean) return null
  const item = { id: newId(), text: clean, state: 'queued', createdAt: now() }
  if (extra?.context?.length) {
    item.context = extra.context
    item.body = String(extra.body || '').trim()
  }
  mutate(sessionId, (q) => ({ ...q, items: [...q.items, item] }))
  ensureStarted()
  scheduleTick(0)
  return item.id
}

export function removeQueued(sessionId, itemId) {
  mutate(sessionId, (q) => {
    const item = q.items.find((i) => i.id === itemId)
    // A message being typed into the CLI right now cannot be taken back.
    if (!item || item.state === 'sending') return null
    const items = q.items.filter((i) => i.id !== itemId)
    return { items, hold: items.some((i) => i.state === 'queued' || i.state === 'failed') ? q.hold : null }
  })
}

// Back into the composer for editing (on top of what is typed there now).
export function editQueued(sessionId, itemId) {
  const item = getQueue(sessionId).items.find((i) => i.id === itemId)
  if (!item || !['queued', 'failed'].includes(item.state)) return false
  removeQueued(sessionId, itemId)
  const store = useStore.getState()
  const draft = String(store.sessionInputs?.[sessionId] || '').trim()
  // With chips the context goes back as chips (the caller restores them), not as raw text.
  const back = item.context?.length ? item.body || '' : item.text
  store.setSessionInput?.(sessionId, draft && back ? `${back}\n\n${draft}` : back || draft)
  return true
}

// Lift a pause (after Stop / failure / exit) and send when the session is idle.
export function sendQueuedNow(sessionId) {
  mutate(sessionId, (q) => ({
    hold: null,
    items: q.items.map((i) => (i.state === 'failed' ? { ...i, state: 'queued', error: null } : i)),
  }))
  const rt = rtOf(sessionId)
  rt.sawWorkSinceSend = true // the user decided: no need to wait out SEND_GAP_MS
  rt.forceSettle = true
  scheduleTick(0)
}

export function holdQueue(sessionId, reason, message) {
  if (!getQueue(sessionId).items.some((i) => i.state === 'queued')) return
  mutate(sessionId, (q) => ({ ...q, hold: { reason, message: message || '', at: now() } }))
}

// ChatPanel sent a prompt directly: the next queued one waits for that turn.
export function noteDirectSend(sessionId) {
  const rt = rtOf(sessionId)
  rt.lastSendAt = now()
  rt.sawWorkSinceSend = false
}

// ── delivery ──────────────────────────────────────────────────────────────
function rtOf(sessionId) {
  let rt = runtime.get(sessionId)
  if (!rt) { rt = { idleSince: null, lastSendAt: 0, sawWorkSinceSend: true, tone: null }; runtime.set(sessionId, rt) }
  return rt
}

function socketUp() {
  const s = useStore.getState()
  const ws = s.ws
  const open = typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1
  return !!s.connected && !!ws && ws.readyState === open
}

function observe() {
  const s = useStore.getState()
  for (const sid of Object.keys(state)) {
    const session = s.sessions?.[sid]
    const rt = rtOf(sid)
    if (!session) { rt.tone = null; rt.idleSince = null; continue }
    const tone = getSessionDisplayStatus(session, s.sessionStarted || {}).tone
    if (tone === 'working' && rt.lastSendAt) rt.sawWorkSinceSend = true
    if (tone === 'ready') {
      if (rt.tone !== 'ready' || rt.idleSince == null) rt.idleSince = now()
    } else {
      rt.idleSince = null
    }
    // The process went away with messages still waiting: never auto-send
    // them into a fresh start; the user decides after restarting.
    if ((tone === 'offline' || tone === 'error' || tone === 'auth') && !getQueue(sid).hold) {
      holdQueue(sid, 'offline', 'The session stopped.')
    }
    rt.tone = tone
  }
}

function canDeliver(sessionId, { claimed = false } = {}) {
  const q = getQueue(sessionId)
  if (q.hold || !q.items.some((i) => i.state === 'queued')) return false
  if (q.items.some((i) => i.state === 'sending')) return false
  if ((!claimed && inFlight.has(sessionId)) || !socketUp()) return false
  const session = useStore.getState().sessions?.[sessionId]
  if (!queueSupported(session) || session.pty_alive === false) return false
  const rt = rtOf(sessionId)
  if (rt.tone !== 'ready' || rt.idleSince == null) return false
  if (!rt.forceSettle && now() - rt.idleSince < timing.SETTLE_MS) return false
  if (!rt.sawWorkSinceSend && now() - rt.lastSendAt < timing.SEND_GAP_MS) return false
  return true
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}
function rowText(row) {
  const c = row?.content
  if (typeof c === 'string') {
    const t = c.trim()
    if (t.startsWith('[') || t.startsWith('{')) {
      try { return rowText({ content: JSON.parse(t) }) } catch { return c }
    }
    return c
  }
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n')
  return ''
}
function rowPos(row) {
  const m = /^msg-(\d+)$/.exec(String(row?.id || ''))
  return m ? Number(m[1]) : null
}
function generationOf(cursor) {
  const m = /^(\d+):/.exec(String(cursor || ''))
  return m ? m[1] : null
}

async function transcriptBaseline(sessionId) {
  const data = await api.getMessages(sessionId, '', { tail: 1 })
  return { total: Number(data?.total ?? 0), generation: generationOf(data?.cursor) }
}

function matchesSent(row, item) {
  if (!row || !['user', 'human'].includes(String(row.role || '').toLowerCase())) return false
  const got = normalizeText(rowText(row))
  const want = normalizeText(item.sentText)
  if (!got || !want) return false
  const head = want.slice(0, 160)
  return got === want || got.includes(head) || (got.length >= 12 && want.includes(got))
}

function isNewRow(row, item) {
  const pos = rowPos(row)
  const base = item.baseline
  if (base && pos != null && base.generation && base.generation === item.seenGeneration) return pos >= base.total
  const at = Date.parse(row?.created_at || '')
  return Number.isFinite(at) ? at >= (item.dispatchedAt || 0) - 5000 : false
}

async function confirmSent(sessionId) {
  if (confirming.has(sessionId)) return
  confirming.add(sessionId)
  const myEpoch = epoch
  try {
    while (myEpoch === epoch) {
      const waiting = getQueue(sessionId).items.filter((i) => i.state === 'sent')
      if (!waiting.length) return
      if (socketUp()) {
        let data = null
        try { data = await api.getMessages(sessionId, '', { tail: 40 }) } catch { data = null }
        if (data?.rows) {
          const generation = generationOf(data.cursor)
          const confirmedBatches = new Set()
          for (const item of waiting) {
            const probe = { ...item, seenGeneration: generation }
            if (data.rows.some((row) => isNewRow(row, probe) && matchesSent(row, probe))) confirmedBatches.add(item.batch)
          }
          if (confirmedBatches.size) {
            mutate(sessionId, (q) => ({
              ...q,
              items: q.items.map((i) => (i.state === 'sent' && confirmedBatches.has(i.batch)
                ? { ...i, state: 'delivered', confirmedAt: now(), uncertain: false }
                : i)),
            }))
            setTimeout(() => dropDelivered(sessionId), timing.DELIVERED_LINGER_MS)
          }
        }
      }
      const t = now()
      const expired = getQueue(sessionId).items.filter((i) => i.state === 'sent' &&
        t - (i.dispatchedAt || 0) > (i.uncertain ? timing.UNCERTAIN_TIMEOUT_MS : timing.CONFIRM_TIMEOUT_MS))
      if (expired.length) {
        const ids = new Set(expired.map((i) => i.id))
        mutate(sessionId, (q) => ({
          hold: q.items.some((i) => ids.has(i.id) && i.uncertain)
            ? { reason: 'failed', message: 'Not sure the last message arrived.', at: now() }
            : q.hold,
          items: q.items.map((i) => (!ids.has(i.id) ? i : i.uncertain
            ? { ...i, state: 'failed', error: 'IVE lost the connection while sending and the transcript does not show it. Check the terminal, then send again or remove it.' }
            : { ...i, state: 'unconfirmed' })),
        }))
      }
      await new Promise((r) => setTimeout(r, timing.CONFIRM_POLL_MS))
    }
  } finally {
    confirming.delete(sessionId)
  }
}

function dropDelivered(sessionId) {
  const t = now()
  if (!getQueue(sessionId).items.some((i) => i.state === 'delivered' && t - (i.confirmedAt || 0) >= timing.DELIVERED_LINGER_MS - 50)) return
  mutate(sessionId, (q) => ({
    ...q,
    items: q.items.filter((i) => !(i.state === 'delivered' && t - (i.confirmedAt || 0) >= timing.DELIVERED_LINGER_MS - 50)),
  }))
}

async function withLock(sessionId, fn) {
  const locks = globalThis.navigator?.locks
  if (!locks?.request) return fn()
  return locks.request(`ive-composer-queue:${sessionId}`, { ifAvailable: true }, async (lock) => (lock ? fn() : undefined))
}

async function deliver(sessionId) {
  if (inFlight.has(sessionId)) return
  inFlight.add(sessionId)
  try {
    await withLock(sessionId, async () => {
      // Re-read under the lock: another tab may have taken the batch.
      state = { ...state, ...readStored() }
      if (!canDeliver(sessionId, { claimed: true })) return
      const batchId = newId()
      const dispatchedAt = now()
      let batch = []
      mutate(sessionId, (q) => {
        batch = q.items.filter((i) => i.state === 'queued')
        if (!batch.length) return null
        const ids = new Set(batch.map((i) => i.id))
        return { ...q, items: q.items.map((i) => (ids.has(i.id) ? { ...i, state: 'sending', batch: batchId, dispatchedAt, error: null } : i)) }
      })
      if (!batch.length) return
      const ids = new Set(batch.map((i) => i.id))
      const backToQueue = (hold = null) => mutate(sessionId, (q) => ({
        hold: hold || q.hold,
        items: q.items.map((i) => (ids.has(i.id) ? { ...i, state: 'queued', batch: null, dispatchedAt: null } : i)),
      }))
      const fail = (error, hold) => mutate(sessionId, (q) => ({
        hold: hold || { reason: 'failed', message: error, at: now() },
        items: q.items.map((i) => (ids.has(i.id) ? { ...i, state: 'failed', error } : i)),
      }))

      let baseline
      try { baseline = await transcriptBaseline(sessionId) } catch { backToQueue(); return }

      const text = batch.map((i) => i.text).join('\n\n')
      const prepared = prepareCommandForDelivery(sessionId, text)
      if (prepared.isRalph) {
        mutate(sessionId, (q) => ({ ...q, items: q.items.map((i) => (ids.has(i.id) ? { ...i, state: 'delivered', confirmedAt: now() } : i)) }))
        setTimeout(() => dropDelivered(sessionId), timing.DELIVERED_LINGER_MS)
        return
      }
      if (prepared.researchReady) {
        const research = await prepared.researchReady
        if (research.error) { fail(`Research could not start: ${research.error.message || 'request rejected'}`); return }
      }
      // Still the same idle session on a live socket after the awaits?
      if (!socketUp() || rtOf(sessionId).tone !== 'ready') { backToQueue(); return }

      try {
        const result = await api.sendSessionInput(sessionId, prepared.processed, { ready_timeout: 8 })
        if (!result?.ok || result.intercepted) {
          fail(result?.message || 'The assistant did not accept this message.')
          return
        }
      } catch (err) {
        const status = err?.status
        const body = err?.body || {}
        if (status === 409 && body.state === 'busy') {
          // Nothing was typed: the agent is still busy. Wait for the next idle.
          const rt = rtOf(sessionId)
          rt.idleSince = null
          rt.forceSettle = false
          backToQueue()
          return
        }
        if (status === 409 && body.startup_blocker) {
          backToQueue({ reason: 'failed', message: body.startup_blocker.label || 'The CLI shows a startup prompt.', at: now() })
          return
        }
        if (status === 503 && body.partial) {
          fail('The text was typed but not submitted. Check the terminal before sending it again.')
          return
        }
        if (status) {
          backToQueue({ reason: 'failed', message: body.error || err.message || `HTTP ${status}`, at: now() })
          return
        }
        // No answer at all (connection dropped): maybe typed, maybe not.
        // Check the transcript, never resend on our own.
        mutate(sessionId, (q) => ({
          ...q,
          items: q.items.map((i) => (ids.has(i.id) ? { ...i, state: 'sent', uncertain: true, sentText: prepared.processed, baseline } : i)),
        }))
        confirmSent(sessionId)
        return
      }

      const rt = rtOf(sessionId)
      rt.lastSendAt = now()
      rt.sawWorkSinceSend = false
      rt.forceSettle = false
      mutate(sessionId, (q) => ({
        ...q,
        items: q.items.map((i) => (ids.has(i.id) ? { ...i, state: 'sent', sentAt: now(), sentText: prepared.processed, baseline } : i)),
      }))
      // Same bubble a direct send shows until the transcript row arrives.
      const store = useStore.getState()
      store.addOptimisticMessage?.(sessionId, {
        id: `optimistic-queue-${batchId}`,
        session_id: sessionId,
        role: 'user',
        content: text,
        match_text: prepared.processed !== text ? prepared.processed : undefined,
        created_at: new Date().toISOString(),
        local_created_at: now(),
      })
      store.setLastSentPrompt?.(sessionId, prepared.processed)
      try { window.dispatchEvent(new CustomEvent('cc-session-messages-refresh', { detail: { sessionId } })) } catch { /* no DOM */ }
      confirmSent(sessionId)
    })
  } finally {
    inFlight.delete(sessionId)
  }
}

function tick() {
  tickTimer = null
  observe()
  let busy = false
  for (const [sid, q] of Object.entries(state)) {
    if (q.items.some((i) => i.state === 'queued' || i.state === 'sending')) busy = true
    if (q.items.some((i) => i.state === 'sent')) confirmSent(sid)
    if (canDeliver(sid)) deliver(sid)
  }
  if (busy) scheduleTick(timing.TICK_MS)
}
function scheduleTick(ms) {
  if (tickTimer != null && ms > 0) return
  if (tickTimer != null) clearTimeout(tickTimer)
  tickTimer = setTimeout(tick, ms)
}

// ── drafts per session survive a reload ───────────────────────────────────
let draftTimer = null
let lastDrafts = null
function persistDrafts(inputs) {
  if (inputs === lastDrafts) return
  lastDrafts = inputs
  if (draftTimer) clearTimeout(draftTimer)
  draftTimer = setTimeout(() => {
    try {
      const kept = Object.fromEntries(Object.entries(inputs || {}).filter(([, v]) => String(v || '').trim()))
      storage()?.setItem(DRAFT_STORAGE_KEY, JSON.stringify(kept))
    } catch { /* memory only */ }
  }, 300)
}
function restoreDrafts() {
  try {
    const saved = JSON.parse(storage()?.getItem(DRAFT_STORAGE_KEY) || '{}')
    const current = useStore.getState().sessionInputs || {}
    const missing = Object.fromEntries(Object.entries(saved || {}).filter(([sid, v]) => typeof v === 'string' && v.trim() && !String(current[sid] || '').trim()))
    if (Object.keys(missing).length) useStore.setState((s) => ({ sessionInputs: { ...s.sessionInputs, ...missing } }))
  } catch { /* nothing saved */ }
}

// A page closed or reloaded mid-send left "sending" rows behind: their
// outcome is unknown, so they are checked against the transcript.
function recoverInterrupted() {
  for (const [sid, q] of Object.entries(state)) {
    if (!q.items.some((i) => i.state === 'sending')) continue
    mutate(sid, (cur) => ({
      ...cur,
      items: cur.items.map((i) => (i.state === 'sending'
        ? { ...i, state: 'sent', uncertain: true, sentText: i.sentText || i.text, dispatchedAt: i.dispatchedAt || now() }
        : i)),
    }))
  }
}

export function ensureStarted() {
  if (started) return
  started = true
  state = readStored()
  recoverInterrupted()
  restoreDrafts()
  unsubscribers.push(useStore.subscribe((s, prev) => {
    if (s.sessionInputs !== prev?.sessionInputs) persistDrafts(s.sessionInputs)
    if (s.sessions !== prev?.sessions || s.connected !== prev?.connected || s.ws !== prev?.ws) {
      observe()
      scheduleTick(0)
    }
  }))
  if (typeof window !== 'undefined' && window.addEventListener) {
    const on = (name, fn) => {
      window.addEventListener(name, fn)
      unsubscribers.push(() => window.removeEventListener(name, fn))
    }
    // Stop / Esc from IVE: the user cancelled, so the queue waits for them.
    on('cc-session-interrupted', (e) => {
      const sid = e.detail?.sessionId
      if (sid) holdQueue(sid, 'stopped', 'You stopped the agent.')
    })
    on('cc-websocket-reconnected', () => scheduleTick(0))
    on('storage', (e) => {
      if (e.key !== QUEUE_STORAGE_KEY) return
      state = readStored()
      emit()
      scheduleTick(0)
    })
  }
  observe()
  scheduleTick(0)
}

// Tests only. keepStorage simulates a page reload (what was persisted stays).
export function __resetComposerQueue({ keepStorage = false } = {}) {
  for (const off of unsubscribers.splice(0)) off()
  epoch += 1
  started = false
  state = {}
  runtime.clear()
  inFlight.clear()
  confirming.clear()
  if (tickTimer != null) clearTimeout(tickTimer)
  tickTimer = null
  if (!keepStorage) {
    try { storage()?.removeItem(QUEUE_STORAGE_KEY) } catch { /* ignore */ }
  }
}

// The app starts delivering at load, not only once a chat panel mounts: a
// queue persisted before a reload must go out even from the terminal view.
if (typeof document !== 'undefined') ensureStarted()
