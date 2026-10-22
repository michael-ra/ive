import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, ClipboardPaste, Keyboard, Menu, MessageSquare, SlidersHorizontal, Square, Terminal } from 'lucide-react'
import useStore from '../../state/store'
import { getCliLabel } from '../../lib/constants'
import { getSessionDisplayStatus, isShellSession } from '../../lib/sessionStatus'
import { cancelQueuedCommand } from '../../lib/terminal'
import { api } from '../../lib/api'
import { terminalControls } from '../../lib/terminalWriters'
import { isCtrlArmed, keyBytes, setCtrlArmed, subscribeCtrl } from '../../lib/phoneKeys'
import { interruptPhoneSession, phoneControlReason } from './phoneControlActions'
import PhoneSessionControls from './PhoneSessionControls'
import SessionContextActions from '../session/SessionContextActions'

// Session on the phone: one header row (back, name + status, Chat/Terminal
// switch, Stop while working, menu) and, in terminal view, a key bar right
// above the iOS keyboard for the keys it does not have.

export function PhoneSessionHeader({ sessionId, view, onView, onBack, onMenu }) {
  const session = useStore((s) => s.sessions[sessionId])
  const sessionStarted = useStore((s) => s.sessionStarted)
  const connected = useStore((s) => s.connected)
  const auth = useStore((s) => s.currentAuth)
  const [controls, setControls] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const current = useRef(sessionId)
  current.current = sessionId
  useEffect(() => { setControls(false); setStopping(false); setNotice(''); setError('') }, [sessionId])
  const meta = getSessionDisplayStatus(session, sessionStarted)
  const shell = isShellSession(session)
  const reason = phoneControlReason(session, { connected, auth })
  const interrupt = async () => {
    if (stopping) return
    setStopping(true); setNotice(''); setError('')
    try {
      const state = useStore.getState()
      await interruptPhoneSession(api, state.sessions[sessionId], { connected: state.connected, auth: state.currentAuth })
      for (const item of useStore.getState().queuedCommands?.[sessionId] || []) cancelQueuedCommand(sessionId, item.id)
      if (!shell) window.dispatchEvent(new CustomEvent('cc-session-interrupted', { detail: { sessionId, cliType: session?.cli_type } }))
      if (current.current === sessionId) setNotice('Unterbrechung an den Mac gesendet. Der Status aktualisiert sich automatisch.')
    } catch (failure) { if (current.current === sessionId) setError(failure?.message || 'Unterbrechung fehlgeschlagen.') }
    finally { if (current.current === sessionId) setStopping(false) }
  }
  return (<>
    <div className="ive-phone-session-head" data-phone-session-head="">
      <button type="button" className="ive-mobile-header-button" onClick={onBack} aria-label="Back to sessions">
        <ArrowLeft size={20} aria-hidden="true" />
      </button>
      <div className="ive-phone-session-title">
        <span className="ive-phone-session-name">{session?.name || 'Session'}</span>
        <span className={`ive-phone-session-sub ${meta.textClass}`}>
          <span className={`h-2 w-2 rounded-full shrink-0 ${meta.dotClass}`} aria-hidden="true" />
          <span data-phone-status="">{meta.label}</span>
          <span className="text-x-faint">· {shell ? 'Mac-Shell' : getCliLabel(session?.cli_type || 'claude')}</span>
        </span>
      </div>
      {!shell && <div className="ive-phone-view-switch" role="group" aria-label="View">
        <button type="button" aria-pressed={view === 'chat'} aria-label="Chat view" onClick={() => onView('chat')}>
          <MessageSquare size={17} aria-hidden="true" />
        </button>
        <button type="button" aria-pressed={view === 'terminal'} aria-label="Terminal view" onClick={() => onView('terminal')}>
          <Terminal size={17} aria-hidden="true" />
        </button>
      </div>}
      {!shell && <SessionContextActions sessionId={sessionId} readOnly={!!session?.read_only} phone />}
      <button type="button" className="ive-mobile-header-button" onClick={() => setControls(true)} aria-label="Session steuern" aria-expanded={controls}>
        <SlidersHorizontal size={20} aria-hidden="true" />
      </button>
      <button type="button" className="ive-mobile-header-button" onClick={onMenu} aria-label="Open sidebar">
        <Menu size={20} aria-hidden="true" />
      </button>
    </div>
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-x-line bg-x-surface px-3 py-2 text-xs" data-phone-control-status="">
      <span className={reason ? 'text-x-warning' : 'text-x-muted'} role="status">{reason || (shell ? 'Echte Shell · Befehle laufen direkt auf dem Mac' : 'Gemeinsamer Chat und Verlauf mit dem Mac')}</span>
      {(meta.isWorking || meta.tone === 'waiting' || shell && session?.pty_alive) && <button type="button" className="ive-phone-stop disabled:opacity-50" disabled={!!reason || stopping} onClick={interrupt} aria-label={shell ? 'Interrupt shell command' : 'Stop the current answer'}>
        <Square size={14} aria-hidden="true" /><span>{stopping ? 'Wird gesendet …' : 'Unterbrechen'}</span>
      </button>}
      {error && <p role="alert" className="w-full text-x-danger">{error}</p>}
      {notice && !error && <p role="status" className="w-full text-x-muted">{notice}</p>}
    </div>
    {controls && <PhoneSessionControls key={sessionId} sessionId={sessionId} onClose={() => setControls(false)} />}
  </>
  )
}

const ctrlSnapshot = (id) => () => isCtrlArmed(id)

// A key press must not take focus from the terminal (that would close the
// iOS keyboard). On touch the key acts on touchend and cancels it, which
// suppresses the emulated mouse events and the focus change (cancelling
// pointerdown instead would swallow the click in WebKit). A finger that
// moved was scrolling the key row, not pressing. Mouse: mousedown is
// cancelled, the click acts.
let touchStart = null
export function keyTap(action) {
  return {
    onTouchStart: (e) => { const t = e.touches[0]; touchStart = t ? { x: t.clientX, y: t.clientY } : null },
    onTouchEnd: (e) => {
      const t = e.changedTouches[0]
      const moved = touchStart && t && Math.hypot(t.clientX - touchStart.x, t.clientY - touchStart.y) > 10
      touchStart = null
      if (e.cancelable) e.preventDefault()
      if (!moved) action()
    },
    onMouseDown: (e) => e.preventDefault(),
    onClick: action,
  }
}

function sendBytes(sessionId, data) {
  const state = useStore.getState()
  const target = state.sessions[sessionId]
  const reason = phoneControlReason(target, { connected: state.connected && state.ws?.readyState === WebSocket.OPEN, auth: state.currentAuth }) || (!target?.pty_alive ? 'Das Terminal ist noch nicht bereit.' : '')
  if (reason || !data) {
    if (reason) state.addNotification?.({ type: 'error', sessionId, message: reason })
    return false
  }
  const ctrl = terminalControls.get(sessionId)
  if (ctrl?.input) { ctrl.input(data); return true }
  const ws = useStore.getState().ws
  if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ action: 'input', session_id: sessionId, data })); return true }
  state.addNotification?.({ type: 'error', sessionId, message: 'Keine Terminal-Verbindung. Die Taste wurde nicht gesendet.' })
  return false
}

const KEYS = [
  { id: 'esc', label: 'Esc', aria: 'Escape' },
  { id: 'ctrl', label: '⌃', aria: 'Control (next key)' },
  { id: 'tab', label: 'Tab', aria: 'Tab' },
  { id: 'ctrl-c', label: '⌃C', aria: 'Control C' },
  { id: 'up', label: '↑', aria: 'Arrow up' },
  { id: 'down', label: '↓', aria: 'Arrow down' },
  { id: 'left', label: '←', aria: 'Arrow left' },
  { id: 'right', label: '→', aria: 'Arrow right' },
  { id: 'ctrl-r', label: '⌃R', aria: 'Control R' },
  { id: 'ctrl-d', label: '⌃D', aria: 'Control D' },
  { id: 'shift-tab', label: '⇧Tab', aria: 'Shift Tab' },
  { id: 'slash', label: '/', aria: 'Slash' },
  { id: 'pipe', label: '|', aria: 'Pipe' },
  { id: 'tilde', label: '~', aria: 'Tilde' },
]
const ARROW_FINAL = { up: 'A', down: 'B', right: 'C', left: 'D' }

export function PhoneKeyBar({ sessionId }) {
  const armed = useSyncExternalStore(subscribeCtrl, ctrlSnapshot(sessionId))
  const readOnly = useStore((s) => !!s.sessions[sessionId]?.read_only)
  const session = useStore((s) => s.sessions[sessionId])
  const connected = useStore((s) => s.connected)
  const auth = useStore((s) => s.currentAuth)
  const blocked = !!phoneControlReason(session, { connected, auth }) || !session?.pty_alive

  const press = (id) => {
    if (id === 'ctrl') { setCtrlArmed(sessionId, !armed); return }
    const ctrl = terminalControls.get(sessionId)
    if (ARROW_FINAL[id] && armed) {
      // ⌃ + arrow: xterm's modifier form (word jumps in readline, Claude).
      setCtrlArmed(sessionId, false)
      sendBytes(sessionId, `\x1b[1;5${ARROW_FINAL[id]}`)
      return
    }
    if (armed && (id === 'slash')) { setCtrlArmed(sessionId, false); sendBytes(sessionId, '\x1f'); return }
    if (armed) setCtrlArmed(sessionId, false)
    sendBytes(sessionId, keyBytes(id, { appCursor: !!ctrl?.appCursor?.() }))
  }

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return
      const state = useStore.getState()
      const target = state.sessions[sessionId]
      const reason = phoneControlReason(target, { connected: state.connected && state.ws?.readyState === WebSocket.OPEN, auth: state.currentAuth }) || (!target?.pty_alive ? 'Das Terminal ist noch nicht bereit.' : '')
      if (reason) throw new Error(reason)
      const ctrl = terminalControls.get(sessionId)
      if (ctrl?.paste) ctrl.paste(text)
      else sendBytes(sessionId, text)
    } catch (error) {
      useStore.getState().addNotification?.({ type: 'info', message: error?.message || 'Paste needs clipboard access. Long-press inside the terminal and tap Paste.' })
    }
  }

  const font = (delta) => terminalControls.get(sessionId)?.stepPhoneFont?.(delta)

  const toggleKeyboard = () => {
    const ctrl = terminalControls.get(sessionId)
    if (ctrl?.hasFocus?.()) ctrl.blur?.()
    else ctrl?.focus?.()
  }

  if (readOnly) return null
  return (
    <div className="ive-phone-keybar" data-phone-keybar="" role="toolbar" aria-label="Terminal keys">
      <div className="ive-phone-keys">
        {KEYS.map((k) => (
          <button
            key={k.id}
            type="button"
            tabIndex={-1}
            disabled={blocked}
            data-key={k.id}
            aria-label={k.aria}
            aria-pressed={k.id === 'ctrl' ? armed : undefined}
            className={k.id === 'ctrl' && armed ? 'is-armed' : undefined}
            {...keyTap(() => press(k.id))}
          >{k.label}</button>
        ))}
        <button type="button" disabled={blocked} tabIndex={-1} data-key="paste" aria-label="Paste" {...keyTap(paste)}>
          <ClipboardPaste size={16} aria-hidden="true" />
        </button>
        <button type="button" tabIndex={-1} data-key="font-down" aria-label="Smaller text" {...keyTap(() => font(-1))}>A−</button>
        <button type="button" tabIndex={-1} data-key="font-up" aria-label="Larger text" {...keyTap(() => font(1))}>A+</button>
      </div>
      <button type="button" tabIndex={-1} className="ive-phone-keyboard-toggle" data-key="keyboard" aria-label="Show or hide the keyboard" {...keyTap(toggleKeyboard)}>
        <Keyboard size={18} aria-hidden="true" />
      </button>
    </div>
  )
}
