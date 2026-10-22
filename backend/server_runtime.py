"""Explicit accessor for the running ``server`` module.

server.py is normally executed as ``__main__`` (``python backend/server.py`` or
``runpy.run_module("server", run_name="__main__")``). A plain ``import server``
from a helper module would then execute server.py a second time as a separate
module with empty state (second PTY manager, no WebSocket clients, empty
session/workspace maps). server.py registers itself as ``sys.modules["server"]``
at the very top when it runs as main; helpers resolve server functions and
state through :func:`attr` so the back-dependency is explicit and always lands
on the live module.
"""

import importlib
import sys
from types import ModuleType


def module() -> ModuleType:
    """Return the live server module, importing it only as a last resort."""
    mod = sys.modules.get("server")
    if mod is not None:
        return mod
    return importlib.import_module("server")


def attr(name: str):
    """Return ``server.<name>`` from the live server module."""
    return getattr(module(), name)
