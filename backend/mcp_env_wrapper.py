#!/usr/bin/env python3
"""Launch an MCP server after resolving IVE session env templates.

Antigravity's agy CLI reads MCP servers from one global config file rather
than from a per-session CLI flag. This wrapper lets that global config stay
stable while still giving each launched MCP server the session-specific env
from the agy process that spawned it.
"""
from __future__ import annotations

import base64
import json
import os
import sys


def _decode_spec(value: str) -> dict:
    padding = "=" * (-len(value) % 4)
    raw = base64.urlsafe_b64decode((value + padding).encode("ascii"))
    spec = json.loads(raw.decode("utf-8"))
    if not isinstance(spec, dict):
        raise ValueError("MCP wrapper spec must be a JSON object")
    return spec


def _template_vars(env: dict[str, str]) -> dict[str, str]:
    api_url = env.get("COMMANDER_API_URL", "http://127.0.0.1:5111")
    host = "127.0.0.1"
    port = "5111"
    if "://" in api_url:
        after_scheme = api_url.split("://", 1)[1].split("/", 1)[0]
        if ":" in after_scheme:
            host, port = after_scheme.rsplit(":", 1)
        elif after_scheme:
            host = after_scheme
    return {
        "host": host,
        "port": port,
        "workspace_id": env.get("COMMANDER_WORKSPACE_ID") or env.get("WORKER_WORKSPACE_ID", ""),
        "workspace_path": env.get("COMMANDER_WORKSPACE_PATH", ""),
        "session_id": env.get("COMMANDER_SESSION_ID") or env.get("WORKER_SESSION_ID", ""),
        "session_type": env.get("COMMANDER_SESSION_TYPE") or env.get("WORKER_SESSION_TYPE", "worker"),
        "w2w_comms": env.get("WORKER_W2W_COMMS", "0"),
        "w2w_context": env.get("WORKER_W2W_CONTEXT", "0"),
        "w2w_coordination": env.get("WORKER_W2W_COORDINATION", "0"),
    }


def _resolve(value: object, vars_: dict[str, str]) -> str:
    text = str(value)
    for key, replacement in vars_.items():
        text = text.replace("{" + key + "}", replacement)
    return text


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: mcp_env_wrapper.py <base64-json-spec>", file=sys.stderr)
        return 2
    try:
        spec = _decode_spec(sys.argv[1])
        command = str(spec["command"])
        args = [str(arg) for arg in spec.get("args") or []]
        env = os.environ.copy()
        vars_ = _template_vars(env)
        for key, value in (spec.get("env") or {}).items():
            env[str(key)] = _resolve(value, vars_)
        os.execvpe(command, [command, *args], env)
    except Exception as exc:
        print(f"mcp_env_wrapper failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
