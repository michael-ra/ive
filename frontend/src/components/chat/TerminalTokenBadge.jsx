import { useMemo } from 'react'
import { X } from 'lucide-react'
import useStore from '../../state/store'
import { parseTokens } from '../../lib/tokens'

/**
 * TerminalTokenBadge — floating chip overlay in the top-right of a
 * terminal pane. Reads the per-session input buffer maintained by
 * terminalInputTracker, scans for `@`-tokens, and surfaces them so
 * the user gets visual confirmation that the system recognized their
 * `@prompt:foo` / `@research` / `@ralph`.
 *
 * Enter auto-expansion is handled in Terminal.jsx's
 * attachCustomKeyEventHandler — when the user presses Enter and the
 * buffer has resolvable tokens, it swallows Enter and re-routes
 * through sendTerminalCommand (which does Escape-clear + expanded
 * text + Enter). The badge just shows the user what was detected.
 */
export default function TerminalTokenBadge({ sessionId }) {
  const buffer = useStore((s) => s.inputBuffers[sessionId] || '')
  const prompts = useStore((s) => s.prompts)

  const tokens = useMemo(
    () => parseTokens(buffer, { prompts }),
    [buffer, prompts],
  )

  if (tokens.length === 0) return null

  const hasResolvable = tokens.some((t) => t.kind !== 'unknown')

  const handleDismiss = (e) => {
    e?.stopPropagation?.()
    useStore.getState().setInputBuffer(sessionId, '')
  }

  return (
    <div className="absolute top-2 right-2 z-20 pointer-events-none flex justify-end max-w-[70%]">
      <div className="pointer-events-auto flex items-center gap-1.5 px-2 py-1 bg-bg-elevated/95 border border-border-primary rounded-md shadow-lg backdrop-blur-sm">
        {tokens.map((t, i) => (
          <span
            key={i}
            title={t.tooltip}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono border ${t.style} max-w-[200px] truncate`}
          >
            <span className="font-semibold shrink-0">{t.label}</span>
            {t.preview && (
              <>
                <span className="opacity-50 shrink-0">→</span>
                <span className="opacity-80 truncate">{t.preview}</span>
              </>
            )}
          </span>
        ))}
        {hasResolvable && (
          <span className="text-[9px] text-text-faint font-mono select-none ml-1">
            ↵ expands
          </span>
        )}
        <button
          onClick={handleDismiss}
          title="Dismiss"
          className="p-0.5 text-text-faint hover:text-text-secondary"
        >
          <X size={10} />
        </button>
      </div>
    </div>
  )
}
