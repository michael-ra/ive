import HelpDetails from '../ui/HelpDetails'
import { useState, useEffect, useCallback } from 'react'
import {
  Eye,
  EyeOff,
  CheckCircle,
  XCircle,
  Loader2,
  Trash2,
  Pencil,
} from 'lucide-react'
import { api } from '../../lib/api'
import { Button, IconButton } from '../ui'

const SOURCE_LABELS = {
  observatory: 'Observatory',
  deep_research: 'Deep Research',
  plugins: 'Plugins',
  model_discovery: 'Model Discovery',
  myelin: 'Myelin',
}

export default function ApiKeysPanel({ selectedKey } = {}) {
  const [keys, setKeys] = useState({})
  const [inputs, setInputs] = useState({})
  const [showValues, setShowValues] = useState({})
  const [testResults, setTestResults] = useState({})
  const [testingKey, setTestingKey] = useState(null)
  const [editing, setEditing] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadKeys = useCallback(async () => {
    try {
      setError('')
      const result = await api.getApiKeys()
      if (result && typeof result === 'object') {
        setKeys(result)
      }
    } catch (cause) {
      setError(cause.message || 'Could not load connections.')
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
      setError('')
      const updated = await api.saveApiKey(name, value.trim())
      if (updated && typeof updated === 'object') setKeys(updated)
      setInputs((p) => ({ ...p, [name]: '' }))
      setTestResults((p) => ({ ...p, [name]: null }))
      setEditing((p) => ({ ...p, [name]: false }))
    } catch (cause) {
      setError(cause.message || 'Could not save this connection. Try again.')
    }
  }

  const handleDelete = async (name) => {
    try {
      const updated = await api.saveApiKey(name, '')
      if (updated && typeof updated === 'object') setKeys(updated)
      setTestResults((p) => ({ ...p, [name]: null }))
    } catch (cause) {
      setError(cause.message || 'Could not remove this key.')
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
    <div className="h-full overflow-y-auto">
        {error && <div role="alert" className="ive-connector-error">{error}</div>}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-xs text-x-muted">
            <Loader2 size={14} className="animate-spin" />
            Loading...
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {keyOrder.filter(name => !selectedKey || name === selectedKey).map((name) => {
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
                  className="p-3 bg-x-surface border border-x-line rounded-lg"
                >
                  {/* Title row */}
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-x-ink font-medium">{info.label}</span>
                    <div className="flex-1" />
                    {hasKey && (
                      <span
                        className={`text-[11px] font-medium px-1.5 py-0.5 rounded-md border ${
                          source === 'env'
                            ? 'text-x-accent-ink bg-x-accent-ink/10 border-x-accent-ink/30'
                            : 'text-x-accent bg-x-tint border-x-accent/30'
                        }`}
                      >
                        {source === 'env' ? `ENV: ${info.env_var}` : 'Saved'}
                      </span>
                    )}
                    {!hasKey && (
                      <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-md text-x-muted bg-x-hover border border-x-line">
                        Not configured
                      </span>
                    )}
                  </div>

                  {/* Description */}
                  <HelpDetails><p className="text-[11px] text-x-muted leading-relaxed mb-2">{info.description}</p></HelpDetails>

                  {/* Used by badges */}
                  <div className="flex items-center gap-1 mb-2.5 flex-wrap">
                    <span className="text-[11px] text-x-faint">Used by:</span>
                    {info.used_by.map((feat) => (
                      <span
                        key={feat}
                        className="text-[11px] px-1.5 py-0.5 rounded-md bg-x-hover text-x-ink-secondary"
                      >
                        {SOURCE_LABELS[feat] || feat}
                      </span>
                    ))}
                  </div>

                  {hasKey && !editing[name] ? (
                    <div className="flex items-center gap-1.5">
                      {/* Masked value */}
                      <div className="flex-1 h-8 flex items-center px-2 text-[13px] font-mono bg-x-surface-2 border border-x-line rounded-md text-x-muted truncate">
                        {showVal && info.preview ? info.preview : '••••••••••••'}
                      </div>
                      <IconButton
                        icon={showVal ? EyeOff : Eye}
                        label={showVal ? 'Hide key preview' : 'Show key preview'}
                        onClick={() => setShowValues((p) => ({ ...p, [name]: !p[name] }))}
                      />
                      {/* Test */}
                      <Button
                        onClick={() => handleTest(name)}
                        disabled={isTesting}
                        size="sm"
                        className={testResult === 'pass' ? 'text-x-good' : testResult === 'fail' ? 'text-x-accent-ink' : ''}
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
                      </Button>
                      {/* Replace — override the current key (works for env-sourced too) */}
                      <IconButton
                        icon={Pencil}
                        label={source === 'env' ? 'Override the environment key' : 'Replace saved key'}
                        onClick={() => setEditing((p) => ({ ...p, [name]: true }))}
                      />
                      {/* Delete (only for DB-stored, not env) */}
                      {source !== 'env' && (
                        <IconButton
                          icon={Trash2}
                          label="Remove saved key"
                          variant="destructive"
                          onClick={() => handleDelete(name)}
                        />
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <input
                        type={showVal ? 'text' : 'password'}
                        value={inputVal}
                        onChange={(e) => setInputs((p) => ({ ...p, [name]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSave(name) }}
                        placeholder={
                          name === 'searxng'
                            ? 'http://localhost:8888'
                            : hasKey
                              ? (source === 'env' ? 'Paste key to override env…' : 'Paste new key to replace…')
                              : 'Paste key…'
                        }
                        autoFocus={!!editing[name]}
                        className="flex-1 h-8 px-2 text-[13px] font-mono bg-x-surface border border-x-line-strong rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                      />
                      <IconButton
                        icon={showVal ? EyeOff : Eye}
                        label={showVal ? 'Hide key' : 'Show key'}
                        onClick={() => setShowValues((p) => ({ ...p, [name]: !p[name] }))}
                      />
                      <Button
                        onClick={() => handleSave(name)}
                        disabled={!inputVal.trim()}
                        variant="primary"
                        size="sm"
                      >
                        Save
                      </Button>
                      {hasKey && (
                        <Button
                          onClick={() => {
                            setEditing((p) => ({ ...p, [name]: false }))
                            setInputs((p) => ({ ...p, [name]: '' }))
                          }}
                          size="sm"
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            <HelpDetails label="Key storage"><div className="pt-2 text-[11px] text-x-muted leading-relaxed border-t border-x-line">
              Keys saved here are stored in the local database and override environment variables.
              Env-sourced keys cannot be removed from here — unset the env var instead.
              All keys stay on your machine and are never sent to external services beyond their own API.
            </div></HelpDetails>
          </div>
        )}
    </div>
  )
}
