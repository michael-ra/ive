---
title: Workspaces API
---

# Workspaces API

## Endpoints

### List workspaces

```
GET /api/workspaces
```

Returns an array of all workspaces.

### Create workspace

```
POST /api/workspaces
```

**Body:**
```json
{
  "path": "/Users/you/project",
  "name": "My Project",
  "color": "#6366f1"
}
```

### Update workspace

```
PUT /api/workspaces/:id
```

**Body:** any subset of workspace fields (name, color, oversight, research_model).

### Delete workspace

```
DELETE /api/workspaces/:id
```

### Reorder workspaces

```
PUT /api/workspaces/order
```

**Body:**
```json
{ "ids": [3, 1, 2] }
```

### OS folder picker

```
POST /api/browse-folder
```

Opens a native OS folder picker dialog. Returns the selected path.

### Workspace preview screenshot

```
GET /api/workspaces/:id/preview-screenshot
```

Returns a cached thumbnail of the workspace's web preview.

### Workspace overview

```
GET /api/workspaces/:id/overview
```

Returns a summary object: active sessions, recent activity stats, git status.

### AGENTS.md

```
GET /api/workspaces/:id/agents-md
PUT /api/workspaces/:id/agents-md
```

Read or write the workspace's `AGENTS.md` coordination file.

## Workspace object

```json
{
  "id": 1,
  "name": "My Project",
  "path": "/Users/you/project",
  "color": "#6366f1",
  "created_at": "2026-01-01T00:00:00Z"
}
```
