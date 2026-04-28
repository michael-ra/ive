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
export function useVoiceInput(onResult, { flushOnStop = false } = {}) {
  const [listening, setListening] = useState(false)
  const recRef = useRef(null)

  const toggle = useCallback(() => {
    // Use ref (not state) to avoid stale closure on rapid toggles
    if (recRef.current) {
      if (flushOnStop) {
        // stop() lets the recognizer finalize any pending interim results
        // before firing onend. listening stays true until onend so consumers
        // who watch the listening transition see a fully-populated transcript.
        recRef.current.stop()
      } else {
        recRef.current.abort()  // discards in-flight speech, instant mic release
        setListening(false)
      }
      return
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      alert('Speech recognition is not supported in this browser. Use Chrome or Edge.')
      return
    }

    const rec = new SR()
    rec.continuous = true
    rec.interimResults = false
    rec.lang = navigator.language || 'en-US'

    rec.onresult = (e) => {
      let text = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          text += e.results[i][0].transcript
        }
      }
      if (text) onResult(text)
    }

    rec.onerror = (e) => {
      // "aborted" fires every time toggle() calls rec.abort() to stop —
      // it's the documented stop path, not a real error.
      // "no-speech" fires when the user toggled the mic but didn't talk.
      // Both are user-initiated and shouldn't show up in the console.
      if (e.error !== 'aborted' && e.error !== 'no-speech') {
        console.error('Speech recognition error:', e.error)
      }
      recRef.current = null
      setListening(false)
    }

    rec.onend = () => { recRef.current = null; setListening(false) }

    try {
      rec.start()
      recRef.current = rec
      setListening(true)
    } catch (e) {
      console.error('Failed to start speech recognition:', e)
      recRef.current = null
    }
  }, [onResult, flushOnStop])

  return { listening, toggle }
}
