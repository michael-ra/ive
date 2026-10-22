"""One interpreter contract for source and self-contained desktop processes."""
from pathlib import Path
import shlex
import sys

from resource_path import backend_dir, is_frozen, project_root

HELPERS = {
    "commander": "mcp_server",
    "worker": "worker_mcp_server",
    "documentor": "documentor_mcp_server",
    "brainstormer": "brainstormer_mcp_server",
    "mcp-env": "mcp_env_wrapper",
    "hook-relay": "desktop_hook_relay",
    "provider-statusline": "provider_statusline",
    "context-navigation": "context_navigation",
}
BUILTIN_HELPERS = {
    "builtin-commander": "commander", "builtin-worker-board": "worker",
    "builtin-documentor": "documentor", "builtin-brainstormer": "brainstormer",
    "builtin-deep-research": "research-mcp",
}


def python_command(*args: str) -> list[str]:
    return [sys.executable, *(["--python"] if is_frozen() else []), *map(str,args)]


def helper_command(name: str, *args: str) -> list[str]:
    if name not in HELPERS and name != "research-mcp":
        raise ValueError(f"Unknown bundled helper: {name}")
    if is_frozen():
        return [sys.executable, "--helper", name, *map(str,args)]
    path = (project_root()/"plugins/deep-research/mcp_server.py" if name == "research-mcp"
            else backend_dir()/(HELPERS[name]+".py"))
    return python_command(str(path), *args)


def shell_python_function() -> str:
    """A private Bash helper, scoped to generated IVE hook processes."""
    if not is_frozen():
        return ""
    return "python3() { " + shlex.join(python_command()) + ' "$@"; }\nexport -f python3\n'
