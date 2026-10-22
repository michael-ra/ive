import { IA_GROUPS } from '../../lib/informationArchitecture'

export default function PrimaryNavigation({ activeGroup, onSelect, compact = false }) {
  return (
    <nav
      aria-label="Primary"
      className={compact
        ? 'ive-primary-nav flex w-full items-center gap-1 p-2'
        : 'ive-primary-nav hidden lg:flex items-center gap-1 self-center mr-2'}
    >
      {IA_GROUPS.map((group) => {
        const isCurrent = activeGroup === group.id
        return (
          <button
            key={group.id}
            type="button"
            data-ia-group={group.id}
            aria-current={isCurrent ? 'page' : undefined}
            onClick={() => onSelect(group.id)}
            title={`${group.label}: ${group.description}`}
            className={`min-h-9 rounded-md border px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-x-accent-ink ${compact ? 'flex-1' : ''} ${
              isCurrent
                ? 'border-x-tint-line bg-x-tint text-x-accent-ink'
                : 'border-transparent text-x-muted hover:text-x-ink hover:bg-x-hover'
            }`}
          >
            {group.label}
          </button>
        )
      })}
    </nav>
  )
}
