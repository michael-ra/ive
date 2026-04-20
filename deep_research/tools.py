"""Tool system for agentic research.

Gives agents the ability to ACT, not just generate text:
  - gather: search the web for information
  - read_url: fetch and extract a specific URL in detail
  - search_code: grep the codebase
  - read_file: read a specific local file
  - profile_codebase: auto-profile a project

Without tools, agents are pipelines (predefined steps).
With tools, agents decide WHAT to do and WHEN — real agency.

Works with Ollama/vLLM function calling (OpenAI-compatible tools API).
Falls back to prompt-based tool parsing for models without native support.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from .extract import extract_content
from .search import build_search

logger = logging.getLogger(__name__)


# ── Tool definitions (OpenAI function-calling format) ──────────────

TOOL_GATHER = {
    "type": "function",
    "function": {
        "name": "gather",
        "description": (
            "Search the web across multiple search engines (DuckDuckGo, Brave, "
            "arXiv, Semantic Scholar, GitHub) and extract content from top results. "
            "Use when you need more information about a topic."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "queries": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "1-3 specific search queries to run",
                },
            },
            "required": ["queries"],
        },
    },
}

TOOL_READ_URL = {
    "type": "function",
    "function": {
        "name": "read_url",
        "description": (
            "Fetch and extract clean text content from a specific URL. "
            "Use when you found an interesting link and want to read it in detail."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The URL to fetch and extract content from",
                },
            },
            "required": ["url"],
        },
    },
}

TOOL_SEARCH_CODE = {
    "type": "function",
    "function": {
        "name": "search_code",
        "description": (
            "Search the codebase for a pattern (grep). Returns matching lines "
            "with file paths. Use to check if something exists or find implementations."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Regex pattern to search for",
                },
                "path": {
                    "type": "string",
                    "description": "Directory to search in (default: codebase root)",
                },
            },
            "required": ["pattern"],
        },
    },
}

TOOL_READ_FILE = {
    "type": "function",
    "function": {
        "name": "read_file",
        "description": (
            "Read the contents of a local file. Use to inspect specific source "
            "code, config files, or documentation."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file to read",
                },
                "max_chars": {
                    "type": "integer",
                    "description": "Maximum characters to read (default: 10000)",
                },
            },
            "required": ["path"],
        },
    },
}

# Tool sets per agent role
RESEARCHER_TOOLS = [TOOL_GATHER, TOOL_READ_URL]
INVESTIGATOR_TOOLS = [TOOL_GATHER, TOOL_READ_URL, TOOL_SEARCH_CODE, TOOL_READ_FILE]
ALIGNER_TOOLS = [TOOL_SEARCH_CODE, TOOL_READ_FILE]


# ── Tool execution ─────────────────────────────────────────────────


class ToolExecutor:
    """Executes tool calls from LLM responses."""

    def __init__(self, config=None, codebase_dir: str | None = None):
        self.config = config
        self.codebase_dir = Path(codebase_dir) if codebase_dir else None
        self._search = None

    async def execute(self, tool_name: str, arguments: dict) -> str:
        """Execute a tool and return the result as a string."""
        handler = {
            "gather": self._tool_gather,
            "read_url": self._tool_read_url,
            "search_code": self._tool_search_code,
            "read_file": self._tool_read_file,
        }.get(tool_name)

        if not handler:
            return f"Error: Unknown tool '{tool_name}'"

        try:
            result = await handler(arguments)
            logger.info("Tool %s executed: %d chars result", tool_name, len(result))
            return result
        except Exception as e:
            logger.warning("Tool %s failed: %s", tool_name, e)
            return f"Error executing {tool_name}: {e}"

    async def _tool_gather(self, args: dict) -> str:
        queries = args.get("queries", [])
        if not queries:
            return "Error: No queries provided"

        if self._search is None:
            self._search = build_search(self.config)

        from .extract import extract_multiple

        results = await self._search.search_many(queries, max_per_source=5)
        top_urls = [r.url for r in results[:8]]
        contents = await extract_multiple(top_urls)

        lines = []
        for r in results[:15]:
            content = contents.get(r.url)
            lines.append(f"### {r.title}")
            lines.append(f"URL: {r.url} | Source: {r.source}")
            if content:
                lines.append(content[:3000])
            else:
                lines.append(f"Snippet: {r.snippet}")
            lines.append("")

        return "\n".join(lines) if lines else "No results found."

    async def _tool_read_url(self, args: dict) -> str:
        url = args.get("url", "")
        if not url:
            return "Error: No URL provided"
        content = await extract_content(url)
        return content or f"Could not extract content from {url}"

    async def _tool_search_code(self, args: dict) -> str:
        import subprocess

        pattern = args.get("pattern", "")
        search_path = args.get("path") or (str(self.codebase_dir) if self.codebase_dir else ".")

        try:
            result = subprocess.run(
                ["grep", "-rn", "--include=*.py", "--include=*.js", "--include=*.ts",
                 "--include=*.jsx", "--include=*.tsx", "--include=*.sql",
                 "-m", "30", pattern, search_path],
                capture_output=True, text=True, timeout=10,
            )
            output = result.stdout.strip()
            return output if output else f"No matches for '{pattern}'"
        except (subprocess.TimeoutExpired, FileNotFoundError) as e:
            return f"Error: {e}"

    async def _tool_read_file(self, args: dict) -> str:
        path = Path(args.get("path", ""))
        max_chars = args.get("max_chars", 10000)
        if not path.exists():
            return f"Error: File not found: {path}"
        try:
            content = path.read_text(errors="replace")
            if len(content) > max_chars:
                return content[:max_chars] + f"\n\n... (truncated at {max_chars} chars, file is {len(content)} total)"
            return content
        except Exception as e:
            return f"Error reading {path}: {e}"


# ── Agentic loop ───────────────────────────────────────────────────


async def run_with_tools(
    llm,
    prompt: str,
    system: str,
    tools: list[dict],
    executor: ToolExecutor,
    max_tool_rounds: int = 5,
    task_hint: str | None = None,
    on_progress: callable | None = None,
) -> str:
    """Run an LLM generation with tool-calling support.

    The LLM can call tools, get results, and continue reasoning.
    Loops until the LLM produces a final text response without tool calls,
    or max_tool_rounds is reached.

    Works with:
    - Native function calling (Ollama/vLLM with supported models)
    - Fallback: prompt-based tool parsing (for any model)
    """
    progress = on_progress or (lambda msg: None)
    session = await llm._get_session()
    model = llm._resolve_model(task_hint)

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    for round_num in range(max_tool_rounds):
        body = {
            "model": model,
            "messages": messages,
            "temperature": llm.temperature,
            "tools": tools,
        }

        headers = {}
        if llm.api_key and llm.api_key != "ollama":
            headers["Authorization"] = f"Bearer {llm.api_key}"

        url = f"{llm.base_url}/chat/completions"

        try:
            async with session.post(url, json=body, headers=headers) as resp:
                if resp.status != 200:
                    err = await resp.text()
                    # If tools not supported, fall back to no-tools generation
                    if resp.status == 400 and "tool" in err.lower():
                        logger.info("Model doesn't support native tools, falling back to prompt-based")
                        return await _fallback_tool_loop(
                            llm, prompt, system, tools, executor,
                            max_tool_rounds, task_hint, progress,
                        )
                    raise RuntimeError(f"LLM error {resp.status}: {err[:500]}")
                data = await resp.json()
        except Exception as e:
            if "tool" in str(e).lower() or round_num == 0:
                return await _fallback_tool_loop(
                    llm, prompt, system, tools, executor,
                    max_tool_rounds, task_hint, progress,
                )
            raise

        choice = data["choices"][0]
        message = choice["message"]

        # Check for tool calls
        tool_calls = message.get("tool_calls", [])
        if not tool_calls:
            # No tool calls — this is the final response
            return message.get("content", "")

        # Execute tool calls
        messages.append(message)  # Add assistant message with tool calls

        for tc in tool_calls:
            fn = tc["function"]
            tool_name = fn["name"]
            try:
                tool_args = json.loads(fn["arguments"]) if isinstance(fn["arguments"], str) else fn["arguments"]
            except json.JSONDecodeError:
                tool_args = {}

            progress(f"    [TOOL] {tool_name}({json.dumps(tool_args)[:100]})")
            result = await executor.execute(tool_name, tool_args)

            messages.append({
                "role": "tool",
                "tool_call_id": tc.get("id", f"call_{round_num}"),
                "content": result,
            })

    # Max rounds reached — get final response without tools
    body_final = {
        "model": model,
        "messages": messages + [{"role": "user", "content": "Please provide your final response now, incorporating all tool results."}],
        "temperature": llm.temperature,
    }
    async with session.post(url, json=body_final, headers=headers) as resp:
        data = await resp.json()
    return data["choices"][0]["message"]["content"]


async def _fallback_tool_loop(
    llm, prompt, system, tools, executor,
    max_rounds, task_hint, progress,
) -> str:
    """Fallback for models without native function calling.

    Injects tool descriptions into the system prompt and parses
    tool calls from the text output using a simple format.
    """
    tool_desc = "\n\n".join(
        f"**{t['function']['name']}**: {t['function']['description']}\n"
        f"Parameters: {json.dumps(t['function']['parameters']['properties'], indent=2)}"
        for t in tools
    )

    augmented_system = (
        f"{system}\n\n"
        f"## Available Tools\n\n{tool_desc}\n\n"
        f"To use a tool, write EXACTLY this format on its own line:\n"
        f"TOOL_CALL: tool_name({{\"param\": \"value\"}})\n\n"
        f"After using a tool, wait for the result before continuing.\n"
        f"When you have enough information, write your final response without any TOOL_CALL."
    )

    accumulated = prompt

    for round_num in range(max_rounds):
        response = await llm.generate(accumulated, system=augmented_system, task_hint=task_hint)

        # Parse tool calls from response
        tool_match = re.search(r"TOOL_CALL:\s*(\w+)\((\{.*?\})\)", response, re.DOTALL)
        if not tool_match:
            # No tool call — final response
            return response

        tool_name = tool_match.group(1)
        try:
            tool_args = json.loads(tool_match.group(2))
        except json.JSONDecodeError:
            return response  # Bad JSON, just return what we have

        progress(f"    [TOOL-fallback] {tool_name}({json.dumps(tool_args)[:100]})")
        result = await executor.execute(tool_name, tool_args)

        # Append tool result and continue
        text_before_tool = response[:tool_match.start()].strip()
        accumulated = (
            f"{accumulated}\n\nAssistant: {text_before_tool}\n"
            f"[Tool result for {tool_name}]:\n{result}\n\n"
            f"Continue your analysis. Use another tool if needed, "
            f"or provide your final response."
        )

    # Max rounds — get final answer
    return await llm.generate(
        accumulated + "\n\nProvide your final response now.",
        system=augmented_system,
        task_hint=task_hint,
    )
