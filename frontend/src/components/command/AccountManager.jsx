import ProviderLogo from '../ui/ProviderLogo'
import { useState, useEffect, useRef } from 'react'
import { Trash2, Plus, Eye, EyeOff, CheckCircle, AlertCircle, Zap, RefreshCw, Globe, SkipForward, Timer, Theater, KeyRound, ChevronRight, ChevronDown } from 'lucide-react'
import { api } from '../../lib/api'
import { resolveExtensionPanel } from '../../lib/extensionRegistry'
import useStore from '../../state/store'
import usePanelCreate from '../../hooks/usePanelCreate'
import useListKeyboardNav from '../../hooks/useListKeyboardNav'
import { Button, EmptyState } from '../ui'

const AccountLoginActions = resolveExtensionPanel('anyuse', 'AccountSetupAction')
const AccountReauthActions = resolveExtensionPanel('anyuse', 'AccountReauthActions')

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

const API_KEY_PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', hint: 'Claude sessions' },
  {
    id: 'z_ai',
    label: 'Z.AI',
    hint: 'Claude Code via default GLM mapping',
    defaultBaseUrl: 'https://api.z.ai/api/anthropic',
    defaultModels: 'haiku, sonnet, opus',
  },
  {
    id: 'z_ai_glm51',
    label: 'Z.AI GLM-5.1',
    hint: 'Claude Code via premium GLM mapping',
    defaultBaseUrl: 'https://api.z.ai/api/anthropic',
    defaultModels: 'haiku, sonnet, opus',
  },
  { id: 'anthropic_gateway', label: 'Custom Claude Gateway', hint: 'Anthropic-compatible Claude endpoint' },
  { id: 'google', label: 'Gemini / Google', hint: 'agy + Gemini features' },
  { id: 'openai', label: 'OpenAI', hint: 'Codex sessions' },
]

const OAUTH_CLI_TARGETS = [
  { id: 'claude', label: 'Claude', authDir: '.claude/', setupLabel: 'log in Claude' },
  { id: 'codex', label: 'Codex', authDir: '.codex/', setupLabel: 'log in Codex' },
  { id: 'antigravity', label: 'agy', authDir: '.gemini/', setupLabel: 'log in agy' },
]

function providerLabel(provider) {
  return API_KEY_PROVIDERS.find((p) => p.id === provider)?.label || 'Anthropic'
}

function providerSpec(provider) {
  return API_KEY_PROVIDERS.find((p) => p.id === provider)
}

function isGatewayProvider(provider) {
  return provider === 'z_ai' || provider === 'z_ai_glm51' || provider === 'anthropic_gateway'
}

function oauthTarget(cliType) {
  return OAUTH_CLI_TARGETS.find((t) => t.id === cliType) || {
    id: cliType || '',
    label: cliType || 'unbound CLI',
    authDir: '',
    setupLabel: 'log in account',
  }
}

export default function AccountManager({ initialCli, initialAccountId, initialCreate = false } = {}) {
  const cliProfiles = useStore((state) => state.cliProfiles)
  const [accounts, setAccounts] = useState([])
  const [selected, setSelected] = useState(null)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [showKey, setShowKey] = useState(false)
  const [mode, setMode] = useState(initialCreate ? 'create' : 'list') // list | create
  const [newName, setNewName] = useState('')
  const [newKey, setNewKey] = useState('')
  const [newAccountKind, setNewAccountKind] = useState(`oauth:${initialCli || 'claude'}`)
  const [newApiKeyProvider, setNewApiKeyProvider] = useState('z_ai')
  const [newBaseUrl, setNewBaseUrl] = useState('')
  const [newModelAliases, setNewModelAliases] = useState('')
  const [newOAuthCliType, setNewOAuthCliType] = useState(initialCli || 'claude')
  const [newDefault, setNewDefault] = useState(false)
  const [newBrowser, setNewBrowser] = useState('')
  const [testing, setTesting] = useState(false)
  const [editBrowser, setEditBrowser] = useState('')
  const [editingBrowser, setEditingBrowser] = useState(false)
  const [editBaseUrl, setEditBaseUrl] = useState('')
  const [editModelAliases, setEditModelAliases] = useState('')
  const [editApiKeyProvider, setEditApiKeyProvider] = useState('anthropic')
  const [editingGateway, setEditingGateway] = useState(false)
  const [tick, setTick] = useState(0) // drives countdown re-renders
  const [pwBusy, setPwBusy] = useState(null) // account id with in-flight Playwright op
  const [authStatuses, setAuthStatuses] = useState({}) // id → evidence-backed account auth status
  const [loginState, setLoginState] = useState(null)
  const [detected, setDetected] = useState({
    browsers: [],
  })
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [creatingPhase, setCreatingPhase] = useState(null) // null | 'creating'
  const listRef = useRef(null)
  const panelRef = useRef(null)

  const isolationLabel = (cliType) => {
    const profile = cliProfiles?.[cliType]
    if (!profile) return 'isolation metadata unavailable'
    if (profile.config_dir_env && profile.config_dir_subpath) {
      return `${profile.config_dir_env} → account HOME/${profile.config_dir_subpath}`
    }
    return 'account HOME only (weaker)'
  }

  // Pull focus into the panel so arrow keys aren't swallowed by the terminal
  useEffect(() => { panelRef.current?.focus() }, [])

  useEffect(() => {
    api.getAccounts().then(rows => {
      setAccounts(rows)
      const index = rows.findIndex(account => account.id === initialAccountId)
      if (index >= 0) setSelectedIdx(index + 1)
    })
    api.detectBrowsers().then(setDetected).catch(() => {})
  }, [])

  useEffect(() => {
    const spec = providerSpec(newApiKeyProvider)
    if (isGatewayProvider(newApiKeyProvider)) {
      if (!newBaseUrl && spec?.defaultBaseUrl) setNewBaseUrl(spec.defaultBaseUrl)
      if (!newModelAliases && spec?.defaultModels) setNewModelAliases(spec.defaultModels)
    } else if (!isGatewayProvider(newApiKeyProvider)) {
      setNewBaseUrl('')
      setNewModelAliases('')
    }
  }, [newApiKeyProvider])

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

  // Fetch Playwright auth status for all accounts
  useEffect(() => {
    for (const acc of accounts) {
      if (acc.id === '__system') continue
      if (acc.type === 'api_key') continue
      api.getAuthStatus(acc.id).then((s) => {
        setAuthStatuses((prev) => ({ ...prev, [acc.id]: s }))
      }).catch(() => {})
    }
  }, [accounts.length])

  useEffect(() => {
    if (!['awaiting_manual', 'verifying'].includes(loginState?.phase)) return undefined
    let stopped = false
    const check = async () => {
      try {
        const status = await api.getAuthStatus(loginState.accountId, loginState.cliType)
        if (stopped) return
        setAuthStatuses((prev) => ({ ...prev, [loginState.accountId]: status }))
        if (status.credentials_verified) {
          setLoginState((prev) => ({ ...prev, phase: 'verified', status }))
          const updated = await api.getAccounts()
          if (stopped) return
          setAccounts(updated)
          setSelected(updated.find((a) => a.id === loginState.accountId) || null)
        } else if (['auth_failed', 'duplicate_identity'].includes(status.account_status)) {
          setLoginState((prev) => ({
            ...prev,
            phase: 'failed',
            status,
            message: status.account_status === 'duplicate_identity'
              ? `These credentials match another ${loginState.cliType} account.`
              : `No ${loginState.cliType} credential evidence appeared in this account sandbox. The account remains not logged in.`,
          }))
        }
      } catch {}
    }
    check()
    const timer = setInterval(check, 2000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [loginState?.phase, loginState?.accountId, loginState?.cliType])

  const handleSetupBrowser = async (acc, cliType, driver = 'ive') => {
    const target = oauthTarget(cliType)
    setPwBusy(acc.id)
    setLoginState({
      accountId: acc.id,
      cliType,
      phase: 'starting',
      message: cliType === 'claude'
        ? 'Starting Claude login in this account sandbox. On macOS, click “Don\'t Allow” when the Keychain dialog appears.'
        : `Starting ${target.label} login in this account sandbox.`,
    })
    try {
      const result = await api.setupBrowser(acc.id, cliType, { driver })
      setLoginState({
        accountId: acc.id,
        cliType,
        phase: result.status === 'action_required'
          ? 'awaiting_manual'
          : result.status === 'verification_pending'
            ? 'verifying'
            : result.ok ? 'verified' : 'failed',
        message: result.message || result.error || 'Login failed',
        result,
      })
      const s = await api.getAuthStatus(acc.id, cliType).catch(() => null)
      if (s) {
        setAuthStatuses((prev) => ({ ...prev, [acc.id]: s }))
      }
      const updated = await api.getAccounts()
      setAccounts(updated)
      setSelected(updated.find((a) => a.id === acc.id) || acc)
    } catch (e) {
      setLoginState({ accountId: acc.id, cliType, phase: 'failed', message: e.message })
    }
    setPwBusy(null)
  }

  const handleCreate = async (e) => {
    e?.preventDefault?.()
    if (!newName.trim() || creatingPhase) return
    const hasKey = newKey.trim()
    const isApiKeyAccount = newAccountKind.startsWith('api:')
    const selectedApiProvider = isApiKeyAccount ? newAccountKind.slice(4) : newApiKeyProvider
    const selectedOAuthCliType = newAccountKind.startsWith('oauth:') ? newAccountKind.slice(6) : newOAuthCliType

    if (isApiKeyAccount && !hasKey) {
      alert('Paste an API key above, or choose a subscription/OAuth account type.')
      return
    }

    setCreatingPhase('creating')
    let acc
    try {
      acc = await api.createAccount({
        name: newName.trim(),
        type: isApiKeyAccount ? 'api_key' : 'oauth',
        cli_type: isApiKeyAccount ? undefined : selectedOAuthCliType,
        api_key: isApiKeyAccount ? newKey.trim() : undefined,
        api_key_provider: isApiKeyAccount ? selectedApiProvider : undefined,
        base_url: isApiKeyAccount && isGatewayProvider(selectedApiProvider) ? newBaseUrl.trim() || undefined : undefined,
        model_aliases: isApiKeyAccount && isGatewayProvider(selectedApiProvider) ? newModelAliases.trim() || undefined : undefined,
        is_default: newDefault,
        browser_path: newBrowser.trim() || undefined,
      })
    } catch (err) {
      setCreatingPhase(null)
      alert('Create failed: ' + err.message)
      return
    }

    // The row exists before setup is allowed to create its account HOME.
    const updated = await api.getAccounts()
    setAccounts(updated)
    const fresh = updated.find((a) => a.id === acc.id) || acc
    const newIdx = 1 + updated.findIndex((a) => a.id === acc.id) // +1 for systemItem
    setSelected(fresh)
    setSelectedIdx(newIdx >= 1 ? newIdx : -1)

    setMode('list')
    setNewName('')
    setNewKey('')
    setNewAccountKind('api:z_ai')
    setNewApiKeyProvider('z_ai')
    setNewBaseUrl('')
    setNewModelAliases('')
    setNewOAuthCliType('claude')
    setNewBrowser('')
    setShowAdvanced(false)
    setCreatingPhase(null)
    if (!isApiKeyAccount) {
      await handleSetupBrowser(fresh, selectedOAuthCliType, 'ive')
    }
  }

  // ⌘= opens the add-account form; ⌘↵ saves it.
  usePanelCreate({
    onAdd: () => setMode('create'),
    onSubmit: () => { if (mode === 'create') handleCreate() },
  })

  // Combined item list: system auth + user accounts, used for keyboard nav.
  const systemItem = { id: '__system', name: 'Local login', type: 'oauth', status: 'active', api_key_masked: 'keychain' }
  const allItems = [systemItem, ...accounts]

  // Sync selectedIdx → selected and keep highlighted row visible.
  useEffect(() => {
    if (selectedIdx < 0 || selectedIdx >= allItems.length) return
    const item = allItems[selectedIdx]
    if (item && selected?.id !== item.id) {
      setSelected(item)
      setEditBrowser(item.browser_path || '')
      setEditBaseUrl(item.base_url || '')
      setEditModelAliases(item.model_aliases || '')
      setEditApiKeyProvider(item.api_key_provider || 'anthropic')
      setEditingBrowser(false)
      setEditingGateway(false)
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
    if (item.status === 'quota_exceeded' && msUntil(item.quota_reset_at) > 0) return 'bg-x-accent-ink animate-pulse'
    if (item.status === 'active') return 'bg-x-accent'
    if (item.status === 'quota_exceeded') return 'bg-x-accent-ink'
    return 'bg-x-faint/40'
  }

  const inputClass = 'w-full h-8 px-2.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus'
  const inputClassMono = `${inputClass} font-mono`
  const newAccountIsApiKey = newAccountKind.startsWith('api:')
  const selectedIsApiKey = selected?.id !== '__system' && selected?.type === 'api_key'
  const selectedIsOAuthAccount = selected?.id !== '__system' && selected?.type !== 'api_key'

  // Summary counts for header
  const cooldownCount = accounts.filter((a) => a.status === 'quota_exceeded' && msUntil(a.quota_reset_at) > 0).length
  const activeCount = accounts.filter((a) => a.status === 'active').length

  return (
      <div
        ref={panelRef}
        tabIndex={-1}
        className="flex h-full min-h-0 flex-col overflow-hidden outline-none"
      >
        <div className="flex items-center gap-1.5 px-4 py-2 border-b border-x-line">
          <span className="text-[11px] text-x-faint">{activeCount} active</span>
          {cooldownCount > 0 && (
            <span className="flex items-center gap-0.5 text-[11px] text-x-accent-ink">
              <Timer size={9} /> {cooldownCount} cooling
            </span>
          )}
          <div className="flex-1" />
          <Button type="button"
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
            size="sm"
            title="Open the next available non-API account in its configured browser"
          >
            <SkipForward size={10} /> Open next
          </Button>
          <Button type="button"
            onClick={() => setMode(mode === 'create' ? 'list' : 'create')}
            className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-medium text-x-muted hover:text-x-ink-secondary hover:bg-x-hover transition-colors duration-[80ms]"
          >
            <Plus size={10} /> Add account
          </Button>
        </div>

        {mode === 'create' && (
          <form onSubmit={handleCreate} className="p-4 border-b border-x-line space-y-2">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Account name (e.g. Personal Max, Work Max)" className={inputClass} autoFocus />
            {newAccountIsApiKey && <input
              value={newKey}
              onChange={(e) => {
                const next = e.target.value
                setNewKey(next)
                if (next.trim() && newAccountKind.startsWith('oauth:')) {
                  setNewAccountKind(`api:${newApiKeyProvider}`)
                }
              }}
              placeholder="API key (required for API key / gateway accounts)"
              type="password"
              className={inputClassMono}
            />}
            <select
              value={newAccountKind}
              onChange={(e) => {
                const next = e.target.value
                setNewAccountKind(next)
                if (next.startsWith('api:')) {
                  const provider = next.slice(4)
                  setNewApiKeyProvider(provider)
                  const spec = providerSpec(provider)
                  if (isGatewayProvider(provider)) {
                    setNewBaseUrl(spec?.defaultBaseUrl || '')
                    setNewModelAliases(spec?.defaultModels || '')
                  }
                } else if (next.startsWith('oauth:')) {
                  setNewOAuthCliType(next.slice(6))
                }
              }}
              className={inputClass}
            >
              <optgroup label="API key / gateway">
                {API_KEY_PROVIDERS.map((p) => (
                  <option key={p.id} value={`api:${p.id}`}>{p.label} — {p.hint}</option>
                ))}
              </optgroup>
              <optgroup label="Subscription / OAuth">
                {OAUTH_CLI_TARGETS.map((target) => (
                  <option key={target.id} value={`oauth:${target.id}`}>
                    {target.label} subscription/OAuth — {target.authDir}
                  </option>
                ))}
              </optgroup>
            </select>
            {newAccountIsApiKey && isGatewayProvider(newApiKeyProvider) && (
              <div className="border border-x-line rounded-md p-2 space-y-1.5">
                <input
                  value={newBaseUrl}
                  onChange={(e) => setNewBaseUrl(e.target.value)}
                  placeholder="Anthropic-compatible base URL"
                  className={inputClassMono}
                />
                <input
                  value={newModelAliases}
                  onChange={(e) => setNewModelAliases(e.target.value)}
                  placeholder="Models, comma-separated (e.g. haiku, sonnet, opus)"
                  className={inputClassMono}
                />
                <p className="text-[11px] text-x-faint leading-relaxed">
                  Claude sessions will export <code className="text-x-accent">ANTHROPIC_BASE_URL</code> and <code className="text-x-accent">ANTHROPIC_AUTH_TOKEN</code> only for sessions using this account.
                </p>
              </div>
            )}
            <p className="text-[11px] text-x-faint leading-relaxed">
              {newAccountIsApiKey ? (
                <>
                  <strong className="text-x-ink-secondary">API key:</strong> choose Anthropic, Z.AI, Z.AI GLM-5.1, Gemini/Google, or OpenAI here, then paste the matching key above.
                </>
              ) : (
                <>
                  <strong className="text-x-ink-secondary">OAuth/subscription:</strong> after the row is created,
                  the CLI opens its own login URL in a fresh per-account browser profile and credentials are
                  verified inside the account sandbox. {isolationLabel(newOAuthCliType)}.
                </>
              )}
            </p>
            <label className="flex items-center gap-1.5 text-[11px] text-x-ink-secondary cursor-pointer">
              <input type="checkbox" checked={newDefault} onChange={(e) => setNewDefault(e.target.checked)} />
              Set as default for new sessions
            </label>

            {!newAccountIsApiKey && (
              <>
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-1 text-[11px] text-x-muted hover:text-x-ink-secondary transition-colors duration-[80ms]"
                >
                  {showAdvanced ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  Advanced browser preference
                </button>
                {showAdvanced && (
                  <div className="border border-x-line rounded-md p-2 space-y-1.5">
                    {detected.browsers.length > 0 ? (
                      <select
                        value={newBrowser}
                        onChange={(e) => setNewBrowser(e.target.value)}
                        className={inputClass}
                      >
                        <option value="">— auto-detect isolated browser —</option>
                        {detected.browsers.map((b) => (
                          <option key={b.path} value={b.path}>{b.name} — {b.path}</option>
                        ))}
                      </select>
                    ) : (
                      <input value={newBrowser} onChange={(e) => setNewBrowser(e.target.value)} placeholder="Browser path (e.g. /Applications/Google Chrome.app)" className={inputClassMono} />
                    )}
                    <p className="text-[11px] text-x-faint leading-relaxed">
                      IVE always passes its own account-home browser directory. Existing Chrome profiles are never reused.
                    </p>
                  </div>
                )}
              </>
            )}

            <div className="flex items-center gap-1.5">
              <Button
                type="submit"
                disabled={!!creatingPhase}
                className="px-2.5 py-1.5 text-[13px] font-medium bg-x-accent hover:bg-x-accent-ink disabled:opacity-40 disabled:cursor-not-allowed text-x-on-accent transition-colors duration-[80ms] active:scale-[.98] flex items-center gap-1"
              >
                {creatingPhase === 'creating' && (
                  <><RefreshCw size={10} className="animate-spin" /> creating…</>
                )}
                {!creatingPhase && 'Add account'}
              </Button>
              <Button type="button" disabled={!!creatingPhase} onClick={() => setMode('list')} className="px-2.5 py-1.5 text-[13px] font-medium text-x-ink-secondary hover:text-x-ink hover:bg-x-hover border border-x-line hover:border-x-line-strong transition-colors duration-[80ms]">Cancel</Button>
            </div>
          </form>
        )}

        <div className="flex flex-1 min-h-0">
          {/* List */}
          <div ref={listRef} className="w-[200px] border-r border-x-line overflow-y-auto">
            {allItems.map((item, idx) => {
              const cd = item.status === 'quota_exceeded' ? fmtCooldown(msUntil(item.quota_reset_at)) : null
              return (
                <button
                  key={item.id}
                  data-idx={idx}
                  onClick={() => setSelectedIdx(idx)}
                  className={`w-full text-left px-2.5 py-1.5 border-b border-x-line/50 transition-colors duration-[80ms] ${
                    selectedIdx === idx
                      ? 'bg-x-tint text-x-ink ring-1 ring-inset ring-x-accent/45'
                      : selected?.id === item.id ? 'bg-x-tint text-x-ink' : 'text-x-muted hover:bg-x-hover'
                  }`}
                >
                  <div className="flex items-center gap-1">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${item.id === '__system' ? 'bg-x-accent' : statusDot(item)}`} />
                    {(item.cli_type || item.api_key_provider) && <ProviderLogo provider={item.api_key_provider || item.cli_type} className="w-3.5 h-3.5 shrink-0" />}
                    <span className="text-[12px] font-medium truncate">{item.name}</span>
                    {item.is_default ? <span className="text-[11px] text-x-accent font-medium shrink-0">DEFAULT</span> : null}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] text-x-faint truncate">
                      {item.id === '__system'
                        ? 'system CLI auth'
                        : (item.api_key_masked
                          ? `${providerLabel(item.api_key_provider)} key`
                          : `${item.cli_type || 'unbound'} OAuth${item.verified_subject ? ` · ${item.verified_subject}` : ''}`)}
                    </span>
                    {cd && (
                      <span className="flex items-center gap-0.5 text-[11px] text-x-accent-ink shrink-0 ml-auto">
                        <Timer size={8} /> {cd}
                      </span>
                    )}
                  </div>
                </button>
              )
            })}

            {accounts.length === 0 && (
              <div className="m-2 rounded-lg border border-dashed border-x-line p-3 text-left">
                <div className="text-[11px] font-medium text-x-ink-secondary">No saved accounts</div>
                <p className="mt-1 text-[11px] leading-relaxed text-x-muted">
                  System CLI authentication remains available.
                </p>
                <Button icon={Plus} size="sm" onClick={() => setMode('create')} className="mt-2 w-full">
                  Add account
                </Button>
              </div>
            )}
          </div>

          {/* Detail */}
          <div className="flex-1 overflow-y-auto p-4">
            {selected ? (
              <div className="space-y-3 text-[11px]">
                <div className="flex items-center justify-between">
                  <span className="text-x-ink text-[11px] font-medium">{selected.name}</span>
                  <div className="flex items-center gap-1">
                    {(() => {
                      const cd = selected.status === 'quota_exceeded' ? fmtCooldown(msUntil(selected.quota_reset_at)) : null
                      if (cd) {
                        return (
                          <span className="flex items-center gap-1 text-[11px] text-x-accent-ink">
                            <Timer size={10} className="animate-pulse" />
                            cooldown
                          </span>
                        )
                      }
                      return (
                        <span className={`flex items-center gap-1 text-[11px] ${
                          selected.status === 'active' ? 'text-x-accent' :
                          selected.status === 'quota_exceeded' ? 'text-x-accent-ink' : 'text-x-muted'
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
                    <div className="bg-x-surface-2 border border-x-line rounded-md p-2 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1 text-x-accent-ink">
                          <Timer size={11} className="animate-pulse" />
                          Usage depleted — cooling down
                        </span>
                        <span className="text-x-accent-ink font-medium">{cd}</span>
                      </div>
                      <div className="w-full h-1 bg-x-surface-2 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-x-accent-ink rounded-full transition-all duration-1000"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-x-accent-ink/80">
                        <span>resets {selected.quota_reset_at}</span>
                        <button
                          onClick={() => handleClearCooldown(selected)}
                          className="text-x-accent-ink hover:text-x-accent-ink underline"
                        >clear cooldown</button>
                      </div>
                    </div>
                  )
                })()}

                {/* Evidence-backed login CTA for this account's bound CLI. */}
                {selected.id !== '__system'
                  && selected.type !== 'api_key'
                  && authStatuses[selected.id]
                  && !authStatuses[selected.id].credentials_verified && (
                  <div className="bg-x-surface-2 border border-x-line rounded-md p-2 space-y-1.5">
                    <div className="flex items-start gap-1.5">
                      <Theater size={11} className="text-x-accent shrink-0 mt-0.5" />
                      <div className="flex-1 space-y-1">
                        <p className="text-x-accent text-[11px]">Log in this {oauthTarget(selected.cli_type).label} account</p>
                        <p className="text-x-ink-secondary text-[11px] leading-relaxed">
                          The CLI runs with this account HOME from the start. Its OAuth URL opens only in a dedicated browser profile, then IVE verifies that credentials appeared in the sandbox.
                        </p>
                        {selected.cli_type === 'claude' && (
                          <p className="text-x-accent-ink text-[11px] leading-relaxed">
                            <strong>macOS:</strong> when Claude asks for Keychain access, click <strong>"Don't Allow"</strong>. IVE verifies the file fallback afterwards.
                          </p>
                        )}
                        <div className="flex gap-1 pt-0.5 flex-wrap">
                          <Button type="submit"
                            onClick={() => handleSetupBrowser(selected, selected.cli_type)}
                            disabled={pwBusy === selected.id || !selected.cli_type}
                            className="flex items-center gap-1 px-1.5 py-1 text-[11px] bg-x-accent hover:bg-x-accent-ink text-x-on-accent transition-colors duration-[80ms] disabled:opacity-40"
                          >
                            <Theater size={10} />
                            {pwBusy === selected.id ? 'waiting for login…' : oauthTarget(selected.cli_type).setupLabel}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {loginState?.accountId === selected.id && (
                  <div className={`rounded-md border p-2 space-y-1.5 ${loginState.phase === 'verified' ? 'border-x-good/30 bg-x-good/10' : loginState.phase === 'failed' ? 'border-x-accent-ink/30 bg-x-accent-ink/10' : 'border-x-accent/30 bg-x-tint'}`}>
                    <p className="text-[11px] font-medium text-x-ink-secondary">
                      {loginState.phase === 'starting' && 'Capturing the CLI OAuth URL…'}
                      {loginState.phase === 'awaiting_manual' && 'Private-window action required'}
                      {loginState.phase === 'verifying' && 'Isolated browser opened · waiting to verify'}
                      {loginState.phase === 'verified' && 'Login verified'}
                      {loginState.phase === 'failed' && 'Login not verified'}
                    </p>
                    <p className="text-[11px] text-x-muted leading-relaxed">{loginState.message}</p>
                    {loginState.result?.browser && (
                      <p className="text-[11px] text-x-faint font-mono break-all">
                        browser: {loginState.result.browser.status} · {loginState.result.browser.profile_dir}
                      </p>
                    )}
                    {loginState.result?.auth_url && (
                      <div className="space-y-1">
                        <p className="text-[11px] text-x-accent-ink leading-relaxed">
                          Sensitive URL: copy it into a brand-new private/incognito window. Do not open it in your normal profile.
                        </p>
                        <textarea readOnly value={loginState.result.auth_url} className={`${inputClassMono} min-h-16 resize-y`} />
                        <Button type="button"
                          onClick={() => navigator.clipboard?.writeText(loginState.result.auth_url)}
                          className="px-1.5 py-1 text-[11px] border border-x-line hover:bg-x-hover text-x-ink-secondary"
                        >copy sensitive URL</Button>
                      </div>
                    )}
                    {loginState.result?.verification && (
                      <p className="text-[11px] text-x-faint">
                        evidence: {loginState.result.verification.evidence_files?.join(', ') || 'none'} · {loginState.result.verification.strong_isolation ? 'profile config redirect' : 'HOME-only (weaker)'}
                      </p>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-1">
                  <div>
                    <label className="text-[11px] text-x-faint">Type</label>
                    <p className="text-x-ink-secondary">
                      {selected.type}
                      {selected.api_key_masked ? <span className="text-x-muted"> · {providerLabel(selected.api_key_provider)}</span> : null}
                    </p>
                  </div>
                  <div>
                    <label className="text-[11px] text-x-faint">API Key</label>
                    <p className="text-x-ink-secondary font-mono flex items-center gap-1">
                      {showKey ? (selected.api_key || selected.api_key_masked) : (selected.api_key_masked || '***')}
                      <button onClick={() => setShowKey(!showKey)} className="text-x-muted hover:text-x-ink-secondary">
                        {showKey ? <EyeOff size={10} /> : <Eye size={10} />}
                      </button>
                    </p>
                  </div>
                  {selectedIsOAuthAccount && authStatuses[selected.id] && (
                    <div className="col-span-2">
                      <label className="text-[11px] text-x-faint">Account login evidence</label>
                      <p className="text-x-muted flex items-center gap-2 flex-wrap">
                        <span className={authStatuses[selected.id].has_browser_context ? 'text-x-accent' : 'text-x-faint'}>
                          {authStatuses[selected.id].has_browser_context ? 'isolated browser ready' : 'browser profile empty'}
                        </span>
                        <span className="text-x-faint">|</span>
                        <span
                          className={authStatuses[selected.id].credentials_verified ? 'text-x-good' : 'text-x-accent-ink'}
                        >
                          {authStatuses[selected.id].credentials_verified ? 'credentials verified' : 'not logged in'}
                        </span>
                        <span className="text-x-faint">|</span>
                        <span className={authStatuses[selected.id].strong_isolation ? 'text-x-good' : 'text-x-accent-ink'}>
                          {authStatuses[selected.id].strong_isolation ? 'config-dir isolated' : 'HOME-only isolation ⚠'}
                        </span>
                      </p>
                      <p className="text-[11px] text-x-faint truncate">
                        identity: {authStatuses[selected.id].verified_subject || 'not exposed by this CLI'}
                      </p>
                    </div>
                  )}
                  {selected.id !== '__system' && selected.base_url && (
                    <div className="col-span-2">
                      <label className="text-[11px] text-x-faint">Gateway</label>
                      <p className="text-x-muted font-mono truncate">{selected.base_url}</p>
                      {selected.model_aliases && (
                        <p className="text-x-faint font-mono truncate">models: {selected.model_aliases}</p>
                      )}
                    </div>
                  )}

                  {selected.id !== '__system'
                    && selected.type !== 'api_key'
                    && authStatuses[selected.id]
                    && selected.cli_type === 'claude'
                    && !authStatuses[selected.id].credentials_verified
                    && authStatuses[selected.id].account_status === 'auth_failed' && (
                    <div className="bg-x-accent-ink/10 border border-x-accent-ink/30 rounded-md p-2 col-span-2">
                      <p className="text-x-accent-ink text-[11px] leading-relaxed">
                        <strong>Claude credentials were not verified in this account.</strong> On macOS, retry and click
                        <strong> "Don't Allow"</strong> on the Keychain dialog so Claude writes the per-account file fallback.
                      </p>
                    </div>
                  )}
                </div>

                {/* API provider / gateway settings */}
                {selected.id !== '__system' && selected.api_key_masked && (
                  <div className="border border-x-line rounded-md p-2 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-x-ink-secondary">API Provider / Gateway</p>
                      {!editingGateway ? (
                        <button
                          onClick={() => {
                            setEditApiKeyProvider(selected.api_key_provider || 'anthropic')
                            setEditBaseUrl(selected.base_url || '')
                            setEditModelAliases(selected.model_aliases || '')
                            setEditingGateway(true)
                          }}
                          className="text-[11px] text-x-faint hover:text-x-ink-secondary transition-colors duration-[80ms]"
                        >edit</button>
                      ) : (
                        <button
                          onClick={async () => {
                            await api.updateAccount(selected.id, {
                              api_key_provider: editApiKeyProvider,
                              base_url: isGatewayProvider(editApiKeyProvider) ? editBaseUrl || null : null,
                              model_aliases: isGatewayProvider(editApiKeyProvider) ? editModelAliases || null : null,
                            })
                            const updated = await api.getAccounts()
                            setAccounts(updated)
                            setSelected(updated.find((a) => a.id === selected.id))
                            setEditingGateway(false)
                          }}
                          className="text-[11px] text-x-accent hover:text-x-accent-ink transition-colors duration-[80ms]"
                        >save</button>
                      )}
                    </div>
                    {editingGateway ? (
                      <>
                        <select
                          value={editApiKeyProvider}
                          onChange={(e) => {
                            const next = e.target.value
                            setEditApiKeyProvider(next)
                            const spec = providerSpec(next)
                            if (isGatewayProvider(next)) {
                              if (!editBaseUrl && spec?.defaultBaseUrl) setEditBaseUrl(spec.defaultBaseUrl)
                              if (!editModelAliases && spec?.defaultModels) setEditModelAliases(spec.defaultModels)
                            }
                          }}
                          className={inputClass}
                        >
                          {API_KEY_PROVIDERS.map((p) => (
                            <option key={p.id} value={p.id}>{p.label} — {p.hint}</option>
                          ))}
                        </select>
                        {isGatewayProvider(editApiKeyProvider) && (
                          <>
                            <input
                              value={editBaseUrl}
                              onChange={(e) => setEditBaseUrl(e.target.value)}
                              placeholder="Anthropic-compatible base URL"
                              className={inputClassMono}
                            />
                            <input
                              value={editModelAliases}
                              onChange={(e) => setEditModelAliases(e.target.value)}
                              placeholder="Models, comma-separated (e.g. haiku, sonnet, opus)"
                              className={inputClassMono}
                            />
                          </>
                        )}
                      </>
                    ) : (
                      <div className="space-y-1">
                        <p className="text-x-muted text-[11px] truncate">{providerLabel(selected.api_key_provider)}</p>
                        {isGatewayProvider(selected.api_key_provider) ? (
                          <>
                            <p className="text-x-muted font-mono text-[11px] truncate">{selected.base_url || 'no base URL'}</p>
                            <p className="text-x-faint font-mono text-[11px] truncate">{selected.model_aliases || 'no custom model list'}</p>
                          </>
                        ) : (
                          <p className="text-x-faint text-[11px]">direct provider API key</p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Browser executable preference; profile is always account-owned. */}
                {selectedIsOAuthAccount && (
                  <div className="border border-x-line rounded-md p-2 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-x-ink-secondary">Isolated browser</p>
                      {!editingBrowser ? (
                        <button
                          onClick={() => setEditingBrowser(true)}
                          className="text-[11px] text-x-faint hover:text-x-ink-secondary transition-colors duration-[80ms]"
                        >edit</button>
                      ) : (
                        <button
                          onClick={async () => {
                            await api.updateAccount(selected.id, {
                              browser_path: editBrowser || null,
                            })
                            const updated = await api.getAccounts()
                            setAccounts(updated)
                            setSelected(updated.find((a) => a.id === selected.id))
                            setEditingBrowser(false)
                          }}
                          className="text-[11px] text-x-accent hover:text-x-accent-ink transition-colors duration-[80ms]"
                        >save</button>
                      )}
                    </div>
                    {editingBrowser ? (
                      <>
                        <input
                          value={editBrowser}
                          onChange={(e) => setEditBrowser(e.target.value)}
                          placeholder="Browser (e.g. Google Chrome, /Applications/Brave Browser.app)"
                          className={inputClassMono}
                        />
                        <p className="text-[11px] text-x-faint">IVE passes &lt;account_home&gt;/browser; an existing browser profile cannot be selected.</p>
                      </>
                    ) : (
                      <div className="space-y-1">
                        <div>
                          <label className="text-[11px] text-x-faint">Browser</label>
                          <p className="text-x-muted font-mono text-[11px] truncate">{selected.browser_path || 'auto-detect'}</p>
                        </div>
                        <p className="text-[11px] text-x-faint">profile: account HOME / browser</p>
                      </div>
                    )}
                  </div>
                )}

                {selectedIsApiKey && (
                  <div className="space-y-2.5 pt-2">
                    <div className="border border-x-good/30 bg-x-good/10 rounded-md p-2 space-y-1.5">
                      <p className="text-xs font-medium text-x-good">API key account</p>
                      <p className="text-[11px] text-x-good/80 leading-relaxed">
                        Pick this account in New Session -&gt; Auth Account. Claude gateway sessions export this account's base URL and token only for that session.
                      </p>
                      {isGatewayProvider(selected.api_key_provider) && (
                        <p className="text-[11px] text-x-good/80 leading-relaxed">
                          Z.AI gateway accounts also attach the Z.AI MCP servers when a Claude session starts.
                        </p>
                      )}
                      {selected.api_key_masked && (
                        <div className="flex flex-wrap gap-1 pt-0.5">
                          <Button type="submit"
                            onClick={() => handleTest(selected)}
                            disabled={testing}
                            className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] bg-x-good/10 hover:bg-x-good/20 text-x-good transition-colors duration-[80ms] disabled:opacity-40"
                            title="Make a tiny API call with this key to verify it works"
                          >
                            <Zap size={10} />
                            {testing ? 'testing...' : 'test key'}
                          </Button>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1 pt-1 border-t border-x-line">
                      {!selected.is_default && (
                        <Button type="submit"
                          onClick={() => handleSetDefault(selected)}
                          className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] bg-x-tint hover:bg-x-accent/20 text-x-accent transition-colors duration-[80ms]"
                          title="Use this account by default for new sessions"
                        >
                          <CheckCircle size={10} />
                          set default
                        </Button>
                      )}
                      <Button type="submit"
                        onClick={() => handleDelete(selected.id)}
                        className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] text-x-accent-ink hover:bg-x-accent-ink/10 transition-colors duration-[80ms] ml-auto"
                        title="Delete this account row"
                      >
                        <Trash2 size={10} />
                        delete
                      </Button>
                    </div>
                  </div>
                )}

                {selectedIsOAuthAccount && (
                  <div className="space-y-2.5 pt-2">
                    {/* ── First-time login ─────────────────────────── */}
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-x-ink-secondary">1. Log in (one-time)</p>
                      <p className="text-[11px] text-x-faint leading-relaxed">
                        This row is bound to <strong className="text-x-accent">{oauthTarget(selected.cli_type).label}</strong>.
                        The CLI writes directly into its account sandbox; host credentials are never copied.
                        Isolation: {isolationLabel(selected.cli_type)}.
                      </p>
                      <div className="flex flex-wrap gap-1">
                        <Button type="submit"
                          onClick={() => handleSetupBrowser(selected, selected.cli_type, 'ive')}
                          disabled={pwBusy === selected.id || !selected.cli_type}
                          className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] bg-x-tint hover:bg-x-accent/20 text-x-accent transition-colors duration-[80ms] disabled:opacity-40"
                          title="Run the CLI login locally and open its OAuth URL in the account browser profile"
                        >
                          <Theater size={10} />
                          {pwBusy === selected.id ? 'waiting for login…' : oauthTarget(selected.cli_type).setupLabel}
                        </Button>
                        <AccountLoginActions
                          accountId={selected.id}
                          cliType={selected.cli_type}
                          busy={pwBusy === selected.id}
                          onSetup={(driver) => handleSetupBrowser(selected, selected.cli_type, driver)}
                        />
                      </div>
                    </div>

                    <AccountReauthActions
                      accountId={selected.id}
                      cliType={selected.cli_type}
                      busy={pwBusy === selected.id}
                      hasBrowserContext={!!authStatuses[selected.id]?.has_browser_context}
                      onBusyChange={(busy) => setPwBusy(busy ? selected.id : null)}
                      onRefreshAccounts={async () => {
                        const updated = await api.getAccounts()
                        setAccounts(updated)
                        setSelected(updated.find((account) => account.id === selected.id))
                      }}
                      onRefreshAuthStatus={async () => {
                        const status = await api.getAuthStatus(selected.id)
                        setAuthStatuses((prev) => ({ ...prev, [selected.id]: status }))
                      }}
                    />

                    {/* ── Dashboard / convenience ──────────────────── */}
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-x-ink-secondary">Open dashboard</p>
                      <p className="text-[11px] text-x-faint leading-relaxed">
                        Opens the provider page in the same account-owned browser profile. It never uses the default profile.
                      </p>
                      <div className="flex flex-wrap gap-1">
                        <Button type="submit"
                          onClick={async () => {
                            try {
                              await api.openAccountBrowser(selected.id, { cli_type: selected.cli_type })
                            } catch (e) {
                              alert('Failed: ' + e.message)
                            }
                          }}
                          className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] border border-x-line hover:border-x-line-strong hover:bg-x-hover text-x-ink-secondary hover:text-x-ink transition-colors duration-[80ms]"
                        >
                          <Globe size={10} />
                          open {oauthTarget(selected.cli_type).label.toLowerCase()}
                        </Button>
                      </div>
                    </div>

                    {/* ── Account meta ─────────────────────────────── */}
                    <div className="flex items-center gap-1 pt-1 border-t border-x-line">
                      {!selected.is_default && (
                        <Button type="submit"
                          onClick={() => handleSetDefault(selected)}
                          className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] bg-x-tint hover:bg-x-accent/20 text-x-accent transition-colors duration-[80ms]"
                          title="Use this account by default for new sessions"
                        >
                          <CheckCircle size={10} />
                          set default
                        </Button>
                      )}
                      <Button type="submit"
                        onClick={() => handleDelete(selected.id)}
                        className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] text-x-accent-ink hover:bg-x-accent-ink/10 transition-colors duration-[80ms] ml-auto"
                        title="Delete this account row + its sandbox HOME dir"
                      >
                        <Trash2 size={10} />
                        delete
                      </Button>
                    </div>
                  </div>
                )}

                {selected.id === '__system' && (
                  <p className="text-[11px] text-x-faint leading-relaxed">
                    Local login uses the selected agent's own sign-in on this computer.
                    Choose Local login in chat or when creating a session to use it. Saved accounts have their own sign-in.
                  </p>
                )}
              </div>
            ) : (
              <EmptyState
                icon={KeyRound}
                title="Choose an account"
                description="Select Local login or a saved account to review its settings."
                className="h-full"
                action={<Button icon={Plus} onClick={() => setMode('create')}>Add account</Button>}
              />
            )}
          </div>
        </div>
    </div>
  )
}
