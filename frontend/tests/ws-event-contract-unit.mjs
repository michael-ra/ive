// Static WebSocket event contract: every message type the backend pushes to
// browsers must have a frontend handler (or be listed as intentionally
// ignored), and every type the frontend waits for must have a producer (or be
// listed as extension-provided). Run: node --test frontend/tests/ws-event-contract-unit.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const backendDir = join(root, 'backend')
const frontendSrc = join(root, 'frontend', 'src')

// Backend pushes these, the browser deliberately does nothing with them.
// Keep the reason next to each entry.
const IGNORED_BY_FRONTEND = {}

// Types built at runtime (f-strings, parameters). `needle` must still exist in
// `file`, so a rename there fails this test instead of silently passing.
const DYNAMIC_PRODUCERS = {
  distill_done: { file: 'backend/server.py', needle: '"type": f"{job_type}_done"' },
  distill_error: { file: 'backend/server.py', needle: '"type": f"{job_type}_error"' },
  mcp_parse_done: { file: 'backend/server.py', needle: 'job_type="mcp_parse"' },
  mcp_parse_error: { file: 'backend/server.py', needle: 'job_type="mcp_parse"' },
  permission_mode_apply: { file: 'backend/permission_mode_live.py', needle: '"permission_mode_apply" if' },
  launch_apply: { file: 'backend/permission_mode_live.py', needle: 'else "launch_apply"' },
  cascade_progress: { file: 'backend/cascade_runner.py', needle: 'event: str = "cascade_progress"' },
  cascade_completed: { file: 'backend/cascade_runner.py', needle: 'event="cascade_completed"' },
  cascade_loop_reprompt: { file: 'backend/cascade_runner.py', needle: 'event="cascade_loop_reprompt"' },
  // Built by event_bus.client_envelope and sent through server's scoped sink.
  commander_event: { file: 'backend/event_bus.py', needle: '"type": "commander_event"' },
}

// The frontend listens for these, but no in-tree backend code sends them.
const EXTERNAL_PRODUCERS = {
  guideline_recommendation: 'Session Advisor extension (advisor routes return 503 without it)',
  skill_suggestion: 'Skill Suggester extension (advisor routes return 503 without it)',
}

// Names that look like a broadcast call. The first argument is either a dict
// literal or a local variable assigned from one.
const CALL_RE = /\b(?:broadcast|_broadcast|_broadcast_to_owners|_broadcast_fn|broadcast_fn|send_json|_send_json|_safe_send|json\.dumps)\s*\(/g

function walk(dir, filter, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.venv' || name === '__pycache__') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, filter, out)
    else if (filter(name)) out.push(full)
  }
  return out
}

// Return index just past the bracket matching src[open], skipping strings.
function matchClose(src, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' }
  const stack = [pairs[src[open]]]
  let i = open + 1
  while (i < src.length && stack.length) {
    const ch = src[i]
    if (ch === '"' || ch === "'") {
      const triple = src.startsWith(ch.repeat(3), i)
      const end = triple ? src.indexOf(ch.repeat(3), i + 3) : findQuoteEnd(src, i, ch)
      i = end < 0 ? src.length : end + (triple ? 3 : 1)
      continue
    }
    if (ch === '#') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue }
    if (pairs[ch]) stack.push(pairs[ch])
    else if (ch === stack[stack.length - 1]) stack.pop()
    i++
  }
  return i
}

function findQuoteEnd(src, start, q) {
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue }
    if (src[i] === q || src[i] === '\n') return i
  }
  return -1
}

// Top-level "type" value and key names of the dict literal at src[open].
function topLevelDict(src, open) {
  const end = matchClose(src, open)
  const body = src.slice(open + 1, end - 1)
  let depth = 0
  let flat = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if ('{[('.includes(ch)) depth++
    else if ('}])'.includes(ch)) depth--
    else if (depth === 0) { flat += ch; continue }
    flat += ' '
  }
  const m = flat.match(/["']type["']\s*:\s*["']([a-z][a-z0-9_]*)["']/)
  const keys = new Set([...flat.matchAll(/["']([a-z_][a-z0-9_]*)["']\s*:/g)].map((k) => k[1]))
  return { type: m ? m[1] : null, keys, spreads: /\*\*/.test(flat) }
}

let cachedSites = null
// Every literal message the backend hands to a broadcast/send helper.
export function backendBroadcastSites() {
  if (cachedSites) return cachedSites
  const sites = []
  const files = walk(backendDir, (n) => n.endsWith('.py') && !n.startsWith('test_'))
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(CALL_RE)) {
      let j = m.index + m[0].length
      while (/\s/.test(src[j])) j++
      let dict = null
      if (src[j] === '{') {
        dict = topLevelDict(src, j)
      } else {
        const ident = src.slice(j).match(/^([A-Za-z_]\w*)\s*[,)]/)
        if (!ident) continue
        // Nearest preceding `ident = {` (or `ident: dict = {`) in the file.
        const assignRe = new RegExp(`\\b${ident[1]}\\s*(?::\\s*[\\w\\[\\], ]+)?=\\s*\\{`, 'g')
        let last = null
        for (const a of src.slice(0, m.index).matchAll(assignRe)) last = a
        if (last) dict = topLevelDict(src, last.index + last[0].length - 1)
      }
      if (dict?.type) {
        const where = `${relative(root, file)}:${src.slice(0, m.index).split('\n').length}`
        sites.push({ ...dict, where })
      }
    }
  }
  cachedSites = sites
  return sites
}

export function backendBroadcastTypes() {
  const types = new Map()
  for (const s of backendBroadcastSites()) if (!types.has(s.type)) types.set(s.type, s.where)
  for (const [t, { file }] of Object.entries(DYNAMIC_PRODUCERS)) if (!types.has(t)) types.set(t, file)
  return types
}

// Types useWebSocket handles after `if (!sid) return`, and types handled
// before it (inline checks plus lib/globalEvents.js). A message of a guarded
// type without a top-level session_id is silently dropped.
function splitAtGuard() {
  const src = readFileSync(join(frontendSrc, 'hooks', 'useWebSocket.js'), 'utf8')
  const guard = src.search(/const sid = data\.session_id\s*\n\s*if \(!sid\) return/)
  assert.ok(guard > 0, 'session guard in useWebSocket.js not found')
  return { before: src.slice(0, guard), after: src.slice(guard) }
}

export function sessionGuardedTypes() {
  return new Set([...splitAtGuard().after.matchAll(/\bcase\s+'([a-z][a-z0-9_]*)'\s*:/g)].map((m) => m[1]))
}

export function preGuardTypes() {
  const types = new Set([...splitAtGuard().before.matchAll(/\bdata\.type\s*===\s*'([a-z][a-z0-9_]*)'/g)].map((m) => m[1]))
  const global = readFileSync(join(frontendSrc, 'lib', 'globalEvents.js'), 'utf8')
  for (const m of global.matchAll(/\bcase\s+'([a-z][a-z0-9_]*)'\s*:/g)) types.add(m[1])
  return types
}

// Pre-guard handlers that only fire when this key is present.
const PRE_GUARD_REQUIRES = { session_created: 'session' }

// event_bus.CLIENT_EVENTS, resolved through the CommanderEvent enum.
export function forwardedCommanderEvents() {
  const enumSrc = readFileSync(join(backendDir, 'commander_events.py'), 'utf8')
  const values = new Map([...enumSrc.matchAll(/^\s+([A-Z_]+)\s*=\s*"([a-z_.]+)"/gm)].map((m) => [m[1], m[2]]))
  const busSrc = readFileSync(join(backendDir, 'event_bus.py'), 'utf8')
  const block = busSrc.match(/CLIENT_EVENTS[^=]*=\s*frozenset\(\{([\s\S]*?)\}\)/)
  assert.ok(block, 'CLIENT_EVENTS not found in event_bus.py')
  return {
    all: new Set(values.values()),
    forwarded: new Set([...block[1].matchAll(/CommanderEvent\.([A-Z_]+)/g)].map((m) => {
      assert.ok(values.has(m[1]), `CommanderEvent.${m[1]} is not declared`)
      return values.get(m[1])
    })),
  }
}

// Commander events the browser reacts to: `cc-<event>` DOM listeners and the
// event_type checks inside useWebSocket's commander_event unwrap.
export function commanderEventsNeededByFrontend(all) {
  const needed = new Map()
  for (const file of walk(frontendSrc, (n) => /\.(jsx?|mjs)$/.test(n))) {
    const src = readFileSync(file, 'utf8')
    const rel = relative(root, file)
    for (const m of src.matchAll(/'cc-([a-z_]+)'/g)) if (all.has(m[1]) && !needed.has(m[1])) needed.set(m[1], rel)
    for (const m of src.matchAll(/\bevent_type\s*===\s*'([a-z_]+)'/g)) if (!needed.has(m[1])) needed.set(m[1], rel)
  }
  return needed
}

let cachedHandled = null
export function frontendHandledTypes() {
  if (cachedHandled) return cachedHandled
  const types = new Map()
  cachedHandled = types
  const files = walk(frontendSrc, (n) => /\.(jsx?|mjs)$/.test(n))
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    const rel = relative(root, file)
    for (const m of src.matchAll(/\b(?:data|msg|message|evt|payload)\??\.type\s*===\s*'([a-z][a-z0-9_]*)'/g)) {
      if (!types.has(m[1])) types.set(m[1], rel)
    }
    // switch(data.type) cases only count inside the socket hooks/handlers.
    if (/useWebSocket|wsEvents|globalEvents/.test(file)) {
      for (const m of src.matchAll(/\bcase\s+'([a-z][a-z0-9_]*)'\s*:/g)) {
        if (!types.has(m[1])) types.set(m[1], rel)
      }
    }
  }
  return types
}

test('every backend broadcast type has a frontend handler or an explicit ignore entry', () => {
  const sent = backendBroadcastTypes()
  const handled = frontendHandledTypes()
  assert.ok(sent.size > 30, `extractor found only ${sent.size} backend types; did the pattern break?`)
  const missing = [...sent].filter(([t]) => !handled.has(t) && !(t in IGNORED_BY_FRONTEND))
    .map(([t, where]) => `${t} (${where})`)
  assert.deepEqual(missing, [], 'unhandled backend WebSocket types; handle them or add to IGNORED_BY_FRONTEND with a reason')
})

test('every type the frontend waits for has a backend producer or a documented external one', () => {
  const sent = backendBroadcastTypes()
  const handled = frontendHandledTypes()
  const orphans = [...handled].filter(([t]) => !sent.has(t) && !(t in EXTERNAL_PRODUCERS))
    .map(([t, where]) => `${t} (${where})`)
  assert.deepEqual(orphans, [], 'frontend handles types nothing sends; remove the handler or document the producer')
})

test('allowlists do not hide stale entries', () => {
  const sent = backendBroadcastTypes()
  const handled = frontendHandledTypes()
  for (const t of Object.keys(IGNORED_BY_FRONTEND)) {
    assert.ok(sent.has(t), `${t} is ignored but no longer sent`)
    assert.ok(!handled.has(t), `${t} is ignored but now handled; drop the ignore entry`)
  }
  for (const t of Object.keys(EXTERNAL_PRODUCERS)) {
    assert.ok(!sent.has(t), `${t} now has an in-tree producer; drop the external entry`)
  }
})

test('session-guarded types always carry a top-level session_id', () => {
  const guarded = sessionGuardedTypes()
  const early = preGuardTypes()
  const reachesHandler = (site) => site.keys.has('session_id') || site.spreads || (
    early.has(site.type) && (!PRE_GUARD_REQUIRES[site.type] || site.keys.has(PRE_GUARD_REQUIRES[site.type])))
  const bad = backendBroadcastSites()
    .filter((site) => guarded.has(site.type) && !reachesHandler(site))
    .map((site) => `${site.type} (${site.where})`)
  assert.deepEqual(bad, [], 'these messages lack session_id and are dropped by the frontend guard')
})

test('dynamic producers still exist where documented', () => {
  for (const [t, { file, needle }] of Object.entries(DYNAMIC_PRODUCERS)) {
    assert.ok(readFileSync(join(root, file), 'utf8').includes(needle), `${t}: "${needle}" not found in ${file}`)
  }
})

test('commander events the frontend listens for are forwarded by the bus, and nothing else is', () => {
  const { all, forwarded } = forwardedCommanderEvents()
  const needed = commanderEventsNeededByFrontend(all)
  const missing = [...needed].filter(([t]) => !forwarded.has(t)).map(([t, where]) => `${t} (${where})`)
  assert.deepEqual(missing, [], 'add these to event_bus.CLIENT_EVENTS or the listener never fires')
  const unused = [...forwarded].filter((t) => !needed.has(t))
  assert.deepEqual(unused, [], 'CLIENT_EVENTS forwards events no frontend code listens for')
})

test('no DOM event is dispatched under a second dash-spelled alias', () => {
  for (const file of walk(frontendSrc, (n) => /\.(jsx?|mjs)$/.test(n))) {
    const src = readFileSync(file, 'utf8')
    assert.doesNotMatch(src, /'cc-'\s*\+\s*[\w.?]+\.replace\(\/_\/g,\s*'-'\)/, `${relative(root, file)} dispatches a dash alias`)
  }
})
