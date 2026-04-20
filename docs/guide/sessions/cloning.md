---
title: Cloning & Merging Sessions
---

# Cloning & Merging Sessions

## Cloning a session

Cloning creates a deep copy of a session, including all settings and conversation turns.

**Via UI:** Right-click the session tab → **Clone**

**Via API:**
```bash
POST /api/sessions/:id/clone
```

The cloned session has the same model, permission mode, guidelines, MCP servers, and message history. It's independent — changes to the clone don't affect the original.

### Use cases

- Exploring a different approach without losing the current state
- Creating parallel workers from a common starting point
- Preserving a known-good session before trying something risky

## Merging sessions

Merging combines messages from a source session into a target session.

**Via UI:** Session context menu → **Merge...**

**Via API:**
```bash
POST /api/sessions/merge
{
  "source_id": "session-a",
  "target_id": "session-b"
}
```

The merge dialog lets you select which elements to merge:
- Conversation messages
- Guidelines
- MCP servers
- Prompts and cascades

### Use cases

- Combining research from two separate sessions
- Consolidating work done in parallel into one session
- Building a richer context from multiple threads of work

## Exporting sessions

Export a session's conversation for archival or analysis:

```bash
GET /api/sessions/:id/export?format=markdown
GET /api/sessions/:id/export?format=json
```

## Importing from Claude.app history

Import sessions from Claude Code's native session history at `~/.claude/projects/`:

**Via UI:** Settings → **Import History**

**Via API:**
```bash
GET /api/history/projects       — list available projects
POST /api/history/import        — import selected sessions
```

## Related

- [Creating Sessions](./creating) — session creation
- [Templates](./templates) — save session config for reuse
