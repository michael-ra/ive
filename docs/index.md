---
layout: home
hero:
  name: "IVE"
  text: "Integrated Vibecoding Environment"
  tagline: "Run multiple Claude Code and Gemini CLI agents from a single browser UI — with a full terminal emulator, Kanban board, research engine, and MCP integration. Everything local, nothing cloud."
  actions:
    - theme: brand
      text: Get Started
      link: /guide/introduction
    - theme: alt
      text: Quick Start
      link: /guide/quick-start
    - theme: alt
      text: API Reference
      link: /api/overview
features:
  - icon: 🖥️
    title: Multi-session terminal
    details: Real PTY sessions with xterm.js — Shift+Tab, plan mode, slash commands all work. Switch between Claude Code and Gemini CLI per session.
    link: /guide/terminal/overview
  - icon: 📋
    title: Built-in Kanban board
    details: Track tasks through backlog → in-progress → done. Sessions can create and update tasks autonomously via the Commander MCP.
    link: /guide/board/overview
  - icon: 🔬
    title: Deep research engine
    details: Self-hosted web research with multi-source search, source citation, and a persistent results database. No API keys required to start.
    link: /guide/research
  - icon: 🔌
    title: MCP server management
    details: Register, configure, and attach Model Context Protocol servers to individual sessions. Parse server configs from documentation automatically.
    link: /guide/mcp-servers
  - icon: 📡
    title: Broadcast & orchestration
    details: Send prompts to multiple sessions at once. Chain them with Cascades. Let the Commander orchestrator spawn and manage worker sessions.
    link: /guide/agents/commander
  - icon: ⚡
    title: RALPH autonomous mode
    details: Execute → verify → fix loop runs up to 20 iterations. Prefix any prompt with @ralph to engage autonomous task completion.
    link: /guide/agents/ralph-mode
---
