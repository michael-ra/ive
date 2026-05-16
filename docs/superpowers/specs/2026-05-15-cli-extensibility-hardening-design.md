# CLI Extensibility Hardening Design

## Goal

Make adding a new CLI to IVE a bounded, low-surprise change — ideally one
`CLIProfile` plus one frontend fallback entry — and eliminate silent failures
when a registered CLI's binary is not installed. Three independent units,
each separately testable and shippable.

## Scope

In scope:

- **(a) Spawn-time CLI guard.** Profile-driven detection so creating or
  switching a session to an uninstalled CLI fails fast with a clear error
  instead of a raw `Failed to exec` line in the PTY.
- **(b) Single-source frontend registry.** Collapse the ~8 scattered static
  per-CLI structures into one registry-shaped constant plus one resolver,
  while preserving the existing store/API-preferred path and the static
  fallback for pre-load / offline rendering.
- **(c) hook_installer profile fields.** Replace the `profile.id == "gemini"`
  tool-event/script/matcher branches with the data already in
  `hook_event_map` plus two small new `CLIProfile` fields.

Explicitly out of scope (legitimate irreducible per-CLI behavior, not
stragglers): `account_sandbox` env-var differences, `codex_sessions` resume
semantics, `start.sh` shell detection blocks, and any per-CLI logic outside
`hook_installer` that is genuine behavior rather than encodable data.

## Architecture

The center of gravity stays `CLIProfile` / `PROFILES` in
`backend/cli_profiles.py` and the `/api/cli-info` + `/api/cli-info/features`
payloads built by `backend/cli_registry.py`. This design pushes three more
behaviors into that profile-driven spine.

### (a) Spawn-time CLI guard

New helper in `backend/cli_registry.py`:

```python
def cli_install_error(cli_id: str, *, which=shutil.which) -> str | None:
    """None if the CLI's binary is on PATH, else a user-facing message."""
```

It resolves the profile via `get_profile(cli_id)` and reuses the same
`shutil.which(profile.binary)` check that powers `available_clis` in
`build_cli_info_payload`, so detection has exactly one implementation.

Wired into the two HTTP entry points that already call
`validate_cli_type`:

- `create_session` (`server.py`, route `POST /api/sessions`): after
  `validate_cli_type`, if `cli_install_error` returns a message, respond
  `400 {"error": <message>}` before any session row or PTY is created.
- `switch_session_cli` (`server.py`, ~line 6893): same guard before the
  switch is applied.
- `pipeline_engine._auto_create_session`: pipeline stages **INSERT
  sessions directly** (not via the HTTP route), so the same
  `cli_install_error` guard is applied there explicitly, returning
  `None` (its existing "not created" signal) before any DB write.

Deep-research reaches sessions through `POST /api/sessions`, so it
inherits the `create_session` guard. `pty_manager.py` is unchanged.

### (b) Single-source frontend registry

`frontend/src/lib/constants.js` currently has store-first getters with
scattered static fallbacks: `CLI_TYPES`, `CLI_THEME`,
`MODELS`/`GEMINI_MODELS`/`CODEX_MODELS`,
`PERMISSION_MODES`/`GEMINI_APPROVAL_MODES`/`CODEX_PERMISSION_MODES`,
`EFFORT_LEVELS`/`CODEX_EFFORT_LEVELS`, plus per-CLI defaults and the
`getCliCapability` fallback.

Introduce one constant shaped like a `/api/cli-info/features` profile:

```js
export const CLI_FALLBACK = {
  claude: { label, available_models, available_permission_modes,
            effort_levels, default_model, default_permission_mode,
            ui_capabilities, theme },
  gemini: { ... },
  codex:  { ... },
}
```

One internal resolver:

```js
function cliProfile(cliType) {
  const store = tryStoreProfiles()           // useStore().cliProfiles
  return store?.[cliType] ?? CLI_FALLBACK[cliType] ?? CLI_FALLBACK.claude
}
```

Every existing exported getter keeps its **exact name and signature** but
reads from `cliProfile(cliType)`:

- `getModelsForCli`, `getPermissionModesForCli`, `getEffortLevelsForCli`,
  `getDefaultModel`, `getDefaultPermissionMode`, `getCliCapability`,
  `getCliTheme`, `getCliShortLabel`, `getCliBadgeClass`,
  `getCliSelectedClass`, `getCliSubtleClass`.
- `CLI_TYPES` derives from the store profiles when present, else
  `Object.entries(CLI_FALLBACK).map(([id, p]) => ({ id, label: p.label }))`.

The store/API path stays preferred and unchanged. The fallback is retained
(graceful pre-load / offline degradation, as the original Codex spec
intended) but consolidated so adding a CLI is one `CLI_FALLBACK` entry — and
zero frontend edits once `/api/cli-info/features` serves the new profile.
Legacy exported names (`GEMINI_MODELS`, `CODEX_MODELS`, etc.) remain as
thin aliases derived from `CLI_FALLBACK` so external importers do not break.

### (c) hook_installer profile fields

Two new `CLIProfile` fields:

- `avcp_hook_script: str` — basename of the AVCP relay script
  (`"claude-code.sh"`, `"gemini-cli.sh"`, `"codex-cli.sh"`).
- `avcp_tool_matcher: str = "*"` — Gemini overrides to
  `"edit_file|write_file|create_file"`.

Refactor `backend/hook_installer.py`:

- `pre_event` / `post_event` derivations
  (`"BeforeTool" if profile.id == "gemini" else "PreToolUse"`, etc.) become
  `profile.native_hook(HookEvent.PRE_TOOL)` /
  `profile.native_hook(HookEvent.POST_TOOL)`. This data already exists in
  every profile's `hook_event_map`; no new data is introduced for this part.
- The `AVCP_CLAUDE_HOOK` / `AVCP_GEMINI_HOOK` / `AVCP_CODEX_HOOK` constant
  trio and the `if profile.id == "gemini" … elif "codex" … else claude`
  install/uninstall/status blocks become generic:
  `AVCP_DIR / "hooks" / profile.avcp_hook_script`, installed under
  `profile.native_hook(HookEvent.PRE_TOOL)` with matcher
  `profile.avcp_tool_matcher`.
- `_gemini_available()` keeps its name/behavior but is re-expressed as
  `_cli_available(get_profile("gemini").binary)` to remove the string
  literal.

## Data Flow

- (a) `POST /api/sessions` → `validate_cli_type` → `cli_install_error` →
  early `400` or proceed to session creation.
- (b) component → `getXForCli(cliType)` → `cliProfile(cliType)` →
  store profile (from `/api/cli-info/features`) or `CLI_FALLBACK`.
- (c) `install_avcp_hooks` / `check_installation` / uninstall →
  `get_profile(cli)` → `avcp_hook_script` + `native_hook(PRE_TOOL)` +
  `avcp_tool_matcher` → write/inspect native settings.

## Error Handling

- (a) Missing binary is a user error → `400` with an actionable message
  naming the CLI and its binary; never a 500 or a raw PTY exec failure.
- (b) `cliProfile` always resolves (store → fallback → claude), so getters
  never throw on an unknown CLI; unknown id degrades to Claude shape, as
  today.
- (c) A profile missing `avcp_hook_script` (e.g. a partial future profile)
  skips AVCP install for that CLI with a warning, matching the current
  "hook script not found" behavior rather than raising.

## Testing

TDD throughout; backend tests run on `~/.ive/venv/bin/python3` (3.11).

- **(a)** `tests/test_codex_backend_surfaces.py`: `cli_install_error`
  returns `None` when `which` resolves and a message when it does not
  (injected `which`); registered-but-absent vs present. Plus a
  `create_session`-level assertion that an uninstalled cli_type yields
  `400` (via the existing aiohttp-free helper path or a focused unit on the
  guard branch).
- **(b)** No JS test harness exists in the repo (honest limitation). A
  Node behavior-preservation script snapshots every getter's output for
  `claude`/`gemini`/`codex` before and after the refactor and asserts
  equality; `cd frontend && npm run build` must pass.
- **(c)** `tests/test_hook_installation_modes.py`: assert the generic path
  resolves `BeforeTool`/`AfterTool` for Gemini and `PreToolUse`/
  `PostToolUse` for Codex and Claude, and that `avcp_hook_script` /
  `avcp_tool_matcher` are honored per profile.

Plus full-suite regression (`test_cli_profiles`,
`test_codex_backend_surfaces`, `test_hook_installation_modes`) and backend
import smoke after each unit.

## Verification

- All backend unit tests green on the 3.11 venv.
- `npm run build` green; getter snapshot diff empty.
- Backend import smoke for all touched modules.
- Manual: `cli_install_error("codex")` flips correctly when `codex` is
  removed from `PATH`; a profile-driven `hooks.json` round-trip for each
  CLI shows correct native event names.
