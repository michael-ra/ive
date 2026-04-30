import { useEffect, useRef, useState } from 'react'
import { Square, StickyNote, RotateCcw, Shuffle } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'

export default function TopBar() {
  const session = useStore((s) => s.sessions[s.activeSessionId])
  const activeSessionId = useStore((s) => s.activeSessionId)
  const [showSwitcher, setShowSwitcher] = useState(false)
  const switcherBtnRef = useRef(null)
  const switcherMenuRef = useRef(null)
  const [switcherPos, setSwitcherPos] = useState(null)

  useEffect(() => {
    if (!showSwitcher) return
    // Anchor the menu in viewport coords so it escapes the TopBar's
    // overflow-x-auto container, which would otherwise clip it.
    const r = switcherBtnRef.current?.getBoundingClientRect()
    if (r) setSwitcherPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
    const onDocClick = (e) => {
      if (switcherMenuRef.current?.contains(e.target)) return
      if (switcherBtnRef.current?.contains(e.target)) return
      setShowSwitcher(false)
    }
    const onResize = () => setShowSwitcher(false)
    document.addEventListener('mousedown', onDocClick)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [showSwitcher])

  if (!session) return null

  const isRunning = session.status === 'running'
  const isExited = session.status === 'exited'
  const currentCli = session.cli_type || 'claude'

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-secondary border-b border-border-primary text-xs overflow-x-auto tab-scroll-hide touch-manipulation">
      {/* Session info */}
      <div className="flex items-center gap-2">
        {session.cli_type === 'gemini' && (
          <span className="text-[10px] font-medium bg-blue-500/12 text-blue-400 px-1.5 py-0.5 rounded border border-blue-500/15">Gemini</span>
        )}
        {session.model && (
          <span className="text-text-secondary font-mono text-[11px]" title="Model">
            {session.model}
          </span>
        )}
        {session.plan_model && session.execute_model && (
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${
            session.model === session.plan_model
              ? 'bg-purple-500/12 text-purple-400 border-purple-500/15'
              : session.model === session.execute_model
                ? 'bg-green-500/12 text-green-400 border-green-500/15'
                : 'bg-zinc-500/12 text-zinc-400 border-zinc-500/15'
          }`}>
            {session.model === session.plan_model ? 'planning' :
             session.model === session.execute_model ? 'executing' : 'custom'}
          </span>
        )}
        {session.total_cost_usd > 0 && (
          <span className="text-text-faint font-mono text-[11px]">
            ${Number(session.total_cost_usd).toFixed(4)}
          </span>
        )}
      </div>

      <div className="flex-1" />

      {/* Actions */}
      <div className="flex items-center gap-1">
        {/* Switch CLI */}
        <div>
          <button
            ref={switcherBtnRef}
            data-chrome-button
            onClick={() => setShowSwitcher((s) => !s)}
            className="flex items-center gap-1.5 px-2 py-1 text-text-faint hover:text-text-secondary hover:bg-bg-hover rounded-md transition-colors"
            title="Switch CLI (Claude ↔ Gemini)"
          >
            <Shuffle size={11} />
            <span className="text-[11px]">switch</span>
          </button>
          {showSwitcher && switcherPos && (
            <div
              ref={switcherMenuRef}
              className="fixed ide-panel p-2 z-[60] w-52 space-y-1 scale-in"
              style={{ top: switcherPos.top, right: switcherPos.right }}
            >
              <div className="text-[10px] text-text-faint font-medium uppercase tracking-wider mb-1">Switch to:</div>
              {[
                { cli: 'claude', model: 'sonnet', label: 'Claude Sonnet' },
                { cli: 'claude', model: 'opus', label: 'Claude Opus' },
                { cli: 'claude', model: 'haiku', label: 'Claude Haiku' },
                { cli: 'gemini', model: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
                { cli: 'gemini', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
              ]
                .filter((o) => !(o.cli === currentCli && o.model === session.model))
                .map((opt) => (
                  <button
                    key={`${opt.cli}-${opt.model}`}
                    onClick={async () => {
                      setShowSwitcher(false)
                      if (!confirm(`Switch to ${opt.label}? The current session will be stopped and restarted. A context summary will be handed off.`)) return
                      try {
                        await api.switchSessionCli(activeSessionId, { cli_type: opt.cli, model: opt.model })
                      } catch (e) { console.error(e) }
                    }}
                    className={`w-full text-left px-2 py-1.5 text-xs font-medium rounded-md transition-colors border ${
                      opt.cli === 'gemini'
                        ? 'text-blue-400 border-blue-500/20 hover:bg-blue-500/10'
                        : 'text-indigo-400 border-indigo-500/20 hover:bg-accent-subtle'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
            </div>
          )}
        </div>

        <button
          data-chrome-button
          onClick={() => window.dispatchEvent(new CustomEvent('open-panel', { detail: 'scratchpad' }))}
          className="flex items-center gap-1.5 px-2 py-1 text-amber-400/50 hover:text-amber-400 hover:bg-amber-400/8 rounded-md transition-colors"
          title="Scratchpad (⌘J)"
        >
          <StickyNote size={11} />
          <span className="text-[11px]">pad</span>
        </button>

        {isExited && (
          <button
            data-chrome-button
            onClick={() => useStore.getState().restartSession(activeSessionId)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-green-400 hover:text-green-300 hover:bg-green-500/10 rounded-md transition-colors ml-1"
            title="Restart session"
          >
            <RotateCcw size={11} />
            <span className="text-[11px]">restart</span>
          </button>
        )}

        {isRunning && (
          <button
            data-chrome-button
            onClick={() => useStore.getState().stopSession(activeSessionId)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-md transition-colors ml-1"
            title="Stop session (⌘.)"
          >
            <Square size={11} />
            <span className="text-[11px]">stop</span>
          </button>
        )}
      </div>

      {/* Status dot */}
      <span className={`w-2 h-2 rounded-full ml-1 ${
        isRunning ? 'bg-green-400 animate-subtle-pulse' :
        isExited ? 'bg-yellow-400' : 'bg-zinc-700'
      }`} />
    </div>
  )
}
