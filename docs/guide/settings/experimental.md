---
title: Experimental Features
---

# Experimental Features

The Experimental panel exposes beta features that are opt-in.

![Experimental panel](../../screenshots/experimental.png)

## Available flags

| Flag | Description |
|------|-------------|
| **Model Switching** | Switch models mid-session without losing context |
| **Checkpoint Protocol** | Save and restore session checkpoints |
| **Myelin Coordination** | Multi-agent conflict detection for concurrent file edits |
| **Install Screenshot Tools** | Install Playwright + WebKit for screenshot capture |

## Myelin Coordination

When enabled, Commander intercepts pre-tool events to detect concurrent write conflicts between agents editing the same files. Uses the `ext-repo/myelin/coordination/` module.

Enable this when running multiple agents in the same codebase to prevent lost changes from simultaneous edits.

## Model Switching

Allows changing the model of an active session without restarting it. Claude Code resumes with the new model and the same conversation context.

## Installing screenshot tools

Required for the Preview Palette (⌘P) and the Documentor agent:

```bash
# Via the UI toggle, or:
curl -X POST http://localhost:5111/api/install-screenshot-tools
```

This installs Playwright and the WebKit browser via `pip3`.

## Related

- [General Settings](./general) — core UI settings
- [Accounts](./accounts) — API account management
