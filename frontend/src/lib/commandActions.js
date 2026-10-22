import { Plus, SquareTerminal, FolderOpen, X, ToggleLeft, Settings, BookOpen, FileText, Keyboard, Square, Shield, Columns, Columns3, Radio, Search, Copy, Download, Layout, LayoutGrid, History, Inbox, ListChecks, Kanban, GitBranch, GitCompareArrows, StickyNote, User, RotateCcw, Package, FlaskConical, Zap, Volume2, MessageSquareQuote, ListOrdered, Server, Sparkles, Brain, MessagesSquare, MessageSquare, ExternalLink, BookOpenCheck, Key, Telescope, Newspaper, Share2, FileCode2, Sliders, ScrollText, Boxes, Coins, Eye, Smartphone, Home, SunMoon, Lightbulb } from 'lucide-react';
import { isSurfaceAvailable } from './extensionRegistry';
import { getKeybindings, formatKeyCombo } from './keybindings';
export const ACTIONS = [{
  id: 'command-palette',
  label: 'Command Palette',
  icon: Search,
  section: 'Navigation',
  shortcut: '⌘K',
  hideFromPanel: true
}, {
  // The first level: composer, recent sessions, projects.
  id: 'sessions',
  label: 'Home',
  icon: Home,
  section: 'Navigation',
  keywords: 'home start',
  get shortcut() { return formatKeyCombo(getKeybindings().goHome) }
}, {
  id: 'board',
  label: 'Board',
  icon: Columns3,
  section: 'Navigation',
  hint: 'Every session in Running / Waiting / Done',
  keywords: 'overview sessions running waiting done columns',
  get shortcut() { return formatKeyCombo(getKeybindings().toggleSessionLevel) }
}, {
  id: 'review',
  label: 'Review changes',
  icon: GitCompareArrows,
  section: 'Navigation',
  hint: 'Diff of the open session',
  keywords: 'git diff files changed',
  get shortcut() { return formatKeyCombo(getKeybindings().codeReview) }
}, {
  id: 'knowledge',
  label: 'Knowledge',
  icon: Brain,
  section: 'Navigation',
  hint: 'Guidelines, memory and project context (Context Hub)',
  keywords: 'memory context hub guidelines docs'
}, {
  id: 'toggle-terminal',
  label: 'Terminal',
  icon: SquareTerminal,
  section: 'Navigation',
  hint: 'Show or hide the terminal drawer of the open session',
  keywords: 'drawer pty shell console',
  get shortcut() { return formatKeyCombo(getKeybindings().toggleTerminal) }
}, {
  id: 'theme-toggle',
  label: 'Switch theme',
  icon: SunMoon,
  section: 'View',
  hint: 'Light / dark',
  keywords: 'dark light mode appearance'
}, {
  id: 'brainstorm',
  label: 'Brainstorm in this project',
  icon: Lightbulb,
  section: 'Work',
  hint: 'Opens the project\'s Brainstormer helper session',
  keywords: 'brainstormer ideas helper'
}, {
  id: 'catch-up',
  label: 'Catch up',
  icon: Newspaper,
  section: 'Work',
  hint: 'What happened while you were away',
  keywords: 'briefing digest missed'
}, {
  id: 'new-session',
  label: 'New Session',
  icon: Plus,
  section: 'Sessions',
  get shortcut() { return formatKeyCombo(getKeybindings().newSession) },
  hint: 'Start right away, no project needed'
}, {
  id: 'new-session-setup',
  label: 'Set Up Session…',
  icon: Sliders,
  section: 'Sessions',
  get shortcut() { return formatKeyCombo(getKeybindings().newSessionSetup) },
  hint: 'Workspace, guidelines, MCP servers, worktree'
}, {
  id: 'new-terminal',
  label: 'New terminal',
  icon: SquareTerminal,
  section: 'Sessions',
  hint: 'Your login shell in the current project, no AI',
  keywords: 'shell zsh bash console command line'
}, {
  id: 'close-tab',
  label: 'Close Session',
  hint: 'Move to Archive and keep the conversation',
  icon: X,
  section: 'Sessions',
  get shortcut() { return formatKeyCombo(getKeybindings().closeTab) },
  hideFromPanel: true
}, {
  id: 'stop-session',
  label: 'Stop Session',
  icon: Square,
  section: 'Sessions',
  shortcut: '⌘.',
  hideFromPanel: true
}, {
  id: 'restart-session',
  label: 'Restart Session',
  icon: RotateCcw,
  section: 'Sessions',
  hideFromPanel: true
}, {
  id: 'mission-control',
  label: 'Mission Control',
  icon: LayoutGrid,
  section: 'View',
  get shortcut() { return formatKeyCombo(getKeybindings().missionControl) }
}, {
  id: 'inbox',
  label: 'Session Inbox',
  icon: Inbox,
  section: 'Work',
  shortcut: '⌘I'
}, {
  id: 'briefing',
  label: 'Catch Up',
  icon: Newspaper,
  section: 'Sessions',
  hint: 'AI summary of what happened in a time window'
}, {
  id: 'cost',
  label: 'Cost & Tokens',
  icon: Coins,
  section: 'View',
  hint: 'Estimated cost and recorded token usage by agent, model, and session'
}, {
  id: 'plan-viewer',
  label: 'Plan Viewer',
  icon: ListChecks,
  section: 'Sessions',
  hideFromPanel: true
}, {
  id: 'capabilities',
  label: 'Capabilities',
  icon: Boxes,
  section: 'Sessions',
  hideFromPanel: true
}, {
  id: 'toggle-sidebar',
  label: 'Toggle Sidebar',
  icon: ToggleLeft,
  section: 'View',
  shortcut: '⌘\\',
  hideFromPanel: true
}, {
  id: 'add-workspace',
  label: 'Add Workspace',
  icon: FolderOpen,
  section: 'Workspaces',
  hideFromPanel: true
}, {
  id: 'workspace-settings',
  label: 'Workspace Settings',
  icon: Settings,
  section: 'Workspaces'
}, {
  id: 'prompt-library',
  label: 'Prompt Library',
  icon: BookOpen,
  section: 'Prompts',
  shortcut: '⌘/'
}, {
  id: 'new-prompt',
  label: 'New Prompt',
  icon: FileText,
  section: 'Prompts'
}, {
  id: 'guidelines',
  label: 'Guidelines',
  icon: Shield,
  section: 'Config',
  shortcut: '⌘G',
  hideFromPanel: true
}, {
  id: 'connectors',
  label: 'Connectors',
  icon: Server,
  section: 'Config',
  hint: 'Connect apps, AI accounts, API keys and MCP tools'
}, {
  id: 'mcp-servers',
  label: 'Connectors: MCP Servers',
  icon: Server,
  section: 'Config',
  shortcut: '⌘⇧S'
}, {
  id: 'broadcast',
  label: 'Broadcast to Sessions',
  icon: Radio,
  section: 'Sessions',
  shortcut: '⌘⇧↵'
}, {
  id: 'files',
  label: 'Files & Plans',
  icon: FileText,
  section: 'Sessions',
  hideFromPanel: true
}, {
  id: 'clone-session',
  label: 'Clone Session',
  icon: Copy,
  section: 'Sessions',
  hideFromPanel: true
}, {
  id: 'export-session',
  label: 'Export as Markdown',
  icon: Download,
  section: 'Sessions',
  hideFromPanel: true
}, {
  id: 'distill-session',
  label: 'Distill Session',
  icon: Sparkles,
  section: 'Sessions',
  hideFromPanel: true
}, {
  id: 'find-in-session',
  label: 'Find in Session',
  icon: Search,
  section: 'Work',
  get shortcut() { return formatKeyCombo(getKeybindings().search) },
  hint: 'Search the open chat or terminal',
  hideFromPanel: true
}, {
  id: 'search',
  label: 'Search All Sessions',
  icon: Search,
  section: 'Work',
  get shortcut() { return formatKeyCombo(getKeybindings().globalSearch) },
  hint: 'Messages of every session',
  hideFromPanel: true
}, {
  id: 'import-history',
  label: 'Import Sessions',
  icon: History,
  section: 'Work',
  hideFromPanel: true
}, {
  id: 'feature-board',
  label: 'Feature Board',
  icon: Kanban,
  section: 'Orchestration',
  shortcut: '⌘B'
}, {
  id: 'board-new-card',
  label: 'Board: New Card',
  icon: Plus,
  section: 'Feature Board',
  hint: 'Title-only, optional capture'
}, {
  id: 'board-needs-attention',
  label: 'Board: Needs Attention',
  icon: ListChecks,
  section: 'Feature Board',
  hint: 'Open the non-blocking triage filter'
}, {
  id: 'board-filter',
  label: 'Board: Focus Filter',
  icon: Search,
  section: 'Feature Board'
}, {
  id: 'board-shortcuts',
  label: 'Board: Keyboard Shortcuts',
  icon: Keyboard,
  section: 'Feature Board'
}, {
  id: 'pipeline-editor',
  label: 'Pipelines',
  icon: GitCompareArrows,
  section: 'Work',
  shortcut: '⌘⇧L'
}, {
  id: 'activity-audit',
  label: 'Activity Logs',
  icon: ScrollText,
  section: 'Operate',
  hint: 'Events, commands, AVCP, HTTP audit, and external access'
}, {
  id: 'quick-feature',
  label: 'Capture Feature',
  icon: Zap,
  section: 'Work',
  get shortcut() { return formatKeyCombo(getKeybindings().quickFeature) },
  hideFromPanel: true
}, {
  id: 'observatory',
  label: 'Discovery Inbox',
  icon: Telescope,
  section: 'Discovery',
  shortcut: '⌘⇧O'
}, {
  id: 'apis-integrations',
  label: 'Connectors: Custom APIs',
  icon: Server,
  section: 'Orchestration'
}, {
  id: 'smart-observatory',
  label: 'Discovery Setup',
  icon: Telescope,
  section: 'Discovery',
  hideFromPanel: true
}, {
  id: 'discovery-insights',
  label: 'Discovery Insights',
  icon: Telescope,
  section: 'Discovery',
  hideFromPanel: true
}, {
  id: 'agent-tree',
  label: 'Agent Tree',
  icon: GitBranch,
  section: 'Orchestration',
  get shortcut() { return formatKeyCombo(getKeybindings().agentTree) },
  hideFromPanel: true
}, {
  id: 'docs-panel',
  label: 'Docs Hub',
  icon: BookOpenCheck,
  section: 'Know',
  hideFromPanel: true
}, {
  id: 'save-template',
  label: 'Save as Template',
  icon: Layout,
  section: 'Templates',
  hideFromPanel: true
}, {
  id: 'scratchpad',
  label: 'Scratchpad',
  icon: StickyNote,
  section: 'View',
  get shortcut() { const combo = getKeybindings().scratchpad; return combo ? formatKeyCombo(combo) : undefined },
  hideFromPanel: true
}, {
  id: 'manage-templates',
  label: 'Manage Templates',
  icon: Layout,
  section: 'Templates',
  hideFromPanel: true
}, {
  id: 'adjust-grid',
  label: 'Adjust Grid Layout',
  icon: Sliders,
  section: 'View',
  hideFromPanel: true
}, {
  id: 'accounts',
  label: 'Manage Accounts',
  icon: User,
  section: 'Auth',
  hideFromPanel: true
}, {
  id: 'config-viewer',
  label: 'Config Files & Tool Permissions',
  icon: Shield,
  section: 'Config',
  hideFromPanel: true
}, {
  id: 'research',
  label: 'Research',
  icon: BookOpen,
  section: 'Know',
  get shortcut() { return formatKeyCombo(getKeybindings().research) }
}, {
  id: 'research-library',
  label: 'Research Library',
  icon: BookOpen,
  section: 'Research',
  hideFromPanel: true
}, {
  id: 'marketplace',
  label: 'Plugins & Skills',
  icon: Package,
  section: 'Config',
  shortcut: '⌘⇧M'
}, {
  id: 'quick-actions',
  label: 'Quick Action Palette',
  icon: Zap,
  section: 'Navigation',
  shortcut: '⌘Y',
  hideFromPanel: true
}, {
  id: 'preview',
  label: 'Preview Palette',
  icon: Eye,
  section: 'Navigation',
  hideFromPanel: true
}, {
  id: 'skills-library',
  label: 'Agent Skills Library',
  icon: Zap,
  section: 'Config',
  shortcut: '⌘O',
  hideFromPanel: true
}, {
  id: 'experimental',
  label: 'Experimental Features',
  icon: FlaskConical,
  section: 'Config',
  hideFromPanel: true
}, {
  id: 'safety',
  label: 'Safety & Policies',
  icon: Shield,
  section: 'Configure',
  hideFromPanel: true
}, {
  id: 'cascades',
  label: 'Prompt Cascades',
  icon: ListOrdered,
  section: 'Prompts',
  hideFromPanel: true
}, {
  id: 'general-settings',
  label: 'General Settings',
  icon: ToggleLeft,
  section: 'Config',
  hideFromPanel: true
}, {
  id: 'mac-power',
  label: 'Mac & Energie',
  icon: Zap,
  section: 'Config',
  hint: 'Akku sparen, Deckel schließen, Agenten weiterarbeiten lassen',
  hideFromPanel: true
}, {
  id: 'model-providers',
  label: 'Model Providers',
  icon: Server,
  section: 'Config',
  hideFromPanel: true
}, {
  id: 'sound-settings',
  label: 'Sound Notifications',
  icon: Volume2,
  section: 'Config',
  hideFromPanel: true
}, {
  id: 'api-keys',
  label: 'API Keys',
  icon: Key,
  section: 'Config',
  hideFromPanel: true
}, {
  id: 'phone-access',
  label: 'Connect your iPhone',
  icon: Smartphone,
  section: 'Configure',
  hint: 'Pair a phone with a one-time QR code, set a PIN, revoke devices',
  hideFromPanel: true
}, {
  id: 'sharing',
  label: 'Multiplayer Share',
  icon: Share2,
  section: 'Configure',
  hint: 'Off / Local / Tunnel + live clients, invite minting, and active joiners',
  hideFromPanel: true
}, {
  id: 'code-review',
  label: 'Code Review',
  icon: GitCompareArrows,
  section: 'Git',
  shortcut: '⌘⇧G',
  hideFromPanel: true
}, {
  id: 'secure',
  label: 'Secure Self-Test',
  icon: Shield,
  section: 'Operate',
  hint: 'Authorized Kali pentest of your own app from a network-clamped sandbox'
}, {
  id: 'annotate',
  label: 'Annotations',
  icon: MessageSquareQuote,
  section: 'Sessions',
  shortcut: '⌘⇧A',
  hideFromPanel: true
}, {
  id: 'memory',
  label: 'Context Hub',
  icon: Brain,
  section: 'Context'
}, {
  id: 'memory-search',
  label: 'Context Search',
  icon: Search,
  section: 'Context',
  hideFromPanel: true
}, {
  id: 'peer-messages',
  label: 'Peer Messages',
  icon: MessagesSquare,
  section: 'Context',
  hideFromPanel: true
}, {
  id: 'grid-templates',
  label: 'Grid Layouts',
  icon: LayoutGrid,
  section: 'Configure',
  hideFromPanel: true
}, {
  id: 'pop-out-terminal',
  label: 'Pop Out Terminal',
  icon: ExternalLink,
  section: 'Sessions',
  hint: 'Open in native OS terminal',
  hideFromPanel: true
}, {
  id: 'shortcuts',
  label: 'Keyboard Shortcuts',
  icon: Keyboard,
  section: 'Help',
  hideFromPanel: true
}].filter(action => isSurfaceAvailable(action.id));
