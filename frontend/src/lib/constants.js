export const MODELS = [
  { id: 'haiku', label: 'Haiku', description: 'Fast & cheap' },
  { id: 'sonnet', label: 'Sonnet', description: 'Balanced' },
  { id: 'opus', label: 'Opus', description: 'Maximum capability' },
]

export const PERMISSION_MODES = [
  { id: 'default', label: 'Default' },
  { id: 'auto', label: 'Auto' },
  { id: 'plan', label: 'Plan' },
  { id: 'acceptEdits', label: 'Accept Edits' },
  { id: 'dontAsk', label: "Don't Ask" },
  { id: 'bypassPermissions', label: 'Bypass All' },
]

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max']

// ─── Workspace colors ───────────────────────────────
// Stable per-workspace palette so distinct projects get distinct colors
// even when ws.color hasn't been explicitly set in the DB.
export const WORKSPACE_PALETTE = [
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#f59e0b', // amber
  '#10b981', // emerald
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#ef4444', // red
  '#84cc16', // lime
  '#f97316', // orange
]

export function getWorkspaceColor(workspace) {
  if (!workspace) return WORKSPACE_PALETTE[0]
  if (workspace.color) return workspace.color
  const id = String(workspace.id || '')
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  }
  return WORKSPACE_PALETTE[Math.abs(hash) % WORKSPACE_PALETTE.length]
}

// CLI_TYPES is derived from CLI_FALLBACK below (single source).

// ─── Gemini CLI ─────────────────────────────────────
export const GEMINI_MODELS = [
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Gemini Pro' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Fast Gemini' },
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', description: 'Previous gen flash' },
]

export const GEMINI_APPROVAL_MODES = [
  { id: 'default', label: 'Default' },
  { id: 'auto_edit', label: 'Auto Edit' },
  { id: 'yolo', label: 'YOLO' },
  { id: 'plan', label: 'Plan' },
]

// ─── Codex CLI ──────────────────────────────────────
export const CODEX_MODELS = [
  { id: 'gpt-5.5', label: 'GPT-5.5', description: 'Maximum capability' },
  { id: 'gpt-5.4', label: 'GPT-5.4', description: 'Balanced Codex work' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', description: 'Fast Codex work' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', description: 'Coding-optimized' },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', description: 'Ultra-fast coding' },
]

export const CODEX_PERMISSION_MODES = [
  { id: 'default', label: 'Default' },
  { id: 'auto', label: 'Auto' },
  { id: 'plan', label: 'Plan' },
  { id: 'bypassPermissions', label: 'Bypass All' },
]

export const CODEX_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh']

// ─── Single-source CLI registry fallback ────────────────────
// Shaped like a /api/cli-info/features profile. The store value
// (loaded from that endpoint) is always preferred; this is the
// pre-load / offline fallback. Adding a CLI = one entry here.
// Values intentionally mirror the previous per-getter fallbacks
// exactly (behavior-preserving — guarded by the snapshot test).
export const CLI_FALLBACK = {
  claude: {
    label: 'Claude',
    message_markers: ['⏺', '>'],
    available_models: MODELS,
    available_permission_modes: PERMISSION_MODES,
    effort_levels: EFFORT_LEVELS,
    default_model: 'sonnet',
    default_permission_mode: 'default',
    ui_capabilities: { force_send: true, terminal_input: 'ink' },
    theme: {
      shortLabel: 'CLA',
      badge: 'bg-indigo-500/12 text-indigo-300 border-indigo-500/20',
      selected: 'bg-accent-subtle text-indigo-400 border border-indigo-500/25',
      subtle: 'text-indigo-400 bg-indigo-500/10',
      hover: 'hover:bg-accent-subtle',
    },
  },
  gemini: {
    label: 'Gemini',
    message_markers: ['✦', '>'],
    available_models: GEMINI_MODELS,
    available_permission_modes: GEMINI_APPROVAL_MODES,
    effort_levels: [],
    default_model: 'gemini-2.5-pro',
    default_permission_mode: 'auto_edit',
    ui_capabilities: { force_send: false, terminal_input: 'readline' },
    theme: {
      shortLabel: 'GEM',
      badge: 'bg-blue-500/12 text-blue-300 border-blue-500/20',
      selected: 'bg-blue-500/15 text-blue-400 border border-blue-500/25',
      subtle: 'text-blue-400 bg-blue-500/10',
      hover: 'hover:bg-blue-500/10',
    },
  },
  codex: {
    label: 'Codex',
    message_markers: ['codex', '>'],
    available_models: CODEX_MODELS,
    available_permission_modes: CODEX_PERMISSION_MODES,
    effort_levels: CODEX_EFFORT_LEVELS,
    default_model: 'gpt-5.4',
    default_permission_mode: 'default',
    ui_capabilities: { force_send: false, terminal_input: 'readline' },
    theme: {
      shortLabel: 'COD',
      badge: 'bg-emerald-500/12 text-emerald-300 border-emerald-500/20',
      selected: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25',
      subtle: 'text-emerald-400 bg-emerald-500/10',
      hover: 'hover:bg-emerald-500/10',
    },
  },
}

function tryStoreProfiles() {
  try {
    const { default: useStore } = require('../state/store')
    return useStore.getState().cliProfiles
  } catch (e) { return null }
}

function cliProfile(cliType) {
  const store = tryStoreProfiles()
  return (store && store[cliType]) || CLI_FALLBACK[cliType] || CLI_FALLBACK.claude
}

// Derived alias so external importers of CLI_THEME keep working.
export const CLI_THEME = Object.fromEntries(
  Object.entries(CLI_FALLBACK).map(([id, p]) => [id, p.theme])
)

// ─── CLI Types (derived — adding a CLI needs no edit here) ───
export const CLI_TYPES = Object.entries(CLI_FALLBACK).map(
  ([id, p]) => ({ id, label: p.label })
)

/**
 * Check if a prompt is too vague for direct execution.
 * Returns true if the prompt likely needs more specificity.
 * Skips check for @Ralph, plan mode triggers, and task-like prompts.
 */
export function isVaguePrompt(text) {
  if (!text) return false
  const cleaned = text.replace(/@\w+/g, '').trim()
  // Skip if short enough to be a command (e.g. "/help", "yes", "proceed")
  if (cleaned.length < 10) return false
  const words = cleaned.split(/\s+/).filter(Boolean)
  // Only flag if ≤15 words
  if (words.length > 15) return false
  // Has file paths, function names, or code symbols → specific enough
  const specificPatterns = /[./\\][\w/]+\.\w+|`[^`]+`|function\s+\w+|class\s+\w+|#\d+|\bstep\s+\d/i
  if (specificPatterns.test(cleaned)) return false
  // Has numbered steps → specific enough
  if (/^\d+[\.\)]/m.test(cleaned)) return false
  // Has force prefix → skip gate
  if (/^(force:|!)/.test(cleaned)) return false
  return true
}

// ─── Profile-driven helpers ─────────────────────────────────
// These read CLI profile data from the store (loaded from /api/cli-info/features).
// They fall back to the static constants above when profiles aren't loaded yet.

// All getters resolve through cliProfile(): store profile (from
// /api/cli-info/features) first, else the single CLI_FALLBACK entry,
// else Claude. Signatures unchanged; behavior identical to the prior
// per-getter static fallbacks (snapshot-guarded).

export function getModelsForCli(cliType) {
  const store = tryStoreProfiles()
  if (store?.[cliType]?.available_models?.length) {
    return store[cliType].available_models
  }
  return cliProfile(cliType).available_models
}

export function getPermissionModesForCli(cliType) {
  const store = tryStoreProfiles()
  if (store?.[cliType]?.available_permission_modes?.length) {
    return store[cliType].available_permission_modes
  }
  return cliProfile(cliType).available_permission_modes
}

export function getEffortLevelsForCli(cliType) {
  const store = tryStoreProfiles()
  if (store?.[cliType]?.effort_levels !== undefined) {
    return store[cliType].effort_levels
  }
  return cliProfile(cliType).effort_levels
}

export function getDefaultModel(cliType) {
  const store = tryStoreProfiles()
  if (store?.[cliType]?.default_model) return store[cliType].default_model
  return cliProfile(cliType).default_model
}

export function getDefaultPermissionMode(cliType) {
  const store = tryStoreProfiles()
  if (store?.[cliType]?.default_permission_mode) {
    return store[cliType].default_permission_mode
  }
  return cliProfile(cliType).default_permission_mode
}

export function getCliCapability(cliType, capability) {
  const store = tryStoreProfiles()
  if (store?.[cliType]) {
    return store[cliType].ui_capabilities?.[capability] ?? false
  }
  const v = (cliProfile(cliType).ui_capabilities || {})[capability]
  return v === undefined ? false : v
}

export function getCliTheme(cliType) {
  return cliProfile(cliType).theme || CLI_FALLBACK.claude.theme
}

export function getCliShortLabel(cliType) {
  const store = tryStoreProfiles()
  const label = store?.[cliType]?.ui_capabilities?.short_label
  if (label) return label
  return getCliTheme(cliType).shortLabel
}

export function getCliBadgeClass(cliType) {
  return getCliTheme(cliType).badge
}

export function getCliSelectedClass(cliType) {
  return getCliTheme(cliType).selected
}

export function getCliSubtleClass(cliType) {
  return getCliTheme(cliType).subtle
}

export function getCliHoverClass(cliType) {
  return getCliTheme(cliType).hover
}

export function getMessageMarkers(cliType) {
  const store = tryStoreProfiles()
  const markers = store?.[cliType]?.message_markers
  if (markers?.length) return new Set(markers)
  return new Set(cliProfile(cliType).message_markers)
}

// RALPH_PROMPT removed — @ralph now starts a multi-agent RALPH pipeline
// (pipeline_engine.py, preset_key='ralph-pipeline') instead of injecting
// a single-agent self-grading prompt.
