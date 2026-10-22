import HelpDetails from '../ui/HelpDetails'
import { ArrowRight, FolderOpen, Search, Terminal } from 'lucide-react'
import useStore from '../../state/store'
import { getSessionDisplayStatus } from '../../lib/sessionStatus'
import { recentSessions } from '../../lib/visibleSessions'

export default function ContinueWork({ onAction }) {
  const workspaces = useStore((s) => s.workspaces)
  const sessions = useStore((s) => s.sessions)
  const sessionStarted = useStore((s) => s.sessionStarted)
  const recent = recentSessions(sessions, { limit: 3 })

  return (
    <section className="ive-continue-panel ive-control-surface" aria-labelledby="continue-work-title">
      <header className="ive-panel-heading">
        <span className="ive-panel-icon"><FolderOpen size={18} /></span>
        <div>
          <p className="ive-eyebrow">{workspaces.length ? 'Your workspace' : 'Get started'}</p>
          <h2 id="continue-work-title">{workspaces.length ? 'Continue working' : 'Start your first session'}</h2>
        </div>
      </header>
      {recent.length > 0 ? (
        <>
          <div className="ive-recent-sessions">
            {recent.map((session) => {
              const status = getSessionDisplayStatus(session, sessionStarted)
              const workspace = workspaces.find((ws) => ws.id === session.workspace_id)
              return (
                <button
                  type="button"
                  key={session.id}
                  className="ive-recent-session"
                  onClick={() => useStore.getState().goSession(session.id)}
                  title={`Open ${session.name}`}
                >
                  <Terminal size={16} className="shrink-0 text-x-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-x-ink">{session.name}</span>
                    <span className="mt-1 flex items-center gap-2 text-xs text-x-muted">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.dotClass}`} />
                      {status.label}
                      <span className="truncate">· {workspace?.name || session.model || session.cli_type}</span>
                    </span>
                  </span>
                  <ArrowRight size={15} className="shrink-0 text-x-muted" />
                </button>
              )
            })}
          </div>
          <button type="button" className="ive-text-action" onClick={() => onAction('search')}>
            <Search size={14} /> Find a session <ArrowRight size={14} />
          </button>
        </>
      ) : (
        <>
          <p className="ive-start-guide">
            {workspaces.length
              ? 'Your project is ready. Start a chat with your agent.'
              : 'Tell your agent what you want to work on.'}
          </p>
          <HelpDetails label="How it works"><ol className="ive-start-steps">
            <li><span>1</span><div><strong>Say what you want</strong><p>{workspaces.length ? 'Name the connected project and describe the change you want.' : 'Describe your idea, then connect the project folder when you are ready.'}</p></div></li>
            <li><span>2</span><div><strong>Add context if you like</strong><p>Guidelines or notes, any time during the session.</p></div></li>
            <li><span>3</span><div><strong>Work and review</strong><p>Follow progress and inspect the changes.</p></div></li>
          </ol></HelpDetails>
          <button type="button" className="ive-start-action" onClick={() => onAction('new-session')}>
            Start a session <ArrowRight size={16} />
          </button>
          {!workspaces.length && (
            <button type="button" className="ive-text-action" onClick={() => onAction('add-workspace')}>
              <FolderOpen size={14} /> Connect a project folder <ArrowRight size={14} />
            </button>
          )}
        </>
      )}
    </section>
  )
}
