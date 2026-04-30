import { useState, useEffect } from 'react'
import { Settings, X, RefreshCw, Loader2, Columns, Rows, Grid2x2, Maximize, Type, Sparkles } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import { MODELS, GEMINI_MODELS } from '../../lib/constants'

function Toggle({ value, onChange }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${
        value ? 'bg-green-500' : 'bg-zinc-600'
      }`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
          value ? 'left-[18px]' : 'left-0.5'
        }`}
      />
    </button>
  )
}

function OptionButton({ active, onClick, children, title }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`px-2.5 py-1.5 text-[11px] rounded-md border transition-colors ${
        active
          ? 'bg-accent-subtle border-accent-primary text-indigo-300 font-medium'
          : 'border-border-secondary text-text-faint hover:text-text-secondary hover:bg-bg-hover'
      }`}
    >
      {children}
    </button>
  )
}

const VIEW_MODES = [
  { id: 'tabs', label: 'Tabs' },
  { id: 'grid', label: 'Grid' },
]

const GRID_LAYOUTS = [
  { id: 'equal', label: 'Equal', icon: Grid2x2 },
  { id: 'focusRight', label: 'Focus Right', icon: Columns },
  { id: 'focusBottom', label: 'Focus Bottom', icon: Rows },
]

const HOME_COLUMN_OPTIONS = [2, 3, 4, 5]

export default function GeneralSettingsPanel({ onClose }) {
  const [autoUpdateCli, setAutoUpdateCli] = useState(false)
  const [autoSessionTitles, setAutoSessionTitles] = useState(true)
  const [catchupModel, setCatchupModel] = useState('haiku')
  const [cliAvail, setCliAvail] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cc-cli-available') || '{}') } catch { return {} }
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savingTitle, setSavingTitle] = useState(false)
  const [savingCatchupModel, setSavingCatchupModel] = useState(false)

  const viewMode = useStore((s) => s.viewMode)
  const gridLayout = useStore((s) => s.gridLayout)
  const homeColumns = useStore((s) => s.homeColumns)
  const gridMinRowHeight = useStore((s) => s.gridMinRowHeight)
  const terminalAutoFit = useStore((s) => s.terminalAutoFit)

  useEffect(() => {
    Promise.all([
      api.getAppSetting('auto_update_cli').then((res) => {
        setAutoUpdateCli(res.value === 'on')
      }).catch(() => {}),
      api.getAppSetting('auto_session_titles').then((res) => {
        // Default is on — only disable if explicitly "off"
        setAutoSessionTitles(res.value !== 'off')
      }).catch(() => {}),
      api.getAppSetting('catchup_model').then((res) => {
        if (res?.value) setCatchupModel(res.value)
      }).catch(() => {}),
      api.getCliInfo().then((info) => {
        if (info.available_clis) {
          setCliAvail(info.available_clis)
          localStorage.setItem('cc-cli-available', JSON.stringify(info.available_clis))
        }
      }).catch(() => {}),
    ]).finally(() => setLoading(false))
  }, [])

  const handleToggle = async (val) => {
    setAutoUpdateCli(val)
    setSaving(true)
    try {
      await api.setAppSetting('auto_update_cli', val ? 'on' : 'off')
    } catch (e) {
      setAutoUpdateCli(!val)
    }
    setSaving(false)
  }

  const handleTitleToggle = async (val) => {
    setAutoSessionTitles(val)
    setSavingTitle(true)
    try {
      await api.setAppSetting('auto_session_titles', val ? 'on' : 'off')
    } catch (e) {
      setAutoSessionTitles(!val)
    }
    setSavingTitle(false)
  }

  const handleCatchupModelChange = async (val) => {
    const prev = catchupModel
    setCatchupModel(val)
    setSavingCatchupModel(true)
    try {
      await api.setAppSetting('catchup_model', val)
    } catch (e) {
      setCatchupModel(prev)
    }
    setSavingCatchupModel(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[480px] ide-panel overflow-hidden scale-in max-h-[70vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary sticky top-0 bg-bg-primary z-10">
          <Settings size={14} className="text-blue-400" />
          <span className="text-xs text-text-primary font-medium">General Settings</span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        <div className="p-4 space-y-5">

          {/* ── Layout ─────────────────────────────── */}
          <div className="text-[10px] text-text-faint font-medium uppercase tracking-wider flex items-center gap-2">
            Layout
            <span className="normal-case tracking-normal text-zinc-400/70 px-1.5 py-0.5 bg-zinc-500/8 rounded border border-zinc-500/15 text-[9px]">This device</span>
          </div>

          <div className="space-y-4">
            {/* View mode */}
            <div>
              <div className="text-xs text-text-secondary mb-1.5">Default view</div>
              <div className="flex gap-1.5">
                {VIEW_MODES.map((m) => (
                  <OptionButton
                    key={m.id}
                    active={viewMode === m.id}
                    onClick={() => useStore.getState().setViewMode(m.id)}
                  >
                    {m.label}
                  </OptionButton>
                ))}
              </div>
            </div>

            {/* Grid layout */}
            <div className={viewMode !== 'grid' ? 'opacity-40 pointer-events-none' : ''}>
              <div className="text-xs text-text-secondary mb-1.5">Grid layout</div>
              <div className="flex gap-1.5">
                {GRID_LAYOUTS.map((l) => (
                  <OptionButton
                    key={l.id}
                    active={gridLayout === l.id}
                    onClick={() => useStore.getState().setGridLayout(l.id)}
                    title={l.label}
                  >
                    <div className="flex items-center gap-1.5">
                      <l.icon size={12} />
                      {l.label}
                    </div>
                  </OptionButton>
                ))}
              </div>
            </div>

            {/* Grid min row height */}
            <div className={viewMode !== 'grid' ? 'opacity-40 pointer-events-none' : ''}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-text-secondary">Min row height</span>
                <span className="text-xs text-text-faint font-mono">{gridMinRowHeight}px</span>
              </div>
              <input
                type="range"
                min="100"
                max="500"
                step="25"
                value={gridMinRowHeight}
                onChange={(e) => useStore.getState().setGridMinRowHeight(Number(e.target.value))}
                className="w-full accent-accent-primary"
              />
            </div>

            {/* Home columns */}
            <div>
              <div className="text-xs text-text-secondary mb-1.5">Home screen columns</div>
              <div className="flex gap-1.5">
                {HOME_COLUMN_OPTIONS.map((n) => (
                  <OptionButton
                    key={n}
                    active={homeColumns === n}
                    onClick={() => useStore.getState().setHomeColumns(n)}
                  >
                    {n}
                  </OptionButton>
                ))}
              </div>
            </div>

            {/* Terminal auto-fit */}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <Maximize size={13} className="text-emerald-400 shrink-0" />
                  <span className="text-xs text-text-primary font-medium">Terminal auto-fit</span>
                </div>
                <div className="text-[10px] text-text-faint mt-0.5 ml-[19px]">
                  Scale font to fit 80x24 PTY in grid cells without scrolling
                </div>
              </div>
              <Toggle
                value={terminalAutoFit}
                onChange={(v) => useStore.getState().setTerminalAutoFit(v)}
              />
            </div>
          </div>

          <div className="border-t border-border-secondary" />

          {/* ── Startup ────────────────────────────── */}
          <div className="text-[10px] text-text-faint font-medium uppercase tracking-wider flex items-center gap-2">
            Startup
            <span className="normal-case tracking-normal text-blue-400/70 px-1.5 py-0.5 bg-blue-500/8 rounded border border-blue-500/15 text-[9px]">Global</span>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-xs text-text-faint">
              <Loader2 size={12} className="animate-spin" />
              Loading...
            </div>
          ) : (
            <div className="space-y-3">
              {/* Auto-update CLI toggle */}
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <RefreshCw size={13} className="text-blue-400 shrink-0" />
                    <span className="text-xs text-text-primary font-medium">Auto-update CLIs on startup</span>
                    {saving && <Loader2 size={10} className="animate-spin text-text-faint" />}
                  </div>
                  <div className="text-[10px] text-text-faint mt-0.5 ml-[19px]">
                    Update Claude Code and Gemini CLI when running <code className="px-1 py-0.5 bg-bg-hover rounded text-[10px]">start.sh</code>
                  </div>
                </div>
                <Toggle value={autoUpdateCli} onChange={handleToggle} />
              </div>
            </div>
          )}

          <div className="border-t border-border-secondary" />

          {/* ── Sessions ──────────────────────────── */}
          <div className="text-[10px] text-text-faint font-medium uppercase tracking-wider flex items-center gap-2">
            Sessions
            <span className="normal-case tracking-normal text-blue-400/70 px-1.5 py-0.5 bg-blue-500/8 rounded border border-blue-500/15 text-[9px]">Global</span>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-xs text-text-faint">
              <Loader2 size={12} className="animate-spin" />
              Loading...
            </div>
          ) : (
            <div className="space-y-3">
              {/* Auto session titles */}
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <Type size={13} className="text-purple-400 shrink-0" />
                    <span className="text-xs text-text-primary font-medium">Auto session titles</span>
                    {savingTitle && <Loader2 size={10} className="animate-spin text-text-faint" />}
                  </div>
                  <div className="text-[10px] text-text-faint mt-0.5 ml-[19px]">
                    Auto-generate a descriptive title after the first response using a cheap LLM call
                  </div>
                </div>
                <Toggle value={autoSessionTitles} onChange={handleTitleToggle} />
              </div>
            </div>
          )}

          <div className="border-t border-border-secondary" />

          {/* ── Briefing ──────────────────────────── */}
          <div className="text-[10px] text-text-faint font-medium uppercase tracking-wider flex items-center gap-2">
            Briefing
            <span className="normal-case tracking-normal text-blue-400/70 px-1.5 py-0.5 bg-blue-500/8 rounded border border-blue-500/15 text-[9px]">Global</span>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-xs text-text-faint">
              <Loader2 size={12} className="animate-spin" />
              Loading...
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <Sparkles size={13} className="text-amber-400 shrink-0" />
                    <span className="text-xs text-text-primary font-medium">Catch-up model</span>
                    {savingCatchupModel && <Loader2 size={10} className="animate-spin text-text-faint" />}
                  </div>
                  <div className="text-[10px] text-text-faint mt-0.5 ml-[19px]">
                    Model used to summarize activity for the catch-up banner and panel
                  </div>
                </div>
                <select
                  value={catchupModel}
                  onChange={(e) => handleCatchupModelChange(e.target.value)}
                  className="shrink-0 px-2 py-1 text-[11px] font-mono bg-bg-inset border border-border-secondary rounded-md text-text-secondary focus:outline-none focus:border-amber-500/50 ide-focus-ring transition-colors"
                >
                  {(cliAvail.claude !== false) && (
                    <optgroup label="Claude">
                      {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </optgroup>
                  )}
                  {cliAvail.gemini && (
                    <optgroup label="Gemini">
                      {GEMINI_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </optgroup>
                  )}
                </select>
              </div>
            </div>
          )}

          <div className="border-t border-border-secondary" />

          <div className="text-[10px] text-text-faint leading-relaxed">
            When enabled, the start script runs <code className="px-1 py-0.5 bg-bg-hover rounded">claude update</code> and <code className="px-1 py-0.5 bg-bg-hover rounded">brew upgrade gemini-cli</code> before launching. Failed updates are skipped silently.
          </div>
        </div>
      </div>
    </div>
  )
}
