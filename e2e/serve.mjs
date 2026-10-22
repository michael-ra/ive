// Start the sandboxed IVE backend and keep it up until Ctrl-C (manual poking).
// Same isolation as run.mjs; the sandbox is deleted on exit.
//   node e2e/serve.mjs            # port 5191
import { openSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { E2E_DIR, createSandbox, portFree, removeSandbox, runIsolationCheck, startBackend, stopAll, waitForHealth } from './sandbox.mjs'

const port = Number(process.env.IVE_E2E_PORT || 5191)
if (!(await portFree(port))) throw new Error(`port ${port} busy`)
const out = join(E2E_DIR, 'out')
await mkdir(out, { recursive: true })
const sb = await createSandbox({ port })
const report = runIsolationCheck(sb)
if (!report.isolated) { console.error(JSON.stringify(report, null, 2)); await removeSandbox(sb); process.exit(3) }
const child = startBackend(sb, openSync(join(out, `serve-backend-${port}.log`), 'w'))
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  const left = await stopAll(sb, child)
  if (process.env.IVE_E2E_KEEP !== '1') await removeSandbox(sb)
  console.log(`stopped (leftover pids: ${left.join(',') || 'none'})`)
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
await waitForHealth(port, child)
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}/`, sandbox: sb.root, workspace: sb.workspace }))
