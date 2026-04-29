# Contributing to IVE

Thanks for your interest in IVE. The project is small and moves fast — patches, bug reports, and feature ideas are all welcome.

## Dev setup

```bash
git clone https://github.com/michael-ra/ive.git
cd ive
./start.sh
```

`./start.sh` handles dependency install (Python + Node) and launches both the backend (`:5111`) and frontend (`:5173`). For a manual run, see the [README](README.md#manual-run).

For full prerequisites (Python 3.11+, Node 18+, screenshot tooling, OS notes), see [`INSTALL.md`](INSTALL.md).

## Project layout &amp; conventions

For the architecture overview (three-layer CLI abstraction, event bus, hook-based state detection, file map), see the [README](README.md#under-the-hood) and the docs at [`docs/guide/introduction.md`](docs/guide/introduction.md). Read those before sending non-trivial changes.

A few load-bearing conventions:

- **No ANSI parsing.** Session state comes from CLI hooks (`backend/hooks.py`). Do not add output regexes for state detection.
- **All state changes flow through the event bus** (`backend/event_bus.py`). New event types go in `backend/commander_events.py`.
- **CLI-specific behavior belongs in `cli_profiles.py`.** Adding a new CLI should mean adding one profile, not branching across the codebase.
- **Frontend state is Zustand-only** (`frontend/src/state/store.js`). Don't add new state libraries.
- **Keyboard shortcuts are configurable.** Defaults live in `frontend/src/lib/keybindings.js`.

## Code style

- Python: follow the existing style in `backend/` — type hints where they aid clarity, no heavy frameworks beyond aiohttp + aiosqlite.
- JavaScript / JSX: follow the existing style in `frontend/src/` — function components, hooks, Tailwind utility classes. No CSS modules.
- Keep pull requests focused. One feature or fix per PR.

## Commit messages

Short, imperative-mood subject line ("Fix banner output buffering", "Add pipeline cooldown guard"). Body optional but encouraged for non-trivial changes — explain *why*, not *what*.

Do not add `Co-Authored-By` lines.

## PR process

1. Fork, branch off `main`.
2. Make your change. Run the app locally and confirm both backend and frontend start cleanly.
3. If you touched backend logic with tests in `backend/tests/`, run them.
4. Open a PR against `main` with a clear description of the change and any relevant screenshots / clips for UI work.
5. Be responsive to review feedback — reviews tend to be quick.

## Reporting bugs

Open a GitHub issue with:

- IVE version (or commit hash)
- OS + Python + Node versions
- Steps to reproduce
- Relevant log output from the backend (`backend/server.py` stderr)

## Security

If you find a security issue (RCE, data exfiltration, sandbox escape), please email the maintainer privately rather than filing a public issue.
