---
title: Prompts API
---

# Prompts API

Manages prompt templates and cascade chains.

## Prompts

### List prompts

```
GET /api/prompts
GET /api/prompts?category=coding
GET /api/prompts?quickaction=true
```

### Create prompt

```
POST /api/prompts
```

**Body:**
```json
{
  "title": "Code Review",
  "content": "Review this code for bugs, style issues, and performance problems.",
  "category": "coding",
  "is_quickaction": false
}
```

### Update prompt

```
PUT /api/prompts/:id
```

### Delete prompt

```
DELETE /api/prompts/:id
```

### Use prompt

```
POST /api/prompts/:id/use
```

Increments usage counter and returns the prompt content.

### Reorder quick actions

```
PUT /api/prompts/quickaction-order
```

**Body:** `{ "ids": [3, 1, 2] }`

## Cascades

### List cascades

```
GET /api/cascades
```

### Create cascade

```
POST /api/cascades
```

**Body:**
```json
{
  "name": "Code Review Workflow",
  "steps": [
    "Review the code in {file} for correctness.",
    "Now check {file} for security issues.",
    "Write tests for {file}."
  ],
  "variables": [
    { "name": "file", "description": "Target file path" }
  ],
  "loop": false
}
```

### Update cascade

```
PUT /api/cascades/:id
```

### Delete cascade

```
DELETE /api/cascades/:id
```

### Execute cascade

```
POST /api/cascades/:id/use
```

**Body:**
```json
{
  "session_id": "abc123",
  "variables": { "file": "src/auth.ts" }
}
```

## Guidelines

### List guidelines

```
GET /api/guidelines
```

### Create guideline

```
POST /api/guidelines
```

**Body:**
```json
{
  "name": "TypeScript Standards",
  "content": "Always use TypeScript strict mode. Never use `any` type.",
  "is_default": false
}
```

### Update / Delete

```
PUT /api/guidelines/:id
DELETE /api/guidelines/:id
```
