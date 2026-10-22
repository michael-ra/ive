import ProviderLogo from '../ui/ProviderLogo'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, FolderOpen, Loader2, SlidersHorizontal, Terminal, ArrowLeft, ArrowRight, MessageSquare, Plus, X } from 'lucide-react'
import useStore from '../../state/store'
import { getCliTypes, getModelsForCli, getDefaultModel } from '../../lib/constants'
import { formatKeyCombo } from '../../lib/keybindings'
import {
  describeTarget,
  lastAgentChoice,
  loadQuickStart,
  openSessionSetup,
  startQuickSession,
  updateQuickStartRoot,
} from '../../lib/quickStart'
import { SHELL_CLI, SHELL_LABEL, startQuickTerminal } from '../../lib/shellSession'
import ProjectTargetSelect from './ProjectTargetSelect'
import WorkspacePicker from '../workspace/WorkspacePicker'
import { connectProject } from '../../lib/taskFlow'

const CLI_SHORT = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity' }
const initialChoice = lastAgentChoice

/** Choose a project and a full session setup or a quick conversation. */
export default function QuickStartPopover({ onClose }) {
  const cliProfiles = useStore((s) => s.cliProfiles)
  const quickStart = useStore((s) => s.quickStart)
  const keybindings = useStore((s) => s.keybindings)
  const workspaces = useStore((s) => s.workspaces)
  void cliProfiles
  const [target, setTarget] = useState(() => useStore.getState().quickStartWorkspaceId || null)
  const cliTypes = getCliTypes()
  const [{ cli, model }, setChoice] = useState(() => initialChoice(cliTypes))
  const [text, setText] = useState('')
  const [entry, setEntry] = useState('choose')
  const [findingProject, setFindingProject] = useState(false)
  const setupRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editingRoot, setEditingRoot] = useState(false)
  const [rootDraft, setRootDraft] = useState('')
  const [rootBusy, setRootBusy] = useState(false)
  const [rootError, setRootError] = useState('')
  const inputRef = useRef(null)
  const rootRef = useRef(null)

  useEffect(() => {
    setupRef.current?.focus()
    loadQuickStart().catch(() => {})
  }, [])

  // CLI profiles can arrive after the popover opened: keep the choice valid.
  const isShell = cli === SHELL_CLI
  useEffect(() => {
    if (cli !== SHELL_CLI && cliTypes.length && !cliTypes.some((c) => c.id === cli)) setChoice(initialChoice(cliTypes))
  }, [cliProfiles]) // eslint-disable-line react-hooks/exhaustive-deps

  // One line that grows with the text (up to ~6 lines, then scrolls).
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])

  useEffect(() => {
    if (findingProject) return
    if (entry === 'quick') inputRef.current?.focus()
    else setupRef.current?.focus()
  }, [entry, findingProject])

  useEffect(() => { if (editingRoot) rootRef.current?.focus() }, [editingRoot])

  const models = isShell ? [] : getModelsForCli(cli)
  const where = describeTarget(target, { workspaces, quickStart })
  const rootLabel = where.isProject ? where.short : (where.short || '~/Projekte')
  const setupKey = keybindings?.newSessionSetup ? formatKeyCombo(keybindings.newSessionSetup) : null

  const start = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const workspaceId = where.isProject ? target : null
      if (isShell) await startQuickTerminal({ text, workspaceId })
      else await startQuickSession({ text, cliType: cli, model, workspaceId })
      onClose()
    } catch (err) {
      setError(err?.message || 'The session could not be started.')
      setBusy(false)
    }
  }

  const saveRoot = async (e) => {
    e?.preventDefault()
    const value = rootDraft.trim()
    if (!value || rootBusy) return
    setRootBusy(true)
    setRootError('')
    try {
      await updateQuickStartRoot(value)
      setEditingRoot(false)
      inputRef.current?.focus()
    } catch (err) {
      setRootError(err?.message || 'That folder does not exist.')
    } finally {
      setRootBusy(false)
    }
  }

  const setup = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (text.trim()) useStore.setState({ newSessionPrefillPurpose: text.trim() })
      await openSessionSetup(where.isProject ? target : null)
    } catch (err) { setError(err?.message || 'Could not open session setup.') }
    finally { setBusy(false) }
  }

  if (findingProject) return <WorkspacePicker
    title="Add a project"
    subtitle="Connect a folder, then set up a session for that project."
    onClose={() => setFindingProject(false)}
    onSelect={async (project) => {
      const { workspace } = await connectProject(project)
      setTarget(workspace.id)
      useStore.getState().setActiveWorkspace(workspace.id)
      setFindingProject(false)
    }}
  />

  const pickCli = (id) => setChoice({ cli: id, model: id === SHELL_CLI ? '' : getDefaultModel(id) })

  return (
    <div className="fixed inset-0 z-[60] flex justify-center px-4 pt-[16vh]" style={{ background: 'color-mix(in srgb, var(--x-scrim) 45%, transparent)' }} onMouseDown={busy ? undefined : onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={entry === 'choose' ? 'New session' : 'Quick chat'}
        data-quick-start
        className="x-panel scale-in h-fit max-h-[80dvh] w-[min(560px,100%)] overflow-y-auto shadow-[var(--x-shadow-3)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="ive-session-entry-heading">
          <div>{entry === 'quick' && <button type="button" onClick={() => setEntry('choose')} aria-label="Back to session options"><ArrowLeft size={17} /></button>}<h2>{entry === 'choose' ? 'New session' : 'Quick chat'}</h2></div>
          <button type="button" disabled={busy} onClick={onClose} aria-label="Close"><X size={17} /></button>
        </header>
        {entry === 'choose' ? <div className="ive-session-entry">
          <p>Choose a project and how you want to work.</p>
          <div className="ive-session-entry-project">
            <label htmlFor="session-entry-project">Project</label>
            <div><ProjectTargetSelect id="session-entry-project" value={target} onChange={setTarget} onFindProject={() => setFindingProject(true)} /><button type="button" onClick={() => setFindingProject(true)}><Plus size={14} /> Add project</button></div>
            {!where.isProject && <span>No project selected. Your session will start in {rootLabel}.</span>}
          </div>
          <button ref={setupRef} type="button" className="ive-session-entry-option is-primary" disabled={busy} onClick={setup}>
            <SlidersHorizontal size={20} /><span><strong>Set up session</strong><span>Name your session, describe the task, and choose the model, permissions, context and tools.</span></span><ArrowRight size={17} />
          </button>
          <button type="button" className="ive-session-entry-option" disabled={busy} onClick={() => setEntry('quick')}>
            <MessageSquare size={20} /><span><strong>Quick chat</strong><span>Start a conversation with your usual settings.</span></span><ArrowRight size={17} />
          </button>
          {error && <p role="alert" className="text-x-danger">{error}</p>}
        </div> : <>
        <form
          onSubmit={(e) => { e.preventDefault(); start() }}
          className="flex items-end gap-2 px-4 pt-4 pb-3"
        >
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                start()
              }
            }}
            aria-label={isShell ? 'Command to run (optional)' : 'What do you want to work on?'}
            placeholder={isShell ? 'Command to run (optional), Enter opens the terminal' : 'What do you want to work on?'}
            className="min-h-[28px] flex-1 resize-none bg-transparent py-1 text-[15px] leading-[1.45] text-x-ink placeholder:text-x-muted outline-none"
          />
          <button
            type="submit"
            disabled={busy}
            aria-label={isShell ? 'Open terminal' : 'Start session'}
            title={`Start in ${where.isProject ? where.name : 'the start folder'} (Enter)`}
            className="mb-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-x-accent text-x-on-accent transition-colors duration-[80ms] hover:bg-x-accent/85 disabled:opacity-60"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={15} />}
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3" role="group" aria-label="Agent">
          {cliTypes.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={cli === c.id}
              onClick={() => pickCli(c.id)}
              className={`h-[24px] rounded-full border px-2.5 text-[11px] font-medium transition-colors duration-[80ms] ${
                cli === c.id
                  ? 'border-x-accent bg-x-tint text-x-accent-ink'
                  : 'border-x-line bg-x-surface text-x-ink-secondary hover:bg-x-hover hover:text-x-ink'
              }`}
            >
              <ProviderLogo provider={c.id} className="w-3.5 h-3.5 shrink-0" />
              {CLI_SHORT[c.id] || c.label}
            </button>
          ))}
          {/* Not an agent: the login shell, like a Terminal window. */}
          <button
            type="button"
            aria-pressed={isShell}
            data-cli-choice="shell"
            onClick={() => pickCli(SHELL_CLI)}
            title="Your login shell, no AI"
            className={`inline-flex h-[24px] items-center gap-1 rounded-full border px-2.5 text-[11px] font-medium transition-colors duration-[80ms] ${
              isShell
                ? 'border-x-accent bg-x-tint text-x-accent-ink'
                : 'border-x-line bg-x-surface text-x-ink-secondary hover:bg-x-hover hover:text-x-ink'
            }`}
          >
            <Terminal size={11} aria-hidden="true" />
            {SHELL_LABEL}
          </button>
          {models.length > 0 && (
            <select
              aria-label="Model"
              value={model}
              onChange={(e) => setChoice({ cli, model: e.target.value })}
              className="h-[24px] max-w-[200px] rounded-full border border-x-line bg-x-surface px-2 font-mono text-[11px] text-x-ink-secondary outline-none hover:bg-x-hover focus-visible:ring-2 focus-visible:ring-x-focus"
            >
              {!models.some((m) => m.id === model) && model && <option value={model}>{model}</option>}
              {models.map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
            </select>
          )}
          <span className="ml-auto text-[11px] text-x-faint">Enter starts · Shift+Enter new line</span>
        </div>
        {!where.isProject && (
          <p className="-mt-1 px-4 pb-3 text-[11px] text-x-muted" data-quick-start-summary>
            No project: the session runs in the start folder and the agent finds the project. You can attach it to a project later.
          </p>
        )}

        {error && <p role="alert" className="px-4 pb-3 text-[12px] text-x-danger">{error}</p>}

        <footer className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-x-line bg-x-surface-2 px-4 py-2 text-[12px] text-x-muted">
          {editingRoot ? (
            <form onSubmit={saveRoot} data-quick-start-root className="flex min-w-0 flex-1 items-center gap-1.5">
              <FolderOpen size={13} className="shrink-0" />
              <input
                ref={rootRef}
                aria-label="Start folder"
                value={rootDraft}
                onChange={(e) => setRootDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.preventDefault(); setEditingRoot(false); inputRef.current?.focus() }
                }}
                placeholder="/path/to/folder"
                className="min-w-0 flex-1 rounded-md border border-x-line bg-x-surface px-2 py-1 font-mono text-[11px] text-x-ink outline-none focus:border-x-accent"
              />
              <button type="submit" disabled={rootBusy || !rootDraft.trim()} className="rounded-md px-2 py-1 font-medium text-x-accent-ink hover:bg-x-hover disabled:opacity-50">
                {rootBusy ? 'Saving…' : 'Save'}
              </button>
              <button type="button" onClick={() => { setEditingRoot(false); inputRef.current?.focus() }} className="rounded-md px-2 py-1 hover:bg-x-hover">Cancel</button>
            </form>
          ) : (
            <span className="flex min-w-[min(100%,260px)] flex-1 items-center gap-1.5" data-quick-start-where>
              <FolderOpen size={13} className="shrink-0" aria-hidden="true" />
              <ProjectTargetSelect
                value={target}
                onChange={(id) => { setTarget(id); inputRef.current?.focus() }}
                label="Project"
                className="h-[24px] max-w-[160px] shrink-0 rounded-md border border-x-line bg-x-surface px-1.5 text-[12px] font-medium text-x-ink outline-none hover:bg-x-hover focus-visible:ring-2 focus-visible:ring-x-focus"
              />
              <span className="truncate font-mono text-[11px] text-x-ink-secondary" title={where.path}>{rootLabel}</span>
              {!where.isProject && (
                <button
                  type="button"
                  onClick={() => { setRootDraft(quickStart?.root || ''); setRootError(''); setEditingRoot(true) }}
                  className="shrink-0 text-x-link hover:underline"
                  aria-label="Change start folder"
                >
                  change
                </button>
              )}
            </span>
          )}
          {!editingRoot && (
            <button
              type="button"
              onClick={setup} disabled={busy}
              className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-x-ink-secondary hover:bg-x-hover hover:text-x-ink"
            >
              <SlidersHorizontal size={12} />
              Set up session…
              {setupKey && <kbd className="font-mono text-[11px] text-x-faint">{setupKey}</kbd>}
            </button>
          )}
        </footer>
        {rootError && <p role="alert" className="border-t border-x-line bg-x-surface-2 px-4 pb-2 text-[12px] text-x-danger">{rootError}</p>}
        </>}
      </div>
    </div>
  )
}
