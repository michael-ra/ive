---
title: Guidelines
---

# Guidelines

Guidelines (⌘G) are reusable system-prompt fragments that can be attached to sessions.

![Guidelines panel](../screenshots/guidelines.png)

## What guidelines do

When a session starts, its attached guidelines are injected into the system prompt via `--append-system-prompt`. This lets you define reusable constraints, coding standards, or behavioral rules without pasting them into every prompt.

## Creating a guideline

1. Press **⌘G** to open the Guidelines panel
2. Click **New Guideline**
3. Give it a name and write the content
4. Optionally set it as **Default** — default guidelines auto-attach to every new session

## Attaching to sessions

- In the New Session form, select guidelines to attach
- In the Guidelines panel, toggle guidelines on/off per session
- Changes to running sessions take effect on the next PTY start

## Session Advisor

The Guidelines panel includes a **Session Advisor** — an LLM-powered tool that recommends which guidelines to attach based on your session's purpose. Describe what the session will do and it suggests relevant guidelines.

## Default guidelines

Mark a guideline as **Default** to have it automatically attached to every new session. This is useful for organization-wide standards or personal preferences.

## Guideline content tips

- Keep guidelines focused on a single concern
- Use clear, imperative language ("Always use TypeScript", "Never modify test files")
- Reference the project's conventions from CLAUDE.md
- Test guidelines by attaching them to a session and observing behavior

## Related

- [Sessions: Creating](./sessions/creating) — attach guidelines at session creation
- [Prompts Library](./prompts/library) — reusable prompt templates
- [MCP Servers](./mcp-servers) — attach tools to sessions
