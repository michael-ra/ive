// CatchUpBanner — top-of-app conditional strip that surfaces missed
// activity when the local "last seen" timestamp is stale (>30 min).
//
// The logic lives in hooks/useCatchUp.js (the redesign shows it as a dot
// badge on Board instead of this strip); this strip remains until the new
// shell replaces it. `touchLastSeen` stays exported from here for App.jsx.
import useCatchUp, { touchLastSeen } from '../../hooks/useCatchUp'

export { touchLastSeen }

export default function CatchUpBanner({ onOpenPanel }) {
  const { digest, stale, dismiss } = useCatchUp()
  if (!stale || !digest) return null

  return (
    <div className="flex items-start gap-3 border-b border-x-line bg-x-surface px-3 py-2 text-[13px] text-x-ink">
      <span aria-hidden className="mt-0.5 text-x-accent-ink">●</span>
      <div className="min-w-0 flex-1 leading-relaxed">
        <span className="font-medium">Catch up:</span>{' '}
        <span className="text-x-ink-secondary">{digest.summary || digest.summary_basic || `${digest.total_events} events since you were last here.`}</span>
      </div>
      <button
        type="button"
        onClick={() => onOpenPanel?.(digest)}
        className="mt-0.5 inline-flex h-6 shrink-0 items-center rounded-full border border-x-line px-2.5 text-xs font-medium text-x-ink-secondary transition-colors duration-[80ms] hover:border-x-line-strong hover:bg-x-hover hover:text-x-ink"
        title="Open the full catch-up briefing"
      >
        View
      </button>
      <button
        type="button"
        onClick={dismiss}
        className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs text-x-muted transition-colors duration-[80ms] hover:bg-x-hover hover:text-x-ink"
        title="Dismiss this catch-up"
        aria-label="Dismiss catch-up"
      >
        ✕
      </button>
    </div>
  )
}
