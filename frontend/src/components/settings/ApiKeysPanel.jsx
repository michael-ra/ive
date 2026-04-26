import { useState, useEffect, useCallback } from 'react'
import {
  Key,
  X,
  Eye,
  EyeOff,
  CheckCircle,
  XCircle,
  Loader2,
  Trash2,
  ExternalLink,
} from 'lucide-react'
import { api } from '../../lib/api'

const SOURCE_COLORS = {
  observatory: 'text-cyan-400',
  deep_research: 'text-emerald-400',
  plugins: 'text-purple-400',
  model_discovery: 'text-amber-400',
  myelin: 'text-rose-400',
}

const SOURCE_LABELS = {
  observatory: 'Observatory',
  deep_research: 'Deep Research',
  plugins: 'Plugins',
  model_discovery: 'Model Discovery',
  myelin: 'Myelin',
}

export default function ApiKeysPanel({ onClose }) {
  const [keys, setKeys] = useState({})
  const [inputs, setInputs] = useState({})
  const [showValues, setShowValues] = useState({})
  const [testResults, setTestResults] = useState({})
  const [testingKey, setTestingKey] = useState(null)
  const [loading, setLoading] = useState(true)

  const loadKeys = useCallback(async () => {
    try {
      const result = await api.getApiKeys()
      if (result && typeof result === 'object') {
        setKeys(result)
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadKeys()
  }, [loadKeys])

  const handleSave = async (name) => {
    const value = inputs[name]
    if (!value?.trim()) return
    try {
      const updated = await api.saveApiKey(name, value.trim())
      if (updated && typeof updated === 'object') setKeys(updated)
      setInputs((p) => ({ ...p, [name]: '' }))
      setTestResults((p) => ({ ...p, [name]: null }))
    } catch {
      // ignore
    }
  }

  const handleDelete = async (name) => {
    try {
      const updated = await api.saveApiKey(name, '')
      if (updated && typeof updated === 'object') setKeys(updated)
      setTestResults((p) => ({ ...p, [name]: null }))
    } catch {
      // ignore
    }
  }

  const handleTest = async (name) => {
    setTestingKey(name)
    setTestResults((p) => ({ ...p, [name]: null }))
    try {
      const result = await api.testApiKey(name)
      setTestResults((p) => ({ ...p, [name]: result?.ok ? 'pass' : 'fail' }))
    } catch {
      setTestResults((p) => ({ ...p, [name]: 'fail' }))
    } finally {
      setTestingKey(null)
    }
  }

  const keyOrder = ['github', 'brave', 'producthunt', 'searxng', 'anthropic', 'google', 'huggingface']

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[560px] ide-panel overflow-hidden scale-in max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary sticky top-0 bg-bg-primary z-10">
          <Key size={14} className="text-amber-400" />
          <span className="text-xs text-text-primary font-medium">API Keys</span>
          <span className="text-[10px] text-blue-400/70 px-1.5 py-0.5 bg-blue-500/8 rounded border border-blue-500/15">Global</span>
          <span className="text-[10px] text-text-faint font-mono ml-1">optional — enhance IVE capabilities</span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-xs text-text-faint">
            <Loader2 size={14} className="animate-spin" />
            Loading...
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {keyOrder.map((name) => {
              const info = keys[name]
              if (!info) return null

              const hasKey = info.configured
              const source = info.source
              const testResult = testResults[name]
              const isTesting = testingKey === name
              const inputVal = inputs[name] || ''
              const showVal = showValues[name]

              return (
                <div
                  key={name}
                  className="p-3 bg-bg-secondary border border-border-secondary rounded-lg"
                >
                  {/* Title row */}
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-text-primary font-medium">{info.label}</span>
                    <div className="flex-1" />
                    {hasKey && (
                      <span
                        className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
                          source === 'env'
                            ? 'text-amber-400 bg-amber-500/10 border border-amber-500/20'
                            : 'text-cyan-400 bg-cyan-500/10 border border-cyan-500/20'
                        }`}
                      >
                        {source === 'env' ? `ENV: ${info.env_var}` : 'Saved'}
                      </span>
                    )}
                    {!hasKey && (
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded text-zinc-500 bg-zinc-800 border border-zinc-700/50">
                        Not configured
                      </span>
                    )}
                  </div>

                  {/* Description */}
                  <p className="text-[10px] text-text-faint leading-relaxed mb-2">{info.description}</p>

                  {/* Used by badges */}
                  <div className="flex items-center gap-1 mb-2.5">
                    <span className="text-[9px] text-zinc-600 font-mono">Used by:</span>
                    {info.used_by.map((feat) => (
                      <span
                        key={feat}
                        className={`text-[9px] font-mono px-1.5 py-0.5 rounded bg-zinc-800/50 ${
                          SOURCE_COLORS[feat] || 'text-zinc-400'
                        }`}
                      >
                        {SOURCE_LABELS[feat] || feat}
                      </span>
                    ))}
                  </div>

                  {hasKey ? (
                    <div className="flex items-center gap-1.5">
                      {/* Masked value */}
                      <div className="flex-1 px-2 py-1.5 text-[11px] font-mono bg-bg-primary border border-border-secondary rounded text-text-faint truncate">
                        {showVal && info.preview ? info.preview : '••••••••••••'}
                      </div>
                      <button
                        onClick={() => setShowValues((p) => ({ ...p, [name]: !p[name] }))}
                        className="p-1.5 text-text-faint hover:text-text-secondary transition-colors"
                        title={showVal ? 'Hide' : 'Show preview'}
                      >
                        {showVal ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                      {/* Test */}
                      <button
                        onClick={() => handleTest(name)}
                        disabled={isTesting}
                        className={`px-2.5 py-1.5 text-[10px] font-mono rounded border transition-colors flex items-center gap-1 ${
                          testResult === 'pass'
                            ? 'text-green-400 bg-green-500/10 border-green-500/20'
                            : testResult === 'fail'
                              ? 'text-red-400 bg-red-500/10 border-red-500/20'
                              : 'text-text-faint bg-bg-primary border-border-secondary hover:text-text-secondary hover:border-border-primary'
                        } disabled:opacity-50`}
                      >
                        {isTesting ? (
                          <><Loader2 size={10} className="animate-spin" /> Testing</>
                        ) : testResult === 'pass' ? (
                          <><CheckCircle size={10} /> Valid</>
                        ) : testResult === 'fail' ? (
                          <><XCircle size={10} /> Failed</>
                        ) : (
                          'Test'
                        )}
                      </button>
                      {/* Delete (only for DB-stored, not env) */}
                      {source !== 'env' && (
                        <button
                          onClick={() => handleDelete(name)}
                          className="p-1.5 text-text-faint hover:text-red-400 transition-colors"
                          title="Remove saved key"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <input
                        type={showVal ? 'text' : 'password'}
                        value={inputVal}
                        onChange={(e) => setInputs((p) => ({ ...p, [name]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSave(name) }}
                        placeholder={name === 'searxng' ? 'http://localhost:8888' : 'Paste key…'}
                        className="flex-1 px-2 py-1.5 text-[11px] font-mono bg-bg-primary border border-border-secondary rounded text-text-primary placeholder-text-faint focus:outline-none focus:border-accent-primary"
                      />
                      <button
                        onClick={() => setShowValues((p) => ({ ...p, [name]: !p[name] }))}
                        className="p-1.5 text-text-faint hover:text-text-secondary transition-colors"
                      >
                        {showVal ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                      <button
                        onClick={() => handleSave(name)}
                        disabled={!inputVal.trim()}
                        className="px-3 py-1.5 text-[10px] font-mono text-accent-primary bg-accent-subtle border border-accent-primary/30 rounded hover:bg-accent-primary/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        Save
                      </button>
                    </div>
                  )}
                </div>
              )
            })}

            <div className="pt-2 text-[10px] text-text-faint leading-relaxed border-t border-border-secondary">
              Keys saved here are stored in the local database and override environment variables.
              Env-sourced keys cannot be removed from here — unset the env var instead.
              All keys stay on your machine and are never sent to external services beyond their own API.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
