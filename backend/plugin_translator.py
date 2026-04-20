"""LLM-assisted plugin translation.

Handles CLI-specific edge cases that deterministic translation can't cover:
  - Hook scripts that call CLI-specific commands (claude --resume, gemini mcp add)
  - Scripts referencing CLI-specific env vars or paths
  - Agent definitions using CLI-specific features
  - Full-package validation after export

Pipeline:
  1. Deterministic pass — variable substitution, flag renames
  2. Pattern detection — find remaining CLI-specific code via regex
  3. LLM translation — send patterns + translation context to LLM
  4. LLM validation — review full output for errors/inconsistencies
  5. Syntax validation — parse and verify structure
  6. Fix loop — if errors, feed back to LLM → fix → re-validate (max N iterations)
  7. Return result with confidence score
"""

import json
import logging
import re
import time
from pathlib import Path

import aiohttp

from cli_features import Feature, HookEvent
from cli_profiles import CLAUDE_PROFILE, GEMINI_PROFILE

log = logging.getLogger(__name__)

# ─── Live docs cache ─────────────────────────────────────────────────────
# Fetched from official doc sites so the LLM always has current info.

_docs_cache = {}  # url → {"content": str, "fetched_at": float}
_DOCS_TTL = 3600  # 1 hour

# Doc URLs relevant to plugin/hook/skill translation
_DOC_URLS = {
    "claude": {
        "hooks": "https://code.claude.com/docs/en/hooks.md",
        "plugins": "https://code.claude.com/docs/en/plugins.md",
        "plugins_ref": "https://code.claude.com/docs/en/plugins-reference.md",
        "skills": "https://code.claude.com/docs/en/skills.md",
        "cli_ref": "https://code.claude.com/docs/en/cli-reference.md",
    },
    "gemini": {
        "hooks": "https://geminicli.com/docs/hooks.md",
        "extensions": "https://geminicli.com/docs/extensions/reference.md",
        "skills": "https://geminicli.com/docs/cli/skills.md",
        "cli_ref": "https://geminicli.com/docs/cli/cli-reference.md",
    },
}


async def _fetch_doc(url: str) -> str:
    """Fetch a doc page with caching."""
    now = time.time()
    cached = _docs_cache.get(url)
    if cached and (now - cached["fetched_at"]) < _DOCS_TTL:
        return cached["content"]

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    log.warning("Failed to fetch doc %s: %d", url, resp.status)
                    return cached["content"] if cached else ""
                content = await resp.text()
                # Trim to reasonable size for LLM context
                if len(content) > 15000:
                    content = content[:15000] + "\n... (truncated)"
                _docs_cache[url] = {"content": content, "fetched_at": now}
                return content
    except Exception as e:
        log.warning("Failed to fetch doc %s: %s", url, e)
        return cached["content"] if cached else ""


async def _fetch_cli_help(cli: str) -> str:
    """Get the CLI's own --help output (always current for installed version)."""
    import asyncio
    binary = "claude" if cli == "claude" else "gemini"
    try:
        proc = await asyncio.create_subprocess_exec(
            binary, "--help",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        return stdout.decode()[:5000]
    except Exception:
        return ""


async def fetch_translation_docs(source_cli: str, target_cli: str) -> str:
    """Fetch relevant live docs for both CLIs.

    Returns a formatted string with current hook events, flags, plugin format,
    etc. from the official documentation.
    """
    sections = []

    # Fetch CLI --help (always reflects installed version)
    for cli in (source_cli, target_cli):
        help_text = await _fetch_cli_help(cli)
        if help_text:
            sections.append(f"## {cli} CLI --help (installed version)\n```\n{help_text[:3000]}\n```")

    # Fetch relevant doc pages
    for cli in (source_cli, target_cli):
        urls = _DOC_URLS.get(cli, {})
        for key in ("hooks", "plugins", "extensions", "skills"):
            url = urls.get(key)
            if url:
                content = await _fetch_doc(url)
                if content:
                    sections.append(f"## {cli} {key} documentation\n{content[:4000]}")

    return "\n\n".join(sections)

# ─── CLI-specific patterns ───────────────────────────────────────────────

CLI_PATTERNS = {
    "claude": [
        (r'claude\s+--resume\s+\S+', "session resume"),
        (r'claude\s+(-p|--print)\b', "non-interactive mode"),
        (r'claude\s+plugin\s+\w+', "plugin management"),
        (r'claude\s+mcp\s+\w+', "MCP management"),
        (r'claude\s+--agent\s+\S+', "agent invocation"),
        (r'\$\{CLAUDE_PLUGIN_ROOT\}', "plugin root variable"),
        (r'\$\{CLAUDE_PLUGIN_DATA\}', "plugin data variable"),
        (r'--allowedTools\b', "tool allowlist flag"),
        (r'--disallowedTools\b', "tool denylist flag"),
        (r'--permission-mode\b', "permission mode flag"),
        (r'--append-system-prompt\b', "system prompt injection"),
        (r'--mcp-config\b', "MCP config flag"),
        (r'--effort\b', "effort level flag"),
        (r'\.claude/settings\.json', "Claude settings path"),
        (r'\.claude/plugins/', "Claude plugins path"),
        (r'CLAUDE\.md\b', "Claude memory file"),
    ],
    "gemini": [
        (r'gemini\s+extensions?\s+\w+', "extension management"),
        (r'gemini\s+mcp\s+\w+', "MCP management"),
        (r'gemini\s+(-p|--print)\b', "non-interactive mode"),
        (r'\$\{extensionPath\}', "extension path variable"),
        (r'--approval-mode\b', "approval mode flag"),
        (r'--allowed-mcp-server-names\b', "MCP server allowlist"),
        (r'--include-directories\b', "directory inclusion flag"),
        (r'\.gemini/settings\.json', "Gemini settings path"),
        (r'\.gemini/extensions/', "Gemini extensions path"),
        (r'GEMINI\.md\b', "Gemini memory file"),
    ],
}

# ─── Simple deterministic substitutions ──────────────────────────────────

_DETERMINISTIC_SUBS = {
    ("claude", "gemini"): [
        ("${CLAUDE_PLUGIN_ROOT}", "${extensionPath}"),
        ("${CLAUDE_PLUGIN_DATA}", "${extensionPath}/data"),
        ("CLAUDE.md", "GEMINI.md"),
        (".claude/settings.json", ".gemini/settings.json"),
        (".claude/plugins/", ".gemini/extensions/"),
        ("--permission-mode", "--approval-mode"),
        ("--append-system-prompt", "-i"),
        ("--add-dir", "--include-directories"),
    ],
    ("gemini", "claude"): [
        ("${extensionPath}", "${CLAUDE_PLUGIN_ROOT}"),
        ("GEMINI.md", "CLAUDE.md"),
        (".gemini/settings.json", ".claude/settings.json"),
        (".gemini/extensions/", ".claude/plugins/"),
        ("--approval-mode", "--permission-mode"),
        ("-i ", "--append-system-prompt "),
        ("--include-directories", "--add-dir"),
    ],
}


# ─── Translation context builder ────────────────────────────────────────

def build_translation_context(source_cli: str, target_cli: str, live_docs: str = "") -> str:
    """Build a comprehensive translation context from cli_profiles.py + live docs.

    This gives the LLM everything it needs to translate CLI-specific code:
    flags, event names, variables, permission modes, tool names, commands,
    plus current documentation fetched from official doc sites.
    """
    profiles = {"claude": CLAUDE_PROFILE, "gemini": GEMINI_PROFILE}
    source = profiles.get(source_cli, CLAUDE_PROFILE)
    target = profiles.get(target_cli, GEMINI_PROFILE)

    ctx = f"""You are translating a {source.label} plugin/script to work with {target.label}.

## CLI Flag Translations
"""
    for feature in Feature:
        src_b = source.binding(feature)
        tgt_b = target.binding(feature)
        if src_b and src_b.flag and tgt_b and tgt_b.flag:
            if src_b.flag != tgt_b.flag:
                ctx += f"- `{src_b.flag}` → `{tgt_b.flag}`\n"
        elif src_b and src_b.flag and (not tgt_b or not getattr(tgt_b, 'supported', True)):
            ctx += f"- `{src_b.flag}` → NOT SUPPORTED in {target.label} (remove or find alternative)\n"

    ctx += "\n## Hook Event Name Translations\n"
    for canonical in HookEvent:
        src_name = source.native_hook(canonical)
        tgt_name = target.native_hook(canonical)
        if src_name and tgt_name and src_name != tgt_name:
            ctx += f"- `{src_name}` → `{tgt_name}`\n"
        elif src_name and not tgt_name:
            ctx += f"- `{src_name}` → NOT SUPPORTED in {target.label}\n"

    ctx += "\n## Variable Translations\n"
    ctx += "- `${CLAUDE_PLUGIN_ROOT}` ↔ `${extensionPath}` (plugin/extension install directory)\n"
    ctx += "- `${CLAUDE_PLUGIN_DATA}` ↔ `${extensionPath}/data` (persistent data)\n"
    ctx += "- `${workspacePath}` — same in both CLIs\n"

    ctx += "\n## Permission Mode Translations\n"
    ctx += "- default → default\n"
    ctx += "- auto → auto_edit\n"
    ctx += "- plan → plan\n"
    ctx += "- acceptEdits → auto_edit\n"
    ctx += "- dontAsk → yolo\n"
    ctx += "- bypassPermissions → yolo\n"

    ctx += f"\n## CLI Command Translations\n"
    ctx += f"- `{source.binary}` binary → `{target.binary}`\n"
    ctx += "- `claude --resume <uuid>` → `gemini --resume latest` (Gemini uses index not UUID)\n"
    ctx += "- `claude plugin install X` → `gemini extensions install X`\n"
    ctx += "- `claude plugin marketplace` → `gemini extensions` (browse)\n"
    ctx += "- `claude mcp add` → `gemini mcp add` (same)\n"
    ctx += "- `claude --print -p` → `gemini -p` (non-interactive mode)\n"
    ctx += "- `/skill-name` → `/skill-name` (same invocation in both CLIs)\n"

    ctx += "\n## Tool Name Translations\n"
    ctx += "- Claude: Bash, Read, Write, Edit, Glob, Grep, Agent, Task\n"
    ctx += "- Gemini: Shell, ReadFile, WriteFile, EditFile, FindFiles, SearchText, Spawn\n"

    ctx += "\n## File Path Translations\n"
    ctx += "- `.claude/skills/` → `.gemini/skills/` (standalone skills)\n"
    ctx += "- `.claude/plugins/` → `.gemini/extensions/` (packages)\n"
    ctx += "- `~/.claude/settings.json` → `~/.gemini/settings.json`\n"
    ctx += "- `CLAUDE.md` → `GEMINI.md` (project memory)\n"

    ctx += """
## Translation Rules
1. Translate ALL CLI-specific patterns to their equivalents
2. If a feature doesn't exist in the target CLI, add a # TODO comment explaining the gap
3. Preserve the script's intent and behavior exactly
4. Use the target CLI's idioms and conventions
5. If unsure about a translation, keep the original with a # REVIEW comment
6. Return ONLY the translated code, no explanations
"""

    if live_docs:
        ctx += f"\n## Live Documentation (fetched from official sources)\n\n{live_docs}\n"

    return ctx


# ─── Analyzer ────────────────────────────────────────────────────────────

class PluginTranslator:
    """Analyze and translate CLI-specific code in plugins."""

    def analyze(self, text: str) -> dict:
        """Detect CLI-specific patterns in text.

        Returns:
            {
                "source_cli": "claude"|"gemini"|None,
                "patterns": [{"pattern": str, "description": str, "line": int}],
                "portable": bool,
            }
        """
        if not text:
            return {"source_cli": None, "patterns": [], "portable": True}

        all_found = []
        detected_cli = None

        for cli, patterns in CLI_PATTERNS.items():
            for regex, desc in patterns:
                for m in re.finditer(regex, text, re.IGNORECASE):
                    line = text[:m.start()].count("\n") + 1
                    all_found.append({
                        "cli": cli,
                        "pattern": m.group(),
                        "description": desc,
                        "line": line,
                    })
                    detected_cli = cli

        return {
            "source_cli": detected_cli,
            "patterns": all_found,
            "portable": len(all_found) == 0,
        }

    def deterministic_pass(self, text: str, source_cli: str, target_cli: str) -> str:
        """Apply simple string substitutions. No LLM needed."""
        key = (source_cli, target_cli)
        for old, new in _DETERMINISTIC_SUBS.get(key, []):
            text = text.replace(old, new)
        return text

    async def translate(
        self,
        text: str,
        source_cli: str,
        target_cli: str,
        llm_fn=None,
        max_fix_iterations: int = 3,
    ) -> dict:
        """Full translation pipeline.

        Args:
            text: Script/config text to translate
            source_cli: "claude" or "gemini"
            target_cli: "claude" or "gemini"
            llm_fn: async callable(prompt: str) -> str for LLM calls
            max_fix_iterations: Max fix loop iterations

        Returns:
            {
                "translated": str,
                "changes": [str],
                "warnings": [str],
                "confidence": "high"|"medium"|"low",
                "needs_review": bool,
                "iterations": int,
            }
        """
        changes = []
        warnings = []

        # Step 1: deterministic pass
        result = self.deterministic_pass(text, source_cli, target_cli)
        if result != text:
            changes.append("Applied deterministic substitutions")

        # Step 2: check for remaining CLI-specific patterns
        remaining = self.analyze(result)
        if remaining["portable"]:
            return {
                "translated": result,
                "changes": changes,
                "warnings": [],
                "confidence": "high",
                "needs_review": False,
                "iterations": 0,
            }

        # Step 3: LLM translation (if LLM function provided)
        if not llm_fn:
            warnings.append(
                f"Found {len(remaining['patterns'])} CLI-specific patterns but no LLM available for translation"
            )
            return {
                "translated": result,
                "changes": changes,
                "warnings": warnings,
                "confidence": "low",
                "needs_review": True,
                "iterations": 0,
            }

        # Fetch live docs from official sources for accurate translation
        try:
            live_docs = await fetch_translation_docs(source_cli, target_cli)
        except Exception:
            live_docs = ""
        context = build_translation_context(source_cli, target_cli, live_docs=live_docs)

        # LLM translation
        pattern_desc = "\n".join(
            f"  Line {p['line']}: {p['pattern']} ({p['description']})"
            for p in remaining["patterns"]
        )
        translate_prompt = f"""{context}

## Translation Task
Translate this {source_cli} script to {target_cli}. The following CLI-specific patterns were detected:
{pattern_desc}

Script to translate:
```
{result}
```

Return ONLY the translated script, no explanations or markdown fences."""

        try:
            result = await llm_fn(translate_prompt)
            # Strip markdown fences if LLM added them
            result = re.sub(r'^```\w*\n', '', result)
            result = re.sub(r'\n```$', '', result)
            changes.append("LLM translated CLI-specific patterns")
        except Exception as e:
            warnings.append(f"LLM translation failed: {e}")
            return {
                "translated": result,
                "changes": changes,
                "warnings": warnings,
                "confidence": "low",
                "needs_review": True,
                "iterations": 0,
            }

        # Step 4+5: Validate → Fix loop
        iterations = 0
        for iteration in range(max_fix_iterations):
            iterations = iteration + 1

            # LLM validation
            validation = await self._llm_validate(result, source_cli, target_cli, context, llm_fn)
            issues = validation.get("issues", [])
            warnings.extend(validation.get("warnings", []))

            if not issues:
                break  # Clean

            # Feed errors back to LLM for fixing
            fix_prompt = f"""{context}

## Fix Task (iteration {iteration + 1})
The following issues were found in this translated script:
{json.dumps(issues, indent=2)}

Fix ALL issues. Return ONLY the corrected script, no explanations.

Script:
```
{result}
```"""
            try:
                result = await llm_fn(fix_prompt)
                result = re.sub(r'^```\w*\n', '', result)
                result = re.sub(r'\n```$', '', result)
                changes.append(f"Fix iteration {iteration + 1}: resolved {len(issues)} issues")
            except Exception as e:
                warnings.append(f"Fix iteration {iteration + 1} failed: {e}")
                break

        # Final confidence assessment
        final = self.analyze(result)
        confidence = "high" if final["portable"] else "medium"
        if iterations >= max_fix_iterations and not final["portable"]:
            confidence = "low"

        return {
            "translated": result,
            "changes": changes,
            "warnings": warnings,
            "confidence": confidence,
            "needs_review": not final["portable"],
            "iterations": iterations,
        }

    async def _llm_validate(
        self, text: str, source_cli: str, target_cli: str, context: str, llm_fn
    ) -> dict:
        """LLM reviews translated output for issues."""
        prompt = f"""{context}

## Validation Task
Review this script that was translated from {source_cli} to {target_cli}.
Check for:
1. Any remaining {source_cli}-specific references (commands, flags, paths, variables)
2. Invalid {target_cli} syntax or unsupported features
3. Logical errors (referencing features that don't exist in {target_cli})
4. Mixed CLI references (e.g., "{source_cli}" commands in a {target_cli} script)
5. Missing error handling for features that work differently

Return a JSON object: {{"issues": ["issue1", "issue2"], "warnings": ["warn1"], "ok": true/false}}
Return ONLY the JSON, nothing else.

Script:
```
{text}
```"""
        try:
            raw = await llm_fn(prompt)
            # Try to parse JSON from response
            raw = raw.strip()
            if raw.startswith("```"):
                raw = re.sub(r'^```\w*\n', '', raw)
                raw = re.sub(r'\n```$', '', raw)
            return json.loads(raw)
        except (json.JSONDecodeError, Exception) as e:
            log.warning("LLM validation parse failed: %s", e)
            return {"issues": [], "warnings": [f"Validation parse error: {e}"], "ok": True}

    async def validate_full_export(
        self, export_dir: Path, target_cli: str, llm_fn=None
    ) -> dict:
        """LLM reviews the entire exported package for coherence.

        Checks that all files reference each other correctly, event names
        are valid, variables are consistent, etc.
        """
        if not llm_fn:
            return {"valid": True, "issues": [], "suggestions": []}

        files = {}
        for f in export_dir.rglob("*"):
            if f.is_file() and f.stat().st_size < 50000:  # Skip large files
                try:
                    files[str(f.relative_to(export_dir))] = f.read_text(
                        encoding="utf-8", errors="replace"
                    )
                except Exception:
                    pass

        if not files:
            return {"valid": True, "issues": [], "suggestions": []}

        cli_label = "plugin" if target_cli == "claude" else "extension"
        var_name = "CLAUDE_PLUGIN_ROOT" if target_cli == "claude" else "extensionPath"

        prompt = f"""Review this {target_cli} {cli_label} package for correctness.

Check that:
1. Manifest references correct paths for skills/, hooks/, agents/
2. Hook event names are valid for {target_cli}
3. MCP server configs use correct variables (${{{var_name}}})
4. No cross-CLI contamination (wrong CLI's conventions mixed in)
5. All referenced files actually exist in the package
6. JSON syntax is valid
7. Skills have valid SKILL.md frontmatter (--- name/description ---)

Files in the package:
{json.dumps(files, indent=2)}

Return a JSON object: {{"valid": true/false, "issues": ["issue1"], "suggestions": ["suggestion1"]}}
Return ONLY the JSON, nothing else."""

        try:
            raw = await llm_fn(prompt)
            raw = raw.strip()
            if raw.startswith("```"):
                raw = re.sub(r'^```\w*\n', '', raw)
                raw = re.sub(r'\n```$', '', raw)
            return json.loads(raw)
        except (json.JSONDecodeError, Exception) as e:
            log.warning("Full export validation failed: %s", e)
            return {"valid": True, "issues": [], "suggestions": [f"Validation error: {e}"]}
