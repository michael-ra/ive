---
title: Commander Orchestrator
---

# Commander Orchestrator

The Commander is a special orchestrator session that can spawn, manage, and coordinate worker sessions within a workspace.

![Agent Orchestration Architecture](/agent-orchestration.svg)

## What Commander does

Commander is a Claude Code session with a special MCP server (`mcp_server.py`) that exposes workspace management tools. It can:

- Create new worker sessions via `spawn_session`
- Send prompts to sessions via `send_to_session`
- Read task board state and update task statuses
- Monitor session output and wait for completion
- Run RALPH loops on worker sessions
- Escalate blockers back to you

## Creating a Commander session

```bash
POST /api/workspaces/:id/commander
```

Or via the UI: workspace context menu → **Create Commander**.

## Commander MCP tools

| Tool | Description |
|------|-------------|
| `list_sessions` | List sessions in the workspace |
| `spawn_session` | Create a new worker session |
| `send_to_session` | Send input to a session |
| `read_session_output` | Get recent PTY output |
| `create_task` | Add a task to the Feature Board |
| `update_task` | Update task status, notes, assignee |
| `list_tasks` | Query the task board |
| `start_research` | Kick off a deep research job |
| `get_research` | Retrieve research results |
| `ralph_mode` | Run RALPH loop on a session |
| `escalate` | Flag a blocker for the user |

## Worker sessions

Worker sessions created by Commander get a lightweight `worker_mcp_server.py` that lets them:
- Read their own task
- Update their task status and notes
- Mark themselves done

This creates a self-managing task board: Commander assigns tasks, workers execute and report back.

## W2W communication (worker-to-worker)

Sessions can communicate laterally via a bulletin board (`post_message`, `check_messages`). This enables peer coordination without going through the Commander.

## Related

- [Agent Tree](./agent-tree) — visualize spawned subagents
- [RALPH Mode](./ralph-mode) — autonomous task execution
- [Feature Board](../board/overview) — task board Commander manages
