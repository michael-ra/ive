---
title: Broadcast
---

# Broadcast

Broadcast (⌘⇧↵) sends the same message to multiple sessions simultaneously.

## How to broadcast

1. Press **⌘⇧↵** to open the Broadcast Bar
2. Check the sessions you want to target (workspace-scoped by default)
3. Type your message
4. Press **Enter** to send to all checked sessions

## Scope

Toggle between **workspace** scope (only sessions in the current workspace) and **global** scope (all open sessions across all workspaces) using the scope button.

## Session groups

Save a selection of sessions as a named broadcast group for quick reuse:

1. Select your target sessions
2. Click **Save Group**
3. Give it a name
4. Load the group next time with one click

## REST alternative

You can also broadcast via the REST API:

```bash
POST /api/broadcast-input
{
  "session_ids": ["id1", "id2"],
  "data": "your message here\n"
}
```

## Use cases

- Sending the same task to multiple Claude instances working in parallel
- Announcing a change to all sessions (e.g., "the API changed, update your approach")
- Running the same verification prompt across multiple codebases

## Related

- [Cascades](./cascade) — sequential multi-step workflows
- [Commander](../agents/commander) — orchestrating worker sessions
