import { useMemo } from 'react'
import useStore from '../../state/store'
import { parseTokens } from '../../lib/tokens'

/**
 * TokenChips — live preview row for `@`-tokens detected in a composer
 * input. Renders one chip per detected token (resolved tokens get a
 * colored chip with a preview of what they expand to; unresolved
 * tokens get a red chip flagging the typo).
 *
 * Designed to sit immediately below a textarea / input so the user
 * can see, before they hit submit, exactly what each `@token` will
 * become when the message is sent to Claude.
 *
 * Hidden when the input contains no recognized tokens.
 */
export default function TokenChips({ text, sessionId, className = '' }) {
  const prompts = useStore((s) => s.prompts)

  const tokens = useMemo(
    () => parseTokens(text || '', { prompts }),
    [text, prompts],
  )

  if (tokens.length === 0) return null

  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      <span className="text-[9px] uppercase tracking-wider text-text-faint font-mono mr-1">
        tokens
      </span>
      {tokens.map((t, i) => (
        <span
          key={i}
          title={t.tooltip}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono border ${t.style} max-w-[280px] truncate`}
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
    </div>
  )
}
