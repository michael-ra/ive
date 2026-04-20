---
title: Session Templates
---

# Session Templates

Session templates save a full session configuration — model, permission mode, effort, guidelines, MCP servers — for quick reuse.

## Creating a template

1. Configure a session with your preferred settings in the New Session form
2. Click **Save as Template**
3. Give the template a name

Or create one directly from Template Manager:
1. ⌘K → "Templates"
2. Click **New Template**
3. Fill in all configuration fields

## Applying a template

In the New Session form, select a template from the **Templates** dropdown. All settings are pre-populated.

Or apply via API:

```bash
POST /api/templates/:id/apply
```

This creates a new session with all the template's settings.

## Grid templates

Grid templates save a multi-session layout — a specific arrangement of sessions in the split/grid view.

1. Open Template Manager → **Grid Templates** tab
2. Click **New Grid Template**
3. Use the visual grid builder to arrange session types
4. Save and apply to recreate the layout instantly

## Template fields

| Field | Description |
|-------|-------------|
| **Name** | Template display name |
| **CLI** | Claude or Gemini |
| **Model** | Default model |
| **Permission mode** | Default permission mode |
| **Effort** | Effort level |
| **System prompt** | Custom system prompt fragment |
| **Guidelines** | Pre-attached guidelines |
| **MCP servers** | Pre-attached MCP servers |

## Related

- [Sessions: Creating](./creating) — create sessions from templates
- [Sessions: Configuration](./configuration) — all session config options
