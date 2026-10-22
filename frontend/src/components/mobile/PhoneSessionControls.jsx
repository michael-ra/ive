import { useEffect, useMemo, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { getModelsForCli, getEffortOptionsForCli, getPermissionModesForCli } from '../../lib/constants'
import { isShellSession } from '../../lib/sessionStatus'
import { Modal } from '../ui/Modal'
import { phoneApplyFeedback, phoneControlReason, phoneSessionPatch, savePhoneSession } from './phoneControlActions'

const selectClass = 'w-full min-h-11 rounded-lg border border-x-line bg-x-surface px-3 text-base text-x-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-x-accent disabled:opacity-50'

export default function PhoneSessionControls({ sessionId, onClose }) {
  const session = useStore((s) => s.sessions[sessionId])
  const connected = useStore((s) => s.connected)
  const auth = useStore((s) => s.currentAuth)
  const profiles = useStore((s) => s.cliProfiles)
  const launch = useStore((s) => s.launchApply[sessionId])
  const permission = useStore((s) => s.permissionApply[sessionId])
  const [draft, setDraft] = useState(() => ({ name: session?.name || '', model: session?.model || '', effort: session?.effort || '', permission_mode: session?.permission_mode || '' }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const shell = isShellSession(session)
  const reason = phoneControlReason(session, { connected, auth })
  const cli = session?.cli_type || 'claude'
  const options = useMemo(() => {
    const model = getModelsForCli(cli).map((item) => ({ value: item.id || '', label: item.label || item.id || 'Standard' }))
    if (session?.model && !model.some((item) => item.value === session.model)) model.unshift({ value: session.model, label: session.model })
    return {
      model,
      effort: getEffortOptionsForCli(cli, draft.model),
      permission_mode: getPermissionModesForCli(cli).map((item) => ({ value: item.id, label: item.label || item.id, description: item.description })),
    }
  }, [cli, session?.model, draft.model, profiles])
  useEffect(() => {
    let alive = true
    Promise.allSettled([api.getLaunchApply(sessionId), api.getPermissionModeApply(sessionId)]).then(([launchResult, permissionResult]) => {
      if (!alive) return
      const store = useStore.getState()
      if (launchResult.status === 'fulfilled') for (const [field, info] of Object.entries(launchResult.value?.fields || {})) {
        if (field !== 'permission_mode') store.setLaunchApply(sessionId, field, info)
      }
      if (permissionResult.status === 'fulfilled') store.setPermissionApply(sessionId, permissionResult.value)
    })
    return () => { alive = false }
  }, [sessionId])
  let changed = false, launchChange = false
  try {
    const patch = phoneSessionPatch(session || {}, draft, options)
    changed = Object.keys(patch).length > 0
    launchChange = !!patch.apply_live
  } catch { changed = true }
  const feedback = phoneApplyFeedback({ ...launch, permission_mode: permission })
  const save = async (event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(''); setSaved(false)
    try {
      const state = useStore.getState()
      const updated = await savePhoneSession(api, state.sessions[sessionId], draft, options, { connected: state.connected, auth: state.currentAuth })
      if (!updated) return
      useStore.setState((current) => current.sessions[sessionId] ? { sessions: { ...current.sessions, [sessionId]: { ...current.sessions[sessionId], name: updated.name, model: updated.model, effort: updated.effort, permission_mode: updated.permission_mode } } } : {})
      for (const [field, info] of Object.entries(updated.launch_apply || {})) {
        if (field === 'permission_mode') useStore.getState().setPermissionApply(sessionId, info)
        else useStore.getState().setLaunchApply(sessionId, field, info)
      }
      if (updated.permission_apply) useStore.getState().setPermissionApply(sessionId, updated.permission_apply)
      setSaved(true)
    } catch (failure) { setError(failure?.message || 'Die Änderung ist fehlgeschlagen.') }
    finally { setBusy(false) }
  }
  const change = (field, value) => { setDraft((previous) => ({ ...previous, [field]: value })); setSaved(false); setError('') }
  return <Modal title={shell ? 'Terminal steuern' : 'Session steuern'} icon={SlidersHorizontal} size="sm" onClose={busy ? undefined : onClose}>
    <form onSubmit={save} className="min-h-0 overflow-y-auto p-4 space-y-4" data-phone-session-controls="">
      <p className="text-sm text-x-muted">{shell ? 'Echte Shell auf deinem Mac. Eingaben führen Befehle direkt im Projektordner aus.' : 'Einstellungen gelten für dieselbe Session auf Mac und iPhone.'}</p>
      <label className="block space-y-1 text-sm text-x-ink">Name<input value={draft.name} maxLength={120} onChange={(e) => change('name', e.target.value)} disabled={!!reason || busy} className={selectClass} /></label>
      {!shell && ['model', 'effort', 'permission_mode'].map((field) => options[field].length > 0 && <label key={field} className="block space-y-1 text-sm text-x-ink">
        <span>{{ model: 'Modell', effort: 'Denktiefe', permission_mode: 'Berechtigungen' }[field]}</span>
        <select aria-label={{ model: 'Modell', effort: 'Denktiefe', permission_mode: 'Berechtigungen' }[field]} aria-describedby={`phone-setting-${sessionId}-${field}`} value={draft[field]} onChange={(e) => change(field, e.target.value)} disabled={!!reason || busy} className={selectClass}>
          {!options[field].some((option) => option.value === draft[field]) && <option value={draft[field]}>{draft[field] || 'Standard'} (aktuell)</option>}
          {options[field].map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <span id={`phone-setting-${sessionId}-${field}`} className="block text-xs text-x-muted">{field === 'permission_mode' ? options[field].find((item) => item.value === draft[field])?.description : field === 'effort' ? 'Mehr Denktiefe kann mehr Zeit und Tokens benötigen.' : 'Wähle ein Modell des aktuellen Agenten.'}</span>
      </label>)}
      {launchChange && <p className="rounded-lg border border-x-line bg-x-surface-2 p-3 text-sm text-x-ink-secondary">{session?.pty_alive ? 'Beim Übernehmen startet der Agent mit den neuen Einstellungen neu. Eine laufende Antwort oder Freigabe wird erst abgewartet; der Chatverlauf wird fortgesetzt.' : 'Diese Einstellungen gelten beim nächsten Start.'}</p>}
      {reason && <p role="status" className="text-sm text-x-warning">{reason}</p>}
      {error && <p role="alert" className="text-sm text-x-danger">{error}</p>}
      {(saved || Object.keys(launch || {}).length > 0 || permission?.state && permission.state !== 'none') && <p role={feedback.tone === 'error' ? 'alert' : 'status'} className={`text-sm ${feedback.tone === 'error' ? 'text-x-danger' : 'text-x-ink-secondary'}`}>{feedback.text}</p>}
      <button type="submit" disabled={busy || !!reason || !changed} className="ive-phone-primary w-full disabled:opacity-50">{busy ? 'Wird gespeichert …' : launchChange && session?.pty_alive ? 'Änderungen und Neustart bestätigen' : 'Änderungen übernehmen'}</button>
    </form>
  </Modal>
}
