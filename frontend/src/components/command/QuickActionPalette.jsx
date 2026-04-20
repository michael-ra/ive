import { useState, useEffect, useRef } from 'react'
import {
  Zap, GitBranch, Shield, FileCode, Bug, TestTube,
  BookOpen, Lightbulb, Code, Wand2, Search,
  RefreshCw, Rocket, Pencil, Terminal, Package,
  Globe, Lock, Star,
} from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { sendTerminalCommand } from '../../lib/terminal'

const ICONS = {
  'file-code': FileCode, 'git-branch': GitBranch, 'shield': Shield,
  'test-tube': TestTube, 'bug': Bug, 'book-open': BookOpen,
  'lightbulb': Lightbulb, 'zap': Zap, 'code': Code, 'wand-2': Wand2,
  'search': Search, 'refresh-cw': RefreshCw, 'rocket': Rocket,
  'pencil': Pencil, 'terminal': Terminal, 'package': Package,
  'globe': Globe, 'lock': Lock, 'star': Star,
}

function getIcon(name) {
  return ICONS[name] || Zap
}

export default function QuickActionPalette({ onClose }) {
  const prompts = useStore((s) => s.prompts)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { setSelectedIdx(0) }, [query])

  const actions = prompts
    .filter((p) => p.is_quickaction)
    .sort((a, b) => (a.quickaction_order || 0) - (b.quickaction_order || 0))

  const filtered = query
    ? actions.filter((a) =>
        a.name.toLowerCase().includes(query.toLowerCase()) ||
        a.content.toLowerCase().includes(query.toLowerCase())
      )
    : actions

  const handleUse = (action) => {
    api.usePrompt(action.id)
    sendTerminalCommand(activeSessionId, action.content)
    onClose()
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && filtered[selectedIdx]) {
      handleUse(filtered[selectedIdx])
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] bg-black/50" onClick={onClose}>
      <div
        className="w-[480px] ide-panel overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary">
          <Zap size={14} className="text-amber-400" />
          <span className="text-xs text-text-secondary font-medium">Quick Actions</span>
          <span className="text-[10px] text-text-faint font-mono ml-auto">⌘Y</span>
        </div>

        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="search actions..."
          className="w-full px-4 py-2.5 text-xs bg-transparent border-b border-border-secondary text-text-primary placeholder-text-faint focus:outline-none font-mono"
        />

        <div className="max-h-[40vh] overflow-y-auto py-1">
          {filtered.map((action, i) => {
            const Icon = getIcon(action.icon)
            const color = action.color || 'text-text-secondary'
            return (
              <button
                key={action.id}
                onClick={() => handleUse(action)}
                className={`group w-full text-left px-4 py-2 transition-colors flex items-center gap-2.5 ${
                  i === selectedIdx ? 'bg-accent-subtle text-text-primary' : 'hover:bg-bg-hover'
                }`}
              >
                <Icon size={13} className={color} />
                <div className="flex-1 min-w-0">
                  <span className="text-xs text-text-primary font-mono">{action.name}</span>
                  <div className="text-[10px] text-text-muted font-mono mt-0.5 truncate">
                    {action.content?.substring(0, 80)}
                  </div>
                </div>
              </button>
            )
          })}
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-xs text-text-faint text-center">
              {actions.length === 0 ? 'No quick actions configured' : 'No matching actions'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
