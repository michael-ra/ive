"""LLM Router — CLI-agnostic one-shot LLM calls.

Routes requests through the installed CLI (claude or gemini) in non-interactive
print mode.  No API keys needed in Commander — uses whatever auth the CLI
already has configured on the machine.

Usage:

    text = await llm_call("claude", model="sonnet", prompt="explain this code")
    data = await llm_call_json("gemini", model="gemini-2.5-flash", prompt="...", system="return JSON only")
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import tempfile
import os

log = logging.getLogger(__name__)

# Max prompt length (bytes) before we fall back to temp-file passing.
# macOS ARG_MAX is ~262144 but we leave headroom for the rest of argv + env.
_ARG_LIMIT = 200_000


async def llm_call(
    cli: str = "claude",
    model: str | None = None,
    prompt: str = "",
    system: str | None = None,
    timeout: int = 120,
) -> str:
    """Make a one-shot LLM call via CLI subprocess.

    Args:
        cli: "claude" or "gemini".
        model: Model name (e.g. "sonnet", "gemini-2.5-pro").  None = CLI default.
        prompt: The user prompt text.
        system: Optional system prompt (prepended to the user prompt for CLIs
                that don't have a dedicated system-prompt flag).
        timeout: Max seconds to wait for a response.

    Returns:
        The LLM's text response (stripped).

    Raises:
        RuntimeError: If the CLI is not found or the call fails.
    """
    from cli_profiles import get_profile
    profile = get_profile(cli)

    binary = shutil.which(profile.binary)
    if not binary:
        raise RuntimeError(f"{profile.binary} CLI not found in PATH")

    # Merge system prompt into the user prompt — both CLIs accept a single
    # prompt string, and embedding the system instructions at the top is the
    # most portable approach.
    full_prompt = prompt
    if system:
        full_prompt = f"{system}\n\n---\n\n{full_prompt}"

    # Build the command.
    use_file = len(full_prompt.encode()) > _ARG_LIMIT
    tmp_path: str | None = None

    if use_file:
        # Write prompt to a temp file and have the CLI read it.
        # Claude: claude -p "$(cat file)"  — but that requires shell.
        # Safer: pass via stdin by omitting the prompt arg.
        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".txt", delete=False, prefix="llm_prompt_"
        )
        tmp.write(full_prompt)
        tmp.close()
        tmp_path = tmp.name

    try:
        cmd: list[str] = [profile.binary]

        if use_file:
            # Claude requires --print to read from stdin; Gemini reads stdin
            # without a special flag.  This is a documented CLI-specific branch
            # — it's not in the Feature enum because it's a print-mode quirk.
            if cli == "claude":
                cmd.append("--print")
        else:
            cmd.extend(["-p", full_prompt])
        if model:
            cmd.extend(["--model", model])

        log.info("llm_call: %s (model=%s, prompt_len=%d)", cli, model, len(full_prompt))

        stdin_data: bytes | None = None
        if use_file:
            stdin_data = full_prompt.encode()

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE if stdin_data else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=stdin_data), timeout=timeout
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise RuntimeError(f"{cli} call timed out after {timeout}s")

        if proc.returncode != 0:
            err = stderr.decode(errors="replace").strip()
            raise RuntimeError(f"{cli} exited with code {proc.returncode}: {err}")

        result = stdout.decode(errors="replace").strip()
        log.info("llm_call: got %d chars back", len(result))
        return result

    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


async def llm_call_json(
    cli: str = "claude",
    model: str | None = None,
    prompt: str = "",
    system: str | None = None,
    timeout: int = 120,
) -> dict:
    """Like llm_call but parses the response as JSON.

    Strips markdown code fences if present before parsing.
    """
    text = await llm_call(cli, model, prompt, system, timeout)

    # Strip markdown fences (```json ... ``` or ``` ... ```)
    stripped = text.strip()
    if stripped.startswith("```"):
        # Remove opening fence line
        stripped = stripped.split("\n", 1)[1] if "\n" in stripped else stripped[3:]
    if stripped.endswith("```"):
        stripped = stripped[:-3]
    stripped = stripped.strip()

    try:
        return json.loads(stripped)
    except json.JSONDecodeError as e:
        log.warning("llm_call_json: failed to parse response as JSON: %s", e)
        log.debug("Raw response:\n%s", text)
        raise RuntimeError(
            f"LLM returned invalid JSON. Raw response (first 500 chars): {text[:500]}"
        ) from e
