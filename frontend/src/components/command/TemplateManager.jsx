import { useState, useEffect, useRef } from 'react'
import { Layout, Trash2, X, Copy, MessageSquare } from 'lucide-react'
import { api } from '../../lib/api'
import useListKeyboardNav from '../../hooks/useListKeyboardNav'

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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-[600px] max-h-[70vh] bg-[#111118] border border-zinc-700 rounded-lg shadow-2xl overflow-hidden flex flex-col animate-in outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1 px-4 py-1.5 border-b border-zinc-800">
          <Layout size={14} className="text-indigo-400" />
          <span className="text-[11px] text-zinc-300 font-mono font-medium">Templates</span>
          <span className="text-[11px] text-zinc-600 font-mono">{templates.length} saved</span>
          <div className="flex-1" />
          <button onClick={onClose} className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"><X size={16} /></button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* List */}
          <div ref={listRef} className="w-[220px] border-r border-zinc-800 overflow-y-auto">
            {templates.map((t, idx) => {
              const turns = parseTurns(t)
              return (
                <button
                  key={t.id}
                  data-idx={idx}
                  onClick={() => setSelectedIdx(idx)}
                  className={`w-full text-left px-2.5 py-1.5 border-b border-zinc-800/30 transition-colors ${
                    selectedIdx === idx ? 'bg-indigo-600/10 text-zinc-200 ring-1 ring-inset ring-indigo-500/40' : 'text-zinc-400 hover:bg-zinc-800/40'
                  }`}
                >
                  <div className="text-[11px] font-mono truncate">{t.name}</div>
                  <div className="flex items-center gap-1 mt-0.5 text-[11px] text-zinc-600 font-mono">
                    <span>{t.model || 'sonnet'}</span>
                    <span>{t.permission_mode || 'auto'}</span>
                    {turns.length > 0 && (
                      <span className="flex items-center gap-0.5 text-amber-500">
                        <MessageSquare size={8} />{turns.length}
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
            {templates.length === 0 && (
              <div className="p-4 text-[11px] text-zinc-600 font-mono text-center">
                no templates yet — save one via ⌘K → Save as Template
              </div>
            )}
          </div>

          {/* Detail */}
          <div className="flex-1 overflow-y-auto p-4">
            {selected ? (
              <div className="space-y-3 text-[11px] font-mono">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-200 text-[11px] font-medium">{selected.name}</span>
                  <button
                    onClick={() => handleDelete(selected.id)}
                    className="flex items-center gap-1 px-1.5 py-1.5 text-[11px] text-red-400 hover:bg-red-400/10 rounded transition-colors"
                  >
                    <Trash2 size={10} /> delete
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-1">
                  <div>
                    <label className="text-[11px] text-zinc-600 uppercase">Model</label>
                    <p className="text-zinc-300">{selected.model || 'sonnet'}</p>
                  </div>
                  <div>
                    <label className="text-[11px] text-zinc-600 uppercase">Mode</label>
                    <p className="text-zinc-300">{selected.permission_mode || 'auto'}</p>
                  </div>
                  <div>
                    <label className="text-[11px] text-zinc-600 uppercase">Effort</label>
                    <p className="text-zinc-300">{selected.effort || 'high'}</p>
                  </div>
                  <div>
                    <label className="text-[11px] text-zinc-600 uppercase">Budget</label>
                    <p className="text-zinc-300">{selected.budget_usd ? `$${selected.budget_usd}` : 'none'}</p>
                  </div>
                </div>

                {selected.system_prompt && (
                  <div>
                    <label className="text-[11px] text-zinc-600 uppercase">System Prompt</label>
                    <pre className="text-zinc-400 bg-[#111118] rounded p-2 text-[11px] whitespace-pre-wrap max-h-24 overflow-y-auto mt-0.5">
                      {selected.system_prompt}
                    </pre>
                  </div>
                )}

                {selected.guideline_ids && selected.guideline_ids !== '[]' && (
                  <div>
                    <label className="text-[11px] text-zinc-600 uppercase">Guidelines</label>
                    <p className="text-zinc-400 text-[11px]">
                      {JSON.parse(selected.guideline_ids || '[]').length} attached
                    </p>
                  </div>
                )}

                {selected.mcp_server_ids && selected.mcp_server_ids !== '[]' && (
                  <div>
                    <label className="text-[11px] text-zinc-600 uppercase">MCP Servers</label>
                    <p className="text-zinc-400 text-[11px]">
                      {JSON.parse(selected.mcp_server_ids || '[]').length} attached
                    </p>
                  </div>
                )}

                {(() => {
                  const turns = parseTurns(selected)
                  if (turns.length === 0) return null
                  return (
                    <div>
                      <label className="text-[11px] text-zinc-600 uppercase">Conversation ({turns.length} turns)</label>
                      <div className="mt-1 space-y-1 max-h-40 overflow-y-auto">
                        {turns.map((turn, i) => (
                          <div key={i} className="flex gap-1 text-[11px]">
                            <span className="text-indigo-400 shrink-0">{i + 1}.</span>
                            <span className="text-zinc-400 truncate">{turn}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })()}

                <div className="text-[11px] text-zinc-700">
                  Created {selected.created_at?.replace('T', ' ').slice(0, 16)}
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-zinc-600 text-[11px] font-mono">
                select a template to view details
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
