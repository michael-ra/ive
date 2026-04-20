import { useEffect } from 'react'
import { Shield, Check, X, MessageSquare, FileText, RotateCcw, Sparkles, Server, Zap } from 'lucide-react'
import useStore from '../../state/store'
import { sendTerminalCommand, typeInTerminal, sendPlanChoice } from '../../lib/terminal'
import { clearPromptBuffer } from '../../lib/outputParser'

export default function NotificationToast() {
  const notifications = useStore((s) => s.notifications)

  if (notifications.length === 0) return null

  return (
    <div className="fixed top-3 right-3 z-50 flex flex-col gap-1 max-w-sm">
      {notifications.map((notif) => (
        <Toast key={notif.id} notif={notif} />
      ))}
    </div>
  )
}

function Toast({ notif }) {
  const sessions = useStore((s) => s.sessions)
  const session = sessions[notif.sessionId]

  // Auto-dismiss after 30s
  useEffect(() => {
    const timer = setTimeout(() => {
      useStore.getState().removeNotification(notif.id)
    }, 30000)
    return () => clearTimeout(timer)
  }, [notif.id])

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

  if (notif.type === 'plan_ready') {
    return (
      <div className="bg-[#161622] border border-orange-500/30 rounded-lg shadow-2xl overflow-hidden animate-in slide-in-from-right">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-orange-500/10 border-b border-orange-500/20">
          <FileText size={12} className="text-orange-400" />
          <span className="text-[11px] font-mono text-orange-300 flex-1 truncate">
            Plan Ready
          </span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors">
            <X size={12} />
          </button>
        </div>

        <div className="px-2.5 py-1.5">
          <p className="text-[11px] font-mono text-zinc-300 leading-relaxed line-clamp-3">
            {notif.message}
          </p>
        </div>

        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-zinc-800">
          <button
            onClick={handleReviewPlan}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-mono bg-orange-600/20 hover:bg-orange-600/30 text-orange-300 border border-orange-500/30 rounded transition-colors"
          >
            <FileText size={10} />
            Review Plan
          </button>
          <button
            onClick={handleFocus}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-mono text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800 rounded transition-colors ml-auto"
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
      if (style === 'primary') return 'bg-green-600/20 hover:bg-green-600/30 text-green-300 border border-green-500/30'
      if (style === 'danger') return 'bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-500/30'
      return 'text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800 border border-zinc-700/30'
    }

    return (
      <div className="bg-[#161622] border border-amber-500/30 rounded-lg shadow-2xl overflow-hidden animate-in slide-in-from-right max-w-sm">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-amber-500/10 border-b border-amber-500/20">
          <MessageSquare size={12} className="text-amber-400" />
          <span className="text-[11px] font-mono text-amber-300 flex-1 truncate">
            {session?.name || notif.sessionId.slice(0, 8)}
          </span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors">
            <X size={12} />
          </button>
        </div>
        <div className="px-2.5 py-1.5">
          <p className="text-[11px] font-mono text-zinc-300 leading-relaxed">{notif.message}</p>
          {notif.context && !options.length && (
            <pre className="mt-1 text-[10px] font-mono text-zinc-500 leading-tight max-h-24 overflow-y-auto whitespace-pre-wrap break-words">
              {notif.context.split('\n').filter(l => l.trim()).slice(-10).join('\n')}
            </pre>
          )}
        </div>

        {options.length > 0 && (
          <div className="px-2.5 py-1.5 border-t border-zinc-800 space-y-1">
            {options.map((opt) => (
              <button
                key={opt.num}
                onClick={() => handleOption(opt)}
                className={`w-full text-left px-2.5 py-1.5 text-[11px] font-mono rounded transition-colors flex items-center gap-1 ${
                  opt.num === 1
                    ? 'bg-green-600/15 hover:bg-green-600/25 text-green-300 border border-green-500/20'
                    : opt.text.toLowerCase().includes('no') || opt.text.toLowerCase().includes('reject')
                      ? 'bg-red-600/10 hover:bg-red-600/20 text-red-300 border border-red-500/20'
                      : 'bg-zinc-800/50 hover:bg-zinc-700/50 text-zinc-300 border border-zinc-700/30'
                }`}
              >
                <span className="text-zinc-500">{opt.num}.</span>
                <span className="truncate">{opt.text}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-zinc-800">
          {actions.map((action, i) => (
            <button
              key={i}
              onClick={() => handleAction(action)}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-mono rounded transition-colors ${actionStyle(action.style)}`}
            >
              {action.style === 'primary' && <Check size={10} />}
              {action.style === 'danger' && <X size={10} />}
              {action.label}
            </button>
          ))}
          <button
            onClick={handleFocus}
            className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-mono text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded transition-colors ml-auto"
          >
            View session
          </button>
        </div>
      </div>
    )
  }

  if (notif.type === 'permission_question') {
    const handleJustDoIt = () => {
      sendTerminalCommand(notif.sessionId, 'Yes, go ahead and implement it.')
      clearPromptBuffer(notif.sessionId)
      dismiss()
    }
    return (
      <div className="bg-[#161622] border border-yellow-500/30 rounded-lg shadow-2xl overflow-hidden animate-in slide-in-from-right max-w-sm">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-yellow-500/10 border-b border-yellow-500/20">
          <Zap size={12} className="text-yellow-400" />
          <span className="text-[11px] font-mono text-yellow-300 flex-1 truncate">
            {session?.name || notif.sessionId.slice(0, 8)} — asking permission
          </span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors">
            <X size={12} />
          </button>
        </div>
        <div className="px-2.5 py-1.5">
          {notif.question && (
            <p className="text-[11px] font-mono text-zinc-300 leading-relaxed line-clamp-2 italic">
              &ldquo;{notif.question}&rdquo;
            </p>
          )}
          {notif.context && (
            <pre className="mt-1 text-[10px] font-mono text-zinc-500 leading-tight max-h-16 overflow-y-auto whitespace-pre-wrap break-words">
              {notif.context.split('\n').filter(l => l.trim()).slice(-5).join('\n')}
            </pre>
          )}
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-zinc-800">
          <button
            onClick={handleJustDoIt}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-mono bg-yellow-600/20 hover:bg-yellow-600/30 text-yellow-300 border border-yellow-500/30 rounded transition-colors"
          >
            <Zap size={10} />
            Just do it
          </button>
          <button
            onClick={handleFocus}
            className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-mono text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded transition-colors ml-auto"
          >
            View session
          </button>
        </div>
      </div>
    )
  }

  if (notif.type === 'session_done') {
    return (
      <div className="bg-[#161622] border border-green-500/30 rounded-lg shadow-2xl overflow-hidden animate-in slide-in-from-right">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-green-500/10 border-b border-green-500/20">
          <Check size={12} className="text-green-400" />
          <span className="text-[11px] font-mono text-green-300 flex-1 truncate">
            {session?.name || notif.sessionId.slice(0, 8)}
          </span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors">
            <X size={12} />
          </button>
        </div>
        <div className="px-2.5 py-1.5">
          <p className="text-[11px] font-mono text-zinc-300">{notif.message}</p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-zinc-800">
          <button
            onClick={handleFocus}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-mono bg-green-600/20 hover:bg-green-600/30 text-green-300 border border-green-500/30 rounded transition-colors"
          >
            <MessageSquare size={10} /> View output
          </button>
        </div>
      </div>
    )
  }

  if (notif.type === 'permission') {
    return (
      <div className="bg-[#161622] border border-amber-500/30 rounded-lg shadow-2xl overflow-hidden animate-in slide-in-from-right">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-amber-500/10 border-b border-amber-500/20">
          <Shield size={12} className="text-amber-400" />
          <span className="text-[11px] font-mono text-amber-300 flex-1 truncate">
            {session?.name || notif.sessionId.slice(0, 8)}
          </span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors">
            <X size={12} />
          </button>
        </div>

        <div className="px-2.5 py-1.5">
          <p className="text-[11px] font-mono text-zinc-300 leading-relaxed line-clamp-3">
            {notif.message}
          </p>
        </div>

        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-zinc-800">
          <button
            onClick={() => handleAction({ key: 'enter' })}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-mono bg-green-600/20 hover:bg-green-600/30 text-green-300 border border-green-500/30 rounded transition-colors"
          >
            <Check size={10} />
            Allow
          </button>
          <button
            onClick={() => handleAction({ key: 'escape' })}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-mono bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-500/30 rounded transition-colors"
          >
            <X size={12} />
            Reject
          </button>
          <button
            onClick={handleFocus}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-mono text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800 rounded transition-colors ml-auto"
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
      <div className="bg-[#161622] border border-amber-500/30 rounded-lg shadow-2xl overflow-hidden animate-in slide-in-from-right">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-amber-500/10 border-b border-amber-500/20">
          <Check size={12} className="text-amber-400" />
          <span className="text-[11px] font-mono text-amber-300 flex-1 truncate">
            Skill Installed
          </span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors">
            <X size={12} />
          </button>
        </div>
        <div className="px-2.5 py-1.5">
          <p className="text-[11px] font-mono text-zinc-300">{notif.message}</p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-zinc-800">
          <button
            onClick={handleRestartAll}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-mono bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/30 rounded transition-colors"
          >
            <RotateCcw size={10} />
            Restart all sessions
          </button>
          <button onClick={dismiss} className="ml-auto text-[11px] font-mono text-zinc-500 hover:text-zinc-300 px-2 py-1.5 rounded hover:bg-zinc-800 transition-colors">
            later
          </button>
        </div>
      </div>
    )
  }

  if (notif.type === 'guideline_recommendation') {
    const count = notif.recommendations?.length || 0
    const handleOpenGuidelines = () => {
      window.dispatchEvent(new CustomEvent('open-guidelines'))
      dismiss()
    }
    return (
      <div className="bg-[#161622] border border-indigo-500/30 rounded-lg shadow-2xl overflow-hidden animate-in slide-in-from-right">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-indigo-500/10 border-b border-indigo-500/20">
          <Sparkles size={12} className="text-indigo-400" />
          <span className="text-[11px] font-mono text-indigo-300 flex-1 truncate">
            {count} guideline{count !== 1 ? 's' : ''} recommended
          </span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors">
            <X size={12} />
          </button>
        </div>
        <div className="px-2.5 py-1.5">
          <p className="text-[11px] font-mono text-zinc-400 leading-relaxed line-clamp-2">
            {notif.recommendations?.[0]?.name}{count > 1 ? ` + ${count - 1} more` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-zinc-800">
          <button
            onClick={handleOpenGuidelines}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-mono bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 rounded transition-colors"
          >
            <Shield size={10} />
            Open Guidelines
          </button>
          <button onClick={dismiss} className="ml-auto text-[11px] font-mono text-zinc-500 hover:text-zinc-300 px-2 py-1.5 rounded hover:bg-zinc-800 transition-colors">
            later
          </button>
        </div>
      </div>
    )
  }

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
      <div className="bg-[#161622] border border-indigo-500/30 rounded-lg shadow-2xl overflow-hidden animate-in slide-in-from-right">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-indigo-500/10 border-b border-indigo-500/20">
          <Sparkles size={12} className="text-indigo-400" />
          <span className="text-[11px] font-mono text-indigo-300 flex-1 truncate">
            Distill Complete
          </span>
          <button onClick={handleDismissToInbox} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors">
            <X size={12} />
          </button>
        </div>
        <div className="px-2.5 py-1.5">
          <p className="text-[11px] font-mono text-zinc-300 leading-relaxed line-clamp-2">
            {notif.message}
          </p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-zinc-800">
          <button
            onClick={handleOpenDistill}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-mono bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 rounded transition-colors"
          >
            <Sparkles size={10} />
            Open Preview
          </button>
          <button onClick={handleDismissToInbox} className="ml-auto text-[11px] font-mono text-zinc-500 hover:text-zinc-300 px-2 py-1.5 rounded hover:bg-zinc-800 transition-colors">
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
      <div className="bg-[#161622] border border-emerald-500/30 rounded-lg shadow-2xl overflow-hidden animate-in slide-in-from-right">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-emerald-500/10 border-b border-emerald-500/20">
          <Server size={12} className="text-emerald-400" />
          <span className="text-[11px] font-mono text-emerald-300 flex-1 truncate">
            MCP Parse Complete
          </span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors">
            <X size={12} />
          </button>
        </div>
        <div className="px-2.5 py-1.5">
          <p className="text-[11px] font-mono text-zinc-300">{notif.message}</p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-zinc-800">
          <button
            onClick={handleOpenMcp}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-mono bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 rounded transition-colors"
          >
            <Server size={10} />
            Open Config
          </button>
          <button onClick={dismiss} className="ml-auto text-[11px] font-mono text-zinc-500 hover:text-zinc-300 px-2 py-1.5 rounded hover:bg-zinc-800 transition-colors">
            later
          </button>
        </div>
      </div>
    )
  }

  if (notif.type === 'distill_error' || notif.type === 'mcp_parse_error') {
    return (
      <div className="bg-[#161622] border border-red-500/30 rounded-lg shadow-2xl overflow-hidden animate-in slide-in-from-right">
        <div className="flex items-center gap-1 px-2.5 py-1.5 bg-red-500/10 border-b border-red-500/20">
          <X size={12} className="text-red-400" />
          <span className="text-[11px] font-mono text-red-300 flex-1 truncate">
            {notif.type === 'distill_error' ? 'Distill Failed' : 'MCP Parse Failed'}
          </span>
          <button onClick={dismiss} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors">
            <X size={12} />
          </button>
        </div>
        <div className="px-2.5 py-1.5">
          <p className="text-[11px] font-mono text-red-300/80 leading-relaxed line-clamp-3">{notif.message}</p>
        </div>
      </div>
    )
  }

  // Generic notification
  return (
    <div className="bg-[#161622] border border-zinc-700 rounded-lg shadow-2xl p-3">
      <div className="flex items-start gap-1">
        <span className="text-[11px] font-mono text-zinc-300 flex-1">{notif.message}</span>
        <button onClick={dismiss} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 shrink-0 transition-colors">
          <X size={12} />
        </button>
      </div>
    </div>
  )
}
