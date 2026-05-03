// Single source of truth for the Feature Board's columns.
// Used by FeatureBoard for layout + by WorkspaceSettingsPanel to populate
// the per-workspace "default destination" dropdowns.
export const COLUMNS = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'todo', label: 'To Do' },
  { key: 'planning', label: 'Planning', color: 'text-amber-400' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'review', label: 'Review' },
  { key: 'testing', label: 'Testing' },
  { key: 'documenting', label: 'Docs' },
  { key: 'done', label: 'Done' },
]

export const columnAccent = {
  backlog: 'text-zinc-500',
  todo: 'text-zinc-400',
  planning: 'text-orange-400',
  in_progress: 'text-indigo-400',
  review: 'text-amber-400',
  testing: 'text-cyan-400',
  documenting: 'text-purple-400',
  done: 'text-green-400',
}
