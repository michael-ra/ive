/**
 * Token registry — defines the `@`-prefixed tokens that get expanded
 * before text is sent to a Claude session via sendTerminalCommand /
 * broadcastCommand.
 *
 * The same definitions power:
 *   - terminal.js token expansion (single source of truth for the regexes)
 *   - TokenChips preview UI (chip row under composer-style inputs so the
 *     user can see at a glance which tokens were recognized + what each
 *     one will expand to)
 *
 * Adding a new token: define its regex + a parseTokens branch + (if it
 * inlines text rather than triggering a side effect) a processor in
 * terminal.js that mirrors the regex.
 */

// ─── Regexes (single source of truth) ─────────────────────────────
export const TOKEN_REGEX = {
  ralph: /@ralph\b/i,
  research: /@research(?:--([^\s]+))?\s+(.+)/i,
  // @prompt:foo  |  @prompt:"foo bar"
  prompt: /@prompt:(?:"([^"]+)"|([^\s,;]+))/gi,
  global: /@global\b/i,
}

// ─── Tailwind class lookups (kept here so chips stay consistent) ──
const STYLES = {
  violet: 'bg-violet-500/10 text-violet-300 border-violet-500/30',
  cyan: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30',
  amber: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  emerald: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  red: 'bg-red-500/10 text-red-300 border-red-500/30',
}

/**
 * Look up a prompt by name with progressively looser matching:
 *   1. exact (case-insensitive)
 *   2. ignore spaces / dashes / underscores
 *   3. prefix match
 */
export function findPromptByName(prompts, name) {
  if (!name || !prompts || prompts.length === 0) return null
  const lc = name.toLowerCase()
  let p = prompts.find((x) => x.name.toLowerCase() === lc)
  if (p) return p
  const norm = lc.replace(/[\s\-_]/g, '')
  p = prompts.find((x) => x.name.toLowerCase().replace(/[\s\-_]/g, '') === norm)
  if (p) return p
  p = prompts.find((x) => x.name.toLowerCase().startsWith(lc))
  return p || null
}

/**
 * Scan text for known tokens and return chip descriptors in source order.
 *
 * ctx:
 *   - prompts: array of prompt objects from the store cache (for @prompt: lookup)
 *   - prompts: array of prompt objects from the store cache (for @prompt: lookup)
 */
export function parseTokens(text, ctx = {}) {
  if (!text) return []
  const { prompts = [] } = ctx
  const found = [] // { kind, label, preview, style, tooltip, index }

  // @ralph
  const ralphM = text.match(TOKEN_REGEX.ralph)
  if (ralphM) {
    found.push({
      kind: 'ralph',
      label: '@ralph',
      preview: 'Ralph loop mode',
      style: STYLES.amber,
      tooltip: 'Wraps the rest of the message in Ralph loop instructions (execute → verify → fix → repeat).',
      index: ralphM.index ?? 0,
    })
  }

  // @research [--<model>] <query>
  const researchM = text.match(TOKEN_REGEX.research)
  if (researchM) {
    const model = researchM[1] || 'default model'
    found.push({
      kind: 'research',
      label: researchM[1] ? `@research--${researchM[1]}` : '@research',
      preview: `deep research (${model})`,
      style: STYLES.cyan,
      tooltip: `Kicks off a background deep-research job. Model: ${model}. Query: "${(researchM[2] || '').slice(0, 80)}"`,
      index: researchM.index ?? 0,
    })
  }

  // @global
  const globalM = text.match(TOKEN_REGEX.global)
  if (globalM) {
    found.push({
      kind: 'global',
      label: '@global',
      preview: 'all workspaces',
      style: STYLES.cyan,
      tooltip: 'Broadcast to all open sessions across every workspace, not just the active one.',
      index: globalM.index ?? 0,
    })
  }

  // @prompt:<name>  (one chip per occurrence)
  TOKEN_REGEX.prompt.lastIndex = 0
  let m
  while ((m = TOKEN_REGEX.prompt.exec(text)) !== null) {
    const name = m[1] || m[2]
    const hit = findPromptByName(prompts, name)
    if (hit) {
      const trimmed = hit.content.trim().replace(/\s+/g, ' ')
      found.push({
        kind: 'prompt',
        label: `@prompt:${name}`,
        preview: `inlines "${hit.name}"`,
        style: STYLES.violet,
        tooltip: trimmed.slice(0, 240) + (trimmed.length > 240 ? '…' : ''),
        index: m.index,
      })
    } else {
      found.push({
        kind: 'unknown',
        label: `@prompt:${name}`,
        preview: 'no prompt found',
        style: STYLES.red,
        tooltip: prompts.length === 0
          ? 'Prompt library is empty — add one with ⌘/ → new'
          : `No prompt named "${name}". Try ⌘/ to browse.`,
        index: m.index,
      })
    }
  }

  return found.sort((a, b) => a.index - b.index)
}

/**
 * Inline expansion for `@prompt:<name>` tokens. Used by terminal.js so
 * commands sent to a session have the prompt body substituted in place.
 * Returns the original text unchanged if no tokens or no matches.
 *
 * `prompts` should be the cached array from the store.
 */
export function expandPromptTokens(text, prompts) {
  if (!text || !prompts || prompts.length === 0) return text
  return text.replace(TOKEN_REGEX.prompt, (match, quoted, bare) => {
    const name = quoted || bare
    const hit = findPromptByName(prompts, name)
    return hit ? hit.content : match
  })
}