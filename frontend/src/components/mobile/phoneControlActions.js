// Phone actions use the same authenticated HTTP endpoints as the desktop.
// Keep delivery acknowledgment separate from the agent actually becoming idle.
export function phoneControlReason(session, { connected, auth } = {}) {
  if (!session?.id) return 'Diese Session ist nicht mehr verfügbar.'
  if (session.read_only || session.is_external) return 'Diese Session ist nur zum Lesen verfügbar.'
  if (session.archived) return 'Archivierter Verlauf. Zum Steuern zuerst wieder öffnen.'
  if (!connected) return 'Keine Verbindung zum Mac. Bitte auf die Wiederverbindung warten.'
  if (!auth) return 'Zugriffsrechte werden geladen.'
  if (!['full', 'code'].includes(auth.mode)) return 'Dein Zugriff erlaubt keine Terminal-Steuerung.'
  return ''
}

export function phoneInterruptBytes(session) {
  return session?.cli_type === 'gemini' || session?.cli_type === 'shell' || session?.session_type === 'shell' ? '\x03' : '\x1b'
}

export async function interruptPhoneSession(api, session, access) {
  const reason = phoneControlReason(session, access)
  if (reason) throw new Error(reason)
  if (!session.pty_alive) throw new Error('Diese Session läuft gerade nicht.')
  const result = await api.sendSessionInput(session.id, phoneInterruptBytes(session), { raw: true })
  if (result?.ok !== true || (result.session_id && result.session_id !== session.id)) {
    throw new Error('Der Mac hat die Unterbrechung nicht bestätigt. Status prüfen und erneut versuchen.')
  }
  return result
}

export function phoneSessionPatch(session, draft, options) {
  const patch = {}
  const name = String(draft.name || '').trim()
  if (!name) throw new Error('Gib der Session einen Namen.')
  if (name.length > 120) throw new Error('Der Name darf höchstens 120 Zeichen haben.')
  if (name !== session.name) patch.name = name
  const shell = session.cli_type === 'shell' || session.session_type === 'shell'
  for (const field of shell ? [] : ['model', 'effort', 'permission_mode']) {
    const value = draft[field] ?? ''
    if (value === (session[field] || '')) continue
    if (!options[field]?.some((option) => option.value === value)) throw new Error('Diese Einstellung ist für den Agenten nicht verfügbar.')
    patch[field] = value
  }
  if (Object.keys(patch).some((field) => field !== 'name')) patch.apply_live = true
  return patch
}

export function phoneApplyFeedback(results = {}) {
  const states = Object.values(results).filter(Boolean).map((result) => result.state)
  if (states.some((state) => ['failed', 'error', 'unsupported'].includes(state))) return { tone: 'error', text: 'Gespeichert, aber nicht im laufenden Agenten angewendet. Details prüfen; die bisherige Einstellung kann noch aktiv sein.' }
  if (states.includes('pending')) return { tone: 'pending', text: 'Gespeichert. Wird nach der aktuellen Antwort oder Freigabe angewendet.' }
  if (states.some((state) => ['scheduled', 'applying'].includes(state))) return { tone: 'pending', text: 'Gespeichert. Der Agent startet mit diesen Einstellungen neu.' }
  if (states.includes('saved')) return { tone: 'saved', text: 'Gespeichert. Gilt beim nächsten Start dieser Session.' }
  if (states.length && states.every((state) => state === 'applied' || state === 'none')) return { tone: 'applied', text: 'Der Mac hat die Einstellungen angewendet.' }
  return { tone: 'saved', text: 'Auf dem Mac gespeichert.' }
}

export async function savePhoneSession(api, session, draft, options, access) {
  const reason = phoneControlReason(session, access)
  if (reason) throw new Error(reason)
  const patch = phoneSessionPatch(session, draft, options)
  if (!Object.keys(patch).length) return null
  const updated = await api.updateSession(session.id, patch)
  if (updated?.id !== session.id) throw new Error('Der Mac hat die Änderung nicht bestätigt. Bitte den aktuellen Stand neu laden.')
  return updated
}
