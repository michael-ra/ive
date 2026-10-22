// Where the user is as data: view from the store, hash in both directions,
// the header address, Back/Forward and deep links that wait for their session.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VIEWS, viewOf, routeOf, parseHash, formatHash, slugify, routeLabel, applyRoute, installRouter } from '../src/lib/route.js'

// A tiny store with the navigation actions of state/store.js.
function fakeStore(initial = {}) {
  let state = { showHome: true, sessionFocus: false, openTabs: [], activeSessionId: null, activeWorkspaceId: null, sessions: {}, workspaces: [], ...initial }
  const listeners = new Set()
  const set = (patch) => {
    const previous = state
    state = { ...state, ...patch }
    for (const fn of [...listeners]) fn(state, previous)
  }
  const actions = {
    goHome: () => set({ showHome: true }),
    goBoard: () => (state.openTabs.length ? set({ showHome: false, sessionFocus: false }) : set({ showHome: true })),
    goSession: (id) => set({ showHome: false, sessionFocus: true, activeSessionId: id || state.activeSessionId }),
    openSession: (id) => set({ openTabs: state.openTabs.includes(id) ? state.openTabs : [...state.openTabs, id], activeSessionId: id, showHome: false }),
    setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
  }
  const store = {
    getState: () => ({ ...state, ...actions }),
    setState: set,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
  }
  return store
}

function fakeWindow(hash = '') {
  const target = new EventTarget()
  const location = { hash }
  const entries = []
  const history = {
    state: null,
    replaceState: (s, t, url) => { location.hash = url; entries.splice(entries.length - 1, 1, url) },
    pushState: (s, t, url) => { location.hash = url; entries.push(url) },
  }
  entries.push(hash)
  return { target, location, history, entries }
}

test('viewOf and routeOf follow showHome / sessionFocus / openTabs', () => {
  assert.deepEqual(VIEWS, ['home', 'board', 'session'])
  assert.equal(viewOf({ showHome: true, openTabs: ['a'], sessionFocus: true, activeSessionId: 'a' }), 'home')
  assert.equal(viewOf({ showHome: false, openTabs: [], sessionFocus: true, activeSessionId: 'a' }), 'home')
  assert.equal(viewOf({ showHome: false, openTabs: ['a'], sessionFocus: false }), 'board')
  assert.equal(viewOf({ showHome: false, openTabs: ['a'], sessionFocus: true, activeSessionId: 'a' }), 'session')
  assert.equal(viewOf({ showHome: false, openTabs: ['a'], sessionFocus: true, activeSessionId: null }), 'board')
  assert.deepEqual(routeOf({ showHome: false, openTabs: ['a'], sessionFocus: true, activeSessionId: 'a', activeWorkspaceId: 'w' }), { view: 'session', sessionId: 'a', workspaceId: 'w' })
  assert.deepEqual(routeOf({ showHome: false, openTabs: ['a'], sessionFocus: false, activeSessionId: 'a' }), { view: 'board', sessionId: null, workspaceId: null })
})

test('hash parsing and formatting round-trip; foreign hashes are left alone', () => {
  assert.deepEqual(parseHash('#home'), { view: 'home' })
  assert.deepEqual(parseHash('#board'), { view: 'board' })
  assert.deepEqual(parseHash('#session-abc%20d'), { view: 'session', sessionId: 'abc d' })
  assert.equal(parseHash('#workspace-settings-x'), null)
  assert.equal(parseHash(''), null)
  assert.equal(parseHash('#session-'), null)
  assert.equal(formatHash({ view: 'session', sessionId: 'a b' }), '#session-a%20b')
  assert.equal(formatHash({ view: 'board' }), '#board')
  assert.equal(formatHash({ view: 'home' }), '#home')
  assert.equal(formatHash(null), '#home')
})

test('slug and header address', () => {
  assert.equal(slugify('Add rate limiting'), 'add-rate-limiting')
  assert.equal(slugify('  Fix: login/redirect (v2) '), 'fix-login-redirect-v2')
  assert.equal(slugify('Über uns'), 'uber-uns')
  const state = {
    showHome: false, openTabs: ['s1'], sessionFocus: true, activeSessionId: 's1',
    sessions: { s1: { id: 's1', name: 'Add rate limiting', workspace_id: 'w1' }, s2: { id: 's2', name: '', workspace_id: 'zz' } },
  }
  const workspaces = [{ id: 'w1', name: 'demo-app' }]
  assert.equal(routeLabel(state, workspaces), 'ive/demo-app/add-rate-limiting')
  assert.equal(routeLabel({ ...state, showHome: true }, workspaces), 'ive/home')
  assert.equal(routeLabel({ ...state, sessionFocus: false }, workspaces), 'ive/board')
  assert.equal(routeLabel({ ...state, activeSessionId: 's2' }, workspaces), 'ive/project/s2')
})

test('applyRoute waits for a session that is not loaded yet', () => {
  const store = fakeStore({ sessions: { a: { id: 'a', workspace_id: 'w1' } } })
  assert.equal(applyRoute(store, { view: 'session', sessionId: 'missing' }), false)
  assert.equal(viewOf(store.getState()), 'home')
  assert.equal(applyRoute(store, { view: 'session', sessionId: 'a' }), true)
  const state = store.getState()
  assert.equal(viewOf(state), 'session')
  assert.deepEqual([state.activeSessionId, state.activeWorkspaceId, state.openTabs], ['a', 'w1', ['a']])
  assert.equal(applyRoute(store, { view: 'board' }), true)
  assert.equal(viewOf(store.getState()), 'board')
  assert.equal(applyRoute(store, { view: 'home' }), true)
  assert.equal(viewOf(store.getState()), 'home')
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('installRouter writes the hash on navigation and applies it on Back/Forward', async () => {
  const store = fakeStore({ sessions: { a: { id: 'a', workspace_id: 'w1' }, b: { id: 'b', workspace_id: 'w1' } } })
  const win = fakeWindow('')
  const uninstall = installRouter(store, win)
  assert.equal(win.location.hash, '#home', 'first sync replaces the entry')
  assert.deepEqual(win.entries, ['#home'])
  // Opening a session is several store updates; they make one history entry.
  store.getState().openSession('a')
  store.getState().goSession('a')
  await tick()
  assert.equal(win.location.hash, '#session-a')
  store.getState().goBoard()
  await tick()
  assert.equal(win.location.hash, '#board')
  assert.deepEqual(win.entries, ['#home', '#session-a', '#board'])
  // Back: the browser restores the hash and fires popstate; the store follows.
  win.location.hash = '#session-a'
  win.target.dispatchEvent(new Event('popstate'))
  await tick()
  assert.equal(viewOf(store.getState()), 'session')
  assert.equal(store.getState().activeSessionId, 'a')
  assert.deepEqual(win.entries, ['#home', '#session-a', '#board'], 'no echo entry for an applied hash')
  // A script sets a hash for a session that is still unknown: it waits.
  win.location.hash = '#session-later'
  win.target.dispatchEvent(new Event('hashchange'))
  assert.equal(viewOf(store.getState()), 'session')
  store.setState({ sessions: { ...store.getState().sessions, later: { id: 'later', workspace_id: 'w2' } } })
  await tick()
  assert.equal(store.getState().activeSessionId, 'later')
  assert.equal(store.getState().activeWorkspaceId, 'w2')
  assert.equal(win.location.hash, '#session-later')
  uninstall()
  store.getState().goHome()
  await tick()
  assert.equal(win.location.hash, '#session-later', 'uninstalled router writes nothing')
})

test('a deep link at start is applied once its session arrives and is not overwritten', async () => {
  const store = fakeStore()
  const win = fakeWindow('#session-x')
  const uninstall = installRouter(store, win)
  assert.equal(win.location.hash, '#session-x', 'pending deep link is kept while sessions load')
  store.setState({ workspaces: [{ id: 'w' }] })
  await tick()
  assert.equal(win.location.hash, '#session-x')
  store.setState({ sessions: { x: { id: 'x', workspace_id: 'w' } } })
  await tick()
  assert.equal(viewOf(store.getState()), 'session')
  assert.equal(store.getState().activeSessionId, 'x')
  assert.equal(win.location.hash, '#session-x')
  uninstall()
  const board = fakeStore({ openTabs: ['x'], sessions: { x: { id: 'x' } } })
  const win2 = fakeWindow('#board')
  installRouter(board, win2)()
  assert.equal(viewOf(board.getState()), 'board')
})
