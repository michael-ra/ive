import HelpDetails from '../ui/HelpDetails'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Battery, Laptop, Leaf, Pause, Play, RotateCw, Square, Timer } from 'lucide-react'
import { request } from '../../lib/api'
import { Button } from '../ui'

const APPS = [
  ['com.tinyspeck.slackmacgap', 'Slack'], ['com.hnc.Discord', 'Discord'],
  ['net.whatsapp.WhatsApp', 'WhatsApp'], ['com.spotify.client', 'Spotify'],
]
const DURATIONS = [[900, '15 Minuten'], [1800, '30 Minuten'], [3600, '1 Stunde'], [7200, '2 Stunden'], [14400, '4 Stunden'], [28800, '8 Stunden']]
const PREF_KEY = 'ive:mac-power-options:v1'
const DEFAULTS = { duration_seconds: 3600, allow_battery: false, lid_low_power: true, pause_apps: [] }
const LABELS = {
  loading: 'Status wird geprüft', unknown: 'Status nicht bestätigt', unavailable: 'IVE Mac-App erforderlich',
  not_found: 'Mac-Helfer fehlt', not_registered: 'Einmalige Einrichtung erforderlich', unregistered: 'Einmalige Einrichtung erforderlich',
  needs_approval: 'macOS-Freigabe erforderlich', ready: 'Ausgeschaltet', stopped: 'Ausgeschaltet',
  restoring: 'Einstellungen werden wiederhergestellt', restore_failed: 'Wiederherstellung noch offen', blocked: 'Modus nicht verfügbar',
}
function loadOptions() {
  try {
    const value = JSON.parse(localStorage.getItem(PREF_KEY))
    if (value && DURATIONS.some(([n]) => n === value.duration_seconds)
      && typeof value.allow_battery === 'boolean' && typeof value.lid_low_power === 'boolean'
      && Array.isArray(value.pause_apps) && value.pause_apps.every(id => APPS.some(([key]) => key === id))) return value
  } catch { /* use defaults */ }
  return DEFAULTS
}
function remaining(expires, now) {
  const seconds = Math.max(0, Math.ceil((Date.parse(expires) - now) / 1000))
  if (!Number.isFinite(seconds)) return '–:––'
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

export default function MacPowerPanel() {
  const [options, setOptions] = useState(loadOptions)
  const [status, setStatus] = useState({ state: 'loading' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [now, setNow] = useState(Date.now)
  const revision = useRef(0)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const refresh = useCallback(async (clearError = false) => {
    if (busyRef.current) return
    const current = ++revision.current
    try {
      const value = await request('/mac-power', { signal: AbortSignal.timeout(30000) })
      if (mounted.current && revision.current === current) { setStatus(value); if (clearError) setError('') }
    } catch (e) {
      if (mounted.current && revision.current === current) {
        setStatus({ state: 'unknown' }); setError(e.message || 'Der Mac-Status konnte nicht geprüft werden.')
      }
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    refresh()
    const interval = setInterval(() => { if (!document.hidden) refresh() }, 5000)
    const visible = () => { if (!document.hidden) refresh() }
    document.addEventListener('visibilitychange', visible)
    return () => { mounted.current = false; ++revision.current; clearInterval(interval); document.removeEventListener('visibilitychange', visible) }
  }, [refresh])
  useEffect(() => {
    if (status.state !== 'active') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [status.state])
  const update = (change) => {
    const value = { ...options, ...change }
    setOptions(value)
    try { localStorage.setItem(PREF_KEY, JSON.stringify(value)) } catch { /* mode still works without saved preferences */ }
  }
  const act = async (action) => {
    if (busyRef.current) return
    busyRef.current = true; ++revision.current; setBusy(action); setError('')
    let failure = ''
    try {
      const value = await request(`/mac-power/${action}`, {
        method: 'POST', ...(action === 'start' ? { body: JSON.stringify(options) } : {}),
        signal: AbortSignal.timeout(90000),
      })
      if (mounted.current) { setStatus(value); setNow(Date.now()) }
    } catch (e) {
      failure = e.message || 'Der Modus konnte nicht geändert werden.'
      // A timed-out start may have reached macOS. Require fresh status, never
      // leave the preceding ready state offering another activation.
      if (mounted.current) setStatus({ state: 'unknown' })
    } finally {
      busyRef.current = false
      if (mounted.current) {
        setBusy('')
        if (failure) setError(failure)
      }
    }
  }
  const active = status.state === 'active'
  const restoring = ['restoring', 'restore_failed'].includes(status.state)
  const expired = active && Date.parse(status.expires_at) <= now
  const canStart = ['ready', 'stopped', 'not_registered', 'unregistered', 'needs_approval'].includes(status.state)
    && status.lid_saver_supported === true
  const liveOptions = active ? {
    allow_battery: status.allow_battery, lid_low_power: status.lid_low_power,
    pause_apps: status.pause_apps || [],
  } : options
  const title = active ? (expired ? 'Zeitlimit erreicht · Status wird geprüft' : status.lid_saver_active ? 'Sparmodus läuft · Deckel geschlossen' : status.mode_source === 'phone' ? 'iPhone-Verfügbarkeit aktiv' : 'Eingeschaltet · bereit zum Zuklappen') : LABELS[status.state] || 'Status prüfen'

  return <div className="h-full overflow-y-auto" data-mac-power-panel>
    <div className="mx-auto max-w-[760px] space-y-6 p-5 sm:p-7">
      <div>
        <h3 className="text-lg font-semibold tracking-tight text-x-ink">Zuklappen. Agenten arbeiten weiter.</h3>
        <HelpDetails label="So funktioniert es"><p className="mt-2 max-w-[62ch] text-xs leading-relaxed text-x-muted">Schalte die Funktion für deinen Arbeitslauf ein. Erst beim Zuklappen spart IVE Strom und pausiert die ausgewählten Apps. Beim Aufklappen kehrt alles zum vorherigen Zustand zurück; der Timer läuft weiter.</p></HelpDetails>
      </div>

      <div className={`rounded-xl border p-4 ${active ? 'border-x-accent/40 bg-x-tint' : 'border-x-line bg-x-surface-2'}`} data-mac-power-state={status.state}>
        <div className="flex flex-wrap items-center gap-3">
          <Laptop size={22} className={active ? 'text-x-accent-ink' : 'text-x-muted'} />
          <div className="min-w-0 flex-1"><p role="status" className="text-sm font-medium text-x-ink">{title}</p>
            <p className="mt-1 text-xs text-x-muted">{active ? 'Auch ohne iPhone-Verbindung erreichbar.' : 'Ausgeschaltet'}</p></div>
          {active && <span className="font-mono text-xl tabular-nums text-x-ink" aria-label="Verbleibende Laufzeit">{remaining(status.expires_at, now)}</span>}
        </div>
        {active && <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-x-line pt-3 text-[11px] text-x-ink-secondary">
          <span>{status.battery_percent == null ? 'Akku unbekannt' : `Akku ${Math.round(status.battery_percent)} %`}{status.on_battery === false ? ' · am Netzteil' : ''}</span>
          <span>{status.low_power_active ? 'macOS-Stromsparmodus aktiv' : 'macOS-Stromsparmodus aus'}</span>
          <span>{status.paused_processes > 0 ? 'Ausgewählte Apps pausiert' : 'Keine Apps pausiert'}</span>
        </div>}
        {status.message && <p className="mt-3 text-xs leading-relaxed text-x-ink-secondary">{status.message}</p>}
        {status.state === 'unavailable' && <p className="mt-3 text-xs text-x-muted">Diese Funktion benötigt die installierte IVE Mac-App mit ihrem macOS-Helfer.</p>}
        {status.state === 'needs_approval' && <p className="mt-3 text-xs text-x-ink-secondary">Erlaube den IVE-Hintergrunddienst in macOS. Danach kannst du den Modus hier einschalten.</p>}
        {status.lid_saver_supported === false && <p className="mt-3 text-xs text-x-muted">Aktualisiere die IVE Mac-App für den Sparmodus beim Zuklappen.</p>}
      </div>

      {error && <p role="alert" className="rounded-lg border border-x-danger/30 bg-x-danger/5 p-3 text-xs text-x-danger">{error}</p>}

      <fieldset disabled={active || restoring || !!busy} className="space-y-5 disabled:opacity-70">
        <legend className="sr-only">Optionen für den nächsten Arbeitslauf</legend>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label htmlFor="mac-power-duration" className="flex items-center gap-2 text-sm font-medium text-x-ink"><Timer size={16} />Maximale Laufzeit</label>
          <select id="mac-power-duration" value={options.duration_seconds} onChange={e => update({ duration_seconds: Number(e.target.value) })} className="rounded-md border border-x-line-strong bg-x-surface px-3 py-2 text-xs text-x-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-x-focus">
            {DURATIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <label className="flex items-start gap-3 text-xs leading-relaxed text-x-muted">
          <input type="checkbox" checked={!!liveOptions.allow_battery} onChange={e => update({ allow_battery: e.target.checked })} className="mt-0.5 accent-[var(--color-x-accent)]" />
          <span><b className="flex items-center gap-1.5 font-medium text-x-ink"><Battery size={14} />Auch im Akkubetrieb weiterarbeiten</b>Ohne diese Auswahl endet die Funktion beim Abziehen des Netzteils.</span>
        </label>
        <div className="border-t border-x-line pt-5">
          <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-x-muted">Nur bei geschlossenem Deckel</p>
          <label className="flex items-start gap-3 text-xs leading-relaxed text-x-muted">
            <input type="checkbox" checked={!!liveOptions.lid_low_power} onChange={e => update({ lid_low_power: e.target.checked })} className="mt-0.5 accent-[var(--color-x-accent)]" />
            <span><b className="flex items-center gap-1.5 font-medium text-x-ink"><Leaf size={14} />macOS-Stromsparmodus im Akkubetrieb</b>Beim Aufklappen wird das vorherige Profil wiederhergestellt. Berechnungen können langsamer laufen.</span>
          </label>
          <div className="mt-5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-x-ink"><Pause size={14} />Diese Apps vorübergehend pausieren</p>
            <p className="mt-1 text-xs leading-relaxed text-x-muted">Nachrichten und Musik dieser Apps pausieren bis zum Aufklappen. IVE und Agenten laufen weiter.</p>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {APPS.map(([id, name]) => <label key={id} className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-xs text-x-ink ${liveOptions.pause_apps.includes(id) ? 'border-x-accent/40 bg-x-tint' : 'border-x-line bg-x-surface'}`}>
                <input type="checkbox" checked={liveOptions.pause_apps.includes(id)} onChange={e => update({ pause_apps: e.target.checked ? [...options.pause_apps, id] : options.pause_apps.filter(key => key !== id) })} className="accent-[var(--color-x-accent)]" />{name}
              </label>)}
            </div>
          </div>
        </div>
      </fieldset>

      <div className="border-t border-x-line pt-5">
        <div className="flex flex-wrap gap-2">
          {(active || restoring) ? <Button icon={Square} disabled={!!busy} loading={busy === 'stop'} onClick={() => act('stop')}>Ausschalten und wiederherstellen</Button>
            : <Button variant="primary" icon={Play} disabled={!!busy || !canStart} loading={busy === 'start'} onClick={() => act('start')}>{status.state === 'needs_approval' ? 'Nach Freigabe einschalten' : 'Funktion einschalten'}</Button>}
          {status.state === 'needs_approval' && <Button disabled={!!busy} onClick={() => act('approval')}>macOS-Freigabe öffnen</Button>}
          <Button icon={RotateCw} disabled={!!busy} onClick={() => refresh(true)}>Status prüfen</Button>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-x-muted">Endet mit dem Timer, beim Beenden von IVE, bei 20 % Akku oder Hitze. Mac belüftet halten und vor dem Zuklappen sperren (⌃⌘Q).</p>
      </div>
    </div>
  </div>
}
