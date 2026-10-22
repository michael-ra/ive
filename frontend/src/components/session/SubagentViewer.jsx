import { useState, useEffect, useRef } from 'react'
import { X, Sparkles, Loader2, ChevronDown, ChevronRight, Terminal, FileText, Search, FolderSearch, Globe, Pencil, PenLine } from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { Button } from '../ui'

/** Pick an icon + color for a tool name (semantic tokens only: run/success,
 *  mutate/warn, agent/accent — everything else stays neutral). */
function toolMeta(name) {
  const n = (name || '').toLowerCase()
  if (n === 'bash' || n === 'execute') return { icon: Terminal, color: 'text-x-good' }
  if (n === 'read' || n === 'read_file') return { icon: FileText, color: 'text-x-ink-secondary' }
  if (n === 'write' || n === 'write_file') return { icon: PenLine, color: 'text-x-accent-ink' }
  if (n === 'edit' || n === 'edit_file') return { icon: Pencil, color: 'text-x-accent-ink' }
  if (n === 'grep' || n === 'search') return { icon: Search, color: 'text-x-ink-secondary' }
  if (n === 'glob' || n === 'find_files') return { icon: FolderSearch, color: 'text-x-ink-secondary' }
  if (n.includes('web') || n.includes('fetch')) return { icon: Globe, color: 'text-x-accent' }
  if (n === 'agent') return { icon: Sparkles, color: 'text-x-accent' }
  return { icon: Terminal, color: 'text-x-muted' }
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
        className="flex items-start gap-1.5 py-1 px-2 rounded-md hover:bg-x-hover cursor-pointer transition-colors duration-[80ms]"
        onClick={() => summary && setExpanded(!expanded)}
      >
        <span className="text-[11px] text-x-faint font-mono tabular-nums w-4 text-right shrink-0 mt-0.5">{index + 1}</span>
        <Icon size={11} className={`shrink-0 mt-0.5 ${color}`} />
        <div className="flex-1 min-w-0">
          <span className="text-[11px] font-mono text-x-ink-secondary">{t.tool}</span>
          {summary && !expanded && (
            <span className="text-[11px] font-mono text-x-muted ml-1.5 truncate inline-block max-w-[250px] align-bottom">
              {isBash ? summary.split('\n')[0].slice(0, 60) : shortenPath(summary)}
            </span>
          )}
        </div>
      </div>
      {expanded && summary && (
        <div className="ml-8 mr-2 mb-1 px-2 py-1.5 bg-x-surface-2 rounded-md text-[11px] font-mono text-x-ink-secondary whitespace-pre-wrap break-all max-h-32 overflow-y-auto border border-x-line">
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
      className="flex flex-col h-full bg-x-surface border-l border-x-line"
      style={{ width: 440 }}
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-x-line">
        <Sparkles size={12} className="text-x-accent" />
        <span className="text-[11px] text-x-ink font-medium">{agent.type}</span>
        <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${
          isRunning
            ? 'text-x-good bg-x-good/10'
            : 'text-x-muted bg-x-hover'
        }`}>
          {isRunning ? 'running' : 'done'}
        </span>
        {hasTools && (
          <span className="text-[11px] text-x-muted tabular-nums">
            {agent.tools.length} tool{agent.tools.length !== 1 ? 's' : ''}
          </span>
        )}
        <div className="flex-1" />
        <Button type="submit"
          onClick={onClose}
          className="p-1 hover:bg-x-hover text-x-muted hover:text-x-ink transition-colors duration-[80ms]"
        >
          <X size={14} />
        </Button>
      </div>

      {/* Body */}
      <div ref={bodyRef} className="flex-1 overflow-y-auto min-h-0">
        {/* Loading state */}
        {loading && (
          <div className="flex items-center justify-center gap-2 py-8 text-x-muted">
            <Loader2 size={14} className="animate-spin" />
            <span className="text-xs">Loading transcript...</span>
          </div>
        )}

        {/* Transcript content */}
        {hasTranscript && (
          <div className="px-4 py-3 text-xs font-mono text-x-ink-secondary leading-relaxed whitespace-pre-wrap break-words">
            {markdown}
          </div>
        )}

        {/* Tools list — always shown when no transcript, or collapsible when transcript exists */}
        {hasTools && !loading && (
          <div className={hasTranscript ? 'border-t border-x-line' : ''}>
            {hasTranscript ? (
              <button
                onClick={() => setToolsOpen(!toolsOpen)}
                className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-x-muted hover:text-x-ink-secondary transition-colors duration-[80ms]"
              >
                {toolsOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                Tools ({agent.tools.length})
              </button>
            ) : (
              <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wider text-x-muted font-medium">
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
            <div className="text-[11px] uppercase tracking-wider text-x-muted font-medium mb-1">Result</div>
            <div className="text-[11px] text-x-ink-secondary font-mono bg-x-surface-2 rounded-lg p-2.5 whitespace-pre-wrap break-words leading-relaxed max-h-[50vh] overflow-y-auto border border-x-line">
              {agent.result}
            </div>
          </div>
        )}

        {/* Running agent — live status */}
        {isRunning && !loading && (
          <div className="px-3 pt-3 pb-2">
            <div className="inline-flex items-center gap-2 text-x-good mb-2">
              <span className="w-1.5 h-1.5 rounded-full bg-x-good animate-subtle-pulse" />
              <span className="text-[11px] font-medium">Running...</span>
            </div>
            {hasTools && (
              <div className="text-[11px] text-x-muted font-mono">
                Current: <span className="text-x-accent-ink">{agent.tools[agent.tools.length - 1].tool}</span>
              </div>
            )}
          </div>
        )}

        {/* Empty state — no tools, no result, no transcript */}
        {!loading && !hasTranscript && !hasTools && !agent.result && !isRunning && (
          <div className="px-4 py-8 text-center text-xs text-x-muted">
            No output captured
          </div>
        )}
      </div>
    </div>
  )
}
