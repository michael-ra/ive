import { useEffect, useRef, useState } from 'react'
import { ArrowRight, FolderOpen, Loader2, Search } from 'lucide-react'
import { api } from '../../lib/api'
import { Button, Modal } from '../ui'

export default function WorkspacePicker({ initialQuery = '', onSelect, onClose, forContext = false, title, subtitle }) {
  const [query, setQuery] = useState(initialQuery)
  const [result, setResult] = useState(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [manualPath, setManualPath] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => {
    const controller = new AbortController()
    setResult(null)
    setSearchError('')
    if (query.trim().length < 2) { setSearching(false); return }
    setSearching(true)
    const timer = setTimeout(() => {
      api.searchProjects(query.trim(), controller.signal)
        .then((data) => {
          if (controller.signal.aborted) return
          if (!Array.isArray(data?.matches)) throw new Error('Project search is unavailable. Try choosing a folder.')
          setResult(data)
        })
        .catch((error) => {
          if (!controller.signal.aborted) setSearchError(error.message || 'Could not search for projects.')
        })
        .finally(() => { if (!controller.signal.aborted) setSearching(false) })
    }, 350)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query])

  const select = async (project) => {
    if (busy) return
    setBusy(true)
    setActionError('')
    try { await onSelect(project) }
    catch (error) { setActionError(error.message || 'Could not connect this project.') }
    finally { setBusy(false) }
  }

  const browse = async () => {
    if (busy) return
    setBusy(true)
    setActionError('')
    try {
      const { path } = await api.browseFolder()
      if (path) await onSelect({ path })
    } catch (error) {
      if (error.message !== 'cancelled') setActionError(error.message || 'Could not open the folder picker.')
    } finally { setBusy(false) }
  }

  return (
    <Modal
      title={title || (forContext ? 'Add project context' : 'Find your project')}
      subtitle={subtitle || (forContext ? 'Include a project overview in your side conversation.' : 'Describe what you want to work on. IVE finds the folder.')}
      icon={FolderOpen}
      size="md"
      className="ive-project-picker"
      onClose={busy ? undefined : onClose}
      bodyClassName="overflow-y-auto"
    >
      <div className="p-5 sm:p-6">
        <label htmlFor="project-search" className="mb-2 block text-sm font-semibold text-x-ink">What would you like to work on?</label>
        <div className="relative">
          <Search size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-x-muted" />
          <input
            id="project-search"
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={240}
            placeholder="e.g. I want to work on IVE"
            className="w-full min-h-12 rounded-lg border border-x-line-strong bg-x-bg py-3 pl-11 pr-4 text-sm text-x-ink outline-none"
            autoComplete="off"
          />
        </div>
        <p className="mt-2 text-xs leading-relaxed text-x-muted">Use a project name or a short description, in English or German.</p>
        <p className="mt-2 text-xs leading-relaxed text-x-muted">{forContext ? 'Includes top-level folder names and short README excerpts. Add more projects from Side chat to discuss them together.' : 'A project folder is a starting point. You can connect other projects too; session permissions control access outside the folder.'}</p>

        <div className="mt-5 min-h-40" aria-live="polite" aria-busy={searching}>
          {searching && <p className="flex items-center gap-2 py-6 text-sm text-x-muted"><Loader2 size={16} className="animate-spin" /> Looking for matching projects…</p>}
          {searchError && <p role="alert" className="rounded-lg border border-x-tint-line bg-x-tint p-4 text-sm text-x-accent-ink">{searchError}</p>}
          {!searching && !searchError && !result && <div className="rounded-xl border border-dashed border-x-line-strong p-6 text-sm leading-relaxed text-x-muted">Name the app, website, or project you want to edit. IVE searches project folders and their descriptions on this computer.</div>}
          {!searching && result && result.matches.length === 0 && <div className="rounded-xl border border-dashed border-x-line-strong p-5 text-sm text-x-muted">{result.needs_project_name ? 'Include a project name or topic so IVE knows what to look for.' : 'No matching project found. Try a more specific name, or choose a folder below.'}</div>}
          {!searching && result?.matches.length > 0 && <div className="space-y-2">
            <p className="mb-3 text-xs font-semibold text-x-muted">{result.matches.length} matching {result.matches.length === 1 ? 'project' : 'projects'} · choose one to continue</p>
            {result.matches.map((project) => <button
              key={project.path}
              type="button"
              disabled={busy}
              onClick={() => select(project)}
              className="flex w-full items-center gap-3 rounded-xl border border-x-line bg-x-surface p-4 text-left transition-colors hover:border-x-tint-line hover:bg-x-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-x-accent-ink disabled:opacity-50"
            >
              <FolderOpen size={19} className="shrink-0 text-x-accent-ink" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1"><strong className="text-sm font-semibold text-x-ink">{project.name}</strong><span className="text-[11px] text-x-muted">{project.workspace_id ? 'Already connected' : project.kind}</span></span>
                {project.description && <span className="mt-1 block text-xs leading-relaxed text-x-muted line-clamp-2">{project.description}</span>}
                <span className="mt-2 block break-all font-mono text-[11px] text-x-muted">{project.path}</span>
              </span>
              <ArrowRight size={16} className="shrink-0 text-x-muted" />
            </button>)}
          </div>}
          {!searching && result?.partial && <p className="mt-3 text-xs text-x-muted">Only part of your folders could be searched. You can also choose a folder below.</p>}
        </div>
        {actionError && <p role="alert" className="mt-3 text-sm text-x-danger">{actionError}</p>}
        <div className="mt-5 border-t border-x-line pt-4">
          <Button icon={FolderOpen} onClick={browse} disabled={busy}>Choose folder…</Button>
          <details className="mt-4 text-xs text-x-muted">
            <summary className="cursor-pointer py-1">Enter a folder path instead</summary>
            <form className="mt-3 flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (manualPath.trim()) select({ path: manualPath.trim() }) }}>
              <input aria-label="Workspace folder path" value={manualPath} onChange={(event) => setManualPath(event.target.value)} placeholder="/path/to/project" className="min-w-0 flex-1 rounded-lg border border-x-line bg-x-bg px-3 py-2 text-sm text-x-ink" />
              <Button type="submit" disabled={busy || !manualPath.trim()}>Connect</Button>
            </form>
          </details>
        </div>
      </div>
    </Modal>
  )
}
