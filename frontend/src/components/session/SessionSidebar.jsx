import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  Files, FileText, ChevronRight, ChevronDown, GitCompareArrows, RefreshCw,
  Send, FileEdit, FilePlus, FileMinus, FileQuestion, Loader2, AlertTriangle,
  Check, ExternalLink, Search, FolderOpen, Edit3, Save, RotateCcw, Eye, Trash2, X, Copy,
  Bot, Maximize2, Minimize2, ChevronUp, ArrowRight
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import useStore from '../../state/store'
import { api } from '../../lib/api'
import { sendPlanChoice, sendPlanFeedback, sendTerminalCommand } from '../../lib/terminal'
import { parseDiffLines } from '../../lib/diffParser'
import { detectLang, tokenizeLinePrism, TOKEN_CLASSES_PRISM } from '../../lib/syntaxHighlightPrism'
import { getCliLabel, getRoleDefaultModel, getDefaultPermissionMode } from '../../lib/constants'
import Scratchpad from './Scratchpad'
import MermaidBlock from './MermaidBlock'
import { addRecentAnnotations } from '../../lib/annotations'
import { Button } from '../ui'

const STATUS_LABELS = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', '?': 'Untracked' }
const STATUS_ICONS = { M: FileEdit, A: FilePlus, D: FileMinus, '?': FileQuestion }
const DEFAULT_REVIEW_AGENT_PROMPT = `Act as a careful code reviewer. Walk the diff, flag bugs, security issues, regressions, dead code, and unclear naming. Quote the offending lines and propose concrete fixes. Be terse; skip what already looks correct.

{annotations}

\`\`\`diff
{diff}
\`\`\``

// Prism's tokenizer emits a much richer set of token types (function,
// class-name, variable, parameter, attr-name, ...). The class map lives in
// syntaxHighlightPrism so it can be shared with future viewers. Aliasing
// here keeps existing references happy.
const TOKEN_CLASSES = TOKEN_CLASSES_PRISM

function FileIcon({ status }) {
  const Icon = STATUS_ICONS[status] || FileEdit
  const color = status === 'A' || status === '?' ? 'text-x-good'
    : status === 'D' ? 'text-x-accent-ink'
    : 'text-x-accent-ink'
  return <Icon size={13} className={color} />
}

// Two-level tree grouping (directory → files). Mirrors the full panel's
// buildFileTree so the sidebar lays files out the same way.
function buildSidebarFileTree(files) {
  const dirs = {}
  const root = []
  for (const f of files) {
    const slash = f.path.lastIndexOf('/')
    if (slash === -1) {
      root.push(f)
    } else {
      const dir = f.path.slice(0, slash)
      if (!dirs[dir]) dirs[dir] = []
      dirs[dir].push(f)
    }
  }
  const sortedDirs = Object.keys(dirs).sort()
  return {
    dirs: sortedDirs.map((d) => ({ dir: d, files: dirs[d] })),
    rootFiles: root,
  }
}

function filterReviewFiles(files = [], query = '') {
  const q = query.trim().toLowerCase()
  if (!q) return files
  return files.filter((f) => `${f.path} ${f.status || ''}`.toLowerCase().includes(q))
}

function alignDiffLines(parsedDiff) {
  const rows = [];
  let i = 0;
  while (i < parsedDiff.length) {
    const line = parsedDiff[i];
    if (line.type === 'file-header' || line.type === 'hunk-header') {
      rows.push({ type: 'header', line, idx: i });
      i++;
      continue;
    }

    const deletes = [];
    const inserts = [];
    while (i < parsedDiff.length) {
      const nextLine = parsedDiff[i];
      if (nextLine.type === 'remove') {
        deletes.push({ line: nextLine, idx: i });
        i++;
      } else if (nextLine.type === 'add') {
        inserts.push({ line: nextLine, idx: i });
        i++;
      } else {
        break;
      }
    }

    if (deletes.length > 0 || inserts.length > 0) {
      const maxLen = Math.max(deletes.length, inserts.length);
      for (let j = 0; j < maxLen; j++) {
        rows.push({
          type: 'code',
          left: deletes[j] || null,
          right: inserts[j] || null
        });
      }
      continue;
    }

    rows.push({
      type: 'code',
      left: { line, idx: i },
      right: { line, idx: i }
    });
    i++;
  }
  return rows;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function renderDiffTextWithSearch(text, query) {
  const q = query.trim()
  if (!q) return text
  const re = new RegExp(`(${escapeRegExp(q)})`, 'ig')
  return text.split(re).map((part, i) => (
    part.toLowerCase() === q.toLowerCase()
      ? <mark key={i} className="rounded bg-x-accent-ink/20 px-0.5 text-x-ink">{part}</mark>
      : part
  ))
}

// Syntax-highlight diff lines + apply the in-diff search highlight on top.
// Uses Prism via tokenizeLinePrism (with regex-tokenizer fallback baked in).
// `filePath` is forwarded so Prism can pick the precise grammar — e.g. tsx vs
// ts vs js — instead of the regex tokenizer's coarse "js" bucket.
function renderDiffLineWithSyntax(text, lang, query, filePath = null) {
  if (!lang) return renderDiffTextWithSearch(text, query)
  let tokens
  try { tokens = tokenizeLinePrism(text, lang, filePath) } catch { return renderDiffTextWithSearch(text, query) }
  if (!tokens || tokens.length === 0) return renderDiffTextWithSearch(text, query)
  const q = (query || '').trim()
  const re = q ? new RegExp(`(${escapeRegExp(q)})`, 'ig') : null
  return tokens.map((tok, ti) => {
    const cls = TOKEN_CLASSES[tok.type] || TOKEN_CLASSES.default
    if (!re) return <span key={ti} className={cls}>{tok.text}</span>
    const parts = tok.text.split(re).map((part, pi) => (
      part.toLowerCase() === q.toLowerCase()
        ? <mark key={pi} className="rounded bg-x-accent-ink/20 px-0.5 text-x-ink">{part}</mark>
        : part
    ))
    return <span key={ti} className={cls}>{parts}</span>
  })
}

function resolveReviewCliType(workspace, activeSession) {
  const configured = workspace?.review_provider || 'active'
  if (configured && configured !== 'active') return configured
  return activeSession?.cli_type || 'claude'
}

function reviewProviderLabel(value) {
  if (!value || value === 'active') return 'Active session CLI'
  return getCliLabel(value)
}

export default function SessionSidebar({ sessionId, initialFile = null, initialTab = 'files', onClose, onAnnotateImage, onTabChange }) {
  const activeSessionId = useStore((s) => s.activeSessionId)
  const sessions = useStore((s) => s.sessions)
  const workspaces = useStore((s) => s.workspaces)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const planFilePaths = useStore((s) => s.planFilePaths)
  const allPlanFiles = useStore((s) => s.allPlanFiles)
  const planWaiting = useStore((s) => s.planWaiting)
  const tasks = useStore((s) => s.tasks)

  const activeSession = sessions[sessionId] || sessions[activeSessionId]
  const workspaceId = activeSession?.workspace_id || activeWorkspaceId || workspaces[0]?.id
  const workspace = workspaces.find((w) => w.id === workspaceId)
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
  const reviewCliType = resolveReviewCliType(workspace, activeSession)
  const configuredReviewProvider = workspace?.review_provider || 'active'

  // ── Tabs ──
  const [activeTab, setActiveTab] = useState(initialTab) // 'files' | 'review' | 'scratchpad'

  useEffect(() => {
    setActiveTab(initialTab)
  }, [initialTab])

  const selectTab = useCallback((tab) => {
    setActiveTab(tab)
    onTabChange?.(tab)
  }, [onTabChange])

  // ── Section Collapses ──
  const [expandedSections, setExpandedSections] = useState({
    plans: true,
    touched: true,
    uploads: true,
  })

  // ── Files & Plans lists data ──
  const [touchedFiles, setTouchedFiles] = useState([])
  const [attachments, setAttachments] = useState([])
  const [plans, setPlans] = useState([])
  const [selectedPlan, setSelectedPlan] = useState(null) // { path, sid, name, status }
  const [planContent, setPlanContent] = useState('')
  const [planOriginal, setPlanOriginal] = useState('')
  const [planMode, setPlanMode] = useState('preview') // 'preview' | 'edit'
  const [planLoading, setPlanLoading] = useState(false)
  const [planFeedback, setPlanFeedback] = useState('')
  const [planSelection, setPlanSelection] = useState(null) // { text }
  const [planComment, setPlanComment] = useState('')

  // ── Code Review tab states ──
  const [gitScope, setGitScope] = useState('working')
  const [gitStatus, setGitStatus] = useState(null)
  const [gitSelectedFile, setGitSelectedFile] = useState(null)
  const [gitDiffText, setGitDiffText] = useState('')
  const [gitLoading, setGitLoading] = useState(false)
  const [gitError, setGitError] = useState(null)
  const [gitSearchQuery, setGitSearchQuery] = useState('')
  const [gitDiffSearchQuery, setGitDiffSearchQuery] = useState('')
  const [gitExpandedDirs, setGitExpandedDirs] = useState({})
  const diffViewportRef = useRef(null)

  // Code Review Line Annotations
  const [reviewSelectedLines, setReviewSelectedLines] = useState(new Set())
  const [reviewComments, setReviewComments] = useState({}) // groupFirstIdx -> text
  const [reviewLastClicked, setReviewLastClicked] = useState(null)
  const [reviewCopied, setReviewCopied] = useState(false)
  const [reviewMenuOpen, setReviewMenuOpen] = useState(false)
  const [reviewAgentOpen, setReviewAgentOpen] = useState(false)
  const [reviewAgentMode, setReviewAgentMode] = useState('new')
  const [reviewAgentPrompt, setReviewAgentPrompt] = useState(DEFAULT_REVIEW_AGENT_PROMPT)
  const [reviewAgentBusy, setReviewAgentBusy] = useState(false)
  const [reviewAgentError, setReviewAgentError] = useState(null)
  const [reviewAgentSaved, setReviewAgentSaved] = useState(false)
  const [reviewAgentTargetSessionId, setReviewAgentTargetSessionId] = useState(sessionId || activeSessionId || '')
  const reviewCommentRefs = useRef({})
  // Tree expand state: section labels ('Staged', 'Unstaged', 'Untracked') and
  // directory keys ('<section>-<dir>') -> bool. Default-true for sections; dirs
  // are open by default (we track only explicit collapses)
  const [gitExpandedSections, setGitExpandedSections] = useState({ staged: true, unstaged: true, untracked: true })
  const [isFullscreenDiff, setIsFullscreenDiff] = useState(false)

  // Persist the user's preferred open mode so ⌘⇧G / the top-bar review button
  // remembers whether to open the sidebar tab or jump straight to fullscreen.
  const setReviewOpenMode = useCallback((mode) => {
    try { localStorage.setItem('code_review_open_mode', mode) } catch {}
  }, [])

  // App-level openReviewForActiveSession dispatches this when the saved
  // preference is fullscreen — we honor it by entering fullscreen on mount.
  useEffect(() => {
    const onEnter = () => setIsFullscreenDiff(true)
    window.addEventListener('code-review:enter-fullscreen', onEnter)
    return () => window.removeEventListener('code-review:enter-fullscreen', onEnter)
  }, [])
  const [viewMode, setViewMode] = useState('split') // 'unified' | 'split'


  useEffect(() => {
    api.getAppSetting('code_review_agent_prompt').then((res) => {
      if (res?.value) setReviewAgentPrompt(res.value)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (reviewAgentTargetSessionId) return
    setReviewAgentTargetSessionId(sessionId || activeSessionId || '')
  }, [activeSessionId, reviewAgentTargetSessionId, sessionId])

  // Load files / attachments / plans
  const loadFilesAndPlans = useCallback(async () => {
    if (!sessionId) return
    
    // 1. Load Session Digest (Files Touched)
    try {
      const digest = await api.getSessionDigest(sessionId)
      if (digest?.files_touched) {
        setTouchedFiles(digest.files_touched)
      }
    } catch {}

    // 2. Load Attachments
    try {
      const atts = await api.listSessionAttachments(sessionId)
      if (Array.isArray(atts)) {
        setAttachments(atts)
      }
    } catch {}

    // 3. Load Plan Files
    try {
      const res = await api.listPlanFiles(workspaceId)
      if (res.plans) {
        const mapping = {}
        for (const p of res.plans) {
          if (p.session_id) mapping[p.session_id] = p.path
        }
        useStore.getState().setPlanFilePaths(mapping)
        useStore.getState().setAllPlanFiles(res.plans)
      }
    } catch {}
  }, [sessionId, workspaceId])

  // Poll attachments and files touched every 4s
  useEffect(() => {
    loadFilesAndPlans()
    const timer = setInterval(loadFilesAndPlans, 4000)
    return () => clearInterval(timer)
  }, [loadFilesAndPlans])

  // Get matched plans for this session
  const sessionPlanPath = planFilePaths[sessionId]
  const matchedPlans = Object.entries(planFilePaths)
    .filter(([sid]) => {
      const s = sessions[sid]
      return s && s.workspace_id === workspaceId
    })
    .map(([sid, path]) => {
      const s = sessions[sid]
      const slug = path.split('/').pop().replace('.md', '')
      return { sid, path, name: s?.name || sid.slice(0, 8), slug, status: s?.status }
    })

  const unmatchedPlans = allPlanFiles.filter((p) => !p.session_id && !p.sub_plan)

  const workspacePlans = [
    ...matchedPlans.sort((a, b) => (a.sid === sessionId ? -1 : b.sid === sessionId ? 1 : 0)),
    ...unmatchedPlans.map((p) => ({
      sid: null,
      path: p.path,
      name: p.filename.replace('.md', ''),
      slug: p.filename.replace('.md', ''),
      status: null,
    }))
  ]

  // Select Plan File and fetch details
  const handleSelectPlan = async (plan) => {
    setSelectedPlan(plan)
    setPlanSelection(null)
    setPlanComment('')
    setPlanLoading(true)
    setPlanContent('')
    try {
      const res = await api.getPlanFile(plan.path)
      setPlanContent(res.content || '')
      setPlanOriginal(res.content || '')
    } catch {}
    setPlanLoading(false)
  }

  const handleSavePlan = async () => {
    if (!selectedPlan || planContent === planOriginal) return
    try {
      await api.putPlanFile(selectedPlan.path, planContent)
      setPlanOriginal(planContent)
    } catch {}
  }

  const handlePlanApprove = () => {
    if (!selectedPlan?.sid) return
    sendPlanChoice(selectedPlan.sid, 1)
    
    // Resume planning task in progress
    const planTask = Object.values(tasks).find(
      (t) => t.assigned_session_id === selectedPlan.sid && t.status === 'planning'
    )
    if (planTask) {
      api.updateTask2(planTask.id, { status: 'in_progress' })
      useStore.getState().updateTaskInStore({ ...planTask, status: 'in_progress' })
    }
    setSelectedPlan(null)
  }

  const handleSendPlanFeedback = () => {
    if (!selectedPlan?.sid || !planFeedback.trim()) return
    sendPlanFeedback(selectedPlan.sid, planFeedback.trim())
    setPlanFeedback('')
    setSelectedPlan(null)
  }

  const handlePlanMouseUp = () => {
    const sel = window.getSelection()
    const text = sel?.toString().trim()
    if (sel && !sel.isCollapsed && text && text.length > 1) {
      setPlanSelection({ text })
      setPlanComment('')
    }
  }

  const handleSendPlanAnnotation = () => {
    if (!planSelection) return
    const targetSessionId = selectedPlan?.sid || sessionId || activeSessionId
    if (!targetSessionId) return
    
    const targetSession = sessions[targetSessionId]
    const workspaceId = targetSession?.workspace_id
    
    const newAnn = {
      id: `ann-${Date.now()}`,
      quote: planSelection.text,
      note: planComment.trim(),
      role: 'plan',
      roleLabel: selectedPlan?.name || 'plan',
      sourceLabel: 'plan',
    }
    
    // 1. Add to recent annotations in localStorage
    if (workspaceId) {
      addRecentAnnotations(workspaceId, newAnn, {
        sessionId: targetSessionId,
        sessionName: targetSession?.name || '',
      })
    }
    
    // 2. Dispatch custom event to let ChatPanel add it to active composer annotations
    window.dispatchEvent(new CustomEvent('cc-add-text-annotation', {
      detail: {
        sessionId: targetSessionId,
        annotation: newAnn
      }
    }))
    
    setPlanSelection(null)
    setPlanComment('')
    window.getSelection()?.removeAllRanges()
  }

  // ── Code Review (Git) Data fetching ──
  const fetchGitStatus = useCallback(async () => {
    if (!workspaceId) return
    try {
      const res = await api.getGitStatus(workspaceId)
      setGitStatus(res)
    } catch (e) {
      setGitError(e.message)
    }
  }, [workspaceId])

  const fetchGitDiff = useCallback(async () => {
    if (!workspaceId) return
    setGitLoading(true)
    try {
      const opts = {}
      if (gitScope === 'staged') opts.staged = true
      if (gitSelectedFile) opts.file = gitSelectedFile
      const res = await api.getGitDiff(workspaceId, opts)
      setGitDiffText(res.diff || '')
    } catch (e) {
      setGitDiffText('')
    }
    setGitLoading(false)
  }, [workspaceId, gitScope, gitSelectedFile])

  const handleStageFile = useCallback(async (filePath) => {
    if (!workspaceId) return
    try {
      await api.stageGitFile(workspaceId, filePath)
      await fetchGitStatus()
      await fetchGitDiff()
    } catch (e) {
      console.error('Failed to stage file:', e)
    }
  }, [workspaceId, fetchGitStatus, fetchGitDiff])

  const handleUnstageFile = useCallback(async (filePath) => {
    if (!workspaceId) return
    try {
      await api.unstageGitFile(workspaceId, filePath)
      await fetchGitStatus()
      await fetchGitDiff()
    } catch (e) {
      console.error('Failed to unstage file:', e)
    }
  }, [workspaceId, fetchGitStatus, fetchGitDiff])

  useEffect(() => {
    if (activeTab === 'review') {
      fetchGitStatus()
    }
  }, [activeTab, fetchGitStatus])

  useEffect(() => {
    if (activeTab === 'review') {
      fetchGitDiff()
    }
  }, [activeTab, gitScope, gitSelectedFile, fetchGitDiff])

  const handleOpenInIde = (filePath) => {
    if (!workspaceId || !filePath) return
    api.openInIde(workspaceId, filePath).catch(() => {})
  }

  // Parse diff and tag each line with the file it belongs to. The file is read
  // off the most-recent "diff --git ... b/<path>" header so syntax highlighting
  // can pick the right language even when the diff spans multiple files.
  const parsedDiff = useMemo(() => {
    const lines = parseDiffLines(gitDiffText)
    let currentFile = gitSelectedFile || null
    return lines.map((line) => {
      if (line.type === 'file-header' && line.text.startsWith('diff --git')) {
        const m = line.text.match(/b\/(.+)$/)
        if (m) currentFile = m[1]
      }
      return { ...line, file: currentFile }
    })
  }, [gitDiffText, gitSelectedFile])

  useEffect(() => { if (initialFile) setGitSelectedFile(initialFile) }, [initialFile])

  const gitFileBuckets = useMemo(() => {
    const staged = gitScope === 'staged'
      ? filterReviewFiles(gitStatus?.staged || [], gitSearchQuery)
      : []
    const unstaged = gitScope === 'working'
      ? filterReviewFiles(gitStatus?.unstaged || [], gitSearchQuery)
      : []
    const untracked = gitScope === 'working'
      ? filterReviewFiles((gitStatus?.untracked || []).map((f) => ({ ...f, status: '?' })), gitSearchQuery)
      : []
    return { staged, unstaged, untracked }
  }, [gitScope, gitSearchQuery, gitStatus])

  const gitVisibleFileCount = gitFileBuckets.staged.length + gitFileBuckets.unstaged.length + gitFileBuckets.untracked.length

  const handleSelectReviewFile = useCallback((path) => {
    setGitSelectedFile(path)
    setReviewSelectedLines(new Set())
    setReviewComments({})
    setReviewLastClicked(null)
    window.setTimeout(() => {
      diffViewportRef.current?.focus?.({ preventScroll: false })
      diffViewportRef.current?.scrollTo?.({ top: 0 })
    }, 80)
  }, [])

  useEffect(() => {
    if (activeTab !== 'review' || gitLoading || !gitDiffText) return
    const timer = window.setTimeout(() => {
      diffViewportRef.current?.focus?.({ preventScroll: false })
      diffViewportRef.current?.scrollTo?.({ top: 0 })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [activeTab, gitDiffText, gitLoading, gitSelectedFile])

  const isReviewSelectable = useCallback((line) => {
    return line && ['add', 'remove', 'context'].includes(line.type)
  }, [])

  // Click-toggle + shift-range, mirroring TerminalAnnotator. Simpler and more
  // predictable than drag-paint, and Enter on the row pops focus to the latest
  // comment box (handled in the keyboard effect below).
  const handleReviewLineClick = useCallback((idx, e) => {
    const line = parsedDiff[idx]
    if (!isReviewSelectable(line)) return
    setReviewSelectedLines((prev) => {
      const next = new Set(prev)
      if (e.shiftKey && reviewLastClicked != null) {
        const lo = Math.min(reviewLastClicked, idx)
        const hi = Math.max(reviewLastClicked, idx)
        let allOn = true
        for (let i = lo; i <= hi; i++) {
          if (!isReviewSelectable(parsedDiff[i])) continue
          if (!prev.has(i)) { allOn = false; break }
        }
        for (let i = lo; i <= hi; i++) {
          if (!isReviewSelectable(parsedDiff[i])) continue
          allOn ? next.delete(i) : next.add(i)
        }
      } else {
        next.has(idx) ? next.delete(idx) : next.add(idx)
      }
      return next
    })
    setReviewLastClicked(idx)
  }, [parsedDiff, reviewLastClicked, isReviewSelectable])

  // Group consecutive selected line indices into [[1,2,3],[7],[10,11]]
  const reviewGroups = useMemo(() => {
    const indices = [...reviewSelectedLines].sort((a, b) => a - b)
    if (!indices.length) return []
    const groups = [[indices[0]]]
    for (let i = 1; i < indices.length; i++) {
      if (indices[i] === indices[i - 1] + 1) groups[groups.length - 1].push(indices[i])
      else groups.push([indices[i]])
    }
    return groups
  }, [reviewSelectedLines])

  // For rendering: line idx → first-idx of its group (so we know where to anchor the textarea)
  const reviewGroupEnds = useMemo(() => {
    const map = new Map()
    for (const g of reviewGroups) map.set(g[g.length - 1], g[0])
    return map
  }, [reviewGroups])

  // Create blank comment entries for new groups, and focus the most recent one
  useEffect(() => {
    if (!reviewGroups.length) return
    const lastKey = reviewGroups[reviewGroups.length - 1][0]
    setReviewComments((prev) => {
      const next = { ...prev }
      let changed = false
      for (const g of reviewGroups) {
        if (!(g[0] in next)) { next[g[0]] = ''; changed = true }
      }
      // Prune comments for groups that no longer exist
      const liveKeys = new Set(reviewGroups.map((g) => g[0]))
      for (const k of Object.keys(next)) {
        if (!liveKeys.has(Number(k))) { delete next[k]; changed = true }
      }
      return changed ? next : prev
    })
    requestAnimationFrame(() => {
      const el = reviewCommentRefs.current[lastKey]
      if (!el) return
      el.focus()
      // Pull the comment into view so the user can see where to type
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }, [reviewGroups])

  const setReviewComment = useCallback((groupKey, text) => {
    setReviewComments((prev) => ({ ...prev, [groupKey]: text }))
  }, [])

  const getBrowserSelectedReviewIndexes = useCallback(() => {
    const root = diffViewportRef.current
    const sel = window.getSelection?.()
    if (!root || !sel || sel.isCollapsed || sel.rangeCount === 0) return []
    if (!root.contains(sel.anchorNode) && !root.contains(sel.focusNode)) return []
    const range = sel.getRangeAt(0)
    const indexes = []
    root.querySelectorAll('[data-review-line-index]').forEach((node) => {
      try {
        if (!range.intersectsNode(node)) return
        const idx = Number(node.getAttribute('data-review-line-index'))
        const line = parsedDiff[idx]
        if (Number.isFinite(idx) && line && ['add', 'remove', 'context'].includes(line.type)) {
          indexes.push(idx)
        }
      } catch {}
    })
    return indexes
  }, [parsedDiff])

  const handleAnnotateBrowserSelection = useCallback(() => {
    const indexes = getBrowserSelectedReviewIndexes()
    if (indexes.length === 0) return
    setReviewSelectedLines((prev) => {
      const next = new Set(prev)
      indexes.forEach((idx) => next.add(idx))
      return next
    })
    setReviewLastClicked(indexes[indexes.length - 1])
  }, [getBrowserSelectedReviewIndexes])

  const getSelectedReviewText = useCallback(() => {
    const sel = window.getSelection?.()
    if (diffViewportRef.current && sel && !sel.isCollapsed && diffViewportRef.current.contains(sel.anchorNode)) {
      const selectedText = sel.toString().trim()
      if (selectedText) return selectedText
    }
    const indexes = Array.from(reviewSelectedLines).sort((a, b) => a - b)
    if (indexes.length > 0) {
      return indexes.map((idx) => parsedDiff[idx]?.text || '').filter(Boolean).join('\n')
    }
    return gitDiffText
  }, [gitDiffText, parsedDiff, reviewSelectedLines])

  const handleCopyReviewText = useCallback(async () => {
    const text = getSelectedReviewText()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setReviewCopied(true)
      setTimeout(() => setReviewCopied(false), 1400)
    } catch {}
  }, [getSelectedReviewText])

  const buildReviewAnnotationsText = useCallback(() => {
    if (reviewGroups.length === 0) return ''
    return reviewGroups.map((g) => {
      const lines = g.map((idx) => parsedDiff[idx]).filter(Boolean)
      const file = gitSelectedFile || lines[0]?.file || 'working tree'
      const startLine = lines[0]?.lineNew || lines[0]?.lineOld || '?'
      const comment = (reviewComments[g[0]] || '').trim()
      const snippet = lines.map((l) => `${l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' '}${l.text.slice(1)}`).join('\n')
      const commentStr = comment ? `Comment: ${comment}` : 'No comment'
      return `File: ${file}:${startLine}\n\`\`\`\n${snippet}\n\`\`\`\n${commentStr}`
    }).join('\n\n')
  }, [gitSelectedFile, parsedDiff, reviewComments, reviewGroups])

  const handleSendReviewFeedback = () => {
    if (!sessionId || reviewGroups.length === 0) return

    const message = `I have reviewed the changes. Here is my feedback on specific code blocks:\n\n${buildReviewAnnotationsText()}`
    sendTerminalCommand(sessionId, message)

    setReviewSelectedLines(new Set())
    setReviewComments({})
  }

  const handleSaveReviewAgentPrompt = useCallback(() => {
    api.setAppSetting('code_review_agent_prompt', reviewAgentPrompt).catch(() => {})
    setReviewAgentSaved(true)
    // User feedback: Save should dismiss the modal so they don't have to
    // hunt for a close button after persisting the template.
    window.setTimeout(() => {
      setReviewAgentSaved(false)
      setReviewAgentOpen(false)
    }, 600)
  }, [reviewAgentPrompt])

  const handleResetReviewAgentPrompt = useCallback(() => {
    setReviewAgentPrompt(DEFAULT_REVIEW_AGENT_PROMPT)
    api.setAppSetting('code_review_agent_prompt', DEFAULT_REVIEW_AGENT_PROMPT).catch(() => {})
  }, [])

  const handleRunReviewAgent = useCallback(async () => {
    if (!workspaceId || !gitDiffText) return
    setReviewAgentBusy(true)
    setReviewAgentError(null)
    try {
      const annotationsText = buildReviewAnnotationsText()
      const basePrompt = (reviewAgentPrompt || DEFAULT_REVIEW_AGENT_PROMPT)
        .replace('{diff}', gitDiffText.slice(0, 100000))
        .replace('{annotations}', annotationsText)
      let prompt = basePrompt
      try {
        const enriched = await api.composeReviewBrief({
          instructions: basePrompt,
          reviewed_session_id: sessionId || activeSessionId,
        })
        if (enriched?.brief) prompt = enriched.brief
      } catch {}

      let sid = reviewAgentTargetSessionId || sessionId || activeSessionId
      if (reviewAgentMode === 'new') {
        const scopeLabel = gitScope === 'staged' ? 'staged' : 'working'
        const fileLabel = gitSelectedFile ? ` · ${gitSelectedFile.split('/').pop()}` : ''
        const session = await api.createSession(workspaceId, {
          name: `Review · ${scopeLabel}${fileLabel}`,
          purpose: 'Code review',
          cli_type: reviewCliType,
          model: getRoleDefaultModel(reviewCliType, 'worker'),
          permission_mode: getDefaultPermissionMode(reviewCliType),
        })
        useStore.getState().addSession(session)
        sid = session.id
        // Wait for the real start_pty instead of a guessed delay.
        await useStore.getState().ensureSessionRunning(sid)
      }
      if (!sid) throw new Error('No review session available')
      sendTerminalCommand(sid, prompt)
      setReviewAgentOpen(false)
    } catch (e) {
      setReviewAgentError(e.message || 'Failed to start review agent')
    } finally {
      setReviewAgentBusy(false)
    }
  }, [
    activeSessionId,
    buildReviewAnnotationsText,
    gitDiffText,
    gitScope,
    gitSelectedFile,
    reviewAgentMode,
    reviewAgentPrompt,
    reviewAgentTargetSessionId,
    reviewCliType,
    sessionId,
    workspaceId,
  ])

  // Parse markdown for Plan details preview
  const renderPlanMarkdown = (md) => {
    if (!md) return <span className="text-x-muted italic text-[11px]">Plan content empty</span>
    return (
      <div className="text-x-ink-secondary leading-relaxed space-y-1 break-words">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1({ children, ...props }) {
              return <h1 className="text-base font-bold text-x-ink mt-5 mb-2 break-words" {...props}>{children}</h1>
            },
            h2({ children, ...props }) {
              return <h2 className="text-sm font-semibold text-x-accent mt-4 mb-1.5 break-words" {...props}>{children}</h2>
            },
            h3({ children, ...props }) {
              return <h3 className="text-xs font-semibold text-x-ink mt-3 mb-1 font-mono break-words" {...props}>{children}</h3>
            },
            p({ children, ...props }) {
              return <p className="text-x-ink-secondary text-xs py-0.5 leading-relaxed break-words" {...props}>{children}</p>
            },
            ul({ children, ...props }) {
              return <ul className="space-y-0.5 pl-0" {...props}>{children}</ul>
            },
            ol({ children, ...props }) {
              return <ol className="space-y-0.5 pl-4 list-decimal text-xs text-x-ink-secondary" {...props}>{children}</ol>
            },
            li({ children, className, ...props }) {
              const isTask = className?.includes('task-list-item')
              if (isTask) {
                return (
                  <li className="flex items-start gap-1.5 text-x-ink-secondary text-xs py-1 list-none break-words" {...props}>
                    {children}
                  </li>
                )
              }
              return (
                <li className="flex items-start gap-1.5 text-x-ink-secondary text-xs py-0.5 list-none break-words" {...props}>
                  <span className="mt-1.5 w-1 h-1 rounded-full bg-x-accent shrink-0" />
                  <span className="flex-1">{children}</span>
                </li>
              )
            },
            input({ type, checked, ...props }) {
              if (type === 'checkbox') {
                return (
                  <span className={`mr-1.5 select-none shrink-0 font-mono text-[13px] leading-none ${checked ? 'text-x-good' : 'text-x-muted'}`}>
                    {checked ? '\u2611' : '\u2610'}
                  </span>
                )
              }
              return <input type={type} checked={checked} {...props} />
            },
            code({ className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || '')
              if (match?.[1] === 'mermaid') return <MermaidBlock code={String(children).trim()} />
              
              const isInline = !className
              if (isInline) {
                return (
                  <code className="bg-x-surface-2 border border-x-line text-x-accent text-[11px] px-1 py-0.5 rounded font-mono break-all whitespace-pre-wrap" {...props}>
                    {children}
                  </code>
                )
              }
              
              return (
                <pre className="bg-x-surface-2 border border-x-line rounded-xl p-3 text-xs font-mono text-x-ink overflow-x-auto scrollbar-thin my-2">
                  <code className={className} {...props}>
                    {children}
                  </code>
                </pre>
              )
            },
            table({ children, ...props }) {
              return (
                <div className="overflow-x-auto my-3 border border-x-line rounded-xl bg-x-surface-2 scrollbar-thin">
                  <table className="w-full min-w-[550px] text-left text-[11px] border-collapse" {...props}>
                    {children}
                  </table>
                </div>
              )
            },
            thead({ children, ...props }) {
              return <thead className="bg-x-hover border-b border-x-line" {...props}>{children}</thead>
            },
            th({ children, ...props }) {
              return <th className="px-3 py-2 font-mono font-semibold text-x-ink border-r border-x-line-subtle last:border-none break-words" {...props}>{children}</th>
            },
            td({ children, ...props }) {
              return <td className="px-3 py-2 text-x-ink-secondary border-r border-x-line-subtle last:border-none break-words" {...props}>{children}</td>
            },
            tr({ children, ...props }) {
              return <tr className="border-b border-x-line-subtle last:border-none hover:bg-x-hover" {...props}>{children}</tr>
            },
            hr({ ...props }) {
              return <hr className="border-x-line my-4" {...props} />
            }
          }}
        >
          {md}
        </ReactMarkdown>
      </div>
    )
  }

  return (
    <div className="relative w-[380px] border-l border-x-line bg-x-bg flex flex-col h-full overflow-hidden z-30 x-sidebar-slide">
      {/* Sidebar Header Tabs */}
      <div className="flex items-center justify-between border-b border-x-line bg-x-surface-2 shrink-0 px-3 select-none">
        <div className="flex gap-1.5 py-2">
          <button
            onClick={() => { selectTab('files'); setSelectedPlan(null) }}
            className={`px-3 py-1.5 text-[11px] font-semibold font-mono rounded-lg transition-all ${
              activeTab === 'files'
                ? 'bg-x-tint text-x-ink'
                : 'text-x-muted hover:text-x-ink-secondary'
            }`}
          >
            Files & Plans
          </button>
          <button
            onClick={() => selectTab('review')}
            className={`px-3 py-1.5 text-[11px] font-semibold font-mono rounded-lg transition-all ${
              activeTab === 'review'
                ? 'bg-x-tint text-x-ink'
                : 'text-x-muted hover:text-x-ink-secondary'
            }`}
          >
            Code Review
          </button>
          <button
            onClick={() => selectTab('scratchpad')}
            className={`px-3 py-1.5 text-[11px] font-semibold font-mono rounded-lg transition-all ${
              activeTab === 'scratchpad'
                ? 'bg-x-tint text-x-ink'
                : 'text-x-muted hover:text-x-ink-secondary'
            }`}
          >
            Scratchpad
          </button>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-x-hover text-x-muted hover:text-x-ink transition-all"
        >
          <X size={15} />
        </button>
      </div>

      {/* Main Sidebar Contents */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {activeTab === 'scratchpad' ? (
          <Scratchpad sessionId={sessionId} hideHeader={true} />
        ) : activeTab === 'files' ? (
          selectedPlan ? (
            /* Plan Details Viewer Nested Screen */
            <div className="p-4 flex flex-col h-full min-h-0 bg-x-surface">
              <div className="flex items-center justify-between border-b border-x-line pb-3 mb-3 shrink-0">
                <div className="flex flex-col min-w-0">
                  <button
                    onClick={() => setSelectedPlan(null)}
                    className="text-[11px] font-mono text-x-accent hover:text-x-accent-ink flex items-center gap-1 self-start"
                  >
                    &larr; Back to Files
                  </button>
                  <span className="text-[11px] font-semibold text-x-ink mt-1 font-mono truncate max-w-[210px]" title={selectedPlan?.path}>
                    {selectedPlan?.slug || selectedPlan?.name}
                  </span>
                </div>
                <div className="flex gap-1.5 self-end pb-0.5">
                  <button
                    onClick={() => setPlanMode('preview')}
                    className={`p-1 rounded text-x-muted hover:text-x-ink ${planMode === 'preview' ? 'text-x-ink bg-x-hover' : ''}`}
                    title="Preview Plan"
                  >
                    <Eye size={13} />
                  </button>
                  <button
                    onClick={() => setPlanMode('edit')}
                    className={`p-1 rounded text-x-muted hover:text-x-ink ${planMode === 'edit' ? 'text-x-ink bg-x-hover' : ''}`}
                    title="Edit Plan Text"
                  >
                    <FileEdit size={13} />
                  </button>
                </div>
              </div>

              {planLoading ? (
                <div className="flex-1 flex items-center justify-center text-x-muted py-20">
                  <Loader2 size={16} className="animate-spin text-x-accent" />
                </div>
              ) : planMode === 'edit' ? (
                <div className="flex-1 flex flex-col gap-2 min-h-[250px]">
                  <textarea
                    value={planContent}
                    onChange={(e) => setPlanContent(e.target.value)}
                    className="flex-1 bg-x-surface-2 border border-x-line rounded-xl p-3 text-xs text-x-ink placeholder-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus font-mono resize-none"
                  />
                  {planContent !== planOriginal && (
                    <button
                      onClick={handleSavePlan}
                      className="py-1.5 rounded-lg bg-x-accent hover:bg-x-accent-ink text-x-on-accent font-mono text-[11px] flex items-center justify-center gap-1"
                    >
                      <Save size={11} />
                      <span>Save Plan</span>
                    </button>
                  )}
                </div>
              ) : (
                <div 
                  onMouseUp={handlePlanMouseUp}
                  className="flex-1 overflow-y-auto overflow-x-hidden bg-x-surface-2 border border-x-line-subtle rounded-xl p-3.5 select-text"
                >
                  {renderPlanMarkdown(planContent)}
                </div>
              )}


              {planSelection && (
                <div className="mt-2.5 p-2.5 bg-x-surface-2 border border-x-line rounded-xl flex flex-col gap-2 shrink-0 animate-in fade-in slide-in-from-top duration-150">
                  <div className="text-[11px] font-mono text-x-accent/80 truncate">
                    Annotating selection: &ldquo;{planSelection.text}&rdquo;
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Add comment note (optional)..."
                      value={planComment}
                      onChange={(e) => setPlanComment(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSendPlanAnnotation()
                      }}
                      className="flex-1 bg-x-surface-2 border border-x-line rounded-xl px-3 py-1.5 text-xs text-x-ink placeholder-x-muted focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus font-mono"
                      autoFocus
                    />
                    <button
                      onClick={handleSendPlanAnnotation}
                      className="px-3 py-1.5 bg-x-accent hover:bg-x-accent-ink text-x-on-accent rounded-xl text-[11px] font-semibold transition-all"
                    >
                      Annotate
                    </button>
                    <button
                      onClick={() => { setPlanSelection(null); setPlanComment('') }}
                      className="p-1.5 rounded hover:bg-x-hover text-x-muted hover:text-x-ink transition-all"
                    >
                      <X size={13} />
                    </button>
                  </div>
                </div>
              )}


              {/* Waiting Feedback Controls */}
              {selectedPlan?.sid && planWaiting[selectedPlan.sid] && (
                <div className="border-t border-x-line pt-3.5 mt-3.5 flex flex-col gap-2.5">
                  <div className="bg-x-accent-ink/10 border border-x-accent-ink/25 p-2 rounded-lg text-[11px] text-x-accent-ink font-mono flex items-center gap-1.5 animate-subtle-pulse">
                    <AlertTriangle size={11} />
                    <span>Agent is waiting for your review</span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handlePlanApprove}
                      className="flex-1 py-2 rounded-xl bg-x-good hover:bg-x-good/90 text-x-on-accent text-[11px] font-semibold flex items-center justify-center gap-1 transition-colors active:scale-[.98]"
                    >
                      <Check size={12} />
                      <span>Approve Plan</span>
                    </button>
                  </div>
                  <div className="flex gap-1.5 bg-x-surface-2 border border-x-line rounded-xl p-1.5 items-center">
                    <input
                      type="text"
                      placeholder="Type changes or comments..."
                      value={planFeedback}
                      onChange={(e) => setPlanFeedback(e.target.value)}
                      className="flex-1 bg-transparent text-xs text-x-ink placeholder-x-muted focus:outline-none pl-1"
                    />
                    <button
                      onClick={handleSendPlanFeedback}
                      disabled={!planFeedback.trim()}
                      className="p-1.5 rounded-lg bg-x-accent hover:bg-x-accent-ink text-x-on-accent transition-colors disabled:opacity-40 active:scale-[.98]"
                    >
                      <Send size={11} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Normal Files Panel lists */
            <div className="p-3.5 space-y-4">
              {/* Plans & Artifacts Group */}
              <div className="border border-x-line-subtle bg-x-surface rounded-xl overflow-hidden ">
                <button
                  onClick={() => setExpandedSections(p => ({ ...p, plans: !p.plans }))}
                  className="w-full flex items-center justify-between p-3 text-[11px] font-mono font-semibold text-x-ink-secondary hover:bg-x-hover"
                >
                  <span className="flex items-center gap-2">
                    <FileText size={13} className="text-x-accent" />
                    <span>Plans & Artifacts</span>
                  </span>
                  <span>
                    {expandedSections.plans ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </span>
                </button>
                {expandedSections.plans && (
                  <div className="border-t border-x-line-subtle p-1.5 space-y-0.5 max-h-[220px] overflow-y-auto scrollbar-thin">
                    {workspacePlans.length === 0 ? (
                      <div className="p-3 text-[11px] text-x-muted italic">No plans generated</div>
                    ) : (
                      workspacePlans.map((p, idx) => {
                        const isCurrent = p.sid === sessionId
                        const isWaiting = p.sid && planWaiting[p.sid]
                        return (
                          <div
                            key={p.path + idx}
                            onClick={() => handleSelectPlan(p)}
                            className={`group flex items-center justify-between p-2 rounded-lg cursor-pointer transition-all ${
                              isCurrent
                                ? 'bg-x-accent/10 border border-x-accent/20 text-x-accent'
                                : 'hover:bg-x-hover border border-transparent text-x-ink-secondary hover:text-x-ink'
                            }`}
                          >
                            <span className="text-[11px] font-mono truncate max-w-[200px]" title={p.path}>
                              {p.slug}
                            </span>
                            {isWaiting && (
                              <span className="text-[11px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-x-accent-ink/20 border border-x-accent-ink/30 text-x-accent-ink animate-subtle-pulse font-semibold">
                                Pending
                              </span>
                            )}
                          </div>
                        )
                      })
                    )}
                  </div>
                )}
              </div>

              {/* Files Touched (from agent run) */}
              <div className="border border-x-line-subtle bg-x-surface rounded-xl overflow-hidden ">
                <button
                  onClick={() => setExpandedSections(p => ({ ...p, touched: !p.touched }))}
                  className="w-full flex items-center justify-between p-3 text-[11px] font-mono font-semibold text-x-ink-secondary hover:bg-x-hover"
                >
                  <span className="flex items-center gap-2">
                    <Files size={13} className="text-x-good" />
                    <span>Files Touched</span>
                  </span>
                  <span>
                    {expandedSections.touched ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </span>
                </button>
                {expandedSections.touched && (
                  <div className="border-t border-x-line-subtle p-1.5 space-y-0.5 max-h-[220px] overflow-y-auto scrollbar-thin">
                    {touchedFiles.length === 0 ? (
                      <div className="p-3 text-[11px] text-x-muted italic">No files touched in this session</div>
                    ) : (
                      touchedFiles.map((filepath, idx) => {
                        const filename = filepath.split('/').pop()
                        return (
                          <div
                            key={idx}
                            onClick={() => handleOpenInIde(filepath)}
                            className="group flex items-center justify-between p-2 rounded-lg cursor-pointer border border-transparent hover:bg-x-hover text-x-ink-secondary hover:text-x-ink transition-all"
                            title={`Open ${filepath} in IDE`}
                          >
                            <span className="text-[11px] font-mono truncate max-w-[240px]">
                              {filename}
                            </span>
                            <ExternalLink size={10} className="opacity-0 group-hover:opacity-100 text-x-muted transition-all shrink-0 ml-2" />
                          </div>
                        )
                      })
                    )}
                  </div>
                )}
              </div>

              {/* Uploads Group */}
              <div className="border border-x-line-subtle bg-x-surface rounded-xl overflow-hidden ">
                <button
                  onClick={() => setExpandedSections(p => ({ ...p, uploads: !p.uploads }))}
                  className="w-full flex items-center justify-between p-3 text-[11px] font-mono font-semibold text-x-ink-secondary hover:bg-x-hover"
                >
                  <span className="flex items-center gap-2">
                    <FolderOpen size={13} className="text-x-accent" />
                    <span>Uploaded Files</span>
                  </span>
                  <span>
                    {expandedSections.uploads ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </span>
                </button>
                {expandedSections.uploads && (
                  <div className="border-t border-x-line-subtle p-2 space-y-2.5 max-h-[250px] overflow-y-auto scrollbar-thin">
                    {attachments.length === 0 ? (
                      <div className="p-2 text-[11px] text-x-muted italic">No files uploaded yet</div>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        {attachments.map((file, idx) => {
                          const isImg = file.filename.match(/\.(jpg|jpeg|png|webp|gif)$/i)
                          return (
                            <div
                              key={idx}
                              onClick={() => isImg && onAnnotateImage?.(file.url, file.filename)}
                              className="p-1.5 rounded-lg bg-x-surface-2 border border-x-line-subtle hover:border-x-accent/40 cursor-pointer transition-colors flex flex-col items-center justify-center"
                            >
                              {isImg ? (
                                <img
                                  src={file.url}
                                  alt={file.filename}
                                  className="w-full h-16 rounded object-cover"
                                />
                              ) : (
                                <div className="w-full h-16 flex items-center justify-center bg-x-hover border border-x-line-subtle rounded text-x-muted">
                                  <FileText size={20} />
                                </div>
                              )}
                              <span className="text-[11px] font-mono text-x-ink-secondary text-center truncate w-full mt-1.5 px-0.5">
                                {file.filename}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        ) : (
          /* Code Review Panel embedded */
          <div className="p-3.5 flex flex-col h-full min-h-[500px]">
            {/* Scope selectors */}
            <div className="flex gap-1.5 mb-3">
              {['working', 'staged'].map((sc) => (
                <button
                  key={sc}
                  onClick={() => { setGitScope(sc); handleSelectReviewFile(null) }}
                  className={`flex-1 py-1 rounded text-[11px] font-mono capitalize transition-all ${
                    gitScope === sc
                      ? 'bg-x-accent/20 border border-x-accent/40 text-x-ink'
                      : 'border border-x-line-subtle text-x-muted hover:text-x-ink-secondary'
                  }`}
                >
                  {sc} Diff
                </button>
              ))}
            </div>

            {/* Files Changed — tree grouped by directory, sectioned by stage. */}
            {gitStatus && (gitStatus.staged?.length > 0 || gitStatus.unstaged?.length > 0 || gitStatus.untracked?.length > 0) && (
              <div className="border border-x-line-subtle bg-x-surface rounded-xl overflow-hidden mb-2.5 max-h-[165px] flex flex-col">
                <button
                  onClick={() => handleSelectReviewFile(null)}
                  className={`flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-mono border-b border-x-line-subtle transition-colors ${
                    gitSelectedFile === null
                      ? 'bg-x-accent/10 text-x-accent'
                      : 'text-x-muted hover:bg-x-hover hover:text-x-ink-secondary'
                  }`}
                >
                  <Files size={11} /> All files
                </button>
                <div className="flex items-center gap-1.5 px-2 py-1 border-b border-x-line-subtle bg-x-surface-2">
                  <Search size={10} className="text-x-faint shrink-0" />
                  <input
                    value={gitSearchQuery}
                    onChange={(e) => setGitSearchQuery(e.target.value)}
                    placeholder="Search file names..."
                    className="w-full bg-transparent text-[11px] font-mono text-x-ink-secondary placeholder:text-x-faint focus:outline-none"
                  />
                  {gitSearchQuery && (
                    <button
                      type="button"
                      onClick={() => setGitSearchQuery('')}
                      className="p-0.5 rounded text-x-faint hover:text-x-ink-secondary hover:bg-x-hover"
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
                <div className="overflow-y-auto scrollbar-thin py-1 min-h-0">
                  {gitFileBuckets.staged.length > 0 && (
                    <SidebarFileSection
                      label="staged"
                      color="text-x-good"
                      files={gitFileBuckets.staged}
                      expanded={gitExpandedSections.staged}
                      onToggle={() => setGitExpandedSections((p) => ({ ...p, staged: !p.staged }))}
                      gitExpandedDirs={gitExpandedDirs}
                      onToggleDir={(k) => setGitExpandedDirs((p) => ({ ...p, [k]: p[k] === false ? true : false }))}
                      selectedFile={gitSelectedFile}
                      onSelect={handleSelectReviewFile}
                      onStage={handleStageFile}
                      onUnstage={handleUnstageFile}
                    />
                  )}
                  {gitFileBuckets.unstaged.length > 0 && (
                    <SidebarFileSection
                      label="unstaged"
                      color="text-x-accent-ink"
                      files={gitFileBuckets.unstaged}
                      expanded={gitExpandedSections.unstaged}
                      onToggle={() => setGitExpandedSections((p) => ({ ...p, unstaged: !p.unstaged }))}
                      gitExpandedDirs={gitExpandedDirs}
                      onToggleDir={(k) => setGitExpandedDirs((p) => ({ ...p, [k]: p[k] === false ? true : false }))}
                      selectedFile={gitSelectedFile}
                      onSelect={handleSelectReviewFile}
                      onStage={handleStageFile}
                      onUnstage={handleUnstageFile}
                    />
                  )}
                  {gitFileBuckets.untracked.length > 0 && (
                    <SidebarFileSection
                      label="untracked"
                      color="text-x-muted"
                      files={gitFileBuckets.untracked}
                      expanded={gitExpandedSections.untracked}
                      onToggle={() => setGitExpandedSections((p) => ({ ...p, untracked: !p.untracked }))}
                      gitExpandedDirs={gitExpandedDirs}
                      onToggleDir={(k) => setGitExpandedDirs((p) => ({ ...p, [k]: p[k] === false ? true : false }))}
                      selectedFile={gitSelectedFile}
                      onSelect={handleSelectReviewFile}
                      onStage={handleStageFile}
                      onUnstage={handleUnstageFile}
                    />
                  )}
                  {gitVisibleFileCount === 0 && (
                    <div className="px-2 py-3 text-center text-[11px] font-mono text-x-faint">
                      No matching files
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Selected File Diff & Annotator */}
            {gitLoading ? (
              <div className="flex items-center justify-center py-10 text-x-muted">
                <Loader2 size={14} className="animate-spin text-x-accent mr-1" />
                <span className="text-[11px] font-mono">Loading diff...</span>
              </div>
            ) : gitDiffText ? (
              <div className="flex-1 flex flex-col gap-2 min-h-0">
                <div className="flex items-center gap-1.5 text-[11px] text-x-muted font-mono bg-x-surface-2 p-1.5 rounded-lg border border-x-line-subtle select-none">
                  <span className="min-w-0 flex-1 truncate text-x-ink-secondary" title={gitSelectedFile || 'All changed files'}>
                    {gitSelectedFile || 'All changed files'}
                  </span>
                  <div className="flex items-center gap-1 w-32 px-1.5 py-1 rounded-md bg-x-surface-2 border border-x-line-subtle">
                    <Search size={10} className="text-x-faint shrink-0" />
                    <input
                      value={gitDiffSearchQuery}
                      onChange={(e) => setGitDiffSearchQuery(e.target.value)}
                      placeholder="Find"
                      className="w-full bg-transparent text-[11px] font-mono text-x-ink-secondary placeholder:text-x-faint focus:outline-none"
                    />
                    {gitDiffSearchQuery && (
                      <button
                        type="button"
                        onClick={() => setGitDiffSearchQuery('')}
                        className="text-x-faint hover:text-x-ink-secondary"
                      >
                        <X size={10} />
                      </button>
                    )}
                  </div>
                  <Button
                    type="button"
                    onClick={handleAnnotateBrowserSelection}
                    className="flex items-center gap-1 px-2 py-1 border border-x-accent/20 text-x-accent hover:bg-x-accent/10 hover:border-x-accent/35 transition-colors"
                    title="Mark the currently highlighted diff text for annotation"
                  >
                    <Edit3 size={10} />
                    <span>Annotate</span>
                  </Button>
                  <Button
                    type="button"
                    onClick={handleCopyReviewText}
                    className="flex items-center gap-1 px-2 py-1 border border-x-line text-x-ink-secondary hover:text-x-ink hover:bg-x-hover transition-colors"
                    title="Copy highlighted text, selected lines, or the current diff"
                  >
                    {reviewCopied ? <Check size={10} className="text-x-good" /> : <Copy size={10} />}
                    <span>{reviewCopied ? 'Copied' : 'Copy'}</span>
                  </Button>
                  <Button
                    type="button"
                    onClick={() => { setReviewOpenMode('fullscreen'); setIsFullscreenDiff(true) }}
                    className="flex items-center gap-1 px-2 py-1 border border-x-line text-x-ink-secondary hover:text-x-ink hover:bg-x-hover transition-colors"
                    title="Open fullscreen. Code Review will remember this preference next time."
                  >
                    <Maximize2 size={10} />
                    <span>Fullscreen</span>
                  </Button>
                </div>
                
                {/* Scrollable diff lines viewport. Fills remaining height. Text
                    stays selectable for normal copy; line-paint happens by
                    mouse-dragging on the +/- gutter column. */}
                <div
                  ref={diffViewportRef}
                  tabIndex={0}
                  className="flex-1 min-h-0 overflow-y-auto bg-x-surface-2 border border-x-line-subtle rounded-xl p-2 font-mono text-[11px] leading-5 scrollbar-thin select-text outline-none focus:border-x-accent/25"
                >
                  {parsedDiff.map((line, idx) => {
                    const isSel = reviewSelectedLines.has(idx)
                    const isSelectable = isReviewSelectable(line)
                    const groupFirstIdx = reviewGroupEnds.get(idx)
                    const commentForGroup = groupFirstIdx != null ? (reviewComments[groupFirstIdx] ?? '') : null
                    // File-header lines: render with a subtle backdrop so the
                    // tree-style file boundaries are visible inside the diff
                    if (line.type === 'file-header') {
                      return (
                        <div key={idx} className={`py-0.5 px-1 ${line.text.startsWith('diff --git') ? 'mt-2 bg-x-hover text-x-ink-secondary font-semibold' : 'text-x-muted'} rounded`}>
                          {renderDiffTextWithSearch(line.text, gitDiffSearchQuery)}
                        </div>
                      )
                    }
                    if (line.type === 'hunk-header') {
                      return (
                        <div key={idx} className="py-0.5 px-1 text-x-accent/90 bg-x-accent/[0.06] rounded">
                          {renderDiffTextWithSearch(line.text, gitDiffSearchQuery)}
                        </div>
                      )
                    }
                    // Code / context line: strip the diff prefix and keep the
                    // text quiet. The diff colors should explain the change;
                    // token colors inside added/removed rows get noisy fast.
                    const codeText = line.text.startsWith('+') || line.text.startsWith('-') || line.text.startsWith(' ')
                      ? line.text.slice(1)
                      : line.text
                    const rowTone = line.type === 'add'
                      ? 'bg-x-good/[0.045]'
                      : line.type === 'remove'
                        ? 'bg-x-accent-ink/[0.05]'
                        : ''
                    const lineLang = line.file ? detectLang(line.file) : null
                    return (
                      <div key={idx} data-review-line-index={idx} className="flex flex-col">
                        {/* Click anywhere on the row to toggle, shift+click for
                            range — matching TerminalAnnotator. The whole row is
                            clickable, text not browser-selectable so a single
                            click never starts a stray text selection. */}
                        <div
                          onClick={isSelectable ? (e) => handleReviewLineClick(idx, e) : undefined}
                          className={`py-0.5 px-1 rounded flex items-start gap-1 transition-colors select-none ${
                            isSel
                              ? 'bg-x-accent/15 border-l-2 border-x-accent'
                              : `${rowTone} ${isSelectable ? 'hover:bg-x-hover cursor-pointer' : ''}`
                          }`}
                          title={isSelectable ? 'Click to select. Shift+click for range. Enter focuses the comment box.' : undefined}
                        >
                          <span
                            className={`w-8 shrink-0 text-right pr-1 rounded-sm ${
                              isSelectable
                                ? isSel
                                  ? 'text-x-accent bg-x-accent/20'
                                  : line.type === 'add'
                                    ? 'text-x-good'
                                    : line.type === 'remove'
                                      ? 'text-x-accent-ink'
                                      : 'text-x-muted'
                                : 'text-x-faint/50'
                            }`}
                          >
                            {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : isSelectable ? ' ' : ''}
                          </span>
                          <span className="flex-1 break-words whitespace-pre-wrap text-x-ink">
                            {renderDiffLineWithSyntax(codeText, lineLang, gitDiffSearchQuery, line.file)}
                          </span>
                        </div>

                        {/* One comment box per consecutive selected group, anchored
                            after the last line. Enter inserts a newline (we
                            stopPropagation so global Enter handlers don't fire);
                            ⌘↵ sends; Esc blurs. */}
                        {commentForGroup != null && (
                          <div
                            className="flex items-start ml-6 mr-1 my-1 pl-3 pr-2 py-1.5 bg-x-accent-ink/8 border border-x-accent-ink/20 rounded-md"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span className="text-x-accent-ink text-[11px] font-semibold shrink-0 pt-0.5 mr-2">{'→'}</span>
                            <textarea
                              ref={(el) => { if (el) reviewCommentRefs.current[groupFirstIdx] = el }}
                              value={commentForGroup}
                              onChange={(e) => setReviewComment(groupFirstIdx, e.target.value)}
                              placeholder="your comment..."
                              rows={Math.max(1, commentForGroup.split('\n').length)}
                              className="flex-1 bg-transparent text-x-accent-ink/90 text-xs font-mono resize-none focus:outline-none placeholder:text-x-accent-ink/30 min-h-[22px]"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) e.stopPropagation()
                                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); handleSendReviewFeedback() }
                                if (e.key === 'Escape') { e.stopPropagation(); e.target.blur() }
                              }}
                            />
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                {/* "Review →" split-button. Primary action fires the most
                    likely thing for the current state (send annotations if any,
                    otherwise spawn agent). The chevron opens a popover with
                    every option so neither path is hidden. */}
                {gitDiffText && (
                  <div className="relative mt-2 select-none">
                    <div className="flex items-stretch rounded-xl overflow-hidden shadow-x-1">
                      <button
                        type="button"
                        onClick={() => {
                          if (reviewGroups.length > 0) handleSendReviewFeedback()
                          else { setReviewAgentError(null); setReviewAgentOpen(true) }
                        }}
                        className="flex-1 py-2 px-3 bg-x-accent hover:bg-x-accent-ink text-x-on-accent font-mono text-[11px] font-semibold flex items-center justify-center gap-1.5 transition-all"
                        title={reviewGroups.length > 0
                          ? `Send ${reviewGroups.length} annotation${reviewGroups.length !== 1 ? 's' : ''} into the active session`
                          : 'Spawn an agent to review this diff'}
                      >
                        <span>Review</span>
                        {reviewGroups.length > 0 && (
                          <span className="text-x-on-accent/90 font-mono text-[11px]">({reviewGroups.length})</span>
                        )}
                        <ArrowRight size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setReviewMenuOpen((s) => !s)}
                        className="px-2 bg-x-accent/80 hover:bg-x-accent text-x-on-accent border-l border-x-on-accent/20 flex items-center"
                        title="More review options"
                        aria-expanded={reviewMenuOpen}
                      >
                        <ChevronUp size={12} className={`transition-transform ${reviewMenuOpen ? '' : 'rotate-180'}`} />
                      </button>
                    </div>

                    {reviewMenuOpen && (
                      <>
                        {/* Click-away catcher */}
                        <div className="fixed inset-0 z-30" onClick={() => setReviewMenuOpen(false)} />
                        <div className="absolute bottom-full mb-2 right-0 z-40 w-[260px] rounded-xl border border-x-line bg-x-surface shadow-x-1 overflow-hidden">
                          {reviewGroups.length > 0 && (
                            <>
                              <button
                                type="button"
                                onClick={() => { setReviewMenuOpen(false); handleSendReviewFeedback() }}
                                className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-x-hover transition-colors"
                              >
                                <Send size={12} className="text-x-accent mt-0.5 shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <div className="text-[11px] font-mono text-x-ink">Send {reviewGroups.length} to active session</div>
                                  <div className="text-[11px] text-x-muted">Drops the annotations into the running CLI</div>
                                </div>
                              </button>
                              <button
                                type="button"
                                onClick={() => { setReviewMenuOpen(false); handleCopyReviewText() }}
                                className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-x-hover transition-colors border-t border-x-line-subtle"
                              >
                                <Copy size={12} className="text-x-ink-secondary mt-0.5 shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <div className="text-[11px] font-mono text-x-ink">Copy selected ({reviewSelectedLines.size})</div>
                                  <div className="text-[11px] text-x-muted">Plain text on the clipboard</div>
                                </div>
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() => { setReviewMenuOpen(false); setReviewAgentError(null); setReviewAgentOpen(true) }}
                            className={`w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-x-hover transition-colors ${reviewGroups.length > 0 ? 'border-t border-x-line-subtle' : ''}`}
                          >
                            <Bot size={12} className="text-x-accent mt-0.5 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="text-[11px] font-mono text-x-ink">Review with Agent…</div>
                              <div className="text-[11px] text-x-muted">Fresh agent + configurable prompt</div>
                            </div>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="py-20 text-center text-x-muted text-[11px] italic">
                No diff loaded. Select a changed file.
              </div>
            )}
          </div>
        )}
      </div>

      {reviewAgentOpen && (
        <SidebarReviewAgentModal
          onClose={() => setReviewAgentOpen(false)}
          prompt={reviewAgentPrompt}
          setPrompt={setReviewAgentPrompt}
          onSavePrompt={handleSaveReviewAgentPrompt}
          onResetPrompt={handleResetReviewAgentPrompt}
          saved={reviewAgentSaved}
          mode={reviewAgentMode}
          setMode={setReviewAgentMode}
          busy={reviewAgentBusy}
          error={reviewAgentError}
          onSubmit={handleRunReviewAgent}
          configuredProvider={configuredReviewProvider}
          resolvedCliType={reviewCliType}
          annotationsCount={reviewGroups.length}
          diffSize={gitDiffText.length}
          sessions={workspaceSessions}
          targetSessionId={reviewAgentTargetSessionId}
          setTargetSessionId={setReviewAgentTargetSessionId}
          activeSessionId={activeSessionId}
        />
      )}

      {/* Portaled to body so position:fixed escapes the sidebar's backdrop-blur
          containing block — otherwise the overlay gets trapped in the 380px
          column and looks like it "opens in the sidebar only". */}
      {isFullscreenDiff && createPortal(
        <div className="fixed inset-0 z-[1000] bg-x-bg flex flex-col p-6 overflow-hidden text-x-ink select-text">
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b border-x-line select-none shrink-0">
            <div>
              <h2 className="text-sm font-semibold font-mono flex items-center gap-2">
                <GitCompareArrows className="text-x-accent" size={16} />
                <span>Fullscreen Code Review</span>
              </h2>
              <p className="text-[11px] text-x-muted font-mono mt-0.5">
                Workspace: {workspaceId}
              </p>
            </div>
            
            {/* Controls */}
            <div className="flex items-center gap-4">
              {/* Working / Staged Selector */}
              <div className="flex bg-x-surface-2 border border-x-line rounded-lg p-0.5">
                {['working', 'staged'].map((sc) => (
                  <Button
                    key={sc}
                    type="button"
                    onClick={() => { setGitScope(sc); handleSelectReviewFile(null) }}
                    className={`px-3 py-1 text-[11px] font-mono capitalize transition-all ${
                      gitScope === sc
                        ? 'bg-x-tint text-x-accent font-semibold'
                        : 'text-x-muted hover:text-x-ink-secondary'
                    }`}
                  >
                    {sc}
                  </Button>
                ))}
              </div>

              {/* Split / Unified Selector */}
              <div className="flex bg-x-surface-2 border border-x-line rounded-lg p-0.5">
                {[
                  { mode: 'split', label: 'Split View' },
                  { mode: 'unified', label: 'Unified View' }
                ].map((item) => (
                  <Button
                    key={item.mode}
                    type="button"
                    onClick={() => setViewMode(item.mode)}
                    className={`px-3 py-1 text-[11px] font-mono transition-all ${
                      viewMode === item.mode
                        ? 'bg-x-tint text-x-accent font-semibold'
                        : 'text-x-muted hover:text-x-ink-secondary'
                    }`}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => { setReviewOpenMode('sidebar'); setIsFullscreenDiff(false) }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-x-line bg-transparent text-[11px] font-mono text-x-ink-secondary hover:text-x-ink hover:bg-x-hover hover:border-x-line-strong transition-colors"
                title="Collapse to sidebar. Code Review will remember this preference next time."
              >
                <Minimize2 size={12} />
                <span>Collapse to Sidebar</span>
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 flex gap-6 overflow-hidden mt-4 min-h-0">
            {/* Sidebar */}
            <div className="w-[320px] flex-shrink-0 bg-x-surface rounded-xl border border-x-line-subtle flex flex-col p-4 overflow-hidden select-none">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-semibold font-mono text-x-accent uppercase tracking-wide">
                  Files Changed
                </span>
                {gitStatus && (
                  <span className="text-[11px] font-mono text-x-muted bg-x-hover px-1.5 py-0.5 rounded">
                    {gitVisibleFileCount} files
                  </span>
                )}
              </div>

              {/* Search */}
              <div className="flex items-center gap-1.5 px-2 py-1.5 border border-x-line bg-x-surface-2 rounded-lg mb-3">
                <Search size={12} className="text-x-faint shrink-0" />
                <input
                  value={gitSearchQuery}
                  onChange={(e) => setGitSearchQuery(e.target.value)}
                  placeholder="Search file names..."
                  className="w-full bg-transparent text-[11px] font-mono text-x-ink-secondary placeholder:text-x-faint focus:outline-none"
                />
                {gitSearchQuery && (
                  <button
                    type="button"
                    onClick={() => setGitSearchQuery('')}
                    className="p-0.5 rounded text-x-faint hover:text-x-ink-secondary hover:bg-x-hover"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>

              {/* Tree scrollable list */}
              <div className="flex-1 overflow-y-auto scrollbar-thin pr-1">
                <button
                  type="button"
                  onClick={() => handleSelectReviewFile(null)}
                  className={`w-full flex items-center gap-1.5 px-2 py-2 text-[11px] font-mono border border-transparent rounded-lg transition-colors mb-2 text-left ${
                    gitSelectedFile === null
                      ? 'bg-x-accent/10 border-x-accent/20 text-x-accent'
                      : 'text-x-muted hover:bg-x-hover hover:text-x-ink-secondary'
                  }`}
                >
                  <Files size={12} /> All changed files
                </button>

                {gitFileBuckets.staged.length > 0 && (
                  <SidebarFileSection
                    label="staged"
                    color="text-x-good"
                    files={gitFileBuckets.staged}
                    expanded={gitExpandedSections.staged}
                    onToggle={() => setGitExpandedSections((p) => ({ ...p, staged: !p.staged }))}
                    gitExpandedDirs={gitExpandedDirs}
                    onToggleDir={(k) => setGitExpandedDirs((p) => ({ ...p, [k]: p[k] === false ? true : false }))}
                    selectedFile={gitSelectedFile}
                    onSelect={handleSelectReviewFile}
                    onStage={handleStageFile}
                    onUnstage={handleUnstageFile}
                  />
                )}
                {gitFileBuckets.unstaged.length > 0 && (
                  <SidebarFileSection
                    label="unstaged"
                    color="text-x-accent-ink"
                    files={gitFileBuckets.unstaged}
                    expanded={gitExpandedSections.unstaged}
                    onToggle={() => setGitExpandedSections((p) => ({ ...p, unstaged: !p.unstaged }))}
                    gitExpandedDirs={gitExpandedDirs}
                    onToggleDir={(k) => setGitExpandedDirs((p) => ({ ...p, [k]: p[k] === false ? true : false }))}
                    selectedFile={gitSelectedFile}
                    onSelect={handleSelectReviewFile}
                    onStage={handleStageFile}
                    onUnstage={handleUnstageFile}
                  />
                )}
                {gitFileBuckets.untracked.length > 0 && (
                  <SidebarFileSection
                    label="untracked"
                    color="text-x-muted"
                    files={gitFileBuckets.untracked}
                    expanded={gitExpandedSections.untracked}
                    onToggle={() => setGitExpandedSections((p) => ({ ...p, untracked: !p.untracked }))}
                    gitExpandedDirs={gitExpandedDirs}
                    onToggleDir={(k) => setGitExpandedDirs((p) => ({ ...p, [k]: p[k] === false ? true : false }))}
                    selectedFile={gitSelectedFile}
                    onSelect={handleSelectReviewFile}
                    onStage={handleStageFile}
                    onUnstage={handleUnstageFile}
                  />
                )}
                {gitVisibleFileCount === 0 && (
                  <div className="px-2 py-4 text-center text-[11px] font-mono text-x-faint italic">
                    No matching files
                  </div>
                )}
              </div>
            </div>

            {/* Main Diff Area */}
            <div className="flex-1 bg-x-surface border border-x-line-subtle rounded-xl flex flex-col overflow-hidden min-w-0">
              <div className="flex items-center justify-between p-3 border-b border-x-line-subtle bg-x-surface-2 select-none shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[11px] font-mono text-x-ink-secondary font-semibold truncate max-w-[400px]" title={gitSelectedFile || 'All changed files'}>
                    {gitSelectedFile || 'All changed files'}
                  </span>
                </div>
                
                <div className="flex items-center gap-2">
                  {/* Find search inside diff */}
                  <div className="flex items-center gap-1 w-40 px-2 py-1 rounded-lg bg-x-surface-2 border border-x-line-subtle">
                    <Search size={11} className="text-x-faint shrink-0" />
                    <input
                      value={gitDiffSearchQuery}
                      onChange={(e) => setGitDiffSearchQuery(e.target.value)}
                      placeholder="Find..."
                      className="w-full bg-transparent text-[11px] font-mono text-x-ink-secondary placeholder:text-x-faint focus:outline-none"
                    />
                    {gitDiffSearchQuery && (
                      <button
                        type="button"
                        onClick={() => setGitDiffSearchQuery('')}
                        className="text-x-faint hover:text-x-ink-secondary"
                      >
                        <X size={11} />
                      </button>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={handleAnnotateBrowserSelection}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-lg border border-x-accent/20 text-x-accent hover:bg-x-accent/10 hover:border-x-accent/35 transition-colors text-[11px] font-mono"
                    title="Mark the currently highlighted diff text for annotation"
                  >
                    <Edit3 size={11} />
                    <span>Annotate</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyReviewText}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-lg border border-x-line text-x-ink-secondary hover:text-x-ink hover:bg-x-hover transition-colors text-[11px] font-mono"
                    title="Copy highlighted text, selected lines, or the current diff"
                  >
                    {reviewCopied ? <Check size={11} className="text-x-good" /> : <Copy size={11} />}
                    <span>{reviewCopied ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
              </div>

              {/* Scrollable Viewport */}
              {gitLoading ? (
                <div className="flex-1 flex flex-col items-center justify-center text-x-muted">
                  <Loader2 size={24} className="animate-spin text-x-accent mb-2" />
                  <span className="text-[12px] font-mono">Loading diff...</span>
                </div>
              ) : gitDiffText ? (
                <div className="flex-1 flex flex-col min-h-0">
                  <div className="flex-1 overflow-auto bg-x-surface-2 p-4 font-mono text-[11px] leading-5 scrollbar-thin select-text">
                    
                    {viewMode === 'unified' ? (
                      /* Unified View */
                      <div className="space-y-0.5">
                        {parsedDiff.map((line, idx) => {
                          const isSel = reviewSelectedLines.has(idx)
                          const isSelectable = isReviewSelectable(line)
                          const groupFirstIdx = reviewGroupEnds.get(idx)
                          const commentForGroup = groupFirstIdx != null ? (reviewComments[groupFirstIdx] ?? '') : null
                          
                          if (line.type === 'file-header') {
                            return (
                              <div key={idx} className={`py-0.5 px-2 ${line.text.startsWith('diff --git') ? 'mt-3 bg-x-hover text-x-ink-secondary font-semibold' : 'text-x-muted'} rounded`}>
                                {renderDiffTextWithSearch(line.text, gitDiffSearchQuery)}
                              </div>
                            )
                          }
                          if (line.type === 'hunk-header') {
                            return (
                              <div key={idx} className="py-0.5 px-2 text-x-accent/90 bg-x-accent/[0.06] rounded">
                                {renderDiffTextWithSearch(line.text, gitDiffSearchQuery)}
                              </div>
                            )
                          }
                          const codeText = line.text.startsWith('+') || line.text.startsWith('-') || line.text.startsWith(' ')
                            ? line.text.slice(1)
                            : line.text
                          const rowTone = line.type === 'add'
                            ? 'bg-x-good/[0.045]'
                            : line.type === 'remove'
                              ? 'bg-x-accent-ink/[0.05]'
                              : ''
                          const lineLang = line.file ? detectLang(line.file) : null

                          return (
                            <div key={idx} className="flex flex-col animate-fadeIn">
                              <div
                                onClick={isSelectable ? (e) => handleReviewLineClick(idx, e) : undefined}
                                className={`py-0.5 px-2 rounded flex items-start gap-2 transition-colors select-none ${
                                  isSel
                                    ? 'bg-x-accent/15 border-l-2 border-x-accent'
                                    : `${rowTone} ${isSelectable ? 'hover:bg-x-hover cursor-pointer' : ''}`
                                }`}
                                title={isSelectable ? 'Click to select. Shift+click for range.' : undefined}
                              >
                                <span
                                  className={`w-8 shrink-0 text-right pr-2 rounded-sm font-bold ${
                                    isSelectable
                                      ? isSel
                                        ? 'text-x-accent bg-x-accent/20'
                                        : line.type === 'add'
                                          ? 'text-x-good'
                                          : line.type === 'remove'
                                            ? 'text-x-accent-ink'
                                            : 'text-x-muted'
                                      : 'text-x-faint/50'
                                  }`}
                                >
                                  {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : isSelectable ? ' ' : ''}
                                </span>
                                <span className="flex-1 break-all whitespace-pre-wrap text-x-ink">
                                  {renderDiffLineWithSyntax(codeText, lineLang, gitDiffSearchQuery, line.file)}
                                </span>
                              </div>

                              {commentForGroup != null && (
                                <div
                                  className="flex items-start ml-10 mr-2 my-1.5 pl-3 pr-2 py-2 bg-x-accent-ink/8 border border-x-accent-ink/25 rounded-lg"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <span className="text-x-accent-ink text-xs font-semibold shrink-0 pt-0.5 mr-2">{'→'}</span>
                                  <textarea
                                    ref={(el) => { if (el) reviewCommentRefs.current[groupFirstIdx] = el }}
                                    value={commentForGroup}
                                    onChange={(e) => setReviewComment(groupFirstIdx, e.target.value)}
                                    placeholder="your comment..."
                                    rows={Math.max(1, commentForGroup.split('\n').length)}
                                    className="flex-1 bg-transparent text-[11px] text-x-accent-ink/90 placeholder:text-x-accent-ink/30 focus:outline-none resize-none min-h-[22px] font-mono"
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) e.stopPropagation()
                                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); handleSendReviewFeedback() }
                                      if (e.key === 'Escape') { e.stopPropagation(); e.target.blur() }
                                    }}
                                  />
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      /* Split View */
                      <div className="flex flex-col gap-0.5 select-text min-w-[700px]">
                        {alignDiffLines(parsedDiff).map((row, rowIdx) => {
                          if (row.type === 'header') {
                            const line = row.line
                            return (
                              <div key={rowIdx} className={`py-1 px-3 rounded text-[11px] font-mono font-semibold ${
                                line.text.startsWith('diff --git') 
                                  ? 'mt-4 bg-x-hover text-x-ink-secondary border border-x-line-subtle' 
                                  : 'text-x-accent/90 bg-x-accent/[0.06] mt-2'
                              }`}>
                                {renderDiffTextWithSearch(line.text, gitDiffSearchQuery)}
                              </div>
                            )
                          }

                          const left = row.left
                          const right = row.right

                          const isLeftSel = left ? reviewSelectedLines.has(left.idx) : false
                          const isRightSel = right ? reviewSelectedLines.has(right.idx) : false

                          const leftText = left 
                            ? (left.line.text.startsWith('-') || left.line.text.startsWith(' ') ? left.line.text.slice(1) : left.line.text) 
                            : ''
                          const rightText = right 
                            ? (right.line.text.startsWith('+') || right.line.text.startsWith(' ') ? right.line.text.slice(1) : right.line.text) 
                            : ''

                          const isLeftSelectable = left && isReviewSelectable(left.line)
                          const isRightSelectable = right && isReviewSelectable(right.line)

                          // Comments
                          const leftCommentFirstIdx = left ? reviewGroupEnds.get(left.idx) : null
                          const rightCommentFirstIdx = right ? reviewGroupEnds.get(right.idx) : null
                          const commentGroupFirstIdx = leftCommentFirstIdx ?? rightCommentFirstIdx
                          const commentForGroup = commentGroupFirstIdx != null ? (reviewComments[commentGroupFirstIdx] ?? '') : null

                          return (
                            <div key={rowIdx} className="flex flex-col animate-fadeIn">
                              <div className="flex w-full border-b border-x-line-subtle hover:bg-x-hover">
                                {/* Left Cell (Original) */}
                                <div className={`flex-1 flex min-w-0 border-r border-x-line-subtle py-0.5 px-2 ${
                                  isLeftSel ? 'bg-x-accent/12 border-l-2 border-x-accent' : left?.line.type === 'remove' ? 'bg-x-accent-ink/[0.05]' : ''
                                }`}>
                                  {left ? (
                                    <>
                                      <button
                                        type="button"
                                        disabled={!isLeftSelectable}
                                        onMouseDown={isLeftSelectable ? (e) => e.preventDefault() : undefined}
                                        onClick={isLeftSelectable ? (e) => handleReviewLineClick(left.idx, e) : undefined}
                                        className={`w-6 shrink-0 text-right pr-2 rounded-sm select-none font-semibold text-[11px] ${
                                          isLeftSelectable
                                            ? isLeftSel
                                              ? 'text-x-accent bg-x-accent/20'
                                              : 'text-x-accent-ink/80 hover:bg-x-accent-ink/10'
                                            : 'text-x-faint/30'
                                        }`}
                                      >
                                        {left.line.type === 'remove' ? '-' : ' '}
                                      </button>
                                      <span className="flex-1 break-all whitespace-pre-wrap text-x-accent-ink/90 font-mono pl-1">
                                        {renderDiffLineWithSyntax(leftText, left.line.file ? detectLang(left.line.file) : null, gitDiffSearchQuery, left.line.file)}
                                      </span>
                                    </>
                                  ) : (
                                    <div className="flex-1 select-none opacity-20 font-mono text-x-faint">~</div>
                                  )}
                                </div>

                                {/* Right Cell (Modified) */}
                                <div className={`flex-1 flex min-w-0 py-0.5 px-2 ${
                                  isRightSel ? 'bg-x-accent/12 border-l-2 border-x-accent' : right?.line.type === 'add' ? 'bg-x-good/[0.045]' : ''
                                }`}>
                                  {right ? (
                                    <>
                                      <button
                                        type="button"
                                        disabled={!isRightSelectable}
                                        onMouseDown={isRightSelectable ? (e) => e.preventDefault() : undefined}
                                        onClick={isRightSelectable ? (e) => handleReviewLineClick(right.idx, e) : undefined}
                                        className={`w-6 shrink-0 text-right pr-2 rounded-sm select-none font-semibold text-[11px] ${
                                          isRightSelectable
                                            ? isRightSel
                                              ? 'text-x-accent bg-x-accent/20'
                                              : 'text-x-good/80 hover:bg-x-good/10'
                                            : 'text-x-faint/30'
                                        }`}
                                      >
                                        {right.line.type === 'add' ? '+' : ' '}
                                      </button>
                                      <span className="flex-1 break-all whitespace-pre-wrap text-x-good/90 font-mono pl-1">
                                        {renderDiffLineWithSyntax(rightText, right.line.file ? detectLang(right.line.file) : null, gitDiffSearchQuery, right.line.file)}
                                      </span>
                                    </>
                                  ) : (
                                    <div className="flex-1 select-none opacity-20 font-mono text-x-faint">~</div>
                                  )}
                                </div>
                              </div>

                              {/* Comment box inline span across both columns */}
                              {commentForGroup != null && (
                                <div className="my-2 mx-8 p-3 bg-x-accent-ink/8 rounded-lg border border-x-accent-ink/25">
                                  <div className="flex items-start gap-2">
                                    <span className="text-x-accent-ink text-xs font-semibold shrink-0 pt-0.5">{'→'}</span>
                                    <textarea
                                      value={commentForGroup}
                                      onChange={(e) => setReviewComment(commentGroupFirstIdx, e.target.value)}
                                      placeholder="your comment on this block..."
                                      rows={Math.max(2, commentForGroup.split('\n').length)}
                                      className="flex-1 bg-transparent text-[11px] text-x-accent-ink/90 placeholder:text-x-accent-ink/30 focus:outline-none resize-y min-h-[40px] font-mono"
                                      onKeyDown={(e) => {
                                        if (e.key === 'Escape') { e.stopPropagation(); e.target.blur() }
                                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                          e.preventDefault(); e.stopPropagation()
                                          handleSendReviewFeedback()
                                        }
                                      }}
                                    />
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}

                  </div>

                  {/* Actions footer — same "Review →" split-button as the
                      sidebar, just larger so it has presence in fullscreen. */}
                  <div className="p-4 border-t border-x-line-subtle bg-x-bg flex items-center gap-3 select-none shrink-0">
                    <div className="relative flex-1 max-w-[420px]">
                      <div className="flex items-stretch rounded-xl overflow-hidden shadow-x-1">
                        <button
                          type="button"
                          onClick={() => {
                            if (reviewGroups.length > 0) handleSendReviewFeedback()
                            else { setReviewAgentError(null); setReviewAgentOpen(true) }
                          }}
                          className="flex-1 py-2 px-4 bg-x-accent hover:bg-x-accent-ink text-x-on-accent font-mono text-xs font-semibold flex items-center justify-center gap-2 transition-all"
                          title={reviewGroups.length > 0
                            ? `Send ${reviewGroups.length} annotation${reviewGroups.length !== 1 ? 's' : ''} into the active session`
                            : 'Spawn an agent to review this diff'}
                        >
                          <span>Review</span>
                          {reviewGroups.length > 0 && (
                            <span className="text-x-on-accent/90 text-[11px]">({reviewGroups.length})</span>
                          )}
                          <ArrowRight size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setReviewMenuOpen((s) => !s)}
                          className="px-3 bg-x-accent/80 hover:bg-x-accent text-x-on-accent border-l border-x-on-accent/20 flex items-center"
                          title="More review options"
                          aria-expanded={reviewMenuOpen}
                        >
                          <ChevronUp size={13} className={`transition-transform ${reviewMenuOpen ? '' : 'rotate-180'}`} />
                        </button>
                      </div>
                      {reviewMenuOpen && (
                        <>
                          <div className="fixed inset-0 z-30" onClick={() => setReviewMenuOpen(false)} />
                          <div className="absolute bottom-full mb-2 right-0 z-40 w-[300px] rounded-xl border border-x-line bg-x-surface shadow-x-1 overflow-hidden">
                            {reviewGroups.length > 0 && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => { setReviewMenuOpen(false); handleSendReviewFeedback() }}
                                  className="w-full flex items-start gap-2 px-3 py-2.5 text-left hover:bg-x-hover transition-colors"
                                >
                                  <Send size={13} className="text-x-accent mt-0.5 shrink-0" />
                                  <div className="flex-1 min-w-0">
                                    <div className="text-xs font-mono text-x-ink">Send {reviewGroups.length} to active session</div>
                                    <div className="text-[11px] text-x-muted">Drops the annotations into the running CLI</div>
                                  </div>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => { setReviewMenuOpen(false); handleCopyReviewText() }}
                                  className="w-full flex items-start gap-2 px-3 py-2.5 text-left hover:bg-x-hover transition-colors border-t border-x-line-subtle"
                                >
                                  <Copy size={13} className="text-x-ink-secondary mt-0.5 shrink-0" />
                                  <div className="flex-1 min-w-0">
                                    <div className="text-xs font-mono text-x-ink">Copy selected ({reviewSelectedLines.size})</div>
                                    <div className="text-[11px] text-x-muted">Plain text on the clipboard</div>
                                  </div>
                                </button>
                              </>
                            )}
                            <button
                              type="button"
                              onClick={() => { setReviewMenuOpen(false); setReviewAgentError(null); setReviewAgentOpen(true) }}
                              className={`w-full flex items-start gap-2 px-3 py-2.5 text-left hover:bg-x-hover transition-colors ${reviewGroups.length > 0 ? 'border-t border-x-line-subtle' : ''}`}
                            >
                              <Bot size={13} className="text-x-accent mt-0.5 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-mono text-x-ink">Review with Agent…</div>
                                <div className="text-[11px] text-x-muted">Fresh agent + configurable prompt</div>
                              </div>
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-x-muted italic text-xs">
                  No diff loaded. Select a changed file from the list.
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

function SidebarReviewAgentModal({
  onClose, prompt, setPrompt, onSavePrompt, onResetPrompt, saved,
  mode, setMode, busy, error, onSubmit, configuredProvider, resolvedCliType,
  annotationsCount, diffSize, sessions, targetSessionId, setTargetSessionId, activeSessionId,
}) {
  const providerText = configuredProvider === 'active'
    ? `${reviewProviderLabel(configuredProvider)} -> ${reviewProviderLabel(resolvedCliType)}`
    : reviewProviderLabel(resolvedCliType)

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-x-scrim backdrop-blur-[4px] p-3"
      onClick={onClose}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="w-full max-h-full flex flex-col rounded-xl border border-x-line bg-x-surface shadow-x-1 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-x-line bg-x-surface-2 shrink-0">
          <Bot size={13} className="text-x-accent" />
          <span className="text-[12px] font-mono font-semibold text-x-ink">Review with Agent</span>
          <span className="text-[11px] font-mono text-x-faint">
            {(diffSize / 1024).toFixed(1)}KB
            {annotationsCount ? ` · ${annotationsCount} note${annotationsCount !== 1 ? 's' : ''}` : ''}
          </span>
          <div className="flex-1" />
          <button onClick={onClose} className="p-1 rounded text-x-muted hover:text-x-ink hover:bg-x-hover">
            <X size={13} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <div>
            <div className="text-[11px] font-mono uppercase tracking-wide text-x-faint mb-1.5">Destination</div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setMode('new')}
                className={`px-2 py-2 rounded-lg border text-left transition-colors ${
                  mode === 'new'
                    ? 'bg-x-accent/15 border-x-accent/35 text-x-accent'
                    : 'bg-x-surface-2 border-x-line text-x-ink-secondary hover:text-x-ink'
                }`}
              >
                <div className="text-[11px] font-mono font-semibold">New agent</div>
                <div className="text-[11px] font-mono text-x-faint truncate">{providerText}</div>
              </button>
              <button
                type="button"
                onClick={() => setMode('current')}
                disabled={!activeSessionId}
                className={`px-2 py-2 rounded-lg border text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  mode === 'current'
                    ? 'bg-x-accent/15 border-x-accent/35 text-x-accent'
                    : 'bg-x-surface-2 border-x-line text-x-ink-secondary hover:text-x-ink'
                }`}
              >
                <div className="text-[11px] font-mono font-semibold">Existing</div>
                <div className="text-[11px] font-mono text-x-faint">Send into selected session</div>
              </button>
            </div>
            {mode === 'current' && sessions.length > 0 && (
              <select
                value={targetSessionId || ''}
                onChange={(e) => setTargetSessionId(e.target.value)}
                className="mt-2 w-full px-2 py-1.5 text-[11px] font-mono bg-x-surface-2 border border-x-line rounded-lg text-x-ink-secondary focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || `Session ${s.id.slice(0, 6)}`}{s.id === activeSessionId ? ' (active)' : ''}{s.cli_type ? ` · ${s.cli_type}` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <Edit3 size={10} className="text-x-muted" />
              <span className="text-[11px] font-mono uppercase tracking-wide text-x-faint">Prompt</span>
              <span className="text-[11px] font-mono text-x-faint">use {'{diff}'} and {'{annotations}'}</span>
              <div className="flex-1" />
              <button
                type="button"
                onClick={onSavePrompt}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-transparent hover:bg-x-hover text-[11px] font-mono text-x-ink-secondary hover:text-x-ink transition-colors"
              >
                {saved ? <Check size={9} className="text-x-good" /> : <Save size={9} />}
                {saved ? 'Saved' : 'Save'}
              </button>
              <button
                type="button"
                onClick={onResetPrompt}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-transparent hover:bg-x-hover text-[11px] font-mono text-x-ink-secondary hover:text-x-ink transition-colors"
              >
                <RotateCcw size={9} />
                Reset
              </button>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full h-[210px] px-2.5 py-2 text-[11px] leading-4 font-mono bg-x-surface-2 border border-x-line rounded-lg text-x-ink placeholder:text-x-faint resize-y focus:outline-none focus:border-x-accent focus:ring-[3px] focus:ring-x-focus"
            />
          </div>

          {error && (
            <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-x-accent-ink/10 border border-x-accent-ink/25 text-[11px] font-mono text-x-accent-ink">
              <AlertTriangle size={11} />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-3 py-2 border-t border-x-line bg-x-surface-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              window.dispatchEvent(new CustomEvent('open-panel', { detail: 'code-review' }))
              requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('code-review:open-agent')))
            }}
            className="px-2 py-1.5 rounded-lg border border-x-line text-[11px] font-mono text-x-muted hover:text-x-ink hover:bg-x-hover"
          >
            Advanced
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="px-2.5 py-1.5 rounded-lg bg-transparent hover:bg-x-hover text-[11px] font-mono text-x-ink-secondary hover:text-x-ink transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || !prompt.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-x-accent/30 bg-x-accent/20 text-[11px] font-mono font-semibold text-x-accent hover:bg-x-accent/30 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Bot size={11} />}
            {busy ? 'Starting...' : mode === 'new' ? 'Spawn Review' : 'Send Review'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Sidebar file-tree section ──────────────────────────────────────────
// One per stage (staged/unstaged/untracked). Files are grouped by directory
// and rendered as a two-level tree. Dirs are open by default — passing
// `false` for a `<section>-<dir>` key collapses just that directory.

function SidebarFileSection({ label, color, files, expanded, onToggle, gitExpandedDirs, onToggleDir, selectedFile, onSelect, onStage, onUnstage }) {
  const tree = useMemo(() => buildSidebarFileTree(files), [files])
  return (
    <div className="mb-1">
      <button
        onClick={onToggle}
        className={`w-full flex items-center gap-1 px-2 py-1 text-[11px] font-mono uppercase tracking-wide ${color} hover:bg-x-hover`}
      >
        {expanded ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
        <span>{label}</span>
        <span className="text-x-muted">({files.length})</span>
      </button>
      {expanded && (
        <>
          {tree.dirs.map(({ dir, files: dirFiles }) => {
            const dirKey = `${label}-${dir}`
            const dirOpen = gitExpandedDirs[dirKey] !== false
            return (
              <div key={dirKey}>
                <button
                  onClick={() => onToggleDir(dirKey)}
                  className="w-full flex items-center gap-1 pl-4 pr-2 py-0.5 text-[11px] font-mono text-x-muted hover:bg-x-hover"
                >
                  {dirOpen ? <ChevronDown size={8} /> : <ChevronRight size={8} />}
                  <FolderOpen size={9} className="text-x-faint" />
                  <span className="truncate">{dir}</span>
                </button>
                {dirOpen && dirFiles.map((f) => (
                  <SidebarFileButton
                    key={f.path}
                    file={f}
                    selected={selectedFile === f.path}
                    onClick={() => onSelect(f.path)}
                    onStage={onStage}
                    onUnstage={onUnstage}
                    indent
                  />
                ))}
              </div>
            )
          })}
          {tree.rootFiles.map((f) => (
            <SidebarFileButton
              key={f.path}
              file={f}
              selected={selectedFile === f.path}
              onClick={() => onSelect(f.path)}
              onStage={onStage}
              onUnstage={onUnstage}
            />
          ))}
        </>
      )}
    </div>
  )
}

function SidebarFileButton({ file, selected, onClick, indent, onStage, onUnstage }) {
  const filename = file.path.split('/').pop()
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={file.path}
      className={`w-full flex items-center gap-1.5 ${indent ? 'pl-8' : 'pl-4'} pr-2 py-0.5 text-[11px] font-mono transition-colors relative group ${
        selected ? 'bg-x-accent/15 text-x-accent' : 'text-x-ink-secondary hover:bg-x-hover hover:text-x-ink'
      }`}
    >
      <FileIcon status={file.status} />
      <span className="truncate flex-1 text-left">{filename}</span>
      {hovered && (
        <div className="flex items-center gap-1">
          {onStage && file.status !== 'staged' && (
            <span
              onClick={(e) => { e.stopPropagation(); onStage(file.path) }}
              className="px-1 py-0.2 bg-x-good/20 text-x-good rounded hover:bg-x-good/40 text-[11px] font-semibold cursor-pointer"
              title="Stage file"
            >
              + Stage
            </span>
          )}
          {onUnstage && (file.status === 'staged' || file.status === 'M' || file.status === 'A' || file.status === 'D') && (
            <span
              onClick={(e) => { e.stopPropagation(); onUnstage(file.path) }}
              className="px-1 py-0.2 bg-x-accent-ink/20 text-x-accent-ink rounded hover:bg-x-accent-ink/40 text-[11px] font-semibold cursor-pointer"
              title="Unstage file"
            >
              - Unstage
            </span>
          )}
        </div>
      )}
      {!hovered && (
        <span className="text-[11px] text-x-muted shrink-0 uppercase">{file.status}</span>
      )}
    </button>
  )
}
