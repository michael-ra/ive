---
title: Installation
---

# Installation

## Prerequisites

- **macOS** (primary platform) or Linux
- **Node.js** 18+ and npm
- **Python** 3.9+
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`
- **Gemini CLI** (optional) — `npm install -g @google/gemini-cli`

## Quick start

Clone the repository and run the start script — it handles everything:

```bash
git clone <repo-url>
cd ive
./start.sh
```

`start.sh` will:
1. Auto-update the Claude Code and Gemini CLIs to latest
2. Install Python dependencies (`pip3 install -r backend/requirements.txt`)
3. Install frontend dependencies (`cd frontend && npm install`)
4. Launch the backend on `:5111`
5. Launch the frontend on `:5173`

Then open `http://localhost:5173` in your browser.

## Manual start

```bash
# Backend only
cd backend && python3 server.py

# Frontend only
cd frontend && npm run dev

# Install deps
pip3 install -r backend/requirements.txt
cd frontend && npm install
```

## Data storage

All app data is stored at `~/.ive/`:

| Path | Contents |
|------|----------|
| `~/.ive/data.db` | SQLite database (sessions, tasks, prompts, etc.) |
| `~/.ive/attachments/` | Task file attachments |
| `~/.ive/hooks/` | CLI hook relay scripts |
| `~/.ive/plugins/` | Installed plugins |
| `~/.ive/mcp_configs/` | Per-session MCP server configs |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COMMANDER_HOST` | `127.0.0.1` | Backend bind address |
| `COMMANDER_PORT` | `5111` | Backend port |
| `COMMANDER_HOOKS_ENABLED` | `true` | Enable CLI lifecycle hooks |
| `BRAVE_API_KEY` | — | Activates Brave search in research engine |
| `SEARXNG_URL` | — | Activates SearXNG backend for research |

## Screenshot tools (optional)

The Documentor agent and Preview palette require Playwright and WebKit:

```bash
# Install via the UI: Settings → Experimental → Install Screenshot Tools
# Or via API:
curl -X POST http://localhost:5111/api/install-screenshot-tools
```

## Related

- [Quick Start](./quick-start) — create your first session
- [Introduction](./introduction) — architecture overview
