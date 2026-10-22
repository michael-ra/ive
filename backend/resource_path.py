"""Path resolution for both source and frozen (PyInstaller/Nuitka) distributions.

In source mode, paths resolve relative to the Python source files.
In frozen mode, paths resolve relative to the compiled executable.
All existing behavior is preserved — this module is a no-op in dev mode.
"""

import os
import sys
from pathlib import Path


def is_frozen() -> bool:
    """True when running from a PyInstaller or Nuitka compiled binary."""
    # Note: dir() returns local scope only — use globals() to see module-level
    # __compiled__ that Nuitka injects into every compiled module.
    return getattr(sys, "frozen", False) or "__compiled__" in globals()


def backend_dir() -> Path:
    """Directory containing backend modules and data files.

    Source mode:  /path/to/ive/backend/
    Frozen mode:  /path/to/dist/ive/  (executable's directory)
    """
    if is_frozen():
        return bundle_root() / "backend"
    return Path(os.path.dirname(os.path.abspath(__file__)))


def project_root() -> Path:
    """Project root directory (one level above backend/ in source mode).

    Source mode:  /path/to/ive/
    Frozen mode:  IVE_ROOT env var if set, else the executable's directory.
    """
    # A shipped app must not load executable resources from an inherited dev
    # checkout or the current working directory.
    if is_frozen():
        return bundle_root()
    env = os.environ.get("IVE_ROOT")
    if env:
        return Path(env)
    return Path(os.path.dirname(os.path.abspath(__file__))).parent


def bundle_root() -> Path:
    """PyInstaller's read-only resource directory (onedir: _internal)."""
    if getattr(sys, "_MEIPASS", None):
        return Path(sys._MEIPASS).resolve()
    return Path(sys.executable).resolve().parent
