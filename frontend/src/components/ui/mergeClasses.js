// mergeClasses — a small, dependency-free stand-in for tailwind-merge.
//
// Tailwind decides conflicts by stylesheet order, not by the order classes
// appear in `className`. So `bg-x-surface bg-x-accent` does not mean "accent
// wins": whichever utility Tailwind happened to emit later wins. Primitives
// like <Button> append the caller's className after their variant classes and
// expect the caller to win; this helper makes that true by dropping earlier
// classes that set the same property (with the same variant prefix, e.g.
// `hover:` or `disabled:`) as a later class.
//
// Only the utility families listed below are de-duplicated. Anything unknown
// is kept as-is, so the worst case is the old behaviour, never a lost class.

const TEXT_SIZES = new Set(['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl'])
const TEXT_ALIGN = new Set(['left', 'center', 'right', 'justify', 'start', 'end'])
const FONT_WEIGHTS = new Set(['thin', 'extralight', 'light', 'normal', 'medium', 'semibold', 'bold', 'extrabold', 'black'])
const BORDER_STYLES = new Set(['solid', 'dashed', 'dotted', 'double', 'hidden', 'none'])
const DISPLAY = new Set(['block', 'inline-block', 'inline', 'flex', 'inline-flex', 'grid', 'inline-grid', 'hidden', 'contents', 'table'])
const POSITION = new Set(['static', 'fixed', 'absolute', 'relative', 'sticky'])

// group -> groups it also overrides when it appears later (p-2 beats px-3).
const OVERRIDES = {
  p: ['px', 'py', 'pt', 'pr', 'pb', 'pl', 'ps', 'pe'],
  px: ['pr', 'pl', 'ps', 'pe'],
  py: ['pt', 'pb'],
  m: ['mx', 'my', 'mt', 'mr', 'mb', 'ml', 'ms', 'me'],
  mx: ['mr', 'ml', 'ms', 'me'],
  my: ['mt', 'mb'],
  size: ['w', 'h', 'min-h'],
  // An explicit later height means "this tall": drop an earlier min-h floor
  // (Button's size floor), which CSS would otherwise let win over height.
  h: ['min-h'],
  gap: ['gap-x', 'gap-y'],
  rounded: ['rounded-side'],
  'border-w': ['border-w-side'],
}

const isLength = (v) => /^(\d+(\.\d+)?|px|\[.*\])$/.test(v)
const isArbitrarySize = (v) => /^\[\d*\.?\d+(px|rem|em)\]$/.test(v)

function groupOf(utility) {
  let u = utility.startsWith('!') ? utility.slice(1) : utility
  if (u.startsWith('-')) u = u.slice(1)
  if (DISPLAY.has(u)) return 'display'
  if (POSITION.has(u)) return 'position'
  if (u === 'truncate') return null

  let m = u.match(/^(p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me)-(.+)$/)
  if (m) return m[1]
  m = u.match(/^(min-w|min-h|max-w|max-h|w|h|size|gap-x|gap-y|gap|opacity|cursor|whitespace|items|justify|self|duration|ease|z|leading|tracking|shrink|grow|basis|overflow|overflow-x|overflow-y|outline|scale|select)-(.+)$/)
  if (m) return m[1]
  if (u === 'shrink' || u === 'grow') return u
  if (/^transition(-|$)/.test(u)) return 'transition'
  if (/^shadow(-|$)/.test(u)) return 'shadow'

  m = u.match(/^text-(.+)$/)
  if (m) {
    const v = m[1]
    if (TEXT_SIZES.has(v) || isArbitrarySize(v)) return 'text-size'
    if (TEXT_ALIGN.has(v)) return 'text-align'
    return 'text-color'
  }
  m = u.match(/^font-(.+)$/)
  if (m) return FONT_WEIGHTS.has(m[1]) || /^\[\d+\]$/.test(m[1]) ? 'font-weight' : 'font-family'
  m = u.match(/^bg-(.+)$/)
  if (m) return /^(gradient|linear|radial|none|cover|contain|center|no-repeat|repeat|fixed|clip)/.test(m[1]) ? null : 'bg-color'

  if (u === 'border') return 'border-w'
  m = u.match(/^border-(.+)$/)
  if (m) {
    const v = m[1]
    if (isLength(v)) return 'border-w'
    if (BORDER_STYLES.has(v)) return 'border-style'
    // border-t / border-x-2 (sides). Note `border-x-<token>` is a colour here:
    // the theme's colours are all named x-*.
    if (/^(t|r|b|l|s|e|y)(-|$)/.test(v) || /^x(-(\d+|\[.*\]))?$/.test(v)) return 'border-w-side'
    return 'border-color'
  }
  if (u === 'rounded' || /^rounded-(none|full|xs|sm|md|lg|xl|2xl|3xl|\[.*\])$/.test(u)) return 'rounded'
  if (/^rounded-/.test(u)) return 'rounded-side'

  if (u === 'ring' || /^ring-(\d+|\[.*px\])$/.test(u)) return 'ring-w'
  if (u === 'ring-inset') return 'ring-inset'
  if (/^ring-offset-/.test(u)) return null
  if (/^ring-/.test(u)) return 'ring-color'
  return null
}

function split(cls) {
  // `hover:bg-x/10`, `disabled:active:scale-100`, `[&>svg]:w-3` -> prefix + utility.
  let depth = 0
  let last = -1
  for (let i = 0; i < cls.length; i++) {
    const c = cls[i]
    if (c === '[') depth++
    else if (c === ']') depth--
    else if (c === ':' && depth === 0) last = i
  }
  return last < 0 ? ['', cls] : [cls.slice(0, last + 1), cls.slice(last + 1)]
}

export function mergeClasses(...parts) {
  const tokens = parts.filter(Boolean).join(' ').split(/\s+/).filter(Boolean)
  const keep = new Array(tokens.length).fill(true)
  const seen = new Set()
  // Walk backwards: the first time we see a (prefix, group) it is the winner;
  // earlier tokens in the same or an overridden group are dropped.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const [prefix, utility] = split(tokens[i])
    const group = groupOf(utility)
    if (!group) continue
    const key = `${prefix}|${group}`
    if (seen.has(key)) { keep[i] = false; continue }
    seen.add(key)
    for (const sub of OVERRIDES[group] || []) seen.add(`${prefix}|${sub}`)
  }
  const out = []
  const dup = new Set()
  tokens.forEach((t, i) => { if (keep[i] && !dup.has(t)) { dup.add(t); out.push(t) } })
  return out.join(' ')
}

export default mergeClasses
