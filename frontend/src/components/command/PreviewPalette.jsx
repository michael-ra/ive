import { useState, useEffect, useRef } from 'react'
import { Camera, ExternalLink, X, Loader2, Download } from 'lucide-react'
import useStore from '../../state/store'

export default function PreviewPalette({ onClose, onScreenshot, onLivePreview }) {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [installing, setInstalling] = useState(false)
  const [installLog, setInstallLog] = useState(null)
  const inputRef = useRef(null)
  const [errorReason, setErrorReason] = useState(null)
  const needsInstall = errorReason === 'no_tools'
  const isUnreachable = errorReason === 'unreachable'
  const isTimeout = errorReason === 'timeout'

  const activeSessionId = useStore((s) => s.activeSessionId)
  const sessions = useStore((s) => s.sessions)
  const workspaces = useStore((s) => s.workspaces)

  const sess = sessions[activeSessionId]
  const wsId = sess?.workspace_id || useStore.getState().activeWorkspaceId
  const ws = workspaces.find((w) => w.id === wsId)
  const otherPreviews = workspaces.filter((w) => w.id !== wsId && w.preview_url?.trim())

  useEffect(() => {
    setUrl(ws?.preview_url || '')
    setTimeout(() => inputRef.current?.select(), 50)
  }, [ws?.preview_url])

  const captureScreenshot = async (targetUrl) => {
    let u = (targetUrl || '').trim()
    if (!u) return
    // Normalize: add https:// if no protocol specified
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u
    setLoading(true)
    setError(null)
    setErrorReason(null)
    try {
      // Use workspace endpoint if we have a matching workspace, else generic
      const targetWs = workspaces.find((w) => w.preview_url?.trim() === u)
      const resp = targetWs
        ? await fetch(`/api/workspaces/${targetWs.id}/preview-screenshot`)
        : await fetch(`/api/screenshot?url=${encodeURIComponent(u)}`)
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        setErrorReason(err.reason || null)
        throw new Error(err.error || `Screenshot failed (${resp.status})`)
      }
      const blob = await resp.blob()
      const blobUrl = URL.createObjectURL(blob)
      onScreenshot(blobUrl, u)
      onClose()
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const openLivePreview = (targetUrl) => {
    let u = (targetUrl || '').trim()
    if (!u) return
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u
    onLivePreview(u)
    onClose()
  }

  const openInTab = (targetUrl) => {
    let u = (targetUrl || '').trim()
    if (u) {
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u
      window.open(u, '_blank', 'noopener,noreferrer')
      onClose()
    }
  }

  const installPlaywright = async () => {
    setInstalling(true)
    setInstallLog(null)
    try {
      const resp = await fetch('/api/install-screenshot-tools', { method: 'POST' })
      const data = await resp.json()
      if (data.ok) {
        setError(null)
        setInstallLog('Installed! Try screenshot again.')
      } else {
        const lastStep = data.steps?.[data.steps.length - 1]
        setInstallLog(lastStep?.output || 'Install failed')
      }
    } catch (e) {
      setInstallLog(`Install error: ${e.message}`)
    } finally {
      setInstalling(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'Enter' && e.shiftKey && !loading) {
      e.preventDefault()
      captureScreenshot(url)
      return
    }
    if (e.key === 'Enter' && !loading) {
      e.preventDefault()
      openLivePreview(url)
      return
    }
    if (e.key === 'o' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      openInTab(url)
      return
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[480px] bg-[#111118] border border-zinc-700 rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800">
          <Camera size={14} className="text-indigo-400" />
          <span className="text-[11px] text-zinc-200 font-mono font-medium">Preview</span>
          {ws && <span className="text-[10px] text-zinc-500 font-mono truncate">— {ws.name}</span>}
          <div className="flex-1" />
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300">
            <X size={14} />
          </button>
        </div>

        {/* URL input */}
        <div className="px-4 py-3">
          <input
            ref={inputRef}
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:3000"
            className="w-full px-3 py-2 text-sm font-mono bg-zinc-900 border border-zinc-700 rounded-md text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50"
            autoFocus
            disabled={loading}
          />
        </div>

        {/* Actions */}
        <div className="px-4 pb-3 flex gap-2">
          <button
            onClick={() => openLivePreview(url)}
            disabled={loading || !url.trim()}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/25 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ExternalLink size={12} />
            Live Preview
            <kbd className="text-[9px] text-indigo-400/60 bg-indigo-900/30 px-1 py-0.5 rounded ml-1">↵</kbd>
          </button>
          <button
            onClick={() => captureScreenshot(url)}
            disabled={loading || !url.trim()}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 border border-zinc-700 hover:border-zinc-600 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
            {loading ? 'Capturing…' : 'Screenshot'}
            <kbd className="text-[9px] text-zinc-500 bg-zinc-800 px-1 py-0.5 rounded ml-1">⇧↵</kbd>
          </button>
          <button
            onClick={() => openInTab(url)}
            disabled={!url.trim() || loading}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 border border-zinc-700 hover:border-zinc-600 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ExternalLink size={12} />
            <kbd className="text-[9px] text-zinc-500 bg-zinc-800 px-1 py-0.5 rounded ml-1">⌘O</kbd>
          </button>
        </div>

        {/* Error / Install prompt */}
        {(error || installLog) && (
          <div className="px-4 pb-2 space-y-1.5">
            {error && (
              <div className={`text-[10px] rounded px-2.5 py-1.5 font-mono break-all ${
                isUnreachable
                  ? 'text-amber-400 bg-amber-500/10 border border-amber-500/20'
                  : 'text-red-400 bg-red-500/10 border border-red-500/20'
              }`}>
                {needsInstall ? 'Screenshot tools not installed.' : isUnreachable ? `Site unreachable — is the dev server running at ${url}?` : isTimeout ? `Page timed out — the site at ${url} took too long to load.` : error}
              </div>
            )}
            {needsInstall && (
              <button
                onClick={installPlaywright}
                disabled={installing}
                className="flex items-center gap-2 w-full px-2.5 py-2 text-[11px] font-medium bg-emerald-600/15 hover:bg-emerald-600/25 text-emerald-300 border border-emerald-500/25 rounded-md transition-colors disabled:opacity-50"
              >
                {installing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                {installing ? 'Installing playwright + chromium…' : 'Install screenshot tools (playwright + chromium)'}
              </button>
            )}
            {installLog && (
              <div className={`text-[10px] rounded px-2.5 py-1.5 font-mono break-all ${
                installLog.startsWith('Installed')
                  ? 'text-emerald-400 bg-emerald-500/10 border border-emerald-500/20'
                  : 'text-amber-400 bg-amber-500/10 border border-amber-500/20'
              }`}>
                {installLog}
              </div>
            )}
          </div>
        )}

        {/* Other workspaces with preview URLs */}
        {otherPreviews.length > 0 && (
          <div className="border-t border-zinc-800 px-4 py-2">
            <div className="text-[9px] text-zinc-500 uppercase tracking-wider font-semibold mb-1.5">Other workspaces</div>
            {otherPreviews.map((w) => (
              <button
                key={w.id}
                onClick={() => setUrl(w.preview_url)}
                className="flex items-center gap-2 w-full px-2 py-1.5 text-left rounded hover:bg-zinc-800/50 transition-colors group"
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: w.color || '#6366f1' }} />
                <span className="text-[11px] text-zinc-400 group-hover:text-zinc-200 truncate">{w.name}</span>
                <span className="text-[10px] text-zinc-600 font-mono truncate ml-auto">{w.preview_url}</span>
              </button>
            ))}
          </div>
        )}

        {/* Hint bar */}
        <div className="px-4 py-2 border-t border-zinc-800">
          <span className="text-[9px] text-zinc-600 font-mono">
            ↵ live preview · ⇧↵ quick screenshot · ⌘O open in tab · esc close
          </span>
        </div>
      </div>
    </div>
  )
}
