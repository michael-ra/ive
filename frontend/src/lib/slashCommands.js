// Slash commands offered by the composer autocomplete (chat composer and the
// Home composer share this list).
export const SLASH_COMMANDS = [
  { cmd: '/goal', desc: 'Frame a durable objective for the agent' },
  { cmd: '/schedule', desc: 'Create or update a scheduled workflow' },
  { cmd: '/browser', desc: 'Start a browser-assisted task' },
  { cmd: '/grill-me', desc: 'Run an interactive review/interview pass' },
  { cmd: '/model', desc: 'Switch the active model for this CLI' },
  { cmd: '/plan', desc: 'Enter planning mode when the CLI supports it' },
  { cmd: '/branch', desc: 'Create a branch/worktree session' },
  { cmd: '/rename', desc: 'Rename the current CLI conversation' },
  { cmd: '/clear', desc: 'Clear visible context and archive prior chat' },
  { cmd: '/help', desc: 'Show CLI slash command help' },
]
