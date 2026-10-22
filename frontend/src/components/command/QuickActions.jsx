import { useState, useRef, useEffect } from 'react'
import useEscapeToClose from '../../hooks/useEscapeToClose'
import {
  GitBranch, Shield, FileCode, Bug, TestTube,
  BookOpen, Lightbulb, Zap, Code, Wand2, Search, RefreshCw, Rocket,
  Pencil, Terminal, Package, Globe, Lock, Star,
  X, Sparkles, ChevronDown, Settings2, Check
} from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { sendTerminalCommand } from '../../lib/terminal'
import { Button } from '../ui'

const ICON_MAP = {
  'file-code': FileCode,
  'git-branch': GitBranch,
  'shield': Shield,
  'test-tube': TestTube,
  'bug': Bug,
  'book-open': BookOpen,
  'lightbulb': Lightbulb,
  'zap': Zap,
  'code': Code,
  'wand-2': Wand2,
  'search': Search,
  'refresh-cw': RefreshCw,
  'rocket': Rocket,
  'pencil': Pencil,
  'terminal': Terminal,
  'package': Package,
  'globe': Globe,
  'lock': Lock,
  'star': Star,
}

function getIcon(name) {
  return ICON_MAP[name] || Zap
}

export default function QuickActions() {
  const prompts = useStore((s) => s.prompts)
  const cascades = useStore((s) => s.cascades)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const notifications = useStore((s) => s.notifications)
  const [isOpen, setIsOpen] = useState(false)
  const [applyingSafetyId, setApplyingSafetyId] = useState(null)
  const [safetyApplyErrors, setSafetyApplyErrors] = useState({})
  const dropdownRef = useRef(null)
  useEscapeToClose(isOpen, () => setIsOpen(false))

  useEffect(() => {
    if (!isOpen) return
    const onClick = (e) => {
      if (!dropdownRef.current?.contains(e.target)) setIsOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [isOpen])

  const skillSuggestions = notifications.filter((n) => n.type === 'skill_suggestion')
  const guidelineSuggestions = notifications.filter((n) => n.type === 'guideline_recommendation')
  const boardSuggestions = notifications.filter((n) => n.type === 'board_suggestion')
  const safetyRuleSuggestions = notifications.filter((n) => n.type === 'safety_rule_proposed')

  const actions = [
    ...prompts.filter((p) => p.is_quickaction).map(p => ({ ...p, _type: 'prompt' })),
    ...cascades.filter((c) => c.is_quickaction).map(c => ({ ...c, _type: 'cascade' }))
  ].sort((a, b) => (a.quickaction_order || 0) - (b.quickaction_order || 0))

  const handleAction = (action) => {
    setIsOpen(false)
    if (action._type === 'cascade') {
      useStore.getState().startCascade(activeSessionId, action)
    } else {
      api.usePrompt(action.id)
      sendTerminalCommand(activeSessionId, action.content)
    }
  }

  const handleCustom = () => {
    setIsOpen(false)
    const cmd = prompt('Slash command or prompt:', '')
    if (cmd?.trim()) sendTerminalCommand(activeSessionId, cmd.trim())
  }

  const dismissNotif = (id) => useStore.getState().removeNotification(id)

  const openSkillsForNotif = (notif) => {
    window.dispatchEvent(new CustomEvent('open-marketplace', {
      detail: { tab: 'skills', suggestedSkills: notif.skills },
    }))
    dismissNotif(notif.id)
  }

  const openGuidelinesForNotif = (notif) => {
    window.dispatchEvent(new CustomEvent('open-guidelines'))
    dismissNotif(notif.id)
  }

  const openBoardSuggestions = () => {
    window.dispatchEvent(new CustomEvent('open-panel', {
      detail: { panel: 'feature-board', boardAction: 'attention' },
    }))
    boardSuggestions.forEach((notification) => dismissNotif(notification.id))
  }

  const applySafetyRule = async (notif) => {
    if (!notif.suggestion?.rule || applyingSafetyId) return
    setApplyingSafetyId(notif.id)
    setSafetyApplyErrors(current => ({ ...current, [notif.id]: null }))
    try {
      await api.createSafetyRule(notif.suggestion.rule)
      dismissNotif(notif.id)
      window.dispatchEvent(new CustomEvent('cc-safety-rules-changed', {
        detail: { suggestionId: notif.suggestionId, rule: notif.suggestion.rule },
      }))
    } catch (error) {
      console.error('Failed to apply suggested safety rule:', error)
      setSafetyApplyErrors(current => ({
        ...current,
        [notif.id]: error.message || 'Could not create rule',
      }))
    } finally {
      setApplyingSafetyId(null)
    }
  }

  const hasSuggestions = skillSuggestions.length > 0 || guidelineSuggestions.length > 0
    || boardSuggestions.length > 0 || safetyRuleSuggestions.length > 0
  if (actions.length === 0 && !hasSuggestions) return null

  return (
    <div className="flex items-center gap-1.5" ref={dropdownRef}>
      {/* Dropdown Button */}
      {actions.length > 0 && (
        <div className="relative">
          <Button type="submit"
            data-chrome-button
            onClick={() => setIsOpen(!isOpen)}
            className="flex items-center gap-1.5 h-[30px] px-2.5 text-x-ink-secondary hover:text-x-ink hover:bg-x-hover border border-x-line hover:border-x-line-strong transition-colors duration-[80ms] ease-x"
            title="Quick Actions"
            aria-label="Quick Actions menu"
            aria-expanded={isOpen}
          >
            <Zap size={13} strokeWidth={1.75} className="text-x-accent-ink" />
            <span className="ive-ctx-label text-[11px] font-medium">actions</span>
            <ChevronDown size={12} className={`text-x-muted transition-transform duration-[120ms] ease-x ${isOpen ? 'rotate-180' : ''}`} />
          </Button>

          {isOpen && (
            <div data-ive-popover className="absolute right-0 top-full mt-2 w-64 p-2 z-[120] rounded-[10px] bg-x-surface border border-x-line shadow-x-1 scale-in max-h-[50vh] overflow-y-auto">
              <div className="text-[11px] text-x-muted font-medium uppercase tracking-[0.06em] mb-1.5 pl-2">Quick Actions</div>
              {actions.map((a) => {
                const Icon = getIcon(a.icon)
                const color = a.color || 'text-x-ink-secondary'
                return (
                  <Button type="submit"
                    key={a.id}
                    onClick={() => handleAction(a)}
                    className="w-full text-left px-2 py-2 flex items-start gap-2.5 hover:bg-x-hover transition-colors duration-[80ms] ease-x group"
                  >
                    <div className="mt-0.5"><Icon size={14} strokeWidth={1.75} className={color} /></div>
                    <div className="flex-1 min-w-0">
                      <div className={`text-xs font-medium ${color}`}>
                        {a.name}
                        {a._type === 'cascade' && (
                          <span className="ml-2 text-[11px] px-1 py-0.5 rounded bg-x-accent/10 text-x-accent border border-x-accent/30">cascade</span>
                        )}
                      </div>
                      {a._type === 'prompt' && a.content && <div className="text-[11px] text-x-muted truncate mt-0.5" title={a.content}>{a.content}</div>}
                      {a._type === 'cascade' && <div className="text-[11px] text-x-muted truncate mt-0.5">{a.steps?.length || 0} steps</div>}
                    </div>
                  </Button>
                )
              })}
              
              <div className="my-1 border-t border-x-line" />

              <Button type="submit"
                onClick={handleCustom}
                className="w-full text-left px-2 py-2 flex items-center gap-2.5 hover:bg-x-hover transition-colors duration-[80ms] ease-x group"
              >
                <Terminal size={14} strokeWidth={1.75} className="text-x-muted group-hover:text-x-ink-secondary" />
                <span className="text-xs text-x-ink-secondary group-hover:text-x-ink">Custom command...</span>
              </Button>
              <Button type="submit"
                onClick={() => { setIsOpen(false); window.dispatchEvent(new CustomEvent('open-panel', { detail: 'prompts' })) }}
                className="w-full text-left px-2 py-2 flex items-center gap-2.5 hover:bg-x-hover transition-colors duration-[80ms] ease-x group"
              >
                <Settings2 size={14} strokeWidth={1.75} className="text-x-muted group-hover:text-x-ink-secondary" />
                <span className="text-xs text-x-ink-secondary group-hover:text-x-ink">Manage actions</span>
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Suggestions */}
      {safetyRuleSuggestions.map((notif) => {
        const suggestion = notif.suggestion || {}
        const isApplying = applyingSafetyId === notif.id
        const error = safetyApplyErrors[notif.id]
        return (
          <span
            key={notif.id}
            className="flex items-stretch shrink-0"
            title={error || suggestion.graduation_message || suggestion.rationale || 'Make this precedent class permanent'}
          >
            <button
              onClick={() => applySafetyRule(notif)}
              disabled={!!applyingSafetyId}
              className={`flex items-center gap-1.5 pl-3 pr-2 py-1.5 text-[11px] font-medium rounded-l-md border border-r-0 transition-colors duration-[80ms] ease-x disabled:cursor-wait disabled:opacity-60 ${error
                ? 'border-x-accent-ink/35 bg-x-accent-ink/10 text-x-accent-ink'
                : 'border-x-good/35 hover:border-x-good/50 bg-x-good/10 hover:bg-x-good/15 text-x-good'}`}
              aria-label={`Apply safety rule: ${suggestion.rule?.name || 'suggested allow'}`}
            >
              <Shield size={13} strokeWidth={1.75} />
              <span>{isApplying ? 'applying…' : `Make permanent: ${suggestion.rule?.name || 'allow rule'}`}</span>
              {!isApplying && suggestion.evidence_count > 0 && (
                <span className="text-[10px] opacity-70">{suggestion.evidence_count}×</span>
              )}
              {!isApplying && <Check size={11} strokeWidth={2} />}
            </button>
            <button
              onClick={() => dismissNotif(notif.id)}
              disabled={isApplying}
              aria-label="Dismiss safety rule suggestion"
              className={`flex items-center justify-center px-2 py-1.5 rounded-r-md border border-l-0 transition-colors duration-[80ms] ease-x disabled:cursor-wait disabled:opacity-60 ${error
                ? 'border-x-accent-ink/35 bg-x-accent-ink/10 text-x-accent-ink/60 hover:text-x-accent-ink'
                : 'border-x-good/35 bg-x-good/10 hover:bg-x-good/15 text-x-good/60 hover:text-x-good'}`}
            >
              <X size={12} />
            </button>
          </span>
        )
      })}

      {boardSuggestions.length > 0 && (
        <span className="flex items-stretch shrink-0">
          <button
            onClick={openBoardSuggestions}
            className="flex items-center gap-1.5 pl-3 pr-2 py-1.5 text-[11px] font-medium rounded-l-md border border-r-0 border-x-line-strong hover:border-x-tint-line bg-x-surface-2 hover:bg-x-hover text-x-ink-secondary transition-colors duration-[80ms] ease-x"
          >
            <Sparkles size={13} strokeWidth={1.75} />
            <span>{boardSuggestions.length} board suggestion{boardSuggestions.length !== 1 ? 's' : ''}</span>
          </button>
          <button
            onClick={() => boardSuggestions.forEach((notification) => dismissNotif(notification.id))}
            aria-label="Dismiss board suggestions"
            className="flex items-center justify-center px-2 py-1.5 rounded-r-md border border-x-line-strong bg-x-surface-2 hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms] ease-x border-l-0"
          >
            <X size={12} />
          </button>
        </span>
      )}

      {skillSuggestions.map((notif) => {
        const count = notif.skills?.length || 0
        return (
          <span key={notif.id} className="flex items-stretch shrink-0">
            <button
              onClick={() => openSkillsForNotif(notif)}
              className="flex items-center gap-1.5 pl-3 pr-2 py-1.5 text-[11px] font-medium rounded-l-md border border-r-0 border-x-accent-ink/30 hover:border-x-accent-ink/45 bg-x-accent-ink/10 hover:bg-x-accent-ink/15 text-x-accent-ink transition-colors duration-[80ms] ease-x"
            >
              <Zap size={13} strokeWidth={1.75} />
              <span>{count} skill{count !== 1 ? 's' : ''}</span>
            </button>
            <button
              onClick={() => dismissNotif(notif.id)}
              className="flex items-center justify-center px-2 py-1.5 rounded-r-md border border-x-accent-ink/30 bg-x-accent-ink/10 hover:bg-x-accent-ink/15 text-x-accent-ink/60 hover:text-x-accent-ink transition-colors duration-[80ms] ease-x border-l-0"
            >
              <X size={12} />
            </button>
          </span>
        )
      })}

      {guidelineSuggestions.map((notif) => {
        const count = notif.recommendations?.length || 0
        return (
          <span key={notif.id} className="flex items-stretch shrink-0">
            <button
              onClick={() => openGuidelinesForNotif(notif)}
              className="flex items-center gap-1.5 pl-3 pr-2 py-1.5 text-[11px] font-medium rounded-l-md border border-r-0 border-x-accent/30 hover:border-x-accent/45 bg-x-accent/10 hover:bg-x-accent/15 text-x-accent transition-colors duration-[80ms] ease-x"
            >
              <Sparkles size={13} strokeWidth={1.75} />
              <span>{count} guideline{count !== 1 ? 's' : ''}</span>
            </button>
            <button
              onClick={() => dismissNotif(notif.id)}
              className="flex items-center justify-center px-2 py-1.5 rounded-r-md border border-x-accent/30 bg-x-accent/10 hover:bg-x-accent/15 text-x-accent/60 hover:text-x-accent transition-colors duration-[80ms] ease-x border-l-0"
            >
              <X size={12} />
            </button>
          </span>
        )
      })}
    </div>
  )
}
