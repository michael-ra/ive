import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  GitCompareArrows, X, RefreshCw, Send, ChevronRight, ChevronDown,
  FileEdit, FilePlus, FileMinus, FileQuestion, Files, Loader2, AlertTriangle,
  GitCommitVertical, Check, ExternalLink, Settings2, Search, FolderOpen,
  Edit3, Save, RotateCcw, Bot, Sparkles, Shield, CheckSquare
} from 'lucide-react'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { sendTerminalCommand } from '../../lib/terminal'
import { parseDiffLines } from '../../lib/diffParser'
import { detectLang, tokenizeLine } from '../../lib/syntaxHighlight'
import { getCliLabel, getRoleDefaultModel, getDefaultPermissionMode } from '../../lib/constants'

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

const DEFAULT_AGENT_PROMPT = `Act as a careful code reviewer. Walk the diff, flag bugs, security issues, regressions, dead code, and unclear naming. Quote the offending lines and propose concrete fixes. Be terse — skip what already looks correct.

{annotations}

\`\`\`diff
{diff}
\`\`\``

// Skills relevant to code review. Other installed skills also get listed if found.
const REVIEW_SKILLS = ['review', 'security-review', 'simplify', 'code-review']

function resolveReviewCliType(workspace, activeSession) {
  const configured = workspace?.review_provider || 'active'
  if (configured && configured !== 'active') return configured
  return activeSession?.cli_type || 'claude'
}

function reviewProviderLabel(value) {
  if (!value || value === 'active') return 'Active session CLI'
  return getCliLabel(value)
}

// ── Helpers ─────────────────────────────────────────────────────

function FileIcon({ status }) {
  const Icon = STATUS_ICONS[status] || FileEdit
  const color = status === 'A' || status === '?' ? 'text-x-good'
    : status === 'D' ? 'text-x-accent-ink'
    : 'text-x-accent-ink'
  return <Icon size={13} className={color} />
}

// Token type → canonical Xirp class for syntax highlighting.
const TOKEN_CLASSES = {
  keyword: 'text-[color:var(--x-accent-ink)]',
  string: 'text-[color:var(--x-good)]',
  comment: 'text-[color:var(--x-muted)] italic',
  number: 'text-[color:var(--x-accent-ink)]',
  punctuation: 'text-x-ink-secondary',
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
  const reviewCliType = resolveReviewCliType(workspace, activeSession)
  const configuredReviewProvider = workspace?.review_provider || 'active'

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

  // ── Drag-to-select state ──
  const [isDragging, setIsDragging] = useState(false)
  const dragAnchorRef = useRef(null) // idx where drag started
  const dragModeRef = useRef('add')  // 'add' or 'remove' depending on anchor's pre-state

  // ── Agent review modal state ──
  const [agentModalOpen, setAgentModalOpen] = useState(false)
  const [agentPrompt, setAgentPrompt] = useState(DEFAULT_AGENT_PROMPT)
  const [agentSkill, setAgentSkill] = useState('')
  const [agentGuidelineIds, setAgentGuidelineIds] = useState(new Set())
  const [agentMode, setAgentMode] = useState('new') // 'new' | 'current'
  const [agentBusy, setAgentBusy] = useState(false)
  const [agentError, setAgentError] = useState(null)
  const [availableSkills, setAvailableSkills] = useState([])
  const [availableGuidelines, setAvailableGuidelines] = useState([])

  const refreshTimerRef = useRef(null)
  const diffListRef = useRef(null)

  const workspaceSessions = Object.values(sessions)
    .filter((s) => s.workspace_id === workspaceId)
    .sort((a, b) => {
      const aComm = a.session_type === 'commander'
      const bComm = b.session_type === 'commander'
      if (aComm && !bComm) return -1
      if (!aComm && bComm) return 1

      const ai = a.order_index || 0
      const bi = b.order_index || 0
      if (ai === 0 && bi === 0) return 0
      if (ai === 0) return 1
      if (bi === 0) return -1
      return ai - bi
    })

  // ── Load settings on mount ──
  useEffect(() => {
    api.getAppSetting('ide').then((res) => {
      if (res?.value) setIde(res.value)
    }).catch(() => {})
    api.getAppSetting('code_review_prompt').then((res) => {
      if (res?.value) setPromptTemplate(res.value)
    }).catch(() => {})
    api.getAppSetting('code_review_agent_prompt').then((res) => {
      if (res?.value) setAgentPrompt(res.value)
    }).catch(() => {})
    // Pull guidelines (project-wide list)
    api.getGuidelines?.().then((res) => {
      const items = Array.isArray(res) ? res : (res?.guidelines || [])
      setAvailableGuidelines(items)
    }).catch(() => {})
  }, [])

  // The sidebar's "Review with Agent" button fires this after dispatching open-panel.
  // Picking it up here lets the modal open as part of the same gesture.
  useEffect(() => {
    const onOpenAgent = () => setAgentModalOpen(true)
    window.addEventListener('code-review:open-agent', onOpenAgent)
    return () => window.removeEventListener('code-review:open-agent', onOpenAgent)
  }, [])

  // Load installed skills for the workspace. Skill list is curated to those
  // relevant for review — anything else stays available via the catalog UI.
  useEffect(() => {
    if (!workspaceId) return
    api.getInstalledSkills?.(workspaceId, 'all').then((res) => {
      const items = Array.isArray(res) ? res : (res?.skills || [])
      const names = new Set()
      for (const s of items) {
        const n = (s.name || s.slug || s.id || '').toLowerCase()
        if (!n) continue
        if (REVIEW_SKILLS.includes(n) || n.includes('review') || n.includes('simplif')) names.add(n)
      }
      // Always offer the canonical review skills even if not installed locally
      for (const n of REVIEW_SKILLS) names.add(n)
      setAvailableSkills([...names].sort())
    }).catch(() => {
      setAvailableSkills([...REVIEW_SKILLS])
    })
  }, [workspaceId])

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
    // Only poll git status while the document is visible — avoids constant
    // background re-renders (every 5s) when the panel/tab isn't being viewed.
    const sync = () => {
      clearInterval(refreshTimerRef.current)
      if (document.visibilityState === 'visible') {
        refreshTimerRef.current = setInterval(fetchStatus, 5000)
      }
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      clearInterval(refreshTimerRef.current)
      document.removeEventListener('visibilitychange', sync)
    }
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

  // ── Search (debounced so a large diff isn't re-scanned on every keystroke) ──
  const [debouncedQuery, setDebouncedQuery] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 150)
    return () => clearTimeout(t)
  }, [searchQuery])
  const searchMatches = useMemo(() => {
    if (!debouncedQuery) return []
    const q = debouncedQuery.toLowerCase()
    return parsedLines
      .map((line, idx) => line.text.toLowerCase().includes(q) ? idx : -1)
      .filter((idx) => idx !== -1)
  }, [parsedLines, debouncedQuery])

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

  // ── Annotation handlers ──
  // Single-click = toggle. Shift-click = range from lastClicked.
  // Click-and-drag = paint selection across the dragged range, in whichever
  //   direction (add if anchor wasn't selected, remove if it was).
  const isSelectableLine = (line) => line && line.type !== 'file-header' && line.type !== 'info'

  const handleLineMouseDown = useCallback((idx, e) => {
    const line = parsedLines[idx]
    if (!isSelectableLine(line)) return
    // Let textareas, buttons, etc. inside the row work normally
    if (e.button !== 0) return

    if (e.shiftKey && lastClicked != null) {
      // Range select from lastClicked
      setSelected((prev) => {
        const next = new Set(prev)
        const lo = Math.min(lastClicked, idx)
        const hi = Math.max(lastClicked, idx)
        let allSelected = true
        for (let i = lo; i <= hi; i++) {
          if (!isSelectableLine(parsedLines[i])) continue
          if (!prev.has(i)) { allSelected = false; break }
        }
        for (let i = lo; i <= hi; i++) {
          if (!isSelectableLine(parsedLines[i])) continue
          allSelected ? next.delete(i) : next.add(i)
        }
        return next
      })
      setLastClicked(idx)
      return
    }

    // Start a drag-paint. Mode is determined by whether the anchor was already selected.
    const wasSelected = selected.has(idx)
    dragAnchorRef.current = idx
    dragModeRef.current = wasSelected ? 'remove' : 'add'
    setIsDragging(true)
    setSelected((prev) => {
      const next = new Set(prev)
      wasSelected ? next.delete(idx) : next.add(idx)
      return next
    })
    setLastClicked(idx)
  }, [lastClicked, parsedLines, selected])

  const handleLineMouseEnter = useCallback((idx) => {
    if (!isDragging || dragAnchorRef.current == null) return
    const anchor = dragAnchorRef.current
    const mode = dragModeRef.current
    const lo = Math.min(anchor, idx)
    const hi = Math.max(anchor, idx)
    setSelected((prev) => {
      const next = new Set(prev)
      for (let i = lo; i <= hi; i++) {
        if (!isSelectableLine(parsedLines[i])) continue
        mode === 'add' ? next.add(i) : next.delete(i)
      }
      return next
    })
  }, [isDragging, parsedLines])

  useEffect(() => {
    if (!isDragging) return
    const onUp = () => { setIsDragging(false); dragAnchorRef.current = null }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [isDragging])

  // Click a hunk-header to select every add/remove line in that hunk.
  // Click a file-header to select every add/remove line in that file.
  const handleHeaderClick = useCallback((idx) => {
    const line = parsedLines[idx]
    if (!line) return
    const isFileHeader = line.type === 'file-header' && line.text.startsWith('diff --git')
    const isHunkHeader = line.type === 'hunk-header'
    if (!isFileHeader && !isHunkHeader) return

    // Find the range: start = idx+1, end = next hunk-header (for hunk click) or next file-header (for file click)
    const end = (() => {
      for (let i = idx + 1; i < parsedLines.length; i++) {
        const t = parsedLines[i]?.type
        if (isFileHeader && t === 'file-header' && parsedLines[i].text.startsWith('diff --git')) return i
        if (isHunkHeader && (t === 'hunk-header' || (t === 'file-header' && parsedLines[i].text.startsWith('diff --git')))) return i
      }
      return parsedLines.length
    })()

    // Collect add/remove lines in [idx+1, end)
    const targets = []
    for (let i = idx + 1; i < end; i++) {
      const t = parsedLines[i]?.type
      if (t === 'add' || t === 'remove') targets.push(i)
    }
    if (!targets.length) return

    setSelected((prev) => {
      const next = new Set(prev)
      const allOn = targets.every((i) => prev.has(i))
      for (const i of targets) allOn ? next.delete(i) : next.add(i)
      return next
    })
    setLastClicked(targets[targets.length - 1])
  }, [parsedLines])

  const handleSelectAllChanges = useCallback(() => {
    const targets = []
    for (let i = 0; i < parsedLines.length; i++) {
      const t = parsedLines[i]?.type
      if (t === 'add' || t === 'remove') targets.push(i)
    }
    if (!targets.length) return
    setSelected((prev) => {
      const allOn = targets.every((i) => prev.has(i))
      if (allOn) return new Set()
      const next = new Set(prev)
      for (const i of targets) next.add(i)
      return next
    })
  }, [parsedLines])

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
  const handleSendToSession = async () => {
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

    const basePrompt = promptTemplate
      .replace('{diff}', diffText.slice(0, 100000))
      .replace('{annotations}', annotationsText)
    let prompt = basePrompt
    try {
      const enriched = await api.composeReviewBrief({
        instructions: basePrompt,
        reviewed_session_id: activeSessionId,
      })
      if (enriched?.brief) prompt = enriched.brief
    } catch {}

    // sendTerminalCommand wraps in bracketed-paste and submits \r as a
    // separate frame — necessary because the diff body can be up to 100KB,
    // which absolutely triggers Ink's paste detection (a raw text+\r blob
    // would land in the input field and never submit).
    sendTerminalCommand(sid, prompt)
    setSent(true)
    setTimeout(() => setSent(false), 2000)
  }

  // Build the annotations text block once, reused by both send paths.
  const buildAnnotationsText = useCallback(() => {
    if (!groups.length) return ''
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
    return parts.join('\n')
  }, [groups, parsedLines, comments])

  // Spawn a fresh agent session pre-loaded with the diff + chosen skill + guidelines.
  // Falls back to sending to the current session if agentMode === 'current'.
  const handleSpawnAgent = async () => {
    if (!workspaceId || !diffText) return
    setAgentBusy(true)
    setAgentError(null)
    try {
      const annotationsText = buildAnnotationsText()
      const skillPrefix = agentSkill ? `/${agentSkill}\n\n` : ''
      const body = (agentPrompt || DEFAULT_AGENT_PROMPT)
        .replace('{diff}', diffText.slice(0, 100000))
        .replace('{annotations}', annotationsText)
      let reviewBody = body
      try {
        const enriched = await api.composeReviewBrief({
          instructions: body,
          reviewed_session_id: activeSessionId,
        })
        if (enriched?.brief) reviewBody = enriched.brief
      } catch {}
      const prompt = `${skillPrefix}${reviewBody}`

      let sid
      if (agentMode === 'current') {
        sid = targetSessionId || activeSessionId
        if (!sid) throw new Error('No active session')
      } else {
        const scopeLabel = scope === 'staged' ? 'staged' : scope === 'commits' ? 'commits' : 'working'
        const session = await api.createSession(workspaceId, {
          name: `Review · ${scopeLabel}${agentSkill ? ` · /${agentSkill}` : ''}`,
          purpose: 'Code review',
          cli_type: reviewCliType,
          model: getRoleDefaultModel(reviewCliType, 'worker'),
          permission_mode: getDefaultPermissionMode(reviewCliType),
        })
        sid = session.id
        const ids = [...agentGuidelineIds]
        if (ids.length > 0) {
          try { await api.setSessionGuidelines(session.id, ids) } catch {}
        }
        useStore.getState().addSession(session)
        // Let the PTY come up before pasting a 100KB prompt
        await useStore.getState().ensureSessionRunning(sid)
      }

      sendTerminalCommand(sid, prompt)
      setAgentModalOpen(false)
    } catch (e) {
      setAgentError(e.message || 'Failed to spawn review agent')
    } finally {
      setAgentBusy(false)
    }
  }

  const handleSaveAgentPrompt = () => {
    api.setAppSetting('code_review_agent_prompt', agentPrompt).catch(() => {})
  }
  const handleResetAgentPrompt = () => {
    setAgentPrompt(DEFAULT_AGENT_PROMPT)
    api.setAppSetting('code_review_agent_prompt', DEFAULT_AGENT_PROMPT).catch(() => {})
  }

  const toggleAgentGuideline = (id) => {
    setAgentGuidelineIds((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
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
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-x-scrim backdrop-blur-[4px]">
        <div className="x-panel scale-in p-8 text-center max-w-sm">
          <AlertTriangle size={24} className="text-x-accent-ink mx-auto mb-3" />
          <p className="text-x-ink-secondary text-sm">No workspace selected</p>
          <button onClick={onClose} className="mt-4 px-4 py-1.5 text-xs font-mono text-x-ink-secondary hover:text-x-ink bg-x-surface border border-x-line rounded">Close</button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-x-scrim backdrop-blur-[4px]" onClick={onClose}>
      <div
        className="relative w-full max-w-[1300px] h-[calc(100vh-60px)] x-panel flex flex-col scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-center gap-3 px-5 py-2.5 border-b border-x-line shrink-0">
          <GitCompareArrows size={16} className="text-x-accent" />
          <span className="text-[13px] font-semibold text-x-ink">Code Review</span>
          {workspace && (
            <span className="text-[11px] font-mono text-x-faint truncate max-w-[200px]">{workspace.name || workspace.path}</span>
          )}

          {/* Scope tabs */}
          <div className="flex items-center gap-0.5 ml-3 bg-x-surface-2 rounded p-0.5">
            {['working', 'staged', 'commits'].map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`px-2.5 py-1 rounded text-[11px] font-mono transition-colors ${
                  scope === s ? 'bg-x-tint text-x-ink' : 'text-x-muted hover:text-x-ink-secondary'
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
              className="px-2 py-1 text-[11px] font-mono bg-x-surface-2 border border-x-line rounded text-x-ink-secondary focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
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
            <span className="text-[11px] text-x-accent font-mono">
              {selected.size} selected &middot; {groups.length} group{groups.length !== 1 ? 's' : ''}
            </span>
          )}
          <button
            onClick={handleSelectAllChanges}
            className="flex items-center gap-1 text-[11px] text-x-muted hover:text-x-ink-secondary font-mono"
            title="Select every +/- line in the diff"
          >
            <CheckSquare size={10} /> select all
          </button>
          {selected.size > 0 && (
            <button onClick={clearAnnotations} className="text-[11px] text-x-muted hover:text-x-ink-secondary font-mono">clear</button>
          )}

          {totalChanges > 0 && (
            <span className="text-[11px] font-mono text-x-muted">
              {totalChanges} file{totalChanges !== 1 ? 's' : ''}
            </span>
          )}

          {/* Search toggle */}
          <button
            onClick={() => { setSearchVisible((s) => !s); requestAnimationFrame(() => searchInputRef.current?.focus()) }}
            className={`p-1.5 rounded transition-colors ${searchVisible ? 'text-x-accent bg-x-accent/10' : 'text-x-muted hover:text-x-ink-secondary'}`}
            title="Search (Cmd+F)"
          >
            <Search size={13} />
          </button>

          {/* IDE config */}
          <div className="relative">
            <button
              onClick={() => setShowIdeConfig((s) => !s)}
              className={`p-1.5 rounded transition-colors ${showIdeConfig ? 'text-x-accent bg-x-accent/10' : 'text-x-faint hover:text-x-ink-secondary'}`}
              title={`IDE: ${ideName}`}
            >
              <Settings2 size={13} />
            </button>
            {showIdeConfig && (
              <div className="absolute right-0 top-full mt-1 z-10 x-panel p-3 w-[200px]" onClick={(e) => e.stopPropagation()}>
                <div className="text-[11px] font-mono uppercase text-x-faint mb-2">Default IDE</div>
                {IDE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => { handleIdeChange(opt.value); setShowIdeConfig(false) }}
                    className={`w-full text-left px-2 py-1.5 text-[11px] font-mono rounded transition-colors ${
                      ide === opt.value ? 'bg-x-accent/10 text-x-accent' : 'text-x-ink-secondary hover:bg-x-hover'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button onClick={handleRefresh} className="p-1.5 text-x-muted hover:text-x-ink-secondary rounded transition-colors" title="Refresh">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
          <button onClick={onClose} className="p-1.5 text-x-muted hover:text-x-ink-secondary rounded transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* ── Search bar ── */}
        {searchVisible && (
          <div className="flex items-center gap-2 px-5 py-2 border-b border-x-line bg-x-surface shrink-0">
            <Search size={12} className="text-x-muted" />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setCurrentMatch(0) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.shiftKey ? prevMatch() : nextMatch() }
                if (e.key === 'Escape') { e.stopPropagation(); setSearchVisible(false); setSearchQuery('') }
              }}
              placeholder="Search in diff..."
              className="flex-1 px-2 py-1 text-[11px] font-mono bg-transparent text-x-ink-secondary placeholder-x-muted focus:outline-none"
              autoFocus
            />
            {searchQuery && (
              <>
                <span className="text-[11px] font-mono text-x-muted">
                  {searchMatches.length > 0 ? `${currentMatch + 1}/${searchMatches.length}` : 'No matches'}
                </span>
                <button onClick={prevMatch} disabled={!searchMatches.length} className="text-x-muted hover:text-x-ink-secondary disabled:opacity-30 text-xs">&uarr;</button>
                <button onClick={nextMatch} disabled={!searchMatches.length} className="text-x-muted hover:text-x-ink-secondary disabled:opacity-30 text-xs">&darr;</button>
              </>
            )}
            <button onClick={() => { setSearchVisible(false); setSearchQuery('') }} className="text-x-muted hover:text-x-ink-secondary">
              <X size={12} />
            </button>
          </div>
        )}

        {/* ── Body ── */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* ── File tree (left sidebar) ── */}
          <div className="w-[260px] shrink-0 border-r border-x-line overflow-y-auto">
            <button
              onClick={() => setSelectedFile(null)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-[11px] font-mono transition-colors ${
                selectedFile === null ? 'bg-x-accent/10 text-x-accent' : 'text-x-muted hover:bg-x-hover'
              }`}
            >
              <Files size={13} />
              All Files
            </button>

            {error && status && !status.is_git_repo ? (
              <div className="px-3 py-4 text-center">
                <AlertTriangle size={16} className="text-x-accent-ink mx-auto mb-2" />
                <p className="text-[11px] text-x-muted">Not a git repository</p>
              </div>
            ) : (
              <>
                {scope === 'staged' && status?.staged?.length > 0 && (
                  <FileSection
                    label="Staged" color="text-x-good" files={status.staged}
                    expanded={expandedSections.staged} onToggle={() => toggleSection('staged')}
                    selectedFile={selectedFile} onSelect={setSelectedFile}
                    onOpenInIde={handleOpenInIde} expandedDirs={expandedDirs} onToggleDir={toggleDir}
                  />
                )}

                {scope === 'working' && status?.unstaged?.length > 0 && (
                  <FileSection
                    label="Unstaged" color="text-x-accent-ink" files={status.unstaged}
                    expanded={expandedSections.unstaged} onToggle={() => toggleSection('unstaged')}
                    selectedFile={selectedFile} onSelect={setSelectedFile}
                    onOpenInIde={handleOpenInIde} expandedDirs={expandedDirs} onToggleDir={toggleDir}
                  />
                )}

                {scope === 'working' && status?.untracked?.length > 0 && (
                  <FileSection
                    label="Untracked" color="text-x-muted"
                    files={status.untracked.map((f) => ({ ...f, status: '?' }))}
                    expanded={expandedSections.untracked} onToggle={() => toggleSection('untracked')}
                    selectedFile={selectedFile} onSelect={setSelectedFile}
                    onOpenInIde={handleOpenInIde} expandedDirs={expandedDirs} onToggleDir={toggleDir}
                  />
                )}

                {scope === 'commits' && commits.length > 0 && (
                  <div className="mt-2 border-t border-x-line">
                    <div className="px-3 py-1.5 text-[11px] font-mono uppercase text-x-muted">Recent Commits</div>
                    {commits.slice(0, 10).map((c) => (
                      <div key={c.hash} className="px-3 py-1 text-[11px] font-mono text-x-muted truncate" title={c.message}>
                        <GitCommitVertical size={10} className="inline mr-1 text-x-faint" />
                        <span className="text-x-muted">{c.short_hash}</span> {c.message}
                      </div>
                    ))}
                  </div>
                )}

                {status && !status.staged?.length && !status.unstaged?.length && !status.untracked?.length && scope !== 'commits' && (
                  <div className="px-3 py-8 text-center">
                    <Check size={16} className="text-x-good mx-auto mb-2" />
                    <p className="text-[11px] text-x-muted">Working tree clean</p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── Diff view with annotations ── */}
          <div ref={diffListRef} className="flex-1 overflow-y-auto bg-x-surface-2 font-mono text-xs">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 size={20} className="text-x-muted animate-spin" />
              </div>
            ) : error && (!status || !status.is_git_repo) ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <AlertTriangle size={24} className="text-x-accent-ink mx-auto mb-3" />
                  <p className="text-x-muted text-sm">{error}</p>
                </div>
              </div>
            ) : !diffText ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-x-faint text-sm font-mono">No changes to display</p>
              </div>
            ) : (
              <div className="min-w-0">
                {truncated && (
                  <div className="px-4 py-2 bg-x-accent-ink/20 border-b border-x-accent-ink/20 text-x-accent-ink text-[11px] font-mono">
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
                        onMouseDown={handleLineMouseDown}
                        onMouseEnter={handleLineMouseEnter}
                        onHeaderClick={handleHeaderClick}
                        onRemoveGroup={removeGroup}
                        onOpenInIde={handleOpenInIde}
                        searchQuery={searchQuery}
                      />
                      {/* Comment input after last line of each group */}
                      {commentForGroup != null && (
                        <div className="flex items-start ml-[72px] mr-4 my-1 pl-3 pr-2 py-1.5 bg-x-accent-ink/8 border border-x-accent-ink/20 rounded-md">
                          <span className="text-x-accent-ink text-[11px] font-semibold shrink-0 pt-0.5 mr-2">{'\u2192'}</span>
                          <textarea
                            ref={(el) => { if (el) commentRefs.current[groupEndKey] = el }}
                            value={commentForGroup}
                            onChange={(e) => setComment(groupEndKey, e.target.value)}
                            placeholder="your comment..."
                            className="flex-1 bg-transparent text-x-accent-ink/90 text-xs font-mono resize-none focus:outline-none placeholder:text-x-accent-ink/30 min-h-[22px]"
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
          <div className="border-t border-x-line bg-x-surface px-5 py-3 shrink-0">
            <div className="flex items-center gap-2 mb-2">
              <Edit3 size={12} className="text-x-muted" />
              <span className="text-[11px] font-mono text-x-muted">Review Prompt Template</span>
              <span className="text-[11px] font-mono text-x-faint">Use {'{diff}'} and {'{annotations}'} as placeholders</span>
              <div className="flex-1" />
              <button onClick={handleSavePrompt} className="flex items-center gap-1 px-2 py-1 text-[11px] font-mono text-x-muted hover:text-x-ink bg-transparent hover:bg-x-hover rounded transition-colors" title="Save as default">
                <Save size={10} /> Save
              </button>
              <button onClick={handleResetPrompt} className="flex items-center gap-1 px-2 py-1 text-[11px] font-mono text-x-muted hover:text-x-ink bg-transparent hover:bg-x-hover rounded transition-colors" title="Reset to default">
                <RotateCcw size={10} /> Reset
              </button>
            </div>
            <textarea
              value={promptTemplate}
              onChange={(e) => setPromptTemplate(e.target.value)}
              className="w-full h-[100px] px-3 py-2 text-[11px] font-mono bg-x-surface-2 border border-x-line rounded text-x-ink-secondary resize-y focus:outline-none focus:border-x-accent"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}

        {/* ── Footer ── */}
        <div className="flex items-center gap-2 px-5 py-2.5 border-t border-x-line shrink-0">
          {selectedFile && (
            <button
              onClick={() => handleOpenInIde(selectedFile)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono rounded transition-colors bg-transparent hover:bg-x-hover text-x-ink-secondary border border-x-line hover:border-x-line-strong"
            >
              <ExternalLink size={11} />
              Open in {ideName}
            </button>
          )}

          <button
            onClick={() => setShowPromptEditor((s) => !s)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono rounded transition-colors border ${
              showPromptEditor ? 'bg-x-accent/10 text-x-accent border-x-accent/30' : 'bg-transparent hover:bg-x-hover text-x-muted border-x-line hover:border-x-line-strong'
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
                ? 'bg-x-good/20 text-x-good border border-x-good/30'
                : diffText
                  ? 'bg-x-accent/20 hover:bg-x-accent/30 text-x-accent border border-x-accent/30'
                  : 'bg-x-hover text-x-faint border border-x-line cursor-not-allowed'
            }`}
          >
            {sent ? <Check size={11} /> : <Send size={11} />}
            {sent ? 'Sent!' : groups.length > 0 ? `Send Review (${groups.length} annotations)` : 'Send to Claude'}
          </button>

          <button
            onClick={() => setAgentModalOpen(true)}
            disabled={!diffText}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono rounded transition-colors border ${
              diffText
                ? 'bg-x-accent/15 hover:bg-x-accent/25 text-x-accent border-x-accent/30'
                : 'bg-x-hover text-x-faint border-x-line cursor-not-allowed'
            }`}
            title="Spawn a fresh agent to review the diff (optionally with a skill + guidelines)"
          >
            <Bot size={11} />
            Review with Agent
          </button>

          {workspaceSessions.length > 1 && (
            <select
              value={targetSessionId || ''}
              onChange={(e) => setTargetSessionId(e.target.value)}
              className="px-2 py-1.5 text-[11px] font-mono bg-x-surface-2 border border-x-line rounded text-x-ink-secondary focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
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
          <div className="flex items-center gap-3 text-[11px] text-x-faint font-mono">
            <span>Drag to select</span>
            <span>Shift+click range</span>
            <span>Click hunk/file header</span>
            <span>{'\u2318\u21B5'} send</span>
            <span>Esc close</span>
          </div>
        </div>

        {/* \u2500\u2500 Review-with-Agent modal \u2500\u2500 */}
        {agentModalOpen && (
          <AgentReviewModal
            onClose={() => setAgentModalOpen(false)}
            prompt={agentPrompt}
            setPrompt={setAgentPrompt}
            onSavePrompt={handleSaveAgentPrompt}
            onResetPrompt={handleResetAgentPrompt}
            skill={agentSkill}
            setSkill={setAgentSkill}
            skills={availableSkills}
            guidelines={availableGuidelines}
            selectedGuidelineIds={agentGuidelineIds}
            onToggleGuideline={toggleAgentGuideline}
            mode={agentMode}
            setMode={setAgentMode}
            busy={agentBusy}
            error={agentError}
            onSubmit={handleSpawnAgent}
            annotationsCount={groups.length}
            diffSize={diffText.length}
            sessions={workspaceSessions}
            targetSessionId={targetSessionId}
            setTargetSessionId={setTargetSessionId}
            activeSessionId={activeSessionId}
            configuredProvider={configuredReviewProvider}
            resolvedCliType={reviewCliType}
          />
        )}
      </div>
    </div>
  )
}

// \u2500\u2500 Agent Review Modal \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function AgentReviewModal({
  onClose, prompt, setPrompt, onSavePrompt, onResetPrompt,
  skill, setSkill, skills, guidelines, selectedGuidelineIds, onToggleGuideline,
  mode, setMode, busy, error, onSubmit, annotationsCount, diffSize,
  sessions, targetSessionId, setTargetSessionId, activeSessionId,
  configuredProvider, resolvedCliType,
}) {
  const providerText = configuredProvider === 'active'
    ? `${reviewProviderLabel(configuredProvider)} -> ${reviewProviderLabel(resolvedCliType)}`
    : reviewProviderLabel(resolvedCliType)

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-x-scrim backdrop-blur-[4px]"
      onClick={onClose}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="w-[640px] max-h-[85%] flex flex-col x-panel scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-x-line shrink-0">
          <Sparkles size={14} className="text-x-accent" />
          <span className="text-[13px] font-semibold text-x-ink">Review with Agent</span>
          <span className="text-[11px] font-mono text-x-faint">
            {(diffSize / 1024).toFixed(1)}KB diff
            {annotationsCount > 0 ? ` \u00B7 ${annotationsCount} annotation${annotationsCount !== 1 ? 's' : ''}` : ''}
            {` \u00B7 ${providerText}`}
          </span>
          <div className="flex-1" />
          <button onClick={onClose} className="p-1 text-x-faint hover:text-x-ink-secondary rounded">
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-4">
          {/* Mode */}
          <div>
            <div className="text-[11px] font-mono uppercase text-x-muted mb-1.5">Destination</div>
            <div className="flex gap-1.5">
              <button
                onClick={() => setMode('new')}
                className={`flex-1 px-3 py-2 text-[11px] font-mono rounded border transition-colors ${
                  mode === 'new'
                    ? 'bg-x-accent/15 text-x-accent border-x-accent/30'
                    : 'bg-x-surface-2 text-x-muted border-x-line hover:text-x-ink-secondary'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <Bot size={11} /> New session
                </div>
                <div className="text-[11px] text-x-muted mt-0.5 font-normal truncate">Fresh agent via {providerText}</div>
              </button>
              <button
                onClick={() => setMode('current')}
                disabled={!activeSessionId}
                className={`flex-1 px-3 py-2 text-[11px] font-mono rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  mode === 'current'
                    ? 'bg-x-accent/15 text-x-accent border-x-accent/30'
                    : 'bg-x-surface-2 text-x-muted border-x-line hover:text-x-ink-secondary'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <Send size={11} /> Existing session
                </div>
                <div className="text-[11px] text-x-muted mt-0.5 font-normal">Hand off to a session you already have</div>
              </button>
            </div>
            {mode === 'current' && sessions.length > 1 && (
              <select
                value={targetSessionId || ''}
                onChange={(e) => setTargetSessionId(e.target.value)}
                className="mt-2 w-full px-2 py-1.5 text-[11px] font-mono bg-x-surface-2 border border-x-line rounded text-x-ink-secondary focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || `Session ${s.id.slice(0, 6)}`}{s.id === activeSessionId ? ' (active)' : ''}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Skill */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <div className="text-[11px] font-mono uppercase text-x-muted">Skill</div>
              <span className="text-[11px] font-mono text-x-faint">Prepends /&lt;skill&gt; to the prompt</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setSkill('')}
                className={`px-2 py-1 text-[11px] font-mono rounded border transition-colors ${
                  skill === '' ? 'bg-x-hover text-x-ink border-x-line-strong' : 'bg-x-surface-2 text-x-muted border-x-line hover:text-x-ink-secondary'
                }`}
              >
                none
              </button>
              {skills.map((s) => (
                <button
                  key={s}
                  onClick={() => setSkill(s)}
                  className={`px-2 py-1 text-[11px] font-mono rounded border transition-colors ${
                    skill === s ? 'bg-x-accent/15 text-x-accent border-x-accent/30' : 'bg-x-surface-2 text-x-muted border-x-line hover:text-x-ink-secondary'
                  }`}
                >
                  /{s}
                </button>
              ))}
            </div>
          </div>

          {/* Guidelines (only when spawning a new session \u2014 existing sessions already have their own) */}
          {mode === 'new' && guidelines.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <Shield size={11} className="text-x-good" />
                <div className="text-[11px] font-mono uppercase text-x-muted">Guidelines</div>
                {selectedGuidelineIds.size > 0 && (
                  <span className="text-[11px] font-mono text-x-good">
                    {selectedGuidelineIds.size} attached
                  </span>
                )}
              </div>
              <div className="max-h-[120px] overflow-y-auto space-y-0.5 bg-x-surface-2 border border-x-line rounded p-1.5">
                {guidelines.map((g) => {
                  const on = selectedGuidelineIds.has(g.id)
                  return (
                    <button
                      key={g.id}
                      onClick={() => onToggleGuideline(g.id)}
                      className={`w-full flex items-center gap-2 px-2 py-1 text-[11px] font-mono rounded transition-colors ${
                        on ? 'bg-x-good/10 text-x-good' : 'text-x-muted hover:bg-x-hover'
                      }`}
                    >
                      <span className={`w-3 h-3 rounded border flex items-center justify-center ${
                        on ? 'bg-x-good/20 border-x-good/40' : 'border-x-line'
                      }`}>
                        {on && <Check size={8} className="text-x-good" />}
                      </span>
                      <span className="truncate">{g.name}</span>
                      {g.is_default ? <span className="ml-auto text-[11px] text-x-good/70">default</span> : null}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Prompt */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <Edit3 size={11} className="text-x-muted" />
              <div className="text-[11px] font-mono uppercase text-x-muted">Agent Prompt</div>
              <span className="text-[11px] font-mono text-x-faint">Placeholders: {'{diff}'} {'{annotations}'}</span>
              <div className="flex-1" />
              <button onClick={onSavePrompt} className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono text-x-muted hover:text-x-ink bg-transparent hover:bg-x-hover rounded transition-colors">
                <Save size={9} /> Save
              </button>
              <button onClick={onResetPrompt} className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono text-x-muted hover:text-x-ink bg-transparent hover:bg-x-hover rounded transition-colors">
                <RotateCcw size={9} /> Reset
              </button>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full h-[160px] px-3 py-2 text-[11px] font-mono bg-x-surface-2 border border-x-line rounded text-x-ink-secondary resize-y focus:outline-none focus:border-x-accent"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 px-3 py-2 bg-x-accent-ink/10 border border-x-accent-ink/30 rounded text-[11px] font-mono text-x-accent-ink">
              <AlertTriangle size={12} /> {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-3 border-t border-x-line shrink-0">
          <div className="text-[11px] font-mono text-x-faint">
            {mode === 'new' ? 'Will create a new session in this workspace' : 'Will send the prompt to the selected session'}
          </div>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-[11px] font-mono text-x-muted hover:text-x-ink bg-transparent hover:bg-x-hover rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={busy}
            className={`flex items-center gap-1.5 px-4 py-1.5 text-[11px] font-mono rounded border transition-colors ${
              busy
                ? 'bg-x-surface-2 text-x-muted border-x-line cursor-not-allowed'
                : 'bg-x-accent/20 hover:bg-x-accent/30 text-x-accent border-x-accent/30'
            }`}
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Bot size={11} />}
            {busy ? 'Spawning\u2026' : mode === 'new' ? 'Spawn Agent' : 'Send to Session'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Annotated Diff Line ─────────────────────────────────────────

function AnnotatedDiffLine({ line, idx, isSel, isSearchMatch, isCurrentSearchMatch, groupAtStart, onMouseDown, onMouseEnter, onHeaderClick, onRemoveGroup, onOpenInIde, searchQuery }) {
  const bgCls = {
    'file-header': 'bg-x-hover',
    'hunk-header': 'bg-x-accent/10',
    'add': 'bg-x-good/20',
    'remove': 'bg-x-accent-ink/15',
    'context': '',
    'info': '',
  }[line.type] || ''

  const isCodeLine = line.type !== 'file-header' && line.type !== 'info'
  const isFileHeader = line.type === 'file-header' && line.text.startsWith('diff --git')
  const isHunkHeader = line.type === 'hunk-header'
  const headerClickable = isFileHeader || isHunkHeader
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
      className={`flex items-start transition-colors border-l-2 select-none ${
        isSel
          ? 'bg-x-accent/10 border-l-x-accent'
          : isCurrentSearchMatch
            ? 'bg-x-accent-ink/15 border-l-warn'
            : isSearchMatch
              ? 'bg-x-accent-ink/5 border-l-warn/50'
              : `${bgCls} border-l-transparent ${isCodeLine || headerClickable ? 'hover:bg-x-hover cursor-pointer' : ''}`
      }`}
      onMouseDown={isCodeLine ? (e) => onMouseDown(idx, e) : headerClickable ? (e) => { e.preventDefault(); onHeaderClick(idx) } : undefined}
      onMouseEnter={isCodeLine ? () => onMouseEnter(idx) : undefined}
      title={isFileHeader ? 'Click to select all changes in this file' : isHunkHeader ? 'Click to select this hunk' : undefined}
    >
      {/* Gutter: line numbers */}
      <span className="w-[28px] shrink-0 text-right pr-1 py-px select-none text-x-faint text-[11px] leading-[18px] tabular-nums">
        {line.type === 'remove' ? line.lineOld : line.type === 'context' ? line.lineOld : ''}
      </span>
      <span className="w-[28px] shrink-0 text-right pr-1 py-px select-none text-x-faint text-[11px] leading-[18px] tabular-nums">
        {line.type === 'add' ? line.lineNew : line.type === 'context' ? line.lineNew : ''}
      </span>

      {/* Selection indicator */}
      <span className={`w-3 shrink-0 py-px text-center text-[11px] leading-[18px] ${
        isSel ? 'text-x-accent' : 'text-transparent'
      }`}>
        {isSel ? '\u25A0' : '\u00B7'}
      </span>

      {/* Diff prefix (+/-/space) */}
      {(line.type === 'add' || line.type === 'remove' || line.type === 'context') && (
        <span className={`w-3 shrink-0 py-px text-center leading-[18px] ${
          line.type === 'add' ? 'text-x-good' : line.type === 'remove' ? 'text-x-accent-ink' : 'text-x-faint'
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
            line.type === 'file-header' ? 'text-x-ink font-semibold' :
            line.type === 'hunk-header' ? 'text-x-accent' :
            'text-x-muted italic'
          }>
            {searchQuery ? highlightSearch(line.text, searchQuery) : line.text}
          </span>
        )}
      </span>

      {/* Open in IDE on file headers */}
      {isFileHeader && line.file && (
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onOpenInIde(line.file) }}
          className="shrink-0 px-2 py-px text-x-faint hover:text-x-ink-secondary transition-colors"
          title={`Open ${line.file} in IDE`}
        >
          <ExternalLink size={11} />
        </button>
      )}

      {/* X to remove group */}
      {groupAtStart ? (
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onRemoveGroup(groupAtStart) }}
          className="shrink-0 w-5 h-[18px] flex items-center justify-center text-x-accent/60 hover:text-x-accent-ink hover:bg-x-accent-ink/10 rounded transition-colors mr-1"
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
    parts.push(<mark key={`m${pos}`} className="bg-x-accent-ink/30 text-inherit rounded-sm">{text.slice(pos, pos + q.length)}</mark>)
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
        className={`w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono uppercase ${color} hover:bg-x-hover`}
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
                  className="w-full flex items-center gap-1.5 px-3 pl-5 py-0.5 text-[11px] font-mono text-x-muted hover:bg-x-hover"
                >
                  {isExpanded ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
                  <FolderOpen size={11} className="text-x-faint" />
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
      selected ? 'bg-x-accent/10' : 'hover:bg-x-hover'
    }`}>
      <button
        onClick={onClick}
        className={`flex-1 flex items-center gap-2 py-1 truncate ${indent ? 'pl-10' : 'px-3 pl-5'} ${
          selected ? 'text-x-accent' : 'text-x-muted'
        }`}
        title={file.path}
      >
        <FileIcon status={file.status} />
        <span className="truncate">{filename}</span>
        <span className="ml-auto text-[11px] text-x-faint shrink-0">{STATUS_LABELS[file.status] || file.status}</span>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onOpenInIde() }}
        className="hidden group-hover:flex items-center px-2 py-1 text-x-faint hover:text-x-ink-secondary transition-colors"
        title="Open in IDE"
      >
        <ExternalLink size={11} />
      </button>
    </div>
  )
}
