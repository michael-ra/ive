import { useState, useEffect } from 'react'
import { X, Sparkles, Loader2, Save, RotateCcw, FileText, Shield, ListOrdered, Check } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { MODELS, GEMINI_MODELS, CLI_TYPES, getModelsForCli } from '../../lib/constants'

const ARTIFACT_TYPES = [
  { id: 'guideline', label: 'Guideline', icon: Shield, description: 'Reusable rules & principles for future sessions' },
  { id: 'prompt', label: 'Prompt', icon: FileText, description: 'A reusable prompt template' },
  { id: 'cascade', label: 'Cascade', icon: ListOrdered, description: 'Multi-step prompt sequence' },
]

export default function DistillPanel({ onClose, initialResult, initialArtifactType }) {
  const activeSessionId = useStore((s) => s.activeSessionId)
  const session = useStore((s) => s.sessions[s.activeSessionId])

  // If opened with a pre-loaded result (from notification), go straight to preview mode
  const hasInitial = !!initialResult

  const [artifactType, setArtifactType] = useState(initialArtifactType || 'guideline')
  const [cli, setCli] = useState('claude')
  const [model, setModel] = useState('')
  const [instructions, setInstructions] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(initialResult || null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const models = getModelsForCli(cli)

  const handleGenerate = async () => {
    if (!activeSessionId) return
    setError(null)

    try {
      const data = await api.distillSession(activeSessionId, {
        type: artifactType,
        cli,
        model: model || undefined,
        instructions: instructions || undefined,
      })
      if (data.error) {
        setError(data.error)
      } else {
        // Job started in background — close panel, user will be notified
        setSubmitted(true)
        setTimeout(() => onClose(), 1500)
      }
    } catch (e) {
      setError(e.message || 'Failed to start distill')
    }
  }

  const handleSave = async () => {
    if (!result) return
    setSaving(true)
    setError(null)

    try {
      const type = result.type || artifactType
      if (type === 'guideline') {
        await api.createGuideline({
          name: result.name,
          content: result.content,
        })
      } else if (type === 'prompt') {
        await api.createPrompt({
          name: result.name,
          category: result.category || 'General',
          content: result.content,
          variables: result.variables || '',
        })
      } else if (type === 'cascade') {
        await api.createCascade({
          name: result.name,
          steps: result.steps || [],
        })
      }
      setSaved(true)
    } catch (e) {
      setError(e.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  // No active session and no pre-loaded result
  if (!session && !hasInitial) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
        <div className="ide-panel p-6 w-[480px] scale-in" onClick={(e) => e.stopPropagation()}>
          <p className="text-sm text-text-faint">No active session to distill.</p>
        </div>
      </div>
    )
  }

  const effectiveType = result?.type || artifactType

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="ide-panel w-[560px] max-h-[85vh] flex flex-col scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border-primary">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-accent-primary" />
            <span className="text-sm font-medium text-text-primary">
              {hasInitial ? 'Distill Preview' : 'Distill Session'}
            </span>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-bg-hover rounded text-text-faint">
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Submitted confirmation */}
          {submitted && !result && (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-accent-subtle border border-accent-primary/30">
              <Check size={14} className="text-accent-primary" />
              <span className="text-xs text-accent-primary">
                Distilling in background — you'll be notified when it's ready.
              </span>
            </div>
          )}

          {/* Input form — only show when not viewing a result */}
          {!result && !submitted && (
            <>
              {/* Session info */}
              {session && (
                <div className="text-xs text-text-faint">
                  Extracting from: <span className="text-text-secondary">{session.name}</span>
                </div>
              )}

              {/* Artifact type picker */}
              <div>
                <label className="block text-[11px] text-text-faint uppercase tracking-wider mb-2">Extract as</label>
                <div className="grid grid-cols-3 gap-2">
                  {ARTIFACT_TYPES.map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      onClick={() => setArtifactType(id)}
                      className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border text-xs transition-all ${
                        artifactType === id
                          ? 'border-accent-primary bg-accent-subtle text-accent-primary'
                          : 'border-border-secondary bg-bg-secondary text-text-secondary hover:border-border-primary hover:bg-bg-hover'
                      }`}
                    >
                      <Icon size={18} />
                      <span className="font-medium">{label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* CLI + Model picker */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-text-faint uppercase tracking-wider mb-1.5">CLI</label>
                  <select
                    value={cli}
                    onChange={(e) => { setCli(e.target.value); setModel('') }}
                    className="w-full px-3 py-2 text-xs bg-bg-secondary border border-border-secondary rounded-md text-text-primary focus:outline-none focus:border-accent-primary"
                  >
                    {CLI_TYPES.map(({ id, label }) => (
                      <option key={id} value={id}>{label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-text-faint uppercase tracking-wider mb-1.5">Model</label>
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-bg-secondary border border-border-secondary rounded-md text-text-primary focus:outline-none focus:border-accent-primary"
                  >
                    <option value="">Default</option>
                    {models.map(({ id, label }) => (
                      <option key={id} value={id}>{label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Instructions */}
              <div>
                <label className="block text-[11px] text-text-faint uppercase tracking-wider mb-1.5">
                  Additional instructions <span className="normal-case">(optional)</span>
                </label>
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="e.g. Focus on the testing patterns, ignore the debugging tangent..."
                  rows={2}
                  className="w-full px-3 py-2 text-xs bg-bg-secondary border border-border-secondary rounded-md text-text-primary placeholder-text-faint focus:outline-none focus:border-accent-primary resize-none"
                />
              </div>

              {/* Generate button */}
              <button
                onClick={handleGenerate}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-xs font-medium bg-accent-primary text-white hover:brightness-110 transition-all"
              >
                <Sparkles size={14} />
                Distill {ARTIFACT_TYPES.find((t) => t.id === artifactType)?.label}
              </button>
            </>
          )}

          {/* Error */}
          {error && (
            <div className="px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-xs text-red-400">
              {error}
            </div>
          )}

          {/* Result preview (from background job notification or inbox) */}
          {result && (
            <div className="space-y-3 border border-border-primary rounded-lg p-4 bg-bg-secondary">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-text-faint uppercase tracking-wider">
                  {ARTIFACT_TYPES.find((t) => t.id === effectiveType)?.label || 'Result'} Preview
                </span>
              </div>

              {/* Editable name */}
              <div>
                <label className="block text-[10px] text-text-faint mb-1">Name</label>
                <input
                  value={result.name || ''}
                  onChange={(e) => setResult({ ...result, name: e.target.value })}
                  className="w-full px-3 py-1.5 text-xs bg-bg-primary border border-border-secondary rounded text-text-primary focus:outline-none focus:border-accent-primary"
                />
              </div>

              {/* Type-specific fields */}
              {effectiveType === 'prompt' && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-text-faint mb-1">Category</label>
                    <input
                      value={result.category || ''}
                      onChange={(e) => setResult({ ...result, category: e.target.value })}
                      className="w-full px-3 py-1.5 text-xs bg-bg-primary border border-border-secondary rounded text-text-primary focus:outline-none focus:border-accent-primary"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-text-faint mb-1">Variables</label>
                    <input
                      value={result.variables || ''}
                      onChange={(e) => setResult({ ...result, variables: e.target.value })}
                      className="w-full px-3 py-1.5 text-xs bg-bg-primary border border-border-secondary rounded text-text-primary focus:outline-none focus:border-accent-primary"
                    />
                  </div>
                </div>
              )}

              {/* Content / Steps */}
              {effectiveType === 'cascade' ? (
                <div>
                  <label className="block text-[10px] text-text-faint mb-1">Steps ({(result.steps || []).length})</label>
                  <div className="space-y-2">
                    {(result.steps || []).map((step, i) => (
                      <div key={i} className="flex gap-2 items-start">
                        <span className="text-[10px] text-text-faint mt-1.5 w-4 text-right shrink-0">{i + 1}.</span>
                        <textarea
                          value={step}
                          onChange={(e) => {
                            const newSteps = [...result.steps]
                            newSteps[i] = e.target.value
                            setResult({ ...result, steps: newSteps })
                          }}
                          rows={2}
                          className="flex-1 px-2 py-1.5 text-xs bg-bg-primary border border-border-secondary rounded text-text-primary focus:outline-none focus:border-accent-primary resize-none"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div>
                  <label className="block text-[10px] text-text-faint mb-1">Content</label>
                  <textarea
                    value={result.content || ''}
                    onChange={(e) => setResult({ ...result, content: e.target.value })}
                    rows={8}
                    className="w-full px-3 py-2 text-xs bg-bg-primary border border-border-secondary rounded text-text-primary focus:outline-none focus:border-accent-primary resize-y font-mono leading-relaxed"
                  />
                </div>
              )}

              {/* Save button */}
              <button
                onClick={handleSave}
                disabled={saving || saved}
                className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-xs font-medium transition-all ${
                  saved
                    ? 'bg-green-600/20 text-green-400 border border-green-500/30'
                    : 'bg-accent-primary text-white hover:brightness-110 disabled:opacity-50'
                }`}
              >
                {saving ? (
                  <><Loader2 size={14} className="animate-spin" /> Saving...</>
                ) : saved ? (
                  <>Saved!</>
                ) : (
                  <><Save size={14} /> Save {ARTIFACT_TYPES.find((t) => t.id === effectiveType)?.label}</>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
