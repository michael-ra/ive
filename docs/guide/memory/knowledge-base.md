---
title: Knowledge Base
---

# Knowledge Base

The Workspace Knowledge Base stores categorized facts about your project that sessions can query.

![Knowledge panel](../../screenshots/knowledge.png)

## Categories

Each knowledge entry has a category:

| Category | Purpose |
|----------|---------|
| **architecture** | System design decisions, component relationships |
| **convention** | Coding standards, naming patterns |
| **gotcha** | Common pitfalls, known issues |
| **pattern** | Recurring implementation patterns |
| **api** | API contracts, endpoint behavior |
| **setup** | Environment setup, dependencies |

## Creating entries

1. Open the Knowledge panel
2. Click **New Entry**
3. Select a category
4. Write the content (markdown supported)
5. Set scope: **workspace** (current project only) or **global** (all workspaces)

## Querying knowledge

Sessions can search the knowledge base via the Commander MCP:

```
query_knowledge("authentication middleware")
```

Or use the REST API:

```bash
GET /api/workspace-knowledge?query=auth&scope=workspace
```

## Auto-generated suggestions

The Knowledge panel includes an **Auto** tab that generates suggested entries from your session history using an LLM. Review and approve suggestions to build up the knowledge base over time.

## W2W integration

Worker sessions in a multi-agent workflow can contribute to and query the knowledge base using the `contribute_knowledge` and `query_knowledge` MCP tools. This lets agents share discoveries with each other.

## Related

- [Memory Sync](./sync) — syncing memory with CLI providers
- [Commander](../agents/commander) — using knowledge in orchestration
