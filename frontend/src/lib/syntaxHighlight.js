/**
 * Lightweight syntax tokenizer for diff code lines.
 * Returns array of { text, type } spans for rendering with CSS classes.
 * Types: 'keyword', 'string', 'comment', 'number', 'punctuation', 'default'
 */

const LANG_MAP = {
  js: 'js', jsx: 'js', ts: 'js', tsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', pyw: 'py',
  go: 'go',
  rs: 'rs',
  java: 'java', kt: 'java', scala: 'java',
  rb: 'rb',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  md: 'md', mdx: 'md',
  sql: 'sql',
  c: 'c', cpp: 'c', h: 'c', hpp: 'c',
}

const KEYWORDS = {
  js: new Set('abstract async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while with yield'.split(' ')),
  py: new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self'.split(' ')),
  go: new Set('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil'.split(' ')),
  rs: new Set('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(' ')),
  java: new Set('abstract assert boolean break byte case catch char class const continue default do double else enum extends false final finally float for goto if implements import instanceof int interface long native new null package private protected public return short static strictfp super switch synchronized this throw throws transient true try void volatile while'.split(' ')),
  rb: new Set('BEGIN END alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield'.split(' ')),
  sh: new Set('if then else elif fi case esac for while until do done in function return exit local export source true false'.split(' ')),
  sql: new Set('SELECT FROM WHERE AND OR NOT NULL IN IS AS ON JOIN LEFT RIGHT INNER OUTER FULL CROSS CREATE TABLE INSERT INTO VALUES UPDATE SET DELETE DROP ALTER ADD INDEX DISTINCT ORDER BY GROUP HAVING LIMIT OFFSET UNION ALL EXISTS BETWEEN LIKE COUNT SUM AVG MIN MAX'.split(' ')),
  c: new Set('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while true false NULL nullptr'.split(' ')),
}

// Comment styles per language
const COMMENT_STYLES = {
  js: { line: '//', block: ['/*', '*/'] },
  py: { line: '#' },
  go: { line: '//', block: ['/*', '*/'] },
  rs: { line: '//', block: ['/*', '*/'] },
  java: { line: '//', block: ['/*', '*/'] },
  rb: { line: '#' },
  css: { block: ['/*', '*/'] },
  sh: { line: '#' },
  sql: { line: '--', block: ['/*', '*/'] },
  c: { line: '//', block: ['/*', '*/'] },
  yaml: { line: '#' },
  toml: { line: '#' },
}

/**
 * Detect language from file path extension.
 */
export function detectLang(filePath) {
  if (!filePath) return null
  const ext = filePath.split('.').pop()?.toLowerCase()
  return LANG_MAP[ext] || null
}

/**
 * Tokenize a single line of code into styled spans.
 * @param {string} code - The code text (without diff prefix)
 * @param {string|null} lang - Language key from detectLang()
 * @returns {Array<{text: string, type: string}>}
 */
export function tokenizeLine(code, lang) {
  if (!code || !lang) return [{ text: code || '', type: 'default' }]

  // JSON: just highlight strings, numbers, booleans, null
  if (lang === 'json') return tokenizeJson(code)
  // Markdown: no highlighting
  if (lang === 'md') return [{ text: code, type: 'default' }]
  // HTML: basic tag detection
  if (lang === 'html') return tokenizeHtml(code)

  const keywords = KEYWORDS[lang] || new Set()
  const commentStyle = COMMENT_STYLES[lang] || {}
  const tokens = []
  let i = 0

  while (i < code.length) {
    // Line comment
    if (commentStyle.line && code.startsWith(commentStyle.line, i)) {
      tokens.push({ text: code.slice(i), type: 'comment' })
      return tokens
    }

    // Block comment start
    if (commentStyle.block && code.startsWith(commentStyle.block[0], i)) {
      const end = code.indexOf(commentStyle.block[1], i + commentStyle.block[0].length)
      if (end !== -1) {
        tokens.push({ text: code.slice(i, end + commentStyle.block[1].length), type: 'comment' })
        i = end + commentStyle.block[1].length
      } else {
        tokens.push({ text: code.slice(i), type: 'comment' })
        return tokens
      }
      continue
    }

    // Strings
    if (code[i] === '"' || code[i] === "'" || code[i] === '`') {
      const quote = code[i]
      let j = i + 1
      while (j < code.length) {
        if (code[j] === '\\') { j += 2; continue }
        if (code[j] === quote) { j++; break }
        j++
      }
      tokens.push({ text: code.slice(i, j), type: 'string' })
      i = j
      continue
    }

    // Numbers
    if (/\d/.test(code[i]) && (i === 0 || /[\s,([{=:+\-*/<>!&|^~%]/.test(code[i - 1]))) {
      let j = i
      if (code[j] === '0' && (code[j + 1] === 'x' || code[j + 1] === 'X')) {
        j += 2
        while (j < code.length && /[0-9a-fA-F_]/.test(code[j])) j++
      } else {
        while (j < code.length && /[0-9._eE]/.test(code[j])) j++
      }
      tokens.push({ text: code.slice(i, j), type: 'number' })
      i = j
      continue
    }

    // Words (identifiers / keywords)
    if (/[a-zA-Z_$]/.test(code[i])) {
      let j = i + 1
      while (j < code.length && /[a-zA-Z0-9_$]/.test(code[j])) j++
      const word = code.slice(i, j)
      tokens.push({ text: word, type: keywords.has(word) ? 'keyword' : 'default' })
      i = j
      continue
    }

    // Punctuation
    if (/[{}()[\];:.,<>=!&|^~?+\-*/%@#]/.test(code[i])) {
      tokens.push({ text: code[i], type: 'punctuation' })
      i++
      continue
    }

    // Default (whitespace, etc.)
    let j = i + 1
    while (j < code.length && !/[a-zA-Z_$0-9"'`{}()[\];:.,<>=!&|^~?+\-*/%@#]/.test(code[j])) j++
    tokens.push({ text: code.slice(i, j), type: 'default' })
    i = j
  }

  return tokens
}

function tokenizeJson(code) {
  const tokens = []
  let i = 0
  while (i < code.length) {
    if (code[i] === '"') {
      let j = i + 1
      while (j < code.length) {
        if (code[j] === '\\') { j += 2; continue }
        if (code[j] === '"') { j++; break }
        j++
      }
      // Check if this is a key (followed by :)
      const rest = code.slice(j).trimStart()
      tokens.push({ text: code.slice(i, j), type: rest.startsWith(':') ? 'keyword' : 'string' })
      i = j
      continue
    }
    if (/\d/.test(code[i]) || (code[i] === '-' && i + 1 < code.length && /\d/.test(code[i + 1]))) {
      let j = i + (code[i] === '-' ? 1 : 0)
      while (j < code.length && /[0-9.eE+-]/.test(code[j])) j++
      tokens.push({ text: code.slice(i, j), type: 'number' })
      i = j
      continue
    }
    if (code.startsWith('true', i) || code.startsWith('false', i) || code.startsWith('null', i)) {
      const word = code.startsWith('true', i) ? 'true' : code.startsWith('false', i) ? 'false' : 'null'
      tokens.push({ text: word, type: 'keyword' })
      i += word.length
      continue
    }
    tokens.push({ text: code[i], type: /[{}[\]:,]/.test(code[i]) ? 'punctuation' : 'default' })
    i++
  }
  return tokens
}

function tokenizeHtml(code) {
  const tokens = []
  let i = 0
  while (i < code.length) {
    // Comment
    if (code.startsWith('<!--', i)) {
      const end = code.indexOf('-->', i + 4)
      const j = end !== -1 ? end + 3 : code.length
      tokens.push({ text: code.slice(i, j), type: 'comment' })
      i = j
      continue
    }
    // Tag
    if (code[i] === '<') {
      let j = i + 1
      while (j < code.length && code[j] !== '>') j++
      if (j < code.length) j++
      tokens.push({ text: code.slice(i, j), type: 'keyword' })
      i = j
      continue
    }
    // Entity
    if (code[i] === '&') {
      let j = i + 1
      while (j < code.length && code[j] !== ';' && j - i < 12) j++
      if (code[j] === ';') j++
      tokens.push({ text: code.slice(i, j), type: 'string' })
      i = j
      continue
    }
    let j = i + 1
    while (j < code.length && code[j] !== '<' && code[j] !== '&') j++
    tokens.push({ text: code.slice(i, j), type: 'default' })
    i = j
  }
  return tokens
}
