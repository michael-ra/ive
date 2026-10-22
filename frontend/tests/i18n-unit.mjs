// UI language: English by default, German on request, fallbacks per key,
// placeholders, subscriptions and the stored choice.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const values = new Map()
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
}
const { LANGUAGES, LANGUAGE_STORAGE_KEY, getLanguage, setLanguage, subscribeLanguage, registerDictionary, t } = await import('../src/lib/i18n.js')
await import('../src/lib/i18n/shell.js')

test('English is the default and the shell dictionary is registered', () => {
  assert.deepEqual(LANGUAGES, ['en', 'de'])
  assert.equal(getLanguage(), 'en')
  assert.equal(t('nav.work'), 'Work')
  assert.equal(t('nav.setup'), 'Set up')
  assert.equal(t('foot.connected'), 'Connected')
  assert.equal(t('status.running'), 'Running')
})

test('missing keys fall back de → en → key, placeholders are filled', () => {
  registerDictionary('demo', { en: { hello: 'Hello {name}', onlyEn: 'English only' }, de: { hello: 'Hallo {name}' } })
  assert.equal(t('demo.hello', { name: 'Max' }), 'Hello Max')
  assert.equal(t('demo.missing'), 'demo.missing')
  const seen = []
  const unsubscribe = subscribeLanguage((lang) => seen.push(lang))
  assert.equal(setLanguage('de', { persistRemote: false }), 'de')
  try {
    assert.equal(getLanguage(), 'de')
    assert.deepEqual(seen, ['de'])
    assert.equal(values.get(LANGUAGE_STORAGE_KEY), 'de')
    assert.equal(t('demo.hello', { name: 'Max' }), 'Hallo Max')
    assert.equal(t('demo.onlyEn'), 'English only')
    assert.equal(t('nav.work'), 'Arbeiten')
    assert.equal(t('status.waiting'), 'Waiting', 'product words stay English')
    assert.equal(t('status.stoppedByYou'), 'Von dir gestoppt')
    assert.equal(t('time.minutes', { n: 3 }), 'vor 3 min')
    assert.equal(setLanguage('de', { persistRemote: false }), 'de')
    assert.deepEqual(seen, ['de'], 'no event when nothing changed')
    assert.equal(setLanguage('fr', { persistRemote: false }), 'de', 'unknown languages are ignored')
  } finally {
    unsubscribe()
    setLanguage('en', { persistRemote: false })
  }
  assert.equal(getLanguage(), 'en')
  assert.deepEqual(seen, ['de'])
})

test('every shell key exists in both languages', async () => {
  // Reads the source: both tables must list the same keys so a German UI
  // never silently shows English where a translation was forgotten.
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../src/lib/i18n/shell.js', import.meta.url), 'utf8')
  const blocks = [...source.matchAll(/registerDictionary\('(\w+)', \{\s*en: \{([\s\S]*?)\},\s*de: \{([\s\S]*?)\},\s*\}\)/g)]
  assert.ok(blocks.length >= 6, 'nav, header, foot, status, activity, time, settings')
  const keysOf = (body) => [...body.replace(/'(?:[^'\\]|\\.)*'/g, "''").matchAll(/(?:^|[\s{,])(\w+):/g)].map((m) => m[1]).sort()
  for (const [, ns, en, de] of blocks) assert.deepEqual(keysOf(de), keysOf(en), ns)
})
