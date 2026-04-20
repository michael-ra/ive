import { useState, useRef, useCallback } from 'react'

/**
 * Hook for browser-native speech recognition (Web Speech API).
 * Works in Chrome, Edge, Safari. Falls back gracefully in Firefox.
 */
export function useVoiceInput(onResult) {
  const [listening, setListening] = useState(false)
  const recRef = useRef(null)

  const toggle = useCallback(() => {
    // Use ref (not state) to avoid stale closure on rapid toggles
    if (recRef.current) {
      recRef.current.abort()  // abort() = instant mic release, stop() lingers 1-3s
      // onend will null the ref
      setListening(false)
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
      console.error('Speech recognition error:', e.error)
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
  }, [onResult])

  return { listening, toggle }
}
