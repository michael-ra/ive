import useStore from '../../state/store'
import { projectWorkspaces } from '../../lib/quickStart'

const FIND_PROJECT = '__find-project'

/**
 * Where a new session runs: one of the connected projects or "No project"
 * (the quick start folder, the agent finds the project itself). Shared by
 * the quick start prompt and the Home composer so both read the same.
 * value: workspace id or null. onChange(id | null).
 */
export default function ProjectTargetSelect({ value, onChange, onFindProject, className = '', id, label = 'Project' }) {
  const workspaces = useStore((s) => s.workspaces)
  const quickStart = useStore((s) => s.quickStart)
  const projects = projectWorkspaces(workspaces, quickStart)
  const current = value && projects.some((ws) => ws.id === value) ? value : ''
  return (
    <select
      id={id}
      data-project-target
      aria-label={label}
      title={label}
      value={current}
      onChange={(e) => {
        if (e.target.value === FIND_PROJECT) { onFindProject?.(); return }
        onChange?.(e.target.value || null)
      }}
      className={className}
    >
      {projects.map((ws) => (
        <option key={ws.id} value={ws.id}>{ws.name || String(ws.path || '').split('/').pop() || ws.id}</option>
      ))}
      <option value="">No project (start folder)</option>
      {onFindProject && <option value={FIND_PROJECT}>Find another project…</option>}
    </select>
  )
}
