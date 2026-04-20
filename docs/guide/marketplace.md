---
title: Marketplace
---

# Marketplace

The Marketplace (⌘⇧M) is a browser for installing plugins and skills.

![Marketplace panel](../screenshots/marketplace.png)

![Plugin & Skills Ecosystem](/plugin-ecosystem.svg)

## Plugins vs Skills

| Type | What it is |
|------|-----------|
| **Plugin** | Adds an MCP server + guideline to a session |
| **Skill** | A slash command (`/skill-name`) installed into the CLI |

## Security tiers

Marketplace entries are classified by security tier:

| Tier | Badge | Meaning |
|------|-------|---------|
| **Text Only** | Blue | No file system or network access |
| **Sandboxed** | Green | Runs in a restricted environment |
| **Extended Permissions** | Yellow | Requires elevated permissions |
| **Unverified** | Gray | Community-submitted, not reviewed |

## Installing a plugin

1. Press **⌘⇧M** to open the Marketplace
2. Search for a plugin
3. Click **Install**
4. The plugin's MCP server is registered and its guideline is available

## Installing a skill

1. Browse the Skills section
2. Click **Install** next to a skill
3. The skill is installed to the CLI's skills directory
4. Use it with `/skill-name` in any session

## Plugin registries

Add additional plugin sources:
1. Settings → Plugins → Add Registry
2. Enter the registry URL
3. Click **Sync** to fetch the catalog

## First-party plugins

| Plugin | Description |
|--------|-------------|
| **Deep Research** | Multi-source web research with source citation |

## Related

- [Deep Research Plugin](./plugins/deep-research) — setup and usage
- [MCP Servers](./mcp-servers) — manually registering MCP servers
- [Guidelines](./guidelines) — attaching system prompt fragments
