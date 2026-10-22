"""IVE-owned default metadata shared by dev and fresh-install bootstraps.

These are source-defined templates, never exported application rows. Product
metadata is contributed only by explicitly installed owners.
"""
import json
import uuid
import extension_host
from config import (
    DEFAULT_REGISTRIES, MCP_SERVER_PATH, WORKER_MCP_SERVER_PATH,
    DEEP_RESEARCH_MCP_PATH, DEEP_RESEARCH_SKILL_PATH, DOCUMENTOR_MCP_SERVER_PATH,
    BRAINSTORMER_MCP_SERVER_PATH,
)


SEED_QUICKACTION_PROMPTS = [
    {"id": "qa-review",   "name": "Review",   "content": "Review the recent code changes for issues and improvements", "icon": "file-code",  "color": "text-blue-400",   "order": 0},
    {"id": "qa-commit",   "name": "Commit",   "content": "Create a git commit for the current changes with a good human-readable message. Do not include IVE session, ticket, or internal attribution metadata.", "icon": "git-branch", "color": "text-green-400",  "order": 1},
    {"id": "qa-security", "name": "Security", "content": "Do a security review of the recent changes", "icon": "shield",     "color": "text-red-400",    "order": 2},
    {"id": "qa-test",     "name": "Test",     "content": "Run the tests and fix any failures", "icon": "test-tube",  "color": "text-yellow-400", "order": 3},
    {"id": "qa-fix",      "name": "Fix",      "content": "Look at the recent changes and fix any bugs or issues", "icon": "bug",        "color": "text-orange-400", "order": 4},
    {"id": "qa-explain",  "name": "Explain",  "content": "Explain the code in this project", "icon": "book-open",  "color": "text-cyan-400",   "order": 5},
    {"id": "qa-suggest",  "name": "Suggest",  "content": "Suggest improvements to the recent changes", "icon": "lightbulb",  "color": "text-amber-400",  "order": 6},
]

SEED_MCP_SERVERS = [
    {
        "id": "builtin-commander",
        "name": "Commander",
        "server_name": "commander",
        "description": "IVE orchestration — manage worker sessions, tasks, research",
        "server_type": "stdio",
        "command": "python3",
        "args": [str(MCP_SERVER_PATH)],
        "env": {
            "COMMANDER_API_URL": "http://{host}:{port}",
            "COMMANDER_WORKSPACE_ID": "{workspace_id}",
        },
        "auto_approve": 1,
        "default_enabled": 1,
        "is_builtin": 1,
    },
    {
        "id": "builtin-worker-board",
        "name": "Worker Board",
        "server_name": "worker-board",
        "description": "Lets workers see and update their assigned tasks on the feature board",
        "server_type": "stdio",
        "command": "python3",
        "args": [str(WORKER_MCP_SERVER_PATH)],
        "env": {
            "COMMANDER_API_URL": "http://{host}:{port}",
            "WORKER_SESSION_ID": "{session_id}",
            "WORKER_WORKSPACE_ID": "{workspace_id}",
            "WORKER_SESSION_TYPE": "{session_type}",
            # W2W flags plumbed at PTY spawn so the worker MCP doesn't have
            # to API-call the commander server at startup. Removes the
            # silent-fail mode where a startup race left zero W2W tools
            # registered but the prompt still referenced them.
            "WORKER_W2W_COMMS": "{w2w_comms}",
            "WORKER_W2W_CONTEXT": "{w2w_context}",
            "WORKER_W2W_COORDINATION": "{w2w_coordination}",
            "IVE_ALLOY_ENABLED": "{alloy_enabled}",
        },
        "auto_approve": 1,
        "default_enabled": 0,
        "is_builtin": 1,
    },
    {
        "id": "builtin-brainstormer",
        "name": "Brainstormer",
        "server_name": "brainstormer",
        "description": (
            "Ask the per-person Product Intake Brainstormer questions and read its "
            "intake/backlog/research/observatory state, and leave durable marks on "
            "the architecture canvas (annotate/highlight). READ-ONLY ON WORK — it "
            "answers and annotates, and is never a dispatch target."
        ),
        "server_type": "stdio",
        "command": "python3",
        "args": [str(BRAINSTORMER_MCP_SERVER_PATH)],
        "env": {
            "COMMANDER_API_URL": "http://{host}:{port}",
            "COMMANDER_WORKSPACE_ID": "{workspace_id}",
            # The session this MCP is attached to (e.g. a Commander). Lets the
            # backend resolve the owner from the caller's auth context and apply
            # per-session read scoping, same as the worker/commander servers.
            "BRAINSTORMER_CALLER_SESSION_ID": "{session_id}",
            "BRAINSTORMER_CALLER_SESSION_TYPE": "{session_type}",
            # Per-person owner identity (kind+id). Unlike the workspace-singular
            # Commander, the Brainstormer is per-operator, so the stdio server
            # must know WHOSE Brainstormer to resolve. These resolve from the
            # attached session's owner_actor_* columns; empty kind => owner.
            "BRAINSTORMER_OWNER_KIND": "{owner_actor_kind}",
            "BRAINSTORMER_OWNER_ID": "{owner_actor_id}",
        },
        "auto_approve": 1,
        "default_enabled": 0,
        "is_builtin": 1,
    },
    {
        "id": "builtin-deep-research",
        "name": "Deep Research",
        "server_name": "deep-research",
        "description": "Multi-engine search, extract, and gather tools for deep research — searches Brave, DuckDuckGo, arXiv, Semantic Scholar, GitHub, SearXNG",
        "server_type": "stdio",
        "command": "python3",
        "args": [str(DEEP_RESEARCH_MCP_PATH)],
        "env": {
            "COMMANDER_API_URL": "http://{host}:{port}",
            "COMMANDER_WORKSPACE_ID": "{workspace_id}",
        },
        "auto_approve": 1,
        "default_enabled": 0,
        "is_builtin": 1,
    },
    {
        "id": "builtin-zai-vision",
        "name": "Z.AI Vision",
        "server_name": "zai-mcp-server",
        "description": "Z.AI GLM vision tools for image, screenshot, video, diagram, and UI analysis",
        "server_type": "stdio",
        "command": "npx",
        "args": ["-y", "@z_ai/mcp-server@latest"],
        "env": {
            "Z_AI_API_KEY": "{z_ai_api_key}",
            "Z_AI_MODE": "ZAI",
        },
        "auto_approve": 0,
        "default_enabled": 0,
        "is_builtin": 1,
    },
    {
        "id": "builtin-zai-web-search",
        "name": "Z.AI Web Search",
        "server_name": "web-search-prime",
        "description": "Z.AI remote web search MCP for current web information",
        "server_type": "http",
        "command": "https://api.z.ai/api/mcp/web_search_prime/mcp",
        "args": [],
        "env": {
            "Authorization": "Bearer {z_ai_api_key}",
        },
        "auto_approve": 0,
        "default_enabled": 0,
        "is_builtin": 1,
    },
    {
        "id": "builtin-zai-web-reader",
        "name": "Z.AI Web Reader",
        "server_name": "web-reader",
        "description": "Z.AI remote web reader MCP for fetching and extracting webpage content",
        "server_type": "http",
        "command": "https://api.z.ai/api/mcp/web_reader/mcp",
        "args": [],
        "env": {
            "Authorization": "Bearer {z_ai_api_key}",
        },
        "auto_approve": 0,
        "default_enabled": 0,
        "is_builtin": 1,
    },
    {
        "id": "builtin-zai-zread",
        "name": "Z.AI Zread",
        "server_name": "zread",
        "description": "Z.AI remote Zread MCP for open-source repository docs, structure, and file reading",
        "server_type": "http",
        "command": "https://api.z.ai/api/mcp/zread/mcp",
        "args": [],
        "env": {
            "Authorization": "Bearer {z_ai_api_key}",
        },
        "auto_approve": 0,
        "default_enabled": 0,
        "is_builtin": 1,
    },
    {
        "id": "builtin-playwright",
        "name": "Playwright",
        "server_name": "playwright",
        "description": "Browser automation — navigate, click, fill forms, screenshot, and scrape web pages",
        "server_type": "stdio",
        "command": "npx",
        # Default to --headless so the Tester doesn't pop a browser window and
        # steal focus on every run. Sessions can opt into a visible browser via
        # the "Show browser" checkbox in the Tester picker (tag: tester_headed),
        # which strips --headless at PTY start.
        "args": ["-y", "@playwright/mcp@latest", "--headless"],
        "env": {},
        "auto_approve": 0,
        "is_builtin": 0,
    },
    {
        "id": "builtin-documentor",
        "name": "Documentor",
        "server_name": "documentor",
        "description": "Documentation generation — screenshot features, record GIF workflows, scaffold and build a VitePress docs site",
        "server_type": "stdio",
        "command": "python3",
        "args": [str(DOCUMENTOR_MCP_SERVER_PATH)],
        "env": {
            "COMMANDER_API_URL": "http://{host}:{port}",
            "COMMANDER_WORKSPACE_ID": "{workspace_id}",
            "COMMANDER_WORKSPACE_PATH": "{workspace_path}",
            "WORKER_SESSION_ID": "{session_id}",
        },
        "auto_approve": 1,
        "default_enabled": 0,
        "is_builtin": 1,
    },
]

_CORE_SEED_MCP_SERVERS = SEED_MCP_SERVERS


def _seed_mcp_servers():
    result = [dict(item) for item in _CORE_SEED_MCP_SERVERS]
    by_id = {item["id"]: item for item in result}
    replaced = set()
    for owner in extension_host.installed_extensions():
        relative = "backend/database.py"
        if not (extension_host.extension_path(owner["id"]) / relative).is_file():
            continue
        provider = extension_host.load_backend_module(owner["id"], relative)
        for key, description in getattr(provider, "MCP_SEED_DESCRIPTIONS", {}).items():
            if key not in by_id or key in replaced or not isinstance(description, str):
                raise ValueError("Invalid or conflicting MCP seed description contribution")
            by_id[key]["description"] = description
            replaced.add(key)
    return result


SEED_MCP_SERVERS = _seed_mcp_servers()


def _load_deep_research_guideline() -> str:
    """Load the deep research methodology guideline from the plugin SKILL.md."""
    try:
        content = DEEP_RESEARCH_SKILL_PATH.read_text(encoding="utf-8")
        # Strip YAML frontmatter
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                content = parts[2].strip()
        return content
    except FileNotFoundError:
        return "Deep Research Methodology guideline not found. Install the deep-research plugin."


SEED_GUIDELINES = [
    {
        "id": "builtin-deep-research",
        "name": "Deep Research Methodology",
        "content": _load_deep_research_guideline(),
        "is_default": 0,
    },
    {
        "id": "builtin-thorough-verification",
        "name": "Thorough Verification",
        "content": """## Thorough Verification Protocol

After completing any code changes, you MUST perform tiered verification based on change size:

### Small changes (1-3 files, <50 lines)
- Run relevant tests for the changed code
- Verify the build still passes

### Medium changes (4-10 files, 50-200 lines)
- Run the full test suite — show complete output
- Run the build — show output
- Run the linter — show output
- Manually verify the feature works as intended (describe what you checked)

### Large changes (>10 files or >200 lines, security-related, or API changes)
- All of the above, plus:
- Check for regressions in related functionality
- Verify edge cases explicitly
- Review your own diff for accidental changes, debug leftovers, or TODO comments
- If security-related: check for injection, auth bypass, data exposure

### Rules
- NEVER claim something "should work" — run it and show actual output
- If a test fails, fix it and re-run ALL tests (not just the failing one)
- Show evidence: paste test output, build output, or terminal output as proof""",
    },
    {
        "id": "builtin-ralph-loop",
        "name": "Ralph Loop",
        "content": """## Ralph Mode — Persistent Execution Loop

You MUST keep working until the task is genuinely complete. Follow this loop:

1. EXECUTE: Implement the requested changes.
2. VERIFY: Run tests, build, lint — show ACTUAL output. Never say "should work".
3. FIX: If anything fails, fix the root cause and go back to step 2.
4. COMPLETE: Only when ALL checks pass with fresh evidence.

Max 20 iterations. State your phase each time (e.g., "Ralph iteration 3 — Verify").
If the same fix fails 3 times, try a fundamentally different approach.
When genuinely complete, say: "Ralph complete — all checks pass" with evidence.""",
    },
    {
        "id": "builtin-testing-agent",
        "name": "Testing Agent",
        "content": """## Testing Agent — Read-Only Verification Mode

You are a **testing agent**. Your sole purpose is to verify that features work correctly. You have access to browser automation via Playwright MCP.

### Rules
1. **NEVER modify source code files** (.js, .jsx, .ts, .tsx, .py, .go, .rs, .java, .c, .cpp, .rb, .php, .swift, .kt, .cs, etc.)
2. **NEVER modify config files** that affect application behavior (package.json scripts, webpack config, vite config, etc.)
3. You MAY create or edit:
   - Test result reports (markdown, txt)
   - Screenshots and visual evidence
   - Documentation about bugs found
   - Test plan documents
4. **Test systematically**: navigate the app, interact with UI elements, verify expected behavior, capture evidence
5. **Report clearly**: for each test, state what was tested, expected result, actual result, and pass/fail
6. If you find a bug, describe it precisely with reproduction steps — do NOT attempt to fix it

### Workflow
1. Read the task description and acceptance criteria
2. Create a test plan
3. Execute each test using Playwright (navigate, click, fill, screenshot)
4. Report results with evidence (screenshots, console output)
5. Summarize: total tests, passed, failed, with details on failures""",
    },
    {
        "id": "builtin-root-cause-first",
        "name": "Root Cause First",
        "content": """## Root Cause First — No Test Fixes, No Workarounds

When something fails (test, build, feature, behavior), your FIRST action must be tracing the actual data/control flow. Never adjust tests, add sleeps, loosen assertions, or work around the symptom.

### The Protocol

1. **TRACE, don't guess.** Read the code path that failed. Follow the data from input to output. Print intermediate values if needed. The bug is in the code, not the test.

2. **Never adjust a failing test** unless the test's expectation is provably wrong. If a test checks `X == Y` and gets `X == Z`, the question is "why does the code produce Z?" not "should the test accept Z?"

3. **Never add sleeps or retries** to make flaky behavior pass. Flakiness means a race condition or missing await — find it.

4. **Never loosen an assertion** ("check ANY message" instead of "check THE message"). The original assertion was specific for a reason. If it fails, the code is wrong.

5. **Check, don't speculate.** When you have multiple hypotheses, don't reason about which one is "most likely" — just verify them. Read the function, print the value, check the DB. Checking takes 10 seconds, speculating wastes minutes and is often wrong.

6. **Data flow over guesswork.** When confused about what a function returns, READ the function. Don't guess based on what you think it should return.

### Anti-Patterns to Avoid

- "Let me increase the timeout" → find the race condition
- "Let me make the test more resilient" → fix the code
- "Maybe there's stale data" → verify by checking, don't assume
- "Let me try a different approach" → understand why THIS approach failed first
- "It works in my head so the test must be wrong" → run it and read the output

### When the Test IS Wrong

Sometimes tests do have bugs. But prove it:
- Show that the code produces the correct output
- Show that the test's expected value is incorrect
- Fix the test AND explain why the original expectation was wrong""",
    },
    {
        "id": "builtin-documentation-agent",
        "name": "Documentation Agent",
        "content": """## Documentation Agent — Read-Only Documentation Mode

You are a **documentation agent**. Your purpose is to create comprehensive external-facing documentation for this project. You have access to browser automation (Playwright) for screenshots and GIF recording, and documentation tools for building a VitePress site.

### Rules
1. **NEVER modify source code files** — you are a documentation agent only
2. **NEVER fabricate features** — only document what you can verify exists in the codebase or UI
3. You MAY create or edit:
   - Documentation pages (markdown in docs/)
   - Screenshots and GIFs as visual evidence
   - VitePress config and theme files
   - The docs manifest for tracking coverage
4. **Explore systematically**: use get_knowledge_base() first, then screenshot features, then write docs
5. **Be thorough**: every major feature, every keyboard shortcut, every panel should be documented
6. If a feature requires specific state to screenshot (e.g., active sessions), describe it textually

### Documentation Page Template
For each feature page, follow this structure:
1. Overview — what it does (1-2 sentences)
2. Screenshot — the feature in its default and active states
3. Usage — step-by-step instructions
4. Keyboard Shortcuts — if applicable
5. GIF Demo — for multi-step workflows
6. Related Features — cross-links

### Incremental Updates
When updating existing docs, always check get_docs_manifest() first to see what's already documented.
Only update pages affected by recent changes. Don't re-screenshot unchanged UI.""",
    },
]

def _guideline_extensions():
    """Discover selected guideline providers without importing absent products."""
    import extension_host
    result = []
    for owner in extension_host.installed_extensions():
        if (extension_host.extension_path(owner["id"]) / "backend/guidelines.py").is_file():
            result.append(extension_host.load_backend_module(owner["id"], "backend/guidelines.py"))
    return result


_CORE_SEED_GUIDELINES = SEED_GUIDELINES


def _seed_guidelines():
    result = _CORE_SEED_GUIDELINES
    for provider in _guideline_extensions():
        result = provider.augment_guidelines(result)
    return result


SEED_GUIDELINES = _seed_guidelines()



async def seed_core_defaults(db):
    # Stable core research artifact identity; additive only, no old artifact or
    # user-data imports. Kept here so the protected legacy initializer is not
    # edited or replayed by the fresh source package.
    cursor = await db.execute("PRAGMA table_info(research_entries)")
    research_columns = {row[1] for row in await cursor.fetchall()}
    for column in ("artifact_run_id", "artifact_workspace_id"):
        if research_columns and column not in research_columns:
            await db.execute(f"ALTER TABLE research_entries ADD COLUMN {column} TEXT")
    # Seed built-in guidelines (INSERT OR IGNORE = only on first run)
    for g in _seed_guidelines():
        await db.execute(
            "INSERT OR IGNORE INTO guidelines (id, name, content, is_default, is_builtin) VALUES (?, ?, ?, 0, ?)",
            (g["id"], g["name"], g["content"], 1 if g["id"].startswith("builtin-") else 0),
        )
    # Backfill is_builtin for existing builtin guidelines
    await db.execute(
        "UPDATE guidelines SET is_builtin = 1 WHERE id LIKE 'builtin-%'"
    )

    # Owners may apply their additive, idempotent guideline upgrades.
    for provider in _guideline_extensions():
        await provider.upgrade_guidelines(db)

    # Seed built-in MCP servers
    for ms in SEED_MCP_SERVERS:
        await db.execute(
            """INSERT OR IGNORE INTO mcp_servers
               (id, name, server_name, description, server_type, command, args, env,
                auto_approve, default_enabled, is_builtin)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (ms["id"], ms["name"], ms["server_name"], ms["description"],
             ms["server_type"], ms["command"],
             json.dumps(ms["args"]),
             json.dumps(ms["env"]),
             ms.get("auto_approve", 0), ms.get("default_enabled", 0), ms.get("is_builtin", 0)),
        )

    # Ensure builtin-commander has default_enabled=1 (backfill for existing DBs)
    await db.execute(
        "UPDATE mcp_servers SET default_enabled = 1 WHERE id = 'builtin-commander'"
    )

    # Existing DB rows keep the script paths from the checkout that first
    # seeded them. Refresh IVE-owned Python MCP servers so Commander,
    # workers, documentor, and research sessions use this build's tools.
    for ms in SEED_MCP_SERVERS:
        if ms["id"] not in {
            "builtin-commander",
            "builtin-worker-board",
            "builtin-deep-research",
            "builtin-documentor",
        }:
            continue
        await db.execute(
            """UPDATE mcp_servers
               SET command = ?, args = ?
               WHERE id = ? AND is_builtin = 1""",
            (ms["command"], json.dumps(ms["args"]), ms["id"]),
        )

    # Backfill worker-board env (existing DBs won't pick up SEED_MCP_SERVERS
    # changes since INSERT OR IGNORE skips existing rows). Add any missing
    # keys without disturbing user customizations.
    try:
        cur = await db.execute(
            "SELECT env FROM mcp_servers WHERE id = 'builtin-worker-board'"
        )
        row = await cur.fetchone()
        if row:
            env = json.loads(row["env"] or "{}")
            changed = False
            for key, default in (
                ("WORKER_WORKSPACE_ID", "{workspace_id}"),
                ("WORKER_SESSION_TYPE", "{session_type}"),
                ("WORKER_W2W_COMMS", "{w2w_comms}"),
                ("WORKER_W2W_CONTEXT", "{w2w_context}"),
                ("WORKER_W2W_COORDINATION", "{w2w_coordination}"),
                ("IVE_ALLOY_ENABLED", "{alloy_enabled}"),
            ):
                if key not in env:
                    env[key] = default
                    changed = True
            if changed:
                await db.execute(
                    "UPDATE mcp_servers SET env = ? WHERE id = 'builtin-worker-board'",
                    (json.dumps(env),),
                )
    except Exception:
        pass

    # Backfill --headless on the Playwright MCP for existing DBs. Match by
    # @playwright/mcp package presence (not exact args) so version-pinned or
    # otherwise customized rows still get the headless default. Respect
    # users who explicitly opted out via --headed / --no-headless.
    try:
        cur = await db.execute(
            "SELECT args FROM mcp_servers WHERE id = 'builtin-playwright'"
        )
        row = await cur.fetchone()
        if row:
            args = json.loads(row["args"] or "[]")
            has_pkg = any("@playwright/mcp" in str(a) for a in args)
            already_set = any(
                str(a) in ("--headless", "--headed", "--no-headless") for a in args
            )
            if has_pkg and not already_set:
                args.append("--headless")
                await db.execute(
                    "UPDATE mcp_servers SET args = ? WHERE id = 'builtin-playwright'",
                    (json.dumps(args),),
                )
    except Exception:
        pass

    # Seed the deep-research plugin entry so it shows in the marketplace
    await db.execute(
        """INSERT OR IGNORE INTO plugins
           (id, name, version, description, author, source_format,
            categories, tags, security_tier, installed, installed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))""",
        ("builtin-deep-research", "Deep Research", "1.0.0",
         "CLI-native deep research — multi-engine search, extraction, and Research DB integration. "
         "Turns any CLI session into a deep researcher with iterative multi-angle methodology.",
         "IVE.dev", "ive",
         json.dumps(["research", "search", "knowledge"]),
         json.dumps(["deep-research", "web-search", "multi-engine", "iterative", "cross-domain"]),
         1),
    )
    await db.execute(
        """UPDATE plugins
           SET author = 'IVE.dev',
               updated_at = datetime('now')
           WHERE id = 'builtin-deep-research'
             AND COALESCE(author, '') != 'IVE.dev'"""
    )
    # Seed the plugin's guideline component
    await db.execute(
        """INSERT OR IGNORE INTO plugin_components
           (id, plugin_id, type, name, description, content, activation)
           VALUES (?, ?, 'guideline', ?, ?, ?, 'always')""",
        ("builtin-dr-methodology", "builtin-deep-research",
         "Deep Research Methodology",
         "Multi-angle iterative research with cross-domain exploration and claim verification",
         _load_deep_research_guideline()),
    )

    # Seed RTK as an optional integration card. This is a catalog entry,
    # not an installed plugin: installing/enabling RTK is an explicit user
    # action handled by the integration UI, and no startup path downloads
    # or activates the external binary.
    await db.execute(
        """INSERT OR IGNORE INTO plugins
           (id, name, version, description, author, license, source_url,
            source_format, categories, tags, security_tier,
            contains_scripts, installed, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, datetime('now'))""",
        (
            "builtin-rtk-command-optimizer",
            "RTK Command Output Optimizer",
            "0.1.0",
            "Optional Rust Token Killer integration for compacting noisy shell output. "
            "IVE owns the hooks; RTK stays disabled until explicitly configured.",
            "rtk-ai",
            "MIT",
            "https://github.com/rtk-ai/rtk",
            "integration:rtk",
            json.dumps(["developer-tools", "output", "tokens"]),
            json.dumps(["rtk", "shell", "test-output", "logs", "performance"]),
            2,
        ),
    )
    await db.execute(
        """UPDATE plugins
           SET security_tier = 2,
               updated_at = datetime('now')
           WHERE id = 'builtin-rtk-command-optimizer'
             AND security_tier != 2"""
    )

    # Seed built-in quick action prompts
    for qa in SEED_QUICKACTION_PROMPTS:
        await db.execute(
            """INSERT OR IGNORE INTO prompts
               (id, name, category, content, is_quickaction, quickaction_order, icon, color, source_type)
               VALUES (?, ?, 'Quick Action', ?, 1, ?, ?, ?, 'seed')""",
            (qa["id"], qa["name"], qa["content"], qa["order"], qa["icon"], qa["color"]),
        )
    await db.execute(
        """UPDATE prompts
           SET content = ?
           WHERE id = 'qa-commit'
             AND source_type = 'seed'""",
        (next(qa["content"] for qa in SEED_QUICKACTION_PROMPTS if qa["id"] == "qa-commit"),),
    )

    # Seed built-in plugin registries. INSERT OR IGNORE on the unique URL
    # so re-running on an existing DB is a no-op even if the user has
    # added their own registries alongside.
    for idx, reg in enumerate(DEFAULT_REGISTRIES):
        await db.execute(
            """INSERT OR IGNORE INTO plugin_registries
               (id, name, url, enabled, is_builtin, last_sync_status, order_index)
               VALUES (?, ?, ?, 1, 1, 'never', ?)""",
            (reg.get("id") or str(uuid.uuid4()), reg["name"], reg["url"], idx),
        )


async def seed_experimental_flags(db):
    # Seed experimental feature flags from the registry. INSERT OR IGNORE
    # preserves any flag the user has explicitly toggled (row already
    # present with "on" or "off"); only flags that have never been touched
    # get the registry's default_enabled value written.
    try:
        from experimental import EXPERIMENTAL_FEATURES
        for feat in EXPERIMENTAL_FEATURES.values():
            await db.execute(
                "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)",
                (feat.key, "on" if feat.default_enabled else "off"),
            )
    except Exception as exc:
        # Don't let a registry import error block server startup.
        import logging
        logging.getLogger(__name__).warning(
            "Failed to seed experimental flags: %s", exc
        )
