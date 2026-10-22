// The one status glyph: a dot for Running (pulsing, with a ring), Waiting
// and Stopped, a check for Done and a cross for Failed. Colours come from the
// --x-running/-waiting/-done/-failed/-stopped tokens (index.css .ive-dot).
export default function StatusDot({ state = 'stopped', pulse, className = '', title }) {
  const animate = pulse ?? state === 'running'
  return (
    <span
      className={`ive-dot${animate ? ' is-pulse' : ''}${className ? ` ${className}` : ''}`}
      data-state={state}
      aria-hidden="true"
      title={title}
    >
      {state === 'done' && (
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8.5l3 3 7-7" />
        </svg>
      )}
      {state === 'failed' && (
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      )}
    </span>
  )
}
