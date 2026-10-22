import { useState, useEffect, useRef } from 'react'
import { Server, Plus, Trash2, Check, X, Pencil, RotateCcw, Search, Sparkles, Loader2 } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import usePanelCreate from '../../hooks/usePanelCreate'
import useListKeyboardNav from '../../hooks/useListKeyboardNav'

export default function McpPanel({ onClose, embedded = false, initialServerId, initialMode = 'list' }) {
  const [servers, setServers] = useState([])
  const [attached, setAttached] = useState({}) // server_id → boolean
  const [overrides, setOverrides] = useState({}) // server_id → auto_approve_override value
  const [mode, setMode] = useState(initialMode) // 'list' | 'create' | 'edit' | 'llm'
  const [editingId, setEditingId] = useState(null)
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const [search, setSearch] = useState('')
  const activeSessionId = useStore((s) => s.activeSessionId)
  const sessionStatus = useStore((s) => s.sessions[s.activeSessionId]?.status)
  const isRunning = sessionStatus === 'running'
  const [activeInSession, setActiveInSession] = useState(new Set())
  const [hasChanges, setHasChanges] = useState(false)
  const listRef = useRef(null)
  const searchRef = useRef(null)
  const panelRef = useRef(null)

  // Pull focus into the panel so arrow keys aren't swallowed by the terminal
  useEffect(() => { panelRef.current?.focus() }, [])

  // LLM parse state
  const [llmDocs, setLlmDocs] = useState('')
  const [llmParsing, setLlmParsing] = useState(false)
  const [llmError, setLlmError] = useState('')

  // Form fields
  const [formName, setFormName] = useState('')
  const [formServerName, setFormServerName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formCommand, setFormCommand] = useState('')
  const [formArgs, setFormArgs] = useState('')
  const [formEnv, setFormEnv] = useState('')
  const [formType, setFormType] = useState('stdio')
  const [formAutoApprove, setFormAutoApprove] = useState(false)
  const [formDefaultEnabled, setFormDefaultEnabled] = useState(false)

  useEffect(() => {
    api.getMcpServers().then(rows => {
      setServers(rows)
      const selected = rows.find(server => server.id === initialServerId)
      if (selected) handleEdit(selected)
    })
    if (activeSessionId) {
      api.getSessionMcpServers(activeSessionId).then((resp) => {
        const srvs = resp.mcp_servers || []
        const activeIds = resp.active_mcp_server_ids || []
        const map = {}
        const ovr = {}
        srvs.forEach((s) => {
          map[s.id] = true
          if (s.auto_approve_override != null) ovr[s.id] = s.auto_approve_override
        })
        setAttached(map)
        setOverrides(ovr)
        setActiveInSession(new Set(activeIds))
      })
    }
  }, [activeSessionId])

  const argsToList = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean)
  const envToObj = (text) => {
    const obj = {}
    text.split('\n').forEach((line) => {
      const eq = line.indexOf('=')
      if (eq > 0) obj[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    })
    return obj
  }
  const listToArgs = (arr) => (arr || []).join('\n')
  const objToEnv = (obj) => Object.entries(obj || {}).map(([k, v]) => `${k}=${v}`).join('\n')

  const handleCreate = async (e) => {
    e?.preventDefault?.()
    if (!formName.trim() || !formServerName.trim() || !formCommand.trim()) return
    const s = await api.createMcpServer({
      name: formName.trim(),
      server_name: formServerName.trim(),
      description: formDescription.trim(),
      command: formCommand.trim(),
      args: argsToList(formArgs),
      env: envToObj(formEnv),
      server_type: formType,
      auto_approve: formAutoApprove,
      default_enabled: formDefaultEnabled,
    })
    setServers([...servers, s])
    resetForm()
  }

  const handleEdit = (s) => {
    setEditingId(s.id)
    setFormName(s.name)
    setFormServerName(s.server_name)
    setFormDescription(s.description || '')
    setFormCommand(s.command)
    setFormArgs(listToArgs(s.args))
    setFormEnv(objToEnv(s.env))
    setFormType(s.server_type || 'stdio')
    setFormAutoApprove(!!s.auto_approve)
    setFormDefaultEnabled(!!s.default_enabled)
    setMode('edit')
  }

  const handleUpdate = async (e) => {
    e?.preventDefault?.()
    if (!formName.trim() || !formServerName.trim() || !formCommand.trim() || !editingId) return
    const updated = await api.updateMcpServer(editingId, {
      name: formName.trim(),
      server_name: formServerName.trim(),
      description: formDescription.trim(),
      command: formCommand.trim(),
      args: argsToList(formArgs),
      env: envToObj(formEnv),
      server_type: formType,
      auto_approve: formAutoApprove ? 1 : 0,
      default_enabled: formDefaultEnabled ? 1 : 0,
    })
    setServers(servers.map((s) => (s.id === editingId ? updated : s)))
    resetForm()
  }

  const resetForm = () => {
    setMode('list')
    setEditingId(null)
    setFormName('')
    setFormServerName('')
    setFormDescription('')
    setFormCommand('')
    setFormArgs('')
    setFormEnv('')
    setFormType('stdio')
    setFormAutoApprove(false)
    setFormDefaultEnabled(false)
    setLlmDocs('')
    setLlmError('')
    setLlmParsing(false)
  }

  usePanelCreate({
    onAdd: () => setMode('create'),
    onSubmit: () => {
      if (mode === 'create') handleCreate()
      else if (mode === 'edit') handleUpdate()
    },
  })

  useEffect(() => {
    if (selectedIdx < 0) return
    const el = listRef.current?.querySelector(`[data-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  // Filter servers by search
  const filteredServers = search.trim()
    ? servers.filter((s) => {
        const q = search.toLowerCase()
        return (
          s.name.toLowerCase().includes(q) ||
          s.server_name.toLowerCase().includes(q) ||
          (s.description || '').toLowerCase().includes(q) ||
          s.command.toLowerCase().includes(q)
        )
      })
    : servers

  useListKeyboardNav({
    enabled: mode === 'list',
    itemCount: filteredServers.length,
    selectedIdx,
    setSelectedIdx,
    onActivate: (idx) => {
      const s = filteredServers[idx]
      if (s) handleToggle(s.id)
    },
    onDelete: (idx) => {
      const s = filteredServers[idx]
      if (s && !s.is_builtin) handleDelete(s.id)
    },
  })

  const handleDelete = async (id) => {
    try {
      await api.deleteMcpServer(id)
      setServers(servers.filter((s) => s.id !== id))
      const { [id]: _, ...rest } = attached
      setAttached(rest)
    } catch (err) {
      // is_builtin check on server returns 403
    }
  }

  const handleToggle = async (sid) => {
    if (!activeSessionId) return
    const next = { ...attached, [sid]: !attached[sid] }
    if (!next[sid]) delete next[sid]
    setAttached(next)
    if (isRunning) setHasChanges(true)
    const ids = Object.keys(next).filter((k) => next[k])
    const ovr = {}
    ids.forEach((id) => { if (overrides[id] != null) ovr[id] = { auto_approve_override: overrides[id] } })
    await api.setSessionMcpServers(activeSessionId, ids, ovr)
  }

  const handleOverrideChange = async (sid, value) => {
    const newOverrides = { ...overrides }
    if (value === 'inherit') delete newOverrides[sid]
    else newOverrides[sid] = value === 'approve' ? 1 : 0
    setOverrides(newOverrides)
    if (isRunning) setHasChanges(true)
    const ids = Object.keys(attached).filter((k) => attached[k])
    const ovr = {}
    ids.forEach((id) => { if (newOverrides[id] != null) ovr[id] = { auto_approve_override: newOverrides[id] } })
    await api.setSessionMcpServers(activeSessionId, ids, ovr)
  }

  const handleRestart = () => {
    const store = useStore.getState()
    if (activeSessionId) {
      store.stopSession(activeSessionId)
      setTimeout(() => {
        store.restartSession(activeSessionId)
        setHasChanges(false)
        setTimeout(() => {
          api.getSessionMcpServers(activeSessionId).then((resp) => {
            const activeIds = resp.active_mcp_server_ids || []
            setActiveInSession(new Set(activeIds))
          })
        }, 2000)
      }, 500)
    }
  }

  // ── LLM parse handler ──────────────────────────────────────────
  const handleLlmParse = async () => {
    if (!llmDocs.trim()) return
    setLlmParsing(true)
    setLlmError('')
    try {
      const parsed = await api.parseMcpDocs(llmDocs)
      // Pre-fill form with parsed result
      setFormName(parsed.name || '')
      setFormServerName(parsed.server_name || '')
      setFormDescription(parsed.description || '')
      setFormCommand(parsed.command || '')
      setFormArgs(Array.isArray(parsed.args) ? parsed.args.join('\n') : (parsed.args || ''))
      setFormEnv(Object.entries(parsed.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'))
      setFormType(parsed.server_type || 'stdio')
      setFormAutoApprove(false)
      setFormDefaultEnabled(false)
      setMode('create')
      setLlmDocs('')
    } catch (err) {
      setLlmError(err.message || 'Failed to parse docs')
    } finally {
      setLlmParsing(false)
    }
  }

  const inputClass = 'w-full px-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus font-mono transition-colors duration-[80ms] ease-x'

  return (
    <div className={embedded ? 'h-full overflow-y-auto' : 'fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-x-scrim backdrop-blur-[4px]'} onClick={embedded ? undefined : onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className={embedded ? 'w-full outline-none' : 'w-[560px] x-panel shadow-x-3 overflow-hidden scale-in outline-none'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-x-line">
          <Server size={14} strokeWidth={1.75} className="text-x-accent" />
          <span className="text-xs text-x-ink-secondary font-medium">{embedded ? 'Connector settings' : 'MCP Servers'}</span>
          <div className="flex-1" />
          {mode === 'list' ? (
            <>
              <button
                onClick={() => setMode('llm')}
                className="flex items-center gap-1 px-2 py-1 text-xs text-x-muted hover:text-x-accent hover:bg-x-accent/10 rounded-md transition-colors duration-[80ms] ease-x"
                title="Paste MCP docs and let AI parse the config"
              >
                <Sparkles size={11} /> add with AI
              </button>
              <button
                onClick={() => setMode('create')}
                className="flex items-center gap-1 px-2 py-1 text-xs text-x-muted hover:text-x-ink-secondary hover:bg-x-hover rounded-md transition-colors duration-[80ms] ease-x"
              >
                <Plus size={11} /> new
              </button>
            </>
          ) : (
            <button
              onClick={resetForm}
              className="flex items-center gap-1 px-2 py-1 text-xs text-x-muted hover:text-x-ink-secondary hover:bg-x-hover rounded-md transition-colors duration-[80ms] ease-x"
            >
              back
            </button>
          )}
          {!embedded && <button onClick={onClose} className="p-1 rounded-md hover:bg-x-hover text-x-muted hover:text-x-ink-secondary transition-colors duration-[80ms] ease-x">
            <X size={15} />
          </button>}
        </div>

        {isRunning && hasChanges && (
          <div className="flex items-center gap-2 px-4 py-2 bg-x-surface-2 border-b border-x-line">
            <span className="text-[11px] text-x-accent-ink flex-1">
              MCP servers changed — restart session to apply.
            </span>
            <button
              onClick={handleRestart}
              className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-x-accent-ink/20 hover:bg-x-accent-ink/30 text-x-accent-ink border border-x-accent-ink/30 rounded-md transition-colors duration-[80ms] ease-x shrink-0"
            >
              <RotateCcw size={10} />
              restart
            </button>
          </div>
        )}

        {/* ── LLM paste mode ──────────────────────────────── */}
        {mode === 'llm' && (
          <div className="p-4 space-y-3">
            <div className="text-xs font-medium text-x-ink-secondary flex items-center gap-1.5">
              <Sparkles size={11} className="text-x-accent" />
              add with AI
            </div>
            <p className="text-xs text-x-ink-secondary">
              Paste the MCP server's documentation, README, or config example below. AI will parse it into a server config.
            </p>
            <textarea
              value={llmDocs}
              onChange={(e) => setLlmDocs(e.target.value)}
              placeholder={"Paste MCP server docs here...\n\ne.g. README content, npm page, JSON config example, or just a description like:\n\"Playwright MCP server, run with npx -y @playwright/mcp@latest\""}
              rows={8}
              className={inputClass + ' resize-none'}
              autoFocus
            />
            {llmError && (
              <p className="text-xs text-x-accent-ink">{llmError}</p>
            )}
            <div className="flex gap-1.5">
              <button
                onClick={handleLlmParse}
                disabled={!llmDocs.trim() || llmParsing}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-x-accent hover:bg-x-accent-ink disabled:opacity-40 text-x-on-accent rounded-md transition-colors duration-[80ms] ease-x"
              >
                {llmParsing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                {llmParsing ? 'parsing...' : 'parse & create'}
              </button>
              <button onClick={resetForm} className="px-3 py-1.5 text-xs font-medium bg-transparent border border-x-line hover:bg-x-hover hover:border-x-line-strong text-x-ink-secondary hover:text-x-ink rounded-md transition-colors duration-[80ms] ease-x">cancel</button>
            </div>
          </div>
        )}

        {/* ── Create / Edit form ──────────────────────────── */}
        {(mode === 'create' || mode === 'edit') && (
          <form onSubmit={mode === 'edit' ? handleUpdate : handleCreate} className="p-4 space-y-2.5 max-h-[65vh] overflow-y-auto">
            <div className="text-xs font-medium text-x-ink-secondary">
              {mode === 'edit' ? 'edit mcp server' : 'new mcp server'}
            </div>
            <input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="display name (e.g. Web Search)"
              className={inputClass}
              autoFocus
            />
            <input
              value={formServerName}
              onChange={(e) => setFormServerName(e.target.value.replace(/\s/g, '-'))}
              placeholder="server name (e.g. web-search) — key in mcpServers config"
              className={inputClass}
            />
            <input
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              placeholder="description (optional)"
              className={inputClass}
            />
            <div className="flex gap-2">
              <input
                value={formCommand}
                onChange={(e) => setFormCommand(e.target.value)}
                placeholder="command or URL (e.g. npx, python3, https://...)"
                className={inputClass}
              />
              <select
                value={formType}
                onChange={(e) => setFormType(e.target.value)}
                className="px-2 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus font-mono"
              >
                <option value="stdio">stdio</option>
                <option value="http">http</option>
                <option value="sse">sse</option>
              </select>
            </div>
            <textarea
              value={formArgs}
              onChange={(e) => setFormArgs(e.target.value)}
              placeholder="args (one per line)"
              rows={2}
              className={inputClass + ' resize-none'}
            />
            <textarea
              value={formEnv}
              onChange={(e) => setFormEnv(e.target.value)}
              placeholder="env vars or HTTP headers (KEY=VALUE per line)"
              rows={2}
              className={inputClass + ' resize-none'}
            />
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-1.5 text-xs text-x-ink-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={formAutoApprove}
                  onChange={(e) => setFormAutoApprove(e.target.checked)}
                  className="rounded border-x-line-strong"
                />
                do not require permission to run
              </label>
              <label className="flex items-center gap-1.5 text-xs text-x-ink-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={formDefaultEnabled}
                  onChange={(e) => setFormDefaultEnabled(e.target.checked)}
                  className="rounded border-x-line-strong"
                />
                auto-attach to new sessions
              </label>
            </div>
            <div className="flex gap-1.5">
              <button type="submit" className="px-3 py-1.5 text-xs font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent rounded-md transition-colors duration-[80ms] ease-x">
                {mode === 'edit' ? 'update' : 'save'}
              </button>
              <button type="button" onClick={resetForm} className="px-3 py-1.5 text-xs font-medium bg-transparent border border-x-line hover:bg-x-hover hover:border-x-line-strong text-x-ink-secondary hover:text-x-ink rounded-md transition-colors duration-[80ms] ease-x">cancel</button>
            </div>
          </form>
        )}

        {/* ── List mode ───────────────────────────────────── */}
        {mode === 'list' && (
          <>
            {/* Search bar */}
            {servers.length > 3 && (
              <div className="px-4 py-2 border-b border-x-line">
                <div className="relative">
                  <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-x-faint" />
                  <input
                    ref={searchRef}
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setSelectedIdx(-1) }}
                    placeholder="search MCP servers..."
                    className="w-full pl-7 pr-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus transition-colors duration-[80ms] ease-x"
                  />
                  {search && (
                    <button
                      onClick={() => { setSearch(''); searchRef.current?.focus() }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-x-faint hover:text-x-ink-secondary"
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              </div>
            )}
            <div ref={listRef} className="max-h-[55vh] overflow-y-auto">
              {filteredServers.map((s, idx) => (
                <div
                  key={s.id}
                  data-idx={idx}
                  onClick={() => setSelectedIdx(idx)}
                  className={`group flex items-start gap-2 px-4 py-2.5 border-b border-x-line transition-colors duration-[80ms] ease-x cursor-pointer ${
                    selectedIdx === idx
                      ? 'bg-x-tint border-l-2 border-l-x-accent'
                      : 'hover:bg-x-hover'
                  }`}
                >
                  <button
                    onClick={() => handleToggle(s.id)}
                    className={`mt-0.5 shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors duration-[80ms] ease-x ${
                      attached[s.id]
                        ? 'bg-x-accent border-x-accent'
                        : 'border-x-line-strong hover:border-x-muted'
                    }`}
                    title={activeSessionId ? 'Toggle for active session' : 'Select a session first'}
                  >
                    {attached[s.id] && <Check size={10} className="text-x-on-accent" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs text-x-ink font-mono">{s.server_name}</span>
                      {s.name !== s.server_name && (
                        <span className="text-[11px] text-x-muted">{s.name}</span>
                      )}
                      {s.is_builtin ? (
                        <span className="text-[11px] text-x-faint font-medium">builtin</span>
                      ) : null}
                      {s.default_enabled ? (
                        <span className="text-[11px] text-x-accent font-medium">default</span>
                      ) : null}
                      {s.auto_approve ? (
                        <span className="text-[11px] text-x-good/70">auto-approve</span>
                      ) : null}
                      {isRunning && attached[s.id] && activeInSession.has(s.id) && (
                        <span className="text-[11px] text-x-good/60" title="Active in session MCP config">active</span>
                      )}
                      {isRunning && attached[s.id] && !activeInSession.has(s.id) && (
                        <span className="text-[11px] text-x-accent-ink/70" title="Not yet loaded — restart to apply">pending</span>
                      )}
                      {isRunning && !attached[s.id] && activeInSession.has(s.id) && (
                        <span className="text-[11px] text-x-accent-ink/70" title="Still loaded — restart to remove">still loaded</span>
                      )}
                    </div>
                    <p className="text-[11px] text-x-muted font-mono mt-0.5 truncate">
                      {s.command} {Array.isArray(s.args) ? s.args.join(' ') : (s.args || '')}
                    </p>
                    {s.description && (
                      <p className="text-[11px] text-x-faint mt-0.5 line-clamp-1">{s.description}</p>
                    )}
                  </div>
                  {attached[s.id] && (
                    <select
                      value={overrides[s.id] != null ? (overrides[s.id] ? 'approve' : 'deny') : 'inherit'}
                      onChange={(e) => handleOverrideChange(s.id, e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="text-[11px] bg-x-surface-2 border border-x-line rounded px-1 py-0.5 text-x-ink-secondary focus:outline-none"
                      title="Per-session auto-approve override"
                    >
                      <option value="inherit">{s.auto_approve ? '🔓 inherit (auto)' : '🔒 inherit (ask)'}</option>
                      <option value="approve">🔓 auto-approve</option>
                      <option value="deny">🔒 require permission</option>
                    </select>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); handleEdit(s) }}
                    className="opacity-0 group-hover:opacity-100 text-x-faint hover:text-x-accent transition-opacity duration-[80ms] ease-x mt-0.5"
                    title="Edit server"
                  >
                    <Pencil size={12} />
                  </button>
                  {!s.is_builtin && (
                    <button
                      onClick={() => handleDelete(s.id)}
                      className="opacity-0 group-hover:opacity-100 text-x-faint hover:text-x-accent-ink transition-opacity duration-[80ms] ease-x mt-0.5"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              ))}
              {servers.length === 0 && (
                <div className="px-4 py-10 text-xs text-x-faint text-center">
                  No MCP servers yet — click "+ new" to create one
                  <br />
                  <span className="text-x-faint/60">MCP servers provide tools to supported CLI sessions</span>
                </div>
              )}
              {servers.length > 0 && filteredServers.length === 0 && search && (
                <div className="px-4 py-8 text-xs text-x-faint text-center">
                  No servers match "{search}"
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
