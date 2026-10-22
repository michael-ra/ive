import SessionBrief from '../components/session/SessionBrief'
import { Terminal, Maximize2, Minimize2, X } from 'lucide-react'
import useStore from '../state/store'
import ChatPanel from '../components/chat/ChatPanel'
import SessionSidebar from '../components/session/SessionSidebar'
import TerminalSlot from '../components/shell/TerminalSlot'
import Kbd from '../components/ui/Kbd'
import { isShellSession } from '../lib/sessionStatus'
import { formatKeyCombo } from '../lib/keybindings'
import { useT } from '../lib/i18n'
import '../lib/i18n/shell'

// Agent sessions can show chat alone, chat with a drawer, or a full terminal.
// TerminalSlot keeps the same running terminal across all three views.
export default function SessionScreen({ sessionId, sidebarTab = null, sidebarFile = null, onSidebarTabChange, onCloseSidebar, onOpenPanel, onOpenReview }) {
  const t = useT()
  const session = useStore((s) => s.sessions[sessionId])
  const drawerOpen = useStore((s) => !!s.terminalDrawer[sessionId])
  const terminalExpanded = useStore((s) => s.terminalDrawer[sessionId] === 'full')
  const drawerHeight = useStore((s) => s.terminalDrawerHeight)
  const terminalKey = useStore((s) => s.keybindings?.toggleTerminal)
  void onOpenPanel
  void onOpenReview
  if (!sessionId || !session) return null
  const shell = isShellSession(session)
  const shellName = shell ? 'zsh' : (session.cli_type || 'claude')
  const toggleExpanded = () => {
    useStore.getState().setTerminalExpanded(sessionId, !terminalExpanded)
  }

  return (
    <div className="ive-session-screen flex-1 flex min-h-0 min-w-0 relative" data-session-view={sessionId} data-grid-cell-session={sessionId}>
      <div className="ive-session-main flex-1 flex flex-col min-h-0 min-w-0 relative">
        {shell ? (
          <TerminalSlot sessionId={sessionId} mode="full" focusOnMount />
        ) : (
          <>
            {!terminalExpanded && <>
              <SessionBrief key={sessionId} sessionId={sessionId} onOpenReview={onOpenReview} onOpenPanel={onOpenPanel} />
              <ChatPanel
                sessionId={sessionId}
                inGrid={false}
                onToggleTerminal={() => useStore.getState().toggleTerminalDrawer(sessionId)}
                onOpenTerminal={() => useStore.getState().toggleTerminalDrawer(sessionId, true)}
                isTerminalOpen={drawerOpen}
              />
            </>}
            {drawerOpen && (
              <div
                className={terminalExpanded ? 'ive-session-terminal-full flex-1 flex flex-col min-h-0' : 'ive-session-drawer'}
                data-session-terminal-drawer={terminalExpanded ? 'full' : 'open'}
                style={terminalExpanded ? undefined : { height: drawerHeight }}
              >
                <div className="ive-session-drawer-bar">
                  <Terminal size={14} aria-hidden="true" />
                  <span className="ive-session-drawer-title">{t('header.terminal')}</span>
                  <span className="ive-session-drawer-shell t-meta">· {shellName}</span>
                  <span className="ive-header-fill" />
                  <Kbd>{terminalKey ? formatKeyCombo(terminalKey) : '⌘J'}</Kbd>
                  <span className="t-meta">{t('header.toHide')}</span>
                  <button type="button" className="ive-terminal-expand" onClick={toggleExpanded}
                    title={t(terminalExpanded ? 'header.restoreTerminal' : 'header.expandTerminal')}
                    aria-label={t(terminalExpanded ? 'header.restoreTerminal' : 'header.expandTerminal')}>
                    {terminalExpanded ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
                  </button>
                  <button type="button" className="ive-terminal-expand" onClick={() => useStore.getState().toggleTerminalDrawer(sessionId, false)}
                    title={t('header.hideTerminal')} aria-label={t('header.hideTerminal')}>
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
                <TerminalSlot sessionId={sessionId} mode={terminalExpanded ? 'full' : 'drawer'} focusOnMount />
              </div>
            )}
          </>
        )}
      </div>
      {sidebarTab && (
        <SessionSidebar
          sessionId={sessionId}
          initialTab={sidebarTab}
          initialFile={sidebarFile}
          onTabChange={onSidebarTabChange}
          onClose={onCloseSidebar}
        />
      )}
    </div>
  )
}
