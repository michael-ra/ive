---
title: Quick Start
---

# Quick Start

This guide gets you from a fresh install to running your first Claude Code session.

## 1. Start the app

```bash
./start.sh
```

Open `http://localhost:5173` in your browser.

## 2. Create a workspace

A workspace maps to a folder on your machine.

1. Click **+** in the sidebar (or ⌘N → New Workspace)
2. Select a project folder using the folder picker
3. Give it a name and color

## 3. Create a session

1. Press **⌘N** or click **New Session** in the sidebar
2. Choose your CLI: **Claude** or **Gemini**
3. Select a model:
   - **Haiku** — fast and cheap, good for simple tasks
   - **Sonnet** — balanced capability and speed (recommended)
   - **Opus** — maximum capability for complex tasks
4. Set a permission mode:
   - **Default** — Claude asks before each action
   - **Auto** — Claude decides autonomously
   - **Plan** — Claude plans before executing
   - **Accept Edits** — auto-accepts file edits, asks for other actions
   - **Don't Ask** — runs without confirmation prompts
5. Click **Create**

## 4. Send your first prompt

Click in the terminal and type your prompt. Press **Enter** to send.

For multi-line input, press **⌘E** to open the Composer — it supports bullet points, markdown headers, and structured formatting.

## 5. Explore the interface

| What | How |
|------|-----|
| Open Command Palette | ⌘K |
| See all sessions at once | ⌘M (Mission Control) |
| Create a task | ⌘B (Feature Board) → New Task |
| Search session output | ⌘F |
| Open a second session | ⌘N |
| Split screen | ⌘D |

## 6. Using RALPH mode

For autonomous task completion, prefix your prompt with `@ralph`:

```
@ralph Fix the failing tests in src/auth/
```

RALPH runs an execute → verify → fix loop (up to 20 iterations) until the task succeeds or it gives up.

## Next steps

- [Interface Overview](./interface/overview) — understand the layout
- [Sessions](./sessions/creating) — advanced session configuration
- [Feature Board](./board/overview) — task management
- [Cascades](./terminal/cascade) — chained prompt workflows
