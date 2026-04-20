---
title: API Overview
---

# API Overview

IVE exposes a REST API on `http://localhost:5111/api` with 130+ endpoints.

## Base URL

```
http://localhost:5111/api
```

## Response format

All endpoints return JSON. Successful responses contain the requested data directly. Errors return:

```json
{
  "error": "Description of the error"
}
```

## Authentication

The API is local-only — no authentication required. It binds to `127.0.0.1` by default.

To expose on the network, set `COMMANDER_HOST=0.0.0.0` (not recommended for production).

## Rate limiting

Default: **100 requests per 60 seconds** globally. Configurable via server settings.

## Endpoint groups

| Group | Description |
|-------|-------------|
| [Workspaces](./workspaces) | Workspace CRUD, overview, git, memory |
| [Sessions](./sessions) | Session lifecycle, config, messages, attachments |
| [Tasks](./tasks) | Feature board task management |
| [Prompts](./prompts) | Prompt templates and cascades |
| [Research](./research) | Deep research entries and jobs |
| [Memory](./memory) | Memory CRUD, sync, conflict resolution |
| [Plugins](./plugins) | Plugin registry, install/uninstall, skills |
| [Settings](./settings) | App settings, events, subscriptions |
| [WebSocket](./websocket) | Real-time PTY and control protocol |

## WebSocket

The WebSocket endpoint is at:

```
ws://localhost:5111/ws
```

See [WebSocket Protocol](./websocket) for full documentation.

## Common patterns

### List resources

```bash
GET /api/sessions?workspace_id=1
```

### Create a resource

```bash
POST /api/sessions
Content-Type: application/json

{ "workspace_id": 1, "model": "sonnet", "cli_type": "claude" }
```

### Update a resource

```bash
PUT /api/sessions/abc123
Content-Type: application/json

{ "model": "opus" }
```

### Delete a resource

```bash
DELETE /api/sessions/abc123
```
