import { useEffect, useMemo, useRef, useState } from 'react'
import { BookPlus, FolderInput, Loader2, X } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { submitSessionContext } from '../../lib/contextDelivery'
import { attachSessionToProject, composeContextMessage, isQuickSession } from '../../lib/quickStart'
import { Button, IconButton } from '../ui'
import WorkspacePicker from '../workspace/WorkspacePicker'
import { emitTourEvent } from '../../lib/guidedTour'

const PILL = 'flex items-center gap-1.5 px-3 h-[30px] text-x-ink-secondary hover:text-x-ink bg-transparent hover:bg-x-hover border border-x-line hover:border-x-line-strong transition-colors duration-[80ms]'

/**
 * "Looks like this is <name>. Attach?" — shown inline in the session header
 * (no extra full-width row) when the backend recognised the project a quick
 * session is working in.
 */
export function ProjectHintChip({ sessionId }) {
  const hint = useStore((s) => s.projectHints[sessionId])
  const session = useStore((s) => s.sessions[sessionId])
  const quickStart = useStore((s) => s.quickStart)
  const [busy, setBusy] = useState(false)
  const quick = isQuickSession(session, quickStart)

  // A hint may have been broadcast before this client was open.
  useEffect(() => {
    if (!sessionId || !quick || useStore.getState().projectHints[sessionId]) return
    let cancelled = false
    api.getProjectHint(sessionId).then((data) => {
      if (!cancelled && data?.path) useStore.getState().setProjectHint(sessionId, data)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [sessionId, quick])

  if (!hint || !quick) return null
  const attach = async () => {
    if (busy) return
    setBusy(true)
    try {
      await attachSessionToProject(sessionId, hint.workspace_id ? { workspace_id: hint.workspace_id, name: hint.name } : { path: hint.path, name: hint.name })
    } catch (err) {
      useStore.getState().addNotification?.({ type: 'error', sessionId, message: err?.message || 'Could not attach the session.' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      role="status"
      data-project-hint
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-x-tint-line bg-x-tint py-1 pl-2.5 pr-1 text-[12px] text-x-ink"
      title={hint.path}
    >
      <FolderInput size={13} className="shrink-0 text-x-accent-ink" />
      <span className="whitespace-nowrap" title={`Looks like this is ${hint.name}. Attach?`}>
        <span className="hidden min-[1400px]:inline">Looks like this is </span>
        <strong className="inline-block max-w-[140px] truncate align-bottom font-semibold">{hint.name}</strong>
        <span className="hidden min-[1400px]:inline">. Attach</span>?
      </span>
      <Button size="sm" variant="primary" onClick={attach} loading={busy} disabled={busy}>Attach</Button>
      <IconButton
        icon={X}
        label="Dismiss"
        size="sm"
        variant="default"
        iconSize={13}
        title="Dismiss"
        onClick={() => useStore.getState().clearProjectHint(sessionId, { dismiss: true })}
        className="border-transparent bg-transparent"
      />
    </div>
  )
}

function AddContextPanel({ sessionId, anchor, onClose }) {
  const sessionName = useStore((s) => s.sessions[sessionId]?.name || 'this session')
  const [guidelines, setGuidelines] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const [filter, setFilter] = useState('')
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const sendingRef = useRef(false)
  const panelRef = useRef(null)
  const noteRef = useRef(null)

  useEffect(() => {
    const prefill = (event) => {
      if (event.detail?.sessionId !== sessionId || sendingRef.current || typeof event.detail.text !== 'string') return
      setNote((previous) => previous.includes(event.detail.text) ? previous : previous.trim() ? `${previous}\n\n${event.detail.text}` : event.detail.text)
      noteRef.current?.focus()
    }
    window.addEventListener('ive-tour-context-example', prefill)
    return () => window.removeEventListener('ive-tour-context-example', prefill)
  }, [sessionId])

  useEffect(() => {
    let cancelled = false
    api.getGuidelines()
      .then((list) => { if (!cancelled) setGuidelines(Array.isArray(list) ? list : []) })
      .catch((err) => { if (!cancelled) { setGuidelines([]); setLoadError(err?.message || 'Guidelines could not be loaded.') } })
    noteRef.current?.focus()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const onDown = (e) => {
      if (sendingRef.current) return
      if (panelRef.current?.contains(e.target) || anchor?.contains(e.target) || e.target.closest?.('[data-interactive-tour]')) return
      onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [anchor, onClose])

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (guidelines || []).filter((g) => !q || `${g.name} ${g.content}`.toLowerCase().includes(q))
  }, [guidelines, filter])

  const chosen = (guidelines || []).filter((g) => selected.has(g.id))
  const message = composeContextMessage(chosen, note)
  const send = async () => {
    if (!message || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setSendError('')
    emitTourEvent('context-started', { sessionId, replyAfter: Date.now(), baselineIds: (useStore.getState().messages[sessionId] || []).slice(-200).map((item) => String(item.id)) })
    try {
      await submitSessionContext(sessionId, message, {
        ensureRunning: (id) => useStore.getState().ensureSessionRunning(id),
        sendInput: api.sendSessionInput,
      })
      useStore.getState().addNotification?.({ type: 'success', sessionId, message: `Context submitted to ${sessionName}.` })
      emitTourEvent('context-sent', { sessionId })
      onClose()
    } catch (err) {
      emitTourEvent('context-failed', { sessionId })
      setSendError(err?.body?.startup_blocker?.label || err?.message || 'Context could not be sent. Your note is still here; retry when the session is ready.')
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const rect = anchor?.getBoundingClientRect()
  // Right-aligned to the button, but never past the left edge: on phones the
  // button sits mid-header and the panel is almost as wide as the screen.
  const panelWidth = Math.min(380, window.innerWidth - 16)
  const style = rect
    ? { top: rect.bottom + 6, right: Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - panelWidth - 8)) }
    : { top: 80, right: 16 }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Add context"
      data-ive-popover
      data-add-context
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!sendingRef.current) onClose() }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() }
      }}
      className="fixed z-[120] w-[min(380px,calc(100vw-16px))] rounded-[10px] border border-x-line bg-x-surface shadow-[var(--x-shadow-3)] scale-in"
      style={style}
    >
      <div className="px-3.5 pt-3 pb-2">
        <div className="text-[13px] font-semibold text-x-ink">Add context</div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-x-muted">Send background, requirements, or guidelines to <strong>{sessionName}</strong> as one message. Other sessions do not receive it.</p>
        <p className="mt-1 text-[11px] leading-relaxed text-x-muted">For reusable project knowledge, use Know → Context Hub.</p>
      </div>
      <div className="px-3.5">
        {guidelines === null ? (
          <p className="flex items-center gap-2 py-3 text-[12px] text-x-muted"><Loader2 size={13} className="animate-spin" /> Loading guidelines…</p>
        ) : guidelines.length === 0 ? (
          <p className="py-2 text-[12px] text-x-muted">{loadError || 'No guidelines yet. A note works too.'}</p>
        ) : (
          <>
            {guidelines.length > 6 && (
              <input
                aria-label="Filter guidelines"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter guidelines"
                className="mb-1.5 w-full rounded-md border border-x-line bg-x-surface-2 px-2 py-1 text-[12px] text-x-ink outline-none focus:border-x-accent"
              />
            )}
            <div className="max-h-[200px] space-y-0.5 overflow-y-auto" role="group" aria-label="Guidelines">
              {visible.map((g) => (
                <label key={g.id} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-x-hover">
                  <input
                    type="checkbox"
                    checked={selected.has(g.id)}
                    onChange={() => setSelected((prev) => {
                      const next = new Set(prev)
                      if (next.has(g.id)) next.delete(g.id); else next.add(g.id)
                      return next
                    })}
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-medium text-x-ink">{g.name}</span>
                    <span className="block truncate text-[11px] text-x-muted">{String(g.content || '').split('\n')[0]}</span>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}
        <textarea
          ref={noteRef}
          disabled={sending}
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-label="Note for the agent"
          placeholder="Anything else the agent should know? Links, constraints, where to look…"
          className="mt-2 w-full resize-y rounded-md border border-x-line bg-x-surface-2 px-2.5 py-2 text-[12px] leading-relaxed text-x-ink outline-none placeholder:text-x-muted focus:border-x-accent"
        />
      </div>
      {sendError && <p role="alert" className="px-3.5 pt-2 text-[12px] text-x-danger">{sendError}</p>}
      {sending && <p role="status" className="px-3.5 pt-2 text-[12px] text-x-muted">Waiting for the agent to accept the context…</p>}
      <div className="flex items-center justify-end gap-1.5 px-3.5 pt-1 pb-3">
        <span className="mr-auto text-[11px] text-x-faint">{chosen.length ? `${chosen.length} selected` : ''}</span>
        <Button size="sm" disabled={sending} onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!message || sending} loading={sending} onClick={send} title="Send (⌘Enter)">Send context</Button>
      </div>
    </div>
  )
}

/**
 * "context" (all sessions) and "attach" (quick sessions) in the session header.
 * `phone`: the phone session header has no TopBar, so it renders the same
 * actions as 44 px icon buttons (the guided tour targets this button too).
 */
export default function SessionContextActions({ sessionId, readOnly = false, phone = false }) {
  const session = useStore((s) => s.sessions[sessionId])
  const quickStart = useStore((s) => s.quickStart)
  const hintName = useStore((s) => s.projectHints[sessionId]?.name)
  const [showContext, setShowContext] = useState(false)
  const [showAttach, setShowAttach] = useState(false)
  const contextBtnRef = useRef(null)
  const quick = isQuickSession(session, quickStart)

  useEffect(() => { setShowContext(false); setShowAttach(false) }, [sessionId])

  if (readOnly || !session) return null
  const panels = (
    <>
      {showContext && (
        <AddContextPanel sessionId={sessionId} anchor={contextBtnRef.current} onClose={() => setShowContext(false)} />
      )}
      {showAttach && (
        <WorkspacePicker
          title="Attach to project"
          initialQuery={hintName || ''}
          subtitle="Move this quick session into a project. The agent keeps running."
          onClose={() => setShowAttach(false)}
          onSelect={async (project) => {
            await attachSessionToProject(sessionId, project.workspace_id
              ? { workspace_id: project.workspace_id, name: project.name }
              : { path: project.path, name: project.name })
            setShowAttach(false)
          }}
        />
      )}
    </>
  )
  if (phone) return (
    <>
      <button type="button" ref={contextBtnRef} data-tour="session-context" className="ive-mobile-header-button"
        onClick={() => setShowContext((v) => !v)} aria-expanded={showContext} aria-label="Add context">
        <BookPlus size={19} aria-hidden="true" />
      </button>
      {quick && (
        <button type="button" className="ive-mobile-header-button" onClick={() => setShowAttach(true)} aria-label="Attach to project">
          <FolderInput size={19} aria-hidden="true" />
        </button>
      )}
      {panels}
    </>
  )
  return (
    <>
      <Button type="button"
        ref={contextBtnRef}
        data-tour="session-context"
        data-chrome-button
        onClick={() => setShowContext((v) => !v)}
        aria-expanded={showContext}
        aria-label="Add context"
        className={PILL}
        title="Add context: guidelines or a note for the agent"
      >
        <BookPlus size={13} className="text-x-ink-secondary" />
        <span className="ive-ctx-label hidden min-[1280px]:inline text-[11px] font-medium">context</span>
      </Button>
      {quick && (
        <Button type="button"
          data-chrome-button
          onClick={() => setShowAttach(true)}
          aria-label="Attach to project"
          className={PILL}
          title="Attach this quick session to a project"
        >
          <FolderInput size={13} className="text-x-ink-secondary" />
          <span className="ive-ctx-label hidden min-[1280px]:inline text-[11px] font-medium">attach</span>
        </Button>
      )}
      {panels}
    </>
  )
}

