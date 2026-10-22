import HelpDetails from '../ui/HelpDetails'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Bell, BellRing, Check, FileKey, Globe, KeyRound, Lock, QrCode, Send, Smartphone, Trash2, Wifi, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { api, ApiError } from '../../lib/api'
import { isTauri } from '../../lib/platform'
import { isPushSupported, getPushSubscription, subscribeForPush } from '../../lib/pushClient'
import { Button, Input, Modal } from '../ui'
import PhoneSetupCard from './PhoneSetupCard'

const IDLE_OPTIONS = [5, 15, 30, 60]

function ago(ts) {
  if (!ts) return 'never'
  const d = new Date(ts.includes('T') || ts.endsWith('Z') ? ts : ts.replace(' ', 'T') + 'Z')
  if (Number.isNaN(d.getTime())) return ts
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

function errText(err) {
  return err instanceof ApiError ? err.message : String(err?.message || err)
}

function Section({ title, icon: Icon, children, ...rest }) {
  return (
    <section className="space-y-3 rounded-lg border border-x-line bg-x-surface p-4" {...rest}>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-x-ink">
        {Icon && <Icon size={14} className="text-x-accent" />}
        {title}
      </h3>
      {children}
    </section>
  )
}

function ConfirmPhoneAction({ title, children, confirmLabel, busy, error, onCancel, onConfirm }) {
  const cancelRef = useRef(null)
  useEffect(() => { cancelRef.current?.focus() }, [])
  return (
    <Modal size="sm" title={title} icon={Trash2} onClose={busy ? undefined : onCancel}
      className="!h-auto" bodyClassName="p-5 gap-3"
      footer={<div className="flex justify-end gap-2">
        <Button ref={cancelRef} onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant="destructive" onClick={onConfirm} disabled={busy} loading={busy}>{confirmLabel}</Button>
      </div>}>
      <p className="text-sm leading-relaxed text-x-ink-secondary break-words">{children}</p>
      {error && <p role="alert" className="text-sm text-x-danger break-words">{error}</p>}
    </Modal>
  )
}

function Countdown({ expiresAt, onExpire }) {
  const [left, setLeft] = useState(() => Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000)))
  useEffect(() => {
    const t = setInterval(() => {
      const next = Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000))
      setLeft(next)
      if (next <= 0) { clearInterval(t); onExpire?.() }
    }, 1000)
    return () => clearInterval(t)
  }, [expiresAt, onExpire])
  const m = Math.floor(left / 60)
  const s = String(left % 60).padStart(2, '0')
  return <span className="tabular-nums">{m}:{s}</span>
}

function PairingCard({ status, onPaired, onRefresh, desktop }) {
  const [pairing, setPairing] = useState(null)
  const [urlIndex, setUrlIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [paired, setPaired] = useState(null)
  const [connectionBusy, setConnectionBusy] = useState(null)
  const baseline = useRef(null)
  const urls = status?._connection_unverified ? [] : status?.urls || []
  const reachable = urls.length > 0
  const needsSetup = !!status?.setup?.required || (desktop && status?.setup?.accepted !== true)

  const connect = async (startTunnel = false) => {
    setConnectionBusy(startTunnel ? 'start' : 'refresh'); setError(null)
    try {
      if (startTunnel) await api.startTunnel()
      const latest = await onRefresh()
      if (!latest) throw new Error('Could not check the connection. Try Check connection again.')
      if (startTunnel && !latest.urls?.length) throw new Error('The tunnel has no reachable address yet. Check the connection again in a moment.')
    } catch (err) {
      const message = errText(err)
      setError(desktop && /cloudflared.*(?:not installed|not found|missing)/i.test(message)
        ? 'The secure-connection helper is missing. Install the latest IVE Mac app, then try again.'
        : message)
    } finally {
      setConnectionBusy(null)
    }
  }

  // A code for a previous tunnel address must not stay on screen after refresh.
  useEffect(() => {
    if (pairing && (needsSetup || !urls.some((u) => u.url === pairing.urls?.[urlIndex]?.url))) setPairing(null)
  }, [status, pairing, urlIndex, needsSetup])

  const start = async () => {
    setBusy(true); setError(null); setPaired(null)
    try {
      const before = await api.phoneDevices()
      baseline.current = new Set((before.devices || []).map((d) => d.id))
      const res = await api.phonePairStart()
      setPairing(res)
      setUrlIndex(0)
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  const cancel = useCallback(async () => {
    setPairing(null)
    try { await api.phonePairCancel() } catch { /* already gone */ }
  }, [])

  const expire = useCallback(() => setPairing(null), [])

  // While a code is live, watch for the new device to appear. The server's
  // phone_paired push checks at once; the poll is the fallback.
  useEffect(() => {
    if (!pairing) return undefined
    let stop = false
    const check = async () => {
      try {
        const res = await api.phoneDevices()
        const fresh = (res.devices || []).find((d) => !baseline.current?.has(d.id))
        if (fresh && !stop) {
          stop = true
          setPaired(fresh)
          setPairing(null)
          onPaired?.()
        }
      } catch { /* keep polling */ }
    }
    const t = setInterval(check, 1500)
    window.addEventListener('ive:phone-paired', check)
    return () => {
      stop = true
      clearInterval(t)
      window.removeEventListener('ive:phone-paired', check)
    }
  }, [pairing, onPaired])

  const current = pairing?.urls?.[urlIndex]

  return (
    <Section title="Connect your iPhone" icon={Smartphone} data-phone-pairing>
      <p className="text-xs leading-relaxed text-x-ink-secondary">
        Connect this Mac, then scan the code with your iPhone.
      </p>

      <div className="space-y-2" data-phone-connection>
        <h4 className="text-xs font-semibold text-x-ink">1. Connect this Mac</h4>
        {reachable ? (
          <p role="status" className="flex items-start gap-2 text-[12px] text-x-ink">
            <Check size={13} className="mt-0.5 shrink-0 text-x-accent" />
            {status.tunnel?.running ? 'Connected · Wi-Fi or mobile data' : 'Connected · same network required'}
          </p>
        ) : (
        <div className="flex items-start gap-2 rounded-md border border-x-line bg-x-surface-2 p-3 text-[12px] text-x-ink-secondary" data-phone-unreachable>
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-x-accent-ink" />
          <div className="space-y-1">
            <div className="font-medium text-x-ink">{status._connection_unverified ? 'Connection status could not be checked' : "Your phone can't reach IVE yet"}</div>
            {status._connection_unverified ? <div>Check the connection before creating a new pairing code. The last known address may no longer be valid.</div> : <>
              <div>{desktop ? 'The Mac app accepts local connections only. Being on the same Wi-Fi is not enough.' : 'IVE has no address your phone can reach yet.'}</div>
              <div>Start a Cloudflare tunnel to get an encrypted internet link to this Mac. Your phone still needs the one-time pairing code.</div>
              {status.tunnel?.cloudflared_installed === false && <div>{desktop ? 'The secure-connection helper is missing. Install the latest IVE Mac app, then check again.' : 'The connection helper (cloudflared) is missing on this server. Starting the connection will show the installation requirement.'}</div>}
            </>}
          </div>
        </div>
        )}
        <div className="flex flex-wrap gap-2">
          {!reachable && !status._connection_unverified && <Button variant="primary" icon={Globe} onClick={() => connect(true)} loading={connectionBusy === 'start'} disabled={!!connectionBusy || needsSetup} data-phone-tunnel-start>
            {connectionBusy === 'start' ? 'Starting secure connection…' : 'Start secure connection'}
          </Button>}
          <Button size="sm" onClick={() => connect()} loading={connectionBusy === 'refresh'} disabled={!!connectionBusy}>Check connection</Button>
        </div>
        {connectionBusy === 'start' && <p role="status" className="text-[12px] text-x-muted">Starting the tunnel can take up to a minute. Keep IVE open.</p>}
        <HelpDetails label="Connection help"><p className="text-[11px] leading-relaxed text-x-muted">Keep IVE open and this Mac awake. A new tunnel gets a new address: after restarting IVE or the tunnel, start the connection again and pair your iPhone with a new code.</p></HelpDetails>
      </div>

      <h4 className="text-xs font-semibold text-x-ink">2. Pair in the iPhone app</h4>

      {paired && (
        <div className="flex items-center gap-2 rounded-md border border-x-line bg-x-tint p-2.5 text-[12px] text-x-ink" data-phone-paired-ok>
          <Check size={13} className="text-x-accent" /> Connected: <b>{paired.label}</b>. You can revoke it below any time.
        </div>
      )}

      {!pairing && (
        <Button variant="primary" icon={QrCode} onClick={start} loading={busy} disabled={!reachable || busy || !!connectionBusy || needsSetup} data-phone-pair-start>
          {paired ? 'Connect another phone' : 'Show pairing code'}
        </Button>
      )}

      {error && <div role="alert" className="text-[12px] text-x-danger break-words">{error}</div>}
      {needsSetup && <p className="text-xs text-x-muted">Complete “Set up iPhone access” above to enable pairing.</p>}

      {pairing && current && (
        <div className="space-y-3" data-phone-pair-code={pairing.code}>
          {pairing.urls.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {pairing.urls.map((u, i) => (
                <Button key={u.url} size="sm" icon={u.kind === 'tunnel' ? Globe : Wifi} selected={i === urlIndex} onClick={() => setUrlIndex(i)}>
                  {u.label}
                </Button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-start gap-4">
            <div className="rounded-md bg-white p-2">
              <QRCodeSVG value={current.pair_url} size={168} level="M" data-phone-qr={current.pair_url} />
            </div>
            <div className="min-w-[200px] flex-1 space-y-2 text-[12px] text-x-ink-secondary">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-x-faint">Code</div>
                <div className="font-mono text-2xl font-semibold tracking-[0.12em] text-x-ink" data-phone-code-display>{pairing.code_display}</div>
                <div className="text-[11px] text-x-muted">Expires in <Countdown expiresAt={pairing.expires_at} onExpire={expire} /> · works once</div>
              </div>
              <ol className="list-decimal space-y-1 pl-4">
                <li>Open <b>IVE on your iPhone</b>. On <b>Connect to your Mac</b>, tap <b>Scan QR code</b> and scan this code.</li>
                <li>Alternatively, paste the full link below into <b>Or paste the pairing link</b>, then tap <b>Connect</b>.</li>
                <li>Already connected to an old address? In the iPhone app’s Settings, choose <b>Disconnect and pair again</b>, then scan the new code.</li>
              </ol>
              <label className="block space-y-1">
                <span className="text-[11px] text-x-muted">Full pairing link · private, works once</span>
                <Input readOnly value={current.pair_url} onFocus={(e) => e.target.select()} className="w-full font-mono text-[11px]" />
              </label>
              <details className="text-[12px] text-x-muted">
                <summary className="cursor-pointer text-x-ink">Use Safari instead</summary>
                <p className="mt-1 leading-relaxed">Scan with the iPhone Camera and open in Safari. For browser notifications: Share → Add to Home Screen (iOS 16.4+).</p>
              </details>
              {!current.secure && (
                <div className="text-[11px] text-x-muted">This address is plain http (unencrypted). Only use it on a network you trust.</div>
              )}
              <Button size="sm" icon={X} onClick={cancel}>Cancel</Button>
            </div>
          </div>
        </div>
      )}
    </Section>
  )
}

function DevicesCard({ devices, currentId, onRevoke, revoking }) {
  return (
    <Section title="Paired devices" icon={Smartphone} data-phone-devices>
      {devices.length === 0 ? (
        <p className="text-xs text-x-muted">No phone is paired.</p>
      ) : (
        <ul className="divide-y divide-x-line-subtle">
          {devices.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" data-phone-device={d.id}>
              <Smartphone size={14} className="shrink-0 text-x-muted" />
              <div className="min-w-[140px] flex-1">
                <div className="break-words text-xs font-medium text-x-ink">
                  {d.label}{d.id === currentId && <span className="ml-1.5 text-[11px] font-normal text-x-muted">(this phone)</span>}
                </div>
                <div className="break-words text-[11px] text-x-muted">
                  Paired {ago(d.paired_at)} · last used {ago(d.last_used_at)}{d.last_ip ? ` · ${d.last_ip}` : ''}
                </div>
              </div>
              <Button size="sm" variant="destructive" icon={Trash2} loading={revoking === d.id} disabled={!!revoking} onClick={() => onRevoke(d)} data-phone-revoke={d.id}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function PinCard({ status, onChanged }) {
  const [pin, setPin] = useState('')
  const [idle, setIdle] = useState(status?.idle_minutes || 15)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const enabled = !!status?.pin_enabled

  const save = async (e) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      await api.phoneSetPin(pin, idle)
      setPin('')
      onChanged?.()
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }
  const clear = async () => {
    setBusy(true); setError(null)
    try { await api.phoneClearPin(); onChanged?.() } catch (err) { setError(errText(err)) } finally { setBusy(false) }
  }

  return (
    <Section title="PIN lock" icon={KeyRound} data-phone-pin>
      <p className="text-xs leading-relaxed text-x-ink-secondary">
        {enabled
          ? `On · locks after ${status.idle_minutes} idle minutes and on restart.`
          : 'Off · add a PIN to protect access to your Mac. Five wrong attempts disconnect the phone.'}
      </p>
      <form onSubmit={save} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-x-muted">{enabled ? 'New PIN' : 'PIN'} ({status?.pin_min_length || 6}+ digits)</span>
          <Input type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="new-password" value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} className="w-36 font-mono" data-phone-pin-input />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-x-muted">Lock after</span>
          <select value={idle} onChange={(e) => setIdle(Number(e.target.value))}
            className="h-8 rounded-md border border-x-line bg-x-surface px-2 text-[13px] text-x-ink">
            {IDLE_OPTIONS.map((m) => <option key={m} value={m}>{m} min</option>)}
          </select>
        </label>
        <Button type="submit" variant="primary" loading={busy} disabled={busy || pin.length < (status?.pin_min_length || 6)} data-phone-pin-save>
          {enabled ? 'Change PIN' : 'Set PIN'}
        </Button>
        {enabled && <Button onClick={clear} disabled={busy} variant="destructive">Remove PIN</Button>}
      </form>
      {error && <div className="text-[12px] text-x-danger">{error}</div>}
      <p className="text-[11px] leading-relaxed text-x-muted">
        Face ID and Touch ID are available in the iPhone app’s settings.
      </p>
    </Section>
  )
}

function ThisPhoneCard({ status, onChanged }) {
  const [pushState, setPushState] = useState('checking')
  const [msg, setMsg] = useState(null)
  const standalone = typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || window.navigator?.standalone)
  useEffect(() => {
    let alive = true
    ;(async () => {
      if (!isPushSupported()) { if (alive) setPushState('unsupported'); return }
      const sub = await getPushSubscription().catch(() => null)
      if (alive) setPushState(sub ? 'on' : 'off')
    })()
    return () => { alive = false }
  }, [])
  const enable = async () => {
    setMsg(null)
    const res = await subscribeForPush().catch((err) => ({ ok: false, reason: errText(err) }))
    if (res.ok) setPushState('on')
    else setMsg(res.reason === 'permission_denied' ? 'Notifications are blocked. Allow them in iOS Settings → Notifications → IVE.' : `Could not turn on notifications (${res.reason}).`)
  }
  const lockNow = async () => {
    try { await api.phoneLock() } catch { /* the overlay takes over */ }
    window.dispatchEvent(new CustomEvent('ive:phone-locked', { detail: { error: 'locked' } }))
    onChanged?.()
  }
  return (
    <Section title="This phone" icon={Bell} data-phone-this>
      <p className="text-xs text-x-ink-secondary">This phone is paired with your Mac as a remote.</p>
      {pushState === 'unsupported' ? (
        <p className="text-[12px] text-x-muted">
          {standalone ? 'This browser has no web push.' : 'Notifications work once IVE is on your Home Screen: tap Share, then Add to Home Screen, then open IVE from there (iOS 16.4+).'}
        </p>
      ) : pushState === 'on' ? (
        <p className="flex items-center gap-1.5 text-[12px] text-x-ink"><Check size={12} className="text-x-accent" /> Notifications on: “needs you” and “finished”.</p>
      ) : pushState === 'off' ? (
        <Button variant="primary" icon={Bell} onClick={enable} data-phone-push-enable>Turn on notifications</Button>
      ) : null}
      {msg && <p className="text-[12px] text-x-danger">{msg}</p>}
      {status?.pin_enabled && <Button icon={Lock} onClick={lockNow}>Lock now</Button>}
    </Section>
  )
}

const APNS_TEAM_ID = '66Y43UAY3C'
const APNS_BUNDLE_ID = 'eu.aiforeu.ive'

function apnsDeviceLine(apns) {
  if (!apns) return 'IVE app not registered yet. Open the IVE app on this phone once.'
  const env = apns.environment === 'sandbox' ? 'Xcode build (sandbox)' : 'TestFlight / App Store (production)'
  const last = apns.last_result
  const lastText = !last ? '' : last.ok ? ' · last push delivered' : ` · last push failed: ${last.reason || last.status}`
  return `Registered · ${env} · token …${apns.token_tail}${lastText}`
}

function NativePushCard({ devices }) {
  const [st, setSt] = useState(null)
  const [keyFile, setKeyFile] = useState(null) // { name, text }
  const [keyId, setKeyId] = useState('')
  const [teamId, setTeamId] = useState(APNS_TEAM_ID)
  const [bundleId, setBundleId] = useState(APNS_BUNDLE_ID)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const fileRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const res = await api.phoneApnsStatus()
      setSt(res)
      setKeyId((v) => v || res.key_id || '')
      if (res.team_id) setTeamId(res.team_id)
      if (res.bundle_id) setBundleId(res.bundle_id)
    } catch (err) {
      setError(errText(err))
    }
  }, [])
  // Device list changes (pair / revoke) refresh the per-device status too.
  useEffect(() => { load() }, [load, devices.length])

  const pickFile = async (e) => {
    const file = e.target.files?.[0]
    setError(null)
    if (!file) return
    const text = await file.text()
    if (!text.includes('PRIVATE KEY')) { setError('This is not a .p8 key file.'); setKeyFile(null); return }
    setKeyFile({ name: file.name, text })
    // AuthKey_AB12CD34EF.p8 → Key ID AB12CD34EF
    const m = file.name.match(/AuthKey_([A-Z0-9]{10})\.p8$/i)
    if (m && !keyId) setKeyId(m[1].toUpperCase())
  }

  const save = async (e) => {
    e.preventDefault()
    setBusy('save'); setError(null); setNote(null)
    try {
      await api.phoneApnsSave({ keyP8: keyFile?.text, keyId, teamId, bundleId })
      setKeyFile(null)
      if (fileRef.current) fileRef.current.value = ''
      setNote('Saved. Send a test notification to check it.')
      await load()
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(null)
    }
  }

  const clear = async () => {
    setBusy('clear'); setError(null); setNote(null)
    try { await api.phoneApnsClear(); setKeyId(''); setConfirmClear(false); await load() } catch (err) { setError(errText(err)) } finally { setBusy(null) }
  }

  const test = async (deviceId) => {
    setBusy(`test:${deviceId || 'all'}`); setError(null); setNote(null)
    try {
      const res = await api.phoneApnsTest(deviceId)
      const failed = Object.values(res.results || {}).filter((r) => !r.ok)
      if (res.sent > 0 && failed.length === 0) setNote(`Test notification sent to ${res.sent} phone${res.sent === 1 ? '' : 's'}.`)
      else setError(`Not delivered: ${failed.map((r) => r.reason || r.status).join(', ') || 'unknown error'}`)
      await load()
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(null)
    }
  }

  const configured = !!st?.configured
  const canEdit = !!st?.can_edit
  const registered = (st?.devices || []).filter((d) => d.apns)

  return (
    <Section title="Native push (iPhone app)" icon={BellRing} data-apns-section={configured ? 'configured' : 'off'}>
      <p className="text-xs leading-relaxed text-x-ink-secondary">
        Add an Apple push key for iPhone notifications. Stored on this Mac and hidden after saving.
      </p>
      <div className="flex items-center gap-1.5 text-[12px]" data-apns-status>
        {configured
          ? <><Check size={12} className="text-x-accent" /><span className="text-x-ink">On. Key ID <span className="font-mono">{st.key_id}</span> · Team {st.team_id}</span></>
          : <span className="text-x-muted">Off. No APNs key yet.</span>}
      </div>
      {st && !st.transport && (
        <p className="text-[12px] text-x-danger">No HTTP/2 client found on this Mac (needs curl with HTTP2 or httpx[http2]).</p>
      )}

      {canEdit && (
        <form onSubmit={save} className="space-y-2" data-apns-form>
          {!configured && (
            <ol className="list-decimal space-y-0.5 pl-4 text-[12px] text-x-ink-secondary">
              <li>developer.apple.com → Certificates, IDs &amp; Profiles → <b>Keys</b> → <b>+</b>.</li>
              <li>Name it (e.g. “IVE push”), tick <b>Apple Push Notifications service (APNs)</b>, Continue, Register.</li>
              <li>Download the <span className="font-mono">AuthKey_….p8</span> file (only possible once) and pick it here.</li>
            </ol>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-x-muted">Key file (.p8)</span>
              <input ref={fileRef} type="file" accept=".p8" onChange={pickFile} className="sr-only" data-apns-file />
              <Button type="button" size="sm" icon={FileKey} onClick={() => fileRef.current?.click()}>
                {keyFile ? keyFile.name : configured ? 'Replace key…' : 'Choose .p8…'}
              </Button>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-x-muted">Key ID</span>
              <Input value={keyId} onChange={(e) => setKeyId(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10))}
                placeholder="AB12CD34EF" className="w-32 font-mono" data-apns-key-id />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-x-muted">Team ID</span>
              <Input value={teamId} onChange={(e) => setTeamId(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10))}
                className="w-32 font-mono" data-apns-team-id />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-x-muted">Bundle ID</span>
              <Input value={bundleId} onChange={(e) => setBundleId(e.target.value.trim())} className="w-40 font-mono" data-apns-bundle-id />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={busy === 'save'}
              disabled={!!busy || keyId.length !== 10 || (!configured && !keyFile)} data-apns-save>
              {configured ? 'Save' : 'Turn on native push'}
            </Button>
            {configured && <Button onClick={() => { setError(null); setConfirmClear(true) }} disabled={!!busy} variant="destructive">Remove key</Button>}
          </div>
        </form>
      )}

      {configured && (
        <div className="space-y-2">
          <ul className="divide-y divide-x-line-subtle">
            {(st?.devices || []).map((d) => (
              <li key={d.device_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" data-apns-device={d.device_id} data-apns-registered={d.apns ? 'yes' : 'no'}>
                <Smartphone size={14} className="shrink-0 text-x-muted" />
                <div className="min-w-[160px] flex-1">
                  <div className="text-xs font-medium text-x-ink">{d.label}</div>
                  <div className="break-words text-[11px] text-x-muted">{apnsDeviceLine(d.apns)}</div>
                </div>
                {d.apns && (
                  <Button size="sm" icon={Send} loading={busy === `test:${d.device_id}`} disabled={!!busy}
                    onClick={() => test(d.device_id)} data-apns-test={d.device_id}>
                    Send test
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {(st?.devices || []).length === 0 && <p className="text-[12px] text-x-muted">No phone is paired yet.</p>}
          {registered.length > 1 && (
            <Button size="sm" icon={Send} loading={busy === 'test:all'} disabled={!!busy} onClick={() => test(null)} data-apns-test-all>
              Send test notification to all
            </Button>
          )}
        </div>
      )}
      {note && <p className="text-[12px] text-x-ink" data-apns-note>{note}</p>}
      {error && <p className="text-[12px] text-x-danger" data-apns-error>{error}</p>}
      {confirmClear && <ConfirmPhoneAction title="Remove notification key?" confirmLabel="Remove key" busy={busy === 'clear'} error={error}
        onCancel={() => setConfirmClear(false)} onConfirm={clear}>
        Remove the APNs key from this Mac? The iPhone app will stop receiving notifications until you add a key again. Paired phones will stay connected.
      </ConfirmPhoneAction>}
    </Section>
  )
}

function NotesCard({ desktop }) {
  return (
    <Section title="Good to know" icon={Wifi} data-phone-notes>
      <ul className="list-disc space-y-1.5 pl-4 text-[12px] leading-relaxed text-x-ink-secondary">
        <li><b>The Mac must stay awake and IVE must stay open.</b> If either stops, your phone loses the connection. You can adjust sleep behavior in the Mac’s System Settings → Battery/Energy.</li>
        <li><b>Tunnel</b>: an encrypted internet connection via Cloudflare, for Wi-Fi or mobile data. The free tunnel gets a new address when it starts again. Start the connection on this Mac, then use a fresh pairing code in the iPhone app.</li>
        {desktop ? <li><b>Mac app:</b> use Start secure connection above. Joining the same Wi-Fi alone does not make this app reachable.</li> : <li><b>Other installations:</b> direct Wi-Fi access is available only when the IVE server is configured for network access. Use only an address shown in the pairing card; plain http is unencrypted.</li>}
        <li>Every remote request needs a paired device. Revoking a device ends its access at once, including open terminals.</li>
      </ul>
    </Section>
  )
}

export default function PhonePanel() {
  const desktop = isTauri()
  const [status, setStatus] = useState(null)
  const [devices, setDevices] = useState([])
  const [currentId, setCurrentId] = useState(null)
  const [error, setError] = useState(null)
  const [revoking, setRevoking] = useState(null)
  const [revokeTarget, setRevokeTarget] = useState(null)
  const [revokeError, setRevokeError] = useState(null)
  const refreshSequence = useRef(0)

  const load = useCallback(async () => {
    const sequence = ++refreshSequence.current
    try {
      const st = await api.phoneStatus()
      if (sequence === refreshSequence.current) setStatus(st)
      if (st.is_local_owner || st.is_device) {
        const res = await api.phoneDevices()
        if (sequence === refreshSequence.current) {
          setDevices(res.devices || [])
          setCurrentId(res.current_device_id || null)
        }
      }
      if (sequence === refreshSequence.current) setError(null)
      return st
    } catch (err) {
      // 423 = this phone is PIN-locked; the lock overlay handles it.
      if (sequence === refreshSequence.current) {
        if (!(err instanceof ApiError && err.status === 423)) setError(errText(err))
        setStatus((previous) => previous ? { ...previous, _connection_unverified: true,
          availability: { state: 'unknown', message: 'Could not confirm the current Mac status. Check availability before closing the lid.' } } : previous)
      }
      return null
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!status?.desktop) return undefined
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [load, status?.desktop])
  useEffect(() => {
    window.addEventListener('ive:phone-unlocked', load)
    window.addEventListener('ive:phone-paired', load)
    window.addEventListener('focus', load)
    return () => {
      window.removeEventListener('ive:phone-unlocked', load)
      window.removeEventListener('ive:phone-paired', load)
      window.removeEventListener('focus', load)
    }
  }, [load])

  const revoke = async () => {
    const device = revokeTarget
    if (!device || revoking) return
    const self = device.id === currentId
    setRevoking(device.id)
    setRevokeError(null)
    try {
      await api.phoneRevokeDevice(device.id)
      if (self) { window.location.reload(); return }
      setRevokeTarget(null)
      await load()
    } catch (err) {
      setRevokeError(errText(err))
    } finally {
      setRevoking(null)
    }
  }

  const askRevoke = (device) => { setRevokeError(null); setRevokeTarget(device) }

  const role = useMemo(() => {
    if (!status) return 'loading'
    if (status.is_local_owner) return 'mac'
    if (status.is_device) return 'device'
    return 'other'
  }, [status])

  return (
    <div className="h-full overflow-y-auto" data-phone-panel={role}>
      <div className="mx-auto max-w-3xl space-y-4 p-5">
        {error && <div role="alert" className="rounded-md border border-x-line bg-x-surface-2 p-2 text-[12px] text-x-danger">{error}</div>}
        {role === 'mac' && (
          <>
            {status?.desktop && <PhoneSetupCard setup={status.setup} availability={status.availability} onChanged={load} />}
            <PairingCard status={status} onPaired={load} onRefresh={load} desktop={desktop || !!status?.desktop} />
            <DevicesCard devices={devices} currentId={currentId} onRevoke={askRevoke} revoking={revoking} />
            <PinCard status={status} onChanged={load} />
            <NativePushCard devices={devices} />
            <NotesCard desktop={desktop || !!status?.desktop} />
          </>
        )}
        {role === 'device' && (
          <>
            <ThisPhoneCard status={status} onChanged={load} />
            <DevicesCard devices={devices} currentId={currentId} onRevoke={askRevoke} revoking={revoking} />
            <NotesCard desktop={desktop} />
          </>
        )}
        {role === 'other' && (
          <Section title="iPhone & Devices" icon={Smartphone}>
            <p className="text-xs text-x-ink-secondary">Phones are paired and managed on the Mac where IVE runs.</p>
          </Section>
        )}
      </div>
      {revokeTarget && <ConfirmPhoneAction title={revokeTarget.id === currentId ? 'Disconnect this phone?' : 'Revoke phone access?'}
        confirmLabel={revokeTarget.id === currentId ? 'Disconnect phone' : 'Revoke access'} busy={!!revoking} error={revokeError}
        onCancel={() => setRevokeTarget(null)} onConfirm={revoke}>
        <strong>{revokeTarget.label}</strong> will lose access to this Mac immediately, including open sessions. To reconnect, this phone will need a new pairing code. Your sessions and project files on the Mac will stay in IVE.
      </ConfirmPhoneAction>}
    </div>
  )
}
