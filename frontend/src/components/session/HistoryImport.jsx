import { useState, useEffect } from 'react'
import { History, FolderOpen, Download, X, ChevronDown, ChevronRight } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import { Button } from '../ui'

export default function HistoryImport({ onClose }) {
  const [projects, setProjects] = useState([])
  const [expanded, setExpanded] = useState({})
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(null)
  const workspaces = useStore((s) => s.workspaces)

  useEffect(() => {
    api.getHistoryProjects().then((p) => {
      setProjects(p)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const handleImport = async (project, session) => {
    // Find matching workspace or use first
    const ws = workspaces.find((w) => project.project_path.startsWith(w.path))
      || workspaces[0]
    if (!ws) {
      alert('Add a workspace first')
      return
    }

    setImporting(session.session_id)
    try {
      const imported = await api.importHistory({
        file: session.file,
        workspace_id: ws.id,
        name: `Import ${session.session_id.slice(0, 8)}`,
      })
      useStore.getState().loadSessions([imported])
      setImporting(null)
    } catch (e) {
      console.error('Import failed:', e)
      setImporting(null)
    }
  }

  const formatDate = (ts) => {
    if (!ts) return ''
    return new Date(ts * 1000).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }

  const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-x-scrim backdrop-blur-[4px]" onClick={onClose}>
      <div
        className="w-[600px] x-panel overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-x-line">
          <History size={14} className="text-x-accent" />
          <span className="text-xs text-x-ink font-medium">Import CLI Sessions</span>
          <span className="text-[11px] text-x-faint">Native history</span>
          <div className="flex-1" />
          <Button type="submit" onClick={onClose} className="p-1 hover:bg-x-hover text-x-faint hover:text-x-ink-secondary transition-colors">
            <X size={15} />
          </Button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {loading && (
            <div className="px-4 py-10 text-xs text-x-faint text-center">scanning...</div>
          )}

          {!loading && projects.length === 0 && (
            <div className="px-4 py-10 text-xs text-x-faint text-center">
              No native CLI sessions found.
            </div>
          )}

          {projects.map((project) => (
            <div key={project.dir_name} className="border-b border-x-line-subtle">
              <button
                onClick={() => setExpanded((p) => ({ ...p, [project.dir_name]: !p[project.dir_name] }))}
                className="w-full flex items-center gap-1.5 px-4 py-2.5 text-left hover:bg-x-hover/50 transition-colors"
              >
                {expanded[project.dir_name]
                  ? <ChevronDown size={12} className="text-x-faint" />
                  : <ChevronRight size={12} className="text-x-faint" />
                }
                <FolderOpen size={12} className="text-x-accent" />
                <span className="text-xs text-x-ink font-mono truncate flex-1">
                  {project.project_path}
                </span>
                {project.cli_type && project.cli_type !== 'claude' && (
                  <span className="text-[11px] font-medium bg-x-tint text-x-accent px-1.5 py-0.5 rounded-md border border-x-accent/30">
                    {project.cli_type}
                  </span>
                )}
                <span className="text-[11px] text-x-faint">
                  {project.session_count} session{project.session_count !== 1 ? 's' : ''}
                </span>
              </button>

              {expanded[project.dir_name] && (
                <div className="pl-8 pr-4 pb-2 space-y-0.5">
                  {project.sessions.map((session) => (
                    <div
                      key={session.session_id}
                      className="flex items-center gap-2 py-1.5 text-xs font-mono"
                    >
                      <span className="text-x-ink-secondary truncate flex-1">{session.session_id}</span>
                      <span className="text-x-faint text-[11px]">{formatSize(session.size_bytes)}</span>
                      <span className="text-x-faint text-[11px]">{formatDate(session.modified)}</span>
                      <Button type="submit"
                        onClick={() => handleImport(project, session)}
                        disabled={importing === session.session_id}
                        className="flex items-center gap-1 px-2 py-1 font-sans text-xs font-medium bg-x-accent-subtle hover:bg-x-accent/20 text-x-accent transition-colors disabled:opacity-50"
                      >
                        <Download size={11} />
                        {importing === session.session_id ? 'importing...' : 'import'}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
