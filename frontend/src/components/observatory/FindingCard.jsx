import { useState } from 'react'
import {
  GripVertical,
  GitBranch,
  Rocket,
  Newspaper,
  Plus,
  ExternalLink,
  Star,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Search,
  Sparkles,
  X as XIcon,
  MessageCircle,
  Hash,
} from 'lucide-react'

const sourceIcons = {
  github: GitBranch,
  producthunt: Rocket,
  hackernews: Newspaper,
  reddit: MessageCircle,
  x: Hash,
}

const sourceLabels = {
  github: 'GitHub',
  producthunt: 'Product Hunt',
  hackernews: 'Hacker News',
  reddit: 'Reddit',
  x: 'X',
}

const sourceColors = {
  github: 'text-x-muted',
  producthunt: 'text-x-accent-ink',
  hackernews: 'text-x-accent-ink',
  reddit: 'text-x-accent-ink',
  x: 'text-x-ink-secondary',
}

function relevanceBadge(score) {
  if (score >= 0.7) return 'bg-x-good/10 text-x-good border-x-good/30'
  if (score >= 0.4) return 'bg-x-accent-ink/10 text-x-accent-ink border-x-accent-ink/30'
  return 'bg-x-accent-ink/10 text-x-accent-ink border-x-accent-ink/30'
}

const categoryStyles = {
  integrate: 'bg-x-accent/10 text-x-accent border-x-accent/30',
  steal: 'bg-x-accent/10 text-x-accent border-x-accent/30',
  competitor: 'bg-x-accent-ink/10 text-x-accent-ink border-x-accent-ink/30',
}

export default function FindingCard({ finding, onPromote, onStatusChange, onDragStart, onResearch, onDeepen }) {
  const [expanded, setExpanded] = useState(false)

  const SourceIcon = sourceIcons[finding.source] || Newspaper
  const score = typeof finding.relevance_score === 'number' ? finding.relevance_score : 0
  const tags = Array.isArray(finding.tags) ? finding.tags : []
  const stealTargets = Array.isArray(finding.steal_targets) ? finding.steal_targets : []
  const metadata = finding.metadata || {}

  return (
    <div
      draggable="true"
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', finding.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart?.(e, finding)
      }}
      className="group relative flex flex-col gap-1.5 p-2.5 bg-x-surface border rounded-lg hover:border-x-line-strong hover:bg-x-hover cursor-pointer transition-colors duration-[80ms] border-x-line"
      onClick={() => setExpanded(!expanded)}
    >
      {/* Drag handle */}
      <GripVertical
        size={10}
        className="absolute top-2 right-2 text-x-faint opacity-0 group-hover:opacity-100 transition-opacity"
      />

      {/* Source icon + title row */}
      <div className="flex items-start gap-1.5 pr-6">
        <SourceIcon
          size={12}
          className={`mt-0.5 shrink-0 ${sourceColors[finding.source] || 'text-x-muted'}`}
        />
        <div className="flex-1 min-w-0">
          {finding.source_url ? (
            <a
              href={finding.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] font-medium text-x-ink-secondary leading-tight line-clamp-2 hover:text-x-accent transition-colors duration-[80ms]"
              onClick={(e) => e.stopPropagation()}
            >
              {finding.title}
              <ExternalLink size={8} className="inline ml-1 opacity-50" />
            </a>
          ) : (
            <span className="text-[11px] font-medium text-x-ink-secondary leading-tight line-clamp-2">
              {finding.title}
            </span>
          )}
        </div>
      </div>

      {/* Badges row: relevance + category + source label */}
      <div className="flex items-center gap-1 flex-wrap">
        <span
          className={`text-[11px] tabular-nums px-1.5 py-0.5 rounded-full border ${relevanceBadge(score)}`}
        >
          {Math.round(score * 100)}%
        </span>
        {finding.category && (
          <span
            className={`text-[11px] px-1.5 py-0.5 rounded-full border ${categoryStyles[finding.category] || categoryStyles.integrate}`}
          >
            {finding.category}
          </span>
        )}
        <span className="text-[11px] text-x-muted">
          {sourceLabels[finding.source] || finding.source}
        </span>
        {/* Stars / votes */}
        {metadata.stars != null && (
          <span className="flex items-center gap-0.5 text-[11px] tabular-nums text-x-muted">
            <Star size={8} className="text-x-accent-ink/70" />
            {metadata.stars.toLocaleString()}
          </span>
        )}
        {metadata.votes != null && (
          <span className="flex items-center gap-0.5 text-[11px] tabular-nums text-x-muted">
            <ArrowUp size={8} className="text-x-accent-ink/70" />
            {metadata.votes}
          </span>
        )}
        {metadata.points != null && (
          <span className="flex items-center gap-0.5 text-[11px] tabular-nums text-x-muted">
            <ArrowUp size={8} className="text-x-accent-ink/70" />
            {metadata.points}
          </span>
        )}
      </div>

      {/* Proposal (truncated) */}
      {finding.proposal && (
        <p className={`text-[11px] text-x-muted leading-snug ${expanded ? '' : 'line-clamp-2'}`}>
          {finding.proposal}
        </p>
      )}

      {/* Steal targets */}
      {finding.category === 'steal' && stealTargets.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {stealTargets.map((target) => (
            <span
              key={target}
              className="px-1.5 py-0.5 text-[11px] text-x-accent bg-x-accent/10 border border-x-accent/20 rounded-md"
            >
              {target}
            </span>
          ))}
        </div>
      )}

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="px-1.5 py-0.5 text-[11px] text-x-muted bg-x-hover rounded-md border border-x-line"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="mt-1 pt-1.5 border-t border-x-line space-y-1.5">
          {finding.notes && (
            <div>
              <span className="text-[11px] font-medium text-x-muted uppercase tracking-wider">Notes</span>
              <p className="text-[11px] text-x-ink-secondary leading-snug mt-0.5">
                {finding.notes}
              </p>
            </div>
          )}
          {metadata.description && (
            <div>
              <span className="text-[11px] font-medium text-x-muted uppercase tracking-wider">Description</span>
              <p className="text-[11px] text-x-ink-secondary leading-snug mt-0.5">
                {metadata.description}
              </p>
            </div>
          )}
          {metadata.language && (
            <span className="text-[11px] text-x-muted">
              Language: {metadata.language}
            </span>
          )}
          {finding.discovered_at && (
            <span className="text-[11px] text-x-muted block">
              Discovered: {new Date(finding.discovered_at).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {/* Footer: expand toggle + action buttons */}
      <div className="flex items-center gap-1 mt-0.5">
        <button
          className="text-x-faint hover:text-x-ink-secondary transition-colors duration-[80ms]"
          onClick={(e) => {
            e.stopPropagation()
            setExpanded(!expanded)
          }}
        >
          {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        </button>
        <div className="flex-1" />
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {onResearch && finding.status !== 'promoted' && (
            <button
              onClick={(e) => { e.stopPropagation(); onResearch(finding) }}
              className="flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] font-medium text-x-accent bg-x-accent/10 border border-x-accent/20 rounded-md hover:bg-x-accent/20 transition-colors duration-[80ms]"
              title="Deep research this finding"
            >
              <Search size={8} />
              Research
            </button>
          )}
          {onDeepen && finding.status !== 'promoted' && (
            <button
              onClick={(e) => { e.stopPropagation(); onDeepen(finding) }}
              className="flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] font-medium text-x-accent bg-x-accent/10 border border-x-accent/20 rounded-md hover:bg-x-accent/20 transition-colors duration-[80ms]"
              title="Inject as steer query into active research, or start a new one"
            >
              <Sparkles size={8} />
              Deepen
            </button>
          )}
          {finding.status !== 'promoted' && (
            <button
              onClick={(e) => { e.stopPropagation(); onPromote?.(finding) }}
              className="flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] font-medium text-x-accent bg-x-accent/10 border border-x-accent/20 rounded-md hover:bg-x-accent/20 transition-colors duration-[80ms]"
              title="Promote to Feature Board"
            >
              <Plus size={8} />
              Promote
            </button>
          )}
          {finding.status !== 'dismissed' && finding.status !== 'promoted' && (
            <button
              onClick={(e) => { e.stopPropagation(); onStatusChange?.(finding, 'dismissed') }}
              className="flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] text-x-muted bg-x-hover border border-x-line rounded-md hover:bg-x-accent-ink/10 hover:text-x-accent-ink hover:border-x-accent-ink/20 transition-colors duration-[80ms]"
              title="Dismiss finding"
            >
              <XIcon size={8} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
