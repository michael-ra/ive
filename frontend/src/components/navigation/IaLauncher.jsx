import { ArrowUpRight, LayoutGrid } from 'lucide-react'
import { ACTIONS } from '../../lib/commandActions'
import { Modal } from '../ui'

const COMMAND_ACTION_BY_ID = new Map(ACTIONS.map((action) => [action.id, action]))

export function IaSurfaceGrid({ group, workspaces, onSelect, mode = 'home' }) {
  const isLauncher = mode === 'launcher'
  const headingId = isLauncher ? `ia-launcher-group-${group.id}` : `ia-group-${group.id}`

  return (
    <section
      className={isLauncher ? 'flex-1 min-h-0 overflow-y-auto p-5' : 'mb-10'}
      data-ia-main-group={group.id}
      data-ia-launcher={isLauncher ? '' : undefined}
      aria-labelledby={headingId}
    >
      <div className="mb-3">
        <div>
          <h2 id={headingId} className="flex items-center gap-2 text-lg font-semibold text-x-ink">
            {group.label} <span className="rounded-full border border-x-line px-2 py-0.5 font-mono text-[11px] font-normal text-x-muted">{group.surfaces.length}</span>
          </h2>
          <p data-ia-group-description className="mt-1 text-sm text-x-muted">
            {group.description}
          </p>
        </div>
      </div>

      {workspaces.length === 0 && isLauncher && (
        <div className="mb-4 rounded-[10px] border border-x-line bg-x-surface px-4 py-3 shadow-x-1" data-ia-empty-state={group.id}>
          <div className="text-xs font-semibold text-x-ink">{group.emptyTitle}</div>
          <div className="mt-1 text-[11px] leading-relaxed text-x-muted">{group.emptyDescription}</div>
          <button
            type="button"
            onClick={() => onSelect('add-workspace')}
            className="mt-3 rounded-md bg-x-accent px-3 py-1.5 text-[11px] font-semibold text-x-on-accent hover:bg-x-accent-ink transition-colors"
          >
            Add your first workspace
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {group.surfaces.map((surface) => {
          const Icon = COMMAND_ACTION_BY_ID.get(surface.id).icon
          const unavailable = workspaces.length === 0 && [
            'sessions', 'new-session', 'workspace-review-graph',
          ].includes(surface.id)
          return (
            <button
              key={surface.id}
              type="button"
              data-ia-surface={surface.id}
              onClick={() => onSelect(surface.id)}
              disabled={unavailable}
              className="suggestion-card min-h-[104px] text-left group/card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-x-accent-ink disabled:cursor-not-allowed disabled:opacity-45"
              title={unavailable
                ? 'Add a workspace first'
                : (surface.title || `${surface.label} — ${surface.description}`)}
            >
              <div className="flex h-full w-full items-start gap-3">
                <span className="shrink-0 rounded-lg bg-x-surface-2 p-2 text-x-ink-secondary transition-colors group-hover/card:bg-x-tint group-hover/card:text-x-accent-ink">
                  <Icon size={17} />
                </span>
                <div className="min-w-0 flex-1 pt-0.5">
                  <h3 className="mb-1 flex items-start justify-between gap-2 text-sm font-semibold text-x-ink">
                    {surface.label}
                    <ArrowUpRight size={13} aria-hidden="true" className="mt-1 shrink-0 text-x-muted" />
                  </h3>
                  <p className="text-xs leading-relaxed text-x-muted">{surface.description}</p>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </section>
  )
}

export default function IaLauncher({ group, workspaces, onSelect, onClose }) {
  return (
    <Modal
      onClose={onClose}
      icon={LayoutGrid}
      title="Navigation launcher"
      subtitle="Choose a surface without leaving your session"
      size="lg"
      className="overflow-hidden"
      bodyClassName="overflow-hidden"
    >
      <IaSurfaceGrid
        group={group}
        workspaces={workspaces}
        onSelect={onSelect}
        mode="launcher"
      />
    </Modal>
  )
}
