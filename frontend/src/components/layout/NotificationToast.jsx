import HelpDetails from '../ui/HelpDetails'
import { Component, useEffect, useLayoutEffect, useState, useRef } from 'react'
import { Shield, Check, X, MessageSquare, FileText, RotateCcw, Sparkles, Server, Zap, GitBranch, Brain, KeyRound, UserPlus, RefreshCw, AlertTriangle, Info, ChevronDown, ArrowUpRight } from 'lucide-react'
import useStore from '../../state/store'
import ProviderLogo from '../ui/ProviderLogo'
import { groupNotifications, affectedSessions, notificationDuration, notificationPreview } from '../../lib/notificationPresentation'
import { sendTerminalCommand, typeInTerminal, sendPlanChoice } from '../../lib/terminal'
import { clearPromptBuffer } from '../../lib/outputParser'
import { notificationSessionId, notificationSessionReady } from '../../lib/operatorDesk'

// Notification types rendered inline in the QuickActions bar instead of as popouts.
const INLINE_QUICKACTION_TYPES = new Set([
  'skill_suggestion',
  'guideline_recommendation',
  'board_suggestion',
  'safety_rule_proposed',
])

// A broken toast must never take the app down: it disappears instead
// (and drops its notification, when it has one).
export class ToastBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('Toast crashed:', error)
    if (this.props.notifId != null) useStore.getState().removeNotification(this.props.notifId)
  }

  render() {
    return this.state.error ? null : this.props.children
  }
}

export default function NotificationToast({ sideChatOpen = false }) {
  const notifications = useStore((s) => s.notifications)
  const sessions = useStore((s) => s.sessions)
  const visible = notifications.filter((n) => !INLINE_QUICKACTION_TYPES.has(n.type)
    && notificationSessionReady(n, sessions))
  const [chatOffset, setChatOffset] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const regionRef = useRef(null)
  useEffect(() => { if (!regionRef.current?.contains(document.activeElement)) setFocused(false) }, [notifications])
  const groups = groupNotifications(visible)
  const shown = expanded ? groups : groups.slice(0, 2)

  useLayoutEffect(() => {
    if (!sideChatOpen) { setChatOffset(0); return }
    const panel = document.getElementById('ive-sidechat')
    if (!panel) return
    const update = () => setChatOffset(window.innerWidth - panel.getBoundingClientRect().left + 12)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(panel)
    window.addEventListener('resize', update)
    return () => { observer.disconnect(); window.removeEventListener('resize', update) }
  }, [sideChatOpen])

  if (visible.length === 0) return null

  return (
    <section className={`ive-toasts ive-notification-region${sideChatOpen ? ' ive-toasts--sidechat' : ''}`}
      ref={regionRef} aria-label="Notifications" onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)}
      onFocusCapture={()=>setFocused(true)} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget))setFocused(false)}}
      style={sideChatOpen && chatOffset ? { right: chatOffset, maxWidth: `min(372px, calc(100vw - ${chatOffset + 12}px))` } : undefined}>
      <div className="ive-notification-stack">
        {shown.map(group => (
          <ToastBoundary key={group.key} notifId={group.notices[0].id}>
            <div className="ive-notification-shell">
              {group.kind === 'hooks' ? <HookSetupNotice notices={group.notices} sessions={sessions} />
                : <Toast notif={group.notices[0]} paused={hovered || focused} />}
            </div>
          </ToastBoundary>
        ))}
      </div>
      {groups.length > 2 && <button className="ive-notification-overflow" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>
        {expanded ? 'Show fewer notifications' : `${groups.length - shown.length} more ${groups.length - shown.length === 1 ? 'notification' : 'notifications'}`} <ChevronDown size={14} style={{transform:expanded?'rotate(180deg)':undefined}}/>
      </button>}
    </section>
  )
}

function HookSetupNotice({ notices, sessions }) {
  const [expanded, setExpanded] = useState(false)
  const affected = affectedSessions(notices, sessions)
  const dismiss = () => notices.forEach(n => useStore.getState().removeNotification(n.id))
  const openTerminal = session => {
    const store = useStore.getState()
    store.goSession(session.id)
    if (!store.terminalDrawer[session.id]) store.toggleTerminalDrawer(session.id)
    window.dispatchEvent(new CustomEvent('ive-open-session-terminal', { detail: { sessionId: session.id } }))
  }
  return <article className="ive-notice ive-notice--setup" aria-label="Codex setup notice">
    <div className="ive-notice-heading">
      <span className="ive-notice-provider"><ProviderLogo provider="codex" size={19}/></span>
      <div className="ive-notice-title"><h2>Finish connecting Codex</h2></div>
      <button className="ive-notice-close" aria-label="Dismiss Codex setup notification" onClick={dismiss}><X size={16}/></button>
    </div>
    <p role="status">Enable IVE checks for Codex.</p>
    <div className="ive-notice-footer">
      <span className="ive-notice-context">{affected.length > 1 ? `${affected.length} sessions affected` : affected[0]?.name || 'Codex session'}</span>
      <button className="ive-notice-action" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'Hide steps':'Review setup'}<ChevronDown size={13}/></button>
    </div>
    {expanded && <div className="ive-notice-details">
      <ol><li>Open the affected session’s terminal.</li><li>Run <code>/hooks</code> in Codex.</li><li>Review the IVE hooks and enable the ones you trust. Restart the session when it is idle.</li></ol>
      <p>IVE checks remain unavailable until Codex loads the trusted hooks.</p>
      <div className="ive-notice-sessions">{affected.map(session=><button key={session.id} onClick={()=>openTerminal(session)} aria-label={`Open terminal for ${session.name} (${session.id.slice(0,8)})`}><span><strong>{session.name}</strong><small>{session.id.slice(0,8)}</small></span><ArrowUpRight size={15}/></button>)}</div>
      {!affected.length && <p>This session is no longer available. You can dismiss this notice.</p>}
    </div>}
  </article>
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body.error || body.message || `Request failed (${response.status})`)
    error.status = response.status
    throw error
  }
  return body
}

function AuthRecoveryToast({ notif, session, dismiss }) {
  const sessionId = notif.sessionId || notif.session_id
  const cliType = (notif.cli || session?.cli_type || 'claude').toLowerCase()
  const cliLabel = cliType === 'antigravity' ? 'agy' : cliType
  const [recovery, setRecovery] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null)
  const [feedback, setFeedback] = useState('')
  const [showNewLogin, setShowNewLogin] = useState(false)
  const [newName, setNewName] = useState('')
  const [pendingLogin, setPendingLogin] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/auth-recovery`)
      .then((result) => {
        if (!cancelled) setRecovery(result)
      })
      .catch((error) => {
        if (cancelled) return
        if (error.status === 404) useStore.getState().removeNotification(notif.id)
        else setFeedback(error.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [sessionId])

  useEffect(() => {
    if (!pendingLogin) return undefined
    let cancelled = false
    let timer = null

    const check = async () => {
      try {
        const auth = await requestJson(
          `/api/accounts/${encodeURIComponent(pendingLogin.accountId)}/auth-status?cli_type=${encodeURIComponent(cliType)}`,
        )
        if (cancelled) return
        if (auth.credentials_verified) {
          setBusy('binding')
          setFeedback('Login verified. Waiting for the old process to exit and the replacement to start…')
          const result = await requestJson(
            `/api/sessions/${encodeURIComponent(sessionId)}/restart-with-account`,
            {
              method: 'POST',
              body: JSON.stringify({
                account_id: pendingLogin.accountId,
                expected_account_id: pendingLogin.expectedAccountId,
              }),
            },
          )
          if (!result.ok) throw new Error(result.error || 'Account switch failed')
          if (cancelled) return
          useStore.getState().addNotification?.({
            type: 'success',
            message: `${pendingLogin.accountName} attached after the replacement session started.`,
          })
          dismiss()
          return
        }
        if (['auth_failed', 'duplicate_identity'].includes(auth.account_status)) {
          setBusy(null)
          setPendingLogin(null)
          setFeedback(
            auth.account_status === 'duplicate_identity'
              ? `Those credentials already belong to another ${cliLabel} account.`
              : `No verified ${cliLabel} credentials appeared in the new account sandbox.`,
          )
          return
        }
        setFeedback(`Waiting for ${cliLabel} login to finish in the isolated browser…`)
        timer = setTimeout(check, 2000)
      } catch (error) {
        if (cancelled) return
        setBusy(null)
        setPendingLogin(null)
        setFeedback(error.message)
      }
    }

    check()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [
    pendingLogin?.accountId,
    pendingLogin?.accountName,
    pendingLogin?.expectedAccountId,
    cliLabel,
    cliType,
    sessionId,
  ])

  const completeRecovery = (message) => {
    useStore.getState().addNotification?.({ type: 'success', message })
    dismiss()
  }

  const restart = async () => {
    setBusy('restart')
    setFeedback('Waiting for the old process to exit and the replacement to start…')
    try {
      const result = await requestJson(
        `/api/sessions/${encodeURIComponent(sessionId)}/auth-recovery/restart`,
        { method: 'POST' },
      )
      if (!result.ok) throw new Error(result.error || 'Restart failed')
      completeRecovery('Session restarted and credentials re-synced.')
    } catch (error) {
      setFeedback(error.message)
      setBusy(null)
    }
  }

  const attach = async (account) => {
    setBusy(`attach:${account.id}`)
    setFeedback(`Attaching ${account.name}; waiting for the old process to exit…`)
    try {
      const result = await requestJson(
        `/api/sessions/${encodeURIComponent(sessionId)}/restart-with-account`,
        {
          method: 'POST',
          body: JSON.stringify({
            account_id: account.id,
            expected_account_id: recovery.current_account_id,
          }),
        },
      )
      if (!result.ok) throw new Error(result.error || 'Account switch failed')
      completeRecovery(`${account.name} attached after the replacement session started.`)
    } catch (error) {
      setFeedback(error.message)
      setBusy(null)
    }
  }

  const startNewLogin = async (event) => {
    event.preventDefault()
    const name = newName.trim()
    if (!name) {
      setFeedback('Name the account before starting login.')
      return
    }
    setBusy('login')
    setFeedback(`Creating an isolated ${cliLabel} account sandbox…`)
    try {
      const account = await requestJson('/api/accounts', {
        method: 'POST',
        body: JSON.stringify({ name, type: 'oauth', cli_type: cliType }),
      })
      const setup = await requestJson(
        `/api/accounts/${encodeURIComponent(account.id)}/setup-browser`,
        {
          method: 'POST',
          body: JSON.stringify({ cli_type: cliType, driver: 'ive' }),
        },
      )
      if (!setup.ok && !['action_required', 'verification_pending'].includes(setup.status)) {
        throw new Error(setup.error || setup.message || 'Could not start login')
      }
      setPendingLogin({
        accountId: account.id,
        accountName: name,
        expectedAccountId: recovery?.current_account_id ?? null,
      })
      setFeedback(
        setup.message || `Finish ${cliLabel} login in the isolated browser; IVE will verify and attach it automatically.`,
      )
    } catch (error) {
      setFeedback(error.message)
      setBusy(null)
    }
  }

  const accounts = recovery?.accounts || []

  return (
    <div className="bg-x-surface border border-x-line rounded-lg shadow-x-1 overflow-hidden animate-in slide-in-from-right">
      <div className="flex items-center gap-1.5 px-3 py-2 bg-x-surface-2 border-b border-x-line">
        <Shield size={13} className="text-x-accent-ink" />
        <span className="text-[11px] font-semibold text-x-accent-ink">Login recovery · {cliLabel}</span>
        <button onClick={dismiss} className="ml-auto p-1 rounded hover:bg-x-hover text-x-muted hover:text-x-ink">
          <X size={12} />
        </button>
      </div>
      <div className="p-3 space-y-2.5">
        <p className="text-[11px] text-x-ink-secondary leading-relaxed">
          {notif.message || notif.hint || 'This session needs working credentials.'}
        </p>

        <button
          onClick={restart}
          disabled={Boolean(busy)}
          className="w-full flex items-center justify-center gap-1.5 px-2.5 py-2 text-[11px] rounded bg-x-accent text-white hover:bg-x-accent/90 disabled:opacity-50 transition-colors"
        >
          <RotateCcw size={11} className={busy === 'restart' ? 'animate-spin' : ''} />
          Restart / re-sync
        </button>

        {loading && <p className="text-[10px] text-x-muted">Checking verified stored accounts…</p>}
        {!loading && accounts.length > 0 && (
          <div className="space-y-1.5 pt-1 border-t border-x-line">
            <p className="text-[10px] font-medium uppercase tracking-wide text-x-faint">Attach a stored account</p>
            {accounts.map((account) => (
              <button
                key={account.id}
                onClick={() => attach(account)}
                disabled={Boolean(busy)}
                className="w-full flex items-center gap-2 px-2.5 py-2 text-left rounded border border-x-line hover:border-x-accent/40 hover:bg-x-hover disabled:opacity-50 transition-colors"
              >
                <KeyRound size={11} className="text-x-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] text-x-ink truncate">{account.name}</span>
                  <span className="block text-[9px] text-x-muted truncate">{account.verified_subject}</span>
                </span>
                {busy === `attach:${account.id}` && <RefreshCw size={10} className="animate-spin text-x-accent" />}
              </button>
            ))}
          </div>
        )}
        {!loading && recovery && accounts.length === 0 && (
          <p className="text-[10px] text-x-muted leading-relaxed border-t border-x-line pt-2">{recovery.message}</p>
        )}

        <div className="pt-1 border-t border-x-line">
          <button
            onClick={() => setShowNewLogin((shown) => !shown)}
            disabled={Boolean(busy)}
            className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-[11px] rounded border border-x-line hover:bg-x-hover disabled:opacity-50 transition-colors"
          >
            <UserPlus size={11} />
            Log in a new account
          </button>
          {showNewLogin && (
            <form onSubmit={startNewLogin} className="mt-2 flex gap-1.5">
              <input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                disabled={Boolean(busy)}
                placeholder="Account name"
                className="min-w-0 flex-1 px-2 py-1.5 text-[11px] bg-x-bg border border-x-line rounded text-x-ink placeholder:text-x-faint focus:outline-none focus:border-x-accent"
              />
              <button
                type="submit"
                disabled={Boolean(busy) || !newName.trim()}
                className="px-2.5 py-1.5 text-[11px] rounded bg-x-accent/20 text-x-accent border border-x-accent/30 hover:bg-x-accent/30 disabled:opacity-50"
              >
                Start login
              </button>
            </form>
          )}
        </div>

        {feedback && <p className="text-[10px] text-x-ink-secondary leading-relaxed">{feedback}</p>}
      </div>
    </div>
  )
}

function Toast({ notif, paused = false }) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const sessions = useStore((s) => s.sessions)
  const session = sessions[notificationSessionId(notif)]

  useEffect(() => {
    const duration = notificationDuration(notif)
    if (paused || detailsOpen || !duration) return undefined
    const timer = setTimeout(() => useStore.getState().removeNotification(notif.id), duration)
    return () => clearTimeout(timer)
  }, [notif.id, notif.type, notif.action, paused, detailsOpen])

  const dismiss = () => useStore.getState().removeNotification(notif.id)

  // Map logical key names to PTY sequences
  const KEY_SEQ = {
    enter: '\r', escape: '\x1b', tab: '\t',
    'ctrl-a': '\x01', 'ctrl-b': '\x02', 'ctrl-c': '\x03',
    'ctrl-d': '\x04', 'ctrl-e': '\x05', 'ctrl-g': '\x07',
  }

  const handleAction = (action) => {
    const seq = KEY_SEQ[action.key] || action.key
    typeInTerminal(notif.sessionId, seq)
    clearPromptBuffer(notif.sessionId)
    useStore.getState().setSessionPlanWaiting(notif.sessionId, false)
    dismiss()
  }

  const handleFocus = () => {
    const store = useStore.getState()
    // Switch workspace context first so the session is visible in
    // workspace-scoped tab views and the sidebar highlights its workspace.
    // Mirrors how clicking a session in the sidebar works (SessionTabs.jsx).
    const sess = store.sessions[notif.sessionId]
    if (sess?.workspace_id && sess.workspace_id !== store.activeWorkspaceId) {
      store.setActiveWorkspace(sess.workspace_id)
    }
    if (!store.openTabs.includes(notif.sessionId)) {
      store.openSession(notif.sessionId)
    } else {
      store.setActiveSession(notif.sessionId)
    }
    dismiss()
  }

  const handleReviewPlan = () => {
    // Focus on the session and dispatch event to open Plan Viewer
    handleFocus()
    window.dispatchEvent(new CustomEvent('open-plan-viewer'))
  }

  const handleReviewBlueprint = () => {
    const store = useStore.getState()
    if (notif.workspaceId && notif.workspaceId !== store.activeWorkspaceId) {
      store.setActiveWorkspace(notif.workspaceId)
    }
    store.setActivePlan({
      type: 'blueprint',
      taskId: notif.taskId,
      blueprintPath: notif.blueprintPath,
    })
    window.dispatchEvent(new CustomEvent('open-plan-viewer', {
      detail: { type: 'blueprint', taskId: notif.taskId },
    }))
    dismiss()
  }

  if (notif.type === 'auth_failed') {
    return <AuthRecoveryToast notif={notif} session={session} dismiss={dismiss} />
  }

  if (notif.type === 'blueprint_ready') {
    return (
      <div className="bg-x-surface border border-x-line rounded-lg shadow-x-1 overflow-hidden animate-in slide-in-from-right">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-x-surface-2 border-b border-x-line">
          <FileText size={12} className="text-x-accent" />
          <span className="text-[11px] font-medium text-x-accent flex-1 truncate">
            Blueprint Ready
          </span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms]">
            <X size={12} />
          </button>
        </div>

        <div className="px-2.5 py-1.5">
          <NoticeMessage message={notif.message} onToggle={event => setDetailsOpen(event.currentTarget.open)} />
        </div>

        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-x-line">
          <button
            onClick={handleReviewBlueprint}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] bg-x-accent/20 hover:bg-x-accent/30 text-x-accent border border-x-accent/30 rounded transition-colors"
          >
            <FileText size={10} />
            Review Blueprint
          </button>
        </div>
      </div>
    )
  }

  if (notif.type === 'plan_ready') {
    return (
      <div className="bg-x-surface border border-x-line rounded-lg shadow-x-1 overflow-hidden animate-in slide-in-from-right">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-x-surface-2 border-b border-x-line">
          <FileText size={12} className="text-x-accent-ink" />
          <span className="text-[11px] font-medium text-x-accent-ink flex-1 truncate">
            Plan Ready
          </span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms]">
            <X size={12} />
          </button>
        </div>

        <div className="px-2.5 py-1.5">
          <NoticeMessage message={notif.message} onToggle={event => setDetailsOpen(event.currentTarget.open)} />
        </div>

        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-x-line">
          <button
            onClick={handleReviewPlan}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] bg-x-accent-ink/20 hover:bg-x-accent-ink/30 text-x-accent-ink border border-x-accent-ink/30 rounded transition-colors"
          >
            <FileText size={10} />
            Review Plan
          </button>
          <button
            onClick={handleFocus}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] text-x-muted hover:text-x-ink-secondary hover:bg-x-hover rounded transition-colors duration-[80ms] ml-auto"
          >
            <MessageSquare size={10} />
            View Session
          </button>
        </div>
      </div>
    )
  }

  if (notif.type === 'input_needed') {
    const options = notif.options || []
    const actions = notif.actions || [
      { label: 'Allow', key: 'enter', style: 'primary' },
      { label: 'Reject', key: 'escape', style: 'danger' },
    ]
    const handleOption = (opt) => {
      sendPlanChoice(notif.sessionId, opt.num)
      clearPromptBuffer(notif.sessionId)
      dismiss()
    }

    const actionStyle = (style) => {
      if (style === 'primary') return 'bg-x-good/20 hover:bg-x-good/30 text-x-good border border-x-good/30'
      if (style === 'danger') return 'bg-x-accent-ink/20 hover:bg-x-accent-ink/30 text-x-accent-ink border border-x-accent-ink/30'
      return 'text-x-muted hover:text-x-ink-secondary hover:bg-x-hover border border-x-line'
    }

    return (
      <div className="bg-x-surface border border-x-line rounded-lg shadow-x-1 overflow-hidden animate-in slide-in-from-right max-w-sm">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-x-surface-2 border-b border-x-line">
          <MessageSquare size={12} className="text-x-accent-ink" />
          <span className="text-[11px] font-medium text-x-accent-ink flex-1 truncate">
            {session?.name || notif.sessionId.slice(0, 8)}
          </span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms]">
            <X size={12} />
          </button>
        </div>
        <div className="px-2.5 py-1.5">
          <p className="text-[11px] text-x-ink-secondary leading-relaxed">{notif.message}</p>
          {notif.context && !options.length && (
            <pre className="mt-1 text-[11px] font-mono text-x-muted leading-tight max-h-24 overflow-y-auto whitespace-pre-wrap break-words">
              {notif.context.split('\n').filter(l => l.trim()).slice(-10).join('\n')}
            </pre>
          )}
        </div>

        {options.length > 0 && (
          <div className="px-2.5 py-1.5 border-t border-x-line space-y-1">
            {options.map((opt) => (
              <button
                key={opt.num}
                onClick={() => handleOption(opt)}
                className={`w-full text-left px-2.5 py-1.5 text-[11px] rounded transition-colors flex items-center gap-1 ${
                  opt.num === 1
                    ? 'bg-x-good/15 hover:bg-x-good/25 text-x-good border border-x-good/20'
                    : opt.text.toLowerCase().includes('no') || opt.text.toLowerCase().includes('reject')
                      ? 'bg-x-accent-ink/10 hover:bg-x-accent-ink/20 text-x-accent-ink border border-x-accent-ink/20'
                      : 'bg-x-surface hover:bg-x-hover text-x-ink-secondary border border-x-line'
                }`}
              >
                <span className="text-x-muted">{opt.num}.</span>
                <span className="truncate">{opt.text}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-x-line">
          {actions.map((action, i) => (
            <button
              key={i}
              onClick={() => handleAction(action)}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded transition-colors ${actionStyle(action.style)}`}
            >
              {action.style === 'primary' && <Check size={10} />}
              {action.style === 'danger' && <X size={10} />}
              {action.label}
            </button>
          ))}
          <button
            onClick={handleFocus}
            className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] text-x-muted hover:text-x-ink-secondary hover:bg-x-hover rounded transition-colors duration-[80ms] ml-auto"
          >
            View session
          </button>
        </div>
      </div>
    )
  }

  if (notif.type === 'permission_question') {
    const options = notif.options || []
    const handleJustDoIt = () => {
      sendTerminalCommand(notif.sessionId, 'Yes, go ahead and implement it.')
      clearPromptBuffer(notif.sessionId)
      dismiss()
    }
    const handleOption = (opt) => {
      sendPlanChoice(notif.sessionId, opt.num)
      clearPromptBuffer(notif.sessionId)
      dismiss()
    }

    return (
      <div className="bg-x-surface border border-x-line rounded-lg shadow-x-1 overflow-hidden animate-in slide-in-from-right max-w-sm">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-x-surface-2 border-b border-x-line">
          <Zap size={12} className="text-x-accent-ink" />
          <span className="text-[11px] font-medium text-x-accent-ink flex-1 truncate">
            {session?.name || notif.sessionId.slice(0, 8)} — asking permission
          </span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms]">
            <X size={12} />
          </button>
        </div>
        <div className="px-2.5 py-1.5">
          {notif.question && (
            <p className="text-[11px] text-x-ink-secondary leading-relaxed line-clamp-2 italic">
              &ldquo;{notif.question}&rdquo;
            </p>
          )}
          {notif.context && !options.length && (
            <pre className="mt-1 text-[11px] font-mono text-x-muted leading-tight max-h-16 overflow-y-auto whitespace-pre-wrap break-words">
              {notif.context.split('\n').filter(l => l.trim()).slice(-5).join('\n')}
            </pre>
          )}
        </div>

        {options.length > 0 && (
          <div className="px-2.5 py-1.5 border-t border-x-line space-y-1">
            {options.map((opt) => (
              <button
                key={opt.num}
                onClick={() => handleOption(opt)}
                className={`w-full text-left px-2.5 py-1.5 text-[11px] rounded transition-colors flex items-center gap-1 ${
                  opt.num === 1
                    ? 'bg-x-good/15 hover:bg-x-good/25 text-x-good border border-x-good/20'
                    : opt.text.toLowerCase().includes('no') || opt.text.toLowerCase().includes('reject')
                      ? 'bg-x-accent-ink/10 hover:bg-x-accent-ink/20 text-x-accent-ink border border-x-accent-ink/20'
                      : 'bg-x-surface hover:bg-x-hover text-x-ink-secondary border border-x-line'
                }`}
              >
                <span className="text-x-muted">{opt.num}.</span>
                <span className="truncate">{opt.text}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-x-line">
          {!options.length && (
            <button
              onClick={handleJustDoIt}
              className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] bg-x-accent-ink/20 hover:bg-x-accent-ink/30 text-x-accent-ink border border-x-accent-ink/30 rounded transition-colors"
            >
              <Zap size={10} />
              Just do it
            </button>
          )}
          <button
            onClick={handleFocus}
            className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] text-x-muted hover:text-x-ink-secondary hover:bg-x-hover rounded transition-colors duration-[80ms] ml-auto"
          >
            View session
          </button>
        </div>
      </div>
    )
  }

  if (notif.type === 'session_done') {
    return (
      <div className="bg-x-surface border border-x-good/30 rounded-lg shadow-x-1 overflow-hidden animate-in slide-in-from-right">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-x-good/10 border-b border-x-good/20">
          <Check size={12} className="text-x-good" />
          <span className="text-[11px] font-medium text-x-good flex-1 truncate">
            {session?.name || notif.sessionId.slice(0, 8)}
          </span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms]">
            <X size={12} />
          </button>
        </div>
        <div className="px-2.5 py-1.5">
          <p className="text-[11px] text-x-ink-secondary">{notif.message}</p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-x-line">
          <button
            onClick={handleFocus}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] bg-x-good/20 hover:bg-x-good/30 text-x-good border border-x-good/30 rounded transition-colors"
          >
            <MessageSquare size={10} /> View output
          </button>
        </div>
      </div>
    )
  }

  if (notif.type === 'permission') {
    return (
      <div className="bg-x-surface border border-x-line rounded-lg shadow-x-1 overflow-hidden animate-in slide-in-from-right">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-x-surface-2 border-b border-x-line">
          <Shield size={12} className="text-x-accent-ink" />
          <span className="text-[11px] font-medium text-x-accent-ink flex-1 truncate">
            {session?.name || notif.sessionId.slice(0, 8)}
          </span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms]">
            <X size={12} />
          </button>
        </div>

        <div className="px-2.5 py-1.5">
          <NoticeMessage message={notif.message} onToggle={event => setDetailsOpen(event.currentTarget.open)} />
        </div>

        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-x-line">
          <button
            onClick={() => handleAction({ key: 'enter' })}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] bg-x-good/20 hover:bg-x-good/30 text-x-good border border-x-good/30 rounded transition-colors"
          >
            <Check size={10} />
            Allow
          </button>
          <button
            onClick={() => handleAction({ key: 'escape' })}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] bg-x-accent-ink/20 hover:bg-x-accent-ink/30 text-x-accent-ink border border-x-accent-ink/30 rounded transition-colors"
          >
            <X size={12} />
            Reject
          </button>
          <button
            onClick={handleFocus}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] text-x-muted hover:text-x-ink-secondary hover:bg-x-hover rounded transition-colors duration-[80ms] ml-auto"
          >
            <MessageSquare size={10} />
            View
          </button>
        </div>
      </div>
    )
  }

  if (notif.type === 'skill_installed') {
    const handleRestartAll = () => {
      const count = useStore.getState().restartAllSessions()
      dismiss()
    }
    return (
      <div className="bg-x-surface border border-x-line rounded-lg shadow-x-1 overflow-hidden animate-in slide-in-from-right">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-x-surface-2 border-b border-x-line">
          <Check size={12} className="text-x-accent-ink" />
          <span className="text-[11px] font-medium text-x-accent-ink flex-1 truncate">
            Skill Installed
          </span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms]">
            <X size={12} />
          </button>
        </div>
        <div className="px-2.5 py-1.5">
          <p className="text-[11px] text-x-ink-secondary">{notif.message}</p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-x-line">
          <button
            onClick={handleRestartAll}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] bg-x-accent-ink/20 hover:bg-x-accent-ink/30 text-x-accent-ink border border-x-accent-ink/30 rounded transition-colors"
          >
            <RotateCcw size={10} />
            Restart all sessions
          </button>
          <button onClick={dismiss} className="ml-auto text-[11px] text-x-muted hover:text-x-ink-secondary px-2 py-1.5 rounded hover:bg-x-hover transition-colors duration-[80ms]">
            later
          </button>
        </div>
      </div>
    )
  }

  // skill_suggestion and guideline_recommendation are rendered inline in QuickActions
  // (filtered out at the parent level), so no popout branches here.

  if (notif.type === 'distill_done') {
    const handleOpenDistill = () => {
      window.dispatchEvent(new CustomEvent('open-distill-result', { detail: { result: notif.result, artifactType: notif.artifactType } }))
      dismiss()
    }
    const handleDismissToInbox = () => {
      // Result is already in backgroundResults via addBackgroundResult — just remove the toast
      dismiss()
    }
    return (
      <div className="bg-x-surface border border-x-line rounded-lg shadow-x-1 overflow-hidden animate-in slide-in-from-right">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-x-surface-2 border-b border-x-line">
          <Sparkles size={12} className="text-x-accent" />
          <span className="text-[11px] font-medium text-x-accent flex-1 truncate">
            Distill Complete
          </span>
          <button onClick={handleDismissToInbox} className="p-1.5 rounded hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms]">
            <X size={12} />
          </button>
        </div>
        <div className="px-2.5 py-1.5">
          <p className="text-[11px] text-x-ink-secondary leading-relaxed line-clamp-2">
            {notif.message}
          </p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-x-line">
          <button
            onClick={handleOpenDistill}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] bg-x-accent/20 hover:bg-x-accent/30 text-x-accent border border-x-accent/30 rounded transition-colors"
          >
            <Sparkles size={10} />
            Open Preview
          </button>
          <button onClick={handleDismissToInbox} className="ml-auto text-[11px] text-x-muted hover:text-x-ink-secondary px-2 py-1.5 rounded hover:bg-x-hover transition-colors duration-[80ms]">
            later
          </button>
        </div>
      </div>
    )
  }

  if (notif.type === 'mcp_parse_done') {
    const handleOpenMcp = () => {
      window.dispatchEvent(new CustomEvent('open-mcp-parse-result', { detail: { result: notif.result } }))
      dismiss()
    }
    return (
      <div className="bg-x-surface border border-x-good/30 rounded-lg shadow-x-1 overflow-hidden animate-in slide-in-from-right">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-x-good/10 border-b border-x-good/20">
          <Server size={12} className="text-x-good" />
          <span className="text-[11px] font-medium text-x-good flex-1 truncate">
            MCP Parse Complete
          </span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms]">
            <X size={12} />
          </button>
        </div>
        <div className="px-2.5 py-1.5">
          <p className="text-[11px] text-x-ink-secondary">{notif.message}</p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-x-line">
          <button
            onClick={handleOpenMcp}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] bg-x-good/20 hover:bg-x-good/30 text-x-good border border-x-good/30 rounded transition-colors"
          >
            <Server size={10} />
            Open Config
          </button>
          <button onClick={dismiss} className="ml-auto text-[11px] text-x-muted hover:text-x-ink-secondary px-2 py-1.5 rounded hover:bg-x-hover transition-colors duration-[80ms]">
            later
          </button>
        </div>
      </div>
    )
  }

  if (notif.type === 'distill_error' || notif.type === 'mcp_parse_error') {
    return (
      <div className="bg-x-surface border border-x-line rounded-lg shadow-x-1 overflow-hidden animate-in slide-in-from-right">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-x-surface-2 border-b border-x-line">
          <X size={12} className="text-x-accent-ink" />
          <span className="text-[11px] font-medium text-x-accent-ink flex-1 truncate">
            {notif.type === 'distill_error' ? 'Distill Failed' : 'MCP Parse Failed'}
          </span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms]">
            <X size={12} />
          </button>
        </div>
        <div className="px-2.5 py-1.5">
          <p className="text-[11px] text-x-accent-ink/80 leading-relaxed line-clamp-3">{notif.message}</p>
        </div>
      </div>
    )
  }

  if (notif.type === 'branch_created') {
    return (
      <div className="bg-x-surface border border-x-line rounded-lg shadow-x-1 overflow-hidden animate-in slide-in-from-right">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-x-surface-2 border-b border-x-line">
          <GitBranch size={12} className="text-x-accent" />
          <span className="text-[11px] font-medium text-x-accent flex-1 truncate">Branch Detected</span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms]">
            <X size={12} />
          </button>
        </div>
        <div className="px-2.5 py-1.5">
          <p className="text-[11px] text-x-ink-secondary leading-relaxed">{notif.message}</p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-x-line">
          <button
            onClick={handleFocus}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] bg-x-accent/20 hover:bg-x-accent/30 text-x-accent border border-x-accent/30 rounded transition-colors"
          >
            <MessageSquare size={10} />
            View Session
          </button>
        </div>
      </div>
    )
  }

  if (notif.type === 'memory_sync_conflict') {
    const handleResolve = () => {
      window.dispatchEvent(new CustomEvent('open-memory-conflict', {
        detail: { workspaceId: notif.workspaceId }
      }))
      dismiss()
    }
    return (
      <div className="bg-x-surface border border-x-line rounded-lg shadow-x-1 overflow-hidden animate-in slide-in-from-right">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-x-surface-2 border-b border-x-line">
          <Brain size={12} className="text-x-accent-ink" />
          <span className="text-[11px] font-medium text-x-accent-ink flex-1 truncate">Memory Sync Conflict</span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms]">
            <X size={12} />
          </button>
        </div>
        <div className="px-2.5 py-1.5">
          <p className="text-[11px] text-x-ink-secondary leading-relaxed">{notif.message}</p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-x-line">
          <button
            onClick={handleResolve}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] bg-x-accent-ink/20 hover:bg-x-accent-ink/30 text-x-accent-ink border border-x-accent-ink/30 rounded transition-colors"
          >
            <Brain size={10} />
            Resolve
          </button>
          <button onClick={dismiss} className="ml-auto text-[11px] text-x-muted hover:text-x-ink-secondary px-2 py-1.5 rounded hover:bg-x-hover transition-colors duration-[80ms]">
            later
          </button>
        </div>
      </div>
    )
  }

  const tone = notif.type === 'success' ? 'success' : ['error','warning','auth_failed'].includes(notif.type) ? 'warning' : 'info'
  const Icon = tone === 'success' ? Check : tone === 'warning' ? AlertTriangle : Info
  return <article className={`ive-notice ive-notice--${tone}`} aria-label={`${tone} notification`}>
    <div className="ive-notice-heading">
      <span className="ive-notice-symbol"><Icon size={17}/></span>
      <NoticeMessage message={notif.message} full={!!notif.action} onToggle={event => setDetailsOpen(event.currentTarget.open)} />
      <button className="ive-notice-close" aria-label="Dismiss notification" onClick={dismiss}><X size={16}/></button>
    </div>
    {notif.action && typeof notif.action.onClick === 'function' && <div className="ive-notice-footer">
      <span className="ive-notice-context">{session?.name || 'IVE'}</span>
      <button className="ive-notice-action" disabled={actionBusy} onClick={async()=>{
        if(actionBusy)return
        setActionBusy(true)
        try {if(await notif.action.onClick()!==false)dismiss()}
        catch(error){useStore.getState().addNotification({type:'warning',message:error.message || 'The action failed. Please try again.'})}
        finally{setActionBusy(false)}
      }}>{actionBusy?'Working…':notif.action.label || 'Confirm'}</button>
    </div>}
  </article>
}

function NoticeMessage({ message, full = false, onToggle }) {
  const { preview, detail } = notificationPreview(message)
  return <div className="ive-notice-copy">
    <p className="ive-notice-message" role="status">{full ? message : preview}</p>
    {!full && detail && <HelpDetails label="Details" onToggle={onToggle}><p>{detail}</p></HelpDetails>}
  </div>
}
