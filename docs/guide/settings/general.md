---
title: General Settings
---

# General Settings

General Settings control the overall UI layout and behavior.

![General Settings panel](../../screenshots/general-settings.png)

## View modes

| Mode | Description |
|------|-------------|
| **Tabs** | One session per tab (default) |
| **Split Horizontal** | Two sessions side by side |
| **Split Vertical** | Two sessions stacked |
| **Grid 2×2** | Four sessions in a grid |

## Sidebar

- **Position** — left (default) or right
- **Auto-hide** — collapse when a session is active

## Terminal

- **Font size** — adjust the terminal font size
- **Auto-scroll** — scroll to bottom when new output arrives
- **Scroll-back limit** — number of lines to keep in the terminal buffer

## Theme

- **Dark** (default) — dark background, designed for extended use
- **Light** — light background
- **System** — follow the OS preference

## Output styles

Output styles control token-saving modes injected into sessions via system prompt:

| Style | Description |
|-------|-------------|
| **Normal** | Standard output |
| **Lite** | Slightly condensed |
| **Caveman** | Minimal prose, code only |
| **Ultra** | Extreme compression |
| **Dense Form** | Maximum information density |

Styles cascade: session → workspace → global app setting.

## Related

- [Sound Settings](./sounds) — audio notification settings
- [Experimental](./experimental) — beta feature flags
