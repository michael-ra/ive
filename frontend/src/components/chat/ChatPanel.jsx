import CommandQueue from './CommandQueue'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import SessionContextNotice from '../session/SessionContextNotice'
import SessionBrief from '../session/SessionBrief'
import { unwrapMessage, presentText } from '../../lib/sessionBrief'
import PermissionModePicker from './PermissionModePicker'
import { changePermissionMode, applyPermissionModeNow } from '../../lib/permissionMode'
import ProviderLogo from '../ui/ProviderLogo'
import ReplyPending from './ReplyPending'
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, memo } from 'react'
import { Send, Sparkles, Terminal, Copy, Check, MessageSquare, AlertCircle, X, ArrowDown, Paperclip, UploadCloud, Clock, Shield, Hash, Activity, ChevronDown, ChevronLeft, ChevronRight, Square, Mic, MicOff, Trash2, FileText, Image as ImageIcon, Film, Music, FileQuestion, Code2, Archive, Loader2 } from 'lucide-react'
import { api } from '../../lib/api'
import { SLASH_COMMANDS } from '../../lib/slashCommands'
import { applyMessageDelta, coalesce, cursorGeneration, prependOlderRows } from '../../lib/messageCursor'
import { interruptTerminalOutput, sendTerminalCommand, cancelQueuedCommand } from '../../lib/terminal'
import useStore from '../../state/store'
import ImageAnnotator from './ImageAnnotator'
import TokenChips from './TokenChips'
import { useVoiceInput } from '../../hooks/useVoiceInput'
import { getPermissionModesForCli, getModelsForCli, getEffortOptionsForCli } from '../../lib/constants'
import { headerModelInfo, effortDefaultValue } from '../../lib/effort'
import LaunchSettingPicker from './LaunchSettingPicker'
import { getSessionStatusMeta, hasSessionStarted, getSessionDisplayStatus } from '../../lib/sessionStatus'
import { formatElapsed, isSessionWaiting, isSessionWorking, isTerminalVisibleSession } from '../../lib/sessionRuntime'
import { detectLang, tokenizeLine } from '../../lib/syntaxHighlight'
import { addRecentAnnotations, loadRecentAnnotations, saveRecentAnnotations } from '../../lib/annotations'
import { createUsageOnceFilter } from '../../lib/usageOnce'
import { getChatActivity } from '../../lib/chatActivity'
import SessionPromptActions from '../session/SessionPromptActions'
import { activityLabel, hasVisibleMessage } from '../../lib/conversationPresentation'
import ChatFindBar from '../find/ChatFindBar'
import ComposerQueue from './ComposerQueue'
import { useComposerQueue } from '../../hooks/useComposerQueue'
import { enqueueMessage, noteDirectSend, queueSupported } from '../../lib/composerQueue'
import ContextChips, { ContextMentionRow, ContextSearchStatus, keepOptionVisible } from './ContextChips'
import { queuedContextItems } from '../../lib/chatContext'
import { focusChatComposerFor } from '../../lib/sessionInputFocus'
import { useChatContext, useContextSearch } from '../../hooks/useChatContext'

const EMPTY_MESSAGES = Object.freeze([])
const BTW_COMMAND = { cmd: '/btw', desc: 'Ask on the side with this task’s context' }

// Long sessions: the first request asks only for the newest rows; older ones
// load page by page when the user scrolls back ("Show earlier"). The panel
// renders only the newest groups of what is loaded.
const TRANSCRIPT_TAIL_ROWS = 300
const TRANSCRIPT_PAGE_ROWS = 300
const RENDER_GROUPS_INITIAL = 40
const RENDER_GROUPS_STEP = 60

// Transcript rows as the server sent them, per session, shared by every
// panel of that session (Overview tile and full view write the same store
// list, so they must agree on the window). { rows, cursor, base, before }
const transcriptStates = new Map()
const EMPTY_CHAT_DRAFT = Object.freeze({
  pastedImages: EMPTY_MESSAGES,
  pendingAnnotation: null,
  annotationNote: '',
  textAnnotations: EMPTY_MESSAGES,
  showProcessing: false,
})

/**
 * A highly robust JSON parser that handles literal control characters (newlines, tabs)
 * inside double-quoted string values, which standard JSON.parse fails on.
 */
function safeJsonParse(str) {
  try {
    return JSON.parse(str)
  } catch (e) {
    try {
      let inQuotes = false
      let escaped = ''
      for (let i = 0; i < str.length; i++) {
        const char = str[i]
        if (char === '"' && (i === 0 || str[i - 1] !== '\\')) {
          inQuotes = !inQuotes
          escaped += char
        } else if (inQuotes) {
          if (char === '\n') escaped += '\\n'
          else if (char === '\r') escaped += '\\r'
          else if (char === '\t') escaped += '\\t'
          else escaped += char
        } else {
          escaped += char
        }
      }
      return JSON.parse(escaped)
    } catch (err) {
      throw e
    }
  }
}

/**
 * Parses lines representing a markdown table.
 */
function parseTableLines(lines, startIndex) {
  const tableLines = []
  let i = startIndex
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      tableLines.push(trimmed)
      i++
    } else {
      break
    }
  }

  if (tableLines.length >= 2) {
    const secondLine = tableLines[1].trim()
    const isSeparator = /^\|?(\s*:?-+:?\s*\|?)+$/.test(secondLine)
    if (isSeparator) {
      return { tableLines, nextIndex: i }
    }
  }
  return null
}

/**
 * Renders a markdown table into premium visual layout matching IVE guidelines.
 */
function renderTable(tableLines, key) {
  if (tableLines.length < 2) return null

  const headers = tableLines[0]
    .split('|')
    .slice(1, -1)
    .map((s) => s.trim())

  const alignments = tableLines[1]
    .split('|')
    .slice(1, -1)
    .map((s) => {
      const t = s.trim()
      const start = t.startsWith(':')
      const end = t.endsWith(':')
      if (start && end) return 'center'
      if (end) return 'right'
      return 'left'
    })

  const rows = tableLines.slice(2).map((line) =>
    line
      .split('|')
      .slice(1, -1)
      .map((s) => s.trim())
  )

  return (
    <div key={`table-${key}`} className="overflow-x-auto my-2 border border-x-line rounded-lg bg-x-surface-2 max-w-full">
      <table className="min-w-full divide-y divide-x-line-subtle text-xs">
        <thead className="bg-x-hover text-x-ink-secondary font-semibold uppercase tracking-wider text-[11px]">
          <tr>
            {headers.map((h, i) => (
              <th
                key={i}
                style={{ textAlign: alignments[i] || 'left' }}
                className="px-2.5 py-1.5 text-left border-r border-x-line-subtle/40 last:border-r-0"
              >
                {parseInlineFormatting(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-x-line-subtle/30 bg-transparent text-x-ink/95 font-sans">
          {rows.map((row, rIdx) => (
            <tr key={rIdx} className="hover:bg-x-hover/10 transition-colors">
              {row.map((cell, cIdx) => (
                <td
                  key={cIdx}
                  style={{ textAlign: alignments[cIdx] || 'left' }}
                  className="px-2.5 py-1.5 border-r border-x-line-subtle/30 last:border-r-0 break-words whitespace-normal max-w-[220px]"
                >
                  {parseInlineFormatting(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const CODE_TOKEN_CLASS = {
  keyword: 'text-[color:var(--x-accent-ink)]',
  string: 'text-[color:var(--x-good)]',
  comment: 'text-[color:var(--x-muted)] italic',
  number: 'text-[color:var(--x-accent-ink)]',
  punctuation: 'text-x-ink-secondary',
  default: 'text-x-ink',
}

// Longest extensions first plus a word end: package.json must not become the
// chip "package.js" followed by "on".
const PATH_RE = /(file:\/\/\/*[A-Za-z0-9_./@-]+(?:\.[A-Za-z0-9]+)?(?::\d+)?|(?:~?\/|\.{1,2}\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./@-]+(?:\.[A-Za-z0-9]+)?(?::\d+)?|[A-Za-z0-9_.-]+\.(?:json|jsx|js|tsx|ts|py|mdx|md|scss|css|html|xml|yaml|yml|toml|rs|go|java|kt|rb|sh|sql)(?![A-Za-z0-9])(?::\d+)?)/g

function normalizeFenceLang(lang, code) {
  const raw = (lang || '').trim().toLowerCase()
  if (raw) return detectLang(`x.${raw}`) || raw
  const trimmed = code.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return 'json'
  }
  return null
}

function prettyCodeForLang(code, lang) {
  if (lang !== 'json') return code.trimEnd()
  try {
    return JSON.stringify(safeJsonParse(code.trim()), null, 2)
  } catch {
    return code.trimEnd()
  }
}

function renderCodeLine(line, lang, keyPrefix) {
  return tokenizeLine(line, lang).map((tok, i) => (
    <span key={`${keyPrefix}-${i}`} className={CODE_TOKEN_CLASS[tok.type] || CODE_TOKEN_CLASS.default}>
      {tok.text}
    </span>
  ))
}

function renderInlinePlain(text, keyPrefix) {
  if (!text) return text
  const parts = []
  let last = 0
  let match
  PATH_RE.lastIndex = 0

  while ((match = PATH_RE.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const filePathWithLine = match[0]
    let baseFilePath = filePathWithLine.replace(/:\d+(?::\d+)?$/, '')
    if (baseFilePath.startsWith('file://')) {
      baseFilePath = baseFilePath.replace(/^file:\/\/\/*/, '/')
    }
    if (baseFilePath.startsWith('/')) {
      baseFilePath = '/' + baseFilePath.replace(/^\/+/, '')
    }
    parts.push(
      <button
        type="button"
        key={`${keyPrefix}-path-${match.index}`}
        onClick={(e) => {
          e.stopPropagation()
          const currentActiveSessionId = e.currentTarget.closest('[data-session-view], [data-grid-cell-session]')?.dataset.sessionView || e.currentTarget.closest('[data-grid-cell-session]')?.dataset.gridCellSession || useStore.getState().activeSessionId
          const currentSession = useStore.getState().sessions[currentActiveSessionId]
          const currentWorkspaceId = currentSession?.workspace_id || useStore.getState().activeWorkspaceId

          if (!currentWorkspaceId) {
            useStore.getState().addNotification({
              type: 'warning',
              message: 'No active workspace found to open file in IDE.',
            })
            return
          }

          if (baseFilePath) {
            api.openInIde(currentWorkspaceId, baseFilePath).catch((e) => {
              useStore.getState().addNotification({
                type: 'warning',
                message: `Failed to open file: ${e.message}`,
              })
            })
          }
        }}
        title={`Click to open ${baseFilePath} in IDE`}
        className="border-0 bg-transparent p-0 font-mono text-[12px] text-x-ink-secondary underline decoration-x-line-strong underline-offset-2 break-all cursor-pointer hover:text-x-ink"
      >
        {filePathWithLine}
      </button>
    )
    last = PATH_RE.lastIndex
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function safeFenceBody(value) {
  return String(value ?? '').replace(/```/g, "'''")
}

function previewToolValue(value) {
  if (value == null) return ''
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    const clean = value.replace(/\s+/g, ' ').trim()
    return clean.length > 180 ? `${clean.slice(0, 177)}...` : clean
  }
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`
  if (typeof value === 'object') return `${Object.keys(value).length} field${Object.keys(value).length === 1 ? '' : 's'}`
  return String(value)
}

function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 || value >= 10 ? 0 : 1)} ${units[unit]}`
}

function toolPathFromInput(input) {
  if (!isPlainObject(input)) return ''
  return input.file_path || input.path || input.file || input.filename || ''
}

function shouldPreviewToolFile(name, input, command) {
  const path = toolPathFromInput(input)
  if (!path || command) return false
  const tool = String(name || '').toLowerCase()
  return tool.includes('read') || tool.includes('view') || tool.includes('open') || String(path).includes('/pastes/')
}

function filePreviewLang(info, path) {
  const detected = detectLang(path || info?.name || '')
  if (detected) return detected
  const mime = String(info?.mime_type || '').toLowerCase()
  if (mime.includes('json')) return 'json'
  if (mime.includes('javascript')) return 'javascript'
  if (mime.includes('typescript')) return 'typescript'
  if (mime.includes('html')) return 'html'
  if (mime.includes('css')) return 'css'
  if (mime.includes('markdown')) return 'markdown'
  return null
}

function fileKindMeta(kind) {
  if (kind === 'image') return { icon: ImageIcon, label: 'Image preview', tone: 'text-x-ink-secondary border-x-line bg-x-surface' }
  if (kind === 'video') return { icon: Film, label: 'Video preview', tone: 'text-x-ink-secondary border-x-line bg-x-surface' }
  if (kind === 'audio') return { icon: Music, label: 'Audio preview', tone: 'text-x-ink-secondary border-x-line bg-x-surface' }
  if (kind === 'text') return { icon: FileText, label: 'File preview', tone: 'text-x-ink-secondary border-x-line bg-x-surface' }
  return { icon: FileQuestion, label: 'File preview', tone: 'text-x-faint border-x-line bg-x-surface' }
}

function formatToolUseBlock(block) {
  const name = block?.name || 'tool'
  const input = block?.input
  const header = `**Calling tool: ${name}**`
  if (!input) return header

  if (!isPlainObject(input)) {
    return `${header}\n\`\`\`\n${safeFenceBody(typeof input === 'string' ? input : JSON.stringify(input, null, 2))}\n\`\`\``
  }

  const command = input.command || input.cmd || input.shell_command
  const description = input.description || input.summary || input.reason
  const path = input.file_path || input.path || input.file || input.filename

  const lines = [header]
  if (description) lines.push(`- Description: ${previewToolValue(description)}`)
  if (path) lines.push(`- Path: \`${previewToolValue(path)}\``)

  if (command) {
    lines.push(`\`\`\`bash\n${safeFenceBody(command)}\n\`\`\``)
    return lines.join('\n')
  }

  const noisyKeys = new Set([
    'description', 'summary', 'reason', 'command', 'cmd', 'shell_command',
    'content', 'new_string', 'old_string', 'patch', 'text',
  ])
  const summaryFields = Object.entries(input)
    .filter(([key]) => !noisyKeys.has(key))
    .slice(0, 6)
    .map(([key, value]) => `- ${key}: ${previewToolValue(value)}`)
    .filter((line) => !line.endsWith(': '))

  if (summaryFields.length > 0) return [...lines, ...summaryFields].join('\n')

  return `${header}\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``
}

function textLineCount(text) {
  const clean = String(text || '').trimEnd()
  if (!clean) return 0
  return clean.split('\n').length
}

function firstLines(text, maxLines = 2) {
  const lines = String(text || '').trimEnd().split('\n')
  if (lines.length <= maxLines) return lines.join('\n')
  return `${lines.slice(0, maxLines).join('\n')}\n... ${lines.length - maxLines} more line${lines.length - maxLines === 1 ? '' : 's'}`
}

function toolResultText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item
      if (item?.text) return item.text
      return JSON.stringify(item, null, 2)
    }).filter(Boolean).join('\n')
  }
  if (typeof content === 'object') return JSON.stringify(content, null, 2)
  return String(content)
}

function parseBackgroundTaskStart(text) {
  const clean = String(text || '')
  const doneMatch = clean.match(/(?:^|\n)\s*(?:Done|Completed)\s*\(ID:\s*`?([A-Za-z0-9_-]+)`?\)\.\s*Output(?:\s+was)?:\s*([\s\S]*)$/i)
  if (doneMatch) {
    return {
      type: 'task_notification',
      task_id: doneMatch[1],
      status: 'completed',
      output_text: doneMatch[2].trim(),
      summary: 'Background command completed',
    }
  }

  const match = clean.match(/Command running in background with ID:\s*([A-Za-z0-9_-]+)\.\s*Output is being written to:\s*(\S+)/i)
  if (!match) return null
  return {
    type: 'task_notification',
    task_id: match[1],
    status: 'running',
    output_file: match[2],
    summary: 'Background command started',
  }
}

function backgroundTaskText(block) {
  if (!block || typeof block !== 'object') return ''
  return [
    block.summary,
    block.result,
    block.output_text,
    block.output_file && !block.output_text ? 'Output pending' : '',
    block.task_id ? `Task ID: ${block.task_id}` : '',
  ].filter(Boolean).join('\n')
}

function backgroundTaskStatusRank(status) {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') return 'completed'
  if (normalized === 'failed' || normalized === 'error') return 'failed'
  if (normalized === 'running' || normalized === 'started') return 'running'
  return normalized || 'updated'
}

function backgroundTaskFromBlock(block, msg, index) {
  if (!block || typeof block !== 'object') return null
  const type = String(block.type || '').toLowerCase()
  const updatedAt = Date.parse(msg?.created_at || '') || Date.now()

  if (type === 'text' || block.text) {
    const textTask = parseBackgroundTaskStart(block.text || '')
    if (!textTask) return null
    return {
      id: textTask.task_id || textTask.output_file || `task-${index}`,
      status: backgroundTaskStatusRank(textTask.status),
      summary: textTask.summary,
      outputFile: textTask.output_file || '',
      outputText: textTask.output_text || '',
      updatedAt,
    }
  }

  if (type === 'task_notification') {
    const id = block.task_id || block.output_file || `task-${index}`
    return {
      id,
      status: backgroundTaskStatusRank(block.status),
      summary: block.summary || 'Background task update',
      outputFile: block.output_file || '',
      outputText: block.output_text || '',
      outputTruncated: Boolean(block.output_truncated),
      toolUseId: block.tool_use_id || '',
      result: block.result || '',
      updatedAt,
    }
  }

  if (type === 'tool_result' || type === 'toolresult' || type === 'function_response' || type === 'functionresponse') {
    const started = parseBackgroundTaskStart(toolResultText(block.content))
    if (!started) return null
    return {
      id: started.task_id || started.output_file || `task-${index}`,
      status: backgroundTaskStatusRank(started.status),
      summary: started.summary,
      outputFile: started.output_file || '',
      outputText: started.output_text || '',
      updatedAt,
    }
  }

  return null
}

function extractBackgroundTasks(messages) {
  const tasks = []
  messages.forEach((msg, msgIndex) => {
    const blocks = contentBlocks(msg.content)
    if (blocks?.length) {
      blocks.forEach((block, blockIndex) => {
        const task = backgroundTaskFromBlock(block, msg, `${msgIndex}-${blockIndex}`)
        if (task) tasks.push(task)
      })
      return
    }

    const started = parseBackgroundTaskStart(contentToText(msg.content))
    if (started) {
      tasks.push({
        id: started.task_id,
        status: backgroundTaskStatusRank(started.status),
        summary: started.summary,
        outputFile: started.output_file || '',
        outputText: started.output_text || '',
        updatedAt: Date.parse(msg.created_at || '') || Date.now(),
      })
    }
  })
  return tasks
}

function isProcessBlock(block) {
  if (!block || typeof block !== 'object') return false
  const type = String(block.type || '').toLowerCase()
  if (type === 'thinking') return Boolean(String(block.thinking || block.text || '').trim())
  if (type === 'task_notification') return true
  return type === 'tool_use'
    || type === 'tool_result'
    || type === 'toolresult'
    || type === 'function_response'
    || type === 'functionresponse'
}

function ProcessDisclosure({ title, subtitle, preview, children, tone = 'amber', defaultOpen = false, forceOpen = null }) {
  const [open, setOpenInternal] = useState(defaultOpen)
  useEffect(() => {
    if (forceOpen !== null) setOpenInternal(forceOpen)
  }, [forceOpen])
  const setOpen = (action) => {
    setOpenInternal((v) => (typeof action === 'function' ? action(v) : action))
  }
  const borderClass = 'border-x-line-subtle'
  const bgClass = tone === 'red' ? 'bg-x-accent-ink/5' : ''
  const accentClass = tone === 'cyan'
    ? 'border-l-2 border-l-x-accent/40'
    : tone === 'violet'
      ? 'border-l-2 border-l-x-accent/40'
      : tone === 'red'
        ? 'border-l-2 border-l-error/50'
        : tone === 'amber'
          ? 'border-l-2 border-l-warn/40'
          : tone === 'zinc'
            ? 'border-l-2 border-l-border-primary'
            : ''

  const titleClass = tone === 'red'
    ? 'text-x-accent-ink font-semibold'
    : 'text-x-ink-secondary font-medium'

  return (
    <div className={`my-1.5 overflow-hidden rounded-md border ${borderClass} ${bgClass} ${accentClass}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[11px] uppercase tracking-wide hover:bg-x-hover transition-colors duration-[80ms]"
      >
        <ChevronDown size={11} className={`shrink-0 text-x-faint transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className={`font-semibold ${titleClass}`}>{title}</span>
        {subtitle ? <span className="min-w-0 truncate normal-case tracking-normal text-x-faint">{subtitle}</span> : null}
      </button>
      {!open && preview ? (
        <div className="border-t border-x-line-subtle px-2.5 py-1.5">
          {preview}
        </div>
      ) : null}
      {open ? (
        <div className="border-t border-x-line-subtle px-2.5 py-2">
          {children}
        </div>
      ) : null}
    </div>
  )
}

function CompactMarkdownPreview({ text }) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return <span className="font-mono text-[11px] text-x-faint">No content</span>
  const lines = trimmed.split('\n').slice(0, 2)
  return (
    <div className="max-h-[2.5rem] overflow-hidden break-words rounded bg-x-surface-2 px-2 py-1 font-sans text-[11px] leading-[1.35] text-x-muted">
      {lines.map((line, idx) => (
        <div key={idx} className="truncate">
          {parseInlineFormatting(line)}
        </div>
      ))}
    </div>
  )
}

function CompactCodePreview({ text, lang = null }) {
  const code = String(text || '').trimEnd()
  if (!code) return <span className="font-mono text-[11px] text-x-faint">No content</span>
  const normalizedLang = normalizeFenceLang(lang, code)
  return (
    <pre className="max-h-[2.25rem] overflow-hidden whitespace-pre-wrap break-words rounded bg-x-surface-2 px-2 py-1 font-mono text-[11px] leading-[1.25] text-x-muted">
      <code>
        {code.split('\n').slice(0, 2).map((line, idx) => (
          <span key={idx} className="block min-h-[1.25em]">
            {renderCodeLine(line, normalizedLang, `preview-${idx}`)}
          </span>
        ))}
      </code>
    </pre>
  )
}

function FullCodeBlock({ text, lang = null }) {
  const code = String(text || '').trimEnd()
  const normalizedLang = normalizeFenceLang(lang, code)
  return (
    <pre className="overflow-x-auto whitespace-pre rounded-lg bg-x-surface-2 px-2.5 py-2 font-mono text-[12px] leading-5 text-x-ink scrollbar-thin">
      <code>
        {code.split('\n').map((line, idx) => (
          <span key={idx} className="block min-h-[1.25rem]">
            {renderCodeLine(line, normalizedLang, `full-${idx}`)}
          </span>
        ))}
      </code>
    </pre>
  )
}

function FileCallPreview({ sessionId, path, compact = false }) {
  const [state, setState] = useState({ loading: false, info: null, error: null })

  useEffect(() => {
    if (!sessionId || !path) return
    let cancelled = false
    setState({ loading: true, info: null, error: null })
    api.getSessionFilePreview(sessionId, path)
      .then((info) => {
        if (!cancelled) setState({ loading: false, info, error: null })
      })
      .catch((err) => {
        if (!cancelled) setState({ loading: false, info: null, error: err?.message || 'Preview unavailable' })
      })
    return () => { cancelled = true }
  }, [sessionId, path])

  const baseClass = compact
    ? 'rounded border border-x-accent/15 bg-x-surface-2 px-2 py-1.5'
    : 'mb-2 rounded-md border bg-x-surface-2 px-2.5 py-2'

  if (!sessionId || !path) return null

  if (state.loading) {
    return (
      <div className={`${baseClass} border-x-line`}>
        <div className="font-mono text-[11px] text-x-faint">Loading file preview...</div>
      </div>
    )
  }

  if (state.error) {
    return (
      <div className={`${baseClass} border-x-line`}>
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-x-faint">
          <AlertCircle size={10} />
          <span className="truncate">{state.error}</span>
        </div>
      </div>
    )
  }

  const info = state.info
  if (!info) return null

  const meta = fileKindMeta(info.kind)
  const Icon = meta.icon
  const contentUrl = info.content_url ? api.sessionFilePreviewContentUrl(sessionId, path) : null
  const size = formatBytes(info.size)
  const title = [info.name || path, size].filter(Boolean).join(' · ')
  const lang = filePreviewLang(info, path)

  return (
    <div className={`${baseClass} ${meta.tone}`}>
      <div className="mb-1.5 flex min-w-0 items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide">
        <Icon size={11} className="shrink-0" />
        <span className="shrink-0">{meta.label}</span>
        <span className="min-w-0 truncate normal-case tracking-normal text-x-faint">{title}</span>
      </div>

      {info.kind === 'image' && contentUrl ? (
        <img
          src={contentUrl}
          alt={info.name || 'File preview'}
          loading="lazy"
          className={`${compact ? 'max-h-36' : 'max-h-80'} w-full rounded bg-x-surface-2 object-contain`}
        />
      ) : info.kind === 'video' && contentUrl ? (
        <video
          src={contentUrl}
          controls={!compact}
          preload="metadata"
          className={`${compact ? 'max-h-36' : 'max-h-80'} w-full rounded bg-x-surface-2`}
        />
      ) : info.kind === 'audio' && contentUrl ? (
        <audio src={contentUrl} controls preload="metadata" className="w-full" />
      ) : info.kind === 'pdf' && contentUrl && !compact ? (
        <iframe title={info.name || 'PDF preview'} src={contentUrl} className="h-80 w-full rounded bg-x-surface-2" />
      ) : info.kind === 'text' ? (
        compact ? (
          <CompactCodePreview text={firstLines(info.text || '', 4)} lang={lang} />
        ) : (
          <div>
            <div className="max-h-80 overflow-auto rounded">
              <FullCodeBlock text={info.text || ''} lang={lang} />
            </div>
            {info.truncated ? (
              <div className="mt-1 font-mono text-[11px] text-x-faint">Preview truncated at 160 KB.</div>
            ) : null}
          </div>
        )
      ) : (
        <div className="font-mono text-[11px] text-x-faint">No inline preview for this file type.</div>
      )}
    </div>
  )
}

function ToolUseProcessBlock({ block, sessionId }) {
  const name = block?.name || 'tool'
  const input = block?.input
  const isObj = isPlainObject(input)
  const command = isObj ? (input.command || input.cmd || input.shell_command) : null
  const description = isObj ? (input.description || input.summary || input.reason) : null
  const path = isObj ? toolPathFromInput(input) : null
  const rawInputText = input == null ? '' : typeof input === 'string' ? input : JSON.stringify(input, null, 2)
  const mainText = command || rawInputText
  const lineMeta = textLineCount(mainText)
  const subtitle = description || path || (lineMeta ? `${lineMeta} line${lineMeta === 1 ? '' : 's'}` : '')
  const canPreviewFile = shouldPreviewToolFile(name, input, command)

  const extraFields = isObj
    ? Object.entries(input)
      .filter(([key]) => !['description', 'summary', 'reason', 'command', 'cmd', 'shell_command', 'file_path', 'path', 'file', 'filename'].includes(key))
      .slice(0, 6)
    : []

  return (
    <ProcessDisclosure
      title={`Calling ${name}`}
      subtitle={subtitle}
      tone="cyan"
      preview={
        canPreviewFile && sessionId
          ? <FileCallPreview sessionId={sessionId} path={path} compact />
          : mainText
            ? <CompactCodePreview text={firstLines(mainText, 2)} lang={command ? 'bash' : 'json'} />
            : null
      }
    >
      {description ? <div className="mb-1.5 font-mono text-[11px] text-x-ink-secondary">{description}</div> : null}
      {path ? <div className="mb-1.5 font-mono text-[11px] text-x-faint">Path: <code className="text-x-accent">{path}</code></div> : null}
      {canPreviewFile && sessionId ? <FileCallPreview sessionId={sessionId} path={path} /> : null}
      {command ? (
        <div className="mb-2">
          <div className="mb-1 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-x-faint">
            <Code2 size={10} />
            Command
          </div>
          <FullCodeBlock text={command} lang="bash" />
        </div>
      ) : null}
      {rawInputText ? (
        <div className="mb-2">
          <div className="mb-1 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-x-faint">
            <Code2 size={10} />
            Raw call
          </div>
          <div className="max-h-72 overflow-auto rounded">
            <FullCodeBlock text={rawInputText} lang={isObj ? 'json' : null} />
          </div>
        </div>
      ) : null}
      {extraFields.length > 0 ? (
        <div className="mt-2 space-y-0.5 font-mono text-[11px] text-x-faint">
          {extraFields.map(([key, value]) => (
            <div key={key}><span className="text-x-muted">{key}:</span> {previewToolValue(value)}</div>
          ))}
        </div>
      ) : null}
    </ProcessDisclosure>
  )
}

function ToolResultProcessBlock({ block }) {
  const result = toolResultText(block?.content)
  const lines = textLineCount(result)
  const isSafetyGate = String(result || '').includes('[Safety Gate]')
  const backgroundTask = parseBackgroundTaskStart(result)

  if (backgroundTask) {
    return <BackgroundTaskProcessBlock block={backgroundTask} />
  }

  if (isSafetyGate) {
    const cleanMessage = result.replace('[Safety Gate]', '').trim()
    return (
      <ProcessDisclosure
        title="Safety Gate Blocked"
        subtitle="avcp policy enforcement"
        tone="red"
        defaultOpen={true}
        preview={<span className="font-mono text-[11px] text-x-accent-ink/80 line-clamp-1">{cleanMessage}</span>}
      >
        <div className="flex items-start gap-2.5 px-1 py-0.5 font-mono text-[11px] leading-relaxed text-x-accent-ink/90">
          <Shield size={13} className="mt-0.5 shrink-0 text-x-accent-ink/60" />
          <div className="flex-1">
            {cleanMessage}
          </div>
        </div>
      </ProcessDisclosure>
    )
  }

  return (
    <ProcessDisclosure
      title="Tool result"
      subtitle={lines ? `${lines} line${lines === 1 ? '' : 's'}` : 'empty'}
      tone="amber"
      preview={<CompactCodePreview text={firstLines(result || 'No output', 2)} />}
    >
      <FullCodeBlock text={result || 'No output'} />
    </ProcessDisclosure>
  )
}

function BackgroundTaskProcessBlock({ block }) {
  const status = String(block?.status || 'updated').toLowerCase()
  const isRunning = status === 'running' || status === 'started'
  const isCompleted = status === 'completed' || status === 'complete' || status === 'done'
  const title = isRunning ? 'Background task started' : isCompleted ? 'Background task completed' : 'Background task'
  const subtitle = [
    status,
    block?.task_id ? `id ${block.task_id}` : '',
  ].filter(Boolean).join(' · ')
  const mainText = backgroundTaskText(block) || 'Background task update'

  return (
    <ProcessDisclosure
      title={title}
      subtitle={subtitle}
      tone={isRunning ? 'cyan' : 'amber'}
      preview={<CompactCodePreview text={firstLines(mainText, 2)} />}
    >
      <div className="space-y-1.5 font-mono text-[11px] leading-5 text-x-ink-secondary">
        {block?.summary ? <div className="font-sans text-[12px] text-x-ink/90">{block.summary}</div> : null}
        {block?.task_id ? <div><span className="text-x-faint">Task ID:</span> <code className="text-x-accent">{block.task_id}</code></div> : null}
        {block?.tool_use_id ? <div><span className="text-x-faint">Tool use:</span> <code className="text-x-accent">{block.tool_use_id}</code></div> : null}
        {block?.output_text ? (
          <div>
            <div className="mb-1 text-x-faint">
              Output{block.output_truncated ? ' (tail)' : ''}
            </div>
            <FullCodeBlock text={block.output_text} />
          </div>
        ) : block?.output_file ? (
          <div className="text-x-faint">Output pending</div>
        ) : null}
        {block?.result ? <FullCodeBlock text={block.result} /> : null}
      </div>
    </ProcessDisclosure>
  )
}

function ThinkingProcessBlock({ block, forceOpen = null }) {
  const thinking = String(block?.thinking || block?.text || '').trim()
  if (!thinking) return null
  const lines = textLineCount(thinking)
  return (
    <ProcessDisclosure
      title="Thinking"
      subtitle={lines ? `${lines} line${lines === 1 ? '' : 's'}` : ''}
      tone="violet"
      forceOpen={forceOpen}
      preview={<CompactMarkdownPreview text={firstLines(thinking, 2)} />}
    >
      <div className="text-[12px] leading-5 text-x-ink-secondary">
        <FormatMessageContent content={thinking} />
      </div>
    </ProcessDisclosure>
  )
}

function ProcessBlockRenderer({ block, sessionId }) {
  if (!block || typeof block !== 'object') return null
  const type = String(block.type || '').toLowerCase()
  if (type === 'tool_use') return <ToolUseProcessBlock block={block} sessionId={sessionId} />
  if (type === 'task_notification') return <BackgroundTaskProcessBlock block={block} />
  if (type === 'tool_result' || type === 'toolresult' || type === 'function_response' || type === 'functionresponse') {
    return <ToolResultProcessBlock block={block} />
  }
  if (type === 'thinking') return <ThinkingProcessBlock block={block} />
  if (type === 'text') return <FormatMessageContent content={block.text || ''} sessionId={sessionId} />
  if (block.text) return <FormatMessageContent content={block.text} sessionId={sessionId} />
  return null
}

/**
 * Rewrite a markdown image src so the browser can actually load it.
 *
 * Why: pasted images are inserted into the prompt as `![name](/abs/path/pastes/paste_X.png)`
 * because Claude Code reads them from disk. The browser can't load filesystem paths.
 * Map the path back to the /api/pastes/<filename> URL served by the backend.
 */
function normalizeImageSrc(src) {
  if (!src) return src
  const trimmed = String(src).trim()
  if (!trimmed) return trimmed
  if (/^(https?:|data:|blob:)/i.test(trimmed)) return trimmed
  // Already a backend URL.
  if (trimmed.startsWith('/api/')) return trimmed
  // Filesystem path to a paste file → rewrite to the served URL.
  const m = trimmed.match(/(?:^|[\\/])pastes[\\/](paste_[^\\/]+\.[A-Za-z0-9]+)$/)
  if (m) return `/api/pastes/${m[1]}`
  return trimmed
}

/** Full-viewport lightbox with optional prev/next nav for grouped image sets. */
function ChatImageLightbox({ images, index, onClose, onIndexChange }) {
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' && images.length > 1) {
        onIndexChange((index + 1) % images.length)
      } else if (e.key === 'ArrowLeft' && images.length > 1) {
        onIndexChange((index - 1 + images.length) % images.length)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [images.length, index, onClose, onIndexChange])

  const current = images[index]
  if (!current) return null

  return (
    <div
      className="fixed inset-0 z-[80] flex flex-col items-center justify-center bg-x-scrim backdrop-blur-[4px] p-6"
      onClick={onClose}
    >
      <div className="absolute top-3 right-3 flex items-center gap-2">
        {images.length > 1 && (
          <span className="text-[11px] font-mono text-x-ink bg-x-surface border border-x-line rounded px-2 py-1">
            {index + 1} / {images.length}
          </span>
        )}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose() }}
          className="p-1.5 rounded-full bg-x-surface border border-x-line text-x-ink-secondary hover:text-x-ink hover:bg-x-hover transition-colors duration-[80ms]"
          title="Close (Esc)"
        >
          <X size={16} />
        </button>
      </div>
      {images.length > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onIndexChange((index - 1 + images.length) % images.length) }}
            className="absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-x-surface border border-x-line text-x-ink-secondary hover:text-x-ink hover:bg-x-hover transition-colors duration-[80ms]"
            title="Previous (←)"
          >
            <ChevronLeft size={20} />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onIndexChange((index + 1) % images.length) }}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-x-surface border border-x-line text-x-ink-secondary hover:text-x-ink hover:bg-x-hover transition-colors duration-[80ms]"
            title="Next (→)"
          >
            <ChevronRight size={20} />
          </button>
        </>
      )}
      <img
        src={current.src}
        alt={current.alt || ''}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[88vh] max-w-[92vw] object-contain rounded-md shadow-x-3"
      />
      {current.alt && (
        <div className="mt-3 text-[11px] font-mono text-x-ink-secondary truncate max-w-[80vw]" onClick={(e) => e.stopPropagation()}>
          {current.alt}
        </div>
      )}
    </div>
  )
}

/** Single inline image (within a paragraph) with click-to-zoom. */
function InlineChatImage({ src, alt }) {
  const [open, setOpen] = useState(false)
  const resolved = normalizeImageSrc(src)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={alt || 'Click to enlarge'}
        className="inline-block align-middle mx-0.5 h-20 w-20 rounded-md overflow-hidden border border-x-line bg-x-surface-2 cursor-zoom-in hover:ring-2 hover:ring-x-accent/60 focus:outline-none focus:ring-2 focus:ring-x-accent/60 transition-colors duration-[80ms]"
      >
        <img src={resolved} alt={alt} className="h-full w-full object-cover" />
      </button>
      {open && (
        <ChatImageLightbox
          images={[{ src: resolved, alt }]}
          index={0}
          onClose={() => setOpen(false)}
          onIndexChange={() => {}}
        />
      )}
    </>
  )
}

/**
 * A group of consecutive standalone images. 1 → full, 2 → side-by-side,
 * 3+ → 2-col grid (quadrant style). Click any thumb to open the lightbox
 * with prev/next nav across the group.
 */
function ChatImageGrid({ images }) {
  const [lightboxIndex, setLightboxIndex] = useState(null)
  const resolved = images.map((im) => ({ src: normalizeImageSrc(im.src), alt: im.alt }))
  // Render as small preview thumbnails (same vibe as the composer's pasted-image
  // strip) — flex-wrap row, click any to enlarge in the lightbox.
  return (
    <div className="my-2">
      <div className="flex flex-wrap gap-1.5">
        {resolved.map((im, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setLightboxIndex(i)}
            className="relative shrink-0 h-20 w-20 rounded-md overflow-hidden border border-x-line bg-x-surface-2 cursor-zoom-in hover:ring-2 hover:ring-x-accent/60 focus:outline-none focus:ring-2 focus:ring-x-accent/60 transition-colors duration-[80ms]"
            title={im.alt || 'Click to enlarge'}
          >
            <img
              src={im.src}
              alt={im.alt || ''}
              className="h-full w-full object-cover"
            />
          </button>
        ))}
      </div>
      {lightboxIndex !== null && (
        <ChatImageLightbox
          images={resolved}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={setLightboxIndex}
        />
      )}
    </div>
  )
}

/**
 * A highly tailored, regex-based formatter for clean and premium rendering of CLI messages.
 * Supports bold, inline code, fenced code blocks with language headers and Copy buttons, lists, tables, and headers.
 */
function FormatMessageContent({ content, sessionId }) {
  const [copiedIndex, setCopiedIndex] = useState(null)
  content = unwrapMessage(content)
  if (!content) return null

  // Helper to parse blocks into raw text
  const parseBlocks = (items) => {
    return items
      .map(block => {
        if (typeof block === 'string') return block
        if (block && typeof block === 'object') {
          if (block.type === 'text') return block.text || ''
          if (block.type === 'thinking') {
            const thinking = String(block.thinking || block.text || '').trim()
            return thinking ? `*Thinking: ${thinking}*` : ''
          }
          if (block.type === 'tool_use') {
            return formatToolUseBlock(block)
          }
          if (block.type === 'tool_result') {
            let resText = ''
            if (typeof block.content === 'string') {
              resText = block.content
            } else if (Array.isArray(block.content)) {
              resText = block.content.map(c => typeof c === 'string' ? c : (c.text || '')).join('\n')
            } else {
              resText = JSON.stringify(block.content, null, 2)
            }
            return `\`\`\`\n${resText}\n\`\`\``
          }
          if (block.text) return block.text
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }

  let rawText = ''
  let blocks = []

  const isBlockList = (arr) => {
    return Array.isArray(arr) && arr.length > 0 && arr.every(item =>
      typeof item === 'string' ||
      (item && typeof item === 'object' && (item.type || item.text))
    )
  }

  // Ensure content is a string and handle serialized JSON arrays/objects representing text blocks
  if (typeof content === 'string') {
    const trimmed = content.trim()
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        const parsed = safeJsonParse(trimmed)
        if (Array.isArray(parsed)) {
          if (parsed.length === 0 || isBlockList(parsed)) {
            blocks = parsed
          } else {
            rawText = `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``
          }
        } else if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.content)) {
            blocks = parsed.content
          } else if (parsed.type || parsed.text || parsed.content) {
            blocks = [parsed]
          } else {
            rawText = `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``
          }
        }
      } catch (e) {
        console.error('Error parsing JSON message content string:', e)
        rawText = content
      }
    } else {
      rawText = content
    }
  } else if (Array.isArray(content)) {
    if (content.length === 0 || isBlockList(content)) {
      blocks = content
    } else {
      rawText = `\`\`\`json\n${JSON.stringify(content, null, 2)}\n\`\`\``
    }
  } else if (content && typeof content === 'object') {
    if (Array.isArray(content.content)) {
      blocks = content.content
    } else if (content.type || content.text || content.content) {
      blocks = [content]
    } else {
      rawText = `\`\`\`json\n${JSON.stringify(content, null, 2)}\n\`\`\``
    }
  } else {
    rawText = String(content)
  }

  if (blocks.length === 0) {
    const backgroundTask = parseBackgroundTaskStart(rawText)
    if (backgroundTask) {
      return (
        <div className="space-y-1.5 text-[13px] leading-6 text-x-ink/95 break-words font-sans">
          <BackgroundTaskProcessBlock block={backgroundTask} />
        </div>
      )
    }
  }

  const hasProcessBlocks = blocks.some(isProcessBlock)
  if (hasProcessBlocks) {
    const processCount = blocks.filter(isProcessBlock).length
    const renderedBlocks = blocks.map((block, idx) => (
      <div key={idx} className={processCount > 1 ? 'pl-2 border-l border-x-line-subtle' : ''}>
        <ProcessBlockRenderer block={block} sessionId={sessionId} />
      </div>
    ))
    if (processCount > 1) {
      return (
        <div className="space-y-1.5 text-[13px] leading-6 text-x-ink/95 break-words font-sans">
          <ProcessDisclosure
            title="Working process"
            subtitle={`${processCount} event${processCount === 1 ? '' : 's'}`}
            tone="violet"
            preview={<span className="font-mono text-[11px] text-x-faint">Tool calls/results collapsed</span>}
          >
            <div className="space-y-1">
              {renderedBlocks}
            </div>
          </ProcessDisclosure>
        </div>
      )
    }
    return (
      <div className="space-y-1.5 text-[13px] leading-6 text-x-ink/95 break-words font-sans">
        {renderedBlocks}
      </div>
    )
  }

  // If blocks exist, map them to text
  if (blocks.length > 0) {
    rawText = parseBlocks(blocks)
    const backgroundTask = parseBackgroundTaskStart(rawText)
    if (backgroundTask) {
      return (
        <div className="space-y-1.5 text-[13px] leading-6 text-x-ink/95 break-words font-sans">
          <BackgroundTaskProcessBlock block={backgroundTask} />
        </div>
      )
    }
  }

  const presentation = presentText(rawText)
  rawText = presentation.text

  // Split into chunks of code blocks and normal text to preserve formatting inside code blocks
  const parts = []
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g
  let lastIndex = 0
  let match

  while ((match = codeBlockRegex.exec(rawText)) !== null) {
    // Add text preceding the code block
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: rawText.slice(lastIndex, match.index) })
    }
    // Add the code block itself
    parts.push({ type: 'code', lang: match[1], code: match[2] })
    lastIndex = codeBlockRegex.lastIndex
  }

  if (lastIndex < rawText.length) {
    parts.push({ type: 'text', value: rawText.slice(lastIndex) })
  }

  const handleCopyCode = (text, idx) => {
    navigator.clipboard.writeText(text)
    setCopiedIndex(idx)
    setTimeout(() => setCopiedIndex(null), 2000)
  }

  return (
    <div className="space-y-2 text-[13px] leading-6 text-x-ink/95 break-words font-sans">
      {presentation.sources.length > 0 && <details className="ive-message-sources"><summary>Sources · {presentation.sources.length}</summary><ul>{presentation.sources.map(source => <li key={source}>{source}</li>)}</ul></details>}
      {presentation.context && <details className="ive-message-sources"><summary>Quoted context</summary><pre>{presentation.context}</pre></details>}
      {parts.map((part, idx) => {
        if (part.type === 'code') {
          const lang = normalizeFenceLang(part.lang, part.code)
          const code = prettyCodeForLang(part.code, lang)
          return (
            <div key={idx} className="relative group/code my-2 border border-x-line rounded-lg overflow-hidden bg-x-surface-2">
              <div className="flex items-center justify-between px-2.5 py-1 bg-x-surface border-b border-x-line-subtle text-[11px] font-mono text-x-muted">
                <span>{part.lang || lang || 'code'}</span>
                <button
                  onClick={() => handleCopyCode(code, idx)}
                  className="flex items-center gap-1 hover:text-x-ink-secondary transition-colors duration-[80ms]"
                >
                  {copiedIndex === idx ? (
                    <>
                      <Check size={10} className="text-x-good" />
                      <span className="text-x-good font-medium">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy size={10} />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="px-3 py-2 text-[12px] font-mono overflow-x-auto bg-x-surface-2 leading-5 scrollbar-thin tabular-nums">
                <code>
                  {code.split('\n').map((line, lineIdx) => (
                    <span key={lineIdx} className="block min-h-[1.25rem]">
                      {renderCodeLine(line, lang, `${idx}-${lineIdx}`)}
                    </span>
                  ))}
                </code>
              </pre>
            </div>
          )
        }

        // Handle regular text parsing (headers, lists, bold, inline code)
        const lines = part.value.split('\n')
        const formattedBlocks = []
        let currentList = []

        const flushList = (key) => {
          if (currentList.length > 0) {
            formattedBlocks.push(
              <ul key={`list-${key}`} className="list-disc pl-5 my-1.5 space-y-1 text-x-ink-secondary">
                {currentList.map((item, i) => (
                  <li key={i}>{parseInlineFormatting(item)}</li>
                ))}
              </ul>
            )
            currentList = []
          }
        }

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          const trimmed = line.trim()

          // Detect table
          const tableInfo = parseTableLines(lines, i)
          if (tableInfo) {
            flushList(i)
            const { tableLines, nextIndex } = tableInfo
            formattedBlocks.push(renderTable(tableLines, i))
            i = nextIndex - 1 // Advance past table lines
            continue
          }

          // Detect standalone image — gather consecutive image lines into one
          // grid so a multi-image paste renders as quadrants instead of a stack.
          const imageMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
          if (imageMatch) {
            flushList(i)
            const group = [{ alt: imageMatch[1], src: imageMatch[2] }]
            let lookahead = i + 1
            while (lookahead < lines.length) {
              const nextTrim = lines[lookahead].trim()
              if (nextTrim === '') { lookahead++; continue }
              const m = nextTrim.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
              if (!m) break
              group.push({ alt: m[1], src: m[2] })
              lookahead++
            }
            formattedBlocks.push(<ChatImageGrid key={i} images={group} />)
            i = lookahead - 1
            continue
          }

          // Detect headers
          if (trimmed.startsWith('### ')) {
            flushList(i)
            formattedBlocks.push(
              <h4 key={i} className="text-[12px] font-semibold text-x-accent mt-3 mb-1">
                {parseInlineFormatting(trimmed.slice(4))}
              </h4>
            )
          } else if (trimmed.startsWith('## ')) {
            flushList(i)
            formattedBlocks.push(
              <h3 key={i} className="text-[13px] font-semibold text-x-ink mt-3 mb-1.5">
                {parseInlineFormatting(trimmed.slice(3))}
              </h3>
            )
          } else if (trimmed.startsWith('# ')) {
            flushList(i)
            formattedBlocks.push(
              <h2 key={i} className="text-[15px] font-semibold text-x-ink mt-4 mb-2 border-b border-x-line-subtle pb-1">
                {parseInlineFormatting(trimmed.slice(2))}
              </h2>
            )
          }
          // Detect bullet points (e.g. - item, * item, → item)
          else if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('→ ') || trimmed.startsWith('• ')) {
            currentList.push(trimmed.slice(2))
          }
          // Detect numeric list items (e.g. 1. item)
          else if (/^\d+\.\s/.test(trimmed)) {
            flushList(i)
            const contentStart = trimmed.indexOf(' ') + 1
            formattedBlocks.push(
              <div key={i} className="flex gap-2 my-0.5 text-x-ink-secondary pl-2">
                <span className="font-semibold text-x-accent tabular-nums shrink-0">{trimmed.match(/^\d+\./)[0]}</span>
                <span>{parseInlineFormatting(trimmed.slice(contentStart))}</span>
              </div>
            )
          }
          // Empty line separates paragraphs
          else if (trimmed === '') {
            flushList(i)
          }
          // Normal paragraph line
          else {
            flushList(i)
            // Combine consecutive non-empty lines that don't start with headers/lists/tables/images into same paragraph block
            let paragraphLines = [trimmed]
            while (i + 1 < lines.length && lines[i + 1].trim() !== '' &&
                   !lines[i + 1].trim().startsWith('### ') &&
                   !lines[i + 1].trim().startsWith('## ') &&
                   !lines[i + 1].trim().startsWith('# ') &&
                   !lines[i + 1].trim().startsWith('- ') &&
                   !lines[i + 1].trim().startsWith('* ') &&
                   !lines[i + 1].trim().startsWith('• ') &&
                   !lines[i + 1].trim().startsWith('→ ') &&
                   !lines[i + 1].trim().startsWith('|') &&
                   !lines[i + 1].trim().startsWith('![') &&
                   !/^\d+\.\s/.test(lines[i + 1].trim())) {
              i++
              paragraphLines.push(lines[i].trim())
            }
            formattedBlocks.push(
              <p key={i} className="my-1.5 text-x-ink/90 leading-6 font-sans">
                {parseInlineFormatting(paragraphLines.join(' '))}
              </p>
            )
          }
        }
        flushList(lines.length)

        return <div key={idx}>{formattedBlocks}</div>
      })}
    </div>
  )
}

function MessageLink({ href, children }) {
  if (!href) return <span>{children}</span>
  const external = /^(?:https?:|mailto:|\/\/)/i.test(href)
  const onClick = (event) => {
    // Overview cells also handle clicks; a link must not select/remount the tile.
    event.stopPropagation()
    if (external) return // Tauri routes new windows to the OS default browser.
    event.preventDefault()
    let path = href.replace(/^file:\/\//i, '').split('#')[0]
    try { path = decodeURIComponent(path) } catch {}
    const owner = event.currentTarget.closest('[data-session-view], [data-grid-cell-session]')
    const id = owner?.dataset.sessionView || owner?.dataset.gridCellSession || useStore.getState().activeSessionId
    const store = useStore.getState()
    const workspaceId = store.sessions[id]?.workspace_id || store.activeWorkspaceId
    if (!workspaceId) {
      store.addNotification({ type: 'warning', message: 'No active workspace found to open file in IDE.' })
      return
    }
    api.openInIde(workspaceId, path).catch((error) => store.addNotification({ type: 'warning', message: `Failed to open file: ${error.message}` }))
  }
  return <a href={href} onClick={onClick} onAuxClick={(event) => event.stopPropagation()}
    target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}
    title={external ? 'Open in default browser' : 'Open in IDE'}
    className="ive-message-link text-x-link underline decoration-current/40 underline-offset-2 hover:decoration-current break-words cursor-pointer">{children}</a>
}

const inlineChildren = (children) => Array.isArray(children)
  ? children.map((child, index) => typeof child === 'string' ? <span key={index}>{renderInlinePlain(child, index)}</span> : child)
  : typeof children === 'string' ? renderInlinePlain(children, 'inline') : children
const INLINE_COMPONENTS = {
  p: ({ children }) => <>{inlineChildren(children)}</>,
  a: MessageLink,
  strong: ({ children }) => <strong className="font-bold text-x-ink">{inlineChildren(children)}</strong>,
  em: ({ children }) => <em className="italic text-x-ink-secondary">{inlineChildren(children)}</em>,
  code: ({ children }) => <code className="bg-x-hover text-x-ink font-mono text-[12px] px-1 py-0.5 rounded">{children}</code>,
  img: ({ src, alt }) => <InlineChatImage src={src} alt={alt} />,
}

export function parseInlineFormatting(text) {
  if (!text) return ''
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={INLINE_COMPONENTS}
    urlTransform={(url) => /^(?:file:\/\/|\/|~\/|\.\.?\/)/i.test(url) ? url : defaultUrlTransform(url)}>{text}</ReactMarkdown>
}


function getAutocompleteToken(value, caret) {
  const before = value.slice(0, caret)

  // 1. Check for slash commands
  const slashMatch = before.match(/(^|[\s\n])\/([^\s\n]*)$/)
  if (slashMatch) {
    const token = slashMatch[0].trimStart()
    return {
      type: 'slash',
      token,
      query: slashMatch[2],
      start: caret - token.length,
      end: caret,
    }
  }

  // 2. Check for @ticket: mentions with quotes
  const ticketQuoteMatch = before.match(/(^|[\s\n])@ticket:"([^"]*)$/)
  if (ticketQuoteMatch) {
    const token = ticketQuoteMatch[0].trimStart()
    return {
      type: 'ticket',
      token,
      query: ticketQuoteMatch[2],
      start: caret - token.length,
      end: caret,
    }
  }

  // 3. Check for @ticket: mentions without quotes
  const ticketMatch = before.match(/(^|[\s\n])@ticket:([^\s\n]*)$/)
  if (ticketMatch) {
    const token = ticketMatch[0].trimStart()
    return {
      type: 'ticket',
      token,
      query: ticketMatch[2],
      start: caret - token.length,
      end: caret,
    }
  }

  // 4. Check for just @ticket
  const ticketBaseMatch = before.match(/(^|[\s\n])@ticket$/)
  if (ticketBaseMatch) {
    const token = ticketBaseMatch[0].trimStart()
    return {
      type: 'ticket',
      token,
      query: '',
      start: caret - token.length,
      end: caret,
    }
  }

  // 5. Check for @ or @<file query> (files, folders and the @ticket: option)
  const atMatch = before.match(/(^|[\s\n])@([^\s\n@"]*)$/)
  if (atMatch) {
    const token = atMatch[0].trimStart()
    return {
      type: 'at',
      token,
      query: atMatch[2],
      start: caret - token.length,
      end: caret,
    }
  }

  return null
}

function compactNumber(value) {
  const n = Number(value) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

function contentToText(content) {
  if (content == null) return ''
  if (typeof content === 'string') {
    const trimmed = content.trim()
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        return contentToText(safeJsonParse(trimmed))
      } catch {}
    }
    return content
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part
      if (part?.text) return part.text
      if (part?.type === 'task_notification') return backgroundTaskText(part)
      if (part?.type === 'tool_result') return toolResultText(part.content)
      if (part?.type === 'tool_use') return formatToolUseBlock(part)
      if (part?.type === 'command') return [part.name, part.args].filter(Boolean).join(' ')
      return JSON.stringify(part)
    }).join('\n')
  }
  return JSON.stringify(content)
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

function nestedUsageNumber(source, ...path) {
  let current = source
  for (const key of path) {
    if (!current || typeof current !== 'object') return null
    current = current[key]
  }
  return firstFiniteNumber(current)
}

function usageTokenBreakdown(msg) {
  if (!msg) return null
  const usage = msg.usage || {}
  let input = firstFiniteNumber(
    usage.input_tokens,
    usage.prompt_tokens,
    usage.promptTokenCount,
    usage.inputTokenCount
  )
  if (input == null) {
    input = firstFiniteNumber(msg.input_tokens)
  }
  const output = firstFiniteNumber(
    msg.output_tokens,
    usage.output_tokens,
    usage.completion_tokens,
    usage.candidatesTokenCount,
    usage.outputTokenCount
  )
  const cacheCreation = firstFiniteNumber(
    msg.cache_creation_tokens,
    usage.cache_creation_input_tokens,
    usage.cacheCreationInputTokens
  )
  const directCacheRead = firstFiniteNumber(
    usage.cache_read_input_tokens,
    usage.cacheReadInputTokens
  )
  const includedCacheRead = firstFiniteNumber(
    usage.cachedContentTokenCount,
    nestedUsageNumber(usage, 'input_tokens_details', 'cached_tokens'),
    nestedUsageNumber(usage, 'prompt_tokens_details', 'cached_tokens'),
    nestedUsageNumber(usage, 'inputTokensDetails', 'cachedTokens'),
    nestedUsageNumber(usage, 'promptTokensDetails', 'cachedTokens'),
    usage.cached_tokens,
    usage.cachedTokens
  )
  const cacheRead = directCacheRead || includedCacheRead || firstFiniteNumber(msg.cache_read_tokens)
  if (input != null && directCacheRead == null && includedCacheRead != null) {
    input = Math.max(0, input - includedCacheRead)
  }
  const reportedTotal = firstFiniteNumber(
    msg.token_count,
    usage.total_tokens,
    usage.totalTokenCount,
    usage.token_count
  )
  const activeParts = [input, output, cacheCreation].filter((n) => n != null)
  const active = activeParts.length
    ? activeParts.reduce((sum, n) => sum + n, 0)
    : (cacheRead ? 0 : reportedTotal)
  const cached = cacheRead || 0
  if (!active && !cached && !reportedTotal) return null
  return {
    active: active || 0,
    cached,
    total: (active || 0) + cached || reportedTotal || 0,
  }
}

function usageTokenCount(msg) {
  const breakdown = usageTokenBreakdown(msg)
  if (!breakdown) return null
  return breakdown.active || (breakdown.cached ? 0 : breakdown.total)
}

function contentBlocks(content) {
  if (Array.isArray(content)) return content
  if (content && typeof content === 'object') {
    if (Array.isArray(content.content)) return content.content
    if (Array.isArray(content.parts)) return content.parts
    return [content]
  }
  if (typeof content === 'string') {
    const trimmed = content.trim()
    if (!trimmed || (!trimmed.startsWith('[') && !trimmed.startsWith('{'))) return null
    try {
      const parsed = safeJsonParse(trimmed)
      if (Array.isArray(parsed)) return parsed
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.content)) return parsed.content
        if (Array.isArray(parsed.parts)) return parsed.parts
        return [parsed]
      }
    } catch {}
  }
  return null
}

function isToolResultBlock(block) {
  if (!block || typeof block !== 'object') return false
  const type = String(block.type || '').toLowerCase()
  return type === 'tool_result'
    || type === 'toolresult'
    || type === 'function_response'
    || type === 'functionresponse'
    || block.tool_result
    || block.toolResult
    || block.functionResponse
}

function isCommandBlock(block) {
  return Boolean(block && typeof block === 'object' && block.type === 'command' && block.name)
}

// Claude slash commands (/clear, /model, ...) arrive as a user row holding
// only `command` blocks. They are not prompts: no YOU bubble, no turn.
function effectiveMessageRole(msg) {
  const role = (msg?.role || '').toLowerCase()
  const blocks = contentBlocks(msg?.content)
  if ((role === 'user' || role === 'human') && blocks?.length && blocks.every(isToolResultBlock)) {
    return 'tool_result'
  }
  if ((role === 'user' || role === 'human') && blocks?.length && blocks.every(isCommandBlock)) {
    return 'command'
  }
  return msg?.role
}

// `before`: server summary of transcript rows not loaded (long sessions load
// only their tail), added so the header still counts the whole conversation.
function computeConversationStats(messages, session, before = null) {
  const userTurns = messages.filter((m) => {
    const role = effectiveMessageRole(m)
    return role === 'user' || role === 'human'
  }).length + (Number(before?.user_turns) || 0)
  const turns = Math.max(Number(session?.turn_count) || 0, userTurns)
  let exactTokens = Number(before?.tokens) || 0
  let exactCachedTokens = Number(before?.cached_tokens) || 0
  let exactCount = Number(before?.exact_count) || 0

  const usageOnce = createUsageOnceFilter()
  for (const msg of messages) {
    const counts = usageOnce(msg)
    const exact = usageTokenBreakdown(msg)
    if (exact && counts) {
      exactTokens += exact.active
      exactCachedTokens += exact.cached
      exactCount += 1
    }
  }

  if (exactCount > 0) {
    return {
      turns,
      tokens: exactTokens,
      cachedTokens: exactCachedTokens,
      estimated: false,
    }
  }

  const estimatedTokens = messages.reduce(
    (sum, msg) => sum + Math.ceil(contentToText(msg.content).length / 4),
    Number(before?.estimated_tokens) || 0
  )

  return {
    turns,
    tokens: estimatedTokens,
    cachedTokens: 0,
    estimated: estimatedTokens > 0,
  }
}

function getRoleMeta(role) {
  const normalized = (role || '').toLowerCase()
  if (normalized === 'user' || normalized === 'human') {
    return {
      label: 'you',
      prompt: '>',
      line: 'border-x-accent/40',
      text: 'text-x-accent',
      bg: 'bg-x-accent/[0.06]',
    }
  }
  if (normalized === 'assistant') {
    return {
      label: 'agent',
      prompt: '<',
      line: 'border-x-good/30',
      text: 'text-x-good',
      bg: 'bg-x-good/[0.018]',
    }
  }
  if (normalized === 'tool' || normalized === 'tool_result') {
    return {
      label: 'tool',
      prompt: '#',
      line: 'border-x-accent-ink/30',
      text: 'text-x-accent-ink',
      bg: 'bg-x-accent-ink/[0.02]',
    }
  }
  return {
    label: normalized || 'log',
    prompt: ':',
    line: 'border-x-line',
    text: 'text-x-muted',
    bg: '',
  }
}

function formatMessageTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function compactQuote(text, max = 160) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1)}...`
}

function formatTextAnnotations(annotations) {
  if (!annotations.length) return ''
  const lines = ['Referenced chat annotations:']
  annotations.forEach((ann, idx) => {
    lines.push(`${idx + 1}. Source role: ${ann.sourceLabel || ann.roleLabel || ann.role || 'unknown'}`)
    lines.push(`   Quote: "${compactQuote(ann.quote, 500)}"`)
    if (ann.note?.trim()) lines.push(`   Note: ${ann.note.trim()}`)
  })
  return lines.join('\n')
}

// The chat view trims very long tool output and images; this fetches the untrimmed row on demand.
function TruncatedOutputNotice({ sessionId, messageId }) {
  const [state, setState] = useState({ open: false, loading: false, text: '', error: '' })
  const toggle = async () => {
    if (state.open) { setState((current) => ({ ...current, open: false })); return }
    if (state.text) { setState((current) => ({ ...current, open: true })); return }
    setState({ open: true, loading: true, text: '', error: '' })
    try {
      const row = await api.getMessageFull(sessionId, messageId)
      setState({ open: true, loading: false, text: contentToText(row?.content), error: '' })
    } catch (err) {
      setState({ open: true, loading: false, text: '', error: err?.message || 'Could not load the full output.' })
    }
  }
  return (
    <div className="mt-1">
      <button type="button" onClick={toggle} aria-expanded={state.open}
        className="inline-flex items-center gap-1 rounded border border-x-line bg-x-surface px-1.5 py-0.5 font-mono text-[11px] text-x-ink-secondary hover:text-x-ink">
        {state.loading ? <Loader2 size={10} className="animate-spin" /> : <FileText size={10} />}
        {state.open ? 'Hide full output' : 'Show full output'}
      </button>
      {state.open && !state.loading && (state.error
        ? <p className="mt-1 text-[11px] text-x-danger">{state.error}</p>
        : <div className="mt-1 max-h-[60vh] overflow-auto"><FullCodeBlock text={state.text} /></div>)}
    </div>
  )
}

const TerminalTranscriptRow = memo(function TerminalTranscriptRow({ msg, sessionId, trackInTimeline = true }) {
  const [copied, setCopied] = useState(false)
  const role = effectiveMessageRole(msg)
  const meta = getRoleMeta(role)
  const time = formatMessageTime(msg.created_at)
  const tokenBreakdown = usageTokenBreakdown(msg)
  const tokens = tokenBreakdown?.active ?? null
  const duration = Number(msg.duration_ms)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(contentToText(msg.content))
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {}
  }

  if (!hasVisibleMessage(msg.content) && !msg.content_truncated) return null
  const isUser = role === 'user' || role === 'human'
  return (
    <article
      id={`msg-${msg.id}`}
      data-chat-message-row="true"
      data-chat-message-id={msg.id}
      data-chat-role={role}
      data-chat-role-label={meta.label}
      {...(trackInTimeline ? { 'data-chat-timeline-row': 'true' } : {})}
      className={`ive-conversation-message ${isUser ? 'is-user' : 'is-assistant'}`}
    >
      <div className="ive-conversation-content">
        <FormatMessageContent content={msg.content} sessionId={sessionId} />
        {msg.content_truncated && msg.id && <TruncatedOutputNotice sessionId={sessionId} messageId={msg.id} />}
      </div>
      <div className="ive-conversation-message-actions">
        <time>{time}</time>
        <button type="button" onClick={handleCopy} aria-label={copied ? 'Message copied' : 'Copy message'} title="Copy message">
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
    </article>
  )
})

const CommandTranscriptRow = memo(function CommandTranscriptRow({ msg }) {
  const text = contentToText(msg.content).trim()
  return (
    <div className="flex items-center gap-2 px-3 py-1 font-mono text-[11px] text-x-faint" data-command-row>
      <span className="rounded border border-x-line bg-x-surface px-1.5 py-0.5 text-x-ink-secondary">{text}</span>
      <span className="text-x-faint">{formatMessageTime(msg.created_at)}</span>
    </div>
  )
})

// Helper to group consecutive agent process messages and tool results
function groupMessages(messages) {
  const grouped = []
  let currentProcessFlow = null
  const usageOnce = createUsageOnceFilter()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const countsUsage = usageOnce(msg)
    const role = effectiveMessageRole(msg)
    const blocks = contentBlocks(msg.content) || []
    const hasProcess = blocks.some(isProcessBlock)
    const isPlainTextAssistant = role === 'assistant' && !hasProcess
    const isUserPrompt = (role === 'user' || role === 'human') && role !== 'tool_result'

    if (role === 'command') {
      if (currentProcessFlow) {
        grouped.push(currentProcessFlow)
        currentProcessFlow = null
      }
      grouped.push({ id: `group-cmd-${msg.id}`, type: 'command', msg })
    } else if (isUserPrompt) {
      if (currentProcessFlow) {
        grouped.push(currentProcessFlow)
        currentProcessFlow = null
      }
      grouped.push({
        id: `group-msg-${msg.id}`,
        type: 'message',
        msg
      })
    } else if (isPlainTextAssistant) {
      if (currentProcessFlow) {
        grouped.push(currentProcessFlow)
        currentProcessFlow = null
      }
      grouped.push({
        id: `group-msg-${msg.id}`,
        type: 'message',
        msg
      })
    } else {
      // Process-related message (tool result, or assistant with thinking/tool calls)
      if (!currentProcessFlow) {
        currentProcessFlow = {
          id: `process-flow-${msg.id}`,
          type: 'process_flow',
          messages: [],
          created_at: msg.created_at,
          duration_ms: 0,
          tokens: 0,
        }
      }
      currentProcessFlow.messages.push(msg)
      const tokenBreakdown = usageTokenBreakdown(msg)
      if (tokenBreakdown && countsUsage) {
        currentProcessFlow.tokens += tokenBreakdown.active
      }
      if (msg.duration_ms) {
        currentProcessFlow.duration_ms += Number(msg.duration_ms)
      }
    }
  }

  if (currentProcessFlow) {
    grouped.push(currentProcessFlow)
  }

  return grouped
}

function isClearCommandMessage(msg) {
  const role = effectiveMessageRole(msg)
  if (role === 'command') {
    return (contentBlocks(msg.content) || []).some((block) => isCommandBlock(block) && block.name.trim() === '/clear')
  }
  if (role !== 'user' && role !== 'human') return false
  const text = contentToText(msg.content).trim()
  return text === '/clear' || /<command-name>\s*\/clear\s*<\/command-name>/.test(text)
}

function timelineEligibleRole(role) {
  return role === 'user' || role === 'human' || role === 'assistant'
}

function countTimelineMessages(messages) {
  return messages.filter((msg) => timelineEligibleRole(effectiveMessageRole(msg))).length
}

function buildClearContextSegments(messages) {
  const segments = []
  let current = []
  let clearCount = 0

  messages.forEach((msg, index) => {
    if (isClearCommandMessage(msg)) {
      clearCount += 1
      segments.push({
        id: `clear-context-${msg.id || index}`,
        type: 'cleared_context',
        clearMessage: msg,
        messages: current,
        ordinal: clearCount,
      })
      current = []
      return
    }
    current.push(msg)
  })

  if (current.length > 0 || segments.length === 0) {
    segments.push({
      id: 'active-context',
      type: 'active_context',
      messages: current,
    })
  }

  return segments
}

function ClearedContextBlock({ segment, renderMessages }) {
  const [open, setOpen] = useState(false)
  const time = formatMessageTime(segment.clearMessage?.created_at)
  const messageCount = countTimelineMessages(segment.messages)
  const lastPreviewMessage = [...segment.messages]
    .reverse()
    .find((msg) => timelineEligibleRole(effectiveMessageRole(msg)))
  const preview = compactQuote(contentToText(lastPreviewMessage?.content), 90)
  const countLabel = `${messageCount} message${messageCount === 1 ? '' : 's'}`

  return (
    <div
      id={`msg-${segment.id}`}
      data-chat-timeline-row="true"
      data-chat-message-id={segment.id}
      data-chat-role="cleared_context"
      data-chat-role-label="clear"
      className="my-1.5 overflow-hidden border-y border-x-line bg-x-surface-2"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-x-hover"
      >
        <ChevronDown size={12} className={`shrink-0 text-x-accent-ink/80 transition-transform ${open ? '' : '-rotate-90'}`} />
        <Archive size={12} className="shrink-0 text-x-accent-ink/80" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-x-accent-ink/85">
            <span>Cleared context</span>
            {time ? <span className="text-x-muted normal-case tracking-normal">{time}</span> : null}
          </div>
          {preview ? (
            <div className="truncate text-[11px] leading-4 text-x-muted">
              {preview}
            </div>
          ) : null}
        </div>
        <span className="shrink-0 rounded border border-x-line bg-x-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-x-accent-ink/75">
          {countLabel}
        </span>
      </button>

      {open ? (
        <div className="border-t border-x-line px-2 py-1.5">
          {segment.messages.length > 0 ? (
            renderMessages(segment.messages, { archived: true })
          ) : (
            <div className="px-3 py-3 text-center text-[11px] text-x-faint">
              No messages before this clear.
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

function getLatestStepPreview(steps) {
  if (!steps || steps.length === 0) return null
  const lastStep = steps[steps.length - 1]

  if (lastStep.type === 'thinking') {
    const text = String(lastStep.block.thinking || lastStep.block.text || '').trim()
    return {
      label: 'Thinking',
      text,
      tone: 'violet',
    }
  }

  if (lastStep.type === 'tool_execution') {
    const name = lastStep.tool_use.name || 'tool'
    if (lastStep.tool_result) {
      const resultText = toolResultText(lastStep.tool_result.content)
      const isSafety = resultText.includes('[Safety Gate]')
      return {
        label: `Completed ${name}`,
        text: isSafety ? 'Blocked by safety policy' : resultText,
        tone: isSafety ? 'red' : 'amber',
      }
    } else {
      const input = lastStep.tool_use.input
      const command = input && typeof input === 'object' ? (input.command || input.cmd || input.shell_command) : null
      const path = input && typeof input === 'object' ? (input.file_path || input.path || input.file) : null
      return {
        label: `Calling ${name}`,
        text: command || path || JSON.stringify(input || ''),
        tone: 'cyan',
        running: true,
      }
    }
  }

  if (lastStep.type === 'task_notification') {
    return {
      label: lastStep.block.summary || 'Background task',
      text: lastStep.block.output_text || lastStep.block.result || '',
      tone: lastStep.block.status === 'running' ? 'cyan' : 'amber',
    }
  }

  if (lastStep.type === 'text') {
    return {
      label: 'Agent note',
      text: lastStep.block.text || '',
      tone: 'zinc',
    }
  }

  if (lastStep.type === 'tool_result') {
    const text = toolResultText(lastStep.block.content)
    const isSafety = text.includes('[Safety Gate]')
    return {
      label: 'Tool result',
      text: isSafety ? 'Blocked by safety policy' : text,
      tone: isSafety ? 'red' : 'amber',
    }
  }

  return null
}

function ToolExecutionBlock({ step, sessionId, forceOpen = null, isStale = false }) {
  const toolUse = step.tool_use
  const toolResult = step.tool_result
  const name = toolUse.name || 'tool'
  const input = toolUse.input
  const isObj = isPlainObject(input)
  const command = isObj ? (input.command || input.cmd || input.shell_command) : null
  const description = isObj ? (input.description || input.summary || input.reason) : null
  const path = isObj ? toolPathFromInput(input) : null
  const rawInputText = input == null ? '' : typeof input === 'string' ? input : JSON.stringify(input, null, 2)
  const mainText = command || rawInputText
  const lineMeta = textLineCount(mainText)
  const subtitle = description || path || (lineMeta ? `${lineMeta} line${lineMeta === 1 ? '' : 's'}` : '')
  const canPreviewFile = shouldPreviewToolFile(name, input, command)

  const extraFields = isObj
    ? Object.entries(input)
      .filter(([key]) => !['description', 'summary', 'reason', 'command', 'cmd', 'shell_command', 'file_path', 'path', 'file', 'filename'].includes(key))
      .slice(0, 6)
    : []

  let tone = 'cyan'
  let resultComponent = null

  if (toolResult) {
    const resultText = toolResultText(toolResult.content)
    const isSafety = resultText.includes('[Safety Gate]')
    tone = isSafety ? 'red' : 'amber'

    if (isSafety) {
      const cleanMessage = resultText.replace('[Safety Gate]', '').trim()
      resultComponent = (
        <div className="mt-2.5 rounded border border-x-accent-ink/20 bg-x-accent-ink/[0.02] p-2">
          <div className="flex items-start gap-2.5 font-mono text-[11px] leading-relaxed text-x-accent-ink/90">
            <Shield size={13} className="mt-0.5 shrink-0 text-x-accent-ink/60" />
            <div className="flex-1">{cleanMessage}</div>
          </div>
        </div>
      )
    } else {
      const lines = textLineCount(resultText)
      resultComponent = (
        <div className="mt-2.5">
          <ProcessDisclosure
            title="Result output"
            subtitle={lines ? `${lines} line${lines === 1 ? '' : 's'}` : 'empty'}
            tone="amber"
            preview={<CompactCodePreview text={firstLines(resultText || 'No output', 2)} />}
          >
            <FullCodeBlock text={resultText || 'No output'} />
          </ProcessDisclosure>
        </div>
      )
    }
  } else if (isStale) {
    tone = 'zinc'
    resultComponent = (
      <div className="mt-2.5 flex items-center gap-2 font-mono text-[11px] text-x-faint">
        <span className="w-1.5 h-1.5 rounded-full border-[1.5px] border-x-faint" />
        <span>No result captured</span>
      </div>
    )
  } else {
    resultComponent = (
      <div className="mt-2.5 flex items-center gap-2 font-mono text-[11px] text-x-faint">
        <span className="w-1.5 h-1.5 rounded-full bg-x-good animate-ping" />
        <span>Executing tool...</span>
      </div>
    )
  }

  return (
    <ProcessDisclosure
      title={`Calling ${name}`}
      subtitle={subtitle}
      tone={tone}
      forceOpen={forceOpen}
      preview={
        canPreviewFile && sessionId
          ? <FileCallPreview sessionId={sessionId} path={path} compact />
          : mainText
            ? <CompactCodePreview text={firstLines(mainText, 2)} lang={command ? 'bash' : 'json'} />
            : null
      }
    >
      {description ? <div className="mb-1.5 font-mono text-[11px] text-x-ink-secondary">{description}</div> : null}
      {path ? <div className="mb-1.5 font-mono text-[11px] text-x-faint">Path: <code className="text-x-accent">{path}</code></div> : null}
      {canPreviewFile && sessionId ? <FileCallPreview sessionId={sessionId} path={path} /> : null}
      {command ? (
        <div className="mb-2">
          <div className="mb-1 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-x-faint">
            <Code2 size={10} />
            Command
          </div>
          <FullCodeBlock text={command} lang="bash" />
        </div>
      ) : null}
      {rawInputText && !command ? (
        <div className="mb-2">
          <div className="mb-1 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-x-faint">
            <Code2 size={10} />
            Raw call
          </div>
          <div className="max-h-72 overflow-auto rounded">
            <FullCodeBlock text={rawInputText} lang={isObj ? 'json' : null} />
          </div>
        </div>
      ) : null}
      {extraFields.length > 0 ? (
        <div className="mt-2 space-y-0.5 font-mono text-[11px] text-x-faint">
          {extraFields.map(([key, value]) => (
            <div key={key}><span className="text-x-muted">{key}:</span> {previewToolValue(value)}</div>
          ))}
        </div>
      ) : null}
      {resultComponent}
    </ProcessDisclosure>
  )
}

function ProcessStepRow({ step, activeMessageId, sessionId, forceOpen = null, isStale = false }) {
  const ref = useRef(null)
  const msgId = step.msg?.id || step.useMsg?.id
  const resultMsgId = step.resultMsg?.id
  const isActive = msgId && (activeMessageId === msgId || activeMessageId === resultMsgId)

  useEffect(() => {
    if (isActive && ref.current) {
      const timer = setTimeout(() => {
        const row = ref.current
        const container = row?.closest('[data-session-scroll]')
        if (!container) return
        const rowRect = row.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()
        container.scrollTo({
          top: Math.max(0, container.scrollTop + rowRect.top - containerRect.top - (container.clientHeight - rowRect.height) / 2),
          behavior: 'smooth',
        })
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [isActive])

  const renderStepContent = () => {
    switch (step.type) {
      case 'thinking':
        return <ThinkingProcessBlock block={step.block} forceOpen={forceOpen} />
      case 'tool_execution':
        return <ToolExecutionBlock step={step} sessionId={sessionId} forceOpen={forceOpen} isStale={isStale} />
      case 'task_notification':
        return <BackgroundTaskProcessBlock block={step.block} />
      case 'text':
        return (
          <div className="pl-2.5 py-1 border-l border-x-line-subtle text-[11px] font-sans text-x-ink-secondary/90 leading-relaxed">
            <FormatMessageContent content={step.block.text} sessionId={sessionId} />
          </div>
        )
      case 'tool_result':
        return <ToolResultProcessBlock block={step.block} />
      default:
        return null
    }
  }

  return (
    <div
      ref={ref}
      id={msgId ? `msg-${msgId}` : undefined}
      className={`transition-all duration-300 rounded-md relative ${
        isActive
          ? 'ring-1 ring-x-good/30 bg-x-good/[0.02] p-1'
          : ''
      }`}
    >
      {resultMsgId && <div id={`msg-${resultMsgId}`} className="absolute top-0 left-0 h-0 w-0 pointer-events-none opacity-0" />}
      {renderStepContent()}
      {[step.msg, step.useMsg, step.resultMsg].filter((m, i, all) => m?.content_truncated && m.id && all.indexOf(m) === i)
        .map((m) => <TruncatedOutputNotice key={m.id} sessionId={sessionId} messageId={m.id} />)}
    </div>
  )
}

function ProcessFlowDisclosure({ steps, activeMessageId, sessionId, open, setOpen, isFlowRunning, showProcessing = false }) {
  return (
    <div className="ive-conversation-activity">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="ive-conversation-activity-toggle">
        {isFlowRunning ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
        <span>{activityLabel(steps, isFlowRunning)}</span>
        <ChevronDown size={13} className={open ? '' : '-rotate-90'} />
      </button>

      {open ? (
        <div className="border-t border-x-line-subtle p-3 space-y-3 bg-x-surface-2/30">
          {steps.map((step, idx) => {
            const stepKey = `${step.type}-${idx}`
            // A tool call with no result is "stale" if the flow has either
            // ended or has already moved on to a later step — only the most
            // recent tool_use in a still-running flow is actually executing.
            const isStale = step.type === 'tool_execution'
              && !step.tool_result
              && (idx < steps.length - 1 || !isFlowRunning)
            return (
              <ProcessStepRow
                key={stepKey}
                step={step}
                activeMessageId={activeMessageId}
                sessionId={sessionId}
                forceOpen={showProcessing}
                isStale={isStale}
              />
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

const ProcessFlowTranscriptRow = memo(function ProcessFlowTranscriptRow({ group, activeMessageId, sessionId, isLast, isAgentBusy, showProcessing }) {
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(showProcessing)

  useEffect(() => {
    setOpen(showProcessing)
  }, [showProcessing])

  const meta = getRoleMeta('assistant')
  const firstMsg = group.messages[0]
  const time = formatMessageTime(firstMsg?.created_at)
  const tokens = group.tokens
  const duration = group.duration_ms
  const isFlowRunning = isLast && isAgentBusy

  const handleCopy = async () => {
    try {
      const texts = []
      group.messages.forEach(msg => {
        const blocks = contentBlocks(msg.content)
        if (Array.isArray(blocks)) {
          blocks.forEach(b => {
            if (b.type === 'thinking') {
              texts.push(`[Thinking]\n${b.thinking || b.text || ''}`)
            } else if (b.type === 'tool_use') {
              texts.push(`[Tool Call: ${b.name}]\n${JSON.stringify(b.input, null, 2)}`)
            } else if (b.type === 'tool_result') {
              texts.push(`[Tool Result]\n${toolResultText(b.content)}`)
            } else if (b.type === 'text') {
              texts.push(b.text || '')
            }
          })
        } else {
          texts.push(contentToText(msg.content))
        }
      })
      await navigator.clipboard.writeText(texts.join('\n\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {}
  }

  const { steps, responseText } = useMemo(() => {
    const allBlocks = []
    group.messages.forEach(msg => {
      const blocks = contentBlocks(msg.content)
      if (Array.isArray(blocks)) {
        blocks.forEach(block => {
          allBlocks.push({ block, msg })
        })
      } else {
        const text = contentToText(msg.content)
        if (text) {
          allBlocks.push({
            block: { type: 'text', text },
            msg
          })
        }
      }
    })

    const steps = []
    const toolCallMap = new Map()

    allBlocks.forEach(({ block, msg }) => {
      if (!block || typeof block !== 'object') return
      const type = String(block.type || '').toLowerCase()

      if (type === 'thinking' && String(block.thinking || block.text || '').trim()) {
        steps.push({
          type: 'thinking',
          block,
          msg
        })
      } else if (type === 'tool_use') {
        const step = {
          type: 'tool_execution',
          tool_use: block,
          tool_result: null,
          useMsg: msg,
          resultMsg: null,
        }
        steps.push(step)
        const id = block.id || block.tool_use_id
        if (id) {
          toolCallMap.set(id, step)
        }
      } else if (type === 'tool_result' || type === 'toolresult' || type === 'function_response' || type === 'functionresponse') {
        const toolUseId = block.tool_use_id || block.id
        let matchedStep = null
        if (toolUseId && toolCallMap.has(toolUseId)) {
          matchedStep = toolCallMap.get(toolUseId)
        } else {
          for (let i = steps.length - 1; i >= 0; i--) {
            if (steps[i].type === 'tool_execution' && !steps[i].tool_result) {
              matchedStep = steps[i]
              break
            }
          }
        }

        if (matchedStep) {
          matchedStep.tool_result = block
          matchedStep.resultMsg = msg
        } else {
          steps.push({
            type: 'tool_result',
            block,
            msg
          })
        }
      } else if (type === 'task_notification') {
        steps.push({
          type: 'task_notification',
          block,
          msg
        })
      } else if (type === 'text' || block.text) {
        steps.push({
          type: 'text',
          block,
          msg
        })
      }
    })

    let lastNonTextIndex = steps.length - 1
    while (lastNonTextIndex >= 0 && steps[lastNonTextIndex].type === 'text') {
      lastNonTextIndex--
    }

    const trailingTextSteps = steps.splice(lastNonTextIndex + 1)
    const responseText = trailingTextSteps.map(s => s.block.text || '').filter(Boolean).join('\n\n')

    return { steps, responseText }
  }, [group.messages])

  if (!steps.length && !responseText) return null
  return (
    <div className="ive-conversation-process">
      {!open && group.messages.map((msg) => <span key={msg.id} id={`msg-${msg.id}`} aria-hidden="true" />)}
      <div className="min-w-0">

        {steps.length > 0 && (
          <ProcessFlowDisclosure
            steps={steps}
            activeMessageId={activeMessageId}
            sessionId={sessionId}
            open={open}
            setOpen={setOpen}
            isFlowRunning={isFlowRunning}
            showProcessing={showProcessing}
          />
        )}

        {responseText ? (
          <div className="mt-2 text-x-ink/95">
            <FormatMessageContent content={responseText} sessionId={sessionId} />
          </div>
        ) : null}
      </div>
    </div>
  )
})

// Composer text field: subscribes to its own draft (sessionInputs) so a
// keystroke re-renders this field, not the whole panel and its transcript.
// The draft stays in the store (persistence, restore after a failed send,
// quick start prefill). Handlers come through a ref that ChatPanel refreshes
// on every render, so this memoized field never needs new props for them.
const ComposerTextarea = memo(function ComposerTextarea({ sessionId, textareaRef, handlersRef, placeholder, disabled }) {
  const value = useStore((s) => s.sessionInputs[sessionId] || '')
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 32), 132)}px`
  }, [value, textareaRef])
  return (
    <textarea
      ref={textareaRef}
      rows={1}
      value={value}
      onChange={(e) => handlersRef.current.onChange(e)}
      onSelect={(e) => handlersRef.current.onSelect(e)}
      onKeyDown={(e) => handlersRef.current.onKeyDown(e)}
      onPaste={(e) => handlersRef.current.onPaste(e)}
      placeholder={placeholder}
      disabled={disabled}
      className="flex-1 resize-none bg-transparent text-x-ink placeholder-x-muted text-[13px] leading-5 focus:outline-none py-1.5 disabled:cursor-not-allowed max-h-32 scrollbar-thin"
      style={{ minHeight: 32 }}
    />
  )
})

const ComposerTokenChips = memo(function ComposerTokenChips({ sessionId }) {
  const value = useStore((s) => s.sessionInputs[sessionId] || '')
  return (
    <TokenChips
      text={value}
      sessionId={sessionId}
      className="px-3 py-1.5 bg-x-surface border border-x-line rounded-lg shadow-x-1"
    />
  )
})

function groupHasMessage(group, messageId) {
  if (!messageId || !group?.messages) return false
  return group.messages.some((m) => m.id === messageId)
}

// The transcript list. Memoized: typing, timers and header changes do not
// reach it. Groups are computed once per message list, and only the newest
// `renderLimit` groups of the current context are rendered; "Show earlier"
// renders more and, once everything loaded is shown, loads older rows.
const TranscriptBody = memo(function TranscriptBody({
  grouped,
  sessionId,
  activeMessageId,
  isAgentBusy,
  showProcessing,
  renderLimit,
  olderRows,
  loadingOlder,
  onShowEarlier,
}) {
  const renderGroup = (group, index, groups, archived) => {
    if (group.type === 'message') {
      return (
        <TerminalTranscriptRow
          key={group.id}
          msg={group.msg}
          sessionId={sessionId}
          trackInTimeline={!archived}
        />
      )
    }
    if (group.type === 'command') {
      return <CommandTranscriptRow key={group.id} msg={group.msg} />
    }
    if (group.type === 'process_flow') {
      const isLast = !archived && index === groups.length - 1
      return (
        <ProcessFlowTranscriptRow
          key={group.id}
          group={group}
          activeMessageId={groupHasMessage(group, activeMessageId) ? activeMessageId : null}
          sessionId={sessionId}
          isLast={isLast}
          isAgentBusy={isLast ? isAgentBusy : false}
          showProcessing={showProcessing}
        />
      )
    }
    return null
  }
  const renderArchived = (messages) => {
    const groups = groupMessages(messages)
    return groups.map((group, index) => renderGroup(group, index, groups, true))
  }

  const lastEntry = grouped[grouped.length - 1]
  const activeGroups = lastEntry?.groups || []
  const hiddenGroups = Math.max(0, activeGroups.length - renderLimit)
  const showEarlier = hiddenGroups > 0 || olderRows > 0

  return (
    <div className="ive-conversation-transcript">
      {showEarlier && (
        <div className="flex justify-center py-1.5">
          <button
            type="button"
            data-testid="chat-show-earlier"
            onClick={onShowEarlier}
            disabled={loadingOlder}
            className="inline-flex items-center gap-1.5 rounded-md border border-x-line bg-x-surface px-2.5 py-1 font-sans text-[11px] text-x-muted hover:text-x-ink-secondary hover:border-x-accent/35 transition-colors duration-[80ms] disabled:opacity-60 cursor-pointer"
            title={olderRows > 0 ? `${olderRows} older transcript rows are not loaded yet` : undefined}
          >
            {loadingOlder ? <Loader2 size={11} className="animate-spin" /> : <ChevronDown size={11} className="rotate-180" />}
            {loadingOlder
              ? 'Loading earlier messages…'
              : hiddenGroups > 0
                ? `Show earlier (${hiddenGroups} more)`
                : 'Load earlier messages'}
          </button>
        </div>
      )}
      {grouped.map(({ segment, groups }, segIndex) => {
        const isActive = segIndex === grouped.length - 1 && groups
        if (segment.type === 'cleared_context') {
          // Older than the hidden groups: shown once those are.
          if (hiddenGroups > 0) return null
          return (
            <ClearedContextBlock
              key={segment.id}
              segment={segment}
              renderMessages={renderArchived}
            />
          )
        }
        const visible = isActive && hiddenGroups > 0 ? groups.slice(hiddenGroups) : groups
        return (
          <div key={segment.id}>
            {visible.map((group, i) => renderGroup(group, i + (groups.length - visible.length), groups, false))}
          </div>
        )
      })}
    </div>
  )
})

export default function ChatPanel({ sessionId, onToggleTerminal, onOpenTerminal = onToggleTerminal, isTerminalOpen = false, inGrid = false, phone = false }) {
  // Phone (full screen, App.jsx): the composer sits in the flow at the bottom,
  // right above the iOS keyboard, so the transcript ends above it.
  const inFlowComposer = inGrid || phone
  const messages = useStore((s) => s.messages?.[sessionId] || EMPTY_MESSAGES)
  const replyWait = useStore((s) => s.awaitingReplies[sessionId])
  // Only "is there text?": the draft itself lives in ComposerTextarea, so
  // typing does not re-render the panel (long transcripts made every key
  // take 300+ ms). Read the current text with readInput().
  const hasInputText = useStore((s) => Boolean((s.sessionInputs[sessionId] || '').trim()))
  const readInput = useCallback(() => useStore.getState().sessionInputs[sessionId] || '', [sessionId])
  const setSessionInput = useStore((s) => s.setSessionInput)
  const chatDraft = useStore((s) => s.chatDrafts?.[sessionId] || EMPTY_CHAT_DRAFT)
  const updateChatDraft = useStore((s) => s.updateChatDraft)
  const setMessages = (action) => {
    const current = useStore.getState().messages?.[sessionId] || EMPTY_MESSAGES
    const next = typeof action === 'function' ? action(current) : action
    useStore.getState().setSessionMessages(sessionId, next)
  }
  const setInputVal = useCallback((action) => {
    const current = useStore.getState().sessionInputs[sessionId] || ''
    const next = typeof action === 'function' ? action(current) : action
    setSessionInput(sessionId, next)
  }, [sessionId, setSessionInput])
  const pastedImages = chatDraft.pastedImages || EMPTY_MESSAGES
  const pendingAnnotation = chatDraft.pendingAnnotation || null
  const annotationNote = chatDraft.annotationNote || ''
  const textAnnotations = chatDraft.textAnnotations || EMPTY_MESSAGES
  const showProcessing = Boolean(chatDraft.showProcessing)
  const setPastedImages = useCallback((action) => {
    updateChatDraft(sessionId, (draft) => {
      const current = draft.pastedImages || EMPTY_MESSAGES
      const next = typeof action === 'function' ? action(current) : action
      return { pastedImages: Array.isArray(next) ? next : [] }
    })
  }, [sessionId, updateChatDraft])
  const setPendingAnnotation = useCallback((action) => {
    updateChatDraft(sessionId, (draft) => ({
      pendingAnnotation: typeof action === 'function' ? action(draft.pendingAnnotation || null) : (action || null),
    }))
  }, [sessionId, updateChatDraft])
  const setAnnotationNote = useCallback((action) => {
    updateChatDraft(sessionId, (draft) => ({
      annotationNote: typeof action === 'function' ? action(draft.annotationNote || '') : (action || ''),
    }))
  }, [sessionId, updateChatDraft])
  const setTextAnnotations = useCallback((action) => {
    updateChatDraft(sessionId, (draft) => {
      const current = draft.textAnnotations || EMPTY_MESSAGES
      const next = typeof action === 'function' ? action(current) : action
      return { textAnnotations: Array.isArray(next) ? next : [] }
    })
  }, [sessionId, updateChatDraft])
  const setShowProcessing = useCallback((action) => {
    updateChatDraft(sessionId, (draft) => ({
      showProcessing: typeof action === 'function' ? Boolean(action(Boolean(draft.showProcessing))) : Boolean(action),
    }))
  }, [sessionId, updateChatDraft])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [deliveryIssue, setDeliveryIssue] = useState(null)
  const [isRestarting, setIsRestarting] = useState(false)
  const [transcriptIssue, setTranscriptIssue] = useState(null)
  const scrollContainerRef = useRef(null)
  const textareaRef = useRef(null)
  const focusChatComposer = useCallback(() => textareaRef.current?.focus(), [])
  // Session started or opened (App's cc-focus-terminal): in the chat view the
  // cursor goes into this composer, like Claude Code / Codex / Cursor.
  useEffect(() => {
    const onFocusRequest = () => focusChatComposerFor({ sessionId, activeSessionId: useStore.getState().activeSessionId, textarea: textareaRef.current })
    window.addEventListener('cc-focus-terminal', onFocusRequest)
    return () => window.removeEventListener('cc-focus-terminal', onFocusRequest)
  }, [sessionId])
  const composerHandlersRef = useRef(null)
  const lastMessageHashRef = useRef('')
  const isPinnedRef = useRef(true)
  const pendingOptimisticMessagesRef = useRef([])
  const optimisticBusyStartedAtRef = useRef(null)

  const [activeMessageId, setActiveMessageId] = useState(null)
  const [isTimelineCollapsed, setIsTimelineCollapsed] = useState(true)
  const [showChatSettings, setShowChatSettings] = useState(false)
  const [scrollContainerHeight, setScrollContainerHeight] = useState(0)
  const [composerHeight, setComposerHeight] = useState(0)
  const composerRef = useRef(null)
  const layoutChangedAtRef = useRef(0)
  const scrollGeometryRef = useRef('')

  useEffect(() => {
    setIsTimelineCollapsed(true)
    setShowChatSettings(false)
  }, [inGrid, sessionId])

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const update = () => {
      setScrollContainerHeight(el.clientHeight)
      // A tile that gets narrower or shorter (side chat opens, layout
      // changes) reflows its text; stay at the latest message if the user
      // was there, instead of drifting up and showing "Jump to Latest".
      layoutChangedAtRef.current = Date.now()
      if (isPinnedRef.current) el.scrollTop = el.scrollHeight
      scrollGeometryRef.current = `${el.scrollHeight}x${el.clientHeight}`
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = composerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const update = () => setComposerHeight(el.clientHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const transcriptSegments = useMemo(() => buildClearContextSegments(messages), [messages])
  // Grouped once per message list (not on every render of the panel).
  const transcriptGroups = useMemo(() => transcriptSegments.map((segment) => ({
    segment,
    groups: segment.type === 'cleared_context' ? null : groupMessages(segment.messages),
  })), [transcriptSegments])
  const activeGroupCount = transcriptGroups[transcriptGroups.length - 1]?.groups?.length || 0

  const timelineItems = useMemo(() => {
    const items = []
    transcriptSegments.forEach((segment) => {
      if (segment.type === 'cleared_context') {
        const messageCount = countTimelineMessages(segment.messages)
        items.push({
          id: segment.id,
          role: 'cleared_context',
          type: 'cleared_context',
          created_at: segment.clearMessage?.created_at,
          content: `${messageCount} message${messageCount === 1 ? '' : 's'} cleared`,
          originalIndex: null,
        })
        return
      }

      segment.messages.forEach((msg, index) => {
        const role = effectiveMessageRole(msg)
        if (!timelineEligibleRole(role) || !hasVisibleMessage(msg.content)) return
        items.push({
          id: msg.id,
          role,
          type: 'message',
          created_at: msg.created_at,
          content: contentToText(msg.content),
          originalIndex: index,
        })
      })
    })
    return items
  }, [transcriptSegments])

  useEffect(() => {
    if (timelineItems.length > 0 && !activeMessageId) {
      setActiveMessageId(timelineItems[timelineItems.length - 1].id)
    }
  }, [timelineItems, activeMessageId])

  useEffect(() => {
    if (timelineItems.length > 0 && isPinnedRef.current) {
      setActiveMessageId(timelineItems[timelineItems.length - 1].id)
    }
  }, [timelineItems])

  const [annotatingImage, setAnnotatingImage] = useState(null) // { url, index }
  const [selectedChatText, setSelectedChatText] = useState(null) // { text, x, y, role, roleLabel, sourceLabel }
  const [showRecentAnnotations, setShowRecentAnnotations] = useState(false)
  const [recentAnnotations, setRecentAnnotations] = useState([])
  const annotationInputRef = useRef(null)
  const recentAnnotationsPanelRef = useRef(null)
  const recentAnnotationsCloseTimerRef = useRef(null)
  const [isAgentExecuting, setIsAgentExecuting] = useState(false)
  const [wasInterrupted, setWasInterrupted] = useState(false)
  const [showAutocomplete, setShowAutocomplete] = useState(false)
  const [autocompleteIndex, setAutocompleteIndex] = useState(0)
  const [autocompleteType, setAutocompleteType] = useState(null) // 'slash' | 'ticket' | 'at'
  const [autocompleteQuery, setAutocompleteQuery] = useState('')
  const [modelPickerRequest, setModelPickerRequest] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef(null)

  const session = useStore((store) => store.sessions[sessionId])
  const restartInterruptedAt = useStore((store) => store.restartInterrupted[sessionId] || 0)
  const launchApply = useStore((store) => store.launchApply[sessionId])
  const sessions = useStore((store) => store.sessions)
  const tasks = useStore((store) => store.tasks)
  const sessionStarted = useStore((store) => store.sessionStarted)
  const ptyStartedAt = useStore((store) => store.sessionPtyStartedAt)
  const workStartedAt = useStore((store) => store.sessionWorkStartedAt)
  const activeSessionId = useStore((store) => store.activeSessionId)
  const queuedCommands = useStore((store) => store.queuedCommands?.[sessionId] || EMPTY_MESSAGES)
  const sessionStatus = session?.status || 'idle'
  const cliProfiles = useStore((store) => store.cliProfiles)
  // Model/effort the CLI really used last turn (picks up /model switches
  // typed into the terminal). Refreshed whenever the session stops working.
  const [runtimeModel, setRuntimeModel] = useState(null)
  const [runtimeDetails, setRuntimeDetails] = useState(null)
  const [runtimeModelTick, setRuntimeModelTick] = useState(0)
  useEffect(() => {
    // A live model/effort switch relaunched the CLI: the backend now drops
    // transcript turns older than the relaunch, so ask again.
    const onApplied = (event) => {
      if (event.detail?.session_id === sessionId) setRuntimeModelTick((n) => n + 1)
    }
    window.addEventListener('cc-launch-applied', onApplied)
    return () => window.removeEventListener('cc-launch-applied', onApplied)
  }, [sessionId])
  useEffect(() => {
    if (!sessionId) return undefined
    let cancelled = false
    setRuntimeModel(null)
    setRuntimeDetails(null)
    const refresh = () => api.getSessionRuntimeModel?.(sessionId)
      ?.then((res) => { if (!cancelled) { setRuntimeModel(res?.observed || null); setRuntimeDetails(res) } })
      ?.catch(() => {})
    refresh()
    const timer = setInterval(refresh, 15000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [sessionId, sessionStatus, session?.native_session_id, runtimeModelTick])
  const cliProfile = cliProfiles?.[session?.cli_type || 'claude']
  const modelInfo = headerModelInfo(session, runtimeModel, cliProfile, runtimeDetails?.launched)
  // Picker options come from the CLI profile (Codex: the discovered list).
  const modelOptions = useMemo(() => {
    const list = getModelsForCli(session?.cli_type || 'claude').map((m) => ({
      value: m.id || '',
      label: m.id ? (m.label && m.label !== m.id ? `${m.label} · ${m.id}` : m.id) : (m.label || 'Default'),
      short: m.id || 'default',
      description: m.description,
    }))
    const current = session?.model || ''
    if (current && !list.some((o) => o.value === current)) {
      list.unshift({ value: current, label: current, short: current })
    }
    return list
  }, [session?.cli_type, session?.model, cliProfiles])
  // Empty for CLIs without an effort setting (e.g. Codex): no picker then.
  const effortPickerOptions = useMemo(() => {
    const opts = getEffortOptionsForCli(session?.cli_type || 'claude', session?.model || '')
    const def = effortDefaultValue(cliProfile, session?.model || '')
    return opts.map((o) => ({ ...o, short: o.value || (def ? `${def} (default)` : 'default') }))
  }, [session?.cli_type, session?.model, cliProfiles])
  const sessionHasStarted = hasSessionStarted(session, sessionStarted)
  const sessionStatusMeta = getSessionStatusMeta(sessionStatus, session?.agentState, sessionHasStarted)
  const cliType = session?.cli_type || 'claude'
  const permissionModes = getPermissionModesForCli(cliType)
  const sessionIsWorking = sessionStatusMeta.isWorking
  // Same words as the header, overview and sidebar ("Needs you" included).
  const sessionDisplayMeta = getSessionDisplayStatus(session, sessionStarted)
  const chatActivity = getChatActivity(sessionDisplayMeta, {
    pending: !!replyWait || isAgentExecuting || queuedCommands.length > 0,
    restarting: isRestarting,
    hasStarted: sessionHasStarted,
    interrupted: wasInterrupted,
    deliveryIssue,
  })
  const isAgentBusy = chatActivity?.kind === 'working'
  const isMessagePending = chatActivity?.kind === 'pending'
  const showReplyPending = !!replyWait && !deliveryIssue && !wasInterrupted
    && !['waiting', 'error', 'auth', 'offline'].includes(sessionDisplayMeta.tone)
  useEffect(() => {
    if (['error', 'exited', 'stopped'].includes(sessionStatus)) useStore.getState().clearReplyWait(sessionId)
  }, [sessionStatus, sessionId])
  const showSessionRecovery = !!deliveryIssue || (!chatActivity && ['error', 'auth', 'offline'].includes(sessionDisplayMeta.tone))
  const canSendWhileBusy = cliType === 'antigravity'
  const wsConnected = useStore((store) => store.connected)
  // Nothing typed here may vanish: before the session row is loaded or while
  // the socket reconnects a send could not be delivered. Typing stays
  // possible (the draft is kept), sending waits.
  const composerUnavailable = !session || !wsConnected
  const owner = useStore((state) => ['localhost', 'owner_legacy', 'owner_device'].includes(state.currentAuth?.actor_kind))
  const canAskAside = owner && !!session && !session.read_only
  const sessionCommands = useMemo(() => canAskAside ? [BTW_COMMAND, ...SLASH_COMMANDS] : SLASH_COMMANDS, [canAskAside])
  // Claude/Codex: typing never locks while the agent works; Enter queues the
  // message for this session (lib/composerQueue.js, shown by ComposerQueue).
  const queueEnabled = queueSupported(session)
  const composerQueue = useComposerQueue(sessionId)
  const willQueue = queueEnabled && (isAgentBusy || isMessagePending || !wsConnected ||
    composerQueue.items.some((item) => ['queued', 'sending', 'failed'].includes(item.state)))
  const agentLabel = cliType === 'codex' ? 'Codex' : 'Claude'
  const composerDisabled = sessionStatus === 'exited' || (!queueEnabled && (isMessagePending || (isAgentBusy && !canSendWhileBusy)))
  const composerPlaceholder = !session
    ? 'Loading session…'
    : !wsConnected && queueEnabled
      ? 'Reconnecting to IVE… Enter queues your message until it is back.'
    : !wsConnected
      ? 'Reconnecting to IVE… you can send again in a moment.'
    : sessionStatus !== 'exited' && willQueue && (isAgentBusy || isMessagePending)
      ? `${agentLabel} is working. Write your next message, Enter queues it.`
    : sessionStatus === 'exited'
    ? 'Session is offline. Restart it to send a message.'
    : isMessagePending
      ? chatActivity.label
    : isAgentBusy && canSendWhileBusy
      ? 'Type steering input for Antigravity...'
      : isAgentBusy
        ? 'Agent is working...'
      // Tiles are narrow: a long placeholder wrapped and was cut in half.
      : inGrid ? 'Message this session…' : 'Type a task or instruction for the agent...'
  const transcriptBefore = useStore((store) => store.transcriptWindows[sessionId]?.before || null)
  const conversationStats = useMemo(() => computeConversationStats(messages, session, transcriptBefore), [messages, session, transcriptBefore])
  const hasComposerAnnotations = textAnnotations.length > 0 || !!pendingAnnotation
  const hasComposerAttachments = pastedImages.length > 0 || hasComposerAnnotations
  const [runtimeNow, setRuntimeNow] = useState(Date.now())
  const [localBusyStartedAt, setLocalBusyStartedAt] = useState(null)
  const hasSpeechSupport = typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition)

  const chatContext = useChatContext(sessionId)
  const contextSearch = useContextSearch(sessionId, showAutocomplete && autocompleteType === 'at' ? autocompleteQuery : null)
  const autocompleteItems = useMemo(() => {
    if (autocompleteType === 'slash') {
      const query = autocompleteQuery || ''
      return sessionCommands.filter((item) => item.cmd.startsWith('/' + query)).map((item) => ({
        key: item.cmd,
        label: item.cmd,
        desc: item.desc,
        value: item,
        type: 'slash',
      }))
    }
    if (autocompleteType === 'at') {
      const q = (autocompleteQuery || '').toLowerCase()
      return [
        ...('ticket:'.startsWith(q) ? [{
          key: '@ticket:',
          label: '@ticket:',
          desc: 'Mention a ticket/task from the workspace',
          value: '@ticket:',
          type: 'at_option',
        }] : []),
        ...(contextSearch.query === autocompleteQuery ? contextSearch.items : []).map((entry) => ({
          key: `ctx:${entry.kind}:${entry.path}`,
          label: entry.path,
          value: entry,
          type: 'context',
        })),
      ]
    }
    if (autocompleteType === 'ticket') {
      const query = autocompleteQuery.toLowerCase()
      const currentWorkspaceId = session?.workspace_id
      const wsTasks = Object.values(tasks).filter(
        (t) => t.workspace_id === currentWorkspaceId && t.status !== 'archived'
      )
      const statusWeight = { in_progress: 0, todo: 1, backlog: 2, completed: 3 }
      const sortedTasks = [...wsTasks].sort((a, b) => {
        const wa = statusWeight[a.status] ?? 99
        const wb = statusWeight[b.status] ?? 99
        if (wa !== wb) return wa - wb
        return new Date(b.created_at || 0) - new Date(a.created_at || 0)
      })

      const filtered = query
        ? sortedTasks.filter(
            (t) =>
              t.title?.toLowerCase().includes(query) ||
              t.id?.toLowerCase().includes(query) ||
              t.description?.toLowerCase().includes(query)
          )
        : sortedTasks

      return filtered.slice(0, 8).map((t) => ({
        key: t.id,
        label: `#${t.id.slice(0, 8)}`,
        title: t.title,
        status: t.status,
        value: t,
        type: 'ticket',
      }))
    }
    return []
  }, [autocompleteType, autocompleteQuery, tasks, session?.workspace_id, contextSearch, sessionCommands])

  const appendVoiceResult = useCallback((text) => {
    const cleaned = text.trim()
    if (!cleaned) return
    setInputVal((prev) => {
      const sep = prev && !/\s$/.test(prev) ? ' ' : ''
      return `${prev}${sep}${cleaned}`
    })
  }, [])
  const { listening, toggle: toggleListening } = useVoiceInput(appendVoiceResult)
  const liveTerminalSessions = useMemo(() => {
    if (!sessionId || !session) return []
    return Object.values(sessions)
      .filter((s) => {
        if (s.workspace_id !== session.workspace_id || s.archived) return false
        const isChild = s.parent_session_id === sessionId
        if (!isChild) return false
        return isTerminalVisibleSession(s, sessionStarted)
      })
      .sort((a, b) => {
        const aw = isSessionWorking(a) ? 1 : 0
        const bw = isSessionWorking(b) ? 1 : 0
        if (aw !== bw) return bw - aw
        return String(a.name || '').localeCompare(String(b.name || ''))
      })
      .slice(0, 8)
  }, [session?.workspace_id, sessionId, sessions, sessionStarted])
  const hasComposerFooter = hasComposerAttachments || liveTerminalSessions.length > 0

  useEffect(() => {
    if (!sessionId || !api.getLaunchApply) return undefined
    let cancelled = false
    api.getLaunchApply(sessionId)
      .then((info) => {
        if (cancelled || !info?.fields) return
        for (const field of ['model', 'effort']) {
          if (info.fields[field]) useStore.getState().setLaunchApply(sessionId, field, info.fields[field])
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [sessionId])

  const handleApplyPermissionModeNow = () => applyPermissionModeNow(sessionId)
  const handleUpdatePermissionMode = mode => changePermissionMode(sessionId, mode)

  const handleUpdateLaunchField = async (field, value) => {
    try {
      const updated = await api.updateSession(sessionId, { [field]: value, apply_live: true })
      const results = updated?.launch_apply || {}
      for (const [f, info] of Object.entries(results)) {
        if (f === 'permission_mode') useStore.getState().setPermissionApply(sessionId, info)
        else useStore.getState().setLaunchApply(sessionId, f, info)
      }
      useStore.setState((state) => {
        if (!state.sessions[sessionId]) return {}
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: { ...state.sessions[sessionId], [field]: updated?.[field] ?? value },
          },
        }
      })
    } catch (err) {
      useStore.getState().addNotification({
        type: 'error',
        message: err?.message || `Failed to update ${field}.`,
        sessionId,
      })
    }
  }

  const cyclePermissionMode = useCallback(() => {
    const ids = permissionModes.map((mode) => mode.id)
    if (ids.length === 0) return
    const current = session?.permission_mode || ids[0]
    const idx = ids.indexOf(current)
    const next = ids[(idx >= 0 ? idx + 1 : 0) % ids.length]
    handleUpdatePermissionMode(next)
  }, [permissionModes, session?.permission_mode, sessionId])

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 32), 132)}px`
  }, [])

  useEffect(() => {
    if (!isAgentBusy) {
      setLocalBusyStartedAt(null)
      return
    }
    setLocalBusyStartedAt((prev) => prev || Date.now())
  }, [isAgentBusy])

  useEffect(() => {
    if (!isAgentBusy && liveTerminalSessions.length === 0) return
    const timer = setInterval(() => setRuntimeNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [isAgentBusy, liveTerminalSessions.length])

  useEffect(() => {
    if (!sessionIsWorking) {
      setIsAgentExecuting(false)
      setWasInterrupted(false)
      optimisticBusyStartedAtRef.current = null
    }
  }, [sessionIsWorking, sessionId])

  useEffect(() => {
    if (!isAgentExecuting || sessionIsWorking) return
    const startedAt = optimisticBusyStartedAtRef.current || Date.now()
    optimisticBusyStartedAtRef.current = startedAt
    const remaining = Math.max(0, 8000 - (Date.now() - startedAt))
    const timer = window.setTimeout(() => {
      if (!getSessionStatusMeta(session?.status || 'idle', session?.agentState, hasSessionStarted(session, sessionStarted)).isWorking) {
        setIsAgentExecuting(false)
        optimisticBusyStartedAtRef.current = null
      }
    }, remaining)
    return () => window.clearTimeout(timer)
  }, [isAgentExecuting, sessionIsWorking, session?.status, session?.agentState, session, sessionStarted])

  useEffect(() => {
    setShowAutocomplete(false)
    setAutocompleteType(null)
    setAutocompleteQuery('')
    setAutocompleteIndex(0)
    setIsAgentExecuting(false)
    setDeliveryIssue(null)
    setIsRestarting(false)
    setWasInterrupted(false)
    pendingOptimisticMessagesRef.current = []
    optimisticBusyStartedAtRef.current = null
    setSelectedChatText(null)
    setAnnotatingImage(null)
  }, [sessionId])

  useEffect(() => {
    if (autocompleteIndex >= autocompleteItems.length) {
      setAutocompleteIndex(0)
    }
  }, [autocompleteIndex, autocompleteItems.length])

  useEffect(() => {
    const handleInterrupted = (e) => {
      if (e.detail?.sessionId !== sessionId) return
      useStore.getState().clearReplyWait(sessionId)
      setIsAgentExecuting(false)
      setWasInterrupted(true)
      optimisticBusyStartedAtRef.current = null
    }
    window.addEventListener('cc-session-interrupted', handleInterrupted)
    return () => window.removeEventListener('cc-session-interrupted', handleInterrupted)
  }, [sessionId])

  // lib/terminal could not deliver a prompt: it already put the text back
  // into the composer; drop its bubble and the "executing" state here.
  useEffect(() => {
    const handleSendFailed = (e) => {
      if (e.detail?.sessionId !== sessionId) return
      useStore.getState().clearReplyWait(sessionId)
      const commands = (e.detail.commands || []).map((c) => String(c).trim())
      const failed = (msg) => {
        if (!String(msg?.id || '').startsWith('optimistic')) return false
        const text = contentToText(msg.content).trim()
        const sent = String(msg.match_text || '').trim()
        return !!text && commands.some((cmd) => cmd === text || cmd === sent || cmd.endsWith(text))
      }
      setMessages((prev) => prev.filter((msg) => !failed(msg)))
      setIsAgentExecuting(false)
      setDeliveryIssue(e.detail?.reason || 'The assistant could not accept your message.')
      optimisticBusyStartedAtRef.current = null
    }
    window.addEventListener('cc-terminal-send-failed', handleSendFailed)
    return () => window.removeEventListener('cc-terminal-send-failed', handleSendFailed)
  }, [sessionId])

  const updateAutocomplete = useCallback((value, caret) => {
    const token = getAutocompleteToken(value, caret)
    if (!token) {
      setShowAutocomplete(false)
      setAutocompleteType(null)
      setAutocompleteQuery('')
      setAutocompleteIndex(0)
      return
    }

    let hasItems = false
    if (token.type === 'slash') {
      const q = token.query || ''
      hasItems = sessionCommands.some((item) => item.cmd.startsWith('/' + q))
    } else if (token.type === 'at') {
      hasItems = true
    } else if (token.type === 'ticket') {
      const currentWorkspaceId = useStore.getState().sessions[sessionId]?.workspace_id
      const wsTasks = Object.values(useStore.getState().tasks).filter(
        (t) => t.workspace_id === currentWorkspaceId && t.status !== 'archived'
      )
      hasItems = wsTasks.length > 0
    }

    setAutocompleteType(token.type)
    setAutocompleteQuery(token.query || '')
    setShowAutocomplete(hasItems)
    setAutocompleteIndex(0)
  }, [sessionId, sessionCommands])

  const openAside = useCallback((question = '') => {
    if (!canAskAside) return
    window.dispatchEvent(new CustomEvent('ask-session-aside', { detail: { sessionId, question } }))
    setShowAutocomplete(false)
  }, [sessionId, canAskAside])

  const openModelPicker = useCallback(() => {
    setInputVal('')
    setShowAutocomplete(false)
    setAutocompleteType(null)
    setAutocompleteQuery('')
    setModelPickerRequest((request) => request + 1)
  }, [setInputVal])

  const applyAutocompleteItem = useCallback((item) => {
    const inputVal = readInput()
    const ta = textareaRef.current
    const caret = ta?.selectionStart ?? inputVal.length
    const token = getAutocompleteToken(inputVal, caret)
    if (!token) return

    const start = token.start
    const end = token.end

    if (item.type === 'slash' && item.value.cmd === '/btw' && !inputVal.slice(0, start).trim()) {
      setInputVal('')
      openAside(inputVal.slice(end).trim())
      return
    }

    if (item.type === 'slash' && item.value.cmd === '/model' &&
        !inputVal.slice(0, start).trim() && !inputVal.slice(end).trim() && !session?.read_only) {
      openModelPicker()
      return
    }

    let replacement = ''
    if (item.type === 'slash') {
      replacement = `${item.value.cmd} `
    } else if (item.type === 'at_option') {
      replacement = `@ticket:`
    } else if (item.type === 'context') {
      // The chip carries the file; the typed @query leaves the text.
      chatContext.addProjectEntry(item.value)
    } else if (item.type === 'ticket') {
      const task = item.value
      const tTitle = task.title || ''
      if (tTitle.includes(' ') || tTitle.includes('"') || tTitle.includes(':') || tTitle.includes('\'')) {
        replacement = `@ticket:"${tTitle.replace(/"/g, '\\"')}" `
      } else {
        replacement = `@ticket:${tTitle} `
      }
    }

    const nextValue = `${inputVal.slice(0, start)}${replacement}${inputVal.slice(end)}`
    const nextCaret = start + replacement.length

    setInputVal(nextValue)
    setShowAutocomplete(false)
    setAutocompleteType(null)
    setAutocompleteQuery('')

    requestAnimationFrame(() => {
      if (!textareaRef.current) return
      textareaRef.current.focus()
      textareaRef.current.selectionStart = textareaRef.current.selectionEnd = nextCaret
      resizeTextarea()
    })
  }, [readInput, resizeTextarea, chatContext.addProjectEntry, openModelPicker, openAside, session?.read_only])

  const handleCancelOutput = useCallback(() => {
    interruptTerminalOutput(sessionId)
    setIsAgentExecuting(false)
    setWasInterrupted(true)
  }, [sessionId])

  const closestChatRow = useCallback((node) => {
    const el = node?.nodeType === 1 ? node : node?.parentElement
    return el?.closest?.('[data-chat-message-row="true"]') || null
  }, [])

  const getSelectionSource = useCallback((selection, container) => {
    const rows = Array.from(container.querySelectorAll('[data-chat-message-row="true"]'))
      .filter((row) => {
        try {
          return selection.containsNode(row, true)
        } catch {
          return false
        }
      })

    const fallbackRows = [
      closestChatRow(selection.anchorNode),
      closestChatRow(selection.focusNode),
    ].filter(Boolean)

    const sourceRows = rows.length > 0 ? rows : fallbackRows
    const unique = []
    const seen = new Set()
    const messageIds = []

    sourceRows.forEach((row) => {
      const role = row.dataset.chatRole || 'unknown'
      const label = row.dataset.chatRoleLabel || role
      const msgId = row.dataset.chatMessageId

      if (msgId && !messageIds.includes(msgId)) {
        messageIds.push(msgId)
      }

      const key = `${role}:${label}`
      if (seen.has(key)) return
      seen.add(key)
      unique.push({ role, label })
    })

    if (unique.length === 0) {
      return { role: 'unknown', roleLabel: 'unknown', sourceLabel: 'unknown', messageIds: [] }
    }
    if (unique.length === 1) {
      return {
        role: unique[0].role,
        roleLabel: unique[0].label,
        sourceLabel: unique[0].label,
        messageIds
      }
    }
    return {
      role: 'mixed',
      roleLabel: 'mixed',
      sourceLabel: unique.map((item) => item.label).join(' + '),
      messageIds
    }
  }, [closestChatRow])

  const handleTranscriptMouseUp = useCallback(() => {
    window.setTimeout(() => {
      const selection = window.getSelection?.()
      const container = scrollContainerRef.current
      if (!selection || selection.isCollapsed || !container || selection.rangeCount === 0) {
        setSelectedChatText(null)
        return
      }
      if (!container.contains(selection.anchorNode) || !container.contains(selection.focusNode)) {
        setSelectedChatText(null)
        return
      }

      const text = selection.toString().trim()
      if (text.length < 2) {
        setSelectedChatText(null)
        return
      }

      const rect = selection.getRangeAt(0).getBoundingClientRect()
      const source = getSelectionSource(selection, container)

      let quoteText = text.slice(0, 4000)
      if (source.messageIds && source.messageIds.length > 0) {
        const selectedMsgs = source.messageIds
          .map(id => messages.find(m => String(m.id) === String(id)))
          .filter(Boolean)

        if (selectedMsgs.length > 0) {
          quoteText = selectedMsgs.map(m => {
            const cleanMsg = { role: m.role, content: m.content }
            return JSON.stringify(cleanMsg, null, 2)
          }).join('\n\n')
        }
      }

      setSelectedChatText({
        text: quoteText,
        ...source,
        x: Math.min(window.innerWidth - 112, Math.max(112, rect.left + rect.width / 2)),
        y: Math.max(72, rect.top - 40),
      })
    }, 0)
  }, [getSelectionSource, messages])

  const beginTextAnnotation = useCallback(() => {
    if (!selectedChatText?.text) return
    setPendingAnnotation({
      id: `ann-${Date.now()}`,
      quote: selectedChatText.text,
      role: selectedChatText.role || 'unknown',
      roleLabel: selectedChatText.roleLabel || 'unknown',
      sourceLabel: selectedChatText.sourceLabel || selectedChatText.roleLabel || 'unknown',
    })
    setAnnotationNote('')
    setSelectedChatText(null)
    window.getSelection?.()?.removeAllRanges()
    requestAnimationFrame(() => annotationInputRef.current?.focus())
  }, [selectedChatText])

  const addPendingAnnotation = useCallback(() => {
    if (!pendingAnnotation?.quote) return
    const next = {
      ...pendingAnnotation,
      id: pendingAnnotation.editingId || pendingAnnotation.id,
      note: annotationNote.trim(),
    }
    delete next.editingId
    setTextAnnotations((prev) => {
      if (!pendingAnnotation.editingId) return [...prev, next]
      return prev.map((ann) => (ann.id === pendingAnnotation.editingId ? next : ann))
    })
    setRecentAnnotations(addRecentAnnotations(session?.workspace_id, next, {
      sessionId,
      sessionName: session?.name || '',
    }))
    setPendingAnnotation(null)
    setAnnotationNote('')
  }, [annotationNote, pendingAnnotation, session?.workspace_id, session?.name, sessionId])

  const cancelPendingAnnotation = useCallback(() => {
    setPendingAnnotation(null)
    setAnnotationNote('')
  }, [])

  const removeTextAnnotation = useCallback((id) => {
    setTextAnnotations((prev) => prev.filter((ann) => ann.id !== id))
  }, [])

  const editTextAnnotation = useCallback((ann) => {
    setPendingAnnotation({
      ...ann,
      editingId: ann.id,
    })
    setAnnotationNote(ann.note || '')
    setSelectedChatText(null)
    requestAnimationFrame(() => annotationInputRef.current?.focus())
  }, [])

  const addRecentAnnotationToComposer = useCallback((ann) => {
    if (!ann?.quote) return
    const next = {
      id: `ann-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      quote: ann.quote,
      note: ann.note || '',
      role: ann.role || ann.roleLabel || 'unknown',
      roleLabel: ann.roleLabel || ann.role || 'unknown',
      sourceLabel: ann.sourceLabel || ann.roleLabel || ann.role || 'unknown',
    }
    setTextAnnotations((prev) => {
      const exists = prev.some((item) => item.quote === next.quote && (item.note || '') === (next.note || ''))
      return exists ? prev : [...prev, next]
    })
  }, [])

  const addAllRecentAnnotationsToComposer = useCallback(() => {
    recentAnnotations.slice(0, 12).forEach(addRecentAnnotationToComposer)
    setShowRecentAnnotations(false)
  }, [addRecentAnnotationToComposer, recentAnnotations])

  const deleteRecentAnnotation = useCallback((annotationId) => {
    setRecentAnnotations((prev) => {
      const next = prev.filter((ann) => ann.id !== annotationId)
      saveRecentAnnotations(session?.workspace_id, next)
      return next
    })
  }, [session?.workspace_id])

  const clearRecentAnnotations = useCallback(() => {
    saveRecentAnnotations(session?.workspace_id, [])
    setRecentAnnotations([])
  }, [session?.workspace_id])

  const copyRecentAnnotations = useCallback(async () => {
    const text = formatTextAnnotations(recentAnnotations.slice(0, 12))
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {}
  }, [recentAnnotations])

  const clearRecentAnnotationsCloseTimer = useCallback(() => {
    if (recentAnnotationsCloseTimerRef.current) {
      window.clearTimeout(recentAnnotationsCloseTimerRef.current)
      recentAnnotationsCloseTimerRef.current = null
    }
  }, [])

  const scheduleRecentAnnotationsClose = useCallback(() => {
    clearRecentAnnotationsCloseTimer()
    recentAnnotationsCloseTimerRef.current = window.setTimeout(() => {
      recentAnnotationsCloseTimerRef.current = null
      setShowRecentAnnotations(false)
    }, 900)
  }, [clearRecentAnnotationsCloseTimer])

  useEffect(() => {
    const refresh = () => setRecentAnnotations(loadRecentAnnotations(session?.workspace_id))
    const open = (event) => {
      if (event.detail?.sessionId && event.detail.sessionId !== sessionId) return
      if (event.detail?.workspaceId && event.detail.workspaceId !== session?.workspace_id) return
      clearRecentAnnotationsCloseTimer()
      refresh()
      setShowRecentAnnotations((openNow) => event.detail?.toggle ? !openNow : true)
    }
    const updated = (event) => {
      if (event.detail?.workspaceId && event.detail.workspaceId !== session?.workspace_id) return
      refresh()
    }
    const addExternal = (event) => {
      if (event.detail?.sessionId && event.detail.sessionId !== sessionId) return
      const ann = event.detail.annotation
      if (!ann?.quote) return
      setTextAnnotations((prev) => {
        if (prev.some((item) => item.id === ann.id || item.quote === ann.quote)) return prev
        return [...prev, ann]
      })
    }
    refresh()
    window.addEventListener('cc-open-annotations', open)
    window.addEventListener('cc-annotations-updated', updated)
    window.addEventListener('cc-add-text-annotation', addExternal)
    return () => {
      window.removeEventListener('cc-open-annotations', open)
      window.removeEventListener('cc-annotations-updated', updated)
      window.removeEventListener('cc-add-text-annotation', addExternal)
    }
  }, [clearRecentAnnotationsCloseTimer, session?.workspace_id, sessionId])

  useEffect(() => {
    if (!showRecentAnnotations) return
    const handleMouseDown = (event) => {
      const target = event.target
      if (recentAnnotationsPanelRef.current?.contains(target)) return
      if (target?.closest?.('[data-annotations-toggle]')) return
      setShowRecentAnnotations(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [showRecentAnnotations])

  useEffect(() => () => clearRecentAnnotationsCloseTimer(), [clearRecentAnnotationsCloseTimer])


  // Cleanup object URLs to avoid memory leaks
  const cleanupPastedImages = (imagesToClean) => {
    imagesToClean.forEach((img) => {
      if (img.previewUrl) URL.revokeObjectURL(img.previewUrl)
    })
  }

  const mergePendingOptimisticMessages = useCallback((fetched) => {
    const now = Date.now()
    const fetchedUserText = new Set(
      fetched
        .filter((msg) => {
          const role = effectiveMessageRole(msg)
          return role === 'user' || role === 'human' || role === 'command'
        })
        .map((msg) => contentToText(msg.content).trim())
        .filter(Boolean)
    )

    const pending = (useStore.getState().pendingOptimisticMessages[sessionId] || []).filter((msg) => {
      const text = contentToText(msg.content).trim()
      const sentText = String(msg.match_text || '').trim()
      const age = now - Number(msg.local_created_at || 0)
      return text && age < 120000 && !fetchedUserText.has(text) && !(sentText && fetchedUserText.has(sentText))
    })
    // The transcript has the last sent prompt: it was delivered, so an exit
    // must not put it back into the composer.
    const lastSent = String(useStore.getState().lastSentPrompts[sessionId] || '').trim()
    if (lastSent && fetchedUserText.has(lastSent)) useStore.getState().setLastSentPrompt(sessionId, '')

    useStore.setState((s) => ({
      pendingOptimisticMessages: {
        ...s.pendingOptimisticMessages,
        [sessionId]: pending,
      },
    }))

    if (!pending.length) return fetched

    const merged = [...fetched]
    pending.forEach((msg) => {
      const msgTime = Date.parse(msg.created_at || '')
      const insertAt = Number.isFinite(msgTime)
        ? merged.findIndex((existing) => {
          const existingTime = Date.parse(existing.created_at || '')
          return Number.isFinite(existingTime) && existingTime > msgTime
        })
        : -1
      if (insertAt >= 0) merged.splice(insertAt, 0, msg)
      else merged.push(msg)
    })
    return merged
  }, [sessionId])

  // Fetch messages from backend JSONL active file. Incremental: the server
  // keeps the parsed transcript and only sends rows after our cursor; one
  // request in flight per panel, extra calls collapse into one follow-up.
  // Transcript rows live in transcriptStates (shared by this session's
  // panels); a panel mount starts over from the tail like before.
  const fetchSessionRef = useRef(sessionId)
  const loadMessagesRef = useRef(null)
  const coalescedLoadRef = useRef(null)
  const panelVisibleRef = useRef(true)
  if (fetchSessionRef.current !== sessionId) {
    fetchSessionRef.current = sessionId
  }

  const publishTranscriptWindow = (state) => {
    useStore.getState().setTranscriptWindow(sessionId, state.base || 0, state.before || null)
  }

  loadMessagesRef.current = async () => {
    const requestedFor = sessionId
    const held = transcriptStates.get(sessionId) || null
    const cursor = held ? (held.cursor || '') : ''
    let data = await api.getMessages(sessionId, cursor, { tail: TRANSCRIPT_TAIL_ROWS })
    if (fetchSessionRef.current !== requestedFor) return
    // Another panel of this session updated the rows meanwhile: it already
    // wrote them to the store; the next poll continues from its cursor.
    if ((transcriptStates.get(sessionId) || null) !== held) return
    let merged = applyMessageDelta(held?.rows ?? null, data, held?.base || 0, held?.before || null)
    if (merged.refetch) {
      data = await api.getMessages(sessionId, '', { tail: TRANSCRIPT_TAIL_ROWS })
      if (fetchSessionRef.current !== requestedFor) return
      merged = applyMessageDelta(null, data)
    }
    if (merged.invalid) {
      console.warn('Invalid message format received:', data)
      return
    }
    setTranscriptIssue(null)
    const nextState = { rows: merged.rows, cursor: merged.cursor || '', base: merged.base || 0, before: merged.before || null }
    transcriptStates.set(sessionId, nextState)
    publishTranscriptWindow(nextState)
    const rows = merged.rows
    const lastFetched = rows[rows.length - 1]
    const lastRole = effectiveMessageRole(lastFetched)
    if (lastRole && lastRole !== 'user' && lastRole !== 'human') {
      setIsAgentExecuting(false)
      optimisticBusyStartedAtRef.current = null
    }
    const hasPendingOptimistic = (useStore.getState().pendingOptimisticMessages[sessionId] || []).length > 0
    if (!merged.changed && !hasPendingOptimistic) {
      setError(null)
      return
    }
    const backgroundTasks = extractBackgroundTasks(rows)
    useStore.getState().mergeBackgroundTasks(sessionId, backgroundTasks)
    setMessages(mergePendingOptimisticMessages(rows))
    const stats = computeConversationStats(rows, useStore.getState().sessions[sessionId], nextState.before)
    useStore.setState((state) => {
      const current = state.sessions[sessionId]
      if (!current) return {}
      if (
        current.turn_count === stats.turns &&
        current.token_count === stats.tokens &&
        current.token_count_estimated === stats.estimated
      ) {
        return {}
      }
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...current,
            turn_count: stats.turns,
            token_count: stats.tokens,
            token_count_estimated: stats.estimated,
          },
        },
      }
    })
    setError(null)
  }
  if (!coalescedLoadRef.current) {
    coalescedLoadRef.current = coalesce(async () => {
      try {
        await loadMessagesRef.current()
      } catch (err) {
        console.error('Failed to load session messages:', err)
        if (err?.body?.code === 'transcript_unavailable') {
          setTranscriptIssue(err.message)
        } else {
          setError('Failed to fetch conversation history.')
        }
      }
    })
  }

  const fetchMessages = async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      await coalescedLoadRef.current()
    } finally {
      if (showLoading) setLoading(false)
    }
  }

  // ─── Windowing: render the newest groups, load older rows on demand ───
  const [renderLimit, setRenderLimit] = useState(RENDER_GROUPS_INITIAL)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const olderRows = useStore((s) => s.transcriptWindows[sessionId]?.base || 0)
  const scrollAnchorRef = useRef(null) // keeps the view in place when rows appear above
  const pendingScrollIdRef = useRef(null) // timeline jump to a row not rendered yet

  const loadOlderRows = async () => {
    const held = transcriptStates.get(sessionId)
    const gen = cursorGeneration(held?.cursor)
    if (!held || !held.base || !gen) return false
    const data = await api.getOlderMessages(sessionId, `${gen}:${held.base}`, TRANSCRIPT_PAGE_ROWS)
    if (transcriptStates.get(sessionId) !== held) return false
    const out = prependOlderRows(held.rows, held.base, data)
    if (out.stale) {
      // Rewritten transcript: start over from the tail.
      transcriptStates.delete(sessionId)
      await coalescedLoadRef.current()
      return false
    }
    const nextState = { ...held, rows: out.rows, base: out.base, before: out.before }
    transcriptStates.set(sessionId, nextState)
    publishTranscriptWindow(nextState)
    setMessages(mergePendingOptimisticMessages(out.rows))
    return true
  }

  const captureScrollAnchor = () => {
    const el = scrollContainerRef.current
    if (el) scrollAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop }
    isPinnedRef.current = false
  }

  const showEarlierRef = useRef(null)
  showEarlierRef.current = async () => {
    if (loadingOlder) return
    captureScrollAnchor()
    if (renderLimit < activeGroupCount) {
      setRenderLimit((n) => n + RENDER_GROUPS_STEP)
      return
    }
    setLoadingOlder(true)
    try {
      if (await loadOlderRows()) setRenderLimit((n) => Math.max(n, activeGroupCount) + RENDER_GROUPS_STEP)
    } catch (err) {
      console.error('Failed to load earlier messages:', err)
      setError('Failed to load earlier messages.')
    } finally {
      setLoadingOlder(false)
    }
  }
  const handleShowEarlier = useCallback(() => showEarlierRef.current?.(), [])

  // Timeline jump to a message outside the rendered window: render down to
  // it first, scroll once it is in the DOM (layout effect below).
  const revealMessage = (messageId) => {
    const active = transcriptGroups[transcriptGroups.length - 1]?.groups || []
    const idx = active.findIndex((g) => g.msg?.id === messageId || g.messages?.some((m) => m.id === messageId))
    pendingScrollIdRef.current = messageId
    setRenderLimit((n) => Math.max(n, idx >= 0 ? active.length - idx : active.length))
  }

  useEffect(() => {
    const handler = event => {
      if (event.detail?.sessionId !== sessionId) return
      setShowProcessing(true)
      revealMessage(event.detail.messageId)
    }
    window.addEventListener('ive-reveal-message', handler)
    return () => window.removeEventListener('ive-reveal-message', handler)
  }, [sessionId, transcriptGroups])

  useLayoutEffect(() => {
    const el = scrollContainerRef.current
    const anchor = scrollAnchorRef.current
    if (el && anchor) {
      scrollAnchorRef.current = null
      el.scrollTop = anchor.top + (el.scrollHeight - anchor.height)
      scrollGeometryRef.current = `${el.scrollHeight}x${el.clientHeight}`
    }
    const pendingId = pendingScrollIdRef.current
    if (pendingId) {
      const target = document.getElementById(`msg-${pendingId}`)
      if (target && el?.contains(target)) {
        pendingScrollIdRef.current = null
        isPinnedRef.current = false
        target.scrollIntoView({ behavior: 'auto', block: 'start' })
        setActiveMessageId(pendingId)
      }
    }
  }, [renderLimit, messages])

  const handleScroll = () => {
    const container = scrollContainerRef.current
    if (!container) return
    // Scroll events caused by a reflow (content or box size changed, e.g.
    // text rewraps when the side chat opens) keep the pin; the user
    // scrolling never changes these sizes.
    const geometry = `${container.scrollHeight}x${container.clientHeight}`
    const reflowed = geometry !== scrollGeometryRef.current
    scrollGeometryRef.current = geometry
    if (isPinnedRef.current && (reflowed || Date.now() - layoutChangedAtRef.current < 150)) {
      container.scrollTop = container.scrollHeight
      return
    }
    const threshold = 45
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    isPinnedRef.current = distanceToBottom < threshold

    // Scroll spy for timeline active dot
    if (timelineItems.length > 0) {
      if (distanceToBottom < threshold) {
        // If we are close to the bottom, the active message is the last one
        setActiveMessageId(timelineItems[timelineItems.length - 1].id)
      } else {
        const elements = container.querySelectorAll('[data-chat-timeline-row="true"]')
        const containerRect = container.getBoundingClientRect()
        let closestMsgId = null
        let minDiff = Infinity

        for (const el of elements) {
          const rect = el.getBoundingClientRect()
          const diff = Math.abs(rect.top - containerRect.top)
          if (diff < minDiff) {
            minDiff = diff
            closestMsgId = el.getAttribute('data-chat-message-id')
          }
        }
        if (closestMsgId) {
          setActiveMessageId(closestMsgId)
        }
      }
    }
  }

  // Load messages on mount/session switch. Rows another panel of this
  // session already holds are reused (the poll continues from its cursor);
  // otherwise start from the tail.
  useEffect(() => {
    setTranscriptIssue(null)
    if (!(useStore.getState().messages?.[sessionId] || []).length) transcriptStates.delete(sessionId)
    setRenderLimit(RENDER_GROUPS_INITIAL)
    fetchMessages(true)
    lastMessageHashRef.current = '' // Reset scroll tracker on session change
    isPinnedRef.current = true // Reset pin state on session switch
    optimisticBusyStartedAtRef.current = null
  }, [sessionId])

  // Only poll while the panel is on screen and the tab is visible.
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting)
      const wasVisible = panelVisibleRef.current
      panelVisibleRef.current = visible
      if (visible && !wasVisible) fetchMessages(false)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [sessionId])

  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden && panelVisibleRef.current) fetchMessages(false)
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [sessionId])

  // Polling to keep chat in sync during active execution
  useEffect(() => {
    if (sessionStatus === 'exited') return undefined
    const isWorking = !!replyWait || getSessionStatusMeta(sessionStatus, session?.agentState, sessionHasStarted).isWorking
    const intervalTime = isWorking ? 1500 : 5000

    const timer = setInterval(() => {
      if (document.hidden || !panelVisibleRef.current) return
      fetchMessages(false)
    }, intervalTime)

    return () => clearInterval(timer)
  }, [sessionId, sessionStatus, session?.agentState, sessionHasStarted, !!replyWait])

  // WebSocket hook events know about state changes before the next polling
  // tick. Refresh now, then once more after the CLI has had a beat to finish
  // writing its JSONL transcript. Bursts of events (a turn end sends two)
  // collapse into one immediate fetch plus one trailing fetch.
  useEffect(() => {
    let trailing = null
    const handleRefresh = (event) => {
      if (event.detail?.sessionId !== sessionId) return
      fetchMessages(false)
      if (trailing) window.clearTimeout(trailing)
      trailing = window.setTimeout(() => {
        trailing = null
        fetchMessages(false)
      }, 450)
    }
    window.addEventListener('cc-session-messages-refresh', handleRefresh)
    return () => {
      window.removeEventListener('cc-session-messages-refresh', handleRefresh)
      if (trailing) window.clearTimeout(trailing)
    }
  }, [sessionId])

  // Restore unsent message on abort / exit
  useEffect(() => {
    if (sessionStatus === 'exited') {
      // Only a prompt the transcript never confirmed goes back into the
      // composer (pending optimistic bubble). A delivered one, or the
      // "/exit" / interrupted rows Claude writes last, must not.
      const pending = useStore.getState().pendingOptimisticMessages[sessionId] || []
      const lastMsg = pending.length > 0 ? pending[pending.length - 1] : null
      const isUserMsg = lastMsg && (lastMsg.role === 'user' || lastMsg.role === 'human')
      const lastSent = useStore.getState().lastSentPrompts[sessionId]
      if (isUserMsg && lastSent) {
        if (!useStore.getState().sessionInputs[sessionId]?.trim()) {
          setInputVal(contentToText(lastMsg.content) || lastSent)
        }
        useStore.getState().setLastSentPrompt(sessionId, '')
      }

      // Clear pending optimistic messages on exit since the process is gone
      useStore.getState().clearOptimisticMessages(sessionId)
      setIsAgentExecuting(false)
      setWasInterrupted(false)
      optimisticBusyStartedAtRef.current = null
    }
  }, [sessionStatus, messages, sessionId])

  // Intelligent Scroll Pinning
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || messages.length === 0) return

    const lastMsg = messages[messages.length - 1]
    const currentHash = lastMsg ? `${lastMsg.id}-${lastMsg.content?.length || 0}` : ''
    const isInitialLoad = lastMessageHashRef.current === ''
    const hasChanged = currentHash !== lastMessageHashRef.current

    lastMessageHashRef.current = currentHash
    if (isInitialLoad || (hasChanged && isPinnedRef.current)) {
      const timer = setTimeout(() => {
        // scrollIntoView also moves the Overview grid and page ancestors.
        // Only follow new replies inside this session's own transcript.
        if (scrollContainerRef.current === container && isPinnedRef.current) {
          container.scrollTop = container.scrollHeight
        }
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [messages])


  // Upload/Paste Image Handling
  const handleUploadImage = async (file) => {
    try {
      const formData = new FormData()
      formData.append('file', file, file.name)
      const res = await fetch('/api/paste-image', { method: 'POST', body: formData })
      if (!res.ok) throw new Error('Upload server error')
      const data = await res.json()

      const newEntry = {
        url: data.url,
        path: data.path,
        filename: data.filename,
        previewUrl: URL.createObjectURL(file),
      }
      setPastedImages((prev) => [...prev, newEntry])
    } catch (err) {
      console.error('Failed to upload image:', err)
      setError('Image upload failed.')
    }
  }

  const handlePaste = async (e) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) {
          await handleUploadImage(file)
        }
      }
    }
  }

  const handleDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    // Text files become context chips (folders and binaries get a notice).
    for (const file of chatContext.acceptFiles(e.dataTransfer)) {
      await handleUploadImage(file)
    }
  }

  const handleFileChange = async (e) => {
    for (const file of chatContext.acceptFiles(Array.from(e.target.files || []))) {
      await handleUploadImage(file)
    }
    e.target.value = '' // Reset so same file can be chosen again
  }

  const removePastedImage = (idx) => {
    setPastedImages((prev) => {
      const img = prev[idx]
      if (img.previewUrl) URL.revokeObjectURL(img.previewUrl)
      return prev.filter((_, i) => i !== idx)
    })
  }

  const handleAnnotationSave = async (blob) => {
    try {
      const formData = new FormData()
      formData.append('file', blob, 'annotated.png')
      const res = await fetch('/api/paste-image', { method: 'POST', body: formData })
      if (!res.ok) throw new Error('Upload error')
      const data = await res.json()

      const idx = annotatingImage?.index
      const newEntry = {
        url: data.url,
        path: data.path,
        filename: data.filename,
        previewUrl: URL.createObjectURL(blob),
      }

      setPastedImages((prev) => {
        if (idx !== null && idx >= 0 && idx < prev.length) {
          const old = prev[idx]
          if (old.previewUrl) URL.revokeObjectURL(old.previewUrl)
          return prev.map((img, i) => (i === idx ? newEntry : img))
        }
        return [...prev, newEntry]
      })
    } catch (err) {
      console.error('Failed to save annotated image:', err)
      setError('Annotation save failed.')
    }
    setAnnotatingImage(null)
  }

  // Form submission handler
  const handleSend = (e, options = {}) => {
    e?.preventDefault()
    const aside = readInput().trim().match(/^\/btw(?:\s+([\s\S]*))?$/i)
    if (aside && canAskAside) {
      setInputVal('')
      openAside(aside[1]?.trim() || '')
      return
    }
    if (readInput().trim() === '/model' && !session?.read_only) {
      openModelPicker()
      return
    }
    const queueThis = willQueue && !options.delivery && sessionStatus !== 'exited'
    if (!queueThis && isMessagePending) return
    if (!queueThis && isAgentBusy && !canSendWhileBusy) return
    if (!queueThis && composerUnavailable) return
    const trimmed = readInput().trim()
    let activeAnnotations = textAnnotations
    if (pendingAnnotation?.quote) {
      const next = {
        ...pendingAnnotation,
        id: pendingAnnotation.editingId || pendingAnnotation.id,
        note: annotationNote.trim(),
      }
      delete next.editingId
      activeAnnotations = pendingAnnotation.editingId
        ? textAnnotations.map((ann) => (ann.id === pendingAnnotation.editingId ? next : ann))
        : [...textAnnotations, next]
    }
    const contextBlock = chatContext.format(cliType)
    if (!trimmed && pastedImages.length === 0 && activeAnnotations.length === 0 && !contextBlock) return
    if (chatContext.busy) {
      chatContext.notify('Wait until the attached files finish loading, then send again.', 'info')
      return
    }
    if (chatContext.blockReason) {
      chatContext.notify(chatContext.blockReason)
      return
    }
    setDeliveryIssue(null)
    const targetSessionId = session?.read_only && session?.annotation_target_session_id
      ? session.annotation_target_session_id
      : sessionId
    if (!targetSessionId) {
      useStore.getState().addNotification?.({
        type: 'error',
        sessionId,
        message: 'Open your own Brainstormer before adding notes to a public view.',
      })
      return
    }
    const targetSession = useStore.getState().sessions[targetSessionId] || session
    if (activeAnnotations.length > 0) {
      setRecentAnnotations(addRecentAnnotations(session?.workspace_id, activeAnnotations, {
        sessionId: targetSessionId,
        sessionName: targetSession?.name || '',
      }))
    }

    const sections = []
    if (trimmed) sections.push(trimmed)
    const annotationText = formatTextAnnotations(activeAnnotations)
    if (annotationText) sections.push(annotationText)
    if (pastedImages.length > 0) {
      const imageMarkdown = pastedImages
        .map((img) => `![${img.filename}](${img.path})`)
        .join('\n\n')
      sections.push(imageMarkdown)
    }
    const bodyText = sections.join('\n\n')
    if (contextBlock) sections.push(contextBlock)
    const fullText = sections.join('\n\n')

    if (queueThis) {
      enqueueMessage(sessionId, fullText, contextBlock ? { body: bodyText, context: queuedContextItems(chatContext.items) } : undefined)
      chatContext.clear()
      setInputVal('')
      setShowAutocomplete(false)
      setAutocompleteType(null)
      setAutocompleteQuery('')
      setPendingAnnotation(null)
      setAnnotationNote('')
      setTextAnnotations([])
      setPastedImages((prev) => {
        cleanupPastedImages(prev)
        return []
      })
      return
    }

    const delivery = options.delivery || (isAgentBusy && canSendWhileBusy ? 'immediate' : 'auto')
    const isQueued = delivery === 'wait_for_ready'

    let optimisticMessage = null
    if (!isQueued) {
      optimisticMessage = {
        id: 'optimistic-' + Date.now(),
        session_id: targetSessionId,
        role: 'user',
        content: fullText,
        created_at: new Date().toISOString(),
        local_created_at: Date.now(),
      }
      useStore.getState().addOptimisticMessage(targetSessionId, optimisticMessage)
      if (targetSessionId === sessionId) {
        setMessages((prev) => [...prev, optimisticMessage])
      }
    }

    setInputVal('')
    useStore.getState().clearRestartInterrupted(sessionId)
    setShowAutocomplete(false)
    setAutocompleteType(null)
    setAutocompleteQuery('')
    setPendingAnnotation(null)
    setAnnotationNote('')
    setTextAnnotations([])
    chatContext.clear()
    setWasInterrupted(false)
    setIsAgentExecuting(true)
    optimisticBusyStartedAtRef.current = Date.now()

    const payload = session?.read_only
      ? `[Note from read-only Brainstormer: ${session?.name || 'public Brainstormer'}]\n\n${fullText}`
      : fullText
    const sent = sendTerminalCommand(targetSessionId, payload, {
      delivery,
      restore: { sessionId, text: fullText },
    })
    noteDirectSend(targetSessionId)
    // @prompt/@ticket/@research and the read-only prefix change the text the
    // CLI gets; the transcript row carries that text, so the bubble must be
    // matched by it or it shows twice until its TTL runs out.
    if (sent?.processed && optimisticMessage && sent.processed !== fullText) {
      optimisticMessage.match_text = sent.processed
      useStore.setState((s) => ({
        pendingOptimisticMessages: {
          ...s.pendingOptimisticMessages,
          [targetSessionId]: (s.pendingOptimisticMessages[targetSessionId] || []).map((msg) =>
            msg.id === optimisticMessage.id ? { ...msg, match_text: sent.processed } : msg),
        },
      }))
    }
    useStore.getState().setLastSentPrompt(targetSessionId, sent?.processed || payload)

    setPastedImages((prev) => {
      cleanupPastedImages(prev)
      return []
    })

    // Force pinning to bottom on message submission
    isPinnedRef.current = true

    const container = scrollContainerRef.current
    setTimeout(() => {
      if (container && scrollContainerRef.current === container && fetchSessionRef.current === sessionId && isPinnedRef.current) {
        container.scrollTop = container.scrollHeight
      }
    }, 50)
  }

  // Fresh closures for the memoized ComposerTextarea, refreshed every render.
  composerHandlersRef.current = {
    onChange: (e) => {
      const val = e.target.value
      setInputVal(val)
      updateAutocomplete(val, e.target.selectionStart)
    },
    onSelect: (e) => updateAutocomplete(e.target.value, e.target.selectionStart),
    onKeyDown: (e) => {
      if (showAutocomplete && autocompleteItems.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setAutocompleteIndex((i) => (i + 1) % autocompleteItems.length)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setAutocompleteIndex((i) => (i - 1 + autocompleteItems.length) % autocompleteItems.length)
        } else if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          applyAutocompleteItem(autocompleteItems[autocompleteIndex])
        } else if (e.key === 'Escape') {
          e.preventDefault()
          setShowAutocomplete(false)
        }
        return
      }
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        cyclePermissionMode()
        return
      }
      if (e.key === 'Escape' && isAgentBusy) {
        e.preventDefault()
        handleCancelOutput()
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend(e)
      }
    },
    onPaste: (e) => handlePaste(e),
  }

  const workingElapsed = formatElapsed(workStartedAt[sessionId] || localBusyStartedAt, runtimeNow)

  const handleRestartSession = async () => {
    if (composerUnavailable || isRestarting || isMessagePending) return
    const requestedFor = sessionId
    setDeliveryIssue(null)
    setWasInterrupted(false)
    setIsRestarting(true)
    try {
      const started = await useStore.getState().restartSession(sessionId)
      if (fetchSessionRef.current === requestedFor && !started) {
        setDeliveryIssue('The session could not restart. Check the connection and try again.')
      }
    } catch (err) {
      if (fetchSessionRef.current === requestedFor) {
        setDeliveryIssue(err?.body?.startup_blocker?.label || err?.message || 'The session could not restart.')
      }
    } finally {
      if (fetchSessionRef.current === requestedFor) setIsRestarting(false)
    }
  }

  const openTerminalSession = (targetId) => {
    const target = sessions[targetId]
    if (target?.workspace_id) {
      useStore.getState().setActiveWorkspace(target.workspace_id)
    }
    useStore.getState().openSession(targetId)
  }

  // IVE restarted while this session worked: its last prompt stays without
  // an answer. Say so instead of dropping it silently.
  const restartInterruptedPrompt = (() => {
    if (!restartInterruptedAt || isAgentBusy) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      const role = effectiveMessageRole(messages[i])
      if (role === 'command') continue
      return role === 'user' || role === 'human' ? messages[i] : null
    }
    return null
  })()

  return (
    <div
      className={`flex-1 flex flex-col min-h-0 bg-x-bg x-canvas ive-conversation select-text relative${inGrid ? ' ive-chat--tile' : ''}${phone ? ' ive-chat--phone' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {(inGrid || phone) && <SessionBrief key={sessionId} sessionId={sessionId} onOpenReview={()=>{useStore.getState().goSession(sessionId);window.dispatchEvent(new CustomEvent('open-panel',{detail:'review'}))}} onOpenPanel={panel=>window.dispatchEvent(new CustomEvent('open-panel',{detail:panel}))} />}
      <SessionContextNotice session={session} runtime={runtimeDetails} />
      {/* ⌘F: find in this chat (own component, see components/find). */}
      <ChatFindBar sessionId={sessionId} scrollRef={scrollContainerRef} focusComposer={focusChatComposer} />
      {/* Session controls; status already appears in the sidebar and Board tile. */}
      <div className={`x-telemetry ive-chat-controls ${inGrid ? 'ive-chat-strip--tile px-2 gap-2' : 'px-4'} py-1.5 flex items-center justify-between text-xs select-none z-20`}>
        {/* Session metadata and selectors */}
        <div className="ive-strip-right flex items-center gap-3 font-mono text-[11px] text-x-ink-secondary shrink-0 whitespace-nowrap">
          {/* Model + effort: shows what the CLI really uses; picking a new
              value restarts the running CLI like Perms (resumes the chat). */}
          <LaunchSettingPicker
            testId="chat-header-model"
            openRequest={modelPickerRequest}
            sessionId={sessionId}
            icon={<ProviderLogo provider={cliType} className="w-3.5 h-3.5 shrink-0" />}
            label="Model:"
            displayValue={modelInfo.model}
            title={`${modelInfo.title} Pick a model to restart the session with it; the conversation continues.`}
            options={modelOptions}
            selected={session?.model || ''}
            apply={launchApply?.model}
            onSelect={(value) => handleUpdateLaunchField('model', value)}
            onApplyNow={handleApplyPermissionModeNow}
            width="w-56"
          />
          <button type="button" className="ive-chat-text-button" aria-expanded={showChatSettings} onClick={() => setShowChatSettings((v) => !v)}>Options <ChevronDown size={12} /></button>
          {showChatSettings && <>
          {effortPickerOptions.length > 0 && (
            <LaunchSettingPicker
              testId="chat-header-effort"
              sessionId={sessionId}
              icon={null}
              label="Effort:"
              displayValue={modelInfo.effort || 'default'}
              title="Reasoning effort. Picking a level restarts the session with --effort; the conversation continues."
              options={effortPickerOptions}
              selected={session?.effort || ''}
              apply={launchApply?.effort}
              onSelect={(value) => handleUpdateLaunchField('effort', value)}
              onApplyNow={handleApplyPermissionModeNow}
              uppercase
              width="w-72"
            />
          )}

          <div className="h-3.5 w-px bg-x-line/45" />

          {/* Permission mode: same click/hover picker as model and effort,
              portalled so compact Overview tiles do not clip it. */}
          </>}
          <PermissionModePicker sessionId={sessionId} />
          <div className="ive-strip-process h-3.5 w-px bg-x-line/45" />

          <button
            onClick={() => setShowProcessing(prev => !prev)}
            title="Show activity details"
            aria-pressed={showProcessing}
            className="ive-strip-process flex items-center gap-1.5 bg-x-bg/40 hover:bg-x-bg/80 border border-x-line/45 hover:border-x-accent/45 rounded-md px-2 py-1 transition-all duration-200 cursor-pointer font-sans text-[11px] text-x-ink-secondary select-none"
          >
            <Activity size={11} className={showProcessing ? 'text-x-accent animate-pulse' : 'text-x-faint'} />
            <span>Details</span>
          </button>

          <div className="h-3.5 w-px bg-x-line/45" />

          <button type="button" className="ive-chat-text-button" aria-expanded={!isTimelineCollapsed} onClick={() => setIsTimelineCollapsed((v) => !v)}><Clock size={13} /> History</button>
          {showChatSettings && <>
          {/* Token usage */}
          <div
            className="flex items-center gap-1"
            title={conversationStats.estimated
              ? 'Estimated token usage from visible conversation text; exact usage appears when the CLI history exposes it.'
              : conversationStats.cachedTokens > 0
                ? `${compactNumber(conversationStats.tokens)} uncached tokens; ${compactNumber(conversationStats.cachedTokens)} cached context tokens.`
                : 'Uncached token usage reported by the CLI history.'}
          >
            <Hash size={11} className="text-x-good" />
            <span className="ive-strip-label text-x-muted font-sans">Total usage:</span>
            <span className="font-semibold text-x-ink">
              {conversationStats.estimated && conversationStats.tokens > 0 ? '~' : ''}{compactNumber(conversationStats.tokens)}
            </span>
            {conversationStats.cachedTokens > 0 && (
              <span className="ive-strip-cache rounded border border-x-good/15 bg-x-good/[0.035] px-1.5 py-0.5 font-mono text-[11px] text-x-good/75">
                +{compactNumber(conversationStats.cachedTokens)} cache
              </span>
            )}
          </div>

          <div className="h-3.5 w-px bg-x-line/45" />

          {/* Turn count */}
          <div className="flex items-center gap-1" title="Number of message turns in the session">
            <Activity size={11} className="text-x-accent" />
            <span className="ive-strip-label text-x-muted font-sans">Turns:</span>
            <span className="font-semibold text-x-ink">
              {conversationStats.turns}
            </span>
          </div>
          </>}
        </div>
      </div>

      {/* Drag & Drop File Upload Overlay */}
      {isDragging && (
        <div className="absolute inset-0 bg-x-bg/95 z-50 flex flex-col items-center justify-center border border-dashed border-x-accent/45 m-4 rounded-2xl animate-in pointer-events-none">
          <UploadCloud size={40} className="text-x-accent animate-bounce mb-2" />
          <span className="text-sm font-medium text-x-ink">Drop images or text files here to attach</span>
          <span className="text-[11px] text-x-muted mt-1 font-sans">Files will be uploaded and previewed above composer</span>
        </div>
      )}

      {/* Image annotator modal */}
      {annotatingImage && (
        <ImageAnnotator
          imageSrc={annotatingImage.url}
          onSave={handleAnnotationSave}
          onClose={() => setAnnotatingImage(null)}
        />
      )}

      {selectedChatText && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={beginTextAnnotation}
          className="fixed z-[70] inline-flex -translate-x-1/2 items-center gap-1.5 rounded-md border border-x-accent/35 bg-x-surface px-2 py-1 text-[11px] font-semibold text-x-accent shadow-x-1 transition-colors duration-[80ms] hover:border-x-accent/60 hover:bg-x-accent/15"
          style={{ left: selectedChatText.x, top: selectedChatText.y }}
        >
          <MessageSquare size={11} />
          Annotate
          <span className="rounded bg-x-accent/12 px-1 py-0.5 text-[11px] uppercase tracking-wide text-x-accent/75">
            {selectedChatText.sourceLabel || selectedChatText.roleLabel || selectedChatText.role || 'unknown'}
          </span>
        </button>
      )}

      {showRecentAnnotations && (
        <div
          ref={recentAnnotationsPanelRef}
          onMouseEnter={clearRecentAnnotationsCloseTimer}
          onMouseLeave={scheduleRecentAnnotationsClose}
          className="fixed right-4 top-14 z-[80] w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-x-line bg-x-surface shadow-x-1 animate-in"
        >
          <div className="flex items-center justify-between gap-3 border-b border-x-line-subtle px-3 py-2">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-x-accent">Annotations</div>
              <div className="truncate text-[11px] text-x-muted">
                Recent workspace context for this composer
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={addAllRecentAnnotationsToComposer}
                disabled={recentAnnotations.length === 0}
                className="rounded-md border border-x-accent/20 bg-x-accent/10 px-2 py-1 text-[11px] font-medium text-x-accent hover:bg-x-accent/18 disabled:opacity-40 transition-colors duration-[80ms]"
                title="Add recent annotations to the current prompt"
              >
                Add all
              </button>
              <button
                type="button"
                onClick={copyRecentAnnotations}
                disabled={recentAnnotations.length === 0}
                className="rounded-md border border-x-line bg-transparent px-2 py-1 text-[11px] font-medium text-x-ink-secondary hover:bg-x-hover disabled:opacity-40 transition-colors duration-[80ms]"
                title="Copy recent annotations"
              >
                Copy
              </button>
              <button
                type="button"
                onClick={() => setShowRecentAnnotations(false)}
                className="rounded-md p-1 text-x-muted hover:bg-x-hover hover:text-x-ink-secondary transition-colors duration-[80ms]"
                title="Close annotations"
              >
                <X size={13} />
              </button>
            </div>
          </div>
          <div className="max-h-[55vh] overflow-y-auto p-2 scrollbar-thin">
            {recentAnnotations.length === 0 ? (
              <div className="px-2 py-8 text-center text-[11px] text-x-faint">
                No recent annotations yet.
              </div>
            ) : (
              <div className="space-y-1.5">
                {recentAnnotations.map((ann) => (
                  <div
                    role="button"
                    tabIndex={0}
                    key={ann.id}
                    onClick={() => addRecentAnnotationToComposer(ann)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        addRecentAnnotationToComposer(ann)
                      }
                    }}
                    className="block w-full rounded-lg border border-x-line bg-x-surface p-2 text-left transition-colors duration-[80ms] hover:border-x-line-strong hover:bg-x-hover"
                    title="Use this annotation in the current prompt"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <div className="min-w-0 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-x-accent/70">
                        <span className="rounded border border-x-accent/15 bg-x-accent/10 px-1.5 py-0.5">
                          {ann.sourceLabel || ann.roleLabel || ann.role || 'unknown'}
                        </span>
                        {ann.sessionName ? <span className="truncate text-x-muted">{ann.sessionName}</span> : null}
                      </div>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          deleteRecentAnnotation(ann.id)
                        }}
                        className="shrink-0 rounded-md border border-x-accent-ink/15 bg-x-accent-ink/[0.045] p-1 text-x-accent-ink/80 hover:border-x-accent-ink/35 hover:bg-x-accent-ink/12 hover:text-x-accent-ink"
                        title="Remove from recent annotations"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                    <div className="line-clamp-3 whitespace-pre-wrap text-[12px] leading-5 text-x-ink/90">
                      {ann.note || compactQuote(ann.quote, 220)}
                    </div>
                    {ann.note ? (
                      <div className="mt-1 line-clamp-2 whitespace-pre-wrap border-l border-x-accent/20 pl-2 text-[11px] leading-4 text-x-muted">
                        {compactQuote(ann.quote, 220)}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
          {recentAnnotations.length > 0 && (
            <div className="flex justify-end border-t border-x-line-subtle px-3 py-2">
              <button
                type="button"
                onClick={clearRecentAnnotations}
                className="text-[11px] text-x-faint hover:text-x-accent-ink transition-colors duration-[80ms]"
              >
                Clear recent
              </button>
            </div>
          )}
        </div>
      )}

      {transcriptIssue && (
        <div role="alert" data-chat-sync-issue className="mx-3 mt-2 flex items-start gap-2 rounded-lg border border-x-line-strong bg-x-surface px-3 py-2 text-xs text-x-ink">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-semibold">Chat history is not syncing</p>
            <p className="mt-1 leading-relaxed">{transcriptIssue}</p>
            {onToggleTerminal && !isTerminalOpen && (
              <button type="button" onClick={onToggleTerminal} className="mt-2 inline-flex items-center gap-1.5 underline underline-offset-2">
                <Terminal size={14} /> Open this session’s terminal
              </button>
            )}
          </div>
        </div>
      )}

      {/* Centered Chat Layout */}
      <div
        ref={scrollContainerRef}
        data-session-scroll={sessionId}
        onScroll={handleScroll}
        onMouseUp={handleTranscriptMouseUp}
        className="flex-1 overflow-y-auto px-3 md:px-4 py-3 scrollbar-thin flex flex-col"
      >

        <div className="ive-conversation-layout w-full mx-auto flex-1 flex flex-row gap-6 relative justify-between">

          {/* Main Messages Area */}
          <div className="flex-1 min-w-0 flex flex-col justify-between">
            {/* Messages Container */}
            <div
              className="flex-1 space-y-1.5 transition-all duration-300 ease-in-out"
              style={{
                paddingBottom: inFlowComposer ? '8px' : `${(composerHeight > 0
                  ? composerHeight + (isTerminalOpen ? 320 : 32)
                  : (isTerminalOpen
                    ? 350
                    : (pendingAnnotation
                      ? 245
                      : (hasComposerFooter ? 170 : 82)))) + 16}px`
              }}
            >
              {showReplyPending && messages.length === 0 ? null : loading && messages.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center py-16 text-x-muted space-y-3 select-none">
                  <Sparkles size={24} className="text-x-accent animate-pulse" />
                  <span className="text-xs">Loading your conversation…</span>
                </div>
              ) : messages.length === 0 && transcriptIssue ? null : messages.length === 0 ? (
                isAgentBusy ? (
                  <div className="flex-1 flex flex-col items-center justify-center py-16 text-center px-4 select-none">
                    <div className="relative mb-4">
                      <div className="relative w-10 h-10 rounded-full border border-x-good/30 bg-x-surface flex items-center justify-center">
                        <Sparkles size={18} className="text-x-good animate-pulse" />
                      </div>
                    </div>
                    <h3 className="text-sm font-semibold text-x-ink tracking-wide">Waiting for the first reply</h3>
                    <p className="text-[11px] text-x-ink-secondary/80 max-w-xs mt-2 leading-relaxed">
                      The assistant is working on your request. Its messages will appear here.
                    </p>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center py-16 text-center px-4 select-none">
                    <div className="relative mb-3">
                      <MessageSquare size={28} className="relative text-x-accent/60" />
                    </div>
                    <h3 className="text-sm font-semibold text-x-ink-secondary">Start the Conversation</h3>
                    <p className="text-[11px] text-x-muted max-w-xs mt-1 leading-relaxed">
                      Describe what you want to change or ask a question. Add relevant files or project notes as context.
                    </p>
                  </div>
                )
              ) : (
                <>
                  <TranscriptBody
                    grouped={transcriptGroups}
                    sessionId={sessionId}
                    activeMessageId={activeMessageId}
                    isAgentBusy={isAgentBusy}
                    showProcessing={showProcessing}
                    renderLimit={renderLimit}
                    olderRows={olderRows}
                    loadingOlder={loadingOlder}
                    onShowEarlier={handleShowEarlier}
                  />
                  {restartInterruptedPrompt && (
                    <div
                      data-testid="chat-restart-interrupted"
                      className="mt-1 flex items-center gap-2 rounded-md border border-x-accent-ink/25 bg-x-accent-ink/[0.06] px-3 py-1.5 font-sans text-[11px] text-x-accent-ink"
                    >
                      <AlertCircle size={12} className="shrink-0" />
                      <span className="flex-1">Interrupted by IVE restart. This prompt got no answer; send it again to continue.</span>
                    </div>
                  )}
                </>
              )}

              <SessionPromptActions sessionId={sessionId} active={sessionDisplayMeta.tone === 'waiting'} disabled={composerUnavailable || !!session?.read_only} onOpenTerminal={onOpenTerminal} />

              {showReplyPending ? (
                <ReplyPending provider={cliType} label={!wsConnected ? 'Reconnecting… Your reply is still pending.' : 'Waiting for a reply…'} />
              ) : chatActivity && !replyWait && (
                <div role="status" className="flex items-center gap-2 text-x-muted text-[11px] pl-1 select-none">
                  <span>{chatActivity.label}</span>
                  {isAgentBusy && workingElapsed && (
                    <span className="rounded border border-x-good/20 bg-x-good/10 px-1.5 py-0.5 text-[11px] font-mono text-x-good">
                      {workingElapsed}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* History stays out of the conversation until requested. */}
          {timelineItems.length > 0 && !isTimelineCollapsed && (
            <div className={'ive-conversation-history w-48 shrink-0 relative'}>
              <div
                className="sticky transition-all duration-300 ease-in-out flex flex-col gap-2 p-3 rounded-xl border border-x-line bg-x-surface"
                style={{
                  top: '16px',
                  maxHeight: (() => {
                    const composerClearance = inGrid ? 0 : composerHeight > 0
                      ? composerHeight + (isTerminalOpen ? 320 : 32)
                      : (isTerminalOpen
                        ? 380
                        : pendingAnnotation
                          ? 275
                          : hasComposerFooter
                            ? 200
                            : 112)
                    const topOffset = 16
                    const safetyMargin = 24
                    if (scrollContainerHeight > 0) {
                      return `${Math.max(120, scrollContainerHeight - composerClearance - topOffset - safetyMargin)}px`
                    }
                    return `calc(100vh - ${composerClearance + topOffset + safetyMargin + 80}px)`
                  })()
                }}
              >
                <div className="text-[11px] font-mono font-bold uppercase tracking-wider text-x-muted mb-2 border-b border-x-line pb-1.5 flex items-center justify-between select-none gap-1 shrink-0">
                  <span>Timeline</span>
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] font-normal lowercase bg-x-hover px-1.5 py-0.5 rounded">{timelineItems.length} events</span>
                    {(
                      <button
                        type="button"
                        onClick={() => setIsTimelineCollapsed(true)}
                        title="Collapse Timeline"
                        className="text-x-muted hover:text-x-ink transition-colors p-0.5 cursor-pointer"
                      >
                        <ChevronRight size={12} />
                      </button>
                    )}
                  </div>
                </div>

                <div className="relative flex flex-col gap-2.5 overflow-y-auto scrollbar-none flex-1 min-h-0">
                  <div className="absolute left-[7px] top-2 bottom-2 w-[1.5px] bg-x-line/25" />
                  {timelineItems.map((item) => {
                    const isUser = item.role === 'user' || item.role === 'human'
                    const isClear = item.type === 'cleared_context'
                    const isActive = activeMessageId === item.id
                    const timeStr = formatMessageTime(item.created_at)
                    const snippet = compactQuote(item.content, 45)

                    const dotColorClass = isUser
                      ? (isActive ? 'bg-x-accent border-x-accent ring-2 ring-x-accent/30' : 'border-x-accent/40 bg-x-bg hover:border-x-accent')
                      : isClear
                        ? (isActive ? 'bg-x-accent-ink border-x-accent-ink ring-2 ring-x-accent-ink/30' : 'border-x-accent-ink/40 bg-x-bg hover:border-x-accent-ink')
                        : (isActive ? 'bg-x-good border-x-good ring-2 ring-x-good/30' : 'border-x-good/40 bg-x-bg hover:border-x-good')

                    const textColorClass = isActive
                      ? 'text-x-ink font-semibold font-sans'
                      : 'text-x-muted hover:text-x-ink-secondary font-sans'

                    const handleDotClick = () => {
                      const el = document.getElementById(`msg-${item.id}`)
                      if (!el) {
                        revealMessage(item.id)
                        return
                      }
                      if (el) {
                        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        setActiveMessageId(item.id)
                        if (item.id === timelineItems[timelineItems.length - 1]?.id) {
                          isPinnedRef.current = true
                        } else {
                          isPinnedRef.current = false
                        }
                      }
                    }

                    return (
                      <button
                        key={item.id}
                        onClick={handleDotClick}
                        className="flex items-start gap-3 w-full text-left group transition-all duration-150 relative py-0.5 cursor-pointer"
                        title={`${isClear ? 'Clear' : isUser ? 'You' : 'Agent'} (${timeStr || ''}):\n${item.content}`}
                      >
                        <div className="relative flex items-center justify-center shrink-0 w-4 h-4 z-10">
                          <div className={`w-2.5 h-2.5 rounded-full border transition-all duration-200 ${dotColorClass}`} />
                          {isActive && (
                            <span className={`absolute w-4 h-4 rounded-full -z-10 animate-ping opacity-25 ${isUser ? 'bg-x-accent' : isClear ? 'bg-x-accent-ink' : 'bg-x-good'}`} style={{ animationDuration: '2s' }} />
                          )}
                        </div>

                        <div className="flex-1 min-w-0 flex flex-col justify-center">
                          <div className="flex items-center justify-between gap-1 text-[11px] font-mono opacity-80 mb-0.5">
                            <span className={isUser ? 'text-x-accent font-bold uppercase' : isClear ? 'text-x-accent-ink font-bold uppercase' : 'text-x-good font-bold uppercase'}>
                              {isClear ? 'Clear' : isUser ? 'You' : 'Agent'}
                            </span>
                            {timeStr && <span className="text-[11px] text-x-muted">{timeStr}</span>}
                          </div>
                          <p className={`text-[11px] truncate leading-tight ${textColorClass}`}>
                            {snippet || (isClear ? 'Cleared context' : isUser ? 'User prompt' : 'Agent response')}
                          </p>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Floating Bottom Composer & Action Bar */}
      <div
        ref={composerRef}
        className={inFlowComposer
          // Overview tile: the composer sits at the bottom in the flow, so
          // the transcript ends above it (nothing scrolls under or below it).
          ? `${phone ? 'ive-chat-composer--phone' : 'ive-chat-composer--tile'} relative shrink-0 px-2 pb-2 pt-1 select-none z-20`
          : 'absolute left-0 right-0 p-4 pointer-events-none select-none transition-all duration-300 ease-in-out z-20'}
        style={inFlowComposer ? undefined : { bottom: isTerminalOpen ? '320px' : '32px' }}
      >
        <div className={`${inFlowComposer ? '' : 'max-w-5xl '}w-full mx-auto flex flex-col gap-2 pointer-events-auto`}>

          {/* Floating Jump to Latest Button */}
          {!isPinnedRef.current && messages.length > 0 && (
            <div className={inFlowComposer
              ? 'absolute left-0 right-0 bottom-full flex justify-center pb-1 pointer-events-none [&>button]:pointer-events-auto'
              : 'flex justify-center mb-1 animate-in pointer-events-auto'}>
              <button
                type="button"
                onClick={() => {
                  isPinnedRef.current = true
                  const container = scrollContainerRef.current
                  container?.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-x-line bg-x-surface text-x-accent hover:text-x-accent-ink text-[13px] font-medium shadow-x-1 hover:bg-x-accent/10 hover:border-x-accent/45 transition-colors duration-[80ms] cursor-pointer"
              >
                <ArrowDown size={12} className="animate-bounce" />
                <span>Jump to Latest</span>
              </button>
            </div>
          )}

          {showSessionRecovery && (
            <div role="alert" data-chat-delivery-issue className="rounded-lg border border-x-line-strong bg-x-surface px-3 py-2 text-xs text-x-ink">
              <p className="flex items-center gap-1.5 font-semibold"><AlertCircle size={14} />{deliveryIssue ? 'Message not sent' : 'Session needs attention'}</p>
              <p className="mt-1 leading-relaxed">
                {deliveryIssue || (sessionDisplayMeta.tone === 'auth'
                  ? 'Sign in to your assistant in Connectors, then restart this session.'
                  : 'The assistant is not ready to accept messages. Restart this session, then send your message again.')}
              </p>
              {deliveryIssue && hasInputText && <p className="mt-1 text-x-muted">Your message is still in the message box below.</p>}
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button type="button" onClick={handleRestartSession} disabled={composerUnavailable || isMessagePending || isAgentBusy} className="underline underline-offset-2 disabled:opacity-40">Restart session</button>
                {hasInputText && sessionStatus !== 'exited' && (
                  <button type="button" onClick={handleSend} disabled={composerUnavailable || composerDisabled} className="underline underline-offset-2 disabled:opacity-40">Send again</button>
                )}
              </div>
            </div>
          )}

          {/* Quick error banner if active */}
          {error && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-x-accent-ink/10 border border-x-accent-ink/30 text-x-accent-ink text-[11px] font-medium shadow-x-1 animate-in">
              <AlertCircle size={12} className="shrink-0" />
              <span className="flex-1">{error}</span>
              <button
                type="button"
                onClick={() => setError(null)}
                className="hover:text-x-ink text-x-muted transition-colors duration-[80ms] shrink-0"
              >
                <X size={10} />
              </button>
            </div>
          )}

          {/* Pasted image preview strip */}
          {pastedImages.length > 0 && (
            <div className="flex items-center gap-2 px-3 py-2 bg-x-surface border border-x-line rounded-xl overflow-x-auto shadow-x-1 animate-in select-none">
              <span className="text-[11px] text-x-muted font-medium uppercase tracking-wider shrink-0 mr-1">Attached:</span>
              {pastedImages.map((img, i) => (
                <div key={i} className="relative group shrink-0">
                  <img
                    src={img.previewUrl || img.url}
                    className="h-10 w-10 rounded-md border border-x-line object-cover cursor-pointer hover:ring-2 hover:ring-x-accent/60 transition-all"
                    title="Click to preview & annotate"
                    onClick={() => setAnnotatingImage({ url: img.previewUrl || img.url, index: i })}
                  />
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removePastedImage(i) }}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-x-hover border border-x-line rounded-full flex items-center justify-center hover:bg-x-accent-ink/20 hover:border-x-accent-ink/30 transition-all shadow-sm"
                  >
                    <X size={8} className="text-x-muted hover:text-x-accent-ink" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <ContextChips context={chatContext} cliType={cliType} />

          {(pendingAnnotation || textAnnotations.length > 0) && (
            <div className="flex flex-col gap-1.5 rounded-xl border border-x-line bg-x-surface px-3 py-2 shadow-x-1 animate-in select-none">
              {pendingAnnotation && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-start gap-2">
                    <MessageSquare size={13} className="mt-0.5 shrink-0 text-x-accent" />
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-x-accent/70">
                        <span>{pendingAnnotation.editingId ? 'Editing annotation' : 'Selected chat text'}</span>
                        <span className="rounded border border-x-line bg-x-surface-2 px-1.5 py-0.5 text-x-accent">
                          {pendingAnnotation.sourceLabel || pendingAnnotation.roleLabel || pendingAnnotation.role || 'unknown'}
                        </span>
                      </div>
                      <div
                        className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md border border-x-line bg-x-surface-2 px-2 py-1.5 font-sans text-[12px] leading-5 text-x-ink/90 scrollbar-thin"
                        title={pendingAnnotation.quote}
                      >
                        {pendingAnnotation.quote}
                      </div>
                      <input
                        ref={annotationInputRef}
                        value={annotationNote}
                        onChange={(e) => setAnnotationNote(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            addPendingAnnotation()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            cancelPendingAnnotation()
                          }
                        }}
                        placeholder="short note for this quote..."
                        className="mt-1.5 w-full bg-transparent font-sans text-[12px] text-x-ink placeholder-x-muted focus:outline-none"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={addPendingAnnotation}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-x-accent/25 bg-x-accent/10 px-2 py-1 text-[11px] font-semibold text-x-accent hover:bg-x-accent/18 transition-colors duration-[80ms]"
                      title="Keep annotation for next prompt"
                    >
                      <Check size={10} />
                      {pendingAnnotation.editingId ? 'Save' : 'Add'}
                    </button>
                    <button
                      type="button"
                      onClick={cancelPendingAnnotation}
                      className="shrink-0 rounded-md p-1 text-x-muted hover:bg-x-hover hover:text-x-ink-secondary transition-colors duration-[80ms]"
                      title={pendingAnnotation.editingId ? 'Close editor' : 'Discard annotation'}
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>
              )}

              {textAnnotations.length > 0 && (
                <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                  <span className="shrink-0 text-[11px] uppercase tracking-wide text-x-faint">Context</span>
                  {textAnnotations.map((ann) => (
                    <div
                      role="button"
                      tabIndex={0}
                      key={ann.id}
                      onClick={() => editTextAnnotation(ann)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          editTextAnnotation(ann)
                        }
                      }}
                      className={`inline-flex min-w-0 max-w-[300px] shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-left font-mono text-[11px] transition-colors ${
                        pendingAnnotation?.editingId === ann.id
                          ? 'border-x-line-strong bg-x-hover text-x-ink'
                          : 'border-x-line bg-x-surface-2 text-x-ink-secondary hover:border-x-line-strong hover:bg-x-hover'
                      }`}
                      title={`${ann.quote}${ann.note ? `\n\n${ann.note}` : ''}`}
                    >
                      <MessageSquare size={10} className="shrink-0 text-x-accent" />
                      <span className="shrink-0 rounded border border-x-line bg-x-surface-2 px-1 py-0.5 text-[11px] uppercase tracking-wide text-x-accent/70">
                        {ann.sourceLabel || ann.roleLabel || ann.role || 'unknown'}
                      </span>
                      <span className="truncate">{ann.note || compactQuote(ann.quote, 88)}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          removeTextAnnotation(ann.id)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                            removeTextAnnotation(ann.id)
                          }
                        }}
                        className="shrink-0 text-x-accent/55 hover:text-x-accent"
                        title="Remove annotation"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {queueEnabled && (
            <ComposerQueue
              sessionId={sessionId}
              agentLabel={agentLabel}
              busy={isAgentBusy || isMessagePending}
              connected={wsConnected}
              offline={sessionStatus === 'exited'}
            />
          )}

          {<CommandQueue items={queuedCommands} onCancel={(id) => cancelQueuedCommand(sessionId, id)} />}

          {/* Autocomplete Dropdown */}
          {showAutocomplete && (autocompleteItems.length > 0 || (autocompleteType === 'at' && contextSearch.status !== 'idle')) && (
            <div role="listbox" aria-label="Mention files, folders or tickets" className="relative mb-1 bg-x-surface border border-x-line rounded-lg shadow-x-1 overflow-hidden max-h-60 overflow-y-auto">
              {autocompleteItems.map((item, idx) => (
                <div
                  key={item.key}
                  role="option"
                  aria-selected={idx === autocompleteIndex}
                  ref={idx === autocompleteIndex ? keepOptionVisible : undefined}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    applyAutocompleteItem(item)
                  }}
                  className={`px-3 py-2 text-xs cursor-pointer flex justify-between items-center transition-colors duration-[80ms] ${
                    idx === autocompleteIndex ? 'bg-x-accent/20 text-x-accent' : 'text-x-muted hover:bg-x-hover hover:text-x-ink-secondary'
                  }`}
                >
                  {item.type === 'context' ? (
                    <ContextMentionRow entry={item.value} />
                  ) : item.type === 'ticket' ? (
                    <div className="flex items-center gap-2 overflow-hidden w-full">
                      <span className="font-mono text-x-accent shrink-0">{item.label}</span>
                      <span className="font-sans text-[11px] truncate flex-1 text-x-ink-secondary font-medium">{item.title}</span>
                      <span className={`shrink-0 font-mono text-[11px] px-1.5 py-0.5 rounded uppercase font-semibold ${
                        item.status === 'in_progress' ? 'bg-x-accent-ink/20 text-x-accent-ink border border-x-accent-ink/30' :
                        item.status === 'completed' || item.status === 'done' ? 'bg-x-good/20 text-x-good border border-x-good/30' :
                        item.status === 'blocked' ? 'bg-x-accent-ink/20 text-x-accent-ink border border-x-accent-ink/30' :
                        'bg-x-hover text-x-muted border border-x-line'
                      }`}>
                        {item.status}
                      </span>
                    </div>
                  ) : (
                    <div className="flex justify-between items-center w-full font-mono text-[11px]">
                      <span className="font-bold text-x-accent">{item.label}</span>
                      <span className="text-x-muted text-[11px]">{item.desc}</span>
                    </div>
                  )}
                </div>
              ))}
              {autocompleteType === 'at' && <ContextSearchStatus search={contextSearch} hasRows={autocompleteItems.length > 0} />}
            </div>
          )}

          <ComposerTokenChips sessionId={sessionId} />

          {canAskAside && <div className="ive-aside-entry">
            <button type="button" onClick={() => openAside()} title="Ask about this task without interrupting it. You can also type /btw followed by a question.">
              <MessageSquare size={13} /> Ask on the side <kbd>/btw</kbd>
            </button>
          </div>}

          {/* Prompt Entry Form (Glassmorphism Pill) */}
          <form onSubmit={handleSend} className="x-composer ive-session-composer flex items-end gap-2 p-1.5 pl-3">
            {/* Hidden File Input */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              multiple
              className="hidden"
            />

            {/* Attachment Button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={composerDisabled}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-x-muted hover:text-x-ink-secondary hover:bg-x-hover transition-all disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
              title="Attach images or text files (or paste / drag & drop). Type @ for project files and folders."
            >
              <Paperclip size={14} />
            </button>

            <ComposerTextarea
              sessionId={sessionId}
              textareaRef={textareaRef}
              handlersRef={composerHandlersRef}
              placeholder={composerPlaceholder}
              disabled={composerDisabled}
            />

            {hasSpeechSupport && (
              <button
                type="button"
                onClick={toggleListening}
                disabled={composerDisabled}
                className={`w-8 h-8 flex items-center justify-center rounded-lg border transition-colors duration-[80ms] shrink-0 ${
                  listening
                    ? 'bg-x-accent/15 border-x-accent/35 text-x-accent'
                    : 'bg-x-surface border-x-line text-x-muted hover:text-x-ink-secondary hover:bg-x-hover'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
                title={listening ? 'Stop dictation' : 'Dictate prompt'}
              >
                {listening ? <MicOff size={14} className="animate-pulse" /> : <Mic size={14} />}
              </button>
            )}

            {isAgentBusy && (
              <button
                type="button"
                onClick={handleCancelOutput}
                className="h-8 px-2.5 rounded-lg border border-x-accent-ink/30 bg-x-accent-ink/15 text-x-accent-ink hover:bg-x-accent-ink/25 hover:border-x-accent-ink/45 transition-all shrink-0 flex items-center justify-center gap-1"
                title={`Cancel output for ${cliType}`}
              >
                <Square size={13} />
                <span className="hidden sm:inline text-[11px] font-semibold">Cancel</span>
              </button>
            )}

            {isAgentBusy && canSendWhileBusy && (
              <button
                type="button"
                onClick={(e) => handleSend(e, { delivery: 'wait_for_ready' })}
                disabled={!hasInputText && pastedImages.length === 0 && !hasComposerAnnotations && chatContext.items.length === 0}
                className="h-8 w-8 rounded-lg border border-x-accent-ink/30 bg-x-accent-ink/15 text-x-accent-ink hover:bg-x-accent-ink/25 hover:border-x-accent-ink/45 disabled:opacity-40 disabled:cursor-not-allowed transition-all shrink-0 flex items-center justify-center"
                title="Send when Antigravity is ready"
              >
                <Clock size={13} />
              </button>
            )}

            {/* Terminal Drawer Trigger */}
            {onToggleTerminal && (
              <button
                type="button"
                onClick={onToggleTerminal}
                className={`w-8 h-8 flex items-center justify-center rounded-lg border transition-all ${
                  isTerminalOpen
                    ? 'bg-x-accent/10 border-x-accent/20 text-x-accent hover:bg-x-accent/20'
                    : 'bg-x-surface border-x-line text-x-muted hover:text-x-ink-secondary hover:bg-x-hover'
                }`}
                title={inGrid ? 'Open this session’s terminal' : 'Toggle PTY Terminal Drawer'}
              >
                <Terminal size={14} />
              </button>
            )}

            {/* Submit Button */}
            <button
              type="submit"
              disabled={(!hasInputText && pastedImages.length === 0 && !hasComposerAnnotations && chatContext.items.length === 0) || composerDisabled || (composerUnavailable && !willQueue)}
              className="w-8 h-8 flex items-center justify-center rounded-lg bg-x-accent hover:bg-x-accent-ink text-x-on-accent disabled:opacity-40 disabled:hover:bg-x-accent transition-colors duration-[80ms] shadow-x-1 shrink-0"
              aria-label={willQueue ? 'Add to queue' : undefined}
              title={willQueue
                ? `Add to queue, sends when ${agentLabel} is done (Enter)`
                : composerUnavailable
                ? (session ? 'Reconnecting to IVE, sending waits until it is back' : 'Loading session')
                : isAgentBusy && canSendWhileBusy ? 'Steer Antigravity now (Enter)' : 'Submit command (Enter)'}
            >
              {willQueue ? <Clock size={14} /> : <Send size={14} />}
            </button>
          </form>

          {liveTerminalSessions.length > 0 && (
            <div className="flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5 select-none scrollbar-thin">
              <span className="shrink-0 font-mono text-[11px] uppercase tracking-wide text-x-faint">Terminals</span>
              {liveTerminalSessions.map((term) => {
                const isActiveTerminal = activeSessionId === term.id
                const statusMeta = getSessionStatusMeta(term.status, term.agentState, hasSessionStarted(term, sessionStarted))
                const working = isSessionWorking(term)
                const waiting = isSessionWaiting(term)
                const elapsed = formatElapsed(working ? workStartedAt[term.id] : ptyStartedAt[term.id], runtimeNow)
                return (
                  <button
                    key={term.id}
                    type="button"
                    onClick={() => openTerminalSession(term.id)}
                    className={`inline-flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] transition-colors ${
                      isActiveTerminal
                        ? 'border-x-accent/35 bg-x-accent/12 text-x-accent'
                        : 'border-x-line/45 bg-x-surface/75 text-x-ink-secondary hover:border-x-accent/25 hover:bg-x-hover'
                    }`}
                    title={`${term.name || term.id} · ${statusMeta.label}${elapsed ? ` · ${elapsed}` : ''}`}
                  >
                    <Terminal size={10} className={isActiveTerminal ? 'text-x-accent' : 'text-x-faint'} />
                    <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${statusMeta.dotClass}`} />
                    <span className="truncate">
                      {term.name || term.id.slice(0, 8)}
                    </span>
                    <span className={`shrink-0 ${working ? 'text-x-good' : waiting ? 'text-x-accent-ink' : 'text-x-faint'}`}>
                      {working ? 'work' : waiting ? 'wait' : statusMeta.label.toLowerCase()}
                    </span>
                    {elapsed && <span className="shrink-0 text-x-faint">{elapsed}</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
