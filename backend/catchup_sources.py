"""Selected optional update sources for IVE's ordinary catch-up digest.

Providers own their queries and row representations. Trusted providers receive
the existing connection and authorized workspace IDs; returned IDs are checked.
This is not a database permission boundary.
An unavailable optional source must not suppress ordinary note/file-sync rows.
"""
import logging

import extension_host

log = logging.getLogger(__name__)


def _sources():
    selected = []
    orders = set()
    for metadata in extension_host.installed_extensions():
        owner = metadata["id"]
        relative = "backend/catchup.py"
        if not (extension_host.extension_path(owner) / relative).is_file():
            continue
        provider = extension_host.load_backend_module(owner, relative)
        sources = getattr(provider, "MEMORY_SOURCES", ())
        if not isinstance(sources, (list, tuple)):
            raise ValueError("Invalid catch-up source declaration")
        for order, callback in sources:
            if type(order) is not int or order in orders or not callable(callback):
                raise ValueError("Conflicting or invalid catch-up source")
            orders.add(order)
            selected.append((order, owner, callback))
    return sorted(selected)


async def memory_updates(db, workspace_ids, since=None, until=None):
    """Keep deterministic contribution order before the host's stable time sort."""
    if not workspace_ids:
        return []
    rows = []
    for _order, owner, callback in _sources():
        try:
            values = await callback(db, tuple(workspace_ids), since, until)
            if not isinstance(values, list) or any(not isinstance(row, dict) for row in values):
                raise ValueError("Catch-up source returned invalid rows")
            if any(row.get("workspace_id") not in workspace_ids for row in values):
                raise ValueError("Catch-up source returned an out-of-scope workspace")
            rows.extend(values)
        except Exception:
            log.warning("Optional catch-up source unavailable: %s", owner, exc_info=True)
    return rows
