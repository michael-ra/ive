"""Optional semantic ticket retrieval compatibility port.

Only the installed owner supplies representations, storage and ranking.
Ordinary IVE tasks, notes and explicit file claims do not use this port.
"""
from extension_host import (
    ExtensionUnavailable as _ExtensionUnavailable,
    available as _extension_available,
    load_legacy_namespace as _load_extension_namespace,
)


async def _unavailable(*args, **kwargs):
    raise _ExtensionUnavailable("swarmlock")


find_related = _unavailable
get_ticket_embedding = _unavailable
embed_text = _unavailable

if _extension_available("swarmlock"):
    _load_extension_namespace(globals(), "swarmlock", "backend/ticket_retriever.py")
