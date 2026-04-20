import { FileCode, Check, X, Eye } from 'lucide-react'
import useStore from '../../state/store'
import { typeInTerminal } from '../../lib/terminal'

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
            className="bg-[#161622] border border-cyan-500/30 rounded-lg shadow-2xl overflow-hidden slide-in-from-right"
          >
            <div className="flex items-center gap-1 px-2.5 py-1.5 bg-cyan-500/10 border-b border-cyan-500/20">
              <FileCode size={12} className="text-cyan-400" />
              <span className="text-[11px] font-mono text-cyan-300 flex-1 truncate">
                {session?.name || capture.session_id.slice(0, 8)} — code change
              </span>
              <button
                onClick={() => useStore.getState().resolveCapture(capture.id)}
                className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                <X size={12} />
              </button>
            </div>

            <div className="px-2.5 py-1.5">
              <pre className="text-[11px] font-mono text-zinc-400 leading-relaxed max-h-24 overflow-y-auto whitespace-pre-wrap">
                {capture.raw_text?.substring(0, 500) || 'Edit/Write detected'}
              </pre>
            </div>

            <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-zinc-800">
              <button
                onClick={() => handleApprove(capture)}
                className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-mono bg-green-600/20 hover:bg-green-600/30 text-green-300 border border-green-500/30 rounded transition-colors"
              >
                <Check size={9} />
                approve
              </button>
              <button
                onClick={() => handleReject(capture)}
                className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-mono bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-500/30 rounded transition-colors"
              >
                <X size={9} />
                reject
              </button>
              <button
                onClick={() => handleFocus(capture)}
                className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] font-mono text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800 rounded transition-colors ml-auto"
              >
                <Eye size={9} />
                view
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
