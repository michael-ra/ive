"""
Sandbox OAuth accounts by giving each a separate HOME directory.

Claude Code stores auth in ~/.claude/. By setting HOME per-PTY to a
sandboxed directory with a snapshotted .claude/, each session can use
a different OAuth subscription.

Symlinks for .zshrc, .gitconfig, .ssh etc. point back to the real HOME
so shell/git still work normally.
"""

import logging
import os
import shutil
from pathlib import Path

from config import ACCOUNT_HOMES_DIR
from cli_profiles import get_profile

logger = logging.getLogger(__name__)

# Files/dirs to symlink from real HOME into sandboxed HOME
SYMLINK_DOTFILES = [
    ".zshrc", ".bashrc", ".bash_profile", ".profile",
    ".gitconfig", ".ssh", ".npm", ".node", ".nvm",
    ".cargo", ".rustup", ".go",
    ".config",  # many tools use this
]


def snapshot_current_auth(account_id: str, cli_type: str = "claude") -> dict:
    """
    Snapshot the current CLI auth state for an account.
    Call this AFTER the user has done `claude auth login` (or gemini equivalent).
    Returns info about what was captured.
    """
    profile = get_profile(cli_type)
    auth_dir_name = profile.auth_dir_name  # ".claude" or ".gemini"
    src = Path(os.path.expanduser(profile.home_dir))
    if not src.exists():
        return {"error": f"~/{auth_dir_name}/ not found — login first"}

    dest = ACCOUNT_HOMES_DIR / account_id / auth_dir_name
    dest.parent.mkdir(parents=True, exist_ok=True)

    # Remove old snapshot
    if dest.exists():
        shutil.rmtree(dest)

    # Copy the entire .claude directory
    shutil.copytree(src, dest, symlinks=True, ignore=shutil.ignore_patterns("*.log"))

    files_copied = sum(1 for _ in dest.rglob("*") if _.is_file())
    size = sum(f.stat().st_size for f in dest.rglob("*") if f.is_file())

    logger.info(f"Snapshotted auth for account {account_id}: {files_copied} files, {size} bytes")

    return {
        "ok": True,
        "account_id": account_id,
        "files": files_copied,
        "size_bytes": size,
        "path": str(dest),
    }


def get_sandbox_home(account_id: str, cli_type: str = "claude") -> str | None:
    """
    Get the sandboxed HOME path for an account.
    Returns None if no snapshot exists (use system HOME instead).
    """
    profile = get_profile(cli_type)
    auth_dir_name = profile.auth_dir_name  # ".claude" or ".gemini"
    account_home = ACCOUNT_HOMES_DIR / account_id
    cli_dir = account_home / auth_dir_name

    if not cli_dir.exists():
        return None

    # Ensure dotfile symlinks exist
    real_home = Path.home()
    for dotfile in SYMLINK_DOTFILES:
        src = real_home / dotfile
        dst = account_home / dotfile
        if src.exists() and not dst.exists():
            try:
                dst.symlink_to(src)
            except OSError:
                pass  # Already exists or permission issue

    return str(account_home)


def has_snapshot(account_id: str, cli_type: str = "claude") -> bool:
    """Check if an account has a saved auth snapshot."""
    profile = get_profile(cli_type)
    return (ACCOUNT_HOMES_DIR / account_id / profile.auth_dir_name).exists()


def delete_snapshot(account_id: str):
    """Delete an account's auth snapshot."""
    account_home = ACCOUNT_HOMES_DIR / account_id
    if account_home.exists():
        shutil.rmtree(account_home)
