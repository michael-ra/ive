import HelpDetails from '../ui/HelpDetails'
import { useEffect, useState } from 'react'
import { Battery, Check, Lock, Smartphone } from 'lucide-react'
import { api } from '../../lib/api'
import { Button } from '../ui'

const STATUS_TEXT = {
  needs_approval: 'macOS approval is still needed. Keep the lid open until availability is active.',
  not_registered: 'One-time macOS helper setup is needed before closed-lid access can start.',
  unregistered: 'One-time macOS helper setup is needed before closed-lid access can start.',
  not_found: 'The Mac helper is missing. Install the latest IVE Mac app to use closed-lid access.',
  ready: 'The Mac helper is ready. Closed-lid availability is not active yet.',
  activating: 'Preparing this Mac for phone access. Keep the lid open for now.',
  active: 'Closed-lid availability is active on this Mac.',
  restoring: 'Restoring normal sleep behavior. Keep the lid open until this is confirmed.',
  restore_failed: 'Normal sleep could not be restored. Keep the lid open and retry below.',
  stopped: 'Normal Mac sleep behavior is in use.',
  blocked: 'Closed-lid availability could not start. Keep the lid open.',
  unavailable: 'Closed-lid availability requires the latest IVE Mac app.',
  unknown: 'Mac availability could not be verified. Keep the lid open and check again.',
}

export default function PhoneSetupCard({ setup, availability, onChanged }) {
  const accepted = !!setup?.accepted
  const [editing, setEditing] = useState(!accepted)
  const [control, setControl] = useState(false)
  const [awake, setAwake] = useState(!!setup?.closed_lid_requested)
  const [battery, setBattery] = useState(!!setup?.allow_battery_requested)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => { if (!accepted) setEditing(true) }, [accepted])
  const phase = availability?.state || 'unavailable'
  const active = phase === 'active'
  const restoring = phase === 'restoring' || phase === 'restore_failed'
  const transitional = phase === 'activating' || phase === 'restoring'
  const requested = !!setup?.closed_lid_requested

  const run = async (action, progress) => {
    setBusy(progress); setError(null)
    let failure = null
    try { await action() }
    catch (err) { failure = err.message || String(err) }
    // Consent, tunnel and helper are separate operations: even after a later
    // failure, show what was actually saved and the latest helper state.
    try {
      const latest = await onChanged()
      if (!latest && !failure) failure = 'The request finished, but its current status could not be checked. Use Check availability before closing the lid.'
    } catch (err) { if (!failure) failure = err.message || String(err) }
    setError(failure)
    setBusy(null)
  }
  const save = () => run(async () => {
    await api.phoneSetup({ consent_version: 1, remote_control: control, closed_lid: awake, allow_battery: awake && battery })
    setEditing(false)
    // Opting out must restore the old mode even if reconnecting the tunnel
    // fails afterwards. First-time setup with no power choice makes no OS call.
    if ((!awake && (requested || active || restoring)) || (active && availability.allow_battery !== battery)) {
      const stopped = await api.phoneAvailabilityStop()
      if ((active || restoring) && !['stopped', 'ready'].includes(stopped?.state)) {
        throw new Error('Your choices were saved, but normal sleep is not confirmed yet. Keep the lid open and use Restore normal sleep before starting again.')
      }
    }
    await api.startTunnel()
    if (awake) await api.phoneAvailabilityStart()
  }, 'Saving your choices and connecting this Mac…')
  const review = () => {
    setControl(false)
    setAwake(!!setup?.closed_lid_requested)
    setBattery(!!setup?.allow_battery_requested)
    setError(null)
    setEditing(true)
  }
  const expires = availability?.expires_at ? new Date(availability.expires_at) : null
  const endTime = expires && !Number.isNaN(expires.getTime()) ? expires.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null

  return (
    <section className="space-y-3 rounded-lg border border-x-line bg-x-surface p-4" data-phone-setup>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-x-ink"><Smartphone size={14} className="text-x-accent" />Set up iPhone access</h3>
      <p className="text-xs leading-relaxed text-x-ink-secondary">Control IVE from your iPhone. Keep this Mac and IVE running.</p>

      {editing ? <fieldset disabled={!!busy} className="space-y-4">
        <legend className="sr-only">iPhone control and optional Mac availability</legend>
        <div className="space-y-2 text-xs leading-relaxed text-x-ink-secondary">
          <HelpDetails label="Which AI account is used?"><p><b className="text-x-ink">Use your existing AI accounts.</b> Sign in to Claude or Codex on this Mac first. Your phone uses those same sessions; it does not need a second AI login. Requests to approve agent actions still appear in the session.</p></HelpDetails>
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-x-line p-3">
            <input type="checkbox" checked={control} onChange={e => setControl(e.target.checked)} className="mt-0.5 accent-[var(--color-x-accent)]" />
            <span><b className="text-x-ink">Allow my paired phone to control IVE.</b><br />Can read chats, send messages and run commands with my Mac account. Pair only a trusted phone; revoke access here anytime.</span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-x-line p-3">
            <input type="checkbox" checked={awake} onChange={e => setAwake(e.target.checked)} className="mt-0.5 accent-[var(--color-x-accent)]" />
            <span><b className="text-x-ink">Keep this Mac available with the lid closed (optional).</b><br />Requires macOS approval. Keeps this Mac awake while the screen can stay locked.</span>
          </label>
          {awake && <div className="space-y-2 pl-6">
            <label className="flex cursor-pointer items-start gap-2"><input type="checkbox" checked={battery} onChange={e => setBattery(e.target.checked)} className="mt-0.5 accent-[var(--color-x-accent)]" /><span>Also run on battery (optional)</span></label>
            <p className="flex items-start gap-2"><Battery size={14} className="mt-0.5 shrink-0" /><span>Uses battery and produces heat. Stops after 8 hours, at 20% battery, on overheating or when IVE disconnects. Keep the Mac ventilated, never in a bag.</span></p>
            <p>Lock your Mac with <b>Control–Command–Q</b> before closing the lid. Phone access keeps working while locked.</p>
          </div>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={!control || !!busy} loading={!!busy} onClick={save}>Agree and set up iPhone access</Button>
          {accepted && <Button disabled={!!busy} onClick={() => { setError(null); setEditing(false) }}>Cancel</Button>}
        </div>
        <HelpDetails label="About macOS approval"><p className="flex items-start gap-2 text-[11px] leading-relaxed text-x-muted"><Lock size={12} className="mt-0.5 shrink-0" /><span>macOS handles its own administrator approval. IVE does not collect your Mac password or bypass Claude/Codex permissions.</span></p></HelpDetails>
      </fieldset> : <div className="space-y-3">
        {accepted && <p className="flex items-start gap-2 text-xs text-x-ink-secondary"><Check size={14} className="mt-0.5 shrink-0 text-x-accent" />Phone control allowed · pairing required</p>}
        <p className="text-xs text-x-muted">Saved choice: {requested ? `closed-lid access requested · ${setup.allow_battery_requested ? 'battery allowed' : 'power adapter only'}. This does not grant macOS approval or start the mode by itself.` : 'normal Mac sleep behavior. Keep the lid open for phone access.'}</p>
        <div className="rounded-md border border-x-line bg-x-surface-2 p-3 text-xs" role="status" data-phone-availability={phase}>
          <p className="font-medium text-x-ink">{STATUS_TEXT[phase] || STATUS_TEXT.unknown}</p>
          {active && <p className="mt-1 text-x-ink-secondary">{availability.allow_battery ? 'Power adapter or battery' : 'Power adapter only'} · works while the screen is locked · maximum 8 hours{endTime ? ` · until ${endTime}` : ''}. At {availability.battery_floor || 20}% battery or high temperature, the closed Mac sleeps and the phone disconnects. Closing IVE ends this mode and restores normal sleep behavior.</p>}
          {active && <p className="mt-2 text-x-ink">Lock your Mac with <b>Control–Command–Q</b> before closing the lid. Phone access keeps working while locked.</p>}
          {availability?.message && <p className="mt-1 break-words text-x-ink-secondary">{availability.message}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {phase === 'needs_approval' && requested && <Button variant="primary" disabled={!!busy} onClick={() => run(() => api.phoneAvailabilityApprove(), 'Opening macOS approval settings…')}>Open macOS approval settings</Button>}
          {!active && !restoring && phase !== 'unknown' && requested && <Button variant={phase === 'needs_approval' ? 'default' : 'primary'} disabled={!!busy || transitional} loading={!!busy} onClick={() => run(async () => { await api.startTunnel(); await api.phoneAvailabilityStart() }, 'Checking approval and starting availability…')}>{phase === 'needs_approval' ? 'Continue after approval' : 'Keep Mac available'}</Button>}
          {(active || restoring) && <Button disabled={!!busy || phase === 'restoring'} loading={!!busy} onClick={() => run(() => api.phoneAvailabilityStop(), 'Restoring normal sleep behavior…')}>Restore normal sleep</Button>}
          <Button size="sm" disabled={!!busy} onClick={() => run(async () => {}, 'Checking Mac availability…')}>Check availability</Button>
          <Button size="sm" disabled={!!busy || transitional} onClick={review}>Review permissions</Button>
        </div>
      </div>}
      {busy && <p role="status" className="text-xs text-x-muted">{busy}</p>}
      {error && <p role="alert" className="break-words text-xs text-x-danger">{error}</p>}
    </section>
  )
}
