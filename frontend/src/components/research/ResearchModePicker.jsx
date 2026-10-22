import Chip from '../ui/Chip'
import { RESEARCH_MODES, normalizeResearchModes } from '../../lib/researchModes'

export default function ResearchModePicker({ value, onChange, compact = false }) {
  const selected = normalizeResearchModes(value)
  const toggle = (key) => {
    if (selected.includes(key)) {
      if (selected.length > 1) onChange(selected.filter((item) => item !== key))
      return
    }
    onChange([...selected, key])
  }

  return (
    <div className={compact ? 'flex flex-wrap gap-1.5' : 'grid grid-cols-1 sm:grid-cols-2 gap-2'} data-testid="research-mode-picker">
      {RESEARCH_MODES.map((mode) => {
        const active = selected.includes(mode.key)
        return (
          <button
            key={mode.key}
            type="button"
            data-research-mode={mode.key}
            aria-pressed={active}
            onClick={() => toggle(mode.key)}
            className={`text-left rounded-md border transition-colors ${compact ? 'p-0 border-0' : 'px-3 py-2'} ${
              active
                ? 'border-x-accent/35 bg-x-accent/10 text-x-accent'
                : 'border-x-line-subtle bg-x-bg/40 text-x-ink-secondary hover:bg-x-hover'
            }`}
          >
            {compact ? (
              <Chip color={active ? 'accent' : 'neutral'} className="rounded-full">{mode.label}</Chip>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Chip color={active ? 'accent' : 'neutral'} className="rounded-full">{mode.label}</Chip>
                  {active && <span className="text-[11px] text-x-accent">selected</span>}
                </div>
                <div className="text-[11px] text-x-faint mt-1">{mode.hint}</div>
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}
