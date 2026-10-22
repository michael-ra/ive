import { useState, useEffect, useRef } from 'react'
import { Layout, Trash2, X, MessageSquare } from 'lucide-react'
import { api } from '../../lib/api'
import useListKeyboardNav from '../../hooks/useListKeyboardNav'
import { Button } from '../ui'
import { getEffortDisplay } from '../../lib/constants'

export default function TemplateManager({ onClose }) {
  const [templates, setTemplates] = useState([])
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const listRef = useRef(null)

  const selected = selectedIdx >= 0 ? templates[selectedIdx] : null

  useListKeyboardNav({
    itemCount: templates.length,
    selectedIdx,
    setSelectedIdx,
    onActivate: (idx) => setSelectedIdx(idx),
    onDelete: (idx) => {
      const t = templates[idx]
      if (t) handleDelete(t.id)
    },
  })

  useEffect(() => {
    if (selectedIdx < 0) return
    const el = listRef.current?.querySelector(`[data-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  const panelRef = useRef(null)

  useEffect(() => {
    api.getTemplates().then(setTemplates)
    // Pull focus into the panel so arrow keys aren't swallowed by the terminal
    panelRef.current?.focus()
  }, [])

  const handleDelete = async (id) => {
    await api.deleteTemplate(id)
    setTemplates(templates.filter((t) => t.id !== id))
    if (selected?.id === id) setSelectedIdx(-1)
  }

  const parseTurns = (t) => {
    try { return JSON.parse(t.conversation_turns || '[]') } catch { return [] }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-x-scrim backdrop-blur-[4px]" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-[600px] max-h-[70vh] x-panel shadow-x-3 overflow-hidden flex flex-col scale-in outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-x-line">
          <Layout size={14} strokeWidth={1.75} className="text-x-accent" />
          <span className="text-xs text-x-ink-secondary font-medium">Templates</span>
          <span className="text-[11px] text-x-muted">{templates.length} saved</span>
          <div className="flex-1" />
          <Button type="submit" onClick={onClose} className="p-1 hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms] ease-x"><X size={15} /></Button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* List */}
          <div ref={listRef} className="w-[220px] border-r border-x-line overflow-y-auto">
            {templates.map((t, idx) => {
              const turns = parseTurns(t)
              return (
                <button
                  key={t.id}
                  data-idx={idx}
                  onClick={() => setSelectedIdx(idx)}
                  className={`w-full text-left px-2.5 py-1.5 border-b border-x-line-subtle transition-colors duration-[80ms] ease-x ${
                    selectedIdx === idx ? 'bg-x-tint text-x-ink border-l-2 border-l-x-accent' : 'text-x-ink-secondary hover:bg-x-hover'
                  }`}
                >
                  <div className="text-xs font-medium truncate">{t.name}</div>
                  <div className="flex items-center gap-1 mt-0.5 text-[11px] text-x-muted">
                    <span>{t.model || 'sonnet'}</span>
                    <span>{t.permission_mode || 'auto'}</span>
                    {turns.length > 0 && (
                      <span className="flex items-center gap-0.5 text-x-accent-ink">
                        <MessageSquare size={10} />{turns.length}
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
            {templates.length === 0 && (
              <div className="p-4 text-[11px] text-x-muted text-center">
                no templates yet — save one via ⌘K → Save as Template
              </div>
            )}
          </div>

          {/* Detail */}
          <div className="flex-1 overflow-y-auto p-4">
            {selected ? (
              <div className="space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-x-ink text-xs font-medium">{selected.name}</span>
                  <Button type="submit"
                    onClick={() => handleDelete(selected.id)}
                    className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] text-x-accent-ink hover:bg-x-accent-ink/10 transition-colors duration-[80ms] ease-x"
                  >
                    <Trash2 size={11} /> delete
                  </Button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[11px] text-x-muted">Model</label>
                    <p className="text-x-ink-secondary">{selected.model || 'sonnet'}</p>
                  </div>
                  <div>
                    <label className="text-[11px] text-x-muted">Mode</label>
                    <p className="text-x-ink-secondary">{selected.permission_mode || 'auto'}</p>
                  </div>
                  <div>
                    <label className="text-[11px] text-x-muted">Effort</label>
                    <p className="text-x-ink-secondary">{getEffortDisplay(selected.cli_type, selected.effort, selected.model)}</p>
                  </div>
                  <div>
                    <label className="text-[11px] text-x-muted">Budget</label>
                    <p className="text-x-ink-secondary" title={selected.budget_usd ? 'Claude enforces this only in headless runs; interactive sessions are not capped.' : undefined}>{selected.budget_usd ? `$${selected.budget_usd} · headless runs only` : 'none'}</p>
                  </div>
                </div>

                {selected.system_prompt && (
                  <div>
                    <label className="text-[11px] text-x-muted">System Prompt</label>
                    <pre className="text-x-ink-secondary font-mono bg-x-surface-2 border border-x-line rounded-md p-2 text-[11px] whitespace-pre-wrap max-h-24 overflow-y-auto mt-0.5">
                      {selected.system_prompt}
                    </pre>
                  </div>
                )}

                {selected.guideline_ids && selected.guideline_ids !== '[]' && (
                  <div>
                    <label className="text-[11px] text-x-muted">Guidelines</label>
                    <p className="text-x-ink-secondary text-[11px]">
                      {JSON.parse(selected.guideline_ids || '[]').length} attached
                    </p>
                  </div>
                )}

                {selected.mcp_server_ids && selected.mcp_server_ids !== '[]' && (
                  <div>
                    <label className="text-[11px] text-x-muted">MCP Servers</label>
                    <p className="text-x-ink-secondary text-[11px]">
                      {JSON.parse(selected.mcp_server_ids || '[]').length} attached
                    </p>
                  </div>
                )}

                {(() => {
                  const turns = parseTurns(selected)
                  if (turns.length === 0) return null
                  return (
                    <div>
                      <label className="text-[11px] text-x-muted">Conversation ({turns.length} turns)</label>
                      <div className="mt-1 space-y-1 max-h-40 overflow-y-auto">
                        {turns.map((turn, i) => (
                          <div key={i} className="flex gap-1 text-[11px]">
                            <span className="text-x-accent shrink-0">{i + 1}.</span>
                            <span className="text-x-muted truncate">{turn}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })()}

                <div className="text-[11px] text-x-faint">
                  Created {selected.created_at?.replace('T', ' ').slice(0, 16)}
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-x-muted text-xs">
                select a template to view details
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
