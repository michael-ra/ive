import { useEffect } from 'react'
import { Shield, Eye, Pencil, Crown, LogOut } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'

const MODE_PRESENT = {
  brief: { label: 'Brief',  Icon: Eye,    cls: 'text-x-ink-secondary bg-x-hover border-x-line' },
  code:  { label: 'Code',   Icon: Pencil, cls: 'text-x-good bg-x-good/10 border-x-good/30' },
  full:  { label: 'Full',   Icon: Crown,  cls: 'text-x-accent bg-x-tint border-x-accent/30' },
}

export default function ModeBadge({ compact = false }) {
  const ctx = useStore((s) => s.currentAuth)
  const loadWhoami = useStore((s) => s.loadWhoami)

  useEffect(() => {
    if (!ctx) loadWhoami()
  }, [ctx, loadWhoami])

  if (!ctx) return null
  const isOwner =
    ctx.actor_kind === 'owner_legacy' ||
    ctx.actor_kind === 'owner_device' ||
    ctx.actor_kind === 'localhost' ||
    ctx.actor_kind === 'hook'

  const mode = ctx.mode || 'full'
  const meta = MODE_PRESENT[mode] || MODE_PRESENT.full
  const { Icon } = meta

  const handleLogout = async () => {
    try { await api.logout() } catch {}
    window.location.reload()
  }

  if (compact) {
    return (
      <span
        title={`Mode: ${meta.label}${ctx.brief_subscope ? ' · ' + ctx.brief_subscope : ''} · ${ctx.actor_kind}`}
        className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border ${meta.cls}`}
      >
        <Icon size={9} />
        {meta.label}
      </span>
    )
  }

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-x-surface border border-x-line-subtle">
      <Shield size={10} className="text-x-muted shrink-0" />
      <span
        className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border ${meta.cls}`}
      >
        <Icon size={10} />
        {meta.label}
      </span>
      {ctx.brief_subscope && (
        <span className="text-[11px] text-x-muted font-mono">{ctx.brief_subscope}</span>
      )}
      <span className="text-[11px] text-x-ink-secondary truncate flex-1">
        {isOwner
          ? <span className="text-x-faint">Owner</span>
          : (ctx.label || <span className="text-x-faint italic">guest</span>)}
      </span>
      {!isOwner && (
        <button
          onClick={handleLogout}
          title="Sign out (revokes this device's session)"
          className="p-0.5 rounded hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms]"
        >
          <LogOut size={10} />
        </button>
      )}
    </div>
  )
}
