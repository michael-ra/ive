"""Desktop lifecycle relay with stdlib only (no system Python, jq or curl)."""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request


def post(path, payload, session_id="", *, timeout=2):
    base=os.environ.get("COMMANDER_API_URL", "http://127.0.0.1:5112").rstrip("/")
    headers={"Content-Type":"application/json"}
    if session_id:
        headers["X-Commander-Session-Id"]=session_id
        headers["X-Commander-Session-Proof"]=os.environ.get("COMMANDER_SESSION_PROOF", "")
        headers["X-Commander-Workspace-Id"]=os.environ.get("COMMANDER_WORKSPACE_ID", "")
    request=urllib.request.Request(base+path,data=json.dumps(payload).encode(),headers=headers,method="POST")
    try:
        with urllib.request.urlopen(request,timeout=timeout) as response:
            result=json.load(response)
            return result if isinstance(result,dict) else {}
    except (OSError,ValueError,urllib.error.URLError):
        return {}


def main():
    try:
        payload=json.load(sys.stdin)
    except (OSError,ValueError):
        return 0
    if not isinstance(payload,dict):return 0
    cli=os.environ.get("COMMANDER_CLI_TYPE", "claude")
    session=os.environ.get("COMMANDER_SESSION_ID", "")
    if not session:
        try:
            parent=subprocess.check_output(["/bin/ps","-p",str(os.getppid()),"-o","comm="],text=True,timeout=1).lower()
            cli=next((name for token,name in (("agy","antigravity"),("antigravity","antigravity"),("gemini","gemini"),("codex","codex")) if token in parent),cli)
        except (OSError,subprocess.SubprocessError):
            pass
        discovered=post("/api/hooks/discover",{**payload,"cwd":os.getcwd(),"pid":str(os.getpid()),"cli_type":cli})
        session=discovered.get("session_id") or ""
        if not session:return 0
    event=payload.get("hook_event_name", "")
    synchronous=event in {"Stop","stop","PreToolUse","BeforeTool"}
    result=post("/api/hooks/event",payload,session,timeout=5 if synchronous else 2)
    if not synchronous:return 0
    if any(key in result for key in ("decision","hookSpecificOutput","additionalContext","updatedInput")):
        print(json.dumps(result));return 0
    if result.get("allow") is False:
        reason=str(result.get("reason") or "File is locked by active teammate session")
        protocol=os.environ.get("COMMANDER_HOOK_DECISION_PROTOCOL") or ("exit_code" if cli in {"gemini","antigravity"} else "claude_json")
        if protocol == "claude_json":
            print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":reason}}))
            return 0
        print(reason,file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":raise SystemExit(main())
