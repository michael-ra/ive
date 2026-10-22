// Shell vocabulary: sidebar, header, footer, status words and details, times,
// settings. The five status words are product vocabulary and stay English in
// every language (e2e checks the words); their details are translated.
import { registerDictionary } from '../i18n.js'

registerDictionary('nav', {
  en: {
    work: 'Work', projects: 'Projects', setup: 'Set up',
    home: 'Home', board: 'Board', review: 'Review', knowledge: 'Knowledge',
    settings: 'Settings', connectors: 'Connectors', phone: 'Phone',
    search: 'Search', searchCommands: 'Search commands', newSession: 'New session', newChat: 'New chat', addProject: 'Add project', projectTools: 'Project tools', withoutProject: 'Without project',
    filterSessions: 'Filter sessions by name or model',
  },
  de: {
    work: 'Arbeiten', projects: 'Projekte', setup: 'Einrichten',
    home: 'Home', board: 'Board', review: 'Review', knowledge: 'Wissen',
    settings: 'Einstellungen', connectors: 'Verbindungen', phone: 'Handy',
    search: 'Suchen', searchCommands: 'Befehle suchen', newSession: 'Neue Session', newChat: 'Neuer Chat', addProject: 'Projekt hinzufügen', projectTools: 'Projektwerkzeuge', withoutProject: 'Ohne Projekt',
    filterSessions: 'Sessions nach Name oder Modell filtern',
  },
})

registerDictionary('header', {
  en: {
    new: 'New', search: 'Search commands', sideChat: 'Chat with Claude', settings: 'Settings',
    newSession: 'Create a new session', hideSidebar: 'Hide sidebar', showSidebar: 'Show sidebar',
    home: 'Home', board: 'Board', terminal: 'Terminal', toHide: 'to hide',
    expandTerminal: 'Expand terminal', restoreTerminal: 'Restore small terminal', hideTerminal: 'Hide terminal — show overview',
  },
  de: {
    new: 'Neu', search: 'Befehle suchen', sideChat: 'Mit Claude chatten', settings: 'Einstellungen',
    newSession: 'Neue Session anlegen', hideSidebar: 'Seitenleiste ausblenden', showSidebar: 'Seitenleiste einblenden',
    home: 'Home', board: 'Board', terminal: 'Terminal', toHide: 'zum Ausblenden',
    expandTerminal: 'Terminal vergrößern', restoreTerminal: 'Kleines Terminal wiederherstellen', hideTerminal: 'Terminal ausblenden — nur Übersicht',
  },
})

registerDictionary('foot', {
  en: { connected: 'Connected', reconnecting: 'Reconnecting', today: 'today', share: 'Share session', reconnectingLong: 'Reconnecting to IVE…' },
  de: { connected: 'Verbunden', reconnecting: 'Verbinde neu', today: 'heute', share: 'Session teilen', reconnectingLong: 'Verbindung zu IVE wird neu aufgebaut…' },
})

registerDictionary('status', {
  en: {
    running: 'Running', waiting: 'Waiting', done: 'Done', failed: 'Failed', stopped: 'Stopped',
    replaying: 'Replaying', notStarted: 'Not started', stoppedByYou: 'Stopped by you',
    loginExpired: 'Login expired', cliExited: 'CLI exited', cliExitedCode: 'CLI exited ({code})',
    lastTurnFailed: 'Last turn failed', needsAnswer: 'Needs your answer', answered: 'Answered',
    filesChanged: '{n} files changed', fileChanged: '1 file changed',
  },
  de: {
    // Product words stay English on purpose.
    running: 'Running', waiting: 'Waiting', done: 'Done', failed: 'Failed', stopped: 'Stopped',
    replaying: 'Wiedergabe', notStarted: 'Nicht gestartet', stoppedByYou: 'Von dir gestoppt',
    loginExpired: 'Login abgelaufen', cliExited: 'CLI beendet', cliExitedCode: 'CLI beendet ({code})',
    lastTurnFailed: 'Letzter Durchlauf fehlgeschlagen', needsAnswer: 'Braucht deine Antwort', answered: 'Beantwortet',
    filesChanged: '{n} Dateien geändert', fileChanged: '1 Datei geändert',
  },
})

registerDictionary('activity', {
  en: {
    run: 'Run {command}?', editing: 'Editing {target}', reading: 'Reading {target}', running: 'Running {target}',
    searching: 'Searching {target}', fetching: 'Fetching {target}', delegating: 'Delegating: {target}', using: '{tool} {target}',
  },
  de: {
    run: '{command} ausführen?', editing: 'Bearbeitet {target}', reading: 'Liest {target}', running: 'Führt aus: {target}',
    searching: 'Sucht {target}', fetching: 'Lädt {target}', delegating: 'Delegiert: {target}', using: '{tool} {target}',
  },
})

registerDictionary('time', {
  en: { now: 'now', seconds: '{n} s ago', minutes: '{n} min ago', hours: '{n} h ago', days: '{n} d ago', runtimeSeconds: '{n} s', runtimeMinutes: '{n} min', runtimeHours: '{h} h', runtimeHoursMinutes: '{h} h {m} min' },
  de: { now: 'jetzt', seconds: 'vor {n} s', minutes: 'vor {n} min', hours: 'vor {n} h', days: 'vor {n} d', runtimeSeconds: '{n} s', runtimeMinutes: '{n} min', runtimeHours: '{h} h', runtimeHoursMinutes: '{h} h {m} min' },
})

registerDictionary('settings', {
  en: { language: 'Language', languageHint: 'Sidebar, header, status details and the three screens. Panels stay English.', en: 'English', de: 'Deutsch' },
  de: { language: 'Sprache', languageHint: 'Seitenleiste, Kopfzeile, Statusdetails und die drei Bildschirme. Panels bleiben Englisch.', en: 'English', de: 'Deutsch' },
})
