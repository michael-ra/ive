"""Optional ownership of implicit dispatch; core explicit execution stays core."""
from __future__ import annotations

import extension_host


def _contributors(owner: str | None = None):
    """Trusted backend/dispatch_ownership.py convention, not process isolation.

    A provider implements owns_dispatch(workspace_id, *, get_db) and may expose
    a stable REASON for compatibility. Plugins without this file are normal.
    Only enabled products may claim a workspace; stored values alone cannot.
    """
    for metadata in extension_host.installed_extensions():
        extension_id = metadata["id"]
        if owner is not None and owner != extension_id:
            continue
        root = extension_host.extension_path(extension_id)
        relative = "backend/dispatch_ownership.py"
        if (root / relative).is_file():
            yield extension_id, extension_host.load_backend_module(extension_id, relative)


async def get_owner(workspace_id: str | None, *, get_db, owner: str | None = None) -> dict | None:
    if not workspace_id:
        return None
    selected = None
    for extension_id, contribution in _contributors(owner):
        predicate = getattr(contribution, "owns_dispatch", None)
        reason = getattr(contribution, "REASON", "external_dispatch_owner")
        if not callable(predicate) or not isinstance(reason, str) or not reason or len(reason) > 100:
            raise ValueError("Invalid dispatch ownership contribution")
        claimed = await predicate(workspace_id, get_db=get_db)
        if not isinstance(claimed, bool):
            raise ValueError("Invalid dispatch ownership decision")
        if claimed:
            if selected is not None:
                raise ValueError("Conflicting dispatch ownership claims")
            selected = {"owner": extension_id, "reason": reason}
    return selected
