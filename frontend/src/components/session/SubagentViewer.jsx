import { useState, useEffect, useRef } from 'react'
import { X, Sparkles, Loader2, ChevronDown, ChevronRight, Terminal, FileText, Search, FolderSearch, Globe, Pencil, PenLine } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'

/** Pick an icon + color for a tool name. */
function toolMeta(name) {
  const n = (name || '').toLowerCase()
  if (n === 'bash' || n === 'execute') return { icon: Terminal, color: 'text-green-400/80' }
  if (n === 'read' || n === 'read_file') return { icon: FileText, color: 'text-blue-400/80' }
  if (n === 'write' || n === 'write_file') return { icon: PenLine, color: 'text-orange-400/80' }
  if (n === 'edit' || n === 'edit_file') return { icon: Pencil, color: 'text-yellow-400/80' }
  if (n === 'grep' || n === 'search') return { icon: Search, color: 'text-purple-400/80' }
  if (n === 'glob' || n === 'find_files') return { icon: FolderSearch, color: 'text-cyan-400/80' }
  if (n.includes('web') || n.includes('fetch')) return { icon: Globe, color: 'text-teal-400/80' }
  if (n === 'agent') return { icon: Sparkles, color: 'text-purple-400/80' }
  return { icon: Terminal, color: 'text-zinc-500' }
}

/** Extract a one-line summary from tool input for display. */
function summarizeInput(name, input) {
  if (!input || typeof input !== 'object') return null
  const n = (name || '').toLowerCase()
  if (n === 'bash' || n === 'execute') return input.command
  if (n === 'read' || n === 'read_file') {
    const fp = input.file_path || ''
    const parts = [fp]
    if (input.offset || input.limit) {
      parts.push(`L${input.offset || 1}${input.limit ? `-${(input.offset || 1) + input.limit}` : ''}`)
    }
    return parts.join(' ')
  }
  if (n === 'write' || n === 'write_file') return input.file_path
  if (n === 'edit' || n === 'edit_file') return input.file_path
  if (n === 'glob' || n === 'find_files') {
    return input.pattern + (input.path ? ` in ${input.path}` : '')
  }
  if (n === 'grep' || n === 'search') {
    return `/${input.pattern}/` + (input.path ? ` in ${input.path}` : '')
  }
  if (n === 'agent') return input.description || input.prompt?.slice(0, 100)
  if (n === 'webfetch' || n === 'web_fetch') return input.url
  if (n === 'websearch' || n === 'web_search') return input.query
  // Generic fallback
  for (const key of ['file_path', 'path', 'command', 'pattern', 'query', 'prompt', 'description']) {
    if (input[key]) return String(input[key]).slice(0, 150)
  }
  return null
}

/** Shorten a file path for display — show last 2-3 segments. */
function shortenPath(fp) {
  if (!fp || fp.length < 50) return fp
  const parts = fp.split('/')
  return '.../' + parts.slice(-3).join('/')
}

function ToolRow({ t, index }) {
  const [expanded, setExpanded] = useState(false)
  const { icon: Icon, color } = toolMeta(t.tool)
  const summary = summarizeInput(t.tool, t.input)
  const isBash = (t.tool || '').toLowerCase() === 'bash' || (t.tool || '').toLowerCase() === 'execute'

  return (
    <div className="group/tool">
      <div
        className="flex items-start gap-1.5 py-1 px-2 rounded-sm hover:bg-zinc-800/50 cursor-pointer transition-colors"
        onClick={() => summary && setExpanded(!expanded)}
      >
        <span className="text-[9px] text-zinc-600 font-mono w-4 text-right shrink-0 mt-0.5">{index + 1}</span>
        <Icon size={11} className={`shrink-0 mt-0.5 ${color}`} />
        <div className="flex-1 min-w-0">
          <span className="text-[10px] font-mono text-zinc-400">{t.tool}</span>
          {summary && !expanded && (
            <span className="text-[10px] font-mono text-zinc-600 ml-1.5 truncate inline-block max-w-[250px] align-bottom">
              {isBash ? summary.split('\n')[0].slice(0, 60) : shortenPath(summary)}
            </span>
          )}
        </div>
      </div>
      {expanded && summary && (
        <div className="ml-8 mr-2 mb-1 px-2 py-1.5 bg-zinc-900/80 rounded text-[10px] font-mono text-zinc-400 whitespace-pre-wrap break-all max-h-32 overflow-y-auto border border-zinc-800/50">
          {summary}
        </div>
      )}
    </div>
  )
}

export default function SubagentViewer({ sessionId, agentId, onClose }) {
  const agent = useStore((s) => s.subagents[sessionId]?.[agentId])
  const [markdown, setMarkdown] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [toolsOpen, setToolsOpen] = useState(true)
  const bodyRef = useRef(null)

  // Fetch transcript from API (uses backend's in-memory transcript_path)
  useEffect(() => {
    if (!sessionId || !agentId) return
    // Only fetch if agent is completed (running agents don't have transcripts)
    if (agent?.status !== 'completed') return
    setLoading(true)
    setError(null)
    setMarkdown(null)
    api.getSubagentTranscript(sessionId, agentId)
      .then((res) => {
        if (res.error && !res.markdown) {
          setError(res.error)
          // If the API has a longer result, use it
          if (res.agent?.result) setMarkdown(null)
        } else if (res.markdown) {
          setMarkdown(res.markdown)
        }
      })
      .catch(() => setError('transcript_unavailable'))
      .finally(() => setLoading(false))
  }, [sessionId, agentId, agent?.status])

  if (!agent) return null

  const hasTools = agent.tools && agent.tools.length > 0
  const isRunning = agent.status === 'running'
  const hasTranscript = !!markdown

  return (
    <div
      className="flex flex-col h-full bg-[#0e0e16] border-l border-zinc-800"
      style={{ width: 440 }}
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-zinc-800">
        <Sparkles size={12} className="text-purple-400" />
        <span className="text-[11px] font-mono text-zinc-300 font-medium">{agent.type}</span>
        <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
          isRunning
            ? 'text-green-400 bg-green-500/10'
            : 'text-zinc-500 bg-zinc-800'
        }`}>
          {isRunning ? 'running' : 'done'}
        </span>
        {hasTools && (
          <span className="text-[9px] font-mono text-zinc-500">
            {agent.tools.length} tool{agent.tools.length !== 1 ? 's' : ''}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* Body */}
      <div ref={bodyRef} className="flex-1 overflow-y-auto min-h-0">
        {/* Loading state */}
        {loading && (
          <div className="flex items-center justify-center gap-2 py-8 text-zinc-500">
            <Loader2 size={14} className="animate-spin" />
            <span className="text-xs font-mono">Loading transcript...</span>
          </div>
        )}

        {/* Transcript content */}
        {hasTranscript && (
          <div className="px-4 py-3 text-xs font-mono text-zinc-300 leading-relaxed whitespace-pre-wrap break-words">
            {markdown}
          </div>
        )}

        {/* Tools list — always shown when no transcript, or collapsible when transcript exists */}
        {hasTools && !loading && (
          <div className={hasTranscript ? 'border-t border-zinc-800/60' : ''}>
            {hasTranscript ? (
              <button
                onClick={() => setToolsOpen(!toolsOpen)}
                className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono text-zinc-500 hover:text-zinc-400 transition-colors"
              >
                {toolsOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                Tools ({agent.tools.length})
              </button>
            ) : (
              <div className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-wider text-zinc-600 font-semibold">
                Tool calls
              </div>
            )}
            {(toolsOpen || !hasTranscript) && (
              <div className="pb-2">
                {agent.tools.map((t, i) => (
                  <ToolRow key={i} t={t} index={i} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Result — shown when no transcript available */}
        {!loading && !hasTranscript && agent.result && (
          <div className="px-3 pt-2 pb-3">
            <div className="text-[9px] uppercase tracking-wider text-zinc-600 font-semibold mb-1">Result</div>
            <div className="text-[11px] text-zinc-400 font-mono bg-zinc-900/60 rounded p-2.5 whitespace-pre-wrap break-words leading-relaxed max-h-[50vh] overflow-y-auto border border-zinc-800/40">
              {agent.result}
            </div>
          </div>
        )}

        {/* Running agent — live status */}
        {isRunning && !loading && (
          <div className="px-3 pt-3 pb-2">
            <div className="inline-flex items-center gap-2 text-green-400/80 mb-2">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-subtle-pulse" />
              <span className="text-[10px] font-mono">Running...</span>
            </div>
            {hasTools && (
              <div className="text-[10px] text-zinc-500 font-mono">
                Current: <span className="text-amber-300/70">{agent.tools[agent.tools.length - 1].tool}</span>
              </div>
            )}
          </div>
        )}

        {/* Empty state — no tools, no result, no transcript */}
        {!loading && !hasTranscript && !hasTools && !agent.result && !isRunning && (
          <div className="px-4 py-8 text-center text-xs text-zinc-600 font-mono">
            No output captured
          </div>
        )}
      </div>
    </div>
  )
}
