# IVE

IVE (Integrated Vibecoding Environment) keeps parallel coding agents visible
and under control. Run Claude Code, Codex and Gemini CLI sessions side by side,
see what each one is doing, answer their questions and review their changes in
one place. Everything runs on your own machine.

IVE is in beta. Expect rough edges and please open an issue when something breaks.

## Install

### Mac app

For a Mac with Apple silicon (M1 or newer) and macOS 13.5 or newer:
[download IVE for Mac](https://github.com/michael-ra/ive/releases/latest/download/IVE-macOS-arm64.dmg),
open the DMG and drag IVE into Applications. The app is signed by AIFOREU GmbH
and notarized by Apple. It runs its own local service in the background, so
there is no terminal window and no browser tab. Its data lives in
`~/Library/Application Support/com.ive.desktop`, and it listens on
`127.0.0.1:5112` only. The SHA-256 of each DMG is on the
[releases page](https://github.com/michael-ra/ive/releases).

To uninstall the app, quit it, run
`"/Applications/IVE.app/Contents/Resources/backend/ive-backend" --remove-hooks`
in Terminal and drag IVE to the Trash.

### From source (Linux, Intel Macs, developers)

```bash
curl -fsSL https://ive.dev/install.sh | bash
```

Then start it:

```bash
ive
```

IVE starts in the background and opens in your browser at
`http://127.0.0.1:5111`. You can close the terminal; IVE keeps running until
you run `ive stop`.

If your shell says `command not found`, `~/.local/bin` is not on your `PATH`
yet: run `~/.local/bin/ive`, or add `export PATH="$HOME/.local/bin:$PATH"` to
`~/.zshrc` (the installer prints this line too).

The installer puts IVE into `~/.ive`, installs its Python and npm dependencies
there, builds the app and links the `ive` command into `~/.local/bin`. It does
not use `sudo` and does not start anything. [Read the script](get.sh) before you
run it.

### Requirements

- macOS or Linux
- Python 3.11 or newer
- Node.js 22.12 or newer with npm
- Git
- At least one coding CLI you already use and are logged in to:
  [Claude Code](https://code.claude.com), Codex or Gemini CLI

On macOS with Homebrew: `brew install python node git`.

### Install without the script

```bash
git clone https://github.com/michael-ra/ive.git
cd ive
bash install.sh
bin/ive
```

`bash install.sh --plan` and `bash start.sh --plan` print every step without
running it. More options are in [INSTALL.md](INSTALL.md).

## Everyday commands

```bash
ive                 # start IVE in the background and open it in the browser
ive --headless      # start in the background without opening a browser
ive stop            # stop IVE
ive status          # is it running, and where
ive logs            # follow the log (Ctrl+C leaves, IVE keeps running)
ive run             # run IVE in this terminal instead of the background
ive update          # pull the latest version, rebuild and restart a running IVE
ive uninstall       # stop IVE, remove its hooks, the app folder and the ive command
```

`ive` returns once IVE is up. For systemd, launchd or a container, use
`ive run --headless`, which stays in the foreground.

## What IVE changes on your machine

- **Its own folder.** Code, dependencies, database and settings live in `~/.ive`
  (data in `~/.ive/.ive-team-state`). Nothing is shared with other apps.
- **A local server.** IVE listens on `127.0.0.1:5111` only. Phone access and
  other network options are off until you turn them on.
- **Hooks in your coding CLIs.** While it runs, IVE adds hooks to
  `~/.claude/settings.json`, `~/.codex/config.toml` and `~/.gemini/settings.json`
  for the CLIs you have installed. They let IVE follow what each agent does and
  let its Safety Gate stop risky commands. Your own hooks stay untouched.
  They stay active, also while IVE is not running, until you remove them:
  `ive uninstall` (or the app's `--remove-hooks`) takes IVE's entries out again.
- **Your shell startup files, only if you turn on the package scanner.** The
  optional AVCP scanner (off by default) adds a marked block to `~/.zshrc` and
  `~/.bashrc` that checks `npm install`, `pip install` and similar commands.
  Turning it off, `ive uninstall` and `--remove-hooks` remove the block.
- **Your existing logins.** Sessions use the login of the CLI you already have.
  You don't need to give IVE an API key to work with your coding CLIs.

## Telemetry

Off by default. If you want to help with anonymous usage numbers, start IVE
with `IVE_TELEMETRY=on ive` (run `ive stop` first if it is already running). It then sends a hashed install ID, the IVE version,
your platform, the number of sessions, uptime and, after a crash, the first
500 characters of the error message to PostHog. No code and no prompts.
[backend/telemetry.py](backend/telemetry.py) shows exactly what is sent.

## Project layout

| Folder | What it is |
| --- | --- |
| `backend/` | Python server (aiohttp), session management, hooks, Safety Gate |
| `frontend/` | React + Vite + xterm.js app |
| `extensions/sandbox/` | Optional sandbox runtime (Docker or Apple container) |
| `deep_research/` | Research and discovery features |
| `anti-vibe-code-pwner/` | Bundled supply-chain scanner (MIT, see its LICENSE) |
| `packaging/` | Scripts for the signed macOS desktop build |
| `e2e/` | End-to-end tests against an isolated backend with fake CLIs |

## Tests

```bash
cd backend && ../.venv/bin/python -m unittest discover -p 'test_*.py'
cd ../frontend && npx playwright install chromium && cd ..
node e2e/run.mjs
```

The e2e suite starts its own backend with a temporary home folder and fake CLIs,
so it never touches your real settings.

## License

[Apache License 2.0](LICENSE). Copyright 2026 AIFOREU GmbH.
Third-party notices are in [NOTICE](NOTICE).
