# CLI Extensibility Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make adding a new CLI a bounded change (one `CLIProfile` + one frontend fallback entry) and fail fast when a registered CLI's binary is absent.

**Architecture:** Three independent units. (A) a profile-driven install guard in `cli_registry` wired into the two session entry points; (C) replace `hook_installer`'s `profile.id == "gemini"` branches with existing `hook_event_map` data plus five new `CLIProfile` fields; (B) collapse the scattered frontend static CLI structures into one registry-shaped `CLI_FALLBACK` constant behind a single `cliProfile()` resolver, keeping every getter signature identical.

**Tech Stack:** Python 3.11 stdlib `unittest` (run via `~/.ive/venv/bin/python3`), aiohttp backend, React 19 / Vite frontend (no JS test harness — verified by build + behavior snapshot), `shutil.which` for detection.

**Spec:** `docs/superpowers/specs/2026-05-15-cli-extensibility-hardening-design.md`

**Spec→plan refinement (recorded intentionally):** the spec's single `avcp_tool_matcher` is split into the precise fields the code actually needs: `tool_event_matcher` (myelin/safety-gate tool scope, Gemini = file-write tools) and the AVCP-entry triple `avcp_hook_script` / `avcp_matcher` / `avcp_timeout` (Gemini timeout is milliseconds). `home_env_var` is added for the `_profile_home_env` branch in the same file, which is the same straggler class.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `backend/cli_registry.py` | profile-driven HTTP helpers | **Modify** — add `cli_install_error()` |
| `backend/server.py` | routes | **Modify** — guard in `create_session` (~3682) + `switch_session_cli` (~6893) |
| `backend/cli_profiles.py` | `CLIProfile` + `PROFILES` | **Modify** — add 5 fields; populate for claude/gemini/codex |
| `backend/hook_installer.py` | native hook install | **Modify** — generic AVCP/home/tool-event paths |
| `frontend/src/lib/constants.js` | CLI static data + getters | **Modify** — `CLI_FALLBACK` + `cliProfile()` resolver |
| `tests/test_codex_backend_surfaces.py` | backend surface tests | **Modify** — guard + field tests |
| `tests/test_hook_installation_modes.py` | hook install tests | **Modify** — generic-path tests |
| `tests/test_frontend_cli_fallback.mjs` | getter snapshot guard | **Create** — Node behavior-preservation check |

Run all backend tests with: `~/.ive/venv/bin/python3 -m unittest tests.test_cli_profiles tests.test_codex_backend_surfaces tests.test_hook_installation_modes`

---

## Task A1: Spawn-time CLI install guard

**Files:**
- Modify: `backend/cli_registry.py`
- Test: `tests/test_codex_backend_surfaces.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_codex_backend_surfaces.py` inside `CodexBackendSurfaceTests`:

```python
    def test_cli_install_error_is_profile_driven(self):
        present = lambda b: "/usr/bin/" + b
        absent = lambda b: None
        self.assertIsNone(
            cli_registry.cli_install_error("codex", which=present)
        )
        msg = cli_registry.cli_install_error("codex", which=absent)
        self.assertIsInstance(msg, str)
        self.assertIn("codex", msg.lower())
        # Unknown id resolves a profile (claude fallback) but still checks its binary.
        self.assertIsNone(
            cli_registry.cli_install_error("claude", which=present)
        )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.ive/venv/bin/python3 -m unittest tests.test_codex_backend_surfaces.CodexBackendSurfaceTests.test_cli_install_error_is_profile_driven -v`
Expected: FAIL — `AttributeError: module 'cli_registry' has no attribute 'cli_install_error'`

- [ ] **Step 3: Write minimal implementation**

In `backend/cli_registry.py`, add after the imports / before `validate_cli_type`:

```python
def cli_install_error(
    cli_id: str, *, which: Callable[[str], str | None] = shutil.which
) -> str | None:
    """None if the CLI's binary is on PATH, else a user-facing message.

    Uses the same `which(profile.binary)` check that powers
    `available_clis`, so detection has exactly one implementation.
    """
    profile = get_profile(cli_id)
    if which(profile.binary) is not None:
        return None
    return (
        f"{profile.label} (binary '{profile.binary}') is not installed. "
        f"Install it to start {cli_id} sessions."
    )
```

(`shutil`, `Callable`, and `get_profile` are already imported in this module.)

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.ive/venv/bin/python3 -m unittest tests.test_codex_backend_surfaces.CodexBackendSurfaceTests.test_cli_install_error_is_profile_driven -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/cli_registry.py tests/test_codex_backend_surfaces.py
git commit -m "feat(cli): profile-driven cli_install_error helper"
```

---

## Task A2: Wire the guard into session entry points

**Files:**
- Modify: `backend/server.py` (`create_session` ~3682, `switch_session_cli` ~6893)
- Test: `tests/test_codex_backend_surfaces.py`

- [ ] **Step 1: Write the failing test**

Add to `CodexBackendSurfaceTests`:

```python
    def test_server_session_entry_points_call_install_guard(self):
        src = (BACKEND / "server.py").read_text()
        # create_session must validate + guard the cli_type, not silently
        # fall back to claude for an unknown/uninstalled CLI.
        self.assertIn("cli_install_error(", src)
        # Guard must be referenced at least twice (create + switch).
        self.assertGreaterEqual(src.count("cli_install_error("), 2)
        self.assertIn(
            "from cli_registry import", src
        )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.ive/venv/bin/python3 -m unittest tests.test_codex_backend_surfaces.CodexBackendSurfaceTests.test_server_session_entry_points_call_install_guard -v`
Expected: FAIL — `cli_install_error(` not found in server.py

- [ ] **Step 3: Add import**

In `backend/server.py`, change the existing line:

```python
from cli_registry import build_cli_info_payload, cli_for_model, validate_cli_type
```

to:

```python
from cli_registry import (build_cli_info_payload, cli_for_model,
                          cli_install_error, validate_cli_type)
```

- [ ] **Step 4: Guard `create_session`**

In `backend/server.py` `create_session`, replace this line (~3682):

```python
    cli_type = body.get("cli_type", "claude")
```

with:

```python
    try:
        cli_type = validate_cli_type(body.get("cli_type", "claude"))
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    _install_err = cli_install_error(cli_type)
    if _install_err:
        return web.json_response({"error": _install_err}, status=400)
```

- [ ] **Step 5: Guard `switch_session_cli`**

In `backend/server.py` `switch_session_cli`, after this existing block (~6893):

```python
    try:
        new_cli_type = validate_cli_type(body.get("cli_type"))
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
```

insert immediately after:

```python
    _install_err = cli_install_error(new_cli_type)
    if _install_err:
        return web.json_response({"error": _install_err}, status=400)
```

- [ ] **Step 6: Run test + import smoke**

Run: `~/.ive/venv/bin/python3 -m unittest tests.test_codex_backend_surfaces.CodexBackendSurfaceTests.test_server_session_entry_points_call_install_guard -v`
Expected: PASS

Run: `cd backend && ~/.ive/venv/bin/python3 -c "import server; print('ok')" && cd ..`
Expected: `ok`

- [ ] **Step 7: Full suite + commit**

Run: `~/.ive/venv/bin/python3 -m unittest tests.test_cli_profiles tests.test_codex_backend_surfaces tests.test_hook_installation_modes`
Expected: `OK`

```bash
git add backend/server.py tests/test_codex_backend_surfaces.py
git commit -m "feat(cli): block session create/switch for uninstalled CLI"
```

---

## Task C1: Add five CLIProfile fields + populate

**Files:**
- Modify: `backend/cli_profiles.py`
- Test: `tests/test_cli_profiles.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_cli_profiles.py` inside `CodexProfileTests`:

```python
    def test_profiles_expose_hook_install_metadata(self):
        expected = {
            "claude": ("CLAUDE_CONFIG_DIR", "claude-code.sh", "Bash", 30, "*"),
            "gemini": ("GEMINI_HOME", "gemini-cli.sh",
                       "shell_execute|run_shell_command|Bash", 30000,
                       "edit_file|write_file|create_file"),
            "codex":  ("CODEX_HOME", "codex-cli.sh",
                       "Bash|shell|shell_command", 30, "*"),
        }
        for cid, (env, script, matcher, timeout, tool_match) in expected.items():
            p = get_profile(cid)
            self.assertEqual(p.home_env_var, env, cid)
            self.assertEqual(p.avcp_hook_script, script, cid)
            self.assertEqual(p.avcp_matcher, matcher, cid)
            self.assertEqual(p.avcp_timeout, timeout, cid)
            self.assertEqual(p.tool_event_matcher, tool_match, cid)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.ive/venv/bin/python3 -m unittest tests.test_cli_profiles.CodexProfileTests.test_profiles_expose_hook_install_metadata -v`
Expected: FAIL — `AttributeError: 'CLIProfile' object has no attribute 'home_env_var'`

- [ ] **Step 3: Add dataclass fields**

In `backend/cli_profiles.py`, in the `CLIProfile` dataclass, after the `session_file_pattern` field (~line 156) add:

```python
    # ── Hook installer metadata (profile-driven hook_installer) ───────
    home_env_var: str = ""                      # CLAUDE_CONFIG_DIR / CODEX_HOME / GEMINI_HOME
    avcp_hook_script: str = ""                   # basename under anti-vibe-code-pwner/hooks/
    avcp_matcher: str = "*"                      # AVCP entry tool matcher
    avcp_timeout: int = 30                       # AVCP hook timeout (Gemini uses ms)
    tool_event_matcher: str = "*"                # myelin/safety-gate tool scope
```

- [ ] **Step 4: Populate CLAUDE_PROFILE**

In `CLAUDE_PROFILE = CLIProfile(...)`, add these keyword args (anywhere in the call, e.g. before `mcp_strategy=`):

```python
    home_env_var="CLAUDE_CONFIG_DIR",
    avcp_hook_script="claude-code.sh",
    avcp_matcher="Bash",
    avcp_timeout=30,
    tool_event_matcher="*",
```

- [ ] **Step 5: Populate GEMINI_PROFILE**

In `GEMINI_PROFILE = CLIProfile(...)` add:

```python
    home_env_var="GEMINI_HOME",
    avcp_hook_script="gemini-cli.sh",
    avcp_matcher="shell_execute|run_shell_command|Bash",
    avcp_timeout=30000,
    tool_event_matcher="edit_file|write_file|create_file",
```

- [ ] **Step 6: Populate CODEX_PROFILE**

In `CODEX_PROFILE = CLIProfile(...)` add:

```python
    home_env_var="CODEX_HOME",
    avcp_hook_script="codex-cli.sh",
    avcp_matcher="Bash|shell|shell_command",
    avcp_timeout=30,
    tool_event_matcher="*",
```

- [ ] **Step 7: Run test + commit**

Run: `~/.ive/venv/bin/python3 -m unittest tests.test_cli_profiles -v`
Expected: PASS (all profile tests green)

```bash
git add backend/cli_profiles.py tests/test_cli_profiles.py
git commit -m "feat(cli): add hook-installer metadata fields to CLIProfile"
```

---

## Task C2: Use profile data for home-env + tool events (drop profile.id branches)

**Files:**
- Modify: `backend/hook_installer.py`
- Test: `tests/test_hook_installation_modes.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_hook_installation_modes.py` (it already imports `hook_installer`; ensure `from cli_profiles import get_profile` and `from cli_features import HookEvent` are imported at top — add if missing):

```python
    def test_hook_installer_has_no_gemini_id_branches(self):
        src = (BACKEND / "hook_installer.py").read_text()
        # The BeforeTool/AfterTool split must come from hook_event_map,
        # not from `profile.id == "gemini"` string checks.
        self.assertNotIn('profile.id == "gemini"', src)
        self.assertNotIn("profile.id == 'gemini'", src)
        # _profile_home_env must use the profile field, not id branches.
        self.assertIn("profile.home_env_var", src)
```

(`BACKEND` is defined at the top of this test module as `ROOT / "backend"`. If not present, add `BACKEND = Path(__file__).resolve().parents[1] / "backend"`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.ive/venv/bin/python3 -m unittest tests.test_hook_installation_modes.HookInstallationModeTests.test_hook_installer_has_no_gemini_id_branches -v`
Expected: FAIL — `'profile.id == "gemini"'` still present

- [ ] **Step 3: Refactor `_profile_home_env`**

In `backend/hook_installer.py`, replace this block (~180-185):

```python
    if profile.id == "claude":
        env["CLAUDE_CONFIG_DIR"] = str(cli_home)
    elif profile.id == "codex":
        env["CODEX_HOME"] = str(cli_home)
    elif profile.id == "gemini":
        env["GEMINI_HOME"] = str(cli_home)
    return env
```

with:

```python
    if profile.home_env_var:
        env[profile.home_env_var] = str(cli_home)
    return env
```

- [ ] **Step 4: Refactor myelin tool matcher (~624)**

Replace:

```python
        matcher = "edit_file|write_file|create_file" if profile.id == "gemini" else "*"
```

with:

```python
        matcher = profile.tool_event_matcher
```

- [ ] **Step 5: Refactor pre/post event derivations (~972-973 and ~1057-1058)**

There are two identical pairs. Replace **each** occurrence of:

```python
        pre_event = "BeforeTool" if profile.id == "gemini" else "PreToolUse"
        post_event = "AfterTool" if profile.id == "gemini" else "PostToolUse"
```

with:

```python
        pre_event = profile.native_hook(HookEvent.PRE_TOOL)
        post_event = profile.native_hook(HookEvent.POST_TOOL)
```

Ensure `from cli_features import HookEvent` is imported at the top of `hook_installer.py` (add if absent).

- [ ] **Step 6: Run tests + import smoke**

Run: `~/.ive/venv/bin/python3 -m unittest tests.test_hook_installation_modes -v`
Expected: PASS (including the new test; `profile.id == "gemini"` gone)

Run: `cd backend && ~/.ive/venv/bin/python3 -c "import hook_installer; print('ok')" && cd ..`
Expected: `ok`

- [ ] **Step 7: Commit**

```bash
git add backend/hook_installer.py tests/test_hook_installation_modes.py
git commit -m "refactor(hooks): derive home-env + tool events from profile data"
```

---

## Task C3: Generic AVCP entry + install/uninstall (drop the script-constant trio)

**Files:**
- Modify: `backend/hook_installer.py`
- Test: `tests/test_hook_installation_modes.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_hook_installation_modes.py`:

```python
    def test_avcp_entry_is_profile_driven(self):
        from cli_profiles import get_profile
        for cid, script, matcher, timeout in [
            ("claude", "claude-code.sh", "Bash", 30),
            ("gemini", "gemini-cli.sh",
             "shell_execute|run_shell_command|Bash", 30000),
            ("codex", "codex-cli.sh", "Bash|shell|shell_command", 30),
        ]:
            entry = hook_installer._avcp_entry(get_profile(cid))
            self.assertEqual(entry["matcher"], matcher, cid)
            self.assertEqual(entry["hooks"][0]["timeout"], timeout, cid)
            self.assertTrue(
                entry["hooks"][0]["command"].endswith(script), cid
            )
        src = (BACKEND / "hook_installer.py").read_text()
        self.assertNotIn("profile.id == \"codex\"", src)
        self.assertNotIn("profile.id == 'codex'", src)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.ive/venv/bin/python3 -m unittest tests.test_hook_installation_modes.HookInstallationModeTests.test_avcp_entry_is_profile_driven -v`
Expected: FAIL — `AttributeError: module 'hook_installer' has no attribute '_avcp_entry'`

- [ ] **Step 3: Add `AVCP_HOOKS_DIR` + generic `_avcp_entry`**

In `backend/hook_installer.py`, near the existing `AVCP_CLAUDE_HOOK` definitions (~367-369), add:

```python
AVCP_HOOKS_DIR = AVCP_DIR / "hooks"


def _avcp_entry(profile) -> dict:
    """AVCP hook entry for any CLI, driven entirely by profile fields."""
    return {
        "matcher": profile.avcp_matcher,
        "hooks": [{
            "type": "command",
            "command": str(AVCP_HOOKS_DIR / profile.avcp_hook_script),
            "timeout": profile.avcp_timeout,
        }],
    }


def _avcp_scripts() -> list[Path]:
    """All AVCP relay script paths across registered profiles."""
    seen, out = set(), []
    for p in PROFILES.values():
        if p.avcp_hook_script and p.avcp_hook_script not in seen:
            seen.add(p.avcp_hook_script)
            out.append(AVCP_HOOKS_DIR / p.avcp_hook_script)
    return out
```

Ensure `from cli_profiles import PROFILES, get_profile` and `from pathlib import Path` are imported at the top of `hook_installer.py` (add `PROFILES` to the existing `cli_profiles` import if missing).

- [ ] **Step 4: Replace the `install_avcp_hooks` per-CLI blocks (~450-500)**

Replace the Claude block, the `if GEMINI_SETTINGS.parent.exists() and AVCP_GEMINI_HOOK.exists():` block, and the `codex_settings = _settings_path_for(get_profile("codex"))` block with one loop:

```python
    for cli_id, profile in PROFILES.items():
        if not profile.avcp_hook_script:
            continue
        script = AVCP_HOOKS_DIR / profile.avcp_hook_script
        if not script.exists():
            continue
        settings_path = _settings_path_for(profile)
        if cli_id != "claude" and not settings_path.parent.exists():
            continue
        settings = _read_settings(settings_path)
        hooks = settings.setdefault("hooks", {})
        event = profile.native_hook(HookEvent.PRE_TOOL)
        bucket = hooks.setdefault(event, [])
        already = any(
            _is_avcp_hook(h)
            for group in bucket
            for h in group.get("hooks", [])
        )
        if not already:
            bucket.append(_avcp_entry(profile))
        _write_settings(settings_path, settings)
        logger.info(f"AVCP hook installed in {settings_path} ({event})")
```

- [ ] **Step 5: Replace the `_append_session_optional_hooks` AVCP block (~1039-1051)**

Replace:

```python
        for hook_path in (AVCP_CLAUDE_HOOK, AVCP_GEMINI_HOOK, AVCP_CODEX_HOOK):
            if hook_path.exists():
                hook_path.chmod(
                    hook_path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH
                )
        if profile.id == "gemini" and AVCP_GEMINI_HOOK.exists():
            settings = _append_entry_once(settings, "BeforeTool", _avcp_gemini_entry(), _is_avcp_hook)
        elif profile.id == "codex" and AVCP_CODEX_HOOK.exists():
            settings = _append_entry_once(settings, "PreToolUse", _avcp_codex_entry(), _is_avcp_hook)
        elif AVCP_CLAUDE_HOOK.exists():
            settings = _append_entry_once(settings, "PreToolUse", _avcp_claude_entry(), _is_avcp_hook)
```

with:

```python
        for script in _avcp_scripts():
            if script.exists():
                script.chmod(
                    script.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH
                )
        _avcp_script = AVCP_HOOKS_DIR / profile.avcp_hook_script
        if profile.avcp_hook_script and _avcp_script.exists():
            settings = _append_entry_once(
                settings, profile.native_hook(HookEvent.PRE_TOOL),
                _avcp_entry(profile), _is_avcp_hook,
            )
```

- [ ] **Step 6: Redirect the old constants + entry builders to the generic path**

Replace the bodies of `_avcp_claude_entry`, `_avcp_gemini_entry`, `_avcp_codex_entry` (keep the names — other call sites/tests may reference them) so they delegate:

```python
def _avcp_claude_entry() -> dict:
    return _avcp_entry(get_profile("claude"))


def _avcp_gemini_entry() -> dict:
    return _avcp_entry(get_profile("gemini"))


def _avcp_codex_entry() -> dict:
    return _avcp_entry(get_profile("codex"))
```

Leave `AVCP_CLAUDE_HOOK`/`AVCP_GEMINI_HOOK`/`AVCP_CODEX_HOOK` definitions in place (still referenced by `_remove_avcp_from_settings` chmod loops and status); they remain correct. Replace any remaining `for hook_path in (AVCP_CLAUDE_HOOK, AVCP_GEMINI_HOOK, AVCP_CODEX_HOOK):` chmod loop bodies with `for hook_path in _avcp_scripts():`.

- [ ] **Step 7: Refactor `_gemini_available`**

Replace:

```python
def _gemini_available() -> bool:
    """Check if gemini CLI is installed (backward compat wrapper)."""
    return _cli_available("gemini")
```

with:

```python
def _gemini_available() -> bool:
    """Check if gemini CLI is installed (backward compat wrapper)."""
    return _cli_available(get_profile("gemini").binary)
```

- [ ] **Step 8: Run tests + import smoke**

Run: `~/.ive/venv/bin/python3 -m unittest tests.test_hook_installation_modes -v`
Expected: PASS (new test green; no `profile.id == "gemini"`/`"codex"` remain)

Run: `cd backend && ~/.ive/venv/bin/python3 -c "import hook_installer, server; print('ok')" && cd ..`
Expected: `ok`

- [ ] **Step 9: Full suite + commit**

Run: `~/.ive/venv/bin/python3 -m unittest tests.test_cli_profiles tests.test_codex_backend_surfaces tests.test_hook_installation_modes`
Expected: `OK`

```bash
git add backend/hook_installer.py tests/test_hook_installation_modes.py
git commit -m "refactor(hooks): generic profile-driven AVCP install path"
```

---

## Task B1: Capture frontend getter outputs (behavior baseline)

**Files:**
- Create: `tests/test_frontend_cli_fallback.mjs`

- [ ] **Step 1: Write the snapshot harness**

Create `tests/test_frontend_cli_fallback.mjs`:

```js
// Behavior-preservation guard for the constants.js CLI refactor.
// No store is available outside the app, so getters use the static
// fallback path — exactly what must stay identical for claude/gemini/codex.
import assert from 'node:assert/strict'
import * as C from '../frontend/src/lib/constants.js'

const clis = ['claude', 'gemini', 'codex', 'unknown']
const getters = [
  'getModelsForCli', 'getPermissionModesForCli', 'getEffortLevelsForCli',
  'getDefaultModel', 'getDefaultPermissionMode', 'getCliShortLabel',
  'getCliBadgeClass', 'getCliSelectedClass', 'getCliSubtleClass',
]
const snap = {}
for (const g of getters) for (const c of clis) snap[`${g}:${c}`] = C[g](c)
snap['CLI_TYPES'] = C.CLI_TYPES
snap['cap:force_send:claude'] = C.getCliCapability('claude', 'force_send')
snap['cap:terminal_input:codex'] = C.getCliCapability('codex', 'terminal_input')
snap['cap:terminal_input:gemini'] = C.getCliCapability('gemini', 'terminal_input')
snap['cap:terminal_input:claude'] = C.getCliCapability('claude', 'terminal_input')

const fs = await import('node:fs')
const path = new URL('./.cli_fallback_baseline.json', import.meta.url)
if (process.argv.includes('--write')) {
  fs.writeFileSync(path, JSON.stringify(snap, null, 2))
  console.log('baseline written')
} else {
  const base = JSON.parse(fs.readFileSync(path, 'utf8'))
  assert.deepEqual(snap, base, 'getter outputs changed vs baseline')
  console.log('cli fallback snapshot: OK')
}
```

- [ ] **Step 2: Write the baseline from CURRENT (pre-refactor) code**

Run: `node tests/test_frontend_cli_fallback.mjs --write`
Expected: `baseline written` (creates `tests/.cli_fallback_baseline.json` capturing today's behavior)

- [ ] **Step 3: Verify the guard passes against current code**

Run: `node tests/test_frontend_cli_fallback.mjs`
Expected: `cli fallback snapshot: OK`

- [ ] **Step 4: Commit the baseline**

```bash
git add tests/test_frontend_cli_fallback.mjs tests/.cli_fallback_baseline.json
git commit -m "test(fe): behavior baseline for CLI getter outputs"
```

---

## Task B2: Single-source CLI_FALLBACK + cliProfile resolver

**Files:**
- Modify: `frontend/src/lib/constants.js`
- Test: `tests/test_frontend_cli_fallback.mjs` (must stay green — no `--write`)

- [ ] **Step 1: Add `CLI_FALLBACK` + `cliProfile()` resolver**

In `frontend/src/lib/constants.js`, after `CODEX_EFFORT_LEVELS` (~line 82) and before `CLI_THEME`, add:

```js
// ─── Single-source CLI registry fallback ────────────────────
// Shaped like a /api/cli-info/features profile. The store value
// (loaded from that endpoint) is always preferred; this is the
// pre-load / offline fallback. Adding a CLI = one entry here.
export const CLI_FALLBACK = {
  claude: {
    label: 'Claude',
    available_models: MODELS,
    available_permission_modes: PERMISSION_MODES,
    effort_levels: EFFORT_LEVELS,
    default_model: 'sonnet',
    default_permission_mode: 'default',
    ui_capabilities: { force_send: true, terminal_input: 'ink' },
    theme: {
      shortLabel: 'CLA',
      badge: 'bg-indigo-500/12 text-indigo-300 border-indigo-500/20',
      selected: 'bg-accent-subtle text-indigo-400 border border-indigo-500/25',
      subtle: 'text-indigo-400 bg-indigo-500/10',
      hover: 'hover:bg-accent-subtle',
    },
  },
  gemini: {
    label: 'Gemini',
    available_models: GEMINI_MODELS,
    available_permission_modes: GEMINI_APPROVAL_MODES,
    effort_levels: [],
    default_model: 'gemini-2.5-pro',
    default_permission_mode: 'auto_edit',
    ui_capabilities: { force_send: false, terminal_input: 'readline' },
    theme: {
      shortLabel: 'GEM',
      badge: 'bg-blue-500/12 text-blue-300 border-blue-500/20',
      selected: 'bg-blue-500/15 text-blue-400 border border-blue-500/25',
      subtle: 'text-blue-400 bg-blue-500/10',
      hover: 'hover:bg-blue-500/10',
    },
  },
  codex: {
    label: 'Codex',
    available_models: CODEX_MODELS,
    available_permission_modes: CODEX_PERMISSION_MODES,
    effort_levels: CODEX_EFFORT_LEVELS,
    default_model: 'gpt-5.4',
    default_permission_mode: 'auto',
    ui_capabilities: { force_send: false, terminal_input: 'readline' },
    theme: {
      shortLabel: 'COD',
      badge: 'bg-emerald-500/12 text-emerald-300 border-emerald-500/20',
      selected: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25',
      subtle: 'text-emerald-400 bg-emerald-500/10',
      hover: 'hover:bg-emerald-500/10',
    },
  },
}

function tryStoreProfiles() {
  try {
    const { default: useStore } = require('../state/store')
    return useStore.getState().cliProfiles
  } catch (e) { return null }
}

function cliProfile(cliType) {
  const store = tryStoreProfiles()
  return (store && store[cliType]) || CLI_FALLBACK[cliType] || CLI_FALLBACK.claude
}
```

(`MODELS`, `PERMISSION_MODES`, `EFFORT_LEVELS`, `GEMINI_MODELS`, `GEMINI_APPROVAL_MODES`, `CODEX_MODELS`, `CODEX_PERMISSION_MODES`, `CODEX_EFFORT_LEVELS` are all defined earlier in the file, so the references resolve.)

- [ ] **Step 2: Rewrite the getters to use `cliProfile()`**

Replace the bodies of these functions (keep names/signatures/exports identical):

```js
export function getModelsForCli(cliType) {
  return cliProfile(cliType).available_models
}

export function getPermissionModesForCli(cliType) {
  return cliProfile(cliType).available_permission_modes
}

export function getEffortLevelsForCli(cliType) {
  return cliProfile(cliType).effort_levels
}

export function getDefaultModel(cliType) {
  return cliProfile(cliType).default_model
}

export function getDefaultPermissionMode(cliType) {
  return cliProfile(cliType).default_permission_mode
}

export function getCliCapability(cliType, capability) {
  const caps = cliProfile(cliType).ui_capabilities || {}
  const v = caps[capability]
  return v === undefined ? false : v
}

export function getCliTheme(cliType) {
  return cliProfile(cliType).theme || CLI_FALLBACK.claude.theme
}
```

If `getCliShortLabel`/`getCliBadgeClass`/`getCliSelectedClass`/`getCliSubtleClass` exist, ensure they read `getCliTheme(cliType).shortLabel` / `.badge` / `.selected` / `.subtle` respectively (update bodies if they currently index `CLI_THEME`).

- [ ] **Step 3: Make `CLI_TYPES` + `CLI_THEME` derive from the registry**

Replace the static `export const CLI_TYPES = [...]` (~46-50) with:

```js
export const CLI_TYPES = Object.entries(CLI_FALLBACK).map(
  ([id, p]) => ({ id, label: p.label })
)
```

(Move this line to AFTER the `CLI_FALLBACK` definition.) Replace the static `export const CLI_THEME = {...}` (~84-106) with a derived alias so external importers keep working:

```js
export const CLI_THEME = Object.fromEntries(
  Object.entries(CLI_FALLBACK).map(([id, p]) => [id, p.theme])
)
```

Keep `MODELS`, `GEMINI_MODELS`, `CODEX_MODELS`, `PERMISSION_MODES`, `GEMINI_APPROVAL_MODES`, `CODEX_PERMISSION_MODES`, `EFFORT_LEVELS`, `CODEX_EFFORT_LEVELS` exactly as they are (now also consumed by `CLI_FALLBACK`; still exported for any external importers).

- [ ] **Step 4: Run the behavior guard (must be identical)**

Run: `node tests/test_frontend_cli_fallback.mjs`
Expected: `cli fallback snapshot: OK` — getter outputs byte-identical to the pre-refactor baseline.

If it fails, the diff shows exactly which getter/CLI changed; fix the `CLI_FALLBACK` entry until the snapshot matches. Do **not** rewrite the baseline.

- [ ] **Step 5: Frontend build**

Run: `cd frontend && npm run build 2>&1 | grep -E "✓ built|error" ; cd ..`
Expected: `✓ built` with no `error` lines.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/constants.js
git commit -m "refactor(fe): single-source CLI_FALLBACK registry behind cliProfile()"
```

---

## Task D1: Final integration verification

**Files:** none (verification only)

- [ ] **Step 1: Full backend suite on 3.11 venv**

Run: `~/.ive/venv/bin/python3 -m unittest tests.test_cli_profiles tests.test_codex_backend_surfaces tests.test_hook_installation_modes`
Expected: `OK` (all tests, including every new one)

- [ ] **Step 2: Backend import smoke (all touched modules)**

Run:
```bash
cd backend && ~/.ive/venv/bin/python3 -c "import importlib; [importlib.import_module(m) for m in ['server','cli_registry','cli_profiles','hook_installer','plugin_manager','hooks','pipeline_engine']]; print('import smoke OK')" && cd ..
```
Expected: `import smoke OK`

- [ ] **Step 3: Frontend behavior guard + build**

Run: `node tests/test_frontend_cli_fallback.mjs && cd frontend && npm run build 2>&1 | grep -E "✓ built|error"; cd ..`
Expected: `cli fallback snapshot: OK` then `✓ built`

- [ ] **Step 4: Extensibility smoke — prove a 4th CLI is bounded**

Run:
```bash
cd backend && ~/.ive/venv/bin/python3 -c "
from cli_profiles import PROFILES, get_profile
from cli_registry import cli_install_error
import hook_installer
# Every registered profile yields a working AVCP entry with no id-branching.
for cid in PROFILES:
    e = hook_installer._avcp_entry(get_profile(cid))
    assert e['hooks'][0]['command'].endswith(get_profile(cid).avcp_hook_script)
# Guard works for an uninstalled binary.
assert cli_install_error('codex', which=lambda b: None)
assert cli_install_error('codex', which=lambda b: '/x/'+b) is None
print('extensibility smoke OK')
" && cd ..
```
Expected: `extensibility smoke OK`

- [ ] **Step 5: Final commit**

```bash
git add -A docs/superpowers tests
git commit -m "chore(cli): extensibility hardening — verification artifacts"
```

---

## Self-Review

**Spec coverage:** (a) spawn guard → A1/A2. (b) single-source frontend, keep fallback → B1/B2 (`CLI_FALLBACK` + `cliProfile()`, getters unchanged signatures, fallback retained). (c) hook_installer profile fields → C1 (5 fields incl. spec→plan split of `avcp_tool_matcher`), C2 (home-env + tool events via existing `hook_event_map`), C3 (generic AVCP + `_gemini_available`). Out-of-scope items (account_sandbox, codex resume, start.sh) are untouched, as the spec requires. Verification → D1.

**Placeholder scan:** No TBD/TODO; every code step shows full code; every run step shows command + expected output.

**Type consistency:** `cli_install_error(cli_id, *, which)` signature consistent A1↔A2. `_avcp_entry(profile)` consistent C3 steps + D1. Field names (`home_env_var`, `avcp_hook_script`, `avcp_matcher`, `avcp_timeout`, `tool_event_matcher`) identical across C1/C2/C3/D1. `cliProfile()`/`CLI_FALLBACK` consistent B2 + harness. `native_hook(HookEvent.PRE_TOOL)` matches verified profile data (claude/codex=PreToolUse, gemini=BeforeTool).
