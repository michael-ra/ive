---
title: Settings & Events API
---

# Settings & Events API

## App settings

### List all settings

```
GET /api/settings
```

### Get setting

```
GET /api/settings/:key
```

### Update setting

```
PUT /api/settings/:key
```

**Body:** `{ "value": "..." }`

### Experimental flags

```
GET /api/settings/experimental
```

Returns all experimental feature flags and their current state.

## Events

### Event catalog

```
GET /api/events/catalog
```

Returns all available event types with descriptions.

### Emit custom event

```
POST /api/events/emit
```

**Body:**
```json
{
  "type": "custom_event",
  "data": { "key": "value" }
}
```

### Event history

```
GET /api/events
GET /api/events?type=session_created&limit=50
```

## Event subscriptions (webhooks)

### List subscriptions

```
GET /api/events/subscriptions
```

### Create subscription

```
POST /api/events/subscriptions
```

**Body:**
```json
{
  "event_types": ["session_idle", "task_update"],
  "url": "https://your-webhook.example.com/handler",
  "secret": "optional-signing-secret"
}
```

### Update / Delete

```
PUT /api/events/subscriptions/:id
DELETE /api/events/subscriptions/:id
```

## Broadcast groups

### List groups

```
GET /api/broadcast-groups
```

### Create group

```
POST /api/broadcast-groups
```

**Body:**
```json
{
  "name": "All Workers",
  "session_ids": ["id1", "id2", "id3"]
}
```

### Update / Delete

```
PUT /api/broadcast-groups/:id
DELETE /api/broadcast-groups/:id
```

## CLI info

```
GET /api/cli-info            — CLI version and capabilities
GET /api/cli-info/features   — CLI feature matrix (what each CLI supports)
```

## Hook receiver

```
POST /api/hooks/event
```

Receives structured JSON lifecycle events from CLI hooks (session start/stop, tool execution, subagent spawning, compaction). Not typically called directly — used by the hook relay scripts installed in `~/.ive/hooks/`.

## Utilities

```
POST /api/open-in-ide                — Open workspace in IDE
GET  /api/plan-file                  — Read PLAN.md from workspace
PUT  /api/plan-file                  — Write/update PLAN.md
GET  /api/screenshot?url=...         — Capture screenshot of URL
POST /api/install-screenshot-tools   — Install Playwright + WebKit
POST /api/paste-image                — Paste image from clipboard
GET  /api/pastes/:filename           — Serve pasted image
GET  /api/preview-proxy?url=...      — Proxy URL preview
```
