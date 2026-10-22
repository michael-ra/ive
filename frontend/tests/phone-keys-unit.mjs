// node --test tests/phone-keys-unit.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyStickyCtrl, clampPhoneFont, ctrlByte, isCtrlArmed, keyBytes, lastActivityLine, readPhoneFont, setCtrlArmed, writePhoneFont } from '../src/lib/phoneKeys.js'

test('key bar bytes', () => {
  assert.equal(keyBytes('esc'), '\x1b')
  assert.equal(keyBytes('tab'), '\t')
  assert.equal(keyBytes('shift-tab'), '\x1b[Z')
  assert.equal(keyBytes('ctrl-c'), '\x03')
  assert.equal(keyBytes('ctrl-d'), '\x04')
  assert.equal(keyBytes('ctrl-r'), '\x12')
  assert.equal(keyBytes('up'), '\x1b[A')
  assert.equal(keyBytes('left', { appCursor: true }), '\x1bOD')
  assert.equal(keyBytes('pipe'), '|')
})

test('ctrl bytes', () => {
  assert.equal(ctrlByte('c'), '\x03')
  assert.equal(ctrlByte('C'), '\x03')
  assert.equal(ctrlByte('['), '\x1b')
  assert.equal(ctrlByte(' '), '\x00')
  assert.equal(ctrlByte('/'), '\x1f')
  assert.equal(ctrlByte('é'), null)
  assert.equal(ctrlByte('ab'), null)
})

test('sticky ctrl applies to one key, then releases', () => {
  assert.equal(applyStickyCtrl('s', 'c'), 'c')
  setCtrlArmed('s', true)
  assert.equal(isCtrlArmed('s'), true)
  assert.equal(applyStickyCtrl('other', 'c'), 'c', 'per session')
  assert.equal(applyStickyCtrl('s', 'r'), '\x12')
  assert.equal(isCtrlArmed('s'), false)
  setCtrlArmed('s', true)
  assert.equal(applyStickyCtrl('s', '\x1b[A'), '\x1b[A', 'sequences pass through')
  assert.equal(isCtrlArmed('s'), false)
})

test('phone font is clamped and remembered', () => {
  const store = new Map()
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  assert.equal(readPhoneFont(storage), 12)
  assert.equal(writePhoneFont(40, storage), 22)
  assert.equal(readPhoneFont(storage), 22)
  assert.equal(clampPhoneFont(3), 8)
  assert.equal(clampPhoneFont('x'), 12)
})

test('last activity line skips CLI chrome', () => {
  const screen = ['● Edited src/app.js', '  ⎿ 3 lines changed', '', '╭──────────╮', '│ >        │', '╰──────────╯', '  ? for shortcuts', ''].join('\n')
  assert.equal(lastActivityLine(screen), '⎿ 3 lines changed')
  assert.equal(lastActivityLine(''), '')
})
