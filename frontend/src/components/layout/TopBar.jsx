import ProviderLogo from '../ui/ProviderLogo'
import { useEffect, useRef, useState } from 'react'
import useEscapeToClose from '../../hooks/useEscapeToClose'
import { MoreHorizontal, Square, StickyNote, RotateCcw, Shuffle, GitCompareArrows, BookOpenCheck, Hash, MessageSquareQuote, Files, Lock, Globe2, Eye, Boxes, Newspaper } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { getSessionStatusMeta, hasSessionStarted, getSessionDisplayStatus, isShellSession } from '../../lib/sessionStatus'
import { loadRecentAnnotations } from '../../lib/annotations'
import { getCliTypes, getModelsForCli, getRoleDefaultModel } from '../../lib/constants'
import QuickActions from '../command/QuickActions'
import VoiceControl from './VoiceControl'
import { Button, IconButton } from '../ui'
import SessionContextActions, { ProjectHintChip } from '../session/SessionContextActions'
import useMediaQuery from '../../hooks/useMediaQuery'

function compactNumber(value) {
  const n = Number(value) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

export default function TopBar() {
  const session = useStore((s) => s.sessions[s.activeSessionId])
  const sessionStarted = useStore((s) => s.sessionStarted)
  const activeSessionId = useStore((s) => s.activeSessionId)
  // Phones show one session at a time, so there is no separate Overview level there.
  const isMobile = useMediaQuery('(max-width: 767px)')
  const sessionFocus = useStore((s) => s.sessionFocus) && !isMobile
  const cliProfiles = useStore((s) => s.cliProfiles)
  const currentAuth = useStore((s) => s.currentAuth)
  const [showSwitcher, setShowSwitcher] = useState(false)
  const [switching, setSwitching] = useState(false)
  const switchingRef = useRef(false)
  const switcherBtnRef = useRef(null)
  const switcherMenuRef = useRef(null)
  const [switcherPos, setSwitcherPos] = useState(null)
  const [annotationCount, setAnnotationCount] = useState(0)
  const [privacyBusy, setPrivacyBusy] = useState(false)
  const [sharingStatus, setSharingStatus] = useState(null)
  // Overflow menu for the occasional panel actions (scratchpad, annotations) so
  // the context bar keeps only the frequently-used controls visible.
  const [showMore, setShowMore] = useState(false)
  const moreBtnRef = useRef(null)
  const moreMenuRef = useRef(null)
  const [morePos, setMorePos] = useState(null)
  useEscapeToClose(showSwitcher, () => setShowSwitcher(false))
  useEscapeToClose(showMore, () => setShowMore(false))
  // The bar's own width decides (side chat open, narrow window): below this
  // the action buttons drop their words and keep icon + tooltip, so nothing
  // overlaps or runs off the edge.
  const barRef = useRef(null)
  const [barCompact, setBarCompact] = useState(false)
  useEffect(() => {
    const el = barRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const update = () => setBarCompact(el.clientWidth < 1080)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [session?.id])

  const sessionType = session?.session_type
  const sessionReadOnly = !!session?.read_only

  useEffect(() => {
    if (!showSwitcher) return
    // Anchor the menu in viewport coords so it escapes the TopBar's
    // overflow-x-auto container, which would otherwise clip it.
    const r = switcherBtnRef.current?.getBoundingClientRect()
    if (r) setSwitcherPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
    const onDocClick = (e) => {
      if (switcherMenuRef.current?.contains(e.target)) return
      if (switcherBtnRef.current?.contains(e.target)) return
      setShowSwitcher(false)
    }
    const onResize = () => setShowSwitcher(false)
    document.addEventListener('mousedown', onDocClick)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [showSwitcher])

  useEffect(() => {
    if (!showMore) return
    // Same viewport anchoring as the CLI switcher: the bar scrolls horizontally,
    // so an absolutely-positioned menu would be clipped by its overflow.
    const r = moreBtnRef.current?.getBoundingClientRect()
    if (r) setMorePos({ top: r.bottom + 4, right: window.innerWidth - r.right })
    const onDocClick = (e) => {
      if (moreMenuRef.current?.contains(e.target)) return
      if (moreBtnRef.current?.contains(e.target)) return
      setShowMore(false)
    }
    const onResize = () => setShowMore(false)
    document.addEventListener('mousedown', onDocClick)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [showMore])

  useEffect(() => {
    const workspaceId = session?.workspace_id
    const refresh = () => setAnnotationCount(loadRecentAnnotations(workspaceId).length)
    const updated = (event) => {
      if (event.detail?.workspaceId && event.detail.workspaceId !== workspaceId) return
      refresh()
    }
    refresh()
    window.addEventListener('cc-annotations-updated', updated)
    return () => window.removeEventListener('cc-annotations-updated', updated)
  }, [session?.workspace_id])

  useEffect(() => {
    if (sessionType !== 'brainstormer' || sessionReadOnly) {
      setSharingStatus(null)
      return
    }
    let cancelled = false
    const refresh = async () => {
      try {
        const status = await api.getRuntimeStatus()
        if (!cancelled) setSharingStatus(status)
      } catch {
        if (!cancelled) setSharingStatus(null)
      }
    }
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionType, sessionReadOnly])

  if (!session) return null

  const isShell = isShellSession(session)
  const isRunning = session.status === 'running' || (isShell && session.pty_alive === true)
  const isExited = session.status === 'exited' || session.status === 'auth_failed'
  const statusMeta = getSessionDisplayStatus(session, sessionStarted)
  // One status vocabulary everywhere (sidebar, overview cells, app bar switch).
  const statusLabel = statusMeta.label
  const currentCli = session.cli_type || 'claude'
  const currentModel = session.model || ''
  let sessionTags = session.tags || []
  if (typeof sessionTags === 'string') {
    try { sessionTags = JSON.parse(sessionTags || '[]') } catch { sessionTags = [] }
  }
  const hasDocumentationCapability = Array.isArray(sessionTags) && sessionTags.includes('capability_documentation')
  const hasTestingCapability = Array.isArray(sessionTags) && sessionTags.includes('capability_testing')
  const isBrainstormer = session.session_type === 'brainstormer'
  const isReadOnly = !!session.read_only
  const isBrainstormPublic = Array.isArray(sessionTags) && sessionTags.includes('brainstorm_public')
  const isJoinerSession = currentAuth?.actor_kind === 'joiner_session'
  const sharingModeEnabled = !!(sharingStatus?.tunnel?.running || sharingStatus?.multiplayer?.enabled || isJoinerSession)
  const showBrainstormPrivacyToggle = isBrainstormer && !isReadOnly && sharingModeEnabled
  const switchRole = session.session_type === 'commander'
    ? 'commander'
    : hasTestingCapability
      ? 'tester'
      : hasDocumentationCapability
        ? 'documentor'
        : 'worker'
  const cliTypes = getCliTypes()
  void cliProfiles
  const switchOptions = cliTypes.flatMap((ct) => {
    const models = getModelsForCli(ct.id)
    const seen = new Set()
    const modelIds = [getRoleDefaultModel(ct.id, switchRole), ...models.map((m) => m.id)]
      .filter((id) => id !== undefined && id !== null)
    return modelIds.flatMap((id) => {
      const key = `${ct.id}:${id || ''}`
      if (seen.has(key)) return []
      seen.add(key)
      const model = models.find((m) => m.id === id)
      const modelLabel = model?.label || (id ? id : 'Default')
      return [{
        cli: ct.id,
        model: id || '',
        label: `${ct.label} ${modelLabel}`,
      }]
    })
  }).filter((o) => !(o.cli === currentCli && (o.model || '') === currentModel))
  const isDocumentor = hasDocumentationCapability
  const toggleBrainstormerPrivacy = async () => {
    if (!isBrainstormer || isReadOnly || !session.workspace_id || privacyBusy) return
    setPrivacyBusy(true)
    try {
      const updated = await api.updateBrainstormerPrivacy(session.workspace_id, !isBrainstormPublic)
      useStore.getState().loadSessions([updated])
    } catch (e) {
      console.error(e)
      useStore.getState().addNotification?.({
        sessionId: activeSessionId,
        type: 'error',
        message: e?.message || 'Failed to update Brainstormer privacy.',
      })
    } finally {
      setPrivacyBusy(false)
    }
  }

  return (
    <div ref={barRef} data-compact={barCompact ? 'true' : undefined} className="x-context-bar relative z-40 flex items-center gap-3 px-4 py-2 bg-x-surface border-b border-x-line text-xs overflow-visible tab-scroll-hide touch-manipulation min-h-[42px]">
      <div className="x-breadcrumb flex items-center gap-2 min-w-0 shrink whitespace-nowrap overflow-hidden">
        {/* Up one level: Session → Overview → Home. Same order as the app bar switch. */}
        <button
          type="button"
          className="x-icon-tile"
          onClick={() => sessionFocus ? useStore.getState().goOverview() : useStore.getState().goHome()}
          title={sessionFocus ? 'Back to overview' : 'Back to home'}
          aria-label={sessionFocus ? 'Back to overview' : 'Back to home'}
        >
          ←
        </button>
        {sessionFocus ? <>
          <button type="button" className="x-breadcrumb-parent hover:text-x-ink" onClick={() => useStore.getState().goOverview()}>Overview</button>
          <span className="x-breadcrumb-separator">/</span>
        </> : <span className="ive-ctx-label x-breadcrumb-parent hidden sm:inline" title="Actions on the right apply to this session">Selected:</span>}
        <span className="x-breadcrumb-current truncate min-w-0 max-w-[180px]" title={session.name}>{session.name}</span>
      </div>
      {/* Session info */}
      <div className="flex items-center gap-2.5 min-w-0 shrink-0">
        {session.cli_type === 'gemini' && (
          <span className="text-[11px] font-medium bg-x-accent-ink/10 text-x-accent-ink px-2.5 py-1 rounded-md border border-x-accent-ink/30">Gemini deprecated</span>
        )}
        <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-md border ${
          `bg-x-surface border-x-line ${statusMeta.textClass}`
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dotClass}`} />
          {statusLabel}
        </span>
        {session.model && (
          <span className="ive-ctx-label text-x-ink-secondary font-mono text-xs truncate max-w-[220px]" title="Model">
            {session.model}
          </span>
        )}
        {session.plan_model && session.execute_model && (
          <span className={`hidden md:inline-flex whitespace-nowrap text-[11px] font-medium px-2 py-1 rounded-md border ${
            session.model === session.plan_model
              ? 'bg-x-tint text-x-accent border-x-accent/30'
              : session.model === session.execute_model
                ? 'bg-x-good/10 text-x-good border-x-good/30'
                : 'bg-x-hover text-x-ink-secondary border-x-line'
          }`}>
            {session.model === session.plan_model ? 'Plan model' :
             session.model === session.execute_model ? 'Execution model' : 'Custom model'}
          </span>
        )}
        {Number(session.token_count) > 0 && (
          <span
            className="ive-ctx-label inline-flex items-center gap-1 text-x-accent/85 font-mono text-[11px] tabular-nums bg-x-accent/5 px-2 py-0.5 rounded border border-x-accent/10"
            title={session.token_count_estimated ? 'Estimated session tokens' : 'Session tokens'}
          >
            <Hash size={10} />
            {session.token_count_estimated ? '~' : ''}{compactNumber(session.token_count)}
          </span>
        )}
      </div>

      {/* Quick session: "Looks like this is <project>. Attach?" lives in this
          row instead of adding another full-width banner. */}
      <ProjectHintChip sessionId={activeSessionId} />

      <div className="flex-1" />

      {/* Actions */}
      <div className="flex items-center gap-1.5">
        {showBrainstormPrivacyToggle && (
          <Button
            data-chrome-button
            type="button"
            onClick={toggleBrainstormerPrivacy}
            disabled={privacyBusy}
            className={`flex items-center gap-1.5 px-3 h-[30px] border transition-colors duration-[80ms] disabled:opacity-40 ${
              isBrainstormPublic
                ? 'text-x-good hover:bg-x-good/15 bg-x-good/10 border-x-good/30'
                : 'text-x-ink-secondary hover:text-x-ink bg-transparent hover:bg-x-hover border-x-line hover:border-x-line-strong'
            }`}
            title="Toggle Brainstormer privacy"
          >
            {isBrainstormPublic ? <Globe2 size={13} className="text-x-good" /> : <Lock size={13} className="text-x-muted" />}
            <span className="text-[11px] font-medium">{isBrainstormPublic ? 'public' : 'private'}</span>
          </Button>
        )}
        {isBrainstormer && isReadOnly && (
          <span className="flex items-center gap-1.5 px-3 h-[30px] rounded-md border border-x-line bg-x-hover text-x-ink-secondary">
            <Eye size={13} className="text-x-muted" />
            <span className="text-[11px] font-medium">read-only</span>
          </span>
        )}
        {/* Agent-only actions: a plain terminal has no prompt, CLI or model. */}
        {!isShell && <VoiceControl
          workspaceId={session.workspace_id}
          activeSessionId={activeSessionId}
          disabled={!session.workspace_id}
        />}

        {!isReadOnly && !isShell && <QuickActions />}

        {/* Switch CLI */}
        {!isReadOnly && !isShell && (
        <div>
          <Button type="button"
            ref={switcherBtnRef}
            disabled={switching}
            data-chrome-button
            onClick={() => setShowSwitcher((s) => !s)}
            className="flex items-center gap-1.5 px-3 h-[30px] text-x-ink-secondary hover:text-x-ink bg-transparent hover:bg-x-hover border border-x-line hover:border-x-line-strong transition-colors duration-[80ms]"
            title="Switch CLI"
            aria-label="Switch CLI"
          >
            <Shuffle size={13} className="text-x-ink-secondary" />
            <span className="ive-ctx-label hidden min-[1280px]:inline text-[11px] font-medium">{switching ? 'Switching…' : 'switch'}</span>
          </Button>
          {showSwitcher && switcherPos && (
            <div
              ref={switcherMenuRef}
              data-ive-popover
              className="fixed p-2 z-[120] w-52 space-y-1 rounded-[10px] bg-x-surface border border-x-line shadow-x-1 scale-in"
              style={{ top: switcherPos.top, right: switcherPos.right }}
            >
              <div className="text-[11px] text-x-muted font-medium uppercase tracking-[0.06em] mb-1.5 pl-1">Switch to:</div>
              {switchOptions.map((opt) => (
                  <Button type="button"
                    key={`${opt.cli}-${opt.model}`}
                    onClick={async () => {
                      if (switchingRef.current) return
                      setShowSwitcher(false)
                      const sameCli = opt.cli === currentCli
                      const prompt = sameCli
                        ? `Switch model to ${opt.model || 'default'}? The session will restart with its saved conversation.`
                        : `Switch to ${opt.label}? The current session will be stopped and restarted. A context summary will be handed off.`
                      if (!confirm(prompt)) return
                      switchingRef.current = true
                      setSwitching(true)
                      try {
                        const switched = await api.switchSessionCli(activeSessionId, { cli_type: opt.cli, model: opt.model })
                        useStore.setState((state) => ({ sessions: { ...state.sessions, [activeSessionId]: { ...state.sessions[activeSessionId], cli_type: switched.cli_type, model: switched.model, permission_mode: switched.permission_mode, effort: switched.effort } } }))
                      } catch (e) {
                        console.error(e)
                        useStore.getState().addNotification?.({
                          sessionId: activeSessionId,
                          type: 'error',
                          message: e?.message || 'Failed to switch model.',
                        })
                      } finally { switchingRef.current = false; setSwitching(false) }
                    }}
                    className="w-full text-left px-2.5 py-1.5 text-[12px] font-medium text-x-ink-secondary hover:bg-x-hover hover:text-x-ink transition-colors duration-[80ms]"
                  >
                    <span className="flex items-center gap-2"><ProviderLogo provider={opt.cli} className="w-3.5 h-3.5 shrink-0" />{opt.label}</span>
                  </Button>
                ))}
            </div>
          )}
        </div>
        )}

        <SessionContextActions sessionId={activeSessionId} readOnly={isReadOnly} />

        <Button type="button"
          data-chrome-button
          onClick={() => window.dispatchEvent(new CustomEvent('open-panel', { detail: 'files' }))}
          className="flex items-center gap-1.5 px-3 h-[30px] text-x-ink-secondary hover:text-x-ink bg-transparent hover:bg-x-hover border border-x-line hover:border-x-line-strong transition-colors duration-[80ms]"
          title="Open files & plans"
          aria-label="Open files & plans"
        >
          <Files size={13} className="text-x-ink-secondary" />
          <span className="ive-ctx-label hidden min-[1280px]:inline text-[11px] font-medium">files</span>
        </Button>

        <Button type="button"
          data-chrome-button
          onClick={() => window.dispatchEvent(new CustomEvent('open-panel', { detail: isDocumentor ? 'docs-panel' : 'code-review' }))}
          className="flex items-center gap-1.5 px-3 h-[30px] text-x-ink-secondary hover:text-x-ink bg-transparent hover:bg-x-hover border border-x-line hover:border-x-line-strong transition-colors duration-[80ms]"
          title={isDocumentor ? 'Open documentation review' : 'Open code review'}
          aria-label={isDocumentor ? 'Open documentation review' : 'Open code review'}
        >
          {isDocumentor ? <BookOpenCheck size={13} className="text-x-ink-secondary" /> : <GitCompareArrows size={13} className="text-x-ink-secondary" />}
          <span className="ive-ctx-label hidden min-[1280px]:inline text-[11px] font-medium">{isDocumentor ? 'docs' : 'review'}</span>
        </Button>

        {/* Overflow: the occasional panels live behind one control so the bar
            reads as a short row instead of a wall of same-weight pills. Both
            actions keep their original handlers and gain readable labels. */}
        <div>
          <IconButton
            icon={MoreHorizontal}
            label="More session panels"
            iconSize={16}
            ref={moreBtnRef}
            data-chrome-button
            onClick={() => setShowMore((s) => !s)}
            className="h-[30px] w-[30px]"
            title="More session panels — capabilities, scratchpad, annotations, catch up"
            aria-expanded={showMore}
            aria-haspopup="menu"
          >
            {annotationCount > 0 && (
              <span className="absolute -right-1.5 -top-1.5 min-w-[16px] h-4 flex items-center justify-center rounded-full border border-x-accent/25 bg-x-accent px-1 font-mono text-[11px] leading-3 text-x-on-accent">
                {annotationCount > 9 ? '9+' : annotationCount}
              </span>
            )}
          </IconButton>
          {showMore && morePos && (
            <div
              ref={moreMenuRef}
              data-ive-popover
              role="menu"
              className="fixed p-2 z-[120] w-56 space-y-1 rounded-[10px] bg-x-surface border border-x-line shadow-x-1 scale-in"
              style={{ top: morePos.top, right: morePos.right }}
            >
              <Button type="button"
                role="menuitem"
                data-capabilities-menuitem
                onClick={() => {
                  setShowMore(false)
                  window.dispatchEvent(new CustomEvent('open-panel', { detail: 'capabilities' }))
                }}
                className="w-full flex items-center gap-2 text-left px-2.5 py-1.5 text-[12px] font-medium text-x-ink-secondary hover:bg-x-hover hover:text-x-ink transition-colors duration-[80ms]"
              >
                <Boxes size={13} className="text-x-muted shrink-0" />
                <span className="flex-1">Capabilities</span>
                <span className="font-mono text-[11px] text-x-muted">read-only</span>
              </Button>
              <Button type="button"
                role="menuitem"
                onClick={() => {
                  setShowMore(false)
                  window.dispatchEvent(new CustomEvent('open-panel', { detail: 'scratchpad' }))
                }}
                className="w-full flex items-center gap-2 text-left px-2.5 py-1.5 text-[12px] font-medium text-x-ink-secondary hover:bg-x-hover hover:text-x-ink transition-colors duration-[80ms]"
              >
                <StickyNote size={13} className="text-x-muted shrink-0" />
                <span className="flex-1">Scratchpad</span>
                <kbd className="font-mono text-[11px] text-x-muted">⌘J</kbd>
              </Button>
              <Button type="button"
                role="menuitem"
                data-annotations-toggle
                onClick={() => {
                  setShowMore(false)
                  window.dispatchEvent(new CustomEvent('cc-open-annotations', {
                    detail: { sessionId: activeSessionId, workspaceId: session.workspace_id, toggle: true },
                  }))
                }}
                className="w-full flex items-center gap-2 text-left px-2.5 py-1.5 text-[12px] font-medium text-x-ink-secondary hover:bg-x-hover hover:text-x-ink transition-colors duration-[80ms]"
              >
                <MessageSquareQuote size={13} className="text-x-muted shrink-0" />
                <span className="flex-1">Annotations</span>
                {annotationCount > 0 && (
                  <span className="font-mono text-[11px] text-x-accent">
                    {annotationCount > 9 ? '9+' : annotationCount}
                  </span>
                )}
              </Button>
              <Button type="button"
                role="menuitem"
                data-catch-up-menuitem
                onClick={() => {
                  setShowMore(false)
                  window.dispatchEvent(new CustomEvent('open-panel', { detail: 'briefing' }))
                }}
                className="w-full flex items-center gap-2 text-left px-2.5 py-1.5 text-[12px] font-medium text-x-ink-secondary hover:bg-x-hover hover:text-x-ink transition-colors duration-[80ms]"
              >
                <Newspaper size={13} className="text-x-muted shrink-0" />
                <span className="flex-1">Catch Up</span>
              </Button>
            </div>
          )}
        </div>

        {!isReadOnly && isExited && (
          <Button type="button"
            data-chrome-button
            onClick={() => useStore.getState().restartSession(activeSessionId)}
            className="flex items-center gap-1.5 px-3 h-[30px] text-x-good hover:bg-x-good/10 bg-transparent border border-x-good/25 hover:border-x-good/40 transition-colors duration-[80ms]"
            title="Restart session"
          >
            <RotateCcw size={13} className="text-x-good" />
            <span className="text-[11px] font-medium">restart</span>
          </Button>
        )}

        {!isReadOnly && isRunning && (
          <Button type="button"
            data-chrome-button
            onClick={() => useStore.getState().stopSession(activeSessionId)}
            className="flex items-center gap-1.5 px-3 h-[30px] text-x-danger hover:bg-x-danger/10 bg-transparent border border-x-danger/25 hover:border-x-danger/40 transition-colors duration-[80ms]"
            title="Stop session (⌘.)"
          >
            <Square size={13} className="text-x-danger" />
            <span className="text-[11px] font-medium">stop</span>
          </Button>
        )}
      </div>
    </div>
  )
}
