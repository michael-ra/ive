---
title: Memory API
---

# Memory API

Manages the memory database and hub-and-spoke CLI sync.

## Memory entries

### List entries

```
GET /api/memory
GET /api/memory?type=feedback&workspace_id=1
```

### Create entry

```
POST /api/memory
```

**Body:**
```json
{
  "name": "testing-approach",
  "type": "feedback",
  "content": "Always use integration tests, not mocks.",
  "workspace_id": 1
}
```

Memory types: `user` | `feedback` | `project` | `reference`

### Update / Delete

```
PUT /api/memory/:id
DELETE /api/memory/:id
```

### Search

```
GET /api/memory/search?q=testing
```

### Import from CLI export

```
POST /api/memory/import
```

### Export as LLM prompt

```
GET /api/memory/prompt
```

Returns memory formatted as a system prompt fragment.

## Workspace memory sync

### Get workspace memory state

```
GET /api/workspaces/:id/memory
```

### Update workspace memory

```
PUT /api/workspaces/:id/memory
```

### View diff (CLI vs server)

```
GET /api/workspaces/:id/memory/diff
```

### Sync from CLI to server

```
POST /api/workspaces/:id/memory/sync
```

Reads the CLI's `CLAUDE.md` files and merges changes into the Commander database.

### Resolve conflicts

```
POST /api/workspaces/:id/memory/resolve
```

**Body:** `{ "resolution": "ours" | "theirs" | "merged" }`

### Auto-generated suggestions

```
GET /api/workspaces/:id/memory/auto
```

Returns LLM-generated memory entry suggestions based on session history.

### Sync settings

```
GET /api/workspaces/:id/memory/settings
PUT /api/workspaces/:id/memory/settings
```
