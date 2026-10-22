// UI language for the shell and the three screens. Keys are '<namespace>.<key>';
// each screen registers its own dictionary (lib/i18n/<ns>.js). A key missing
// in the current language falls back to English, then to the key itself, so
// a half-translated dictionary never shows an empty label. Existing panels and
// dialogs stay English; only new surfaces call t().
import * as React from 'react'

export const LANGUAGES = ['en', 'de']
export const LANGUAGE_STORAGE_KEY = 'ive.ui-language'
export const LANGUAGE_EVENT = 'ive-language-change'
export const LANGUAGE_SETTING_KEY = 'ui_language'

const dictionaries = { en: {}, de: {} }
const listeners = new Set()

function normalizeLanguage(value) {
  const lang = String(value || '').toLowerCase().slice(0, 2)
  return LANGUAGES.includes(lang) ? lang : null
}

function readStored() {
  try {
    return normalizeLanguage(globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY))
  } catch {
    return null
  }
}

let current = readStored() || 'en'

export function getLanguage() {
  return current
}

function notify() {
  for (const fn of [...listeners]) {
    try { fn(current) } catch { /* one listener must not stop the others */ }
  }
  try { globalThis.window?.dispatchEvent?.(new CustomEvent(LANGUAGE_EVENT, { detail: { language: current } })) } catch { /* no DOM */ }
}

// Sets the language for this browser and, by default, as the app setting so
// every device of this IVE reads the same choice at start (loadLanguageSetting).
export function setLanguage(lang, { persistRemote = true } = {}) {
  const next = normalizeLanguage(lang)
  if (!next) return current
  try { globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, next) } catch { /* privacy mode */ }
  if (persistRemote) {
    import('./api.js')
      .then(({ api }) => api.setAppSetting(LANGUAGE_SETTING_KEY, next))
      .catch(() => { /* the local choice still applies; the next start retries */ })
  }
  if (next === current) return current
  current = next
  notify()
  return current
}

export function subscribeLanguage(fn) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// Start: the app setting wins, then localStorage, then English.
export async function loadLanguageSetting() {
  try {
    const { api } = await import('./api.js')
    const res = await api.getAppSetting(LANGUAGE_SETTING_KEY)
    const remote = normalizeLanguage(res?.value)
    if (remote) return setLanguage(remote, { persistRemote: false })
  } catch { /* offline or old backend: keep the local choice */ }
  return current
}

export function registerDictionary(namespace, { en = {}, de = {} } = {}) {
  const ns = String(namespace || '').trim()
  if (!ns) return
  for (const [lang, table] of [['en', en], ['de', de]]) {
    for (const [key, value] of Object.entries(table || {})) dictionaries[lang][`${ns}.${key}`] = value
  }
  notify()
}

function interpolate(template, vars) {
  if (typeof template === 'function') return template(vars)
  return String(template).replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))
}

export function t(key, vars = {}) {
  const table = dictionaries[current] || dictionaries.en
  const value = Object.hasOwn(table, key) ? table[key]
    : Object.hasOwn(dictionaries.en, key) ? dictionaries.en[key]
    : key
  return interpolate(value, vars || {})
}

// Re-renders the component when the language (or a dictionary) changes.
export function useT() {
  React.useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage)
  return t
}
