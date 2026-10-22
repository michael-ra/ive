import { useState, useEffect, useCallback } from 'react'
import useStore from '../../state/store'
import {
  Package, X, Plus, Trash2, RefreshCw, Globe, HardDrive, Settings,
  Shield, AlertTriangle, FileCode, Check, Search, Download, ExternalLink,
  Zap, Gauge, Terminal, Power,
} from 'lucide-react'
import { api } from '../../lib/api'

const RTK_PLUGIN_ID = 'builtin-rtk-command-optimizer'

function isRtkPlugin(plugin) {
  return plugin?.id === RTK_PLUGIN_ID || plugin?.source_format === 'integration:rtk'
}

// ─── Security tier presentation ──────────────────────────────────────────
// Tier 0 = text-only (safest), tier 3 = unverified raw source.
const TIERS = {
  0: { label: 'Text Only',     color: 'text-x-good', bg: 'bg-x-good/10',  border: 'border-x-good/30', icon: Shield },
  1: { label: 'Sandboxed',     color: 'text-x-accent-ink',   bg: 'bg-x-accent-ink/10',    border: 'border-x-accent-ink/30',   icon: AlertTriangle },
  2: { label: 'Extended Perm', color: 'text-x-accent-ink',  bg: 'bg-x-accent-ink/15',   border: 'border-x-accent-ink/40',  icon: AlertTriangle },
  3: { label: 'Unverified',    color: 'text-x-accent-ink',     bg: 'bg-x-accent-ink/10',      border: 'border-x-accent-ink/30',     icon: AlertTriangle },
}

function TierBadge({ tier }) {
  const t = TIERS[tier ?? 0] || TIERS[0]
  const Icon = t.icon
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded ${t.bg} ${t.color} border ${t.border}`}>
      <Icon size={9} />
      {t.label}
    </span>
  )
}

// ─── Plugin card ─────────────────────────────────────────────────────────

function PluginCard({ plugin, onInstall, onUninstall, onSelect, busy }) {
  const isInstalled = !!plugin.installed
  const isRtk = isRtkPlugin(plugin)
  const Icon = isRtk ? Gauge : Package
  return (
    <div
      onClick={() => onSelect(plugin)}
      className="group p-3 border-b border-x-line-subtle hover:bg-x-hover/50 cursor-pointer transition-colors"
    >
      <div className="flex items-start gap-2">
        <div className="shrink-0 mt-0.5">
          <Icon size={14} strokeWidth={1.75} className="text-x-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-x-ink font-mono font-medium truncate">
              {plugin.name}
            </span>
            {plugin.version && (
              <span className="text-[11px] text-x-faint font-mono">v{plugin.version}</span>
            )}
            <TierBadge tier={plugin.security_tier} />
            {plugin.contains_scripts ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-x-accent-ink/80">
                <FileCode size={9} /> scripts
              </span>
            ) : null}
            {isInstalled && (
              <span className="text-[11px] text-x-good font-medium">installed</span>
            )}
          </div>
          {plugin.description && (
            <p className="text-[11px] text-x-muted font-mono mt-0.5 line-clamp-2 leading-relaxed">
              {plugin.description}
            </p>
          )}
          <div className="flex items-center gap-2 mt-1 text-[11px] text-x-faint font-mono">
            {plugin.author && <span>by {plugin.author}</span>}
            {plugin.source_format && plugin.source_format !== 'unknown' && (
              <span className="px-1 py-0.5 bg-x-surface-2 rounded">{plugin.source_format}</span>
            )}
            {(plugin.categories || []).slice(0, 3).map((c) => (
              <span key={c} className="px-1 py-0.5 bg-x-surface-2 rounded">{c}</span>
            ))}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {isRtk ? (
            <button
              onClick={(e) => { e.stopPropagation(); onSelect(plugin) }}
              disabled={busy}
              className="px-2 py-0.5 text-[11px] font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent rounded-md transition-colors duration-[80ms] ease-x disabled:opacity-30"
              title="Configure"
            >
              configure
            </button>
          ) : isInstalled ? (
            <button
              onClick={(e) => { e.stopPropagation(); onUninstall(plugin) }}
              disabled={busy}
              className="p-1 text-x-faint hover:text-x-accent-ink transition-colors duration-[80ms] ease-x disabled:opacity-30"
              title="Uninstall"
            >
              <Trash2 size={12} />
            </button>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); onInstall(plugin) }}
              disabled={busy}
              className="px-2 py-0.5 text-[11px] font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent rounded-md transition-colors duration-[80ms] ease-x disabled:opacity-30"
              title="Install"
            >
              install
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Plugin detail view ──────────────────────────────────────────────────

function RtkIntegrationDetail({ plugin, onClose }) {
  const [status, setStatus] = useState(null)
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const next = await api.getRtkIntegration()
      setStatus(next)
      setForm(next.config || {})
    } catch (err) {
      setError(err.message || 'Failed to load RTK status')
    }
  }, [])

  useEffect(() => { load() }, [load])

  const updateField = (key, value) => {
    setForm((current) => ({ ...(current || {}), [key]: value }))
  }

  const save = async () => {
    if (!form) return
    setBusy(true)
    setError('')
    try {
      const next = await api.updateRtkIntegration(form)
      setStatus(next)
      setForm(next.config || {})
    } catch (err) {
      setError(err.message || 'Failed to save RTK config')
    } finally {
      setBusy(false)
    }
  }

  const installSelectedMode = async () => {
    const mode = form?.binary_mode || 'managed_stable'
    const selected = status.install_modes?.find((m) => m.id === mode)
    if (!selected?.downloads) return
    const label = selected.label || mode
    if (!confirm(`${label} will download RTK ${status.pinned_stable_version} from GitHub and install it under ~/.ive/tools/rtk.\n\nContinue?`)) return
    setBusy(true)
    setError('')
    try {
      const result = await api.installRtkIntegration({ mode })
      const next = result.status || await api.getRtkIntegration()
      setStatus(next)
      setForm(next.config || {})
    } catch (err) {
      setError(err.message || 'Failed to install RTK')
    } finally {
      setBusy(false)
    }
  }

  if (!status || !form) {
    return <div className="p-6 text-xs text-x-faint">loading...</div>
  }

  const selectedMode = status.install_modes?.find((m) => m.id === form.binary_mode)
  const selectedPreset = status.presets?.find((p) => p.id === form.preset)

  return (
    <div className="overflow-y-auto max-h-full">
      <div className="p-4 border-b border-x-line">
        <button onClick={onClose} className="text-[11px] text-x-faint hover:text-x-ink-secondary mb-2">back</button>
        <div className="flex items-start gap-3">
          <Gauge size={18} strokeWidth={1.75} className="text-x-accent mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm text-x-ink font-mono font-medium">{plugin.name}</h2>
              <TierBadge tier={plugin.security_tier} />
              <span className={`text-[11px] font-mono px-1.5 py-0.5 rounded border ${
                status.enabled
                  ? 'text-x-good bg-x-good/10 border-x-good/25'
                  : 'text-x-faint bg-x-surface-2 border-x-line'
              }`}>
                {status.enabled ? 'enabled' : 'off'}
              </span>
            </div>
            <p className="text-xs text-x-ink-secondary mt-2 leading-relaxed">
              Optional RTK command-output compaction. IVE keeps hook ownership; RTK only runs after this integration is explicitly enabled.
            </p>
            <div className="flex flex-wrap items-center gap-2 mt-2 text-[11px] text-x-faint font-mono">
              <span className={status.available ? 'text-x-good' : 'text-x-accent-ink'}>
                {status.available ? 'local binary found' : 'local binary not found'}
              </span>
              {status.binary && <span className="truncate max-w-[320px]">{status.binary}</span>}
              {status.version && <span>{status.version}</span>}
              {status.pinned_stable_version && <span>pinned {status.pinned_stable_version}</span>}
            </div>
          </div>
        </div>
        {plugin.source_url && (
          <a
            href={plugin.source_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 mt-3 px-2 py-1.5 text-[11px] text-x-ink-secondary hover:text-x-ink"
          >
            <ExternalLink size={11} /> source
          </a>
        )}
      </div>

      <div className="p-4 border-b border-x-line space-y-3">
        <div className="flex items-center justify-between gap-3 px-3 py-2 bg-x-surface-2 border border-x-line-subtle rounded-md">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs text-x-ink font-mono">
              <Power size={12} strokeWidth={1.75} className={form.enabled ? 'text-x-good' : 'text-x-faint'} />
              Enable RTK rewriting
            </div>
            <div className="text-[11px] text-x-faint font-mono mt-0.5">
              Requires a local RTK binary; save will fail if none is available.
            </div>
          </div>
          <button
            type="button"
            onClick={() => updateField('enabled', !form.enabled)}
            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border border-x-line transition-colors ${
              form.enabled ? 'bg-x-good' : 'bg-x-surface-2 border border-x-line'
            }`}
          >
            <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-x-on-accent shadow transition-transform duration-[80ms] ease-x ${
              form.enabled ? 'translate-x-4' : 'translate-x-0'
            }`} />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-xs font-medium text-x-ink-secondary">Install mode</span>
            <select
              value={form.binary_mode || 'existing_path'}
              onChange={(e) => updateField('binary_mode', e.target.value)}
              className="w-full px-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus font-mono"
            >
              {(status.install_modes || []).map((mode) => (
                <option key={mode.id} value={mode.id}>{mode.label}</option>
              ))}
            </select>
            {selectedMode && (
              <span className="block text-[11px] text-x-faint leading-relaxed">
                {selectedMode.description}
              </span>
            )}
          </label>

          <label className="space-y-1">
            <span className="text-xs font-medium text-x-ink-secondary">Preset</span>
            <select
              value={form.preset || 'balanced'}
              onChange={(e) => updateField('preset', e.target.value)}
              className="w-full px-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus font-mono"
            >
              {(status.presets || []).map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.label}</option>
              ))}
            </select>
            {selectedPreset && (
              <span className="block text-[11px] text-x-faint leading-relaxed">
                {selectedPreset.description}
              </span>
            )}
          </label>
        </div>

        <label className="space-y-1 block">
          <span className="text-xs font-medium text-x-ink-secondary">Custom binary path</span>
          <input
            value={form.binary_path || ''}
            onChange={(e) => updateField('binary_path', e.target.value)}
            placeholder="/usr/local/bin/rtk"
            className="w-full px-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus font-mono"
          />
        </label>

        <label className="space-y-1 block">
          <span className="text-xs font-medium text-x-ink-secondary">Updates</span>
          <select
            value={form.update_policy || 'notify'}
            onChange={(e) => updateField('update_policy', e.target.value)}
            className="w-full px-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus font-mono"
          >
            {(status.update_policies || []).map((policy) => (
              <option key={policy.id} value={policy.id}>{policy.id}</option>
            ))}
          </select>
        </label>

        {selectedMode?.downloads && (
          <div className="flex items-center justify-between gap-3 px-3 py-2 bg-x-surface-2 border border-x-line rounded-md">
            <div className="min-w-0 text-[11px] text-x-accent-ink leading-relaxed">
              {form.binary_mode === 'build_from_source'
                ? `Builds pinned ${status.pinned_stable_version} with cargo build --release --locked.`
                : `Downloads pinned ${status.pinned_stable_version} release binary from GitHub.`}
            </div>
            <button
              onClick={installSelectedMode}
              disabled={busy}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent rounded-md transition-colors duration-[80ms] ease-x disabled:opacity-50"
            >
              <Download size={11} />
              {form.binary_mode === 'build_from_source' ? 'build' : 'install'}
            </button>
          </div>
        )}

        {error && (
          <div className="px-3 py-2 bg-x-accent-ink/10 border border-x-accent-ink/20 rounded-md text-[11px] text-x-accent-ink">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={load}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-transparent border border-x-line hover:bg-x-hover hover:border-x-line-strong text-x-ink-secondary hover:text-x-ink rounded-md transition-colors duration-[80ms] ease-x disabled:opacity-50"
          >
            <RefreshCw size={11} /> refresh
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent rounded-md transition-colors duration-[80ms] ease-x disabled:opacity-50"
          >
            <Check size={11} /> save
          </button>
        </div>
      </div>

      <div className="p-4 border-b border-x-line">
        <div className="flex items-center gap-1.5 mb-2">
          <Terminal size={11} strokeWidth={1.75} className="text-x-accent" />
          <span className="text-[11px] text-x-ink-secondary font-mono uppercase tracking-wide">
            Balanced command set
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {(status.balanced_candidate_prefixes || []).slice(0, 28).map((cmd) => (
            <span key={cmd} className="text-[11px] px-1.5 py-0.5 bg-x-surface-2 border border-x-line-subtle rounded text-x-faint font-mono">
              {cmd}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function PluginDetail({ pluginId, onClose, onInstall, onUninstall, busy }) {
  const [plugin, setPlugin] = useState(null)

  useEffect(() => {
    if (!pluginId) return
    api.getPlugin(pluginId).then(setPlugin)
  }, [pluginId])

  if (!plugin) {
    return (
      <div className="p-6 text-xs text-x-faint">loading…</div>
    )
  }

  const guidelines = (plugin.components || []).filter((c) => c.type === 'guideline')
  const scripts = (plugin.components || []).filter((c) => c.type === 'script')

  if (isRtkPlugin(plugin)) {
    return <RtkIntegrationDetail plugin={plugin} onClose={onClose} />
  }

  return (
    <div className="overflow-y-auto max-h-full">
      <div className="p-4 border-b border-x-line">
        <button onClick={onClose} className="text-[11px] text-x-faint hover:text-x-ink-secondary mb-2">← back</button>
        <div className="flex items-start gap-3">
          <Package size={18} className="text-x-accent mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm text-x-ink font-mono font-medium">{plugin.name}</h2>
              {plugin.version && <span className="text-[11px] text-x-faint font-mono">v{plugin.version}</span>}
              <TierBadge tier={plugin.security_tier} />
            </div>
            {plugin.author && (
              <p className="text-[11px] text-x-muted font-mono mt-0.5">by {plugin.author}</p>
            )}
            {plugin.description && (
              <p className="text-xs text-x-ink-secondary mt-2 leading-relaxed">{plugin.description}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 mt-3">
          {plugin.installed ? (
            <button
              onClick={() => onUninstall(plugin)}
              disabled={busy}
              className="px-3 py-1.5 text-xs font-medium bg-x-accent-ink/10 hover:bg-x-accent-ink/15 text-x-accent-ink border border-x-accent-ink/30 hover:border-x-accent-ink/45 rounded-md transition-colors duration-[80ms] ease-x disabled:opacity-50"
            >
              uninstall
            </button>
          ) : (
            <>
              <button
                onClick={() => onInstall(plugin, false)}
                disabled={busy || !plugin.package_url}
                className="px-3 py-1.5 text-xs font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent rounded-md transition-colors duration-[80ms] ease-x disabled:opacity-50"
              >
                {plugin.contains_scripts ? 'install all' : 'install'}
              </button>
              {plugin.contains_scripts && (
                <button
                  onClick={() => onInstall(plugin, true)}
                  disabled={busy || !plugin.package_url}
                  className="px-3 py-1.5 text-xs font-medium bg-transparent border border-x-line hover:bg-x-hover hover:border-x-line-strong text-x-ink-secondary hover:text-x-ink rounded-md transition-colors duration-[80ms] ease-x disabled:opacity-50"
                >
                  guidelines only
                </button>
              )}
            </>
          )}
          {plugin.source_url && (
            <a
              href={plugin.source_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 px-2 py-1.5 text-[11px] text-x-ink-secondary hover:text-x-ink"
            >
              <ExternalLink size={11} /> source
            </a>
          )}
        </div>
      </div>

      {/* Guidelines section */}
      {guidelines.length > 0 && (
        <div className="p-4 border-b border-x-line">
          <div className="flex items-center gap-1.5 mb-2">
            <Shield size={11} strokeWidth={1.75} className="text-x-good" />
            <span className="text-[11px] text-x-ink-secondary font-mono uppercase tracking-wide">
              Guidelines ({guidelines.length})
            </span>
          </div>
          <div className="space-y-1.5">
            {guidelines.map((c) => (
              <div key={c.id} className="px-2.5 py-1.5 bg-x-surface-2 rounded border border-x-line-subtle">
                <div className="text-[11px] text-x-ink font-mono">{c.name}</div>
                {c.description && (
                  <div className="text-[11px] text-x-muted mt-0.5">{c.description}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scripts section */}
      {scripts.length > 0 && (
        <div className="p-4 border-b border-x-line">
          <div className="flex items-center gap-1.5 mb-2">
            <FileCode size={11} strokeWidth={1.75} className="text-x-accent-ink" />
            <span className="text-[11px] text-x-ink-secondary font-mono uppercase tracking-wide">
              Scripts ({scripts.length})
            </span>
          </div>
          <div className="space-y-1.5">
            {scripts.map((c) => (
              <div key={c.id} className="px-2.5 py-1.5 bg-x-surface-2 rounded-md border border-x-accent-ink/20">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-x-ink font-mono">{c.name}</span>
                  {c.trigger && (
                    <span className="text-[11px] text-x-accent-ink/80 font-mono">on: {c.trigger}</span>
                  )}
                  {c.risk_level && (
                    <span className="text-[11px] text-x-faint">risk: {c.risk_level}</span>
                  )}
                </div>
                {c.description && (
                  <div className="text-[11px] text-x-muted mt-0.5">{c.description}</div>
                )}
                {c.permissions && c.permissions.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {c.permissions.map((p) => (
                      <span key={p} className="text-[11px] px-1 py-0.5 bg-x-surface rounded text-x-faint">
                        {p}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {(plugin.tags || []).length > 0 && (
        <div className="p-4">
          <div className="flex flex-wrap gap-1">
            {(plugin.tags || []).map((t) => (
              <span key={t} className="text-[11px] px-1.5 py-0.5 bg-x-surface-2 rounded text-x-faint">
                {t}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Registries (settings) tab ───────────────────────────────────────────

function RegistriesTab({ registries, onChange }) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(null) // registry id being acted on

  const refresh = useCallback(async () => {
    const list = await api.getPluginRegistries()
    onChange(list)
  }, [onChange])

  const handleAdd = async (e) => {
    e?.preventDefault?.()
    if (!name.trim() || !url.trim()) return
    try {
      await api.addPluginRegistry({ name: name.trim(), url: url.trim() })
      setName('')
      setUrl('')
      setAdding(false)
      await refresh()
    } catch (err) {
      alert(`Failed to add registry: ${err.message}`)
    }
  }

  const handleDelete = async (reg) => {
    if (reg.is_builtin) return
    if (!confirm(`Delete registry "${reg.name}"? Plugins from this registry will also be removed from the catalog.`)) return
    setBusy(reg.id)
    try {
      await api.deletePluginRegistry(reg.id)
      await refresh()
    } catch (err) {
      alert(`Failed to delete: ${err.message}`)
    } finally {
      setBusy(null)
    }
  }

  const handleToggle = async (reg) => {
    setBusy(reg.id)
    try {
      await api.updatePluginRegistry(reg.id, { enabled: !reg.enabled })
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const handleSync = async (reg) => {
    setBusy(reg.id)
    try {
      const result = await api.syncPluginRegistry(reg.id)
      if (!result.ok) {
        alert(`Sync failed: ${result.error}`)
      }
      await refresh()
    } catch (err) {
      alert(`Sync failed: ${err.message}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="overflow-y-auto max-h-full">
      <div className="p-4 border-b border-x-line">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-x-ink-secondary">
            Discovery servers
          </span>
          <button
            onClick={() => setAdding(!adding)}
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-x-ink-secondary hover:text-x-ink hover:bg-x-hover rounded-md transition-colors duration-[80ms] ease-x"
          >
            <Plus size={11} /> add
          </button>
        </div>
        <p className="text-[11px] text-x-faint leading-relaxed">
          A discovery server is a URL pointing to a plugin index JSON. Multiple
          servers can be configured — Commander aggregates plugins from all
          enabled servers. Built-in servers can be disabled but not deleted.
        </p>
      </div>

      {adding && (
        <form onSubmit={handleAdd} className="p-4 border-b border-x-line space-y-2 bg-x-surface-2/40">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="server name (e.g. Community)"
            className="w-full px-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
            autoFocus
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/registry/index.json"
            className="w-full px-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus font-mono"
          />
          <div className="flex gap-1.5">
            <button type="submit" className="px-3 py-1.5 text-xs font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent rounded-md transition-colors duration-[80ms] ease-x">add</button>
            <button type="button" onClick={() => setAdding(false)} className="px-3 py-1.5 text-xs font-medium bg-transparent border border-x-line hover:bg-x-hover hover:border-x-line-strong text-x-ink-secondary hover:text-x-ink rounded-md transition-colors duration-[80ms] ease-x">cancel</button>
          </div>
        </form>
      )}

      <div>
        {registries.map((reg) => (
          <div key={reg.id} className="p-3 border-b border-x-line-subtle">
            <div className="flex items-start gap-2">
              <Globe size={13} className={reg.enabled ? 'text-x-accent' : 'text-x-faint'} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-x-ink font-mono font-medium">{reg.name}</span>
                  {reg.is_builtin ? (
                    <span className="text-[11px] text-x-faint uppercase">built-in</span>
                  ) : null}
                  {!reg.enabled && (
                    <span className="text-[11px] text-x-faint uppercase">disabled</span>
                  )}
                </div>
                <div className="text-[11px] text-x-muted font-mono mt-0.5 break-all">{reg.url}</div>
                <div className="flex items-center gap-2 mt-1 text-[11px] text-x-faint font-mono">
                  <span>
                    {reg.last_sync_status === 'ok' && `✓ synced (${reg.plugin_count || 0} plugins)`}
                    {reg.last_sync_status === 'error' && `✗ error: ${reg.last_sync_error || 'unknown'}`}
                    {reg.last_sync_status === 'never' && 'never synced'}
                  </span>
                </div>
              </div>
              <div className="shrink-0 flex items-center gap-1">
                <button
                  onClick={() => handleSync(reg)}
                  disabled={busy === reg.id || !reg.enabled}
                  className="p-1 text-x-faint hover:text-x-accent transition-colors disabled:opacity-30"
                  title="Sync now"
                >
                  <RefreshCw size={11} className={busy === reg.id ? 'animate-spin' : ''} />
                </button>
                <button
                  onClick={() => handleToggle(reg)}
                  disabled={busy === reg.id}
                  className="px-1.5 py-0.5 text-[11px] text-x-faint hover:text-x-ink border border-x-line-subtle rounded transition-colors disabled:opacity-30"
                  title={reg.enabled ? 'Disable' : 'Enable'}
                >
                  {reg.enabled ? 'on' : 'off'}
                </button>
                {!reg.is_builtin && (
                  <button
                    onClick={() => handleDelete(reg)}
                    disabled={busy === reg.id}
                    className="p-1 text-x-faint hover:text-x-accent-ink transition-colors duration-[80ms] ease-x disabled:opacity-30"
                    title="Delete"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
        {registries.length === 0 && (
          <div className="px-4 py-10 text-xs text-x-faint text-center">
            No discovery servers configured.
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main panel ──────────────────────────────────────────────────────────

export default function MarketplacePanel({ onClose, initialTab, suggestedSkills }) {
  // Four tabs: locally installed, remote catalog, skills catalog, registry settings.
  const [tab, setTab] = useState(initialTab || 'local') // local | marketplace | skills | settings
  const [plugins, setPlugins] = useState([])
  const [registries, setRegistries] = useState([])
  const [query, setQuery] = useState('')
  const [registryFilter, setRegistryFilter] = useState('') // empty = all
  const [selectedPluginId, setSelectedPluginId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  // Skills catalog
  const [skills, setSkills] = useState([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsLoaded, setSkillsLoaded] = useState(false)
  const [skillVisible, setSkillVisible] = useState(50)
  const [selectedSkill, setSelectedSkill] = useState(null)
  const [skillFilter, setSkillFilter] = useState('all') // all | installed
  // Installed skills (from disk scan)
  const [installedOnDisk, setInstalledOnDisk] = useState([])
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const workspaces = useStore((s) => s.workspaces)
  // Fall back to first workspace when none is explicitly active
  const effectiveWorkspaceId = activeWorkspaceId || workspaces[0]?.id

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [pl, regs] = await Promise.all([
        api.getPlugins(),
        api.getPluginRegistries(),
      ])
      setPlugins(pl)
      setRegistries(regs)
    } catch (err) {
      console.error('marketplace refresh failed:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Lazy-load skills catalog + installed-on-disk when Skills tab is first viewed
  const refreshInstalledSkills = useCallback(async () => {
    try {
      const list = await api.getInstalledSkills(effectiveWorkspaceId, 'project')
      setInstalledOnDisk(list)
    } catch (e) {
      console.error('refreshInstalledSkills failed:', e)
    }
  }, [effectiveWorkspaceId])

  // Load installed-on-disk for both local and skills tabs
  useEffect(() => {
    if (tab === 'local' || tab === 'skills') refreshInstalledSkills()
  }, [tab, refreshInstalledSkills])

  useEffect(() => {
    if (tab === 'skills' && !skillsLoaded) {
      setSkillsLoading(true)
      api.getAgentSkills().then((list) => {
        setSkills(list)
        setSkillsLoaded(true)
      }).catch(() => {}).finally(() => setSkillsLoading(false))
    }
  }, [tab, skillsLoaded])

  const handleInstall = async (plugin, skipScripts = false) => {
    setBusy(true)
    try {
      const result = await api.installPlugin(plugin.id, { skip_scripts: skipScripts })
      if (!result.ok) {
        alert(`Install failed: ${result.error}`)
      } else {
        await refresh()
      }
    } catch (err) {
      alert(`Install failed: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  const handleUninstall = async (plugin) => {
    if (!confirm(`Uninstall "${plugin.name}"?`)) return
    setBusy(true)
    try {
      await api.uninstallPlugin(plugin.id)
      await refresh()
      if (selectedPluginId === plugin.id) setSelectedPluginId(null)
    } catch (err) {
      alert(`Uninstall failed: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  const handleInstallSkill = async (skill, cliTypes = ['claude']) => {
    setBusy(true)
    try {
      // Build full SKILL.md content with frontmatter
      let content = ''
      if (skill.repo && skill.source !== 'catalog') {
        try {
          const full = await api.getAgentSkill(skill.path, skill.repo)
          if (full?.content) {
            // Reconstruct full SKILL.md with frontmatter
            content = `---\nname: ${full.name}\ndescription: ${(full.description || '').replace(/\n/g, ' ')}\n`
            if (full.license) content += `license: ${full.license}\n`
            if (full.compatibility) content += `compatibility: ${full.compatibility}\n`
            if (full.allowed_tools) content += `allowed-tools: ${full.allowed_tools}\n`
            content += `---\n\n${full.content}`
          }
        } catch { /* fall back */ }
      }
      if (!content) {
        // Catalog skill — build from metadata
        content = `---\nname: ${skill.name}\ndescription: ${(skill.description || '').replace(/\n/g, ' ')}\n---\n\n${skill.description || ''}`
      }

      const res = await api.installAgentSkill({
        name: skill.name,
        content,
        workspace_id: effectiveWorkspaceId,
        cli_types: cliTypes,
        scope: 'project',
        source_url: skill.source_url || '',
        repo: skill.repo || '',
        skill_path: skill.path || '',
      })
      // Check if any CLI install actually succeeded
      const results = res?.results || {}
      const anyOk = Object.values(results).some((r) => r.ok)
      if (!anyOk) {
        const firstErr = Object.values(results).find((r) => r.error)?.error || 'Unknown error'
        useStore.getState().addNotification({
          type: 'error',
          message: `Skill install failed: ${firstErr}`,
        })
        return
      }
      await refreshInstalledSkills()
      // Notify: restart needed for running sessions
      useStore.getState().addNotification({
        type: 'skill_installed',
        message: `Skill "${skill.name}" installed. Restart active sessions to use it.`,
      })
    } catch (e) {
      console.error('Skill install failed:', e)
    } finally {
      setBusy(false)
    }
  }

  const handleUninstallSkill = async (skill, cliTypes = ['claude']) => {
    setBusy(true)
    try {
      await api.uninstallAgentSkill({
        name: skill.name || skill.slug,
        workspace_id: effectiveWorkspaceId,
        cli_types: cliTypes,
        scope: 'project',
      })
      await refreshInstalledSkills()
    } catch (e) {
      console.error('Skill uninstall failed:', e)
    } finally {
      setBusy(false)
    }
  }

  const handleSyncSkill = async (skill, fromCli, toCli) => {
    setBusy(true)
    try {
      await api.syncAgentSkill({
        name: skill.name || skill.slug,
        from_cli: fromCli,
        to_cli: toCli,
        workspace_id: effectiveWorkspaceId,
        scope: 'project',
      })
      await refreshInstalledSkills()
    } catch (e) {
      console.error('Skill sync failed:', e)
    } finally {
      setBusy(false)
    }
  }

  const handleSyncAll = async () => {
    setBusy(true)
    try {
      await api.syncAllPluginRegistries()
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  // Filter plugins by tab + search
  const filtered = plugins.filter((p) => {
    if (tab === 'local' && !p.installed) return false
    if (tab === 'marketplace' && p.installed) return false
    if (registryFilter && p.registry_id !== registryFilter) return false
    if (query) {
      const q = query.toLowerCase()
      const hay = [
        p.name,
        p.description,
        p.author,
        ...(p.categories || []),
        ...(p.tags || []),
      ].join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] bg-x-scrim backdrop-blur-[4px]" onClick={onClose}>
      <div
        className="w-[760px] max-h-[80vh] x-panel overflow-hidden scale-in flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-x-line">
          <Package size={14} className="text-x-accent" />
          <span className="text-xs text-x-ink-secondary font-medium">Plugins & Skills</span>
          <div className="flex-1" />
          {tab !== 'settings' && (
            <button
              onClick={handleSyncAll}
              disabled={busy}
              className="flex items-center gap-1 px-2 py-1 text-[11px] text-x-faint hover:text-x-ink-secondary hover:bg-x-hover rounded transition-colors disabled:opacity-30"
              title="Sync all registries"
            >
              <RefreshCw size={11} className={busy ? 'animate-spin' : ''} />
              sync all
            </button>
          )}
          <button onClick={onClose} className="p-1 rounded-md hover:bg-x-hover text-x-faint hover:text-x-ink-secondary transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-x-line text-xs h-8">
          <button
            onClick={() => { setTab('local'); setSelectedPluginId(null) }}
            className={`flex items-center gap-1.5 px-4 transition-colors duration-[80ms] ease-x ${
              tab === 'local'
                ? 'text-x-ink border-b-[1.5px] border-x-accent -mb-px'
                : 'text-x-muted hover:text-x-ink-secondary'
            }`}
          >
            <HardDrive size={11} />
            Installed
            <span className="text-[11px] text-x-faint">
              ({plugins.filter((p) => p.installed).length + installedOnDisk.length})
            </span>
          </button>
          <button
            onClick={() => { setTab('marketplace'); setSelectedPluginId(null) }}
            className={`flex items-center gap-1.5 px-4 transition-colors duration-[80ms] ease-x ${
              tab === 'marketplace'
                ? 'text-x-ink border-b-[1.5px] border-x-accent -mb-px'
                : 'text-x-muted hover:text-x-ink-secondary'
            }`}
          >
            <Globe size={11} />
            Marketplace
            <span className="text-[11px] text-x-faint">
              ({plugins.filter((p) => !p.installed).length})
            </span>
          </button>
          <button
            onClick={() => { setTab('skills'); setSelectedPluginId(null); setSelectedSkill(null) }}
            className={`flex items-center gap-1.5 px-4 transition-colors duration-[80ms] ease-x ${
              tab === 'skills'
                ? 'text-x-ink border-b-[1.5px] border-x-accent -mb-px'
                : 'text-x-muted hover:text-x-ink-secondary'
            }`}
          >
            <Zap size={11} />
            Skills
            {skillsLoaded && <span className="text-[11px] text-x-faint">({skills.length.toLocaleString()})</span>}
          </button>
          <button
            onClick={() => { setTab('settings'); setSelectedPluginId(null) }}
            className={`flex items-center gap-1.5 px-4 transition-colors duration-[80ms] ease-x ${
              tab === 'settings'
                ? 'text-x-ink border-b-[1.5px] border-x-accent -mb-px'
                : 'text-x-muted hover:text-x-ink-secondary'
            }`}
          >
            <Settings size={11} />
            Servers
            <span className="text-[11px] text-x-faint">({registries.length})</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden flex">
          {tab === 'skills' ? (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Skills search + filter */}
              <div className="px-4 py-2 border-b border-x-line flex items-center gap-2">
                <Search size={11} className="text-x-faint" />
                <input
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setSkillVisible(50) }}
                  placeholder={skillFilter === 'installed' ? 'search installed skills…' : 'search available skills…'}
                  className="flex-1 bg-transparent text-xs text-x-ink placeholder:text-x-muted font-mono focus:outline-none"
                />
                <div className="shrink-0 flex rounded-md border border-x-line overflow-hidden">
                  <button
                    onClick={() => setSkillFilter('all')}
                    className={`px-2 py-0.5 text-[11px] font-medium transition-colors duration-[80ms] ease-x ${
                      skillFilter === 'all'
                        ? 'text-x-ink bg-x-hover'
                        : 'text-x-muted hover:text-x-ink-secondary'
                    }`}
                  >
                    catalog
                  </button>
                  <button
                    onClick={() => setSkillFilter('installed')}
                    className={`px-2 py-0.5 text-[11px] font-medium border-l border-x-line transition-colors duration-[80ms] ease-x ${
                      skillFilter === 'installed'
                        ? 'text-x-good bg-x-good/10'
                        : 'text-x-muted hover:text-x-ink-secondary'
                    }`}
                  >
                    installed ({installedOnDisk.length})
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                {suggestedSkills?.length > 0 && !query && skillFilter === 'all' && (
                  <div className="border-b border-x-line bg-x-surface-2">
                    <div className="flex items-center gap-1.5 px-4 py-1.5 border-b border-x-line">
                      <Zap size={11} strokeWidth={1.75} className="text-x-accent-ink" />
                      <span className="text-xs font-medium text-x-accent-ink">Suggested for you</span>
                    </div>
                    {suggestedSkills.map((s, i) => (
                      <div
                        key={i}
                        className="group px-4 py-2.5 border-b border-x-line last:border-0 hover:bg-x-hover cursor-pointer transition-colors duration-[80ms] ease-x"
                        onClick={() => {
                          const match = skills.find((sk) => sk.name === s.name) || s
                          setSelectedSkill(match)
                        }}
                      >
                        <div className="flex items-start gap-2">
                          <Zap size={12} strokeWidth={1.75} className="text-x-accent-ink mt-0.5 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <span className="text-xs text-x-accent-ink font-medium">{s.name}</span>
                            {s.description && (
                              <p className="text-[11px] text-x-muted font-mono mt-0.5 line-clamp-1 leading-relaxed">{s.description}</p>
                            )}
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleInstallSkill(s) }}
                            disabled={busy}
                            className="shrink-0 opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium bg-x-accent-ink/20 hover:bg-x-accent-ink/30 text-x-accent-ink border border-x-accent-ink/30 rounded-md transition-colors duration-[80ms] ease-x disabled:opacity-30"
                          >
                            <Download size={9} />
                            install
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {skillsLoading ? (
                  <div className="px-4 py-10 text-xs text-x-faint text-center">
                    <RefreshCw size={16} className="animate-spin mx-auto mb-2 text-x-muted" />
                    Loading skills catalog…
                  </div>
                ) : (() => {
                  const q = query.toLowerCase()
                  // Build installed lookup
                  const installedSlugs = new Set(installedOnDisk.map(s => s.slug))
                  const diskBySlug = Object.fromEntries(installedOnDisk.map(s => [s.slug, s]))

                  let filteredSkills
                  if (skillFilter === 'installed') {
                    // Show installed-on-disk skills (merge with catalog data for descriptions)
                    filteredSkills = installedOnDisk.map((disk) => {
                      // Try to find matching catalog entry for richer metadata
                      const cat = skills.find((s) => {
                        const slug = s.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
                        return slug === disk.slug
                      })
                      return { ...disk, ...(cat || {}), name: disk.name, installed_for: disk.installed_for }
                    })
                    if (q) {
                      filteredSkills = filteredSkills.filter((s) =>
                        s.name.toLowerCase().includes(q) ||
                        (s.description || '').toLowerCase().includes(q)
                      )
                    }
                  } else {
                    filteredSkills = query
                      ? skills.filter((s) =>
                          s.name.toLowerCase().includes(q) ||
                          (s.description || '').toLowerCase().includes(q) ||
                          (s.category || '').toLowerCase().includes(q) ||
                          (s.tags || '').toLowerCase().includes(q) ||
                          (s.author || '').toLowerCase().includes(q)
                        )
                      : skills
                  }
                  const visible = filteredSkills.slice(0, skillVisible)
                  return visible.length > 0 ? (
                    <>
                      {visible.map((skill) => {
                        const slug = skill.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
                        const diskInfo = diskBySlug[slug]
                        const isInstalled = !!diskInfo
                        const clis = diskInfo?.installed_for || []
                        return (
                          <div
                            key={skill.path + skill.name}
                            className="group p-3 border-b border-x-line-subtle hover:bg-x-hover/50 cursor-pointer transition-colors"
                            onClick={() => setSelectedSkill(skill)}
                          >
                            <div className="flex items-start gap-2">
                              <Zap size={13} strokeWidth={1.75} className="text-x-accent-ink mt-0.5 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="text-xs text-x-ink font-mono font-medium truncate">{skill.name}</span>
                                  {skill.category && (
                                    <span className="text-[11px] text-x-faint font-mono px-1 py-0.5 bg-x-surface-2 rounded">{skill.category}</span>
                                  )}
                                  {isInstalled && clis.map(c => (
                                    <span key={c} className={`text-[11px] font-medium uppercase px-1 py-0.5 rounded ${
                                      c === 'claude' ? 'text-x-accent bg-x-accent/10' : 'text-x-ink-secondary bg-x-muted/10'
                                    }`}>{c}</span>
                                  ))}
                                </div>
                                {skill.description && (
                                  <p className="text-[11px] text-x-muted font-mono mt-0.5 line-clamp-2 leading-relaxed">{skill.description}</p>
                                )}
                                <div className="flex items-center gap-2 mt-1 text-[11px] text-x-faint font-mono">
                                  {skill.author && <span>by {skill.author}</span>}
                                  {skill.tags && <span className="px-1 py-0.5 bg-x-accent-ink/10 text-x-accent-ink/80 rounded">{skill.tags}</span>}
                                </div>
                              </div>
                              <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                {isInstalled ? (
                                  <>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleUninstallSkill(skill) }}
                                      disabled={busy}
                                      className="p-1 text-x-faint hover:text-x-accent-ink transition-colors duration-[80ms] ease-x disabled:opacity-30"
                                      title="Uninstall"
                                    >
                                      <Trash2 size={11} />
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleInstallSkill(skill) }}
                                    disabled={busy}
                                    className="px-2 py-0.5 text-[11px] font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent rounded-md transition-colors duration-[80ms] ease-x disabled:opacity-30"
                                  >
                                    install
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        )
                      })}
                      {skillVisible < filteredSkills.length && (
                        <button
                          onClick={() => setSkillVisible((c) => c + 50)}
                          className="w-full py-3 text-xs text-x-muted hover:text-x-ink-secondary hover:bg-x-hover transition-colors font-mono"
                        >
                          show more ({(filteredSkills.length - skillVisible).toLocaleString()} remaining)
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="px-4 py-10 text-xs text-x-faint text-center">
                      {skillFilter === 'installed'
                        ? (query ? 'No matching installed skills' : 'No skills installed yet — browse the catalog and install some')
                        : (query ? 'No matching skills' : 'No skills found')}
                    </div>
                  )
                })()}
              </div>
            </div>
          ) : tab === 'settings' ? (
            <RegistriesTab registries={registries} onChange={setRegistries} />
          ) : selectedPluginId ? (
            <PluginDetail
              pluginId={selectedPluginId}
              onClose={() => setSelectedPluginId(null)}
              onInstall={handleInstall}
              onUninstall={handleUninstall}
              busy={busy}
            />
          ) : (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Search + filter */}
              <div className="px-4 py-2 border-b border-x-line flex items-center gap-2">
                <Search size={11} className="text-x-faint" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="search plugins…"
                  className="flex-1 bg-transparent text-xs text-x-ink placeholder-x-faint font-mono focus:outline-none"
                />
                {tab === 'marketplace' && registries.length > 1 && (
                  <select
                    value={registryFilter}
                    onChange={(e) => setRegistryFilter(e.target.value)}
                    className="text-[11px] bg-x-surface-2 border border-x-line rounded px-1.5 py-0.5 text-x-ink-secondary"
                  >
                    <option value="">all servers</option>
                    {registries.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                )}
              </div>

              {/* Plugin list */}
              <div className="flex-1 overflow-y-auto">
                {loading ? (
                  <div className="px-4 py-10 text-xs text-x-faint text-center">loading…</div>
                ) : (filtered.length === 0 && (tab !== 'local' || installedOnDisk.length === 0)) ? (
                  <div className="px-4 py-10 text-xs text-x-faint text-center space-y-2">
                    {tab === 'local' ? (
                      <>
                        <Download size={20} className="mx-auto text-x-faint/40" />
                        <div>No plugins or skills installed yet.</div>
                        <div className="text-[11px]">Browse the Skills tab or Marketplace to get started.</div>
                      </>
                    ) : (
                      <>
                        <Globe size={20} className="mx-auto text-x-faint/40" />
                        <div>No plugins found.</div>
                        <div className="text-[11px]">
                          Try syncing your discovery servers, or add a new one in Settings.
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <>
                    {filtered.map((p) => (
                      <PluginCard
                        key={p.id}
                        plugin={p}
                        onInstall={handleInstall}
                        onUninstall={handleUninstall}
                        onSelect={(pl) => setSelectedPluginId(pl.id)}
                        busy={busy}
                      />
                    ))}
                    {/* Show installed-on-disk skills in the Installed tab */}
                    {tab === 'local' && installedOnDisk.length > 0 && (
                      <>
                        {filtered.length > 0 && (
                          <div className="px-4 py-1.5 text-xs font-medium text-x-ink-secondary border-t border-x-line mt-1">
                            Skills on disk
                          </div>
                        )}
                        {installedOnDisk
                          .filter((s) => !query || s.name.toLowerCase().includes(query.toLowerCase()))
                          .map((skill) => (
                          <div key={skill.slug} className="group p-3 border-b border-x-line-subtle hover:bg-x-hover/50 transition-colors">
                            <div className="flex items-start gap-2">
                              <Zap size={13} strokeWidth={1.75} className="text-x-accent-ink mt-0.5 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="text-xs text-x-ink font-mono font-medium">{skill.name}</span>
                                  {skill.installed_for?.map((c) => (
                                    <span key={c} className={`text-[11px] font-medium uppercase px-1 py-0.5 rounded ${
                                      c === 'claude' ? 'text-x-accent bg-x-accent/10' : 'text-x-ink-secondary bg-x-muted/10'
                                    }`}>{c}</span>
                                  ))}
                                  {skill.has_scripts && (
                                    <span className="text-[11px] text-x-accent-ink/80 px-1 py-0.5 bg-x-accent-ink/10 rounded">scripts</span>
                                  )}
                                </div>
                                {skill.description && (
                                  <p className="text-[11px] text-x-muted font-mono mt-0.5 line-clamp-2">{skill.description}</p>
                                )}
                              </div>
                              <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  onClick={() => handleUninstallSkill(skill)}
                                  disabled={busy}
                                  className="p-1 text-x-faint hover:text-x-accent-ink transition-colors duration-[80ms] ease-x disabled:opacity-30"
                                >
                                  <Trash2 size={11} />
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
