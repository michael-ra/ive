import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Send, Filter, Tag, FileText, AlertTriangle, Info, Clock } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'

const PRIORITIES = ['info', 'heads_up', 'blocking']

const PRIORITY_STYLES = {
  info: 'bg-bg-tertiary text-text-muted',
  heads_up: 'bg-yellow-500/20 text-yellow-400',
  blocking: 'bg-red-500/20 text-red-400',
}

const PRIORITY_LABELS = {
  info: 'info',
  heads_up: 'heads up',
  blocking: 'blocking',
}

function timeAgo(ts) {
  const now = Date.now()
  const d = new Date(ts)
  const diff = now - d.getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return d.toLocaleDateString()
}

export default function PeerMessagesPanel({ onClose }) {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const sessions = useStore((s) => s.sessions)

  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)

  // Filters
  const [filterPriority, setFilterPriority] = useState('all')
  const [filterTopic, setFilterTopic] = useState('')

  // Compose form
  const [content, setContent] = useState('')
  const [topic, setTopic] = useState('')
  const [priority, setPriority] = useState('info')
  const [fileInput, setFileInput] = useState('')
  const [files, setFiles] = useState([])
  const [sending, setSending] = useState(false)

  const contentRef = useRef(null)

  // Build a session name lookup
  const sessionNameMap = {}
  for (const [id, s] of Object.entries(sessions)) {
    sessionNameMap[id] = s.name || id.slice(0, 8)
  }

  const fetchMessages = useCallback(async () => {
    if (!activeWorkspaceId) return
    try {
      const params = {}
      if (filterPriority !== 'all') params.priority = filterPriority
      if (filterTopic.trim()) params.topic = filterTopic.trim()
      const data = await api.getPeerMessages(activeWorkspaceId, params)
      const list = Array.isArray(data) ? data : (data.messages || [])
      // Newest first
      list.sort((a, b) => new Date(b.created_at || b.timestamp) - new Date(a.created_at || a.timestamp))
      setMessages(list)
    } catch (e) {
      console.error('Failed to fetch peer messages:', e)
    } finally {
      setLoading(false)
    }
  }, [activeWorkspaceId, filterPriority, filterTopic])

  // Initial load + auto-refresh every 10s
  useEffect(() => {
    fetchMessages()
    const interval = setInterval(fetchMessages, 10000)
    return () => clearInterval(interval)
  }, [fetchMessages])

  const handleAddFile = (e) => {
    if (e.key === 'Enter' && fileInput.trim()) {
      e.preventDefault()
      if (!files.includes(fileInput.trim())) {
        setFiles([...files, fileInput.trim()])
      }
      setFileInput('')
    }
  }

  const handleRemoveFile = (f) => {
    setFiles(files.filter((x) => x !== f))
  }

  const handleSend = async (e) => {
    e.preventDefault()
    if (!content.trim() || !activeWorkspaceId) return
    setSending(true)
    try {
      await api.postPeerMessage(activeWorkspaceId, {
        content: content.trim(),
        topic: topic.trim() || undefined,
        priority,
        files: files.length > 0 ? files : undefined,
      })
      setContent('')
      setTopic('')
      setPriority('info')
      setFiles([])
      setFileInput('')
      await fetchMessages()
    } catch (e) {
      console.error('Failed to post peer message:', e)
    } finally {
      setSending(false)
    }
  }

  // Collect unique topics for filter dropdown
  const allTopics = [...new Set(messages.map((m) => m.topic).filter(Boolean))]

  const filtered = messages

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-bg-primary border border-border-primary rounded-lg shadow-xl w-[600px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-primary">
          <h2 className="text-sm font-semibold text-text-primary">Peer Messages</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">
            <X size={16} />
          </button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border-primary">
          <Filter size={12} className="text-text-faint shrink-0" />
          <select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value)}
            className="text-[11px] font-mono bg-bg-inset border border-border-primary rounded px-1.5 py-0.5 text-text-secondary focus:outline-none"
          >
            <option value="all">all priorities</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
            ))}
          </select>
          {allTopics.length > 0 && (
            <select
              value={filterTopic}
              onChange={(e) => setFilterTopic(e.target.value)}
              className="text-[11px] font-mono bg-bg-inset border border-border-primary rounded px-1.5 py-0.5 text-text-secondary focus:outline-none"
            >
              <option value="">all topics</option>
              {allTopics.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          )}
          <span className="ml-auto text-[10px] text-text-faint font-mono">
            {filtered.length} message{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Message list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading ? (
            <div className="text-[11px] text-text-faint text-center py-8 font-mono">loading...</div>
          ) : filtered.length === 0 ? (
            <div className="text-[11px] text-text-faint text-center py-8 font-mono">
              no peer messages yet
            </div>
          ) : (
            filtered.map((msg) => (
              <div
                key={msg.id}
                className="border border-border-secondary rounded-md p-3 bg-bg-secondary/50 space-y-1.5"
              >
                {/* Top row: from + priority + timestamp */}
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono text-accent-primary truncate max-w-[180px]">
                    {sessionNameMap[msg.from_session_id] || (msg.from_session_id ? msg.from_session_id.slice(0, 8) : 'unknown')}
                  </span>
                  {msg.topic && (
                    <span className="flex items-center gap-0.5 text-[10px] font-mono text-text-muted bg-bg-tertiary px-1.5 py-0.5 rounded">
                      <Tag size={9} />
                      {msg.topic}
                    </span>
                  )}
                  <span
                    className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${PRIORITY_STYLES[msg.priority] || PRIORITY_STYLES.info}`}
                  >
                    {PRIORITY_LABELS[msg.priority] || msg.priority || 'info'}
                  </span>
                  <span className="ml-auto text-[10px] text-text-faint font-mono flex items-center gap-1">
                    <Clock size={9} />
                    {timeAgo(msg.created_at || msg.timestamp)}
                  </span>
                </div>

                {/* Content */}
                <p className="text-[11px] text-text-primary font-mono whitespace-pre-wrap leading-relaxed">
                  {msg.content}
                </p>

                {/* Files */}
                {msg.files && msg.files.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {(Array.isArray(msg.files) ? msg.files : []).map((f, i) => (
                      <span
                        key={i}
                        className="flex items-center gap-1 text-[10px] font-mono text-text-muted bg-bg-tertiary px-1.5 py-0.5 rounded"
                      >
                        <FileText size={9} />
                        {f}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Compose form */}
        <div className="border-t border-border-primary p-3 space-y-2">
          <form onSubmit={handleSend} className="space-y-2">
            <textarea
              ref={contentRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="write a message to peers..."
              rows={3}
              className="w-full px-2.5 py-1.5 text-[11px] font-mono bg-bg-inset border border-border-primary rounded-md text-text-primary placeholder-text-faint focus:outline-none focus:border-accent-primary resize-none leading-relaxed"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  handleSend(e)
                }
              }}
            />
            <div className="flex items-center gap-2">
              <input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="topic"
                className="flex-1 px-2 py-1 text-[11px] font-mono bg-bg-inset border border-border-primary rounded text-text-primary placeholder-text-faint focus:outline-none focus:border-accent-primary"
              />
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="text-[11px] font-mono bg-bg-inset border border-border-primary rounded px-1.5 py-1 text-text-secondary focus:outline-none"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
                ))}
              </select>
              <button
                type="submit"
                disabled={!content.trim() || sending}
                className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-mono font-medium bg-accent-primary hover:bg-accent-hover text-white rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Send size={10} />
                send
              </button>
            </div>

            {/* Files tags */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {files.map((f) => (
                <span
                  key={f}
                  className="flex items-center gap-1 text-[10px] font-mono text-text-muted bg-bg-tertiary px-1.5 py-0.5 rounded group cursor-pointer"
                  onClick={() => handleRemoveFile(f)}
                >
                  <FileText size={9} />
                  {f}
                  <X size={8} className="opacity-0 group-hover:opacity-100 text-text-faint" />
                </span>
              ))}
              <input
                value={fileInput}
                onChange={(e) => setFileInput(e.target.value)}
                onKeyDown={handleAddFile}
                placeholder={files.length > 0 ? 'add file...' : 'files (enter to add)'}
                className="flex-1 min-w-[120px] px-1.5 py-0.5 text-[10px] font-mono bg-transparent border-none text-text-muted placeholder-text-faint focus:outline-none"
              />
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
