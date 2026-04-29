# Installing IVE

IVE — the Integrated Vibecoding Environment — runs entirely on your laptop.
There is no cloud account, no signup, no telemetry-by-default. The promise
is simple: clone the repo and run `./start.sh`.

## Prerequisites

You need three things on your `$PATH`:

| Tool | Minimum | Why |
|------|---------|-----|
| **git** | any modern | Cloning the repo and worktree-based features |
| **Python** | 3.11+ | Backend (aiohttp + sqlite + PTY orchestration) |
| **Node.js** | 20+ | Frontend (Vite 8 + React 19) and the `npx ive` launcher |

That's it. Everything else either ships in the repo or is installed
automatically the first time `./start.sh` runs. The first launch prints a
checklist of every tool it found (and what's missing).

### Optional extras

These are detected at runtime and only matter if you use the matching
feature. IVE will run without them — `start.sh` warns but does not exit.

| Tool | Used by |
|------|---------|
| **claude** CLI ([install](https://docs.anthropic.com/claude-code)) | Claude Code sessions |
| **gemini** CLI ([install](https://github.com/google-gemini/gemini-cli)) | Gemini CLI sessions |
| **cloudflared** | `--tunnel` mode (auto-installed via brew/apt when needed) |
| **ffmpeg** | Documentor's GIF recording (`brew install ffmpeg` / `apt install ffmpeg`) |
| **sqlite3** CLI | Auto-update-CLI setting (gracefully skipped if missing) |
| **Playwright Chromium** | Screenshots, live preview, browser-based OAuth |
| **fastembed ONNX weights** | Semantic search, coordination, dense retrieval |

`start.sh` pre-fetches both the Playwright Chromium binary (~150MB) and
the fastembed model weights (~56MB total — `BAAI/bge-small-en-v1.5` plus
the `Xenova/ms-marco-MiniLM-L-6-v2` cross-encoder reranker) automatically
once the Python wheels are installed. Each is gated by a stamp file
(`~/.ive/.playwright-installed`, `~/.ive/.embeddings-installed`) so
subsequent launches are no-ops.

To re-run an install manually:

```bash
# Chromium
~/.ive/venv/bin/python3 -m playwright install chromium
# or, if you're not using the venv:
python3 -m playwright install chromium

# fastembed weights (re-warm both models)
rm -f ~/.ive/.embeddings-installed && ./start.sh
```

### How `start.sh` handles Python deps (PEP 668)

Modern macOS (Homebrew Python) and Debian/Ubuntu mark the system Python
as "externally managed" — `pip install` into it is refused. `start.sh`
detects this with a dry-run probe and, if needed, creates a private venv
at `~/.ive/venv` on first launch, then installs `backend/requirements.txt`
into it. The backend is then started with `~/.ive/venv/bin/python3`. If
the system Python *is* writable (older systems, custom builds, an active
virtualenv, etc.) the script uses it directly and skips the venv.

A successful dependency check is cached at
`~/.ive/.deps-checked.<hash>` so subsequent launches are an instant
no-op. The hash covers `backend/requirements.txt`, `frontend/package.json`,
and `start.sh` itself. To force a fresh check:

```bash
./start.sh --recheck-deps
# or:
rm -f ~/.ive/.deps-checked.*
```

## Quickstart — clone and go

```bash
git clone https://github.com/michael-ra/ive.git
cd ive
./start.sh
```

`start.sh` will, in order:

1. Run a one-time dependency check (Python, Node, pip, sqlite3, ffmpeg,
   git, Claude/Gemini CLIs). Required tools fail fast with an install
   hint; optional tools warn and continue. The result is cached.
2. Bootstrap a venv at `~/.ive/venv` if the system Python refuses pip
   installs (PEP 668), otherwise use system pip.
3. Auto-update the `claude` / `gemini` CLIs if you have them and the
   `auto_update_cli` setting is on.
4. Install `backend/requirements.txt` into the chosen interpreter
   (skipped if up to date).
5. Run `playwright install chromium` once and stamp it.
6. Pre-fetch the fastembed ONNX weights (`BAAI/bge-small-en-v1.5` +
   cross-encoder reranker, ~56MB total) once and stamp it. Skipped if
   `fastembed` isn't installed; warns and continues if the download
   fails (lazy load takes over on first use).
7. `npm install` in `frontend/` (skipped if `node_modules/` exists).
8. Free ports `5111` and `5173` of any stale processes.
9. Start the backend on `http://127.0.0.1:5111`.
10. Start the Vite dev server on `http://localhost:5173` and open it.

Press `Ctrl+C` to shut down both processes cleanly.

## Run modes

```bash
./start.sh                     # Local dev mode (default)
./start.sh --multiplayer       # Production build, served from backend, auth-token gated
./start.sh --tunnel            # --multiplayer + a Cloudflare quick tunnel
./start.sh --headless          # Don't open the browser on startup
./start.sh --port 6000         # Override backend port (default 5111)
./start.sh --host 0.0.0.0      # Bind to all interfaces (implied by --multiplayer)
./start.sh --token MYTOKEN     # Set the auth token (auto-generated otherwise)
```

## npx alternative

If you'd rather not clone the repo first, the npm-published launcher does
both steps in one:

```bash
npx ive                # Clones (or updates) and runs in --multiplayer mode
npx ive --tunnel       # Same, plus a public Cloudflare tunnel
```

The launcher writes its working copy to `~/.ive/repo`. Subsequent runs
do `git pull` instead of re-cloning.

## What lives where

| Path | Contents |
|------|----------|
| `~/.ive/data.db` | SQLite database (workspaces, sessions, tasks, memory, …) |
| `~/.ive/token` | Auth token used in `--multiplayer` and `--tunnel` modes |
| `~/.ive/repo` | Working copy used by `npx ive` (only created if you use npx) |
| `~/.ive/venv` | Private Python venv (only created when system pip is externally-managed) |
| `~/.ive/.deps-checked.<hash>` | Stamp from the dependency check; delete to re-run |
| `~/.ive/.playwright-installed` | Stamp marking that Chromium is downloaded |
| `~/.ive/.embeddings-installed` | Stamp marking that fastembed ONNX weights are pre-fetched |
| `backend/.deps-installed` | Stamp from `pip install` (when not using the venv) |
| `frontend/node_modules` | npm packages — delete to force a clean reinstall |
| `frontend/dist` | Production build (only created in `--multiplayer` mode) |

Nothing leaves your machine unless you explicitly enable the Cloudflare
tunnel.

## Troubleshooting

### `python3: command not found` or `Python version too old`

IVE needs Python 3.11+. Check with `python3 --version`. On macOS:

```bash
brew install python@3.12
```

On Ubuntu/Debian:

```bash
sudo apt-get install python3.12 python3.12-venv
```

### `npm: command not found` or Node too old

IVE needs Node 20+. Check with `node --version`.

```bash
# nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
nvm install 20
nvm use 20

# or via Homebrew
brew install node@20
```

### Port 5111 or 5173 already in use

`start.sh` calls `lsof -ti :5111 | xargs kill -9` automatically before
starting. If a different app actually owns the port and you can't free it,
override the backend port:

```bash
./start.sh --port 6000
```

The frontend dev server (5173) is set in `frontend/vite.config.js`. If you
need to change it, edit that file.

### `pip3 install` fails on `fastembed`

`fastembed` pulls in ONNX runtime and some platform-specific wheels.
On older Linux distros without a recent `glibc`, the wheel download can
fail. IVE works without `fastembed` — embedding-backed search silently
falls back to keyword search. To skip it:

```bash
# Use the venv pip if start.sh created one, otherwise system pip.
~/.ive/venv/bin/pip install aiohttp aiosqlite     # if the venv exists
pip3 install aiohttp aiosqlite                    # otherwise
./start.sh
```

(Comment out the `fastembed` line in `backend/requirements.txt` to keep
`start.sh` from re-trying.)

### `error: externally-managed-environment` when running pip yourself

`start.sh` handles this for you by creating `~/.ive/venv`. If you're
running pip directly, either activate the venv first
(`source ~/.ive/venv/bin/activate`) or use a `--user` install /
`--break-system-packages` if you really mean to write into the system
Python.

### Screenshots / live preview say "Chromium not installed"

Playwright's browser binaries are downloaded on demand. Click the
"Install screenshot tools" button in the in-app prompt, or install from
the shell:

```bash
pip3 install playwright
playwright install chromium
```

### `ffmpeg not found` while recording a GIF in Documentor

Documentor stitches PNG frames into GIFs with `ffmpeg`. Install it:

```bash
brew install ffmpeg            # macOS
sudo apt-get install ffmpeg    # Debian / Ubuntu
```

Then retry the recording. Screenshots and live preview do not need
ffmpeg.

### Backend starts but the browser shows "Cannot connect"

The backend takes a couple of seconds to bind. Watch the
`Waiting for backend...` line in `start.sh`'s output — it polls
`/api/workspaces` for up to 10 seconds. If you see `ready` and the page
still doesn't load, check `http://127.0.0.1:5111/api/workspaces`
directly: a JSON list means the backend is fine and the frontend dev
server is the issue (try `cd frontend && npm run dev` in a fresh
shell).

### `cloudflared` not auto-installing on `--tunnel`

`start.sh` tries `brew install` then `apt-get install`. If you're on a
distro that uses neither (Arch, Fedora, NixOS, …), grab the binary
directly from
<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>
and put it on your `$PATH`, then re-run `./start.sh --tunnel`.

### Wiping local state

Everything IVE writes lives in `~/.ive/`. To start over:

```bash
rm -rf ~/.ive
```

The next `./start.sh` will recreate the directory and database.
