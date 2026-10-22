import { FileCode, Check, X, Eye } from 'lucide-react'
import useStore from '../../state/store'
import { typeInTerminal } from '../../lib/terminal'
import { Button } from '../ui'

export default function CodePreview() {
  const captures = useStore((s) => s.pendingCaptures)
  const sessions = useStore((s) => s.sessions)

  const editCaptures = captures.filter((c) => c.capture_type === 'edit_diff')

  if (editCaptures.length === 0) return null

  const handleApprove = (capture) => {
    typeInTerminal(capture.session_id, 'y\r')
    useStore.getState().resolveCapture(capture.id)
  }

  const handleReject = (capture) => {
    typeInTerminal(capture.session_id, 'n\r')
    useStore.getState().resolveCapture(capture.id)
  }

  const handleFocus = (capture) => {
    const store = useStore.getState()
    if (!store.openTabs.includes(capture.session_id)) {
      store.openSession(capture.session_id)
    } else {
      store.setActiveSession(capture.session_id)
    }
    useStore.getState().resolveCapture(capture.id)
  }

  return (
    <div className="fixed bottom-12 right-3 z-40 flex flex-col gap-1 max-w-sm">
      {editCaptures.slice(0, 5).map((capture) => {
        const session = sessions[capture.session_id]
        return (
          <div
            key={capture.id}
            className="bg-x-surface border border-x-line rounded-lg shadow-x-3 overflow-hidden slide-in-from-right"
          >
            <div className="flex items-center gap-1 px-2.5 py-1.5 bg-x-surface-2 border-b border-x-line">
              <FileCode size={12} className="text-x-accent" />
              <span className="text-[11px] font-medium text-x-accent flex-1 truncate">
                {session?.name || capture.session_id.slice(0, 8)} — code change
              </span>
              <Button type="submit"
                onClick={() => useStore.getState().resolveCapture(capture.id)}
                className="p-1.5 hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms]"
              >
                <X size={12} />
              </Button>
            </div>

            <div className="px-2.5 py-1.5">
              <pre className="text-[11px] font-mono text-x-muted leading-relaxed max-h-24 overflow-y-auto whitespace-pre-wrap">
                {capture.raw_text?.substring(0, 500) || 'Edit/Write detected'}
              </pre>
            </div>

            <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-x-line">
              <Button type="submit"
                onClick={() => handleApprove(capture)}
                className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-medium bg-x-good/15 hover:bg-x-good/25 text-x-good border border-x-good/30 transition-colors duration-[80ms]"
              >
                <Check size={9} />
                approve
              </Button>
              <Button type="submit"
                onClick={() => handleReject(capture)}
                className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-medium bg-x-accent-ink/15 hover:bg-x-accent-ink/25 text-x-accent-ink border border-x-accent-ink/30 transition-colors duration-[80ms]"
              >
                <X size={9} />
                reject
              </Button>
              <Button type="submit"
                onClick={() => handleFocus(capture)}
                className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-medium text-x-muted hover:text-x-ink-secondary hover:bg-x-hover transition-colors duration-[80ms] ml-auto"
              >
                <Eye size={9} />
                view
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
