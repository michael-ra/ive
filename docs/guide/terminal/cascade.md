---
title: Cascades
---

# Cascades

A cascade is a sequential chain of prompts executed automatically, one after another.

![Prompts & Cascades](/prompts-cascades.svg)

## Creating a cascade

1. Press **⌘/** to open the Prompt Library
2. Click the **Cascades** tab
3. Click **New Cascade**
4. Add steps — each step is a prompt sent to the session
5. Optionally define **variables** for dynamic substitution
6. Save the cascade

## Running a cascade

1. Open the Cascade Palette (⌘/ → Cascades)
2. Select a cascade
3. If the cascade has variables, a dialog prompts for values
4. Click **Run** — the Cascade Bar appears at the top of the terminal

## Cascade Bar

The Cascade Bar shows:
- Current step / total steps
- **Pause** — pause between steps
- **Stop** — cancel the cascade (⌘Esc)

Each step waits for the session to go idle before sending the next prompt.

## Variables

Use `{variable_name}` in prompt steps for dynamic substitution:

```
Analyze the code in {file_path} and identify all security issues.
Then generate a fix for each issue you found in {file_path}.
```

When you run the cascade, a dialog collects the variable values.

## Loop mode

Enable **Loop mode** to repeat the cascade until you stop it. Useful for monitoring tasks, polling workflows, or continuous improvement loops.

## Auto-approval

Cascades can temporarily change the session's permission mode during execution:
- Switch to **Auto** for the duration of the cascade
- Restore the original mode when done

## Related

- [Prompt Library](../prompts/library) — manage prompts and cascades
- [Broadcast](./broadcast) — send to multiple sessions at once
- [RALPH Mode](../agents/ralph-mode) — autonomous task execution
