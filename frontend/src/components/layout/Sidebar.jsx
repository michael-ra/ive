import { useEffect, useState, useRef, useCallback } from 'react'
import { Plus, FolderOpen, MessageSquare, ChevronDown, ChevronRight, Trash2, Search, Crown, Kanban, GitCompareArrows, GripVertical, Shield, Server, Check, GitMerge, FlaskConical, BookOpenCheck, FileText, Pencil, Copy, ClipboardCopy, Square, ExternalLink, Download } from 'lucide-react'
import MergeDialog from '../session/MergeDialog'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { sendTerminalCommand } from '../../lib/terminal'
import { MODELS, PERMISSION_MODES, EFFORT_LEVELS, GEMINI_MODELS, GEMINI_APPROVAL_MODES, CLI_TYPES, getWorkspaceColor, WORKSPACE_PALETTE, getModelsForCli, getPermissionModesForCli, getEffortLevelsForCli, getDefaultModel, getDefaultPermissionMode } from '../../lib/constants'
import MailboxPill from './MailboxPill'

function SessionContextMenu({ x, y, session, onClose }) {
  const menuRef = useRef(null)

  useEffect(() => {
    const handler = () => onClose()
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [onClose])

  // Clamp menu position so it doesn't overflow the viewport
  const [pos, setPos] = useState({ left: x, top: y })
  useEffect(() => {
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    const newPos = { left: x, top: y }
    if (rect.bottom > window.innerHeight) newPos.top = window.innerHeight - rect.height - 8
    if (rect.right > window.innerWidth) newPos.left = window.innerWidth - rect.width - 8
    setPos(newPos)
  }, [x, y])

  const handleRename = async () => {
    const name = prompt('Rename session:', session.name)
    if (name?.trim()) {
      const updated = await api.renameSession(session.id, name.trim())
      useStore.getState().loadSessions([updated])
    }
    onClose()
  }

  const handleCopyOutput = async () => {
    try {
      const data = await api.getSessionOutput(session.id, 200)
      const text = data.output || data.text || ''
      await navigator.clipboard.writeText(text)
    } catch { /* silent */ }
    onClose()
  }

  const handleCopyMessages = async () => {
    try {
      const msgs = await api.getMessages(session.id)
      if (msgs.length > 0) {
        const last = msgs[msgs.length - 1]
        const text = last.content || ''
        await navigator.clipboard.writeText(text)
      }
    } catch { /* silent */ }
    onClose()
  }

  const handleStop = () => {
    useStore.getState().stopSession(session.id)
    onClose()
  }

  const handleOpen = () => {
    useStore.getState().openSession(session.id)
    onClose()
  }

  const handleExport = () => {
    window.open(`/api/sessions/${session.id}/export`, '_blank')
    onClose()
  }

  const handleDelete = async () => {
    await api.deleteSession(session.id)
    useStore.getState().removeSession(session.id)
    onClose()
  }

  const isRunning = session.status === 'running'

  const items = [
    { icon: ExternalLink, label: 'Open', action: handleOpen },
    { icon: Pencil, label: 'Rename', action: handleRename },
    null, // separator
    { icon: ClipboardCopy, label: 'Copy output', action: handleCopyOutput },
    { icon: Copy, label: 'Copy last message', action: handleCopyMessages },
    { icon: Download, label: 'Export', action: handleExport },
    null,
    ...(isRunning ? [{ icon: Square, label: 'Stop', action: handleStop }] : []),
    { icon: Trash2, label: 'Delete', action: handleDelete, danger: true },
  ]

  return (
    <div
      ref={menuRef}
      className="fixed z-[60] ide-panel py-1 min-w-[170px] scale-in"
      style={pos}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, i) =>
        item === null ? (
          <div key={`sep-${i}`} className="my-1 border-t border-border-secondary" />
        ) : (
          <button
            key={item.label}
            onClick={item.action}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${
              item.danger ? 'text-red-400 hover:bg-red-400/10' : 'text-text-secondary hover:bg-bg-hover'
            }`}
          >
            <item.icon size={12} />
            {item.label}
          </button>
        )
      )}
    </div>
  )
}

function ResearchModelPicker({ ws }) {
  // Detect installed CLIs (cached after first fetch)
  const [cliAvail, setCliAvail] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cc-cli-available') || '{}') } catch { return {} }
  })

  useEffect(() => {
    api.getCliInfo().then((info) => {
      if (info.available_clis) {
        setCliAvail(info.available_clis)
        localStorage.setItem('cc-cli-available', JSON.stringify(info.available_clis))
      }
      if (info.version) {
        localStorage.setItem('cc-version', info.version)
      }
    }).catch(() => {})
  }, [])

  const hasClaude = cliAvail.claude !== false // default true if unknown
  const hasGemini = !!cliAvail.gemini

  const savedOllama = JSON.parse(localStorage.getItem('cc-ollama-models') || '[]')
  const [showCustom, setShowCustom] = useState(false)
  const [customModel, setCustomModel] = useState('')

  const currentVal = ws.research_model || ''
  const isOllamaCustom = currentVal && !MODELS.some((m) => m.id === currentVal) && !GEMINI_MODELS.some((m) => m.id === currentVal)

  const saveModel = async (v) => {
    await api.updateWorkspace(ws.id, { research_model: v || null })
    useStore.getState().setWorkspaces(
      useStore.getState().workspaces.map((w) => w.id === ws.id ? { ...w, research_model: v || null } : w)
    )
  }

  const addOllamaModel = (model) => {
    if (!model.trim()) return
    const updated = [...new Set([...savedOllama, model.trim()])]
    localStorage.setItem('cc-ollama-models', JSON.stringify(updated))
    saveModel(model.trim())
    setShowCustom(false)
    setCustomModel('')
  }

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 mb-0.5">
      <span className="text-[10px] text-text-faint font-mono shrink-0">research:</span>
      {showCustom ? (
        <div className="flex-1 min-w-0 flex gap-1">
          <input
            type="text"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addOllamaModel(customModel); if (e.key === 'Escape') setShowCustom(false) }}
            placeholder="ollama model:tag"
            className="flex-1 px-1.5 py-1 text-[10px] font-mono bg-bg-inset border border-border-secondary rounded-md text-text-secondary placeholder-text-faint focus:outline-none ide-focus-ring"
            autoFocus
          />
          <button onClick={() => addOllamaModel(customModel)} className="text-[9px] text-accent-primary">add</button>
          <button onClick={() => setShowCustom(false)} className="text-[9px] text-text-faint">x</button>
        </div>
      ) : (
        <select
          value={isOllamaCustom ? currentVal : currentVal}
          onChange={(e) => {
            if (e.target.value === '__custom__') { setShowCustom(true); return }
            saveModel(e.target.value)
          }}
          className="flex-1 min-w-0 px-1.5 py-1 text-[10px] font-mono bg-bg-inset border border-border-secondary rounded-md text-text-secondary focus:outline-none focus:border-purple-500/50 ide-focus-ring transition-colors"
        >
          <option value="">default</option>
          {hasClaude && (
            <optgroup label="Claude">
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </optgroup>
          )}
          {hasGemini && (
            <optgroup label="Gemini">
              {GEMINI_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </optgroup>
          )}
          {savedOllama.length > 0 && (
            <optgroup label="Ollama (saved)">
              {savedOllama.map((m) => <option key={m} value={m}>{m}</option>)}
            </optgroup>
          )}
          <option value="__custom__">+ add Ollama model...</option>
        </select>
      )}
    </div>
  )
}

function PreviewUrlInput({ ws }) {
  const [val, setVal] = useState(ws.preview_url || '')
  const [saving, setSaving] = useState(false)

  // Sync local state if the workspace gets updated externally (e.g. by MCP).
  useEffect(() => { setVal(ws.preview_url || '') }, [ws.preview_url])

  const save = async () => {
    const next = val.trim()
    if (next === (ws.preview_url || '')) return
    setSaving(true)
    try {
      await api.updateWorkspace(ws.id, { preview_url: next || null })
      useStore.getState().setWorkspaces(
        useStore.getState().workspaces.map((w) =>
          w.id === ws.id ? { ...w, preview_url: next || null } : w
        )
      )
    } finally {
      setSaving(false)
    }
  }

  const open = () => {
    const url = (ws.preview_url || val || '').trim()
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 mb-0.5">
      <span className="text-[10px] text-text-faint font-mono shrink-0">preview:</span>
      <input
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
        placeholder="http://localhost:3000"
        className="flex-1 min-w-0 px-1.5 py-1 text-[10px] font-mono bg-bg-inset border border-border-secondary rounded-md text-text-secondary placeholder-text-faint focus:outline-none focus:border-purple-500/50 ide-focus-ring transition-colors"
      />
      <button
        onClick={open}
        disabled={!ws.preview_url && !val.trim()}
        title="Open in new tab (⌘P)"
        className="text-[9px] text-accent-primary hover:text-indigo-300 disabled:text-text-faint disabled:cursor-not-allowed font-mono"
      >
        {saving ? '…' : '↗'}
      </button>
    </div>
  )
}

function CoordinationNamespaceInput({ ws }) {
  const [val, setVal] = useState(ws.coordination_namespace || '')
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(false)

  // Check if the experimental flag is on
  useEffect(() => {
    api.getAppSetting('experimental_myelin_coordination')
      .then((r) => setEnabled(r?.value === 'on'))
      .catch(() => {})
  }, [])

  useEffect(() => { setVal(ws.coordination_namespace || '') }, [ws.coordination_namespace])

  if (!enabled) return null

  const save = async () => {
    const next = val.trim()
    if (next === (ws.coordination_namespace || '')) return
    setSaving(true)
    try {
      await api.updateWorkspace(ws.id, { coordination_namespace: next || null })
      useStore.getState().setWorkspaces(
        useStore.getState().workspaces.map((w) =>
          w.id === ws.id ? { ...w, coordination_namespace: next || null } : w
        )
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 mb-0.5">
      <span className="text-[10px] text-text-faint font-mono shrink-0" title="Myelin coordination namespace — workspaces sharing the same namespace detect conflicts between sessions">coord:</span>
      <input
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
        placeholder={`commander:${ws.id.slice(0, 8)}`}
        className="flex-1 min-w-0 px-1.5 py-1 text-[10px] font-mono bg-bg-inset border border-border-secondary rounded-md text-text-secondary placeholder-text-faint focus:outline-none focus:border-purple-500/50 ide-focus-ring transition-colors"
      />
      {saving && <span className="text-[9px] text-text-faint font-mono">…</span>}
    </div>
  )
}

function NewSessionForm({ workspaceId, onClose }) {
  const [cliType, setCliType] = useState('claude')
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [model, setModel] = useState('sonnet')
  const [mode, setMode] = useState('auto')
  const [effort, setEffort] = useState('high')
  const [outputStyle, setOutputStyle] = useState('')
  const [outputStyles, setOutputStyles] = useState([])
  const [templates, setTemplates] = useState([])
  const [accounts, setAccounts] = useState([])
  const [accountId, setAccountId] = useState('')
  const [appliedTemplate, setAppliedTemplate] = useState(null)
  // Guideline picker — guidelines selected here go into --append-system-prompt
  // at session start (cached by Claude's prompt caching → 90% cheaper per turn
  // vs mid-session injection via hooks).
  const [allGuidelines, setAllGuidelines] = useState([])
  const [selectedGuidelineIds, setSelectedGuidelineIds] = useState(new Set())
  const [showGuidelines, setShowGuidelines] = useState(false)
  const [allMcpServers, setAllMcpServers] = useState([])
  const [selectedMcpServerIds, setSelectedMcpServerIds] = useState(new Set())
  const [showMcpPicker, setShowMcpPicker] = useState(false)
  const [guidelineFilter, setGuidelineFilter] = useState('')
  const [mcpFilter, setMcpFilter] = useState('')
  const [modelSwitchingEnabled, setModelSwitchingEnabled] = useState(false)
  const [planModel, setPlanModel] = useState('')
  const [executeModel, setExecuteModel] = useState('')
  const [autoApprovePlan, setAutoApprovePlan] = useState(false)
  const [worktree, setWorktree] = useState(false)

  // Pre-populate worktree from workspace default
  const workspaces = useStore((s) => s.workspaces)
  useEffect(() => {
    const ws = workspaces.find((w) => w.id === workspaceId)
    if (ws?.default_worktree) setWorktree(true)
  }, [workspaceId, workspaces])

  useEffect(() => {
    api.getTemplates().then(setTemplates).catch(() => {})
    api.getAccounts().then(setAccounts).catch(() => {})
    api.getOutputStyles().then(setOutputStyles).catch(() => {})
    api.getGuidelines().then((gs) => {
      setAllGuidelines(gs)
      // Pre-select guidelines marked as default
      const defaults = new Set(gs.filter((g) => g.is_default).map((g) => g.id))
      setSelectedGuidelineIds(defaults)
    }).catch(() => {})
    api.getMcpServers().then((srvs) => {
      setAllMcpServers(srvs)
      const defaults = new Set(srvs.filter((s) => s.default_enabled).map((s) => s.id))
      setSelectedMcpServerIds(defaults)
    }).catch(() => {})
    api.getAppSetting('experimental_model_switching').then((r) => {
      if (r?.value === 'on') setModelSwitchingEnabled(true)
    }).catch(() => {})
  }, [])

  const applyTemplate = (tmpl) => {
    if (tmpl.model) setModel(tmpl.model)
    if (tmpl.permission_mode) setMode(tmpl.permission_mode)
    if (tmpl.effort) setEffort(tmpl.effort)
    if (tmpl.name && !name) setName(tmpl.name)
    if (tmpl.plan_model) setPlanModel(tmpl.plan_model)
    if (tmpl.execute_model) setExecuteModel(tmpl.execute_model)
    if (tmpl.auto_approve_plan) setAutoApprovePlan(!!tmpl.auto_approve_plan)
    setAppliedTemplate(tmpl)
  }

  const toggleGuideline = (id) => {
    setSelectedGuidelineIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleMcpServer = (id) => {
    setSelectedMcpServerIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCreate = async (e) => {
    e.preventDefault()
    try {
      // If a template was applied, use the apply endpoint to get guidelines too
      let session
      if (appliedTemplate?.id) {
        session = await api.applyTemplate(appliedTemplate.id, workspaceId, name.trim() || undefined)
      } else {
        session = await api.createSession(workspaceId, {
          name: name.trim() || undefined,
          purpose: purpose.trim() || undefined,
          model,
          permission_mode: mode,
          effort: getEffortLevelsForCli(cliType).length > 0 ? effort : undefined,
          output_style: outputStyle || undefined,
          account_id: accountId || undefined,
          cli_type: cliType,
          plan_model: planModel || undefined,
          execute_model: executeModel || undefined,
          auto_approve_plan: autoApprovePlan || undefined,
          worktree: worktree ? 1 : 0,
        })
      }

      // Attach selected guidelines BEFORE the PTY starts so they flow
      // into --append-system-prompt and get prompt-cached. This runs
      // after createSession (which creates the DB row) but before the
      // PTY connect (which happens on the next WebSocket start_pty).
      const guidelineIds = [...selectedGuidelineIds]
      if (guidelineIds.length > 0 && !appliedTemplate?.id) {
        await api.setSessionGuidelines(session.id, guidelineIds)
      }

      const mcpServerIds = [...selectedMcpServerIds]
      if (mcpServerIds.length > 0 && !appliedTemplate?.id) {
        await api.setSessionMcpServers(session.id, mcpServerIds)
      }

      useStore.getState().addSession(session)

      // If template has conversation turns, replay them after PTY starts
      if (appliedTemplate?.conversation_turns) {
        const turns = JSON.parse(appliedTemplate.conversation_turns || '[]')
        if (turns.length > 0) {
          useStore.getState().setSessionStatus(session.id, 'replaying')
          // Wait for PTY to start, then send replay action
          setTimeout(() => {
            const ws = useStore.getState().ws
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                action: 'replay_turns',
                session_id: session.id,
                turns,
              }))
            }
          }, 2000) // Give PTY time to start + Claude Code to initialize
        }
      }

      onClose()
    } catch (err) {
      console.error('Failed to create session:', err)
    }
  }

  const selectClass = 'flex-1 px-2 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-zinc-300 focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-colors'

  return (
    <form onSubmit={handleCreate} className="px-3 py-2.5 border-b border-border-primary bg-bg-elevated/50 space-y-2">
      {templates.length > 0 && (
        <div>
          <label className="text-[10px] text-text-faint font-medium uppercase tracking-wider mb-1 block">From template</label>
          <select
            onChange={(e) => {
              const tmpl = templates.find((t) => t.id === e.target.value)
              if (tmpl) applyTemplate(tmpl)
            }}
            className="w-full px-2 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-zinc-300 focus:outline-none focus:border-accent-primary/50 font-mono"
            defaultValue=""
          >
            <option value="">blank session</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.model || 'sonnet'}, {t.permission_mode || 'auto'})
                {t.conversation_turns ? ` +${JSON.parse(t.conversation_turns || '[]').length} turns` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="session name (optional)"
        className="w-full px-2 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-zinc-300 placeholder-text-faint focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-colors"
        autoFocus
      />
      <input
        type="text"
        value={purpose}
        onChange={(e) => setPurpose(e.target.value)}
        placeholder="purpose (e.g. frontend design, bug fix...)"
        className="w-full px-2 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-zinc-300 placeholder-text-faint focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-colors"
      />

      {/* CLI type toggle */}
      <div className="flex gap-1.5">
        {CLI_TYPES.map((ct) => (
          <button
            key={ct.id}
            type="button"
            onClick={() => {
              setCliType(ct.id)
              setModel(getDefaultModel(ct.id))
              setMode(getDefaultPermissionMode(ct.id))
            }}
            className={`flex-1 px-2 py-1.5 text-xs font-medium rounded-md transition-all ${
              cliType === ct.id
                ? ct.id === 'gemini' ? 'bg-blue-500/15 text-blue-400 border border-blue-500/25' : 'bg-accent-subtle text-indigo-400 border border-indigo-500/25'
                : 'text-text-faint hover:text-text-secondary border border-border-secondary hover:border-border-primary'
            }`}
          >
            {ct.label}
          </button>
        ))}
      </div>

      <div className="flex gap-1.5">
        <select value={model} onChange={(e) => setModel(e.target.value)} className={selectClass}>
          {getModelsForCli(cliType).map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value)} className={selectClass}>
          {getPermissionModesForCli(cliType).map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>

      {accounts.length > 0 && (
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectClass}>
          <option value="">system auth</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name} {a.is_default ? '(default)' : ''}</option>
          ))}
        </select>
      )}

      {/* Guideline picker — collapsible, shows available guidelines with
          checkboxes. Selected guidelines go into --append-system-prompt at
          session start (prompt-cached, 90% cheaper per turn after first).
          Default guidelines are pre-selected. */}
      {allGuidelines.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowGuidelines(!showGuidelines)}
            className="flex items-center gap-1 text-[10px] text-text-faint hover:text-text-secondary transition-colors"
          >
            <Shield size={10} />
            guidelines
            {selectedGuidelineIds.size > 0 && (
              <span className="text-accent-primary">({selectedGuidelineIds.size})</span>
            )}
            {showGuidelines ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
          </button>
          {showGuidelines && (
            <div className="mt-1 space-y-0.5">
              <input
                type="text"
                value={guidelineFilter}
                onChange={(e) => setGuidelineFilter(e.target.value)}
                placeholder="search guidelines..."
                className="w-full px-1.5 py-1 text-[11px] bg-bg-inset border border-border-primary rounded text-zinc-300 placeholder-text-faint focus:outline-none focus:border-accent-primary/50"
              />
              <div className="max-h-[120px] overflow-y-auto space-y-0.5">
              {allGuidelines.filter((g) => !guidelineFilter || g.name.toLowerCase().includes(guidelineFilter.toLowerCase())).map((g) => (
                <label
                  key={g.id}
                  className="flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-bg-hover/50 cursor-pointer text-[11px]"
                >
                  <span
                    className={`shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors ${
                      selectedGuidelineIds.has(g.id)
                        ? 'bg-accent-primary border-accent-primary'
                        : 'border-border-accent hover:border-text-muted'
                    }`}
                    onClick={(e) => { e.preventDefault(); toggleGuideline(g.id) }}
                  >
                    {selectedGuidelineIds.has(g.id) && <Check size={8} className="text-white" />}
                  </span>
                  <span className="text-text-secondary font-mono truncate">{g.name}</span>
                  {g.is_default ? (
                    <span className="text-[8px] text-accent-primary shrink-0">default</span>
                  ) : null}
                </label>
              ))}
              </div>
            </div>
          )}
        </div>
      )}

      {allMcpServers.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowMcpPicker(!showMcpPicker)}
            className="flex items-center gap-1 text-[10px] text-text-faint hover:text-text-secondary transition-colors"
          >
            <Server size={10} />
            mcp servers
            {selectedMcpServerIds.size > 0 && (
              <span className="text-accent-primary">({selectedMcpServerIds.size})</span>
            )}
            {showMcpPicker ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
          </button>
          {showMcpPicker && (
            <div className="mt-1 space-y-0.5">
              <input
                type="text"
                value={mcpFilter}
                onChange={(e) => setMcpFilter(e.target.value)}
                placeholder="search servers..."
                className="w-full px-1.5 py-1 text-[11px] bg-bg-inset border border-border-primary rounded text-zinc-300 placeholder-text-faint focus:outline-none focus:border-accent-primary/50"
              />
              <div className="max-h-[120px] overflow-y-auto space-y-0.5">
              {allMcpServers.filter((s) => !mcpFilter || s.server_name.toLowerCase().includes(mcpFilter.toLowerCase())).map((s) => {
                const locked = s.is_builtin && s.default_enabled
                return (
                <label
                  key={s.id}
                  className={`flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-bg-hover/50 text-[11px] ${locked ? 'opacity-60 cursor-default' : 'cursor-pointer'}`}
                >
                  <span
                    className={`shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors ${
                      selectedMcpServerIds.has(s.id)
                        ? 'bg-accent-primary border-accent-primary'
                        : 'border-border-accent hover:border-text-muted'
                    }`}
                    onClick={(e) => { e.preventDefault(); if (!locked) toggleMcpServer(s.id) }}
                  >
                    {selectedMcpServerIds.has(s.id) && <Check size={8} className="text-white" />}
                  </span>
                  <span className="text-text-secondary font-mono truncate">{s.server_name}</span>
                  {locked ? (
                    <span className="text-[8px] text-text-faint shrink-0">required</span>
                  ) : s.default_enabled ? (
                    <span className="text-[8px] text-accent-primary shrink-0">default</span>
                  ) : null}
                </label>
                )
              })}
              </div>
            </div>
          )}
        </div>
      )}

      {modelSwitchingEnabled && (
        <div className="space-y-1">
          <div className="text-[10px] text-amber-400/80 font-medium uppercase tracking-wider flex items-center gap-1">
            <span>dual model</span>
            <span className="text-[8px] bg-amber-500/10 text-amber-400 px-1 py-0.5 rounded border border-amber-500/20">exp</span>
          </div>
          <div className="flex gap-1.5">
            <select value={planModel} onChange={(e) => setPlanModel(e.target.value)} className={selectClass}>
              <option value="">plan: default</option>
              {getModelsForCli(cliType).map((m) => (
                <option key={m.id} value={m.id}>plan: {m.label}</option>
              ))}
            </select>
            <select value={executeModel} onChange={(e) => setExecuteModel(e.target.value)} className={selectClass}>
              <option value="">exec: default</option>
              {getModelsForCli(cliType).map((m) => (
                <option key={m.id} value={m.id}>exec: {m.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Toggles row */}
      <div className="flex gap-4">
        {/* Auto-approve plan toggle */}
        <label className="flex items-center gap-2 cursor-pointer">
          <span
            className={`relative inline-block w-7 h-3.5 rounded-full transition-colors ${
              autoApprovePlan ? 'bg-green-500' : 'bg-bg-tertiary border border-border-secondary'
            }`}
            onClick={() => setAutoApprovePlan(!autoApprovePlan)}
          >
            <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all ${
              autoApprovePlan ? 'left-[13px]' : 'left-0.5'
            }`} />
          </span>
          <span className="text-[10px] text-text-secondary">
            Auto-approve plans
          </span>
        </label>

        {/* Worktree toggle */}
        <label className="flex items-center gap-2 cursor-pointer">
          <span
            className={`relative inline-block w-7 h-3.5 rounded-full transition-colors ${
              worktree ? 'bg-cyan-500' : 'bg-bg-tertiary border border-border-secondary'
            }`}
            onClick={() => setWorktree(!worktree)}
          >
            <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all ${
              worktree ? 'left-[13px]' : 'left-0.5'
            }`} />
          </span>
          <span className="text-[10px] text-text-secondary">
            Worktree
          </span>
        </label>
      </div>

      {(getEffortLevelsForCli(cliType).length > 0 || outputStyles.length > 0) && (
        <div className="flex gap-1.5">
          {getEffortLevelsForCli(cliType).length > 0 && (
            <select value={effort} onChange={(e) => setEffort(e.target.value)} className={selectClass}>
              {getEffortLevelsForCli(cliType).map((e) => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
          )}
          {outputStyles.length > 0 && (
            <select value={outputStyle} onChange={(e) => setOutputStyle(e.target.value)} className={selectClass} title="Output style (token saving)">
              <option value="">inherit</option>
              {outputStyles.map((s) => (
                <option key={s.id} value={s.id} title={s.description}>{s.label}</option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className="flex gap-1.5">
        <button
          type="submit"
          className="flex-1 px-2 py-1.5 text-xs font-medium bg-accent-primary hover:bg-accent-hover text-white rounded-md transition-colors"
        >
          Create
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex-1 px-2 py-1.5 text-xs font-medium bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded-md transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

export default function Sidebar() {
  const workspaces = useStore((s) => s.workspaces)
  const sessions = useStore((s) => s.sessions)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const openTabs = useStore((s) => s.openTabs)
  const connected = useStore((s) => s.connected)
  const planWaiting = useStore((s) => s.planWaiting)
  const sessionActivity = useStore((s) => s.sessionActivity)
  const compactionState = useStore((s) => s.compactionState)
  const subagents = useStore((s) => s.subagents)
  const sidebarExpanded = useStore((s) => s.sidebarExpanded)
  const toggleSessionExpanded = useStore((s) => s.toggleSessionExpanded)
  const selectedSessionIds = useStore((s) => s.selectedSessionIds)
  const selectionWorkspaceId = useStore((s) => s.selectionWorkspaceId)
  const toggleSessionSelect = useStore((s) => s.toggleSessionSelect)
  const clearSessionSelection = useStore((s) => s.clearSessionSelection)
  const [showMergeDialog, setShowMergeDialog] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [appVersion] = useState(() => localStorage.getItem('cc-version') || '')

  // Tick every 2s so "active" dots decay when spinners stop
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 2000)
    return () => clearInterval(timer)
  }, [])

  const isActive = (id) => sessionActivity[id] && (now - sessionActivity[id]) < 5000

  const [expanded, setExpanded] = useState({})
  const [showAddWs, setShowAddWs] = useState(false)
  const [showCommanderPicker, setShowCommanderPicker] = useState(false)
  const [showTesterPicker, setShowTesterPicker] = useState(false)
  const [showDocumentorPicker, setShowDocumentorPicker] = useState(false)
  const [docAllowAllEdits, setDocAllowAllEdits] = useState(false)
  const [ctxMenu, setCtxMenu] = useState(null) // { x, y, session }
  const [newPath, setNewPath] = useState('')
  const [newSessionFor, setNewSessionFor] = useState(null)
  const [filter, setFilter] = useState('')

  // Close picker popups on outside click
  useEffect(() => {
    if (!showCommanderPicker && !showTesterPicker && !showDocumentorPicker) return
    const close = () => { setShowCommanderPicker(false); setShowTesterPicker(false); setShowDocumentorPicker(false) }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [showCommanderPicker, showTesterPicker, showDocumentorPicker])

  // Drag-reorder state
  const [wsDragIdx, setWsDragIdx] = useState(null)        // index of dragged workspace
  const [wsDropIdx, setWsDropIdx] = useState(null)        // workspace drop indicator
  const [sessDrag, setSessDrag] = useState(null)          // { wsId, idx }
  const [sessDropKey, setSessDropKey] = useState(null)    // `${wsId}:${idx}`
  const [colorPickerWs, setColorPickerWs] = useState(null) // workspace id whose color picker is open

  // Dismiss color picker on outside click
  useEffect(() => {
    if (!colorPickerWs) return
    const h = (e) => {
      if (!e.target.closest('[data-ws-color-popover]') && !e.target.closest('[data-ws-color-trigger]')) {
        setColorPickerWs(null)
      }
    }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [colorPickerWs])

  const setWorkspaceColor = async (wsId, color) => {
    try {
      const updated = await api.updateWorkspace(wsId, { color })
      useStore.getState().setWorkspaces(
        useStore.getState().workspaces.map((w) => (w.id === wsId ? { ...w, ...updated } : w))
      )
    } catch (err) {
      console.error('Failed to update workspace color:', err)
    }
    setColorPickerWs(null)
  }

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      const wsList = await api.getWorkspaces()
      useStore.getState().setWorkspaces(wsList)
      // Auto-set activeWorkspaceId if not yet set so that features like
      // skill install have a valid workspace context from the start.
      if (wsList.length > 0 && !useStore.getState().activeWorkspaceId) {
        useStore.getState().setActiveWorkspace(wsList[0].id)
      }
      const sessResults = await Promise.all(
        wsList.map((ws) => api.getSessions(ws.id).catch(() => []))
      )
      for (let i = 0; i < wsList.length; i++) {
        useStore.getState().loadSessions(sessResults[i])
        setExpanded((p) => ({ ...p, [wsList[i].id]: true }))
      }
      // Eagerly load tasks for all workspaces so the auto-oversight
      // nudge gate (useWebSocket session_idle handler) can check whether
      // an idle worker actually has an active task assigned.
      const allTasks = await api.getTasks()
      if (Array.isArray(allTasks)) useStore.getState().loadTasks(allTasks)
      // Grid templates are tiny and used the moment the user opens the layout dropdown.
      useStore.getState().loadGridTemplates()
      // Tab groups for one-click tab set switching.
      useStore.getState().loadTabGroups()
      // Prompt cache backs @prompt:<name> token expansion + the chip preview.
      useStore.getState().loadPrompts()
      // CLI profiles drive model/mode/effort dropdowns from backend data.
      api.getCliFeatures().then((data) => {
        if (data?.profiles) useStore.getState().loadCliProfiles(data.profiles)
      }).catch(() => {})
    } catch (e) {
      console.error('Failed to load data:', e)
    }
  }

  const handleAddWorkspace = async (e) => {
    e.preventDefault()
    if (!newPath.trim()) return
    try {
      const ws = await api.createWorkspace(newPath.trim())
      useStore.getState().setWorkspaces([...useStore.getState().workspaces, ws])
      setNewPath('')
      setShowAddWs(false)
      setExpanded((p) => ({ ...p, [ws.id]: true }))
    } catch (err) {
      console.error('Failed to create workspace:', err)
    }
  }

  const handleDeleteSession = async (e, sessionId) => {
    e.stopPropagation()
    try {
      await api.deleteSession(sessionId)
      useStore.getState().removeSession(sessionId)
    } catch (err) {
      console.error('Failed to delete session:', err)
    }
  }

  const handleClickSession = (session) => {
    useStore.getState().setActiveWorkspace(session.workspace_id)
    if (!openTabs.includes(session.id)) {
      useStore.getState().openSession(session.id)
    } else {
      useStore.getState().setActiveSession(session.id)
    }
  }

  // Sort by server-assigned `order_index` (0 = unset, fall back to natural order from the API).
  const sortedByOrderIndex = (items) => {
    return [...items].sort((a, b) => {
      const ai = a.order_index || 0
      const bi = b.order_index || 0
      if (ai === 0 && bi === 0) return 0
      if (ai === 0) return 1
      if (bi === 0) return -1
      return ai - bi
    })
  }

  const orderedWorkspaces = sortedByOrderIndex(workspaces)

  const workspaceSessions = (wsId) => {
    const list = Object.values(sessions).filter((s) =>
      s.workspace_id === wsId &&
      (!filter || s.name.toLowerCase().includes(filter.toLowerCase()) || (s.model || '').toLowerCase().includes(filter.toLowerCase()))
    )
    return sortedByOrderIndex(list)
  }

  return (
    <aside className="w-72 bg-bg-secondary border-r border-border-primary flex flex-col shrink-0">
      {/* Header */}
      <div className="px-3 pt-3 pb-2.5 border-b border-border-primary">
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-1.5">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="30 35 140 135" width="14" height="14">
              <g transform="translate(100,95)"><g transform="translate(-60,-55)">
                <path d="M0,0 L24,0 L60,81.6 L96,0 L120,0 L60,120 Z" fill="#00f0ff" opacity="0.78" transform="translate(-8.4,0) rotate(-7,60,120)"/>
                <path d="M0,0 L24,0 L60,81.6 L96,0 L120,0 L60,120 Z" fill="#8b5cf6" opacity="0.78"/>
                <path d="M0,0 L24,0 L60,81.6 L96,0 L120,0 L60,120 Z" fill="#d946ef" opacity="0.78" transform="translate(8.4,0) rotate(7,60,120)"/>
                <circle cx="60" cy="120" r="2.5" fill="#fff" opacity="0.9"/>
              </g></g>
            </svg>
            <span className="text-[11px] font-extrabold font-mono text-text-secondary uppercase tracking-[0.15em]">IVE</span>
            {appVersion && <span className="text-[9px] font-mono text-text-faint/50">v{appVersion}</span>}
          </div>
          <div className="flex items-center gap-0.5">
            <MailboxPill position="below" />
            <button
              onClick={() => setShowAddWs(!showAddWs)}
              className="p-1 rounded-md hover:bg-bg-hover text-text-muted hover:text-text-secondary transition-colors"
            >
              <Plus size={15} />
            </button>
          </div>
        </div>
        <div className="relative">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-faint" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter sessions..."
            className="w-full pl-6 pr-2 py-1.5 text-xs bg-bg-inset border border-border-secondary rounded-md text-text-secondary placeholder-text-faint focus:outline-none focus:border-border-accent ide-focus-ring font-mono transition-colors"
          />
        </div>
      </div>

      {showAddWs && (
        <form onSubmit={handleAddWorkspace} className="px-3 py-2.5 border-b border-border-primary">
          <div className="flex gap-1.5">
            <input
              type="text"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              placeholder="/path/to/project"
              className="flex-1 min-w-0 px-2 py-1.5 text-xs bg-bg-inset border border-border-primary rounded-md text-zinc-300 placeholder-text-faint focus:outline-none focus:border-accent-primary/50 ide-focus-ring transition-colors"
              autoFocus
            />
            <button
              type="button"
              onClick={() => {
                api.browseFolder().then(({ path }) => {
                  if (path) setNewPath(path)
                }).catch(() => {})
              }}
              className="px-2 py-1.5 text-xs bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded-md border border-border-primary transition-colors"
              title="Browse for folder"
            >
              <FolderOpen size={13} />
            </button>
          </div>
          <div className="flex gap-1.5 mt-2">
            <button type="submit" className="flex-1 px-2 py-1.5 text-xs font-medium bg-accent-primary hover:bg-accent-hover text-white rounded-md transition-colors">Add</button>
            <button type="button" onClick={() => setShowAddWs(false)} className="flex-1 px-2 py-1.5 text-xs font-medium bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded-md transition-colors">Cancel</button>
          </div>
        </form>
      )}

      <div className="flex-1 overflow-y-auto min-h-0">
        {orderedWorkspaces.map((ws, wsIdx) => {
          const wsColor = getWorkspaceColor(ws)
          const wsIsDragOver = wsDropIdx === wsIdx && wsDragIdx !== wsIdx
          return (
          <div
            key={ws.id}
            onDragOver={(e) => {
              // Only react to workspace-id drags here, not session drags
              if (e.dataTransfer.types.includes('workspace-id')) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setWsDropIdx(wsIdx)
              }
            }}
            onDragLeave={(e) => {
              if (e.dataTransfer.types.includes('workspace-id')) setWsDropIdx(null)
            }}
            onDrop={(e) => {
              if (e.dataTransfer.types.includes('workspace-id')) {
                e.preventDefault()
                const fromId = e.dataTransfer.getData('workspace-id')
                const currentIds = orderedWorkspaces.map((w) => w.id)
                const fromIdx = currentIds.indexOf(fromId)
                if (fromIdx !== -1 && fromIdx !== wsIdx) {
                  // Compute the new full order and ship it to the store/server
                  const next = [...currentIds]
                  const [moved] = next.splice(fromIdx, 1)
                  next.splice(wsIdx, 0, moved)
                  useStore.getState().reorderWorkspaces(next)
                }
                setWsDragIdx(null)
                setWsDropIdx(null)
              }
            }}
            className={`mx-1.5 my-1 rounded-md relative ${wsIsDragOver ? 'bg-accent-subtle/40' : ''}`}
            style={{
              border: `1px solid ${wsColor}33`,
              borderTop: wsIsDragOver ? `2px solid ${wsColor}` : `1px solid ${wsColor}33`,
            }}
          >
            <button
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('workspace-id', ws.id)
                e.dataTransfer.effectAllowed = 'move'
                setWsDragIdx(wsIdx)
              }}
              onDragEnd={() => { setWsDragIdx(null); setWsDropIdx(null) }}
              onClick={() => {
                setExpanded((p) => ({ ...p, [ws.id]: !p[ws.id] }))
                useStore.getState().setActiveWorkspace(ws.id)
              }}
              className="group w-full flex items-center gap-1.5 px-3 py-2 text-xs hover:bg-bg-hover text-left transition-colors cursor-grab active:cursor-grabbing"
              title="Drag to reorder workspace"
            >
              <GripVertical size={11} className="shrink-0 text-text-faint/40 opacity-0 group-hover:opacity-100 transition-opacity" />
              {expanded[ws.id] ? <ChevronDown size={12} className="shrink-0 text-text-faint" /> : <ChevronRight size={12} className="shrink-0 text-text-faint" />}
              <FolderOpen size={12} className="shrink-0" style={{ color: wsColor }} />
              <span className="truncate text-text-primary font-medium flex-1 min-w-0">{ws.name}</span>
              <span onClick={(e) => e.stopPropagation()}>
                <MailboxPill position="below" workspaceId={ws.id} compact />
              </span>
              {/* Color picker swatch (uses span so it can live inside the button) */}
              <span
                data-ws-color-trigger
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation()
                  setColorPickerWs(colorPickerWs === ws.id ? null : ws.id)
                }}
                className="shrink-0 w-3 h-3 rounded-full cursor-pointer hover:ring-2 hover:ring-white/20 transition-all"
                style={{ backgroundColor: wsColor, border: '1px solid rgba(255,255,255,0.15)' }}
                title="Change project color"
              />
              <Trash2
                size={13}
                className="shrink-0 box-content p-1 -mr-1 opacity-0 group-hover:opacity-100 text-text-faint hover:text-red-400 hover:bg-red-500/10 rounded-md transition-all"
                onClick={async (e) => {
                  e.stopPropagation()
                  if (confirm(`Delete workspace "${ws.name}"? Sessions will be removed.`)) {
                    await api.deleteWorkspace(ws.id)
                    useStore.getState().setWorkspaces(
                      useStore.getState().workspaces.filter((w) => w.id !== ws.id)
                    )
                  }
                }}
              />
            </button>

            {colorPickerWs === ws.id && (
              <div
                data-ws-color-popover
                className="absolute right-2 top-9 z-50 ide-panel p-2 scale-in"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="text-[9px] text-text-faint font-medium uppercase tracking-wider mb-1.5 px-0.5">Project color</div>
                <div className="grid grid-cols-5 gap-1.5">
                  {WORKSPACE_PALETTE.map((c) => (
                    <button
                      key={c}
                      onClick={() => setWorkspaceColor(ws.id, c)}
                      className={`w-5 h-5 rounded-full transition-transform hover:scale-110 ${ws.color === c ? 'ring-2 ring-white/60' : ''}`}
                      style={{ backgroundColor: c, border: '1px solid rgba(255,255,255,0.15)' }}
                      title={c}
                    />
                  ))}
                </div>
                <button
                  onClick={() => setWorkspaceColor(ws.id, null)}
                  className="mt-2 w-full text-[10px] text-text-faint hover:text-text-secondary py-1 rounded hover:bg-bg-hover transition-colors font-mono"
                >
                  auto (hash)
                </button>
              </div>
            )}

            {expanded[ws.id] && (
              <div className="relative">
                {/* Workspace settings shortcut — shows key info inline */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    useStore.setState({ activeWorkspaceId: ws.id })
                    window.dispatchEvent(new CustomEvent('open-workspace-settings', { detail: { workspaceId: ws.id } }))
                  }}
                  className="flex items-center gap-1.5 w-full px-3 py-1.5 mb-0.5 text-[10px] text-text-faint hover:text-text-secondary hover:bg-bg-hover transition-colors group/ws-btn"
                  title="Open workspace settings (⌘K → Workspace Settings)"
                >
                  <span className="font-mono text-[9px]">⚙</span>
                  <span className="flex items-center gap-1.5 ml-auto">
                    <span className={`px-1 py-0.5 rounded text-[9px] font-mono border ${
                      ws.human_oversight === 'full_auto'
                        ? 'border-emerald-500/25 text-emerald-400/80 bg-emerald-500/10'
                        : ws.human_oversight === 'approve_all'
                          ? 'border-amber-500/25 text-amber-400/80 bg-amber-500/10'
                          : 'border-border-secondary text-text-faint'
                    }`}>
                      {ws.human_oversight === 'full_auto' ? 'auto' : ws.human_oversight === 'approve_all' ? 'all' : 'plans'}
                    </span>
                    {ws.coordination_namespace && (
                      <span className="px-1 py-0.5 rounded text-[9px] font-mono border border-purple-500/25 text-purple-400/80 bg-purple-500/10" title={`Coordination: ${ws.coordination_namespace}`}>
                        coord
                      </span>
                    )}
                    {ws.research_model && (
                      <span className="text-[9px] font-mono text-text-faint">{ws.research_model}</span>
                    )}
                  </span>
                </button>
                {workspaceSessions(ws.id).map((session, sIdx) => {
                  const dropKey = `${ws.id}:${sIdx}`
                  const isSessDragOver = sessDropKey === dropKey && !(sessDrag?.wsId === ws.id && sessDrag?.idx === sIdx)
                  const sessAgents = Object.values(subagents[session.id] || {})
                  const hasAgents = sessAgents.length > 0
                  const isExpanded = !!sidebarExpanded[session.id]
                  const runningAgents = sessAgents.filter((a) => a.status === 'running').length
                  const isChecked = selectedSessionIds.includes(session.id)
                  const hasSelection = selectedSessionIds.length > 0
                  const isOtherWs = selectionWorkspaceId && session.workspace_id !== selectionWorkspaceId
                  return (
                  <div key={session.id}>
                  <button
                    onClick={() => handleClickSession(session)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setCtxMenu({ x: e.clientX, y: e.clientY, session })
                    }}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('session-id', session.id)
                      e.dataTransfer.setData('reorder-from-ws', ws.id)
                      e.dataTransfer.setData('reorder-from-idx', String(sIdx))
                      e.dataTransfer.effectAllowed = 'copyMove'
                      setSessDrag({ wsId: ws.id, idx: sIdx })
                    }}
                    onDragOver={(e) => {
                      // Reorder hint only when dragging another session within same ws
                      if (e.dataTransfer.types.includes('reorder-from-ws')) {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        setSessDropKey(dropKey)
                      }
                    }}
                    onDragLeave={(e) => {
                      if (e.dataTransfer.types.includes('reorder-from-ws')) setSessDropKey(null)
                    }}
                    onDrop={(e) => {
                      if (e.dataTransfer.types.includes('reorder-from-ws')) {
                        e.preventDefault()
                        e.stopPropagation() // don't bubble up to terminal split-handler
                        const fromWs = e.dataTransfer.getData('reorder-from-ws')
                        const fromIdxRaw = e.dataTransfer.getData('reorder-from-idx')
                        const fromIdx = parseInt(fromIdxRaw, 10)
                        if (fromWs === ws.id && !Number.isNaN(fromIdx) && fromIdx !== sIdx) {
                          const currentIds = workspaceSessions(ws.id).map((s) => s.id)
                          const next = [...currentIds]
                          const [moved] = next.splice(fromIdx, 1)
                          next.splice(sIdx, 0, moved)
                          useStore.getState().reorderSessionsInWorkspace(ws.id, next)
                        }
                        setSessDrag(null)
                        setSessDropKey(null)
                      }
                    }}
                    onDragEnd={() => { setSessDrag(null); setSessDropKey(null) }}
                    className={`group w-full flex items-center gap-1.5 pl-3 pr-2 py-1.5 text-xs text-left transition-all cursor-grab active:cursor-grabbing ${
                      activeSessionId === session.id
                        ? 'bg-bg-hover text-text-primary border-l-2'
                        : 'text-text-secondary hover:bg-bg-hover/50 border-l-2 border-l-transparent'
                    } ${isSessDragOver ? 'bg-accent-subtle/40' : ''}`}
                    style={activeSessionId === session.id ? { borderLeftColor: wsColor } : undefined}
                    title="Click to open · Drag onto a sibling to reorder · Drag to terminal area to split"
                  >
                    {/* Merge checkbox — visible on hover or when any session is selected */}
                    <span
                      onClick={(e) => { e.stopPropagation(); if (!isOtherWs) toggleSessionSelect(session.id) }}
                      className={`shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-all cursor-pointer ${
                        isChecked
                          ? 'bg-accent-primary border-accent-primary'
                          : isOtherWs
                            ? 'border-border-secondary opacity-20 cursor-not-allowed'
                            : hasSelection
                              ? 'border-border-accent hover:border-text-muted'
                              : 'border-border-accent hover:border-text-muted opacity-0 group-hover:opacity-100'
                      }`}
                      title={isOtherWs ? 'Can only select sessions from the same workspace' : 'Select for merge'}
                    >
                      {isChecked && <Check size={8} className="text-white" />}
                    </span>
                    {hasAgents ? (
                      <span
                        onClick={(e) => { e.stopPropagation(); toggleSessionExpanded(session.id) }}
                        className="shrink-0 text-text-faint hover:text-text-secondary p-0.5 -ml-0.5 rounded cursor-pointer"
                        title={`${sessAgents.length} sub-agent${sessAgents.length !== 1 ? 's' : ''} (${runningAgents} running)`}
                      >
                        {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                      </span>
                    ) : (
                      <span className="shrink-0 w-[14px]" />
                    )}
                    {session.session_type === 'commander'
                      ? <Crown size={11} className="shrink-0 text-amber-400" />
                      : session.session_type === 'tester'
                        ? <FlaskConical size={11} className="shrink-0 text-cyan-400" />
                        : session.session_type === 'documentor'
                          ? <BookOpenCheck size={11} className="shrink-0 text-emerald-400" />
                          : <MessageSquare size={11} className="shrink-0 text-text-faint" />
                    }
                    <span className="truncate flex-1 min-w-0">{session.name}</span>
                    {runningAgents > 0 && (
                      <span className="shrink-0 text-[9px] font-mono text-green-400 bg-green-500/10 px-1 rounded">
                        {runningAgents}
                      </span>
                    )}
                    <span className="text-text-faint text-[10px] font-mono">{session.model}</span>
                    {(() => {
                      const tags = Array.isArray(session.tags) ? session.tags
                        : typeof session.tags === 'string' ? (() => { try { return JSON.parse(session.tags) } catch { return [] } })()
                        : []
                      return tags.length > 0 ? (
                        <span className="text-[8px] text-indigo-400 font-mono truncate max-w-[60px]" title={tags.join(', ')}>
                          {tags[0]}{tags.length > 1 ? `+${tags.length - 1}` : ''}
                        </span>
                      ) : null
                    })()}
                    {session.is_external ? <span className="text-teal-400/60 text-[9px] font-mono">ext</span> : null}
                    {session.branch_label && (
                      <span
                        className="shrink-0 text-[9px] font-mono px-1 rounded border border-purple-500/25 text-purple-400/80 bg-purple-500/10"
                        title={`Branch group ${session.branch_label} — linked session`}
                      >
                        {session.branch_label}
                      </span>
                    )}
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        compactionState[session.id]?.status === 'compacting'
                          ? 'bg-yellow-400 animate-pulse'
                          : compactionState[session.id]?.status === 'compacted'
                            ? 'bg-yellow-400'
                            : compactionState[session.id]?.status === 'warning'
                              ? 'bg-orange-400'
                              : planWaiting[session.id]
                                ? 'bg-amber-400 animate-subtle-pulse'
                                : isActive(session.id)
                                  ? 'bg-red-400 animate-subtle-pulse'
                                  : session.status === 'running'
                                    ? 'bg-green-400'
                                    : session.status === 'replaying'
                                      ? 'bg-yellow-400 animate-subtle-pulse'
                                      : session.status === 'exited'
                                        ? 'bg-red-400'
                                        : 'bg-zinc-600'
                      }`}
                      title={
                        compactionState[session.id]?.status === 'compacting'
                          ? 'Auto-compacting context...'
                          : compactionState[session.id]?.status === 'compacted'
                            ? 'Context just auto-compacted'
                            : compactionState[session.id]?.status === 'warning'
                              ? `Only ${compactionState[session.id].percent_left}% context left until auto-compact`
                              : planWaiting[session.id]
                                ? 'Needs your input'
                                : isActive(session.id)
                                  ? 'Working...'
                                  : session.status
                      }
                    />
                    <Trash2
                      size={12}
                      className="shrink-0 box-content p-1 -mr-1 opacity-0 group-hover:opacity-100 text-text-faint hover:text-red-400 hover:bg-red-500/10 rounded-md transition-all"
                      onClick={(e) => handleDeleteSession(e, session.id)}
                    />
                  </button>
                  {isExpanded && hasAgents && (
                    <div className="pl-7 pr-2 pb-1 space-y-0.5 bg-bg-primary/30">
                      {sessAgents.map((agent) => (
                        <button
                          key={agent.id}
                          onClick={(e) => {
                            e.stopPropagation()
                            useStore.getState().setViewingSubagent(session.id, agent.id)
                          }}
                          className="w-full flex items-center gap-1.5 py-1 text-[10px] font-mono text-left rounded-sm hover:bg-bg-hover/60 transition-colors cursor-pointer group/agent"
                          title={`View ${agent.type} output`}
                        >
                          <span className={`w-1 h-1 rounded-full shrink-0 ${
                            agent.status === 'running' ? 'bg-green-400 animate-subtle-pulse' : 'bg-zinc-600'
                          }`} />
                          <span className="text-text-secondary shrink-0">{agent.type}</span>
                          {agent.tools.length > 0 && (
                            <span className="text-text-faint truncate">
                              · {agent.tools[agent.tools.length - 1].tool}
                            </span>
                          )}
                          {agent.status === 'completed' && agent.result && (
                            <span className="text-text-faint truncate flex-1 min-w-0">
                              → {agent.result}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                  </div>
                  )
                })}

                {newSessionFor === ws.id ? (
                  <NewSessionForm workspaceId={ws.id} onClose={() => setNewSessionFor(null)} />
                ) : (
                  <button
                    onClick={() => setNewSessionFor(ws.id)}
                    className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-faint hover:text-text-secondary hover:bg-bg-hover/50 transition-colors border-l-2 border-l-transparent"
                  >
                    <Plus size={11} />
                    New Session
                  </button>
                )}

              </div>
            )}
          </div>
          )
        })}

        {workspaces.length === 0 && (
          <div className="p-6 text-xs text-text-faint text-center">
            Add a workspace to get started
          </div>
        )}
      </div>

      {/* Merge bar — shown when 2+ sessions are selected */}
      {selectedSessionIds.length >= 2 && (
        <div className="px-2 py-2 border-t border-accent-primary/30 bg-accent-subtle/30 flex items-center gap-2">
          <GitMerge size={13} className="shrink-0 text-accent-primary" />
          <span className="text-xs text-text-secondary flex-1 min-w-0 truncate">
            {selectedSessionIds.length} sessions selected
          </span>
          <button
            onClick={() => clearSessionSelection()}
            className="text-[10px] text-text-faint hover:text-text-secondary transition-colors"
          >
            clear
          </button>
          <button
            onClick={() => setShowMergeDialog(true)}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-accent-primary hover:bg-accent-hover text-white rounded-md transition-colors"
          >
            <GitMerge size={11} />
            Merge
          </button>
        </div>
      )}

      {/* Merge dialog */}
      {showMergeDialog && (
        <MergeDialog onClose={() => setShowMergeDialog(false)} />
      )}

      {/* Quick action buttons */}
      <div className="px-2 py-1.5 border-t border-border-primary flex gap-1">
        <div className="flex-1 relative">
          <button
            onClick={() => { setShowCommanderPicker((s) => !s); setShowTesterPicker(false); setShowDocumentorPicker(false) }}
            className="w-full flex items-center justify-center gap-1 px-1.5 py-1 text-[11px] text-text-faint hover:text-amber-400 hover:bg-bg-hover rounded transition-colors"
            title="Start Commander (orchestrator agent)"
          >
            <Crown size={11} />
            Commander
          </button>
          {showCommanderPicker && (
            <div
              className="absolute bottom-full left-0 mb-1 ide-panel p-2 z-50 space-y-1 scale-in min-w-[180px]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-[10px] text-text-faint font-medium uppercase tracking-wider px-1 mb-1">Create Commander with:</div>
              {[
                { cli: 'claude', model: 'opus', label: 'Claude Opus', style: 'text-indigo-400 border-indigo-500/25 hover:bg-accent-subtle' },
                { cli: 'claude', model: 'sonnet', label: 'Claude Sonnet', style: 'text-indigo-400 border-indigo-500/25 hover:bg-accent-subtle' },
                { cli: 'gemini', model: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', style: 'text-blue-400 border-blue-500/25 hover:bg-blue-500/10' },
                { cli: 'gemini', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', style: 'text-blue-400 border-blue-500/25 hover:bg-blue-500/10' },
              ].map((opt) => (
                <button
                  key={`${opt.cli}-${opt.model}`}
                  onClick={async () => {
                    setShowCommanderPicker(false)
                    const wsId = useStore.getState().activeWorkspaceId || workspaces[0]?.id
                    if (wsId) {
                      try {
                        const s = await api.startCommander(wsId, { cli_type: opt.cli, model: opt.model })
                        useStore.getState().addSession(s)
                      } catch (e) { console.error(e) }
                    }
                  }}
                  className={`w-full text-left px-2 py-1.5 text-xs font-medium border rounded-md transition-colors ${opt.style}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex-1 relative">
          <button
            onClick={() => { setShowTesterPicker((s) => !s); setShowCommanderPicker(false); setShowDocumentorPicker(false) }}
            className="w-full flex items-center justify-center gap-1 px-1.5 py-1 text-[11px] text-text-faint hover:text-cyan-400 hover:bg-bg-hover rounded transition-colors"
            title="Start Testing Agent (Playwright, read-only)"
          >
            <FlaskConical size={11} />
            Tester
          </button>
          {showTesterPicker && (
            <div
              className="absolute bottom-full left-0 mb-1 ide-panel p-2 z-50 space-y-1 scale-in min-w-[180px]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-[10px] text-text-faint font-medium uppercase tracking-wider px-1 mb-1">Create Testing Agent with:</div>
              {[
                { cli: 'claude', model: 'sonnet', label: 'Claude Sonnet', style: 'text-indigo-400 border-indigo-500/25 hover:bg-accent-subtle' },
                { cli: 'claude', model: 'opus', label: 'Claude Opus', style: 'text-indigo-400 border-indigo-500/25 hover:bg-accent-subtle' },
                { cli: 'gemini', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', style: 'text-blue-400 border-blue-500/25 hover:bg-blue-500/10' },
              ].map((opt) => (
                <button
                  key={`tester-${opt.cli}-${opt.model}`}
                  onClick={async () => {
                    setShowTesterPicker(false)
                    const wsId = useStore.getState().activeWorkspaceId || workspaces[0]?.id
                    if (wsId) {
                      try {
                        const s = await api.startTester(wsId, { cli_type: opt.cli, model: opt.model })
                        useStore.getState().addSession(s)
                      } catch (e) { console.error(e) }
                    }
                  }}
                  className={`w-full text-left px-2 py-1.5 text-xs font-medium border rounded-md transition-colors ${opt.style}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex-1 relative">
          <button
            onClick={() => { setShowDocumentorPicker((s) => !s); setShowCommanderPicker(false); setShowTesterPicker(false) }}
            className="w-full flex items-center justify-center gap-1 px-1.5 py-1 text-[11px] text-text-faint hover:text-emerald-400 hover:bg-bg-hover rounded transition-colors"
            title="Start Documentor (documentation agent)"
          >
            <BookOpenCheck size={11} />
            Docs
          </button>
          {showDocumentorPicker && (
            <div
              className="absolute bottom-full left-0 mb-1 ide-panel p-2 z-50 space-y-1 scale-in min-w-[180px]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-[10px] text-text-faint font-medium uppercase tracking-wider px-1 mb-1">Create Documentor with:</div>
              <label className="flex items-center gap-1.5 px-1 py-1 text-[10px] text-text-faint cursor-pointer hover:text-text-secondary">
                <input
                  type="checkbox"
                  checked={docAllowAllEdits}
                  onChange={(e) => setDocAllowAllEdits(e.target.checked)}
                  className="rounded border-border-accent w-3 h-3"
                />
                Allow editing all files (not just docs/)
              </label>
              {[
                { cli: 'claude', model: 'sonnet', label: 'Claude Sonnet', style: 'text-indigo-400 border-indigo-500/25 hover:bg-accent-subtle' },
                { cli: 'claude', model: 'opus', label: 'Claude Opus', style: 'text-indigo-400 border-indigo-500/25 hover:bg-accent-subtle' },
                { cli: 'gemini', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', style: 'text-blue-400 border-blue-500/25 hover:bg-blue-500/10' },
              ].map((opt) => (
                <button
                  key={`doc-${opt.cli}-${opt.model}`}
                  onClick={async () => {
                    setShowDocumentorPicker(false)
                    const wsId = useStore.getState().activeWorkspaceId || workspaces[0]?.id
                    if (wsId) {
                      try {
                        const s = await api.startDocumentor(wsId, { cli_type: opt.cli, model: opt.model, allow_all_edits: docAllowAllEdits })
                        useStore.getState().addSession(s)
                        // Auto-send kickoff prompt after PTY boots
                        setTimeout(() => {
                          sendTerminalCommand(s.id, 'Begin documenting this project now. Start with get_knowledge_base() to understand the product, then scaffold_docs() and systematically document each feature with screenshots and GIF demos. Build the site when done.')
                        }, 3000)
                      } catch (e) { console.error(e) }
                    }
                  }}
                  className={`w-full text-left px-2 py-1.5 text-xs font-medium border rounded-md transition-colors ${opt.style}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="px-2 py-1 border-t border-border-primary flex gap-1">
        <button
          onClick={() => {
            window.dispatchEvent(new CustomEvent('open-panel', { detail: 'feature-board' }))
          }}
          className="flex-1 flex items-center justify-center gap-1 px-1.5 py-1 text-[11px] text-text-faint hover:text-text-secondary hover:bg-bg-hover rounded transition-colors"
          title="Feature Board (⌘B)"
        >
          <Kanban size={11} />
          Board
        </button>
        <button
          onClick={() => {
            window.dispatchEvent(new CustomEvent('open-panel', { detail: 'pipeline-editor' }))
          }}
          className="flex-1 flex items-center justify-center gap-1 px-1.5 py-1 text-[11px] text-text-faint hover:text-text-secondary hover:bg-bg-hover rounded transition-colors"
          title="Pipeline Editor (⌘⇧L)"
        >
          <GitCompareArrows size={11} />
          Pipelines
        </button>
        <button
          onClick={() => {
            window.dispatchEvent(new CustomEvent('open-panel', { detail: 'docs-panel' }))
          }}
          className="flex-1 flex items-center justify-center gap-1 px-1.5 py-1 text-[11px] text-text-faint hover:text-emerald-400 hover:bg-bg-hover rounded transition-colors"
          title="Documentation Dashboard"
        >
          <FileText size={11} />
          Docs Hub
        </button>
      </div>

      {/* Footer status + shortcuts */}
      <div className="px-3 py-2 border-t border-border-secondary text-[10px] text-text-faint leading-relaxed">
        <div className="flex items-center gap-1.5 mb-1">
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="font-medium">{connected ? 'connected' : 'disconnected'}</span>
        </div>
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-text-faint/70">
          <span>⌘K cmd</span>
          <span>⌘N new</span>
          <span>⌘W close</span>
          <span>⌘1-9 tabs</span>
          <span>⌘B board</span>
          <span>⌘D split</span>
          <span>⌘M all</span>
          <span>⌘T tree</span>
          <span>Esc close</span>
        </div>
      </div>

      {/* Session context menu */}
      {ctxMenu && (
        <SessionContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          session={ctxMenu.session}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </aside>
  )
}
