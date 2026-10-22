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
      className="flex items-center gap-2 px-3 py-1.5 bg-x-accent-ink/10 border-t border-x-accent-ink/30 shrink-0"
    >
      <Zap size={11} className="text-x-accent-ink shrink-0" />
      <span className="text-[11px] text-x-accent-ink font-medium shrink-0 select-none">
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
        className="flex-1 bg-transparent border-none text-xs text-x-ink placeholder:text-x-muted focus:outline-none"
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="submit"
        disabled={!text.trim()}
        className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium bg-x-accent-ink/10 border border-x-accent-ink/30 hover:bg-x-accent-ink/20 disabled:opacity-40 text-x-accent-ink rounded-md transition-colors duration-[80ms]"
      >
        <CornerDownLeft size={9} /> send
      </button>
      <button
        type="button"
        onClick={onClose}
        className="p-0.5 text-x-muted hover:text-x-ink transition-colors duration-[80ms]"
      >
        <X size={11} />
      </button>
    </form>
  )
}
