import { useState, useEffect, useRef } from 'react'
import { Server, Plus, Trash2, Check, X, Pencil, RotateCcw, Search, Sparkles, Loader2 } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import usePanelCreate from '../../hooks/usePanelCreate'
import useListKeyboardNav from '../../hooks/useListKeyboardNav'

export default function McpPanel({ onClose }) {
  const [servers, setServers] = useState([])
  const [attached, setAttached] = useState({}) // server_id → boolean
  const [overrides, setOverrides] = useState({}) // server_id → auto_approve_override value
  const [mode, setMode] = useState('list') // 'list' | 'create' | 'edit' | 'llm'
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
    api.getMcpServers().then(setServers)
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

  const inputClass = 'w-full px-2.5 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono transition-colors'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/50" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-[560px] ide-panel overflow-hidden scale-in outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary">
          <Server size={14} className="text-accent-primary" />
          <span className="text-xs text-text-secondary font-medium">MCP Servers</span>
          <div className="flex-1" />
          {mode === 'list' ? (
            <>
              <button
                onClick={() => setMode('llm')}
                className="flex items-center gap-1 px-2 py-1 text-xs text-text-faint hover:text-violet-400 hover:bg-violet-500/10 rounded-md transition-colors"
                title="Paste MCP docs and let AI parse the config"
              >
                <Sparkles size={11} /> add with AI
              </button>
              <button
                onClick={() => setMode('create')}
                className="flex items-center gap-1 px-2 py-1 text-xs text-text-faint hover:text-text-secondary hover:bg-bg-hover rounded-md transition-colors"
              >
                <Plus size={11} /> new
              </button>
            </>
          ) : (
            <button
              onClick={resetForm}
              className="flex items-center gap-1 px-2 py-1 text-xs text-text-faint hover:text-text-secondary hover:bg-bg-hover rounded-md transition-colors"
            >
              back
            </button>
          )}
          <button onClick={onClose} className="p-1 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors">
            <X size={15} />
          </button>
        </div>

        {isRunning && hasChanges && (
          <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20">
            <span className="text-[11px] text-amber-400 flex-1">
              MCP servers changed — restart session to apply.
            </span>
            <button
              onClick={handleRestart}
              className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 rounded-md transition-colors shrink-0"
            >
              <RotateCcw size={10} />
              restart
            </button>
          </div>
        )}

        {/* ── LLM paste mode ──────────────────────────────── */}
        {mode === 'llm' && (
          <div className="p-4 space-y-3">
            <div className="text-[10px] text-text-faint font-mono uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles size={10} className="text-violet-400" />
              add with AI
            </div>
            <p className="text-xs text-text-secondary">
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
              <p className="text-xs text-red-400">{llmError}</p>
            )}
            <div className="flex gap-1.5">
              <button
                onClick={handleLlmParse}
                disabled={!llmDocs.trim() || llmParsing}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-violet-600 hover:bg-violet-500 disabled:opacity-30 text-white rounded-md transition-colors"
              >
                {llmParsing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                {llmParsing ? 'parsing...' : 'parse & create'}
              </button>
              <button onClick={resetForm} className="px-3 py-1.5 text-xs font-medium bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded-md transition-colors">cancel</button>
            </div>
          </div>
        )}

        {/* ── Create / Edit form ──────────────────────────── */}
        {(mode === 'create' || mode === 'edit') && (
          <form onSubmit={mode === 'edit' ? handleUpdate : handleCreate} className="p-4 space-y-2.5 max-h-[65vh] overflow-y-auto">
            <div className="text-[10px] text-text-faint font-mono uppercase tracking-wider">
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
                placeholder="command (e.g. npx, python3)"
                className={inputClass}
              />
              <select
                value={formType}
                onChange={(e) => setFormType(e.target.value)}
                className="px-2 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary focus:outline-none ide-focus-ring font-mono"
              >
                <option value="stdio">stdio</option>
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
              placeholder="env vars (KEY=VALUE per line)"
              rows={2}
              className={inputClass + ' resize-none'}
            />
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={formAutoApprove}
                  onChange={(e) => setFormAutoApprove(e.target.checked)}
                  className="rounded border-border-accent"
                />
                do not require permission to run
              </label>
              <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={formDefaultEnabled}
                  onChange={(e) => setFormDefaultEnabled(e.target.checked)}
                  className="rounded border-border-accent"
                />
                auto-attach to new sessions
              </label>
            </div>
            <div className="flex gap-1.5">
              <button type="submit" className="px-3 py-1.5 text-xs font-medium bg-accent-primary hover:bg-accent-hover text-white rounded-md transition-colors">
                {mode === 'edit' ? 'update' : 'save'}
              </button>
              <button type="button" onClick={resetForm} className="px-3 py-1.5 text-xs font-medium bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded-md transition-colors">cancel</button>
            </div>
          </form>
        )}

        {/* ── List mode ───────────────────────────────────── */}
        {mode === 'list' && (
          <>
            {/* Search bar */}
            {servers.length > 3 && (
              <div className="px-4 py-2 border-b border-border-secondary">
                <div className="relative">
                  <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint" />
                  <input
                    ref={searchRef}
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setSelectedIdx(-1) }}
                    placeholder="search MCP servers..."
                    className="w-full pl-7 pr-2.5 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none ide-focus-ring font-mono transition-colors"
                  />
                  {search && (
                    <button
                      onClick={() => { setSearch(''); searchRef.current?.focus() }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-text-faint hover:text-text-secondary"
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
                  className={`group flex items-start gap-2 px-4 py-2.5 border-b border-border-secondary transition-colors cursor-pointer ${
                    selectedIdx === idx
                      ? 'bg-accent-subtle ring-1 ring-inset ring-accent-primary/40'
                      : 'hover:bg-bg-hover/50'
                  }`}
                >
                  <button
                    onClick={() => handleToggle(s.id)}
                    className={`mt-0.5 shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                      attached[s.id]
                        ? 'bg-accent-primary border-accent-primary'
                        : 'border-border-accent hover:border-text-muted'
                    }`}
                    title={activeSessionId ? 'Toggle for active session' : 'Select a session first'}
                  >
                    {attached[s.id] && <Check size={10} className="text-white" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs text-text-primary font-mono">{s.server_name}</span>
                      {s.name !== s.server_name && (
                        <span className="text-[10px] text-text-muted">{s.name}</span>
                      )}
                      {s.is_builtin ? (
                        <span className="text-[9px] text-text-faint/60 font-medium uppercase">builtin</span>
                      ) : null}
                      {s.default_enabled ? (
                        <span className="text-[10px] text-accent-primary font-medium uppercase">default</span>
                      ) : null}
                      {s.auto_approve ? (
                        <span className="text-[9px] text-emerald-500/70">auto-approve</span>
                      ) : null}
                      {isRunning && attached[s.id] && activeInSession.has(s.id) && (
                        <span className="text-[9px] text-emerald-400/60" title="Active in session MCP config">active</span>
                      )}
                      {isRunning && attached[s.id] && !activeInSession.has(s.id) && (
                        <span className="text-[9px] text-amber-400/70" title="Not yet loaded — restart to apply">pending</span>
                      )}
                      {isRunning && !attached[s.id] && activeInSession.has(s.id) && (
                        <span className="text-[9px] text-red-400/70" title="Still loaded — restart to remove">still loaded</span>
                      )}
                    </div>
                    <p className="text-[11px] text-text-muted font-mono mt-0.5 truncate">
                      {s.command} {Array.isArray(s.args) ? s.args.join(' ') : (s.args || '')}
                    </p>
                    {s.description && (
                      <p className="text-[10px] text-text-faint mt-0.5 line-clamp-1">{s.description}</p>
                    )}
                  </div>
                  {attached[s.id] && (
                    <select
                      value={overrides[s.id] != null ? (overrides[s.id] ? 'approve' : 'deny') : 'inherit'}
                      onChange={(e) => handleOverrideChange(s.id, e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="text-[10px] bg-bg-inset border border-border-primary rounded px-1 py-0.5 text-text-secondary focus:outline-none"
                      title="Per-session auto-approve override"
                    >
                      <option value="inherit">{s.auto_approve ? '🔓 inherit (auto)' : '🔒 inherit (ask)'}</option>
                      <option value="approve">🔓 auto-approve</option>
                      <option value="deny">🔒 require permission</option>
                    </select>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); handleEdit(s) }}
                    className="opacity-0 group-hover:opacity-100 text-text-faint hover:text-accent-primary transition-all mt-0.5"
                    title="Edit server"
                  >
                    <Pencil size={12} />
                  </button>
                  {!s.is_builtin && (
                    <button
                      onClick={() => handleDelete(s.id)}
                      className="opacity-0 group-hover:opacity-100 text-text-faint hover:text-red-400 transition-all mt-0.5"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              ))}
              {servers.length === 0 && (
                <div className="px-4 py-10 text-xs text-text-faint text-center">
                  No MCP servers yet — click "+ new" to create one
                  <br />
                  <span className="text-text-faint/60">MCP servers provide tools to Claude/Gemini CLI sessions</span>
                </div>
              )}
              {servers.length > 0 && filteredServers.length === 0 && search && (
                <div className="px-4 py-8 text-xs text-text-faint text-center">
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
