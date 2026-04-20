---
title: Sessions API
---

# Sessions API

## Core CRUD

### List sessions

```
GET /api/sessions
GET /api/sessions?workspace_id=1
```

### Create session

```
POST /api/sessions
```

**Body:**
```json
{
  "workspace_id": 1,
  "name": "My Session",
  "cli_type": "claude",
  "model": "sonnet",
  "permission_mode": "auto",
  "effort": "high",
  "system_prompt": "You are a helpful assistant.",
  "guideline_ids": [1, 2],
  "mcp_server_ids": [3]
}
```

### Update session

```
PUT /api/sessions/:id
```

### Delete session

```
DELETE /api/sessions/:id
```

### Rename session

```
PUT /api/sessions/:id/rename
```

**Body:** `{ "name": "New Name" }`

### Reorder sessions

```
PUT /api/sessions/order
```

**Body:** `{ "ids": [3, 1, 2] }`

## Session actions

### Clone session

```
POST /api/sessions/:id/clone
```

Deep clone with all settings and conversation turns.

### Merge sessions

```
POST /api/sessions/merge
```

**Body:** `{ "source_id": "...", "target_id": "..." }`

### Switch CLI type

```
POST /api/sessions/:id/switch-cli
```

**Body:** `{ "cli_type": "gemini" }`

### Switch model

```
POST /api/sessions/:id/switch-model
```

**Body:** `{ "model": "opus" }`

### Restart with account

```
POST /api/sessions/:id/restart-with-account
```

**Body:** `{ "account_id": "..." }`

## Session data

### Messages

```
GET /api/sessions/:id/messages
```

Returns conversation message history.

### Export

```
GET /api/sessions/:id/export?format=markdown
GET /api/sessions/:id/export?format=json
```

### PTY output

```
GET /api/sessions/:id/output
```

Raw captured PTY output.

### Send input (REST)

```
POST /api/sessions/:id/input
```

**Body:** `{ "data": "your message\n" }`

### Distill

```
POST /api/sessions/:id/distill
```

LLM-summarize the session. Runs as a background job.

### Scratchpad

```
GET /api/sessions/:id/scratchpad
PUT /api/sessions/:id/scratchpad
```

### Captures

```
GET /api/sessions/:id/captures
```

### Session tree

```
GET /api/sessions/:id/tree
```

Hierarchical session tree showing subagents.

### Subagents

```
GET /api/sessions/:id/subagents
GET /api/sessions/:id/subagents/:aid/transcript
```

### Turns (for replay)

```
GET  /api/sessions/:id/turns
```

## Attachments (Guidelines, MCP, Plugins)

### Guidelines

```
GET /api/sessions/:id/guidelines
PUT /api/sessions/:id/guidelines
```

### MCP Servers

```
GET /api/sessions/:id/mcp-servers
PUT /api/sessions/:id/mcp-servers
```

### Plugin components

```
GET /api/sessions/:id/plugin-components
PUT /api/sessions/:id/plugin-components
```

## Search

```
GET /api/search?q=your+query
```

Full-text search across all sessions.

## Broadcast (REST)

```
POST /api/broadcast-input
```

**Body:**
```json
{
  "session_ids": ["id1", "id2"],
  "data": "your message\n"
}
```

## Git

```
GET /api/workspaces/:id/git/status
GET /api/workspaces/:id/git/diff
GET /api/workspaces/:id/git/log
```
