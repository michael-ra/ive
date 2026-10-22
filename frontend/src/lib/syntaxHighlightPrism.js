/**
 * Code-review tokenizer shim.
 *
 * This file intentionally does not import Prism at runtime. Some local installs
 * have package.json entries that are not present in node_modules, and Vite's dev
 * import analysis fails before a dynamic-import fallback can run. Keep the API
 * name stable for callers, but use the repo's built-in tokenizer so dev and
 * production both render instead of crashing on a missing optional highlighter.
 */

import { detectLang, tokenizeLine } from './syntaxHighlight'

export { detectLang }

export function tokenizeLinePrism(code, lang) {
  return tokenizeLine(code, lang)
}

export const TOKEN_CLASSES_PRISM = {
  keyword: 'text-purple-400',
  builtin: 'text-cyan-300',
  constant: 'text-cyan-300',
  function: 'text-yellow-300',
  'function-variable': 'text-yellow-300',
  method: 'text-yellow-300',
  'class-name': 'text-teal-300',
  'maybe-class-name': 'text-teal-300',
  parameter: 'text-orange-300',
  variable: 'text-sky-300',
  property: 'text-sky-200',
  'property-access': 'text-sky-200',
  decorator: 'text-pink-400',

  string: 'text-amber-300',
  'template-string': 'text-amber-300',
  'string-property': 'text-amber-300',
  char: 'text-amber-300',
  number: 'text-orange-300',
  boolean: 'text-cyan-300',
  null: 'text-cyan-300',
  regex: 'text-emerald-300',
  url: 'text-amber-300 underline',

  tag: 'text-rose-300',
  'attr-name': 'text-orange-300',
  'attr-value': 'text-amber-300',
  namespace: 'text-zinc-400',
  doctype: 'text-zinc-500 italic',
  cdata: 'text-zinc-500 italic',
  entity: 'text-cyan-300',

  selector: 'text-rose-300',
  important: 'text-rose-400 font-bold',
  unit: 'text-orange-300',

  comment: 'text-zinc-600 italic',
  'doc-comment': 'text-zinc-500 italic',
  prolog: 'text-zinc-500 italic',

  operator: 'text-zinc-400',
  punctuation: 'text-zinc-500',
  delimiter: 'text-zinc-500',
  inserted: 'text-emerald-400',
  deleted: 'text-rose-400',
  symbol: 'text-cyan-300',
  default: '',
}
