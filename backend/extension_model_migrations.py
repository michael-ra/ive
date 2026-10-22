"""Selected workspace-model migration contributions, without product fields.

Providers declare initial result counters and an async per-row migration. The
host invokes them after its own research-model write, in the same transaction.
Selection governs access even when a disabled owner's old columns still exist.
"""
import extension_host


class WorkspaceModelMigrations:
    def __init__(self):
        self.counts = {}
        self._providers = []
        for metadata in extension_host.installed_extensions():
            owner = metadata["id"]
            relative = "backend/model_providers.py"
            if not (extension_host.extension_path(owner) / relative).is_file():
                continue
            provider = extension_host.load_backend_module(owner, relative)
            initial = getattr(provider, "INITIAL_COUNTS", None)
            if (not isinstance(initial, dict)
                    or any(not isinstance(key, str) or not key or type(value) is not int or value < 0
                           for key, value in initial.items())
                    or self.counts.keys() & initial.keys()
                    or not callable(getattr(provider, "migrate_workspace_row", None))):
                raise ValueError(f"Invalid workspace-model migration contribution: {owner}")
            self.counts.update(initial)
            self._providers.append((owner, provider, set(initial)))

    async def migrate_row(self, db, row, **host):
        for owner, provider, keys in self._providers:
            delta = await provider.migrate_workspace_row(db, row, **host)
            if (not isinstance(delta, dict) or delta.keys() - keys
                    or any(type(value) is not int or value < 0 for value in delta.values())):
                raise ValueError(f"Invalid workspace-model migration counts: {owner}")
            for key, value in delta.items():
                self.counts[key] += value
