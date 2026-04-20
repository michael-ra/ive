import { useState } from 'react'
import { X, GitMerge, Plus, ArrowRight, Trash2, Check } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="ide-panel w-[480px] max-h-[80vh] flex flex-col scale-in">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-primary">
          <div className="flex items-center gap-2">
            <GitMerge size={16} className="text-accent-primary" />
            <h2 className="text-sm font-semibold text-text-primary">Merge Sessions</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-bg-hover text-text-muted hover:text-text-secondary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Source sessions */}
        <div className="px-4 py-3 border-b border-border-secondary">
          <div className="text-[10px] font-medium text-text-faint uppercase tracking-wider mb-2">
            Merging {selectedSessions.length} sessions
          </div>
          <div className="space-y-1 max-h-[120px] overflow-y-auto">
            {selectedSessions.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-bg-inset text-xs"
              >
                <span className="text-text-primary font-medium truncate flex-1">{s.name}</span>
                <span className="text-text-faint font-mono text-[10px]">{s.model}</span>
                <span className="text-text-faint font-mono text-[10px]">
                  {s.turn_count || 0} turns
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Target selection */}
        <div className="px-4 py-3 space-y-3">
          <div className="text-[10px] font-medium text-text-faint uppercase tracking-wider">
            Merge into
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setMode('new')}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border transition-all ${
                mode === 'new'
                  ? 'bg-accent-subtle text-accent-primary border-accent-primary/30'
                  : 'text-text-secondary border-border-secondary hover:border-border-primary hover:bg-bg-hover'
              }`}
            >
              <Plus size={12} />
              New Session
            </button>
            <button
              onClick={() => setMode('existing')}
              disabled={availableTargets.length === 0}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border transition-all ${
                mode === 'existing'
                  ? 'bg-accent-subtle text-accent-primary border-accent-primary/30'
                  : 'text-text-secondary border-border-secondary hover:border-border-primary hover:bg-bg-hover'
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              <ArrowRight size={12} />
              Existing Session
            </button>
          </div>

          {mode === 'existing' && (
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="w-full px-2 py-2 text-xs bg-bg-inset border border-border-primary rounded-md text-text-secondary font-mono focus:outline-none focus:border-accent-primary/50 ide-focus-ring"
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
                  ? 'bg-red-500 border-red-500'
                  : 'border-border-accent hover:border-text-muted'
              }`}
            >
              {deleteSources && <Check size={10} className="text-white" />}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-text-secondary group-hover:text-text-primary transition-colors">
              <Trash2 size={11} className={deleteSources ? 'text-red-400' : 'text-text-faint'} />
              Delete source sessions after merge
            </span>
          </label>

          <div className="text-[10px] text-text-faint leading-relaxed">
            Source sessions will be closed{deleteSources ? ' and permanently deleted' : ''} after merge.
            The {mode === 'new' ? 'new' : 'target'} session will receive a summarized context
            with instructions to internalize the merged knowledge.
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 pb-2">
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
              {error}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border-primary">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-medium text-text-secondary bg-bg-tertiary hover:bg-bg-hover rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleMerge}
            disabled={merging || (mode === 'existing' && !targetId)}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium bg-accent-primary hover:bg-accent-hover text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <GitMerge size={12} />
            {merging ? 'Merging...' : `Merge ${selectedSessions.length} Sessions`}
          </button>
        </div>
      </div>
    </div>
  )
}
