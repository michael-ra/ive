import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { request, ApiError } from '../lib/api'
import { apiBase } from '../lib/platform'
import { MAX_UPLOAD_BYTES, contextKey, formatContextBlock, humanSize, splitDroppedFiles } from '../lib/chatContext'
import { checkRestoredChips, getChips, missingContextMessage, setChips, subscribeChips } from '../lib/contextChipStore'

// Chips survive switching sessions/tabs and reloads (lib/contextChipStore.js,
// keyed by session id), like the composer draft. They are cleared when the
// message is sent; chips restored after a reload are checked again first.
const EMPTY = []

/** Edit on a queued message: its chips come back next to what is already attached. */
export function restoreChatContext(sessionId, items) {
  if (!sessionId || !items?.length) return
  setChips(sessionId, (prev) => {
    const have = new Set(prev.map((c) => c.key))
    return [...prev, ...items.filter((c) => c?.key && !have.has(c.key))]
  })
}

const enc = encodeURIComponent
const errorText = (err, fallback) => err?.body?.error || err?.message || fallback

async function uploadContextFile(sessionId, file) {
  const form = new FormData()
  form.append('file', file, file.name)
  const res = await fetch(`${apiBase()}/sessions/${enc(sessionId)}/context/upload`, { method: 'POST', body: form })
  let body = null
  try { body = await res.json() } catch { /* not json */ }
  if (!res.ok) throw new ApiError(body?.error || `Upload failed (HTTP ${res.status})`, { status: res.status, body })
  return body
}

async function readPreview(file) {
  try {
    const text = await file.slice(0, 16 * 1024).text()
    const lines = text.split('\n')
    return { preview: lines.slice(0, 40).join('\n'), previewTruncated: lines.length > 40 || file.size > 16 * 1024 }
  } catch {
    return { preview: '', previewTruncated: false }
  }
}

/**
 * Context chips for one session's composer: add project files/folders (from
 * the @ picker) or dropped files, show problems as notices, format for send.
 */
export function useChatContext(sessionId) {
  const items = useSyncExternalStore(subscribeChips, () => getChips(sessionId), () => EMPTY)
  const [notices, setNotices] = useState([])
  const [flashKey, setFlashKey] = useState(null)
  const flashTimer = useRef(null)

  const notify = useCallback((message, tone = 'error') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setNotices((prev) => [...prev.slice(-2), { id, message, tone }])
    // Info ("already in the context") goes away by itself; errors stay until dismissed or sent.
    if (tone === 'info') setTimeout(() => setNotices((prev) => prev.filter((n) => n.id !== id)), 5000)
  }, [])
  const dismissNotice = useCallback((id) => setNotices((prev) => prev.filter((n) => n.id !== id)), [])
  useEffect(() => { setNotices([]) }, [sessionId])
  // Chips restored after a reload: is each file or folder still there?
  useEffect(() => {
    checkRestoredChips(sessionId, (chip) => request(chip.source === 'upload'
      ? `/sessions/${enc(sessionId)}/context/inspect?upload=${enc(chip.absPath || chip.path)}`
      : `/sessions/${enc(sessionId)}/context/inspect?path=${enc(chip.path)}`))
  }, [sessionId])
  useEffect(() => () => clearTimeout(flashTimer.current), [])

  const flash = useCallback((key) => {
    setFlashKey(key)
    clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlashKey(null), 1600)
  }, [])

  const alreadyThere = useCallback((key, label) => {
    flash(key)
    notify(`${label} is already in the context.`, 'info')
  }, [flash, notify])

  const addProjectEntry = useCallback(async (entry) => {
    if (!sessionId || !entry?.path) return
    if (entry.status && entry.status !== 'ok') {
      notify(`${entry.path} can't be added: ${entry.reason || 'unsupported file.'}`)
      return
    }
    const chip = { source: 'project', kind: entry.kind, path: entry.path.replace(/\/+$/, ''), name: entry.name, size: entry.size, status: 'checking' }
    const key = contextKey(chip)
    if (getChips(sessionId).some((c) => c.key === key)) { alreadyThere(key, chip.path); return }
    setChips(sessionId, (prev) => [...prev, { ...chip, key }])
    try {
      const info = await request(`/sessions/${enc(sessionId)}/context/inspect?path=${enc(chip.path)}`)
      if (info.status && info.status !== 'ok') throw new Error(info.reason || 'unsupported file')
      setChips(sessionId, (prev) => prev.map((c) => (c.key === key ? {
        ...c, status: 'ok', kind: info.kind, size: info.size, absPath: info.abs_path,
        preview: info.preview, previewTruncated: info.preview_truncated, children: info.children, more: info.more,
      } : c)))
    } catch (err) {
      setChips(sessionId, (prev) => prev.filter((c) => c.key !== key))
      notify(`Couldn't add ${chip.path}: ${errorText(err, 'the file could not be loaded.')}`)
    }
  }, [sessionId, notify, alreadyThere])

  /** Takes a DataTransfer or FileList; returns the image Files for the image flow. */
  const acceptFiles = useCallback((source) => {
    const { images, files, folders } = splitDroppedFiles(source)
    for (const name of folders) {
      notify(`${name}: folders can't be dropped here. Type @ and pick the folder from the project instead.`)
    }
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        notify(`${file.name} is ${humanSize(file.size)}; attached text files can be up to ${humanSize(MAX_UPLOAD_BYTES)}. Add big project files with @ instead.`)
        continue
      }
      const tempKey = `pending:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`
      setChips(sessionId, (prev) => [...prev, { key: tempKey, source: 'upload', kind: 'file', name: file.name, size: file.size, status: 'uploading' }])
      ;(async () => {
        try {
          const [res, preview] = await Promise.all([uploadContextFile(sessionId, file), readPreview(file)])
          const done = { source: 'upload', kind: 'file', name: file.name, size: res.size, sha256: res.sha256, absPath: res.path, path: res.path, status: 'ok', ...preview }
          const key = contextKey(done)
          const dup = getChips(sessionId).some((c) => c.key === key)
          setChips(sessionId, (prev) => (dup ? prev.filter((c) => c.key !== tempKey) : prev.map((c) => (c.key === tempKey ? { ...done, key } : c))))
          if (dup) alreadyThere(key, file.name)
        } catch (err) {
          setChips(sessionId, (prev) => prev.filter((c) => c.key !== tempKey))
          notify(err?.status === 415 || err?.status === 413
            ? errorText(err, `${file.name} is not supported.`)
            : `Couldn't attach ${file.name}: ${errorText(err, 'upload failed.')}`)
        }
      })()
    }
    return images
  }, [sessionId, notify, alreadyThere])

  const remove = useCallback((key) => setChips(sessionId, (prev) => prev.filter((c) => c.key !== key)), [sessionId])
  const clear = useCallback(() => { setChips(sessionId, []); setNotices([]) }, [sessionId])
  const format = useCallback((cliType) => formatContextBlock(getChips(sessionId), cliType), [sessionId])
  const busy = items.some((c) => c.status === 'uploading' || c.status === 'checking')
  // A restored chip whose file is gone: refuse to send instead of dropping it silently.
  const blockReason = missingContextMessage(items)

  return { items, notices, flashKey, busy, blockReason, addProjectEntry, acceptFiles, remove, clear, format, notify, dismissNotice }
}

/** Debounced fuzzy search over the session folder for the @ picker. query null = off. */
export function useContextSearch(sessionId, query) {
  const [state, setState] = useState({ status: 'idle', items: EMPTY, error: null, query: null })
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (query == null || !sessionId) { setState({ status: 'idle', items: EMPTY, error: null, query: null }); return }
    let cancelled = false
    setState((s) => ({ ...s, status: 'loading', query }))
    const timer = setTimeout(async () => {
      try {
        const res = await request(`/sessions/${enc(sessionId)}/context/search?q=${enc(query)}&limit=12`)
        if (!cancelled) setState({ status: 'ready', items: res.items || EMPTY, error: null, query })
      } catch (err) {
        if (!cancelled) setState({ status: 'error', items: EMPTY, error: errorText(err, 'request failed'), query })
      }
    }, 90)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [sessionId, query, retry])
  const reload = useCallback(() => setRetry((n) => n + 1), [])
  return useMemo(() => ({ ...state, reload }), [state, reload])
}
