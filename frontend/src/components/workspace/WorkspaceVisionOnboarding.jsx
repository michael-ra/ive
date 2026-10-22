import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, Check, Mic, MicOff } from 'lucide-react'
import { api, request } from '../../lib/api'
import { useVoiceInput } from '../../hooks/useVoiceInput'
import { Button, Modal } from '../ui'
import { createWorkspaceContextSaver, emptyWorkspaceContext, mergeWorkspaceAutofill, WORKSPACE_CONTEXT_QUESTIONS } from '../../lib/workspaceContext'

export default function WorkspaceVisionOnboarding({ workspace, onClose, onDone }) {
  const [answers, setAnswers] = useState(emptyWorkspaceContext)
  const [savedKeys, setSavedKeys] = useState([])
  const [saving, setSaving] = useState(false)
  const [filling, setFilling] = useState(false)
  const [error, setError] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const answersRef = useRef(answers)
  const mounted = useRef(true)
  const voiceRef = useRef(null)
  const stoppingVoice = useRef(false)
  const transcriptRef = useRef('')
  const autofillRef = useRef(null)
  const savingRef = useRef(false)
  const saver = useRef(null)
  if (!saver.current) saver.current = createWorkspaceContextSaver(api, workspace?.id)

  const setAnswer = (key, value) => {
    answersRef.current = { ...answersRef.current, [key]: value }
    setAnswers(answersRef.current)
  }
  const handleVoiceResult = useCallback((text) => {
    if (mounted.current && text) transcriptRef.current += `${transcriptRef.current ? ' ' : ''}${text}`
  }, [])
  const handleVoiceError = useCallback((reason) => {
    if (!mounted.current || reason === 'aborted') return
    const messages = {
      'not-allowed': 'Microphone access was not allowed. You can type the answers instead.',
      'service-not-allowed': 'Speech recognition is not available. You can type the answers instead.',
      'audio-capture': 'The microphone is unavailable. You can type the answers instead.',
      'no-speech': 'No speech detected. Try dictating again or type your answers.',
    }
    setError(messages[reason] || 'Dictation stopped. You can try again or type your answers.')
  }, [])
  const { listening, toggle: toggleVoice, supported } = useVoiceInput(handleVoiceResult, { flushOnStop: true, onError: handleVoiceError })
  voiceRef.current = { listening, toggle: toggleVoice }

  const stopVoice = () => {
    const voice = voiceRef.current
    if (!voice?.listening || stoppingVoice.current) return
    stoppingVoice.current = true
    try { voice.toggle() } catch { /* The recognizer may already have ended. */ }
  }

  const runAutofill = useCallback(async () => {
    const transcript = transcriptRef.current.trim()
    transcriptRef.current = ''
    if (!mounted.current) return
    if (!transcript) {
      setError((current) => current || 'No speech detected. Try dictating again or type your answers.')
      return
    }
    const controller = new AbortController()
    autofillRef.current?.abort()
    autofillRef.current = controller
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 60000)
    setFilling(true)
    setError('')
    try {
      // Same endpoint and provider/model defaults, with request cancellation.
      const result = await request('/vision/autofill', {
        method: 'POST', body: JSON.stringify({ transcript }), signal: controller.signal,
      })
      if (!mounted.current || controller.signal.aborted) return
      const next = mergeWorkspaceAutofill(answersRef.current, result, saver.current.getSavedKeys())
      const changed = WORKSPACE_CONTEXT_QUESTIONS.some(({ key }) => next[key] !== answersRef.current[key])
      if (!changed) {
        setError('No empty answers could be filled. Your existing answers were kept; you can edit them below.')
        return
      }
      answersRef.current = next
      setAnswers(next)
      if (WORKSPACE_CONTEXT_QUESTIONS.some(({ key, advanced }) => advanced && next[key]?.trim())) setAdvancedOpen(true)
    } catch (err) {
      if (mounted.current) setError(timedOut ? 'Dictation could not be organized within one minute. You can type the answers or try again.' : err?.message || 'Could not organize the dictated text.')
    } finally {
      clearTimeout(timer)
      if (autofillRef.current === controller) autofillRef.current = null
      if (mounted.current) setFilling(false)
    }
  }, [])

  const wasListening = useRef(false)
  useEffect(() => {
    if (wasListening.current && !listening) {
      stoppingVoice.current = false
      runAutofill()
    }
    wasListening.current = listening
  }, [listening, runAutofill])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      transcriptRef.current = ''
      autofillRef.current?.abort()
      stopVoice()
    }
  }, [])

  const close = () => {
    if (savingRef.current) return
    mounted.current = false
    transcriptRef.current = ''
    autofillRef.current?.abort()
    stopVoice()
    onClose?.()
  }

  const save = async () => {
    if (!workspace?.id || savingRef.current || filling || listening) return
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      await saver.current.save(answersRef.current, (keys) => { if (mounted.current) setSavedKeys(keys) })
      if (mounted.current) { onDone?.(workspace); onClose?.() }
    } catch (err) {
      if (mounted.current) setError(`${err?.message || 'Could not save project context.'}${saver.current.getSavedKeys().length ? ' Saved answers are marked below. Retry saves only the remaining answers.' : ''}`)
    } finally {
      savingRef.current = false
      if (mounted.current) setSaving(false)
    }
  }

  const renderQuestion = (question) => {
    const saved = savedKeys.includes(question.key)
    return <label key={question.key} className="block">
      <span className="flex items-center justify-between gap-3 text-sm font-semibold text-x-ink">{question.label}<span className="text-xs font-normal text-x-muted">{saved ? <span className="inline-flex items-center gap-1"><Check size={13} />Saved</span> : 'Optional'}</span></span>
      <textarea value={answers[question.key]} onChange={(event) => setAnswer(question.key, event.target.value)} placeholder={question.placeholder} rows={3} maxLength={12000} disabled={saving || filling || listening || saved} className="mt-2 w-full resize-y rounded-lg border border-x-line bg-x-surface-2 p-3 text-sm text-x-ink outline-none focus:border-x-accent focus:ring-2 focus:ring-x-focus disabled:opacity-70" />
    </label>
  }
  const hasAnswers = Object.values(answers).some((value) => value.trim())
  return <Modal title={`Context for ${workspace?.name || 'your project'}`} subtitle="Your project is connected. These questions are optional." icon={BookOpen} size="md" onClose={saving ? undefined : close} bodyClassName="overflow-y-auto" footer={
    <div className="flex flex-wrap items-center justify-between gap-3"><Button onClick={close} disabled={saving}>Skip for now</Button><Button variant="primary" onClick={save} disabled={!hasAnswers || saving || filling || listening} loading={saving}>{saving ? 'Saving…' : savedKeys.length ? 'Save remaining answers' : 'Save project context'}</Button></div>
  }>
    <div className="space-y-5 p-5 sm:p-6" data-workspace-context>
      <p className="text-sm leading-relaxed text-x-muted">Give the agent a short description and any rules that matter. Answers are saved as project knowledge. You can review and edit them later in <strong className="font-medium text-x-ink-secondary">Know → Context Hub</strong>.</p>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-x-line bg-x-surface-2 px-3 py-2.5">
        <p className="max-w-md text-xs leading-relaxed text-x-muted" role="status">{listening ? 'Listening… stop dictation when you are finished.' : filling ? 'Organizing your words into the empty answers…' : 'Type below or dictate. AI fills empty answers only; review them before saving.'}</p>
        <Button icon={listening ? MicOff : Mic} onClick={() => { if (listening) stopVoice(); else { stoppingVoice.current = false; transcriptRef.current = ''; setError(''); toggleVoice() } }} disabled={saving || filling || !supported} title={supported ? 'Dictate project context' : 'Speech recognition is unavailable in this browser'}>{listening ? 'Stop dictation' : 'Dictate'}</Button>
      </div>
      {WORKSPACE_CONTEXT_QUESTIONS.filter((question) => !question.advanced).map(renderQuestion)}
      <details open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)} className="rounded-lg border border-x-line p-4">
        <summary className="cursor-pointer text-sm font-semibold text-x-ink">Audience & similar products <span className="font-normal text-x-muted">· optional</span></summary>
        <p className="mt-2 text-xs leading-relaxed text-x-muted">Useful when planning a product or researching related tools. You can skip this for an existing repo or a small fix.</p>
        <div className="mt-4 space-y-5">{WORKSPACE_CONTEXT_QUESTIONS.filter((question) => question.advanced).map(renderQuestion)}</div>
      </details>
      {error && <p role="alert" className="rounded-lg border border-x-line bg-x-surface-2 p-3 text-sm leading-relaxed text-x-danger">{error}</p>}
      {savedKeys.length > 0 && <p className="text-xs text-x-muted">Saved answers stay in Context Hub even if you close this form. Edit them there after finishing.</p>}
    </div>
  </Modal>
}
