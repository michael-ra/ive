import useDialogDrag from '../../hooks/useDialogDrag'
import ProviderLogo from '../ui/ProviderLogo'
import { useState, useEffect, useRef, useId } from 'react'
import { X, LayoutGrid, Sparkles, FolderOpen, ChevronDown, ChevronRight, Shield, ShieldAlert, Server, Check, Flame, MessageSquare, Crown, FlaskConical, BookOpenCheck, Plus, Terminal } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import {
  getCliTypes,
  getModelsForCli,
  getPermissionModesForCli,
  getEffortLevelsForCli,
  getEffortOptionsForCli,
  getDefaultModel,
  getDefaultPermissionMode
} from '../../lib/constants'
import { Button } from '../ui'
import { isQuickWorkspace, nameFromText, sendWhenAgentReady, shortenHome } from '../../lib/quickStart'
import { SHELL_CLI, SHELL_LABEL, createTerminalSession } from '../../lib/shellSession'
import { emitTourEvent } from '../../lib/guidedTour'

function parseAccountModels(account) {
  return String(account?.model_aliases || '')
    .split(/[\n,]+/)
    .map((m) => m.trim())
    .filter(Boolean)
}

function isClaudeGatewayAccount(account) {
  return ['z_ai', 'z_ai_glm51', 'anthropic_gateway'].includes(account?.api_key_provider)
}

function isAccountCompatibleWithCli(account, cliType) {
  if (!account?.api_key_masked) {
    return account?.type === 'oauth'
      && account.cli_type === cliType
      && Boolean(account.credentials_verified_at)
      && account.credentials_present === true
      && account.status === 'active'
  }
  const provider = account.api_key_provider || 'anthropic'
  if (['anthropic', 'z_ai', 'z_ai_glm51', 'anthropic_gateway'].includes(provider)) return cliType === 'claude'
  if (provider === 'google') return cliType === 'gemini' || cliType === 'antigravity'
  if (provider === 'openai') return cliType === 'codex'
  return true
}

function preserveOrFallbackModel(cliType, account, currentModel) {
  const aliases = parseAccountModels(account)
  if (!account || !isClaudeGatewayAccount(account)) return currentModel || getDefaultModel(cliType)
  if (!aliases.length) return currentModel || getDefaultModel(cliType)

  const baseModelIds = getModelsForCli(cliType).map((m) => m.id)
  if (currentModel && (baseModelIds.includes(currentModel) || aliases.includes(currentModel))) {
    return currentModel
  }
  return aliases[0] || getDefaultModel(cliType)
}


const TESTING_MCP_ID = 'builtin-playwright'
const TESTING_GUIDELINE_ID = 'builtin-testing-agent'
const DOCUMENTATION_MCP_IDS = ['builtin-documentor', 'builtin-playwright']
const DOCUMENTATION_GUIDELINE_ID = 'builtin-documentation-agent'

export default function NewSessionDialog({ workspaceId, onClose }) {
  const formId = useId()
  const cliProfiles = useStore((s) => s.cliProfiles)
  const cliTypes = getCliTypes()
  void cliProfiles
  const [cliType, setCliType] = useState('claude')
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [model, setModel] = useState('sonnet')
  const [mode, setMode] = useState('auto')
  const [effort, setEffort] = useState('')  // '' = CLI default (shown with its real value)
  const [outputStyle, setOutputStyle] = useState('')
  const [outputStyles, setOutputStyles] = useState([])
  const [templates, setTemplates] = useState([])
  const [accounts, setAccounts] = useState([])
  const [accountId, setAccountId] = useState('')
  const [accountTouched, setAccountTouched] = useState(false)
  const [appliedTemplate, setAppliedTemplate] = useState(null)
  
  // Guideline picker
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
  const [enableTesting, setEnableTesting] = useState(false)
  const [testingShowBrowser, setTestingShowBrowser] = useState(false)
  const [enableDocumentation, setEnableDocumentation] = useState(false)
  const [docAllowAllEdits, setDocAllowAllEdits] = useState(false)
  const [enableSecure, setEnableSecure] = useState(false)
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [newTemplateName, setNewTemplateName] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showOptions, setShowOptions] = useState(false)
  const [createError, setCreateError] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [linkedTaskId] = useState(() => useStore.getState().newSessionPrefillTaskId || null)
  // "Terminal": the user's login shell in this project, no agent settings.
  const isShell = cliType === SHELL_CLI

  // Pre-populate worktree from workspace default
  const workspaces = useStore((s) => s.workspaces)
  const activeWorkspace = workspaces.find((w) => w.id === workspaceId)
  const worktreeSupported = cliProfiles?.[cliType]?.features?.WORKTREE?.supported === true

  useEffect(() => {
    // A workspace preference must never imply isolation that this CLI cannot
    // create. Re-evaluate when switching providers or loading their profiles.
    setWorktree(worktreeSupported && Boolean(activeWorkspace?.default_worktree))
  }, [workspaceId, activeWorkspace?.default_worktree, worktreeSupported])

  useEffect(() => {
    if (cliType !== SHELL_CLI && cliTypes.length > 0 && !cliTypes.some((item) => item.id === cliType)) {
      const nextCli = cliTypes[0].id
      setCliType(nextCli)
      setModel(getDefaultModel(nextCli))
    }
  }, [cliProfiles, cliType])

  // One-shot purpose prefill (e.g. "Edit in session" on an attached agentario
  // agent system). Consumed on mount so a later manual open starts clean.
  useEffect(() => {
    const store = useStore.getState()
    const prefill = store.newSessionPrefillPurpose
    if (prefill) {
      setPurpose(String(prefill))
    }
    if (store.newSessionPrefillName) setName(String(store.newSessionPrefillName))
    useStore.setState({
      newSessionPrefillPurpose: null,
      newSessionPrefillTaskId: null,
      newSessionPrefillName: null,
    })
  }, [])

  const handleSaveAsTemplate = async (e) => {
    if (e) e.preventDefault()
    if (!newTemplateName.trim()) return
    const { guidelineIds, mcpServerIds } = capabilitySelections()
    try {
      const t = await api.createTemplate({
        name: newTemplateName.trim(),
        cli_type: cliType,
        model,
        permission_mode: mode,
        effort: getEffortLevelsForCli(cliType).length > 0 ? (effort || null) : undefined,
        plan_model: planModel || undefined,
        execute_model: executeModel || undefined,
        auto_approve_plan: autoApprovePlan ? 1 : 0,
        account_id: accountId || undefined,
        guideline_ids: guidelineIds,
        mcp_server_ids: mcpServerIds,
      })
      setTemplates((prev) => [...prev, t])
      setAppliedTemplate(t)
      setSavingTemplate(false)
      setNewTemplateName('')
    } catch (err) {
      alert('Failed to save preset: ' + err.message)
    }
  }

  useEffect(() => {
    api.getTemplates().then(setTemplates).catch(() => {})
    api.getAccounts().then(setAccounts).catch(() => {})
    api.getOutputStyles().then(setOutputStyles).catch(() => {})
    api.getGuidelines().then((gs) => {
      setAllGuidelines(gs)
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

  const resetToBlank = () => {
    setAppliedTemplate(null)
    setName('')
    setPurpose('')
    setCliType('claude')
    setModel(getDefaultModel('claude'))
    setMode(getDefaultPermissionMode('claude'))
    setEffort('')
    setPlanModel('')
    setExecuteModel('')
    setAutoApprovePlan(false)
    setEnableTesting(false)
    setTestingShowBrowser(false)
    setEnableDocumentation(false)
    setDocAllowAllEdits(false)
    setEnableSecure(false)
    setAccountId('')
    setAccountTouched(false)
    
    const defaultGuidelines = new Set(allGuidelines.filter((g) => g.is_default).map((g) => g.id))
    setSelectedGuidelineIds(defaultGuidelines)
    const defaultMcps = new Set(allMcpServers.filter((s) => s.default_enabled).map((s) => s.id))
    setSelectedMcpServerIds(defaultMcps)
  }

  const applyTemplate = (tmpl) => {
    setAppliedTemplate(tmpl)
    if (tmpl.name) setName(tmpl.name)
    if (tmpl.purpose) setPurpose(tmpl.purpose)
    const cli = tmpl.cli_type || 'claude'
    setCliType(cli)
    setModel(tmpl.model || getDefaultModel(cli))
    setMode(tmpl.permission_mode || getDefaultPermissionMode(cli))
    setEffort(tmpl.effort || '')
    setPlanModel(tmpl.plan_model || '')
    setExecuteModel(tmpl.execute_model || '')
    setAutoApprovePlan(!!tmpl.auto_approve_plan)
    setAccountId(tmpl.account_id || '')
    setAccountTouched(!!tmpl.account_id)
    
    try {
      const gids = JSON.parse(tmpl.guideline_ids || '[]')
      setSelectedGuidelineIds(new Set(gids))
    } catch (e) {
      const defaultGuidelines = new Set(allGuidelines.filter((g) => g.is_default).map((g) => g.id))
      setSelectedGuidelineIds(defaultGuidelines)
    }
    
    try {
      const mids = JSON.parse(tmpl.mcp_server_ids || '[]')
      setSelectedMcpServerIds(new Set(mids))
    } catch (e) {
      const defaultMcps = new Set(allMcpServers.filter((s) => s.default_enabled).map((s) => s.id))
      setSelectedMcpServerIds(defaultMcps)
    }
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

  const capabilitySelections = () => {
    const guidelineSet = new Set(selectedGuidelineIds)
    const mcpSet = new Set(selectedMcpServerIds)
    const mcpOverrides = {}
    const tags = []
    let sessionType

    if (enableSecure) {
      // Secure is a distinct worker TYPE (not just a capability tag): the
      // backend keys the offensive system prompt, disallowed-tools, policy
      // role and the builtin-secure MCP surface off session_type='secure'
      // at create_session — so we set the type here and let it auto-attach.
      sessionType = 'secure'
      tags.push('capability_secure')
    }

    if (enableTesting) {
      mcpSet.add(TESTING_MCP_ID)
      mcpOverrides[TESTING_MCP_ID] = { auto_approve_override: 1 }
      guidelineSet.add(TESTING_GUIDELINE_ID)
      tags.push('capability_testing')
      if (testingShowBrowser) tags.push('tester_headed')
    }

    if (enableDocumentation) {
      DOCUMENTATION_MCP_IDS.forEach((id) => {
        mcpSet.add(id)
        mcpOverrides[id] = { auto_approve_override: 1 }
      })
      guidelineSet.add(DOCUMENTATION_GUIDELINE_ID)
      tags.push('capability_documentation')
      if (docAllowAllEdits) tags.push('unrestricted_edit')
    }

    return {
      guidelineIds: [...guidelineSet],
      mcpServerIds: [...mcpSet],
      mcpOverrides,
      tags,
      sessionType,
    }
  }

  const handleCreate = async (e) => {
    if (e) e.preventDefault()
    if (isCreating) return
    if (isShell) {
      setCreateError('')
      setIsCreating(true)
      try {
        await createTerminalSession(workspaceId, { name: name.trim() || SHELL_LABEL })
        onClose()
      } catch (err) {
        console.error('Failed to create terminal:', err)
        setCreateError(err?.message || 'The terminal could not be created')
      } finally {
        setIsCreating(false)
      }
      return
    }
    if (!cliTypes.some((item) => item.id === cliType)) {
      setCreateError('No installed and enabled CLI is available for this session.')
      return
    }
    setCreateError('')
    setIsCreating(true)
    try {
      let session
      const { guidelineIds, mcpServerIds, mcpOverrides, tags, sessionType } = capabilitySelections()
      if (appliedTemplate?.id) {
        session = await api.applyTemplate(appliedTemplate.id, workspaceId, {
          name: name.trim() || undefined,
          purpose: purpose.trim() || undefined,
          cli_type: cliType,
          model,
          permission_mode: mode,
          session_type: sessionType || undefined,
          effort: getEffortLevelsForCli(cliType).length > 0 ? (effort || null) : undefined,
          plan_model: planModel || undefined,
          execute_model: executeModel || undefined,
          auto_approve_plan: autoApprovePlan || undefined,
          account_id: accountId || null,
          guideline_ids: guidelineIds,
          mcp_server_ids: mcpServerIds,
          mcp_overrides: mcpOverrides,
          tags,
          worktree: worktreeSupported && worktree ? 1 : 0,
          task_id: linkedTaskId || undefined,
        })
      } else {
        session = await api.createSession(workspaceId, {
          name: name.trim() || nameFromText(purpose),
          purpose: purpose.trim() || undefined,
          model,
          permission_mode: mode,
          session_type: sessionType || undefined,
          effort: getEffortLevelsForCli(cliType).length > 0 ? (effort || null) : undefined,
          output_style: outputStyle || undefined,
          account_id: accountId || undefined,
          cli_type: cliType,
          plan_model: planModel || undefined,
          execute_model: executeModel || undefined,
          auto_approve_plan: autoApprovePlan || undefined,
          worktree: worktreeSupported && worktree ? 1 : 0,
          task_id: linkedTaskId || undefined,
          guideline_ids: guidelineIds,
          mcp_server_ids: mcpServerIds,
          mcp_overrides: mcpOverrides,
          tags,
        })
      }

      useStore.getState().addSession(session)
      emitTourEvent('session-created', { workspaceId, sessionId: session.id, cliType: session.cli_type || cliType })

      // The task description is the agent's first message, delivered the
      // same way as a quick start (after addSession's own PTY start).
      const firstMessage = purpose.trim()
      if (firstMessage) setTimeout(() => { sendWhenAgentReady(session.id, firstMessage) }, 0)

      if (appliedTemplate?.conversation_turns) {
        const turns = JSON.parse(appliedTemplate.conversation_turns || '[]')
        if (turns.length > 0) {
          useStore.getState().setSessionStatus(session.id, 'replaying')
          setTimeout(() => {
            const ws = useStore.getState().ws
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                action: 'replay_turns',
                session_id: session.id,
                turns,
              }))
            }
          }, 2000)
        }
      }

      onClose()
    } catch (err) {
      console.error('Failed to create session:', err)
      setCreateError(err?.message || 'Session could not be created')
    } finally {
      setIsCreating(false)
    }
  }

  const compatibleAccounts = accounts.filter((account) => isAccountCompatibleWithCli(account, cliType))
  const selectedAccount = accounts.find((account) => account.id === accountId)
  const accountModelAliases = parseAccountModels(selectedAccount)
  const modelOptions = (() => {
    const base = getModelsForCli(cliType)
    const merged = [...base]
    if (selectedAccount && isAccountCompatibleWithCli(selectedAccount, cliType)) {
      for (const id of accountModelAliases) {
        if (!merged.some((m) => m.id === id)) {
          merged.push({ id, label: id })
        }
      }
    }
    if (model && !merged.some((m) => m.id === model)) {
      merged.push({ id: model, label: model })
    }
    return merged
  })()

  useEffect(() => {
    if (accountId && !compatibleAccounts.some((account) => account.id === accountId)) {
      setAccountId('')
    }
  }, [cliType, accounts.length])

  useEffect(() => {
    if (accountTouched || accountId || compatibleAccounts.length === 0) return
    const def = compatibleAccounts.find((account) => account.is_default)
    if (!def) return
    setAccountId(def.id)
    setModel((prev) => preserveOrFallbackModel(cliType, def, prev))
  }, [accounts.length, cliType, accountTouched, accountId])

  const selectAccount = (nextAccountId) => {
    setAccountTouched(true)
    setAccountId(nextAccountId)
    const account = accounts.find((a) => a.id === nextAccountId)
    setModel((prev) => preserveOrFallbackModel(cliType, account, prev))
  }

  // One accent, always — the redesign retires the per-CLI-engine hue switch
  // (blue/emerald/purple/indigo) for the single periwinkle-indigo accent.
  // Engines stay visually distinct via their ProviderLogo glyph, not chrome
  // color. Kept as a function (same call shape) to minimize the diff.
  const getThemeAccents = () => ({
    accent: 'accent',
    border: 'border-x-accent/30',
    borderFocus: 'focus:border-x-accent focus:ring-[3px] focus:ring-x-focus',
    text: 'text-x-accent',
    bg: 'bg-x-tint',
    cardBgActive: 'bg-x-tint border-x-accent/45',
    buttonBg: 'bg-x-accent hover:bg-x-accent-ink',
  })

  const accents = getThemeAccents(cliType)
  const dialogRef = useRef(null)
  const drag = useDialogDrag(dialogRef)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-x-scrim backdrop-blur-[4px]">
      <div ref={dialogRef} data-tour="session-setup" role="dialog" aria-modal="true" aria-labelledby="new-session-dialog-title" className="x-panel w-[760px] max-h-[90vh] flex flex-col scale-in overflow-hidden shadow-x-3 relative border border-x-line rounded-xl">
        {/* Header */}
        <div {...drag.headerProps} className="flex items-center justify-between px-6 py-4 border-b border-x-line">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-x-accent/10 border border-x-accent/30">
              <Terminal size={16} className={accents.text} />
            </div>
            <div>
              <h2 id="new-session-dialog-title" className="text-[18px] font-semibold text-x-ink font-sans">
                {isShell ? 'New terminal' : 'New AI session'}
              </h2>
              {activeWorkspace && (
                <p className="text-[11px] text-x-muted font-mono mt-0.5" data-session-setup-where title={activeWorkspace.path}>
                  {isQuickWorkspace(activeWorkspace)
                    ? `No project · start folder ${shortenHome(activeWorkspace.path)}`
                    : `Project: ${activeWorkspace.name || activeWorkspace.path.split('/').pop()} · ${shortenHome(activeWorkspace.path)}`}
                </p>
              )}
            </div>
          </div>
          <Button type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="p-1.5 hover:bg-x-hover text-x-muted hover:text-x-ink-secondary transition-colors duration-[80ms]"
          >
            <X size={18} />
          </Button>
        </div>

        {!isShell && <div className="ive-new-session-summary"><span>Start with your task and assistant. You can adjust the setup whenever you need.</span><button type="button" aria-expanded={showOptions} onClick={()=>{setShowOptions(!showOptions);setShowAdvanced(true)}}>{showOptions?'Fewer options':'More options & presets'}</button></div>}
        {/* Content Panel (Spacious Two Columns) */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 flex flex-col sm:flex-row gap-6 min-h-0 scrollbar-thin">
          
          {/* Left Column: Core Configuration */}
          <div className="flex-none sm:flex-1 flex flex-col gap-5 min-w-0">
            
            {/* Define Task */}
            <div className="space-y-3.5 p-4 rounded-lg border border-x-line bg-x-surface">
              <div className="text-[12px] font-medium text-x-ink-secondary flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${accents.text} bg-current`} />
                {isShell ? '1. Name your terminal' : '1. Describe your task'}
              </div>
              <div className="space-y-3">
                <div className="space-y-1" style={isShell ? { display: 'none' } : undefined}>
                  <label htmlFor={`${formId}-purpose`} className="text-xs font-medium text-x-ink-secondary">
                    What would you like to do?
                  </label>
                  <textarea
                    id={`${formId}-purpose`}
                    rows={3}
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                    placeholder="For example: explain this project, fix the sign-in page, or add a contact form."
                    className={`w-full px-3 py-2 text-[13px] bg-x-surface-2 border border-x-line hover:border-x-line-strong rounded-md text-x-ink placeholder-x-muted focus:outline-none ${accents.borderFocus} transition-colors duration-[80ms] resize-none`}
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor={`${formId}-name`} className="text-xs font-medium text-x-ink-secondary">
                    Session name <span className="text-[11px] text-x-faint">(optional)</span>
                  </label>
                  <input
                    id={`${formId}-name`}
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={isShell ? 'Terminal' : 'For example: Fix sign-in'}
                    className={`w-full px-3 py-2 text-[13px] bg-x-surface-2 border border-x-line hover:border-x-line-strong rounded-md text-x-ink placeholder-x-muted focus:outline-none ${accents.borderFocus} transition-colors duration-[80ms]`}
                  />
                </div>
              </div>
            </div>

            {/* Choose CLI Engine */}
            <div className="space-y-3.5 p-4 rounded-lg border border-x-line bg-x-surface">
              <div className="text-[12px] font-medium text-x-ink-secondary flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${accents.text} bg-current`} />
                2. Choose your assistant
              </div>
              
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div id={`${formId}-assistant-label`} className="text-xs font-medium text-x-ink-secondary">
                    AI assistant
                  </div>
                  <div role="group" aria-labelledby={`${formId}-assistant-label`} className="grid grid-cols-2 gap-2">
                    {cliTypes.map((ct) => {
                      const isActive = cliType === ct.id
                      // One accent for every engine — providers stay visually
                      // distinct via their ProviderLogo glyph, not chrome hue.
                      const engineBorderClass = isActive
                        ? 'border-x-accent/45'
                        : 'border-x-line hover:border-x-line-strong'
                      const engineTextClass = isActive
                        ? 'text-x-ink'
                        : 'text-x-ink-secondary hover:text-x-ink'
                      const engineBgClass = isActive
                        ? 'bg-x-tint'
                        : 'bg-x-surface-2 hover:bg-x-hover'

                      return (
                        <button
                          key={ct.id}
                          type="button"
                          aria-pressed={isActive}
                          onClick={() => {
                            setCliType(ct.id)
                            setModel(getDefaultModel(ct.id))
                            setMode(getDefaultPermissionMode(ct.id))
                            setAccountId('')
                            setAccountTouched(false)
                          }}
                          className={`flex items-center gap-2.5 p-2.5 rounded-lg border text-left transition-colors duration-[80ms] text-[13px] font-medium ${engineBorderClass} ${engineTextClass} ${engineBgClass}`}
                        >
                          <ProviderLogo provider={ct.id} className="w-5 h-5 shrink-0" />
                          <span className="min-w-0 leading-snug">{ct.label}</span>
                          {isActive && <Check size={12} className={`ml-auto ${accents.text}`} />}
                        </button>
                      )
                    })}
                    {/* Not an AI: the login shell in this project, like Terminal.app. */}
                    <button
                      type="button"
                      aria-pressed={isShell}
                      data-cli-choice="shell"
                      onClick={() => {
                        setCliType(SHELL_CLI)
                        setAccountId('')
                        setAccountTouched(false)
                      }}
                      title="Your login shell in this project folder, no AI"
                      className={`flex items-center gap-2.5 p-2.5 rounded-lg border text-left transition-colors duration-[80ms] text-[13px] font-medium ${isShell ? 'border-x-accent/45 text-x-ink bg-x-tint' : 'border-x-line hover:border-x-line-strong text-x-ink-secondary hover:text-x-ink bg-x-surface-2 hover:bg-x-hover'}`}
                    >
                      <Terminal size={16} className="shrink-0 text-x-ink-secondary" />
                      <span className="truncate">{SHELL_LABEL}</span>
                      {isShell && <Check size={12} className={`ml-auto ${accents.text}`} />}
                    </button>
                  </div>
                </div>

                {isShell && (
                  <p className="text-[11px] text-x-muted leading-relaxed">
                    Opens your login shell in {activeWorkspace ? activeWorkspace.path.split('/').pop() : 'this project'}, like a Terminal window. No AI, no model or permissions.
                  </p>
                )}
                {!isShell && <details className="ive-session-options"><summary>Model & permissions · {modelOptions.find(m=>m.id===model)?.label || model} · {getPermissionModesForCli(cliType).find(m=>m.id===mode)?.label || mode}</summary>
                <div className="grid grid-cols-2 gap-3 pt-1" style={isShell ? { display: 'none' } : undefined}>
                  <div className="space-y-1">
                    <label htmlFor={`${formId}-model`} className="text-xs font-medium text-x-ink-secondary">AI model</label>
                    <select
                      id={`${formId}-model`}
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      className={`w-full px-3 py-2 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none ${accents.borderFocus} transition-colors duration-[80ms]`}
                    >
                      {modelOptions.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={`${formId}-permissions`} className="text-xs font-medium text-x-ink-secondary">Permissions</label>
                    <select
                      id={`${formId}-permissions`}
                      aria-describedby={`${formId}-permissions-help`}
                      value={mode}
                      onChange={(e) => setMode(e.target.value)}
                      className={`w-full px-3 py-2 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none ${accents.borderFocus} transition-colors duration-[80ms]`}
                    >
                      {getPermissionModesForCli(cliType).map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <p id={`${formId}-permissions-help`} className="text-[11px] text-x-muted leading-relaxed" style={isShell ? { display: 'none' } : undefined}>
                  Permissions control which actions the assistant can take and when it asks you to approve them.
                </p>
                </details>}
              </div>
            </div>

            {/* Capabilities */}
            <details className="ive-session-options space-y-3.5 p-4 rounded-lg border border-x-line bg-x-surface" style={isShell ? { display: 'none' } : undefined}>
              <summary className="text-[12px] font-medium text-x-ink-secondary">
                <span className={`w-1.5 h-1.5 rounded-full ${accents.text} bg-current`} />
                Optional tools & capabilities
              </summary>
              <div className="space-y-2">
                <div
                  onClick={(e) => {
                    if (e.target.closest('.sub-option')) return
                    setEnableTesting(!enableTesting)
                  }}
                  className={`flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer select-none transition-colors duration-[80ms] ${
                    enableTesting
                      ? accents.cardBgActive
                      : 'border-x-line bg-x-surface-2 hover:bg-x-hover'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={enableTesting}
                    onChange={(e) => setEnableTesting(e.target.checked)}
                    onClick={(e) => e.stopPropagation()}
                    className="mt-0.5 h-4 w-4 rounded border-x-tint-line bg-x-surface-2 cursor-pointer"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-x-ink">
                      <FlaskConical size={13} className="text-x-accent" />
                      Testing
                    </div>
                    <p className="mt-0.5 text-[11px] text-x-muted leading-relaxed">
                      Attach browser automation and the testing guideline to this worker.
                    </p>
                    {enableTesting && (
                      <label className="sub-option mt-2 flex items-center gap-1.5 text-[11px] text-x-muted cursor-pointer">
                        <input
                          type="checkbox"
                          checked={testingShowBrowser}
                          onChange={(e) => setTestingShowBrowser(e.target.checked)}
                          onClick={(e) => e.stopPropagation()}
                          className="h-3 w-3 rounded border-x-tint-line bg-x-surface-2"
                        />
                        Show browser window
                      </label>
                    )}
                  </div>
                </div>

                <div
                  onClick={(e) => {
                    if (e.target.closest('.sub-option')) return
                    setEnableDocumentation(!enableDocumentation)
                  }}
                  className={`flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer select-none transition-colors duration-[80ms] ${
                    enableDocumentation
                      ? accents.cardBgActive
                      : 'border-x-line bg-x-surface-2 hover:bg-x-hover'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={enableDocumentation}
                    onChange={(e) => setEnableDocumentation(e.target.checked)}
                    onClick={(e) => e.stopPropagation()}
                    className="mt-0.5 h-4 w-4 rounded border-x-tint-line bg-x-surface-2 cursor-pointer"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-x-ink">
                      <BookOpenCheck size={13} className="text-x-accent" />
                      Documentation
                    </div>
                    <p className="mt-0.5 text-[11px] text-x-muted leading-relaxed">
                      Attach documentation tools, screenshots, and the documentation guideline.
                    </p>
                    {enableDocumentation && (
                      <label className="sub-option mt-2 flex items-center gap-1.5 text-[11px] text-x-muted cursor-pointer">
                        <input
                          type="checkbox"
                          checked={docAllowAllEdits}
                          onChange={(e) => setDocAllowAllEdits(e.target.checked)}
                          onClick={(e) => e.stopPropagation()}
                          className="h-3 w-3 rounded border-x-tint-line bg-x-surface-2"
                        />
                        Allow edits outside docs
                      </label>
                    )}
                  </div>
                </div>

                <div
                  onClick={() => setEnableSecure(!enableSecure)}
                  className={`flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer select-none transition-colors duration-[80ms] ${
                    enableSecure
                      ? accents.cardBgActive
                      : 'border-x-line bg-x-surface-2 hover:bg-x-hover'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={enableSecure}
                    onChange={(e) => setEnableSecure(e.target.checked)}
                    onClick={(e) => e.stopPropagation()}
                    className="mt-0.5 h-4 w-4 rounded border-x-tint-line bg-x-surface-2 cursor-pointer"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-x-ink">
                      <ShieldAlert size={13} className="text-x-accent-ink" />
                      Security testing (Secure)
                    </div>
                    <p className="mt-0.5 text-[11px] text-x-muted leading-relaxed">
                      Offensive self-test worker — drives a sandboxed Kali box clamped to a scope you authorize. No host shell; every command is scope-vetted.
                    </p>
                  </div>
                </div>
              </div>
            </details>

          </div>

          {/* Right Column: Presets & Advanced Configurations */}
          <div className="flex-none sm:flex-1 flex flex-col gap-5 min-w-0" style={isShell || !showOptions ? { display: 'none' } : undefined}>
            
            {/* Session Presets */}
            <div className="space-y-3.5 p-4 rounded-lg border border-x-line bg-x-surface">
              <div className="flex items-center justify-between">
                <label className="text-[12px] font-medium text-x-ink-secondary flex items-center gap-1.5">
                  <LayoutGrid size={12} className={accents.text} />
                  <span>Session Presets</span>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('open-panel', { detail: 'manage-templates' }))
                    onClose()
                  }}
                  className="text-[11px] text-x-muted hover:text-x-ink flex items-center gap-1 transition-colors duration-[80ms]"
                >
                  <FolderOpen size={11} />
                  <span>Manage</span>
                </button>
              </div>
              <div className="flex gap-2">
                <select
                  value={appliedTemplate?.id || ""}
                  onChange={(e) => {
                    if (e.target.value === "") {
                      resetToBlank()
                    } else {
                      const tmpl = templates.find((t) => t.id === e.target.value)
                      if (tmpl) applyTemplate(tmpl)
                    }
                  }}
                  className={`flex-1 px-3 py-2 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none ${accents.borderFocus} transition-colors duration-[80ms]`}
                >
                  <option value="">[blank session]</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setSavingTemplate(!savingTemplate)}
                  className={`px-3 py-2 rounded-lg border border-x-line hover:border-x-line-strong text-[13px] font-medium flex items-center gap-1.5 bg-x-surface-2 hover:bg-x-hover text-x-ink-secondary hover:text-x-ink transition-colors duration-[80ms]`}
                  title="Save current configuration as preset"
                >
                  <Sparkles size={11} className={savingTemplate ? accents.text : ''} />
                  <span>Save Preset</span>
                </button>
              </div>

              {savingTemplate && (
                <div className="flex gap-1.5 mt-2 p-2 bg-x-surface-2 border border-x-line rounded-lg items-center animation-fade-in">
                  <input
                    type="text"
                    value={newTemplateName}
                    onChange={(e) => setNewTemplateName(e.target.value)}
                    placeholder="Preset name (e.g. Debug Node)"
                    className={`flex-1 px-2.5 py-1 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder-x-muted focus:outline-none ${accents.borderFocus} transition-colors duration-[80ms]`}
                  />
                  <Button
                    type="button"
                    onClick={handleSaveAsTemplate}
                    disabled={!newTemplateName.trim()}
                    className={`px-2.5 py-1.5 text-[11px] font-medium text-x-on-accent transition-colors duration-[80ms] active:scale-[.98] ${accents.buttonBg} disabled:opacity-40`}
                  >
                    Save
                  </Button>
                  <Button
                    type="button"
                    onClick={() => { setSavingTemplate(false); setNewTemplateName(''); }}
                    className="px-2.5 py-1.5 text-[11px] font-medium text-x-muted hover:text-x-ink bg-x-surface-2 hover:bg-x-hover transition-colors duration-[80ms]"
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>

            {/* Advanced Configuration */}
            <div className="space-y-3.5 p-4 rounded-lg border border-x-line bg-x-surface flex-1 flex flex-col min-h-0">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center justify-between w-full text-[12px] text-x-ink-secondary hover:text-x-ink font-medium py-0.5 transition-colors duration-[80ms] text-left"
              >
                <div className="flex items-center gap-1.5">
                  <Flame size={12} className={accents.text} />
                  <span>Advanced Settings</span>
                </div>
                {showAdvanced ? <ChevronDown size={14} className="text-x-muted" /> : <ChevronRight size={14} className="text-x-muted" />}
              </button>
              
              <div className={`space-y-4 overflow-y-auto pr-1 scrollbar-thin flex-1 min-h-0 ${showAdvanced ? 'block' : 'hidden'}`}>
                {compatibleAccounts.length > 0 && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-x-ink-secondary block">Auth Accounts</label>
                    <select
                      value={accountId}
                      onChange={(e) => selectAccount(e.target.value)}
                      className={`w-full px-3 py-2 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none ${accents.borderFocus} transition-colors duration-[80ms]`}
                    >
                      <option value="">Local login</option>
                      {compatibleAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} {a.is_default ? '(default)' : ''}{a.base_url ? ' · gateway' : ''}
                        </option>
                      ))}
                    </select>
                    {selectedAccount?.base_url && (
                      <p className="text-[11px] text-x-muted font-mono truncate">
                        {selectedAccount.base_url}
                      </p>
                    )}
                  </div>
                )}

                {allGuidelines.length > 0 && (
                  <div className="space-y-1">
                    <button
                      type="button"
                      onClick={() => setShowGuidelines(!showGuidelines)}
                      className="flex items-center gap-1.5 text-[11px] text-x-ink-secondary hover:text-x-ink transition-colors duration-[80ms] font-medium w-full text-left"
                    >
                      <Shield size={12} className={accents.text} />
                      <span>Guidelines</span>
                      {selectedGuidelineIds.size > 0 && (
                        <span className="bg-x-tint text-x-accent px-1.5 py-0.5 rounded text-[11px] border border-x-accent/30">
                          {selectedGuidelineIds.size} active
                        </span>
                      )}
                      {showGuidelines ? <ChevronDown size={12} className="ml-auto" /> : <ChevronRight size={12} className="ml-auto" />}
                    </button>
                    {showGuidelines && (
                      <div className="mt-1.5 space-y-1.5 bg-x-surface-2 p-2 border border-x-line rounded-lg">
                        <input
                          type="text"
                          value={guidelineFilter}
                          onChange={(e) => setGuidelineFilter(e.target.value)}
                          placeholder="Search guidelines..."
                          className={`w-full px-2.5 py-1.5 text-[11px] bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder-x-muted focus:outline-none ${accents.borderFocus} transition-colors`}
                        />
                        <div className="max-h-[120px] overflow-y-auto space-y-1 pr-1 scrollbar-thin">
                          {allGuidelines.filter((g) => !guidelineFilter || g.name.toLowerCase().includes(guidelineFilter.toLowerCase())).map((g) => (
                            <div
                              key={g.id}
                              onClick={() => toggleGuideline(g.id)}
                              className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-x-hover cursor-pointer text-[11px] select-none"
                            >
                              <span
                                className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                                  selectedGuidelineIds.has(g.id)
                                    ? 'bg-x-tint border-x-accent/30 text-x-accent'
                                    : 'border-x-line-strong bg-x-surface-2'
                                }`}
                              >
                                {selectedGuidelineIds.has(g.id) && <Check size={10} className="font-bold" />}
                              </span>
                              <span className="text-x-ink-secondary truncate">{g.name}</span>
                              {g.is_default && (
                                <span className={`text-[11px] ${accents.bg} ${accents.text} border ${accents.border} px-1.5 py-0.5 rounded ml-auto shrink-0 font-medium`}>
                                  default
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {allMcpServers.length > 0 && (
                  <div className="space-y-1">
                    <button
                      type="button"
                      onClick={() => setShowMcpPicker(!showMcpPicker)}
                      className="flex items-center gap-1.5 text-[11px] text-x-ink-secondary hover:text-x-ink transition-colors duration-[80ms] font-medium w-full text-left"
                    >
                      <Server size={12} className="text-x-accent" />
                      <span>MCP Servers</span>
                      {selectedMcpServerIds.size > 0 && (
                        <span className="bg-x-tint text-x-accent px-1.5 py-0.5 rounded text-[11px] border border-x-accent/30">
                          {selectedMcpServerIds.size} active
                        </span>
                      )}
                      {showMcpPicker ? <ChevronDown size={12} className="ml-auto" /> : <ChevronRight size={12} className="ml-auto" />}
                    </button>
                    {showMcpPicker && (
                      <div className="mt-1.5 space-y-1.5 bg-x-surface-2 p-2 border border-x-line rounded-lg">
                        <input
                          type="text"
                          value={mcpFilter}
                          onChange={(e) => setMcpFilter(e.target.value)}
                          placeholder="Search servers..."
                          className={`w-full px-2.5 py-1.5 text-[11px] bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder-x-muted focus:outline-none ${accents.borderFocus} transition-colors`}
                        />
                        <div className="max-h-[120px] overflow-y-auto space-y-1 pr-1 scrollbar-thin">
                          {allMcpServers.filter((s) => !mcpFilter || s.server_name.toLowerCase().includes(mcpFilter.toLowerCase())).map((s) => {
                            const locked = s.is_builtin && s.default_enabled
                            return (
                              <div
                                key={s.id}
                                onClick={() => { if (!locked) toggleMcpServer(s.id) }}
                                className={`flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-x-hover text-[11px] select-none ${locked ? 'opacity-60 cursor-default' : 'cursor-pointer'}`}
                              >
                                <span
                                  className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                                    selectedMcpServerIds.has(s.id)
                                      ? 'bg-x-accent border-x-accent text-x-on-accent'
                                      : 'border-x-line-strong bg-x-surface-2'
                                  }`}
                                >
                                  {selectedMcpServerIds.has(s.id) && <Check size={10} className="font-bold" />}
                                </span>
                                <span className="text-x-ink-secondary truncate">{s.server_name}</span>
                                {locked ? (
                                  <span className="text-[11px] bg-x-hover border border-x-line text-x-muted px-1.5 py-0.5 rounded ml-auto shrink-0 font-medium">required</span>
                                ) : s.default_enabled ? (
                                  <span className="text-[11px] bg-x-tint text-x-accent border border-x-accent/30 px-1.5 py-0.5 rounded ml-auto shrink-0 font-medium">default</span>
                                ) : null}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {modelSwitchingEnabled && (
                  <div className="space-y-1.5 border-t border-x-line pt-3">
                    <div className="text-[12px] font-medium text-x-accent-ink flex items-center gap-1.5">
                      <Flame size={12} />
                      <span>Dual Model Routing</span>
                      <span className="text-[11px] bg-x-accent-ink/10 text-x-accent-ink px-1.5 py-0.5 rounded border border-x-accent-ink/30">EXP</span>
                    </div>
                    <div className="flex gap-2">
                      <select
                        value={planModel}
                        onChange={(e) => setPlanModel(e.target.value)}
                        className={`flex-1 px-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none ${accents.borderFocus} transition-colors duration-[80ms]`}
                      >
                        <option value="">plan: default</option>
                        {getModelsForCli(cliType).map((m) => (
                          <option key={m.id} value={m.id}>plan: {m.label}</option>
                        ))}
                      </select>
                      <select
                        value={executeModel}
                        onChange={(e) => setExecuteModel(e.target.value)}
                        className={`flex-1 px-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none ${accents.borderFocus} transition-colors duration-[80ms]`}
                      >
                        <option value="">exec: default</option>
                        {getModelsForCli(cliType).map((m) => (
                          <option key={m.id} value={m.id}>exec: {m.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}

                <div className="flex gap-4 p-2 bg-x-surface-2 border border-x-line rounded-lg">
                  <div className="flex items-center gap-2 cursor-pointer flex-1 select-none">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={autoApprovePlan}
                      aria-label="Auto-approve plans"
                      onClick={() => setAutoApprovePlan(!autoApprovePlan)}
                      className={`relative inline-flex h-4 w-8 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${autoApprovePlan ? 'bg-x-accent' : 'bg-x-hover'}`}
                    >
                      <span className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-x-on-accent shadow ring-0 transition duration-200 ease-in-out ${autoApprovePlan ? 'translate-x-4' : 'translate-x-0'}`} />
                    </button>
                    <span className="text-[11px] text-x-ink-secondary font-medium">
                      Auto-approve plans
                    </span>
                  </div>

                  <div className="flex items-center gap-2 cursor-pointer flex-1 select-none">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={worktreeSupported && worktree}
                      aria-label="Use an isolated Git worktree"
                      aria-describedby="new-session-worktree-help"
                      disabled={!worktreeSupported}
                      onClick={() => setWorktree(!worktree)}
                      className={`relative inline-flex h-4 w-8 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${worktree ? 'bg-x-accent' : 'bg-x-hover'}`}
                    >
                      <span className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-x-on-accent shadow ring-0 transition duration-200 ease-in-out ${worktree ? 'translate-x-4' : 'translate-x-0'}`} />
                    </button>
                    <span className="text-[11px] text-x-ink-secondary font-medium">
                      Isolated Git worktree
                    </span>
                  </div>
                </div>

                <p id="new-session-worktree-help" className="mt-1 text-[11px] text-x-muted">
                  {worktreeSupported
                    ? 'A worktree is a separate working copy of your Git repository. Use it when agents should edit independently.'
                    : `${cliProfiles?.[cliType]?.label || cliType} does not support automatic worktree creation in IVE. This session will use the project folder. For isolated work, choose a supported agent or connect a separate worktree folder.`}
                </p>

                {(getEffortLevelsForCli(cliType).length > 0 || outputStyles.length > 0) && (
                  <div className="flex gap-2">
                    {getEffortLevelsForCli(cliType).length > 0 && (
                      <div className="flex-1 space-y-1">
                        <label className="text-xs font-medium text-x-ink-secondary block">Reasoning Effort</label>
                        <select
                          value={effort}
                          onChange={(e) => setEffort(e.target.value)}
                          className={`w-full px-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none ${accents.borderFocus} transition-colors duration-[80ms]`}
                        >
                          {getEffortOptionsForCli(cliType, model).map((o) => (
                            <option key={o.value || 'default'} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    {outputStyles.length > 0 && (
                      <div className="flex-1 space-y-1">
                        <label className="text-xs font-medium text-x-ink-secondary block">Output Formatting</label>
                        <select
                          value={outputStyle}
                          onChange={(e) => setOutputStyle(e.target.value)}
                          className={`w-full px-2.5 py-1.5 text-[13px] bg-x-surface-2 border border-x-line rounded-md text-x-ink focus:outline-none ${accents.borderFocus} transition-colors duration-[80ms]`}
                          title="Output style (token saving)"
                        >
                          <option value="">inherit</option>
                          {outputStyles.map((s) => (
                            <option key={s.id} value={s.id} title={s.description}>{s.label}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                )}
              </div>
              
              {!showAdvanced && (
                <div className="hidden sm:flex flex-1 flex-col items-center justify-center text-center p-4 border border-dashed border-x-line rounded-lg text-x-muted">
                  <Flame size={18} className="mb-1.5 opacity-40" />
                  <p className="text-[11px]">Click "Advanced Settings" above to configure Guidelines, MCP Servers, routing options and formatting styles.</p>
                </div>
              )}
            </div>

          </div>

        </div>

        {/* Footer Actions */}
        <div className="flex items-center gap-3 px-6 py-4 border-t border-x-line">
          <div className="min-w-0 flex-1">
            {(createError || (cliTypes.length === 0 && !isShell)) && (
              <p role="alert" className="text-[11px] leading-relaxed text-x-danger">
                {createError || 'No installed and enabled CLI was found. Install or enable a CLI in Model Providers.'}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            disabled={isCreating}
            className="px-4 py-2 text-[13px] font-medium bg-x-surface hover:bg-x-hover text-x-ink-secondary hover:text-x-ink rounded-lg transition-colors duration-[80ms] border border-x-line hover:border-x-line-strong active:scale-[.98]"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={isCreating || (cliTypes.length === 0 && !isShell)}
            className={`px-5 py-2 text-[13px] font-medium ${accents.buttonBg} text-x-on-accent rounded-lg transition-colors duration-[80ms] active:scale-[.98] disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {isCreating ? 'Creating…' : isShell ? 'Open Terminal' : 'Create Session'}
          </button>
        </div>
      </div>
    </div>
  )
}
