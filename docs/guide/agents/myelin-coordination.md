---
title: Myelin Coordination
---

# Myelin Coordination

Myelin Coordination is an opt-in multi-agent conflict detection system that prevents concurrent Claude Code sessions from clobbering each other's file edits.

## Architecture

![Myelin Coordination Architecture](/coordination-architecture.svg)

When multiple agents work in the same codebase simultaneously, they can unknowingly edit the same files. Myelin solves this with a **shared semantic workspace**: each agent announces its intent, and before any destructive edit, the system checks whether another agent is doing similar work.

## How it works

### 1. Intent capture (UserPromptSubmit hook)

When you submit a prompt to a session, a `UserPromptSubmit` hook captures the intent and stores it in a per-session sidecar file.

### 2. Conflict check (PreToolUse hook)

Before any `Edit`, `Write`, `MultiEdit`, or `NotebookEdit` tool call, a `PreToolUse` hook:

1. Reads the stored user intent from the sidecar
2. Embeds the intent using Gemini embeddings (3072d)
3. Runs a vector similarity search against all active agent tasks in the shared `~/.myelin/coord.db`
4. Classifies the overlap level using cosine thresholds

### 3. Graduated responses

| Overlap level | Cosine score | Action |
|--------------|-------------|--------|
| **CONFLICT** | ≥ 0.80 | Block edit — agent must yield or coordinate |
| **SHARE** | 0.65–0.80 | Allow + share other agent's lessons learned |
| **NOTIFY** | 0.55–0.65 | Allow + brief FYI in tool result |
| **TANGENT** | 0.48–0.55 | Allow silently |
| **UNRELATED** | < 0.48 | Allow silently |

### 4. CONFLICT block message

When a CONFLICT is detected, the edit is blocked and Claude receives a structured message like:

```
⛔ COORDINATION HOLD — edit blocked

agent session_abc is doing very similar work (cosine=0.94):
  intent: Refactor auth middleware to use RS256
  status: active
  files: backend/auth.py, backend/middleware.py

Their full reasoning: ...

Options:
  1. WAIT — poll the workspace and retry when their task completes
  2. COORDINATE — write a response task to share your concerns
  3. DIFFERENTIATE — take a non-overlapping approach
  4. OVERRIDE — proceed anyway (use this only if urgent)
```

Claude then decides how to respond — the system provides information but never forces a specific resolution.

## Enabling Myelin Coordination

1. Open Settings → Experimental
2. Toggle **Myelin Coordination** on

This installs the two hooks into `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "python3 -m myelin.coordination.hook --event user_prompt" }]
    }],
    "PreToolUse": [{
      "matcher": "Edit|Write|MultiEdit|NotebookEdit",
      "hooks": [{ "type": "command", "command": "python3 -m myelin.coordination.hook --event pre_tool" }]
    }]
  }
}
```

## Shared workspace database

All agent tasks are stored in `~/.myelin/coord.db` (SQLite). Override with `MYELIN_COORD_PATH` env var. Tasks expire automatically — any task without a heartbeat for 2 minutes is considered stale and ignored.

## Fail-open design

If Myelin is not installed, the embedding service is unavailable, or any error occurs, the hooks exit 0 and allow the tool call to proceed. Coordination is best-effort — it never blocks Claude when the system itself is broken.

## Scope

IVE uses only Myelin's **coordination sub-module**. The rest of the Myelin graph engine (memory, storage backends, fact retrieval) is not part of IVE.

## Related

- [Experimental Features](../settings/experimental) — enable Myelin Coordination
- [Agent Tree](./agent-tree) — visualize spawned subagents
- [Commander](./commander) — orchestrating multiple agents
