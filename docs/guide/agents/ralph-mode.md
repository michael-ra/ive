---
title: RALPH Mode
---

# RALPH Mode

RALPH mode runs an autonomous **execute → verify → fix** loop, retrying until a task succeeds or a maximum iteration count is reached.

## How RALPH works

1. **Execute** — Claude attempts the task
2. **Verify** — runs a verification step (tests, linting, or a custom check)
3. **Fix** — if verification fails, Claude analyzes the failure and retries
4. Repeats up to **20 iterations**

## Using RALPH

Prefix your prompt with `@ralph`:

```
@ralph Fix all TypeScript errors in src/
@ralph Make the test suite pass
@ralph Implement the feature in PLAN.md and verify it works
```

RALPH expands the `@ralph` token before sending to the session.

## Stopping RALPH

RALPH stops automatically when:
- Verification passes
- 20 iterations are reached
- You send a Force Message (Shift+Enter) to interrupt

## RALPH via Commander MCP

The Commander can invoke RALPH on worker sessions:

```
ralph_mode(session_id, task="Fix failing tests", max_iterations=10)
```

## Verification strategies

RALPH uses whatever verification makes sense for the task:
- **Tests** — run the test suite and check for failures
- **Linting** — check for lint errors
- **Build** — verify the project builds
- **Custom** — specify a custom verification command in your prompt

## Related

- [Commander](./commander) — orchestrating RALPH across multiple sessions
- [Cascades](../terminal/cascade) — sequential multi-step workflows
- [Terminal](../terminal/overview) — sending prompts to sessions
