import { useEffect } from 'react'
import { ListOrdered, X, RotateCcw, Loader2, Pause, Play } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'

/**
 * CascadeBar — shows a visible progress bar for the active session's
 * cascade. Step advancement is now handled server-side by cascade_runner.py,
 * so there is no longer a browser-side CascadeEngine driving the loop.
 * The store receives cascade_progress / cascade_completed WebSocket events
 * and updates cascadeRunners state accordingly.
 */
export default function CascadeBar() {
  const activeSessionId = useStore((s) => s.activeSessionId)
  const allRunners = useStore((s) => s.cascadeRunners)
  const runner = activeSessionId ? allRunners[activeSessionId] : null
  const sessionStatus = useStore((s) => {
    if (!activeSessionId) return null
    return s.sessions[activeSessionId]?.status
  })
  const stopCascade = useStore((s) => s.stopCascade)

  // ⌘+Esc stops the active session's cascade
  useEffect(() => {
    if (!runner?.running) return
    const handler = (e) => {
      if (e.key === 'Escape' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        e.stopPropagation()
        stopCascade(activeSessionId)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [runner?.running, stopCascade, activeSessionId])

  // Only show for active session
  if (!runner) return null

  return <CascadeBarUI runner={runner} sessionStatus={sessionStatus} onStop={() => stopCascade(activeSessionId)} />
}

function CascadeBarUI({ runner, sessionStatus, onStop }) {
  const { name, steps, currentStep, totalSteps, loop, running, iteration, status, runId } = runner
  const stepNum = currentStep + 1
  const total = totalSteps || (steps ? steps.length : 0)
  const currentPrompt = steps ? (steps[currentStep] || '') : ''
  const progress = total > 0 ? (stepNum / total) * 100 : 0

  const handlePause = async () => {
    if (runId) {
      try {
        await api.updateCascadeRun(runId, 'pause')
      } catch (e) {
        console.error('cascade: failed to pause', e)
      }
    }
  }

  const handleResume = async () => {
    if (runId) {
      try {
        await api.updateCascadeRun(runId, 'resume')
      } catch (e) {
        console.error('cascade: failed to resume', e)
      }
    }
  }

  const isPaused = status === 'paused'
  const isWaiting = status === 'waiting_idle'

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-indigo-500/10 border-t border-indigo-500/20 text-xs">
      <ListOrdered size={12} className="text-indigo-400 shrink-0" />
      <span className="text-indigo-300 font-mono font-medium truncate max-w-[120px]">
        {name}
      </span>

      <span className="text-text-faint font-mono">
        {running || isPaused ? (
          <>
            step {stepNum}/{total}
            {loop && iteration > 0 && (
              <span className="text-indigo-400/60 ml-1">loop #{iteration + 1}</span>
            )}
          </>
        ) : (
          'done'
        )}
      </span>

      <div className="flex-1 h-1 bg-bg-tertiary rounded-full overflow-hidden max-w-[200px]">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            isPaused ? 'bg-amber-400/60' : 'bg-indigo-400/60'
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>

      {(running || isPaused) && (
        <span className="text-[10px] text-text-faint font-mono truncate max-w-[250px]" title={currentPrompt}>
          {currentPrompt.length > 60 ? currentPrompt.slice(0, 60) + '...' : currentPrompt}
        </span>
      )}

      {isPaused && (
        <span className="text-[10px] text-amber-400 font-mono">paused</span>
      )}
      {isWaiting && (
        <Loader2 size={11} className="text-indigo-400 animate-spin shrink-0" />
      )}

      {/* Server-side indicator */}
      <span className="text-[9px] text-indigo-400/40 font-mono" title="Running on server — survives browser close">
        srv
      </span>

      {loop && (running || isPaused) && (
        <RotateCcw size={10} className="text-indigo-400/50 shrink-0" title="Looping" />
      )}

      {/* Pause/Resume button */}
      {running && (
        <button
          onClick={handlePause}
          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20 rounded transition-colors shrink-0"
          title="Pause cascade"
        >
          <Pause size={8} />
        </button>
      )}
      {isPaused && (
        <button
          onClick={handleResume}
          className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-green-500/10 hover:bg-green-500/20 text-green-400 border border-green-500/20 rounded transition-colors shrink-0"
          title="Resume cascade"
        >
          <Play size={8} />
        </button>
      )}

      {(running || isPaused) ? (
        <button
          onClick={onStop}
          className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium bg-red-500/15 hover:bg-red-500/25 text-red-400 border border-red-500/25 rounded transition-colors shrink-0"
          title="Stop cascade (⌘+Esc)"
        >
          <X size={9} />
          stop
        </button>
      ) : (
        <button
          onClick={onStop}
          className="text-[10px] text-text-faint hover:text-text-secondary px-1"
        >
          dismiss
        </button>
      )}
    </div>
  )
}
