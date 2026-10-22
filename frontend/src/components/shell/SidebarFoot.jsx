import { useEffect, useRef, useState } from 'react'
import { UsersRound } from 'lucide-react'
import useStore from '../../state/store'
import { formatCost } from '../../lib/sessionVocabulary'
import { useT } from '../../lib/i18n'
import '../../lib/i18n/shell'

const PEER_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#f97316', '#84cc16', '#ef4444', '#6366f1']

// Your name and colour for other people in a shared session (moved here from
// the old status bar; Settings › Access & sharing has the same editor).
// `inline` renders it as a static block (Settings › Access & sharing) instead
// of a popover above the sidebar foot.
export function IdentityEditor({ onClose, align = 'left', inline = false }) {
  const myName = useStore((s) => s.myName)
  const myColor = useStore((s) => s.myColor)
  const setMyName = useStore((s) => s.setMyName)
  const setMyColor = useStore((s) => s.setMyColor)
  const [name, setName] = useState(myName || '')
  const inputRef = useRef(null)
  const panelRef = useRef(null)

  useEffect(() => { if (!inline) { inputRef.current?.focus(); inputRef.current?.select() } }, [inline])
  useEffect(() => {
    if (inline) return undefined
    const h = (e) => { if (panelRef.current && !panelRef.current.contains(e.target)) onClose?.() }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [onClose, inline])

  const save = () => {
    const trimmed = name.trim()
    if (trimmed && trimmed !== myName) setMyName(trimmed)
    onClose?.()
  }

  return (
    <div ref={panelRef} data-ive-popover={inline ? undefined : ''} data-identity-editor="" className={`ive-identity-editor${inline ? ' is-inline' : ''}${align === 'right' ? ' is-right' : ''}`}>
      <div className="t-meta">Your identity</div>
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={inline ? save : undefined}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onClose?.() }}
        placeholder="Display name"
        maxLength={24}
        aria-label="Display name"
      />
      <div className="ive-identity-colors">
        {PEER_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Colour ${c}`}
            aria-pressed={myColor === c}
            style={{ background: c }}
            onClick={() => setMyColor(c)}
          />
        ))}
      </div>
    </div>
  )
}

export default function SidebarFoot() {
  const t = useT()
  const connected = useStore((s) => s.connected)
  const costToday = useStore((s) => s.costToday)
  const peers = useStore((s) => s.peers)
  const myName = useStore((s) => s.myName)
  const myColor = useStore((s) => s.myColor)
  const [showIdentity, setShowIdentity] = useState(false)
  const peerCount = Object.keys(peers || {}).length

  return (
    <footer data-sidebar-foot="" className="ive-sidebar-foot">
      <div className="ive-sidebar-foot-row">
        <span className={`ive-dot${connected ? '' : ' is-pulse'}`} data-state={connected ? 'done' : 'waiting'} aria-hidden="true" />
        <span className="ive-sidebar-foot-state">{connected ? t('foot.connected') : t('foot.reconnecting')}</span>
        {costToday !== null && costToday !== undefined && (
          <button
            type="button"
            className="ive-sidebar-foot-cost"
            data-cost-today=""
            title="Cost & tokens"
            onClick={() => window.dispatchEvent(new CustomEvent('open-panel', { detail: 'cost' }))}
          >
            {formatCost(costToday)} {t('foot.today')}
          </button>
        )}
      </div>
      {peerCount > 0 && (
        <div className="ive-sidebar-foot-row ive-sidebar-foot-peers">
          <div className="relative">
            <button type="button" className="ive-sidebar-foot-identity" onClick={() => setShowIdentity((v) => !v)} title="Your name and colour">
              <span className="ive-sidebar-foot-avatar" style={{ background: myColor || 'var(--x-accent)' }}>{myName?.[0]?.toUpperCase() || '?'}</span>
              <span className="truncate">{myName || 'Anonymous'}</span>
            </button>
            {showIdentity && <IdentityEditor onClose={() => setShowIdentity(false)} />}
          </div>
          <button
            type="button"
            className="ive-sidebar-foot-share"
            aria-label={t('foot.share')}
            title={`${t('foot.share')} · ${peerCount + 1} online`}
            onClick={() => window.dispatchEvent(new CustomEvent('open-panel', { detail: { panel: 'multiplayer-share', tab: 'online' } }))}
          >
            <UsersRound size={14} aria-hidden="true" />
            <span>{peerCount + 1}</span>
          </button>
        </div>
      )}
    </footer>
  )
}
