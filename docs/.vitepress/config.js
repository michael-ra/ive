import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'IVE',
  description: 'Integrated Vibecoding Environment — a local web app that spawns and manages multiple Claude Code and Gemini CLI sessions from a single browser UI.',
  base: '/docs/',
  head: [['link', { rel: 'icon', href: '/docs/favicon.svg', type: 'image/svg+xml' }]],
  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'API', link: '/api/overview' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Introduction', link: '/guide/introduction' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Quick Start', link: '/guide/quick-start' },
            { text: 'Keyboard Shortcuts', link: '/guide/keyboard-shortcuts' },
          ],
        },
        {
          text: 'Interface',
          items: [
            { text: 'Overview', link: '/guide/interface/overview' },
            { text: 'Sidebar', link: '/guide/interface/sidebar' },
            { text: 'Session Tabs', link: '/guide/interface/session-tabs' },
          ],
        },
        {
          text: 'Sessions',
          items: [
            { text: 'Creating Sessions', link: '/guide/sessions/creating' },
            { text: 'Configuration', link: '/guide/sessions/configuration' },
            { text: 'Templates', link: '/guide/sessions/templates' },
            { text: 'Cloning & Merging', link: '/guide/sessions/cloning' },
            { text: 'Mission Control', link: '/guide/sessions/mission-control' },
            { text: 'Inbox', link: '/guide/sessions/inbox' },
            { text: 'Catch-up Briefing', link: '/guide/sessions/catchup' },
          ],
        },
        {
          text: 'Sharing & Multiplayer',
          items: [
            { text: 'Sharing Modes', link: '/guide/sharing/modes' },
            { text: 'Invites & QR Codes', link: '/guide/sharing/invites' },
            { text: 'Joiner Sessions & Modes', link: '/guide/sharing/joiner-sessions' },
          ],
        },
        {
          text: 'Mobile',
          items: [
            { text: 'Install (PWA)', link: '/guide/mobile/install' },
            { text: 'Push Notifications', link: '/guide/mobile/push' },
          ],
        },
        {
          text: 'Terminal & Input',
          items: [
            { text: 'Terminal', link: '/guide/terminal/overview' },
            { text: 'Composer', link: '/guide/terminal/composer' },
            { text: 'Broadcast', link: '/guide/terminal/broadcast' },
            { text: 'Cascades', link: '/guide/terminal/cascade' },
            { text: 'Force Message', link: '/guide/terminal/force-message' },
          ],
        },
        {
          text: 'Feature Board',
          items: [
            { text: 'Overview', link: '/guide/board/overview' },
            { text: 'Tasks', link: '/guide/board/tasks' },
            { text: 'Quick Feature', link: '/guide/board/quick-feature' },
          ],
        },
        {
          text: 'Prompts & Cascades',
          items: [
            { text: 'Prompt Library', link: '/guide/prompts/library' },
            { text: 'Cascades', link: '/guide/terminal/cascade' },
          ],
        },
        {
          text: 'Tools & Integrations',
          items: [
            { text: 'Guidelines', link: '/guide/guidelines' },
            { text: 'MCP Servers', link: '/guide/mcp-servers' },
            { text: 'Code Review', link: '/guide/code-review' },
            { text: 'Screenshots', link: '/guide/screenshots' },
            { text: 'Research Panel', link: '/guide/research' },
            { text: 'Deep Research Engine', link: '/guide/research/deep-research-engine' },
          ],
        },
        {
          text: 'Agent System',
          items: [
            { text: 'Agent Tree', link: '/guide/agents/agent-tree' },
            { text: 'Commander', link: '/guide/agents/commander' },
            { text: 'RALPH Mode', link: '/guide/agents/ralph-mode' },
            { text: 'Myelin Coordination', link: '/guide/agents/myelin-coordination' },
          ],
        },
        {
          text: 'Memory & Knowledge',
          items: [
            { text: 'Knowledge Base', link: '/guide/memory/knowledge-base' },
            { text: 'Memory Sync', link: '/guide/memory/sync' },
          ],
        },
        {
          text: 'Marketplace & Plugins',
          items: [
            { text: 'Marketplace', link: '/guide/marketplace' },
            { text: 'Deep Research Plugin', link: '/guide/plugins/deep-research' },
          ],
        },
        {
          text: 'Settings',
          items: [
            { text: 'General', link: '/guide/settings/general' },
            { text: 'Sounds', link: '/guide/settings/sounds' },
            { text: 'Accounts', link: '/guide/settings/accounts' },
            { text: 'API Keys', link: '/guide/settings/api-keys' },
            { text: 'Safety Gate (AVCP) & Auto Auth Cycling', link: '/guide/settings/safety' },
            { text: 'Experimental', link: '/guide/settings/experimental' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'Overview', link: '/api/overview' },
            { text: 'Workspaces', link: '/api/workspaces' },
            { text: 'Sessions', link: '/api/sessions' },
            { text: 'Tasks', link: '/api/tasks' },
            { text: 'Prompts & Cascades', link: '/api/prompts' },
            { text: 'Research', link: '/api/research' },
            { text: 'Memory', link: '/api/memory' },
            { text: 'Plugins & Skills', link: '/api/plugins' },
            { text: 'Settings & Events', link: '/api/settings' },
            { text: 'WebSocket Protocol', link: '/api/websocket' },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com' },
    ],
    search: {
      provider: 'local',
    },
  },
})
