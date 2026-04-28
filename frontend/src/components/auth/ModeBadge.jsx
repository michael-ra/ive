import { useEffect } from 'react'
import { Shield, Eye, Pencil, Crown, LogOut } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'

const MODE_PRESENT = {
  brief: { label: 'Brief',  Icon: Eye,    cls: 'text-cyan-300 bg-cyan-500/10 border-cyan-500/30' },
  code:  { label: 'Code',   Icon: Pencil, cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  full:  { label: 'Full',   Icon: Crown,  cls: 'text-purple-300 bg-purple-500/10 border-purple-500/30' },
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
        className={`inline-flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 rounded border ${meta.cls}`}
      >
        <Icon size={9} />
        {meta.label}
      </span>
    )
  }

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-bg-secondary border border-border-secondary">
      <Shield size={10} className="text-text-faint shrink-0" />
      <span
        className={`inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border ${meta.cls}`}
      >
        <Icon size={10} />
        {meta.label}
      </span>
      {ctx.brief_subscope && (
        <span className="text-[9px] text-text-faint font-mono">{ctx.brief_subscope}</span>
      )}
      <span className="text-[10px] text-text-secondary truncate flex-1">
        {isOwner
          ? <span className="text-text-faint">Owner</span>
          : (ctx.label || <span className="text-text-faint italic">guest</span>)}
      </span>
      {!isOwner && (
        <button
          onClick={handleLogout}
          title="Sign out (revokes this device's session)"
          className="p-0.5 rounded hover:bg-bg-hover text-text-faint hover:text-text-secondary"
        >
          <LogOut size={10} />
        </button>
      )}
    </div>
  )
}
