import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Use the real registries; only Vite's build-time extension metadata is stubbed.
const built = await build({
  stdin: { contents: `export {ACTIONS} from './src/lib/commandActions.js'; export {IA_GROUPS} from './src/lib/informationArchitecture.js';`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  plugins: [{ name: 'extension-metadata', setup(b) {
    b.onResolve({ filter: /^virtual:ive-extensions$/ }, () => ({ path: 'metadata', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const edition='integrated-dev';export const extensions=[];export const loaders={};` }))
  } }],
})
const module = { exports: {} }
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { ACTIONS, IA_GROUPS } = module.exports

test('every navigation surface has a registered action and renderable icon', () => {
  const commands = new Map(ACTIONS.map(action => [action.id, action]))
  for (const group of IA_GROUPS) for (const surface of group.surfaces) {
    assert.ok(commands.get(surface.id)?.icon, `Missing command/icon for ${group.id}/${surface.id}`)
  }
})

test('Mac power is reachable through Configure and command search', () => {
  assert.ok(IA_GROUPS.find(group => group.id === 'configure').surfaces.some(surface => surface.id === 'mac-power'))
  assert.equal(ACTIONS.filter(action => action.id === 'mac-power').length, 1)
})
