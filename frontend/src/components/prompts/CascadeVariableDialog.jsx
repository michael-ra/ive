import { useState, useMemo, useRef, useEffect } from 'react'
import { Variable, Play, X } from 'lucide-react'
import useStore from '../../state/store'
import { extractVariables, syncVariableMetadata, substituteVariables } from '../../lib/cascadeVariables'

/**
 * CascadeVariableDialog — runtime input modal for cascade variables.
 *
 * Self-gating: renders only when cascadeVariablePending is non-null.
 * Prompts the user for variable values, substitutes them into steps,
 * then calls executeCascade to start the run.
 */
export default function CascadeVariableDialog() {
  const pending = useStore((s) => s.cascadeVariablePending)
  const executeCascade = useStore((s) => s.executeCascade)
  const resumeCascadeWithVariables = useStore((s) => s.resumeCascadeWithVariables)
  const clearPending = useStore((s) => s.clearCascadeVariablePending)
  const firstInputRef = useRef(null)

  // Build the variable list from metadata or auto-detect
  const vars = useMemo(() => {
    if (!pending) return []
    const keys = extractVariables(pending.cascade.steps)
    return syncVariableMetadata(keys, pending.cascade.variables || [])
  }, [pending])

  // State: { [key]: value } — initialized from defaults or previous values
  const [values, setValues] = useState({})

  // Reset values when pending changes
  useEffect(() => {
    if (!pending || vars.length === 0) return
    const lastValues = pending.cascade._lastVariableValues || {}
    setValues(
      Object.fromEntries(vars.map(v => [v.key, lastValues[v.key] ?? v.default ?? '']))
    )
    // Focus first input after render
    setTimeout(() => firstInputRef.current?.focus(), 50)
  }, [pending, vars])

  if (!pending || vars.length === 0) return null

  const { cascade, sessionId, isLoopReprompt, iteration } = pending

  const handleSubmit = (e) => {
    e?.preventDefault?.()
    if (isLoopReprompt && cascade._runId) {
      // Server-side loop reprompt — resume the existing backend run
      resumeCascadeWithVariables(sessionId, cascade._runId, values)
      clearPending()
    } else {
      // Fresh cascade start
      const resolvedSteps = substituteVariables(cascade.steps, values)
      executeCascade(sessionId, {
        ...cascade,
        _lastVariableValues: values,
        _iteration: iteration || 0,
      }, resolvedSteps)
    }
  }

  const handleCancel = () => {
    clearPending()
  }

  const updateValue = (key, val) => {
    setValues(prev => ({ ...prev, [key]: val }))
  }

  return (
    <div
      className="fixed inset-0 z-[55] flex items-start justify-center pt-[14vh] bg-black/60"
      onClick={handleCancel}
    >
      <div
        className="w-[520px] ide-panel overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary">
          <Variable size={14} className="text-indigo-400" />
          <span className="text-xs text-text-secondary font-medium">
            {isLoopReprompt ? 'Re-prompt Variables' : 'Cascade Variables'}
          </span>
          <span className="text-[10px] text-indigo-400 font-mono truncate max-w-[200px]">
            {cascade.name}
          </span>
          {isLoopReprompt && iteration > 0 && (
            <span className="text-[10px] text-text-faint font-mono">
              iteration #{iteration + 1}
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={handleCancel}
            className="p-1 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Variable inputs */}
        <form onSubmit={handleSubmit} className="p-4 space-y-3 max-h-[55vh] overflow-y-auto">
          <div className="text-[10px] text-text-faint">
            Fill in the values below. They will replace <code className="bg-bg-inset px-1 rounded">{'{ }'}</code> placeholders in all cascade steps.
          </div>

          {vars.map((v, idx) => (
            <div key={v.key} className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="inline-block px-1.5 py-0.5 text-[10px] font-mono font-medium text-indigo-300 bg-indigo-500/15 rounded">
                  {'{' + v.key + '}'}
                </span>
                {v.label && v.label !== v.key && (
                  <span className="text-[11px] text-text-secondary font-medium">{v.label}</span>
                )}
              </div>
              {v.description && (
                <div className="text-[10px] text-text-faint">{v.description}</div>
              )}
              <input
                ref={idx === 0 ? firstInputRef : undefined}
                value={values[v.key] || ''}
                onChange={(e) => updateValue(v.key, e.target.value)}
                placeholder={v.default ? `default: ${v.default}` : `value for ${v.label || v.key}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && idx === vars.length - 1) {
                    e.preventDefault()
                    handleSubmit()
                  }
                }}
                className="w-full px-2.5 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono"
              />
            </div>
          ))}

          <div className="flex gap-1.5 pt-1">
            <button
              type="submit"
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-indigo-500/80 hover:bg-indigo-500 text-white rounded-md transition-colors"
            >
              <Play size={10} />
              {isLoopReprompt ? 'continue' : 'run cascade'}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="px-3 py-1.5 text-xs font-medium bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded-md transition-colors"
            >
              cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
