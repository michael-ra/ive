/**
 * Files and folders as chat context: how a chip becomes prompt text.
 *
 * Chips are references, never pasted contents. The block is appended to the
 * message after the user's text (and after annotations), one entry per line:
 *
 *   Claude, Gemini  `@path` mentions. Both CLIs resolve an @-mention when the
 *                   prompt is submitted and read the file (a folder: its
 *                   listing) into the turn themselves. Project entries use the
 *                   path relative to the session folder (the CLI's cwd);
 *                   uploaded files use their absolute path in IVE's session
 *                   attachment folder. Paths with spaces: Claude `@"a b.md"`,
 *                   Gemini `@a\ b.md`.
 *   Codex, others   plain paths with a one-line instruction. Codex's `@` is
 *                   only a picker in its composer that inserts the path, so
 *                   the path itself is what the model sees; it opens the file
 *                   with its own tools (sandbox read access covers the
 *                   project and IVE's attachment folder).
 *
 * The block always ends with a plain sentence, so a CLI never sees the
 * prompt end inside an `@` token (Claude's file typeahead would take Enter).
 */

export const MENTION_CLIS = new Set(['claude', 'gemini'])
export const MAX_UPLOAD_BYTES = 1024 * 1024
export const isImageFile = (file) => String(file?.type || '').startsWith('image/')

const CLI_LABELS = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity' }

export function cliLabel(cliType) {
  return CLI_LABELS[cliType] || (cliType ? cliType[0].toUpperCase() + cliType.slice(1) : 'the agent')
}

export function contextKey(item) {
  if (item.source === 'upload') return item.sha256 ? `u:${item.sha256}` : `u-pending:${item.name}:${item.size}`
  return `p:${String(item.path || '').replace(/\/+$/, '')}`
}

/** The path the CLI gets for one chip (relative for project, absolute for uploads). */
export function contextPath(item) {
  const p = item.source === 'upload' ? item.absPath || item.path : String(item.path || '').replace(/\/+$/, '')
  return item.kind === 'dir' ? `${p}/` : p
}

function mention(path, cliType) {
  if (!/\s/.test(path)) return `@${path}`
  if (cliType === 'gemini') return `@${path.replace(/(\s)/g, '\\$1')}`
  return `@"${path.replace(/"/g, '\\"')}"`
}

/** One chip as it appears in the prompt for this CLI. */
export function contextReference(item, cliType) {
  const path = contextPath(item)
  return MENTION_CLIS.has(cliType) ? mention(path, cliType) : path
}

export function formatContextBlock(items, cliType) {
  const usable = (items || []).filter((it) => it && it.status !== 'error' && it.status !== 'missing' && it.status !== 'uploading' && (it.path || it.absPath))
  if (usable.length === 0) return ''
  if (MENTION_CLIS.has(cliType)) {
    return [
      'Attached context:',
      ...usable.map((it) => contextReference(it, cliType)),
      'Use the files and folders above as context for this message.',
    ].join('\n')
  }
  return [
    'Attached context (paths are relative to your working folder unless absolute; open them before answering):',
    ...usable.map((it) => {
      const note = it.source === 'upload' ? ' (file the user attached, outside the project)' : it.kind === 'dir' ? ' (folder)' : ''
      return `- ${contextPath(it)}${note}`
    }),
  ].join('\n')
}

/** Chip label as the composer shows it (project path, or the dropped file's name). */
export function contextLabel(item) {
  return item?.source === 'upload' ? item.name : `${String(item?.path || '').replace(/\/+$/, '')}${item?.kind === 'dir' ? '/' : ''}`
}

/**
 * The chips a queued message carries, small enough for localStorage (no
 * preview text): shown on the queue row and put back as chips on Edit.
 */
export function queuedContextItems(items) {
  return (items || [])
    .filter((it) => it && it.status === 'ok' && (it.path || it.absPath))
    .map(({ key, source, kind, path, absPath, name, size, sha256 }) => ({ key, source, kind, path, absPath, name, size, sha256, status: 'ok' }))
}

/** Short sentence for the UI: how chips reach this provider. */
export function deliveryHint(cliType) {
  const who = cliLabel(cliType)
  return MENTION_CLIS.has(cliType)
    ? `${who} gets these as @-mentions and reads them when you send.`
    : `${who} gets these paths and opens the files itself.`
}

export function humanSize(size) {
  const n = Number(size)
  if (!Number.isFinite(n)) return ''
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/**
 * Split a drop or a file-input selection: images go to the existing image
 * attachment flow, everything else to context. Folders dropped from Finder
 * cannot be read by the browser and are reported. Must run synchronously in
 * the drop handler (DataTransfer items expire after the first await).
 */
export function splitDroppedFiles(source) {
  const images = [], files = [], folders = []
  const items = source?.items ? Array.from(source.items) : null
  if (items && items.length) {
    for (const item of items) {
      if (item.kind !== 'file') continue
      const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
      const file = item.getAsFile()
      if (entry?.isDirectory) { folders.push(entry.name || file?.name || 'folder'); continue }
      if (!file) continue
      ;(isImageFile(file) ? images : files).push(file)
    }
    return { images, files, folders }
  }
  for (const file of Array.from(source?.files || source || [])) {
    ;(isImageFile(file) ? images : files).push(file)
  }
  return { images, files, folders }
}
