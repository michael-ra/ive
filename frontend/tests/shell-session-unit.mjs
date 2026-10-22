// Plain terminal sessions (cli_type "shell") show Running / Stopped, never
// Waiting or Done (no agent, no questions).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getSessionDisplayStatus, isShellSession, isShellCli } from '../src/lib/sessionStatus.js'

const shell = (extra = {}) => ({ id: 't', name: 'Terminal', cli_type: 'shell', session_type: 'shell', ...extra })

test('a live shell is Running even though the DB says running/working', () => {
  for (const status of ['running', 'idle', 'working']) {
    const meta = getSessionDisplayStatus(shell({ status, agentState: 'working', pty_alive: true }))
    assert.equal(meta.label, 'Running')
    assert.equal(meta.isWorking, false)
  }
})

test('a started shell without pty_alive yet is Running; after exit it is Stopped', () => {
  assert.equal(getSessionDisplayStatus(shell({ status: 'idle' }), { t: true }).label, 'Running')
  assert.equal(getSessionDisplayStatus(shell({ status: 'exited', pty_alive: false }), { t: true }).label, 'Stopped')
  assert.equal(getSessionDisplayStatus(shell({ status: 'stopped', pty_alive: false }), { t: true }).state, 'stopped')
  assert.equal(getSessionDisplayStatus(shell({ status: 'idle', pty_alive: false })).label, 'Stopped')
})

test('shells are never Waiting or Done (no agent attention)', () => {
  const meta = getSessionDisplayStatus(shell({ status: 'running', pty_alive: true, attention: { kind: 'question' } }))
  assert.equal(meta.label, 'Running')
  assert.equal(meta.state, 'running')
  for (const status of ['running', 'idle', 'exited', 'waiting']) {
    const word = getSessionDisplayStatus(shell({ status, pty_alive: status === 'running' })).label
    assert.ok(['Running', 'Stopped'].includes(word), `${status} → ${word}`)
  }
})

test('agents use the same five words', () => {
  assert.equal(getSessionDisplayStatus({ id: 'a', cli_type: 'claude', status: 'running', pty_alive: true }).label, 'Running')
  assert.equal(getSessionDisplayStatus({ id: 'a', cli_type: 'claude', status: 'exited' }).label, 'Stopped')
  assert.equal(getSessionDisplayStatus({ id: 'a', cli_type: 'claude', status: 'idle', pty_alive: true }).label, 'Done')
  assert.equal(getSessionDisplayStatus({ id: 'a', cli_type: 'claude', status: 'idle', pty_alive: true, attention: { kind: 'question' } }).label, 'Waiting')
})

test('shell detection', () => {
  assert.equal(isShellSession(shell()), true)
  assert.equal(isShellSession({ cli_type: 'claude' }), false)
  assert.equal(isShellSession(null), false)
  assert.equal(isShellCli('shell'), true)
  assert.equal(isShellCli('codex'), false)
})
