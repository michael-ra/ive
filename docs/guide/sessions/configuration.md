---
title: Session Configuration
---

# Session Configuration

Sessions are highly configurable. Most settings can be changed at creation time and some can be updated mid-session.

## Claude Code options

| Option | Values | Notes |
|--------|--------|-------|
| `model` | `haiku`, `sonnet`, `opus` | Changed mid-session via `switch-model` |
| `permission_mode` | `default`, `auto`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions` | — |
| `effort` | `low`, `medium`, `high`, `max` | Reasoning effort level |
| `budget_usd` | Number | Spend cap per session |
| `worktree` | Path | Run in a git worktree |
| `add_dirs` | Paths | Extra directories to include |
| `system_prompt` | String | Appended to session system prompt |
| `allowed_tools` | Tool list | Restrict available tools |
| `disallowed_tools` | Tool list | Explicitly block tools |

## Gemini CLI options

**Models:**
- `gemini-3.1-pro-preview` — latest Pro
- `gemini-3-flash-preview` — latest Flash
- `gemini-2.5-pro` — stable Pro
- `gemini-2.5-flash` — stable Flash
- `gemini-2.0-flash` — previous gen

| Option | Values | Notes |
|--------|--------|-------|
| `model` | see above | — |
| `permission_mode` | `default`, `auto_edit`, `yolo`, `plan` | Mapped from canonical modes |
| `worktree` | Path | Run in a git worktree |
| `add_dirs` | Paths | Extra directories |

Gemini CLI does **not** support: `effort`, `budget_usd`, `allowed_tools`, `disallowed_tools`, `mcp_config_path`, `agent`.

## Updating a running session

Some settings can be updated while a session is active:

```bash
PUT /api/sessions/:id
{ "model": "opus", "permission_mode": "auto" }
```

Changes take effect on next PTY start (the session is restarted with the new config).

## Switching models mid-session

```bash
POST /api/sessions/:id/switch-model
{ "model": "opus" }
```

With the **Model Switching** experimental feature enabled, the session resumes with full context.

## Output styles

Control token-saving modes via the output style setting. Styles cascade: session → workspace → global.

| Style | Token use | Description |
|-------|-----------|-------------|
| `normal` | Standard | Full prose responses |
| `lite` | -15% | Slightly condensed |
| `caveman` | -40% | Minimal prose, mostly code |
| `ultra` | -60% | Extreme compression |
| `dense_form` | -50% | Dense structured format |

## Related

- [Creating Sessions](./creating) — session creation form
- [Templates](./templates) — save configs for reuse
- [API: Sessions](../../api/sessions) — REST API reference
