---
title: Screenshots & Annotations
---

# Screenshots & Annotations

Commander includes a screenshot capture and annotation system for sharing visual context with sessions.

![Visual Collaboration](/visual-collaboration.svg)

## Preview Palette (⌘P)

The Preview Palette opens a URL or takes a screenshot of any webpage.

1. Press **⌘P**
2. Enter a URL
3. Choose **Preview** (open in panel) or **Screenshot** (capture)

The captured image appears in the palette and can be annotated or sent to the active session.

## Screenshot Annotator

The Screenshot Annotator lets you mark up captured images with drawing tools before sending them to a session.

### Drawing tools

| Tool | Use |
|------|-----|
| **Rectangle** | Highlight regions |
| **Arrow** | Point to specific areas |
| **Pencil** | Free-form drawing |
| **Text** | Add labels |

### Colors

8 colors available: red, yellow, blue, green, white, black, orange, purple.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| ⌘Z | Undo |
| ⌘⇧Z | Redo |

### Sending to session

After annotating, click **Send to Session** — the annotated image is pasted into the terminal as a context attachment.

## Terminal Annotation (⌘⇧A)

Annotate specific segments of terminal output:

1. Press **⌘⇧A**
2. Select a region of terminal output
3. Add a comment
4. The annotation is preserved with the session

## Image from Clipboard

Paste an image directly into a session:

```bash
POST /api/paste-image
```

Or use **⌘V** in the terminal when a screenshot is on your clipboard.

## Live Preview

The Live Preview panel shows a real-time browser preview of a URL, useful for checking web app output while Claude works.

## Related

- [Terminal](./terminal/overview) — main terminal view
- [API: Screenshots](../api/sessions) — screenshot endpoints
