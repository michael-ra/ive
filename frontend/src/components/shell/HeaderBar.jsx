import SessionContextActions from '../session/SessionContextActions'
import { Plus, Search, MessageCircle, Settings } from 'lucide-react'
import useStore from '../../state/store'
import SidebarToggle from '../layout/SidebarToggle'
import { registerHeaderSlot } from './HeaderPortal'
import { isQuickWorkspace } from '../../lib/quickStart'
import { routeLabel } from '../../lib/route'
import { formatKeyCombo } from '../../lib/keybindings'
import { useT } from '../../lib/i18n'
import '../../lib/i18n/shell'

// 44 px header: sidebar toggle, breadcrumb (Home / Board / project › session),
// the address (ive/demo-app/add-rate-limiting), two portal slots the screens
// fill (crumb, actions) and the global buttons. In a session only the side
// chat button stays; new session, search and settings live on ⌃N / ⌘K.
function Breadcrumb({ view, onGoBoard }) {
  const t = useT()
  const session = useStore((s) => (s.activeSessionId ? s.sessions[s.activeSessionId] : null))
  const workspace = useStore((s) => s.workspaces.find((ws) => ws.id === session?.workspace_id) || null)
  if (view === 'session' && session) {
    return (
      <nav className="ive-breadcrumb" aria-label="Where you are" data-breadcrumb="">
        {workspace && (
          <>
            <button
              type="button"
              data-chrome-button
              className="ive-crumb-parent"
              title={`${t('nav.board')} · ${workspace.name}`}
              onClick={() => {
                useStore.getState().setBoardFilters({ workspaceId: workspace.id })
                onGoBoard?.()
              }}
            >
              {isQuickWorkspace(workspace) ? t('nav.withoutProject') : workspace.name}
            </button>
            <span className="ive-crumb-sep" aria-hidden="true">›</span>
          </>
        )}
        <strong className="ive-crumb-current" title={session.name}>{session.name}</strong>
      </nav>
    )
  }
  return (
    <nav className="ive-breadcrumb" aria-label="Where you are" data-breadcrumb="">
      <strong className="ive-crumb-current">{view === 'board' ? t('nav.board') : t('nav.home')}</strong>
    </nav>
  )
}

export default function HeaderBar({ view, onGoHome, onGoBoard, onNewSession, onOpenPanel, onToggleSideChat, sideChatOpen = false, isOwner = false }) {
  const t = useT()
  const address = useStore((s) => routeLabel(s, s.workspaces))
  const newKey = useStore((s) => s.keybindings?.newSession)
  const chatKey = useStore((s) => s.keybindings?.sideChat)
  const paletteKey = useStore((s) => s.keybindings?.commandPalette)
  void onGoHome
  const inSession = view === 'session'
  const session = useStore(s => s.sessions[s.activeSessionId])

  return (
    <header className="x-context-bar ive-header" data-view={view} data-session-header={inSession ? '' : undefined}>
      <SidebarToggle />
      <Breadcrumb view={view} onGoBoard={onGoBoard} />
      <span className="ive-header-address mono" data-header-address="" title={address}>{address}</span>
      <div data-header-slot="crumb" className="ive-header-slot" ref={(el) => registerHeaderSlot('crumb', el)} />
      <div className="ive-header-fill" />
      <div data-header-slot="actions" className="ive-header-slot ive-header-slot--actions" ref={(el) => registerHeaderSlot('actions', el)} />
      <div className="ive-header-global">
        {(inSession || view === 'board') && session && session.cli_type !== 'shell' && <SessionContextActions sessionId={session.id} readOnly={!!session.read_only} phone />}
        {!inSession && (
          <button
            type="button"
            data-new-session-button
            data-chrome-button
            className="ive-header-btn ive-header-btn--new"
            aria-label={t('header.newSession')}
            title={`${t('header.newSession')}${newKey ? ` (${formatKeyCombo(newKey)})` : ''}`}
            onClick={onNewSession}
          >
            <Plus size={15} aria-hidden="true" />
            <span className="ive-header-btn-label">{t('header.new')}</span>
          </button>
        )}
        {!inSession && (
          <button
            type="button"
            data-chrome-button
            className="ive-header-btn"
            aria-label={t('header.search')}
            title={`${t('header.search')}${paletteKey ? ` (${formatKeyCombo(paletteKey)})` : ''}`}
            onClick={() => window.dispatchEvent(new CustomEvent('open-command-palette'))}
          >
            <Search size={15} aria-hidden="true" />
          </button>
        )}
        {isOwner && onToggleSideChat && (
          <button
            type="button"
            data-chrome-button
            className="ive-header-btn"
            aria-label={t('header.sideChat')}
            aria-pressed={sideChatOpen}
            aria-controls="ive-sidechat"
            title={`${t('header.sideChat')}${chatKey ? ` (${formatKeyCombo(chatKey)})` : ''}`}
            onClick={onToggleSideChat}
          >
            <MessageCircle size={15} aria-hidden="true" />
          </button>
        )}
        {!inSession && (
          <button
            type="button"
            data-chrome-button
            className="ive-header-btn"
            aria-label={t('header.settings')}
            title={t('header.settings')}
            onClick={() => onOpenPanel?.('general-settings')}
          >
            <Settings size={15} aria-hidden="true" />
          </button>
        )}
      </div>
    </header>
  )
}
