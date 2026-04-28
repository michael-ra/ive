import { useState, useEffect, useRef, useCallback } from 'react'
import { FolderOpen, X, Save, ChevronDown, ChevronRight, Check, GitBranch, MessageSquare, Shield, Brain, ExternalLink, Monitor, Play, Users, RotateCcw, Layers, Plus, Trash2, Link, BookOpen } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import { MODELS, GEMINI_MODELS, getWorkspaceColor, WORKSPACE_PALETTE } from '../../lib/constants'

const OVERSIGHT_OPTIONS = [
  { value: 'full_auto', label: 'Auto', desc: 'Commander decides everything autonomously' },
  { value: 'approve_plans', label: 'Plans', desc: 'Approve plans, rest is auto' },
  { value: 'approve_all', label: 'All', desc: 'Approve every major action' },
]

const TESTER_MODE_OPTIONS = [
  { value: 'direct', label: 'Direct', desc: 'Tester runs tests itself with Playwright' },
  { value: 'delegated', label: 'Delegated', desc: 'Tester spawns test-worker sessions for parallel execution' },
]

const RESEARCH_MODELS = [
  { group: 'Claude', items: MODELS },
  { group: 'Gemini', items: GEMINI_MODELS },
]

export default function WorkspaceSettingsPanel({ onClose, initialWorkspaceId }) {
  const workspaces = useStore((s) => s.workspaces)
  const sessions = useStore((s) => s.sessions)
  const [expandedId, setExpandedId] = useState(initialWorkspaceId || null)
  const [forms, setForms] = useState({})
  const [savingId, setSavingId] = useState(null)
  const [savedId, setSavedId] = useState(null)
  const [coordEnabled, setCoordEnabled] = useState(false)
  const scrollRef = useRef(null)
  const itemRefs = useRef({})

  // Check coordination flag
  useEffect(() => {
    api.getAppSetting('experimental_myelin_coordination')
      .then((r) => setCoordEnabled(r?.value === 'on'))
      .catch(() => {})
  }, [])

  // Init form state for all workspaces
  useEffect(() => {
    const f = {}
    for (const ws of workspaces) {
      f[ws.id] = {
        name: ws.name || '',
        human_oversight: ws.human_oversight || 'approve_plans',
        tester_mode: ws.tester_mode || 'direct',
        research_model: ws.research_model || '',
        research_llm_url: ws.research_llm_url || '',
        preview_url: ws.preview_url || '',
        coordination_namespace: ws.coordination_namespace || '',
        color: ws.color || null,
        default_worktree: ws.default_worktree || 0,
        comms_enabled: ws.comms_enabled || 0,
        coordination_enabled: ws.coordination_enabled || 0,
        context_sharing_enabled: ws.context_sharing_enabled || 0,
        native_terminals_enabled: ws.native_terminals_enabled || 0,
        auto_register_terminals: ws.auto_register_terminals || 0,
        auto_exec_enabled: ws.auto_exec_enabled || 0,
        pipeline_enabled: ws.pipeline_enabled || 0,
        task_dependencies_enabled: ws.task_dependencies_enabled || 0,
        auto_knowledge_enabled: ws.auto_knowledge_enabled || 0,
        commander_max_workers: ws.commander_max_workers || 3,
        tester_max_workers: ws.tester_max_workers || 2,
        research_max_iterations: ws.research_max_iterations || '',
      }
    }
    setForms(f)
  }, [workspaces])

  // Scroll to initial workspace
  useEffect(() => {
    if (initialWorkspaceId && itemRefs.current[initialWorkspaceId]) {
      setTimeout(() => {
        itemRefs.current[initialWorkspaceId]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
    }
  }, [initialWorkspaceId])

  const updateField = (wsId, key, value) => {
    setForms((f) => ({ ...f, [wsId]: { ...f[wsId], [key]: value } }))
  }

  const saveWorkspace = async (wsId) => {
    const form = forms[wsId]
    if (!form) return
    setSavingId(wsId)
    try {
      const payload = { ...form }
      for (const k of ['research_model', 'research_llm_url', 'preview_url', 'coordination_namespace', 'color', 'research_max_iterations']) {
        if (!payload[k]) payload[k] = null
      }
      const updated = await api.updateWorkspace(wsId, payload)
      useStore.getState().setWorkspaces(
        useStore.getState().workspaces.map((w) =>
          w.id === wsId ? { ...w, ...updated } : w
        )
      )
      setSavedId(wsId)
      setTimeout(() => setSavedId(null), 1500)
    } finally {
      setSavingId(null)
    }
  }

  const sessionCount = (wsId) =>
    Object.values(sessions).filter((s) => s.workspace_id === wsId).length

  const runningCount = (wsId) =>
    Object.values(sessions).filter((s) => s.workspace_id === wsId && s.status === 'running').length

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[6vh] bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[680px] max-h-[85vh] ide-panel overflow-hidden scale-in flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary">
          <FolderOpen size={14} className="text-accent-primary" />
          <span className="text-xs text-text-secondary font-medium">Workspace Settings</span>
          <span className="text-[10px] text-emerald-400/70 px-1.5 py-0.5 bg-emerald-500/8 rounded border border-emerald-500/15">Per workspace</span>
          <span className="text-[10px] text-text-faint font-mono">
            {workspaces.length} workspace{workspaces.length !== 1 ? 's' : ''}
          </span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Workspace list */}
        <div className="flex-1 overflow-y-auto" ref={scrollRef}>
          {workspaces.length === 0 ? (
            <div className="px-4 py-10 text-xs text-text-faint text-center">
              No workspaces configured.
            </div>
          ) : (
            workspaces.map((ws) => {
              const isExpanded = expandedId === ws.id
              const form = forms[ws.id] || {}
              const wsColor = getWorkspaceColor(ws)
              const sessions_n = sessionCount(ws.id)
              const running_n = runningCount(ws.id)

              return (
                <div
                  key={ws.id}
                  ref={(el) => { itemRefs.current[ws.id] = el }}
                  className={`border-b border-border-secondary ${
                    isExpanded ? 'bg-bg-secondary/30' : ''
                  }`}
                >
                  {/* Workspace row */}
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : ws.id)}
                    className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left hover:bg-bg-hover transition-colors"
                  >
                    {isExpanded
                      ? <ChevronDown size={12} className="text-text-faint shrink-0" />
                      : <ChevronRight size={12} className="text-text-faint shrink-0" />
                    }
                    <div
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: wsColor }}
                    />
                    <span className="text-xs text-text-primary font-medium truncate">
                      {ws.name}
                    </span>
                    <span className="text-[10px] text-text-faint font-mono truncate max-w-[180px]">
                      {ws.path}
                    </span>
                    <div className="flex-1" />
                    {/* Inline badges */}
                    <span className="flex items-center gap-1.5">
                      <span className={`px-1 py-0.5 rounded text-[9px] font-mono border ${
                        (ws.human_oversight || 'approve_plans') === 'full_auto'
                          ? 'border-emerald-500/25 text-emerald-400/80 bg-emerald-500/10'
                          : (ws.human_oversight || 'approve_plans') === 'approve_all'
                            ? 'border-amber-500/25 text-amber-400/80 bg-amber-500/10'
                            : 'border-border-secondary text-text-faint'
                      }`}>
                        {(ws.human_oversight || 'approve_plans') === 'full_auto' ? 'auto'
                          : ws.human_oversight === 'approve_all' ? 'all' : 'plans'}
                      </span>
                      {ws.default_worktree ? (
                        <span className="px-1 py-0.5 rounded text-[9px] font-mono border border-cyan-500/25 text-cyan-400/80 bg-cyan-500/10">
                          wt
                        </span>
                      ) : null}
                      {ws.native_terminals_enabled ? (
                        <span className="px-1 py-0.5 rounded text-[9px] font-mono border border-teal-500/25 text-teal-400/80 bg-teal-500/10">
                          native
                        </span>
                      ) : null}
                      {ws.coordination_namespace && (
                        <span className="px-1 py-0.5 rounded text-[9px] font-mono border border-purple-500/25 text-purple-400/80 bg-purple-500/10">
                          coord
                        </span>
                      )}
                      {ws.auto_exec_enabled ? (
                        <span className="px-1 py-0.5 rounded text-[9px] font-mono border border-emerald-500/25 text-emerald-400/80 bg-emerald-500/10">
                          auto
                        </span>
                      ) : null}
                      {ws.pipeline_enabled ? (
                        <span className="px-1 py-0.5 rounded text-[9px] font-mono border border-cyan-500/25 text-cyan-400/80 bg-cyan-500/10">
                          pipeline
                        </span>
                      ) : null}
                      <span className="text-[9px] text-text-faint font-mono">
                        {sessions_n}s{running_n > 0 ? ` · ${running_n}▶` : ''}
                      </span>
                    </span>
                  </button>

                  {/* Expanded settings */}
                  {isExpanded && (
                    <div className="px-4 pb-4 pt-1 space-y-4 ml-5">
                      {/* Name + Color row */}
                      <div className="flex gap-4">
                        <Field label="Name" className="flex-1">
                          <input
                            type="text"
                            value={form.name || ''}
                            onChange={(e) => updateField(ws.id, 'name', e.target.value)}
                            className="ide-input w-full"
                          />
                        </Field>
                        <Field label="Color">
                          <div className="flex gap-1 flex-wrap">
                            <button
                              onClick={() => updateField(ws.id, 'color', null)}
                              title="No color"
                              className={`w-4 h-4 rounded flex items-center justify-center transition-colors ${
                                !form.color ? 'border border-white/50 text-white' : 'border border-border-secondary text-text-faint hover:text-text-secondary hover:border-border-primary'
                              }`}
                            ><X size={9} strokeWidth={2.5} /></button>
                            {WORKSPACE_PALETTE.map((c) => (
                              <button
                                key={c}
                                onClick={() => updateField(ws.id, 'color', c)}
                                className={`w-4 h-4 rounded transition-all ${
                                  form.color === c ? 'ring-1 ring-white scale-110' : 'hover:scale-110'
                                }`}
                                style={{ backgroundColor: c }}
                              />
                            ))}
                          </div>
                        </Field>
                      </div>

                      {/* Oversight */}
                      <Field label="Human Oversight">
                        <div className="flex gap-1.5">
                          {OVERSIGHT_OPTIONS.map((opt) => (
                            <button
                              key={opt.value}
                              onClick={() => updateField(ws.id, 'human_oversight', opt.value)}
                              className={`flex-1 px-2 py-1.5 rounded text-[10px] font-mono border transition-colors ${
                                form.human_oversight === opt.value
                                  ? 'border-accent-primary bg-accent-primary/15 text-accent-primary'
                                  : 'border-border-secondary text-text-faint hover:border-border-primary hover:text-text-secondary'
                              }`}
                              title={opt.desc}
                            >{opt.label}</button>
                          ))}
                        </div>
                      </Field>

                      {/* Tester Mode */}
                      <Field label="Tester Mode" hint="How the testing agent executes tests">
                        <div className="flex gap-1.5">
                          {TESTER_MODE_OPTIONS.map((opt) => (
                            <button
                              key={opt.value}
                              onClick={() => updateField(ws.id, 'tester_mode', opt.value)}
                              className={`flex-1 px-2 py-1.5 rounded text-[10px] font-mono border transition-colors ${
                                form.tester_mode === opt.value
                                  ? 'border-accent-primary bg-accent-primary/15 text-accent-primary'
                                  : 'border-border-secondary text-text-faint hover:border-border-primary hover:text-text-secondary'
                              }`}
                              title={opt.desc}
                            >{opt.label}</button>
                          ))}
                        </div>
                        <p className="text-[10px] text-text-faint mt-1">
                          {form.tester_mode === 'delegated'
                            ? 'Tester acts as test-commander, spawning parallel test-worker sessions'
                            : 'Tester runs each test sequentially using Playwright'}
                        </p>
                      </Field>

                      {/* Git Worktree Isolation */}
                      <Field label="Git Worktree Isolation" hint="New sessions get their own branch">
                        <button
                          onClick={() => updateField(ws.id, 'default_worktree', form.default_worktree ? 0 : 1)}
                          className={`flex items-center gap-2 px-3 py-1.5 rounded text-[11px] font-mono border transition-colors w-full ${
                            form.default_worktree
                              ? 'border-accent-primary bg-accent-primary/15 text-accent-primary'
                              : 'border-border-secondary text-text-faint hover:border-border-primary hover:text-text-secondary'
                          }`}
                        >
                          <GitBranch size={12} />
                          <span>{form.default_worktree ? 'Enabled' : 'Disabled'}</span>
                          <span className="flex-1" />
                          <span className="text-[10px] opacity-60">
                            {form.default_worktree
                              ? 'Each session works on its own branch'
                              : 'Sessions share the working directory'}
                          </span>
                        </button>
                      </Field>

                      {/* Native Terminals */}
                      <div className="text-[10px] text-text-muted font-semibold uppercase tracking-wider mt-2 mb-1">Native Terminals</div>

                      <Field label="Pop-Out Terminals" hint="Run sessions in native OS terminal windows">
                        <button
                          onClick={() => updateField(ws.id, 'native_terminals_enabled', form.native_terminals_enabled ? 0 : 1)}
                          className={`flex items-center gap-2 px-3 py-1.5 rounded text-[11px] font-mono border transition-colors w-full ${
                            form.native_terminals_enabled
                              ? 'border-accent-primary bg-accent-primary/15 text-accent-primary'
                              : 'border-border-secondary text-text-faint hover:border-border-primary hover:text-text-secondary'
                          }`}
                        >
                          <ExternalLink size={12} />
                          <span>{form.native_terminals_enabled ? 'Enabled' : 'Disabled'}</span>
                          <span className="flex-1" />
                          <span className="text-[10px] opacity-60">
                            {form.native_terminals_enabled ? 'Pop Out Terminal available in ⌘K' : 'Sessions stay in browser'}
                          </span>
                        </button>
                        {form.native_terminals_enabled ? (
                          <div className="mt-2 space-y-2">
                            <div className="p-2 bg-bg-inset rounded border border-border-secondary">
                              <p className="text-[10px] text-text-secondary leading-relaxed">
                                <span className="text-emerald-400 font-medium">Works:</span>{' '}
                                Hook-based state tracking (idle/working/prompting), tool &amp; subagent tracking,
                                broadcasting, task board, memory sync, session management
                              </p>
                              <p className="text-[10px] text-text-secondary leading-relaxed mt-1">
                                <span className="text-amber-400 font-medium">Unavailable:</span>{' '}
                                Message markers, terminal annotations, image capture, grid layouts,
                                force bar, @-token UI chips, output search
                              </p>
                            </div>
                            <button
                              onClick={() => updateField(ws.id, 'auto_register_terminals', form.auto_register_terminals ? 0 : 1)}
                              className={`flex items-center gap-2 px-3 py-1.5 rounded text-[11px] font-mono border transition-colors w-full ${
                                form.auto_register_terminals
                                  ? 'border-cyan-500 bg-cyan-500/15 text-cyan-400'
                                  : 'border-border-secondary text-text-faint hover:border-border-primary hover:text-text-secondary'
                              }`}
                            >
                              <Monitor size={12} />
                              <span>{form.auto_register_terminals ? 'Auto-register' : 'Manual only'}</span>
                              <span className="flex-1" />
                              <span className="text-[10px] opacity-60">
                                {form.auto_register_terminals
                                  ? 'External CLIs in this workspace auto-join Commander'
                                  : 'Only popped-out sessions are tracked'}
                              </span>
                            </button>
                            {form.auto_register_terminals ? (
                              <p className="text-[10px] text-text-faint ml-1">
                                Any Claude/Gemini CLI started in this workspace directory will
                                automatically appear in Commander with full hook tracking.
                                Reinstall hooks after enabling (start.sh does this automatically).
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                      </Field>

                      {/* W2W: Worker-to-Worker Features */}
                      <div className="text-[10px] text-text-muted font-semibold uppercase tracking-wider mt-2 mb-1">Worker-to-Worker (W2W)</div>

                      <Field label="Peer Communication" hint="Workers post/read messages on a shared bulletin board">
                        <button
                          onClick={() => updateField(ws.id, 'comms_enabled', form.comms_enabled ? 0 : 1)}
                          className={`flex items-center gap-2 px-3 py-1.5 rounded text-[11px] font-mono border transition-colors w-full ${
                            form.comms_enabled
                              ? 'border-accent-primary bg-accent-primary/15 text-accent-primary'
                              : 'border-border-secondary text-text-faint hover:border-border-primary hover:text-text-secondary'
                          }`}
                        >
                          <MessageSquare size={12} />
                          <span>{form.comms_enabled ? 'Enabled' : 'Disabled'}</span>
                          <span className="flex-1" />
                          <span className="text-[10px] opacity-60">
                            {form.comms_enabled ? 'Workers can message each other' : 'No peer messaging'}
                          </span>
                        </button>
                      </Field>

                      <Field label="Shared Context" hint="Session digests + workspace knowledge base">
                        <button
                          onClick={() => updateField(ws.id, 'context_sharing_enabled', form.context_sharing_enabled ? 0 : 1)}
                          className={`flex items-center gap-2 px-3 py-1.5 rounded text-[11px] font-mono border transition-colors w-full ${
                            form.context_sharing_enabled
                              ? 'border-accent-primary bg-accent-primary/15 text-accent-primary'
                              : 'border-border-secondary text-text-faint hover:border-border-primary hover:text-text-secondary'
                          }`}
                        >
                          <Brain size={12} />
                          <span>{form.context_sharing_enabled ? 'Enabled' : 'Disabled'}</span>
                          <span className="flex-1" />
                          <span className="text-[10px] opacity-60">
                            {form.context_sharing_enabled ? 'Workers share knowledge automatically' : 'No knowledge sharing'}
                          </span>
                        </button>
                      </Field>

                      <Field label="Semantic Coordination" hint="Conflict detection via intent embeddings (requires Myelin)">
                        <button
                          onClick={() => updateField(ws.id, 'coordination_enabled', form.coordination_enabled ? 0 : 1)}
                          disabled={!coordEnabled}
                          className={`flex items-center gap-2 px-3 py-1.5 rounded text-[11px] font-mono border transition-colors w-full ${
                            !coordEnabled ? 'opacity-40 cursor-not-allowed border-border-secondary text-text-faint' :
                            form.coordination_enabled
                              ? 'border-accent-primary bg-accent-primary/15 text-accent-primary'
                              : 'border-border-secondary text-text-faint hover:border-border-primary hover:text-text-secondary'
                          }`}
                        >
                          <Shield size={12} />
                          <span>{form.coordination_enabled ? 'Enabled' : 'Disabled'}</span>
                          <span className="flex-1" />
                          <span className="text-[10px] opacity-60">
                            {!coordEnabled ? 'Enable Myelin experimental flag first' :
                             form.coordination_enabled ? 'File edit conflicts detected' : 'No conflict detection'}
                          </span>
                        </button>
                      </Field>

                      {/* Research Model + LLM URL row */}
                      <div className="flex gap-4">
                        <Field label="Research Model" className="flex-1">
                          <select
                            value={form.research_model || ''}
                            onChange={(e) => updateField(ws.id, 'research_model', e.target.value)}
                            className="ide-input w-full"
                          >
                            <option value="">Default</option>
                            {RESEARCH_MODELS.map((g) => (
                              <optgroup key={g.group} label={g.group}>
                                {g.items.map((m) => (
                                  <option key={m.id} value={m.id}>{m.label}</option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                        </Field>
                        <Field label="Research LLM URL" hint="Ollama or compatible endpoint" className="flex-1">
                          <input
                            type="text"
                            value={form.research_llm_url || ''}
                            onChange={(e) => updateField(ws.id, 'research_llm_url', e.target.value)}
                            placeholder="http://localhost:11434/v1"
                            className="ide-input w-full"
                          />
                        </Field>
                        <Field label="Iterations" hint="Max research loops (default: 5)" className="w-24">
                          <input
                            type="number"
                            min={1}
                            max={20}
                            value={form.research_max_iterations || ''}
                            onChange={(e) => updateField(ws.id, 'research_max_iterations', e.target.value ? Number(e.target.value) : null)}
                            placeholder="5"
                            className="ide-input w-full"
                          />
                        </Field>
                      </div>

                      {/* Preview URL */}
                      <Field label="Preview URL" hint="App preview for screenshots and live preview">
                        <input
                          type="text"
                          value={form.preview_url || ''}
                          onChange={(e) => updateField(ws.id, 'preview_url', e.target.value)}
                          placeholder="http://localhost:3000"
                          className="ide-input w-full"
                        />
                      </Field>

                      {/* Coordination Namespace */}
                      {coordEnabled && (
                        <Field label="Coordination Namespace" hint="Shared namespace = shared conflict detection">
                          <input
                            type="text"
                            value={form.coordination_namespace || ''}
                            onChange={(e) => updateField(ws.id, 'coordination_namespace', e.target.value)}
                            placeholder={`commander:${ws.id.slice(0, 8)} (isolated)`}
                            className="ide-input w-full"
                          />
                          <p className="text-[10px] text-text-faint mt-1">
                            Set the same value across workspaces to coordinate sessions across repos.
                          </p>
                        </Field>
                      )}

                      {/* Memory */}
                      <div className="text-[10px] text-text-muted font-semibold uppercase tracking-wider mt-2 mb-1">Memory</div>
                      <p className="text-[10px] text-text-faint leading-relaxed mb-2">
                        Hub-and-spoke sync of CLI memory files (CLAUDE.md, GEMINI.md, AGENTS.md) through this workspace.
                        Conflicts between providers are resolved with a three-way git merge so each CLI keeps its own copy in sync without overwriting the others.
                      </p>
                      <MemorySettingsSection workspaceId={ws.id} />

                      {/* Workspace Knowledge */}
                      <div className="text-[10px] text-text-muted font-semibold uppercase tracking-wider mt-2 mb-1">Workspace Knowledge</div>
                      <p className="text-[10px] text-text-faint leading-relaxed mb-2">
                        Shared insights about this codebase (gotchas, conventions, patterns) that future agents see in their system prompt.
                        Workers can call <span className="font-mono text-text-secondary">contribute_knowledge</span> mid-session;
                        auto-extract distills durable insights from each completed session into the knowledge base.
                      </p>

                      <Field label="Auto-Extract Knowledge" hint="LLM-extract insights when a session goes idle or exits cleanly">
                        <button
                          onClick={() => updateField(ws.id, 'auto_knowledge_enabled', form.auto_knowledge_enabled ? 0 : 1)}
                          className={`flex items-center gap-2 px-3 py-1.5 rounded text-[11px] font-mono border transition-colors w-full ${
                            form.auto_knowledge_enabled
                              ? 'border-emerald-500 bg-emerald-500/15 text-emerald-400'
                              : 'border-border-secondary text-text-faint hover:border-border-primary hover:text-text-secondary'
                          }`}
                        >
                          <BookOpen size={12} />
                          <span>{form.auto_knowledge_enabled ? 'Enabled' : 'Disabled'}</span>
                          <span className="flex-1" />
                          <span className="text-[10px] opacity-60">
                            {form.auto_knowledge_enabled
                              ? 'Sessions auto-contribute knowledge on idle + clean exit'
                              : 'Knowledge is only added manually or via MCP tool'}
                          </span>
                        </button>
                        {form.auto_knowledge_enabled ? (
                          <p className="text-[10px] text-text-faint mt-1">
                            Fires on Stop-hook idle and on clean exit (5+ turns, non-worktree, non-orchestrator).
                            An LLM pass extracts up to 5 high-signal entries into the knowledge base,
                            tagged <span className="font-mono">auto:&lt;session_id&gt;</span>.
                            Each idle window fires at most once; resets when the agent runs more tools.
                            Disable if you want manual curation only.
                          </p>
                        ) : null}
                      </Field>

                      {/* Automation */}
                      <div className="text-[10px] text-text-muted font-semibold uppercase tracking-wider mt-2 mb-1">Automation</div>

                      <Field label="Auto-Execute Tasks" hint="Commander automatically picks up backlog/todo tasks">
                        <button
                          onClick={() => updateField(ws.id, 'auto_exec_enabled', form.auto_exec_enabled ? 0 : 1)}
                          className={`flex items-center gap-2 px-3 py-1.5 rounded text-[11px] font-mono border transition-colors w-full ${
                            form.auto_exec_enabled
                              ? 'border-emerald-500 bg-emerald-500/15 text-emerald-400'
                              : 'border-border-secondary text-text-faint hover:border-border-primary hover:text-text-secondary'
                          }`}
                        >
                          <Play size={12} />
                          <span>{form.auto_exec_enabled ? 'Enabled' : 'Disabled'}</span>
                          <span className="flex-1" />
                          <span className="text-[10px] opacity-60">
                            {form.auto_exec_enabled
                              ? 'Tasks auto-dispatched to Commander'
                              : 'Manual dispatch only'}
                          </span>
                        </button>
                        {form.auto_exec_enabled ? (
                          <p className="text-[10px] text-text-faint mt-1">
                            When enabled, new backlog/todo tasks are automatically sent to the Commander session.
                            Commander must be running. Tasks are dispatched by priority, respecting worker limits.
                          </p>
                        ) : null}
                      </Field>

                      <Field label="Pipeline" hint="Auto: implement → test → document for new tasks">
                        <button
                          onClick={() => updateField(ws.id, 'pipeline_enabled', form.pipeline_enabled ? 0 : 1)}
                          className={`flex items-center gap-2 px-3 py-1.5 rounded text-[11px] font-mono border transition-colors w-full ${
                            form.pipeline_enabled
                              ? 'border-emerald-500 bg-emerald-500/15 text-emerald-400'
                              : 'border-border-secondary text-text-faint hover:border-border-primary hover:text-text-secondary'
                          }`}
                        >
                          <RotateCcw size={12} />
                          <span>{form.pipeline_enabled ? 'Enabled' : 'Disabled'}</span>
                          <span className="flex-1" />
                          <span className="text-[10px] opacity-60">
                            {form.pipeline_enabled
                              ? 'New tasks auto-loop through test + docs'
                              : 'Tasks use pipeline only when toggled individually'}
                          </span>
                        </button>
                        {form.pipeline_enabled ? (
                          <p className="text-[10px] text-text-faint mt-1">
                            New tasks inherit pipeline mode. Workers implement → tester verifies → documentor documents → done. Failed tests iterate back automatically.
                          </p>
                        ) : null}
                      </Field>

                      <Field label="Task Dependencies" hint="Declare ordering between tasks via depends_on">
                        <button
                          onClick={() => updateField(ws.id, 'task_dependencies_enabled', form.task_dependencies_enabled ? 0 : 1)}
                          className={`flex items-center gap-2 px-3 py-1.5 rounded text-[11px] font-mono border transition-colors w-full ${
                            form.task_dependencies_enabled
                              ? 'border-emerald-500 bg-emerald-500/15 text-emerald-400'
                              : 'border-border-secondary text-text-faint hover:border-border-primary hover:text-text-secondary'
                          }`}
                        >
                          <Link size={12} />
                          <span>{form.task_dependencies_enabled ? 'Enabled' : 'Disabled'}</span>
                          <span className="flex-1" />
                          <span className="text-[10px] opacity-60">
                            {form.task_dependencies_enabled
                              ? 'Auto-exec respects task ordering'
                              : 'Tasks dispatched by priority only'}
                          </span>
                        </button>
                        {form.task_dependencies_enabled ? (
                          <p className="text-[10px] text-text-faint mt-1">
                            Tasks can declare dependencies. Auto-exec holds dependent tasks until prerequisites are done. Commander can set depends_on when creating tasks.
                          </p>
                        ) : null}
                      </Field>

                      <div className="flex gap-4">
                        <Field label="Max Workers" hint="Commander worker limit" className="flex-1">
                          <div className="flex items-center gap-2">
                            <Users size={12} className="text-text-faint shrink-0" />
                            <input
                              type="number"
                              min="1"
                              max="10"
                              value={form.commander_max_workers || 3}
                              onChange={(e) => updateField(ws.id, 'commander_max_workers', parseInt(e.target.value) || 3)}
                              className="ide-input w-full"
                            />
                          </div>
                        </Field>
                        <Field label="Max Testers" hint="Tester worker limit" className="flex-1">
                          <div className="flex items-center gap-2">
                            <Users size={12} className="text-text-faint shrink-0" />
                            <input
                              type="number"
                              min="1"
                              max="5"
                              value={form.tester_max_workers || 2}
                              onChange={(e) => updateField(ws.id, 'tester_max_workers', parseInt(e.target.value) || 2)}
                              className="ide-input w-full"
                            />
                          </div>
                        </Field>
                      </div>

                      {/* Tab Groups */}
                      <div className="text-[10px] text-text-muted font-semibold uppercase tracking-wider mt-2 mb-1">Tab Groups</div>
                      <TabGroupsSection workspaceId={ws.id} />

                      {/* Save */}
                      <div className="flex justify-end">
                        <button
                          onClick={() => saveWorkspace(ws.id)}
                          disabled={savingId === ws.id}
                          className="px-3 py-1.5 text-[11px] font-medium text-white bg-accent-primary hover:bg-accent-hover rounded-md transition-colors disabled:opacity-50 flex items-center gap-1.5"
                        >
                          {savedId === ws.id ? (
                            <><Check size={12} /> Saved</>
                          ) : savingId === ws.id ? (
                            'Saving…'
                          ) : (
                            <><Save size={12} /> Save</>
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

function MemorySettingsSection({ workspaceId }) {
  const [settings, setSettings] = useState(null)
  const [status, setStatus] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
  const [resolving, setResolving] = useState(false)
  const [resolveContent, setResolveContent] = useState('')
  const [diffData, setDiffData] = useState(null)

  const loadData = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([
        api.getWorkspaceMemorySettings(workspaceId),
        api.getWorkspaceMemory(workspaceId).catch(() => null),
      ])
      setSettings(s)
      setStatus(st)
    } catch {
      setSettings({ enabled: true, auto_sync: true, memory_max_chars: 4000 })
    }
  }, [workspaceId])

  useEffect(() => { loadData() }, [loadData])

  const update = async (key, value) => {
    const next = { ...settings, [key]: value }
    setSettings(next)
    try { await api.updateWorkspaceMemorySettings(workspaceId, { [key]: value }) } catch { /* ignore */ }
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      const result = await api.syncWorkspaceMemory(workspaceId)
      setSyncResult(result)
      await loadData()
    } catch { /* ignore */ }
    setSyncing(false)
  }

  const handleStartResolve = async () => {
    try {
      const diff = await api.getWorkspaceMemoryDiff(workspaceId)
      setDiffData(diff)
      setResolveContent(status?.content || '')
      setResolving(true)
    } catch { /* ignore */ }
  }

  const handleSubmitResolve = async () => {
    try {
      await api.resolveWorkspaceMemory(workspaceId, resolveContent)
      setResolving(false)
      setDiffData(null)
      setSyncResult(null)
      await loadData()
    } catch { /* ignore */ }
  }

  if (!settings) return null

  const providers = status?.providers || {}
  const hasConflicts = syncResult?.status === 'conflicts' && syncResult?.conflict_count > 0

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          onClick={() => update('enabled', !settings.enabled)}
          className={`flex items-center gap-2 px-3 py-1.5 rounded text-[11px] font-mono border transition-colors flex-1 ${
            settings.enabled
              ? 'border-accent-primary bg-accent-primary/15 text-accent-primary'
              : 'border-border-secondary text-text-faint hover:border-border-primary hover:text-text-secondary'
          }`}
        >
          <Brain size={12} />
          <span>{settings.enabled ? 'Sync Enabled' : 'Sync Disabled'}</span>
        </button>
        {settings.enabled && (
          <button
            onClick={() => update('auto_sync', !settings.auto_sync)}
            className={`px-2.5 py-1.5 rounded text-[10px] font-mono border transition-colors ${
              settings.auto_sync
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                : 'border-border-secondary text-text-faint hover:border-border-primary'
            }`}
            title="Automatically sync when CLI memory files change"
          >
            {settings.auto_sync ? 'Auto' : 'Manual'}
          </button>
        )}
      </div>

      {settings.enabled && (
        <>
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-text-faint">Max chars</label>
            <input
              type="number"
              min={1000}
              max={10000}
              step={500}
              value={settings.memory_max_chars || 4000}
              onChange={(e) => update('memory_max_chars', parseInt(e.target.value) || 4000)}
              className="ide-input text-[11px] w-20 px-2 py-1"
            />
            <button
              onClick={handleSync}
              disabled={syncing}
              className="ml-auto px-2.5 py-1 rounded text-[10px] font-mono border border-border-secondary text-text-secondary hover:border-border-primary hover:text-text-primary transition-colors disabled:opacity-50"
            >
              {syncing ? 'Syncing...' : 'Sync Now'}
            </button>
          </div>

          {/* Provider status */}
          {Object.keys(providers).length > 0 && (
            <div className="space-y-1">
              {Object.entries(providers).map(([cli, info]) => (
                <div key={cli} className="flex items-center gap-2 text-[10px] font-mono text-text-faint">
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    !info.file_exists ? 'bg-zinc-600'
                    : info.synced ? 'bg-emerald-400'
                    : info.changed ? 'bg-amber-400'
                    : 'bg-zinc-500'
                  }`} />
                  <span className="text-text-secondary">{cli}</span>
                  <span className="truncate flex-1 opacity-60">{info.filename || '—'}</span>
                  <span>{info.file_exists ? (info.synced ? 'synced' : 'changed') : 'no file'}</span>
                </div>
              ))}
            </div>
          )}

          {status?.last_synced_at && (
            <div className="text-[9px] text-text-faint">
              Last synced: {new Date(status.last_synced_at).toLocaleString()}
            </div>
          )}

          {hasConflicts && !resolving && (
            <button
              onClick={handleStartResolve}
              className="w-full px-2.5 py-1.5 rounded text-[11px] font-mono bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-500/30 transition-colors"
            >
              <Brain size={10} className="inline mr-1" />
              {syncResult.conflict_count} conflict{syncResult.conflict_count !== 1 ? 's' : ''} — Resolve
            </button>
          )}

          {resolving && (
            <div className="space-y-2 border border-red-500/20 rounded p-2">
              <div className="text-[10px] text-red-300 font-mono">Resolve merge conflicts</div>
              {diffData && Object.entries(diffData).map(([cli, d]) => (
                <details key={cli} className="text-[10px] font-mono text-text-faint">
                  <summary className="cursor-pointer hover:text-text-secondary">{cli}: {d.filename}</summary>
                  <pre className="mt-1 p-1.5 bg-black/30 rounded text-[9px] overflow-x-auto max-h-32 overflow-y-auto">{d.diff}</pre>
                </details>
              ))}
              <textarea
                value={resolveContent}
                onChange={(e) => setResolveContent(e.target.value)}
                rows={8}
                className="w-full ide-input text-[10px] font-mono p-2 resize-y"
                placeholder="Edit the resolved content..."
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSubmitResolve}
                  className="px-2.5 py-1 rounded text-[10px] font-mono bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 transition-colors"
                >
                  Save Resolution
                </button>
                <button
                  onClick={() => { setResolving(false); setDiffData(null) }}
                  className="px-2.5 py-1 rounded text-[10px] font-mono text-text-faint hover:text-text-secondary transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function TabGroupsSection({ workspaceId }) {
  const tabGroups = useStore((s) => s.tabGroups)
  const loadTabGroups = useStore((s) => s.loadTabGroups)
  const removeTabGroup = useStore((s) => s.removeTabGroup)
  const activateTabGroup = useStore((s) => s.activateTabGroup)
  const saveCurrentTabsAsGroup = useStore((s) => s.saveCurrentTabsAsGroup)
  const openTabs = useStore((s) => s.openTabs)
  const sessions = useStore((s) => s.sessions)

  useEffect(() => {
    loadTabGroups(workspaceId)
  }, [workspaceId, loadTabGroups])

  const wsGroups = tabGroups.filter((g) => g.workspace_id === workspaceId)
  const currentTabCount = openTabs.filter((id) => sessions[id]?.workspace_id === workspaceId).length

  const handleSave = async () => {
    const name = prompt('Tab group name:')
    if (!name?.trim()) return
    await saveCurrentTabsAsGroup(name.trim())
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] text-text-faint">
        Save your current open tabs as a named group. Switch between groups to restore different tab arrangements.
      </p>

      {wsGroups.length === 0 && (
        <div className="text-[10px] text-text-faint/60 py-2 text-center">
          No tab groups saved yet.
        </div>
      )}

      {wsGroups.map((group) => {
        const validCount = group.session_ids.filter((id) => sessions[id]).length
        return (
          <div
            key={group.id}
            className="flex items-center gap-2 px-3 py-2 rounded border border-border-secondary bg-bg-tertiary/30"
          >
            <Layers size={12} className="text-indigo-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] text-text-primary font-medium truncate">{group.name}</div>
              <div className="text-[10px] text-text-faint font-mono">
                {validCount}/{group.session_ids.length} sessions available
              </div>
            </div>
            <button
              onClick={() => activateTabGroup(group)}
              disabled={validCount === 0}
              className="px-2 py-1 text-[10px] font-medium bg-accent-subtle hover:bg-accent-primary/20 text-indigo-400 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              open
            </button>
            <button
              onClick={() => {
                if (confirm(`Delete tab group "${group.name}"?`)) removeTabGroup(group.id)
              }}
              className="p-1 text-text-faint hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
            >
              <Trash2 size={10} />
            </button>
          </div>
        )
      })}

      <button
        onClick={handleSave}
        disabled={currentTabCount === 0}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[10px] font-medium bg-accent-subtle hover:bg-accent-primary/20 text-indigo-400 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Plus size={10} /> Save current tabs as group ({currentTabCount} tabs)
      </button>
    </div>
  )
}

function Field({ label, hint, className, children }) {
  return (
    <div className={className}>
      <div className="flex items-baseline gap-2 mb-1.5">
        <label className="text-[11px] text-text-secondary font-medium">{label}</label>
        {hint && <span className="text-[10px] text-text-faint">{hint}</span>}
      </div>
      {children}
    </div>
  )
}
