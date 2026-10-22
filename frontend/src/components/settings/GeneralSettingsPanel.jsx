import HelpDetails from '../ui/HelpDetails'
import { useState, useEffect } from 'react'
import { RefreshCw, Loader2, Columns, Rows, Grid2x2, Type, Sparkles, Terminal, CircleHelp } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import { Button, ThemeToggle } from '../ui'
import { LANGUAGES, getLanguage, setLanguage, useT } from '../../lib/i18n'
import '../../lib/i18n/shell'

function Toggle({ value, onChange, label, disabled = false }) {
  return (
    <Button
      type="button"
      onClick={() => onChange(!value)}
      aria-label={label}
      disabled={disabled}
      toggleState={value}
      shape="card"
      size="sm"
      className="min-w-[70px] shrink-0"
    >
      {value ? 'On' : 'Off'}
    </Button>
  )
}

function OptionButton({ active, onClick, children, title }) {
  return (
    <Button
      onClick={onClick}
      title={title}
      size="sm"
      selected={active}
    >
      {children}
    </Button>
  )
}

const GRID_LAYOUTS = [
  { id: 'equal', label: 'Equal', icon: Grid2x2 },
  { id: 'focusRight', label: 'Focus Right', icon: Columns },
  { id: 'focusBottom', label: 'Focus Bottom', icon: Rows },
]



export default function GeneralSettingsPanel() {
  const t = useT()
  const language = getLanguage()
  const [autoUpdateCli, setAutoUpdateCli] = useState(false)
  const [autoSessionTitles, setAutoSessionTitles] = useState(false)
  const [automaticSummaries, setAutomaticSummaries] = useState(false)
  const [savingSummaries, setSavingSummaries] = useState(false)
  const [summaryError, setSummaryError] = useState('')
  const [catchupModel, setCatchupModel] = useState('claude:haiku')
  const [modelRegistry, setModelRegistry] = useState({ providers: [], health: [] })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savingTitle, setSavingTitle] = useState(false)
  const [savingCatchupModel, setSavingCatchupModel] = useState(false)

  const viewMode = useStore((s) => s.viewMode)
  const gridLayout = useStore((s) => s.gridLayout)
  const terminalBoardMode = useStore((s) => s.terminalBoardMode)
  const setTerminalBoardMode = useStore((s) => s.setTerminalBoardMode)

  useEffect(() => {
    Promise.all([
      api.getAppSetting('auto_update_cli').then((res) => {
        setAutoUpdateCli(res.value === 'on')
      }).catch(() => {}),
      api.getAppSetting('auto_session_titles').then((res) => {
        setAutoSessionTitles(res.value === 'on')
      }).catch(() => {}),
      api.getAppSetting('automatic_session_summaries').then((res) => {
        setAutomaticSummaries(res.value === 'on')
      }).catch(() => {}),
      api.getAppSetting('catchup_model').then((res) => {
        if (res?.value) setCatchupModel(res.value)
      }).catch(() => {}),
      api.getModelProviders().then((registry) => {
        setModelRegistry(registry || { providers: [], health: [] })
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

  const handleSummaryToggle = async (val) => {
    setSavingSummaries(true)
    setSummaryError('')
    try {
      await api.setAppSetting('automatic_session_summaries', val ? 'on' : 'off')
      setAutomaticSummaries(val)
    } catch {
      setSummaryError('Die Einstellung konnte nicht gespeichert werden.')
    } finally {
      setSavingSummaries(false)
    }
  }

  const handleCatchupModelChange = async (val) => {
    const next = val
    const prev = catchupModel
    setCatchupModel(next)
    setSavingCatchupModel(true)
    try {
      await api.setAppSetting('catchup_model', next)
    } catch (e) {
      setCatchupModel(prev)
    }
    setSavingCatchupModel(false)
  }

  return (
    <div className="h-full overflow-y-auto">
        <div className="p-5 space-y-5">

          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-x-line pb-5">
            <div><h3 className="text-sm font-semibold text-x-ink">IVE kennenlernen</h3></div>
            <Button icon={CircleHelp} onClick={() => window.dispatchEvent(new Event('open-onboarding'))}>Einführung öffnen</Button>
          </div>

          {/* ── Language ───────────────────────────── */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-x-ink font-medium">{t('settings.language')}</div>

            </div>
            <select
              aria-label="Language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="shrink-0 px-2 py-1 text-[11px] bg-x-surface-2 border border-x-line rounded-md text-x-ink-secondary focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
            >
              {LANGUAGES.map((code) => <option key={code} value={code}>{t(`settings.${code}`)}</option>)}
            </select>
          </div>

          {/* ── Theme (moved here from the old status bar; ⌘K "Switch theme") ── */}
          <div className="flex items-center justify-between gap-3" data-theme-setting="">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-x-ink font-medium">Theme</div>

            </div>
            <ThemeToggle />
          </div>

          <div className="border-t border-x-line-subtle" />

          {/* ── Layout ─────────────────────────────── */}
          <div className="text-xs text-x-ink-secondary font-medium flex items-center gap-2">
            Layout
            <span className="text-x-muted px-1.5 py-0.5 bg-x-hover rounded-md border border-x-line text-[11px]">Personal</span>
          </div>

          <div className="space-y-4">
            {/* Grid layout */}
            <div>
              <div className="text-xs text-x-ink-secondary font-medium mb-1.5">Grid layout</div>
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

            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <Terminal size={13} className="text-x-accent shrink-0" />
                  <span className="text-xs text-x-ink font-medium">Terminal board mode</span>
                </div>
                <HelpDetails><div className="text-[11px] text-x-muted mt-0.5 ml-[19px]">
                  Render grid sessions as IVE terminals by default on this device
                </div></HelpDetails>
              </div>
              <Toggle value={terminalBoardMode} onChange={setTerminalBoardMode} />
            </div>

          </div>

          <div className="border-t border-x-line-subtle" />

          {/* ── Startup ────────────────────────────── */}
          <div className="text-xs text-x-ink-secondary font-medium flex items-center gap-2">
            Startup
            <span className="rounded-md border border-x-line bg-x-surface-2 px-1.5 py-0.5 text-[11px] text-x-muted">Global</span>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-xs text-x-muted">
              <Loader2 size={12} className="animate-spin" />
              Loading...
            </div>
          ) : (
            <div className="space-y-3">
              {/* Auto-update CLI toggle */}
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <RefreshCw size={13} className="text-x-accent shrink-0" />
                    <span className="text-xs text-x-ink font-medium">Auto-update CLIs on startup</span>
                    {saving && <Loader2 size={10} className="animate-spin text-x-muted" />}
                  </div>
                  <HelpDetails><div className="text-[11px] text-x-muted mt-0.5 ml-[19px]">
                    Update supported CLIs when running <code className="px-1 py-0.5 bg-x-surface-2 rounded text-[11px]">start.sh</code>
                  </div></HelpDetails>

                </div>
                <Toggle value={autoUpdateCli} onChange={handleToggle} />
              </div>
            </div>
          )}

          <div className="border-t border-x-line-subtle" />

          {/* ── Sessions ──────────────────────────── */}
          <div className="text-xs text-x-ink-secondary font-medium flex items-center gap-2">
            Sessions
            <span className="rounded-md border border-x-line bg-x-surface-2 px-1.5 py-0.5 text-[11px] text-x-muted">Global</span>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-xs text-x-muted">
              <Loader2 size={12} className="animate-spin" />
              Loading...
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-x-ink font-medium">Automatische Zusammenfassungen</div>
                  <p className="mt-1 text-[11px] text-x-muted">
                    Zusätzliche KI-Aufrufe für geteilten Kontext und Chat-Zusammenfassungen.
                    Verbraucht Claude- oder Codex-Kontingent. Standardmäßig aus.
                    {' '}Bei Aktivierung: höchstens zwei Hintergrundaufrufe pro Session und sechs insgesamt in 24 Stunden,
                    mit gemeinsamem Eingabelimit. Dateiübergaben benötigen keinen zusätzlichen KI-Aufruf.
                  </p>
                </div>
                <Toggle value={automaticSummaries} onChange={handleSummaryToggle}
                  label="Automatische Zusammenfassungen" disabled={savingSummaries} />
              </div>
              {summaryError && <p role="alert" className="text-xs text-red-500">{summaryError}</p>}
              {/* Auto session titles */}
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <Type size={13} className="text-x-accent shrink-0" />
                    <span className="text-xs text-x-ink font-medium">Auto session titles</span>
                    {savingTitle && <Loader2 size={10} className="animate-spin text-x-muted" />}
                  </div>
                  <HelpDetails><div className="text-[11px] text-x-muted mt-0.5 ml-[19px]">
                    Auto-generate a descriptive title after the first response using a cheap LLM call
                  </div></HelpDetails>
                </div>
                <Toggle value={autoSessionTitles} onChange={handleTitleToggle} label="Auto session titles" disabled={savingTitle} />
              </div>
            </div>
          )}

          <div className="border-t border-x-line-subtle" />

          {/* ── Briefing ──────────────────────────── */}
          <div className="text-xs text-x-ink-secondary font-medium flex items-center gap-2">
            Briefing
            <span className="rounded-md border border-x-line bg-x-surface-2 px-1.5 py-0.5 text-[11px] text-x-muted">Global</span>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-xs text-x-muted">
              <Loader2 size={12} className="animate-spin" />
              Loading...
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <Sparkles size={13} className="text-x-accent shrink-0" />
                    <span className="text-xs text-x-ink font-medium">Catch-up model</span>
                    {savingCatchupModel && <Loader2 size={10} className="animate-spin text-x-muted" />}
                  </div>
                  <HelpDetails><div className="text-[11px] text-x-muted mt-0.5 ml-[19px]">
                    Model used to summarize activity for the catch-up banner and panel
                  </div></HelpDetails>
                </div>
                <select
                  value={catchupModel}
                  onChange={(e) => handleCatchupModelChange(e.target.value)}
                  className="shrink-0 px-2 py-1 text-[11px] bg-x-surface-2 border border-x-line rounded-md text-x-ink-secondary focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                >
                  {(modelRegistry.providers || []).map((provider) => {
                    const health = (modelRegistry.health || []).find((item) => item.id === provider.id)
                    const available = provider.enabled && (provider.capabilities || []).includes('json')
                    return (
                      <optgroup
                        key={provider.id}
                        label={`${provider.id} · ${provider.kind} · ${health?.reachable ? 'reachable' : 'unreachable'}`}
                      >
                        {(provider.models || []).map((model) => (
                          <option
                            key={`${provider.id}:${model}`}
                            value={`${provider.id}:${model}`}
                            disabled={!available}
                          >
                            {model}{available ? '' : ' — unavailable'}
                          </option>
                        ))}
                      </optgroup>
                    )
                  })}
                </select>
              </div>
            </div>
          )}

        </div>
    </div>
  )
}
