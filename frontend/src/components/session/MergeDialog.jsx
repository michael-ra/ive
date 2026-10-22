import { useState } from 'react'
import { X, GitMerge, Plus, ArrowRight, Trash2, Check } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { Button } from '../ui'

export default function MergeDialog({ onClose }) {
  const sessions = useStore((s) => s.sessions)
  const selectedSessionIds = useStore((s) => s.selectedSessionIds)
  const selectionWorkspaceId = useStore((s) => s.selectionWorkspaceId)
  const clearSessionSelection = useStore((s) => s.clearSessionSelection)
  const addSession = useStore((s) => s.addSession)

  const [mode, setMode] = useState('new') // 'new' | 'existing'
  const [targetId, setTargetId] = useState('')
  const [deleteSources, setDeleteSources] = useState(false)
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState(null)

  const selectedSessions = selectedSessionIds
    .map((id) => sessions[id])
    .filter(Boolean)

  // Sessions in same workspace that are NOT selected (potential merge targets)
  const availableTargets = Object.values(sessions).filter(
    (s) => s.workspace_id === selectionWorkspaceId && !selectedSessionIds.includes(s.id)
  )

  const handleMerge = async () => {
    setMerging(true)
    setError(null)
    try {
      const result = await api.mergeSessions(
        selectedSessionIds,
        mode === 'existing' ? targetId : null,
        selectionWorkspaceId
      )
      const { session, context } = result
      const store = useStore.getState()

      // Close source session tabs + optionally delete from DB
      for (const srcId of selectedSessionIds) {
        // Stop the PTY if running
        if (store.sessions[srcId]?.status === 'running') {
          store.stopSession(srcId)
        }
        // Close the tab
        store.closeTab(srcId)

        if (deleteSources) {
          try {
            await api.deleteSession(srcId)
            store.removeSession(srcId)
          } catch { /* ignore if already gone */ }
        }
      }

      // Add session to store + open it
      if (mode === 'new') {
        addSession(session)
      } else {
        if (!store.openTabs.includes(session.id)) {
          store.openSession(session.id)
        } else {
          store.setActiveSession(session.id)
        }
      }

      // Send context as PTY input after a delay to let PTY initialize
      const sendContext = () => {
        const ws = useStore.getState().ws
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            action: 'input',
            session_id: session.id,
            data: context + '\n',
          }))
        }
      }

      // For new sessions, wait for PTY to start; for existing, send immediately
      if (mode === 'new') {
        setTimeout(sendContext, 3000)
      } else {
        setTimeout(sendContext, 500)
      }

      clearSessionSelection()
      onClose()
    } catch (err) {
      setError(err.message || 'Merge failed')
    } finally {
      setMerging(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-x-scrim backdrop-blur-[4px]">
      <div className="x-panel w-[480px] max-h-[80vh] flex flex-col scale-in">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-x-line">
          <div className="flex items-center gap-2">
            <GitMerge size={16} className="text-x-accent" />
            <h2 className="text-sm font-semibold text-x-ink">Merge Sessions</h2>
          </div>
          <Button type="submit"
            onClick={onClose}
            className="p-1 hover:bg-x-hover text-x-muted hover:text-x-ink-secondary transition-colors"
          >
            <X size={16} />
          </Button>
        </div>

        {/* Source sessions */}
        <div className="px-4 py-3 border-b border-x-line-subtle">
          <div className="text-xs font-medium text-x-ink-secondary mb-2">
            Merging {selectedSessions.length} sessions
          </div>
          <div className="space-y-1 max-h-[120px] overflow-y-auto">
            {selectedSessions.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-x-surface-2 text-xs"
              >
                <span className="text-x-ink font-medium truncate flex-1">{s.name}</span>
                <span className="text-x-faint font-mono text-[11px]">{s.model}</span>
                <span className="text-x-faint font-mono text-[11px]">
                  {s.turn_count || 0} turns
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Target selection */}
        <div className="px-4 py-3 space-y-3">
          <div className="text-xs font-medium text-x-ink-secondary">
            Merge into
          </div>

          <div className="flex gap-2">
            <Button type="submit"
              onClick={() => setMode('new')}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium border transition-all ${
                mode === 'new'
                  ? 'bg-x-accent-subtle text-x-accent border-x-accent/30'
                  : 'text-x-ink-secondary border-x-line-subtle hover:border-x-line hover:bg-x-hover'
              }`}
            >
              <Plus size={12} />
              New Session
            </Button>
            <Button type="submit"
              onClick={() => setMode('existing')}
              disabled={availableTargets.length === 0}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium border transition-all ${
                mode === 'existing'
                  ? 'bg-x-accent-subtle text-x-accent border-x-accent/30'
                  : 'text-x-ink-secondary border-x-line-subtle hover:border-x-line hover:bg-x-hover'
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              <ArrowRight size={12} />
              Existing Session
            </Button>
          </div>

          {mode === 'existing' && (
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="w-full px-2 py-2 text-xs bg-x-surface-2 border border-x-line rounded-md text-x-ink-secondary font-mono focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
            >
              <option value="">Select a session...</option>
              {availableTargets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.model})
                </option>
              ))}
            </select>
          )}

          {/* Delete sources option */}
          <label className="flex items-center gap-2 cursor-pointer group">
            <span
              onClick={() => setDeleteSources(!deleteSources)}
              className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                deleteSources
                  ? 'bg-x-accent-ink border-x-accent-ink'
                  : 'border-x-line-strong hover:border-x-muted'
              }`}
            >
              {deleteSources && <Check size={10} className="text-x-on-accent" />}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-x-ink-secondary group-hover:text-x-ink transition-colors">
              <Trash2 size={11} className={deleteSources ? 'text-x-accent-ink' : 'text-x-faint'} />
              Delete source sessions after merge
            </span>
          </label>

          <div className="text-[11px] text-x-faint leading-relaxed">
            Source sessions will be closed{deleteSources ? ' and permanently deleted' : ''} after merge.
            The {mode === 'new' ? 'new' : 'target'} session will receive a summarized context
            with instructions to internalize the merged knowledge.
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 pb-2">
            <div className="text-xs text-x-accent-ink bg-x-accent-ink/10 border border-x-accent-ink/20 rounded-md px-3 py-2">
              {error}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-x-line">
          <Button type="submit"
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-medium text-x-ink-secondary bg-x-surface hover:bg-x-hover transition-colors"
          >
            Cancel
          </Button>
          <Button type="submit"
            onClick={handleMerge}
            disabled={merging || (mode === 'existing' && !targetId)}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[.98]"
          >
            <GitMerge size={12} />
            {merging ? 'Merging...' : `Merge ${selectedSessions.length} Sessions`}
          </Button>
        </div>
      </div>
    </div>
  )
}
