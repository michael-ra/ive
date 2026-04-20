import { useState, useEffect, useRef } from 'react'
import {
  X, Search, Download, Check, ExternalLink, Zap,
  BookOpen, RefreshCw, Trash2,
} from 'lucide-react'
import { api } from '../../lib/api'
import useStore from '../../state/store'
import useListKeyboardNav from '../../hooks/useListKeyboardNav'

function SkillCard({ skill, installed, onInstall, onUninstall, onSelect, busy, idx, isSelected }) {
  return (
    <div
      data-idx={idx}
      onClick={() => onSelect(skill)}
      className={`group p-3 border-b border-border-secondary cursor-pointer transition-colors ${
        isSelected
          ? 'bg-accent-subtle ring-1 ring-inset ring-accent-primary/40'
          : 'hover:bg-bg-hover/50'
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="shrink-0 mt-0.5">
          <Zap size={14} className="text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-text-primary font-mono font-medium truncate">
              {skill.name}
            </span>
            {skill.category && (
              <span className="text-[10px] text-text-faint font-mono px-1 py-0.5 bg-bg-inset rounded">
                {skill.category}
              </span>
            )}
            {skill.license && (
              <span className="text-[10px] text-text-faint font-mono px-1 py-0.5 bg-bg-inset rounded">
                {skill.license}
              </span>
            )}
            {installed && (
              <span className="text-[10px] text-emerald-400 font-medium uppercase">installed</span>
            )}
          </div>
          {skill.description && (
            <p className="text-[11px] text-text-muted font-mono mt-0.5 line-clamp-2 leading-relaxed">
              {skill.description}
            </p>
          )}
          <div className="flex items-center gap-2 mt-1 text-[10px] text-text-faint font-mono">
            {skill.author && <span>by {skill.author}</span>}
            {skill.repo && skill.repo !== 'anthropics/skills' && (
              <span className="px-1 py-0.5 bg-bg-inset rounded">community</span>
            )}
            {skill.compatibility && <span>{skill.compatibility}</span>}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {installed ? (
            <button
              onClick={(e) => { e.stopPropagation(); onUninstall(skill) }}
              disabled={busy}
              className="p-1 text-text-faint hover:text-red-400 transition-colors disabled:opacity-30"
              title="Remove from library"
            >
              <Trash2 size={12} />
            </button>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); onInstall(skill) }}
              disabled={busy}
              className="px-2 py-0.5 text-[10px] font-medium bg-amber-500/80 hover:bg-amber-500 text-white rounded transition-colors disabled:opacity-30"
              title="Install as prompt"
            >
              install
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function SkillDetail({ skill, installed, onInstall, onUninstall, onClose, busy }) {
  const [full, setFull] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.getAgentSkill(skill.path, skill.repo).then((s) => {
      setFull(s)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [skill.path])

  return (
    <div className="overflow-y-auto max-h-full">
      <div className="p-4 border-b border-border-primary">
        <button onClick={onClose} className="text-[10px] text-text-faint hover:text-text-secondary mb-2">← back</button>
        <div className="flex items-start gap-3">
          <Zap size={18} className="text-amber-400 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm text-text-primary font-mono font-medium">{skill.name}</h2>
              {skill.license && (
                <span className="text-[11px] text-text-faint font-mono">{skill.license}</span>
              )}
            </div>
            {skill.description && (
              <p className="text-xs text-text-secondary mt-2 leading-relaxed">{skill.description}</p>
            )}
            {skill.compatibility && (
              <p className="text-[11px] text-text-muted mt-1">{skill.compatibility}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 mt-3">
          {installed ? (
            <button
              onClick={() => onUninstall(skill)}
              disabled={busy}
              className="px-3 py-1.5 text-xs font-medium bg-red-500/80 hover:bg-red-500 text-white rounded-md transition-colors disabled:opacity-50"
            >
              remove
            </button>
          ) : (
            <button
              onClick={() => onInstall(skill)}
              disabled={busy}
              className="px-3 py-1.5 text-xs font-medium bg-amber-500/80 hover:bg-amber-500 text-white rounded-md transition-colors disabled:opacity-50"
            >
              install as prompt
            </button>
          )}
          {skill.source_url && (
            <a
              href={skill.source_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 px-2 py-1.5 text-[11px] text-text-secondary hover:text-text-primary"
            >
              <ExternalLink size={11} /> source
            </a>
          )}
        </div>
      </div>

      {/* Skill content preview */}
      {loading ? (
        <div className="p-6 text-xs text-text-faint">loading skill content…</div>
      ) : full?.content ? (
        <div className="p-4">
          <div className="text-[11px] text-text-secondary font-mono uppercase tracking-wide mb-2">
            Instructions
          </div>
          <pre className="text-[11px] text-text-muted font-mono whitespace-pre-wrap leading-relaxed bg-bg-inset p-3 rounded border border-border-secondary max-h-[40vh] overflow-y-auto">
            {full.content}
          </pre>
        </div>
      ) : null}
    </div>
  )
}

export default function SkillsPanel({ onClose }) {
  const [skills, setSkills] = useState([])
  const [tab, setTab] = useState('browse') // browse | installed
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [visibleCount, setVisibleCount] = useState(50)
  const [selected, setSelected] = useState(null)
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const listRef = useRef(null)
  const prompts = useStore((s) => s.prompts)

  // Installed skill source URLs for matching
  const installedUrls = new Set(
    prompts.filter((p) => p.source_type === 'skill').map((p) => p.source_url)
  )

  const installedPrompts = prompts.filter((p) => p.source_type === 'skill')

  const loadSkills = () => {
    setLoading(true)
    api.getAgentSkills().then((list) => {
      setSkills(list)
      setLoading(false)
    }).catch(() => setLoading(false))
  }

  useEffect(() => { loadSkills() }, [])

  const handleInstall = async (skill) => {
    setBusy(true)
    try {
      // For official skills with a repo, fetch full SKILL.md content
      // For catalog skills, use the description as content
      let name = skill.name
      let content = skill.description || ''
      let sourceUrl = skill.source_url || ''

      if (skill.repo && skill.source !== 'catalog') {
        try {
          const full = await api.getAgentSkill(skill.path, skill.repo)
          if (full) {
            name = full.name || name
            content = full.content || content
            sourceUrl = full.source_url || sourceUrl
          }
        } catch {
          // Fall back to description
        }
      }

      const prompt = await api.installAgentSkill({
        name,
        content,
        source_url: sourceUrl,
        icon: 'zap',
        color: 'text-amber-400',
      })
      useStore.getState().setPrompts([...prompts, prompt])
    } catch (e) {
      console.error('Failed to install skill:', e)
    } finally {
      setBusy(false)
    }
  }

  const handleUninstall = async (skill) => {
    const matched = prompts.find((p) => p.source_url === skill.source_url)
    if (!matched) return
    setBusy(true)
    try {
      await api.deletePrompt(matched.id)
      const next = prompts.filter((p) => p.id !== matched.id)
      useStore.getState().setPrompts(next)
    } catch (e) {
      console.error('Failed to uninstall skill:', e)
    } finally {
      setBusy(false)
    }
  }

  // Reset visible count and selection when query or tab changes
  useEffect(() => { setVisibleCount(50); setSelectedIdx(-1) }, [query, tab])

  const filtered = query
    ? skills.filter((s) =>
        s.name.toLowerCase().includes(query.toLowerCase()) ||
        (s.description || '').toLowerCase().includes(query.toLowerCase()) ||
        (s.category || '').toLowerCase().includes(query.toLowerCase())
      )
    : skills

  const visibleSkills = filtered.slice(0, visibleCount)

  const filteredInstalled = query
    ? installedPrompts.filter((p) =>
        p.name.toLowerCase().includes(query.toLowerCase()) ||
        p.content.toLowerCase().includes(query.toLowerCase())
      )
    : installedPrompts

  const currentList = tab === 'browse' ? visibleSkills : filteredInstalled
  const currentListLength = currentList.length

  useListKeyboardNav({
    enabled: !selected,
    itemCount: currentListLength,
    selectedIdx,
    setSelectedIdx,
    onActivate: (idx) => {
      if (tab === 'browse') {
        const skill = visibleSkills[idx]
        if (skill) setSelected(skill)
      }
    },
    onDelete: (idx) => {
      if (tab === 'installed') {
        const p = filteredInstalled[idx]
        if (p) {
          api.deletePrompt(p.id)
          useStore.getState().setPrompts(prompts.filter((x) => x.id !== p.id))
        }
      }
    },
  })

  useEffect(() => {
    if (selectedIdx < 0) return
    const el = listRef.current?.querySelector(`[data-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] bg-black/50" onClick={onClose}>
      <div
        className="w-[640px] max-h-[80vh] flex flex-col ide-panel overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-primary shrink-0">
          <Zap size={14} className="text-amber-400" />
          <span className="text-xs text-text-secondary font-medium">Agent Skills Library</span>
          <span className="text-[10px] text-text-faint font-mono ml-1">{skills.length > 0 ? `${skills.length.toLocaleString()} skills` : 'loading…'}</span>
          <div className="flex-1" />
          <button
            onClick={loadSkills}
            disabled={loading}
            className="p-1 text-text-faint hover:text-text-secondary transition-colors disabled:opacity-30"
            title="Refresh"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
          <button onClick={onClose} className="p-1 text-text-faint hover:text-text-secondary">
            <X size={14} />
          </button>
        </div>

        {selected ? (
          <SkillDetail
            skill={selected}
            installed={installedUrls.has(selected.source_url)}
            onInstall={handleInstall}
            onUninstall={handleUninstall}
            onClose={() => setSelected(null)}
            busy={busy}
          />
        ) : (
          <>
            {/* Tabs */}
            <div className="flex border-b border-border-secondary shrink-0">
              {[
                { id: 'browse', label: 'Browse', count: skills.length },
                { id: 'installed', label: 'Installed', count: installedPrompts.length },
              ].map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`flex-1 px-4 py-2 text-xs font-mono transition-colors ${
                    tab === t.id
                      ? 'text-text-primary border-b-2 border-amber-400'
                      : 'text-text-faint hover:text-text-secondary'
                  }`}
                >
                  {t.label} ({t.count})
                </button>
              ))}
            </div>

            {/* Search */}
            <div className="px-3 py-2 border-b border-border-secondary shrink-0">
              <div className="flex items-center gap-2 px-2 py-1.5 bg-bg-inset border border-border-primary rounded-md">
                <Search size={11} className="text-text-faint" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx((i) => i < currentListLength - 1 ? i + 1 : i) }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx((i) => i > 0 ? i - 1 : 0) }
                    else if (e.key === 'Enter' && selectedIdx >= 0 && tab === 'browse') {
                      e.preventDefault()
                      const skill = visibleSkills[selectedIdx]
                      if (skill) setSelected(skill)
                    }
                  }}
                  autoFocus
                  placeholder="search skills..."
                  className="flex-1 text-xs bg-transparent text-text-primary placeholder-text-faint focus:outline-none font-mono"
                />
              </div>
            </div>

            {/* List */}
            <div ref={listRef} className="flex-1 overflow-y-auto">
              {loading && skills.length === 0 ? (
                <div className="p-6 text-xs text-text-faint text-center">
                  <RefreshCw size={16} className="animate-spin mx-auto mb-2 text-text-muted" />
                  Fetching skills from GitHub…
                </div>
              ) : tab === 'browse' ? (
                visibleSkills.length > 0 ? (
                  <>
                    {visibleSkills.map((skill, idx) => (
                      <SkillCard
                        key={skill.path + skill.name}
                        skill={skill}
                        installed={installedUrls.has(skill.source_url)}
                        onInstall={handleInstall}
                        onUninstall={handleUninstall}
                        onSelect={setSelected}
                        busy={busy}
                        idx={idx}
                        isSelected={selectedIdx === idx}
                      />
                    ))}
                    {visibleCount < filtered.length && (
                      <button
                        onClick={() => setVisibleCount((c) => c + 50)}
                        className="w-full py-3 text-xs text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors font-mono"
                      >
                        show more ({filtered.length - visibleCount} remaining)
                      </button>
                    )}
                  </>
                ) : (
                  <div className="p-6 text-xs text-text-faint text-center">
                    {query ? 'No matching skills' : 'No skills found'}
                  </div>
                )
              ) : (
                filteredInstalled.length > 0 ? (
                  filteredInstalled.map((p, idx) => (
                    <div
                      key={p.id}
                      data-idx={idx}
                      onClick={() => setSelectedIdx(idx)}
                      className={`group p-3 border-b border-border-secondary transition-colors cursor-pointer ${
                        selectedIdx === idx
                          ? 'bg-accent-subtle ring-1 ring-inset ring-accent-primary/40'
                          : 'hover:bg-bg-hover/50'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Zap size={12} className="text-amber-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="text-xs text-text-primary font-mono">{p.name}</span>
                          <div className="text-[10px] text-text-muted font-mono truncate mt-0.5">
                            {p.content?.substring(0, 80)}
                          </div>
                        </div>
                        {p.is_quickaction ? (
                          <span className="text-[10px] text-amber-400 shrink-0">quick action</span>
                        ) : null}
                        <button
                          onClick={() => {
                            api.deletePrompt(p.id)
                            useStore.getState().setPrompts(prompts.filter((x) => x.id !== p.id))
                          }}
                          className="p-1 text-text-faint hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                          title="Remove"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="p-6 text-xs text-text-faint text-center">
                    {query ? 'No matching installed skills' : 'No skills installed yet — browse and install from the catalog'}
                  </div>
                )
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
