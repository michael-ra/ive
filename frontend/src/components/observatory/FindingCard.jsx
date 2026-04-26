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
  X as XIcon,
} from 'lucide-react'

const sourceIcons = {
  github: GitBranch,
  producthunt: Rocket,
  hackernews: Newspaper,
}

const sourceLabels = {
  github: 'GitHub',
  producthunt: 'Product Hunt',
  hackernews: 'Hacker News',
}

const sourceColors = {
  github: 'text-zinc-400',
  producthunt: 'text-orange-400',
  hackernews: 'text-amber-400',
}

function relevanceBadge(score) {
  if (score >= 0.7) return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
  if (score >= 0.4) return 'bg-amber-500/15 text-amber-400 border-amber-500/30'
  return 'bg-red-500/15 text-red-400 border-red-500/30'
}

const categoryStyles = {
  integrate: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
  steal: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
}

export default function FindingCard({ finding, onPromote, onStatusChange, onDragStart, onResearch }) {
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
      className="group relative flex flex-col gap-1.5 p-2.5 bg-[#111118]/80 border rounded-md hover:border-zinc-700 hover:bg-[#111118] cursor-pointer transition-all border-zinc-800"
      onClick={() => setExpanded(!expanded)}
    >
      {/* Drag handle */}
      <GripVertical
        size={10}
        className="absolute top-2 right-2 text-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity"
      />

      {/* Source icon + title row */}
      <div className="flex items-start gap-1.5 pr-6">
        <SourceIcon
          size={12}
          className={`mt-0.5 shrink-0 ${sourceColors[finding.source] || 'text-zinc-500'}`}
        />
        <div className="flex-1 min-w-0">
          {finding.source_url ? (
            <a
              href={finding.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] font-mono text-zinc-300 leading-tight line-clamp-2 hover:text-indigo-300 transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              {finding.title}
              <ExternalLink size={8} className="inline ml-1 opacity-50" />
            </a>
          ) : (
            <span className="text-[11px] font-mono text-zinc-300 leading-tight line-clamp-2">
              {finding.title}
            </span>
          )}
        </div>
      </div>

      {/* Badges row: relevance + category + source label */}
      <div className="flex items-center gap-1 flex-wrap">
        <span
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full border ${relevanceBadge(score)}`}
        >
          {Math.round(score * 100)}%
        </span>
        {finding.category && (
          <span
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full border ${categoryStyles[finding.category] || categoryStyles.integrate}`}
          >
            {finding.category}
          </span>
        )}
        <span className="text-[10px] font-mono text-zinc-600">
          {sourceLabels[finding.source] || finding.source}
        </span>
        {/* Stars / votes */}
        {metadata.stars != null && (
          <span className="flex items-center gap-0.5 text-[10px] font-mono text-zinc-500">
            <Star size={8} className="text-amber-500/70" />
            {metadata.stars.toLocaleString()}
          </span>
        )}
        {metadata.votes != null && (
          <span className="flex items-center gap-0.5 text-[10px] font-mono text-zinc-500">
            <ArrowUp size={8} className="text-orange-400/70" />
            {metadata.votes}
          </span>
        )}
        {metadata.points != null && (
          <span className="flex items-center gap-0.5 text-[10px] font-mono text-zinc-500">
            <ArrowUp size={8} className="text-amber-400/70" />
            {metadata.points}
          </span>
        )}
      </div>

      {/* Proposal (truncated) */}
      {finding.proposal && (
        <p className={`text-[11px] font-mono text-zinc-500 leading-snug ${expanded ? '' : 'line-clamp-2'}`}>
          {finding.proposal}
        </p>
      )}

      {/* Steal targets */}
      {finding.category === 'steal' && stealTargets.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {stealTargets.map((target) => (
            <span
              key={target}
              className="px-1.5 py-0.5 text-[10px] font-mono text-purple-300 bg-purple-500/10 border border-purple-500/20 rounded"
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
              className="px-1.5 py-0.5 text-[10px] font-mono text-zinc-500 bg-zinc-800/80 rounded border border-zinc-700/50"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="mt-1 pt-1.5 border-t border-zinc-800/50 space-y-1.5">
          {finding.notes && (
            <div>
              <span className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider">Notes</span>
              <p className="text-[11px] font-mono text-zinc-400 leading-snug mt-0.5">
                {finding.notes}
              </p>
            </div>
          )}
          {metadata.description && (
            <div>
              <span className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider">Description</span>
              <p className="text-[11px] font-mono text-zinc-400 leading-snug mt-0.5">
                {metadata.description}
              </p>
            </div>
          )}
          {metadata.language && (
            <span className="text-[10px] font-mono text-zinc-600">
              Language: {metadata.language}
            </span>
          )}
          {finding.discovered_at && (
            <span className="text-[10px] font-mono text-zinc-700 block">
              Discovered: {new Date(finding.discovered_at).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {/* Footer: expand toggle + action buttons */}
      <div className="flex items-center gap-1 mt-0.5">
        <button
          className="text-zinc-700 hover:text-zinc-500 transition-colors"
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
              className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 rounded hover:bg-cyan-500/20 transition-colors"
              title="Deep research this finding"
            >
              <Search size={8} />
              Research
            </button>
          )}
          {finding.status !== 'promoted' && (
            <button
              onClick={(e) => { e.stopPropagation(); onPromote?.(finding) }}
              className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 rounded hover:bg-indigo-500/20 transition-colors"
              title="Promote to Feature Board"
            >
              <Plus size={8} />
              Promote
            </button>
          )}
          {finding.status !== 'dismissed' && finding.status !== 'promoted' && (
            <button
              onClick={(e) => { e.stopPropagation(); onStatusChange?.(finding, 'dismissed') }}
              className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono text-zinc-500 bg-zinc-500/10 border border-zinc-500/20 rounded hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/20 transition-colors"
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
