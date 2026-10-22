import { useState, useEffect } from 'react'
import { FileText, Shield, Save, FolderOpen } from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import { Button, EmptyState } from '../ui'

const TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'Agent', 'WebFetch', 'WebSearch', 'Skill', 'NotebookEdit']

export default function ConfigViewer() {
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

  const tabClass = (t) => `px-3 py-1.5 text-xs font-medium transition-colors border-b-[1.5px] ${
    tab === t ? 'text-x-ink border-x-accent' : 'text-x-muted hover:text-x-ink-secondary border-transparent'
  }`

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex items-center border-b border-x-line px-4">
          <button onClick={() => setTab('files')} className={tabClass('files')}>
            <span className="flex items-center gap-1"><FileText size={11} /> Config Files</span>
          </button>
          <button onClick={() => setTab('tools')} className={tabClass('tools')}>
            <span className="flex items-center gap-1"><Shield size={11} /> Tool Permissions</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Config Files tab */}
          {tab === 'files' && (
            <div className="p-4 space-y-3">
              <p className="text-xs text-x-faint">
                These AGENTS.md / CLAUDE.md files are automatically loaded when sessions start in this workspace.
                They're injected as system prompt context.
              </p>

              {agentsFiles.length > 0 ? (
                agentsFiles.map((f) => (
                  <div key={f.path} className="border border-x-line rounded-md overflow-hidden">
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-x-surface border-b border-x-line-subtle">
                      <FolderOpen size={11} className="text-x-accent" />
                      <span className="text-xs text-x-ink-secondary font-mono flex-1 truncate">{f.relative || f.path}</span>
                      <button
                        onClick={() => setEditingFile({ path: f.path, content: f.content })}
                        className="text-[11px] text-x-faint hover:text-x-ink-secondary"
                      >
                        edit
                      </button>
                    </div>
                    <pre className="text-[11px] text-x-muted font-mono p-3 max-h-32 overflow-y-auto whitespace-pre-wrap leading-relaxed">
                      {f.content.substring(0, 500)}{f.content.length > 500 ? '...' : ''}
                    </pre>
                  </div>
                ))
              ) : (
                <EmptyState
                  icon={FileText}
                  title="No workspace instructions yet"
                  description="AGENTS.md gives every new session the workspace's coding standards, architecture notes, and test commands."
                  align="start"
                  className="rounded-xl border border-dashed border-x-line bg-x-bg/60"
                  action={(
                    <Button
                      variant="primary"
                      icon={FileText}
                      onClick={() => setEditingFile({ path: 'new', content: '# AGENTS.md\n\n## Coding Standards\n\n## Architecture\n\n## Testing\n' })}
                    >
                      Create AGENTS.md
                    </Button>
                  )}
                />
              )}

              {editingFile && (
                <div className="border border-x-line rounded-md overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-x-surface-2 border-b border-x-line">
                    <span className="text-xs text-x-accent font-mono">Editing AGENTS.md</span>
                    <div className="flex-1" />
                    <button onClick={handleSaveAgentsMd} disabled={saving} className="flex items-center gap-1 text-xs text-x-accent hover:text-x-accent-ink">
                      <Save size={10} /> {saving ? 'saving...' : 'save'}
                    </button>
                    <button onClick={() => setEditingFile(null)} className="text-xs text-x-faint hover:text-x-ink-secondary">cancel</button>
                  </div>
                  <textarea
                    value={editingFile.content}
                    onChange={(e) => setEditingFile({ ...editingFile, content: e.target.value })}
                    className="w-full px-3 py-2 text-xs bg-x-surface-2 text-x-ink font-mono resize-none focus:outline-none leading-relaxed"
                    rows={12}
                  />
                </div>
              )}

              <p className="text-[11px] text-x-faint">
                Restart session for changes to take effect. Files are searched from workspace root upward.
              </p>
            </div>
          )}

          {/* Tool Permissions tab */}
          {tab === 'tools' && (
            <div className="p-4 space-y-3">
              <p className="text-xs text-x-faint">
                Control which tools the agent can use. Green = always allowed (no prompt). Red = always denied.
                Unmarked = uses session's permission mode ({session?.permission_mode || 'auto'}).
              </p>

              <div className="grid grid-cols-2 gap-1.5">
                {TOOLS.map((tool) => {
                  const isAllowed = toolPerms.allowed.includes(tool)
                  const isDenied = toolPerms.disallowed.includes(tool)
                  return (
                    <div key={tool} className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-x-line-subtle bg-x-surface">
                      <span className="text-xs text-x-ink font-mono flex-1">{tool}</span>
                      <button
                        onClick={() => toggleTool(tool, 'allowed')}
                        className={`px-1.5 py-0.5 text-[11px] rounded transition-colors ${
                          isAllowed ? 'bg-x-good/20 text-x-good border border-x-good/30' : 'text-x-faint hover:text-x-good border border-transparent'
                        }`}
                      >
                        allow
                      </button>
                      <button
                        onClick={() => toggleTool(tool, 'disallowed')}
                        className={`px-1.5 py-0.5 text-[11px] rounded transition-colors ${
                          isDenied ? 'bg-x-accent-ink/20 text-x-accent-ink border border-x-accent-ink/30' : 'text-x-faint hover:text-x-accent-ink border border-transparent'
                        }`}
                      >
                        deny
                      </button>
                    </div>
                  )
                })}
              </div>

              <div className="flex gap-2 pt-2">
                <Button type="submit"
                  onClick={handleSaveTools}
                  disabled={saving}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-x-accent hover:bg-x-accent-ink text-x-on-accent transition-colors disabled:opacity-50 active:scale-[.98]"
                >
                  <Save size={11} /> {saving ? 'saving...' : 'save permissions'}
                </Button>
                <button
                  onClick={() => { setToolPerms({ allowed: [], disallowed: [] }) }}
                  className="px-3 py-1.5 text-xs text-x-faint hover:text-x-ink-secondary"
                >
                  reset to default
                </button>
              </div>

              <p className="text-[11px] text-x-faint">
                Restart session for changes to take effect. Allowed tools skip permission prompts.
                Denied tools are blocked entirely.
              </p>
            </div>
          )}
        </div>
    </div>
  )
}
