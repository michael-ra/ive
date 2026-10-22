import HelpDetails from '../ui/HelpDetails'
import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Save, ChevronDown, ChevronRight, Check, GitBranch, MessageSquare, Shield, Brain, ExternalLink, Monitor, Play, Users, RotateCcw, Layers, Plus, Trash2, Link, BookOpen, FileCode2, Sparkles, RefreshCw } from 'lucide-react'
import { api } from '../../lib/api'
import { loadExtensionContributions, resolveExtensionPanel, isSurfaceAvailable } from '../../lib/extensionRegistry'
import { extensionSettingsValues, extensionSettingsPayload } from '../../lib/workspaceExtensionSettings'
import useStore from '../../state/store'
import { getCliTypes, getRoleDefaultModel, getWorkspaceColor, WORKSPACE_PALETTE } from '../../lib/constants'
import { ORCHESTRATION_ROLE_OPTIONS, parseOrchestrationPolicy, serializeOrchestrationPolicy } from '../../lib/orchestrationPolicy'

import { COLUMNS as BOARD_COLUMNS } from '../../lib/boardColumns'
import { Button, IconButton } from '../ui'
import CoordinationControls from './CoordinationControls'

const KnowledgeSettings = resolveExtensionPanel('myelin', 'KnowledgeSettings')
const MemoryEngineSettings = resolveExtensionPanel('myelin', 'MemoryEngineSettings')
const CatalogueSettings = resolveExtensionPanel('forge', 'CatalogueSettings')
const CoordinationSettings = resolveExtensionPanel('swarmlock', 'CoordinationSettings')
const CoordinationMemorySettings = resolveExtensionPanel('swarmlock', 'CoordinationMemorySettings')
const CoordinationWorkspaceBadge = resolveExtensionPanel('swarmlock', 'CoordinationWorkspaceBadge')

const OVERSIGHT_OPTIONS = [
  { value: 'full_auto', label: 'Auto', desc: 'Commander decides everything autonomously' },
  { value: 'approve_plans', label: 'Plans', desc: 'Approve plans, rest is auto' },
  { value: 'approve_all', label: 'All', desc: 'Approve every major action' },
]

const BOARD_DOC_MODE_OPTIONS = [
  { value: 'off', label: 'Off', desc: 'No auto-doc; agents may still create tickets manually' },
  { value: 'agent_only', label: 'Agent-only', desc: 'Reflection nudges agents to call document_to_board; no fallback sweeper' },
  { value: 'agent_with_backstop', label: 'Agent + Backstop', desc: 'Agent-driven, plus an hourly sweeper that documents missed sessions' },
]

export const WORKSPACE_SETTING_SECTIONS = [
  { id: 'identity', label: 'Identity' },
  { id: 'oversight', label: 'Oversight & approvals' },
  { id: 'sessions', label: 'Sessions & isolation' },
  { id: 'coordination', label: 'Multi-agent coordination' },
  { id: 'knowledge', label: 'Knowledge & memory' },
  { id: 'research', label: 'Research' },
  { id: 'feature-board', label: 'Feature board' },
  { id: 'runtime', label: 'Runtime environment' },
  { id: 'preview', label: 'Preview & experimental' },
]

export default function WorkspaceSettingsPanel({ initialWorkspaceId, activeSectionId = 'identity' }) {
  const workspaces = useStore((s) => s.workspaces)
  const sessions = useStore((s) => s.sessions)
  const cliProfiles = useStore((s) => s.cliProfiles)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const cliTypes = getCliTypes()
  void cliProfiles
  const initialExpandedId = initialWorkspaceId || activeWorkspaceId || workspaces[0]?.id || null
  const [expandedId, setExpandedId] = useState(initialExpandedId)
  const hasChosenInitialWorkspace = useRef(Boolean(initialExpandedId))
  const [forms, setForms] = useState({})
  const [savingId, setSavingId] = useState(null)
  const [savedId, setSavedId] = useState(null)
  const [runtimeEnvs, setRuntimeEnvs] = useState({})
  const [runtimeLoading, setRuntimeLoading] = useState({})
  const [runtimeErrors, setRuntimeErrors] = useState({})
  const [modelRegistry, setModelRegistry] = useState({
    providers: [],
    health: [],
    loading: true,
    error: null,
  })
  const [settingContributions, setSettingContributions] = useState(null)
  const [settingsError, setSettingsError] = useState(null)
  const [settingsAttempt, setSettingsAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setSettingsError(null)
    loadExtensionContributions('workspaceSettings').then((contributions) => {
      if (active) setSettingContributions(contributions)
    }).catch((error) => {
      if (active) setSettingsError(error.message || 'Could not load extension settings')
    })
    return () => { active = false }
  }, [settingsAttempt])
  const scrollRef = useRef(null)
  const itemRefs = useRef({})

  useEffect(() => {
    if (hasChosenInitialWorkspace.current) return
    const nextWorkspaceId = initialWorkspaceId || activeWorkspaceId || workspaces[0]?.id
    if (!nextWorkspaceId) return
    hasChosenInitialWorkspace.current = true
    setExpandedId(nextWorkspaceId)
  }, [activeWorkspaceId, initialWorkspaceId, workspaces])

  const wouldCreateLoop = (startId, targetId) => {
    if (startId === targetId) return true;
    let currentId = targetId;
    const visited = new Set([startId]);
    while (currentId) {
      if (visited.has(currentId)) return true;
      visited.add(currentId);
      const ws = workspaces.find((w) => w.id === currentId);
      const form = forms[currentId];
      const nextInherit = form ? form.inherit_orchestration_policy_from : ws?.inherit_orchestration_policy_from;
      currentId = nextInherit;
    }
    return false;
  };

  // Init form state for all workspaces
  useEffect(() => {
    if (!settingContributions) return
    const f = {}
    for (const ws of workspaces) {
      f[ws.id] = {
        name: ws.name || '',
        human_oversight: ws.human_oversight || 'approve_plans',
        review_provider: ws.review_provider || 'active',
        research_model: ws.research_model || '',
        preview_url: ws.preview_url || '',
        color: ws.color || null,
        default_worktree: ws.default_worktree || 0,
        comms_enabled: ws.comms_enabled || 0,
        // Shared host capability flags, not semantic-product configuration.
        coordination_enabled: ws.coordination_enabled || 0,
        context_sharing_enabled: ws.context_sharing_enabled || 0,
        native_terminals_enabled: ws.native_terminals_enabled || 0,
        auto_register_terminals: ws.auto_register_terminals || 0,
        auto_exec_enabled: ws.auto_exec_enabled || 0,
        pipeline_enabled: ws.pipeline_enabled || 0,
        task_dependencies_enabled: ws.task_dependencies_enabled || 0,
        alloy_enabled: ws.alloy_enabled || 0,
        orchestration_policy: parseOrchestrationPolicy(ws.orchestration_policy),
        inherit_orchestration_policy_from: ws.inherit_orchestration_policy_from || '',
        commander_max_workers: ws.commander_max_workers || 3,
        tester_max_workers: ws.tester_max_workers || 2,
        research_max_iterations: ws.research_max_iterations || '',
        board_doc_mode: ws.board_doc_mode || 'agent_with_backstop',
        board_doc_new_column: ws.board_doc_new_column || 'review',
        board_doc_existing_column: ws.board_doc_existing_column || 'review',
        ...extensionSettingsValues(ws, settingContributions),
      }
    }
    setForms(f)
  }, [workspaces, settingContributions])

  // Scroll to initial workspace
  useEffect(() => {
    if (initialWorkspaceId && itemRefs.current[initialWorkspaceId]) {
      setTimeout(() => {
        itemRefs.current[initialWorkspaceId]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
    }
  }, [initialWorkspaceId])

  const loadRuntimeEnv = useCallback(async (wsId) => {
    if (!wsId) return
    setRuntimeLoading((p) => ({ ...p, [wsId]: true }))
    setRuntimeErrors((p) => ({ ...p, [wsId]: null }))
    try {
      const env = await api.getWorkspaceRuntimeEnv(wsId)
      setRuntimeEnvs((p) => ({ ...p, [wsId]: env }))
    } catch (e) {
      setRuntimeErrors((p) => ({ ...p, [wsId]: e.message || 'Failed to load runtime environment' }))
    } finally {
      setRuntimeLoading((p) => ({ ...p, [wsId]: false }))
    }
  }, [])

  useEffect(() => {
    if (expandedId && !runtimeEnvs[expandedId] && !runtimeLoading[expandedId]) {
      loadRuntimeEnv(expandedId)
    }
  }, [expandedId, runtimeEnvs, runtimeLoading, loadRuntimeEnv])

  useEffect(() => {
    let active = true
    api.getModelProviders()
      .then((data) => {
        if (active) setModelRegistry({ ...data, loading: false, error: null })
      })
      .catch((error) => {
        if (active) {
          setModelRegistry({
            providers: [],
            health: [],
            loading: false,
            error: error?.message || 'Could not load model providers',
          })
        }
      })
    return () => { active = false }
  }, [])

  const updateField = (wsId, key, value) => {
    setForms((f) => ({ ...f, [wsId]: { ...f[wsId], [key]: value } }))
  }

  const saveWorkspace = async (wsId) => {
    const form = forms[wsId]
    if (!form || !settingContributions || settingsError) return
    setSavingId(wsId)
    try {
      const payload = { ...form, ...extensionSettingsPayload(form, settingContributions) }
      payload.orchestration_policy = serializeOrchestrationPolicy(payload.orchestration_policy)
      for (const k of ['research_model', 'preview_url', 'color', 'research_max_iterations', 'inherit_orchestration_policy_from']) {
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

  if (!settingContributions) return (
    <div className="p-4 text-[12px] text-x-muted" role={settingsError ? 'alert' : 'status'}>
      {settingsError || 'Loading extension settings…'}
      {settingsError && <Button onClick={() => setSettingsAttempt(attempt => attempt + 1)}>Retry</Button>}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
        {/* Workspace list */}
        <div className="flex-1 overflow-y-auto" ref={scrollRef}>
          {workspaces.length === 0 ? (
            <div className="px-4 py-10 text-xs text-x-faint text-center">
              No workspaces configured.
            </div>
          ) : (
            workspaces.map((ws) => {
              const isExpanded = expandedId === ws.id
              const form = forms[ws.id] || {}
              const wsColor = getWorkspaceColor(ws)
              const sessions_n = sessionCount(ws.id)
              const running_n = runningCount(ws.id)
              const inheritedPolicyWorkspace = form.inherit_orchestration_policy_from
                ? workspaces.find((candidate) => candidate.id === form.inherit_orchestration_policy_from)
                : null
              const policyReadOnly = Boolean(form.inherit_orchestration_policy_from)
              const effectivePolicy = policyReadOnly
                ? inheritedPolicyWorkspace?.orchestration_policy || '{}'
                : form.orchestration_policy
              const updatePolicy = policyReadOnly
                ? () => {}
                : (next) => updateField(ws.id, 'orchestration_policy', next)

              return (
                <div
                  key={ws.id}
                  ref={(el) => { itemRefs.current[ws.id] = el }}
                  className={`border-b border-x-line-subtle ${
                    isExpanded ? 'bg-x-hover' : ''
                  }`}
                >
                  {/* Workspace row */}
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : ws.id)}
                    className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left hover:bg-x-hover transition-colors duration-[80ms]"
                  >
                    {isExpanded
                      ? <ChevronDown size={12} className="text-x-faint shrink-0" />
                      : <ChevronRight size={12} className="text-x-faint shrink-0" />
                    }
                    <div
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: wsColor }}
                    />
                    <span className="text-xs text-x-ink font-medium truncate">
                      {ws.name}
                    </span>
                    <span
                      dir="rtl"
                      title={ws.path}
                      className="max-w-[220px] truncate text-left font-mono text-[11px] text-x-faint"
                    >
                      {ws.path}
                    </span>
                    <div className="flex-1" />
                    {/* Inline badges */}
                    <span className="flex flex-wrap items-center justify-end gap-1.5">
                      <span className="rounded-md border border-x-line bg-x-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-x-ink-secondary">
                        Oversight: {(ws.human_oversight || 'approve_plans') === 'full_auto' ? 'Auto'
                          : ws.human_oversight === 'approve_all' ? 'All' : 'Plans'}
                      </span>
                      {ws.default_worktree ? (
                        <span className="rounded-md border border-x-line bg-x-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-x-ink-secondary">
                          Worktrees
                        </span>
                      ) : null}
                      {ws.native_terminals_enabled ? (
                        <span className="rounded-md border border-x-line bg-x-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-x-ink-secondary">
                          Native terminals
                        </span>
                      ) : null}
                      <CoordinationWorkspaceBadge workspace={ws} />
                      {ws.auto_exec_enabled ? (
                        <span className="rounded-md border border-x-line bg-x-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-x-ink-secondary">
                          Auto-execute
                        </span>
                      ) : null}
                      {ws.pipeline_enabled ? (
                        <span className="rounded-md border border-x-line bg-x-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-x-ink-secondary">
                          Pipeline
                        </span>
                      ) : null}
                      {ws.alloy_enabled ? (
                        <span className="rounded-md border border-x-line bg-x-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-x-ink-secondary">
                          Alloy
                        </span>
                      ) : null}
                      <span className="text-[11px] text-x-faint font-mono">
                        Sessions: {sessions_n}{running_n > 0 ? ` · Running: ${running_n}` : ''}
                      </span>
                    </span>
                  </button>

                  {/* Expanded settings */}
                  {isExpanded && (
                    <div className="px-4 pb-4 pt-1 space-y-4 ml-5">
                      <SettingsSection id="identity" title="Identity" active={activeSectionId === 'identity'}>
                      {/* Name + Color row */}
                      <div className="flex gap-4">
                        <Field label="Name" className="flex-1">
                          <input
                            type="text"
                            value={form.name || ''}
                            onChange={(e) => updateField(ws.id, 'name', e.target.value)}
                            className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md px-3 text-[13px] text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                          />
                        </Field>
                        <Field label="Color">
                          <div className="flex gap-1 flex-wrap">
                            <button
                              onClick={() => updateField(ws.id, 'color', null)}
                              title="No color"
                              className={`w-4 h-4 rounded-full flex items-center justify-center transition-colors duration-[80ms] ${
                                !form.color ? 'border border-x-accent text-x-accent' : 'border border-x-line text-x-faint hover:text-x-ink-secondary hover:border-x-line-strong'
                              }`}
                            ><X size={9} strokeWidth={2.5} /></button>
                            {WORKSPACE_PALETTE.map((c) => (
                              <button
                                key={c}
                                onClick={() => updateField(ws.id, 'color', c)}
                                className={`w-4 h-4 rounded-full transition-colors duration-[80ms] ${
                                  form.color === c ? 'ring-2 ring-x-accent' : 'hover:ring-1 hover:ring-x-line-strong'
                                }`}
                                style={{ backgroundColor: c }}
                              />
                            ))}
                          </div>
                        </Field>
                      </div>
                      </SettingsSection>

                      <SettingsSection id="oversight" title="Oversight & approvals" active={activeSectionId === 'oversight'}>
                      <Field label="Human Oversight">
                        <div className="flex gap-1.5">
                          {OVERSIGHT_OPTIONS.map((opt) => (
                            <Button
                              key={opt.value}
                              onClick={() => updateField(ws.id, 'human_oversight', opt.value)}
                              selected={form.human_oversight === opt.value}
                              className="flex-1"
                              title={opt.desc}
                            >{opt.label}</Button>
                          ))}
                        </div>
                      </Field>

                      <Field label="Orchestration Policy Source" hint="Define a local policy or inherit from another workspace">
                        <select
                          value={form.inherit_orchestration_policy_from || ''}
                          onChange={(e) => {
                            const val = e.target.value || '';
                            updateField(ws.id, 'inherit_orchestration_policy_from', val);
                          }}
                          className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md px-3 text-[13px] text-x-ink focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                        >
                          <option value="">This Workspace (Independent)</option>
                          {workspaces
                            .filter((otherWs) => otherWs.id !== ws.id && !wouldCreateLoop(ws.id, otherWs.id))
                            .map((otherWs) => (
                              <option key={otherWs.id} value={otherWs.id}>
                                Inherit from "{otherWs.name}"
                              </option>
                            ))}
                        </select>
                      </Field>

                      {form.inherit_orchestration_policy_from ? (
                        <div className="p-3 bg-x-tint border border-x-accent/30 rounded-md text-[11px] text-x-ink-secondary leading-relaxed flex items-start gap-2">
                          <Sparkles size={13} className="text-x-accent shrink-0 mt-0.5" />
                          <div>
                            This workspace inherits its Orchestration Policy from{' '}
                            <span className="font-semibold text-x-accent">
                              "{inheritedPolicyWorkspace?.name || 'another workspace'}"
                            </span>
                            . Changes can only be made in that workspace.
                          </div>
                        </div>
                      ) : null}

	                      <Field label="Review Provider" hint="CLI used when Code Review spawns a new review agent">
                        <select
                          value={form.review_provider || 'active'}
                          onChange={(e) => updateField(ws.id, 'review_provider', e.target.value)}
                          className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md px-3 text-[13px] text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                        >
                          <option value="active">Active session CLI</option>
                          {cliTypes.map((ct) => (
                            <option key={ct.id} value={ct.id}>{ct.label}</option>
                          ))}
                        </select>
                        <HelpDetails label="Review routing"><p className="text-[11px] text-x-faint mt-1">
                          Existing-session reviews still send to the session you choose; this controls only new review agents.
                        </p></HelpDetails>
                      </Field>
                      </SettingsSection>

                      <SettingsSection id="sessions" title="Sessions & isolation" active={activeSectionId === 'sessions'}>
                      <Field label="Git Worktree Isolation" hint="New sessions get their own branch">
                        <Button
                          onClick={() => updateField(ws.id, 'default_worktree', form.default_worktree ? 0 : 1)}
                          toggleState={Boolean(form.default_worktree)}
                          shape="card"
                          className="min-h-10 w-full justify-start py-2 text-left"
                          aria-label="Toggle Git worktree isolation"
                        >
                          <GitBranch size={12} />
                          <span>{form.default_worktree ? 'Enabled' : 'Disabled'}</span>
                          <span className="flex-1" />
                          <span className="text-[11px] text-x-ink-secondary">
                            {form.default_worktree
                              ? 'Each session works on its own branch'
                              : 'Sessions share the working directory'}
                          </span>
                        </Button>
                      </Field>

                      {/* Native Terminals */}
                      <div className="text-xs font-medium text-x-ink-secondary mt-2 mb-1.5">Native Terminals</div>

                      <Field label="Pop-Out Terminals" hint="Run sessions in native OS terminal windows">
                        <Button
                          onClick={() => updateField(ws.id, 'native_terminals_enabled', form.native_terminals_enabled ? 0 : 1)}
                          toggleState={Boolean(form.native_terminals_enabled)}
                          shape="card"
                          className="min-h-10 w-full justify-start py-2 text-left"
                          aria-label="Toggle pop-out terminals"
                        >
                          <ExternalLink size={12} />
                          <span>{form.native_terminals_enabled ? 'Enabled' : 'Disabled'}</span>
                          <span className="flex-1" />
                          <span className="text-[11px] text-x-ink-secondary">
                            {form.native_terminals_enabled ? 'Pop Out Terminal available in ⌘K' : 'Sessions stay in browser'}
                          </span>
                        </Button>
                        {form.native_terminals_enabled ? (
                          <div className="mt-2 space-y-2">
                            <HelpDetails label="Terminal compatibility"><div className="p-2 bg-x-surface-2 rounded-md border border-x-line-subtle">
                              <p className="text-[11px] text-x-ink-secondary leading-relaxed">
                                <span className="text-x-good font-medium">Works:</span>{' '}
                                Hook-based state tracking (idle/working/prompting), tool &amp; subagent tracking,
                                broadcasting, task board, memory sync, session management
                              </p>
                              <p className="text-[11px] text-x-ink-secondary leading-relaxed mt-1">
                                <span className="text-x-accent-ink font-medium">Unavailable:</span>{' '}
                                Message markers, terminal annotations, image capture, grid layouts,
                                force bar, @-token UI chips, output search
                              </p>
                            </div></HelpDetails>
                            <Button
                              onClick={() => updateField(ws.id, 'auto_register_terminals', form.auto_register_terminals ? 0 : 1)}
                              toggleState={Boolean(form.auto_register_terminals)}
                              shape="card"
                              className="min-h-10 w-full justify-start py-2 text-left"
                              aria-label="Toggle automatic terminal registration"
                            >
                              <Monitor size={12} />
                              <span>{form.auto_register_terminals ? 'Auto-register' : 'Manual only'}</span>
                              <span className="flex-1" />
                              <span className="text-[11px] text-x-ink-secondary">
                                {form.auto_register_terminals
                                  ? 'External CLIs in this workspace auto-join Commander'
                                  : 'Only popped-out sessions are tracked'}
                              </span>
                            </Button>
                            {form.auto_register_terminals ? (
                              <HelpDetails label="Automatic registration"><p className="text-[11px] text-x-faint ml-1">
                                Any supported CLI started in this workspace directory will
                                automatically appear in Commander with full hook tracking.
                                Reinstall hooks after enabling (start.sh does this automatically).
                              </p></HelpDetails>
                            ) : null}
                          </div>
                        ) : null}
                      </Field>

                      <div className="text-xs font-medium text-x-ink-secondary mt-2 mb-1.5">Tab Groups</div>
                      <TabGroupsSection workspaceId={ws.id} />
                      </SettingsSection>

                      <SettingsSection id="coordination" title="Multi-agent coordination" active={activeSectionId === 'coordination'}>
                      {/* W2W: Worker-to-Worker Features */}
                      <div className="text-xs font-medium text-x-ink-secondary mt-2 mb-1.5">Worker-to-Worker (W2W)</div>

                      <CoordinationControls workspace={ws} form={form} updateField={updateField} Field={Field} />

                      <CoordinationSettings workspace={ws} form={form} updateField={updateField} Field={Field} />

                      <div className="flex gap-4">
                        <Field label="Max Workers" hint="Commander worker limit" className="flex-1">
                          <div className="flex items-center gap-2">
                            <Users size={12} className="text-x-faint shrink-0" />
                            <input
                              type="number"
                              min="1"
                              max="10"
                              value={form.commander_max_workers || 3}
                              onChange={(e) => updateField(ws.id, 'commander_max_workers', parseInt(e.target.value) || 3)}
                              className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md px-3 text-[13px] text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                            />
                          </div>
                        </Field>
                        <Field label="Max Test Workers" hint="Testing-capable worker limit" className="flex-1">
                          <div className="flex items-center gap-2">
                            <Users size={12} className="text-x-faint shrink-0" />
                            <input
                              type="number"
                              min="1"
                              max="5"
                              value={form.tester_max_workers || 2}
                              onChange={(e) => updateField(ws.id, 'tester_max_workers', parseInt(e.target.value) || 2)}
                              className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md px-3 text-[13px] text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                            />
                          </div>
                        </Field>
                      </div>

                      <div className={policyReadOnly ? 'opacity-60 pointer-events-none select-none' : undefined}>
                        <OrchestrationPolicyEditor
                          policy={effectivePolicy}
                          cliTypes={cliTypes}
                          modelRegistry={modelRegistry}
                          onChange={updatePolicy}
                          readOnly={policyReadOnly}
                        />
                      </div>
                      </SettingsSection>

                      <SettingsSection id="knowledge" title="Knowledge & memory" active={activeSectionId === 'knowledge'}>
                      {/* Memory */}
                      <div className="text-xs font-medium text-x-ink-secondary mt-2 mb-1.5">Memory</div>
                      <p className="text-[11px] text-x-faint leading-relaxed mb-2">
                        Hub-and-spoke sync of CLI memory files through this workspace.
                        Conflicts between providers are resolved with a three-way git merge so each CLI keeps its own copy in sync without overwriting the others.
                      </p>
                      <MemorySettingsSection workspaceId={ws.id} />

                      <KnowledgeSettings workspace={ws} form={form} updateField={updateField} Field={Field} policy={effectivePolicy} onPolicyChange={updatePolicy} readOnly={policyReadOnly} />

                      <CatalogueSettings workspace={ws} form={form} updateField={updateField} Field={Field} RegistryModelSelect={RegistryModelSelect} modelRegistry={modelRegistry} />

                      </SettingsSection>

                      <SettingsSection id="research" title="Research" active={activeSectionId === 'research'}>
                      {/* Registry-backed research model */}
                      <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
                        <Field label="Research Model">
                          <RegistryModelSelect
                            value={form.research_model || ''}
                            onChange={(value) => updateField(ws.id, 'research_model', value)}
                            registry={modelRegistry}
                            requiredCapability="json"
                            defaultLabel="Provider default"
                            className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md px-3 text-[13px] text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                          />
                        </Field>
                        <Field label="Iterations" hint="Max research loops (default: 5)">
                          <input
                            type="number"
                            min={1}
                            max={20}
                            value={form.research_max_iterations || ''}
                            onChange={(e) => updateField(ws.id, 'research_max_iterations', e.target.value ? Number(e.target.value) : null)}
                            placeholder="5"
                            className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md px-3 text-[13px] text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                          />
                        </Field>
                      </div>
                      </SettingsSection>

                      <SettingsSection id="feature-board" title="Feature board" active={activeSectionId === 'feature-board'}>
                      {/* Automation */}
                      <div className="text-xs font-medium text-x-ink-secondary mt-2 mb-1.5">Automation</div>

                      <Field label="Auto-Execute Tasks" hint="Commander automatically picks up backlog/todo tasks">
                        <Button
                          onClick={() => updateField(ws.id, 'auto_exec_enabled', form.auto_exec_enabled ? 0 : 1)}
                          toggleState={Boolean(form.auto_exec_enabled)}
                          shape="card"
                          className="min-h-10 w-full justify-start py-2 text-left"
                          aria-label="Toggle automatic task execution"
                        >
                          <Play size={12} />
                          <span>{form.auto_exec_enabled ? 'Enabled' : 'Disabled'}</span>
                          <span className="flex-1" />
                          <span className="text-[11px] text-x-ink-secondary">
                            {form.auto_exec_enabled
                              ? 'Tasks auto-dispatched to Commander'
                              : 'Manual dispatch only'}
                          </span>
                        </Button>
                        {form.auto_exec_enabled ? (
                          <p className="text-[11px] text-x-faint mt-1">
                            When enabled, new backlog/todo tasks are automatically sent to the Commander session.
                            Commander must be running. Tasks are dispatched by priority, respecting worker limits.
                          </p>
                        ) : null}
                      </Field>

                      <Field label="Pipeline" hint="Visible stage runs for task automation">
                        <Button
                          onClick={() => updateField(ws.id, 'pipeline_enabled', form.pipeline_enabled ? 0 : 1)}
                          toggleState={Boolean(form.pipeline_enabled)}
                          shape="card"
                          className="min-h-10 w-full justify-start py-2 text-left"
                          aria-label="Toggle pipeline mode"
                        >
                          <RotateCcw size={12} />
                          <span>{form.pipeline_enabled ? 'Enabled' : 'Disabled'}</span>
                          <span className="flex-1" />
                          <span className="text-[11px] text-x-ink-secondary">
	                            {form.pipeline_enabled
	                              ? 'New tasks use visible stage runs'
	                              : 'Tasks use pipelines only when toggled individually'}
                          </span>
                        </Button>
                        {form.pipeline_enabled ? (
                          <p className="text-[11px] text-x-faint mt-1">
	                            New tasks inherit pipeline mode. Stage completion, review, testing, retries, and documentation are tracked as visible pipeline/task state rather than hidden session handoffs.
                          </p>
                        ) : null}
                      </Field>

                      <Field label="Task Dependencies" hint="Declare ordering between tasks via depends_on">
                        <Button
                          onClick={() => updateField(ws.id, 'task_dependencies_enabled', form.task_dependencies_enabled ? 0 : 1)}
                          toggleState={Boolean(form.task_dependencies_enabled)}
                          shape="card"
                          className="min-h-10 w-full justify-start py-2 text-left"
                          aria-label="Toggle task dependencies"
                        >
                          <Link size={12} />
                          <span>{form.task_dependencies_enabled ? 'Enabled' : 'Disabled'}</span>
                          <span className="flex-1" />
                          <span className="text-[11px] text-x-ink-secondary">
                            {form.task_dependencies_enabled
                              ? 'Auto-exec respects task ordering'
                              : 'Tasks dispatched by priority only'}
                          </span>
                        </Button>
                        {form.task_dependencies_enabled ? (
                          <p className="text-[11px] text-x-faint mt-1">
                            Tasks can declare dependencies. Auto-exec holds dependent tasks until prerequisites are done. Commander can set depends_on when creating tasks.
                          </p>
                        ) : null}
                      </Field>

                      {/* Feature Board Documentation */}
                      <div className="text-xs font-medium text-x-ink-secondary mt-2 mb-1.5">Feature Board Documentation</div>

                      <Field label="Mode" hint="How finished work lands on the board">
                        <div className="grid grid-cols-3 gap-1">
                          {BOARD_DOC_MODE_OPTIONS.map((opt) => (
                            <Button
                              key={opt.value}
                              onClick={() => updateField(ws.id, 'board_doc_mode', opt.value)}
                              title={opt.desc}
                              selected={form.board_doc_mode === opt.value}
                            >
                              {opt.label}
                            </Button>
                          ))}
                        </div>
                        <p className="text-[11px] text-x-faint mt-1">
                          {BOARD_DOC_MODE_OPTIONS.find((o) => o.value === form.board_doc_mode)?.desc}
                        </p>
                      </Field>

                      {form.board_doc_mode !== 'off' ? (
                        <div className="flex gap-4">
                          <Field label="New ticket → column" hint="Where document_to_board(create) lands" className="flex-1">
                            <select
                              value={form.board_doc_new_column || 'review'}
                              onChange={(e) => updateField(ws.id, 'board_doc_new_column', e.target.value)}
                              className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md px-3 text-[13px] text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                            >
                              {BOARD_COLUMNS.map((c) => (
                                <option key={c.key} value={c.key}>{c.label}</option>
                              ))}
                            </select>
                          </Field>
                          <Field label="Existing ticket → column" hint="Where document_to_board(update) moves bound tickets" className="flex-1">
                            <select
                              value={form.board_doc_existing_column || 'review'}
                              onChange={(e) => updateField(ws.id, 'board_doc_existing_column', e.target.value)}
                              className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md px-3 text-[13px] text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                            >
                              {BOARD_COLUMNS.map((c) => (
                                <option key={c.key} value={c.key}>{c.label}</option>
                              ))}
                            </select>
                          </Field>
                        </div>
                      ) : null}

                      </SettingsSection>

                      <SettingsSection id="runtime" title="Runtime environment" active={activeSectionId === 'runtime'}>
                      <RuntimeEnvSection
                        env={runtimeEnvs[ws.id]}
                        loading={runtimeLoading[ws.id]}
                        error={runtimeErrors[ws.id]}
                        onRefresh={() => loadRuntimeEnv(ws.id)}
                      />
                      </SettingsSection>

                      <SettingsSection id="preview" title="Preview & experimental" active={activeSectionId === 'preview'}>
                      <Field label="Preview URL" hint="App preview for screenshots and live preview">
                        <input
                          type="text"
                          value={form.preview_url || ''}
                          onChange={(e) => updateField(ws.id, 'preview_url', e.target.value)}
                          placeholder="http://localhost:3000"
                          className="w-full h-8 bg-x-surface-2 border border-x-line rounded-md px-3 text-[13px] text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
                        />
                      </Field>

                      <Field label="IVE Alloy" hint="Workspace-local SDK/MCP generation for the target app">
                        <Button
                          onClick={() => updateField(ws.id, 'alloy_enabled', form.alloy_enabled ? 0 : 1)}
                          toggleState={Boolean(form.alloy_enabled)}
                          shape="card"
                          className="min-h-10 w-full justify-start py-2 text-left"
                          aria-label="Toggle IVE Alloy"
                        >
                          <Sparkles size={12} />
                          <span>{form.alloy_enabled ? 'Enabled' : 'Disabled'}</span>
                          <span className="flex-1" />
                          <span className="text-[11px] text-x-ink-secondary">
                            {form.alloy_enabled
                              ? 'Alloy tickets default to Worker + smoke test'
                              : 'No Alloy-specific routing'}
                          </span>
                        </Button>
                        {form.alloy_enabled ? (
                          <p className="text-[11px] text-x-faint mt-1">
                            Commander labels SDK/OpenAPI/MCP generation tickets as alloy, skips inherited full-pipeline mode by default, and adds Tester only when verification is needed.
                          </p>
                        ) : null}
                      </Field>
                      </SettingsSection>

                      {settingsError && <p role="alert" className="text-[11px] text-x-accent-ink">{settingsError}. No workspace settings have been changed.</p>}
                      {!settingContributions && !settingsError && <p role="status" className="text-[11px] text-x-muted">Loading extension settings…</p>}
                      {/* Save */}
                      <div className="flex justify-end">
                        <Button
                          onClick={() => saveWorkspace(ws.id)}
                          disabled={savingId === ws.id || !settingContributions || Boolean(settingsError)}
                          variant="primary"
                        >
                          {savedId === ws.id ? (
                            <><Check size={12} /> Saved</>
                          ) : savingId === ws.id ? (
                            'Saving…'
                          ) : (
                            <><Save size={12} /> Save</>
                          )}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
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
  const [regenerating, setRegenerating] = useState(false)
  const [regenResult, setRegenResult] = useState(null)

  const handleRegenCodeMemory = async () => {
    if (!isSurfaceAvailable('observatory')) return
    setRegenerating(true)
    setRegenResult(null)
    try {
      await api.regenerateObservatoryProfile(workspaceId)
      setRegenResult({ type: 'success', message: 'Code memory regenerated.' })
      await loadData()
    } catch (err) {
      setRegenResult({ type: 'error', message: err?.message || String(err) })
    } finally {
      setRegenerating(false)
    }
  }


  const loadData = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([
        api.getWorkspaceMemorySettings(workspaceId),
        api.getWorkspaceMemory(workspaceId).catch(() => null),
      ])
      setSettings(s)
      setStatus(st)
    } catch {
      setSettings({ enabled: false, auto_sync: false, memory_max_chars: 4000 })
      setSyncResult({ error: 'Could not load memory settings. No changes were made.' })
    }
  }, [workspaceId])

  useEffect(() => { loadData() }, [loadData])

  const update = async (key, value) => {
    if ((key === 'enabled' || key === 'auto_sync') && value === true &&
        !window.confirm('Allow IVE to read and synchronize existing CLI memories for this workspace? Synchronization can import memories and update CLI files.')) return
    try {
      const saved = await api.updateWorkspaceMemorySettings(workspaceId, { [key]: value })
      setSettings(saved)
      setSyncResult(null)
    } catch (error) { setSyncResult({ error: error?.message || 'Memory settings were not saved' }) }
  }

  const handleSync = async () => {
    if (!window.confirm('Synchronize existing CLI memory files with IVE now? This can import memories and update those files.')) return
    setSyncing(true)
    try {
      const result = await api.syncWorkspaceMemory(workspaceId, undefined, { consent: true })
      setSyncResult(result)
      await loadData()
    } catch (error) { setSyncResult({ error: error?.message || 'Sync failed' }) }
    setSyncing(false)
  }

  const handleStartResolve = async () => {
    if (!window.confirm('Read existing CLI memory files to preview the differences?')) return
    try {
      const diff = await api.getWorkspaceMemoryDiff(workspaceId, { consent: true })
      setDiffData(diff)
      setResolveContent(status?.content || '')
      setResolving(true)
    } catch (error) { setSyncResult({ error: error?.message || 'Could not load the memory differences' }) }
  }

  const handleSubmitResolve = async () => {
    if (!window.confirm('Write this resolved content to CLI memory files?')) return
    try {
      const result = await api.resolveWorkspaceMemory(workspaceId, resolveContent, undefined, { consent: true })
      if (result.error || result.status === 'error' || result.status === 'disabled') {
        setSyncResult({ ...result, error: result.error || 'Memory resolution was not saved' })
        return
      }
      setResolving(false)
      setDiffData(null)
      setSyncResult(null)
      await loadData()
    } catch (error) { setSyncResult({ error: error?.message || 'Memory resolution was not saved' }) }
  }

  if (!settings) return null

  const providers = status?.providers || {}
  const hasConflicts = syncResult?.status === 'conflicts' && syncResult?.conflict_count > 0

  return (
    <div className="space-y-2">
      {syncResult?.error && <p role="alert" className="text-[11px] text-x-accent-ink">{syncResult.error}</p>}
      <p className="text-[11px] text-x-faint">Native CLI memory access is optional. Enabling synchronization can import existing memories and write CLI memory files.</p>
      <Button
        onClick={() => update('enabled', !settings.enabled)}
        toggleState={settings.enabled}
        shape="card"
        className="min-h-10 w-full justify-start py-2 text-left"
        aria-label="Toggle workspace memory sync"
      >
        <Brain size={12} />
        <span>{settings.enabled ? 'Sync Enabled' : 'Sync Disabled'}</span>
        <span className="flex-1" />
        <span className="text-[11px] text-x-ink-secondary">
          {settings.enabled ? 'CLI memory files stay synchronized' : 'Workspace memory sync is paused'}
        </span>
      </Button>
      {settings.enabled && (
        <Button
          onClick={() => update('auto_sync', !settings.auto_sync)}
          toggleState={settings.auto_sync}
          shape="card"
          className="min-h-10 w-full justify-start py-2 text-left"
          aria-label="Toggle automatic workspace memory sync"
        >
          <RefreshCw size={12} />
          <span>{settings.auto_sync ? 'Automatic Sync' : 'Manual Sync'}</span>
          <span className="flex-1" />
          <span className="text-[11px] text-x-ink-secondary">
            {settings.auto_sync ? 'Sync when CLI memory files change' : 'Sync only when requested'}
          </span>
        </Button>
      )}

      <MemoryEngineSettings settings={settings} update={update} />
      <CoordinationMemorySettings settings={settings} update={update} />

      {settings.enabled && (
        <>
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-x-faint">Max chars</label>
            <input
              type="number"
              min={1000}
              max={10000}
              step={500}
              value={settings.memory_max_chars || 4000}
              onChange={(e) => update('memory_max_chars', parseInt(e.target.value) || 4000)}
              className="bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus text-[11px] w-20 px-2 py-1"
            />
            <Button
              onClick={handleSync}
              disabled={syncing}
              size="sm"
              className="ml-auto font-mono"
            >
              {syncing ? 'Syncing...' : 'Sync Now'}
            </Button>
          </div>

          <div className="flex items-center gap-2 pt-1.5 border-t border-x-line-subtle/40">
            <span className="text-[11px] text-x-faint font-mono">Code Memory</span>
            <Button
              type="button"
              onClick={handleRegenCodeMemory}
              disabled={regenerating || !isSurfaceAvailable('observatory')}
              title={isSurfaceAvailable('observatory') ? undefined : 'Code memory regeneration requires the discovery layer'}
              size="sm"
              className="ml-auto font-mono"
            >
              <RefreshCw size={10} className={regenerating ? 'animate-spin' : ''} />
              {regenerating ? 'Regenerating...' : 'Regen Code Memory'}
            </Button>
          </div>
          {regenResult && (
            <div className={`rounded-md border px-2 py-1 font-mono text-[11px] ${
              regenResult.type === 'success'
                ? 'border-x-good/30 bg-x-good/10 text-x-good'
                : 'border-x-accent-ink/30 bg-x-accent-ink/10 text-x-accent-ink'
            }`}>
              {regenResult.message}
            </div>
          )}


          {/* Provider status */}
          {Object.keys(providers).length > 0 && (
            <div className="space-y-1">
              {Object.entries(providers).map(([cli, info]) => (
                <div key={cli} className="flex items-center gap-2 text-[11px] font-mono text-x-faint">
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    !info.file_exists ? 'bg-x-faint/40'
                    : info.synced ? 'bg-x-good'
                    : info.changed ? 'bg-x-accent-ink'
                    : 'bg-x-faint/40'
                  }`} />
                  <span className="text-x-ink-secondary">{cli}</span>
                  <span className="truncate flex-1 opacity-60">{info.filename || '—'}</span>
                  <span>{info.file_exists ? (info.synced ? 'synced' : 'changed') : 'no file'}</span>
                </div>
              ))}
            </div>
          )}

          {status?.last_synced_at && (
            <div className="text-[11px] text-x-faint">
              Last synced: {new Date(status.last_synced_at).toLocaleString()}
            </div>
          )}

          {hasConflicts && !resolving && (
            <Button
              onClick={handleStartResolve}
              className="w-full font-mono"
            >
              <Brain size={10} className="inline mr-1" />
              {syncResult.conflict_count} conflict{syncResult.conflict_count !== 1 ? 's' : ''} — Resolve
            </Button>
          )}

          {resolving && (
            <div className="space-y-2 border border-x-line rounded-md p-2">
              <div className="text-[11px] text-x-accent-ink font-mono">Resolve merge conflicts</div>
              {diffData && Object.entries(diffData).map(([cli, d]) => (
                <details key={cli} className="text-[11px] font-mono text-x-faint">
                  <summary className="cursor-pointer hover:text-x-ink-secondary">{cli}: {d.filename}</summary>
                  <pre className="mt-1 p-1.5 bg-x-surface-2 rounded-md text-[11px] overflow-x-auto max-h-32 overflow-y-auto">{d.diff}</pre>
                </details>
              ))}
              <textarea
                value={resolveContent}
                onChange={(e) => setResolveContent(e.target.value)}
                rows={8}
                className="w-full bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus text-[11px] font-mono p-2 resize-y"
                placeholder="Edit the resolved content..."
              />
              <div className="flex gap-2">
                <Button
                  onClick={handleSubmitResolve}
                  variant="primary"
                  size="sm"
                  className="font-mono"
                >
                  Save Resolution
                </Button>
                <Button
                  onClick={() => { setResolving(false); setDiffData(null) }}
                  size="sm"
                  className="font-mono"
                >
                  Cancel
                </Button>
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
      <HelpDetails label="About tab groups"><p className="text-[11px] text-x-faint">
        Save your current open tabs as a named group. Switch between groups to restore different tab arrangements.
      </p></HelpDetails>

      {wsGroups.length === 0 && (
        <div className="text-[11px] text-x-faint/60 py-2 text-center">
          No tab groups saved yet.
        </div>
      )}

      {wsGroups.map((group) => {
        const validCount = group.session_ids.filter((id) => sessions[id]).length
        return (
          <div
            key={group.id}
            className="flex items-center gap-2 px-3 py-2 rounded-md border border-x-line-subtle bg-x-surface/30"
          >
            <Layers size={12} className="text-x-accent shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] text-x-ink font-medium truncate">{group.name}</div>
              <div className="text-[11px] text-x-faint tabular-nums">
                {validCount}/{group.session_ids.length} sessions available
              </div>
            </div>
            <Button
              onClick={() => activateTabGroup(group)}
              disabled={validCount === 0}
              size="sm"
            >
              open
            </Button>
            <IconButton
              icon={Trash2}
              label={`Delete tab group ${group.name}`}
              variant="destructive"
              size="sm"
              onClick={() => {
                if (confirm(`Delete tab group "${group.name}"?`)) removeTabGroup(group.id)
              }}
            />
          </div>
        )
      })}

      <Button
        icon={Plus}
        onClick={handleSave}
        disabled={currentTabCount === 0}
        className="w-full"
      >
        Save current tabs as group ({currentTabCount} tabs)
      </Button>
    </div>
  )
}

function OrchestrationPolicyEditor({ policy, cliTypes, modelRegistry, onChange, readOnly = false }) {
  const normalized = parseOrchestrationPolicy(policy)

  const setCandidates = (roleId, candidates) => {
    if (readOnly) return
    onChange({
      ...normalized,
      roles: {
        ...normalized.roles,
        [roleId]: { candidates },
      },
    })
  }

  const updateField = (key, value) => {
    if (readOnly) return
    onChange({ ...normalized, [key]: value })
  }

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-x-ink-secondary mt-2 mb-1.5">Orchestration Policy</div>
      <HelpDetails label="About routing"><p className="text-[11px] text-x-faint leading-relaxed">
        Shared model and routing policy used by backend automation, pipelines, summaries, and Commander. Add one or more candidate models per role — higher priority wins, and ties are picked at random. Leave a role empty to use CLI defaults.
      </p></HelpDetails>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {ORCHESTRATION_ROLE_OPTIONS.map((role) => {
          const candidates = normalized.roles?.[role.id]?.candidates || []
          const fallbackCli = cliTypes[0]?.id || 'claude'
          const fallbackModel = getRoleDefaultModel(fallbackCli, role.fallbackRole)

          const updateCandidate = (idx, patch) => {
            const next = candidates.map((c, i) => (i === idx ? { ...c, ...patch } : c))
            setCandidates(role.id, next)
          }
          const removeCandidate = (idx) => {
            setCandidates(role.id, candidates.filter((_, i) => i !== idx))
          }
          const addCandidate = () => {
            setCandidates(role.id, [
              ...candidates,
              { cli_type: fallbackCli, model: '', priority: 1 },
            ])
          }

          return (
            <div key={role.id} className="flex h-full flex-col border border-x-line-subtle rounded-xl p-3 bg-x-surface">
              <div className="mb-2 min-h-[44px]">
                <div className="text-[11px] text-x-ink-secondary font-semibold">{role.label}</div>
                <p className="mt-1 text-[11px] leading-relaxed text-x-faint">{role.hint}</p>
              </div>

              {candidates.length === 0 && (
                <div className="text-[11px] text-x-faint italic px-1 py-1">
                  No candidates — {role.fallbackHint || `falls back to CLI default (${fallbackModel}).`}
                </div>
              )}

              <div className="space-y-1">
                {candidates.map((cand, idx) => {
                  const cli = cand.cli_type || ''
                  const selectedCli = cli || fallbackCli
                  const selectedModel = cand.model ? `${selectedCli}:${cand.model}` : ''
                  return (
                    <div key={idx} className="flex items-center gap-1">
                      <select
                        value={cli}
                        onChange={(e) => updateCandidate(idx, { cli_type: e.target.value, model: '' })}
                        className="bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus text-[11px] py-1 flex-1 min-w-0"
                        title={`${role.label} provider`}
                        disabled={readOnly}
                      >
                        <option value="">Default CLI</option>
                        {cliTypes.map((ct) => (
                          <option key={ct.id} value={ct.id}>{ct.label}</option>
                        ))}
                      </select>
                      <RegistryModelSelect
                        value={selectedModel}
                        onChange={(qualifiedModel) => {
                          if (!qualifiedModel) {
                            updateCandidate(idx, { model: '' })
                            return
                          }
                          const [providerId, model] = splitQualifiedModelId(qualifiedModel)
                          updateCandidate(idx, { cli_type: providerId, model })
                        }}
                        registry={modelRegistry}
                        providerIds={[selectedCli]}
                        providerKind="cli"
                        defaultLabel="Default"
                        className="bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus text-[11px] py-1 flex-1 min-w-0"
                        title={`${role.label} model`}
                        disabled={readOnly}
                      />
                      <input
                        type="number"
                        value={cand.priority}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10)
                          updateCandidate(idx, { priority: Number.isFinite(v) ? v : 1 })
                        }}
                        className="bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus text-[11px] py-1 w-12 text-center"
                        title="Priority — higher wins; ties picked at random"
                        disabled={readOnly}
                      />
                      {!readOnly && (
                        <IconButton
                          icon={Trash2}
                          label="Remove candidate"
                          variant="destructive"
                          size="sm"
                          onClick={() => removeCandidate(idx)}
                        />
                      )}
                    </div>
                  )
                })}
              </div>

              {!readOnly && (
                <Button
                  icon={Plus}
                  onClick={addCandidate}
                  size="sm"
                  className="mt-auto w-full"
                >
                  Add candidate
                </Button>
              )}
            </div>
          )
        })}
      </div>

      <Field label="Routing Instructions" hint="How Brain/Commander should classify, staff, and escalate work">
        <textarea
          value={normalized.routing_instructions}
          onChange={(e) => updateField('routing_instructions', e.target.value)}
          rows={3}
          placeholder="Use planner + plan critic for vague, multi-file, DB/auth/MCP/pipeline work. Use cheap workers for copy/CSS. Escalate after one failed guided retry."
          className="w-full bg-x-surface-2 border border-x-line rounded-md px-3 py-2 text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus resize-none text-xs"
          disabled={readOnly}
        />
      </Field>

      <Field label="Reuse Instructions" hint="When to reuse idle sessions vs start clean">
        <textarea
          value={normalized.reuse_instructions}
          onChange={(e) => updateField('reuse_instructions', e.target.value)}
          rows={3}
          placeholder="Reuse only when digest, files touched, and subsystem fit are strong. Start fresh for high-risk, unrelated, failed, stale, or context-heavy sessions."
          className="w-full bg-x-surface-2 border border-x-line rounded-md px-3 py-2 text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus resize-none text-xs"
          disabled={readOnly}
        />
      </Field>

    </div>
  )
}

function splitQualifiedModelId(value) {
  const separator = value.indexOf(':')
  if (separator < 0) return ['', value]
  return [value.slice(0, separator), value.slice(separator + 1)]
}

function RegistryModelSelect({
  value,
  onChange,
  registry,
  requiredCapability,
  providerIds,
  providerKind,
  defaultLabel,
  className,
  title,
  disabled = false,
}) {
  const healthById = new Map((registry.health || []).map((item) => [item.id, item]))
  const allowedProviderIds = providerIds ? new Set(providerIds) : null
  const providers = (registry.providers || []).filter((provider) => (
    (!allowedProviderIds || allowedProviderIds.has(provider.id))
    && (!providerKind || provider.kind === providerKind)
  ))
  const configuredModelIds = new Set(
    providers.flatMap((provider) => (
      provider.models || []
    ).map((model) => `${provider.id}:${model}`)),
  )

  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={className}
      title={title}
      disabled={disabled}
    >
      <option value="">{defaultLabel}</option>
      {value && !configuredModelIds.has(value) ? (
        <option value={value} disabled>{value} — no longer configured</option>
      ) : null}
      {registry.loading ? (
        <option value="__registry_loading" disabled>Loading model registry…</option>
      ) : registry.error ? (
        <option value="__registry_error" disabled>Model registry unavailable</option>
      ) : null}
      {providers.map((provider) => {
        const health = healthById.get(provider.id)
        const hasCapability = !requiredCapability
          || (provider.capabilities || []).includes(requiredCapability)
        const providerUnavailable = !provider.enabled || !hasCapability
        const status = !provider.enabled
          ? 'disabled'
          : !hasCapability
            ? `missing ${requiredCapability}`
            : health?.reachable
              ? 'reachable'
              : 'unreachable'
        const optionSuffix = !provider.enabled
          ? ' — provider disabled'
          : !hasCapability
            ? ` — missing ${requiredCapability}`
            : health?.reachable
              ? ''
              : ' — provider unreachable'

        return (provider.models || []).length > 0 ? (
          <optgroup
            key={provider.id}
            label={`${provider.id} · ${provider.kind} · ${status}`}
          >
            {provider.models.map((model) => (
              <option
                key={`${provider.id}:${model}`}
                value={`${provider.id}:${model}`}
                disabled={providerUnavailable}
              >
                {model}{optionSuffix}
              </option>
            ))}
          </optgroup>
        ) : null
      })}
    </select>
  )
}

function SettingsSection({ id, title, active, children }) {
  if (!active) return null
  return (
    <section
      id={`workspace-settings-${id}`}
      data-workspace-settings-view={id}
      className="space-y-4 rounded-xl border border-x-line bg-x-surface p-4"
    >
      <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-x-ink">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Field({ label, hint, className, children }) {
  return (
    <div className={className}>
      <div className="flex items-baseline gap-2 mb-1.5">
        <label className="text-[11px] text-x-ink-secondary font-medium">{label}</label>

      </div>
      {children}
      {hint && <HelpDetails label={`About ${label}`}><p>{hint}</p></HelpDetails>}
    </div>
  )
}

function RuntimeEnvSection({ env, loading, error, onRefresh }) {
  const sections = env?.sections || {}
  const python = sections.python
  const jsProjects = (sections.javascript?.projects || []).filter((project) =>
    ['test', 'build', 'lint', 'typecheck', 'dev'].some((key) => project.commands?.[key])
  )
  const rustProjects = sections.rust?.projects || []
  const commandGroups = [
    ['Go', sections.go?.commands],
    ['Java', sections.java?.commands],
    ['Native', sections.native?.commands],
  ].filter(([, commands]) => commands && Object.keys(commands).length)
  const hasContent = Boolean(python || jsProjects.length || rustProjects.length || commandGroups.length)

  return (
    <div className="border border-x-line-subtle rounded-md bg-x-surface/40 p-2.5">
      <div className="flex items-center gap-2 mb-2">
        <Monitor size={12} className="text-x-faint" />
        <span className="text-[11px] text-x-ink-secondary font-medium">Tester command hints</span>
        <span className="flex-1" />
        <IconButton
          icon={RefreshCw}
          label="Refresh detected runtime environment"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          className={loading ? 'animate-spin' : ''}
        />
      </div>

      {error ? (
        <div className="text-[11px] text-x-accent-ink">{error}</div>
      ) : loading && !env ? (
        <div className="text-[11px] text-x-faint">Detecting...</div>
      ) : !hasContent ? (
        <div className="text-[11px] text-x-faint">No runtime markers detected.</div>
      ) : (
        <div className="space-y-2">
          {python ? (
            <RuntimeGroup title="Python">
              <CommandRow label="python" command={python.preferred?.command} />
              <CommandRow label="pip" command={python.commands?.pip} />
              {(python.commands?.tests || []).slice(0, 3).map((cmd) => (
                <CommandRow key={cmd} label="test" command={cmd} />
              ))}
              {python.preferred?.reason ? (
                <div className="text-[11px] text-x-faint">Reason: {python.preferred.reason}</div>
              ) : null}
            </RuntimeGroup>
          ) : null}

          {jsProjects.length ? (
            <RuntimeGroup title="JavaScript / TypeScript">
              {jsProjects.slice(0, 4).map((project) => (
                <div key={project.path} className="space-y-1">
                  <div className="text-[11px] text-x-faint">
                    <span className="font-mono text-x-ink-secondary">{project.path}</span>
                    <span> uses </span>
                    <span className="font-mono text-x-ink-secondary">{project.package_manager}</span>
                  </div>
                  {['test', 'build', 'lint', 'typecheck'].map((key) => (
                    <CommandRow key={`${project.path}-${key}`} label={key} command={project.commands?.[key]} />
                  ))}
                </div>
              ))}
            </RuntimeGroup>
          ) : null}

          {rustProjects.length ? (
            <RuntimeGroup title="Rust">
              {sections.rust?.toolchain_file ? (
                <div className="text-[11px] text-x-faint">
                  Toolchain: <span className="font-mono text-x-ink-secondary">{sections.rust.toolchain_file}</span>
                </div>
              ) : null}
              {rustProjects.slice(0, 3).map((project) => (
                <div key={project.path} className="space-y-1">
                  <div className="text-[11px] font-mono text-x-ink-secondary">{project.path}</div>
                  <CommandRow label="test" command={project.commands?.test} />
                  <CommandRow label="check" command={project.commands?.check} />
                </div>
              ))}
            </RuntimeGroup>
          ) : null}

          {commandGroups.map(([title, commands]) => (
            <RuntimeGroup key={title} title={title}>
              {Object.entries(commands).map(([label, command]) => (
                <CommandRow key={`${title}-${label}`} label={label} command={command} />
              ))}
            </RuntimeGroup>
          ))}
        </div>
      )}
    </div>
  )
}

function RuntimeGroup({ title, children }) {
  return (
    <div>
      <div className="text-xs font-medium text-x-ink-secondary mb-1.5">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function CommandRow({ label, command }) {
  if (!command) return null
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <span className="text-x-faint w-14 shrink-0">{label}</span>
      <code className="font-mono text-x-ink-secondary break-all">{command}</code>
    </div>
  )
}
