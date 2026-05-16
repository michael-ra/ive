# Session-Scoped Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop default global hook installation and make IVE-managed sessions use session-scoped hook config.

**Architecture:** Move global mutation behind explicit APIs/settings. Add helper functions in `backend/hook_installer.py` that generate hook settings for a chosen base directory, and use those helpers from session startup paths to create IVE-owned per-session hook config. Startup should only wire the hook receiver, not call global install.

**Tech Stack:** Python backend, existing CLI profile registry, unittest, React settings copy.

---

### Task 1: Backend Hook Install Semantics

**Files:**
- Modify: `backend/hook_installer.py`
- Modify: `backend/server.py`
- Test: `tests/test_hook_installation_modes.py`

- [x] Write tests proving `install_all()` does not run at startup by default.
- [x] Add explicit global install/check helpers while preserving existing compatibility wrappers.
- [x] Change backend startup to generate relay scripts and wire receivers without global settings writes.

### Task 2: Session-Scoped Hook Config

**Files:**
- Modify: `backend/hook_installer.py`
- Modify: `backend/server.py`
- Modify: `backend/session_supervisor.py`
- Test: `tests/test_hook_installation_modes.py`

- [x] Write tests for session-scoped hook settings generation.
- [x] Generate `~/.ive/session_homes/<session_id>/<cli-home>/...` hook config for managed sessions.
- [x] Launch managed sessions with the session home when hook mode is `session_scoped`.

### Task 3: Settings And Docs

**Files:**
- Modify: `frontend/src/components/settings/WorkspaceSettingsPanel.jsx`
- Modify: `docs/guide/settings/safety.md`
- Modify: `README.md`

- [x] Update copy so auto-register/global hooks are clearly opt-in.
- [x] Document that normal startup does not touch global CLI settings.
- [x] Run backend tests and frontend/docs builds.
