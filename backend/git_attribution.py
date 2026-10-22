"""Private Git commit attribution for IVE-managed sessions.

Git history should keep normal user/repository identity. IVE attribution is
captured out-of-band by a process-local git wrapper and stored in SQLite.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import shutil
import stat
import textwrap
from pathlib import Path

import aiosqlite

from config import DATA_DIR


KEY_VERSION = "v1"
SESSION_KEY_HEX_CHARS = 32
GIT_WRAPPER_DIR = DATA_DIR / "git-wrapper"
GIT_WRAPPER_PATH = GIT_WRAPPER_DIR / "git"

_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


class AttributionError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def derive_session_key(secret_hex: str, session_id: str) -> str:
    try:
        secret = bytes.fromhex(secret_hex)
    except ValueError:
        secret = secret_hex.encode("utf-8")
    digest = hmac.new(secret, session_id.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{KEY_VERSION}:{digest[:SESSION_KEY_HEX_CHARS]}"


async def _workspace_secret(db: aiosqlite.Connection, workspace_id: str) -> str:
    cur = await db.execute(
        "SELECT secret FROM workspace_git_secrets WHERE workspace_id = ?",
        (workspace_id,),
    )
    row = await cur.fetchone()
    if row and row["secret"]:
        return row["secret"]

    secret = secrets.token_hex(32)
    await db.execute(
        """INSERT OR IGNORE INTO workspace_git_secrets
           (workspace_id, secret) VALUES (?, ?)""",
        (workspace_id, secret),
    )
    cur = await db.execute(
        "SELECT secret FROM workspace_git_secrets WHERE workspace_id = ?",
        (workspace_id,),
    )
    row = await cur.fetchone()
    if not row or not row["secret"]:
        raise AttributionError("workspace Git secret could not be created", 500)
    return row["secret"]


async def ensure_session_git_identity(
    db: aiosqlite.Connection,
    workspace_id: str,
    session_id: str,
) -> str:
    cur = await db.execute(
        "SELECT id FROM sessions WHERE id = ? AND workspace_id = ?",
        (session_id, workspace_id),
    )
    if not await cur.fetchone():
        raise AttributionError("session does not belong to workspace", 404)

    secret = await _workspace_secret(db, workspace_id)
    session_key = derive_session_key(secret, session_id)
    await db.execute(
        """INSERT OR IGNORE INTO session_git_identities
           (workspace_id, session_id, session_key, key_version)
           VALUES (?, ?, ?, ?)""",
        (workspace_id, session_id, session_key, KEY_VERSION),
    )
    await db.commit()
    return session_key


def _wrapper_script() -> str:
    return textwrap.dedent(
        '''\
        #!/usr/bin/env python3
        import json
        import os
        import shutil
        import subprocess
        import sys
        import urllib.request
        from pathlib import Path

        TRACKED_COMMANDS = {"commit", "cherry-pick", "revert", "am"}
        GLOBAL_OPTS_WITH_VALUE = {
            "-C", "-c", "--git-dir", "--work-tree", "--namespace",
            "--exec-path", "--super-prefix",
        }
        GLOBAL_OPT_PREFIXES = (
            "--git-dir=", "--work-tree=", "--namespace=", "--exec-path=",
            "--super-prefix=",
        )

        def find_real_git():
            script = Path(__file__).resolve()
            configured = os.environ.get("IVE_REAL_GIT")
            if configured:
                try:
                    candidate = Path(configured).resolve()
                    if candidate != script and candidate.exists():
                        return str(candidate)
                except OSError:
                    return configured

            script_dir = str(script.parent)
            for entry in os.environ.get("PATH", "").split(os.pathsep):
                if not entry or os.path.abspath(entry) == script_dir:
                    continue
                candidate = shutil.which("git", path=entry)
                if not candidate:
                    continue
                try:
                    resolved = Path(candidate).resolve()
                    if resolved != script:
                        return str(resolved)
                except OSError:
                    return candidate
            return None

        def split_global_args(argv):
            prefix = []
            i = 0
            while i < len(argv):
                arg = argv[i]
                if arg == "--":
                    return prefix, None
                if not arg.startswith("-"):
                    return prefix, arg
                if arg in GLOBAL_OPTS_WITH_VALUE:
                    if i + 1 >= len(argv):
                        return prefix + [arg], None
                    prefix.extend([arg, argv[i + 1]])
                    i += 2
                    continue
                if any(arg.startswith(p) for p in GLOBAL_OPT_PREFIXES):
                    prefix.append(arg)
                    i += 1
                    continue
                # Git also accepts -cname=value. Keep it with the global prefix.
                if arg.startswith("-c") and arg != "-c":
                    prefix.append(arg)
                    i += 1
                    continue
                prefix.append(arg)
                i += 1
            return prefix, None

        def git_out(real_git, prefix, args):
            try:
                proc = subprocess.run(
                    [real_git, *prefix, *args],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    text=True,
                    check=False,
                )
            except OSError:
                return ""
            if proc.returncode != 0:
                return ""
            return proc.stdout.strip()

        def post_attribution(commit_shas, old_head, new_head, repo_path, command_kind):
            api_url = (os.environ.get("COMMANDER_API_URL") or "").rstrip("/")
            session_id = os.environ.get("COMMANDER_SESSION_ID") or os.environ.get("WORKER_SESSION_ID")
            workspace_id = os.environ.get("COMMANDER_WORKSPACE_ID") or os.environ.get("WORKER_WORKSPACE_ID")
            session_key = os.environ.get("IVE_SESSION_KEY")
            if not api_url or not session_id or not workspace_id or not session_key or not commit_shas:
                return

            payload = {
                "workspace_id": workspace_id,
                "session_id": session_id,
                "session_key": session_key,
                "repo_path": repo_path,
                "cwd": os.getcwd(),
                "command_kind": command_kind,
                "old_head": old_head,
                "new_head": new_head,
                "commit_shas": commit_shas,
            }
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                f"{api_url}/api/hooks/git-attribution",
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=2):
                    pass
            except Exception:
                # Attribution must never break the user's git command.
                pass

        def main():
            real_git = find_real_git()
            if not real_git:
                print("IVE git wrapper: real git binary not found", file=sys.stderr)
                return 127

            argv = sys.argv[1:]
            prefix, subcommand = split_global_args(argv)
            should_track = subcommand in TRACKED_COMMANDS
            old_head = ""
            repo_path = ""
            if should_track:
                old_head = git_out(real_git, prefix, ["rev-parse", "--verify", "HEAD"])
                repo_path = git_out(real_git, prefix, ["rev-parse", "--show-toplevel"])

            try:
                proc = subprocess.run([real_git, *argv])
            except OSError as exc:
                print(f"IVE git wrapper: failed to exec git: {exc}", file=sys.stderr)
                return 127

            if should_track and proc.returncode == 0:
                new_head = git_out(real_git, prefix, ["rev-parse", "--verify", "HEAD"])
                if new_head and new_head != old_head:
                    if old_head:
                        revs = git_out(real_git, prefix, ["rev-list", "--reverse", f"{old_head}..{new_head}"])
                    else:
                        revs = git_out(real_git, prefix, ["rev-list", "--reverse", "--max-count=50", new_head])
                    shas = [line.strip() for line in revs.splitlines() if len(line.strip()) == 40]
                    if new_head not in shas and len(new_head) == 40:
                        shas.append(new_head)
                    post_attribution(shas[:50], old_head, new_head, repo_path, subcommand)

            return proc.returncode

        if __name__ == "__main__":
            raise SystemExit(main())
        '''
    )


def ensure_git_wrapper() -> Path:
    GIT_WRAPPER_DIR.mkdir(parents=True, exist_ok=True)
    script = _wrapper_script()
    from resource_path import is_frozen
    if is_frozen():
        import shlex
        from helper_command import python_command
        source = GIT_WRAPPER_DIR / "git_attribution.py"
        if not source.exists() or source.read_text() != script:
            source.write_text(script)
        script = "#!/bin/sh\nexec " + shlex.join(python_command(str(source))) + ' "$@"\n'
    if not GIT_WRAPPER_PATH.exists() or GIT_WRAPPER_PATH.read_text() != script:
        GIT_WRAPPER_PATH.write_text(script)
    mode = GIT_WRAPPER_PATH.stat().st_mode
    GIT_WRAPPER_PATH.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return GIT_WRAPPER_DIR


def _find_real_git(wrapper_dir: Path) -> str | None:
    wrapper_dir_abs = os.path.abspath(str(wrapper_dir))
    wrapper_path_abs = os.path.realpath(str(GIT_WRAPPER_PATH))
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        if not entry or os.path.abspath(entry) == wrapper_dir_abs:
            continue
        candidate = shutil.which("git", path=entry)
        if not candidate:
            continue
        if os.path.realpath(candidate) == wrapper_path_abs:
            continue
        return candidate
    return None


async def inject_git_attribution_env(
    config: dict,
    session_id: str,
    extra_env: dict[str, str],
) -> None:
    workspace_id = config.get("workspace_id") or extra_env.get("COMMANDER_WORKSPACE_ID")
    if not workspace_id:
        return

    from db import get_db

    db = await get_db()
    try:
        session_key = await ensure_session_git_identity(db, workspace_id, session_id)
    finally:
        await db.close()

    wrapper_dir = ensure_git_wrapper()
    real_git = _find_real_git(wrapper_dir)
    if not real_git:
        return

    current_path = extra_env.get("PATH") or os.environ.get("PATH", "")
    path_parts = [p for p in current_path.split(os.pathsep) if p]
    wrapper_str = str(wrapper_dir)
    if not path_parts or path_parts[0] != wrapper_str:
        path_parts = [p for p in path_parts if os.path.abspath(p) != os.path.abspath(wrapper_str)]
        extra_env["PATH"] = os.pathsep.join([wrapper_str, *path_parts])

    extra_env["IVE_REAL_GIT"] = real_git
    extra_env["IVE_SESSION_KEY"] = session_key
    extra_env["IVE_GIT_ATTRIBUTION"] = "1"


def _clean_sha(value: object) -> str | None:
    text = str(value or "").strip().lower()
    return text if _SHA_RE.match(text) else None


def _safe_abs(path: str | None, fallback: str) -> str:
    raw = path or fallback
    try:
        return os.path.realpath(os.path.abspath(os.path.expanduser(raw)))
    except (TypeError, ValueError):
        return os.path.realpath(os.path.abspath(fallback))


async def record_commit_attributions(
    db: aiosqlite.Connection,
    payload: dict,
) -> dict:
    workspace_id = str(payload.get("workspace_id") or "").strip()
    session_id = str(payload.get("session_id") or "").strip()
    session_key = str(payload.get("session_key") or "").strip()
    if not workspace_id or not session_id or not session_key:
        raise AttributionError("workspace_id, session_id, and session_key are required")

    raw_shas = payload.get("commit_shas")
    if not isinstance(raw_shas, list):
        raw_shas = [payload.get("commit_sha")]
    commit_shas = []
    seen = set()
    for raw in raw_shas:
        sha = _clean_sha(raw)
        if sha and sha not in seen:
            seen.add(sha)
            commit_shas.append(sha)
    if not commit_shas:
        raise AttributionError("no valid commit SHAs provided")
    if len(commit_shas) > 50:
        raise AttributionError("too many commit SHAs in one attribution payload")

    cur = await db.execute(
        """SELECT s.id, s.workspace_id, s.name, s.task_id, s.active_ticket_id,
                  s.cli_type, s.model, s.session_type, w.path AS workspace_path
           FROM sessions s
           JOIN workspaces w ON w.id = s.workspace_id
           WHERE s.id = ?""",
        (session_id,),
    )
    row = await cur.fetchone()
    if not row:
        raise AttributionError("session not found", 404)
    if row["workspace_id"] != workspace_id:
        raise AttributionError("session/workspace mismatch", 403)

    expected_key = await ensure_session_git_identity(db, workspace_id, session_id)
    if not hmac.compare_digest(expected_key, session_key):
        raise AttributionError("invalid session key", 403)

    workspace_path = _safe_abs(row["workspace_path"], os.getcwd())
    repo_path = _safe_abs(payload.get("repo_path"), workspace_path)
    try:
        if os.path.commonpath([workspace_path, repo_path]) != workspace_path:
            raise AttributionError("repo path is outside the workspace", 403)
    except ValueError:
        raise AttributionError("repo path is outside the workspace", 403)

    active_ticket_id = row["active_ticket_id"]
    task_id = row["task_id"]
    source = str(payload.get("source") or "git_wrapper")[:80]
    command_kind = str(payload.get("command_kind") or "")[:80]
    old_head = _clean_sha(payload.get("old_head"))
    new_head = _clean_sha(payload.get("new_head"))

    inserted = 0
    for sha in commit_shas:
        cur = await db.execute(
            """INSERT OR IGNORE INTO commit_attributions
               (workspace_id, repo_path, commit_sha, session_id, session_key,
                task_id_snapshot, active_ticket_id_snapshot, session_name_snapshot,
                session_cli_type_snapshot, session_model_snapshot,
                session_type_snapshot, command_kind, old_head, new_head, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                workspace_id,
                repo_path,
                sha,
                session_id,
                session_key,
                task_id,
                active_ticket_id,
                row["name"],
                row["cli_type"],
                row["model"],
                row["session_type"],
                command_kind,
                old_head,
                new_head,
                source,
            ),
        )
        inserted += max(cur.rowcount or 0, 0)

    await db.commit()
    return {
        "ok": True,
        "inserted": inserted,
        "commit_shas": commit_shas,
        "session_key": session_key,
    }
