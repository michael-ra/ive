// The five status words and their details (A.7), the activity line, times
// and number formatting that every screen reads from lib/sessionVocabulary.js.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SESSION_STATES, sessionStateOf, boardColumnOf, activityLineOf, relativeTime, runtimeOf,
  compactNumber, formatCost, summarizeToolInput, toMillis,
} from '../src/lib/sessionVocabulary.js'
import { setLanguage } from '../src/lib/i18n.js'

const agent = (extra = {}) => ({ id: 'a', name: 'Add rate limiting', cli_type: 'claude', ...extra })
const shell = (extra = {}) => ({ id: 't', name: 'Terminal', cli_type: 'shell', session_type: 'shell', ...extra })

test('A.7: every backend state maps to one of five words with its detail', () => {
  const rows = [
    [agent({ status: 'running', pty_alive: true }), 'running', 'Running', ''],
    [agent({ status: 'idle', agentState: 'working', pty_alive: true }), 'running', 'Running', ''],
    [agent({ status: 'replaying', pty_alive: true }), 'running', 'Running', 'Replaying'],
    [agent({ status: 'waiting', pty_alive: true, attention: { kind: 'permission', title: 'Permission needed', message: 'npm test' } }), 'waiting', 'Waiting', 'Permission needed'],
    [agent({ status: 'idle', pty_alive: true, attention: { kind: 'question', title: 'Your answer is needed', message: 'Which?' } }), 'waiting', 'Waiting', 'Your answer is needed'],
    [agent({ status: 'idle', pty_alive: true, startup_blocker: { type: 'trust_required', label: 'Trust this folder' } }), 'waiting', 'Waiting', 'Trust this folder'],
    [agent({ status: 'idle', pty_alive: true }), 'done', 'Done', ''],
    [agent({ status: 'idle', pty_alive: false }), 'stopped', 'Stopped', 'Not started'],
    [agent({ status: 'exited', pty_alive: false }), 'stopped', 'Stopped', 'Stopped by you'],
    [agent({ status: 'stopped', pty_alive: false }), 'stopped', 'Stopped', 'Stopped by you'],
    [agent({ status: 'error', pty_alive: false }), 'failed', 'Failed', 'CLI exited'],
    [agent({ status: 'error', pty_alive: false, exit_code: 137 }), 'failed', 'Failed', 'CLI exited (SIGKILL)'],
    [agent({ status: 'error', pty_alive: false, exit_code: 2 }), 'failed', 'Failed', 'CLI exited (code 2)'],
    [agent({ status: 'auth_failed', pty_alive: false }), 'failed', 'Failed', 'Login expired'],
    [agent({ status: 'idle', pty_alive: true, last_turn_error: 'rate_limit' }), 'done', 'Done', 'Last turn failed'],
    [shell({ status: 'running', pty_alive: true }), 'running', 'Running', ''],
    [shell({ status: 'exited', pty_alive: false }), 'stopped', 'Stopped', ''],
    [shell({ status: 'running', pty_alive: true, attention: { kind: 'question' } }), 'running', 'Running', ''],
  ]
  for (const [session, state, label, detail] of rows) {
    const meta = sessionStateOf(session)
    assert.equal(meta.state, state, `${session.status}/${session.pty_alive}`)
    assert.equal(meta.label, label, `${session.status}/${session.pty_alive}`)
    assert.equal(meta.detail, detail, `${session.status}/${session.pty_alive} detail`)
    assert.ok(SESSION_STATES.includes(meta.state))
    assert.ok(meta.dotClass && meta.textClass && typeof meta.tone === 'string')
  }
  assert.equal(sessionStateOf(agent({ status: 'idle' }), { a: true }).state, 'done', 'a started session without pty_alive yet is Done')
  assert.equal(sessionStateOf(null).state, 'stopped')
})

test('old words never appear and tone survives for older callers', () => {
  const words = new Set(['Running', 'Waiting', 'Done', 'Failed', 'Stopped'])
  for (const status of ['running', 'idle', 'waiting', 'exited', 'error', 'auth_failed', 'replaying', 'stopped', 'crashed'])
    assert.ok(words.has(sessionStateOf(agent({ status, pty_alive: status !== 'exited' })).label), status)
  assert.equal(sessionStateOf(agent({ status: 'idle', pty_alive: false })).tone, 'not-started')
  assert.equal(sessionStateOf(agent({ status: 'exited' })).tone, 'offline')
  assert.equal(sessionStateOf(agent({ status: 'running', pty_alive: true })).isWorking, true)
})

test('status words stay English in German, details are translated', () => {
  setLanguage('de', { persistRemote: false })
  try {
    const meta = sessionStateOf(agent({ status: 'exited', pty_alive: false }))
    assert.equal(meta.label, 'Stopped')
    assert.equal(meta.detail, 'Von dir gestoppt')
    assert.equal(relativeTime(Date.now() - 120000), 'vor 2 min')
  } finally {
    setLanguage('en', { persistRemote: false })
  }
})

test('board columns: failed and stopped sit in Done', () => {
  assert.deepEqual(SESSION_STATES.map(boardColumnOf), ['running', 'waiting', 'done', 'done', 'done'])
})

test('activity line: question first, then the last tool, then the last assistant line', () => {
  const waiting = agent({ attention: { kind: 'permission', message: 'npm test -- --coverage', source: 'hook' } })
  assert.equal(activityLineOf(waiting, { lastTool: { tool_name: 'Edit', summary: 'x.ts' } }), 'Run npm test -- --coverage?')
  assert.equal(activityLineOf(agent({ attention: { kind: 'question', message: 'Which project?' } })), 'Which project?')
  assert.equal(activityLineOf(agent({ attention: { kind: 'permission', message: 'Review the request in the terminal.', source: 'terminal' } })), 'Review the request in the terminal.')
  assert.equal(activityLineOf(agent(), { lastTool: { tool_name: 'Edit', summary: 'src/auth/redirect.ts' } }), 'Editing src/auth/redirect.ts')
  assert.equal(activityLineOf(agent(), { lastTool: { tool_name: 'Bash', summary: '', input: { command: 'npm test' } } }), 'Running npm test')
  assert.equal(activityLineOf(agent(), { lastTool: { tool_name: 'Read', summary: 'README.md' } }), 'Reading README.md')
  assert.equal(activityLineOf(agent(), { lastTool: { tool_name: 'Grep', summary: '/foo/ in src' } }), 'Searching /foo/ in src')
  assert.equal(activityLineOf(agent(), { lastTool: { tool_name: 'Task', summary: 'explore: find callers' } }), 'Delegating: explore: find callers')
  assert.equal(activityLineOf(agent(), { lastTool: { tool_name: 'Think', summary: '' } }), 'Think')
  const messages = [
    { role: 'user', content: 'Add a limiter' },
    { role: 'assistant', content: JSON.stringify([{ type: 'tool_use', name: 'Read' }, { type: 'text', text: 'The middleware is wired in.\nNext I run the tests.' }]) },
    { role: 'user', content: 'ok' },
  ]
  assert.equal(activityLineOf(agent(), { messages }), 'The middleware is wired in.')
  assert.equal(activityLineOf(agent(), { messages: [{ role: 'assistant', content: 'x'.repeat(200) }] }).length, 120)
  assert.equal(activityLineOf(agent()), '')
})

test('summarizeToolInput mirrors the backend one-liner', () => {
  assert.equal(summarizeToolInput('Bash', { command: 'git status' }), 'git status')
  assert.equal(summarizeToolInput('Read', { file_path: 'a.py', offset: 10, limit: 5 }), 'a.py L10-15')
  assert.equal(summarizeToolInput('Edit', { file_path: 'a.py', old_string: 'x' }), 'a.py')
  assert.equal(summarizeToolInput('NotebookEdit', { notebook_path: 'n.ipynb' }), 'n.ipynb')
  assert.equal(summarizeToolInput('Glob', { pattern: '*.ts', path: 'src' }), '*.ts in src')
  assert.equal(summarizeToolInput('WebFetch', { url: 'https://x' }), 'https://x')
  assert.equal(summarizeToolInput('Custom', { query: 'q' }), 'q')
  assert.equal(summarizeToolInput('Custom', null), '')
})

test('relative time and runtime read ISO strings, epoch seconds and milliseconds', () => {
  const now = Date.parse('2026-10-12T12:00:00Z')
  assert.equal(relativeTime(now - 1000, now), 'now')
  assert.equal(relativeTime(now - 2000 * 10, now), '20 s ago')
  assert.equal(relativeTime(now - 12 * 60000, now), '12 min ago')
  assert.equal(relativeTime(now - 65 * 60000, now), '1 h ago')
  assert.equal(relativeTime(now - 3 * 86400000, now), '3 d ago')
  assert.equal(relativeTime('2026-10-12 11:58:00', now), '2 min ago', 'SQLite UTC without zone')
  assert.equal(relativeTime((now - 40000) / 1000, now), '40 s ago', 'epoch seconds from hooks')
  assert.equal(relativeTime(null, now), '')
  assert.equal(toMillis('2026-10-12T11:58:00Z'), now - 120000)
  assert.equal(runtimeOf(agent(), { workStartedAt: now - 14 * 60000, now }), '14 min')
  assert.equal(runtimeOf(agent(), { ptyStartedAt: now - 65 * 60000, now }), '1 h 05 min')
  assert.equal(runtimeOf(agent(), { ptyStartedAt: now - 2 * 3600000, now }), '2 h')
  assert.equal(runtimeOf(agent({ last_active_at: '2026-10-12 11:59:30' }), { now }), '30 s')
  assert.equal(runtimeOf(agent(), { now }), '')
})

test('numbers and cost', () => {
  assert.equal(compactNumber(6100), '6.1k')
  assert.equal(compactNumber(950), '950')
  assert.equal(compactNumber(120000), '120k')
  assert.equal(compactNumber(1250000), '1.3M')
  assert.equal(compactNumber(null), '')
  assert.equal(formatCost(0.42), '$0.42')
  assert.equal(formatCost(0), '$0.00')
  assert.equal(formatCost(0.001), '<$0.01')
  assert.equal(formatCost(null), '')
  assert.equal(formatCost('x'), '')
})
