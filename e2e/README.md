# IVE end-to-end test

Real backend (`backend/server.py`), real SQLite, real PTYs, real Chromium.
Nothing is mocked except the agent CLIs. Nothing touches your real home,
your real `~/.claude` / `~/.codex` / `~/.gemini`, any `.ive-team-state`,
the macOS Keychain, or ports 5111 / 5173 / 5183.

## Run

```sh
node e2e/run.mjs                    # from the repo root
# or
cd frontend && npm run test:e2e
```

Options (env vars):

| var | effect |
| --- | --- |
| `IVE_E2E_PORT` | backend port, default `5191` (5111/5173/5183 are refused) |
| `IVE_E2E_SKIP_BUILD=1` | reuse `frontend/dist` instead of rebuilding |
| `IVE_E2E_KEEP=1` | keep the sandbox directory for inspection |
| `IVE_E2E_HEADED=1` | show the browser |
| `IVE_E2E_PYTHON` | Python with the backend requirements (default: `.venv/bin/python` here, else the main checkout's `.venv`) |

`IVE_E2E_PORT=<port> node e2e/chat-context.mjs` runs the files-and-folders
chat context flow (@ picker, chips, drag and drop, load errors, the text the
fake Claude and Codex receive, 390 px) in its own sandbox.

Exit code 0 = every check passed. `node e2e/serve.mjs` starts the same
sandboxed backend and keeps it up until Ctrl-C, for poking at it by hand.

## What it does

1. Builds the frontend (`vite build --configLoader runner`, so nothing is
   written into a shared `node_modules`).
2. Creates a sandbox in the system temp dir (`$TMPDIR/ive-e2e-*`):
   `home/` (becomes `HOME`), `state/` (`IVE_DATA_DIR`), `tmp/` (`TMPDIR`),
   `bin/`, and a git repo `home/projects/demo-app`.
3. `bin/` is the first and only non-system entry on `PATH`:
   - `claude`, `gemini`: `fake-bin/fake_cli.py`, a tiny TUI. Prompt, echo,
     SIGWINCH repaint, and lifecycle hooks fired through whatever IVE
     installed into the fake `~/.claude/settings.json` (so the real relay,
     safety gate and AVCP hook scripts run). Type `ask <cmd>` for a
     permission request, then `1` to approve.
   - `codex`: `fake-bin/fake_codex.py`, a stand-in for codex-cli 0.162.1.
     Strict argv like clap (`-a` only `on-request|never`, unknown flags exit
     2), `resume <id>`, the rollout JSONL is written only at the first prompt
     in the 0.16x record shape, hooks from `~/.codex/config.toml` run only
     when `[hooks.state."<realpath CODEX_HOME>/config.toml:<event>:<g>:<h>"]`
     carries codex's own `trusted_hash` for that handler (otherwise the banner
     says "N hooks need review" and they are skipped, like the real CLI). `spawn <text>` also writes a subagent rollout.
   - `security` (Keychain), `osascript`, `open`: shims that log and do nothing.
   - Homebrew and `~/.local/bin` are not on `PATH`, so the real `claude` /
     `codex` cannot be found.
4. **Isolation preflight** (`isolation_check.py`) imports the backend config
   with the sandbox env and asserts every resolved path (data dir, DB, hook
   scripts, every CLI profile's home/settings, runtime homes, keyring, `which`
   results, API URLs) is inside the sandbox. If anything is outside, the
   backend is not started.
5. Starts the backend in its own process group with `--headless`, telemetry
   off, keyring disabled (`keyring.backends.fail.Keyring`), all HTTP proxies
   pointed at a closed port (no network, loopback excluded).
6. Drives Chromium through: onboarding, add workspace via project search,
   terminal board mode, create session, large + focused terminal, typing to
   the CLI, Working / Ready / Needs you in every place the UI shows status,
   ⌘⇧E Overview round trip (with PTY size checks), Home, `?` quick help,
   ⌘K, delete with confirmation.
7. Stats real files a leak would write before and after (`~/.claude/settings.json`,
   `~/.codex/config.toml`, `~/.gemini/settings.json`, `~/.ive`, and the
   `instance.json` + hook scripts of every `.ive-team-state` next to this
   checkout), fails if any changed, and fails if any of them mentions the
   sandbox path or port. `data.db` and `~/.claude.json` are not compared
   because a real IVE / Claude Code running at the same time changes them.
8. Kills the backend process group and every process whose command line
   contains the sandbox path (PTY children call `setsid`), then deletes the
   sandbox.

## Output (`e2e/out/`, gitignored)

`results.json`, numbered screenshots, `backend.log`, `backend-problems.txt`
(tracebacks / ERROR lines), `browser-errors.txt`, `fake-cli.log` (what the
CLI received, with step markers), `shim-calls.log`, `isolation.json`,
`guarded-paths.json`.

## Phone pairing (`e2e/phone-pairing.mjs`)

`IVE_E2E_PORT=5272 node e2e/phone-pairing.mjs` runs the same sandbox in
external-proxy mode behind a fake "cloudflared" (a local reverse proxy on
`PORT+1000` that stamps `Cf-Connecting-Ip`). The Mac is a desktop Chromium
context, the iPhone a WebKit iPhone 15 context that only reaches IVE through
the fake tunnel. It checks: unpaired phone rejected (page, API, WebSocket),
QR one-time link, pairing, single use, PIN lock, revoke. No real cloudflared.
Screenshots land in `e2e/out/phone/`.
