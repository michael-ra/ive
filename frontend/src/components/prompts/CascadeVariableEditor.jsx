import { useEffect, useMemo } from 'react'
import { Variable } from 'lucide-react'
import { extractVariables, syncVariableMetadata } from '../../lib/cascadeVariables'

/**
 * CascadeVariableEditor — auto-detects {variable_name} in cascade steps
 * and lets users annotate each with a label, description, and default value.
 *
 * Renders nothing when no variables are detected (zero friction for static cascades).
 *
 * Props:
 *   steps       — array of step strings (watched for variable detection)
 *   variables   — array of { key, label, description, default } metadata
 *   onVariablesChange — called when metadata changes
 */
export default function CascadeVariableEditor({ steps, variables, onVariablesChange }) {
  const detectedKeys = useMemo(() => extractVariables(steps), [steps])

  // Sync detected keys with existing metadata (add new, prune stale)
  useEffect(() => {
    const synced = syncVariableMetadata(detectedKeys, variables)
    // Only update if the set of keys changed (not on every metadata edit)
    const currentKeys = (variables || []).map(v => v.key).join(',')
    const syncedKeys = synced.map(v => v.key).join(',')
    if (currentKeys !== syncedKeys) {
      onVariablesChange(synced)
    }
  }, [detectedKeys]) // eslint-disable-line react-hooks/exhaustive-deps

  if (detectedKeys.length === 0) return null

  const updateVar = (key, field, value) => {
    onVariablesChange(
      (variables || []).map(v => v.key === key ? { ...v, [field]: value } : v)
    )
  }

  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1.5 text-xs font-medium text-x-ink-secondary">
        <Variable size={11} strokeWidth={1.75} className="text-x-accent" />
        Variables (auto-detected)
      </label>
      <div className="space-y-2">
        {(variables || []).map((v) => (
          <div
            key={v.key}
            className="px-2.5 py-2 bg-x-surface-2 border border-x-line rounded-md space-y-1.5"
          >
            <span className="inline-block px-1.5 py-0.5 text-[11px] font-mono font-medium text-x-accent bg-x-accent/15 rounded">
              {'{' + v.key + '}'}
            </span>
            <div className="grid grid-cols-3 gap-1.5">
              <input
                value={v.label || ''}
                onChange={(e) => updateVar(v.key, 'label', e.target.value)}
                placeholder="Label"
                className="px-2 py-1 text-[11px] bg-x-bg border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
              />
              <input
                value={v.description || ''}
                onChange={(e) => updateVar(v.key, 'description', e.target.value)}
                placeholder="Description / help text"
                className="px-2 py-1 text-[11px] bg-x-bg border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
              />
              <input
                value={v.default || ''}
                onChange={(e) => updateVar(v.key, 'default', e.target.value)}
                placeholder="Default value"
                className="px-2 py-1 text-[11px] bg-x-bg border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
