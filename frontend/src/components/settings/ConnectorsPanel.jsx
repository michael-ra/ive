import HelpDetails from '../ui/HelpDetails'
import ProviderLogo from '../ui/ProviderLogo'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, Check, ChevronRight, Globe, Loader2, Plug, Plus, Search, Settings2 } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import AccountManager from '../command/AccountManager'
import McpPanel from '../mcp/McpPanel'
import ApisIntegrationsPanel from '../integrations/ApisIntegrationsPanel'
import ApiKeysPanel from './ApiKeysPanel'
import ProviderLimits from '../layout/ProviderLimits'
import './connectors.css'

const AGENTS = [
  { id: 'claude', name: 'Claude', description: 'Use your Claude subscription for coding and conversations.', brand: 'claude' },
  { id: 'codex', name: 'Codex', description: 'Connect your OpenAI account to work with Codex.', brand: 'codex' },
  { id: 'antigravity', name: 'Antigravity', description: 'Use your Google account with Antigravity.', brand: 'antigravity' },
]
const APPS = {
  github: ['GitHub', 'Search repositories and discover code.', 'GH'],
  brave: ['Brave Search', 'Search the web for research and current information.', 'B'],
  producthunt: ['Product Hunt', 'Discover products and follow new launches.', 'P'],
  searxng: ['SearXNG', 'Search through your own search service.', 'S'],
  huggingface: ['Hugging Face', 'Access models and repositories with your account.', '🤗'],
  anthropic: ['Anthropic model directory', 'Find available Claude models. Coding sessions use their own account.', 'A'],
  google: ['Google model directory', 'Find available Gemini models.', 'G'],
}
const FILTERS = [['all', 'All'], ['apps', 'Apps'], ['agents', 'AI accounts'], ['builtin', 'Built-in']]

export default function ConnectorsPanel({ initialView = '', onNavigate }) {
  const [data, setData] = useState({ accounts: [], keys: {}, servers: [], clis: {} })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('yours')
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [view, setView] = useState(() => initialView === 'accounts' ? { kind: 'accounts', title: 'AI accounts' }
    : initialView === 'api-keys' ? { kind: 'key', title: 'API keys' }
      : initialView === 'apis-integrations' ? { kind: 'api', title: 'Custom APIs' }
        : initialView === 'mcp-servers' ? { kind: 'mcp', title: 'MCP servers' } : null)
  const search = useRef(null)
  const requestVersion = useRef(0)
  const activeSessionId = useStore(state => state.activeSessionId)

  const load = useCallback(async () => {
    const version = ++requestVersion.current
    setLoading(true)
    setError('')
    // cli-info only tells which agent CLIs are installed (Local login); it never fails the page.
    const [cliInfo, ...results] = await Promise.allSettled([api.getCliInfo(), api.getAccounts(), api.getApiKeys(), api.getMcpServers()])
    if (version !== requestVersion.current) return
    const [accounts, keys, servers] = results
    setData(previous => ({
      accounts: accounts.status === 'fulfilled' && Array.isArray(accounts.value) ? accounts.value : previous.accounts,
      keys: keys.status === 'fulfilled' && keys.value && !Array.isArray(keys.value) ? keys.value : previous.keys,
      servers: servers.status === 'fulfilled' && Array.isArray(servers.value) ? servers.value : previous.servers,
      clis: cliInfo.status === 'fulfilled' && cliInfo.value?.available_clis ? cliInfo.value.available_clis : previous.clis,
    }))
    if (results.some(result => result.status === 'rejected')) setError('Some connections could not be loaded. Try again to refresh their status.')
    setLoading(false)
  }, [])
  useEffect(() => { load(); return () => { requestVersion.current += 1 } }, [load])
  useEffect(() => { if (!view) search.current?.focus() }, [view])

  const rows = [
    ...AGENTS.map(agent => {
      const accounts = data.accounts.filter(account => account.cli_type === agent.id)
      const needsLogin = accounts.filter(account => ['auth_failed', 'duplicate_identity'].includes(account.status)).length
      // An installed CLI runs with this computer's own sign-in (Local login), so it is not
      // "unconnected". Manage opens the account list; a second account stays one click away there.
      const local = !accounts.length && !!data.clis[agent.id]
      return { ...agent, id: `agent:${agent.id}`, category: 'agents', saved: accounts.length > 0 || local, local,
        status: needsLogin ? `${needsLogin} saved account${needsLogin === 1 ? ' needs' : 's need'} sign-in` : accounts.length ? `${accounts.length} account${accounts.length === 1 ? '' : 's'} saved` : local ? 'Local login · this computer' : '',
        warning: needsLogin, action: needsLogin ? 'Reconnect' : accounts.length || local ? 'Manage' : 'Connect',
        view: { kind: 'accounts', title: agent.name, cli: agent.id, create: !accounts.length && !local, accountId: accounts.find(a => a.status === 'auth_failed')?.id || accounts[0]?.id },
      }
    }),
    ...Object.entries(data.keys).map(([id, info]) => {
      const [name, description, mark] = APPS[id] || [info.label || id, info.description, '↗']
      return { id: `key:${id}`, name, description, mark, brand: ['anthropic', 'google', 'openai'].includes(id) ? id : null, category: 'apps', saved: !!info.configured,
        status: info.configured ? 'Key saved' : '', action: info.configured ? 'Manage' : 'Connect',
        view: { kind: 'key', title: name, key: id },
      }
    }),
    ...data.servers.map(server => ({
      id: `mcp:${server.id}`, name: server.name, description: server.description || 'Give your agent access to this service.',
      mark: '↗', category: server.is_builtin ? 'builtin' : 'apps', saved: !server.is_builtin || !!server.default_enabled,
      status: server.default_enabled ? 'Added · on for new sessions' : server.is_builtin ? 'Included with IVE' : 'Added', action: 'Manage',
      view: { kind: 'mcp', title: server.name, serverId: server.id },
    })),
  ]
  const visible = rows.filter(row => (tab === 'browse' || row.saved)
    && (filter === 'all' || row.category === filter)
    && `${row.name} ${row.description}`.toLowerCase().includes(query.trim().toLowerCase()))
  const back = () => { setView(null); load() }
  const go = next => { setError(''); setView(next) }

  if (view) return <div className="ive-connectors ive-connectors-detail">
    <header className="ive-connectors-detail-header">
      <button type="button" className="ive-connector-back" onClick={back}><ArrowLeft size={16} /> All connectors</button>
      <h3>{view.title}</h3>
    </header>
    <div className="ive-connectors-detail-content">
      {view.kind === 'accounts' && <AccountManager initialCli={view.cli} initialAccountId={view.accountId} initialCreate={view.create} />}
      {view.kind === 'key' && <ApiKeysPanel selectedKey={view.key} />}
      {view.kind === 'mcp' && <McpPanel embedded initialServerId={view.serverId} onClose={back} />}
      {view.kind === 'local' && <McpPanel embedded initialMode="create" onClose={back} />}
      {view.kind === 'custom' && <CustomConnector onSaved={() => { setTab('yours'); setFilter('all'); setQuery(''); back() }} onAdvanced={() => go({ kind: 'local', title: 'Local connector' })} />}
      {view.kind === 'api' && <ApisIntegrationsPanel embedded onClose={back}
        onOpenBoard={() => window.dispatchEvent(new CustomEvent('open-panel', { detail: 'feature-board' }))}
        onOpenWorkspaceSettings={() => onNavigate?.('workspace-settings')} />}
    </div>
  </div>

  return <section className="ive-connectors" aria-label="Connectors">
    <div className="ive-connectors-heading">
      <div><h3>Apps & accounts</h3></div>
      <button type="button" className="ive-connector-primary" onClick={() => go({ kind: 'custom', title: 'Add custom connector' })}><Plus size={16} /> Add connector</button>
    </div>
    <div className="ive-connectors-login">
      <HelpDetails label="Using your existing login"><p>Choose <strong>Local login</strong> in chat or a session to use the sign-in on this computer. Saved accounts below have their own sign-in.</p></HelpDetails>
      <button type="button" className="ive-connector-action" onClick={() => go({ kind: 'accounts', title: 'Local login', accountId: '__system' })}>Local login<ChevronRight size={14} /></button>
    </div>
    {/* Account limits (5h / week windows) of the active session's provider;
        owners only (the component renders nothing otherwise). */}
    <div className="ive-connectors-limits"><ProviderLimits /></div>
    <div className="ive-connectors-tabs" role="tablist" aria-label="Connector directory">
      {[['yours', 'Your connectors'], ['browse', 'Browse']].map(([id, name]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{name}</button>)}
    </div>
    <div className="ive-connectors-toolbar">
      <label className="ive-connectors-search"><Search size={16} /><input ref={search} aria-label="Search connectors" placeholder="Search connectors…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="ive-connectors-filters" aria-label="Connector categories">
        {FILTERS.map(([id, name]) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>{name}</button>)}
      </div>
    </div>
    {error && <div className="ive-connector-error" role="alert">{error}<button type="button" onClick={load}>Try again</button></div>}
    <div className="ive-connectors-list" aria-busy={loading}>
      {loading ? <div className="ive-connectors-empty" role="status"><Loader2 size={20} className="animate-spin" /> Loading connectors…</div>
        : visible.length ? visible.map(row => <article className="ive-connector-row" key={row.id}>
          <span className="ive-connector-mark" aria-hidden="true">{row.brand ? <ProviderLogo provider={row.brand} className="w-6 h-6 shrink-0" /> : row.mark}</span>
          <div className="ive-connector-copy"><h4>{row.name}</h4><p>{row.description}</p>
            {row.status && <span className={`ive-connector-status${row.warning ? ' is-warning' : ''}`}>{row.saved && !row.warning && !row.local && <Check size={11} />}{row.status}</span>}
          </div>
          <button type="button" className="ive-connector-action" aria-label={`${row.action} ${row.name}`} onClick={() => go(row.view)}>{row.action}<ChevronRight size={14} /></button>
        </article>) : <div className="ive-connectors-empty">
          <Plug size={28} /><h4>{query ? 'No matching connectors' : 'Add your first connector'}</h4>
          <p>{query ? 'Try a different name or category.' : 'Connect an app or AI account to get started.'}</p>
          {!query && <button type="button" className="ive-connector-action" onClick={() => { setTab('browse'); setFilter('all') }}>Browse connectors <ArrowUpRight size={14} /></button>}
        </div>}
    </div>
    <footer className="ive-connectors-footer">
      <span>{activeSessionId ? 'Choose which tools a session can use in its connector settings.' : 'Add connectors here, then choose them for a session.'}</span>
      <button type="button" onClick={() => go({ kind: 'api', title: 'Custom APIs' })}><Settings2 size={14} /> Custom APIs</button>
    </footer>
  </section>
}

function CustomConnector({ onSaved, onAdvanced }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async event => {
    event.preventDefault()
    if (busy) return
    setError('')
    let parsed
    try { parsed = new URL(url.trim()) } catch { setError('Enter a valid server URL.'); return }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) { setError('Use an HTTP or HTTPS URL without credentials in it.'); return }
    if (!name.trim()) { setError('Give this connector a name.'); return }
    setBusy(true)
    try {
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'connector'
      await api.createMcpServer({ name: name.trim(), server_name: `${slug}-${crypto.randomUUID().slice(0, 8)}`,
        server_type: 'http', command: parsed.href, args: [], env: {}, auto_approve: false, default_enabled: false })
      onSaved()
    } catch (cause) { setError(cause.message || 'Could not add this connector. Your details are still here.') }
    finally { setBusy(false) }
  }
  return <form className="ive-connector-form" onSubmit={submit}>
    <span className="ive-connector-mark"><Globe size={23} /></span>
    <h4>Connect a service by URL</h4>
    <p>Add a remote MCP server. You can choose which sessions use it after adding it.</p>
    <label>Name<input value={name} onChange={e => setName(e.target.value)} placeholder="My team's tools" autoFocus disabled={busy} /></label>
    <label>Server URL<input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/mcp" disabled={busy} /></label>
    <HelpDetails label="Connection details"><p>Adding saves the connection details. If the service requires authentication, complete it with your agent or add its credentials in the connector settings.</p></HelpDetails>
    {error && <div role="alert" className="ive-connector-error">{error}</div>}
    <button type="submit" className="ive-connector-primary" disabled={busy || !name.trim() || !url.trim()}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}{busy ? 'Adding…' : 'Add connector'}</button>
    <button type="button" className="ive-connector-local" onClick={onAdvanced} disabled={busy}><Settings2 size={14} /> Set up a local connector instead</button>
  </form>
}
