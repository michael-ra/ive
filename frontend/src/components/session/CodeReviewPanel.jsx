import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  GitCompareArrows, X, RefreshCw, Send, ChevronRight, ChevronDown,
  FileEdit, FilePlus, FileMinus, FileQuestion, Files, Loader2, AlertTriangle,
  GitCommitVertical, Check, ExternalLink, Settings2, Search, FolderOpen,
  MessageSquareQuote, Edit3, Save, RotateCcw
} from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { typeInTerminal } from '../../lib/terminal'
import { parseDiffLines, splitDiffByFile } from '../../lib/diffParser'
import { detectLang, tokenizeLine } from '../../lib/syntaxHighlight'

const STATUS_LABELS = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', '?': 'Untracked' }
const STATUS_ICONS = { M: FileEdit, A: FilePlus, D: FileMinus, '?': FileQuestion }

const IDE_OPTIONS = [
  { value: 'vscode', label: 'VS Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'zed', label: 'Zed' },
  { value: 'sublime', label: 'Sublime Text' },
  { value: 'idea', label: 'IntelliJ IDEA' },
  { value: 'webstorm', label: 'WebStorm' },
  { value: 'vim', label: 'Vim' },
  { value: 'neovim', label: 'Neovim' },
  { value: 'antigravity', label: 'Antigravity' },
]

const DEFAULT_PROMPT = `Please review the following code changes and provide feedback on code quality, potential bugs, security issues, and suggestions for improvement.

{annotations}

\`\`\`diff
{diff}
\`\`\``

// ── Helpers ─────────────────────────────────────────────────────

function FileIcon({ status }) {
  const Icon = STATUS_ICONS[status] || FileEdit
  const color = status === 'A' || status === '?' ? 'text-green-400'
    : status === 'D' ? 'text-red-400'
    : 'text-amber-400'
  return <Icon size={13} className={color} />
}

// Token type → CSS class for syntax highlighting
const TOKEN_CLASSES = {
  keyword: 'text-purple-400',
  string: 'text-amber-300',
  comment: 'text-zinc-600 italic',
  number: 'text-cyan-300',
  punctuation: 'text-zinc-500',
  default: '',
}

// Group consecutive selected indices: [[3,4,5], [8], [12,13]]
function groupConsecutive(indices) {
  if (!indices.length) return []
  const sorted = [...indices].sort((a, b) => a - b)
  const groups = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] + 1) {
      groups[groups.length - 1].push(sorted[i])
    } else {
      groups.push([sorted[i]])
    }
  }
  return groups
}

// Build VS Code-style directory tree from flat file list
function buildFileTree(files) {
  const dirs = {}
  const root = []
  for (const f of files) {
    const lastSlash = f.path.lastIndexOf('/')
    if (lastSlash === -1) {
      root.push(f)
    } else {
      const dir = f.path.slice(0, lastSlash)
      if (!dirs[dir]) dirs[dir] = []
      dirs[dir].push(f)
    }
  }
  // Sort dirs alphabetically, root files at end
  const sortedDirs = Object.keys(dirs).sort()
  return { dirs: sortedDirs.map((d) => ({ dir: d, files: dirs[d] })), rootFiles: root }
}

// ── Main Component ──────────────────────────────────────────────

export default function CodeReviewPanel({ onClose }) {
  const activeSessionId = useStore((s) => s.activeSessionId)
  const sessions = useStore((s) => s.sessions)
  const workspaces = useStore((s) => s.workspaces)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)

  const activeSession = sessions[activeSessionId]
  const workspaceId = activeSession?.workspace_id || activeWorkspaceId || workspaces[0]?.id
  const workspace = workspaces.find((w) => w.id === workspaceId)

  // ── Data state ──
  const [scope, setScope] = useState('working')
  const [status, setStatus] = useState(null)
  const [selectedFile, setSelectedFile] = useState(null)
  const [diffText, setDiffText] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [commits, setCommits] = useState([])
  const [commitRange, setCommitRange] = useState('HEAD~1')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // ── UI state ──
  const [expandedSections, setExpandedSections] = useState({ staged: true, unstaged: true, untracked: true })
  const [expandedDirs, setExpandedDirs] = useState({})
  const [ide, setIde] = useState('vscode')
  const [showIdeConfig, setShowIdeConfig] = useState(false)
  const [sent, setSent] = useState(false)
  const [targetSessionId, setTargetSessionId] = useState(activeSessionId)

  // ── Search state ──
  const [searchQuery, setSearchQuery] = useState('')
  const [searchVisible, setSearchVisible] = useState(false)
  const [currentMatch, setCurrentMatch] = useState(0)
  const searchInputRef = useRef(null)

  // ── Annotation state (TerminalAnnotator pattern) ──
  const [selected, setSelected] = useState(new Set())
  const [comments, setComments] = useState({})
  const [lastClicked, setLastClicked] = useState(null)
  const commentRefs = useRef({})

  // ── Prompt editing state ──
  const [promptTemplate, setPromptTemplate] = useState(DEFAULT_PROMPT)
  const [showPromptEditor, setShowPromptEditor] = useState(false)

  const refreshTimerRef = useRef(null)
  const diffListRef = useRef(null)

  const workspaceSessions = Object.values(sessions).filter(
    (s) => s.workspace_id === workspaceId
  )

  // ── Load settings on mount ──
  useEffect(() => {
    api.getAppSetting('ide').then((res) => {
      if (res?.value) setIde(res.value)
    }).catch(() => {})
    api.getAppSetting('code_review_prompt').then((res) => {
      if (res?.value) setPromptTemplate(res.value)
    }).catch(() => {})
  }, [])

  const handleIdeChange = (value) => {
    setIde(value)
    api.setAppSetting('ide', value).catch(() => {})
  }

  const handleOpenInIde = (filePath, line) => {
    if (!workspaceId || !filePath) return
    api.openInIde(workspaceId, filePath, line).catch(() => {})
  }

  const handleSavePrompt = () => {
    api.setAppSetting('code_review_prompt', promptTemplate).catch(() => {})
  }

  const handleResetPrompt = () => {
    setPromptTemplate(DEFAULT_PROMPT)
    api.setAppSetting('code_review_prompt', DEFAULT_PROMPT).catch(() => {})
  }

  // ── Data fetching ──
  const fetchStatus = useCallback(async () => {
    if (!workspaceId) return
    try {
      const res = await api.getGitStatus(workspaceId)
      setStatus(res)
      if (!res.is_git_repo) setError('This workspace is not a git repository')
    } catch (e) {
      setError(e.message)
    }
  }, [workspaceId])

  const fetchDiff = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    setError(null)
    try {
      const opts = {}
      if (scope === 'staged') opts.staged = true
      if (scope === 'commits') opts.range = commitRange
      if (selectedFile) opts.file = selectedFile
      const res = await api.getGitDiff(workspaceId, opts)
      setDiffText(res.diff || '')
      setTruncated(res.truncated || false)
    } catch (e) {
      setError(e.message)
      setDiffText('')
    } finally {
      setLoading(false)
    }
  }, [workspaceId, scope, selectedFile, commitRange])

  const fetchLog = useCallback(async () => {
    if (!workspaceId) return
    try {
      const res = await api.getGitLog(workspaceId)
      setCommits(res.commits || [])
    } catch { setCommits([]) }
  }, [workspaceId])

  useEffect(() => {
    fetchStatus()
    fetchDiff()
    if (scope === 'commits') fetchLog()
  }, [fetchStatus, fetchDiff, fetchLog, scope])

  useEffect(() => {
    refreshTimerRef.current = setInterval(fetchStatus, 5000)
    return () => clearInterval(refreshTimerRef.current)
  }, [fetchStatus])

  useEffect(() => {
    setSelectedFile(null)
    setSelected(new Set())
    setComments({})
  }, [scope])

  // Clear annotations when file changes
  useEffect(() => {
    setSelected(new Set())
    setComments({})
  }, [selectedFile, diffText])

  const handleRefresh = () => {
    fetchStatus()
    fetchDiff()
    if (scope === 'commits') fetchLog()
  }

  // ── Parsed diff lines with file context ──
  const parsedLines = useMemo(() => {
    const lines = parseDiffLines(diffText)
    // Track current file for syntax highlighting
    let currentFile = selectedFile || null
    return lines.map((line) => {
      if (line.type === 'file-header' && line.text.startsWith('diff --git')) {
        const m = line.text.match(/b\/(.+)$/)
        if (m) currentFile = m[1]
      }
      return { ...line, file: currentFile }
    })
  }, [diffText, selectedFile])

  // ── Search ──
  const searchMatches = useMemo(() => {
    if (!searchQuery) return []
    const q = searchQuery.toLowerCase()
    return parsedLines
      .map((line, idx) => line.text.toLowerCase().includes(q) ? idx : -1)
      .filter((idx) => idx !== -1)
  }, [parsedLines, searchQuery])

  useEffect(() => {
    if (searchMatches.length > 0 && currentMatch >= searchMatches.length) {
      setCurrentMatch(0)
    }
  }, [searchMatches, currentMatch])

  const scrollToMatch = useCallback((matchIdx) => {
    if (!diffListRef.current || !searchMatches[matchIdx]) return
    const lineIdx = searchMatches[matchIdx]
    const el = diffListRef.current.querySelector(`[data-line-idx="${lineIdx}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [searchMatches])

  const nextMatch = () => {
    const next = (currentMatch + 1) % searchMatches.length
    setCurrentMatch(next)
    scrollToMatch(next)
  }
  const prevMatch = () => {
    const prev = (currentMatch - 1 + searchMatches.length) % searchMatches.length
    setCurrentMatch(prev)
    scrollToMatch(prev)
  }

  // ── Annotation handlers (TerminalAnnotator pattern) ──
  const handleLineClick = useCallback((idx, e) => {
    // Don't select header/info lines
    const line = parsedLines[idx]
    if (!line || line.type === 'file-header' || line.type === 'info') return

    setSelected((prev) => {
      const next = new Set(prev)
      if (e.shiftKey && lastClicked != null) {
        const lo = Math.min(lastClicked, idx)
        const hi = Math.max(lastClicked, idx)
        let allSelected = true
        for (let i = lo; i <= hi; i++) {
          if (!prev.has(i)) { allSelected = false; break }
        }
        for (let i = lo; i <= hi; i++) {
          allSelected ? next.delete(i) : next.add(i)
        }
      } else {
        next.has(idx) ? next.delete(idx) : next.add(idx)
      }
      return next
    })
    setLastClicked(idx)
  }, [lastClicked, parsedLines])

  const groups = useMemo(() => groupConsecutive([...selected]), [selected])

  // Auto-create comment entries for new groups
  useEffect(() => {
    if (!groups.length) return
    const lastKey = groups[groups.length - 1][0]
    setComments((prev) => {
      let changed = false
      const next = { ...prev }
      for (const g of groups) {
        if (!(g[0] in next)) { next[g[0]] = ''; changed = true }
      }
      return changed ? next : prev
    })
    requestAnimationFrame(() => {
      commentRefs.current[lastKey]?.focus()
    })
  }, [groups])

  const setComment = useCallback((groupKey, text) => {
    setComments((prev) => ({ ...prev, [groupKey]: text }))
  }, [])

  const removeGroup = useCallback((groupIndices) => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const i of groupIndices) next.delete(i)
      return next
    })
    const key = groupIndices[0]
    setComments((prev) => { const next = { ...prev }; delete next[key]; return next })
  }, [])

  const clearAnnotations = () => { setSelected(new Set()); setComments({}) }

  const groupEnds = useMemo(() => {
    const map = new Map()
    for (const g of groups) map.set(g[g.length - 1], g[0])
    return map
  }, [groups])

  const groupStarts = useMemo(() => {
    const map = new Map()
    for (const g of groups) map.set(g[0], g)
    return map
  }, [groups])

  // ── Send review ──
  const handleSendToSession = () => {
    const sid = targetSessionId || activeSessionId
    if (!sid || !diffText) return

    // Build annotations text
    let annotationsText = ''
    if (groups.length > 0) {
      const parts = ['My annotations on the code:']
      for (const group of groups) {
        const groupKey = group[0]
        for (const idx of group) {
          const line = parsedLines[idx]
          if (line) parts.push(`> ${line.text.trimEnd()}`)
        }
        const comment = (comments[groupKey] || '').trim()
        if (comment) {
          for (const cl of comment.split('\n')) parts.push(`-> ${cl}`)
        }
        parts.push('')
      }
      annotationsText = parts.join('\n')
    }

    const prompt = promptTemplate
      .replace('{diff}', diffText.slice(0, 100000))
      .replace('{annotations}', annotationsText)

    typeInTerminal(sid, prompt + '\r')
    setSent(true)
    setTimeout(() => setSent(false), 2000)
  }

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handler = (e) => {
      // Cmd+F → toggle search within panel
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        e.stopPropagation()
        setSearchVisible((s) => !s)
        requestAnimationFrame(() => searchInputRef.current?.focus())
        return
      }
      // Enter → focus comment input for last group
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        if (groups.length > 0 && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') {
          e.preventDefault()
          const lastKey = groups[groups.length - 1][0]
          if (!(lastKey in comments)) setComment(lastKey, '')
          requestAnimationFrame(() => commentRefs.current[lastKey]?.focus())
        }
      }
      // Cmd+Enter → send
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleSendToSession()
      }
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [groups, comments, setComment, handleSendToSession])

  const toggleSection = (section) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }))
  }
  const toggleDir = (dir) => {
    setExpandedDirs((prev) => ({ ...prev, [dir]: !prev[dir] }))
  }

  const totalChanges = [
    ...(status?.staged || []),
    ...(status?.unstaged || []),
    ...(status?.untracked || []),
  ].length

  const ideName = IDE_OPTIONS.find((o) => o.value === ide)?.label || ide

  // ── No workspace ──
  if (!workspaceId) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="ide-panel scale-in p-8 text-center">
          <AlertTriangle size={24} className="text-amber-400 mx-auto mb-3" />
          <p className="text-zinc-300 text-sm">No workspace selected</p>
          <button onClick={onClose} className="mt-4 px-4 py-1.5 text-xs font-mono text-zinc-400 hover:text-zinc-200 bg-zinc-800 rounded">Close</button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-[1300px] h-[calc(100vh-60px)] ide-panel flex flex-col scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-center gap-3 px-5 py-2.5 border-b border-border-primary shrink-0">
          <GitCompareArrows size={16} className="text-accent-primary" />
          <span className="text-[13px] font-semibold text-zinc-200">Code Review</span>
          {workspace && (
            <span className="text-[11px] font-mono text-zinc-500 truncate max-w-[200px]">{workspace.name || workspace.path}</span>
          )}

          {/* Scope tabs */}
          <div className="flex items-center gap-0.5 ml-3 bg-zinc-900 rounded p-0.5">
            {['working', 'staged', 'commits'].map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`px-2.5 py-1 rounded text-[11px] font-mono transition-colors ${
                  scope === s ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-400'
                }`}
              >
                {s === 'working' ? 'Working' : s === 'staged' ? 'Staged' : 'Commits'}
              </button>
            ))}
          </div>

          {scope === 'commits' && (
            <select
              value={commitRange}
              onChange={(e) => setCommitRange(e.target.value)}
              className="px-2 py-1 text-[11px] font-mono bg-zinc-900 border border-zinc-700 rounded text-zinc-300"
            >
              <option value="HEAD~1">Last commit</option>
              <option value="HEAD~3">Last 3 commits</option>
              <option value="HEAD~5">Last 5 commits</option>
              <option value="HEAD~10">Last 10 commits</option>
            </select>
          )}

          <div className="flex-1" />

          {/* Annotation count */}
          {selected.size > 0 && (
            <span className="text-[10px] text-cyan-400 font-mono">
              {selected.size} selected &middot; {groups.length} group{groups.length !== 1 ? 's' : ''}
            </span>
          )}
          {selected.size > 0 && (
            <button onClick={clearAnnotations} className="text-[10px] text-zinc-500 hover:text-zinc-300 font-mono">clear</button>
          )}

          {totalChanges > 0 && (
            <span className="text-[11px] font-mono text-zinc-500">
              {totalChanges} file{totalChanges !== 1 ? 's' : ''}
            </span>
          )}

          {/* Search toggle */}
          <button
            onClick={() => { setSearchVisible((s) => !s); requestAnimationFrame(() => searchInputRef.current?.focus()) }}
            className={`p-1.5 rounded transition-colors ${searchVisible ? 'text-accent-primary bg-accent-primary/10' : 'text-zinc-500 hover:text-zinc-300'}`}
            title="Search (Cmd+F)"
          >
            <Search size={13} />
          </button>

          {/* IDE config */}
          <div className="relative">
            <button
              onClick={() => setShowIdeConfig((s) => !s)}
              className={`p-1.5 rounded transition-colors ${showIdeConfig ? 'text-accent-primary bg-accent-primary/10' : 'text-zinc-500 hover:text-zinc-300'}`}
              title={`IDE: ${ideName}`}
            >
              <Settings2 size={13} />
            </button>
            {showIdeConfig && (
              <div className="absolute right-0 top-full mt-1 z-10 ide-panel p-3 w-[200px]" onClick={(e) => e.stopPropagation()}>
                <div className="text-[10px] font-mono uppercase text-zinc-500 mb-2">Default IDE</div>
                {IDE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => { handleIdeChange(opt.value); setShowIdeConfig(false) }}
                    className={`w-full text-left px-2 py-1.5 text-[11px] font-mono rounded transition-colors ${
                      ide === opt.value ? 'bg-accent-primary/10 text-accent-primary' : 'text-zinc-400 hover:bg-zinc-800'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button onClick={handleRefresh} className="p-1.5 text-zinc-500 hover:text-zinc-300 rounded transition-colors" title="Refresh">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
          <button onClick={onClose} className="p-1.5 text-zinc-500 hover:text-zinc-300 rounded transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* ── Search bar ── */}
        {searchVisible && (
          <div className="flex items-center gap-2 px-5 py-2 border-b border-border-primary bg-bg-elevated shrink-0">
            <Search size={12} className="text-zinc-500" />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setCurrentMatch(0) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.shiftKey ? prevMatch() : nextMatch() }
                if (e.key === 'Escape') { e.stopPropagation(); setSearchVisible(false); setSearchQuery('') }
              }}
              placeholder="Search in diff..."
              className="flex-1 px-2 py-1 text-[11px] font-mono bg-transparent text-zinc-300 placeholder-zinc-600 focus:outline-none"
              autoFocus
            />
            {searchQuery && (
              <>
                <span className="text-[10px] font-mono text-zinc-500">
                  {searchMatches.length > 0 ? `${currentMatch + 1}/${searchMatches.length}` : 'No matches'}
                </span>
                <button onClick={prevMatch} disabled={!searchMatches.length} className="text-zinc-500 hover:text-zinc-300 disabled:opacity-30 text-xs">&uarr;</button>
                <button onClick={nextMatch} disabled={!searchMatches.length} className="text-zinc-500 hover:text-zinc-300 disabled:opacity-30 text-xs">&darr;</button>
              </>
            )}
            <button onClick={() => { setSearchVisible(false); setSearchQuery('') }} className="text-zinc-500 hover:text-zinc-300">
              <X size={12} />
            </button>
          </div>
        )}

        {/* ── Body ── */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* ── File tree (left sidebar) ── */}
          <div className="w-[260px] shrink-0 border-r border-zinc-800 overflow-y-auto">
            <button
              onClick={() => setSelectedFile(null)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-[11px] font-mono transition-colors ${
                selectedFile === null ? 'bg-accent-primary/10 text-accent-primary' : 'text-zinc-400 hover:bg-zinc-800/50'
              }`}
            >
              <Files size={13} />
              All Files
            </button>

            {error && status && !status.is_git_repo ? (
              <div className="px-3 py-4 text-center">
                <AlertTriangle size={16} className="text-amber-400 mx-auto mb-2" />
                <p className="text-[11px] text-zinc-500">Not a git repository</p>
              </div>
            ) : (
              <>
                {scope !== 'staged' && status?.staged?.length > 0 && (
                  <FileSection
                    label="Staged" color="text-green-500" files={status.staged}
                    expanded={expandedSections.staged} onToggle={() => toggleSection('staged')}
                    selectedFile={selectedFile} onSelect={setSelectedFile}
                    onOpenInIde={handleOpenInIde} expandedDirs={expandedDirs} onToggleDir={toggleDir}
                  />
                )}

                {(scope === 'working' || scope === 'staged') && status?.unstaged?.length > 0 && (
                  <FileSection
                    label="Unstaged" color="text-amber-500" files={status.unstaged}
                    expanded={expandedSections.unstaged} onToggle={() => toggleSection('unstaged')}
                    selectedFile={selectedFile} onSelect={setSelectedFile}
                    onOpenInIde={handleOpenInIde} expandedDirs={expandedDirs} onToggleDir={toggleDir}
                  />
                )}

                {scope === 'working' && status?.untracked?.length > 0 && (
                  <FileSection
                    label="Untracked" color="text-zinc-500"
                    files={status.untracked.map((f) => ({ ...f, status: '?' }))}
                    expanded={expandedSections.untracked} onToggle={() => toggleSection('untracked')}
                    selectedFile={selectedFile} onSelect={setSelectedFile}
                    onOpenInIde={handleOpenInIde} expandedDirs={expandedDirs} onToggleDir={toggleDir}
                  />
                )}

                {scope === 'commits' && commits.length > 0 && (
                  <div className="mt-2 border-t border-zinc-800">
                    <div className="px-3 py-1.5 text-[10px] font-mono uppercase text-zinc-500">Recent Commits</div>
                    {commits.slice(0, 10).map((c) => (
                      <div key={c.hash} className="px-3 py-1 text-[10px] font-mono text-zinc-500 truncate" title={c.message}>
                        <GitCommitVertical size={10} className="inline mr-1 text-zinc-600" />
                        <span className="text-zinc-400">{c.short_hash}</span> {c.message}
                      </div>
                    ))}
                  </div>
                )}

                {status && !status.staged?.length && !status.unstaged?.length && !status.untracked?.length && scope !== 'commits' && (
                  <div className="px-3 py-8 text-center">
                    <Check size={16} className="text-green-400 mx-auto mb-2" />
                    <p className="text-[11px] text-zinc-500">Working tree clean</p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── Diff view with annotations ── */}
          <div ref={diffListRef} className="flex-1 overflow-y-auto bg-[#0a0a0c] font-mono text-xs">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 size={20} className="text-zinc-500 animate-spin" />
              </div>
            ) : error && (!status || !status.is_git_repo) ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <AlertTriangle size={24} className="text-amber-400 mx-auto mb-3" />
                  <p className="text-zinc-400 text-sm">{error}</p>
                </div>
              </div>
            ) : !diffText ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-zinc-600 text-sm font-mono">No changes to display</p>
              </div>
            ) : (
              <div className="min-w-0">
                {truncated && (
                  <div className="px-4 py-2 bg-amber-900/20 border-b border-amber-500/20 text-amber-300 text-[11px] font-mono">
                    Diff truncated (exceeds 200KB). Select individual files for full diffs.
                  </div>
                )}
                {parsedLines.map((line, idx) => {
                  const isSel = selected.has(idx)
                  const groupEndKey = groupEnds.get(idx)
                  const commentForGroup = groupEndKey != null ? (comments[groupEndKey] ?? '') : null
                  const groupAtStart = groupStarts.get(idx)
                  const isSearchMatch = searchQuery && searchMatches.includes(idx)
                  const isCurrentSearchMatch = isSearchMatch && searchMatches[currentMatch] === idx

                  return (
                    <div key={idx} data-line-idx={idx}>
                      <AnnotatedDiffLine
                        line={line}
                        idx={idx}
                        isSel={isSel}
                        isSearchMatch={isSearchMatch}
                        isCurrentSearchMatch={isCurrentSearchMatch}
                        groupAtStart={groupAtStart}
                        onClick={handleLineClick}
                        onRemoveGroup={removeGroup}
                        onOpenInIde={handleOpenInIde}
                        searchQuery={searchQuery}
                      />
                      {/* Comment input after last line of each group */}
                      {commentForGroup != null && (
                        <div className="flex items-start ml-[72px] mr-4 my-1 pl-3 pr-2 py-1.5 bg-amber-500/8 border border-amber-500/20 rounded-md">
                          <span className="text-amber-400 text-[11px] font-semibold shrink-0 pt-0.5 mr-2">{'\u2192'}</span>
                          <textarea
                            ref={(el) => { if (el) commentRefs.current[groupEndKey] = el }}
                            value={commentForGroup}
                            onChange={(e) => setComment(groupEndKey, e.target.value)}
                            placeholder="your comment..."
                            className="flex-1 bg-transparent text-amber-200/90 text-xs font-mono resize-none focus:outline-none placeholder:text-amber-200/30 min-h-[22px]"
                            rows={Math.max(1, commentForGroup.split('\n').length)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) e.stopPropagation()
                              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); handleSendToSession() }
                              if (e.key === 'Escape') { e.stopPropagation(); e.target.blur() }
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
                <div className="h-8" />
              </div>
            )}
          </div>
        </div>

        {/* ── Prompt editor (collapsible) ── */}
        {showPromptEditor && (
          <div className="border-t border-border-primary bg-bg-elevated px-5 py-3 shrink-0">
            <div className="flex items-center gap-2 mb-2">
              <Edit3 size={12} className="text-zinc-400" />
              <span className="text-[11px] font-mono text-zinc-400">Review Prompt Template</span>
              <span className="text-[9px] font-mono text-zinc-600">Use {'{diff}'} and {'{annotations}'} as placeholders</span>
              <div className="flex-1" />
              <button onClick={handleSavePrompt} className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono text-zinc-400 hover:text-zinc-200 bg-zinc-800 rounded" title="Save as default">
                <Save size={10} /> Save
              </button>
              <button onClick={handleResetPrompt} className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono text-zinc-400 hover:text-zinc-200 bg-zinc-800 rounded" title="Reset to default">
                <RotateCcw size={10} /> Reset
              </button>
            </div>
            <textarea
              value={promptTemplate}
              onChange={(e) => setPromptTemplate(e.target.value)}
              className="w-full h-[100px] px-3 py-2 text-[11px] font-mono bg-[#0a0a0c] border border-zinc-800 rounded text-zinc-300 resize-y focus:outline-none focus:border-zinc-600"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}

        {/* ── Footer ── */}
        <div className="flex items-center gap-2 px-5 py-2.5 border-t border-border-primary shrink-0">
          {selectedFile && (
            <button
              onClick={() => handleOpenInIde(selectedFile)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono rounded transition-colors bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700"
            >
              <ExternalLink size={11} />
              Open in {ideName}
            </button>
          )}

          <button
            onClick={() => setShowPromptEditor((s) => !s)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono rounded transition-colors border ${
              showPromptEditor ? 'bg-accent-primary/10 text-accent-primary border-accent-primary/30' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400 border-zinc-700'
            }`}
          >
            <Edit3 size={11} />
            Prompt
          </button>

          <button
            onClick={handleSendToSession}
            disabled={!diffText || sent}
            className={`flex items-center gap-1.5 px-4 py-1.5 text-[11px] font-mono rounded transition-colors ${
              sent
                ? 'bg-green-600/20 text-green-300 border border-green-500/30'
                : diffText
                  ? 'bg-accent-primary/20 hover:bg-accent-primary/30 text-indigo-300 border border-indigo-500/30'
                  : 'bg-zinc-800 text-zinc-600 border border-zinc-700 cursor-not-allowed'
            }`}
          >
            {sent ? <Check size={11} /> : <Send size={11} />}
            {sent ? 'Sent!' : groups.length > 0 ? `Send Review (${groups.length} annotations)` : 'Send to Claude'}
          </button>

          {workspaceSessions.length > 1 && (
            <select
              value={targetSessionId || ''}
              onChange={(e) => setTargetSessionId(e.target.value)}
              className="px-2 py-1.5 text-[11px] font-mono bg-zinc-900 border border-zinc-700 rounded text-zinc-300"
            >
              {workspaceSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || `Session ${s.id.slice(0, 6)}`}
                  {s.id === activeSessionId ? ' (active)' : ''}
                </option>
              ))}
            </select>
          )}

          <div className="flex-1" />
          <div className="flex items-center gap-3 text-[10px] text-zinc-600 font-mono">
            <span>Click to annotate</span>
            <span>Shift+click range</span>
            <span>{'\u2318\u21B5'} send</span>
            <span>Esc close</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Annotated Diff Line ─────────────────────────────────────────

function AnnotatedDiffLine({ line, idx, isSel, isSearchMatch, isCurrentSearchMatch, groupAtStart, onClick, onRemoveGroup, onOpenInIde, searchQuery }) {
  const bgCls = {
    'file-header': 'bg-zinc-800/50',
    'hunk-header': 'bg-cyan-900/10',
    'add': 'bg-green-900/20',
    'remove': 'bg-red-900/20',
    'context': '',
    'info': '',
  }[line.type] || ''

  const isClickable = line.type !== 'file-header' && line.type !== 'info'
  const lang = line.file ? detectLang(line.file) : null

  // Code content (strip diff prefix)
  const prefix = (line.type === 'add' || line.type === 'remove') ? line.text[0] : line.type === 'context' ? ' ' : ''
  const codeText = (line.type === 'add' || line.type === 'remove' || line.type === 'context')
    ? line.text.slice(1)
    : line.text

  // Syntax tokens for code lines
  const tokens = (line.type === 'add' || line.type === 'remove' || line.type === 'context')
    ? tokenizeLine(codeText, lang)
    : null

  return (
    <div
      className={`flex items-start transition-colors border-l-2 ${
        isSel
          ? 'bg-cyan-500/10 border-l-cyan-400'
          : isCurrentSearchMatch
            ? 'bg-amber-500/15 border-l-amber-400'
            : isSearchMatch
              ? 'bg-amber-500/5 border-l-amber-400/50'
              : `${bgCls} border-l-transparent ${isClickable ? 'hover:bg-white/[0.02] cursor-pointer' : ''}`
      }`}
      onClick={isClickable ? (e) => onClick(idx, e) : undefined}
    >
      {/* Gutter: line numbers */}
      <span className="w-[28px] shrink-0 text-right pr-1 py-px select-none text-zinc-700 text-[10px] leading-[18px] tabular-nums">
        {line.type === 'remove' ? line.lineOld : line.type === 'context' ? line.lineOld : ''}
      </span>
      <span className="w-[28px] shrink-0 text-right pr-1 py-px select-none text-zinc-700 text-[10px] leading-[18px] tabular-nums">
        {line.type === 'add' ? line.lineNew : line.type === 'context' ? line.lineNew : ''}
      </span>

      {/* Selection indicator */}
      <span className={`w-3 shrink-0 py-px text-center text-[10px] leading-[18px] ${
        isSel ? 'text-cyan-400' : 'text-transparent'
      }`}>
        {isSel ? '\u25A0' : '\u00B7'}
      </span>

      {/* Diff prefix (+/-/space) */}
      {(line.type === 'add' || line.type === 'remove' || line.type === 'context') && (
        <span className={`w-3 shrink-0 py-px text-center leading-[18px] ${
          line.type === 'add' ? 'text-green-500' : line.type === 'remove' ? 'text-red-500' : 'text-zinc-600'
        }`}>
          {prefix}
        </span>
      )}

      {/* Line content */}
      <span className="flex-1 py-px whitespace-pre leading-[18px] overflow-hidden">
        {tokens ? (
          tokens.map((tok, ti) => (
            <span key={ti} className={TOKEN_CLASSES[tok.type] || ''}>
              {searchQuery ? highlightSearch(tok.text, searchQuery) : tok.text}
            </span>
          ))
        ) : (
          <span className={
            line.type === 'file-header' ? 'text-zinc-200 font-semibold' :
            line.type === 'hunk-header' ? 'text-cyan-400' :
            'text-zinc-500 italic'
          }>
            {searchQuery ? highlightSearch(line.text, searchQuery) : line.text}
          </span>
        )}
      </span>

      {/* Open in IDE on file headers */}
      {line.type === 'file-header' && line.text.startsWith('diff --git') && line.file && (
        <button
          onClick={(e) => { e.stopPropagation(); onOpenInIde(line.file) }}
          className="shrink-0 px-2 py-px text-zinc-600 hover:text-zinc-300 transition-colors"
          title={`Open ${line.file} in IDE`}
        >
          <ExternalLink size={11} />
        </button>
      )}

      {/* X to remove group */}
      {groupAtStart ? (
        <button
          onClick={(e) => { e.stopPropagation(); onRemoveGroup(groupAtStart) }}
          className="shrink-0 w-5 h-[18px] flex items-center justify-center text-cyan-400/60 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors mr-1"
        >
          <X size={10} />
        </button>
      ) : isSel ? (
        <span className="w-5 shrink-0 mr-1" />
      ) : null}
    </div>
  )
}

// Highlight search matches within text
function highlightSearch(text, query) {
  if (!query || !text) return text
  const parts = []
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  let lastIdx = 0
  let pos = lower.indexOf(q)
  while (pos !== -1) {
    if (pos > lastIdx) parts.push(<span key={`t${lastIdx}`}>{text.slice(lastIdx, pos)}</span>)
    parts.push(<mark key={`m${pos}`} className="bg-amber-400/30 text-inherit rounded-sm">{text.slice(pos, pos + q.length)}</mark>)
    lastIdx = pos + q.length
    pos = lower.indexOf(q, lastIdx)
  }
  if (lastIdx < text.length) parts.push(<span key={`t${lastIdx}`}>{text.slice(lastIdx)}</span>)
  return parts.length > 0 ? parts : text
}

// ── File Section with VS Code-style directory grouping ──────────

function FileSection({ label, color, files, expanded, onToggle, selectedFile, onSelect, onOpenInIde, expandedDirs, onToggleDir }) {
  const tree = useMemo(() => buildFileTree(files), [files])

  return (
    <div>
      <button
        onClick={onToggle}
        className={`w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono uppercase ${color} hover:bg-zinc-800/30`}
      >
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {label} ({files.length})
      </button>
      {expanded && (
        <>
          {/* Directory groups */}
          {tree.dirs.map(({ dir, files: dirFiles }) => {
            const isExpanded = expandedDirs[`${label}-${dir}`] !== false // default open
            return (
              <div key={dir}>
                <button
                  onClick={() => onToggleDir(`${label}-${dir}`)}
                  className="w-full flex items-center gap-1.5 px-3 pl-5 py-0.5 text-[10px] font-mono text-zinc-500 hover:bg-zinc-800/30"
                >
                  {isExpanded ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
                  <FolderOpen size={11} className="text-zinc-600" />
                  <span className="truncate">{dir}</span>
                </button>
                {isExpanded && dirFiles.map((f) => (
                  <FileButton
                    key={f.path}
                    file={f}
                    selected={selectedFile === f.path}
                    onClick={() => onSelect(f.path)}
                    onOpenInIde={() => onOpenInIde(f.path)}
                    indent
                  />
                ))}
              </div>
            )
          })}
          {/* Root files */}
          {tree.rootFiles.map((f) => (
            <FileButton
              key={f.path}
              file={f}
              selected={selectedFile === f.path}
              onClick={() => onSelect(f.path)}
              onOpenInIde={() => onOpenInIde(f.path)}
            />
          ))}
        </>
      )}
    </div>
  )
}

function FileButton({ file, selected, onClick, onOpenInIde, indent }) {
  const filename = file.path.split('/').pop()

  return (
    <div className={`group flex items-center text-[11px] font-mono transition-colors ${
      selected ? 'bg-accent-primary/10' : 'hover:bg-zinc-800/50'
    }`}>
      <button
        onClick={onClick}
        className={`flex-1 flex items-center gap-2 py-1 truncate ${indent ? 'pl-10' : 'px-3 pl-5'} ${
          selected ? 'text-accent-primary' : 'text-zinc-400'
        }`}
        title={file.path}
      >
        <FileIcon status={file.status} />
        <span className="truncate">{filename}</span>
        <span className="ml-auto text-[9px] text-zinc-600 shrink-0">{STATUS_LABELS[file.status] || file.status}</span>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onOpenInIde() }}
        className="hidden group-hover:flex items-center px-2 py-1 text-zinc-600 hover:text-zinc-300 transition-colors"
        title="Open in IDE"
      >
        <ExternalLink size={11} />
      </button>
    </div>
  )
}
