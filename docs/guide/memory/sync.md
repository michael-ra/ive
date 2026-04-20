---
title: Memory Sync
---

# Memory Sync

IVE synchronizes memory between its own database and Claude Code's native memory files (`~/.claude/CLAUDE.md` and per-project `CLAUDE.md`).

![Workspaces & Memory Architecture](/workspace-memory.svg)

## Hub-and-spoke architecture

Commander acts as a central memory hub. All CLI memory providers sync through the hub — never directly with each other. This prevents conflicts and provides a single source of truth.

```
~/.claude/CLAUDE.md  ←→  Commander Hub  ←→  Project CLAUDE.md
```

## Conflict resolution

When both sides have changed the same memory, Commander uses a **three-way git merge** (`git merge-file`) to reconcile differences automatically. Manual resolution is available for conflicts that can't be auto-resolved.

## Sync endpoints

```bash
# Get workspace memory state
GET /api/workspaces/:id/memory

# Sync from CLI to server
POST /api/workspaces/:id/memory/sync

# View diff between CLI and server
GET /api/workspaces/:id/memory/diff

# Resolve conflicts
POST /api/workspaces/:id/memory/resolve

# Get/update sync settings
GET  /api/workspaces/:id/memory/settings
PUT  /api/workspaces/:id/memory/settings
```

## Auto-sync triggers

Memory sync happens automatically on:
- Session start (reads latest CLI memory)
- Session stop (writes back any changes)
- Hook events from the CLI (when memory files change)

## Memory types

Commander understands the standard memory taxonomy:

| Type | Purpose |
|------|---------|
| **user** | User profile, preferences, expertise |
| **feedback** | Behavioral guidance for the agent |
| **project** | Project-specific context, decisions |
| **reference** | Pointers to external resources |

## Related

- [Knowledge Base](./knowledge-base) — workspace knowledge entries
- [API: Memory](../../api/memory) — memory REST API reference
