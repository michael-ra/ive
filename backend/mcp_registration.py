"""Build CLI-specific MCP registration commands."""

from __future__ import annotations

from cli_profiles import CLIProfile


def build_mcp_remove_command(profile: CLIProfile, server_cfg: dict) -> list[str]:
    name = server_cfg["server_name"]
    if profile.id == "codex":
        return [profile.binary, "mcp", "remove", name]
    return [profile.binary, "mcp", "remove", name, "--scope", "project"]


def build_mcp_add_command(
    profile: CLIProfile,
    server_cfg: dict,
    resolved_env: dict[str, str],
    effective_approve: bool,
) -> list[str]:
    name = server_cfg["server_name"]
    if profile.id == "codex":
        cmd = [profile.binary, "mcp", "add", name]
        if server_cfg.get("server_type") == "http" and server_cfg.get("url"):
            cmd.extend(["--url", server_cfg["url"]])
        else:
            for key, value in resolved_env.items():
                cmd.extend(["--env", f"{key}={value}"])
            cmd.extend(["--", server_cfg["command"], *server_cfg.get("args", [])])
        return cmd

    cmd = [
        profile.binary, "mcp", "add", name,
        server_cfg["command"], *server_cfg.get("args", []),
        "--scope", "project",
        "--transport", server_cfg.get("server_type", "stdio"),
    ]
    if effective_approve:
        cmd.append("--trust")
    for key, value in resolved_env.items():
        cmd.extend(["-e", f"{key}={value}"])
    return cmd
