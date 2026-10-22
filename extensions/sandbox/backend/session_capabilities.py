"""Sandbox-owned runtime diagnostics; values and transport details stay private."""
from session_capabilities import _capability, _env_state

ENV_FEATURES = (
    ("SANDBOX_RUNTIME", False),
    ("SANDBOX_FAIL_CLOSED", False),
    ("SANDBOX_EXEC_API", False),
    ("EGRESS_PROXY_ENFORCE", False),
    ("EGRESS_ENFORCE", False),
)
PRESENCE_ENABLES = {"SANDBOX_RUNTIME"}


async def collect_capabilities(db, session, workspace, environ):
    workspace_id = str(session.get("workspace_id") or "")
    env = environ
    capabilities = []
    sandbox_type = str(workspace.get("sandbox_type") or "none")
    capabilities.append(_capability(
        "sandbox",
        sandbox_type,
        "workspace_setting",
        f"{workspace_id}:sandbox_type",
        {
            "enabled": sandbox_type != "none",
            "network": bool(1 if workspace.get("sandbox_network") is None else workspace.get("sandbox_network")),
            "fail_closed": _env_state(env, "SANDBOX_FAIL_CLOSED", False)["enabled"],
        },
    ))

    return capabilities
