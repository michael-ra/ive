import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  X,
  Loader2,
  AlertCircle,
  Copy,
  Check,
  AlertTriangle,
  QrCode,
  Ticket,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Smartphone,
  ShieldCheck,
  Ban,
  RefreshCw,
  Globe,
  Wifi,
  WifiOff,
  UsersRound,
  Monitor,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { api, ApiError } from '../../lib/api'
import useStore from '../../state/store'
import { Button, IconButton } from '../ui'
import { IdentityEditor } from '../shell/SidebarFoot'

// ─── Mode definitions ────────────────────────────────────────────────────
const MODES = [
  {
    id: 'off',
    label: 'Off',
    icon: WifiOff,
    hint: 'Localhost only. No invites or joiners.',
  },
  {
    id: 'local',
    label: 'Local',
    icon: Wifi,
    hint: 'LAN preview proxy on. Joiners on the same network can connect.',
  },
  {
    id: 'tunnel',
    label: 'Tunnel',
    icon: Globe,
    hint: 'Cloudflare quick tunnel. Public URL — anyone with the link + token gets in.',
  },
]

// ─── Invite/auth-session helpers (lifted from existing panels) ───────────
const MODE_OPTIONS = [
  { id: 'brief', label: 'Brief', hint: 'Create tasks, comment, advise. No execution.' },
  { id: 'code',  label: 'Code',  hint: 'Drive sessions in auto/plan. No Bash unless allowlisted.' },
  { id: 'full',  label: 'Full',  hint: 'Owner-equivalent. TTL-bounded.' },
]
const TTL_OPTIONS = [
  { value: 0,        label: 'Session-only' },
  { value: 3600,     label: '1 hour' },
  { value: 28800,    label: '8 hours' },
  { value: 2592000,  label: '30 days' },
]
const BRIEF_SUBSCOPES = [
  { value: 'read_only',      label: 'Read-only' },
  { value: 'create_comment', label: 'Comment + create' },
]
const SESSION_MODE_TONE = {
  brief: 'text-x-ink-secondary bg-x-surface-2 border-x-line',
  code:  'text-x-ink-secondary bg-x-surface-2 border-x-line',
  full:  'text-x-ink-secondary bg-x-surface-2 border-x-line',
}

function fmtTs(iso) {
  if (!iso) return '—'
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z')
  if (isNaN(d.getTime())) return iso
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

function fmtUA(ua) {
  if (!ua) return 'unknown'
  if (/iPhone|iPad/i.test(ua)) return 'iOS'
  if (/Android/i.test(ua)) return 'Android'
  if (/Macintosh/i.test(ua)) return 'macOS'
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Linux/i.test(ua)) return 'Linux'
  return ua.slice(0, 24)
}

function statusOf(invite) {
  if (invite.burned_at)   return { tone: 'red',     label: 'Revoked' }
  if (invite.redeemed_at) return { tone: 'zinc',    label: 'Redeemed' }
  if (invite.expires_at && new Date(invite.expires_at + 'Z') < new Date())
    return { tone: 'amber', label: 'Expired' }
  return { tone: 'emerald', label: 'Active' }
}

function CopyButton({ value, label = 'Copy' }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1400) } catch {}
      }}
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? 'Copied' : label}
    </Button>
  )
}

// ─── Mode selector (the 3-way switch) ────────────────────────────────────
function ModeSelector({ status, busy, onChange }) {
  // Derive active mode from status flags so we never get out of sync.
  const active = useMemo(() => {
    if (status?.tunnel?.running) return 'tunnel'
    if (status?.multiplayer?.enabled) return 'local'
    return 'off'
  }, [status])

  return (
    <div className="space-y-2">
      <div className="text-[11px] text-x-faint uppercase tracking-wide">Multiplayer mode</div>
      <div className="grid grid-cols-3 gap-1.5 p-1 bg-x-surface border border-x-line rounded-lg">
        {MODES.map((m) => {
          const Icon = m.icon
          const isActive = active === m.id
          return (
            <Button
              key={m.id}
              icon={Icon}
              selected={isActive}
              onClick={() => !busy && active !== m.id && onChange(m.id)}
              disabled={busy}
              className="w-full flex-col py-2"
            >
              {m.label}
            </Button>
          )
        })}
      </div>
      <p className="text-[11px] text-x-faint">
        {MODES.find((m) => m.id === active)?.hint}
      </p>
    </div>
  )
}

// ─── Tunnel URL + QR card ────────────────────────────────────────────────
function TunnelCard({ status }) {
  const [copied, setCopied] = useState(false)
  const url = status?.tunnel?.url
  const token = status?.tunnel?.token
  const qrUrl = useMemo(() => {
    if (!url) return null
    return token ? `${url}?token=${encodeURIComponent(token)}` : url
  }, [url, token])

  if (!status?.tunnel?.running || !url) return null

  return (
    <div className="space-y-2">
      <div className="bg-x-surface border border-x-line rounded-md p-2 flex items-center gap-2">
        <code className="text-[11px] text-x-ink flex-1 break-all font-mono">
          {url}
        </code>
        <Button
          size="sm"
          onClick={async () => {
            try { await navigator.clipboard.writeText(qrUrl || url); setCopied(true); setTimeout(() => setCopied(false), 1400) } catch {}
          }}
        >
          {copied ? <Check size={10} /> : <Copy size={10} />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {qrUrl && (
        <div className="bg-x-surface border border-x-line rounded-lg p-3 flex items-center gap-3">
          <div className="bg-white p-1.5 rounded-md">
            <QRCodeSVG value={qrUrl} size={104} level="M" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-x-ink text-[12px] font-medium flex items-center gap-1.5">
              <QrCode size={12} /> Scan to open on phone
            </div>
            <div className="text-x-muted text-[11px] mt-1 leading-relaxed">
              {token
                ? 'QR includes auth token — scanning lands signed in. Treat like a password.'
                : 'QR opens public URL only. Visitor will need an invite or token.'}
            </div>
          </div>
        </div>
      )}
      <div className="flex items-start gap-2 text-x-accent-ink text-[11px] bg-x-accent-ink/10 border border-x-accent-ink/30 rounded-md p-2">
        <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
        <span>Anyone with URL + token has full shell access. Prefer short-TTL invites for collaborators. For your own phone use Settings → iPhone &amp; Devices (one-time code, revocable).</span>
      </div>
    </div>
  )
}

// ─── Invite create form ──────────────────────────────────────────────────
function CreateInviteForm({ onCreated, onCancel }) {
  const [mode, setMode] = useState('code')
  const [briefSubscope, setBriefSubscope] = useState('create_comment')
  const [ttlSeconds, setTtlSeconds] = useState(28800)
  const [label, setLabel] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const handle = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const body = { mode, ttl_seconds: ttlSeconds, label: label.trim() || null }
      if (mode === 'brief') body.brief_subscope = briefSubscope
      onCreated(await api.createInvite(body))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handle} className="p-3 bg-x-surface border border-x-line rounded-lg space-y-2.5">
      <div className="flex items-center gap-2">
        <Plus size={13} className="text-x-accent" />
        <span className="text-xs text-x-ink font-medium">New invite</span>
        <div className="flex-1" />
        <IconButton icon={X} label="Cancel invite" size="sm" onClick={onCancel} />
      </div>
      <div>
        <label className="text-xs font-medium text-x-ink-secondary">Mode</label>
        <div className="flex gap-1.5 mt-1.5">
          {MODE_OPTIONS.map((m) => (
            <Button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              selected={mode === m.id}
              size="sm"
              className="flex-1"
            >
              {m.label}
            </Button>
          ))}
        </div>
        <p className="text-[11px] text-x-faint mt-1">{MODE_OPTIONS.find((m) => m.id === mode)?.hint}</p>
      </div>
      {mode === 'brief' && (
        <div>
          <label className="text-xs font-medium text-x-ink-secondary">Brief sub-scope</label>
          <div className="flex gap-1.5 mt-1.5">
            {BRIEF_SUBSCOPES.map((s) => (
              <Button
                key={s.value}
                type="button"
                onClick={() => setBriefSubscope(s.value)}
                selected={briefSubscope === s.value}
                size="sm"
                className="flex-1"
              >
                {s.label}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div>
        <label className="text-xs font-medium text-x-ink-secondary">TTL after redeem</label>
        <div className="flex gap-1.5 mt-1.5 flex-wrap">
          {TTL_OPTIONS.map((t) => (
            <Button
              key={t.value}
              type="button"
              onClick={() => setTtlSeconds(t.value)}
              selected={ttlSeconds === t.value}
              size="sm"
            >
              {t.label}
            </Button>
          ))}
        </div>
      </div>
      <div>
        <label className="text-xs font-medium text-x-ink-secondary">Label (optional)</label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Sara's iPhone"
          className="w-full mt-1.5 h-8 bg-x-surface-2 border border-x-line rounded-md px-2.5 text-[13px] text-x-ink placeholder:text-x-muted outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
        />
      </div>
      {error && (
        <div className="flex items-start gap-1.5 text-[11px] text-x-accent-ink bg-x-accent-ink/10 border border-x-accent-ink/30 rounded-md p-2">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span className="font-mono">{error}</span>
        </div>
      )}
      <Button
        type="submit"
        disabled={submitting}
        variant="primary"
        className="w-full"
      >
        {submitting && <Loader2 size={12} className="animate-spin" />}
        {submitting ? 'Generating…' : 'Generate invite'}
      </Button>
    </form>
  )
}

// ─── Just-created invite display ─────────────────────────────────────────
function NewInviteResult({ invite, onDone, tunnelOrigin }) {
  const [showUrl, setShowUrl] = useState(false)
  const localOrigin = typeof window !== 'undefined' ? window.location.origin : ''
  const origin = tunnelOrigin || localOrigin
  let host = ''
  try { host = origin ? new URL(origin).host : '' } catch { host = '' }
  const joinPlain = `${origin}/join`
  const joinMagic = `${origin}/join?t=${encodeURIComponent(invite.secret_qr)}`
  const isLocalhost = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(host)

  return (
    <div className="p-3 bg-x-good/5 border border-x-good/30 rounded-lg space-y-3">
      <div className="flex items-center gap-2">
        <Check size={14} className="text-x-good" />
        <span className="text-xs text-x-ink font-medium">Invite generated</span>
        <div className="flex-1" />
        <Button onClick={onDone} size="sm">Close</Button>
      </div>
      <p className="text-[11px] text-x-accent-ink">
        Shown <span className="font-medium">once</span> — save this invite.
      </p>
      <div className="p-2.5 bg-x-surface-2 border border-x-line rounded-md text-[11px] text-x-ink-secondary leading-relaxed">
        Open <span className="font-mono text-x-accent">{host}/join</span> and enter the code.
        {isLocalhost && (
          <p className="text-[11px] text-x-accent-ink flex items-start gap-1 mt-1.5">
            <AlertCircle size={10} className="mt-0.5 shrink-0" />
            <span>You're on <span className="font-mono">{host}</span>. Other-network phones can't reach this — switch to Tunnel.</span>
          </p>
        )}
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-x-faint uppercase tracking-wide">Speakable</span>
          <CopyButton value={invite.secret_speakable} />
        </div>
        <div className="font-mono text-sm text-x-accent bg-x-surface-2 border border-x-line rounded-md px-2.5 py-1.5 break-words">
          {invite.secret_speakable}
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-x-faint uppercase tracking-wide">Compact</span>
          <CopyButton value={invite.secret_compact} />
        </div>
        <div className="font-mono text-sm text-x-accent bg-x-surface-2 border border-x-line rounded-md px-2.5 py-1.5 tracking-wider">
          {invite.secret_compact}
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-x-faint uppercase tracking-wide flex items-center gap-1">
            <Smartphone size={10} /> Magic link (scan in person only)
          </span>
          <div className="flex items-center gap-1">
            <Button
              onClick={() => setShowUrl((v) => !v)}
              size="sm"
            >
              {showUrl ? <EyeOff size={10} /> : <Eye size={10} />}
              {showUrl ? 'Hide' : 'Show'}
            </Button>
            <CopyButton value={joinMagic} label="Copy URL" />
          </div>
        </div>
        <div className="flex items-start gap-2.5 bg-x-surface-2 border border-x-line rounded-md p-2.5">
          <div className="bg-white p-1.5 rounded-md shrink-0">
            <QRCodeSVG value={joinMagic} size={96} level="M" includeMargin={false} />
          </div>
          <div className="flex-1 text-[11px] text-x-faint leading-relaxed">
            Send the code, not this link. Chat previews can use up the link.
          </div>
        </div>
        {showUrl && (
          <div className="font-mono text-[11px] text-x-accent-ink bg-x-surface-2 border border-x-line rounded-md px-2.5 py-1.5 break-all mt-1.5">
            {joinMagic}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Live multiplayer clients ───────────────────────────────────────────
function OnlineList({ peers, sessionsById, currentClientId, onRevoke, revoking, loading }) {
  if (loading && peers.length === 0) {
    return (
      <div className="flex items-center gap-2 text-x-muted text-[12px] py-6 justify-center">
        <Loader2 size={14} className="animate-spin" /> Loading…
      </div>
    )
  }
  if (peers.length === 0) {
    return (
      <div className="text-x-muted text-[12px] italic text-center py-6">
        No live multiplayer clients.
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      {peers.map((p) => {
        const isMe = p.client_id === currentClientId
        const mode = p.is_owner ? 'owner' : (p.mode || p.actor_kind || 'unknown')
        const tone = p.is_owner
          ? 'text-x-ink-secondary bg-x-surface-2 border-x-line'
          : SESSION_MODE_TONE[p.mode] || 'text-x-ink-secondary bg-x-hover border-x-line'
        const viewing = p.viewing_session ? sessionsById[p.viewing_session] : null
        const canRevoke = p.actor_id && !isMe
        return (
          <div key={p.client_id} className="p-2.5 bg-x-surface border border-x-line rounded-lg">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="w-5 h-5 rounded-full text-[11px] font-semibold text-x-on-accent flex items-center justify-center shrink-0"
                style={{ background: p.color || 'var(--color-x-accent)' }}
              >
                {p.name?.[0]?.toUpperCase() || '?'}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[12px] text-x-ink font-medium truncate">{p.name || 'Anonymous'}</span>
                  {isMe && (
                    <span className="text-[11px] px-1 py-0.5 bg-x-surface-2 text-x-ink-secondary border border-x-line rounded-md uppercase">you</span>
                  )}
                  <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded-md border uppercase ${tone}`}>{mode}</span>
                </div>
                {p.label && p.label !== p.name && (
                  <div className="text-[11px] text-x-faint truncate">{p.label}</div>
                )}
              </div>
              <div className="flex-1" />
              {canRevoke && (
                <Button
                  onClick={() => onRevoke({ id: p.actor_id, label: p.label || p.name || p.actor_id })}
                  disabled={revoking === p.actor_id}
                  variant="destructive"
                  size="sm"
                >
                  {revoking === p.actor_id ? <Loader2 size={10} className="animate-spin" /> : <Ban size={10} />}
                  Revoke
                </Button>
              )}
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-[11px] text-x-faint font-mono flex-wrap">
              <span>{p.remote_ip || 'IP —'}</span>
              <span>·</span>
              <span>{fmtUA(p.user_agent)}</span>
              <span>·</span>
              <span>connected {fmtTs(p.connected_at)}</span>
              {p.expires_at && (
                <>
                  <span>·</span>
                  <span>expires {fmtTs(p.expires_at)}</span>
                </>
              )}
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-x-faint">
              <Monitor size={11} className="shrink-0" />
              <span className="truncate">
                {p.viewing_session
                  ? `Viewing ${viewing?.name || p.viewing_session.slice(0, 8)}`
                  : 'No active session focus'}
              </span>
              <span className="font-mono text-x-faint/70 ml-auto">{p.client_id?.slice(0, 8)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Active sessions list ────────────────────────────────────────────────
function SessionsList({ sessions, currentId, onRevoke, revoking, loading }) {
  if (loading && sessions.length === 0) {
    return (
      <div className="flex items-center gap-2 text-x-muted text-[12px] py-6 justify-center">
        <Loader2 size={14} className="animate-spin" /> Loading…
      </div>
    )
  }
  if (sessions.length === 0) {
    return (
      <div className="text-x-muted text-[12px] italic text-center py-6">
        No active joiner sessions. Mint an invite or send a tunnel link to add one.
      </div>
    )
  }
  return (
    <div className="space-y-1.5">
      {sessions.map((s) => {
        const isMe = s.id === currentId
        const tone = SESSION_MODE_TONE[s.mode] || 'text-x-ink-secondary bg-x-hover border-x-line'
        return (
          <div key={s.id} className="p-2.5 bg-x-surface border border-x-line rounded-lg">
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-x-ink font-medium flex items-center gap-1.5">
                {s.label || <span className="text-x-faint italic">unnamed</span>}
                {isMe && (
                  <span className="text-[11px] px-1 py-0.5 bg-x-surface-2 text-x-ink-secondary border border-x-line rounded-md uppercase">you</span>
                )}
              </span>
              <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded-md border uppercase ${tone}`}>{s.mode}</span>
              <div className="flex-1" />
              <Button
                onClick={() => onRevoke(s)}
                disabled={revoking === s.id || isMe}
                title={isMe ? 'Use Logout to revoke yourself' : 'Revoke session'}
                variant="destructive"
                size="sm"
              >
                {revoking === s.id ? <Loader2 size={10} className="animate-spin" /> : <Ban size={10} />}
                Revoke
              </Button>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-x-faint font-mono flex-wrap">
              <span>{s.last_ip || '—'}</span>
              <span>·</span>
              <span>{fmtUA(s.last_user_agent)}</span>
              <span>·</span>
              <span>last {fmtTs(s.last_used_at || s.created_at)}</span>
              <span>·</span>
              <span>expires {fmtTs(s.expires_at)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Invites list ────────────────────────────────────────────────────────
function InvitesList({ invites, onRevoke, revoking, loading }) {
  if (loading && invites.length === 0) {
    return (
      <div className="flex items-center gap-2 text-x-muted text-[12px] py-6 justify-center">
        <Loader2 size={14} className="animate-spin" /> Loading…
      </div>
    )
  }
  if (invites.length === 0) {
    return (
      <div className="text-x-muted text-[12px] italic text-center py-6">
        No invites yet.
      </div>
    )
  }
  return (
    <div className="space-y-1.5">
      {invites.map((inv) => {
        const status = statusOf(inv)
        const toneClass = {
          emerald: 'text-x-ink-secondary bg-x-surface-2 border-x-line',
          red:     'text-x-accent-ink bg-x-accent-ink/10 border-x-accent-ink/30',
          zinc:    'text-x-muted bg-x-hover border-x-line',
          amber:   'text-x-accent-ink bg-x-accent-ink/10 border-x-accent-ink/30',
        }[status.tone]
        const isActive = status.label === 'Active'
        return (
          <div key={inv.id} className="p-2.5 bg-x-surface border border-x-line rounded-lg">
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-x-ink font-medium">
                {inv.label || <span className="text-x-faint italic">unlabeled</span>}
              </span>
              <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-md border ${toneClass}`}>
                {isActive && <span className="h-1.5 w-1.5 rounded-full bg-x-accent" />}
                {status.label}
              </span>
              <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-md text-x-ink-secondary bg-x-surface-2 border border-x-line uppercase">
                {inv.mode}{inv.brief_subscope ? ` · ${inv.brief_subscope}` : ''}
              </span>
              <div className="flex-1" />
              {isActive && (
                <Button
                  onClick={() => onRevoke(inv.id)}
                  disabled={revoking === inv.id}
                  variant="destructive"
                  size="sm"
                >
                  {revoking === inv.id ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                  Revoke
                </Button>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-x-faint font-mono flex-wrap">
              <span>TTL {inv.ttl_seconds === 0 ? 'session-only' : inv.ttl_seconds + 's'}</span>
              <span>·</span>
              <span>Expires {inv.expires_at}</span>
              {inv.redemption_attempts > 0 && (
                <>
                  <span>·</span>
                  <span className="text-x-accent-ink">{inv.redemption_attempts} bad attempt{inv.redemption_attempts === 1 ? '' : 's'}</span>
                </>
              )}
            </div>
            <div className="mt-1 flex items-center gap-3 text-[11px] text-x-faint">
              <span className="font-mono text-x-accent/80">{inv.encoded_speakable}</span>
              <span className="font-mono text-x-accent/80 tracking-wider">{inv.encoded_compact}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Main panel ──────────────────────────────────────────────────────────
export default function SharingPanel({ initialTab = 'online' }) {
  const sessionsById = useStore((s) => s.sessions)
  const currentClientId = useStore((s) => s.myClientId)
  const [status, setStatus] = useState(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const [tab, setTab] = useState(initialTab) // 'online' | 'invites' | 'sessions'

  // Invite state
  const [invites, setInvites] = useState([])
  const [invitesLoading, setInvitesLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [justCreated, setJustCreated] = useState(null)
  const [revokingInvite, setRevokingInvite] = useState(null)

  // Auth-session state
  const [sessions, setSessions] = useState([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [currentId, setCurrentId] = useState(null)
  const [revokingSession, setRevokingSession] = useState(null)

  const tunnelOrigin = useMemo(() => {
    const url = status?.tunnel?.running ? status?.tunnel?.url : null
    if (!url) return null
    try { return new URL(url).origin } catch { return null }
  }, [status])

  const reloadStatus = useCallback(async () => {
    try {
      const s = await api.getRuntimeStatus()
      setStatus(s)
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setStatusLoading(false)
    }
  }, [])

  const reloadInvites = useCallback(async () => {
    try {
      const r = await api.listInvites()
      setInvites(Array.isArray(r?.invites) ? r.invites : [])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setInvitesLoading(false)
    }
  }, [])

  const reloadSessions = useCallback(async () => {
    try {
      const data = await api.listAuthSessions()
      setSessions(data?.sessions || [])
      setCurrentId(data?.current_id || null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSessionsLoading(false)
    }
  }, [])

  useEffect(() => {
    reloadStatus()
    reloadInvites()
    reloadSessions()
  }, [reloadStatus, reloadInvites, reloadSessions])

  useEffect(() => {
    setTab(initialTab || 'online')
  }, [initialTab])

  useEffect(() => {
    const id = setInterval(reloadStatus, 5000)
    return () => clearInterval(id)
  }, [reloadStatus])

  const onlinePeers = useMemo(
    () => Array.isArray(status?.online?.peers) ? status.online.peers : [],
    [status],
  )

  // ── Mode change handler ────────────────────────────────────────────────
  const handleModeChange = async (mode) => {
    if (mode === 'tunnel') {
      if (!confirm('Start the public Cloudflare tunnel?\n\nAnyone with the URL + auth token can drive sessions, run shell, and read your filesystem. Mint short-TTL invites for collaborators.')) {
        return
      }
    }
    setBusy(true)
    setError(null)
    try {
      const r = await api.setMode(mode)
      if (r?.ok === false) throw new Error(r.error || `failed to switch mode to ${mode}`)
      // Apply optimistically from response so the UI flips immediately.
      setStatus((prev) => ({
        ...(prev || {}),
        multiplayer: r.multiplayer || { enabled: mode !== 'off' },
        tunnel: r.tunnel || { running: mode === 'tunnel', url: null, token: null },
      }))
      // Then re-pull canonical status (handles cloudflared race).
      await reloadStatus()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
      await reloadStatus()
    } finally {
      setBusy(false)
    }
  }

  // ── Invite handlers ────────────────────────────────────────────────────
  const handleCreated = async (created) => {
    setJustCreated(created)
    setCreating(false)
    await reloadInvites()
  }
  const handleRevokeInvite = async (id) => {
    setRevokingInvite(id)
    try { await api.revokeInvite(id); await reloadInvites() }
    catch (err) { setError(err instanceof ApiError ? err.message : String(err)) }
    finally { setRevokingInvite(null) }
  }

  // ── Session handlers ───────────────────────────────────────────────────
  const handleRevokeSession = async (s) => {
    if (!confirm(`Revoke "${s.label || s.id.slice(0, 8)}"? They'll be logged out immediately.`)) return
    setRevokingSession(s.id)
    try { await api.revokeAuthSession(s.id); await reloadSessions() }
    catch (e) { alert(e instanceof ApiError ? e.message : String(e)) }
    finally { setRevokingSession(null) }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 border-b border-x-line px-4 py-2">
          <div className="flex-1" />
          <IconButton
            icon={RefreshCw}
            label="Refresh sharing status"
            onClick={() => { reloadStatus(); reloadInvites(); reloadSessions() }}
            disabled={statusLoading || invitesLoading || sessionsLoading}
            className={(statusLoading || invitesLoading || sessionsLoading) ? 'animate-spin' : ''}
          />
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {error && (
            <div className="flex items-start gap-1.5 text-[11px] text-x-accent-ink bg-x-accent-ink/10 border border-x-accent-ink/30 rounded-md p-2">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span className="font-mono">{error}</span>
            </div>
          )}

          {/* Mode selector */}
          <ModeSelector status={status} busy={busy || statusLoading} onChange={handleModeChange} />
          {busy && (
            <div className="text-[11px] text-x-faint flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" /> Switching mode…
            </div>
          )}

          {/* Tunnel URL + QR (visible only when tunnel is running) */}
          <TunnelCard status={status} />

          {/* Tabs */}
          <div className="border-t border-x-line pt-3">
            <div className="flex items-center gap-1 mb-3">
              <Button
                icon={UsersRound}
                onClick={() => setTab('online')}
                selected={tab === 'online'}
                size="sm"
              >
                Online
                <span className="text-[11px] text-x-faint">({onlinePeers.length})</span>
              </Button>
              <Button
                icon={Ticket}
                onClick={() => setTab('invites')}
                selected={tab === 'invites'}
                size="sm"
              >
                Invites
                <span className="text-[11px] text-x-faint">({invites.length})</span>
              </Button>
              <Button
                icon={ShieldCheck}
                onClick={() => setTab('sessions')}
                selected={tab === 'sessions'}
                size="sm"
              >
                Sessions
                <span className="text-[11px] text-x-faint">({sessions.length})</span>
              </Button>
            </div>

            {tab === 'online' && (
              <>
                {/* Your name and colour as others see them (moved from the status bar). */}
                <IdentityEditor inline />
                <OnlineList
                  peers={onlinePeers}
                  sessionsById={sessionsById}
                  currentClientId={currentClientId}
                  onRevoke={handleRevokeSession}
                  revoking={revokingSession}
                  loading={statusLoading}
                />
              </>
            )}

            {tab === 'invites' && (
              <div className="space-y-2.5">
                {justCreated && (
                  <NewInviteResult
                    invite={justCreated}
                    onDone={() => setJustCreated(null)}
                    tunnelOrigin={tunnelOrigin}
                  />
                )}
                {creating ? (
                  <CreateInviteForm onCreated={handleCreated} onCancel={() => setCreating(false)} />
                ) : (
                  !justCreated && (
                    <Button
                      icon={Plus}
                      onClick={() => setCreating(true)}
                      className="w-full"
                    >
                      New invite
                    </Button>
                  )
                )}
                <InvitesList
                  invites={invites}
                  onRevoke={handleRevokeInvite}
                  revoking={revokingInvite}
                  loading={invitesLoading}
                />
              </div>
            )}

            {tab === 'sessions' && (
              <SessionsList
                sessions={sessions}
                currentId={currentId}
                onRevoke={handleRevokeSession}
                revoking={revokingSession}
                loading={sessionsLoading}
              />
            )}
          </div>
        </div>
    </div>
  )
}
