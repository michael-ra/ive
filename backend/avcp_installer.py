"""Installer for IVE's AVCP supply-chain guard (backend/avcp.sh).

Adds an idempotent IVE-managed block to the user's shell rc that sources avcp.sh, so package
installs (npm/pip/cargo/brew/...) are gated + logged. Because avcp.sh defines `_avcp_check`
EAGERLY (not zsh-autoloaded), shell-snapshot tools capture it — fixing the
`npm install -> _avcp_check: command not found` breakage seen under agents.
"""
from __future__ import annotations
import os

from resource_path import backend_dir
_HERE = str(backend_dir())
AVCP_SH = os.path.join(_HERE, "avcp.sh")
_BEGIN = "# >>> IVE avcp >>>"
_END = "# <<< IVE avcp <<<"


def _block(avcp_sh: str = AVCP_SH) -> str:
    return f'{_BEGIN}\n[ -f "{avcp_sh}" ] && . "{avcp_sh}"\n{_END}\n'


def _default_rcs() -> list[str]:
    home = os.path.expanduser("~")
    return [os.path.join(home, ".zshrc"), os.path.join(home, ".bashrc")]


def _strip_block(text: str) -> str:
    """Remove any existing IVE-avcp managed block (idempotency / clean uninstall)."""
    out, skip = [], False
    for ln in text.splitlines(keepends=True):
        if ln.strip() == _BEGIN:
            skip = True
            continue
        if ln.strip() == _END:
            skip = False
            continue
        if not skip:
            out.append(ln)
    return "".join(out)


def install_avcp(rc_paths: list[str] | None = None, avcp_sh: str = AVCP_SH) -> dict:
    """Write the IVE-avcp source block to each rc (idempotent — replaces any prior block)."""
    rcs = rc_paths if rc_paths is not None else _default_rcs()
    done = []
    for rc in rcs:
        existing = ""
        if os.path.exists(rc):
            with open(rc, encoding="utf-8", errors="ignore") as f:
                existing = f.read()
        cleaned = _strip_block(existing)
        if cleaned and not cleaned.endswith("\n"):
            cleaned += "\n"
        new = cleaned + _block(avcp_sh)
        if new != existing:
            with open(rc, "w", encoding="utf-8") as f:
                f.write(new)
            done.append(rc)
    return {"installed": done, "avcp_sh": avcp_sh}


def uninstall_avcp(rc_paths: list[str] | None = None) -> dict:
    rcs = rc_paths if rc_paths is not None else _default_rcs()
    removed = []
    for rc in rcs:
        if not os.path.exists(rc):
            continue
        with open(rc, encoding="utf-8", errors="ignore") as f:
            existing = f.read()
        cleaned = _strip_block(existing)
        if cleaned != existing:
            with open(rc, "w", encoding="utf-8") as f:
                f.write(cleaned)
            removed.append(rc)
    return {"removed": removed}


def avcp_status(rc_paths: list[str] | None = None) -> dict:
    rcs = rc_paths if rc_paths is not None else _default_rcs()
    installed = [rc for rc in rcs if os.path.exists(rc)
                 and _BEGIN in open(rc, encoding="utf-8", errors="ignore").read()]
    return {"installed_in": installed, "avcp_sh_exists": os.path.exists(AVCP_SH)}
