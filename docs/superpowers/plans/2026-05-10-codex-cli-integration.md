# Codex CLI Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for behavior changes. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Codex CLI as a first-class IVE CLI with parity to Claude Code and Gemini CLI.

**Architecture:** Add a Codex `CLIProfile`, then move runtime and UI surfaces from two-CLI conditionals to profile-driven helpers. Keep implementation incremental and test each layer before moving outward.

**Tech Stack:** Python 3.11 stdlib `unittest`, aiohttp backend, React 19/Vite frontend, shell `start.sh`, Codex CLI 0.130.0.

---

### Task 1: Backend Profile Spine

**Files:**
- Create: `tests/test_cli_profiles.py`
- Modify: `backend/cli_profiles.py`
- Modify: `backend/config.py`
- Modify: `backend/model_discovery.py`

- [x] Write failing unit tests for `UnifiedSession("codex")` command generation, defaults, feature matrix exposure, and no fallback to Claude for registered Codex.
- [x] Run `python3 -m unittest tests.test_cli_profiles` and verify Codex tests fail because the profile is missing.
- [x] Add `CODEX_PROFILE` with binary `codex`, models `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, permission modes mapping to Codex approval/sandbox flags, `AGENTS.md`, `.agents/skills`, `~/.agents/skills`, and Codex hook/MCP metadata.
- [x] Update config/model discovery exports so `/api/cli-info` can report Codex.
- [x] Re-run the profile tests and verify they pass.

### Task 2: Backend Runtime Surfaces

**Files:**
- Create: `tests/test_codex_backend_surfaces.py`
- Modify: `backend/server.py`
- Modify: `backend/auth_cycler.py`
- Modify: `backend/account_sandbox.py`
- Modify: `backend/mcp_server.py`
- Modify: `backend/history_reader.py`
- Modify: `backend/llm_router.py`

- [x] Write failing tests for `switch_session_cli` CLI validation helper, `/api/cli-info` availability data helper, Codex history listing from sample session index/rollout files, and Codex API-key env selection.
- [x] Run `python3 -m unittest tests.test_codex_backend_surfaces` and verify failures are about missing Codex behavior.
- [x] Replace hard-coded `("claude", "gemini")` validation with `PROFILES`.
- [x] Add Codex history discovery and message reading for rollout JSONL.
- [x] Add Codex model ladder and one-shot `llm_router` command shape using `codex exec`.
- [x] Add Codex API key env support with `OPENAI_API_KEY`/`CODEX_API_KEY` where appropriate.
- [x] Re-run backend tests.

### Task 3: Hooks, Skills, Security, Startup

**Files:**
- Create: `anti-vibe-code-pwner/hooks/codex-cli.sh`
- Modify: `backend/hook_installer.py`
- Modify: `backend/skill_installer.py`
- Modify: `backend/plugin_translator.py`
- Modify: `anti-vibe-code-pwner/avcp`
- Modify: `start.sh`

- [x] Add tests or import checks covering hook installer profile iteration and skill directory defaults.
- [x] Add Codex hook relay support through the existing profile-driven hook installer.
- [x] Add AVCP Codex setup and hook script using Codex `PreToolUse` JSON decision output.
- [x] Make default skill install/uninstall target all registered profiles.
- [x] Add Codex optional CLI detection and auto-update support to `start.sh`.
- [x] Run Python unit/import tests and shell syntax checks.

### Task 4: Frontend Profile-Driven UI

**Files:**
- Modify: `frontend/src/lib/constants.js`
- Modify: `frontend/src/lib/terminal.js`
- Modify: `frontend/src/components/layout/Sidebar.jsx`
- Modify: `frontend/src/components/layout/TopBar.jsx`
- Modify: `frontend/src/components/pipeline/PipelineEditor.jsx`
- Modify: `frontend/src/components/marketplace/MarketplacePanel.jsx`
- Modify: `frontend/src/components/settings/GeneralSettingsPanel.jsx`
- Modify: `frontend/src/components/settings/WorkspaceSettingsPanel.jsx`
- Modify: `frontend/src/components/command/AccountManager.jsx`

- [x] Add Codex static fallback constants and profile presentation helpers.
- [x] Replace Claude/Gemini quick-pick lists with profile-driven model options.
- [x] Add Codex badge/color/short-label behavior.
- [x] Add Codex terminal input strategy so multiline input and clearing are explicit.
- [x] Update account, marketplace, pipeline, workspace settings, and general settings copy/actions.
- [x] Run `cd frontend && npm run build`.

### Task 5: Documentation and End-to-End Verification

**Files:**
- Modify: `README.md`
- Modify: `INSTALL.md`
- Modify: `docs/guide/installation.md`
- Modify: `docs/guide/introduction.md`
- Modify: `docs/api/sessions.md`
- Modify: `docs/api/overview.md`
- Modify: `docs/api/websocket.md`
- Modify: other docs found by `rg "Claude|Gemini|cli_type" docs README.md INSTALL.md`.

- [x] Update public docs to list Codex as supported.
- [x] Run backend unit tests.
- [x] Run frontend build.
- [x] Run `codex exec --ephemeral --sandbox read-only --model gpt-5.4-mini "Reply exactly: IVE codex smoke test ok"` with required permissions if the sandbox blocks Codex state.
- [x] Record remaining gaps honestly.

### Verification Notes

- `codex exec` smoke passed with Codex CLI 0.130.0 and returned `IVE codex smoke test ok`.
- `npm install` updated `frontend/package-lock.json` to include the existing Node engine from `package.json`; npm audit still reports two moderate vulnerabilities.
- Codex emitted non-fatal local state/plugin warnings during the smoke test, but exited 0.
