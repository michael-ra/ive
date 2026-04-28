import { useCallback, useEffect, useRef, useState } from 'react'
import { Telescope, X, Mic, MicOff, Sparkles } from 'lucide-react'
import { api } from '../../lib/api'
import { useVoiceInput } from '../../hooks/useVoiceInput'

const QUESTIONS = [
  {
    key: 'vision',
    label: 'Vision — what is this product?',
    placeholder: 'In 1–2 sentences: what are you building, and what does the finished thing do for someone? Skip the implementation talk.',
    memoryName: 'Product vision',
    memoryDescription: 'One-paragraph product vision captured at workspace creation.',
  },
  {
    key: 'audience',
    label: 'Who is it for?',
    placeholder: 'Target users / customers / personas. e.g. "solo founders shipping AI products", "data teams at mid-market SaaS".',
    memoryName: 'Target audience',
    memoryDescription: 'Who the product is built for; informs voice-of-customer extraction.',
  },
  {
    key: 'competitors',
    label: 'Competitors or adjacent tools',
    placeholder: 'Anything you compare yourself to, even loosely. Comma-separated names + a hint of why each is on your radar.',
    memoryName: 'Competitor radar',
    memoryDescription: 'Named competitors and overlapping tools the user has on their radar.',
  },
  {
    key: 'differentiator',
    label: 'What makes it different?',
    placeholder: 'Why does this exist when those already do? What\'s the unfair angle / wedge?',
    memoryName: 'Differentiator',
    memoryDescription: 'How this project differentiates from competitors.',
  },
]

// How long to wait between each field beginning its reveal (top-to-bottom).
const STAGGER_MS = 220
// Per-character delay during the type-in animation.  ~22ms = ~45 chars/sec
// — fast enough to feel responsive, slow enough that the rainbow shimmer
// flowing through the partial text is visible.
const CHAR_MS = 22
// How long the shimmer keeps playing after the last character lands, before
// the text settles to plain. Apple's effect lingers a beat past completion.
const SHIMMER_TAIL_MS = 500
// Soft cap on how long any one field can spend revealing — stops a long
// paragraph from running for many seconds. Falls back to a faster char rate.
const MAX_REVEAL_MS = 2200

export default function WorkspaceVisionOnboarding({ workspace, onClose, onDone }) {
  const [answers, setAnswers] = useState(() =>
    QUESTIONS.reduce((m, q) => ({ ...m, [q.key]: '' }), {})
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  // Per-field flag — true while the rainbow shimmer is sweeping through the
  // newly-replaced text. False once the text has settled to plain.
  const [shimmering, setShimmering] = useState(() =>
    QUESTIONS.reduce((m, q) => ({ ...m, [q.key]: false }), {})
  )
  // 'idle' | 'thinking' | 'filling' — drives the overlay state.
  const [phase, setPhase] = useState('idle')

  // Accumulate transcript across multiple Web Speech API result events.
  // Refs (not state) — speech results fire faster than React batching.
  const transcriptRef = useRef('')

  const setAnswer = (key, value) =>
    setAnswers((prev) => ({ ...prev, [key]: value }))

  // ── Voice → transcript accumulation ───────────────────────────────────
  const handleVoiceResult = useCallback((text) => {
    if (!text) return
    transcriptRef.current += (transcriptRef.current ? ' ' : '') + text
  }, [])

  // flushOnStop: true — wait for pending speech to finalize before onend
  // fires, so transcriptRef is fully populated by the time runAutofill runs.
  // (Default abort() would discard any in-flight speech and leave us with an
  // empty transcript — the symptom: clicking stop appeared to "do nothing".)
  const { listening, toggle: toggleVoice } = useVoiceInput(
    handleVoiceResult,
    { flushOnStop: true },
  )

  // ── Autofill: when user stops talking, send transcript to /api/vision/autofill ─
  const runAutofill = useCallback(async () => {
    const transcript = transcriptRef.current.trim()
    transcriptRef.current = '' // reset so a second recording doesn't double-up
    if (!transcript) {
      // Silent failure used to leave the user staring at an unchanged form
      // wondering if the mic worked. Surface it.
      setError("Didn't catch any speech — click the mic and try again.")
      return
    }
    setError(null)
    setPhase('thinking')
    try {
      const result = await api.autofillVision(transcript)
      setPhase('filling')

      // For each field that has new content: type it character-by-character
      // into the textarea while the shimmer overlay sweeps through whatever
      // partial text is currently rendered. This is the Apple Writing-Tools
      // effect — letters tumble in with the iridescent gradient flowing
      // through them, then settle to plain a beat after the last character.
      let lastEndsAt = 0
      let pendingFinishes = 0
      QUESTIONS.forEach((q, i) => {
        const incoming = typeof result[q.key] === 'string' ? result[q.key].trim() : ''
        const current = answers[q.key] || ''
        if (!incoming || incoming === current) return // nothing to reveal

        // Adaptive char delay — long fields tighten so we don't drag.
        const charMs = Math.max(8, Math.min(CHAR_MS, MAX_REVEAL_MS / incoming.length))
        const startDelay = i * STAGGER_MS
        const revealDur = incoming.length * charMs
        const endsAt = startDelay + revealDur + SHIMMER_TAIL_MS
        if (endsAt > lastEndsAt) lastEndsAt = endsAt
        pendingFinishes += 1

        setTimeout(() => {
          // Wipe any prior content and start the type-in. shimmer overlay
          // tracks the textarea value so it auto-shows partial text styled
          // with the rainbow gradient.
          setAnswers((prev) => ({ ...prev, [q.key]: '' }))
          setShimmering((prev) => ({ ...prev, [q.key]: true }))
          let charIdx = 0
          const tick = () => {
            charIdx += 1
            const slice = incoming.slice(0, charIdx)
            setAnswers((prev) => ({ ...prev, [q.key]: slice }))
            if (charIdx < incoming.length) {
              setTimeout(tick, charMs)
            } else {
              // Last character placed — let the shimmer linger briefly,
              // then settle the text to plain.
              setTimeout(() => {
                setShimmering((prev) => ({ ...prev, [q.key]: false }))
                pendingFinishes -= 1
                if (pendingFinishes <= 0) setPhase('idle')
              }, SHIMMER_TAIL_MS)
            }
          }
          tick()
        }, startDelay)
      })

      // Defensive: if no field changed (e.g. the LLM returned all empties),
      // pendingFinishes never increments and phase would stick. Catch it.
      if (pendingFinishes === 0) {
        setPhase('idle')
        setError("Couldn't extract anything from that — try saying more about the product.")
      }
    } catch (e) {
      setError(e?.message || 'Autofill failed')
      setPhase('idle')
    }
  }, [])

  // Fire autofill the moment listening transitions from true → false.
  // We watch `listening` rather than wiring into the hook's `onend` so we
  // catch all stop paths (manual toggle, browser auto-stop, error).
  const wasListeningRef = useRef(false)
  useEffect(() => {
    if (wasListeningRef.current && !listening) {
      runAutofill()
    }
    wasListeningRef.current = listening
  }, [listening, runAutofill])

  // Stop listening cleanly if the user closes the modal mid-recording.
  useEffect(() => {
    return () => {
      if (listening) toggleVoice()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSkip = () => {
    onClose?.()
  }

  const handleSave = async () => {
    if (!workspace?.id) {
      onClose?.()
      return
    }
    setSaving(true)
    setError(null)
    try {
      const writes = QUESTIONS
        .filter((q) => (answers[q.key] || '').trim())
        .map((q) =>
          api.createMemoryEntry({
            type: 'project',
            name: q.memoryName,
            description: q.memoryDescription,
            content: answers[q.key].trim(),
            workspace_id: workspace.id,
            source_cli: 'commander',
            tags: ['onboarding', 'vision'],
          })
        )
      await Promise.all(writes)
      onDone?.(workspace)
      onClose?.()
    } catch (e) {
      setError(e?.message || 'Failed to save answers')
    } finally {
      setSaving(false)
    }
  }

  const wsLabel = workspace?.name || 'this workspace'
  const busy = phase !== 'idle'

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      {/* Scoped animations:
          • vision-shimmer-text — the Apple-Intelligence text-replace effect.
            An iridescent gradient sweeps THROUGH the text itself (not a
            border, not a glow) via background-clip: text. Used as a one-shot
            on each field as its new content lands so it visibly "rewrites".
            Palette from jacobamobin/AppleIntelligenceGlowEffect.
          • vision-sparkle-pulse — small ✨ next to the title while the LLM
            is thinking, before any text has arrived.
          Inline so the component is self-contained — no global CSS edit. */}
      <style>{`
        @keyframes vision-shimmer-sweep {
          0%   { background-position: 0% 50%; }
          100% { background-position: 200% 50%; }
        }
        .vision-shimmer-text {
          background-image: linear-gradient(
            90deg,
            #BC82F3 0%,
            #F5B9EA 14%,
            #8D9FFF 28%,
            #AA6EEE 42%,
            #FF6778 56%,
            #FFBA71 70%,
            #C686FF 84%,
            #BC82F3 100%
          );
          background-size: 200% 100%;
          background-clip: text;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          color: transparent;
          animation: vision-shimmer-sweep 1.6s linear infinite;
        }
        @keyframes vision-sparkle-pulse {
          0%, 100% { opacity: 0.4; transform: scale(0.95); }
          50%      { opacity: 1;   transform: scale(1.1); }
        }
        .vision-sparkle-pulse { animation: vision-sparkle-pulse 1.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .vision-shimmer-text,
          .vision-sparkle-pulse {
            animation: none !important;
          }
        }
      `}</style>

      <div className="bg-zinc-950 border border-zinc-800 rounded-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto relative">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 sticky top-0 bg-zinc-950 z-10">
          <div className="flex items-center gap-2">
            <Telescope size={16} className="text-indigo-400" />
            <div>
              <h2 className="text-zinc-100 text-sm font-semibold flex items-center gap-2">
                Set the vision for {wsLabel}
                {busy && (
                  <Sparkles
                    size={12}
                    className="text-violet-400 vision-sparkle-pulse"
                  />
                )}
              </h2>
              <p className="text-zinc-500 text-[11px] mt-0.5">
                {listening
                  ? 'Listening… speak about your product. Click the mic again to stop.'
                  : phase === 'thinking'
                    ? 'Thinking…'
                    : phase === 'filling'
                      ? 'Filling in your answers…'
                      : 'Stored as project memory. Drives the Observatory profile and downstream agents — skip any question that doesn\'t apply.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={toggleVoice}
              disabled={busy && !listening}
              title={listening ? 'Stop listening' : 'Dictate your vision — auto-fills the fields'}
              className={
                'flex items-center gap-1.5 px-2 py-1 text-[11px] font-mono rounded border transition-colors ' +
                (listening
                  ? 'border-rose-500/40 bg-rose-500/15 text-rose-300'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed')
              }
            >
              {listening ? (
                <>
                  <MicOff size={11} className="animate-pulse" />
                  <span>stop</span>
                </>
              ) : (
                <>
                  <Mic size={11} />
                  <span>dictate</span>
                </>
              )}
            </button>
            <button onClick={handleSkip} className="text-zinc-500 hover:text-zinc-300">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {QUESTIONS.map((q) => {
            const isShimmer = !!shimmering[q.key]
            return (
              <label key={q.key} className="block">
                <span className="text-zinc-300 text-[12px] font-medium">{q.label}</span>
                <div className="relative mt-1">
                  <textarea
                    value={answers[q.key]}
                    onChange={(e) => setAnswer(q.key, e.target.value)}
                    placeholder={q.placeholder}
                    rows={3}
                    disabled={busy}
                    style={isShimmer ? { color: 'transparent', caretColor: 'transparent' } : undefined}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded text-zinc-100 text-[12px] p-2 font-mono resize-y focus:outline-none focus:border-indigo-600"
                  />
                  {isShimmer && (
                    /* Overlay div mirrors the textarea's text rendering and
                       applies the iridescent gradient via background-clip.
                       Pointer-events disabled so the textarea below stays
                       focusable; padding/font/wrap match exactly so the
                       overlay text aligns 1:1 with where the textarea would
                       render it. */
                    <div
                      aria-hidden
                      className="vision-shimmer-text absolute inset-0 pointer-events-none p-2 text-[12px] font-mono whitespace-pre-wrap break-words overflow-hidden"
                    >
                      {answers[q.key]}
                    </div>
                  )}
                </div>
              </label>
            )
          })}

          {error && (
            <div className="text-rose-400 text-[11px] font-mono">{error}</div>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
            <button
              onClick={handleSkip}
              disabled={saving || busy}
              className="text-[11px] text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
            >
              Skip — fill in later via Smart Observatory
            </button>
            <button
              onClick={handleSave}
              disabled={saving || busy}
              className="px-3 py-1.5 text-[12px] bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded transition-colors"
            >
              {saving ? 'Saving…' : 'Save vision'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
