import { useState, useEffect, useCallback, useRef } from 'react'
import {
  X,
  Telescope,
  Search,
  Settings,
  ChevronDown,
  RefreshCw,
  Play,
  GitBranch,
  Rocket,
  Newspaper,
  Layers,
  ToggleLeft,
  ToggleRight,
  Key,
} from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import FindingCard from './FindingCard'

const COLUMNS = [
  { key: 'new', label: 'New' },
  { key: 'reviewing', label: 'Reviewing' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'dismissed', label: 'Dismissed' },
  { key: 'promoted', label: 'Promoted' },
]

const columnAccent = {
  new: 'text-cyan-400',
  reviewing: 'text-amber-400',
  accepted: 'text-indigo-400',
  dismissed: 'text-zinc-500',
  promoted: 'text-green-400',
}

const SOURCE_TABS = [
  { key: 'all', label: 'All', icon: Layers },
  { key: 'github', label: 'GitHub', icon: GitBranch },
  { key: 'producthunt', label: 'Product Hunt', icon: Rocket },
  { key: 'hackernews', label: 'Hacker News', icon: Newspaper },
]

const DEFAULT_SOURCE_SETTINGS = {
  github: { enabled: true, interval_hours: 6, mode: 'both', keywords: '' },
  producthunt: { enabled: true, interval_hours: 12, mode: 'integrate', keywords: '' },
  hackernews: { enabled: true, interval_hours: 12, mode: 'both', keywords: '' },
}

const sourceIcons = {
  github: GitBranch,
  producthunt: Rocket,
  hackernews: Newspaper,
}

const sourceLabels = {
  github: 'GitHub',
  producthunt: 'Product Hunt',
  hackernews: 'Hacker News',
}

const sourceColors = {
  github: 'text-zinc-400',
  producthunt: 'text-orange-400',
  hackernews: 'text-amber-400',
}

export default function ObservatoryBoard({ onClose }) {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)

  const [findings, setFindings] = useState([])
  const [sourceFilter, setSourceFilter] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [dragOverCol, setDragOverCol] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showScanMenu, setShowScanMenu] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [settings, setSettings] = useState(DEFAULT_SOURCE_SETTINGS)
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [apiKeys, setApiKeys] = useState({})

  const searchRef = useRef(null)
  const scanMenuRef = useRef(null)
  const boardRef = useRef(null)

  // ── Data loading ──────────────────────────────────────────────────────────
  const loadFindings = useCallback(async () => {
    try {
      const params = {}
      if (activeWorkspaceId) params.workspace_id = activeWorkspaceId
      if (sourceFilter !== 'all') params.source = sourceFilter
      const result = await api.getObservatoryFindings(params)
      const list = Array.isArray(result) ? result : result?.findings || []
      setFindings(list)
    } catch {
      // endpoint may not exist yet
    }
  }, [activeWorkspaceId, sourceFilter])

  const loadSettings = useCallback(async () => {
    if (!activeWorkspaceId) return
    try {
      const result = await api.getObservatorySettings(activeWorkspaceId)
      if (result?.sources) {
        setSettings((prev) => ({ ...prev, ...result.sources }))
      }
    } catch {
      // use defaults
    }
  }, [activeWorkspaceId])

  useEffect(() => {
    loadFindings()
  }, [loadFindings])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  // ── API Keys status (for indicators) ────────────────────────────────────
  const loadApiKeys = useCallback(async () => {
    try {
      const result = await api.getApiKeys()
      if (result && typeof result === 'object') {
        setApiKeys(result)
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    if (showSettings) loadApiKeys()
  }, [showSettings, loadApiKeys])

  // Close scan dropdown on outside click
  useEffect(() => {
    if (!showScanMenu) return
    const handler = (e) => {
      if (scanMenuRef.current && !scanMenuRef.current.contains(e.target)) {
        setShowScanMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showScanMenu])

  // Escape handling
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        if (showSettings) {
          e.stopImmediatePropagation()
          setShowSettings(false)
        } else if (showScanMenu) {
          e.stopImmediatePropagation()
          setShowScanMenu(false)
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [showSettings, showScanMenu])

  // ── Filtering ─────────────────────────────────────────────────────────────
  const query = searchQuery.toLowerCase().trim()
  const filteredFindings = findings.filter((f) => {
    if (sourceFilter !== 'all' && f.source !== sourceFilter) return false
    if (!query) return true
    const tags = Array.isArray(f.tags) ? f.tags.join(' ') : ''
    return (
      (f.title || '').toLowerCase().includes(query) ||
      (f.proposal || '').toLowerCase().includes(query) ||
      (f.category || '').toLowerCase().includes(query) ||
      tags.toLowerCase().includes(query)
    )
  })

  const findingsByColumn = {}
  for (const col of COLUMNS) {
    findingsByColumn[col.key] = filteredFindings.filter((f) => f.status === col.key)
  }

  const totalCount = filteredFindings.length

  // ── Drag-and-drop ─────────────────────────────────────────────────────────
  const handleDragOver = useCallback((e, colKey) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverCol(colKey)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverCol(null)
  }, [])

  const handleDrop = useCallback(
    async (e, colKey) => {
      e.preventDefault()
      setDragOverCol(null)
      const findingId = e.dataTransfer.getData('text/plain')
      if (!findingId) return
      const finding = findings.find((f) => f.id === findingId)
      if (!finding || finding.status === colKey) return

      // Optimistic update
      setFindings((prev) =>
        prev.map((f) => (f.id === findingId ? { ...f, status: colKey } : f))
      )
      try {
        await api.updateObservatoryFinding(findingId, { status: colKey })
        // If promoted, also create a task
        if (colKey === 'promoted' && activeWorkspaceId) {
          await api.promoteObservatoryFinding(findingId, activeWorkspaceId)
        }
      } catch {
        // Revert on error
        setFindings((prev) =>
          prev.map((f) => (f.id === findingId ? finding : f))
        )
      }
    },
    [findings, activeWorkspaceId]
  )

  // ── Actions ───────────────────────────────────────────────────────────────
  const handlePromote = async (finding) => {
    if (!activeWorkspaceId) return
    try {
      await api.promoteObservatoryFinding(finding.id, activeWorkspaceId)
      setFindings((prev) =>
        prev.map((f) => (f.id === finding.id ? { ...f, status: 'promoted' } : f))
      )
    } catch {
      // ignore
    }
  }

  const handleStatusChange = async (finding, newStatus) => {
    setFindings((prev) =>
      prev.map((f) => (f.id === finding.id ? { ...f, status: newStatus } : f))
    )
    try {
      await api.updateObservatoryFinding(finding.id, { status: newStatus })
    } catch {
      setFindings((prev) =>
        prev.map((f) => (f.id === finding.id ? finding : f))
      )
    }
  }

  const handleScan = async (source) => {
    setShowScanMenu(false)
    setScanning(true)
    try {
      const data = { workspace_id: activeWorkspaceId }
      if (source !== 'all') data.source = source
      await api.triggerObservatoryScan(data)
      // Reload findings after scan
      await loadFindings()
    } catch {
      // ignore
    } finally {
      setScanning(false)
    }
  }

  const handleStartObservatorist = async () => {
    if (!activeWorkspaceId) return
    try {
      await api.createObservatorist(activeWorkspaceId)
    } catch {
      // ignore
    }
  }

  const handleSaveSettings = async () => {
    if (!activeWorkspaceId) return
    try {
      await api.updateObservatorySettings({
        workspace_id: activeWorkspaceId,
        sources: settings,
      })
      setSettingsDirty(false)
    } catch {
      // ignore
    }
  }

  const updateSourceSetting = (source, key, value) => {
    setSettings((prev) => ({
      ...prev,
      [source]: { ...prev[source], [key]: value },
    }))
    setSettingsDirty(true)
  }


  // ── Stats ─────────────────────────────────────────────────────────────────
  const newCount = findingsByColumn.new?.length || 0
  const acceptedCount = findingsByColumn.accepted?.length || 0
  const promotedCount = findingsByColumn.promoted?.length || 0

  return (
    <div
      className="fixed inset-0 z-50 bg-[#0a0a0f]/95 backdrop-blur-sm flex flex-col"
      data-observatory-overlay
      onClick={onClose}
    >
      <div
        ref={boardRef}
        className="flex-1 flex flex-col m-4 bg-[#111118] border border-zinc-700 rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-1.5 px-5 py-3 border-b border-zinc-800 shrink-0">
          <Telescope size={14} className="text-cyan-400" />
          <span className="text-[11px] text-zinc-200 font-mono font-semibold">Observatory</span>
          <div className="flex-1" />

          {/* Source filter tabs */}
          <div className="flex items-center gap-0.5 mr-2">
            {SOURCE_TABS.map((tab) => {
              const Icon = tab.icon
              const isActive = sourceFilter === tab.key
              return (
                <button
                  key={tab.key}
                  onClick={() => setSourceFilter(tab.key)}
                  className={`flex items-center gap-1 px-2 py-1 text-[11px] font-mono rounded transition-colors ${
                    isActive
                      ? 'bg-cyan-600/20 text-cyan-300 border border-cyan-500/30'
                      : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 border border-transparent'
                  }`}
                >
                  <Icon size={10} />
                  {tab.label}
                </button>
              )
            })}
          </div>

          {/* Search */}
          <div className="relative flex items-center">
            <Search size={12} className="absolute left-2 text-zinc-600 pointer-events-none" />
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search findings..."
              className="w-48 pl-7 pr-7 py-1 text-[11px] font-mono bg-zinc-900/80 border border-zinc-700/50 rounded text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/30 transition-colors"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  if (searchQuery) {
                    setSearchQuery('')
                  } else {
                    searchRef.current?.blur()
                  }
                }
              }}
            />
            {searchQuery && (
              <button
                onClick={() => { setSearchQuery(''); searchRef.current?.focus() }}
                className="absolute right-1.5 text-zinc-600 hover:text-zinc-400 transition-colors"
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* Scan Now dropdown */}
          <div className="relative" ref={scanMenuRef}>
            <button
              onClick={() => setShowScanMenu(!showScanMenu)}
              disabled={scanning}
              className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-mono rounded border transition-colors ${
                scanning
                  ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 border-zinc-700/50'
              }`}
            >
              <RefreshCw size={10} className={scanning ? 'animate-spin' : ''} />
              {scanning ? 'Scanning...' : 'Scan Now'}
              <ChevronDown size={10} />
            </button>
            {showScanMenu && !scanning && (
              <div className="absolute right-0 top-full mt-1 w-48 bg-zinc-900 border border-zinc-700/50 rounded-lg shadow-xl z-10 overflow-hidden">
                <button
                  onClick={() => handleScan('all')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-[11px] font-mono text-zinc-300 hover:bg-zinc-800 transition-colors"
                >
                  <Layers size={10} className="text-cyan-400" />
                  Scan All Sources
                </button>
                <button
                  onClick={() => handleScan('github')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-[11px] font-mono text-zinc-300 hover:bg-zinc-800 transition-colors"
                >
                  <GitBranch size={10} className="text-zinc-400" />
                  Scan GitHub
                </button>
                <button
                  onClick={() => handleScan('producthunt')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-[11px] font-mono text-zinc-300 hover:bg-zinc-800 transition-colors"
                >
                  <Rocket size={10} className="text-orange-400" />
                  Scan Product Hunt
                </button>
                <button
                  onClick={() => handleScan('hackernews')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-[11px] font-mono text-zinc-300 hover:bg-zinc-800 transition-colors"
                >
                  <Newspaper size={10} className="text-amber-400" />
                  Scan Hacker News
                </button>
              </div>
            )}
          </div>

          {/* Start Observatorist */}
          <button
            onClick={handleStartObservatorist}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-mono text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 rounded hover:bg-cyan-500/20 transition-colors"
          >
            <Play size={10} />
            Start Observatorist
          </button>

          {/* Settings gear */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`text-zinc-600 hover:text-zinc-400 transition-colors ${showSettings ? 'text-cyan-400' : ''}`}
          >
            <Settings size={14} />
          </button>

          {/* Count */}
          <span className="text-[11px] font-mono text-zinc-500">
            {totalCount} findings
          </span>

          {/* Close */}
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-400 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Settings panel (collapsible) */}
        {showSettings && (
          <div className="px-5 py-3 border-b border-zinc-800 bg-zinc-900/50 shrink-0">
            <div className="flex items-center gap-2 mb-3">
              <Settings size={12} className="text-zinc-500" />
              <span className="text-[11px] font-mono font-semibold text-zinc-300">Source Configuration</span>
              <div className="flex-1" />
              {settingsDirty && (
                <button
                  onClick={handleSaveSettings}
                  className="px-2.5 py-1 text-[11px] font-mono text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 rounded hover:bg-cyan-500/20 transition-colors"
                >
                  Save Settings
                </button>
              )}
            </div>
            <div className="grid grid-cols-3 gap-4">
              {['github', 'producthunt', 'hackernews'].map((src) => {
                const s = settings[src] || DEFAULT_SOURCE_SETTINGS[src]
                const SrcIcon = sourceIcons[src]
                return (
                  <div
                    key={src}
                    className="flex flex-col gap-2 p-3 bg-zinc-800/50 border border-zinc-700/40 rounded-lg"
                  >
                    <div className="flex items-center gap-1.5">
                      {SrcIcon && <SrcIcon size={12} className={sourceColors[src]} />}
                      <span className="text-[11px] font-mono text-zinc-300 font-semibold">
                        {sourceLabels[src]}
                      </span>
                      <div className="flex-1" />
                      <button
                        onClick={() => updateSourceSetting(src, 'enabled', !s.enabled)}
                        className="text-zinc-500 hover:text-zinc-300 transition-colors"
                      >
                        {s.enabled ? (
                          <ToggleRight size={16} className="text-cyan-400" />
                        ) : (
                          <ToggleLeft size={16} />
                        )}
                      </button>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider">
                        Interval (hours)
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={168}
                        value={s.interval_hours}
                        onChange={(e) =>
                          updateSourceSetting(src, 'interval_hours', parseInt(e.target.value) || 6)
                        }
                        className="w-full px-2 py-1 text-[11px] font-mono bg-zinc-900/80 border border-zinc-700/50 rounded text-zinc-300 focus:outline-none focus:border-cyan-500/50"
                      />
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider">
                        Mode
                      </label>
                      <select
                        value={s.mode}
                        onChange={(e) => updateSourceSetting(src, 'mode', e.target.value)}
                        className="w-full px-2 py-1 text-[11px] font-mono bg-zinc-900/80 border border-zinc-700/50 rounded text-zinc-300 focus:outline-none focus:border-cyan-500/50"
                      >
                        <option value="integrate">Integrate</option>
                        <option value="steal">Steal</option>
                        <option value="both">Both</option>
                      </select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider">
                        Keywords
                      </label>
                      <input
                        type="text"
                        value={s.keywords}
                        onChange={(e) => updateSourceSetting(src, 'keywords', e.target.value)}
                        placeholder="comma-separated"
                        className="w-full px-2 py-1 text-[11px] font-mono bg-zinc-900/80 border border-zinc-700/50 rounded text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-cyan-500/50"
                      />
                    </div>
                  </div>
                )
              })}
            </div>

            {/* API Keys status + link */}
            <div className="mt-4 pt-3 border-t border-zinc-800">
              <div className="flex items-center gap-2">
                <Key size={12} className="text-zinc-500" />
                <span className="text-[11px] font-mono font-semibold text-zinc-300">API Keys</span>
                <div className="flex items-center gap-1.5 ml-2">
                  {['github', 'producthunt', 'brave'].map((k) => {
                    const info = apiKeys[k] || {}
                    const SrcIcon = sourceIcons[k]
                    return (
                      <span
                        key={k}
                        className={`inline-flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 rounded ${
                          info.configured
                            ? 'text-green-400 bg-green-500/10'
                            : 'text-zinc-600 bg-zinc-800/50'
                        }`}
                        title={`${sourceLabels[k]}: ${info.configured ? 'configured' : 'not set'}`}
                      >
                        {SrcIcon && <SrcIcon size={9} />}
                        {info.configured ? '\u2713' : '\u2013'}
                      </span>
                    )
                  })}
                </div>
                <div className="flex-1" />
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    window.dispatchEvent(new CustomEvent('open-panel', { detail: { panel: 'api-keys' } }))
                  }}
                  className="px-2.5 py-1 text-[10px] font-mono text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 rounded hover:bg-cyan-500/20 transition-colors"
                >
                  Manage API Keys
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Columns */}
        <div className="flex-1 flex gap-1.5 p-4 overflow-x-auto min-h-0">
          {COLUMNS.map((col) => {
            const colFindings = findingsByColumn[col.key] || []
            const isOver = dragOverCol === col.key

            return (
              <div
                key={col.key}
                className={`flex flex-col w-[260px] min-w-[260px] rounded-lg border transition-colors ${
                  isOver
                    ? 'border-cyan-500/50 bg-cyan-500/5'
                    : 'border-zinc-800 bg-[#111118]/30'
                }`}
                onDragOver={(e) => handleDragOver(e, col.key)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, col.key)}
              >
                {/* Column header */}
                <div className="flex items-center gap-1 px-2.5 py-1.5 border-b border-zinc-800/50 shrink-0">
                  <span
                    className={`text-[11px] font-mono font-semibold uppercase tracking-wider ${columnAccent[col.key]}`}
                  >
                    {col.label}
                  </span>
                  <span className="text-[11px] font-mono text-zinc-700">
                    {colFindings.length}
                  </span>
                </div>

                {/* Cards */}
                <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                  {colFindings.map((finding) => (
                    <FindingCard
                      key={finding.id}
                      finding={finding}
                      onPromote={handlePromote}
                      onStatusChange={handleStatusChange}
                      onDragStart={() => {}}
                    />
                  ))}
                  {colFindings.length === 0 && (
                    <div className="text-center py-6 text-[11px] font-mono text-zinc-700">
                      no findings
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 px-5 py-1.5 border-t border-zinc-800 shrink-0">
          <span className="text-[11px] font-mono text-zinc-600">
            {totalCount} total
          </span>
          <span className="text-[11px] font-mono text-cyan-400/70">
            {newCount} new
          </span>
          <span className="text-[11px] font-mono text-indigo-400/70">
            {acceptedCount} accepted
          </span>
          <span className="text-[11px] font-mono text-green-400/70">
            {promotedCount} promoted
          </span>
          <span className="ml-auto text-[11px] font-mono text-zinc-700">
            {sourceFilter === 'all' ? 'all sources' : sourceLabels[sourceFilter]}
          </span>
        </div>
      </div>
    </div>
  )
}
