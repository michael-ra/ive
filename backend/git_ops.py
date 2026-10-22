"""Async git subprocess helpers for workspace code review."""

import asyncio
import logging
import re

logger = logging.getLogger(__name__)

TIMEOUT = 10  # seconds
MAX_DIFF_BYTES = 200_000  # 200KB truncation limit

# One revision: refs, SHAs and suffix syntax (HEAD~2, main^, @{u}, v1.0^{},
# HEAD^!).
# Deliberately no whitespace, no option-like leading "-" and no ":" (blob
# paths); a revision range joins two of these with ".." or "...".
_REVISION_RE = re.compile(r"[A-Za-z0-9_@][A-Za-z0-9._/@{}~^!+-]*")
MAX_REVISION_LEN = 256


class InvalidRevisionError(ValueError):
    """A user-supplied revision or range that must not reach git."""


def is_safe_revision(value: str) -> bool:
    """True when ``value`` is a plain revision git cannot read as an option."""
    return (
        isinstance(value, str)
        and 0 < len(value) <= MAX_REVISION_LEN
        and _REVISION_RE.fullmatch(value) is not None
        and ".." not in value
    )


def validate_revision_range(value: str) -> str:
    """Return ``value`` if it is ``rev``, ``rev..rev`` or ``rev...rev``.

    Either side of a range may be empty (``main..`` means ``main..HEAD``),
    but never both. Anything else raises InvalidRevisionError, so request
    input like ``--output=/path`` can never be passed to ``git diff``.
    """
    if not isinstance(value, str) or not value or len(value) > MAX_REVISION_LEN:
        raise InvalidRevisionError("invalid revision range")
    sep = "..." if "..." in value else ".." if ".." in value else None
    parts = value.split(sep) if sep else [value]
    if len(parts) > 2 or not any(parts):
        raise InvalidRevisionError("invalid revision range")
    for part in parts:
        if part and not is_safe_revision(part):
            raise InvalidRevisionError("invalid revision range")
    return value


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


_END_OF_OPTIONS_SUPPORTED: bool | None = None


async def _supports_end_of_options(cwd: str) -> bool:
    """``--end-of-options`` exists since git 2.24; probe the version once."""
    global _END_OF_OPTIONS_SUPPORTED
    if _END_OF_OPTIONS_SUPPORTED is None:
        try:
            out, _, rc = await _run(["git", "--version"], cwd)
            match = re.search(r"(\d+)\.(\d+)", out)
            _END_OF_OPTIONS_SUPPORTED = bool(
                rc == 0 and match and (int(match.group(1)), int(match.group(2))) >= (2, 24)
            )
        except (OSError, TimeoutError):
            return False
    return _END_OF_OPTIONS_SUPPORTED


async def git_status(workspace_path: str) -> dict:
    """Get structured git status for a workspace directory."""
    # Check if this is a git repo
    _, _, rc = await _run(["git", "rev-parse", "--is-inside-work-tree"], workspace_path)
    if rc != 0:
        return {"is_git_repo": False, "staged": [], "unstaged": [], "untracked": []}

    # NUL records preserve spaces, Unicode, quotes and newlines verbatim.
    # Text porcelain quotes these paths and is not safe to pass back to Git.
    stdout, _, _ = await _run(["git", "status", "--porcelain=v1", "-z"], workspace_path)

    staged = []
    unstaged = []
    untracked = []

    records = iter(stdout.split("\0"))
    for line in records:
        if len(line) < 4:
            continue
        index_status = line[0]
        worktree_status = line[1]
        path = line[3:]

        # In -z output the destination comes first, followed by a separate
        # source-path record. A literal " -> " in a filename is not a rename.
        if index_status in "RC" or worktree_status in "RC":
            next(records, None)

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
    if file_path and not staged and not commit_range:
        # `git diff -- <untracked>` is empty. For a selected untracked file,
        # synthesize the expected "new file" diff so the review pane can focus
        # actual content instead of a blank view.
        ls_out, _, _ = await _run(
            ["git", "--literal-pathspecs", "ls-files", "-z", "--others", "--exclude-standard", "--", file_path],
            workspace_path,
        )
        if file_path in ls_out.split("\0"):
            stdout, _, _ = await _run(
                ["git", "diff", "--no-index", "--", "/dev/null", file_path],
                workspace_path,
            )
            truncated = False
            if len(stdout) > MAX_DIFF_BYTES:
                stdout = stdout[:MAX_DIFF_BYTES]
                truncated = True
            return {"diff": stdout, "truncated": truncated}

    if commit_range and not staged:
        validate_revision_range(commit_range)

    args = ["git", "--literal-pathspecs", "diff"]
    if staged:
        args.append("--staged")
    elif commit_range:
        # Validation above already rejects option-shaped input; the
        # terminator (git >= 2.24) is defense in depth.
        if await _supports_end_of_options(workspace_path):
            args.append("--end-of-options")
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
    fmt = "%H%x00%h%x00%s%x00%an%x00%ai"
    stdout, _, rc = await _run(
        ["git", "log", f"-{count}", f"--format={fmt}"],
        workspace_path,
    )
    if rc != 0:
        return []

    commits = []
    for line in stdout.strip().splitlines():
        parts = line.split("\0", 4)
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
    include_files: bool = False,
) -> list[dict]:
    """Get commits in a time window. Optionally include shortstat
    (insertions/deletions/files) and/or files (list of file paths with changes).
    Returns [] if path is not a git repo or git fails (e.g. timeout)."""
    fmt = "%H%x00%h%x00%s%x00%an%x00%ai"
    args = ["git", "log", f"-{limit}", f"--format={fmt}"]
    if include_files:
        args.append("--numstat")
    elif include_stat:
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
        if line.count("\0") == 4:
            # New commit header line.
            parts = line.split("\0", 4)
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
                if include_files:
                    current["files"] = []
                commits.append(current)
        elif current is not None:
            if include_files:
                # Numstat line: "1\t1\tfrontend/src/App.jsx"
                tokens = line.split(None, 2)
                if len(tokens) >= 3:
                    try:
                        ins = int(tokens[0]) if tokens[0] != "-" else 0
                        dels = int(tokens[1]) if tokens[1] != "-" else 0
                    except ValueError:
                        ins, dels = 0, 0
                    current["files"].append({
                        "path": tokens[2],
                        "insertions": ins,
                        "deletions": dels,
                    })
                    current["files_changed"] += 1
                    current["insertions"] += ins
                    current["deletions"] += dels
            elif "file changed" in line or "files changed" in line:
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


async def git_stage(workspace_path: str, file_path: str) -> None:
    """Stage a file (git add)."""
    _, stderr, rc = await _run(["git", "--literal-pathspecs", "add", "--", file_path], workspace_path)
    if rc != 0:
        raise Exception(f"Failed to stage file: {stderr}")


async def git_unstage(workspace_path: str, file_path: str) -> None:
    """Unstage a file (git reset HEAD -- file)."""
    _, stderr, rc = await _run(["git", "--literal-pathspecs", "reset", "HEAD", "--", file_path], workspace_path)
    if rc != 0:
        raise Exception(f"Failed to unstage file: {stderr}")

