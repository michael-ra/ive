---
title: Code Review
---

# Code Review

The Code Review panel (⌘⇧G) shows a live git diff of your workspace with inline annotation support.

![Code Review panel](../screenshots/code-review.png)

![Code Review & Planning](/code-review-planning.svg)

## Opening the panel

Press **⌘⇧G** or open via the Command Palette (⌘K → "Code Review").

## Diff view

The panel shows all modified, added, and deleted files in the current workspace. For each file:
- **Green lines** — added
- **Red lines** — removed
- **Unchanged lines** — context

Click any file to expand its full diff.

## Inline annotations

Add comments to specific diff lines:
1. Click the **+** icon next to a line
2. Type your comment
3. The annotation is saved and visible to you

Annotations can be sent directly to the active session as a review prompt.

## IDE integration

Open any file in your preferred IDE directly from the diff:

| IDE | Supported |
|-----|-----------|
| VS Code | ✓ |
| Cursor | ✓ |
| Zed | ✓ |
| Sublime Text | ✓ |
| IntelliJ | ✓ |
| Vim / Neovim | ✓ |

Click the IDE icon next to a filename to open it at the correct line.

## Review prompt

Write a review prompt at the bottom of the panel and click **Send to Session** — it sends the diff context plus your annotations to the active Claude session.

## Keyboard navigation

- **↑/↓** — navigate files
- **Enter** — expand/collapse selected file
- **E** — open in IDE

## Related

- [Sessions](./sessions/creating) — sessions that receive review prompts
- [API: Git](../api/sessions) — git status, diff, log endpoints
