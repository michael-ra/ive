---
title: Prompt Library
---

# Prompt Library

The Prompt Library (⌘/) stores reusable prompt templates organized by category.

## Opening the library

Press **⌘/** to open the Prompt Library. It has two tabs: **Prompts** and **Cascades**.

## Creating a prompt

1. Press **⌘/** → Prompts tab
2. Click **New Prompt**
3. Fill in:
   - **Title** — short name
   - **Category** — General, Coding, Analysis, etc.
   - **Content** — the prompt text (markdown supported)
4. Save

## Using a prompt

Click **Run** on any prompt to send it immediately to the active session.

Or use `@prompt:Name` in the terminal to expand the prompt inline before sending.

## Quick actions

Mark a prompt as a **Quick Action** to add it to the Quick Action Palette (⌘Y). Quick action prompts get:
- An icon (from lucide-react)
- A position in the quick action order
- Keyboard-accessible from ⌘Y

## Markdown preview

Toggle markdown preview to see how formatted prompts will render before using them.

## Pinning favorites

Pin frequently-used prompts to the top of the list for quick access.

## Token preview

When you type `@prompt:` in the terminal, a floating badge previews which prompt will be expanded — useful when prompt names are similar.

## Related

- [Cascades](../terminal/cascade) — multi-step prompt chains
- [Quick Action Palette](#) — rapid access to marked prompts
- [Terminal @-tokens](../terminal/overview) — token expansion
