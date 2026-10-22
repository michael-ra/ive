import HelpDetails from '../ui/HelpDetails'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, Check, ChevronRight, CircleHelp, ClipboardCheck, FolderOpen, KeyRound, Loader2, MessageSquare, Search, X } from 'lucide-react'
import { IA_GROUPS } from '../../lib/informationArchitecture'
import { isSurfaceAvailable } from '../../lib/extensionRegistry'
import { GUIDE_GLOSSARY, GUIDE_STEPS, TOOL_EXPLANATIONS } from './guideContent'
import './onboarding.css'

const WORKFLOW = ['Projekt', 'Aufgabe', 'Plan', 'Arbeit', 'Prüfung']
const EXAMPLES = [
  { label: 'Oberfläche verbessern', goal: 'Verbessere das Kontaktformular auf meiner Website.', criteria: 'Auf dem Handy gut bedienbar. Verständliche Fehlermeldungen. Vorhandener Versand funktioniert weiter.' },
  { label: 'Fehler beheben', goal: 'Finde heraus, warum die Suche keine Ergebnisse mehr zeigt.', criteria: 'Ursache erklären. Fehler beheben. Mit passenden Suchbegriffen überprüfen.' },
]

function Workflow({ current = -1 }) {
  return <ol className="ive-guide-workflow" aria-label="Der Weg durch einen Auftrag">
    {WORKFLOW.map((label, index) => <li key={label} data-active={index === current}>
      <span>{index < current ? <Check size={14} /> : index + 1}</span><strong>{label}</strong>
    </li>)}
  </ol>
}

function ExampleFrame({ label, children }) {
  return <div className="ive-guide-example"><div className="ive-guide-example-label">{label}<span>Beispiel</span></div>{children}</div>
}

function GuidePreview({ step }) {
  const [example, setExample] = useState(0)
  const [session, setSession] = useState(0)
  const current = EXAMPLES[example]
  if (step === 'welcome') return <div className="ive-guide-map">
    <span className="ive-guide-wordmark">IVE<span /></span>
    <p>Ein Ort für dein Projekt.<br />Ein klarer Weg zum Ergebnis.</p>
    <Workflow />
    <dl className="ive-guide-glossary">
      <div><dt>Workspace</dt><dd>Dein Projektordner</dd></div>
      <div><dt>Session</dt><dd>Ein Arbeitsdialog</dd></div>
      <div><dt>Agent</dt><dd>Dein KI-Assistent</dd></div>
    </dl>
  </div>
  if (step === 'project') return <>
    <Workflow current={0} />
    <ExampleFrame label="Projects & sessions">
      <div className="ive-guide-project"><FolderOpen size={23} /><div><strong>Meine Website</strong><span>Projekte / meine-website</span></div></div>
      <div className="ive-guide-file-tree"><span>src /</span><span>public /</span><span>README.md</span></div>
      <div className="ive-guide-example-note"><MessageSquare size={16} /><span>Sessions und Aufgaben bleiben diesem Projekt zugeordnet.</span></div>
    </ExampleFrame>
    <p className="ive-guide-location">Zu finden: <strong>Startseite → Find project</strong></p>
  </>
  if (step === 'access') return <div className="ive-guide-access">
    <KeyRound size={30} strokeWidth={1.5} />
    <h3>Einmal verbinden.<br />Dann im Projekt arbeiten.</h3>
    <ol className="ive-guide-route">
      <li><span>1</span><div><strong>Configure</strong><p>Einrichtung öffnen</p></div></li>
      <li><span>2</span><div><strong>Connectors</strong><p>Passendes KI-Konto einrichten</p></div></li>
      <li><span>3</span><div><strong>Model Providers</strong><p>Anbieter und Modell prüfen</p></div></li>
    </ol>
    <p className="ive-guide-example-note">Schon eingerichtet? Dann kannst du direkt zum nächsten Kapitel gehen.</p>
  </div>
  if (step === 'context') return <>
    <Workflow current={1} />
    <ExampleFrame label="Kontext für diese Session">
      <div className="ive-guide-criteria ive-guide-context-example"><strong>Ziel</strong><p>Das Kontaktformular soll auf dem Handy leichter bedienbar sein.</p></div>
      <div className="ive-guide-criteria"><strong>Beachten</strong><p>Bestehende Felder und den Versand beibehalten. Orientierung: src/components/ContactForm.jsx.</p></div>
      <div className="ive-guide-example-note"><MessageSquare size={17} /><span>Diese Notiz gehört zum gewählten Dialog. Gib sie einer zweiten Session bei Bedarf ebenfalls mit.</span></div>
    </ExampleFrame>
    <p className="ive-guide-location">Zu finden: <strong>Session → context</strong>. Im geführten Auftrag: <strong>Context & execution settings</strong>.</p>
  </>
  if (step === 'automation') return <>
    <Workflow current={3} />
    <ExampleFrame label="Geführte Aufgabe">
      <ol className="ive-guide-review-list">
        <li><span>1</span><div><strong>Du prüfst den Plan</strong><p>Erst mit „Approve plan & start“ beginnt die Umsetzung.</p></div></li>
        <li><span>2</span><div><strong>Agent setzt um → Testagent prüft</strong><p>Fehlgeschlagene Prüfungen gehen zurück zur Überarbeitung.</p></div></li>
        <li><span>3</span><div><strong>Du prüfst das Ergebnis</strong><p>Berichte, Änderungen und deine ursprünglichen Kriterien abgleichen.</p></div></li>
      </ol>
      <div className="ive-guide-example-note"><ClipboardCheck size={17} /><span>Bei erreichten Grenzen oder Fehlern den Bericht prüfen und bewusst über den nächsten Lauf entscheiden.</span></div>
    </ExampleFrame>
    <p className="ive-guide-location">Zu finden: <strong>Home → Start a task</strong>. Eigene Abläufe: <strong>Work → Pipelines</strong>.</p>
  </>
  if (step === 'task') return <>
    <Workflow current={2} />
    <div className="ive-guide-switch" role="group" aria-label="Aufgabenbeispiel">
      {EXAMPLES.map((item, index) => <button key={item.label} type="button" aria-pressed={example === index} onClick={() => setExample(index)}>{item.label}</button>)}
    </div>
    <ExampleFrame label="Your request">
      <p className="ive-guide-example-goal">{current.goal}</p>
      <div className="ive-guide-criteria"><strong>Acceptance criteria</strong><p>{current.criteria}</p></div>
      <div className="ive-guide-example-note"><ClipboardCheck size={17} /><span>Erst den Plan lesen, dann die Umsetzung freigeben.</span></div>
    </ExampleFrame>
    <p className="ive-guide-location">Dieses Beispiel startet keine Aufgabe.</p>
  </>
  if (step === 'sessions') return <>
    <Workflow current={3} />
    <ExampleFrame label="Sessions">
      <div className="ive-guide-switch ive-guide-session-tabs" role="group" aria-label="Beispiel-Sessions">
        {['Formular verbessern', 'Suche reparieren'].map((label, index) => <button key={label} type="button" aria-pressed={session === index} onClick={() => setSession(index)}><MessageSquare size={14} />{label}</button>)}
      </div>
      <div className="ive-guide-dialogue">
        <span>Du</span><p>{EXAMPLES[session].goal}</p>
        <span>KI-Assistent</span><p>{session === 0 ? 'Soll das Formular weiterhin dieselben Felder enthalten?' : 'Bei welchem Suchbegriff tritt der Fehler auf?'}</p>
        <div className="ive-guide-waiting">Wartet auf deine Antwort</div>
      </div>
    </ExampleFrame>
    <p className="ive-guide-location">Probiere oben den Wechsel zwischen zwei Beispiel-Sessions.</p>
  </>
  if (step === 'review') return <>
    <Workflow current={4} />
    <ExampleFrame label="Deine Ergebnisprüfung">
      <ul className="ive-guide-review-list">
        <li><span>1</span><div><strong>Entspricht es meinem Ziel?</strong><p>Ergebnis und Vorschau ansehen</p></div></li>
        <li><span>2</span><div><strong>Was wurde verändert?</strong><p>Dateien und Änderungen durchgehen</p></div></li>
        <li><span>3</span><div><strong>Was wurde überprüft?</strong><p>Testberichte und offene Punkte lesen</p></div></li>
      </ul>
      <div className="ive-guide-example-note"><MessageSquare size={17} /><span>„Die Fehlermeldung ist noch unklar. Bitte zeige direkt am Feld, was fehlt.“</span></div>
    </ExampleFrame>
    <p className="ive-guide-location">Konkretes Feedback wird zur nächsten überprüfbaren Aufgabe.</p>
  </>
  return null
}

function ToolExplorer({ onOpen, disabled }) {
  const [groupId, setGroupId] = useState('work')
  const [query, setQuery] = useState('')
  const group = IA_GROUPS.find((item) => item.id === groupId)
  const groups = query.trim() ? IA_GROUPS : group ? [group] : []
  const normalizedQuery = query.trim().toLocaleLowerCase('de')
  const matches = groups.flatMap((item) => item.surfaces
    .filter((surface) => isSurfaceAvailable(surface.id))
    .map((surface) => ({ ...surface, group: item.label, explanation: TOOL_EXPLANATIONS[surface.id] || surface.description })))
    .filter((item) => `${item.label} ${item.explanation}`.toLocaleLowerCase('de').includes(normalizedQuery))
  const terms = (normalizedQuery || groupId === 'terms' ? GUIDE_GLOSSARY : [])
    .filter((item) => (!item.surface || isSurfaceAvailable(item.surface)) && `${item.term} ${item.explanation}`.toLocaleLowerCase('de').includes(normalizedQuery))
  return <div className="ive-guide-tools">
    <div className="ive-guide-switch" role="group" aria-label="Werkzeugbereiche">
      {IA_GROUPS.map((item) => <button key={item.id} type="button" aria-pressed={groupId === item.id && !query} onClick={() => { setGroupId(item.id); setQuery('') }}>{item.label}</button>)}
      <button type="button" aria-pressed={groupId === 'terms' && !query} onClick={() => { setGroupId('terms'); setQuery('') }}>Begriffe</button>
    </div>
    <label className="ive-guide-search"><Search size={17} /><input type="search" aria-label="Funktionen in der Einführung suchen" placeholder="Was möchtest du finden?" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="ive-guide-tool-list" tabIndex={0} role="region" aria-label="Verfügbare Funktionen">
      {matches.map((item) => <div key={item.id}><div className="ive-guide-tool-heading"><strong>{item.label}</strong>{query && <small>{item.group}</small>}<button type="button" disabled={disabled} onClick={() => onOpen(`surface:${item.id}`)} aria-label={`${item.label} öffnen`}>Öffnen <ArrowRight size={13} /></button></div><p>{item.explanation}</p></div>)}
      {terms.map((item) => <div key={item.term}><strong>{item.term}</strong><small>Begriff</small><p>{item.explanation}</p></div>)}
      {!matches.length && !terms.length && <p className="ive-guide-empty">Keine passende Funktion gefunden. Versuche zum Beispiel „Kontext“, „Recherche“ oder „Aufgaben“.</p>}
    </div>
    <p className="ive-guide-location">„Öffnen“ bringt dich direkt zum Werkzeug. Die Einführung findest du jederzeit in Quick help (?) wieder.</p>
  </div>
}

export default function FirstLaunchOnboarding({ profile, onFinish, onNavigate }) {
  const [index, setIndex] = useState(0)
  const [name, setName] = useState(profile.name)
  const [nameEdited, setNameEdited] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)
  const [destination, setDestination] = useState(profile.owner ? 'project' : 'home')
  const panelRef = useRef(null)
  const chaptersRef = useRef(null)
  const headingRef = useRef(null)
  const bodyRef = useRef(null)
  const busyRef = useRef(false)
  const step = GUIDE_STEPS[index]
  const last = index === GUIDE_STEPS.length - 1

  useEffect(() => { if (!nameEdited) setName(profile.name) }, [profile.name, nameEdited])
  useEffect(() => {
    const previous = document.activeElement
    const app = document.querySelector('.x-app-shell')
    const wasInert = app?.inert
    if (app) app.inert = true
    return () => {
      if (app) app.inert = wasInert
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  const showChapter = () => {
    headingRef.current?.focus()
    if (bodyRef.current) bodyRef.current.scrollTop = 0
    chaptersRef.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  useEffect(showChapter, [index])
  // Choosing a chapter always moves focus to its heading, also when it is the
  // chapter already shown. Otherwise focus stays on the chapter strip, which on
  // narrow screens sits above a scrolled body and screen readers announce nothing.
  const openChapter = (chapter) => {
    setError(false)
    if (chapter === index) showChapter()
    else setIndex(chapter)
  }

  const finish = async (action = null, localOnly = false) => {
    if (busyRef.current) return
    busyRef.current = true
    setSaving(true)
    setError(false)
    setPendingAction(action)
    try {
      await onFinish({ name, skip: action === null, localOnly })
      if (action) onNavigate(action)
    } catch {
      setError(true)
    } finally {
      busyRef.current = false
      setSaving(false)
    }
  }

  const handleKeyDown = (event) => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); finish(); return }
    if (event.key !== 'Tab') return
    const elements = [...panelRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]')].filter((element) => element.getClientRects().length)
    const first = elements[0], lastElement = elements.at(-1)
    if (!first) { event.preventDefault(); return }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === headingRef.current)) { event.preventDefault(); lastElement.focus() }
    else if (!event.shiftKey && document.activeElement === lastElement) { event.preventDefault(); first.focus() }
  }

  return createPortal(
    <div className="ive-guide-backdrop" lang="de" data-ive-onboarding onKeyDown={handleKeyDown}>
      <section ref={panelRef} className="ive-guide" role="dialog" aria-modal="true" aria-labelledby="ive-guide-title" aria-describedby="ive-guide-description" aria-busy={saving}>
        <header className="ive-guide-header">
          <div><CircleHelp size={19} /><span>IVE kennenlernen</span></div>
          <button type="button" className="ive-guide-icon-button" aria-label="Einführung schließen" onClick={() => finish()} disabled={saving}><X size={20} /></button>
        </header>
        <div className="ive-guide-layout">
          <nav ref={chaptersRef} className="ive-guide-chapters" aria-label="Kapitel der Einführung">
            {GUIDE_STEPS.map((item, chapter) => <button key={item.id} type="button" aria-current={index === chapter ? 'step' : undefined} disabled={saving} onClick={() => openChapter(chapter)}><span>{chapter + 1}</span>{item.label}<ChevronRight size={14} /></button>)}
          </nav>
          <div ref={bodyRef} className="ive-guide-body" data-guide-step={step.id}>
            <div className="ive-guide-copy">
              <span className="ive-guide-eyebrow">{step.eyebrow}</span>
              <h1 id="ive-guide-title" ref={headingRef} tabIndex={-1}>{step.title}</h1>
              <p id="ive-guide-description" className="ive-guide-intro">{step.text}</p>
              {step.id === 'welcome' && <div className="ive-guide-topic-links" aria-label="Wichtige Einstiegsthemen">{[
                ['project', 'Projekt verbinden'], ['context', 'Kontext verstehen'], ['automation', 'Automatisch prüfen'],
              ].map(([id, label]) => <button key={id} type="button" disabled={saving} onClick={() => openChapter(GUIDE_STEPS.findIndex((chapter) => chapter.id === id))}>{label}<ArrowRight size={15} /></button>)}</div>}
              {step.id === 'welcome' && profile.owner && <label className="ive-guide-name">Wie darf IVE dich nennen? <span>Optional</span><input value={name} onChange={(event) => { setNameEdited(true); setName(event.target.value) }} maxLength={64} placeholder="Dein Name" autoComplete="given-name" disabled={saving} /><small>Wird in Begrüßungen und für Personen angezeigt, mit denen du deinen Workspace teilst.</small></label>}
              {step.id === 'welcome' && profile.known && !profile.owner && <p className="ive-guide-guest">Du nutzt einen geteilten Zugang. Welche Funktionen du verwenden kannst, hängt von deinen freigegebenen Rechten ab.</p>}
              {step.points && <HelpDetails key={step.id} label="Mehr dazu"><dl className="ive-guide-points">{step.points.map(([title, text]) => <div key={title}><dt>{title}</dt><dd>{text}</dd></div>)}</dl></HelpDetails>}
              {step.actions && <div className="ive-guide-actions">{step.actions.filter((action) =>
                (profile.owner || !['project', 'task', 'surface:connectors'].includes(action.destination)) &&
                (!action.destination.startsWith('surface:') || isSurfaceAvailable(action.destination.slice(8))) &&
                (action.destination !== 'task' || isSurfaceAvailable('pipeline-editor'))
              ).map((action) => <button key={action.destination} type="button" disabled={saving} onClick={() => finish(action.destination)}>{action.label}<ArrowRight size={15} /></button>)}</div>}
              <HelpDetails key={`${step.id}-tip`} label="Tipp"><p>{step.hint}</p></HelpDetails>
            </div>
            <div className="ive-guide-visual">
              {step.id === 'tools' ? <ToolExplorer onOpen={finish} disabled={saving} /> : last ? <>
                <Workflow current={0} />
                <fieldset className="ive-guide-destinations" disabled={saving}>
                  <legend>Wo möchtest du weitermachen?</legend>
                  {[
                    ...(profile.owner ? [{ id: 'project', icon: FolderOpen, title: 'Projekt auswählen', text: 'Einen Projektordner finden und verbinden.' }, { id: 'accounts', icon: KeyRound, title: 'KI-Zugang einrichten', text: 'Zuerst Konten und Anmeldung prüfen.' }] : []),
                    { id: 'home', icon: ArrowRight, title: 'Zur Übersicht', text: 'IVE in deinem eigenen Tempo erkunden.' },
                  ].map(({ id, icon: Icon, title, text }) => <label key={id} data-selected={destination === id}><input type="radio" name="ive-guide-destination" value={id} checked={destination === id} onChange={() => setDestination(id)} /><Icon size={21} /><span><strong>{title}</strong><small>{text}</small></span></label>)}
                </fieldset>
              </> : <GuidePreview step={step.id} />}
            </div>
          </div>
        </div>
        {error && <div className="ive-guide-error" role="alert"><p>Dein Fortschritt konnte nicht gespeichert werden. Versuche es erneut oder schließe die Einführung nur für diesen Browser. Ein noch nicht gespeicherter Name wird dabei nicht übernommen.</p><div><button type="button" onClick={() => finish(pendingAction)}>Erneut versuchen</button><button type="button" onClick={() => finish(pendingAction, true)}>Nur hier schließen</button></div></div>}
        <footer className="ive-guide-footer">
          <button type="button" className="ive-guide-skip" disabled={saving} onClick={() => finish()}>Später ansehen</button>
          <span className="ive-guide-progress" aria-live="polite">{index + 1} / {GUIDE_STEPS.length}</span>
          <div>
            {index > 0 && <button type="button" className="ive-guide-back" disabled={saving} onClick={() => { setIndex(index - 1); setError(false) }}><ArrowLeft size={16} /><span>Zurück</span></button>}
            <button type="button" className="ive-guide-next" disabled={saving} onClick={() => last ? finish(destination) : setIndex(index + 1)}>{saving ? <Loader2 size={17} className="animate-spin" /> : null}{last ? 'Einführung abschließen' : index === 0 ? 'IVE entdecken' : 'Weiter'}{!saving && <ArrowRight size={16} />}</button>
          </div>
        </footer>
      </section>
    </div>, document.body,
  )
}
