import { useState, useRef, useEffect } from 'react'
import { Zap, X, CornerDownLeft } from 'lucide-react'
import useStore from '../../state/store'
import { sendForceMessage } from '../../lib/terminal'

/**
 * ForceBar — Shift+Enter force-message bar for Claude CLI sessions.
 *
 * Sends an Escape-interrupt + typed message to the active terminal.
 * If a second Shift+Enter fires before Claude starts working,
 * the new message is combined with the previous ones into:
 *
 *   "I paused, look at what you've done then continue with:
 *   -> first message
 *   -> second message"
 *
 * This lets the user interrupt, add context, and re-interrupt without
 * Claude seeing a confusing chain of partial messages.
 */

export default function ForceBar({ sessionId, onClose }) {
  const [text, setText] = useState('')
  const inputRef = useRef(null)

  const forceHistory = useStore((s) => s.forceHistory?.[sessionId])

  const isCombining = forceHistory && forceHistory.messages.length > 0

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = (e) => {
    e?.preventDefault()
    const msg = text.trim()
    if (!msg) return

    // Always wrap — Claude needs to know this is a correction/addition to
    // the previous message, not a brand new instruction.
    const all = isCombining ? [...forceHistory.messages, msg] : [msg]
    const points = all.map((m) => '-> ' + m).join('\n')
    const tail = all.length > 1
      ? 'If not conflicting, continue. Otherwise incorporate these.'
      : 'If not conflicting, continue. Otherwise incorporate this.'
    const formatted = `[Added to my last message]\n${points}\n${tail}`

    // Update store with the new message added to history
    const prev = (isCombining ? forceHistory.messages : [])
    useStore.getState().setForceHistory(sessionId, {
      messages: [...prev, msg],
    })

    // Interrupt Claude with a standalone Escape, wait for it to stop,
    // then send the message. sendForceMessage handles the timing.
    sendForceMessage(sessionId, formatted)

    setText('')
    onClose()
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/5 border-t border-amber-500/20 shrink-0"
    >
      <Zap size={11} className="text-amber-400 shrink-0" />
      <span className="text-[10px] text-amber-400 font-medium shrink-0 select-none">
        {isCombining ? `force +${forceHistory.messages.length}` : 'force'}
      </span>
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={isCombining
          ? `add to: "${forceHistory.messages[forceHistory.messages.length - 1].slice(0, 40)}..."`
          : 'interrupt Claude and say...'
        }
        className="flex-1 bg-transparent border-none text-xs text-text-primary placeholder-text-faint font-mono focus:outline-none"
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="submit"
        disabled={!text.trim()}
        className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium bg-amber-500/15 hover:bg-amber-500/25 disabled:opacity-30 text-amber-400 rounded transition-colors"
      >
        <CornerDownLeft size={9} /> send
      </button>
      <button
        type="button"
        onClick={onClose}
        className="p-0.5 text-text-faint hover:text-text-secondary"
      >
        <X size={11} />
      </button>
    </form>
  )
}
