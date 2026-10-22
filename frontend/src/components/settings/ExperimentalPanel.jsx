import { useState, useEffect, useCallback } from 'react'
import { AlertTriangle, Info } from 'lucide-react'
import { api } from '../../lib/api'
import { Button } from '../ui'

/**
 * ExperimentalPanel — toggle surface for opt-in experimental features.
 *
 * Every feature requires an explicit click to turn on. Features that modify
 * the system prompt display a prominent warning before the toggle. Nothing
 * here changes Commander's behavior until the user opts in.
 */
export default function ExperimentalPanel() {
  const [features, setFeatures] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState(null)
  const [expandedKey, setExpandedKey] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.getExperimentalFeatures()
      setFeatures(data.features || [])
    } catch (err) {
      console.error('failed to load experimental features:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const toggleFeature = async (feature, nextEnabled) => {
    // Hard confirmation before enabling anything that modifies the prompt.
    if (nextEnabled && feature.modifies_prompt) {
      const ok = confirm(
        `Enable "${feature.label}"?\n\n` +
        `⚠ This feature adds text to the system prompt of every new session.\n\n` +
        `Tradeoffs:\n` +
        `  • Adds tokens to every session's system prompt\n` +
        `  • May cause extra tool calls at normal billing rates\n` +
        `  • Marked experimental — behavior may change or break\n\n` +
        `Only enable this if you understand and accept these tradeoffs.`
      )
      if (!ok) return
    }

    setBusyKey(feature.key)
    try {
      await api.setAppSetting(feature.key, nextEnabled ? 'on' : 'off')
      await refresh()
    } catch (err) {
      alert(`Failed to update setting: ${err.message}`)
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
        {/* Intro */}
        <div className="px-4 py-3 bg-x-accent-ink/10 border-b border-x-accent-ink/25">
          <div className="flex items-start gap-2">
            <Info size={12} className="text-x-accent-ink mt-0.5 shrink-0" />
            <div className="text-[11px] text-x-ink-secondary leading-relaxed">
              Experimental features may change or stop working. “Modifies prompt” features
              affect new sessions and token usage. Read the details before enabling.
            </div>
          </div>
        </div>

        {/* Feature list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="px-4 py-10 text-xs text-x-muted text-center">
              Loading…
            </div>
          ) : features.length === 0 ? (
            <div className="px-4 py-10 text-xs text-x-muted text-center">
              No experimental features available.
            </div>
          ) : (
            features.map((f) => {
              const isExpanded = expandedKey === f.key
              return (
                <div
                  key={f.key}
                  className="px-4 py-3 border-b border-x-line-subtle"
                >
                  <div className="flex items-start gap-3">
                    {/* Toggle */}
                    <Button
                      type="button"
                      onClick={() => toggleFeature(f, !f.enabled)}
                      disabled={busyKey === f.key}
                      toggleState={f.enabled}
                      shape="card"
                      size="sm"
                      className="mt-0.5 min-w-[70px] shrink-0"
                      aria-label={`Toggle ${f.label}`}
                    >
                      {f.enabled ? 'On' : 'Off'}
                    </Button>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs text-x-ink font-medium">
                          {f.label}
                        </span>
                        {f.modifies_prompt && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium bg-x-accent-ink/10 text-x-accent-ink border border-x-accent-ink/30 rounded-md">
                            <AlertTriangle size={9} /> modifies prompt
                          </span>
                        )}
                        {f.category && (
                          <span className="text-[11px] text-x-muted">
                            {f.category}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-x-muted mt-1 leading-relaxed">
                        {f.description}
                      </p>
                      <Button
                        onClick={() =>
                          setExpandedKey(isExpanded ? null : f.key)
                        }
                        size="sm"
                        className="mt-1.5"
                      >
                        {isExpanded ? 'Hide details' : 'Details'}
                      </Button>

                      {isExpanded && (
                        <div className="mt-2 p-2.5 bg-x-surface-2 rounded-md border border-x-line-subtle">
                          <pre className="text-[11px] text-x-ink-secondary font-mono leading-relaxed whitespace-pre-wrap">
                            {f.long_description}
                          </pre>
                          {f.added_in && (
                            <div className="mt-2 pt-2 border-t border-x-line-subtle text-[11px] text-x-faint font-mono">
                              added: {f.added_in}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
    </div>
  )
}
