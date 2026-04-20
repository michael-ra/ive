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
    return getattr(sys, "frozen", False)


def backend_dir() -> Path:
    """Directory containing backend modules and data files.

    Source mode:  /path/to/ive/backend/
    Frozen mode:  /path/to/dist/ive/  (executable's directory)
    """
    if is_frozen():
        return Path(sys.executable).parent
    return Path(os.path.dirname(os.path.abspath(__file__)))


def project_root() -> Path:
    """Project root directory (one level above backend/ in source mode).

    Source mode:  /path/to/ive/
    Frozen mode:  /path/to/dist/ive/  (executable's directory)
    """
    if is_frozen():
        return Path(sys.executable).parent
    return Path(os.path.dirname(os.path.abspath(__file__))).parent
