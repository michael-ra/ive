---
title: Screenshots, Annotations & Walkthroughs
---

# Screenshots, Annotations & Walkthroughs

IVE has three different ways to send visual context to a session: a one-shot screenshot, an annotated image, or a recorded walkthrough with your voice on top. Pick whichever fits the level of detail you want to convey.

![Visual Collaboration](/visual-collaboration.svg)

## Preview Palette (⌘P)

The Preview Palette opens a URL or grabs a screenshot of any webpage.

1. Press **⌘P**.
2. Enter a URL.
3. Pick **Preview** (open in panel) or **Screenshot** (one-shot capture).

The captured image appears in the palette, where you can annotate it or send it straight to the active session.

## Live Preview (the voice walkthrough story)

The Live Preview panel renders a real-time browser preview of any URL — typically the dev server you're working on. It's where the more interesting flows live.

### One-shot screenshot — ⌘↵

While the Live Preview is open, press **⌘↵** to grab the current frame. The screenshot lands in the Image Annotator (see below).

### Hold-to-record voice walkthrough — ⌘R

This is the killer flow. **Hold ⌘R** while you talk over the live preview. IVE records:

1. The screen as a video clip.
2. Your microphone as voice-over audio.
3. The Web Speech API transcript so the voice gets dropped into the session as text too.

Release ⌘R to stop. IVE assembles the clip and pastes it into the terminal as a context attachment, with the transcript inline. The session sees both — the image / video AND your spoken intent — so you don't have to type out what you wanted iterated.

::: tip
This is the fastest way to give a session feedback on a UI. Open the live preview, hold ⌘R, point and talk: "the button on the right needs a softer shadow, and the modal should close when you click outside". The agent gets a 5-second clip plus that transcript verbatim.
:::

### Browser support

The voice transcript uses the Web Speech API. Chrome / Edge / Safari are all supported; Firefox transcript may be empty (the audio still gets captured).

## Image Annotator

When you screenshot from any source (Preview Palette, Live Preview, paste from clipboard), the Image Annotator opens before send.

### Drawing tools

| Tool | Use |
|------|-----|
| **Rectangle** | Highlight regions |
| **Arrow** | Point to specific areas |
| **Pencil** | Free-form drawing |
| **Text** | Add labels |

### Colors

8 colors: red, yellow, blue, green, white, black, orange, purple.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| ⌘Z | Undo |
| ⌘⇧Z | Redo |
| Esc | Cancel and discard |

### Sending to session

Click **Send to Session** — the annotated image is pasted into the terminal as a context attachment. The agent receives the image with annotations baked into the pixels.

## Terminal Annotator (⌘⇧A)

Annotate specific segments of terminal output instead of an external screenshot.

1. Press **⌘⇧A** while in a session.
2. The terminal switches to selection mode — segments are highlighted by ownership (Claude vs you).
3. Click a segment, add a comment.
4. The annotation is preserved with the session and shows on hover.

Use this when you want to point at a specific tool call, error, or output line and add context without taking a separate screenshot.

## Image from Clipboard

Paste an image directly into a session with **⌘V** while focused on the terminal. IVE detects the clipboard image, opens the Image Annotator, and lets you mark it up before sending.

You can also paste programmatically:

```bash
POST /api/paste-image
```

## Related

- [Terminal](./terminal/overview) — main terminal view
- [Keyboard Shortcuts](./keyboard-shortcuts) — full shortcut reference
- [API: Screenshots](../api/sessions) — programmatic capture
