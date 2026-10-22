import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { X, Sparkles, Check, RefreshCw, AlertCircle, FileText, Activity } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { getPolicyRoleConfig } from '../../lib/orchestrationPolicy'
import PanelBoundary from '../PanelBoundary'
import { Button } from '../ui'

// The post-run "what changed on the graph" reading (vision/CONVERGENCE_AND_CANVAS_TODO.md
// §4.A). This dialog is the natural home for it: it is the one surface you already
// open to ask "what did this session do?", it holds the session record the window
// needs, and the answer sits next to the prose summary rather than competing with it.
// Lazy because the canvas pulls SystemGraph + CanvasControls and SummaryDialog is
// statically imported by the sidebar.
const WorkspaceChangesCanvas = lazy(() => import('./WorkspaceChangesCanvas'))

// Sessions are stamped by SQLite's datetime('now') — "YYYY-MM-DD HH:MM:SS", UTC
// with no zone marker, which new Date() would read as LOCAL and shift the window
// by the machine's offset. Pin it to UTC before it becomes a query bound.
function sessionStartIso(session) {
  const raw = session?.created_at
  if (!raw) return null
  let t = String(raw).trim().replace(' ', 'T')
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(t)) t += 'Z'
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export default function SummaryDialog({ session, onClose }) {
  const workspaces = useStore((s) => s.workspaces)
  const [text, setText] = useState(session?.summary || '')
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [showGraph, setShowGraph] = useState(false)
  const graphCanvasRef = useRef(null)

  // Sync state if session summary changes externally
  useEffect(() => {
    if (session?.summary) {
      setText(session.summary)
    }
  }, [session?.summary])

  if (!session) return null

  const workspace = workspaces.find((w) => w.id === session.workspace_id)
  const policy = workspace?.orchestration_policy
  const config = getPolicyRoleConfig(policy, 'summary')

  const activeCli = config.cli_type || session.cli_type || 'claude'
  const activeModel = config.model || 'default'
  const isFromPolicy = !!config.cli_type
  
  const providerName = activeCli.charAt(0).toUpperCase() + activeCli.slice(1)
  const modelInfo = `${providerName} (${activeModel})`
  const configSource = isFromPolicy
    ? 'workspace orchestration settings'
    : 'session CLI type defaults'

  // Window = session start → now. No `until`: work landing right now still belongs
  // to this run. Without a start stamp there is no honest window, so the entry hides
  // rather than quietly falling back to the server's default 24h.
  const startedIso = sessionStartIso(session)
  const canShowGraph = !!(session.workspace_id && startedIso)

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await api.updateSession(session.id, { summary: text.trim() })
      useStore.getState().loadSessions([updated])
      useStore.getState().addNotification({
        type: 'success',
        message: 'Session summary saved successfully.'
      })
      onClose()
    } catch (err) {
      setError(err.message || 'Failed to save summary')
    } finally {
      setSaving(false)
    }
  }

  const handleGenerate = async () => {
    setGenerating(true)
    setError(null)
    try {
      const res = await api.summarizeSession(session.id)
      if (res.summary) {
        setText(res.summary)
        useStore.getState().addNotification({
          type: 'success',
          message: 'Summary generated successfully.'
        })
      } else {
        throw new Error('No summary returned from server')
      }
    } catch (err) {
      setError(err.message || 'Failed to generate summary')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-x-scrim backdrop-blur-[4px]" onClick={onClose}>
      <div
        className="x-panel w-[520px] max-h-[85vh] flex flex-col scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-x-line">
          <div className="flex items-center gap-2">
            <FileText size={16} className="text-x-accent" />
            <div>
              <h2 className="text-sm font-semibold text-x-ink">Session Summary</h2>
              <p className="text-[11px] text-x-faint">For: {session.name}</p>
            </div>
          </div>
          <Button type="submit"
            onClick={onClose}
            className="p-1 hover:bg-x-hover text-x-muted hover:text-x-ink-secondary transition-colors"
          >
            <X size={16} />
          </Button>
        </div>

        {/* Body */}
        <div className="px-4 py-4 flex-1 flex flex-col min-h-0 space-y-3">
          <div className="flex flex-col flex-1 min-h-[150px]">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={generating || saving}
              placeholder="No summary available yet. Write one manually, or click 'Generate Summary' to automatically summarize this session using the configured model."
              className="w-full flex-1 p-3 text-xs bg-x-surface-2 border border-x-line rounded-lg text-x-ink-secondary focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus resize-none leading-relaxed"
            />
          </div>

          {/* Model info banner */}
          <div className="px-3 py-2 rounded-lg bg-x-surface/30 border border-x-line-subtle flex items-start gap-2">
            <Sparkles size={13} className="text-x-accent mt-0.5 shrink-0" />
            <div className="text-[11px] leading-relaxed text-x-ink-secondary">
              <span className="font-semibold text-x-ink">Summarizer Model:</span> {modelInfo}
              <div className="text-x-faint text-[11px]">Resolved from {configSource}</div>
            </div>
          </div>

          {error && (
            <div className="text-xs text-x-accent-ink bg-x-accent-ink/10 border border-x-accent-ink/20 rounded-md px-3 py-2 flex items-start gap-1.5">
              <AlertCircle size={13} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-x-line">
          <div className="flex items-center gap-2">
            <Button type="submit"
              onClick={handleGenerate}
              disabled={generating || saving}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-x-line-subtle text-x-accent hover:bg-x-accent/5 hover:border-x-accent/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw size={12} className={generating ? 'animate-spin' : ''} />
              {generating ? 'Generating...' : 'Generate Summary'}
            </Button>
            {canShowGraph && (
              <Button type="submit"
                onClick={() => setShowGraph(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-x-line-subtle text-x-ink-secondary hover:bg-x-hover hover:text-x-ink hover:border-x-line-strong transition-colors"
                title="Show the files this session touched, on the workspace code graph"
              >
                <Activity size={12} />
                What changed on the graph
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button type="submit"
              onClick={onClose}
              disabled={generating || saving}
              className="px-3 py-1.5 text-xs font-medium text-x-ink-secondary bg-x-surface hover:bg-x-hover transition-colors disabled:opacity-50"
            >
              Cancel
            </Button>
            <Button type="submit"
              onClick={handleSave}
              disabled={generating || saving}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[.98]"
            >
              <Check size={12} />
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </div>
    </div>

    {/* Layered ABOVE the dialog rather than replacing it: closing the graph must
        return to an unsaved summary draft exactly as it was left. */}
    {showGraph && canShowGraph && (
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-x-scrim backdrop-blur-[4px] p-4"
        onClick={() => {
          if (graphCanvasRef.current) graphCanvasRef.current.requestClose(() => setShowGraph(false))
          else setShowGraph(false)
        }}
      >
        <div
          className="x-panel w-full max-w-6xl h-[86vh] flex flex-col scale-in"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Suspense covers the lazy chunk's LOADING; a boundary is what covers it
              throwing (chunk fetch failure, a render error in the graph) — without
              one that takes the whole app down, draft summary included. */}
          <PanelBoundary onClose={() => setShowGraph(false)}>
            <Suspense fallback={<div className="flex-1 p-4 text-xs text-x-faint">Loading graph…</div>}>
              {/* No untilIso — the window runs from the session's start to now, so a
                  run that is still going keeps accumulating into its own view. */}
              <WorkspaceChangesCanvas
                ref={graphCanvasRef}
                workspaceId={session.workspace_id}
                sinceIso={startedIso}
                title={`What changed · ${session.name || 'session'}`}
                onClose={() => setShowGraph(false)}
              />
            </Suspense>
          </PanelBoundary>
        </div>
      </div>
    )}
    </>
  )
}
