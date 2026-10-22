/**
 * Cascade variable detection, substitution, and metadata sync.
 *
 * Variables use {variable_name} syntax in cascade step text.
 * Only identifiers match: {foo}, {my_var2} — not {1,2} or {}.
 */

const CASCADE_VAR_REGEX = /\{([a-zA-Z_]\w*)\}/g

/**
 * Extract unique variable keys from an array of step strings.
 * Returns keys in order of first appearance, deduplicated.
 */
export function extractVariables(steps) {
  const seen = new Set()
  const keys = []
  for (const step of steps) {
    let m
    const re = new RegExp(CASCADE_VAR_REGEX.source, 'g')
    while ((m = re.exec(step)) !== null) {
      const key = m[1]
      if (!seen.has(key)) {
        seen.add(key)
        keys.push(key)
      }
    }
  }
  return keys
}

/**
 * Check if any steps contain variables.
 */
export function hasVariables(steps) {
  return steps.some(s => new RegExp(CASCADE_VAR_REGEX.source).test(s))
}

/**
 * Substitute all {key} occurrences across steps with provided values.
 * Returns a new array of steps with substitutions applied.
 */
export function substituteVariables(steps, values) {
  return steps.map(step =>
    step.replace(new RegExp(CASCADE_VAR_REGEX.source, 'g'), (match, key) =>
      key in values ? values[key] : match
    )
  )
}

/**
 * Merge auto-detected keys with existing variable metadata.
 * - New keys get a default entry { key, label: key, description: '', default: '' }
 * - Removed keys are dropped
 * - Existing metadata for retained keys is preserved
 * - Order follows extraction order (first appearance in steps)
 */
export function syncVariableMetadata(detectedKeys, existingMeta) {
  const metaMap = new Map((existingMeta || []).map(m => [m.key, m]))
  return detectedKeys.map(key =>
    metaMap.get(key) || { key, label: key, description: '', default: '' }
  )
}
