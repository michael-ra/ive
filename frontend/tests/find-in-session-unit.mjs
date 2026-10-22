// "Find in session" matching + ⌘F routing, and the shortcut contract
// (⌘F in a session, ⌘⇧F across sessions). node --test tests/find-in-session-unit.mjs
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { findOffsets, findInTerminalLines, firstMatchFrom, stepIndex, formatFindStatus } from '../src/lib/findText.js'
import { pickFindTarget, registerFindTarget, openFindInSession, closeAllFindBars } from '../src/lib/findRouter.js'

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const values = new Map()
globalThis.localStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) }
globalThis.window = {}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform: 'MacIntel' } })
after(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else delete globalThis.navigator
})
const kb = await import('../src/lib/keybindings.js')
const event = (key, extra = {}) => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...extra })

test('findOffsets: case-insensitive, non-overlapping, empty query finds nothing', () => {
  assert.deepEqual(findOffsets('Foo foo FOO', 'foo'), [0, 4, 8])
  assert.deepEqual(findOffsets('aaaa', 'aa'), [0, 2])
  assert.deepEqual(findOffsets('abc', ''), [])
  assert.deepEqual(findOffsets('abc', '   '), [])
  assert.deepEqual(findOffsets('abc', 'x'), [])
  assert.equal(findOffsets('a'.repeat(50), 'a', 10).length, 10)
})

test('terminal lines: matches map to row/col, words broken by a wrap are found', () => {
  const lines = [
    { text: '> run tests', isWrapped: false },
    { text: 'error: build fai', isWrapped: false },
    { text: 'led at step 2', isWrapped: true },
    { text: 'ERROR again', isWrapped: false },
  ]
  assert.deepEqual(findInTerminalLines(lines, 'error'), [{ row: 1, col: 0, length: 5 }, { row: 3, col: 0, length: 5 }])
  assert.deepEqual(findInTerminalLines(lines, 'failed'), [{ row: 1, col: 13, length: 6 }])
  assert.deepEqual(findInTerminalLines(lines, 'step'), [{ row: 2, col: 7, length: 4 }])
  assert.deepEqual(findInTerminalLines(lines, ''), [])
})

test('stepping wraps around both ways, status reads "3 of 12" / "No matches"', () => {
  assert.equal(stepIndex(0, 3, 1), 1)
  assert.equal(stepIndex(2, 3, 1), 0)
  assert.equal(stepIndex(0, 3, -1), 2)
  assert.equal(stepIndex(-1, 3, -1), 2)
  assert.equal(stepIndex(0, 0, 1), -1)
  assert.equal(firstMatchFrom([{ row: 1, col: 0 }, { row: 5, col: 2 }], 3), 1)
  assert.equal(firstMatchFrom([{ row: 1, col: 0 }], 9), 0)
  assert.equal(formatFindStatus('x', 12, 2), '3 of 12')
  assert.equal(formatFindStatus('x', 0, -1), 'No matches')
  assert.equal(formatFindStatus('', 0, -1), '')
  assert.equal(formatFindStatus('x', 2000, 0, true), '1 of 2000+')
})

// Minimal DOM stand-ins: an element "contains" its descendants by id path.
const el = (path, { shown = true, field = false } = {}) => ({
  path,
  ownerDocument: { body: null },
  isConnected: true,
  getClientRects: () => (shown ? [1] : []),
  getBoundingClientRect: () => (shown ? { width: 300, height: 200 } : { width: 0, height: 0 }),
  contains(other) { return !!other && (other.path === path || other.path?.startsWith(`${path}/`)) },
  closest: (sel) => (field && /input/.test(sel) ? {} : null),
})
const target = (sessionId, kind, root) => ({ sessionId, kind, getRoot: () => root, open() { this.opened = true }, close() { this.opened = false }, isOpen() { return !!this.opened } })

test('⌘F picks the focused chat or terminal, else the active chat, else global', () => {
  const chatA = target('a', 'chat', el('chatA'))
  const termA = target('a', 'terminal', el('termA'))
  const chatB = target('b', 'chat', el('chatB'))
  const hiddenChatC = target('c', 'chat', el('chatC', { shown: false }))
  const list = [chatA, termA, chatB, hiddenChatC]
  // Focus in the terminal (drawer) → terminal search, even though a chat shows.
  assert.equal(pickFindTarget({ active: el('termA/xterm-textarea'), activeSessionId: 'a', list }), termA)
  // Focus in the chat composer → chat search.
  assert.equal(pickFindTarget({ active: el('chatA/composer', { field: true }), activeSessionId: 'a', list }), chatA)
  // Focus on nothing in particular → the active session's chat.
  assert.equal(pickFindTarget({ active: null, activeSessionId: 'b', list }), chatB)
  // Only a terminal shown for the active session (terminal view / shell) → terminal.
  assert.equal(pickFindTarget({ active: null, activeSessionId: 'a', list: [termA] }), termA)
  // Hidden (inactive tab) panels never take ⌘F.
  assert.equal(pickFindTarget({ active: null, activeSessionId: 'c', list }), null)
  // Home, or typing in a field outside the sessions → search across sessions.
  assert.equal(pickFindTarget({ active: null, activeSessionId: 'a', showHome: true, list }), null)
  assert.equal(pickFindTarget({ active: el('sidebar/filter', { field: true }), activeSessionId: 'a', list }), null)
  assert.equal(pickFindTarget({ active: null, activeSessionId: null, list }), null)
})

test('only one find bar is open at a time', () => {
  globalThis.document = { activeElement: null }
  const one = target('a', 'chat', el('one'))
  const two = target('b', 'chat', el('two'))
  const offs = [registerFindTarget(one), registerFindTarget(two)]
  try {
    assert.equal(openFindInSession({ active: null, activeSessionId: 'a' }), true)
    assert.equal(one.isOpen(), true)
    assert.equal(openFindInSession({ active: null, activeSessionId: 'b' }), true)
    assert.equal(one.isOpen(), false)
    assert.equal(two.isOpen(), true)
    closeAllFindBars()
    assert.equal(two.isOpen(), false)
    assert.equal(openFindInSession({ active: null, activeSessionId: 'zzz' }), false)
  } finally { offs.forEach((off) => off()); delete globalThis.document }
})

test('shortcuts: ⌘F = find in session, ⌘⇧F = all sessions, Quick Feature moved to ⌘⇧I', () => {
  const bindings = kb.getKeybindings()
  assert.equal(kb.formatKeyCombo(bindings.search), '⌘F')
  assert.equal(kb.formatKeyCombo(bindings.globalSearch), '⌘⇧F')
  assert.equal(kb.formatKeyCombo(bindings.quickFeature), '⌘⇧I')
  assert.ok(kb.matchesKey(event('f', { metaKey: true }), bindings.search))
  assert.ok(!kb.matchesKey(event('f', { metaKey: true }), bindings.globalSearch))
  assert.ok(kb.matchesKey(event('F', { metaKey: true, shiftKey: true }), bindings.globalSearch))
  assert.ok(!kb.matchesKey(event('F', { metaKey: true, shiftKey: true }), bindings.search))
  assert.ok(!kb.matchesKey(event('F', { metaKey: true, shiftKey: true }), bindings.quickFeature))
  // ⌃F on a Mac stays readline "forward char" for the agent, never IVE find.
  assert.ok(!kb.matchesKey(event('f', { ctrlKey: true }), bindings.search))
  assert.ok(!kb.shouldTerminalIntercept(event('f', { ctrlKey: true }), bindings))
  // ⌘F / ⌘⇧F typed in the terminal go to IVE, never to the PTY.
  assert.ok(kb.shouldTerminalIntercept(event('f', { metaKey: true }), bindings))
  assert.ok(kb.shouldTerminalIntercept(event('F', { metaKey: true, shiftKey: true }), bindings))
  assert.equal(kb.findConflict('composer', { key: 'F', meta: true, shift: true }, bindings)?.id, 'globalSearch')
})

test('non-Mac: Ctrl+F finds, Ctrl+Shift+F searches all; in the terminal Ctrl+F stays with readline', () => {
  navigator.platform = 'Win32'
  try {
    const bindings = kb.getKeybindings()
    assert.ok(kb.matchesKey(event('f', { ctrlKey: true }), bindings.search))
    assert.ok(kb.matchesKey(event('F', { ctrlKey: true, shiftKey: true }), bindings.globalSearch))
    assert.ok(!kb.shouldTerminalIntercept(event('f', { ctrlKey: true }), bindings))
    assert.ok(kb.shouldTerminalIntercept(event('F', { ctrlKey: true, shiftKey: true }), bindings))
  } finally { navigator.platform = 'MacIntel' }
})
