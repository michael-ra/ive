// Calls the real tag expansion without opening a browser or contacting a provider.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

test('@research uses the provider registry API contract without a legacy endpoint field', async () => {
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  globalThis.window = Object.assign(new EventTarget(), { location: { protocol: 'http:', host: 'localhost', hostname: 'localhost', search: '' } })
  globalThis.CustomEvent = class extends Event { constructor(type, options) { super(type); this.detail = options?.detail } }
  globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }
  const vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
  try {
    const useStore = (await vite.ssrLoadModule('/src/state/store.js')).default
    const { api } = await vite.ssrLoadModule('/src/lib/api.js')
    const { sendTerminalCommand } = await vite.ssrLoadModule('/src/lib/terminal.js')
    useStore.getState().loadSessions([{ id: 'research-contract', workspace_id: 'test-workspace', name: 'test', cli_type: 'claude', status: 'idle', pty_alive: true }])
    useStore.setState({ ws: null })
    let request
    api.startResearch = async (body) => { request = JSON.parse(JSON.stringify(body)); return { job_id: 'fake-job' } }
    sendTerminalCommand('research-contract', '@research explain this repository')
    assert.equal(request.query, 'explain this repository')
    assert.equal(request.workspace_id, 'test-workspace')
    assert.equal(Object.hasOwn(request, 'llm_url'), false, 'server rejects the legacy llm_url field even when its value is null')
  } finally { await vite.close() }
})
