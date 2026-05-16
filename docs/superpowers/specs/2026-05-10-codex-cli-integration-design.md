# Codex CLI Integration Design

## Goal

IVE should treat Codex CLI as a first-class CLI next to Claude Code and Gemini CLI. Users should be able to create, switch, run, authorize, equip, observe, and document Codex sessions through the same surfaces.

## Scope

Add a `codex` CLI profile and remove the important two-CLI assumptions across backend, frontend, docs, and local startup checks. The first implementation must support normal interactive PTY sessions, model and permission selection, profile-driven UI rendering, MCP registration, hooks, skills, memory guidance, account/API-key routing, and smoke verification against the installed Codex CLI.

History import and native resume should use Codex's `~/.codex/session_index.jsonl` and `~/.codex/sessions/**/rollout-*.jsonl` files. If a full native resume mapping proves unstable, Codex sessions should still start reliably and record enough native metadata for later improvement.

## Architecture

The center remains `CLIProfile` in `backend/cli_profiles.py`. Codex-specific command flags, feature support, paths, hooks, model choices, and UI capabilities live there. Runtime code asks the profile for behavior instead of branching on `claude` and `gemini`.

Frontend constants become registry-aware: static fallbacks include Codex, but the preferred data comes from `/api/cli-info/features`. UI colors, short labels, message markers, terminal input behavior, and quick-launch model menus should use profile metadata where possible.

## Verification

Use unit tests for profile command generation and backend registry behavior, frontend production build for UI integration, backend import smoke checks, and one real local Codex smoke test. The real smoke test should be read-only and minimal.
