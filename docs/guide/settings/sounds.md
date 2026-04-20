---
title: Sound Settings
---

# Sound Settings

Sound Settings control audio notifications triggered by session events.

![Sound Settings panel](../../screenshots/sound-settings.png)

## Notification triggers

| Event | Default sound |
|-------|--------------|
| Session done (Claude idle) | Chime |
| Agent done | Bell |
| Plan ready | Ding |
| Input needed (oversight nudge) | Alert |

## Controls

- **Enable / Disable** — master toggle for all sounds
- **Volume** — slider from 0–100%
- **Sound type** — select a different sound per trigger
- **Test** — play the sound immediately to preview

## Implementation

Sounds use the Web Audio API — no external files required. All tones are generated programmatically.

## Related

- [General Settings](./general) — UI layout and behavior
- [Inbox](../sessions/inbox) — oversight nudges that trigger sounds
