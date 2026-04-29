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

By default IVE binds to `127.0.0.1` and treats every localhost request as Owner / Full mode. No token needed — you're trusted on your own machine.

When [Sharing](../guide/sharing/modes) is set to **Local** or **Tunnel**, every non-localhost request must carry an auth identity:

| Identity | Header / cookie | How to get it |
|----------|-----------------|---------------|
| Joiner session | `Authorization: Bearer <token>` or `ive_session` cookie | Redeem an [invite](../guide/sharing/invites) |
| Legacy owner token | `Authorization: Bearer <AUTH_TOKEN>` or `?token=` (LAN only) | Set via `AUTH_TOKEN` env var |

Joiner sessions carry a **mode** — `brief`, `code`, or `full` — that clamps which routes return 200 vs 403. See [Joiner Sessions](../guide/sharing/joiner-sessions) for the rules.

Owner-only endpoints (e.g. `/api/api-keys`, `/api/runtime/mode`, `/api/invite/*`) require `mode=full` and return 403 to anyone else.

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

### Collaboration & runtime

These groups don't yet have dedicated reference pages — endpoints live alongside their guide topic for now.

| Surface | Endpoints |
|---------|-----------|
| [Sharing modes](../guide/sharing/modes) | `GET/PUT /api/runtime/mode`, tunnel start/stop |
| [Invites](../guide/sharing/invites) | `POST /api/invite/create`, `GET /api/invites`, `POST /api/invite/{id}/revoke`, `POST /api/invite/redeem`, `GET /join` |
| [Joiner sessions](../guide/sharing/joiner-sessions) | `GET /api/whoami`, `GET /api/sessions/auth`, `POST /api/sessions/auth/{id}/revoke`, `POST /api/auth/logout` |
| [Push notifications](../guide/mobile/push) | `POST /api/push/subscribe`, `POST /api/push/unsubscribe`, `GET /api/push/vapid-pubkey` |
| [Catch-up briefing](../guide/sessions/catchup) | `GET /api/catchup` |
| [API keys](../guide/settings/api-keys) | `GET /api/api-keys`, `PUT /api/api-keys`, `POST /api/api-keys/test` (owner-only) |

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
