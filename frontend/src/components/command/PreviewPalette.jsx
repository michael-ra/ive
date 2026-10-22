import { useState, useEffect, useRef } from 'react'
import { Camera, ExternalLink, X, Loader2, Download } from 'lucide-react'
import useStore from '../../state/store'
import { Button } from '../ui'

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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-x-scrim backdrop-blur-[4px]" onClick={onClose}>
      <div
        className="w-[480px] x-panel overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-x-line">
          <Camera size={14} className="text-x-accent" />
          <span className="text-[11px] text-x-ink font-medium">Preview</span>
          {ws && <span className="text-[11px] text-x-muted truncate">— {ws.name}</span>}
          <div className="flex-1" />
          <Button type="submit" onClick={onClose} className="p-1 hover:bg-x-hover text-x-faint hover:text-x-ink transition-colors duration-[80ms]">
            <X size={14} />
          </Button>
        </div>

        {/* URL input */}
        <div className="px-4 py-3">
          <input
            ref={inputRef}
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:3000"
            className="w-full px-3 py-2 text-[13px] font-mono bg-x-surface-2 border border-x-line rounded-md text-x-ink placeholder:text-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
            autoFocus
            disabled={loading}
          />
        </div>

        {/* Actions */}
        <div className="px-4 pb-3 flex gap-2">
          <Button type="submit"
            onClick={() => openLivePreview(url)}
            disabled={loading || !url.trim()}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium bg-x-accent/15 hover:bg-x-accent/25 text-x-accent border border-x-accent/30 transition-colors duration-[80ms] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ExternalLink size={12} />
            Live Preview
            <kbd className="text-[11px] text-x-accent/70 bg-x-accent/15 px-1 py-0.5 rounded ml-1">↵</kbd>
          </Button>
          <Button type="submit"
            onClick={() => captureScreenshot(url)}
            disabled={loading || !url.trim()}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-x-ink-secondary hover:text-x-ink hover:bg-x-hover border border-x-line hover:border-x-line-strong transition-colors duration-[80ms] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
            {loading ? 'Capturing…' : 'Screenshot'}
            <kbd className="text-[11px] text-x-muted bg-x-hover px-1 py-0.5 rounded ml-1">⇧↵</kbd>
          </Button>
          <Button type="submit"
            onClick={() => openInTab(url)}
            disabled={!url.trim() || loading}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-x-ink-secondary hover:text-x-ink hover:bg-x-hover border border-x-line hover:border-x-line-strong transition-colors duration-[80ms] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ExternalLink size={12} />
            <kbd className="text-[11px] text-x-muted bg-x-hover px-1 py-0.5 rounded ml-1">⌘O</kbd>
          </Button>
        </div>

        {/* Error / Install prompt */}
        {(error || installLog) && (
          <div className="px-4 pb-2 space-y-1.5">
            {error && (
              <div className={`text-[11px] rounded-md px-2.5 py-1.5 break-all ${
                isUnreachable
                  ? 'text-x-accent-ink bg-x-accent-ink/10 border border-x-accent-ink/30'
                  : 'text-x-accent-ink bg-x-accent-ink/10 border border-x-accent-ink/30'
              }`}>
                {needsInstall ? 'Screenshot tools not installed.' : isUnreachable ? `Site unreachable — is the dev server running at ${url}?` : isTimeout ? `Page timed out — the site at ${url} took too long to load.` : error}
              </div>
            )}
            {needsInstall && (
              <Button type="submit"
                onClick={installPlaywright}
                disabled={installing}
                className="flex items-center gap-2 w-full px-2.5 py-2 text-[11px] font-medium bg-x-good/15 hover:bg-x-good/25 text-x-good border border-x-good/30 transition-colors duration-[80ms] disabled:opacity-50"
              >
                {installing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                {installing ? 'Installing playwright + chromium…' : 'Install screenshot tools (playwright + chromium)'}
              </Button>
            )}
            {installLog && (
              <div className={`text-[11px] rounded-md px-2.5 py-1.5 break-all ${
                installLog.startsWith('Installed')
                  ? 'text-x-good bg-x-good/10 border border-x-good/30'
                  : 'text-x-accent-ink bg-x-accent-ink/10 border border-x-accent-ink/30'
              }`}>
                {installLog}
              </div>
            )}
          </div>
        )}

        {/* Other workspaces with preview URLs */}
        {otherPreviews.length > 0 && (
          <div className="border-t border-x-line px-4 py-2">
            <div className="text-[11px] text-x-muted uppercase tracking-[0.06em] font-medium mb-1.5">Other workspaces</div>
            {otherPreviews.map((w) => (
              <Button type="submit"
                key={w.id}
                onClick={() => setUrl(w.preview_url)}
                className="flex items-center gap-2 w-full px-2 py-1.5 text-left hover:bg-x-hover transition-colors duration-[80ms] group"
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: w.color || 'var(--x-accent)' }} />
                <span className="text-[11px] text-x-ink-secondary group-hover:text-x-ink truncate">{w.name}</span>
                <span className="text-[11px] text-x-muted font-mono truncate ml-auto">{w.preview_url}</span>
              </Button>
            ))}
          </div>
        )}

        {/* Hint bar */}
        <div className="px-4 py-2 border-t border-x-line">
          <span className="text-[11px] text-x-muted">
            ↵ live preview · ⇧↵ quick screenshot · ⌘O open in tab · esc close
          </span>
        </div>
      </div>
    </div>
  )
}
