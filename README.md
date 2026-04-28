<p align="center">
  <img src="docs/public/logo.svg" alt="IVE Logo" width="120">
</p>

<h1 align="center">IVE (Integrated Vibecoding Environment)</h1>

<h3 align="center">Vibecoding on steroids. Humanity's last IDE.</h3>

<p align="center">
  <em>One browser. N terminals. Infinite agents. Bring friends.</em><br>
  <strong>CLI-Agnostic · Multiplayer · Visual Pipelines · 8,000+ Skills · Local-First</strong>
</p>

<p align="center">
  <a href="https://github.com/michael-ra/ive/stargazers"><img src="https://img.shields.io/github/stars/michael-ra/ive?style=flat&color=f59e0b" alt="GitHub stars"></a>
  <a href="https://github.com/michael-ra/ive/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License: Apache 2.0"></a>
  <img src="https://img.shields.io/badge/python-3.11%2B-blue.svg" alt="Python 3.11+">
  <img src="https://img.shields.io/badge/node-18%2B-green.svg" alt="Node 18+">
  <img src="https://img.shields.io/badge/status-Alpha-orange.svg" alt="Status: Alpha">
  <img src="https://img.shields.io/badge/Claude%20Code-supported-7C3AED.svg" alt="Claude Code">
  <img src="https://img.shields.io/badge/Gemini%20CLI-supported-1F6FEB.svg" alt="Gemini CLI">
</p>

---

## ⚡ The Pitch

Six terminals running. Three Claude Code, two Gemini, one Commander session managing workers. A friend jumps in from their phone and starts triaging the Feature Board. A pipeline fires the second a ticket hits *In Progress*. Sonnet runs out of tokens mid-sentence—IVE automatically rotates to your next API key and keeps going. You go get coffee. **Nothing stops.**

Current AI CLI tools are powerful, but running multiple agents simultaneously across different terminal windows leads to fragmented context, wasted tokens, and chaotic workflows. 

**IVE fixes this.** It brings your CLIs into a centralized, persistent, and highly collaborative environment. Stop switching tabs. Start commanding agents.

<p align="center">
  <a href="https://ive.dev">
    <img src="docs/screenshots/main-layout.png" alt="IVE Main Layout" width="900">
  </a>
</p>

---

## 🚀 Quick Start

Get up and running in seconds. IVE handles its own dependencies and agent installations.

```bash
git clone https://github.com/michael-ra/ive.git
cd ive
./start.sh
```

Open [http://localhost:5173](http://localhost:5173). That's it.

> **Want to code from your phone or share with a friend?** 
> Generate secure invites and toggle tunnels directly inside the app, or boot a public instance instantly with `npx ive --tunnel`.

---

## 🤯 What Changes When You Install IVE

🛑 **Your terminals stop being archaeology.** Every session lives in one grid—state, scroll, name, ownership all tracked. No more *"which window had the auth fix?"*

🛑 **Your tokens stop running out.** Stack every plan you own (Claude Max, Gemini Ultra, API keys). IVE rotates on `quota_exceeded` automatically. The agent doesn't notice. The PR ships.

🛑 **Your laptop stops being a leash.** Add IVE to your phone's home screen. Code while you're in line for coffee. Your flow doesn't break because your laptop closed.

🛑 **Your team stops needing the keys.** Hand a friend a 4-word invite. They get clamped access (Read/Code/Full). No screen sharing. No password reset.

🛑 **Your roadmap goes on autopilot.** The built-in *Observatory* scans GitHub Trending, Hacker News, and X while you sleep, telling you exactly what tools to integrate next.

---

## ✨ Core Pillars

### 🔌 1. CLI-Agnostic
Use **Claude Code**, **Gemini CLI**, or whatever comes next. IVE mounts real PTY terminals, meaning all native features (Shift+Tab, Plan Mode, Slash Commands) work perfectly. Swap models mid-session or switch CLIs in two keystrokes.

### 🤝 2. Real-Time Multiplayer
Bring your team into the loop. Share a session with a 4-word passcode. Granular access controls ensure collaborators have exactly the permissions they need—without sharing your API keys.

### 🧠 3. Shared Memory & Context
Agents shouldn't have amnesia. IVE features a hub-and-spoke memory synchronization system. What one agent learns, every agent remembers. When you return to your desk, IVE generates a 2-5 sentence prose digest of what your agents accomplished while you were away.

### ⚡ 4. Visual Pipelines & Orchestration
Stop babysitting agents. Use our drag-and-drop node editor to build autonomous workflows. Trigger pipelines based on Kanban board column moves, run Test-Driven Development (TDD) loops, or set up a RALPH (Execute → Verify → Fix) cycle that runs up to 20 iterations automatically.

### 🧩 5. 8,000+ Skills & MCP Integration
Extensibility is a first-class citizen. IVE ships with a built-in marketplace of over 8,000 offline-browsable skills. Easily attach Model Context Protocol (MCP) servers (like the bundled Deep Research engine) to give your agents access to databases, web search, or custom internal tools.

---

## 📸 A Glimpse Inside

<table>
  <tr>
    <td align="center" width="33%">
      <img src="docs/screenshots/mission-control.png" alt="Mission Control">
      <br><b>Mission Control</b><br>Monitor all active agent sessions at a glance.
    </td>
    <td align="center" width="33%">
      <img src="docs/screenshots/pipeline-editor.png" alt="Pipeline Editor">
      <br><b>Pipeline Editor</b><br>Design autonomous multi-agent workflows visually.
    </td>
    <td align="center" width="33%">
      <img src="docs/screenshots/code-review.png" alt="Code Review">
      <br><b>Integrated Code Review</b><br>Diff viewer with inline agent annotation support.
    </td>
  </tr>
</table>

---

## 🏗 Under the Hood

IVE is designed to be lightweight, local-first, and highly secure.

* **Backend**: Python (`aiohttp`) spawning real PTY sessions via `os.fork()`. Handles 140+ REST routes and a single multiplexed WebSocket for realtime control.
* **Frontend**: React 19 + Vite 8 + xterm.js. Zustand for state management, styled with Tailwind CSS v4.
* **Data**: Local SQLite (`~/.ive/data.db`). **Zero external cloud dependencies.**
* **Security**: API account sandboxing, constant-time token comparisons, built-in Anti-Vibe-Code-Pwner supply chain scanning.

---

## 📊 Telemetry

IVE ships with anonymous, local-first telemetry **enabled by default** to help us understand usage during the Alpha phase. We only collect standard metrics (version, platform, session count). **No PII, no code, no prompts are ever collected.**

To opt out, simply run:
```bash
IVE_TELEMETRY=off ./start.sh
```

---

## 🤝 Contributing

We are building the open standard for AI orchestration. Whether it's fixing a bug, adding a new CLI profile, or improving documentation, your contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

<p align="center">
  Built with ❤️ by the IVE Community.<br>
  <strong>Stop switching tabs. Start commanding agents.</strong>
</p>