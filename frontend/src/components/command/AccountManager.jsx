import { useState, useEffect, useRef } from 'react'
import { User, X, Trash2, Plus, Eye, EyeOff, CheckCircle, AlertCircle, Zap, RefreshCw, Globe, SkipForward, Timer } from 'lucide-react'
import { api } from '../../lib/api'
import usePanelCreate from '../../hooks/usePanelCreate'
import useListKeyboardNav from '../../hooks/useListKeyboardNav'

/** Return remaining ms until `isoString` (UTC), or 0 if already past. */
function msUntil(isoString) {
  if (!isoString) return 0
  // Server stores UTC datetimes via datetime('now') — parse as UTC
  const target = new Date(isoString.endsWith('Z') ? isoString : isoString + 'Z')
  return Math.max(0, target.getTime() - Date.now())
}

/** Format ms remaining as "Xh Ym" or "Xm Ys". */
function fmtCooldown(ms) {
  if (ms <= 0) return null
  const totalSec = Math.ceil(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export default function AccountManager({ onClose }) {
  const [accounts, setAccounts] = useState([])
  const [selected, setSelected] = useState(null)
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const [showKey, setShowKey] = useState(false)
  const [mode, setMode] = useState('list') // list | create
  const [newName, setNewName] = useState('')
  const [newKey, setNewKey] = useState('')
  const [newDefault, setNewDefault] = useState(false)
  const [newBrowser, setNewBrowser] = useState('')
  const [newProfile, setNewProfile] = useState('')
  const [testing, setTesting] = useState(false)
  const [editBrowser, setEditBrowser] = useState('')
  const [editProfile, setEditProfile] = useState('')
  const [editingBrowser, setEditingBrowser] = useState(false)
  const [tick, setTick] = useState(0) // drives countdown re-renders
  const listRef = useRef(null)
  const panelRef = useRef(null)

  // Pull focus into the panel so arrow keys aren't swallowed by the terminal
  useEffect(() => { panelRef.current?.focus() }, [])

  useEffect(() => {
    api.getAccounts().then(setAccounts)
  }, [])

  // Tick every second while any account is cooling down, to update countdowns.
  useEffect(() => {
    const hasCooldown = accounts.some((a) => a.status === 'quota_exceeded' && msUntil(a.quota_reset_at) > 0)
    if (!hasCooldown) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [accounts])

  // When a cooldown timer hits zero, auto-refresh from backend to update status.
  useEffect(() => {
    const justExpired = accounts.some(
      (a) => a.status === 'quota_exceeded' && a.quota_reset_at && msUntil(a.quota_reset_at) === 0
    )
    if (justExpired) {
      api.getAccounts().then((updated) => {
        setAccounts(updated)
        if (selected) setSelected(updated.find((a) => a.id === selected.id) || null)
      })
    }
  }, [tick])

  const handleCreate = async (e) => {
    e?.preventDefault?.()
    if (!newName.trim()) return
    const hasKey = newKey.trim()
    const acc = await api.createAccount({
      name: newName.trim(),
      type: hasKey ? 'api_key' : 'oauth',
      api_key: hasKey ? newKey.trim() : undefined,
      is_default: newDefault,
      browser_path: newBrowser.trim() || undefined,
      chrome_profile: newProfile.trim() || undefined,
    })
    setAccounts([...accounts, acc])
    setMode('list')
    setNewName('')
    setNewKey('')
    setNewBrowser('')
    setNewProfile('')
  }

  // ⌘= opens the add-account form; ⌘↵ saves it.
  usePanelCreate({
    onAdd: () => setMode('create'),
    onSubmit: () => { if (mode === 'create') handleCreate() },
  })

  // Combined item list: system auth + user accounts, used for keyboard nav.
  const systemItem = { id: '__system', name: 'System Auth', type: 'oauth', status: 'active', api_key_masked: 'keychain' }
  const allItems = [systemItem, ...accounts]

  // Sync selectedIdx → selected and keep highlighted row visible.
  useEffect(() => {
    if (selectedIdx < 0 || selectedIdx >= allItems.length) return
    const item = allItems[selectedIdx]
    if (item && selected?.id !== item.id) {
      setSelected(item)
      setEditBrowser(item.browser_path || '')
      setEditProfile(item.chrome_profile || '')
      setEditingBrowser(false)
    }
    const el = listRef.current?.querySelector(`[data-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx, allItems.length])

  // ↑/↓ to navigate the account list, ⌘⌫ to delete (no-op on system row).
  useListKeyboardNav({
    enabled: mode !== 'create',
    itemCount: allItems.length,
    selectedIdx,
    setSelectedIdx,
    onActivate: (idx) => setSelected(allItems[idx]),
    onDelete: (idx) => {
      const item = allItems[idx]
      if (item && item.id !== '__system') handleDelete(item.id)
    },
  })

  const handleTest = async (acc) => {
    setTesting(true)
    try {
      const result = await api.testAccount(acc.id)
      // Refresh accounts to get updated status
      const updated = await api.getAccounts()
      setAccounts(updated)
      setSelected(updated.find((a) => a.id === acc.id) || null)
      alert(result.message || result.status)
    } catch (e) {
      alert('Test failed: ' + e.message)
    }
    setTesting(false)
  }

  const handleDelete = async (id) => {
    await api.deleteAccount(id)
    setAccounts(accounts.filter((a) => a.id !== id))
    if (selected?.id === id) setSelected(null)
  }

  const handleSetDefault = async (acc) => {
    // Clear other defaults
    for (const a of accounts) {
      if (a.is_default) await api.updateAccount(a.id, { is_default: 0 })
    }
    await api.updateAccount(acc.id, { is_default: 1 })
    const updated = await api.getAccounts()
    setAccounts(updated)
    setSelected(updated.find((a) => a.id === acc.id))
  }

  const handleClearCooldown = async (acc) => {
    await api.updateAccount(acc.id, { status: 'active', quota_reset_at: null })
    const updated = await api.getAccounts()
    setAccounts(updated)
    setSelected(updated.find((a) => a.id === acc.id))
  }

  /** Status dot CSS — cooldown (quota_exceeded with time remaining) gets an orange pulsing dot. */
  const statusDot = (item) => {
    if (item.status === 'quota_exceeded' && msUntil(item.quota_reset_at) > 0) return 'bg-amber-400 animate-pulse'
    if (item.status === 'active') return 'bg-green-400'
    if (item.status === 'quota_exceeded') return 'bg-red-400'
    return 'bg-zinc-600'
  }

  const inputClass = 'w-full px-2.5 py-1.5 text-[11px] bg-[#111118] border border-zinc-700 rounded text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 font-mono'

  // Summary counts for header
  const cooldownCount = accounts.filter((a) => a.status === 'quota_exceeded' && msUntil(a.quota_reset_at) > 0).length
  const activeCount = accounts.filter((a) => a.status === 'active').length

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-[600px] max-h-[70vh] bg-[#111118] border border-zinc-700 rounded-lg shadow-2xl overflow-hidden flex flex-col animate-in outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1 px-4 py-1.5 border-b border-zinc-800">
          <User size={14} className="text-indigo-400" />
          <span className="text-[11px] text-zinc-300 font-mono font-medium">Accounts</span>
          <span className="text-[11px] text-zinc-600 font-mono">{activeCount} active</span>
          {cooldownCount > 0 && (
            <span className="flex items-center gap-0.5 text-[11px] text-amber-400 font-mono">
              <Timer size={9} /> {cooldownCount} cooling
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={async () => {
              try {
                const result = await api.openNextAccount()
                if (result.ok) {
                  // Refresh accounts to update last_used_at
                  api.getAccounts().then(setAccounts)
                } else {
                  alert(result.error || result.message || 'No available accounts')
                }
              } catch (e) {
                alert(e.message || 'No available accounts')
              }
            }}
            className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-mono text-emerald-500 hover:text-emerald-300 hover:bg-emerald-800/20 rounded transition-colors"
            title="Open the next available non-API account in its configured browser"
          >
            <SkipForward size={10} /> open next
          </button>
          <button
            onClick={() => setMode(mode === 'create' ? 'list' : 'create')}
            className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-mono text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded transition-colors"
          >
            <Plus size={10} /> add
          </button>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"><X size={16} /></button>
        </div>

        {mode === 'create' && (
          <form onSubmit={handleCreate} className="p-4 border-b border-zinc-800 space-y-2">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Account name (e.g. Personal Max, Work Max)" className={inputClass} autoFocus />
            <input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="API key (optional — leave blank for OAuth/subscription)" type="password" className={inputClass} />
            <div className="border border-zinc-800 rounded p-2 space-y-1.5">
              <p className="text-[11px] text-zinc-500 font-mono uppercase">Browser / Chrome Profile</p>
              <input value={newBrowser} onChange={(e) => setNewBrowser(e.target.value)} placeholder="Browser path (e.g. Google Chrome, /Applications/Brave Browser.app)" className={inputClass} />
              <input value={newProfile} onChange={(e) => setNewProfile(e.target.value)} placeholder="Chrome profile directory (e.g. Profile 1, Default)" className={inputClass} />
              <p className="text-[11px] text-zinc-600 font-mono leading-relaxed">
                For non-API accounts: assign a browser and Chrome profile so "open next" launches the right session.
              </p>
            </div>
            <p className="text-[11px] text-zinc-600 font-mono leading-relaxed">
              <strong className="text-zinc-400">API key:</strong> paste sk-ant-... above. <strong className="text-zinc-400">OAuth/Max subscription:</strong> leave blank, create account, then run <code className="text-indigo-400">claude auth login</code> in a terminal and click "snapshot auth".
            </p>
            <label className="flex items-center gap-1 text-[11px] text-zinc-400 font-mono cursor-pointer">
              <input type="checkbox" checked={newDefault} onChange={(e) => setNewDefault(e.target.checked)} />
              set as default for new sessions
            </label>
            <div className="flex gap-1">
              <button type="submit" className="px-2.5 py-1.5 text-[11px] bg-indigo-600 hover:bg-indigo-500 text-white rounded font-mono">add account</button>
              <button type="button" onClick={() => setMode('list')} className="px-2.5 py-1.5 text-[11px] bg-zinc-800 text-zinc-400 rounded font-mono">cancel</button>
            </div>
          </form>
        )}

        <div className="flex flex-1 min-h-0">
          {/* List */}
          <div ref={listRef} className="w-[200px] border-r border-zinc-800 overflow-y-auto">
            {allItems.map((item, idx) => {
              const cd = item.status === 'quota_exceeded' ? fmtCooldown(msUntil(item.quota_reset_at)) : null
              return (
                <button
                  key={item.id}
                  data-idx={idx}
                  onClick={() => setSelectedIdx(idx)}
                  className={`w-full text-left px-2.5 py-1.5 border-b border-zinc-800/30 transition-colors ${
                    selectedIdx === idx
                      ? 'bg-indigo-600/10 text-zinc-200 ring-1 ring-inset ring-indigo-500/40'
                      : selected?.id === item.id ? 'bg-indigo-600/10 text-zinc-200' : 'text-zinc-400 hover:bg-zinc-800/40'
                  }`}
                >
                  <div className="flex items-center gap-1">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${item.id === '__system' ? 'bg-green-400' : statusDot(item)}`} />
                    <span className="text-[11px] font-mono truncate">{item.name}</span>
                    {item.is_default ? <span className="text-[8px] text-indigo-400 font-mono shrink-0">DEFAULT</span> : null}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] text-zinc-600 font-mono truncate">
                      {item.id === '__system' ? 'keychain / claude auth' : (item.api_key_masked || item.type)}
                      {item.chrome_profile && <span className="text-zinc-700"> · {item.chrome_profile}</span>}
                    </span>
                    {cd && (
                      <span className="flex items-center gap-0.5 text-[9px] text-amber-400/80 font-mono shrink-0 ml-auto">
                        <Timer size={8} /> {cd}
                      </span>
                    )}
                  </div>
                </button>
              )
            })}

            {accounts.length === 0 && (
              <div className="p-3 text-[11px] text-zinc-600 font-mono text-center">
                no API key accounts — using system auth
              </div>
            )}
          </div>

          {/* Detail */}
          <div className="flex-1 overflow-y-auto p-4">
            {selected ? (
              <div className="space-y-3 text-[11px] font-mono">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-200 text-[11px] font-medium">{selected.name}</span>
                  <div className="flex items-center gap-1">
                    {(() => {
                      const cd = selected.status === 'quota_exceeded' ? fmtCooldown(msUntil(selected.quota_reset_at)) : null
                      if (cd) {
                        return (
                          <span className="flex items-center gap-1 text-[11px] text-amber-400">
                            <Timer size={10} className="animate-pulse" />
                            cooldown
                          </span>
                        )
                      }
                      return (
                        <span className={`flex items-center gap-1 text-[11px] ${
                          selected.status === 'active' ? 'text-green-400' :
                          selected.status === 'quota_exceeded' ? 'text-red-400' : 'text-zinc-500'
                        }`}>
                          {selected.status === 'active' ? <CheckCircle size={10} /> : <AlertCircle size={10} />}
                          {selected.status}
                        </span>
                      )
                    })()}
                  </div>
                </div>

                {/* Cooldown banner */}
                {(() => {
                  if (selected.status !== 'quota_exceeded') return null
                  const remaining = msUntil(selected.quota_reset_at)
                  const cd = fmtCooldown(remaining)
                  if (!cd) return null
                  // Progress bar: 4h = 14400000ms total
                  const totalMs = 4 * 60 * 60 * 1000
                  const elapsed = totalMs - remaining
                  const pct = Math.min(100, Math.max(0, (elapsed / totalMs) * 100))
                  return (
                    <div className="bg-amber-500/10 border border-amber-500/30 rounded p-2 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1 text-amber-300">
                          <Timer size={11} className="animate-pulse" />
                          Usage depleted — cooling down
                        </span>
                        <span className="text-amber-200 font-medium">{cd}</span>
                      </div>
                      <div className="w-full h-1 bg-amber-900/40 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-amber-400 rounded-full transition-all duration-1000"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-amber-500/70">
                        <span>resets {selected.quota_reset_at}</span>
                        <button
                          onClick={() => handleClearCooldown(selected)}
                          className="text-amber-400 hover:text-amber-200 underline"
                        >clear cooldown</button>
                      </div>
                    </div>
                  )
                })()}

                <div className="grid grid-cols-2 gap-1">
                  <div>
                    <label className="text-[11px] text-zinc-600 uppercase">Type</label>
                    <p className="text-zinc-300">{selected.type}</p>
                  </div>
                  <div>
                    <label className="text-[11px] text-zinc-600 uppercase">API Key</label>
                    <p className="text-zinc-300 flex items-center gap-1">
                      {showKey ? (selected.api_key || selected.api_key_masked) : (selected.api_key_masked || '***')}
                      <button onClick={() => setShowKey(!showKey)} className="text-zinc-500 hover:text-zinc-300">
                        {showKey ? <EyeOff size={10} /> : <Eye size={10} />}
                      </button>
                    </p>
                  </div>
                </div>

                {/* Browser / Chrome profile settings */}
                {selected.id !== '__system' && (
                  <div className="border border-zinc-800 rounded p-2 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] text-zinc-500 font-mono uppercase">Browser / Profile</p>
                      {!editingBrowser ? (
                        <button
                          onClick={() => setEditingBrowser(true)}
                          className="text-[11px] text-zinc-600 hover:text-zinc-400 font-mono"
                        >edit</button>
                      ) : (
                        <button
                          onClick={async () => {
                            await api.updateAccount(selected.id, {
                              browser_path: editBrowser || null,
                              chrome_profile: editProfile || null,
                            })
                            const updated = await api.getAccounts()
                            setAccounts(updated)
                            setSelected(updated.find((a) => a.id === selected.id))
                            setEditingBrowser(false)
                          }}
                          className="text-[11px] text-indigo-400 hover:text-indigo-300 font-mono"
                        >save</button>
                      )}
                    </div>
                    {editingBrowser ? (
                      <>
                        <input
                          value={editBrowser}
                          onChange={(e) => setEditBrowser(e.target.value)}
                          placeholder="Browser (e.g. Google Chrome, /Applications/Brave Browser.app)"
                          className={inputClass}
                        />
                        <input
                          value={editProfile}
                          onChange={(e) => setEditProfile(e.target.value)}
                          placeholder="Chrome profile (e.g. Profile 1, Default)"
                          className={inputClass}
                        />
                      </>
                    ) : (
                      <div className="grid grid-cols-2 gap-1">
                        <div>
                          <label className="text-[11px] text-zinc-600">Browser</label>
                          <p className="text-zinc-400 text-[11px] truncate">{selected.browser_path || 'default'}</p>
                        </div>
                        <div>
                          <label className="text-[11px] text-zinc-600">Profile</label>
                          <p className="text-zinc-400 text-[11px] truncate">{selected.chrome_profile || 'none'}</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {selected.id !== '__system' && (
                  <div className="flex flex-wrap gap-1 pt-2">
                    {selected.api_key && (
                      <button
                        onClick={() => handleTest(selected)}
                        disabled={testing}
                        className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors disabled:opacity-50"
                      >
                        <Zap size={10} />
                        {testing ? 'testing...' : 'test key'}
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        try {
                          const result = await api.openAccountBrowser(selected.id)
                          if (!result.ok) alert(result.error || 'Failed to open browser')
                        } catch (e) {
                          alert('Failed: ' + e.message)
                        }
                      }}
                      className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 rounded transition-colors"
                      title="Open this account's browser with its configured profile"
                    >
                      <Globe size={10} />
                      open browser
                    </button>
                    <button
                      onClick={async () => {
                        const result = await api.snapshotAccount(selected.id)
                        if (result.ok) {
                          alert(`Auth snapshotted: ${result.files} files captured. This account can now run in its own sandbox.`)
                          const updated = await api.getAccounts()
                          setAccounts(updated)
                          setSelected(updated.find((a) => a.id === selected.id))
                        } else {
                          alert(result.error || 'Snapshot failed')
                        }
                      }}
                      className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 rounded transition-colors"
                      title="Capture current ~/.claude/ auth state for this account"
                    >
                      <RefreshCw size={10} />
                      snapshot auth
                    </button>
                    {!selected.is_default && (
                      <button
                        onClick={() => handleSetDefault(selected)}
                        className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 rounded transition-colors"
                      >
                        <CheckCircle size={10} />
                        set default
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(selected.id)}
                      className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] text-red-400 hover:bg-red-400/10 rounded transition-colors ml-auto"
                    >
                      <Trash2 size={10} />
                      delete
                    </button>
                  </div>
                )}

                {selected.id === '__system' && (
                  <p className="text-[11px] text-zinc-600 leading-relaxed">
                    System auth uses whatever <code>claude auth login</code> set up on this machine.
                    All sessions without an explicit API key account use this.
                    Run <code>claude auth login</code> in any terminal to switch.
                  </p>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-zinc-600 text-[11px] font-mono">
                select an account
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
