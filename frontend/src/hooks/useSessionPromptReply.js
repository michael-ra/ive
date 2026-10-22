import { useCallback, useEffect, useRef, useState } from 'react'
import { answerPrompt, fetchPromptSnapshot, promptChoices, promptErrorMessage } from '../lib/promptAnswer'

// Polls the current native prompt of a session and answers it against that
// exact screen. Shared by SessionPromptActions, the Home "Needs you" row and
// the board card. After a 409 (stale prompt) the snapshot is reloaded and the
// answer is never resent.
export default function useSessionPromptReply(sessionId, { active = true, pollMs = 1500 } = {}) {
  const [snapshot, setSnapshot] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [sending, setSending] = useState(false)
  const [answeredScreen, setAnsweredScreen] = useState('')
  const requestRef = useRef(0)
  const generationRef = useRef(0)
  const sendingRef = useRef(false)

  const refresh = useCallback(async () => {
    const request = ++requestRef.current
    const generation = generationRef.current
    try {
      const next = await fetchPromptSnapshot(sessionId)
      if (request !== requestRef.current || generation !== generationRef.current) return
      setSnapshot(next)
      setLoadError('')
    } catch (err) {
      if (request !== requestRef.current || generation !== generationRef.current) return
      setLoadError(err?.message || 'Could not load the current request. Refresh to try again.')
      setSnapshot(null)
    } finally {
      if (request === requestRef.current && generation === generationRef.current) setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    generationRef.current++
    requestRef.current++
    setSnapshot(null)
    setError('')
    setLoadError('')
    setAnsweredScreen('')
    setSending(false)
    sendingRef.current = false
    setLoading(true)
    if (!active || !sessionId) return undefined
    let stopped = false
    let timer
    const poll = async () => {
      if (!sendingRef.current && !(typeof document !== 'undefined' && document.hidden)) await refresh()
      if (!stopped) timer = setTimeout(poll, pollMs)
    }
    poll()
    return () => {
      stopped = true
      clearTimeout(timer)
      generationRef.current++
      requestRef.current++
    }
  }, [active, sessionId, pollMs, refresh])

  const current = snapshot?.sessionId === sessionId ? snapshot : null
  const answered = !!current?.screen && answeredScreen === current.screen
  const unavailable = sending || loading || !current?.screen?.trim() || !!current?.incomplete || answered

  const reply = useCallback(async (value, { manual = false } = {}) => {
    if (unavailable || sendingRef.current || !current) return false
    const screen = current.screen
    const generation = generationRef.current
    sendingRef.current = true
    setSending(true)
    setError('')
    try {
      await answerPrompt(sessionId, current, value, { manual })
      if (generation !== generationRef.current) return true
      setAnsweredScreen(screen)
      window.dispatchEvent(new CustomEvent('cc-session-messages-refresh', { detail: { sessionId } }))
      await refresh()
      return true
    } catch (err) {
      if (generation !== generationRef.current) return false
      setError(promptErrorMessage(err))
      await refresh()
      return false
    } finally {
      if (generation === generationRef.current) {
        sendingRef.current = false
        setSending(false)
      }
    }
  }, [unavailable, current, sessionId, refresh])

  const clearError = useCallback(() => { setError(''); setLoadError('') }, [])

  return {
    snapshot: current,
    choices: promptChoices(current),
    loading,
    error: error || loadError,
    sending,
    answered,
    unavailable,
    refresh,
    reply,
    clearError,
  }
}
