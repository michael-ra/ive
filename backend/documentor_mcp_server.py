"""Documentor MCP Server — tools for autonomous documentation generation.

Provides the Documentor agent with tools to:
  - Ingest Commander's internal knowledge base
  - Screenshot UI features and record GIF workflows
  - Scaffold and build a VitePress documentation site
  - Track documentation coverage via a manifest

Runs as a stdio JSON-RPC 2.0 MCP server, same pattern as mcp_server.py
and worker_mcp_server.py.  Zero external dependencies beyond stdlib +
Playwright (for screenshots/GIFs) and ffmpeg (for GIF encoding).
"""
from __future__ import annotations

import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# ── Environment ──────────────────────────────────────────────────────

API_URL = os.environ.get("COMMANDER_API_URL", "http://127.0.0.1:5111")
WORKSPACE_ID = os.environ.get("COMMANDER_WORKSPACE_ID", "")
WORKSPACE_PATH = os.environ.get("COMMANDER_WORKSPACE_PATH", "")
SESSION_ID = os.environ.get("WORKER_SESSION_ID", "")

DOCS_DIR = os.path.join(WORKSPACE_PATH, "docs") if WORKSPACE_PATH else "docs"
SCREENSHOTS_DIR = os.path.join(DOCS_DIR, "screenshots")
GIFS_DIR = os.path.join(DOCS_DIR, "gifs")
MANIFEST_PATH = os.path.join(DOCS_DIR, "docs_manifest.json")


# ── REST API helper ──────────────────────────────────────────────────

def api_call(method: str, path: str, body: dict | None = None) -> dict:
    url = f"{API_URL}/api{path}"
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"} if data else {}
    if SESSION_ID:
        headers["X-IVE-Session-Id"] = SESSION_ID
        headers["X-IVE-Session-Type"] = "documentor"
    if WORKSPACE_ID:
        headers["X-IVE-Workspace-Id"] = WORKSPACE_ID
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode() if e.fp else str(e)
        return {"error": error_body, "status": e.code}
    except Exception as e:
        return {"error": str(e)}


# ��─ Tool implementations ─────────────────────────────────────────────

def tool_get_knowledge_base(args: dict) -> str:
    """Aggregate all internal knowledge sources into a unified context."""
    parts: list[str] = []

    # 1. AGENTS.md (shared, CLI-agnostic)
    try:
        result = api_call("GET", f"/workspaces/{WORKSPACE_ID}/agents-md")
        if isinstance(result, list):
            for entry in result:
                parts.append(f"# AGENTS.md — {entry.get('path', 'unknown')}\n{entry.get('content', '')}")
        elif isinstance(result, dict) and result.get("files"):
            for entry in result["files"]:
                parts.append(f"# AGENTS.md — {entry.get('path', 'unknown')}\n{entry.get('content', '')}")
    except Exception:
        pass

    # 2. Central memory (synced hub — unified CLAUDE.md/GEMINI.md content)
    try:
        result = api_call("GET", f"/workspaces/{WORKSPACE_ID}/memory")
        if isinstance(result, dict):
            central = result.get("central_content") or result.get("content", "")
            if central:
                parts.append(f"# Central Memory (synced hub)\n{central}")
    except Exception:
        pass

    # 3. Memory entries (user/feedback/project/reference)
    try:
        result = api_call("GET", "/memory")
        if isinstance(result, list):
            by_type: dict[str, list[str]] = {}
            for entry in result:
                t = entry.get("type", "general")
                by_type.setdefault(t, []).append(
                    f"- **{entry.get('name', 'untitled')}**: {entry.get('content', '')}"
                )
            for t, entries in by_type.items():
                parts.append(f"## Memory — {t.title()}\n" + "\n".join(entries))
    except Exception:
        pass

    # 4. Workspace knowledge (ranked, categorized)
    try:
        result = api_call("GET", f"/workspaces/{WORKSPACE_ID}/memory")
        if isinstance(result, dict) and result.get("knowledge"):
            knowledge = result["knowledge"]
            parts.append("## Workspace Knowledge\n" + "\n".join(
                f"- [{k.get('category', 'general')}] {k.get('content', '')} "
                f"(confirmed: {k.get('confirmed_count', 0)})"
                for k in knowledge
            ))
    except Exception:
        pass

    # 5. CLAUDE.md from workspace root (if readable)
    claude_md_path = os.path.join(WORKSPACE_PATH, "CLAUDE.md") if WORKSPACE_PATH else None
    if claude_md_path and os.path.isfile(claude_md_path):
        try:
            with open(claude_md_path, "r") as f:
                content = f.read()
            parts.append(f"# CLAUDE.md (project documentation)\n{content[:50000]}")
        except Exception:
            pass

    if not parts:
        return "No knowledge base entries found. The workspace may not have any documented content yet."

    return "\n\n---\n\n".join(parts)


def tool_get_changes_since(args: dict) -> str:
    """Get changes since a timestamp: distills, tasks, git log, peer messages."""
    since = args.get("timestamp", "")
    if not since:
        return "Error: 'timestamp' is required (ISO 8601 format, e.g. '2025-01-15T00:00:00')"

    sections: list[str] = []

    # Session distills — check recent sessions
    try:
        result = api_call("GET", f"/sessions?workspace_id={WORKSPACE_ID}")
        if isinstance(result, list):
            recent = [s for s in result if (s.get("last_active_at") or "") >= since]
            if recent:
                summaries = []
                for s in recent[:20]:  # cap at 20
                    summaries.append(
                        f"- **{s.get('name', 'unnamed')}** ({s.get('session_type', 'worker')}) "
                        f"— last active: {s.get('last_active_at', 'unknown')}"
                    )
                sections.append("## Sessions active since " + since + "\n" + "\n".join(summaries))
    except Exception:
        pass

    # Completed tasks
    try:
        result = api_call("GET", "/tasks")
        if isinstance(result, list):
            completed = [t for t in result
                         if t.get("status") in ("done", "review")
                         and (t.get("updated_at") or "") >= since]
            if completed:
                task_lines = []
                for t in completed:
                    task_lines.append(
                        f"- **{t.get('title', 'untitled')}** (status: {t.get('status')}) "
                        f"— {t.get('result_summary', 'no summary')}"
                    )
                sections.append("## Completed tasks since " + since + "\n" + "\n".join(task_lines))
    except Exception:
        pass

    # Git log
    try:
        result = api_call("GET", f"/workspaces/{WORKSPACE_ID}/git/log")
        if isinstance(result, dict) and result.get("commits"):
            recent_commits = [c for c in result["commits"] if (c.get("date") or "") >= since]
            if recent_commits:
                commit_lines = [
                    f"- `{c.get('hash', '?')[:8]}` {c.get('message', '')} ({c.get('author', '')})"
                    for c in recent_commits[:30]
                ]
                sections.append("## Git commits since " + since + "\n" + "\n".join(commit_lines))
    except Exception:
        pass

    # Peer messages (bulletin)
    try:
        result = api_call("GET", f"/workspaces/{WORKSPACE_ID}/peer-messages?since={since}")
        if isinstance(result, list) and result:
            msg_lines = [
                f"- [{m.get('priority', 'info')}] **{m.get('topic', 'general')}**: {m.get('content', '')}"
                for m in result[:20]
            ]
            sections.append("## Peer messages since " + since + "\n" + "\n".join(msg_lines))
    except Exception:
        pass

    if not sections:
        return f"No changes found since {since}."

    return "\n\n".join(sections)


def tool_get_completed_features(args: dict) -> str:
    """Get feature board tasks that are done but not yet documented."""
    manifest = _load_manifest()
    documented_tasks = set(manifest.get("documented_tasks", []))

    try:
        result = api_call("GET", "/tasks")
        if not isinstance(result, list):
            return "Error fetching tasks"

        done = [t for t in result if t.get("status") in ("done", "review")]
        undocumented = [t for t in done if t.get("id") not in documented_tasks]

        if not undocumented:
            return "All completed features are already documented."

        lines = []
        for t in undocumented:
            lines.append(
                f"### {t.get('title', 'untitled')} (id: {t.get('id')})\n"
                f"- Status: {t.get('status')}\n"
                f"- Labels: {', '.join(t.get('labels', []) or [])}\n"
                f"- Description: {t.get('description', 'none')}\n"
                f"- Result: {t.get('result_summary', 'none')}"
            )
        return f"## {len(undocumented)} undocumented completed features\n\n" + "\n\n".join(lines)
    except Exception as e:
        return f"Error: {e}"


def tool_screenshot_page(args: dict) -> str:
    """Take a screenshot of a page using Playwright."""
    url = args.get("url", "")
    name = args.get("name", "screenshot")
    full_page = args.get("full_page", False)
    width = args.get("width", 1280)
    height = args.get("height", 800)
    dark_mode = args.get("dark_mode", True)

    if not url:
        return "Error: 'url' is required"

    os.makedirs(SCREENSHOTS_DIR, exist_ok=True)
    filepath = os.path.join(SCREENSHOTS_DIR, f"{name}.png")

    try:
        script = textwrap.dedent(f"""\
            import asyncio
            from playwright.async_api import async_playwright

            async def capture():
                async with async_playwright() as p:
                    browser = await p.chromium.launch()
                    context = await browser.new_context(
                        viewport={{"width": {width}, "height": {height}}},
                        color_scheme="{'dark' if dark_mode else 'light'}",
                    )
                    page = await context.new_page()
                    await page.goto("{url}", wait_until="networkidle", timeout=30000)
                    await page.wait_for_timeout(1000)  # settle animations
                    await page.screenshot(path="{filepath}", full_page={full_page})
                    await browser.close()

            asyncio.run(capture())
        """)

        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
            f.write(script)
            script_path = f.name

        subprocess.run(
            ["python3", script_path],
            check=True, capture_output=True, timeout=60,
        )
        os.unlink(script_path)

        rel_path = os.path.relpath(filepath, DOCS_DIR)
        return f"Screenshot saved: {filepath}\nMarkdown reference: ![{name}](./{rel_path})"
    except subprocess.TimeoutExpired:
        return "Error: Screenshot timed out after 60s"
    except subprocess.CalledProcessError as e:
        return f"Error taking screenshot: {e.stderr.decode()[:500] if e.stderr else str(e)}"
    except Exception as e:
        return f"Error: {e}"


def tool_screenshot_element(args: dict) -> str:
    """Screenshot a specific element by CSS selector."""
    url = args.get("url", "")
    selector = args.get("selector", "")
    name = args.get("name", "element")
    dark_mode = args.get("dark_mode", True)

    if not url or not selector:
        return "Error: 'url' and 'selector' are required"

    os.makedirs(SCREENSHOTS_DIR, exist_ok=True)
    filepath = os.path.join(SCREENSHOTS_DIR, f"{name}.png")

    try:
        # Escape selector for Python string embedding
        safe_selector = selector.replace("\\", "\\\\").replace('"', '\\"')
        script = textwrap.dedent(f"""\
            import asyncio
            from playwright.async_api import async_playwright

            async def capture():
                async with async_playwright() as p:
                    browser = await p.chromium.launch()
                    context = await browser.new_context(
                        viewport={{"width": 1280, "height": 800}},
                        color_scheme="{'dark' if dark_mode else 'light'}",
                    )
                    page = await context.new_page()
                    await page.goto("{url}", wait_until="networkidle", timeout=30000)
                    await page.wait_for_timeout(1000)
                    element = page.locator("{safe_selector}").first
                    await element.screenshot(path="{filepath}")
                    await browser.close()

            asyncio.run(capture())
        """)

        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
            f.write(script)
            script_path = f.name

        subprocess.run(
            ["python3", script_path],
            check=True, capture_output=True, timeout=60,
        )
        os.unlink(script_path)

        rel_path = os.path.relpath(filepath, DOCS_DIR)
        return f"Element screenshot saved: {filepath}\nMarkdown reference: ![{name}](./{rel_path})"
    except Exception as e:
        return f"Error: {e}"


def tool_record_gif(args: dict) -> str:
    """Record a multi-step browser workflow as an animated GIF."""
    url = args.get("url", "")
    steps = args.get("steps", [])
    name = args.get("name", "workflow")
    fps = args.get("fps", 4)
    width = args.get("width", 1280)
    height = args.get("height", 800)

    if not url:
        return "Error: 'url' is required"
    if not steps:
        return "Error: 'steps' array is required with at least one step"

    # Check ffmpeg availability
    if not shutil.which("ffmpeg"):
        return "Error: ffmpeg not found. Install it with: brew install ffmpeg"

    os.makedirs(GIFS_DIR, exist_ok=True)
    gif_path = os.path.join(GIFS_DIR, f"{name}.gif")

    # Build step execution code
    step_code_lines = []
    for i, step in enumerate(steps):
        action = step.get("action", "")
        if action == "click":
            sel = step.get("selector", "").replace('"', '\\"')
            step_code_lines.append(f'    await page.locator("{sel}").first.click()')
        elif action == "type":
            sel = step.get("selector", "").replace('"', '\\"')
            text = step.get("text", "").replace('"', '\\"')
            step_code_lines.append(f'    await page.locator("{sel}").first.fill("{text}")')
        elif action == "wait":
            ms = step.get("ms", 500)
            step_code_lines.append(f"    await page.wait_for_timeout({ms})")
        elif action == "scroll":
            y = step.get("y", 300)
            step_code_lines.append(f"    await page.mouse.wheel(0, {y})")
        elif action == "hover":
            sel = step.get("selector", "").replace('"', '\\"')
            step_code_lines.append(f'    await page.locator("{sel}").first.hover()')
        elif action == "press":
            key = step.get("key", "Enter").replace('"', '\\"')
            step_code_lines.append(f'    await page.keyboard.press("{key}")')
        else:
            step_code_lines.append(f"    # unknown action: {action}")

        # Capture frame after each step
        step_code_lines.append(f'    await page.wait_for_timeout(250)')
        step_code_lines.append(f'    await page.screenshot(path=f"{{frames_dir}}/frame_{i:04d}.png")')

    steps_code = "\n".join(step_code_lines)

    try:
        script = textwrap.dedent(f"""\
            import asyncio
            import os
            import tempfile
            from playwright.async_api import async_playwright

            async def record():
                frames_dir = tempfile.mkdtemp(prefix="docgif_")
                async with async_playwright() as p:
                    browser = await p.chromium.launch()
                    context = await browser.new_context(
                        viewport={{"width": {width}, "height": {height}}},
                        color_scheme="dark",
                    )
                    page = await context.new_page()
                    await page.goto("{url}", wait_until="networkidle", timeout=30000)
                    await page.wait_for_timeout(1000)

                    # Initial frame
                    await page.screenshot(path=f"{{frames_dir}}/frame_init.png")

            {textwrap.indent(steps_code, '        ')}

                    await browser.close()

                # Print frames_dir so parent process can find it
                print(frames_dir)

            asyncio.run(record())
        """)

        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
            f.write(script)
            script_path = f.name

        result = subprocess.run(
            ["python3", script_path],
            capture_output=True, text=True, timeout=120,
        )
        os.unlink(script_path)

        if result.returncode != 0:
            return f"Error recording frames: {result.stderr[:500]}"

        frames_dir = result.stdout.strip().split("\n")[-1]

        # Stitch frames to GIF with optimized palette
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-framerate", str(fps),
                "-pattern_type", "glob",
                "-i", f"{frames_dir}/frame_*.png",
                "-vf", f"fps={fps},scale={width}:-1:flags=lanczos,"
                       "split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer",
                "-loop", "0",
                gif_path,
            ],
            check=True, capture_output=True, timeout=60,
        )

        # Clean up frames
        shutil.rmtree(frames_dir, ignore_errors=True)

        size_kb = os.path.getsize(gif_path) / 1024
        rel_path = os.path.relpath(gif_path, DOCS_DIR)
        return (
            f"GIF recorded: {gif_path} ({size_kb:.0f} KB, {len(steps)} steps)\n"
            f"Markdown reference: ![{name}](./{rel_path})"
        )
    except subprocess.TimeoutExpired:
        return "Error: GIF recording timed out after 120s"
    except subprocess.CalledProcessError as e:
        return f"Error encoding GIF: {e.stderr.decode()[:500] if e.stderr else str(e)}"
    except Exception as e:
        return f"Error: {e}"



# Panel recipes: built-in knowledge of what Playwright steps each panel
# needs before the open-panel event is dispatched.  Derived from the
# frontend source (App.jsx open-panel handler, useKeyboard.js shortcuts,
# Sidebar.jsx / TopBar.jsx button wiring).
#
# Each recipe is a list of Playwright JS snippets executed in order.
# An empty list means the panel opens directly from the dashboard.
PANEL_RECIPES: dict[str, list[str]] = {
    # ── Panels that open directly (modals / overlays) ──
    "command-palette":  [],
    "feature-board":    [],
    "guidelines":       [],
    "mcp-servers":      [],
    "research":         [],
    "inbox":            [],
    "mission-control":  [],
    "agent-tree":       [],
    "marketplace":      [],
    "accounts":         [],
    "shortcuts":        [],
    "knowledge":        [],
    "peer-messages":    [],
    "docs-panel":       [],
    "prompts":          [],
    "search":           [],
    "memory":           [],
    "general-settings": [],
    "sound-settings":   [],
    "experimental":     [],
    "annotate":         [],
    "grid-templates":   [],

    # ── Session-dependent panels (need a session tab active first) ──
    # Scratchpad is per-session; click the first session link in sidebar
    "scratchpad": [
        # Expand the first workspace if collapsed, then click the first session
        "const sessions = document.querySelectorAll('[data-session-id]');"
        "if (sessions.length) sessions[0].click();",
    ],
    # Code review opens full-screen over the current workspace
    "code-review": [
        "const sessions = document.querySelectorAll('[data-session-id]');"
        "if (sessions.length) sessions[0].click();",
    ],
    # Config viewer shows config for the active session
    "config-viewer": [
        "const sessions = document.querySelectorAll('[data-session-id]');"
        "if (sessions.length) sessions[0].click();",
    ],
}


def tool_screenshot_panel(args: dict) -> str:
    """Open a UI panel/modal via JS event dispatch and screenshot it.

    Uses built-in recipes derived from the frontend source code to
    prepare the correct UI state before each screenshot — e.g. clicking
    a session tab before opening session-dependent panels like scratchpad.
    """
    panel = args.get("panel", "")
    url = args.get("url", "http://localhost:5173")
    name = args.get("name", "") or panel
    wait_ms = args.get("wait_ms", 800)

    if not panel:
        available = ", ".join(sorted(PANEL_RECIPES.keys()))
        return (
            f"Error: 'panel' is required. Available panels:\n  {available}\n\n"
            "Each panel has a built-in recipe that prepares the correct UI "
            "state (e.g. selecting a session) before taking the screenshot."
        )

    os.makedirs(SCREENSHOTS_DIR, exist_ok=True)
    filepath = os.path.join(SCREENSHOTS_DIR, f"{name}.png")

    # Escape for embedding in Python string
    safe_panel = panel.replace("\\", "\\\\").replace("'", "\\'")

    # Build preparation steps from recipe
    recipe = PANEL_RECIPES.get(panel, [])
    prep_lines = []
    for step_js in recipe:
        safe_js = step_js.replace("\\", "\\\\").replace('"', '\\"')
        prep_lines.append(
            f'                    await page.evaluate("{safe_js}")\n'
            f'                    await page.wait_for_timeout(500)'
        )
    prep_code = "\n".join(prep_lines) if prep_lines else ""

    try:
        script = textwrap.dedent(f"""\
            import asyncio
            from playwright.async_api import async_playwright

            async def capture():
                async with async_playwright() as p:
                    browser = await p.chromium.launch()
                    context = await browser.new_context(
                        viewport={{"width": 1280, "height": 800}},
                        color_scheme="dark",
                    )
                    page = await context.new_page()
                    await page.goto("{url}", wait_until="networkidle", timeout=30000)
                    await page.wait_for_timeout(1000)

{prep_code}

                    # Dispatch the open-panel custom event
                    await page.evaluate("window.dispatchEvent(new CustomEvent('open-panel', {{detail: '{safe_panel}'}}))")
                    await page.wait_for_timeout({wait_ms})

                    await page.screenshot(path="{filepath}")
                    await browser.close()

            asyncio.run(capture())
        """)

        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
            f.write(script)
            script_path = f.name

        subprocess.run(
            ["python3", script_path],
            check=True, capture_output=True, timeout=60,
        )
        os.unlink(script_path)

        rel_path = os.path.relpath(filepath, DOCS_DIR)
        return (
            f"Panel '{panel}' screenshot saved: {filepath}\n"
            f"Markdown reference: ![{name}](./{rel_path})"
        )
    except subprocess.CalledProcessError as e:
        return f"Error: {e.stderr.decode()[:500] if e.stderr else str(e)}"
    except Exception as e:
        return f"Error: {e}"


def tool_scaffold_docs(args: dict) -> str:
    """Create a VitePress documentation site skeleton."""
    project_name = args.get("project_name", "Documentation")
    tagline = args.get("tagline", "")
    description = args.get("description", "")

    os.makedirs(DOCS_DIR, exist_ok=True)
    os.makedirs(os.path.join(DOCS_DIR, ".vitepress"), exist_ok=True)
    os.makedirs(os.path.join(DOCS_DIR, "guide"), exist_ok=True)
    os.makedirs(os.path.join(DOCS_DIR, "features"), exist_ok=True)
    os.makedirs(os.path.join(DOCS_DIR, "api"), exist_ok=True)
    os.makedirs(SCREENSHOTS_DIR, exist_ok=True)
    os.makedirs(GIFS_DIR, exist_ok=True)

    # VitePress config
    config_js = textwrap.dedent(f"""\
        import {{ defineConfig }} from 'vitepress'

        export default defineConfig({{
          title: '{project_name}',
          description: '{description or tagline}',
          themeConfig: {{
            nav: [
              {{ text: 'Home', link: '/' }},
              {{ text: 'Guide', link: '/guide/getting-started' }},
              {{ text: 'Features', link: '/features/' }},
              {{ text: 'API', link: '/api/' }},
            ],
            sidebar: {{
              '/guide/': [
                {{
                  text: 'Getting Started',
                  items: [
                    {{ text: 'Installation', link: '/guide/installation' }},
                    {{ text: 'Quick Start', link: '/guide/getting-started' }},
                    {{ text: 'Configuration', link: '/guide/configuration' }},
                  ],
                }},
              ],
              '/features/': [
                {{
                  text: 'Features',
                  items: [
                    {{ text: 'Overview', link: '/features/' }},
                  ],
                }},
              ],
              '/api/': [
                {{
                  text: 'API Reference',
                  items: [
                    {{ text: 'REST API', link: '/api/' }},
                    {{ text: 'WebSocket', link: '/api/websocket' }},
                  ],
                }},
              ],
            }},
            socialLinks: [
              {{ icon: 'github', link: 'https://github.com' }},
            ],
            search: {{
              provider: 'local',
            }},
          }},
        }})
    """)
    _write_file(os.path.join(DOCS_DIR, ".vitepress", "config.js"), config_js)

    # Custom CSS for dark theme
    os.makedirs(os.path.join(DOCS_DIR, ".vitepress", "theme"), exist_ok=True)
    custom_css = textwrap.dedent("""\
        :root {
          --vp-c-brand-1: #6366f1;
          --vp-c-brand-2: #818cf8;
          --vp-c-brand-3: #a5b4fc;
          --vp-c-brand-soft: rgba(99, 102, 241, 0.14);
        }

        .dark {
          --vp-c-bg: #0f1117;
          --vp-c-bg-soft: #1a1b26;
          --vp-c-bg-mute: #24273a;
        }
    """)
    _write_file(os.path.join(DOCS_DIR, ".vitepress", "theme", "custom.css"), custom_css)

    # Theme index (to load custom CSS)
    theme_index = textwrap.dedent("""\
        import DefaultTheme from 'vitepress/theme'
        import './custom.css'

        export default DefaultTheme
    """)
    _write_file(os.path.join(DOCS_DIR, ".vitepress", "theme", "index.js"), theme_index)

    # Landing page (hero / showcase)
    index_md = textwrap.dedent(f"""\
        ---
        layout: home
        hero:
          name: "{project_name}"
          text: "{tagline}"
          tagline: "{description}"
          actions:
            - theme: brand
              text: Get Started
              link: /guide/getting-started
            - theme: alt
              text: View Features
              link: /features/
        features:
          - title: Feature Highlights
            details: Explore the complete feature set with screenshots and demos.
            link: /features/
          - title: API Reference
            details: REST API and WebSocket protocol documentation.
            link: /api/
          - title: Quick Start Guide
            details: Get up and running in minutes.
            link: /guide/getting-started
        ---
    """)
    _write_file(os.path.join(DOCS_DIR, "index.md"), index_md)

    # Placeholder pages
    _write_file(os.path.join(DOCS_DIR, "guide", "getting-started.md"),
                f"# Getting Started\n\nWelcome to {project_name}.\n")
    _write_file(os.path.join(DOCS_DIR, "guide", "installation.md"),
                f"# Installation\n\nHow to install {project_name}.\n")
    _write_file(os.path.join(DOCS_DIR, "guide", "configuration.md"),
                f"# Configuration\n\nHow to configure {project_name}.\n")
    _write_file(os.path.join(DOCS_DIR, "features", "index.md"),
                "# Features\n\nOverview of all features.\n")
    _write_file(os.path.join(DOCS_DIR, "api", "index.md"),
                "# REST API Reference\n\nAPI endpoint documentation.\n")
    _write_file(os.path.join(DOCS_DIR, "api", "websocket.md"),
                "# WebSocket Protocol\n\nReal-time communication documentation.\n")

    # Package.json for VitePress
    package_json = {
        "name": project_name.lower().replace(" ", "-") + "-docs",
        "private": True,
        "scripts": {
            "docs:dev": "vitepress dev",
            "docs:build": "vitepress build",
            "docs:preview": "vitepress preview",
        },
        "devDependencies": {
            "vitepress": "^1.6.0",
        },
    }
    _write_file(os.path.join(DOCS_DIR, "package.json"), json.dumps(package_json, indent=2))

    # Initialize manifest
    manifest = {
        "project_name": project_name,
        "created_at": _now_iso(),
        "last_build_at": None,
        "pages": {},
        "documented_tasks": [],
    }
    _write_file(MANIFEST_PATH, json.dumps(manifest, indent=2))

    return (
        f"VitePress docs scaffolded at {DOCS_DIR}/\n"
        f"Structure:\n"
        f"  docs/\n"
        f"  ├── .vitepress/config.js  (site config)\n"
        f"  ├── .vitepress/theme/     (custom dark theme)\n"
        f"  ├── index.md              (landing page)\n"
        f"  ├── guide/                (getting started, installation, config)\n"
        f"  ├── features/             (feature documentation)\n"
        f"  ├── api/                  (REST + WebSocket reference)\n"
        f"  ├── screenshots/          (captured screenshots)\n"
        f"  ├── gifs/                 (recorded workflows)\n"
        f"  ├── package.json          (VitePress dependency)\n"
        f"  └── docs_manifest.json    (coverage tracking)\n\n"
        f"Next: run `cd docs && npm install` to install VitePress, then start writing pages."
    )


def tool_write_doc_page(args: dict) -> str:
    """Write or update a documentation page with VitePress frontmatter."""
    path = args.get("path", "")
    title = args.get("title", "")
    content = args.get("content", "")

    if not path or not content:
        return "Error: 'path' and 'content' are required"

    # MCP-S8: defense-in-depth path-traversal guard. Even though the
    # documentor process has shell access, refuse `../` escapes so a future
    # locked-down documentor (MCP-only, no Bash) can't smuggle writes
    # outside DOCS_DIR via this tool.
    if path.startswith("/"):
        path = path[1:]
    docs_root = os.path.realpath(DOCS_DIR)
    candidate = os.path.realpath(os.path.join(DOCS_DIR, path))
    if candidate != docs_root and not candidate.startswith(docs_root + os.sep):
        return f"Error: path '{path}' escapes the docs directory"
    full_path = candidate

    # Add frontmatter if not present and title given
    if title and not content.startswith("---"):
        content = f"---\ntitle: {title}\n---\n\n{content}"

    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    _write_file(full_path, content)

    # Update manifest
    manifest = _load_manifest()
    manifest["pages"][path] = {
        "title": title or path,
        "updated_at": _now_iso(),
    }
    _save_manifest(manifest)

    return f"Page written: {full_path}"


def tool_get_doc_tree(args: dict) -> str:
    """Return the current docs directory structure and coverage stats."""
    if not os.path.isdir(DOCS_DIR):
        return "No docs directory found. Run scaffold_docs first."

    tree_lines: list[str] = []
    manifest = _load_manifest()
    page_count = 0
    screenshot_count = 0
    gif_count = 0

    for root, dirs, files in os.walk(DOCS_DIR):
        # Skip node_modules, .vitepress/cache, dist
        dirs[:] = [d for d in dirs if d not in ("node_modules", "cache", "dist", ".vitepress")]
        level = root.replace(DOCS_DIR, "").count(os.sep)
        indent = "  " * level
        folder = os.path.basename(root) or "docs"
        tree_lines.append(f"{indent}{folder}/")

        for file in sorted(files):
            file_indent = "  " * (level + 1)
            tree_lines.append(f"{file_indent}{file}")
            if file.endswith(".md"):
                page_count += 1
            elif file.endswith(".png"):
                screenshot_count += 1
            elif file.endswith(".gif"):
                gif_count += 1

    coverage = f"\n\n## Coverage\n- Pages: {page_count}\n- Screenshots: {screenshot_count}\n- GIFs: {gif_count}"
    if manifest.get("last_build_at"):
        coverage += f"\n- Last build: {manifest['last_build_at']}"

    return "## Docs Tree\n```\n" + "\n".join(tree_lines) + "\n```" + coverage


def tool_get_docs_manifest(args: dict) -> str:
    """Return the documentation manifest (what's documented, when, coverage)."""
    manifest = _load_manifest()
    return json.dumps(manifest, indent=2)


def tool_update_docs_manifest(args: dict) -> str:
    """Mark pages as up-to-date and record documented task IDs."""
    pages = args.get("pages", [])
    task_ids = args.get("task_ids", [])

    manifest = _load_manifest()

    for page in pages:
        path = page.get("path", "")
        if path:
            manifest["pages"][path] = {
                "title": page.get("title", path),
                "updated_at": _now_iso(),
            }

    if task_ids:
        existing = set(manifest.get("documented_tasks", []))
        existing.update(task_ids)
        manifest["documented_tasks"] = list(existing)

    _save_manifest(manifest)
    return f"Manifest updated: {len(pages)} pages, {len(task_ids)} tasks marked as documented."


def tool_build_site(args: dict) -> str:
    """Build the VitePress site to static HTML."""
    if not os.path.isdir(DOCS_DIR):
        return "Error: docs directory not found. Run scaffold_docs first."

    package_json = os.path.join(DOCS_DIR, "package.json")
    node_modules = os.path.join(DOCS_DIR, "node_modules")

    # Auto-install if needed
    if os.path.isfile(package_json) and not os.path.isdir(node_modules):
        try:
            subprocess.run(
                ["npm", "install"],
                cwd=DOCS_DIR, check=True, capture_output=True, timeout=120,
            )
        except Exception as e:
            return f"Error installing VitePress: {e}"

    try:
        result = subprocess.run(
            ["npx", "vitepress", "build"],
            cwd=DOCS_DIR, capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            return f"Build failed:\n{result.stderr[:1000]}"

        # Update manifest
        manifest = _load_manifest()
        manifest["last_build_at"] = _now_iso()
        _save_manifest(manifest)

        dist_path = os.path.join(DOCS_DIR, ".vitepress", "dist")
        return f"Build successful! Static site at: {dist_path}\n{result.stdout[-500:]}"
    except subprocess.TimeoutExpired:
        return "Error: Build timed out after 120s"
    except Exception as e:
        return f"Error: {e}"


def _find_free_port() -> int:
    """Find an available port by binding to port 0."""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def tool_preview_site(args: dict) -> str:
    """Start a VitePress dev server for live preview."""
    if not os.path.isdir(DOCS_DIR):
        return "Error: docs directory not found. Run scaffold_docs first."

    node_modules = os.path.join(DOCS_DIR, "node_modules")
    if not os.path.isdir(node_modules):
        try:
            subprocess.run(
                ["npm", "install"],
                cwd=DOCS_DIR, check=True, capture_output=True, timeout=120,
            )
        except Exception as e:
            return f"Error installing VitePress: {e}"

    # Pick a free port dynamically
    port = _find_free_port()

    # Start dev server in background
    try:
        proc = subprocess.Popen(
            ["npx", "vitepress", "dev", "--port", str(port)],
            cwd=DOCS_DIR,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        # Persist port so the frontend can discover it
        try:
            with open(os.path.join(DOCS_DIR, ".dev-port"), "w") as f:
                f.write(str(port))
        except Exception:
            pass
        return (
            f"VitePress dev server starting on http://localhost:{port}\n"
            f"Process PID: {proc.pid}\n"
            f"Stop with: kill {proc.pid}"
        )
    except Exception as e:
        return f"Error: {e}"


# ── Manifest helpers ────────────────────────────────────────────────

def _load_manifest() -> dict:
    if os.path.isfile(MANIFEST_PATH):
        try:
            with open(MANIFEST_PATH, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return {
        "project_name": "Documentation",
        "created_at": _now_iso(),
        "last_build_at": None,
        "pages": {},
        "documented_tasks": [],
    }


def _save_manifest(manifest: dict) -> None:
    os.makedirs(os.path.dirname(MANIFEST_PATH), exist_ok=True)
    with open(MANIFEST_PATH, "w") as f:
        json.dump(manifest, f, indent=2)


def _write_file(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


VALID_MEMORY_TYPES = {"user", "feedback", "project", "reference"}


def tool_save_memory(args: dict) -> str:
    """Persist a doc-relevant insight (style guide, gap, gotcha) to the
    workspace memory pool. Mirrors the worker tool so the documentor can
    capture lessons learned across documentation passes (e.g. a section
    that always needs a custom screenshot setup, or a feature that the
    knowledge base described differently than the code).
    """
    name = (args.get("name") or "").strip()
    content = (args.get("content") or "").strip()
    mem_type = (args.get("type") or "").strip()
    tags = args.get("tags") or []

    if not name or not content:
        return json.dumps({"ok": False, "error": "name and content are required"})
    if mem_type not in VALID_MEMORY_TYPES:
        return json.dumps({
            "ok": False,
            "error": f"type must be one of {sorted(VALID_MEMORY_TYPES)}",
        })

    existing = api_call(
        "GET",
        f"/memory?workspace_id={urllib.parse.quote(WORKSPACE_ID)}",
    )
    match_id = None
    if isinstance(existing, list):
        for e in existing:
            if (e.get("name") or "").strip().lower() == name.lower() and (
                (e.get("workspace_id") or "") == WORKSPACE_ID
            ):
                match_id = e.get("id")
                break

    body = {
        "name": name,
        "type": mem_type,
        "content": content,
        "workspace_id": WORKSPACE_ID or None,
        "tags": tags,
        "source_cli": "documentor",
    }
    if match_id:
        result = api_call("PUT", f"/memory/{match_id}", body)
        if isinstance(result, dict) and result.get("error"):
            return json.dumps({"ok": False, **result})
        return json.dumps({"ok": True, "id": match_id, "updated": True})
    result = api_call("POST", "/memory", body)
    if isinstance(result, dict) and result.get("error"):
        return json.dumps({"ok": False, **result})
    if isinstance(result, dict) and result.get("id"):
        return json.dumps({"ok": True, "id": result["id"], "created": True})
    return json.dumps({"ok": True})


# ── Tool registry ───────────────────────────────────────────────────

TOOLS: dict[str, dict] = {
    "get_knowledge_base": {
        "handler": tool_get_knowledge_base,
        "description": (
            "Aggregate all internal knowledge sources (CLAUDE.md, AGENTS.md, "
            "workspace knowledge, memory hub, central sync) into a single context. "
            "Call this first to understand the product before documenting."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    "get_changes_since": {
        "handler": tool_get_changes_since,
        "description": (
            "Get all changes since a timestamp: active sessions, completed tasks, "
            "git commits, and peer messages. Use for incremental doc updates."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "timestamp": {
                    "type": "string",
                    "description": "ISO 8601 timestamp (e.g. '2025-01-15T00:00:00')",
                },
            },
            "required": ["timestamp"],
        },
    },
    "get_completed_features": {
        "handler": tool_get_completed_features,
        "description": (
            "Get feature board tasks that are done/in-review but not yet documented. "
            "Cross-references the docs manifest to identify gaps."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    "screenshot_page": {
        "handler": tool_screenshot_page,
        "description": (
            "Capture a full-page or viewport screenshot using Playwright. "
            "Saves to docs/screenshots/. Returns markdown image reference."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL to screenshot"},
                "name": {"type": "string", "description": "Output filename (without extension)"},
                "full_page": {"type": "boolean", "description": "Capture full scrollable page (default: false)"},
                "width": {"type": "integer", "description": "Viewport width (default: 1280)"},
                "height": {"type": "integer", "description": "Viewport height (default: 800)"},
                "dark_mode": {"type": "boolean", "description": "Use dark color scheme (default: true)"},
            },
            "required": ["url", "name"],
        },
    },
    "screenshot_element": {
        "handler": tool_screenshot_element,
        "description": (
            "Screenshot a specific UI element by CSS selector. "
            "Useful for documenting individual panels, modals, or components."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL containing the element"},
                "selector": {"type": "string", "description": "CSS selector for the element"},
                "name": {"type": "string", "description": "Output filename (without extension)"},
                "dark_mode": {"type": "boolean", "description": "Use dark color scheme (default: true)"},
            },
            "required": ["url", "selector", "name"],
        },
    },
    "record_gif": {
        "handler": tool_record_gif,
        "description": (
            "Record a multi-step browser workflow as an animated GIF. "
            "Each step is executed via Playwright, frames captured, then "
            "stitched into an optimized GIF with ffmpeg. "
            "Steps: click, type, wait, scroll, hover, press."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Starting URL"},
                "name": {"type": "string", "description": "Output GIF filename (without extension)"},
                "steps": {
                    "type": "array",
                    "description": "Array of workflow steps",
                    "items": {
                        "type": "object",
                        "properties": {
                            "action": {
                                "type": "string",
                                "enum": ["click", "type", "wait", "scroll", "hover", "press"],
                            },
                            "selector": {"type": "string", "description": "CSS selector (for click/type/hover)"},
                            "text": {"type": "string", "description": "Text to type (for type action)"},
                            "ms": {"type": "integer", "description": "Milliseconds (for wait action)"},
                            "y": {"type": "integer", "description": "Scroll pixels (for scroll action)"},
                            "key": {"type": "string", "description": "Key name (for press action)"},
                        },
                        "required": ["action"],
                    },
                },
                "fps": {"type": "integer", "description": "Frames per second for GIF (default: 4)"},
                "width": {"type": "integer", "description": "Viewport width (default: 1280)"},
                "height": {"type": "integer", "description": "Viewport height (default: 800)"},
            },
            "required": ["url", "steps", "name"],
        },
    },
    "screenshot_panel": {
        "handler": tool_screenshot_panel,
        "description": (
            "Open a UI panel or modal and screenshot it. Each panel has a "
            "built-in recipe that prepares the correct UI state — e.g. "
            "session-dependent panels (scratchpad, code-review, config-viewer) "
            "automatically click a session first. Just specify the panel name. "
            "Available: command-palette, feature-board, guidelines, mcp-servers, "
            "research, inbox, mission-control, agent-tree, scratchpad, "
            "code-review, marketplace, accounts, config-viewer, shortcuts, "
            "knowledge, peer-messages, docs-panel, prompts, search, memory, "
            "general-settings, sound-settings, experimental, annotate, "
            "grid-templates."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "panel": {
                    "type": "string",
                    "description": "Panel name to open (e.g. 'feature-board', 'scratchpad')",
                },
                "url": {"type": "string", "description": "App URL (default: http://localhost:5173)"},
                "name": {"type": "string", "description": "Output filename (defaults to panel name)"},
                "wait_ms": {"type": "integer", "description": "Wait time after opening for animations (default: 800)"},
            },
            "required": ["panel"],
        },
    },
    "scaffold_docs": {
        "handler": tool_scaffold_docs,
        "description": (
            "Create a VitePress documentation site skeleton with dark theme, "
            "search, sidebar navigation, and directory structure for guide/, "
            "features/, api/, screenshots/, and gifs/."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_name": {"type": "string", "description": "Project name for the docs site"},
                "tagline": {"type": "string", "description": "Short tagline for the hero section"},
                "description": {"type": "string", "description": "Longer description"},
            },
            "required": ["project_name"],
        },
    },
    "write_doc_page": {
        "handler": tool_write_doc_page,
        "description": (
            "Write or update a documentation page. Path is relative to docs/. "
            "Automatically adds VitePress frontmatter if title is provided. "
            "Updates the docs manifest with the page entry."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path from docs/ (e.g. 'features/workspaces.md')"},
                "title": {"type": "string", "description": "Page title (added as frontmatter)"},
                "content": {"type": "string", "description": "Full page content in markdown"},
            },
            "required": ["path", "content"],
        },
    },
    "get_doc_tree": {
        "handler": tool_get_doc_tree,
        "description": (
            "Return the current docs directory tree and coverage statistics "
            "(page count, screenshots, GIFs, last build time)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    "get_docs_manifest": {
        "handler": tool_get_docs_manifest,
        "description": (
            "Return the documentation manifest — what pages exist, when they "
            "were last updated, which tasks are marked as documented, and "
            "the last build timestamp."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    "update_docs_manifest": {
        "handler": tool_update_docs_manifest,
        "description": (
            "Mark documentation pages as up-to-date and record task IDs as documented. "
            "Used after writing/updating pages to track incremental coverage."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "pages": {
                    "type": "array",
                    "description": "Pages to mark as current",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string"},
                            "title": {"type": "string"},
                        },
                    },
                },
                "task_ids": {
                    "type": "array",
                    "description": "Task IDs to mark as documented",
                    "items": {"type": "string"},
                },
            },
        },
    },
    "build_site": {
        "handler": tool_build_site,
        "description": (
            "Build the VitePress site to static HTML. Auto-installs npm "
            "dependencies if needed. Output goes to docs/.vitepress/dist/."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    "preview_site": {
        "handler": tool_preview_site,
        "description": (
            "Start a VitePress dev server on port 5174 for live preview. "
            "Auto-installs npm dependencies if needed."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    "save_memory": {
        "handler": tool_save_memory,
        "description": (
            "Persist a doc-relevant insight to the workspace memory pool. "
            "Use this when you discover a documentation pattern, a gap "
            "between code and docs, or a screenshot-setup gotcha worth "
            "remembering for future doc passes. Idempotent on `name`."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Short title (dedup key within the workspace)."},
                "type": {
                    "type": "string",
                    "enum": ["user", "feedback", "project", "reference"],
                    "description": "user/feedback/project/reference — pick the closest fit for a documentation insight.",
                },
                "content": {"type": "string", "description": "The insight itself. One paragraph or a tight bullet list."},
                "tags": {"type": "array", "items": {"type": "string"}, "description": "Optional tags."},
            },
            "required": ["name", "type", "content"],
        },
    },
}


# ── MCP JSON-RPC 2.0 protocol (stdio) ──────────────────────────────

def handle_jsonrpc(request: dict) -> dict:
    req_id = request.get("id")
    method = request.get("method", "")
    params = request.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {
                    "name": "commander-documentor",
                    "version": "1.0.0",
                },
            },
        }

    if method == "notifications/initialized":
        return None  # no response for notifications

    if method == "tools/list":
        tools_list = []
        for name, spec in TOOLS.items():
            tools_list.append({
                "name": name,
                "description": spec["description"],
                "inputSchema": spec["inputSchema"],
            })
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"tools": tools_list},
        }

    if method == "tools/call":
        tool_name = params.get("name", "")
        tool_args = params.get("arguments", {})
        spec = TOOLS.get(tool_name)
        if not spec:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}],
                    "isError": True,
                },
            }
        try:
            result_text = spec["handler"](tool_args)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": result_text}],
                },
            }
        except Exception as e:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": f"Error: {e}"}],
                    "isError": True,
                },
            }

    # Unknown method
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main():
    from mcp_exit_log import install, log_exit
    install("documentor")
    try:
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
                try:
                    sys.stdout.write(json.dumps(response) + "\n")
                    sys.stdout.flush()
                except BrokenPipeError:
                    log_exit("stdout-broken-pipe", "(parent stopped reading)")
                    return
        log_exit("stdin-eof", "(parent closed stdin)")
    except SystemExit:
        raise
    except BaseException as e:
        log_exit("unhandled-exception", f"{type(e).__name__}: {e}")
        raise


if __name__ == "__main__":
    main()
