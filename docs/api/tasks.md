---
title: Tasks API
---

# Tasks API

The tasks API manages the Feature Board Kanban.

## Endpoints

### List tasks

```
GET /api/tasks
GET /api/tasks?workspace_id=1&status=in_progress
```

### Create task

```
POST /api/tasks
```

**Body:**
```json
{
  "title": "Implement login page",
  "description": "Build the login form with validation",
  "workspace_id": 1,
  "status": "backlog",
  "priority": "high",
  "labels": ["frontend", "auth"],
  "assignee": "session-id"
}
```

### Get task

```
GET /api/tasks/:id
```

### Update task

```
PUT /api/tasks/:id
```

**Body:** any subset of task fields.

### Delete task

```
DELETE /api/tasks/:id
```

## Task events

```
GET /api/tasks/:id/events
```

Returns the full history of status changes, comments, and assignments.

## Attachments

```
POST /api/tasks/:id/attachments     — upload file
GET  /api/tasks/:id/attachments     — list attachments
GET  /api/attachments/:task_id/:filename  — download file
```

## Task statuses

| Status | Meaning |
|--------|---------|
| `backlog` | Not started, not prioritized |
| `todo` | Prioritized, ready to work |
| `planning` | Being designed/scoped |
| `in_progress` | Actively being worked |
| `review` | Awaiting review |
| `done` | Complete |

## Task object

```json
{
  "id": "abc123",
  "title": "Implement login page",
  "description": "...",
  "workspace_id": 1,
  "status": "in_progress",
  "priority": "high",
  "labels": ["frontend"],
  "assignee": "session-id",
  "created_at": "2026-01-01T00:00:00Z",
  "updated_at": "2026-01-01T12:00:00Z"
}
```
