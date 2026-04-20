---
title: MCP Servers
---

# MCP Servers

MCP Servers (⌘⇧S) lets you register, configure, and attach Model Context Protocol servers to sessions.

![MCP Servers panel](../screenshots/mcp-servers.png)

## What MCP servers do

MCP servers extend Claude Code or Gemini CLI with custom tools. When an MCP server is attached to a session, its tools are available to the CLI agent.

## Registering an MCP server

1. Press **⌘⇧S** to open the MCP Servers panel
2. Click **Add Server**
3. Fill in the details:
   - **Name** — display name
   - **Type** — `stdio`, `sse`, or `http`
   - **Command** — for stdio servers: the executable (e.g., `python3`)
   - **Args** — command arguments (e.g., `path/to/server.py`)
   - **URL** — for SSE/HTTP servers
   - **Environment variables** — any env vars the server needs

## Parsing from documentation

Paste MCP server documentation or a README into the **Parse Docs** field and Commander will extract the server configuration automatically using an LLM.

1. Click **Parse from Docs**
2. Paste the server's documentation
3. Click **Parse** — the form fills in automatically
4. Review and save

## Attaching to sessions

Toggle any server on/off for the current session in the panel. Changes take effect on the next session start.

You can also attach servers at session creation time via the New Session form.

## Auto-approve

Enable **Auto-approve** per server to let the session use that server's tools without confirmation prompts.

## Claude vs Gemini MCP strategy

| CLI | Strategy |
|-----|---------|
| Claude Code | `--mcp-config` flag pointing to a dynamically-built JSON config file |
| Gemini CLI | `--mcp-add` flags added per server |

## Related

- [Sessions: Creating](./sessions/creating) — attach MCP servers at session creation
- [Marketplace](./marketplace) — install pre-configured MCP servers as plugins
- [API: MCP Servers](../api/sessions) — REST API reference
