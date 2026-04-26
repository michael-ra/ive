#!/usr/bin/env python3
"""HF Explorer MCP Server — mount Hugging Face repos as local filesystems.

Uses hf-mount to lazily mount HF Hub repos (models, datasets, spaces).
Once mounted, agents use their native file tools (Read, ls, Glob, etc.)
to explore — no custom file-reading tools needed.

Search uses the HF Hub REST API (hf-mount doesn't do discovery).

Stdio JSON-RPC 2.0 (MCP protocol).
Requires: hf-mount binary (https://github.com/huggingface/hf-mount)
"""

import json
import logging
import os
import shutil
import subprocess
import sys
import urllib.request
import urllib.error
import urllib.parse

log = logging.getLogger("hf-explorer-mcp")

# ── Config ────────────────────────────────────────────────────────

HF_API = "https://huggingface.co/api"
HF_TOKEN = os.environ.get("HF_TOKEN", "")
MOUNT_BASE = os.environ.get("HF_MOUNT_BASE", "/tmp/hf-mounts")
HF_MOUNT_BIN = shutil.which("hf-mount")

# Track active mounts: repo_id -> mount_path
_active_mounts: dict[str, str] = {}


def _ensure_hf_mount() -> str | None:
    """Auto-install hf-mount if missing. Returns binary path or None on failure."""
    global HF_MOUNT_BIN
    if HF_MOUNT_BIN:
        return HF_MOUNT_BIN
    try:
        log.warning("hf-mount not found, installing...")
        result = subprocess.run(
            ["sh", "-c", "curl -fsSL https://raw.githubusercontent.com/huggingface/hf-mount/main/install.sh | sh"],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode == 0:
            HF_MOUNT_BIN = shutil.which("hf-mount")
            # Also check ~/.local/bin which the installer uses
            if not HF_MOUNT_BIN:
                candidate = os.path.expanduser("~/.local/bin/hf-mount")
                if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                    HF_MOUNT_BIN = candidate
            if HF_MOUNT_BIN:
                log.warning("hf-mount installed at %s", HF_MOUNT_BIN)
                return HF_MOUNT_BIN
        return None
    except Exception:
        return None


def _hf_headers() -> dict:
    headers = {"User-Agent": "ive-hf-explorer/1.0"}
    if HF_TOKEN:
        headers["Authorization"] = f"Bearer {HF_TOKEN}"
    return headers


# ── Tool implementations ─────────────────────────────────────────

def tool_hf_search(args: dict) -> str:
    """Search HF Hub for models, datasets, or spaces."""
    query = args.get("query", "").strip()
    if not query:
        return json.dumps({"error": "query required"})

    repo_type = args.get("type", "model")
    sort = args.get("sort", "downloads")
    limit = min(args.get("limit", 20), 50)

    type_path = {"model": "/models", "dataset": "/datasets", "space": "/spaces"}.get(repo_type, "/models")

    params = {"search": query, "sort": sort, "direction": "-1", "limit": str(limit)}
    if args.get("filter"):
        params["filter"] = args["filter"]

    url = f"{HF_API}{type_path}?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=_hf_headers())

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return json.dumps({"error": e.read().decode(), "status": e.code})
    except Exception as e:
        return json.dumps({"error": str(e)})

    items = []
    for item in data:
        entry = {
            "id": item.get("id", item.get("modelId", "")),
            "likes": item.get("likes", 0),
            "downloads": item.get("downloads", 0),
            "tags": item.get("tags", [])[:10],
            "last_modified": item.get("lastModified", ""),
        }
        if "pipeline_tag" in item:
            entry["task"] = item["pipeline_tag"]
        if item.get("description"):
            entry["description"] = item["description"][:200]
        items.append(entry)

    return json.dumps({"query": query, "type": repo_type, "total": len(items), "results": items}, indent=2)


def tool_hf_mount(args: dict) -> str:
    """Mount a HF repo as a local filesystem."""
    binary = _ensure_hf_mount()
    if not binary:
        return json.dumps({
            "error": "hf-mount auto-install failed",
            "manual_install": "curl -fsSL https://raw.githubusercontent.com/huggingface/hf-mount/main/install.sh | sh",
        })

    repo_id = args.get("repo_id", "").strip()
    if not repo_id:
        return json.dumps({"error": "repo_id required (e.g. 'meta-llama/Llama-3.1-8B')"})

    repo_type = args.get("type", "model")
    mount_path = args.get("mount_path", "").strip()

    if not mount_path:
        safe_name = repo_id.replace("/", "_")
        mount_path = os.path.join(MOUNT_BASE, safe_name)

    # Already mounted?
    if repo_id in _active_mounts:
        existing = _active_mounts[repo_id]
        if os.path.ismount(existing) or os.listdir(existing):
            return json.dumps({
                "already_mounted": True,
                "repo_id": repo_id,
                "mount_path": existing,
                "note": f"Already mounted. Explore with: ls {existing}",
            }, indent=2)

    os.makedirs(mount_path, exist_ok=True)

    # Build hf-mount command
    # hf-mount start [--hf-token TOKEN] repo <repo_id> <mount_path>
    # For datasets: prefix repo_id with "datasets/"
    if repo_type == "dataset":
        full_id = f"datasets/{repo_id}"
    elif repo_type == "space":
        full_id = f"spaces/{repo_id}"
    else:
        full_id = repo_id

    cmd = [binary, "start"]
    if HF_TOKEN:
        cmd.extend(["--hf-token", HF_TOKEN])
    cmd.extend(["repo", full_id, mount_path])

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            stderr = result.stderr.strip()
            return json.dumps({"error": f"hf-mount failed (exit {result.returncode}): {stderr}"})

        _active_mounts[repo_id] = mount_path

        return json.dumps({
            "mounted": True,
            "repo_id": repo_id,
            "mount_path": mount_path,
            "note": (
                f"Repo mounted at {mount_path} — files are fetched lazily on access. "
                f"Use standard tools to explore: ls, Read, Glob, grep, etc."
            ),
        }, indent=2)
    except subprocess.TimeoutExpired:
        return json.dumps({"error": "hf-mount timed out (30s)"})
    except Exception as e:
        return json.dumps({"error": str(e)})


def tool_hf_unmount(args: dict) -> str:
    """Unmount a previously mounted HF repo."""
    binary = HF_MOUNT_BIN or shutil.which("hf-mount")
    if not binary:
        return json.dumps({"error": "hf-mount not installed"})

    repo_id = args.get("repo_id", "").strip()
    mount_path = args.get("mount_path", "").strip()

    if not mount_path and repo_id:
        mount_path = _active_mounts.get(repo_id, "")

    if not mount_path:
        mounts = {k: v for k, v in _active_mounts.items()}
        return json.dumps({"error": "Provide repo_id or mount_path", "active_mounts": mounts})

    try:
        result = subprocess.run(
            [binary, "stop", mount_path],
            capture_output=True, text=True, timeout=15,
        )
        # Clean up tracking
        to_remove = [k for k, v in _active_mounts.items() if v == mount_path]
        for k in to_remove:
            del _active_mounts[k]

        if result.returncode != 0:
            return json.dumps({"error": result.stderr.strip()})

        return json.dumps({"unmounted": True, "path": mount_path})
    except Exception as e:
        return json.dumps({"error": str(e)})


# ── Tool registry ────────────────────────────────────────────────

TOOLS = {
    "hf_search": {
        "handler": tool_hf_search,
        "description": (
            "Search Hugging Face Hub for models, datasets, or spaces. "
            "Returns repo IDs, download counts, tags, and task types. "
            "Use to discover what's available before mounting."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query (e.g. 'sentiment analysis', 'llama 3', 'code generation')",
                },
                "type": {
                    "type": "string",
                    "enum": ["model", "dataset", "space"],
                    "description": "Repo type to search (default: model)",
                    "default": "model",
                },
                "sort": {
                    "type": "string",
                    "enum": ["downloads", "likes", "trending", "last_modified"],
                    "description": "Sort order (default: downloads)",
                    "default": "downloads",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results (default: 20, max: 50)",
                    "default": 20,
                },
                "filter": {
                    "type": "string",
                    "description": "HF filter (e.g. 'task:text-generation', 'library:transformers')",
                },
            },
            "required": ["query"],
        },
    },

    "hf_mount": {
        "handler": tool_hf_mount,
        "description": (
            "Mount a Hugging Face repo as a local filesystem using hf-mount. "
            "Files are fetched lazily — only bytes you access travel over the network. "
            "Once mounted, use standard file tools (Read, ls, Glob, grep) to explore. "
            "No full download needed."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "repo_id": {
                    "type": "string",
                    "description": "HF repo ID (e.g. 'meta-llama/Llama-3.1-8B', 'openai/whisper-large-v3')",
                },
                "type": {
                    "type": "string",
                    "enum": ["model", "dataset", "space"],
                    "description": "Repo type (default: model)",
                    "default": "model",
                },
                "mount_path": {
                    "type": "string",
                    "description": "Local path to mount at (auto-generated under /tmp/hf-mounts/ if omitted)",
                },
            },
            "required": ["repo_id"],
        },
    },

    "hf_unmount": {
        "handler": tool_hf_unmount,
        "description": "Unmount a previously mounted HF repo. Provide repo_id or mount_path.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "repo_id": {
                    "type": "string",
                    "description": "Repo ID to unmount",
                },
                "mount_path": {
                    "type": "string",
                    "description": "Mount path to unmount",
                },
            },
        },
    },
}


# ── MCP protocol handler ─────────────────────────────────────────

def handle_jsonrpc(request: dict) -> dict | None:
    method = request.get("method", "")
    req_id = request.get("id")

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "hf-explorer", "version": "1.0.0"},
            },
        }

    if method == "notifications/initialized":
        return None

    if method == "tools/list":
        tools_list = [
            {"name": name, "description": spec["description"], "inputSchema": spec["inputSchema"]}
            for name, spec in TOOLS.items()
        ]
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": tools_list}}

    if method == "tools/call":
        params = request.get("params", {})
        tool_name = params.get("name", "")
        tool_args = params.get("arguments", {})
        spec = TOOLS.get(tool_name)

        if not spec:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"Unknown tool: {tool_name}"}}

        try:
            result_text = spec["handler"](tool_args)
            return {"jsonrpc": "2.0", "id": req_id, "result": {"content": [{"type": "text", "text": result_text}]}}
        except Exception as e:
            return {"jsonrpc": "2.0", "id": req_id, "result": {"content": [{"type": "text", "text": f"Error: {e}"}], "isError": True}}

    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"Unknown method: {method}"}}


# ── Main loop ─────────────────────────────────────────────────────

def main():
    logging.basicConfig(level=logging.WARNING, format="%(name)s %(levelname)s %(message)s", stream=sys.stderr)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue

        response = handle_jsonrpc(request)
        if response is not None:
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
