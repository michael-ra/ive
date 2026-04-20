---
title: Force Message
---

# Force Message

Force Message (Shift+Enter) lets you interrupt a running session and inject new instructions.

## How it works

1. While a session is running, press **Shift+Enter**
2. The Force Bar appears above the terminal input
3. Type your corrective instruction
4. Press **Enter** — Commander sends an Escape signal followed by your message

This interrupts whatever Claude is currently doing and redirects it with your new guidance.

## Use cases

- **Course correction** — Claude is going down the wrong path
- **Adding context** — you realized important information mid-task
- **Stopping and redirecting** — abort the current approach and try something different

## Multiple force messages

You can queue multiple force messages — they're combined into a single wrapped context before being sent.

## Difference from Stop (⌘.)

| Action | What happens |
|--------|-------------|
| **Force Message** (Shift+Enter) | Interrupts + sends your message |
| **Stop** (⌘.) | Sends SIGTERM, ends the session |

## Related

- [Terminal Overview](./overview) — terminal features
- [Broadcast](./broadcast) — send to multiple sessions
