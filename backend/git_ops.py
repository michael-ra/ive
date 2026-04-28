"""Async git subprocess helpers for workspace code review."""

import asyncio
import logging

logger = logging.getLogger(__name__)

TIMEOUT = 10  # seconds
MAX_DIFF_BYTES = 200_000  # 200KB truncation limit


async def _run(args: list[str], cwd: str, timeout: int = TIMEOUT) -> tuple[str, str, int]:
    """Run a git command and return (stdout, stderr, returncode)."""
    proc = await asyncio.create_subprocess_exec(
        *args,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        raise TimeoutError(f"git command timed out after {timeout}s: {' '.join(args)}")
    return stdout.decode(errors="replace"), stderr.decode(errors="replace"), proc.returncode


async def git_status(workspace_path: str) -> dict:
    """Get structured git status for a workspace directory."""
    # Check if this is a git repo
    _, _, rc = await _run(["git", "rev-parse", "--is-inside-work-tree"], workspace_path)
    if rc != 0:
        return {"is_git_repo": False, "staged": [], "unstaged": [], "untracked": []}

    stdout, _, _ = await _run(["git", "status", "--porcelain=v1"], workspace_path)

    staged = []
    unstaged = []
    untracked = []

    for line in stdout.splitlines():
        if len(line) < 4:
            continue
        index_status = line[0]
        worktree_status = line[1]
        path = line[3:]

        # Handle renames: "R  old -> new"
        if " -> " in path:
            path = path.split(" -> ", 1)[1]

        if index_status == "?":
            untracked.append({"path": path, "status": "?"})
        else:
            if index_status not in (" ", "?"):
                staged.append({"path": path, "status": index_status})
            if worktree_status not in (" ", "?"):
                unstaged.append({"path": path, "status": worktree_status})

    return {
        "is_git_repo": True,
        "staged": staged,
        "unstaged": unstaged,
        "untracked": untracked,
    }


async def git_diff(
    workspace_path: str,
    staged: bool = False,
    commit_range: str | None = None,
    file_path: str | None = None,
) -> dict:
    """Get unified diff output. Returns {diff, truncated}."""
    args = ["git", "diff"]
    if staged:
        args.append("--staged")
    elif commit_range:
        args.append(commit_range)
    if file_path:
        args.extend(["--", file_path])

    stdout, _, _ = await _run(args, workspace_path)

    truncated = False
    if len(stdout) > MAX_DIFF_BYTES:
        stdout = stdout[:MAX_DIFF_BYTES]
        truncated = True

    return {"diff": stdout, "truncated": truncated}


async def git_log(workspace_path: str, count: int = 20) -> list[dict]:
    """Get recent commit log entries."""
    fmt = "%H|%h|%s|%an|%ai"
    stdout, _, rc = await _run(
        ["git", "log", f"-{count}", f"--format={fmt}"],
        workspace_path,
    )
    if rc != 0:
        return []

    commits = []
    for line in stdout.strip().splitlines():
        parts = line.split("|", 4)
        if len(parts) >= 5:
            commits.append({
                "hash": parts[0],
                "short_hash": parts[1],
                "message": parts[2],
                "author": parts[3],
                "date": parts[4],
            })
    return commits


async def git_log_window(
    workspace_path: str,
    since_iso: str | None = None,
    until_iso: str | None = None,
    limit: int = 50,
    include_stat: bool = True,
) -> list[dict]:
    """Get commits in a time window. Optionally include shortstat
    (insertions/deletions/files). Returns [] if path is not a git repo
    or git fails (e.g. timeout)."""
    fmt = "%H|%h|%s|%an|%ai"
    args = ["git", "log", f"-{limit}", f"--format={fmt}"]
    if include_stat:
        args.append("--shortstat")
    if since_iso:
        args.append(f"--since={since_iso}")
    if until_iso:
        args.append(f"--until={until_iso}")

    try:
        stdout, _, rc = await _run(args, workspace_path)
    except (TimeoutError, FileNotFoundError, OSError):
        return []
    if rc != 0:
        return []

    commits: list[dict] = []
    current: dict | None = None
    for raw in stdout.splitlines():
        line = raw.strip()
        if not line:
            continue
        if "|" in line and line.count("|") >= 4 and not line.startswith(" "):
            # New commit header line.
            parts = line.split("|", 4)
            if len(parts) >= 5:
                current = {
                    "hash": parts[0],
                    "short_hash": parts[1],
                    "message": parts[2],
                    "author": parts[3],
                    "date": parts[4],
                    "files_changed": 0,
                    "insertions": 0,
                    "deletions": 0,
                }
                commits.append(current)
        elif current is not None and ("file changed" in line or "files changed" in line):
            # Shortstat line: " 3 files changed, 42 insertions(+), 5 deletions(-)"
            for chunk in line.split(","):
                chunk = chunk.strip()
                tokens = chunk.split()
                if not tokens:
                    continue
                try:
                    n = int(tokens[0])
                except ValueError:
                    continue
                if "file" in chunk:
                    current["files_changed"] = n
                elif "insertion" in chunk:
                    current["insertions"] = n
                elif "deletion" in chunk:
                    current["deletions"] = n
    return commits
