import { useState, useEffect } from 'react'
import { FileText, Shield, X, Save, FolderOpen, ChevronRight } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'

const TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'Agent', 'WebFetch', 'WebSearch', 'Skill', 'NotebookEdit']

export default function ConfigViewer({ onClose }) {
  const session = useStore((s) => s.sessions[s.activeSessionId])
  const activeSessionId = useStore((s) => s.activeSessionId)
  const [tab, setTab] = useState('files') // files | tools
  const [agentsFiles, setAgentsFiles] = useState([])
  const [editingFile, setEditingFile] = useState(null) // { path, content }
  const [toolPerms, setToolPerms] = useState({ allowed: [], disallowed: [] })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (session?.workspace_id) {
      api.getAgentsMd(session.workspace_id).then((data) => {
        setAgentsFiles(data.files || [])
      }).catch(() => {})
    }
    // Parse current tool permissions from session
    if (session) {
      try {
        const allowed = session.allowed_tools ? JSON.parse(session.allowed_tools) : []
        const disallowed = session.disallowed_tools ? JSON.parse(session.disallowed_tools) : []
        setToolPerms({ allowed, disallowed })
      } catch {
        setToolPerms({ allowed: [], disallowed: [] })
      }
    }
  }, [session?.workspace_id, activeSessionId])

  const handleSaveTools = async () => {
    if (!activeSessionId) return
    setSaving(true)
    await api.updateSession(activeSessionId, {
      allowed_tools: JSON.stringify(toolPerms.allowed.filter(Boolean)),
      disallowed_tools: JSON.stringify(toolPerms.disallowed.filter(Boolean)),
    })
    useStore.getState().loadSessions([{
      ...session,
      allowed_tools: JSON.stringify(toolPerms.allowed),
      disallowed_tools: JSON.stringify(toolPerms.disallowed),
    }])
    setSaving(false)
  }

  const toggleTool = (tool, list) => {
    setToolPerms((prev) => {
      const other = list === 'allowed' ? 'disallowed' : 'allowed'
      return {
        [list]: prev[list].includes(tool) ? prev[list].filter((t) => t !== tool) : [...prev[list], tool],
        [other]: prev[other].filter((t) => t !== tool), // remove from other list
      }
    })
  }

  const handleSaveAgentsMd = async () => {
    if (!editingFile || !session?.workspace_id) return
    setSaving(true)
    await api.saveAgentsMd(session.workspace_id, editingFile.content)
    setEditingFile(null)
    // Refresh
    const data = await api.getAgentsMd(session.workspace_id)
    setAgentsFiles(data.files || [])
    setSaving(false)
  }

  const tabClass = (t) => `px-3 py-1.5 text-xs font-medium transition-colors ${
    tab === t ? 'text-text-primary border-b-2 border-accent-primary' : 'text-text-faint hover:text-text-secondary'
  }`

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-black/50" onClick={onClose}>
      <div className="w-[600px] max-h-[70vh] ide-panel overflow-hidden flex flex-col scale-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center border-b border-border-primary px-4">
          <button onClick={() => setTab('files')} className={tabClass('files')}>
            <span className="flex items-center gap-1"><FileText size={11} /> Config Files</span>
          </button>
          <button onClick={() => setTab('tools')} className={tabClass('tools')}>
            <span className="flex items-center gap-1"><Shield size={11} /> Tool Permissions</span>
          </button>
          <div className="flex-1" />
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-bg-hover text-text-faint hover:text-text-secondary transition-colors">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Config Files tab */}
          {tab === 'files' && (
            <div className="p-4 space-y-3">
              <p className="text-xs text-text-faint">
                These AGENTS.md / CLAUDE.md files are automatically loaded when sessions start in this workspace.
                They're injected as system prompt context.
              </p>

              {agentsFiles.length > 0 ? (
                agentsFiles.map((f) => (
                  <div key={f.path} className="border border-border-primary rounded-md overflow-hidden">
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-elevated border-b border-border-secondary">
                      <FolderOpen size={11} className="text-accent-primary" />
                      <span className="text-xs text-text-secondary font-mono flex-1 truncate">{f.relative || f.path}</span>
                      <button
                        onClick={() => setEditingFile({ path: f.path, content: f.content })}
                        className="text-[10px] text-text-faint hover:text-text-secondary"
                      >
                        edit
                      </button>
                    </div>
                    <pre className="text-[11px] text-text-muted font-mono p-3 max-h-32 overflow-y-auto whitespace-pre-wrap leading-relaxed">
                      {f.content.substring(0, 500)}{f.content.length > 500 ? '...' : ''}
                    </pre>
                  </div>
                ))
              ) : (
                <div className="text-center py-6">
                  <p className="text-xs text-text-faint mb-2">No AGENTS.md found in workspace</p>
                  <button
                    onClick={() => setEditingFile({ path: 'new', content: '# AGENTS.md\n\n## Coding Standards\n\n## Architecture\n\n## Testing\n' })}
                    className="text-xs text-accent-primary hover:text-accent-hover"
                  >
                    Create one
                  </button>
                </div>
              )}

              {editingFile && (
                <div className="border border-accent-primary/30 rounded-md overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-accent-subtle border-b border-accent-primary/20">
                    <span className="text-xs text-accent-primary font-mono">Editing AGENTS.md</span>
                    <div className="flex-1" />
                    <button onClick={handleSaveAgentsMd} disabled={saving} className="flex items-center gap-1 text-xs text-accent-primary hover:text-accent-hover">
                      <Save size={10} /> {saving ? 'saving...' : 'save'}
                    </button>
                    <button onClick={() => setEditingFile(null)} className="text-xs text-text-faint hover:text-text-secondary">cancel</button>
                  </div>
                  <textarea
                    value={editingFile.content}
                    onChange={(e) => setEditingFile({ ...editingFile, content: e.target.value })}
                    className="w-full px-3 py-2 text-xs bg-bg-inset text-text-primary font-mono resize-none focus:outline-none leading-relaxed"
                    rows={12}
                  />
                </div>
              )}

              <p className="text-[10px] text-text-faint">
                Restart session for changes to take effect. Files are searched from workspace root upward.
              </p>
            </div>
          )}

          {/* Tool Permissions tab */}
          {tab === 'tools' && (
            <div className="p-4 space-y-3">
              <p className="text-xs text-text-faint">
                Control which tools the agent can use. Green = always allowed (no prompt). Red = always denied.
                Unmarked = uses session's permission mode ({session?.permission_mode || 'auto'}).
              </p>

              <div className="grid grid-cols-2 gap-1.5">
                {TOOLS.map((tool) => {
                  const isAllowed = toolPerms.allowed.includes(tool)
                  const isDenied = toolPerms.disallowed.includes(tool)
                  return (
                    <div key={tool} className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-border-secondary bg-bg-elevated">
                      <span className="text-xs text-text-primary font-mono flex-1">{tool}</span>
                      <button
                        onClick={() => toggleTool(tool, 'allowed')}
                        className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                          isAllowed ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'text-text-faint hover:text-green-400 border border-transparent'
                        }`}
                      >
                        allow
                      </button>
                      <button
                        onClick={() => toggleTool(tool, 'disallowed')}
                        className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                          isDenied ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'text-text-faint hover:text-red-400 border border-transparent'
                        }`}
                      >
                        deny
                      </button>
                    </div>
                  )
                })}
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  onClick={handleSaveTools}
                  disabled={saving}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-accent-primary hover:bg-accent-hover text-white rounded-md transition-colors disabled:opacity-50"
                >
                  <Save size={11} /> {saving ? 'saving...' : 'save permissions'}
                </button>
                <button
                  onClick={() => { setToolPerms({ allowed: [], disallowed: [] }) }}
                  className="px-3 py-1.5 text-xs text-text-faint hover:text-text-secondary"
                >
                  reset to default
                </button>
              </div>

              <p className="text-[10px] text-text-faint">
                Restart session for changes to take effect. Allowed tools skip permission prompts.
                Denied tools are blocked entirely.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
