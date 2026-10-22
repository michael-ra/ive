"""Optional ticket indexing compatibility port.

Only the installed owner supplies representations, storage and ranking.
Ordinary IVE tasks, notes and explicit file claims do not use this port.
"""
from extension_host import (
    ExtensionUnavailable as _ExtensionUnavailable,
    available as _extension_available,
    load_legacy_namespace as _load_extension_namespace,
)


async def _unavailable(*args, **kwargs):
    raise _ExtensionUnavailable("myelin")


index_ticket = _unavailable
reindex_ticket = _unavailable
update_ticket_metadata = _unavailable
delete_ticket_index = _unavailable
backfill_workspace = _unavailable

if _extension_available("myelin"):
    _load_extension_namespace(globals(), "myelin", "backend/ticket_indexer.py")
