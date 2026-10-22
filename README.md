# IVE

IVE (Integrated Vibecoding Environment) keeps parallel coding agents visible
and under control. Run Claude Code, Codex and Gemini CLI sessions side by side,
see what each one is doing, answer their questions and review their changes in
one place. Everything runs on your own machine.

IVE is in beta. Expect rough edges and please open an issue when something breaks.

## Install

```bash
curl -fsSL https://ive.dev/install.sh | bash
```

Then start it:

```bash
ive
```

IVE opens in your browser at `http://127.0.0.1:5111`.

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
bash start.sh
```

`bash install.sh --plan` and `bash start.sh --plan` print every step without
running it. More options are in [INSTALL.md](INSTALL.md).

## Everyday commands

```bash
ive                 # start IVE and open it in the browser
ive --headless      # start without opening a browser
ive update          # pull the latest version and rebuild
ive uninstall       # remove IVE, its hooks and the ive command
```

## What IVE changes on your machine

- **Its own folder.** Code, dependencies, database and settings live in `~/.ive`
  (data in `~/.ive/.ive-team-state`). Nothing is shared with other apps.
- **A local server.** IVE listens on `127.0.0.1:5111` only. Phone access and
  other network options are off until you turn them on.
- **Hooks in your coding CLIs.** While it runs, IVE adds hooks to
  `~/.claude/settings.json`, `~/.codex/config.toml` and `~/.gemini/settings.json`
  for the CLIs you have installed. They let IVE follow what each agent does and
  let its Safety Gate stop risky commands. Your own hooks stay untouched.
  `ive uninstall` removes IVE's entries again. If you turned on the package
  scanner (AVCP) in IVE's settings, turn it off before uninstalling.
- **Your existing logins.** Sessions use the login of the CLI you already have.
  You don't need to give IVE an API key to work with your coding CLIs.

## Telemetry

Off by default. If you want to help with anonymous usage numbers, start IVE
with `IVE_TELEMETRY=on ive`. It then sends a hashed install ID, the IVE version,
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
| `apps/ios/` | iPhone companion app (remote control for IVE on your Mac) |
| `packaging/` | Scripts for the signed macOS desktop build |
| `e2e/` | End-to-end tests against an isolated backend with fake CLIs |

## Tests

```bash
cd backend && ../.venv/bin/python -m unittest discover -p 'test_*.py'
node e2e/run.mjs
```

The e2e suite starts its own backend with a temporary home folder and fake CLIs,
so it never touches your real settings.

## License

[Apache License 2.0](LICENSE). Copyright 2026 AIFOREU GmbH.
Third-party notices are in [NOTICE](NOTICE).
