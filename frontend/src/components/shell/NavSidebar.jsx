import { visibleSessions } from '../../lib/visibleSessions'
import { sessionNeedsAttention } from '../../lib/sessionAttention'
import { useRef, useState } from 'react'
import { Command, Plus, SquarePen, Search, X, House, Columns3, GitCompareArrows, BookOpen, Settings, Plug, Smartphone } from 'lucide-react'
import useStore from '../../state/store'
import useView from '../../hooks/useView'
import { selectCounts } from '../../state/selectors'
import { isSurfaceAvailable } from '../../lib/extensionRegistry'
import Sidebar from '../layout/Sidebar'
import SidebarFoot from './SidebarFoot'
import { useT } from '../../lib/i18n'
import '../../lib/i18n/shell'
import markLight from '../../assets/ive-mark-light.svg'
import markDark from '../../assets/ive-mark-dark.svg'

// The sidebar: brand, filter, Work (Home · Board · Review · Knowledge), the
// project tree, Set up (Settings · Connectors · Phone), and the foot. Helper
// sessions (Commander, Brainstormer) never appear here.
function NavItem({ id, icon: Icon, label, current, onClick, children, title }) {
  return (
    <button
      type="button"
      data-nav={id}
      data-chrome-button
      className="ive-nav-item"
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
      title={title || label}
    >
      <Icon size={15} aria-hidden="true" />
      <span className="ive-nav-label">{label}</span>
      {children}
    </button>
  )
}

export default function NavSidebar({
  onOpenPanel, onNewSession, onGoHome, onGoBoard, onOpenAttention, onOpenReview, onOpenKnowledge,
  activeOverlay = null, attentionCount = 0, catchUp = null,
}) {
  const t = useT()
  const view = useView()
  const counts = useStore(selectCounts)
  const sessions = useStore(s=>s.sessions)
  const waitingSessions = visibleSessions(sessions).filter(sessionNeedsAttention)
  const [filter, setFilter] = useState('')
  const filterRef = useRef(null)
  const waiting = waitingSessions.length + (attentionCount || 0)

  return (
    <aside id="ive-project-sidebar" aria-label="Projects and sessions" className="x-sidebar">
      <div className="ive-sidebar-head">
        <div className="ive-sidebar-brand">
          <img src={markLight} alt="" className="ive-brand-mark ive-brand-mark--light" width="20" height="20" aria-hidden="true" />
          <img src={markDark} alt="" className="ive-brand-mark ive-brand-mark--dark" width="20" height="20" aria-hidden="true" />
          <span className="ive-brand-name">IVE</span>
        </div>
        <div className="ive-sidebar-head-actions">
          <button
            type="button"
            data-chrome-button
            className="ive-sidebar-icon-btn"
            aria-label={t('nav.searchCommands')}
            title={`${t('nav.searchCommands')} (⌘K)`}
            onClick={() => window.dispatchEvent(new CustomEvent('open-command-palette'))}
          >
            <Command size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      <button type="button" data-sidebar-new-chat className="ive-sidebar-new-chat" onClick={onNewSession}>
        <SquarePen size={16} aria-hidden="true" /><span>{t('nav.newSession')}</span><kbd className="ive-kbd">⌘N</kbd>
      </button>

      <div className="ive-sidebar-filter">
        <Search size={14} aria-hidden="true" className="ive-sidebar-filter-icon" />
        <input
          ref={filterRef}
          type="search"
          aria-label="Filter sessions by name or model"
          value={filter}
          placeholder={t('nav.search')}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && filter) { e.preventDefault(); e.stopPropagation(); setFilter(''); return }
            if (e.key === 'Enter' && !filter.trim()) { e.preventDefault(); window.dispatchEvent(new CustomEvent('open-command-palette')) }
          }}
        />
        {filter ? (
          <button type="button" className="ive-sidebar-filter-clear" aria-label="Clear session filter" title="Clear filter (Esc)" onClick={() => { setFilter(''); filterRef.current?.focus() }}>
            <X size={13} aria-hidden="true" />
          </button>
        ) : (
          <kbd className="ive-kbd" aria-hidden="true">⌘K</kbd>
        )}
      </div>

      <nav className="ive-nav-group" aria-label={t('nav.work')}>
        <div className="t-label ive-nav-group-title">{t('nav.work')}</div>
        <NavItem id="home" icon={House} label={t('nav.home')} current={!activeOverlay && view === 'home'} onClick={onGoHome} />
        <NavItem id="board" icon={Columns3} label={t('nav.board')} current={!activeOverlay && view === 'board'} onClick={onGoBoard}>
          {counts.running > 0 && <span className="ive-nav-badge" data-board-badge>{counts.running} running</span>}
          {catchUp?.stale && (
            <span
              className="ive-nav-dot"
              data-catchup-badge=""
              title={`${catchUp.count} events while you were away`}
              onClick={(e) => { e.stopPropagation(); catchUp.open?.() }}
              aria-hidden="true"
            />
          )}
        </NavItem>
        {waiting > 0 && (
          <button type="button" className="ive-needs-you" onClick={onOpenAttention}
            aria-haspopup="dialog">
            {waiting} {waiting === 1 ? 'item needs' : 'items need'} your attention
            <span aria-hidden="true">→</span>
          </button>
        )}
        <NavItem id="review" icon={GitCompareArrows} label={t('nav.review')} current={activeOverlay === 'review'} onClick={onOpenReview} />
        <NavItem id="knowledge" icon={BookOpen} label={t('nav.knowledge')} current={activeOverlay === 'knowledge'} onClick={onOpenKnowledge} />
      </nav>

      <div className="ive-nav-group ive-nav-group--projects">
        <div className="t-label ive-nav-group-title ive-project-heading">
          <span>{t('nav.projects')}</span>
          <button type="button" className="ive-sidebar-icon-btn" aria-label={t('nav.addProject')} title={t('nav.addProject')} onClick={() => window.dispatchEvent(new CustomEvent('open-add-workspace'))}>
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
        <Sidebar filter={filter} />
      </div>

      <nav className="ive-nav-group ive-nav-group--setup" aria-label={t('nav.setup')}>
        <div className="t-label ive-nav-group-title">{t('nav.setup')}</div>
        <NavItem id="settings" icon={Settings} label={t('nav.settings')} current={activeOverlay === 'settings'} onClick={() => onOpenPanel?.('general-settings')} />
        <NavItem id="connectors" icon={Plug} label={t('nav.connectors')} current={activeOverlay === 'connectors'} onClick={() => onOpenPanel?.('connectors')} />
        {isSurfaceAvailable('phone-access') && (
          <NavItem id="phone" icon={Smartphone} label={t('nav.phone')} current={activeOverlay === 'phone'} onClick={() => onOpenPanel?.('phone-access')} />
        )}
      </nav>

      <SidebarFoot />
    </aside>
  )
}
