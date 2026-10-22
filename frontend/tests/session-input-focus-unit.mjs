// Where the cursor goes when a session is started or opened
// (lib/sessionInputFocus.js): chat view -> composer, a terminal on screen
// keeps it, a hidden terminal never takes it, touch only after typing.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { focusChatComposerFor, isShown, mayAutoFocusComposer, noteTyping, terminalShownFor, TYPING_GRACE_MS } from '../src/lib/sessionInputFocus.js'

const el = (w, h, extra = {}) => ({ clientWidth: w, clientHeight: h, isConnected: true, ...extra })
function fakeDoc(terminals = []) {
  const doc = {
    activeElement: null,
    querySelectorAll: (sel) => terminals.filter((t) => sel.includes(`"${t.sid}"`)),
  }
  return doc
}
function textarea(doc, w = 300, h = 32) {
  const t = el(w, h, { disabled: false })
  t.focus = () => { doc.activeElement = t }
  return t
}
const desktop = { matchMedia: () => ({ matches: false }) }
const touch = { matchMedia: (q) => ({ matches: q === '(hover: none) and (pointer: coarse)' }) }

test('isShown: 0px drawer, 1px hidden cell and detached nodes are not on screen', () => {
  assert.equal(isShown(el(800, 0)), false)
  assert.equal(isShown(el(1, 1)), false)
  assert.equal(isShown(el(800, 300, { isConnected: false })), false)
  assert.equal(isShown(el(800, 300)), true)
  assert.equal(isShown(null), false)
})

test('terminalShownFor only counts a terminal of that session that is on screen', () => {
  const doc = fakeDoc([{ sid: 's1', ...el(800, 0) }, { sid: 's2', ...el(800, 300) }])
  assert.equal(terminalShownFor('s1', doc), false)
  assert.equal(terminalShownFor('s2', doc), true)
  assert.equal(terminalShownFor('s3', doc), false)
})

test('chat view: the active session composer gets the cursor', () => {
  const doc = fakeDoc([{ sid: 's1', ...el(800, 0) }]) // closed drawer
  const t = textarea(doc)
  assert.equal(focusChatComposerFor({ sessionId: 's1', activeSessionId: 's1', textarea: t, doc, win: desktop }), true)
  assert.equal(doc.activeElement, t)
})

test('not the active session, hidden or disabled composer: nothing happens', () => {
  const doc = fakeDoc()
  assert.equal(focusChatComposerFor({ sessionId: 's1', activeSessionId: 's2', textarea: textarea(doc), doc, win: desktop }), false)
  assert.equal(focusChatComposerFor({ sessionId: 's1', activeSessionId: 's1', textarea: textarea(doc, 0, 0), doc, win: desktop }), false)
  const off = textarea(doc); off.disabled = true
  assert.equal(focusChatComposerFor({ sessionId: 's1', activeSessionId: 's1', textarea: off, doc, win: desktop }), false)
  assert.equal(doc.activeElement, null)
})

test('a terminal of the session on screen (terminal view, open drawer) keeps the cursor', () => {
  const doc = fakeDoc([{ sid: 's1', ...el(800, 320) }])
  assert.equal(focusChatComposerFor({ sessionId: 's1', activeSessionId: 's1', textarea: textarea(doc), doc, win: desktop }), false)
  assert.equal(doc.activeElement, null)
})

test('touch-only: no focus (no soft keyboard) unless the user was just typing', () => {
  assert.equal(mayAutoFocusComposer({ touchOnly: false }), true)
  assert.equal(mayAutoFocusComposer({ touchOnly: true, sinceTypingMs: Infinity }), false)
  assert.equal(mayAutoFocusComposer({ touchOnly: true, sinceTypingMs: 200 }), true)
  assert.equal(mayAutoFocusComposer({ touchOnly: true, sinceTypingMs: TYPING_GRACE_MS + 1 }), false)
  const doc = fakeDoc()
  noteTyping(Date.now() - TYPING_GRACE_MS - 50)
  assert.equal(focusChatComposerFor({ sessionId: 's1', activeSessionId: 's1', textarea: textarea(doc), doc, win: touch }), false)
  noteTyping()
  assert.equal(focusChatComposerFor({ sessionId: 's1', activeSessionId: 's1', textarea: textarea(doc), doc, win: touch }), true)
})
