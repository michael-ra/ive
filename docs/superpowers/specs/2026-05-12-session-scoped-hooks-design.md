# Session-Scoped Hooks Design

## Goal

IVE must not mutate global Claude, Gemini, or Codex hook settings during normal startup or when launching IVE-managed sessions.

## Behavior

By default, IVE writes hook relay scripts under `~/.ive/hooks/` and uses IVE-owned session homes/config for managed sessions. Global CLI hook settings are modified only when the user explicitly enables external terminal integration or a global protection feature.

## Modes

- `session_scoped`: default. Managed sessions get IVE hooks through session-local config only.
- `global`: opt-in. IVE installs hooks into native CLI settings so externally launched CLIs can auto-register.
- `disabled`: no lifecycle hooks are configured; PTY output still works, but structured state tracking is reduced.

## Non-Goals

- Do not remove the hook receiver API.
- Do not remove external terminal auto-register; make its global config dependency explicit.
- Do not rewrite the CLI abstraction.

## Testing

Tests should prove that startup no longer installs global hooks by default, that explicit global installation still works, and that session-scoped hook files can be generated without touching real home directories.
