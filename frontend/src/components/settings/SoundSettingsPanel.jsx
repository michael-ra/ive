import { Volume2, VolumeX, Bell, X, Play } from 'lucide-react'
import useStore from '../../state/store'
import { SOUNDS } from '../../lib/sounds'

const SOUND_EVENTS = [
  {
    key: 'soundOnSessionDone',
    setter: 'setSoundOnSessionDone',
    label: 'Session finished',
    desc: 'A session exits or finishes working',
  },
  {
    key: 'soundOnAgentDone',
    setter: 'setSoundOnAgentDone',
    label: 'Agent completed',
    desc: 'A sub-agent finishes its task',
  },
  {
    key: 'soundOnPlanReady',
    setter: 'setSoundOnPlanReady',
    label: 'Plan ready',
    desc: 'A plan is ready for review',
  },
  {
    key: 'soundOnInputNeeded',
    setter: 'setSoundOnInputNeeded',
    label: 'Input needed',
    desc: 'A session needs your permission or input',
  },
]

function Toggle({ value, onChange }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${
        value ? 'bg-green-500' : 'bg-zinc-600'
      }`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
          value ? 'left-[18px]' : 'left-0.5'
        }`}
      />
    </button>
  )
}

export default function SoundSettingsPanel({ onClose }) {
  const soundEnabled = useStore((s) => s.soundEnabled)
  const soundVolume = useStore((s) => s.soundVolume)

  const testSound = (key) => {
    const fn = SOUNDS[key]
    if (fn) fn(soundVolume / 100)
  }

  const testAll = () => {
    let delay = 0
    for (const evt of SOUND_EVENTS) {
      setTimeout(() => testSound(evt.key), delay)
      delay += 600
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[440px] ide-panel overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary">
          <Bell size={14} className="text-amber-400" />
          <span className="text-xs text-text-primary font-medium">Sound Notifications</span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Master toggle */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {soundEnabled ? (
                <Volume2 size={16} className="text-green-400" />
              ) : (
                <VolumeX size={16} className="text-text-faint" />
              )}
              <span className="text-sm text-text-primary font-medium">Enable sounds</span>
            </div>
            <Toggle
              value={soundEnabled}
              onChange={(v) => useStore.getState().setSoundEnabled(v)}
            />
          </div>

          {/* Volume slider */}
          <div className={!soundEnabled ? 'opacity-40 pointer-events-none' : ''}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-text-secondary">Volume</span>
              <span className="text-xs text-text-faint font-mono">{soundVolume}%</span>
            </div>
            <input
              type="range"
              min="5"
              max="100"
              value={soundVolume}
              onChange={(e) => useStore.getState().setSoundVolume(Number(e.target.value))}
              className="w-full accent-accent-primary"
            />
          </div>

          {/* Test all */}
          <button
            onClick={testAll}
            disabled={!soundEnabled}
            className="px-3 py-1.5 text-xs font-medium bg-accent-subtle hover:bg-accent-primary/20 text-indigo-400 rounded-md transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            Preview all sounds
          </button>

          <div className="border-t border-border-secondary" />

          {/* Per-event toggles */}
          <div className="text-[10px] text-text-faint font-medium uppercase tracking-wider">
            Play sound when
          </div>
          <div className={`space-y-3 ${!soundEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
            {SOUND_EVENTS.map((evt) => {
              const value = useStore((s) => s[evt.key])
              return (
                <div key={evt.key} className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-text-primary">{evt.label}</div>
                    <div className="text-[10px] text-text-faint">{evt.desc}</div>
                  </div>
                  <button
                    onClick={() => testSound(evt.key)}
                    className="p-1 rounded-md text-text-faint hover:text-text-secondary hover:bg-bg-hover transition-colors shrink-0"
                    title={`Preview "${evt.label}" sound`}
                  >
                    <Play size={11} />
                  </button>
                  <Toggle
                    value={value}
                    onChange={(v) => useStore.getState()[evt.setter](v)}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
