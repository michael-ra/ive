import ProviderLogo from '../ui/ProviderLogo'
import ReplyPending from './ReplyPending'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, Copy, FolderPlus, MessageCircle, Plus, Square, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import WorkspacePicker from '../workspace/WorkspacePicker'

const STORAGE = 'ive-sidechat-v1'
function restore(storage) {
  try { return JSON.parse(sessionStorage.getItem(storage) || '{}') || {} } catch { return {} }
}

export default function SideChat({ open, onClose, onNavigate, sessionId = null, incoming, onConsumed, onGeneral }) {
  const storage = sessionId ? `${STORAGE}:${sessionId}` : STORAGE
  const [saved] = useState(() => restore(storage))
  const [messages, setMessages] = useState(() => Array.isArray(saved.messages) ? saved.messages : [])
  const [draft, setDraft] = useState(saved.draft || '')
  const [projects, setProjects] = useState(() => Array.isArray(saved.projects) ? saved.projects : [])
  const [cli, setCli] = useState(saved.cli || '')
  const [model, setModel] = useState(saved.model || '')
  const [accountId, setAccountId] = useState(saved.accountId || '')
  const [pending, setPending] = useState(saved.pending || null)
  const [queued, setQueued] = useState(() => Array.isArray(saved.queued) ? saved.queued : [])
  // Bumped when an answer completes; only then does the queue go out on its own.
  const [answered, setAnswered] = useState(0)
  const [options, setOptions] = useState(null)
  const [error, setError] = useState(saved.error || '')
  const [retryable, setRetryable] = useState(!!saved.retryable)
  const [reconnect, setReconnect] = useState(0)
  const [stopping, setStopping] = useState(false)
  const [showProjects, setShowProjects] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [copied, setCopied] = useState(null)
  const [viewportHeight, setViewportHeight] = useState(null)
  const input = useRef(null)
  const scroll = useRef(null)
  const busyRef = useRef(!!pending)
  const focusOrigin = useRef(null)
  const activeSession = useStore((state) => state.sessions[sessionId || state.activeSessionId])
  const workspaces = useStore((state) => state.workspaces)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)

  useEffect(() => {
    try { sessionStorage.setItem(storage, JSON.stringify({ messages, draft, projects, cli, model, accountId, pending, queued, error, retryable })) } catch { /* memory-only when storage is unavailable */ }
  }, [messages, draft, projects, cli, model, accountId, pending, queued, error, retryable])

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const update = () => setViewportHeight(viewport.height)
    update()
    viewport.addEventListener('resize', update)
    return () => viewport.removeEventListener('resize', update)
  }, [])

  useEffect(() => {
    if (!open) return
    focusOrigin.current = document.activeElement
    input.current?.focus()
  }, [open])

  useLayoutEffect(() => {
    const field = input.current
    if (!open || !field) return
    const resize = () => {
      field.style.height = 'auto'
      field.style.height = `${field.scrollHeight}px`
    }
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [draft, open, viewportHeight])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    api.getSidechatOptions().then((data) => {
      if (cancelled) return
      setOptions(data)
      if (!cli) {
        const selected = (data.providers || []).find((item) => item.id === activeSession?.cli_type && item.installed)
          || (data.providers || []).find((item) => item.installed)
        if (selected) {
          setCli(selected.id)
          if (selected.id === activeSession?.cli_type) {
            setModel(activeSession.model || '')
            if (data.accounts.some((account) => account.id === activeSession.account_id)) setAccountId(activeSession.account_id)
          }
        }
      }
    }).catch((cause) => { if (!cancelled) setError(cause.message || 'Could not load local agents.') })
    return () => { cancelled = true }
  }, [open, reconnect])

  useEffect(() => {
    if (open && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [messages, pending, queued, error, open])

  useEffect(() => {
    if (!pending) return
    let cancelled = false
    let timer
    let failures = 0
    const finish = (job) => {
      busyRef.current = false
      setPending(null)
      if (job.status === 'completed') {
        setMessages((current) => current.some((item) => item.id === job.id) ? current : [...current, {
          id: job.id, role: 'assistant', content: job.answer, cli: job.cli_type, model: job.model,
        }])
        setError('')
        setRetryable(false)
        setAnswered((value) => value + 1)
      } else {
        setError(job.status === 'cancelled' ? 'Answer stopped. You can retry or ask a new question.' : job.error)
        setRetryable(true)
      }
    }
    const poll = async (start = false) => {
      try {
        let job
        try { job = start ? await api.askSidechat(pending.payload) : await api.getSidechatRequest(pending.payload.request_id) }
        catch (cause) {
          if (cause.status === 404) {
            throw Object.assign(new Error('This answer is no longer available. Retry or edit your question.'), { status: 404 })
          }
          throw cause
        }
        if (cancelled) return
        failures = 0
        if (job.status !== 'running') { finish(job); return }
        setError('')
        timer = setTimeout(() => poll(), 900)
      } catch (cause) {
        if (cancelled) return
        if (cause.status && cause.status < 500 && cause.status !== 429) {
          finish({ status: 'failed', error: cause.message })
          return
        }
        failures += 1
        if (failures >= 3) {
          setError(cause.message || 'Connection interrupted. Reconnect to check your answer.')
          return
        }
        timer = setTimeout(() => poll(start), 2000)
      }
    }
    poll(true)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [pending, reconnect])

  const provider = (options?.providers || []).find((item) => item.id === cli)
  const accounts = options?.accounts.filter((item) => item.cli_type === cli) || []
  const currentProject = workspaces.find((item) => item.id === (activeSession?.workspace_id || activeWorkspaceId))
  const models = (provider?.models || []).filter((item) => item.id)
  const full = messages.length >= 39 || messages.reduce((size, item) => size + item.content.length, 0) >= 48000

  const close = () => {
    onClose()
    if (focusOrigin.current?.isConnected) focusOrigin.current.focus()
  }
  const addProject = (project) => {
    setProjects((current) => current.some((item) => item.path === project.path) ? current
      : [...current, { path: project.path, name: project.name || project.path.split('/').filter(Boolean).at(-1) }].slice(0, 6))
    setShowProjects(false)
  }
  const start = (conversation) => {
    if (busyRef.current || !provider?.installed) return
    busyRef.current = true
    setError('')
    setRetryable(false)
    setPending({ payload: {
      request_id: crypto.randomUUID(), cli_type: cli, model, account_id: accountId || null,
      messages: conversation.map(({ role, content }) => ({ role, content })),
      project_paths: projects.map((project) => project.path),
      session_id: sessionId,
    } })
  }
  const send = (event) => {
    event.preventDefault()
    if (!draft.trim() || full || !provider?.installed) return
    sendQuestion(draft.trim())
    setDraft('')
  }
  const sendQuestion = (question) => {
    // While an answer is running, follow-ups wait in a queue instead of blocking the composer.
    if (busyRef.current || queued.length) {
      setQueued((current) => [...current, { id: crypto.randomUUID(), content: question }])
      return
    }
    const next = [...messages, { id: crypto.randomUUID(), role: 'user', content: question }]
    setMessages(next)
    start(next)
  }
  const consumed = useRef(null)
  useEffect(() => {
    if (!open || !incoming || consumed.current === incoming.id) return
    if (incoming.question && !options) return
    consumed.current = incoming.id
    if (incoming.question) {
      if (provider?.installed && !full) sendQuestion(incoming.question)
      else {
        setDraft((value) => [value, incoming.question].filter(Boolean).join('\n\n'))
        setError(full ? 'This conversation is full. Start a new side chat to send your question.' : 'Choose an installed agent to send your question.')
      }
    }
    onConsumed?.()
    input.current?.focus()
  }, [incoming, open, options, provider, full])
  const sendQueued = () => {
    if (!queued.length || busyRef.current || full || !provider?.installed) return
    const next = [...messages, { id: crypto.randomUUID(), role: 'user', content: queued.map((item) => item.content).join('\n\n') }]
    setMessages(next)
    setQueued([])
    start(next)
  }
  // A finished answer sends what was queued; a stopped or failed one keeps the queue until you decide
  // (clearing the error, e.g. via Edit question, must not flush it behind the user's back).
  useEffect(() => {
    if (answered && queued.length) sendQueued()
  }, [answered])
  const stop = async () => {
    if (!pending || stopping) return
    setStopping(true)
    try {
      await api.cancelSidechatRequest(pending.payload.request_id)
      // Keep polling until the server confirms completion/cancellation.
      setReconnect((value) => value + 1)
    } catch (cause) { setError(cause.message || 'Could not stop the answer. Try again.') }
    finally { setStopping(false) }
  }
  const newChat = () => {
    if (busyRef.current) return
    setMessages([])
    setQueued([])
    setDraft('')
    setError('')
    setRetryable(false)
    input.current?.focus()
  }
  const editFailedQuestion = () => {
    if (busyRef.current || messages.at(-1)?.role !== 'user') return
    // Keep a draft written during the wait: the failed question goes on top, the draft below it.
    const failed = messages.at(-1).content
    setDraft(draft.trim() ? `${failed}\n\n${draft}` : failed)
    setMessages((current) => current.slice(0, -1))
    setError('')
    setRetryable(false)
    input.current?.focus()
  }

  return <>
    <aside id="ive-sidechat" className="ive-sidechat" hidden={!open} aria-label="Side chat" style={viewportHeight ? { '--ive-sidechat-height': `${viewportHeight}px` } : undefined}
      onKeyDown={(event) => { if (event.key === 'Escape' && !showProjects) { event.stopPropagation(); close() } }}>
      <header className="ive-sidechat-header">
        <span className="ive-sidechat-mark"><ProviderLogo provider={cli} className="w-5 h-5 shrink-0" /></span>
        <div className="min-w-0 flex-1"><h2>{sessionId ? 'Ask on the side' : `Chat with ${cli === 'codex' ? 'Codex' : 'Claude'}`}</h2><p>{sessionId ? 'Your main task keeps going.' : 'Ask anything. No session or project needed.'}</p></div>
        <button type="button" className="ive-sidechat-icon" aria-label="New side chat" title="New chat" disabled={!!pending} onClick={newChat}><Plus size={18} /></button>
        <button type="button" className="ive-sidechat-icon" aria-label="Close side chat" onClick={close}><X size={18} /></button>
      </header>

      <div className="ive-sidechat-context">
        {sessionId && <div className="ive-aside-context">
          <strong>{activeSession?.name || 'Session'}</strong>
          <span>{currentProject?.name || 'Project'} · task & recent conversation</span>
          <small>Refreshed for each question. Answers stay in this side chat.</small>
          <button type="button" className="ive-sidechat-link" onClick={onGeneral}>Open general chat</button>
        </div>}
        <button type="button" className="ive-sidechat-agent" aria-expanded={showSettings} onClick={() => setShowSettings((value) => !value)}>
          <span className={`ive-sidechat-dot ${provider?.installed ? 'is-ready' : ''}`} />
          <span>{provider?.label || 'Choose an agent'}<small>{model || 'Default model'} · {accountId ? accounts.find((account) => account.id === accountId)?.name || 'Selected account' : 'Local login'}</small></span>
          <ChevronDown size={14} />
        </button>
        {showSettings && <div className="ive-sidechat-settings">
          <label>Agent<select aria-label="Side chat agent" value={cli} disabled={!!pending} onChange={(event) => { setCli(event.target.value); setModel(''); setAccountId('') }}>
            {!cli && <option value="">Select an installed agent</option>}
            {(options?.providers || []).map((item) => <option key={item.id} value={item.id} disabled={!item.installed}>{item.label}{!item.installed ? ' · not installed' : ''}</option>)}
          </select></label>
          <label>Model<select aria-label="Side chat model" value={model} disabled={!!pending} onChange={(event) => setModel(event.target.value)}>
            <option value="">Default model</option>
            {model && !models.some((item) => item.id === model) && <option value={model}>{model}</option>}
            {models.map((item) => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}
          </select></label>
          <label className="ive-sidechat-account">Account<select aria-label="Side chat account" value={accountId} disabled={!!pending} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">Local login</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select></label>
          <button type="button" className="ive-sidechat-link" onClick={() => onNavigate('accounts')}>Manage accounts</button>
        </div>}
        <div className="ive-sidechat-projects">
          <span className="ive-sidechat-chip is-guide">IVE guide</span>
          {projects.map((project) => <span className="ive-sidechat-chip" key={project.path} title={project.path}>
            <span>{project.name}</span><button type="button" disabled={!!pending} aria-label={`Remove ${project.name} from side chat`} onClick={() => setProjects((current) => current.filter((item) => item.path !== project.path))}><X size={12} /></button>
          </span>)}
          <button type="button" className="ive-sidechat-add" disabled={!!pending || projects.length >= 6} onClick={() => setShowProjects(true)}><FolderPlus size={13} /> Add project</button>
        </div>
        {projects.length > 0 && <p className="ive-sidechat-context-note">Project overviews & README excerpts · {projects.length}/6 folders</p>}
      </div>

      <div ref={scroll} className="ive-sidechat-scroll" role="log" aria-label="Side chat conversation" aria-live="polite">
        {messages.length === 0 && <div className="ive-sidechat-empty">
          <span className="ive-sidechat-eyebrow">A QUESTION ON THE SIDE</span>
          <h3>Keep your train<br />of thought.</h3>
          <p>{sessionId ? 'Ask about the current task or project. This chat can explain and suggest; it does not change files or send instructions to your main agent.' : 'Find your way around IVE, untangle an idea, or ask something while your session keeps going.'}</p>
          <div className="ive-sidechat-starters">
            {(sessionId ? ['Why are we taking this approach?', 'What should I check before accepting the result?', 'Explain the latest change in simple terms.'] : ['Where can I change the model?', 'Can I work across several project folders?', 'What’s the difference between a task and a session?']).map((question) => <button type="button" key={question} onClick={() => { setDraft(question); input.current?.focus() }}>{question}<span>↗</span></button>)}
          </div>
          {currentProject && !projects.some((project) => project.path === currentProject.path) && <button type="button" className="ive-sidechat-link mt-4" onClick={() => addProject(currentProject)}><FolderPlus size={14} /> Include {currentProject.name}</button>}
        </div>}
        {messages.map((message) => <article key={message.id} className={`ive-sidechat-message is-${message.role}`}>
          <div className="ive-sidechat-message-label"><span>{message.role === 'user' ? 'You' : message.cli === 'codex' ? 'Codex' : 'Claude'}</span>
            {message.role === 'assistant' && <button type="button" aria-label="Copy answer" onClick={async () => {
              try { await navigator.clipboard.writeText(message.content); setCopied(message.id); setTimeout(() => setCopied(null), 1800) }
              catch { setError('Could not copy. Select the answer text to copy it.') }
            }}>{copied === message.id ? 'Copied' : <Copy size={12} />}</button>}
          </div>
          {message.role === 'user' ? <p className="whitespace-pre-wrap">{message.content}</p> : <div className="ive-flow-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a> }}>{message.content}</ReactMarkdown></div>}
        </article>)}
        {pending && !error && <ReplyPending provider={pending.payload.cli_type} label={stopping ? 'Stopping…' : 'Waiting for a reply…'} />}
        {queued.length > 0 && <div className="ive-sidechat-queue" aria-label="Queued messages">
          {queued.map((item) => <article key={item.id} className="ive-sidechat-message is-user is-queued">
            <div className="ive-sidechat-message-label"><span>Queued</span>
              <button type="button" aria-label="Remove queued message" onClick={() => setQueued((current) => current.filter((entry) => entry.id !== item.id))}><X size={12} /></button>
            </div>
            <p className="whitespace-pre-wrap">{item.content}</p>
          </article>)}
          {pending ? <p className="ive-sidechat-queue-note">Sends when the answer is done</p>
            : <button type="button" className="ive-sidechat-link" onClick={() => { setError(''); setRetryable(false); sendQueued() }}>Send queued now</button>}
        </div>}
        {error && <div className="ive-sidechat-error" role="alert"><p>{error}</p>
          {pending ? <button type="button" onClick={() => { setError(''); setReconnect((value) => value + 1) }}>Reconnect</button>
            : retryable && <>
              <button type="button" onClick={() => start(messages)}>Retry answer</button>
              {messages.at(-1)?.role === 'user' && <button type="button" onClick={editFailedQuestion}>Edit question</button>}
            </>}
        </div>}
      </div>

      <form className="ive-sidechat-composer" onSubmit={send}>
        {options && !(options.providers || []).some((item) => item.installed) && <p className="ive-sidechat-empty-agent">Install Claude Code or Codex CLI and sign in on this computer to start chatting.</p>}
        {full && <p className="ive-sidechat-context-note">This conversation is full. Use + to start a new chat.</p>}
        <div className={`ive-sidechat-input ${pending ? 'is-busy' : ''}`}>
          <textarea ref={input} aria-label="Ask a side question" placeholder={pending ? 'Write a follow-up…' : 'Ask a question…'} rows={3} value={draft} maxLength={12000}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(event) }
            }} />
          {pending && <button type="button" className="ive-sidechat-stop" aria-label="Stop side chat answer" title="Stop answer" disabled={stopping} onClick={stop}><Square size={12} fill="currentColor" /></button>}
          <button type="submit" className="ive-sidechat-send" aria-label={pending ? 'Queue follow-up' : 'Send side question'} disabled={!draft.trim() || !provider?.installed || full}><ArrowUp size={18} /></button>
        </div>
        <p>{pending ? 'Enter queues it · sends when the answer is done' : 'Enter to send · Shift+Enter for a new line'}</p>
      </form>
    </aside>
    {showProjects && <WorkspacePicker forContext onClose={() => setShowProjects(false)} onSelect={addProject} />}
  </>
}
