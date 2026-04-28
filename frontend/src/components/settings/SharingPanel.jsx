import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Share2,
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
  ScrollText,
  Globe,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { api, ApiError } from '../../lib/api'

// ─── Mode definitions ────────────────────────────────────────────────────
const MODES = [
  {
    id: 'off',
    label: 'Off',
    icon: WifiOff,
    tone: 'zinc',
    hint: 'Localhost only. No invites or joiners.',
  },
  {
    id: 'local',
    label: 'Local',
    icon: Wifi,
    tone: 'emerald',
    hint: 'LAN preview proxy on. Joiners on the same network can connect.',
  },
  {
    id: 'tunnel',
    label: 'Tunnel',
    icon: Globe,
    tone: 'indigo',
    hint: 'Cloudflare quick tunnel. Public URL — anyone with the link + token gets in.',
  },
]

const TONE_BG = {
  zinc:    'bg-zinc-800 border-zinc-700 text-zinc-200',
  emerald: 'bg-emerald-600 border-emerald-500 text-white',
  indigo:  'bg-indigo-600 border-indigo-500 text-white',
}

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
  brief: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
  code:  'text-amber-300 bg-amber-500/10 border-amber-500/30',
  full:  'text-rose-300 bg-rose-500/10 border-rose-500/30',
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
    <button
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1400) } catch {}
      }}
      className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border-secondary text-text-faint hover:text-text-secondary hover:bg-bg-hover transition-colors"
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? 'Copied' : label}
    </button>
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
      <div className="text-[10px] text-text-faint uppercase tracking-wide">Sharing mode</div>
      <div className="grid grid-cols-3 gap-1.5 p-1 bg-bg-secondary border border-border-secondary rounded-lg">
        {MODES.map((m) => {
          const Icon = m.icon
          const isActive = active === m.id
          return (
            <button
              key={m.id}
              onClick={() => !busy && active !== m.id && onChange(m.id)}
              disabled={busy}
              className={`flex flex-col items-center gap-1 px-3 py-2 rounded-md border transition-all disabled:opacity-50 ${
                isActive
                  ? TONE_BG[m.tone] + ' shadow-sm'
                  : 'bg-transparent border-transparent text-text-faint hover:text-text-primary hover:bg-bg-hover'
              }`}
            >
              <Icon size={14} />
              <span className="text-[11px] font-medium">{m.label}</span>
            </button>
          )
        })}
      </div>
      <p className="text-[10px] text-text-faint">
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
      <div className="bg-bg-secondary border border-border-secondary rounded p-2 flex items-center gap-2">
        <code className="text-[11px] text-text-primary flex-1 break-all font-mono">
          {url}
        </code>
        <button
          onClick={async () => {
            try { await navigator.clipboard.writeText(qrUrl || url); setCopied(true); setTimeout(() => setCopied(false), 1400) } catch {}
          }}
          className="text-[10px] flex items-center gap-1 px-1.5 py-1 rounded border border-border-secondary text-text-faint hover:text-text-secondary hover:bg-bg-hover"
        >
          {copied ? <Check size={10} /> : <Copy size={10} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {qrUrl && (
        <div className="bg-bg-secondary border border-border-secondary rounded p-3 flex items-center gap-3">
          <div className="bg-white p-1.5 rounded">
            <QRCodeSVG value={qrUrl} size={104} level="M" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-text-primary text-[12px] font-medium flex items-center gap-1.5">
              <QrCode size={12} /> Scan to open on phone
            </div>
            <div className="text-text-faint text-[11px] mt-1 leading-relaxed">
              {token
                ? 'QR includes auth token — scanning lands signed in. Treat like a password.'
                : 'QR opens public URL only. Visitor will need an invite or token.'}
            </div>
          </div>
        </div>
      )}
      <div className="flex items-start gap-2 text-amber-300/90 text-[11px] bg-amber-500/5 border border-amber-500/20 rounded p-2">
        <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
        <span>Anyone with URL + token has full shell access. Prefer short-TTL invites for sharing.</span>
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
    <form onSubmit={handle} className="p-3 bg-bg-secondary border border-border-secondary rounded-lg space-y-2.5">
      <div className="flex items-center gap-2">
        <Plus size={13} className="text-emerald-400" />
        <span className="text-xs text-text-primary font-medium">New invite</span>
        <div className="flex-1" />
        <button type="button" onClick={onCancel} className="p-1 rounded hover:bg-bg-hover text-text-faint">
          <X size={13} />
        </button>
      </div>
      <div>
        <label className="text-[10px] text-text-faint uppercase tracking-wide">Mode</label>
        <div className="flex gap-1.5 mt-1">
          {MODE_OPTIONS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={`flex-1 px-2.5 py-1.5 text-[11px] rounded-md border transition-colors ${
                mode === m.id
                  ? 'bg-accent-subtle border-accent-primary text-indigo-300 font-medium'
                  : 'border-border-secondary text-text-faint hover:text-text-secondary hover:bg-bg-hover'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-text-faint mt-1">{MODE_OPTIONS.find((m) => m.id === mode)?.hint}</p>
      </div>
      {mode === 'brief' && (
        <div>
          <label className="text-[10px] text-text-faint uppercase tracking-wide">Brief sub-scope</label>
          <div className="flex gap-1.5 mt-1">
            {BRIEF_SUBSCOPES.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setBriefSubscope(s.value)}
                className={`flex-1 px-2.5 py-1.5 text-[11px] rounded-md border transition-colors ${
                  briefSubscope === s.value
                    ? 'bg-accent-subtle border-accent-primary text-indigo-300 font-medium'
                    : 'border-border-secondary text-text-faint hover:text-text-secondary hover:bg-bg-hover'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div>
        <label className="text-[10px] text-text-faint uppercase tracking-wide">TTL after redeem</label>
        <div className="flex gap-1.5 mt-1 flex-wrap">
          {TTL_OPTIONS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTtlSeconds(t.value)}
              className={`px-2.5 py-1.5 text-[11px] rounded-md border transition-colors ${
                ttlSeconds === t.value
                  ? 'bg-accent-subtle border-accent-primary text-indigo-300 font-medium'
                  : 'border-border-secondary text-text-faint hover:text-text-secondary hover:bg-bg-hover'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className="text-[10px] text-text-faint uppercase tracking-wide">Label (optional)</label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Sara's iPhone"
          className="w-full mt-1 bg-bg-primary border border-border-secondary rounded-md px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-faint outline-none focus:border-accent-primary"
        />
      </div>
      {error && (
        <div className="flex items-start gap-1.5 text-[11px] text-red-300 bg-red-500/10 border border-red-500/20 rounded-md p-2">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span className="font-mono">{error}</span>
        </div>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="w-full flex items-center justify-center gap-1.5 bg-accent-primary text-white text-xs font-medium py-2 rounded-md hover:opacity-90 disabled:opacity-50"
      >
        {submitting && <Loader2 size={12} className="animate-spin" />}
        {submitting ? 'Generating…' : 'Generate invite'}
      </button>
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
    <div className="p-3 bg-emerald-500/5 border border-emerald-500/30 rounded-lg space-y-3">
      <div className="flex items-center gap-2">
        <Check size={14} className="text-emerald-400" />
        <span className="text-xs text-text-primary font-medium">Invite generated</span>
        <div className="flex-1" />
        <button onClick={onDone} className="text-[10px] text-text-faint hover:text-text-secondary">Close</button>
      </div>
      <p className="text-[10px] text-amber-300/90">
        These projections are shown <span className="font-medium">once</span>. Save what you'll send.
      </p>
      <div className="p-2.5 bg-bg-primary border border-border-secondary rounded-md text-[11px] text-text-secondary leading-relaxed">
        Have them open <span className="font-mono text-cyan-300">{host}/join</span> and paste any projection.
        {isLocalhost && (
          <p className="text-[10px] text-amber-300/90 flex items-start gap-1 mt-1.5">
            <AlertCircle size={10} className="mt-0.5 shrink-0" />
            <span>You're on <span className="font-mono">{host}</span>. Other-network phones can't reach this — switch to Tunnel.</span>
          </p>
        )}
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-text-faint uppercase tracking-wide">Speakable</span>
          <CopyButton value={invite.secret_speakable} />
        </div>
        <div className="font-mono text-sm text-emerald-300 bg-bg-primary border border-border-secondary rounded-md px-2.5 py-1.5 break-words">
          {invite.secret_speakable}
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-text-faint uppercase tracking-wide">Compact</span>
          <CopyButton value={invite.secret_compact} />
        </div>
        <div className="font-mono text-sm text-cyan-300 bg-bg-primary border border-border-secondary rounded-md px-2.5 py-1.5 tracking-wider">
          {invite.secret_compact}
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-text-faint uppercase tracking-wide flex items-center gap-1">
            <Smartphone size={10} /> Magic link (scan in person only)
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowUrl((v) => !v)}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border-secondary text-text-faint hover:text-text-secondary"
            >
              {showUrl ? <EyeOff size={10} /> : <Eye size={10} />}
              {showUrl ? 'Hide' : 'Show'}
            </button>
            <CopyButton value={joinMagic} label="Copy URL" />
          </div>
        </div>
        <div className="flex items-start gap-2.5 bg-bg-primary border border-border-secondary rounded-md p-2.5">
          <div className="bg-white p-1.5 rounded shrink-0">
            <QRCodeSVG value={joinMagic} size={96} level="M" includeMargin={false} />
          </div>
          <div className="flex-1 text-[10px] text-text-faint leading-relaxed">
            Don't paste in chat — preview bots burn the token. Send words/compact code instead.
          </div>
        </div>
        {showUrl && (
          <div className="font-mono text-[11px] text-purple-300 bg-bg-primary border border-border-secondary rounded-md px-2.5 py-1.5 break-all mt-1.5">
            {joinMagic}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Active sessions list ────────────────────────────────────────────────
function SessionsList({ sessions, currentId, onRevoke, revoking, loading }) {
  if (loading && sessions.length === 0) {
    return (
      <div className="flex items-center gap-2 text-text-faint text-[12px] py-6 justify-center">
        <Loader2 size={14} className="animate-spin" /> Loading…
      </div>
    )
  }
  if (sessions.length === 0) {
    return (
      <div className="text-text-faint text-[12px] italic text-center py-6">
        No active joiner sessions. Mint an invite or share a tunnel link to add one.
      </div>
    )
  }
  return (
    <div className="space-y-1.5">
      {sessions.map((s) => {
        const isMe = s.id === currentId
        const tone = SESSION_MODE_TONE[s.mode] || 'text-zinc-300 bg-zinc-500/10 border-zinc-500/30'
        return (
          <div key={s.id} className="p-2.5 bg-bg-secondary border border-border-secondary rounded-lg">
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-text-primary font-medium flex items-center gap-1.5">
                {s.label || <span className="text-text-faint italic">unnamed</span>}
                {isMe && (
                  <span className="text-[9px] px-1 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded uppercase">you</span>
                )}
              </span>
              <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border uppercase ${tone}`}>{s.mode}</span>
              <div className="flex-1" />
              <button
                onClick={() => onRevoke(s)}
                disabled={revoking === s.id || isMe}
                title={isMe ? 'Use Logout to revoke yourself' : 'Revoke session'}
                className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-rose-500/30 text-rose-300 hover:bg-rose-500/10 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {revoking === s.id ? <Loader2 size={10} className="animate-spin" /> : <Ban size={10} />}
                Revoke
              </button>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-text-faint font-mono flex-wrap">
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
      <div className="flex items-center gap-2 text-text-faint text-[12px] py-6 justify-center">
        <Loader2 size={14} className="animate-spin" /> Loading…
      </div>
    )
  }
  if (invites.length === 0) {
    return (
      <div className="text-text-faint text-[12px] italic text-center py-6">
        No invites yet.
      </div>
    )
  }
  return (
    <div className="space-y-1.5">
      {invites.map((inv) => {
        const status = statusOf(inv)
        const toneClass = {
          emerald: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20',
          red:     'text-red-300 bg-red-500/10 border-red-500/20',
          zinc:    'text-zinc-300 bg-zinc-700/30 border-zinc-600/30',
          amber:   'text-amber-300 bg-amber-500/10 border-amber-500/20',
        }[status.tone]
        const isActive = status.label === 'Active'
        return (
          <div key={inv.id} className="p-2.5 bg-bg-secondary border border-border-secondary rounded-lg">
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-text-primary font-medium">
                {inv.label || <span className="text-text-faint italic">unlabeled</span>}
              </span>
              <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${toneClass}`}>{status.label}</span>
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded text-purple-300 bg-purple-500/10 border border-purple-500/20 uppercase">
                {inv.mode}{inv.brief_subscope ? ` · ${inv.brief_subscope}` : ''}
              </span>
              <div className="flex-1" />
              {isActive && (
                <button
                  onClick={() => onRevoke(inv.id)}
                  disabled={revoking === inv.id}
                  className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-red-500/30 text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                >
                  {revoking === inv.id ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                  Revoke
                </button>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-text-faint font-mono flex-wrap">
              <span>TTL {inv.ttl_seconds === 0 ? 'session-only' : inv.ttl_seconds + 's'}</span>
              <span>·</span>
              <span>Expires {inv.expires_at}</span>
              {inv.redemption_attempts > 0 && (
                <>
                  <span>·</span>
                  <span className="text-amber-300">{inv.redemption_attempts} bad attempt{inv.redemption_attempts === 1 ? '' : 's'}</span>
                </>
              )}
            </div>
            <div className="mt-1 flex items-center gap-3 text-[10px] text-text-faint">
              <span className="font-mono text-emerald-300/80">{inv.encoded_speakable}</span>
              <span className="font-mono text-cyan-300/80 tracking-wider">{inv.encoded_compact}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Main panel ──────────────────────────────────────────────────────────
export default function SharingPanel({ onClose }) {
  const [status, setStatus] = useState(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const [tab, setTab] = useState('invites') // 'invites' | 'sessions'

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
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[6vh] bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[680px] ide-panel overflow-hidden scale-in max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary bg-bg-primary">
          <Share2 size={14} className="text-cyan-400" />
          <span className="text-xs text-text-primary font-medium">Sharing</span>
          <span className="text-[10px] text-text-faint">
            Mode · invites · active sessions
          </span>
          <div className="flex-1" />
          <button
            onClick={() => { reloadStatus(); reloadInvites(); reloadSessions() }}
            className="p-1 rounded hover:bg-bg-hover text-text-faint hover:text-text-secondary"
            title="Refresh"
            disabled={statusLoading || invitesLoading || sessionsLoading}
          >
            <RefreshCw size={13} className={(statusLoading || invitesLoading || sessionsLoading) ? 'animate-spin' : ''} />
          </button>
          <button onClick={onClose} className="p-1 rounded hover:bg-bg-hover text-text-faint hover:text-text-secondary">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {error && (
            <div className="flex items-start gap-1.5 text-[11px] text-red-300 bg-red-500/10 border border-red-500/20 rounded-md p-2">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span className="font-mono">{error}</span>
            </div>
          )}

          {/* Mode selector */}
          <ModeSelector status={status} busy={busy || statusLoading} onChange={handleModeChange} />
          {busy && (
            <div className="text-[11px] text-text-faint flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" /> Switching mode…
            </div>
          )}

          {/* Tunnel URL + QR (visible only when tunnel is running) */}
          <TunnelCard status={status} />

          {/* Tabs */}
          <div className="border-t border-border-primary pt-3">
            <div className="flex items-center gap-1 mb-3">
              <button
                onClick={() => setTab('invites')}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded-md transition-colors ${
                  tab === 'invites'
                    ? 'bg-bg-secondary text-text-primary border border-border-primary'
                    : 'text-text-faint hover:text-text-primary hover:bg-bg-hover'
                }`}
              >
                <Ticket size={12} /> Invites
                <span className="text-[10px] text-text-faint">({invites.length})</span>
              </button>
              <button
                onClick={() => setTab('sessions')}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded-md transition-colors ${
                  tab === 'sessions'
                    ? 'bg-bg-secondary text-text-primary border border-border-primary'
                    : 'text-text-faint hover:text-text-primary hover:bg-bg-hover'
                }`}
              >
                <ShieldCheck size={12} /> Sessions
                <span className="text-[10px] text-text-faint">({sessions.length})</span>
              </button>
            </div>

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
                    <button
                      onClick={() => setCreating(true)}
                      className="w-full flex items-center justify-center gap-1.5 bg-bg-secondary border border-dashed border-border-secondary rounded-lg py-2 text-xs text-text-secondary hover:bg-bg-hover hover:border-border-primary transition-colors"
                    >
                      <Plus size={13} /> New invite
                    </button>
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
    </div>
  )
}
