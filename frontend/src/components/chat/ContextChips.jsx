import { useEffect, useRef, useState } from 'react'
import { AlertCircle, FileText, Folder, Image as ImageIcon, Info, Loader2, Paperclip, X } from 'lucide-react'
import { contextReference, deliveryHint, humanSize } from '../../lib/chatContext'

const chipIcon = (item) => {
  if (item.status === 'uploading' || item.status === 'checking') return Loader2
  if (item.status === 'missing') return AlertCircle
  if (item.kind === 'dir') return Folder
  if (item.source === 'upload') return Paperclip
  if (/\.(png|jpe?g|gif|webp)$/i.test(item.path || item.name || '')) return ImageIcon
  return FileText
}

function chipTitle(item) {
  if (item.status === 'uploading') return `Uploading ${item.name}…`
  if (item.status === 'missing') return `Not sent: ${item.error || 'the file is gone'}\nDelete/Backspace: remove`
  if (item.restored && item.status === 'checking') return 'Checking that this is still there…'
  const where = item.source === 'upload' ? `Attached file, stored at ${item.absPath}` : `${item.kind === 'dir' ? 'Folder' : 'File'} in the project: ${item.path}${item.kind === 'dir' ? '/' : ''}`
  return `${where}\nEnter: preview · Delete/Backspace: remove`
}

function ContextPreview({ item, cliType, onClose, onRemove }) {
  const ref = useRef(null)
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(true) } }
    const onDown = (e) => { if (!ref.current?.contains(e.target) && !e.target.closest?.('[data-context-chip]')) onClose(false) }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('mousedown', onDown) }
  }, [onClose])
  const fullPath = item.source === 'upload' ? item.absPath : `${item.path}${item.kind === 'dir' ? '/' : ''}`
  return (
    <div ref={ref} role="dialog" aria-label={`Context preview: ${item.name || item.path}`} data-context-preview data-ive-popover
      className="absolute bottom-full left-0 right-0 mb-1.5 z-30 rounded-lg border border-x-line bg-x-surface shadow-x-1 p-2.5 text-[12px] text-x-ink-secondary max-h-72 flex flex-col gap-1.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[12px] text-x-ink break-all">{fullPath}</div>
          <div className="text-[11px] text-x-muted">
            {item.source === 'upload' ? 'Attached file (outside the project)' : item.kind === 'dir' ? 'Project folder' : 'Project file'}
            {item.size != null && item.kind !== 'dir' ? ` · ${humanSize(item.size)}` : ''}
            {' · sent as '}<code className="font-mono text-x-ink">{contextReference(item, cliType)}</code>
          </div>
        </div>
        <button type="button" onClick={onRemove} className="shrink-0 rounded-md border border-x-line px-2 py-0.5 text-[11px] text-x-ink-secondary hover:bg-x-hover">Remove</button>
        <button type="button" onClick={() => onClose(true)} aria-label="Close preview" className="shrink-0 rounded-md p-1 text-x-muted hover:bg-x-hover hover:text-x-ink"><X size={12} /></button>
      </div>
      {item.status === 'missing' ? (
        <div className="text-[11px] text-x-danger">Not sent: {item.error || 'the file is gone'}. Remove it, or add the file again with @.</div>
      ) : item.kind === 'dir' ? (
        <ul className="overflow-y-auto font-mono text-[11px] leading-5 text-x-ink/90 scrollbar-thin">
          {(item.children || []).length === 0 && <li className="text-x-muted">Empty folder</li>}
          {(item.children || []).map((c) => <li key={c} className="truncate">{c}</li>)}
          {item.more && <li className="text-x-muted">…more</li>}
        </ul>
      ) : item.preview != null ? (
        <pre className="overflow-auto whitespace-pre font-mono text-[11px] leading-[1.45] text-x-ink/90 bg-x-surface-2 rounded-md border border-x-line px-2 py-1.5 scrollbar-thin">{item.preview || '(empty file)'}{item.previewTruncated ? '\n…' : ''}</pre>
      ) : (
        <div className="text-x-muted text-[11px]">{item.status === 'ok' ? 'No text preview for this file.' : 'Loading…'}</div>
      )}
    </div>
  )
}

/** Context chips above the composer: visible, previewable, removable. */
export default function ContextChips({ context, cliType }) {
  const { items, notices, flashKey, remove, dismissNotice } = context
  const [openKey, setOpenKey] = useState(null)
  const chipRefs = useRef(new Map())
  const open = items.find((i) => i.key === openKey)
  useEffect(() => { if (openKey && !open) setOpenKey(null) }, [openKey, open])

  const removeAt = (idx) => {
    const item = items[idx]
    if (!item) return
    remove(item.key)
    // Keep keyboard users in the strip: focus the neighbour, else the composer.
    const next = items[idx + 1] || items[idx - 1]
    requestAnimationFrame(() => {
      const el = next && chipRefs.current.get(next.key)
      if (el) el.focus()
      else document.querySelector('form.x-composer textarea')?.focus()
    })
  }

  if (items.length === 0 && notices.length === 0) return null
  return (
    <div className="relative flex flex-col gap-1.5" data-context-strip>
      {open && (
        <ContextPreview item={open} cliType={cliType} onRemove={() => removeAt(items.indexOf(open))}
          onClose={(refocus) => { const k = openKey; setOpenKey(null); if (refocus) chipRefs.current.get(k)?.focus() }} />
      )}
      {items.length > 0 && (
        <div role="group" aria-label="Context for the next message"
          className="flex flex-wrap items-center gap-1.5 rounded-xl border border-x-line bg-x-surface px-2.5 py-1.5 shadow-x-1 select-none">
          <span className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-x-muted" title={deliveryHint(cliType)}>
            Context
          </span>
          {items.map((item, idx) => {
            const Icon = chipIcon(item)
            const pending = item.status === 'uploading' || item.status === 'checking'
            const missing = item.status === 'missing'
            const label = item.source === 'upload' ? item.name : `${item.path}${item.kind === 'dir' ? '/' : ''}`
            return (
              <span key={item.key} data-context-chip={item.key} data-context-chip-state={item.status}
                className={`inline-flex min-w-0 max-w-[min(320px,100%)] items-center rounded-md border font-mono text-[11px] transition-colors ${
                  missing ? 'border-x-danger/45 bg-x-danger/[0.06] text-x-ink' : flashKey === item.key ? 'border-x-line-strong bg-x-hover text-x-ink' : openKey === item.key ? 'border-x-line-strong bg-x-hover text-x-ink' : 'border-x-line bg-x-surface-2 text-x-ink-secondary hover:border-x-line-strong'
                }`}>
                <button type="button"
                  ref={(el) => { if (el) chipRefs.current.set(item.key, el); else chipRefs.current.delete(item.key) }}
                  onClick={() => setOpenKey((k) => (k === item.key ? null : item.key))}
                  onKeyDown={(e) => {
                    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeAt(idx) }
                    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                      const n = items[idx + (e.key === 'ArrowRight' ? 1 : -1)]
                      if (n) { e.preventDefault(); chipRefs.current.get(n.key)?.focus() }
                    }
                  }}
                  aria-expanded={openKey === item.key}
                  aria-label={`${item.kind === 'dir' ? 'Folder' : 'File'} ${label}${pending ? ' (loading)' : ''}${missing ? ` (missing, not sent: ${item.error || 'the file is gone'})` : ''}. Press Enter to preview, Delete to remove.`}
                  title={chipTitle(item)}
                  className="inline-flex min-w-0 items-center gap-1 py-0.5 pl-1.5 pr-1 rounded-l-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-x-accent">
                  <Icon size={11} className={`shrink-0 ${pending ? 'animate-spin' : ''}${missing ? ' text-x-danger' : ''}`} />
                  <span className={`truncate${missing ? ' line-through decoration-x-danger/60' : ''}`} dir="rtl"><bdi>{label}</bdi></span>
                  {missing && <span className="shrink-0 font-sans text-[11px] text-x-danger">missing</span>}
                </button>
                <button type="button" onClick={() => removeAt(idx)} aria-label={`Remove ${label} from context`} title="Remove from context"
                  className="shrink-0 self-stretch flex items-center px-1 rounded-r-md text-x-muted hover:text-x-ink hover:bg-x-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-x-accent">
                  <X size={10} />
                </button>
              </span>
            )
          })}
        </div>
      )}
      {notices.length > 0 && (
        <div role="status" aria-live="polite" className="flex flex-col gap-1">
          {notices.map((n) => (
            <div key={n.id} data-context-notice={n.tone}
              className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] ${n.tone === 'error' ? 'border-x-danger/30 bg-x-danger/[0.06] text-x-ink' : 'border-x-line bg-x-surface text-x-ink-secondary'}`}>
              {n.tone === 'error' ? <AlertCircle size={13} className="mt-0.5 shrink-0 text-x-danger" /> : <Info size={13} className="mt-0.5 shrink-0 text-x-muted" />}
              <span className="min-w-0 flex-1 break-words">{n.message}</span>
              <button type="button" onClick={() => dismissNotice(n.id)} aria-label="Dismiss" className="shrink-0 rounded p-0.5 text-x-muted hover:text-x-ink hover:bg-x-hover"><X size={11} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** One file/folder row inside the composer's @ menu. */
export function ContextMentionRow({ entry }) {
  const blocked = entry.status && entry.status !== 'ok'
  const Icon = entry.kind === 'dir' ? Folder : entry.file_type === 'image' ? ImageIcon : FileText
  const slash = entry.path.lastIndexOf('/')
  const dir = slash >= 0 ? entry.path.slice(0, slash + 1) : ''
  return (
    <div className={`flex items-center gap-2 overflow-hidden w-full ${blocked ? 'opacity-60' : ''}`} title={blocked ? entry.reason : entry.path}>
      <Icon size={12} className="shrink-0 text-x-muted" />
      <span className="font-mono text-[12px] text-x-ink shrink-0 max-w-[60%] truncate">{entry.name}{entry.kind === 'dir' ? '/' : ''}</span>
      <span className="font-mono text-[11px] text-x-muted truncate flex-1 min-w-0" dir="rtl"><bdi>{dir}</bdi></span>
      {blocked ? (
        <span className="shrink-0 text-[11px] text-x-danger">{entry.status === 'too_large' ? 'too large' : entry.status === 'outside' ? 'outside project' : 'binary'}</span>
      ) : (
        <span className="shrink-0 text-[11px] text-x-muted">{entry.kind === 'dir' ? 'folder' : humanSize(entry.size)}</span>
      )}
    </div>
  )
}

/** Footer of the @ menu: loading, empty and error states of the file search. */
export function ContextSearchStatus({ search, hasRows }) {
  if (search.status === 'error') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-x-ink border-t border-x-line" role="status">
        <AlertCircle size={12} className="shrink-0 text-x-danger" />
        <span className="flex-1 min-w-0 break-words">Couldn't load project files: {search.error}</span>
        <button type="button" onMouseDown={(e) => { e.preventDefault(); search.reload() }} className="shrink-0 rounded border border-x-line px-1.5 py-0.5 text-[11px] hover:bg-x-hover">Retry</button>
      </div>
    )
  }
  if (search.status === 'loading' && !hasRows) {
    return <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-x-muted" role="status"><Loader2 size={12} className="animate-spin" />Searching project files…</div>
  }
  if (search.status === 'ready' && search.items.length === 0) {
    return <div className="px-3 py-2 text-[12px] text-x-muted" role="status">No files or folders match “{search.query}”.</div>
  }
  return null
}

/** Keep the keyboard-selected row of a scrolling menu visible without moving ancestors. */
export function keepOptionVisible(el) {
  const box = el?.parentElement
  if (!box) return
  if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop
  else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight
}
