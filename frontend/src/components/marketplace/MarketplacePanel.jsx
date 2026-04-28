import { useState, useEffect, useCallback } from 'react'
import useStore from '../../state/store'
import {
  Package, X, Plus, Trash2, RefreshCw, Globe, HardDrive, Settings,
  Shield, AlertTriangle, FileCode, Check, Search, Download, ExternalLink,
  Zap,
} from 'lucide-react'
import { api } from '../../lib/api'

// ─── Security tier presentation ──────────────────────────────────────────
// Tier 0 = text-only (safest), tier 3 = unverified raw source.
const TIERS = {
  0: { label: 'Text Only',     color: 'text-emerald-400', bg: 'bg-emerald-500/10',  border: 'border-emerald-500/30', icon: Shield },
  1: { label: 'Sandboxed',     color: 'text-amber-400',   bg: 'bg-amber-500/10',    border: 'border-amber-500/30',   icon: AlertTriangle },
  2: { label: 'Extended Perm', color: 'text-orange-400',  bg: 'bg-orange-500/10',   border: 'border-orange-500/30',  icon: AlertTriangle },
  3: { label: 'Unverified',    color: 'text-red-400',     bg: 'bg-red-500/10',      border: 'border-red-500/30',     icon: AlertTriangle },
}

function TierBadge({ tier }) {
  const t = TIERS[tier ?? 0] || TIERS[0]
  const Icon = t.icon
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded ${t.bg} ${t.color} border ${t.border}`}>
      <Icon size={9} />
      {t.label}
    </span>
  )
}

// ─── Plugin card ─────────────────────────────────────────────────────────

function PluginCard({ plugin, onInstall, onUninstall, onSelect, busy }) {
  const isInstalled = !!plugin.installed
  return (
    <div
      onClick={() => onSelect(plugin)}
      className="group p-3 border-b border-border-secondary hover:bg-bg-hover/50 cursor-pointer transition-colors"
    >
      <div className="flex items-start gap-2">
        <div className="shrink-0 mt-0.5">
          <Package size={14} className="text-accent-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-text-primary font-mono font-medium truncate">
              {plugin.name}
            </span>
            {plugin.version && (
              <span className="text-[10px] text-text-faint font-mono">v{plugin.version}</span>
            )}
            <TierBadge tier={plugin.security_tier} />
            {plugin.contains_scripts ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-amber-400/80">
                <FileCode size={9} /> scripts
              </span>
            ) : null}
            {isInstalled && (
              <span className="text-[10px] text-emerald-400 font-medium uppercase">installed</span>
            )}
          </div>
          {plugin.description && (
            <p className="text-[11px] text-text-muted font-mono mt-0.5 line-clamp-2 leading-relaxed">
              {plugin.description}
            </p>
          )}
          <div className="flex items-center gap-2 mt-1 text-[10px] text-text-faint font-mono">
            {plugin.author && <span>by {plugin.author}</span>}
            {plugin.source_format && plugin.source_format !== 'unknown' && (
              <span className="px-1 py-0.5 bg-bg-inset rounded">{plugin.source_format}</span>
            )}
            {(plugin.categories || []).slice(0, 3).map((c) => (
              <span key={c} className="px-1 py-0.5 bg-bg-inset rounded">{c}</span>
            ))}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {isInstalled ? (
            <button
              onClick={(e) => { e.stopPropagation(); onUninstall(plugin) }}
              disabled={busy}
              className="p-1 text-text-faint hover:text-red-400 transition-colors disabled:opacity-30"
              title="Uninstall"
            >
              <Trash2 size={12} />
            </button>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); onInstall(plugin) }}
              disabled={busy}
              className="px-2 py-0.5 text-[10px] font-medium bg-accent-primary hover:bg-accent-hover text-white rounded transition-colors disabled:opacity-30"
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

function PluginDetail({ pluginId, onClose, onInstall, onUninstall, busy }) {
  const [plugin, setPlugin] = useState(null)

  useEffect(() => {
    if (!pluginId) return
    api.getPlugin(pluginId).then(setPlugin)
  }, [pluginId])

  if (!plugin) {
    return (
      <div className="p-6 text-xs text-text-faint">loading…</div>
    )
  }

  const guidelines = (plugin.components || []).filter((c) => c.type === 'guideline')
  const scripts = (plugin.components || []).filter((c) => c.type === 'script')

  return (
    <div className="overflow-y-auto max-h-full">
      <div className="p-4 border-b border-border-primary">
        <button onClick={onClose} className="text-[10px] text-text-faint hover:text-text-secondary mb-2">← back</button>
        <div className="flex items-start gap-3">
          <Package size={18} className="text-accent-primary mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm text-text-primary font-mono font-medium">{plugin.name}</h2>
              {plugin.version && <span className="text-[11px] text-text-faint font-mono">v{plugin.version}</span>}
              <TierBadge tier={plugin.security_tier} />
            </div>
            {plugin.author && (
              <p className="text-[11px] text-text-muted font-mono mt-0.5">by {plugin.author}</p>
            )}
            {plugin.description && (
              <p className="text-xs text-text-secondary mt-2 leading-relaxed">{plugin.description}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 mt-3">
          {plugin.installed ? (
            <button
              onClick={() => onUninstall(plugin)}
              disabled={busy}
              className="px-3 py-1.5 text-xs font-medium bg-red-500/80 hover:bg-red-500 text-white rounded-md transition-colors disabled:opacity-50"
            >
              uninstall
            </button>
          ) : (
            <>
              <button
                onClick={() => onInstall(plugin, false)}
                disabled={busy || !plugin.package_url}
                className="px-3 py-1.5 text-xs font-medium bg-accent-primary hover:bg-accent-hover text-white rounded-md transition-colors disabled:opacity-50"
              >
                {plugin.contains_scripts ? 'install all' : 'install'}
              </button>
              {plugin.contains_scripts && (
                <button
                  onClick={() => onInstall(plugin, true)}
                  disabled={busy || !plugin.package_url}
                  className="px-3 py-1.5 text-xs font-medium bg-bg-tertiary hover:bg-bg-hover text-text-primary rounded-md transition-colors disabled:opacity-50"
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
              className="inline-flex items-center gap-1 px-2 py-1.5 text-[11px] text-text-secondary hover:text-text-primary"
            >
              <ExternalLink size={11} /> source
            </a>
          )}
        </div>
      </div>

      {/* Guidelines section */}
      {guidelines.length > 0 && (
        <div className="p-4 border-b border-border-primary">
          <div className="flex items-center gap-1.5 mb-2">
            <Shield size={11} className="text-emerald-400" />
            <span className="text-[11px] text-text-secondary font-mono uppercase tracking-wide">
              Guidelines ({guidelines.length})
            </span>
          </div>
          <div className="space-y-1.5">
            {guidelines.map((c) => (
              <div key={c.id} className="px-2.5 py-1.5 bg-bg-inset rounded border border-border-secondary">
                <div className="text-[11px] text-text-primary font-mono">{c.name}</div>
                {c.description && (
                  <div className="text-[10px] text-text-muted mt-0.5">{c.description}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scripts section */}
      {scripts.length > 0 && (
        <div className="p-4 border-b border-border-primary">
          <div className="flex items-center gap-1.5 mb-2">
            <FileCode size={11} className="text-amber-400" />
            <span className="text-[11px] text-text-secondary font-mono uppercase tracking-wide">
              Scripts ({scripts.length})
            </span>
          </div>
          <div className="space-y-1.5">
            {scripts.map((c) => (
              <div key={c.id} className="px-2.5 py-1.5 bg-bg-inset rounded border border-amber-500/20">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-text-primary font-mono">{c.name}</span>
                  {c.trigger && (
                    <span className="text-[9px] text-amber-400/80 font-mono">on: {c.trigger}</span>
                  )}
                  {c.risk_level && (
                    <span className="text-[9px] text-text-faint">risk: {c.risk_level}</span>
                  )}
                </div>
                {c.description && (
                  <div className="text-[10px] text-text-muted mt-0.5">{c.description}</div>
                )}
                {c.permissions && c.permissions.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {c.permissions.map((p) => (
                      <span key={p} className="text-[9px] px-1 py-0.5 bg-bg-tertiary rounded text-text-faint">
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
              <span key={t} className="text-[10px] px-1.5 py-0.5 bg-bg-inset rounded text-text-faint">
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
      <div className="p-4 border-b border-border-primary">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] text-text-secondary font-mono uppercase tracking-wide">
            Discovery Servers
          </span>
          <button
            onClick={() => setAdding(!adding)}
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
          >
            <Plus size={11} /> add
          </button>
        </div>
        <p className="text-[10px] text-text-faint leading-relaxed">
          A discovery server is a URL pointing to a plugin index JSON. Multiple
          servers can be configured — Commander aggregates plugins from all
          enabled servers. Built-in servers can be disabled but not deleted.
        </p>
      </div>

      {adding && (
        <form onSubmit={handleAdd} className="p-4 border-b border-border-primary space-y-2 bg-bg-inset/40">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="server name (e.g. Community)"
            className="w-full px-2.5 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono"
            autoFocus
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/registry/index.json"
            className="w-full px-2.5 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono"
          />
          <div className="flex gap-1.5">
            <button type="submit" className="px-3 py-1.5 text-xs font-medium bg-accent-primary hover:bg-accent-hover text-white rounded-md">add</button>
            <button type="button" onClick={() => setAdding(false)} className="px-3 py-1.5 text-xs font-medium bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded-md">cancel</button>
          </div>
        </form>
      )}

      <div>
        {registries.map((reg) => (
          <div key={reg.id} className="p-3 border-b border-border-secondary">
            <div className="flex items-start gap-2">
              <Globe size={13} className={reg.enabled ? 'text-accent-primary' : 'text-text-faint'} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-text-primary font-mono font-medium">{reg.name}</span>
                  {reg.is_builtin ? (
                    <span className="text-[9px] text-text-faint uppercase">built-in</span>
                  ) : null}
                  {!reg.enabled && (
                    <span className="text-[9px] text-text-faint uppercase">disabled</span>
                  )}
                </div>
                <div className="text-[10px] text-text-muted font-mono mt-0.5 break-all">{reg.url}</div>
                <div className="flex items-center gap-2 mt-1 text-[10px] text-text-faint font-mono">
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
                  className="p-1 text-text-faint hover:text-accent-primary transition-colors disabled:opacity-30"
                  title="Sync now"
                >
                  <RefreshCw size={11} className={busy === reg.id ? 'animate-spin' : ''} />
                </button>
                <button
                  onClick={() => handleToggle(reg)}
                  disabled={busy === reg.id}
                  className="px-1.5 py-0.5 text-[10px] text-text-faint hover:text-text-primary border border-border-secondary rounded transition-colors disabled:opacity-30"
                  title={reg.enabled ? 'Disable' : 'Enable'}
                >
                  {reg.enabled ? 'on' : 'off'}
                </button>
                {!reg.is_builtin && (
                  <button
                    onClick={() => handleDelete(reg)}
                    disabled={busy === reg.id}
                    className="p-1 text-text-faint hover:text-red-400 transition-colors disabled:opacity-30"
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
          <div className="px-4 py-10 text-xs text-text-faint text-center">
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

  const handleInstallSkill = async (skill, cliTypes = ['claude', 'gemini']) => {
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

  const handleUninstallSkill = async (skill, cliTypes = ['claude', 'gemini']) => {
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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] bg-black/50" onClick={onClose}>
      <div
        className="w-[760px] max-h-[80vh] ide-panel overflow-hidden scale-in flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary">
          <Package size={14} className="text-accent-primary" />
          <span className="text-xs text-text-secondary font-medium">Plugins & Skills</span>
          <div className="flex-1" />
          {tab !== 'settings' && (
            <button
              onClick={handleSyncAll}
              disabled={busy}
              className="flex items-center gap-1 px-2 py-1 text-[11px] text-text-faint hover:text-text-secondary hover:bg-bg-hover rounded transition-colors disabled:opacity-30"
              title="Sync all registries"
            >
              <RefreshCw size={11} className={busy ? 'animate-spin' : ''} />
              sync all
            </button>
          )}
          <button onClick={onClose} className="p-1 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-border-primary text-xs">
          <button
            onClick={() => { setTab('local'); setSelectedPluginId(null) }}
            className={`flex items-center gap-1.5 px-4 py-2 transition-colors ${
              tab === 'local'
                ? 'text-text-primary border-b-2 border-accent-primary -mb-px'
                : 'text-text-faint hover:text-text-secondary'
            }`}
          >
            <HardDrive size={11} />
            Installed
            <span className="text-[10px] text-text-faint">
              ({plugins.filter((p) => p.installed).length + installedOnDisk.length})
            </span>
          </button>
          <button
            onClick={() => { setTab('marketplace'); setSelectedPluginId(null) }}
            className={`flex items-center gap-1.5 px-4 py-2 transition-colors ${
              tab === 'marketplace'
                ? 'text-text-primary border-b-2 border-accent-primary -mb-px'
                : 'text-text-faint hover:text-text-secondary'
            }`}
          >
            <Globe size={11} />
            Marketplace
            <span className="text-[10px] text-text-faint">
              ({plugins.filter((p) => !p.installed).length})
            </span>
          </button>
          <button
            onClick={() => { setTab('skills'); setSelectedPluginId(null); setSelectedSkill(null) }}
            className={`flex items-center gap-1.5 px-4 py-2 transition-colors ${
              tab === 'skills'
                ? 'text-text-primary border-b-2 border-amber-400 -mb-px'
                : 'text-text-faint hover:text-text-secondary'
            }`}
          >
            <Zap size={11} />
            Skills
            {skillsLoaded && <span className="text-[10px] text-text-faint">({skills.length.toLocaleString()})</span>}
          </button>
          <button
            onClick={() => { setTab('settings'); setSelectedPluginId(null) }}
            className={`flex items-center gap-1.5 px-4 py-2 transition-colors ${
              tab === 'settings'
                ? 'text-text-primary border-b-2 border-accent-primary -mb-px'
                : 'text-text-faint hover:text-text-secondary'
            }`}
          >
            <Settings size={11} />
            Servers
            <span className="text-[10px] text-text-faint">({registries.length})</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden flex">
          {tab === 'skills' ? (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Skills search + filter */}
              <div className="px-4 py-2 border-b border-border-primary flex items-center gap-2">
                <Search size={11} className="text-text-faint" />
                <input
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setSkillVisible(50) }}
                  placeholder={skillFilter === 'installed' ? 'search installed skills…' : 'search 8,000+ skills…'}
                  className="flex-1 bg-transparent text-xs text-text-primary placeholder-text-faint font-mono focus:outline-none"
                />
                <div className="shrink-0 flex rounded border border-border-primary overflow-hidden">
                  <button
                    onClick={() => setSkillFilter('all')}
                    className={`px-2 py-0.5 text-[10px] font-mono transition-colors ${
                      skillFilter === 'all'
                        ? 'text-text-primary bg-bg-hover'
                        : 'text-text-faint hover:text-text-secondary'
                    }`}
                  >
                    catalog
                  </button>
                  <button
                    onClick={() => setSkillFilter('installed')}
                    className={`px-2 py-0.5 text-[10px] font-mono border-l border-border-primary transition-colors ${
                      skillFilter === 'installed'
                        ? 'text-emerald-400 bg-emerald-500/10'
                        : 'text-text-faint hover:text-text-secondary'
                    }`}
                  >
                    installed ({installedOnDisk.length})
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                {suggestedSkills?.length > 0 && !query && skillFilter === 'all' && (
                  <div className="border-b border-amber-500/20 bg-amber-500/5">
                    <div className="flex items-center gap-1.5 px-4 py-1.5 border-b border-amber-500/10">
                      <Zap size={10} className="text-amber-400" />
                      <span className="text-[10px] font-mono text-amber-400 font-medium uppercase tracking-wider">Suggested for you</span>
                    </div>
                    {suggestedSkills.map((s, i) => (
                      <div
                        key={i}
                        className="group px-4 py-2.5 border-b border-amber-500/10 last:border-0 hover:bg-amber-500/10 cursor-pointer transition-colors"
                        onClick={() => {
                          const match = skills.find((sk) => sk.name === s.name) || s
                          setSelectedSkill(match)
                        }}
                      >
                        <div className="flex items-start gap-2">
                          <Zap size={12} className="text-amber-400 mt-0.5 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <span className="text-xs text-amber-300 font-mono font-medium">{s.name}</span>
                            {s.description && (
                              <p className="text-[11px] text-text-muted font-mono mt-0.5 line-clamp-1 leading-relaxed">{s.description}</p>
                            )}
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleInstallSkill(s) }}
                            disabled={busy}
                            className="shrink-0 opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/30 rounded transition-colors disabled:opacity-30"
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
                  <div className="px-4 py-10 text-xs text-text-faint text-center">
                    <RefreshCw size={16} className="animate-spin mx-auto mb-2 text-text-muted" />
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
                            className="group p-3 border-b border-border-secondary hover:bg-bg-hover/50 cursor-pointer transition-colors"
                            onClick={() => setSelectedSkill(skill)}
                          >
                            <div className="flex items-start gap-2">
                              <Zap size={13} className="text-amber-400 mt-0.5 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="text-xs text-text-primary font-mono font-medium truncate">{skill.name}</span>
                                  {skill.category && (
                                    <span className="text-[10px] text-text-faint font-mono px-1 py-0.5 bg-bg-inset rounded">{skill.category}</span>
                                  )}
                                  {isInstalled && clis.map(c => (
                                    <span key={c} className={`text-[10px] font-medium uppercase px-1 py-0.5 rounded ${
                                      c === 'claude' ? 'text-indigo-400 bg-indigo-500/10' : 'text-blue-400 bg-blue-500/10'
                                    }`}>{c}</span>
                                  ))}
                                </div>
                                {skill.description && (
                                  <p className="text-[11px] text-text-muted font-mono mt-0.5 line-clamp-2 leading-relaxed">{skill.description}</p>
                                )}
                                <div className="flex items-center gap-2 mt-1 text-[10px] text-text-faint font-mono">
                                  {skill.author && <span>by {skill.author}</span>}
                                  {skill.tags && <span className="px-1 py-0.5 bg-amber-500/10 text-amber-400/80 rounded">{skill.tags}</span>}
                                </div>
                              </div>
                              <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                {isInstalled ? (
                                  <>
                                    {clis.length === 1 && (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); handleSyncSkill(skill, clis[0], clis[0] === 'claude' ? 'gemini' : 'claude') }}
                                        disabled={busy}
                                        className="px-1.5 py-0.5 text-[10px] text-text-faint hover:text-text-secondary border border-border-primary rounded transition-colors disabled:opacity-30"
                                        title={`Sync to ${clis[0] === 'claude' ? 'Gemini' : 'Claude'}`}
                                      >
                                        sync→{clis[0] === 'claude' ? 'gem' : 'claude'}
                                      </button>
                                    )}
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleUninstallSkill(skill) }}
                                      disabled={busy}
                                      className="p-1 text-text-faint hover:text-red-400 transition-colors disabled:opacity-30"
                                      title="Uninstall"
                                    >
                                      <Trash2 size={11} />
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleInstallSkill(skill) }}
                                    disabled={busy}
                                    className="px-2 py-0.5 text-[10px] font-medium bg-amber-500/80 hover:bg-amber-500 text-white rounded transition-colors disabled:opacity-30"
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
                          className="w-full py-3 text-xs text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors font-mono"
                        >
                          show more ({(filteredSkills.length - skillVisible).toLocaleString()} remaining)
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="px-4 py-10 text-xs text-text-faint text-center">
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
              <div className="px-4 py-2 border-b border-border-primary flex items-center gap-2">
                <Search size={11} className="text-text-faint" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="search plugins…"
                  className="flex-1 bg-transparent text-xs text-text-primary placeholder-text-faint font-mono focus:outline-none"
                />
                {tab === 'marketplace' && registries.length > 1 && (
                  <select
                    value={registryFilter}
                    onChange={(e) => setRegistryFilter(e.target.value)}
                    className="text-[11px] bg-bg-inset border border-border-primary rounded px-1.5 py-0.5 text-text-secondary"
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
                  <div className="px-4 py-10 text-xs text-text-faint text-center">loading…</div>
                ) : (filtered.length === 0 && (tab !== 'local' || installedOnDisk.length === 0)) ? (
                  <div className="px-4 py-10 text-xs text-text-faint text-center space-y-2">
                    {tab === 'local' ? (
                      <>
                        <Download size={20} className="mx-auto text-text-faint/40" />
                        <div>No plugins or skills installed yet.</div>
                        <div className="text-[10px]">Browse the Skills tab or Marketplace to get started.</div>
                      </>
                    ) : (
                      <>
                        <Globe size={20} className="mx-auto text-text-faint/40" />
                        <div>No plugins found.</div>
                        <div className="text-[10px]">
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
                          <div className="px-4 py-1.5 text-[10px] text-text-faint font-mono uppercase tracking-wide border-t border-border-primary mt-1">
                            Skills on disk
                          </div>
                        )}
                        {installedOnDisk
                          .filter((s) => !query || s.name.toLowerCase().includes(query.toLowerCase()))
                          .map((skill) => (
                          <div key={skill.slug} className="group p-3 border-b border-border-secondary hover:bg-bg-hover/50 transition-colors">
                            <div className="flex items-start gap-2">
                              <Zap size={13} className="text-amber-400 mt-0.5 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="text-xs text-text-primary font-mono font-medium">{skill.name}</span>
                                  {skill.installed_for?.map((c) => (
                                    <span key={c} className={`text-[10px] font-medium uppercase px-1 py-0.5 rounded ${
                                      c === 'claude' ? 'text-indigo-400 bg-indigo-500/10' : 'text-blue-400 bg-blue-500/10'
                                    }`}>{c}</span>
                                  ))}
                                  {skill.has_scripts && (
                                    <span className="text-[10px] text-amber-400/80 px-1 py-0.5 bg-amber-500/10 rounded">scripts</span>
                                  )}
                                </div>
                                {skill.description && (
                                  <p className="text-[11px] text-text-muted font-mono mt-0.5 line-clamp-2">{skill.description}</p>
                                )}
                              </div>
                              <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                {skill.installed_for?.length === 1 && (
                                  <button
                                    onClick={() => handleSyncSkill(skill, skill.installed_for[0], skill.installed_for[0] === 'claude' ? 'gemini' : 'claude')}
                                    disabled={busy}
                                    className="px-1.5 py-0.5 text-[10px] text-text-faint hover:text-text-secondary border border-border-primary rounded transition-colors disabled:opacity-30"
                                  >
                                    sync→{skill.installed_for[0] === 'claude' ? 'gemini' : 'claude'}
                                  </button>
                                )}
                                <button
                                  onClick={() => handleUninstallSkill(skill)}
                                  disabled={busy}
                                  className="p-1 text-text-faint hover:text-red-400 transition-colors disabled:opacity-30"
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
