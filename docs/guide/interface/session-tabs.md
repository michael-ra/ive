---
title: Session Tabs
---

# Session Tabs

The tab bar at the top of the main area shows all open sessions as tabs.

## Tab features

- **Active tab** — highlighted, shows the current terminal
- **Status dot** — colored indicator of session state (running/idle/exited)
- **Model badge** — shows the model in use
- **Drag to reorder** — drag tabs to change their order

## Tab shortcuts

| Shortcut | Action |
|----------|--------|
| ⌘N | Open new session tab |
| ⌘W | Close current tab |
| ⌘1–9 | Switch to tab N |

## Context menu

Right-click any tab for options:
- **Rename** — change the session name
- **Clone** — duplicate the session with all settings
- **Export** — download as markdown or JSON
- **Split** — open alongside current tab
- **Delete** — permanently remove the session

## Split view (⌘D)

Press **⌘D** to split the current view and show two sessions side by side. Split views can be:
- **Horizontal** — side by side
- **Vertical** — stacked

## Terminal persistence

When you switch tabs, the previous terminal is **hidden via CSS, not unmounted**. This preserves scroll position, terminal history, and state — switching back is instant.

## Tab limit

There's no hard limit on open tabs, but Commander's UI is optimized for up to ~8 simultaneous sessions.

## Related

- [Interface Overview](./overview) — full layout description
- [Split View](../sessions/creating) — split screen configuration
- [Mission Control](../sessions/mission-control) — overview of all sessions
