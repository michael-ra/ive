import { useState, useRef } from 'react'
import {
  GitBranch, Shield, FileCode, Bug, TestTube,
  BookOpen, Lightbulb, GripVertical, Settings2, Check,
  Zap, Code, Wand2, Search, RefreshCw, Rocket,
  Pencil, Terminal, Package, Globe, Lock, Star,
  X, Sparkles,
} from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { sendTerminalCommand } from '../../lib/terminal'

// Map icon name strings to Lucide components
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
  const [editMode, setEditMode] = useState(false)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const notifications = useStore((s) => s.notifications)

  // Suggestion chips that ride at the end of the bar (replaces the toast popouts)
  const skillSuggestions = notifications.filter((n) => n.type === 'skill_suggestion')
  const guidelineSuggestions = notifications.filter((n) => n.type === 'guideline_recommendation')

  // Derive quick actions from the global prompts cache
  const actions = prompts
    .filter((p) => p.is_quickaction)
    .sort((a, b) => (a.quickaction_order || 0) - (b.quickaction_order || 0))

  // Drag state
  const dragIdx = useRef(null)
  const dragOverIdx = useRef(null)
  const [dragging, setDragging] = useState(null)

  const handleAction = (prompt) => {
    if (editMode) return
    api.usePrompt(prompt.id)
    sendTerminalCommand(activeSessionId, prompt.content)
  }

  const handleCustom = () => {
    if (editMode) return
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

  const onDragStart = (e, idx) => {
    dragIdx.current = idx
    setDragging(idx)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setDragImage(e.target, 0, 0)
  }

  const onDragOver = (e, idx) => {
    e.preventDefault()
    dragOverIdx.current = idx
  }

  const onDragEnd = () => {
    if (dragIdx.current !== null && dragOverIdx.current !== null && dragIdx.current !== dragOverIdx.current) {
      const reordered = [...actions]
      const [moved] = reordered.splice(dragIdx.current, 1)
      reordered.splice(dragOverIdx.current, 0, moved)
      const ids = reordered.map((a) => a.id)
      api.reorderQuickActions(ids)
      // Optimistic update in store
      const updated = reordered.map((a, i) => ({ ...a, quickaction_order: i }))
      const allPrompts = prompts.map((p) => {
        const qa = updated.find((u) => u.id === p.id)
        return qa || p
      })
      useStore.getState().setPrompts(allPrompts)
    }
    dragIdx.current = null
    dragOverIdx.current = null
    setDragging(null)
  }

  const hasSuggestions = skillSuggestions.length > 0 || guidelineSuggestions.length > 0
  if (actions.length === 0 && !editMode && !hasSuggestions) return null

  return (
    <div className="flex items-center bg-bg-inset border-b border-border-secondary">
      <div className="flex items-center gap-1 px-2 py-1.5 overflow-x-auto flex-1 min-w-0">
        {actions.map((a, idx) => {
          const Icon = getIcon(a.icon)
          const color = a.color || 'text-text-secondary'
          return (
            <button
              key={a.id}
              data-chrome-button
              draggable={editMode}
              onDragStart={editMode ? (e) => onDragStart(e, idx) : undefined}
              onDragOver={editMode ? (e) => onDragOver(e, idx) : undefined}
              onDragEnd={editMode ? onDragEnd : undefined}
              onClick={() => handleAction(a)}
              className={`flex items-center gap-1.5 px-2 py-1 text-[11px] font-mono rounded-md border border-border-primary hover:border-border-accent bg-bg-secondary/50 hover:bg-bg-hover transition-colors shrink-0 ${
                editMode ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
              } ${color} ${dragging === idx ? 'opacity-40' : ''}`}
              title={editMode ? 'Drag to reorder' : a.content?.substring(0, 80)}
            >
              {editMode && <GripVertical size={10} className="text-text-faint -ml-0.5" />}
              <Icon size={11} />
              <span>{a.name}</span>
            </button>
          )
        })}

        {!editMode && (
          <button
            data-chrome-button
            onClick={handleCustom}
            className="px-1.5 py-1 text-[11px] font-mono text-text-faint hover:text-text-secondary border border-border-primary hover:border-border-accent rounded-md transition-colors cursor-pointer shrink-0"
            title="Custom command"
          >
            /...
          </button>
        )}

        {!editMode && skillSuggestions.length > 0 && (
          <>
            <span className="mx-1 select-none font-mono text-[14px] leading-none text-amber-400/60 shrink-0" aria-hidden>|</span>
            {skillSuggestions.map((notif) => {
              const count = notif.skills?.length || 0
              const preview = (notif.skills || []).slice(0, 3).map((s) => s.name).join(', ')
              return (
                <span key={notif.id} className="flex items-center shrink-0">
                  <button
                    data-chrome-button
                    onClick={() => openSkillsForNotif(notif)}
                    title={preview ? `Suggested skills: ${preview}` : 'Browse suggested skills'}
                    className="flex items-center gap-1.5 pl-2 pr-1.5 py-1 text-[11px] font-mono rounded-md border border-amber-500/30 hover:border-amber-500/60 bg-amber-500/5 hover:bg-amber-500/10 text-amber-300 transition-colors cursor-pointer"
                  >
                    <Zap size={11} />
                    <span>{count} skill{count !== 1 ? 's' : ''}</span>
                  </button>
                  <button
                    onClick={() => dismissNotif(notif.id)}
                    title="Dismiss"
                    className="ml-0.5 p-0.5 rounded text-amber-400/50 hover:text-amber-300 hover:bg-amber-500/10 transition-colors cursor-pointer"
                  >
                    <X size={10} />
                  </button>
                </span>
              )
            })}
          </>
        )}

        {!editMode && guidelineSuggestions.length > 0 && (
          <>
            <span className="mx-1 select-none font-mono text-[14px] leading-none text-indigo-400/60 shrink-0" aria-hidden>|</span>
            {guidelineSuggestions.map((notif) => {
              const count = notif.recommendations?.length || 0
              const preview = (notif.recommendations || []).slice(0, 3).map((g) => g.name).join(', ')
              return (
                <span key={notif.id} className="flex items-center shrink-0">
                  <button
                    data-chrome-button
                    onClick={() => openGuidelinesForNotif(notif)}
                    title={preview ? `Recommended guidelines: ${preview}` : 'Open recommended guidelines'}
                    className="flex items-center gap-1.5 pl-2 pr-1.5 py-1 text-[11px] font-mono rounded-md border border-indigo-500/30 hover:border-indigo-500/60 bg-indigo-500/5 hover:bg-indigo-500/10 text-indigo-300 transition-colors cursor-pointer"
                  >
                    <Sparkles size={11} />
                    <span>{count} guideline{count !== 1 ? 's' : ''}</span>
                  </button>
                  <button
                    onClick={() => dismissNotif(notif.id)}
                    title="Dismiss"
                    className="ml-0.5 p-0.5 rounded text-indigo-400/50 hover:text-indigo-300 hover:bg-indigo-500/10 transition-colors cursor-pointer"
                  >
                    <X size={10} />
                  </button>
                </span>
              )
            })}
          </>
        )}
      </div>

      {/* Edit / Done toggle */}
      <button
        data-chrome-button
        onClick={() => setEditMode(!editMode)}
        className={`shrink-0 px-2 py-1.5 mr-1 rounded-md transition-colors ${
          editMode
            ? 'text-green-400 hover:bg-green-500/10'
            : 'text-text-faint hover:text-text-secondary hover:bg-bg-hover'
        }`}
        title={editMode ? 'Done reordering' : 'Reorder actions'}
      >
        {editMode ? <Check size={12} /> : <Settings2 size={12} />}
      </button>
    </div>
  )
}
