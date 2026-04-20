---
title: Research API
---

# Research API

Manages the deep research database and background research jobs.

## Research entries

### List entries

```
GET /api/research
GET /api/research?workspace_id=1
```

### Create entry

```
POST /api/research
```

**Body:**
```json
{
  "title": "React 19 features",
  "content": "Summary of findings...",
  "workspace_id": 1
}
```

### Get entry (with sources)

```
GET /api/research/:id
```

### Update entry

```
PUT /api/research/:id
```

### Delete entry

```
DELETE /api/research/:id
```

### Add source

```
POST /api/research/:id/sources
```

**Body:**
```json
{
  "url": "https://react.dev/blog/2024/12/05/react-19",
  "title": "React 19 Blog Post",
  "snippet": "React 19 includes..."
}
```

### Search research

```
GET /api/research/search?q=authentication
```

## Research jobs

### Start a job

```
POST /api/research/jobs
```

**Body:**
```json
{
  "topic": "Best practices for JWT refresh token rotation",
  "depth": "standard",
  "workspace_id": 1,
  "mode": "hybrid"
}
```

`depth`: `quick` | `standard` | `deep`  
`mode`: `autonomous` | `hybrid`

Job runs as a background subprocess. Progress is streamed via WebSocket (`research_progress` events).

### List jobs

```
GET /api/research/jobs
```

### Stop a job

```
DELETE /api/research/jobs/:job_id
```

## WebSocket events

| Event | Description |
|-------|-------------|
| `research_started` | Job started with topic and job_id |
| `research_progress` | Progress update with log message |
| `research_done` | Job complete with result entry ID |
