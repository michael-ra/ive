import useStore from '../../state/store'
import MailboxPill from './MailboxPill'

export default function StatusBar() {
  const sessions = useStore((s) => s.sessions)
  const connected = useStore((s) => s.connected)

  const allSessions = Object.values(sessions)
  const runningCount = allSessions.filter((s) => s.status === 'running').length
  const totalCost = allSessions.reduce((sum, s) => sum + (Number(s.total_cost_usd) || 0), 0)

  return (
    <>
      {!connected && (
        <div className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-red-500/8 border-t border-red-500/20 text-xs text-red-400">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-subtle-pulse" />
          disconnected — reconnecting...
        </div>
      )}

      <div className="flex items-center h-6 px-2.5 bg-bg-inset border-t border-border-primary text-[11px] select-none">
        {/* Left section */}
        <div className="flex items-center gap-2.5">
          <div className={`flex items-center gap-1.5 px-1.5 py-0.5 -ml-1 rounded-sm ${connected ? 'text-text-faint' : 'text-red-400'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="font-mono text-[10px]">{connected ? 'ok' : 'off'}</span>
          </div>

          {allSessions.length > 0 && (
            <span className="text-text-faint font-mono text-[10px]">{allSessions.length} sessions</span>
          )}

          {runningCount > 0 && (
            <span className="flex items-center gap-1 text-green-500 font-mono text-[10px]">
              <span className="w-1 h-1 rounded-full bg-green-500 animate-subtle-pulse" />
              {runningCount} active
            </span>
          )}

          {totalCost > 0 && (
            <span className="text-text-faint font-mono text-[10px]">${totalCost.toFixed(4)}</span>
          )}

          <MailboxPill position="above" />
        </div>

        <div className="flex-1" />

        {/* Right section — keyboard hints */}
        <div className="hidden md:flex items-center gap-2 text-text-faint/60 font-mono text-[10px]">
          <span>⌘K</span>
          <span>⌘B</span>
          <span>⌘M</span>
          <span>⌘/</span>
          <span>⌘1-9</span>
          <span>⌘?</span>
        </div>
      </div>
    </>
  )
}
