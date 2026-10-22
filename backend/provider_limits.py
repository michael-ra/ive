"""Provider-reported subscription windows, never inferred from token totals.

Codex: https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt
Claude: https://code.claude.com/docs/en/statusline (rate_limits payload)
"""
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import time

from config import DATA_DIR

_cache = {}
_locks = {}


def window(label, used, reset, minutes=None):
    if isinstance(used, bool) or not isinstance(used, (float, int)) or not math.isfinite(used) or not 0 <= used <= 100:
        return None
    if isinstance(reset, bool) or not isinstance(reset, (float, int)) or not math.isfinite(reset) or reset <= 0:
        reset = None
    return {"label": label, "used_percent": used, "remaining_percent": round(100 - used, 1),
            "resets_at": reset, "window_minutes": minutes}


def codex_windows(result):
    buckets = result.get("rateLimitsByLimitId")
    if not isinstance(buckets, dict) or not buckets:
        buckets = {"codex": result.get("rateLimits") or {}}
    windows = []
    for bucket_id, bucket in buckets.items():
        if not isinstance(bucket, dict):
            continue
        for kind in ("primary", "secondary"):
            raw = bucket.get(kind)
            if not isinstance(raw, dict):
                continue
            minutes = raw.get("windowDurationMins")
            label = "5h" if minutes == 300 else "Week" if minutes == 10080 else f"{minutes} min" if isinstance(minutes, (int, float)) and minutes > 0 else kind.title()
            item = window(label, raw.get("usedPercent"), raw.get("resetsAt"), minutes)
            if item:
                windows.append({**item, "bucket": str(bucket_id), "bucket_label": bucket.get("limitName") or str(bucket_id)})
    return windows


def claude_windows(payload):
    rates = payload.get("rate_limits")
    if not isinstance(rates, dict):
        return []
    result = []
    for key, label, minutes in (("five_hour", "5h", 300), ("seven_day", "Week", 10080)):
        raw = rates.get(key)
        if isinstance(raw, dict):
            item = window(label, raw.get("used_percentage"), raw.get("resets_at"), minutes)
            if item:
                result.append({**item, "bucket": "claude", "bucket_label": "Claude"})
    return result


def snapshot_path(session_id):
    return DATA_DIR / "provider-limits" / (hashlib.sha256(session_id.encode()).hexdigest() + ".json")


def read_claude_snapshot(session_id, scope):
    try:
        data = json.loads(snapshot_path(session_id).read_text())
        if data.get("scope") != scope:
            return None
        # Revalidate cached data, including old/corrupt files.
        windows = claude_windows(data)
        updated = data.get("updated_at")
        if not isinstance(updated, (int, float)) or not math.isfinite(updated):
            return None
        return {"windows": windows, "updated_at": updated, "source": "Claude Code status line"}
    except (OSError, ValueError, TypeError):
        return None


async def read_codex_limits(home):
    binary = shutil.which("codex")
    if not binary:
        raise RuntimeError("Codex CLI is not installed.")
    env = os.environ.copy()
    # Match the session's credential scope, with no fallback to another account.
    env.update({"HOME": str(home), "CODEX_HOME": str(Path(home) / ".codex")})
    for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"):
        env.pop(key, None)
    proc = await asyncio.create_subprocess_exec(binary, "app-server", "--listen", "stdio://",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, env=env, cwd=str(home), limit=1024 * 1024)
    async def send(message):
        proc.stdin.write((json.dumps(message) + "\n").encode())
        await proc.stdin.drain()
    async def response(request_id):
        while line := await proc.stdout.readline():
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if message.get("id") != request_id:
                continue
            if "error" in message:
                # Raw provider errors can include account or credential details.
                raise RuntimeError("Codex could not read this account's subscription limits. Check its CLI sign-in.")
            return message.get("result") or {}
        raise RuntimeError("Codex closed the limit query.")
    try:
        async with asyncio.timeout(12):
            await send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "ive_limits", "title": "IVE account limits", "version": "1.0.6"}}})
            await response(1)
            await send({"method": "initialized", "params": {}})
            await send({"id": 2, "method": "account/rateLimits/read"})
            result = await response(2)
            return {"windows": codex_windows(result), "updated_at": time.time(), "source": "Codex account/rateLimits/read"}
    finally:
        if proc.returncode is None:
            proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), 2)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()


async def limits_for_session(session, account=None):
    from ive_cli_profile import runtime_home_for_cli
    provider = session.get("cli_type") or ("claude" if session.get("id") else "codex")
    scope = session.get("account_id") or "host"
    result = {"provider": provider, "account_id": session.get("account_id"),
              "account_label": (account or {}).get("name") or "Local CLI account",
              "windows": [], "updated_at": None, "stale": False}
    if session.get("account_id") and (not account or account.get("cli_type") != provider or account.get("type") != "oauth" or not account.get("credentials_verified_at")):
        return {**result, "message": "Subscription limits require this session's verified OAuth account."}
    if provider == "claude":
        snapshot = read_claude_snapshot(session.get("id", ""), scope)
        if snapshot:
            return {**result, **snapshot, "stale": time.time() - snapshot["updated_at"] > 300,
                    "message": None if snapshot["windows"] else "Claude has not reported subscription windows yet."}
        return {**result, "message": "Waiting for Claude Code to report limits after a response. Existing sessions need a restart to enable reporting."}
    if provider != "codex":
        return {**result, "message": "This provider does not report subscription windows to IVE."}
    home = runtime_home_for_cli(provider, account_id=session.get("account_id"))
    key = str(home)
    async with _locks.setdefault(key, asyncio.Lock()):
        cached = _cache.get(key)
        if cached and time.monotonic() - cached[0] < 60:
            return {**result, **cached[1]}
        try:
            data = await read_codex_limits(home)
            data["stale"] = False
            data["message"] = None if data["windows"] else "This account has no reported subscription windows."
        except (OSError, RuntimeError, asyncio.TimeoutError, ValueError):
            data = {**(cached[1] if cached else {}), "stale": True,
                    "message": "Limits could not be refreshed. Check the account's Codex CLI sign-in or try again shortly."}
        _cache[key] = (time.monotonic(), data)
        return {**result, **data}
