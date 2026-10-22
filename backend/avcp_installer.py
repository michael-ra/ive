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


def _strip_block(text: str, only_sourcing: str | None = None) -> str:
    """Remove IVE-avcp managed blocks (idempotency / clean uninstall).

    With ``only_sourcing``, keep blocks that source a different avcp.sh, so
    one IVE installation never removes another one's guard.
    """
    out, block = [], None
    for ln in text.splitlines(keepends=True):
        if block is None and ln.strip() == _BEGIN:
            block = [ln]
            continue
        if block is not None:
            block.append(ln)
            if ln.strip() == _END:
                if only_sourcing is not None and only_sourcing not in "".join(block):
                    out.extend(block)
                block = None
            continue
        out.append(ln)
    if block is not None:
        out.extend(block)
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


def uninstall_avcp(rc_paths: list[str] | None = None, only_this_install: bool = False) -> dict:
    """Remove the IVE-avcp block from each rc; with only_this_install, only
    blocks that source this installation's avcp.sh."""
    rcs = rc_paths if rc_paths is not None else _default_rcs()
    removed = []
    for rc in rcs:
        if not os.path.exists(rc):
            continue
        with open(rc, encoding="utf-8", errors="ignore") as f:
            existing = f.read()
        cleaned = _strip_block(existing, AVCP_SH if only_this_install else None)
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
