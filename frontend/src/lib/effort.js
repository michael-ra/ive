// Reasoning effort helpers. Pure (no store import) so node tests can load it.
//
// '' means "pass no --effort": the CLI then uses its own default, which for
// Claude is CLAUDE_CODE_EFFORT_LEVEL / modelSettings / effortLevel from the
// user's settings, NOT "high". The backend resolves that value and sends it
// as profile.effort_default ({ value, source, label, by_model }).

// Values `claude --effort` accepts (2.1.296).
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

export function effortDefaultValue(profile, model) {
  const def = profile?.effort_default
  if (!def) return null
  if (model && def.by_model && def.by_model[model]) return def.by_model[model]
  return def.value || null
}

// Label for the "nothing chosen" option of an effort picker.
export function effortDefaultLabel(profile, model) {
  const def = profile?.effort_default
  if (!def) return 'Default (CLI setting)'
  if (model && def.by_model && def.by_model[model]) {
    return `Default (${def.by_model[model]}, your Claude settings for ${model})`
  }
  return def.label || (def.value ? `Default (${def.value})` : 'Default (CLI picks per model)')
}

// Options for an effort <select>: the default entry first, then the levels.
export function effortOptions(levels, profile, model) {
  if (!levels || levels.length === 0) return []
  return [
    { value: '', label: effortDefaultLabel(profile, model) },
    ...levels.map((level) => ({ value: level, label: level })),
  ]
}

// Short text for read-only displays (cards, template details).
export function effortDisplay(value, profile, model) {
  if (value) return value
  const def = effortDefaultValue(profile, model)
  return def ? `${def} (default)` : 'default'
}

// What the chat header shows. `observed` comes from
// GET /api/sessions/:id/runtime-model (the CLI's own transcript), so a
// `/model` or `/effort` switch inside the terminal shows up after the next
// turn. Falls back to the launch config, then to the resolved default.
export function headerModelInfo(session, observed, profile, launched) {
  const configuredModel = session?.model || ''
  const configuredEffort = session?.effort || ''
  const model = observed?.model || launched || configuredModel || 'default'
  const effort = observed?.effort || configuredEffort || effortDefaultValue(profile, configuredModel) || ''
  const parts = []
  if (observed?.model) {
    parts.push(`Last turn ran on ${observed.model}${observed.effort ? ` at ${observed.effort} effort` : ''} (from the CLI transcript).`)
    if (configuredModel && observed.model !== configuredModel && !observed.model.includes(configuredModel)) {
      parts.push(`Configured: ${configuredModel}. The last recorded turn differs from this choice.`)
    }
  } else {
    parts.push(`Launch setting: ${configuredModel || 'CLI default model'}, ${configuredEffort ? `${configuredEffort} effort` : effortDefaultLabel(profile, configuredModel).toLowerCase()}.`)
  }
  return { model, effort, observed: Boolean(observed?.model), title: parts.join(' ') }
}
