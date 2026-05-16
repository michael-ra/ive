# Finding: Codex writes exec-wrapper scratch to the real `~/.codex`, ignoring `$HOME`/`$CODEX_HOME`

**Date:** 2026-05-15
**Severity:** Low (ephemeral, non-sensitive, no cross-session collision) — but
a **real isolation gap**, not a test-only artifact.
**Status:** Documented. No blocking code change; mitigation + doc-correction
recommended.

> **Correction note:** an earlier draft of this finding claimed IVE was
> safe because account-sandboxing sets `HOME` and `CODEX_HOME` together
> (`CODEX_HOME == $HOME/.codex` invariant). A follow-up experiment
> **falsified that**: with *both* `HOME` and `CODEX_HOME` overridden to a
> temp sandbox, Codex *still* wrote into the real `~/.codex/tmp`. This
> document reflects the corrected, evidence-based understanding.

## What actually happens

Every Codex run drops an exec-sandbox wrapper directory:

```
<OS-account-home>/.codex/tmp/arg0/codex-arg0<rand>/
  ├── .lock
  ├── apply_patch
  ├── applypatch
  └── codex-execve-wrapper
```

The path is resolved from the **OS account home** (Rust
`dirs::home_dir()` / `getpwuid(getuid())->pw_dir`), **not** the `$HOME` or
`$CODEX_HOME` environment variables.

Verified empirically (Codex CLI 0.130.0, macOS):

- `pty_manager.PTYSession.start` builds the child env as
  `os.environ.copy()` → `env.update(extra_env)` → `os.execvpe(...)`, so a
  child spawned with `extra_env={"HOME": sandbox, "CODEX_HOME":
  sandbox/.codex}` genuinely has both overridden.
- Despite that, the wrapper dir appeared in the **real**
  `~/.codex/tmp/arg0/...` (mtimes matching the run), not under the temp
  sandbox. Reproduced across multiple runs.
- `~/.codex/tmp/` was empty (`total 0`, created 2026-05-09) before the
  runs; manually restored to empty after each.

Conclusion: **no environment-variable-based sandboxing (the mechanism
IVE's `account_sandbox.py` relies on) can redirect this path.**

## Impact assessment — why Low severity

- The per-run directory is **randomly named** (`codex-arg0<rand>`), so
  concurrent sandboxed Codex sessions get *distinct* dirs — no file
  collision or contention between sessions/accounts.
- Contents are **ephemeral exec-helper shims** (a lock + patch wrappers +
  an execve shim) — **no auth, tokens, or conversation state**. This is
  not credential/data cross-contamination.
- Not a correctness problem for IVE sessions.

So the practical impact is limited to: (1) **cruft accumulation** in the
real `~/.codex/tmp/arg0/` (Codex cleans some but not all on exit), and
(2) the fact that **IVE account-sandboxing does not fully HOME-isolate
Codex** — a claim the sandbox docs should not make for the `codex`
profile.

## Recommendations

1. **Correct the account-sandbox expectation:** `account_sandbox.py` /
   `_env_for_cli_home` docs/comments must not imply Codex is fully
   HOME-isolated. Codex's exec-wrapper scratch always lands in the real
   OS-home `~/.codex/tmp` regardless of env.
2. **Mitigation (cleanup, not redirection):** since the path cannot be
   redirected by env, the only lever is cleanup. Options:
   - Periodically prune stale `~/.codex/tmp/arg0/*` from IVE (low risk —
     random per-run dirs, ephemeral), or
   - Accept it as Codex-managed ephemeral scratch and document it.
   - Investigate whether a Codex config key (e.g. a TMPDIR/exec-wrapper
     setting) can relocate it — none found in `codex --help`; would need
     Codex-side support.
3. **Test guidance:** harnesses spawning Codex **cannot** isolate this via
   env. They must expect `~/.codex/tmp/arg0/*` to be (re)created and clean
   it explicitly; treat "`~/.codex/tmp/` returns to empty" as the
   post-test integrity check. (Used throughout this investigation.)

## Relation to the system-prompt fix

Independent. The Codex system-prompt fix uses `-c developer_instructions=`
(pure argv, **zero filesystem footprint**) and neither causes nor depends
on this behavior.
