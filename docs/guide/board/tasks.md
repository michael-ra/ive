---
title: Tasks
---

# Tasks

Tasks are the unit of work in the Feature Board. Each task tracks a piece of work through the development lifecycle.

## Task fields

| Field | Description |
|-------|-------------|
| **Title** | Short description of the work |
| **Description** | Detailed notes, requirements, context |
| **Status** | Current column (backlog → done) |
| **Priority** | low / medium / high / urgent |
| **Labels** | Free-form tags for categorization |
| **Assignee** | Session or agent assigned to the task |

## Task detail modal

Click any task card to open the detail modal. It has tabs:

- **Description** — rich text editor for task details
- **Scratchpad** — free-form notes
- **Timeline** — status change history
- **Attachments** — file uploads

### Keyboard shortcuts in the modal

| Shortcut | Action |
|----------|--------|
| ⌥← | Previous tab |
| ⌥→ | Next tab |
| ⌥↑ | Previous field |
| ⌥↓ | Next field |

## Labels

Labels are free-form strings. They appear as colored chips on the task card. Use them to categorize tasks by component, team, or any other dimension.

## Attachments

Upload files to a task:
1. Open the task detail modal
2. Click the **Attachments** tab
3. Drag and drop files or click to upload

Files are stored at `~/.ive/attachments/`.

## Task events

Every status change and comment is recorded in the task's event history. View it via `GET /api/tasks/:id/events`.

## Related

- [Feature Board](./overview) — the Kanban board
- [Quick Feature](./quick-feature) — fast task creation
- [API: Tasks](../../api/tasks) — task API reference
