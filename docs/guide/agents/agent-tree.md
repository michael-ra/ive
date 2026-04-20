---
title: Agent Tree
---

# Agent Tree

The Agent Tree (⌘T) shows the hierarchical tree of subagents spawned by the current session.

![Agent Tree panel](../../screenshots/agent-tree.png)

## What the Agent Tree shows

When Claude Code uses the `Agent` tool to spawn subagents, Commander tracks them in real time:

- **Parent session** at the root
- **Spawned subagents** as child nodes
- **Tool calls** made by each agent (collapsible)
- **Status** — running (green), completed (gray), failed (red)
- **Tool count badges** per agent

## Exploring a subagent

Click any agent node to expand it and see:
- Which tools it used (Bash, Read, Edit, Grep, etc.)
- Tool input/output summaries
- Execution timeline

Click **View Transcript** to open the full subagent transcript in a side panel, showing every tool call with full input and output.

## Hook-based tracking

Agent tree data comes from CLI hooks, not ANSI parsing. When a subagent starts or stops, the CLI fires a `SubagentStart`/`SubagentStop` hook event, which Commander records.

::: info Gemini CLI limitation
Gemini CLI does not currently fire subagent lifecycle hooks, so the Agent Tree is Claude Code only. Gemini parity is planned.
:::

## Related

- [Commander](./commander) — orchestrating multiple sessions
- [Sessions: Creating](../sessions/creating) — session configuration
