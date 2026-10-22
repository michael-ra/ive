// Phone pairing end to end, the tunnel path: a sandboxed backend in
// external-proxy mode with a fake "cloudflared" in front of it (a local
// reverse proxy that adds Cf-Connecting-Ip, exactly what IVE trusts from the
// real one). The Mac is a desktop Chromium context talking to the backend
// directly; the iPhone is a WebKit iPhone 15 context that only reaches IVE
// through the fake tunnel, so the backend treats it as a remote client.
// No real cloudflared, no LAN exposure (macOS blocks inbound LAN for
// unsigned binaries anyway; the LAN path is covered by test_phone_access.py).
//
//   IVE_E2E_PORT=5272 node e2e/phone-pairing.mjs
//   IVE_E2E_SKIP_BUILD=1 IVE_E2E_PORT=5272 node e2e/phone-pairing.mjs
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, openSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import net from 'node:net'
import { join } from 'node:path'
import {
  E2E_DIR, ROOT, createSandbox, portFree, removeSandbox, runIsolationCheck, startBackend, stopAll,
} from './sandbox.mjs'

const require = createRequire(join(ROOT, 'frontend', 'package.json'))
const { chromium, webkit, devices } = require('playwright')

const PORT = Number(process.env.IVE_E2E_PORT || 5272)
const TUNNEL_PORT = Number(process.env.IVE_E2E_TUNNEL_PORT || PORT + 1000)
const OUT = join(E2E_DIR, 'out', 'phone')
const MAC = `http://127.0.0.1:${PORT}`
const PHONE_BASE = `http://127.0.0.1:${TUNNEL_PORT}`
const PHONE_IP = '203.0.113.7'
const TOKEN = 'e2e-master-token-not-secret'
const APNS_PORT = Number(process.env.IVE_E2E_APNS_PORT || PORT + 2000)
const APNS_DEVICE_TOKEN = 'ab'.repeat(32)

const results = []
let shotNo = 0
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${String(detail).slice(0, 240)})` : ''}`)
  return !!ok
}
const shot = async (page, name) => {
  const file = join(OUT, `${String(++shotNo).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file }).catch(() => {})
  console.log(`     shot ${file}`)
  return file
}
async function step(name, fn) {
  console.log(`\n── ${name}`)
  try { await fn() } catch (err) { check(`${name}: no exception`, false, err?.message?.split('\n')[0]) }
}

// Fake cloudflared: forwards HTTP + WebSocket to the backend and stamps the
// edge header with the "phone's" address, overwriting any client copy.
function startFakeTunnel() {
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, 'cf-connecting-ip': PHONE_IP }
    const up = http.request({ host: '127.0.0.1', port: PORT, method: req.method, path: req.url, headers }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers)
      ur.pipe(res)
    })
    up.on('error', () => { res.writeHead(502); res.end() })
    req.pipe(up)
  })
  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(PORT, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() !== 'cf-connecting-ip') lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      }
      lines.push(`Cf-Connecting-Ip: ${PHONE_IP}`)
      up.write(lines.join('\r\n') + '\r\n\r\n')
      if (head?.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
  })
  return new Promise((resolve) => server.listen(TUNNEL_PORT, '127.0.0.1', () => resolve(server)))
}

// Fake APNs: records each push, answers 200 (or what `apnsReply` says).
const apnsCalls = []
let apnsReply = { status: 200, body: '' }
function startFakeApns() {
  const server = http.createServer((req, res) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => {
      apnsCalls.push({ path: req.url, headers: req.headers, body: data })
      res.writeHead(apnsReply.status, { 'content-type': 'application/json' })
      res.end(apnsReply.body)
    })
  })
  return new Promise((resolve) => server.listen(APNS_PORT, '127.0.0.1', () => resolve(server)))
}

async function waitReady(child) {
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`backend exited early with ${child.exitCode}`)
    try { if ((await fetch(`${MAC}/ready`)).ok) return } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('backend did not become ready')
}

if (!(await portFree(PORT)) || !(await portFree(TUNNEL_PORT)) || !(await portFree(APNS_PORT))) throw new Error(`port ${PORT}, ${TUNNEL_PORT} or ${APNS_PORT} busy`)
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
if (process.env.IVE_E2E_SKIP_BUILD !== '1' || !existsSync(join(ROOT, 'frontend/dist/index.html'))) {
  console.log('building frontend …')
  const r = spawnSync(process.execPath, [join(ROOT, 'frontend/node_modules/vite/bin/vite.js'), 'build', '--configLoader', 'runner', '--logLevel', 'warn'],
    { cwd: join(ROOT, 'frontend'), stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status || 1)
}

const sb = await createSandbox({ port: PORT })
const iso = runIsolationCheck(sb)
if (!iso.isolated) { console.error(JSON.stringify(iso, null, 2)); await removeSandbox(sb); process.exit(3) }
sb.env.IVE_APNS_TEST_ENDPOINT = `http://127.0.0.1:${APNS_PORT}`
const fakeApns = await startFakeApns()
const backend = startBackend(sb, openSync(join(OUT, 'backend.log'), 'w'), {
  extraArgs: [
    '--external-proxy', '--trusted-proxy-peer', '127.0.0.1/32', '--trusted-proxy-header', 'Cf-Connecting-Ip',
    '--token', TOKEN, '--public-url', PHONE_BASE,
  ],
})
let desktopBrowser, phoneBrowser, tunnel
try {
  await waitReady(backend)
  tunnel = await startFakeTunnel()
  desktopBrowser = await chromium.launch()
  phoneBrowser = await webkit.launch()
  const iphone = devices['iPhone 15']
  const quiet = () => {
    localStorage.setItem('cc-pwa-install-dismissed-v1', '1')
    localStorage.setItem('cc-soundEnabled', '0')
    localStorage.setItem('ive.onboarding.v1.owner', 'done')
  }
  const macCtx = await desktopBrowser.newContext({ viewport: { width: 1360, height: 900 } })
  await macCtx.addInitScript(quiet)
  const mac = await macCtx.newPage()
  mac.setDefaultTimeout(15000)
  const newPhone = async () => {
    const ctx = await phoneBrowser.newContext({ ...iphone })
    await ctx.addInitScript(quiet)
    const page = await ctx.newPage()
    page.setDefaultTimeout(15000)
    return page
  }
  const phone = await newPhone()
  let pairCode = null
  let pairUrl = null

  await step('unpaired phone is rejected (HTTP, API, WebSocket, PTY)', async () => {
    const res = await phone.goto(`${PHONE_BASE}/`)
    check('page load answers 401', res.status() === 401, res.status())
    check('connect page instead of the app', await phone.getByLabel('Pairing code').isVisible())
    const api = await phone.evaluate(async () => (await fetch('/api/sessions')).status)
    check('API answers 401', api === 401, api)
    const ws = await phone.evaluate((url) => new Promise((resolve) => {
      const s = new WebSocket(url)
      s.onopen = () => { s.send(JSON.stringify({ action: 'input', session_id: 'x', data: 'id\r' })); resolve('open') }
      s.onerror = () => resolve('error')
      s.onclose = () => resolve('closed')
      setTimeout(() => resolve('timeout'), 5000)
    }), `ws://127.0.0.1:${TUNNEL_PORT}/ws`)
    check('WebSocket refused (no PTY input possible)', ws === 'error' || ws === 'closed', ws)
    const bad = await phone.evaluate(async () => (await fetch('/api/phone/pair/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'AAAA-AAAA' }),
    })).status)
    check('made-up code refused', bad === 401, bad)
    await shot(phone, 'phone-unpaired-connect-page')
  })

  await step('Mac: sign in (tunnel mode drops loopback trust) → Settings → pairing QR', async () => {
    const first = await mac.goto(MAC)
    check('Mac without a session also gets the connect page', first.status() === 401, first.status())
    await mac.locator('summary').click()
    await mac.locator('input[name="token"]').fill(TOKEN)
    await mac.getByRole('button', { name: 'Sign in' }).click()
    await mac.waitForURL(`${MAC}/`)
    await mac.waitForFunction(() => document.querySelector('#root')?.children.length > 0)
    await mac.waitForTimeout(800)
    await mac.evaluate(() => window.dispatchEvent(new CustomEvent('open-panel', { detail: { panel: 'phone-access' } })))
    await mac.locator('[data-phone-panel="mac"]').waitFor()
    await shot(mac, 'mac-phone-settings')
    const start = mac.locator('[data-phone-pair-start]')
    check('pair button enabled (phone-reachable address known)', await start.isEnabled())
    await start.click()
    const box = mac.locator('[data-phone-pair-code]')
    await box.waitFor()
    pairCode = await box.getAttribute('data-phone-pair-code')
    pairUrl = await mac.locator('[data-phone-qr]').getAttribute('data-phone-qr')
    check('QR carries a one-time link with the code in the fragment', pairUrl?.endsWith(`/pair#${pairCode}`), pairUrl)
    await shot(mac, 'mac-pairing-qr')
  })

  await step('Mac-only: unpaired phone cannot mint codes', async () => {
    const r = await phone.evaluate(async () => (await fetch('/api/phone/pair/start', { method: 'POST' })).status)
    check('pair/start from remote refused', r === 401, r)
    const spoof = await phone.evaluate(async () => (await fetch('/api/sessions', { headers: { 'Cf-Connecting-Ip': '127.0.0.1' } })).status)
    check('spoofed edge header does not help', spoof === 401 || spoof === 429, spoof)
  })

  await step('phone scans the QR → paired', async () => {
    // The QR names the Mac's primary LAN address; reach the same backend via ours.
    check('QR points at the phone-reachable address', pairUrl.startsWith(`${PHONE_BASE}/pair#`), pairUrl)
    await phone.goto(pairUrl)
    await phone.getByRole('heading', { name: 'Connected' }).waitFor()
    check('connected view', true)
    check('Home Screen hint shown on iPhone Safari', await phone.locator('#ios-hint').isVisible())
    check('code removed from the address bar', !phone.url().includes(pairCode), phone.url())
    await shot(phone, 'phone-paired')
    const cookies = await phone.context().cookies()
    const sess = cookies.find((c) => c.name === 'ive_session')
    check('device credential is an httpOnly cookie', sess?.httpOnly === true && sess?.sameSite === 'Strict', JSON.stringify(sess && { httpOnly: sess.httpOnly, sameSite: sess.sameSite, expires: sess.expires }))
    check('credential is long-lived (> 30 days)', sess && sess.expires * 1000 - Date.now() > 30 * 86400 * 1000)
    await phone.getByRole('button', { name: 'Open IVE' }).click()
    await phone.waitForFunction(() => document.querySelector('#root')?.children.length > 0)
    await phone.waitForTimeout(1500)
    const who = await phone.evaluate(async () => (await (await fetch('/api/whoami')).json()))
    check('phone is an owner device', who.actor_kind === 'owner_device' && who.is_owner, JSON.stringify(who))
    await shot(phone, 'phone-app-overview')
    const ws = await phone.evaluate((url) => new Promise((resolve) => {
      const s = new WebSocket(url)
      s.onopen = () => { resolve('open'); s.close() }
      s.onerror = () => resolve('error')
      setTimeout(() => resolve('timeout'), 5000)
    }), `ws://127.0.0.1:${TUNNEL_PORT}/ws`)
    check('WebSocket opens for the paired phone', ws === 'open', ws)
    const token = await phone.evaluate(async () => (await (await fetch('/api/runtime/status')).json()).tunnel?.token ?? null)
    check('master token never handed to the phone', token === null, token)
    const mint = await phone.evaluate(async () => (await fetch('/api/phone/pair/start', { method: 'POST' })).status)
    check('paired phone still cannot mint pairing codes', mint === 403, mint)
  })

  await step('code is single use', async () => {
    const other = await newPhone()
    await other.goto(`${PHONE_BASE}/pair#${pairCode}`)
    await other.locator('#pair-msg.err').waitFor()
    check('second phone with the same code refused', (await other.locator('#pair-msg').innerText()).includes('wrong, used or expired'))
    await shot(other, 'phone-reused-code')
    await other.context().close()
  })

  await step('Mac sees the device; foreign origin refused', async () => {
    await mac.locator('[data-phone-paired-ok]').waitFor()
    const rows = await mac.locator('[data-phone-device]').count()
    check('device listed under Paired devices', rows === 1, rows)
    await shot(mac, 'mac-device-listed')
    const direct = await fetch(`${MAC}/api/phone/pair/start`, { method: 'POST', headers: { Origin: 'https://evil.example' } })
    check('cross-origin POST refused', direct.status === 403, direct.status)
  })

  await step('PIN lock on the phone', async () => {
    await mac.locator('[data-phone-pin-input]').fill('294817')
    await mac.locator('[data-phone-pin-save]').click()
    await mac.getByText(/^On\. A paired phone locks/).waitFor()
    await phone.reload()
    await phone.getByRole('heading', { name: 'IVE is locked' }).waitFor()
    await shot(phone, 'phone-locked')
    await phone.locator('#pin').fill('111222')
    await phone.locator('#unlock-btn').click()
    await phone.locator('#unlock-msg.err').waitFor()
    check('wrong PIN refused', (await phone.locator('#unlock-msg').innerText()).startsWith('Wrong PIN'))
    await phone.locator('#pin').fill('294817')
    await phone.locator('#unlock-btn').click()
    await phone.waitForFunction(() => document.querySelector('#root')?.children.length > 0)
    const st = await phone.evaluate(async () => (await (await fetch('/api/phone/status')).json()))
    check('unlocked with the right PIN', st.locked === false, JSON.stringify(st))
  })

  await step('phone: its own settings page, Lock now → in-app PIN overlay', async () => {
    await phone.waitForTimeout(800)
    await phone.evaluate(() => window.dispatchEvent(new CustomEvent('open-panel', { detail: { panel: 'phone-access' } })))
    await phone.locator('[data-phone-panel="device"]').waitFor()
    check('phone sees the device view (no pairing controls)', await phone.locator('[data-phone-pair-start]').count() === 0)
    await shot(phone, 'phone-settings-this-phone')
    await phone.getByRole('button', { name: 'Lock now' }).click()
    await phone.locator('[data-phone-lock]').waitFor()
    const blocked = await phone.evaluate(async () => (await fetch('/api/sessions')).status)
    check('locked phone gets 423 from the API', blocked === 423, blocked)
    await shot(phone, 'phone-lock-overlay')
    await phone.locator('[data-phone-lock-input]').fill('294817')
    await phone.getByRole('button', { name: 'Unlock' }).click()
    await phone.locator('[data-phone-lock]').waitFor({ state: 'detached' })
    const ok = await phone.evaluate(async () => (await fetch('/api/sessions')).status)
    check('overlay unlock restores access', ok === 200, ok)
  })

  await step('native push: phone app registers, Mac adds the .p8 key, test push, 410 cleanup', async () => {
    // What the iOS app does after each page load (WebModel.sendPushToken).
    const reg = await phone.evaluate(async (token) => {
      const r = await fetch('/api/phone/apns-token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, environment: 'sandbox', bundle_id: 'eu.aiforeu.ive', device: 'iPhone' }) })
      return { status: r.status, body: await r.json() }
    }, APNS_DEVICE_TOKEN)
    check('paired phone registers its APNs token', reg.status === 200 && reg.body.apns_configured === false, JSON.stringify(reg))
    const macReg = await mac.evaluate(async () => (await fetch('/api/phone/apns-token', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'ab'.repeat(32), environment: 'sandbox' }) })).status)
    check('the Mac itself cannot register a token', macReg === 403, macReg)

    await mac.evaluate(() => window.dispatchEvent(new CustomEvent('open-panel', { detail: { panel: 'phone-access' } })))
    const section = mac.locator('[data-apns-section]')
    await section.waitFor()
    check('section starts "off"', await section.getAttribute('data-apns-section') === 'off')
    check('Team ID prefilled', await mac.locator('[data-apns-team-id]').inputValue() === '66Y43UAY3C')
    check('Bundle ID prefilled', await mac.locator('[data-apns-bundle-id]').inputValue() === 'eu.aiforeu.ive')
    await section.scrollIntoViewIfNeeded()
    await shot(mac, 'mac-native-push-off')

    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
    await mac.locator('[data-apns-file]').setInputFiles({ name: 'AuthKey_ABCDE12345.p8', mimeType: 'application/octet-stream', buffer: Buffer.from(pem) })
    await mac.waitForFunction(() => document.querySelector('[data-apns-key-id]')?.value === 'ABCDE12345')
    check('Key ID taken from the file name', true)
    await mac.locator('[data-apns-save]').click()
    await mac.locator('[data-apns-section="configured"]').waitFor()
    const statusText = await mac.locator('[data-apns-status]').innerText()
    check('status shows the Key ID', statusText.includes('ABCDE12345'), statusText)
    const page = await mac.content()
    check('key material never comes back to the page', !page.includes('PRIVATE KEY'))
    const row = mac.locator(`[data-apns-registered="yes"]`)
    await row.waitFor()
    check('device row says registered (sandbox)', /sandbox/.test(await row.innerText()), await row.innerText())

    await mac.locator('[data-apns-test]').first().click()
    await mac.locator('[data-apns-note]').waitFor()
    const call = apnsCalls.at(-1)
    check('fake APNs got one push for the token', call && call.path === `/3/device/${APNS_DEVICE_TOKEN}`, call?.path)
    check('apns-topic + apns-push-type headers', call?.headers['apns-topic'] === 'eu.aiforeu.ive' && call?.headers['apns-push-type'] === 'alert',
      JSON.stringify(call?.headers))
    check('ES256 bearer JWT with kid', (() => {
      try {
        const jwt = call.headers.authorization.replace(/^bearer /, '')
        const head = JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString())
        return head.alg === 'ES256' && head.kid === 'ABCDE12345'
      } catch { return false }
    })())
    check('payload is an alert', JSON.parse(call?.body || '{}').aps?.alert?.title === 'IVE', call?.body)
    await shot(mac, 'mac-native-push-test-sent')

    apnsReply = { status: 410, body: JSON.stringify({ reason: 'Unregistered' }) }
    await mac.locator('[data-apns-test]').first().click()
    await mac.locator('[data-apns-error]').waitFor()
    await mac.locator('[data-apns-registered="no"]').waitFor()
    check('410 Unregistered removes the token', true)
    apnsReply = { status: 200, body: '' }
    await shot(mac, 'mac-native-push-410')

    // Register again so the revoke step below also proves the token goes.
    await phone.evaluate(async (token) => fetch('/api/phone/apns-token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, environment: 'sandbox' }) }), APNS_DEVICE_TOKEN)
  })

  await step('revoke on the Mac → phone is out', async () => {
    mac.once('dialog', (d) => d.accept())
    await mac.locator('[data-phone-revoke]').first().click()
    await mac.waitForFunction(() => document.querySelectorAll('[data-phone-device]').length === 0)
    const res = await phone.reload()
    check('phone back to the connect page', [401, 429].includes(res.status()) && await phone.getByLabel('Pairing code').isVisible(), res.status())
    const api = await phone.evaluate(async () => (await fetch('/api/sessions')).status)
    check('API refuses the revoked phone', api === 401 || api === 429, api)
    await shot(phone, 'phone-after-revoke')
    await shot(mac, 'mac-after-revoke')
    const ap = await mac.evaluate(async () => (await (await fetch('/api/phone/apns')).json()))
    check('revoked phone has no APNs token left', (ap.devices || []).length === 0, JSON.stringify(ap.devices))
    const before = apnsCalls.length
    await mac.evaluate(async () => fetch('/api/phone/apns/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))
    check('no push goes to the revoked phone', apnsCalls.length === before, apnsCalls.length - before)
  })
} finally {
  tunnel?.close()
  fakeApns?.close()
  await desktopBrowser?.close().catch(() => {})
  await phoneBrowser?.close().catch(() => {})
  const left = await stopAll(sb, backend)
  if (process.env.IVE_E2E_KEEP !== '1') await removeSandbox(sb)
  console.log(`\nbackend stopped (leftover pids: ${left.join(',') || 'none'})`)
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
