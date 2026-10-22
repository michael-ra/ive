import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import {
  KEYBINDING_DEFS, getKeybindings, getDefaultKeybinding, getTabSwitchCombo,
  matchesKey, matchesAction, formatKeyCombo, isGlobalShortcut, setKeybinding, resetKeybinding,
  shouldTerminalIntercept, isPtyControlKey, isBrowserReservedControlKey, combosEqual, findConflict,
} from '../src/lib/keybindings.js'

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const values = new Map()
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: (key) => values.delete(key),
}
globalThis.window = {}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform: 'MacIntel' } })
after(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else delete globalThis.navigator
})

const event = (key, extra = {}) => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...extra })


const PTY_KEYS = 'cdzlraekuwypnbftgj'.split('')
// Mac browser: the only ⌃ letters IVE keeps while the terminal has focus.
const BROWSER_KEPT = ['n', 'w', 't']

test('Mac browser defaults avoid reserved Command shortcuts and show Control', () => {
  const bindings = getKeybindings()
  const expected = { newSession: '⌃N', newSessionSetup: '⌃⇧N', closeTab: '⌃W', agentTree: '⌃T', missionControl: '⌃M', research: '⌃R', splitView: '⌃D' }
  for (const [id, label] of Object.entries(expected)) {
    assert.equal(bindings[id].ctrl, true, id)
    assert.ok(!bindings[id].meta, id)
    assert.equal(formatKeyCombo(bindings[id]), label, id)
  }
  assert.equal(formatKeyCombo(getTabSwitchCombo('2')), '⌃2')
  assert.equal(bindings.commandPalette.meta, true, 'working Command+K remains available')
})

test('desktop app and non-Mac keep ⌘ defaults (contract: ⌘N quick start)', () => {
  for (const def of KEYBINDING_DEFS) assert.deepEqual(getDefaultKeybinding(def, false), def.defaultKey)
  window.__TAURI_INTERNALS__ = {}
  try {
    assert.equal(formatKeyCombo(getKeybindings().newSession), '⌘N')
    assert.equal(getTabSwitchCombo().meta, true)
  } finally { delete window.__TAURI_INTERNALS__ }
  navigator.platform = 'Win32'
  try { assert.equal(getKeybindings().newSession.meta, true) } finally { navigator.platform = 'MacIntel' }
})

test('on macOS Control is never an alias for Command', () => {
  const bindings = getKeybindings()
  assert.ok(matchesKey(event('n', { ctrlKey: true }), bindings.newSession))
  assert.ok(!matchesKey(event('n', { metaKey: true }), bindings.newSession))
  assert.ok(!matchesKey(event('n', { ctrlKey: true, metaKey: true }), bindings.newSession))
  assert.ok(!matchesKey(event('n', { ctrlKey: true, shiftKey: true }), bindings.newSession))
  assert.ok(matchesKey(event('N', { ctrlKey: true, shiftKey: true }), bindings.newSessionSetup))
  for (const id of ['commandPalette', 'composer', 'toggleTerminal', 'guidelines', 'usage', 'stopSession', 'featureBoard', 'inbox']) {
    const combo = bindings[id]
    assert.ok(!matchesKey(event(combo.key, { ctrlKey: true, shiftKey: !!combo.shift }), combo), id)
  }
})

test('Mac browser terminal: IVE keeps only ⌃N/⌃⇧N/⌃T/⌃W/⌃1-9, ⌃R/⌃D/⌃M go to the PTY', () => {
  const bindings = getKeybindings()
  for (const key of PTY_KEYS) {
    const e = event(key, { ctrlKey: true })
    assert.equal(shouldTerminalIntercept(e, bindings), BROWSER_KEPT.includes(key), key)
  }
  assert.ok(shouldTerminalIntercept(event('N', { ctrlKey: true, shiftKey: true }), bindings), '⌃⇧N setup')
  assert.ok(!shouldTerminalIntercept(event('.', { ctrlKey: true }), bindings), 'Ctrl+. does not stop the session')
  assert.ok(shouldTerminalIntercept(event('k', { metaKey: true }), bindings))
  assert.ok(shouldTerminalIntercept(event('2', { ctrlKey: true }), bindings))
  assert.ok(!shouldTerminalIntercept(event('['), bindings))
  assert.ok(!shouldTerminalIntercept(event('n'), bindings))
  assert.ok(!matchesAction(event('n', { ctrlKey: true, _ivePtyKey: true }), bindings, 'newSession'))
})

test('outside the terminal ⌃R/⌃D/⌃M still run research / overview / mission control', () => {
  const bindings = getKeybindings()
  assert.ok(matchesKey(event('r', { ctrlKey: true }), bindings.research))
  assert.ok(matchesKey(event('d', { ctrlKey: true }), bindings.splitView))
  assert.ok(matchesKey(event('m', { ctrlKey: true }), bindings.missionControl))
  for (const key of ['r', 'd', 'm']) assert.ok(!isBrowserReservedControlKey(event(key, { ctrlKey: true }), bindings), key)
})

test('rebinding close tab away gives ⌃W back to the PTY', () => {
  setKeybinding('closeTab', { key: 'w', meta: true, alt: true })
  try {
    assert.ok(!shouldTerminalIntercept(event('w', { ctrlKey: true }), getKeybindings()))
  } finally { resetKeybinding('closeTab') }
})

test('a custom ⌃ binding on a readline key for any other action stays with the PTY', () => {
  setKeybinding('composer', { key: 'e', ctrl: true })
  try {
    const bindings = getKeybindings()
    assert.ok(isGlobalShortcut(event('e', { ctrlKey: true }), bindings))
    assert.ok(!shouldTerminalIntercept(event('e', { ctrlKey: true }), bindings))
  } finally { resetKeybinding('composer') }
})

test('desktop app terminal gives every ⌃ key to the PTY', () => {
  window.__TAURI_INTERNALS__ = {}
  try {
    const bindings = getKeybindings()
    for (const key of PTY_KEYS) assert.ok(!shouldTerminalIntercept(event(key, { ctrlKey: true }), bindings), key)
    assert.ok(shouldTerminalIntercept(event('n', { metaKey: true }), bindings))
  } finally { delete window.__TAURI_INTERNALS__ }
})

test('non-Mac: Ctrl stands in for ⌘ outside the terminal, readline keys still go to the PTY', () => {
  navigator.platform = 'Win32'
  try {
    const bindings = getKeybindings()
    assert.ok(matchesKey(event('k', { ctrlKey: true }), bindings.commandPalette))
    assert.ok(matchesKey(event('n', { ctrlKey: true }), bindings.newSession))
    assert.equal(getTabSwitchCombo().meta, true)
    for (const key of PTY_KEYS) assert.ok(!shouldTerminalIntercept(event(key, { ctrlKey: true }), bindings), key)
    assert.ok(shouldTerminalIntercept(event('2', { ctrlKey: true }), bindings))
    assert.ok(shouldTerminalIntercept(event('F', { ctrlKey: true, shiftKey: true }), bindings))
    assert.ok(combosEqual({ key: 'k', ctrl: true }, { key: 'k', meta: true }))
    assert.equal(findConflict('composer', { key: 'k', ctrl: true }, bindings)?.id, 'commandPalette')
  } finally {
    navigator.platform = 'MacIntel'
  }
})

test('Mac recorder: ⌃K is not a conflict with ⌘K, ⌃N is a conflict with quick start', () => {
  const bindings = getKeybindings()
  assert.ok(!combosEqual({ key: 'k', ctrl: true }, { key: 'k', meta: true }))
  assert.equal(findConflict('composer', { key: 'k', ctrl: true }, bindings), null)
  assert.equal(findConflict('composer', { key: 'k', meta: true }, bindings)?.id, 'commandPalette')
  assert.equal(findConflict('composer', { key: 'n', ctrl: true }, bindings)?.id, 'newSession')
})

test('custom bindings and explicitly disabled shortcuts survive browser defaults', () => {
  const custom = { key: 'n', meta: true, alt: true }
  setKeybinding('newSession', custom)
  assert.deepEqual(getKeybindings().newSession, custom)
  setKeybinding('newSession', null)
  assert.equal(getKeybindings().newSession, null)
  assert.ok(!shouldTerminalIntercept(event('n', { ctrlKey: true }), getKeybindings()))
  resetKeybinding('newSession')
  assert.equal(getKeybindings().newSession.ctrl, true)
})

test('⌘J is the terminal drawer, Scratchpad and the launcher have no default, ⌘⇧H goes Home', () => {
  const bindings = getKeybindings()
  assert.deepEqual(bindings.toggleTerminal, { key: 'j', meta: true })
  assert.ok(matchesKey(event('j', { metaKey: true }), bindings.toggleTerminal))
  assert.equal(formatKeyCombo(bindings.toggleTerminal), '⌘J')
  assert.ok(KEYBINDING_DEFS.some((def) => def.id === 'scratchpad'), 'the id stays for saved overrides and the ⋯ menu')
  assert.equal(bindings.scratchpad, null)
  assert.equal(bindings.navigationLauncher, null)
  assert.deepEqual(bindings.goHome, { key: 'H', meta: true, shift: true })
  assert.ok(matchesKey(event('H', { metaKey: true, shiftKey: true }), bindings.goHome))
  assert.deepEqual(bindings.toggleSessionLevel, { key: 'E', meta: true, shift: true })
  assert.equal(KEYBINDING_DEFS.find((def) => def.id === 'toggleSessionLevel').label, 'Switch Board ⇄ Session')
  assert.ok(!isGlobalShortcut(event('j', { metaKey: true, shiftKey: false, ctrlKey: true }), bindings))
})

test('effective defaults do not assign two actions to the same physical shortcut', () => {
  const bindings = getKeybindings()
  const seen = new Map()
  for (const [id, combo] of Object.entries(bindings)) {
    if (!combo) continue
    const signature = [combo.key.toLowerCase(), !!combo.meta, !!combo.ctrl, !!combo.shift, !!combo.alt].join(':')
    assert.ok(!seen.has(signature), `${id} conflicts with ${seen.get(signature)}`)
    seen.set(signature, id)
  }
})
