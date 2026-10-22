import HelpDetails from '../ui/HelpDetails'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, Check, Minus, Pause, RotateCcw } from 'lucide-react'
import useStore from '../../state/store'
import { TOUR_STEPS, advanceTour, newTour, pauseTour, readTour, reduceTourEvent, resumeTour, writeTour } from '../../lib/guidedTour'
import FirstLaunchOnboarding from './FirstLaunchOnboarding'
import './interactive-onboarding.css'

const EMPTY = []
const storage = () => { try { return window.localStorage } catch { return null } }
const EXAMPLE = 'Ich lerne IVE kennen. Erkläre kurz, wofür dieses Projekt da ist und wie es gestartet wird. Nutze vorhandene Dateien als Quelle. Ändere keine Dateien.'
const LESSONS = {
  project: ['Dein Projekt verbinden', 'Ein Workspace ist dein Projektordner. Hier liegen die Dateien, mit denen die KI arbeitet.', 'Wähle den Ordner deines Projekts.', 'Sessions, Aufgaben und Ergebnisse bleiben diesem Projekt zugeordnet.'],
  session: ['Dein erster KI-Dialog', 'Eine Session ist ein eigener Arbeitsdialog mit einer KI – etwa Claude oder Codex.', 'Wähle deine KI und klicke auf „Create Session“.', 'Im Overview siehst du die Unterhaltung. Der Terminalblick gehört zur selben Session und zum selben Verlauf.'],
  context: ['Gib der KI Orientierung', 'Kontext sind Informationen, die die KI für deinen Auftrag braucht: Ziel, Grenzen und passende Dateien.', 'Öffne „context“, schreibe deine Notiz und klicke auf „Send context“.', 'Die Notiz wird an genau diese Session gesendet. Projektregeln kannst du hier ebenfalls hinzufügen.'],
  answer: ['Die erste echte Antwort', 'Deine Notiz ist unterwegs. Die Tour wartet auf eine neue Antwort dieser KI-Session.', 'Lies die Antwort im Overview. Offene Freigaben erscheinen in der Session.', 'Eine gesendete Nachricht allein ist noch kein Ergebnis. Bei Problemen helfen der Session-Status und dein KI-Zugang.'],
  overview: ['Zwei Dialoge unterscheiden', 'Jede Session hat ihren eigenen Kontext. Farben und Namen helfen dir, parallele Arbeit auseinanderzuhalten.', 'Erstelle eine zweite Session. Klicke danach im Overview wieder auf „Mein erster Dialog“.', 'Zwischen Sessions wird Kontext nicht automatisch geteilt. Innerhalb einer Session zeigen Overview und Terminal dieselbe Arbeit.'],
  'loop-setup': ['Lass die KI selbst nachbessern', 'Ein Loop ist eine begrenzte Wiederholung: arbeiten → prüfen → bei Problemen korrigieren → erneut prüfen.', 'Öffne den Übungsauftrag, wähle „Maximum cycles“ und starte mit „Prepare plan“.', 'So musst du nicht nach jedem gefundenen Fehler selbst „bitte reparieren“ schreiben. Der Auftrag nutzt deinen KI-Zugang.'],
  'loop-plan': ['Du gibst den Plan frei', 'IVE erstellt einen Plan und lässt ihn prüfen. Erst nach deiner Freigabe beginnt die Umsetzung.', 'Prüfe den Plan. Wenn er passt: „Approve plan & start“.', 'Du kannst vorher eine Überarbeitung verlangen. Prüfe besonders, welche Dateien und Befehle der Plan vorsieht.'],
  'loop-run': ['Beobachte die Prüfung', 'Ein zweiter Agent prüft das Ergebnis. Findet er Probleme, läuft eine Korrekturrunde innerhalb deines Limits.', 'Verfolge Arbeit und Prüfung im Auftrag.', 'Besteht das Ergebnis sofort, ist keine Wiederholung nötig. Das Wiederholungslimit ist kein Zeit- oder Kostenlimit.'],
  review: ['Du nimmst das Ergebnis ab', 'Ein bestandener KI-Check hilft – die abschließende Entscheidung bleibt bei dir.', 'Prüfe Bericht und „Show project changes“. Passt alles? „Accept result“.', 'Bei dieser Analyse sind keine Dateiänderungen beabsichtigt. Bei anderen Aufgaben prüfst du hier die Änderungen und gegebenenfalls die Vorschau.'],
  tools: ['Dein nächstes Werkzeug', 'Unter „Work“ findest du Werkzeuge für deine Arbeit. „Pipelines“ zeigt Abläufe aus mehreren Schritten.', 'Öffne „Work → Pipelines“ und entdecke weitere Abläufe.', 'Der geführte Auftrag nutzt einen vorgegebenen Ablauf. Mit Pipelines kannst du eigene Abläufe gestalten; Know bündelt Wissen und Projektregeln.'],
}

function findTarget(progress) {
  const visible = (selector) => [...document.querySelectorAll(selector)].find((el) => el.getBoundingClientRect().width && el.getBoundingClientRect().height)
  if (progress.step === 'project') return visible('.ive-project-picker input, [data-home-action="find-project"]')
  if (progress.step === 'session' || progress.step === 'overview' && !progress.secondSessionId) return visible('[data-tour="session-setup"]')
  if (progress.step === 'context') return visible('[data-add-context] textarea') || [...document.querySelectorAll('[data-tour="session-context"]')].find((el) => {
    const cell = el.closest('[data-grid-cell-session]')
    return (!cell || cell.dataset.gridCellSession === progress.sessionId) && el.getBoundingClientRect().width
  })
  if (progress.step === 'overview') return [...document.querySelectorAll('[data-grid-cell-session]')].find((el) => el.dataset.gridCellSession === progress.sessionId)
  const selectors = { 'loop-setup': '[data-tour="loop-cycles"]', 'loop-plan': '[data-tour="plan-approve"], [data-tour="loop-status"]', 'loop-run': '[data-tour="loop-status"]', review: progress.inspected ? '[data-tour="result-accept"]' : '[data-tour="result-changes"]', tools: '[data-ia-surface="pipeline-editor"]' }
  return selectors[progress.step] ? visible(selectors[progress.step]) : null
}

function usePlacement(progress, cardRef, minimized) {
  const [placement, setPlacement] = useState({ card: { right: 16, top: 100 }, target: null })
  useLayoutEffect(() => {
    let frame
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = findTarget(progress)?.getBoundingClientRect()
        const width = window.innerWidth, height = window.innerHeight
        const cw = cardRef.current?.offsetWidth || 340, ch = cardRef.current?.offsetHeight || 400
        let left = width - cw - 16, top = 90
        const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
        const anchor = document.querySelector('[data-add-context]')?.getBoundingClientRect() || rect
        if (rect && !dialog) {
          // Prefer the margin next to a dialog. For full-width controls, sit
          // above or below them so the action itself remains clickable.
          if (anchor.left >= cw + 24) { left = anchor.left - cw - 12; top = anchor.top }
          else if (anchor.right + cw + 24 < width) { left = anchor.right + 12; top = anchor.top }
          else top = anchor.top > ch + 24 ? anchor.top - ch - 12 : anchor.bottom + 12
        }
        top = Math.max(12, Math.min(top, height - ch - 12))
        left = Math.max(12, Math.min(left, width - cw - 12))
        const target = rect && rect.bottom > 0 && rect.top < height ? { left: Math.max(2, rect.left - 4), top: Math.max(2, rect.top - 4), width: Math.min(rect.width + 8, width - 4), height: Math.min(rect.height + 8, height - 4) } : null
        const next = { card: { left, top }, target }
        setPlacement((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next)
      })
    }
    const observer = new MutationObserver((records) => {
      if (records.some((r) => !r.target.closest?.('[data-interactive-tour]'))) update()
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'class', 'hidden'] })
    const resize = new ResizeObserver(update)
    if (cardRef.current) resize.observe(cardRef.current)
    window.addEventListener('resize', update); window.addEventListener('scroll', update, true)
    update()
    return () => { observer.disconnect(); resize.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [progress.step, progress.sessionId, progress.secondSessionId, progress.inspected, minimized, cardRef])
  return placement
}

export default function InteractiveOnboarding({ profile, onFinish, onPause, onNavigate }) {
  const [progress, setProgress] = useState(() => resumeTour(readTour(storage(), profile.owner)))
  const [observed, setObserved] = useState(null)
  const [reference, setReference] = useState(false)
  const [minimized, setMinimized] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [storageFailed, setStorageFailed] = useState(false)
  const [missingTarget, setMissingTarget] = useState(false)
  const card = useRef(null), welcome = useRef(null), hint = useRef(null)
  const workspaces = useStore((s) => s.workspaces)
  const sessions = useStore((s) => s.sessions)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const messages = useStore((s) => s.messages[progress.sessionId] || EMPTY)
  const workspace = workspaces.find((ws) => ws.id === progress.workspaceId)
  const placement = usePlacement(progress, card, minimized)
  const step = progress.step
  const lesson = LESSONS[step]
  const go = (destination, detail = {}) => {
    if (window.innerWidth < 1100 && destination !== 'overview') setMinimized(true)
    onNavigate(destination, { workspaceId: progress.workspaceId, sessionId: progress.sessionId, ...detail })
  }

  useEffect(() => {
    const active = !minimized && !reference && step !== 'welcome'
    document.body.classList.toggle('ive-tour-guided', active)
    const focus = (event) => {
      if (window.innerWidth < 1100 && !event.target.closest?.('[data-interactive-tour]') && event.target.matches?.('input, textarea, select')) setMinimized(true)
    }
    window.addEventListener('focusin', focus)
    const keyboard = (event) => {
      if (!active || event.key !== 'Tab') return
      const dialog = document.querySelector('[role="dialog"]')
      if (!dialog || !card.current) return
      const selector = 'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]'
      const items = [...dialog.querySelectorAll(selector), ...card.current.querySelectorAll(selector)].filter((el) => el.getClientRects().length)
      if (!items.length) return
      const index = items.indexOf(document.activeElement)
      event.preventDefault(); event.stopImmediatePropagation()
      items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length].focus()
    }
    window.addEventListener('keydown', keyboard, true)
    return () => { document.body.classList.remove('ive-tour-guided'); window.removeEventListener('focusin', focus); window.removeEventListener('keydown', keyboard, true) }
  }, [minimized, reference, step])

  useEffect(() => { setStorageFailed(!writeTour(storage(), profile.owner, progress)) }, [progress, profile.owner])
  useEffect(() => { if (missingTarget) hint.current?.scrollIntoView({ block: 'nearest' }) }, [missingTarget])
  useEffect(() => { setMissingTarget(false) }, [step])
  useEffect(() => {
    const receive = ({ detail }) => {
      if (!detail?.type) return
      if (detail.type === 'task-state') setObserved(detail)
      setProgress((current) => reduceTourEvent(current, detail))
    }
    window.addEventListener('ive-tour-event', receive)
    return () => window.removeEventListener('ive-tour-event', receive)
  }, [])
  // A single persisted server snapshot may already contain several completed
  // steps after a reload. Reconcile it one step at a time, never invent events.
  useEffect(() => { if (observed) setProgress((current) => reduceTourEvent(current, observed)) }, [observed, step])
  useEffect(() => {
    if (step === 'overview') setProgress((current) => reduceTourEvent(current, { type: 'session-focused', sessionId: activeSessionId }))
  }, [step, activeSessionId, progress.secondSessionId])
  useEffect(() => {
    if (step !== 'answer') return
    const answer = messages.find((message) => {
      if (message.role !== 'assistant' || !message.id || progress.replyBaselineIds?.includes(String(message.id))) return false
      const content = typeof message.content === 'string' ? message.content : (Array.isArray(message.content) ? message.content : []).filter((block) => block.type === 'text').map((block) => block.text || '').join('')
      const date = message.created_at || message.timestamp
      const time = typeof date === 'number' ? (date < 1e12 ? date * 1000 : date) : Date.parse(date)
      return content.trim() && Number.isFinite(time) && time >= (progress.replyAfter || 0) - 2000
    })
    if (answer) setProgress((current) => reduceTourEvent(current, { type: 'assistant-reply', sessionId: progress.sessionId, messageId: String(answer.id) }))
  }, [messages, progress.replyBaselineIds, progress.replyAfter, progress.sessionId, step])
  useEffect(() => {
    if (step !== 'welcome') return
    const previous = document.activeElement, shell = document.querySelector('.x-app-shell')
    const wasInert = shell?.inert
    if (shell) shell.inert = true
    welcome.current?.querySelector('button')?.focus()
    return () => { if (shell) shell.inert = wasInert; if (previous?.isConnected) previous.focus() }
  }, [step])

  const pause = () => {
    writeTour(storage(), profile.owner, pauseTour(progress))
    onPause()
  }
  const skipPart = () => {
    const stop = step === 'project' || step.startsWith('loop-') || step === 'review' ? 'tools' : step === 'tools' ? 'done' : 'loop-setup'
    setProgress((current) => {
      let next = current
      do { next = advanceTour(next, { skip: true }) } while (next.step !== stop && next.step !== 'done')
      return next
    })
  }
  const finish = async (localOnly = false) => {
    setSaving(true); setError('')
    try { await onFinish({ name: profile.name || '', localOnly }) }
    catch (err) { setError(`Der Abschluss konnte nicht gespeichert werden. ${err.message || ''}`) }
    finally { setSaving(false) }
  }
  const openTask = () => go('task', progress.taskId ? { taskId: progress.taskId } : {
    goal: 'Untersuche dieses Projekt: Welche belegten Befehle starten es und prüfen seine Funktion? Erkläre sie mit den zugehörigen Dateipfaden. Ändere keine Dateien.',
    criteria: 'Jeder genannte Befehl hat eine Quelle im Projekt.\nFehlende oder nicht ausgeführte Prüfungen werden ausdrücklich benannt.\nKeine Projektdateien werden verändert.',
    context: 'Dies ist meine erste Übung mit einem IVE-Loop. Antworte verständlich auf Deutsch. Erkläre Fachbegriffe kurz. Führe keine Installation und keine Veröffentlichung aus.',
    maxIterations: 3,
  })
  const live = observed?.workspaceId === progress.workspaceId && (!progress.taskId || observed.taskId === progress.taskId) ? observed : null
  const failed = ['failed', 'cancelled', 'max_iterations'].includes(live?.runStatus)
  const done = step === 'done'

  if (reference) return <FirstLaunchOnboarding profile={profile} onFinish={async () => setReference(false)} onNavigate={(destination) => { setReference(false); onNavigate(destination) }} />
  if (step === 'welcome') return createPortal(<div className="ive-tour-welcome" lang="de" data-interactive-tour data-ive-onboarding>
    <section ref={welcome} role="dialog" aria-modal="true" aria-labelledby="ive-tour-welcome-title" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); pause() }
      if (event.key !== 'Tab') return
      const buttons = [...welcome.current.querySelectorAll('button, summary')].filter(el => el.getClientRects().length), first = buttons[0], last = buttons.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }}>
      <div className="ive-tour-body"><p className="ive-tour-kicker">Willkommen bei IVE</p><h1 id="ive-tour-welcome-title" className="ive-tour-title">Dein Projekt. Dein erster Durchlauf.</h1><p className="ive-tour-description">Verbinde dein Projekt und starte deinen ersten KI-Dialog.</p><p className="ive-tour-benefit">Du nutzt dein eigenes Projekt und KI-Konto. Dabei können Modellkosten entstehen.</p></div>
      <div className="ive-tour-actions"><button className="ive-tour-primary" onClick={() => setProgress(advanceTour(progress))}>Selbst ausprobieren <ArrowRight size={16} /></button><button className="ive-tour-secondary" onClick={pause}>Später</button></div>
    </section>
  </div>, document.body)

  if (minimized) return createPortal(<button data-interactive-tour className="ive-tour-minimized" onClick={() => setMinimized(false)}>Einführung fortsetzen · {done ? 'Abschluss' : `${TOUR_STEPS.indexOf(step) + 1}/${TOUR_STEPS.length}`}</button>, document.body)
  return createPortal(<>
    {placement.target && <div data-interactive-tour className="ive-tour-spotlight" style={placement.target} aria-hidden="true" />}
    <section ref={card} lang="de" data-interactive-tour data-ive-onboarding data-tour-step={step} role="region" aria-label="Interaktive Einführung" className="ive-tour-coach" style={placement.card}>
      <header className="ive-tour-header"><div><p className="ive-tour-progress">{done ? 'Geschafft' : `Schritt ${TOUR_STEPS.indexOf(step) + 1} von ${TOUR_STEPS.length}`}</p></div><button aria-label="Einführung verkleinern" title="Einführung verkleinern" onClick={() => setMinimized(true)}><Minus size={16} /></button></header>
      <div className="ive-tour-body">
        <h2 className="ive-tour-title" aria-live="polite">{done ? 'Dein Weg durch IVE' : lesson[0]}</h2>
        {!done && <><p className="ive-tour-task">{lesson[2]}</p><HelpDetails key={step} label="Mehr dazu"><p>{lesson[1]}</p><p>{lesson[3]}</p></HelpDetails></>}
        {done && <><p className="ive-tour-description">{progress.skipped.length ? 'Du kannst ausgelassene Schritte später nachholen. Hier siehst du, was du tatsächlich ausprobiert hast.' : 'Du hast Projekt, Dialoge und den Weg vom Plan zum geprüften Ergebnis selbst ausprobiert.'}</p><HelpDetails label="Deine Schritte ansehen"><ul className="ive-tour-checklist">{TOUR_STEPS.map((id) => <li key={id} className={`ive-tour-step ${progress.completed.includes(id) ? 'is-complete' : ''}`}><span>{progress.completed.includes(id) ? <Check size={14} aria-label="Erledigt" /> : '–'}</span>{LESSONS[id][0]}{progress.skipped.includes(id) && ' · ausgelassen'}</li>)}</ul></HelpDetails></>}
        {step === 'overview' && progress.secondSessionId && <p className="ive-tour-success">Zweite Session erstellt. Klicke jetzt zurück in deinen ersten Dialog.</p>}
        {step.startsWith('loop-') && <ol className="ive-tour-loop" aria-label="So funktioniert ein Loop">{[['implement', 'Arbeiten'], ['verify', 'Prüfen'], ['fix', 'Bei Fehlern korrigieren']].map(([id, label]) => <li className={`ive-tour-loop-node ${live?.currentStages?.includes(id) ? 'is-current' : ''}`} key={id}>{label}</li>)}</ol>}
        {live && step.startsWith('loop-') && <p className="ive-tour-status" role="status">{live.current?.label || live.runStatus || 'Auftrag wird vorbereitet'}{live.iteration != null && ` · Durchlauf ${live.iteration}`}</p>}
        {failed && <p className="ive-tour-error" role="alert">{live.runStatus === 'max_iterations' ? 'Das Wiederholungslimit ist erreicht.' : live.runStatus === 'cancelled' ? 'Der Ablauf wurde abgebrochen.' : 'Der Ablauf braucht Aufmerksamkeit.'} Das zählt nicht als erfolgreicher Durchlauf. Öffne den Auftrag und prüfe die Berichte.</p>}
        {progress.workspaceId && !workspace && <p className="ive-tour-error">Das gewählte Projekt ist noch nicht geladen oder wurde entfernt. Du kannst die Einführung mit einem anderen Projekt neu beginnen.</p>}
        {progress.sessionId && !sessions[progress.sessionId] && ['context', 'answer', 'overview'].includes(step) && <p className="ive-tour-error">Deine Session ist noch nicht geladen oder wurde entfernt. Beginne bei Bedarf mit einer neuen Session.</p>}
        {missingTarget && step === 'context' && <p ref={hint} className="ive-tour-error" role="status">Der Kontext-Knopf ist gerade nicht zu sehen. Öffne zuerst deine Session mit „Zum Overview“ und versuche es erneut.</p>}
        {storageFailed && <p className="ive-tour-error" role="status">Fortschritt kann in diesem Browser nicht gespeichert werden. Lass die Seite für diese Tour geöffnet.</p>}
        {error && <p className="ive-tour-error" role="alert">{error}</p>}
      </div>
      <div className="ive-tour-actions">
        {step === 'project' && <button className="ive-tour-primary" onClick={() => go('project')}>Projekt auswählen <ArrowRight size={16} /></button>}
        {(step === 'session' || step === 'overview' && !progress.secondSessionId) && <button className="ive-tour-primary" disabled={!workspace} onClick={() => go('session', { name: step === 'session' ? 'Mein erster Dialog' : 'Meine zweite Session' })}>{step === 'session' ? 'Session einrichten' : 'Zweite Session erstellen'}</button>}
        {['context', 'answer', 'overview'].includes(step) && <button className="ive-tour-secondary" disabled={!sessions[progress.sessionId]} onClick={() => go('overview', { sessionId: step === 'overview' ? activeSessionId || progress.sessionId : progress.sessionId })}>Zum Overview</button>}
        {step === 'context' && <button className="ive-tour-secondary" onClick={() => {
          if (!document.querySelector('[data-add-context]')) {
            // Never a silent no-op: say what to do when the button is not on screen.
            const target = findTarget(progress)
            setMissingTarget(!target)
            target?.click()
            return
          }
          window.dispatchEvent(new CustomEvent('ive-tour-context-example', { detail: { sessionId: progress.sessionId, text: EXAMPLE } }))
        }}>{document.querySelector('[data-add-context]') ? 'Beispielnotiz einsetzen' : 'Kontext öffnen'}</button>}
        {['session', 'answer'].includes(step) && <button className="ive-tour-text-button" onClick={() => go('accounts')}>KI-Zugang einrichten</button>}
        {(step.startsWith('loop-') || step === 'review') && <button className="ive-tour-primary" disabled={!workspace} onClick={openTask}>{progress.taskId ? 'Auftrag öffnen' : 'Übungsauftrag öffnen'}</button>}
        {step === 'tools' && <button className="ive-tour-primary" onClick={() => go('tools')}>Work öffnen</button>}
        {done && <button className="ive-tour-primary" disabled={saving} onClick={() => finish()}>{saving ? 'Speichern…' : 'Einführung abschließen'}</button>}
        {error && <button className="ive-tour-secondary" disabled={saving} onClick={() => finish(true)}>Nur hier abschließen</button>}
        {failed && <button className="ive-tour-secondary" onClick={() => { setObserved(null); setProgress((value) => ({ ...value, step: 'loop-setup', taskId: null, runId: null, cyclesChosen: false, inspected: false })) }}>Neue Loop-Übung</button>}
      </div>
      <footer className="ive-tour-footer">
        <button className="ive-tour-text-button" onClick={pause}><Pause size={12} /> Pausieren</button>
        {!done && <button className="ive-tour-text-button" onClick={skipPart}>Diesen Teil auslassen</button>}
        <button className="ive-tour-reference" onClick={() => setReference(true)}>Begriffe & Werkzeuge</button>
        {(done || progress.workspaceId && !workspace || progress.sessionId && !sessions[progress.sessionId]) && <button className="ive-tour-text-button" onClick={() => { setObserved(null); setProgress(newTour()) }}><RotateCcw size={12} /> Neu beginnen</button>}
        {live?.runStatus === 'running' && <span>Tour pausieren beendet keinen laufenden Auftrag.</span>}
      </footer>
    </section>
  </>, document.body)
}
