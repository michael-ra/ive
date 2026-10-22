"""Executable entry for the bundled server and its stdio child helpers."""
import json
import multiprocessing
import os
from pathlib import Path
import runpy
import sys

from resource_path import is_frozen, project_root


def configure_desktop() -> None:
    if not is_frozen():
        return
    # Do not discover adjacent development extensions or inherit dev roots.
    os.environ.setdefault("IVE_EDITION", "integrated-dev")
    os.environ.setdefault("IVE_EXTENSION_PATHS", str(project_root()/"extensions"))
    os.environ.setdefault("IVE_EXTENSIONS", "sandbox")


def run_python(args: list[str]) -> int:
    """Internal subprocess compatibility; no shell parsing or external Python."""
    if not args:
        raise ValueError("--python requires -c, -m, -, or a script path")
    mode=args[0]
    if mode in {"-c", "-m"} and len(args)<2:
        raise ValueError(f"{mode} requires an argument")
    if mode == "-m":
        sys.argv=[args[1],*args[2:]]
        runpy.run_module(args[1],run_name="__main__",alter_sys=True)
    elif mode == "-c":
        sys.argv=["-c",*args[2:]]
        exec(compile(args[1],"<string>","exec"),{"__name__":"__main__","__builtins__":__builtins__})
    elif mode == "-":
        sys.argv=["-",*args[1:]]
        exec(compile(sys.stdin.read(),"<stdin>","exec"),{"__name__":"__main__","__builtins__":__builtins__})
    elif not mode.startswith("-"):
        sys.argv=args
        sys.path.insert(0,str(Path(mode).resolve().parent))
        runpy.run_path(mode,run_name="__main__")
    else:
        raise ValueError(f"Unsupported embedded Python option: {mode}")
    return 0


def main(args: list[str] | None = None) -> int:
    multiprocessing.freeze_support()
    configure_desktop()
    args=list(sys.argv[1:] if args is None else args)
    if args[:1] == ["--python"]:
        return run_python(args[1:])
    if args[:1] == ["--helper"]:
        from helper_command import HELPERS
        if len(args)<2 or args[1] not in {*HELPERS,"research-mcp"}:
            raise ValueError("Unknown bundled helper")
        sys.argv=[args[1],*args[2:]]
        if args[1] == "research-mcp":
            if is_frozen():
                runpy.run_module("ive_research_mcp",run_name="__main__",alter_sys=True)
            else:
                runpy.run_path(str(project_root()/"plugins/deep-research/mcp_server.py"),run_name="__main__")
        else:
            runpy.run_module(HELPERS[args[1]],run_name="__main__",alter_sys=True)
        return 0
    if args == ["--bundle-info"]:
        manifest=project_root()/"bundle-info.json"
        print(manifest.read_text() if manifest.is_file() else json.dumps({"frozen":False}))
        return 0
    sys.argv=[sys.argv[0],*args]
    runpy.run_module("server",run_name="__main__",alter_sys=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValueError as exc:
        print(f"IVE backend: {exc}",file=sys.stderr)
        raise SystemExit(2)
