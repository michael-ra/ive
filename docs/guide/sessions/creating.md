---
title: Creating Sessions
---

# Creating Sessions

A session is a real PTY (pseudo-terminal) running `claude` or `gemini` interactively.

## New session form

Press **⌘N** or click **New Session** in the sidebar to open the session creation form.

### CLI selection

Choose between **Claude Code** and **Gemini CLI**. The available options change based on which CLI you select.

### Claude Code options

| Option | Values | Description |
|--------|--------|-------------|
| **Model** | Haiku, Sonnet, Opus | Claude model to use |
| **Permission mode** | Default, Auto, Plan, Accept Edits, Don't Ask, Bypass All | How Claude handles confirmations |
| **Effort** | low, medium, high, max | Reasoning effort level |
| **Budget** | USD amount | Optional token spend cap |

### Gemini CLI options

| Option | Values | Description |
|--------|--------|-------------|
| **Model** | see below | Gemini model to use |
| **Approval mode** | Default, Auto Edit, YOLO, Plan | How Gemini handles confirmations |

**Available Gemini models:**
- `gemini-3.1-pro-preview` — latest Pro
- `gemini-3-flash-preview` — latest Flash
- `gemini-2.5-pro` — stable Pro
- `gemini-2.5-flash` — stable Flash
- `gemini-2.0-flash` — previous gen

### Advanced options

- **System prompt** — custom instructions appended to the session's system prompt
- **Guidelines** — attach reusable guideline fragments (see [Guidelines](../guidelines))
- **MCP servers** — attach MCP servers to this session (see [MCP Servers](../mcp-servers))
- **Worktree** — run in a git worktree for isolated changes
- **Working directory** — override the workspace's root directory

## Permission modes

| Mode | Behavior |
|------|----------|
| **Default** | Claude asks before each tool use |
| **Auto** | Claude decides autonomously when safe |
| **Plan** | Claude generates a plan first, then executes |
| **Accept Edits** | Auto-accepts file edits, asks for Bash and other actions |
| **Don't Ask** | Runs without any confirmation prompts |
| **Bypass All** | Bypasses all permission checks |

## Templates

Save your current session configuration as a template for quick reuse:

1. Configure a session with your preferred settings
2. Click **Save as Template**
3. Give it a name
4. Use the template from the New Session form to spawn identical sessions

See [Session Templates](./templates) for details.

## Related

- [Configuration](./configuration) — all session config options
- [Templates](./templates) — save and reuse session configs
- [Mission Control](./mission-control) — view all active sessions
