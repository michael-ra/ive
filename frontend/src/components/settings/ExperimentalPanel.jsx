import { useState, useEffect, useCallback } from 'react'
import { FlaskConical, X, AlertTriangle, Check, Info } from 'lucide-react'
import { api } from '../../lib/api'

/**
 * ExperimentalPanel — toggle surface for opt-in experimental features.
 *
 * Every feature requires an explicit click to turn on. Features that modify
 * the system prompt display a prominent warning before the toggle. Nothing
 * here changes Commander's behavior until the user opts in.
 */
export default function ExperimentalPanel({ onClose }) {
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
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[720px] max-h-[80vh] ide-panel overflow-hidden scale-in flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary">
          <FlaskConical size={14} className="text-amber-400" />
          <span className="text-xs text-text-secondary font-medium">
            Experimental Features
          </span>
          <span className="text-[10px] text-amber-400/80 font-mono uppercase px-1.5 py-0.5 bg-amber-500/10 rounded border border-amber-500/20">
            opt-in
          </span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Intro */}
        <div className="px-4 py-3 bg-amber-500/5 border-b border-amber-500/20">
          <div className="flex items-start gap-2">
            <Info size={12} className="text-amber-400 mt-0.5 shrink-0" />
            <div className="text-[11px] text-text-secondary leading-relaxed">
              Experimental features are disabled by default and may change,
              break, or be removed at any time. Features marked{' '}
              <span className="inline-flex items-center gap-1 px-1 py-0.5 text-[10px] bg-amber-500/15 text-amber-400 border border-amber-500/25 rounded">
                <AlertTriangle size={9} /> modifies prompt
              </span>{' '}
              add text to the system prompt of every new session, which
              affects token usage and model behavior. Read each feature's
              full description before enabling.
            </div>
          </div>
        </div>

        {/* Feature list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="px-4 py-10 text-xs text-text-faint text-center">
              loading…
            </div>
          ) : features.length === 0 ? (
            <div className="px-4 py-10 text-xs text-text-faint text-center">
              No experimental features available.
            </div>
          ) : (
            features.map((f) => {
              const isExpanded = expandedKey === f.key
              return (
                <div
                  key={f.key}
                  className="px-4 py-3 border-b border-border-secondary"
                >
                  <div className="flex items-start gap-3">
                    {/* Toggle */}
                    <button
                      onClick={() => toggleFeature(f, !f.enabled)}
                      disabled={busyKey === f.key}
                      className={`shrink-0 mt-0.5 relative inline-block w-9 h-5 rounded-full transition-colors disabled:opacity-50 ${
                        f.enabled
                          ? 'bg-accent-primary'
                          : 'bg-bg-tertiary border border-border-secondary'
                      }`}
                      aria-label={`Toggle ${f.label}`}
                    >
                      <span
                        className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all ${
                          f.enabled ? 'left-[18px]' : 'left-0.5'
                        }`}
                      />
                    </button>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs text-text-primary font-mono font-medium">
                          {f.label}
                        </span>
                        {f.modifies_prompt && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-amber-500/15 text-amber-400 border border-amber-500/25 rounded">
                            <AlertTriangle size={9} /> modifies prompt
                          </span>
                        )}
                        {f.enabled && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 rounded">
                            <Check size={9} /> enabled
                          </span>
                        )}
                        {f.category && (
                          <span className="text-[10px] text-text-faint font-mono">
                            {f.category}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-text-muted mt-1 leading-relaxed">
                        {f.description}
                      </p>
                      <button
                        onClick={() =>
                          setExpandedKey(isExpanded ? null : f.key)
                        }
                        className="text-[10px] text-accent-primary hover:text-accent-hover mt-1.5"
                      >
                        {isExpanded ? 'hide details' : 'details + tradeoffs'}
                      </button>

                      {isExpanded && (
                        <div className="mt-2 p-2.5 bg-bg-inset rounded border border-border-secondary">
                          <pre className="text-[11px] text-text-secondary font-mono leading-relaxed whitespace-pre-wrap">
                            {f.long_description}
                          </pre>
                          {f.added_in && (
                            <div className="mt-2 pt-2 border-t border-border-secondary text-[10px] text-text-faint font-mono">
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
    </div>
  )
}
