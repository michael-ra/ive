---
title: WebSocket Protocol
---

# WebSocket Protocol

Commander uses a single multiplexed WebSocket at `ws://localhost:5111/ws` for all real-time communication.

## Connection

```javascript
const ws = new WebSocket('ws://localhost:5111/ws')
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  // handle msg.type
}
```

## Client → Server actions

All messages sent to the server are JSON objects with an `action` field.

### Start PTY

```json
{
  "action": "start_pty",
  "session_id": "abc123",
  "cols": 120,
  "rows": 40
}
```

Starts the PTY process for a session. Commander builds the full CLI command including system prompt, guidelines, plugins, MCP servers, and memory.

### Send input

```json
{
  "action": "input",
  "session_id": "abc123",
  "data": "hello\n"
}
```

Sends keystrokes to the PTY. `@prompt:` tokens in `data` are expanded before delivery.

### Resize terminal

```json
{
  "action": "resize",
  "session_id": "abc123",
  "cols": 140,
  "rows": 45
}
```

### Replay turns

```json
{
  "action": "replay_turns",
  "session_id": "abc123",
  "turns": ["turn-id-1", "turn-id-2"]
}
```

Re-executes stored conversation turns.

### Broadcast

```json
{
  "action": "broadcast",
  "session_ids": ["id1", "id2", "id3"],
  "data": "your message\n"
}
```

### Stop session

```json
{
  "action": "stop",
  "session_id": "abc123"
}
```

Sends SIGTERM to the PTY process.

## Server → Client messages

All messages from the server are JSON with a `type` field and a `session_id` (for session-scoped messages).

### Session-scoped events

| Type | Description | Key fields |
|------|-------------|-----------|
| `output` | PTY terminal data | `data` (string) |
| `exit` | Process exited | `code` (exit code) |
| `error` | Error occurred | `message` |
| `status` | Session status update | `status` |
| `session_state` | State from hooks: working/idle/prompting | `state` |
| `session_idle` | Stop hook fired | — |
| `session_renamed` | Name changed | `name` |
| `session_switched` | CLI type changed | `cli_type` |
| `model_changed` | Model changed mid-session | `model` |
| `replay_done` | Turn replay completed | — |
| `tool_event` | PreToolUse/PostToolUse lifecycle | `tool`, `phase` |
| `subagent_event` | Sub-agent start/stop | `agent_id`, `phase` |
| `task_update` | Task board update | `task` |
| `test_queue_update` | Test queue changed | — |
| `capture` | Output capture event | `capture` |
| `quota_exceeded` | Usage quota depleted | — |
| `context_low` | Context window running low | `percent_left` |
| `compaction` | Pre/post compaction | `phase` |

### Global events

| Type | Description |
|------|-------------|
| `session_created` | New session created |
| `research_started` | Deep research job started |
| `research_progress` | Research progress update |
| `research_done` | Research job complete |
| `distill_done` | Background distill complete |
| `distill_error` | Background distill failed |
| `mcp_parse_done` | MCP doc parse complete |
| `mcp_parse_error` | MCP doc parse failed |

## Example: receiving terminal output

```javascript
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data)
  if (msg.type === 'output' && msg.session_id === mySessionId) {
    terminal.write(msg.data)
  }
}
```

## Example: starting a session

```javascript
// 1. Create session via REST
const session = await fetch('/api/sessions', {
  method: 'POST',
  body: JSON.stringify({ workspace_id: 1, model: 'sonnet', cli_type: 'claude' })
}).then(r => r.json())

// 2. Start the PTY via WebSocket
ws.send(JSON.stringify({
  action: 'start_pty',
  session_id: session.id,
  cols: 120,
  rows: 40
}))

// 3. Send a prompt
ws.send(JSON.stringify({
  action: 'input',
  session_id: session.id,
  data: 'Write a hello world in Python\n'
}))
```
