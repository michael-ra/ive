import { Keyboard, Sparkles, Plus, MessageSquare, MessageCircle, BellRing, GitCompareArrows, FolderOpen, Search, SquareTerminal, CircleHelp, Settings, BookOpen, GitBranch } from 'lucide-react'
import { Modal } from '../ui'
import { KEYBINDING_DEFS, getKeybindings, formatKeyCombo } from '../../lib/keybindings'
import { isSurfaceAvailable } from '../../lib/extensionRegistry'

// Everyday tasks first, each with the one click / key that does it. The full
// shortcut list follows, read from the live keybindings so custom keys show.
const EVERYDAY = [
  { id: 'start-task', icon: Sparkles, label: 'Start a guided task', how: 'Describe a goal, add context, approve the plan, then review the result', surface: 'pipeline-editor', keys: [] },
  { id: 'new-session', icon: Plus, label: 'New session', how: '“New” in the header, or + in the sidebar', binding: 'newSession' },
  { id: 'side-chat', icon: MessageCircle, label: 'Open Side chat', how: 'The chat bubble in the header. A separate conversation; add project context when needed', binding: 'sideChat' },
  { id: 'find-session', icon: MessageSquare, label: 'Open a session', how: 'Click it under Projects in the sidebar, or search its name', binding: 'commandPalette' },
  { id: 'inbox', icon: BellRing, label: 'See what needs you', how: 'The Waiting count next to Board in the sidebar, or the inbox', binding: 'inbox' },
  { id: 'code-review', icon: GitCompareArrows, label: 'Review changes', how: '“Review” in the sidebar, on the open session', binding: 'codeReview' },
  { id: 'switch-project', icon: FolderOpen, label: 'Switch project', how: 'Click a project in the left list, or search it', binding: 'commandPalette' },
  { id: 'guidelines', icon: BookOpen, label: 'Save reusable instructions', how: 'Guidelines are saved rules. Send selected rules and a note with “context” in a session' },
  { id: 'memory', icon: BookOpen, label: 'Find project context', how: 'Context Hub stores knowledge. Check what is included in your current task', surface: 'memory' },
  { id: 'pipeline-editor', icon: GitBranch, label: 'Explore automated workflows', how: 'Pipelines arrange planning, work and checks. Start a guided task for your first try', surface: 'pipeline-editor' },
  { id: 'toggle-terminal', icon: SquareTerminal, label: 'Show or hide the terminal', how: 'Terminal drawer at the bottom of the session', binding: 'toggleTerminal' },
  { id: 'command-palette', icon: Search, label: 'Find any tool', how: 'The search icon in the header, or ⌘ in the sidebar', binding: 'commandPalette' },
  { id: 'find-in-session', icon: Search, label: 'Find in this chat or terminal', how: 'Enter / ⇧Enter step through matches, Esc closes', binding: 'search' },
  { id: 'search', icon: Search, label: 'Search all sessions', how: 'Finds earlier conversations by their content', binding: 'globalSearch' },
]

const SECTION_ORDER = ['Navigation', 'Sessions', 'Panels', 'Feature Board', 'Task Modal']

function Kbd({ children }) {
  return (
    <kbd className="inline-flex min-w-[22px] justify-center rounded border border-x-line bg-x-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-x-ink-secondary">
      {children}
    </kbd>
  )
}

export default function CheatSheet({ onClose, onRun }) {
  const bindings = getKeybindings()
  const sections = SECTION_ORDER.map((section) => ({
    section,
    items: KEYBINDING_DEFS.filter((def) => def.section === section && bindings[def.id]),
  })).filter((s) => s.items.length)

  const run = (id) => { onClose(); onRun(id) }

  return (
    <Modal
      onClose={onClose}
      icon={Keyboard}
      title="Quick help"
      subtitle="The everyday actions and every keyboard shortcut. Press ? anywhere to open this."
      size="md"
      bodyClassName="overflow-y-auto"
      footer={(
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-x-muted">
          <span>Tip: <Kbd>{formatKeyCombo(bindings.commandPalette)}</Kbd> finds every tool, session and project by name.</span>
          <span className="flex gap-2">
            <button type="button" className="inline-flex items-center gap-1 rounded-md border border-x-line px-2 py-1 hover:bg-x-hover hover:text-x-ink" onClick={() => { onClose(); window.dispatchEvent(new Event('open-onboarding')) }}>
              <CircleHelp size={12} /> Interaktive Einführung
            </button>
            <button type="button" className="inline-flex items-center gap-1 rounded-md border border-x-line px-2 py-1 hover:bg-x-hover hover:text-x-ink" onClick={() => run('shortcuts')}>
              <Settings size={12} /> Change shortcuts
            </button>
          </span>
        </div>
      )}
    >
      <div className="p-5" data-cheat-sheet>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-x-muted">Everyday actions</h3>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {EVERYDAY.filter((item) => !item.surface || isSurfaceAvailable(item.surface)).map((item) => {
            const Icon = item.icon
            const combo = item.binding ? bindings[item.binding] : null
            return (
              <button
                key={item.id}
                type="button"
                data-cheat-action={item.id}
                onClick={() => run(item.id)}
                className="flex items-start gap-3 rounded-[10px] border border-x-line bg-x-surface px-3 py-2.5 text-left transition-colors hover:border-x-line-strong hover:bg-x-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-x-accent-ink"
              >
                <span className="mt-0.5 shrink-0 rounded-md bg-x-surface-2 p-1.5 text-x-ink-secondary"><Icon size={14} /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2 text-xs font-semibold text-x-ink">
                    {item.label}
                    {combo && <Kbd>{formatKeyCombo(combo)}</Kbd>}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-x-muted">{item.how}</span>
                </span>
              </button>
            )
          })}
        </div>

        <h3 className="mb-2 mt-6 text-[11px] font-semibold uppercase tracking-[0.06em] text-x-muted">All keyboard shortcuts</h3>
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          {sections.map(({ section, items }) => (
            <div key={section}>
              <div className="mb-1 border-b border-x-line pb-1 text-[11px] font-semibold text-x-ink-secondary">{section}</div>
              <dl className="space-y-1">
                {section === 'Navigation' && (
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <dt className="text-x-muted">This help</dt><dd><Kbd>?</Kbd></dd>
                  </div>
                )}
                {section === 'Sessions' && (
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <dt className="text-x-muted">Go to tab 1 to 9</dt><dd><Kbd>⌘1–9</Kbd></dd>
                  </div>
                )}
                {items.map((def) => (
                  <div key={def.id} className="flex items-center justify-between gap-2 text-[11px]">
                    <dt className="text-x-muted">{def.label}</dt>
                    <dd><Kbd>{formatKeyCombo(bindings[def.id])}</Kbd></dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}
