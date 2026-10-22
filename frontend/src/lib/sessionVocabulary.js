// The one place that turns backend/store state into what the user reads:
// five status words (Running / Waiting / Done / Failed / Stopped), a short
// detail, the activity line ("Editing src/x.ts"), relative times, runtime,
// token and cost formatting. Pure functions, no network. Screens, board
// cards and the sidebar all import from here so every place says the same.
import { getSessionDisplayStatus, isShellSession } from './sessionStatus.js'
import { t } from './i18n.js'
import './i18n/shell.js'

export const SESSION_STATES = ['running', 'waiting', 'done', 'failed', 'stopped']

// Tailwind aliases of the status tokens (--x-running …, A.5). Tailwind only
// emits them once the tokens exist in index.css; the old shell keeps using
// getSessionDisplayStatus() and its accent/warning/good classes.
const STATE_CLASSES = {
  running: { dotClass: 'bg-x-running animate-subtle-pulse', textClass: 'text-x-running' },
  waiting: { dotClass: 'bg-x-waiting', textClass: 'text-x-waiting' },
  done: { dotClass: 'bg-x-done', textClass: 'text-x-done' },
  failed: { dotClass: 'bg-x-failed', textClass: 'text-x-failed' },
  stopped: { dotClass: 'bg-x-stopped', textClass: 'text-x-stopped' },
}

const BLOCKER_LABELS = {
  trust_required: 'Trust this folder', auth_required: 'Login required', auth_error: 'Login failed',
  setup_required: 'Setup required', update_required: 'Update required',
}

function exitCodeOf(session) {
  const raw = session?.exit_code ?? session?.exit?.code ?? session?.last_exit_code
  if (raw === null || raw === undefined || raw === '') return null
  const code = Number(raw)
  if (!Number.isFinite(code)) return String(raw)
  // 128 + n is the usual "killed by signal n" convention.
  const signals = { 137: 'SIGKILL', 143: 'SIGTERM', 130: 'SIGINT', 134: 'SIGABRT', 139: 'SIGSEGV' }
  return signals[code] || `code ${code}`
}

function detailOf(session, meta) {
  if (!session || isShellSession(session)) return ''
  switch (meta.tone) {
    case 'replaying': return t('status.replaying')
    case 'waiting': {
      if (session.attention?.title) return session.attention.title
      const blocker = session.startup_blocker
      if (blocker) return blocker.label || BLOCKER_LABELS[blocker.type] || t('status.waiting')
      return ''
    }
    case 'not-started': return t('status.notStarted')
    case 'offline': return t('status.stoppedByYou')
    case 'error': {
      const code = exitCodeOf(session)
      return code ? t('status.cliExitedCode', { code }) : t('status.cliExited')
    }
    case 'auth': return t('status.loginExpired')
    case 'ready': return session.last_turn_error ? t('status.lastTurnFailed') : ''
    default: return ''
  }
}

// → { state, label, detail, dotClass, textClass, isWorking, tone }
export function sessionStateOf(session, sessionStarted = {}) {
  const meta = getSessionDisplayStatus(session, sessionStarted)
  const state = SESSION_STATES.includes(meta.state) ? meta.state : 'stopped'
  return {
    state,
    label: t(`status.${state}`),
    detail: detailOf(session, meta),
    ...STATE_CLASSES[state],
    isWorking: !!meta.isWorking,
    tone: meta.tone,
  }
}

// Board columns: Running / Waiting / Done (failed and stopped sit in Done).
export function boardColumnOf(state) {
  return state === 'running' || state === 'waiting' ? state : 'done'
}

// Mirror of backend/hooks.py `_summarize_tool_input`: the one-line target of
// a tool call, used when a tool_event arrives without a summary.
export function summarizeToolInput(toolName, input) {
  if (!input || typeof input !== 'object') return ''
  const tn = String(toolName || '').toLowerCase()
  const str = (key) => (input[key] === undefined || input[key] === null ? '' : String(input[key]))
  if (tn === 'bash' || tn === 'execute') return str('command').slice(0, 120)
  if (tn === 'read' || tn === 'read_file') {
    const fp = str('file_path')
    const offset = input.offset, limit = input.limit
    let suffix = ''
    if (offset || limit) {
      suffix = ` L${offset || 1}`
      if (limit) suffix += `-${(offset || 1) + limit}`
    }
    return fp ? fp + suffix : ''
  }
  if (['write', 'write_file', 'edit', 'edit_file', 'multiedit', 'notebookedit'].includes(tn)) return str('file_path') || str('notebook_path') || str('path')
  if (tn === 'glob' || tn === 'find_files') return `${str('pattern')}${str('path') ? ` in ${str('path')}` : ''}`
  if (tn === 'grep' || tn === 'search') return `/${str('pattern')}/${str('path') ? ` in ${str('path')}` : ''}`
  if (tn === 'agent' || tn === 'task') return str('subagent_type') ? `${str('subagent_type')}: ${str('description')}` : str('description')
  if (tn === 'webfetch' || tn === 'web_fetch') return str('url')
  if (tn === 'websearch' || tn === 'web_search') return str('query')
  for (const key of ['file_path', 'path', 'command', 'pattern', 'query', 'prompt', 'description']) {
    if (key in input) return str(key).slice(0, 120)
  }
  return ''
}

const EDIT_TOOLS = new Set(['edit', 'edit_file', 'write', 'write_file', 'multiedit', 'notebookedit'])
const READ_TOOLS = new Set(['read', 'read_file'])
const RUN_TOOLS = new Set(['bash', 'execute'])
const SEARCH_TOOLS = new Set(['grep', 'glob', 'search', 'find_files'])
const FETCH_TOOLS = new Set(['webfetch', 'web_fetch', 'websearch', 'web_search'])
const AGENT_TOOLS = new Set(['agent', 'task'])

function toolLine(lastTool) {
  const toolName = String(lastTool?.tool_name || '')
  if (!toolName) return ''
  const target = String(lastTool.summary || summarizeToolInput(toolName, lastTool.input) || '').trim()
  const tn = toolName.toLowerCase()
  if (!target) return toolName
  if (EDIT_TOOLS.has(tn)) return t('activity.editing', { target })
  if (READ_TOOLS.has(tn)) return t('activity.reading', { target })
  if (RUN_TOOLS.has(tn)) return t('activity.running', { target })
  if (SEARCH_TOOLS.has(tn)) return t('activity.searching', { target })
  if (FETCH_TOOLS.has(tn)) return t('activity.fetching', { target })
  if (AGENT_TOOLS.has(tn)) return t('activity.delegating', { target })
  return t('activity.using', { tool: toolName, target })
}

function textOfMessage(message) {
  const content = message?.content
  if (typeof content !== 'string') return ''
  const trimmed = content.trim()
  if (!trimmed) return ''
  if (trimmed[0] === '[' || trimmed[0] === '{') {
    try {
      const parsed = JSON.parse(trimmed)
      const blocks = Array.isArray(parsed) ? parsed : [parsed]
      const text = blocks.find((block) => block && block.type === 'text' && typeof block.text === 'string')
      return text ? text.text : ''
    } catch { /* plain text that happens to start with a bracket */ }
  }
  return trimmed
}

function firstLine(text, max = 120) {
  const line = String(text || '').split('\n').map((part) => part.trim()).find(Boolean) || ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// Attention text (question with command) > last tool > last assistant line > ''.
export function activityLineOf(session, { lastTool = null, messages = null } = {}) {
  const attention = session?.attention
  if (attention) {
    const message = String(attention.message || '').trim()
    if (attention.kind === 'permission' && message && attention.source !== 'terminal') return t('activity.run', { command: firstLine(message) })
    return firstLine(message || attention.title || '')
  }
  const fromTool = toolLine(lastTool)
  if (fromTool) return fromTool
  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message?.role !== 'assistant') continue
      const text = firstLine(textOfMessage(message))
      if (text) return text
    }
  }
  return ''
}

// Accepts ISO strings (with or without zone), epoch milliseconds or epoch
// seconds (what the backend hooks record), and returns milliseconds.
export function toMillis(when) {
  if (when === null || when === undefined || when === '') return NaN
  if (when instanceof Date) return when.getTime()
  if (typeof when === 'number') return when < 1e11 ? when * 1000 : when
  const text = String(when).trim()
  if (/^\d+(\.\d+)?$/.test(text)) return toMillis(Number(text))
  // SQLite datetime('now') is UTC without a zone marker.
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text) ? `${text.replace(' ', 'T')}Z` : text
  return Date.parse(iso)
}

// 'now' | '2 s ago' | '12 min ago' | '1 h ago' | '3 d ago'
export function relativeTime(when, now = Date.now()) {
  const at = toMillis(when)
  if (!Number.isFinite(at)) return ''
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 5) return t('time.now')
  if (seconds < 60) return t('time.seconds', { n: seconds })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('time.minutes', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('time.hours', { n: hours })
  return t('time.days', { n: Math.round(hours / 24) })
}

// How long the session has been working: '14 min' | '1 h 05 min' | ''.
export function runtimeOf(session, { workStartedAt, ptyStartedAt, now = Date.now() } = {}) {
  const start = toMillis(workStartedAt) || toMillis(ptyStartedAt) || toMillis(session?.last_active_at)
  if (!Number.isFinite(start) || start <= 0 || start > now) return ''
  const seconds = Math.round((now - start) / 1000)
  if (seconds < 60) return t('time.runtimeSeconds', { n: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('time.runtimeMinutes', { n: minutes })
  const h = Math.floor(minutes / 60), m = minutes % 60
  return m ? t('time.runtimeHoursMinutes', { h, m: String(m).padStart(2, '0') }) : t('time.runtimeHours', { h })
}

// 6100 → '6.1k', 950 → '950', 1_250_000 → '1.3M'
export function compactNumber(n) {
  if (n === null || n === undefined || n === '') return ''
  const value = Number(n)
  if (!Number.isFinite(value)) return ''
  const abs = Math.abs(value)
  const format = (num, suffix) => {
    const fixed = num.toFixed(abs / (suffix === 'k' ? 1e3 : 1e6) >= 100 ? 0 : 1).replace(/\.0$/, '')
    return `${fixed}${suffix}`
  }
  if (abs >= 1e6) return format(value / 1e6, 'M')
  if (abs >= 1e3) return format(value / 1e3, 'k')
  return String(Math.round(value))
}

// 0.42 → '$0.42'; null → ''
export function formatCost(usd) {
  if (usd === null || usd === undefined || usd === '') return ''
  const value = Number(usd)
  if (!Number.isFinite(value)) return ''
  if (value > 0 && value < 0.005) return '<$0.01'
  return `$${value.toFixed(2)}`
}
