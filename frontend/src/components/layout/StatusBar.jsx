import { useState, useRef, useEffect } from 'react'
import { UsersRound } from 'lucide-react'
import useStore from '../../state/store'
import MailboxPill from './MailboxPill'
import ThemeToggle from '../ui/ThemeToggle'
import { Button } from '../ui'

const PEER_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#f97316', '#84cc16', '#ef4444', '#6366f1']

function compactNumber(value) {
  const n = Number(value) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

function IdentityEditor({ onClose }) {
  const myName = useStore((s) => s.myName)
  const myColor = useStore((s) => s.myColor)
  const setMyName = useStore((s) => s.setMyName)
  const setMyColor = useStore((s) => s.setMyColor)
  const [name, setName] = useState(myName || '')
  const inputRef = useRef(null)
  const panelRef = useRef(null)

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [])

  useEffect(() => {
    const h = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) onClose()
    }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [onClose])

  const save = () => {
    const trimmed = name.trim()
    if (trimmed && trimmed !== myName) setMyName(trimmed)
    onClose()
  }

  return (
    <div
      ref={panelRef}
      className="absolute bottom-9 right-0 z-50 bg-x-surface border border-x-line rounded-[10px] shadow-x-1 p-2.5 w-56"
    >
      <div className="text-xs font-medium text-x-ink-secondary mb-1.5">Your identity</div>
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onClose() }}
        className="w-full bg-x-surface-2 border border-x-line rounded-md px-2 py-1 text-xs text-x-ink placeholder:text-x-muted outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus mb-2"
        placeholder="Display name"
        maxLength={24}
      />
      <div className="flex gap-1 flex-wrap">
        {PEER_COLORS.map((c) => (
          <button
            key={c}
            className={`w-5 h-5 rounded-full transition-colors duration-[80ms] ${myColor === c ? 'ring-2 ring-x-focus' : 'hover:ring-2 hover:ring-x-line-strong'}`}
            style={{ background: c }}
            onClick={() => setMyColor(c)}
          />
        ))}
      </div>
    </div>
  )
}

export default function StatusBar() {
  const sessions = useStore((s) => s.sessions)
  const connected = useStore((s) => s.connected)
  const peers = useStore((s) => s.peers)
  const myName = useStore((s) => s.myName)
  const myColor = useStore((s) => s.myColor)
  const [showIdentity, setShowIdentity] = useState(false)

  const allSessions = Object.values(sessions)
  const runningCount = allSessions.filter((s) => s.status === 'running').length
  const totalTokens = allSessions.reduce((sum, s) => sum + (Number(s.token_count) || 0), 0)
  const estimatedTokens = allSessions.some((s) => s.token_count_estimated)
  const peerList = Object.entries(peers)
  const peerCount = peerList.length
  const onlineCount = peerCount + 1

  return (
    <>
      <div data-status-bar className="flex items-center h-8 px-3 bg-x-surface border-t border-x-line text-[11px] select-none">
        {/* Left section */}
        <div className="flex items-center gap-3">
          <div
            className={`flex items-center gap-1.5 px-2 py-0.5 -ml-1 rounded-md border text-[11px] font-medium transition-colors duration-[80ms] ${
              connected
                ? 'text-x-good border-x-good/25 bg-x-good/10'
                : 'text-x-accent-ink border-x-accent-ink/30 bg-x-accent-ink/10 animate-pulse'
            }`}
            title={connected ? "Connected to workspace backend" : "Disconnected - attempting to reconnect"}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-x-good' : 'bg-x-accent-ink animate-pulse'}`} />
            <span>{connected ? 'connected' : 'reconnecting...'}</span>
          </div>

          {allSessions.length > 0 && (
            <span className="hidden sm:inline text-x-muted text-[11px] tabular-nums">{allSessions.length} sessions</span>
          )}

          {runningCount > 0 && (
            <span className="flex items-center gap-1.5 text-x-good font-medium text-[11px] tabular-nums">
              <span className="w-1 h-1 rounded-full bg-x-good animate-subtle-pulse" />
              {runningCount}<span className="hidden sm:inline">&nbsp;active</span>
            </span>
          )}

          {totalTokens > 0 && (
            <span className="hidden sm:inline text-x-muted text-[11px] tabular-nums">
              {estimatedTokens ? '~' : ''}{compactNumber(totalTokens)} tok
            </span>
          )}

          <MailboxPill position="above" align="left" />
        </div>

        <div className="flex-1" />

        {/* Right section — identity + multiplayer control + keyboard hints */}
        <div className="flex items-center gap-3">
          {/* Your identity badge — click to edit */}
          <div className="flex items-center gap-1.5">
            <div className="relative">
              <Button type="submit"
                onClick={() => setShowIdentity(!showIdentity)}
                className="flex items-center gap-1.5 px-2 py-1 hover:bg-x-hover transition-colors duration-[80ms]"
              >
                <span
                  className="w-4 h-4 rounded-full text-[11px] font-medium text-x-on-accent flex items-center justify-center"
                  style={{ background: myColor || 'var(--color-x-accent)' }}
                >
                  {myName?.[0]?.toUpperCase() || '?'}
                </span>
                <span className="hidden sm:inline text-[11px] text-x-ink-secondary max-w-[80px] truncate">{myName || 'Anonymous'}</span>
              </Button>
              {showIdentity && <IdentityEditor onClose={() => setShowIdentity(false)} />}
            </div>

            <ThemeToggle />

            <Button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('open-panel', { detail: { panel: 'multiplayer-share', tab: 'online' } }))}
              className={`relative flex items-center justify-center w-6 h-6 p-0 border transition-colors duration-[80ms] ${
                peerCount > 0
                  ? 'text-x-accent border-x-accent/25 bg-x-accent/10 hover:bg-x-accent/15'
                  : 'text-x-muted border-x-line-subtle bg-transparent hover:text-x-ink hover:bg-x-hover'
              }`}
              title={peerCount > 0
                ? `Open Multiplayer Share: ${onlineCount} online (${peerList.map(([, p]) => p.name).join(', ')})`
                : 'Open Multiplayer Share: only you online'}
              aria-label={`Open Multiplayer Share, ${onlineCount} online`}
            >
              <UsersRound size={13} />
              <span className={`absolute -top-1.5 -right-1.5 min-w-[16px] h-[16px] px-0.5 rounded-full border text-[11px] leading-[14px] tabular-nums ${
                peerCount > 0
                  ? 'bg-x-accent text-x-on-accent border-x-surface'
                  : 'bg-x-surface text-x-muted border-x-surface'
              }`}>
                {onlineCount}
              </span>
            </Button>
          </div>

          {/* The six static shortcut chips that sat here read as buttons but were
              inert, and duplicated the sidebar legend. That legend is now the
              single "Shortcuts" disclosure in the sidebar footer, which carries
              all of these keys (⌘/ and ⌘? included). */}
        </div>
      </div>
    </>
  )
}
