import useStore from '../state/store'
import { EFFORT_LEVELS, effortOptions, effortDisplay } from './effort'

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

export { EFFORT_LEVELS }

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
  { id: 'codex', label: 'Codex' },
  { id: 'antigravity', label: 'Antigravity' },
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

// Offline fallback only: the real list comes from /api/cli-info, which reads
// the account's models from $CODEX_HOME/models_cache.json at backend start.
export const CODEX_MODELS = [
  { id: '', label: 'Default', description: 'Use Codex CLI config' },
]

export const CODEX_APPROVAL_MODES = [
  { id: 'default', label: 'Default', description: 'Ask for each action' },
  { id: 'auto', label: 'Auto', description: 'Approve most actions automatically' },
  { id: 'dontAsk', label: "Don't Ask", description: 'Never ask, deny if not allowed' },
  { id: 'bypassPermissions', label: 'Bypass All', description: 'Skip all permission checks' },
]

export const ANTIGRAVITY_MODELS = [
  { id: '', label: 'Default', description: 'Use Antigravity CLI config' },
  { id: 'Gemini 3.5 Flash (High)', label: 'Gemini 3.5 Flash High', description: 'Fast high-effort Antigravity setting' },
  { id: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro High', description: 'Highest Antigravity setting' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Gemini Pro' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Fast Gemini' },
]

export const ANTIGRAVITY_APPROVAL_MODES = [
  { id: 'default', label: 'Default', description: 'Ask for each action' },
  { id: 'bypassPermissions', label: 'Bypass All', description: 'Skip permission prompts' },
]

const MODEL_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

function modelText(model) {
  return String(model?.label || model?.id || '')
}

function modelVersionParts(model) {
  const match = modelText(model).match(/\d+(?:\.\d+)*/)
  if (!match) return []
  return match[0].split('.').map((part) => Number.parseInt(part, 10) || 0)
}

function modelFamily(model) {
  const text = modelText(model)
    .toLowerCase()
    .replace(/\d+(?:\.\d+)*/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\b(pro|flash|lite|mini|spark|codex|opus|sonnet|haiku|high|medium|low|preview|stable|default)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return text || modelText(model).toLowerCase()
}

function modelTier(model) {
  const text = modelText(model).toLowerCase()
  if (/\b(pro|opus)\b/.test(text)) return 0
  if (/\bsonnet\b/.test(text)) return 1
  if (/\bflash\b/.test(text) && !/\b(lite|mini)\b/.test(text)) return 2
  if (/\b(lite|mini|spark)\b/.test(text)) return 3
  if (/\bhaiku\b/.test(text)) return 4
  return 5
}

function modelQuality(model) {
  const text = modelText(model).toLowerCase()
  if (/\bhigh\b/.test(text)) return 0
  if (/\bmedium\b/.test(text)) return 1
  if (/\blow\b/.test(text)) return 2
  return 3
}

function compareVersionsDesc(a, b) {
  const av = modelVersionParts(a)
  const bv = modelVersionParts(b)
  const len = Math.max(av.length, bv.length)
  for (let i = 0; i < len; i += 1) {
    const diff = (bv[i] || 0) - (av[i] || 0)
    if (diff) return diff
  }
  return 0
}

export function sortModelOptions(models = []) {
  return [...models].sort((a, b) => {
    if ((a?.id || '') === '') return -1
    if ((b?.id || '') === '') return 1

    const familyDiff = MODEL_COLLATOR.compare(modelFamily(a), modelFamily(b))
    if (familyDiff) return familyDiff

    const versionDiff = compareVersionsDesc(a, b)
    if (versionDiff) return versionDiff

    const tierDiff = modelTier(a) - modelTier(b)
    if (tierDiff) return tierDiff

    const qualityDiff = modelQuality(a) - modelQuality(b)
    if (qualityDiff) return qualityDiff

    return MODEL_COLLATOR.compare(modelText(a), modelText(b))
  })
}

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
// Availability is required for lifecycle choices; unknown state fails closed.

export function getCliTypes() {
  try {
    const profiles = useStore.getState().cliProfiles
    const values = Object.values(profiles || {})
      .filter((profile) => (
        profile
        && profile.active !== false
        && !profile.deprecated
        && profile.available === true
      ))
      .map((profile) => ({ id: profile.id, label: profile.label || profile.id }))
    if (values.length) return values
  } catch (e) { /* store not ready */ }
  return []
}

export function getCliLabel(cliType) {
  return getCliTypes().find((ct) => ct.id === cliType)?.label || cliType || 'Claude'
}

export function getProfileForCli(cliType) {
  try {
    const profile = useStore.getState().cliProfiles?.[cliType]
    if (profile && profile.active !== false && !profile.deprecated) return profile
  } catch (e) { /* store not ready */ }
  return null
}

export function getModelsForCli(cliType) {
  try {
    const profiles = useStore.getState().cliProfiles
    const profile = profiles?.[cliType]
    if (profile?.deprecated || profile?.active === false) return []
    if (profile?.available_models?.length) {
      return cliType === 'claude' ? profile.available_models : sortModelOptions(profile.available_models)
    }
  } catch (e) { /* store not ready */ }
  if (cliType === 'gemini') return []
  if (cliType === 'codex') return sortModelOptions(CODEX_MODELS)
  if (cliType === 'antigravity') return sortModelOptions(ANTIGRAVITY_MODELS)
  return MODELS
}

function rawPermissionModesForCli(cliType) {
  try {
    const profiles = useStore.getState().cliProfiles
    const profile = profiles?.[cliType]
    if (profile?.deprecated || profile?.active === false) return []
    if (profile?.available_permission_modes?.length) {
      return profile.available_permission_modes
    }
  } catch (e) { /* store not ready */ }
  if (cliType === 'gemini') return []
  if (cliType === 'codex') return CODEX_APPROVAL_MODES
  if (cliType === 'antigravity') return ANTIGRAVITY_APPROVAL_MODES
  return PERMISSION_MODES
}

export function getPermissionModesForCli(cliType) {
  return rawPermissionModesForCli(cliType).map(mode => {
    if (['bypassPermissions', 'yolo'].includes(mode.id)) return {
      ...mode, label: 'Skip agent approvals',
      description: cliType === 'codex'
        ? 'Skips Codex approvals and disables its sandbox. Additional IVE checks still apply.'
        : 'Skips the agent’s permission prompts. Additional IVE checks still apply.',
    }
    return mode
  })
}

export function getEffortLevelsForCli(cliType) {
  try {
    const profiles = useStore.getState().cliProfiles
    const profile = profiles?.[cliType]
    if (profile?.deprecated || profile?.active === false) return []
    if (profile?.effort_levels !== undefined) {
      return profile.effort_levels
    }
  } catch (e) { /* store not ready */ }
  if (cliType === 'claude') return EFFORT_LEVELS
  return []
}

// Effort <select> options for a CLI: [{value:'', label:'Default (xhigh, ...)'}, ...levels].
// Empty when the CLI has no effort setting.
export function getEffortOptionsForCli(cliType, model) {
  let profile = null
  try { profile = useStore.getState().cliProfiles?.[cliType] } catch (e) { /* store not ready */ }
  return effortOptions(getEffortLevelsForCli(cliType), profile, model)
}

export function getEffortDisplay(cliType, value, model) {
  let profile = null
  try { profile = useStore.getState().cliProfiles?.[cliType || 'claude'] } catch (e) { /* store not ready */ }
  return effortDisplay(value, profile, model)
}

export function getDefaultModel(cliType) {
  try {
    const profiles = useStore.getState().cliProfiles
    const profile = profiles?.[cliType]
    if (profile?.deprecated || profile?.active === false) return ''
    if (profile?.default_model) {
      return profile.default_model
    }
  } catch (e) { /* store not ready */ }
  if (cliType === 'gemini') return ''
  if (cliType === 'codex' || cliType === 'antigravity') return ''
  return 'sonnet'
}

export function getRoleDefaultModel(cliType, role = 'worker') {
  const profile = getProfileForCli(cliType)
  if (profile) {
    if (role === 'commander' && profile.default_commander_model !== undefined) {
      return profile.default_commander_model
    }
    if ((role === 'tester' || role === 'documentor') && profile.default_tester_model !== undefined) {
      return profile.default_tester_model
    }
    if (profile.default_model !== undefined) return profile.default_model
  }
  if (cliType === 'codex') return ''  // Codex config.toml decides
  if (cliType === 'antigravity') {
    if (role === 'commander') return 'Gemini 3.1 Pro (High)'
    if (role === 'tester' || role === 'documentor') return 'Gemini 3.5 Flash (High)'
    return ''
  }
  if (role === 'commander') return 'opus'
  return getDefaultModel(cliType)
}

export function getSessionModelLabel(session) {
  if (!session) return ''
  // Plain terminal (cli_type "shell"): no model, it is just a shell.
  if (session.cli_type === 'shell') return 'Terminal'
  const explicit = String(session.model || '').trim()
  if (explicit) return explicit

  const cliType = session.cli_type || 'claude'
  const tags = Array.isArray(session.tags) ? session.tags
    : typeof session.tags === 'string' ? (() => { try { return JSON.parse(session.tags) } catch { return [] } })()
    : []
  const role = session.session_type === 'commander'
    ? 'commander'
    : tags.includes('capability_testing')
      ? 'tester'
      : tags.includes('capability_documentation')
        ? 'documentor'
        : 'worker'

  const roleDefault = getRoleDefaultModel(cliType, role)
  if (roleDefault) return roleDefault

  const defaultOption = getModelsForCli(cliType).find((m) => (m.id || '') === '')
  const defaultLabel = String(defaultOption?.label || '').trim()
  if (defaultLabel && defaultLabel.toLowerCase() !== 'default') return defaultLabel

  return `${getCliLabel(cliType)} default`
}

export function getDefaultPermissionMode(cliType) {
  try {
    const profiles = useStore.getState().cliProfiles
    const profile = profiles?.[cliType]
    if (profile?.deprecated || profile?.active === false) return 'default'
    if (profile?.default_permission_mode) {
      return profile.default_permission_mode
    }
  } catch (e) { /* store not ready */ }
  if (cliType === 'gemini') return 'default'
  if (cliType === 'codex') return 'auto'
  if (cliType === 'antigravity') return 'default'
  return 'default'
}

export function getCliCapability(cliType, capability) {
  try {
    const profiles = useStore.getState().cliProfiles
    const profile = profiles?.[cliType]
    if (profile?.deprecated || profile?.active === false) return false
    return profile?.ui_capabilities?.[capability] ?? false
  } catch (e) { /* store not ready */ }
  // Static fallbacks
  if (capability === 'force_send') return cliType === 'claude' || cliType === 'codex' || cliType === 'antigravity'
  return false
}

export function getMessageMarkers(cliType) {
  try {
    const profiles = useStore.getState().cliProfiles
    const markers = profiles?.[cliType]?.message_markers
    if (markers?.length) return new Set(markers)
  } catch (e) { /* store not ready */ }
  return cliType === 'gemini' ? new Set(['\u2726', '>']) : new Set(['\u23FA', '>'])
}

// RALPH_PROMPT removed — @ralph now starts a multi-agent RALPH pipeline
// (pipeline_engine.py, preset_key='ralph-pipeline') instead of injecting
// a single-agent self-grading prompt.
