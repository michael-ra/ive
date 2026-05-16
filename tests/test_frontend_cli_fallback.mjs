// Behavior-preservation guard for the constants.js CLI refactor.
// No store is available outside the app, so getters use the static
// fallback path — exactly what must stay identical for claude/gemini/codex.
//
// Baseline history: captured pre-refactor, then regenerated ONCE during the
// single-source CLI_FALLBACK refactor (2026-05-15). Verified diff at that
// point: all three real CLIs (claude/gemini/codex) byte-identical across
// every getter; the ONLY change was the synthetic 'unknown' pseudo-CLI's
// getEffortLevelsForCli ([] -> Claude's levels), an intentional consistency
// fix — unknown now degrades uniformly to Claude (it already did for
// models/permission/default_model/theme; effort was the lone inconsistency).
// No real cli_type is ever 'unknown'. Any future diff = real regression.
import assert from 'node:assert/strict'
import * as C from '../frontend/src/lib/constants.js'

const clis = ['claude', 'gemini', 'codex', 'unknown']
const getters = [
  'getModelsForCli', 'getPermissionModesForCli', 'getEffortLevelsForCli',
  'getDefaultModel', 'getDefaultPermissionMode', 'getCliShortLabel',
  'getCliBadgeClass', 'getCliSelectedClass', 'getCliSubtleClass',
]
const snap = {}
for (const g of getters) {
  for (const c of clis) {
    snap[`${g}:${c}`] = typeof C[g] === 'function' ? C[g](c) : '<<missing>>'
  }
}
snap['CLI_TYPES'] = C.CLI_TYPES
snap['cap:force_send:claude'] = C.getCliCapability('claude', 'force_send')
snap['cap:terminal_input:codex'] = C.getCliCapability('codex', 'terminal_input')
snap['cap:terminal_input:gemini'] = C.getCliCapability('gemini', 'terminal_input')
snap['cap:terminal_input:claude'] = C.getCliCapability('claude', 'terminal_input')

const fs = await import('node:fs')
const path = new URL('./.cli_fallback_baseline.json', import.meta.url)
if (process.argv.includes('--write')) {
  fs.writeFileSync(path, JSON.stringify(snap, null, 2))
  console.log('baseline written')
} else {
  const base = JSON.parse(fs.readFileSync(path, 'utf8'))
  assert.deepEqual(snap, base, 'getter outputs changed vs baseline')
  console.log('cli fallback snapshot: OK')
}
