---
title: Plugins API
---

# Plugins API

Manages plugin registries, plugin installation, and agent skills.

## Plugin registries

### List registries

```
GET /api/plugins/registries
```

### Add registry

```
POST /api/plugins/registries
```

**Body:**
```json
{
  "name": "My Registry",
  "url": "https://example.com/plugins/index.json"
}
```

### Update / Delete

```
PUT /api/plugins/registries/:id
DELETE /api/plugins/registries/:id
```

### Sync registries

```
POST /api/plugins/registries/:id/sync   — sync one registry
POST /api/plugins/registries/sync       — sync all registries
```

## Plugins

### List available plugins

```
GET /api/plugins
```

Returns plugins from all synced registries.

### Get plugin details

```
GET /api/plugins/:id
```

### Install plugin

```
POST /api/plugins/:id/install
```

Installs the plugin's MCP server and makes its guideline available.

### Uninstall plugin

```
DELETE /api/plugins/:id
```

## Agent skills

### List available skills

```
GET /api/skills
```

Skills from agentskills ecosystem + baked-in catalog.

### List installed skills

```
GET /api/skills/installed
```

### Install skill

```
POST /api/skills/install
```

**Body:** `{ "skill_id": "..." }`

Installs to the CLI's skills directory (project or user scope).

### Uninstall skill

```
POST /api/skills/uninstall
```

**Body:** `{ "skill_id": "..." }`

### Sync skill updates

```
POST /api/skills/sync
```

### Get skill details

```
GET /api/skills/:path
```

## MCP Servers

### List MCP servers

```
GET /api/mcp-servers
```

### Create MCP server

```
POST /api/mcp-servers
```

**Body:**
```json
{
  "name": "My MCP Server",
  "type": "stdio",
  "command": "python3",
  "args": ["path/to/server.py"],
  "env": { "API_KEY": "..." }
}
```

### Update / Delete

```
PUT /api/mcp-servers/:id
DELETE /api/mcp-servers/:id
```

### Parse from documentation

```
POST /api/mcp-servers/parse-docs
```

**Body:** `{ "docs": "...markdown or documentation text..." }`

Returns a parsed server config object.
