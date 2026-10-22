import { useCallback, useState } from 'react'
import { ArrowUp, ListChecks, Paperclip, Plus } from 'lucide-react'
import { Button, IconButton } from '../ui'
import useStore from '../../state/store'
import { getCliLabel } from '../../lib/constants'
import { formatKeyCombo, isMacPlatform } from '../../lib/keybindings'
import { describeTarget, lastAgentChoice, startDirectSession } from '../../lib/quickStart'
import ProjectTargetSelect from '../session/ProjectTargetSelect'

// Home composer: Enter talks to an agent right away (like Claude Code, Codex
// or Cursor), planning is its own named action with its own shortcut.
export const PLAN_SHORTCUT = formatKeyCombo({ key: 'Enter', ...(isMacPlatform() ? { meta: true } : { ctrl: true }) })

/** ⌘↵ / Ctrl+↵ in the Home composer = Plan task. */
export function isPlanShortcut(e) {
  return e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey
}

/** Text for the agent: what was typed plus pasted images as markdown links. */
export function composeHomePrompt(text, images = []) {
  return [String(text || '').trim(), ...images.map((img) => `![${img.filename}](${img.path})`)].filter(Boolean).join('\n\n')
}

function useWhere(target) {
  const workspaces = useStore((s) => s.workspaces)
  const quickStart = useStore((s) => s.quickStart)
  return describeTarget(target, { workspaces, quickStart })
}

/** Enter in the Home composer: start a session with the text as first message. */
export function useHomeStart() {
  const [busy, setBusy] = useState(false)
  const start = useCallback(async ({ text, workspaceId }) => {
    if (!String(text || '').trim()) return false
    setBusy(true)
    try {
      await startDirectSession({ text, workspaceId })
      return true
    } catch (err) {
      useStore.getState().addNotification?.({ type: 'error', message: err?.message || 'The session could not be started.' })
      return false
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, start }
}

const selectClass = 'h-9 min-w-0 max-w-[220px] bg-x-surface-2 border border-x-line rounded-md px-3 text-xs text-x-ink-secondary focus:outline-none focus:border-x-accent'

/**
 * Bottom row of the Home composer: where the work runs (project or start
 * folder), attachments, and the actions. "Start session" is the submit
 * button, so Enter does exactly what it says.
 */
export function HomeStartControls({ target, onTargetChange, onFindProject, onAttach, hasInput, busy, planAvailable, onPlan, onBrainstorm, onTicket }) {
  const where = useWhere(target)
  return (
    <div className="flex flex-row flex-wrap items-center justify-between gap-3 border-t border-x-line pt-3 mt-2 shrink-0">
      <div className="flex min-w-0 max-w-full items-center gap-2">
        <ProjectTargetSelect value={target} onChange={onTargetChange} onFindProject={onFindProject} className={selectClass} />
        <IconButton
          icon={Paperclip}
          label="Attach images"
          iconSize={16}
          onClick={onAttach}
          className="h-9 w-9"
          title="Attach images (or paste / drag & drop)"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={onBrainstorm}
          disabled={!hasInput || !where.isProject}
          className="h-9 px-3 text-xs"
          title={where.isProject ? 'Explore the idea with the project brainstormer' : 'Pick a project to brainstorm'}
        >
          Brainstorm
        </Button>
        <Button
          type="button"
          onClick={onTicket}
          disabled={!hasInput || !where.isProject}
          icon={Plus}
          className="h-9 px-3 text-xs"
          title={where.isProject ? 'Save this as a backlog ticket for later' : 'Pick a project to create a ticket'}
        >
          Create ticket
        </Button>
        {planAvailable && (
          <Button
            type="button"
            onClick={onPlan}
            disabled={!hasInput}
            icon={ListChecks}
            data-home-plan
            className="h-9 px-3 text-xs font-semibold"
            title={`Plan task (${PLAN_SHORTCUT}): IVE drafts a plan for your approval, then implements and checks the result`}
          >
            <span>Plan task</span>
            <kbd className="ml-1 font-mono text-[11px] font-normal text-x-faint">{PLAN_SHORTCUT}</kbd>
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          icon={ArrowUp}
          loading={busy}
          disabled={!hasInput || busy}
          data-home-start
          className="h-9 px-4 text-xs font-semibold"
          title={`Start session (Enter): ${where.isProject ? `chat with the agent in ${where.name}` : 'chat with the agent in the start folder'}`}
        >
          <span>Start session</span>
        </Button>
      </div>
    </div>
  )
}

/** One line under the composer that says what Enter and Plan task do, and where. */
export function HomeStartHint({ id, target, planAvailable, noProjects, onAddProject }) {
  const where = useWhere(target)
  const agent = getCliLabel(lastAgentChoice().cli)
  return (
    <p id={id} className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs leading-relaxed text-x-muted" data-home-start-hint>
      <span>
        <strong className="font-semibold text-x-ink-secondary">Enter</strong> starts a session with {agent} in{' '}
        {where.isProject
          ? <><strong className="font-semibold text-x-ink-secondary">{where.name}</strong> <span className="font-mono break-all">({where.short})</span></>
          : <>the start folder <span className="font-mono break-all">{where.short}</span>, no project</>}.
        {planAvailable && <> <strong className="font-semibold text-x-ink-secondary">Plan task</strong> ({PLAN_SHORTCUT}) drafts a plan for your approval, then implements and checks the result.</>}
      </span>
      {noProjects && (
        <button
          type="button"
          onClick={onAddProject}
          className="font-semibold text-x-accent-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-x-accent-ink"
        >
          Add a project
        </button>
      )}
    </p>
  )
}
