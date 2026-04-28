import { useState, useEffect } from 'react'
import { Sparkles, Loader2 } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'

export default function FirstLaunchOnboarding({ onDone }) {
  const setMyName = useStore((s) => s.setMyName)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    const t = setTimeout(() => {
      const el = document.getElementById('owner-name-input')
      el?.focus()
    }, 60)
    return () => clearTimeout(t)
  }, [])

  const handleSave = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Pick a name — agents address you by it in nudges and briefings.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.setAppSetting('owner_name', trimmed)
      await api.setAppSetting('owner_intro_completed_at', new Date().toISOString())
      // Override the random "Drift Lynx"-style peer identity with the
      // real owner name so terminal greetings, peer messages, and
      // multiplayer presence all show it.
      setMyName?.(trimmed)
      onDone?.(trimmed)
    } catch (e) {
      setError(e?.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleSkip = async () => {
    setSaving(true)
    try {
      // Stamp completion so we don't pester next launch — owner can fill in
      // via Settings later.
      await api.setAppSetting('owner_intro_completed_at', new Date().toISOString())
    } catch {
      /* non-fatal */
    } finally {
      setSaving(false)
      onDone?.(null)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[200] p-4">
      <div className="bg-zinc-950 border border-zinc-800 rounded-lg w-full max-w-md">
        <div className="px-6 py-5 border-b border-zinc-800 flex items-start gap-3">
          <Sparkles size={18} className="text-indigo-400 mt-0.5" />
          <div>
            <h2 className="text-zinc-100 text-base font-semibold">Welcome to IVE</h2>
            <p className="text-zinc-500 text-[12px] mt-1">
              What should agents call you? Used in nudges, briefings, and shared with joiners so they know whose workspace they're in.
            </p>
          </div>
        </div>

        <div className="p-6 space-y-3">
          <input
            id="owner-name-input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !saving) handleSave()
            }}
            placeholder="e.g. Michael"
            maxLength={64}
            className="w-full bg-zinc-900 border border-zinc-800 rounded text-zinc-100 text-sm px-3 py-2 focus:outline-none focus:border-indigo-600"
          />
          {error && (
            <div className="text-rose-400 text-[11px] font-mono">{error}</div>
          )}

          <div className="flex items-center justify-between pt-2">
            <button
              onClick={handleSkip}
              disabled={saving}
              className="text-[11px] text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
            >
              Skip for now
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !name.trim()}
              className="px-4 py-1.5 text-[12px] bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded transition-colors flex items-center gap-1.5"
            >
              {saving && <Loader2 size={12} className="animate-spin" />}
              Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
