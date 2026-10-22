import { useState, useRef, useCallback } from 'react'

/**
 * Hook for browser-native speech recognition (Web Speech API).
 * Works in Chrome, Edge, Safari. Falls back gracefully in Firefox.
 *
 * Options:
 *   flushOnStop (default false)
 *     - false: rec.abort() on stop — instant mic release, but discards any
 *       interim speech that hasn't yet finalized into a result. Best for
 *       streaming-append UX where losing the last fragment is acceptable.
 *     - true:  rec.stop() on stop — waits for pending finals to flush
 *       before onend fires (typically <1s lag). Use this when callers need
 *       a COMPLETE transcript at the moment listening goes false (e.g.
 *       firing an LLM autofill on stop).
 */
export function useVoiceInput(
  onResult,
  {
    flushOnStop = false,
    keepAlive = false,
    onInterim,
    onStart,
    onEnd,
    onError,
    lang,
  } = {},
) {
  const [listening, setListening] = useState(false)
  const recRef = useRef(null)
  const manualStopRef = useRef(false)
  const startRef = useRef(null)

  const startRecognition = useCallback((restart = false) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      alert('Speech recognition is not supported in this browser. Use Chrome or Edge.')
      return
    }

    const rec = new SR()
    rec.continuous = true
    rec.interimResults = !!onInterim
    rec.lang = lang || navigator.language || 'en-US'

    rec.onresult = (e) => {
      let finalText = ''
      let interimText = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          finalText += e.results[i][0].transcript
        } else {
          interimText += e.results[i][0].transcript
        }
      }
      if (interimText) onInterim?.(interimText)
      if (finalText) onResult(finalText)
    }

    rec.onerror = (e) => {
      // "aborted" fires every time toggle() calls rec.abort() to stop —
      // it's the documented stop path, not a real error.
      // "no-speech" fires when the user toggled the mic but didn't talk.
      // Both are user-initiated and shouldn't show up in the console.
      if (e.error !== 'aborted' && e.error !== 'no-speech') {
        console.error('Speech recognition error:', e.error)
      }
      onError?.(e.error)
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) {
        manualStopRef.current = true
      }
      recRef.current = null
      if (!keepAlive || manualStopRef.current) setListening(false)
    }

    rec.onend = () => {
      recRef.current = null
      if (keepAlive && !manualStopRef.current) {
        setTimeout(() => {
          if (!manualStopRef.current && !recRef.current) startRef.current?.(true)
        }, 250)
        return
      }
      setListening(false)
      onEnd?.({ manual: manualStopRef.current })
    }

    try {
      rec.start()
      recRef.current = rec
      setListening(true)
      onStart?.({ restart, lang: rec.lang })
    } catch (e) {
      console.error('Failed to start speech recognition:', e)
      onError?.(e?.message || 'start_failed')
      recRef.current = null
    }
  }, [keepAlive, lang, onEnd, onError, onInterim, onResult, onStart])

  startRef.current = startRecognition

  const toggle = useCallback(() => {
    // Use ref (not state) to avoid stale closure on rapid toggles.
    if (recRef.current) {
      manualStopRef.current = true
      if (flushOnStop) {
        // stop() lets the recognizer finalize any pending interim results
        // before firing onend. listening stays true until onend so consumers
        // who watch the listening transition see a fully-populated transcript.
        recRef.current.stop()
      } else {
        recRef.current.abort()  // discards in-flight speech, instant mic release
        recRef.current = null
        setListening(false)
        onEnd?.({ manual: true })
      }
      return
    }
    if (listening) {
      manualStopRef.current = true
      setListening(false)
      onEnd?.({ manual: true })
      return
    }

    manualStopRef.current = false
    startRecognition(false)
  }, [flushOnStop, listening, onEnd, startRecognition])

  return { listening, toggle, supported: typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition) }
}
