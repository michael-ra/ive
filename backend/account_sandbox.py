"""Account-scoped CLI homes and evidence-based credential verification."""

import base64
import json
import logging
import os
import shutil
from pathlib import Path

from config import ACCOUNT_HOMES_DIR
from cli_profiles import get_profile

logger = logging.getLogger(__name__)

# Files/dirs to symlink from real HOME into sandboxed HOME so shell/git/tooling
# still work. SECURITY (2.8): private-key / credential dirs are NOT in this list
# — a sandboxed agent HOME must never expose host secrets by default.
SYMLINK_DOTFILES = [
    ".zshrc", ".bashrc", ".bash_profile", ".profile",
    ".gitconfig", ".npm", ".node", ".nvm",
    ".cargo", ".rustup", ".go",
    ".config",  # many tools use this
]

# Sensitive dirs (host SSH private keys) are symlinked ONLY when an operator
# explicitly opts in via SANDBOX_SYMLINK_SSH=1 — e.g. when agents must push over
# git+SSH. Default OFF closes the leak where any sandboxed agent could read
# ~/.ssh/id_* off the host (account_sandbox previously symlinked .ssh always).
SENSITIVE_SYMLINK_DOTFILES = [".ssh"]


def _dotfiles_to_symlink() -> list[str]:
    """The dotfiles to symlink into a sandboxed HOME, honoring the opt-in for
    sensitive (SSH key) dirs. Kept as a function so the env flag is read live."""
    dotfiles = list(SYMLINK_DOTFILES)
    if os.environ.get("SANDBOX_SYMLINK_SSH") == "1":
        dotfiles += SENSITIVE_SYMLINK_DOTFILES
    return dotfiles

def get_sandbox_home(account_id: str, cli_type: str = "claude") -> str | None:
    """
    Get an existing sandboxed HOME and install safe tooling symlinks.

    This helper never falls back to the system HOME.
    """
    profile = get_profile(cli_type)
    if not profile.auth_dir_name or not profile.account_isolation:
        return None
    auth_dir_name = profile.auth_dir_name  # ".claude" or ".gemini"
    account_home = ACCOUNT_HOMES_DIR / account_id
    cli_dir = account_home / auth_dir_name

    if not cli_dir.exists():
        return None

    # Ensure dotfile symlinks exist (sensitive .ssh only when opted-in — 2.8)
    real_home = Path.home()
    for dotfile in _dotfiles_to_symlink():
        src = real_home / dotfile
        dst = account_home / dotfile
        if not src.exists() or dst.exists():
            continue
        # Validate source is not a symlink chain escaping HOME
        try:
            resolved = src.resolve()
            if not (resolved.is_relative_to(real_home) or resolved == src):
                logger.warning("Skipping suspicious symlink %s -> %s", src, resolved)
                continue
            dst.symlink_to(src)
        except OSError as e:
            logger.debug("Symlink %s -> %s failed: %s", dst, src, e)

    return str(account_home)


def profile_config_dir(account_id: str, cli_type: str) -> Path | None:
    """Return the profile-declared config/credential root for one account."""
    profile = get_profile(cli_type)
    if not profile.config_dir_env or not profile.config_dir_subpath:
        return None
    return ACCOUNT_HOMES_DIR / account_id / profile.config_dir_subpath


def has_isolated_claude_credentials(account_id: str) -> bool:
    """True iff the account has its own ``.credentials.json`` on disk.

    When this is False, ``claude auth login`` either wrote the OAuth token
    to the shared macOS keychain (which all accounts read from, so they
    overwrite each other) or didn't complete. The setup flow surfaces this
    so users can retry and click "Don't Allow" on the keychain dialog,
    forcing the file fallback that makes per-account isolation work.
    """
    config_dir = profile_config_dir(account_id, "claude")
    credential_file = config_dir / ".credentials.json" if config_dir else None
    return bool(
        credential_file
        and credential_file.is_file()
        and credential_file.stat().st_size > 0
    )


def _credential_scope(account_id: str, cli_type: str) -> tuple[Path, str]:
    profile = get_profile(cli_type)
    account_home = ACCOUNT_HOMES_DIR / account_id
    config_dir = profile_config_dir(account_id, cli_type)
    if config_dir is not None:
        return config_dir, "config_dir"
    if profile.account_isolation == "home_only":
        return account_home, "home_only"
    return account_home, "unsupported"


def capture_credential_state(account_id: str, cli_type: str) -> dict[str, tuple[int, int]]:
    """Fingerprint only profile-declared credential files, never arbitrary writes."""
    profile = get_profile(cli_type)
    account_home = ACCOUNT_HOMES_DIR / account_id
    if not account_home.exists() or not profile.credential_files:
        return {}
    state: dict[str, tuple[int, int]] = {}
    home_resolved = account_home.resolve(strict=False)
    for relative in profile.credential_files:
        path = account_home / relative
        try:
            resolved = path.resolve(strict=False)
            resolved.relative_to(home_resolved)
            if path.is_symlink() or not path.is_file():
                continue
            stat_result = path.stat()
            if stat_result.st_size <= 0:
                continue
            state[Path(relative).as_posix()] = (
                stat_result.st_size,
                stat_result.st_mtime_ns,
            )
        except (OSError, ValueError):
            continue
    return state


def _recursive_key_values(value, key: str, depth: int = 0):
    if depth > 8:
        return
    if isinstance(value, dict):
        if key in value:
            yield value[key]
        for nested in value.values():
            yield from _recursive_key_values(nested, key, depth + 1)
    elif isinstance(value, list):
        for nested in value:
            yield from _recursive_key_values(nested, key, depth + 1)


def _exact_path_value(value, path: str):
    current = value
    for segment in path.split("."):
        if isinstance(current, dict) and segment in current:
            current = current[segment]
        elif isinstance(current, list) and segment.isdigit() and int(segment) < len(current):
            current = current[int(segment)]
        else:
            return None
    return current


def _identity_from_value(value, identity_paths: list[str], depth: int = 0) -> str | None:
    if depth > 2:
        return None
    for selector in identity_paths:
        values = (
            _recursive_key_values(value, selector[3:])
            if selector.startswith("**.")
            else (_exact_path_value(value, selector),)
        )
        for candidate in values:
            if not isinstance(candidate, str) or not candidate.strip():
                continue
            terminal = selector.rsplit(".", 1)[-1]
            if terminal in {"id_token", "idToken"}:
                parts = candidate.split(".")
                if len(parts) == 3:
                    try:
                        payload = parts[1] + "=" * (-len(parts[1]) % 4)
                        claims = json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
                        subject = _identity_from_value(claims, identity_paths, depth + 1)
                        if subject:
                            return subject
                    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
                        continue
            elif len(candidate) <= 320:
                return candidate.strip()
    return None


def _verified_subject(account_id: str, cli_type: str) -> str | None:
    profile = get_profile(cli_type)
    if not profile.credential_files or not profile.credential_identity_paths:
        return None
    home = ACCOUNT_HOMES_DIR / account_id
    candidates = [home / relative for relative in profile.credential_files]
    for path in candidates:
        try:
            if not path.is_file() or path.stat().st_size > 2_000_000:
                continue
            subject = _identity_from_value(
                json.loads(path.read_text()),
                profile.credential_identity_paths,
            )
            if subject:
                return subject
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
    return None


def verify_account_credentials(
    account_id: str,
    cli_type: str,
    *,
    before: dict[str, tuple[int, int]] | None = None,
) -> dict:
    """Verify that the CLI wrote credentials into this account's own scope."""
    profile = get_profile(cli_type)
    current = capture_credential_state(account_id, profile.id)
    changed = sorted(
        path for path, fingerprint in current.items()
        if before is None or before.get(path) != fingerprint
    )
    known_files = profile.credential_files
    if known_files:
        present = [relative for relative in known_files if relative in current]
        evidence = present if before is None else [
            relative for relative in present if relative in changed
        ]
        verified = bool(evidence)
    else:
        verified = False
        evidence = []
    _, isolation = _credential_scope(account_id, profile.id)
    return {
        "verified": verified,
        "cli_type": profile.id,
        "isolation": isolation,
        "strong_isolation": isolation == "config_dir",
        "config_dir_env": profile.config_dir_env or None,
        "config_dir_subpath": profile.config_dir_subpath or None,
        "evidence_files": evidence[:12],
        "verified_subject": _verified_subject(account_id, profile.id) if verified else None,
        "unsupported_reason": (
            "credential_layout_not_declared" if not known_files else None
        ),
        "keychain_fallback_detected": profile.id == "claude" and not verified,
    }


def delete_account_home(account_id: str) -> None:
    """Delete the IVE-owned home for a removed account."""
    account_home = ACCOUNT_HOMES_DIR / account_id
    if account_home.exists():
        shutil.rmtree(account_home)
