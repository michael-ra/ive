"""sandbox extension routes; host authentication and operation guards remain mandatory."""
from aiohttp import web


def register(app, host):
    # Sidecars (§2.4/§2.5): long-lived per-workspace containers hosting connectors.
    # Separate surface from the one-shot session sandbox — these are `--detach` and
    # never `--rm`, which is what makes logs survive a stop and a restart a restart.
    from sidecars import (
        list_sidecars_handler,
        start_sidecar_handler,
        stop_sidecar_handler,
        restart_sidecar_handler,
        delete_sidecar_handler,
        sidecar_health_handler,
        sidecar_logs_handler,
        sidecar_ledger_handler,
    )
    def _sidecar_ws_scoped(handler):
        """A workspace-scoped caller may only drive its OWN workspace's sidecars.

        The global auth middleware authenticates but does not compare the caller's
        scope against the workspace in the path, so without this a workspace-scoped
        joiner session could start or delete containers in any workspace.
        """
        async def _wrapped(request: web.Request) -> web.Response:
            caller = await host["resolve_caller"](request)
            if (caller and caller.get("workspace_id")
                    and caller["workspace_id"] != request.match_info.get("id")):
                return web.json_response({"error": "workspace mismatch"}, status=403)
            return await handler(request)
        return _wrapped

    app.router.add_get("/api/workspaces/{id}/sidecars",
                       _sidecar_ws_scoped(list_sidecars_handler))
    app.router.add_post("/api/workspaces/{id}/sidecars",
                        _sidecar_ws_scoped(start_sidecar_handler))
    app.router.add_post("/api/workspaces/{id}/sidecars/{name}/stop",
                        _sidecar_ws_scoped(stop_sidecar_handler))
    app.router.add_post("/api/workspaces/{id}/sidecars/{name}/restart",
                        _sidecar_ws_scoped(restart_sidecar_handler))
    app.router.add_delete("/api/workspaces/{id}/sidecars/{name}",
                          _sidecar_ws_scoped(delete_sidecar_handler))
    app.router.add_get("/api/workspaces/{id}/sidecars/{name}/health",
                       _sidecar_ws_scoped(sidecar_health_handler))
    app.router.add_get("/api/workspaces/{id}/sidecars/{name}/logs",
                       _sidecar_ws_scoped(sidecar_logs_handler))
    # The ledger is the only record of connector calls: `container exec` output
    # never reaches `container logs`.
    app.router.add_get("/api/workspaces/{id}/sidecars/{name}/ledger",
                       _sidecar_ws_scoped(sidecar_ledger_handler))
