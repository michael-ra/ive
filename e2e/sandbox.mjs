// Throwaway sandbox for the IVE end-to-end run: fake HOME, fake CLIs, own
// state dir, own port. Nothing here may point at the operator's real home,
// real ~/.claude/.codex/.gemini or the real .ive-team-state.
import { spawn, spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const E2E_DIR = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(E2E_DIR, '..')
export const FORBIDDEN_PORTS = new Set([5111, 5173, 5183])
export const REAL_HOME = os.userInfo().homedir

// Real files that a leaking sandbox run would write (hook installation,
// backend startup) but that normal concurrent use leaves alone. Their stat is
// compared before/after and their content must never mention the sandbox.
// data.db and ~/.claude.json are deliberately not stat-compared: a real IVE
// or Claude Code running at the same time changes them legitimately.
export function guardedRealPaths() {
  const list = [
    join(REAL_HOME, '.claude', 'settings.json'), join(REAL_HOME, '.codex', 'config.toml'),
    join(REAL_HOME, '.gemini', 'settings.json'), join(REAL_HOME, '.ive'),
  ]
  const projects = resolve(ROOT, '..')
  const stateDirs = [join(ROOT, '.ive-team-state'), resolve(projects, '..', 'ive-team', '.ive-team-state')]
  try { for (const name of readdirSync(projects)) stateDirs.push(join(projects, name, '.ive-team-state')) } catch {}
  for (const state of new Set(stateDirs)) {
    // The state dir itself is not compared: a running real IVE creates
    // SQLite journal files in it all the time.
    list.push(join(state, 'instance.json'), join(state, 'hooks'), join(state, 'hooks', 'hook.sh'),
      join(state, 'hooks', 'safety_gate.sh'), join(state, 'hooks', 'safety_gate_post.sh'))
  }
  return [...new Set(list)]
}

export function snapshot(paths) {
  const out = {}
  for (const p of paths) {
    try { const s = statSync(p); out[p] = `${s.size}:${s.mtimeMs}` } catch { out[p] = 'missing' }
  }
  return out
}

// Real files (not dirs) whose content mentions the sandbox root or port.
export function mentionsSandbox(paths, sb) {
  const hits = []
  for (const p of paths) {
    try {
      if (!statSync(p).isFile()) continue
      const text = readFileSync(p, 'utf8')
      if (text.includes(sb.root) || text.includes(`:${sb.port}`)) hits.push(p)
    } catch {}
  }
  return hits
}

export function portFree(port) {
  return new Promise((done) => {
    const server = net.createServer()
    server.once('error', () => done(false))
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)))
  })
}

export function pythonPath() {
  const candidates = [process.env.IVE_E2E_PYTHON, join(ROOT, '.venv/bin/python'),
    resolve(ROOT, '..', '..', 'ive-team', '.venv/bin/python')].filter(Boolean)
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error(`No IVE Python found (tried ${candidates.join(', ')}); set IVE_E2E_PYTHON`)
  return found
}

export async function createSandbox({ port }) {
  if (FORBIDDEN_PORTS.has(port)) throw new Error(`Port ${port} belongs to a real IVE/Vite; refusing`)
  const root = await realpath(await mkdtemp(join(os.tmpdir(), 'ive-e2e-')))
  if (root === REAL_HOME || root.startsWith(REAL_HOME + '/')) throw new Error(`Sandbox ${root} is inside the real home`)
  const sb = {
    root, port,
    home: join(root, 'home'),
    bin: join(root, 'bin'),
    state: join(root, 'state'),
    tmp: join(root, 'tmp'),
    workspace: join(root, 'home', 'projects', 'demo-app'),
  }
  for (const dir of [sb.home, sb.bin, sb.state, sb.tmp, sb.workspace]) await mkdir(dir, { recursive: true })

  // Fake CLIs (same script, behaviour chosen by argv[0]).
  const fake = join(E2E_DIR, 'fake-bin', 'fake_cli.py')
  for (const name of ['claude', 'gemini']) {
    await copyFile(fake, join(sb.bin, name))
    await chmod(join(sb.bin, name), 0o755)
  }
  // Fake codex-cli 0.162.1: strict argv, lazy 0.16x rollouts, trust-gated hooks.
  await copyFile(join(E2E_DIR, 'fake-bin', 'fake_codex.py'), join(sb.bin, 'codex'))
  await chmod(join(sb.bin, 'codex'), 0o755)
  // Shims for host integrations that could reach real user state.
  const shim = (name, body) => writeFile(join(sb.bin, name), `#!/bin/sh\necho "$(date +%T) ${name} $*" >> "$HOME/shim-calls.log"\n${body}\n`, { mode: 0o755 })
  await shim('security', 'exit 44')      // macOS Keychain: "item not found"
  await shim('osascript', 'exit 1')      // no Terminal/iTerm automation
  await shim('open', 'exit 0')           // no Finder/browser launches
  // Node is needed by frontend tooling the backend may call; the real
  // Homebrew dir is NOT on PATH (it also holds real CLIs).
  const node = process.execPath
  await symlink(node, join(sb.bin, 'node'))

  // Fake HOME basics: git identity, shell rc files that do nothing.
  await writeFile(join(sb.home, '.gitconfig'), '[user]\n\tname = IVE E2E\n\temail = e2e@example.invalid\n[init]\n\tdefaultBranch = main\n')
  await writeFile(join(sb.home, '.zshrc'), '')
  await writeFile(join(sb.home, '.bashrc'), '')

  sb.env = sandboxEnv(sb)
  // Workspace: a tiny git repo inside the sandbox.
  await writeFile(join(sb.workspace, 'README.md'), '# demo-app\n\nE2E sandbox workspace.\n')
  await writeFile(join(sb.workspace, 'package.json'), '{"name":"demo-app","version":"0.0.0"}\n')
  for (const args of [['init', '-q'], ['add', '.'], ['commit', '-qm', 'init']]) {
    const r = spawnSync('git', args, { cwd: sb.workspace, env: sb.env, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  }
  return sb
}

export function sandboxEnv(sb) {
  const api = `http://127.0.0.1:${sb.port}`
  const env = {
    PATH: [sb.bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: sb.home,
    USER: process.env.USER || 'e2e', LOGNAME: process.env.LOGNAME || 'e2e',
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
    SHELL: '/bin/zsh', TERM: 'xterm-256color',
    TMPDIR: sb.tmp + '/', TMP: sb.tmp, TEMP: sb.tmp,
    XDG_CONFIG_HOME: join(sb.home, '.config'), XDG_CACHE_HOME: join(sb.home, '.cache'),
    XDG_DATA_HOME: join(sb.home, '.local', 'share'), XDG_STATE_HOME: join(sb.home, '.local', 'state'),
    // Same product selection the launcher (tools/ive_team.py) passes.
    IVE_ROOT: ROOT, IVE_EDITION: 'integrated-dev', IVE_EXTENSIONS: 'sandbox',
    IVE_EXTENSION_PATHS: join(ROOT, 'extensions'), IVE_NATIVE_MEMORY_OPT_IN: '1',
    IVE_DATA_DIR: sb.state, IVE_APP_CONTAINER_STATE: join(sb.state, 'app-containers'),
    COMMANDER_PORT: String(sb.port), COMMANDER_HOST: '127.0.0.1',
    COMMANDER_API_URL: api, IVE_BASE_URL: api, IVE_API_URL: api,
    IVE_TELEMETRY: 'off',
    PYTHON_KEYRING_BACKEND: 'keyring.backends.fail.Keyring',
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
    PLAYWRIGHT_BROWSERS_PATH: join(sb.state, 'browsers'),
    PIP_CONFIG_FILE: '/dev/null', PIP_NO_INPUT: '1',
    NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: join(sb.state, 'npm-globalrc'),
    NPM_CONFIG_CACHE: join(sb.state, 'npm-cache'),
    GIT_CONFIG_NOSYSTEM: '1',
    // No outbound network: every proxied client hits a closed port; loopback stays direct.
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  }
  return env
}

export function runIsolationCheck(sb) {
  const py = pythonPath()
  const r = spawnSync(py, ['-s', join(E2E_DIR, 'isolation_check.py'), sb.root, REAL_HOME, join(ROOT, 'backend')],
    { cwd: sb.tmp, env: sb.env, encoding: 'utf8', timeout: 120000 })
  let report
  try { report = JSON.parse(r.stdout) } catch { report = { isolated: false, problems: ['isolation check crashed'], stdout: r.stdout, stderr: r.stderr } }
  report.exitCode = r.status
  report.stderr = (r.stderr || '').slice(-4000)
  if (r.status !== 0) report.isolated = false
  return report
}

export function startBackend(sb, logFile, { host = '127.0.0.1', extraArgs = [] } = {}) {
  const py = pythonPath()
  const args = ['-s', join(ROOT, 'backend', 'server.py'), '--headless', '--host', host, '--port', String(sb.port), ...extraArgs]
  const child = spawn(py, args, { cwd: join(ROOT, 'backend'), env: sb.env, detached: true, stdio: ['ignore', logFile, logFile] })
  return child
}

export async function waitForHealth(port, child, timeoutMs = 90000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`backend exited early with ${child.exitCode}`)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/whoami`)
      if (res.ok) return await res.json()
    } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('backend did not become healthy in time')
}

function processesUnder(root) {
  const r = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  return (r.stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.includes(root))
    .map((l) => Number(l.split(/\s+/, 1)[0])).filter((pid) => pid && pid !== process.pid)
}

export async function stopAll(sb, child) {
  const kill = (pid, sig) => { try { process.kill(pid, sig) } catch {} }
  if (child && child.pid) {
    kill(-child.pid, 'SIGTERM')
    for (let i = 0; i < 40 && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 150))
    kill(-child.pid, 'SIGKILL')
  }
  // PTY children call setsid(), so they are not in the backend's group.
  // Every one of them runs a binary from, or has argv inside, the sandbox.
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    for (const pid of processesUnder(sb.root)) { kill(-pid, sig); kill(pid, sig) }
    await new Promise((r) => setTimeout(r, 400))
  }
  return processesUnder(sb.root)
}

export async function removeSandbox(sb) {
  if (!sb?.root || !sb.root.includes('ive-e2e-') || sb.root.startsWith(REAL_HOME + '/')) return
  await rm(sb.root, { recursive: true, force: true })
}

export { readFile, stat }
