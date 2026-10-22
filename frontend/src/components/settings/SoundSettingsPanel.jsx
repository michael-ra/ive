import { Volume2, VolumeX, Play } from 'lucide-react'
import useStore from '../../state/store'
import { SOUNDS } from '../../lib/sounds'
import { Button, IconButton } from '../ui'

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

function Toggle({ value, onChange, label }) {
  return (
    <Button
      type="button"
      onClick={() => onChange(!value)}
      toggleState={value}
      shape="card"
      size="sm"
      aria-label={label}
      className="min-w-[70px] shrink-0"
    >
      {value ? 'On' : 'Off'}
    </Button>
  )
}

export default function SoundSettingsPanel() {
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
    <div className="h-full overflow-y-auto">
        <div className="p-5 space-y-4">
          {/* Master toggle */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {soundEnabled ? (
                <Volume2 size={16} className="text-x-accent" />
              ) : (
                <VolumeX size={16} className="text-x-muted" />
              )}
              <span className="text-sm text-x-ink font-medium">Enable sounds</span>
            </div>
            <Toggle
              value={soundEnabled}
              onChange={(v) => useStore.getState().setSoundEnabled(v)}
              label="Enable sounds"
            />
          </div>

          {/* Volume slider */}
          <div className={!soundEnabled ? 'opacity-40 pointer-events-none' : ''}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-x-ink-secondary font-medium">Volume</span>
              <span className="text-xs text-x-muted tabular-nums">{soundVolume}%</span>
            </div>
            <input
              type="range"
              min="5"
              max="100"
              value={soundVolume}
              onChange={(e) => useStore.getState().setSoundVolume(Number(e.target.value))}
              className="x-range w-full"
              style={{ '--x-range-value': `${soundVolume}%` }}
            />
          </div>

          {/* Test all */}
          <Button
            onClick={testAll}
            disabled={!soundEnabled}
          >
            Preview all sounds
          </Button>

          <div className="border-t border-x-line-subtle" />

          {/* Per-event toggles */}
          <div className="text-xs text-x-ink-secondary font-medium">
            Play sound when
          </div>
          <div className={`space-y-3 ${!soundEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
            {SOUND_EVENTS.map((evt) => {
              const value = useStore((s) => s[evt.key])
              return (
                <div key={evt.key} className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-x-ink font-medium">{evt.label}</div>

                  </div>
                  <IconButton
                    icon={Play}
                    label={`Preview "${evt.label}" sound`}
                    size="sm"
                    onClick={() => testSound(evt.key)}
                  />
                  <Toggle
                    value={value}
                    onChange={(v) => useStore.getState()[evt.setter](v)}
                    label={`Play sound when ${evt.label.toLowerCase()}`}
                  />
                </div>
              )
            })}
          </div>
        </div>
    </div>
  )
}
