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

// ─── CLI Types ──────────────────────────────────────
export const CLI_TYPES = [
  { id: 'claude', label: 'Claude' },
  { id: 'gemini', label: 'Gemini' },
]

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

export function getModelsForCli(cliType) {
  try {
    const { default: useStore } = require('../state/store')
    const profiles = useStore.getState().cliProfiles
    if (profiles?.[cliType]?.available_models?.length) {
      return profiles[cliType].available_models
    }
  } catch (e) { /* store not ready */ }
  return cliType === 'gemini' ? GEMINI_MODELS : MODELS
}

export function getPermissionModesForCli(cliType) {
  try {
    const { default: useStore } = require('../state/store')
    const profiles = useStore.getState().cliProfiles
    if (profiles?.[cliType]?.available_permission_modes?.length) {
      return profiles[cliType].available_permission_modes
    }
  } catch (e) { /* store not ready */ }
  return cliType === 'gemini' ? GEMINI_APPROVAL_MODES : PERMISSION_MODES
}

export function getEffortLevelsForCli(cliType) {
  try {
    const { default: useStore } = require('../state/store')
    const profiles = useStore.getState().cliProfiles
    if (profiles?.[cliType]?.effort_levels !== undefined) {
      return profiles[cliType].effort_levels
    }
  } catch (e) { /* store not ready */ }
  return cliType === 'claude' ? EFFORT_LEVELS : []
}

export function getDefaultModel(cliType) {
  try {
    const { default: useStore } = require('../state/store')
    const profiles = useStore.getState().cliProfiles
    if (profiles?.[cliType]?.default_model) {
      return profiles[cliType].default_model
    }
  } catch (e) { /* store not ready */ }
  return cliType === 'gemini' ? 'gemini-2.5-pro' : 'sonnet'
}

export function getDefaultPermissionMode(cliType) {
  try {
    const { default: useStore } = require('../state/store')
    const profiles = useStore.getState().cliProfiles
    if (profiles?.[cliType]?.default_permission_mode) {
      return profiles[cliType].default_permission_mode
    }
  } catch (e) { /* store not ready */ }
  return cliType === 'gemini' ? 'auto_edit' : 'default'
}

export function getCliCapability(cliType, capability) {
  try {
    const { default: useStore } = require('../state/store')
    const profiles = useStore.getState().cliProfiles
    return profiles?.[cliType]?.ui_capabilities?.[capability] ?? false
  } catch (e) { /* store not ready */ }
  // Static fallbacks
  if (capability === 'force_send') return cliType === 'claude'
  return false
}

export function getMessageMarkers(cliType) {
  try {
    const { default: useStore } = require('../state/store')
    const profiles = useStore.getState().cliProfiles
    const markers = profiles?.[cliType]?.message_markers
    if (markers?.length) return new Set(markers)
  } catch (e) { /* store not ready */ }
  return cliType === 'gemini' ? new Set(['\u2726', '>']) : new Set(['\u23FA', '>'])
}

// RALPH_PROMPT removed — @ralph now starts a multi-agent RALPH pipeline
// (pipeline_engine.py, preset_key='ralph-pipeline') instead of injecting
// a single-agent self-grading prompt.
